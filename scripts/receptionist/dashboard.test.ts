import { expect, test } from "bun:test";
import { ageText, blockIsStale, buildDashboard, FEED_STALE_MS, PROVIDER_STALE_MS, tileRecovery, tileState, type ClientPackageMap, type DashboardInput } from "./dashboard";
import { calculateEconomics, DEFAULT_COST_RATES, DEFAULT_FX, DEFAULT_LABOUR_HOURLY_CENTS, DEFAULT_PAYMENT, DEFAULT_TARGET_MARGIN_BPS } from "../../src/lib/business-economics";
import { getReceptionistPackage } from "../../src/lib/receptionist-packages";
import type { AgencyFeedState, FeedClient, FeedDeployment, FeedOrganization } from "./types";

const NOW = Date.parse("2026-09-27T06:00:00Z");

/** A contract-shaped, entirely synthetic `clients[]` row. Every field is fictional. */
function syntheticClient(overrides: Partial<FeedClient> = {}): FeedClient {
  return {
    organizationId: "org_synthetic_1",
    slug: "synthetic-dental",
    isDemoTenant: false,
    bookings: { byStatus: { CONFIRMED: 10, CANCELLED: 1 }, total: 11, madeOnCalls: 10, sandbox: 0, upcoming: 4 },
    handoffs: {
      transfersByStatus: { CONNECTED: 2 },
      alertsByReason: { NEW_BOOKING: 10, CALLBACK_REQUEST: 1 },
      alertsByStatus: { SENT: 10 },
    },
    minutesThisMonth: { monthStart: "2026-09-01T00:00:00Z", calls: 100, callMinutes: 250, billableMinutesCurrentPeriod: 250 },
    readiness: {
      agentMapped: true, inboundNumberSet: true, calendarRequested: "GOOGLE", calendarInUse: "GOOGLE",
      calendarReason: "configured", liveCalendar: true, demoDiaryConfirmed: false,
      bookingOutcome: "confirmed", alertMailboxSet: true, transferEnabled: true, smsEnabled: false,
      retentionDays: 90, retellRetentionAligned: "unverified",
    },
    ...overrides,
  };
}
function syntheticOrg(overrides: Partial<FeedOrganization> = {}): FeedOrganization {
  return { id: "org_synthetic_1", name: "Synthetic Dental (fictional)", niche: "DENTAL", isDemoTenant: false, inboundNumberMasked: "••• 208", ...overrides };
}
type FeedOkOverrides = Partial<{ clients: FeedClient[]; organizations: FeedOrganization[]; generatedAt: string; deployment: FeedDeployment | null }>;
function feedOk(overrides: FeedOkOverrides = {}): AgencyFeedState {
  return {
    ok: true,
    generatedAt: overrides.generatedAt ?? "2026-09-27T05:00:00.000Z",
    windowDays: 30,
    view: "metadata",
    organizations: overrides.organizations ?? [syntheticOrg()],
    totals: { calls: 100, completed: 95, failed: 5, avgDurationSeconds: 150, totalMinutes: 250, byOutcome: [{ name: "booked", count: 90 }], bySentiment: [{ name: "positive", count: 80 }], qaGraded: 20, qaFlagged: 1, qaCriticalOpen: 0, triagePending: 2, triageDone: 8, oldestPendingTriageAt: "2026-09-26T00:00:00.000Z" },
    calls: [],
    followUps: [],
    clients: overrides.clients ?? [syntheticClient()],
    deployment: overrides.deployment ?? { retellWebhookSecretSet: true, alertEmailChannelLive: true, cronSecretValid: true, trustProxyHeaders: true, transferExecutionEnabled: false },
  };
}
const AGENT_OK = { ok: true as const, name: "Synthetic Agent", voice: "voice-x", language: "en-AU", model: "claude-4.5-haiku", published: true, webhook: true, webhookHost: "mu-receptionist.example.test", webhookProbe: "protected" as const, modified: "2026-09-26T00:00:00.000Z", prompt000: true, disclosure: true, recording: true, overseas: true, transfer: false, promptKnown: true, version: 3, llmVersion: 5 };
const NUMBER_OK = { ok: true as const, attached: true, version: 3, sms: false };
const TWILIO_OK = { ok: true as const, connected: true, trunkSid: "TK_synthetic", balanceUsd: 42, month: { ok: true as const, usd: 3.5, balanceUsd: 42 } };

