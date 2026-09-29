import { describe, expect, test } from "bun:test";
import { openManualFinanceStore } from "./manual-store";
import { buildNabCsv, SYNTHETIC_SEPTEMBER, syntheticSeptemberCsv } from "./manual-fixtures";
import { matchRefunds, parsePeriodParam, resolvePeriod, summary } from "./manual-summary";
import { answerManualFinanceQuestion, matchManualFinanceQuestion } from "./manual-jarvis";

function seeded() {
  const store = openManualFinanceStore(":memory:");
  store.importCsv("usman", syntheticSeptemberCsv(), "test");
  return store;
}

describe("summary(owner, period) — WAVE2 contract", () => {
  const store = seeded();
  const s = summary("usman", "this-month", { store, today: "2026-09-27" });

  test("contract fields: source, asOf = latest posted date, cash flow not profit, no GST", () => {
    expect(s).toMatchObject({ source: "nab-csv-manual", owner: "usman", asOf: "2026-09-26", stale: false, daysSinceAsOf: 1,
      basis: "cash-flow", accountingProfit: null, gst: "not-inferred", currency: "AUD", rowCount: 24, accounts: 2 });
    expect(s.period).toEqual({ from: "2026-09-01", to: "2026-09-27", label: "This month" });
  });

  test("exact cash in/out with transfers, refunds and pending kept separate", () => {
    // The 412.50 Stripe payout is a transfer (Stripe revenue already counts it), not cash in.
    expect(s.cashInCents).toBe(82500);
    // Tools 235.00 + FX 7.05 + account fee 10.00 + Officeworks 45.99.
    expect(s.cashOutCents).toBe(23500 + 705 + 1000 + 4599);
    expect(s.netOperatingCents).toBe(s.cashInCents - s.cashOutCents);
    expect(s.transfers).toEqual({ inCents: 15000 + 41250, outCents: 15000, count: 3 });
    expect(s.stripePayouts).toEqual({ inCents: 41250, count: 1 });
    expect(s.refunds).toEqual({ inCents: 1240, outCents: 0, count: 1 });
    expect(s.pending).toEqual({ count: 1, inCents: 0, outCents: 2143, stale: 0 });
    // Own-account transfers net to zero; the Stripe payout is the only net transfer in.
    expect(s.netCashMovementCents).toBe(s.netOperatingCents + 1240 + 41250);
    expect(s.bankFeesCents).toBe(1000);
    expect(s.fxFees).toEqual({ totalCents: 705, count: 8, unattributedCents: 0 });
  });

  test("tools/subscriptions include attributed FX fees, net of refunds", () => {
    expect(s.tools.totalCents).toBe(23500 + 705 - 1240);
    expect(s.tools.vendors.map((v) => v.vendorId).sort()).toEqual(["anthropic", "elevenlabs", "higgsfield", "neon", "openai", "retell", "twilio", "vercel"]);
    expect(s.byVendor.find((v) => v.vendorId === "retell")).toMatchObject({ outCents: 3512, fxFeeCents: 105, refundCents: 1240, netCostCents: 2377, count: 1, tool: true });
    expect(s.byVendor.find((v) => v.vendorId === "stripe-payouts")).toBeUndefined(); // a transfer, not a vendor line
    expect(s.byVendor.find((v) => v.vendorId === "m-officeworks")).toMatchObject({ outCents: 4599, known: false, tool: false });
  });

  test("categories and daily series", () => {
    const cat = Object.fromEntries(s.byCategory.map((c) => [c.category, c]));
    expect(cat["voice-telephony"].outCents).toBe(3512 + 2143 + 1420);
    expect(cat["bank-fees"].outCents).toBe(1705);
    expect(s.daily).toHaveLength(27);
    expect(s.daily.reduce((n, d) => n + d.outCents, 0)).toBe(s.cashOutCents);
    expect(s.daily.reduce((n, d) => n + d.inCents, 0)).toBe(s.cashInCents);
  });

  test("stale when asOf is more than 7 days old; empty owners are honest", () => {
    expect(summary("usman", "all", { store, today: "2026-10-03" }).stale).toBe(false);
    expect(summary("usman", "all", { store, today: "2026-10-04" })).toMatchObject({ stale: true, daysSinceAsOf: 8 });
    expect(summary("usman", "all", { store, today: "2026-10-20" }).pending.stale).toBe(1);
    expect(summary("mehroz", "all", { store, today: "2026-09-27" })).toMatchObject({ rowCount: 0, asOf: null, stale: true, cashInCents: 0 });
    // A period no import covers is unknown, not zero: the summary says so, and so does Jarvis.
    expect(summary("usman", "last-month", { store, today: "2026-09-27" })).toMatchObject({ periodCoverage: "none", period: { from: "2026-08-01", to: "2026-08-31" } });
    // The September export covers 1–27 Sep for both accounts in it, so this month is fully covered.
    expect(summary("usman", "this-month", { store, today: "2026-09-27" })).toMatchObject({ periodCoverage: "full", coverage: { from: "2026-09-01", to: "2026-09-27" }, coverageNote: null });
    expect(summary("usman", { from: "2026-09-02", to: "2026-09-20" }, { store, today: "2026-09-27" }).periodCoverage).toBe("full");
    expect(answerManualFinanceQuestion({ kind: "cash", period: "last-month" }, summary("usman", "last-month", { store, today: "2026-09-27" })))
      .toBe("NAB CSV imported, as of 26 Sep 2026. I have no data for last month: no imported NAB data covers it, so it's unknown, not zero. Imported data covers 1 Sep 2026 – 27 Sep 2026. Import a CSV that includes it on the Finance page.");
  });

  test("an incoming TRANSFER CREDIT is income unless it mirrors an own-account transfer", () => {
    const st = openManualFinanceStore(":memory:");
    st.importCsv("usman", buildNabCsv([SYNTHETIC_SEPTEMBER[0], SYNTHETIC_SEPTEMBER[9], SYNTHETIC_SEPTEMBER[10]]), "test");
    const r = summary("usman", "all", { store: st, today: "2026-09-27" });
    expect(r.cashInCents).toBe(82500);
    expect(r.transfers).toEqual({ inCents: 15000, outCents: 15000, count: 2 });
  });

  test("periods", () => {
    expect(resolvePeriod({ month: "2026-02" }, "2026-09-27")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolvePeriod("last-30-days", "2026-09-27")).toMatchObject({ from: "2026-08-29", to: "2026-09-27" });
    expect(parsePeriodParam("2026-09-01..2026-09-10")).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(parsePeriodParam(null)).toBe("this-month");
    for (const bad of ["yesterday", "2026-13", "2026-09-10..2026-09-01"]) expect(() => resolvePeriod(parsePeriodParam(bad), "2026-09-27")).toThrow("INVALID_PERIOD");
  });
});

