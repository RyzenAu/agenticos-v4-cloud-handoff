import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExecutors } from "../../companion/executors";
import { MicLock } from "../../companion/mic-lock";
import { CompanionWorker } from "../../companion/worker";
import { isExecutorResult } from "../jarvis-command/contracts";
import { abortableSleep, type WindowsDeps, type WinInfo } from "../executors/windows";
import { startHub, type Hub, type Who } from "./test-harness";

// SYNTHETIC: an in-process hub (createDevicesService on loopback) and two companion workers, Mehroz's PC
// and Usman's laptop, each running the SHARED Windows executors (scripts/executors/windows.ts) over a fake
// desktop. Synthetic people, fake Tailscale headers; no real device, screen, PowerPoint or network.

/** A fake Windows desktop for one PC. */
class FakePc {
  windows: WinInfo[] = [];
  text = new Map<number, string>();
  typed: string[] = [];
  started: string[] = [];
  ps: Array<{ aborted: boolean }> = [];
  next = 1;
  /** Typing waits for this (so two PCs can be caught mid-command at once). */
  typingGate: Promise<void> = Promise.resolve();
  typingStarted = 0;
  /** notepad.exe produces no window (the executor keeps looking until stopped). */
  notepadHangs = false;
  constructor(readonly name: string) {}
  deps(): Partial<WindowsDeps> {
    return {
      platform: "win32",
      windows: async () => this.windows.map((w) => ({ ...w })),
      foreground: async () => this.windows.at(-1) ?? null,
      startApp: async (exe) => {
        this.started.push(exe);
        if (exe !== "notepad.exe" || this.notepadHangs) return;
        const handle = this.next++;
        this.windows.push({ handle, process: "Notepad", cls: "Notepad", title: "Untitled - Notepad" });
        this.text.set(handle, "");
      },
      shellOpen: async () => undefined,
      focus: async () => true,
      keys: async () => undefined,
      typeText: async (handle, text) => {
        this.typingStarted++;
        await this.typingGate;
        this.typed.push(text);
        this.text.set(handle, (this.text.get(handle) ?? "") + text);
      },
      editorText: async (handle) => this.text.get(handle) ?? null,
      // PowerPoint that takes until it's stopped (for cancel).
      runPs: (_script, { signal }) =>
        new Promise((resolve) => {
          const rec = { aborted: false };
          this.ps.push(rec);
          signal.addEventListener("abort", () => {
            rec.aborted = true;
            resolve({ code: -1, stdout: "", stderr: "Cancelled." });
          });
        }),
      pageTitle: undefined,
      realpath: (p) => p,
      sleep: (ms, signal) => abortableSleep(Math.min(ms, 5), signal),
      timing: { appWaitMs: 20_000, pollMs: 10, settleMs: 1, urlWaitMs: 50, fileWaitMs: 50 },
    };
  }
}

let hub: Hub;
let dir: string;
const workers: CompanionWorker[] = [];
beforeEach(async () => {
  hub = await startHub({ maxWaitMs: 300 });
  dir = mkdtempSync(join(tmpdir(), "companion-exec-"));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};

/** Pair a companion the real way (a code from the owner's device, redeemed over the simulated tailnet). */
async function pair(owner: "usman" | "mehroz", label: string, aliases: string[], pc: FakePc, opts: { mic?: boolean; flaky?: { down: boolean } } = {}) {
  const issuer = owner === "usman" ? hub.browser("local") : hub.browser("mehroz");
  if (owner === "mehroz") await issuer.post("/pair/tailnet", { label: "Mehroz's browser" });
  const code = (await issuer.post("/pair/code", { purpose: "companion" })).json.code as string;
  const headers = hub.headersFor(owner as Who);
  const res = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code, label, aliases }) });
  const paired = (await res.json()) as any;
  expect(res.status).toBe(200);
  const flaky = opts.flaky;
  const worker = new CompanionWorker({
    hubUrl: hub.base,
    token: paired.token,
    deviceId: paired.deviceId,
    owner,
    extraHeaders: headers,
    heartbeatMs: 40,
    pollWaitMs: 300,
    micLock: opts.mic ? new MicLock(join(dir, `${owner}-${paired.deviceId}-mic.lock`)) : null,
    // The companion's REAL default executor table, over this PC's fake desktop.
    executors: defaultExecutors({ platform: "win32", roots: [], windows: pc.deps() }),
    fetchImpl: (async (input: any, init?: any) => {
      if (flaky?.down) throw new Error("network down");
      return fetch(input, init);
    }) as typeof fetch,
    log: () => undefined,
  }).start();
  workers.push(worker);
  expect(await worker.waitOnline()).toBe(true);
  return { worker, deviceId: paired.deviceId as string };
}