function baseInput(over: Partial<DashboardInput> = {}): DashboardInput {
  return { now: NOW, feed: feedOk(), agent: AGENT_OK, numberFacts: NUMBER_OK, twilio: TWILIO_OK, ...over };
}

test("feed error: every block reports the same reason and stays honest (no fabricated zeros)", () => {
  const model = buildDashboard(baseInput({ feed: { ok: false, reason: "Agency feed rejected the token (HTTP 401)" } }));
  for (const block of [model.clients, model.callsOutcomes, model.bookings, model.transfers, model.callbacks, model.sms, model.handoffs, model.usage, model.economics, model.commercial, model.supportWorkload]) {
    expect(block.ok).toBe(false);
    if (block.ok) throw Error("unreachable");
    expect(block.reason).toBe("Agency feed rejected the token (HTTP 401)");
    expect(block.stale).toBe(true);
  }
  expect(model.exceptions).toEqual([]);
  // Channel health/agent readiness are independent of the feed and must still report.
  expect(model.agentReadiness.ok).toBe(true);
});

test("missing token: readAgencyFeed's own reason (feed not configured) flows through unchanged", () => {
  const model = buildDashboard(baseInput({ feed: { ok: false, reason: "Agency feed not configured" } }));
  expect(model.clients).toMatchObject({ ok: false, reason: "Agency feed not configured" });
});

test("stale feed: a generatedAt over 24h old marks every feed-sourced block stale", () => {
  const oldGeneratedAt = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
  const model = buildDashboard(baseInput({ feed: feedOk({ generatedAt: oldGeneratedAt }) }));
  expect(model.clients.ok).toBe(true);
  if (!model.clients.ok) throw Error("unreachable");
  expect(model.clients.stale).toBe(true);
  expect(model.clients.asOf).toBe(oldGeneratedAt);
  expect(model.bookings.stale).toBe(true);
});

test("a fresh feed (generated seconds ago) is not stale", () => {
  const model = buildDashboard(baseInput({ feed: feedOk({ generatedAt: new Date(NOW - 5000).toISOString() }) }));
  expect(model.clients).toMatchObject({ ok: true, stale: false });
});

test("zero clients and zero calls: totals are honest zeros, not nulls, and no exceptions fire", () => {
  // UI-truth M7: zeros only when the feed also reports no calls (this test used a 100-call feed).
  const feed = feedOk({ clients: [], organizations: [] });
  if (feed.ok) feed.totals.calls = 0;
  const model = buildDashboard(baseInput({ feed }));
  expect(model.clients).toMatchObject({ ok: true, rows: [] });
  expect(model.bookings).toMatchObject({ ok: true, total: 0, confirmed: 0, cancelled: 0, failed: 0, upcoming: 0, attribution: "clients" });
  expect(model.usage).toMatchObject({ ok: true, usedTotal: 0, overageMinutesTotal: 0 });
  expect(model.exceptions).toEqual([]);
  expect(model.commercial).toMatchObject({ ok: true, mrrCents: null, setupFeesCents: null, unassignedClients: 0 });
});

test("overage client: minutes/overage are computed from the assigned package's included minutes", () => {
  const clientPackages: ClientPackageMap = { "synthetic-dental": "receptionist-essential" };
  const client = syntheticClient({ minutesThisMonth: { monthStart: "2026-09-01T00:00:00Z", calls: 300, callMinutes: 500, billableMinutesCurrentPeriod: 500 } });
  const model = buildDashboard(baseInput({ feed: feedOk({ clients: [client] }), clientPackages }));
  expect(model.clients.ok).toBe(true);
  if (!model.clients.ok) throw Error("unreachable");
  const row = model.clients.rows[0];
  const pkg = getReceptionistPackage("receptionist-essential");
  expect(row.minutes).toMatchObject({ includedPerMonth: pkg.pricing.includedMinutes, usedThisMonth: 500, overageMinutes: 500 - pkg.pricing.includedMinutes, remaining: 0 });
  expect(model.usage).toMatchObject({ ok: true, includedTotal: pkg.pricing.includedMinutes, usedTotal: 500, overageMinutesTotal: 500 - pkg.pricing.includedMinutes });
  expect(model.exceptions.some((e) => e.id === "client:org_synthetic_1:minutes-overage")).toBe(true);
});

