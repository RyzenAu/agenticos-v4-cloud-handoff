// Durable trigger state: triggers.sqlite (WAL) beside jobs.sqlite. Jobs themselves live in the job store;
// this file only holds the trigger definitions, the event -> job relationship (deliveries), the ledger of
// what our own agents produced (feedback-loop prevention) and each routine's last-run record.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { maskJobText } from "../jobs/service";
import type {
  Condition, DeliveryStatus, DeliveryView, OfflinePolicy, RoutineOutcome, RoutineRunView, RoutineSchedule, SafeFields, SafeValue, TriggerDef,
  TriggerKind, TriggerMode, TriggerState,
} from "./types";

export const triggersDbPath = (root: string) => join(dataDirFor(root), "triggers.sqlite");

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
export const dedupeKey = (source: string, eventId: string) => createHash("sha256").update(`${source}\u0000${eventId}`).digest("hex").slice(0, 32);

/**
 * The only way event content enters this store: bounded keys, scalar values, strings masked (e-mails,
 * long digit runs, typed secrets) and cut short. A long free-text value is refused, not truncated into
 * something that looks like a summary.
 */
export function safeFields(input: Record<string, unknown>): SafeFields {
  const out: SafeFields = {};
  for (const [key, value] of Object.entries(input ?? {}).slice(0, 12)) {
    if (!/^[a-z][A-Za-z0-9]{0,30}$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && value.length <= 200) out[key] = maskJobText(value, 120);
  }
  return out;
}

type TriggerRow = {
  id: string; name: string; kind: TriggerKind; source: string; action: string; conditions: string; mode: TriggerMode; state: TriggerState;
  retry_limit: number; offline_policy: OfflinePolicy | null; schedule: string | null; config: string; created_at: number; updated_at: number;
};
export type DeliveryRecord = {
  id: number; trigger_id: string; dedupe_key: string; status: DeliveryStatus; reason: string | null; attempts: number; repeats: number;
  received_at: number; updated_at: number; next_retry_at: number | null; job_id: string | null; safe: string; approval_id: string | null; stage: string;
};

