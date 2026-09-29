// Audit F2 (28 Sep 2026), Receptionist findings RX-1 … RX-12. Synthetic fixtures only: no network
// (every fetch is a stub), no real feed/Retell/Twilio data, temp directories for the stores.
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildReceptionistSnapshot } from "./aggregate";
import { call, inputs, NOW } from "./aggregate.test";
import { createAgencyFeed, projectAgencyFeed } from "./agency-feed";
import { ASSIGN_PACKAGE_LABEL, buildDashboard, packageWarningException, sumKnown, tileRecovery, type DashboardInput } from "./dashboard";
import { createReceptionistService, receptionistMiddleware } from "./plugin";
import { buildReadiness } from "./readiness";
import type { AgencyFeedState, FeedClient, FeedOrganization, Incident, ReceptionistSnapshot } from "./types";
import { pageTokenFor, type Principal } from "../identity/principal";
import { ClientsTable, nicheLabel } from "../../src/components/receptionist/dashboard/clients-table";
import { Overview } from "../../src/components/receptionist/dashboard/overview";
import { extraQaCodes, feedReadAgreement, incidentLabels, incidentException, mergeSellExceptions } from "../../src/components/receptionist/dashboard/sell-exceptions";
import { FlaggedCalls, SellVerdict } from "../../src/components/receptionist/dashboard/sell-status";
import { DashboardRetryProvider } from "../../src/components/receptionist/dashboard/shared";
import { UsageAndEconomics } from "../../src/components/receptionist/dashboard/usage-economics";
import { GateRow } from "../../src/components/receptionist/gates";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "rx-audit-"));
  dirs.push(d);
  return d;
};

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/receptionist"] }) });
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterContextProvider router={router}>
        <DashboardRetryProvider value={() => {}}>{el}</DashboardRetryProvider>
      </RouterContextProvider>
    </QueryClientProvider>,
  );
