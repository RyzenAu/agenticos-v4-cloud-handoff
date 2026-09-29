// UI-truth H5 + L4 (28 Sep 2026): "Safe to sell" only when EVERY required condition holds.
// Coordinator follow-up (28 Sep): the go-live condition is MU-Receptionist's ENFORCED top-level
// `goLive.verdict === "safe"` plus no open critical `qaFlags`; the 14-step OS checklist is shown
// but informational (its per-client steps are what goLive records).
// Mutation-killing: one all-satisfied fixture is safe; each test below breaks exactly ONE condition
// and the verdict must be "Not safe to sell" with that condition's check reported not met.
import { describe, expect, test } from "bun:test";
import { buildReceptionistSnapshot, RETEST_TARGET, webhookHealth, type SnapshotInputs } from "./aggregate";
import { call, NOW } from "./aggregate.test";
import { GO_LIVE_STEPS, type ChecklistStepStatus } from "./checklist";
import { projectAgencyFeed } from "./agency-feed";
import type { FeedClient, FeedData, FeedGoLive, FeedQaFlag, SellCheck } from "./types";
import { sellCheckException } from "../../src/components/receptionist/dashboard/sell-exceptions";

const PROMPT_CHANGED = new Date(NOW - 3 * 3_600_000).toISOString();
const SIGNED = new Date(NOW - 2 * 3_600_000).toISOString();
// Before the prompt change: a flag AFTER it would (rightly) fail the no-false-actions gate too.
const INCIDENT_AT = new Date(NOW - 4 * 3_600_000).toISOString();

function demoClient(goLive: FeedClient["readiness"]["goLive"] = { ready: true, blockers: [] }): FeedClient {
  return {
    organizationId: "org_demo",
    slug: "mu-demo-line",
    isDemoTenant: true,
    bookings: { byStatus: { CONFIRMED: 1 }, total: 1, madeOnCalls: 1, sandbox: 0, upcoming: 1 },
    handoffs: { transfersByStatus: { CONNECTED: 1 }, alertsByReason: {}, alertsByStatus: { SENT: 1 } },
    minutesThisMonth: { monthStart: "2026-09-01T00:00:00Z", calls: 6, callMinutes: 18, billableMinutesCurrentPeriod: 18 },
    readiness: {
      agentMapped: true, inboundNumberSet: true, calendarRequested: "GOOGLE", calendarInUse: "GOOGLE", calendarReason: "configured",
      liveCalendar: true, demoDiaryConfirmed: true, bookingOutcome: "confirmed", alertMailboxSet: true, transferEnabled: true,
      smsEnabled: true, retentionDays: 90, retellRetentionAligned: "unverified", goLive,
    },
  };
}

function feed(over: Partial<FeedData> = {}): FeedData & { ok: true } {
  return {
    ok: true,
    generatedAt: new Date(NOW - 60_000).toISOString(),
    windowDays: 30,
    view: "full",
    organizations: [{ id: "org_demo", name: "M&U demo line", niche: "DENTAL", isDemoTenant: true, inboundNumberMasked: "••• 208" }],
    totals: { calls: 6, completed: 6, failed: 0, avgDurationSeconds: 180, totalMinutes: 18, byOutcome: [], bySentiment: [], qaGraded: 6, qaFlagged: 0, qaCriticalOpen: 0, triagePending: 0, triageDone: 1, oldestPendingTriageAt: null },
    calls: [],
    followUps: [],
    clients: [demoClient()],
    deployment: { retellWebhookSecretSet: true, alertEmailChannelLive: true, cronSecretValid: true, trustProxyHeaders: true, transferExecutionEnabled: true },
    goLive: goLive(),
    qaFlags: [],
    ...over,
  };
}

