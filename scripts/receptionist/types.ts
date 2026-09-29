// The /receptionist page's data contract (server: scripts/receptionist/*, client: src/lib/receptionist.ts).
//
// Hard rules this shape encodes:
//   - No raw transcript text ever appears here. Calls carry flag CODES only; the transcript is read
//     in memory by flags.ts and dropped.
//   - No key, token or auth header ever appears here.
//   - A source that could not be read is `{ ok: false, reason }` — never a zero dressed up as data.
//
// Money: Retell reports call_cost.combined_cost in US CENTS. We keep `usdCents` as the source of
// truth and add `aud` (dollars) when an exchange rate was available.

import type { PackageId } from "../../src/lib/receptionist-packages";

export type Unavailable = { ok: false; reason: string };
/** Where the receptionist line's agent id and number were resolved from (plugin.ts resolveLine). */
export type LineSource = "options" | "config" | "legacy-demo-default";
export type Available<T> = { ok: true } & T;
export type Source<T> = Available<T> | Unavailable;

export type Tone = "ok" | "warn" | "bad" | "neutral";

/** One item in the health strip. `detail` is a short plain line; `next` only when something is wrong. */
export type HealthItem = {
  id: "agent" | "number" | "twilio" | "webhook" | "evals" | "feed";
  label: string;
  tone: Tone;
  /** e.g. "claude-4.5-haiku · retell-Leland · en-AU" */
  headline: string;
  detail: string;
  /** Plain next step when tone is warn/bad, e.g. "Set the agent webhook to MU-Receptionist". */
  next?: string;
  /** Owner-facing deep link (Retell/Twilio console), never an API URL with a key. */
  href?: string;
  /** ISO time the underlying fact changed (agent last edited, eval report date…), if known. */
  asOf?: string;
};

export type FlagCode =
  | "DANGER_LANGUAGE" // life-safety language on any line: critical human review
  | "LEGAL_URGENT" // legal deadline/custody: urgent human review, not automatically 000
  | "URGENT_NO_HUMAN_ROUTE" // legal urgency without affirmative transfer/message wording
  | "FALSE_BOOKING" // agent told the caller they were booked — no booking system is connected
  | "SMS_PROMISE" // agent promised an SMS/text — SMS is not configured
  | "URGENT_NO_000" // caller used urgent/life-safety language and the agent never gave 000 advice
  | "CLINICAL_ADVICE" // agent named a medication/dose without refusing to advise
  | "NO_AI_DISCLOSURE" // agent's opening turns never said it is an AI/virtual assistant
  | "STAGE_DIRECTION"; // agent read a stage direction aloud: [brackets], *asterisks*, (pause), "Note:"

export const FLAG_LABEL: Record<FlagCode, string> = {
  DANGER_LANGUAGE: "Danger language — critical review",
  LEGAL_URGENT: "Legal urgency — human review",
  URGENT_NO_HUMAN_ROUTE: "Legal urgency — no human route offered",
  FALSE_BOOKING: "False booking",
  SMS_PROMISE: "Promised SMS",
  URGENT_NO_000: "Urgent, no 000",
  CLINICAL_ADVICE: "Clinical advice",
  NO_AI_DISCLOSURE: "No AI disclosure",
  STAGE_DIRECTION: "Stage direction read aloud",
};

export type CallRow = {
  /** Explicit owner-test attribution only; never inferred from a masked phone or call quality.
   * Current Retell adapter does not supply this field. */
  ownerTestBy?: string;
  id: string;
  /** "phone" for real PSTN calls, "web" for Retell dashboard/web test calls. */
  kind: "phone" | "web";
  startedAt: string | null;
  durationSec: number | null;
  /** Caller number masked to the last 3 digits, e.g. "••• 208"; null for web calls. */
  from: string | null;
  status: string;
  disconnectReason: string | null;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  usdCents: number | null;
  /** One line, from Retell's call_summary (condensed by MiMo when available, else first sentence). */
  summary: string | null;
  summarySource: "mimo" | "first-sentence" | "none";
  sentiment: "Positive" | "Neutral" | "Negative" | "Unknown";
  successful: boolean | null;
  flags: FlagCode[];
  /** Whether a transcript existed to check. False → flags is empty because nothing could be checked. */
  checked: boolean;
  /** https://dashboard.retellai.com/… page for this call (owner opens it; we never fetch it). */
  retellUrl: string;
};

