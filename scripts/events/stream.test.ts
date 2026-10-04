import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeJobsRuntime, jobsRuntime } from "../jobs/runtime";
import { ActivityBus, RING_CAPACITY, parseWireId, wireId } from "./bus";
import { startActivitySources, type RegistryLike } from "./sources";
import { createStream, type StreamPrincipal } from "./stream";

type Frame = { event: string; id?: string; data: any };

/** Read SSE frames from a fetch response, as an async queue with a way to wait for N frames. */
async function open(base: string, init: { headers?: Record<string, string>; path?: string } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${base}${init.path ?? "/__events"}`, { headers: init.headers, signal: controller.signal });
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const f: Frame = { event: "message", data: null };
            for (const line of raw.split("\n")) {
              if (line.startsWith("event: ")) f.event = line.slice(7);
              else if (line.startsWith("id: ")) f.id = line.slice(4);
              else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
            }
            if (raw.startsWith("retry:") && !raw.includes("event:")) continue;
            frames.push(f);
            for (const w of waiters.splice(0)) w();
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }
  const waitFor = async (pred: (f: Frame[]) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred(frames)) {
      if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(frames.map((f) => f.event + (f.data?.type ? `:${f.data.type}` : "")))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
  };
  return { res, frames, waitFor, close: () => controller.abort() };
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server?.closeAllConnections?.();
  server = undefined;
});

function host(person: (req: IncomingMessage) => StreamPrincipal, extra: Partial<Parameters<typeof createStream>[0]> = {}) {
  const bus = new ActivityBus({ epoch: "testepoch1" });
  const stream = createStream({ bus, resolvePrincipal: person, snapshot: (p) => ({ person: p, jobs: [] }), heartbeatMs: 60_000, ...extra });
  server = createServer((req, res) => stream.handle(req, res));
  return new Promise<{ bus: ActivityBus; stream: ReturnType<typeof createStream>; base: string }>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve({ bus, stream, base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` })),
  );
}
const asUsman = () => ({ personId: "usman" as const });
describe("a live stream stays authorised (review C8)", () => {
  test("a session revoked after connect ends the stream on the next recheck, and on the next event delivery", async () => {
    let signedIn = true;
    const { bus, stream, base } = await host(() => (signedIn ? { personId: "usman" } : null), { recheckMs: 40, deliveryRecheckMs: 0 });
    const a = await open(base);
    await a.waitFor((f) => f.some((x) => x.event === "snapshot"));
    expect(stream.openCount()).toBe(1);
    signedIn = false;
    bus.publish({ topic: "job", type: "job", scope: "shared", data: { n: 1 } });
    await new Promise((r) => setTimeout(r, 120));
    expect(stream.openCount()).toBe(0);
    expect(a.frames.some((f) => f.event === "job")).toBe(false); // nothing was delivered after the revocation
    a.close();
  });
  test("a periodic recheck closes an idle stream; a person change closes it too", async () => {
    let who: "usman" | "mehroz" | null = "usman";
    const { stream, base } = await host(() => (who ? { personId: who } : null), { recheckMs: 40, deliveryRecheckMs: 60_000 });
    const a = await open(base);
    await a.waitFor((f) => f.some((x) => x.event === "snapshot"));
    who = "mehroz";
    await new Promise((r) => setTimeout(r, 150));
    expect(stream.openCount()).toBe(0);
    a.close();
  });
});
const byHeader = (req: IncomingMessage): StreamPrincipal => (req.headers["x-person"] === "mehroz" ? { personId: "mehroz" } : req.headers["x-person"] === "usman" ? { personId: "usman" } : null);

