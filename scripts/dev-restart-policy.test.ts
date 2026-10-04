import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devRestartPolicy, inFlightWork } from "./dev-restart-policy";

const dirs: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "restart-policy-"));
  dirs.push(root);
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  return { root, liveRunsFile: join(root, "claude-live-runs.json") };
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Mw = (req: any, res: any, next: () => void) => void;
function fakeServer() {
  const middlewares: Mw[] = [];
  const restarts: Array<boolean | undefined> = [];
  const server: any = {
    middlewares: { use: (fn: Mw) => middlewares.push(fn) },
    httpServer: { once: () => undefined },
    restart: async (force?: boolean) => void restarts.push(force),
  };
  return { server, middlewares, restarts };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("inFlightWork", () => {
  test("is empty when nothing is running", () => {
    const f = fixture();
    expect(inFlightWork({ root: f.root, openMutations: 0, liveRunsFile: f.liveRunsFile })).toEqual([]);
  });
  test("counts open mutations, this process's chat turns and active agent tasks only", () => {
    const f = fixture();
    writeFileSync(f.liveRunsFile, JSON.stringify([{ chatId: "a", pid: 42 }, { chatId: "b", pid: 7 }]));
    writeFileSync(
      join(f.root, ".operator-data", "agent-jobs.json"),
      JSON.stringify({ version: 1, jobs: [{ id: "j", runs: [{ status: "running" }, { status: "completed" }, { status: "needs_input" }] }] }),
    );
    expect(inFlightWork({ root: f.root, openMutations: 1, pid: 42, liveRunsFile: f.liveRunsFile })).toEqual([
      "1 request in progress",
      "1 chat turn running",
      "2 agent tasks active",
    ]);
  });
  test("never blocks on unreadable files", () => {
    const f = fixture();
    writeFileSync(f.liveRunsFile, "{not json");
    writeFileSync(join(f.root, ".operator-data", "agent-jobs.json"), "nope");
    expect(inFlightWork({ root: f.root, openMutations: 0, liveRunsFile: f.liveRunsFile })).toEqual([]);
  });
});

describe("devRestartPolicy", () => {
  // The quiet window and defer cap are measured on fake timers (which also drive Date.now, the
  // policy's default clock). With real 15 ms sleeps a loaded machine could stretch one gap past the
  // 40 ms quiet window, or delay the first 10 ms check past the 60 ms cap, and fail spuriously.
  test("coalesces a burst of restart requests into one restart after the quiet window", async () => {
    const f = fixture();
    const { server, restarts } = fakeServer();
    jest.useFakeTimers();
    try {
      const plugin: any = devRestartPolicy({ root: f.root, quietMs: 40, pollMs: 10, liveRunsFile: f.liveRunsFile, env: {}, log: () => {} });
      plugin.configureServer(server);
      const a = server.restart();
      jest.advanceTimersByTime(15);
      const b = server.restart();
      jest.advanceTimersByTime(15);
      const c = server.restart(true);
      expect(restarts).toEqual([]);
      jest.advanceTimersByTime(40);
      await Promise.all([a, b, c]);
      expect(restarts).toEqual([true]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("waits while a mutating /__* request is open, then restarts", async () => {
    const f = fixture();
    const { server, middlewares, restarts } = fakeServer();
    const plugin: any = devRestartPolicy({ root: f.root, quietMs: 10, pollMs: 10, liveRunsFile: f.liveRunsFile, env: {}, log: () => {} });
    plugin.configureServer(server);
    let onClose: () => void = () => {};
    const res = { once: (_: string, fn: () => void) => (onClose = fn), setHeader() {}, end() {} };
    let passed = false;
    middlewares[0]({ url: "/__hermes_chat", method: "POST" }, res, () => (passed = true));
    expect(passed).toBe(true);
    const done = server.restart();
    await sleep(60);
    expect(restarts).toEqual([]);
    onClose();
    await done;
    expect(restarts.length).toBe(1);
  });

  test("gives up waiting after the cap", async () => {
    const f = fixture();
    writeFileSync(f.liveRunsFile, JSON.stringify([{ chatId: "a", pid: process.pid }]));
    const { server, restarts } = fakeServer();
    const lines: string[] = [];
    jest.useFakeTimers();
    try {
      const plugin: any = devRestartPolicy({ root: f.root, quietMs: 10, pollMs: 10, maxDeferMs: 60, liveRunsFile: f.liveRunsFile, env: {}, log: (l) => lines.push(l) });
      plugin.configureServer(server);
      const done = server.restart();
      jest.advanceTimersByTime(60);
      await done;
    } finally {
      jest.useRealTimers();
    }
    expect(restarts.length).toBe(1);
    expect(lines.some((l) => l.includes("waiting (1 chat turn running)"))).toBe(true);
    expect(lines.some((l) => l.includes("despite"))).toBe(true);
  });

  test("reports status on GET /__dev_restart and ignores reads for busy tracking", async () => {
    const f = fixture();
    const { server, middlewares } = fakeServer();
    const plugin: any = devRestartPolicy({ root: f.root, quietMs: 10_000, liveRunsFile: f.liveRunsFile, env: {}, log: () => {} });
    plugin.configureServer(server);
    let body = "";
    const local = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:8081" } };
    middlewares[0]({ url: "/__dev_restart", method: "GET", ...local }, { setHeader() {}, end: (b: string) => (body = b) }, () => {});
    expect(JSON.parse(body)).toMatchObject({ pending: false, waitingFor: [] });
    // Audit A-L7: anything that is not this PC's own loopback is refused.
    for (const req of [
      { socket: { remoteAddress: "100.64.0.7" }, headers: { host: "127.0.0.1:8081" } },
      { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "nebula-pc.tailnet.ts.net:8443" } },
      { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:8081", "tailscale-user-login": "someone@example.invalid" } },
      { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "evil.example" } },
      { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost:8081", "sec-fetch-site": "cross-site" } },
    ]) {
      const res: any = { statusCode: 200, setHeader() {}, end: (b: string) => (body = b) };
      middlewares[0]({ url: "/__dev_restart", method: "GET", ...req }, res, () => {});
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(body)).toEqual({ error: "Local access only" });
    }
    let once = false;
    middlewares[0]({ url: "/__leads", method: "GET" }, { once: () => (once = true) }, () => {});
    expect(once).toBe(false);
  });

  test("config adds warmup, and disables watching only for AGENTIC_OS_NO_WATCH=1", () => {
    const plain: any = devRestartPolicy({ root: "/x", env: {} }).config;
    expect(plain().server.warmup.clientFiles).toContain("./src/routes/__root.tsx");
    expect("watch" in plain().server).toBe(false);
    const quiet: any = devRestartPolicy({ root: "/x", env: { AGENTIC_OS_NO_WATCH: "1" } }).config;
    expect(quiet().server.watch).toBeNull();
  });
});

describe("Track 3: coding jobs defer a restart", () => {
  test("a running coding job in this process is in-flight work", () => {
    const key = Symbol.for("mu.coding.runtime.v1");
    const g = globalThis as Record<symbol, unknown>;
    const before = g[key];
    g[key] = new Map([["root", { orch: { active: () => ["job-1"] } }]]);
    try {
      expect(inFlightWork({ root: "D:/nowhere", openMutations: 0, liveRunsFile: "D:/nowhere/none.json" })).toContain("1 coding job running");
    } finally {
      g[key] = before;
    }
  });
});
