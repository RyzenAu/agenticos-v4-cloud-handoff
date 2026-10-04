// Inbox triage: the private log (.operator-data/inbox-triage.sqlite) and the alert ledger.
// One row per inbound email: short metadata, a masked one-line summary and the decisions. No
// bodies — the mail archive already keeps the provider snippet and nothing more is copied here.
import { createRequire } from "node:module";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Category, Flags, Importance, Relationship } from "./rules";
import { dataDirFor } from "../cloud/data-dir";

type Sql = string | number | null;
type Row = Record<string, unknown>;
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: Sql[]): unknown; all(...args: Sql[]): Row[]; get(...args: Sql[]): Row | undefined };
  close(): void;
};
const require = createRequire(import.meta.url);

export type TriageRow = {
  messageId: string;
  account: string;
  threadId: string;
  receivedAt: string;
  loggedAt: string;
  senderName: string;
  senderAddress: string;
  senderDomain: string;
  subject: string;
  summary: string;
  category: Category;
  importance: Importance;
  reason: string;
  rulesCategory: Category;
  rulesImportance: Importance;
  jevCategory: Category | null;
  jevImportance: Importance | null;
  /** Jev's probabilities and nouls, or null when Jev wasn't asked or failed. */
  jev: { categoryConfidence: number; importanceConfidence: number; needsReply: number; manipulation: number; probabilities: Record<string, unknown> } | null;
  jevMs: number | null;
  jevError: string | null;
  relationship: Relationship;
  flags: Flags;
  wouldAlert: boolean;
  alertBasis: "" | "rules" | "jev" | "both";
  alertReason: string;
  /** "", armed-off, sent, suppressed:<why>, stale, backfill */
  alertStatus: string;
  mode: string;
  policyVersion: string;
  backfill: boolean;
};

export const triageDbPath = (root: string) => join(dataDirFor(root), "inbox-triage.sqlite");

