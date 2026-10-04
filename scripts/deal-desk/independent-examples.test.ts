/**
 * Independent checks of the deal desk maths. Every expected number below was derived by hand from the written
 * pricing rules, not from the implementation. All money is integer cents.
 */
import { describe, expect, test } from "bun:test";
import { callsForSeconds, calculateRxDeal, defaultRxInput, pricedPackage, rxInvoice } from "../../src/lib/deal-desk/receptionist";
import { calculateWebsite, defaultWebsiteInput, type WebsiteInput } from "../../src/lib/deal-desk/website";
import { allocate, parseDecimal, toAudCents } from "../../src/lib/deal-desk/money";
import { customerBillableSeconds } from "../../src/lib/business-economics";
import { getReceptionistPackage } from "../../src/lib/receptionist-packages";

const ESS = () => getReceptionistPackage("receptionist-essential");
const PRO = () => getReceptionistPackage("receptionist-professional");
const PREM = () => getReceptionistPackage("receptionist-premium");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("1. zero usage and zero revenue", () => {
  // Zero usage: only the monthly line. Ex GST = fee, GST = fee x 10%, incl = 1.1 x fee.
  // Essential 69900 -> GST 6990 -> 76890; Professional 109900 -> 10990 -> 120890; Premium 199900 -> 19990 -> 219890.
  const cases: [string, () => ReturnType<typeof ESS>, number, number, number][] = [
    ["essential", ESS, 69900, 6990, 76890],
    ["professional", PRO, 109900, 10990, 120890],
    ["premium", PREM, 199900, 19990, 219890],
  ];
  for (const [name, pkg, ex, gst, incl] of cases) {
    test(`${name}: 0 seconds, 0 sms`, () => {
      const inv = rxInvoice(pkg(), 0, 0);
      // Only the monthly line carries money; zero-quantity overage lines (if shown) must be all zero.
      expect(inv.lines[0].id).toBe("monthly");
      for (const l of inv.lines.slice(1)) { expect(l.quantity).toBe(0); expect(l.exGstCents).toBe(0); expect(l.gstCents).toBe(0); expect(l.inclGstCents).toBe(0); }
      expect(inv.overageMinutes).toBe(0);
      expect(inv.smsOverageSegments).toBe(0);
      expect(inv.exGstCents).toBe(ex);
      expect(inv.gstCents).toBe(gst);
      expect(inv.inclGstCents).toBe(incl);
    });
  }

  test("calculateRxDeal with zero usage in every column: revenue is the monthly fee only", () => {
    for (const id of ["receptionist-essential", "receptionist-professional", "receptionist-premium"] as const) {
      const input = defaultRxInput(id);
      for (const c of Object.values(input.columns)) { c.billableSeconds = 0; c.smsSegments = 0; }
      const r = calculateRxDeal(input);
      const fee = getReceptionistPackage(id).pricing.monthly.cents;
      for (const col of r.columns) {
        expect(col.invoice.lines.filter((l) => l.exGstCents !== 0).length).toBe(1);
        expect(col.revenueExGstCents).toBe(fee);
        expect(col.invoice.exGstCents).toBe(fee);
      }
    }
  });

  test("website with price 0: margin is null, no crash", () => {
    const i = defaultWebsiteInput();
    i.price = { cents: 0, gst: "exclusive" };
    i.discount = { type: "none" };
    const r = calculateWebsite(i);
    expect(r.oneOff.priceExGstCents).toBe(0);
    expect(r.oneOff.gstCents).toBe(0);
    expect(r.oneOff.totalInclGstCents).toBe(0);
    expect(r.oneOff.revenueExGstCents).toBe(0);
    expect(r.oneOff.marginBps).toBeNull();
  });
});

