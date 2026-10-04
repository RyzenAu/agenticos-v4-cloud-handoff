import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { startHub, type Hub } from "../devices/test-harness";
import { markLoopbackUnproven } from "./principal";

/**
 * Final independent review of the combined change: regression tests (each fails on fe0d3241).
 *   2 pairing codes, session approve/revoke, device revoke and policy are SAME-PERSON only in the server role
 *   3 a loopback companion pair, and /__devices/me, need the local-owner proof in the server role
 * (1 is in scripts/away-mode/server-role.test.ts and scripts/identity/operator-sites.test.ts; 4 in lead-sites; 5 and 6 below
 *  and in scripts/identity/local-owner-proof.test.ts)
 */

const hubs: Hub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});
async function rig(role: "pc" | "cloud" | "server" = "server") {
  const hub = await startHub({ hubRole: role });
  hubs.push(hub);
  /** A browser holding a CONFIRMED session of this founder (a human). */
  const confirmed = (who: "usman" | "mehroz") => {
    const b = hub.browser(who);
    const minted = hub.svc.store.mintSession(who, `${who}'s laptop`, "code");
    b.jar.set("mu_session", encodeURIComponent(minted.cookie));
    return { browser: b, session: minted.session };
  };
  return { hub, confirmed };
}

describe("2: equal founders manage only their own devices (server role)", () => {
  test("pairing codes: Usman cannot mint a code that makes a CONFIRMED session for Mehroz (and the reverse); each can for himself", async () => {
    const { hub, confirmed } = await rig();
    const usman = confirmed("usman").browser;
    const mehroz = confirmed("mehroz").browser;
    const cross = await usman.post("/pair/code", { personId: "mehroz", purpose: "browser" });
    expect(cross.status).toBe(403);
    expect(hub.svc.store.read().codes.length).toBe(0); // no code was made
    expect((await mehroz.post("/pair/code", { personId: "usman", purpose: "browser" })).status).toBe(403);
    const own = await usman.post("/pair/code", { personId: "usman", purpose: "browser" });
    expect(own.status).toBe(200);
    expect((await usman.post("/pair/code", { purpose: "companion" })).status).toBe(200); // no personId: himself
    expect((await mehroz.post("/pair/code", { personId: "mehroz", purpose: "browser" })).status).toBe(200);
  });

  test("session approve and revoke, device revoke and the sign-in policy are the same: own only", async () => {
    const { hub, confirmed } = await rig();
    const u = confirmed("usman");
    const m = confirmed("mehroz");
    // revoke a session
    const mehrozPhone = hub.svc.store.mintSession("mehroz", "Mehroz's phone", "code").session;
    expect((await u.browser.post("/sessions/revoke", { sessionId: mehrozPhone.id })).status).toBe(403);
    expect(hub.svc.store.sessions("mehroz").find((s) => s.id === mehrozPhone.id)?.revokedAt).toBeUndefined();
    expect((await m.browser.post("/sessions/revoke", { sessionId: mehrozPhone.id })).status).toBe(200);
    // revoke a personal device
    const usmanPc = hub.svc.store.registerCompanion("usman", { label: "Usman's laptop" }).device;
    const mehrozPc = hub.svc.store.registerCompanion("mehroz", { label: "Mehroz's PC" }).device;
    expect((await m.browser.post("/devices/revoke", { deviceId: usmanPc.id })).status).toBe(403);
    expect((await u.browser.post("/devices/revoke", { deviceId: mehrozPc.id })).status).toBe(403);
    expect(hub.svc.store.companions().find((c) => c.id === mehrozPc.id)?.revokedAt).toBeUndefined();
    expect((await u.browser.post("/devices/revoke", { deviceId: usmanPc.id })).status).toBe(200);
    // the "require a code" policy
    expect((await u.browser.post("/policy/self-pair", { personId: "mehroz", allowed: false })).status).toBe(403);
    expect(hub.svc.store.policy().selfPair.mehroz).not.toBe(false);
    expect((await m.browser.post("/policy/self-pair", { personId: "mehroz", allowed: true })).status).toBe(200);
  });

  test("listing: a founder lists his own sessions, not the other's; the other founder's online status stays visible", async () => {
    const { hub, confirmed } = await rig();
    const u = confirmed("usman");
    const m = confirmed("mehroz");
    const sessions = (await u.browser.get("/sessions")).json.sessions as Array<{ personId: string }>;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.personId === "usman")).toBe(true);
    expect(((await m.browser.get("/sessions")).json.sessions as Array<{ personId: string }>).every((s) => s.personId === "mehroz")).toBe(true);
    const devices = (await u.browser.get("/devices")).json;
    expect(devices.people.map((p: { id: string }) => p.id).sort()).toEqual(["mehroz", "usman"]);
    expect(devices.people.find((p: { id: string }) => p.id === "mehroz")).toHaveProperty("online");
    void hub;
  });

  test("pc and cloud are unchanged: Usman still manages anyone's codes, sessions and devices there", async () => {
    for (const role of ["pc", "cloud"] as const) {
      const { hub, confirmed } = await rig(role);
      const u = confirmed("usman").browser;
      expect((await u.post("/pair/code", { personId: "mehroz", purpose: "browser" })).status).toBe(200);
      const phone = hub.svc.store.mintSession("mehroz", "phone", "code").session;
      expect((await u.post("/sessions/revoke", { sessionId: phone.id })).status).toBe(200);
      const all = (await u.get("/sessions")).json.sessions as Array<{ personId: string }>;
      expect(all.some((s) => s.personId === "mehroz")).toBe(true);
    }
  });

  test("the console code is still the cross-person route (made at the server with the local-owner token)", async () => {
    const { hub } = await rig();
    const made = await hub.browser("local").post("/pair/console-code", { personId: "mehroz" });
    expect(made.status).toBe(200);
    const redeemed = await hub.browser("mehroz").post("/pair/redeem", { code: made.json.code });
    expect([redeemed.status, redeemed.json.session?.pending]).toEqual([200, false]);
  });
});

