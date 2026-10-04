import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLedger } from "../../companion/ledger";
import type { Executor } from "../../companion/executors";
import { CompanionWorker } from "../../companion/worker";
import { cleanProgress, Dispatcher } from "./dispatch";
import { defaultHub, staticRegistry } from "./registry";
import { startHub, type Hub, type Who } from "./test-harness";
import type { TargetDevice } from "./types";

// SYNTHETIC: the hub side of the wire contract. Part 1 drives the Dispatcher directly; part 2 runs a real
// /__devices service on loopback with real CompanionWorkers over fake executors (no PC, no desktop).

const mehrozPc: TargetDevice = { id: "mehroz-pc", owner: "mehroz", kind: "companion", label: "Mehroz's PC", aliases: ["pc"], primary: true };
const mehrozLaptop: TargetDevice = { id: "mehroz-laptop", owner: "mehroz", kind: "companion", label: "Mehroz's laptop", aliases: ["laptop"] };

function dispatcher(devices: TargetDevice[], observeWaitMs = 40) {
  const registry = staticRegistry([defaultHub(), ...devices]);
  for (const d of devices) registry.heartbeat(d.id);
  return { registry, d: new Dispatcher(registry, Date.now, observeWaitMs) };
}

describe("the wire command", () => {
  test("carries jobId, stepId, deviceId, a commandKey and expiresAt", async () => {
    const { d } = dispatcher([mehrozPc]);
    const before = Date.now();
    const pending = d.submit({ personId: "mehroz", executor: "echo", jobId: "job-1", stepId: "s2" }, { timeoutMs: 5_000 });
    const item = await d.next(mehrozPc.id, 0);
    expect(item?.type).toBe("command");
    const c = (item as any).command;
    expect(c).toMatchObject({ executor: "echo", personId: "mehroz", deviceId: "mehroz-pc", jobId: "job-1", stepId: "s2", commandKey: "job-1/s2" });
    expect(c.expiresAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(c.expiresAt).toBeLessThanOrEqual(Date.now() + 5_000);
    d.complete(mehrozPc.id, c.id, { ok: true });
    await pending;
    d.close();
  });
  test("without a job the key is unique to that command, so two identical commands are two actions", async () => {
    const { d } = dispatcher([mehrozPc]);
    const a = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000 });
    const ia = (await d.next(mehrozPc.id, 0)) as any;
    d.complete(mehrozPc.id, ia.command.id, { ok: true });
    await a;
    const b = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000 });
    const ib = (await d.next(mehrozPc.id, 0)) as any;
    expect(ia.command.commandKey).not.toBe(ib.command.commandKey);
    d.complete(mehrozPc.id, ib.command.id, { ok: true });
    await b;
    d.close();
  });
  test("a command past its expiry is never handed out: it fails 'nothing ran'", async () => {
    const { d } = dispatcher([mehrozPc]);
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    expect(await d.next(mehrozPc.id, 0)).toBeNull();
    expect(await pending).toMatchObject({ ok: false, notRun: true });
    d.close();
  });
});

describe("progress from a companion", () => {
  test("reaches the submitter's sink only from the right device, only while delivered, bounded and cleaned", async () => {
    const { d } = dispatcher([mehrozPc, mehrozLaptop]);
    const got: string[] = [];
    let id = "";
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000, onQueued: (c) => (id = c), onProgress: (s) => got.push(s.intent) });
    expect(d.progress(mehrozPc.id, id, { intent: "early", executor: "uia", outcome: "ok", ms: 1 })).toBe(false); // not delivered yet
    await d.next(mehrozPc.id, 0);
    expect(d.progress(mehrozLaptop.id, id, { intent: "forged", executor: "uia", outcome: "ok", ms: 1 })).toBe(false);
    expect(d.progress(mehrozPc.id, id, { intent: "act: one", executor: "uia", outcome: "ok", ms: 1 })).toBe(true);
    expect(d.progress(mehrozPc.id, id, { nonsense: true })).toBe(false);
    expect(d.progress(mehrozPc.id, id, { intent: "x", executor: "uia", outcome: "bogus", ms: 1 })).toBe(false);
    d.complete(mehrozPc.id, id, { ok: true });
    await pending;
    expect(d.progress(mehrozPc.id, id, { intent: "late", executor: "uia", outcome: "ok", ms: 1 })).toBe(false); // settled
    expect(got).toEqual(["act: one"]);
    expect(cleanProgress({ intent: "x".repeat(900), executor: "e", outcome: "ok", ms: 99999999999 })).toMatchObject({ ms: 3_600_000 });
    d.close();
  });
});

