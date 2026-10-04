import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { buildDashboard, type DashboardInput } from "./dashboard";
import type { AgencyFeedState } from "./types";
import { Overview } from "../../src/components/receptionist/dashboard/overview";
import { CallsAndBookings } from "../../src/components/receptionist/dashboard/calls-bookings";
import { DashboardRetryProvider } from "../../src/components/receptionist/dashboard/shared";
import { mergeSellExceptions } from "../../src/components/receptionist/dashboard/sell-exceptions";
import { FlaggedCalls, SellVerdict } from "../../src/components/receptionist/dashboard/sell-status";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Blocker, Incident, ReceptionistSnapshot } from "./types";

// Server-render the dashboard's own tiles from synthetic models (in-memory router, no network): a feed
// that is down must never read as "0 open exceptions" in success colour.

const NOW = Date.now();
const AGENT_OK = { ok: true as const, name: "Synthetic Agent", voice: "voice-x", language: "en-AU", model: "model-x", published: true, webhook: true, webhookHost: "rx.example.test", webhookProbe: "protected" as const, modified: new Date(NOW - 3 * 86_400_000).toISOString(), prompt000: true, disclosure: true, recording: true, overseas: true, transfer: false, promptKnown: true, version: 3, llmVersion: 5 };
const input = (feed: AgencyFeedState): DashboardInput => ({
  now: NOW,
  providersReadAt: NOW,
  feed,
  agent: AGENT_OK,
  numberFacts: { ok: true, attached: true, version: 3, sms: false },
  twilio: { ok: true, connected: true, trunkSid: "TK_synthetic", balanceUsd: 42, month: { ok: true, usd: 1, balanceUsd: 42 } },
});
// A bare in-memory router, so the "Check ... in System" recovery link can render.
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/receptionist"] }) });
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <DashboardRetryProvider value={() => {}}>{el}</DashboardRetryProvider>
    </RouterContextProvider>,
  );