export type CallWindow = {
  label: "Today" | "7 days" | "All time";
  count: number;
  /** Calls that connected to the agent (status ended/ongoing with duration > 0). */
  answered: number;
  avgDurationSec: number | null;
  p90DurationSec: number | null;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  /** Share of analysed calls Retell marked call_successful, 0..1; null when none analysed. */
  successRate: number | null;
  usdCents: number;
  aud: number | null;
  /** Retell cost per connected minute, AUD (null when no minutes or no fx). */
  audPerMinute: number | null;
  minutes: number;
  disconnectReasons: { reason: string; count: number }[];
  flaggedCalls: number;
};

export type CallsBlock = Source<{
  windows: [CallWindow, CallWindow, CallWindow];
  /** Latest first, at most 25. */
  recent: CallRow[];
  /** Daily points for the latency trend, oldest first, last 14 days with calls only. */
  latencyTrend: { day: string; p50Ms: number; p90Ms: number; calls: number }[];
  /** Count of each flag across all calls read. */
  flagTotals: Partial<Record<FlagCode, number>>;
}>;

// ── MU-Receptionist agency feed (docs/AGENCY-FEED-CONTRACT.md) ──────────────────────────────────
// The production database's own view of calls, QA and triage, read server-side. Everything here
// is already privacy-projected: phones are re-masked, first names only, summaries ≤ 200 chars,
// QA codes only — never transcript text, evidence text or the feed token. Counts are
// `number | null`: a counter the feed did not send shows as "—", never as a zero.

/** QA verdict on one call, from the MU-Receptionist QA engine: codes only, never evidence text. */
export type FeedCallQa = {
  flagCount: number | null;
  /** Highest severity band the QA engine uses, e.g. "critical". */
  topBand: string | null;
  reviewStatus: string | null;
  /** QA flag codes as strings (the QA engine's own codes, not FlagCode). */
  flagCodes: string[];
};

/** One production call record from the agency feed (newest first, at most 50). */
export type FeedCall = {
  id: string;
  organizationId: string | null;
  /** The Retell call id, for the owner's own "open in Retell" link. */
  providerCallId: string | null;
  callType: string | null;
  status: string | null;
  outcome: string | null;
  sentiment: string | null;
  /** "••• 123" — re-masked on our side even though the contract masks upstream. */
  callerMasked: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  disconnectionReason: string | null;
  /** At most 200 chars. */
  summary: string | null;
  /** null = no QA review on record (never a zero-flag claim). */
  qa: FeedCallQa | null;
};

/** A pending triage item for the Follow-ups panel (TriageItem where status is not done). */
export type TriageItem = {
  id: string;
  receivedAt: string | null;
  /** First name only. */
  contactFirstName: string | null;
  callerMasked: string | null;
  intent: string | null;
  urgency: string | null;
  callbackNeeded: boolean;
  alertPriority: string | null;
  status: string | null;
};

export type FeedOrganization = {
  id: string;
  name: string | null;
  niche: string | null;
  isDemoTenant: boolean;
  inboundNumberMasked: string | null;
};

/** Feed totals across the window; the QA and triage counters feed the Quality and Follow-ups panels. */
export type FeedTotals = {
  calls: number | null;
  completed: number | null;
  failed: number | null;
  avgDurationSeconds: number | null;
  totalMinutes: number | null;
  byOutcome: { name: string; count: number }[];
  bySentiment: { name: string; count: number }[];
  qaGraded: number | null;
  qaFlagged: number | null;
  /** Critical-band reviews whose reviewStatus is not resolved. */
  qaCriticalOpen: number | null;
  triagePending: number | null;
  triageDone: number | null;
  oldestPendingTriageAt: string | null;
};

