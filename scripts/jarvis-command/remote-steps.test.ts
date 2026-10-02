import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLedger } from "../../companion/ledger";
import type { Executor } from "../../companion/executors";
import { CompanionWorker } from "../../companion/worker";
import { resolveTarget } from "../devices/route";
import { startHub, type Hub, type Who } from "../devices/test-harness";
import { JobService } from "../jobs/service";
import type { Principal } from "../identity/principal";
import { abortableSleep } from "../executors/windows";
import { COMPANION_EXECUTORS, type CommandBody, type CommandDoneEvent } from "./contracts";
import { parseCommandBody, parseSteps } from "./route";
import { createCommandService } from "./service";

// SYNTHETIC: the real command service + a real JobService (SQLite on D:-style temp) over a real /__devices
// service, with a real CompanionWorker per PC running fake executors. No desktop, browser or network.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const until = async (check: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

const usmanAtPc: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };

async function rig(opts: { role?: "pc" | "cloud" | "server"; observeWaitMs?: number } = {}) {
  const hub: Hub = await startHub({ maxWaitMs: 300, hubRole: opts.role ?? "pc", observeWaitMs: opts.observeWaitMs ?? 300 });
  const dir = mkdtempSync(join(tmpdir(), "remote-steps-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 1500, snapshotMs: 0 });
  let entryCalls = 0;
  const service = createCommandService({
    jobs: () => jobs,
    entry: () => {
      entryCalls++;
      return null;
    },
    hubDeviceId: hub.svc.hubIsDevice ? "usman-pc" : "",
    resolveTarget: (ctx) => resolveTarget(ctx, hub.svc.registry),
    dispatcher: hub.svc.dispatcher,
    micOwner: (p) => hub.svc.registry.micOwner(p),
    deviceLabel: (id) => hub.svc.registry.all().find((d) => d.id === id)?.label ?? id,
    remoteTimeoutMs: 5_000,
  });
  const workers: CompanionWorker[] = [];
  cleanups.push(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await hub.close();
    try {
      jobs.close();
    } catch {
      /* running */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  async function pair(owner: "usman" | "mehroz", label: string, executors: Record<string, Executor>, extra: { flaky?: { down: boolean }; ledger?: CommandLedger; aliases?: string[] } = {}) {
    const issuer = owner === "usman" ? hub.browser("local") : hub.browser("mehroz");
    if (owner === "mehroz") {
      const paired = await issuer.post("/pair/tailnet", { label: "b" });
      // Server role: a self-paired browser is pending until a confirmed session approves it (the review's self-upgrade fix).
      if (paired.json.pending) expect(hub.svc.store.approveSession(paired.json.session.id).ok).toBe(true);
    }
    const code = (await issuer.post("/pair/code", { purpose: "companion" })).json.code as string;
    const headers = hub.headersFor(owner as Who);
    const res = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code, label, aliases: extra.aliases ?? ["pc"] }) });
    const paired = (await res.json()) as any;
    expect(res.status).toBe(200);
    const ledger = extra.ledger ?? new CommandLedger();
    const worker = new CompanionWorker({
      hubUrl: hub.base, token: paired.token, deviceId: paired.deviceId, owner, extraHeaders: headers, heartbeatMs: 40, pollWaitMs: 300,
      executors, ledger, interactive: async () => true,
      fetchImpl: (async (input: any, init?: any) => {
        if (extra.flaky?.down) throw new Error("network down");
        return fetch(input, init);
      }) as typeof fetch,
      log: () => undefined,
    }).start();
    workers.push(worker);
    expect(await worker.waitOnline()).toBe(true);
    return { worker, ledger, deviceId: paired.deviceId as string };
  }
  async function run(principal: Principal, body: Partial<CommandBody>): Promise<CommandDoneEvent> {
    return service.run({ principal, body: { utterance: "do these", source: "typed", ...body } as CommandBody });
  }
  return { hub, jobs, service, pair, run, entryCalls: () => entryCalls };
}