describe("the bus", () => {
  test("ids are monotonic, the wire id carries the epoch, and a bad one is refused", () => {
    const bus = new ActivityBus({ epoch: "abcdef12" });
    const a = bus.publish({ topic: "job", type: "job", scope: "shared", data: { x: 1 } });
    const b = bus.publish({ topic: "job", type: "step", scope: "shared", data: {} });
    expect(b.id).toBe(a.id + 1);
    expect(a.frame.startsWith(`id: ${wireId("abcdef12", a.id)}\n`)).toBe(true);
    expect(parseWireId("abcdef12:7")).toEqual({ epoch: "abcdef12", n: 7 });
    for (const bad of ["", "7", "x:y", "abcdef12:-1", "abcdef12:1.5", undefined, 5]) expect(parseWireId(bad)).toBeNull();
  });
  test("the ring is bounded; an id older than the ring, ahead of the head, or negative cannot be replayed", () => {
    const bus = new ActivityBus({ capacity: 5, epoch: "abcdef12" });
    for (let i = 0; i < 12; i++) bus.publish({ topic: "job", type: "job", scope: "shared", data: i });
    expect(bus.head()).toBe(12);
    expect(bus.oldest()).toBe(8);
    expect(bus.since(7)!.map((e) => e.id)).toEqual([8, 9, 10, 11, 12]); // 7 is exactly what the ring still covers
    expect(bus.since(6)).toBeNull(); // 7 was dropped: a gap
    expect(bus.since(13)).toBeNull();
    expect(bus.since(-1)).toBeNull();
    expect(bus.since(12)).toEqual([]);
    expect(RING_CAPACITY).toBe(500);
  });
  test("an oversized payload becomes a stub that tells the client to refetch; a cyclic one never throws", () => {
    const bus = new ActivityBus();
    const big = bus.publish({ topic: "agent", type: "message", scope: "shared", data: { text: "x".repeat(40_000) } });
    expect(JSON.parse(big.frame.split("data: ")[1]).truncated).toBe(true);
    const cyc: any = {};
    cyc.self = cyc;
    expect(() => bus.publish({ topic: "agent", type: "message", scope: "shared", data: cyc })).not.toThrow();
  });
  test("a throwing listener never breaks the publisher or the other listeners", () => {
    const bus = new ActivityBus();
    let got = 0;
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => void got++);
    bus.publish({ topic: "job", type: "job", scope: "shared", data: 1 });
    expect(got).toBe(1);
  });
});

