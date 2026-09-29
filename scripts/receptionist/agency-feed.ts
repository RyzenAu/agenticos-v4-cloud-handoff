// Server-only reader for the MU-Receptionist agency feed (docs/AGENCY-FEED-CONTRACT.md).
//
// Hard rules this module encodes:
//   - AGENCY_FEED_TOKEN is used for exactly one Authorization header and appears in NOTHING that
//     leaves this module: no logs, no return values, no reason strings. Reasons never quote a
//     provider body or an exception message — either may echo the token.
//   - The response is validated field by field and projected explicitly; a stray provider field
//     (transcript text, a full phone number) can never spread into the page model. Phones are
//     re-masked and summaries re-truncated even though the contract requires the feed to do it.
//   - Missing env, a bad token or a broken feed is `{ ok: false, reason }` — never zeros.

import type {
  AgencyFeedState,
  BookingOutcome,
  FeedCall,
  FeedCallQa,
  FeedClient,
  FeedClientBookings,
  FeedClientHandoffs,
  FeedClientMinutes,
  FeedClientReadiness,
  FeedClientUsage,
  FeedData,
  FeedDeployment,
  FeedGoLive,
  FeedGoLiveClient,
  FeedOrganization,
  FeedQaFlag,
  GoLiveVerdict,
  FeedTotals,
  TriageItem,
} from "./types";

export type AgencyFeedOptions = {
  /** Resolves AGENCY_FEED_URL / AGENCY_FEED_TOKEN (scripts/provider-config.ts providerKey). */
  providerKey: (name: string) => string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long one fetch result (success or failure) is reused. The contract calls for 60 s. */
  cacheMs?: number;
  /**
   * "metadata" (the dashboard's default): calls/followUps come back empty — the only two v1
   * fields that can carry caller content are never requested. "full" (the default here) is the
   * older single-tenant snapshot's shape (recent calls + triage). Always appended as `?view=…`,
   * nothing else in the query: from MU-Receptionist f/rx-open-items-20260929 the FEED's default is
   * metadata, so a full read must ask for it explicitly (older feed builds return full for any view).
   */
  view?: "full" | "metadata";
};

const MAX_CALLS = 50;
const MAX_FOLLOW_UPS = 50;
const MAX_SUMMARY = 200;
const CACHE_MS = 60_000;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const when = (v: unknown): string | null => {
  const s = text(v, 40);
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
};
/** "••• 123" — re-masked here even though the contract masks upstream. */
const mask = (v: unknown): string | null => {
  const raw = typeof v === "number" && Number.isFinite(v) ? String(v) : (text(v, 64) ?? "");
  const digits = raw.replace(/\D/g, "");
  return digits ? `••• ${digits.slice(-3)}` : null;
};
const firstName = (v: unknown): string | null => (text(v, 60) ?? "").split(/\s+/)[0] || null;
/** Entries that don't validate are dropped, not defaulted. */
const project = <T>(rows: unknown, f: (v: unknown) => T | null): T[] =>
  Array.isArray(rows) ? rows.flatMap((row) => { const p = f(row); return p ? [p] : []; }) : [];
const counts = (v: unknown): { name: string; count: number }[] =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.entries(v as Record<string, unknown>).flatMap(([name, raw]) => {
        const label = text(name, 60);
        const n = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : null;
        return label && n !== null ? [{ name: label, count: n }] : [];
      })
    : [];

function projectQa(v: unknown): FeedCallQa | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const q = v as Record<string, unknown>;
  return {
    flagCount: num(q.flagCount),
    topBand: text(q.topBand, 40),
    reviewStatus: text(q.reviewStatus, 40),
    flagCodes: Array.isArray(q.flagCodes)
      ? [...new Set(q.flagCodes.flatMap((c) => { const s = text(c, 40); return s ? [s] : []; }))].slice(0, 12)
      : [],
  };
}

function projectCall(v: unknown): FeedCall | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const id = text(c.id, 120);
  if (!id) return null;
  return {
    id,
    organizationId: text(c.organizationId, 120),
    providerCallId: text(c.providerCallId, 120),
    callType: text(c.callType, 40),
    status: text(c.status, 40),
    outcome: text(c.outcome, 60),
    sentiment: text(c.sentiment, 40),
    callerMasked: mask(c.callerMasked),
    startedAt: when(c.startedAt),
    endedAt: when(c.endedAt),
    durationSeconds: num(c.durationSeconds),
    disconnectionReason: text(c.disconnectionReason, 60),
    summary: text(c.summary, MAX_SUMMARY),
    qa: projectQa(c.qa),
  };
}

