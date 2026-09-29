import { expect, test } from "bun:test";
import { matchInvoices, type CreditRow, type OpenInvoice } from "./invoice-matching";

const invoice = (over: Partial<OpenInvoice> = {}): OpenInvoice => ({ id: "inv-1", reference: "INV-1042", amount: 1650, issuedAt: "2026-09-01T00:00:00Z", dueAt: "2026-09-15T00:00:00Z", ...over });
const credit = (over: Partial<CreditRow> = {}): CreditRow => ({ id: "t1", amount: 1650, description: "EFT INV-1042 Acme Pty Ltd", postDate: "2026-09-14T00:00:00Z", ...over });

test("amount, reference and date all matching gives the highest confidence", () => {
  const matches = matchInvoices([invoice()], [credit()]);
  expect(matches).toEqual([{ invoiceId: "inv-1", transactionId: "t1", confidence: 0.97, reason: expect.any(String) }]);
});

test("reference match outside the date window still matches, at lower confidence", () => {
  const matches = matchInvoices([invoice()], [credit({ postDate: "2026-11-01T00:00:00Z" })]);
  expect(matches).toHaveLength(1);
  expect(matches[0].confidence).toBe(0.85);
});

test("amount-only match inside the date window is weak but still surfaced", () => {
  const matches = matchInvoices([invoice()], [credit({ description: "Direct credit 483920" })]);
  expect(matches).toHaveLength(1);
  expect(matches[0].confidence).toBe(0.55);
});

test("amount-only match outside the date window and with no reference is not surfaced at all", () => {
  const matches = matchInvoices([invoice()], [credit({ description: "Direct credit 483920", postDate: "2027-06-01T00:00:00Z" })]);
  expect(matches).toEqual([]);
});

test("a wrong amount never matches even with a perfect reference", () => {
  const matches = matchInvoices([invoice({ amount: 1650 })], [credit({ amount: 1649.99 })]);
  expect(matches).toEqual([]);
});

test("each transaction is used for at most one invoice, and each invoice takes its best candidate", () => {
  const invoices = [invoice({ id: "inv-a", reference: "INV-A" }), invoice({ id: "inv-b", reference: "INV-B" })];
  const credits = [
    credit({ id: "weak", description: "no reference here", }),
    credit({ id: "strong-a", description: "INV-A settlement" }),
  ];
  const matches = matchInvoices(invoices, credits);
  // inv-a should prefer the strong reference match over the weak amount-only one.
  const forA = matches.find((m) => m.invoiceId === "inv-a");
  expect(forA?.transactionId).toBe("strong-a");
  // inv-b has no reference hit, so it falls back to the remaining amount-only candidate.
  const forB = matches.find((m) => m.invoiceId === "inv-b");
  expect(forB?.transactionId).toBe("weak");
  // No transaction id appears twice.
  expect(new Set(matches.map((m) => m.transactionId)).size).toBe(matches.length);
});

test("invoices with a non-positive or missing amount are skipped rather than throwing", () => {
  expect(matchInvoices([invoice({ amount: 0 })], [credit()])).toEqual([]);
  expect(matchInvoices([{ ...invoice(), amount: Number.NaN }], [credit()])).toEqual([]);
});
