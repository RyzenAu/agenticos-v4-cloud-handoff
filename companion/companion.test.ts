import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextItem, WireCommand } from "../scripts/devices/dispatch";
import { checkRoot, defaultRoots, rootsOf } from "./config";
import { defaultExecutors, gate, type Executor } from "./executors";
import { MicLock } from "./mic-lock";
import { CompanionWorker, resultPost, type CompanionState } from "./worker";

// SYNTHETIC: a scripted fake hub behind fetchImpl. No network, no real device, no screen.

type Json = Record<string, any>;
class FakeHub {
  mode: "up" | "down" | "revoked" = "up";
  beats: Json[] = [];
  results: Json[] = [];
  items: NextItem[] = [];
  /** Held long-polls: resolved when an item is pushed or the wait ends. */
  private polls: Array<(item: NextItem | null) => void> = [];
  push(item: NextItem) {
    const poll = this.polls.shift();
    if (poll) poll(item);
    else this.items.push(item);
  }
  /** Answer a held poll with an item even though the network is "down" now (a late response). */
  lateDeliver(item: NextItem) {
    const poll = this.polls.shift();
    poll?.(item);
    return !!poll;
  }
  heldPolls() {
    return this.polls.length;
  }
  fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/__devices/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    if (path === "/companion/next") {
      if (this.mode === "revoked") return reply(403, { error: "revoked" });
      if (this.mode === "down") throw new Error("network down");
      const ready = this.items.shift();
      if (ready) return reply(200, { item: ready });
      const item = await new Promise<NextItem | null>((resolve) => {
        this.polls.push(resolve);
        const t = setTimeout(() => {
          const i = this.polls.indexOf(resolve);
          if (i >= 0) this.polls.splice(i, 1);
          resolve(null);
        }, Number(url.searchParams.get("wait") ?? 50));
        // Like real fetch: an abort (the worker stopping) ends the request at once.
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            const i = this.polls.indexOf(resolve);
            if (i >= 0) this.polls.splice(i, 1);
            resolve(null);
          },
          { once: true },
        );
      });
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return reply(200, { item });
    }
    if (this.mode === "revoked") return reply(403, { error: "revoked" });
    if (this.mode === "down") throw new Error("network down");
    if (path === "/companion/heartbeat") {
      this.beats.push(body);
      return reply(200, { ok: true });
    }
    if (path === "/companion/result") {
      this.results.push(body);
      return reply(200, { accepted: true });
    }
    if (path === "/companion/goodbye") return reply(200, { ok: true });
    return reply(404, {});
  }) as typeof fetch;
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "companion-t2-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function worker(hub: FakeHub, extra: Partial<ConstructorParameters<typeof CompanionWorker>[0]> = {}) {
  const w = new CompanionWorker({ hubUrl: "http://127.0.0.1:1", token: "t", deviceId: "mehroz-pc", owner: "mehroz", heartbeatMs: 20, pollWaitMs: 60, fetchImpl: hub.fetch, log: () => undefined, ...extra });
  cleanup.push(() => w.stop());
  return w;
}

const cmd = (id: string, executor: string, args: Json = {}, personId: "mehroz" | "usman" = "mehroz"): WireCommand => ({ id, executor, args, personId });

/** An executor that runs until aborted; records what it saw. */
function blocker(seen: { aborted: number; ran: number }): Executor {
  return (_args, ctx) =>
    new Promise((resolve) => {
      seen.ran++;
      ctx.signal.addEventListener("abort", () => {
        seen.aborted++;
        resolve({ ok: false, said: "Stopped.", verified: false });
      });
    });
}

describe("results go back as ExecutorResults", () => {
  test("resultPost: pass-through, failures carry their line, legacy output wrapped", () => {
    expect(resultPost("c1", { ok: true, said: "Opened Notepad.", verified: true })).toEqual({ commandId: "c1", ok: true, output: { ok: true, said: "Opened Notepad.", verified: true } });
    expect(resultPost("c2", { ok: false, said: "No window appeared.", verified: false })).toMatchObject({ ok: false, error: "No window appeared.", output: { ok: false } });
    expect(resultPost("c3", { echoed: "x" })).toMatchObject({ ok: true, output: { ok: true, verified: null, data: { echoed: "x" } } });
  });
  test("a Windows executor's ExecutorResult reaches the hub intact (ok, verified, evidence)", async () => {
    const hub = new FakeHub();
    const w = worker(hub, { executors: { "notepad.type": async () => ({ ok: true, said: "Typed it.", verified: true, evidence: "read back 5 chars" }) } }).start();
    expect(await w.waitOnline()).toBe(true);
    hub.push({ type: "command", command: cmd("c1", "notepad.type", { text: "hello" }) });
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(hub.results[0]).toEqual({ commandId: "c1", ok: true, output: { ok: true, said: "Typed it.", verified: true, evidence: "read back 5 chars" } });
  });
  test("an executor's ok:false is posted as a failure with its own line", async () => {
    const hub = new FakeHub();
    const w = worker(hub, { executors: { "deck.blank": async () => ({ ok: false, said: "PowerPoint is running as an Unlicensed Product.", verified: false }) } }).start();
    await w.waitOnline();
    hub.push({ type: "command", command: cmd("c1", "deck.blank", { title: "T" }) });
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(hub.results[0]).toMatchObject({ ok: false, error: "PowerPoint is running as an Unlicensed Product.", output: { ok: false, verified: false } });
    expect(w.history[0]).toMatchObject({ outcome: "failed" });
  });
});

