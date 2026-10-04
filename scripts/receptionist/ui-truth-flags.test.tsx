// UI-truth H4 + M7 (28 Sep 2026). H4: every production-QA flag from the agency feed — attributed to
// a client or not — reaches Flagged calls and Exceptions, merged with the local flags by call (one
// entry per call, never double counted). M7: with no client rows but calls in the feed, bookings and
// transfers are "not attributed" (unknown), never 0.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildReceptionistSnapshot } from "./aggregate";
import { call, inputs, NOW } from "./aggregate.test";
import { buildDashboard, NOT_ATTRIBUTED_HINT, tileState, type DashboardInput } from "./dashboard";
import type { AgencyFeedState, FeedCall, FeedData } from "./types";
import { projectReceptionist } from "../workspace/projections";
import { todayFacts } from "../../src/components/shell/today-facts";
import { mergeSellExceptions } from "../../src/components/receptionist/dashboard/sell-exceptions";
import { FlaggedCalls } from "../../src/components/receptionist/dashboard/sell-status";
import { CallsAndBookings } from "../../src/components/receptionist/dashboard/calls-bookings";
import { DashboardRetryProvider } from "../../src/components/receptionist/dashboard/shared";

// The live shape of 28 Sep: one organisation, NO clients[], qaCriticalOpen 1 for the call ending 615,
// which Retell flagged URGENT_NO_000 and production QA flagged TRANSFER_PROMISED_NOT_ATTEMPTED + URGENT_CALL.
const CALL_ID = "call_12b9597804d1a656cb61caec263";
const STARTED = new Date(NOW - 3_600_000).toISOString();
function feedCall(over: Partial<FeedCall> = {}): FeedCall {
  return {
    id: "cmuiddz8r000104lcs42b67vn", organizationId: "org_live", providerCallId: CALL_ID, callType: "phone", status: "COMPLETED",
    outcome: "ENQUIRY_ANSWERED", sentiment: "NEUTRAL", callerMasked: "••• 615", startedAt: STARTED, endedAt: null, durationSeconds: 150,
    disconnectionReason: null, summary: null,
    qa: { flagCount: 2, topBand: "FLAG", reviewStatus: "PENDING", flagCodes: ["TRANSFER_PROMISED_NOT_ATTEMPTED", "URGENT_CALL"] },
    ...over,
  };
}
function liveFeed(over: Partial<FeedData> = {}): AgencyFeedState {
  return {
    ok: true, generatedAt: new Date(NOW - 60_000).toISOString(), windowDays: 30, view: "full",
    organizations: [{ id: "org_live", name: "M&U demo line", niche: "DENTAL", isDemoTenant: false, inboundNumberMasked: "••• 208" }],
    totals: { calls: 3, completed: 2, failed: 1, avgDurationSeconds: 140, totalMinutes: 5, byOutcome: [], bySentiment: [], qaGraded: 2, qaFlagged: 1, qaCriticalOpen: 1, triagePending: 1, triageDone: 0, oldestPendingTriageAt: STARTED },
    calls: [feedCall()], followUps: [], clients: [], deployment: null,
    ...over,
  };
}
const localFlagged = () => call({ id: CALL_ID, startedAt: STARTED, from: "+61400000615", flags: ["URGENT_NO_000"] });

