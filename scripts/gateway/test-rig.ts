/// <reference path="../computers/ws.d.ts" />
/**
 * Test support for the Dot gateway: a throwaway HUB on a loopback port, built from the hub's REAL parts
 * (the identity gate in the server role, the gateway trust check, the /__gateway routes, the /__events stream and bus)
 * plus a few plain routes, and a recorder of everything that reached it. Synthetic people and tokens only; no real
 * people.json, session or credential is read. Used by scripts/gateway/*.test.ts and nothing else.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { DeviceStore } from "../devices/store";
import { ActivityBus } from "../events/bus";
import { createStream } from "../events/stream";
import { createPrincipalGate, requestPrincipal } from "../identity/gate";
import { createLocalOwnerProof } from "../identity/local-owner-token";
import { isAtHub, isHumanSession, type Principal } from "../identity/principal";
import { syntheticTailnetForTests } from "../remote-access";
import { gatewayDir } from "./config";
import { gatewayStreamPrincipal } from "./events";
import { createGatewayTrust } from "./hub";
import { createGatewayRoutes } from "./hub-plugin";

export const RIG_INTERNAL_TOKEN = "rig-internal-page-token";
export const RIG_TAILNET = "rig-hub.tail-test.ts.net";

export type Seen = { method: string; url: string; headers: Record<string, string>; upgrade: boolean };

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function startRigHub(options: { trust?: boolean; /** Seams for Dot's operating routes (hub-ops.ts); the tests pass real services built on synthetic data. */ operate?: import("./hub-plugin").GatewayRoutesOptions["operate"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gw-rig-"));
  const dataDir = join(root, ".operator-data");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: ["owner@example.test"] }, { name: "Mehroz", role: "co-founder", tailscale: ["partner@example.test"] }] }));
  const env = { MU_DATA_DIR: dataDir };
  const dir = gatewayDir(root, env);
  const store = new DeviceStore(root);
  const trust = createGatewayTrust({ root, internalToken: () => RIG_INTERNAL_TOKEN, enabled: options.trust !== false, dir });
  const gate = createPrincipalGate({
    root,
    internalToken: () => RIG_INTERNAL_TOKEN,
    store,
    tailnetName: RIG_TAILNET,
    servePeer: () => false,
    tailnet: syntheticTailnetForTests(RIG_TAILNET, ["100.64.0.1"]),
    role: "server",
    localOwnerProof: createLocalOwnerProof(root, { MU_LOCAL_OWNER_TOKEN_FILE: join(root, "local-owner.token") }),
    gateway: trust,
  });

  const seen: Seen[] = [];
  /** What the handlers saw AFTER the gate: the principal and the headers a handler could read. */
  const reached: Array<{ method: string; url: string; principal: Principal | null; atHub: boolean; human: boolean; headers: Record<string, string> }> = [];
  const bus = new ActivityBus();
  /** What a founder's snapshot would hold: Dot's must be cut down from it. */
  const fullSnapshot = () => ({ jobs: [{ id: "j-coding", kind: "coding" }, { id: "j-memory", kind: "memory" }, { id: "j-trigger", kind: "trigger" }], jobsHead: 3, approvals: [{ id: "a-deploy", action: "git.push.production" }], computers: [{ name: "bot-1" }], devices: [{ id: "d1" }] });
  const principalOf = (req: IncomingMessage) => requestPrincipal(req, { root });
  const stream = createStream({
    bus,
    // The same rule as scripts/events/plugin.ts.
    resolvePrincipal: (req) => {
      const p = principalOf(req) as { personId?: string; via?: string } | null;
      if (p && p.via === "gateway") return gatewayStreamPrincipal(p.personId as never, () => fullSnapshot());
      return p && (p.personId === "usman" || p.personId === "mehroz") ? { personId: p.personId } : null;
    },
    snapshot: () => fullSnapshot(),
    heartbeatMs: 60_000,
  });
  const gatewayRoutes = createGatewayRoutes({ root, internalToken: () => RIG_INTERNAL_TOKEN, dir, principal: principalOf, trust: () => options.trust !== false, operate: { env: () => env, readOnly: () => false, ...options.operate } });
  const flat = (req: IncomingMessage) => Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]));
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };

  let port = 0;
  function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const principal = principalOf(req);
    reached.push({ method: req.method ?? "GET", url: req.url ?? "/", principal, atHub: isAtHub(principal), human: isHumanSession(principal), headers: flat(req) });
    if (path === "/__events" || path.startsWith("/__events/")) return stream.handle(req, res);
    if (path === "/__gateway" || path.startsWith("/__gateway/")) return void gatewayRoutes(req, res);
    // A hub that leaks: its own cookie, a server banner, and redirects that name its internal address.
    const leaky = { "Set-Cookie": ["hub_cookie=HUB-COOKIE-VALUE; Path=/", "mu_session=HUB-SESSION-VALUE; Path=/; HttpOnly"], Server: "rig-hub", "X-Powered-By": "rig" };
    if (path === "/__agents/redirect") return json(res, 302, {}, { ...leaky, Location: `http://127.0.0.1:${port}/__agents/landing?x=1` });
    if (path === "/__agents/redirect-relative") return json(res, 302, {}, { ...leaky, Location: "/__agents/landing" });
    if (path === "/__agents/redirect-out") return json(res, 302, {}, { ...leaky, Location: "https://evil.example/phish" });
    if (path === "/__version") return json(res, 200, { version: "rig" }, leaky);
    if (path.startsWith("/__")) return json(res, 200, { reached: req.url, who: principal?.personId ?? null, via: principal?.via ?? null }, leaky);
    if (path.endsWith(".tsx") || path.endsWith(".ts") || path.endsWith(".js")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/javascript");
      return void res.end("export const rig = true;\n");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>rig app</title><p>rig page ${path}</p>`);
  }

  const server = createServer((req, res) => {
    // Recorded BEFORE the gate, with every header exactly as it arrived (the gate removes the assertion afterwards).
    seen.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: flat(req), upgrade: false });
    gate(req, res, (err?: unknown) => {
      if (err) return json(res, 500, { error: "rig" });
      route(req, res);
    });
  });

  // A WebSocket upgrade never passes the gate, so the upgrade's own handler runs the same check (hub.ts screenUpgrade).
  const wss = new WebSocketServer({ noServer: true });
  const socketPrincipals: Array<Principal | null> = [];
  const liveSockets = new Set<WsSocket>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    seen.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: flat(req), upgrade: true });
    const verdict = trust.screenUpgrade(req);
    if (!verdict || !verdict.ok) {
      socket.write(`HTTP/1.1 ${verdict ? verdict.status : 401} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
      socketPrincipals.push(verdict.principal);
      liveSockets.add(ws);
      ws.on("close", () => liveSockets.delete(ws));
      ws.send("hello from the rig hub");
      ws.on("message", (data: Buffer) => ws.send(`echo:${data.toString()}`));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;

  return {
    root,
    dataDir,
    dir,
    port,
    origin: `http://127.0.0.1:${port}`,
    seen,
    reached,
    bus,
    openStreams: () => stream.openCount(),
    socketPrincipals,
    liveSockets: () => liveSockets.size,
    async close() {
      stream.closeAll();
      for (const ws of liveSockets) ws.close();
      wss.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* a handle may linger briefly on Windows; the OS reclaims the temp dir */
      }
    },
  };
}

export type RigHub = Awaited<ReturnType<typeof startRigHub>>;
