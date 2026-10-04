import { describe, expect, test } from "bun:test";
import { receptionistConsistencyFixture } from "../../src/lib/business-economics";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../../src/lib/receptionist-packages";
import { BOOKING_DISCLOSURE as SALES_BOOKING, OWNER_DECISION_B as SALES_DECISION_B, WEBSITE_OFFER } from "../leads/sales-backoffice";
import { auditDeal } from "../../src/lib/deal-desk/checks";
import { blankDeal, comparisonCsv, fillQuoteText, parseDeals, seedDeals, serializeDeals } from "../../src/lib/deal-desk/deal";
import { allocate, paymentFee, parseDecimal, toAudCents } from "../../src/lib/deal-desk/money";
import { BOOKING_DISCLOSURE, buildQuote, OWNER_DECISION_B, renderQuoteHtml, renderQuoteMarkdown } from "../../src/lib/deal-desk/quote";
import { calculateRxDeal, callsForSeconds, defaultRxInput, pricedPackage, rxColumn, rxInvoice } from "../../src/lib/deal-desk/receptionist";
import { calculateWebsite, defaultWebsiteInput, WEBSITE_BASELINE } from "../../src/lib/deal-desk/website";

const TODAY = "2026-10-03";

describe("single sources of truth (drift guards)", () => {
  test("website baseline equals the owner-confirmed WEBSITE_OFFER", () => {
    expect(WEBSITE_BASELINE.priceCents).toBe(WEBSITE_OFFER.priceCents);
    expect(WEBSITE_BASELINE.depositCents).toBe(WEBSITE_OFFER.depositCents);
    expect(WEBSITE_BASELINE.carePlanMonthlyCents).toBe(WEBSITE_OFFER.carePlanMonthlyCents);
    expect(WEBSITE_BASELINE.gst).toBe(WEBSITE_OFFER.gst);
  });
  test("quote wording for open decision (b) and booking matches the sales back office verbatim", () => {
    expect(OWNER_DECISION_B).toBe(SALES_DECISION_B);
    expect(BOOKING_DISCLOSURE).toBe(SALES_BOOKING);
  });
  test("the desk never mutates the catalogue", () => {
    const before = JSON.stringify(RECEPTIONIST_PACKAGES);
    const i = defaultRxInput("receptionist-essential"); i.monthlyDiscountBps = 5000; i.setupFeeCents = 99000;
    calculateRxDeal(i); pricedPackage(i);
    expect(JSON.stringify(RECEPTIONIST_PACKAGES)).toBe(before);
  });
});

describe("money helpers", () => {
  test("allocate conserves cents and rejects shares that do not add to 100%", () => {
    expect(allocate(165000, [5000, 5000])).toEqual([82500, 82500]);
    expect(allocate(100, [3333, 3333, 3334])).toEqual([33, 33, 34]);
    expect(allocate(1, [5000, 5000])).toEqual([1, 0]);
    for (let t = 0; t < 2000; t += 37) expect(allocate(t, [2500, 2500, 5000]).reduce((a, b) => a + b, 0)).toBe(t);
    expect(() => allocate(100, [5000, 4000])).toThrow();
  });
  test("parseDecimal is exact and strict", () => {
    expect(parseDecimal("1,099.50", 2)).toBe(109950);
    expect(parseDecimal("0.7019", 6)).toBe(701900);
    for (const bad of ["", "-1", "1e3", "1.234", "1,00", "abc"]) expect(() => parseDecimal(bad, 2)).toThrow();
  });
  test("USD converts with the reference rate and buffer, AUD passes through", () => {
    const fx = { usdPerAudMillionths: 701900, date: "2026-09-25", cardFeeBps: 300 };
    expect(toAudCents(2000, "USD", fx)).toBe(2935); // 20 / 0.7019 × 1.03 = 29.349…
    expect(toAudCents(2000, "AUD", fx)).toBe(2000);
    expect(toAudCents(0, "USD", fx)).toBe(0);
  });
  test("payment fee: nothing on a zero charge; GST credit on creditable fees", () => {
    const stripe = { label: "", percentBps: 240, fixedCents: 30, gstCreditable: true };
    expect(paymentFee(0, stripe)).toEqual({ feeCents: 0, creditCents: 0, costCents: 0 });
    expect(paymentFee(120890, stripe)).toEqual({ feeCents: 2931, creditCents: 266, costCents: 2665 });
    expect(paymentFee(10000, { label: "", percentBps: 0, fixedCents: 0, gstCreditable: false }).costCents).toBe(0);
  });
});

