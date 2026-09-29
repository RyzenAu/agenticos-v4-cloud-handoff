import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync, type ChildProcess } from "node:child_process";
import { backgroundJobsDisabled } from "../preview-guard";
import { runCapture } from "../nonblocking-exec";
import { digestOf, ExecutionJournal, type Execution, type Receipt } from "./journal";
import { classifyControlTask } from "../../src/lib/control-risk";
import { ControlDispatchGate, controlDispatchGate } from "./server-approval";
import { ChildTerminationUnverified } from "./child";
import { captureTree, systemProcessTable, treeStillPresent, type ProcessAccounting, type TreeMember } from "./process-accounting";
import { jarvisTaskPrompt } from "../../src/lib/jarvis-control";
import { controlPolicyPermits } from "./control-policy";

// One authenticated local operator per installation. The principal is supplied by
// the host, never a request body. Remote access is refused by the registered routes.
const LOCAL_OWNER = "00000000-0000-4000-8000-000000000001";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type JobReceipt = Omit<Receipt, "owner" | "permitted" | "status"> & { status: Receipt["status"] | "blocked" | "quarantined" };
const publicReceipt = ({ owner: _owner, permitted, ...receipt }: Receipt): JobReceipt =>
  ({ ...receipt, status: permitted ? receipt.status : "blocked" });

// Code-owned allowlist + denylist (audit A-H2): scripts/jarvis-execution/control-policy.ts.
// Approval cannot authorise money movement, trading, bank/broker/exchange apps or secret reads.
export { controlPolicyPermits };
export type ExecutionTicket = {
  id: string;
  signal: AbortSignal;
  completion: Promise<JobReceipt>;
  finish(result: Execution): void;
  attach(child: Pick<ChildProcess, "once" | "pid">, stop: () => boolean | Promise<boolean>): void;
};
export type Admission = { admitted: true; ticket: ExecutionTicket }
  | { admitted: false; status: number; receipt: JobReceipt; reason?: "execution_quarantined" };

/** Why admission is closed. Reason codes only; no task, output or process detail. */
export type QuarantineReason = "child_termination_unverified" | "worker_exit_child_unaccounted" | "descendant_outlived_child";
export type RecoveryOutcome = "cleared" | "not_quarantined" | "tree_present" | "accounting_failed";
export type QuarantineState = {
  quarantined: boolean; reason: QuarantineReason | null; since: number | null; jobs: string[];
  recovering: boolean; lastRecovery: { at: number; outcome: RecoveryOutcome } | null;
};
export type RuntimeOptions = {
  accounting?: ProcessAccounting; now?: () => number;
  /** Start time (epoch ms) of a live PID, or null when unknown. Tests inject; default asks the OS. */
  pidStartTime?: (pid: number) => number | null;
  /** How long a cancelled child's tree stop (and its accounting) may take before the job is
   * quarantined as unverified. Default 5 s; tests on a loaded machine inject a longer budget. */
  stopGraceMs?: number;
};

const START_TOLERANCE_MS = 2000;
/** This process's own start time (epoch ms), recorded with its lease. */
const OWN_START = Math.round(Date.now() - process.uptime() * 1000);
/** A live PID whose start time differs from the one the lease recorded is a reused PID. Unknown
 * on either side (legacy row, unreadable OS table) is NOT proof of reuse, so the lease holds. */