// ── v1 additions, 27 Sep 2026: per-client metadata (docs/AGENCY-FEED-CONTRACT.md "v1 additions") ──
// Counts, ids, enum values, booleans and ISO timestamps only — the loader's Prisma selects read no
// name/phone/email/notes/summary/transcript column, so there is nothing to mask here.

// Unknown is never 0 (audit F2 RX-2). A block the feed didn't send, or sent without one of its
// counters, is null on FeedClient as a whole (agency-feed.ts). Inside a reported block, a
// `byStatus`/`…ByStatus`/`alertsByReason` record the feed sent is complete (an absent key there is a
// real zero); null means that record was missing, so its counts are unknown.
export type FeedClientBookings = {
  byStatus: Partial<Record<"CONFIRMED" | "RESCHEDULED" | "CANCELLED" | "FAILED", number>> | null;
  total: number;
  /** Linked to a call: made by the receptionist. */
  madeOnCalls: number;
  /** In a platform sandbox diary (demo diary or test-only). */
  sandbox: number;
  /** Live bookings whose appointment is still ahead (any creation date). */
  upcoming: number;
};

export type FeedClientHandoffs = {
  transfersByStatus: Partial<Record<"RESERVED" | "SUBMITTED" | "CONNECTED" | "FAILED" | "UNKNOWN", number>> | null;
  /**
   * Every alert reason the feed reports, known or not (REVIEW-RECEPTIONIST-R3 F11: a fixed allow-list
   * dropped NOT_LIVE_CALL and GO_LIVE_DRIFT, so they could never show). Labels: dashboard.ts.
   */
  alertsByReason: Record<string, number> | null;
  alertsByStatus: Partial<Record<"PENDING" | "SENT" | "FAILED", number>> | null;
};

export type FeedClientMinutes = {
  /** Local midnight on the 1st, as UTC — the CLIENT's calendar month, not the feed window. */
  monthStart: string | null;
  calls: number;
  callMinutes: number;
  billableMinutesCurrentPeriod: number;
};

/** What a caller hears after `book_appointment` succeeds: "confirmed" or "test_booking_only". */
export type BookingOutcome = "confirmed" | "test_booking_only";

export type FeedClientReadiness = {
  agentMapped: boolean;
  inboundNumberSet: boolean;
  calendarRequested: string | null;
  calendarInUse: string | null;
  calendarReason: string | null;
  liveCalendar: boolean;
  demoDiaryConfirmed: boolean;
  bookingOutcome: BookingOutcome | null;
  alertMailboxSet: boolean;
  transferEnabled: boolean;
  smsEnabled: boolean;
  retentionDays: number | null;
  /** Always "unverified" per contract: needs a live Retell read, never claimed from the feed alone. */
  retellRetentionAligned: string;
  /**
   * MU-Receptionist's own server-side go-live verdict (contract "Round 2 additions, 28 Sep 2026":
   * `clients[].readiness.goLive`): ready only when booking, routing and every configured capability
   * have a recorded passing test on the current configuration. null when the feed didn't send it —
   * which the sell verdict treats as NOT ready, never as ready.
   */
  goLive: { ready: boolean; blockers: string[] } | null;
};

/** Per-client usage counts for the window (contract "clients[].usage"); the feed's cost estimate is not read. */
/**
 * `billableMinutes` and `smsSegments` count calls STARTED in the feed's rolling window (30 days,
 * per-call rounding): never billing figures. `periodBillableMinutes` is the current billing
 * period's figure (contract `usage.currentPeriod.billableMinutes`); null when not sent. Review R1.
 */
export type FeedClientUsage = { receipts: number | null; pending: number | null; billableMinutes: number; smsSegments: number; periodBillableMinutes: number | null };

/** One client (organisation) this deployment serves, from the feed's `clients[]` (view=metadata). */
export type FeedClient = {
  organizationId: string;
  slug: string | null;
  isDemoTenant: boolean;
  /** null when the feed didn't report this block (F2 RX-2): unknown, never zeros. */
  bookings: FeedClientBookings | null;
  handoffs: FeedClientHandoffs | null;
  minutesThisMonth: FeedClientMinutes | null;
  readiness: FeedClientReadiness;
  /** null/absent on a deployment without the usage block: SMS counts are then unknown. */
  usage?: FeedClientUsage | null;
};

