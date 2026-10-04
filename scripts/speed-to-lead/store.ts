// Speed-to-lead: the enquiry lead record. A small table of its own inside the same CRM database
// crm.ts already opens (.operator-data/crm.sqlite) — kept separate from the `leads` table
// (place_id-keyed cold-outreach prospects, with its own Places-compliance rules) rather than
// bent to fit it. Callers pass in an already-open Database (openCrm(crmPath(root))); this file
// never opens its own connection, so it never needs to know where the CRM file lives.
import type { Database } from "bun:sqlite";

export type EnquiryStatus = "open" | "responded";

export type EnquiryRecord = {
  ref: string;
  topic: string;
  receivedAt: string;
  detectedAt: string;
  startedAt: string;
  dueAt: string;
  outsideHoursAtArrival: boolean;
  notifiedAt: string | null;
  status: EnquiryStatus;
  respondedAt: string | null;
};

export type NewEnquiry = {
  ref: string;
  topic: string;
  receivedAt: string;
  detectedAt: string;
  startedAt: string;
  dueAt: string;
  outsideHoursAtArrival: boolean;
};

type Row = {
  id: number;
  ref: string;
  topic: string;
  received_at: string;
  detected_at: string;
  started_at: string;
  due_at: string;
  outside_hours_at_arrival: number;
  notified_at: string | null;
  status: string;
  responded_at: string | null;
};
function toRecord(r: Row): EnquiryRecord {
  return {
    ref: r.ref,
    topic: r.topic,
    receivedAt: r.received_at,
    detectedAt: r.detected_at,
    startedAt: r.started_at,
    dueAt: r.due_at,
    outsideHoursAtArrival: !!r.outside_hours_at_arrival,
    notifiedAt: r.notified_at ?? null,
    status: (r.status as EnquiryStatus) || "open",
    respondedAt: r.responded_at ?? null,
  };
}

export function ensureEnquiriesTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      outside_hours_at_arrival INTEGER NOT NULL DEFAULT 0,
      notified_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      responded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS enquiries_due ON enquiries(due_at);
  `);
}

export function openEnquiryStore(db: Database) {
  ensureEnquiriesTable(db);
  return {
    /** Idempotent on `ref`: a re-detected enquiry (the watcher's lookback window overlaps run to
     *  run by design) is a no-op — it never resets the clock or clears notifiedAt. `created` is
     *  false on a repeat, which is exactly what tells the caller not to send a second alert. */
    upsert(input: NewEnquiry): { record: EnquiryRecord; created: boolean } {
      const before = db.query("SELECT ref FROM enquiries WHERE ref = ?").get(input.ref);
      db.query(
        `INSERT INTO enquiries (ref, topic, received_at, detected_at, started_at, due_at, outside_hours_at_arrival, status)
         VALUES ($ref, $topic, $receivedAt, $detectedAt, $startedAt, $dueAt, $outsideHoursAtArrival, 'open')
         ON CONFLICT(ref) DO NOTHING`,
      ).run({
        $ref: input.ref,
        $topic: input.topic,
        $receivedAt: input.receivedAt,
        $detectedAt: input.detectedAt,
        $startedAt: input.startedAt,
        $dueAt: input.dueAt,
        $outsideHoursAtArrival: input.outsideHoursAtArrival ? 1 : 0,
      });
      const row = db.query("SELECT * FROM enquiries WHERE ref = ?").get(input.ref) as Row;
      return { record: toRecord(row), created: !before };
    },
    markNotified(ref: string, at: string) {
      db.query(
        "UPDATE enquiries SET notified_at = COALESCE(notified_at, $at) WHERE ref = $ref",
      ).run({ $ref: ref, $at: at });
    },
    markResponded(ref: string, at: string) {
      db.query(
        "UPDATE enquiries SET status = 'responded', responded_at = $at WHERE ref = $ref",
      ).run({ $ref: ref, $at: at });
    },
    get(ref: string): EnquiryRecord | null {
      const row = db.query("SELECT * FROM enquiries WHERE ref = ?").get(ref) as Row | null;
      return row ? toRecord(row) : null;
    },
    listOpen(limit = 200): EnquiryRecord[] {
      return (
        db
          .query("SELECT * FROM enquiries WHERE status = 'open' ORDER BY due_at ASC LIMIT ?")
          .all(Math.max(1, Math.min(limit, 2000))) as Row[]
      ).map(toRecord);
    },
    list(limit = 200): EnquiryRecord[] {
      return (
        db
          .query("SELECT * FROM enquiries ORDER BY received_at DESC LIMIT ?")
          .all(Math.max(1, Math.min(limit, 2000))) as Row[]
      ).map(toRecord);
    },
  };
}

export type EnquiryStore = ReturnType<typeof openEnquiryStore>;

/**
 * Open enquiries for a read-only reader (the Today panel). Unlike openEnquiryStore it never creates
 * the table: a CRM the watcher has never written to simply has no open enquiries.
 */
export function readOpenEnquiries(db: Database, limit = 200): EnquiryRecord[] {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'enquiries'").get();
  if (!table) return [];
  return (
    db
      .query("SELECT * FROM enquiries WHERE status = 'open' ORDER BY due_at ASC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 2000))) as Row[]
  ).map(toRecord);
}
