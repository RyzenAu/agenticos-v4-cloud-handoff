/**
 * Website project pricing model (deal desk, 3 Oct 2026). Pure and deterministic.
 *
 * One-off project figures and the ongoing care plan are calculated and reported separately: a monthly
 * fee is never folded into project revenue. Unknown costs stay null, are listed, and are excluded from
 * every subtotal (never treated as zero). Founder labour is an assumption valued at an hourly rate, so
 * "gross profit" here is an estimate, not measured profit.
 */
import { DEFAULT_FX, DEFAULT_LABOUR_HOURLY_CENTS, RATE_SOURCES, STRIPE_BILLING_BPS, STRIPE_CARD_BPS } from "../business-economics";
import { allocate, int, mulDiv, paymentFee, ratioBps, splitGst, toAudCents, type Currency, type Fx, type PaymentFee } from "./money";

export type Evidence = "owner-confirmed" | "public-list" | "assumption" | "entered" | "unknown";
export type CostItem = {
  id: string; label: string; currency: Currency;
  /** null = unknown. Never a free cost. */
  cents: number | null;
  frequency: "one-off" | "monthly";
  /** A shared subscription divided over this many client sites (1 = this client carries all of it). */
  sharedAcross: number;
  evidence: Evidence; source: string | null; checkedAt: string | null; note: string;
};
export type Discount = { type: "none" } | { type: "percent"; bps: number } | { type: "fixed"; cents: number };
export type Stage = { label: string; shareBps: number; trigger: string };
export type EffortKey = "discovery" | "design" | "build" | "content" | "cms" | "qa" | "pm";
export const EFFORT_LABELS: Readonly<Record<EffortKey, string>> = {
  discovery: "Discovery and planning", design: "Design", build: "Build", content: "Content preparation",
  cms: "CMS / editing setup", qa: "Testing and launch", pm: "Client communication",
};
export type CmsComplexity = "none" | "simple" | "structured" | "custom";
/** Planning assumptions for CMS effort, in minutes. Not measured. */
export const CMS_PRESETS: Readonly<Record<CmsComplexity, { minutes: number; label: string }>> = {
  none: { minutes: 0, label: "No CMS (we make the changes)" },
  simple: { minutes: 120, label: "Simple (a few editable pages)" },
  structured: { minutes: 360, label: "Structured (listings, team, blog)" },
  custom: { minutes: 900, label: "Custom (integrations or data feeds)" },
};

export type WebsiteInput = {
  kind: "build" | "redesign";
  price: { cents: number; gst: "inclusive" | "exclusive" };
  discount: Discount;
  labourHourlyCents: number;
  effortMinutes: Record<EffortKey, number>;
  cmsComplexity: CmsComplexity;
  revisions: { includedRounds: number; minutesPerRound: number; expectedExtraRounds: number; /** ex GST; null = extra rounds are absorbed, not charged. */ extraRoundFeeCents: number | null };
  costs: CostItem[];
  contingencyBps: number;
  /** Planning target for the build's gross margin (an assumption, used only for the "price for target" figure). */
  targetMarginBps: number;
  stages: Stage[];
  payment: PaymentFee;
  care: {
    enabled: boolean; monthly: { cents: number; gst: "inclusive" | "exclusive" };
    maintenanceMinutes: number; includedChangeMinutes: number; expectedChangeMinutes: number; termMonths: number;
  };
  fx: Fx;
};

/**
 * The only owner-confirmed website figures on record: the offer in scripts/leads/sales-backoffice.ts
 * (WEBSITE_OFFER), which is also the signed first-client deal. scripts/deal-desk/website.test.ts fails
 * if this drifts from that constant. Anything else entered in the desk is a scenario, not an approved price.
 */
export const WEBSITE_BASELINE = {
  priceCents: 165_000, depositCents: 82_500, carePlanMonthlyCents: 11_000, gst: "inclusive" as const,
  source: "scripts/leads/sales-backoffice.ts WEBSITE_OFFER (owner-confirmed; the signed first-client deal, 17 Sep 2026)",
};

export const PAYMENT_PRESETS: readonly PaymentFee[] = [
  { label: "Bank transfer (no fee)", percentBps: 0, fixedCents: 0, gstCreditable: false },
  { label: `Stripe card ${STRIPE_CARD_BPS / 100}% + A$0.30`, percentBps: STRIPE_CARD_BPS, fixedCents: 30, gstCreditable: true },
  { label: `Stripe card + Billing ${(STRIPE_CARD_BPS + STRIPE_BILLING_BPS) / 100}% + A$0.30`, percentBps: STRIPE_CARD_BPS + STRIPE_BILLING_BPS, fixedCents: 30, gstCreditable: true },
];

