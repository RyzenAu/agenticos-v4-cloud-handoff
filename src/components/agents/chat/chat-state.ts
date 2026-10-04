// The pure model of one bot conversation: how server entries and the person's own lines become one ordered, de-duplicated transcript, and how that
// transcript is read as blocks (a request, its acknowledgement, one card per job). No React, no fetch, no storage: tested without a browser.
//
// Reuses src/lib/thread-events.ts for the rules that matter (an entry is keyed, so applying it twice is a no-op; `entryKind` says what it is).
import type { BotThreadEntry, BlockerHint, StoredItem } from "@/lib/agent-chat";
import { entryKind, foldEntry, hasSavedResult, jobIdOf, viaFor, type EntryKind } from "@/lib/thread-events";

/** What an entry is. "info" is a note the hub adds about a job AFTER or beside its work (memory saved / not saved): never a state of the job, never a step. */
export type ItemKind = EntryKind | "info";
const isInfo = (entry: { key: string; state: string }) => entry.state === "note" || /:memory$/.test(entry.key);

export type Item = {
  who: "you" | "oracle";
  text: string;
  /** `job:<key>` for a server entry (thread-events' identity); `local:<key>` for the person's request and its acknowledgement. */
  via: string;
  type: "request" | "ack" | "entry";
  key: string;
  /** Epoch ms: the order of the thread. */
  at: number;
  seq: number;
  jobId: string;
  state: string;
  kind: ItemKind | null;
  jobKind: "job" | "coding";
  blocker?: BlockerHint;
  /** request: how it was given. */
  source?: "typed" | "voice";
  /** request: sent but not yet acknowledged. */
  pending?: boolean;
  /** ack: the command was accepted. false: it did not start anything. */
  ok?: boolean;
  /** ack: this browser never learned how the command ended (a timeout, a dropped link), so the hub may have it. Not the same as `ok: false`. */
  unconfirmed?: boolean;
  /** The server wrote this line into the thread: authoritative. A line only this device holds (an offline send) has no `server`. */
  server?: boolean;
};

export type ChatState = { items: Item[]; /** Highest server seq seen: where a catch-up resumes. */ maxSeq: number };
export const emptyChat = (): ChatState => ({ items: [], maxSeq: 0 });

const atOf = (iso: string, fallback: number) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
};

function sorted(items: Item[]): Item[] {
  // Stable by (at, seq): the server's order inside one instant, insertion order otherwise.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at - b.item.at || (a.item.type === "entry" && b.item.type === "entry" ? a.item.seq - b.item.seq : 0) || a.index - b.index)
    .map((x) => x.item);
}

/**
 * Fold server entries (a live event, a catch-up page, a reconnect snapshot) into the transcript. Idempotent by entry key: a replay, a second tab or
 * a catch-up overlapping a live event changes nothing. `applied` lists only what was genuinely new, in order.
 */
