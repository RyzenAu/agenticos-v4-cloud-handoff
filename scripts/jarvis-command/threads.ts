/**
 * Jarvis threads: the link between the jobs Jarvis starts for a person and that person's durable conversation (Open Dot V).
 *
 *   command service  --link(job)-->  conversation (scripts/conversations.ts, ensureThread/linkJob)
 *   job service      --state change-->  this watcher  --appendEntry-->  the same conversation (durable, server-side)
 *
 * The conversation is the ONE place a result lands, whether the mic is still open, the tab was closed or the PC slept: the server appends
 * the entry when the job's real state changes, so it is there when the person comes back. Nothing here starts, runs or cancels a job and
 * no state is invented: every word of "started / waiting / failed / finished" is read from the job's own state (JobService for command and
 * computer jobs, the coding store for coding jobs). A restart re-reads every linked job (`start()`), so a result that landed while the
 * hub was down is appended once on the way back up (the entry key `<jobId>:<state>` makes a repeat a no-op).
 *
 * Implemented independently (Open Dot's equivalent is an in-memory queue plus a messages table; see docs/programme-20261001/OPEN-DOT-ADOPTION.md).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { maskJobText, type JobService } from "../jobs/service";
import type { JobEvent, Step } from "../jobs/types";
import { jarvisThreadId, type ThreadEntry, type ThreadJobLink } from "../conversations";
import { isOpenState, type ActiveJob } from "./followup";
export { isOpenState };

export type ThreadStore = {
  ensureThread(input: { id?: string; personId: string }): { id: string; jobs?: ThreadJobLink[] } | null;
  linkJob(id: string, link: { jobId: string; kind: "job" | "coding"; title: string; state: string; at?: string }): unknown;
  touchJob(id: string, jobId: string, patch?: { state?: string; addContext?: string; at?: string }): unknown;
  appendEntry(id: string, entry: { key: string; jobId: string; state: string; text: string; speak?: string; at?: string }): ThreadEntry | null;
  get(id: unknown): { id: string; jobs?: ThreadJobLink[]; personId?: string } | null;
  list(): Array<{ id: string; thread?: string; jobs?: ThreadJobLink[] }>;
  entriesAfter(id: string, seq: number): ThreadEntry[];
  /**
   * Told after an entry is durably appended, whoever appended it (this watcher, the research report's way back, the acknowledgement). Optional so
   * a plain test store still works: without it this watcher notifies for its own appends only.
   */
  onAppend?(listener: (e: { conversationId: string; personId: string | null; entry: ThreadEntry }) => void): () => void;
};

/**
 * What an appended entry tells the rest of the hub. `announce` is the ONE short spoken line, only for an entry that reports where a job ENDED
 * or what it needs (never the acknowledgement, a progress line or a returned report); its `key` is the stable event id the interjection gate
 * dedupes on and persists, so a replay, a restart or a second tab can never make it speak twice.
 */
export type ThreadNotice = { conversationId: string; personId: string; entry: ThreadEntry; announce: { text: string; key: string } | null };
const SILENT_STATES = new Set(["started", "progress", "report"]);
export const announceFor = (entry: ThreadEntry): ThreadNotice["announce"] =>
  entry.speak && !SILENT_STATES.has(entry.state) ? { text: entry.speak, key: `job:${entry.jobId}:${entry.state}` } : null;

/**
 * A job step worth a line in the conversation, or null. Only what the job itself recorded: a research sub-goal that finished, failed or was skipped
 * (the "started" ones are noise), a person taking the computer (the job paused), and control coming back (the job resumed). Pure.
 */
