// Receptionist handoffs in the shared Command scene (cloud/receptionist-leads-handoff-20260929).
// SYNTHETIC: hand-built dashboard blocks and events, no feed, provider or customer data.
import { describe, expect, test } from "bun:test";
import { HANDOFF_LINGER_MS, claimSweep, handoffMotion, parseHandoff, visibleHandoffs } from "../../src/components/shell/handoff";
import { LEAD_LINK_GAP, RX_HANDOFF_FRESH_MS, blockFresh, fromSourceEvent, receptionistHandoffs, type DashboardHandoffInput, type SourceEvent } from "../../src/components/shell/receptionist-handoff";

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const block = (over: Record<string, unknown> = {}) => ({ ok: true, asOf: at(2), stale: false, staleAfterMs: 86_400_000, ...over });
const vm = (over: Partial<Record<"handoffs" | "transfers" | "callbacks", Record<string, unknown>>> = {}): DashboardHandoffInput =>
  ({
    handoffs: block({ pending: 0, failed: 0, ...over.handoffs }),
    transfers: block({ failed: 0, ...over.transfers }),
    callbacks: block({ pending: 0, ...over.callbacks }),
  }) as DashboardHandoffInput;
const key = (h: { id: string; state: string }) => `${h.id}:${h.state}`;

describe("feed counts become honest staff handoffs", () => {
  test("nothing pending or failed means no handoff row at all", () => {
    expect(receptionistHandoffs(vm(), NOW)).toEqual([]);
  });
  test("failed staff alerts and transfers are failed; pending alerts and callbacks are queued, never done", () => {
    const rows = receptionistHandoffs(vm({ handoffs: { pending: 2, failed: 1 }, transfers: { failed: 3 }, callbacks: { pending: 4 } }), NOW);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["rx:staff-alerts:failed"]).toMatchObject({ state: "failed", label: "1 staff alert failed to send", from: "receptionist", to: "staff", source: "receptionist-feed" });
    expect(by["rx:transfers:failed"]).toMatchObject({ state: "failed", label: "3 call transfers failed" });
    expect(by["rx:staff-alerts:pending"]).toMatchObject({ state: "queued", label: "2 staff alerts waiting to send" });
    expect(by["rx:callbacks:pending"]).toMatchObject({ state: "queued", label: "4 callbacks waiting for staff" });
    expect(rows.every((r) => r.state !== "done")).toBe(true);
  });
  test("each row is stamped with the block's own read time, and says it is a count", () => {
    const [r] = receptionistHandoffs(vm({ handoffs: { failed: 1, asOf: at(5) } }), NOW);
    expect(r.at).toBe(NOW - 5 * 60_000);
    expect(r.basis).toContain("Count from the agency feed, not a single call");
  });
  test("a partial count is a lower bound", () => {
    const [r] = receptionistHandoffs(vm({ handoffs: { failed: 2, partial: true } }), NOW);
    expect(r.basis).toContain("At least this many");
  });
  test("nothing in the wording implies a booking, SMS, notification or completed lead", () => {
    const rows = receptionistHandoffs(vm({ handoffs: { pending: 1, failed: 1 }, transfers: { failed: 1 }, callbacks: { pending: 1 } }), NOW);
    const words = rows.map((r) => `${r.label} ${r.basis}`).join(" ");
    expect(words).not.toMatch(/booked|booking confirmed|sms sent|texted|has been notified|lead saved|completed|converted/i);
    expect(words).not.toMatch(/\d{3}[ -]?\d{3}|@|\+61/); // no phone numbers or emails, only counts
  });
});

