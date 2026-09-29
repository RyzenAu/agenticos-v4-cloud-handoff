// The Job service (TARGET-ARCHITECTURE §3.3): ONE durable history for voice, screen, control, away,
// coding, memory and lessons. `jobs.sqlite` (WAL) under .operator-data.
//
//   create  → queued (idempotent on requestId)
//   run     → admits a QUEUED job only, atomically; so nothing interrupted, unknown or finished can ever
//             run again (no replay). The executor gets an abort signal, a step logger and child registration.
//   cancel  → cooperative durable flag + executor abort + tree-kill of every registered child
//             (`taskkill /pid <pid> /t /f` on Windows). A stop the OS doesn't acknowledge within the grace
//             period QUARANTINES the job (state `unknown`) and blocks new runs of that kind until released.
//   recover → at startup, by the single recovery owner: running → unknown (never re-run), queued and
//             awaiting-approval → interrupted. Approvals keep their own durable state (approvals/service).
//
// Privacy: steps are masked like the screen run log (maskLine: e-mails and long digit runs), and the
// executor is expected to pass typed payloads as placeholders already. No prompts or outputs are stored.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isPrincipal, principalRef, publicPrincipal, type Principal } from "../approvals/principal";
import { stopOwnedChild } from "../jarvis-execution/child";
import { captureTree, systemProcessTable, treeStillPresent, type ProcessAccounting, type ProcessRow, type TreeMember } from "../jarvis-execution/process-accounting";
import { maskLine } from "../screen-hands/run-log";
import {
  JOB_KINDS,
  TERMINAL_STATES,
  type Job,
  type JobEvent,
  type JobKind,
  type JobState,
  type JobSummary,
  type Receipt,
  type ReceiptOutcome,
  type Step,
  type StepOutcome,
} from "./types";

export * from "./types";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STEP_OUTCOMES: readonly StepOutcome[] = ["ok", "failed", "skipped", "refused", "asked", "cancelled", "unknown", "note"];
const RECEIPT_OUTCOMES: readonly ReceiptOutcome[] = ["succeeded", "failed", "cancelled", "timed_out", "termination_unverified", "refused_policy", "rate_limited", "unknown"];
export const MAX_STEPS_PER_JOB = 400;
const KEEP_EVENTS = 5000;
const KEEP_JOBS = 2000;

type JobRow = {
  id: string; kind: JobKind; principal: string; target_device_id: string; state: JobState; title: string; request_id: string | null;
  approval_id: string | null; cancel_requested: number; quarantined: number; quarantine_reason: string | null; note: string | null;
  created_at: number; updated_at: number;
};
type StepRow = { job_id: string; seq: number; data: string };
type ReceiptRow = { job_id: string; data: string };

