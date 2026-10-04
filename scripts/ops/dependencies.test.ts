import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHealth } from "../cloud/health";
import { createDependencyMonitor, realChecks, type Alert, type DependencyCheck } from "./dependencies";

function fake() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const alerts: Alert[] = [];
  const base = {
    now: () => t,
    sleep: async (ms: number) => void sleeps.push(ms),
    setTimer: (fn: () => void, ms: number) => (timers.set(++id, { at: t + ms, fn }), id),
    clearTimer: (i: unknown) => void timers.delete(i as number),
    onAlert: (a: Alert) => void alerts.push(a),
  };
  const fire = async () => {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return null;
    t = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return t;
  };
  return { base, sleeps, alerts, timers, fire, advance: (ms: number) => (t += ms) };
}

const check = (probe: DependencyCheck["probe"], id: DependencyCheck["id"] = "searxng"): DependencyCheck => ({ id, label: "Search (SearXNG)", recovery: "Start it.", probe });

describe("startup health check", () => {
  test("a dependency that answers at once is healthy: one try, no alert, re-checked every 2 minutes", async () => {
    const f = fake();
    const m = createDependencyMonitor({ ...f.base, checks: [check(async () => ({ ok: true, detail: "answering" }))] });
    const [d] = await m.startup();
    expect(d).toMatchObject({ state: "healthy", attempts: 1, failures: 0, alert: null });
    expect(f.alerts).toEqual([]);
    expect(f.sleeps).toEqual([]);
    expect(d.nextCheckInMs).toBe(120_000);
    m.stop();
  });

  test("retries are bounded: 3 tries with 1 s and 2 s gaps, then unavailable with ONE alert and a recovery hint", async () => {
    const f = fake();
    let probes = 0;
    const m = createDependencyMonitor({ ...f.base, checks: [check(async () => (probes++, { ok: false, detail: "not reachable (connection refused)" }))] });
    const [d] = await m.startup();
    expect(probes).toBe(3);
    expect(f.sleeps).toEqual([1_000, 2_000]);
    expect(d).toMatchObject({ state: "unavailable", attempts: 3, failures: 1 });
    expect(d.alert).toBe("Search (SearXNG) is unavailable: not reachable (connection refused). Start it.");
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0].level).toBe("alert");
    m.stop();
  });

  test("it comes up on the second try: healthy, no alert", async () => {
    const f = fake();
    let n = 0;
    const m = createDependencyMonitor({ ...f.base, checks: [check(async () => (++n < 2 ? { ok: false, detail: "starting" } : { ok: true, detail: "answering" }))] });
    const [d] = await m.startup();
    expect(d).toMatchObject({ state: "healthy", attempts: 2 });
    expect(f.alerts).toEqual([]);
    m.stop();
  });

  test("a probe that throws or hangs is a failed probe with its reason, never an exception out of the monitor", async () => {
    const f = fake();
    const throwing = createDependencyMonitor({ ...f.base, startupAttempts: 1, checks: [check(async () => { throw new Error("boom: ECONNRESET"); })] });
    expect((await throwing.startup())[0]).toMatchObject({ state: "unavailable", detail: "boom: ECONNRESET" });
    throwing.stop();
    const hanging = createDependencyMonitor({ ...f.base, startupAttempts: 1, probeTimeoutMs: 30, checks: [check(() => new Promise(() => undefined))] });
    expect((await hanging.startup())[0]).toMatchObject({ state: "unavailable", detail: "no answer within 0 s" });
    hanging.stop();
  });
});

describe("monitoring after startup: bounded, one line per change, recovery reported", () => {
  test("an unavailable dependency is re-checked at 15 s, 30 s, 1 min, 2 min, then every 5 minutes (never faster, never a loop), with no repeat alerts", async () => {
    const f = fake();
    let up = false;
    const m = createDependencyMonitor({ ...f.base, startupAttempts: 1, checks: [check(async () => (up ? { ok: true, detail: "answering" } : { ok: false, detail: "down" }))] });
    await m.startup();
    const gaps: number[] = [];
    let last = f.base.now();
    for (let i = 0; i < 7; i++) {
      const at = await f.fire();
      gaps.push((at ?? 0) - last);
      last = at ?? last;
    }
    expect(gaps).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(f.alerts).toHaveLength(1); // still the first alert only
    expect(m.snapshot()[0].failures).toBe(8);
    up = true;
    await f.fire();
    expect(m.snapshot()[0]).toMatchObject({ state: "healthy", failures: 0, alert: null });
    expect(f.alerts.map((a) => a.level)).toEqual(["alert", "recovered"]);
    expect(m.snapshot()[0].nextCheckInMs).toBe(120_000);
    m.stop();
  });

  test("stop clears every timer and nothing is checked afterwards", async () => {
    const f = fake();
    let probes = 0;
    const m = createDependencyMonitor({ ...f.base, startupAttempts: 1, checks: [check(async () => (probes++, { ok: true, detail: "ok" }))] });
    await m.startup();
    expect(f.timers.size).toBe(1);
    m.stop();
    expect(f.timers.size).toBe(0);
    expect(await f.fire()).toBeNull();
    expect(probes).toBe(1);
    expect(m.snapshot()[0].nextCheckInMs).toBeNull();
  });

  test("a healthy dependency that goes down alerts once; checkNow re-probes at once", async () => {
    const f = fake();
    let up = true;
    const m = createDependencyMonitor({ ...f.base, startupAttempts: 1, checks: [check(async () => (up ? { ok: true, detail: "ok" } : { ok: false, detail: "gone" }))] });
    await m.startup();
    up = false;
    const now = await m.checkNow("searxng");
    expect(now).toMatchObject({ state: "unavailable", detail: "gone" });
    await m.checkNow("searxng");
    expect(f.alerts).toHaveLength(1);
    m.stop();
  });
});