/** One SignalTile's markup, from its label to the next tile's label. */
function tileHtml(html: string, label: string): string {
  const start = html.indexOf(`<span class="min-w-0 [overflow-wrap:anywhere]">${label}</span>`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<span class="sh-signal-label">', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

test("feed unreachable: exceptions tile says it couldn't read, offers retry, and has no success tone", () => {
  const model = buildDashboard(input({ ok: false, reason: "Agency feed unreachable (TimeoutError)" }));
  const html = render(<Overview data={model} />);
  expect(html).not.toContain("No open exceptions");
  expect(html).toContain("Couldn&#x27;t read");
  expect(html).toContain("Feed unreachable, retry");
  const tile = tileHtml(html, "Open exceptions");
  expect(tile).toContain('data-state="failed"');
  expect(tile).not.toContain('data-tone="success"');
  expect(tile).not.toMatch(/>0</);
  // Channels still render from their own provider reads, with their update time.
  expect(html).toContain("Healthy");
  expect(html).toContain("Agent last edited 3 d ago");
});

test("fresh feed with nothing wrong: a real zero, with its update time", () => {
  const feed: AgencyFeedState = {
    ok: true, generatedAt: new Date(NOW - 5000).toISOString(), windowDays: 30, view: "metadata", organizations: [],
    totals: { calls: 0, completed: 0, failed: 0, avgDurationSeconds: null, totalMinutes: 0, byOutcome: [], bySentiment: [], qaGraded: 0, qaFlagged: 0, qaCriticalOpen: 0, triagePending: null, triageDone: null, oldestPendingTriageAt: null },
    calls: [], followUps: [], clients: [], deployment: null,
  };
  const model = buildDashboard(input(feed));
  // A real zero needs BOTH reads: the feed and a clean sell status (no incidents, every gate passed).
  const clean = snapshot({ incidents: [], blockers: [blocker({ state: "pass", done: true })] });
  const overview = render(<Overview data={model} exceptions={mergeSellExceptions({ items: model.exceptions, summary: model.exceptionSummary }, { data: clean, error: null, isLoading: false })} />);
  expect(overview).toContain("No open exceptions in the last reads (agency feed and sell status)");
  const tile = tileHtml(overview, "Open exceptions");
  expect(tile).toContain('data-tone="success" data-state="zero"');
  expect(tile).toContain("Updated just now");
  expect(overview).toContain("Updated just now");
  // Triage counts the feed didn't report show "Unknown", never 0.
  const calls = render(<CallsAndBookings data={model} />);
  expect(calls).toContain("The feed did not report triage counts");
  expect(calls).toMatch(/Pending[\s\S]*?Unknown/);
});

test("agency feed token rejected: the recovery points at System", () => {
  const model = buildDashboard(input({ ok: false, reason: "Agency feed rejected the token (HTTP 401)" }));
  const html = render(<Overview data={model} />);
  expect(html).toContain("Check the agency feed token in System");
  expect(html).toContain('href="/system"');
  expect(html).not.toContain("No open exceptions");
});

// ── Sell status from /__receptionist (owner 28 Sep: keep "Not safe to sell" and flagged calls) ──
function blocker(over: Partial<Blocker> = {}): Blocker {
  return { id: "no-false-actions", title: "No false bookings or texts", mode: "derived", done: false, evidence: ["0 of 5 clean real calls"], next: "Make the owner retest calls", state: "fail", ...over } as Blocker;
}
const TRANSCRIPT = "SYNTHETIC-TRANSCRIPT-LINE-must-never-render";
function incident(callId: string, flags: Incident["flags"]): Incident {
  return { callId, startedAt: new Date(NOW - 3_600_000).toISOString(), from: "+61400111222", flags, consequence: "Caller may expect a booking and an SMS that will not come.", retellUrl: `https://dashboard.retellai.com/calls/${callId}`, ...({ transcript: TRANSCRIPT } as object) } as Incident;
}
function snapshot(over: { incidents?: Incident[]; blockers?: Blocker[] } = {}): ReceptionistSnapshot {
  return {
    generatedAt: new Date(NOW - 60_000).toISOString(),
    verdict: { decision: "Not safe to sell", tone: "bad", facts: ["Answering on unpublished draft v0", "No real calls today", "0 of 5 gates passed", "2 callers may be expecting a booking or text"], next: "Follow up 2 flagged calls" },
    incidents: over.incidents ?? [incident("call_a", ["URGENT_NO_000"]), incident("call_b", ["FALSE_BOOKING", "SMS_PROMISE", "URGENT_NO_000", "CLINICAL_ADVICE"])],
    readiness: { blockers: over.blockers ?? [blocker(), blocker({ id: "urgent-wording", title: "Urgent wording", state: "not-tested" })], open: 2, facts: [], cleanStreak: { count: 0, target: 5 }, ownerRetestCalls: null },
    health: [],
  } as unknown as ReceptionistSnapshot;
}
const zeroFeed = (): AgencyFeedState => ({
  ok: true, generatedAt: new Date(NOW - 5000).toISOString(), windowDays: 30, view: "metadata", organizations: [],
  totals: { calls: 0, completed: 0, failed: 0, avgDurationSeconds: null, totalMinutes: 0, byOutcome: [], bySentiment: [], qaGraded: 0, qaFlagged: 0, qaCriticalOpen: 0, triagePending: 0, triageDone: 0, oldestPendingTriageAt: null },
  calls: [], followUps: [], clients: [], deployment: null,
});

test("feed with zero exceptions + /__receptionist incidents: count >= incidents and never 'No open exceptions'", () => {
  const model = buildDashboard(input(zeroFeed()));
  expect(model.exceptions).toEqual([]);
  const snap = snapshot();
  const merged = mergeSellExceptions({ items: model.exceptions, summary: model.exceptionSummary }, { data: snap, error: null, isLoading: false });
  expect(merged.summary.ok && merged.summary.count).toBeGreaterThanOrEqual(snap.incidents.length);
  const html = render(<Overview data={model} exceptions={merged} />);
  expect(html).not.toContain("No open exceptions");
  const tile = tileHtml(html, "Open exceptions");
  expect(tile).not.toContain('data-tone="success"');
  expect(tile).toMatch(/>4</); // 2 flagged calls + 2 open gates
  expect(html).toContain("Flagged call");
  expect(html).toContain("False booking"); // a flag label, not a raw code
  expect(html).not.toContain(TRANSCRIPT);
});

test("a feed exception for the same call is one row, keeping the higher severity", () => {
  const model = buildDashboard(input(zeroFeed()));
  const feedRow = { id: "call_a", severity: "warn" as const, title: "feed row", detail: "x", clientSlug: null };
  const merged = mergeSellExceptions({ items: [feedRow], summary: model.exceptionSummary }, { data: snapshot(), error: null, isLoading: false });
  expect(merged.items.filter((i) => i.id === "call_a")).toHaveLength(1);
  expect(merged.items.find((i) => i.id === "call_a")?.severity).toBe("critical");
});

test("sell status unreadable and feed clean: exceptions are failed/unknown, never 0 or green", () => {
  const model = buildDashboard(input(zeroFeed()));
  const merged = mergeSellExceptions({ items: model.exceptions, summary: model.exceptionSummary }, { data: undefined, error: new Error("Receptionist request failed (HTTP 500)"), isLoading: false });
  expect(merged.summary.ok).toBe(false);
  const html = render(<Overview data={model} exceptions={merged} />);
  expect(html).not.toContain("No open exceptions");
  expect(tileHtml(html, "Open exceptions")).not.toContain('data-tone="success"');
  const verdict = render(<SellVerdict sell={{ data: undefined, error: new Error("Receptionist request failed (HTTP 500)"), isLoading: false }} />);
  expect(verdict).toContain("Sell status unknown");
  // D1: the tone lives on data-tone (no side stripes); an unread status is neutral, never ok/green.
  expect(verdict).toContain('data-tone="neutral"');
  expect(verdict).not.toContain('data-tone="ok"');
  expect(verdict).not.toMatch(/success/);
});

test("Overview without a sell source never claims zero", () => {
  const model = buildDashboard(input(zeroFeed()));
  const html = render(<Overview data={model} />);
  expect(html).not.toContain("No open exceptions");
  expect(tileHtml(html, "Open exceptions")).not.toContain('data-tone="success"');
});

test("verdict and flagged calls render the /__receptionist facts, metadata only", () => {
  const snap = snapshot();
  const verdict = render(<SellVerdict sell={{ data: snap, error: null, isLoading: false }} />);
  expect(verdict).toContain("Not safe to sell");
  expect(verdict).toContain("0 of 5 gates passed");
  expect(verdict).toContain("Follow up 2 flagged calls");
  expect(verdict).toContain("Source: /__receptionist");
  expect(verdict).toContain('data-tone="bad"');
  expect(verdict).not.toContain("border-l-");
  const calls = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><FlaggedCalls incidents={snap.incidents} /></QueryClientProvider>);
  expect(calls.match(/data-flagged-call=/g)).toHaveLength(2);
  expect(calls).toContain("••• 222");
  expect(calls).not.toContain("+61400111222");
  expect(calls).toContain("https://dashboard.retellai.com/calls/call_b");
  expect(calls).not.toContain(TRANSCRIPT);
  expect(calls).not.toContain("FALSE_BOOKING"); // labels, not raw codes
});

// ── D1 (29 Sep): the calm redesign keeps every honest state, folded rather than removed ──────────
function d1Snapshot() {
  const snap = snapshot();
  snap.verdict.checks = [
    { id: "answering", label: "Answering on a published agent, webhook verified", ok: false, detail: "Answering on unpublished draft v0" },
    { id: "flagged-calls", label: "No flagged calls open", ok: false, detail: "2 flagged calls to follow up" },
    { id: "go-live-verdict", label: "MU-Receptionist go-live verdict", ok: false, detail: "Not safe" },
    { id: "feed-qa", label: "No open critical QA flags", ok: false, unknown: true, detail: "Unknown · agency feed not read" },
    { id: "checklist", label: "Owner console go-live steps (informational)", ok: false, informational: true, detail: "1 of 14 verified" },
    { id: "evals", label: "Eval report passing", ok: false, detail: "No eval report on file" },
    { id: "gates", label: "Go-live gates passed with evidence", ok: false, detail: "0 of 5 passed with evidence" },
    { id: "retests", label: "Followed-up calls retested", ok: true, detail: "None awaiting a retest" },
  ];
  (snap as { calls: unknown }).calls = { ok: true, windows: [{ label: "Today", count: 3, answered: 2 }, {}, {}], recent: [], latencyTrend: [], flagTotals: {} };
  return snap;
}

test("D1 tiles + next step: four big answers, short words, one gold action", async () => {
  const { SummaryTiles, NextStepBar, shortFact } = await import("../../src/components/receptionist/dashboard/sell-status");
  const snap = d1Snapshot();
  const sell = { data: snap, error: null, isLoading: false };
  const tiles = render(<SummaryTiles sell={sell} onOpen={() => {}} />);
  expect(tiles.match(/data-tile=/g)).toHaveLength(4);
  expect(tiles.match(/<button type="button"/g)).toHaveLength(4); // every tile opens its section
  expect(tiles).toContain(">Not safe<");
  expect(tiles).toContain("(Not safe to sell)"); // the full decision for screen readers
  // L10 (29 Sep 2026): the fraction is stated in words, not drawn as a ring.
  expect(tiles).not.toContain('role="progressbar"');
  expect(tiles).not.toMatch(/aria-label="\d+ of \d+ (?:requirements met|gates passed)"/);
  expect(tiles).toContain("1 of 7 met");
  expect(tiles).toMatch(/Calls today[\s\S]*?>3<[\s\S]*?2 answered/);
  expect(tiles).toContain(">2 urgent<"); // flagged, urgent highlighted
  expect(tiles).toContain(">0/2<"); // gates passed of total, as a plain number
  expect(tiles.match(/text-danger/g)).toHaveLength(2); // the verdict value and the urgent count only
  const next = render(<NextStepBar sell={sell} onOpen={() => {}} />);
  expect(next).toContain("Follow up 2 flagged calls");
  expect(next).toContain(">Open flagged calls<");
  // R12 rollout: the page's one gold action is the header's Refresh calls (launch on hold); the next step's button is quiet.
  expect(next).not.toContain("bg-brand text-brand-foreground");
  // Unread status: unknown tiles, a retry, never green.
  const unread = { data: undefined, error: new Error("HTTP 500"), isLoading: false };
  const unknownTiles = render(<SummaryTiles sell={unread} onOpen={() => {}} />);
  expect(unknownTiles).toContain("Couldn&#x27;t read status");
  expect(unknownTiles).not.toMatch(/success/);
  expect(render(<NextStepBar sell={unread} onOpen={() => {}} onRetry={() => {}} />)).toContain(">Retry<");
  // Chips are short labels; unknown phrasings pass through unchanged.
  expect(shortFact("Answering on unpublished draft v0")).toBe("Draft v0");
  expect(shortFact("1 real call today · 1 flagged")).toBe("1 call today · 1 flagged");
  expect(shortFact("0 of 5 gates passed · 2 failing")).toBe("0/5 gates · 2 failing");
  expect(shortFact("2 callers may be expecting a booking or text")).toBe("2 may expect a booking or text");
  expect(shortFact("Retell unreachable: HTTP 500")).toBe("Retell unreachable: HTTP 500");
});

test("D1 verdict (Go-live tab): decision, short why, every requirement with its word, sources behind (i)", () => {
  const snap = d1Snapshot();
  const html = render(<SellVerdict sell={{ data: snap, error: null, isLoading: false }} />);
  const decision = html.indexOf("Not safe to sell");
  const why = html.indexOf("6 of 7 requirements not met (1 unknown)");
  expect(decision).toBeGreaterThan(-1);
  expect(why).toBeGreaterThan(decision);
  expect(html).toContain("Follow up 2 flagged calls"); // the next step, as text (the gold button is the page's)
  expect(html).not.toContain("bg-brand text-brand-foreground");
  expect(html).toContain(">Draft v0<"); // short chips, full fact in the title
  expect(html).toContain('title="Answering on unpublished draft v0"');
  // L10: a plain big number with one line under it instead of a ring.
  expect(html).toContain('data-requirements-tally=""');
  expect(html).toMatch(/data-requirements-tally[^>]*>[\s\S]*?>1\/7<[\s\S]*?requirements met/);
  expect(html).not.toContain('role="progressbar"');
  for (const c of snap.verdict.checks!) expect(html).toContain(`data-sell-check="${c.id}"`);
  expect(html.match(/>Not met</g)).toHaveLength(5);
  expect(html).toContain(">Unknown<");
  expect(html).toContain(">Info<");
  expect(html).toContain(">1 met<"); // the met one folds into a single line
  const notMet = html.slice(html.indexOf('data-sell-check="evals"'));
  expect(notMet.slice(0, notMet.indexOf("</li>"))).not.toMatch(/danger/);
  expect(html.match(/text-danger/g)).toHaveLength(1); // the verdict mark only
  // Provenance is behind (i), still on the page.
  expect(html).toContain('aria-label="Sources"');
  expect(html).toMatch(/role="note" hidden=""[^>]*>[\s\S]*Source: \/__receptionist/);
});

test("D1 flagged calls: one line per call (first label, time, dot), the rest folded, danger only when urgent", () => {
  const snap = snapshot();
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><FlaggedCalls incidents={snap.incidents} /></QueryClientProvider>);
  expect(html).toContain("Flagged calls");
  expect(html).toMatch(/>2<span class="sr-only"> calls<\/span>/); // review F11: hidden text, not aria-label
  expect(html).toContain('aria-label="About flagged calls"'); // the explanation is behind (i)
  expect(html).toMatch(/role="note" hidden=""[^>]*>Real calls flagged/);
  // Both calls include "Urgent, no 000": urgent, and it leads the summary.
  expect(html.match(/data-severity="urgent"/g)).toHaveLength(2);
  expect(html.match(/>Urgent</g)).toHaveLength(2);
  expect(html.match(/>Urgent, no 000</g)).toHaveLength(2);
  // Every label once; the others and the consequence behind Details.
  expect(html.match(/False booking/g)).toHaveLength(1);
  expect(html.indexOf("Clinical advice")).toBeGreaterThan(html.lastIndexOf('inert=""', html.indexOf("Clinical advice")));
  expect(html).toContain("Details · 3 more flags");
  expect(html.indexOf("Caller may expect a booking")).toBeGreaterThan(html.indexOf('inert=""'));
  // A call that isn't urgent is "Follow up" (warn dot), never red.
  const calm = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><FlaggedCalls incidents={[incident("call_c", ["FALSE_BOOKING", "SMS_PROMISE"])]} /></QueryClientProvider>);
  expect(calm).toContain('data-severity="attention"');
  expect(calm).toContain(">Follow up<");
  expect(calm).toContain(">False booking<");
  expect(calm).not.toMatch(/danger/);
});

