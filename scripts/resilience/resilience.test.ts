/**
 * Round 6 resilience suite (synthetic, automated). Each failure ends in an accurate state with no duplicated side effect:
 *
 *   1  hub restart in the middle of a job
 *   2  tunnel loss (the computer cannot reach the hub) while a job runs
 *   3  the supervised SSH tunnel itself dying and restarting (one ssh at a time, bounded backoff)
 *   4  browser crash in the middle of a step
 *   5  stale leases (a dead holder never locks a computer; a late command from an old holder is refused)
 *   6  interrupted jobs (the computer's process killed mid-step)
 *   7  memory-sync retries (outage, lost response, no hammering, no duplicate memory)
 *   8  duplicate events (the same job event, thread entry, report or notice delivered twice)
 *
 * "Side effects" are counted by executors that record every time they run, so a replay shows up as a count of 2.
 * The real hub, job store, lease manager, companion worker and memory connector are used; only the host machine and Hindsight are simulated.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Executor } from "../../companion/executors";
import { applyJobEvents } from "../../src/lib/job-events";
import type { JobEvent, JobSummary, Step } from "../jobs/types";
import { abortableSleep } from "../executors/windows";
import { LeaseManager } from "../computers/lease";
import { SshTunnel, type TunnelChild } from "../computers/ssh-tunnel";
import { startComputersHub, type ComputersHub } from "../computers/test-harness";
import { threadDeliver } from "../computers/research-wiring";
import { cleanup as cleanupMemory, setup as setupMemory, usman } from "../memory/testing/harness";

setDefaultTimeout(60_000);
let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
  await cleanupMemory();
});

const ok = (said: string) => ({ ok: true, said, verified: true });

/** Executors that record every run, so a replayed step is visible as a second entry. */
function recorder() {
  const ran: string[] = [];
  const crashOnce = new Set<string>();
  const factory = (): Record<string, Executor> => {
    const step = (label: string): Executor => async (args, ctx) => {
      const tag = `${label}:${String(args.tag ?? "")}`;
      ran.push(tag);
      if (crashOnce.delete(tag)) throw new Error("Target page, context or browser has been closed");
      if (args.ms) await abortableSleep(Number(args.ms), ctx.signal);
      return ctx.signal.aborted ? { ok: false, said: "Stopped.", verified: false } : ok(`${label} ${String(args.tag ?? "")}`.trim());
    };
    return { echo: step("echo"), wait: step("wait"), "browser.navigate": step("browser.navigate"), "file.write": step("file.write") };
  };
  return { ran, crashOnce, factory };
}

async function oneComputer(opts: Parameters<typeof startComputersHub>[0] = {}) {
  const rec = recorder();
  hub = await startComputersHub(opts);
  hub.host.executorsFor = rec.factory;
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
  return { h: hub, rec };
}

const job = (h: ComputersHub, steps: { executor: string; args?: Record<string, unknown> }[], agent = "reader") => h.api("usman", "POST", "/research/jobs", { agent, steps }).then((r) => (expect(r.status).toBe(200), r.json.jobId as string));
const stateOf = (h: ComputersHub, id: string) => h.jobs.get(id)?.state;
const terminal = (s?: string) => ["succeeded", "failed", "unknown", "cancelled", "interrupted"].includes(s ?? "");

describe("1 · hub restart in the middle of a job", () => {
  test("the job ends 'unknown' with a plain note, the step in flight ran once and is never replayed, later steps never ran, and the computer reconnects and works", async () => {
    const { h, rec } = await oneComputer();
    const id = await job(h, [{ executor: "echo", args: { tag: "before" } }, { executor: "wait", args: { tag: "inflight", ms: 1_500 } }, { executor: "echo", args: { tag: "after" } }]);
    await h.waitFor("the long step to start", () => rec.ran.includes("wait:inflight"));
    const { root, port, host } = h;
    await h.close({ root: true, host: true, abrupt: true }); // the hub process is killed (kill -9); the computer's own process stays up
    hub = undefined;
    // The store, read directly (no hub running): the job is still "running". Nothing from the dead hub settled it.
    const peek = () => {
      const db = new Database(join(root, ".operator-data", "jobs.sqlite"), { readonly: true });
      try {
        return (db.query("SELECT state FROM jobs WHERE id = ?").get(id) as { state: string } | null)?.state;
      } finally {
        db.close();
      }
    };
    await new Promise((r) => setTimeout(r, 2_200)); // longer than the step: a live old runner would have settled it by now
    expect(peek()).toBe("running");
    const again = await startComputersHub({ restart: { root, port }, host });
    hub = again;
    host.executorsFor = rec.factory;
    // The NEW hub is what settles it, at startup, with the restart wording.
    expect(stateOf(again, id)).toBe("unknown");
    expect(again.jobs.get(id)!.note).toBe("Interrupted by a restart: the outcome is unknown and it was not re-run.");
    await again.waitFor("the computer to come back", () => again.computers.view("research").state === "online", 15_000);
    await new Promise((r) => setTimeout(r, 2_500)); // long enough for any replay to show
    expect(rec.ran.filter((x) => x === "echo:before")).toHaveLength(1);
    expect(rec.ran.filter((x) => x === "wait:inflight")).toHaveLength(1);
    expect(rec.ran.filter((x) => x === "echo:after")).toHaveLength(0);
    expect(stateOf(again, id)).toBe("unknown"); // still the same honest answer, not rewritten as success or re-run
    expect(again.computers.view("research").controller.kind).toBeNull(); // nothing still holds the lease
    const next = await job(again, [{ executor: "echo", args: { tag: "fresh" } }]);
    await again.waitFor("a new job to run", () => stateOf(again, next) === "succeeded");
  });
});

