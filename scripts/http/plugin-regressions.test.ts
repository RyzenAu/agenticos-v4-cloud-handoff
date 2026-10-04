import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { applySettingsPatch } from "../ai-usage/snapshot";
import { createAutomationsApi } from "../automations";
import { businessWorkspace } from "../business-workspace";
import { under } from "../identity/gate";
import { controlReceiptRoute } from "../jarvis-execution/routes";
import { createLeadsApi } from "../leads/api";
import { openCrm, upsertLead } from "../leads/crm";
import { validateGreeting, writeJarvisSettings } from "../jarvis-settings";
import { meetingApi } from "../meeting-mode/api";
import { memoryMiddleware } from "../memory/plugin";
import { modelFleetReceiptRoute } from "../model-fleet/receipt-sink";
import { operatorPlugin } from "../operator-plugin";

/**
 * Audit F5 regressions outside vite.config.ts: the /__operator API (through the real plugin, on a
 * temp workspace), and the modules behind it. Synthetic data only; nothing is sent or spawned.
 */

/** While the handlers run: fetch refuses anything not loopback, and the live OS on 8081. */
const realFetch = globalThis.fetch;
function guardNetwork() {
  globalThis.fetch = Object.assign(((input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? ""), "http://127.0.0.1");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port === "8081")
      return Promise.reject(new Error(`test network guard: blocked ${url.origin}`));
    return realFetch(input, init);
  }) as typeof fetch, realFetch);
}

const INTERNAL = "f5-synthetic-internal-token";
let root = "";
let base = "";
let server: Server;
type Fn = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => unknown;
const mounts: Array<{ path: string | null; fn: Fn }> = [];
const fakeServer = {
  middlewares: { use: (a: string | Fn, b?: Fn) => void mounts.push(typeof a === "function" ? { path: null, fn: a } : { path: a, fn: b! }) },
  config: { server: { port: 0 } },
};

function dispatch(req: IncomingMessage, res: ServerResponse) {
  const original = req.url || "/";
  const path = original.split("?")[0];
  let i = 0;
  const next = (): unknown => {
    req.url = original;
    const m = mounts[i++];
    if (!m) {
      res.statusCode = 404;
      return res.end("no route");
    }
    if (m.path === null) return m.fn(req, res, next);
    if (!under(path, m.path)) return next();
    const rest = original.slice(m.path.length);
    req.url = rest.startsWith("/") ? rest : `/${rest}`;
    return m.fn(req, res, next);
  };
  next();
}