describe("Jarvis cost/margin answers (deterministic)", () => {
  const store = seeded();
  const ask = (q: string) => {
    const intent = matchManualFinanceQuestion(q);
    if (!intent) return null;
    return answerManualFinanceQuestion(intent, summary("usman", intent.period, { store, today: "2026-09-27" }));
  };
  test("intents", () => {
    expect(matchManualFinanceQuestion("How much did we spend on Retell this month?")).toEqual({ kind: "vendor", vendorId: "retell", period: "this-month" });
    expect(matchManualFinanceQuestion("what did claude cost us last month")).toEqual({ kind: "vendor", vendorId: "anthropic", period: "last-month" });
    expect(matchManualFinanceQuestion("what are our tool costs")).toEqual({ kind: "tools", period: "this-month" });
    expect(matchManualFinanceQuestion("how much in FX fees overall")).toEqual({ kind: "fx-fees", period: "all" });
    expect(matchManualFinanceQuestion("what's our margin on the receptionist")).toMatchObject({ kind: "margin" });
    expect(matchManualFinanceQuestion("cash flow this month")).toMatchObject({ kind: "cash" });
    expect(matchManualFinanceQuestion("play some music")).toBeNull();
  });
  test("answers quote exact aggregates only", () => {
    expect(ask("how much did we spend on retell")).toBe("NAB CSV imported, as of 26 Sep 2026. Retell AI this month: $35.12 across 1 charge, plus $1.05 in NAB international fees, less $12.40 refunded. Net $23.77.");
    expect(ask("tool costs this month")).toContain("$229.65 net, including $7.05 in NAB international fees");
    expect(ask("how much in international fees")).toBe("NAB CSV imported, as of 26 Sep 2026. NAB international transaction fees this month: $7.05 across 8 fees.");
    expect(ask("cash flow this month")).toContain("$825.00 came in and $298.04 went out, so net operating cash is $526.96");
    expect(ask("cash flow this month")).toContain("including $412.50 of Stripe payouts that Stripe revenue already counts");
    const margin = ask("what's our margin")!;
    expect(margin).toMatch(/Essential about \d+%/);
    expect(margin).toContain("not accounting profit");
    expect(margin).toContain("$229.65");
    expect(margin).toContain("$825.00 cash in (Stripe payouts left out: Stripe revenue already counts them)");
  });
  test("no data and stale data are said plainly", () => {
    const empty = openManualFinanceStore(":memory:");
    expect(answerManualFinanceQuestion({ kind: "tools", period: "this-month" }, summary("usman", "this-month", { store: empty, today: "2026-09-27" }))).toContain("No NAB CSV has been imported yet");
    expect(answerManualFinanceQuestion({ kind: "fx-fees", period: "all" }, summary("usman", "all", { store, today: "2026-10-20" }))).toStartWith("NAB CSV imported, as of 26 Sep 2026, 24 days ago, so newer spending isn't in it.");
  });
});

