import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubRoleGate } from "../cloud/hub-role";
import { LOGINS, PAGE_TOKEN, SIMULATED_TAILNET, startHub, TAILNET, type Hub } from "../devices/test-harness";
import { createPrincipalGate } from "./gate";
import { createLocalOwnerProof } from "./local-owner-token";
import { markLoopbackUnproven, pageTokenFor, sessionCookieValues, MAX_SESSION_COOKIES } from "./principal";
import { makeRig } from "./role-matrix";
import { APPROVAL_GATED, consoleOnlyRule, SERVER_ROLE_CATEGORIES } from "./server-role";

/**
 * Regression tests for the independent review of 282c7041 (each fails on that commit):
 *  1 a bare Tailscale login must not be able to self-upgrade to a confirmed human session in the server role
 *  2 deny by default survives for unclassified /__* paths
 *  3 the 501 capability gate is not bypassed by case or a dot suffix
 *  4 duplicate mu_session cookies cannot lock a founder out
 *  5 writes to /__hermes_pantheon* are console-only
 *  6 publishing: lead-site deploy/takedown go through B2 approvals; unwired outward actions are console-only
 */

const rig = makeRig("server");
const pc = makeRig("pc");
afterAll(() => {
  rig.close();
  pc.close();
});

// ---------------------------------------------------------------------------------------------------------------
describe("1. self-upgrade to a human session", () => {
  const hubs: Hub[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const h of hubs.splice(0)) await h.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A server-role gate over the same store as the devices service, with Serve simulated. */
  async function setup(role: "server" | "pc" | "cloud" = "server") {
    const hub = await startHub({ hubRole: role });
    hubs.push(hub);
    const dir = mkdtempSync(join(tmpdir(), "owner-proof-"));
    dirs.push(dir);
    const proof = role === "server" ? createLocalOwnerProof(hub.root, { MU_LOCAL_OWNER_TOKEN_FILE: join(dir, "t") }) : undefined;
    const gate = createPrincipalGate({
      root: hub.root,
      internalToken: () => PAGE_TOKEN,
      store: hub.svc.store,
      tailnetName: TAILNET,
      servePeer: () => true,
      tailnet: SIMULATED_TAILNET,
      role,
      ...(proof ? { localOwnerProof: proof } : {}),
    } as never);
    /** What the gate does with a request from a founder's browser holding this cookie. */
    const through = (who: "usman" | "mehroz", cookie: string | null, method: string, path: string) => {
      const headers: Record<string, string> = { ...hub.headersFor(who) };
      if (cookie) headers.cookie = `mu_session=${cookie}`;
      headers["x-claude-os-token"] = pageTokenFor({ personId: who, via: "paired-session" }, PAGE_TOKEN);
      let body: any = null;
      let reached = false;
      const res: any = { statusCode: 200, setHeader() {}, getHeader() {}, end(b?: string) { try { body = b ? JSON.parse(b) : null; } catch { body = b; } } };
      gate({ url: path, method, headers, socket: { remoteAddress: "127.0.0.1" } } as never, res, () => (reached = true));
      return { status: reached ? 200 : res.statusCode, body };
    };
    /** A confirmed session for someone, as a browser holding it. */
    const confirmed = (who: "usman" | "mehroz") => {
      const b = hub.browser(who);
      b.jar.set("mu_session", encodeURIComponent(hub.svc.store.mintSession(who, "confirmed", "code").cookie));
      return b;
    };
    return { hub, through, confirmed };
  }

  test("the chain in the review: a cookieless script self-pairs, and the session it gets does NOT open local-owner routes", async () => {
    const { hub, through } = await setup();
    const script = hub.browser("mehroz"); // no cookie: a bare Tailscale login, i.e. a process
    const r = await script.post("/pair/tailnet", { label: "curl" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ paired: true, pending: true, needsApproval: true });
    expect(r.json.session.pending).toBe(true);
    const cookie = decodeURIComponent(script.jar.get("mu_session")!);
    // It keeps today's shared access...
    expect(through("mehroz", cookie, "GET", "/__operator/leads").status).toBe(200);
    // ...but is not a confirmed human session: no local-owner route.
    const denied = through("mehroz", cookie, "POST", "/__claude_chat");
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ reason: "needs-human-session" });
    expect(through("mehroz", cookie, "GET", "/__hermes_memory").status).toBe(403);
    // And a pending session can neither approve itself nor administer anything.
    const id = r.json.session.id as string;
    expect((await script.post("/sessions/approve", { sessionId: id })).status).toBe(403);
    expect((await script.post("/pair/code", { purpose: "browser" })).status).toBe(403);
    expect(through("mehroz", cookie, "POST", "/__claude_chat").status).toBe(403);
  });

  test("approve (S3, manage only your own devices): a confirmed session approves a pending browser of the SAME person only; the other founder gets 403", async () => {
    const { hub, through, confirmed } = await setup();
    const script = hub.browser("mehroz");
    const r = await script.post("/pair/tailnet", { label: "curl" });
    const cookie = decodeURIComponent(script.jar.get("mu_session")!);
    // What the approver sees: when it was created and where it came from, besides the label the browser chose for itself.
    expect(r.json.session).toMatchObject({ label: "curl", pending: true, via: "tailnet" });
    expect(typeof r.json.session.createdAt).toBe("number");
    expect(r.json.session.source).toMatch(/^100.64.0.12#/);
    const listed = (await confirmed("mehroz").get("/sessions")).json.sessions.find((x: any) => x.id === r.json.session.id);
    expect(listed).toMatchObject({ pending: true, createdAt: r.json.session.createdAt, source: r.json.session.source, label: "curl" });
    expect(through("mehroz", cookie, "POST", "/__claude_chat").status).toBe(403);
    // Usman's confirmed session may NOT approve Mehroz's browser: 403, and it stays pending.
    const other = await confirmed("usman").post("/sessions/approve", { sessionId: r.json.session.id });
    expect(other.status).toBe(403);
    expect(hub.svc.store.sessions("mehroz").find((x) => x.id === r.json.session.id)?.pending).toBe(true);
    expect(through("mehroz", cookie, "POST", "/__claude_chat").status).toBe(403);
    // Mehroz's own confirmed session may.
    const ok = await confirmed("mehroz").post("/sessions/approve", { sessionId: r.json.session.id });
    expect(ok.status).toBe(200);
    expect(ok.json.approved.pending).toBe(false);
    expect(through("mehroz", cookie, "POST", "/__claude_chat").status).toBe(200);
    // Approving twice, or something that is not a pending tailnet browser, is refused.
    expect((await confirmed("mehroz").post("/sessions/approve", { sessionId: r.json.session.id })).status).toBe(409);
    expect((await confirmed("mehroz").post("/sessions/approve", { sessionId: "nope" })).status).toBe(404);
    // The same rule the other way round.
    const u = await hub.browser("usman").post("/pair/tailnet", { label: "u" });
    expect((await confirmed("mehroz").post("/sessions/approve", { sessionId: u.json.session.id })).status).toBe(403);
    expect((await confirmed("usman").post("/sessions/approve", { sessionId: u.json.session.id })).status).toBe(200);
  });

  test("console code: made only with the local-owner proof, redeemed in the browser for a CONFIRMED session", async () => {
    const { hub, through } = await setup();
    // The owner with the proof (the harness's loopback browser has none of the gate's marking, so it is the proven owner).
    const made = await hub.browser("local").post("/pair/console-code", { personId: "mehroz" });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ personId: "mehroz", purpose: "browser" });
    expect(made.json.code).toMatch(/^[A-Z0-9-]{8,12}$/);
    // The founder types it into his browser: a confirmed session straight away.
    const browser = hub.browser("mehroz");
    const redeemed = await browser.post("/pair/redeem", { code: made.json.code, label: "laptop" });
    expect(redeemed.status).toBe(200);
    expect(redeemed.json.session.pending).toBe(false);
    expect(through("mehroz", decodeURIComponent(browser.jar.get("mu_session")!), "POST", "/__claude_chat").status).toBe(200);
    // Single use, and a code made for someone else is not his.
    expect((await hub.browser("mehroz").post("/pair/redeem", { code: made.json.code })).status).toBe(403);
    const forUsman = await hub.browser("local").post("/pair/console-code", { personId: "usman" });
    expect((await hub.browser("mehroz").post("/pair/redeem", { code: forUsman.json.code })).status).toBe(403);
    expect((await hub.browser("local").post("/pair/console-code", { personId: "nobody" })).status).toBe(400);
  });

  test("console code: refused to a remote founder, to a bare script, to an unproven loopback caller, and outside the server role", async () => {
    const { hub, confirmed } = await setup();
    expect((await hub.browser("mehroz").post("/pair/console-code", { personId: "mehroz" })).status).toBe(403);
    expect((await confirmed("mehroz").post("/pair/console-code", { personId: "mehroz" })).status).toBe(403);
    expect((await confirmed("usman").post("/pair/console-code", { personId: "usman" })).status).toBe(403);
    // A loopback request the gate marked unproven is nobody to the devices service as well.
    let status = 0;
    const req: any = { url: "/__devices/pair/console-code", method: "POST", headers: { host: "127.0.0.1:1", "x-claude-os-token": PAGE_TOKEN, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } };
    markLoopbackUnproven(req);
    await hub.svc.handle(req, { statusCode: 200, setHeader() {}, end() { status = this.statusCode; } } as never);
    expect([401, 403]).toContain(status); // nobody: refused, and no code was made
    expect(hub.svc.store.read().codes.length).toBe(0);
    for (const role of ["pc", "cloud"] as const) {
      const other = await setup(role);
      expect((await other.hub.browser("local").post("/pair/console-code", { personId: "mehroz" })).status).toBe(403);
    }
  });

  test("pc and cloud are unchanged: a self-paired session is confirmed immediately", async () => {
    for (const role of ["pc", "cloud"] as const) {
      const { hub } = await setup(role);
      const r = await hub.browser("mehroz").post("/pair/tailnet", {});
      expect(r.status).toBe(200);
      expect(r.json.session.pending).toBe(false);
      expect(r.json.pending).toBeUndefined();
    }
  });

  test("a script cannot pile up unconfirmed browsers: at most five are kept", async () => {
    const { hub } = await setup();
    for (let i = 0; i < 9; i++) await hub.browser("mehroz").post("/pair/tailnet", { label: `s${i}` });
    const live = hub.svc.store.sessions("mehroz").filter((s) => s.pending && !s.revokedAt);
    expect(live.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("2. deny by default survives in the server role", () => {
  test("unclassified /__* paths (Vite's /__open-in-editor, a route nobody classified) are refused to a confirmed founder", () => {
    for (const path of ["/__open-in-editor?file=C:/x.txt", "/__totally_unknown_route", "/__vite_ping", "/__brand_new/x"])
      for (const method of ["GET", "POST"]) {
        const r = rig.decide("paired-founder", method, path);
        expect([method, path, r.status, r.reached]).toEqual([method, path, 403, false]);
        expect(pc.decide("paired-founder", method, path).status).toBe(403); // as in pc
      }
    // The loopback owner with the proof keeps today's access to them.
    expect(rig.decide("loopback-owner", "GET", "/__open-in-editor?file=x").status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("3. the 501 gate is not bypassed by case or a dot suffix", () => {
  const forms = [
    "/__OPERATOR/screen/act", "/__Operator/browser/act", "/__operator/PC/act", "/__OPERATOR/open-url", "/__operator/screen/act.x", "/__operator/browser/act.json", "/__operator/screen/act/x",
    "/__FISH_TTS", "/__fish_tts.x", "/__Fish_Tts/x", "/__START_VOICE", "/__start_voice.x", "/__Start_Voice/y",
  ];
  const run = (role: "pc" | "cloud" | "server", url: string) => {
    let nexted = false;
    const res: any = { statusCode: 200, setHeader() {}, end() {} };
    hubRoleGate(role)({ url } as never, res, () => (nexted = true));
    return nexted ? "next" : res.statusCode;
  };
  test("server and cloud answer 501 for every form; pc passes them through", () => {
    for (const url of forms) {
      expect([url, "server", run("server", url)]).toEqual([url, "server", 501]);
      expect([url, "cloud", run("cloud", url)]).toEqual([url, "cloud", 501]);
      expect([url, "pc", run("pc", url)]).toEqual([url, "pc", "next"]);
    }
  });
  test("the CLI-agent group follows the same boundary in cloud (case and dot), and stays available in server", () => {
    for (const url of ["/__CLAUDE_CHAT", "/__claude.json", "/__Hermes_Status", "/__hermes_chat.x", "/__OPERATOR/agent-jobs", "/__operator/agent-jobs.x"]) {
      expect([url, run("cloud", url)]).toEqual([url, 501]);
      expect([url, run("server", url)]).toEqual([url, "next"]);
    }
  });
  test("look-alikes that are not the route are untouched", () => {
    for (const url of ["/__operator/screen/command", "/__operator/screen/actx", "/__fish_ttsx", "/__start_voicex", "/__operator/browser/actx"]) expect([url, run("server", url)]).toEqual([url, "next"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("4. duplicate mu_session cookies cannot lock a founder out (S2: junk is skipped, not counted)", () => {
  const good = () => encodeURIComponent(rig.pairedCookie);
  /** A well-formed but unsigned cookie: 43 chars, a dot, 43 chars. It passes the shape check and fails the signature. */
  const forged = (i: number) => `${String(i).padStart(43, "f")}.${String(i).padStart(43, "g")}`;
  const cookieHeader = (...values: string[]) => values.map((v) => `mu_session=${v}`).join("; ");
  test("sessionCookieValues keeps only well-formed values, in order, de-duplicated, capped at 32", () => {
    const one = forged(1);
    expect(sessionCookieValues(`a=1; mu_session=junk; mu_session=${one}; mu_session=${one}; mu_session=a.b; other=2`)).toEqual([one]);
    expect(sessionCookieValues(undefined)).toEqual([]);
    expect(sessionCookieValues(cookieHeader(...Array.from({ length: 60 }, (_, i) => forged(i)))).length).toBe(MAX_SESSION_COOKIES);
    expect(MAX_SESSION_COOKIES).toBe(32);
  });
  test("a junk cookie ahead of (or behind) the valid one does not sign the founder out, on shared and local-owner routes", () => {
    for (const cookie of [cookieHeader("junk", good()), cookieHeader(good(), "junk"), cookieHeader("a.b", "junk2", good())]) {
      expect([cookie.slice(0, 20), rig.decide("paired-founder", "GET", "/__operator/leads", { cookie }).status]).toEqual([cookie.slice(0, 20), 200]);
      expect([cookie.slice(0, 20), rig.decide("paired-founder", "POST", "/__claude_chat", { cookie }).status]).toEqual([cookie.slice(0, 20), 200]);
    }
  });
  test("many malformed cookies ahead of the real one (a preview port can plant several per path level) still do not lock him out", () => {
    for (const n of [8, 20, 100, 500]) {
      const junk = Array.from({ length: n }, (_, i) => `junk${i}`);
      const cookie = cookieHeader(...junk, good());
      expect([n, rig.decide("paired-founder", "GET", "/__operator/leads", { cookie }).status]).toEqual([n, 200]);
      expect([n, rig.decide("paired-founder", "POST", "/__claude_chat", { cookie }).status]).toEqual([n, 200]);
    }
  });
  test("well-formed but forged cookies count toward the cap of 32: 31 ahead is fine, 32 ahead pushes the real one out", () => {
    const ahead = (n: number) => Array.from({ length: n }, (_, i) => forged(i));
    expect(rig.decide("paired-founder", "POST", "/__claude_chat", { cookie: cookieHeader(...ahead(31), good()) }).status).toBe(200);
    expect(rig.decide("paired-founder", "POST", "/__claude_chat", { cookie: cookieHeader(...ahead(32), good()) }).status).toBe(401);
  });
  test("only junk is still signed out (dead), and another founder's valid cookie is still never adopted", () => {
    expect(rig.decide("paired-founder", "GET", "/__operator/leads", { cookie: "mu_session=junk; mu_session=junk2" }).status).toBe(401);
    expect(rig.decide("paired-founder", "GET", "/__operator/leads", { cookie: cookieHeader(forged(1), forged(2)) }).status).toBe(401);
    expect(rig.decide("tailnet-founder", "POST", "/__claude_chat", { "tailscale-user-login": "owner@example.test", cookie: cookieHeader("junk", good()) }).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("5. persona writes are console-only, reads stay open", () => {
  test("PUT, DELETE and POST to /__hermes_pantheon* are refused to a confirmed founder; GET works", () => {
    for (const path of ["/__hermes_pantheon/someid", "/__hermes_pantheon", "/__hermes_pantheon_sync", "/__hermes_pantheon_templates", "/__hermes_pantheon/install", "/__hermes_pantheon/create"])
      for (const method of ["PUT", "DELETE", "POST", "PATCH"]) {
        const r = rig.decide("paired-founder", method, path);
        expect([method, path, r.status, r.body?.reason]).toEqual([method, path, 403, "console-only"]);
      }
    for (const path of ["/__hermes_pantheon", "/__hermes_pantheon/someid", "/__hermes_pantheon_templates", "/__hermes_pantheon_sync", "/__hermes_pantheon/validate"]) expect([path, rig.decide("paired-founder", "GET", path).status]).toEqual([path, 200]);
    expect(rig.decide("paired-founder", "POST", "/__hermes_pantheon/validate").status).toBe(403); // validate is a POST in the app: refused with the other writes (a console action)
    expect(consoleOnlyRule("/__hermes_pantheon/x", undefined, "DELETE")?.key).toBe("/__hermes_pantheon");
    expect(consoleOnlyRule("/__hermes_pantheon/x", undefined, "GET")).toBeNull();
    // The owner with the proof is unaffected.
    expect(rig.decide("loopback-owner", "DELETE", "/__hermes_pantheon/someid").status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("6. publishing: lead-site deploy/takedown and design publish go through B2 (not console-only)", () => {
  test("the gate lets a confirmed founder reach /__lead-sites/deploy and /takedown (the route then demands a B2 approval), and the whole /__lead-sites family", () => {
    for (const path of ["/__lead-sites/deploy", "/__lead-sites/takedown", "/__lead-sites/generate", "/__lead-sites/status"])
      for (const method of ["GET", "POST"]) expect([method, path, rig.decide("paired-founder", method, path).status]).toEqual([method, path, 200]);
    for (const path of Object.keys(APPROVAL_GATED)) expect(consoleOnlyRule(path, undefined, "POST")).toBeNull();
    // A bare Tailscale login still gets nothing here.
    expect(rig.decide("tailnet-founder", "POST", "/__lead-sites/deploy").status).toBe(403);
  });
  test("social publishing (/__design_publish) is open to a confirmed founder at the gate, in APPROVAL_GATED, and no longer console-only", () => {
    for (const method of ["POST", "GET"]) expect([method, rig.decide("paired-founder", method, "/__design_publish").status]).toEqual([method, 200]);
    expect(Object.keys(APPROVAL_GATED)).toContain("/__design_publish");
    expect(consoleOnlyRule("/__design_publish", undefined, "POST")).toBeNull();
    expect(rig.decide("loopback-owner", "POST", "/__design_publish").status).toBe(200);
    // A bare Tailscale login (a process) still gets nothing.
    expect(rig.decide("tailnet-founder", "POST", "/__design_publish").status).toBe(403);
  });
  test("the three categories are explicit", () => {
    expect(Object.keys(SERVER_ROLE_CATEGORIES)).toEqual(["personal-desktop-control", "server-side-work", "publishing-outward"]);
    expect(SERVER_ROLE_CATEGORIES["publishing-outward"]).toMatch(/B2 approval/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("unknown /__* routes fail closed in the server role for every caller kind", () => {
  test("only the owner WITH the local-owner proof reaches an unclassified path; no other kind, method or spelling does", async () => {
    const { CALLER_KINDS } = await import("./role-matrix");
    for (const path of ["/__open-in-editor?file=x", "/__totally_unknown_route", "/__OPEN-IN-EDITOR", "/__brand_new.json", "/__claude_x", "/__design_new_writer", "/__operatorx"])
      for (const method of ["GET", "POST", "PUT", "DELETE"])
        for (const kind of CALLER_KINDS) {
          const r = rig.decide(kind, method, path);
          const owner = kind === "loopback-owner";
          expect([kind, method, path, r.reached]).toEqual([kind, method, path, owner]);
        }
    // And the owner WITHOUT the proof is nobody.
    expect(rig.decide("loopback-owner", "GET", "/__totally_unknown_route", {}, undefined, { proof: "none" }).reached).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("second review: notes N1, N2 and the WebSocket viewer", () => {
  test("N1: a #fragment is not part of the path: the 501 gate and the identity gate both strip it", () => {
    const run = (role: "pc" | "cloud" | "server", url: string) => {
      let nexted = false;
      const res: any = { statusCode: 200, setHeader() {}, end() {} };
      hubRoleGate(role)({ url } as never, res, () => (nexted = true));
      return nexted ? "next" : res.statusCode;
    };
    for (const url of ["/__fish_tts#x", "/__OPERATOR/screen/act#frag", "/__start_voice?a=1#x", "/__operator/browser/act#"]) {
      expect([url, run("server", url)]).toEqual([url, 501]);
      expect([url, run("cloud", url)]).toEqual([url, 501]);
      expect([url, run("pc", url)]).toEqual([url, "next"]);
    }
    // The identity gate classifies the path without the fragment: a console-only route cannot be spelled around.
    expect(rig.decide("paired-founder", "POST", "/__design_set_key#x").status).toBe(403);
    expect(rig.decide("paired-founder", "POST", "/__design_set_key?x=1#y").status).toBe(403);
    expect(rig.decide("paired-founder", "POST", "/__totally_unknown#x").status).toBe(403);
  });

  test("N2: GET /__dev_restart (answered before the gate) is data-free to a loopback caller without the local-owner proof in the server role", async () => {
    const { devRestartPolicy } = await import("../dev-restart-policy");
    const dir = mkdtempSync(join(tmpdir(), "dev-restart-"));
    try {
      const proof = createLocalOwnerProof(dir, { MU_LOCAL_OWNER_TOKEN_FILE: join(dir, "t") });
      const token = require("node:fs").readFileSync(proof.path, "utf8").trim();
      const middlewares: Array<(req: any, res: any, next: () => void) => void> = [];
      (devRestartPolicy({ root: dir, quietMs: 10_000, env: { MU_HUB_ROLE: "server" }, localOwnerProof: proof, log: () => {} }) as any).configureServer({ middlewares: { use: (fn: never) => middlewares.push(fn) }, restart: async () => {}, config: { logger: { info() {} } }, watcher: { on() {} }, httpServer: { once() {} } });
      const ask = (headers: Record<string, string>) => {
        let body = "";
        const res = { statusCode: 200, setHeader() {}, end: (b: string) => (body = b) };
        middlewares[0]({ url: "/__dev_restart", method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:8081", ...headers } }, res, () => {});
        return { status: res.statusCode, body };
      };
      const denied = ask({});
      expect(denied.status).toBe(403);
      expect(denied.body).toBe(JSON.stringify({ error: "Local access only" })); // data-free: no pending, no waitingFor
      expect(ask({ authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).status).toBe(403);
      const ok = ask({ "x-mu-local-owner": token });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ pending: false });
      // The headers were only peeked at: the gate that follows still sees the proof.
      const headers: Record<string, string> = { host: "127.0.0.1:8081", "x-mu-local-owner": token };
      middlewares[0]({ url: "/__operator/state", method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers }, { setHeader() {}, once() {}, end() {} }, () => {});
      expect(headers["x-mu-local-owner"]).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the VNC viewer upgrade needs a confirmed human session: a loopback caller with no hub session cookie, or a bare Tailscale login, is refused 401", async () => {
    const { upgradeViewer } = await import("../computers/viewer");
    const hub = await startHub({ hubRole: "server" });
    try {
      const writes: string[] = [];
      const socket: any = { write: (s: string) => writes.push(s), destroy() {} };
      const attempt = async (headers: Record<string, string>) => {
        writes.length = 0;
        await upgradeViewer({ devices: hub.svc, computers: {} as never }, {} as never, "bot-1", { url: "/__computers/bot-1/vnc", headers, socket: { remoteAddress: "127.0.0.1" } } as never, socket, Buffer.alloc(0));
        return writes.join("");
      };
      expect(await attempt({ host: "127.0.0.1:8081" })).toMatch(/^HTTP\/1\.1 401/); // a process at loopback
      expect(await attempt({ host: "127.0.0.1:8081", authorization: "Bearer sk-local-dummy" })).toMatch(/^HTTP\/1\.1 401/);
      expect(await attempt({ ...hub.headersFor("mehroz") })).toMatch(/^HTTP\/1\.1 401/); // a bare Tailscale login
      // A pending (unconfirmed) session is not human either.
      const pending = hub.svc.store.mintSession("mehroz", "x", "tailnet", { pending: true });
      expect(await attempt({ ...hub.headersFor("mehroz"), cookie: `mu_session=${encodeURIComponent(pending.cookie)}` })).toMatch(/^HTTP\/1\.1 401/);
      // A hub session minted by a navigation is pending until confirmed, so a local program that forged one is no better.
      const forged = hub.svc.store.mintSession("usman", "x", "hub", { pending: true });
      expect(await attempt({ host: "127.0.0.1:8081", cookie: `mu_session=${encodeURIComponent(forged.cookie)}` })).toMatch(/^HTTP\/1\.1 401/);
    } finally {
      await hub.close();
    }
  });
});
