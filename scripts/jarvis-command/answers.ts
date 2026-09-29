/**
 * Deterministic answers the command path gives without a model (AUDIT-F4 F9): package prices come from
 * the catalogue (src/lib/receptionist-packages.ts) only, with each figure's approval status said out loud.
 * Margins stay in scripts/jev-margin.ts (the economics model). Pure.
 */
import { formatAud, RECEPTIONIST_PACKAGES, type ReceptionistPackage } from "../../src/lib/receptionist-packages";

const PRICE_QUESTION = /\b(?:how much (?:is|does|for|are)|what(?:'s| is| does)(?: the)? (?:price|cost)|price of|cost of|pricing (?:for|of|on))\b|\bwhat does (?:the )?\w+ (?:package |plan )?cost\b/i;

/** "how much is the Premium package" → that package, or every package for "how much are the packages". Pure. */
export function parsePriceQuery(text: string): ReceptionistPackage[] | null {
  if (!PRICE_QUESTION.test(text) || /\bmargin|profit/i.test(text)) return null;
  const t = text.toLowerCase();
  const named = RECEPTIONIST_PACKAGES.filter((p) => t.includes(p.shortName.toLowerCase()));
  if (named.length) return named;
  return /\b(?:packages|plans|receptionist|pricing)\b/.test(t) ? [...RECEPTIONIST_PACKAGES] : null;
}

/** The spoken answer and the figures behind it. Setup fees are never quoted as approved. */
export function priceAnswer(pkgs: ReceptionistPackage[]) {
  const one = (p: ReceptionistPackage) =>
    `${p.shortName}: ${formatAud(p.pricing.monthly.cents)} a month ex GST (${p.pricing.status}), ${p.pricing.includedMinutes.toLocaleString("en-AU")} minutes included, then ${formatAud(p.pricing.overagePerMinute.cents)} a minute`;
  const setup = pkgs.every((p) => p.pricing.setupStatus !== "approved") ? " Setup fees aren't approved yet, so I won't quote one." : "";
  return {
    said: `${pkgs.map(one).join("; ")}. Invoices add 10% GST.${setup}`,
    numbers: {
      source: "src/lib/receptionist-packages.ts",
      packages: pkgs.map((p) => ({ id: p.id, monthlyExGstCents: p.pricing.monthly.cents, status: p.pricing.status, includedMinutes: p.pricing.includedMinutes, overagePerMinuteCents: p.pricing.overagePerMinute.cents, setupStatus: p.pricing.setupStatus })),
    },
  };
}
