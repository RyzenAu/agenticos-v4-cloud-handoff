// Usage → package economics (Track 5): three bases, never mixed; source and as-of on every figure;
// unknown is unknown. SYNTHETIC data only: fictional clients, invented call ids and costs.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { calculateEconomics, DEFAULT_COST_RATES, DEFAULT_FX, DEFAULT_LABOUR_HOURLY_CENTS, DEFAULT_PAYMENT, DEFAULT_TARGET_MARGIN_BPS, receptionistConsistencyFixture, splitGst } from "../../src/lib/business-economics";
import { getReceptionistPackage, type PackageId } from "../../src/lib/receptionist-packages";
import { NOT_A_CALL, type RouterReceipt } from "../model-router/receipts";
import { SHARED_LEDGER, openManualFinanceStore } from "../finance/manual-store";
import { summary } from "../finance/manual-summary";
import { syntheticSeptemberCsv } from "../finance/manual-fixtures";
import { buildDashboard, type DashboardInput } from "./dashboard";
import type { AgencyFeedState, FeedCall, FeedClient } from "./types";
import {
  buildUsageEconomics, callAttribution, ledgerMonthFrom, NOT_A_CALL_OUTCOMES, receiptsForEconomics, sydneyMonthStartIso, usdToAudCents,
  type LedgerMonth, type UsageEconomics, type UsageEconomicsInput,
} from "./usage-economics";
import { EconomicsByBasis, TierBasisTable, marginText } from "../../src/components/receptionist/dashboard/economics-by-basis";
import { DashboardRetryProvider } from "../../src/components/receptionist/dashboard/shared";

const NOW = Date.parse("2026-09-27T06:00:00Z");
const READ_AT = new Date(NOW).toISOString();
const MONTH = "2026-08-31T14:00:00.000Z"; // 1 Sep 2026, 00:00 Sydney (AEST)

function client(over: Partial<FeedClient> & { organizationId: string }): FeedClient {
  return {
    slug: over.organizationId.replace("org_", ""),
    isDemoTenant: false,
    bookings: { byStatus: {}, total: 0, madeOnCalls: 0, sandbox: 0, upcoming: 0 },
    handoffs: { transfersByStatus: {}, alertsByReason: {}, alertsByStatus: {} },
    minutesThisMonth: { monthStart: MONTH, calls: 0, callMinutes: 0, billableMinutesCurrentPeriod: 0 },
    readiness: {
      agentMapped: true, inboundNumberSet: true, calendarRequested: "GOOGLE", calendarInUse: "GOOGLE", calendarReason: null, liveCalendar: true,
      demoDiaryConfirmed: false, bookingOutcome: "confirmed", alertMailboxSet: true, transferEnabled: false, smsEnabled: false, retentionDays: 90,
      retellRetentionAligned: "unverified", goLive: null,
    },
    ...over,
  };
}
// Professional: 480 calls × 150 s = 1,200 billable minutes (the consistency fixture's usage).
const PRO = client({ organizationId: "org_synth_pro", minutesThisMonth: { monthStart: MONTH, calls: 480, callMinutes: 1200, billableMinutesCurrentPeriod: 1200 } });
// Essential: 2 calls this month, SMS on but the deployed feed sends no counts.
const ESS = client({ organizationId: "org_synth_ess", minutesThisMonth: { monthStart: MONTH, calls: 2, callMinutes: 5, billableMinutesCurrentPeriod: 5 }, readiness: { ...PRO.readiness, smsEnabled: true } });
const DEMO = client({ organizationId: "org_synth_demo", isDemoTenant: true, minutesThisMonth: { monthStart: MONTH, calls: 1, callMinutes: 2, billableMinutesCurrentPeriod: 2 } });
const PACKAGES: Record<string, PackageId> = { synth_pro: "receptionist-professional", synth_ess: "receptionist-essential", synth_demo: "receptionist-essential" };