/** One SignalTile's markup, from its label to the next tile's label. */
function tileHtml(html: string, label: string): string {
  const start = html.indexOf(`<span class="min-w-0 [overflow-wrap:anywhere]">${label}</span>`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<span class="sh-signal-label">', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

// ── Synthetic dashboard fixtures ───────────────────────────────────────────────────────────────
const DNOW = Date.now();
const AGENT_OK = { ok: true as const, name: "Synthetic Agent", voice: "voice-x", language: "en-AU", model: "model-x", published: true, webhook: true, webhookHost: "rx.example.test", webhookProbe: "protected" as const, modified: new Date(DNOW - 3 * 86_400_000).toISOString(), prompt000: true, disclosure: true, recording: true, overseas: true, transfer: false, promptKnown: true, version: 3, llmVersion: 5 };
function client(over: Partial<FeedClient> = {}): FeedClient {
  return {
    organizationId: "org_syn_1", slug: "synthetic-dental", isDemoTenant: false,
    bookings: { byStatus: { CONFIRMED: 3 }, total: 3, madeOnCalls: 3, sandbox: 0, upcoming: 1 },
    handoffs: { transfersByStatus: {}, alertsByReason: {}, alertsByStatus: {} },
    minutesThisMonth: { monthStart: "2026-09-01T00:00:00Z", calls: 10, callMinutes: 40, billableMinutesCurrentPeriod: 40 },
    readiness: { agentMapped: true, inboundNumberSet: true, calendarRequested: null, calendarInUse: null, calendarReason: null, liveCalendar: false, demoDiaryConfirmed: false, bookingOutcome: null, alertMailboxSet: false, transferEnabled: false, smsEnabled: false, retentionDays: null, retellRetentionAligned: "unverified", goLive: null },
    ...over,
  };
}
const org = (over: Partial<FeedOrganization> = {}): FeedOrganization => ({ id: "org_syn_1", name: "Harbourview Dental (synthetic)", niche: "REAL_ESTATE", isDemoTenant: false, inboundNumberMasked: "••• 208", ...over });
function feed(clients: FeedClient[], organizations: FeedOrganization[] = [org()]): AgencyFeedState {
  return {
    ok: true, generatedAt: new Date(DNOW - 60_000).toISOString(), windowDays: 30, view: "metadata", organizations,
    totals: { calls: 5, completed: 5, failed: 0, avgDurationSeconds: 60, totalMinutes: 5, byOutcome: [], bySentiment: [], qaGraded: 0, qaFlagged: 0, qaCriticalOpen: 0, triagePending: 0, triageDone: 0, oldestPendingTriageAt: null },
    calls: [], followUps: [], clients, deployment: null, goLive: null, qaFlags: null,
  };
}
const dashInput = (over: Partial<DashboardInput> = {}): DashboardInput => ({
  now: DNOW, providersReadAt: DNOW, feed: feed([client()]),
  agent: AGENT_OK, numberFacts: { ok: true, attached: true, version: 3, sms: false },
  twilio: { ok: true, connected: true, trunkSid: "TK_syn", balanceUsd: 42, month: { ok: true, usd: 1, balanceUsd: 42 } },
  ...over,
});

// ── RX-1 ───────────────────────────────────────────────────────────────────────────────────────
describe("RX-1: Refresh re-reads everything, and each feed read says its time", () => {
  test("the feed reader: force bypasses the cache; status keeps the read time and the last good read", async () => {
    let t = 1_000_000;
    let ok = false;
    const fetchStub = (async () => (ok
      ? new Response(JSON.stringify({ version: 1, generatedAt: new Date(t).toISOString(), totals: {}, calls: [], followUps: [] }), { status: 200 })
      : new Response("nope", { status: 401 }))) as unknown as typeof fetch;
    const read = createAgencyFeed({ providerKey: (n) => (n === "AGENCY_FEED_URL" ? "https://feed.example.test/api/agency/feed" : "synthetic-token"), fetch: fetchStub, now: () => t });
    expect(read.status()).toEqual({ readAt: null, lastOkAt: null });
    expect(await read()).toMatchObject({ ok: false, reason: "Agency feed rejected the token (HTTP 401)" });
    expect(read.status()).toEqual({ readAt: 1_000_000, lastOkAt: null });
    ok = true;
    t += 10_000;
    // Within 60 s the cached failure is reused…
    expect((await read()).ok).toBe(false);
    // …but a forced read (every Refresh path) goes to the feed.
    expect((await read(true)).ok).toBe(true);
    expect(read.status()).toEqual({ readAt: 1_010_000, lastOkAt: 1_010_000 });
    ok = false;
    t += 5_000;
    expect((await read(true)).ok).toBe(false);
    expect(read.status()).toEqual({ readAt: 1_015_000, lastOkAt: 1_010_000 });
  });

  test("the snapshot service: refresh() forces the feed read, and the snapshot carries that read's time", async () => {
    let feedOk = false;
    const urls: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://feed.example.test/"))
        return feedOk
          ? new Response(JSON.stringify({ version: 1, generatedAt: new Date(NOW).toISOString(), totals: {}, calls: [], followUps: [], goLive: { verdict: "safe", perClient: [] } }), { status: 200 })
          : new Response("down", { status: 503 });
      return new Response("synthetic failure", { status: 500 });
    }) as unknown as typeof fetch;
    let now = NOW;
    const service = createReceptionistService(
      { root: temp(), token: "fixture", fetch: fetchStub, providerKey: (n) => ({ AGENCY_FEED_URL: "https://feed.example.test/api/agency/feed", AGENCY_FEED_TOKEN: "synthetic-feed-token" } as Record<string, string>)[n] ?? "" },
      { now: () => now },
    );
    const first = await service.get();
    expect(first.feed).toEqual({ ok: false, reason: "Agency feed returned HTTP 503" });
    expect(first.feedRead).toEqual({ at: new Date(NOW).toISOString(), lastOkAt: null });
    feedOk = true;
    now += 30_000; // inside the feed's 60 s cache, which still holds the 503
    const cached = await service.refresh();
    // A forced snapshot build forces the feed too: never a cached failure from up to 60 s ago.
    expect(cached.feed.ok).toBe(true);
    expect(cached.feedRead).toEqual({ at: new Date(now).toISOString(), lastOkAt: new Date(now).toISOString() });
    expect(urls.filter((u) => u.startsWith("https://feed.example.test/")).length).toBe(2);
    expect(JSON.stringify(cached)).not.toContain("synthetic-feed-token");
  });

  test("load(force) receives the Refresh, and a Refresh never joins an in-flight cached build", async () => {
    const forces: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const service = createReceptionistService(
      { root: temp(), token: "fixture", providerKey: () => "" },
      { now: () => NOW, load: async (force) => { forces.push(force); if (forces.length === 1) await gate; return inputs(); } },
    );
    const slow = service.get();
    const refreshed = service.refresh();
    release();
    await Promise.all([slow, refreshed]);
    expect(forces).toEqual([false, true]);
  });

  test("the page: the two feed reads are compared, and a disagreement names each read and its time", () => {
    const at = new Date(DNOW - 120_000).toISOString();
    const snap = { generatedAt: at, feed: { ok: false, reason: "Agency feed unreachable (request failed)" }, feedRead: { at, lastOkAt: null } } as unknown as ReceptionistSnapshot;
    const disagree = feedReadAgreement({ ok: false, reason: "Agency feed rejected the token (HTTP 401)", at: new Date(DNOW).toISOString(), lastOkAt: null }, snap, DNOW);
    expect(disagree?.agree).toBe(false);
    expect(disagree?.lines).toEqual([
      "Sell status: feed unavailable (Agency feed unreachable (request failed)), read 2 min ago",
      "Dashboard: feed unavailable (Agency feed rejected the token (HTTP 401)), read just now",
    ]);
    expect(feedReadAgreement({ ok: false, reason: "Agency feed unreachable (request failed)", at, lastOkAt: null }, snap, DNOW)?.agree).toBe(true);
    expect(feedReadAgreement(undefined, snap, DNOW)).toBeNull();
    // The verdict states its own feed read (reason, when, last good read).
    const verdict = render(<SellVerdict sell={{ data: { ...buildReceptionistSnapshot(inputs(), NOW), feedRead: { at, lastOkAt: null } }, error: null, isLoading: false }} />);
    expect(verdict).toContain("Agency feed unavailable (Agency feed not configured)");
    expect(verdict).toContain("no successful read yet");
    // The dashboard model carries its own read.
    expect(buildDashboard(dashInput({ feed: { ok: false, reason: "Agency feed rejected the token (HTTP 401)" }, feedReadAt: DNOW })).feedRead).toEqual({ ok: false, reason: "Agency feed rejected the token (HTTP 401)", at: new Date(DNOW).toISOString(), lastOkAt: null });
  });
});

