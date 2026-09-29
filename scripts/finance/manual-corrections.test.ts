// Stage F finance: overlap dedupe, corrections that survive re-imports, provenance and the one
// shared business ledger. SYNTHETIC data only (manual-fixtures.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { buildNabCsv, SYNTHETIC_SEPTEMBER, syntheticSeptemberCsv, type SyntheticLine } from "./manual-fixtures";
import { NabCsvRejected } from "./manual-nab-csv";

const dir = mkdtempSync(join(tmpdir(), "finance-corrections-test-"));
afterAll(() => { Bun.gc(true); try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });
const L = SHARED_LEDGER;
const mem = () => openManualFinanceStore(":memory:", { now: () => new Date("2026-09-27T09:00:00Z") });
const line = (over: Partial<SyntheticLine>): SyntheticLine => ({ date: "03 Sep 26", amount: "-31.25", type: "EFTPOS DEBIT", details: "V0000 VERCEL INC USD 20.00", merchant: "Vercel", category: "Software", ...over });

describe("overlap dedupe: a stable key plus the running balance", () => {
  test("an overlapping export adds only the new rows", () => {
    const s = mem();
    expect(s.importCsv(L, buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 15)), "test")).toMatchObject({ inserted: 15 });
    expect(s.importCsv(L, buildNabCsv(SYNTHETIC_SEPTEMBER.slice(10)), "test").inserted).toBeGreaterThan(0);
    expect(s.importCsv(L, syntheticSeptemberCsv(), "test")).toMatchObject({ inserted: 0, unchanged: 24 });
    expect(s.count(L)).toBe(24);
    s.close();
  });

  test("NAB re-wording details and re-categorising between exports never double-counts", () => {
    const s = mem();
    s.importCsv(L, syntheticSeptemberCsv(), "test");
    const reworded = buildNabCsv(SYNTHETIC_SEPTEMBER.map((l) => ({ ...l, details: `${l.details} ENRICHED`, category: "Recategorised" })));
    const r = s.importCsv(L, reworded, "test");
    expect(r).toMatchObject({ inserted: 0, unchanged: 24 });
    expect(r.reclassified).toBeGreaterThan(0); // NAB's new category is kept as the base value
    expect(s.count(L)).toBe(24);
    s.close();
  });

  test("NAB re-ordering a day's rows (so their running balances move) never double-counts", () => {
    const s = mem();
    const day = [line({}), line({ amount: "-12.00", details: "SYNTH CAFE", merchant: "Synth Cafe", category: "Food" })];
    s.importCsv(L, buildNabCsv(day), "test");
    expect(s.importCsv(L, buildNabCsv([day[1], day[0]]), "test")).toMatchObject({ inserted: 0, unchanged: 2 });
    expect(s.count(L)).toBe(2);
    // The stored rows now carry the new balances' keys, so the next export in that order matches by key.
    expect(s.importCsv(L, buildNabCsv([day[1], day[0]]), "test")).toMatchObject({ inserted: 0, unchanged: 2 });
    s.close();
  });

  test("identical charges on one day are two rows, and stay two through overlapping exports", () => {
    const s = mem();
    const coffee = line({ amount: "-5.00", details: "SYNTH CAFE", merchant: "Synth Cafe" });
    expect(s.importCsv(L, buildNabCsv([coffee, coffee]), "test")).toMatchObject({ inserted: 2 });
    expect(s.importCsv(L, buildNabCsv([coffee, coffee, line({ date: "04 Sep 26" })]), "test")).toMatchObject({ inserted: 1, unchanged: 2 });
    expect(s.count(L)).toBe(3);
    s.close();
  });

  test("preview says what an import would do and writes nothing", () => {
    const s = mem();
    s.importCsv(L, buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 15)), "test");
    const before = JSON.stringify(s.rows(L)), auditBefore = s.audit(L).length;
    const p = s.previewCsv(L, syntheticSeptemberCsv());
    expect(p).toMatchObject({ preview: true, rowsInFile: 24, inserted: 9, unchanged: 15, asOf: "2026-09-26", format: "nab-ib", warnings: 0 });
    expect(JSON.stringify(s.rows(L))).toBe(before);
    expect(s.audit(L)).toHaveLength(auditBefore);
    s.close();
  });

  test("a running-balance warning blocks the import until it is accepted, and is recorded", () => {
    const s = mem();
    const full = buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 8)).split("\r\n");
    const missing = [...full.slice(0, 4), ...full.slice(5)].join("\r\n");
    expect(() => s.importCsv(L, missing, "drop", { actor: "usman" })).toThrow(NabCsvRejected);
    expect(s.count(L)).toBe(0);
    expect(s.audit(L)[0]).toMatchObject({ action: "import-rejected", code: "BALANCE_MISMATCH", warnings: 1, actor: "usman" });
    expect(s.previewCsv(L, missing)).toMatchObject({ warnings: 1, inserted: 7 });
    expect(s.importCsv(L, missing, "drop", { actor: "usman", acceptWarnings: true })).toMatchObject({ inserted: 7, warnings: 1 });
    expect(s.audit(L)[0]).toMatchObject({ action: "import", warnings: 1, actor: "usman" });
    s.close();
  });
});