function projectFollowUp(v: unknown): TriageItem | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  const id = text(f.id, 120);
  if (!id) return null;
  return {
    id,
    receivedAt: when(f.receivedAt),
    contactFirstName: firstName(f.contactFirstName),
    callerMasked: mask(f.callerMasked),
    intent: text(f.intent, 120),
    urgency: text(f.urgency, 40),
    callbackNeeded: f.callbackNeeded === true,
    alertPriority: text(f.alertPriority, 40),
    status: text(f.status, 40),
  };
}

function projectOrg(v: unknown): FeedOrganization | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = text(o.id, 120);
  if (!id) return null;
  return {
    id,
    name: text(o.name, 120),
    niche: text(o.niche, 60),
    isDemoTenant: o.isDemoTenant === true,
    inboundNumberMasked: mask(o.inboundNumberMasked),
  };
}

const bool = (v: unknown): boolean => v === true;
/**
 * Counts object -> a typed partial record of non-negative integers only; unknown keys dropped.
 * A missing record is null (not reported), never an empty record that would read as all zeros.
 */
function countRecord<K extends string>(v: unknown, keys: readonly K[]): Partial<Record<K, number>> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) {
    const n = src[k];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = Math.trunc(n);
  }
  return out;
}

/**
 * Alert reasons: every well-formed reason code with a count, not a fixed list (F11). A new reason
 * (NOT_LIVE_CALL, GO_LIVE_DRIFT, or one added later) must reach the page, labelled or shown as
 * unrecognised, never dropped. Codes are UPPER_SNAKE only and capped, so the feed can't inject text.
 */
function reasonCounts(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, 40))
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(k) && typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = Math.trunc(n);
  return out;
}

/** A block the feed didn't send, or sent without its counters, is null: unknown, never zeros (F2 RX-2). */
const block = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function projectClientBookings(v: unknown): FeedClientBookings | null {
  const o = block(v);
  const total = num(o?.total), madeOnCalls = num(o?.madeOnCalls), sandbox = num(o?.sandbox), upcoming = num(o?.upcoming);
  if (!o || total === null || madeOnCalls === null || sandbox === null || upcoming === null) return null;
  return { byStatus: countRecord(o.byStatus, ["CONFIRMED", "RESCHEDULED", "CANCELLED", "FAILED"]), total, madeOnCalls, sandbox, upcoming };
}

function projectClientHandoffs(v: unknown): FeedClientHandoffs | null {
  // Count maps list only non-zero statuses, so a reported, empty map is a real zero; a missing block isn't.
  const o = block(v);
  if (!o) return null;
  return {
    transfersByStatus: countRecord(o.transfersByStatus, ["RESERVED", "SUBMITTED", "CONNECTED", "FAILED", "UNKNOWN"]),
    alertsByReason: reasonCounts(o.alertsByReason),
    alertsByStatus: countRecord(o.alertsByStatus, ["PENDING", "SENT", "FAILED"]),
  };
}

function projectClientMinutes(v: unknown): FeedClientMinutes | null {
  const o = block(v);
  const calls = num(o?.calls), callMinutes = num(o?.callMinutes), billable = num(o?.billableMinutesCurrentPeriod);
  if (!o || calls === null || callMinutes === null || billable === null) return null;
  return { monthStart: when(o.monthStart), calls, callMinutes, billableMinutesCurrentPeriod: billable };
}

/**
 * Optional per-client usage (MU-Receptionist contract "clients[].usage", branches after 27 Sep): counts
 * only. The feed's own cost figures are its estimate and are NOT read here (AgenticOS estimates from
 * business-economics.ts and measures from Retell). Absent or malformed = null: unknown, never zero.
 */
function projectClientUsage(v: unknown): FeedClientUsage | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const smsSegments = num(o.smsSegments), billableMinutes = num(o.billableMinutes);
  if (smsSegments === null || billableMinutes === null || smsSegments < 0 || billableMinutes < 0) return null;
  const period = o.currentPeriod && typeof o.currentPeriod === "object" && !Array.isArray(o.currentPeriod) ? num((o.currentPeriod as Record<string, unknown>).billableMinutes) : null;
  return { receipts: num(o.receipts), pending: num(o.pending), billableMinutes: Math.trunc(billableMinutes), smsSegments: Math.trunc(smsSegments), periodBillableMinutes: period === null || period < 0 ? null : Math.trunc(period) };
}