describe("receptionist economics", () => {
  test("reproduces the agreed regression and the shared consistency fixture", () => {
    const i = defaultRxInput("receptionist-professional");
    const inv = rxInvoice(pricedPackage(i), 72000, 40);
    expect([inv.exGstCents, inv.gstCents, inv.inclGstCents, inv.overageMinutes]).toEqual([124900, 12490, 137390, 200]);
    const fixture = receptionistConsistencyFixture();
    expect(inv.inclGstCents).toBe(fixture.expectedInvoice.totals.totalInclGstCents);
    expect(inv.lines.map((l) => l.inclGstCents)).toEqual(fixture.expectedInvoice.lines.map((l) => l.inclGstCents));
  });
  test("per-second boundaries round once per month", () => {
    const pkg = pricedPackage(defaultRxInput("receptionist-professional"));
    expect([59_999, 60_000, 60_001, 60_060, 60_061].map((s) => rxInvoice(pkg, s, 0).overageMinutes)).toEqual([0, 0, 1, 1, 2]);
  });
  test("calls for seconds never loses or invents billable time", () => {
    for (const [s, avg] of [[60_001, 150], [0, 150], [4, 150], [149, 150], [72_000, 150], [1_000_003, 37]] as const) {
      const calls = callsForSeconds(s, avg);
      expect(calls.reduce((n, c) => n + c.count * c.seconds, 0)).toBe(s);
      expect(calls.every((c) => c.count > 0)).toBe(true);
    }
    expect(() => callsForSeconds(100, 4)).toThrow();
  });
  test("modelled revenue equals the invoice in every column, and costs tie to operating profit", () => {
    for (const pkg of RECEPTIONIST_PACKAGES) {
      const r = calculateRxDeal(defaultRxInput(pkg.id));
      for (const c of r.columns) {
        expect(c.invoice.exGstCents).toBe(c.revenueExGstCents);
        expect(c.revenueExGstCents - c.variableCostCents - c.supportCents - c.sharedPlatformCents).toBe(c.operatingCents);
      }
      expect(r.columns.map((c) => c.id)).toEqual(["low", "expected", "full", "extra"]);
      expect(r.columns.find((c) => c.id === "full")!.billableSeconds).toBe(pkg.pricing.includedMinutes * 60);
    }
  });
  test("zero usage: only the monthly fee is billed, costs exclude per-minute lines", () => {
    const i = defaultRxInput("receptionist-essential");
    const c = rxColumn(i, { billableSeconds: 0, smsSegments: 0, supportMinutes: 0 });
    expect(c.invoice.inclGstCents).toBe(76890);
    expect(c.overageMinutes).toBe(0);
    expect(c.costLines.find((l) => l.id === "retell")!.cents).toBe(0);
    expect(c.effectiveHourlyCents).toBeNull();
  });
  test("break-even points are consistent with the model they summarise", () => {
    const i = defaultRxInput("receptionist-essential");
    const b = calculateRxDeal(i).breakEven;
    // With overage charged above marginal cost, Essential stays profitable across the searched range.
    expect(b.overage.profitable).toBe(true);
    expect(b.unprofitableFromMinutes).toBeNull();
    // Without overage, a loss starts somewhere above the allowance: just below it is still profitable.
    expect(b.unprofitableFromMinutesWithoutOverage).not.toBeNull();
    expect(b.unprofitableFromMinutesWithoutOverage!).toBeGreaterThan(400);
    // The voice ceiling is tight: at the ceiling profit ≥ 0, one micro-dollar more and it is negative.
    const full = i.columns.full;
    const at = (v: number) => rxColumn({ ...i, voiceMicros: v }, full).operatingCents;
    expect(at(b.maxVoiceUsdMicrosAtFullAllowance!)).toBeGreaterThanOrEqual(0);
    expect(at(b.maxVoiceUsdMicrosAtFullAllowance! + 1)).toBeLessThan(0);
  });
  test("heavy costs make the loss point appear inside the allowance", () => {
    // US$0.90/min: the allowance still pays, but every extra minute now costs more than A$0.80, so the loss starts at 401.
    const i = defaultRxInput("receptionist-essential"); i.voiceMicros = 900_000;
    expect(calculateRxDeal(i).breakEven.unprofitableFromMinutes).toBe(401);
    expect(calculateRxDeal(i).breakEven.overage.profitable).toBe(false);
    // US$2/min: the loss starts inside the allowance, and the boundary is exact.
    i.voiceMicros = 2_000_000;
    const m = calculateRxDeal(i).breakEven.unprofitableFromMinutes!;
    expect(m).toBeLessThanOrEqual(400);
    const col = (minutes: number) => ({ billableSeconds: minutes * 60, smsSegments: Math.round(i.columns.expected.smsSegments * minutes * 60 / i.columns.expected.billableSeconds), supportMinutes: minutes * 60 <= 12000 ? i.columns.low.supportMinutes : i.columns.expected.supportMinutes });
    expect(rxColumn(i, col(m)).operatingCents).toBeLessThan(0);
    expect(rxColumn(i, col(m - 1)).operatingCents).toBeGreaterThanOrEqual(0);
  });
  test("unknown costs stay unknown; entering an assumption moves them into the total", () => {
    const i = defaultRxInput("receptionist-professional");
    const before = calculateRxDeal(i);
    expect(before.unknownCosts).toContain("Neon Postgres usage (Launch plan)");
    i.rateOverrides = { database: 20_000_000 }; // US$20/month shared: an entered assumption
    const after = calculateRxDeal(i);
    expect(after.unknownCosts).not.toContain("Neon Postgres usage (Launch plan)");
    const e0 = before.columns[1]; const e1 = after.columns[1];
    expect(e1.sharedPlatformCents - e0.sharedPlatformCents).toBe(toAudCents(2000, "USD", i.fx));
  });
  test("discounts, setup fees and non-catalogue terms are flagged, never silently approved", () => {
    const i = defaultRxInput("receptionist-premium");
    expect(calculateRxDeal(i).unapproved).toEqual([]);
    i.monthlyDiscountBps = 1000; i.setupFeeCents = 249000; i.termMonths = 3;
    const r = calculateRxDeal(i);
    expect(r.unapproved.map((u) => u.id)).toEqual(["rx-discount", "rx-setup", "rx-term"]);
    expect(rxInvoice(pricedPackage(i), 0, 0).lines[0].exGstCents).toBe(179910);
    expect(rxInvoice(pricedPackage(i), 0, 0).lines.some((l) => /setup/i.test(l.description))).toBe(false);
  });
  test("platform share is split per client and rounded up", () => {
    const i = defaultRxInput("receptionist-essential");
    const one = rxColumn(i, i.columns.expected).sharedPlatformCents;
    const three = rxColumn({ ...i, clientsSharingPlatform: 3 }, i.columns.expected).sharedPlatformCents;
    expect(three).toBe(Math.ceil(one / 3));
  });
});