const iso = (ms: number) => new Date(ms).toISOString();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function summary(r: JobRow, stepCount: number, lastStep: Step | null): JobSummary {
  return {
    id: r.id,
    kind: r.kind,
    principal: publicPrincipal(JSON.parse(r.principal)),
    targetDeviceId: r.target_device_id,
    state: r.state,
    title: r.title,
    ...(r.request_id ? { requestId: r.request_id } : {}),
    ...(r.approval_id ? { approvalId: r.approval_id } : {}),
    cancelRequested: r.cancel_requested === 1,
    quarantined: r.quarantined === 1,
    ...(r.quarantine_reason ? { quarantineReason: r.quarantine_reason } : {}),
    ...(r.note ? { note: r.note } : {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    stepCount,
    lastStep,
  };
}

/**
 * The job store's masking, a stricter second pass over the executor's own: full-width forms folded (NFKC),
 * typed payloads ("type 'hello'") as a placeholder, any run of 6+ digits (OTPs, phone, account, cards
 * with spaces, dashes or dots) as [number], away-style one-time codes as [code], then run-log's maskLine
 * (e-mails). ISO dates stay.
 */
export function maskJobText(text: unknown, max = 300): string {
  let s = String(text ?? "").normalize("NFKC");
  s = s.replace(/\b(type|typed|typing|enter|entered|paste|pasted|write|wrote|fill|filled|dictate|dictated)\s+(["'“‘«])(.+?)(["'”’»])/gi, (_m, verb: string, _o, body: string) => `${verb} [typed ${body.length} characters]`);
  // An unquoted one-word payload typed into a field ("typed hunter2 into Password").
  s = s.replace(/\b(type|typed|typing|enter|entered|paste|pasted)\s+(?![[(])(\S+)\s+(into|in|on)\b/gi, (_m, verb: string, body: string, prep: string) => `${verb} [typed ${body.length} characters] ${prep}`);
  // The value after a secret's name ("PIN 4821", "password: x", "OTP=123").
  // Needs a separator (is / : / = / #) or a digit in the value, so "the PIN pad" stays readable.
  s = s.replace(/\b(pin|passcode|password|passwd|otp|cvv|cvc)\b(\s*(?:\bis\b|:|=|#)\s*|\s+(?=\S*\d))(?![[(])(\S+)/gi, (_m, name: string, sep: string) => `${name}${sep}[secret]`);
  s = s.replace(/\d(?:[ .\-_·]?\d)*/g, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) || m.replace(/\D/g, "").length < 6 ? m : "[number]"));
  s = s.replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4}\b/g, "[code]");
  return maskLine(s, max);
}

/** Mask and bound a step before it is stored (a defensive second pass over the executor's own masking). */
export function maskStep(input: Omit<Step, "seq" | "at">, seq: number, at: number): Step {
  const jev = input.jev
    ? {
        op: maskJobText(input.jev.op, 60),
        confidence: Math.min(1, Math.max(0, num(input.jev.confidence) ?? 0)),
        policy: maskJobText(input.jev.policy, 30),
        ...(input.jev.delegateTo ? { delegateTo: maskJobText(input.jev.delegateTo, 60) } : {}),
        ...(input.jev.deviceId ? { deviceId: maskJobText(input.jev.deviceId, 80) } : {}),
        ...(num(input.jev.ms) !== null ? { ms: Math.round(input.jev.ms!) } : {}),
        inputTokens: num(input.jev.inputTokens),
        outputTokens: num(input.jev.outputTokens),
      }
    : undefined;
  const v = input.verification;
  return {
    seq,
    at,
    intent: maskJobText(input.intent, 200) || "step",
    executor: maskJobText(input.executor, 40) || "none",
    ...(input.target ? { target: maskJobText(input.target, 120) } : {}),
    ...(jev ? { jev } : {}),
    ...(input.action ? { action: maskJobText(input.action, 200) } : {}),
    ...(v ? { verification: { method: maskJobText(v.method, 60), ok: typeof v.ok === "boolean" ? v.ok : null, ...(v.evidence ? { evidence: maskJobText(v.evidence, 200) } : {}) } } : {}),
    ...(input.approvalId && UUID.test(input.approvalId) ? { approvalId: input.approvalId } : {}),
    ms: Math.max(0, Math.round(num(input.ms) ?? 0)),
    outcome: STEP_OUTCOMES.includes(input.outcome) ? input.outcome : "note",
  };
}

/** Validate a receipt: unknown stays null (never 0), routes and outcomes are enums, no free text beyond a short reason. */
export function cleanReceipt(r: Receipt): Receipt {
  if (!r || typeof r !== "object") throw new Error("Invalid receipt");
  if (!["free", "subscription", "metered"].includes(r.route)) throw new Error("Invalid receipt route");
  if (!["jev", "rule", "owner"].includes(r.selectedBy)) throw new Error("Invalid receipt selectedBy");
  const nonNeg = (v: unknown) => {
    const n = num(v);
    return n !== null && n >= 0 ? n : null;
  };
  return {
    requestId: maskLine(r.requestId, 80),
    provider: maskLine(r.provider, 60),
    model: maskLine(r.model, 120),
    route: r.route,
    selectedBy: r.selectedBy,
    reason: maskLine(r.reason, 200),
    inputTokens: nonNeg(r.inputTokens),
    outputTokens: nonNeg(r.outputTokens),
    // A subscription call records allowance, not cash.
    costUsd: r.route === "subscription" ? null : nonNeg(r.costUsd),
    ...(r.allowance ? { allowance: { plan: maskLine(r.allowance.plan, 60), window: maskLine(r.allowance.window, 40), usedPct: nonNeg(r.allowance.usedPct) } } : {}),
    latencyMs: nonNeg(r.latencyMs),
    outcome: RECEIPT_OUTCOMES.includes(r.outcome) ? r.outcome : "unknown",
    fallbackFrom: typeof r.fallbackFrom === "string" && r.fallbackFrom ? maskLine(r.fallbackFrom, 120) : null,
  };
}

/** Why a job kind is held. */
export type QuarantineReason = "termination_unverified" | "identity_unverified" | "process_table_unreadable" | "stop_ignored";
/** PID + creation time must match within this to be the same process (process-accounting's tolerance). */
const IDENTITY_TOLERANCE_MS = 1500;
type ActiveRun = {
  controller: AbortController;
  children: Map<number, TreeMember>;
  captures: Promise<void>[];
  stopping: Promise<boolean> | null;
  settled: Promise<void>;
  finished: Promise<void>;
  treeUnverified?: boolean;
  /** The executor didn't settle within the grace period after the stop. */
  settledLate?: boolean;
  snapshotTimer?: ReturnType<typeof setInterval>;
};

/**
 * THE EXECUTOR CONTRACT (review R2):
 * - When `signal` aborts, stop, and return `{ ok: false }` (or throw). `ok: true` means "the action
 *   COMPLETED"; returned after a stop, it is recorded as `succeeded` and the job kind is quarantined
 *   (stop_ignored), because the history must say it happened. `runChild` already returns not-ok on abort.
 * - Register every process you spawn with `registerChild` straight after spawning (pass its creation time
 *   when you have it); the service snapshots its descendants so an orphan can still be found and killed.
 * - Call `childExited` when a child exits on its own. Its descendants are still tracked.
 * - Settle within the grace period after the abort (default 5 s), or the job is quarantined as unknown.
 */
export type ExecutorContext = {
  jobId: string;
  /** Aborted on a stop: stop promptly and return `{ ok: false }`. */
  signal: AbortSignal;
  /** Append a step (masked). */
  step(step: Omit<Step, "seq" | "at">): Step | null;
  /** Register a spawned child so cancel can tree-kill it (its creation time is read from the OS when not given). */
  registerChild(pid: number, created?: number | null): void;
  /** The child exited on its own: it isn't killed, but its descendants stay tracked. */
  childExited(pid: number): void;
  /** The durable cooperative flag (another process may have set it). */
  cancelRequested(): boolean;
  /** The job waits for an approval (state awaiting-approval) and back to running once it returns. */
  awaitingApproval(approvalId: string): void;
  resumed(): void;
  receipt(receipt: Receipt): void;
};
/** `ok: true` only when the action completed; after a stop, return `ok: false` (see the contract above). */
export type Execution = {
  ok: boolean;
  note?: string;
  /**
   * `ok: true` only: the action had ALREADY completed and been checked when the stop arrived (a race, not an
   * ignored stop). Recorded as succeeded with that note, without the stop_ignored quarantine.
   */
  completedBeforeStop?: boolean;
  /**
   * How work that didn't run to an outcome here settles: `awaiting-approval` (it asked a question and is
   * waiting for the person's answer), `handed-off` (it passed the request to another tool; nothing ran here,
   * recorded as succeeded with the note). Never used after a stop.
   */
  settle?: "awaiting-approval" | "handed-off";
  /** `ok: false` after a stop: the note to record instead of "Stopped on request." (e.g. "a step may still finish"). */
  stopNote?: string;
};
export type CancelResult = { ok: boolean; state: JobState | null; aborted: boolean; acknowledged: boolean | null; quarantined: boolean };

export type JobServiceOptions = {
  path: string;
  now?: () => number;
  readOnly?: boolean;
  /** Tree-kill one owned child; resolves true only when the OS acknowledged the stop. */
  kill?: (pid: number) => Promise<boolean>;
  /** How long the executor may take to settle after a stop before the job is quarantined. */
  stopGraceMs?: number;
  /** Independent OS process table (PID, parent, creation time) for identity checks and release. */
  accounting?: ProcessAccounting;
  /** How often a running job's process tree is snapshotted (0 = only at registration). */
  snapshotMs?: number;
};

export class JobService {
  private db: Database;
  private now: () => number;
  private kill: (pid: number) => Promise<boolean>;
  private graceMs: number;
  private active = new Map<string, ActiveRun>();
  private accounting: ProcessAccounting;
  private snapshotMs: number;
  private listeners = new Set<(event: JobEvent) => void>();
  private inserts = 0;
  private creates = 0;
  readonly readOnly: boolean;

  constructor(options: JobServiceOptions) {
    this.now = options.now ?? Date.now;
    this.kill = options.kill ?? ((pid) => stopOwnedChild({ pid }));
    this.graceMs = options.stopGraceMs ?? 5_000;
    this.accounting = options.accounting ?? systemProcessTable;
    this.snapshotMs = options.snapshotMs ?? 5_000;
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path, this.readOnly ? { readonly: true } : { create: true });
    this.db.exec("PRAGMA busy_timeout=3000;");
    if (this.readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, principal TEXT NOT NULL, target_device_id TEXT NOT NULL, state TEXT NOT NULL,
        title TEXT NOT NULL, request_id TEXT UNIQUE, approval_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0, quarantine_reason TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, kind);
      CREATE TABLE IF NOT EXISTS steps (job_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (job_id, seq));
      CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipts_job ON receipts(job_id);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS children (job_id TEXT NOT NULL, pid INTEGER NOT NULL, created INTEGER, exited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (job_id, pid));
      CREATE TABLE IF NOT EXISTS quarantine_trees (job_id TEXT PRIMARY KEY, since INTEGER NOT NULL, members TEXT NOT NULL);`);
  }

  close() {
    if (this.active.size) throw new Error("Cannot close the job store while jobs are running");
    this.db.close();
  }
  subscribe(listener: (event: JobEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private writable() {
    if (this.readOnly) throw new Error("The job store is open read-only here");
  }
  private jobRow(id: string): JobRow | null {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    return this.db.query("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | null;
  }
  private lastStep(id: string): { count: number; last: Step | null } {
    const row = this.db.query("SELECT COUNT(*) AS n, MAX(seq) AS m FROM steps WHERE job_id=?").get(id) as { n: number; m: number | null };
    const last = row.m === null ? null : (this.db.query("SELECT data FROM steps WHERE job_id=? AND seq=?").get(id, row.m) as { data: string }).data;
    return { count: row.n, last: last ? JSON.parse(last) : null };
  }
  private summaryOf(id: string): JobSummary | null {
    const r = this.jobRow(id);
    if (!r) return null;
    const { count, last } = this.lastStep(id);
    return summary(r, count, last);
  }
  private event(jobId: string, type: JobEvent["type"], data: unknown) {
    const at = this.now();
    const seq = Number(this.db.query("INSERT INTO events (job_id, at, type, data) VALUES (?, ?, ?, ?)").run(jobId, at, type, JSON.stringify(data)).lastInsertRowid);
    if (++this.inserts % 200 === 0) this.db.query("DELETE FROM events WHERE seq < ?").run(seq - KEEP_EVENTS);
    const ev = { seq, at, type, jobId, ...(type === "job" ? { job: data } : type === "step" ? { step: data } : { receipt: data }) } as JobEvent;
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* a listener never breaks a job */
      }
    }
  }
  private jobChanged(id: string) {
    const s = this.summaryOf(id);
    if (s) this.event(id, "job", s);
  }
  private setState(id: string, to: JobState, from: readonly JobState[], note?: string): boolean {
    const changed = this.db
      .query(`UPDATE jobs SET state=?, updated_at=?, note=COALESCE(?, note) WHERE id=? AND state IN (${from.map(() => "?").join(",")})`)
      .run(to, this.now(), note ? maskJobText(note, 200) : null, id, ...from).changes;
    if (changed) this.jobChanged(id);
    return changed === 1;
  }

  create(input: { kind: JobKind; principal: Principal; targetDeviceId: string; title: string; requestId?: string; approvalId?: string }): Job {
    this.writable();
    if (!JOB_KINDS.includes(input.kind)) throw new Error("Unknown job kind");
    if (!isPrincipal(input.principal)) throw new Error("A verified principal is required");
    if (typeof input.targetDeviceId !== "string" || !/^[\w:.-]{1,80}$/.test(input.targetDeviceId)) throw new Error("A target device is required");
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[\w:.-]{1,80}$/.test(input.requestId))) throw new Error("Invalid request id");
    if (input.requestId) {
      const existing = this.db.query("SELECT id FROM jobs WHERE request_id=?").get(input.requestId) as { id: string } | null;
      if (existing) return this.get(existing.id)!;
    }
    const id = randomUUID(), now = this.now();
    this.db
      .query("INSERT INTO jobs (id, kind, principal, target_device_id, state, title, request_id, approval_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
      .run(id, input.kind, JSON.stringify(principalRef(input.principal)), input.targetDeviceId, maskJobText(input.title, 200) || input.kind,
        input.requestId ?? null, input.approvalId && UUID.test(input.approvalId) ? input.approvalId : null, now, now);
    this.jobChanged(id);
    if (++this.creates % 100 === 0) this.prune();
    return this.get(id)!;
  }
  /** Keep the newest KEEP_JOBS jobs; older FINISHED ones go with their steps and receipts (never a quarantined one). */
  private prune() {
    const old = this.db
      .query(`SELECT id FROM jobs WHERE quarantined=0 AND state IN ('succeeded','failed','cancelled','interrupted','unknown')
        AND id NOT IN (SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?)`)
      .all(KEEP_JOBS) as { id: string }[];
    if (!old.length) return;
    this.db.transaction(() => {
      for (const { id } of old) for (const t of ["steps", "receipts", "children", "jobs"]) this.db.query(`DELETE FROM ${t} WHERE ${t === "jobs" ? "id" : "job_id"}=?`).run(id);
    })();
  }

  get(id: string): Job | null {
    const r = this.jobRow(id);
    if (!r) return null;
    const steps = (this.db.query("SELECT data FROM steps WHERE job_id=? ORDER BY seq").all(id) as StepRow[]).map((s) => JSON.parse(s.data) as Step);
    const receipts = (this.db.query("SELECT data FROM receipts WHERE job_id=? ORDER BY id").all(id) as ReceiptRow[]).map((x) => JSON.parse(x.data) as Receipt);
    const { steps: _s, receipts: _r, stepCount: _c, lastStep: _l, ...rest } = { ...summary(r, steps.length, steps.at(-1) ?? null), steps, receipts };
    return { ...rest, steps, receipts };
  }

  list(filter: { kind?: JobKind; state?: JobState; personId?: string; limit?: number } = {}): JobSummary[] {
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 200);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.kind) (where.push("kind=?"), params.push(filter.kind));
    if (filter.state) (where.push("state=?"), params.push(filter.state));
    if (filter.personId) (where.push("json_extract(principal,'$.personId')=?"), params.push(filter.personId));
    const rows = this.db.query(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params, limit) as JobRow[];
    return rows.map((r) => {
      const { count, last } = this.lastStep(r.id);
      return summary(r, count, last);
    });
  }

  /** Events after `after` (the UI resumes from its last seq). */
  events(after = 0, limit = 200): { events: JobEvent[]; last: number } {
    const rows = this.db.query("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(Math.max(0, Math.floor(after)), Math.min(Math.max(1, limit), 500)) as {
      seq: number; job_id: string; at: number; type: JobEvent["type"]; data: string;
    }[];
    const events = rows.map((r) => {
      const data = JSON.parse(r.data);
      // A job snapshot written before AUDIT-A1-1 may hold the server-only session key.
      if (r.type === "job" && data && typeof data === "object") data.principal = publicPrincipal(data.principal);
      return { seq: r.seq, at: r.at, type: r.type, jobId: r.job_id, ...(r.type === "job" ? { job: data } : r.type === "step" ? { step: data } : { receipt: data }) } as JobEvent;
    });
    // A client ahead of the store (reset or pruned) is brought back to the real head.
    return { events, last: events.at(-1)?.seq ?? Math.min(Math.max(0, Math.floor(after)), this.head()) };
  }
  /** The newest event seq (a client starts following from here). */
  head(): number {
    return (this.db.query("SELECT MAX(seq) AS m FROM events").get() as { m: number | null }).m ?? 0;
  }

  /**
   * Work executed outside `run` (a mirrored screen run, an adapter around an existing gate): queued →
   * running once. Like `run`, only a queued job can begin, so nothing is ever replayed.
   */
  begin(jobId: string): boolean {
    this.writable();
    return this.setState(jobId, "running", ["queued"]);
  }
  /** Settle externally executed work. A quarantined (`unknown`) or finished job is never overwritten. */
  finish(jobId: string, to: "succeeded" | "failed" | "cancelled" | "awaiting-approval" | "interrupted" | "unknown", note?: string): boolean {
    this.writable();
    if (to === "awaiting-approval") return this.setState(jobId, to, ["running"], note);
    return this.setState(jobId, to, ["running", "awaiting-approval"], note);
  }

  step(jobId: string, input: Omit<Step, "seq" | "at">): Step | null {
    this.writable();
    const r = this.jobRow(jobId);
    if (!r) return null;
    const { count, last } = this.lastStep(jobId);
    if (count >= MAX_STEPS_PER_JOB) return null;
    const step = maskStep(input, (last?.seq ?? 0) + 1, this.now());
    this.db.query("INSERT INTO steps VALUES (?, ?, ?)").run(jobId, step.seq, JSON.stringify(step));
    this.db.query("UPDATE jobs SET updated_at=? WHERE id=?").run(step.at, jobId);
    this.event(jobId, "step", step);
    return step;
  }

  receipt(jobId: string, receipt: Receipt): Receipt | null {
    this.writable();
    if (!this.jobRow(jobId)) return null;
    const clean = cleanReceipt(receipt);
    this.db.query("INSERT INTO receipts (job_id, data) VALUES (?, ?)").run(jobId, JSON.stringify(clean));
    this.event(jobId, "receipt", clean);
    return clean;
  }

  /**
   * Replace a job's note after the fact, with what actually happened later (a step that finished after the
   * stop). Never changes the state; any job, finished or not. Masked like every note.
   */
  amendNote(jobId: string, note: string): boolean {
    this.writable();
    const changed = this.db.query("UPDATE jobs SET note=?, updated_at=? WHERE id=?").run(maskJobText(note, 200), this.now(), jobId).changes === 1;
    if (changed) this.jobChanged(jobId);
    return changed;
  }

  awaitingApproval(jobId: string, approvalId: string): boolean {
    this.writable();
    if (!UUID.test(approvalId)) return false;
    this.db.query("UPDATE jobs SET approval_id=? WHERE id=? AND state='running'").run(approvalId, jobId);
    return this.setState(jobId, "awaiting-approval", ["running"]);
  }
  resumed(jobId: string): boolean {
    this.writable();
    return this.setState(jobId, "running", ["awaiting-approval"]);
  }

  /** Jobs held because a stop was never acknowledged (or was ignored). */
  quarantined(kind?: JobKind): JobSummary[] {
    const rows = (kind
      ? this.db.query("SELECT * FROM jobs WHERE quarantined=1 AND kind=?").all(kind)
      : this.db.query("SELECT * FROM jobs WHERE quarantined=1").all()) as JobRow[];
    return rows.map((r) => {
      const { count, last } = this.lastStep(r.id);
      return summary(r, count, last);
    });
  }
  private quarantine(jobId: string, reason: QuarantineReason, members: TreeMember[]) {
    const now = this.now();
    this.db.transaction(() => {
      this.db.query("UPDATE jobs SET quarantined=1, quarantine_reason=COALESCE(quarantine_reason, ?), updated_at=? WHERE id=?").run(reason, now, jobId);
      const old = this.db.query("SELECT members FROM quarantine_trees WHERE job_id=?").get(jobId) as { members: string } | null;
      const all = [...(old ? (JSON.parse(old.members) as TreeMember[]) : []), ...members];
      this.db.query("INSERT OR REPLACE INTO quarantine_trees (job_id, since, members) VALUES (?, COALESCE((SELECT since FROM quarantine_trees WHERE job_id=?), ?), ?)")
        .run(jobId, jobId, now, JSON.stringify(all));
    })();
    this.jobChanged(jobId);
  }
  /**
   * Is every process of a quarantined job's stopped tree gone? Read from the OS process table against the
   * persisted members (PID + creation time), so it works after a restart. An unreadable table is "present".
   */
  async quarantineTreeGone(jobId: string): Promise<boolean> {
    const q = this.db.query("SELECT since, members FROM quarantine_trees WHERE job_id=?").get(jobId) as { since: number; members: string } | null;
    const members = q ? (JSON.parse(q.members) as TreeMember[]) : [];
    if (!members.length) return true;
    try {
      return !treeStillPresent(await this.accounting(), members, q!.since);
    } catch {
      return false;
    }
  }
  /**
   * Explicit release, owner-visible and consequential: the stopped tree must be gone (independent
   * process accounting), then `consumeApproval` must consume a durable approval for exactly this release
   * (action `jobs.release-quarantine`, asked once). Nothing re-runs: the job keeps its recorded outcome.
   */
  async releaseQuarantine(jobId: string, consumeApproval: () => boolean): Promise<{ ok: boolean; reason?: "not-quarantined" | "tree-present" | "not-approved" }> {
    this.writable();
    const r = this.jobRow(jobId);
    if (!r || r.quarantined !== 1) return { ok: false, reason: "not-quarantined" };
    if (!(await this.quarantineTreeGone(jobId))) return { ok: false, reason: "tree-present" };
    if (!consumeApproval()) return { ok: false, reason: "not-approved" };
    this.db.transaction(() => {
      this.db.query("UPDATE jobs SET quarantined=0, quarantine_reason=NULL, updated_at=? WHERE id=?").run(this.now(), jobId);
      this.db.query("DELETE FROM quarantine_trees WHERE job_id=?").run(jobId);
    })();
    this.jobChanged(jobId);
    return { ok: true };
  }

  /**
   * Run a queued job. Admission is one atomic transition from `queued`; a job in any other state (or
   * one whose kind is quarantined) is never run, so an interrupted, unknown or finished job is never replayed.
   */
  async run(jobId: string, execute: (ctx: ExecutorContext) => Promise<Execution>): Promise<{ admitted: boolean; job: Job | null; reason?: "not-queued" | "quarantined" }> {
    this.writable();
    const r = this.jobRow(jobId);
    if (!r) return { admitted: false, job: null, reason: "not-queued" };
    if (this.quarantined(r.kind).length) return { admitted: false, job: this.get(jobId), reason: "quarantined" };
    const admitted = this.db.query("UPDATE jobs SET state='running', updated_at=? WHERE id=? AND state='queued' AND cancel_requested=0").run(this.now(), jobId).changes === 1;
    if (!admitted) return { admitted: false, job: this.get(jobId), reason: "not-queued" };
    this.jobChanged(jobId);
    let settle!: () => void, finish!: () => void;
    const entry: ActiveRun = {
      controller: new AbortController(),
      children: new Map(),
      captures: [],
      stopping: null,
      settled: new Promise<void>((resolve) => (settle = resolve)),
      finished: new Promise<void>((resolve) => (finish = resolve)),
    };
    this.active.set(jobId, entry);
    const ctx: ExecutorContext = {
      jobId,
      signal: entry.controller.signal,
      step: (s) => this.step(jobId, s),
      registerChild: (pid, created) => this.registerChild(jobId, entry, pid, created),
      childExited: (pid) => {
        entry.children.delete(pid);
        // Kept (marked exited) so its descendants are still found; identity decides any kill.
        this.db.query("UPDATE children SET exited=1 WHERE job_id=? AND pid=?").run(jobId, pid);
      },
      cancelRequested: () => (this.jobRow(jobId)?.cancel_requested ?? 1) === 1,
      awaitingApproval: (id) => void this.awaitingApproval(jobId, id),
      resumed: () => void this.resumed(jobId),
      receipt: (x) => void this.receipt(jobId, x),
    };
    let to: JobState = "failed", note: string | undefined, stopIgnored = false;
    try {
      const result = await execute(ctx);
      const stopAsked = entry.controller.signal.aborted || ctx.cancelRequested();
      if (stopAsked && result.ok && result.completedBeforeStop)
        (to = "succeeded"), (note = result.note ?? "Completed and checked just before the stop arrived.");
      else if (stopAsked && result.ok) {
        // The history of record says what happened: it completed. The ignored stop quarantines the kind.
        (to = "succeeded"), (note = "Completed after a stop was requested: the stop wasn't honoured."), (stopIgnored = true);
      } else if (stopAsked)
        // An executor that stopped but knows a step it had started may still finish says so in its note.
        (to = "cancelled"), (note = entry.settledLate ? "Stopped late: it didn't settle within the grace period after the stop." : (result.stopNote ?? "Stopped on request."));
      else if (result.settle === "awaiting-approval") (to = "awaiting-approval"), (note = result.note);
      else if (result.settle === "handed-off") (to = "succeeded"), (note = result.note ?? "Handed off to another tool; nothing ran here.");
      else (to = result.ok ? "succeeded" : "failed"), (note = result.note);
    } catch (error) {
      if ((error as Error)?.name === "ChildTerminationUnverified" || (error as Error)?.message === "Child termination not verified")
        (to = "unknown"), (note = "The stop wasn't confirmed; the outcome is unknown.");
      else if (entry.controller.signal.aborted)
        (to = "cancelled"), (note = entry.settledLate ? "Stopped late: it didn't settle within the grace period after the stop." : "Stopped on request.");
      else (to = "failed"), (note = "The executor failed.");
    } finally {
      if (entry.snapshotTimer) clearInterval(entry.snapshotTimer);
      settle();
      // A stop in progress decides first (identity checks, tree-kill, the settle deadline).
      if (entry.stopping) await entry.stopping;
      if (this.active.get(jobId) === entry) this.active.delete(jobId);
    }
    // One terminal write with the ACTUAL outcome. A stop that timed out already set `unknown`; the real
    // outcome, once it arrives, replaces that (the quarantine stays until an approved release).
    const from: JobState[] = to === "succeeded" || !entry.treeUnverified ? ["running", "awaiting-approval", "unknown"] : ["running", "awaiting-approval"];
    this.setState(jobId, to, from, note);
    if (stopIgnored) this.quarantine(jobId, "stop_ignored", []);
    finish();
    return { admitted: true, job: this.get(jobId) };
  }

  private registerChild(jobId: string, entry: ActiveRun, pid: number, created?: number | null) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const child: TreeMember = { pid, created: typeof created === "number" && Number.isFinite(created) ? created : null };
    entry.children.set(pid, child);
    this.db.query("INSERT OR REPLACE INTO children (job_id, pid, created, exited) VALUES (?, ?, ?, 0)").run(jobId, pid, child.created);
    // No creation time from the executor: read it from the OS now, while the PID is certainly ours. The same
    // read snapshots the child's descendants, so a grandchild is known before its parent can exit.
    entry.captures.push(this.snapshot(jobId, entry));
    if (!entry.snapshotTimer && this.snapshotMs > 0) {
      entry.snapshotTimer = setInterval(() => void this.snapshot(jobId, entry), this.snapshotMs);
      (entry.snapshotTimer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Record every live descendant of this job's known processes (PID + creation time) in `children`, while
   * their parents are alive. A detached grandchild whose parent then exits is still ours: cancel finds it
   * here, or by its parent PID (Windows keeps the dead parent's PID as its ppid).
   */
  private async snapshot(jobId: string, entry: ActiveRun): Promise<void> {
    let table: ProcessRow[];
    try {
      table = await this.accounting();
    } catch {
      return; // a failed snapshot is just a missed snapshot; cancel reads the table again
    }
    if (this.active.get(jobId) !== entry) return;
    try {
      for (const child of entry.children.values()) {
        if (child.created !== null) continue;
        const row = table.find((x) => x.pid === child.pid);
        if (row?.created != null) {
          child.created = row.created;
          this.db.query("UPDATE children SET created=? WHERE job_id=? AND pid=?").run(row.created, jobId, child.pid);
        }
      }
      const known = this.knownProcesses(jobId);
      const insert = this.db.query("INSERT OR IGNORE INTO children (job_id, pid, created, exited) VALUES (?, ?, ?, 0)");
      for (const root of known) if (root.created !== null) for (const m of captureTree(table, root)) if (m.pid !== root.pid && m.created !== null) insert.run(jobId, m.pid, m.created);
    } catch {
      /* the store is closing */
    }
  }
  /** Every process this job has ever owned: registered children (exited or not) and snapshotted descendants. */
  private knownProcesses(jobId: string): TreeMember[] {
    return (this.db.query("SELECT pid, created FROM children WHERE job_id=?").all(jobId) as { pid: number; created: number | null }[]).map((r) => ({ pid: r.pid, created: r.created }));
  }

  /**
   * Cooperative flag + executor abort + tree-kill. Every process the job owns is found (registered children,
   * exited or not, their snapshotted descendants, and anything still parented by them) and each one whose
   * identity (PID + creation time) matches the OS process table is killed. A process whose PID now belongs
   * to someone else is never killed. The OS table is then read AGAIN: if any owned process survives (an
   * orphan the kill missed), the stop isn't acknowledged. Quarantine (state `unknown`, blocks the kind until
   * an approved release) when: a process survives, an identity can't be verified, the table can't be read,
   * or the executor hasn't settled within the grace period. A stop that is ignored (it completes anyway) is
   * recorded as what happened and quarantined too.
   */
  async cancel(jobId: string): Promise<CancelResult> {
    this.writable();
    const r = this.jobRow(jobId);
    if (!r) return { ok: false, state: null, aborted: false, acknowledged: null, quarantined: false };
    if (TERMINAL_STATES.includes(r.state)) return { ok: false, state: r.state, aborted: false, acknowledged: null, quarantined: r.quarantined === 1 };
    this.db.query("UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?").run(this.now(), jobId);
    if (r.state === "queued") {
      this.setState(jobId, "cancelled", ["queued"], "Cancelled before it started.");
      return { ok: true, state: "cancelled", aborted: false, acknowledged: true, quarantined: false };
    }
    const entry = this.active.get(jobId);
    this.jobChanged(jobId);
    if (!entry) {
      // Running in another worker (or before a restart): the durable flag is all this process can set.
      return { ok: true, state: this.jobRow(jobId)!.state, aborted: false, acknowledged: null, quarantined: false };
    }
    if (!entry.stopping) entry.stopping = this.stop(jobId, entry);
    const ok = await entry.stopping;
    // Settled in time: wait for the terminal write so the reply states the recorded outcome.
    if (ok) await entry.finished;
    const after = this.jobRow(jobId)!;
    return { ok: true, state: after.state, aborted: true, acknowledged: ok && after.quarantined === 0, quarantined: after.quarantined === 1 };
  }

  private withGrace<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([work, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), this.graceMs)))]).finally(() => clearTimeout(timer));
  }

  private async stop(jobId: string, entry: ActiveRun): Promise<boolean> {
    entry.controller.abort();
    let reason: QuarantineReason | null = null;
    const members: TreeMember[] = [];
    await Promise.all(entry.captures);
    const known = this.knownProcesses(jobId);
    if (known.length) {
      const since = this.now();
      let table: ProcessRow[] | null = null;
      try {
        table = await this.accounting();
      } catch {
        reason = "process_table_unreadable";
        members.push(...known);
      }
      if (table) {
        // Owned processes: each known one, plus anything still parented by it (even if the parent is gone).
        const owned = new Map<number, TreeMember>();
        for (const root of known) {
          if (root.created === null) {
            // A PID whose creation time was never read: if it's alive we can't prove it's ours. Never kill it.
            if (table.some((x) => x.pid === root.pid)) {
              reason ??= "identity_unverified";
              members.push(root);
            }
            continue;
          }
          for (const m of captureTree(table, root)) if (!owned.has(m.pid)) owned.set(m.pid, m);
        }
        const verified: TreeMember[] = [];
        for (const m of owned.values()) {
          const row = table.find((x) => x.pid === m.pid);
          if (!row) continue; // already exited
          if (m.created === null || row.created === null) {
            reason ??= "identity_unverified";
            members.push(m);
            continue;
          }
          if (Math.abs(row.created - m.created) > IDENTITY_TOLERANCE_MS) continue; // PID now belongs to another process
          verified.push(m);
        }
        members.push(...verified);
        // Kill each verified process (its own /t tree too); a kill's exit code isn't trusted on its own.
        await this.withGrace(Promise.all(verified.map((m) => this.kill(m.pid).catch(() => false))), []);
        if (verified.length) {
          // Independent check: read the table again. Any owned process still alive (an orphan the kill
          // missed, or a kill that didn't happen) means the stop is NOT acknowledged.
          let after: ProcessRow[] | null = null;
          try {
            after = await this.accounting();
          } catch {
            reason ??= "process_table_unreadable";
          }
          if (after && treeStillPresent(after, verified, since)) reason ??= "termination_unverified";
        }
        if (reason) entry.treeUnverified = true;
      }
    }
    // The executor must settle within the grace period after the abort.
    const settledInTime = await this.withGrace(entry.settled.then(() => true), false);
    if (!settledInTime) {
      entry.settledLate = true;
      reason ??= "termination_unverified";
    }
    if (reason) {
      if (reason !== "termination_unverified" || members.length) entry.treeUnverified = true;
      this.quarantine(jobId, reason, members);
      this.setState(jobId, "unknown", ["running", "awaiting-approval"], "The stop wasn't acknowledged: quarantined, outcome unknown until it settles.");
      return false;
    }
    return true;
  }

  /** Once, by the single recovery owner at startup. Nothing is re-run. */
  recover(): { unknown: number; interrupted: number } {
    this.writable();
    if (this.active.size) throw new Error("Cannot recover while jobs are running here");
    const running = this.db.query("SELECT id FROM jobs WHERE state='running'").all() as { id: string }[];
    const waiting = this.db.query("SELECT id FROM jobs WHERE state IN ('queued','awaiting-approval')").all() as { id: string }[];
    for (const { id } of running) this.setState(id, "unknown", ["running"], "Interrupted by a restart: the outcome is unknown and it was not re-run.");
    for (const { id } of waiting) this.setState(id, "interrupted", ["queued", "awaiting-approval"], "Interrupted by a restart before it ran: not re-run.");
    return { unknown: running.length, interrupted: waiting.length };
  }
}
