/**
 * AI receptionist deal economics (deal desk, 3 Oct 2026). A thin layer over calculateEconomics in
 * src/lib/business-economics.ts and the approved catalogue in src/lib/receptionist-packages.ts: no price,
 * allowance, rate or billing rule is typed here.
 *
 * Billing rule (catalogue `per-second-aggregate-period`): connected seconds are summed over the month, calls
 * under the minimum are excluded, and the period total is rounded up to a whole minute ONCE when working out
 * extra minutes. Transfer minutes and demo calls are never billed. GST (10%) is added per invoice line.
 */
import {
  calculateEconomics, DEFAULT_COST_RATES, DEFAULT_FX, DEFAULT_LABOUR_HOURLY_CENTS, DEFAULT_PAYMENT, DEFAULT_TARGET_MARGIN_BPS,
  priceAmount, RETELL_CONFIGURATIONS, RETELL_STRESS, unknownCostRegister,
  type CostRate, type EconomicsInput, type UsageBucket,
} from "../business-economics";
import { getReceptionistPackage, type PackageId, type ReceptionistPackage } from "../receptionist-packages";
import { int, mulDiv, paymentFee, ratioBps, splitGst, type Fx } from "./money";

export type RxColumnId = "low" | "expected" | "full" | "extra";
export const RX_COLUMN_LABELS: Readonly<Record<RxColumnId, string>> = {
  low: "Low usage", expected: "Expected usage", full: "Full allowance", extra: "Over allowance",
};
export type RxColumnInput = { billableSeconds: number; smsSegments: number; supportMinutes: number };
export type RxDealInput = {
  packageId: PackageId;
  columns: Record<RxColumnId, RxColumnInput>;
  /** Average connected call length, used to turn billable seconds into calls (per-call carrier rounding, webhooks). */
  avgCallSeconds: number;
  /** Hang-ups and never-connected calls as a share of billable calls: a cost to M&U, never billed. */
  shortCallShareBps: number;
  webhookEventsPerCall: number;
  /** Voice platform rate (Retell) in US$ millionths per connected minute. */
  voiceMicros: number;
  /** Entered rate amounts by DEFAULT_COST_RATES id, in the rate's own currency millionths; null = unknown. */
  rateOverrides: Record<string, number | null>;
  /** Paying receptionist clients sharing the platform bills (Vercel, Neon). 1 = this client carries all of it. */
  clientsSharingPlatform: number;
  fx: Fx;
  labourHourlyCents: number;
  onboardingMinutes: number;
  payment: { percentBps: number; fixedCents: number };
  /** A discount on the monthly fee. Not an approved term: any value above 0 is flagged. */
  monthlyDiscountBps: number;
  /** Setup fee ex GST. null = "quoted separately once approved" (setup fees are NOT approved). */
  setupFeeCents: number | null;
  termMonths: number;
};

export const RX_VOICE_PRESETS = [
  ...RETELL_CONFIGURATIONS.map((c) => ({ id: c.id, label: c.label, micros: c.micros })),
  ...RETELL_STRESS.filter((s) => s.id !== "base").map((s) => ({ id: `stress-${s.id}`, label: `Stress: ${s.label}`, micros: s.micros })),
];

function scenario(pkg: ReceptionistPackage, id: "low" | "base" | "high") {
  const s = pkg.model.scenarios.find((x) => x.id === id)!;
  return { seconds: s.calls.reduce((n, c) => n + c.count * c.seconds, 0), sms: s.smsSegments, support: s.supportMinutes };
}

/** Catalogue planning scenarios for low/expected/over; "full" is exactly the included allowance. */
export function defaultRxColumns(pkg: ReceptionistPackage): Record<RxColumnId, RxColumnInput> {
  const low = scenario(pkg, "low"); const base = scenario(pkg, "base"); const high = scenario(pkg, "high");
  const full = pkg.pricing.includedMinutes * 60;
  return {
    low: { billableSeconds: low.seconds, smsSegments: low.sms, supportMinutes: low.support },
    expected: { billableSeconds: base.seconds, smsSegments: base.sms, supportMinutes: base.support },
    full: { billableSeconds: full, smsSegments: base.seconds ? Math.round(base.sms * full / base.seconds) : base.sms, supportMinutes: base.support },
    extra: { billableSeconds: Math.max(high.seconds, full + 60), smsSegments: high.sms, supportMinutes: high.support },
  };
}