describe("corrections: kept with provenance, surviving re-imports", () => {
  test("a row correction survives re-importing the same and an overlapping, re-categorised export", () => {
    const s = mem();
    s.importCsv(L, buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 15)), "test");
    s.importCsv(L, syntheticSeptemberCsv(), "test");
    const officeworks = () => s.rows(L).find((r) => r.vendorId === "m-officeworks")!;
    expect(officeworks().scope).toBe("unreviewed");
    const edited = s.setTxOverride(L, officeworks().id, { scope: "personal", category: "Home office" }, "mehroz");
    expect(edited).toMatchObject({ scope: "personal", category: "Home office", base: { scope: "unreviewed", category: "Office supplies" } });
    expect(edited.edited.scope).toEqual({ by: "mehroz", source: "row", at: "2026-09-27T09:00:00.000Z" });
    s.importCsv(L, syntheticSeptemberCsv(), "picker");
    s.importCsv(L, buildNabCsv(SYNTHETIC_SEPTEMBER.map((l) => ({ ...l, category: "Recategorised" }))), "drop");
    expect(officeworks()).toMatchObject({ scope: "personal", category: "Home office", edited: { scope: { by: "mehroz" } } });
    expect(s.editLog(L).map((e) => [e.field, e.oldValue, e.newValue, e.actor, e.action]).sort()).toEqual([
      ["category", "Office supplies", "Home office", "mehroz", "set"], ["scope", "unreviewed", "personal", "mehroz", "set"],
    ]);
    s.close();
  });

  test("a correction on a pending row moves to the posted row that settles it", () => {
    const s = mem();
    const pending = line({ date: "27 Sep 26", processedOn: null, details: "SYNTH CONSULTANT", merchant: "Synth Consultant", amount: "-400.00" });
    s.importCsv(L, buildNabCsv([pending]), "test");
    s.setTxOverride(L, s.rows(L)[0].id, { scope: "business", category: "Contractors" }, "usman");
    expect(s.importCsv(L, buildNabCsv([{ ...pending, processedOn: "28 Sep 26" }]), "test")).toMatchObject({ reconciled: 1 });
    const rows = s.rows(L);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "posted", scope: "business", category: "Contractors", edited: { scope: { by: "usman" } } });
    expect(s.editLog(L)[0]).toMatchObject({ action: "carried", targetId: rows[0].id });
    s.close();
  });

  test("vendor rules apply to every row of a vendor, now and in later imports; a row correction wins", () => {
    const s = mem();
    const a = line({ date: "05 Sep 26", amount: "-45.99", details: "OFFICEWORKS 0000", merchant: "Officeworks", category: "Office supplies" });
    s.importCsv(L, buildNabCsv([a]), "test");
    s.setVendorOverride(L, "m-officeworks", { scope: "business", category: "Office" }, "usman");
    const b = line({ date: "19 Sep 26", amount: "-12.00", details: "OFFICEWORKS 0000", merchant: "Officeworks", category: "Office supplies" });
    s.importCsv(L, buildNabCsv([a, b]), "test");
    const rows = s.rows(L);
    expect(rows.map((r) => [r.scope, r.category, r.edited.scope?.source])).toEqual([["business", "Office", "vendor"], ["business", "Office", "vendor"]]);
    s.setTxOverride(L, rows[1].id, { scope: "personal" }, "mehroz");
    expect(s.rows(L).map((r) => r.scope)).toEqual(["business", "personal"]);
    expect(s.vendorOverrides(L).map((o) => [o.field, o.value, o.by])).toEqual([["category", "Office", "usman"], ["scope", "business", "usman"]]);
    s.close();
  });

  test("reverting restores NAB's value and is logged; invalid corrections change nothing", () => {
    const s = mem();
    s.importCsv(L, syntheticSeptemberCsv(), "test");
    const row = s.rows(L).find((r) => r.vendorId === "m-officeworks")!;
    s.setTxOverride(L, row.id, { kind: "transfer" }, "usman");
    expect(s.row(L, row.id)!.kind).toBe("transfer");
    s.setTxOverride(L, row.id, { kind: null }, "usman");
    expect(s.row(L, row.id)).toMatchObject({ kind: "ordinary", edited: {} });
    expect(s.editLog(L)[0]).toMatchObject({ field: "kind", oldValue: "transfer", newValue: "ordinary", action: "revert" });
    for (const [patch, code] of [[{ kind: "profit" }, "INVALID_VALUE"], [{ scope: "shared" }, "INVALID_VALUE"], [{ colour: "red" }, "INVALID_FIELD"], [{ category: "<script>" }, "INVALID_VALUE"]] as const)
      expect(() => s.setTxOverride(L, row.id, patch as never, "usman")).toThrow(code);
    expect(() => s.setTxOverride(L, `nab-${"0".repeat(32)}`, { scope: "business" }, "usman")).toThrow("UNKNOWN_TRANSACTION");
    expect(() => s.setTxOverride(L, row.id, { scope: "business" }, "Not An Id")).toThrow("INVALID_ACTOR");
    expect(s.row(L, row.id)).toMatchObject({ kind: "ordinary", scope: "unreviewed" });
    s.close();
  });

  test("a refund can be linked to its charge by hand; the link must point at a charge", () => {
    const s = mem();
    s.importCsv(L, syntheticSeptemberCsv(), "test");
    const rows = s.rows(L);
    const cafeRefund = rows.find((r) => r.kind === "refund")!;
    const charge = rows.find((r) => r.vendorId === "retell" && r.amountCents < 0)!;
    expect(() => s.setTxOverride(L, cafeRefund.id, { refundOf: cafeRefund.id }, "usman")).toThrow("INVALID_REFUND_LINK");
    expect(() => s.setTxOverride(L, charge.id, { refundOf: cafeRefund.id }, "usman")).toThrow("INVALID_REFUND_LINK");
    expect(s.setTxOverride(L, cafeRefund.id, { refundOf: charge.id }, "usman")).toMatchObject({ refundOf: charge.id, kind: "refund" });
    s.close();
  });

  test("clear deletes rows and row corrections; vendor rules (settings) stay", () => {
    const s = mem();
    s.importCsv(L, syntheticSeptemberCsv(), "test");
    s.setTxOverride(L, s.rows(L)[0].id, { scope: "personal" }, "usman");
    s.setVendorOverride(L, "m-officeworks", { scope: "business" }, "usman");
    expect(s.clear(L, "usman")).toMatchObject({ deleted: 24 });
    expect(s.editLog(L).every((e) => e.target === "vendor")).toBe(true);
    expect(s.vendorOverrides(L)).toHaveLength(1);
    expect(s.audit(L)[0]).toMatchObject({ action: "clear", actor: "usman", deleted: 24 });
    s.close();
  });
});