const WORKFLOW_PROGRESS: Record<string, string> = { research: "Research", builder: "Builder", audit: "Website audit", bizprep: "Business preparation" };
export function progressFor(step: Step): string | null {
  const intent = step.intent ?? "";
  const workflow = WORKFLOW_PROGRESS[step.executor];
  if (workflow && (step.verification?.method === "research-subgoal" || step.verification?.method === "workflow-subgoal")) {
    const m = /^sub-goal (\d+) of (\d+), ([^:]+): (done|failed|skipped)\.\s*(.*)$/s.exec(intent);
    if (!m) return null;
    const detail = m[4] === "done" ? "" : ` ${cut(maskJobText(m[5].replace(/\s*\(\d+ of \d+ done\)\s*$/, ""), 140), 120)}`;
    return `${workflow}, step ${m[1]} of ${m[2]} (${m[3]}): ${m[4]}.${detail}`;
  }
  if (step.executor === "computer.lease") {
    const paused = /^paused before .*?: (.+) is taking control$/s.exec(intent);
    if (paused) return `Paused: ${cut(maskJobText(paused[1], 40), 40)} is taking control of the computer. The job waits and does not run until control is returned.`;
    if (/^control returned to the agent/.test(intent)) return "Resumed: control is back with the agent, which re-read the computer before carrying on.";
  }
  return null;
}

/** What the coding store says about a coding job (state + the receipts' account and model), read through live.ts. */
export type CodingSnapshot = { state: string; title: string; receipts: { account: string; model: string; providerModel: string | null; role?: string }[]; /** The result in a few words (files changed, tests, review), from the job record. */ detail?: string };
export type CodingReader = (jobId: string) => Promise<CodingSnapshot | null> | CodingSnapshot | null;

export type JobReading = { state: string; title: string; note: string | null; steps: number; lastStep: string | null; receipts: CodingSnapshot["receipts"]; detail?: string };

const short = (id: string) => id.slice(0, 8);
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
// Everything stored in a conversation (titles, notes, context) passes the same masking as the job log: numbers, codes, typed payloads, e-mails.
const shortTitle = (title: string) => cut(maskJobText(title, 200).replace(/\s+/g, " ").trim() || "That job", 48);
export const accountWords = (slot: string) => {
  const n = /-(\d+)$/.exec(slot)?.[1];
  return slot.startsWith("claude:max") ? `Claude Max${n ? ` ${n}` : ""}` : slot.startsWith("codex:") ? `Codex${n ? ` ${n}` : ""}` : slot;
};

const DONE = new Set(["succeeded", "completed"]);
const WAITING = new Set(["awaiting-approval", "awaiting_approval", "needs_owner", "blocked_allowance", "awaiting_confirmation"]);
const STOPPED = new Set(["cancelled"]);
const UNSURE = new Set(["interrupted", "unknown"]);
export const isTerminal = (state: string) => DONE.has(state) || STOPPED.has(state) || UNSURE.has(state) || state === "failed";
/** States that get a conversation entry. running/queued/building… are not news: the acknowledgement was the first entry. */
const notable = (state: string) => isTerminal(state) || WAITING.has(state);

/** "Ran on Claude Max 2: builder claude-sonnet-5-5, reviewer claude-opus-5-5" from the receipts (the account and the model that ACTUALLY answered). */
function ranOn(r: JobReading): string {
  if (!r.receipts.length) return "";
  const byAccount = new Map<string, string[]>();
  for (const x of r.receipts) {
    const list = byAccount.get(x.account) ?? [];
    const who = `${x.role ? `${x.role} ` : ""}${x.providerModel ?? x.model}`;
    if (!list.includes(who)) list.push(who);
    byAccount.set(x.account, list);
  }
  return `Ran on ${[...byAccount].map(([account, who]) => `${accountWords(account)}: ${who.join(", ")}`).join("; ")}.`;
}