const feed = (clients: FeedClient[], view: "metadata" | "full" = "metadata", calls: FeedCall[] = []): AgencyFeedState => ({
  ok: true, generatedAt: "2026-09-27T05:00:00.000Z", windowDays: 30, view,
  organizations: [], calls, followUps: [], clients, deployment: null, goLive: null, qaFlags: null,
  totals: { calls: 483, completed: 480, failed: 3, avgDurationSeconds: 150, totalMinutes: 1207, byOutcome: [], bySentiment: [], qaGraded: 0, qaFlagged: 0, qaCriticalOpen: 0, triagePending: null, triageDone: null, oldestPendingTriageAt: null },
} as unknown as AgencyFeedState);
const feedCall = (providerCallId: string, organizationId: string): FeedCall =>
  ({ id: `rec_${providerCallId}`, organizationId, providerCallId, callType: "phone", status: "ended", outcome: "booked", sentiment: "Neutral", callerMasked: null, startedAt: "2026-09-10T00:00:00.000Z", endedAt: null, durationSeconds: 150, disconnectionReason: null, summary: null, qa: null }) as unknown as FeedCall;
// Retell rows: two of Pro's calls (one without a cost yet), one Essential call, one demo-line web test, one last month.
const RETELL = { ok: true as const, rows: [
  { id: "call_p1", startedAt: "2026-09-10T01:00:00.000Z", usdCents: 1800 },
  { id: "call_p2", startedAt: "2026-09-11T01:00:00.000Z", usdCents: null },
  { id: "call_e1", startedAt: "2026-09-12T01:00:00.000Z", usdCents: 30 },
  { id: "call_web", startedAt: "2026-09-13T01:00:00.000Z", usdCents: 12 },
  { id: "call_old", startedAt: "2026-08-20T01:00:00.000Z", usdCents: 99 },
] };
const FULL = feed([], "full", [feedCall("call_p1", PRO.organizationId), feedCall("call_p2", PRO.organizationId), feedCall("call_e1", ESS.organizationId)]);

function seededLedger(): LedgerMonth {
  const store = openManualFinanceStore(":memory:");
  store.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "test");
  const l = ledgerMonthFrom(summary(SHARED_LEDGER, "this-month", { store, today: "2026-09-27" }));
  store.close();
  return l;
}
const receipt = (over: Partial<RouterReceipt>): RouterReceipt => ({
  schema: "mu.router-receipt/v1", requestId: "r", attempt: 1, parentRequestId: null, task: "chat", caller: "synthetic", provider: "openrouter", model: "m", providerModel: null,
  route: "metered", selectedBy: "default", reason: "", fallbackFrom: null, inputTokens: 1, outputTokens: 1, characters: null, audioSeconds: null, costUsd: 0.01,
  costBasis: "provider_reported", priceAsOf: null, allowance: null, latencyMs: 1, outcome: "succeeded", errorCode: null, httpStatus: 200,
  startedAt: "2026-09-10T00:00:00.000Z", endedAt: "2026-09-10T00:00:01.000Z", ...over,
} as RouterReceipt);