test("transfer attempted-not-confirmed becomes a warn exception, deduplicated by a stable id", () => {
  const clientPackages: ClientPackageMap = { "synthetic-dental": "receptionist-essential" };
  const client = syntheticClient({ handoffs: { transfersByStatus: { RESERVED: 1, SUBMITTED: 1 }, alertsByReason: {}, alertsByStatus: {} } });
  const model = buildDashboard(baseInput({ feed: feedOk({ clients: [client] }), clientPackages }));
  expect(model.clients.ok).toBe(true);
  if (!model.clients.ok) throw Error("unreachable");
  expect(model.clients.rows[0].transfers).toEqual({ attempted: 2, confirmed: 0, failed: 0 });
  const match = model.exceptions.filter((e) => e.id === "client:org_synthetic_1:transfer-not-confirmed");
  expect(match).toHaveLength(1);
  expect(match[0]).toMatchObject({ severity: "warn" });
  // Rebuilding the model from the same input never duplicates the exception.
  const rebuilt = buildDashboard(baseInput({ feed: feedOk({ clients: [client] }), clientPackages }));
  expect(rebuilt.exceptions.filter((e) => e.id === match[0].id)).toHaveLength(1);
});

test("SMS: the feed never carries delivery/consent/STOP counts, so the block says so explicitly instead of a fabricated zero", () => {
  const smsOnClient = syntheticClient({ readiness: { ...syntheticClient().readiness, smsEnabled: true } });
  const model = buildDashboard(baseInput({ feed: feedOk({ clients: [smsOnClient] }) }));
  expect(model.sms.ok).toBe(true);
  if (!model.sms.ok) throw Error("unreachable");
  expect(model.sms.anyEnabled).toBe(true);
  expect(model.sms.reason).toContain("not yet part of the agency feed contract");
  expect(JSON.stringify(model.sms)).not.toMatch(/"stop"\s*:\s*0/i);
});

test("deterministic economics: estimated monthly cost matches calculateEconomics run directly against the same package", () => {
  const clientPackages: ClientPackageMap = { "synthetic-dental": "receptionist-professional" };
  const client = syntheticClient({ minutesThisMonth: { monthStart: "2026-09-01T00:00:00Z", calls: 120, callMinutes: 300, billableMinutesCurrentPeriod: 300 } });
  const model = buildDashboard(baseInput({ feed: feedOk({ clients: [client] }), clientPackages }));
  expect(model.clients.ok).toBe(true);
  if (!model.clients.ok) throw Error("unreachable");
  const pkg = getReceptionistPackage("receptionist-professional");
  const expected = calculateEconomics({
    package: pkg, clients: 1, calls: [{ count: 120, seconds: Math.round((300 * 60) / 120) }],
    notificationsPerClient: 0, smsSegmentsPerClient: 0, phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
    rates: DEFAULT_COST_RATES, fx: DEFAULT_FX, gstRegistered: true,
    supportMinutesPerClient: 0, supportHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    onboardingMinutes: 0, onboardingHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    payment: DEFAULT_PAYMENT, targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
  });
  expect(model.clients.rows[0].costs.estimatedMonthlyCents).toBe(expected.variableCostCents);
  expect(model.clients.rows[0].commercial.marginCents).toBe(expected.contributionCents);
  expect(model.economics).toMatchObject({ ok: true, estimatedMonthlyCents: expected.variableCostCents });
  expect(model.commercial).toMatchObject({ ok: true, mrrCents: pkg.pricing.monthly.cents, setupFeesCents: pkg.pricing.setup.cents, unassignedClients: 0 });
});

test("an unassigned client (no local package mapping) never gets an invented cost or margin", () => {
  const model = buildDashboard(baseInput());
  expect(model.clients.ok).toBe(true);
  if (!model.clients.ok) throw Error("unreachable");
  const row = model.clients.rows[0];
  expect(row.packageId).toBeNull();
  expect(row.onboardingStatus).toBe("unassigned");
  expect(row.costs).toMatchObject({ estimatedMonthlyCents: null, measuredMonthlyCents: null, reconciledMonthlyCents: null });
  expect(row.commercial).toMatchObject({ setupFeeCents: null, mrrCents: null, marginCents: null, marginPct: null });
  expect(model.commercial).toMatchObject({ ok: true, mrrCents: null, setupFeesCents: null, unassignedClients: 1 });
});