export function openTriageStore(root: string, options: { readonly?: boolean; path?: string } = {}) {
  const path = options.path ?? triageDbPath(root);
  if (!options.readonly) mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const module = require(process.versions.bun ? "bun:sqlite" : "node:sqlite");
  const db: Db = process.versions.bun
    ? new module.Database(path, options.readonly ? { readonly: true } : { create: true })
    : new module.DatabaseSync(path, options.readonly ? { readOnly: true } : {});
  if (!options.readonly) {
    try { chmodSync(path, 0o600); } catch { /* Windows ignores modes; the folder is private. */ }
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS triage_log (
        message_id TEXT PRIMARY KEY, account TEXT NOT NULL, thread_id TEXT NOT NULL, received_at TEXT NOT NULL, logged_at TEXT NOT NULL,
        sender_name TEXT NOT NULL, sender_address TEXT NOT NULL, sender_domain TEXT NOT NULL, subject TEXT NOT NULL, summary TEXT NOT NULL,
        category TEXT NOT NULL, importance TEXT NOT NULL, reason TEXT NOT NULL,
        rules_category TEXT NOT NULL, rules_importance TEXT NOT NULL,
        jev_category TEXT, jev_importance TEXT, jev_json TEXT, jev_ms INTEGER, jev_error TEXT,
        relationship TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}',
        would_alert INTEGER NOT NULL DEFAULT 0, alert_basis TEXT NOT NULL DEFAULT '', alert_reason TEXT NOT NULL DEFAULT '', alert_status TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL, policy_version TEXT NOT NULL, backfill INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS triage_received ON triage_log(received_at DESC);
      CREATE TABLE IF NOT EXISTS alert_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, thread_key TEXT NOT NULL, sender_key TEXT NOT NULL,
        channel TEXT NOT NULL, importance TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', subject_key TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS ledger_at ON alert_ledger(at DESC);`);
    if (!db.prepare("PRAGMA table_info(alert_ledger)").all().some((c) => c.name === "subject_key")) db.exec("ALTER TABLE alert_ledger ADD COLUMN subject_key TEXT NOT NULL DEFAULT ''");
  }
  const toRow = (r: Row): TriageRow => ({
    messageId: String(r.message_id),
    account: String(r.account),
    threadId: String(r.thread_id),
    receivedAt: String(r.received_at),
    loggedAt: String(r.logged_at),
    senderName: String(r.sender_name),
    senderAddress: String(r.sender_address),
    senderDomain: String(r.sender_domain),
    subject: String(r.subject),
    summary: String(r.summary),
    category: r.category as Category,
    importance: r.importance as Importance,
    reason: String(r.reason),
    rulesCategory: r.rules_category as Category,
    rulesImportance: r.rules_importance as Importance,
    jevCategory: (r.jev_category as Category) ?? null,
    jevImportance: (r.jev_importance as Importance) ?? null,
    jev: r.jev_json ? JSON.parse(String(r.jev_json)) : null,
    jevMs: r.jev_ms === null || r.jev_ms === undefined ? null : Number(r.jev_ms),
    jevError: (r.jev_error as string) ?? null,
    relationship: r.relationship as Relationship,
    flags: JSON.parse(String(r.flags || "{}")),
    wouldAlert: Number(r.would_alert) === 1,
    alertBasis: String(r.alert_basis || "") as TriageRow["alertBasis"],
    alertReason: String(r.alert_reason || ""),
    alertStatus: String(r.alert_status || ""),
    mode: String(r.mode),
    policyVersion: String(r.policy_version),
    backfill: Number(r.backfill) === 1,
  });
  return {
    has(messageId: string) {
      return !!db.prepare("SELECT 1 AS x FROM triage_log WHERE message_id=?").get(messageId);
    },
    insert(row: TriageRow) {
      db.prepare(
        `INSERT OR IGNORE INTO triage_log(message_id,account,thread_id,received_at,logged_at,sender_name,sender_address,sender_domain,subject,summary,category,importance,reason,rules_category,rules_importance,jev_category,jev_importance,jev_json,jev_ms,jev_error,relationship,flags,would_alert,alert_basis,alert_reason,alert_status,mode,policy_version,backfill)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.messageId, row.account, row.threadId, row.receivedAt, row.loggedAt, row.senderName, row.senderAddress, row.senderDomain, row.subject, row.summary,
        row.category, row.importance, row.reason, row.rulesCategory, row.rulesImportance, row.jevCategory, row.jevImportance,
        row.jev ? JSON.stringify(row.jev) : null, row.jevMs, row.jevError, row.relationship, JSON.stringify(row.flags),
        row.wouldAlert ? 1 : 0, row.alertBasis, row.alertReason, row.alertStatus, row.mode, row.policyVersion, row.backfill ? 1 : 0,
      );
    },
    setAlertStatus(messageId: string, status: string) {
      db.prepare("UPDATE triage_log SET alert_status=? WHERE message_id=?").run(status.slice(0, 80), messageId);
    },
    /** Rows received at or after `sinceIso`, newest first. */
    since(sinceIso: string, limit = 500) {
      return db.prepare("SELECT * FROM triage_log WHERE received_at>=? ORDER BY received_at DESC LIMIT ?").all(sinceIso, Math.max(1, Math.min(limit, 2000))).map(toRow);
    },
    recent(limit = 50) {
      return db.prepare("SELECT * FROM triage_log ORDER BY received_at DESC LIMIT ?").all(Math.max(1, Math.min(limit, 2000))).map(toRow);
    },
    counts() {
      const total = Number(db.prepare("SELECT COUNT(*) AS c FROM triage_log").get()?.c ?? 0);
      const withJev = Number(db.prepare("SELECT COUNT(*) AS c FROM triage_log WHERE jev_category IS NOT NULL").get()?.c ?? 0);
      const last = db.prepare("SELECT MAX(logged_at) AS at FROM triage_log").get()?.at;
      return { total, withJev, lastLoggedAt: last ? String(last) : null };
    },
    ledger: {
      record(entry: { messageId: string; threadKey: string; senderKey: string; subjectKey?: string; channel: string; importance: Importance; at: string; status: string; detail?: string }) {
        db.prepare("INSERT INTO alert_ledger(message_id,thread_key,sender_key,subject_key,channel,importance,at,status,detail) VALUES(?,?,?,?,?,?,?,?,?)").run(
          entry.messageId, entry.threadKey, entry.senderKey, (entry.subjectKey ?? "").slice(0, 160), entry.channel, entry.importance, entry.at, entry.status, (entry.detail ?? "").slice(0, 200),
        );
      },
      /** Sent alerts on a channel since `sinceIso`. */
      sentSince(channel: string, sinceIso: string) {
        return db.prepare("SELECT message_id,thread_key,sender_key,subject_key,importance,at FROM alert_ledger WHERE channel=? AND status='sent' AND at>=? ORDER BY at DESC").all(channel, sinceIso).map((r) => ({
          messageId: String(r.message_id), threadKey: String(r.thread_key), senderKey: String(r.sender_key), subjectKey: String(r.subject_key ?? ""), importance: String(r.importance) as Importance, at: String(r.at),
        }));
      },
    },
    close() {
      db.close();
    },
  };
}
export type TriageStore = ReturnType<typeof openTriageStore>;
