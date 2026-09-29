// SYNTHETIC fixture for the D1 Receptionist preview (29 Sep 2026). Mirrors the owner's screenshot
// states: not safe to sell, 1 of 7 requirements met, 2 flagged calls (3-4 labels each), 0 of 5 gates.
// Everything here is invented: no real calls, callers, feed, Retell or Twilio data, no keys.
import { buildReceptionistSnapshot, type SnapshotInputs } from "../../scripts/receptionist/aggregate";
import { buildDashboard } from "../../scripts/receptionist/dashboard";
import type { AgencyFeedState, CallRow, FeedCall, FeedClient, ReceptionistSnapshot } from "../../scripts/receptionist/types";

export function syntheticFixture(now = Date.now()) {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const call = (over: Partial<CallRow>): CallRow => ({
    id: "call_synthetic0001", kind: "phone", startedAt: iso(3_600_000), durationSec: 150, from: "+61400000615",
    status: "ended", disconnectReason: "user_hangup", latencyP50Ms: 900, latencyP90Ms: 1400, usdCents: 38,
    summary: "Synthetic call.", summarySource: "first-sentence", sentiment: "Neutral", successful: true,
    flags: [], checked: true, retellUrl: "https://dashboard.retellai.com/call-history?history=call_synthetic0001", ...over,
  });
  const rows = [
    call({ id: "call_synthetic0001", startedAt: iso(47 * 60_000), from: "+61400000615", flags: ["URGENT_NO_000"] }),
    call({ id: "call_synthetic0002", startedAt: iso(26 * 3_600_000), from: "+61400000342", flags: ["FALSE_BOOKING", "SMS_PROMISE"], retellUrl: "https://dashboard.retellai.com/call-history?history=call_synthetic0002" }),
    call({ id: "call_synthetic0003", startedAt: iso(30 * 3_600_000), from: "+61400000908" }),
  ];
  const feedCall: FeedCall = {
    id: "fc_synthetic_1", organizationId: "org_synthetic", providerCallId: "call_synthetic0001", callType: "phone", status: "COMPLETED",
    outcome: "ENQUIRY_ANSWERED", sentiment: "NEUTRAL", callerMasked: "â€¢â€¢â€¢ 615", startedAt: iso(47 * 60_000), endedAt: null, durationSeconds: 150,
    disconnectionReason: null, summary: null,
    qa: { flagCount: 2, topBand: "FLAG", reviewStatus: "PENDING", flagCodes: ["TRANSFER_PROMISED_NOT_ATTEMPTED", "URGENT_CALL"] },
  };
  const client: FeedClient = {
    organizationId: "org_synthetic", slug: "synthetic-dental", isDemoTenant: true,
    bookings: { byStatus: { CONFIRMED: 2 }, total: 2, madeOnCalls: 2, sandbox: 2, upcoming: 1 },
    handoffs: { transfersByStatus: { FAILED: 1 }, alertsByReason: { URGENT: 1 }, alertsByStatus: { SENT: 1 } },
    minutesThisMonth: { monthStart: iso(28 * 86_400_000), calls: 3, callMinutes: 8, billableMinutesCurrentPeriod: 8 },
    readiness: { agentMapped: true, inboundNumberSet: true, calendarRequested: null, calendarInUse: null, calendarReason: "Demo diary only", liveCalendar: false, demoDiaryConfirmed: true, bookingOutcome: "test_booking_only", alertMailboxSet: true, transferEnabled: false, smsEnabled: false, retentionDays: 30, retellRetentionAligned: "unverified", goLive: { ready: false, blockers: ["booking: awaiting-test", "routing: awaiting-test"] } },
  };
  const organizations = [{ id: "org_synthetic", name: "Harbourview Dental (synthetic)", niche: "DENTAL", isDemoTenant: true, inboundNumberMasked: "â€¢â€¢â€¢ 000" }];
  const totals = { calls: 3, completed: 3, failed: 0, avgDurationSeconds: 150, totalMinutes: 8, byOutcome: [], bySentiment: [], qaGraded: 3, qaFlagged: 1, qaCriticalOpen: 1, triagePending: 1, triageDone: 0, oldestPendingTriageAt: iso(47 * 60_000) };
  const goLive = { verdict: "not-safe" as const, checkedAt: iso(5 * 60_000), perClient: [{ orgId: "org_synthetic", verdict: "not-safe" as const, testRecordAt: null, configHash: null, missing: ["booking", "routing"], blockers: ["booking: awaiting-test", "routing: awaiting-test"], liveAt: null }] };
  const fullFeed: AgencyFeedState = { ok: true, generatedAt: iso(90_000), windowDays: 30, view: "full", organizations, totals, calls: [feedCall], followUps: [], clients: [client], deployment: null, goLive, qaFlags: null };
  const metaFeed: AgencyFeedState = { ...fullFeed, view: "metadata", calls: [], followUps: [] };

  const inputs: SnapshotInputs = {
    agentId: "agent_synthetic", number: "+61400000000", lineSource: "config",
    agent: { ok: true, name: "Synthetic receptionist", voice: "voice-x", language: "en-AU", model: "model-x", published: false, webhook: true, webhookHost: "rx.example.test", webhookProbe: "protected", modified: iso(2 * 86_400_000), promptKnown: true, prompt000: true, disclosure: true, recording: true, overseas: true, transfer: false, version: 0 } as never,
    numberFacts: { ok: true, attached: true, version: 0, sms: false },
    calls: { ok: true, rows },
    twilio: { ok: true, connected: true, trunkSid: "TK_synthetic", balanceUsd: 12, month: { ok: true, usd: 3, balanceUsd: 12 } },
    evals: { ok: false, reason: "No eval report on file" },
    agencyFeed: fullFeed,
    agencyFeedRead: { readAt: now - 90_000, lastOkAt: now - 90_000 },
    legal: "missing",
    leads: { ok: false, reason: "CRM not found" },
    signoffs: {},
    fx: { usdToAud: 1.52, asOf: iso(86_400_000).slice(0, 10), source: "synthetic" },
  };
  const snapshot: ReceptionistSnapshot = buildReceptionistSnapshot(inputs, now);
  const dashboard = buildDashboard({
    now, providersReadAt: now, feed: metaFeed, feedReadAt: now - 60_000,
    agent: inputs.agent as never, numberFacts: inputs.numberFacts as never, twilio: inputs.twilio as never,
  });
  return { snapshot, dashboard };
}

if (import.meta.main) {
  const { snapshot } = syntheticFixture();
  const req = (snapshot.verdict.checks ?? []).filter((c) => !c.informational);
  console.log(JSON.stringify({
    decision: snapshot.verdict.decision,
    met: `${req.filter((c) => c.ok).length} of ${req.length}`,
    checks: snapshot.verdict.checks?.map((c) => [c.id, c.ok, c.unknown ?? false, c.informational ?? false, c.label, c.detail]),
    incidents: snapshot.incidents.map((i) => [i.callId, i.flags, i.qaCodes]),
    gates: snapshot.readiness.blockers.map((b) => [b.id, b.state]),
    facts: snapshot.verdict.facts, next: snapshot.verdict.next,
  }, null, 1));
}
