// One-way migration of NAB rows from the RETIRED legacy store (.operator-data/finance.sqlite, the
// Basiq/CSV path in store.ts + csv-import.ts) into the authoritative finance-manual.sqlite.
//
// Safety:
//  - Backs up first: the legacy file (+ -wal/-shm) is copied into .operator-data/backups/, and the
//    manual store is copied with VACUUM INTO. Nothing is migrated if a backup fails.
//  - Reads only the BACKUP COPY of the legacy file. The original is never opened, changed or
//    deleted (it also holds the Stripe tables, which stay where they are).
//  - Rows land in the shared ledger as "loose" rows (the legacy store kept no running balance),
//    tagged origin legacy-csv / legacy-basiq. The first NAB CSV import that covers them replaces
//    each one with the full row (same account, date and amount), carrying any correction across, so
//    the same money is never counted twice. Re-running the migration changes nothing.
//  - Output is counts only: no descriptions, account numbers or amounts are printed or returned.
//
// CLI (owner-run; dry run by default):
//   bun scripts/finance/legacy-migration.ts --root <AgenticOS folder> [--apply] [--force] [--actor usman]
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyNabText, labelNabRow, sanitiseLabel, sanitiseType, type ManualRow } from "./manual-nab-csv";
import { SHARED_LEDGER, manualFinanceDbPath, openManualFinanceStore, stampOf, type ManualFinanceStore, type RowOrigin } from "./manual-store";
import { financeDbPath } from "./store";

type LegacyTx = { id: string; account_id: string; amount: number; direction: string; description: string; post_date: string | null; transaction_date: string | null; status: string; class: string; source: string };

export type LegacyMigrationResult = {
  present: boolean;
  applied: boolean;
  /** NAB rows found in the legacy store, by source. */
  found: { csv: number; basiq: number };
  /** Rows that could not be converted (no usable date or amount). Counted, never shown. */
  skipped: number;
  inserted: number;
  unchanged: number;
  backupDir: string | null;
  manualBackup: string | null;
  migratedAt: string | null;
};