describe("website project pricing", () => {
  test("confirmed offer: A$1,650 incl. GST splits 50/50 to the cent", () => {
    const w = calculateWebsite(defaultWebsiteInput()); const o = w.oneOff;
    expect([o.priceExGstCents, o.gstCents, o.totalInclGstCents]).toEqual([150000, 15000, 165000]);
    expect(o.stages.map((s) => [s.inclGstCents, s.gstCents])).toEqual([[82500, 7500], [82500, 7500]]);
    // Only the care-plan inclusions and notice remain unconfirmed; the price, stages and A$110 care price are confirmed.
    expect(w.approval.unapproved).toEqual([expect.stringContaining("Care plan inclusions")]);
  });
  test("labour, contingency and fees tie to gross profit; break-even hours really break even", () => {
    const input = defaultWebsiteInput();
    const o = calculateWebsite(input).oneOff;
    expect(o.revenueExGstCents - o.labourCents - o.contingencyCents - o.thirdPartyCents - o.paymentCostCents).toBe(o.grossProfitCents);
    // Scale planned effort to the break-even hours: profit lands within a few cents of zero.
    const be = o.pricing.breakEvenMinutes!;
    for (const k of Object.keys(input.effortMinutes) as (keyof typeof input.effortMinutes)[]) input.effortMinutes[k] = 0;
    input.revisions.includedRounds = 0; input.effortMinutes.build = be; // planned minutes; contingency is added on top
    expect(Math.abs(calculateWebsite(input).oneOff.grossProfitCents)).toBeLessThan(200);
  });
  test("price for target margin earns the target", () => {
    const input = defaultWebsiteInput(); input.payment = { label: "", percentBps: 240, fixedCents: 30, gstCreditable: true };
    const target = calculateWebsite(input).oneOff.pricing.priceForTargetExGstCents!;
    input.price = { cents: target, gst: "exclusive" };
    const o = calculateWebsite(input).oneOff;
    expect(Math.abs(o.marginBps! - 5000)).toBeLessThanOrEqual(2);
    expect(calculateWebsite(input).approval.priceMatches).toBe(false);
  });
  test("zero price: margin is undefined, not 0%, and nothing crashes", () => {
    const input = defaultWebsiteInput(); input.price = { cents: 0, gst: "inclusive" }; input.care.enabled = false;
    const w = calculateWebsite(input);
    expect(w.oneOff.marginBps).toBeNull(); expect(w.oneOff.totalInclGstCents).toBe(0);
    expect(w.oneOff.stages.every((s) => s.inclGstCents === 0 && s.feeCostCents === 0)).toBe(true);
    expect(w.recurring.marginBps).toBeNull();
  });
  test("care plan is recurring and never enters one-off revenue", () => {
    const a = defaultWebsiteInput(); const b = defaultWebsiteInput(); b.care.monthly.cents = 55000;
    expect(calculateWebsite(a).oneOff.revenueExGstCents).toBe(calculateWebsite(b).oneOff.revenueExGstCents);
    expect(calculateWebsite(b).recurring.revenueExGstCents).toBe(50000);
    expect(calculateWebsite(b).approval.careMatches).toBe(false);
  });
  test("unknown costs are listed and excluded; shared hosting is split and rounded up", () => {
    const input = defaultWebsiteInput();
    const w = calculateWebsite(input);
    expect(w.unknownCosts.length).toBe(3);
    const host = w.recurring.costLines.find((l) => l.id === "hosting")!;
    expect(host.audCents).toBe(2935);
    input.costs.find((c) => c.id === "hosting")!.sharedAcross = 4;
    expect(calculateWebsite(input).recurring.costLines.find((l) => l.id === "hosting")!.audCents).toBe(734);
  });
  test("extra revision rounds: absorbed by default, revenue only when a fee is entered (and flagged)", () => {
    const input = defaultWebsiteInput(); input.revisions.expectedExtraRounds = 2;
    const absorbed = calculateWebsite(input);
    expect(absorbed.oneOff.extraRevisionRevenueCents).toBe(0);
    expect(absorbed.oneOff.extraRevisionMinutes).toBe(240);
    input.revisions.extraRoundFeeCents = 15000;
    const charged = calculateWebsite(input);
    expect(charged.oneOff.revenueExGstCents - absorbed.oneOff.revenueExGstCents).toBe(30000);
    expect(charged.approval.unapproved.some((u) => /revision/.test(u))).toBe(true);
  });
});

