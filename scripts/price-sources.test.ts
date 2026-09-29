// Guard: CRM deal values, proposal/invoice drafts and the economics pricing note take every
// receptionist price from src/lib/receptionist-packages.ts. A typed receptionist price or minute
// figure in these files fails here, so the old A$549 / 300 min / A$990 / A$490 pilot copy (or a
// hand copy of today's catalogue) cannot creep back. Website figures are a separate offer and allowed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUE_VERSION, formatAud, RECEPTIONIST_PACKAGES } from "../src/lib/receptionist-packages";
import { PRICE_RECOMMENDATION } from "../src/lib/business-economics";
import { OFFER_DEFAULTS } from "./leads/deals";
import { BOOKING_DISCLOSURE, invoiceData, proposalText } from "./leads/sales-backoffice";
import type { Lead } from "./leads/crm";

const ROOT = join(import.meta.dir, "..");
const GUARDED = ["scripts/leads/deals.ts", "scripts/leads/sales-backoffice.ts", "src/lib/business-economics.ts"];

/** Digits of `n` allowing `_` separators (69_900) and a thousands comma (1,690), bounded so 9999 ≠ 999. */
function amount(n: number): RegExp {
  const digits = String(n).split("");
  const body = digits.map((d, i) => (i === 0 ? d : `[_,]?${d}`)).join("");
  return new RegExp(`(?<![\\d_.,])${body}(?![\\d_]|,\\d)`);
}
const minutes = (n: number) => new RegExp(`(?<![\\d_.,])${String(n).replace(/(\d)(?=(\d{3})+$)/g, "$1,?")}\\s*(?:call\\s+)?min`, "i");

/** Every receptionist price in the catalogue, as cents and as whole dollars, plus minute counts. */
function catalogueBans(): { label: string; re: RegExp }[] {
  const bans: { label: string; re: RegExp }[] = [];
  for (const pkg of RECEPTIONIST_PACKAGES) {
    for (const [what, price] of [["monthly", pkg.pricing.monthly], ["setup", pkg.pricing.setup]] as const) {
      bans.push({ label: `${pkg.shortName} ${what} cents ${price.cents}`, re: amount(price.cents) });
      bans.push({ label: `${pkg.shortName} ${what} dollars ${price.cents / 100}`, re: amount(price.cents / 100) });
    }
    bans.push({ label: `${pkg.shortName} overage ${formatAud(pkg.pricing.overagePerMinute.cents)}`, re: new RegExp(formatAud(pkg.pricing.overagePerMinute.cents).replace(/[$.]/g, "\\$&")) });
    bans.push({ label: `${pkg.shortName} ${pkg.pricing.includedMinutes} minutes`, re: minutes(pkg.pricing.includedMinutes) });
  }
  return bans;
}
/** The retired pilot offer and the brief's named stale figures. */
const STALE: { label: string; re: RegExp }[] = [
  { label: "A$549 monthly (cents)", re: amount(54900) }, { label: "A$549 monthly", re: amount(549) },
  { label: "A$490 pilot (cents)", re: amount(49000) }, { label: "A$490 pilot", re: amount(490) },
  { label: "A$990 setup (cents)", re: amount(99000) }, { label: "A$990 setup", re: amount(990) },
  { label: "A$699 (cents)", re: amount(69900) }, { label: "A$699", re: amount(699) },
  { label: "A$999", re: amount(999) }, { label: "A$1,690", re: amount(1690) },
  { label: "300 minutes", re: /\b300\s*min/i },
  { label: "paid pilot price", re: /paid pilot/i },
];