describe("gate on the companion", () => {
  test("Windows executors are registered on Windows only; echo/notify/wait/open-url everywhere", () => {
    const win = Object.keys(defaultExecutors({ platform: "win32", open: () => undefined }));
    expect(win.sort()).toEqual(["app.open", "deck.blank", "echo", "file.open", "notepad.type", "notify", "open-url", "wait"]);
    const mac = Object.keys(defaultExecutors({ platform: "darwin", open: () => undefined }));
    expect(mac.sort()).toEqual(["echo", "notify", "open-url", "wait"]);
  });
  test("someone else's command, an unknown executor or a risky one without his yes → refused and posted as refused", async () => {
    const hub = new FakeHub();
    let ran = 0;
    const ex: Record<string, Executor> = { "notepad.type": async () => (ran++, { ok: true, said: "x", verified: true }), "send-email": async () => (ran++, "sent") };
    const w = worker(hub, { executors: ex }).start();
    await w.waitOnline();
    hub.push({ type: "command", command: cmd("a", "notepad.type", { text: "hi" }, "usman") });
    hub.push({ type: "command", command: cmd("b", "format-disk") });
    hub.push({ type: "command", command: cmd("c", "send-email") });
    expect(await until(() => hub.results.length === 3)).toBe(true);
    expect(ran).toBe(0);
    for (const r of hub.results) expect(r).toMatchObject({ ok: false, output: { ok: false, verified: false, data: { refused: true } } });
    expect(gate(cmd("d", "notepad.type", {}, "usman"), "mehroz", ex)).toMatchObject({ ok: false });
  });
  test("one command at a time: a second while busy is refused, not run alongside", async () => {
    const hub = new FakeHub();
    const seen = { aborted: 0, ran: 0 };
    const w = worker(hub, { executors: { wait: blocker(seen) } }).start();
    await w.waitOnline();
    hub.push({ type: "command", command: cmd("a", "wait") });
    expect(await until(() => w.status().busy)).toBe(true);
    hub.push({ type: "command", command: cmd("b", "wait") });
    expect(await until(() => hub.results.some((r) => r.commandId === "b"))).toBe(true);
    expect(hub.results.find((r) => r.commandId === "b")).toMatchObject({ ok: false, error: "This PC is still finishing another command." });
    expect(seen.ran).toBe(1);
  });
});

describe("cancel", () => {
  test("the hub's cancel aborts the running executor and posts nothing that looks like success", async () => {
    const hub = new FakeHub();
    const seen = { aborted: 0, ran: 0 };
    const w = worker(hub, { executors: { "notepad.type": blocker(seen) } }).start();
    await w.waitOnline();
    hub.push({ type: "command", command: cmd("c1", "notepad.type", { text: "hi" }) });
    expect(await until(() => w.status().runningCommand === "c1")).toBe(true);
    hub.push({ type: "cancel", commandId: "c1" });
    expect(await until(() => seen.aborted === 1)).toBe(true);
    expect(await until(() => w.history.some((h) => h.id === "c1" && h.outcome === "cancelled"))).toBe(true);
    expect(hub.results.find((r) => r.commandId === "c1")).toMatchObject({ ok: false, error: "Cancelled.", output: { data: { cancelled: true } } });
    expect(w.status().busy).toBe(false);
  });
  test("the real wait executor is cancellable", async () => {
    const hub = new FakeHub();
    const w = worker(hub, { executors: defaultExecutors({ platform: "linux", open: () => undefined }) }).start();
    await w.waitOnline();
    hub.push({ type: "command", command: cmd("w", "wait", { ms: 30_000 }) });
    expect(await until(() => w.status().busy)).toBe(true);
    hub.push({ type: "cancel", commandId: "w" });
    expect(await until(() => w.history.some((h) => h.id === "w" && h.outcome === "cancelled"), 1_500)).toBe(true);
  });
});

