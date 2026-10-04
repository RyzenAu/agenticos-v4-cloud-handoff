import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextItem, WireCommand } from "../scripts/devices/dispatch";
import type { Executor } from "./executors";
import { CommandLedger } from "./ledger";
import { desktopInteractive } from "./session";
import { COMPANION_VERSION, CompanionWorker } from "./worker";

// SYNTHETIC: a scripted hub behind fetchImpl; no network, no real PC. The worker side of the wire contract:
// expiry, idempotency by commandKey (on disk), cancel, observe, lost results, version/capabilities/interactive.

type Json = Record<string, any>;
class Hub {
  beats: Json[] = [];
  results: Json[] = [];
  observations: Json[] = [];
  progress: Json[] = [];
  items: NextItem[] = [];
  /** hub clock minus the PC's clock, sent back as serverTime. */
  skewMs = 0;
  /** The next N result POSTs never arrive (a lost ack). */
  dropResults = 0;
  resultStatus = 200;
  private polls: Array<(item: NextItem | null) => void> = [];
  push(item: NextItem) {
    const poll = this.polls.shift();
    if (poll) poll(item);
    else this.items.push(item);
  }
  fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/__devices/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    if (path === "/companion/next") {
      const ready = this.items.shift();
      if (ready) return reply(200, { item: ready });
      const item = await new Promise<NextItem | null>((resolve) => {
        this.polls.push(resolve);
        const t = setTimeout(() => {
          const i = this.polls.indexOf(resolve);
          if (i >= 0) this.polls.splice(i, 1);
          resolve(null);
        }, Number(url.searchParams.get("wait") ?? 50));
        init?.signal?.addEventListener("abort", () => (clearTimeout(t), this.polls.splice(this.polls.indexOf(resolve) >>> 0, 1), resolve(null)), { once: true });
      });
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return reply(200, { item });
    }
    if (path === "/companion/heartbeat") {
      this.beats.push(body);
      return reply(200, { ok: true, serverTime: Date.now() + this.skewMs });
    }
    if (path === "/companion/result") {
      if (this.dropResults > 0) {
        this.dropResults--;
        throw new Error("the ack was lost");
      }
      this.results.push(body);
      return reply(this.resultStatus, { accepted: this.resultStatus === 200 });
    }
    if (path === "/companion/progress") {
      this.progress.push(body);
      return reply(200, { accepted: true });
    }
    if (path === "/companion/observation") {
      this.observations.push(body);
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
    await new Promise((r) => setTimeout(r, 8));
  }
  return false;
};
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "companion-wire-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function worker(hub: Hub, extra: Partial<ConstructorParameters<typeof CompanionWorker>[0]> = {}) {
  const w = new CompanionWorker({ hubUrl: "http://127.0.0.1:1", token: "t", deviceId: "usman-pc2", owner: "usman", heartbeatMs: 20, pollWaitMs: 60, fetchImpl: hub.fetch, log: () => undefined, interactive: async () => true, ...extra });
  cleanup.push(() => w.stop());
  return w;
}
const wire = (id: string, executor: string, extra: Partial<WireCommand> = {}): WireCommand => ({
  id,
  executor,
  args: {},
  personId: "usman",
  deviceId: "usman-pc2",
  jobId: "job1",
  stepId: `s-${id}`,
  commandKey: `job1/s-${id}`,
  expiresAt: Date.now() + 60_000,
  ...extra,
});
const cmdItem = (c: WireCommand): NextItem => ({ type: "command", command: c });

/** An executor that counts its runs, and (optionally) holds until released or aborted. */
function counter() {
  const seen = { ran: 0, aborted: 0, release: undefined as undefined | (() => void) };
  const run: Executor = (_args, ctx) =>
    new Promise((resolve) => {
      seen.ran++;
      const done = () => resolve({ ok: true, said: "Done.", verified: true, evidence: "checked" });
      seen.release = done;
      ctx.signal.addEventListener("abort", () => (seen.aborted++, resolve({ ok: false, said: "Stopped.", verified: false })), { once: true });
      if (!seen.hold) done();
    });
  return Object.assign(seen, { run, hold: false });
}
type Counter = ReturnType<typeof counter>;
const ex = (c: Counter): Record<string, Executor> => ({ "app.open": c.run, echo: c.run });

