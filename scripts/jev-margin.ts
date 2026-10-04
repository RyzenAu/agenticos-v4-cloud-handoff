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

// ------------------------------------------------------------------------------------------------
// "Explain this margin" on a selected item: the figures the page SHOWS, quoted as shown, with the source
// and its data state said plainly. Nothing here computes, rounds or infers a number.

export type ShownData = Record<string, string | number | boolean | null>;
export type ShownSource = { name: string; state?: "live" | "simulated" | "stale" | "failed" | "unknown" | "setup-required"; updatedAt?: string };
export type ShownFigure = { key: string; label: string; value: string | number };

const NOT_FIGURES = /^(?:id|kind|packageId|package|scenario|clients|name|label|title|href|tier)$/i;
const humanise = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").replace(/\s*\b(?:pct|percent|cents)\b/i, "").trim().toLowerCase();

/** The figures on an item: numbers, and strings that carry a number. Values are kept exactly as sent. Pure. */
export function shownFigures(data: ShownData | undefined): ShownFigure[] {
  const out: ShownFigure[] = [];
  for (const [key, value] of Object.entries(data ?? {})) {
    if (NOT_FIGURES.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out.push({ key, label: humanise(key), value });
    else if (typeof value === "string" && /\d/.test(value)) out.push({ key, label: humanise(key), value });
  }
  return out;
}

/** One figure as it is spoken: a Cents key as dollars, a pct/margin key with a percent sign; strings verbatim. */
export function speakFigure(f: ShownFigure): string {
  if (typeof f.value === "string") return `${f.label} ${f.value}`;
  if (/cents$/i.test(f.key) && Number.isInteger(f.value)) return `${f.label} ${formatAud(f.value)}`;
  if (/(?:pct|percent|margin)/i.test(f.key)) return `${f.label} ${f.value}%`;
  return `${f.label} ${f.value}`;
}

/** The margin percentage the item shows for contribution, if any (for the cross-check against the model). */
export function shownContributionPct(data: ShownData | undefined): number | null {
  const hit = Object.entries(data ?? {}).find(([k]) => /contribution/i.test(k) && /margin|pct|percent|^contribution$/i.test(k));
  const v = hit?.[1];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Where the figures come from and whether that is live, said plainly. Never calls a non-live state live. */
export function sourceWords(source: ShownSource | undefined): { line: string; live: boolean } {
  if (!source) return { line: "The page didn't say where these come from, so I can't call them live.", live: false };
  const when = source.updatedAt ? ` (updated ${source.updatedAt})` : "";
  switch (source.state) {
    case "live":
      return { line: `Source: ${source.name}, live${when}.`, live: true };
    case "simulated":
      return { line: `Source: ${source.name}. This is simulated data, not real figures${when}.`, live: false };
    case "stale":
      return { line: `Source: ${source.name}. It is stale${source.updatedAt ? `, last updated ${source.updatedAt}` : ""}, so these may be out of date.`, live: false };
    case "failed":
      return { line: `Source: ${source.name}. It failed to load${when}, so these figures may be wrong or missing.`, live: false };
    case "setup-required":
      return { line: `Source: ${source.name}. It still needs setup, so these aren't real figures yet.`, live: false };
    default:
      return { line: `Source: ${source.name}. I can't tell whether it is live${when}, so treat it as unconfirmed.`, live: false };
  }
}