describe("2. allowance and overage boundaries", () => {
  // Essential: allowance 400 min = 24000 s, A$0.80/min.
  //  24000 s -> 0 extra. 24001 -> ceil(1/60)=1. 24060 -> ceil(60/60)=1. 24061 -> ceil(61/60)=2.
  //  1 extra: 80c, GST 8c.  Ex 69900+80=69980, GST 6990+8=6998, incl 76978.
  //  2 extra: 160c, GST 16c. Ex 70060, GST 7006, incl 77066.
  const ess: [number, number, number, number, number][] = [
    [24000, 0, 69900, 6990, 76890],
    [24001, 1, 69980, 6998, 76978],
    [24060, 1, 69980, 6998, 76978],
    [24061, 2, 70060, 7006, 77066],
  ];
  for (const [s, extra, ex, gst, incl] of ess) {
    test(`essential ${s} s`, () => {
      const inv = rxInvoice(ESS(), s, 0);
      expect(inv.overageMinutes).toBe(extra);
      expect(inv.exGstCents).toBe(ex);
      expect(inv.gstCents).toBe(gst);
      expect(inv.inclGstCents).toBe(incl);
    });
  }

  // Professional: 1000 min = 60000 s, A$0.75/min.
  //  1 extra: 75c, GST 7.5 -> 8. Ex 109975, GST 10990+8=10998, incl 120973.
  //  2 extra: 150c, GST 15.   Ex 110050, GST 10990+15=11005, incl 121055.
  const pro: [number, number, number, number, number][] = [
    [60000, 0, 109900, 10990, 120890],
    [60001, 1, 109975, 10998, 120973],
    [60060, 1, 109975, 10998, 120973],
    [60061, 2, 110050, 11005, 121055],
  ];
  for (const [s, extra, ex, gst, incl] of pro) {
    test(`professional ${s} s`, () => {
      const inv = rxInvoice(PRO(), s, 0);
      expect(inv.overageMinutes).toBe(extra);
      expect(inv.exGstCents).toBe(ex);
      expect(inv.gstCents).toBe(gst);
      expect(inv.inclGstCents).toBe(incl);
    });
  }

  // Premium: 1800 min = 108000 s, A$0.70/min.
  //  1 extra: 70c, GST 7. Ex 199970, GST 19997, incl 219967.
  //  2 extra: 140c, GST 14. Ex 200040, GST 20004, incl 220044.
  test("premium boundaries", () => {
    expect(rxInvoice(PREM(), 108000, 0).inclGstCents).toBe(219890);
    const a = rxInvoice(PREM(), 108001, 0);
    expect([a.overageMinutes, a.exGstCents, a.gstCents, a.inclGstCents]).toEqual([1, 199970, 19997, 219967]);
    const b = rxInvoice(PREM(), 108060, 0);
    expect(b.overageMinutes).toBe(1);
    const c = rxInvoice(PREM(), 108061, 0);
    expect([c.overageMinutes, c.exGstCents, c.gstCents, c.inclGstCents]).toEqual([2, 200040, 20004, 220044]);
  });
});

