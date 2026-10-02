// Usage → package economics (Track 5): per-client and per-tier margins on three bases that are
// NEVER mixed in one figure.
//
//   estimated   A client's ACTUAL usage counts (the agency feed's minutes and calls, SMS segments
//               when the feed reports them) × the dated public list rates in business-economics.ts.
//               A tier with no clients falls back to the package model's base scenario, and says so.
//   measured    Provider-reported cost only. Retell's per-call `call_cost` (list-calls), joined to a
//               client through the agency feed's providerCallId → organizationId. Twilio reports an
//               account total, and router receipts carry no client, so those are portfolio lines,
//               never allocated to a client or tier.
//   reconciled  Money actually paid, from the NAB CSV ledger (vendor lines, AUD, NAB fees included).
//               Bank lines are not split by client or tier, so per-client and per-tier reconciled
//               figures are unknown, with the reason.
//
// Revenue is one figure per client: the catalogue price plus overage on the feed's billable minutes
// for the current period (what M&U would bill; nothing here is an issued or paid invoice). Demo
// tenants are never billed. Every figure carries its source and as-of date; unknown is null with a
// reason, never zero. Pure: the plugin supplies every source already read.
import { getReceptionistPackage, RECEPTIONIST_PACKAGES, CATALOGUE_VERSION, type PackageId, type ReceptionistPackage } from "../../src/lib/receptionist-packages";
import {
  calculateEconomics,
  DEFAULT_COST_RATES,
  DEFAULT_FX,
  DEFAULT_LABOUR_HOURLY_CENTS,
  DEFAULT_PAYMENT,
  DEFAULT_TARGET_MARGIN_BPS,
  ECONOMICS_AS_OF,
  packageEconomicsMatrix,
  type CostRate,
} from "../../src/lib/business-economics";
import type { AgencyFeedState, FeedClient, Source } from "./types";
import type { ManualSummary } from "../finance/manual-summary";
import type { RouterReceipt } from "../model-router/receipts";

/**
 * Receipt outcomes that are not provider calls. Mirrors model-router/receipts.ts NOT_A_CALL (pinned
 * by usage-economics.test.ts): that module imports bun:sqlite, and this one reaches the browser.
 */
export const NOT_A_CALL_OUTCOMES: ReadonlySet<string> = new Set(["refused_policy", "exhausted_free", "replay_refused"]);

export type Basis = "estimated" | "measured" | "reconciled";

/** One money figure on one basis. `cents` is AUD cents ex GST; null = unknown, with `note` saying why. */
export type Figure = {
  basis: Basis;
  cents: number | null;
  source: string;
  asOf: string | null;
  /** Some cost lines behind this figure are unknown: a cost is a floor, a margin a ceiling. */
  complete: boolean;
  /** What is missing or why the figure is unknown (plain English, one line each). */
  notes: string[];
};
/** A margin on one basis: revenue minus that basis's cost, never another basis's. */
export type MarginFigure = Figure & { revenueCents: number | null; marginBps: number | null };

/** Retell calls as read from list-calls (retell.ts CallRow), ids and money only. */
export type RetellCostRow = { id: string; startedAt: string | null; usdCents: number | null };

export type UsageEconomicsInput = {
  now: number;
  /** The dashboard's feed (view=metadata): clients, minutes, readiness, package-free. */
  feed: AgencyFeedState;
  /** Locally assigned packages, keyed by slug (or organizationId). Demo tenants are never billed. */
  packageFor: (c: FeedClient) => ReceptionistPackage | null;
  /** Retell list-calls for the line's agent, with when the read completed. */
  retell: Source<{ rows: RetellCostRow[] }>;
  retellReadAt: string | null;
  /**
   * providerCallId → organizationId from the agency feed's full view (ids only: this module never
   * sees caller content). null when the full view couldn't be read.
   */
  attribution: { byCallId: ReadonlyMap<string, string>; windowStart: string | null; asOf: string } | null;
  attributionReason?: string;
  /** Twilio's account month-to-date total (Usage Records ThisMonth, totalprice), USD. */
  twilioMonth: Source<{ usd: number }>;
  twilioReadAt: string | null;
  /** Router receipts this month (model-router/receipts.ts), already summed. null = couldn't read. */
  receipts: { since: string; asOf: string; receptionist: { calls: number; costUsd: number; unknownCostCalls: number }; other: { calls: number; costUsd: number; unknownCostCalls: number } } | null;
  /** NAB CSV ledger, this calendar month: vendor spend actually paid (AUD cents, NAB fees in). */
  ledger: LedgerMonth;
  rates?: readonly CostRate[];
  fx?: typeof DEFAULT_FX;
};

