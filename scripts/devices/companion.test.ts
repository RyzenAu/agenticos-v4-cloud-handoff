import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHubUrl } from "../../companion/config";
import { defaultExecutors, gate } from "../../companion/executors";
import { MicLock } from "../../companion/mic-lock";
import { CompanionWorker } from "../../companion/worker";
import { resolveTarget } from "./route";
import { startHub, type Hub, type Who } from "./test-harness";

// Two simulated companions (Mehroz's PC, Usman's laptop) against a real loopback hub.
// Synthetic people, fake Tailscale headers; no real device, no network beyond 127.0.0.1.

let hub: Hub;
let dir: string;
const workers: CompanionWorker[] = [];
beforeEach(async () => {
  hub = await startHub({ maxWaitMs: 300 });
  dir = mkdtempSync(join(tmpdir(), "companion-"));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean | Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};

/** Pair a companion the real way: a code from the owner's authorised device, redeemed over the (simulated) tailnet. */
async function pairCompanion(owner: "usman" | "mehroz", label: string, aliases: string[], opts: { mic?: boolean; opened?: string[]; flaky?: { down: boolean } } = {}) {
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
    micLock: opts.mic ? new MicLock(join(dir, `${owner}-mic.lock`)) : null,
    executors: defaultExecutors({ open: (url) => opts.opened?.push(url) }),
    fetchImpl: (async (input: any, init?: any) => {
      if (flaky?.down) throw new Error("network down");
      return fetch(input, init);
    }) as typeof fetch,
    log: () => undefined,
  }).start();
  workers.push(worker);
  expect(await worker.waitOnline()).toBe(true);
  return { worker, deviceId: paired.deviceId as string, token: paired.token as string, headers };
}

describe("heartbeat and who's online", () => {
  test("two companions come online; the hub sees owners, mic ownership and presence", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc", "desktop"], { mic: true });
    const u = await pairCompanion("usman", "Usman's laptop", ["laptop"]);
    const devices = (await hub.browser("local").get("/devices")).json;
    const byId = Object.fromEntries(devices.devices.map((d: any) => [d.id, d]));
    expect(byId["usman-pc"]).toMatchObject({ owner: "usman", kind: "hub", online: true });
    expect(byId[m.deviceId]).toMatchObject({ owner: "mehroz", kind: "companion", online: true, micOwned: true, primary: true });
    expect(byId[u.deviceId]).toMatchObject({ owner: "usman", online: true, micOwned: false, primary: false });
    expect(devices.people.find((p: any) => p.id === "mehroz").online).toBe(true);
  });
  test("a companion's token only works with its owner's Tailscale login", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    for (const who of ["usman", "stranger"] as const) {
      const r = await fetch(`${hub.base}/__devices/companion/heartbeat`, { method: "POST", headers: { ...hub.headersFor(who), authorization: `Bearer ${m.token}`, "content-type": "application/json" }, body: "{}" });
      expect(r.status).toBe(403);
    }
    // And not from a local process at the hub either (only Usman's own companions may be local).
    const local = await fetch(`${hub.base}/__devices/companion/heartbeat`, { method: "POST", headers: { ...hub.headersFor("local"), authorization: `Bearer ${m.token}`, "content-type": "application/json" }, body: "{}" });
    expect(local.status).toBe(403);
    const page = await fetch(`${hub.base}/__devices/companion/heartbeat`, { method: "POST", headers: { ...m.headers, origin: "https://evil.example.com", authorization: `Bearer ${m.token}`, "content-type": "application/json" }, body: "{}" });
    expect(page.status).toBe(403);
  });
  test("a companion code for Mehroz can't be redeemed by Usman's login", async () => {
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    const code = (await mb.post("/pair/code", { purpose: "companion" })).json.code;
    const r = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...hub.headersFor("usman"), "content-type": "application/json" }, body: JSON.stringify({ code }) });
    expect(r.status).toBe(403);
  });
});

