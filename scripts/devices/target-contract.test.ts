// The target-device contract (docs/DEVICE-TARGET-CONTRACT.md), SYNTHETIC: Usman's hub and Mehroz's companion
// are fixtures from scripts/devices/synthetic.ts (labelled SYNTHETIC), answered in process. No real device,
// PowerPoint, Tailscale login or network.
import { afterEach, describe, expect, test } from "bun:test";
import { defaultExecutors, gate } from "../../companion/executors";
import { COMPANION_EXECUTORS } from "../jarvis-command/contracts";
import { planRules } from "../jarvis-command/plan";
import { approvalValid } from "./dispatch";
import { parseSpokenTarget, resolveTarget } from "./route";
import { startHub } from "./test-harness";
import { SYNTHETIC_MEHROZ_PC_ID, SYNTHETIC_USMAN_HUB_ID, syntheticWorld } from "./synthetic";

const worlds: Array<ReturnType<typeof syntheticWorld>> = [];
const world = (opts?: Parameters<typeof syntheticWorld>[0]) => {
  const w = syntheticWorld(opts);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((w) => w.close()));
});
const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
};

describe("device ownership: Mehroz cannot reach Usman's PC", () => {
  test("not by name, id, spokenTarget, originDeviceId or a person's display name", async () => {
    const w = world();
    const attempts = [
      { personId: "mehroz", spokenTarget: "on Usman's PC" },
      { personId: "mehroz", spokenTarget: "usman's computer" },
      { personId: "mehroz", spokenTarget: SYNTHETIC_USMAN_HUB_ID },
      { personId: "mehroz", originDeviceId: SYNTHETIC_USMAN_HUB_ID },
      { personId: "mehroz", spokenTarget: "here", originDeviceId: SYNTHETIC_USMAN_HUB_ID },
      { personId: "Usman (Mehroz)" },
    ];
    for (const a of attempts) {
      const r = resolveTarget(a, w.registry);
      expect(r.ok, JSON.stringify(a)).toBe(false);
      const sent = await w.dispatcher.submit({ ...a, executor: "app.open", args: { name: "powerpoint" } }, { timeoutMs: 200 });
      expect(sent.ok, JSON.stringify(a)).toBe(false);
    }
    expect(w.mehroz.ran).toEqual([]);
  });

  test("a display name / mu_name cookie never authorises control (real devices service over loopback)", async () => {
    const hub = await startHub({ maxWaitMs: 100 });
    try {
      const mehroz = hub.browser("mehroz");
      await mehroz.post("/pair/tailnet", { label: "Mehroz's browser" });
      // He picks "usman" as the name shown to him: personalisation only.
      expect((await mehroz.post("/name", { personId: "usman" })).status).toBe(200);
      const me = await mehroz.get("/me");
      expect(me.json.principal.personId).toBe("mehroz");
      // Body fields that try to say "I am Usman" or "run it on the hub" are not read.
      const r = await mehroz.post("/commands", { executor: "echo", args: { text: "x" }, personId: "usman", originDeviceId: "usman-pc", deviceId: "usman-pc", spokenTarget: "Usman's PC", timeoutMs: 100 });
      // Refused (his tailnet login alone is only a shared-workspace session, not a paired device); never run on the hub.
      expect([403, 409]).toContain(r.status);
      expect(r.json.local).not.toBe(true);
      const bare = await mehroz.post("/commands", { executor: "echo", args: {}, personId: "usman", timeoutMs: 100 });
      expect([403, 409]).toContain(bare.status);
      expect(bare.json.local).not.toBe(true);
    } finally {
      await hub.close();
    }
  });

  test("the companion's own gate refuses a command signed for someone else", () => {
    const executors = defaultExecutors({ platform: "win32", windows: {} });
    const cmd = { id: "c1", executor: "app.open", args: { name: "powerpoint" }, personId: "usman" as const };
    expect(gate(cmd, "mehroz", executors)).toEqual({ ok: false, reason: "That command is for someone else's device." });
    expect(gate({ ...cmd, personId: "mehroz" }, "mehroz", executors).ok).toBe(true);
  });
});