describe("one shared business ledger (V7)", () => {
  test("per-person ledgers fold into the shared one after a backup; imported-by stays as provenance", () => {
    const file = join(dir, "consolidate.sqlite");
    const s = openManualFinanceStore(file, { now: () => new Date("2026-09-27T09:00:00Z") });
    s.importCsv("usman", syntheticSeptemberCsv(), "picker");
    s.importCsv("mehroz", buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 3)), "drop"); // the same first three rows
    s.importCsv("mehroz", buildNabCsv([line({ date: "01 Oct 26", account: "00-000-0009", amount: "-9.00", details: "SYNTH ONLY MEHROZ", merchant: "Synth Only" })]), "drop");
    s.setTxOverride("usman", s.rows("usman").find((r) => r.vendorId === "m-officeworks")!.id, { scope: "business" }, "usman");
    const r = s.consolidateLedgers({ backupDir: join(dir, "backups"), stamp: "test" });
    expect(r).toMatchObject({ owners: ["mehroz", "usman"], moved: 25, duplicates: 3 });
    expect(existsSync(r.backup!)).toBe(true);
    const backup = openManualFinanceStore(r.backup!);
    expect(backup.count("usman")).toBe(24); // the backup is the file as it was
    backup.close();
    expect(s.count("usman") + s.count("mehroz")).toBe(0);
    expect(s.count(L)).toBe(25);
    expect(s.rows(L).find((x) => x.vendorId === "m-officeworks")).toMatchObject({ scope: "business", edited: { scope: { by: "usman" } } });
    expect(new Set(s.audit(L).map((a) => a.actor))).toEqual(new Set(["usman", "mehroz"]));
    expect(s.consolidateLedgers()).toEqual({ owners: [], moved: 0, duplicates: 0, backup: null });
    s.close();
  });
});
