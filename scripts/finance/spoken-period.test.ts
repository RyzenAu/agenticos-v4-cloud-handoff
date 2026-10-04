// AUDIT-F2 FIN-1: "how much came in last month" was answered with this month's figure. Periods are
// parsed once (spoken-period.ts) and every finance voice path answers for the period asked about,
// saying which. SYNTHETIC data only.
import { describe, expect, test } from "bun:test";
import { parseSpokenPeriod, resolveSpokenPeriod } from "./spoken-period";
import { matchFinanceIntent } from "./jarvis-intent";
import { matchManualFinanceQuestion } from "./manual-jarvis";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { buildNabCsv } from "./manual-fixtures";
import { answerFinance, financeIntent } from "../jarvis-skills/finance";

const TODAY = "2026-09-28"; // a Monday

describe("parse and resolve", () => {
  const r = (text: string) => { const p = parseSpokenPeriod(text); return p && resolveSpokenPeriod(p, TODAY); };
  test("month, week and day words", () => {
    expect(r("how much came in last month")).toEqual({ from: "2026-08-01", to: "2026-08-31", label: "last month (August 2026)" });
    expect(r("how much came in this month")).toEqual({ from: "2026-09-01", to: TODAY, label: "this month" });
    expect(r("what did we spend last week")).toEqual({ from: "2026-09-21", to: "2026-09-27", label: "last week (21 Sep 2026 to 27 Sep 2026)" });
    expect(r("income this week")).toEqual({ from: "2026-09-22", to: TODAY, label: "the last 7 days" });
    expect(r("what came in yesterday")?.from).toBe("2026-09-27");
    expect(r("revenue today")).toEqual({ from: TODAY, to: TODAY, label: "today" });
    expect(r("spend over the last 14 days")).toMatchObject({ from: "2026-09-15", to: TODAY });
    expect(r("the past thirty days")).toMatchObject({ from: "2026-08-30" });
    expect(r("last fortnight")).toMatchObject({ from: "2026-09-15" });
  });
  test("Australian financial year runs 1 July to 30 June", () => {
    expect(r("how much came in this financial year")).toEqual({ from: "2026-07-01", to: TODAY, label: "this financial year (from 1 Jul 2026)" });
    expect(r("revenue last financial year")).toEqual({ from: "2025-07-01", to: "2026-06-30", label: "last financial year (2025–26)" });
    const may = parseSpokenPeriod("this FY")!;
    expect(resolveSpokenPeriod(may, "2026-05-10")).toMatchObject({ from: "2025-07-01", to: "2026-05-10" });
    expect(r("this calendar year")).toMatchObject({ from: "2026-01-01" });
    expect(r("last year")).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
  });
  test("named months are their most recent occurrence; January's last month is last December", () => {
    expect(r("how much did we spend in August")).toEqual({ from: "2026-08-01", to: "2026-08-31", label: "in August 2026" });
    expect(r("what came in in November")).toMatchObject({ from: "2025-11-01", to: "2025-11-30" });
    expect(r("revenue for sept")).toMatchObject({ from: "2026-09-01", to: TODAY });
    expect(resolveSpokenPeriod({ kind: "last-month" }, "2026-01-05")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });
  test("no named period is null (callers default to this month)", () => {
    expect(parseSpokenPeriod("how much did we make")).toBeNull();
  });
});

describe("intents keep the period and strip it from categories", () => {
  test("income and spend", () => {
    expect(matchFinanceIntent("how much came in last month")).toEqual({ kind: "income-month", period: { kind: "last-month" } });
    expect(matchFinanceIntent("How much came in this financial year?")).toEqual({ kind: "income-month", period: { kind: "this-fy" } });
    expect(matchFinanceIntent("what did we spend last week")).toMatchObject({ period: { kind: "last-week" } });
    expect(matchFinanceIntent("how much did we spend on software last month")).toEqual({ kind: "spend-category", category: "software", period: { kind: "last-month" } });
    expect(matchFinanceIntent("what did I spend on software")).toEqual({ kind: "spend-category", category: "software" });
    expect(matchManualFinanceQuestion("what did tools cost last financial year", TODAY)).toEqual({ kind: "tools", period: { from: "2025-07-01", to: "2026-06-30" } });
    expect(matchManualFinanceQuestion("cash flow last month")).toEqual({ kind: "cash", period: "last-month" });
  });
});

describe("answers: the period asked about, said out loud", () => {
  // August and September imported, as in the audit: August cash in A$1,970.00; September A$825.00.
  const store = () => {
    const s = openManualFinanceStore(":memory:", { now: () => new Date("2026-09-28T01:00:00Z") });
    s.importCsv(SHARED_LEDGER, buildNabCsv([
      { date: "01 Aug 26", amount: "1500.00", type: "TRANSFER CREDIT", details: "SYNTH CLIENT A" },
      { date: "15 Aug 26", amount: "470.00", type: "TRANSFER CREDIT", details: "SYNTH CLIENT B" },
      { date: "20 Aug 26", amount: "-45.00", type: "EFTPOS DEBIT", details: "V0000 RETELL AI USD 30.00", merchant: "Retell AI" },
      { date: "01 Sep 26", amount: "825.00", type: "TRANSFER CREDIT", details: "SYNTH CLIENT C" },
      { date: "27 Sep 26", amount: "-5.00", type: "EFTPOS DEBIT", details: "SYNTH CAFE", merchant: "Synth Cafe" },
    ]), "test");
    return s;
  };
  const ask = async (q: string) => answerFinance(financeIntent(q)!, { root: "", manualStore: store(), today: TODAY });
  test("last month is August's A$1,970.00, not September's A$825.00", async () => {
    const said = await ask("how much came in last month");
    expect(said).toContain("$1,970.00 came in last month (August 2026)");
    expect(said).not.toContain("825");
  });
  test("this month, this financial year and a category over last month", async () => {
    expect(await ask("how much came in this month")).toContain("$825.00 came in this month");
    expect(await ask("how much came in this financial year")).toContain("$2,795.00 came in this financial year (from 1 Jul 2026)");
    const tools = await ask("how much did we spend on software last month");
    expect(tools).toContain("last month (August 2026)");
    expect(tools).toContain("$45.00");
    expect(tools).not.toContain('not by "software last month"');
  });
});

describe("review R7: bank-cash intents don't take package, price or unrelated questions", () => {
  test("non-finance questions are not bank answers", () => {
    for (const q of ["what does the professional package cost", "how much do we make on professional", "what should I make for dinner", "what did the client say about the cost", "what's the cost of retell per minute", "what's the price of premium"])
      expect(matchFinanceIntent(q)).toBeUndefined();
  });
  test("real cash questions still match, with or without the generic forms", () => {
    expect(matchFinanceIntent("how much came in last month")).toMatchObject({ kind: "income-month" });
    expect(matchFinanceIntent("how much money did we make")).toMatchObject({ kind: "income-month" });
    expect(matchFinanceIntent("how much did we spend in August")).toMatchObject({ kind: "spend-month", period: { kind: "named-month", month: 8 } });
    expect(matchFinanceIntent("what did we spend on software last month")).toMatchObject({ kind: "spend-category", category: "software" });
  });
});
