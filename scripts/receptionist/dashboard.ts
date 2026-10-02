// The multi-client receptionist dashboard's view model (WAVE2-CONTRACT.md, master prompt v2 §9).
//
// ONE agreed source per entity, no duplicate counters, no contradictory statuses:
//   - Every client/booking/transfer/handoff/minutes fact comes from the agency feed's `clients[]`
//     (docs/AGENCY-FEED-CONTRACT.md v1 additions), read with `?view=metadata` so no caller content
//     (transcript, summary, contact name) ever reaches this process.
//   - Every package/margin/pricing fact comes ONLY from receptionist-packages.ts +
//     business-economics.ts (WAVE2-CONTRACT.md: "Package/margin numbers come ONLY from...").
//   - Retell/Twilio channel health comes from retell.ts/twilio.ts (live provider reads), the same
//     modules the single-tenant snapshot (aggregate.ts) already uses — not re-derived here.
// A source this module cannot see is `{ ok: false, reason }`, never a zero dressed up as data.
// Every block carries `asOf`/`source`/`stale` so the UI never shows a stale number as current.

import type { AgentFacts, NumberFacts } from "./retell";
import { catalogueLabels } from "../../src/lib/price-status";
import type { TwilioFacts } from "./twilio";
import { deriveChecklist, liveLineCapabilityMismatch, type ChecklistStepStatus } from "./checklist";
import type { AgencyFeedState, FeedClient, FeedOrganization, LineSource, Source } from "./types";
import { buildUsageEconomics, isInternalClient, type LedgerMonth, type RetellCostRow, type UsageEconomics, type UsageEconomicsInput } from "./usage-economics";
import {
  getReceptionistPackage,
  RECEPTIONIST_PACKAGES,
  type PackageId,
  type ReceptionistPackage,
} from "../../src/lib/receptionist-packages";
import {
  calculateEconomics,
  DEFAULT_COST_RATES,
  DEFAULT_FX,
  DEFAULT_LABOUR_HOURLY_CENTS,
  DEFAULT_PAYMENT,
  DEFAULT_TARGET_MARGIN_BPS,
  type CostRate,
} from "../../src/lib/business-economics";

/** A feed-sourced block is stale once the feed's own generatedAt is over a day old. */
export const FEED_STALE_MS = 24 * 60 * 60 * 1000;
/** A live provider read (Retell/Twilio) is stale once the read itself is over a quarter-hour old. */
export const PROVIDER_STALE_MS = 15 * 60 * 1000;

/**
 * `asOf` is when the block's DATA was read or generated (never an unrelated edit time). For a failed
 * block (`ok: false`) it is the time of the last SUCCESSFUL read, or null when there never was one
 * (audit RX-7): a failed read never reads as "updated just now".
 * `staleAfterMs` lets the UI re-evaluate staleness against its own clock, not just build time.
 */
export type BlockMeta = { asOf: string | null; source: string; stale: boolean; staleAfterMs: number };
export type DashBlock<T> = ({ ok: true } & T & BlockMeta) | ({ ok: false; reason: string } & BlockMeta);