/** A request as the server sees it, with the gate's "no local-owner proof" mark when asked. */
function fakeRequest(path: string, method: string, body: unknown, headers: Record<string, string>, unproven: boolean) {
  const req: any = Object.assign(Readable.from([JSON.stringify(body ?? {})]), { url: path, method, headers: { host: "127.0.0.1:8081", "content-type": "application/json", ...headers }, socket: { remoteAddress: "127.0.0.1" } });
  if (unproven) markLoopbackUnproven(req);
  const out = { status: 200, body: null as any };
  const res: any = { statusCode: 200, setHeader() {}, end(text?: string) { out.status = res.statusCode; try { out.body = text ? JSON.parse(text) : null; } catch { out.body = text; } } };
  return { req, res, out };
}

describe("3: loopback needs the local-owner proof to pair a companion or to learn who the founders are (server role)", () => {
  test("an unproven loopback process cannot register a Usman companion with a code; the code stays unused", async () => {
    const { hub } = await rig();
    const { code } = hub.svc.store.createCode("usman", "companion", "usman");
    const { req, res, out } = fakeRequest("/__devices/companion/pair", "POST", { code, label: "evil" }, {}, true);
    await hub.svc.handle(req, res);
    expect(out.status).toBe(403);
    expect(hub.svc.store.companions()).toEqual([]);
    // The same request WITH the proof (the gate did not mark it) pairs, as before.
    const ok = fakeRequest("/__devices/companion/pair", "POST", { code, label: "mine" }, {}, false);
    await hub.svc.handle(ok.req, ok.res);
    expect(ok.out.status).toBe(200);
    expect(hub.svc.store.companions().length).toBe(1);
  });

  test("pairing over Serve (a tailnet login with its own code) is unchanged", async () => {
    const { hub } = await rig();
    const { code } = hub.svc.store.createCode("mehroz", "companion", "mehroz");
    const r = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...hub.headersFor("mehroz"), "content-type": "application/json" }, body: JSON.stringify({ code, label: "laptop" }) });
    expect(r.status).toBe(200);
  });

  test("GET /__devices/me from an unproven local process does not list the founders; a proven owner and a tailnet founder still get it", async () => {
    const { hub } = await rig();
    const bare = fakeRequest("/__devices/me", "GET", undefined, {}, true);
    await hub.svc.handle(bare.req, bare.res);
    expect(bare.out.status).toBe(200);
    expect(bare.out.body.authorised).toBe(false);
    expect(bare.out.body.people).toEqual([]);
    expect(bare.out.body.person).toBeNull();
    const owner = await hub.browser("local").get("/me");
    expect(owner.json.people.length).toBe(2);
    const founder = await hub.browser("mehroz").get("/me");
    expect(founder.json.people.length).toBe(2);
  });

  test("pc and cloud: nothing changes (a local companion pair and /me behave as before)", async () => {
    for (const role of ["pc", "cloud"] as const) {
      const { hub } = await rig(role);
      const { code } = hub.svc.store.createCode("usman", "companion", "usman");
      const r = fakeRequest("/__devices/companion/pair", "POST", { code, label: "x" }, {}, false);
      await hub.svc.handle(r.req, r.res);
      expect(r.out.status).toBe(200);
      expect((await hub.browser("local").get("/me")).json.people.length).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { relayToken, relayTokenFile } from "../away-mode/service";
import { shimToken } from "../jev-hermes";
import { tokenFileProtected } from "./local-owner-token";

describe("final review 6b: the relay bearer and the Jev shim key are protected on Windows too (mode 0o600 does nothing there)", () => {
  const roots: string[] = [];
  const withRole = <T>(role: string | undefined, fn: () => T): T => {
    const prior = process.env.MU_HUB_ROLE;
    if (role === undefined) delete process.env.MU_HUB_ROLE;
    else process.env.MU_HUB_ROLE = role;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env.MU_HUB_ROLE;
      else process.env.MU_HUB_ROLE = prior;
    }
  };
  const newRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "relay-token-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const icacls = (file: string, ...args: string[]) => spawnSync(join(process.env.SystemRoot ?? "C:\Windows", "System32", "icacls.exe"), [file, ...args], { encoding: "utf8" });

  test("a new relay token is created protected from its first byte, in every role; no stray temp files", () => {
    for (const role of [undefined, "pc", "cloud", "server"]) {
      const root = newRoot();
      const token = withRole(role, () => relayToken(root));
      const file = relayTokenFile(root);
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(file, "utf8").trim()).toBe(token);
      expect([role, tokenFileProtected(file)]).toEqual([role, true]);
      expect(require("node:fs").readdirSync(join(file, "..")).sort()).toEqual(["relay.token"]);
      expect(withRole(role, () => relayToken(root))).toBe(token); // stable across calls
    }
  });

  test("server role: an existing relay token with a wide ACL is tightened IN PLACE (same value, so Hermes' plugin keeps working)", () => {
    const root = newRoot();
    const file = relayTokenFile(root);
    mkdirSync(join(file, ".."), { recursive: true });
    const old = "a".repeat(64);
    writeFileSync(file, old); // inherits the folder's ACL, as a token written by an older start would
    if (process.platform !== "win32") chmodSync(file, 0o644);
    expect(tokenFileProtected(file)).toBe(false);
    const warn = console.warn;
    const seen: string[] = [];
    console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    try {
      expect(withRole("server", () => relayToken(root))).toBe(old);
    } finally {
      console.warn = warn;
    }
    expect(readFileSync(file, "utf8").trim()).toBe(old);
    expect(tokenFileProtected(file)).toBe(true);
    expect(seen.join(" ")).not.toContain(old);
    if (process.platform === "win32") expect(icacls(file).stdout).not.toMatch(/Everyone|Authenticated Users|BUILTIN\Users/i);
  });

  test("pc: an existing relay token is left exactly as it was (nothing is tightened outside the server role)", () => {
    const root = newRoot();
    const file = relayTokenFile(root);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "b".repeat(64));
    if (process.platform !== "win32") chmodSync(file, 0o644);
    expect(withRole("pc", () => relayToken(root))).toBe("b".repeat(64));
    expect(tokenFileProtected(file)).toBe(false);
  });

  test("the Jev shim key is created protected too", () => {
    const root = newRoot();
    const token = shimToken(root);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const file = join(root, ".operator-data", "jev-shim.token");
    expect(tokenFileProtected(file)).toBe(true);
    expect(shimToken(root)).toBe(token);
  });
});

