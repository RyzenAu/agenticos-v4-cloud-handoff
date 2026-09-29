import { expect, test } from "bun:test";
import { computeCategorySpend, resolveCategory } from "./categories";
import type { StoredTransaction } from "./store";

const tx = (overrides: Partial<StoredTransaction> = {}): StoredTransaction => ({
  id: "t1", accountId: "a1", amount: -10, direction: "debit", description: "", postDate: "2026-09-20T00:00:00Z", status: "posted", class: "",
  ...overrides,
});

test("resolveCategory maps aliases to the one supported bucket", () => {
  expect(resolveCategory("software")).toBe("software");
  expect(resolveCategory("Subscriptions")).toBe("software");
  expect(resolveCategory("SaaS")).toBe("software");
  expect(resolveCategory("groceries")).toBeUndefined();
});

test("computeCategorySpend reports unsupported for anything but software", () => {
  expect(computeCategorySpend([], "groceries")).toEqual({ supported: false, amount: 0, count: 0 });
});

test("computeCategorySpend matches known software vendors in the description, case-insensitively", () => {
  const transactions = [
    tx({ id: "t1", description: "ANTHROPIC CLAUDE SUBSCRIPTION", amount: -100 }),
    tx({ id: "t2", description: "Vercel Inc", amount: -20 }),
    tx({ id: "t3", description: "Woolworths Leura", amount: -55 }),
    tx({ id: "t4", description: "Anthropic refund", amount: 100, direction: "credit" }), // credits never count as spend
  ];
  expect(computeCategorySpend(transactions, "software")).toEqual({ supported: true, amount: 120, count: 2 });
});

test("computeCategorySpend finds nothing when no vendor matches", () => {
  expect(computeCategorySpend([tx({ description: "Woolworths Leura" })], "software")).toEqual({ supported: true, amount: 0, count: 0 });
});
