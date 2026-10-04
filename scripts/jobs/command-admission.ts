/**
 * Durable, at-most-once command admission in the jobs database. This is a ledger, not a queue:
 * an accepted event is never automatically retried, including after a throw or a restart before
 * a job id is known. Only never-admitted Stop tombstones expire (the existing 30-minute window).
 * Keep only identifiers, a caller-computed binding digest and bounded verdicts. No request bodies,
 * prompts, outputs, session keys, model credentials or execution plans belong in this table.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const PERSON_ID = /^[\w.-]{1,80}$/;
const EVENT_ID = /^[\w:.-]{6,80}$/;
const BINDING = /^[a-f0-9]{64}$/;
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const COMMAND_STOP_WINDOW_MS = 30 * 60_000;
export type CommandOutcome = "completed" | "stopped" | "unknown" | "no-work";
export type CommandAdmissionKey = { personId: string; eventId: string; binding: string };
export type CommandTask = { taskId: string; taskKind: "job" | "coding" };
export type CommandSettlement = {
  jobId?: string; jobKind?: "job" | "coding";
  /** Effective delegated task, independent of the command's own wrapper/history job. */
  taskId?: string; taskKind?: "job" | "coding";
  outcome: CommandOutcome;
};
export type CommandAdmission = {
  personId: string;
  eventId: string;
  binding: string | null;
  admittedAt: number | null;
  stoppedAt: number | null;
  stopUntil: number | null;
  outcome: CommandOutcome | null;
  jobId: string | null;
  jobKind: "job" | "coding" | null;
  taskId: string | null;
  taskKind: "job" | "coding" | null;
  createdAt: number;
  updatedAt: number;
};
export type CommandClaim = { status: "claimed" | "existing" | "conflict"; record: CommandAdmission };
export type CommandStop = { outcome: "prevented" | "unconfirmed"; record: CommandAdmission };

