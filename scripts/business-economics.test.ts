import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { parseHTML } from "linkedom";
import { billedSeconds, breakEvenMinutes, calculateEconomics, CLIENT_COUNTS, costEvidenceTable, customerBillableSeconds, DEFAULT_COST_RATES, DEFAULT_FX, DEFAULT_PAYMENT, defaultEconomicsInput, economicsStressReport, exportConsistencyFixtureJson, exportEconomicsDraftJson, exportPackageEconomicsJson, overageFloor, packageEconomicsMatrix, receptionistConsistencyFixture, reconcileUsageMetadata, renderStressMarkdown, RETELL_COMPONENTS, RETELL_CONFIGURATIONS, RETELL_PUBLISHED_RANGE, RETELL_STRESS, SCENARIOS, scenariosFor, splitGst, STRESS_DEFAULTS, STRESS_USAGE_BPS, stressInput, stressUsage, STRIPE_FROM_2026_10_01, unknownCostRegister, validateRates } from "../src/lib/business-economics";
import type { CostRate, EconomicsInput } from "../src/lib/business-economics";
import { exportReceptionistCatalogueJson, formatAud, getReceptionistPackage, LEGACY_PACKAGE_ALIASES, priceDisplay, projectPackageProposal, projectReceptionistConfiguration, RECEPTIONIST_PACKAGES } from "../src/lib/receptionist-packages";
import { EconomicsComparisonCell, EconomicsDraftPreview, EconomicsWorkbench, parseEconomicsDecimal } from "../src/components/business/economics-workbench";

/** Synthetic arithmetic fixture: GST-inclusive A$110 so tax maths is easy to read. */
function fixture(): EconomicsInput {
  const input = defaultEconomicsInput(structuredClone(getReceptionistPackage("receptionist-essential")));
  const p = input.package.pricing;
  p.monthly = { cents: 11000, currency: "AUD", gst: "inclusive" }; p.setup = { cents: 11000, currency: "AUD", gst: "inclusive" };
  p.includedMinutes = 100; p.overagePerMinute = { cents: 110, currency: "AUD", gst: "inclusive" };
  p.includedSmsSegments = 0; p.extraSmsSegment = { cents: 0, currency: "AUD", gst: "inclusive" };
  return { ...input, clients: 1, calls: [{ count: 1, seconds: 60 }], rates: [], supportMinutesPerClient: 0, onboardingMinutes: 0,
    smsSegmentsPerClient: 0, phoneNumbersPerClient: 1,
    payment: { percentBps: 0, fixedCents: 0, gst: "none", creditEligible: false }, targetMarginBps: 0 };
}
function rate(extra: Partial<CostRate> = {}): CostRate {
  return { id: "fixture", label: "Synthetic", currency: "AUD", micros: 1000000, basis: "minute", gst: "none", creditEligible: false, covers: ["fixture"], incrementSeconds: 1, source: null, checkedAt: "2026-09-27", effectiveFrom: null, evidence: "assumption", note: "Synthetic arithmetic fixture", ...extra };
}
const pct = (bps: number | null) => bps === null ? null : bps / 100;

describe("GST and deterministic money", () => {
  test("inclusive GST conserves cents and exclusive adds tax", () => {
    expect(splitGst(11000, "inclusive")).toEqual({ grossCents: 11000, netCents: 10000, gstCents: 1000 });
    expect(splitGst(10000, "exclusive")).toEqual({ grossCents: 11000, netCents: 10000, gstCents: 1000 });
    expect(splitGst(69900, "exclusive")).toEqual({ grossCents: 76890, netCents: 69900, gstCents: 6990 });
    for (let n = 0; n < 500; n++) { const s = splitGst(n, "inclusive"); expect(s.grossCents).toBe(s.netCents + s.gstCents); }
  });
  test("ex-GST quotes keep the same net revenue whether or not M&U is registered", () => {
    const registered = defaultEconomicsInput(getReceptionistPackage("receptionist-essential"));
    const unregistered = { ...registered, gstRegistered: false };
    const a = calculateEconomics(registered); const b = calculateEconomics(unregistered);
    expect(a.revenueExGstCents).toBe(b.revenueExGstCents); expect(a.revenueExGstCents).toBe(69900 * 5);
    expect(a.outputGstCents).toBe(6990 * 5); expect(b.outputGstCents).toBe(0); expect(b.monthlyInputGstCents).toBe(0);
  });
  test("no GST and unregistered amounts are not divided by 1.1", () => {
    expect(splitGst(11000, "none").netCents).toBe(11000);
    const input = fixture(); input.gstRegistered = false; input.rates = [rate({ gst: "inclusive", creditEligible: true })];
    const r = calculateEconomics(input); expect(r.revenueExGstCents).toBe(11000); expect(r.outputGstCents).toBe(0); expect(r.monthlyInputGstCents).toBe(0); expect(r.variableCostCents).toBe(100);
  });
  test("supplier GST affects cash and eligible credits separately", () => {
    const input = fixture(); input.rates = [rate({ gst: "exclusive", creditEligible: true })];
    const r = calculateEconomics(input); expect(r.lines[0].cashCents).toBe(110); expect(r.lines[0].inputGstCents).toBe(10); expect(r.lines[0].operatingCents).toBe(100);
    input.rates = [rate({ gst: "exclusive", creditEligible: false })]; expect(calculateEconomics(input).variableCostCents).toBe(110);
  });
  test("decimal parser has exact cents, rejects exponent/negative/incomplete input", () => {
    expect(parseEconomicsDecimal("0.29", 2)).toBe(29); expect(parseEconomicsDecimal("0.7019", 6)).toBe(701900);
    for (const invalid of ["", "1e3", "-1", "NaN", "Infinity", "0.001", "1,00", "1,0000", ",100"]) expect(() => parseEconomicsDecimal(invalid, 2)).toThrow();
    // F1-13: correctly grouped thousands separators are accepted ("1,099").
    expect(parseEconomicsDecimal("1,000", 2)).toBe(100000);
  });
  test("USD converts in correct direction with exact RBA reciprocal and card buffer", () => {
    const input = fixture(); input.fx = { ...DEFAULT_FX, cardFeeBps: 0 }; input.rates = [rate({ currency: "USD", micros: 701900 })];
    expect(calculateEconomics(input).variableCostCents).toBe(100);
    input.fx.cardFeeBps = 300; expect(calculateEconomics(input).variableCostCents).toBe(103);
  });
  test("price display shows ex GST and incl GST (M&U is GST registered, +10%)", () => {
    expect(priceDisplay({ cents: 69900, currency: "AUD", gst: "exclusive" })).toEqual({ exGstCents: 69900, inclGstCents: 76890 });
    expect(priceDisplay({ cents: 11000, currency: "AUD", gst: "inclusive" }).exGstCents).toBe(10000);
    expect(formatAud(123456)).toBe("A$1,234.56"); expect(formatAud(90)).toBe("A$0.90"); expect(formatAud(-1)).toBe("-A$0.01");
  });
});