/** One entry's text and the one short line worth speaking, from a job's REAL reading. Pure. */
export function entryFor(state: string, r: JobReading, jobId: string): { text: string; speak: string } {
  const t = shortTitle(r.title);
  const note = r.note ? cut(maskJobText(r.note, 300).replace(/^Waiting for your yes:\s*/i, ""), 200) : "";
  const lead = (word: string) => `${word}: ${t.endsWith("…") ? t : `${t}.`}`;
  const tail = (...parts: string[]) => parts.filter(Boolean).join(" ");
  const id = `(job ${short(jobId)})`;
  const line = (word: string, ...parts: string[]) => `${lead(word)}${tail(...parts) ? ` ${tail(...parts)}` : ""} ${id}`;
  if (DONE.has(state)) return { text: line("Finished", note, maskJobText(r.detail ?? "", 300), ranOn(r)), speak: `${cut(t, 36)} is finished.` };
  if (state === "failed") return { text: line("Failed", note, maskJobText(r.detail ?? "", 300), ranOn(r)), speak: `${cut(t, 36)} failed.` };
  if (STOPPED.has(state)) return { text: line("Stopped", "Nothing further ran."), speak: `${cut(t, 36)} was stopped.` };
  if (UNSURE.has(state)) return { text: line("Ended without a confirmed outcome", note, "It was not re-run, so one step may or may not have happened."), speak: `${cut(t, 36)} ended without a confirmed result.` };
  if (WAITING.has(state)) return { text: line("Waiting for you", note, r.detail ?? ""), speak: `${cut(t, 36)} is waiting for you.` };
  return { text: `${t} is ${state.replace(/[-_]/g, " ")}. ${id}`, speak: `${cut(t, 36)} is ${state.replace(/[-_]/g, " ")}.` };
}

/** The status line for "how's that going?", from the real reading. Pure. */
export function statusLine(r: JobReading, jobId: string): string {
  const t = shortTitle(r.title);
  if (isTerminal(r.state) || WAITING.has(r.state)) return entryFor(r.state, r, jobId).text.replace(/ \(job [0-9a-f]{8}[^)]*\)$/, "");
  const where = r.steps ? `, ${r.steps} step${r.steps === 1 ? "" : "s"} in` : "";
  return `${t} is ${r.state.replace(/[-_]/g, " ")}${where}.${r.lastStep ? ` Latest: ${cut(r.lastStep, 110)}` : ""}`;
}

export type JobThreadsDeps = {
  conversations: ThreadStore;
  jobs: () => JobService;
  /** Coding jobs live in the coding store, not the job service. Absent: coding jobs are never linked. */
  coding?: CodingReader;
  now?: () => number;
  /** How often coding jobs (which have no subscribe) are re-read. Default 4 s. */
  pollMs?: number;
  /** Where "this person is at this PC" is remembered, so a hub restart does not silence the spoken end of a job still running. Absent: memory only. */
  localFile?: string;
};

type Watch = { personId: string; conversationId: string; kind: "job" | "coding"; last: string };