describe("missing, failed, stale or partial sources are Not confirmed, never work in flight", () => {
  test("no read yet or a failed read: one unknown row saying why", () => {
    for (const input of [null, undefined]) {
      const rows = receptionistHandoffs(input, NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "rx:staff-handoffs:unknown", state: "unknown", to: "staff" });
    }
  });
  test("a block that failed to read", () => {
    const rows = receptionistHandoffs(vm({ handoffs: { ok: false, reason: "feed unreachable" } }), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "unknown" });
    expect(rows[0].basis).toContain("feed unreachable");
  });
  test("a stale count is not shown as queued even with a big number", () => {
    const rows = receptionistHandoffs(vm({ handoffs: { pending: 9, asOf: at(RX_HANDOFF_FRESH_MS / 60_000 + 5) } }), NOW);
    expect(rows.map((r) => r.state)).toEqual(["unknown"]);
    expect(rows[0].basis).toContain("old or has no read time");
  });
  test("a block with no read time or a read time in the future is not fresh", () => {
    expect(blockFresh({ ok: true, asOf: null }, NOW)).toBe(false);
    expect(blockFresh({ ok: true, asOf: new Date(NOW + 3_600_000).toISOString() }, NOW)).toBe(false);
    expect(blockFresh({ ok: true, asOf: at(1), staleAfterMs: 30_000 }, NOW)).toBe(false); // the block's own window is tighter
  });
  test("a counter the feed did not send is unknown, not zero", () => {
    const rows = receptionistHandoffs(vm({ handoffs: { pending: null, failed: 1 } }), NOW);
    expect(rows.map((r) => r.state).sort()).toEqual(["failed", "unknown"]);
  });
  test("a dashboard error body with no blocks is Not confirmed", () => {
    expect(receptionistHandoffs({ error: "boom" } as never, NOW)[0]).toMatchObject({ state: "unknown" });
  });
  test("the missing call-to-lead link is stated, not faked", () => {
    expect(LEAD_LINK_GAP.state).toBe("Setup required");
    expect(LEAD_LINK_GAP.text).toMatch(/no field linking a receptionist call to a lead/);
    expect(receptionistHandoffs(vm({ handoffs: { failed: 1 } }), NOW).some((r) => r.to === "leads")).toBe(false);
  });
});

describe("the per-event seam confirms only with evidence", () => {
  const ev = (over: Partial<SourceEvent> = {}): SourceEvent => ({ eventId: "evt-1", kind: "lead-saved", state: "confirmed", observedAt: at(1), system: "crm", evidence: { leadId: "lead-42" }, ...over });
  test("a saved lead with its id is done and lands on Leads", () => {
    expect(fromSourceEvent(ev(), NOW)).toMatchObject({ id: "rx:crm:evt-1", state: "done", to: "leads", from: "receptionist" });
  });
  test("confirmed without its proof is Not confirmed, for every kind", () => {
    expect(fromSourceEvent(ev({ evidence: {} }), NOW)?.state).toBe("unknown");
    expect(fromSourceEvent(ev({ kind: "staff-alert", evidence: { alertAck: false } }), NOW)?.state).toBe("unknown");
    expect(fromSourceEvent(ev({ kind: "call-transfer", evidence: undefined }), NOW)?.state).toBe("unknown");
    expect(fromSourceEvent(ev({ kind: "staff-alert", evidence: { alertAck: true } }), NOW)).toMatchObject({ state: "done", to: "staff" });
    expect(fromSourceEvent(ev({ kind: "call-transfer", evidence: { transferConnected: true } }), NOW)?.state).toBe("done");
  });
  test("failed and queued pass through; a bad id or time is dropped", () => {
    expect(fromSourceEvent(ev({ state: "failed", evidence: undefined }), NOW)?.state).toBe("failed");
    expect(fromSourceEvent(ev({ state: "queued", evidence: undefined }), NOW)?.state).toBe("queued");
    expect(fromSourceEvent(ev({ eventId: "" }), NOW)).toBeNull();
    expect(fromSourceEvent(ev({ observedAt: "not a time" }), NOW)).toBeNull();
    expect(fromSourceEvent(ev({ observedAt: new Date(NOW + 3_600_000).toISOString() }), NOW)).toBeNull();
  });
  test("the label carries no more than 60 clipped characters and the id is stable across retries", () => {
    const a = fromSourceEvent(ev({ label: "x".repeat(200) }), NOW)!;
    expect(a.label).toHaveLength(60);
    expect(fromSourceEvent(ev({ label: "x".repeat(200) }), NOW + 5000)!.id).toBe(a.id);
  });
  test("an os:handoff event for staff and unknown states parses; a self-handoff does not", () => {
    expect(parseHandoff({ id: "a", from: "receptionist", to: "staff", state: "unknown" }, NOW)).toMatchObject({ to: "staff", state: "unknown" });
    expect(parseHandoff({ id: "a", from: "staff", to: "staff", state: "queued" }, NOW)).toBeNull();
  });
});