export type LedgerMonth =
  | { state: "none-imported" }
  | { state: "unreadable"; reason: string }
  | {
      state: "ok";
      /** "NAB CSV imported, as of 26 Sep 2026". */
      statement: string;
      asOf: string | null;
      period: { label: string; from: string | null; to: string | null };
      coverage: "full" | "partial" | "none";
      coverageNote: string | null;
      vendors: { vendorId: string; label: string; netCostCents: number }[];
    };

export type ClientEconomics = {
  organizationId: string;
  slug: string | null;
  isDemoTenant: boolean;
  packageId: PackageId | null;
  packageName: string | null;
  monthStart: string | null;
  /** calls/billableMinutes null: the feed didn't report this client's minutes (unknown, never 0). */
  usage: { calls: number | null; billableMinutes: number | null; smsSegments: number | null; smsSource: string };
  revenue: Figure;
  estimated: MarginFigure;
  measured: MarginFigure & { retell: { matchedCalls: number; feedCalls: number | null; usdCents: number | null; unknownCostCalls: number } };
  reconciled: MarginFigure;
};

export type TierEconomics = {
  packageId: PackageId;
  name: string;
  /** Billed (non-demo) clients on this tier. */
  clients: number;
  revenue: Figure;
  estimated: MarginFigure;
  measured: MarginFigure;
  reconciled: MarginFigure;
};

export type PortfolioLine = Figure & { usdCents: number | null; label: string };

export type UsageEconomics = {
  generatedAt: string;
  fx: { usdPerAud: number; date: string; source: string; note: string };
  catalogue: string;
  ratesCheckedAt: string;
  clients: ClientEconomics[];
  tiers: TierEconomics[];
  portfolio: {
    measured: {
      retell: PortfolioLine & { calls: number; attributedUsdCents: number | null; unattributedUsdCents: number | null };
      twilio: PortfolioLine;
      receptionistModels: PortfolioLine & { calls: number };
      otherModels: PortfolioLine & { calls: number };
      smsSegments: { count: number | null; source: string; asOf: string | null; note: string };
    };
    reconciled: { lines: PortfolioLine[]; statement: string | null; coverage: "full" | "partial" | "none" | null; notes: string[]; asOf: string | null };
  };
};

/**
 * Review R2: a measured margin is shown only when every call the feed reports for the client this
 * month matched a Retell cost (coverage 100%). Below that, the measured COST is a floor ("≥") and
 * the margin is Unknown, because the unmatched calls' cost is unknown.
 */
export const MEASURED_MARGIN_MIN_COVERAGE = 1;
/** A demo tenant or M&U's own organisation (slug mu-…, muv-…): never billed (review R3). */
export function isInternalClient(c: { isDemoTenant: boolean; slug: string | null }): boolean {
  return c.isDemoTenant || /^(mu|m-u|muv)(-|$)/i.test(c.slug ?? "");
}
/** Client count the package model is run at for a tier with no clients (per-client figures are divided back). */
const MODEL_CLIENTS = 5;
const RETELL_SOURCE ="Retell list-calls (call_cost.combined_cost, per call)";
const FEED_SOURCE = "MU-Receptionist agency feed";
const NAB_SOURCE = "NAB CSV import (finance-manual.sqlite)";
const RECEIPTS_SOURCE = "Model router receipts (.operator-data/model-router)";
/** Vendors in the NAB ledger that are receptionist providers or model costs (manual-vendors.ts ids). */
export const RECONCILED_VENDORS: readonly { id: string; label: string }[] = [
  { id: "retell", label: "Retell AI" },
  { id: "twilio", label: "Twilio" },
  { id: "elevenlabs", label: "ElevenLabs" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "vercel", label: "Vercel" },
  { id: "neon", label: "Neon" },
];

