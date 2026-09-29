import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_LEDGER, manualFinanceDbPath, openManualFinanceStore } from "./manual-store";
import { buildNabCsv, SYNTHETIC_SEPTEMBER, syntheticSeptemberCsv, type SyntheticLine } from "./manual-fixtures";
import { NabCsvRejected } from "./manual-nab-csv";

const dir = mkdtempSync(join(tmpdir(), "finance-manual-test-"));
// Windows can keep a closed bun:sqlite file pinned until GC; a leftover temp dir is harmless.
afterAll(() => { Bun.gc(true); try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });
const fresh = (name: string) => openManualFinanceStore(join(dir, `${name}.sqlite`), { now: () => new Date("2026-09-27T09:00:00Z") });

describe("manual finance store", () => {
  test("default path is a new file beside, not inside, the legacy finance.sqlite", () => {
    expect(manualFinanceDbPath("/repo").replace(/\\/g, "/")).toBe("/repo/.operator-data/finance-manual.sqlite");
  });

  test("re-importing the same export changes zero rows", () => {
    const s = fresh("idempotent");
    const first = s.importCsv("usman", syntheticSeptemberCsv(), "test");
    expect(first).toMatchObject({ rowsInFile: 24, inserted: 24, unchanged: 0, reconciled: 0, accounts: 2 });
    const before = JSON.stringify(s.rows("usman"));
    const again = s.importCsv("usman", syntheticSeptemberCsv(), "drop");
    expect(again).toMatchObject({ inserted: 0, unchanged: 24, reconciled: 0 });
    expect(JSON.stringify(s.rows("usman"))).toBe(before);
    s.close();
  });

  test("an overlapping export adds only the new rows", () => {
    const s = fresh("overlap");
    s.importCsv("usman", buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 15)), "test");
    // Second export overlaps rows 10..14 with identical running balances (same opening balance).
    const r = s.importCsv("usman", buildNabCsv(SYNTHETIC_SEPTEMBER), "test");
    expect(r).toMatchObject({ inserted: 9, unchanged: 15 });
    expect(s.count("usman")).toBe(24);
    s.close();
  });

  test("pending → posted reconciles to one row, and a stale pending never regresses it", () => {
    const s = fresh("pending");
    const pending: SyntheticLine = { date: "27 Sep 26", amount: "-21.43", type: "EFTPOS DEBIT", details: "TWILIO SENDGRID", merchant: "Twilio", processedOn: null };
    const posted: SyntheticLine = { date: "27 Sep 26", amount: "-21.43", type: "EFTPOS DEBIT", details: "V0000 27/09 TWILIO SENDGRID SAN FRANCISCO USD 15.04", merchant: "Twilio", processedOn: "28 Sep 26" };
    const older = buildNabCsv([pending]), newer = buildNabCsv([posted]);
    expect(s.importCsv("usman", older, "test")).toMatchObject({ inserted: 1 });
    expect(s.rows("usman")[0].status).toBe("pending");
    expect(s.importCsv("usman", newer, "test")).toMatchObject({ inserted: 0, reconciled: 1 });
    const rows = s.rows("usman");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "posted", processedOn: "2026-09-28", vendorId: "twilio" });
    expect(s.importCsv("usman", older, "test")).toMatchObject({ inserted: 0, reconciled: 0, unchanged: 1 });
    expect(s.importCsv("usman", newer, "test")).toMatchObject({ inserted: 0, unchanged: 1 });
    expect(s.count("usman")).toBe(1);
    s.close();
  });

  test("a posted row imported BEFORE its older pending export still wins", () => {
    const s = fresh("reverse");
    s.importCsv("usman", buildNabCsv([{ date: "20 Sep 26", amount: "-30.00", type: "EFTPOS DEBIT", details: "OPENAI", processedOn: "21 Sep 26" }]), "test");
    const r = s.importCsv("usman", buildNabCsv([{ date: "20 Sep 26", amount: "-30.00", type: "EFTPOS DEBIT", details: "OPENAI *PENDING", processedOn: null }]), "test");
    expect(r).toMatchObject({ inserted: 0, stalePendingSkipped: 1 });
    expect(s.rows("usman").map((x) => x.status)).toEqual(["posted"]);
    s.close();
  });

  test("owners are isolated", () => {
    const s = fresh("owners");
    s.importCsv("usman", syntheticSeptemberCsv(), "test");
    expect(s.count("mehroz")).toBe(0);
    expect(s.rows("mehroz")).toEqual([]);
    expect(s.audit("mehroz")).toEqual([]);
    s.importCsv("mehroz", buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 2)), "test");
    expect(s.count("mehroz")).toBe(2);
    expect(s.clear("mehroz")).toMatchObject({ deleted: 2 });
    expect(s.count("usman")).toBe(24);
    for (const bad of ["", "Usman", "../x", "a".repeat(41), "usman;drop"]) expect(() => s.rows(bad)).toThrow("INVALID_OWNER");
    s.close();
  });

  test("malformed files are rejected atomically and logged by code only", () => {
    const s = fresh("atomic");
    s.importCsv("usman", syntheticSeptemberCsv(), "test");
    const before = JSON.stringify(s.rows("usman"));
    const bad = syntheticSeptemberCsv().replace("26 Sep 26,-55.00", "26 Sep 26,-55.0.0");
    expect(() => s.importCsv("usman", bad, "drop")).toThrow(NabCsvRejected);
    expect(JSON.stringify(s.rows("usman"))).toBe(before);
    expect(s.audit("usman")[0]).toMatchObject({ action: "import-rejected", code: "BAD_AMOUNT", inserted: 0 });
    expect(() => s.importCsv("usman", syntheticSeptemberCsv(), "folder-scan" as never)).toThrow("OWNER_ACTION_REQUIRED");
    s.close();
  });

  test("persists across reopen; clear-all really deletes and keeps a counts-only audit", () => {
    const file = join(dir, "persist.sqlite");
    let s = openManualFinanceStore(file);
    s.importCsv("usman", syntheticSeptemberCsv(), "picker");
    s.close();
    s = openManualFinanceStore(file);
    expect(s.count("usman")).toBe(24);
    expect(s.lastImportAt("usman")).not.toBeNull();
    expect(readFileSync(file).includes("Higgsfield")).toBe(true);
    const cleared = s.clear("usman");
    expect(cleared).toMatchObject({ deleted: 24 });
    expect(openManualFinanceStore(cleared.backup!).count("usman")).toBe(24); // backed up before the delete
    expect(s.count("usman")).toBe(0);
    expect(s.lastImportAt("usman")).toBeNull();
    const audit = s.audit("usman");
    expect(audit[0]).toMatchObject({ action: "clear", deleted: 24 });
    expect(audit[1]).toMatchObject({ action: "import", via: "picker", rowsInFile: 24, inserted: 24 });
    expect(Object.keys(audit[0]).sort()).toEqual(["action", "actor", "asOf", "at", "code", "deleted", "format", "id", "inserted", "reclassified", "reconciled", "rowsInFile", "unchanged", "upgraded", "via", "warnings"]);
    expect(audit[1]).toMatchObject({ asOf: "2026-09-26", format: "nab-ib" });
    s.close();
    const bytes = readFileSync(file);
    for (const label of ["Higgsfield", "Officeworks", "Retell AI", "acct-"]) expect(bytes.includes(label)).toBe(false);
    expect(bytes.toString("latin1")).not.toMatch(/nab-[0-9a-f]{32}|k-[0-9a-f]{32}|t-[0-9a-f]{32}/); // row ids and keys are gone too
  });
});