/** Fake executors that record what ran, in order. */
function pcExecutors(log: string[], opts: { failOn?: string; slowMs?: number } = {}): Record<string, Executor> {
  const ok = (name: string): Executor => async (args, ctx) => {
    log.push(`${name}:${String(args.tag ?? "")}`);
    if (opts.slowMs && name === "wait") await abortableSleep(opts.slowMs, ctx.signal).catch(() => undefined);
    if (ctx.signal.aborted) return { ok: false, said: "Cancelled.", verified: false, data: { cancelled: true } };
    if (opts.failOn && String(args.tag) === opts.failOn) return { ok: false, said: `Step ${args.tag} didn't verify.`, verified: false };
    return { ok: true, said: `${name} ${args.tag ?? ""} done.`.replace(/ +/g, " "), verified: true, evidence: `${name} read back` };
  };
  return { echo: ok("echo"), wait: ok("wait"), "app.focus": ok("app.focus"), "browser.navigate": ok("browser.navigate"), "observe.window": ok("observe.window") };
}

const job = (r: Awaited<ReturnType<typeof rig>>, id: string | null) => (id ? r.jobs.get(id) : null);

describe("a typed plan becomes a job with steps, each dispatched to the requester's own device", () => {
  test("three steps run in order on Mehroz's PC, each checked, each carrying the job and step on the wire", async () => {
    const r = await rig();
    const log: string[] = [];
    const m = await r.pair("mehroz", "Mehroz's PC", pcExecutors(log));
    const done = await r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "one" } }, { executor: "echo", args: { tag: "two" } }, { executor: "echo", args: { tag: "three" } }] });
    expect(done).toMatchObject({ ok: true, kind: "remote", verified: true, targetDeviceId: m.deviceId });
    expect(log).toEqual(["echo:one", "echo:two", "echo:three"]);
    const j = job(r, done.jobId)!;
    expect(j.state).toBe("succeeded");
    expect(j.steps.filter((s) => s.executor === "companion").map((s) => s.outcome)).toEqual(["ok", "ok", "ok"]);
    // The wire carried job + step; the companion's ledger is keyed by them.
    expect(m.ledger.list().map((e) => e.commandKey).sort()).toEqual([`${done.jobId}/s1`, `${done.jobId}/s2`, `${done.jobId}/s3`]);
    expect(m.ledger.list().every((e) => e.jobId === done.jobId && /^s[123]$/.test(e.stepId ?? ""))).toBe(true);
    expect(r.entryCalls()).toBe(0);
  });

  test("a step that doesn't verify stops the job there: later steps never run and are recorded as not run", async () => {
    const r = await rig();
    const log: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", pcExecutors(log, { failOn: "two" }));
    const done = await r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "one" } }, { executor: "echo", args: { tag: "two" } }, { executor: "echo", args: { tag: "three" } }] });
    expect(done).toMatchObject({ ok: false, outcome: "unverified" });
    expect(done.said).toContain("Stopped at step 2 of 3");
    expect(done.said).toContain("Step two didn't verify");
    expect(log).toEqual(["echo:one", "echo:two"]);
    const steps = job(r, done.jobId)!.steps.map((s) => s.outcome);
    expect(steps).toEqual(["ok", "failed", "skipped"]);
  });

  test("two equal steps in one plan are two steps (no dedupe across them)", async () => {
    const r = await rig();
    const log: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", pcExecutors(log));
    const done = await r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "x" } }, { executor: "echo", args: { tag: "x" } }] });
    expect(done.ok).toBe(true);
    expect(log).toEqual(["echo:x", "echo:x"]);
  });

  test("a step the companion doesn't run is refused before any of it runs", async () => {
    const r = await rig();
    const log: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", pcExecutors(log));
    const done = await r.run(mehroz, { steps: [{ executor: "echo", args: {} }, { executor: "screen.act" as never, args: {} }] });
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(log).toEqual([]);
  });

  test("a plan never runs on the hub's own screen", async () => {
    const r = await rig();
    const done = await r.run(usmanAtPc, { steps: [{ executor: "echo", args: {} }] });
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(done.said).toContain("paired companion");
    expect(r.entryCalls()).toBe(0);
  });
});