describe("refresh and retry never duplicate or replay", () => {
  test("re-reading the same feed gives the same ids and states, so the list has one row each", () => {
    const input = vm({ handoffs: { pending: 2, failed: 1 } });
    const a = receptionistHandoffs(input, NOW), b = receptionistHandoffs(input, NOW + 90_000);
    expect(b.map(key)).toEqual(a.map(key));
    expect(visibleHandoffs([...a, ...b], NOW + 90_000)).toHaveLength(a.length);
  });
  test("a changed count keeps the id and state, so the sweep key does not change", () => {
    const one = receptionistHandoffs(vm({ handoffs: { pending: 1 } }), NOW)[0];
    const two = receptionistHandoffs(vm({ handoffs: { pending: 5 } }), NOW + 60_000)[0];
    expect(key(two)).toBe(key(one));
  });
  test("a sweep is claimed once per state and replays only on a new state", () => {
    const seen = new Set<string>();
    expect(claimSweep("rx:staff-alerts:pending:queued", seen)).toBe(true);
    expect(claimSweep("rx:staff-alerts:pending:queued", seen)).toBe(false);
    expect(claimSweep("rx:staff-alerts:pending:failed", seen)).toBe(true);
  });
  test("a feed row stays while the feed still says it; an event's finished handoff lingers then goes; unknown stays while true", () => {
    const failed = receptionistHandoffs(vm({ handoffs: { failed: 1, asOf: at(1) } }), NOW)[0];
    expect(visibleHandoffs([failed], NOW + 10 * HANDOFF_LINGER_MS)).toHaveLength(1);
    const done = fromSourceEvent({ eventId: "e", kind: "lead-saved", state: "confirmed", observedAt: at(0), system: "crm", evidence: { leadId: "l1" } }, NOW)!;
    expect(visibleHandoffs([done], NOW + HANDOFF_LINGER_MS - 1)).toHaveLength(1);
    expect(visibleHandoffs([done], NOW + HANDOFF_LINGER_MS + 1)).toHaveLength(0);
    expect(visibleHandoffs(receptionistHandoffs(null, NOW), NOW + 10 * HANDOFF_LINGER_MS)).toHaveLength(1);
  });
});

describe("measured stillness and reduced motion", () => {
  const rows = () => receptionistHandoffs(vm({ handoffs: { pending: 1, failed: 1 }, callbacks: { pending: 1 } }), NOW);
  test("queued work travels once when nothing else has attention; failed, unknown and everything under reduced motion stay still", () => {
    const [failed, queued] = [rows().find((r) => r.state === "failed")!, rows().find((r) => r.state === "queued")!];
    expect(handoffMotion(queued, [], false)).toBe("travel");
    expect(handoffMotion(failed, [], false)).toBe("still");
    expect(handoffMotion(receptionistHandoffs(null, NOW)[0], [], false)).toBe("still");
    for (const r of rows()) expect(handoffMotion(r, [], true)).toBe("still");
  });
  test("reading, editing or speaking holds it still", () => {
    const queued = rows().find((r) => r.state === "queued")!;
    for (const hold of ["reading", "editing", "speaking"] as const) expect(handoffMotion(queued, [hold] as never, false)).toBe("still");
  });
  test("staff is a place with no scene object, so no object can light for a staff handoff", () => {
    expect(rows().every((r) => r.to === "staff")).toBe(true);
  });
});