function isoOrNull(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
/** Stale when there is no usable timestamp, or it is older than `staleMs` at `now`. */
/**
 * Setup fees are NOT approved (owner brief 1 Oct 2026): a proposed setup fee is never a total, quote or invoice
 * line. Unknown / not approved is null, never zero and never the proposed figure.
 */
export function approvedSetupCents(pkg: { pricing: { setup: { cents: number }; setupStatus?: string; status: string } }): number | null {
  return (pkg.pricing.setupStatus ?? pkg.pricing.status) === "approved" ? pkg.pricing.setup.cents : null;
}

export function isStaleAt(asOf: string | null, now: number, staleMs: number): boolean {
  if (asOf === null) return true;
  const t = Date.parse(asOf);
  return !Number.isFinite(t) || now - t > staleMs;
}
function ok<T extends object>(data: T, source: string, asOf: string | null, now: number, staleMs = FEED_STALE_MS): DashBlock<T> {
  return { ok: true, ...data, source, asOf, stale: isStaleAt(asOf, now, staleMs), staleAfterMs: staleMs };
}
function bad(reason: string, source: string, asOf: string | null = null, staleMs = FEED_STALE_MS): DashBlock<never> {
  return { ok: false, reason, source, asOf, stale: true, staleAfterMs: staleMs } as DashBlock<never>;
}

// ── Tile discipline (the UI renders these; kept pure here so they are unit-tested) ──────────────
/** What a tile's number is: a live value, a real zero, not reported, too old, or a failed read. */
export type TileState = "ok" | "zero" | "unknown" | "stale" | "failed";
/** "assign": the value is unknown because a client has no package; a retry can't fix it (RX-9). */
export type TileRecovery = { kind: "retry" | "system" | "assign"; label: string };
/**
 * Why a tile's value is unknown, when the caller knows (default: the source didn't report it).
 * "not-available": nothing exists to read yet (no reconciled invoice): a retry can't help, so no recovery.
 */
export type UnknownCause = "not-reported" | "unassigned-package" | "not-available";
export const ASSIGN_PACKAGE_LABEL = "Assign each client a package";

/** Is the block stale at the viewer's `now`? (Server-side `stale` OR the viewer's own clock.) */
export function blockIsStale(block: BlockMeta, now: number): boolean {
  return block.stale || isStaleAt(block.asOf, now, block.staleAfterMs);
}

/**
 * A tile's state from its block and the value it shows. Failed beats everything; a missing value
 * is "unknown" (never a zero); an old block is "stale" (never success); a read zero is "zero".
 */
export function tileState(block: { ok: boolean } & BlockMeta, value: unknown, now: number): TileState {
  if (!block.ok) return "failed";
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return "unknown";
  if (blockIsStale(block, now)) return "stale";
  return value === 0 ? "zero" : "ok";
}

const FEED_CONFIG_REASON = /token|not configured|URL invalid|HTTP 40[13]|version unsupported/i;
const PROVIDER_CONFIG_REASON = /not configured|key|HTTP 40[13]|unauthori[sz]ed|forbidden/i;
/** The next step for a tile that isn't ok/zero: retry the read, or fix configuration in System. */
export function tileRecovery(block: ({ ok: true } | { ok: false; reason: string }) & BlockMeta, state: TileState, cause: UnknownCause = "not-reported"): TileRecovery | null {
  if (state === "ok" || state === "zero") return null;
  const isFeed = /agency feed/i.test(block.source);
  if (state === "failed" && !block.ok) {
    if (isFeed) return FEED_CONFIG_REASON.test(block.reason)
      ? { kind: "system", label: "Check the agency feed token in System" }
      : { kind: "retry", label: "Feed unreachable, retry" };
    return PROVIDER_CONFIG_REASON.test(block.reason)
      ? { kind: "system", label: "Check the provider keys in System" }
      : { kind: "retry", label: "Read failed, retry" };
  }
  if (state === "stale") return { kind: "retry", label: isFeed ? "Feed is stale, refresh" : "Read is stale, refresh" };
  if (cause === "unassigned-package") return { kind: "assign", label: ASSIGN_PACKAGE_LABEL };
  if (cause === "not-available") return null;
  return { kind: "retry", label: "Not reported, retry" };
}

/** "3 d ago"-style age of an ISO time at `now`, or null when unknown/unparseable. */
export function ageText(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const age = Math.max(0, now - t);
  if (age < 60_000) return "just now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} min ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} h ago`;
  return `${Math.floor(age / 86_400_000)} d ago`;
}

/** Local package assignment, e.g. `{ "demo-dental": "receptionist-essential" }`. NOT sourced from
 *  the feed — the contract carries no package selection field — so this must be supplied by the
 *  caller (a CRM/config row) and every client without an entry is explicitly "unassigned". */
export type ClientPackageMap = Readonly<Record<string, PackageId>>;

export type DashboardInput = {
  now: number;
  /** When the Retell/Twilio reads completed (ms). Defaults to `now`. Never the agent's edit time. */
  providersReadAt?: number;
  /**
   * When each source was last read SUCCESSFULLY (ms; null = never). A failed block shows this, not
   * the failed read's time (audit RX-7). Absent: a failed source has no known good read.
   */
  lastGoodReadAt?: { feed?: number | null; retell?: number | null; twilio?: number | null };
  /** When the feed read behind `feed` completed (ms). Defaults to `now`. */
  feedReadAt?: number;
  /** Where the line's agent id/number came from (plugin.ts resolveLine). */
  lineSource?: LineSource;
  /** Read with `?view=metadata` — see agency-feed.ts's `view` option. */
  feed: AgencyFeedState;
  agent: Source<AgentFacts>;
  numberFacts: Source<NumberFacts>;
  twilio: Source<TwilioFacts>;
  /** Keyed by client slug, falling back to organizationId when a client has no slug. */
  clientPackages?: ClientPackageMap;
  /** Package assignments that used a legacy alias or an unknown id (plugin.ts clientPackageWarnings). */
  packageWarnings?: readonly PackageWarning[];
  rates?: readonly CostRate[];
  fx?: typeof DEFAULT_FX;
  gstRegistered?: boolean;
  /**
   * Actual usage and cost sources for the three-basis economics (usage-economics.ts). Each one the
   * caller didn't read stays unknown, with the reason; nothing is filled in.
   */
  usageSources?: {
    retellCalls?: Source<{ rows: RetellCostRow[] }>;
    attribution?: UsageEconomicsInput["attribution"];
    attributionReason?: string;
    receipts?: UsageEconomicsInput["receipts"];
    ledger?: LedgerMonth;
  };
};

export type ClientRow = {
  organizationId: string;
  slug: string | null;
  name: string | null;
  niche: string | null;
  isDemoTenant: boolean;
  packageId: PackageId | null;
  packageName: string | null;
  onboardingStatus: "unassigned" | "not-connected" | "sandbox-only" | "live";
  calendar: { connected: boolean; provider: string | null; reason: string | null };
  /**
   * null = the feed didn't report it, or (overage/remaining) the allowance is unknown: never 0 (RX-2/RX-3).
   * overageMinutes: billable minutes over the allowance.
   */
  minutes: { includedPerMonth: number | null; usedThisMonth: number | null; remaining: number | null; overageMinutes: number | null; billableCurrentPeriod: number | null };
  /**
   * null: the feed didn't report this client's block (F2 RX-2), never zeros. Inside a reported block,
   * a count whose status record the feed didn't send is null too (RX-2), never a 0.
   */
  bookings: { total: number; confirmed: number | null; cancelled: number | null; failed: number | null; madeOnCalls: number; sandbox: number; upcoming: number } | null;
  /** null when the handoffs block or its transfer record wasn't reported. */
  transfers: { attempted: number; confirmed: number; failed: number } | null;
  /** `alertsByReason`: every reason the feed sent, known or not (F11); null when not reported. */
  handoffs: { pendingAlerts: number | null; failedAlerts: number | null; callbackRequests: number | null; alertsByReason: Record<string, number> | null } | null;
  sms: { enabled: boolean };
  costs: { estimatedMonthlyCents: number | null; measuredMonthlyCents: number | null; reconciledMonthlyCents: number | null; reason: string | null };
  commercial: { setupFeeCents: number | null; mrrCents: number | null; marginCents: number | null; marginPct: number | null; caveat: string; /** Set when the receptionist app could not compute this period's charge: shown as blocked, never zero. */ billingBlocked?: { reason: string; message: string } | null };
};

export type ExceptionItem = {
  /** Stable across rebuilds: a real call id when it's a call-level incident, else a composite
   *  `client:<organizationId>:<kind>` — either way, rebuilding the model never duplicates a row. */
  id: string;
  severity: "critical" | "warn";
  title: string;
  detail: string;
  clientSlug: string | null;
};

/** "clients": summed from the feed's client rows; "not-attributed": calls but no client rows;
 *  "client-unreported": client rows exist but one of them didn't report this block (unknown). */
export type Attribution = "clients" | "not-attributed" | "client-unreported";
/** Shown on a tile whose total is unknown because a client's block wasn't reported (review should-fix). */
export const CLIENT_UNREPORTED_HINT = "Unknown: the feed didn't report this for one or more clients";
export { isInternalClient };
/** Shown on a tile whose count is unknown because no client row accounts for the feed's calls. */
export const NOT_ATTRIBUTED_HINT = "Not attributed: the feed reports calls but no client rows";

export type DashboardViewModel = {
  generatedAt: string;
  /**
   * The dashboard's own agency-feed read (metadata view): when it completed, whether it worked, and
   * the last successful read. The sell status reads the feed separately and says its own time (RX-1).
   */
  feedRead: { ok: boolean; reason: string | null; at: string | null; lastOkAt: string | null };
  clients: DashBlock<{ rows: ClientRow[] }>;
  agentReadiness: DashBlock<{
    agentMapped: boolean;
    published: boolean;
    version: number | null;
    llmVersion: number | null;
    /** null when the number read failed: unknown, never "not attached". */
    numberAttached: boolean | null;
    /** The agent's own last edit (Retell last_modification_timestamp), shown as an age note only. */
    agentLastEditedAt: string | null;
    /** e.g. "Agent last edited 3 d ago" / "Agent edit time unknown". Never drives staleness. */
    agentEditNote: string;
    lineSource: LineSource | null;
  }>;
  channelHealth: DashBlock<{
    retell: "ok" | "warn" | "bad" | "unknown";
    twilio: "ok" | "warn" | "bad" | "unknown";
    webhook: "ok" | "warn" | "bad" | "unknown";
    /** null when the feed is unreadable: unknown, never "off". */
    smsAnyClientEnabled: boolean | null;
    /** Why a channel is unknown (the provider's own reason, e.g. "Twilio not configured"); null when read. */
    reasons: { retell: string | null; twilio: string | null; webhook: string | null };
    /** Last SUCCESSFUL read per provider (ISO; null = never): a failed read shows this, not "just now". */
    lastOkAt: { retell: string | null; twilio: string | null };
  }>;
  callsOutcomes: DashBlock<{
    calls: number | null;
    completed: number | null;
    failed: number | null;
    byOutcome: { name: string; count: number }[];
    bySentiment: { name: string; count: number }[];
  }>;
  /**
   * Sums over clients[]. With no client rows while the feed has calls (or doesn't report them), the
   * sum of nothing is not a zero: every count is null and `attribution` is "not-attributed" (M7).
   */
  /** `partial`: some client didn't report a count, so a number shown is a lower bound ("at least"). */
  bookings: DashBlock<{ total: number | null; confirmed: number | null; cancelled: number | null; failed: number | null; upcoming: number | null; attribution: Attribution; partial: boolean }>;
  transfers: DashBlock<{ attempted: number | null; confirmed: number | null; failed: number | null; attribution: Attribution; partial: boolean }>;
  /** null counts: the feed didn't report triage — unknown, never zero. */
  callbacks: DashBlock<{ pending: number | null; done: number | null; oldestPendingAt: string | null }>;
  sms: DashBlock<{ anyEnabled: boolean; reason: string }>;
  /** `byReason`: every staff-alert reason any client reported, labelled or "Unrecognised alert: <code>" (F11). */
  handoffs: DashBlock<{ pending: number | null; failed: number | null; attribution: Attribution; partial: boolean; byReason: AlertReasonRow[]; byReasonPartial: boolean }>;
  /**
   * `usedIsLowerBound`: some client's minutes are unknown, so the total counts only the known clients
   * ("at least N"); nothing known is null (RX-3). `overageMinutesTotal` is null while any client's
   * overage is unknown (no package, or usage unreported): live's reviewed rule (F2 RX-3); the
   * over-allowance client still shows its own overage and raises a "minutes-overage" exception.
   */
  usage: DashBlock<{ includedTotal: number | null; usedTotal: number | null; overageMinutesTotal: number | null; attribution: Attribution; usedIsLowerBound: boolean; unassignedClients: number }>;
  economics: DashBlock<{
    estimatedMonthlyCents: number | null; measuredMonthlyCents: number | null; reconciledMonthlyCents: number | null; caveat: string;
    /** Each basis's own source, as-of date and scope: the three tiles never share one label. */
    estimated: BasisMeta;
    measured: BasisMeta;
    reconciled: BasisMeta;
    /** false: some lines are missing, so the figure is a floor (shown "≥"). */
    estimatedComplete: boolean;
    estimatedUnknownClients: number;
    measuredComplete: boolean;
    reconciledComplete: boolean;
    /** `clientsEstimated` of `clientsTotal` had a package and reported minutes (the estimate covers only them). */
    clientsEstimated: number;
    clientsTotal: number;
  }>;
  /** Per-client, per-tier and portfolio economics on three separate bases (usage-economics.ts). */
  usageEconomics: DashBlock<UsageEconomics>;
  commercial: DashBlock<{ mrrCents: number | null; setupFeesCents: number | null; unassignedClients: number }>;
  /**
   * Assumed from each assigned client's package scenario at its reported usage. `clientsCounted` of
   * `clientsTotal` are in the figure (fewer: it's "at least"); null when none can be (RX-3), never 0.
   */
  supportWorkload: DashBlock<{ assumedMinutesTotal: number | null; clientsCounted: number; clientsTotal: number; caveat: string }>;
  exceptions: ExceptionItem[];
  /** Whether `exceptions` could be computed at all: failed when the feed is down (never "0 open"). */
  exceptionSummary: DashBlock<{ count: number; critical: number }>;
  goLive: { steps: ChecklistStepStatus[]; liveLineMismatch: ReturnType<typeof liveLineCapabilityMismatch> };
};

function orgOf(organizations: readonly FeedOrganization[], id: string): FeedOrganization | null {
  return organizations.find((o) => o.id === id) ?? null;
}

function calendarState(c: FeedClient): ClientRow["calendar"] {
  return { connected: c.readiness.liveCalendar, provider: c.readiness.calendarInUse, reason: c.readiness.calendarReason };
}

function onboardingStatus(c: FeedClient, hasPackage: boolean): ClientRow["onboardingStatus"] {
  if (!hasPackage) return "unassigned";
  if (!c.readiness.agentMapped || !c.readiness.inboundNumberSet) return "not-connected";
  if (c.readiness.bookingOutcome === "confirmed" && c.readiness.liveCalendar) return "live";
  return "sandbox-only";
}

/** A count from a status record: null when the record wasn't sent (unknown), else the keys' sum or a real 0. */
const fromRecord = <K extends string>(r: Partial<Record<K, number>> | null, ...keys: K[]): number | null =>
  r === null ? null : keys.reduce((n, k) => n + (r[k] ?? 0), 0);

function buildClientRow(
  c: FeedClient,
  org: FeedOrganization | null,
  pkg: ReceptionistPackage | null,
  rates: readonly CostRate[],
  fx: typeof DEFAULT_FX,
  gstRegistered: boolean,
): ClientRow {
  const includedMinutes = pkg?.pricing.includedMinutes ?? null;
  // F2 RX-2 (block model): null = the feed didn't report this client's minutes; unknown, never zeros.
  const m = c.minutesThisMonth;
  const used = m?.callMinutes ?? null;
  // Overage is billed on billable minutes (the feed's current-period figure), not raw call minutes.
  // Either the allowance or the usage unknown: overage unknown, never 0 (RX-3).
  const billable = m?.billableMinutesCurrentPeriod ?? null;
  const overageMinutes = includedMinutes === null || billable === null ? null : Math.max(0, billable - includedMinutes);
  let costs: ClientRow["costs"] = { estimatedMonthlyCents: null, measuredMonthlyCents: null, reconciledMonthlyCents: null, reason: "No package assigned locally: nothing to estimate against." };
  let commercial: ClientRow["commercial"] = { setupFeeCents: null, mrrCents: null, marginCents: null, marginPct: null, caveat: "No package assigned locally." };
  if (pkg && isInternalClient(c)) {
    costs = { estimatedMonthlyCents: null, measuredMonthlyCents: null, reconciledMonthlyCents: null, reason: "Demo or M&U's own line: never billed, so no client margin. Its provider cost is in the portfolio figures." };
    commercial = { setupFeeCents: null, mrrCents: null, marginCents: null, marginPct: null, caveat: "Demo tenant: never billed." };
  } else if (pkg && !m) {
    // RX-2: the fees are known; cost and margin would be computed from made-up zeros, so they stay unknown.
    costs = { estimatedMonthlyCents: null, measuredMonthlyCents: null, reconciledMonthlyCents: null, reason: "Usage unknown: the feed didn't report this client's minutes, so no cost or margin is estimated." };
    commercial = { setupFeeCents: approvedSetupCents(pkg), mrrCents: pkg.pricing.monthly.cents, marginCents: null, marginPct: null, caveat: "Margin unknown: usage missing." };
  } else if (pkg && m) {
    // A single averaged call bucket from this month's aggregate minutes — the feed carries no
    // per-call duration list for a client, only the monthly total (docs/AGENCY-FEED-CONTRACT.md).
    const avgSeconds = m.calls > 0 ? Math.round((m.callMinutes * 60) / m.calls) : 0;
    const calls = m.calls > 0 ? [{ count: m.calls, seconds: avgSeconds }] : [];
    // SMS: the feed's count when it reports one; a real zero when SMS is off; otherwise unknown.
    const smsSegmentsKnown = typeof c.usage?.smsSegments === "number" ? c.usage.smsSegments : c.readiness.smsEnabled ? null : 0;
    const estimate = calculateEconomics({
      package: pkg, clients: 1, calls,
      notificationsPerClient: 0, smsSegmentsPerClient: smsSegmentsKnown ?? 0, phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
      rates, fx, gstRegistered,
      supportMinutesPerClient: 0, supportHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
      onboardingMinutes: 0, onboardingHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
      payment: DEFAULT_PAYMENT, targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
    });
    costs = {
      estimatedMonthlyCents: estimate.variableCostCents,
      measuredMonthlyCents: null,
      reconciledMonthlyCents: null,
      reason: [
        estimate.incomplete ? "Estimate only: one or more provider rates are unknown (see business-economics.ts warnings)." : "Estimate only: list rates × this month's usage.",
        smsSegmentsKnown === null ? "SMS is on but its segment count isn't in the feed: SMS cost is not in this estimate." : null,
        "Measured and reconciled figures: see Economics by basis.",
      ].filter(Boolean).join(" "),
    };
    commercial = {
      setupFeeCents: approvedSetupCents(pkg),
      mrrCents: pkg.pricing.monthly.cents,
      marginCents: estimate.contributionCents,
      marginPct: estimate.contributionMarginBps === null ? null : estimate.contributionMarginBps / 100,
      caveat: "Estimated contribution margin (list rates × this month's aggregate minutes), before support and the shared platform. Not measured or reconciled.",
    };
  }
  const blocked = pkg && !isInternalClient(c) ? (c.usage?.periodBillingBlocked ?? null) : null;
  if (blocked) {
    // Billing blocked: no charge can be computed, so no margin either. Never a zero.
    commercial = { ...commercial, marginCents: null, marginPct: null, billingBlocked: blocked, caveat: `Billing blocked (${blocked.reason}): ${blocked.message} No margin is shown for this period.` };
  }
  const b = c.bookings, h = c.handoffs;
  return {
    organizationId: c.organizationId,
    slug: c.slug,
    name: org?.name ?? null,
    niche: org?.niche ?? null,
    isDemoTenant: c.isDemoTenant,
    packageId: pkg?.id ?? null,
    packageName: pkg?.shortName ?? null,
    onboardingStatus: onboardingStatus(c, !!pkg),
    calendar: calendarState(c),
    minutes: {
      includedPerMonth: includedMinutes,
      usedThisMonth: used,
      remaining: includedMinutes === null || used === null ? null : Math.max(0, includedMinutes - used),
      overageMinutes,
      billableCurrentPeriod: billable,
    },
    // F2 RX-2: an unreported block is unknown as a whole; inside a reported block, a status record the
    // feed didn't send leaves its counts unknown (fromRecord), never 0.
    bookings: !b ? null : {
      total: b.total,
      confirmed: fromRecord(b.byStatus, "CONFIRMED"),
      cancelled: fromRecord(b.byStatus, "CANCELLED"),
      failed: fromRecord(b.byStatus, "FAILED"),
      madeOnCalls: b.madeOnCalls,
      sandbox: b.sandbox,
      upcoming: b.upcoming,
    },
    transfers: !h || !h.transfersByStatus ? null : {
      attempted: fromRecord(h.transfersByStatus, "RESERVED", "SUBMITTED", "CONNECTED", "FAILED")!,
      confirmed: fromRecord(h.transfersByStatus, "CONNECTED")!,
      failed: fromRecord(h.transfersByStatus, "FAILED")!,
    },
    handoffs: !h ? null : {
      pendingAlerts: fromRecord(h.alertsByStatus, "PENDING"),
      failedAlerts: fromRecord(h.alertsByStatus, "FAILED"),
      callbackRequests: fromRecord(h.alertsByReason, "CALLBACK_REQUEST"),
      // F11: every reason the feed sent, kept for the by-reason list.
      alertsByReason: h.alertsByReason,
    },
    sms: { enabled: c.readiness.smsEnabled },
    costs,
    commercial,
  };
}

/** Staff-alert reasons MU-Receptionist sends (AGENCY-FEED-CONTRACT; NOT_LIVE_CALL and GO_LIVE_DRIFT from R3). */
export const ALERT_REASON_LABELS: Record<string, string> = {
  CALLBACK_REQUEST: "Callback requests",
  TRANSFER_UNAVAILABLE: "Transfer unavailable",
  AFTER_HOURS_CALLBACK: "After-hours callbacks",
  URGENT_MESSAGE: "Urgent messages",
  NEW_BOOKING: "New bookings",
  NOT_LIVE_CALL: "Real call on a line that isn't marked live",
  GO_LIVE_DRIFT: "Go-live setup changed since it was tested",
};
export type AlertReasonRow = { reason: string; label: string; known: boolean; count: number };
/** A reason's label; an unknown one is shown by its code, never hidden (F11). */
export function alertReasonLabel(reason: string): { label: string; known: boolean } {
  const known = ALERT_REASON_LABELS[reason];
  return known ? { label: known, known: true } : { label: `Unrecognised alert: ${reason}`, known: false };
}
/**
 * Alert counts by reason over every client: every reason any client reported, largest first. A
 * client that sent no reason record makes the counts a lower bound (`partial`), never zeros.
 */
export function alertReasonRows(records: readonly (Record<string, number> | null)[]): { rows: AlertReasonRow[]; partial: boolean } {
  const totals = new Map<string, number>();
  for (const r of records) for (const [k, n] of Object.entries(r ?? {})) totals.set(k, (totals.get(k) ?? 0) + n);
  const rows = [...totals].map(([reason, count]) => ({ reason, count, ...alertReasonLabel(reason) })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { rows, partial: records.some((r) => r === null) };
}

/**
 * A total over client rows where some values may be unknown: every value known = the sum; nothing
 * known, or only zeros beside unknowns = null (unknown); otherwise the known sum as a lower bound.
 */
export function sumKnown(values: readonly (number | null)[]): { total: number | null; lowerBound: boolean } {
  const known = values.filter((v): v is number => v !== null);
  const sum = known.reduce((a, b) => a + b, 0);
  if (known.length === values.length) return { total: sum, lowerBound: false };
  return sum > 0 ? { total: sum, lowerBound: true } : { total: null, lowerBound: false };
}

function clientExceptions(row: ClientRow, c: FeedClient): ExceptionItem[] {
  const label = row.name ?? row.slug ?? row.organizationId;
  const items: ExceptionItem[] = [];
  const push = (kind: string, severity: ExceptionItem["severity"], title: string, detail: string) =>
    items.push({ id: `client:${row.organizationId}:${kind}`, severity, title, detail, clientSlug: row.slug });
  if (row.packageId && !c.readiness.agentMapped) push("agent-not-mapped", "critical", `${label}: no Retell agent mapped`, "This client has an assigned package but no Retell agent id mapped to it — it cannot be answering calls.");
  if (row.packageId && !c.readiness.inboundNumberSet) push("number-not-set", "critical", `${label}: inbound number not set`, "The inbound webhook cannot route this client's calls to the right tenant yet.");
  if (row.packageId && !row.calendar.connected && !row.isDemoTenant) push("calendar-not-live", "warn", `${label}: no live calendar connected`, `calendarInUse=${row.calendar.provider ?? "—"}, reason=${row.calendar.reason ?? "unknown"}. Bookings fall to the sandbox diary until a calendar is connected.`);
  // An unknown count raises nothing and is never read as 0.
  const gt0 = (n: number | null | undefined): n is number => typeof n === "number" && n > 0;
  if (row.transfers && row.transfers.attempted > row.transfers.confirmed) push("transfer-not-confirmed", "warn", `${label}: transfer attempted but not confirmed`, `${row.transfers.attempted} attempted vs ${row.transfers.confirmed} confirmed this window — a caller may have been told they'd be connected when they weren't.`);
  if (gt0(row.handoffs?.failedAlerts)) push("handoff-alert-failed", "critical", `${label}: ${row.handoffs!.failedAlerts} handoff alert(s) failed`, "A staff alert (new booking or urgent message) failed to send — check the alert email channel.");
  if (gt0(row.bookings?.failed)) push("booking-failed", "warn", `${label}: ${row.bookings!.failed} booking attempt(s) failed`, "A caller's booking attempt did not complete — check the calendar adapter for this client.");
  if (gt0(row.minutes.overageMinutes)) push("minutes-overage", "warn", `${label}: ${row.minutes.overageMinutes} minute(s) over the included allowance`, `${row.minutes.billableCurrentPeriod} billable of ${row.minutes.includedPerMonth} included minutes this period.`);
  return items;
}

function resolvePackage(c: FeedClient, map: ClientPackageMap): ReceptionistPackage | null {
  const id = map[c.slug ?? ""] ?? map[c.organizationId];
  if (!id) return null;
  try { return getReceptionistPackage(id); } catch { return null; }
}

/** Deterministic, pure, unit-testable. No I/O — callers supply already-fetched sources. */
export function buildDashboard(input: DashboardInput): DashboardViewModel {
  const generatedAt = new Date(input.now).toISOString();
  const rates = input.rates ?? DEFAULT_COST_RATES;
  const fx = input.fx ?? DEFAULT_FX;
  const gstRegistered = input.gstRegistered ?? true;
  const clientPackages = input.clientPackages ?? {};
  const feed = input.feed;
  const feedSource = "MU-Receptionist agency feed (/api/agency/feed?view=metadata)";
  const feedReadAt = isoOrNull(input.feedReadAt ?? input.now);
  // The last successful feed read: this one when it worked, else what the reader remembers.
  const feedLastOk = feed.ok ? feedReadAt : isoOrNull(input.lastGoodReadAt?.feed ?? null);
  const feedRead: DashboardViewModel["feedRead"] = { ok: feed.ok, reason: feed.ok ? null : feed.reason, at: feedReadAt, lastOkAt: feedLastOk };

  if (!feed.ok) {
    // A failed block's asOf is the last GOOD read (null = never), never this failed read (RX-7).
    const emptyBad = bad(feed.reason, feedSource, feedLastOk);
    return {
      generatedAt,
      feedRead,
      clients: emptyBad, agentReadiness: agentReadinessBlock(input), channelHealth: channelHealthBlock(input, null),
      callsOutcomes: emptyBad, bookings: emptyBad, transfers: emptyBad, callbacks: emptyBad, sms: emptyBad, handoffs: emptyBad,
      usage: emptyBad, economics: emptyBad, usageEconomics: emptyBad, commercial: emptyBad, supportWorkload: emptyBad,
      exceptions: [], exceptionSummary: emptyBad, goLive: { steps: deriveChecklist([], null), liveLineMismatch: liveLineCapabilityMismatch([]) },
    };
  }

  const rows = feed.clients.map((c) => buildClientRow(c, orgOf(feed.organizations, c.organizationId), resolvePackage(c, clientPackages), rates, fx, gstRegistered));
  const exceptions = rows.flatMap((row, i) => clientExceptions(row, feed.clients[i]));
  const asOf = feed.generatedAt;

  const totals = feed.totals;
  // The feed's own open critical QA counter. The metadata view carries no per-call QA, so this is
  // never attributed to a client here; the sell status (/__receptionist) lists the calls one by
  // one and sell-exceptions.ts drops this aggregate row when it has them (one entry per call).
  if (typeof totals.qaCriticalOpen === "number" && totals.qaCriticalOpen > 0)
    exceptions.push({
      id: "feed:qa-critical-open",
      severity: "critical",
      title: `${totals.qaCriticalOpen} critical QA flag${totals.qaCriticalOpen === 1 ? "" : "s"} open in production (not attributed to a client)`,
      detail: "MU-Receptionist's QA engine flagged a call at the FLAG band and it hasn't been reviewed. Review it in MU-Receptionist; the Receptionist sell status lists the call and its codes.",
      clientSlug: null,
    });
  // M7: no client rows but calls on record (or an unreported call count): a sum over clients[]
  // would be a fabricated 0, so the per-client totals are unknown ("not attributed").
  const attribution: Attribution = rows.length === 0 && totals.calls !== 0 ? "not-attributed" : "clients";
  const unattributed = attribution === "not-attributed";
  // A total with a client row that didn't report its block is "client-unreported" (review should-fix),
  // never "not attributed" (that's reserved for calls with no client rows at all).
  const blockAttribution = (missing: (r: ClientRow) => boolean): Attribution => (unattributed ? attribution : rows.some(missing) ? "client-unreported" : "clients");
  // F2 RX-2/RX-3: a client that didn't report a count makes the total a lower bound ("at least N",
  // `partial`), or unknown (null) when nothing is known. Never a sum that treats the unknown as 0.
  const totalOf = (pick: (r: ClientRow) => number | null | undefined) => sumKnown(rows.map((r) => pick(r) ?? null));
  const bk = { total: totalOf((r) => r.bookings?.total), confirmed: totalOf((r) => r.bookings?.confirmed), cancelled: totalOf((r) => r.bookings?.cancelled), failed: totalOf((r) => r.bookings?.failed), upcoming: totalOf((r) => r.bookings?.upcoming) };
  const tr = { attempted: totalOf((r) => r.transfers?.attempted), confirmed: totalOf((r) => r.transfers?.confirmed), failed: totalOf((r) => r.transfers?.failed) };
  const ho = { pending: totalOf((r) => r.handoffs?.pendingAlerts), failed: totalOf((r) => r.handoffs?.failedAlerts) };
  // F11: every alert reason any client reported; a client without a reason record makes it "at least".
  const reasons = alertReasonRows(rows.map((r) => r.handoffs?.alertsByReason ?? null));
  const partial = (o: Record<string, { lowerBound: boolean }>) => Object.values(o).some((v) => v.lowerBound);
  const values = <K extends string>(o: Record<K, { total: number | null }>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (v as { total: number | null }).total])) as Record<K, number | null>;
  const anySms = rows.some((r) => r.sms.enabled);
  const usageIncludedKnown = rows.every((r) => r.minutes.includedPerMonth !== null);
  const used = totalOf((r) => r.minutes.usedThisMonth);
  const includedTotal = usageIncludedKnown ? rows.reduce((s, r) => s + (r.minutes.includedPerMonth ?? 0), 0) : null;
  // An unassigned client has no allowance (and an unreported one no usage), so the total overage is
  // unknown, not a smaller number and never a 0 standing in for them (F2 RX-3).
  const overageTotal = rows.every((r) => r.minutes.overageMinutes !== null) ? rows.reduce((s, r) => s + (r.minutes.overageMinutes ?? 0), 0) : null;
  const withCost = rows.filter((r) => r.costs.estimatedMonthlyCents !== null);
  const estimatedTotal = withCost.length ? withCost.reduce((s, r) => s + (r.costs.estimatedMonthlyCents ?? 0), 0) : null;
  // R4: a billed client with a package but unknown usage isn't in the total: the total is a floor.
  const estimatedUnknown = rows.filter((r) => r.packageId && !isInternalClient(r) && r.costs.estimatedMonthlyCents === null).length;
  const estimatedUnassigned = rows.filter((r) => !r.packageId).length;
  const usageEconomics = buildUsageEconomics({
    now: input.now,
    feed,
    packageFor: (c) => resolvePackage(c, clientPackages),
    retell: input.usageSources?.retellCalls ?? { ok: false, reason: "Retell calls not read for this view" },
    retellReadAt: providerReadAt(input),
    attribution: input.usageSources?.attribution ?? null,
    attributionReason: input.usageSources?.attributionReason,
    twilioMonth: input.twilio.ok ? (input.twilio.month.ok ? { ok: true, usd: input.twilio.month.usd } : { ok: false, reason: input.twilio.month.reason }) : { ok: false, reason: input.twilio.reason },
    twilioReadAt: providerReadAt(input),
    receipts: input.usageSources?.receipts ?? null,
    ledger: input.usageSources?.ledger ?? { state: "unreadable", reason: "The NAB CSV ledger wasn't read for this view" },
    rates, fx,
  });
  const econTiles = economicsTiles(usageEconomics, { estimated: withCost.length, unknownUsage: estimatedUnknown, unassigned: estimatedUnassigned, total: rows.length }, fx, asOf);
  const withPackage = rows.filter((r) => r.packageId);
  const unassignedClients = rows.length - withPackage.length;
  // R3: billed clients only; a demo tenant or M&U's own line is never MRR or a setup fee.
  const billed = withPackage.filter((r) => !isInternalClient(r));
  const mrrTotal = billed.length ? billed.reduce((s, r) => s + (r.commercial.mrrCents ?? 0), 0) : null;
  const setupKnown = billed.filter((r) => r.commercial.setupFeeCents !== null);
  const setupTotal = setupKnown.length ? setupKnown.reduce((s, r) => s + (r.commercial.setupFeeCents ?? 0), 0) : null;
  // F2 RX-3: support is assumed from each ASSIGNED client's package scenario at its reported usage.
  // A client without a package or usage isn't in the figure (it's then "at least"); with no client
  // countable there is nothing to assume from: null, never 0.
  const supportCounted = withPackage.filter((r) => r.minutes.usedThisMonth !== null);
  const supportMinutes = supportCounted.length
    ? supportCounted.reduce((s, r) => {
        const pkg = getReceptionistPackage(r.packageId!);
        const usedMinutes = r.minutes.usedThisMonth!;
        const scenario = pkg.model.scenarios.find((sc) => usedMinutes <= sc.calls.reduce((n, c) => n + (c.count * c.seconds) / 60, 0)) ?? pkg.model.scenarios.at(-1)!;
        return s + scenario.supportMinutes;
      }, 0)
    : null;
  const supportGap = withPackage.length < rows.length ? "a client has no package assigned, so its support scenario can't be assumed." : "a client's usage wasn't reported by the feed.";
  const supportCaveat = rows.length === 0
    ? "No clients yet."
    : supportCounted.length === rows.length
      ? "Assumption from the package usage model's nearest scenario (low/base/high), not measured support tickets."
      : `${supportMinutes === null ? "Unknown" : "Partial"}: ${supportGap}`;

  const now = input.now;
  const nameForSlug = (slug: string) => {
    const client = feed.clients.find((c) => c.slug === slug || c.organizationId === slug);
    return client ? (orgOf(feed.organizations, client.organizationId)?.name ?? null) : null;
  };
  for (const w of input.packageWarnings ?? []) exceptions.push(packageWarningException(w, nameForSlug(w.slug)));
  const deduped = dedupeExceptions(exceptions);
  // A counter the feed didn't report is null (unknown), never a fabricated 0.
  const count = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : null);
  return {
    generatedAt,
    feedRead,
    clients: ok({ rows }, feedSource, asOf, now),
    agentReadiness: agentReadinessBlock(input),
    channelHealth: channelHealthBlock(input, rows),
    callsOutcomes: ok({ calls: totals.calls, completed: totals.completed, failed: totals.failed, byOutcome: totals.byOutcome, bySentiment: totals.bySentiment }, feedSource, asOf, now),
    bookings: ok(unattributed ? { total: null, confirmed: null, cancelled: null, failed: null, upcoming: null, attribution, partial: false } : { ...values(bk), attribution: blockAttribution((r) => r.bookings === null), partial: partial(bk) }, feedSource, asOf, now),
    transfers: ok(unattributed ? { attempted: null, confirmed: null, failed: null, attribution, partial: false } : { ...values(tr), attribution: blockAttribution((r) => r.transfers === null), partial: partial(tr) }, feedSource, asOf, now),
    callbacks: ok({ pending: count(totals.triagePending), done: count(totals.triageDone), oldestPendingAt: totals.oldestPendingTriageAt }, feedSource, asOf, now),
    sms: ok({ anyEnabled: anySms, reason: "Feed exposes readiness.smsEnabled per client only; delivery/consent/STOP counts are not yet part of the agency feed contract." }, feedSource, asOf, now),
    handoffs: ok(unattributed ? { pending: null, failed: null, attribution, partial: false, byReason: [], byReasonPartial: false } : { ...values(ho), attribution: blockAttribution((r) => r.handoffs === null), partial: partial(ho), byReason: reasons.rows, byReasonPartial: reasons.partial }, feedSource, asOf, now),
    usage: ok(
      unattributed
        ? { includedTotal: null, usedTotal: null, overageMinutesTotal: null, attribution, usedIsLowerBound: false, unassignedClients }
        : { includedTotal, usedTotal: used.total, overageMinutesTotal: overageTotal, attribution: blockAttribution((r) => r.minutes.usedThisMonth === null), usedIsLowerBound: used.lowerBound, unassignedClients },
      feedSource, asOf, now,
    ),
    economics: ok({ estimatedMonthlyCents: estimatedTotal, measuredMonthlyCents: econTiles.measured.cents, reconciledMonthlyCents: econTiles.reconciled.cents, caveat: "Three bases, never mixed: estimated (list rates × usage, assigned clients), measured (provider-reported), reconciled (paid, NAB CSV). Unknowns are explicit, never zero.", estimated: econTiles.estimated, estimatedComplete: estimatedUnknown === 0, estimatedUnknownClients: estimatedUnknown, measured: econTiles.measured.meta, reconciled: econTiles.reconciled.meta, measuredComplete: econTiles.measured.complete, reconciledComplete: econTiles.reconciled.complete, clientsEstimated: withCost.length, clientsTotal: rows.length }, "receptionist-packages.ts + business-economics.ts; Retell and Twilio usage; NAB CSV", asOf, now),
    usageEconomics: usageEconomics.ok ? ok(usageEconomics, "usage-economics.ts: feed × catalogue × Retell × Twilio × receipts × NAB CSV", usageEconomics.generatedAt, now, PROVIDER_STALE_MS) : bad(usageEconomics.reason, feedSource),
    commercial: ok({ mrrCents: mrrTotal, setupFeesCents: setupTotal, unassignedClients }, `receptionist-packages.ts (${catalogueLabels().source}) x locally-assigned clients`, asOf, now),
    supportWorkload: ok({ assumedMinutesTotal: supportMinutes, clientsCounted: supportCounted.length, clientsTotal: rows.length, caveat: supportCaveat }, "receptionist-packages.ts usage scenarios", asOf, now),
    exceptions: deduped,
    exceptionSummary: ok({ count: deduped.length, critical: deduped.filter((e) => e.severity === "critical").length }, feedSource, asOf, now),
    goLive: { steps: deriveChecklist(feed.clients, feed.deployment), liveLineMismatch: liveLineCapabilityMismatch(feed.clients) },
  };
}