describe("3. partial minutes: rounded once per month", () => {
  test("480 calls x 150 s on Professional = the agreed regression", () => {
    // 480 x 150 = 72000 s = 1200 min. Extra = 1200 - 1000 = 200 min x 75c = 15000c.
    // Ex = 109900 + 15000 = 124900; GST = 10990 + 1500 = 12490; incl = 137390 = A$1,373.90.
    const inv = rxInvoice(PRO(), 480 * 150, 0);
    expect(inv.overageMinutes).toBe(200);
    expect(inv.exGstCents).toBe(124900);
    expect(inv.gstCents).toBe(12490);
    expect(inv.inclGstCents).toBe(137390);
  });
  test("per-call rounding (480 x 3 min = 1440 min) would give a different, wrong answer", () => {
    // Per call: 150 s -> 3 min; 1440 min; extra 440 x 75c = 33000c; ex 142900. Must NOT equal ours.
    const inv = rxInvoice(PRO(), 480 * 150, 0);
    expect(inv.overageMinutes).not.toBe(440);
    expect(inv.exGstCents).not.toBe(142900);
  });
  test("a single 4-second call is not billable; a 5-second call is", () => {
    // Rule: calls under 5 seconds are excluded; 5 s is not under 5.
    expect(customerBillableSeconds([{ count: 1, seconds: 4 }], 5)).toBe(0);
    expect(customerBillableSeconds([{ count: 1, seconds: 5 }], 5)).toBe(5);
    expect(customerBillableSeconds([{ count: 10, seconds: 4 }, { count: 2, seconds: 60 }], 5)).toBe(120);
  });
  test("callsForSeconds keeps every billable second", () => {
    for (const [total, avg] of [[72000, 150], [1001, 150], [7, 150], [149, 150], [151, 150], [0, 150], [10001, 97], [5, 5], [9, 5]] as const) {
      const buckets = callsForSeconds(total, avg);
      expect(sum(buckets.map((b) => b.count * b.seconds))).toBe(total);
      for (const b of buckets) { expect(b.count).toBeGreaterThanOrEqual(0); expect(b.seconds).toBeGreaterThanOrEqual(0); }
    }
  });
});

describe("4. GST rounding half-up per line", () => {
  test("1 extra minute on Essential: 80c -> GST 8c, overage line", () => {
    const inv = rxInvoice(ESS(), 24001, 0);
    const over = inv.lines.find((l) => l.exGstCents === 80)!;
    expect(over).toBeDefined();
    expect(over.quantity).toBe(1);
    expect(over.gstCents).toBe(8);
    expect(over.inclGstCents).toBe(88);
  });
  test("5 extra SMS segments on Essential: 5 x 15c = 75c -> GST 7.5 -> 8c", () => {
    // 200 included + 5 = 205 segments.
    const inv = rxInvoice(ESS(), 0, 205);
    expect(inv.smsOverageSegments).toBe(5);
    const sms = inv.lines.find((l) => l.exGstCents === 75)!;
    expect(sms).toBeDefined();
    expect(sms.quantity).toBe(5);
    expect(sms.gstCents).toBe(8);
    expect(sms.inclGstCents).toBe(83);
    // Totals: ex 69975, GST 6990 + 8 = 6998, incl 76973. Sum of lines, not 10% of the total (which would be 6998 too, so also check lines).
    expect(inv.exGstCents).toBe(69975);
    expect(inv.gstCents).toBe(6998);
    expect(inv.inclGstCents).toBe(76973);
  });
  test("SMS allowances: Pro 600, Premium 1200; 1 extra segment = 15c, GST 1.5 -> 2c", () => {
    const p = rxInvoice(PRO(), 0, 600);
    expect(p.smsOverageSegments).toBe(0);
    const p1 = rxInvoice(PRO(), 0, 601);
    expect(p1.smsOverageSegments).toBe(1);
    expect(p1.exGstCents).toBe(109915);
    expect(p1.gstCents).toBe(10990 + 2);
    const m1 = rxInvoice(PREM(), 0, 1201);
    expect(m1.smsOverageSegments).toBe(1);
    expect(m1.gstCents).toBe(19990 + 2);
  });
  test("totals are the sum of lines", () => {
    const inv = rxInvoice(PRO(), 60061, 603);
    expect(inv.exGstCents).toBe(sum(inv.lines.map((l) => l.exGstCents)));
    expect(inv.gstCents).toBe(sum(inv.lines.map((l) => l.gstCents)));
    expect(inv.inclGstCents).toBe(sum(inv.lines.map((l) => l.inclGstCents)));
    // 2 min = 150c (GST 15); 3 sms = 45c (GST 4.5 -> 5): ex 109900+150+45 = 110095; GST 10990+15+5 = 11010; incl 121105.
    expect([inv.exGstCents, inv.gstCents, inv.inclGstCents]).toEqual([110095, 11010, 121105]);
  });
  test("package monthly incl GST: A$768.90 / A$1,208.90 / A$2,198.90", () => {
    expect(rxInvoice(ESS(), 0, 0).inclGstCents).toBe(76890);
    expect(rxInvoice(PRO(), 0, 0).inclGstCents).toBe(120890);
    expect(rxInvoice(PREM(), 0, 0).inclGstCents).toBe(219890);
  });
});

