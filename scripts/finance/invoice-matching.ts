// Matches incoming NAB credits (via Basiq) to open invoices by amount, reference and a date
// window. This never writes back to an external invoicing system — a match only ever
// produces a local, reviewable suggestion (see recordInvoiceMatches in store.ts). There is no
// live invoicing feature in this OS yet, so the source list below is a small local JSON file;
// wiring a real invoicing feature to it later only means it starts writing that file.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type OpenInvoice = { id: string; reference: string; amount: number; currency?: string; issuedAt?: string; dueAt?: string; status?: string };
export type CreditRow = { id: string; amount: number; description: string; postDate: string | null };
export type InvoiceMatch = { invoiceId: string; transactionId: string; confidence: number; reason: string };

/** Either side of an invoice's issue/due date this many days counts as "the expected window". */
const DEFAULT_DATE_WINDOW_DAYS = 21;

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function referenceInDescription(reference: string, description: string): boolean {
  const ref = normalise(reference);
  if (ref.length < 3) return false;
  return normalise(description).includes(ref);
}

function withinWindow(postDate: string, invoice: OpenInvoice, windowDays: number): boolean {
  const anchor = invoice.dueAt || invoice.issuedAt;
  if (!anchor) return true; // Nothing to compare against — a missing date never disqualifies a match.
  const anchorMs = Date.parse(anchor), postMs = Date.parse(postDate);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(postMs)) return true;
  return Math.abs(postMs - anchorMs) <= windowDays * 86400000;
}

/**
 * Greedy best-match per invoice: each incoming credit is used for at most one invoice, and
 * each invoice takes its single highest-confidence candidate. Amount must match to the cent;
 * reference and date window only raise or gate confidence, they never substitute for amount.
 */
export function matchInvoices(invoices: OpenInvoice[], credits: CreditRow[], options: { dateWindowDays?: number } = {}): InvoiceMatch[] {
  const windowDays = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  const usedTransactions = new Set<string>();
  const matches: InvoiceMatch[] = [];
  for (const invoice of invoices) {
    if (typeof invoice.amount !== "number" || !Number.isFinite(invoice.amount) || invoice.amount <= 0) continue;
    let best: { transactionId: string; confidence: number; reason: string } | undefined;
    for (const credit of credits) {
      if (usedTransactions.has(credit.id)) continue;
      if (Math.round(credit.amount * 100) !== Math.round(invoice.amount * 100)) continue;
      const referenceHit = invoice.reference ? referenceInDescription(invoice.reference, credit.description) : false;
      const dateOk = credit.postDate ? withinWindow(credit.postDate, invoice, windowDays) : true;
      let confidence: number, reason: string;
      if (referenceHit && dateOk) { confidence = 0.97; reason = "Amount, reference and date all line up."; }
      else if (referenceHit) { confidence = 0.85; reason = "Amount and reference match; the date is outside the usual window."; }
      else if (dateOk) { confidence = 0.55; reason = "Amount matches within the expected date window; no reference found in the description."; }
      else continue; // Amount only, no reference, outside the window: too weak to surface as a match.
      if (!best || confidence > best.confidence) best = { transactionId: credit.id, confidence, reason };
    }
    if (best) { matches.push({ invoiceId: invoice.id, ...best }); usedTransactions.add(best.transactionId); }
  }
  return matches;
}

/** Reads .operator-data/invoices.json if something has written one; an absent or unreadable
 *  file is an ordinary "no invoices yet" state, never an error. */
export function loadOpenInvoices(root: string): OpenInvoice[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".operator-data", "invoices.json"), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof (item as any).id === "string" && typeof (item as any).amount === "number")
      .map((item) => ({
        id: item.id as string,
        reference: typeof item.reference === "string" ? item.reference : "",
        amount: item.amount as number,
        currency: typeof item.currency === "string" ? item.currency : undefined,
        issuedAt: typeof item.issuedAt === "string" ? item.issuedAt : undefined,
        dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined,
        status: typeof item.status === "string" ? item.status : undefined,
      }))
      .filter((invoice) => invoice.status !== "paid" && invoice.status !== "matched");
  } catch {
    return [];
  }
}