describe("receptionist prices have one source", () => {
  test.each(GUARDED)("%s holds no receptionist price or minute literal", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    const hits = [...STALE, ...catalogueBans()].flatMap(({ label, re }) =>
      src.split("\n").flatMap((line, i) => (re.test(line) ? [`${file}:${i + 1} ${label}: ${line.trim().slice(0, 120)}`] : [])));
    expect(hits).toEqual([]);
  });

  test("the scanner is live: it catches the old pilot copy and the catalogue figures, and passes website figures", () => {
    const bans = [...STALE, ...catalogueBans()];
    const caught = (s: string) => bans.some(({ re }) => re.test(s));
    for (const bad of ["setupCents: 99_000, monthlyCents: 54_900", "A$990 setup and A$549/month incl. 300 minutes", "pilot A$490", "monthlyExGstCents: 69900", "A$1,099", "Premium 1,800 min", "A$0.80/min", "cents: 199900"]) expect(caught(bad)).toBe(true);
    for (const ok of ["165_000", "82_500", "11_000", "A$1,650 incl. GST", "A$825", "A$110/month", "9999", "30 days' written notice", "usdPerAudMillionths: 701900"]) expect(caught(ok)).toBe(false);
  });

  test("CRM defaults price the entry tier from the catalogue, ex GST and proposed", () => {
    const essential = RECEPTIONIST_PACKAGES.find((p) => p.tier === 1)!;
    const counted = (essential.pricing.setupStatus ?? essential.pricing.status) === "approved" ? essential.pricing.setup.cents : 0;
    expect([OFFER_DEFAULTS.receptionist.setupCents, OFFER_DEFAULTS.receptionist.monthlyCents]).toEqual([counted, essential.pricing.monthly.cents]);
    expect(OFFER_DEFAULTS.both.monthlyCents).toBe(essential.pricing.monthly.cents);
    expect(OFFER_DEFAULTS.receptionist.priceStatus).toBe(essential.pricing.status);
    expect(PRICE_RECOMMENDATION.monthlyExGstCents).toBe(essential.pricing.monthly.cents);
    expect(PRICE_RECOMMENDATION.setupExGstCents).toBe(essential.pricing.setup.cents);
  });

  test.each(RECEPTIONIST_PACKAGES.map((p) => [p.shortName, p] as const))("%s: proposal, invoice and pricing note carry the catalogue price", (_name, pkg) => {
    const lead = { id: 1, pitch: "receptionist", name: "Synthetic Dental" } as Lead;
    const text = proposalText(lead, pkg.id);
    expect(["proposed", "approved"]).toContain(pkg.pricing.status);
    expect(pkg.pricing.monthly.gst).toBe("exclusive");
    const setupApproved = (pkg.pricing.setupStatus ?? pkg.pricing.status) === "approved";
    if (!setupApproved) { expect(text).not.toContain(formatAud(pkg.pricing.setup.cents)); expect(text).toContain("Setup: quoted separately once approved."); }
    expect(text).toContain(`${setupApproved ? `${formatAud(pkg.pricing.setup.cents)} setup and ` : ""}${formatAud(pkg.pricing.monthly.cents)}/month, ex GST`);
    expect(text).toContain(`including ${pkg.pricing.includedMinutes.toLocaleString("en-AU")} call minutes per month`);
    expect(text).toContain(`additional minutes ${formatAud(pkg.pricing.overagePerMinute.cents)}/min ex GST`);
    expect(text).toContain(pkg.pricing.status === "approved" ? `(catalogue ${CATALOGUE_VERSION}, approved)` : "proposed, not yet approved");
    expect(text).toContain(BOOKING_DISCLOSURE);
    // Nothing may invoice a proposed setup fee.
    const inv = invoiceData(lead, new Date("2026-09-25T00:00:00Z"), pkg.id);
    // Only approved prices are invoiced: the first month at the approved monthly price (+10% GST).
    const monthlyApproved = pkg.pricing.status === "approved";
    const expected = (monthlyApproved ? pkg.pricing.monthly.cents : 0) + (setupApproved ? pkg.pricing.setup.cents : 0);
    // The receptionist part is an illustration only (owner decision (b) open), never due or issued.
    const acc = inv.receptionistIllustration!;
    expect(acc.issue).toBe(false);
    expect([acc.subtotal, acc.gst, acc.total]).toEqual([expected, Math.round(expected / 10), expected + Math.round(expected / 10)]);
    expect([inv.lines.length, inv.total]).toEqual([0, 0]);
    if (monthlyApproved) expect(acc.lines[0]).toMatchObject({ cents: pkg.pricing.monthly.cents, gst: "exclusive" });
    expect(inv.notInvoiced.length).toBe(setupApproved ? 0 : 1);
    expect(PRICE_RECOMMENDATION.rationale).toContain(`${pkg.shortName} ${formatAud(pkg.pricing.monthly.cents)}/month`);
  });
});
