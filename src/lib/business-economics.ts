import type { PackageId, PackagePrice, ReceptionistPackage, UsageScenario } from "./receptionist-packages";
import { CATALOGUE_VERSION, formatAud, getReceptionistPackage, projectPackageProposal, RECEPTIONIST_PACKAGES } from "./receptionist-packages";

/** Date the official public rates below were re-read. A check date is not a vendor effective date. */
export const ECONOMICS_AS_OF = "2026-09-28";
export const RATE_SOURCES = {
  retell: "https://www.retellai.com/pricing",
  twilioSip: "https://www.twilio.com/en-us/sip-trunking/pricing/au",
  twilioSms: "https://www.twilio.com/en-us/sms/pricing/au",
  twilio: "https://www.twilio.com/en-us/voice/pricing/au",
  rounding: "https://help.twilio.com/articles/223132307-How-do-you-round-minutes-for-billing-",
  twilioNumbersCsv: "https://assets.cdn.prod.twilio.com/pricing-csv/SiteNumbersPricing.csv",
  twilioTerminationCsv: "https://assets.cdn.prod.twilio.com/pricing-csv/OutboundSipTrunkPricing.csv",
  retellTransfer: "https://docs.retellai.com/build/single-multi-prompt/transfer-call",
  stripe: "https://stripe.com/au/pricing",
  vercel: "https://vercel.com/pricing",
  neon: "https://neon.com/pricing",
  rba: "https://www.rba.gov.au/statistics/frequency/exchange-rates.html",
  gst: "https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits",
} as const;
export type CostBasis = "minute" | "call" | "notification" | "sms-segment" | "number-month" | "client-month" | "shared-month" | "setup"
  /** Post-transfer seconds of a cold-transferred call (carrier legs only; Retell's AI fee stops). */
  | "transfer-minute"
  /** One webhook or tool invocation, including duplicate deliveries and retries (never customer-billable). */
  | "webhook-event";