describe("deals, quotes and exports", () => {
  test("synthetic seeds are clearly synthetic and pass every critical check", () => {
    for (const d of seedDeals()) {
      expect(d.synthetic).toBe(true);
      expect(d.client.business).toMatch(/synthetic/i);
      const critical = auditDeal(d, TODAY).filter((f) => f.severity === "critical" && !f.pass);
      expect(critical).toEqual([]);
    }
  });
  test("save and reopen round-trips exactly; damaged files are rejected", () => {
    const deals = seedDeals();
    expect(parseDeals(serializeDeals(deals))).toEqual(deals);
    expect(() => parseDeals("{}")).toThrow();
    expect(() => parseDeals(JSON.stringify([{ schemaVersion: 2 }]))).toThrow();
    // Older/partial deals are filled from defaults rather than crashing.
    const partial = parseDeals(JSON.stringify([{ schemaVersion: 1, id: "x", name: "Partial" }]))[0];
    expect(partial.name).toBe("Partial"); expect(partial.website.price.cents).toBe(165000);
  });
  test("quote: approved prices, no setup line, unapproved terms marked, escaped HTML", () => {
    const d = seedDeals().find((x) => x.id === "seed-realty-both")!;
    d.client.business = `<script>alert(1)</script> & Co`;
    const doc = buildQuote(d);
    expect(doc.recurring[0].money).toBeNull === undefined;
    const rx = doc.recurring.find((r) => r.label.startsWith("AI receptionist"))!;
    expect(rx.money).toEqual({ exGstCents: 69900, gstCents: 6990, inclGstCents: 76890 });
    expect(doc.oneOff.find((r) => /setup/.test(r.label))!.money).toBeNull();
    expect(doc.openDecisions).toContain(OWNER_DECISION_B);
    const html = renderQuoteHtml(doc, true);
    expect(html).toContain("DRAFT QUOTE: NOT SENT");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Before this can be sent");
    expect(renderQuoteHtml(doc, false)).not.toContain("Before this can be sent");
    expect(html).not.toMatch(/stripe\.com\/pay|checkout\.stripe|buy\.stripe/);
    const md = renderQuoteMarkdown(doc);
    expect(md).toContain("A$1,650.00");
    expect(md).toContain("Needs approval: Product readiness");
  });
  test("quote marks an entered setup fee and a discount inline", () => {
    const d = seedDeals().find((x) => x.id === "seed-edge-heavy")!; d.rx.setupFeeCents = 99000;
    const doc = buildQuote(d);
    expect(doc.oneOff.find((r) => /setup/.test(r.label))!.unapproved).toBe("Setup fees are not approved");
    expect(doc.recurring[0].unapproved).toBe("Discounted monthly fee is not approved");
    expect(renderQuoteHtml(doc)).toContain("Needs approval: Setup fees are not approved");
  });
  test("comparison CSV prints unknown as unknown and money in dollars", () => {
    const csv = comparisonCsv(seedDeals().find((x) => x.id === "seed-realty-both")!);
    expect(csv.split("\n")[0]).toContain("Revenue ex GST (A$)");
    expect(csv).toContain("1500.00");
    expect(csv).toContain("Domain registration");
    expect(csv).not.toMatch(/NaN|undefined/);
  });
  test("checks flag stale FX and a broken stage split", () => {
    const d = fillQuoteText(blankDeal(TODAY, "t")); d.website.fx.date = "2026-06-01"; d.website.stages[1].shareBps = 4000;
    const f = auditDeal(d, TODAY);
    expect(f.find((x) => x.id === "fx-age")!.pass).toBe(false);
    expect(f.find((x) => x.id === "web-calc")?.pass ?? f.find((x) => x.id === "stages-100")!.pass).toBe(false);
  });
  test("packages in the desk are the approved catalogue", () => {
    expect(getReceptionistPackage("receptionist-essential").pricing.status).toBe("approved");
    expect(RECEPTIONIST_PACKAGES.every((p) => p.pricing.setupStatus === "proposed")).toBe(true);
  });
});

