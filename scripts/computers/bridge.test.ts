import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { BRIDGE_ALLOW, createBridge, forwardHeaders } from "./bridge";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function fakeHub() {
  const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))));
  return { seen, port: (server.address() as { port: number }).port };
}

describe("the companion bridge", () => {
  test("forwards only the companion wire routes, keeps the bearer, and never lets a caller look like the hub's own user", async () => {
    const hub = await fakeHub();
    const bridge = createBridge({ listenHost: "127.0.0.1", listenPort: 0, targetPort: hub.port });
    const { port } = await bridge.start();
    closers.push(() => bridge.close());
    const res = await fetch(`http://127.0.0.1:${port}/__devices/companion/heartbeat`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json", "tailscale-user-login": "owner@example.test", "x-forwarded-for": "100.64.0.11", cookie: "mu_session=steal", "x-claude-os-token": "page" },
      body: JSON.stringify({ busy: false }),
    });
    expect(res.status).toBe(200);
    const got = hub.seen[0];
    expect(got.path).toBe("/__devices/companion/heartbeat");
    expect(got.headers.authorization).toBe("Bearer tok");
    expect(got.body).toBe(JSON.stringify({ busy: false }));
    // nothing that could pose as a tailnet person, a cookie session or a page token crosses
    expect(got.headers["tailscale-user-login"]).toBeUndefined();
    expect(got.headers["x-forwarded-for"]).toBeUndefined();
    expect(got.headers.cookie).toBeUndefined();
    expect(got.headers["x-claude-os-token"]).toBeUndefined();
    // and the Host is the hub's own loopback name (decided by the bridge, not the caller): a computer's token is accepted only on the hub's own host
    expect(got.headers.host).toBe(`127.0.0.1:${hub.port}`);
  });

  test("every other hub route is 404 at the bridge and never reaches the hub", async () => {
    const hub = await fakeHub();
    const bridge = createBridge({ listenHost: "127.0.0.1", listenPort: 0, targetPort: hub.port });
    const { port } = await bridge.start();
    closers.push(() => bridge.close());
    for (const path of ["/", "/__operator/screen/command", "/__devices/devices", "/__devices/pair/redeem", "/__computers", "/__devices/companion/../devices", "/__devices/companion/unknown"]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(r.status).toBe(404);
    }
    expect((await fetch(`http://127.0.0.1:${port}/__devices/companion/next`, { method: "DELETE" })).status).toBe(404);
    expect(hub.seen).toHaveLength(0);
  });

  test("it refuses to listen on every interface", () => {
    expect(() => createBridge({ listenHost: "0.0.0.0", listenPort: 1, targetPort: 2 })).toThrow(/one interface/);
    expect(() => createBridge({ listenHost: "::", listenPort: 1, targetPort: 2 })).toThrow();
  });

  test("the allow-list is exactly the companion wire", () => {
    for (const p of ["pair", "heartbeat", "next", "result", "progress", "observation", "goodbye"]) expect(BRIDGE_ALLOW.test(`/__devices/companion/${p}`)).toBe(true);
    expect(BRIDGE_ALLOW.test("/__devices/me")).toBe(false);
    // the hub still refuses anything that came from a web page: Origin crosses untouched
    expect(forwardHeaders({ host: "a", origin: "http://evil", "sec-fetch-site": "cross-site" }, "b:1").origin).toBe("http://evil");
  });
});