describe("2 · the computer loses its way to the hub (a dead tunnel) while a job runs", () => {
  test("the hub never claims success it did not see; the step ran once; when the way back returns nothing is replayed and the computer is online again", async () => {
    const { h, rec } = await oneComputer();
    const id = await job(h, [{ executor: "wait", args: { tag: "during", ms: 700 } }, { executor: "echo", args: { tag: "next" } }]);
    await h.waitFor("the step to start", () => rec.ran.includes("wait:during"));
    h.host.dead.add("research"); // every request from the computer to the hub now fails: the tunnel is down
    // With nothing to tell the hub, the bound is the presence TTL (30 s): then the job ends "unknown", not "succeeded".
    await h.waitFor("the job to reach an honest end", () => terminal(stateOf(h, id)), 50_000);
    const during = stateOf(h, id);
    expect(["unknown", "failed", "interrupted"]).toContain(during); // never "succeeded": the hub did not see the result
    expect(h.computers.view("research").state).not.toBe("online"); // and the computer is not shown as healthy while unreachable
    h.host.dead.delete("research"); // the tunnel comes back
    await h.waitFor("the computer to be online again", () => h.computers.view("research").state === "online", 20_000);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(rec.ran.filter((x) => x === "wait:during")).toHaveLength(1);
    expect(rec.ran.filter((x) => x === "echo:next")).toHaveLength(0); // the job ended unknown before step two; it never ran
    expect(stateOf(h, id)).toBe(during); // the recorded end did not flip later
    const next = await job(h, [{ executor: "echo", args: { tag: "after-return" } }]);
    await h.waitFor("work to resume", () => stateOf(h, next) === "succeeded", 15_000);
    expect(rec.ran.filter((x) => x === "echo:after-return")).toHaveLength(1);
  });
});