import { renderAgreementHtml, SUPPLIER } from "../../src/lib/deal-desk/agreement";
describe("two-page proposal and agreement", () => {
  test("two sheets, supplier from the signed agreement, approved prices, no unapproved setup amount", () => {
    const d = seedDeals().find((x) => x.id === "seed-realty-both")!;
    const html = renderAgreementHtml(d);
    expect(html.match(/<section class="sheet">/g)!.length).toBe(2);
    expect(html).toContain(SUPPLIER.abn);
    expect(html).toContain("A$1,650.00 including GST");
    expect(html).toContain("A$768.90 per month including GST");
    expect(html).toContain("Quoted separately once approved");
    expect(html).toContain("Needs approval: billing timing is an open owner decision");
    expect(html).toContain("Ownership, cancellation and law"); // moved to page 2 when both offers are combined
  });
  test("website-only keeps the signed-agreement layout; flags appear only for changed terms", () => {
    const d = seedDeals().find((x) => x.id === "seed-legal-web")!;
    const html = renderAgreementHtml(d);
    expect(html).not.toContain("Receptionist terms in brief");
    expect(html.match(/Needs approval: [^<]*/g)).toEqual(["Needs approval: supplier address", "Needs approval: draft care terms: inclusions and notice period await confirmation (the A$110 price is confirmed)"]);
    expect(html).toContain("A$825.00 on acceptance, before work starts / A$825.00 at approved launch");
    d.rx.setupFeeCents = 99000; d.include.receptionist = true;
    expect(renderAgreementHtml(d)).toContain("Needs approval: setup fees are not approved");
  });
  test("client text is escaped", () => {
    const d = seedDeals()[0]; d.client.business = `<img src=x onerror=alert(1)>`;
    const html = renderAgreementHtml(d);
    expect(html).not.toContain("<img src=x");
  });
});