describe("authorisation", () => {
  test("no signed-in person: 401 and nothing is held open; non-GET 405; cross-site 403", async () => {
    const { base, bus, stream } = await host(byHeader);
    expect((await fetch(`${base}/__events`)).status).toBe(401);
    expect((await fetch(`${base}/__events/snapshot`)).status).toBe(401);
    expect((await fetch(`${base}/__events`, { method: "POST", headers: { "x-person": "usman" } })).status).toBe(405);
    expect((await fetch(`${base}/__events`, { headers: { "x-person": "usman", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${base}/__events`, { headers: { "x-person": "usman", origin: "http://evil.example" } })).status).toBe(403);
    expect(stream.openCount()).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });
  test("a person's personal-device events are never delivered to the other person; shared ones reach both", async () => {
    const { base, bus } = await host(byHeader);
    const u = await open(base, { headers: { "x-person": "usman" } });
    const m = await open(base, { headers: { "x-person": "mehroz" } });
    await u.waitFor((f) => f.some((x) => x.event === "snapshot"));
    await m.waitFor((f) => f.some((x) => x.event === "snapshot"));
    bus.publish({ topic: "device", type: "offline", scope: "usman", data: { id: "usman-laptop" } });
    bus.publish({ topic: "device", type: "online", scope: "mehroz", data: { id: "mehroz-pc" } });
    bus.publish({ topic: "computer", type: "changed", scope: "shared", data: { computer: { name: "shared-1" } } });
    await u.waitFor((f) => f.filter((x) => x.event === "message").length >= 2);
    await m.waitFor((f) => f.filter((x) => x.event === "message").length >= 2);
    const ids = (frames: Frame[]) => frames.filter((x) => x.event === "message").map((x) => x.data.data.id ?? x.data.data.computer?.name);
    expect(ids(u.frames)).toEqual(["usman-laptop", "shared-1"]);
    expect(ids(m.frames)).toEqual(["mehroz-pc", "shared-1"]);
    // and the same through replay: Mehroz asking for everything since the start still gets nothing of Usman's
    const again = await open(base, { headers: { "x-person": "mehroz", "last-event-id": `${bus.epoch}:0` } });
    await again.waitFor((f) => f.filter((x) => x.event === "message").length >= 2);
    expect(ids(again.frames)).toEqual(["mehroz-pc", "shared-1"]);
    [u, m, again].forEach((c) => c.close());
  });
  test("the snapshot is scoped too", async () => {
    const seen: string[] = [];
    const { base } = await host(byHeader, { snapshot: (p) => (seen.push(p), { person: p }) });
    const r = await fetch(`${base}/__events/snapshot`, { headers: { "x-person": "mehroz" } });
    expect((await r.json()).person).toBe("mehroz");
    expect(seen).toEqual(["mehroz"]);
  });
  test("too many open streams for one person get 429", async () => {
    const { base } = await host(byHeader, { maxPerPerson: 2 });
    const a = await open(base, { headers: { "x-person": "usman" } });
    const b = await open(base, { headers: { "x-person": "usman" } });
    expect((await fetch(`${base}/__events`, { headers: { "x-person": "usman" } })).status).toBe(429);
    const c = await open(base, { headers: { "x-person": "mehroz" } });
    expect(c.res.status).toBe(200);
    [a, b, c].forEach((x) => x.close());
  });
});

describe("clean disconnect", () => {
  test("100 connect/disconnect cycles leave no listener, slot or timer behind", async () => {
    const { base, bus, stream } = await host(asUsman, { heartbeatMs: 20 });
    for (let i = 0; i < 100; i++) {
      const c = await open(base);
      await c.waitFor((f) => f.some((x) => x.event === "hello"));
      c.close();
    }
    for (let i = 0; i < 40 && (stream.openCount() > 0 || bus.listenerCount() > 0); i++) await new Promise((r) => setTimeout(r, 25));
    expect(stream.openCount()).toBe(0);
    expect(bus.listenerCount()).toBe(0);
    // Heartbeat timers are cleared with the stream: after a pause a new, quiet stream sees pings only from its own timer.
    const c = await open(base);
    await c.waitFor((f) => f.filter((x) => x.event === "ping").length >= 2);
    expect(stream.openCount()).toBe(1);
    c.close();
  });
  test("a consumer that stops reading is dropped, not buffered without limit", async () => {
    const { base, bus, stream } = await host(asUsman, { maxBufferedBytes: 1 });
    const c = await open(base);
    await c.waitFor((f) => f.some((x) => x.event === "hello"));
    for (let i = 0; i < 50; i++) bus.publish({ topic: "agent", type: "message", scope: "shared", data: { text: "y".repeat(2000) } });
    for (let i = 0; i < 40 && stream.openCount() > 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(stream.openCount()).toBe(0);
    expect(bus.listenerCount()).toBe(0);
    c.close();
  });
});

describe("reconnect: replay or a fresh snapshot, never a gap", () => {
  test("a known recent Last-Event-ID replays exactly what was missed, in order, once", async () => {
    const { base, bus } = await host(asUsman);
    const first = await open(base);
    await first.waitFor((f) => f.some((x) => x.event === "snapshot"));
    bus.publish({ topic: "job", type: "job", scope: "shared", data: { n: 1 } });
    await first.waitFor((f) => f.some((x) => x.event === "message"));
    const lastId = first.frames.filter((x) => x.event === "message").at(-1)!.id!;
    first.close();
    bus.publish({ topic: "job", type: "job", scope: "shared", final: true, data: { n: 2 } });
    bus.publish({ topic: "job", type: "job", scope: "shared", data: { n: 3 } });
    const again = await open(base, { headers: { "last-event-id": lastId } });
    await again.waitFor((f) => f.filter((x) => x.event === "message").length >= 2);
    expect(again.frames[0].data.mode).toBe("replay");
    expect(again.frames.some((x) => x.event === "snapshot")).toBe(false);
    const got = again.frames.filter((x) => x.event === "message");
    expect(got.map((x) => x.data.data.n)).toEqual([2, 3]);
    expect(got[0].data.final).toBe(true); // the completion that happened while the client was away
    // the query form works for a client that reconnects by hand
    const viaQuery = await open(base, { path: `/__events?last=${encodeURIComponent(lastId)}` });
    await viaQuery.waitFor((f) => f.filter((x) => x.event === "message").length >= 2);
    expect(viaQuery.frames[0].data.mode).toBe("replay");
    again.close();
    viaQuery.close();
  });
  test("an id that is too old, from another boot, ahead of the head or malformed gets a snapshot", async () => {
    const bus = new ActivityBus({ capacity: 3, epoch: "testepoch1" });
    const stream = createStream({ bus, resolvePrincipal: asUsman, snapshot: () => ({ jobs: ["fresh"] }), heartbeatMs: 60_000 });
    server = createServer((req, res) => stream.handle(req, res));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    for (let i = 0; i < 10; i++) bus.publish({ topic: "job", type: "job", scope: "shared", data: i });
    for (const last of ["testepoch1:2", "otherboot9:9", "testepoch1:99", "garbage"]) {
      const c = await open(base, { headers: { "last-event-id": last } });
      await c.waitFor((f) => f.some((x) => x.event === "snapshot"));
      expect(c.frames[0].data.mode).toBe("snapshot");
      expect(c.frames.find((x) => x.event === "snapshot")!.data.jobs).toEqual(["fresh"]);
      expect(c.frames.find((x) => x.event === "snapshot")!.id).toBe(wireId("testepoch1", bus.head()));
      c.close();
    }
  });
  test("a restart (a new bus, a new epoch) answers an old id with a snapshot built from the durable stores", async () => {
    const { base } = await host(asUsman);
    const c = await open(base, { headers: { "last-event-id": "previousboot1:42" } });
    await c.waitFor((f) => f.some((x) => x.event === "snapshot"));
    expect(c.frames[0].data.mode).toBe("snapshot");
    c.close();
  });
});

describe("sources: scope, durability, and notifications that never run anything", () => {
  const device = (id: string, owner: string, kind = "companion", label = id) => ({ id, owner, kind, label });
  function fakeRegistry(devices: ReturnType<typeof device>[], online: Set<string>): RegistryLike {
    return { all: () => devices, isOnline: (d) => online.has(d.id) };
  }

  test("device presence: offline shows on the next sample, only to the owner; shared computers to everyone", () => {
    const bus = new ActivityBus();
    const devices = [device("usman-pc", "usman"), device("mehroz-laptop", "mehroz"), device("shared-1", "shared", "cloud-computer")];
    const online = new Set(["usman-pc", "mehroz-laptop", "shared-1"]);
    const s = startActivitySources({ bus, registry: () => fakeRegistry(devices, online), sampleMs: 3_600_000 });
    expect(bus.head()).toBe(0); // the first sample is a baseline, not news
    online.delete("mehroz-laptop");
    online.delete("shared-1");
    s.sampleNow();
    const events = bus.since(0)!;
    expect(events.map((e) => [e.type, e.scope, JSON.parse(e.frame.split("data: ")[1]).data.id])).toEqual([
      ["offline", "mehroz", "mehroz-laptop"],
      ["offline", "shared", "shared-1"],
    ]);
    s.sampleNow();
    expect(bus.head()).toBe(2); // unchanged presence is not repeated
    s.stop();
  });

  test("real job store: events carry jobSeq, terminal states are final, a personal-device job reaches only its owner, coding is shared", () => {
    const root = mkdtempSync(join(tmpdir(), "s-stream-"));
    try {
      const { jobs } = jobsRuntime(root, { owner: true });
      const bus = new ActivityBus();
      const devices = [device("usman-pc", "usman"), device("mehroz-laptop", "mehroz")];
      const s = startActivitySources({ bus, registry: () => fakeRegistry(devices, new Set(["usman-pc", "mehroz-laptop"])), jobs: () => jobs as never, sampleMs: 3_600_000 });
      const principal = { personId: "mehroz", via: "paired-session", actor: "human" } as const;
      const mine = jobs.create({ kind: "control", principal, targetDeviceId: "mehroz-laptop", title: "Open Notepad" });
      const coding = jobs.create({ kind: "coding", principal, targetDeviceId: "usman-pc", title: "Plan a change" });
      jobs.begin(mine.id);
      jobs.step(mine.id, { executor: "x", intent: "look", outcome: "ok", ms: 5 } as never);
      jobs.finish(mine.id, "succeeded");
      const all = bus.since(0)!;
      const forUsman = all.filter((e) => e.scope === "shared" || e.scope === "usman");
      const forMehroz = all.filter((e) => e.scope === "shared" || e.scope === "mehroz");
      const body = (e: (typeof all)[number]) => JSON.parse(e.frame.split("data: ")[1]);
      expect(forUsman.every((e) => body(e).data.event.jobId === coding.id)).toBe(true); // Usman never hears of Mehroz's laptop job
      expect(forMehroz.some((e) => body(e).data.event.jobId === mine.id)).toBe(true);
      expect(forMehroz.some((e) => body(e).final && body(e).data.event.job?.state === "succeeded")).toBe(true);
      const jobSeqs = all.map((e) => body(e).data.jobSeq);
      expect(jobSeqs).toEqual([...jobSeqs].sort((a, b) => a - b));
      // The snapshot is durable and scoped the same way, and carries the job log's head for the legacy cursor.
      const snapU = s.snapshot("usman") as any;
      const snapM = s.snapshot("mehroz") as any;
      expect(snapU.jobs.map((j: any) => j.id)).toEqual([coding.id]);
      expect(snapM.jobs.map((j: any) => j.id).sort()).toEqual([coding.id, mine.id].sort());
      expect(snapM.jobsHead).toBe(jobs.head());
      expect(JSON.stringify(snapM)).not.toContain("sk1.");
      s.stop();
    } finally {
      closeJobsRuntime(root);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* WAL */
      }
    }
  });

  // Open Dot review C2: the other founder's personal Jarvis jobs (no device) and personal approvals never reach a person.
  test("jobs and approvals with no device belong to their requester; shared computers and business jobs are shared", () => {
    const root = mkdtempSync(join(tmpdir(), "s-stream-own-"));
    try {
      const { jobs } = jobsRuntime(root, { owner: true });
      const bus = new ActivityBus();
      const devices = [device("usman-pc", "usman"), device("mehroz-laptop", "mehroz"), device("shared-1", "shared", "cloud-computer")];
      let approvalListener: ((e: any) => void) | undefined;
      const approvalRows: any[] = [];
      const s = startActivitySources({
        bus,
        registry: () => fakeRegistry(devices, new Set(devices.map((d) => d.id))),
        jobs: () => jobs as never,
        approvals: () => ({ subscribe: (l) => ((approvalListener = l), () => (approvalListener = undefined)), list: () => approvalRows }) as never,
        sampleMs: 3_600_000,
      });
      const usman = { personId: "usman", via: "loopback-owner", actor: "human" } as const;
      const personal = jobs.create({ kind: "voice", principal: usman, targetDeviceId: "none", title: "What is on Bondi Dental's invoice" });
      const unknownDevice = jobs.create({ kind: "command", principal: usman, targetDeviceId: "ghost-device", title: "Look up a client" });
      const onShared = jobs.create({ kind: "control", principal: usman, targetDeviceId: "shared-1", title: "Research on the shared computer" });
      const business = jobs.create({ kind: "trigger", principal: usman, targetDeviceId: "none", title: "Morning summary" });
      const approve = (id: string, action: string, requester: string, deviceId?: string) => {
        const approval = { id, state: "pending", action, requester: { personId: requester, via: "loopback-owner", actor: "human" }, scope: deviceId ? { deviceId } : {}, summary: "x", createdAt: "", expiresAt: "" };
        approvalRows.push(approval);
        approvalListener!({ type: "approval", approval });
      };
      approve("a-msg", "message.send", "usman");
      approve("a-merge", "git.merge.protected", "usman");
      const body = (e: any) => JSON.parse(e.frame.split("data: ")[1]);
      const reach = (person: string) => bus.since(0)!.filter((e) => e.scope === "shared" || e.scope === person);
      const jobIds = (person: string) => new Set(reach(person).filter((e) => e.topic === "job").map((e) => body(e).data.event.jobId));
      expect(jobIds("mehroz").has(personal.id)).toBe(false);
      expect(jobIds("mehroz").has(unknownDevice.id)).toBe(false);
      expect(jobIds("mehroz").has(onShared.id)).toBe(true);
      expect(jobIds("mehroz").has(business.id)).toBe(true);
      expect(jobIds("usman").has(personal.id)).toBe(true);
      const approvalIds = (person: string) => reach(person).filter((e) => e.topic === "approval").map((e) => body(e).data.approval.id);
      expect(approvalIds("mehroz")).toEqual(["a-merge"]);
      expect(approvalIds("usman").sort()).toEqual(["a-merge", "a-msg"]);
      // The snapshot (and so the replay fallback) is scoped the same way.
      const snapM = s.snapshot("mehroz") as any;
      expect(snapM.jobs.map((j: any) => j.id).sort()).toEqual([onShared.id, business.id].sort());
      expect(snapM.approvals.map((a: any) => a.id)).toEqual(["a-merge"]);
      expect((s.snapshot("usman") as any).jobs).toHaveLength(4);
      s.stop();
    } finally {
      closeJobsRuntime(root);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* WAL */
      }
    }
  });

  test("lease events are reduced (no viewer session) and trigger an immediate computer sample", () => {
    const bus = new ActivityBus();
    let listener: ((e: any) => void) | undefined;
    let view = { name: "shared-1", state: "online", controller: { kind: null } };
    const s = startActivitySources({
      bus,
      registry: () => fakeRegistry([], new Set()),
      computers: { list: () => [view as never], targets: () => [], leases: { subscribe: (l) => ((listener = l), () => (listener = undefined)) } },
      sampleMs: 3_600_000,
    });
    view = { name: "shared-1", state: "busy", controller: { kind: "person" as never } };
    listener!({ type: "acquired", lease: { computerId: "dev-1", epoch: 3, holder: { kind: "person", personId: "usman", session: "sk1.SECRETSESSION" }, takeover: null } });
    const out = bus.since(0)!;
    expect(out.map((e) => e.topic)).toEqual(["lease", "computer"]);
    expect(out[0].frame).not.toContain("SECRETSESSION");
    expect(JSON.parse(out[0].frame.split("data: ")[1]).data).toEqual({ computerId: "dev-1", holder: { kind: "person", who: "usman" }, takeoverBy: null });
    s.stop();
    expect(listener).toBeUndefined();
  });

  test("agent messages are masked and bounded; a Jarvis hint is shared", () => {
    const bus = new ActivityBus();
    const s = startActivitySources({ bus, registry: () => fakeRegistry([], new Set()), sampleMs: 3_600_000 });
    s.agentMessage({ agent: "coder", text: "email me at a@b.com code 123456789" });
    s.jarvisChanged("timers");
    const [a, j] = bus.since(0)!;
    expect(a.frame).not.toContain("a@b.com");
    expect(a.frame).not.toContain("123456789");
    expect(j.scope).toBe("shared");
    s.stop();
  });

  test("notifications only: replaying the same events any number of times starts nothing, and the modules have no way to", async () => {
    // No producer or stream code calls anything that executes, creates or changes a job, approval or lease.
    for (const file of ["bus.ts", "stream.ts", "sources.ts"]) {
      const text = readFileSync(join(import.meta.dir, file), "utf8");
      expect(text).not.toMatch(/\.(run|begin|create|cancel|finish|step|decide|consume|handOver|acquire|release|startJob)\(/);
      expect(text).not.toMatch(/from "\.\.\/(executors|coding|jarvis-execution|screen-hands)/);
    }
    // And behaviourally: a stream replayed three times over a finished job leaves the store untouched.
    const root = mkdtempSync(join(tmpdir(), "s-stream-replay-"));
    try {
      const { jobs } = jobsRuntime(root, { owner: true });
      const bus = new ActivityBus();
      const s = startActivitySources({ bus, registry: () => fakeRegistry([], new Set()), jobs: () => jobs as never, sampleMs: 3_600_000 });
      const job = jobs.create({ kind: "voice", principal: { personId: "usman", via: "loopback-owner" }, targetDeviceId: "usman-pc", title: "Say hi" });
      jobs.begin(job.id);
      jobs.finish(job.id, "succeeded");
      const before = JSON.stringify([jobs.get(job.id), jobs.head()]);
      const stream = createStream({ bus, resolvePrincipal: asUsman, snapshot: (p) => s.snapshot(p), heartbeatMs: 60_000 });
      server = createServer((req, res) => stream.handle(req, res));
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      for (let i = 0; i < 3; i++) {
        const c = await open(base, { headers: { "last-event-id": `${bus.epoch}:0` } });
        await c.waitFor((f) => f.filter((x) => x.event === "message").length >= 3);
        c.close();
      }
      expect(JSON.stringify([jobs.get(job.id), jobs.head()])).toBe(before);
      expect(jobs.get(job.id)!.state).toBe("succeeded");
      s.stop();
    } finally {
      closeJobsRuntime(root);
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* WAL */
      }
    }
  });
});

describe("the Jarvis layer hints the stream (and a hint never breaks the gate)", () => {
  test("submit, claim, quiet and call mode call onChange; reading the list does not; a throwing hint is swallowed", async () => {
    const { createJarvisEvents } = await import("../jarvis-events");
    const dir = mkdtempSync(join(tmpdir(), "s-stream-jarvis-"));
    try {
      let n = 0;
      const gate = createJarvisEvents(dir, { now: () => Date.parse("2026-09-24T00:00:00Z"), onChange: () => void n++ });
      const posted = gate.submit({ source: "timer", text: "Tea is ready", priority: "normal" });
      expect(n).toBe(1);
      gate.list(null);
      gate.status();
      expect(n).toBe(1); // reads change nothing and hint nothing (so a refetch can't feed itself)
      gate.setQuiet({ on: true });
      gate.setCallMode(true);
      expect(n).toBe(3);
      const id = (posted as { event?: { id?: string } }).event?.id ?? "x";
      gate.claim({ id });
      expect(n).toBe(4);
      const angry = createJarvisEvents(dir, { now: () => Date.parse("2026-09-24T00:00:00Z"), onChange: () => { throw new Error("boom"); } });
      expect(() => angry.setQuiet({ on: false })).not.toThrow();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* handle */
      }
    }
  });
});