test("go-live: the live-line capability mismatch stays visible until the demo line proves booking", () => {
  const notLive = buildDashboard(baseInput({ feed: feedOk({ clients: [syntheticClient({ isDemoTenant: true, readiness: { ...syntheticClient().readiness, bookingOutcome: "test_booking_only" } })] }) }));
  expect(notLive.goLive.liveLineMismatch).toMatchObject({ visible: true, resolved: false });
  const live = buildDashboard(baseInput({ feed: feedOk({ clients: [syntheticClient({ isDemoTenant: true })] }) }));
  expect(live.goLive.liveLineMismatch).toMatchObject({ visible: true, resolved: true });
  const noDemoClient = buildDashboard(baseInput({ feed: feedOk({ clients: [syntheticClient({ isDemoTenant: false })] }) }));
  expect(noDemoClient.goLive.liveLineMismatch).toMatchObject({ visible: true, resolved: false });
});

test("go-live steps mirror the checklist doc's 14 steps (0 through 13) with an honest 'unknown' default", () => {
  const model = buildDashboard(baseInput());
  expect(model.goLive.steps).toHaveLength(14);
  expect(model.goLive.steps.map((s) => s.step)).toEqual([...Array(14).keys()]);
  expect(model.goLive.steps.find((s) => s.id === "preflight")?.status).toBe("unknown");
});

test("channel health degrades to unknown, not ok, when the provider read failed", () => {
  const model = buildDashboard(baseInput({ agent: { ok: false, reason: "Retell not configured" }, twilio: { ok: false, reason: "Twilio not configured" } }));
  expect(model.channelHealth).toMatchObject({ ok: true, retell: "unknown", twilio: "unknown", webhook: "unknown" });
  expect(model.agentReadiness).toMatchObject({ ok: false, reason: "Retell not configured" });
});

// ── Stage A fixes (27 Sep): zero / unknown / stale / failed, read times, not edit times ─────────

test("staleness is judged against input.now, never the machine clock", () => {
  // Far in the past: with Date.now() this feed would look years stale.
  const past = Date.parse("2020-01-01T12:00:00Z");
  const fresh = buildDashboard(baseInput({ now: past, providersReadAt: past, feed: feedOk({ generatedAt: new Date(past - 60 * 60 * 1000).toISOString() }) }));
  expect(fresh.clients).toMatchObject({ ok: true, stale: false });
  expect(fresh.bookings).toMatchObject({ ok: true, stale: false });
  // Far in the future: with Date.now() this day-old feed would look fresh.
  const future = Date.parse("2031-01-01T12:00:00Z");
  const old = buildDashboard(baseInput({ now: future, providersReadAt: future, feed: feedOk({ generatedAt: new Date(future - 25 * 60 * 60 * 1000).toISOString() }) }));
  expect(old.clients).toMatchObject({ ok: true, stale: true });
  expect(old.clients.staleAfterMs).toBe(FEED_STALE_MS);
});

test("agent readiness: asOf is the read time; an agent unedited for 10 days is not stale, only noted", () => {
  const readAt = NOW - 30_000;
  const agent = { ...AGENT_OK, modified: new Date(NOW - 10 * 86_400_000).toISOString() };
  const model = buildDashboard(baseInput({ agent, providersReadAt: readAt }));
  expect(model.agentReadiness.ok).toBe(true);
  if (!model.agentReadiness.ok) throw Error("unreachable");
  expect(model.agentReadiness.asOf).toBe(new Date(readAt).toISOString());
  expect(model.agentReadiness.stale).toBe(false);
  expect(model.agentReadiness.staleAfterMs).toBe(PROVIDER_STALE_MS);
  expect(model.agentReadiness.agentLastEditedAt).toBe(agent.modified);
  expect(model.agentReadiness.agentEditNote).toBe("Agent last edited 10 d ago");
  const unknownEdit = buildDashboard(baseInput({ agent: { ...AGENT_OK, modified: undefined } }));
  expect(unknownEdit.agentReadiness).toMatchObject({ ok: true, agentLastEditedAt: null, agentEditNote: "Agent edit time unknown", stale: false });
});

