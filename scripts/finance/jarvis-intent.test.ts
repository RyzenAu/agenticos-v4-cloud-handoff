import { expect, test } from "bun:test";
import { answerFinanceIntent, matchFinanceIntent } from "./jarvis-intent";

test("matches the four supported finance questions and ignores unrelated text", () => {
  expect(matchFinanceIntent("How much has come in today?")).toEqual({ kind: "income-today" });
  expect(matchFinanceIntent("what's today's revenue")).toEqual({ kind: "income-today" });
  expect(matchFinanceIntent("how much came in this week")).toEqual({ kind: "income-week" });
  expect(matchFinanceIntent("What's my balance?")).toEqual({ kind: "balance" });
  expect(matchFinanceIntent("check my bank balance")).toEqual({ kind: "balance" });
  expect(matchFinanceIntent("who's paid?")).toEqual({ kind: "paid-invoices" });
  expect(matchFinanceIntent("which invoices have been paid")).toEqual({ kind: "paid-invoices" });
  expect(matchFinanceIntent("what's the weather like")).toBeUndefined();
  expect(matchFinanceIntent("")).toBeUndefined();
});

test("matches income-month, spend-week/month and spend-category", () => {
  expect(matchFinanceIntent("how much did we make this month")).toEqual({ kind: "income-month" });
  expect(matchFinanceIntent("what's our income this month")).toEqual({ kind: "income-month" });
  expect(matchFinanceIntent("what did I spend this week?")).toEqual({ kind: "spend-week" });
  expect(matchFinanceIntent("what did I spend this month")).toEqual({ kind: "spend-month" });
  expect(matchFinanceIntent("how much have I spent on software")).toEqual({ kind: "spend-category", category: "software" });
  expect(matchFinanceIntent("what did I spend on software this month?")).toEqual({ kind: "spend-category", category: "software" });
});

function fakeFinance(overrides: Partial<{ configured: boolean; connected: boolean; summary: any; matches: any[]; category: any }> = {}) {
  return {
    configured: () => overrides.configured ?? true,
    status: async () => ({ configured: true, connected: overrides.connected ?? true, accounts: [], connections: [] }),
    summary: () =>
      overrides.summary ?? {
        currency: "AUD", balance: 5000, accounts: 1,
        incomeToday: { amount: 0, count: 0 }, incomeWeek: { amount: 0, count: 0 }, incomeMonth: { amount: 0, count: 0 },
        spendMonth: 0, spendWeek: { amount: 0, count: 0 }, runwayDays: null, recordedAt: new Date().toISOString(),
      },
    invoiceMatches: () => overrides.matches ?? [],
    categorySpend: () => overrides.category ?? { supported: true, amount: 0, count: 0 },
  } as any;
}

test("answerFinanceIntent tells the owner to connect NAB when there's no key or no connection yet", async () => {
  expect(await answerFinanceIntent({ kind: "balance" }, fakeFinance({ configured: false }))).toMatch(/isn't connected yet/);
  expect(await answerFinanceIntent({ kind: "balance" }, fakeFinance({ connected: false }))).toMatch(/isn't connected yet/);
});

test("answerFinanceIntent reports income and balance in AUD", async () => {
  const finance = fakeFinance({ summary: { incomeToday: { amount: 1234.5, count: 2 }, incomeWeek: { amount: 0, count: 0 }, balance: 9800, accounts: 2 } });
  expect(await answerFinanceIntent({ kind: "income-today" }, finance)).toBe("$1,234.50 has come in today, across 2 payments.");
  expect(await answerFinanceIntent({ kind: "income-week" }, finance)).toBe("Nothing's come in this week yet.");
  expect(await answerFinanceIntent({ kind: "balance" }, finance)).toBe("Your balance across 2 accounts is $9,800.00.");
});

test("answerFinanceIntent lists high-confidence invoice matches only", async () => {
  const finance = fakeFinance({ matches: [{ invoiceId: "inv-1", confidence: 0.97 }, { invoiceId: "inv-2", confidence: 0.55 }] });
  expect(await answerFinanceIntent({ kind: "paid-invoices" }, finance)).toBe("1 invoice looks paid: inv-1.");
});

test("answerFinanceIntent reports this month's income", async () => {
  const finance = fakeFinance({ summary: { incomeMonth: { amount: 5230, count: 4 } } });
  expect(await answerFinanceIntent({ kind: "income-month" }, finance)).toBe("$5,230.00 has come in this month, across 4 payments.");
  expect(await answerFinanceIntent({ kind: "income-month" }, fakeFinance())).toBe("Nothing's come in this month yet.");
});

test("answerFinanceIntent reports spend this week and this month", async () => {
  const finance = fakeFinance({ summary: { spendWeek: { amount: 340.2, count: 3 }, spendMonth: 1890.75 } });
  expect(await answerFinanceIntent({ kind: "spend-week" }, finance)).toBe("$340.20 spent this week, across 3 transactions.");
  expect(await answerFinanceIntent({ kind: "spend-month" }, finance)).toBe("$1,890.75 spent this month.");
  expect(await answerFinanceIntent({ kind: "spend-week" }, fakeFinance())).toBe("No spending recorded this week yet.");
  expect(await answerFinanceIntent({ kind: "spend-month" }, fakeFinance())).toBe("No spending recorded this month yet.");
});

test("answerFinanceIntent is honest about categories it can't break down", async () => {
  const finance = fakeFinance();
  expect(await answerFinanceIntent({ kind: "spend-category", category: "groceries" }, finance)).toBe('I can only break spend down by software right now, not "groceries".');
});

test("answerFinanceIntent reports software spend for the trailing month", async () => {
  const finance = fakeFinance({ category: { supported: true, amount: 456.7, count: 5 } });
  expect(await answerFinanceIntent({ kind: "spend-category", category: "software" }, finance)).toBe("$456.70 on software this month, across 5 transactions.");
  expect(await answerFinanceIntent({ kind: "spend-category", category: "software" }, fakeFinance())).toBe("No software spend found in the last month.");
});
