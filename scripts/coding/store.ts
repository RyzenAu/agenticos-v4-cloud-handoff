import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartTime, processStartTimeAsync } from "../jarvis-execution/runtime";
import type {
  AgentBinding,
  AgentRun,
  AgentRunReason,
  AgentRunState,
  AgentRunTransitions,
  ApplyStep,
  ArtefactId,
  CodingEvent,
  CodingEventType,
  CodingJob,
  GitSha,
  IsoTime,
  JobState,
  JobTransitions,
  RoleId,
  Uuid,
} from "./contracts";
import { redactDeep, redactText } from "./redact";

/**
 * The coding job store (CODING-HARNESS §3.6, §3.10): `.operator-data/coding/coding.sqlite`.
 *  - WAL, one writer. The writer holds a lease (PID + process start time, the jarvis-execution A-L5
 *    pattern); a second server opens read-only and never recovers or writes.
 *  - Append-only events with a per-job `seq` (1, 2, 3 …) assigned in the same transaction as the
 *    change they describe; payloads are redacted before insert.
 *  - State changes only along the contract transition tables.
 *  - Recovery on writer start: active runs and jobs become `interrupted`, running apply steps become
 *    `outcome_unknown`, and NOTHING is replayed: the store has no launcher, and leaving `interrupted`
 *    needs an explicit owner resume.
 */

type Table<S extends string, T extends { [K in S]: string }> = { readonly [K in S]: readonly T[K][] };

export const JOB_TRANSITIONS: Table<JobState, JobTransitions> = {
  draft: ["awaiting_confirmation", "cancelled"],
  awaiting_confirmation: ["draft", "preparing", "cancelled"],
  preparing: ["building", "reviewing", "failed", "cancelled", "interrupted"],
  building: ["integrating", "needs_owner", "blocked_allowance", "failed", "cancelled", "interrupted"],
  integrating: ["testing", "needs_owner", "failed", "cancelled", "interrupted"],
  testing: ["reviewing", "building", "needs_owner", "failed", "cancelled", "interrupted"],
  reviewing: ["gating", "building", "needs_owner", "blocked_allowance", "failed", "cancelled", "interrupted"],
  gating: ["completed", "needs_owner", "failed", "interrupted"],
  completed: ["awaiting_approval"],
  awaiting_approval: ["applying", "completed", "cancelled"],
  applying: ["completed", "needs_owner", "interrupted"],
  needs_owner: ["building", "testing", "reviewing", "gating", "cancelled", "failed"],
  blocked_allowance: ["building", "reviewing", "cancelled"],
  interrupted: ["building", "testing", "reviewing", "gating", "applying", "cancelled", "failed"],
  failed: [],
  cancelled: [],
};