describe("usage and cost boundaries", () => {
  test("usage receipt reconciliation reports gaps without claiming invoice verification", () => {
    const calls = [{ count: 2, seconds: 61 }];
    expect(reconcileUsageMetadata(calls, 60, null, 40).state).toBe("receipt-missing");
    expect(reconcileUsageMetadata(calls, 60, { billedSeconds: 240, costCents: 40 }, 40)).toEqual({ state: "metadata-matches", expectedSeconds: 240, secondsDelta: 0, costDeltaCents: 0, invoiceReconciled: false });
    expect(reconcileUsageMetadata(calls, 60, { billedSeconds: 122, costCents: 20 }, 40).secondsDelta).toBe(-118);
  });
  test("rounds each carrier call, not aggregate duration", () => {
    const calls = [{ count: 2, seconds: 61 }, { count: 1, seconds: 1 }];
    expect(billedSeconds(calls, 60)).toBe(300); expect(billedSeconds(calls, 1)).toBe(123);
    expect(billedSeconds([{ count: 20, seconds: 0 }], 60)).toBe(0);
  });
  test("customer billing excludes calls under the minimum and sums seconds per period", () => {
    expect(customerBillableSeconds([{ count: 10, seconds: 4 }, { count: 2, seconds: 61 }], 5)).toBe(122);
    expect(customerBillableSeconds([{ count: 1, seconds: 5 }], 5)).toBe(5);
    const input = fixture(); input.package.pricing.includedMinutes = 2; input.calls = [{ count: 2, seconds: 61 }, { count: 50, seconds: 3 }];
    const r = calculateEconomics(input); expect(r.customerBillableSeconds).toBe(122); expect(r.overageMinutes).toBe(1);
  });
  test("Retell seconds and carrier started minutes are charged separately", () => {
    const input = fixture(); input.calls = [{ count: 2, seconds: 61 }];
    input.rates = [rate({ id: "retell", covers: ["voice"], micros: 600000 }), rate({ id: "carrier", covers: ["carrier"], incrementSeconds: 60, micros: 100000 })];
    const r = calculateEconomics(input); expect(r.lines.map((l) => l.operatingCents)).toEqual([122, 40]); expect(r.variableCostCents).toBe(162);
  });
  test("customer overage rounds aggregate excess once and calculates line GST", () => {
    const input = fixture(); input.package.pricing.includedMinutes = 1; input.calls = [{ count: 3, seconds: 21 }];
    const r = calculateEconomics(input); expect(r.overageMinutes).toBe(1); expect(r.revenueExGstCents).toBe(10100);
    input.calls = [{ count: 1, seconds: 60 }]; expect(calculateEconomics(input).overageMinutes).toBe(0);
  });
  test("SMS segments beyond the allowance are billed; SMS and numbers cost per client", () => {
    const input = fixture(); input.clients = 2; input.package.pricing.includedSmsSegments = 10;
    input.package.pricing.extraSmsSegment = { cents: 11, currency: "AUD", gst: "inclusive" }; input.smsSegmentsPerClient = 21;
    input.phoneNumbersPerClient = 3;
    input.rates = [rate({ id: "sms", basis: "sms-segment", covers: ["sms"], micros: 50000 }), rate({ id: "number", basis: "number-month", covers: ["number"], micros: 2000000 })];
    const r = calculateEconomics(input);
    expect(r.smsOverageSegments).toBe(11); expect(r.revenueExGstCents).toBe((10000 + 110) * 2);
    expect(r.lines.map((l) => l.operatingCents)).toEqual([105 * 2, 600 * 2]); expect(r.perSmsSegmentCents).toBe(5);
  });
  test("a bundled component cannot be charged again", () => {
    expect(() => validateRates([...DEFAULT_COST_RATES, rate({ covers: ["tts"] })])).toThrow("Double-counted");
    expect(() => validateRates([rate(), rate()])).toThrow("Duplicate rate");
    expect(() => validateRates(DEFAULT_COST_RATES)).not.toThrow();
  });
  test("unknown rate produces a visible gap, not a claimed zero-cost service", () => {
    const input = fixture(); input.rates = [rate({ micros: null })];
    const r = calculateEconomics(input); expect(r.incomplete).toBe(true); expect(r.lines).toHaveLength(0); expect(r.warnings.join(" ")).toContain("unknown, excluded"); expect(r.basis).toBe("estimate");
  });
  test("unknown supplier tax remains explicitly unresolved", () => {
    const input = fixture(); input.rates = [rate({ gst: "unknown", creditEligible: true })];
    const r = calculateEconomics(input); expect(r.incomplete).toBe(true); expect(r.monthlyInputGstCents).toBe(0); expect(r.warnings.join(" ")).toContain("supplier GST unknown");
  });
  test("zero usage has no per-call/minute division and still has fixed costs", () => {
    const input = fixture(); input.calls = []; input.rates = [rate({ basis: "client-month" })];
    const r = calculateEconomics(input); expect(r.variableCostCents).toBe(100); expect(r.perCallCents).toBeNull(); expect(r.perMinuteCents).toBeNull(); expect(r.overageFloorExGstCents).toBeNull();
  });
  test("rejects invalid/unsafe inputs before calculating", () => {
    for (const clients of [0, -1, 1.5, Infinity, 10001]) expect(() => calculateEconomics({ ...fixture(), clients })).toThrow();
    expect(() => calculateEconomics({ ...fixture(), fx: { ...DEFAULT_FX, usdPerAudMillionths: 0 } })).toThrow();
    expect(() => calculateEconomics({ ...fixture(), smsSegmentsPerClient: -1 })).toThrow();
    expect(() => calculateEconomics({ ...fixture(), phoneNumbersPerClient: 101 })).toThrow();
    expect(() => billedSeconds([{ count: 1, seconds: -1 }], 60)).toThrow();
    expect(() => billedSeconds([], 0)).toThrow();
    expect(() => calculateEconomics({ ...fixture(), targetMarginBps: 10000 })).toThrow();
  });
});