export function applyEntries(state: ChatState, entries: BotThreadEntry[], now = Date.now()): { state: ChatState; applied: Item[] } {
  let items = state.items;
  let maxSeq = state.maxSeq;
  const applied: Item[] = [];
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    maxSeq = Math.max(maxSeq, entry.seq);
    // The hub writes the person's request and its acknowledgement into the thread (`<eventId>:request` / `:ack`). Those are the SAME lines as
    // the ones this device showed on send (its event id is the command id), so the server's copy replaces the local one, never sits beside it.
    const own = /^(.+):(request|ack)$/.exec(entry.key);
    if (own && (entry.state === "request" || entry.state === "ack")) {
      const role = own[2] as "request" | "ack";
      const via = `local:${own[1]}:${role}`;
      const existing = items.find((i) => i.via === via);
      const spoken = role === "request" && /^spoken request\.?$/i.test(entry.text.trim());
      const item: Item = {
        who: role === "request" ? "you" : "oracle",
        text: entry.text,
        via,
        type: role,
        key: own[1],
        at: atOf(entry.at, now),
        seq: entry.seq,
        jobId: entry.jobId || existing?.jobId || "",
        state: entry.state,
        kind: null,
        jobKind: entry.jobKind ?? existing?.jobKind ?? "job",
        server: true,
        // The hub's own ack means the hub handled the command: a line this device marked unconfirmed is settled by it (ok), never kept as a failure.
        // The hub's own verdict (`ok` on its reply) wins; only an older entry without one falls back to what this device knew.
        ...(role === "request" ? { source: spoken ? ("voice" as const) : (existing?.source ?? "typed"), pending: false } : { ok: entry.unverified ? false : typeof entry.ok === "boolean" ? entry.ok : existing && !existing.unconfirmed ? (existing.ok ?? true) : true, ...(entry.unverified ? { unconfirmed: true } : {}) }),
        ...(entry.blocker ? { blocker: entry.blocker } : {}),
      };
      // The same entry again changes nothing; a reply the hub wrote AGAIN (a command that was never run, run on a resend) is newer and replaces it.
      if (existing?.server && entry.seq <= existing.seq) continue;
      items = existing ? items.map((i) => (i === existing ? item : i)) : [...items, item];
      // An ack ends its request's pending state and links it to the job.
      if (role === "ack") items = items.map((i) => (i.via === `local:${own[1]}:request` ? { ...i, pending: false, jobId: item.jobId || i.jobId } : i));
      applied.push(item);
      continue;
    }
    const folded = foldEntry<Item>(items, { seq: entry.seq, key: entry.key, at: entry.at, jobId: entry.jobId, state: entry.state, text: entry.text });
    if (!folded.applied) continue;
    const via = viaFor(entry.key);
    const decorated: Item = {
      who: "oracle",
      text: entry.text,
      via,
      type: "entry",
      key: entry.key,
      at: atOf(entry.at, now),
      seq: entry.seq,
      jobId: entry.jobId || jobIdOf(via) || "",
      state: entry.state,
      kind: isInfo(entry) ? "info" : entryKind(via),
      jobKind: entry.jobKind ?? "job",
      ...(entry.blocker ? { blocker: entry.blocker } : {}),
    };
    items = [...folded.turns.slice(0, -1), decorated];
    applied.push(decorated);
  }
  return { state: applied.length || maxSeq !== state.maxSeq ? { items: sorted(items), maxSeq } : state, applied };
}

/** The person's request, shown at once (pending until the command answers). Same key twice: unchanged. */
export function addRequest(state: ChatState, req: { key: string; text: string; source: "typed" | "voice"; at: number }): ChatState {
  const via = `local:${req.key}:request`;
  if (state.items.some((i) => i.via === via)) return state;
  const item: Item = { who: "you", text: req.text, via, type: "request", key: req.key, at: req.at, seq: 0, jobId: "", state: "", kind: null, jobKind: "job", source: req.source, pending: true };
  return { ...state, items: sorted([...state.items, item]) };
}

/** The command's one-line answer: ends the request's pending state, links it to its job, and adds the acknowledgement (once). */
export function addAck(state: ChatState, ack: { key: string; text: string; ok: boolean; jobId: string | null; at: number; unconfirmed?: boolean }): ChatState {
  const reqVia = `local:${ack.key}:request`;
  const ackVia = `local:${ack.key}:ack`;
  let items = state.items.map((i) => (i.via === reqVia ? { ...i, pending: false, jobId: ack.jobId ?? i.jobId } : i));
  const have = items.find((i) => i.via === ackVia);
  // The hub's own line is authoritative; a line only this device wrote (an unconfirmed send) is replaced by the answer of a resend.
  if (have && !have.server && have.unconfirmed && !ack.unconfirmed) items = items.map((i) => (i === have ? { ...i, text: ack.text, ok: ack.ok, jobId: ack.jobId ?? "", unconfirmed: false } : i));
  if (!have) {
    const request = items.find((i) => i.via === reqVia);
    // One tick after its request, so the acknowledgement always reads straight after it.
    const at = Math.max(ack.at, (request?.at ?? ack.at) + 1);
    items = [...items, { who: "oracle", text: ack.text, via: ackVia, type: "ack", key: ack.key, at, seq: 0, jobId: ack.jobId ?? "", state: "", kind: null, jobKind: "job", ok: ack.ok, ...(ack.unconfirmed ? { unconfirmed: true } : {}) }];
  }
  return { ...state, items: sorted(items) };
}