/** USD cents → AUD cents at the one FX rate this view uses (no card buffer: NAB's fee is in the ledger). */
export function usdToAudCents(usdCents: number, fx: typeof DEFAULT_FX = DEFAULT_FX): number {
  return Math.round((usdCents * 1_000_000) / fx.usdPerAudMillionths);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const figure = (basis: Basis, cents: number | null, source: string, asOf: string | null, complete: boolean, notes: string[]): Figure =>
  ({ basis, cents, source, asOf, complete, notes });
const margin = (f: Figure, revenueCents: number | null): MarginFigure => {
  const known = f.cents !== null && revenueCents !== null;
  const m = known ? revenueCents - f.cents! : null;
  return { ...f, revenueCents, marginBps: known && revenueCents! > 0 ? Math.round((m! * 10_000) / revenueCents!) : null };
};
const unknownMargin = (basis: Basis, source: string, asOf: string | null, note: string, revenueCents: number | null): MarginFigure =>
  margin(figure(basis, null, source, asOf, false, [note]), revenueCents);

/** SMS segments a client sent this period: the feed's usage block when present; a real zero when SMS is off. */
function smsUsage(c: FeedClient): { segments: number | null; source: string } {
  if (typeof c.usage?.smsSegments === "number") return { segments: c.usage.smsSegments, source: `${FEED_SOURCE} (clients[].usage.smsSegments: the feed's 30-day window, not the billing period)` };
  if (!c.readiness.smsEnabled) return { segments: 0, source: `${FEED_SOURCE}: SMS is switched off for this client` };
  return { segments: null, source: `${FEED_SOURCE}: SMS is on, but the deployed feed doesn't report segment counts yet` };
}

function clientEconomics(c: FeedClient, pkg: ReceptionistPackage | null, input: UsageEconomicsInput, feedAsOf: string, rates: readonly CostRate[], fx: typeof DEFAULT_FX, retellRows: RetellCostRow[] | null): ClientEconomics {
  if (!c.minutesThisMonth) return unknownUsageClient(c, pkg, feedAsOf, input);
  // Review R1: billing is on the current billing period's minutes, never the feed's 30-day window.
  const billable = c.usage?.periodBillableMinutes ?? c.minutesThisMonth.billableMinutesCurrentPeriod;
  const sms = smsUsage(c);
  const usage = { calls: c.minutesThisMonth.calls, billableMinutes: billable, smsSegments: sms.segments, smsSource: sms.source };
  const base = { organizationId: c.organizationId, slug: c.slug, isDemoTenant: c.isDemoTenant, packageId: pkg?.id ?? null, packageName: pkg?.shortName ?? null, monthStart: c.minutesThisMonth.monthStart, usage };

  // Revenue: what M&U would bill this period at catalogue prices. Demo tenants and unassigned clients: none.
  const revenueSource = `Catalogue ${CATALOGUE_VERSION} (ex GST) × ${FEED_SOURCE} billable minutes`;
  let revenueCents: number | null = null;
  const revenueNotes: string[] = [];
  if (isInternalClient(c)) revenueNotes.push("Demo tenant: never billed.");
  else if (c.usage?.periodBillingBlocked) revenueNotes.push(`Billing blocked (${c.usage.periodBillingBlocked.reason}): ${c.usage.periodBillingBlocked.message} No revenue, overage or margin is shown for this period; it is not zero.`);
  else if (!pkg) revenueNotes.push("No package assigned locally: nothing to bill against.");
  else {
    const overage = Math.max(0, billable - pkg.pricing.includedMinutes);
    revenueCents = pkg.pricing.monthly.cents + overage * pkg.pricing.overagePerMinute.cents;
    revenueNotes.push(overage ? `${pkg.shortName} monthly + ${overage} overage min at the catalogue rate.` : `${pkg.shortName} monthly; within the included minutes.`);
    revenueNotes.push("Billing-period minutes. SMS overage isn't included: the feed counts SMS over a 30-day window, not the billing period. Not an issued or paid invoice.");
  }
  const revenue = figure("estimated", revenueCents, revenueSource, feedAsOf, revenueCents !== null, revenueNotes);

  // ── estimated: actual usage × list rates ──
  let estimated: MarginFigure;
  if (!pkg) estimated = unknownMargin("estimated", `business-economics.ts list rates, checked ${ECONOMICS_AS_OF}`, feedAsOf, c.isDemoTenant ? "Demo tenant with no package: no rates to apply." : "No package assigned locally.", revenueCents);
  else {
    const calls = c.minutesThisMonth.calls;
    const avg = calls > 0 ? Math.round((c.minutesThisMonth.callMinutes * 60) / calls) : 0;
    const e = calculateEconomics({
      package: pkg, clients: 1, calls: calls > 0 ? [{ count: calls, seconds: avg }] : [],
      notificationsPerClient: 0, smsSegmentsPerClient: sms.segments ?? 0, phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
      rates, fx, gstRegistered: true,
      supportMinutesPerClient: 0, supportHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
      onboardingMinutes: 0, onboardingHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
      payment: DEFAULT_PAYMENT, targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
    });
    const notes = [`${calls} calls, ${c.minutesThisMonth.callMinutes} min this month (feed) × list rates; averaged per call.`];
    if (sms.segments === null) notes.push("SMS segments unknown: not in the estimate.");
    if (e.incomplete) notes.push("Some provider rates are unknown (database, alerts, concurrency, carrier SMS fees): cost is a floor.");
    notes.push("Support time and the shared platform are not allocated here.");
    // Demo tenants: M&U carries the cost; there is no revenue to set it against.
    estimated = margin(figure("estimated", e.variableCostCents, `business-economics.ts list rates, checked ${ECONOMICS_AS_OF}; usage from ${FEED_SOURCE}`, feedAsOf, !e.incomplete && sms.segments !== null, notes), revenueCents);
  }

  // ── measured: Retell per-call cost joined through the feed's call ids ──
  const feedCalls = c.minutesThisMonth.calls;
  const retellBlock = { matchedCalls: 0, feedCalls, usdCents: null as number | null, unknownCostCalls: 0 };
  let measured: ClientEconomics["measured"];
  const retellAsOf = input.retellReadAt;
  if (!retellRows) measured = { ...unknownMargin("measured", RETELL_SOURCE, retellAsOf, `Retell couldn't be read: ${input.retell.ok ? "" : input.retell.reason}`, revenueCents), retell: retellBlock };
  else if (!input.attribution) measured = { ...unknownMargin("measured", RETELL_SOURCE, retellAsOf, `Calls can't be matched to clients: ${input.attributionReason ?? "the agency feed's call list couldn't be read"}.`, revenueCents), retell: retellBlock };
  else {
    const since = c.minutesThisMonth.monthStart ? Date.parse(c.minutesThisMonth.monthStart) : NaN;
    const mine = retellRows.filter((r) => input.attribution!.byCallId.get(r.id) === c.organizationId && (!Number.isFinite(since) || (r.startedAt !== null && Date.parse(r.startedAt) >= since)));
    const known = mine.filter((r) => r.usdCents !== null);
    retellBlock.matchedCalls = mine.length;
    retellBlock.unknownCostCalls = mine.length - known.length;
    const notes: string[] = [];
    if (!Number.isFinite(since)) notes.push("The feed gave no month start for this client: every matched call is counted.");
    const windowStart = input.attribution.windowStart;
    if (windowStart === null) notes.push("The feed didn't say how far back its call list goes: earlier calls may be unmatched.");
    else if (Number.isFinite(since) && Date.parse(windowStart) > since) notes.push(`The feed's call list starts ${windowStart.slice(0, 10)}: earlier calls this month can't be matched.`);
    if (mine.length < feedCalls) notes.push(`${mine.length} of ${feedCalls} calls this month matched to a Retell cost (this OS reads one Retell agent).`);
    if (retellBlock.unknownCostCalls) notes.push(`${plural(retellBlock.unknownCostCalls, "matched call has", "matched calls have")} no cost from Retell yet.`);
    notes.push("Measured here: Retell only. Twilio carrier, number, SMS and payment fees aren't reported per client, so this cost is a floor and the margin a ceiling.");
    if (feedCalls === 0 && mine.length === 0) {
      measured = { ...margin(figure("measured", 0, RETELL_SOURCE, retellAsOf, false, ["No calls this month (feed): no Retell cost.", notes.at(-1)!]), revenueCents), retell: { ...retellBlock, usdCents: 0 } };
    } else if (!known.length) {
      measured = { ...unknownMargin("measured", RETELL_SOURCE, retellAsOf, feedCalls ? `None of this client's ${feedCalls} calls matched a Retell cost (its agent may not be the one this OS reads).` : "No matched call has a cost.", revenueCents), retell: retellBlock };
    } else {
      const usd = known.reduce((s, r) => s + r.usdCents!, 0);
      retellBlock.usdCents = usd;
      const coverage = feedCalls > 0 ? known.length / feedCalls : 0;
      const covered = coverage >= MEASURED_MARGIN_MIN_COVERAGE;
      if (!covered) notes.unshift(`Margin unknown: only ${known.length} of ${feedCalls} calls matched a cost (a measured margin needs every call).`);
      else notes.push("Revenue is the catalogue billing figure; the cost is measured.");
      const cost = figure("measured", usdToAudCents(usd, fx), `${RETELL_SOURCE}, joined by ${FEED_SOURCE} call ids; converted at RBA ${fx.date}`, retellAsOf, false, notes);
      measured = { ...(covered ? margin(cost, revenueCents) : { ...cost, revenueCents: null, marginBps: null }), retell: retellBlock };
    }
  }

  const reconciled = unknownMargin("reconciled", NAB_SOURCE, ledgerAsOf(input.ledger), "Bank lines aren't split by client: see the portfolio's reconciled costs.", revenueCents);
  return { ...base, revenue, estimated, measured, reconciled };
}

/** F2 RX-2: the feed didn't report this client's minutes. Usage is unknown, so every margin is too. */
function unknownUsageClient(c: FeedClient, pkg: ReceptionistPackage | null, feedAsOf: string, input: UsageEconomicsInput): ClientEconomics {
  const why = "Margin unknown: usage missing (the feed didn't report this client's minutes).";
  const revenue = figure("estimated", null, `Catalogue ${CATALOGUE_VERSION} (ex GST) × ${FEED_SOURCE} billable minutes`, feedAsOf, false,
    [isInternalClient(c) ? "Demo tenant: never billed." : pkg ? "Usage missing: overage can't be worked out, so billable revenue is unknown." : "No package assigned locally: nothing to bill against."]);
  return {
    organizationId: c.organizationId, slug: c.slug, isDemoTenant: c.isDemoTenant, packageId: pkg?.id ?? null, packageName: pkg?.shortName ?? null, monthStart: null,
    usage: { calls: null, billableMinutes: null, smsSegments: smsUsage(c).segments, smsSource: smsUsage(c).source },
    revenue,
    estimated: unknownMargin("estimated", `business-economics.ts list rates, checked ${ECONOMICS_AS_OF}`, feedAsOf, why, null),
    measured: { ...unknownMargin("measured", RETELL_SOURCE, input.retellReadAt, why, null), retell: { matchedCalls: 0, feedCalls: null, usdCents: null, unknownCostCalls: 0 } },
    reconciled: unknownMargin("reconciled", NAB_SOURCE, ledgerAsOf(input.ledger), "Bank lines aren't split by client: see the portfolio's reconciled costs.", null),
  };
}

function ledgerAsOf(l: LedgerMonth): string | null {
  return l.state === "ok" ? l.asOf : null;
}

/** Sum a basis over clients: a floor/ceiling unless every client's figure is known and complete. */
function sumMargin(basis: Basis, rows: ClientEconomics[], pick: (r: ClientEconomics) => MarginFigure, source: string, asOf: string | null, emptyNote: string): MarginFigure {
  const known = rows.filter((r) => pick(r).cents !== null);
  if (!rows.length || !known.length) return unknownMargin(basis, source, asOf, rows.length ? `No client on this tier has ${basis === "estimated" ? "an" : "a"} ${basis} cost yet.` : emptyNote, null);
  const cost = known.reduce((s, r) => s + pick(r).cents!, 0);
  // Each basis carries its own revenue: null when its margin is unknown (R2), so the tier margin is too.
  const revenue = known.every((r) => pick(r).revenueCents !== null) ? known.reduce((s, r) => s + pick(r).revenueCents!, 0) : null;
  const notes = known.length < rows.length ? [`${known.length} of ${rows.length} clients have a ${basis} cost; revenue is theirs only.`] : [];
  if (known.some((r) => !pick(r).complete)) notes.push(basis === "measured" ? "Retell only per client: cost is a floor, margin a ceiling." : "Some cost lines are unknown: cost is a floor, margin a ceiling.");
  return margin(figure(basis, cost, source, asOf, known.length === rows.length && known.every((r) => pick(r).complete), notes), revenue);
}

function tierEconomics(pkg: ReceptionistPackage, clients: ClientEconomics[], feedAsOf: string | null, ledger: LedgerMonth, retellAsOf: string | null): TierEconomics {
  const billed = clients.filter((c) => c.packageId === pkg.id && !isInternalClient(c));
  const revenueCents = billed.length && billed.every((c) => c.revenue.cents !== null) ? billed.reduce((s, c) => s + c.revenue.cents!, 0) : null;
  const revenue = figure("estimated", revenueCents, `Catalogue ${CATALOGUE_VERSION} × ${FEED_SOURCE} billable minutes`, feedAsOf, revenueCents !== null, billed.length ? ["Not issued or paid invoices."] : ["No billed client on this tier yet."]);
  let estimated: MarginFigure;
  if (billed.length) estimated = sumMargin("estimated", billed, (c) => c.estimated, `business-economics.ts list rates × actual usage (${billed.length} client${billed.length === 1 ? "" : "s"})`, feedAsOf, "");
  else {
    // No clients: the package model's base scenario, per client, on the same definition as a
    // client's estimate (variable service + payment cost; before support and the shared platform).
    const m = packageEconomicsMatrix([MODEL_CLIENTS]).find((p) => p.packageId === pkg.id);
    const scen = m?.scenarios.find((s) => s.scenarioId === "base") ?? m?.scenarios[0];
    const est = scen?.byClients[0]?.estimated;
    estimated = est
      ? margin(figure("estimated", Math.round(est.variableCostCents / MODEL_CLIENTS), `Package model (base usage), business-economics.ts, rates checked ${ECONOMICS_AS_OF}`, ECONOMICS_AS_OF, !est.incomplete,
          [`Model, not usage: no client on this tier yet. Per client at base usage (${Math.round(scen!.minutesPerClient)} min), before support and the shared platform.`]), Math.round(est.revenueExGstCents / MODEL_CLIENTS))
      : unknownMargin("estimated", "business-economics.ts", ECONOMICS_AS_OF, "No package model for this tier.", null);
  }
  const measured = sumMargin("measured", billed, (c) => c.measured, `${RETELL_SOURCE} (per client, summed)`, retellAsOf, "No billed client on this tier: nothing to measure.");
  const reconciled = unknownMargin("reconciled", NAB_SOURCE, ledgerAsOf(ledger), "Bank lines aren't split by tier: see the portfolio's reconciled costs.", revenueCents);
  return { packageId: pkg.id, name: pkg.shortName, clients: billed.length, revenue, estimated, measured, reconciled };
}

function portfolio(input: UsageEconomicsInput, clients: ClientEconomics[], fx: typeof DEFAULT_FX, feedAsOf: string | null): UsageEconomics["portfolio"] {
  const monthStart = sydneyMonthStartIso(input.now);
  // Retell: every call on the line's agent this month, attributed or not (demo line, web tests…).
  let retell: UsageEconomics["portfolio"]["measured"]["retell"];
  if (!input.retell.ok) retell = { ...figure("measured", null, RETELL_SOURCE, input.retellReadAt, false, [`Retell couldn't be read: ${input.retell.reason}`]), usdCents: null, label: "Retell (voice, AI, STT/TTS)", calls: 0, attributedUsdCents: null, unattributedUsdCents: null };
  else {
    const month = input.retell.rows.filter((r) => r.startedAt !== null && r.startedAt >= monthStart);
    const known = month.filter((r) => r.usdCents !== null);
    const usd = known.reduce((s, r) => s + r.usdCents!, 0);
    const attributed = input.attribution ? known.filter((r) => input.attribution!.byCallId.has(r.id)).reduce((s, r) => s + r.usdCents!, 0) : null;
    const notes = [`${plural(month.length, "call", "calls")} since ${monthStart.slice(0, 10)} on the agent this OS reads, converted at RBA ${fx.date}.`];
    if (month.length - known.length) notes.push(`${plural(month.length - known.length, "call has", "calls have")} no cost from Retell yet: a floor.`);
    if (attributed !== null) notes.push("Unattributed: calls the agency feed doesn't list (demo and web test calls, or before its window).");
    else notes.push(`Calls can't be matched to clients: ${input.attributionReason ?? "the agency feed's call list couldn't be read"}.`);
    retell = { ...figure("measured", usdToAudCents(usd, fx), RETELL_SOURCE, input.retellReadAt, month.length === known.length, notes), usdCents: usd, label: "Retell (voice, AI, STT/TTS)", calls: month.length, attributedUsdCents: attributed, unattributedUsdCents: attributed === null ? null : usd - attributed };
  }
  const twilio: PortfolioLine = input.twilioMonth.ok
    ? { ...figure("measured", usdToAudCents(Math.round(input.twilioMonth.usd * 100), fx), "Twilio usage records, this month (totalprice)", input.twilioReadAt, true, ["Account total: carrier minutes, numbers and SMS for every client and the demo line. Not split by client."]), usdCents: Math.round(input.twilioMonth.usd * 100), label: "Twilio (carrier, numbers, SMS)" }
    : { ...figure("measured", null, "Twilio usage records, this month", input.twilioReadAt, false, [`Twilio couldn't be read: ${input.twilioMonth.reason}`]), usdCents: null, label: "Twilio (carrier, numbers, SMS)" };
  const receiptLine = (label: string, part: { calls: number; costUsd: number; unknownCostCalls: number } | null, note: string) => {
    if (!input.receipts || !part) return { ...figure("measured", null, RECEIPTS_SOURCE, null, false, ["Receipts couldn't be read."]), usdCents: null, label, calls: 0 };
    const usdCents = Math.round(part.costUsd * 100);
    const notes = [note, `${plural(part.calls, "call", "calls")} since ${input.receipts.since.slice(0, 10)}.`];
    if (part.unknownCostCalls) notes.push(`${plural(part.unknownCostCalls, "call has", "calls have")} no known cost: a floor.`);
    return { ...figure("measured", usdToAudCents(usdCents, fx), RECEIPTS_SOURCE, input.receipts.asOf, part.unknownCostCalls === 0, notes), usdCents, label, calls: part.calls };
  };
  const smsKnown = clients.every((c) => c.usage.smsSegments !== null);
  const smsSegments = {
    count: clients.length && smsKnown ? clients.reduce((s, c) => s + (c.usage.smsSegments ?? 0), 0) : null,
    source: FEED_SOURCE, asOf: feedAsOf,
    note: smsKnown ? "Segments sent in the feed's 30-day window (not the billing period); SMS off counts as none." : "SMS is on for a client but the deployed feed doesn't report segment counts yet: unknown.",
  };

  // Reconciled: what the NAB ledger shows was paid this month to each provider.
  const reconciled: UsageEconomics["portfolio"]["reconciled"] = { lines: [], statement: null, coverage: null, notes: [], asOf: null };
  const l = input.ledger;
  if (l.state === "none-imported") reconciled.notes.push("No NAB CSV imported: nothing reconciled. Unknown, not zero.");
  else if (l.state === "unreadable") reconciled.notes.push(`The NAB CSV ledger couldn't be read: ${l.reason}`);
  else {
    reconciled.statement = l.statement; reconciled.coverage = l.coverage; reconciled.asOf = l.asOf;
    const src = `${NAB_SOURCE}, ${l.period.label.toLowerCase()} (${l.period.from ?? "?"} to ${l.period.to ?? "?"})`;
    if (l.coverage === "none") reconciled.notes.push(`No imported NAB data covers ${l.period.label.toLowerCase()}: unknown, not zero.`);
    else {
      if (l.coverageNote) reconciled.notes.push(l.coverageNote);
      reconciled.notes.push("Paid amounts in AUD, NAB international fees included. Bank charges follow provider billing dates, not call dates, so they don't line up with the measured column day for day.");
      for (const v of RECONCILED_VENDORS) {
        const hit = l.vendors.find((x) => x.vendorId === v.id);
        reconciled.lines.push({ ...figure("reconciled", hit ? hit.netCostCents : 0, src, l.asOf, l.coverage === "full", hit ? [] : [l.coverage === "full" ? "No charge in the covered period." : "No charge in the covered part of the period."]), usdCents: null, label: v.label });
      }
    }
  }
  return {
    measured: {
      retell,
      twilio,
      receptionistModels: receiptLine("Receptionist call summaries (router, task receptionist-summary)", input.receipts?.receptionist ?? null, "The receptionist's own model calls through the router (one-line call summaries)."),
      otherModels: receiptLine("Other router model spend (M&U operations, not per client)", input.receipts?.other ?? null, "Shared operating overhead: not allocated to any client or tier."),
      smsSegments,
    },
    reconciled,
  };
}

/** First instant of the current Sydney calendar month, as a UTC ISO string. */
export function sydneyMonthStartIso(now: number): string {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit" }).formatToParts(new Date(now));
  const y = Number(parts.find((p) => p.type === "year")!.value), m = Number(parts.find((p) => p.type === "month")!.value);
  // Sydney is UTC+10 or +11; find the UTC instant whose Sydney date is the 1st at 00:00.
  for (const offset of [11, 10]) {
    const guess = Date.UTC(y, m - 1, 1, -offset);
    const d = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(guess));
    if (d.find((p) => p.type === "day")!.value === "1" && Number(d.find((p) => p.type === "hour")!.value) === 0) return new Date(guess).toISOString();
  }
  return new Date(Date.UTC(y, m - 1, 1)).toISOString();
}

