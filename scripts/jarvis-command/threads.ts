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
import { maskJobText as maskJobTextRaw, type JobService } from "../jobs/service";

/**
 * The job log's masking for what a conversation stores, EXCEPT job references: "(job db837321)" and a full job id are not numbers or phones, and masking
 * their digit runs printed "job db[number]". Job ids are kept as written; everything else (real phone-like and account-like digit runs, codes, typed
 * payloads, e-mails) is masked exactly as before.
 */
export function maskJobText(text: unknown, max = 300): string {
  const refs: string[] = [];
  const keep = (m: string) => `§jobref${refs.push(m) - 1}§`;
  const guarded = String(text ?? "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, keep)
    .replace(/\bjobs?\s+[0-9a-f]{8}\b/gi, keep);
  return maskJobTextRaw(guarded, max + refs.length * 12).replace(/§jobref(\d+)§/g, (_m, i: string) => refs[Number(i)] ?? "").slice(0, max);
}
import type { JobEvent, Step } from "../jobs/types";
import { botThreadId, isJobThread, jarvisThreadId, type ThreadBlocker, type ThreadEntry, type ThreadJobLink, type TypedBinding } from "../conversations";
import { isOpenState, type ActiveJob } from "./followup";
export { isOpenState };

/** The "a person took the computer" blocker as the conversation's owner should read it. `holder` is who took it (a person id as the computer service names them). */
export function takeoverBlocker(holder: string, owner: string): ThreadBlocker {
  if (holder.toLowerCase() === owner.toLowerCase()) return { kind: "needs-takeover", held: "you", recovery: "Paused while you have the controls. Return them when you're done." };
  const name = holder.charAt(0).toUpperCase() + holder.slice(1);
  return { kind: "needs-takeover", held: "other", recovery: `${name} has the controls. The job carries on when they hand them back.` };
}

export type ThreadStore = {
  ensureThread(input: { id?: string; personId: string; bot?: string; title?: string }): { id: string; jobs?: ThreadJobLink[] } | null;
  linkJob(id: string, link: { jobId: string; kind: "job" | "coding"; title: string; state: string; at?: string }): unknown;
  touchJob(id: string, jobId: string, patch?: { state?: string; addContext?: string; at?: string }): unknown;
  appendEntry(id: string, entry: { key: string; jobId: string; state: string; text: string; speak?: string; at?: string; jobKind?: "computer" | "coding"; blocker?: ThreadBlocker; ok?: boolean; stopped?: boolean; unverified?: boolean; replace?: boolean }): ThreadEntry | null;
  get(id: unknown): { id: string; jobs?: ThreadJobLink[]; personId?: string; thread?: string; bot?: string } | null;
  list(): Array<{ id: string; thread?: string; bot?: string; jobs?: ThreadJobLink[] }>;
  entriesAfter(id: string, seq: number): ThreadEntry[];
  saveTypedPart?(binding: TypedBinding, part: "user" | "reply" | "note", role: "user" | "assistant", text: string): string;
  /** A keyed plain message (a typed request or its reply); optional so a plain test store still works. */
  appendMessage?(id: string, m: { key: string; role: "user" | "oracle"; text: string }): boolean;
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
const SILENT_STATES = new Set(["started", "progress", "report", "request", "ack"]);
/**
 * The ONE spelling of a state in an entry key and a spoken-line key. A coding job says `completed` where the job service says `succeeded`; both
 * mean "finished", so both are keyed `succeeded` and one finished job can never hold two finished entries or be spoken twice (round 10).
 */
export const stateKey = (state: string) => (state === "completed" ? "succeeded" : state);
export const announceFor = (entry: ThreadEntry): ThreadNotice["announce"] =>
  entry.speak && !SILENT_STATES.has(entry.state) ? { text: entry.speak, key: `job:${entry.jobId}:${stateKey(entry.state)}` } : null;

/**
 * A job step worth a line in the conversation, or null. Only what the job itself recorded: a research sub-goal that finished, failed or was skipped
 * (the "started" ones are noise), a person taking the computer (the job paused), and control coming back (the job resumed). Pure.
 */
const WORKFLOW_PROGRESS: Record<string, string> = { research: "Research", builder: "Builder", audit: "Website audit", bizprep: "Business preparation" };
export function progressFor(step: Step, /** The conversation's owner: a pause is worded from their side. */ reader?: string): string | null {
  const intent = step.intent ?? "";
  const workflow = WORKFLOW_PROGRESS[step.executor];
  if (workflow && (step.verification?.method === "research-subgoal" || step.verification?.method === "workflow-subgoal")) {
    const m = /^sub-goal (\d+) of (\d+), ([^:]+): (done|failed|skipped)\.\s*(.*)$/s.exec(intent);
    if (!m) return null;
    const detail = m[4] === "done" ? "" : ` ${cut(maskJobText(m[5].replace(/\s*\(\d+ of \d+ done\)\s*$/, ""), 140), 120)}`;
    return `${workflow}, step ${m[1]} of ${m[2]} (${m[3]}): ${m[4]}.${detail}`;
  }
  // Which model answered, or that none did, when the bot has a model preference (a note the job wrote itself).
  if (step.verification?.method === "model-route" && /^Model route /.test(intent)) return cut(maskJobText(intent, 200), 200);
  if (step.executor === "computer.lease") {
    const holder = pausedHolder(step);
    if (holder !== null) return pauseLine(holder, reader);
    if (/^control returned to the agent/.test(intent)) return "Resumed: control is back with the agent, which re-read the computer before carrying on.";
  }
  return null;
}

/** Who took the computer, from a job's own pause step ("paused before step 2: usman is taking control"), or null for any other step. */
export function pausedHolder(step: Pick<Step, "executor" | "intent">): string | null {
  if (step.executor !== "computer.lease") return null;
  const m = /^paused before .*?: (.+) is taking control$/s.exec(step.intent ?? "");
  return m ? m[1].trim() : null;
}

/**
 * The pause as the conversation's reader reads it. Round 8: it said "Paused: usman is taking control of the computer" to Usman himself, by id, in the
 * third person. The reader who took the controls reads it in the second person; anyone else (or no known reader) reads the holder's name.
 */
export function pauseLine(holder: string, reader?: string): string {
  if (reader && holder.toLowerCase() === reader.toLowerCase()) return "Paused: you took the controls of the computer. The job waits until you return them.";
  const name = cut(maskJobText(holder, 40), 40);
  return `Paused: ${name.charAt(0).toUpperCase()}${name.slice(1)} took the controls of the computer. The job waits and does not run until they hand them back.`;
}

/** What the coding store says about a coding job (state + the receipts' account and model), read through live.ts. */
export type CodingSnapshot = { state: string; title: string; /** Who asked for the job (its spec's requestedBy): its report goes to this person's conversations only. */ owner?: string; receipts: { account: string; model: string; providerModel: string | null; role?: string }[]; /** The result in a few words (files changed, tests, review), from the job record. */ detail?: string; /** The B2 approval a job in awaiting_approval is waiting on. */ approvalId?: string; /** Why a job that needs its owner is stopped, in the coding page's own words. */ blocker?: string };
export type CodingReader = (jobId: string) => Promise<CodingSnapshot | null> | CodingSnapshot | null;

export type JobReading = { state: string; title: string; note: string | null; steps: number; lastStep: string | null; receipts: CodingSnapshot["receipts"]; detail?: string; /** A shared computer's job ("computer") or a coding job; absent for a command on a person's own device. */ jobKind?: "computer" | "coding"; approvalId?: string; blockerText?: string };

/**
 * The machine-readable "what does this need from the person" for a job entry, from the job's REAL reading (the words stay in the entry's text).
 * Waiting on an answer is an approval (its id when the job names one), a coding job in needs_owner is "needs-owner" (the owner's decision, not an approval), a coding account at its limit is its own "allowance" kind (never "offline"), a job that failed or
 * ended without a confirmed outcome is "failed" (and is never re-run by itself); done and stopped jobs need nothing. Pure.
 */
export function blockerFor(state: string, r: JobReading): ThreadBlocker | undefined {
  if (DONE.has(state) || STOPPED.has(state)) return undefined;
  if (state === "blocked_allowance") return { kind: "allowance", recovery: r.blockerText ? cut(maskJobText(r.blockerText, 200), 200) : "That account is at its limit. Resume after it resets, or move the role to another account." };
  // A coding job in needs_owner is stopped for the owner's decision (a role to retry, a conflict, a review to act on, an unsafe git setup): there is
  // nothing to approve and no computer to take over, so it is its own kind, answered from the job.
  if (state === "needs_owner") return { kind: "needs-owner", recovery: r.blockerText ? cut(maskJobText(r.blockerText, 200), 200) : "It stopped and needs your decision. Open the job to see why, then resume it or stop it." };
  if (WAITING.has(state)) return { kind: "needs-approval", ...(r.approvalId ? { approvalId: r.approvalId } : {}), recovery: r.blockerText ? cut(maskJobText(r.blockerText, 200), 200) : "Answer it from the job (say yes out loud or use its card), or stop it." };
  if (state === "failed") return { kind: "failed", recovery: "Nothing is re-run by itself. Tell the bot the next goal to start a new task, or open the job to see what failed." };
  // Round 10: a CODING job the hub restart interrupted is resumable on purpose (its worktrees, commits and receipts are kept; the coding page's Resume
  // re-enters where it stopped). Its action is the owner's Resume, said in the job's own words, not "check the result before asking again".
  if (state === "interrupted" && r.jobKind === "coding") return { kind: "needs-owner", recovery: r.blockerText ? cut(maskJobText(r.blockerText, 200), 200) : "The hub restarted while it ran. Nothing was replayed. Open the job and resume it when you're ready, or stop it." };
  if (UNSURE.has(state)) return { kind: "failed", recovery: "It ended without a confirmed outcome and was not re-run, so one step may or may not have happened. Check the result before asking again." };
  return undefined;
}

const short = (id: string) => id.slice(0, 8);
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
// Everything stored in a conversation (titles, notes, context) passes the same masking as the job log: numbers, codes, typed payloads, e-mails.
const shortTitle = (title: string) => cut(maskJobText(title, 200).replace(/\s+/g, " ").trim() || "That job", 48);
export const accountWords = (slot: string) => {
  const n = /-(\d+)$/.exec(slot)?.[1];
  return slot.startsWith("claude:max") ? `Claude Max${n ? ` ${n}` : ""}` : slot.startsWith("codex:") ? `Codex${n ? ` ${n}` : ""}` : slot;
};

const DONE = new Set(["succeeded", "completed"]);
/** A coding job that has been drafted but not started yet (linked as pending until it starts, from anywhere). */
const DRAFTED = new Set(["draft", "awaiting_confirmation"]);
const WAITING = new Set(["awaiting-approval", "awaiting_approval", "needs_owner", "blocked_allowance", "awaiting_confirmation"]);
const STOPPED = new Set(["cancelled"]);
const UNSURE = new Set(["interrupted", "unknown"]);
export const isTerminal = (state: string) => DONE.has(state) || STOPPED.has(state) || UNSURE.has(state) || state === "failed";
/** States that get a conversation entry. running/queued/building… are not news: the acknowledgement was the first entry. */
const notable = (state: string) => isTerminal(state) || WAITING.has(state);
/** Reported like an ending, but the job can be resumed: its conversation keeps watching for the real ending. */
const resumable = (kind: "job" | "coding", state: string) => kind === "coding" && state === "interrupted";

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
  // A finished coding job says where its diff opens (round 10: the end entry named the files and tests but gave no way to the change itself).
  const changes = r.jobKind === "coding" ? `Changes: /coding/${jobId}?tab=changes` : "";
  if (DONE.has(state)) return { text: line("Finished", note, maskJobText(r.detail ?? "", 300), ranOn(r), changes), speak: `${cut(t, 36)} is finished.` };
  if (state === "failed") return { text: line("Failed", note, maskJobText(r.detail ?? "", 300), ranOn(r)), speak: `${cut(t, 36)} failed.` };
  if (STOPPED.has(state)) return { text: line("Stopped", "Nothing further ran."), speak: `${cut(t, 36)} was stopped.` };
  if (state === "interrupted" && r.jobKind === "coding") return { text: line("Interrupted", "Nothing was replayed; its work so far is kept.", r.blockerText ? cut(maskJobText(r.blockerText, 200), 200) : "Resume it from the job when you're ready.", ranOn(r)), speak: `${cut(t, 36)} was interrupted. Resume it when you're ready.` };
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

/**
 * `conversationId` is where the job's progress lands (a bot's conversation for a bot's job). `also`: the person's other conversations that hold the
 * job too (round 10: the one the request was made in, when that is not the bot's own; or one that attached to it later). Each gets the job's ONE
 * end entry (and a waiting entry), never its progress lines, so the result comes back where it was asked for without filling it with steps.
 */
type Watch = { personId: string; conversationId: string; kind: "job" | "coding"; last: string; also?: string[]; /** A pending draft's link time (ms): it stops being polled after PENDING_DRAFT_MS. */ pendingSince?: number };
/** How long a draft linked as pending is watched for its start before the conversation stops polling it (review, round 11). */
const PENDING_DRAFT_MS = 24 * 60 * 60_000;

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
      return c ? { state: c.state, title: c.title, note: null, steps: 0, lastStep: null, receipts: c.receipts, jobKind: "coding", ...(c.detail ? { detail: c.detail } : {}), ...(c.approvalId ? { approvalId: c.approvalId } : {}), ...(c.blocker ? { blockerText: c.blocker } : {}) } : null;
    }
    const j = deps.jobs().get(jobId);
    if (!j) return null;
    const last = j.steps.at(-1);
    return { state: j.state, title: j.title, note: j.note ?? null, steps: j.steps.length, lastStep: last?.intent ?? null, receipts: [], ...(j.kind === "control" ? { jobKind: "computer" as const } : {}), ...(j.approvalId ? { approvalId: j.approvalId } : {}) };
  }

  function append(w: Watch, jobId: string, state: string, r: JobReading): ThreadEntry | null {
    const e = entryFor(state, r, jobId);
    const blocker = blockerFor(state, r);
    let first: ThreadEntry | null = null;
    for (const conversationId of [w.conversationId, ...(w.also ?? [])]) {
      // One finished entry per job and conversation, whichever spelling it was first written with (entries from before round 10 kept the raw state).
      if (DONE.has(state) && deps.conversations.entriesAfter(conversationId, 0).some((x) => x.jobId === jobId && DONE.has(x.state))) continue;
      const entry = deps.conversations.appendEntry(conversationId, { key: `${jobId}:${stateKey(state)}`, jobId, state, text: e.text, speak: e.speak, at: iso(), ...(r.jobKind ? { jobKind: r.jobKind } : {}), ...(blocker ? { blocker } : {}) });
      // The spoken line's key is the job's (job:<id>:<state>), so a second conversation's copy is one event at the interjection gate: spoken once.
      if (entry && !viaStore) notify(conversationId, w.personId, entry);
      first ??= entry;
    }
    return first;
  }

  /** Compare one job's real state with what the thread last recorded; append when it is news. */
  async function reconcileOne(jobId: string): Promise<void> {
    const w = watches.get(jobId);
    if (!w) return;
    const r = await read(jobId, w.kind).catch(() => null);
    // A draft nobody started within a day is no longer polled (a dropped or forgotten draft must not be re-read forever).
    if (w.kind === "coding" && DRAFTED.has(w.last) && w.pendingSince !== undefined && now() - w.pendingSince > PENDING_DRAFT_MS && (!r || DRAFTED.has(r.state))) {
      watches.delete(jobId);
      return;
    }
    if (!r || r.state === w.last) return;
    // Still a draft (draft → awaiting confirmation): not news; nothing is written until it starts (review, round 11).
    if (w.kind === "coding" && DRAFTED.has(w.last) && DRAFTED.has(r.state)) {
      w.last = r.state;
      return;
    }
    // Round 11: a coding DRAFT made in this conversation was linked as pending. However it gets started (his "start it" here, or Start on the
    // draft page), the first state past the draft is the start: one "Started" entry (the same key "start it" writes, so never two), then the
    // usual progress and ONE end entry. A draft cancelled before it started is dropped without an entry.
    if (w.kind === "coding" && DRAFTED.has(w.last) && !DRAFTED.has(r.state)) {
      if (r.state === "cancelled") {
        watches.delete(jobId);
        return;
      }
      const started = deps.conversations.appendEntry(w.conversationId, { key: `${jobId}:started`, jobId, state: "started", text: `Started: ${shortTitle(r.title)} (job ${short(jobId)}). Progress and the result will come here.`, at: iso(), jobKind: "coding" });
      if (started && !viaStore) notify(w.conversationId, w.personId, started);
    }
    w.last = r.state;
    if (notable(r.state)) append(w, jobId, r.state, r);
    // A coding job interrupted by a hub restart can be resumed (from its page or by words): it has been reported, and it stays watched so the
    // result of the resumed job comes back to this same conversation (production 4 Oct: the resumed job finished and nobody was told).
    if (isTerminal(r.state) && !resumable(w.kind, r.state)) watches.delete(jobId);
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
    const line = w ? progressFor(step, w.personId) : null;
    if (!w || !line) return;
    // A person taking the computer pauses the job: the line says so, and the entry says what unblocks it.
    // The words depend on who is reading: the person holding the controls is not told to wait for someone to hand them back.
    const holder = pausedHolder(step);
    const takeover: ThreadBlocker | undefined = holder === null ? undefined : takeoverBlocker(holder, w.personId);
    const entry = deps.conversations.appendEntry(w.conversationId, { key: `${jobId}:step:${step.seq}`, jobId, state: "progress", text: line, at: iso(), ...(w.kind === "job" && deps.jobs().get(jobId)?.kind === "control" ? { jobKind: "computer" as const } : {}), ...(takeover ? { blocker: takeover } : {}) });
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
      // A job held by more than one of the person's conversations (a bot's job asked for from the Jarvis thread) is ONE watch: its progress goes to the
      // bot's conversation (else the one that linked it first) and every other holder gets the end entry. Before round 10 the last conversation read
      // replaced the others, so after a restart only one of them heard how the job ended.
      // Release re-check M4: a job goes to its OWNER's conversations (the coding spec's requester, the job's principal), never to whichever
      // conversation the store happens to list first (newest-updated: after a restart that was another founder who had only asked its status).
      const linked = new Map<string, { kind: "job" | "coding"; state: string; convs: { id: string; person: string; bot: boolean; at: number }[] }>();
      for (const c of deps.conversations.list()) {
        if (!isJobThread(c.thread)) continue;
        const person = deps.conversations.get(c.id)?.personId;
        for (const j of c.jobs ?? []) if (person && (!isTerminal(j.state) || resumable(j.kind, j.state))) {
          const l = linked.get(j.jobId) ?? { kind: j.kind, state: j.state, convs: [] };
          l.convs.push({ id: c.id, person, bot: c.thread === "bot", at: Date.parse((j as { startedAt?: string }).startedAt ?? "") || 0 });
          linked.set(j.jobId, l);
        }
      }
      const holders = new Map<string, { personId: string; kind: "job" | "coding"; state: string; convs: { id: string; bot: boolean; at: number }[] }>();
      for (const [jobId, l] of linked) {
        const owner = l.kind === "coding" ? ((deps.coding ? await Promise.resolve(deps.coding(jobId)).catch(() => null) : null)?.owner ?? null) : (deps.jobs().get(jobId)?.principal?.personId ?? null);
        // The owner's own conversations; with no recorded owner, the person who linked it first (the earliest link), never list order.
        const byTime = [...l.convs].sort((a, b) => a.at - b.at);
        const person = owner ?? byTime[0].person;
        const convs = l.convs.filter((x) => x.person === person);
        if (!convs.length) continue;
        holders.set(jobId, { personId: person, kind: l.kind, state: l.state, convs: convs.map(({ id, bot, at }) => ({ id, bot, at })) });
      }
      for (const [jobId, h] of holders) {
        const [main, ...rest] = [...h.convs].sort((a, b) => Number(b.bot) - Number(a.bot) || a.at - b.at);
        // A draft linked as pending more than a day ago is not re-watched after a restart (it was never started).
        if (h.kind === "coding" && DRAFTED.has(h.state) && main.at && now() - main.at > PENDING_DRAFT_MS) continue;
        watch(jobId, { personId: h.personId, conversationId: main.id, kind: h.kind, last: h.state, ...(rest.length ? { also: rest.map((x) => x.id) } : {}), ...(h.kind === "coding" && DRAFTED.has(h.state) ? { pendingSince: main.at || now() } : {}) });
        // Steps recorded while the hub was down (same keys as live, so none is added twice; progress is never spoken).
        if (h.kind === "job") for (const step of deps.jobs().get(jobId)?.steps ?? []) onStep(jobId, step);
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
    /**
     * Round 11: a typed request or its reply, saved into the person's OWN default Jarvis thread (the one /jarvis reads), keyed by the request id.
     * Returns the conversation id, or null when nothing could be written.
     */
    say(personId: string, input: { key: string; role: "user" | "assistant"; text: string; conversationId?: string }): string | null {
      const match = /^(.+):(user|reply|note)$/.exec(input.key);
      if (deps.conversations.saveTypedPart && match) return deps.conversations.saveTypedPart({ personId, requestId: match[1], ...(input.conversationId ? { conversationId: input.conversationId } : {}) }, match[2] as "user" | "reply" | "note", input.role, input.text);
      const thread = deps.conversations.ensureThread({ personId, ...(input.conversationId ? { id: input.conversationId } : {}) });
      if (!thread || !deps.conversations.appendMessage) return null;
      // Compatibility stores cannot prove a false append was a duplicate rather than a failed/capacity write.
      if (input.text.length > 20_000 || !deps.conversations.appendMessage(thread.id, { key: input.key, role: input.role === "user" ? "user" : "oracle", text: input.text })) return null;
      return thread.id;
    },
    onEntry(listener: (e: ThreadNotice) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * Link a job the person just started to their Jarvis thread and record the acknowledgement as its first entry. The acknowledgement
     * carries the job id (the receipt) and the real state at this moment. Returns the conversation id, or null when that id is someone else's.
     */
    /**
     * The coding drafts still waiting to be started that are BOUND to this conversation: made here by this person (linked as pending), and not
     * started yet. A "start it" said in a conversation starts only one of these (owner, 4 Oct); a draft made in another conversation is not here.
     */
    async pendingDrafts(personId: string, conversationId?: string): Promise<string[]> {
      const thread = conversationId ? deps.conversations.ensureThread({ id: conversationId, personId }) : deps.conversations.ensureThread({ personId });
      if (!thread) return [];
      const ids: string[] = [];
      for (const link of thread.jobs ?? []) {
        if (link.kind !== "coding" || ids.includes(link.jobId)) continue;
        const reading = await read(link.jobId, "coding").catch(() => null);
        if (reading?.state === "awaiting_confirmation") ids.push(link.jobId);
      }
      return ids;
    },
    async link(input: {
      personId: string;
      conversationId?: string;
      /** The agent bot whose conversation this job belongs to: the job lands in that person's thread with that bot, not their default one. */ bot?: { id: string; name?: string };
      jobId: string;
      kind: "job" | "coding";
      title: string;
      /** An existing job the person asked about ("show me the research computer"), not one this command started. */ attached?: boolean;
      /**
       * Round 10: the conversation the request was MADE in, when it named a bot from elsewhere ("Ask Research to ..." typed to Jarvis). The job's
       * progress stays in the bot's conversation; this one gets the receipt and the ONE end entry, so the result returns where it was asked for.
       * Ignored when it is the bot's own conversation or someone else's.
       */
      origin?: string;
      /**
       * Round 11: a coding draft made in this conversation, not started yet. It is linked (the conversation is its origin) and watched with no
       * entry; when it starts, from this conversation or the draft page, its "Started" entry, progress and one end entry arrive here.
       */
      pending?: boolean;
    }): Promise<{ conversationId: string; created: boolean } | null> {
      // Someone else's conversation id is never written to; the job goes to this person's own default thread instead.
      const thread = (input.bot ? deps.conversations.ensureThread({ personId: input.personId, bot: input.bot.id, ...(input.bot.name ? { title: input.bot.name } : {}) }) : input.conversationId ? deps.conversations.ensureThread({ id: input.conversationId, personId: input.personId }) : null) ?? deps.conversations.ensureThread({ personId: input.personId });
      if (!thread) return null;
      const reading = await read(input.jobId, input.kind).catch(() => null);
      const state = reading?.state ?? "queued";
      const title = maskJobText(reading?.title || input.title, 200);
      deps.conversations.linkJob(thread.id, { jobId: input.jobId, kind: input.kind, title, state, at: iso() });
      if (input.pending) {
        const prior = watches.get(input.jobId);
        // Never replaces an existing watch (review M2): a job already watched, for anyone, keeps where its report goes.
        if (!isTerminal(state) && !prior) watch(input.jobId, { personId: input.personId, conversationId: thread.id, kind: input.kind, last: state, pendingSince: now() });
        return { conversationId: thread.id, created: false };
      }
      const startedEntry = deps.conversations.appendEntry(thread.id, { key: `${input.jobId}:started`, jobId: input.jobId, state: "started", text: `${input.attached ? "Following" : "Started"}: ${shortTitle(title)} (job ${short(input.jobId)}).`, at: iso(), ...(reading?.jobKind ? { jobKind: reading.jobKind } : input.kind === "coding" ? { jobKind: "coding" as const } : {}) });
      const created = !!startedEntry;
      if (startedEntry && !viaStore) notify(thread.id, input.personId, startedEntry);
      // Where the request was made, when that is not the bot's own conversation: the job is linked there too ("stop that task" and "how's it going"
      // find it), with a receipt that says where the progress is. Someone else's id is refused by ensureThread (null) and nothing is written.
      const origin = input.origin && input.bot ? deps.conversations.ensureThread({ id: input.origin, personId: input.personId }) : null;
      const originId = origin && origin.id !== thread.id ? origin.id : null;
      if (originId) {
        const name = input.bot!.name || input.bot!.id;
        deps.conversations.linkJob(originId, { jobId: input.jobId, kind: input.kind, title, state, at: iso() });
        const receipt = deps.conversations.appendEntry(originId, { key: `${input.jobId}:started`, jobId: input.jobId, state: "started", text: `${input.attached ? "Following" : "Started"} with ${name}: ${shortTitle(title)} (job ${short(input.jobId)}). Its progress is in ${name}'s conversation; the result comes back here.`, at: iso(), ...(reading?.jobKind ? { jobKind: reading.jobKind } : input.kind === "coding" ? { jobKind: "coding" as const } : {}) });
        if (receipt && !viaStore) notify(originId, input.personId, receipt);
      }
      // A job already watched for another of the person's conversations keeps its progress there; this one joins the conversations told how it ends.
      const prior = watches.get(input.jobId);
      // Another person's watch on this job is never taken over (review M2): their report stays theirs; this link writes its receipt only.
      if (prior && prior.personId !== input.personId) return { conversationId: thread.id, created };
      const w: Watch = prior && prior.personId === input.personId
        ? { ...prior, also: [...new Set([...(prior.also ?? []), thread.id, ...(originId ? [originId] : [])])].filter((id) => id !== prior.conversationId) }
        : { personId: input.personId, conversationId: thread.id, kind: input.kind, last: state, ...(originId ? { also: [originId] } : {}) };
      if (!isTerminal(state)) {
        watch(input.jobId, w);
        // Steps the job recorded between starting and being linked (it was already running): the same keys, so none is ever added twice.
        if (input.kind === "job") for (const step of deps.jobs().get(input.jobId)?.steps ?? []) onStep(input.jobId, step);
      }
      else if (reading) append(w, input.jobId, state, reading);
      return { conversationId: thread.id, created };
    },
    /**
     * One half of an exchange in a bot's conversation (Agents workspace): the person's request or the assistant's acknowledgement, as a server
     * entry, so the conversation reads the same on every device and after a cache clear. The key is `<commandId>:request` or `<commandId>:ack`;
     * the same key is a no-op, so a replayed command never writes it twice. The text is masked like every job line. Notifications only.
     */
    /**
     * Has this person's conversation with this bot already received this command (its `<commandId>:request` entry)? The hub's in-memory event
     * dedupe is lost on a restart and after its window; the conversation is durable, so a resend of the same event id after either finds it here
     * and is answered from what was recorded, never run again. `ack` is the recorded reply when there was one.
     * Bounded: a conversation keeps its last 300 entries (conversations.ts), roughly the last 100 commands per bot (a request, a receipt and a reply
     * each), so an id older than that is no longer known here and is run as new. The in-memory event window (30 minutes) covers the rest.
     */
    priorCommand(input: { personId: string; bot: { id: string }; commandId: string }): { request: ThreadEntry; ack: ThreadEntry | null; /** A job (or its receipt) exists from after the request: the command may have started something. */ mayHaveStarted: boolean } | null {
      const c = deps.conversations.get(botThreadId(input.personId, input.bot.id));
      if (!c || c.personId !== input.personId) return null;
      const entries = deps.conversations.entriesAfter(c.id, 0);
      const request = entries.find((e) => e.key === `${input.commandId}:request`);
      if (!request) return null;
      const since = Date.parse(request.at);
      const mayHaveStarted =
        entries.some((e) => e.seq > request.seq && e.state === "started") ||
        deps.jobs().list({ bot: input.bot.id, personId: input.personId, limit: 50 }).some((j) => Date.parse(j.createdAt) >= since - 1000);
      return { request, ack: entries.find((e) => e.key === `${input.commandId}:ack`) ?? null, mayHaveStarted };
    },
    note(input: { personId: string; bot: { id: string; name?: string }; commandId: string; role: "request" | "ack"; text: string; jobId?: string; jobKind?: "computer" | "coding"; blocker?: ThreadBlocker; ok?: boolean; stopped?: boolean; unverified?: boolean; replace?: boolean }): ThreadEntry | null {
      const thread = deps.conversations.ensureThread({ personId: input.personId, bot: input.bot.id, ...(input.bot.name ? { title: input.bot.name } : {}) });
      if (!thread) return null;
      const entry = deps.conversations.appendEntry(thread.id, { key: `${input.commandId}:${input.role}`, jobId: input.jobId ?? "", state: input.role, text: maskJobText(input.text, 600), at: iso(), ...(input.jobKind ? { jobKind: input.jobKind } : {}), ...(input.blocker ? { blocker: input.blocker } : {}), ...(typeof input.ok === "boolean" ? { ok: input.ok } : {}), ...(input.stopped ? { stopped: true } : {}), ...(input.unverified ? { unverified: true } : {}), ...(input.replace ? { replace: true } : {}) });
      if (entry && !viaStore) notify(thread.id, input.personId, entry);
      return entry;
    },
    noteLocal: (personId: string) => rememberLocal(personId),
    isLocal: (personId: string) => local.has(personId),
    /** The person's thread (created empty when missing); null when that conversation id is someone else's. */
    thread(personId: string, conversationId?: string, bot?: { id: string; name?: string }) {
      if (bot) return deps.conversations.ensureThread({ personId, bot: bot.id, ...(bot.name ? { title: bot.name } : {}) });
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
    async active(personId: string, conversationId?: string, scope: { /** Only this conversation's jobs (a bot thread: "stop that task" never reaches a job of another bot or the default thread). */ only?: boolean; /** Also these conversations' jobs (the person's bot threads: the default thread's "stop that task" can mean a bot's task). */ withBots?: string[] } = {}): Promise<ActiveJob[]> {
      // Read-only: asking about jobs never creates a conversation.
      const mine = (id: string) => {
        const c = deps.conversations.get(id);
        return c && c.personId === personId ? c : null;
      };
      // This conversation's jobs and the person's default thread's (typed commands land there): one set of "his jobs".
      const base = scope.only ? [conversationId ? mine(conversationId) : null] : [conversationId ? mine(conversationId) : null, mine(jarvisThreadId(personId))];
      const bots = (scope.withBots ?? []).map((id) => mine(id));
      const convs = [...base, ...bots].filter((c, i, a): c is NonNullable<typeof c> => !!c && a.findIndex((x) => x?.id === c.id) === i);
      const out: ActiveJob[] = [];
      for (const c of convs) for (const l of c.jobs ?? []) {
        const seen = out.find((o) => o.jobId === l.jobId);
        if (seen) {
          // A bot's job is also linked where it was asked for (round 10): it is still THAT bot's job ("which one to stop" asks by bot, never by recency).
          if (!seen.bot && c.bot) Object.assign(seen, { bot: c.bot, conversationId: c.id });
          continue;
        }
        const r = await read(l.jobId, l.kind).catch(() => null);
        const state = r?.state ?? l.state;
        // A coding draft linked as pending (round 11) is not a running job: "stop that task" and "how's it going" never pick it until it starts.
        if (l.kind === "coding" && DRAFTED.has(state)) continue;
        out.push({ jobId: l.jobId, kind: l.kind, title: r?.title || l.title, state, lastReferencedAt: Date.parse(l.lastReferencedAt) || now(), conversationId: c.id, ...(c.bot ? { bot: c.bot } : {}) });
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
export { botThreadId };