describe("final review 6c: a WebSocket upgrade is held to the unproven-loopback rule too (the VNC viewer)", () => {
  test("server role: a loopback upgrade carrying a CONFIRMED hub session but no local-owner proof is refused; with the proof it gets past identity", async () => {
    const { upgradeViewer } = await import("../computers/viewer");
    const { createLocalOwnerProof } = await import("./local-owner-token");
    const { hub } = await rig();
    const dir = mkdtempSync(join(tmpdir(), "viewer-proof-"));
    try {
      const proof = createLocalOwnerProof(hub.root, { MU_LOCAL_OWNER_TOKEN_FILE: join(dir, "t") });
      const token = readFileSync(proof.path, "utf8").trim();
      const session = hub.svc.store.mintSession("usman", "This PC's browser", "hub"); // confirmed (not pending): a human session
      const cookie = `mu_session=${encodeURIComponent(session.cookie)}`;
      const computers: any = { openVnc: async () => null }; // got past identity <=> reaches here => 404 "No viewer"
      const attempt = async (headers: Record<string, string>, withProof: boolean) => {
        const writes: string[] = [];
        const socket: any = { write: (t: string) => writes.push(t), destroy() {} };
        await upgradeViewer({ devices: hub.svc, computers, ...(withProof ? { localOwnerProof: proof } : {}) }, {} as never, "bot-1", { url: "/__computers/bot-1/vnc", headers: { host: "127.0.0.1:8081", cookie, ...headers }, socket: { remoteAddress: "127.0.0.1" } } as never, socket, Buffer.alloc(0));
        return writes.join("");
      };
      expect(await attempt({}, true)).toMatch(/^HTTP\/1\.1 401/); // a local program holding the cookie but not the token
      expect(await attempt({ authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, true)).toMatch(/^HTTP\/1\.1 401/);
      expect(await attempt({ "x-mu-local-owner": token }, true)).toMatch(/^HTTP\/1\.1 404/); // past identity: the stub finds no viewer
      expect(await attempt({ authorization: `Bearer ${token}` }, true)).toMatch(/^HTTP\/1\.1 404/);
      // Without the server-role proof wired in (pc and cloud) the same upgrade behaves exactly as before.
      expect(await attempt({}, false)).toMatch(/^HTTP\/1\.1 404/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