describe("the real probes", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "r6-health-"));
  const refused = (async () => { throw new TypeError("ECONNREFUSED"); }) as unknown as typeof fetch;

  test("SearXNG refused -> unavailable; answering -> healthy; Hindsight off -> healthy by configuration", async () => {
    const down = realChecks({ fetchImpl: refused, hindsightUrl: "off", companions: () => ({ online: 0, total: 0 }), modelHealth: () => ({ states: [] }) });
    const up = realChecks({ fetchImpl: (async () => new Response("OK")) as unknown as typeof fetch, hindsightUrl: "http://127.0.0.1:8888", companions: () => ({ online: 1, total: 1 }), modelHealth: () => ({ states: ["ok", "down"] }) });
    const run = (cs: DependencyCheck[], id: string) => cs.find((c) => c.id === id)!.probe(new AbortController().signal);
    expect(await run(down, "searxng")).toMatchObject({ ok: false, detail: "not reachable (connection refused)" });
    expect(await run(down, "hindsight")).toMatchObject({ ok: true });
    expect(await run(up, "searxng")).toMatchObject({ ok: true });
    expect(await run(up, "hindsight")).toMatchObject({ ok: true });
    const hs500 = realChecks({ fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch, hindsightUrl: "http://127.0.0.1:8888", companions: () => ({ online: 0, total: 0 }), modelHealth: () => ({ states: [] }) });
    expect(await run(hs500, "hindsight")).toMatchObject({ ok: false, detail: "answered HTTP 500" });
  });

  test("companions: none paired is healthy; paired but none online is unavailable; model routes: all down is unavailable", async () => {
    const run = (cs: DependencyCheck[], id: string) => cs.find((c) => c.id === id)!.probe(new AbortController().signal);
    const mk = (online: number, total: number, states: string[]) => realChecks({ fetchImpl: refused, hindsightUrl: "off", companions: () => ({ online, total }), modelHealth: () => ({ states }) });
    expect(await run(mk(0, 0, []), "companion")).toMatchObject({ ok: true, detail: "none paired" });
    expect(await run(mk(0, 2, []), "companion")).toMatchObject({ ok: false, detail: "2 paired, none online (asleep or offline; not a hub fault)" });
    expect(await run(mk(1, 2, []), "companion")).toMatchObject({ ok: true });
    expect(await run(mk(0, 0, []), "model_routes")).toMatchObject({ ok: true });
    expect(await run(mk(0, 0, ["down", "exhausted", "limited"]), "model_routes")).toMatchObject({ ok: false });
    expect(await run(mk(0, 0, ["down", "unknown"]), "model_routes")).toMatchObject({ ok: true });
  });

  test("/__health carries the dependency report, lists an unavailable one as degraded with its recovery, and stays ok without a monitor", async () => {
    const f = fake();
    const m = createDependencyMonitor({ ...f.base, startupAttempts: 1, checks: [check(async () => ({ ok: false, detail: "not reachable (connection refused)" }))] });
    await m.startup();
    const root = dir();
    const common = { root, env: { MU_DATA_DIR: join(root, "data"), HINDSIGHT_URL: "off" }, jobs: () => ({ owner: true }), companions: () => ({ online: 0, total: 0 }), version: async () => ({ version: "t", gitSha: "x", dirty: false, buildTime: "" }) };
    const withMonitor = await collectHealth({ ...common, dependencies: () => m.snapshot() });
    expect(withMonitor.status).toBe("degraded");
    expect(withMonitor.dependencies[0]).toMatchObject({ id: "searxng", state: "unavailable" });
    expect(withMonitor.failed.find((x) => x.component === "searxng")).toMatchObject({ recovery: "Start it." });
    expect(withMonitor.failed.find((x) => x.component === "searxng")!.detail).toContain("is unavailable");
    const quiet = await collectHealth(common);
    expect(quiet.dependencies).toEqual([]);
    expect(quiet.status).toBe("ok");
    m.stop();
  });

  test("a sleeping personal PC is offline, not a hub failure: status stays ok and nothing is listed as failed, while the dependency still reports it", async () => {
    const f = fake();
    const m = createDependencyMonitor({ ...f.base, startupAttempts: 1, checks: [{ id: "companion", label: "Companions", recovery: "Wake the PC.", probe: async () => ({ ok: false, detail: "1 paired, none online (asleep or offline; not a hub fault)" }) }] });
    await m.startup();
    const root = dir();
    const r = await collectHealth({ root, env: { MU_DATA_DIR: join(root, "data"), HINDSIGHT_URL: "off" }, jobs: () => ({ owner: true }), companions: () => ({ online: 0, total: 1 }), version: async () => ({ version: "t", gitSha: "x", dirty: false, buildTime: "" }), dependencies: () => m.snapshot() });
    expect(r.components.companions.status).toBe("ok");
    expect(r.status).toBe("ok");
    expect(r.failed).toEqual([]);
    expect(r.dependencies[0]).toMatchObject({ id: "companion", state: "unavailable" });
    m.stop();
  });
});