function inputFor(over: Partial<UsageEconomicsInput> = {}): UsageEconomicsInput {
  return {
    now: NOW, feed: feed([PRO, ESS, DEMO]),
    packageFor: (c) => (PACKAGES[c.slug ?? ""] ? getReceptionistPackage(PACKAGES[c.slug ?? ""]) : null),
    retell: RETELL, retellReadAt: READ_AT,
    attribution: callAttribution(FULL, NOW),
    twilioMonth: { ok: true, usd: 3.5 }, twilioReadAt: READ_AT,
    receipts: receiptsForEconomics([
      receipt({ task: "receptionist-summary", route: "free", costUsd: 0 }),
      receipt({ task: "receptionist-summary", route: "metered", costUsd: 0.02 }),
      receipt({ task: "receptionist-summary", route: "metered", costUsd: null }),
      receipt({ task: "jev-triage", route: "metered", costUsd: 0.5 }),
      receipt({ task: "chat", route: "subscription", costUsd: 0 }),
      receipt({ task: "chat", route: "metered", costUsd: 9, outcome: "refused_policy" }),
      receipt({ task: "chat", route: "metered", costUsd: 7, startedAt: "2026-08-30T00:00:00.000Z" }),
    ], MONTH, READ_AT),
    ledger: seededLedger(),
    ...over,
  };
}
const econ = (over: Partial<UsageEconomicsInput> = {}): UsageEconomics => {
  const r = buildUsageEconomics(inputFor(over));
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const byOrg = (e: UsageEconomics, id: string) => e.clients.find((c) => c.organizationId === id)!;

describe("revenue: one billable figure per client, from the catalogue and the feed's billable minutes", () => {
  test("the Professional fixture: A$1,249.00 + A$124.90 = A$1,373.90, the same numbers as the consistency fixture", () => {
    const pro = byOrg(econ(), PRO.organizationId);
    expect(pro.revenue).toMatchObject({ cents: 124_900, basis: "estimated", complete: true });
    expect(pro.revenue.source).toContain("Catalogue");
    expect(pro.revenue.asOf).toBe("2026-09-27T05:00:00.000Z");
    const gst = splitGst(pro.revenue.cents!, "exclusive");
    expect([gst.netCents, gst.gstCents, gst.grossCents]).toEqual([124_900, 12_490, 137_390]);
    expect(receptionistConsistencyFixture().expectedInvoice.totals).toMatchObject({ exGstCents: pro.revenue.cents, gstCents: gst.gstCents, totalInclGstCents: gst.grossCents });
  });
  test("a demo tenant is never billed; an unassigned client has nothing to bill against", () => {
    const e = econ({ packageFor: (c) => (c.slug === "synth_pro" ? null : getReceptionistPackage("receptionist-essential")) });
    expect(byOrg(e, DEMO.organizationId).revenue).toMatchObject({ cents: null, notes: ["Demo tenant: never billed."] });
    expect(byOrg(e, PRO.organizationId).revenue).toMatchObject({ cents: null, notes: ["No package assigned locally: nothing to bill against."] });
  });
});

describe("estimated: actual usage × list rates", () => {
  test("equals calculateEconomics on the client's own calls and minutes", () => {
    const pkg = getReceptionistPackage("receptionist-professional");
    const expected = calculateEconomics({
      package: pkg, clients: 1, calls: [{ count: 480, seconds: 150 }], notificationsPerClient: 0, smsSegmentsPerClient: 0, phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
      rates: DEFAULT_COST_RATES, fx: DEFAULT_FX, gstRegistered: true, supportMinutesPerClient: 0, supportHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
      onboardingMinutes: 0, onboardingHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS, payment: DEFAULT_PAYMENT, targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
    });
    const pro = byOrg(econ(), PRO.organizationId);
    expect(pro.estimated).toMatchObject({ basis: "estimated", cents: expected.variableCostCents, revenueCents: 124_900, complete: false });
    expect(pro.estimated.marginBps).toBe(Math.round(((124_900 - expected.variableCostCents) * 10_000) / 124_900));
    expect(pro.estimated.source).toContain("list rates");
  });
  test("SMS on with no count is unknown and said so; SMS off is a real zero", () => {
    const e = econ();
    expect(byOrg(e, ESS.organizationId).usage.smsSegments).toBeNull();
    expect(byOrg(e, ESS.organizationId).estimated.notes).toContain("SMS segments unknown: not in the estimate.");
    expect(byOrg(e, PRO.organizationId).usage.smsSegments).toBe(0);
    // A feed that reports usage counts is used as-is.
    const withUsage = econ({ feed: feed([{ ...ESS, usage: { receipts: 2, pending: 0, billableMinutes: 5, smsSegments: 3 } }]) });
    expect(byOrg(withUsage, ESS.organizationId).usage).toMatchObject({ smsSegments: 3 });
  });
  test("a tier with no clients shows the package model, labelled as the model", () => {
    const premium = econ().tiers.find((t) => t.packageId === "receptionist-premium")!;
    expect(premium.clients).toBe(0);
    expect(premium.estimated.source).toContain("Package model (base usage)");
    expect(premium.estimated.notes[0]).toContain("Model, not usage");
    expect(premium.estimated.revenueCents).toBe(getReceptionistPackage("receptionist-premium").pricing.monthly.cents);
    expect(premium.measured).toMatchObject({ cents: null, notes: ["No billed client on this tier: nothing to measure."] });
  });
});

describe("measured: provider-reported only, joined to clients by the feed's call ids", () => {
  test("Retell per-call cost is matched to its client, converted at the one FX rate, and marked a floor", () => {
    const pro = byOrg(econ(), PRO.organizationId);
    expect(pro.measured.retell).toEqual({ matchedCalls: 2, feedCalls: 480, usdCents: 1800, unknownCostCalls: 1 });
    // R2: 1 of 480 calls matched a cost, so the measured COST is a floor and the margin is Unknown.
    expect(pro.measured).toMatchObject({ basis: "measured", cents: usdToAudCents(1800), complete: false, revenueCents: null, marginBps: null });
    expect(pro.measured.notes[0]).toBe("Margin unknown: only 1 of 480 calls matched a cost (a measured margin needs every call).");
    expect(usdToAudCents(1800)).toBe(Math.round((1800 * 1_000_000) / DEFAULT_FX.usdPerAudMillionths));
    expect(pro.measured.notes.join(" ")).toContain("2 of 480 calls this month matched to a Retell cost");
    expect(pro.measured.notes.join(" ")).toContain("1 matched call has no cost from Retell yet");
    expect(pro.measured.notes.join(" ")).toContain("Measured here: Retell only");
    expect(pro.measured.asOf).toBe(READ_AT);
    expect(marginText(pro.measured)).toBe("Unknown");
  });
  test("no Retell read, no call list, or no matched cost: unknown with the reason, never A$0", () => {
    const noRetell = byOrg(econ({ retell: { ok: false, reason: "Retell not configured" } }), PRO.organizationId).measured;
    expect(noRetell).toMatchObject({ cents: null, marginBps: null });
    expect(noRetell.notes[0]).toContain("Retell not configured");
    const noList = byOrg(econ({ attribution: null, attributionReason: "Agency feed rejected the token (HTTP 401)" }), PRO.organizationId).measured;
    expect(noList).toMatchObject({ cents: null });
    expect(noList.notes[0]).toContain("HTTP 401");
    expect(callAttribution(feed([]), NOW)).toBeNull(); // the metadata view has no call list
    const unmatched = byOrg(econ({ attribution: callAttribution(feed([], "full", []), NOW) }), PRO.organizationId).measured;
    expect(unmatched.cents).toBeNull();
    expect(unmatched.notes[0]).toContain("None of this client's 480 calls matched");
  });
  test("a client with no calls this month has a real zero measured cost", () => {
    const quiet = client({ organizationId: "org_synth_quiet", slug: "synth_pro" });
    expect(byOrg(econ({ feed: feed([quiet]) }), quiet.organizationId).measured).toMatchObject({ cents: 0, retell: { usdCents: 0 } });
  });
  test("portfolio: Retell this month (matched and not), Twilio account total, receipts split, never allocated", () => {
    const m = econ().portfolio.measured;
    expect(m.retell).toMatchObject({ usdCents: 1842, attributedUsdCents: 1830, unattributedUsdCents: 12, calls: 4, complete: false, cents: usdToAudCents(1842) });
    expect(m.twilio).toMatchObject({ usdCents: 350, cents: usdToAudCents(350), complete: true });
    expect(m.twilio.notes[0]).toContain("Not split by client");
    expect(m.receptionistModels).toMatchObject({ calls: 3, usdCents: 2, complete: false });
    expect(m.otherModels).toMatchObject({ calls: 1, usdCents: 50, complete: true }); // metered only; refused and last month excluded
    expect(m.smsSegments.count).toBeNull();
    const failed = econ({ twilioMonth: { ok: false, reason: "Twilio usage unavailable" }, receipts: null }).portfolio.measured;
    expect(failed.twilio).toMatchObject({ cents: null, usdCents: null });
    expect(failed.receptionistModels).toMatchObject({ cents: null, notes: ["Receipts couldn't be read."] });
  });
  test("the receipts filter mirrors the router's NOT_A_CALL set", () => {
    expect([...NOT_A_CALL_OUTCOMES].sort()).toEqual([...NOT_A_CALL].sort());
  });
});

describe("reconciled: paid, from the NAB CSV ledger; never split by client or tier", () => {
  test("provider lines this month carry the CSV statement, as-of and coverage", () => {
    const r = econ().portfolio.reconciled;
    expect(r).toMatchObject({ statement: "NAB CSV imported, as of 26 Sep 2026", asOf: "2026-09-26", coverage: "full" });
    const line = (label: string) => r.lines.find((l) => l.label === label)!;
    expect(line("Retell AI")).toMatchObject({ basis: "reconciled", cents: 3512 + 105 - 1240, complete: true }); // charge + NAB FX fee − refund
    expect(line("Twilio")).toMatchObject({ cents: 2143 + 64 }); // the pending Twilio row isn't paid yet
    expect(line("Retell AI").source).toContain("NAB CSV import");
  });
  test("per client and per tier: unknown, with the reason", () => {
    const e = econ();
    expect(byOrg(e, PRO.organizationId).reconciled).toMatchObject({ cents: null, notes: ["Bank lines aren't split by client: see the portfolio's reconciled costs."] });
    expect(e.tiers[0].reconciled.notes[0]).toContain("aren't split by tier");
  });
  test("nothing imported, or a month no import covers: unknown, not zero", () => {
    const none = econ({ ledger: { state: "none-imported" } }).portfolio.reconciled;
    expect(none).toMatchObject({ lines: [], statement: null });
    expect(none.notes[0]).toBe("No NAB CSV imported: nothing reconciled. Unknown, not zero.");
    const store = openManualFinanceStore(":memory:");
    store.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "test");
    const october = ledgerMonthFrom(summary(SHARED_LEDGER, "this-month", { store, today: "2026-10-05" }));
    store.close();
    const r = econ({ ledger: october }).portfolio.reconciled;
    expect(r).toMatchObject({ coverage: "none", lines: [] });
    expect(r.notes[0]).toContain("unknown, not zero");
    expect(ledgerMonthFrom(null)).toEqual({ state: "none-imported" });
  });
});