describe("two people at once", () => {
  test("Mehroz's and Usman's commands run in flight together, each on their own PC, no cross-talk", async () => {
    const mPc = new FakePc("mehroz");
    const uPc = new FakePc("usman-laptop");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mPc.typingGate = gate;
    uPc.typingGate = gate;
    const m = await pair("mehroz", "Mehroz's PC", ["pc", "desktop"], mPc);
    const u = await pair("usman", "Usman's laptop", ["laptop"], uPc);
    const d = hub.svc.dispatcher;
    const mehroz = d.submit({ personId: "mehroz", executor: "notepad.type", args: { text: "hello from Mehroz" } }, { timeoutMs: 20_000 });
    const usman = d.submit({ personId: "usman", spokenTarget: "on my laptop", executor: "notepad.type", args: { text: "hello from Usman" } }, { timeoutMs: 20_000 });
    // Both are mid-command at the same moment.
    expect(await until(() => mPc.typingStarted === 1 && uPc.typingStarted === 1)).toBe(true);
    expect(m.worker.status().busy && u.worker.status().busy).toBe(true);
    // Meanwhile Usman's plain command still resolves to the hub (run there, by the hub's own entry).
    expect(await d.submit({ personId: "usman", executor: "notepad.type", args: { text: "on the hub" } })).toEqual({ ok: true, local: true, deviceId: "usman-pc" });
    release();
    const [mr, ur] = await Promise.all([mehroz, usman]);
    expect(mr).toMatchObject({ ok: true, local: false, deviceId: m.deviceId });
    expect(ur).toMatchObject({ ok: true, local: false, deviceId: u.deviceId });
    for (const r of [mr, ur]) {
      const x = (r as any).result;
      expect(isExecutorResult(x)).toBe(true);
      expect(x).toMatchObject({ ok: true, verified: true });
    }
    expect(mPc.typed).toEqual(["hello from Mehroz"]);
    expect(uPc.typed).toEqual(["hello from Usman"]);
    expect(m.worker.history.map((h) => h.executor)).toEqual(["notepad.type"]);
    expect(u.worker.history.map((h) => h.executor)).toEqual(["notepad.type"]);
  });
  test("a refusal on one PC doesn't touch the other", async () => {
    const mPc = new FakePc("mehroz");
    const uPc = new FakePc("usman-laptop");
    const m = await pair("mehroz", "Mehroz's PC", ["pc"], mPc);
    await pair("usman", "Usman's laptop", ["laptop"], uPc);
    const r = await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "notepad.type", args: { text: "my stripe api key" } });
    expect(r).toMatchObject({ ok: false, deviceId: m.deviceId });
    expect(mPc.started).toEqual([]);
    expect(uPc.started).toEqual([]);
    // And Mehroz can't point anything at Usman's machines.
    expect(await hub.svc.dispatcher.submit({ personId: "mehroz", spokenTarget: "on Usman's PC", executor: "notepad.type", args: { text: "hi" } })).toMatchObject({ ok: false });
    expect(await hub.svc.dispatcher.submit({ personId: "mehroz", spokenTarget: "on usman's laptop", executor: "notepad.type", args: { text: "hi" } })).toMatchObject({ ok: false });
    expect(uPc.started).toEqual([]);
  });
});