describe("a job's steps never move to another device", () => {
  test("pinned to the laptop, a target that now resolves to the PC is refused and nothing is queued for the PC", async () => {
    const { d } = dispatcher([mehrozPc, mehrozLaptop]);
    // The job started on the laptop. Now the person's words resolve to the PC (primary).
    const r = await d.submit({ personId: "mehroz", executor: "echo", pinDeviceId: "mehroz-laptop" }, { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: false, notRun: true, deviceId: "mehroz-laptop" });
    expect(r.ok === false && r.reason).toContain("did not move it");
    expect(await d.next(mehrozPc.id, 0)).toBeNull();
    expect(await d.next(mehrozLaptop.id, 0)).toBeNull();
    d.close();
  });
  test("pinned device offline: fails 'not run' and never falls back to the hub or the other device", async () => {
    const { d, registry } = dispatcher([mehrozPc, mehrozLaptop]);
    registry.markOffline(mehrozLaptop.id);
    const r = await d.submit({ personId: "mehroz", executor: "echo", spokenTarget: "my laptop", pinDeviceId: "mehroz-laptop" }, { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: false, reason: "device offline", notRun: true, deviceId: "mehroz-laptop" });
    expect(await d.next(mehrozPc.id, 0)).toBeNull();
    d.close();
  });
});

describe("delivered and then lost is uncertain, never done and never 'it didn't run'", () => {
  test("its device goes offline after delivery → uncertain (the dispatcher result says so)", async () => {
    const { d, registry } = dispatcher([mehrozPc]);
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000 });
    await d.next(mehrozPc.id, 0);
    registry.markOffline(mehrozPc.id);
    d.sweepOffline();
    expect(await pending).toMatchObject({ ok: false, reason: "device offline", uncertain: true });
    d.close();
  });
  test("its device goes offline before delivery → notRun", async () => {
    const { d, registry } = dispatcher([mehrozPc]);
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000 });
    registry.markOffline(mehrozPc.id);
    d.sweepOffline();
    expect(await pending).toMatchObject({ ok: false, reason: "device offline", notRun: true });
    d.close();
  });
  test("a late result after 'uncertain' is kept as what the device says, but the outcome is never rewritten as a success", async () => {
    const { d, registry } = dispatcher([mehrozPc]);
    let id = "";
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 5_000, onQueued: (c) => (id = c) });
    await d.next(mehrozPc.id, 0);
    registry.markOffline(mehrozPc.id);
    d.sweepOffline();
    expect(await pending).toMatchObject({ uncertain: true });
    expect(d.complete(mehrozPc.id, id, { ok: true, output: { ok: true, said: "Done.", verified: true } })).toBe(false);
    expect(d.get(id)).toMatchObject({ status: "uncertain", observed: { state: "done", ok: true } });
    d.close();
  });
});