/** Per-client, per-tier and portfolio economics, every figure on one basis with source and as-of. */
export function buildUsageEconomics(input: UsageEconomicsInput): Source<UsageEconomics> {
  if (!input.feed.ok) return { ok: false, reason: input.feed.reason };
  const rates = input.rates ?? DEFAULT_COST_RATES;
  const fx = input.fx ?? DEFAULT_FX;
  const feedAsOf = input.feed.generatedAt;
  const retellRows = input.retell.ok ? input.retell.rows : null;
  const clients = input.feed.clients.map((c) => clientEconomics(c, input.packageFor(c), input, feedAsOf, rates, fx, retellRows));
  const tiers = RECEPTIONIST_PACKAGES.filter((p) => p.kind === "receptionist").map((p) => tierEconomics(p, clients, feedAsOf, input.ledger, input.retellReadAt));
  return {
    ok: true,
    generatedAt: new Date(input.now).toISOString(),
    fx: { usdPerAud: fx.usdPerAudMillionths / 1_000_000, date: fx.date, source: "RBA reference rate (business-economics.ts DEFAULT_FX)", note: "Measured USD converted without a card buffer: NAB's international fee shows in the reconciled column." },
    catalogue: CATALOGUE_VERSION,
    ratesCheckedAt: ECONOMICS_AS_OF,
    clients,
    tiers,
    portfolio: portfolio(input, clients, fx, feedAsOf),
  };
}