describe("routing: each person's commands reach only their own machine", () => {
  test("Mehroz's command runs on his companion; Usman's never reaches it", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc", "desktop"]);
    const u = await pairCompanion("usman", "Usman's laptop", ["laptop"]);
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    const r = await mb.post("/commands", { executor: "echo", args: { text: "hi from mehroz" } });
    expect(r.json).toMatchObject({ ok: true, local: false, deviceId: m.deviceId, result: { echoed: "hi from mehroz" } });

    const ub = hub.browser("local");
    expect((await ub.post("/commands", { executor: "echo", args: { text: "x" } })).json).toMatchObject({ ok: true, local: true, deviceId: "usman-pc" });
    expect((await ub.post("/commands", { executor: "echo", args: { text: "lap" }, spokenTarget: "on my laptop" })).json).toMatchObject({ ok: true, deviceId: u.deviceId, result: { echoed: "lap" } });
    for (const spokenTarget of ["on Mehroz's PC", "on mehroz's desktop", "on the pc of mehroz"]) {
      const refused = await ub.post("/commands", { executor: "echo", args: { text: "nope" }, spokenTarget });
      expect(refused.status).toBe(409);
    }
    expect(m.worker.history.map((h) => h.executor)).toEqual(["echo"]);
    expect(u.worker.history).toHaveLength(1);
  });
  test("Mehroz can't target Usman's PC or laptop", async () => {
    await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    const u = await pairCompanion("usman", "Usman's laptop", ["laptop"]);
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    for (const spokenTarget of ["on Usman's PC", "on usman's laptop", "on my laptop"]) {
      const r = await mb.post("/commands", { executor: "echo", spokenTarget });
      expect(r.status).toBe(409);
      expect(r.json.ok).toBe(false);
    }
    expect(u.worker.history).toHaveLength(0);
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "on Usman's PC" }, hub.svc.registry).ok).toBe(false);
  });
  test("open-url runs on the companion's own PC only", async () => {
    const opened: string[] = [];
    await pairCompanion("mehroz", "Mehroz's PC", ["pc"], { opened });
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    expect((await mb.post("/commands", { executor: "open-url", args: { url: "https://example.com/" } })).json.ok).toBe(true);
    expect(opened).toEqual(["https://example.com/"]);
    const bad = await mb.post("/commands", { executor: "open-url", args: { url: "file:///C:/Windows" } });
    expect(bad.json.ok).toBe(false);
  });
});

describe("cancellation", () => {
  test("a running command is cancelled on the companion within a bounded time", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    const pending = hub.svc.dispatcher.submit({ personId: "mehroz", executor: "wait", args: { ms: 20_000 } }, { timeoutMs: 30_000 });
    expect(await until(() => m.worker.status().busy)).toBe(true);
    const commandId = m.worker.status().runningCommand!;
    expect(hub.svc.dispatcher.cancel(commandId, "usman")).toEqual({ ok: false, reason: "You can only cancel your own commands." });
    const started = Date.now();
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    expect((await mb.post("/commands/cancel", { commandId })).json.ok).toBe(true);
    expect(await pending).toMatchObject({ ok: false, reason: "Cancelled." });
    expect(await until(() => m.worker.history.some((h) => h.id === commandId && h.outcome === "cancelled"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(m.worker.status().busy).toBe(false);
  });
  test("a queued command can be cancelled before it is delivered", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    const first = hub.svc.dispatcher.submit({ personId: "mehroz", executor: "wait", args: { ms: 400 } });
    expect(await until(() => m.worker.status().busy)).toBe(true);
    const second = hub.svc.dispatcher.submit({ personId: "mehroz", executor: "echo", args: { text: "never" } });
    const queued = [...(hub.svc.dispatcher as any).commands.values()].find((c: any) => c.executor === "echo");
    expect(hub.svc.dispatcher.cancel(queued.id, "mehroz").ok).toBe(true);
    expect(await second).toMatchObject({ ok: false, reason: "Cancelled." });
    expect((await first).ok).toBe(true);
    expect(m.worker.history.some((h) => h.executor === "echo")).toBe(false);
  });
});

describe("local permission boundaries on the companion", () => {
  test("non-allow-listed executors are refused on the PC even if the hub sends them", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    const r = await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "format-disk" });
    expect(r).toMatchObject({ ok: false });
    expect(m.worker.history[0]).toMatchObject({ executor: "format-disk", outcome: "refused" });
  });
  test("send/pay/delete/publish: refused without the owner's own spoken yes, at hub and on the PC", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    const now = hub.clock.now(); // the hub's clock decides freshness
    // No approval → hub refuses before anything is queued.
    expect(await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "send-email" })).toMatchObject({ ok: false });
    // Usman's yes does not approve Mehroz's send.
    expect(await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "send-email", approval: { personId: "usman", via: "spoken-yes", at: now } })).toMatchObject({ ok: false });
    // A browser click is never a spoken yes.
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    expect((await mb.post("/commands", { executor: "publish-post" })).status).toBe(403);
    // Mehroz's own yes passes the hub, but no risky executor is allow-listed on the PC.
    const r = await hub.svc.dispatcher.submit({ personId: "mehroz", executor: "send-email", approval: { personId: "mehroz", via: "spoken-yes", at: now } });
    expect(r).toMatchObject({ ok: false });
    expect(m.worker.history.at(-1)).toMatchObject({ executor: "send-email", outcome: "refused" });
  });
  test("gate(): unit checks of the local boundary", () => {
    const ex = { ...defaultExecutors(), "send-email": async () => "sent" };
    const t = 1_000_000;
    const base = { id: "c1", args: {}, personId: "mehroz" as const };
    expect(gate({ ...base, executor: "echo" }, "mehroz", ex, t).ok).toBe(true);
    expect(gate({ ...base, executor: "echo", personId: "usman" }, "mehroz", ex, t).ok).toBe(false);
    expect(gate({ ...base, executor: "toString" }, "mehroz", ex, t).ok).toBe(false);
    expect(gate({ ...base, executor: "send-email" }, "mehroz", ex, t).ok).toBe(false);
    expect(gate({ ...base, executor: "send-email", approval: { personId: "usman", via: "spoken-yes", at: t } }, "mehroz", ex, t).ok).toBe(false);
    expect(gate({ ...base, executor: "send-email", approval: { personId: "mehroz", via: "spoken-yes", at: t - 3 * 60_000 } }, "mehroz", ex, t).ok).toBe(false);
    expect(gate({ ...base, executor: "send-email", approval: { personId: "mehroz", via: "spoken-yes", at: t } }, "mehroz", ex, t).ok).toBe(true);
    expect(gate({ ...base, executor: "echo", risk: "pay" }, "mehroz", ex, t).ok).toBe(false);
  });
});

