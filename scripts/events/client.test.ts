import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ActivityClient,
  ActivityHub,
  BACKOFF_MAX_MS,
  WATCHDOG_MS,
  backoffDelay,
  type ActivityEvent,
  type ActivityMessage,
  type ActivitySnapshot,
  type SourceLike,
} from "../../src/lib/activity-stream";
import { applyActivityToJobs, nextPollDelay, JOB_SAFETY_POLL_MS } from "../../src/lib/job-events";
import { HUD_OFFLINE_AFTER_MS, HUD_STREAM_LOST_AFTER_MS, hudOffline } from "../../src/lib/jarvis-hud";
import { ActivityBus } from "./bus";
import { createStream } from "./stream";

// ---- fakes -------------------------------------------------------------------------------------------------
class FakeSource implements SourceLike {
  handlers = new Map<string, ((e: { data?: string; lastEventId?: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  addEventListener(type: string, fn: (e: { data?: string; lastEventId?: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string, e: { data?: string; lastEventId?: string } = {}) {
    for (const h of this.handlers.get(type) ?? []) h(e);
  }
  hello() {
    this.fire("open");
    this.fire("hello", { data: JSON.stringify({ mode: "snapshot" }) });
  }
  event(id: string, ev: Partial<ActivityEvent>) {
    this.fire("message", { data: JSON.stringify({ id: Number(id.split(":")[1]), at: 1, topic: "job", type: "job", final: false, data: null, ...ev }), lastEventId: id });
  }
}
function harness(extra: { random?: () => number } = {}) {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  let seq = 0;
  let clock = 1_000;
  const client = new ActivityClient({
    createSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: ++seq, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.live = false;
    },
    random: extra.random ?? (() => 0.5),
    now: () => clock,
  });
  const fire = (pred: (t: { ms: number }) => boolean) => {
    const t = timers.filter((x) => x.live).find(pred);
    if (!t) throw new Error("no such timer; live: " + JSON.stringify(timers.filter((x) => x.live).map((x) => x.ms)));
    t.live = false;
    t.fn();
  };
  return { client, sources, timers, fire, advance: (ms: number) => (clock += ms) };
}

describe("backoff", () => {
  test("grows 1 s, 2 s, 4 s ... is capped at 30 s, and is jittered to 50-100% so tabs don't retry in lockstep", () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, () => 1))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(50, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(50, () => 0)).toBe(BACKOFF_MAX_MS / 2);
    for (let n = 0; n < 20; n++) for (const r of [0, 0.3, 0.999, 1, 7, -3]) {
      const d = backoffDelay(n, () => r);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
    const spread = new Set(Array.from({ length: 50 }, () => backoffDelay(5)));
    expect(spread.size).toBeGreaterThan(10);
  });
});

describe("ActivityClient", () => {
  test("opens, delivers events and snapshots, remembers the last id, and reconnects from it after an error", () => {
    const h = harness({ random: () => 1 });
    const got: ActivityMessage[] = [];
    h.client.onMessage((m) => got.push(m));
    h.client.start();
    expect(h.sources[0].url).toBe("/__events");
    expect(h.client.getStatus().state).toBe("connecting");
    h.sources[0].hello();
    expect(h.client.getStatus()).toMatchObject({ state: "open", attempts: 0, everOpened: true });
    h.sources[0].fire("snapshot", { data: JSON.stringify({ epoch: "e1", head: 5, jobs: [], jobsHead: 0 }), lastEventId: "e1:5" });
    h.sources[0].event("e1:6", { topic: "job" });
    expect(got.map((m) => m.kind)).toEqual(["snapshot", "event"]);
    h.sources[0].fire("error");
    expect(h.sources[0].closed).toBe(true);
    expect(h.client.getStatus()).toMatchObject({ state: "retrying", attempts: 1 });
    h.fire((t) => t.ms === 1000);
    expect(h.sources[1].url).toBe("/__events?last=" + encodeURIComponent("e1:6"));
  });

  test("repeated failures back off (bounded) and one successful hello resets the count", () => {
    const h = harness({ random: () => 1 });
    h.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      h.sources.at(-1)!.fire("error");
      const t = h.timers.filter((x) => x.live && x.ms >= 1000 && x.ms !== WATCHDOG_MS).at(-1)!;
      delays.push(t.ms);
      h.fire((x) => x === t);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    h.sources.at(-1)!.hello();
    expect(h.client.getStatus().attempts).toBe(0);
    h.sources.at(-1)!.fire("error");
    expect(h.timers.filter((x) => x.live).some((t) => t.ms === 1000)).toBe(true);
  });

  test("a connection that goes silent (no heartbeat) is declared dead by the watchdog and retried", () => {
    const h = harness();
    h.client.start();
    h.sources[0].hello();
    h.sources[0].fire("ping");
    h.fire((t) => t.ms === WATCHDOG_MS); // the only watchdog still live is the one armed by the last frame
    expect(h.sources[0].closed).toBe(true);
    expect(h.client.getStatus().state).toBe("retrying");
  });

  test("a late event from a connection we already dropped is ignored; stop() releases everything", () => {
    const h = harness();
    const got: ActivityMessage[] = [];
    h.client.onMessage((m) => got.push(m));
    h.client.start();
    const old = h.sources[0];
    old.hello();
    old.fire("error");
    h.fire((t) => t.ms >= 500 && t.ms <= 1000);
    old.event("e1:9", {});
    expect(got).toEqual([]);
    h.sources[1].hello();
    h.client.stop();
    expect(h.sources[1].closed).toBe(true);
    expect(h.timers.filter((t) => t.live)).toEqual([]);
    expect(h.client.getStatus().state).toBe("idle");
  });

  test("retryNow skips the backoff (tab visible again, network back) but never doubles a live connection", () => {
    const h = harness();
    h.client.start();
    h.sources[0].fire("error");
    h.client.retryNow(); // within 2 s of the last attempt: refused, the backoff stands
    expect(h.sources.length).toBe(1);
    h.advance(2_500);
    h.client.retryNow();
    expect(h.sources.length).toBe(2);
    h.client.retryNow(); // already connecting
    expect(h.sources.length).toBe(2);
  });
});

describe("one stream per browser: leader election across tabs", () => {
  function bus() {
    const tabs: { onmessage: ((e: { data: any }) => void) | null }[] = [];
    return () => {
      const me: { onmessage: ((e: { data: any }) => void) | null; postMessage(m: unknown): void; close(): void } = {
        onmessage: null,
        postMessage: (m) => queueMicrotask(() => tabs.filter((t) => t !== me).forEach((t) => t.onmessage?.({ data: m }))),
        close: () => void 0,
      };
      tabs.push(me);
      return me;
    };
  }
  function locks() {
    let holder: (() => void) | null = null;
    const queue: (() => void)[] = [];
    const grant = () => {
      const next = queue.shift();
      if (next) next();
    };
    return {
      request: (_name: string, cb: () => Promise<void>) =>
        new Promise<void>((resolve) => {
          const run = () => {
            holder = () => void 0;
            void cb().then(() => {
              holder = null;
              resolve();
              grant();
            });
          };
          if (holder) queue.push(run);
          else run();
        }),
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("only the first tab opens the connection; the others receive its messages; a closing leader hands over", async () => {
    const mkChannel = bus();
    const lock = locks();
    const mk = () => {
      const h = harness();
      const hub = new ActivityHub({ client: h.client, lock: lock.request as never, channel: mkChannel() as never, now: () => 1_000 });
      return { h, hub };
    };
    const a = mk();
    const b = mk();
    const gotB: ActivityMessage[] = [];
    b.hub.subscribe((m) => gotB.push(m));
    const releaseA = a.hub.acquire();
    await tick();
    const releaseB = b.hub.acquire();
    await tick();
    expect(a.hub.isLeader()).toBe(true);
    expect(b.hub.isLeader()).toBe(false);
    expect(a.h.sources.length).toBe(1);
    expect(b.h.sources.length).toBe(0); // a second tab opens no connection of its own
    a.h.sources[0].hello();
    a.h.sources[0].fire("snapshot", { data: JSON.stringify({ epoch: "e1", head: 3, jobs: [], jobsHead: 3 }), lastEventId: "e1:3" });
    a.h.sources[0].event("e1:4", { final: true });
    await tick();
    expect(gotB.map((m) => m.kind)).toEqual(["snapshot", "event"]);
    expect(b.hub.getStatus().state).toBe("open");
    // a late tab asks the leader and gets the current snapshot and status
    const c = mk();
    const gotC: ActivityMessage[] = [];
    c.hub.subscribe((m) => gotC.push(m));
    c.hub.acquire();
    await tick();
    expect(gotC.map((m) => m.kind)).toEqual(["snapshot"]);
    // the leader tab closes: its lock is released and the next tab takes over with a fresh connection
    releaseA();
    await tick();
    expect(a.h.sources[0].closed).toBe(true);
    expect(b.hub.isLeader()).toBe(true);
    expect(b.h.sources.length).toBe(1);
    releaseB();
    await tick();
    expect(b.h.sources[0].closed).toBe(true);
  });

  test("without Web Locks a tab simply leads for itself; releasing closes the stream", () => {
    const h = harness();
    const hub = new ActivityHub({ client: h.client, lock: null, channel: null });
    const release = hub.acquire();
    expect(hub.isLeader()).toBe(true);
    expect(h.sources.length).toBe(1);
    hub.acquire()(); // a second component mounting and unmounting changes nothing
    expect(h.sources[0].closed).toBe(false);
    release();
    expect(h.sources[0].closed).toBe(true);
  });

  test("healthy means open and heard from lately; a stale signal is not healthy", () => {
    let now = 1_000;
    const h = harness();
    const hub = new ActivityHub({ client: h.client, lock: null, channel: null, now: () => now });
    hub.acquire();
    expect(hub.healthy()).toBe(false);
    now = 5_000;
    h.sources[0].hello(); // lastSignalAt comes from the client's clock (1_000)
    expect(hub.getStatus().state).toBe("open");
    expect(hub.healthy()).toBe(true);
    now = 80_000; // nothing heard for longer than the heartbeat window
    expect(hub.healthy()).toBe(false);
  });
});

describe("job chip folding: events extend, snapshots replace, replays are harmless", () => {
  const job = (id: string, state: string, extra = {}) => ({ id, kind: "voice", state, title: id, updatedAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", stepCount: 0, lastStep: null, ...extra });
  const ev = (jobSeq: number, e: any, extra: Partial<ActivityEvent> = {}): ActivityMessage => ({ kind: "event", event: { id: jobSeq, at: 1, topic: "job", type: e.type, final: false, data: { jobSeq, event: { seq: jobSeq, at: 1, ...e } }, ...extra } as ActivityEvent });

  test("a snapshot replaces the list and sets the cursor; the same event twice is applied once", () => {
    const snap = { kind: "snapshot", snapshot: { jobs: [job("a", "running")], jobsHead: 10 } as unknown as ActivitySnapshot } as ActivityMessage;
    const s1 = applyActivityToJobs(new Map(), 0, snap);
    expect([...s1.jobs.keys()]).toEqual(["a"]);
    expect(s1.cursor).toBe(10);
    const done = ev(11, { type: "job", jobId: "a", job: job("a", "succeeded") }, { final: true });
    const s2 = applyActivityToJobs(s1.jobs, s1.cursor, done);
    expect(s2.jobs.get("a")!.state).toBe("succeeded");
    expect(s2.events.length).toBe(1);
    const again = applyActivityToJobs(s2.jobs, s2.cursor, done); // a replay or an overlapping poll
    expect(again.events).toEqual([]);
    expect(again.jobs.get("a")!.state).toBe("succeeded");
    expect(again.cursor).toBe(11);
  });
  test("a stale event (older than the cursor) never regresses a finished job; a truncated one asks for a refetch; other topics are ignored", () => {
    const finished = new Map([["a", { ...job("a", "succeeded"), steps: [] }]]) as any;
    const old = applyActivityToJobs(finished, 20, ev(15, { type: "job", jobId: "a", job: job("a", "running") }));
    expect(old.jobs.get("a")!.state).toBe("succeeded");
    expect(applyActivityToJobs(finished, 20, { kind: "event", event: { id: 1, at: 1, topic: "job", type: "step", final: false, truncated: true, data: null } }).refetch).toBe(true);
    expect(applyActivityToJobs(finished, 20, { kind: "event", event: { id: 1, at: 1, topic: "device", type: "offline", final: false, data: {} } }).events).toEqual([]);
  });
  test("polling: a healthy stream means one safety read a minute, busy or not; no stream keeps the old fast and idle rates", () => {
    expect(nextPollDelay(2000, [{ state: "running" }], 0, true)).toBe(JOB_SAFETY_POLL_MS);
    expect(nextPollDelay(2000, [{ state: "running" }], 0, false)).toBe(2000);
    expect(nextPollDelay(2000, [], 10 * 60_000, false)).toBe(15_000);
  });
});

describe("HUD offline detection is no slower than before", () => {
  const base = { hasData: true, isError: false, dataUpdatedAt: 100_000, now: 101_000, stream: { state: "open", everOpened: true, lastSignalAt: 100_500, lostAt: 0 } };
  test("healthy: not offline, even when the safety poll is 90 s old, because the heartbeat counts", () => {
    expect(hudOffline({ ...base, dataUpdatedAt: 10_000, now: 105_000 })).toBe(false);
  });
  test("a stream that was open and dropped shows offline once it has been gone 12 s (the poll alone took up to 45 s); a blink that reconnects does not flash", () => {
    const lost = { ...base, stream: { state: "retrying", everOpened: true, lastSignalAt: 90_000, lostAt: 100_600 } };
    expect(hudOffline({ ...lost, now: 100_600 + HUD_STREAM_LOST_AFTER_MS })).toBe(false);
    expect(hudOffline({ ...lost, now: 100_600 + HUD_STREAM_LOST_AFTER_MS + 1 })).toBe(true);
    expect(hudOffline({ ...lost, now: 102_000 })).toBe(false); // lost 1.4 s ago: a reconnect blip
  });
  test("the client stamps lostAt on the first failure of a streak, keeps it across retries, and clears it on hello", () => {
    const h = harness({ random: () => 1 });
    h.client.start();
    h.sources[0].hello();
    expect(h.client.getStatus().lostAt).toBe(0);
    h.sources[0].fire("error");
    const first = h.client.getStatus().lostAt;
    expect(first).toBeGreaterThan(0);
    h.advance(5_000);
    h.fire((t) => t.ms === 1000);
    h.sources[1].fire("error");
    expect(h.client.getStatus().lostAt).toBe(first);
    h.fire((t) => t.ms === 2000);
    h.sources[2].hello();
    expect(h.client.getStatus().lostAt).toBe(0);
  });
  test("with no stream at all the old rules apply unchanged: no data, an error, or silence past 120 s", () => {
    const none = { ...base, stream: { state: "retrying", everOpened: false, lastSignalAt: 0, lostAt: 0 } };
    expect(hudOffline({ ...none, now: 100_000 + HUD_OFFLINE_AFTER_MS })).toBe(false);
    expect(hudOffline({ ...none, now: 100_000 + HUD_OFFLINE_AFTER_MS + 1 })).toBe(true);
    expect(hudOffline({ ...none, hasData: false })).toBe(true);
    expect(hudOffline({ ...none, isError: true })).toBe(true);
  });
});

describe("client against the real server: kill the connection, reconnect, miss nothing", () => {
  /** An EventSource over fetch (bun has none): same frames, same lastEventId behaviour. */
  function fetchSource(base: string) {
    return (path: string): SourceLike => {
      const handlers = new Map<string, ((e: any) => void)[]>();
      const ctl = new AbortController();
      const emit = (t: string, e: any) => (handlers.get(t) ?? []).forEach((h) => h(e));
      void (async () => {
        try {
          const res = await fetch(base + path, { signal: ctl.signal });
          if (res.status !== 200) return emit("error", {});
          emit("open", {});
          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const raw = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let type = "message", id: string | undefined, data = "";
              for (const line of raw.split("\n")) {
                if (line.startsWith("event: ")) type = line.slice(7);
                else if (line.startsWith("id: ")) id = line.slice(4);
                else if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (data) emit(type, { data, lastEventId: id });
            }
          }
          emit("error", {});
        } catch {
          if (!ctl.signal.aborted) emit("error", {});
        }
      })();
      return { close: () => ctl.abort(), addEventListener: (t, fn) => void handlers.set(t, [...(handlers.get(t) ?? []), fn]) };
    };
  }
  test("events published while the connection was down arrive by replay, in order, with the finished result included", async () => {
    const bus = new ActivityBus();
    const stream = createStream({ bus, resolvePrincipal: () => ({ personId: "usman" }), snapshot: () => ({ jobs: [], jobsHead: 0 }), heartbeatMs: 60_000 });
    const server: Server = createServer((req, res) => stream.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new ActivityClient({ createSource: (u) => fetchSource(base)(u), random: () => 0 });
    const got: ActivityMessage[] = [];
    client.onMessage((m) => got.push(m));
    const until = async (pred: () => boolean, ms = 5000) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error("timed out: " + JSON.stringify(got.map((m) => (m.kind === "event" ? m.event.type + ":" + JSON.stringify(m.event.data) : "snapshot"))));
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    client.start();
    await until(() => got.some((m) => m.kind === "snapshot"));
    bus.publish({ topic: "job", type: "job", scope: "shared", data: { n: 1 } });
    await until(() => got.filter((m) => m.kind === "event").length === 1);
    // drop the network: the server side of every stream is cut, and events happen while the client is away
    stream.closeAll();
    bus.publish({ topic: "job", type: "job", scope: "shared", final: true, data: { n: 2 } });
    bus.publish({ topic: "approval", type: "approved", scope: "shared", final: true, data: { n: 3 } });
    await until(() => got.filter((m) => m.kind === "event").length === 3);
    const events = got.filter((m): m is Extract<ActivityMessage, { kind: "event" }> => m.kind === "event").map((m) => m.event);
    expect(events.map((e) => e.data.n)).toEqual([1, 2, 3]);
    expect(events[1].final).toBe(true);
    expect(got.filter((m) => m.kind === "snapshot").length).toBe(1); // a replay, not a second snapshot
    expect(client.getStatus().state).toBe("open");
    client.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("recovery", () => {
  test("a leader's retryNow skips the backoff when a read proves the hub is back; a follower's does nothing", async () => {
    const h = harness();
    const hub = new ActivityHub({ client: h.client, lock: null, channel: null });
    hub.acquire();
    h.sources[0].hello();
    h.sources[0].fire("error");
    expect(h.client.getStatus().state).toBe("retrying");
    h.advance(5_000); // not a nudge-loop: a retry within 2 s of the last attempt is refused (below)
    hub.retryNow();
    expect(h.sources.length).toBe(2);
    expect(h.client.getStatus().state).toBe("connecting");
    // it fails at once (hub still down) and something nudges again straight away: no storm
    h.sources[1].fire("error");
    for (let i = 0; i < 50; i++) hub.retryNow();
    expect(h.sources.length).toBe(2);
    h.advance(2_001);
    hub.retryNow();
    expect(h.sources.length).toBe(3);
    const f = harness();
    const follower = new ActivityHub({ client: f.client, lock: () => new Promise(() => {}) as never, channel: null });
    follower.acquire();
    follower.retryNow();
    expect(f.sources.length).toBe(0);
  });
});