describe("H4: every production QA flag reaches Flagged calls, one entry per call", () => {
  test("a Retell-flagged call that production QA also flagged is ONE incident carrying every code", () => {
    const i = inputs([localFlagged()]);
    i.agencyFeed = liveFeed();
    const s = buildReceptionistSnapshot(i, NOW);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents[0]).toMatchObject({
      callId: CALL_ID,
      flags: ["URGENT_NO_000"],
      qaCodes: ["TRANSFER_PROMISED_NOT_ATTEMPTED", "URGENT_CALL"],
      qaReview: "PENDING",
      qaCritical: true,
      client: null, // the feed has no clients[]: not attributed to a client
      sources: ["retell", "production QA"],
    });
    expect(s.incidents[0].consequence).toContain("was promised a transfer that was never attempted");
    expect(check(s, "flagged-calls")).toMatchObject({ ok: false, detail: "1 flagged call to follow up" });
    expect(check(s, "feed-qa").ok).toBe(false);
  });

  test("a call only production QA flagged (no Retell id, unattributed) still appears, once", () => {
    const i = inputs([]);
    i.agencyFeed = liveFeed({ calls: [feedCall({ providerCallId: null, id: "fc_only" })] });
    const s = buildReceptionistSnapshot(i, NOW);
    expect(s.incidents.map((x) => [x.callId, x.flags, x.qaCodes, x.client, x.retellUrl])).toEqual([["feed:fc_only", [], ["TRANSFER_PROMISED_NOT_ATTEMPTED", "URGENT_CALL"], null, ""]]);
    expect(s.verdict.decision).toBe("Not safe to sell");
  });

  test("no feed Retell id: the same masked caller within 2 minutes is the same call", () => {
    const i = inputs([localFlagged()]);
    i.agencyFeed = liveFeed({ calls: [feedCall({ providerCallId: null, startedAt: new Date(Date.parse(STARTED) + 60_000).toISOString() })] });
    const s = buildReceptionistSnapshot(i, NOW);
    expect(s.incidents.map((x) => x.callId)).toEqual([CALL_ID]);
  });

  test("a non-urgent, non-critical QA flag is still surfaced (all codes, not only urgent ones)", () => {
    const i = inputs([]);
    i.agencyFeed = liveFeed({ calls: [feedCall({ qa: { flagCount: 1, topBand: "REVIEW", reviewStatus: "PENDING", flagCodes: ["BOOKING_NO_PROVIDER_REF"] } })] });
    const s = buildReceptionistSnapshot(i, NOW);
    expect(s.incidents.map((x) => x.qaCodes)).toEqual([["BOOKING_NO_PROVIDER_REF"]]);
    expect(s.incidents[0].qaCritical).toBe(false);
  });

  test("a REVIEWED production QA flag is closed and not listed", () => {
    const i = inputs([]);
    i.agencyFeed = liveFeed({ calls: [feedCall({ qa: { flagCount: 2, topBand: "FLAG", reviewStatus: "REVIEWED", flagCodes: ["TRANSFER_PROMISED_NOT_ATTEMPTED"] } })] });
    expect(buildReceptionistSnapshot(i, NOW).incidents).toEqual([]);
  });

  test("an attributed call names its client", () => {
    const i = inputs([]);
    const f = liveFeed();
    if (f.ok) f.clients = [{ organizationId: "org_live", slug: "mu-demo-line", isDemoTenant: true, bookings: { byStatus: {}, total: 0, madeOnCalls: 0, sandbox: 0, upcoming: 0 }, handoffs: { transfersByStatus: {}, alertsByReason: {}, alertsByStatus: {} }, minutesThisMonth: { monthStart: null, calls: 0, callMinutes: 0, billableMinutesCurrentPeriod: 0 }, readiness: { agentMapped: true, inboundNumberSet: true, calendarRequested: null, calendarInUse: null, calendarReason: null, liveCalendar: false, demoDiaryConfirmed: false, bookingOutcome: null, alertMailboxSet: false, transferEnabled: false, smsEnabled: false, retentionDays: null, retellRetentionAligned: "unverified", goLive: null } }];
    i.agencyFeed = f;
    expect(buildReceptionistSnapshot(i, NOW).incidents[0].client).toBe("M&U demo line");
  });

  test("marking the call followed up can't close production QA's open review: still one open entry", () => {
    const i = inputs([localFlagged()]);
    i.agencyFeed = liveFeed();
    i.followedUp = { [CALL_ID]: { by: "Usman", at: new Date(NOW - 60_000).toISOString() } };
    const s = buildReceptionistSnapshot(i, NOW);
    expect(s.incidents.map((x) => [x.callId, x.followedUp?.by])).toEqual([[CALL_ID, "Usman"]]);
    expect(s.awaitingRetest).toEqual([]); // listed once, in incidents
  });

  test("Exceptions: the feed's aggregate QA row is replaced by the per-call row (never both)", () => {
    const i = inputs([localFlagged()]);
    i.agencyFeed = liveFeed();
    const snap = buildReceptionistSnapshot(i, NOW);
    const model = buildDashboard(dashInput(liveFeed({ view: "metadata", calls: [] })));
    expect(model.exceptions.map((e) => e.id)).toContain("feed:qa-critical-open");
    expect(model.exceptions.find((e) => e.id === "feed:qa-critical-open")?.title).toContain("not attributed to a client");
    const merged = mergeSellExceptions({ items: model.exceptions, summary: model.exceptionSummary }, { data: snap, error: null, isLoading: false });
    expect(merged.items.filter((x) => x.id === "feed:qa-critical-open")).toEqual([]);
    const rows = merged.items.filter((x) => x.id === CALL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("Transfer promised, not attempted");
    expect(rows[0].title).toContain("Urgent, no 000");
    expect(rows[0].title).toContain("not attributed to a client");
    // Without the per-call sell status, the aggregate row stays (a count, never hidden).
    const alone = mergeSellExceptions({ items: model.exceptions, summary: model.exceptionSummary }, { data: undefined, error: new Error("down"), isLoading: false });
    expect(alone.items.map((x) => x.id)).toContain("feed:qa-critical-open");
  });

  test("Flagged calls renders QA labels, attribution, and no follow-up button for a feed-only id", () => {
    const i = inputs([localFlagged()]);
    i.agencyFeed = liveFeed({ calls: [feedCall(), feedCall({ id: "fc_only", providerCallId: null, callerMasked: "••• 777", startedAt: new Date(NOW - 7_200_000).toISOString() })] });
    const s = buildReceptionistSnapshot(i, NOW);
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><FlaggedCalls incidents={s.incidents} /></QueryClientProvider>);
    expect(html.match(/data-flagged-call=/g)).toHaveLength(2);
    expect(html).toContain("Transfer promised, not attempted");
    expect(html).toContain("Urgent, no 000");
    expect(html).toContain("not attributed to a client");
    expect(html).not.toMatch(/>TRANSFER_PROMISED_NOT_ATTEMPTED</); // labels, not raw codes, as text
    expect(html.match(/Mark followed up/g)).toHaveLength(1); // only the Retell call id can be followed up locally
  });

  test("Workspace + Today: the panel's incident carries every code and the Today line counts it", () => {
    const i = inputs([localFlagged()]);
    i.agencyFeed = liveFeed();
    const panel = projectReceptionist(JSON.parse(JSON.stringify(buildReceptionistSnapshot(i, NOW))));
    expect(panel.incidents[0].flags).toEqual(["URGENT_NO_000", "TRANSFER_PROMISED_NOT_ATTEMPTED", "URGENT_CALL"]);
    expect(panel.urgent).toHaveLength(1);
    expect(panel.urgent[0].codes).toContain("TRANSFER_PROMISED_NOT_ATTEMPTED");
    // A non-urgent flagged call still reaches Today's exceptions.
    const calm = { ...panel, urgent: [], incidents: [{ callId: "c1", startedAt: null, from: null, flags: ["BOOKING_NO_PROVIDER_REF"] }] };
    const facts = todayFacts({ receptionist: { data: { ok: true, data: calm } as never } });
    expect(facts.exceptions.find((e) => e.id === "urgent")?.text).toBe("1 flagged receptionist call to follow up");
  });
});

