import type { NabRow } from "./normalise";

export const FIXTURE_IDS = ["cashflow-v1", "pending-posted-v1", "duplicate-v1", "insights-v1"] as const;
export type FixtureId = typeof FIXTURE_IDS[number];
const row = (id: string, amount: string, direction: NabRow["direction"], kind: NabRow["kind"] = "ordinary", status: NabRow["status"] = "posted"): NabRow =>
  ({ id, accountId: "syn-business", amount, direction, kind, status, currency: "AUD", date: "2026-09-27" });

/** Closed fixture catalogue. No upload, arbitrary JSON, filesystem path or provider call. */
export function fixture(id: FixtureId): { balance: string; balanceRevision: number; rows: NabRow[] } {
  if (id === "cashflow-v1") return { balance: "2315.00", balanceRevision: 1, rows: [
    { ...row("syn-income", "1000.00", "credit"), invoiceReference: "syn-invoice-001" }, row("syn-expense", "100.00", "debit"),
    row("syn-transfer-in", "500.00", "credit", "transfer"), row("syn-transfer-out", "500.00", "debit", "transfer"),
    row("syn-refund-in", "20.00", "credit", "refund"), row("syn-refund-out", "5.00", "debit", "refund"),
    row("syn-pending", "75.00", "debit", "ordinary", "pending"),
  ] };
  if (id === "pending-posted-v1") return { balance: "2240.00", balanceRevision: 2, rows: [row("syn-pending", "75.00", "debit")] };
  if (id === "duplicate-v1") { const income = { ...row("syn-income", "1000.00", "credit"), invoiceReference: "syn-invoice-001" }; return { balance: "2315.00", balanceRevision: 1, rows: [income, { ...income }] }; }
  if (id === "insights-v1") return { balance: "2220.00", balanceRevision: 3, rows: [
    { ...row("syn-software-aug", "10.00", "debit"), date: "2026-08-27", vendorId: "syn-software" },
    { ...row("syn-software-sep", "10.00", "debit"), vendorId: "syn-software" },
  ] };
  throw new Error("UNKNOWN_FIXTURE");
}