/** providerCallId → organizationId from a full-view feed. Ids only; nothing else is kept. */
export function callAttribution(feed: AgencyFeedState, now: number): UsageEconomicsInput["attribution"] {
  if (!feed.ok || feed.view !== "full") return null;
  const byCallId = new Map<string, string>();
  for (const c of feed.calls) if (c.providerCallId && c.organizationId) byCallId.set(c.providerCallId, c.organizationId);
  const generated = Date.parse(feed.generatedAt);
  const windowStart = feed.windowDays === null ? null : new Date((Number.isFinite(generated) ? generated : now) - feed.windowDays * 86_400_000).toISOString();
  return { byCallId, windowStart, asOf: feed.generatedAt };
}

/** The NAB CSV ledger's summary for this month → the reconciled lines' input. null = nothing imported. */
export function ledgerMonthFrom(s: ManualSummary | null): LedgerMonth {
  if (!s || !s.rowCount) return { state: "none-imported" };
  return {
    state: "ok",
    statement: s.sourceLabel,
    asOf: s.asOf,
    period: { ...s.period },
    coverage: s.periodCoverage,
    coverageNote: s.coverageNote,
    vendors: s.byVendor.map((v) => ({ vendorId: v.vendorId, label: v.label, netCostCents: v.netCostCents })),
  };
}

/**
 * Router receipts this month: the receptionist's own model calls (task "receptionist-summary", any
 * route: free and subscription calls are known zeros) and other METERED spend (shared overhead).
 * Refused-before-work rows are not calls. Unknown cost is counted, never added as zero.
 */
export function receiptsForEconomics(receipts: readonly RouterReceipt[], since: string, asOf: string): NonNullable<UsageEconomicsInput["receipts"]> {
  const empty = () => ({ calls: 0, costUsd: 0, unknownCostCalls: 0 });
  const receptionist = empty(), other = empty();
  for (const r of receipts) {
    if (NOT_A_CALL_OUTCOMES.has(r.outcome) || r.startedAt < since) continue;
    const bucket = r.task === RECEPTIONIST_TASK ? receptionist : r.route === "metered" ? other : null;
    if (!bucket) continue;
    bucket.calls++;
    if (r.costUsd === null) bucket.unknownCostCalls++;
    else bucket.costUsd += r.costUsd;
  }
  return { since, asOf, receptionist, other };
}
/** The router task the receptionist's call summaries run under (summaries.ts). */
export const RECEPTIONIST_TASK = "receptionist-summary";

export { getReceptionistPackage };