/** Booleans only, never a value — the feed's `deployment` block. */
export type FeedDeployment = {
  retellWebhookSecretSet: boolean;
  alertEmailChannelLive: boolean;
  cronSecretValid: boolean;
  trustProxyHeaders: boolean;
  transferExecutionEnabled: boolean;
};

export type FeedData = {
  /** When MU-Receptionist generated the feed (the health strip's "last generatedAt"). */
  generatedAt: string;
  windowDays: number | null;
  /** "metadata" when read with `?view=metadata` (calls/followUps come back empty); "full" otherwise. */
  view: "full" | "metadata";
  organizations: FeedOrganization[];
  totals: FeedTotals;
  /** Newest first, at most 50. Empty on a metadata-view read. */
  calls: FeedCall[];
  /** Oldest first, at most 50. Empty on a metadata-view read. */
  followUps: TriageItem[];
  /** v1 addition: one row per organisation this deployment serves. Empty on a v1-only feed. */
  clients: FeedClient[];
  /** v1 addition. Null on a v1-only feed (the key was absent). */
  deployment: FeedDeployment | null;
  /**
   * Review R2 (28 Sep 2026): MU-Receptionist's ENFORCED go-live verdict, the authoritative record of
   * the per-client go-live tests (booking, routing, texts, consent) bound to a config hash, with
   * evidence under 30 days old. Null when the feed didn't send it (not safe).
   */
  goLive: FeedGoLive | null;
  /** Review R2: every OPEN Call QA flag across every organisation, newest first. Null when absent. */
  qaFlags: FeedQaFlag[] | null;
};

export type GoLiveVerdict = "safe" | "not-safe" | "unknown";
export type FeedGoLiveClient = {
  orgId: string;
  verdict: GoLiveVerdict;
  testRecordAt: string | null;
  configHash: string | null;
  missing: string[];
  blockers: string[];
  liveAt: string | null;
};
export type FeedGoLive = { verdict: GoLiveVerdict; perClient: FeedGoLiveClient[]; checkedAt: string | null };
export type FeedQaFlag = { callId: string; codes: string[]; severity: string | null; orgId: string | null; at: string | null };

/** The agency feed source: `{ ok: false, reason }` when unreadable — never zeros. */
export type AgencyFeedState = Source<FeedData>;

export type BlockerId = "no-false-actions" | "urgent-wording" | "compliance" | "hours-handoff" | "cost-reconciliation";

export type Blocker = {
  id: BlockerId;
  title: string;
  /** "derived" blockers turn green only from evidence; "manual" ones from an owner sign-off. */
  mode: "derived" | "manual";
  done: boolean;
  /** Evidence lines we could compute (never transcript text), e.g. "Prompt mentions 000: yes". */
  evidence: string[];
  /** Plain next step while open. */
  next: string;
  /** The standing owner sign-off (only while signed off; a reopened gate has `reopened` instead). */
  signedOff?: { by: string; at: string; note?: string };
  /** The owner reopened a signed-off gate: who and when (audit RX-4). */
  reopened?: { by: string; at: string; note?: string };
  /** Set when a signed-off blocker has contrary evidence since (e.g. a flagged call after sign-off). */
  warning?: string;
  /**
   * Gate state, round 2 (Sol: "PASS / FAIL / NOT TESTED"):
   *   "pass"       — derived evidence met, or signed off with no contrary evidence;
   *   "fail"       — a relevant flag on a real call made AFTER the agent/prompt was last changed;
   *   "not-tested" — no qualifying real call since the last agent/prompt change;
   *   "open"       — evidence exists but nothing contradicts it; waiting for sign-off.
   *   "evidence-missing" — a changed prompt lost evidence supporting an earlier sign-off.
   *   "unknown"    — the Retell calls couldn't be read, so whether a real call tested it is unknown.
   * Sign-off is refused (400) while failing, untested, unknown, or missing evidence.
   */
  state: "pass" | "fail" | "not-tested" | "open" | "evidence-missing" | "unknown";
  /** Short plain reason for the state, e.g. "1 flag, before the 26 Sep prompt rebuild". */
  stateNote?: string;
  /**
   * Whether the evidence the gate needs is actually present now (e.g. "Transfer tool on agent: yes").
   * false means a sign-off alone can't pass the gate: it shows "evidence-missing" instead.
   */
  evidencePresent?: boolean;
};

