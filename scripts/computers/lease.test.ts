import { describe, expect, test } from "bun:test";
import { AGENT_LEASE_TTL_MS, LeaseManager, PERSON_LEASE_TTL_MS, type LeaseEvent } from "./lease";
import { holderKey } from "./types";

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const job = (n = 1, by: "usman" | "mehroz" = "usman") => ({ jobId: `00000000-0000-4000-8000-00000000000${n}`, by, agent: `agent-${n}` });
const usman = { personId: "usman" as const, session: "sk-u" };
const mehroz = { personId: "mehroz" as const, session: "sk-m" };

describe("control lease: one controller at a time", () => {
  test("a free computer is taken by a job; a second job is refused with who holds it", () => {
    const c = clock();
    const l = new LeaseManager(c.now);
    const a = l.acquireAgent("c1", job(1));
    expect(a.ok).toBe(true);
    const b = l.acquireAgent("c1", job(2));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toContain("agent-1");
    // a different computer is independent
    expect(l.acquireAgent("c2", job(2)).ok).toBe(true);
  });

  test("the same job asking again keeps its lease; a person cannot take a person's lease", () => {
    const c = clock();
    const l = new LeaseManager(c.now);
    expect(l.acquireAgent("c1", job(1)).ok).toBe(true);
    expect(l.acquireAgent("c1", job(1)).ok).toBe(true);
    l.release("c1", holderKey({ kind: "agent", ...job(1) }));
    expect(l.requestTakeover("c1", usman)).toMatchObject({ ok: true, state: "held" });
    const other = l.requestTakeover("c1", mehroz);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toContain("usman");
    // the holder asking again just keeps it
    expect(l.requestTakeover("c1", usman)).toMatchObject({ ok: true, state: "held" });
  });

  test("a stale epoch is refused: a command issued before a change of holder never lands", () => {
    const c = clock();
    const l = new LeaseManager(c.now);
    const a = l.acquireAgent("c1", job(1));
    if (!a.ok) throw new Error("x");
    const key = holderKey(a.lease.holder);
    expect(l.valid("c1", key, a.lease.epoch)).toBe(true);
    l.requestTakeover("c1", usman);
    l.handOver("c1", job(1).jobId);
    expect(l.valid("c1", key, a.lease.epoch)).toBe(false); // the agent's old epoch
    expect(l.current("c1")?.epoch).toBeGreaterThan(a.lease.epoch);
  });
});

describe("expiry: an abandoned viewer or dead job never locks a computer", () => {
  test("an agent lease not renewed is free; renewing keeps it", () => {
    const c = clock();
    const l = new LeaseManager(c.now);
    const a = l.acquireAgent("c1", job(1));
    if (!a.ok) throw new Error("x");
    const key = holderKey(a.lease.holder);
    c.advance(AGENT_LEASE_TTL_MS - 1);
    expect(l.renew("c1", key)).toBe(true);
    c.advance(AGENT_LEASE_TTL_MS - 1);
    expect(l.current("c1")).not.toBeNull();
    c.advance(2);
    expect(l.current("c1")).toBeNull();
    expect(l.acquireAgent("c1", job(2)).ok).toBe(true);
  });

  test("a person's lease without a heartbeat expires and the other founder can take the computer", () => {
    const c = clock();
    const l = new LeaseManager(c.now);
    l.requestTakeover("c1", usman);
    c.advance(PERSON_LEASE_TTL_MS + 1);
    expect(l.current("c1")).toBeNull();
    expect(l.requestTakeover("c1", mehroz)).toMatchObject({ ok: true, state: "held" });
  });

  test("a person's viewer that vanishes while an agent job is paused hands the computer back to that same job", () => {
    const c = clock();
    const l = new LeaseManager(c.now);
    const events: LeaseEvent[] = [];
    l.subscribe((e) => events.push(e));
    l.acquireAgent("c1", job(1));
    expect(l.requestTakeover("c1", usman)).toMatchObject({ ok: true, state: "pending" });
    expect(l.takeoverWaiting("c1", job(1).jobId)).toBe(true);
    expect(l.handOver("c1", job(1).jobId).ok).toBe(true);
    expect(l.current("c1")?.holder).toMatchObject({ kind: "person", personId: "usman" });
    c.advance(PERSON_LEASE_TTL_MS + 1);
    const back = l.current("c1");
    expect(back?.holder).toMatchObject({ kind: "agent", jobId: job(1).jobId });
    expect(back?.paused).toBeNull();
    expect(events.some((e) => e.type === "returned" && e.why === "viewer-expired")).toBe(true);
  });
});

describe("takeover pauses at a step boundary and return resumes the same job", () => {
  test("the agent holds until it hands over; only then does the person hold; return gives it back under a new epoch", () => {
    const c = clock();
    const l = new LeaseManager(c.now);
    const a = l.acquireAgent("c1", job(1));
    if (!a.ok) throw new Error("x");
    const pending = l.requestTakeover("c1", usman);
    expect(pending).toMatchObject({ ok: true, state: "pending" });
    // still the agent's until it reaches a boundary
    expect(l.current("c1")?.holder.kind).toBe("agent");
    expect(l.valid("c1", holderKey(a.lease.holder), a.lease.epoch)).toBe(true);
    expect(l.handOver("c1", "00000000-0000-4000-8000-0000000000ff").ok).toBe(false); // not this job's lease
    const handed = l.handOver("c1", job(1).jobId);
    expect(handed.ok).toBe(true);
    expect(l.current("c1")?.paused?.jobId).toBe(job(1).jobId);
    // the other founder cannot take it, and cannot return it
    expect(l.requestTakeover("c1", mehroz).ok).toBe(false);
    expect(l.returnToAgent("c1", mehroz).ok).toBe(false);
    const back = l.returnToAgent("c1", usman);
    expect(back).toEqual({ ok: true, resumed: job(1).jobId });
    const now = l.current("c1")!;
    expect(now.holder).toMatchObject({ kind: "agent", jobId: job(1).jobId });
    expect(now.epoch).toBeGreaterThan(a.lease.epoch + 1);
  });

  test("a person who asked can withdraw before the agent reaches a boundary", () => {
    const l = new LeaseManager(clock().now);
    l.acquireAgent("c1", job(1));
    l.requestTakeover("c1", usman);
    expect(l.cancelTakeover("c1", mehroz)).toBe(false);
    expect(l.cancelTakeover("c1", usman)).toBe(true);
    expect(l.takeoverWaiting("c1", job(1).jobId)).toBe(false);
  });

  test("a cancelled paused job is forgotten, so returning frees the computer instead of resuming a dead job", () => {
    const l = new LeaseManager(clock().now);
    l.acquireAgent("c1", job(1));
    l.requestTakeover("c1", usman);
    l.handOver("c1", job(1).jobId);
    l.clearPaused("c1", job(1).jobId);
    expect(l.returnToAgent("c1", usman)).toEqual({ ok: true, resumed: null });
    expect(l.current("c1")).toBeNull();
  });
});