describe("expiry", () => {
  test("a command past its expiresAt is refused, never run, and the refusal is posted", async () => {
    const hub = new Hub();
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo", { expiresAt: Date.now() - 1 })));
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(c.ran).toBe(0);
    expect(hub.results[0]).toMatchObject({ commandId: "a", ok: false, output: { ok: false, verified: false, data: { refused: true, expired: true } } });
    expect(hub.results[0].error).toContain("expired");
  });
  test("expiry is judged on the HUB's clock (taught by the heartbeat), not this PC's", async () => {
    const hub = new Hub();
    hub.skewMs = -10 * 60_000; // the hub's clock is 10 minutes behind this PC's
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    // By this PC's clock it expired 5 minutes ago; by the hub's clock it has 5 minutes left: it runs.
    hub.push(cmdItem(wire("a", "echo", { expiresAt: Date.now() - 5 * 60_000 })));
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(c.ran).toBe(1);
    expect(hub.results[0]).toMatchObject({ ok: true });
  });
});

describe("idempotency by commandKey", () => {
  test("the same key delivered twice runs once; the second delivery re-sends the recorded report", async () => {
    const hub = new Hub();
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    expect(await until(() => hub.results.length === 1)).toBe(true);
    hub.push(cmdItem(wire("a", "echo", { id: "a2" }))); // a redelivery under a new command id, same key
    await until(() => hub.results.length === 2, 600);
    expect(c.ran).toBe(1);
    // Nothing new ran; at most the recorded result was re-sent.
    expect(hub.results.every((r) => r.output.said === "Done.")).toBe(true);
  });
  test("a different step is a different key: both run", async () => {
    const hub = new Hub();
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    await until(() => hub.results.length === 1);
    hub.push(cmdItem(wire("b", "echo")));
    expect(await until(() => hub.results.length === 2)).toBe(true);
    expect(c.ran).toBe(2);
  });
  test("the ledger is on disk: a restarted companion does not run a key it already ran", async () => {
    const dir = tempDir();
    const path = join(dir, "command-ledger.json");
    const hub1 = new Hub();
    const c1 = counter();
    const w1 = worker(hub1, { executors: ex(c1), ledger: new CommandLedger(path) }).start();
    await w1.waitOnline();
    hub1.push(cmdItem(wire("a", "echo")));
    await until(() => hub1.results.length === 1);
    await w1.stop();
    // A new process, the same ledger file, the same command delivered again.
    const hub2 = new Hub();
    const c2 = counter();
    const w2 = worker(hub2, { executors: ex(c2), ledger: new CommandLedger(path) }).start();
    await w2.waitOnline();
    hub2.push(cmdItem(wire("a", "echo")));
    await new Promise((r) => setTimeout(r, 150));
    expect(c2.ran).toBe(0);
  });
  test("killed mid-step: after a restart that key is 'interrupted' (it may have happened), and is never re-run", async () => {
    const dir = tempDir();
    const path = join(dir, "command-ledger.json");
    // What a process that died mid-step left behind: written BEFORE the action started.
    writeFileSync(path, JSON.stringify([{ commandKey: "job1/s-x", commandId: "x", executor: "echo", state: "running", startedAt: Date.now() - 1000, reported: false }]));
    const hub = new Hub();
    const c = counter();
    const w = worker(hub, { executors: ex(c), ledger: new CommandLedger(path) }).start();
    await w.waitOnline();
    hub.push({ type: "observe", commandId: "x", commandKey: "job1/s-x" });
    expect(await until(() => hub.observations.length === 1)).toBe(true);
    expect(hub.observations[0]).toEqual({ commandId: "x", observation: { state: "interrupted" } });
    hub.push(cmdItem(wire("x", "echo")));
    await new Promise((r) => setTimeout(r, 120));
    expect(c.ran).toBe(0);
  });
  test("the ledger is written before the action starts", async () => {
    const dir = tempDir();
    const path = join(dir, "command-ledger.json");
    const hub = new Hub();
    const c = counter();
    c.hold = true;
    const w = worker(hub, { executors: ex(c), ledger: new CommandLedger(path) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    expect(await until(() => c.ran === 1)).toBe(true);
    const onDisk = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
    expect(onDisk).toMatchObject([{ commandKey: "job1/s-a", state: "running" }]);
    c.release?.();
  });
});

describe("cancel", () => {
  test("a cancel while a step is running aborts it; the result says Cancelled and nothing else runs", async () => {
    const hub = new Hub();
    const c = counter();
    c.hold = true;
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    expect(await until(() => c.ran === 1)).toBe(true);
    hub.push({ type: "cancel", commandId: "a" });
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(c.aborted).toBe(1);
    expect(hub.results[0]).toMatchObject({ commandId: "a", ok: false, output: { said: "Cancelled.", data: { cancelled: true } } });
    expect(w.history[0]).toMatchObject({ outcome: "cancelled" });
  });
  test("a cancel that arrives BEFORE its command means the command never starts", async () => {
    const hub = new Hub();
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push({ type: "cancel", commandId: "a" });
    await new Promise((r) => setTimeout(r, 60));
    hub.push(cmdItem(wire("a", "echo")));
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(c.ran).toBe(0);
    expect(hub.results[0].output).toMatchObject({ ok: false, data: { cancelled: true } });
  });
  test("a step that finished and was checked just before the cancel landed is reported as done, not hidden", async () => {
    const hub = new Hub();
    let abortSeen = false;
    const finishing: Executor = async (_a, ctx) => {
      await new Promise((r) => setTimeout(r, 30));
      abortSeen = ctx.signal.aborted;
      return { ok: true, said: "Opened.", verified: true, evidence: "window appeared" };
    };
    const w = worker(hub, { executors: { echo: finishing } }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    await until(() => w.status().busy);
    hub.push({ type: "cancel", commandId: "a" });
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(abortSeen).toBe(true);
    expect(hub.results[0]).toMatchObject({ ok: true, output: { verified: true } });
  });
});

describe("observe: the hub asks what happened; the answer comes from the ledger, never from a rerun", () => {
  test("done (with the result), running, unknown", async () => {
    const hub = new Hub();
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    await until(() => hub.results.length === 1);
    hub.push({ type: "observe", commandId: "a", commandKey: "job1/s-a" });
    hub.push({ type: "observe", commandId: "zzz", commandKey: "job1/never" });
    expect(await until(() => hub.observations.length === 2)).toBe(true);
    expect(hub.observations[0]).toMatchObject({ commandId: "a", observation: { state: "done", ok: true, output: { said: "Done.", verified: true } } });
    expect(hub.observations[1]).toEqual({ commandId: "zzz", observation: { state: "unknown" } });
    expect(c.ran).toBe(1);

    const c2 = counter();
    c2.hold = true;
    const hub2 = new Hub();
    const w2 = worker(hub2, { executors: ex(c2) }).start();
    await w2.waitOnline();
    hub2.push(cmdItem(wire("r", "echo")));
    await until(() => c2.ran === 1);
    hub2.push({ type: "observe", commandId: "r", commandKey: "job1/s-r" });
    expect(await until(() => hub2.observations.length === 1)).toBe(true);
    expect(hub2.observations[0].observation).toEqual({ state: "running" });
    c2.release?.();
    void w;
  });
});

describe("a lost result is not lost", () => {
  test("the result POST dropped: kept in the ledger and re-sent on the next good heartbeat, without re-running the action", async () => {
    const hub = new Hub();
    hub.dropResults = 1;
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    expect(await until(() => hub.results.length === 1, 3_000)).toBe(true);
    expect(c.ran).toBe(1);
    expect(hub.results[0]).toMatchObject({ commandId: "a", ok: true });
  });
  test("the hub already settled it (409): the report is marked taken and not sent again", async () => {
    const hub = new Hub();
    hub.resultStatus = 409;
    const c = counter();
    const w = worker(hub, { executors: ex(c) }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    await until(() => hub.results.length === 1);
    await new Promise((r) => setTimeout(r, 120));
    expect(hub.results).toHaveLength(1);
    expect(c.ran).toBe(1);
  });
});

describe("heartbeat: version, capabilities, interactive desktop", () => {
  test("every heartbeat reports the worker's own version, its capabilities and whether the desktop is available", async () => {
    const hub = new Hub();
    const w = worker(hub, { executors: { echo: counter().run, "app.open": counter().run }, interactive: async () => true }).start();
    await w.waitOnline();
    expect(await until(() => hub.beats.length >= 1)).toBe(true);
    expect(hub.beats[0]).toMatchObject({ version: COMPANION_VERSION, capabilities: ["app.open", "echo"], interactive: true });
    expect(w.status()).toMatchObject({ version: COMPANION_VERSION, capabilities: ["app.open", "echo"] });
  });
  test("a locked PC reports interactive:false, refuses desktop executors honestly, and still runs the ones that need no desktop", async () => {
    const hub = new Hub();
    const desk = counter();
    const other = counter();
    const w = worker(hub, { executors: { "app.open": desk.run, echo: other.run }, interactive: async () => false }).start();
    await w.waitOnline();
    await until(() => hub.beats.length >= 1);
    expect(hub.beats[0].interactive).toBe(false);
    hub.push(cmdItem(wire("a", "app.open")));
    hub.push(cmdItem(wire("b", "echo")));
    expect(await until(() => hub.results.length === 2)).toBe(true);
    expect(desk.ran).toBe(0);
    expect(other.ran).toBe(1);
    const a = hub.results.find((r) => r.commandId === "a")!;
    expect(a).toMatchObject({ ok: false, output: { verified: false, data: { refused: true, locked: true } } });
    expect(a.error).toContain("locked");
  });
  test("can't tell (null) is reported as null, and does not block anything", async () => {
    const hub = new Hub();
    const c = counter();
    const w = worker(hub, { executors: ex(c), interactive: async () => null }).start();
    await w.waitOnline();
    await until(() => hub.beats.length >= 1);
    expect(hub.beats[0].interactive).toBeNull();
    hub.push(cmdItem(wire("a", "app.open")));
    await until(() => hub.results.length === 1);
    expect(c.ran).toBe(1);
  });
  test("desktopInteractive: LogonUI running = locked, absent = unlocked, unreadable or not Windows = null", async () => {
    expect(await desktopInteractive("win32", async () => '"LogonUI.exe","1234","Console","1","20,000 K"')).toBe(false);
    expect(await desktopInteractive("win32", async () => "INFO: No tasks are running which match the specified criteria.")).toBe(true);
    expect(await desktopInteractive("win32", async () => null)).toBeNull();
    expect(await desktopInteractive("linux", async () => "anything")).toBeNull();
  });
});

describe("progress: a long executor's sub-steps reach the hub in order, then the result", () => {
  test("ctx.progress posts each step with the command id; the result follows them", async () => {
    const hub = new Hub();
    const long: Executor = async (_a, ctx) => {
      ctx.progress?.({ intent: "act: one", executor: "uia", outcome: "ok", ms: 1 });
      ctx.progress?.({ intent: "check: two", executor: "uia", outcome: "ok", ms: 2, verification: { method: "m", ok: true } });
      return { ok: true, said: "Done.", verified: true };
    };
    const w = worker(hub, { executors: { echo: long } }).start();
    await w.waitOnline();
    hub.push(cmdItem(wire("a", "echo")));
    expect(await until(() => hub.results.length === 1)).toBe(true);
    expect(hub.progress.map((p) => [p.commandId, p.step.intent])).toEqual([["a", "act: one"], ["a", "check: two"]]);
  });
});