test("D1 overview: only the top two attention cards, with a way to the rest", async () => {
  const { TopAttention } = await import("../../src/components/receptionist/dashboard/sell-status");
  const snap = snapshot({ incidents: [incident("call_a", ["URGENT_NO_000"]), incident("call_b", ["FALSE_BOOKING"]), incident("call_c", ["SMS_PROMISE"])] });
  (snap as { calls: unknown }).calls = { ok: true };
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><TopAttention sell={{ data: snap, error: null, isLoading: false }} onOpen={() => {}} /></QueryClientProvider>);
  expect(html.match(/data-overview-call=/g)).toHaveLength(2);
  expect(html).not.toContain("data-flagged-call="); // no duplicate anchors: the Calls tab owns them
  expect(html).toContain(">See all 3<");
});

test("D1 gates: N of M in words (no ring), each gate one calm row, evidence and 'not yet tracked' kept", async () => {
  const { Gates } = await import("../../src/components/receptionist/gates");
  const snap = snapshot({ blockers: [blocker(), blocker({ id: "urgent-wording", title: "Urgent wording", state: "not-tested" }), blocker({ id: "compliance", title: "Compliance", mode: "manual", state: "open", next: "Hear the disclosure" })] });
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Gates data={{ ...snap.readiness, facts: [{ id: "sms", label: "SMS", tone: "warn", detail: "Not configured on the number" }] }} /></QueryClientProvider>);
  expect(html).not.toContain('aria-label="0 of 3 gates passed"'); // L10: no ring, the words carry it
  expect(html).not.toContain('role="progressbar"');
  expect(html).toContain("0 of 3 passed");
  expect(html).toContain("Automated tests: Not available");
  expect(html).toContain("Owner retests: not tracked");
  expect(html).toContain("Automated test evidence: Not available"); // the full wording, behind (i)
  expect(html).toContain("Owner retest calls: not yet tracked — count from Retell call history");
  expect(html.match(/data-gate=/g)).toHaveLength(3);
  for (const word of [">Fail<", ">Not tested<", ">Awaiting owner sign-off<"]) expect(html).toContain(word);
  expect(html).toContain("0 of 5 clean real calls"); // evidence folded, not removed
  expect(html).toContain("Make the owner retest calls");
  expect(html).toContain(">Sign off</button>"); // beside the row, not inside its trigger
  expect(html).toContain("Not configured on the number");
  expect(html).not.toMatch(/danger/); // a failing gate is warn; the verdict carries the alarm
  // Review F2: a fact whose source couldn't be read says Unknown, never Info.
  const unknownFact = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Gates data={{ ...snap.readiness, facts: [{ id: "sms", label: "SMS", tone: "neutral", detail: "SMS: Unknown" }] }} /></QueryClientProvider>);
  const fact = unknownFact.slice(unknownFact.indexOf('data-fact="sms"'));
  expect(fact.slice(0, fact.indexOf("</li>"))).toContain(">Unknown<");
  expect(fact.slice(0, fact.indexOf("</li>"))).not.toContain(">Info<");
});

test("review F3: a critical production-QA review is its own severity, named in words", () => {
  const i = { ...incident("call_q", ["FALSE_BOOKING"]), qaCodes: ["BOOKING_CLAIMED_NOT_RECORDED"], qaCritical: true, qaReview: "PENDING", sources: ["retell", "production QA"] } as Incident;
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><FlaggedCalls incidents={[i]} /></QueryClientProvider>);
  expect(html).toContain('data-severity="critical"');
  expect(html).toContain(">Critical<");
  expect(html).toContain("Critical, not yet reviewed");
  expect(html).not.toMatch(/danger/); // critical is amber; red stays for urgent calls
});
