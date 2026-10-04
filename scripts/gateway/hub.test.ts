import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrincipal } from "../approvals/principal";
import { devicesPrincipal } from "../devices/identity";
import { DeviceStore } from "../devices/store";
import { createPrincipalGate, founderMayRead, refuseUnlessAtThisPc, requestAtHub, requestPrincipal } from "../identity/gate";
import { createLocalOwnerProof } from "../identity/local-owner-token";
import { isAtHub, isHumanSession, pageTokenFor } from "../identity/principal";
import { ROUTES, routeClass } from "../identity/routes";
import { syntheticTailnetForTests } from "../remote-access";
import { signAssertion } from "./assertion";
import { ASSERTION_HEADER, FILES, VIA_VALUE } from "./config";
import { createGatewayTrust } from "./hub";
import { CAPABILITIES, decide, METHODS } from "./policy";

/**
 * The hub's half of the trust boundary, through the REAL identity gate in the server role (no network: request objects,
 * as scripts/identity/role-matrix.ts does). The gateway process is not involved: everything here is what a caller on the
 * hub's own loopback could try.
 */

const INTERNAL = "hub-test-internal-token";
const TAILNET = "hub-test.tail-test.ts.net";
const root = mkdtempSync(join(tmpdir(), "gw-hub-"));
mkdirSync(join(root, ".operator-data"));
writeFileSync(join(root, ".operator-data", "people.json"), JSON.stringify({ people: [{ name: "Usman", tailscale: ["owner@example.test"] }, { name: "Mehroz", tailscale: ["partner@example.test"] }] }));
const dir = join(root, ".operator-data", "gateway");
const store = new DeviceStore(root);
const pairedCookie = store.mintSession("mehroz", "Mehroz's phone", "tailnet").cookie;
const proof = createLocalOwnerProof(root, { MU_LOCAL_OWNER_TOKEN_FILE: join(root, "local-owner.token") });
const ownerToken = readFileSync(join(root, "local-owner.token"), "utf8").trim();
const tailnet = syntheticTailnetForTests(TAILNET, ["100.64.0.1"]);
const makeGate = (enabled: boolean) =>
  createPrincipalGate({ root, internalToken: () => INTERNAL, store, tailnetName: TAILNET, servePeer: () => true, tailnet, role: "server", localOwnerProof: proof, gateway: createGatewayTrust({ root, internalToken: () => INTERNAL, enabled, dir }) });
const gate = makeGate(true);
const gateOff = makeGate(false);
const key = readFileSync(join(dir, FILES.secret), "utf8").trim();

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});

type Opts = { caps?: string[]; remote?: string; headers?: Record<string, string>; assertion?: string | null; useGate?: typeof gate; signMethod?: string; signTarget?: string };
function call(method: string, url: string, opts: Opts = {}) {
  const caps = opts.caps ?? ["view"];
  const assertion = opts.assertion === undefined ? signAssertion(key, { method: opts.signMethod ?? method, target: opts.signTarget ?? url, sessionId: "cd".repeat(12), caps, delegatedBy: "usman" }) : opts.assertion;
  const headers: Record<string, string> = { host: "127.0.0.1:8081", via: VIA_VALUE, ...(assertion ? { [ASSERTION_HEADER]: assertion } : {}), ...(opts.headers ?? {}) };
  // `via: ""` in a test's headers means "no Via header at all".
  if (headers.via === "") delete headers.via;
  const req = { url, method, headers, socket: { remoteAddress: opts.remote ?? "127.0.0.1" } } as unknown as IncomingMessage;
  const out = { status: 200, reached: false, body: null as unknown, req };
  const res = {
    statusCode: 200,
    setHeader() {},
    getHeader: () => undefined,
    end(text?: string) {
      out.body = text ? JSON.parse(text) : null;
    },
  } as unknown as ServerResponse;
  (opts.useGate ?? gate)(req, res, () => (out.reached = true));
  out.status = out.reached ? 200 : (res as unknown as { statusCode: number }).statusCode;
  return out;
}

