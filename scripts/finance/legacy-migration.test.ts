// Migration of the retired legacy finance.sqlite NAB rows into finance-manual.sqlite. SYNTHETIC
// legacy stores built in temp roots with the legacy store's own writers; no real data.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyMigrationRefused, legacyNabRowCount, migrateLegacyFinance } from "./legacy-migration";
import { SHARED_LEDGER, manualFinanceDbPath, openManualFinanceStore } from "./manual-store";
import { financeDbPath, openFinanceDb, upsertAccounts, upsertTransactions } from "./store";
import { buildNabCsv, SYNTHETIC_ACCOUNT } from "./manual-fixtures";
import { summary } from "./manual-summary";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "finance-legacy-migration-")); dirs.push(d); return d; };
afterAll(() => { Bun.gc(true); for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } } });
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const at = (day: string) => new Date(Date.parse(`2026-09-${day}T00:00:00+10:00`)).toISOString(); // Sydney midnight, as csv-import.ts stored it

/** A legacy store as the retired csv-import.ts + Basiq sync left it. */
function legacyRoot() {
  const root = temp();
  const db = openFinanceDb(financeDbPath(root));
  const account = `nab-csv:${SYNTHETIC_ACCOUNT}`;
  upsertAccounts(db, [{ id: account, name: "NAB · synthetic", accountNo: SYNTHETIC_ACCOUNT, balance: 1000, availableFunds: null, currency: "AUD", institutionId: "AU00NAB", connectionId: "nab-csv", status: "available", lastUpdated: at("05") }], "nab-csv");
  const tx = (id: string, amount: number, description: string, day: string, cls = "EFTPOS DEBIT") =>
    ({ id, accountId: account, connectionId: "nab-csv", amount, direction: amount < 0 ? "debit" as const : "credit" as const, description, postDate: at(day), transactionDate: at(day), status: "posted", class: cls });
  upsertTransactions(db, [
    tx("nab-csv:a", -31.25, "V0000 VERCEL INC USD 20.00 · Vercel", "03"),
    tx("nab-csv:b", -12, "SYNTH CAFE · Synth Cafe", "04"),
    tx("nab-csv:c", 825, "SYNTHETIC CLIENT DEPOSIT", "05", "TRANSFER CREDIT"),
  ], "nab-csv");
  upsertTransactions(db, [{ id: "basiq-1", accountId: "basiq-acct", connectionId: "c1", amount: -9.99, direction: "debit", description: "OPENAI CHATGPT", postDate: at("06"), transactionDate: at("06"), status: "posted", class: "payment" }], "basiq");
  db.exec("CREATE TABLE IF NOT EXISTS stripe_payouts (id TEXT PRIMARY KEY)"); // Stripe shares the file; it must stay
  db.close();
  return root;
}

test("no legacy store: nothing to do, nothing created", () => {
  const root = temp();
  const r = migrateLegacyFinance({ root, apply: true });
  expect(r).toMatchObject({ present: false, applied: false, found: { csv: 0, basiq: 0 }, backupDir: null });
  expect(legacyNabRowCount(root)).toBe(0); // the Finance page offers nothing
  expect(legacyNabRowCount(legacyRoot())).toBe(4);
  expect(existsSync(financeDbPath(root))).toBe(false);
});

test("dry run reads a temporary copy, reports counts and writes nothing (no backup, no rows)", () => {
  const root = legacyRoot();
  const before = sha(financeDbPath(root));
  const r = migrateLegacyFinance({ root, now: () => new Date("2026-09-28T01:00:00Z") });
  expect(r).toMatchObject({ present: true, applied: false, found: { csv: 3, basiq: 1 }, skipped: 0, inserted: 0 });
  expect(r.backupDir).toBeNull();
  expect(existsSync(join(root, ".operator-data", "backups"))).toBe(false);
  expect(sha(financeDbPath(root))).toBe(before); // the original is never changed
  const store = openManualFinanceStore(manualFinanceDbPath(root));
  expect(store.count(SHARED_LEDGER)).toBe(0);
  store.close();
  expect(JSON.stringify(r)).not.toMatch(/VERCEL|SYNTH CAFE|00-000-0000|825/); // counts only
});