/** Restore what the person said and what was answered on an earlier visit. */
export function withStored(state: ChatState, stored: StoredItem[]): ChatState {
  let s = state;
  for (const i of stored) {
    if (i.type === "request") {
      s = addRequest(s, { key: i.key.replace(/:request$/, ""), text: i.text, source: i.source ?? "typed", at: i.at });
      s = { ...s, items: s.items.map((x) => (x.via === `local:${i.key.replace(/:request$/, "")}:request` ? { ...x, pending: false, jobId: i.jobId ?? x.jobId } : x)) };
    } else {
      s = addAck(s, { key: i.key.replace(/:ack$/, ""), text: i.text, ok: i.ok !== false, jobId: i.jobId ?? null, at: i.at, ...(i.unconfirmed ? { unconfirmed: true } : {}) });
    }
  }
  return s;
}

/** The part of the transcript worth keeping on this device (the person's own lines). */
export function toStored(state: ChatState): StoredItem[] {
  return state.items
    .filter((i) => i.type !== "entry" && !i.pending && !i.server)
    .map((i) => ({ type: i.type as "request" | "ack", key: i.key, at: i.at, text: i.text, ...(i.jobId ? { jobId: i.jobId } : {}), ...(i.source ? { source: i.source } : {}), ...(i.ok === false ? { ok: false } : {}), ...(i.unconfirmed ? { unconfirmed: true } : {}) }));
}

// ---- reading the transcript as blocks ----------------------------------------------------------------------------------------------------

export type RunStatus = "running" | "blocked" | "done" | "failed" | "stopped" | "unclear";
export type Run = {
  type: "run";
  jobId: string;
  jobKind: "job" | "coding";
  /** Every entry of this job, in order. The first is the "started" line; progress steps follow. */
  entries: Item[];
  status: RunStatus;
  last: Item;
  /** The job's title as the server worded it ("Started: <title> (job 1234abcd)." -> title), when known. */
  title: string;
  /** The entry that carries the result text (report), when there is one. */
  result?: Item;
  /** Steps shown in the collapsible list: everything except the started line and the informational notes. */
  steps: Item[];
  /** Informational notes about the job (memory saved / not saved): small lines under the result, never steps and never a state. */
  notes: Item[];
  /** A saved artifact exists for this job: /__computers/artifacts/<jobId>. */
  hasSavedResult: boolean;
};
export type Block = { type: "request"; item: Item } | { type: "ack"; item: Item } | { type: "note"; item: Item } | Run;

const TERMINAL = new Set<ItemKind>(["result", "finished", "failed", "stopped", "unknown"]);
const STATUS_BY_KIND: Record<EntryKind, RunStatus> = { started: "running", progress: "running", update: "running", result: "done", finished: "done", failed: "failed", stopped: "stopped", waiting: "blocked", unknown: "unclear" };

/** "Started: Find dentists (job abcd1234)." -> "Find dentists". Otherwise the first line, trimmed. */
export function titleOf(text: string): string {
  const m = /^(?:Started|Following):\s*(.+?)\s*\(job [0-9a-f]{8}\)\.?\s*$/i.exec(text.split("\n")[0] ?? "");
  return (m ? m[1] : (text.split("\n")[0] ?? "")).slice(0, 140);
}

