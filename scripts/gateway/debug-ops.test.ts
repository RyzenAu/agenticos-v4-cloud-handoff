import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageTokenFor, type Principal } from "../identity/principal";
import { RECORD_IDS_HEADER } from "./config";
import { createGatewayOps } from "./hub-ops";
import { DEBUG_SET, OPERATE_SET, permitted } from "./policy";

/**
 * r12 debugging: ops.logs and ops.restart on the hub's /__gateway routes, over real HTTP, with SYNTHETIC log fixtures, a
 * spy in place of process exit and a spy service runner (nothing is ever restarted or executed). The principal is injected
 * (the gate and assertion are proven in hub.test.ts).
 */

const TOKEN = "debug-test-internal-token";
const root = mkdtempSync(join(tmpdir(), "gw-debug-"));
const dir = join(root, "data", "gateway");
const logs = join(root, "logs");
mkdirSync(dir, { recursive: true });
mkdirSync(logs, { recursive: true });

const FAKE_TOKEN = "sk-ant-api03-FAKEfakeFAKE0123456789abcdef";
const ENV_MARKER = "HUB-ENV-MARKER-never-served";
writeFileSync(join(logs, "hub-stdout.log"), ["boot line 1", "  VITE ready in 900 ms", `calling provider with ${FAKE_TOKEN}`, "OPENROUTER_API_KEY=abc123fakevalue", "my_auth: hunter2", "SESSION_TOKEN='quoted value here'", "last line"].join("\r\n") + "\r\n");
writeFileSync(join(logs, "hub-stderr.log"), Array.from({ length: 900 }, (_, i) => `stderr ${i}`).join("\n") + "\n");
writeFileSync(join(logs, "hub-stdout.log.1"), "the run before the restart\n");
writeFileSync(join(logs, "mu-hub-supervisor.log"), "supervisor started\nFAILURE: hub exited (code 75)\n");
writeFileSync(join(logs, "release-20261004T101500.json"), '{"time":"old"}');
writeFileSync(join(logs, "release-20261005T090000.log"), "newest release log\n");
// Never readable, whatever is asked:
writeFileSync(join(logs, "hub.env"), `OPENROUTER_API_KEY=${ENV_MARKER}\n`);
writeFileSync(join(logs, ".env"), `${ENV_MARKER}\n`);
writeFileSync(join(logs, "release-20261006T000000.env"), `${ENV_MARKER}\n`);
writeFileSync(join(root, "hub.env"), `${ENV_MARKER}\n`);

const env: Record<string, string | undefined> = { MU_DATA_DIR: join(root, "data"), MU_LOG_DIR: logs, MU_HUB_SUPERVISED: "1" };
const events: string[] = [];
const ran: string[] = [];

function server(startedAt?: number) {
  const ops = createGatewayOps({
    root,
    internalToken: () => TOKEN,
    dir,
    env: () => env,
    readOnly: () => false,
    health: async () => ({ ok: true, status: "ok", components: { hub: { status: "ok", detail: "answering" } } }),
    debug: {
      exitHub: (code) => events.push(`exit:${code}`),
      hubExitDelayMs: 30,
      runService: async (service) => (ran.push(service), { ok: true, detail: `restarted ${service} token=SHOULD-BE-REDACTED` }),
      ...(startedAt ? { startedAt } : {}),
    },
  });
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    const who = String(req.headers["x-test-who"] ?? "");
    const [, identity, caps] = who.split(":");
    const principal = { personId: "dot", via: "gateway", actor: "process", sessionId: `gw:sess-${identity}`, gatewayIdentityId: identity, capabilities: ["view", ...(caps ?? "").split(",").filter(Boolean)], delegatedBy: "usman" } as unknown as Principal;
    await ops.handle(req, res, { path: url.pathname.replace(/^\/__gateway/, ""), url, principal });
  });
}