describe("a verified gateway request is Dot, and only Dot", () => {
  test("the principal: person dot, via gateway, a process; never a founder, the owner, at the hub, or a human session", () => {
    const r = call("GET", "/__workspace/pipeline");
    expect(r.status).toBe(200);
    const p = requestPrincipal(r.req, { root })!;
    expect(p).toMatchObject({ personId: "dot", via: "gateway", actor: "process", displayName: "Dot", capabilities: ["view"], delegatedBy: "usman" });
    expect([isAtHub(p), isHumanSession(p), requestAtHub(r.req, { root }), founderMayRead(r.req, { root })]).toEqual([false, false, false, true]);
    expect(refuseUnlessAtThisPc(r.req, "hub only", { root })).toEqual({ status: 403, error: "hub only" });
    // B2 and the devices module refuse it structurally.
    expect(isPrincipal(p)).toBe(false);
    expect(devicesPrincipal(p)).toBeNull();
    // The assertion is gone before any handler runs.
    expect(r.req.headers[ASSERTION_HEADER]).toBeUndefined();
  });

  test("writes are handed Dot's own page token (never the internal one); reads get none; a browser-sent token is discarded", () => {
    const read = call("GET", "/__workspace/pipeline", { headers: { "x-claude-os-token": INTERNAL, cookie: `mu_session=${pairedCookie}`, authorization: `Bearer ${ownerToken}` } });
    expect(read.status).toBe(200);
    expect(read.req.headers["x-claude-os-token"]).toBeUndefined();
    expect(read.req.headers.cookie).toBeUndefined();
    expect(read.req.headers.authorization).toBeUndefined();
    const write = call("POST", "/__gateway/crm/activity", { caps: ["view", "crm.write"], headers: { "x-claude-os-token": INTERNAL } });
    expect(write.status).toBe(200);
    const p = requestPrincipal(write.req, { root })!;
    expect(write.req.headers["x-claude-os-token"]).toBe(pageTokenFor(p, INTERNAL));
    expect(write.req.headers["x-claude-os-token"]).not.toBe(INTERNAL);
  });

  test("the hub enforces the capability table itself: with every capability, local-owner, self and unlisted routes are refused", () => {
    const all = [...CAPABILITIES];
    const reached: string[] = [];
    for (const route of Object.keys(ROUTES))
      for (const method of METHODS) {
        const r = call(method, route, { caps: all });
        if (r.status === 200) reached.push(`${method} ${route}`);
        if (r.status === 200) expect(routeClass(route, method)).toBe("shared");
        else expect([method, route, r.status]).toEqual([method, route, 403]);
      }
    expect(reached.every((k) => decide(k.split(" ")[0], k.split(" ")[1]).ok)).toBe(true);
    // A capability the assertion does not carry is refused at the hub even though the gateway would never send it.
    expect(call("POST", "/__gateway/crm/activity", { caps: ["view"] }).status).toBe(403);
    expect(call("POST", "/__operator/coding/jobs", { caps: ["view", "crm.write"] }).status).toBe(403);
    for (const p of ["/__devices/me", "/__token", "/__claude_chat", "/__hermes_cmd", "/__design_set_key", "/__memory_note", "/__approvals/x/decide"]) expect([p, call("POST", p, { caps: all }).status]).toEqual([p, 403]);
  });

  test("Workspace panels at the hub: pipeline, websites and groups only; mail, calls, enquiries, today, needs-you and the all-panels route are refused with every capability", () => {
    const all = [...CAPABILITIES];
    for (const p of ["/__workspace/pipeline", "/__workspace/websites", "/__workspace/groups"]) expect([p, call("GET", p, { caps: all }).status]).toEqual([p, 200]);
    for (const p of ["/__workspace", "/__workspace/email", "/__workspace/receptionist", "/__workspace/enquiries", "/__workspace/call-queue", "/__workspace/today", "/__workspace/needs-you", "/__workspace/email/", "/__workspace/Email", "/__workspace/new-panel"])
      for (const m of ["GET", "HEAD", "POST"]) expect([m, p, call(m, p, { caps: all }).status]).toEqual([m, p, 403]);
    // No WebSocket and no computers read for the gateway principal, as a request or as an upgrade.
    for (const p of ["/__computers", "/__computers/bot-1/screenshot", "/__computers/bot-1/vnc"]) expect([p, call("GET", p, { caps: all }).status]).toEqual([p, 403]);
  });

  test("no non-/__ path, ever: the dev server's pages, source and files are refused to the gateway principal, validly signed or not", () => {
    for (const p of ["/", "/leads", "/src/main.tsx", "/@vite/client", "/@id/C:/x/secret.txt?raw", "/@fs/C:/Windows/win.ini", "/node_modules/.vite/deps/_metadata.json", "/.env", "/src/data/live-data.json", "/docs/x.md", "/memory/notes.md?raw", "/favicon.svg"])
      for (const m of ["GET", "HEAD", "POST"]) expect([m, p, call(m, p, { caps: [...CAPABILITIES] }).status]).toEqual([m, p, 403]);
  });

  test("the strict target rule at the hub: NTFS streams, colons, trailing dots or spaces, NUL and encoded separators", () => {
    for (const p of ["/__workspace::$DATA", "/__workspace:x", "/__workspace.", "/__workspace%20", "/__workspace/a.", "/__workspace/%2e%2e", "/__workspace%3a", "/__workspace?x=%00", "/src/data/live-data.json::$DATA"])
      expect([p, call("GET", p).status]).toEqual([p, 403]);
    expect(call("GET", "/__workspace/pipeline").status).toBe(200);
  });
});