describe("cancel through submit(..., { signal })", () => {
  test("the job's stop cancels the command on the companion and PowerPoint's run is killed", async () => {
    const pc = new FakePc("mehroz");
    const m = await pair("mehroz", "Mehroz's PC", ["pc"], pc);
    const stop = new AbortController();
    let queued = "";
    const pending = hub.svc.dispatcher.submit({ personId: "mehroz", executor: "deck.blank", args: { title: "Mehroz test" } }, { timeoutMs: 20_000, signal: stop.signal, onQueued: (id) => (queued = id) });
    expect(await until(() => pc.ps.length === 1)).toBe(true);
    const started = Date.now();
    stop.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "Cancelled." });
    expect(await until(() => pc.ps[0].aborted)).toBe(true);
    expect(await until(() => m.worker.history.some((h) => h.id === queued && h.outcome === "cancelled"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hub.svc.dispatcher.get(queued)?.status).toBe("cancelled");
  });
  test("an already-stopped job sends nothing", async () => {
    const pc = new FakePc("mehroz");
    const m = await pair("mehroz", "Mehroz's PC", ["pc"], pc);
    const stop = new AbortController();
    stop.abort();
    expect(await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "notepad.type", args: { text: "hi" } }, { signal: stop.signal })).toMatchObject({ ok: false, reason: "Cancelled." });
    await new Promise((r) => setTimeout(r, 100));
    expect(m.worker.history).toEqual([]);
    expect(pc.started).toEqual([]);
  });
});

describe("a companion going offline mid-command", () => {
  test("the command fails 'device offline', is never re-routed to the hub, and never runs later", async () => {
    const pc = new FakePc("mehroz");
    pc.notepadHangs = true; // the executor keeps looking for Notepad's window until stopped
    const flaky = { down: false };
    const m = await pair("mehroz", "Mehroz's PC", ["pc"], pc, { flaky });
    let queued = "";
    const pending = hub.svc.dispatcher.submit({ personId: "mehroz", executor: "notepad.type", args: { text: "hello from Mehroz" } }, { timeoutMs: 30_000, onQueued: (id) => (queued = id) });
    expect(await until(() => m.worker.status().busy)).toBe(true);
    flaky.down = true; // Tailscale drops on his PC
    // The companion fails closed: it stops the running executor on its own side.
    expect(await until(() => m.worker.state === "offline")).toBe(true);
    expect(await until(() => m.worker.history.some((h) => h.id === queued && h.outcome === "cancelled"))).toBe(true);
    // The hub notices the missing heartbeats (presence TTL) and fails it, naming his device.
    hub.clock.advance(31_000);
    hub.svc.dispatcher.sweepOffline();
    const r = await pending;
    expect(r).toEqual({ ok: false, reason: "device offline", deviceId: m.deviceId, commandId: queued });
    expect(JSON.stringify(r)).not.toContain("usman-pc");
    // A new command for Mehroz now is refused, not sent to the hub.
    expect(await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "notepad.type", args: { text: "again" } })).toMatchObject({ ok: false, reason: "device offline", deviceId: m.deviceId });
    // Back online: nothing from before runs by surprise.
    flaky.down = false;
    expect(await until(() => m.worker.state === "online", 5_000)).toBe(true);
    await new Promise((r2) => setTimeout(r2, 400));
    expect(pc.typed).toEqual([]);
    expect(m.worker.history.filter((h) => h.id === queued)).toHaveLength(1);
    expect(hub.svc.dispatcher.get(queued)?.status).toBe("failed");
  });
});

describe("microphone ownership reaches the hub", () => {
  test("registry.micOwner follows the companion's claim and release", async () => {
    const mPc = new FakePc("mehroz");
    const m = await pair("mehroz", "Mehroz's PC", ["pc"], mPc, { mic: true });
    await pair("usman", "Usman's laptop", ["laptop"], new FakePc("usman-laptop"));
    const reg = hub.svc.registry;
    expect(await until(() => reg.micOwner("mehroz") === m.deviceId)).toBe(true);
    expect(reg.micOwner("usman")).toBeNull();
    await m.worker.releaseMic();
    expect(reg.micOwner("mehroz")).toBeNull();
    const devices = (await hub.browser("local").get("/devices")).json.devices;
    expect(devices.find((x: any) => x.id === m.deviceId).micOwned).toBe(false);
    await m.worker.claimMic();
    expect(reg.micOwner("mehroz")).toBe(m.deviceId);
    // Offline → no mic owner (a voice command can't originate from a machine that's gone).
    await m.worker.stop();
    expect(reg.micOwner("mehroz")).toBeNull();
  });
});