const cost = (c: Omit<CostItem, "sharedAcross"> & { sharedAcross?: number }): CostItem => ({ sharedAcross: 1, ...c });
export function defaultWebsiteInput(): WebsiteInput {
  return {
    kind: "build",
    price: { cents: WEBSITE_BASELINE.priceCents, gst: WEBSITE_BASELINE.gst },
    discount: { type: "none" },
    labourHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    effortMinutes: { discovery: 120, design: 480, build: 840, content: 240, cms: CMS_PRESETS.simple.minutes, qa: 180, pm: 120 },
    cmsComplexity: "simple",
    revisions: { includedRounds: 2, minutesPerRound: 120, expectedExtraRounds: 0, extraRoundFeeCents: null },
    costs: [
      cost({ id: "domain", label: "Domain registration (if M&U registers it)", currency: "AUD", cents: null, frequency: "one-off", evidence: "unknown", source: null, checkedAt: null, note: "No domain cost is on record. Enter the registrar's price, or leave unknown." }),
      cost({ id: "assets", label: "Stock imagery, fonts or generated assets", currency: "AUD", cents: null, frequency: "one-off", evidence: "unknown", source: null, checkedAt: null, note: "Depends on the project; nothing recorded." }),
      cost({ id: "hosting", label: "Vercel Pro seat (shared across client sites)", currency: "USD", cents: 2000, frequency: "monthly", evidence: "public-list", source: RATE_SOURCES.vercel, checkedAt: "2026-09-28", note: "US$20/month list price, re-read 28 Sep 2026. Usage beyond the included credit is unknown. Shared: set how many client sites carry it." }),
      cost({ id: "domain-renewal", label: "Domain renewal (monthly share)", currency: "AUD", cents: null, frequency: "monthly", evidence: "unknown", source: null, checkedAt: null, note: "Unknown until the registrar and payer are agreed." }),
    ],
    contingencyBps: 1000,
    targetMarginBps: 5000,
    stages: [
      { label: "Deposit to start", shareBps: 5000, trigger: "On acceptance, before work starts" },
      { label: "Balance", shareBps: 5000, trigger: "At approved launch" },
    ],
    payment: { ...PAYMENT_PRESETS[0] },
    care: { enabled: true, monthly: { cents: WEBSITE_BASELINE.carePlanMonthlyCents, gst: WEBSITE_BASELINE.gst }, maintenanceMinutes: 30, includedChangeMinutes: 30, expectedChangeMinutes: 30, termMonths: 12 },
    fx: { ...DEFAULT_FX },
  };
}

function knownCosts(items: readonly CostItem[], frequency: CostItem["frequency"], fx: Fx) {
  const lines = items.filter((c) => c.frequency === frequency).map((c) => {
    int(c.sharedAcross, `${c.label}: shared across`, 100000);
    if (c.sharedAcross < 1) throw new Error(`${c.label}: shared across must be at least 1`);
    if (c.cents === null) return { ...c, audCents: null as number | null };
    const full = toAudCents(int(c.cents, c.label), c.currency, fx);
    // A share of a shared bill is rounded up: under-allocating a real cost flatters the margin.
    return { ...c, audCents: Math.ceil(full / c.sharedAcross) as number | null };
  });
  return {
    lines,
    knownCents: lines.reduce((n, l) => n + (l.audCents ?? 0), 0),
    unknown: lines.filter((l) => l.audCents === null).map((l) => l.label),
  };
}

