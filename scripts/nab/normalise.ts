import type { BasiqTransaction } from "../finance/basiq";
import { resolveCategory } from "../finance/categories";

/** Deliberately decimal strings: the existing Basiq numeric amounts lose lexical precision. */
export type NabRow = Pick<BasiqTransaction, "id" | "accountId" | "direction" | "status"> & {
  amount: string; currency: string; kind: "ordinary" | "transfer" | "refund";
  date: string; vendorId?: string; invoiceReference?: string;
};
export type NormalisedRow = Omit<NabRow, "amount" | "currency"> & { minor: number; currency: "AUD" };

export function minorUnits(value: string): number {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(value)) throw new Error("INVALID_MONEY");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MONEY_OVERFLOW");
  return Number(negative ? -cents : cents);
}

export function normalise(row: NabRow): NormalisedRow {
  if (row.currency !== "AUD") throw new Error("UNSUPPORTED_CURRENCY");
  if (![row.id, row.accountId].every(v => typeof v === "string" && /^syn-[a-z0-9-]{1,80}$/.test(v))) throw new Error("INVALID_SYNTHETIC_ID");
  if (!["posted", "pending"].includes(row.status) || !["credit", "debit"].includes(row.direction) || !["ordinary", "transfer", "refund"].includes(row.kind)) throw new Error("INVALID_ROW");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date) throw new Error("INVALID_DATE");
  const minor = minorUnits(row.amount);
  if (minor < 0) throw new Error("NEGATIVE_MAGNITUDE");
  for (const id of [row.vendorId, row.invoiceReference]) if (id !== undefined && !/^syn-[a-z0-9-]{1,80}$/.test(id)) throw new Error("INVALID_SYNTHETIC_ID");
  // Explicit allowlist prevents payload/description fields entering state accidentally.
  return { id: row.id, accountId: row.accountId, direction: row.direction, status: row.status, kind: row.kind, date: row.date, minor, currency: "AUD", ...(row.vendorId ? { vendorId: row.vendorId } : {}), ...(row.invoiceReference ? { invoiceReference: row.invoiceReference } : {}) };
}

function safeAdd(a: number, b: number) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new Error("MONEY_OVERFLOW");
  return result;
}

/** Transfers excluded both ways. Refunds shown separately, never counted as sales. No inferred GST. */
export function cashFlow(rows: NormalisedRow[]) {
  let incomeMinor = 0, expensesMinor = 0, refundsReceivedMinor = 0, refundsPaidMinor = 0, pendingCount = 0, transferCount = 0;
  for (const row of rows) {
    if (row.status === "pending") { pendingCount++; continue; }
    if (row.kind === "transfer") { transferCount++; continue; }
    if (row.kind === "refund") {
      if (row.direction === "credit") refundsReceivedMinor = safeAdd(refundsReceivedMinor, row.minor);
      else refundsPaidMinor = safeAdd(refundsPaidMinor, row.minor);
    } else if (row.direction === "credit") incomeMinor = safeAdd(incomeMinor, row.minor);
    else expensesMinor = safeAdd(expensesMinor, row.minor);
  }
  return { currency: "AUD" as const, incomeMinor, expensesMinor, refundsReceivedMinor, refundsPaidMinor,
    netCashMinor: safeAdd(safeAdd(incomeMinor, -expensesMinor), safeAdd(refundsReceivedMinor, -refundsPaidMinor)),
    pendingCount, transferCount, gst: "not-inferred" as const, accountingProfit: null };
}

// Reuse the existing pure vocabulary lookup; do not load its finance store.
export const supportedSpendCategory = resolveCategory;