export type BasisMeta = { source: string; asOf: string | null; note: string };

/**
 * The three provider-cost tiles: estimated (assigned clients, list rates × usage), measured (Retell +
 * Twilio this month, as the providers report it; account-wide) and reconciled (NAB-paid Retell +
 * Twilio this month). Different scopes, so each carries its own source, as-of and note.
 */
function economicsTiles(u: Source<UsageEconomics>, n: { estimated: number; unknownUsage: number; unassigned: number; total: number }, fx: typeof DEFAULT_FX, feedAsOf: string | null) {
  const parts = [
    `${n.estimated} of ${n.total} clients estimated`,
    n.unknownUsage ? `${n.unknownUsage} with a package but usage not reported (not in the total: a floor)` : null,
    n.unassigned ? `${n.unassigned} with no package` : null,
  ].filter(Boolean);
  const estimated: BasisMeta = {
    source: "business-economics.ts list rates × agency feed usage",
    asOf: feedAsOf,
    note: `${parts.join("; ")}. Variable service and payment cost; demo and M&U lines excluded.`,
  };
  if (!u.ok) {
    const unknown = { cents: null as number | null, complete: false, meta: { source: "—", asOf: null, note: u.reason } as BasisMeta };
    return { estimated, measured: unknown, reconciled: unknown };
  }
  const m = u.portfolio.measured;
  // F2 RX-12: Retell measured but Twilio unreadable is still a measured floor (Retell only), so this
  // tile agrees with the cost gate's measured Retell rate instead of saying "Unknown".
  const measuredCents = m.retell.cents === null ? null : m.retell.cents + (m.twilio.cents ?? 0);
  const measuredComplete = m.retell.cents !== null && m.twilio.cents !== null && m.retell.complete;
  const measured = {
    cents: measuredCents,
    complete: measuredComplete,
    meta: {
      source: `${m.retell.source}; ${m.twilio.source}`,
      asOf: m.retell.asOf ?? m.twilio.asOf,
      note: measuredCents === null
        ? [m.retell.notes[0], m.twilio.cents === null ? m.twilio.notes[0] : null].filter(Boolean).join(" ")
        : m.twilio.cents === null
          ? `Retell only this month, converted at RBA ${fx.date}: a floor. ${m.twilio.notes[0]}`
          : `Retell + Twilio this month, account-wide (every client and the demo line), converted at RBA ${fx.date}.${m.retell.complete ? "" : " Some calls have no cost yet: a floor."}`,
    } as BasisMeta,
  };
  const r = u.portfolio.reconciled;
  const lines = r.lines.filter((l) => l.label === "Retell AI" || l.label === "Twilio");
  const reconciledCents = lines.length === 2 && lines.every((l) => l.cents !== null) ? lines.reduce((s, l) => s + l.cents!, 0) : null;
  const reconciled = {
    cents: reconciledCents,
    complete: r.coverage === "full",
    meta: {
      source: "NAB CSV import (finance-manual.sqlite)",
      asOf: r.asOf,
      note: reconciledCents === null ? r.notes[0] ?? "Not reconciled." : `Paid to Retell and Twilio this month (NAB CSV, AUD, fees in).${r.coverage === "partial" ? " Partly covered: may be incomplete." : ""}`,
    } as BasisMeta,
  };
  return { estimated, measured, reconciled };
}