export function toBlocks(state: ChatState): Block[] {
  const blocks: Block[] = [];
  const runs = new Map<string, Run>();
  for (const item of state.items) {
    if (item.type === "request") blocks.push({ type: "request", item });
    else if (item.type === "ack") blocks.push({ type: "ack", item });
    else if (!item.jobId) blocks.push({ type: "note", item });
    else {
      let run = runs.get(item.jobId);
      if (!run) {
        run = { type: "run", jobId: item.jobId, jobKind: item.jobKind, entries: [], status: "running", last: item, title: "", steps: [], notes: [], hasSavedResult: false };
        runs.set(item.jobId, run);
        blocks.push(run);
      }
      run.entries.push(item);
      if (item.jobKind === "coding") run.jobKind = "coding";
    }
  }
  // A job started by a request belongs right after that request's acknowledgement, whatever the two clocks say (the hub's entry can carry a
  // time a moment before the browser's own line, and it often arrives before the command's answer does).
  for (const ack of blocks) {
    if (ack.type !== "ack" || !ack.item.jobId) continue;
    const run = runs.get(ack.item.jobId);
    const from = run ? blocks.indexOf(run) : -1;
    const to = blocks.indexOf(ack);
    if (run && from >= 0 && from < to) {
      blocks.splice(from, 1);
      blocks.splice(blocks.indexOf(ack) + 1, 0, run);
    }
  }
  for (const run of runs.values()) {
    const ordered = [...run.entries].sort((a, b) => a.seq - b.seq);
    run.entries = ordered;
    // The job's status comes from its state entries. A note never counts, and once the job has reached a terminal entry nothing that is only progress
    // (a late step, a repeated started line) can reopen it; only a new state (waiting, another terminal) can.
    let counted = ordered.find((e) => e.kind !== "info") ?? ordered[0];
    let status: RunStatus = STATUS_BY_KIND[counted.kind === "info" || counted.kind === null ? "update" : counted.kind];
    let terminal = false;
    for (const e of ordered) {
      const k = e.kind ?? "update";
      if (k === "info") continue;
      if (terminal && (k === "progress" || k === "started")) continue;
      counted = e;
      status = STATUS_BY_KIND[k];
      if (TERMINAL.has(k)) terminal = true;
    }
    run.last = counted;
    run.status = status;
    run.notes = ordered.filter((e) => e.kind === "info");
    // A person took the computer: the takeover blocker sits on a progress entry, but the job is held until control is returned.
    if (run.status === "running" && normaliseBlockerKind(run.last.blocker?.kind) === "take-over") run.status = "blocked";
    const started = ordered.find((e) => e.kind === "started");
    run.title = titleOf((started ?? ordered[0]).text);
    run.result = [...ordered].reverse().find((e) => e.kind === "result");
    run.steps = ordered.filter((e) => e.kind !== "started" && e.kind !== "info");
    run.hasSavedResult = ordered.some((e) => e.kind === "result" && hasSavedResult(e.text));
  }
  return blocks;
}

/** True when any job in the conversation is waiting for the person: the bot's "Needs you" state. */
export const needsYou = (blocks: Block[]) => blocks.some((b) => b.type === "run" && b.status === "blocked");
/** True when any job is still going (sending more is still allowed; this is for the status line). */
export const working = (blocks: Block[]) => blocks.some((b) => b.type === "run" && (b.status === "running" || b.status === "blocked"));

// ---- blockers and recovery -----------------------------------------------------------------------------------------------------------

/** The blocker kind the card reasons in, from the server's kind. Unknown or absent: undefined, so the job's state decides. */
export type BlockerKindNorm = "approval" | "take-over" | "owner" | "allowance" | "offline" | "failed";
export function normaliseBlockerKind(kind: string | undefined): BlockerKindNorm | undefined {
  switch (kind) {
    case "needs-approval": case "approval": return "approval";
    case "needs-takeover": case "take-over": return "take-over";
    case "needs-owner": case "owner": return "owner";
    case "allowance": case "offline": case "failed": return kind;
    default: return undefined;
  }
}

export type RecoveryAction = "take-over" | "return-controls" | "approve" | "retry" | "reconnect" | "open-job";
/** `kind`: the blocker it answers, when it answers one (the computer panel already says who holds the controls, so it can leave a take-over out). */
export type Recovery = { tone: "warn" | "danger" | "info"; title: string; body: string; actions: RecoveryAction[]; kind?: BlockerKindNorm };

/**
 * A body that opens by repeating its title keeps only what it adds. The hub's own sentence for a person holding the controls is "Paused while you have
 * the controls. Return them when you're done." under the title "Paused while you have the controls": the card read the same words twice (round 8).
 */
