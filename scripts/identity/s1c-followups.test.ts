import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevicesService, type DevicesService } from "../devices/service";
import { setActiveRegistry } from "../devices/registry";
import { CODE_MAX_FAILURES, DeviceStore, MAX_PENDING_HUB_SESSIONS, MAX_PENDING_PER_SOURCE } from "../devices/store";
import { resetOwnTailnetNameForTests, setTailnetStatusForTests, syntheticTailnetForTests } from "../remote-access";
import { createPrincipalGate, sourceTag, under } from "./gate";

/**
 * REVIEW-S1 follow-ups N1, N2 and N4 (N8 and N9 are in serve-peer.test.ts).
 *   N1  forged page loads evicted the owner's own pending browser (pending cap, oldest first)
 *   N2  a local program's wrong companion codes locked Usman's other PC out of companion pairing
 *   N4  a throw in the identity gate's deferred (wait-for-snapshot) path left the request hanging
 */

const TAILNET = "s1c-hub.tail-test.ts.net";
const INTERNAL = "s1c-internal-page-token";
const LOGIN = { usman: "owner@example.test", mehroz: "partner@example.test" };
const TAILNET_STATUS = syntheticTailnetForTests(TAILNET, ["100.64.0.1"]);

type Mount = { path: string | null; fn: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => unknown) => unknown };

/** A tiny connect-like server: `next(err)` answers 500, like Connect's error handler. */
async function serveMounts(mounts: Mount[]) {
  const server = createServer((r, s) => {
    let i = 0;
    const original = r.url || "/";
    const next = (err?: unknown): unknown => {
      if (err) {
        s.statusCode = 500;
        return s.end(JSON.stringify({ error: "handled" }));
      }
      r.url = original;
      const m = mounts[i++];
      if (!m) return s.end();
      if (m.path === null) return m.fn(r, s, next);
      if (!under(original.split("?")[0], m.path)) return next();
      r.url = original.slice(m.path.length) || "/";
      return m.fn(r, s, next);
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

function freshRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".operator-data"));
  writeFileSync(
    join(root, ".operator-data", "people.json"),
    JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGIN.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGIN.mehroz] }] }),
  );
  return root;
}

async function call(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const h = { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, cookies: res.headers.getSetCookie() };
}