/** A client package id that is a legacy alias (silently resolved) or not in the catalogue (dropped). */
export type PackageWarning = { slug: string; id: string; kind: "legacy-alias" | "unknown"; resolvedTo?: string };
/** `name`: the client's display name when the feed knows it (never the bare slug when a name exists, RX-11). */
export function packageWarningException(w: PackageWarning, name?: string | null): ExceptionItem {
  const label = name?.trim() || w.slug;
  return w.kind === "legacy-alias"
    ? { id: `package:${w.slug}`, severity: "warn", title: `${label}: legacy package id "${w.id}" used`, detail: `Resolved to ${w.resolvedTo ?? "the entry tier"} for the estimate. Set the client's real package (Essential, Professional or Premium) in client-packages.json.`, clientSlug: w.slug }
    : { id: `package:${w.slug}`, severity: "warn", title: `${label}: unknown package id "${w.id}"`, detail: "Not in the catalogue, so the client is treated as unassigned. Set Essential, Professional or Premium in client-packages.json.", clientSlug: w.slug };
}

function dedupeExceptions(items: ExceptionItem[]): ExceptionItem[] {
  const seen = new Map<string, ExceptionItem>();
  for (const item of items) seen.set(item.id, item); // last write wins; ids are stable per rebuild
  return [...seen.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}

/** When the provider reads completed: the plugin passes it; a pure caller defaults to `now`. */
function providerReadAt(input: DashboardInput): string | null {
  return isoOrNull(input.providersReadAt ?? input.now);
}

/** The last successful read of one provider: this read when it worked, else what the caller remembers. */
function providerLastOk(input: DashboardInput, read: { ok: boolean }, which: "retell" | "twilio"): string | null {
  return read.ok ? providerReadAt(input) : isoOrNull(input.lastGoodReadAt?.[which] ?? null);
}

function agentReadinessBlock(input: DashboardInput): DashboardViewModel["agentReadiness"] {
  const source = "Retell API (get-agent, get-retell-llm, list-phone-numbers)";
  const readAt = providerReadAt(input);
  // A failed read carries the last GOOD read time (null = never), not this read's (RX-7).
  if (!input.agent.ok) return bad(input.agent.reason, source, providerLastOk(input, input.agent, "retell"), PROVIDER_STALE_MS);
  // The agent's edit time is a fact about the agent, not about how fresh this read is: an agent
  // nobody edited for a week is not "stale" data. It is shown as an age note only.
  const modified = input.agent.modified;
  const edited = modified && Number.isFinite(Date.parse(modified)) ? modified : null;
  const age = ageText(edited, input.now);
  return ok({
    agentMapped: true,
    published: input.agent.published,
    version: input.agent.version ?? null,
    llmVersion: input.agent.llmVersion ?? null,
    numberAttached: input.numberFacts.ok ? input.numberFacts.attached : null,
    agentEditNote: age ? `Agent last edited ${age}` : "Agent edit time unknown",
    agentLastEditedAt: edited,
    lineSource: input.lineSource ?? null,
  }, source, readAt, input.now, PROVIDER_STALE_MS);
}

function channelHealthBlock(input: DashboardInput, rows: ClientRow[] | null): DashboardViewModel["channelHealth"] {
  const source = "Retell + Twilio provider reads";
  const retell = !input.agent.ok ? "unknown" : input.agent.published ? "ok" : "warn";
  const twilio = !input.twilio.ok ? "unknown" : input.twilio.connected ? "ok" : "bad";
  // Not probed is unknown, never ok: only an unsigned probe that was rejected proves protection.
  const probe = input.agent.ok ? input.agent.webhookProbe : undefined;
  const webhook = !input.agent.ok ? "unknown" : !input.agent.webhook ? "bad" : probe === "protected" ? "ok" : probe === undefined ? "unknown" : "bad";
  // With the feed unreadable, whether any client has SMS on is unknown (null), not "off".
  const smsAnyClientEnabled = rows === null ? null : rows.some((r) => r.sms.enabled);
  // The provider's own reason is passed through (e.g. "Twilio not configured"), never hidden (RX-7).
  const reasons = {
    retell: input.agent.ok ? null : input.agent.reason,
    twilio: input.twilio.ok ? null : input.twilio.reason,
    webhook: !input.agent.ok ? input.agent.reason : webhook === "unknown" ? "Webhook not probed yet" : null,
  };
  const lastOkAt = { retell: providerLastOk(input, input.agent, "retell"), twilio: providerLastOk(input, input.twilio, "twilio") };
  return ok({ retell, twilio, webhook, smsAnyClientEnabled, reasons, lastOkAt }, source, providerReadAt(input), input.now, PROVIDER_STALE_MS);
}
