// Jarvis and memory get sourced summaries only: period totals with source and as-of; never rows.
import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { syntheticSeptemberCsv, SYNTHETIC_ACCOUNT, SYNTHETIC_SEPTEMBER } from "./manual-fixtures";
import { sourcedFinanceSummaries, sourcedSummaryText } from "./manual-sourced";
import { businessMemoryDocuments, businessEvidence, financeMemoryDocument } from "../business-memory";

const seeded = () => { const s = openManualFinanceStore(":memory:"); s.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "test"); return s; };

test("a sourced summary carries the source, the as-of date and period totals, and nothing row-level", () => {
  const store = seeded();
  const [last, current] = sourcedFinanceSummaries({ store, today: "2026-09-27" })!;
  expect(current).toMatchObject({
    kind: "finance-sourced-summary/v1",
    source: { name: "NAB CSV import", store: "finance-manual.sqlite", statement: "NAB CSV imported, as of 26 Sep 2026", asOf: "2026-09-26", live: false },
    period: { label: "This month", from: "2026-09-01", to: "2026-09-27" }, coverage: "full", covered: [{ from: "2026-09-01", to: "2026-09-27" }], note: null,
    totals: { cashInCents: 82500, cashOutCents: 29804, netOperatingCents: 52696, refundsInCents: 1240, toolsCents: 22965 },
    pendingCount: 1,
  });
  expect(last).toMatchObject({ period: { label: "Last month" }, coverage: "none", totals: null }); // unknown, not zero
  const json = JSON.stringify([last, current]);
  expect(json).not.toMatch(/acct-|nab-[0-9a-f]|k-[0-9a-f]|t-[0-9a-f]|Retell|Officeworks|Vercel|vendor/i);
  expect(json).not.toContain(SYNTHETIC_ACCOUNT);
  for (const l of SYNTHETIC_SEPTEMBER) expect(json).not.toContain(l.details);
  store.close();
});

test("the memory text says where the numbers came from and that unknown periods are unknown", () => {
  const store = seeded();
  const text = sourcedSummaryText(sourcedFinanceSummaries({ store, today: "2026-09-27" })!);
  expect(text).toContain("Source: NAB CSV import (finance-manual.sqlite). NAB CSV imported, as of 26 Sep 2026");
  expect(text).toContain("Not a live bank feed.");
  expect(text).toContain("- Last month (2026-08-01 to 2026-08-31): no data. No imported NAB data covers it, so its figures are unknown, not zero.");
  expect(text).toContain("- This month (2026-09-01 to 2026-09-27): cash in $825.00; cash out $298.04; net operating $526.96");
  expect(text).not.toMatch(/Retell|Officeworks|acct-|00-000/);
  store.close();
});

test("a custom range says its dates once, and a named period keeps its dates (REVIEW-FINANCE R2)", () => {
  const store = seeded();
  const range = sourcedFinanceSummaries({ store, today: "2026-09-27", periods: [{ from: "2026-09-10", to: "2026-09-26" }, { month: "2026-09" }, "last-month"] })!;
  const text = sourcedSummaryText(range);
  expect(text).toContain("- 2026-09-10 to 2026-09-26: cash in");
  expect(text).not.toContain("2026-09-10 to 2026-09-26 (2026-09-10 to 2026-09-26)");
  expect(text).toContain("- 2026-09 (2026-09-01 to 2026-09-30)");
  expect(text).toContain("- Last month (2026-08-01 to 2026-08-31): no data.");
  store.close();
});

test("nothing imported: no summaries, and the finance store is not created just to say so", () => {
  const root = mkdtempSync(join(tmpdir(), "finance-sourced-"));
  expect(sourcedFinanceSummaries({ root, today: "2026-09-27" })).toBeNull();
  expect(existsSync(join(root, ".operator-data"))).toBe(false);
  expect(sourcedFinanceSummaries({ store: openManualFinanceStore(":memory:") })).toBeNull();
});

test("business memory: balances never become memory rows; only the sourced summary does", () => {
  const store = seeded();
  const workspace = { finances: { accounts: [{ name: "Finance fixture", balance: 9876, currency: "USD", sourceId: "acct-9999" }], recordedAt: "2026-09-15T00:00:00.000Z", sourceLabel: "Mercury", monthlyIncome: { amount: 4321, currency: "USD", days: 30, transactions: 3, recordedAt: "2026-09-15" } } };
  const docs = businessMemoryDocuments(workspace, { finance: () => sourcedFinanceSummaries({ store, today: "2026-09-27" }) });
  const finance = docs.find((d) => d.id === "finances")!;
  expect(finance.title).toBe("Finance summary (sourced)");
  expect(finance.text).toContain("NAB CSV imported, as of 26 Sep 2026");
  expect(finance.text).toContain("Observed account balances exist in Finance (source: Mercury, recorded 2026-09-15). The figures stay in Finance");
  expect(finance.text).not.toMatch(/9876|4321|Finance fixture|acct-9999/);
  // Without any finance source there is no finance document at all (and the old one is retracted by the caller).
  expect(businessMemoryDocuments({ snapshots: [] })).toEqual([]);
  expect(financeMemoryDocument({}, null)).toBeNull();
  expect(financeMemoryDocument(workspace, null)!.text).toContain("No NAB CSV imported: bank cash flow is unknown, not zero.");
  // A failing finance source says nothing rather than guessing.
  expect(businessMemoryDocuments({}, { finance: () => { throw new Error("locked"); } })).toEqual([]);
  expect(businessEvidence(workspace)).toMatchObject({ finances: { measurement: "account_balances", inMemory: "source and date only; figures stay in Finance" }, bankCashFlow: { live: false } });
  store.close();
});
