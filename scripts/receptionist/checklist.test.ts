import { expect, test } from "bun:test";
import { deriveChecklist, GO_LIVE_STEPS, liveLineCapabilityMismatch } from "./checklist";
import type { FeedClient } from "./types";

function demoClient(overrides: Partial<FeedClient["readiness"]> = {}): FeedClient {
  return {
    organizationId: "org_demo",
    slug: "mu-demo-line",
    isDemoTenant: true,
    bookings: { byStatus: {}, total: 0, madeOnCalls: 0, sandbox: 0, upcoming: 0 },
    handoffs: { transfersByStatus: {}, alertsByReason: {}, alertsByStatus: {} },
    minutesThisMonth: { monthStart: null, calls: 0, callMinutes: 0, billableMinutesCurrentPeriod: 0 },
    readiness: {
      agentMapped: false, inboundNumberSet: false, calendarRequested: null, calendarInUse: null,
      calendarReason: null, liveCalendar: false, demoDiaryConfirmed: true, bookingOutcome: null,
      alertMailboxSet: false, transferEnabled: false, smsEnabled: false, retentionDays: null,
      retellRetentionAligned: "unverified", ...overrides,
    },
  };
}

test("with no clients at all, every derivable step is honestly not-started/unknown, never verified", () => {
  const rows = deriveChecklist([], null);
  expect(rows).toHaveLength(GO_LIVE_STEPS.length);
  expect(rows.some((r) => r.status === "verified")).toBe(false);
  expect(rows.find((r) => r.id === "seed-demo-org")?.status).toBe("not-started");
});

test("nothing has been done: fresh demo client with no readiness signals stays not-started, not verified", () => {
  const rows = deriveChecklist([demoClient()], null);
  expect(rows.find((r) => r.id === "seed-demo-org")?.status).toBe("not-started");
  expect(rows.find((r) => r.id === "retell-config")?.status).toBe("not-started");
  expect(rows.find((r) => r.id === "sms-on-demo")?.status).toBe("not-started");
  expect(rows.find((r) => r.id === "say-it-out-loud")?.status).toBe("not-started");
});

test("booking confirmed on the mapped demo line verifies seed + retell-config and marks say-it-out-loud in-progress until SMS is on too", () => {
  const rows = deriveChecklist([demoClient({ agentMapped: true, inboundNumberSet: true, bookingOutcome: "confirmed" })], null);
  expect(rows.find((r) => r.id === "seed-demo-org")?.status).toBe("verified");
  expect(rows.find((r) => r.id === "retell-config")?.status).toBe("verified");
  expect(rows.find((r) => r.id === "say-it-out-loud")?.status).toBe("in-progress");
});

test("SMS on for the demo line completes say-it-out-loud only once booking is also confirmed", () => {
  const smsOnly = deriveChecklist([demoClient({ smsEnabled: true })], null);
  expect(smsOnly.find((r) => r.id === "sms-on-demo")?.status).toBe("verified");
  expect(smsOnly.find((r) => r.id === "say-it-out-loud")?.status).toBe("not-started");
  const both = deriveChecklist([demoClient({ agentMapped: true, inboundNumberSet: true, bookingOutcome: "confirmed", smsEnabled: true })], null);
  expect(both.find((r) => r.id === "say-it-out-loud")?.status).toBe("verified");
});

test("vercel-env step reads the deployment block's booleans and stays unknown without one", () => {
  expect(deriveChecklist([], null).find((r) => r.id === "vercel-env")?.status).toBe("unknown");
  const partial = deriveChecklist([], { retellWebhookSecretSet: true, alertEmailChannelLive: false, cronSecretValid: false, trustProxyHeaders: true, transferExecutionEnabled: false });
  expect(partial.find((r) => r.id === "vercel-env")?.status).toBe("not-started");
  const good = deriveChecklist([], { retellWebhookSecretSet: true, alertEmailChannelLive: true, cronSecretValid: true, trustProxyHeaders: true, transferExecutionEnabled: false });
  expect(good.find((r) => r.id === "vercel-env")?.status).toBe("in-progress");
});

test("steps that need the owner's physical test (phone calls, texts) are always unknown, never inferred", () => {
  const rows = deriveChecklist([demoClient({ agentMapped: true, inboundNumberSet: true, bookingOutcome: "confirmed", smsEnabled: true })], null);
  expect(rows.find((r) => r.id === "five-test-calls")?.status).toBe("unknown");
  expect(rows.find((r) => r.id === "five-test-texts")?.status).toBe("unknown");
});

test("liveLineCapabilityMismatch: no demo client in the feed keeps it visible and unresolved", () => {
  const result = liveLineCapabilityMismatch([]);
  expect(result).toMatchObject({ visible: true, resolved: false });
  expect(result.reason).toContain("No demo-tenant client");
});

test("liveLineCapabilityMismatch: resolves only when the demo line is fully mapped and confirmed", () => {
  expect(liveLineCapabilityMismatch([demoClient({ agentMapped: true, inboundNumberSet: false, bookingOutcome: "confirmed" })]).resolved).toBe(false);
  expect(liveLineCapabilityMismatch([demoClient({ agentMapped: true, inboundNumberSet: true, bookingOutcome: "test_booking_only" })]).resolved).toBe(false);
  expect(liveLineCapabilityMismatch([demoClient({ agentMapped: true, inboundNumberSet: true, bookingOutcome: "confirmed" })]).resolved).toBe(true);
});

test("every step id is unique and matches its doc step number 0..13 exactly once", () => {
  const steps = [...GO_LIVE_STEPS].sort((a, b) => a.step - b.step).map((s) => s.step);
  expect(steps).toEqual([...Array(14).keys()]);
  expect(new Set(GO_LIVE_STEPS.map((s) => s.id)).size).toBe(GO_LIVE_STEPS.length);
});