/** The enforced verdict: one real client, safe, tested on its current configuration. */
function goLive(over: Partial<FeedGoLive> = {}): FeedGoLive {
  return {
    verdict: "safe",
    perClient: [{ orgId: "org_client", verdict: "safe", testRecordAt: "2026-09-27T09:00:00Z", configHash: "cfg1", missing: [], blockers: [], liveAt: "2026-09-27T10:00:00Z" }],
    checkedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}
const flag = (over: Partial<FeedQaFlag> = {}): FeedQaFlag => ({ callId: "call_prodqa0001", codes: ["TRANSFER_PROMISED_NOT_ATTEMPTED", "URGENT_CALL"], severity: "FLAG", orgId: null, at: new Date(NOW - 600_000).toISOString(), ...over });

const allVerified = (): ChecklistStepStatus[] => GO_LIVE_STEPS.map((s) => ({ ...s, status: "verified" as const, evidence: ["recorded"] }));

/** Five clean owner retests after the prompt change AND after the followed-up incident. */
const retests = (n = RETEST_TARGET, at = (k: number) => new Date(NOW - (k + 1) * 60_000).toISOString()) =>
  Array.from({ length: n }, (_, k) => call({ id: `call_retest${k}0`, startedAt: at(k), ownerTestBy: "Usman" }));

/** Every condition satisfied — including a followed-up flagged call whose recorded retests passed. */
function satisfied(): SnapshotInputs {
  return {
    agentId: "agent_fixture",
    number: "+61485011208",
    agent: {
      ok: true, name: "Demo", voice: "voice-x", language: "en-AU", model: "model-x", published: true, version: 4,
      webhook: true, webhookHost: "rx.example.test", webhookProbe: "protected", modified: PROMPT_CHANGED,
      promptKnown: true, prompt000: true, disclosure: true, recording: true, overseas: true, transfer: true,
    },
    numberFacts: { ok: true, attached: true, version: 4, sms: true },
    calls: {
      ok: true,
      rows: [
        ...retests(),
        call({ id: "call_flagged01", startedAt: INCIDENT_AT, flags: ["SMS_PROMISE"], from: "••• 615" }),
      ],
    },
    twilio: { ok: true, connected: true, trunkSid: "TK_fixture", balanceUsd: 40, month: { ok: true, usd: 3, balanceUsd: 40 } },
    evals: { ok: true, passed: 12, total: 12, reports: 1, date: "2026-09-27" },
    agencyFeed: feed(),
    legal: "present",
    leads: { ok: false, reason: "CRM not found" },
    signoffs: {
      "urgent-wording": { done: true, by: "Usman", at: SIGNED },
      compliance: { done: true, by: "Usman", at: SIGNED },
      "hours-handoff": { done: true, by: "Usman", at: SIGNED },
      "cost-reconciliation": { done: true, by: "Usman", at: SIGNED },
    },
    followedUp: { call_flagged01: { by: "Usman", at: SIGNED } },
    fx: { usdToAud: 1.5, asOf: "2026-09-26", source: "fixture" },
    checklist: allVerified(),
  };
}

const build = (i: SnapshotInputs) => buildReceptionistSnapshot(i, NOW);
const check = (s: ReturnType<typeof build>, id: SellCheck["id"]) => s.verdict.checks!.find((c) => c.id === id)!;
/** Not safe, and the failing checks are EXACTLY `failing` + `also` (the mutation broke nothing else). */
function expectNotSafe(i: SnapshotInputs, failing: SellCheck["id"], also: SellCheck["id"][] = []) {
  const s = build(i);
  expect(s.verdict.decision).toBe("Not safe to sell");
  expect(s.verdict.tone).not.toBe("ok");
  expect(check(s, failing).ok).toBe(false);
  // Required checks only: the informational owner-console checklist never decides the verdict.
  expect(s.verdict.checks!.filter((c) => !c.ok && !c.informational).map((c) => c.id).sort()).toEqual([failing, ...also].sort());
  return s;
}

describe("H5: Safe to sell requires every condition", () => {
  test("all satisfied (incl. a followed-up call with its recorded retests): Safe to sell", () => {
    const s = build(satisfied());
    expect(s.verdict.checks!.filter((c) => !c.ok)).toEqual([]);
    expect(s.verdict.decision).toBe("Safe to sell");
    expect(s.verdict.tone).toBe("ok");
    expect(s.incidents).toEqual([]);
    expect(s.awaitingRetest).toEqual([]);
  });

  test("enforced go-live verdict absent from the feed (older deployment): not safe", () => {
    const i = satisfied();
    i.agencyFeed = feed({ goLive: null });
    expect(check(expectNotSafe(i, "go-live-verdict"), "go-live-verdict").detail).toContain("no enforced go-live verdict");
  });

  test("go-live verdict not-safe: not safe, and the client's blockers are shown", () => {
    const i = satisfied();
    i.agencyFeed = feed({ goLive: goLive({ verdict: "not-safe", perClient: [{ orgId: "org_client", verdict: "not-safe", testRecordAt: null, configHash: "cfg2", missing: ["routing"], blockers: ["routing: awaiting-test"], liveAt: null }] }) });
    expect(check(expectNotSafe(i, "go-live-verdict"), "go-live-verdict").detail).toContain("routing: awaiting-test");
  });

  test("go-live verdict unknown: not safe (unknown is not a pass)", () => {
    const i = satisfied();
    i.agencyFeed = feed({ goLive: goLive({ verdict: "unknown" }) });
    expectNotSafe(i, "go-live-verdict");
  });

  test("no real client (not-safe, empty perClient): not safe", () => {
    const i = satisfied();
    i.agencyFeed = feed({ goLive: goLive({ verdict: "not-safe", perClient: [] }) });
    expect(check(expectNotSafe(i, "go-live-verdict"), "go-live-verdict").detail).toContain("no real client");
  });

  test("the old per-client readiness.goLive can't stand in for the enforced verdict", () => {
    const i = satisfied();
    i.agencyFeed = feed({ goLive: null, clients: [demoClient({ ready: true, blockers: [] })] });
    expectNotSafe(i, "go-live-verdict");
  });

  test("a not-ready per-client readiness row doesn't override an enforced safe verdict", () => {
    const i = satisfied();
    i.agencyFeed = feed({ clients: [demoClient(null)] });
    expect(build(i).verdict.decision).toBe("Safe to sell");
  });

  test("agency feed unavailable: not safe (unknown is not a pass)", () => {
    const i = satisfied();
    i.agencyFeed = { ok: false, reason: "Agency feed unreachable (TimeoutError)" };
    i.checklist = undefined;
    expectNotSafe(i, "go-live-verdict", ["feed-qa"]);
  });

  test("an open critical QA flag (feed counter): not safe", () => {
    const i = satisfied();
    const f = feed();
    f.totals.qaCriticalOpen = 1;
    i.agencyFeed = f;
    expectNotSafe(i, "feed-qa");
  });

  test("the feed reported neither qaFlags nor the critical counter: not safe", () => {
    const i = satisfied();
    const f = feed({ qaFlags: null });
    f.totals.qaCriticalOpen = null;
    i.agencyFeed = f;
    expectNotSafe(i, "feed-qa");
  });

  test("the qaFlags list stands in for an unreported counter", () => {
    const i = satisfied();
    const f = feed();
    f.totals.qaCriticalOpen = null;
    i.agencyFeed = f;
    expect(build(i).verdict.decision).toBe("Safe to sell");
  });

  test("an open critical flag in qaFlags (unattributed, metadata view): not safe, and it's a flagged call", () => {
    const i = satisfied();
    i.agencyFeed = feed({ view: "metadata", qaFlags: [flag()] });
    const s = expectNotSafe(i, "feed-qa", ["flagged-calls"]);
    const incident = s.incidents.find((x) => x.callId === "call_prodqa0001")!;
    expect(incident).toMatchObject({ qaCritical: true, client: null, sources: ["production QA"] });
    expect(incident.qaCodes).toEqual(["TRANSFER_PROMISED_NOT_ATTEMPTED", "URGENT_CALL"]);
  });

  test("a qaFlags entry with no severity counts as critical", () => {
    const i = satisfied();
    i.agencyFeed = feed({ qaFlags: [flag({ severity: null })] });
    expectNotSafe(i, "feed-qa", ["flagged-calls"]);
  });

  test("a below-critical open flag isn't a critical flag, but it's still a flagged call to follow up", () => {
    const i = satisfied();
    i.agencyFeed = feed({ qaFlags: [flag({ severity: "WARN", codes: ["CALLER_FRUSTRATED"] })] });
    expectNotSafe(i, "flagged-calls");
  });

  test("a qaFlags entry for a local Retell call merges into that call (one entry)", () => {
    const i = satisfied();
    i.followedUp = {};
    i.agencyFeed = feed({ qaFlags: [flag({ callId: "call_flagged01", severity: "WARN", codes: ["HUMAN_REQUEST_UNMET"] })] });
    const s = build(i);
    const same = s.incidents.filter((x) => x.callId === "call_flagged01");
    expect(same).toHaveLength(1);
    expect(same[0].sources).toEqual(["retell", "production QA"]);
    expect(same[0].flags).toEqual(["SMS_PROMISE"]);
  });

  test("an open FLAG-band QA call even with a zero counter: not safe", () => {
    const i = satisfied();
    i.agencyFeed = feed({ calls: [{ id: "fc_1", organizationId: "org_demo", providerCallId: null, callType: null, status: null, outcome: null, sentiment: null, callerMasked: "••• 999", startedAt: new Date(NOW - 600_000).toISOString(), endedAt: null, durationSeconds: 60, disconnectionReason: null, summary: null, qa: { flagCount: 1, topBand: "FLAG", reviewStatus: "PENDING", flagCodes: ["HUMAN_REQUEST_UNMET"] } }] });
    // The same call is also an open flagged call (one entry): two conditions, one cause.
    expectNotSafe(i, "feed-qa", ["flagged-calls"]);
  });

  test("the owner-console checklist is informational: an incomplete one doesn't block when goLive is safe", () => {
    const i = satisfied();
    i.checklist = allVerified().map((s) => (s.id === "deploy" || s.id === "migrations" ? { ...s, status: "in-progress" as const } : s));
    const s = build(i);
    expect(s.verdict.decision).toBe("Safe to sell");
    expect(check(s, "checklist")).toMatchObject({ ok: false, informational: true });
    expect(check(s, "checklist").detail).toContain("12 of 14 verified");
  });

  test("steps the feed can't see stay unknown on display, and don't block", () => {
    const i = satisfied();
    i.checklist = undefined;
    const s = build(i);
    expect(s.verdict.decision).toBe("Safe to sell");
    expect(check(s, "checklist").detail).toMatch(/\d+ not visible from the feed \(unknown\)/);
    // the first failing *required* check drives "next", never the informational checklist
    expect(s.verdict.next).not.toMatch(/checklist/i);
  });

  test("the informational checklist never becomes a sell exception", () => {
    const i = satisfied();
    i.checklist = undefined;
    const c = check(build(i), "checklist");
    expect(c.ok).toBe(false);
    expect(sellCheckException(c)).toBeNull();
    expect(sellCheckException({ ...c, informational: undefined })).not.toBeNull();
  });

  test("the checklist can't rescue an unsafe goLive either", () => {
    const i = satisfied();
    i.agencyFeed = feed({ goLive: goLive({ verdict: "not-safe" }) });
    expectNotSafe(i, "go-live-verdict");
  });

  test("no eval report on file: not safe", () => {
    const i = satisfied();
    i.evals = { ok: false, reason: "No eval report on file" };
    expectNotSafe(i, "evals");
  });

  test("eval report with a failing scenario: not safe", () => {
    const i = satisfied();
    i.evals = { ok: true, passed: 11, total: 12, reports: 1, date: "2026-09-27" };
    expectNotSafe(i, "evals");
  });

  test("hours/handoff signed off while 'Transfer tool on agent: no': not safe", () => {
    const i = satisfied();
    if (i.agent.ok) i.agent.transfer = false;
    const s = expectNotSafe(i, "gates");
    expect(s.readiness.blockers.find((b) => b.id === "hours-handoff")).toMatchObject({ state: "evidence-missing", done: false, evidencePresent: false });
  });

  test("cost reconciliation signed off without the Twilio month: not safe", () => {
    const i = satisfied();
    if (i.twilio.ok) i.twilio.month = { ok: false, reason: "Twilio usage unavailable" };
    expect(expectNotSafe(i, "gates").readiness.blockers.find((b) => b.id === "cost-reconciliation")?.state).toBe("evidence-missing");
  });

  test("compliance signed off while the prompt lacks recording consent (no prompt change since): not safe", () => {
    const i = satisfied();
    if (i.agent.ok) i.agent.recording = false;
    expectNotSafe(i, "gates");
  });

  test("followed up but fewer than the recorded retests: not safe, the follow-up is still recorded", () => {
    const i = satisfied();
    if (i.calls.ok) i.calls.rows = [...retests(RETEST_TARGET - 1), call({ id: "call_flagged01", startedAt: INCIDENT_AT, flags: ["SMS_PROMISE"], from: "••• 615" }), call({ id: "call_plain0001", startedAt: new Date(NOW - 30 * 60_000).toISOString() })];
    const s = expectNotSafe(i, "retests");
    expect(s.incidents).toEqual([]);
    expect(s.awaitingRetest?.map((x) => [x.callId, x.followedUp?.by])).toEqual([["call_flagged01", "Usman"]]);
  });

  test("followed up, but the retests were made BEFORE the flagged call: not safe", () => {
    const i = satisfied();
    // Clean calls since the prompt change keep every gate passing; the owner's retests all predate the call.
    const clean = Array.from({ length: 5 }, (_, k) => call({ id: `call_clean00${k}`, startedAt: new Date(NOW - (k + 1) * 60_000).toISOString() }));
    const early = retests(RETEST_TARGET, (k) => new Date(Date.parse(INCIDENT_AT) - (k + 1) * 60_000).toISOString());
    if (i.calls.ok) i.calls.rows = [...clean, ...early, call({ id: "call_flagged01", startedAt: INCIDENT_AT, flags: ["SMS_PROMISE"], from: "••• 615" })];
    expectNotSafe(i, "retests");
  });

  test("a flagged call not followed up: not safe", () => {
    const i = satisfied();
    i.followedUp = {};
    expectNotSafe(i, "flagged-calls");
  });

  test("agent not published: not safe", () => {
    const i = satisfied();
    if (i.agent.ok) i.agent.published = false;
    expectNotSafe(i, "answering");
  });
});

describe("L4: an unprobed webhook is unknown, never green", () => {
  test("configured but not probed: neutral 'unverified', with a next step", () => {
    const h = webhookHealth({ ...(satisfied().agent as Extract<SnapshotInputs["agent"], { ok: true }>), webhookProbe: undefined });
    expect(h.tone).toBe("neutral");
    expect(h.headline).toBe("Webhook unverified");
    expect(h.next).toBeTruthy();
  });

  test("an unprobed webhook keeps the verdict unsafe", () => {
    const i = satisfied();
    if (i.agent.ok) i.agent.webhookProbe = undefined;
    expectNotSafe(i, "answering");
  });
});

describe("enforced goLive and qaFlags in the agency feed (Review R2, both views)", () => {
  const body = (extra: Record<string, unknown>) => ({ version: 1, generatedAt: "2026-09-28T00:00:00Z", totals: {}, calls: [], followUps: [], ...extra });
  const read = (extra: Record<string, unknown>) => {
    const s = projectAgencyFeed(body(extra));
    if (!s.ok) throw new Error("feed");
    return s;
  };
  test("goLive is kept only with a known verdict; a malformed value is absent (never safe)", () => {
    const g = read({ goLive: { verdict: "safe", checkedAt: "2026-09-28T00:00:00Z", perClient: [{ orgId: "org_1", verdict: "safe", testRecordAt: "2026-09-27T00:00:00Z", configHash: "abc", missing: [], blockers: [], liveAt: null }, { orgId: "org_2", verdict: "SAFE" }, { verdict: "safe" }] } }).goLive!;
    expect(g.verdict).toBe("safe");
    expect(g.perClient.map((c) => [c.orgId, c.verdict])).toEqual([["org_1", "safe"], ["org_2", "unknown"]]);
    expect(read({ goLive: { verdict: "SAFE" } }).goLive).toBeNull();
    expect(read({ goLive: { verdict: true } }).goLive).toBeNull();
    expect(read({}).goLive).toBeNull();
  });
  test("qaFlags keep codes only (no free text); absent is null, empty is []", () => {
    const f = read({ qaFlags: [{ callId: "call_x1", codes: ["URGENT_CALL", "free text here"], severity: "FLAG", orgId: null, at: "2026-09-28T00:00:00Z", transcript: "never" }, { codes: ["X"] }] }).qaFlags!;
    expect(f).toEqual([{ callId: "call_x1", codes: ["URGENT_CALL"], severity: "FLAG", orgId: null, at: "2026-09-28T00:00:00.000Z" }]);
    expect(JSON.stringify(f)).not.toContain("never");
    expect(read({}).qaFlags).toBeNull();
    expect(read({ qaFlags: [] }).qaFlags).toEqual([]);
  });
});

describe("go-live field in the agency feed (MU-Receptionist clients[].readiness.goLive)", () => {
  const body = (goLive: unknown) => ({
    version: 1, generatedAt: "2026-09-28T00:00:00Z", totals: {}, calls: [], followUps: [],
    clients: [{ organizationId: "org_1", readiness: { goLive } }],
  });
  const read = (goLive: unknown) => {
    const s = projectAgencyFeed(body(goLive));
    if (!s.ok) throw new Error("feed");
    return s.clients[0].readiness.goLive;
  };
  test("ready only when the feed says exactly true; blockers kept as short strings", () => {
    expect(read({ ready: true, blockers: [] })).toEqual({ ready: true, blockers: [] });
    expect(read({ ready: false, blockers: ["booking: awaiting-test", 7] })).toEqual({ ready: false, blockers: ["booking: awaiting-test"] });
  });
  test("absent or malformed is null (not ready), never true", () => {
    expect(read(undefined)).toBeNull();
    expect(read({ ready: "yes" })).toBeNull();
    expect(read([true])).toBeNull();
  });
});

describe("merge review U3: a failed calls read is unknown, never 'Met'", () => {
  test("calls unreadable: the flagged-calls check is not met and says unknown", () => {
    const i = satisfied();
    i.calls = { ok: false, reason: "Retell calls unavailable" };
    const s = build(i);
    expect(s.verdict.decision).not.toBe("Safe to sell");
    const c = check(s, "flagged-calls");
    expect(c.ok).toBe(false);
    expect(c.detail).toBe("Unknown · couldn't read calls (Retell calls unavailable)");
  });

  test("the Flagged calls panel never says 'No flagged calls' when calls couldn't be read", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { FlaggedCalls } = await import("../../src/components/receptionist/dashboard/sell-status");
    const unread = renderToStaticMarkup(createElement(FlaggedCalls, { incidents: [], callsUnread: "Retell calls unavailable" }));
    expect(unread).toContain("Unknown · couldn&#x27;t read calls");
    expect(unread).not.toContain("No flagged calls waiting");
    const read = renderToStaticMarkup(createElement(FlaggedCalls, { incidents: [] }));
    expect(read).toContain("No flagged calls waiting for follow-up");
  });
});
