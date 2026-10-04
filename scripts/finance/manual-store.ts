// Persistent store for the owner-initiated NAB CSV import: .operator-data/finance-manual.sqlite.
// This is the AUTHORITATIVE finance transaction store (TARGET-ARCHITECTURE §2). The legacy
// finance.sqlite NAB path is retired; its rows come in once through legacy-migration.ts.
//
//  - Every row, override and audit entry carries a ledger id and every query filters on it. The
//    Finance page uses one shared business ledger for both founders (V7: full shared access); the
//    person who made each change is recorded as the actor.
//  - Only sanitised rows from manual-nab-csv.ts are stored: no account numbers (salted alias only),
//    no description text, no balances (they only exist inside salted keys).
//  - Imports are atomic (one transaction; the whole file is validated before the store is touched)
//    and idempotent: overlapping exports are recognised by id, then by the balance-based dedupe
//    key, then by the text key (NAB re-ordered same-day rows), so nothing is counted twice.
//  - Corrections live in their own tables with provenance (who, when, previous value) and an
//    append-only edit log. Re-imports never touch them; when a row is superseded (pending → posted,
//    loose → strong) its corrections move to the new row.
//  - clear() really deletes: secure_delete zeroes freed pages and VACUUM rewrites the file.
//  - The audit log holds counts, dates and codes only.
//  - Nothing here reads a folder, watches a directory or opens a bank file: the only input is text
//    that the owner explicitly handed over (drag-drop or file picker).
import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { NabCsvRejected, inspectNabCsvExport, sanitiseLabel, type KeyStrength, type ManualKind, type ManualRow, type NabCsvFormat, type NabCsvIssue } from "./manual-nab-csv";
import { vendorRule } from "./manual-vendors";
import { dataDirFor } from "../cloud/data-dir";

export const MANUAL_SOURCE = "nab-csv-manual" as const;
/** The one business ledger both founders share (V7). */
export const SHARED_LEDGER = "shared";
/** The person at this PC. An actor (provenance) only, never a separate dataset. */
export const DEFAULT_OWNER = "usman";
export const MAX_ROWS_PER_OWNER = 100_000;
export const SCHEMA_VERSION = "2";
const OWNER_RE = /^[a-z][a-z0-9-]{0,39}$/;

export function manualFinanceDbPath(root: string): string {
  return join(dataDirFor(root), "finance-manual.sqlite");
}

export function assertOwner(owner: unknown): string {
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) throw new Error("INVALID_OWNER");
  return owner;
}
const assertActor = (actor: unknown): string => {
  if (typeof actor !== "string" || !OWNER_RE.test(actor)) throw new Error("INVALID_ACTOR");
  return actor;
};

export type Scope = "business" | "personal" | "unreviewed";
export const SCOPES: readonly Scope[] = Object.freeze(["business", "personal", "unreviewed"]);
export const KINDS: readonly ManualKind[] = Object.freeze(["ordinary", "transfer", "refund", "fx-fee", "bank-fee"]);
export type TxField = "kind" | "category" | "scope" | "refundOf";
export type VendorField = "label" | "category" | "scope" | "kind";
export const TX_FIELDS: readonly TxField[] = Object.freeze(["kind", "category", "scope", "refundOf"]);
export const VENDOR_FIELDS: readonly VendorField[] = Object.freeze(["label", "category", "scope", "kind"]);
export type RowOrigin = "csv" | "legacy-csv" | "legacy-basiq";

export type ImportVia = "drop" | "picker" | "test" | "migration";
export type ImportResult = {
  importId: number; rowsInFile: number; inserted: number; unchanged: number; reconciled: number; upgraded: number; reclassified: number;
  stalePendingSkipped: number; accounts: number; firstDate: string; lastDate: string; asOf: string | null; format: NabCsvFormat | "legacy";
  warnings: number; issues: NabCsvIssue[];
};
export type PreviewResult = Omit<ImportResult, "importId"> & { preview: true };
export type AuditEntry = {
  id: number; at: string; action: "import" | "import-rejected" | "clear" | "migrate-legacy";
  via: string; actor: string | null; rowsInFile: number; inserted: number; unchanged: number; reconciled: number; upgraded: number; reclassified: number;
  deleted: number; warnings: number; asOf: string | null; format: string | null; code: string | null;
};

type DbRow = {
  id: string; account_alias: string; date: string; processed_on: string | null; status: "posted" | "pending";
  amount_cents: number; kind: ManualKind; type_label: string; vendor_id: string; vendor_label: string; known: number;
  category: string; nab_category: string; foreign_billed: number; fx_vendor_id: string | null; fx_vendor_label: string | null;
  supersedes: string | null; dedupe_key: string | null; key_strength: KeyStrength | null; text_key: string | null; origin: RowOrigin | null;
};
export type StoredRow = ManualRow & { supersedes: string | null; origin: RowOrigin };
const toRow = (r: DbRow): StoredRow => ({
  id: r.id, dedupeKey: r.dedupe_key, keyStrength: r.key_strength ?? "loose", textKey: r.text_key, accountAlias: r.account_alias, date: r.date,
  processedOn: r.processed_on, status: r.status, amountCents: r.amount_cents,
  kind: r.kind, typeLabel: r.type_label, vendorId: r.vendor_id, vendorLabel: r.vendor_label, known: r.known === 1,
  category: r.category, nabCategory: r.nab_category, foreign: r.foreign_billed === 1, fxVendorId: r.fx_vendor_id, fxVendorLabel: r.fx_vendor_label,
  supersedes: r.supersedes, origin: r.origin ?? "csv",
});

export type Provenance = { by: string; at: string; source: "row" | "vendor" };
/** A stored row with the owner's corrections applied. `base` is what NAB/the rules said. */
export type EffectiveRow = StoredRow & {
  scope: Scope;
  refundOf: string | null;
  edited: Partial<Record<TxField | "label", Provenance>>;
  base: { kind: ManualKind; category: string; vendorLabel: string; scope: Scope };
};
export type EditEntry = { id: number; at: string; actor: string; target: "tx" | "vendor"; targetId: string; field: string; oldValue: string | null; newValue: string | null; action: "set" | "revert" | "carried" };
export type VendorOverride = { vendorId: string; field: VendorField; value: string; by: string; at: string };

/** Default business/personal scope before any correction: known M&U vendors are business. */
export function defaultScope(row: Pick<ManualRow, "known" | "kind" | "fxVendorId">): Scope {
  if (row.known) return "business";
  if (row.kind === "fx-fee" && row.fxVendorId && vendorRule(row.fxVendorId)) return "business";
  return "unreviewed";
}

