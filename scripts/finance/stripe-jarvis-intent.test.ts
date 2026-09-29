import { expect, test } from "bun:test";
import { answerStripeIntent, matchStripeIntent } from "./stripe-jarvis-intent";

test("matches the three supported Stripe questions and ignores unrelated text", () => {
  expect(matchStripeIntent("Who owes me?")).toEqual({ kind: "outstanding-invoices" });
  expect(matchStripeIntent("who hasn't paid")).toEqual({ kind: "outstanding-invoices" });
  expect(matchStripeIntent("which invoices are outstanding")).toEqual({ kind: "outstanding-invoices" });
  expect(matchStripeIntent("what's overdue?")).toEqual({ kind: "overdue-invoices" });
  expect(matchStripeIntent("which invoices are overdue")).toEqual({ kind: "overdue-invoices" });
  expect(matchStripeIntent("when's my next payout?")).toEqual({ kind: "next-payout" });
  expect(matchStripeIntent("when do I get paid next")).toEqual({ kind: "next-payout" });
  expect(matchStripeIntent("what's the weather like")).toBeUndefined();
  expect(matchStripeIntent("")).toBeUndefined();
});

function fakeStripe(overrides: Partial<{ configured: boolean; keyStatus: any; summary: any }> = {}) {
  return {
    configured: () => overrides.configured ?? true,
    keyStatus: () => overrides.keyStatus ?? { present: true, ok: true, message: null },
    summary: () =>
      overrides.summary ?? {
        configured: true,
        revenueThisMonthAud: 0,
        invoices: { paidCount: 0, paidAud: 0, outstandingCount: 0, outstandingAud: 0 },
        overdueInvoices: [],
        nextPayout: null,
        mrrAud: null,
        lastSyncedAt: null,
      },
  } as any;
}

test("answerStripeIntent tells the owner to connect a key when Stripe isn't configured", async () => {
  expect(await answerStripeIntent({ kind: "next-payout" }, fakeStripe({ configured: false }))).toMatch(/isn't connected yet/);
});

test("answerStripeIntent surfaces the sk_ rejection reason instead of a generic message", async () => {
  const stripe = fakeStripe({ configured: false, keyStatus: { present: true, ok: false, message: "Use a restricted read-only key (rk_…)" } });
  expect(await answerStripeIntent({ kind: "next-payout" }, stripe)).toBe("Stripe isn't connected: Use a restricted read-only key (rk_…)");
});

test("answerStripeIntent reports outstanding invoices in AUD", async () => {
  const stripe = fakeStripe({ summary: { invoices: { outstandingCount: 3, outstandingAud: 4500.5 }, overdueInvoices: [], nextPayout: null } });
  expect(await answerStripeIntent({ kind: "outstanding-invoices" }, stripe)).toBe("3 invoices are outstanding, totalling $4,500.50.");
});

test("answerStripeIntent says nothing's outstanding when there's nothing to collect", async () => {
  expect(await answerStripeIntent({ kind: "outstanding-invoices" }, fakeStripe())).toBe("Nothing's outstanding — every invoice is paid.");
});

test("answerStripeIntent lists overdue invoices by customer with days overdue, capped at 5", async () => {
  const overdueInvoices = Array.from({ length: 7 }, (_, i) => ({ id: `in_${i}`, number: `INV-00${i}`, customerName: `Customer ${i}`, amountDue: 100, daysOverdue: i + 1 }));
  const stripe = fakeStripe({ summary: { invoices: {}, overdueInvoices, nextPayout: null } });
  const said = await answerStripeIntent({ kind: "overdue-invoices" }, stripe);
  expect(said).toStartWith("7 invoices are overdue: Customer 0 (1d, $100.00), Customer 1 (2d, $100.00), Customer 2 (3d, $100.00), Customer 3 (4d, $100.00), Customer 4 (5d, $100.00), and more.");
});

test("answerStripeIntent reports the next payout with amount and date", async () => {
  const stripe = fakeStripe({ summary: { invoices: {}, overdueInvoices: [], nextPayout: { amount: 1250.75, arrivalDate: "2026-10-01T00:00:00Z" } } });
  const said = await answerStripeIntent({ kind: "next-payout" }, stripe);
  expect(said).toStartWith("Your next payout is $1,250.75, arriving");
});

test("answerStripeIntent says nothing when no payout is scheduled", async () => {
  expect(await answerStripeIntent({ kind: "next-payout" }, fakeStripe())).toBe("No payout is scheduled yet.");
});