export type CostRate = {
  id: string; label: string; currency: "USD" | "AUD";
  /** Integer millionths of a currency unit; null is unknown, never a free rate. */
  micros: number | null;
  basis: CostBasis;
  gst: "inclusive" | "exclusive" | "none" | "unknown";
  creditEligible: boolean;
  covers: string[];
  incrementSeconds?: number;
  /** The rate is quoted per this many units (e.g. 1,000,000 invocations). Default 1. */
  quantityPer?: number;
  source: string | null; checkedAt: string; effectiveFrom: string | null;
  evidence: "public-list" | "assumption" | "unknown";
  note: string;
};
const rate = (item: Omit<CostRate, "checkedAt" | "effectiveFrom" | "gst" | "creditEligible"> & Partial<Pick<CostRate, "effectiveFrom">>): CostRate => ({
  checkedAt: ECONOMICS_AS_OF, effectiveFrom: null, gst: "unknown", creditEligible: false, ...item,
});
const TWILIO_CURRENCY = "Twilio's AU page shows '$' with no currency label; modelled as USD, the dearer reading. Confirm on the invoice.";
export const DEFAULT_COST_RATES: readonly CostRate[] = [
  rate({ id: "retell", label: "Retell voice infra + Claude 4.5 Haiku + ElevenLabs voice tier", currency: "USD", micros: 120000, basis: "minute", incrementSeconds: 1, covers: ["voice-infra", "stt", "tts", "llm"], source: RATE_SOURCES.retell, evidence: "public-list", note: "Conservative base, kept from 27 Sep: US$0.055 infra + US$0.025 Claude 4.5 Haiku + US$0.040 ElevenLabs tier (all re-read 28 Sep). The receptionist generator (provision-plan.ts) provisions gpt-4.1-mini + retell-Cimo, a Retell platform voice = US$0.0828; the live demo agent was recorded on Claude 4.5 Haiku (27 Sep read) = US$0.095 if its voice is platform tier. See RETELL_CONFIGURATIONS. Per second, silence billed. BYO Twilio SIP: Retell charges no telephony." }),
  rate({ id: "carrier", label: "Twilio Elastic SIP origination, AU mobile", currency: "USD", micros: 6000, basis: "minute", incrementSeconds: 60, covers: ["carrier-inbound"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `0.0060/min inbound to the SIP trunk (page and numbers CSV, 'pricing current as of August 2026'). Rounded up per call per minute (conservative). ${TWILIO_CURRENCY}` }),
  rate({ id: "number", label: "Twilio AU mobile number", currency: "USD", micros: 8250000, basis: "number-month", covers: ["number"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `8.25/month per mobile number (the demo line +61 485 011 208 is a mobile); a local number is 2.50 on the SIP page. ${TWILIO_CURRENCY}` }),
  rate({ id: "sms", label: "Twilio AU outbound SMS", currency: "USD", micros: 51500, basis: "sms-segment", covers: ["sms-outbound"], source: RATE_SOURCES.twilioSms, evidence: "public-list", note: `0.0515 per outbound segment; inbound STOP replies 0.0075 are negligible and excluded; failed-message fee 0.001. Carrier fees 'may apply': see sms-carrier-fees (unknown). ${TWILIO_CURRENCY}` }),
  rate({ id: "transfer-termination", label: "Twilio Elastic SIP termination to AU mobile (cold-transfer leg)", currency: "USD", micros: 71000, basis: "transfer-minute", incrementSeconds: 60, covers: ["carrier-transfer-outbound"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `0.0710/min to AU mobile (0.0212 to landlines), rounded up per leg. Only if transfer is ever offered: it is 'not-offered' in every tier today. Retell's AI fee stops once the caller is connected (Retell transfer docs); the carrier legs continue. ${TWILIO_CURRENCY}` }),
  rate({ id: "transfer-origination", label: "Twilio SIP origination continuing after a cold transfer", currency: "USD", micros: 6000, basis: "transfer-minute", incrementSeconds: 60, covers: ["carrier-inbound-after-transfer"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `The caller's inbound leg keeps running for the transferred part of the call. Modelled as its own rounded leg (conservative). ${TWILIO_CURRENCY}` }),
  rate({ id: "webhook", label: "Vercel function invocations (webhooks, tool calls, retries, duplicates)", currency: "USD", micros: 600000, quantityPer: 1_000_000, basis: "webhook-event", covers: ["function-invocation"], source: RATE_SOURCES.vercel, evidence: "public-list", note: "US$0.60 per 1M invocations beyond Pro's 1M included; charged here from the first event (conservative). Active CPU per invocation is in hosting-excess (unknown)." }),
  rate({ id: "hosting", label: "Vercel Pro base (1 seat)", currency: "USD", micros: 20000000, basis: "shared-month", covers: ["hosting"], source: RATE_SOURCES.vercel, evidence: "public-list", note: "US$20/month incl. US$20 usage credit; Hobby is for personal projects, so Pro is required before billing a client. Extra seats (US$20 each) and excess usage are in hosting-excess (unknown)." }),
  rate({ id: "database", label: "Neon Postgres usage (Launch plan)", currency: "USD", micros: null, basis: "shared-month", covers: ["database"], source: RATE_SOURCES.neon, evidence: "unknown", note: "Launch: US$0.106/CU-hour + US$0.35/GB-month, no minimum, scale to zero after 5 min (re-read 28 Sep). Actual compute hours not measured; unknown, not free." }),
  rate({ id: "hosting-excess", label: "Vercel usage beyond the US$20 credit and extra seats", currency: "USD", micros: null, basis: "shared-month", covers: ["hosting-excess"], source: RATE_SOURCES.vercel, evidence: "unknown", note: "Fluid Active CPU from US$0.128/hour, data transfer US$0.15/GB beyond 1 TB, US$20 per extra seat. Usage and seat count not measured." }),
  rate({ id: "sms-carrier-fees", label: "AU carrier fees on SMS", currency: "USD", micros: null, basis: "sms-segment", covers: ["sms-carrier-fee"], source: RATE_SOURCES.twilioSms, evidence: "unknown", note: "Twilio: 'additional carrier fees may apply'. Amount not published on the AU page." }),
  rate({ id: "trunk-recording", label: "Twilio trunk call recording (if switched on)", currency: "USD", micros: null, basis: "minute", incrementSeconds: 60, covers: ["carrier-recording"], source: RATE_SOURCES.twilioSip, evidence: "unknown", note: "US$0.0025/min + US$0.0005/min-month storage if trunk recording is on. Retell records the call itself; whether trunk recording is on has not been checked (no live Twilio read allowed)." }),
  rate({ id: "notifications", label: "Staff alert email", currency: "AUD", micros: null, basis: "notification", covers: ["alert-email"], source: null, evidence: "unknown", note: "Alert channel not yet configured in production; provider and price unknown." }),
  rate({ id: "concurrency", label: "Retell concurrency above 20 free slots", currency: "USD", micros: null, basis: "shared-month", covers: ["concurrency"], source: RATE_SOURCES.retell, evidence: "unknown", note: "US$8/slot/month beyond 20 concurrent calls across ALL clients. Peak concurrency not measured." }),
  rate({ id: "subscriptions", label: "Other tools and subscriptions allocation", currency: "AUD", micros: null, basis: "shared-month", covers: ["subscriptions"], source: null, evidence: "unknown", note: "Unscoped allocation; excluded from the known-cost subtotal, not assumed free." }),
];

export type UsageBucket = { count: number; seconds: number };
export type EconomicsInput = {
  package: ReceptionistPackage;
  clients: number;
  calls: UsageBucket[]; // per client; synthetic or non-sensitive duration/count metadata only
  /** Post-transfer durations of cold-transferred calls, per client. Carrier-only; never customer-billable. */
  transferLegs?: UsageBucket[];
  /** Webhook deliveries + tool invocations per client, including retries and duplicates. */
  webhookEventsPerClient?: number;
  notificationsPerClient: number;
  smsSegmentsPerClient: number;
  phoneNumbersPerClient: number;
  rates: readonly CostRate[];
  fx: { usdPerAudMillionths: number; date: string; cardFeeBps: number };
  gstRegistered: boolean;
  supportMinutesPerClient: number; supportHourlyCents: number;
  onboardingMinutes: number; onboardingHourlyCents: number;
  payment: { percentBps: number; fixedCents: number; gst: "inclusive" | "exclusive" | "none"; creditEligible: boolean };
  targetMarginBps: number;
};
/** RBA reference rate, 25 Sep 2026 (still the latest published when re-read 28 Sep 00:07 AEST). Not a settlement quote. */
export const DEFAULT_FX = { usdPerAudMillionths: 701900, date: "2026-09-25", cardFeeBps: 300 };
/**
 * Stripe AU domestic card 1.7% + A$0.30, fees include GST: the official page (re-read 28 Sep) prints this as the
 * "lower pricing effective starting 1 Oct 2026". The receptionist bills through Stripe subscriptions + meters
 * (src/lib/billing/sync.ts in the receptionist repo), so Stripe Billing pay-as-you-go 0.7% of Billing volume also
 * applies: 2.4% + A$0.30 on the GST-inclusive charge. The Billing fee's GST treatment is not stated; the whole fee
 * is treated as GST-inclusive and creditable (overstates the credit by at most 0.064% of the charge).
 */
export const STRIPE_CARD_BPS = 170;
export const STRIPE_BILLING_BPS = 70;
export const DEFAULT_PAYMENT = { percentBps: STRIPE_CARD_BPS + STRIPE_BILLING_BPS, fixedCents: 30, gst: "inclusive" as const, creditEligible: true };
/** The 1 Oct 2026 domestic card price as printed on Stripe's own page (supersedes the 27 Sep secondary-source 1.65%). */
export const STRIPE_FROM_2026_10_01 = { percentBps: STRIPE_CARD_BPS, fixedCents: 30, source: RATE_SOURCES.stripe, verifiedOnOfficialPage: true, checkedAt: "2026-09-28" } as const;
export const DEFAULT_LABOUR_HOURLY_CENTS = 6000;
export const DEFAULT_TARGET_MARGIN_BPS = 7000;

export function scenariosFor(pkg: ReceptionistPackage): readonly UsageScenario[] { return pkg.model.scenarios; }
/** Essential tier scenarios; kept for callers that predate per-package scenarios. */
export const SCENARIOS = scenariosFor(getReceptionistPackage("receptionist-essential"));
export const CLIENT_COUNTS = [1, 5, 10, 25] as const;

function integer(value: number, name: string, max = 1_000_000_000): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${name} must be a non-negative safe integer ≤ ${max}`);
  return BigInt(value);
}
function safe(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Calculation exceeds safe money range");
  return n;
}
/** Signed totals stay exact until the final safe-number boundary. */
function moneyTotal(...values: number[]): number {
  return safe(values.reduce((total, value) => {
    if (!Number.isSafeInteger(value)) throw new Error("Calculation exceeds safe money range");
    return total + BigInt(value);
  }, 0n));
}
/** Half up, non-negative values only. All monetary multiplication uses BigInt. */
function round(n: bigint, d: bigint): bigint { if (d <= 0n || n < 0n) throw new Error("Invalid ratio"); return (n + d / 2n) / d; }
function ceil(n: bigint, d: bigint): bigint { if (d <= 0n || n < 0n) throw new Error("Invalid ratio"); return (n + d - 1n) / d; }
export function splitGst(cents: number, treatment: "inclusive" | "exclusive" | "none" | "unknown", taxable = true) {
  const value = integer(cents, "money", Number.MAX_SAFE_INTEGER);
  const gst = !taxable || treatment === "none" || treatment === "unknown" ? 0n : treatment === "inclusive" ? round(value, 11n) : round(value, 10n);
  const gross = treatment === "exclusive" ? value + gst : value;
  return { grossCents: safe(gross), netCents: safe(gross - gst), gstCents: safe(gst) };
}
export function priceAmount(price: PackagePrice, gstRegistered: boolean) { return splitGst(price.cents, price.gst, gstRegistered); }

export function billedSeconds(calls: readonly UsageBucket[], increment: number): number {
  const step = integer(increment, "billing increment", 3600);
  if (!step) throw new Error("Billing increment must be positive");
  return safe(calls.reduce((sum, call) => sum + integer(call.count, "call count", 1_000_000) * ceil(integer(call.seconds, "duration", 86400), step) * step, 0n));
}

/** Customer-billable seconds: calls under the minimum are excluded, the rest summed per period. */
export function customerBillableSeconds(calls: readonly UsageBucket[], minimumBillableSeconds: number): number {
  const min = integer(minimumBillableSeconds, "minimum billable seconds", 600);
  return safe(calls.reduce((sum, call) => {
    const seconds = integer(call.seconds, "duration", 86400);
    return seconds < min ? sum : sum + integer(call.count, "call count", 1_000_000) * seconds;
  }, 0n));
}

/** Compare duration/count metadata with a provider usage receipt; no caller content or invoice access. */
export function reconcileUsageMetadata(calls: readonly UsageBucket[], incrementSeconds: number, receipt: { billedSeconds: number; costCents: number } | null, estimatedCostCents: number) {
  const expectedSeconds = billedSeconds(calls, incrementSeconds);
  integer(estimatedCostCents, "estimated cost", Number.MAX_SAFE_INTEGER);
  if (!receipt) return { state: "receipt-missing" as const, expectedSeconds, secondsDelta: null, costDeltaCents: null, invoiceReconciled: false as const };
  integer(receipt.billedSeconds, "receipt seconds", Number.MAX_SAFE_INTEGER);
  integer(receipt.costCents, "receipt cost", Number.MAX_SAFE_INTEGER);
  return {
    state: receipt.billedSeconds === expectedSeconds && receipt.costCents === estimatedCostCents ? "metadata-matches" as const : "metadata-difference" as const,
    expectedSeconds, secondsDelta: receipt.billedSeconds - expectedSeconds, costDeltaCents: receipt.costCents - estimatedCostCents,
    invoiceReconciled: false as const,
  };
}
export function validateRates(rates: readonly CostRate[]) {
  const ids = new Set<string>(); const components = new Set<string>();
  for (const r of rates) {
    if (ids.has(r.id)) throw new Error(`Duplicate rate: ${r.id}`);
    ids.add(r.id);
    if (r.micros !== null) integer(r.micros, `${r.id} rate`, Number.MAX_SAFE_INTEGER);
    if (r.basis === "minute" || r.basis === "transfer-minute") billedSeconds([], r.incrementSeconds ?? 1);
    if (r.quantityPer !== undefined && (!Number.isSafeInteger(r.quantityPer) || r.quantityPer < 1)) throw new Error(`${r.id} quantityPer must be a positive integer`);
    for (const component of r.covers) {
      if (components.has(component)) throw new Error(`Double-counted component: ${component}`);
      components.add(component);
    }
  }
}
export type CostResult = { id: string; label: string; basis: CostBasis; cashCents: number; inputGstCents: number; operatingCents: number; billedSeconds: number | null };

const PER_CLIENT: readonly CostBasis[] = ["minute", "call", "notification", "sms-segment", "number-month", "client-month", "transfer-minute", "webhook-event"];
const PER_MINUTE_USAGE: readonly CostBasis[] = ["minute", "call", "notification"];

export function calculateEconomics(input: EconomicsInput) {
  const clients = integer(input.clients, "clients", 10000);
  if (!clients) throw new Error("At least one client is required");
  const fxDate = new Date(`${input.fx.date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fx.date) || !Number.isFinite(fxDate.getTime()) || fxDate.toISOString().slice(0, 10) !== input.fx.date) throw new Error("FX date must be a real YYYY-MM-DD calendar date");
  const fx = integer(input.fx.usdPerAudMillionths, "USD per AUD", 100_000_000);
  if (!fx) throw new Error("FX must be positive");
  const card = integer(input.fx.cardFeeBps, "FX/card fee", 10000);
  integer(input.supportMinutesPerClient, "support minutes"); integer(input.supportHourlyCents, "support hourly rate");
  integer(input.onboardingMinutes, "onboarding minutes"); integer(input.onboardingHourlyCents, "onboarding hourly rate");
  integer(input.notificationsPerClient, "notifications");
  const webhookEvents = integer(input.webhookEventsPerClient ?? 0, "webhook events");
  const transferLegs = input.transferLegs ?? [];
  billedSeconds(transferLegs, 1);
  integer(input.smsSegmentsPerClient, "SMS segments");
  integer(input.phoneNumbersPerClient, "phone numbers", 100);
  const paymentBps = integer(input.payment.percentBps, "payment percentage", 10000);
  integer(input.payment.fixedCents, "payment fixed fee");
  integer(input.targetMarginBps, "target margin", 9999);
  const pricing = input.package.pricing;
  integer(pricing.includedMinutes, "included minutes");
  integer(pricing.includedSmsSegments, "included SMS segments");
  validateRates(input.rates);
  const actualSeconds = billedSeconds(input.calls, 1);
  const customerSeconds = customerBillableSeconds(input.calls, pricing.billing.minimumBillableSeconds);
  const callCount = safe(input.calls.reduce((n, c) => n + integer(c.count, "call count"), 0n));
  const overageMinutes = Math.max(0, Math.ceil((customerSeconds - pricing.includedMinutes * 60) / 60));
  const smsOverageSegments = Math.max(0, input.smsSegmentsPerClient - pricing.includedSmsSegments);
  const monthly = priceAmount(pricing.monthly, input.gstRegistered);
  priceAmount(pricing.overagePerMinute, input.gstRegistered);
  // Invoice overage is one aggregate line per item: calculate tax after multiplying the quoted unit price.
  const overage = priceAmount({ ...pricing.overagePerMinute, cents: safe(BigInt(pricing.overagePerMinute.cents) * BigInt(overageMinutes)) }, input.gstRegistered);
  const smsOverage = priceAmount({ ...pricing.extraSmsSegment, cents: safe(BigInt(pricing.extraSmsSegment.cents) * BigInt(smsOverageSegments)) }, input.gstRegistered);
  const grossRevenue = safe((BigInt(monthly.grossCents) + BigInt(overage.grossCents) + BigInt(smsOverage.grossCents)) * clients);
  const revenue = safe((BigInt(monthly.netCents) + BigInt(overage.netCents) + BigInt(smsOverage.netCents)) * clients);
  const outputGst = grossRevenue - revenue;
  const warnings: string[] = ["Estimate only: no measured usage or invoice reconciliation supplied."];
  const lines: CostResult[] = [];
  for (const r of input.rates) {
    if (r.micros === null) { warnings.push(`${r.label}: unknown, excluded from subtotal.`); continue; }
    if (r.gst === "unknown") warnings.push(`${r.label}: supplier GST unknown; no tax or credit assumed.`);
    let quantity = 1n; let divisor = 1n; let seconds: number | null = null;
    if (r.basis === "minute") { seconds = billedSeconds(input.calls, r.incrementSeconds ?? 1); quantity = BigInt(seconds); divisor = 60n; }
    if (r.basis === "call") quantity = BigInt(callCount);
    if (r.basis === "notification") quantity = BigInt(input.notificationsPerClient);
    if (r.basis === "sms-segment") quantity = BigInt(input.smsSegmentsPerClient);
    if (r.basis === "number-month") quantity = BigInt(input.phoneNumbersPerClient);
    if (r.basis === "transfer-minute") { seconds = billedSeconds(transferLegs, r.incrementSeconds ?? 1); quantity = BigInt(seconds); divisor = 60n; }
    if (r.basis === "webhook-event") quantity = webhookEvents;
    divisor *= BigInt(r.quantityPer ?? 1);
    let numerator = BigInt(r.micros) * quantity;
    let denominator = divisor * 10000n; // micro dollars -> cents
    if (r.currency === "USD") { numerator *= 1_000_000n * (10000n + card); denominator *= fx * 10000n; }
    // Round a vendor line per client first, then scale, so cohorts preserve cent totals.
    const amount = safe(round(numerator, denominator));
    const tax = splitGst(amount, r.gst);
    const factor = PER_CLIENT.includes(r.basis) ? clients : 1n;
    const credit = input.gstRegistered && r.creditEligible ? tax.gstCents : 0;
    lines.push({ id: r.id, label: r.label, basis: r.basis, cashCents: safe(BigInt(tax.grossCents) * factor), inputGstCents: safe(BigInt(credit) * factor), operatingCents: safe(BigInt(tax.grossCents - credit) * factor), billedSeconds: seconds });
  }
  function payment(gross: number) {
    if (gross === 0) return { grossCents: 0, netCents: 0, gstCents: 0, operatingCents: 0, credit: 0 };
    const cents = safe(round(BigInt(gross) * paymentBps, 10000n) + BigInt(input.payment.fixedCents));
    const tax = splitGst(cents, input.payment.gst);
    const credit = input.gstRegistered && input.payment.creditEligible ? tax.gstCents : 0;
    return { ...tax, operatingCents: tax.grossCents - credit, credit };
  }
  const monthlyPayment = payment(moneyTotal(monthly.grossCents, overage.grossCents, smsOverage.grossCents));
  const paymentCost = safe(BigInt(monthlyPayment.operatingCents) * clients);
  const variable = lines.filter((l) => PER_CLIENT.includes(l.basis));
  const usageLines = variable.filter((l) => PER_MINUTE_USAGE.includes(l.basis));
  const smsLines = variable.filter((l) => l.basis === "sms-segment");
  const sum = (rows: CostResult[], key: "operatingCents" | "cashCents" | "inputGstCents" = "operatingCents") => safe(rows.reduce((n, row) => n + BigInt(row[key]), 0n));
  const variableCost = moneyTotal(sum(variable), paymentCost);
  const sharedCost = sum(lines.filter((l) => l.basis === "shared-month"));
  const supportPerClient = safe(round(BigInt(input.supportMinutesPerClient) * BigInt(input.supportHourlyCents), 60n));
  const support = safe(BigInt(supportPerClient) * clients);
  const contribution = moneyTotal(revenue, -variableCost);
  const operating = moneyTotal(contribution, -support, -sharedCost);
  const setupPrice = priceAmount(pricing.setup, input.gstRegistered);
  const setupPayment = payment(setupPrice.grossCents);
  const setupLabour = safe(round(BigInt(input.onboardingMinutes) * BigInt(input.onboardingHourlyCents), 60n));
  const setupCost = moneyTotal(setupLabour, setupPayment.operatingCents, sum(lines.filter((l) => l.basis === "setup")));
  const usageCost = sum(usageLines);
  const perMinute = actualSeconds > 0 ? safe(ceil(BigInt(usageCost) * 60n, clients * BigInt(actualSeconds))) : null;
  const perCall = callCount > 0 ? safe(round(BigInt(usageCost), clients * BigInt(callCount))) : null;
  const perSms = input.smsSegmentsPerClient > 0 && smsLines.length ? safe(ceil(BigInt(sum(smsLines)), clients * BigInt(input.smsSegmentsPerClient))) : null;
  // Floor covers marginal service cost + percentage collection fee at target net-revenue margin.
  // Fixed payment fee is already in monthly fees; overage is collected on the same invoice.
  const saleTaxFactor = input.gstRegistered && pricing.overagePerMinute.gst !== "none" ? 11000n : 10000n;
  const feeTaxNumerator = input.payment.gst === "exclusive" && !(input.gstRegistered && input.payment.creditEligible) ? 11000n : 10000n;
  const feeTaxDenominator = input.payment.gst === "inclusive" && input.gstRegistered && input.payment.creditEligible ? 11000n : 10000n;
  const marginDenominator = (10000n - BigInt(input.targetMarginBps)) * 10000n * feeTaxDenominator - paymentBps * saleTaxFactor * feeTaxNumerator;
  const floorFor = (cost: number | null) => cost === null || marginDenominator <= 0n ? null : safe(ceil(BigInt(cost) * 10000n * 10000n * feeTaxDenominator, marginDenominator));
  const quoted = (floor: number | null, price: PackagePrice) => floor === null ? null : price.gst === "inclusive" && input.gstRegistered ? safe(ceil(BigInt(floor) * 11n, 10n)) : floor;
  const floorExGst = floorFor(perMinute);
  const floorQuoted = quoted(floorExGst, pricing.overagePerMinute);
  const smsFloorExGst = floorFor(perSms);
  const fixedDirect = sum(variable.filter((l) => l.basis === "client-month" || l.basis === "number-month")) / input.clients;
  const smsDirect = sum(smsLines) / input.clients;
  const basePayment = payment(monthly.grossCents).operatingCents;
  const includedHeadroom = moneyTotal(monthly.netCents, -basePayment, -Math.ceil(fixedDirect), -Math.ceil(smsDirect), -supportPerClient, -safe(ceil(BigInt(sharedCost), clients)));
  const beforeShared = moneyTotal(contribution, -support);
  const monthlyInputGst = safe(BigInt(sum(lines.filter((l) => l.basis !== "setup"), "inputGstCents")) + BigInt(monthlyPayment.credit) * clients);
  return {
    basis: "estimate" as const, incomplete: input.rates.some((r) => r.micros === null || r.gst === "unknown"), warnings,
    clients: input.clients, actualSeconds, customerBillableSeconds: customerSeconds, callCount, overageMinutes, smsOverageSegments,
    includedUtilisationBps: pricing.includedMinutes > 0 ? Math.round(customerSeconds * 10000 / (pricing.includedMinutes * 60)) : null,
    grossRevenueCents: grossRevenue, revenueExGstCents: revenue, outputGstCents: outputGst,
    variableCostCents: variableCost, paymentCostCents: paymentCost, contributionCents: contribution,
    sharedPlatformCents: sharedCost, supportCents: support, operatingContributionCents: operating,
    contributionMarginBps: revenue ? Math.round(contribution * 10000 / revenue) : null,
    operatingMarginBps: revenue ? Math.round(operating * 10000 / revenue) : null,
    monthlyInputGstCents: monthlyInputGst, estimatedNetGstCents: moneyTotal(outputGst, -monthlyInputGst),
    perMinuteCents: perMinute, perCallCents: perCall, perSmsSegmentCents: perSms,
    overageFloorExGstCents: floorExGst, overageFloorQuotedCents: floorQuoted,
    overageBelowFloor: floorQuoted !== null && pricing.overagePerMinute.cents < floorQuoted,
    smsFloorExGstCents: smsFloorExGst,
    smsBelowFloor: smsFloorExGst !== null && pricing.extraSmsSegment.cents < (quoted(smsFloorExGst, pricing.extraSmsSegment) ?? 0),
    breakEvenIncludedMinutes: perMinute === null || perMinute === 0 ? null : Math.max(0, Math.floor(includedHeadroom / perMinute)),
    breakEvenClients: beforeShared <= 0 ? null : Math.max(1, safe(ceil(BigInt(sharedCost) * clients, BigInt(beforeShared)))),
    setup: { revenueExGstCents: setupPrice.netCents, outputGstCents: setupPrice.gstCents, costCents: setupCost, labourCents: setupLabour, paymentCents: setupPayment.operatingCents, contributionCents: moneyTotal(setupPrice.netCents, -setupCost), paybackCovered: setupPrice.netCents >= setupCost },
    lines,
  };
}

export function defaultEconomicsInput(pkg: ReceptionistPackage, scenarioId: UsageScenario["id"] = "base"): EconomicsInput {
  const scenario = pkg.model.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  return {
    package: pkg, clients: 5, calls: scenario.calls.map((c) => ({ ...c })),
    notificationsPerClient: 0, smsSegmentsPerClient: scenario.smsSegments, phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
    rates: DEFAULT_COST_RATES, fx: { ...DEFAULT_FX }, gstRegistered: true,
    supportMinutesPerClient: scenario.supportMinutes, supportHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    onboardingMinutes: pkg.model.onboardingMinutes, onboardingHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    payment: { ...DEFAULT_PAYMENT }, targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
  };
}

/**
 * Three cost columns per line. Only "estimated" has values: nothing has been measured over a
 * usable sample and no invoice has been reconciled. Nulls carry the reason, never a zero.
 */
export function costEvidenceTable(rates: readonly CostRate[] = DEFAULT_COST_RATES) {
  return rates.map((r) => ({
    id: r.id, label: r.label, basis: r.basis, currency: r.currency,
    estimatedMicros: r.micros, estimateEvidence: r.evidence, source: r.source, checkedAt: r.checkedAt, effectiveFrom: r.effectiveFrom,
    measuredMicros: null as number | null,
    measuredReason: r.id === "retell"
      ? "Not established. The dashboard showed about A$0.17/min over 2 calls (6 min) on 26 Sep: too small a sample, before booking/SMS, and a per-call estimate rather than a bill. Needs one month of duration metadata after go-live."
      : "Not established: no production usage for a paying receptionist client yet.",
    invoiceReconciledMicros: null as number | null,
    invoiceReason: "Not reconciled: no provider invoice has been matched to usage metadata. Requires owner-authorised access to the monthly invoice totals (no caller content).",
  }));
}

/** Deterministic tier × scenario × client-count matrix used by the sales pack and dashboard. */
export function packageEconomicsMatrix(clientCounts: readonly number[] = CLIENT_COUNTS) {
  return RECEPTIONIST_PACKAGES.map((pkg) => ({
    packageId: pkg.id, name: pkg.name, tier: pkg.tier,
    monthlyExGstCents: pkg.pricing.monthly.cents, setupExGstCents: pkg.pricing.setup.cents,
    setupStatus: pkg.pricing.setupStatus ?? pkg.pricing.status,
    ...((pkg.pricing.setupStatus ?? pkg.pricing.status) === "approved" ? {} : { setupNote: "Setup figures are a SCENARIO using a proposed setup fee, not approved revenue, until setupStatus is approved." }),
    includedMinutes: pkg.pricing.includedMinutes, overageExGstCents: pkg.pricing.overagePerMinute.cents,
    scenarios: pkg.model.scenarios.map((s) => ({
      scenarioId: s.id, label: s.label,
      minutesPerClient: s.calls.reduce((n, c) => n + c.count * c.seconds, 0) / 60,
      smsSegmentsPerClient: s.smsSegments, supportMinutesPerClient: s.supportMinutes,
      byClients: clientCounts.map((clients) => {
        const r = calculateEconomics({ ...defaultEconomicsInput(pkg, s.id), clients });
        return {
          clients,
          estimated: {
            revenueExGstCents: r.revenueExGstCents, variableCostCents: r.variableCostCents, contributionCents: r.contributionCents,
            contributionMarginBps: r.contributionMarginBps, supportCents: r.supportCents, sharedPlatformCents: r.sharedPlatformCents,
            operatingContributionCents: r.operatingContributionCents, operatingMarginBps: r.operatingMarginBps,
            perMinuteCents: r.perMinuteCents, overageFloorExGstCents: r.overageFloorExGstCents, overageBelowFloor: r.overageBelowFloor,
            breakEvenIncludedMinutes: r.breakEvenIncludedMinutes, breakEvenClients: r.breakEvenClients,
            incomplete: r.incomplete,
          },
          measured: null, measuredReason: "No production usage yet.",
          invoiceReconciled: null, invoiceReason: "No invoice reconciled.",
        };
      }),
    })),
    setup: (() => { const r = calculateEconomics(defaultEconomicsInput(pkg)); return r.setup; })(),
  }));
}

/** Stable JSON for the sales pack. No wall-clock values. */
export function exportPackageEconomicsJson(): string {
  return JSON.stringify({
    schemaVersion: 1, asOf: ECONOMICS_AS_OF, mode: "estimate-only", publishable: false,
    assumptions: {
      fx: DEFAULT_FX, payment: DEFAULT_PAYMENT, stripeFrom20261001: STRIPE_FROM_2026_10_01,
      labourHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS, targetOverageMarginBps: DEFAULT_TARGET_MARGIN_BPS,
      gst: "Prices ex GST. Model assumes GST registration with eligible Stripe fee credits; unregistered leaves net revenue unchanged and removes credits.",
      unknownCosts: DEFAULT_COST_RATES.filter((r) => r.micros === null).map((r) => r.id),
    },
    costEvidence: costEvidenceTable(),
    packages: packageEconomicsMatrix(),
  }, null, 2) + "\n";
}

/** Local scenario snapshot, never a price approval or publishable client offer. */
export function exportEconomicsDraftJson(input: EconomicsInput): string {
  const estimate = calculateEconomics(input);
  const proposal = projectPackageProposal(input.package.id);
  // Approval is carried per field from the catalogue; any edited price, allowance or rate is a scenario.
  const catalogue = getReceptionistPackage(input.package.id).pricing;
  const edited = input.package.pricing.monthly.cents !== catalogue.monthly.cents || input.package.pricing.includedMinutes !== catalogue.includedMinutes
    || input.package.pricing.overagePerMinute.cents !== catalogue.overagePerMinute.cents || input.package.pricing.setup.cents !== catalogue.setup.cents;
  const setupStatus = catalogue.setupStatus ?? catalogue.status;
  proposal.pricing = structuredClone(edited
    ? { ...input.package.pricing, status: "proposed" as const, setupStatus: "proposed" as const, approvedAt: null, approvalReference: null, rationale: "Workbench scenario that overrides the catalogue; not approved." }
    : { ...input.package.pricing, status: catalogue.status, setupStatus, approvedAt: catalogue.approvedAt, approvalReference: catalogue.approvalReference });
  proposal.approvalRequired = edited || setupStatus !== "approved";
  const monthlyText = edited ? "edited scenario, not approved" : catalogue.status === "approved" ? `approved ${catalogue.approvedAt ?? ""}`.trim() : "proposed, not approved";
  return JSON.stringify({ schemaVersion: 1, mode: "draft-only", publishable: false,
    notice: `DRAFT — NOT A QUOTE. Prices ex GST; M&U is GST registered, so 10% GST is added on invoices. Monthly price, included minutes and extra-minute rate: ${monthlyText}. Setup fee: ${edited || setupStatus !== "approved" ? "proposed, not approved" : "approved"}. Pilot terms: not approved. Unknown costs remain excluded; estimates only.`,
    proposal, scenario: { ...input, package: undefined }, estimate,
    sourceNotes: "Rate edits and FX overrides are assumptions, not new official observations. Source links and dates describe the reference evidence.",
  }, null, 2) + "\n";
}

const pct = (bps: number | null) => bps === null ? "n/a" : `${Math.round(bps / 100)}%`;
const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
/**
 * The pricing note for owner review, derived entirely from the package catalogue and this model:
 * no price, minute or margin is typed here, so a catalogue edit cannot leave a stale figure behind.
 * The headline fields describe the entry tier (the CRM's default package).
 */
export function priceRecommendation() {
  const tiers = [...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier);
  const entry = tiers[0];
  const margin = (scenario: UsageScenario["id"]) => list(tiers.map((pkg) => pct(calculateEconomics(defaultEconomicsInput(pkg, scenario)).operatingMarginBps)));
  const clients = defaultEconomicsInput(entry).clients;
  const approved = tiers.every((pkg) => pkg.pricing.status === "approved");
  return {
    status: approved ? "approved" as const : "proposed" as const, asOf: ECONOMICS_AS_OF, packageId: entry.id,
    monthlyExGstCents: priceAmount(entry.pricing.monthly, false).netCents, setupExGstCents: priceAmount(entry.pricing.setup, false).netCents,
    setupStatus: entry.pricing.setupStatus ?? entry.pricing.status,
    ...((entry.pricing.setupStatus ?? entry.pricing.status) === "approved" ? {} : { setupNote: "Setup figures are a SCENARIO using a proposed setup fee, not approved revenue, until setupStatus is approved." }),
    includedMinutes: entry.pricing.includedMinutes, overageExGstCents: priceAmount(entry.pricing.overagePerMinute, false).netCents,
    rationale: `${tiers.length} ${approved ? "approved" : "proposed"} tiers on the owner's anchors, quoted ex GST: ${list(tiers.map((pkg) =>
      `${pkg.shortName} ${formatAud(priceAmount(pkg.pricing.monthly, false).netCents)}/month (${pkg.pricing.includedMinutes.toLocaleString("en-AU")} min, ${formatAud(priceAmount(pkg.pricing.overagePerMinute, false).netCents)}/min over, ${formatAud(priceAmount(pkg.pricing.setup, false).netCents)} setup ${(pkg.pricing.setupStatus ?? pkg.pricing.status) === "approved" ? "approved" : "proposed, not approved"})`))}. ` +
      `Base-case operating margins at ${clients} clients are about ${margin("base")} on known costs (high usage about ${margin("high")}); unknown database, alert and concurrency costs still reduce them. ` +
      `Estimates only: ${approved ? "monthly prices, allowances and extra-minute rates are approved in the catalogue; setup fees and pilot terms are not" : "no monthly price is approved"}, and the live line does not book yet.`,
  };
}
/** Computed once at load, after every rate and helper above is initialised. */
export const PRICE_RECOMMENDATION = priceRecommendation();
/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Stress test, 28 Sep 2026: approved prices and launch allowances, estimates only.
 * Everything below is a deterministic function of the catalogue, DEFAULT_COST_RATES and the labelled
 * STRESS_ASSUMPTIONS. Nothing is measured; the "measured" column stays null until invoices exist.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export const REVIEW_TRIGGER = "Review allowances, rates and support time after the first 30 days of paid service or the first five paying clients, whichever comes first (owner decision 28 Sep 2026). Until then every figure is an estimate, not measured profit.";
const MEASURED_REASON = "No paying receptionist client and no provider invoice yet; fill from reconciled invoices after the review trigger.";

/** Retell per-minute components in US$ millionths, read from the official pricing page on 28 Sep 2026. */
export const RETELL_COMPONENTS = {
  infra: 55000, platformVoice: 15000, elevenlabsVoice: 40000,
  gpt41mini: 12800, claude45haiku: 25000, gpt6AstraFast: 640000,
  knowledgeBase: 5000, denoising: 5000, guardrails: 5000, piiRemoval: 10000, aiQualityAssurance: 100000,
  customTelephony: 0, retellTelephony: 15000,
} as const;
export type RetellComponent = keyof typeof RETELL_COMPONENTS;
export type RetellConfiguration = { id: string; label: string; components: readonly RetellComponent[]; micros: number; evidence: string };
const retellConfig = (id: string, label: string, components: readonly RetellComponent[], evidence: string): RetellConfiguration =>
  ({ id, label, components, micros: components.reduce((n, c) => n + RETELL_COMPONENTS[c], 0), evidence });
/** Retell's own headline range, quoted exactly from the pricing page. */
export const RETELL_PUBLISHED_RANGE = { lowMicros: 70000, highMicros: 310000, text: "$0.07-$0.31 / min for AI Voice Agents", source: RATE_SOURCES.retell, checkedAt: ECONOMICS_AS_OF } as const;
export const RETELL_CONFIGURATIONS: readonly RetellConfiguration[] = [
  retellConfig("generator-default", "Receptionist generator default: gpt-4.1-mini + retell-Cimo (Retell platform voice)", ["infra", "platformVoice", "gpt41mini", "customTelephony"],
    "D:/MU-Receptionist-wt-prompt @ 4debd33: src/lib/buildmaster/provision-plan.ts DEFAULT_MODEL 'gpt-4.1-mini' and DEFAULT_VOICE_ID 'retell-Cimo' ('placeholder platform voice', build-report.ts). Standard LLM tier; the generator sets no knowledge-base, denoising, guardrail or PII add-on."),
  retellConfig("live-demo-recorded", "Live demo agent as recorded 27 Sep: Claude 4.5 Haiku + a retell- voice (platform tier assumed from the prefix)", ["infra", "platformVoice", "claude45haiku", "customTelephony"],
    "27 Sep live-config read (MU-Workspace memory/master-v3/ENTITY-MAP.md rows 3 and 10). Not re-read on 28 Sep: no live Retell call is allowed in this task. Voice tier unconfirmed."),
  retellConfig("modelled-base", "Modelled base (conservative): Claude 4.5 Haiku + ElevenLabs voice tier", ["infra", "elevenlabsVoice", "claude45haiku", "customTelephony"],
    "DEFAULT_COST_RATES retell. Dearer than either configuration above, so the estimates err towards cost."),
  retellConfig("max-config", "Published maximum configuration: ElevenLabs + GPT 6 Astra fast tier + every per-minute add-on", ["infra", "elevenlabsVoice", "gpt6AstraFast", "knowledgeBase", "denoising", "guardrails", "piiRemoval", "aiQualityAssurance", "customTelephony"],
    "Every per-minute component on the official page at its maximum. Retell telephony (US$0.015) excluded because M&U brings its own Twilio SIP trunk; AI QA's first 100 free minutes ignored."),
];

export type RetellStressId = "base" | "plus25" | "plus50" | "range-top" | "max-config";
const BASE_RETELL_MICROS = DEFAULT_COST_RATES.find((r) => r.id === "retell")?.micros ?? 0;
const usd = (micros: number) => `US$${(micros / 1_000_000).toFixed(micros % 1000 === 0 ? 3 : 4)}`;
const retellMax = RETELL_CONFIGURATIONS.find((c) => c.id === "max-config")!.micros;
export const RETELL_STRESS: readonly { id: RetellStressId; label: string; micros: number }[] = [
  { id: "base", label: `Base ${usd(BASE_RETELL_MICROS)}`, micros: BASE_RETELL_MICROS },
  { id: "plus25", label: `+25% ${usd(BASE_RETELL_MICROS * 125 / 100)}`, micros: BASE_RETELL_MICROS * 125 / 100 },
  { id: "plus50", label: `+50% ${usd(BASE_RETELL_MICROS * 150 / 100)}`, micros: BASE_RETELL_MICROS * 150 / 100 },
  { id: "range-top", label: `Published range top ${usd(RETELL_PUBLISHED_RANGE.highMicros)}`, micros: RETELL_PUBLISHED_RANGE.highMicros },
  { id: "max-config", label: `Published max config ${usd(retellMax)}`, micros: retellMax },
];

/** Planning assumptions for the stress test. Every one is an ASSUMPTION, not an observation. */
export const STRESS_ASSUMPTIONS = {
  status: "assumption" as const,
  callSeconds: 150,
  /** Hang-ups and never-connected calls: carried by Retell and Twilio (Twilio rounds each to a minute), never billed to the client. */
  nonBillableCallShareBps: 500, nonBillableCallSeconds: 4,
  /** Share of billable calls that end in a booking (drives SMS). */
  bookingShareBps: 5000,
  /** Essential sends a confirmation only; Professional and Premium also send a reminder (catalogue functions). */
  smsMessagesPerBooking: { "receptionist-essential": 1, "receptionist-professional": 2, "receptionist-premium": 2 } as Readonly<Record<PackageId, number>>,
  /** GSM-7 templates are capped at two segments (receptionist src/lib/sms/templates.ts): base 1, stress 2. */
  smsSegmentsPerMessageBase: 1, smsSegmentsPerMessageStress: 2,
  /** call_started + call_ended + call_analyzed + two booking tool calls. */
  webhookEventsPerCall: 5,
  /** Base +10% redeliveries; stress +300% (Retell retries up to three times on any non-2xx). */
  webhookDuplicateBps: 1000, webhookDuplicateStressBps: 30000,
  /** Transfer is not offered today (base 0%); the stress case cold-transfers 10% of calls for 3 minutes each. */
  transferShareBps: 0, transferStressShareBps: 1000, transferSeconds: 180,
  /** Founder time valued at A$60/hour. Not a wage actually paid and not measured. */
  labourHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
  /** Support minutes follow the catalogue scenarios: ≤50% usage = low, ≤100% = base, above = high. */
  supportScenarioByUsage: "≤50% low, ≤100% base, >100% high (catalogue model.scenarios)",
  /** Extra first-month support beyond the monthly scenario (Premium: daily call review for two weeks). */
  firstMonthExtraSupportMinutes: { "receptionist-essential": 120, "receptionist-professional": 180, "receptionist-premium": 600 } as Readonly<Record<PackageId, number>>,
  clientsForGrid: 5,
};

export const STRESS_USAGE_BPS = [2500, 5000, 7500, 10000, 15000] as const;
export type StressOptions = {
  usageBps: number; retell: RetellStressId; clients: number;
  smsSegmentsPerMessage: number; transferShareBps: number; transferSeconds: number;
  webhookDuplicateBps: number; supportMultiplierBps: number;
  /** false = the client is never charged overage (minutes or SMS): what the base fee alone funds. */
  chargeOverage: boolean;
};
export const STRESS_DEFAULTS: Readonly<StressOptions> = {
  usageBps: 10000, retell: "base", clients: STRESS_ASSUMPTIONS.clientsForGrid,
  smsSegmentsPerMessage: STRESS_ASSUMPTIONS.smsSegmentsPerMessageBase, transferShareBps: STRESS_ASSUMPTIONS.transferShareBps,
  transferSeconds: STRESS_ASSUMPTIONS.transferSeconds, webhookDuplicateBps: STRESS_ASSUMPTIONS.webhookDuplicateBps,
  supportMultiplierBps: 10000, chargeOverage: true,
};

function stressRetellMicros(id: RetellStressId): number {
  const row = RETELL_STRESS.find((r) => r.id === id);
  if (!row) throw new Error(`Unknown Retell stress case: ${id}`);
  return row.micros;
}

/** Usage profile for one client at `minutes` billable minutes (defaults to the usage share of the allowance). */
export function stressUsage(pkg: ReceptionistPackage, opts: StressOptions, minutesOverride?: number) {
  const a = STRESS_ASSUMPTIONS;
  const minutes = minutesOverride ?? Math.ceil(pkg.pricing.includedMinutes * integerNumber(opts.usageBps, "usage") / 10000);
  const seconds = integerNumber(minutes, "minutes") * 60;
  const full = Math.floor(seconds / a.callSeconds); const rest = seconds % a.callSeconds;
  const calls: UsageBucket[] = full ? [{ count: full, seconds: a.callSeconds }] : [];
  if (rest) calls.push({ count: 1, seconds: rest });
  const billableCalls = full + (rest ? 1 : 0);
  const nonBillableCalls = Math.round(billableCalls * a.nonBillableCallShareBps / 10000);
  if (nonBillableCalls) calls.push({ count: nonBillableCalls, seconds: a.nonBillableCallSeconds });
  const bookings = Math.floor(billableCalls * a.bookingShareBps / 10000);
  const smsSegments = bookings * a.smsMessagesPerBooking[pkg.id] * integerNumber(opts.smsSegmentsPerMessage, "SMS segments per message");
  const transfers = Math.floor(billableCalls * integerNumber(opts.transferShareBps, "transfer share") / 10000);
  const webhookEvents = Math.ceil((billableCalls + nonBillableCalls) * a.webhookEventsPerCall * (10000 + integerNumber(opts.webhookDuplicateBps, "duplicates")) / 10000);
  const scenarioId: UsageScenario["id"] = opts.usageBps <= 5000 ? "low" : opts.usageBps <= 10000 ? "base" : "high";
  const scenario = pkg.model.scenarios.find((s) => s.id === scenarioId)!;
  const supportMinutes = Math.round(scenario.supportMinutes * integerNumber(opts.supportMultiplierBps, "support multiplier") / 10000);
  return { minutes, calls, billableCalls, nonBillableCalls, bookings, smsSegments, transfers, transferLegs: transfers ? [{ count: transfers, seconds: opts.transferSeconds }] : [], webhookEvents, supportScenario: scenarioId, supportMinutes };
}
function integerNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

/** The EconomicsInput for one stress cell. Pure; never mutates the catalogue. */
export function stressInput(pkg: ReceptionistPackage, opts: StressOptions = STRESS_DEFAULTS, minutesOverride?: number): EconomicsInput {
  const u = stressUsage(pkg, opts, minutesOverride);
  const priced = opts.chargeOverage ? pkg : (() => { const p = structuredClone(pkg); p.pricing.overagePerMinute.cents = 0; p.pricing.extraSmsSegment.cents = 0; return p; })();
  const retell = stressRetellMicros(opts.retell);
  return {
    ...defaultEconomicsInput(priced, u.supportScenario), clients: opts.clients, calls: u.calls,
    smsSegmentsPerClient: u.smsSegments, transferLegs: u.transferLegs, webhookEventsPerClient: u.webhookEvents,
    supportMinutesPerClient: u.supportMinutes, supportHourlyCents: STRESS_ASSUMPTIONS.labourHourlyCents,
    rates: DEFAULT_COST_RATES.map((r) => r.id === "retell" ? { ...r, micros: retell } : r),
  };
}

const perClient = (total: number, clients: number) => Math.round(total / clients);

/** One grid cell: estimated per-client figures, margins, and an empty measured column. */
export function stressCell(pkg: ReceptionistPackage, opts: StressOptions = STRESS_DEFAULTS, minutesOverride?: number) {
  const u = stressUsage(pkg, opts, minutesOverride);
  const r = calculateEconomics(stressInput(pkg, opts, minutesOverride));
  const n = opts.clients;
  const line = (id: string) => { const l = r.lines.find((x) => x.id === id); return l ? perClient(l.operatingCents, n) : null; };
  const overageRevenue = opts.chargeOverage ? r.overageMinutes * pkg.pricing.overagePerMinute.cents : 0;
  return {
    packageId: pkg.id, usageBps: opts.usageBps, retell: opts.retell, clients: n,
    usage: { minutesPerClient: u.minutes, billableCalls: u.billableCalls, nonBillableCalls: u.nonBillableCalls, bookings: u.bookings, smsSegments: u.smsSegments, transfers: u.transfers, webhookEvents: u.webhookEvents, supportMinutes: u.supportMinutes, overageMinutes: r.overageMinutes, smsOverageSegments: r.smsOverageSegments },
    estimated: {
      basis: "estimate" as const,
      perClient: {
        revenueExGstCents: perClient(r.revenueExGstCents, n), overageRevenueExGstCents: overageRevenue,
        retellCents: line("retell"), carrierCents: line("carrier"), transferCents: (line("transfer-termination") ?? 0) + (line("transfer-origination") ?? 0),
        smsCents: line("sms"), numberCents: line("number"), webhookCents: line("webhook"), paymentCents: perClient(r.paymentCostCents, n),
        variableCostCents: perClient(r.variableCostCents, n), contributionCents: perClient(r.contributionCents, n),
        supportCents: perClient(r.supportCents, n), sharedPlatformCents: perClient(r.sharedPlatformCents, n), operatingCents: perClient(r.operatingContributionCents, n),
      },
      contributionMarginBps: r.contributionMarginBps, operatingMarginBps: r.operatingMarginBps,
      incomplete: r.incomplete,
    },
    measured: null, measuredReason: MEASURED_REASON,
  };
}

/** Smallest billable minutes per client at which the operating margin goes negative, or null if not within `ceilingMultiple` × allowance. */
export function breakEvenMinutes(pkg: ReceptionistPackage, opts: StressOptions = STRESS_DEFAULTS, ceilingMultiple = 20): number | null {
  const op = (m: number) => calculateEconomics(stressInput(pkg, opts, m)).operatingContributionCents;
  const search = (lo: number, hi: number) => { while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (op(mid) < 0) hi = mid; else lo = mid; } return hi; };
  const allowance = pkg.pricing.includedMinutes; const ceiling = allowance * ceilingMultiple;
  if (op(0) < 0) return 0;
  if (op(allowance) < 0) return search(0, allowance);
  if (op(ceiling) >= 0) return null;
  return search(allowance, ceiling);
}

/** Net payment burden on an ex-GST price, in parts per million of that price. */
function paymentBurdenPpm(input: EconomicsInput): bigint {
  const bps = BigInt(input.payment.percentBps);
  const gross = input.gstRegistered ? 11n : 10n;
  const credit = input.gstRegistered && input.payment.creditEligible && input.payment.gst === "inclusive";
  return credit ? bps * 100n * gross * 10n / (10n * 11n) : bps * 100n * gross / 10n;
}

/**
 * Overage floor: the marginal voice cost of one more minute (Retell + carrier with per-call rounding + short-call
 * overhead + webhooks), measured over 10,000 extra minutes above the allowance, against the extra-minute price.
 * Units are hundredths of a cent (A$0.0001). SMS is priced separately (A$0.15 beyond the included segments).
 */
export function overageFloor(pkg: ReceptionistPackage, retell: RetellStressId, extraMinutes = 10000) {
  const opts: StressOptions = { ...STRESS_DEFAULTS, retell, clients: 1 };
  const voice = new Set(["retell", "carrier", "webhook"]);
  const cost = (m: number) => calculateEconomics(stressInput(pkg, opts, m)).lines.filter((l) => voice.has(l.id)).reduce((n, l) => n + l.operatingCents, 0);
  const allowance = pkg.pricing.includedMinutes;
  const marginal = Math.round((cost(allowance + extraMinutes) - cost(allowance)) * 100 / extraMinutes);
  const burden = paymentBurdenPpm(stressInput(pkg, opts));
  const price = pkg.pricing.overagePerMinute.cents * 100;
  const floorAt = (marginBps: bigint) => { const den = 1_000_000n - marginBps * 100n - burden; return den <= 0n ? null : safe(ceil(BigInt(marginal) * 1_000_000n, den)); };
  const breakEvenFloor = floorAt(0n); const targetFloor = floorAt(BigInt(DEFAULT_TARGET_MARGIN_BPS));
  const headroom = price - marginal - safe(round(BigInt(price) * burden, 1_000_000n));
  return {
    packageId: pkg.id, retell, unit: "A$0.0001 (hundredths of a cent), ex GST" as const,
    priceExGst: price, marginalVoiceCost: marginal, paymentBurdenPpm: Number(burden),
    breakEvenFloor, targetFloor70: targetFloor, headroomPerMinute: headroom,
    aboveMarginalCost: breakEvenFloor !== null && price >= breakEvenFloor,
    meetsTarget70: targetFloor !== null && price >= targetFloor,
  };
}

/** Setup profitability with the PROPOSED setup fee and with no setup fee (fees are not approved). */
export function setupProfitability(pkg: ReceptionistPackage) {
  const r = calculateEconomics(stressInput(pkg, STRESS_DEFAULTS));
  const monthlyOperating = Math.floor(r.operatingContributionCents / STRESS_DEFAULTS.clients);
  const labour = r.setup.labourCents;
  const firstMonthExtra = Math.round(STRESS_ASSUMPTIONS.firstMonthExtraSupportMinutes[pkg.id] * STRESS_ASSUMPTIONS.labourHourlyCents / 60);
  const monthsToRecover = (cost: number) => cost <= 0 ? 0 : monthlyOperating <= 0 ? null : Math.ceil(cost / monthlyOperating);
  return {
    packageId: pkg.id, setupStatus: pkg.pricing.setupStatus, onboardingHours: pkg.model.onboardingMinutes / 60,
    labourCents: labour, firstMonthExtraSupportCents: firstMonthExtra, monthlyOperatingCents: monthlyOperating,
    withProposedFee: {
      feeExGstCents: pkg.pricing.setup.cents, paymentCents: r.setup.paymentCents, setupContributionCents: r.setup.contributionCents,
      firstMonthNetCents: r.setup.contributionCents + monthlyOperating - firstMonthExtra,
      monthsToRecoverOnboarding: monthsToRecover(labour + firstMonthExtra - r.setup.revenueExGstCents + r.setup.paymentCents),
    },
    withoutFee: {
      setupContributionCents: -labour,
      firstMonthNetCents: monthlyOperating - labour - firstMonthExtra,
      monthsToRecoverOnboarding: monthsToRecover(labour + firstMonthExtra),
    },
  };
}

/** Unknown costs: listed with amount null, never folded into a total and never shown as 0. */
export function unknownCostRegister() {
  const rates = DEFAULT_COST_RATES.filter((r) => r.micros === null).map((r) => ({
    id: r.id, label: r.label, amount: null, basis: r.basis as string, whyUnknown: r.note, source: r.source,
    illustrationNotInTotals: r.id === "database" ? "0.25 CU always on = 0.25 × 730 h × US$0.106 = US$19.35/month shared (about A$28.40 with the FX buffer), before storage" : null,
  }));
  const other = [
    { id: "supplier-gst", label: "GST on Retell, Twilio, Vercel and Neon invoices, and whether it is creditable", whyUnknown: "Supplier tax invoices not seen. No GST added and no credit taken on any supplier line." },
    { id: "live-voice-tier", label: "Voice tier of the live Retell agent", whyUnknown: "Recorded 27 Sep as a retell- voice (platform tier by prefix). The base rate uses the dearer ElevenLabs tier until an owner-approved live read confirms it." },
    { id: "bad-debt", label: "Failed payments, disputes, refunds and service credits", whyUnknown: "No payment history. Stripe dispute fees and any service credit policy are not modelled." },
    { id: "business-overhead", label: "Accounting, insurance, legal review of the service agreement, M&U's own phones and domains", whyUnknown: "Business overhead, not allocated per client; not scoped." },
    { id: "fx-settlement", label: "Actual card FX spread on USD bills", whyUnknown: "Modelled as RBA 25 Sep + 3% buffer; the real spread depends on the card used." },
  ].map((x) => ({ ...x, amount: null, basis: "unallocated", source: null, illustrationNotInTotals: null }));
  return [...rates, ...other];
}

const stressLabel = (bps: number) => `${bps / 100}%`;
/** Full deterministic stress report used by the doc, tests and exports. */
export function economicsStressReport() {
  const tiers = [...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier);
  return {
    schemaVersion: 1, asOf: ECONOMICS_AS_OF, catalogueVersion: CATALOGUE_VERSION, basis: "estimate" as const, publishable: false as const,
    reviewTrigger: REVIEW_TRIGGER,
    assumptions: { ...STRESS_ASSUMPTIONS, fx: DEFAULT_FX, payment: DEFAULT_PAYMENT, gstRegistered: true },
    retell: { configurations: RETELL_CONFIGURATIONS, stress: RETELL_STRESS, publishedRange: RETELL_PUBLISHED_RANGE },
    grid: tiers.map((pkg) => ({
      packageId: pkg.id,
      cells: STRESS_USAGE_BPS.flatMap((usageBps) => RETELL_STRESS.map((r) => stressCell(pkg, { ...STRESS_DEFAULTS, usageBps, retell: r.id }))),
    })),
    overlays: tiers.map((pkg) => ({
      packageId: pkg.id,
      cases: STRESS_OVERLAYS.map((o) => ({ id: o.id, label: o.label, cell: stressCell(pkg, { ...STRESS_DEFAULTS, ...o.opts }) })),
    })),
    hostingAllocation: tiers.map((pkg) => ({ packageId: pkg.id, byClients: CLIENT_COUNTS.map((clients) => stressCell(pkg, { ...STRESS_DEFAULTS, clients })) })),
    overageFloors: tiers.map((pkg) => ({ packageId: pkg.id, byRetell: RETELL_STRESS.map((r) => overageFloor(pkg, r.id)) })),
    breakEven: tiers.map((pkg) => ({
      packageId: pkg.id,
      byRetell: RETELL_STRESS.map((r) => ({
        retell: r.id,
        withOverageMinutes: breakEvenMinutes(pkg, { ...STRESS_DEFAULTS, retell: r.id }),
        withoutOverageMinutes: breakEvenMinutes(pkg, { ...STRESS_DEFAULTS, retell: r.id, chargeOverage: false }),
      })),
    })),
    setup: tiers.map((pkg) => setupProfitability(pkg)),
    unknownCosts: unknownCostRegister(),
  };
}

export const STRESS_OVERLAYS: readonly { id: string; label: string; opts: Partial<StressOptions> }[] = [
  { id: "baseline", label: "Baseline: 100% of allowance, base Retell", opts: {} },
  { id: "sms-2-segments", label: "Every SMS is 2 segments", opts: { smsSegmentsPerMessage: STRESS_ASSUMPTIONS.smsSegmentsPerMessageStress } },
  { id: "transfers-10pct", label: "10% of calls cold-transferred for 3 min", opts: { transferShareBps: STRESS_ASSUMPTIONS.transferStressShareBps } },
  { id: "duplicate-webhooks", label: "Every webhook delivered 4 times", opts: { webhookDuplicateBps: STRESS_ASSUMPTIONS.webhookDuplicateStressBps } },
  { id: "support-x2", label: "Support time doubled", opts: { supportMultiplierBps: 20000 } },
  { id: "combined-1-client", label: "Combined: 150% usage, Retell +50%, 2-segment SMS, 10% transfers, 4× webhooks, 2× support, 1 client", opts: { usageBps: 15000, retell: "plus50", smsSegmentsPerMessage: 2, transferShareBps: 1000, webhookDuplicateBps: 30000, supportMultiplierBps: 20000, clients: 1 } },
];

/** Deterministic markdown tables for docs/ECONOMICS-STRESS-20260928.md (the doc embeds this output verbatim). */
export function renderStressMarkdown(): string {
  const rep = economicsStressReport();
  const pct = (bps: number | null) => bps === null ? "n/a" : `${(bps / 100).toFixed(1)}%`;
  const a4 = (h: number | null) => h === null ? "n/a" : `${h < 0 ? "-" : ""}A$${(Math.abs(h) / 10000).toFixed(4)}`;
  const name = (id: string) => getReceptionistPackage(id).shortName;
  const out: string[] = [];
  const toAud = (usdMicros: number) => (usdMicros / 1_000_000 / (DEFAULT_FX.usdPerAudMillionths / 1_000_000) * (1 + DEFAULT_FX.cardFeeBps / 10000)).toFixed(4);
  out.push("### Rates used (checked " + ECONOMICS_AS_OF + "; USD converted at RBA " + DEFAULT_FX.date + " + " + DEFAULT_FX.cardFeeBps / 100 + "% card/FX buffer)", "");
  out.push("| Rate | Amount | Basis | Evidence | Source | Effective |");
  out.push("|---|---:|---|---|---|---|");
  for (const r of DEFAULT_COST_RATES) {
    const amount = r.micros === null ? "**UNKNOWN**" : `${r.currency === "USD" ? "US$" : "A$"}${(r.micros / 1_000_000).toFixed(4)}${r.quantityPer ? ` per ${r.quantityPer.toLocaleString("en-AU")}` : ""}`;
    out.push(`| ${r.label} | ${amount} | ${r.basis}${r.incrementSeconds && r.incrementSeconds > 1 ? `, rounded up per ${r.incrementSeconds} s` : ""} | ${r.evidence} | ${r.source ?? "none"} | ${r.effectiveFrom ?? "not published"} |`);
  }
  out.push(`| Stripe card (from 1 Oct 2026) + Stripe Billing | ${STRIPE_CARD_BPS / 100}% + ${STRIPE_BILLING_BPS / 100}% + A$0.30, fees include GST | GST-inclusive charge | public-list | ${RATE_SOURCES.stripe} | 2026-10-01 (card) |`);
  out.push(`| RBA USD per A$1 | ${(DEFAULT_FX.usdPerAudMillionths / 1_000_000).toFixed(4)} | reference rate, not a settlement quote | public-list | ${RATE_SOURCES.rba} | ${DEFAULT_FX.date} |`);
  out.push(`| Founder labour | ${formatAud(STRESS_ASSUMPTIONS.labourHourlyCents)}/hour | support + onboarding time | **assumption** | none | — |`);
  out.push("", "### Retell configurations (per connected minute; M&U brings its own Twilio SIP trunk, so Retell telephony is US$0)", "");
  out.push("| Configuration | Components | US$/min | A$/min incl. buffer |");
  out.push("|---|---|---:|---:|");
  for (const c of RETELL_CONFIGURATIONS) out.push(`| ${c.label} | ${c.components.filter((x) => RETELL_COMPONENTS[x] > 0).map((x) => `${x} ${(RETELL_COMPONENTS[x] / 1_000_000).toFixed(4)}`).join(" + ")} | ${(c.micros / 1_000_000).toFixed(4)} | ${toAud(c.micros)} |`);
  out.push(`| Retell's published headline range | ${RETELL_PUBLISHED_RANGE.text} | ${(RETELL_PUBLISHED_RANGE.lowMicros / 1_000_000).toFixed(2)}–${(RETELL_PUBLISHED_RANGE.highMicros / 1_000_000).toFixed(2)} | ${toAud(RETELL_PUBLISHED_RANGE.lowMicros)}–${toAud(RETELL_PUBLISHED_RANGE.highMicros)} |`);
  out.push("", "### Grid: margin per client by usage and Retell rate (5 clients, estimate)", "");
  for (const g of rep.grid) {
    const pkg = getReceptionistPackage(g.packageId);
    out.push(`**${pkg.shortName}** · ${formatAud(pkg.pricing.monthly.cents)}/month ex GST · ${pkg.pricing.includedMinutes.toLocaleString("en-AU")} min · ${formatAud(pkg.pricing.overagePerMinute.cents)}/extra min`, "");
    out.push(`| Usage | Minutes | Revenue ex GST | Variable cost (base) | Contribution (base) | ${RETELL_STRESS.map((r) => `Operating · ${r.label}`).join(" | ")} | Measured |`);
    out.push(`|---|---:|---:|---:|---:|${RETELL_STRESS.map(() => "---:").join("|")}|---|`);
    for (const usageBps of STRESS_USAGE_BPS) {
      const row = g.cells.filter((c) => c.usageBps === usageBps);
      const base = row.find((c) => c.retell === "base")!;
      const p = base.estimated.perClient;
      out.push(`| ${stressLabel(usageBps)} | ${base.usage.minutesPerClient.toLocaleString("en-AU")} | ${formatAud(p.revenueExGstCents)} | ${formatAud(p.variableCostCents)} | ${formatAud(p.contributionCents)} (${pct(base.estimated.contributionMarginBps)}) | ${row.map((c) => `${formatAud(c.estimated.perClient.operatingCents)} (${pct(c.estimated.operatingMarginBps)})`).join(" | ")} | — |`);
    }
    out.push("");
  }
  out.push("### Cost lines per client at 100% of allowance, base Retell (5 clients, estimate)", "");
  out.push("| Tier | Retell | Carrier | SMS | Number | Webhooks | Payment (net of GST credit) | Support | Hosting share | Operating |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const g of rep.grid) {
    const c = g.cells.find((x) => x.usageBps === 10000 && x.retell === "base")!; const p = c.estimated.perClient;
    out.push(`| ${name(g.packageId)} | ${formatAud(p.retellCents ?? 0)} | ${formatAud(p.carrierCents ?? 0)} | ${formatAud(p.smsCents ?? 0)} (${c.usage.smsSegments} seg) | ${formatAud(p.numberCents ?? 0)} | ${p.webhookCents === 0 && c.usage.webhookEvents > 0 ? "<A$0.01" : formatAud(p.webhookCents ?? 0)} (${c.usage.webhookEvents.toLocaleString("en-AU")} events) | ${formatAud(p.paymentCents)} | ${formatAud(p.supportCents)} (${c.usage.supportMinutes} min) | ${formatAud(p.sharedPlatformCents)} | ${formatAud(p.operatingCents)} |`);
  }
  out.push("", "### Stress overlays (100% of allowance unless stated, estimate)", "");
  out.push(`| Case | ${rep.overlays.map((o) => name(o.packageId)).join(" | ")} |`);
  out.push(`|---|${rep.overlays.map(() => "---:").join("|")}|`);
  for (const o of STRESS_OVERLAYS) {
    out.push(`| ${o.label} | ${rep.overlays.map((t) => { const c = t.cases.find((x) => x.id === o.id)!.cell; return `${formatAud(c.estimated.perClient.operatingCents)} (${pct(c.estimated.operatingMarginBps)})`; }).join(" | ")} |`);
  }
  out.push("", "### Hosting allocation by client count (100% of allowance, base Retell; Neon unknown and excluded)", "");
  out.push(`| Tier | ${CLIENT_COUNTS.map((n) => `${n} client${n === 1 ? "" : "s"}`).join(" | ")} |`);
  out.push(`|---|${CLIENT_COUNTS.map(() => "---:").join("|")}|`);
  for (const h of rep.hostingAllocation) {
    out.push(`| ${name(h.packageId)} | ${h.byClients.map((c) => `${formatAud(c.estimated.perClient.sharedPlatformCents)} share → ${pct(c.estimated.operatingMarginBps)}`).join(" | ")} |`);
  }
  out.push("", "### Overage floor: extra-minute price vs marginal voice cost (ex GST, per minute)", "");
  out.push("| Tier | Retell case | Price | Marginal cost | Break-even floor | 70% target floor | Headroom after payment fee | Above marginal cost? |");
  out.push("|---|---|---:|---:|---:|---:|---:|---|");
  for (const f of rep.overageFloors) for (const x of f.byRetell) {
    out.push(`| ${name(f.packageId)} | ${RETELL_STRESS.find((r) => r.id === x.retell)!.label} | ${a4(x.priceExGst)} | ${a4(x.marginalVoiceCost)} | ${a4(x.breakEvenFloor)} | ${a4(x.targetFloor70)} | ${a4(x.headroomPerMinute)} | ${x.aboveMarginalCost ? "yes" : "**NO**"}${x.meetsTarget70 ? "" : " (below 70% target)"} |`);
  }
  out.push("", "### Break-even minutes per client (operating margin goes negative; 5 clients, base support)", "");
  out.push(`| Tier | ${RETELL_STRESS.map((r) => r.label).join(" | ")} |`);
  out.push(`|---|${RETELL_STRESS.map(() => "---:").join("|")}|`);
  for (const b of rep.breakEven) {
    const allowance = getReceptionistPackage(b.packageId).pricing.includedMinutes;
    const fmt = (m: number | null) => m === null ? `never (≤${(allowance * 20).toLocaleString("en-AU")})` : m.toLocaleString("en-AU");
    out.push(`| ${name(b.packageId)} overage charged | ${b.byRetell.map((x) => fmt(x.withOverageMinutes)).join(" | ")} |`);
    out.push(`| ${name(b.packageId)} no overage charged | ${b.byRetell.map((x) => fmt(x.withoutOverageMinutes)).join(" | ")} |`);
  }
  out.push("", "### Setup and first month per new client (labour at the A$60/hour assumption)", "");
  out.push("| Tier | Onboarding | Proposed fee ex GST | Setup contribution with fee | First month net with fee | Setup contribution, no fee | First month net, no fee | Months to recover, no fee |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of rep.setup) {
    out.push(`| ${name(s.packageId)} | ${s.onboardingHours} h (${formatAud(s.labourCents)}) + ${formatAud(s.firstMonthExtraSupportCents)} first-month support | ${formatAud(s.withProposedFee.feeExGstCents)} (${s.setupStatus}) | ${formatAud(s.withProposedFee.setupContributionCents)} | ${formatAud(s.withProposedFee.firstMonthNetCents)} | ${formatAud(s.withoutFee.setupContributionCents)} | ${formatAud(s.withoutFee.firstMonthNetCents)} | ${s.withoutFee.monthsToRecoverOnboarding ?? "never"} |`);
  }
  out.push("", "### Unknown costs (amount null; never in any total above)", "");
  out.push("| Item | Why unknown | Illustration only (not in totals) |");
  out.push("|---|---|---|");
  for (const u of rep.unknownCosts) out.push(`| ${u.label} | ${u.whyUnknown.replace(/\|/g, "/")} | ${u.illustrationNotInTotals ?? "—"} |`);
  return out.join("\n") + "\n";
}

/* ── Consistency fixture: one synthetic customer every app must invoice identically ── */

export const CONSISTENCY_FIXTURE_USAGE = {
  packageId: "receptionist-professional" as PackageId,
  /** 480 calls × 150 s = 72,000 s = 1,200 billable minutes under PER_PERIOD rounding. */
  calls: [{ count: 480, seconds: 150 }] as UsageBucket[],
  smsSegments: 40,
  /** Two of the 480 calls were cold-transferred; each ran 3 minutes after the handoff (carrier-only, not billable). */
  transferLegs: [{ count: 2, seconds: 180 }] as UsageBucket[],
};

export function receptionistConsistencyFixture() {
  const pkg = getReceptionistPackage(CONSISTENCY_FIXTURE_USAGE.packageId);
  const input: EconomicsInput = {
    ...defaultEconomicsInput(pkg), clients: 1, calls: CONSISTENCY_FIXTURE_USAGE.calls.map((c) => ({ ...c })),
    smsSegmentsPerClient: CONSISTENCY_FIXTURE_USAGE.smsSegments, transferLegs: CONSISTENCY_FIXTURE_USAGE.transferLegs.map((c) => ({ ...c })),
    webhookEventsPerClient: 0,
  };
  const r = calculateEconomics(input);
  const line = (id: string, description: string, quantity: number, unit: PackagePrice) => {
    const amount = priceAmount({ ...unit, cents: unit.cents * quantity }, true);
    return { id, description, quantity, unitExGstCents: unit.cents, exGstCents: amount.netCents, gstCents: amount.gstCents, inclGstCents: amount.grossCents };
  };
  const lines = [
    line("monthly", `${pkg.name}, monthly fee`, 1, pkg.pricing.monthly),
    line("overage-minutes", `Extra AI minutes beyond ${pkg.pricing.includedMinutes.toLocaleString("en-AU")} included`, r.overageMinutes, pkg.pricing.overagePerMinute),
    line("sms-overage", `Extra SMS segments beyond ${pkg.pricing.includedSmsSegments} included`, r.smsOverageSegments, pkg.pricing.extraSmsSegment),
  ];
  const sum = (k: "exGstCents" | "gstCents" | "inclGstCents") => lines.reduce((n, l) => n + l[k], 0);
  const totals = { exGstCents: sum("exGstCents"), gstCents: sum("gstCents"), totalInclGstCents: sum("inclGstCents") };
  if (totals.exGstCents !== r.revenueExGstCents || totals.gstCents !== r.outputGstCents) throw new Error("Fixture invoice lines disagree with calculateEconomics");
  const perCall = CONSISTENCY_FIXTURE_USAGE.calls.reduce((n, c) => n + c.count * Math.ceil(c.seconds / 60), 0);
  return {
    schemaVersion: 1, fixtureId: "rx-consistency-professional-1200min", synthetic: true,
    generatedBy: "AgenticOS-v4 src/lib/business-economics.ts receptionistConsistencyFixture()", catalogueVersion: CATALOGUE_VERSION, ratesAsOf: ECONOMICS_AS_OF,
    purpose: "The receptionist app, CRM proposal and Finance must reproduce expectedInvoice exactly from this usage. Synthetic data only.",
    customer: { packageId: pkg.id, name: "Synthetic Dental Pty Ltd (fixture)", gstRegistered: true, currency: "AUD", roundingMode: pkg.pricing.billing.receptionistRoundingMode, minimumBillableSeconds: pkg.pricing.billing.minimumBillableSeconds },
    usage: {
      calls: CONSISTENCY_FIXTURE_USAGE.calls, billableSeconds: r.customerBillableSeconds, billableMinutes: r.customerBillableSeconds / 60,
      smsSegments: CONSISTENCY_FIXTURE_USAGE.smsSegments,
      transfers: { legs: CONSISTENCY_FIXTURE_USAGE.transferLegs, customerBillable: false, note: "Transfer is not offered in any tier today. Post-transfer minutes are carrier cost only: Retell's AI fee stops at the handoff and the client is billed for AI minutes only." },
    },
    expectedInvoice: {
      includedMinutes: pkg.pricing.includedMinutes, overageMinutes: r.overageMinutes, overageRateExGstCents: pkg.pricing.overagePerMinute.cents,
      includedSmsSegments: pkg.pricing.includedSmsSegments, smsOverageSegments: r.smsOverageSegments,
      lines, totals,
      gstMethod: "GST per line = round-half-up(ex GST × 10%); totals are the sum of lines.",
      setupFee: { status: pkg.pricing.setupStatus, invoiced: false, note: "Setup fees are PROPOSED; no app may add a setup line." },
    },
    mustNotProduce: [
      { case: "PER_CALL rounding", billableMinutes: perCall, overageMinutes: perCall - pkg.pricing.includedMinutes, overageExGstCents: (perCall - pkg.pricing.includedMinutes) * pkg.pricing.overagePerMinute.cents, why: "The catalogue bills per second summed per period (PER_PERIOD). The receptionist's default PER_CALL mode would bill 480 × 3 min." },
      { case: "transfer minutes billed", billableMinutes: r.customerBillableSeconds / 60 + CONSISTENCY_FIXTURE_USAGE.transferLegs.reduce((n, l) => n + l.count * l.seconds, 0) / 60, why: "Post-transfer minutes are not AI minutes." },
      { case: "setup fee invoiced", why: "setupStatus is proposed." },
    ],
    financeEstimate: {
      basis: "estimate" as const, measured: null, measuredReason: MEASURED_REASON,
      costLinesCents: Object.fromEntries(r.lines.filter((l) => l.basis !== "shared-month").map((l) => [l.id, l.operatingCents])),
      paymentFeeNetCents: r.paymentCostCents,
      directCostCents: r.variableCostCents, contributionCents: r.contributionCents, contributionMarginBps: r.contributionMarginBps,
      excluded: "Support labour, shared hosting and every unknown cost (see unknownCostRegister()).",
    },
  };
}

export function exportConsistencyFixtureJson(): string {
  return JSON.stringify(receptionistConsistencyFixture(), null, 2) + "\n";
}