const dayDiff = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
/** A posted row settles a pending one: same account and amount, posted within [-1, +7] days. */
function settles(posted: ManualRow, pending: ManualRow) {
  if (posted.accountAlias !== pending.accountAlias || posted.amountCents !== pending.amountCents) return false;
  const d = dayDiff(pending.date, posted.date);
  return d >= -1 && d <= 7;
}

const sydneyDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const stampOf = (d: Date) => d.toISOString().replace(/[:.]/g, "-");
class PreviewRollback extends Error { constructor(readonly result: Omit<ImportResult, "importId">) { super("PREVIEW"); } }

function validateValue(field: TxField | VendorField, value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID_VALUE");
  const v = value.trim();
  if (field === "kind" && (KINDS as readonly string[]).includes(v)) return v;
  if (field === "scope" && (SCOPES as readonly string[]).includes(v)) return v;
  if (field === "category" && /^[A-Za-z][A-Za-z0-9 &/-]{0,39}$/.test(v)) return v;
  if (field === "label") { const l = sanitiseLabel(v); if (l && l === v) return l; }
  if (field === "refundOf" && /^(nab|legacy)-[0-9a-f]{32}$/.test(v)) return v;
  throw new Error("INVALID_VALUE");
}

/** Corporate suffixes and store numbers NAB adds to or drops from a merchant name between exports. */
const MERCHANT_NOISE = new Set(["pty", "ltd", "limited", "inc", "llc", "co", "corp", "corporation", "company", "au", "aus", "australia", "pl", "the"]);
/**
 * One id for a merchant however NAB spells it: "m-officeworks" and "m-officeworks-pty-ltd" are
 * one family. Only unknown-merchant ids (m-…) are folded; M&U vendor ids are already stable.
 */