function projectClientReadiness(v: unknown): FeedClientReadiness {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const outcome = text(o.bookingOutcome, 40);
  return {
    agentMapped: bool(o.agentMapped),
    inboundNumberSet: bool(o.inboundNumberSet),
    calendarRequested: text(o.calendarRequested, 40),
    calendarInUse: text(o.calendarInUse, 40),
    calendarReason: text(o.calendarReason, 80),
    liveCalendar: bool(o.liveCalendar),
    demoDiaryConfirmed: bool(o.demoDiaryConfirmed),
    bookingOutcome: (outcome === "confirmed" || outcome === "test_booking_only" ? outcome : null) as BookingOutcome | null,
    alertMailboxSet: bool(o.alertMailboxSet),
    transferEnabled: bool(o.transferEnabled),
    smsEnabled: bool(o.smsEnabled),
    retentionDays: num(o.retentionDays),
    retellRetentionAligned: text(o.retellRetentionAligned, 40) ?? "unverified",
    goLive: projectGoLive(o.goLive),
  };
}

const VERDICTS = ["safe", "not-safe", "unknown"] as const;
const verdictOf = (v: unknown): GoLiveVerdict | null => (VERDICTS.includes(v as GoLiveVerdict) ? (v as GoLiveVerdict) : null);
const codeList = (v: unknown) => (Array.isArray(v) ? v.flatMap((c) => (typeof c === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(c) ? [c] : [])).slice(0, 20) : []);
const textList = (v: unknown, max = 80) => (Array.isArray(v) ? v.flatMap((b) => { const s = text(b, max); return s ? [s] : []; }).slice(0, 12) : []);

/**
 * Top-level `goLive` (contract "Review R2 additions"): the enforced verdict. A malformed or unknown
 * verdict value is null (absent), never "safe"; a per-client row with a bad verdict is "unknown".
 */
export function projectGoLiveVerdict(v: unknown): FeedGoLive | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  const verdict = verdictOf(g.verdict);
  if (!verdict) return null;
  const perClient = Array.isArray(g.perClient)
    ? g.perClient.flatMap((c): FeedGoLiveClient[] => {
        if (!c || typeof c !== "object" || Array.isArray(c)) return [];
        const r = c as Record<string, unknown>;
        const orgId = text(r.orgId, 120);
        if (!orgId) return [];
        return [{ orgId, verdict: verdictOf(r.verdict) ?? "unknown", testRecordAt: when(r.testRecordAt), configHash: text(r.configHash, 80), missing: textList(r.missing, 40), blockers: textList(r.blockers), liveAt: when(r.liveAt) }];
      }).slice(0, 100)
    : [];
  return { verdict, perClient, checkedAt: when(g.checkedAt) };
}

/** Top-level `qaFlags`: open QA flags, codes only. Null when the key is absent (older feed). */
export function projectQaFlags(v: unknown): FeedQaFlag[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .flatMap((f): FeedQaFlag[] => {
      if (!f || typeof f !== "object" || Array.isArray(f)) return [];
      const r = f as Record<string, unknown>;
      const callId = text(r.callId, 120);
      if (!callId) return [];
      return [{ callId, codes: codeList(r.codes), severity: text(r.severity, 20), orgId: text(r.orgId, 120), at: when(r.at) }];
    })
    .slice(0, 200);
}

/** `readiness.goLive` (contract round 2): ready is true ONLY when the feed says exactly `true`. */
function projectGoLive(v: unknown): FeedClientReadiness["goLive"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  if (typeof g.ready !== "boolean") return null;
  const blockers = Array.isArray(g.blockers) ? g.blockers.flatMap((b) => { const s = text(b, 80); return s ? [s] : []; }).slice(0, 12) : [];
  return { ready: g.ready === true, blockers };
}

function projectClient(v: unknown): FeedClient | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const organizationId = text(c.organizationId, 120);
  if (!organizationId) return null;
  return {
    organizationId,
    slug: text(c.slug, 120),
    isDemoTenant: bool(c.isDemoTenant),
    bookings: projectClientBookings(c.bookings),
    handoffs: projectClientHandoffs(c.handoffs),
    minutesThisMonth: projectClientMinutes(c.minutesThisMonth),
    readiness: projectClientReadiness(c.readiness),
    usage: projectClientUsage(c.usage),
  };
}

function projectDeployment(v: unknown): FeedDeployment | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    retellWebhookSecretSet: bool(o.retellWebhookSecretSet),
    alertEmailChannelLive: bool(o.alertEmailChannelLive),
    cronSecretValid: bool(o.cronSecretValid),
    trustProxyHeaders: bool(o.trustProxyHeaders),
    transferExecutionEnabled: bool(o.transferExecutionEnabled),
  };
}

function projectTotals(v: unknown): FeedTotals | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  return {
    calls: num(t.calls),
    completed: num(t.completed),
    failed: num(t.failed),
    avgDurationSeconds: num(t.avgDurationSeconds),
    totalMinutes: num(t.totalMinutes),
    byOutcome: counts(t.byOutcome),
    bySentiment: counts(t.bySentiment),
    qaGraded: num(t.qaGraded),
    qaFlagged: num(t.qaFlagged),
    qaCriticalOpen: num(t.qaCriticalOpen),
    triagePending: num(t.triagePending),
    triageDone: num(t.triageDone),
    oldestPendingTriageAt: when(t.oldestPendingTriageAt),
  };
}