describe('"here" means the device the request came from', () => {
  test("parse: here / right here / this pc / this computer carry no name to match", () => {
    for (const t of ["here", "right here", "this pc", "on this computer", "this device"]) expect(parseSpokenTarget(t, "mehroz"), t).toMatchObject({ owner: "mehroz", words: [], here: true });
    expect(parseSpokenTarget("this laptop", "mehroz")).toMatchObject({ words: ["laptop"] });
    expect(parseSpokenTarget("here", "mehroz")?.here).toBe(true);
  });

  test("Mehroz: origin companion, else his own primary; never the hub", () => {
    const w = world();
    for (const say of ["here", "this pc", "this computer", "on this pc"]) {
      expect(resolveTarget({ personId: "mehroz", spokenTarget: say, originDeviceId: SYNTHETIC_MEHROZ_PC_ID }, w.registry)).toMatchObject({ ok: true, deviceId: SYNTHETIC_MEHROZ_PC_ID, owner: "mehroz" });
      expect(resolveTarget({ personId: "mehroz", spokenTarget: say }, w.registry)).toMatchObject({ ok: true, deviceId: SYNTHETIC_MEHROZ_PC_ID });
    }
  });

  test("Usman at his PC: here is the hub; a named person is still refused", () => {
    const w = world();
    expect(resolveTarget({ personId: "usman", spokenTarget: "here", originDeviceId: SYNTHETIC_USMAN_HUB_ID }, w.registry)).toMatchObject({ ok: true, deviceId: SYNTHETIC_USMAN_HUB_ID });
    expect(resolveTarget({ personId: "usman", spokenTarget: "Mehroz's PC" }, w.registry).ok).toBe(false);
  });
});

describe("open PowerPoint here", () => {
  test("plans an allow-listed companion executor, and the companion allows it on Windows", () => {
    const plan = planRules("open PowerPoint");
    expect(plan).toMatchObject({ lane: "executor", executor: "app.open", args: { name: "powerpoint" } });
    expect(COMPANION_EXECUTORS).toContain("app.open");
    expect(COMPANION_EXECUTORS).toContain("deck.blank");
    const win = defaultExecutors({ platform: "win32", windows: {} });
    expect(Object.keys(win)).toEqual(expect.arrayContaining(["app.open", "deck.blank"]));
    // Off Windows the desktop executors are not registered at all.
    expect(Object.keys(defaultExecutors({ platform: "linux" }))).not.toContain("app.open");
  });

  test("Mehroz's request runs on his synthetic companion only", async () => {
    const w = world();
    const r = await w.dispatcher.submit({ personId: "mehroz", spokenTarget: "this pc", originDeviceId: SYNTHETIC_MEHROZ_PC_ID, executor: "app.open", args: { name: "powerpoint" } }, { timeoutMs: 2_000 });
    expect(r).toMatchObject({ ok: true, local: false, deviceId: SYNTHETIC_MEHROZ_PC_ID });
    expect(w.mehroz.ran).toEqual([{ executor: "app.open", args: { name: "powerpoint" }, personId: "mehroz" }]);
  });
});

describe("offline fails closed", () => {
  test("no reroute to the hub or anyone else; nothing runs", async () => {
    const w = world();
    w.mehroz.goOffline();
    const r = await w.dispatcher.submit({ personId: "mehroz", spokenTarget: "here", executor: "app.open", args: { name: "powerpoint" } }, { timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, reason: "device offline", deviceId: SYNTHETIC_MEHROZ_PC_ID });
    expect((r as { local?: boolean }).local).toBeUndefined();
    expect(w.mehroz.ran).toEqual([]);
    w.mehroz.goOnline();
    expect((await w.dispatcher.submit({ personId: "mehroz", executor: "echo", args: { text: "back" } }, { timeoutMs: 2_000 })).ok).toBe(true);
  });

  test("a heartbeat that stops (no goodbye) also fails closed once presence lapses", async () => {
    const w = world({ start: false });
    w.registry.heartbeat(SYNTHETIC_MEHROZ_PC_ID);
    expect(resolveTarget({ personId: "mehroz" }, w.registry).ok).toBe(true);
    w.clock.advance(31_000);
    expect(resolveTarget({ personId: "mehroz" }, w.registry)).toEqual({ ok: false, reason: "device offline", deviceId: SYNTHETIC_MEHROZ_PC_ID });
  });
});