function check(s: ReturnType<typeof buildReceptionistSnapshot>, id: string) {
  return s.verdict.checks!.find((c) => c.id === id)!;
}

const dashInput = (feed: AgencyFeedState): DashboardInput => ({
  now: NOW,
  providersReadAt: NOW,
  feed,
  agent: { ok: true, name: "A", voice: "v", language: "en-AU", model: "m", published: true, webhook: true, webhookHost: "x.test", webhookProbe: "protected", modified: undefined, prompt000: true, disclosure: true, recording: true, overseas: true, transfer: false, promptKnown: true },
  numberFacts: { ok: true, attached: true, version: 1, sms: false },
  twilio: { ok: true, connected: true, trunkSid: "TK", balanceUsd: 20, month: { ok: true, usd: 1, balanceUsd: 20 } },
});

describe("M7: no client rows but calls in the feed: not attributed, never 0", () => {
  test("bookings, transfers, handoffs and usage are unknown with attribution 'not-attributed'", () => {
    const model = buildDashboard(dashInput(liveFeed({ view: "metadata", calls: [] })));
    expect(model.bookings).toMatchObject({ ok: true, total: null, confirmed: null, cancelled: null, failed: null, upcoming: null, attribution: "not-attributed" });
    expect(model.transfers).toMatchObject({ ok: true, attempted: null, confirmed: null, failed: null, attribution: "not-attributed" });
    expect(model.handoffs).toMatchObject({ ok: true, pending: null, failed: null, attribution: "not-attributed" });
    expect(model.usage).toMatchObject({ ok: true, usedTotal: null, includedTotal: null, overageMinutesTotal: null });
    if (model.transfers.ok) expect(tileState(model.transfers, model.transfers.attempted, NOW)).toBe("unknown");
  });

  test("an unreported call count is not attributed either; a feed reporting 0 calls keeps real zeros", () => {
    const unreported = liveFeed({ view: "metadata", calls: [] });
    if (unreported.ok) unreported.totals.calls = null;
    expect(buildDashboard(dashInput(unreported)).bookings).toMatchObject({ total: null, attribution: "not-attributed" });
    const none = liveFeed({ view: "metadata", calls: [] });
    if (none.ok) { none.totals.calls = 0; none.totals.qaCriticalOpen = 0; }
    expect(buildDashboard(dashInput(none)).transfers).toMatchObject({ attempted: 0, confirmed: 0, failed: 0, attribution: "clients" });
  });

  test("the Transfers tiles read 'Unknown' with the not-attributed reason, never 0", () => {
    const model = buildDashboard(dashInput(liveFeed({ view: "metadata", calls: [] })));
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/receptionist"] }) });
    const html = renderToStaticMarkup(
      <RouterContextProvider router={router}><DashboardRetryProvider value={() => {}}><CallsAndBookings data={model} /></DashboardRetryProvider></RouterContextProvider>,
    );
    const transfers = html.slice(html.indexOf(">Transfers<"), html.indexOf(">Callbacks / handoffs<"));
    expect(transfers.length).toBeGreaterThan(100);
    expect(transfers).toContain(NOT_ATTRIBUTED_HINT);
    expect(transfers).not.toMatch(/>0</);
  });
});
