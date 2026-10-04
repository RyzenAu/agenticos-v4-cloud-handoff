import { expect, test } from "bun:test";
import { buildReceptionistSnapshot, type SnapshotInputs } from "./aggregate";
import type { CallRow } from "./types";
import { DEFAULT_OFFER_PACKAGE_ID, economics } from "./commercial";
import { getReceptionistPackage } from "../../src/lib/receptionist-packages";
export const NOW = Date.parse("2026-09-26T02:00:00Z");
export function call(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "one",
    kind: "phone",
    startedAt: new Date(NOW - 60_000).toISOString(),
    durationSec: 183,
    from: "+61412345208",
    status: "ended",
    disconnectReason: "user_hangup",
    latencyP50Ms: 100,
    latencyP90Ms: 200,
    usdCents: 42.95,
    summary: "Asked about opening hours.",
    summarySource: "first-sentence",
    sentiment: "Neutral",
    successful: true,
    flags: [],
    checked: true,
    retellUrl: "https://dashboard.retellai.com/call-history?history=one",
    ...overrides,
  };
}
export function inputs(rows = [call(), call({ id: "web", kind: "web" })]): SnapshotInputs {
  return {
    agentId: "agent_fixture",
    number: "+61485011208",
    agent: {
      ok: true,
      name: "Demo",
      voice: "retell-Leland",
      language: "en-AU",
      model: "claude-4.5-haiku",
      published: true,
      webhook: false,
      modified: undefined,
      promptKnown: true,
      prompt000: true,
      disclosure: true,
      recording: false,
      overseas: false,
      transfer: false,
    },
    numberFacts: { ok: true, attached: true, version: 2, sms: false },
    calls: { ok: true, rows },
    twilio: {
      ok: true,
      connected: true,
      trunkSid: "fixture",
      balanceUsd: 11.726,
      month: { ok: true, usd: 8.274, balanceUsd: 11.726 },
    },
    evals: { ok: false, reason: "No eval report on file" },
    agencyFeed: { ok: false, reason: "Agency feed not configured" },
    legal: "missing",
    leads: { ok: false, reason: "CRM not found" },
    signoffs: {},
    fx: { usdToAud: 1.5, asOf: "2026-09-26", source: "fixture" },
  };
}
test("Sydney windows, nearest-rank, medians and masking", () => {
  const rows = [
    call({ durationSec: 60 }),
    call({ id: "web", kind: "web", durationSec: 120, latencyP50Ms: 300, latencyP90Ms: 400 }),
    call({
      id: "zero",
      durationSec: 0,
      status: "not_connected",
      latencyP50Ms: null,
      latencyP90Ms: null,
    }),
    call({ id: "midnight", startedAt: "2026-09-25T14:01:00Z", durationSec: 180 }),
    call({ id: "yesterday", startedAt: "2026-09-25T13:59:00Z", durationSec: 240 }),
    call({ id: "old", startedAt: "2026-09-18T02:00:00Z", durationSec: 300 }),
  ];
  const s = buildReceptionistSnapshot(inputs(rows), NOW);
  if (!s.calls.ok) throw Error("calls");
  expect(s.calls.windows.map((w) => w.count)).toEqual([4, 5, 6]);
  expect(s.calls.windows[0].answered).toBe(3);
  expect(s.calls.windows[0].p90DurationSec).toBe(180);
  expect(s.calls.windows[0].avgDurationSec).toBe(90);
  expect(s.calls.windows[0].latencyP50Ms).toBe(100);
  expect(s.calls.windows[0].latencyP90Ms).toBe(200);
  expect(s.calls.recent.find((c) => c.kind === "web")?.from).toBeNull();
  expect(s.calls.recent[0].from).toBe("••• 208");
  expect(s.calls.latencyTrend).toHaveLength(3);
});
test("Retell unavailable stays unavailable and omits call count", () => {
  const i = inputs();
  i.calls = { ok: false, reason: "Retell unreachable (TimeoutError)" };
  i.agent = { ok: false, reason: "Retell unreachable (TimeoutError)" };
  const s = buildReceptionistSnapshot(i, NOW);
  expect(s.calls.ok).toBe(false);
  expect(s.sentence).not.toContain("calls today");
  expect(s.sentence).toContain("Retell unreachable");
  expect(s.verdict.decision).toBe("Status unknown");
  expect(s.commercial.economics.retellAudPerMinute).toBeNull();
});
test("US cents economics, phone preference and missing FX", () => {
  const e = economics([call(), call({ kind: "web", usdCents: 10000 })], 1.5);
  expect(e.retellAudPerMinute).toBeCloseTo(0.2112295082, 8);
  // Priced against the catalogue's default tier, never a local offer constant.
  const pkg = getReceptionistPackage(DEFAULT_OFFER_PACKAGE_ID);
  const monthly = pkg.pricing.monthly.cents / 100;
  expect(e.packageId).toBe(pkg.id);
  expect(e.costAtIncludedAud).toBeCloseTo(0.2112295082 * pkg.pricing.includedMinutes, 6);
  expect(e.marginAtIncludedAud).toBeCloseTo(monthly - 0.2112295082 * pkg.pricing.includedMinutes, 6);
  expect(e.breakEvenMinutes).toBeCloseTo(monthly / 0.2112295082, 4);
  expect(economics([call()], null).marginPct).toBeNull();
  expect(economics([call({ kind: "web" })], 1.5).caveat).toContain("all calls");
});
test("clean streak ignores short/web calls, stops on unchecked and flags", () => {
  const rows = Array.from({ length: 6 }, (_, n) =>
    call({ id: String(n), startedAt: new Date(NOW - n * 60_000).toISOString() }),
  );
  expect(buildReceptionistSnapshot(inputs(rows), NOW).readiness.cleanStreak.count).toBe(6);
  rows[2].checked = false;
  expect(buildReceptionistSnapshot(inputs(rows), NOW).readiness.cleanStreak.count).toBe(2);
  rows[2].kind = "web";
  rows[3].durationSec = 10;
  rows[4].flags = ["SMS_PROMISE"];
  expect(buildReceptionistSnapshot(inputs(rows), NOW).readiness.cleanStreak.count).toBe(2);
});
test("exact current-state sentence and safe projection", () => {
  const row = Object.assign(call(), {
    transcript: "UNIQUE_PRIVATE_SENTENCE_793",
    transcript_object: [{ role: "agent", content: "UNIQUE_PRIVATE_SENTENCE_793" }],
    authHeader: "UNIQUE_SECRET_793",
  });
  const s = buildReceptionistSnapshot(inputs([row, call({ id: "web", kind: "web" })]), NOW);
  expect(s.sentence).toBe(
    "Not safe to sell · Answering on published agent · 1 real call today · none flagged — next: connect the webhook so calls reach MU-Receptionist.",
  );
  expect(s.sentence.length).toBeLessThanOrEqual(160);
  expect(JSON.stringify(s)).not.toContain("UNIQUE_PRIVATE_SENTENCE_793");
  expect(JSON.stringify(s)).not.toContain("UNIQUE_SECRET_793");
});