describe("3 · the supervised SSH tunnel dies and restarts", () => {
  test("only one ssh is ever alive, restarts back off and are bounded in rate, it is up only after the positive echo, and close() leaves nothing running", async () => {
    const children: (EventEmitter & TunnelChild & { alive: boolean; stdinLog: string[] })[] = [];
    const logs: string[] = [];
    const spawnFn = () => {
      const e = new EventEmitter() as EventEmitter & TunnelChild & { alive: boolean; stdinLog: string[] };
      e.alive = true;
      e.stdinLog = [];
      e.stdout = new EventEmitter();
      e.stderr = new EventEmitter();
      e.stdin = { write: (c: string) => (e.stdinLog.push(c), setTimeout(() => e.alive && (e.stdout as EventEmitter).emit("data", c), 2), true), on: () => undefined };
      e.kill = () => {
        if (e.alive) {
          e.alive = false;
          setTimeout(() => e.emit("close", 255), 1);
        }
        return true;
      };
      children.push(e);
      return e;
    };
    const tunnel = new SshTunnel({ command: "ssh", args: ["-R", "x"], spawnFn, readyMarker: "READY", backoffMs: [20, 40, 80], settleMs: 500, onLog: (l) => logs.push(l) });
    await tunnel.ensure(2_000);
    expect(tunnel.status().state).toBe("up");
    expect(children).toHaveLength(1);
    // the tunnel dies three times in a row (network blip, host reboot, port taken)
    for (let i = 0; i < 3; i++) {
      const live = children.filter((c) => c.alive);
      expect(live.length).toBeLessThanOrEqual(1);
      children[children.length - 1].alive = false;
      children[children.length - 1].emit("close", 255);
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(tunnel.status().restarts).toBe(3);
    expect(children.length).toBe(4);
    expect(children.filter((c) => c.alive)).toHaveLength(1); // exactly one ssh alive, never two holding the remote port
    expect(tunnel.status().state).toBe("up");
    expect(children.every((c) => c.stdinLog.length === 1)).toBe(true); // each attempt wrote its marker once
    tunnel.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(children.filter((c) => c.alive)).toHaveLength(0);
    expect(tunnel.status().state).toBe("closed");
    const spawned = children.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(children.length).toBe(spawned); // nothing restarts after close
  });
});

describe("4 · browser crash in the middle of a step", () => {
  test("the step is reported failed with the reason, is not retried behind the person's back, later steps do not run, and the next job works", async () => {
    const { h, rec } = await oneComputer();
    rec.crashOnce.add("browser.navigate:crashing");
    const id = await job(h, [{ executor: "echo", args: { tag: "first" } }, { executor: "browser.navigate", args: { tag: "crashing" } }, { executor: "echo", args: { tag: "never" } }]);
    await h.waitFor("the job to settle", () => terminal(stateOf(h, id)), 15_000);
    expect(["failed", "unknown"]).toContain(stateOf(h, id));
    expect(stateOf(h, id)).not.toBe("succeeded");
    const view = h.computers.jobView(id)!;
    const crashed = view.steps.find((x) => /crashing|browser/i.test(`${x.intent} ${x.executor}`) && x.outcome !== "ok");
    expect(crashed).toBeTruthy(); // the failed step is on the record, not just the job's end state
    expect(["failed", "unknown"]).toContain(crashed!.outcome);
    expect(`${crashed!.intent} ${h.jobs.get(id)!.note ?? ""}`).toMatch(/closed|crash|browser/i); // and it says why
    expect(view.steps.filter((x) => x.outcome === "ok")).toHaveLength(1); // only the first echo succeeded
    await new Promise((r) => setTimeout(r, 1_000));
    expect(rec.ran.filter((x) => x === "browser.navigate:crashing")).toHaveLength(1); // no silent retry of a navigation that may have happened
    expect(rec.ran.filter((x) => x === "echo:never")).toHaveLength(0);
    expect(h.computers.view("research").controller.kind).toBeNull(); // the crash did not leave the computer locked
    const next = await job(h, [{ executor: "browser.navigate", args: { tag: "again" } }]);
    await h.waitFor("a fresh job to run on the same computer", () => stateOf(h, next) === "succeeded", 15_000);
  });
});

describe("5 · stale leases", () => {
  test("an agent that stops renewing frees the computer after its TTL, and its late command (old epoch) is refused", () => {
    let t = 1_000_000;
    const leases = new LeaseManager(() => t, 60_000, 90_000);
    const a = leases.acquireAgent("c1", { jobId: "job-a", by: "usman", agent: "reader" });
    expect(a.ok).toBe(true);
    const oldEpoch = a.ok ? a.lease.epoch : -1;
    expect(leases.acquireAgent("c1", { jobId: "job-b", by: "mehroz", agent: "coder" }).ok).toBe(false); // held: nothing queued behind it
    t += 59_000;
    expect(leases.valid("c1", "agent:job-a", oldEpoch)).toBe(true); // activity renews
    t += 61_000; // the holder's process died: no renewal for longer than the TTL
    expect(leases.current("c1")).toBeNull();
    const b = leases.acquireAgent("c1", { jobId: "job-b", by: "mehroz", agent: "coder" });
    expect(b.ok).toBe(true);
    expect(b.ok && b.lease.epoch).toBeGreaterThan(oldEpoch);
    expect(leases.valid("c1", "agent:job-a", oldEpoch)).toBe(false); // the dead job's late command is refused
    expect(leases.valid("c1", "agent:job-b", b.ok ? b.lease.epoch : -1)).toBe(true);
  });

  test("a person who walks away while an agent was paused hands control back to that same job exactly once", () => {
    let t = 5_000_000;
    const leases = new LeaseManager(() => t, 60_000, 90_000);
    const events: string[] = [];
    leases.subscribe((e) => events.push(e.type));
    const a = leases.acquireAgent("c1", { jobId: "job-a", by: "usman", agent: "reader" });
    expect(a.ok).toBe(true);
    expect(leases.requestTakeover("c1", { personId: "usman", session: "s1" })).toMatchObject({ ok: true, state: "pending" });
    expect(leases.handOver("c1", "job-a")).toBeTruthy();
    expect(leases.current("c1")!.holder.kind).toBe("person");
    t += 100_000; // the viewer closed without a goodbye
    const back = leases.current("c1")!;
    expect(back.holder).toMatchObject({ kind: "agent", jobId: "job-a" });
    expect(leases.current("c1")!.epoch).toBe(back.epoch); // reading again does not hand it back twice
    expect(events.filter((e) => e === "returned")).toHaveLength(1);
  });

  test("a job whose computer died never leaves its lease behind: a new job gets the computer at once", async () => {
    const { h, rec } = await oneComputer({ autoRecover: false });
    const dead = await job(h, [{ executor: "wait", args: { tag: "doomed", ms: 600 } }, { executor: "echo", args: { tag: "x" } }], "doomed-agent");
    await h.waitFor("the step to start", () => rec.ran.includes("wait:doomed"));
    h.host.crash("research");
    await h.computers.tick();
    await h.waitFor("the job to end", () => terminal(stateOf(h, dead)), 10_000);
    expect(h.computers.view("research").controller.kind).toBeNull();
    await h.api("usman", "POST", "/research/action", { action: "recover" });
    await h.waitFor("online", () => h.computers.view("research").state === "online", 15_000);
    const next = await job(h, [{ executor: "echo", args: { tag: "next-owner" } }], "next-agent");
    await h.waitFor("the next agent to run", () => stateOf(h, next) === "succeeded", 15_000);
  });
});

describe("6 · interrupted jobs", () => {
  test("a computer killed mid-step: the job is 'unknown' quickly (not a timeout), the step ran once, later steps never ran, and a recovery does not replay", async () => {
    const { h, rec } = await oneComputer({ autoRecover: false });
    const id = await job(h, [{ executor: "wait", args: { tag: "inflight", ms: 800 } }, { executor: "echo", args: { tag: "later" } }]);
    await h.waitFor("the step to start", () => rec.ran.includes("wait:inflight"));
    const killed = Date.now();
    h.host.crash("research");
    await h.computers.tick();
    await h.waitFor("an honest end", () => terminal(stateOf(h, id)), 6_000);
    expect(Date.now() - killed).toBeLessThan(6_000);
    expect(stateOf(h, id)).toBe("unknown");
    expect(h.jobs.get(id)!.note).toMatch(/may or may not have happened/);
    await h.api("usman", "POST", "/research/action", { action: "recover" });
    await h.waitFor("online", () => h.computers.view("research").state === "online", 15_000);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(rec.ran.filter((x) => x === "wait:inflight")).toHaveLength(1);
    expect(rec.ran.filter((x) => x === "echo:later")).toHaveLength(0);
    expect(stateOf(h, id)).toBe("unknown");
  });
});

describe("7 · memory-sync retries", () => {
  test("an outage queues the change, retries are paced by backoff (a burst of sync calls does not hammer Hindsight), and recovery sends it exactly once", async () => {
    const m = await setupMemory();
    await m.api.sync({ force: true });
    const retainCalls = () => m.fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/memories")).length;
    const base = retainCalls();
    await m.fake.down();
    const saved = await m.api.remember(usman, { text: "The synthetic Plover depot opens at 7am.", channel: "voice" });
    expect(saved.ok).toBe(true); // the local save is real even though Hindsight is down
    await m.api.sync().catch(() => undefined);
    const afterFirst = m.api.status().pending;
    expect(afterFirst).toBeGreaterThan(0);
    // a burst of ordinary (non-forced) syncs inside the backoff window makes no new attempts
    const attemptsBefore = m.fake.calls.length;
    for (let i = 0; i < 6; i++) await m.api.sync().catch(() => undefined);
    expect(m.fake.calls.length - attemptsBefore).toBeLessThanOrEqual(1);
    expect(m.api.status().pending).toBe(afterFirst); // still queued, honestly reported, nothing dropped
    await m.fake.up();
    await m.api.sync({ force: true });
    expect(m.api.status().pending).toBe(0);
    expect(retainCalls() - base).toBe(1); // sent once
    const docs = [...m.bankDocs().values()].filter((d) => d.content.includes("Plover depot"));
    expect(docs).toHaveLength(1);
    await m.api.sync({ force: true });
    expect(retainCalls() - base).toBe(1); // and a later sync does not send it again
  });

  test("a retain Hindsight applied but whose response was lost is replayed without creating a second memory", async () => {
    const m = await setupMemory();
    await m.api.sync({ force: true });
    m.fake.loseRetainResponses(1);
    const r = await m.api.remember(usman, { text: "The synthetic Curlew office has a blue door.", channel: "voice" });
    expect(r.ok).toBe(true);
    await m.api.sync({ force: true });
    await m.api.sync({ force: true });
    const docs = [...m.bankDocs().values()].filter((d) => d.content.includes("Curlew office"));
    expect(docs).toHaveLength(1);
    expect(m.api.status().pending).toBe(0);
  });
});

describe("8 · duplicate events", () => {
  const summary = (over: Partial<JobSummary>): JobSummary =>
    ({ id: "j1", kind: "coding", title: "t", state: "running", stepCount: 0, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:01Z", lastStep: null, ...over }) as unknown as JobSummary;
  const step = (seq: number): Step => ({ seq, at: seq, intent: `step ${seq}`, executor: "echo", ms: 1, outcome: "ok" });

  test("the same job and step events delivered twice, or replayed after a reconnect, fold to the same state", () => {
    const events: JobEvent[] = [
      { type: "job", jobId: "j1", job: summary({}) } as JobEvent,
      { type: "step", jobId: "j1", step: step(1) } as JobEvent,
      { type: "step", jobId: "j1", step: step(2) } as JobEvent,
      { type: "job", jobId: "j1", job: summary({ state: "succeeded", stepCount: 2, updatedAt: "2026-10-02T00:00:05Z" }) } as JobEvent,
    ];
    const once = applyJobEvents(new Map(), events);
    const twice = applyJobEvents(applyJobEvents(new Map(), events), events); // a replay of everything
    const interleaved = applyJobEvents(new Map(), [events[0], events[1], events[1], events[2], events[1], events[3], events[2]]);
    for (const folded of [twice, interleaved]) {
      const j = folded.get("j1")!;
      expect(j.steps.map((s) => s.seq)).toEqual([1, 2]); // each step once
      expect(j.state).toBe("succeeded");
    }
    expect(once.get("j1")!.steps).toHaveLength(2);
  });

  test("a report or progress entry delivered twice lands in the conversation once", async () => {
    const entries: { id: string; key: string }[] = [];
    const store: any = {
      list: () => [{ id: "c-usman", thread: "jarvis", jobs: [{ jobId: "j1" }] }],
      get: (id: string) => ({ id, personId: "usman" }),
      appendEntry: (id: string, e: { key: string }) => (entries.some((x) => x.id === id && x.key === e.key) ? null : (entries.push({ id, key: e.key }), { seq: entries.length })),
    };
    const deliver = threadDeliver(store);
    const report = "Research: x\n- a fact [1]";
    await deliver({ jobId: "j1", by: "usman", title: "t", report });
    await deliver({ jobId: "j1", by: "usman", title: "t", report });
    await Promise.all([deliver({ jobId: "j1", by: "usman", title: "t", report }), deliver({ jobId: "j1", by: "usman", title: "t", report })]);
    expect(entries).toEqual([{ id: "c-usman", key: "j1:report:1" }]);
  });

  test("a finished job announces its end exactly once, and a hub restart does not announce or change it again", async () => {
    const { h, rec } = await oneComputer();
    const ends: string[] = [];
    h.jobs.subscribe((e) => e.type === "job" && ["succeeded", "failed", "unknown", "cancelled", "interrupted"].includes(e.job.state) && ends.push(`${e.job.id}:${e.job.state}`));
    const id = await job(h, [{ executor: "echo", args: { tag: "once" } }]);
    await h.waitFor("done", () => stateOf(h, id) === "succeeded");
    await new Promise((r) => setTimeout(r, 400));
    expect(ends.filter((x) => x.startsWith(id))).toEqual([`${id}:succeeded`]); // one end announcement, not one per report
    const before = h.jobs.get(id)!;
    const { root, port, host } = h;
    await h.close({ root: true, host: true }); // an ordinary restart of the hub
    hub = undefined;
    const again = await startComputersHub({ restart: { root, port }, host });
    hub = again;
    host.executorsFor = rec.factory;
    const after: string[] = [];
    again.jobs.subscribe((e) => e.type === "job" && e.job.id === id && after.push(e.job.state));
    await again.waitFor("the computer to reconnect", () => again.computers.view("research").state === "online", 15_000);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(after).toEqual([]); // nothing about the finished job is re-announced after the restart
    expect(again.jobs.get(id)!.state).toBe("succeeded");
    expect(again.jobs.get(id)!.updatedAt).toBe(before.updatedAt);
    expect(rec.ran.filter((x) => x === "echo:once")).toHaveLength(1);
  });
});