// ── RX-5 ───────────────────────────────────────────────────────────────────────────────────────
describe("RX-5: sign-offs and follow-ups record the verified principal, never a body name", () => {
  async function post(service: ReturnType<typeof createReceptionistService>, route: string, body: unknown, principal: Principal) {
    const req = Object.assign(new EventEmitter(), { method: "POST", url: route, headers: { host: "127.0.0.1:8081", "x-claude-os-token": pageTokenFor(principal, "fixture") }, socket: { remoteAddress: "127.0.0.1" } });
    const done = new Promise<{ status: number; body: any }>((resolve) => {
      const res = { statusCode: 0, setHeader() {}, end(s: string) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
      receptionistMiddleware(service, "fixture", () => principal)(req as any, res as any, () => resolve({ status: 404, body: {} }));
    });
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
    return done;
  }
  const mehroz: Principal = { personId: "mehroz" as Principal["personId"], via: "tailnet-person", actor: "human", displayName: "Mehroz" };

  test("a body `by` is ignored: the store and the page show the principal", async () => {
    const root = temp();
    const i = inputs([call({ id: "call_fixture1", flags: ["FALSE_BOOKING"] })]);
    const service = createReceptionistService({ root, token: "fixture", providerKey: () => "" }, { load: async () => structuredClone(i), now: () => NOW });
    const signed = await post(service, "/readiness", { id: "compliance", done: false, by: "Operator" }, mehroz);
    expect(signed.status).toBe(200);
    const followed = await post(service, "/incident", { callId: "call_fixture1", by: "Forged Name", note: "Called back" }, mehroz);
    expect(followed.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(root, ".operator-data/receptionist-readiness.json"), "utf8"));
    expect(saved.compliance.by).toBe("Mehroz");
    expect(saved.followedUp.call_fixture1.by).toBe("Mehroz");
    expect(JSON.stringify(saved)).not.toContain("Operator");
    expect(JSON.stringify(saved)).not.toContain("Forged Name");
    // Without a body `by` at all (what the page now sends), the same.
    expect((await post(service, "/readiness", { id: "urgent-wording", done: false }, mehroz)).status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, ".operator-data/receptionist-readiness.json"), "utf8"))["urgent-wording"].by).toBe("Mehroz");
  });

  test("the page sends no name: the client patch has no `by`", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/lib/receptionist.ts"), "utf8");
    expect(src).not.toContain("operatorName");
    expect(src).not.toContain("by:");
  });
});

