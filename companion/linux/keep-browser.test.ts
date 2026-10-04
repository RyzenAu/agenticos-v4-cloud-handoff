import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { clearStaleHold, ensureBrowser, keepBrowserOpen, type CdpConfig, type StartDeps } from "./cdp";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a desktop computer keeps its browser open (an idle desktop with no window is a black, blank screen)", () => {
  const watch = (over: Partial<Parameters<typeof keepBrowserOpen>[0]> = {}) => {
    const c = { ensure: 0, alive: 0 };
    const logs: string[] = [];
    const stop = keepBrowserOpen({ ensure: async () => void c.ensure++, alive: async () => (c.alive++, false), paused: () => false, log: (l) => logs.push(l), everyMs: 15, ...over });
    return { c, logs, stop };
  };

  test("it opens the browser at start, and reopens it only after TWO consecutive misses (a busy browser can miss one check)", async () => {
    let answers = [false, true, false, false, false, false];
    const { c, stop } = watch({ alive: async () => answers.shift() ?? false });
    expect(c.ensure).toBe(1); // at start
    await tick(30); // miss, then an answer: no reopen
    expect(c.ensure).toBe(1);
    await tick(70); // miss, miss: reopened
    expect(c.ensure).toBeGreaterThanOrEqual(2);
    stop();
  });

  test("a failure to open is logged, never thrown, and it tries again", async () => {
    let calls = 0;
    const { logs, stop } = watch({ ensure: async () => { calls++; if (calls === 1) throw new Error("Chromium didn't start."); } });
    await tick(80);
    expect(logs.some((l) => /Chromium didn't start/.test(l))).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    stop();
  });

  test("it leaves the browser alone while a person holds the computer or a job step is running, even if the browser does not answer", async () => {
    let paused = true;
    const { c, stop } = watch({ paused: () => paused });
    await tick(100);
    expect(c.ensure).toBe(1); // only the start
    expect(c.alive).toBe(0); // it did not even look
    paused = false;
    await tick(80);
    expect(c.ensure).toBeGreaterThanOrEqual(2);
    stop();
  });

  test("a person who takes the computer while the answer is being waited for is not undone by it", async () => {
    let paused = false;
    const { c, stop } = watch({ paused: () => paused, alive: async () => { await tick(20); paused = true; return false; } });
    await tick(120);
    expect(c.ensure).toBe(1);
    stop();
  });

  test("it stops when told", async () => {
    const { c, stop } = watch();
    stop();
    const n = c.alive;
    await tick(60);
    expect(c.alive).toBe(n);
  });
});

describe("a stale hold marker is cleared when the companion boots", () => {
  test("the marker in the config folder is removed (the hub says 'on' again if a person still holds the computer); nothing to clear is fine", () => {
    const removed: string[] = [];
    clearStaleHold("/cfg", (p) => void removed.push(p.replace(/\\/g, "/")));
    expect(removed).toEqual(["/cfg/hold"]);
    expect(() => clearStaleHold("/cfg", () => { throw new Error("EACCES"); })).not.toThrow();
  });
});

describe("ensureBrowser never starts a second Chromium on a profile that one is still using", () => {
  const cfg: CdpConfig = { port: 9333, profileDir: "/p", chromiumPath: "/usr/bin/chromium", display: ":41" };
  function deps(over: Partial<StartDeps> = {}) {
    const seen = { spawned: 0, removed: 0, upCalls: [] as number[] };
    const d: StartDeps = {
      up: async (_p, ms) => (seen.upCalls.push(ms), false),
      lockPid: () => null,
      alive: () => false,
      removeLocks: () => void seen.removed++,
      spawn: () => {
        seen.spawned++;
        d.up = async () => true; // it comes up
        return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess;
      },
      sleep: async () => undefined,
      ...over,
    };
    return { d, seen };
  }

  test("a lock whose pid is ALIVE (a busy browser that missed a check): its locks are not deleted and nothing is spawned; an answer that never comes is an error", async () => {
    const { d, seen } = deps({ lockPid: () => 4242, alive: (pid) => pid === 4242 });
    await expect(ensureBrowser(cfg, () => undefined, d)).rejects.toThrow(/isn't answering; not starting a second one/);
    expect(seen.spawned).toBe(0);
    expect(seen.removed).toBe(0);
    expect(Math.min(...seen.upCalls)).toBeGreaterThanOrEqual(3_000); // a generous timeout, not 800 ms
  });

  test("the same live browser answering a little later is simply used", async () => {
    let n = 0;
    const { d, seen } = deps({ lockPid: () => 4242, alive: () => true, up: async () => ++n > 3 });
    await ensureBrowser(cfg, () => undefined, d);
    expect(seen.spawned).toBe(0);
    expect(seen.removed).toBe(0);
  });

  test("a stale lock (its pid is dead) is cleared and one browser is started; no lock at all just starts one", async () => {
    const a = deps({ lockPid: () => 4242, alive: () => false });
    await ensureBrowser(cfg, () => undefined, a.d);
    expect(a.seen).toMatchObject({ spawned: 1, removed: 1 });
    const b = deps();
    await ensureBrowser(cfg, () => undefined, b.d);
    expect(b.seen).toMatchObject({ spawned: 1, removed: 1 });
  });
});