import { agreementPlan, MAX_INLINE_NOTES } from "../../src/lib/deal-desk/agreement";
import { effectiveQuote } from "../../src/lib/deal-desk/deal";
describe("agreement never drops content; quote text stays in step with the deal", () => {
  test("unedited text regenerates from the scenario; hand-edited text is kept verbatim", () => {
    const d = seedDeals().find((x) => x.id === "seed-realty-both")!;
    d.rx.packageId = "receptionist-premium";
    expect(effectiveQuote(d).scope).toContain("Premium");
    expect(buildQuote(d).scope.join(" ")).toContain("Premium");
    d.quote.customText = true; d.quote.scope = "Only this line.";
    expect(buildQuote(d).scope).toEqual(["Only this line."]);
  });
  test("standard deals need no appendix; long notes or hand-written scope go to Appendix A in full", () => {
    const d = seedDeals().find((x) => x.id === "seed-realty-both")!;
    expect(agreementPlan(d).appendix).toBe(false);
    expect(renderAgreementHtml(d)).not.toContain("Appendix A");
    const notes = Array.from({ length: MAX_INLINE_NOTES + 4 }, (_, i) => `Special term number ${i + 1}`);
    d.quote.notes = notes.join("\n");
    const html = renderAgreementHtml(d);
    expect(agreementPlan(d).appendix).toBe(true);
    for (const n of notes) expect(html).toContain(n);
    expect(html).toContain("forms part of this agreement");
    d.quote.notes = ""; d.quote.customText = true; d.quote.scope = Array.from({ length: 40 }, (_, i) => `Scope line ${i + 1}`).join("\n");
    const long = renderAgreementHtml(d);
    for (let i = 1; i <= 40; i++) expect(long).toContain(`Scope line ${i}<`);
  });
  test("flagged agreements say they are drafts; compressed terms never pose as the approved agreement", () => {
    const d = seedDeals().find((x) => x.id === "seed-dental-pro")!;
    const html = renderAgreementHtml(d);
    expect(html).toMatch(/Draft for review\. \d+ items marked/);
    expect(html).toContain("They do not replace it.");
    expect(html).toContain("Needs approval: subject to legal review");
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toMatch(/<img|M\.U\. Ventures<\/i>/i); // no stored signature image or mark
  });
  test("the agreement shows the same prices as the quote and the model", () => {
    const d = seedDeals().find((x) => x.id === "seed-edge-heavy")!;
    const doc = buildQuote(d); const html = renderAgreementHtml(d);
    const monthly = doc.recurring[0].money!;
    expect(monthly.exGstCents).toBe(calculateRxDeal(d.rx).columns[0].invoice.lines[0].exGstCents);
    expect(html).toContain(`A$${(monthly.inclGstCents / 100).toFixed(2)} per month including GST`);
  });
});
test("more than three payment stages move to an Appendix A schedule that still adds up", () => {
  const d = seedDeals().find((x) => x.id === "seed-legal-web")!;
  d.website.stages = [2000, 2000, 2000, 2000, 2000].map((shareBps, i) => ({ label: `Stage ${i + 1}`, shareBps, trigger: `On milestone ${i + 1}` }));
  const html = renderAgreementHtml(d);
  expect(agreementPlan(d).reasons).toEqual(["5 payment stages"]);
  expect(html).toContain("paid in 5 instalments totalling A$1,650.00");
  expect(html.match(/A\$330\.00<br>/g)!.length).toBe(5);
  expect(html).not.toContain(">Scope<"); // generated scope is not duplicated into the appendix
});