describe("N1 + N2 through the gate and /__devices", () => {
  let root: string;
  let store: DeviceStore;
  let devices: DevicesService;
  let server: Server;
  let base: string;
  let ownerCookie = "";

  beforeAll(async () => {
    root = freshRoot("s1c-followups-");
    store = new DeviceStore(root);
    const opts = { root, store, tailnetName: TAILNET, servePeer: () => true, tailnet: TAILNET_STATUS };
    devices = createDevicesService({ ...opts, token: INTERNAL });
    // The navigating program, simulated: the test names it (the real gate reads the socket peer's image).
    const navigationSource = (req: IncomingMessage) => sourceTag(String(req.headers["x-test-program"] ?? "") || null);
    ({ server, base } = await serveMounts([
      { path: null, fn: createPrincipalGate({ ...opts, internalToken: () => INTERNAL, navigationSource }) },
      { path: "/__devices", fn: (r, s, n) => void devices.handle(r, s, n) },
      { path: null, fn: (_r, s) => void s.end("served") },
    ]));
    ownerCookie = await navigate("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  });

  afterAll(async () => {
    devices?.close();
    setActiveRegistry(undefined);
    server?.closeAllConnections?.();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const local = () => ({ host: `127.0.0.1:${new URL(base).port}` });
  async function navigate(program: string) {
    const res = await fetch(base + "/", { headers: { ...local(), "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "x-test-program": program } });
    return (res.headers.getSetCookie().find((c) => c.startsWith("mu_session=")) ?? "").split(";")[0];
  }
  const program = (cookie = "") => ({ ...local(), "x-claude-os-token": INTERNAL, ...(cookie ? { cookie } : {}) });

  test("N1: a program's looping forged page loads never evict the owner's new browser waiting for its code", async () => {
    const ownersNewBrowser = await navigate("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    for (let i = 0; i < 30; i++) await navigate("C:\\Users\\owner\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe");
    // Even a program cycling through many copies of itself only displaces the newest pending sessions.
    for (let i = 0; i < MAX_PENDING_HUB_SESSIONS + 4; i++) await navigate(`C:\\Users\\owner\\AppData\\Local\\Temp\\copy-${i}.exe`);
    const code = (await call(base, "POST", "/__devices/sessions/confirm-code", program(ownerCookie), {})).json.code;
    const ok = await call(base, "POST", "/__devices/sessions/confirm", program(ownersNewBrowser), { code });
    expect([ok.status, ok.json.confirmed?.pending]).toEqual([200, false]);
    const pending = store.sessions("usman").filter((s) => s.via === "hub" && s.pending && !s.revokedAt);
    expect(pending.length).toBeLessThanOrEqual(MAX_PENDING_HUB_SESSIONS);
    expect(pending.filter((s) => s.source?.startsWith("bun.exe#")).length).toBeLessThanOrEqual(MAX_PENDING_PER_SOURCE);
  });

  test("N2: a local program's wrong companion codes don't lock Usman's other PC out of companion pairing", async () => {
    for (let i = 0; i < CODE_MAX_FAILURES + 1; i++) expect((await call(base, "POST", "/__devices/companion/pair", local(), { code: "EEEE-EEEE" })).status).toBe(403);
    // The hub's own bucket is locked (brute force still stops there)...
    const localTry = await call(base, "POST", "/__devices/companion/pair", local(), { code: "FFFF-FFFF" });
    expect([localTry.status, localTry.json.error]).toEqual([403, expect.stringContaining("Too many")]);
    // ...but Usman's laptop, over the tailnet from its own node, pairs a companion with a code he made.
    const code = (await call(base, "POST", "/__devices/pair/code", program(ownerCookie), { purpose: "companion", personId: "usman" })).json.code;
    const laptop = { host: `${TAILNET}:8443`, "tailscale-user-login": LOGIN.usman, "x-forwarded-for": "100.64.0.21", "x-forwarded-proto": "https" };
    const paired = await call(base, "POST", "/__devices/companion/pair", laptop, { code, label: "Usman's laptop" });
    expect([paired.status, paired.json.owner]).toEqual([200, "usman"]);
    // And one remote node's typos lock only that node.
    const otherNode = { ...laptop, "x-forwarded-for": "100.64.0.22" };
    for (let i = 0; i < CODE_MAX_FAILURES; i++) await call(base, "POST", "/__devices/companion/pair", otherNode, { code: "GGGG-GGGG" });
    const again = (await call(base, "POST", "/__devices/pair/code", program(ownerCookie), { purpose: "companion", personId: "usman" })).json.code;
    expect((await call(base, "POST", "/__devices/companion/pair", laptop, { code: again, label: "Usman's desktop" })).status).toBe(200);
  });
});

describe("N1: the store's pending caps", () => {
  test("per source first, then overall: the largest source loses its oldest; between equals the newest goes", () => {
    const dir = freshRoot("s1c-store-");
    let t = 1_000_000;
    try {
      const s = new DeviceStore(dir, { now: () => (t += 10) });
      s.mintHubSession("first"); // trusted on first use
      const owner = s.mintHubSession("owner's new browser", "chrome.exe#aaaa");
      for (let i = 0; i < 25; i++) s.mintHubSession("forged", "bun.exe#bbbb");
      let live = s.sessions("usman").filter((x) => x.pending && !x.revokedAt);
      expect(live.filter((x) => x.source === "bun.exe#bbbb").length).toBe(MAX_PENDING_PER_SOURCE);
      expect(live.some((x) => x.id === owner.session.id)).toBe(true);
      // Many one-off sources: the owner's (older) one is kept; the newest ones make way.
      for (let i = 0; i < 40; i++) s.mintHubSession("forged", `copy-${i}.exe#${i}`);
      live = s.sessions("usman").filter((x) => x.pending && !x.revokedAt);
      expect(live.length).toBe(MAX_PENDING_HUB_SESSIONS);
      expect(live.some((x) => x.id === owner.session.id)).toBe(true);
      // Sessions minted before this change (no source) share one "unknown" bucket and stay capped.
      for (let i = 0; i < 10; i++) s.mintHubSession("old style");
      live = s.sessions("usman").filter((x) => x.pending && !x.revokedAt);
      expect(live.filter((x) => (x.source ?? "unknown") === "unknown").length).toBeLessThanOrEqual(MAX_PENDING_PER_SOURCE);
      expect(live.some((x) => x.id === owner.session.id)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the source tag is a file name and a path hash, never the path itself", () => {
    const tag = sourceTag("C:\\Users\\owner\\secret-folder\\tool.exe")!;
    expect(tag).toMatch(/^tool\.exe#[0-9a-f]{8}$/);
    expect(sourceTag("C:\\Other\\tool.exe")).not.toBe(tag);
    expect(sourceTag(null)).toBeNull();
  });
});

describe("N2: companion lockout scopes", () => {
  test("per origin: the hub's bucket and each tailnet node's bucket are separate", () => {
    const dir = freshRoot("s1c-scope-");
    try {
      const s = new DeviceStore(dir);
      for (let i = 0; i < CODE_MAX_FAILURES; i++) s.redeemCode("HHHH-HHHH", "companion", "usman", "hub");
      expect(s.redeemCode(s.createCode("usman", "companion", "usman").code, "companion", "usman", "hub").ok).toBe(false);
      expect(s.redeemCode(s.createCode("usman", "companion", "usman").code, "companion", "usman", "nLaptopCNTRL").ok).toBe(true);
      expect(Object.keys(s.read().codeFailures)).toEqual(["companion:usman@hub"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("N4: a failure in the gate's deferred path is answered, not left hanging", () => {
  test("a throw after waiting for the tailnet snapshot reaches the error handler", async () => {
    const root = freshRoot("s1c-n4-");
    resetOwnTailnetNameForTests();
    // The live-snapshot path (no injected snapshot), with a (fake) `tailscale status` to wait for.
    setTailnetStatusForTests(async () => {
      await Bun.sleep(20);
      return JSON.stringify({ Self: { ID: "nHub", DNSName: `${TAILNET}.`, TailscaleIPs: ["100.64.0.1"] }, Peer: {} });
    });
    const warn = console.warn;
    console.warn = () => {};
    const { server, base } = await serveMounts([
      {
        path: null,
        fn: createPrincipalGate({
          root,
          tailnetName: TAILNET,
          servePeer: () => true,
          internalToken: () => {
            throw new Error("EPERM renaming devices.json (synthetic)");
          },
        }),
      },
    ]);
    try {
      const res = await call(base, "GET", "/__token", { host: `${TAILNET}:8443`, "tailscale-user-login": LOGIN.mehroz, "x-forwarded-for": "100.64.0.12" });
      expect(res.status).toBe(500);
    } finally {
      console.warn = warn;
      resetOwnTailnetNameForTests();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
