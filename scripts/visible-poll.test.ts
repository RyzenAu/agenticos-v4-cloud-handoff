import { describe, expect, test } from "bun:test";
import { backoffMs, createVisiblePoller, staleSinceMs, type PollState } from "../src/lib/visible-poll";

// A fake clock: timers fire only when the test advances time.
function harness(opts: { delay?: () => number; hang?: () => boolean; loadTimeoutMs?: number } = {}) {
  let t = 0;
  let hidden = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const loads: number[] = [];
  let outcome: "ok" | "fail" = "ok";
  const states: PollState[] = [];
  const poller = createVisiblePoller({
    loadTimeoutMs: opts.loadTimeoutMs,
    load: async () => {
      loads.push(t);
      if (opts.hang?.()) return new Promise(() => undefined); // a request that never answers
      if (outcome === "fail") throw new Error("hub unreachable");
    },
    delayMs: opts.delay ?? (() => 10_000),
    hidden: () => hidden,
    now: () => t,
    setTimer: (fn, ms) => {
      timers.set(++id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (i) => void timers.delete(i as number),
    onState: (s) => states.push(s),
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      t = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    t = end;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { poller, loads, states, advance, setHidden: (h: boolean) => (hidden = h), setOutcome: (o: "ok" | "fail") => (outcome = o), now: () => t };
}

describe("visible poll", () => {
  test("reads at once, then every delay, scheduling after each read settles", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0);
    await h.advance(35_000);
    expect(h.loads).toEqual([0, 10_000, 20_000, 30_000]);
  });

  test("a hidden tab reads nothing; becoming visible reads at once and the poll resumes", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0);
    h.setHidden(true);
    await h.advance(120_000);
    expect(h.loads.length).toBe(1); // the wait that was pending fired while hidden and read nothing
    h.setHidden(false);
    h.poller.nudge();
    await h.advance(1);
    expect(h.loads.length).toBe(2);
    await h.advance(10_000);
    expect(h.loads.length).toBe(3);
  });

  test("failures back off, are reported (never swallowed), and the last good read keeps its age", async () => {
    const h = harness({ delay: () => 4_000 });
    h.poller.start();
    await h.advance(0);
    expect(h.poller.state().lastOkAt).toBe(0);
    h.setOutcome("fail");
    await h.advance(4_000); // the second read fails
    expect(h.poller.state()).toMatchObject({ failures: 1, lastError: "hub unreachable", lastOkAt: 0 });
    await h.advance(60_000);
    // gaps after failures grow, capped: never a tight loop on a dead hub
    const gaps = h.loads.slice(1).map((v, i) => v - h.loads[i]);
    expect(gaps.slice(0, 3)).toEqual([4_000, 8_000, 16_000]);
    expect(h.loads.length).toBeLessThan(8);
    expect(staleSinceMs(h.poller.state(), h.now())).toBe(64_000); // last good read at t=0: reported as 64 s old, never as fresh
    h.setOutcome("ok");
    h.poller.nudge();
    await h.advance(1);
    expect(h.poller.state()).toMatchObject({ failures: 0, lastError: null });
    expect(staleSinceMs(h.poller.state(), h.now())).toBeLessThan(5);
  });

  test("the delay is re-read after every read (quick while something runs, slow when idle)", async () => {
    let busy = true;
    const h = harness({ delay: () => (busy ? 2_000 : 20_000) });
    h.poller.start();
    await h.advance(0);
    await h.advance(4_000);
    expect(h.loads).toEqual([0, 2_000, 4_000]);
    busy = false;
    await h.advance(2_000);
    expect(h.loads).toEqual([0, 2_000, 4_000, 6_000]);
    await h.advance(19_000);
    expect(h.loads.length).toBe(4);
    await h.advance(1_000);
    expect(h.loads.length).toBe(5);
  });

  test("one hung read never stalls the poll: it times out as a reported failure, backs off, and the next read still happens", async () => {
    let hang = true;
    const h = harness({ delay: () => 4_000, hang: () => hang, loadTimeoutMs: 10_000 });
    h.poller.start();
    await h.advance(0);
    expect(h.loads).toEqual([0]);
    await h.advance(10_000); // the hung read is abandoned
    expect(h.poller.state()).toMatchObject({ failures: 1, lastError: "no answer within 10 s", lastOkAt: null });
    hang = false;
    await h.advance(8_000); // backoff 8 s, then it reads again and recovers
    expect(h.loads.length).toBe(2);
    expect(h.poller.state()).toMatchObject({ failures: 0, lastError: null });
  });

  test("stop cancels the pending read and a stopped poller never reads again", async () => {
    const h = harness();
    h.poller.start();
    await h.advance(0);
    h.poller.stop();
    await h.advance(60_000);
    expect(h.loads.length).toBe(1);
    h.poller.nudge();
    await h.advance(1);
    expect(h.loads.length).toBe(1);
  });

  test("backoffMs doubles and caps", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(4_000, n))).toEqual([4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });
});