/**
 * Validate a decoded feed response and project it to the safe public shape.
 * Explicit projection only — an extra field in the payload can never spread through.
 */
export function projectAgencyFeed(body: unknown): AgencyFeedState {
  const root = body as Record<string, unknown> | null;
  if (!root || typeof root !== "object" || Array.isArray(root))
    return { ok: false, reason: "Agency feed response invalid" };
  if (root.version !== 1) return { ok: false, reason: "Agency feed version unsupported" };
  const generatedAt = when(root.generatedAt),
    totals = projectTotals(root.totals);
  if (!generatedAt || !totals || !Array.isArray(root.calls) || !Array.isArray(root.followUps))
    return { ok: false, reason: "Agency feed response invalid" };
  const view = root.view === "metadata" ? "metadata" : "full";
  const data: FeedData = {
    generatedAt,
    windowDays: num(root.windowDays),
    view,
    organizations: project(root.organizations, projectOrg),
    totals,
    calls: project(root.calls, projectCall).slice(0, MAX_CALLS),
    followUps: project(root.followUps, projectFollowUp).slice(0, MAX_FOLLOW_UPS),
    // Additive v1 keys: absent on an older (pre-27-Sep) feed deployment, never treated as an error.
    clients: project(root.clients, projectClient),
    deployment: projectDeployment(root.deployment),
    // Review R2 keys (both views): absent on an older deployment = null, which is never "safe".
    goLive: projectGoLiveVerdict(root.goLive),
    qaFlags: projectQaFlags(root.qaFlags),
  };
  return { ok: true, ...data };
}

/**
 * One fetch of the feed. Never logs; failure reasons are fixed phrases that cannot contain the
 * token or a provider body.
 */
export async function readAgencyFeed(options: AgencyFeedOptions): Promise<AgencyFeedState> {
  const url = options.providerKey("AGENCY_FEED_URL");
  const token = options.providerKey("AGENCY_FEED_TOKEN");
  if (!url || !token) return { ok: false, reason: "Agency feed not configured" };
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return { ok: false, reason: "Agency feed URL invalid" };
    // Only `view` is ever appended, and always explicitly: the feed now defaults to metadata, so a
    // full read that omitted it would silently lose calls and follow-ups. No other query parameter
    // is accepted from a caller.
    parsed.searchParams.set("view", options.view === "metadata" ? "metadata" : "full");
    href = parsed.href;
  } catch {
    return { ok: false, reason: "Agency feed URL invalid" };
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(href, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Never echo an exception message: it may carry the URL or headers.
    return {
      ok: false,
      reason: `Agency feed unreachable (${e instanceof Error && e.name === "TimeoutError" ? "TimeoutError" : "request failed"})`,
    };
  }
  if (!response.ok) {
    try {
      await response.text(); // drain and discard; the body is never read into a reason
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      reason:
        response.status === 401
          ? "Agency feed rejected the token (HTTP 401)"
          : `Agency feed returned HTTP ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "Agency feed response invalid" };
  }
  return projectAgencyFeed(body);
}

/** When the reader's latest read completed and when a read last succeeded (ms; null = never). */
export type AgencyFeedReadStatus = { readAt: number | null; lastOkAt: number | null };
export type AgencyFeedReader = ((force?: boolean) => Promise<AgencyFeedState>) & {
  /** The read behind the state the reader currently serves (audit RX-1/RX-7: say WHEN, and the last good read). */
  status: () => AgencyFeedReadStatus;
};

/**
 * The feed with a 60 s cache (failures included, so a down feed is not hammered). `force`
 * bypasses the cache — every Refresh path passes it through (audit RX-1).
 */
export function createAgencyFeed(options: AgencyFeedOptions): AgencyFeedReader {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? CACHE_MS;
  let cached: { at: number; state: Promise<AgencyFeedState> } | null = null;
  const status: AgencyFeedReadStatus = { readAt: null, lastOkAt: null };
  const read = (force = false) => {
    if (!force && cached && now() - cached.at < cacheMs) return cached.state;
    // Concurrent callers share one request; failures are cached too, so a down feed isn't hammered.
    const entry = {
      at: now(),
      state: readAgencyFeed(options).then((state) => {
        // Only the newest request updates the status (a slow older read never overwrites it).
        if (cached === entry) {
          status.readAt = now();
          if (state.ok) status.lastOkAt = status.readAt;
        }
        return state;
      }),
    };
    cached = entry;
    return entry.state;
  };
  return Object.assign(read, { status: () => ({ ...status }) });
}