describe("ack lost: the hub asks the companion to observe before deciding, and never repeats the action", () => {
  async function lostAck(answer: (item: any, d: Dispatcher) => void) {
    const { d } = dispatcher([mehrozPc], 500);
    const pending = d.submit({ personId: "mehroz", executor: "echo", jobId: "j", stepId: "s1" }, { timeoutMs: 120 });
    const item = (await d.next(mehrozPc.id, 0)) as any; // delivered; the ack never comes
    const asked = (await d.next(mehrozPc.id, 2_000)) as any; // the wait ran out → the hub asks what happened
    expect(asked).toMatchObject({ type: "observe", commandId: item.command.id, commandKey: "j/s1" });
    answer(item, d);
    const r = await pending;
    // Nothing new was queued for the device: the action is never sent again.
    expect(await d.next(mehrozPc.id, 0)).toBeNull();
    d.close();
    return r;
  }
  test("the companion says it finished and verified: the hub adopts that result", async () => {
    const r = await lostAck((item, d) => d.reportObservation(mehrozPc.id, item.command.id, { state: "done", ok: true, output: { ok: true, said: "Opened.", verified: true } }));
    expect(r).toMatchObject({ ok: true, result: { said: "Opened.", verified: true } });
  });
  test("the companion says it failed: a failure, with its own words", async () => {
    const r = await lostAck((item, d) => d.reportObservation(mehrozPc.id, item.command.id, { state: "done", ok: false, output: { ok: false, said: "No window appeared." }, error: "No window appeared." }));
    expect(r).toMatchObject({ ok: false, reason: "No window appeared." });
  });
  test("the companion has no record of it: it never arrived, so 'nothing ran'", async () => {
    const r = await lostAck((item, d) => d.reportObservation(mehrozPc.id, item.command.id, { state: "unknown" }));
    expect(r).toMatchObject({ ok: false, notRun: true });
  });
  test("the companion says it is still running: it is asked to stop and the outcome is uncertain", async () => {
    const { d } = dispatcher([mehrozPc], 500);
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 100 });
    const item = (await d.next(mehrozPc.id, 0)) as any;
    await d.next(mehrozPc.id, 2_000); // observe
    d.reportObservation(mehrozPc.id, item.command.id, { state: "running" });
    expect(await pending).toMatchObject({ ok: false, uncertain: true });
    expect(await d.next(mehrozPc.id, 0)).toMatchObject({ type: "cancel", commandId: item.command.id });
    d.close();
  });
  test("the companion says it was interrupted (killed and restarted mid-step): uncertain", async () => {
    const r = await lostAck((item, d) => d.reportObservation(mehrozPc.id, item.command.id, { state: "interrupted" }));
    expect(r).toMatchObject({ ok: false, uncertain: true, observed: { state: "interrupted" } });
  });
  test("no answer at all: uncertain (silence is not 'it didn't run')", async () => {
    const { d } = dispatcher([mehrozPc], 60);
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 80 });
    await d.next(mehrozPc.id, 0);
    expect(await pending).toMatchObject({ ok: false, uncertain: true });
    d.close();
  });
  test("only the device the command went to may answer", async () => {
    const { d } = dispatcher([mehrozPc, mehrozLaptop], 300);
    const pending = d.submit({ personId: "mehroz", executor: "echo" }, { timeoutMs: 60 });
    const item = (await d.next(mehrozPc.id, 0)) as any;
    expect(d.reportObservation(mehrozLaptop.id, item.command.id, { state: "done", ok: true })).toBe(false);
    expect(await pending).toMatchObject({ ok: false, uncertain: true });
    d.close();
  });
});

// ---- Part 2: a real /__devices service and real companion workers ----------------------------------

let hub: Hub;
let dir: string;
const workers: CompanionWorker[] = [];
beforeEach(async () => {
  hub = await startHub({ maxWaitMs: 300, observeWaitMs: 1_500 });
  dir = mkdtempSync(join(tmpdir(), "wire-contract-"));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});
const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};

async function pairMehroz(executors: Record<string, Executor>, opts: { flaky?: { down: boolean; dropResults?: number }; ledger?: CommandLedger; interactive?: () => Promise<boolean | null>; token?: { deviceId: string; token: string } } = {}) {
  const headers = hub.headersFor("mehroz" as Who);
  let deviceId: string;
  let token: string;
  if (opts.token) ({ deviceId, token } = opts.token);
  else {
    const issuer = hub.browser("mehroz");
    await issuer.post("/pair/tailnet", { label: "Mehroz's browser" });
    const code = (await issuer.post("/pair/code", { purpose: "companion" })).json.code as string;
    const res = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code, label: "Mehroz's PC", aliases: ["pc"] }) });
    const paired = (await res.json()) as any;
    expect(res.status).toBe(200);
    deviceId = paired.deviceId;
    token = paired.token;
  }
  const flaky = opts.flaky;
  const worker = new CompanionWorker({
    hubUrl: hub.base,
    token,
    deviceId,
    owner: "mehroz",
    extraHeaders: headers,
    heartbeatMs: 40,
    pollWaitMs: 300,
    executors,
    ledger: opts.ledger,
    interactive: opts.interactive ?? (async () => true),
    fetchImpl: (async (input: any, init?: any) => {
      if (flaky?.down) throw new Error("network down");
      if (flaky?.dropResults && String(input).endsWith("/companion/result")) {
        flaky.dropResults--;
        // The hub gets it (the action ran and was reported) but the ack never makes it back: worst case.
        await fetch(input, init);
        throw new Error("ack lost");
      }
      return fetch(input, init);
    }) as typeof fetch,
    log: () => undefined,
  }).start();
  workers.push(worker);
  expect(await worker.waitOnline()).toBe(true);
  return { worker, deviceId, token };
}

const okResult = { ok: true, said: "Opened Chrome.", verified: true, evidence: "window appeared" };