export function calculateWebsite(input: WebsiteInput) {
  const hourly = int(input.labourHourlyCents, "hourly rate");
  const list = splitGst(int(input.price.cents, "price"), input.price.gst);
  const discountCents = input.discount.type === "percent" ? mulDiv(list.netCents, int(input.discount.bps, "discount", 10000), 10000)
    : input.discount.type === "fixed" ? Math.min(int(input.discount.cents, "discount"), list.netCents) : 0;
  // No discount: keep the quoted figure to the cent. With a discount, GST is recalculated on the reduced ex-GST price.
  const net = discountCents === 0 ? list : splitGst(list.netCents - discountCents, "exclusive");
  const r = input.revisions;
  int(r.includedRounds, "included revision rounds", 100); int(r.minutesPerRound, "minutes per revision round"); int(r.expectedExtraRounds, "extra revision rounds", 100);
  const extraRevisionRevenue = r.extraRoundFeeCents === null ? 0 : int(r.extraRoundFeeCents, "extra round fee") * r.expectedExtraRounds;
  const revenueExGst = net.netCents + extraRevisionRevenue;

  const effort = (Object.keys(EFFORT_LABELS) as EffortKey[]).map((key) => {
    const minutes = int(input.effortMinutes[key], EFFORT_LABELS[key]);
    return { key, label: EFFORT_LABELS[key], minutes, cents: mulDiv(minutes, hourly, 60) };
  });
  const includedRevisionMinutes = r.includedRounds * r.minutesPerRound;
  const extraRevisionMinutes = r.expectedExtraRounds * r.minutesPerRound;
  const minutes = effort.reduce((n, e) => n + e.minutes, 0) + includedRevisionMinutes + extraRevisionMinutes;
  const labourCents = mulDiv(minutes, hourly, 60);
  const thirdParty = knownCosts(input.costs, "one-off", input.fx);
  const contingency = int(input.contingencyBps, "contingency", 10000);
  const labourContingencyCents = mulDiv(labourCents, contingency, 10000);
  const thirdPartyContingencyCents = mulDiv(thirdParty.knownCents, contingency, 10000);

  const stageIncl = allocate(net.grossCents, input.stages.map((s) => s.shareBps));
  const stageGst = allocate(net.gstCents, input.stages.map((s) => s.shareBps));
  const stages = input.stages.map((s, i) => {
    const fee = paymentFee(stageIncl[i], input.payment);
    return { ...s, inclGstCents: stageIncl[i], gstCents: stageGst[i], exGstCents: stageIncl[i] - stageGst[i], feeCostCents: fee.costCents };
  });
  const paymentCostCents = stages.reduce((n, s) => n + s.feeCostCents, 0);

  const nonLabourCents = thirdParty.knownCents + thirdPartyContingencyCents + paymentCostCents;
  const deliveryCostCents = labourCents + labourContingencyCents + nonLabourCents;
  const grossProfitCents = revenueExGst - deliveryCostCents;
  const contingencyMinutes = mulDiv(minutes, contingency, 10000);
  const oneOff = {
    listExGstCents: list.netCents, listGstCents: list.gstCents, discountCents, priceExGstCents: net.netCents, gstCents: net.gstCents, totalInclGstCents: net.grossCents,
    extraRevisionRevenueCents: extraRevisionRevenue, revenueExGstCents: revenueExGst,
    effort, includedRevisionMinutes, extraRevisionMinutes, minutes, labourCents,
    thirdPartyLines: thirdParty.lines, thirdPartyCents: thirdParty.knownCents,
    contingencyCents: labourContingencyCents + thirdPartyContingencyCents, contingencyMinutes,
    paymentCostCents, deliveryCostCents, grossProfitCents, marginBps: ratioBps(grossProfitCents, revenueExGst),
    /** What an hour of founder time earns after non-labour costs: planned hours, and if the contingency hours are used. */
    effectiveHourlyCents: minutes === 0 ? null : Math.round((revenueExGst - thirdParty.knownCents - paymentCostCents) * 60 / minutes),
    effectiveHourlyWithContingencyCents: minutes + contingencyMinutes === 0 ? null : Math.round((revenueExGst - nonLabourCents) * 60 / (minutes + contingencyMinutes)),
    stages, unknownCosts: thirdParty.unknown,
  };

  const c = input.care;
  const careSplit = c.enabled ? splitGst(int(c.monthly.cents, "care plan price"), c.monthly.gst) : { grossCents: 0, netCents: 0, gstCents: 0 };
  const monthlyCosts = knownCosts(c.enabled ? input.costs : [], "monthly", input.fx);
  const careMinutes = c.enabled ? int(c.maintenanceMinutes, "maintenance minutes") + int(c.expectedChangeMinutes, "expected change minutes") : 0;
  const careLabour = mulDiv(careMinutes, hourly, 60);
  const careFee = paymentFee(careSplit.grossCents, input.payment).costCents;
  const careCost = careLabour + monthlyCosts.knownCents + careFee;
  const careProfit = careSplit.netCents - careCost;
  const term = int(c.termMonths, "care plan months", 120);
  const recurring = {
    enabled: c.enabled, revenueExGstCents: careSplit.netCents, gstCents: careSplit.gstCents, inclGstCents: careSplit.grossCents,
    minutes: careMinutes, labourCents: careLabour, costLines: monthlyCosts.lines, thirdPartyCents: monthlyCosts.knownCents, paymentCostCents: careFee,
    costCents: careCost, profitCents: careProfit, marginBps: ratioBps(careProfit, careSplit.netCents),
    effectiveHourlyCents: careMinutes === 0 ? null : Math.round((careSplit.netCents - monthlyCosts.knownCents - careFee) * 60 / careMinutes),
    changeMinutesOverIncluded: c.enabled ? Math.max(0, c.expectedChangeMinutes - c.includedChangeMinutes) : 0,
    unknownCosts: monthlyCosts.unknown,
  };

  // Break-even and target pricing for the build. Labour and its contingency scale together; payment fees are a
  // share of the GST-inclusive price (fee GST credited when creditable). Target is a share of ex-GST revenue.
  const target = int(input.targetMarginBps, "target margin", 9999);
  const loadedHourly = hourly * (10000 + contingency) / 10000;
  const feeShare = input.payment.percentBps * 1.1 * (input.payment.gstCreditable ? 10 / 11 : 1) / 10000;
  const fixedFees = input.stages.filter((s) => s.shareBps > 0).length * input.payment.fixedCents * (input.payment.gstCreditable ? 10 / 11 : 1);
  const fixedCost = labourCents + labourContingencyCents + thirdParty.knownCents + thirdPartyContingencyCents + fixedFees;
  const denominator = 1 - target / 10000 - feeShare;
  const pricing = {
    targetMarginBps: target,
    /** Planned founder minutes the price can carry before the build makes a loss (the contingency is added on top). */
    breakEvenMinutes: loadedHourly === 0 ? null : Math.max(0, Math.floor((revenueExGst - nonLabourCents) * 60 / loadedHourly)),
    /** Ex-GST price at which the build earns the target margin on these hours and costs. */
    priceForTargetExGstCents: denominator <= 0 ? null : Math.max(0, Math.ceil((fixedCost - extraRevisionRevenue * (1 - target / 10000)) / denominator)),
    /** null when collection fees take the whole price, so no price can break even. */
    breakEvenPriceExGstCents: feeShare >= 1 ? null : Math.max(0, Math.ceil((fixedCost - extraRevisionRevenue) / (1 - feeShare))),
  };

  const unknownCosts = [...oneOff.unknownCosts, ...recurring.unknownCosts];
  return {
    basis: "estimate" as const, incomplete: unknownCosts.length > 0, unknownCosts,
    oneOff: { ...oneOff, pricing }, recurring,
    /** One-off and recurring shown side by side over the care term; the two are never merged into one margin. */
    horizon: {
      months: term, oneOffProfitCents: grossProfitCents, recurringProfitCents: careProfit * term,
      recurringRevenueExGstCents: careSplit.netCents * term, totalProfitCents: grossProfitCents + careProfit * term,
      /** Months of care-plan profit needed to cover a loss on the build; 0 when the build is profitable; null when it never recovers. */
      monthsToRecoverBuildLoss: grossProfitCents >= 0 ? 0 : careProfit <= 0 ? null : Math.ceil(-grossProfitCents / careProfit),
    },
    approval: websiteApproval(input),
  };
}
export type WebsiteResult = ReturnType<typeof calculateWebsite>;