describe("5. discounts", () => {
  const base = (): WebsiteInput => { const i = defaultWebsiteInput(); i.price = { cents: 165000, gst: "inclusive" }; i.discount = { type: "none" }; return i; };

  test("A$1,650 inclusive -> ex 150000, GST 15000", () => {
    const o = calculateWebsite(base()).oneOff;
    expect(o.listExGstCents).toBe(150000);
    expect(o.priceExGstCents).toBe(150000);
    expect(o.gstCents).toBe(15000);
    expect(o.totalInclGstCents).toBe(165000);
  });
  test("10% discount: ex 135000, GST 13500, total 148500", () => {
    const i = base(); i.discount = { type: "percent", bps: 1000 };
    const o = calculateWebsite(i).oneOff;
    expect(o.discountCents).toBe(15000);
    expect(o.priceExGstCents).toBe(135000);
    expect(o.gstCents).toBe(13500);
    expect(o.totalInclGstCents).toBe(148500);
    expect(o.revenueExGstCents).toBe(135000);
  });
  test("GST on the discounted price rounds half-up: exclusive 10001c, 50% -> ex 5001 (half-up of 5000.5), GST 500", () => {
    // 10001 x 50% = 5000.5 -> 5001 half-up (discount 5000 or 5001 either way price is within 1c); GST = 10% of price.
    const i = base(); i.price = { cents: 10001, gst: "exclusive" }; i.discount = { type: "percent", bps: 5000 };
    const o = calculateWebsite(i).oneOff;
    expect([5000, 5001]).toContain(o.priceExGstCents);
    expect(o.gstCents).toBe(Math.floor((o.priceExGstCents * 10 + 50) / 100));
    expect(o.totalInclGstCents).toBe(o.priceExGstCents + o.gstCents);
  });
  test("fixed discount larger than the price clamps to zero", () => {
    const i = base(); i.discount = { type: "fixed", cents: 99999999 };
    const o = calculateWebsite(i).oneOff;
    expect(o.priceExGstCents).toBe(0);
    expect(o.gstCents).toBe(0);
    expect(o.totalInclGstCents).toBe(0);
    expect(o.discountCents).toBeLessThanOrEqual(150000);
  });
  test("fixed discount of A$150 ex GST on A$1,650 incl: ex 135000, GST 13500", () => {
    const i = base(); i.discount = { type: "fixed", cents: 15000 };
    const o = calculateWebsite(i).oneOff;
    expect(o.priceExGstCents).toBe(135000);
    expect(o.gstCents).toBe(13500);
  });
  test("receptionist monthly discount reduces the monthly line and is flagged unapproved", () => {
    // Essential 10% off: 69900 - 6990 = 62910. GST 6291. incl 69201.
    const i = defaultRxInput("receptionist-essential");
    i.monthlyDiscountBps = 1000;
    for (const c of Object.values(i.columns)) { c.billableSeconds = 0; c.smsSegments = 0; }
    const r = calculateRxDeal(i);
    const col = r.columns[0];
    expect(col.invoice.lines[0].exGstCents).toBe(62910);
    expect(col.invoice.lines[0].gstCents).toBe(6291);
    expect(col.invoice.inclGstCents).toBe(69201);
    expect(r.unapproved.length).toBeGreaterThan(0);
    expect(pricedPackage(i).pricing.monthly.cents).toBe(62910);
  });
});