describe("cancel: steps after the cancel never run", () => {
  test("cancelled as soon as step 1 is done: steps 2 and 3 are never dispatched", async () => {
    const r = await rig();
    const log: string[] = [];
    const m = await r.pair("mehroz", "Mehroz's PC", pcExecutors(log));
    const unsubscribe = r.jobs.subscribe((e) => {
      // The moment step 1's result is recorded, the person says stop.
      if (e.type === "step" && e.step.executor === "companion" && e.step.outcome === "ok") void r.jobs.cancel(e.jobId);
    });
    cleanups.push(() => unsubscribe());
    const done = await r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "one" } }, { executor: "echo", args: { tag: "two" } }, { executor: "echo", args: { tag: "three" } }] });
    expect(done).toMatchObject({ ok: false, stopped: true });
    await new Promise((res) => setTimeout(res, 200));
    expect(log).toEqual(["echo:one"]);
    expect(m.ledger.list()).toHaveLength(1);
    const j = job(r, done.jobId)!;
    expect(j.state).toBe("cancelled");
    expect(j.steps.map((s) => s.outcome)).toEqual(["ok", "skipped", "skipped"]);
  });

  test("cancelled while step 2 is running: the companion aborts it, step 3 never starts", async () => {
    const r = await rig();
    const log: string[] = [];
    const m = await r.pair("mehroz", "Mehroz's PC", pcExecutors(log, { slowMs: 10_000 }));
    const pending = r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "one" } }, { executor: "wait", args: { tag: "two" } }, { executor: "echo", args: { tag: "three" } }] });
    expect(await until(() => log.includes("wait:two"))).toBe(true);
    const live = r.service.liveJobs()[0];
    await r.jobs.cancel(live);
    const done = await pending;
    expect(done).toMatchObject({ ok: false, stopped: true });
    expect(await until(() => m.worker.history.some((h) => h.executor === "wait" && h.outcome === "cancelled"))).toBe(true);
    expect(log).toEqual(["echo:one", "wait:two"]);
    expect(job(r, done.jobId)!.state).toBe("cancelled");
  });
});

describe("the companion dies mid-job: device offline / uncertain, never success, never replayed", () => {
  test("killed during step 2: the job ends uncertain, step 3 is not run, nothing ran on any other device", async () => {
    const r = await rig();
    const log: string[] = [];
    const flaky = { down: false };
    const m = await r.pair("mehroz", "Mehroz's PC", pcExecutors(log, { slowMs: 30_000 }), { flaky });
    const pending = r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "one" } }, { executor: "wait", args: { tag: "two" } }, { executor: "echo", args: { tag: "three" } }] });
    expect(await until(() => log.includes("wait:two"))).toBe(true);
    // The PC is killed: no result, no goodbye, no more heartbeats.
    flaky.down = true;
    await m.worker.stop();
    r.hub.clock.advance(31_000);
    r.hub.svc.dispatcher.sweepOffline();
    const done = await pending;
    expect(done).toMatchObject({ ok: false, outcome: "uncertain", verified: null });
    expect(done.said).toMatch(/went offline/);
    expect(done.said).toMatch(/can't say whether it happened/);
    expect(done.said).toMatch(/haven't tried it again/);
    expect(log).toEqual(["echo:one", "wait:two"]);
    const j = job(r, done.jobId)!;
    expect(j.state).toBe("unknown"); // neither success nor a plain failure: it may have happened
    expect(j.steps.map((s) => s.outcome)).toEqual(["ok", "unknown", "skipped"]);
    expect(j.note).toMatch(/went offline/);
    expect(r.entryCalls()).toBe(0);
  });

  test("the PC is already offline when the job starts: nothing ran, said plainly, never moved to another machine", async () => {
    const r = await rig();
    const log: string[] = [];
    const m = await r.pair("mehroz", "Mehroz's PC", pcExecutors(log));
    r.hub.svc.dispatcher.deviceOffline(m.deviceId);
    const done = await r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "one" } }] });
    expect(done).toMatchObject({ ok: false });
    expect(done.said).toMatch(/Mehroz's PC is offline, so nothing ran/);
    expect(log).toEqual([]);
  });
});

describe("the single-executor words still work, now with job and step on the wire", () => {
  test("'open notepad' → one typed step, verified by the companion, the wire key is job/step", async () => {
    const r = await rig();
    const log: string[] = [];
    const m = await r.pair("mehroz", "Mehroz's PC", { "app.open": async (args) => (log.push(`app.open:${String(args.name)}`), { ok: true, said: "Opened Notepad.", verified: true, evidence: "new window" }) });
    const done = await r.run(mehroz, { utterance: "open notepad" });
    expect(done).toMatchObject({ ok: true, kind: "remote", verified: true });
    expect(log).toEqual(["app.open:notepad"]);
    expect(m.ledger.list()[0].commandKey).toBe(`${done.jobId}/s1`);
  });
});