test("agent readiness and channel health go stale when the provider READ is old, and carry the read time", () => {
  const readAt = NOW - PROVIDER_STALE_MS - 60_000;
  const model = buildDashboard(baseInput({ providersReadAt: readAt }));
  expect(model.agentReadiness).toMatchObject({ ok: true, stale: true, asOf: new Date(readAt).toISOString() });
  expect(model.channelHealth).toMatchObject({ ok: true, stale: true, asOf: new Date(readAt).toISOString() });
  const recent = buildDashboard(baseInput({ providersReadAt: NOW - 1000 }));
  expect(recent.channelHealth).toMatchObject({ ok: true, stale: false, asOf: new Date(NOW - 1000).toISOString() });
  // A pure caller with no read time: the build time, never the wall clock.
  expect(buildDashboard(baseInput()).channelHealth.asOf).toBe(new Date(NOW).toISOString());
  // RX-7 (intended change): a failed read carries the last SUCCESSFUL read time, never its own
  // attempt time (which read as "Updated just now"); null when no read ever succeeded.
  const failed = buildDashboard(baseInput({ agent: { ok: false, reason: "Retell unreachable (TimeoutError)" }, providersReadAt: readAt }));
  expect(failed.agentReadiness).toMatchObject({ ok: false, asOf: null, stale: true });
  const lastGood = NOW - 20 * 60_000;
  const failedAfterGood = buildDashboard(baseInput({ agent: { ok: false, reason: "Retell unreachable (TimeoutError)" }, providersReadAt: NOW, lastGoodReadAt: { retell: lastGood } }));
  expect(failedAfterGood.agentReadiness).toMatchObject({ ok: false, asOf: new Date(lastGood).toISOString(), stale: true });
});

test("webhook: not probed is unknown, not ok; only a protected probe is ok", () => {
  const { webhookProbe: _drop, ...unprobed } = AGENT_OK;
  expect(buildDashboard(baseInput({ agent: unprobed })).channelHealth).toMatchObject({ ok: true, webhook: "unknown" });
  expect(buildDashboard(baseInput()).channelHealth).toMatchObject({ webhook: "ok" });
  expect(buildDashboard(baseInput({ agent: { ...AGENT_OK, webhookProbe: "open" } })).channelHealth).toMatchObject({ webhook: "bad" });
  expect(buildDashboard(baseInput({ agent: { ...AGENT_OK, webhook: false } })).channelHealth).toMatchObject({ webhook: "bad" });
});

test("callbacks: a triage counter the feed didn't report is unknown (null), never 0", () => {
  const feed = feedOk();
  if (!feed.ok) throw Error("unreachable");
  const unreported = { ...feed, totals: { ...feed.totals, triagePending: null, triageDone: null } };
  const model = buildDashboard(baseInput({ feed: unreported }));
  expect(model.callbacks).toMatchObject({ ok: true, pending: null, done: null });
  if (!model.callbacks.ok) throw Error("unreachable");
  expect(tileState(model.callbacks, model.callbacks.pending, NOW)).toBe("unknown");
  const reported = buildDashboard(baseInput());
  expect(reported.callbacks).toMatchObject({ ok: true, pending: 2, done: 8 });
  const zero = buildDashboard(baseInput({ feed: { ...feed, totals: { ...feed.totals, triagePending: 0 } } }));
  if (!zero.callbacks.ok) throw Error("unreachable");
  expect(tileState(zero.callbacks, zero.callbacks.pending, NOW)).toBe("zero");
});

test("feed down: exceptions are 'failed', never '0 open'; SMS and number facts are unknown, not off", () => {
  const model = buildDashboard(baseInput({ feed: { ok: false, reason: "Agency feed unreachable (TimeoutError)" }, numberFacts: { ok: false, reason: "Retell number response invalid" } }));
  expect(model.exceptions).toEqual([]);
  expect(model.exceptionSummary).toMatchObject({ ok: false, reason: "Agency feed unreachable (TimeoutError)" });
  expect(tileState(model.exceptionSummary, null, NOW)).toBe("failed");
  expect(tileState(model.exceptionSummary, 0, NOW)).toBe("failed");
  expect(model.channelHealth).toMatchObject({ ok: true, smsAnyClientEnabled: null });
  expect(model.agentReadiness).toMatchObject({ ok: true, numberAttached: null });
  // With the feed up and nothing wrong, the summary is a real zero.
  const clean = buildDashboard(baseInput({ feed: feedOk({ generatedAt: new Date(NOW - 5000).toISOString() }) }));
  expect(clean.exceptionSummary).toMatchObject({ ok: true, count: 0, critical: 0 });
  if (!clean.exceptionSummary.ok) throw Error("unreachable");
  expect(tileState(clean.exceptionSummary, clean.exceptionSummary.count, NOW)).toBe("zero");
});