async function op(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(`${base}/__operator${path}`, {
      method,
      headers: { "X-Claude-OS-Token": INTERNAL, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  } catch (error) {
    return { status: 0, json: { error: String(error) } };
  }
}

beforeAll(async () => {
  guardNetwork();
  root = mkdtempSync(join(tmpdir(), "s3-f5-op-"));
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  mkdirSync(join(root, "fake-home"), { recursive: true });
  const quiet = process.env.AGENTIC_OS_NO_BACKGROUND;
  process.env.AGENTIC_OS_NO_BACKGROUND = "1";
  try {
    (operatorPlugin({ root, token: INTERNAL, memoryHome: join(root, "fake-home") } as any).configureServer as any)(fakeServer);
  } finally {
    if (quiet === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND;
    else process.env.AGENTIC_OS_NO_BACKGROUND = quiet;
  }
  server = createServer((req, res) => dispatch(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  globalThis.fetch = realFetch;
  Bun.gc(true);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold a SQLite handle */
  }
});

describe("/__operator (P2-3, P3)", () => {
  test("settings with a wrong type or an unknown key are 400, and nothing changes", async () => {
    const before = (await op("GET", "/state")).json?.settings ?? null;
    for (const body of [{ news: "yes" }, { zz: 1 }, { news: true, zz: 1 }, { inboxAccounts: "all" }, { inboxAccounts: { gmail: "no" } }]) {
      const r = await op("POST", "/settings", JSON.stringify(body));
      expect([body, r.status]).toEqual([body, 400]);
    }
    if (before) expect((await op("GET", "/state")).json?.settings).toEqual(before);
    expect((await op("POST", "/settings", JSON.stringify({ news: false }))).status).toBe(200);
  });

  test("a business profile that is not an object, or a non-text field, is 400", async () => {
    for (const body of [{ profile: "x" }, { profile: ["x"] }, { profile: { businessName: 5 } }, { widgets: "all" }]) {
      const r = await op("POST", "/business", JSON.stringify(body));
      expect([body, r.status]).toEqual([body, 400]);
    }
    expect((await op("POST", "/business", JSON.stringify({ profile: { businessName: "Synthetic Co (fictional)" } }))).status).toBe(200);
  });

  test("an oversize body is 413, not 400", async () => {
    const r = await op("POST", "/settings", JSON.stringify({ x: "a".repeat(9 * 1024 * 1024) }));
    expect(r.status).toBe(413);
  });

  test("a DELETE with no body needs no Content-Type", async () => {
    const res = await fetch(`${base}/__operator/skill-drafts/zz-f5-none`, { method: "DELETE", headers: { "X-Claude-OS-Token": INTERNAL } });
    expect(res.status).not.toBe(415);
  });
});

describe("modules behind the API", () => {
  test("P2-3: the greeting and shorthand meanings must be text", () => {
    expect(() => validateGreeting({ x: 1 })).toThrow("text");
    expect(() => validateGreeting(42)).toThrow();
    expect(validateGreeting("  Morning, sir. ")).toBe("Morning, sir.");
    const dir = mkdtempSync(join(tmpdir(), "s3-f5-jarvis-"));
    try {
      expect(() => writeJarvisSettings(dir, { shorthand: { yt: { x: 1 } } })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("P2-3: an unknown packageId is refused on a website-only proposal too (a price document)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s3-f5-leads-"));
    const db = openCrm(join(dir, ".operator-data", "crm.sqlite"));
    try {
      const api = createLeadsApi(dir, { db, hunt: () => ({ status: "never", ranAt: null, area: null, added: 0, errors: [], overdue: false }) as never });
      const lead = upsertLead(db, {
        placeId: `osm:node/f5-${Math.random()}`, source: "osm", attribution: "synthetic", vertical: "dental", area: "Exampleville NSW",
        name: "Synthetic Dental (fictional)", phone: "", address: "", website: "", mapsUrl: "", rating: null, reviews: null,
        emails: [], emailOk: false, score: 50, pitch: "website", reasons: [], googleAt: null,
      } as never);
      const P = new URLSearchParams();
      await expect(api.handle("/leads/proposal", "POST", { lead: lead.id, packageId: "zz-none" }, P, false)).rejects.toThrow("packageId must be one of");
      await expect(api.handle("/leads/deposit-invoice", "POST", { lead: lead.id, packageId: 42 }, P, false)).rejects.toThrow("packageId must be one of");
      expect(((await api.handle("/leads/proposal", "POST", { lead: lead.id }, P, false)) as any).draft).toBe(true);
    } finally {
      db.close();
      Bun.gc(true);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp */
      }
    }
  });

  test("P2-3: an AI usage setting that doesn't exist (budget) is refused", () => {
    const current = { prices: {}, owners: {} } as any;
    expect(() => applySettingsPatch(current, { budget: "lots" })).toThrow("Unknown setting");
    expect(() => applySettingsPatch(current, [])).toThrow();
    expect(applySettingsPatch(current, { owners: { "acct-1": "Usman" } }).owners["acct-1"]).toBe("Usman");
  });

  test("P2-3: the business store refuses a non-object profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3-f5-biz-"));
    try {
      const biz = businessWorkspace(dir);
      expect(() => biz.update({ profile: "x" })).toThrow();
      expect(() => biz.update({ profile: { quarterGoal: ["x"] } })).toThrow();
      expect(biz.update({ profile: { quarterGoal: "Synthetic goal" } }).profile.quarterGoal).toBe("Synthetic goal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("P3: the Hermes scheduler being unreachable is a 503-class error", async () => {
    const api = createAutomationsApi({ exec: async () => ({ ok: false, stdout: "", stderr: "not running" }) });
    const error = await api.list(true).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    const { operatorErrorStatus } = await import("./operator-checks");
    expect(operatorErrorStatus(error)).toBe(503);
    expect(operatorErrorStatus(new Error("Choose an automation."))).toBe(400);
  });

  test("P3: a control-receipt read with the worker down is 503; a bad limit is 400", () => {
    const input = (path: string, query = "") => ({ path, method: "GET", url: new URL(`http://x${path}${query}`), remote: false, authenticated: true });
    const down = () => {
      throw new Error("worker unavailable");
    };
    expect(controlReceiptRoute(input("/control/jobs"), down as never)?.status).toBe(503);
    expect(controlReceiptRoute(input("/control/quarantine"), down as never)?.status).toBe(503);
    expect(controlReceiptRoute(input("/control/jobs", "?limit=abc"), down as never)?.status).toBe(400);
  });

  test("P3: fleet receipts with unreadable storage are 503; a bad limit is 400", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3-f5-fleet-"));
    try {
      mkdirSync(join(dir, ".operator-data", "model-fleet"), { recursive: true });
      writeFileSync(join(dir, ".operator-data", "model-fleet", "receipts.sqlite"), "this is not a database");
      const input = (query: string) => ({ path: "/model-fleet/receipts", method: "GET", url: new URL(`http://x/model-fleet/receipts${query}`), remote: false, authenticated: true });
      expect(modelFleetReceiptRoute(input("?limit=abc"), dir)?.status).toBe(400);
      expect(modelFleetReceiptRoute(input(""), dir)?.status).toBe(503);
    } finally {
      Bun.gc(true);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* handle */
      }
    }
  });

  test("P2-9: the meeting API answers 404 and 405, not 409, for routing mistakes", async () => {
    const api = meetingApi({ status: () => ({}) } as never, { notes: () => null, list: () => [] } as never);
    const status = (p: Promise<unknown>) => p.then(() => 200, (e) => (e as { status?: number }).status);
    expect(await status(api.handle("/meeting/zz", "GET", {}))).toBe(404);
    expect(await status(api.handle("/meeting/zz", "POST", {}))).toBe(404);
    expect(await status(api.handle("/meeting/start", "GET", {}))).toBe(405);
    expect(await status(api.handle("/meeting/status", "POST", {}))).toBe(405);
    expect(await status(api.handle("/meeting/notes/zz", "GET", {}))).toBe(404);
    expect(await status(api.voice({ action: "zz" }, {}))).toBe(400);
  });

  test("P2-3: /__memory/items with an unknown kind or bucket is 400", async () => {
    const principal = { id: "usman", name: "Usman", via: "local", actor: "human" };
    const api = { list: () => [] };
    const call = (url: string) =>
      new Promise<number>((resolve) => {
        const req = Object.assign(Readable.from([]), { method: "GET", url, headers: { host: "localhost:8081" }, socket: { remoteAddress: "127.0.0.1" } });
        memoryMiddleware({ api: () => api as never, principalFor: () => principal as never })(
          req as never,
          { statusCode: 200, setHeader() {}, end() { resolve(this.statusCode); } } as never,
          () => resolve(404),
        );
      });
    expect(await call("/items?kind=zz")).toBe(400);
    expect(await call("/items?bucket=zz")).toBe(400);
    expect(await call("/items?kind=note")).toBe(200);
    expect(await call("/items")).toBe(200);
    // MCP over streamable HTTP: GET means "open a server stream", which this endpoint doesn't do.
    expect(await call("/mcp")).toBe(405);
  });
});