export function createJobThreads(deps: JobThreadsDeps) {
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const watches = new Map<string, Watch>();
  /** People whose own session is at this PC (a loopback-owner command was seen): only their results are spoken here. */
  const local = new Set<string>();
  if (deps.localFile) {
    try {
      const saved = JSON.parse(readFileSync(deps.localFile, "utf8"));
      if (Array.isArray(saved)) for (const p of saved) if (p === "usman" || p === "mehroz") local.add(p);
    } catch { /* first run, or unreadable: nobody is assumed to be at this PC until they say something here */ }
  }
  const rememberLocal = (personId: string) => {
    if (local.has(personId)) return;
    local.add(personId);
    if (!deps.localFile) return;
    try {
      mkdirSync(dirname(deps.localFile), { recursive: true });
      const tmp = `${deps.localFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...local]));
      renameSync(tmp, deps.localFile);
    } catch { /* memory still has it */ }
  };
  const listeners = new Set<(e: ThreadNotice) => void>();
  const viaStore = !!deps.conversations.onAppend;
  let offStore: (() => void) | null = null;
  const notify = (conversationId: string, personId: string, entry: ThreadEntry) => {
    const n: ThreadNotice = { conversationId, personId, entry, announce: announceFor(entry) };
    for (const l of [...listeners]) try { l(n); } catch { /* a listener never breaks the thread */ }
  };
  const subscribeStore = () => {
    if (!viaStore || offStore) return;
    offStore = deps.conversations.onAppend!(({ conversationId, personId, entry }) => { if (personId) notify(conversationId, personId, entry); });
  };
  subscribeStore();
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  async function read(jobId: string, kind: "job" | "coding"): Promise<JobReading | null> {
    if (kind === "coding") {
      const c = deps.coding ? await deps.coding(jobId) : null;
      return c ? { state: c.state, title: c.title, note: null, steps: 0, lastStep: null, receipts: c.receipts, ...(c.detail ? { detail: c.detail } : {}) } : null;
    }
    const j = deps.jobs().get(jobId);
    if (!j) return null;
    const last = j.steps.at(-1);
    return { state: j.state, title: j.title, note: j.note ?? null, steps: j.steps.length, lastStep: last?.intent ?? null, receipts: [] };
  }

  function append(w: Watch, jobId: string, state: string, r: JobReading): ThreadEntry | null {
    const e = entryFor(state, r, jobId);
    const entry = deps.conversations.appendEntry(w.conversationId, { key: `${jobId}:${state}`, jobId, state, text: e.text, speak: e.speak, at: iso() });
    if (entry && !viaStore) notify(w.conversationId, w.personId, entry);
    return entry;
  }

  /** Compare one job's real state with what the thread last recorded; append when it is news. */
  async function reconcileOne(jobId: string): Promise<void> {
    const w = watches.get(jobId);
    if (!w) return;
    const r = await read(jobId, w.kind).catch(() => null);
    if (!r || r.state === w.last) return;
    w.last = r.state;
    if (notable(r.state)) append(w, jobId, r.state, r);
    if (isTerminal(r.state)) watches.delete(jobId);
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      for (const id of [...watches.keys()]) await reconcileOne(id);
    } finally {
      busy = false;
    }
  }

  /** A watched job recorded a step: if it is news, one durable progress entry (the key makes a re-delivered step a no-op). */
  function onStep(jobId: string, step: Step) {
    const w = watches.get(jobId);
    const line = w ? progressFor(step) : null;
    if (!w || !line) return;
    const entry = deps.conversations.appendEntry(w.conversationId, { key: `${jobId}:step:${step.seq}`, jobId, state: "progress", text: line, at: iso() });
    if (entry && !viaStore) notify(w.conversationId, w.personId, entry);
  }

  function watch(jobId: string, w: Watch) {
    watches.set(jobId, w);
  }

  return {
    /**
     * Start watching: the job service's change events (command and computer jobs), a short poll for coding jobs, and a re-read of every
     * linked job that was still open when the hub last stopped (so a result that landed meanwhile is appended once).
     */
    async start(): Promise<void> {
      if (unsub) return;
      subscribeStore();
      unsub = deps.jobs().subscribe((e: JobEvent) => {
        if (e.type === "job" && watches.has(e.jobId)) void reconcileOne(e.jobId);
        else if (e.type === "step" && watches.has(e.jobId)) onStep(e.jobId, e.step);
      });
      timer = setInterval(() => void poll(), deps.pollMs ?? 4_000);
      timer.unref?.();
      for (const c of deps.conversations.list()) {
        if (c.thread !== "jarvis") continue;
        const person = deps.conversations.get(c.id)?.personId;
        for (const j of c.jobs ?? []) if (person && !isTerminal(j.state)) {
          watch(j.jobId, { personId: person, conversationId: c.id, kind: j.kind, last: j.state });
          // Steps recorded while the hub was down (same keys as live, so none is added twice; progress is never spoken).
          if (j.kind === "job") for (const step of deps.jobs().get(j.jobId)?.steps ?? []) onStep(j.jobId, step);
        }
      }
      await poll();
    },
    stop() {
      unsub?.();
      unsub = null;
      offStore?.();
      offStore = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
    onEntry(listener: (e: ThreadNotice) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * Link a job the person just started to their Jarvis thread and record the acknowledgement as its first entry. The acknowledgement
     * carries the job id (the receipt) and the real state at this moment. Returns the conversation id, or null when that id is someone else's.
     */
    async link(input: { personId: string; conversationId?: string; jobId: string; kind: "job" | "coding"; title: string; /** An existing job the person asked about ("show me the research computer"), not one this command started. */ attached?: boolean }): Promise<{ conversationId: string; created: boolean } | null> {
      // Someone else's conversation id is never written to; the job goes to this person's own default thread instead.
      const thread = (input.conversationId ? deps.conversations.ensureThread({ id: input.conversationId, personId: input.personId }) : null) ?? deps.conversations.ensureThread({ personId: input.personId });
      if (!thread) return null;
      const reading = await read(input.jobId, input.kind).catch(() => null);
      const state = reading?.state ?? "queued";
      const title = maskJobText(reading?.title || input.title, 200);
      deps.conversations.linkJob(thread.id, { jobId: input.jobId, kind: input.kind, title, state, at: iso() });
      const startedEntry = deps.conversations.appendEntry(thread.id, { key: `${input.jobId}:started`, jobId: input.jobId, state: "started", text: `${input.attached ? "Following" : "Started"}: ${shortTitle(title)} (job ${short(input.jobId)}).`, at: iso() });
      const created = !!startedEntry;
      if (startedEntry && !viaStore) notify(thread.id, input.personId, startedEntry);
      const w: Watch = { personId: input.personId, conversationId: thread.id, kind: input.kind, last: state };
      if (!isTerminal(state)) {
        watch(input.jobId, w);
        // Steps the job recorded between starting and being linked (it was already running): the same keys, so none is ever added twice.
        if (input.kind === "job") for (const step of deps.jobs().get(input.jobId)?.steps ?? []) onStep(input.jobId, step);
      }
      else if (reading) append(w, input.jobId, state, reading);
      return { conversationId: thread.id, created };
    },
    noteLocal: (personId: string) => rememberLocal(personId),
    isLocal: (personId: string) => local.has(personId),
    /** The person's thread (created empty when missing); null when that conversation id is someone else's. */
    thread(personId: string, conversationId?: string) {
      return (conversationId ? deps.conversations.ensureThread({ id: conversationId, personId }) : null) ?? deps.conversations.ensureThread({ personId });
    },
    /**
     * Entries after `after` in this person's thread (the voice client's poll, and the activity stream). Reads only: an unknown thread is
     * empty and never created here; someone else's thread is refused (null).
     */
    updates(personId: string, conversationId: string | undefined, after: number): { conversationId: string; entries: ThreadEntry[] } | null {
      const id = conversationId ?? jarvisThreadId(personId);
      const c = deps.conversations.get(id);
      if (!c) return { conversationId: id, entries: [] };
      if (c.personId !== personId) return null;
      return { conversationId: id, entries: deps.conversations.entriesAfter(id, after) };
    },
    /** The jobs this person's thread knows, with their REAL state now (a stored state is never trusted over the job service). */
    async active(personId: string, conversationId?: string): Promise<ActiveJob[]> {
      // Read-only: asking about jobs never creates a conversation.
      const mine = (id: string) => {
        const c = deps.conversations.get(id);
        return c && c.personId === personId ? c : null;
      };
      // This conversation's jobs and the person's default thread's (typed commands land there): one set of "his jobs".
      const convs = [conversationId ? mine(conversationId) : null, mine(jarvisThreadId(personId))].filter((c, i, a): c is NonNullable<typeof c> => !!c && a.findIndex((x) => x?.id === c.id) === i);
      const out: ActiveJob[] = [];
      for (const c of convs) for (const l of c.jobs ?? []) {
        if (out.some((o) => o.jobId === l.jobId)) continue;
        const r = await read(l.jobId, l.kind).catch(() => null);
        const state = r?.state ?? l.state;
        out.push({ jobId: l.jobId, kind: l.kind, title: r?.title || l.title, state, lastReferencedAt: Date.parse(l.lastReferencedAt) || now(), conversationId: c.id });
      }
      return out;
    },
    /** Reading a job the person asked about: becomes the most recently referenced. */
    async status(conversationId: string, jobId: string, kind: "job" | "coding"): Promise<{ said: string; state: string } | null> {
      const r = await read(jobId, kind).catch(() => null);
      if (!r) return null;
      deps.conversations.touchJob(conversationId, jobId, { state: r.state, at: iso() });
      return { said: statusLine(r, jobId), state: r.state };
    },
    touch(conversationId: string, jobId: string, patch: { state?: string; addContext?: string } = {}) {
      deps.conversations.touchJob(conversationId, jobId, { ...patch, ...(patch.addContext ? { addContext: maskJobText(patch.addContext, 300) } : {}), at: iso() });
    },
    /** For tests and the lead: re-read every watched job now. */
    reconcile: poll,
    watching: () => [...watches.keys()],
  };
}

export type JobThreads = ReturnType<typeof createJobThreads>;