import { validateDeal } from "../../src/lib/deal-desk/validate";
describe("independent review fixes (3 Oct)", () => {
  const exportOf = (d: unknown) => JSON.stringify({ deals: [d] });
  test("F01: a deal that cannot be calculated is reported, never treated as sound", () => {
    const d = seedDeals()[2]; expect(validateDeal(d)).toBeNull();
    d.website.stages[1].shareBps = 3000; expect(validateDeal(d)).toMatch(/100%/);
    d.website.stages[1].shareBps = 5000; d.rx.clientsSharingPlatform = 0; expect(validateDeal(d)).toMatch(/at least 1/);
    d.rx.clientsSharingPlatform = 1; d.website.fx.usdPerAudMillionths = 0; expect(validateDeal(d)).not.toBeNull();
  });
  test("F02/F03/F14: hostile or malformed imports are rejected with a reason", () => {
    const base = () => JSON.parse(JSON.stringify(seedDeals()[2]));
    const cases: [string, (d: any) => void][] = [
      ["absurd validity", (d) => { d.quote.validDays = 1e300; }], ["bad date", (d) => { d.quote.preparedOn = "2026-13-45"; }],
      ["stage without label", (d) => { d.website.stages = [{ shareBps: 10000 }]; }], ["unknown GST mode", (d) => { d.website.price.gst = "none"; }],
      ["unknown currency", (d) => { d.website.costs[0].currency = "EUR"; }], ["absurd number", (d) => { d.rx.columns.expected.billableSeconds = 1e300; }],
      ["negative price", (d) => { d.website.price.cents = -1; }], ["fractional cents", (d) => { d.website.price.cents = 10.5; }],
      ["text as number", (d) => { d.rx.termMonths = "12"; }], ["NaN", (d) => { d.website.contingencyBps = NaN; }],
      ["zero stages", (d) => { d.website.stages = []; }], ["script in enum", (d) => { d.client.sector = "<script>"; }],
    ];
    for (const [name, mutate] of cases) { const d = base(); mutate(d); expect(() => parseDeals(exportOf(d)), name).toThrow(); }
  });
  test("F13: __proto__ and unknown keys are not copied", () => {
    const d = JSON.parse(JSON.stringify(seedDeals()[0]));
    const text = exportOf(d).replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{"polluted":true},"evil":"x","constructor":{"prototype":{"p":1}}');
    const parsed = parseDeals(text)[0] as any;
    expect(parsed.polluted).toBeUndefined(); expect(parsed.evil).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype); expect(({} as any).polluted).toBeUndefined();
  });
  test("F05/F06: break-even search respects the support-time steps", () => {
    // Support cost jumps above the allowance: the first loss is just past it, although 20x the allowance is profitable again.
    const i = defaultRxInput("receptionist-essential"); i.columns.extra.supportMinutes = 800;
    const r = calculateRxDeal(i); const b = r.breakEven;
    expect(r.columns.find((c) => c.id === "extra")!.operatingCents).toBeLessThan(0);
    expect(b.unprofitableFromMinutes).toBe(401);
    expect(b.recoversAtMinutes).not.toBeNull();
    const col = (m: number) => ({ billableSeconds: m * 60, smsSegments: Math.round(i.columns.expected.smsSegments * m * 60 / i.columns.expected.billableSeconds), supportMinutes: 800 });
    expect(rxColumn(i, col(b.recoversAtMinutes!)).operatingCents).toBeGreaterThanOrEqual(0);
    expect(rxColumn(i, col(b.recoversAtMinutes! - 1)).operatingCents).toBeLessThan(0);
    // A loss band in the lower half that recovers inside the allowance is found, not skipped to 401.
    const j = defaultRxInput("receptionist-essential"); j.columns.low.supportMinutes = 900;
    const bj = calculateRxDeal(j).breakEven;
    expect(bj.unprofitableFromMinutes).toBe(0); expect(bj.recoversAtMinutes).toBe(201);
  });
  test("F07: CSV cells that start like a formula are neutralised and always quoted", () => {
    const d = seedDeals()[2]; d.name = `=HYPERLINK("http://x","click")`;
    const csv = comparisonCsv(d);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csv.split("\n").slice(1).every((line) => !/^[=+\-@]/.test(line))).toBe(true);
  });
  test("F08: a discount row shows its amount and the rows add up to the total", () => {
    const d = seedDeals().find((x) => x.id === "seed-legal-web")!; d.website.discount = { type: "percent", bps: 1000 };
    const doc = buildQuote(d);
    const rows = doc.oneOff.filter((r) => r.money); const sum = rows.reduce((n, r) => n + r.money!.inclGstCents, 0);
    expect(doc.oneOff.find((r) => r.label === "Discount")!.money).toEqual({ exGstCents: -15000, gstCents: -1500, inclGstCents: -16500 });
    expect(sum).toBe(doc.oneOffTotal!.inclGstCents); expect(doc.oneOffTotal!.inclGstCents).toBe(148500);
  });
  test("F15/F17/F18: Markdown is neutralised; a discounted fee is not called approved; at-go-live stays visible", () => {
    const d = seedDeals().find((x) => x.id === "seed-edge-heavy")!; d.client.business = `A | B <b>bold</b>`;
    const md = renderQuoteMarkdown(buildQuote(d));
    expect(md).toContain("&lt;b&gt;bold&lt;/b&gt;"); expect(md).not.toContain("<b>"); expect(md).not.toContain("A | B");
    expect(buildQuote(d).recurring[0].detail).toContain("this discounted fee is not approved");
    const pro = seedDeals().find((x) => x.id === "seed-dental-pro")!;
    expect(renderAgreementHtml(pro)).toContain("Weekly proof report: calls, bookings, urgent calls routed, issues flagged (at go-live)");
  });
  test("F12: no break-even price when fees take the whole price", () => {
    const i = defaultWebsiteInput(); i.payment = { label: "", percentBps: 10000, fixedCents: 0, gstCreditable: false };
    expect(calculateWebsite(i).oneOff.pricing.breakEvenPriceExGstCents).toBeNull();
  });
});
test("a saved discount (percent or fixed) survives save and reopen", () => {
  const d = seedDeals()[1]; d.website.discount = { type: "percent", bps: 500 };
  const e = seedDeals()[2]; e.website.discount = { type: "fixed", cents: 12345 };
  expect(parseDeals(serializeDeals([d, e]))).toEqual([d, e]);
});

test("route to a person: callback request and staff alert, never a live transfer", () => {
  const d = seedDeals().find((x) => x.id === "seed-dental-pro")!;
  for (const text of [renderAgreementHtml(d), renderQuoteHtml(buildQuote(d), false)]) {
    expect(text).toContain("takes their details and a callback request");
    expect(text).toContain("It does not transfer live calls.");
    expect(text).not.toMatch(/transfers? (the call|you) to|put through to|connect(s|ed)? (the caller|you) (to|with) (a|your) (person|team) live/i);
  }
});
test("agreement body type is at least 10.5 pt and prints on A4 pages that flow", () => {
  const html = renderAgreementHtml(seedDeals()[2]);
  expect(html).toContain("font:10.5pt/1.5");
  expect(html).toContain("@page{size:A4;margin:13mm 15mm 14mm");
  expect(html).not.toContain("overflow:hidden");
});