export type ReadinessBlock = {
  blockers: Blocker[];
  open: number;
  /** Always-shown facts that aren't blockers but gate selling: LEGAL template, SMS. */
  facts: { id: "legal-template" | "sms"; label: string; tone: Tone; detail: string }[];
  /** Consecutive recent real phone calls with no FALSE_BOOKING/SMS_PROMISE flag, and the target. */
  cleanStreak: { count: number; target: number };
  /** Qualifying owner-attributed retests since the prompt change; null means attribution unavailable. */
  ownerRetestCalls: { count: number; target: number } | null;
};

export type CommercialBlock = {
  leads: Source<{
    total: number;
    /** CRM status buckets for leads pitched receptionist/both, in pipeline order. */
    byStage: { stage: string; label: string; count: number }[];
  }>;
  /** Pilots in flight — none yet; the page shows an empty state with the next step. */
  pilots: { name: string; startedAt: string; endsAt: string }[];
  /**
   * The offer, derived ONLY from src/lib/receptionist-packages.ts (commercial.ts catalogueOffer).
   * No pilot is offered: `pilotTerms` says pilot terms are not approved.
   */
  offer: {
    source: string;
    catalogueVersion: string;
    defaultPackageId: OfferTier["id"];
    tiers: OfferTier[];
    pilotTerms: string;
  };
  /** Measured, not assumed. Null fields when there is no measured cost yet. */
  economics: {
    measuredMinutes: number;
    measuredCalls: number;
    retellAudPerMinute: number | null;
    /** The catalogue tier the top-level cost/margin fields describe (offer.defaultPackageId). */
    packageId: OfferTier["id"];
    /** Retell cost of a client using all the default tier's included minutes. */
    costAtIncludedAud: number | null;
    marginAtIncludedAud: number | null;
    marginPct: number | null;
    /** Minutes of use at which Retell cost equals the default tier's monthly fee. */
    breakEvenMinutes: number | null;
    /** The same figures for every catalogued tier. */
    perTier: TierMargin[];
    caveat: string;
  };
};

/** One catalogued package tier, as the commercial panel shows it (prices in AUD cents). */
export type OfferTier = {
  id: PackageId;
  name: string;
  shortName: string;
  tier: number;
  /** "proposed" until the owner approves the catalogue price. */
  status: "proposed" | "approved";
  /** The setup fee's own approval (catalogue setupStatus); a proposed setup fee is never invoiced. */
  setupStatus: "proposed" | "approved";
  setupCents: number;
  monthlyCents: number;
  includedMinutes: number;
  overagePerMinuteCents: number;
  /** GST basis label, e.g. "ex GST". */
  gst: string;
};

export type TierMargin = {
  packageId: OfferTier["id"];
  shortName: string;
  status: OfferTier["status"];
  gst: string;
  monthlyAud: number;
  includedMinutes: number;
  costAtIncludedAud: number | null;
  marginAtIncludedAud: number | null;
  marginPct: number | null;
  breakEvenMinutes: number | null;
};

/** A flagged real phone call whose caller may be expecting something that won't happen
 *  (FALSE_BOOKING / SMS_PROMISE / URGENT_NO_000 / CLINICAL_ADVICE), until the owner marks it followed up. */