test("tile state separates ok / zero / unknown / stale / failed", () => {
  const fresh = buildDashboard(baseInput({ feed: feedOk({ generatedAt: new Date(NOW - 5000).toISOString() }) }));
  expect(tileState(fresh.bookings, 3, NOW)).toBe("ok");
  expect(tileState(fresh.bookings, 0, NOW)).toBe("zero");
  expect(tileState(fresh.bookings, null, NOW)).toBe("unknown");
  expect(tileState(fresh.bookings, Number.NaN, NOW)).toBe("unknown");
  // The viewer's clock moves on: a block fresh at build time turns stale without a rebuild.
  expect(tileState(fresh.bookings, 0, NOW + FEED_STALE_MS + 1)).toBe("stale");
  expect(blockIsStale(fresh.bookings, NOW + FEED_STALE_MS + 1)).toBe(true);
  const failed = buildDashboard(baseInput({ feed: { ok: false, reason: "Agency feed returned HTTP 502" } }));
  expect(tileState(failed.bookings, 0, NOW)).toBe("failed");
});

test("recovery: the next step names retry or the System token check, from the failure reason", () => {
  const unreachable = buildDashboard(baseInput({ feed: { ok: false, reason: "Agency feed unreachable (request failed)" } }));
  expect(tileRecovery(unreachable.clients, "failed")).toEqual({ kind: "retry", label: "Feed unreachable, retry" });
  const http502 = buildDashboard(baseInput({ feed: { ok: false, reason: "Agency feed returned HTTP 502" } }));
  expect(tileRecovery(http502.clients, "failed")).toEqual({ kind: "retry", label: "Feed unreachable, retry" });
  for (const reason of ["Agency feed rejected the token (HTTP 401)", "Agency feed not configured", "Agency feed URL invalid"]) {
    const model = buildDashboard(baseInput({ feed: { ok: false, reason } }));
    expect(tileRecovery(model.exceptionSummary, "failed")).toEqual({ kind: "system", label: "Check the agency feed token in System" });
  }
  const noRetell = buildDashboard(baseInput({ agent: { ok: false, reason: "Retell not configured" } }));
  expect(tileRecovery(noRetell.agentReadiness, "failed")).toEqual({ kind: "system", label: "Check the provider keys in System" });
  const retellDown = buildDashboard(baseInput({ agent: { ok: false, reason: "Retell unreachable (TimeoutError)" } }));
  expect(tileRecovery(retellDown.agentReadiness, "failed")).toEqual({ kind: "retry", label: "Read failed, retry" });
  const fresh = buildDashboard(baseInput());
  expect(tileRecovery(fresh.bookings, "ok")).toBeNull();
  expect(tileRecovery(fresh.bookings, "zero")).toBeNull();
  expect(tileRecovery(fresh.bookings, "stale")).toEqual({ kind: "retry", label: "Feed is stale, refresh" });
  expect(tileRecovery(fresh.channelHealth, "stale")).toEqual({ kind: "retry", label: "Read is stale, refresh" });
  expect(tileRecovery(fresh.callbacks, "unknown")?.kind).toBe("retry");
});

test("lineSource flows into agent readiness so a legacy demo-line fallback is visible", () => {
  expect(buildDashboard(baseInput({ lineSource: "legacy-demo-default" })).agentReadiness).toMatchObject({ ok: true, lineSource: "legacy-demo-default" });
  expect(buildDashboard(baseInput()).agentReadiness).toMatchObject({ ok: true, lineSource: null });
  expect(ageText(null, NOW)).toBeNull();
  expect(ageText(new Date(NOW - 90 * 60_000).toISOString(), NOW)).toBe("1 h ago");
});
