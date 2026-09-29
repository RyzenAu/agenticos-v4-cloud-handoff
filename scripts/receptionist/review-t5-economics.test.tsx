// REVIEW-T5-FINANCE R1-R4 and the unknown-reason should-fix, on the reviewer's own scenario: an
// Essential client with 530 window minutes but 500 billing-period minutes, a Professional client
// with 2 of 480 calls matched, a Premium client with no usage reported and a demo tenant. SYNTHETIC.
import { describe, expect, test } from "bun:test";
import { projectAgencyFeed } from "./agency-feed";
import { buildDashboard } from "./dashboard";
import { MEASURED_MARGIN_MIN_COVERAGE, callAttribution, isInternalClient } from "./usage-economics";

const NOW = Date.parse("2026-09-28T06:00:00Z");
const MONTH = "2026-08-31T14:00:00.000Z";
const readiness = { agentMapped: true, inboundNumberSet: true, liveCalendar: true, smsEnabled: true, bookingOutcome: "confirmed" };
const blocks = { bookings: { total: 1, madeOnCalls: 1, sandbox: 0, upcoming: 0 }, handoffs: { transfersByStatus: {}, alertsByReason: {}, alertsByStatus: {} } };
const client = (id: string, slug: string, extra: Record<string, unknown>) => ({ organizationId: id, slug, readiness, ...blocks, ...extra });
const body = (view: "metadata" | "full") => ({
  version: 1, generatedAt: "2026-09-28T05:00:00.000Z", windowDays: 30, view,
  organizations: [], followUps: [],
  totals: { calls: 700, completed: 700, failed: 0, totalMinutes: 1800, byOutcome: [], bySentiment: [] },
  calls: view === "metadata" ? [] : ["c1", "c2", "c3"].map((id) => ({ id, organizationId: "org_pro", providerCallId: id, callType: "phone", status: "ended", outcome: "x", sentiment: "x", startedAt: "2026-09-10T00:00:00.000Z" })),
  clients: [
    client("org_pro", "harbour", { minutesThisMonth: { monthStart: MONTH, calls: 480, callMinutes: 1200, billableMinutesCurrentPeriod: 1200 } }),
    // R1: the usage block's billableMinutes (530) is the 30-day window; currentPeriod (500) is billing.
    client("org_ess", "coastal", { minutesThisMonth: { monthStart: MONTH, calls: 200, callMinutes: 500, billableMinutesCurrentPeriod: 500 }, usage: { receipts: 212, pending: 0, billableMinutes: 530, smsSegments: 120, currentPeriod: { billableMinutes: 500 } } }),
    { organizationId: "org_prem", slug: "premium-co", readiness },
    client("org_demo", "mu-demo", { isDemoTenant: true, minutesThisMonth: { monthStart: MONTH, calls: 8, callMinutes: 20, billableMinutesCurrentPeriod: 20 } }),
  ],
});
const dash = () => buildDashboard({
  now: NOW, feed: projectAgencyFeed(body("metadata")), agent: { ok: false, reason: "x" }, numberFacts: { ok: false, reason: "x" },
  twilio: { ok: false, reason: "Twilio not configured" },
  clientPackages: { harbour: "receptionist-professional", coastal: "receptionist-essential", "premium-co": "receptionist-premium", "mu-demo": "receptionist-essential" },
  usageSources: {
    retellCalls: { ok: true, rows: [{ id: "c1", startedAt: "2026-09-10T00:00:00.000Z", usdCents: 800 }, { id: "c2", startedAt: "2026-09-11T00:00:00.000Z", usdCents: 800 }, { id: "c3", startedAt: "2026-09-12T00:00:00.000Z", usdCents: null }] },
    attribution: callAttribution(projectAgencyFeed(body("full")), NOW),
  },
});
const econ = () => { const d = dash(); if (!d.usageEconomics.ok) throw new Error("x"); return d.usageEconomics; };

describe("review R1-R4", () => {
  test("R1: revenue on billing-period minutes: Coastal A$779.00 (100 overage), not A$803.00", () => {
    const c = econ().clients.find((x) => x.slug === "coastal")!;
    expect(c.revenue.cents).toBe(77_900);
    expect(c.revenue.notes.join(" ")).toContain("100 overage min");
    expect(c.usage.smsSource).toContain("30-day window, not the billing period");
    expect(econ().tiers.find((t) => t.packageId === "receptionist-essential")!.revenue.cents).toBe(77_900);
  });
  test("R2: 2 of 480 calls matched is not a measured margin", () => {
    expect(MEASURED_MARGIN_MIN_COVERAGE).toBe(1);
    const h = econ().clients.find((x) => x.slug === "harbour")!;
    expect(h.measured).toMatchObject({ marginBps: null, revenueCents: null, complete: false });
    expect(h.measured.cents).toBeGreaterThan(0); // the cost stays, as a floor
    expect(h.measured.notes[0]).toBe("Margin unknown: only 2 of 480 calls matched a cost (a measured margin needs every call).");
    expect(econ().tiers.find((t) => t.packageId === "receptionist-professional")!.measured.marginBps).toBeNull();
  });
  test("R3: the demo tenant is out of MRR, setup and the margin table", () => {
    const d = dash();
    if (!d.commercial.ok || !d.clients.ok) throw new Error("x");
    expect(d.commercial.mrrCents).toBe(379_700); // 1,099 + 699 + 1,999; not 4,496 with the demo
    const demo = d.clients.rows.find((r) => r.slug === "mu-demo")!;
    expect(demo.commercial).toMatchObject({ mrrCents: null, marginCents: null, setupFeeCents: null, caveat: "Demo tenant: never billed." });
    expect(isInternalClient({ isDemoTenant: false, slug: "mu-demo" })).toBe(true);
    expect(isInternalClient({ isDemoTenant: false, slug: "munro-dental" })).toBe(false);
  });
  test("R4: the estimated tile is a floor with the unknown client counted", () => {
    const d = dash();
    if (!d.economics.ok) throw new Error("x");
    expect(d.economics).toMatchObject({ estimatedComplete: false, estimatedUnknownClients: 1 });
    expect(d.economics.estimated.note).toBe("2 of 4 clients estimated; 1 with a package but usage not reported (not in the total: a floor). Variable service and payment cost; demo and M&U lines excluded.");
  });
  test("should-fix: a client that didn't report a block is 'client-unreported', not 'not attributed'", () => {
    const d = dash();
    if (!d.usage.ok || !d.bookings.ok) throw new Error("x");
    expect(d.usage.attribution).toBe("client-unreported");
    expect(d.bookings.attribution).toBe("client-unreported");
  });
});