export function defaultRxInput(packageId: PackageId = "receptionist-professional"): RxDealInput {
  const pkg = getReceptionistPackage(packageId);
  return {
    packageId, columns: defaultRxColumns(pkg), avgCallSeconds: 150, shortCallShareBps: 500, webhookEventsPerCall: 5,
    voiceMicros: DEFAULT_COST_RATES.find((r) => r.id === "retell")!.micros!, rateOverrides: {},
    clientsSharingPlatform: 1, fx: { ...DEFAULT_FX }, labourHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    onboardingMinutes: pkg.model.onboardingMinutes,
    payment: { percentBps: DEFAULT_PAYMENT.percentBps, fixedCents: DEFAULT_PAYMENT.fixedCents },
    monthlyDiscountBps: 0, setupFeeCents: null, termMonths: pkg.pricing.minimumTermMonths,
  };
}

/** The catalogue package with this deal's discount and (unapproved) setup amount applied. Never mutates the catalogue. */
export function pricedPackage(input: RxDealInput): ReceptionistPackage {
  const pkg = structuredClone(getReceptionistPackage(input.packageId));
  const discount = mulDiv(pkg.pricing.monthly.cents, int(input.monthlyDiscountBps, "discount", 10000), 10000);
  pkg.pricing.monthly.cents -= discount;
  pkg.pricing.setup.cents = input.setupFeeCents === null ? 0 : int(input.setupFeeCents, "setup fee");
  return pkg;
}

/**
 * Billable seconds as calls of the average length. The remainder joins the last call rather than becoming a
 * separate tiny call, which the 5-second minimum would otherwise wrongly drop.
 */
export function callsForSeconds(billableSeconds: number, avgCallSeconds: number): UsageBucket[] {
  const total = int(billableSeconds, "billable seconds", 1_000_000_000);
  const avg = int(avgCallSeconds, "average call length", 86400);
  if (avg < 5) throw new Error("Average call length must be at least 5 seconds");
  const full = Math.floor(total / avg); const rest = total % avg;
  if (full === 0) return rest ? [{ count: 1, seconds: rest }] : [];
  if (rest === 0) return [{ count: full, seconds: avg }];
  if (avg + rest > 86400) return [{ count: full, seconds: avg }, { count: 1, seconds: rest }];
  return [...(full > 1 ? [{ count: full - 1, seconds: avg }] : []), { count: 1, seconds: avg + rest }];
}

export function ratesFor(input: RxDealInput): CostRate[] {
  return DEFAULT_COST_RATES.map((r) => {
    if (r.id === "retell") return input.voiceMicros === r.micros ? r : { ...r, micros: int(input.voiceMicros, "voice rate"), evidence: "assumption" as const, note: `Entered in the deal desk (catalogue base ${r.micros}). ${r.note}` };
    if (!(r.id in input.rateOverrides)) return r;
    const v = input.rateOverrides[r.id];
    return { ...r, micros: v === null ? null : int(v, r.label), evidence: v === null ? "unknown" as const : "assumption" as const, note: `Entered in the deal desk: an assumption, not a provider charge. ${r.note}` };
  });
}

function economicsInput(input: RxDealInput, column: RxColumnInput, pkg: ReceptionistPackage): EconomicsInput {
  const calls = callsForSeconds(column.billableSeconds, input.avgCallSeconds);
  const billableCalls = calls.reduce((n, c) => n + c.count, 0);
  const shortCalls = Math.round(billableCalls * int(input.shortCallShareBps, "short-call share", 10000) / 10000);
  const allCalls = shortCalls ? [...calls, { count: shortCalls, seconds: 4 }] : calls;
  return {
    package: pkg, clients: (() => { const n = int(input.clientsSharingPlatform, "clients sharing the platform", 10000); if (n < 1) throw new Error("Clients sharing the platform must be at least 1"); return n; })(),
    calls: allCalls, transferLegs: [],
    webhookEventsPerClient: (billableCalls + shortCalls) * int(input.webhookEventsPerCall, "webhook events per call", 100),
    notificationsPerClient: 0, smsSegmentsPerClient: int(column.smsSegments, "SMS segments"), phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
    rates: ratesFor(input), fx: input.fx, gstRegistered: true,
    supportMinutesPerClient: int(column.supportMinutes, "support minutes"), supportHourlyCents: int(input.labourHourlyCents, "hourly rate"),
    onboardingMinutes: int(input.onboardingMinutes, "onboarding minutes"), onboardingHourlyCents: input.labourHourlyCents,
    payment: { ...DEFAULT_PAYMENT, percentBps: input.payment.percentBps, fixedCents: input.payment.fixedCents },
    targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
  };
}

