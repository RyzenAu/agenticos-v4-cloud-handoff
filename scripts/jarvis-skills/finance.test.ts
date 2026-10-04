import { expect, test } from "bun:test";
import { answerFinance, financeIntent } from "./finance";
import { SHARED_LEDGER, openManualFinanceStore } from "../finance/manual-store";
import { syntheticSeptemberCsv } from "../finance/manual-fixtures";

test("financeIntent tries the NAB matcher then the Stripe matcher, in one skill", () => {
  expect(financeIntent("what's my balance")).toEqual({ skill: "finance", source: "nab", kind: "balance" });
  expect(financeIntent("what did I spend on software this month")).toEqual({ skill: "finance", source: "nab", kind: "spend-category", category: "software" });
  expect(financeIntent("who owes me")).toEqual({ skill: "finance", source: "stripe", kind: "outstanding-invoices" });
  expect(financeIntent("what's overdue")).toEqual({ skill: "finance", source: "stripe", kind: "overdue-invoices" });
  expect(financeIntent("what's the weather like")).toBeNull();
});

function fakeStripe(summary: any) {
  return { configured: () => true, keyStatus: () => ({ present: true, ok: true, message: null }), summary: () => summary } as any;
}

test("bank questions are answered from the NAB CSV import, sourced and dated; never a live balance", async () => {
  const store = openManualFinanceStore(":memory:");
  const ask = (kind: any, category?: string) => answerFinance({ skill: "finance", source: "nab", kind, ...(category ? { category } : {}) } as any, { root: "/tmp/does-not-matter", manualStore: store, today: "2026-09-27" });
  expect(await ask("income-month")).toBe("No NAB CSV has been imported yet. Export one from NAB Internet Banking and drop it on the Finance page.");
  expect(await answerFinance({ skill: "finance", source: "nab", kind: "balance" }, { root: "/tmp/does-not-matter", manualStore: null, today: "2026-09-27" })).toContain("No NAB CSV has been imported yet");
  store.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "test");
  expect(await ask("balance")).toBe("NAB CSV imported, as of 26 Sep 2026. I don't keep bank balances: the NAB CSV import holds cash flow only, and there's no live bank feed. Check NAB for your current balance.");
  expect(await ask("income-month")).toBe("NAB CSV imported, as of 26 Sep 2026. $825.00 came in this month, not counting transfers, refunds or Stripe payouts.");
  expect(await ask("spend-week")).toContain("went out the last 7 days");
  // The export runs to 27 Sep (its last row is dated then), so today is covered: a real $0, not unknown.
  expect(await ask("income-today")).toBe("NAB CSV imported, as of 26 Sep 2026. $0.00 came in today, not counting transfers, refunds or Stripe payouts.");
  expect(await ask("spend-category", "software")).toContain("Tools and subscriptions this month: $229.65 net");
  expect(await ask("spend-category", "groceries")).toContain('not by "groceries"');
  expect(await ask("paid-invoices")).toContain("can't match NAB payments to invoices");
  store.close();
});

test("answerFinance appends the local client-record note to 'who owes me' but no other Stripe answer", async () => {
  const stripe = fakeStripe({ invoices: { outstandingCount: 1, outstandingAud: 500 }, overdueInvoices: [], nextPayout: null });
  const receivablesLine = () => "From the client record, not Stripe: Test Co $825.00 (deposit).";
  const outstanding = await answerFinance({ skill: "finance", source: "stripe", kind: "outstanding-invoices" }, { root: "/tmp/does-not-matter", stripe, receivablesLine });
  expect(outstanding).toBe("1 invoice is outstanding, totalling $500.00. From the client record, not Stripe: Test Co $825.00 (deposit).");
  const payout = await answerFinance({ skill: "finance", source: "stripe", kind: "next-payout" }, { root: "/tmp/does-not-matter", stripe, receivablesLine });
  expect(payout).toBe("No payout is scheduled yet.");
});

test("answerFinance adds nothing when there's no local receivable to report", async () => {
  const stripe = fakeStripe({ invoices: { outstandingCount: 0, outstandingAud: 0 }, overdueInvoices: [], nextPayout: null });
  const said = await answerFinance({ skill: "finance", source: "stripe", kind: "outstanding-invoices" }, { root: "/tmp/does-not-matter", stripe, receivablesLine: () => "" });
  expect(said).toBe("Nothing's outstanding — every invoice is paid.");
});
