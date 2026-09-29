import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { classifyControlTask, type RiskTier } from "../../src/lib/control-risk";
import { ChildTerminationUnverified } from "./child";

/** Server-side integration primitive, not a route or an authority to execute anything.
 * The host must authenticate the owner, enforce its action policy, and provide an executor
 * and independent verifier. No prompts, responses, error text or audio enter this journal.
 * One worker owns recovery; other connections may atomically claim/read jobs.
 */
export type Status = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unverified";
export type Receipt = {
  id: string; owner: string; digest: string; tier: RiskTier; permitted: number;
  status: Status; evidence: string | null; usageMicrousd: number | null;
};
export type Execution = { ok: boolean; usageMicrousd?: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
export const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
function id(value: string) { if (!uuid.test(value)) throw new Error("Expected opaque UUID"); }
function taskText(text: string) {
  if (!text.trim() || text.length > 2000) throw new Error("Invalid task size");
  return text.trim();
}

export class ExecutionJournal {
  private db: Database;
  private active = new Map<string, AbortController>();
  constructor(path: string, private now: () => number = Date.now) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, digest TEXT NOT NULL, tier TEXT NOT NULL,
        permitted INTEGER NOT NULL, status TEXT NOT NULL, evidence TEXT, usageMicrousd INTEGER);
      CREATE TABLE IF NOT EXISTS approvals (
        digest TEXT PRIMARY KEY, job TEXT NOT NULL, owner TEXT NOT NULL,
        issued INTEGER NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);`);
  }
  close() {
    if (this.active.size) throw new Error("Cannot close an active journal");
    this.db.close();
  }
  /** Called only after host authorisation. `permitted` is never model/client supplied. */
  prepare(input: { id: string; owner: string; task: string; permitted: boolean }): Receipt {
    id(input.id); id(input.owner);
    const text = taskText(input.task);
    const digest = digestOf(text), tier = classifyControlTask(text).tier;
    this.db.query("INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)")
      .run(input.id, input.owner, digest, tier, Number(input.permitted));
    const job = this.read(input.id, input.owner);
    if (!job || job.digest !== digest || job.tier !== tier || job.permitted !== Number(input.permitted))
      throw new Error("Job binding conflict");
    return job;
  }
  read(jobId: string, owner: string): Receipt | null {
    id(jobId); id(owner);
    return this.db.query("SELECT * FROM jobs WHERE id=? AND owner=?").get(jobId, owner) as Receipt | null;
  }
  list(owner: string, limit = 50): Receipt[] {
    id(owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid receipt limit");
    return this.db.query("SELECT * FROM jobs WHERE owner=? ORDER BY rowid DESC LIMIT ?").all(owner, limit) as Receipt[];
  }
  /** Trusted UI approval handler only, after reviewing this exact job. Not a voice tool.
   * The opaque capability is stored hashed and consumed in the same transaction as claim.
   */
  approve(jobId: string, owner: string, ttlMs = 120_000): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 120_000) throw new Error("Invalid approval lifetime");
    const job = this.read(jobId, owner);
    if (!job || job.status !== "pending" || !job.permitted) throw new Error("Job cannot be approved");
    const token = randomUUID(), now = this.now();
    this.db.query("INSERT INTO approvals VALUES (?, ?, ?, ?, ?, 0)")
      .run(digestOf(token), jobId, owner, now, now + ttlMs);
    return token;
  }
  /** Invoke only on exclusive worker startup, never on a browser reconnect or second reader.
   * Interrupted effects are unknown; neither jobs nor approvals are automatically replayed.
   */
  recoverAfterWorkerExit() {
    if (this.active.size) throw new Error("Cannot recover while work is active");
    this.db.transaction(() => {
      this.db.query("UPDATE jobs SET status='unverified' WHERE status='running'").run();
      this.db.query("UPDATE approvals SET consumed=1").run();
    })();
  }
  /** Cancellation prevents success, but partial effects remain possible. The executor must
   * actually stop its child work. The receipt stays running until the executor settles.
   */
  cancel(jobId: string, owner: string): boolean {
    const job = this.read(jobId, owner);
    if (!job || job.status !== "running") return false;
    const controller = this.active.get(jobId);
    if (!controller) return false; // another worker: host must route cancellation to it
    controller.abort();
    return true;
  }
  async run(input: {
    id: string; owner: string; task: string; approval?: string; signal?: AbortSignal;
    execute: (signal: AbortSignal) => Promise<Execution>;
    verify?: (signal: AbortSignal) => Promise<{ passed: boolean; evidenceDigest?: string }>;
  }): Promise<{ admitted: boolean; receipt: Receipt; blocked?: boolean }> {
    const job = this.read(input.id, input.owner);
    if (!job || job.digest !== digestOf(taskText(input.task))) throw new Error("Job binding conflict");
    const controller = new AbortController();
    const relay = () => controller.abort();
    input.signal?.addEventListener("abort", relay, { once: true });
    if (input.signal?.aborted) relay();
    try {
      const admitted = this.db.transaction(() => {
        const current = this.read(input.id, input.owner)!;
        if (current.status !== "pending" || !current.permitted || controller.signal.aborted) return false;
        if (current.tier === "external-effect") {
          if (!input.approval || !uuid.test(input.approval)) return false;
          const now = this.now();
          const used = this.db.query(`UPDATE approvals SET consumed=1
            WHERE digest=? AND job=? AND owner=? AND consumed=0 AND issued<=? AND expires>?`)
            .run(digestOf(input.approval), input.id, input.owner, now, now);
          if (used.changes !== 1) return false;
        }
        this.db.query("UPDATE jobs SET status='running' WHERE id=?").run(input.id);
        return true;
      })();
      if (!admitted) {
        const receipt = this.read(input.id, input.owner)!;
        return { admitted: false, receipt, ...(receipt.status === "pending" ? { blocked: true } : {}) };
      }
      this.active.set(input.id, controller);
      let status: Status = "unverified", evidence: string | null = null, usage: number | null = null;
      try {
        const result = await input.execute(controller.signal);
        if (Number.isSafeInteger(result.usageMicrousd) && result.usageMicrousd! >= 0) usage = result.usageMicrousd!;
        if (controller.signal.aborted) status = "cancelled";
        else if (!result.ok) status = "failed";
        else if (input.verify) {
          // Verifier failures are inconclusive; never convert narration into success.
          const checked = await input.verify(controller.signal);
          if (controller.signal.aborted) status = "cancelled";
          else if (!checked.passed) status = "failed";
          else if (checked.evidenceDigest && hash.test(checked.evidenceDigest)) {
            status = "succeeded"; evidence = checked.evidenceDigest;
          }
        }
      } catch (error) {
        status = controller.signal.aborted && !(error instanceof ChildTerminationUnverified) ? "cancelled" : "unverified";
      }
      // One terminal write; duplicate connections never run an executor or settle twice.
      this.db.query("UPDATE jobs SET status=?, evidence=?, usageMicrousd=? WHERE id=? AND status='running'")
        .run(status, evidence, usage, input.id);
      return { admitted: true, receipt: this.read(input.id, input.owner)! };
    } finally {
      input.signal?.removeEventListener("abort", relay);
      // A duplicate run must not erase the original run's cancellation handle.
      if (this.active.get(input.id) === controller) this.active.delete(input.id);
    }
  }
}