export function withoutTitle(title: string, body: string): string {
  const t = title.trim().replace(/[.!]+$/, "");
  const b = body.trim();
  if (!t || !b.toLowerCase().startsWith(t.toLowerCase())) return b;
  const rest = b.slice(t.length).replace(/^[\s.!,;:]+/, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "";
}

const STATE = (s: string) => s.toLowerCase().replace(/_/g, "-");

/**
 * What the person can DO about a run that is blocked, failed or of unclear outcome. Honest and short: the server's own sentence is shown as the
 * reason; the recovery line says the next move. Returns null when there is nothing to do (running, done, stopped on purpose).
 */
/** The recovery for a blocker (the server's kind first; an unknown or absent kind falls back to the job's state). Also what an acknowledgement line shows. */
export function recoveryOfBlocker(b: BlockerHint | undefined, state = ""): Recovery {
  const kind = normaliseBlockerKind(b?.kind) ?? (/awaiting-(approval|confirmation)/.test(state) ? "approval" : /needs-owner/.test(state) ? "owner" : /blocked-allowance/.test(state) ? "allowance" : undefined);
  const r = recoveryFor_(kind, b);
  // Never the title twice: a body that only repeated it falls back to the default sentence for that blocker.
  const body = withoutTitle(r.title, r.body) || withoutTitle(r.title, recoveryFor_(kind, b ? withoutRecovery(b) : undefined).body) || r.body;
  return { ...r, body, ...(kind ? { kind } : {}) };
}

const withoutRecovery = ({ recovery: _said, ...rest }: BlockerHint): BlockerHint => rest;

function recoveryFor_(kind: BlockerKindNorm | undefined, b: BlockerHint | undefined): Recovery {
  if (kind === "approval") return { tone: "warn", title: "Needs your approval", body: b?.recovery ?? "It will not go further until you approve or decline.", actions: ["approve", "open-job"] };
  // The person holding the controls is not told to wait for somebody to hand them back: one calm sentence and ONE action, to the computer where the
  // controls are returned. Somebody else holding them is a wait, with nothing to press.
  if (kind === "take-over" && b?.held === "you") return { tone: "info", title: "Paused while you have the controls", body: b.recovery ?? "Return the controls when you're done and it carries on from the same step.", actions: ["return-controls"] };
  if (kind === "take-over" && b?.held === "other") return { tone: "info", title: "Someone else has the controls", body: b.recovery ?? "The job carries on when they hand the controls back.", actions: [] };
  if (kind === "take-over") return { tone: "warn", title: "Needs you at the computer", body: b?.recovery ?? "Take over, do the step it could not, then hand back and it carries on.", actions: ["take-over", "open-job"] };
  if (kind === "owner") return { tone: "warn", title: "Needs your decision", body: b?.recovery ?? "It stopped and needs your decision. Open the job to see why, then resume it or stop it.", actions: ["open-job"] };
  if (kind === "allowance") return { tone: "warn", title: "The account is at its limit", body: b?.recovery ?? "The account it uses has reached its limit. Retry when it resets, or open the job to pick another account.", actions: ["retry", "open-job"] };
  if (kind === "offline") return { tone: "warn", title: "The computer is offline", body: b?.recovery ?? "Reconnect it, then it picks the job up again.", actions: ["reconnect", "open-job"] };
  return { tone: "warn", title: "Needs you", body: b?.recovery ?? "Open the job to see what it is waiting for.", actions: ["open-job"] };
}

export function recoveryFor(run: Run): Recovery | null {
  const b = run.last.blocker;
  if (run.status === "blocked") return recoveryOfBlocker(b, STATE(run.last.state));
  if (run.status === "failed") return { tone: "danger", title: "That did not finish", body: b?.recovery ?? "Open the job to see where it stopped, or try the request again.", actions: ["retry", "open-job"] };
  if (run.status === "unclear") return { tone: "info", title: "Outcome unclear", body: b?.recovery ?? "Contact was lost before this finished. Check again before you repeat the request.", actions: ["reconnect", "open-job"] };
  return null;
}

/** Whether an entry is a completion worth one notification (a result or a failure), and its short line. */
export const isNotable = (item: Item) => item.type === "entry" && (item.kind === "result" || item.kind === "finished" || item.kind === "failed" || item.kind === "waiting");