export function merchantFamily(vendorId: string): string {
  if (!vendorId.startsWith("m-")) return vendorId;
  const tokens = vendorId.slice(2).split("-").filter((t) => t && !/^\d+$/.test(t));
  while (tokens.length > 1 && MERCHANT_NOISE.has(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length > 1 && tokens[0] === "the") tokens.shift();
  return tokens.length ? `m-${tokens.join("-")}` : vendorId;
}

export function openManualFinanceStore(file: string, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  if (file !== ":memory:" && !existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 4000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tx (
      owner TEXT NOT NULL, id TEXT NOT NULL, account_alias TEXT NOT NULL, date TEXT NOT NULL, processed_on TEXT,
      status TEXT NOT NULL CHECK (status IN ('posted','pending')), amount_cents INTEGER NOT NULL, kind TEXT NOT NULL,
      type_label TEXT NOT NULL, vendor_id TEXT NOT NULL, vendor_label TEXT NOT NULL, known INTEGER NOT NULL,
      category TEXT NOT NULL, nab_category TEXT NOT NULL, foreign_billed INTEGER NOT NULL,
      fx_vendor_id TEXT, fx_vendor_label TEXT, supersedes TEXT, import_id INTEGER NOT NULL,
      PRIMARY KEY (owner, id)
    );
    CREATE INDEX IF NOT EXISTS tx_owner_date ON tx(owner, date);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, via TEXT NOT NULL,
      rows_in_file INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0,
      reconciled INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, code TEXT
    );
    CREATE TABLE IF NOT EXISTS tx_override (
      owner TEXT NOT NULL, tx_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (owner, tx_id, field)
    );
    CREATE TABLE IF NOT EXISTS vendor_override (
      owner TEXT NOT NULL, vendor_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (owner, vendor_id, field)
    );
    CREATE TABLE IF NOT EXISTS edit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, target TEXT NOT NULL,
      target_id TEXT NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT, action TEXT NOT NULL
    );
  `);
  // v1 → v2: add the columns a v1 file (w2/finance) lacks. Its rows keep their ids; with no keys
  // they are treated as "loose" and are upgraded by the first strong row that matches them.
  const addColumns = (table: string, cols: Array<[string, string]>) => {
    const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  addColumns("tx", [["dedupe_key", "TEXT"], ["key_strength", "TEXT"], ["text_key", "TEXT"], ["origin", "TEXT NOT NULL DEFAULT 'csv'"]]);
  addColumns("audit", [["actor", "TEXT"], ["upgraded", "INTEGER NOT NULL DEFAULT 0"], ["reclassified", "INTEGER NOT NULL DEFAULT 0"],
    ["warnings", "INTEGER NOT NULL DEFAULT 0"], ["as_of", "TEXT"], ["format", "TEXT"]]);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tx_owner_key ON tx(owner, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS tx_owner_text ON tx(owner, text_key);
    CREATE INDEX IF NOT EXISTS tx_owner_amount ON tx(owner, account_alias, amount_cents);
    -- Every per-row lookup in merge() is an index seek (REVIEW-FINANCE M1: 20,000 rows took 189 s).
    CREATE INDEX IF NOT EXISTS tx_owner_amount_date ON tx(owner, account_alias, amount_cents, date);
    CREATE INDEX IF NOT EXISTS tx_owner_supersedes ON tx(owner, supersedes);
    CREATE INDEX IF NOT EXISTS tx_owner_status_amount ON tx(owner, status, account_alias, amount_cents);
    -- The dates each import covered, per account: coverage is their union (unknown is never zero).
    CREATE TABLE IF NOT EXISTS import_span (
      owner TEXT NOT NULL, import_id INTEGER NOT NULL, account_alias TEXT NOT NULL, first_date TEXT NOT NULL, last_date TEXT NOT NULL,
      PRIMARY KEY (owner, import_id, account_alias)
    );
    -- Legacy finance.sqlite rows already brought in, so a re-run never brings them in twice.
    CREATE TABLE IF NOT EXISTS legacy_migrated (owner TEXT NOT NULL, legacy_id TEXT NOT NULL, PRIMARY KEY (owner, legacy_id));`);
  let salt = (db.query("SELECT value FROM meta WHERE key = 'salt'").get() as { value: string } | null)?.value;
  if (!salt) {
    salt = randomBytes(32).toString("hex");
    db.query("INSERT INTO meta (key, value) VALUES ('salt', ?)").run(salt);
  }
  db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);
  const saltHex = salt;

  const q = {
    rows: db.query("SELECT * FROM tx WHERE owner = ? ORDER BY date, id"),
    count: db.query("SELECT COUNT(*) AS n FROM tx WHERE owner = ?"),
    get: db.query("SELECT * FROM tx WHERE owner = ? AND id = ?"),
    byKey: db.query("SELECT * FROM tx WHERE owner = ? AND dedupe_key = ?"),
    byText: db.query("SELECT * FROM tx WHERE owner = ? AND text_key = ?"),
    supersededBy: db.query("SELECT id FROM tx WHERE owner = ? AND supersedes = ?"),
    // Status leads the index: thousands of same-amount posted rows (a daily coffee) never slow a pending lookup.
    pendingFor: db.query("SELECT * FROM tx INDEXED BY tx_owner_status_amount WHERE owner = ? AND status = 'pending' AND account_alias = ? AND amount_cents = ?"),
    postedFor: db.query("SELECT * FROM tx WHERE owner = ? AND status = 'posted' AND supersedes IS NULL AND account_alias = ? AND amount_cents = ?"),
    // No ORDER BY: it made SQLite pick the primary key and scan the ledger per row. Sorted in JS.
    looseFor: db.query("SELECT * FROM tx INDEXED BY tx_owner_amount_date WHERE owner = ? AND account_alias = ? AND amount_cents = ? AND date = ? AND status = 'posted' AND (key_strength IS NULL OR key_strength = 'loose')"),
    /** Any stored posted row for this account/amount/date, superseding or not (M2: a strong row that completed a legacy row still covers it). */
    postedOnDay: db.query("SELECT * FROM tx INDEXED BY tx_owner_amount_date WHERE owner = ? AND account_alias = ? AND amount_cents = ? AND date = ? AND status = 'posted'"),
    accounts: db.query("SELECT DISTINCT account_alias AS a FROM tx WHERE owner = ?"),
    span: db.query("INSERT OR REPLACE INTO import_span (owner, import_id, account_alias, first_date, last_date) VALUES (?,?,?,?,?)"),
    spans: db.query(`SELECT account_alias AS account, first_date AS "from", last_date AS "to" FROM import_span WHERE owner = ?1
      UNION ALL SELECT account_alias, MIN(date), MAX(date) FROM tx WHERE owner = ?1 AND import_id NOT IN (SELECT import_id FROM import_span WHERE owner = ?1)
      GROUP BY import_id, account_alias`),
    wasMigrated: db.query("SELECT 1 FROM legacy_migrated WHERE owner = ? AND legacy_id = ?"),
    markMigrated: db.query("INSERT OR IGNORE INTO legacy_migrated (owner, legacy_id) VALUES (?, ?)"),
    insert: db.query(`INSERT INTO tx (owner, id, account_alias, date, processed_on, status, amount_cents, kind, type_label, vendor_id, vendor_label,
      known, category, nab_category, foreign_billed, fx_vendor_id, fx_vendor_label, supersedes, import_id, dedupe_key, key_strength, text_key, origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    del: db.query("DELETE FROM tx WHERE owner = ? AND id = ?"),
    link: db.query("UPDATE tx SET supersedes = ? WHERE owner = ? AND id = ?"),
    refresh: db.query(`UPDATE tx SET kind = ?, type_label = ?, vendor_id = ?, vendor_label = ?, known = ?, category = ?, nab_category = ?,
      foreign_billed = ?, fx_vendor_id = ?, fx_vendor_label = ? WHERE owner = ? AND id = ?`),
    rekey: db.query("UPDATE tx SET dedupe_key = ?, key_strength = ?, text_key = ? WHERE owner = ? AND id = ?"),
    audit: db.query(`INSERT INTO audit (owner, at, action, via, actor, rows_in_file, inserted, unchanged, reconciled, upgraded, reclassified, deleted, warnings, as_of, format, code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    auditList: db.query("SELECT * FROM audit WHERE owner = ? ORDER BY id DESC LIMIT ?"),
    lastImport: db.query("SELECT at, action FROM audit WHERE owner = ? AND action IN ('import','migrate-legacy','clear') ORDER BY id DESC LIMIT 1"),
    txOverrides: db.query("SELECT * FROM tx_override WHERE owner = ?"),
    txOverride: db.query("SELECT * FROM tx_override WHERE owner = ? AND tx_id = ? AND field = ?"),
    txOverridesFor: db.query("SELECT * FROM tx_override WHERE owner = ? AND tx_id = ?"),
    setTx: db.query(`INSERT INTO tx_override (owner, tx_id, field, value, actor, at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(owner, tx_id, field) DO UPDATE SET value = excluded.value, actor = excluded.actor, at = excluded.at`),
    delTx: db.query("DELETE FROM tx_override WHERE owner = ? AND tx_id = ? AND field = ?"),
    moveTx: db.query("UPDATE tx_override SET tx_id = ? WHERE owner = ? AND tx_id = ? AND field = ?"),
    repointRefunds: db.query("UPDATE tx_override SET value = ? WHERE owner = ? AND field = 'refundOf' AND value = ?"),
    vendorOverrides: db.query("SELECT * FROM vendor_override WHERE owner = ? ORDER BY vendor_id, field"),
    vendorOverride: db.query("SELECT * FROM vendor_override WHERE owner = ? AND vendor_id = ? AND field = ?"),
    setVendor: db.query(`INSERT INTO vendor_override (owner, vendor_id, field, value, actor, at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(owner, vendor_id, field) DO UPDATE SET value = excluded.value, actor = excluded.actor, at = excluded.at`),
    delVendor: db.query("DELETE FROM vendor_override WHERE owner = ? AND vendor_id = ? AND field = ?"),
    log: db.query("INSERT INTO edit_log (owner, at, actor, target, target_id, field, old_value, new_value, action) VALUES (?,?,?,?,?,?,?,?,?)"),
    logList: db.query("SELECT * FROM edit_log WHERE owner = ? ORDER BY id DESC LIMIT ?"),
  };
  const insertRow = (owner: string, r: ManualRow, supersedes: string | null, importId: number, origin: RowOrigin) =>
    q.insert.run(owner, r.id, r.accountAlias, r.date, r.processedOn, r.status, r.amountCents, r.kind, r.typeLabel, r.vendorId, r.vendorLabel,
      r.known ? 1 : 0, r.category, r.nabCategory, r.foreign ? 1 : 0, r.fxVendorId, r.fxVendorLabel, supersedes, importId,
      r.dedupeKey, r.keyStrength, r.textKey, origin);
  type AuditCounts = Partial<Record<"rowsInFile" | "inserted" | "unchanged" | "reconciled" | "upgraded" | "reclassified" | "deleted" | "warnings", number>>;
  const writeAudit = (owner: string, action: AuditEntry["action"], via: string, actor: string | null, n: AuditCounts, extra: { asOf?: string | null; format?: string | null; code?: string | null } = {}) =>
    Number(q.audit.run(owner, now().toISOString(), action, via, actor, n.rowsInFile ?? 0, n.inserted ?? 0, n.unchanged ?? 0, n.reconciled ?? 0, n.upgraded ?? 0,
      n.reclassified ?? 0, n.deleted ?? 0, n.warnings ?? 0, extra.asOf ?? null, extra.format ?? null, extra.code ?? null).lastInsertRowid);
  const logEdit = (owner: string, actor: string, target: "tx" | "vendor", targetId: string, field: string, oldValue: string | null, newValue: string | null, action: EditEntry["action"]) =>
    q.log.run(owner, now().toISOString(), actor, target, targetId, field, oldValue, newValue, action);

  /** Moves a superseded row's corrections (and refund links to it) onto its replacement. */
  function carry(owner: string, fromId: string, toId: string) {
    for (const o of q.txOverridesFor.all(owner, fromId) as Array<{ field: string; value: string; actor: string }>) {
      if (q.txOverride.get(owner, toId, o.field)) q.delTx.run(owner, fromId, o.field);
      else q.moveTx.run(toId, owner, fromId, o.field);
      logEdit(owner, o.actor, "tx", toId, o.field, fromId, o.value, "carried");
    }
    q.repointRefunds.run(toId, owner, fromId);
  }

  /** Base classification changed (rules improved, NAB re-categorised)? Refresh it; corrections are separate. */
  function refreshIfChanged(owner: string, stored: DbRow, r: ManualRow): boolean {
    const same = stored.kind === r.kind && stored.type_label === r.typeLabel && stored.vendor_id === r.vendorId && stored.vendor_label === r.vendorLabel
      && (stored.known === 1) === r.known && stored.category === r.category && stored.nab_category === r.nabCategory && (stored.foreign_billed === 1) === r.foreign
      && stored.fx_vendor_id === r.fxVendorId && stored.fx_vendor_label === r.fxVendorLabel;
    if (same) return false;
    // The same transaction now carries another merchant name (NAB renamed the merchant): the
    // founders' rule for the old name follows it, unless the new name has its own (REVIEW-FINANCE #3).
    if (stored.vendor_id !== r.vendorId && stored.vendor_id.startsWith("m-") && r.vendorId.startsWith("m-") && merchantFamily(stored.vendor_id) !== merchantFamily(r.vendorId)) {
      for (const o of q.vendorOverrides.all(owner) as Array<{ vendor_id: string; field: string; value: string; actor: string; at: string }>) {
        if (o.vendor_id !== stored.vendor_id || q.vendorOverride.get(owner, r.vendorId, o.field)) continue;
        q.setVendor.run(owner, r.vendorId, o.field, o.value, o.actor, o.at);
        logEdit(owner, o.actor, "vendor", r.vendorId, o.field, stored.vendor_id, o.value, "carried");
      }
    }
    q.refresh.run(r.kind, r.typeLabel, r.vendorId, r.vendorLabel, r.known ? 1 : 0, r.category, r.nabCategory, r.foreign ? 1 : 0, r.fxVendorId, r.fxVendorLabel, owner, stored.id);
    return true;
  }

  type Counts = { inserted: number; unchanged: number; reconciled: number; upgraded: number; reclassified: number; stalePendingSkipped: number };
  /** The one merge algorithm (imports, previews and legacy migration). Caller holds the transaction. */
  function merge(owner: string, rows: ManualRow[], importId: number, origin: RowOrigin): Counts {
    const c: Counts = { inserted: 0, unchanged: 0, reconciled: 0, upgraded: 0, reclassified: 0, stalePendingSkipped: 0 };
    const incomingKeys = new Set(rows.map((r) => r.dedupeKey).filter(Boolean));
    const incomingText = new Set(rows.map((r) => r.textKey).filter(Boolean));
    const claimed = new Set<string>();
    /** Rows this import put in: a pending row in the same file is never "settled" by one of them (review #2). */
    const insertedNow = new Set<string>();
    const matched = (stored: DbRow, r: ManualRow) => {
      claimed.add(stored.id);
      c.unchanged++;
      if (refreshIfChanged(owner, stored, r)) c.reclassified++;
    };
    // Posted rows first, so a pending row later in the same file can see its settlement.
    const ordered = [...rows.filter((r) => r.status === "posted"), ...rows.filter((r) => r.status === "pending")];
    for (const row of ordered) {
      const same = q.get.get(owner, row.id) as DbRow | null;
      if (same) { matched(same, row); continue; }
      if (row.status === "posted") {
        // 1. The balance-based key: NAB re-worded the details or re-categorised, same transaction.
        const byKey = row.keyStrength === "strong" && row.dedupeKey ? q.byKey.get(owner, row.dedupeKey) as DbRow | null : null;
        if (byKey) { if (claimed.has(byKey.id)) c.unchanged++; else matched(byKey, row); continue; }
        // 2. The text key: same transaction, but NAB re-ordered the day so its running balance moved.
        const byText = row.textKey ? (q.byText.all(owner, row.textKey) as DbRow[]).find((s) => !claimed.has(s.id) && s.status === "posted" && !(s.dedupe_key && incomingKeys.has(s.dedupe_key))) : undefined;
        if (byText) {
          matched(byText, row);
          if (byText.key_strength === "strong" && row.keyStrength === "strong" && !q.byKey.get(owner, row.dedupeKey)) q.rekey.run(row.dedupeKey, "strong", row.textKey, owner, byText.id);
          continue;
        }
        // 3. Settles a stored pending row (same vendor first), exactly once.
        const pend = (q.pendingFor.all(owner, row.accountAlias, row.amountCents) as DbRow[]).map(toRow).filter((p) => settles(row, p));
        const match = pend.find((p) => p.vendorId === row.vendorId) ?? (pend.length === 1 ? pend[0] : undefined);
        if (match) { q.del.run(owner, match.id); insertRow(owner, row, match.id, importId, origin); carry(owner, match.id, row.id); claimed.add(row.id); insertedNow.add(row.id); c.reconciled++; continue; }
        // 4. Replaces a loose row (no balance: an older export or a migrated legacy row).
        if (row.keyStrength === "strong") {
          const loose = (q.looseFor.all(owner, row.accountAlias, row.amountCents, row.date) as DbRow[]).sort((a, b) => a.id.localeCompare(b.id)).find((s) => !claimed.has(s.id));
          if (loose) { q.del.run(owner, loose.id); insertRow(owner, row, loose.id, importId, origin); carry(owner, loose.id, row.id); claimed.add(row.id); insertedNow.add(row.id); c.upgraded++; continue; }
          // 5. NAB re-ordered the day AND re-worded it (REVIEW-FINANCE #1): the balance moved, so the
          //    strong key misses, and the details changed, so the text key misses. NAB exports whole
          //    days, so a stored posted row for this account, date and amount that no other row in
          //    this file accounts for (by its strong or text key) is this row. Rows are fungible on
          //    account + date + amount, so the count per day is right whichever twin is taken. The
          //    stored row takes the new keys, so the next import of this export matches directly.
          const same = (q.postedOnDay.all(owner, row.accountAlias, row.amountCents, row.date) as DbRow[])
            .sort((a, b) => a.id.localeCompare(b.id))
            .find((s) => !claimed.has(s.id) && !insertedNow.has(s.id) && s.key_strength === "strong"
              && !(s.dedupe_key && incomingKeys.has(s.dedupe_key)) && !(s.text_key && incomingText.has(s.text_key)));
          if (same) {
            matched(same, row);
            if (row.dedupeKey && !q.byKey.get(owner, row.dedupeKey)) q.rekey.run(row.dedupeKey, "strong", row.textKey, owner, same.id);
            continue;
          }
        } else if (row.keyStrength === "loose" && row.dedupeKey) {
          // A loose row never duplicates a stored strong row for the same account, date and amount.
          // (Any strong row counts, including one that completed an earlier legacy row: REVIEW-FINANCE M2.)
          const covered = (q.postedOnDay.all(owner, row.accountAlias, row.amountCents, row.date) as DbRow[]).sort((a, b) => a.id.localeCompare(b.id)).find((s) => !claimed.has(s.id) && s.key_strength === "strong");
          if (covered) { matched(covered, row); continue; }
          const sameKey = q.byKey.get(owner, row.dedupeKey) as DbRow | null;
          if (sameKey) { if (claimed.has(sameKey.id)) c.unchanged++; else matched(sameKey, row); continue; }
        }
        insertRow(owner, row, null, importId, origin); claimed.add(row.id); insertedNow.add(row.id); c.inserted++;
        continue;
      }
      // Pending: never regress a row that has already settled.
      if (q.supersededBy.get(owner, row.id)) { c.unchanged++; continue; }
      const posted = (q.postedFor.all(owner, row.accountAlias, row.amountCents) as DbRow[]).filter((p) => !insertedNow.has(p.id)).map(toRow).filter((p) => settles(p, row));
      const settled = posted.find((p) => p.vendorId === row.vendorId) ?? (posted.length === 1 ? posted[0] : undefined);
      if (settled) { q.link.run(row.id, owner, settled.id); c.stalePendingSkipped++; continue; }
      // NAB often re-words a pending row between exports: same account, date and amount is the same row.
      const samePending = (q.pendingFor.all(owner, row.accountAlias, row.amountCents) as DbRow[]).find((p) => p.date === row.date && !claimed.has(p.id));
      if (samePending) { matched(samePending, row); continue; }
      insertRow(owner, row, null, importId, origin); claimed.add(row.id); c.inserted++;
    }
    const total = (q.count.get(owner) as { n: number }).n;
    if (total > MAX_ROWS_PER_OWNER) throw new Error("OWNER_ROW_LIMIT");
    return c;
  }

  const describe = (rows: ManualRow[]) => {
    const dates = rows.map((r) => r.date).sort();
    const asOf = rows.reduce<string | null>((m, r) => (r.processedOn && (!m || r.processedOn > m) ? r.processedOn : m), null);
    return { accounts: new Set(rows.map((r) => r.accountAlias)).size, firstDate: dates[0], lastDate: dates[dates.length - 1], asOf };
  };

  function validated(owner: string, text: unknown, via: string, actor: string | null, acceptWarnings: boolean, audit: boolean) {
    let inspection: ReturnType<typeof inspectNabCsvExport>;
    try { inspection = inspectNabCsvExport(text, saltHex, { today: sydneyDate(now()) }); }
    catch (error) {
      if (audit) writeAudit(owner, "import-rejected", via, actor, {}, { code: error instanceof NabCsvRejected ? error.code : "REJECTED" });
      throw error;
    }
    const blocking = inspection.errors > 0 || (inspection.warnings > 0 && !acceptWarnings);
    if (blocking) {
      const first = inspection.issues[0];
      if (audit) writeAudit(owner, "import-rejected", via, actor, { warnings: inspection.warnings }, { code: first.code, format: inspection.format });
      throw new NabCsvRejected(first.code, first.line, inspection.issues);
    }
    // REVIEW-FINANCE M4: an export without account numbers can't be matched against exports with
    // them (every key includes the account), so mixing the two would count the same money twice.
    const none = noneAlias(), stored = new Set((q.accounts.all(owner) as Array<{ a: string }>).map((r) => r.a));
    const incoming = new Set(inspection.rows.map((r) => r.accountAlias));
    const mix = (incoming.has(none) && [...stored].some((a) => a !== none)) || (stored.has(none) && [...incoming].some((a) => a !== none));
    if (mix) {
      const issue: NabCsvIssue = { line: null, code: "ACCOUNTLESS_MIX", column: "Account Number", severity: "error" };
      if (audit) writeAudit(owner, "import-rejected", via, actor, { rowsInFile: inspection.rows.length }, { code: issue.code, format: inspection.format });
      throw new NabCsvRejected(issue.code, null, [issue]);
    }
    return inspection;
  }
  const noneAlias = () => `acct-${createHmac("sha256", Buffer.from(saltHex, "hex")).update("account:none").digest("hex").slice(0, 10)}`;
  /** Each account in a file is covered for the file's whole date range (NAB exports a date range, not only days with rows). */
  function recordSpans(owner: string, importId: number, rows: ManualRow[], perAccount: boolean) {
    const byAccount = new Map<string, { from: string; to: string }>();
    const all = describe(rows);
    for (const r of rows) {
      const span = byAccount.get(r.accountAlias);
      if (!perAccount) byAccount.set(r.accountAlias, { from: all.firstDate, to: all.lastDate });
      else if (!span) byAccount.set(r.accountAlias, { from: r.date, to: r.date });
      else { if (r.date < span.from) span.from = r.date; if (r.date > span.to) span.to = r.date; }
    }
    for (const [account, span] of byAccount) q.span.run(owner, importId, account, span.from, span.to);
  }

  /**
   * Owner-initiated import of one NAB CSV export's text. Atomic; idempotent. A running-balance
   * warning blocks the import unless `acceptWarnings` is set by an explicit owner confirmation.
   */
  function importCsv(ownerInput: string, text: unknown, via: ImportVia, opts: { actor?: string; acceptWarnings?: boolean } = {}): ImportResult {
    const owner = assertOwner(ownerInput);
    if (!["drop", "picker", "test"].includes(via)) throw new Error("OWNER_ACTION_REQUIRED");
    const actor = opts.actor === undefined ? null : assertActor(opts.actor);
    const inspection = validated(owner, text, via, actor, !!opts.acceptWarnings, true);
    const parsed = inspection.rows;
    const info = describe(parsed);
    const run = db.transaction((): ImportResult => {
      const importId = writeAudit(owner, "import", via, actor, { rowsInFile: parsed.length, warnings: inspection.warnings }, { asOf: info.asOf, format: inspection.format });
      const c = merge(owner, parsed, importId, "csv");
      recordSpans(owner, importId, parsed, false);
      db.query("UPDATE audit SET inserted = ?, unchanged = ?, reconciled = ?, upgraded = ?, reclassified = ? WHERE id = ?")
        .run(c.inserted, c.unchanged + c.stalePendingSkipped, c.reconciled, c.upgraded, c.reclassified, importId);
      return { importId, rowsInFile: parsed.length, ...c, ...info, format: inspection.format, warnings: inspection.warnings, issues: inspection.issues };
    });
    try { return run(); }
    catch (error) {
      writeAudit(owner, "import-rejected", via, actor, { rowsInFile: parsed.length }, { code: error instanceof Error && error.message === "OWNER_ROW_LIMIT" ? "OWNER_ROW_LIMIT" : "STORE_REJECTED", format: inspection.format });
      throw error;
    }
  }

  /** What an import WOULD do, without writing anything (the merge runs and is rolled back). */
  function previewCsv(ownerInput: string, text: unknown): PreviewResult {
    const owner = assertOwner(ownerInput);
    const inspection = validated(owner, text, "preview", null, true, false);
    const parsed = inspection.rows;
    try {
      db.transaction(() => {
        const c = merge(owner, parsed, 0, "csv");
        throw new PreviewRollback({ rowsInFile: parsed.length, ...c, ...describe(parsed), format: inspection.format, warnings: inspection.warnings, issues: inspection.issues });
      })();
    } catch (error) {
      if (error instanceof PreviewRollback) return { ...error.result, preview: true };
      throw error;
    }
    throw new Error("PREVIEW_FAILED");
  }

  /**
   * Rows converted from the retired legacy store (legacy-migration.ts). Loose keys. Idempotent for
   * good: a legacy row brought in once is never brought in again, even after a NAB CSV completed it.
   */
  function importLegacyRows(ownerInput: string, input: Array<ManualRow & { origin: RowOrigin }>, actor: string): ImportResult {
    const owner = assertOwner(ownerInput);
    assertActor(actor);
    const run = db.transaction((): ImportResult => {
      const already = input.filter((r) => q.wasMigrated.get(owner, r.id)).length;
      const rows = input.filter((r) => !q.wasMigrated.get(owner, r.id));
      const importId = writeAudit(owner, "migrate-legacy", "migration", actor, { rowsInFile: input.length }, { format: "legacy" });
      const total: Counts = { inserted: 0, unchanged: 0, reconciled: 0, upgraded: 0, reclassified: 0, stalePendingSkipped: 0 };
      for (const origin of ["legacy-csv", "legacy-basiq"] as const) {
        const c = merge(owner, rows.filter((r) => r.origin === origin).map(({ origin: _o, ...r }) => r), importId, origin);
        for (const k of Object.keys(total) as Array<keyof Counts>) total[k] += c[k];
      }
      total.unchanged += already;
      for (const r of rows) q.markMigrated.run(owner, r.id);
      if (rows.length) recordSpans(owner, importId, rows, true);
      db.query("UPDATE audit SET inserted = ?, unchanged = ? WHERE id = ?").run(total.inserted, total.unchanged + total.stalePendingSkipped, importId);
      db.query("INSERT INTO meta (key, value) VALUES ('legacy_migrated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now().toISOString());
      const info = input.length ? describe(input) : { accounts: 0, firstDate: "", lastDate: "", asOf: null };
      return { importId, rowsInFile: input.length, ...total, ...info, format: "legacy", warnings: 0, issues: [] };
    });
    return run();
  }

  // ---- corrections -------------------------------------------------------------------------
  function baseRows(owner: string): StoredRow[] { return (q.rows.all(assertOwner(owner)) as DbRow[]).map(toRow); }

  type OverrideRow = { field: string; value: string; actor: string; at: string };
  type VendorOverrideRow = OverrideRow & { vendor_id: string };
  type TxOverrideRow = OverrideRow & { tx_id: string };
  /** Base → vendor rule → row correction, each applied field recording who set it and when. */
  function withCorrections(rows: StoredRow[], vendorOv: VendorOverrideRow[], txOv: TxOverrideRow[]): EffectiveRow[] {
    const vendor = new Map<string, OverrideRow[]>(), tx = new Map<string, OverrideRow[]>();
    for (const o of vendorOv) (vendor.get(o.vendor_id) ?? vendor.set(o.vendor_id, []).get(o.vendor_id)!).push(o);
    for (const o of txOv) (tx.get(o.tx_id) ?? tx.set(o.tx_id, []).get(o.tx_id)!).push(o);
    return rows.map((r) => {
      const scope0 = defaultScope(r);
      const out: EffectiveRow = { ...r, scope: scope0, refundOf: null, edited: {}, base: { kind: r.kind, category: r.category, vendorLabel: r.vendorLabel, scope: scope0 } };
      const apply = (o: OverrideRow, source: Provenance["source"]) => {
        if (o.field === "kind") out.kind = o.value as ManualKind;
        else if (o.field === "category") out.category = o.value;
        else if (o.field === "scope") out.scope = o.value as Scope;
        else if (o.field === "label") out.vendorLabel = o.value;
        else if (o.field === "refundOf") out.refundOf = o.value;
        else return;
        out.edited[o.field as TxField | "label"] = { by: o.actor, at: o.at, source };
      };
      // A rule set on this vendor id wins; otherwise a rule on the same merchant under another
      // spelling NAB used ("Officeworks" vs "OFFICEWORKS PTY LTD": REVIEW-FINANCE #3), newest first.
      const own = vendor.get(r.vendorId) ?? [];
      const family = merchantFamily(r.vendorId);
      const kin = family === r.vendorId ? [] : [...vendor.entries()]
        .filter(([id]) => id !== r.vendorId && merchantFamily(id) === family).flatMap(([, list]) => list)
        .filter((o) => !own.some((x) => x.field === o.field)).sort((a, b) => a.at.localeCompare(b.at));
      for (const o of [...kin, ...own]) apply(o, "vendor");
      for (const o of tx.get(r.id) ?? []) apply(o, "row");
      return out;
    });
  }

  function effectiveRows(ownerInput: string): EffectiveRow[] {
    const owner = assertOwner(ownerInput);
    return withCorrections(baseRows(owner), q.vendorOverrides.all(owner) as VendorOverrideRow[], q.txOverrides.all(owner) as TxOverrideRow[]);
  }

  function effectiveRow(owner: string, txId: string): EffectiveRow | null {
    const stored = q.get.get(owner, txId) as DbRow | null;
    if (!stored) return null;
    const row = toRow(stored);
    const family = merchantFamily(row.vendorId);
    const vendorOv = (q.vendorOverrides.all(owner) as VendorOverrideRow[]).filter((o) => o.vendor_id === row.vendorId || merchantFamily(o.vendor_id) === family);
    return withCorrections([row], vendorOv, q.txOverridesFor.all(owner, txId) as TxOverrideRow[])[0];
  }

  function effectiveValue(owner: string, txId: string, field: TxField): string | null {
    const row = effectiveRow(owner, txId);
    if (!row) return null;
    return field === "refundOf" ? row.refundOf : String(row[field]);
  }

  /** Owner correction of one transaction. Kept with provenance; survives every re-import. */
  function setTxOverride(ownerInput: string, txId: string, patch: Partial<Record<TxField, string | null>>, actorInput: string): EffectiveRow {
    const owner = assertOwner(ownerInput), actor = assertActor(actorInput);
    const run = db.transaction(() => {
      const stored = q.get.get(owner, txId) as DbRow | null;
      if (!stored) throw new Error("UNKNOWN_TRANSACTION");
      const fields = Object.keys(patch) as TxField[];
      if (!fields.length || fields.some((f) => !TX_FIELDS.includes(f))) throw new Error("INVALID_FIELD");
      for (const field of fields) {
        const raw = patch[field];
        const before = effectiveValue(owner, txId, field);
        if (raw === null) {
          if (q.txOverride.get(owner, txId, field)) { q.delTx.run(owner, txId, field); logEdit(owner, actor, "tx", txId, field, before, effectiveValue(owner, txId, field), "revert"); }
          continue;
        }
        const value = validateValue(field, raw);
        if (field === "refundOf") {
          const original = q.get.get(owner, value) as DbRow | null;
          if (!original || value === txId || original.amount_cents >= 0 || stored.amount_cents <= 0) throw new Error("INVALID_REFUND_LINK");
          const kindBefore = effectiveValue(owner, txId, "kind");
          if (kindBefore !== "refund" && !fields.includes("kind")) { q.setTx.run(owner, txId, "kind", "refund", actor, now().toISOString()); logEdit(owner, actor, "tx", txId, "kind", kindBefore, "refund", "set"); }
        }
        q.setTx.run(owner, txId, field, value, actor, now().toISOString());
        logEdit(owner, actor, "tx", txId, field, before, value, "set");
      }
    });
    run();
    return effectiveRow(owner, txId)!;
  }

  /** Owner rule for every row of one vendor (now and in future imports). Row corrections win over it. */
  function setVendorOverride(ownerInput: string, vendorId: string, patch: Partial<Record<VendorField, string | null>>, actorInput: string): VendorOverride[] {
    const owner = assertOwner(ownerInput), actor = assertActor(actorInput);
    if (typeof vendorId !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(vendorId)) throw new Error("INVALID_VENDOR");
    const run = db.transaction(() => {
      const fields = Object.keys(patch) as VendorField[];
      if (!fields.length || fields.some((f) => !VENDOR_FIELDS.includes(f))) throw new Error("INVALID_FIELD");
      for (const field of fields) {
        const raw = patch[field];
        const before = (q.vendorOverride.get(owner, vendorId, field) as { value: string } | null)?.value ?? null;
        if (raw === null) { if (before !== null) { q.delVendor.run(owner, vendorId, field); logEdit(owner, actor, "vendor", vendorId, field, before, null, "revert"); } continue; }
        const value = validateValue(field, raw);
        q.setVendor.run(owner, vendorId, field, value, actor, now().toISOString());
        logEdit(owner, actor, "vendor", vendorId, field, before, value, "set");
      }
    });
    run();
    return vendorOverrides(owner);
  }

  function vendorOverrides(ownerInput: string): VendorOverride[] {
    return (q.vendorOverrides.all(assertOwner(ownerInput)) as Array<{ vendor_id: string; field: VendorField; value: string; actor: string; at: string }>)
      .map((o) => ({ vendorId: o.vendor_id, field: o.field, value: o.value, by: o.actor, at: o.at }));
  }

  /** A consistent full copy of this store (SQLite VACUUM INTO). Never overwrites an existing file. */
  function backupTo(target: string): string {
    if (file === ":memory:") throw new Error("NO_FILE");
    if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) throw new Error("BACKUP_EXISTS");
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    if (!existsSync(target)) throw new Error("BACKUP_FAILED");
    return target;
  }

  /**
   * V7: one shared business ledger. Moves rows kept per person (the w2 design keyed them by
   * "usman"/"mehroz") into SHARED_LEDGER, after a full backup of the file. A row already in the
   * shared ledger (same id or dedupe key) is not duplicated. Who imported or corrected something
   * is kept as provenance (audit actor, override actor), never as access. Idempotent.
   */
  function consolidateLedgers(options: { backupDir?: string; stamp?: string } = {}): { owners: string[]; moved: number; duplicates: number; backup: string | null } {
    const owners = (db.query(`SELECT owner FROM tx WHERE owner != ?1 UNION SELECT owner FROM audit WHERE owner != ?1 UNION SELECT owner FROM import_span WHERE owner != ?1
      UNION SELECT owner FROM tx_override WHERE owner != ?1 UNION SELECT owner FROM vendor_override WHERE owner != ?1
      UNION SELECT owner FROM edit_log WHERE owner != ?1`).all(SHARED_LEDGER) as Array<{ owner: string }>).map((o) => o.owner).sort();
    if (!owners.length) return { owners: [], moved: 0, duplicates: 0, backup: null };
    const backup = file === ":memory:" ? null
      : backupTo(join(options.backupDir ?? join(dirname(file), "backups"), `finance-manual.pre-shared-ledger-${options.stamp ?? stampOf(now())}.sqlite`));
    let moved = 0, duplicates = 0;
    db.transaction(() => {
      for (const owner of owners) {
        for (const row of db.query("SELECT id, dedupe_key FROM tx WHERE owner = ? ORDER BY date, id").all(owner) as Array<{ id: string; dedupe_key: string | null }>) {
          const clash = db.query("SELECT id FROM tx WHERE owner = ? AND (id = ? OR (?3 IS NOT NULL AND dedupe_key = ?3))").get(SHARED_LEDGER, row.id, row.dedupe_key) as { id: string } | null;
          if (clash) {
            // The shared ledger already has this transaction: keep its corrections too (review #12),
            // unless the shared row has its own correction for that field.
            db.query("UPDATE OR IGNORE tx_override SET owner = ?, tx_id = ? WHERE owner = ? AND tx_id = ?").run(SHARED_LEDGER, clash.id, owner, row.id);
            db.query("DELETE FROM tx_override WHERE owner = ? AND tx_id = ?").run(owner, row.id);
            db.query("DELETE FROM tx WHERE owner = ? AND id = ?").run(owner, row.id); duplicates++;
          }
          else { db.query("UPDATE tx SET owner = ? WHERE owner = ? AND id = ?").run(SHARED_LEDGER, owner, row.id); moved++; }
        }
        db.query("UPDATE OR IGNORE tx_override SET owner = ? WHERE owner = ?").run(SHARED_LEDGER, owner);
        db.query("DELETE FROM tx_override WHERE owner = ?").run(owner);
        db.query("UPDATE OR IGNORE vendor_override SET owner = ? WHERE owner = ?").run(SHARED_LEDGER, owner);
        db.query("DELETE FROM vendor_override WHERE owner = ?").run(owner);
        db.query("UPDATE audit SET owner = ?, actor = COALESCE(actor, ?) WHERE owner = ?").run(SHARED_LEDGER, owner, owner);
        db.query("UPDATE edit_log SET owner = ? WHERE owner = ?").run(SHARED_LEDGER, owner);
        db.query("UPDATE OR IGNORE import_span SET owner = ? WHERE owner = ?").run(SHARED_LEDGER, owner);
        db.query("DELETE FROM import_span WHERE owner = ?").run(owner);
        db.query("UPDATE OR IGNORE legacy_migrated SET owner = ? WHERE owner = ?").run(SHARED_LEDGER, owner);
        db.query("DELETE FROM legacy_migrated WHERE owner = ?").run(owner);
      }
      db.query("INSERT INTO meta (key, value) VALUES ('ledger_consolidated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now().toISOString());
    })();
    return { owners, moved, duplicates, backup };
  }

  return {
    file,
    importCsv,
    previewCsv,
    consolidateLedgers,
    backupTo,
    /** This store's salted HMAC (hex) of a label: lets the legacy migration build the same account aliases and ids. */
    salted(label: string): string { return createHmac("sha256", Buffer.from(saltHex, "hex")).update(label).digest("hex"); },
    importLegacyRows,
    /** Rows with corrections applied (what every summary reads). */
    rows(owner: string): EffectiveRow[] { return effectiveRows(owner); },
    row(owner: string, txId: string): EffectiveRow | null { return effectiveRow(assertOwner(owner), txId); },
    /** Rows exactly as imported, without corrections. */
    baseRows,
    /** The date ranges each import covered, per account alias (for coverage; aliases never leave Finance). */
    coverageSpans(owner: string): Array<{ account: string; from: string; to: string }> {
      return q.spans.all(assertOwner(owner)) as Array<{ account: string; from: string; to: string }>;
    },
    count(owner: string): number { return (q.count.get(assertOwner(owner)) as { n: number }).n; },
    /** Time of the last successful import or migration, or null if nothing is imported (or it was cleared since). */
    lastImportAt(owner: string): string | null {
      const last = q.lastImport.get(assertOwner(owner)) as { at: string; action: string } | null;
      return last && last.action !== "clear" ? last.at : null;
    },
    legacyMigratedAt(): string | null {
      return (db.query("SELECT value FROM meta WHERE key = 'legacy_migrated_at'").get() as { value: string } | null)?.value ?? null;
    },
    setTxOverride,
    setVendorOverride,
    vendorOverrides,
    editLog(ownerInput: string, limit = 50): EditEntry[] {
      const owner = assertOwner(ownerInput);
      return (q.logList.all(owner, Math.max(1, Math.min(500, limit))) as Array<Record<string, any>>).map((e) => ({
        id: e.id, at: e.at, actor: e.actor, target: e.target, targetId: e.target_id, field: e.field, oldValue: e.old_value ?? null, newValue: e.new_value ?? null, action: e.action,
      }));
    },
    /**
     * Deletes every imported row, its row corrections and coverage for this ledger. Vendor rules are
     * settings and stay. The one irreversible action, so a full backup is taken first (review #4).
     */
    clear(ownerInput: string, actorInput?: string): { deleted: number; backup: string | null } {
      const owner = assertOwner(ownerInput);
      const actor = actorInput === undefined ? null : assertActor(actorInput);
      const backup = file === ":memory:" || !(q.count.get(owner) as { n: number }).n ? null
        : backupTo(join(dirname(file), "backups", `finance-manual.pre-clear-${stampOf(now())}.sqlite`));
      const deleted = db.transaction(() => {
        db.query("DELETE FROM import_span WHERE owner = ?").run(owner);
        const n = Number(db.query("DELETE FROM tx WHERE owner = ?").run(owner).changes);
        db.query("DELETE FROM tx_override WHERE owner = ?").run(owner);
        db.query("DELETE FROM edit_log WHERE owner = ? AND target = 'tx'").run(owner);
        return n;
      })();
      writeAudit(owner, "clear", "owner", actor, { deleted });
      if (file !== ":memory:") db.exec("VACUUM");
      return { deleted, backup };
    },
    audit(ownerInput: string, limit = 20): AuditEntry[] {
      const owner = assertOwner(ownerInput);
      return (q.auditList.all(owner, Math.max(1, Math.min(200, limit))) as Array<Record<string, any>>).map((a) => ({
        id: a.id, at: a.at, action: a.action, via: a.via, actor: a.actor ?? null, rowsInFile: a.rows_in_file, inserted: a.inserted, unchanged: a.unchanged,
        reconciled: a.reconciled, upgraded: a.upgraded ?? 0, reclassified: a.reclassified ?? 0, deleted: a.deleted, warnings: a.warnings ?? 0,
        asOf: a.as_of ?? null, format: a.format ?? null, code: a.code ?? null,
      }));
    },
    close() { db.close(); },
  };
}
export type ManualFinanceStore = ReturnType<typeof openManualFinanceStore>;

const shared = new Map<string, ManualFinanceStore>();
/**
 * One store handle per file in this process (the Finance plugin, Jarvis and business memory share
 * it). Opening it folds any per-person ledgers into the shared one, once, after a backup.
 */
export function sharedManualStore(root: string): ManualFinanceStore {
  const file = manualFinanceDbPath(root);
  let store = shared.get(file);
  if (!store) {
    store = openManualFinanceStore(file);
    store.consolidateLedgers();
    shared.set(file, store);
  }
  return store;
}
/** Releases shared handles (tests, server close). */
export function closeSharedManualStores(): void {
  for (const store of shared.values()) { try { store.close(); } catch { /* already closed */ } }
  shared.clear();
}