describe("risky actions need the same person's spoken yes", () => {
  test("no approval, someone else's approval, or an old one is refused; his own runs", async () => {
    const w = world();
    const base = { personId: "mehroz", executor: "echo", args: {}, risk: "send" as const };
    const now = w.clock.now();
    expect((await w.dispatcher.submit(base, { timeoutMs: 200 })).ok).toBe(false);
    expect((await w.dispatcher.submit({ ...base, approval: { personId: "usman", via: "spoken-yes", at: now } }, { timeoutMs: 200 })).ok).toBe(false);
    expect(approvalValid({ personId: "mehroz", via: "spoken-yes", at: now - 3 * 60_000 }, "mehroz", now)).toBe(false);
    expect(w.mehroz.ran).toEqual([]);
  });
});

describe("no duplicate dispatch (commandKey)", () => {
  test("the same key from the same person while it runs is one command", async () => {
    const w = world();
    const input = { personId: "mehroz", executor: "wait", args: { ms: 80 }, commandKey: "typed+voice" };
    const [a, b] = await Promise.all([w.dispatcher.submit(input, { timeoutMs: 2_000 }), w.dispatcher.submit(input, { timeoutMs: 2_000 })]);
    expect(a.ok && b.ok).toBe(true);
    expect((a as { commandId: string }).commandId).toBe((b as { commandId: string }).commandId);
    expect(w.mehroz.ran.filter((c) => c.executor === "wait")).toHaveLength(1);
  });

  test("a finished one is reused within the window, run again after it, and different args are different", async () => {
    const w = world();
    const go = (args: Record<string, unknown>) => w.dispatcher.submit({ personId: "mehroz", executor: "echo", args, commandKey: "k" }, { timeoutMs: 2_000 });
    const first = await go({ text: "a" });
    const again = await go({ text: "a" });
    expect((again as { commandId: string }).commandId).toBe((first as { commandId: string }).commandId);
    expect(w.mehroz.ran).toHaveLength(1);
    expect(((await go({ text: "b" })) as { commandId: string }).commandId).not.toBe((first as { commandId: string }).commandId);
    w.clock.advance(6_000);
    await go({ text: "b" });
    expect(w.mehroz.ran).toHaveLength(3);
  });

  test("no key means no dedupe; a failed command is retried, not replayed", async () => {
    const w = world();
    await w.dispatcher.submit({ personId: "mehroz", executor: "echo", args: {} }, { timeoutMs: 2_000 });
    await w.dispatcher.submit({ personId: "mehroz", executor: "echo", args: {} }, { timeoutMs: 2_000 });
    expect(w.mehroz.ran).toHaveLength(2);
    w.mehroz.goOffline();
    const failed = await w.dispatcher.submit({ personId: "mehroz", executor: "echo", args: {}, commandKey: "f" }, { timeoutMs: 200 });
    expect(failed.ok).toBe(false);
    w.mehroz.goOnline();
    expect((await w.dispatcher.submit({ personId: "mehroz", executor: "echo", args: {}, commandKey: "f" }, { timeoutMs: 2_000 })).ok).toBe(true);
  });
});

describe("stop mid-command", () => {
  test("cancelling a running command comes back cancelled, not a late success", async () => {
    const w = world();
    const stop = new AbortController();
    const pending = w.dispatcher.submit({ personId: "mehroz", executor: "wait", args: { ms: 4_000 } }, { timeoutMs: 10_000, signal: stop.signal });
    expect(await until(() => w.mehroz.ran.some((c) => c.executor === "wait"))).toBe(true);
    stop.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "Cancelled." });
  });
});