const toDef = (r: TriggerRow): TriggerDef => ({
  id: r.id, name: r.name, kind: r.kind, source: r.source, action: r.action, conditions: JSON.parse(r.conditions) as Condition[], mode: r.mode, state: r.state,
  retryLimit: r.retry_limit, ...(r.offline_policy ? { offlinePolicy: r.offline_policy } : {}), ...(r.schedule ? { schedule: JSON.parse(r.schedule) as RoutineSchedule } : {}),
  config: JSON.parse(r.config) as Record<string, SafeValue>, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class TriggerStore {
  readonly db: Database;
  constructor(path: string, private now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL, conditions TEXT NOT NULL,
        mode TEXT NOT NULL, state TEXT NOT NULL, retry_limit INTEGER NOT NULL, offline_policy TEXT, schedule TEXT, config TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, repeats INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        next_retry_at INTEGER, job_id TEXT, safe TEXT NOT NULL, approval_id TEXT, stage TEXT NOT NULL DEFAULT 'start',
        UNIQUE (trigger_id, dedupe_key));
      CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);
      CREATE TABLE IF NOT EXISTS delivery_jobs (delivery_id INTEGER NOT NULL, attempt INTEGER NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY (delivery_id, attempt));
      CREATE TABLE IF NOT EXISTS outputs (ref TEXT PRIMARY KEY, job_id TEXT NOT NULL, trigger_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routine_state (trigger_id TEXT PRIMARY KEY, cursor_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routine_runs (
        trigger_id TEXT NOT NULL, slot TEXT NOT NULL, outcome TEXT NOT NULL, job_id TEXT, at INTEGER NOT NULL, missed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (trigger_id, slot));
      CREATE TABLE IF NOT EXISTS trigger_stats (trigger_id TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (trigger_id, name));`);
  }
  close() {
    this.db.close();
  }

  // ---- triggers
  upsert(def: Omit<TriggerDef, "createdAt" | "updatedAt" | "state"> & { state?: TriggerState }): TriggerDef {
    const now = this.now();
    const existing = this.db.query("SELECT * FROM triggers WHERE id=?").get(def.id) as TriggerRow | null;
    if (existing) {
      // A seed never undoes an owner's pause or disable; it only refreshes the definition.
      this.db
        .query("UPDATE triggers SET name=?, kind=?, source=?, action=?, conditions=?, mode=?, retry_limit=?, offline_policy=?, schedule=?, config=?, updated_at=? WHERE id=?")
        .run(def.name, def.kind, def.source, def.action, JSON.stringify(def.conditions), def.mode, def.retryLimit, def.offlinePolicy ?? null, def.schedule ? JSON.stringify(def.schedule) : null, JSON.stringify(def.config), now, def.id);
    } else {
      this.db
        .query("INSERT INTO triggers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(def.id, def.name, def.kind, def.source, def.action, JSON.stringify(def.conditions), def.mode, def.state ?? "active", def.retryLimit, def.offlinePolicy ?? null,
          def.schedule ? JSON.stringify(def.schedule) : null, JSON.stringify(def.config), now, now);
    }
    return this.get(def.id)!;
  }
  get(id: string): TriggerDef | null {
    const r = this.db.query("SELECT * FROM triggers WHERE id=?").get(id) as TriggerRow | null;
    return r ? toDef(r) : null;
  }
  list(filter: { source?: string; kind?: TriggerKind } = {}): TriggerDef[] {
    const rows = this.db.query("SELECT * FROM triggers ORDER BY created_at, id").all() as TriggerRow[];
    return rows.map(toDef).filter((t) => (!filter.source || t.source === filter.source) && (!filter.kind || t.kind === filter.kind));
  }
  setState(id: string, state: TriggerState): boolean {
    return this.db.query("UPDATE triggers SET state=?, updated_at=? WHERE id=?").run(state, this.now(), id).changes === 1;
  }
  bump(triggerId: string, name: "delivered" | "duplicates" | "ignored" | "paused" | "unmatched") {
    this.db.query("INSERT INTO trigger_stats VALUES (?,?,1) ON CONFLICT(trigger_id,name) DO UPDATE SET n=n+1").run(triggerId, name);
  }
  stat(triggerId: string, name: string): number {
    return (this.db.query("SELECT n FROM trigger_stats WHERE trigger_id=? AND name=?").get(triggerId, name) as { n: number } | null)?.n ?? 0;
  }

  // ---- deliveries
  /** Insert-or-count: the UNIQUE (trigger, dedupe key) is what makes a repeated delivery one job. */
  claim(triggerId: string, key: string, safe: SafeFields, ignoredReason: string | null): { created: boolean; row: DeliveryRecord } {
    const now = this.now();
    const inserted =
      this.db
        .query("INSERT OR IGNORE INTO deliveries (trigger_id, dedupe_key, status, reason, received_at, updated_at, safe) VALUES (?,?,?,?,?,?,?)")
        .run(triggerId, key, ignoredReason ? "ignored" : "queued", ignoredReason, now, now, JSON.stringify(safe)).changes === 1;
    if (!inserted) this.db.query("UPDATE deliveries SET repeats=repeats+1, updated_at=? WHERE trigger_id=? AND dedupe_key=?").run(now, triggerId, key);
    return { created: inserted, row: this.db.query("SELECT * FROM deliveries WHERE trigger_id=? AND dedupe_key=?").get(triggerId, key) as DeliveryRecord };
  }
  delivery(id: number): DeliveryRecord | null {
    return this.db.query("SELECT * FROM deliveries WHERE id=?").get(id) as DeliveryRecord | null;
  }
  patch(id: number, p: Partial<{ status: DeliveryStatus; reason: string | null; attempts: number; nextRetryAt: number | null; jobId: string | null; approvalId: string | null; stage: string }>) {
    const sets: string[] = ["updated_at=?"];
    const params: (string | number | null)[] = [this.now()];
    const map: Record<string, string> = { status: "status", reason: "reason", attempts: "attempts", nextRetryAt: "next_retry_at", jobId: "job_id", approvalId: "approval_id", stage: "stage" };
    for (const [k, col] of Object.entries(map)) if (k in p) (sets.push(`${col}=?`), params.push((p as Record<string, string | number | null>)[k]));
    this.db.query(`UPDATE deliveries SET ${sets.join(", ")} WHERE id=?`).run(...params, id);
  }
  link(deliveryId: number, attempt: number, jobId: string) {
    this.db.query("INSERT OR IGNORE INTO delivery_jobs VALUES (?,?,?)").run(deliveryId, attempt, jobId);
  }
  byStatus(statuses: DeliveryStatus[]): DeliveryRecord[] {
    return this.db.query(`SELECT * FROM deliveries WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`).all(...statuses) as DeliveryRecord[];
  }
  deliveries(triggerId: string, limit = 20): DeliveryView[] {
    const rows = this.db.query("SELECT * FROM deliveries WHERE trigger_id=? ORDER BY id DESC LIMIT ?").all(triggerId, limit) as DeliveryRecord[];
    return rows.map((r) => this.view(r));
  }
  view(r: DeliveryRecord): DeliveryView {
    const jobs = (this.db.query("SELECT attempt, job_id FROM delivery_jobs WHERE delivery_id=? ORDER BY attempt").all(r.id) as { attempt: number; job_id: string }[]).map((j) => ({ attempt: j.attempt, jobId: j.job_id }));
    return {
      id: r.id, triggerId: r.trigger_id, status: r.status, reason: r.reason, attempts: r.attempts, repeats: r.repeats, receivedAt: iso(r.received_at)!,
      updatedAt: iso(r.updated_at)!, nextRetryAt: iso(r.next_retry_at), jobId: r.job_id, jobs, safe: JSON.parse(r.safe) as SafeFields, approvalId: r.approval_id,
    };
  }
  counts(triggerId: string): { failed: number; pending: number } {
    const n = (sql: string) => (this.db.query(sql).get(triggerId) as { n: number }).n;
    return {
      failed: n("SELECT COUNT(*) AS n FROM deliveries WHERE trigger_id=? AND status IN ('failed','unknown')"),
      pending: n("SELECT COUNT(*) AS n FROM deliveries WHERE trigger_id=? AND status IN ('queued','running','awaiting-approval','retrying')"),
    };
  }

  // ---- the feedback-loop ledger
  recordOutput(ref: string, jobId: string, triggerId: string, kind: string) {
    this.db.query("INSERT OR IGNORE INTO outputs VALUES (?,?,?,?,?)").run(String(ref).slice(0, 160), jobId, triggerId, kind.slice(0, 40), this.now());
  }
  /** True when `ref` is something one of our own jobs produced, or is a child of it ("draft:42" covers "draft:42:v2"), or is one of our job ids. */
  isOwnOutput(ref: string | undefined): boolean {
    if (!ref) return false;
    const r = String(ref);
    // `ref` is stored data, never a pattern: escape LIKE's wildcards (% and _) and the escape character itself.
    if (this.db.query("SELECT 1 FROM outputs WHERE ref=? OR ? LIKE replace(replace(replace(ref, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || ':%' ESCAPE '\\'").get(r, r)) return true;
    return Boolean(this.db.query("SELECT 1 FROM outputs WHERE job_id=?").get(r)) || Boolean(this.db.query("SELECT 1 FROM delivery_jobs WHERE job_id=?").get(r));
  }

  // ---- routines
  cursor(triggerId: string): number | null {
    return (this.db.query("SELECT cursor_ms FROM routine_state WHERE trigger_id=?").get(triggerId) as { cursor_ms: number } | null)?.cursor_ms ?? null;
  }
  setCursor(triggerId: string, ms: number) {
    this.db.query("INSERT INTO routine_state VALUES (?,?) ON CONFLICT(trigger_id) DO UPDATE SET cursor_ms=MAX(cursor_ms, excluded.cursor_ms)").run(triggerId, ms);
  }
  recordRun(triggerId: string, slot: string, outcome: RoutineOutcome, jobId: string | null, missed: number) {
    this.db.query("INSERT OR REPLACE INTO routine_runs VALUES (?,?,?,?,?,?)").run(triggerId, slot, outcome, jobId, this.now(), missed);
  }
  hasRun(triggerId: string, slot: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM routine_runs WHERE trigger_id=? AND slot=?").get(triggerId, slot));
  }
  runs(triggerId: string, limit = 10): RoutineRunView[] {
    return (this.db.query("SELECT * FROM routine_runs WHERE trigger_id=? ORDER BY slot DESC LIMIT ?").all(triggerId, limit) as { slot: string; outcome: RoutineOutcome; job_id: string | null; at: number; missed: number }[]).map(
      (r) => ({ slot: r.slot, outcome: r.outcome, jobId: r.job_id, at: iso(r.at)!, missed: r.missed }),
    );
  }
}
