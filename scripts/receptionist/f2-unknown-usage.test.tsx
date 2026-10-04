// AUDIT-F2 RX-2, RX-3, RX-9: a client row the feed sends without minutes, bookings or handoffs is
// unknown, never zeros; no margin, overage or support figure is built from made-up zeros; and an
// unknown caused by setup (no package) doesn't offer a retry. SYNTHETIC data only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { projectAgencyFeed } from "./agency-feed";
import { buildDashboard } from "./dashboard";
import { buildUsageEconomics } from "./usage-economics";
import { getReceptionistPackage } from "../../src/lib/receptionist-packages";
import { UsageAndEconomics } from "../../src/components/receptionist/dashboard/usage-economics";
import { DashboardRetryProvider } from "../../src/components/receptionist/dashboard/shared";

const NOW = Date.parse("2026-09-27T06:00:00Z");
const readiness = { agentMapped: true, inboundNumberSet: true, liveCalendar: true, smsEnabled: false, bookingOutcome: "confirmed" };
// The audit's "nulls" scenario: a client row with no minutesThisMonth, bookings or handoffs.
const raw = (clients: unknown[]) => ({
  version: 1, generatedAt: "2026-09-27T05:00:00.000Z", windowDays: 30, view: "metadata",
  organizations: [{ id: "org_h", name: "Harbourview (fictional)", slug: "harbourview", niche: "DENTAL", isDemoTenant: false }],
  totals: { calls: 12, completed: 12, failed: 0, totalMinutes: 30, byOutcome: [], bySentiment: [] },
  calls: [], followUps: [], clients,
});
const nulls = projectAgencyFeed(raw([{ organizationId: "org_h", slug: "harbourview", readiness }]));
const partial = projectAgencyFeed(raw([{ organizationId: "org_h", slug: "harbourview", readiness, minutesThisMonth: { calls: 12 }, bookings: { total: 3 } }]));
const dash = (feed: ReturnType<typeof projectAgencyFeed>, pkgs: Record<string, "receptionist-professional"> = { harbourview: "receptionist-professional" }) => buildDashboard({
  now: NOW, feed, agent: { ok: false, reason: "x" }, numberFacts: { ok: false, reason: "x" },
  twilio: { ok: false, reason: "Twilio not configured" }, clientPackages: pkgs,
});

describe("RX-2: unreported client blocks are unknown, never zeros", () => {
  test("the projection keeps a missing or incomplete block as null", () => {
    for (const f of [nulls, partial]) {
      if (!f.ok) throw new Error(f.reason);
      expect(f.clients[0]).toMatchObject({ minutesThisMonth: null, bookings: null });
    }
    if (!nulls.ok) throw new Error("x");
    expect(nulls.clients[0].handoffs).toBeNull();
    // A reported block with an empty count map is still a real zero.
    const reported = projectAgencyFeed(raw([{ organizationId: "org_h", readiness, handoffs: { transfersByStatus: {}, alertsByReason: {}, alertsByStatus: {} } }]));
    if (!reported.ok) throw new Error("x");
    expect(reported.clients[0].handoffs).toEqual({ transfersByStatus: {}, alertsByReason: {}, alertsByStatus: {} });
  });
  test("no margin from made-up zeros: the audit's A$1,060.24 is now 'Margin unknown: usage missing'", () => {
    const d = dash(nulls);
    if (!d.clients.ok || !d.usage.ok || !d.bookings.ok || !d.transfers.ok || !d.handoffs.ok || !d.economics.ok) throw new Error("blocks should be ok");
    const row = d.clients.rows[0];
    expect(row.minutes).toMatchObject({ usedThisMonth: null, billableCurrentPeriod: null, overageMinutes: null, remaining: null });
    expect(row).toMatchObject({ bookings: null, transfers: null, handoffs: null });
    expect(row.commercial).toMatchObject({ marginCents: null, marginPct: null, caveat: "Margin unknown: usage missing." });
    expect(row.costs.estimatedMonthlyCents).toBeNull();
    expect(JSON.stringify(row)).not.toContain("106024");
    expect(d.usage).toMatchObject({ usedTotal: null, overageMinutesTotal: null });
    expect(d.bookings).toMatchObject({ total: null, confirmed: null });
    expect(d.transfers).toMatchObject({ attempted: null });
    expect(d.handoffs).toMatchObject({ pending: null, failed: null });
    expect(d.economics.estimatedMonthlyCents).toBeNull();
  });
  test("the three-basis economics say usage is missing, on every basis", () => {
    const e = buildUsageEconomics({
      now: NOW, feed: nulls, packageFor: () => getReceptionistPackage("receptionist-professional"),
      retell: { ok: true, rows: [] }, retellReadAt: null, attribution: null, twilioMonth: { ok: false, reason: "x" }, twilioReadAt: null, receipts: null, ledger: { state: "none-imported" },
    });
    if (!e.ok) throw new Error(e.reason);
    const c = e.clients[0];
    expect(c.usage).toMatchObject({ calls: null, billableMinutes: null });
    expect(c.revenue.cents).toBeNull();
    for (const f of [c.estimated, c.measured]) expect(f).toMatchObject({ cents: null, marginBps: null, notes: ["Margin unknown: usage missing (the feed didn't report this client's minutes)."] });
    const pro = e.tiers.find((t) => t.packageId === "receptionist-professional")!;
    expect(pro.revenue.cents).toBeNull();
  });
});