/** Which entered terms match the owner-confirmed website offer, and which are scenarios needing approval. */
export function websiteApproval(input: WebsiteInput) {
  const b = WEBSITE_BASELINE;
  const priceMatches = input.price.cents === b.priceCents && input.price.gst === b.gst && input.discount.type === "none";
  // The confirmed schedule is 50% to start and 50% at approved launch: the timing wording counts, not only the split.
  const stagesMatch = input.stages.length === 2 && input.stages[0].shareBps === 5000 && input.stages[1].shareBps === 5000
    && /accept|start/i.test(input.stages[0].trigger) && /launch/i.test(input.stages[1].trigger) && !/after|later|days|weeks|months/i.test(input.stages[1].trigger);
  const careMatches = !input.care.enabled || (input.care.monthly.cents === b.carePlanMonthlyCents && input.care.monthly.gst === b.gst);
  const unapproved: string[] = [];
  if (!priceMatches) unapproved.push(input.discount.type === "none"
    ? "Website price differs from the owner-confirmed offer (A$1,650 incl. GST). This is a scenario, not an approved price."
    : "A discount is applied to the website price. Discounts are not an approved term.");
  if (!stagesMatch) unapproved.push("Payment stages or their timing differ from the confirmed 50% deposit to start / 50% at approved launch.");
  if (!careMatches) unapproved.push("Care plan price differs from the owner-confirmed A$110/month incl. GST.");
  if (input.care.enabled) unapproved.push("Care plan inclusions (hosting, maintenance, included change time) and the 30-day notice period are draft terms awaiting confirmation; only the A$110/month price is confirmed.");
  if (input.revisions.extraRoundFeeCents !== null) unapproved.push("A fee for extra revision rounds is entered. No extra-revision price has been approved.");
  return { priceMatches, stagesMatch, careMatches, unapproved, source: b.source };
}