function pidReused(old: { pid: number; started: number | null }, pidStartTime: (pid: number) => number | null) {
  if (old.started === null || old.started === undefined) return false;
  // Our own PID: the recorded holder is this very process only if it recorded our start time.
  if (old.pid === process.pid) return Math.abs(old.started - OWN_START) > START_TOLERANCE_MS;
  const now = pidStartTime(old.pid);
  return now !== null && Math.abs(now - old.started) > START_TOLERANCE_MS;
}
/** The OS query for one PID's start time, and how to read its answer (shared by the sync and async forms). */
function startTimeQuery(pid: number): { file: string; args: string[]; env: NodeJS.ProcessEnv; parse: (status: number | null, stdout: string) => number | null } {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || "C:\\Windows";
    return {
      file: join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`],
      env: { SystemRoot: root },
      parse: (status, stdout) => { const ms = Number(stdout.trim()); return status === 0 && Number.isFinite(ms) && ms > 0 ? ms : null; },
    };
  }
  return {
    file: "ps", args: ["-o", "etimes=", "-p", String(pid)], env: { PATH: "/usr/bin:/bin" },
    parse: (status, stdout) => { const seconds = Number(stdout.trim()); return status === 0 && Number.isFinite(seconds) ? Date.now() - seconds * 1000 : null; },
  };
}
/** OS-reported start time of one PID (no command line, owner or environment is read). */
export function processStartTime(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const q = startTimeQuery(pid);
    const r = spawnSync(q.file, q.args, { env: q.env, encoding: "utf8", timeout: 10_000, windowsHide: true });
    return q.parse(r.status, String(r.stdout ?? ""));
  } catch { return null; }
}
/**
 * processStartTime as an async child (M1, review T8b: the coding store's lease check ran the
 * PowerShell query synchronously, holding the server for up to 10 s). Same query, same answer;
 * a timeout stops the whole process tree. Never rejects.
 */
export async function processStartTimeAsync(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const q = startTimeQuery(pid);
    const r = await runCapture(q.file, q.args, { env: q.env, timeout: 10_000 });
    return r.error ? null : q.parse(r.status, r.stdout);
  } catch { return null; }
}

/** The CLI watchdog must use exactly the same acknowledged stop as owner Stop.
 * Legacy shutdown is reserved for non-control chat children. */
export function stopExecutionForWatchdog(runtime: () => ControlExecutionRuntime, ticket: ExecutionTicket | undefined, legacyStop: () => void) {
  if (ticket) runtime().cancel(ticket.id);
  else legacyStop();
}

export class ControlExecutionRuntime {
  private journal: ExecutionJournal;
  private leaseDb: Database;
  private lease: string;
  private active = new Set<Promise<JobReceipt>>();
  private accounting: ProcessAccounting;
  private now: () => number;
  private stopGraceMs: number;
  private captures = new Set<Promise<void>>();
  private recovery: Promise<RecoveryOutcome> | null = null;
  private lastRecovery: QuarantineState["lastRecovery"] = null;
  constructor(directory: string, private gate: ControlDispatchGate = controlDispatchGate, options: RuntimeOptions = {}) {
    this.accounting = options.accounting ?? systemProcessTable;
    this.now = options.now ?? Date.now;
    this.stopGraceMs = options.stopGraceMs ?? 5000;
    mkdirSync(directory, { recursive: true });
    this.lease = randomUUID();
    this.leaseDb = new Database(join(directory, "worker.sqlite"), { create: true });
    this.leaseDb.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, instance TEXT NOT NULL)");
    // Audit A-L5: the lease records its holder's process start time, so a reused Windows PID
    // (alive, but a different process) no longer blocks the runtime forever.
    const leaseColumns = this.leaseDb.query("PRAGMA table_info(lease)").all() as { name: string }[];
    if (!leaseColumns.some((c) => c.name === "started")) this.leaseDb.exec("ALTER TABLE lease ADD COLUMN started INTEGER");
    const pidStarted = options.pidStartTime ?? processStartTime;
    // SQLite serialises stale-lease replacement; no unlink/open race between workers.
    try {
      this.leaseDb.transaction(() => {
        const old = this.leaseDb.query("SELECT pid, started FROM lease WHERE id=1").get() as { pid: number; started: number | null } | null;
        if (old) {
          let alive = true;
          try { process.kill(old.pid, 0); }
          catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
          // Alive with the recorded start time (or no way to tell) = the holder is still there: fail closed.
          if (alive && !pidReused(old, pidStarted)) throw new Error("Execution worker is already active");
        }
        this.leaseDb.query("INSERT OR REPLACE INTO lease (id, pid, instance, started) VALUES (1, ?, ?, ?)").run(process.pid, this.lease, OWN_START);
        // Fail closed across restarts. `attached` holds only the child PID of a live job;
        // a row left by a dead worker means nobody acknowledged that child's termination.
        this.leaseDb.exec(`CREATE TABLE IF NOT EXISTS attached (job TEXT PRIMARY KEY, pid INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS quarantine (job TEXT PRIMARY KEY, reason TEXT NOT NULL,
            since INTEGER NOT NULL, tree TEXT NOT NULL)`);
        const orphaned = this.leaseDb.query("SELECT job, pid FROM attached").all() as { job: string; pid: number }[];
        for (const row of orphaned)
          this.leaseDb.query("INSERT OR IGNORE INTO quarantine VALUES (?, 'worker_exit_child_unaccounted', ?, ?)")
            .run(row.job, this.now(), JSON.stringify([{ pid: row.pid, created: null }]));
        this.leaseDb.query("DELETE FROM attached").run();
      }).immediate();
    } catch (error) { this.leaseDb.close(); throw error; }
    try {
      this.journal = new ExecutionJournal(join(directory, "jobs.sqlite"));
      this.journal.recoverAfterWorkerExit();
    } catch (error) { this.releaseLease(); throw error; }
  }
  private releaseLease() {
    this.leaseDb.query("DELETE FROM lease WHERE id=1 AND instance=?").run(this.lease);
    this.leaseDb.close();
  }
  /**
   * Resolves once nothing is in flight: every job settled, every quarantine tree snapshot written and
   * no recovery running (what close() requires). A job's completion can resolve while the snapshot
   * its quarantine started is still reading the process table, so a caller that awaits the
   * completion and then closes must await this in between.
   */
  async idle(): Promise<void> {
    while (this.active.size || this.captures.size || this.recovery)
      await Promise.allSettled([...this.active, ...this.captures, ...(this.recovery ? [this.recovery] : [])]);
  }
  close() {
    if (this.active.size || this.captures.size || this.recovery) throw new Error("Execution worker still active");
    this.journal.close(); this.releaseLease();
  }
  list(limit = 50) { return this.journal.list(LOCAL_OWNER, limit).map(publicReceipt); }
  useGate(gate: ControlDispatchGate) { this.gate = gate; }
  read(id: string) { const r = this.journal.read(id, LOCAL_OWNER); return r ? publicReceipt(r) : null; }
  cancel(id: string) { return { cancelRequested: this.journal.cancel(id, LOCAL_OWNER), receipt: this.read(id) }; }

  quarantineState(): QuarantineState {
    const rows = this.leaseDb.query("SELECT job, reason, since FROM quarantine ORDER BY since, rowid").all() as
      { job: string; reason: QuarantineReason; since: number }[];
    return { quarantined: rows.length > 0, reason: rows[0]?.reason ?? null, since: rows[0]?.since ?? null,
      jobs: rows.map((row) => row.job), recovering: !!this.recovery, lastRecovery: this.lastRecovery };
  }
  /** Synchronous and durable, before the job settles: no admission can slip in between an
   * unacknowledged termination and its quarantine. The tree snapshot is enrichment only. */
  private quarantine(job: string, pid: number | undefined, reason: QuarantineReason) {
    const since = this.now();
    const root: TreeMember[] = pid ? [{ pid, created: null }] : [];
    this.leaseDb.transaction(() => {
      this.leaseDb.query("INSERT OR IGNORE INTO quarantine VALUES (?, ?, ?, ?)").run(job, reason, since, JSON.stringify(root));
      this.leaseDb.query("DELETE FROM attached WHERE job=?").run(job);
    })();
    console.warn(`[jarvis-execution] admission quarantined reason=${reason}`);
    if (!pid) return;
    const capture = this.accounting().then((table) => {
      const tree = captureTree(table, { pid, created: null });
      this.leaseDb.query("UPDATE quarantine SET tree=? WHERE job=?").run(JSON.stringify(tree), job);
    }).catch(() => { /* root PID stays recorded; recovery re-reads the table anyway */ });
    this.captures.add(capture);
    void capture.finally(() => this.captures.delete(capture));
  }
  /** Explicit owner/host action, never automatic. Clears only rows whose recorded tree
   * independent OS accounting shows gone. Unreadable accounting keeps admission closed. */
  recoverQuarantine(): Promise<RecoveryOutcome> {
    if (this.recovery) return this.recovery;
    const run = (async (): Promise<RecoveryOutcome> => {
      await Promise.all([...this.captures]);
      const rows = this.leaseDb.query("SELECT job, since, tree FROM quarantine").all() as { job: string; since: number; tree: string }[];
      if (!rows.length) return "not_quarantined";
      let table;
      try { table = await this.accounting(); } catch { return "accounting_failed"; }
      if (!Array.isArray(table) || !table.length) return "accounting_failed";
      const gone = rows.filter((row) => !treeStillPresent(table, JSON.parse(row.tree) as TreeMember[], row.since));
      this.leaseDb.transaction(() => {
        for (const row of gone) this.leaseDb.query("DELETE FROM quarantine WHERE job=? AND since=?").run(row.job, row.since);
      })();
      return gone.length === rows.length && !this.quarantineState().quarantined ? "cleared" : "tree_present";
    })().then((outcome) => {
      this.lastRecovery = { at: this.now(), outcome };
      console.warn(`[jarvis-execution] quarantine recovery outcome=${outcome}`);
      return outcome;
    }).finally(() => { this.recovery = null; });
    this.recovery = run;
    return run;
  }

  /** Called by the real CLI route before spawning. No prompt/output is persisted. */
  begin(value: unknown, prompt: string): Admission {
    const b = value as { requestId?: unknown; task?: unknown; owner?: unknown; permitted?: unknown };
    if (!b || typeof b.requestId !== "string" || !uuid.test(b.requestId) || typeof b.task !== "string" ||
        b.task !== b.task.trim() || prompt !== jarvisTaskPrompt(b.task) || "owner" in b || "permitted" in b)
      throw new Error("Invalid control binding");
    if (this.quarantineState().quarantined) {
      // Nothing is persisted and no approval is consumed while admission is closed.
      const existing = this.journal.read(b.requestId, LOCAL_OWNER);
      if (existing && existing.status !== "pending") return { admitted: false, status: 409, receipt: publicReceipt(existing) };
      return { admitted: false, status: 503, reason: "execution_quarantined", receipt: {
        id: b.requestId, digest: digestOf(b.task), tier: classifyControlTask(b.task).tier,
        status: "quarantined", evidence: null, usageMicrousd: null } };
    }
    const job = this.journal.prepare({ id: b.requestId, owner: LOCAL_OWNER, task: b.task, permitted: controlPolicyPermits(b.task) });
    if (!job.permitted) return { admitted: false, status: 403, receipt: publicReceipt(job) };
    if (job.status !== "pending") return { admitted: false, status: 409, receipt: publicReceipt(job) };
    // Existing reviewed gate checks canonical prompt and consumes the server nonce.
    this.gate.consume(value, prompt);
    const approval = job.tier === "external-effect" ? this.journal.approve(job.id, LOCAL_OWNER) : undefined;
    let controllerSignal!: AbortSignal, finish!: (value: Execution) => void, fail!: (error: Error) => void;
    const completion = this.journal.run({ id: job.id, owner: LOCAL_OWNER, task: b.task, approval,
      execute: (signal) => {
        controllerSignal = signal;
        return new Promise<Execution>((resolve, reject) => { finish = resolve; fail = reject; });
      },
    }).then((r) => publicReceipt(r.receipt));
    this.active.add(completion);
    void completion.finally(() => this.active.delete(completion)).catch(() => {});
    if (!controllerSignal) throw new Error("Execution admission unavailable");
    return { admitted: true, ticket: {
      id: job.id, signal: controllerSignal, completion, finish,
      attach: (child, stop) => {
        let ended = false, outcome = false;
        let closed = false, code: number | null = null;
        let stopping: Promise<boolean> | undefined;
        let grace: ReturnType<typeof setTimeout> | undefined;
        const pid = child.pid;
        if (pid) this.leaseDb.query("INSERT OR REPLACE INTO attached VALUES (?, ?)").run(job.id, pid);
        // Audit A-M4: the child's own creation time, read while it runs, so its descendants can
        // be told apart from unrelated processes after it exits.
        const rootCreated: Promise<number | null> = pid
          ? this.accounting().then((t) => t.find((row) => row.pid === pid)?.created ?? null).catch(() => null)
          : Promise.resolve(null);
        // First outcome wins. An unacknowledged stop quarantines before the job settles;
        // a later acknowledgement does not reopen admission (explicit recovery does).
        const unverified = () => {
          if (outcome) return;
          outcome = true; clearTimeout(grace);
          this.quarantine(job.id, pid, "child_termination_unverified");
          fail(new ChildTerminationUnverified());
        };
        const verified = (value: Execution) => {
          if (outcome) return;
          outcome = true; clearTimeout(grace);
          this.leaseDb.query("DELETE FROM attached WHERE job=?").run(job.id);
          finish(value);
        };
        const settle = async () => {
          if (!closed) return;
          if (stopping && !await stopping) { unverified(); return; }
          // A normal exit is only verified when independent accounting shows nothing it spawned
          // is still running (a detached browser or script would otherwise keep acting after the
          // job settled). Survivors, or a table that cannot be read, quarantine (fail closed).
          if (pid && !await descendantsGone(pid)) { outlived(); return; }
          verified({ ok: code === 0 });
        };
        const descendantsGone = async (root: number) => {
          try {
            const created = await rootCreated;
            const table = await this.accounting();
            if (!Array.isArray(table) || !table.length) return false;
            const members = captureTree(table, { pid: root, created });
            return !treeStillPresent(table, members, this.now());
          } catch { return false; }
        };
        const outlived = () => {
          if (outcome) return;
          outcome = true; clearTimeout(grace);
          this.quarantine(job.id, pid, "descendant_outlived_child");
          fail(new ChildTerminationUnverified());
        };
        const abort = () => {
          if (ended) return;
          stopping = Promise.resolve().then(stop).catch(() => false);
          void stopping.then((ok) => { if (!ok) unverified(); else void settle(); });
          grace = setTimeout(unverified, this.stopGraceMs);
          grace.unref?.();
        };
        const cleanup = () => { ended = true; controllerSignal.removeEventListener("abort", abort); };
        child.once("error", () => { if (!child.pid) { cleanup(); verified({ ok: false }); } });
        child.once("close", (exitCode: number | null) => { closed = true; code = exitCode; cleanup(); void settle(); });
        controllerSignal.addEventListener("abort", abort, { once: true });
        if (controllerSignal.aborted) abort();
      },
    } };
  }
}

// Keep a single worker across in-process Vite config reloads. A new OS process
// must acquire the lease before converting interrupted rows to unverified.
const key = Symbol.for("mu.jarvis.control-execution.v1");
const registry = globalThis as typeof globalThis & { [key: symbol]: Map<string, ControlExecutionRuntime> | undefined };
export function controlExecution(root: string): ControlExecutionRuntime {
  // Audit A-L5: a quiet copy (AGENTIC_OS_NO_BACKGROUND=1) never constructs the runtime, so it
  // cannot take the execution lease from the live server. Callers already map a throw to
  // "worker unavailable" (403/400), which is the correct fail-closed answer here.
  if (backgroundJobsDisabled()) throw new Error("Execution worker disabled in a quiet copy");
  const directory = resolve(root, ".operator-data", "control-execution");
  const runtimes = registry[key] ?? (registry[key] = new Map());
  let runtime = runtimes.get(directory);
  if (!runtime) { runtime = new ControlExecutionRuntime(directory); runtimes.set(directory, runtime); }
  runtime.useGate(controlDispatchGate);
  return runtime;
}