describe("profit, allocation and price floors", () => {
  test("one-cent inclusive overage warns on quoted floor without changing aggregate GST", () => {
    const input = fixture(); input.package.pricing.monthly.cents = 0; input.package.pricing.includedMinutes = 0;
    input.package.pricing.overagePerMinute.cents = 1; input.rates = [rate({ micros: 10000 })];
    for (const minutes of [1, 5, 6, 10, 11, 12, 22]) {
      input.calls = [{ count: 1, seconds: minutes * 60 }]; const r = calculateEconomics(input);
      expect(r.revenueExGstCents).toBe(minutes - Math.floor((minutes + 5) / 11));
      expect(r.variableCostCents).toBe(minutes); expect(r.overageFloorQuotedCents).toBe(2); expect(r.overageBelowFloor).toBe(true);
    }
    input.calls = [{ count: 1, seconds: 660 }]; expect(calculateEconomics(input).contributionCents).toBe(-1);
    input.package.pricing.overagePerMinute.cents = 2; expect(calculateEconomics(input).overageBelowFloor).toBe(false);
    input.package.pricing.overagePerMinute.cents = 1; input.gstRegistered = false; expect(calculateEconomics(input).overageBelowFloor).toBe(false);
  });
  test("final operating and setup totals reject overflow across individually safe amounts", () => {
    const input = fixture(); input.fx = { usdPerAudMillionths: 1, cardFeeBps: 0, date: "2026-09-27" };
    input.rates = [rate({ currency: "USD", micros: 50000000000000 })];
    input.supportMinutesPerClient = 1000000000; input.supportHourlyCents = 400000000;
    expect(() => calculateEconomics(input)).toThrow("safe money range");
    input.supportMinutesPerClient = 0; input.rates = [rate({ currency: "USD", micros: 50000000000000, basis: "setup" })];
    input.onboardingMinutes = 1000000000; input.onboardingHourlyCents = 400000000;
    expect(() => calculateEconomics(input)).toThrow("safe money range");
  });
  test("variable subtotal plus payment fee cannot escape money range", () => {
    const input = fixture(); input.gstRegistered = false; input.package.pricing.monthly = { cents: 5000000000000000, currency: "AUD", gst: "none" };
    input.fx = { usdPerAudMillionths: 1, cardFeeBps: 0, date: "2026-09-27" }; input.rates = [rate({ currency: "USD", micros: 50000000000000 })];
    input.payment.percentBps = 10000;
    expect(() => calculateEconomics(input)).toThrow("safe money range");
  });
  test("FX requires a real calendar date, accepting leap years only when valid", () => {
    for (const date of ["2026-02-30", "2026-02-29", "2100-02-29", "2026-13-01", "2026-00-01", "2026-04-31", "2026-09-00", "2026-9-25", "not-a-date"]) expect(() => calculateEconomics({ ...fixture(), fx: { ...DEFAULT_FX, date } })).toThrow("FX date");
    for (const date of ["2024-02-29", "2000-02-29", "2026-09-25"]) expect(calculateEconomics({ ...fixture(), fx: { ...DEFAULT_FX, date } }).basis).toBe("estimate");
  });
  test("contribution subtracts variable costs before support/platform", () => {
    const input = fixture(); input.supportMinutesPerClient = 30; input.supportHourlyCents = 2000;
    input.rates = [rate(), rate({ id: "platform", covers: ["platform"], basis: "shared-month", micros: 2000000 })];
    const r = calculateEconomics(input); expect(r.revenueExGstCents).toBe(10000); expect(r.contributionCents).toBe(9900); expect(r.supportCents).toBe(1000); expect(r.operatingContributionCents).toBe(8700); expect(r.operatingMarginBps).toBe(8700);
  });
  test("one platform allocation at 1/5/10/25 clients; exact per-client cents preserved", () => {
    const input = fixture(); input.rates = [rate(), rate({ id: "platform", covers: ["platform"], basis: "shared-month", micros: 2000000 })];
    for (const clients of CLIENT_COUNTS) { const r = calculateEconomics({ ...input, clients }); expect(r.sharedPlatformCents).toBe(200); expect(r.variableCostCents).toBe(100 * clients); expect(r.operatingContributionCents).toBe(9900 * clients - 200); }
    expect([...CLIENT_COUNTS]).toEqual([1, 5, 10, 25]);
  });
  test("payment fees use GST-inclusive charge and eligible fee GST is removed", () => {
    const input = fixture(); input.payment = { percentBps: 170, fixedCents: 30, gst: "inclusive", creditEligible: true };
    const r = calculateEconomics(input); // 11000*.017+30 =217 incl GST, credit20
    expect(r.paymentCostCents).toBe(197); expect(r.monthlyInputGstCents).toBe(20); expect(r.estimatedNetGstCents).toBe(980);
  });
  test("setup includes independent payment, labour and setup-only costs", () => {
    const input = fixture(); input.onboardingMinutes = 120; input.onboardingHourlyCents = 3000;
    input.rates = [rate({ basis: "setup", micros: 5000000 })];
    const r = calculateEconomics(input); expect(r.setup.costCents).toBe(6500); expect(r.setup.contributionCents).toBe(3500); expect(r.variableCostCents).toBe(0); expect(r.setup.paybackCovered).toBe(true);
  });
  test("target floor accounts for collection fees and GST; rounds upward", () => {
    const input = fixture(); input.rates = [rate()]; input.targetMarginBps = 5000;
    let r = calculateEconomics(input); expect(r.overageFloorExGstCents).toBe(200); expect(r.overageFloorQuotedCents).toBe(220); expect(r.overageBelowFloor).toBe(true);
    input.payment = { percentBps: 1000, fixedCents: 0, gst: "inclusive", creditEligible: true };
    r = calculateEconomics(input); expect(r.overageFloorExGstCents).toBe(250); expect(r.overageFloorQuotedCents).toBe(275);
    input.targetMarginBps = 9900; expect(calculateEconomics(input).overageFloorExGstCents).toBeNull();
  });
  test("usage and client break-even boundaries include shared costs", () => {
    const input = fixture(); input.rates = [rate(), rate({ id: "platform", covers: ["platform"], basis: "shared-month", micros: 200000000 })];
    let r = calculateEconomics(input); expect(r.breakEvenClients).toBe(3); expect(r.breakEvenIncludedMinutes).toBe(0);
    input.clients = 5; r = calculateEconomics(input); expect(r.breakEvenIncludedMinutes).toBe(60);
    input.supportMinutesPerClient = 600; expect(calculateEconomics(input).breakEvenClients).toBeNull();
  });
  test("zero revenue has no misleading margin, no payment fixed fee", () => {
    const input = fixture(); input.package.pricing.monthly.cents = 0; input.payment.fixedCents = 30;
    const r = calculateEconomics(input); expect(r.contributionMarginBps).toBeNull(); expect(r.operatingMarginBps).toBeNull(); expect(r.paymentCostCents).toBe(0);
  });
});