export type Incident = {
  /** The Retell call id when known (local flags, or the feed's providerCallId); else `feed:<feed call id>`. */
  callId: string;
  startedAt: string | null;
  from: string | null;
  /** Local transcript flags (flags.ts). Empty for a call only production QA flagged. */
  flags: FlagCode[];
  /** Plain consequence, e.g. "Caller may expect a booking and an SMS that won't come." */
  consequence: string;
  /** Retell call page; "" when the feed gave no Retell call id. */
  retellUrl: string;
  /** Every open production-QA code the agency feed carries for this call (not only urgent ones). */
  qaCodes?: string[];
  /** The feed's QA review status for the call (PENDING / NOT_QUEUED / null = not reported). */
  qaReview?: string | null;
  /** A FLAG-band (critical) QA review that isn't REVIEWED yet: counted in the feed's qaCriticalOpen. */
  qaCritical?: boolean;
  /** Where the flags came from; one entry per call even when both flagged it. */
  sources?: ("retell" | "production QA")[];
  /**
   * For a production-QA call: the client (organisation) the feed attributes it to, or null when it
   * matches no row in the feed's clients[] ("not attributed to a client"). Absent for local-only calls.
   */
  client?: string | null;
  /** Set when the owner marked the call followed up; it still counts until the recorded retests pass. */
  followedUp?: { by: string; at: string };
};

/** One condition the "Safe to sell" verdict requires (all must be ok), or an informational line. */
export type SellCheck = {
  id: "answering" | "flagged-calls" | "go-live-verdict" | "feed-qa" | "checklist" | "evals" | "gates" | "retests";
  label: string;
  ok: boolean;
  detail: string;
  /**
   * Shown with the checks but never blocks the verdict: the owner-console go-live checklist, whose
   * per-client steps the enforced goLive verdict now covers (coordinator, 28 Sep 2026).
   */
  informational?: boolean;
  /** The condition couldn't be evaluated (its source wasn't read): shown "Unknown", never "Met". */
  unknown?: boolean;
};

/** The first-screen decision block (Sol: decision before plumbing). */
export type Verdict = {
  /** "Not safe to sell" | "Safe to sell" | "Status unknown" */
  decision: string;
  tone: Tone;
  /** 2–4 short facts, e.g. ["Answering on unpublished draft v0", "1 real call today · 1 flagged", "0 of 5 gates passed"]. */
  facts: string[];
  /** The single next action, sentence case, no trailing full stop. */
  next: string;
  /** Every condition "Safe to sell" requires, each with its current state (UI-truth H5). */
  checks?: SellCheck[];
};

export type ReceptionistSnapshot = {
  generatedAt: string;
  verdict: Verdict;
  /** Flagged calls to act on, newest first: local flags not yet followed up, merged by call with
   *  every open production-QA flag from the agency feed (attributed to a client or not). */
  incidents: Incident[];
  /** Followed-up flagged calls whose recorded retests haven't passed yet: still block selling. */
  awaitingRetest?: Incident[];
  /** The one plain sentence at the top of the page (and what Jarvis reads aloud). */
  sentence: string;
  /** Overall tone for the sentence's dot. */
  tone: Tone;
  agent: {
    id: string;
    name: string | null;
    number: string;
    retellUrl: string;
    /** Where the agent id and number came from: explicit options, runtime config, or the legacy demo-line fallback. */
    lineSource?: LineSource;
  };
  health: HealthItem[];
  calls: CallsBlock;
  /** MU-Receptionist's production feed (QA flag codes, outcomes, triage) — { ok:false, reason } when unreadable. */
  feed: AgencyFeedState;
  /**
   * When THIS snapshot's agency-feed read completed, and the last read that succeeded (ISO, null =
   * never). The dashboard reads the feed separately (metadata view), so each surface says its own
   * read time (audit RX-1). Absent on a snapshot built without the plugin's reader.
   */
  feedRead?: { at: string | null; lastOkAt: string | null };
  readiness: ReadinessBlock;
  commercial: CommercialBlock;
  fx: { usdToAud: number; asOf: string; source: string } | null;
  /** Retell account/Twilio month-to-date account spend, for cost reconciliation. */
  spend: {
    retellMonthUsdCents: number | null;
    twilioMonthUsd: Source<{ usd: number; balanceUsd: number | null }>;
  };
};

/**
 * POST /__receptionist/readiness body. WHO signed off is never part of it: the server records the
 * verified principal (scripts/identity), and a `by` in the body is ignored (audit RX-5).
 */
export type ReadinessPatch = { id: BlockerId; done: boolean; note?: string };

/** POST /__receptionist/incident body: mark a flagged call as followed up (who = the verified principal). */
export type IncidentPatch = { callId: string; note?: string };