// ── RX-2 / RX-3 ────────────────────────────────────────────────────────────────────────────────
describe("RX-2 + RX-3: unknown usage is unknown, never 0, and no margin is computed from it", () => {
  test("a client row without minutes/bookings/handoffs projects to null", () => {
    const projected = projectAgencyFeed({
      version: 1, generatedAt: new Date(DNOW).toISOString(), totals: {}, calls: [], followUps: [],
      clients: [{ organizationId: "org_nulls", slug: "harbourview", readiness: {} }],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const c = projected.clients[0];
    // Merged with live's block model (F2 RX-2, Track 5): an unreported block is null as a whole.
    expect(c.minutesThisMonth).toBeNull();
    expect(c.bookings).toBeNull();
    expect(c.handoffs).toBeNull();
    // A reported handoffs block missing a record keeps that record unknown (null), never {} (zeros).
    const partial = projectAgencyFeed({
      version: 1, generatedAt: new Date(DNOW).toISOString(), totals: {}, calls: [], followUps: [],
      clients: [{ organizationId: "org_nulls", slug: "harbourview", readiness: {}, handoffs: { alertsByStatus: { SENT: 1 } } }],
    });
    if (!partial.ok) throw new Error(partial.reason);
    expect(partial.clients[0].handoffs).toEqual({ transfersByStatus: null, alertsByReason: null, alertsByStatus: { SENT: 1 } });
  });

  test("an assigned client with unknown minutes: fees known, cost/margin/overage unknown, table says Unknown", () => {
    const nulls = client({ minutesThisMonth: null, bookings: null, handoffs: null });
    const model = buildDashboard(dashInput({ feed: feed([nulls]), clientPackages: { "synthetic-dental": "receptionist-essential" } }));
    const row = model.clients.ok ? model.clients.rows[0] : null;
    expect(row?.minutes).toMatchObject({ usedThisMonth: null, overageMinutes: null, remaining: null });
    // Block model: the whole unreported block is null (unknown), never zeros.
    expect(row?.bookings).toBeNull();
    expect(row?.transfers).toBeNull();
    expect(row?.handoffs).toBeNull();
    expect(row?.costs.estimatedMonthlyCents).toBeNull();
    expect(row?.commercial.marginCents).toBeNull();
    expect(row?.commercial.mrrCents).not.toBeNull();
    expect(model.usage).toMatchObject({ ok: true, usedTotal: null, overageMinutesTotal: null });
    expect(model.economics).toMatchObject({ ok: true, estimatedMonthlyCents: null, clientsEstimated: 0 });
    expect(model.bookings).toMatchObject({ ok: true, confirmed: null, total: null });
    const html = render(<ClientsTable data={model} />);
    expect(html).toContain("Unknown / ");
    expect(html).not.toMatch(/>0 \/ /);
    expect(html).toContain("Margin unknown");
  });

  test("no package: overage is unknown per client and in the total; support is unknown", () => {
    const model = buildDashboard(dashInput());
    const row = model.clients.ok ? model.clients.rows[0] : null;
    expect(row?.minutes).toMatchObject({ includedPerMonth: null, usedThisMonth: 40, overageMinutes: null });
    expect(model.usage).toMatchObject({ ok: true, usedTotal: 40, overageMinutesTotal: null, unassignedClients: 1 });
    expect(model.supportWorkload).toMatchObject({ ok: true, assumedMinutesTotal: null, clientsCounted: 0 });
    const html = render(<UsageAndEconomics data={model} />);
    const overage = tileHtml(html, "Overage");
    expect(overage).toContain("Unknown");
    expect(overage).not.toMatch(/>0</);
    expect(tileHtml(html, "Assumed support minutes / month")).toContain("Unknown");
  });

  // Merged with live (Track 5, reviewed): the overage TOTAL is unknown while any client has no
  // package (usage-economics.test.tsx asserts it), where T8 showed "at least N". Still never 0: the
  // over-allowance client's own overage stays visible (its row and a "minutes-overage" exception),
  // and the tile points to package assignment. Support keeps T8's "at least" over counted clients.
  test("one client over its allowance, one unassigned: overage total unknown, the known overage still shown", () => {
    const over = client({ minutesThisMonth: { monthStart: null, calls: 400, callMinutes: 5000, billableMinutesCurrentPeriod: 5000 } });
    const other = client({ organizationId: "org_syn_2", slug: "synthetic-legal" });
    const model = buildDashboard(dashInput({ feed: feed([over, other], [org(), org({ id: "org_syn_2", name: "Synthetic Legal" })]), clientPackages: { "synthetic-dental": "receptionist-essential" } }));
    expect(model.usage.ok && model.usage.overageMinutesTotal).toBeNull();
    const overRow = model.clients.ok ? model.clients.rows.find((r) => r.slug === "synthetic-dental")! : null;
    expect(overRow?.minutes.overageMinutes).toBeGreaterThan(0);
    expect(model.exceptions.some((e) => e.id === "client:org_syn_1:minutes-overage")).toBe(true);
    expect(render(<ClientsTable data={model} />)).toContain(`+${overRow?.minutes.overageMinutes}`);
    expect(model.supportWorkload).toMatchObject({ clientsCounted: 1, clientsTotal: 2 });
    const html = render(<UsageAndEconomics data={model} />);
    expect(tileHtml(html, "Overage")).toContain("Unknown");
    expect(tileHtml(html, "Overage")).not.toMatch(/>0</);
    expect(tileHtml(html, "Overage")).toContain(ASSIGN_PACKAGE_LABEL);
    expect(tileHtml(html, "Assumed support minutes / month")).toContain("≥");
    expect(tileHtml(html, "Assumed support minutes / month")).toContain("At least: not known for every client");
    expect(sumKnown([1, null])).toEqual({ total: 1, lowerBound: true });
    expect(sumKnown([0, null])).toEqual({ total: null, lowerBound: false });
    expect(sumKnown([2, 3])).toEqual({ total: 5, lowerBound: false });
  });
});

// ── RX-4 / RX-6 / RX-8 (gates) ─────────────────────────────────────────────────────────────────
describe("gates: reopened, the resolved line, and unread calls", () => {
  test("RX-4: a reopened gate records who reopened it and never says 'Signed off'", () => {
    const i = inputs();
    i.signoffs = { compliance: { done: false, by: "Usman", at: new Date(NOW - 60_000).toISOString() } };
    const b = buildReceptionistSnapshot(i, NOW).readiness.blockers.find((x) => x.id === "compliance")!;
    expect(b.signedOff).toBeUndefined();
    expect(b.reopened).toMatchObject({ by: "Usman" });
    const html = render(<GateRow blocker={b} />);
    expect(html).not.toContain("Signed off by");
    expect(html).toContain("Reopened by Usman");
  });

  test("RX-6: the next step names the resolved line, not a hard-coded number", () => {
    const i = inputs();
    i.number = "+61400111222";
    const s = buildReceptionistSnapshot(i, NOW);
    const next = s.readiness.blockers.find((b) => b.id === "no-false-actions")!.next;
    expect(next).toContain("+61 400 111 222");
    expect(JSON.stringify(s.readiness)).not.toContain("485 011 208");
    const fallback = buildReadiness({ calls: { ok: true, rows: [] }, agent: { ok: false, reason: "x" }, sms: null, legal: "unknown", signoffs: {}, economics: buildReceptionistSnapshot(inputs(), NOW).commercial.economics, twilioMonth: { ok: false, reason: "x" } });
    expect(fallback.blockers[0].next).toContain("the receptionist line");
  });

  test("RX-8: calls unread → retests and gates are Unknown, never Met / 'No real call'", async () => {
    const i = inputs();
    i.calls = { ok: false, reason: "Retell returned HTTP 500" };
    const s = buildReceptionistSnapshot(i, NOW);
    const retests = s.verdict.checks!.find((c) => c.id === "retests")!;
    expect(retests).toMatchObject({ ok: false, unknown: true });
    expect(retests.detail).toContain("Unknown");
    const gate = s.readiness.blockers.find((b) => b.id === "no-false-actions")!;
    expect(gate.state).toBe("unknown");
    expect(gate.stateNote).toBe("Unknown · couldn't read calls (Retell returned HTTP 500)");
    expect(JSON.stringify(s.readiness)).not.toContain("since records began");
    const html = render(<SellVerdict sell={{ data: s, error: null, isLoading: false }} />);
    const li = html.slice(html.indexOf('data-sell-check="retests"'));
    expect(li.slice(0, li.indexOf("</li>"))).toContain(">Unknown<");
    expect(li.slice(0, li.indexOf("</li>"))).not.toContain(">Met<");
    // The server refuses a sign-off on a gate whose evidence is unknown.
    const service = createReceptionistService({ root: temp(), token: "fixture", providerKey: () => "" }, { load: async () => structuredClone(i), now: () => NOW });
    await expect(service.saveReadiness({ id: "urgent-wording", done: true }, "Usman")).rejects.toThrow("couldn't be read");
  });
});

// ── RX-7 / RX-9 ────────────────────────────────────────────────────────────────────────────────
describe("RX-7 + RX-9: failed reads show the reason and the last good read; the right recovery", () => {
  test("a failed Twilio read: its own reason, no 'Updated just now', last good read time", () => {
    const never = buildDashboard(dashInput({ twilio: { ok: false, reason: "Twilio not configured" } }));
    const tile = tileHtml(render(<Overview data={never} />), "Twilio trunk");
    expect(tile).toContain("Twilio not configured");
    expect(tile).toContain("No successful read yet");
    expect(tile).not.toContain("Updated just now");
    expect(tile).toContain('data-state="failed"');
    const earlier = buildDashboard(dashInput({ twilio: { ok: false, reason: "Twilio returned HTTP 503" }, lastGoodReadAt: { twilio: DNOW - 20 * 60_000 } }));
    const tile2 = tileHtml(render(<Overview data={earlier} />), "Twilio trunk");
    expect(tile2).toContain("Last good read 20 min ago");
    expect(tile2).not.toContain("Updated just now");
  });

  test("a failed feed read: last good read, never 'Not loaded yet'", () => {
    const model = buildDashboard(dashInput({ feed: { ok: false, reason: "Agency feed unreachable (TimeoutError)" }, lastGoodReadAt: { feed: DNOW - 5 * 60_000 } }));
    expect(model.clients).toMatchObject({ ok: false, asOf: new Date(DNOW - 5 * 60_000).toISOString() });
    const html = render(<Overview data={model} />);
    expect(html).not.toContain("Not loaded yet");
    expect(tileHtml(html, "Clients")).toContain("Last good read 5 min ago");
  });

  test("feed never read + sell incidents: the exceptions count is partial, not stale", () => {
    const model = buildDashboard(dashInput({ feed: { ok: false, reason: "Agency feed not configured" } }));
    const s = buildReceptionistSnapshot(inputs([call({ id: "call_flagged01", flags: ["FALSE_BOOKING"] })]), DNOW);
    const merged = mergeSellExceptions({ items: model.exceptions, summary: model.exceptionSummary }, { data: s, error: null, isLoading: false });
    expect(merged.summary).toMatchObject({ ok: true, stale: false });
    const tile = tileHtml(render(<Overview data={model} exceptions={merged} />), "Open exceptions");
    expect(tile).not.toContain("Stale");
    expect(tile).not.toContain("Feed is stale, refresh");
    expect(tile).toContain("Partial: at least");
  });

  test("RX-9: unknown because of unassigned packages points to package assignment, not a retry", () => {
    const meta = { asOf: new Date(DNOW).toISOString(), source: "x", stale: false, staleAfterMs: 60_000 };
    expect(tileRecovery({ ok: true, ...meta }, "unknown", "unassigned-package")).toEqual({ kind: "assign", label: ASSIGN_PACKAGE_LABEL });
    expect(tileRecovery({ ok: true, ...meta }, "unknown")).toEqual({ kind: "retry", label: "Not reported, retry" });
    // Nothing to read yet (no reconciled invoice): no "retry" that can't help.
    expect(tileRecovery({ ok: true, ...meta }, "unknown", "not-available")).toBeNull();
    const html = render(<UsageAndEconomics data={buildDashboard(dashInput())} />);
    expect(tileHtml(html, "Overage")).toContain(ASSIGN_PACKAGE_LABEL);
    expect(tileHtml(html, "Overage")).not.toContain("Not reported, retry");
    expect(tileHtml(html, "Included")).toContain(ASSIGN_PACKAGE_LABEL);
    expect(tileHtml(html, "Reconciled")).not.toContain("retry");
    expect(render(<ClientsTable data={buildDashboard(dashInput())} />)).toContain("receptionist-client-packages.json");
  });
});

// ── RX-10 / RX-11 / RX-12 ──────────────────────────────────────────────────────────────────────
describe("RX-10..12: labels once, table words whole, one source per figure", () => {
  test("RX-10: a Retell flag and the matching QA code show one label", () => {
    const incident: Incident = { callId: "call_dupe0001", startedAt: null, from: null, flags: ["FALSE_BOOKING"], consequence: "Caller may expect a booking that wasn't made.", retellUrl: "", qaCodes: ["FALSE_BOOKING", "URGENT_CALL"], sources: ["retell", "production QA"] };
    expect(incidentLabels(incident)).toEqual(["False booking", "Urgent call (review)"]);
    expect(incidentException(incident).title).not.toContain("False booking, False booking");
    expect(extraQaCodes(incident)).toEqual(["URGENT_CALL"]);
    const html = render(<FlaggedCalls incidents={[incident]} />);
    expect(html.match(/False booking/g)).toHaveLength(1);
  });

  test("RX-11: niche in words, whole words in the table, the client's name not its slug", () => {
    expect(nicheLabel("REAL_ESTATE")).toBe("Real estate");
    expect(nicheLabel(null)).toBe("—");
    const html = render(<ClientsTable data={buildDashboard(dashInput({ clientPackages: { "synthetic-dental": "receptionist-professional" } }))} />);
    expect(html).toContain("Real estate");
    expect(html).not.toContain("REAL_ESTATE");
    expect(html).toContain("[overflow-wrap:normal]");
    expect(html).not.toContain("overflow-wrap:anywhere");
    expect(packageWarningException({ slug: "mu-demo", id: "starter", kind: "legacy-alias", resolvedTo: "Essential" }, "M&U demo line").title).toBe('M&U demo line: legacy package id "starter" used');
    const model = buildDashboard(dashInput({ feed: feed([client({ slug: "mu-demo" })], [org({ name: "M&U demo line" })]), packageWarnings: [{ slug: "mu-demo", id: "nonsense", kind: "unknown" }] }));
    const warning = model.exceptions.find((e) => e.id === "package:mu-demo");
    expect(warning?.title.startsWith("M&U demo line:")).toBe(true);
  });

  test("RX-12: the verdict's flagged count and the next step count the same calls", () => {
    const today = new Date(NOW - 60_000).toISOString();
    const s = buildReceptionistSnapshot(
      inputs([
        call({ id: "call_flag0001", startedAt: today, flags: ["FALSE_BOOKING"] }),
        call({ id: "call_flag0002", startedAt: today, flags: ["SMS_PROMISE"] }),
        // Flagged only for a stage direction: not a call to follow up, so not "flagged" here.
        call({ id: "call_style001", startedAt: today, flags: ["STAGE_DIRECTION"] }),
      ]),
      NOW,
    );
    expect(s.incidents).toHaveLength(2);
    expect(s.verdict.facts).toContain("3 real calls today · 2 flagged");
    expect(s.verdict.next).toBe("Follow up 2 flagged calls");
  });

  test("RX-12: 'Measured' shows the same Retell sample as the cost gate", () => {
    const s = buildReceptionistSnapshot(inputs([call({ durationSec: 180, usdCents: 40 })]), NOW);
    const gateLine = s.readiness.blockers.find((b) => b.id === "cost-reconciliation")!.evidence[0];
    expect(gateLine).toBe("Retell A$0.20/min measured on 1 call (3 min)");
    const html = render(<UsageAndEconomics data={buildDashboard(dashInput())} sell={{ data: s, error: null, isLoading: false }} />);
    const measured = tileHtml(html, "Measured");
    expect(measured).toContain("A$0.20/min");
    expect(measured).toContain("measured on 1 call");
    expect(measured).not.toContain("Not yet measured");
  });
});