describe("package catalogue (owner-approved prices, 28 Sep 2026)", () => {
  test("exactly three receptionist tiers at the owner-approved prices", () => {
    expect(RECEPTIONIST_PACKAGES.map((p) => p.id)).toEqual(["receptionist-essential", "receptionist-professional", "receptionist-premium"]);
    const [e, p, x] = RECEPTIONIST_PACKAGES;
    expect(e.pricing.monthly).toEqual({ cents: 69900, currency: "AUD", gst: "exclusive" });
    expect(p.pricing.monthly).toEqual({ cents: 109900, currency: "AUD", gst: "exclusive" });
    expect(x.pricing.monthly).toEqual({ cents: 199900, currency: "AUD", gst: "exclusive" });
    expect([e, p, x].map((t) => t.pricing.overagePerMinute.cents)).toEqual([80, 75, 70]);
    for (const pkg of RECEPTIONIST_PACKAGES) {
      expect(pkg.kind).toBe("receptionist"); expect(pkg.pricing.status).toBe("approved"); expect(pkg.pricing.approvedAt).toBe("2026-09-28"); expect(pkg.pricing.approvalReference).toMatch(/Owner decision 28 Sep 2026/); expect(pkg.pricing.setupStatus).toBe("proposed"); expect([400, 1000, 1800]).toContain(pkg.pricing.includedMinutes);
      expect(pkg.readiness.releaseGates.length).toBeGreaterThan(0); expect(pkg.onboarding.length).toBeGreaterThan(0);
      expect(pkg.pricing.billing.minimumBillableSeconds).toBe(5); expect(pkg.pricing.billing.rollover).toBe(false);
      expect(pkg.pricing.minimumTermMonths).toBeGreaterThan(0); expect(pkg.fairUse.length).toBeGreaterThan(0);
      expect(pkg.model.scenarios.map((s) => s.id)).toEqual(["low", "base", "high"]);
    }
    // Upgrades are monotonic: more minutes, calendars and SMS; cheaper overage.
    for (let i = 1; i < 3; i++) {
      const [a, b] = [RECEPTIONIST_PACKAGES[i - 1], RECEPTIONIST_PACKAGES[i]];
      expect(b.pricing.includedMinutes).toBeGreaterThan(a.pricing.includedMinutes); expect(b.inclusions.calendars).toBeGreaterThan(a.inclusions.calendars);
      expect(b.pricing.includedSmsSegments).toBeGreaterThan(a.pricing.includedSmsSegments); expect(b.pricing.overagePerMinute.cents).toBeLessThan(a.pricing.overagePerMinute.cents);
    }
  });
  test("Enquiry Rescue and the old A$549 price are gone from the catalogue and export", () => {
    const json = exportReceptionistCatalogueJson();
    expect(json.toLowerCase()).not.toContain("enquiry rescue"); expect(json).not.toContain("enquiry-rescue"); expect(json).not.toContain("549");
    expect(() => getReceptionistPackage("dental-enquiry-rescue")).toThrow();
    const source = readFileSync(new URL("../src/lib/receptionist-packages.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/lib/business-economics.ts", import.meta.url), "utf8");
    expect(source).not.toContain("549"); expect(source.toLowerCase()).not.toContain("enquiry rescue");
  });
  test("capabilities never overclaim: booking and SMS at go-live, transfer not offered, live line does not book", () => {
    for (const pkg of RECEPTIONIST_PACKAGES) {
      const state = Object.fromEntries(pkg.functions.map((f) => [f.id, f.state]));
      expect(state.booking).toBe("at-go-live"); expect(state["sms-confirmation"]).toBe("at-go-live"); expect(state.transfer).toBe("not-offered");
      expect(state.message).toBe("available"); expect(state.safety).toBe("available");
      expect(pkg.limitations.join(" ")).toContain("does not book yet"); expect(pkg.limitations.join(" ")).toContain("000");
    }
    expect(JSON.parse(exportReceptionistCatalogueJson()).liveLineBooks).toBe(false);
  });
  test("legacy ids resolve for older callers without appearing in the catalogue", () => {
    expect(getReceptionistPackage("dental-receptionist").id).toBe("receptionist-essential");
    for (const id of Object.keys(LEGACY_PACKAGE_ALIASES)) expect(RECEPTIONIST_PACKAGES.some((p) => p.id === id)).toBe(false);
    expect(() => getReceptionistPackage("missing")).toThrow();
  });
  test("proposal and configuration projections are detached and fail closed", () => {
    const proposal = projectPackageProposal("receptionist-essential"); proposal.pricing.monthly.cents = 1;
    expect(getReceptionistPackage("receptionist-essential").pricing.monthly.cents).toBe(69900); expect(proposal.publishable).toBe(false);
    expect(proposal.display.monthly).toEqual({ exGstCents: 69900, inclGstCents: 76890 });
    const config = projectReceptionistConfiguration("receptionist-professional", "legal");
    expect(config.niche).toBe("LEGAL"); expect(config.provisionable).toBe(false); expect(config.enabledTools).toEqual([]);
    expect(config.calendarConfigured).toBe(false); expect(config.smsConfigured).toBe(false); expect(config.transferConfigured).toBe(false);
    expect(config.roundingMode).toBe("PER_PERIOD"); expect(config.calendarsAllowed).toBe(3);
    expect(projectReceptionistConfiguration("receptionist-premium").niche).toBeNull();
    expect(() => projectReceptionistConfiguration("receptionist-essential", "trades" as never)).toThrow("Unsupported sector");
  });
  test("manifest is deterministic, serialisable and never enables live capabilities", () => {
    const json = exportReceptionistCatalogueJson(); expect(json).toBe(exportReceptionistCatalogueJson());
    const manifest = JSON.parse(json); expect(manifest.schemaVersion).toBe(2); expect(manifest.mode).toBe("draft-only"); expect(manifest.liveCapabilitiesVerified).toBe(false);
    expect(manifest.packages.map((p: any) => p.catalogueId)).toEqual(RECEPTIONIST_PACKAGES.map((p) => p.id));
    for (const p of manifest.packages) { expect(p.publishable).toBe(false); expect(p.configurationDraft.provisionable).toBe(false); expect(p.configurationDraft.enabledTools).toEqual([]); expect(p.pricing.status).toBe("approved"); }
    manifest.packages[0].pricing.monthly.cents = 1; expect(exportReceptionistCatalogueJson()).toBe(json);
  });
  test("committed JSON exports match the source (run the exporter after catalogue edits)", () => {
    expect(readFileSync(new URL("../docs/receptionist-package-catalogue.json", import.meta.url), "utf8")).toBe(exportReceptionistCatalogueJson());
    expect(readFileSync(new URL("../docs/sales/receptionist-pack-2026-09-28/package-economics.json", import.meta.url), "utf8")).toBe(exportPackageEconomicsJson());
  });
});