describe("end to end over the real service", () => {
  test("the device record shows version, capabilities, interactive and the UI wording hook (This PC / label / Offline)", async () => {
    const m = await pairMehroz({ echo: async () => okResult, "app.open": async () => okResult }, { interactive: async () => false });
    await until(() => (hub.svc.registry.presenceOf(m.deviceId)?.capabilities?.length ?? 0) > 0);
    const asMehroz = (await hub.browser("mehroz", { confirmed: true }).get("/devices")).json.devices.find((d: any) => d.id === m.deviceId);
    expect(asMehroz).toMatchObject({ online: true, workerVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/), capabilities: ["app.open", "echo"], interactive: false, mine: true, displayLabel: "This PC", label: "Mehroz's PC" });
    // Usman looking at Mehroz's device: it is not his PC, so its own label.
    const asUsman = (await hub.browser("local").get("/devices")).json.devices.find((d: any) => d.id === m.deviceId);
    expect(asUsman).toMatchObject({ mine: false, displayLabel: "Mehroz's PC", interactive: false });
    // The hub's own record carries no worker facts.
    const hubRow = (await hub.browser("local").get("/devices")).json.devices.find((d: any) => d.kind === "hub");
    expect(hubRow).toMatchObject({ workerVersion: null, capabilities: null, interactive: null, displayLabel: "This PC" });
    // Offline: the hook says so, for its owner and for others.
    hub.svc.dispatcher.deviceOffline(m.deviceId);
    const off = (await hub.browser("mehroz", { confirmed: true }).get("/devices")).json.devices.find((d: any) => d.id === m.deviceId);
    expect(off).toMatchObject({ online: false, displayLabel: "Offline" });
  });

  test("the result never reaches the hub (connection dropped after the action): the hub asks, the companion answers from its ledger", async () => {
    let runs = 0;
    // The companion's result POSTs fail outright until 'heal'; everything else works.
    let heal = false;
    const headers = hub.headersFor("mehroz" as Who);
    const issuer = hub.browser("mehroz");
    await issuer.post("/pair/tailnet", { label: "b" });
    const code = (await issuer.post("/pair/code", { purpose: "companion" })).json.code as string;
    const paired = (await (await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code, label: "Mehroz's PC", aliases: ["pc"] }) })).json()) as any;
    const worker = new CompanionWorker({
      hubUrl: hub.base, token: paired.token, deviceId: paired.deviceId, owner: "mehroz", extraHeaders: headers, heartbeatMs: 40, pollWaitMs: 300,
      executors: { "app.open": async () => (runs++, okResult) },
      interactive: async () => true,
      fetchImpl: (async (input: any, init?: any) => {
        if (!heal && String(input).endsWith("/companion/result")) throw new Error("connection dropped");
        return fetch(input, init);
      }) as typeof fetch,
      log: () => undefined,
    }).start();
    workers.push(worker);
    await worker.waitOnline();
    const r = await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "app.open", args: { name: "chrome" }, jobId: "job-B", stepId: "s1", pinDeviceId: paired.deviceId }, { timeoutMs: 500 });
    // The hub waited, asked "what happened to job-B/s1?", and the companion answered from its ledger: done and verified.
    expect(r).toMatchObject({ ok: true, result: { said: "Opened Chrome.", verified: true } });
    expect(runs).toBe(1);
    heal = true;
    await new Promise((res) => setTimeout(res, 200));
    expect(runs).toBe(1); // nothing was re-sent or re-run by healing
  });

  test("the companion is killed mid-step: uncertain at once; when it comes back the hub learns 'interrupted' and never replays or moves it", async () => {
    const ledgerPath = join(dir, "ledger.json");
    let runsA = 0;
    const hold = new Promise<void>(() => undefined);
    const flaky = { down: false };
    const m = await pairMehroz({ "app.open": async () => (runsA++, await hold, okResult) }, { flaky, ledger: new CommandLedger(ledgerPath) });
    let id = "";
    const pending = hub.svc.dispatcher.submit({ personId: "mehroz", executor: "app.open", args: { name: "chrome" }, jobId: "job-C", stepId: "s1", pinDeviceId: m.deviceId }, { timeoutMs: 20_000, onQueued: (c) => (id = c) });
    expect(await until(() => runsA === 1)).toBe(true);
    // Kill: the process is gone (no goodbye, no result). Its ledger says 'running' on disk.
    flaky.down = true;
    await m.worker.stop();
    hub.clock.advance(31_000);
    hub.svc.dispatcher.sweepOffline();
    expect(await pending).toMatchObject({ ok: false, reason: "device offline", uncertain: true, commandId: id });
    // New process, same ledger file, same pairing.
    let runsB = 0;
    await pairMehroz({ "app.open": async () => (runsB++, okResult) }, { ledger: new CommandLedger(ledgerPath), token: { deviceId: m.deviceId, token: m.token } });
    expect(await until(() => hub.svc.dispatcher.get(id)?.observed?.state === "interrupted")).toBe(true);
    // Still uncertain; nothing ran again, anywhere.
    expect(hub.svc.dispatcher.get(id)?.status).toBe("uncertain");
    await new Promise((r) => setTimeout(r, 200));
    expect(runsB).toBe(0);
  });
});

