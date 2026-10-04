// A small, standalone rules-based intent matcher for the Stripe questions Jarvis should be
// able to answer: "who owes me", "what's overdue", "when's my next payout". Modelled directly
// on scripts/finance/jarvis-intent.ts (the NAB/Basiq equivalent) and, like that file, is
// intentionally NOT wired into scripts/free-voice.ts, scripts/jev*.ts or
// scripts/jarvis-skills/* — those are owned by another engineer, and at the time this file was
// written scripts/jarvis-skills/index.ts had unrelated uncommitted changes in flight. See
// docs/finance/STRIPE-JARVIS-HOOK.md for the exact lines to add there to call this module.
import type { createStripeSync } from "./stripe";

export type StripeIntentKind = "outstanding-invoices" | "overdue-invoices" | "next-payout";
export type StripeIntent = { kind: StripeIntentKind };

const PATTERNS: Array<{ kind: StripeIntentKind; test: RegExp }> = [
  { kind: "overdue-invoices", test: /\bwhat'?s overdue\b|\bwhich invoices? (?:is|are) overdue\b|\boverdue invoices?\b|\bwho'?s (?:late|overdue)\b/ },
  { kind: "outstanding-invoices", test: /\bwho owes me\b|\bwho hasn'?t paid\b|\bwhich invoices? (?:are|is) (?:outstanding|unpaid)\b|\boutstanding invoices?\b|\bunpaid invoices?\b/ },
  { kind: "next-payout", test: /\bwhen'?s my next payout\b|\bwhen(?:'?s| is) the next payout\b|\bwhen do i get paid( next)?\b|\bnext stripe payout\b/ },
];

/** Pure text match — no side effects, safe to call from any voice/router pipeline. Checked in
 *  this order (overdue before outstanding) so "which invoices are overdue" never falls through
 *  to the more general outstanding pattern. */
export function matchStripeIntent(text: string): StripeIntent | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  for (const pattern of PATTERNS) if (pattern.test.test(t)) return { kind: pattern.kind };
  return undefined;
}

const aud = (value: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 2 }).format(value);
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });

/**
 * Turns a matched intent into a short spoken-style answer, in Australian English. Reads only
 * the locally-stored Stripe summary (summary() never calls Stripe — see stripe.ts), so this is
 * safe to call on every voice turn without rate-limit or live-request concerns.
 */
export async function answerStripeIntent(intent: StripeIntent, stripe: ReturnType<typeof createStripeSync>): Promise<string> {
  if (!stripe.configured()) {
    const status = stripe.keyStatus();
    if (status.present && !status.ok) return `Stripe isn't connected: ${status.message}`;
    return "Stripe isn't connected yet. Add a restricted read-only key (rk_…) from the dashboard first.";
  }
  const summary = stripe.summary();
  switch (intent.kind) {
    case "outstanding-invoices": {
      const { outstandingCount, outstandingAud } = summary.invoices;
      if (!outstandingCount) return "Nothing's outstanding — every invoice is paid.";
      return `${outstandingCount} ${outstandingCount === 1 ? "invoice is" : "invoices are"} outstanding, totalling ${aud(outstandingAud)}.`;
    }
    case "overdue-invoices": {
      const overdue = summary.overdueInvoices;
      if (!overdue.length) return "Nothing's overdue.";
      const named = overdue.slice(0, 5).map((i) => `${i.customerName || i.number || i.id} (${i.daysOverdue}d, ${aud(i.amountDue)})`);
      return `${overdue.length} ${overdue.length === 1 ? "invoice is" : "invoices are"} overdue: ${named.join(", ")}${overdue.length > 5 ? ", and more" : ""}.`;
    }
    case "next-payout": {
      const next = summary.nextPayout;
      if (!next) return "No payout is scheduled yet.";
      return `Your next payout is ${aud(next.amount)}, arriving ${dateLabel(next.arrivalDate)}.`;
    }
  }
}