describe("per tier: sums of one basis only", () => {
  test("Professional's tier figures are its client's, and the demo tenant is not billed revenue", () => {
    const e = econ();
    const pro = e.tiers.find((t) => t.packageId === "receptionist-professional")!;
    const client = byOrg(e, PRO.organizationId);
    expect(pro).toMatchObject({ clients: 1, revenue: { cents: 124_900 } });
    expect(pro.estimated).toMatchObject({ cents: client.estimated.cents, revenueCents: 124_900 });
    expect(pro.measured).toMatchObject({ cents: client.measured.cents, revenueCents: null, complete: false });
    const ess = e.tiers.find((t) => t.packageId === "receptionist-essential")!;
    expect(ess.clients).toBe(1); // the Essential demo tenant is excluded
    expect(ess.revenue.cents).toBe(getReceptionistPackage("receptionist-essential").pricing.monthly.cents);
  });
});

describe("dates and attribution", () => {
  test("the Sydney month starts at local midnight, across daylight saving", () => {
    expect(sydneyMonthStartIso(NOW)).toBe(MONTH);
    expect(sydneyMonthStartIso(Date.parse("2026-10-05T00:00:00Z"))).toBe("2026-09-30T14:00:00.000Z"); // 1 Oct: still AEST
    expect(sydneyMonthStartIso(Date.parse("2026-11-15T00:00:00Z"))).toBe("2026-10-31T13:00:00.000Z"); // 1 Nov: AEDT
  });
  test("attribution keeps ids only, and an unknown window says so", () => {
    const a = callAttribution(FULL, NOW)!;
    expect([...a.byCallId.entries()]).toEqual([["call_p1", PRO.organizationId], ["call_p2", PRO.organizationId], ["call_e1", ESS.organizationId]]);
    expect(a.windowStart).toBe("2026-08-28T05:00:00.000Z");
    const noWindow = callAttribution({ ...FULL, windowDays: null } as AgencyFeedState, NOW)!;
    expect(noWindow.windowStart).toBeNull();
    expect(byOrg(econ({ attribution: noWindow }), PRO.organizationId).measured.notes.join(" ")).toContain("didn't say how far back");
  });
  test("the feed window starting after the month start is called out", () => {
    const late = callAttribution({ ...FULL, windowDays: 7 } as AgencyFeedState, NOW)!;
    expect(byOrg(econ({ attribution: late }), PRO.organizationId).measured.notes.join(" ")).toContain("The feed's call list starts 2026-09-20");
  });
  test("a feed that can't be read makes the whole view unknown", () => {
    expect(buildUsageEconomics(inputFor({ feed: { ok: false, reason: "Agency feed unreachable" } }))).toEqual({ ok: false, reason: "Agency feed unreachable" });
  });
});