/** The client's monthly invoice under the catalogue rule. GST per line = round-half-up(ex GST × 10%); totals sum the lines. */
export function rxInvoice(pkg: ReceptionistPackage, billableSeconds: number, smsSegments: number) {
  const p = pkg.pricing;
  int(billableSeconds, "billable seconds"); int(smsSegments, "SMS segments");
  const includedSeconds = p.includedMinutes * 60;
  const overageMinutes = Math.max(0, Math.ceil((billableSeconds - includedSeconds) / 60));
  const smsOver = Math.max(0, smsSegments - p.includedSmsSegments);
  const line = (id: string, description: string, quantity: number, unitCents: number) => {
    const a = priceAmount({ cents: unitCents * quantity, currency: "AUD", gst: "exclusive" }, true);
    return { id, description, quantity, unitExGstCents: unitCents, exGstCents: a.netCents, gstCents: a.gstCents, inclGstCents: a.grossCents };
  };
  const lines = [
    line("monthly", `${pkg.name}, monthly fee`, 1, p.monthly.cents),
    line("overage-minutes", `Extra minutes beyond ${p.includedMinutes.toLocaleString("en-AU")} included`, overageMinutes, p.overagePerMinute.cents),
    line("sms-overage", `Extra SMS segments beyond ${p.includedSmsSegments.toLocaleString("en-AU")} included`, smsOver, p.extraSmsSegment.cents),
  ];
  const sum = (k: "exGstCents" | "gstCents" | "inclGstCents") => lines.reduce((n, l) => n + l[k], 0);
  return { billableSeconds, includedSeconds, overageMinutes, smsOverageSegments: smsOver, lines, exGstCents: sum("exGstCents"), gstCents: sum("gstCents"), inclGstCents: sum("inclGstCents") };
}

/** Per-client monthly figures for one usage column. Shared platform bills are split and rounded up per client. */
export function rxColumn(input: RxDealInput, column: RxColumnInput, pkg = pricedPackage(input)) {
  const e = economicsInput(input, column, pkg);
  const r = calculateEconomics(e);
  const n = e.clients;
  const invoice = rxInvoice(pkg, column.billableSeconds, column.smsSegments);
  const revenue = r.revenueExGstCents / n;
  const variable = r.variableCostCents / n;
  const support = r.supportCents / n;
  const shared = Math.ceil(r.sharedPlatformCents / n);
  const operating = revenue - variable - support - shared;
  const supportMinutes = column.supportMinutes;
  return {
    billableSeconds: column.billableSeconds, smsSegments: column.smsSegments, supportMinutes,
    calls: r.callCount, overageMinutes: r.overageMinutes, invoice,
    revenueExGstCents: revenue,
    costLines: r.lines.map((l) => ({ id: l.id, label: l.label, basis: l.basis, cents: l.basis === "shared-month" ? Math.ceil(l.operatingCents / n) : l.operatingCents / n })),
    paymentCostCents: r.paymentCostCents / n, variableCostCents: variable, contributionCents: revenue - variable,
    supportCents: support, sharedPlatformCents: shared, operatingCents: operating,
    contributionMarginBps: ratioBps(revenue - variable, revenue), operatingMarginBps: ratioBps(operating, revenue),
    providerCostPerMinuteCents: r.perMinuteCents,
    /** What an hour of support time earns after every non-labour cost; null with no support time. */
    effectiveHourlyCents: supportMinutes === 0 ? null : Math.round((operating + support) * 60 / supportMinutes),
    unknownCosts: e.rates.filter((x) => x.micros === null).map((x) => x.label),
    raw: r,
  };
}
export type RxColumnResult = ReturnType<typeof rxColumn>;