test("apply migrates once into the shared ledger, keeps the old file, and a later CSV import completes the rows without double-counting", () => {
  const root = legacyRoot();
  const before = sha(financeDbPath(root));
  let tick = 0;
  const now = () => new Date(Date.parse("2026-09-28T01:00:00Z") + (tick++) * 1000);
  const r = migrateLegacyFinance({ root, apply: true, actor: "usman", now });
  expect(r).toMatchObject({ present: true, applied: true, found: { csv: 3, basiq: 1 }, inserted: 4, unchanged: 0 });
  expect(existsSync(r.manualBackup!)).toBe(true);
  expect(sha(join(r.backupDir!, "finance.sqlite"))).toBe(before); // the backup is a pristine byte copy (review #5)
  expect(sha(financeDbPath(root))).toBe(before);
  expect(existsSync(financeDbPath(root))).toBe(true); // never deleted: Stripe tables live there too
  // A re-run is refused unless forced; forced, it changes nothing.
  expect(() => migrateLegacyFinance({ root, apply: true, actor: "usman", now })).toThrow(LegacyMigrationRefused);
  expect(migrateLegacyFinance({ root, apply: true, force: true, actor: "usman", now })).toMatchObject({ inserted: 0, unchanged: 4 });

  const store = openManualFinanceStore(manualFinanceDbPath(root));
  try {
    const rows = store.rows(SHARED_LEDGER);
    expect(rows.map((x) => [x.origin, x.keyStrength, x.date, x.amountCents, x.vendorId]).sort()).toEqual([
      ["legacy-basiq", "loose", "2026-09-06", -999, "openai"],
      ["legacy-csv", "loose", "2026-09-03", -3125, "vercel"],
      ["legacy-csv", "loose", "2026-09-04", -1200, "m-synth-cafe"],
      ["legacy-csv", "loose", "2026-09-05", 82500, "incoming-payments"],
    ]);
    expect(store.audit(SHARED_LEDGER).filter((a) => a.action === "migrate-legacy").map((a) => [a.actor, a.rowsInFile, a.inserted, a.unchanged])).toEqual([["usman", 4, 0, 4], ["usman", 4, 4, 0]]);
    // A correction made on a migrated row follows it when the NAB CSV row replaces it.
    const cafe = rows.find((x) => x.vendorId === "m-synth-cafe")!;
    store.setTxOverride(SHARED_LEDGER, cafe.id, { scope: "personal" }, "mehroz");
    const csv = buildNabCsv([
      { date: "03 Sep 26", amount: "-31.25", type: "EFTPOS DEBIT", details: "V0000 VERCEL INC USD 20.00", merchant: "Vercel" },
      { date: "04 Sep 26", amount: "-12.00", type: "EFTPOS DEBIT", details: "SYNTH CAFE", merchant: "Synth Cafe" },
      { date: "05 Sep 26", amount: "825.00", type: "TRANSFER CREDIT", details: "SYNTHETIC CLIENT DEPOSIT" },
      { date: "07 Sep 26", amount: "-5.00", type: "EFTPOS DEBIT", details: "SYNTH NEW", merchant: "Synth New" },
    ]);
    expect(store.importCsv(SHARED_LEDGER, csv, "picker", { actor: "usman" })).toMatchObject({ upgraded: 3, inserted: 1 });
    const after = store.rows(SHARED_LEDGER);
    expect(after).toHaveLength(5); // 3 legacy rows completed in place + the Basiq row + 1 new
    expect(after.filter((x) => x.origin === "legacy-csv")).toHaveLength(0);
    expect(after.find((x) => x.vendorId === "m-synth-cafe")).toMatchObject({ keyStrength: "strong", scope: "personal", edited: { scope: { by: "mehroz" } } });
    expect(summary(SHARED_LEDGER, "all", { store, today: "2026-09-28" })).toMatchObject({ cashInCents: 82500, cashOutCents: 3125 + 1200 + 500 + 999 });
  } finally { store.close(); }
  // REVIEW-FINANCE M2: re-running the migration AFTER a CSV completed the legacy rows never brings them back.
  const again = migrateLegacyFinance({ root, apply: true, force: true, actor: "usman", now });
  expect(again).toMatchObject({ inserted: 0, unchanged: 4 });
  const check = openManualFinanceStore(manualFinanceDbPath(root));
  try {
    expect(check.count(SHARED_LEDGER)).toBe(5);
    expect(summary(SHARED_LEDGER, "all", { store: check, today: "2026-09-28" })).toMatchObject({ cashInCents: 82500, cashOutCents: 3125 + 1200 + 500 + 999 });
  } finally { check.close(); }
});

test("a CSV imported BEFORE the migration still covers the legacy rows (a strong row that settled a pending one included)", () => {
  const root = legacyRoot();
  const store = openManualFinanceStore(manualFinanceDbPath(root));
  try {
    // The café charge arrives pending first, then posted: the posted row supersedes the pending one.
    store.importCsv(SHARED_LEDGER, buildNabCsv([{ date: "04 Sep 26", amount: "-12.00", type: "EFTPOS DEBIT", details: "SYNTH CAFE", merchant: "Synth Cafe", processedOn: null }]), "test");
    store.importCsv(SHARED_LEDGER, buildNabCsv([
      { date: "03 Sep 26", amount: "-31.25", type: "EFTPOS DEBIT", details: "V0000 VERCEL INC USD 20.00", merchant: "Vercel" },
      { date: "04 Sep 26", amount: "-12.00", type: "EFTPOS DEBIT", details: "SYNTH CAFE", merchant: "Synth Cafe" },
      { date: "05 Sep 26", amount: "825.00", type: "TRANSFER CREDIT", details: "SYNTHETIC CLIENT DEPOSIT" },
    ]), "test");
    const r = migrateLegacyFinance({ root, apply: true, actor: "usman", store });
    expect(r).toMatchObject({ inserted: 1, unchanged: 3 }); // only the Basiq row (another account) is new
    expect(store.count(SHARED_LEDGER)).toBe(4);
  } finally { store.close(); }
});
