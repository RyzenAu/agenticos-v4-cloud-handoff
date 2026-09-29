/**
 * "What's our margin on the A$1,099 package?": answered deterministically from the package catalogue and
 * the economics model (src/lib/receptionist-packages.ts + src/lib/business-economics.ts, the only
 * sources of package and margin numbers). No model computes or rounds a number here; Jev (or rules)
 * only routes the question to this function. Every answer says what it is: an ESTIMATE from planning
 * assumptions, prices PROPOSED, nothing measured or invoice-reconciled.
 */
import { calculateEconomics, defaultEconomicsInput, ECONOMICS_AS_OF } from "../src/lib/business-economics";
import { formatAud, RECEPTIONIST_PACKAGES, type ReceptionistPackage } from "../src/lib/receptionist-packages";

export const MARGIN_QUESTION = /\b(?:margin|margins|profit(?:ability)?|contribution|break[- ]?even|how much (?:do|would|will) we (?:make|keep|earn))\b/i;

export type MarginQuery = { pkg: ReceptionistPackage; scenario: "low" | "base" | "high"; clients: number };

/** The package, usage scenario and client count his words name (defaults: base usage, 5 clients). Pure. */
export function parseMarginQuery(text: string): MarginQuery | null {
  if (!MARGIN_QUESTION.test(text)) return null;
  const t = text.toLowerCase();
  const byPrice = RECEPTIONIST_PACKAGES.find((p) => new RegExp(`\\$?\\b${Math.round(p.pricing.monthly.cents / 100)}\\b`).test(t));
  const byName = RECEPTIONIST_PACKAGES.find((p) => t.includes(p.shortName.toLowerCase()));
  const byTier = /\b(?:tier|level)\s*([123])\b/.exec(t)?.[1];
  const pkg = byPrice ?? byName ?? (byTier ? RECEPTIONIST_PACKAGES.find((p) => p.tier === Number(byTier)) : undefined);
  if (!pkg) return null;
  const scenario = /\b(?:low|quiet|light)\b/.test(t) ? "low" : /\b(?:high|busy|heavy)\b/.test(t) ? "high" : "base";
  const n = /\b(\d{1,3})\s+(?:clients?|practices?|customers?)\b/.exec(t)?.[1];
  const clients = n ? Math.max(1, Math.min(500, Number(n))) : 5;
  return { pkg, scenario, clients };
}

const pct = (bps: number | null) => (bps === null ? "not computable" : `${(bps / 100).toFixed(1)}%`);

/** The spoken answer and the numbers behind it. Deterministic: same inputs, same words. */
export function marginAnswer(q: MarginQuery) {
  const r = calculateEconomics({ ...defaultEconomicsInput(q.pkg, q.scenario), clients: q.clients });
  const price = formatAud(q.pkg.pricing.monthly.cents);
  const status = q.pkg.pricing.status === "approved" ? "approved" : "proposed";
  const said =
    `${q.pkg.shortName} at ${price} a month (${status}, ex GST), ${q.scenario} usage, ${q.clients} client${q.clients === 1 ? "" : "s"}: ` +
    `estimated contribution margin ${pct(r.contributionMarginBps)} and operating margin ${pct(r.operatingMarginBps)} ` +
    `(${formatAud(r.contributionCents)} contribution on ${formatAud(r.revenueExGstCents)} revenue a month). ` +
    `That's an estimate from planning assumptions as of ${ECONOMICS_AS_OF}, not measured usage or reconciled invoices${r.incomplete ? ", and some cost rates are still unknown" : ""}.`;
  return {
    said,
    numbers: {
      packageId: q.pkg.id, monthlyExGstCents: q.pkg.pricing.monthly.cents, pricingStatus: status, scenario: q.scenario, clients: q.clients,
      revenueExGstCents: r.revenueExGstCents, contributionCents: r.contributionCents, contributionMarginBps: r.contributionMarginBps,
      operatingContributionCents: r.operatingContributionCents, operatingMarginBps: r.operatingMarginBps, incomplete: r.incomplete, asOf: ECONOMICS_AS_OF,
      source: "src/lib/receptionist-packages.ts + src/lib/business-economics.ts",
    },
  };
}