describe("RX-3 and RX-9: overage and support are unknown, not 0, and setup unknowns offer no retry", () => {
  test("support minutes are unknown with no package assigned (was 0)", () => {
    const d = dash(nulls, {});
    if (!d.supportWorkload.ok || !d.usage.ok) throw new Error("x");
    expect(d.supportWorkload.assumedMinutesTotal).toBeNull();
    expect(d.supportWorkload.caveat).toContain("no package assigned");
    expect(d.usage.overageMinutesTotal).toBeNull();
  });
  test("rendered: Unknown with the reason, no 'Not reported, retry' on setup unknowns", () => {
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/receptionist"] }) });
    const html = renderToStaticMarkup(<RouterContextProvider router={router}><DashboardRetryProvider value={() => {}}><UsageAndEconomics data={dash(nulls, {})} /></DashboardRetryProvider></RouterContextProvider>);
    expect(html).toContain("Unknown: a client has no package assigned");
    const support = html.slice(html.indexOf("Assumed support minutes"));
    expect(support).not.toContain("Not reported, retry");
    expect(support).not.toMatch(/>0</);
  });
});

describe("RX-11 and RX-12", () => {
  test("RX-11: niches read as words, never the raw enum", async () => {
    const { nicheLabel } = await import("../../src/components/receptionist/dashboard/clients-table");
    expect(nicheLabel("REAL_ESTATE")).toBe("Real estate");
    expect(nicheLabel("DENTAL")).toBe("Dental");
    expect(nicheLabel(null)).toBe("—");
  });
  test("RX-12: Retell measured with Twilio unreadable is a Retell-only floor, not Unknown", () => {
    const feed = projectAgencyFeed(raw([{ organizationId: "org_h", slug: "harbourview", readiness, minutesThisMonth: { calls: 1, callMinutes: 2, billableMinutesCurrentPeriod: 2 } }]));
    const d = buildDashboard({
      now: NOW, feed, agent: { ok: false, reason: "x" }, numberFacts: { ok: false, reason: "x" }, twilio: { ok: false, reason: "Twilio not configured" },
      usageSources: { retellCalls: { ok: true, rows: [{ id: "c1", startedAt: "2026-09-10T00:00:00.000Z", usdCents: 26 }] } },
    });
    if (!d.economics.ok) throw new Error("x");
    expect(d.economics.measuredMonthlyCents).toBeGreaterThan(0);
    expect(d.economics.measuredComplete).toBe(false);
    expect(d.economics.measured.note).toContain("Retell only this month");
    expect(d.economics.measured.note).toContain("Twilio not configured");
  });
});
