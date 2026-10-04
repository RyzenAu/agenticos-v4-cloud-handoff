// A short, hand-maintained list of money owed that isn't in Stripe — invoiced or agreed
// directly with a client outside Stripe (bank transfer, on-account, a signed agreement's
// milestone payment). Kept here as a plain, reviewable, add-one-line list rather than parsed
// live from a client's own project folder (that would be a fragile cross-repo read at answer
// time, for a handful of entries that change rarely). Update this file by hand when a client's
// deal terms change; "who owes me" (scripts/jarvis-skills/finance.ts) appends it to the Stripe
// answer, always labelled as coming from the client record, never implied to be a Stripe figure
// — see docs/STRIPE-JARVIS-HOOK.md.
export type LocalReceivable = {
  client: string; amountAud: number; note: string;
  /** True only once an invoice has actually been issued for it. Absent/false = agreed in the
   *  client's signed terms but not yet invoiced (never shown as an "outstanding invoice"). */
  invoiced?: boolean;
  /** When it falls due, in the client record's words, e.g. "at launch". */
  due?: string;
};

// 24 Sep 2026: Bianca Brown Realty signed agreement (see
// C:\Users\Nebula PC\source\repos\bianca-brown-realty\CLIENT.md) — A$1,650 incl. GST total,
// A$825 deposit paid 22 Sep 2026 (ref BBR825), remaining A$825 due at approved launch
// (target ~13 Oct 2026). Not in Stripe — invoiced/paid directly.
export const LOCAL_RECEIVABLES: LocalReceivable[] = [
  { client: "Bianca Brown Realty", amountAud: 825, note: "remaining 50%, due at approved launch (~13 Oct 2026)", invoiced: false, due: "at launch" },
];

const aud = (value: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 2 }).format(value);

/**
 * A short spoken addendum for "who owes me" — empty string when there's nothing to add. Always
 * says the money comes from the client record, not Stripe, so it's never mistaken for a synced
 * figure.
 */
export function localReceivablesLine(receivables: LocalReceivable[] = LOCAL_RECEIVABLES): string {
  if (!receivables.length) return "";
  const named = receivables.map((r) => `${r.client} ${aud(r.amountAud)} (${r.note})`);
  return `From the client record, not Stripe: ${named.join(", ")}.`;
}

/** Where these figures come from, said wherever they're shown. */
export const RECEIVABLES_SOURCE = "client record in scripts/finance/receivables.ts, not Stripe";

/**
 * The CRM "Owed to us" tile, labelled for what the entries are (audit F1-24): money agreed with a
 * client and due at a milestone is "due at launch (client record)", not an issued invoice. Only
 * entries marked `invoiced` are counted as invoices.
 */
export function receivablesSummary(receivables: LocalReceivable[] = LOCAL_RECEIVABLES) {
  const cents = receivables.reduce((s, r) => s + Math.round(r.amountAud * 100), 0);
  const invoiced = receivables.filter((r) => r.invoiced === true);
  const agreed = receivables.filter((r) => r.invoiced !== true);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const dues = [...new Set(agreed.map((r) => r.due?.trim()).filter(Boolean))];
  const parts: string[] = [];
  if (agreed.length) parts.push(`${plural(agreed.length, "payment")} due ${dues.length === 1 ? dues[0] : "on agreed milestones"} (agreed, not yet invoiced)`);
  if (invoiced.length) parts.push(`${plural(invoiced.length, "issued invoice")} unpaid`);
  return {
    count: receivables.length,
    cents,
    invoicedCount: invoiced.length,
    label: parts.length ? parts.join(" · ") : "Nothing owed on the client record",
    source: RECEIVABLES_SOURCE,
  };
}