describe("microphone ownership", () => {
  test("the heartbeat and status follow claim and release", async () => {
    const dir = tempDir();
    const hub = new FakeHub();
    const w = worker(hub, { micLock: new MicLock(join(dir, "mic.lock")) }).start();
    await w.waitOnline();
    expect(w.status().micOwned).toBe(true);
    expect(hub.beats.at(-1)!.micOwned).toBe(true);
    await w.releaseMic();
    expect(w.status().micOwned).toBe(false);
    expect(hub.beats.at(-1)!.micOwned).toBe(false);
    // Released on purpose: later heartbeats keep saying so (no silent re-claim).
    const n = hub.beats.length;
    expect(await until(() => hub.beats.length >= n + 2)).toBe(true);
    expect(hub.beats.slice(n).every((b) => b.micOwned === false)).toBe(true);
    expect(await w.claimMic()).toBe(true);
    expect(hub.beats.at(-1)!.micOwned).toBe(true);
    expect(w.status().micOwned).toBe(true);
  });
  test("someone else holding the mic → reported false; taken over or deleted → false, not stale", async () => {
    const dir = tempDir();
    const file = join(dir, "mic.lock");
    const other = new MicLock(file, process.ppid); // a live process that isn't us
    expect(other.claim()).toBe(true);
    const hub = new FakeHub();
    const w = worker(hub, { micLock: new MicLock(file) }).start();
    await w.waitOnline();
    expect(hub.beats.at(-1)!.micOwned).toBe(false);
    expect(w.status()).toMatchObject({ micOwned: false, micHolder: process.ppid });
    other.release();
    // The lock is free now: the next heartbeat claims it and says so.
    expect(await until(() => hub.beats.at(-1)?.micOwned === true)).toBe(true);
    // Someone deletes it and writes their own pid: owned() reads the file, not a stale flag.
    const mine = new MicLock(file);
    expect(mine.claim()).toBe(true);
    unlinkSync(file);
    writeFileSync(file, String(process.ppid));
    expect(mine.owned()).toBe(false);
  });
});

describe("offline and revoked", () => {
  test("hub unreachable → the running command is aborted (fail closed) and no result is posted late", async () => {
    const hub = new FakeHub();
    const seen = { aborted: 0, ran: 0 };
    const w = worker(hub, { executors: { "notepad.type": blocker(seen) } }).start();
    await w.waitOnline();
    hub.push({ type: "command", command: cmd("c1", "notepad.type", { text: "hi" }) });
    expect(await until(() => w.status().busy)).toBe(true);
    hub.mode = "down";
    expect(await until(() => w.state === "offline")).toBe(true);
    expect(await until(() => seen.aborted === 1)).toBe(true);
    expect(w.history.find((h) => h.id === "c1")).toMatchObject({ outcome: "cancelled" });
    expect(hub.results.filter((r) => r.commandId === "c1")).toEqual([]);
  });
  test("a command that arrives across a disconnect never runs; reconnects with backoff and runs new ones", async () => {
    const hub = new FakeHub();
    let ran = 0;
    const states: CompanionState[] = [];
    const w = worker(hub, { executors: { echo: async () => (ran++, { ok: true, said: "Echoed.", verified: true }) }, pollWaitMs: 400, onState: (s) => states.push(s) }).start();
    await w.waitOnline();
    expect(await until(() => hub.heldPolls() === 1)).toBe(true);
    hub.mode = "down";
    expect(await until(() => w.state === "offline")).toBe(true);
    // The poll that was already open answers late with a command: it must not run.
    expect(hub.lateDeliver({ type: "command", command: cmd("stale", "echo") })).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(ran).toBe(0);
    expect(w.history.find((h) => h.id === "stale")).toMatchObject({ outcome: "failed", detail: "arrived across a disconnect; not run" });
    hub.mode = "up";
    expect(await until(() => w.state === "online", 4_000)).toBe(true);
    hub.push({ type: "command", command: cmd("fresh", "echo") });
    expect(await until(() => ran === 1)).toBe(true);
    expect(states).toEqual(["online", "offline", "online"]);
  });
  test("a revoked pairing stops for good (unpaired; onState says so; loops end)", async () => {
    const hub = new FakeHub();
    const states: CompanionState[] = [];
    const w = worker(hub, { onState: (s) => states.push(s) }).start();
    await w.waitOnline();
    hub.mode = "revoked";
    expect(await until(() => w.state === "unpaired")).toBe(true);
    const beats = hub.beats.length;
    hub.mode = "up";
    await new Promise((r) => setTimeout(r, 120));
    expect(w.state).toBe("unpaired");
    expect(hub.beats.length).toBe(beats);
    expect(states).toContain("unpaired");
  });
});

describe("authorised folders", () => {
  test("default is a dedicated folder; drive roots, the profile and system folders are refused", () => {
    const env = { USERPROFILE: "C:\\Users\\mehroz", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData" };
    expect(defaultRoots(env)[0]).toMatch(/Users[\\/]mehroz[\\/]Documents[\\/]MU-Jarvis$/);
    if (process.platform === "win32") {
      expect(checkRoot("D:\\Work\\Jarvis", env)).toMatchObject({ ok: true });
      for (const bad of ["C:\\", "D:\\", "C:\\Users\\mehroz", "C:\\Windows\\System32", "C:\\Program Files\\x", "relative\\path", ""]) expect(checkRoot(bad, env).ok).toBe(false);
      expect(rootsOf({ roots: ["C:\\", "D:\\Work\\Jarvis"] }, env)).toEqual(["D:\\Work\\Jarvis"]);
      expect(rootsOf({ roots: ["C:\\"] }, env)).toEqual(defaultRoots(env));
    }
    expect(rootsOf(null, env)).toEqual(defaultRoots(env));
  });
});