describe("offline states", () => {
  test("a companion that loses the network goes offline on both sides and commands fail closed", async () => {
    const flaky = { down: false };
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"], { flaky });
    flaky.down = true;
    // Let heartbeats already in flight land first, then let the presence TTL lapse.
    expect(await until(() => m.worker.state === "offline")).toBe(true);
    hub.clock.advance(31_000);
    expect(resolveTarget({ personId: "mehroz" }, hub.svc.registry)).toEqual({ ok: false, reason: "device offline", deviceId: m.deviceId });
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    const r = await mb.post("/commands", { executor: "echo" });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("device offline");
    // Never re-routed to Usman's PC.
    expect(JSON.stringify(r.json)).not.toContain("usman-pc");
    flaky.down = false;
    expect(await until(() => m.worker.state === "online", 4_000)).toBe(true);
    expect((await mb.post("/commands", { executor: "echo", args: { text: "back" } })).json).toMatchObject({ ok: true, result: { echoed: "back" } });
  });
  test("a command in flight fails with 'device offline' when its device drops", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    const pending = hub.svc.dispatcher.submit({ personId: "mehroz", executor: "wait", args: { ms: 20_000 } });
    expect(await until(() => m.worker.status().busy)).toBe(true);
    hub.svc.dispatcher.deviceOffline(m.deviceId);
    expect(await pending).toMatchObject({ ok: false, reason: "device offline" });
  });
  test("stopping a companion says goodbye: offline at once, mic released", async () => {
    const u = await pairCompanion("usman", "Usman's laptop", ["laptop"], { mic: true });
    const lock = new MicLock(join(dir, "usman-mic.lock"), process.ppid);
    expect(lock.claim()).toBe(false);
    await u.worker.stop();
    const d = (await hub.browser("local").get("/devices")).json.devices.find((x: any) => x.id === u.deviceId);
    expect(d.online).toBe(false);
    expect(lock.claim()).toBe(true);
    lock.release();
  });
  test("revoking a companion stops it for good", async () => {
    const m = await pairCompanion("mehroz", "Mehroz's PC", ["pc"]);
    expect((await hub.browser("local").post("/devices/revoke", { deviceId: m.deviceId })).status).toBe(200);
    expect(await until(() => m.worker.state === "unpaired")).toBe(true);
    expect(resolveTarget({ personId: "mehroz" }, hub.svc.registry).ok).toBe(false);
  });
  test("Mehroz can't revoke Usman's companion", async () => {
    const u = await pairCompanion("usman", "Usman's laptop", ["laptop"]);
    const mb = hub.browser("mehroz");
    await mb.post("/pair/tailnet", {});
    expect((await mb.post("/devices/revoke", { deviceId: u.deviceId })).status).toBe(403);
  });
});

test("the companion only talks to a tailnet or local address", () => {
  expect(checkHubUrl("https://desktop-x.tail123.ts.net:8443").ok).toBe(true);
  expect(checkHubUrl("http://100.101.102.103:8081").ok).toBe(true);
  expect(checkHubUrl("http://127.0.0.1:4305").ok).toBe(true);
  expect(checkHubUrl("http://desktop-x.tail123.ts.net:8443").ok).toBe(false);
  expect(checkHubUrl("https://example.com").ok).toBe(false);
  expect(checkHubUrl("https://user:pw@desktop-x.tail123.ts.net").ok).toBe(false);
});