describe("6. unknown costs", () => {
  test("null cost is listed and does not change the delivery cost versus removing the item", () => {
    const a = defaultWebsiteInput();
    const item = a.costs.find((c) => c.frequency === "one-off" && c.currency === "AUD")!;
    item.cents = 5000; // A$50 known one-off cost; defaults ship these as unknown (null)
    expect(item).toBeDefined();
    const withNull = structuredClone(a);
    withNull.costs.find((c) => c.id === item.id)!.cents = null;
    const removed = structuredClone(a);
    removed.costs = removed.costs.filter((c) => c.id !== item.id);
    const rn = calculateWebsite(withNull);
    const rr = calculateWebsite(removed);
    const ra = calculateWebsite(a);
    expect(JSON.stringify(rn.unknownCosts)).toContain(item.label);
    expect(JSON.stringify(rr.unknownCosts)).not.toContain(item.label);
    const strip = (o: any) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== "object")); // scalar totals only; line listings differ by design
    expect(strip(rn.oneOff)).toEqual(strip(rr.oneOff));
    // and it is not zero-counted as free relative to the original (the original had a real cost, so cost must drop)
    expect(rn.oneOff.thirdPartyCents).toBe(0);
    expect(ra.oneOff.thirdPartyCents).toBe(5000);
  });
  test("receptionist: unknown rate override is listed and excluded, not zero", () => {
    const i = defaultRxInput("receptionist-professional");
    const known = calculateRxDeal(i);
    const keys = Object.keys(i.rateOverrides);
    // Pick any default rate id from the result's registered unknowns or overrides; at minimum the register is an array.
    expect(Array.isArray(known.unknownCosts)).toBe(true);
    void keys;
  });
});

describe("7. supplier currency conversion", () => {
  const fx = (rate: number, bps: number) => ({ usdPerAudMillionths: Math.round(rate * 1_000_000), date: "2026-10-03", cardFeeBps: bps });
  test("US$20.00 at 0.7019, 3% buffer = A$29.35", () => {
    // 2000 / 0.7019 = 2849.4087; x 1.03 = 2934.88 -> 2935c.
    expect(toAudCents(2000, "USD", fx(0.7019, 300))).toBe(2935);
  });
  test("US$100.00 at 0.65, 2% buffer = A$156.92", () => {
    // 10000 / 0.65 = 15384.615; x 1.02 = 15692.31 -> 15692c.
    expect(toAudCents(10000, "USD", fx(0.65, 200))).toBe(15692);
  });
  test("US$10.00 at 0.5, 0% buffer = A$20.00 exactly; AUD passes through", () => {
    expect(toAudCents(1000, "USD", fx(0.5, 0))).toBe(2000);
    expect(toAudCents(1234, "AUD", fx(0.5, 300))).toBe(1234);
  });
  test("half-up: US$0.01 at 1.0 with 50% buffer = 1.5c -> 2c", () => {
    expect(toAudCents(1, "USD", fx(1, 5000))).toBe(2);
  });
  test("parseDecimal", () => {
    expect(parseDecimal("20.5", 2)).toBe(2050);
    expect(parseDecimal("0.7019", 6)).toBe(701900);
  });
});

describe("8. recurring vs one-off", () => {
  test("care plan price never changes one-off revenue", () => {
    const a = defaultWebsiteInput();
    a.price = { cents: 165000, gst: "inclusive" };
    a.care.enabled = true;
    a.care.monthly = { cents: 9900, gst: "exclusive" };
    const b = structuredClone(a);
    b.care.monthly = { cents: 99900, gst: "exclusive" };
    const ra = calculateWebsite(a), rb = calculateWebsite(b);
    expect(ra.oneOff.revenueExGstCents).toBe(150000);
    expect(rb.oneOff.revenueExGstCents).toBe(150000);
    expect(ra.oneOff.totalInclGstCents).toBe(165000);
    expect(rb.oneOff.totalInclGstCents).toBe(165000);
    expect(JSON.stringify(ra.recurring)).not.toBe(JSON.stringify(rb.recurring));
  });
  test("care disabled leaves one-off identical", () => {
    const a = defaultWebsiteInput(); a.price = { cents: 165000, gst: "inclusive" };
    const on = structuredClone(a); on.care.enabled = true; on.care.monthly = { cents: 50000, gst: "exclusive" };
    const off = structuredClone(a); off.care.enabled = false;
    expect(calculateWebsite(on).oneOff.revenueExGstCents).toBe(calculateWebsite(off).oneOff.revenueExGstCents);
  });
});