// The server role (the headless Ryzen-PC hub) is not a device either: the same tests prove the same behaviour.
for (const role of ["cloud", "server"] as const)
describe(`MU_HUB_ROLE=${role}: the hub is not a device; Usman's PC is his paired companion`, () => {
  test("the hub is not listed, not online and not a target: only paired companions exist", async () => {
    const r = await rig({ role });
    expect(r.hub.svc.hubIsDevice).toBe(false);
    expect(r.hub.svc.registry.all()).toEqual([]);
    const listed = (await r.hub.browser("local").get("/devices")).json.devices;
    expect(listed.filter((d: any) => d.kind === "hub")).toEqual([]);
    // No companion yet: Usman has no device at all, and the hub is not a fallback.
    expect(resolveTarget({ personId: "usman" }, r.hub.svc.registry)).toEqual({ ok: false, reason: "no device registered for usman" });
    expect(resolveTarget({ personId: "usman", spokenTarget: "here" }, r.hub.svc.registry)).toMatchObject({ ok: false });
    expect(await r.hub.svc.dispatcher.submit({ personId: "usman", executor: "echo" })).toMatchObject({ ok: false, reason: "no device registered for usman" });
    // Same for the PC role's control: the default role still lists the hub.
    const pc = await startHub({ hubRole: "pc" });
    cleanups.push(() => pc.close());
    expect(pc.svc.registry.all().map((d) => d.id)).toEqual(["usman-pc"]);
  });

  test("Usman's paired companion runs his commands; 'here' and 'this pc' resolve to it, even from the server's loopback", async () => {
    const r = await rig({ role });
    const log: string[] = [];
    const u = await r.pair("usman", "Usman's PC", pcExecutors(log), { aliases: ["pc", "desktop"] });
    expect(resolveTarget({ personId: "usman", spokenTarget: "here" }, r.hub.svc.registry)).toMatchObject({ ok: true, deviceId: u.deviceId });
    expect(resolveTarget({ personId: "usman", spokenTarget: "on this pc" }, r.hub.svc.registry)).toMatchObject({ ok: true, deviceId: u.deviceId });
    // The loopback-owner principal (someone at the server itself) gets no "hub screen": it goes to his companion.
    const done = await r.run(usmanAtPc, { steps: [{ executor: "echo", args: { tag: "from-cloud" } }], spokenTarget: "this pc" });
    expect(done).toMatchObject({ ok: true, kind: "remote", targetDeviceId: u.deviceId });
    expect(log).toEqual(["echo:from-cloud"]);
    expect(r.entryCalls()).toBe(0);
    // And it never reaches Mehroz's device, nor the other way round.
    const m = await r.pair("mehroz", "Mehroz's PC", pcExecutors(log));
    const forMehroz = await r.run(mehroz, { steps: [{ executor: "echo", args: { tag: "m" } }] });
    expect(forMehroz.targetDeviceId).toBe(m.deviceId);
    expect(log).toEqual(["echo:from-cloud", "echo:m"]);
  });

  test("Usman's companion offline: 'here' fails honestly as offline; nothing runs anywhere else", async () => {
    const r = await rig({ role });
    const log: string[] = [];
    const u = await r.pair("usman", "Usman's PC", pcExecutors(log));
    r.hub.svc.dispatcher.deviceOffline(u.deviceId);
    const done = await r.run(usmanAtPc, { utterance: "open notepad", spokenTarget: "here" });
    expect(done.ok).toBe(false);
    expect(done.said).toMatch(/Usman's PC is offline, so nothing ran/);
    expect(done.said).toContain("never send your commands to another machine");
    expect(log).toEqual([]);
    expect(r.entryCalls()).toBe(0);
  });
});

describe("a typed plan from the route body", () => {
  test("parseSteps keeps companion executors only, at most six, plain-object args", () => {
    expect(parseSteps([{ executor: "app.focus", args: { name: "chrome" } }, { executor: "browser.navigate", args: { url: "https://example.com" } }])).toEqual([
      { executor: "app.focus", args: { name: "chrome" } },
      { executor: "browser.navigate", args: { url: "https://example.com" } },
    ]);
    expect(parseSteps([{ executor: "screen.act", args: {} }])).toBeUndefined();
    expect(parseSteps(new Array(7).fill({ executor: "echo" }))).toBeUndefined();
    expect(parseSteps([])).toBeUndefined();
    expect(parseSteps("echo")).toBeUndefined();
    expect(parseSteps([{ executor: "echo", args: "x" }])).toEqual([{ executor: "echo", args: {} }]);
    expect(parseCommandBody({ utterance: "go", steps: [{ executor: "echo" }] }).steps).toEqual([{ executor: "echo", args: {} }]);
    expect(COMPANION_EXECUTORS).toContain("browser.navigate");
  });
});

describe("owners: a command is refused BEFORE dispatch when it names, or smuggles, someone else's device", () => {
  test("Usman names Mehroz's PC and the reverse: refused, no command row, the other device received nothing; body fields are ignored; 'here' is each person's own; revoke and re-pair keep the rule", async () => {
    const r = await rig({ role: "cloud" });
    const uLog: string[] = [];
    const mLog: string[] = [];
    const u = await r.pair("usman", "Usman's PC", pcExecutors(uLog), { aliases: ["pc"] });
    const m = await r.pair("mehroz", "Mehroz's PC", pcExecutors(mLog), { aliases: ["pc"] });
    const rows = () => r.hub.svc.dispatcher.recent(100).length;
    const step = { executor: "echo" as const, args: { tag: "x" } };

    const before = rows();
    const a = await r.run(usmanAtPc, { utterance: "open Chrome on Mehroz's PC" });
    const b = await r.run(usmanAtPc, { utterance: "look", steps: [step], spokenTarget: "on Mehroz's computer" });
    const c = await r.run(mehroz, { utterance: "open Chrome on Usman's PC" });
    const d = await r.run(mehroz, { utterance: "look", steps: [step], spokenTarget: "on Usman's computer" });
    for (const done of [a, b, c, d]) expect(done).toMatchObject({ ok: false, refused: true });
    expect(a.said).toContain("belongs to mehroz");
    expect(c.said).toContain("belongs to usman");
    expect(rows()).toBe(before); // nothing was queued for anyone
    expect(uLog).toEqual([]);
    expect(mLog).toEqual([]);

    // A body pointing at the other person's device, person or display name changes nothing: identity is the verified principal.
    const smuggle = await r.run(usmanAtPc, { utterance: "look", steps: [step], ...({ deviceId: m.deviceId, targetDeviceId: m.deviceId, personId: "mehroz", displayName: "Mehroz" } as object) });
    expect(smuggle).toMatchObject({ ok: true, targetDeviceId: u.deviceId });
    const smuggle2 = await r.run(mehroz, { utterance: "look", steps: [step], ...({ deviceId: u.deviceId, personId: "usman", displayName: "Usman" } as object) });
    expect(smuggle2).toMatchObject({ ok: true, targetDeviceId: m.deviceId });
    expect(uLog).toEqual(["echo:x"]);
    expect(mLog).toEqual(["echo:x"]);

    // "here" is that person's own device.
    expect((await r.run(usmanAtPc, { utterance: "look", steps: [step], spokenTarget: "here" })).targetDeviceId).toBe(u.deviceId);
    expect((await r.run(mehroz, { utterance: "look", steps: [step], spokenTarget: "this pc" })).targetDeviceId).toBe(m.deviceId);

    // Revoke Mehroz's PC: Usman still can't reach it, Mehroz's "here" fails honestly, Usman is unaffected; a re-paired device keeps the rule.
    r.hub.svc.store.revokeCompanion(m.deviceId);
    r.hub.svc.dispatcher.deviceOffline(m.deviceId);
    const mark = rows();
    expect(await r.run(usmanAtPc, { utterance: "open Chrome on Mehroz's PC" })).toMatchObject({ ok: false, refused: true });
    const gone = await r.run(mehroz, { utterance: "look", steps: [step], spokenTarget: "here" });
    expect(gone.ok).toBe(false);
    expect(gone.targetDeviceId).not.toBe(u.deviceId);
    expect(rows()).toBe(mark);
    expect((await r.run(usmanAtPc, { utterance: "look", steps: [step], spokenTarget: "here" })).ok).toBe(true);
    const m2 = await r.pair("mehroz", "Mehroz's PC (new)", pcExecutors(mLog), { aliases: ["pc"] });
    expect(await r.run(usmanAtPc, { utterance: "open Chrome on Mehroz's PC" })).toMatchObject({ ok: false, refused: true });
    expect((await r.run(mehroz, { utterance: "look", steps: [step], spokenTarget: "here" })).targetDeviceId).toBe(m2.deviceId);
  });
});