/** Usage between the entered columns: SMS scales with minutes from the expected column; support follows the band. */
function syntheticColumn(input: RxDealInput, pkg: ReceptionistPackage, minutes: number): RxColumnInput {
  const seconds = minutes * 60; const exp = input.columns.expected;
  const sms = exp.billableSeconds ? Math.round(exp.smsSegments * seconds / exp.billableSeconds) : exp.smsSegments;
  const share = pkg.pricing.includedMinutes ? seconds / (pkg.pricing.includedMinutes * 60) : 2;
  const support = share <= 0.5 ? input.columns.low.supportMinutes : share <= 1 ? input.columns.expected.supportMinutes : input.columns.extra.supportMinutes;
  return { billableSeconds: seconds, smsSegments: sms, supportMinutes: support };
}

function searchFirst(lo: number, hi: number, bad: (x: number) => boolean): number {
  // Smallest x in (lo, hi] with bad(x), given bad(lo) false and bad(hi) true and monotone in between.
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (bad(mid)) hi = mid; else lo = mid; }
  return hi;
}

/**
 * Where this package stops making money under the entered assumptions. Every figure is "per client per month,
 * operating" (after provider costs, payment fees, support time and the platform share). null = not reached
 * within the searched range.
 */
export function rxBreakEven(input: RxDealInput) {
  const pkg = pricedPackage(input);
  const allowance = pkg.pricing.includedMinutes;
  const ceiling = Math.max(allowance, 100) * 20;
  const op = (minutes: number, variant: Partial<RxDealInput> = {}, p = pkg) => {
    const i = { ...input, ...variant };
    return rxColumn(i, syntheticColumn(i, p, minutes), p).operatingCents;
  };
  const noOverage = structuredClone(pkg); noOverage.pricing.overagePerMinute.cents = 0; noOverage.pricing.extraSmsSegment.cents = 0;

  // Profit is only monotone inside each band: support time steps at 50% and 100% of the allowance, and extra
  // minutes start being charged above it. Each band is searched on its own (review F05/F06).
  const half = Math.floor(allowance / 2);
  const bands = ([[0, half], [half + 1, allowance], [allowance + 1, ceiling]] as [number, number][]).filter(([a, b]) => a <= b);
  const firstWhere = (test: (minutes: number) => boolean, from = 0): number | null => {
    for (const [start, end] of bands) {
      const a = Math.max(start, from); if (a > end) continue;
      if (test(a)) return a;
      if (test(end)) return searchFirst(a, end, test);
    }
    return null;
  };
  const lossFrom = (p: ReceptionistPackage) => firstWhere((m) => op(m, {}, p) < 0);
  const unprofitableFromMinutes = lossFrom(pkg);
  const recoversAtMinutes = unprofitableFromMinutes === null ? null : firstWhere((m) => op(m) >= 0, unprofitableFromMinutes + 1);

  const full = input.columns.full;
  const fullOp = (variant: Partial<RxDealInput>) => rxColumn({ ...input, ...variant }, full, pricedPackage({ ...input, ...variant })).operatingCents;
  const maxVoice = (() => {
    const top = 5_000_000;
    if (fullOp({ voiceMicros: 0 }) < 0) return 0;
    if (fullOp({ voiceMicros: top }) >= 0) return null;
    return searchFirst(0, top, (v) => fullOp({ voiceMicros: v }) < 0) - 1;
  })();
  const maxDiscount = (col: RxColumnInput) => {
    const at = (bps: number) => rxColumn({ ...input, monthlyDiscountBps: bps }, col, pricedPackage({ ...input, monthlyDiscountBps: bps })).operatingCents;
    if (at(0) < 0) return 0;
    if (at(10000) >= 0) return 10000;
    return searchFirst(0, 10000, (b) => at(b) < 0) - 1;
  };
  const expected = rxColumn(input, input.columns.expected, pkg);
  const hourly = input.labourHourlyCents;
  // Overage unit economics: 1,000 extra minutes above the allowance, SMS and support held constant.
  const extraCost = (() => {
    const base = { ...full, billableSeconds: allowance * 60 };
    const more = { ...base, billableSeconds: (allowance + 1000) * 60 };
    const a = rxColumn(input, base, pkg); const b = rxColumn(input, more, pkg);
    return { costPerMinuteCents: (b.variableCostCents - a.variableCostCents) / 1000, revenuePerMinuteCents: (b.revenueExGstCents - a.revenueExGstCents) / 1000 };
  })();
  return {
    allowanceMinutes: allowance,
    unprofitableFromMinutes, recoversAtMinutes,
    unprofitableFromMinutesWithoutOverage: lossFrom(noOverage),
    maxVoiceUsdMicrosAtFullAllowance: maxVoice,
    maxDiscountBpsAtExpected: maxDiscount(input.columns.expected),
    maxDiscountBpsAtFullAllowance: maxDiscount(full),
    maxSupportMinutesAtExpected: hourly === 0 ? null : Math.max(0, Math.floor((expected.operatingCents + expected.supportCents) * 60 / hourly)),
    overage: { priceExGstCents: pkg.pricing.overagePerMinute.cents, ...extraCost, profitable: extraCost.revenuePerMinuteCents > extraCost.costPerMinuteCents },
    searchedUpToMinutes: ceiling,
  };
}

