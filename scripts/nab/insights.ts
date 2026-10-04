import type { InvoiceMatch } from "../finance/invoice-matching";
import type { NormalisedRow } from "./normalise";

/** Closed, synthetic invoice catalogue. Never calls loadOpenInvoices or reads real records. */
export function financeInsights(rows: NormalisedRow[]) {
  const eligible = rows.filter(row => row.status === "posted" && row.kind === "ordinary");
  const credit = eligible.find(row => row.direction === "credit" && row.currency === "AUD" && row.minor === 100000 && row.invoiceReference === "syn-invoice-001");
  const invoiceMatches: InvoiceMatch[] = credit ? [{ invoiceId: "syn-invoice-001", transactionId: credit.id, confidence: 0.97, reason: "Synthetic exact amount and explicit reference; owner review required." }] : [];
  const vendors = new Map<string, { vendorId: string; grossSpendMinor: number; refundsMinor: number; netSpendMinor: number; count: number }>();
  for (const row of rows) {
    if (!row.vendorId || row.status !== "posted" || row.kind === "transfer") continue;
    const vendor = vendors.get(row.vendorId) ?? { vendorId: row.vendorId, grossSpendMinor: 0, refundsMinor: 0, netSpendMinor: 0, count: 0 };
    if (row.kind === "ordinary" && row.direction === "debit") { vendor.grossSpendMinor += row.minor; vendor.count++; }
    if (row.kind === "refund" && row.direction === "credit") vendor.refundsMinor += row.minor;
    vendor.netSpendMinor = vendor.grossSpendMinor - vendor.refundsMinor;
    if (![vendor.grossSpendMinor, vendor.refundsMinor, vendor.netSpendMinor].every(Number.isSafeInteger)) throw new Error("MONEY_OVERFLOW");
    vendors.set(row.vendorId, vendor);
  }
  const recurringCandidates: Array<{ vendorId: string; amountMinor: number; evidenceCount: number; status: "candidate-only" }> = [];
  for (const vendorId of vendors.keys()) {
    const debits = eligible.filter(row => row.vendorId === vendorId && row.direction === "debit").sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < debits.length; i++) {
      const gap = (Date.parse(debits[i].date) - Date.parse(debits[i - 1].date)) / 86400000;
      if (gap >= 25 && gap <= 35 && debits[i].minor === debits[i - 1].minor) {
        recurringCandidates.push({ vendorId, amountMinor: debits[i].minor, evidenceCount: 2, status: "candidate-only" }); break;
      }
    }
  }
  return { invoiceMatches, vendorSpend: [...vendors.values()], recurringCandidates, invoiceStatusChanged: false as const };
}