import { classify, ConflictError, RequestError } from "../../tools/deal-desk/shared";
describe("second independent review (round-7 lead)", () => {
  test("1: no street address anywhere in generated documents; region only, flagged", () => {
    for (const d of seedDeals()) for (const text of [renderAgreementHtml(d), renderQuoteHtml(buildQuote(d), true), renderQuoteMarkdown(buildQuote(d)), JSON.stringify(SUPPLIER)]) {
      expect(text).not.toMatch(/\b\d+\/\d+ [A-Z][a-z]+ (Street|St|Road|Rd)\b|NSW 27\d\d/);
    }
    const html = renderAgreementHtml(seedDeals()[0]);
    expect(html).toContain("Western Sydney, NSW"); expect(html).toContain("Needs approval: supplier address");
  });
  test("4: a 409 is a revision conflict only when the server's revision differs; other refusals keep their own words", () => {
    const rec = { id: "x", rev: 5, updatedAt: "2026-10-03T00:00:00Z", updatedBy: "mehroz", deal: seedDeals()[0], draft: null, problem: null, leadId: null, crmDealRef: null, archived: false };
    const stale = classify(409, { error: "This quote workbook was changed by mehroz (now revision 5). Reload it before saving.", current: rec }, 4);
    expect(stale).toBeInstanceOf(ConflictError); expect((stale as ConflictError).current?.updatedBy).toBe("mehroz");
    for (const error of ["The lead's deal is saved as Essential but this workbook prices Professional. Change one so they agree.", "Choose the receptionist package on the lead's deal first, so the deal and this quote agree.", "Finish or discard the unfinished changes first."]) {
      const e = classify(409, { error, current: rec }, 5); // same revision: not "someone else saved"
      expect(e).toBeInstanceOf(RequestError); expect(e.message).toBe(error);
    }
    const damaged = classify(409, { error: "This quote workbook's file is damaged and was left untouched.", current: { id: "x", status: "damaged", raw: "{" } }, 3);
    expect(damaged).toBeInstanceOf(RequestError); expect(damaged.message).toContain("damaged");
    expect(classify(409, { error: "This quote workbook no longer exists on the server.", current: null }, 3)).toBeInstanceOf(ConflictError);
    expect(classify(403, { error: "Confirm this browser first (System › Devices and people), then save the quote workbook." }, 1).message).toContain("Confirm this browser first");
  });
  test("minors: no cent drift on a discounted inclusive price; long dates; timing wording counts; care flag is honest", () => {
    const d = seedDeals().find((x) => x.id === "seed-legal-web")!; d.website.price = { cents: 100_000, gst: "inclusive" }; d.website.discount = { type: "percent", bps: 1000 };
    const doc = buildQuote(d); const rows = doc.oneOff.filter((r) => r.money);
    expect(rows[0].money).toEqual({ exGstCents: 90909, gstCents: 9091, inclGstCents: 100000 }); // the quoted figure, to the cent
    expect(rows.reduce((n, r) => n + r.money!.inclGstCents, 0)).toBe(doc.oneOffTotal!.inclGstCents);
    expect(renderQuoteHtml(doc, false)).toContain("Prepared 3 October 2026");
    const t = seedDeals().find((x) => x.id === "seed-legal-web")!; t.website.stages[1].trigger = "Thirty days after launch";
    expect(calculateWebsite(t.website).approval.stagesMatch).toBe(false);
    const c = seedDeals().find((x) => x.id === "seed-legal-web")!; c.website.care.monthly.cents = 22000;
    expect(renderAgreementHtml(c)).toContain("draft care terms: price, inclusions and notice period await confirmation");
    const rx = renderAgreementHtml(seedDeals()[0]);
    expect(rx).toContain("first-month charging is an open owner decision"); expect(rx).toContain("then 30 days' written notice");
  });
});

import { refreshDecision } from "../../tools/deal-desk/shared";
describe("lead re-check (73be3421) minors", () => {
  test("(a) a newer server copy that is this tab's own save is not a conflict; a save in flight is skipped", () => {
    const base = { inFlight: false, dirty: true, timerPending: false, incoming: "A", lastSent: "A" };
    expect(refreshDecision({ ...base, inFlight: true })).toBe("skip");
    expect(refreshDecision(base)).toBe("ours"); // our save landed before its response was processed
    expect(refreshDecision({ ...base, incoming: "B" })).toBe("conflict"); // someone else's save, and we have unsaved edits
    expect(refreshDecision({ ...base, incoming: "B", dirty: false, timerPending: true })).toBe("conflict");
    expect(refreshDecision({ ...base, incoming: "B", dirty: false, lastSent: undefined })).toBe("replace"); // nothing unsaved here
  });
});