const upper = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();
const sydneyDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** Legacy rows → sanitised manual rows (pure, given the manual store's salt). */
export function convertLegacyRows(rows: LegacyTx[], accountNumbers: Map<string, string>, salted: (label: string) => string): { rows: Array<ManualRow & { origin: RowOrigin }>; skipped: number } {
  const out: Array<ManualRow & { origin: RowOrigin }> = [];
  let skipped = 0;
  for (const t of rows) {
    const when = t.post_date ?? t.transaction_date;
    const time = when ? Date.parse(when) : NaN;
    if (!Number.isFinite(time) || typeof t.amount !== "number" || !Number.isFinite(t.amount)) { skipped++; continue; }
    const date = sydneyDate(when!);
    const magnitude = Math.round(Math.abs(t.amount) * 100);
    const amountCents = t.direction === "debit" || t.amount < 0 ? -magnitude : magnitude;
    const rawAccount = accountNumbers.get(t.account_id) ?? (t.account_id.startsWith("nab-csv:") ? t.account_id.slice("nab-csv:".length) : "");
    // A Basiq row with no stored account number is still a known account (its Basiq id), not "no account".
    const account = rawAccount === "default" ? "" : rawAccount ? rawAccount.replace(/[^0-9A-Za-z]/g, "")
      : t.account_id && !t.account_id.startsWith("nab-csv:") ? `legacy:${t.account_id}` : "";
    const accountAlias = `acct-${salted(`account:${account || "none"}`).slice(0, 10)}`;
    // csv-import.ts joined "details · merchant"; Basiq wrote one description.
    const [details = "", merchant = ""] = String(t.description ?? "").split(" · ");
    const typeLabel = sanitiseType(String(t.class ?? ""));
    const text = `${upper(details)} ${upper(merchant)}`;
    const kind = classifyNabText(typeLabel, text, amountCents);
    const label = labelNabRow(kind, typeLabel, merchant, amountCents > 0, text);
    const status = t.status === "pending" ? "pending" as const : "posted" as const;
    out.push({
      id: `legacy-${salted(`legacy:${t.id}`).slice(0, 32)}`,
      dedupeKey: status === "posted" ? `k-${salted(`legacy-loose:${t.id}`).slice(0, 32)}` : null,
      keyStrength: status === "posted" ? "loose" : "pending", textKey: null,
      accountAlias, date, processedOn: status === "posted" ? date : null, status, amountCents, kind, typeLabel,
      vendorId: label.vendorId, vendorLabel: label.vendorLabel, known: label.known,
      category: label.category || (amountCents > 0 ? "uncategorised-in" : "uncategorised-out"), nabCategory: sanitiseLabel(String(t.class ?? ""), 32),
      foreign: kind !== "fx-fee" && label.foreignBilled, fxVendorId: null, fxVendorLabel: null,
      origin: t.source === "basiq" ? "legacy-basiq" : "legacy-csv",
    });
  }
  return { rows: out, skipped };
}

/**
 * How many NAB rows the legacy store still holds (0 when there is no file or no table), or null if
 * it can't be read. Read-only COUNT, no row is read. The Finance page only offers the migration
 * when this is above zero.
 */
export function legacyNabRowCount(root: string): number | null {
  const file = financeDbPath(root);
  if (!existsSync(file)) return 0;
  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    const has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get();
    return has ? (db.query("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n : 0;
  } catch { return null; }
  finally { db?.close(); }
}

/**
 * Dry run unless `apply`. Backs up both stores before reading anything. `store` defaults to the
 * manual store under `root` (opened and closed here).
 */
export class LegacyMigrationRefused extends Error { constructor(readonly code: "ALREADY_MIGRATED") { super(code); } }

export function migrateLegacyFinance(options: { root: string; apply?: boolean; force?: boolean; actor?: string; store?: ManualFinanceStore; now?: () => Date }): LegacyMigrationResult {
  const now = options.now ?? (() => new Date());
  const legacyFile = financeDbPath(options.root);
  const empty: LegacyMigrationResult = { present: false, applied: false, found: { csv: 0, basiq: 0 }, skipped: 0, inserted: 0, unchanged: 0, backupDir: null, manualBackup: null, migratedAt: null };
  const ownsStore = !options.store;
  const store = options.store ?? openManualFinanceStore(manualFinanceDbPath(options.root), { now });
  try {
    if (!existsSync(legacyFile)) return { ...empty, migratedAt: store.legacyMigratedAt() };
    // Once migrated, a re-run needs --force (REVIEW-FINANCE M2). Even then nothing counts twice:
    // the store remembers every legacy row it has ever brought in.
    if (options.apply && store.legacyMigratedAt() && !options.force) throw new LegacyMigrationRefused("ALREADY_MIGRATED");
    let backupDir: string | null = null, manualBackup: string | null = null;
    if (options.apply) {
      // Backups are byte copies that are never opened (review #5), so they stay identical to the originals.
      backupDir = join(options.root, ".operator-data", "backups", `finance-legacy-${stampOf(now())}`);
      if (existsSync(backupDir)) throw new Error("BACKUP_EXISTS");
      mkdirSync(backupDir, { recursive: true });
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(legacyFile + suffix)) copyFileSync(legacyFile + suffix, join(backupDir, `finance.sqlite${suffix}`));
      manualBackup = store.file === ":memory:" ? null : store.backupTo(join(backupDir, "finance-manual.sqlite"));
    }

    // Read a disposable working copy in the temp folder: never the original, never the backup.
    const work = mkdtempSync(join(tmpdir(), "finance-legacy-read-"));
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(legacyFile + suffix)) copyFileSync(legacyFile + suffix, join(work, `finance.sqlite${suffix}`));
    const copy = new Database(join(work, "finance.sqlite"));
    let legacy: LegacyTx[] = [], accounts = new Map<string, string>();
    try {
      const tables = new Set((copy.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
      if (tables.has("transactions")) {
        const cols = new Set((copy.query("PRAGMA table_info(transactions)").all() as Array<{ name: string }>).map((c) => c.name));
        legacy = copy.query(`SELECT id, account_id, amount, direction, description, post_date, transaction_date, status, class, ${cols.has("source") ? "source" : "'basiq' AS source"} FROM transactions ORDER BY post_date, id`).all() as LegacyTx[];
      }
      if (tables.has("accounts")) accounts = new Map((copy.query("SELECT id, account_no FROM accounts").all() as Array<{ id: string; account_no: string }>).map((a) => [a.id, a.account_no ?? ""]));
    } finally { copy.close(); try { rmSync(work, { recursive: true, force: true }); } catch { /* the OS reclaims temp */ } }
    const found = { csv: legacy.filter((t) => t.source !== "basiq").length, basiq: legacy.filter((t) => t.source === "basiq").length };
    const converted = convertLegacyRows(legacy, accounts, (label) => store.salted(label));
    const base = { present: true, found, skipped: converted.skipped, backupDir, manualBackup };
    if (!options.apply) return { ...base, applied: false, inserted: 0, unchanged: 0, migratedAt: store.legacyMigratedAt() };
    const result = store.importLegacyRows(SHARED_LEDGER, converted.rows, options.actor ?? "usman");
    return { ...base, applied: true, inserted: result.inserted, unchanged: result.unchanged, migratedAt: store.legacyMigratedAt() };
  } finally {
    if (ownsStore) store.close();
  }
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
  const root = arg("root");
  if (!root) { console.error("Usage: bun scripts/finance/legacy-migration.ts --root <AgenticOS folder> [--apply] [--actor usman]"); process.exit(2); }
  let r: LegacyMigrationResult;
  try { r = migrateLegacyFinance({ root, apply: process.argv.includes("--apply"), force: process.argv.includes("--force"), actor: arg("actor") }); }
  catch (error) {
    if (error instanceof LegacyMigrationRefused) { console.error("Already migrated. Re-running changes nothing, but needs --force to confirm."); process.exit(3); }
    throw error;
  }
  // Counts only.
  console.log(JSON.stringify({ present: r.present, applied: r.applied, found: r.found, skipped: r.skipped, inserted: r.inserted, unchanged: r.unchanged, backupDir: r.backupDir, migratedAt: r.migratedAt }, null, 2));
}