let a: Server;
let b: Server;
const baseOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
beforeAll(async () => {
  a = server();
  b = server(Date.now() + 60_000); // "the restarted hub": a process that started after every request in this file
  await Promise.all([new Promise<void>((r) => a.listen(0, "127.0.0.1", r)), new Promise<void>((r) => b.listen(0, "127.0.0.1", r))]);
});
afterAll(() => {
  a.close();
  b.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(identity: string, caps: string[], method: string, path: string, body?: unknown, s: Server = a) {
  const headers: Record<string, string> = { "x-test-who": `dot:${identity}:${caps.join(",")}` };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-claude-os-token"] = pageTokenFor({ personId: "dot" as never, via: "gateway" as never }, TOKEN);
  }
  const res = await fetch(`${baseOf(s)}/__gateway${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any, headers: res.headers };
}

describe("policy", () => {
  test("grant debug is ops.logs + ops.restart, and grant operate holds neither", () => {
    expect([...DEBUG_SET]).toEqual(["ops.logs", "ops.restart"]);
    for (const cap of DEBUG_SET) expect(OPERATE_SET.includes(cap)).toBe(false);
    expect(permitted("GET", "/__gateway/diagnostics/logs", ["view", ...OPERATE_SET]).ok).toBe(false);
    expect(permitted("POST", "/__gateway/ops/restart", ["view", ...OPERATE_SET]).ok).toBe(false);
    expect(permitted("GET", "/__gateway/diagnostics/logs", ["view", "ops.logs"]).ok).toBe(true);
    expect(permitted("POST", "/__gateway/ops/restart", ["view", "ops.restart"]).ok).toBe(true);
    expect(permitted("GET", "/__gateway/ops/restart/rs-abc123-abcdef", ["view", "ops.restart"]).ok).toBe(true);
    expect(permitted("DELETE", "/__gateway/ops/restart", ["view", ...DEBUG_SET]).ok).toBe(false);
  });
});

describe("ops.logs", () => {
  test("allowed with the capability: the hub's stdout and stderr, tailed", async () => {
    const r = await call("id-logs", ["ops.logs"], "GET", "/diagnostics/logs?source=hub&tail=3");
    expect(r.status).toBe(200);
    const [out, err] = r.json.files;
    expect(out.name).toBe("hub-stdout.log");
    expect(out.lines.at(-1)).toBe("last line");
    expect(err.lines).toEqual(["stderr 897", "stderr 898", "stderr 899"]);
    const sup = await call("id-logs", ["ops.logs"], "GET", "/diagnostics/logs?source=supervisor");
    expect(sup.json.files[0].lines).toContain("FAILURE: hub exited (code 75)");
    const prev = await call("id-logs", ["ops.logs"], "GET", "/diagnostics/logs?source=hub&previous=1");
    expect(prev.json.files.map((f: { name: string }) => f.name)).toEqual(["hub-stdout.log.1"]);
    const rel = await call("id-logs", ["ops.logs"], "GET", "/diagnostics/logs?source=release");
    expect(rel.json.files.map((f: { name: string }) => f.name)).toEqual(["release-20261005T090000.log"]);
  });

  test("refused without it (operate's ops.read is not enough)", async () => {
    const r = await call("id-logs", [...OPERATE_SET], "GET", "/diagnostics/logs?source=hub");
    expect(r.status).toBe(403);
    expect(r.json.needs).toBe("ops.logs");
    expect(r.text).not.toContain("boot line");
  });

  test("tail is capped at 500 lines", async () => {
    const r = await call("id-logs", ["ops.logs"], "GET", "/diagnostics/logs?source=hub&tail=100000");
    expect(r.json.tail).toBe(500);
    expect(r.json.files[1].lines.length).toBe(500);
    expect(r.json.files[1].truncated).toBe(true);
  });

  test("redaction strips a fake token and NAME=value secrets", async () => {
    const r = await call("id-logs", ["ops.logs"], "GET", "/diagnostics/logs?source=hub&tail=50");
    const lines: string[] = r.json.files[0].lines;
    expect(r.text).not.toContain(FAKE_TOKEN);
    expect(r.text).not.toContain("abc123fakevalue");
    expect(r.text).not.toContain("hunter2");
    expect(r.text).not.toContain("quoted value here");
    expect(lines).toContain("OPENROUTER_API_KEY=[redacted]");
    expect(lines).toContain("  VITE ready in 900 ms");
  });

  test("no path escape: no path parameter, no unknown source, and hub.env or any .env is never served", async () => {
    for (const q of ["source=../hub.env", "source=hub.env", "source=.env", "source=hub&path=../hub.env", "source=hub&file=hub.env", "source=..%2Fhub.env", "source=constructor", "source=__proto__", ""]) {
      const r = await call("id-logs", ["ops.logs"], "GET", `/diagnostics/logs?${q}`);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain(ENV_MARKER);
    }
    for (const source of ["hub", "supervisor", "gateway", "release", "health"]) {
      const r = await call("id-logs", ["ops.logs"], "GET", `/diagnostics/logs?source=${source}&tail=500&previous=1`);
      expect(r.text).not.toContain(ENV_MARKER);
      const r2 = await call("id-logs", ["ops.logs"], "GET", `/diagnostics/logs?source=${source}&tail=500`);
      expect(r2.text).not.toContain(ENV_MARKER);
    }
  });
});

describe("ops.restart", () => {
  test("refused without the capability", async () => {
    const r = await call("id-none", [...OPERATE_SET, "ops.logs"], "POST", "/ops/restart", { service: "hermes" });
    expect(r.status).toBe(403);
    expect(r.json.needs).toBe("ops.restart");
    expect(ran).toEqual([]);
  });

  test("only the three services, and nothing else in the body", async () => {
    for (const body of [{ service: "cmd.exe" }, { service: "hub", command: "whoami" }, {}, { service: ["hub"] }]) {
      const r = await call("id-bad", ["ops.restart"], "POST", "/ops/restart", body);
      expect(r.status).toBe(400);
    }
    expect(events).toEqual([]);
    expect(ran).toEqual([]);
  });

  test("the hub restart replies 202 BEFORE the hub exits, and the poll reports health once the hub is back", async () => {
    events.length = 0;
    const r = await call("id-hub", ["ops.restart"], "POST", "/ops/restart", { service: "hub" });
    expect(r.status).toBe(202);
    expect(events).toEqual([]); // the reply is here and the hub has not exited yet
    expect(r.json.follow).toBe(`/__gateway/ops/restart/${r.json.id}`);
    expect(r.headers.get(RECORD_IDS_HEADER)).toBe(r.json.id); // the gateway's audit records it
    await new Promise((res) => setTimeout(res, 150));
    expect(events).toEqual(["exit:75"]);
    // Still the old process: restarting. The restarted one (started after the request): done, with health.
    const before = await call("id-hub", ["ops.restart"], "GET", `/ops/restart/${r.json.id}`);
    expect(before.json.restart.state).toBe("restarting");
    const after = await call("id-hub", ["ops.restart"], "GET", `/ops/restart/${r.json.id}`, undefined, b);
    expect(after.status).toBe(200);
    expect(after.json.restart.state).toBe("done");
    expect(after.json.health.ok).toBe(true);
    // Another identity cannot read it.
    expect((await call("id-other", ["ops.restart"], "GET", `/ops/restart/${r.json.id}`, undefined, b)).status).toBe(404);
  });

  test("an unsupervised hub is never restarted", async () => {
    events.length = 0;
    env.MU_HUB_SUPERVISED = undefined;
    try {
      const r = await call("id-unsup", ["ops.restart"], "POST", "/ops/restart", { service: "hub" });
      expect(r.status).toBe(409);
    } finally {
      env.MU_HUB_SUPERVISED = "1";
    }
    await new Promise((res) => setTimeout(res, 80));
    expect(events).toEqual([]);
  });

  test("hermes and searxng run their fixed action; the result is redacted", async () => {
    ran.length = 0;
    const r = await call("id-svc", ["ops.restart"], "POST", "/ops/restart", { service: "searxng" });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 50));
    expect(ran).toEqual(["searxng"]);
    const s = await call("id-svc", ["ops.restart"], "GET", `/ops/restart/${r.json.id}`);
    expect(s.json.restart.state).toBe("done");
    expect(s.text).not.toContain("SHOULD-BE-REDACTED");
  });

  test("rate limit: 3 an hour per identity (it survives a hub restart: the count is on disk), and every restart is in the hub's action log", async () => {
    ran.length = 0;
    for (let i = 0; i < 3; i++) expect((await call("id-rate", ["ops.restart"], "POST", "/ops/restart", { service: "hermes" })).status).toBe(202);
    const fourth = await call("id-rate", ["ops.restart"], "POST", "/ops/restart", { service: "hermes" });
    expect(fourth.status).toBe(429);
    expect(fourth.json.retryAfter).toBeGreaterThan(0);
    // The "restarted hub" (a new process, same folder) still counts them.
    expect((await call("id-rate", ["ops.restart"], "POST", "/ops/restart", { service: "hub" }, b)).status).toBe(429);
    // Another identity has its own allowance.
    expect((await call("id-rate-2", ["ops.restart"], "POST", "/ops/restart", { service: "hermes" })).status).toBe(202);
    await new Promise((res) => setTimeout(res, 50));
    expect(ran.length).toBe(4);
    const log = await call("id-rate", ["ops.read"], "GET", "/diagnostics/actions?tail=500");
    const restarts = (log.json.actions as Array<{ action: string; outcome: string; status: number }>).filter((x) => x.action.startsWith("ops.restart"));
    expect(restarts.filter((x) => x.outcome === "done").length).toBeGreaterThanOrEqual(6);
    expect(restarts.some((x) => x.status === 429 && x.outcome === "refused")).toBe(true);
  });
});