describe("tier economics on current official rates (estimates, pinned)", () => {
  test("default rates carry sources, check date and no invented values", () => {
    for (const r of DEFAULT_COST_RATES) { expect(r.checkedAt).toBe("2026-09-28"); if (r.micros !== null) expect(r.source).toMatch(/^https:\/\//); }
    const unknown = DEFAULT_COST_RATES.filter((r) => r.micros === null).map((r) => r.id);
    expect(unknown).toEqual(["database", "hosting-excess", "sms-carrier-fees", "trunk-recording", "notifications", "concurrency", "subscriptions"]);
    expect(DEFAULT_FX).toEqual({ usdPerAudMillionths: 701900, date: "2026-09-25", cardFeeBps: 300 });
    // Stripe card 1.7% (official price from 1 Oct 2026) + Stripe Billing 0.7% (the receptionist bills via subscriptions).
    expect(DEFAULT_PAYMENT.percentBps).toBe(240); expect(STRIPE_FROM_2026_10_01.verifiedOnOfficialPage).toBe(true); expect(STRIPE_FROM_2026_10_01.percentBps).toBe(170);
  });
  test("estimated, measured and invoice-reconciled columns: only estimates have values, nulls carry reasons", () => {
    const rows = costEvidenceTable();
    expect(rows).toHaveLength(DEFAULT_COST_RATES.length);
    for (const row of rows) { expect(row.measuredMicros).toBeNull(); expect(row.invoiceReconciledMicros).toBeNull(); expect(row.measuredReason.length).toBeGreaterThan(20); expect(row.invoiceReason.length).toBeGreaterThan(20); }
  });
  test("variable cost per minute and overage floors at 70% target", () => {
    for (const pkg of RECEPTIONIST_PACKAGES) {
      const r = calculateEconomics(defaultEconomicsInput(pkg));
      expect(r.perMinuteCents).toBe(19); expect(r.overageFloorExGstCents).toBe(69);
      expect(r.overageBelowFloor).toBe(false); expect(r.incomplete).toBe(true);
    }
  });
  test("base-case margins at 5 clients are pinned so price edits are deliberate", () => {
    const base = Object.fromEntries(RECEPTIONIST_PACKAGES.map((pkg) => { const r = calculateEconomics(defaultEconomicsInput(pkg)); return [pkg.shortName, [pct(r.contributionMarginBps), pct(r.operatingMarginBps), r.setup.contributionCents]]; }));
    expect(base).toEqual({ Essential: [86.42, 76.99, 48596], Professional: [80.82, 69.37, 73396], Premium: [80.28, 70.98, 122996] });
  });
  test("matrix covers 3 tiers × low/base/high × 1/5/10/25 clients with empty measured and invoice columns", () => {
    const m = packageEconomicsMatrix();
    expect(m).toHaveLength(3);
    for (const p of m) for (const s of p.scenarios) {
      expect(s.byClients.map((c) => c.clients)).toEqual([1, 5, 10, 25]);
      for (const c of s.byClients) { expect(c.measured).toBeNull(); expect(c.invoiceReconciled).toBeNull(); expect(c.estimated.operatingMarginBps).toBeGreaterThan(4000); expect(c.estimated.breakEvenClients).toBe(1); }
    }
    expect(exportPackageEconomicsJson()).toBe(exportPackageEconomicsJson());
  });
  test("scenarios are package-specific; legacy SCENARIOS is the Essential set", () => {
    expect(SCENARIOS).toBe(scenariosFor(getReceptionistPackage("receptionist-essential")));
    expect(scenariosFor(getReceptionistPackage("receptionist-premium"))[1].calls[0].count).toBe(576);
    expect(() => defaultEconomicsInput(getReceptionistPackage("receptionist-essential"), "peak" as never)).toThrow();
  });
});

describe("workbench compatibility (component owned by the integration lead)", () => {
  test("read-only draft preview contains parseable current scenario JSON and updates", () => {
    const input = fixture(); input.package.pricing.monthly.cents = 69900;
    const preview = () => parseHTML(renderToStaticMarkup(createElement(EconomicsDraftPreview, { input }))).document.querySelector("textarea")!;
    const json = (text: string) => JSON.parse(parseHTML(`<div>${text}</div>`).document.querySelector("div")!.textContent!);
    const textarea = preview();
    expect(textarea.getAttributeNames().some((name) => name.toLowerCase() === "readonly")).toBe(true);
    const draft = json(textarea.textContent!);
    expect(draft.proposal.pricing.monthly.cents).toBe(69900);
    expect(draft.proposal.pricing.status).toBe("proposed"); expect(draft.publishable).toBe(false);
    expect(draft.estimate).toEqual(calculateEconomics(input));
    input.package.pricing.monthly.cents = 99900;
    expect(json(preview().textContent!).proposal.pricing.monthly.cents).toBe(99900);
  });
  test("comparison overflow stays local to a cell and recovers with valid assumptions", () => {
    const input = fixture();
    input.fx = { usdPerAudMillionths: 1, cardFeeBps: 0, date: "2026-09-27" };
    input.clients = 5; input.rates = [rate({ currency: "USD", micros: 2000000000000, basis: "client-month" })];
    expect(Number.isSafeInteger(calculateEconomics(input).operatingContributionCents)).toBe(true);
    const larger = { ...input, clients: 50 };
    expect(() => calculateEconomics(larger)).toThrow("safe money range");
    const html = renderToStaticMarkup(createElement(EconomicsComparisonCell, { input: larger }));
    expect(html).toContain("Estimate paused"); expect(html).not.toContain("NaN"); expect(html).not.toContain("Infinity");
  });
  test("download snapshot uses selected package and overrides but cannot inherit approval", () => {
    const input = defaultEconomicsInput(structuredClone(getReceptionistPackage("receptionist-professional")));
    input.package.pricing.includedMinutes = 900;
    input.package.pricing.status = "approved"; input.package.pricing.approvedAt = "2026-09-27"; input.package.pricing.approvalReference = "synthetic";
    input.clients = 10; input.fx.usdPerAudMillionths = 700000;
    const catalogueBefore = exportReceptionistCatalogueJson(); const before = JSON.stringify(input);
    const draft = JSON.parse(exportEconomicsDraftJson(input));
    expect(draft.proposal.catalogueId).toBe("receptionist-professional"); expect(draft.proposal.pricing.includedMinutes).toBe(900);
    expect(draft.proposal.pricing.status).toBe("proposed"); expect(draft.proposal.pricing.approvedAt).toBeNull(); expect(draft.proposal.pricing.approvalReference).toBeNull();
    expect(draft.publishable).toBe(false); expect(draft.proposal.approvalRequired).toBe(true);
    expect(draft.estimate).toEqual(calculateEconomics(input));
    expect(JSON.stringify(input)).toBe(before); expect(exportReceptionistCatalogueJson()).toBe(catalogueBefore);
  });
  test("real exported component still renders the new catalogue without NaN", () => {
    const html = renderToStaticMarkup(createElement(EconomicsWorkbench));
    for (const expected of ["Package catalogue", "Booking Receptionist · Essential", "Booking Receptionist · Premium", "25 clients", "Onboarding", "https://www.retellai.com/pricing", "RBA", "internal testing", "Download draft proposal"]) expect(html).toContain(expected);
    expect(html).not.toContain("NaN"); expect(html).not.toContain("Infinity"); expect(html).not.toContain("Enquiry Rescue");
  });
});

describe("stress test, 28 Sep 2026 (approved prices, launch allowances; estimates only)", () => {
  const pkg = (id: string) => getReceptionistPackage(id);
  const report = economicsStressReport();
  const cell = (id: string, usageBps: number, retell: string) => report.grid.find((g) => g.packageId === id)!.cells.find((c) => c.usageBps === usageBps && c.retell === retell)!;
  const op = (id: string, usageBps: number, retell: string) => { const c = cell(id, usageBps, retell); return [c.estimated.perClient.operatingCents, c.estimated.operatingMarginBps, c.estimated.contributionMarginBps]; };

  test("Retell configurations are sums of the official per-minute components", () => {
    const byId = Object.fromEntries(RETELL_CONFIGURATIONS.map((c) => [c.id, c.micros]));
    expect(byId).toEqual({ "generator-default": 82800, "live-demo-recorded": 95000, "modelled-base": 120000, "max-config": 860000 });
    expect(byId["modelled-base"]).toBe(DEFAULT_COST_RATES.find((r) => r.id === "retell")!.micros);
    for (const c of RETELL_CONFIGURATIONS) expect(c.micros).toBe(c.components.reduce((n, x) => n + RETELL_COMPONENTS[x], 0));
    expect(RETELL_STRESS.map((r) => [r.id, r.micros])).toEqual([["base", 120000], ["plus25", 150000], ["plus50", 180000], ["range-top", 310000], ["max-config", 860000]]);
    expect(RETELL_PUBLISHED_RANGE.highMicros).toBe(310000);
  });
  test("grid covers 3 tiers x 25/50/75/100/150% x 5 Retell cases, every cell an estimate with an empty measured column", () => {
    expect([...STRESS_USAGE_BPS]).toEqual([2500, 5000, 7500, 10000, 15000]);
    expect(report.grid.map((g) => g.packageId)).toEqual(["receptionist-essential", "receptionist-professional", "receptionist-premium"]);
    for (const g of report.grid) {
      expect(g.cells).toHaveLength(25);
      for (const c of g.cells) { expect(c.measured).toBeNull(); expect(c.measuredReason.length).toBeGreaterThan(20); expect(c.estimated.basis).toBe("estimate"); expect(c.estimated.incomplete).toBe(true); }
    }
    expect(report.basis).toBe("estimate"); expect(report.publishable).toBe(false); expect(report.reviewTrigger).toMatch(/30 days.*five paying clients/);
    expect(JSON.stringify(economicsStressReport())).toBe(JSON.stringify(report));
  });
  test("key grid cells are pinned (per-client operating cents, operating bps, contribution bps; 5 clients)", () => {
    expect(op("receptionist-essential", 10000, "base")).toEqual([52309, 7483, 8426]);
    expect(op("receptionist-essential", 2500, "base")).toEqual([61376, 8781, 9294]);
    expect(op("receptionist-essential", 15000, "max-config")).toEqual([-7360, -857, 608]);
    expect(op("receptionist-professional", 10000, "base")).toEqual([71707, 6525, 7670]);
    expect(op("receptionist-professional", 10000, "plus50")).toEqual([62891, 5723, 6868]);
    expect(op("receptionist-professional", 10000, "max-config")).toEqual([-37029, -3369, -2224]);
    expect(op("receptionist-premium", 10000, "base")).toEqual([133742, 6690, 7620]);
    expect(op("receptionist-premium", 10000, "range-top")).toEqual([83488, 4176, 5106]);
    expect(op("receptionist-premium", 15000, "base")).toEqual([157672, 5997, 7389]);
  });
  test("usage profile: 150 s calls, 5% non-billable short calls, SMS by tier, support scenario by usage", () => {
    const u = stressUsage(pkg("receptionist-essential"), { ...STRESS_DEFAULTS });
    expect(u).toMatchObject({ minutes: 400, billableCalls: 160, nonBillableCalls: 8, bookings: 80, smsSegments: 80, transfers: 0, webhookEvents: 924, supportScenario: "base", supportMinutes: 60 });
    const p = stressUsage(pkg("receptionist-professional"), { ...STRESS_DEFAULTS, usageBps: 15000, smsSegmentsPerMessage: 2, transferShareBps: 1000 });
    expect(p).toMatchObject({ minutes: 1500, billableCalls: 600, bookings: 300, smsSegments: 1200, transfers: 60, supportScenario: "high", supportMinutes: 240 });
    const c = cell("receptionist-essential", 10000, "base");
    // Short calls are costed but never billed: 400 billable minutes, not 400 + 8 x 4 s.
    expect(c.usage.overageMinutes).toBe(0); expect(c.estimated.perClient.revenueExGstCents).toBe(69900);
    expect(c.estimated.perClient.retellCents).toBe(7053); expect(c.estimated.perClient.carrierCents).toBe(430);
    expect(() => stressInput(pkg("receptionist-essential"), { ...STRESS_DEFAULTS, retell: "cheap" as never })).toThrow("Unknown Retell stress case");
  });
  test("overlays: SMS segments, transfer legs, duplicate webhooks and support are costed, never billed", () => {
    const cases = (id: string) => Object.fromEntries(report.overlays.find((o) => o.packageId === id)!.cases.map((c) => [c.id, [c.cell.estimated.perClient.operatingCents, c.cell.estimated.operatingMarginBps]]));
    expect(cases("receptionist-premium")).toEqual({ baseline: [133742, 6690], "sms-2-segments": [131814, 6477], "transfers-10pct": [131302, 6568], "duplicate-webhooks": [133741, 6690], "support-x2": [115742, 5790], "combined-1-client": [97750, 3525] });
    const base = cell("receptionist-premium", 10000, "base");
    const transfers = report.overlays.find((o) => o.packageId === "receptionist-premium")!.cases.find((c) => c.id === "transfers-10pct")!.cell;
    expect(transfers.estimated.perClient.revenueExGstCents).toBe(base.estimated.perClient.revenueExGstCents);
    expect(transfers.estimated.perClient.transferCents).toBeGreaterThan(0); expect(base.estimated.perClient.transferCents).toBe(0);
    for (const t of report.overlays) for (const c of t.cases) expect(c.cell.estimated.operatingMarginBps).toBeGreaterThan(3000);
  });
  test("transfer legs are carrier-only, rounded per leg, and never customer-billable", () => {
    const input = fixture(); input.calls = [{ count: 1, seconds: 60 }]; input.transferLegs = [{ count: 2, seconds: 61 }];
    input.rates = [rate({ id: "leg", basis: "transfer-minute", incrementSeconds: 60, covers: ["leg"], micros: 100000 })];
    const r = calculateEconomics(input);
    expect(r.lines[0].billedSeconds).toBe(240); expect(r.lines[0].operatingCents).toBe(40);
    expect(r.revenueExGstCents).toBe(10000); expect(r.overageMinutes).toBe(0); expect(r.customerBillableSeconds).toBe(60);
    expect(() => calculateEconomics({ ...input, transferLegs: [{ count: 1, seconds: -1 }] })).toThrow();
  });
  test("webhook events are priced per million and a bad quantityPer fails closed", () => {
    const input = fixture(); input.webhookEventsPerClient = 2_000_000;
    input.rates = [rate({ id: "hook", basis: "webhook-event", covers: ["hook"], micros: 600000, quantityPer: 1_000_000 })];
    expect(calculateEconomics(input).variableCostCents).toBe(120);
    expect(() => validateRates([rate({ quantityPer: 0 })])).toThrow("quantityPer");
    expect(() => calculateEconomics({ ...input, webhookEventsPerClient: -1 })).toThrow();
  });
  test("overage floor: marginal voice cost vs extra-minute price (A$0.0001 units)", () => {
    const floors = (id: string) => report.overageFloors.find((f) => f.packageId === id)!.byRetell;
    expect(floors("receptionist-premium").map((x) => [x.retell, x.marginalVoiceCost, x.breakEvenFloor, x.targetFloor70, x.headroomPerMinute, x.aboveMarginalCost])).toEqual([
      ["base", 1871, 1918, 6779, 4961, true], ["plus25", 2312, 2369, 8377, 4520, true], ["plus50", 2752, 2820, 9972, 4080, true],
      ["range-top", 4663, 4778, 16895, 2169, true], ["max-config", 12744, 13058, 46174, -5912, false],
    ]);
    // Premium A$0.70 stays above the marginal floor under +50% and at Retell's published range top; only the max configuration breaks it.
    const premium = overageFloor(pkg("receptionist-premium"), "plus50");
    expect(premium.priceExGst).toBe(7000); expect(premium.aboveMarginalCost).toBe(true); expect(premium.meetsTarget70).toBe(false);
    expect(premium.paymentBurdenPpm).toBe(24000);
    for (const f of report.overageFloors) expect(f.byRetell.find((x) => x.retell === "base")!.meetsTarget70).toBe(true);
  });
  test("break-even minutes per client: never with overage below the max configuration; finite without overage", () => {
    const be = Object.fromEntries(report.breakEven.map((b) => [b.packageId, b.byRetell.map((x) => [x.withOverageMinutes, x.withoutOverageMinutes])]));
    expect(be).toEqual({
      "receptionist-essential": [[null, 2988], [null, 2453], [null, 2081], [null, 1255], [574, 469]],
      "receptionist-professional": [[null, 4300], [null, 3575], [null, 3059], [null, 1883], [717, 717]],
      "receptionist-premium": [[null, 7955], [null, 6613], [null, 5659], [null, 3482], [1325, 1325]],
    });
    // The boundary is exact: one minute earlier is still non-negative.
    const ess = pkg("receptionist-essential"); const opts = { ...STRESS_DEFAULTS, chargeOverage: false };
    expect(calculateEconomics(stressInput(ess, opts, 2988)).operatingContributionCents).toBeLessThan(0);
    expect(calculateEconomics(stressInput(ess, opts, 2987)).operatingContributionCents).toBeGreaterThanOrEqual(0);
    expect(breakEvenMinutes(ess, opts)).toBe(2988);
  });
  test("setup profitability with the PROPOSED fee and with no fee; hosting allocation at 1/5/10/25 clients", () => {
    const s = Object.fromEntries(report.setup.map((x) => [x.packageId, [x.setupStatus, x.withProposedFee.setupContributionCents, x.withProposedFee.firstMonthNetCents, x.withoutFee.setupContributionCents, x.withoutFee.firstMonthNetCents, x.withoutFee.monthsToRecoverOnboarding]]));
    expect(s).toEqual({
      "receptionist-essential": ["proposed", 48596, 88905, -48000, -7691, 2],
      "receptionist-professional": ["proposed", 73396, 127103, -72000, -18293, 2],
      "receptionist-premium": ["proposed", 122996, 196738, -120000, -46258, 2],
    });
    const h = report.hostingAllocation.find((x) => x.packageId === "receptionist-professional")!.byClients;
    expect(h.map((c) => [c.clients, c.estimated.perClient.sharedPlatformCents, c.estimated.operatingMarginBps])).toEqual([[1, 2935, 6311], [5, 587, 6525], [10, 294, 6551], [25, 117, 6567]]);
  });
  test("unknown costs never become 0: null in rates, register, lines, JSON and docs", () => {
    const unknownIds = DEFAULT_COST_RATES.filter((r) => r.micros === null).map((r) => r.id);
    expect(unknownIds.length).toBeGreaterThanOrEqual(7);
    const register = unknownCostRegister();
    for (const id of unknownIds) expect(register.find((u) => u.id === id)!.amount).toBeNull();
    for (const u of register) { expect(u.amount).toBeNull(); expect(u.whyUnknown.length).toBeGreaterThan(20); }
    const r = calculateEconomics(stressInput(pkg("receptionist-premium")));
    for (const id of unknownIds) expect(r.lines.some((l) => l.id === id)).toBe(false);
    expect(r.incomplete).toBe(true);
    for (const x of DEFAULT_COST_RATES.filter((y) => y.micros === null)) expect(r.warnings).toContain(`${x.label}: unknown, excluded from subtotal.`);
    const json = JSON.parse(JSON.stringify(report));
    for (const u of json.unknownCosts) expect(u.amount).toBeNull();
    for (const row of costEvidenceTable()) if (unknownIds.includes(row.id)) expect(row.estimatedMicros).toBeNull();
    // Replacing an unknown with 0 is visible: it would then appear as a costed (zero) line.
    const zeroed = calculateEconomics({ ...stressInput(pkg("receptionist-premium")), rates: DEFAULT_COST_RATES.map((x) => x.micros === null ? { ...x, micros: 0 } : x) });
    expect(zeroed.lines.filter((l) => unknownIds.includes(l.id)).length).toBe(unknownIds.length);
    expect(renderStressMarkdown().match(/\*\*UNKNOWN\*\*/g)!.length).toBe(unknownIds.length);
  });
  test("consistency fixture: Professional, 1,200 min, 40 SMS segments, 2 x 3-min transfers", () => {
    const f = receptionistConsistencyFixture();
    expect(f.expectedInvoice.overageMinutes).toBe(200); expect(f.expectedInvoice.smsOverageSegments).toBe(0);
    expect(f.expectedInvoice.lines.map((l) => [l.id, l.quantity, l.exGstCents, l.gstCents, l.inclGstCents])).toEqual([
      ["monthly", 1, 109900, 10990, 120890], ["overage-minutes", 200, 15000, 1500, 16500], ["sms-overage", 0, 0, 0, 0],
    ]);
    expect(f.expectedInvoice.totals).toEqual({ exGstCents: 124900, gstCents: 12490, totalInclGstCents: 137390 });
    expect(f.expectedInvoice.setupFee).toMatchObject({ status: "proposed", invoiced: false });
    expect(f.usage.billableMinutes).toBe(1200); expect(f.usage.transfers.customerBillable).toBe(false);
    expect(f.mustNotProduce[0]).toMatchObject({ billableMinutes: 1440, overageMinutes: 440, overageExGstCents: 33000 });
    expect(f.financeEstimate).toMatchObject({ basis: "estimate", measured: null, paymentFeeNetCents: 3025, directCostCents: 27005, contributionCents: 97895 });
    expect(f.financeEstimate.costLinesCents).toMatchObject({ retell: 21131, carrier: 1268, number: 1211, sms: 302, "transfer-termination": 63, "transfer-origination": 5 });
    // Independent recomputation from the catalogue alone.
    const p = pkg("receptionist-professional").pricing;
    const over = 1200 - p.includedMinutes; const ex = p.monthly.cents + over * p.overagePerMinute.cents;
    expect([ex, Math.round(ex / 10), ex + Math.round(ex / 10)]).toEqual([124900, 12490, 137390]);
    expect(readFileSync(new URL("../docs/receptionist-consistency-fixture.json", import.meta.url), "utf8")).toBe(exportConsistencyFixtureJson());
  });
  test("the stress doc embeds the rendered tables verbatim", () => {
    const doc = readFileSync(new URL("../docs/ECONOMICS-STRESS-20260928.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const start = "<!-- stress-tables:start (generated by renderStressMarkdown; do not hand-edit) -->\n"; const end = "<!-- stress-tables:end -->";
    expect(doc.includes(start)).toBe(true);
    expect(doc.slice(doc.indexOf(start) + start.length, doc.indexOf(end))).toBe(renderStressMarkdown());
  });
});
