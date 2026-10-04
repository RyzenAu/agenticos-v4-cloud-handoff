// REVIEW-RECEPTIONIST-R3 F11 (Track 8): the feed adds alert reasons NOT_LIVE_CALL and GO_LIVE_DRIFT
// and a `lead` capability. The OS kept five known alert reasons and dropped the rest, so these could
// never show. Every reason is kept; known ones are labelled, unknown ones are shown by code.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { projectAgencyFeed } from "./agency-feed";
import { alertReasonLabel, alertReasonRows, buildDashboard, type DashboardInput } from "./dashboard";
import { CallsAndBookings } from "../../src/components/receptionist/dashboard/calls-bookings";
import { DashboardRetryProvider } from "../../src/components/receptionist/dashboard/shared";

const NOW = Date.parse("2026-09-28T06:00:00Z");
const feedBody = (alertsByReason: unknown, goLive: unknown = null) => ({
  version: 1,
  generatedAt: new Date(NOW - 60_000).toISOString(),
  view: "metadata",
  totals: { calls: 4, completed: 4, failed: 0 },
  calls: [],
  followUps: [],
  organizations: [{ id: "org_syn_1", name: "Harbourview Dental (synthetic)", isDemoTenant: false }],
  clients: [
    {
      organizationId: "org_syn_1",
      slug: "synthetic-dental",
      isDemoTenant: false,
      bookings: { byStatus: {}, total: 0, madeOnCalls: 0, sandbox: 0, upcoming: 0 },
      handoffs: { transfersByStatus: {}, alertsByReason, alertsByStatus: { SENT: 3 } },
      minutesThisMonth: { monthStart: "2026-09-01T00:00:00Z", calls: 4, callMinutes: 8, billableMinutesCurrentPeriod: 8 },
      readiness: { agentMapped: true, inboundNumberSet: true, goLive: { ready: false, blockers: ["lead"] } },
    },
  ],
  goLive,
});

describe("F11: every alert reason reaches the page", () => {
  test("the projection keeps new and unknown reasons, and still rejects junk keys and counts", () => {
    const state = projectAgencyFeed(feedBody({ CALLBACK_REQUEST: 1, NOT_LIVE_CALL: 2, GO_LIVE_DRIFT: 1, SOMETHING_NEW: 5, "bad key<script>": 9, NEGATIVE: -1, TEXT: "7" }));
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.clients[0].handoffs.alertsByReason).toEqual({ CALLBACK_REQUEST: 1, NOT_LIVE_CALL: 2, GO_LIVE_DRIFT: 1, SOMETHING_NEW: 5 });
  });

  test("known reasons get labels (including the two new ones); an unknown one is 'Unrecognised alert: <code>'", () => {
    expect(alertReasonLabel("NOT_LIVE_CALL")).toEqual({ label: "Real call on a line that isn't marked live", known: true });
    expect(alertReasonLabel("GO_LIVE_DRIFT")).toEqual({ label: "Go-live setup changed since it was tested", known: true });
    expect(alertReasonLabel("SOMETHING_NEW")).toEqual({ label: "Unrecognised alert: SOMETHING_NEW", known: false });
    const { rows, partial } = alertReasonRows([{ NOT_LIVE_CALL: 2, SOMETHING_NEW: 1 }, { NOT_LIVE_CALL: 1 }, null]);
    expect(rows.map((r) => [r.reason, r.count])).toEqual([["NOT_LIVE_CALL", 3], ["SOMETHING_NEW", 1]]);
    expect(partial).toBe(true); // a client that sent no record: counts are "at least"
  });

  test("the Receptionist page lists every reason, the unrecognised one included", () => {
    const state = projectAgencyFeed(feedBody({ CALLBACK_REQUEST: 1, NOT_LIVE_CALL: 2, GO_LIVE_DRIFT: 1, SOMETHING_NEW: 5 }));
    const input: DashboardInput = {
      now: NOW, providersReadAt: NOW, feed: state,
      agent: { ok: false, reason: "not read" } as never,
      numberFacts: { ok: false, reason: "not read" } as never,
      twilio: { ok: false, reason: "not read" } as never,
    };
    const model = buildDashboard(input);
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/receptionist"] }) });
    const html = renderToStaticMarkup(
      <RouterContextProvider router={router}>
        <DashboardRetryProvider value={() => {}}>
          <CallsAndBookings data={model} />
        </DashboardRetryProvider>
      </RouterContextProvider>,
    );
    const list = html.slice(html.indexOf("data-alert-reasons"), html.indexOf("</ul>", html.indexOf("data-alert-reasons")));
    for (const label of ["Callback requests", "Real call on a line that isn&#x27;t marked live", "Go-live setup changed since it was tested", "Unrecognised alert: SOMETHING_NEW"])
      expect(list).toContain(label);
  });

  test("`lead` in a client's go-live blockers and the per-client missing list is kept", () => {
    const state = projectAgencyFeed(feedBody({}, { verdict: "not-safe", perClient: [{ orgId: "org_syn_1", verdict: "not-safe", missing: ["lead", "booking"], blockers: ["lead"] }] }));
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.clients[0].readiness.goLive).toEqual({ ready: false, blockers: ["lead"] });
    expect(state.goLive?.perClient[0]).toMatchObject({ missing: ["lead", "booking"], blockers: ["lead"] });
  });
});