export const RUN_TRANSITIONS: Table<AgentRunState, AgentRunTransitions> = {
  queued: ["starting", "cancelled", "blocked_allowance", "interrupted"],
  starting: ["running", "failed", "cancelled", "interrupted", "termination_unverified"],
  running: ["needs_input", "succeeded", "failed", "cancelled", "interrupted", "termination_unverified", "blocked_allowance"],
  needs_input: ["running", "failed", "cancelled", "interrupted", "termination_unverified"],
  interrupted: ["starting", "cancelled"],
  blocked_allowance: ["starting", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  termination_unverified: [],
};

/** Job states a restart interrupts. `awaiting_approval` is not one: Stage B approvals survive restarts. */
export const ACTIVE_JOB_STATES: readonly JobState[] = ["preparing", "building", "integrating", "testing", "reviewing", "gating", "applying"];
/** Run states a restart interrupts (§3.10). A queued run of an interrupted job simply stays queued. */
export const ACTIVE_RUN_STATES: readonly AgentRunState[] = ["starting", "running", "needs_input"];

export class CodingStoreError extends Error {}
export class LeaseHeld extends CodingStoreError {}

export type RecoveryReport = { jobs: Uuid[]; runs: Uuid[]; applies: Uuid[] };
export type WorktreeSnapshot = { roleId: RoleId; head: GitSha; dirtyFiles: number };

export type CodingStoreOptions = {
  /** A quiet second server: read the store, never recover, never write, never take the lease. */
  readOnly?: boolean;
  now?: () => Date;
  /** Evidence for the recovery event (C4 passes git status per role worktree). Never commits anything. */
  snapshot?: (job: CodingJob) => WorktreeSnapshot[];
  /** Injected for tests; defaults ask the OS. */
  pidAlive?: (pid: number) => boolean;
  pidStartTime?: (pid: number) => number | null;
};

/**
 * CodingStore.openAsync's options (M1, review T8b): the two slow parts of opening, the lease holder's
 * OS start time and the recovery snapshot (git per role worktree), may be async so the server's event
 * loop keeps running while they do.
 */
export type CodingStoreAsyncOptions = Omit<CodingStoreOptions, "snapshot" | "pidStartTime"> & {
  snapshot?: (job: CodingJob) => Promise<WorktreeSnapshot[]> | WorktreeSnapshot[];
  pidStartTime?: (pid: number) => Promise<number | null> | number | null;
};

/** The lease row changed between reading its holder's start time and taking the lease: read again. */
class LeaseMoved extends CodingStoreError {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTEFACT = /^a-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWN_START = Math.round(Date.now() - process.uptime() * 1000);
const START_TOLERANCE_MS = 2000;
const MAX_ARTEFACT = 512 * 1024;

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function assertUuid(value: string, what: string) {
  if (!UUID.test(value)) throw new CodingStoreError(`${what} must be a UUID.`);
}

export class CodingStore {
  private db: Database;
  private lease: string | null = null;
  private closed = false;
  readonly readOnly: boolean;
  readonly dir: string;
  private recoveredReport: RecoveryReport | null = null;
  /** What the writer's start-up recovery changed; null for a reader. */
  get recovered(): RecoveryReport | null { return this.recoveredReport; }
  private now: () => Date;

  /** `deferred`: open and create the schema only; openAsync takes the lease and recovers. */
  private constructor(dir: string, options: CodingStoreOptions, deferred = false) {
    this.dir = dir;
    this.readOnly = !!options.readOnly;
    this.now = options.now ?? (() => new Date());
    const file = join(dir, "coding.sqlite");
    if (this.readOnly) {
      if (!existsSync(file)) throw new CodingStoreError("No coding store yet.");
      this.db = new Database(file, { readonly: true });
      this.db.exec("PRAGMA busy_timeout=3000;");
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true });
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, instance TEXT NOT NULL, started INTEGER);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, repo_id TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), role_id TEXT NOT NULL,
          state TEXT NOT NULL, doc TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (job_id TEXT NOT NULL REFERENCES jobs(id), seq INTEGER NOT NULL, at TEXT NOT NULL,
          type TEXT NOT NULL, role_id TEXT, payload TEXT NOT NULL, PRIMARY KEY (job_id, seq));
        CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
        CREATE INDEX IF NOT EXISTS runs_job ON runs(job_id);`);
      if (deferred) return;
      this.takeLease(options.pidAlive ?? defaultPidAlive, options.pidStartTime ?? processStartTime);
      this.recoveredReport = this.recover(options.snapshot);
    } catch (error) {
      this.abortOpen();
      throw error;
    }
  }

  private abortOpen() {
    try { if (this.lease) this.releaseLease(); } finally { this.db.close(); }
  }

  /**
   * Open the store. The writer takes the lease and runs recovery once; readers do neither.
   * Synchronous: the lease check and the recovery snapshot may spawn (PowerShell, git) and block the
   * caller while they run. For CLIs, seeds and tests; the server uses openAsync.
   */
  static open(dir: string, options: CodingStoreOptions = {}): CodingStore {
    return new CodingStore(dir, options);
  }

  /**
   * As open(), with the same lease rule and the same recovery (M1, review T8b), but the lease holder's
   * OS start time and the recovery snapshot are awaited instead of run synchronously, so the server's
   * event loop never stalls while the store opens. The database work itself stays synchronous and in
   * the same transactions. Between taking the lease and recovering, the store isn't handed to anyone,
   * so nothing else can write in the gap.
   */
  static async openAsync(dir: string, options: CodingStoreAsyncOptions = {}): Promise<CodingStore> {
    if (options.readOnly) return new CodingStore(dir, { readOnly: true, now: options.now });
    const store = new CodingStore(dir, { now: options.now }, true);
    try {
      const alive = options.pidAlive ?? defaultPidAlive;
      const startOf = options.pidStartTime ?? processStartTimeAsync;
      for (let attempt = 1; ; attempt++) {
        // Read the holder's start time first (async), then decide in one transaction on the same row.
        const old = store.db.query("SELECT pid, started FROM lease WHERE id = 1").get() as { pid: number; started: number | null } | null;
        const known = old && old.started !== null && old.pid !== process.pid && alive(old.pid) ? { pid: old.pid, started: old.started, current: await startOf(old.pid) } : null;
        try {
          store.takeLease(alive, (pid) => (known && known.pid === pid ? known.current : null), (row) => !!known && known.pid === row.pid && known.started === row.started);
          break;
        } catch (e) {
          // A different holder appeared meanwhile; after three tries its start time counts as unknown
          // (not proof of reuse), exactly as when the OS can't answer: the lease holds.
          if (!(e instanceof LeaseMoved)) throw e;
          if (attempt >= 3) throw new LeaseHeld("Another server owns the coding store. Open it read-only.");
        }
      }
      const at = store.at();
      const evidence = new Map<string, WorktreeSnapshot[]>();
      if (options.snapshot) {
        const snapshot = options.snapshot;
        await Promise.all(store.recoveryPreview(at).map(async (job) => {
          let found: WorktreeSnapshot[] = [];
          try { found = (await snapshot(job)) ?? []; } catch { found = []; }
          evidence.set(job.id, found);
        }));
      }
      store.recoveredReport = store.recover(options.snapshot ? (job) => evidence.get(job.id) ?? [] : undefined, at);
      return store;
    } catch (error) {
      store.abortOpen();
      throw error;
    }
  }

  private at(): IsoTime { return this.now().toISOString() as IsoTime; }
  private writable() {
    if (this.closed) throw new CodingStoreError("The coding store is closed.");
    if (this.readOnly) throw new CodingStoreError("This coding store is open read-only.");
  }

  // ─────────────────────────── lease ───────────────────────────

  /** `matches`: openAsync read the holder's start time before this transaction; is it still that row? */
  private takeLease(alive: (pid: number) => boolean, startOf: (pid: number) => number | null, matches?: (row: { pid: number; started: number }) => boolean) {
    const instance = randomUUID();
    this.db.transaction(() => {
      const old = this.db.query("SELECT pid, started FROM lease WHERE id = 1").get() as { pid: number; started: number | null } | null;
      if (old && alive(old.pid)) {
        // A live PID holds the lease unless it is provably a different (reused) process.
        let reused = false;
        if (old.started !== null) {
          if (matches && old.pid !== process.pid && !matches({ pid: old.pid, started: old.started })) throw new LeaseMoved("The coding store's lease changed hands.");
          const current = old.pid === process.pid ? OWN_START : startOf(old.pid);
          reused = current !== null && Math.abs(current - old.started) > START_TOLERANCE_MS;
        }
        if (!reused) throw new LeaseHeld("Another server owns the coding store. Open it read-only.");
      }
      this.db.query("INSERT OR REPLACE INTO lease (id, pid, instance, started) VALUES (1, ?, ?, ?)").run(process.pid, instance, OWN_START);
    }).immediate();
    this.lease = instance;
  }

  private releaseLease() {
    if (!this.lease) return;
    this.db.query("DELETE FROM lease WHERE id = 1 AND instance = ?").run(this.lease);
    this.lease = null;
  }

  // ─────────────────────────── recovery ───────────────────────────

  /** Jobs recovery will touch: any with an active run, and every active job. */
  private recoveryJobIds(): Set<string> {
    const jobIds = new Set<string>();
    const runRows = this.db.query(`SELECT doc FROM runs WHERE state IN (${ACTIVE_RUN_STATES.map(() => "?").join(",")})`).all(...ACTIVE_RUN_STATES) as { doc: string }[];
    for (const row of runRows) jobIds.add((JSON.parse(row.doc) as AgentRun).jobId);
    const jobRows = this.db.query(`SELECT id FROM jobs WHERE state IN (${ACTIVE_JOB_STATES.map(() => "?").join(",")})`).all(...ACTIVE_JOB_STATES) as { id: string }[];
    for (const row of jobRows) jobIds.add(row.id);
    return jobIds;
  }

  /**
   * Each job recovery will touch, as it will look afterwards (runs interrupted, running applies
   * outcome_unknown, active job interrupted), for openAsync's snapshot. Reads only.
   */
  private recoveryPreview(at: IsoTime): CodingJob[] {
    return [...this.recoveryJobIds()].map((jobId) => {
      const job = this.readJob(jobId)!;
      return {
        ...job,
        state: ACTIVE_JOB_STATES.includes(job.state) ? "interrupted" : job.state,
        runs: job.runs.map((run) => (ACTIVE_RUN_STATES.includes(run.state)
          ? { ...run, state: "interrupted", pendingInput: null, history: [...run.history, { from: run.state, to: "interrupted", at, reason: "server_restart" } as AgentRun["history"][number]] }
          : run)),
        applies: job.applies.map((a): ApplyStep => (a.state === "running" ? { ...a, state: "outcome_unknown" } : a)),
        updatedAt: at,
      };
    });
  }

  /** Exclusive-writer start-up only. Interrupts; never replays, never consumes an approval. */
  private recover(snapshot?: CodingStoreOptions["snapshot"], at: IsoTime = this.at()): RecoveryReport {
    const report: RecoveryReport = { jobs: [], runs: [], applies: [] };
    this.db.transaction(() => {
      const jobIds = this.recoveryJobIds();
      for (const jobId of jobIds) {
        const job = this.readJob(jobId)!;
        const interruptedRuns: Uuid[] = [];
        for (const run of job.runs) {
          if (!ACTIVE_RUN_STATES.includes(run.state)) continue;
          this.writeRun({ ...run, state: "interrupted", pendingInput: null,
            history: [...run.history, { from: run.state, to: "interrupted", at, reason: "server_restart" } as AgentRun["history"][number]] });
          this.insertEvent(jobId, "state", run.roleId, { scope: "run", runId: run.id, from: run.state, to: "interrupted", reason: "server_restart" }, at);
          interruptedRuns.push(run.id);
        }
        const unknownApplies: Uuid[] = [];
        const applies = job.applies.map((a): ApplyStep => {
          if (a.state !== "running") return a;
          unknownApplies.push(a.id);
          return { ...a, state: "outcome_unknown" };
        });
        let state = job.state;
        if (ACTIVE_JOB_STATES.includes(job.state)) {
          this.insertEvent(jobId, "state", null, { scope: "job", from: job.state, to: "interrupted" }, at);
          state = "interrupted";
        }
        this.writeJob({ ...job, state, applies, updatedAt: at });
        let evidence: WorktreeSnapshot[] = [];
        try { evidence = snapshot?.(this.readJob(jobId)!) ?? []; } catch { evidence = []; }
        this.insertEvent(jobId, "recovery", null, { interruptedRuns, outcomeUnknownApplies: unknownApplies, snapshot: evidence }, at);
        report.jobs.push(jobId as Uuid);
        report.runs.push(...interruptedRuns);
        report.applies.push(...unknownApplies);
      }
    }).immediate();
    return report;
  }

  // ─────────────────────────── rows ───────────────────────────

  private readJob(id: string): CodingJob | null {
    const row = this.db.query("SELECT doc, state, last_seq, updated_at FROM jobs WHERE id = ?").get(id) as { doc: string; state: JobState; last_seq: number; updated_at: string } | null;
    if (!row) return null;
    const runs = (this.db.query("SELECT doc FROM runs WHERE job_id = ? ORDER BY rowid").all(id) as { doc: string }[]).map((r) => JSON.parse(r.doc) as AgentRun);
    const doc = JSON.parse(row.doc) as Omit<CodingJob, "runs">;
    return { ...doc, state: row.state, lastSeq: row.last_seq, updatedAt: row.updated_at as IsoTime, runs };
  }

  private writeJob(job: CodingJob) {
    const { runs: _runs, ...doc } = job;
    this.db.query("UPDATE jobs SET state = ?, updated_at = ?, doc = ? WHERE id = ?").run(job.state, job.updatedAt, JSON.stringify(doc), job.id);
  }

  private writeRun(run: AgentRun) {
    this.db.query("UPDATE runs SET state = ?, doc = ? WHERE id = ?").run(run.state, JSON.stringify(run), run.id);
  }

  /** Next seq for the job, in the caller's transaction. */
  private insertEvent(jobId: string, type: CodingEventType, roleId: RoleId | null, payload: unknown, at: IsoTime): CodingEvent {
    const row = this.db.query("UPDATE jobs SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq").get(at, jobId) as { last_seq: number } | null;
    if (!row) throw new CodingStoreError("Unknown job.");
    const clean = redactDeep(payload);
    this.db.query("INSERT INTO events (job_id, seq, at, type, role_id, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(jobId, row.last_seq, at, type, roleId, JSON.stringify(clean));
    return { jobId: jobId as Uuid, seq: row.last_seq, at, type, roleId, payload: clean } as CodingEvent;
  }

  // ─────────────────────────── jobs ───────────────────────────

  /** A new job starts as a draft or awaiting confirmation; its spec is stored as given (validated upstream). */
  createJob(job: Omit<CodingJob, "runs" | "lastSeq" | "updatedAt" | "createdAt"> & { createdAt?: IsoTime }): CodingJob {
    this.writable();
    assertUuid(job.id, "Job id");
    if (job.state !== "draft" && job.state !== "awaiting_confirmation") throw new CodingStoreError("A job starts as a draft.");
    const at = job.createdAt ?? this.at();
    const { runs: _r, ...rest } = job as CodingJob;
    const doc = { ...rest, createdAt: at, updatedAt: at, lastSeq: 0 };
    this.db.query("INSERT INTO jobs (id, state, repo_id, created_at, updated_at, last_seq, doc) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run(job.id, job.state, job.spec.repo.repoId, at, at, JSON.stringify(doc));
    return this.getJob(job.id)!;
  }

  getJob(id: string): CodingJob | null {
    if (!UUID.test(id)) return null;
    return this.readJob(id);
  }

  listJobs(filter: { state?: JobState | "needs-you"; repo?: string; limit?: number } = {}): CodingJob[] {
    const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
    const rows = this.db.query("SELECT id FROM jobs ORDER BY updated_at DESC, rowid DESC").all() as { id: string }[];
    const out: CodingJob[] = [];
    for (const { id } of rows) {
      const job = this.readJob(id)!;
      if (filter.repo && job.spec.repo.repoId !== filter.repo) continue;
      if (filter.state === "needs-you") {
        const waiting = ["needs_owner", "awaiting_approval", "interrupted", "blocked_allowance"].includes(job.state) || job.runs.some((r) => r.state === "needs_input");
        if (!waiting) continue;
      } else if (filter.state && job.state !== filter.state) continue;
      out.push(job);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Move a job along JOB_TRANSITIONS. Leaving `interrupted` for work needs `resume: true`, which only
   * an explicit owner action (button or "resume the coding job") may pass: recovery never resumes.
   */
  transitionJob(id: string, to: JobState, options: { resume?: boolean } = {}): CodingJob {
    this.writable();
    const at = this.at();
    this.db.transaction(() => {
      const job = this.readJob(id);
      if (!job) throw new CodingStoreError("Unknown job.");
      if (!(JOB_TRANSITIONS[job.state] as readonly JobState[]).includes(to))
        throw new CodingStoreError(`A job can't move from ${job.state} to ${to}.`);
      if (job.state === "interrupted" && !["cancelled", "failed"].includes(to) && !options.resume)
        throw new CodingStoreError("An interrupted job stays interrupted until the owner resumes it.");
      if (to === "completed" && job.state === "gating" && !(job.gate?.passed && job.gate.sha === job.headSha))
        throw new CodingStoreError("A job completes only with a passed gate for its head sha.");
      this.writeJob({ ...job, state: to, updatedAt: at });
      this.insertEvent(id, "state", null, { scope: "job", from: job.state, to }, at);
    }).immediate();
    return this.readJob(id)!;
  }

  /**
   * Record fields the orchestrator derives (head sha, diff, tests, review, gate, applies). Never state.
   * `spec` may change only before the job starts (a draft edit or the confirmation, C4): a confirmed
   * spec is immutable, and an edit after confirmation is refused.
   */
  updateJob(id: string, patch: Partial<Pick<CodingJob, "headSha" | "diff" | "tests" | "review" | "gate" | "applies" | "spec">>): CodingJob {
    this.writable();
    const at = this.at();
    this.db.transaction(() => {
      const job = this.readJob(id);
      if (!job) throw new CodingStoreError("Unknown job.");
      for (const key of Object.keys(patch))
        if (!["headSha", "diff", "tests", "review", "gate", "applies", "spec"].includes(key)) throw new CodingStoreError(`Can't update ${key} here.`);
      if (patch.spec) {
        if (!["draft", "awaiting_confirmation"].includes(job.state)) throw new CodingStoreError("A started job's spec never changes.");
        if (job.spec.confirmation.state === "confirmed") throw new CodingStoreError("A confirmed spec is immutable; draft a new job instead.");
        if (patch.spec.id !== job.spec.id) throw new CodingStoreError("The spec id can't change.");
      }
      this.writeJob({ ...job, ...patch, updatedAt: at });
    }).immediate();
    return this.readJob(id)!;
  }

  // ─────────────────────────── runs ───────────────────────────

  addRun(run: Omit<AgentRun, "history" | "lastSeq" | "attempt" | "startedAt" | "endedAt" | "pendingInput" | "resultSha" | "error" | "state">): AgentRun {
    this.writable();
    assertUuid(run.id, "Run id");
    const full: AgentRun = { ...run, state: "queued", attempt: 1, startedAt: null, endedAt: null, lastSeq: 0, pendingInput: null, resultSha: null, history: [], error: null };
    this.db.transaction(() => {
      if (!this.readJob(run.jobId)) throw new CodingStoreError("Unknown job.");
      this.db.query("INSERT INTO runs (id, job_id, role_id, state, doc) VALUES (?, ?, ?, ?, ?)").run(run.id, run.jobId, run.roleId, "queued", JSON.stringify(full));
    }).immediate();
    return full;
  }

  getRun(id: string): AgentRun | null {
    const row = this.db.query("SELECT doc FROM runs WHERE id = ?").get(id) as { doc: string } | null;
    return row ? (JSON.parse(row.doc) as AgentRun) : null;
  }

  /**
   * Move a run along RUN_TRANSITIONS. Out of `interrupted`/`blocked_allowance` only by `owner_resume`.
   * The binding (account + model) is fixed for the run: it changes only on that explicit resume with
   * `reassignTo`, which is recorded (owner decision 1: no silent move to another account).
   */
  transitionRun(id: string, to: AgentRunState, reason: AgentRunReason, options: { reassignTo?: AgentBinding; error?: AgentRun["error"]; resultSha?: GitSha; pendingInput?: AgentRun["pendingInput"]; nativeSessionId?: string } = {}): AgentRun {
    this.writable();
    const at = this.at();
    this.db.transaction(() => {
      const run = this.getRun(id);
      if (!run) throw new CodingStoreError("Unknown run.");
      if (!(RUN_TRANSITIONS[run.state] as readonly AgentRunState[]).includes(to))
        throw new CodingStoreError(`A run can't move from ${run.state} to ${to}.`);
      const resuming = (run.state === "interrupted" || run.state === "blocked_allowance") && to === "starting";
      if (resuming && reason !== "owner_resume") throw new CodingStoreError("Only an explicit owner resume restarts an interrupted run.");
      if (to === "interrupted" && !["server_restart", "owner_interrupt"].includes(reason)) throw new CodingStoreError("Interrupted means a restart or an owner pause.");
      if (options.reassignTo && !resuming) throw new CodingStoreError("A run's account and model change only on an explicit resume.");
      const next: AgentRun = {
        ...run,
        state: to,
        binding: options.reassignTo ?? run.binding,
        attempt: resuming ? run.attempt + 1 : run.attempt,
        startedAt: to === "starting" && !run.startedAt ? at : run.startedAt,
        endedAt: ["succeeded", "failed", "cancelled", "termination_unverified"].includes(to) ? at : run.endedAt,
        pendingInput: to === "needs_input" ? options.pendingInput ?? run.pendingInput : null,
        resultSha: options.resultSha ?? run.resultSha,
        nativeSessionId: options.nativeSessionId ?? run.nativeSessionId,
        error: options.error ?? (to === "running" || to === "starting" ? null : run.error),
        history: [...run.history, { from: run.state, to, at, reason } as AgentRun["history"][number]],
      };
      const event = this.insertEvent(run.jobId, "state", run.roleId, { scope: "run", runId: run.id, from: run.state, to, reason }, at);
      if (options.reassignTo) this.insertEvent(run.jobId, "step", run.roleId, { label: "Owner reassigned this role", detail: `${run.binding.accountSlot} ${run.binding.model} → ${options.reassignTo.accountSlot} ${options.reassignTo.model}` }, at);
      this.writeRun({ ...next, lastSeq: event.seq });
    }).immediate();
    return this.getRun(id)!;
  }

  // ─────────────────────────── events ───────────────────────────

  appendEvent<T extends CodingEventType>(jobId: string, type: T, roleId: RoleId | null, payload: Extract<CodingEvent, { type: T }>["payload"]): CodingEvent {
    this.writable();
    if (type === "state" || type === "recovery") throw new CodingStoreError("State and recovery events are written by transitions only.");
    const at = this.at();
    let event!: CodingEvent;
    this.db.transaction(() => { event = this.insertEvent(jobId, type, roleId, payload, at); }).immediate();
    return event;
  }

  /** Events after `after` (exclusive), in seq order: the SSE resume point. */
  events(jobId: string, after = 0, limit = 500): CodingEvent[] {
    const rows = this.db.query("SELECT job_id, seq, at, type, role_id, payload FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(jobId, Math.max(0, Math.floor(after)), Math.max(1, Math.min(5000, limit))) as { job_id: string; seq: number; at: string; type: string; role_id: string | null; payload: string }[];
    return rows.map((r) => ({ jobId: r.job_id, seq: r.seq, at: r.at, type: r.type, roleId: r.role_id, payload: JSON.parse(r.payload) }) as CodingEvent);
  }

  // ─────────────────────────── artefacts ───────────────────────────

  /** Store a redacted, capped text artefact under `<dir>/<jobId>/`. Events carry its id, never a path. */
  putArtefact(jobId: string, text: string): ArtefactId {
    this.writable();
    assertUuid(jobId, "Job id");
    if (!this.readJob(jobId)) throw new CodingStoreError("Unknown job.");
    const id = `a-${randomUUID()}` as ArtefactId;
    const folder = join(this.dir, jobId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const clean = redactText(text, Number.MAX_SAFE_INTEGER);
    const body = clean.length > MAX_ARTEFACT ? `[earlier output trimmed]\n${clean.slice(-MAX_ARTEFACT)}` : clean;
    const file = join(folder, `${id}.txt`);
    writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return id;
  }

  readArtefact(jobId: string, id: string): string {
    assertUuid(jobId, "Job id");
    if (!ARTEFACT.test(id)) throw new CodingStoreError("Unknown artefact.");
    const file = join(this.dir, jobId, `${id}.txt`);
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw new CodingStoreError("Unknown artefact.");
    return readFileSync(file, "utf8");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.readOnly) this.releaseLease();
    this.db.close();
  }
}