describe("a companion restarted faster than the offline sweep: idle with a delivered command is asked about, not waited on", () => {
  function clocked(observeWaitMs = 40) {
    let t = 1_800_000_000_000;
    const registry = staticRegistry([defaultHub(), mehrozPc], () => t);
    registry.heartbeat(mehrozPc.id);
    const d = new Dispatcher(registry, () => t, observeWaitMs);
    return { d, advance: (ms: number) => void (t += ms), registry };
  }
  test("not before the grace: a command delivered a moment ago is simply starting", async () => {
    const { d, advance } = clocked();
    const pending = d.submit({ personId: "mehroz", executor: "wait", jobId: "j", stepId: "s1" }, { timeoutMs: 60_000 });
    await d.next(mehrozPc.id, 0);
    advance(5_000);
    d.reviewIdle(mehrozPc.id);
    expect(await d.next(mehrozPc.id, 0)).toBeNull(); // no observe was queued
    d.close();
    expect(await pending).toMatchObject({ ok: false });
  });
  test("past the grace, idle, and the new process says it was interrupted: uncertain at once, never re-sent", async () => {
    const { d, advance } = clocked();
    const pending = d.submit({ personId: "mehroz", executor: "wait", jobId: "j", stepId: "s1" }, { timeoutMs: 60_000 });
    const first = (await d.next(mehrozPc.id, 0)) as any;
    advance(16_000);
    d.reviewIdle(mehrozPc.id);
    const asked = (await d.next(mehrozPc.id, 1_000)) as any;
    expect(asked).toMatchObject({ type: "observe", commandId: first.command.id, commandKey: "j/s1" });
    d.reportObservation(mehrozPc.id, first.command.id, { state: "interrupted" });
    const r = await pending;
    expect(r).toMatchObject({ ok: false, uncertain: true });
    expect((r as { reason: string }).reason).toContain("restarted");
    expect(await d.next(mehrozPc.id, 0)).toBeNull(); // the action is never sent again
    d.close();
  });
  test("it has no record of it: nothing ran (and the wording says so)", async () => {
    const { d, advance } = clocked();
    const pending = d.submit({ personId: "mehroz", executor: "wait", jobId: "j", stepId: "s1" }, { timeoutMs: 60_000 });
    const first = (await d.next(mehrozPc.id, 0)) as any;
    advance(16_000);
    d.reviewIdle(mehrozPc.id);
    await d.next(mehrozPc.id, 1_000);
    d.reportObservation(mehrozPc.id, first.command.id, { state: "unknown" });
    expect(await pending).toMatchObject({ ok: false, notRun: true });
    d.close();
  });
  test("it finished and kept the result (a lost POST): the result is adopted", async () => {
    const { d, advance } = clocked();
    const pending = d.submit({ personId: "mehroz", executor: "echo", jobId: "j", stepId: "s1" }, { timeoutMs: 60_000 });
    const first = (await d.next(mehrozPc.id, 0)) as any;
    advance(16_000);
    d.reviewIdle(mehrozPc.id);
    await d.next(mehrozPc.id, 1_000);
    d.reportObservation(mehrozPc.id, first.command.id, { state: "done", ok: true, output: { ok: true, said: "Echoed.", verified: true } });
    expect(await pending).toMatchObject({ ok: true });
    d.close();
  });
  test("still running after all (the heartbeat raced the start): left alone, not settled, not cancelled", async () => {
    const { d, advance } = clocked();
    const pending = d.submit({ personId: "mehroz", executor: "wait", jobId: "j", stepId: "s1" }, { timeoutMs: 60_000 });
    const first = (await d.next(mehrozPc.id, 0)) as any;
    advance(16_000);
    d.reviewIdle(mehrozPc.id);
    await d.next(mehrozPc.id, 1_000);
    d.reportObservation(mehrozPc.id, first.command.id, { state: "running" });
    await new Promise((r) => setTimeout(r, 30));
    expect(d.get(first.command.id)?.status).toBe("delivered");
    expect(await d.next(mehrozPc.id, 0)).toBeNull(); // no cancel was queued
    d.complete(mehrozPc.id, first.command.id, { ok: true });
    expect(await pending).toMatchObject({ ok: true });
    d.close();
  });
});