export function calculateRxDeal(input: RxDealInput) {
  const pkg = pricedPackage(input);
  const catalogue = getReceptionistPackage(input.packageId);
  const columns = (Object.keys(RX_COLUMN_LABELS) as RxColumnId[]).map((id) => ({ id, label: RX_COLUMN_LABELS[id], ...rxColumn(input, input.columns[id], pkg) }));
  const expected = columns.find((c) => c.id === "expected")!;
  const onboardingLabour = mulDiv(int(input.onboardingMinutes, "onboarding minutes"), input.labourHourlyCents, 60);
  const setupRevenue = input.setupFeeCents ?? 0;
  const setupFee = paymentFee(splitGst(setupRevenue, "exclusive").grossCents, { label: "", percentBps: input.payment.percentBps, fixedCents: input.payment.fixedCents, gstCreditable: true });
  const setupNet = setupRevenue - onboardingLabour - setupFee.costCents;
  const months = int(input.termMonths, "term months", 120);
  const unknown = [...new Set([...expected.unknownCosts, ...unknownCostRegister().filter((u) => u.basis === "unallocated").map((u) => u.label)])];
  const unapproved: { id: string; text: string }[] = [];
  if (input.monthlyDiscountBps > 0) unapproved.push({ id: "rx-discount", text: `A ${input.monthlyDiscountBps / 100}% discount on the monthly fee is entered. Discounts are not an approved term.` });
  if (input.setupFeeCents !== null) unapproved.push({ id: "rx-setup", text: "A setup fee is entered. Setup fees are NOT approved; A$990 / A$1,490 / A$2,490 were proposals only." });
  if (input.termMonths !== catalogue.pricing.minimumTermMonths) unapproved.push({ id: "rx-term", text: `Term of ${input.termMonths} months differs from the catalogue's proposed ${catalogue.pricing.minimumTermMonths}-month minimum.` });
  return {
    basis: "estimate" as const, packageId: input.packageId, packageName: catalogue.name, catalogueVersion: catalogue.version,
    approvedAt: catalogue.pricing.approvedAt, priceStatus: catalogue.pricing.status,
    columns, breakEven: rxBreakEven(input),
    setup: { feeExGstCents: input.setupFeeCents, feeStatus: input.setupFeeCents === null ? "quoted separately once approved" : "UNAPPROVED", onboardingLabourCents: onboardingLabour, paymentCostCents: setupFee.costCents, netCents: setupNet,
      monthsToRecover: setupNet >= 0 ? 0 : expected.operatingCents <= 0 ? null : Math.ceil(-setupNet / expected.operatingCents) },
    term: { months, revenueExGstCents: expected.revenueExGstCents * months, operatingCents: expected.operatingCents * months + setupNet,
      hours: (expected.supportMinutes * months + input.onboardingMinutes) / 60 },
    unknownCosts: unknown, incomplete: unknown.length > 0, unapproved,
  };
}
export type RxDealResult = ReturnType<typeof calculateRxDeal>;