describe("transfers, refunds and business/personal scope", () => {
  test("own-account transfers are paired across accounts; the refund is matched to its original charge", () => {
    const store = seeded();
    const s = summary("usman", "all", { store, today: "2026-09-27" });
    expect(s.ownAccountTransfers).toEqual({ pairs: 1, cents: 15000 });
    expect(s.refundMatches).toEqual({ matched: 1, matchedCents: 1240, unmatched: 0, unmatchedCents: 0 });
    expect(s.review.unmatchedRefunds).toBe(0);
    expect(s.sourceLabel).toBe("NAB CSV imported, as of 26 Sep 2026");
    expect(s.live).toBe(false);
  });

  test("a refund from an unknown merchant is matched to that merchant's charge, and reduces its net cost", () => {
    const store = openManualFinanceStore(":memory:");
    store.importCsv("usman", buildNabCsv([
      { date: "02 Sep 26", amount: "-80.00", type: "EFTPOS DEBIT", details: "SYNTH HARDWARE STORE", merchant: "Synth Hardware" },
      { date: "03 Sep 26", amount: "-20.00", type: "EFTPOS DEBIT", details: "SYNTH HARDWARE STORE", merchant: "Synth Hardware" },
      { date: "09 Sep 26", amount: "20.00", type: "EFTPOS CREDIT", details: "SYNTH HARDWARE REFUND", merchant: "Synth Hardware" },
      { date: "10 Sep 26", amount: "7.00", type: "EFTPOS CREDIT", details: "SYNTH UNKNOWN REFUND", merchant: "Synth Elsewhere" },
    ]), "test");
    const s = summary("usman", "all", { store, today: "2026-09-27" });
    expect(s.refundMatches).toEqual({ matched: 1, matchedCents: 2000, unmatched: 1, unmatchedCents: 700 });
    expect(s.byVendor.find((v) => v.vendorId === "m-synth-hardware")).toMatchObject({ outCents: 10000, refundCents: 2000, netCostCents: 8000 });
    expect(s.cashOutCents).toBe(10000); // refunds stay out of cash in/out
    const [, twenty] = matchRefunds(store.rows("usman")).entries().next().value!;
    expect(store.rows("usman").find((r) => r.id === twenty)!.amountCents).toBe(-2000); // exact amount first
  });

  test("owner corrections change the totals: a transfer that was really a payment, and business vs personal", () => {
    const store = seeded();
    const rows = store.rows("usman");
    const officeworks = rows.find((r) => r.vendorId === "m-officeworks")!;
    const toSavings = rows.find((r) => r.vendorId === "transfer-out")!;
    const before = summary("usman", "all", { store, today: "2026-09-27" });
    expect(before.byScope.unreviewed.outCents).toBeGreaterThan(0);
    store.setTxOverride("usman", officeworks.id, { scope: "personal" }, "usman");
    store.setTxOverride("usman", toSavings.id, { kind: "ordinary", scope: "business" }, "mehroz");
    const after = summary("usman", "all", { store, today: "2026-09-27" });
    expect(after.byScope.personal.outCents).toBe(4599);
    expect(after.cashOutCents).toBe(before.cashOutCents + 15000);
    expect(after.ownAccountTransfers.pairs).toBe(0); // the savings credit no longer mirrors a transfer
    expect(after.review.corrected).toBe(2);
  });
});