type Row = {
  person_id: string; event_id: string; binding: string | null; admitted_at: number | null;
  stopped_at: number | null; stop_until: number | null; outcome: CommandOutcome | null;
  job_id: string | null; job_kind: "job" | "coding" | null;
  task_id: string | null; task_kind: "job" | "coding" | null;
  created_at: number; updated_at: number;
};
const recordOf = (r: Row): CommandAdmission => ({
  personId: r.person_id, eventId: r.event_id, binding: r.binding, admittedAt: r.admitted_at,
  stoppedAt: r.stopped_at, stopUntil: r.stop_until, outcome: r.outcome,
  jobId: r.job_id, jobKind: r.job_kind, taskId: r.task_id ?? null, taskKind: r.task_kind ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
function identity(personId: string, eventId: string) {
  if (typeof personId !== "string" || !PERSON_ID.test(personId)) throw new Error("Invalid command person id");
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) throw new Error("Invalid command event id");
}
function bindingKey(key: CommandAdmissionKey) {
  identity(key.personId, key.eventId);
  if (typeof key.binding !== "string" || !BINDING.test(key.binding)) throw new Error("A command binding digest is required");
}

/** Full event identity; preserve old keys where they fit, never truncate long ids to collide. */
export function commandRequestId(personId: string, eventId: string): string {
  identity(personId, eventId);
  const old = `cmd:${personId}:${eventId}`;
  return old.length <= 80 ? old : `cmd-hash:${createHash("sha256").update(JSON.stringify([personId, eventId])).digest("hex")}`;
}

/** Internal store used by JobService, sharing its connection and atomic job-creation transaction. */
export class CommandAdmissionStore {
  constructor(private db: Database, private now: () => number, private readOnly = false) {
    if (readOnly) return;
    db.exec(`CREATE TABLE IF NOT EXISTS command_admissions (
      person_id TEXT NOT NULL, event_id TEXT NOT NULL, binding TEXT,
      admitted_at INTEGER, stopped_at INTEGER, stop_until INTEGER,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','stopped','unknown','no-work')),
      job_id TEXT, job_kind TEXT CHECK (job_kind IS NULL OR job_kind IN ('job','coding')),
      task_id TEXT, task_kind TEXT CHECK (task_kind IS NULL OR task_kind IN ('job','coding')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (person_id, event_id),
      CHECK ((admitted_at IS NULL AND binding IS NULL AND stopped_at IS NOT NULL AND stop_until IS NOT NULL)
        OR (admitted_at IS NOT NULL AND binding IS NOT NULL AND stop_until IS NULL)),
      CHECK ((job_id IS NULL AND job_kind IS NULL) OR (job_id IS NOT NULL AND job_kind IS NOT NULL)),
      CHECK ((task_id IS NULL AND task_kind IS NULL) OR (task_id IS NOT NULL AND task_kind IS NOT NULL))
    );`);
    // The command's wrapper can end while its delegated coding/computer task continues. Keep both
    // immutable identities. Serialize the additive migration so concurrent openers cannot race ALTER.
    db.transaction(() => {
      const columns = new Set((db.query("PRAGMA table_info(command_admissions)").all() as { name: string }[]).map((c) => c.name));
      if (!columns.has("task_id")) db.exec("ALTER TABLE command_admissions ADD COLUMN task_id TEXT");
      if (!columns.has("task_kind")) db.exec(`ALTER TABLE command_admissions ADD COLUMN task_kind TEXT CHECK (
        (task_id IS NULL AND task_kind IS NULL) OR (task_id IS NOT NULL AND task_kind IS NOT NULL AND task_kind IN ('job','coding'))
      )`);
    }).immediate();
  }

  private writable() {
    if (this.readOnly) throw new Error("The job store is open read-only here");
  }
  private row(personId: string, eventId: string): Row | null {
    return this.db.query("SELECT * FROM command_admissions WHERE person_id=? AND event_id=?").get(personId, eventId) as Row | null;
  }
  get(personId: string, eventId: string): CommandAdmission | null {
    identity(personId, eventId);
    const row = this.row(personId, eventId);
    if (!row || (row.admitted_at === null && row.stop_until !== null && row.stop_until < this.now())) return null;
    return recordOf(row);
  }

  claim(key: CommandAdmissionKey): CommandClaim {
    this.writable();
    bindingKey(key);
    return this.db.transaction((): CommandClaim => {
      const now = this.now();
      // This deletes only never-admitted, expired stops. An uncertain admission is never a lease.
      this.db.query("DELETE FROM command_admissions WHERE person_id=? AND event_id=? AND admitted_at IS NULL AND stop_until < ?")
        .run(key.personId, key.eventId, now);
      const inserted = this.db.query(`INSERT INTO command_admissions
        (person_id,event_id,binding,admitted_at,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(person_id,event_id) DO NOTHING`).run(key.personId, key.eventId, key.binding, now, now, now).changes === 1;
      const record = recordOf(this.row(key.personId, key.eventId)!);
      return { status: inserted ? "claimed" : record.binding !== null && record.binding !== key.binding ? "conflict" : "existing", record };
    }).immediate();
  }

  stop(personId: string, eventId: string): CommandStop {
    this.writable();
    identity(personId, eventId);
    return this.db.transaction((): CommandStop => {
      const now = this.now();
      this.db.query(`INSERT INTO command_admissions
        (person_id,event_id,stopped_at,stop_until,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(person_id,event_id) DO UPDATE SET
          stopped_at=COALESCE(command_admissions.stopped_at,excluded.stopped_at),
          stop_until=CASE WHEN command_admissions.admitted_at IS NULL THEN excluded.stop_until ELSE NULL END,
          updated_at=excluded.updated_at`).run(personId, eventId, now, now + COMMAND_STOP_WINDOW_MS, now, now);
      const record = recordOf(this.row(personId, eventId)!);
      // No process-local map can prove what another/restarted process dispatched before returning a job.
      return { outcome: record.admittedAt === null ? "prevented" : "unconfirmed", record };
    }).immediate();
  }

  /** An immutable link, also used inside JobService's createCommandJob transaction. */
  bindJob(key: CommandAdmissionKey, jobId: string, jobKind: "job" | "coding"): CommandAdmission | null {
    return this.update(key, { jobId, jobKind });
  }
  /** A task this command explicitly started; status/show references must never call this method. */
  bindTask(key: CommandAdmissionKey, task: CommandTask): CommandAdmission | null {
    if (!task || task.taskId === undefined || task.taskKind === undefined) throw new Error("A command task binding needs an id and kind");
    return this.update(key, { taskId: task.taskId, taskKind: task.taskKind });
  }
  settle(key: CommandAdmissionKey, settlement: CommandSettlement): CommandAdmission | null {
    if (!["completed", "stopped", "unknown", "no-work"].includes(settlement.outcome)) throw new Error("Invalid command outcome");
    return this.update(key, settlement);
  }
  private update(key: CommandAdmissionKey, patch: Partial<CommandSettlement>): CommandAdmission | null {
    this.writable();
    bindingKey(key);
    if (patch.jobId !== undefined && (typeof patch.jobId !== "string" || !JOB_ID.test(patch.jobId))) throw new Error("Invalid command job id");
    if (patch.jobKind !== undefined && patch.jobKind !== "job" && patch.jobKind !== "coding") throw new Error("Invalid command job kind");
    if (patch.jobKind !== undefined && patch.jobId === undefined) throw new Error("A command job kind needs a job id");
    if (patch.taskId !== undefined && (typeof patch.taskId !== "string" || !JOB_ID.test(patch.taskId))) throw new Error("Invalid command task id");
    if (patch.taskKind !== undefined && patch.taskKind !== "job" && patch.taskKind !== "coding") throw new Error("Invalid command task kind");
    if (patch.taskKind !== undefined && patch.taskId === undefined) throw new Error("A command task kind needs a task id");
    return this.db.transaction(() => {
      const row = this.row(key.personId, key.eventId);
      if (!row || row.admitted_at === null || row.binding !== key.binding) return null;
      const kind = patch.jobId === undefined ? row.job_kind : patch.jobKind ?? "job";
      if (patch.jobId !== undefined && row.job_id !== null && (row.job_id !== patch.jobId || row.job_kind !== kind)) return null;
      const taskKind = patch.taskId === undefined ? row.task_kind : patch.taskKind ?? "job";
      if (patch.taskId !== undefined && row.task_id !== null && (row.task_id !== patch.taskId || row.task_kind !== taskKind)) return null;
      this.db.query(`UPDATE command_admissions SET outcome=COALESCE(?,outcome),
        job_id=COALESCE(?,job_id),job_kind=COALESCE(?,job_kind),
        task_id=COALESCE(?,task_id),task_kind=COALESCE(?,task_kind),updated_at=? WHERE person_id=? AND event_id=?`)
        .run(patch.outcome ?? null, patch.jobId ?? null, kind, patch.taskId ?? null, taskKind, this.now(), key.personId, key.eventId);
      return recordOf(this.row(key.personId, key.eventId)!);
    }).immediate();
  }
}
