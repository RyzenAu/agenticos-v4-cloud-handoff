import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogueOffer, DEFAULT_OFFER_PACKAGE_ID, economics, PILOT_TERMS } from "./commercial";
import { buildReceptionistSnapshot } from "./aggregate";
import { call, inputs, NOW } from "./aggregate.test";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../../src/lib/receptionist-packages";

test("offer: every tier comes from the package catalogue, labelled with its approval status and GST basis", () => {
  const offer = catalogueOffer();
  expect(offer.tiers.map((t) => t.id)).toEqual([...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier).map((p) => p.id));
  for (const t of offer.tiers) {
    const pkg = getReceptionistPackage(t.id);
    expect(t).toMatchObject({
      setupCents: pkg.pricing.setup.cents,
      monthlyCents: pkg.pricing.monthly.cents,
      includedMinutes: pkg.pricing.includedMinutes,
      overagePerMinuteCents: pkg.pricing.overagePerMinute.cents,
      status: pkg.pricing.status,
    });
    // The catalogue quotes ex GST; the label must say so.
    expect(t.gst).toBe(pkg.pricing.monthly.gst === "exclusive" ? "ex GST" : t.gst);
  }
  expect(offer.tiers.every((t) => t.status === getReceptionistPackage(t.id).pricing.status)).toBe(true);
  expect(offer.tiers.every((t) => t.gst === "ex GST")).toBe(true);
  expect(offer.defaultPackageId).toBe(DEFAULT_OFFER_PACKAGE_ID);
  expect(getReceptionistPackage(DEFAULT_OFFER_PACKAGE_ID).tier).toBe(1);
});

test("offer: no pilot price exists; the pilot is 'agree in writing'", () => {
  const offer = catalogueOffer();
  expect(offer.pilotTerms).toBe("Pilot terms: not approved");
  for (const t of offer.tiers) expect(t.setupStatus).toBe(getReceptionistPackage(t.id).pricing.setupStatus ?? getReceptionistPackage(t.id).pricing.status);
  expect(PILOT_TERMS).toBe(offer.pilotTerms);
  const keys = JSON.stringify(offer);
  expect(keys).not.toMatch(/pilotAud|pilotDays|pilotPrice/);
});

test("economics: margin per tier is measured against that tier's catalogue price and allowance", () => {
  const e = economics([call()], 1.5);
  expect(e.perTier).toHaveLength(RECEPTIONIST_PACKAGES.length);
  for (const t of e.perTier) {
    const pkg = getReceptionistPackage(t.packageId);
    expect(t.monthlyAud).toBe(pkg.pricing.monthly.cents / 100);
    expect(t.includedMinutes).toBe(pkg.pricing.includedMinutes);
    expect(t.costAtIncludedAud).toBeCloseTo(e.retellAudPerMinute! * pkg.pricing.includedMinutes, 8);
    expect(t.status).toBe(pkg.pricing.status);
    expect(t.gst).toBe("ex GST");
  }
  expect(e.caveat).toContain(`prices ${RECEPTIONIST_PACKAGES.every((p) => p.pricing.status === "approved") ? "approved" : "proposed"} and ex GST`);
  // No FX: nothing measured, every tier's margin is unknown, never zero.
  expect(economics([call()], null).perTier.every((t) => t.marginAtIncludedAud === null && t.costAtIncludedAud === null)).toBe(true);
});

test("snapshot: the commercial block's offer is the catalogue offer", () => {
  const s = buildReceptionistSnapshot(inputs(), NOW);
  expect(s.commercial.offer).toEqual(catalogueOffer());
  expect(s.commercial.economics.packageId).toBe(DEFAULT_OFFER_PACKAGE_ID);
});

// ── The single-catalogue guard ────────────────────────────────────────────────────────────────
// Fails if any non-test file under scripts/receptionist/ carries its own dollar price or minute
// allowance (the retired local offer: 490 pilot, 990 setup, 549 monthly, 300 minutes), or copies a
// catalogue price. Prices and allowances must be read from src/lib/receptionist-packages.ts.

const DIR = import.meta.dir;
const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** Dollar amounts and cents that must never be typed here: legacy offer + every catalogue price. */
function forbiddenAmounts(): string[] {
  const dollars = new Set<number>([490, 549, 990]);
  const cents = new Set<number>();
  for (const p of RECEPTIONIST_PACKAGES) {
    for (const price of [p.pricing.setup, p.pricing.monthly]) {
      dollars.add(price.cents / 100);
      cents.add(price.cents);
    }
  }
  const out: string[] = [];
  for (const d of dollars) {
    out.push(String(d));
    if (d >= 1000) out.push(d.toLocaleString("en-AU")); // 1,690
  }
  for (const c of cents) out.push(String(c));
  return out;
}

function offences(name: string, text: string): string[] {
  const found: string[] = [];
  const lines = text.split(/\r?\n/);
  const amounts = forbiddenAmounts().map((a) => a.replace(",", "\\,"));
  const amountRe = new RegExp(`(?<![\\w.+])(?:${amounts.join("|")})(?![\\w])`);
  const patterns: [string, RegExp][] = [
    // A$/AU$/AUD followed by a digit, or a bare $ with 2+ digits (so regex "$1" back-references pass).
    ["dollar price literal", /(?:A\$|AU\$|AUD\s?)\s?\d|(?<![\w$])\$\d{2,}/],
    ["minute allowance literal", /\b\d{2,5}\s?-?\s?(?:min|mins|minutes?)\b/i],
    ["included-minutes literal", /includedMinutes\s*[:=]\s*\d/],
    ["price field literal", /\b(?:pilot|setup|monthly)(?:Aud|Cents|Price)?\s*:\s*\d/i],
    ["catalogue/legacy amount", amountRe],
  ];
  lines.forEach((line, i) => {
    for (const [label, re] of patterns) if (re.test(line)) found.push(`${name}:${i + 1} ${label}: ${line.trim().slice(0, 120)}`);
  });
  return found;
}

test("guard: no file under scripts/receptionist/ (excluding tests) contains a literal price or minute allowance", () => {
  expect(sources.length).toBeGreaterThan(5);
  expect(sources).toContain("commercial.ts");
  const all = sources.flatMap((f) => offences(f, readFileSync(join(DIR, f), "utf8")));
  expect(all).toEqual([]);
});

test("guard self-check: the patterns catch the retired offer and a copied catalogue price", () => {
  expect(offences("x.ts", "export const OFFER = { pilotAud: 490, setupAud: 990, monthlyAud: 549, includedMinutes: 300 };").length).toBeGreaterThan(0);
  expect(offences("x.ts", "const monthly = 549;")).toHaveLength(1);
  expect(offences("x.ts", "const price = 699;")).toHaveLength(1);
  expect(offences("x.ts", "label: 'A$1,690/mo'").length).toBeGreaterThan(0);
  expect(offences("x.ts", "// the 300-minute allowance")).toHaveLength(1);
  expect(offences("x.ts", "const cents = 69900;")).toHaveLength(1);
  // Ordinary numbers are not prices.
  expect(offences("x.ts", "signal: AbortSignal.timeout(8_000), status === 401, +61400000990x")).toEqual([]);
  expect(offences("x.ts", "`Retell A$${rate.toFixed(2)}/min measured on ${n} calls (${Math.round(m)} min)`")).toEqual([]);
});