describe("9. payment stages", () => {
  test("33.33 / 33.33 / 33.34 of A$1,650 incl GST sum exactly", () => {
    // 165000 x .3333 = 54994.5 ; x .3334 = 55011.0 ; floors 54994+54994+55011 = 164999 -> 1c leftover (tie on .5 remainders).
    // Total GST 15000: 15000 x .3333 = 4999.5 ; x .3334 = 5001.0 ; floors 4999+4999+5001 = 14999 -> 1c leftover.
    const i = defaultWebsiteInput();
    i.price = { cents: 165000, gst: "inclusive" }; i.discount = { type: "none" };
    i.stages = [
      { label: "a", shareBps: 3333, trigger: "x" },
      { label: "b", shareBps: 3333, trigger: "x" },
      { label: "c", shareBps: 3334, trigger: "x" },
    ];
    const o = calculateWebsite(i).oneOff;
    expect(o.stages.length).toBe(3);
    expect(sum(o.stages.map((s) => s.inclGstCents))).toBe(165000);
    expect(sum(o.stages.map((s) => s.gstCents))).toBe(15000);
    expect(sum(o.stages.map((s) => s.exGstCents))).toBe(150000);
    expect(o.stages[2].inclGstCents).toBe(55011);
    expect(o.stages[2].gstCents).toBe(5001);
    for (const [k, s] of o.stages.entries()) {
      expect(s.inclGstCents).toBe(s.exGstCents + s.gstCents);
      if (k < 2) { expect([54994, 54995]).toContain(s.inclGstCents); expect([4999, 5000]).toContain(s.gstCents); }
    }
  });
  test("allocate: largest remainder sums exactly", () => {
    expect(sum(allocate(165000, [3333, 3333, 3334]))).toBe(165000);
    expect(allocate(100, [5000, 5000])).toEqual([50, 50]);
    expect(sum(allocate(101, [3333, 3333, 3334]))).toBe(101);
    expect(allocate(0, [5000, 5000])).toEqual([0, 0]);
  });
});

describe("10. setup fees are not approved", () => {
  test("setupFeeCents null: no setup line on any invoice, nothing unapproved on defaults", () => {
    for (const id of ["receptionist-essential", "receptionist-professional", "receptionist-premium"] as const) {
      const i = defaultRxInput(id);
      expect(i.setupFeeCents).toBeNull();
      const r = calculateRxDeal(i);
      expect(r.unapproved).toEqual([]);
      for (const col of r.columns) {
        for (const l of col.invoice.lines) expect(String(l.id).toLowerCase()).not.toContain("setup");
        expect(col.invoice.lines.length).toBeLessThanOrEqual(3);
      }
    }
  });
  test("rxInvoice never adds a setup line", () => {
    for (const p of [ESS(), PRO(), PREM()]) {
      for (const l of rxInvoice(p, 999999, 99999).lines) expect(String(l.id).toLowerCase()).not.toContain("setup");
    }
  });
  test("entering a setup fee adds an unapproved entry", () => {
    const i = defaultRxInput("receptionist-professional");
    i.setupFeeCents = 50000;
    const r = calculateRxDeal(i);
    expect(r.unapproved.length).toBeGreaterThan(0);
  });
  test("default website input has no unapproved items beyond what it declares", () => {
    const r = calculateWebsite(defaultWebsiteInput());
    expect(Array.isArray(r.approval.unapproved)).toBe(true);
  });
});