describe("the dashboard carries the three bases, each tile with its own source", () => {
  const dash = (over: Partial<DashboardInput> = {}) => buildDashboard({
    now: NOW, providersReadAt: NOW, feed: feed([PRO, ESS, DEMO]),
    agent: { ok: false, reason: "not needed" }, numberFacts: { ok: false, reason: "not needed" },
    twilio: { ok: true, connected: true, trunkSid: "TK_synthetic", balanceUsd: 1, month: { ok: true, usd: 3.5, balanceUsd: 1 } },
    clientPackages: PACKAGES,
    usageSources: { retellCalls: RETELL, attribution: callAttribution(FULL, NOW), ledger: seededLedger() },
    ...over,
  });
  test("measured = Retell + Twilio this month; reconciled = NAB-paid Retell + Twilio; each with its own note", () => {
    const d = dash();
    if (!d.economics.ok || !d.usageEconomics.ok) throw new Error("blocks should be ok");
    expect(d.economics.measuredMonthlyCents).toBe(usdToAudCents(1842) + usdToAudCents(350));
    expect(d.economics.reconciledMonthlyCents).toBe(3512 + 105 - 1240 + 2143 + 64);
    expect(d.economics.measured.note).toContain("account-wide");
    expect(d.economics.reconciled).toMatchObject({ source: "NAB CSV import (finance-manual.sqlite)", asOf: "2026-09-26" });
    // The demo tenant isn't a billed client, so 2 of 3 are estimated (review R3).
    expect(d.economics.estimated.note).toBe("2 of 3 clients estimated. Variable service and payment cost; demo and M&U lines excluded.");
    expect(d.economics).toMatchObject({ estimatedComplete: true, estimatedUnknownClients: 0 });
    // Serialisable (the route sends JSON): no Map or function leaks into the view model.
    expect(JSON.parse(JSON.stringify(d.usageEconomics)).clients).toHaveLength(3);
  });
  test("without usage sources every measured/reconciled tile is unknown with a reason, never A$0", () => {
    const d = dash({ usageSources: undefined, twilio: { ok: false, reason: "Twilio not configured" } });
    if (!d.economics.ok) throw new Error("block should be ok");
    expect(d.economics).toMatchObject({ measuredMonthlyCents: null, reconciledMonthlyCents: null });
    expect(d.economics.measured.note).toContain("Retell calls not read");
    expect(d.economics.reconciled.note).toContain("couldn't be read");
  });
  test("overage is on billable minutes, and unknown for a client with no package", () => {
    const d = dash({ clientPackages: { synth_pro: "receptionist-professional" } });
    if (!d.clients.ok || !d.usage.ok) throw new Error("blocks should be ok");
    expect(d.clients.rows.find((r) => r.slug === "synth_pro")!.minutes.overageMinutes).toBe(200);
    expect(d.clients.rows.find((r) => r.slug === "synth_ess")!.minutes.overageMinutes).toBeNull();
    expect(d.usage.overageMinutesTotal).toBeNull();
  });
});