describe("an assertion that does not verify is refused, never ignored", () => {
  test("forged, wrong key, wrong method or target, stale, replayed", () => {
    expect(call("GET", "/__workspace/pipeline", { assertion: "v1.forged.forged" }).status).toBe(401);
    expect(call("GET", "/__workspace/pipeline", { assertion: signAssertion("not-the-key".repeat(4), { method: "GET", target: "/__workspace/pipeline", sessionId: "cd".repeat(12), caps: ["view"] }) }).status).toBe(401);
    expect(call("POST", "/__gateway/crm/activity", { caps: ["view", "crm.write"], signMethod: "GET" }).status).toBe(401);
    expect(call("GET", "/__hermes_cmd", { signTarget: "/__workspace/pipeline" }).status).toBe(401);
    expect(call("GET", "/__workspace/pipeline", { assertion: signAssertion(key, { method: "GET", target: "/__workspace/pipeline", sessionId: "cd".repeat(12), caps: ["view"], now: Date.now() - 120_000 }) }).status).toBe(401);
    const once = signAssertion(key, { method: "GET", target: "/__workspace/pipeline", sessionId: "cd".repeat(12), caps: ["view"] });
    expect(call("GET", "/__workspace/pipeline", { assertion: once }).status).toBe(200);
    expect(call("GET", "/__workspace/pipeline", { assertion: once }).status).toBe(401);
    // A capability the policy does not know is not smuggled in by a correctly signed assertion either.
    expect(call("GET", "/__workspace/pipeline", { caps: ["view", "owner"] }).status).toBe(401);
  });

  test("only on loopback, only with the gateway's Via, never alongside anything Tailscale stamped", () => {
    expect(call("GET", "/__workspace/pipeline", { remote: "192.168.1.20" }).status).toBe(401);
    expect(call("GET", "/__workspace/pipeline", { headers: { via: "1.1 someone-else" } }).status).toBe(401);
    expect(call("GET", "/__workspace/pipeline", { headers: { host: `${TAILNET}:8443`, "tailscale-user-login": "partner@example.test" } }).status).toBe(401);
  });

  test("trust off (the default): any assertion is refused, and a founder is never helped or hurt by one", () => {
    expect(call("GET", "/__workspace/pipeline", { useGate: gateOff }).status).toBe(401);
    // A paired founder through Serve, with a junk assertion attached: refused outright, not quietly treated as the founder.
    const founder = { host: `${TAILNET}:8443`, "tailscale-user-login": "partner@example.test", "x-forwarded-for": "100.64.0.9", cookie: `mu_session=${encodeURIComponent(pairedCookie)}` };
    expect(call("GET", "/__workspace/pipeline", { assertion: "junk", headers: { ...founder, via: "" } }).status).toBe(401);
    // Without one, the founder is exactly who they were (the full matrix is scripts/identity/server-role.test.ts).
    const plain = call("GET", "/__workspace/pipeline", { assertion: null, headers: { ...founder, via: "" } });
    expect(plain.status).toBe(200);
    expect(requestPrincipal(plain.req, { root })).toMatchObject({ personId: "mehroz", via: "paired-session", actor: "human" });
    // And the owner's loopback proof still makes the owner, unaffected by the gateway being on.
    const owner = call("GET", "/__claude_chats", { assertion: null, headers: { via: "", "x-mu-local-owner": ownerToken } });
    expect(owner.status).toBe(200);
    expect(requestPrincipal(owner.req, { root })).toMatchObject({ personId: "usman", via: "loopback-owner" });
  });

  test("the kill switch file makes the hub refuse even a valid assertion", () => {
    writeFileSync(join(dir, FILES.kill), "test\n");
    try {
      expect(call("GET", "/__workspace/pipeline").status).toBe(503);
    } finally {
      rmSync(join(dir, FILES.kill), { force: true });
    }
    expect(call("GET", "/__workspace/pipeline").status).toBe(200);
  });
});