describe("rendered: every figure names its basis, source and date; unknown reads Unknown", () => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/receptionist"] }) });
  const render = (el: React.ReactElement) => renderToStaticMarkup(<RouterContextProvider router={router}><DashboardRetryProvider value={() => {}}>{el}</DashboardRetryProvider></RouterContextProvider>);
  test("the dashboard section", () => {
    const d = buildDashboard({
      now: NOW, providersReadAt: NOW, feed: feed([PRO, ESS, DEMO]), agent: { ok: false, reason: "x" }, numberFacts: { ok: false, reason: "x" },
      twilio: { ok: true, connected: true, trunkSid: "TK", balanceUsd: 1, month: { ok: true, usd: 3.5, balanceUsd: 1 } }, clientPackages: PACKAGES,
      usageSources: { retellCalls: RETELL, attribution: callAttribution(FULL, NOW), ledger: seededLedger() },
    });
    const html = render(<EconomicsByBasis data={d} />);
    for (const s of ["Economics by basis", "Estimated", "Measured", "Reconciled", "List rates × usage", "Provider-reported", "Paid (NAB CSV)", "A$1,249.00", "NAB CSV imported, as of 26 Sep 2026", "as of 27 Sep 2026", "Unknown", "≤ ", "Model, not usage"])
      expect(html).toContain(s);
    expect(html).not.toContain("NaN");
    // The reconciled column per client is unknown, not a zero.
    expect(html).toContain("Bank lines aren&#x27;t split by client");
  });
  test("the tier table has a stacked list for phones and no scroll container", () => {
    const html = render(<TierBasisTable tiers={econ().tiers} />);
    expect(html).toContain("md:hidden");
    expect(html).not.toMatch(/overflow-x-auto|min-w-\[\d+px\]/);
  });
});
