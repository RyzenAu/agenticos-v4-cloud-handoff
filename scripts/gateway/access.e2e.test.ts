import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCrmOperations } from "../crm/ops";
import { CrmStore } from "../crm/store";
import { signAssertion } from "./assertion";
import { readAudit } from "./audit";
import { runCli } from "./cli";
import { ACCESS_TOKEN_PREFIX, ASSERTION_HEADER, FILES, LIMITS, RECONNECT_KEY_PREFIX, SESSION_COOKIE_NAME, VIA_VALUE } from "./config";
import { startGateway, type Gateway } from "./server";
import { freePort, startRigHub, type RigHub } from "./test-rig";

/**
 * End to end: Dot's identity through the REAL gateway (in process) in front of a throwaway hub with the REAL identity gate,
 * the real gateway trust check and the real CRM operations on an in-memory store. Enrol, reconnect in a new task, renew,
 * bearer access for Dot's own programs, a real write through all three checks, and revocation that is immediate at the
 * gateway and at the hub. Loopback only; synthetic everything.
 */

setDefaultTimeout(60_000);

let hub: RigHub;
let gateway: Gateway;
let origin = "";
const crmStore = new CrmStore(new Database(":memory:"));
const crmOps = createCrmOperations({ store: crmStore });
/** Every secret this run handled, to prove none is written down anywhere. */
const secrets: string[] = [];
const lines: string[] = [];
let ipCounter = 10;
const nextIp = () => `198.51.100.${ipCounter++}`;

const cli = (...argv: string[]) => {
  const out: string[] = [];
  const code = runCli(argv, hub.dir, (l) => out.push(l));
  return { code, text: out.join("\n") };
};
function mintCode(...extra: string[]) {
  const code = /code for Dot: ([A-Z0-9-]+)/.exec(cli("enrol-code", "--by", "usman", ...extra).text)![1];
  secrets.push(code, code.replace(/-/g, ""));
  return code;
}
type Call = { method?: string; cookie?: string; bearer?: string; headers?: Record<string, string>; body?: unknown; ip?: string };
async function gw(path: string, call: Call = {}) {
  const headers: Record<string, string> = { "X-Forwarded-For": call.ip ?? "198.51.100.5", ...(call.cookie ? { Cookie: `${SESSION_COOKIE_NAME}=${call.cookie}` } : {}), ...(call.bearer ? { Authorization: `Bearer ${call.bearer}` } : {}), ...(call.headers ?? {}) };
  let body: string | undefined;
  if (call.body !== undefined) {
    body = typeof call.body === "string" ? call.body : JSON.stringify(call.body);
    headers["Content-Type"] ??= "application/json";
  }
  const res = await fetch(origin + path, { method: call.method ?? "GET", headers, body, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a page */
  }
  return { status: res.status, json, text, res };
}
const cookieFrom = (res: Response) => {
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([A-Za-z0-9_-]{43})`).exec(res.headers.getSetCookie().join("\n"));
  if (m) secrets.push(m[1]);
  return m ? m[1] : null;
};
const ENROL = { "X-MU-Gateway-Enrol": "1" };
/** Sign in from the gateway's own page (a browser): the cookie, the identity and the reconnect key shown once. */
async function enrolBrowser(...flags: string[]) {
  const r = await gw("/gw/enrol", { method: "POST", ip: nextIp(), headers: { Origin: origin, ...ENROL }, body: { code: mintCode(...flags) } });
  expect(r.status).toBe(200);
  secrets.push(r.json.reconnectKey);
  return { cookie: cookieFrom(r.res)!, reconnectKey: r.json.reconnectKey as string, identity: r.json.identity as { id: string; expiresAt: number }, access: r.json.access };
}
/** New access from the reconnect key, as Dot's own program asks for it (no browser, no Origin): a bearer token. */
async function renewBearer(reconnectKey: string) {
  const r = await gw("/gw/renew", { method: "POST", ip: nextIp(), headers: ENROL, body: { reconnectKey, mode: "bearer" } });
  if (r.status === 200) secrets.push(r.json.access.accessToken, String(r.json.access.accessToken).slice(ACCESS_TOKEN_PREFIX.length));
  return r;
}

beforeAll(async () => {
  hub = await startRigHub({ operate: { crm: () => crmOps as never } });
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  gateway = startGateway({ dir: hub.dir, port, upstream: hub.origin, publicOrigin: origin, forwardedFor: true, recheckMs: 100, log: (l) => void lines.push(l) });
});
afterAll(async () => {
  await gateway?.stop();
  await hub?.close();
});

describe("enrol: a one-time code becomes Dot's identity", () => {
  test("the sign-in answer carries the reconnect key once, the identity and when access ends; the code is spent", async () => {
    const code = mintCode("--label", "Dot (cloud browser)", "--identity-days", "7");
    const r = await gw("/gw/enrol", { method: "POST", ip: nextIp(), headers: { Origin: origin, ...ENROL }, body: { code } });
    expect(r.status).toBe(200);
    secrets.push(r.json.reconnectKey);
    expect(r.json.reconnectKey).toMatch(new RegExp(`^${RECONNECT_KEY_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(r.json.identity).toMatchObject({ label: "Dot (cloud browser)", enrolledBy: "usman" });
    expect(r.json.identity.expiresAt - r.json.identity.createdAt).toBe(7 * 86_400_000);
    expect(r.json.access).toMatchObject({ mode: "cookie", idleMinutes: LIMITS.idleMinutesDefault });
    expect(r.json.access.accessToken).toBeUndefined(); // a browser gets the HttpOnly cookie, never the token in a body
    const cookie = cookieFrom(r.res)!;
    expect(r.res.headers.get("cache-control")).toContain("no-store");
    const me = await gw("/gw/me", { cookie });
    expect(me.json).toMatchObject({ person: "dot", identity: { id: r.json.identity.id, label: "Dot (cloud browser)" }, session: { mode: "cookie" }, renew: { path: "/gw/renew" } });
    expect(me.text).not.toContain(r.json.reconnectKey);
    // The same code again: refused, and it tells nothing.
    const again = await gw("/gw/enrol", { method: "POST", ip: nextIp(), headers: { Origin: origin, ...ENROL }, body: { code } });
    expect(again.status).toBe(401);
    expect(again.json.reconnectKey).toBeUndefined();
    // The founder's console lists it, and nothing it prints is a secret.
    expect(cli("identities").text).toContain(r.json.identity.id);
    // The sign-in page offers the code form and the reconnect form, with a strict CSP.
    const page = await gw("/gw/enrol");
    expect(page.text).toContain("One-time code");
    expect(page.text).toContain("reconnect key");
    expect(page.res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("reconnect and renew", () => {
  test("a new task (no cookie) gets new access with the reconnect key; the browser form needs the gateway's own page", async () => {
    const first = await enrolBrowser();
    // A new browser session, on the sign-in page: cookie mode needs Origin (it sets a cookie), the custom header and JSON.
    const renewed = await gw("/gw/renew", { method: "POST", ip: nextIp(), headers: { Origin: origin, ...ENROL }, body: { reconnectKey: first.reconnectKey } });
    expect(renewed.status).toBe(200);
    const cookie2 = cookieFrom(renewed.res)!;
    expect(cookie2).not.toBe(first.cookie);
    expect(renewed.json.identity.id).toBe(first.identity.id);
    expect(renewed.json.reconnectKey).toBeUndefined(); // the key is shown once, at enrolment
    expect((await gw("/__version", { cookie: cookie2 })).status).toBe(200);
    expect((await gw("/__version", { cookie: first.cookie })).status).toBe(200); // an earlier task's access is not cut off by a new one
    for (const [headers, body, status] of [
      [{ ...ENROL }, { reconnectKey: first.reconnectKey }, 403], // cookie mode without Origin
      [{ Origin: origin }, { reconnectKey: first.reconnectKey }, 403], // no custom header
      [{ Origin: "https://evil.example", ...ENROL }, { reconnectKey: first.reconnectKey }, 403],
      [{ Origin: origin, ...ENROL }, { reconnectKey: `${RECONNECT_KEY_PREFIX}${"A".repeat(43)}` }, 401],
      [{ Origin: origin, ...ENROL }, { reconnectKey: first.cookie }, 401],
      [{ Origin: origin, ...ENROL }, {}, 401],
      [{ Origin: origin, ...ENROL, "Content-Type": "text/plain" }, JSON.stringify({ reconnectKey: first.reconnectKey }), 403],
    ] as const)
      expect([JSON.stringify(headers).slice(0, 60), (await gw("/gw/renew", { method: "POST", ip: nextIp(), headers, body })).status]).toEqual([JSON.stringify(headers).slice(0, 60), status]);
    expect((await gw("/gw/renew", { ip: nextIp() })).status).toBe(405);
  });

  test("expired access is renewed with the key; the expired token stays dead", async () => {
    const first = await enrolBrowser("--session-minutes", "0.03"); // about two seconds of access
    expect((await gw("/__version", { cookie: first.cookie })).status).toBe(200);
    await Bun.sleep(2_200);
    const dead = await gw("/__version", { cookie: first.cookie });
    expect([dead.status, dead.json.reason, dead.json.renew]).toEqual([401, "expired", "/gw/renew"]);
    const renewed = await renewBearer(first.reconnectKey);
    expect(renewed.status).toBe(200);
    expect((await gw("/__version", { bearer: renewed.json.access.accessToken })).status).toBe(200);
    expect((await gw("/__version", { cookie: first.cookie })).status).toBe(401);
  });

  test("wrong reconnect keys are rate limited and never lock Dot's real key out", async () => {
    const first = await enrolBrowser();
    const ip = nextIp();
    let limited = 0;
    for (let i = 0; i < LIMITS.renewAttemptsPerIpPerMinute + 3; i++) {
      const r = await gw("/gw/renew", { method: "POST", ip, headers: ENROL, body: { reconnectKey: `${RECONNECT_KEY_PREFIX}${"B".repeat(43)}`, mode: "bearer" } });
      if (r.status === 429) limited++;
      else expect(r.status).toBe(401);
    }
    expect(limited).toBeGreaterThanOrEqual(3);
    // From another address, the real key still works: guesses burn nothing.
    expect((await renewBearer(first.reconnectKey)).status).toBe(200);
  }, 120_000);
});

describe("bearer access for Dot's own programs", () => {
  test("a bearer token reads and writes without a cookie or CSRF token; it is never a cookie, and a cookie is never a bearer", async () => {
    const first = await enrolBrowser();
    const r = await renewBearer(first.reconnectKey);
    expect(r.status).toBe(200);
    expect(r.res.headers.getSetCookie()).toEqual([]);
    const token = r.json.access.accessToken as string;
    expect(token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect((await gw("/gw/me", { bearer: token })).json).toMatchObject({ person: "dot", session: { mode: "bearer" }, identity: { id: first.identity.id } });
    // Not interchangeable.
    expect((await gw("/__version", { cookie: token.slice(ACCESS_TOKEN_PREFIX.length) })).status).toBe(401);
    expect((await gw("/__version", { bearer: ACCESS_TOKEN_PREFIX + first.cookie })).status).toBe(401);
    // A browser page on another site cannot use it either way: a foreign Origin is refused before the token is looked at.
    expect((await gw("/__version", { bearer: token, headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await gw("/__version", { bearer: token, headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    // An Authorization header that is not the gateway's own token is ignored, and never reaches the hub.
    const seenBefore = hub.seen.length;
    expect((await gw("/__version", { cookie: first.cookie, headers: { Authorization: "Bearer some-other-services-token" } })).status).toBe(200);
    expect(hub.seen.slice(seenBefore).every((s) => !("authorization" in s.headers) && !("cookie" in s.headers))).toBe(true);
    // Sign-in straight to a bearer (Dot's program redeeming the code itself): no Origin needed, the custom header and JSON are.
    const direct = await gw("/gw/enrol", { method: "POST", ip: nextIp(), headers: ENROL, body: { code: mintCode(), mode: "bearer" } });
    expect(direct.status).toBe(200);
    secrets.push(direct.json.reconnectKey, direct.json.access.accessToken);
    expect(direct.res.headers.getSetCookie()).toEqual([]);
    expect((await gw("/gw/enrol", { method: "POST", ip: nextIp(), headers: {}, body: { code: mintCode(), mode: "bearer" } })).status).toBe(403);
  });

  test("a real write through all three checks: the gateway's table, the hub's gate, the route; recorded as Dot's", async () => {
    const first = await enrolBrowser();
    const token = (await renewBearer(first.reconnectKey)).json.access.accessToken as string;
    const create = { name: "crm.company.create", input: { name: "Synthetic Conveyancing Co", locality: "Blacktown" } };
    // Not granted: refused at the gateway, and the hub never hears of it.
    const before = hub.seen.length;
    const refused = await gw("/__gateway/crm/ops", { method: "POST", bearer: token, body: create });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toContain("crm.write");
    expect(hub.seen.length).toBe(before);
    // A founder grants the operating set at the console; the next request has it.
    expect(cli("grant", "operate", "--by", "usman", "--until-identity").code).toBe(0);
    // /gw/me tells Dot when its identity and each grant end, and whether to ask for renewal now.
    const meNow = await gw("/gw/me", { bearer: token });
    expect(meNow.json.expiry.identity).toMatchObject({ id: first.identity.id, renewSoon: false });
    expect(meNow.json.expiry.grants.find((g: { capability: string }) => g.capability === "crm.write").expiresAt).toBe(meNow.json.expiry.identity.expiresAt);
    const made = await gw("/__gateway/crm/ops", { method: "POST", bearer: token, body: create });
    expect(made.status).toBe(200);
    const id = made.json.data.id as string;
    expect(crmStore.snapshot().companies.find((c) => c.id === id)?.name).toBe("Synthetic Conveyancing Co");
    // The reversible update, and the read.
    const changed = await gw("/__gateway/crm/ops", { method: "POST", bearer: token, body: { name: "crm.company.update", input: { id, expectedVersion: made.json.data.version, patch: { locality: "Seven Hills" } } } });
    expect(changed.status).toBe(200);
    const back = await gw("/__gateway/crm/ops", { method: "POST", bearer: token, body: { name: "crm.company.update", input: { id, expectedVersion: changed.json.data.version, patch: { locality: "Blacktown" } } } });
    expect(back.json.data.locality).toBe("Blacktown");
    const read = await gw("/__gateway/crm/read", { method: "POST", bearer: token, body: { name: "crm.record.get", input: { ref: { kind: "company", id } } } });
    expect(read.status).toBe(200);
    // The same through a browser session: the cookie needs the page's Origin and CSRF token (a bearer does not).
    expect((await gw("/__gateway/crm/read", { method: "POST", cookie: first.cookie, body: { name: "crm.snapshot" } })).status).toBe(403);
    const me = await gw("/gw/me", { cookie: first.cookie });
    const rotated = cookieFrom(me.res) ?? first.cookie; // the browser's cookie rotated when its privilege changed
    const csrf = (await gw("/__token", { cookie: rotated })).json.token as string;
    secrets.push(csrf);
    expect((await gw("/__gateway/crm/read", { method: "POST", cookie: rotated, headers: { Origin: origin, "X-Claude-OS-Token": csrf }, body: { name: "crm.snapshot" } })).status).toBe(200);
    // Final actions are still refused with everything granted, here by the gateway route and by the CRM's own guard.
    expect((await gw("/__gateway/crm/ops", { method: "POST", bearer: token, body: { name: "crm.document.create", input: { companyId: id, title: "Invoice", status: "issued" } } })).status).toBe(403);
    expect((await gw("/__gateway/crm/ops", { method: "POST", bearer: token, body: { name: "crm.company.update", input: { id, expectedVersion: back.json.data.version, patch: { emailAllowed: true } } } })).status).toBe(403);
    // The founders' own routes and the identity administration never open, whatever is granted.
    const seen = hub.seen.length;
    for (const [method, path] of [["POST", "/__crm/ops"], ["GET", "/__crm/snapshot"], ["GET", "/__gateway/admin/access"], ["POST", `/__gateway/admin/identities/${first.identity.id}/revoke`], ["POST", "/__approvals/abc/decide"], ["POST", "/__operator/screen/command"], ["POST", "/__memory/remember"], ["GET", "/__devices/me"]] as const)
      expect([path, (await gw(path, { method, bearer: token, body: method === "POST" ? {} : undefined })).status]).toEqual([path, 403]);
    expect(hub.seen.length).toBe(seen);
    // The audit: Dot, the session, the identity, the route TEMPLATE, the capability, the record id, who granted it.
    const audit = readAudit(hub.dir);
    const write = audit.find((e) => e.route === "/__gateway/crm/ops" && e.outcome === "allowed" && e.status === 200)!;
    expect(write).toMatchObject({ person: "dot", identity: first.identity.id, capability: "crm.write", method: "POST", delegatedBy: "usman" });
    expect(write.recordIds).toEqual([id]);
    expect(audit.some((e) => e.event === "renew" && e.identity === first.identity.id)).toBe(true);
    // And the hub's own record of the same actions.
    const hubLog = readdirSync(hub.dir).filter((n) => n.startsWith("hub-actions-")).map((n) => readFileSync(join(hub.dir, n), "utf8")).join("\n");
    expect(hubLog).toContain('"action":"crm.company.create"');
    expect(hubLog).not.toContain("Synthetic Conveyancing Co");
    // What reached the hub's handler: the gateway principal, a process, never at the hub, never a person.
    const reached = hub.reached.filter((r) => r.url === "/__gateway/crm/ops").at(-1)!;
    expect(reached.principal).toMatchObject({ personId: "dot", via: "gateway", actor: "process" });
    expect([reached.atHub, reached.human]).toEqual([false, false]);
  });

  test("request size and rate limits hold for a bearer too", async () => {
    const first = await enrolBrowser();
    const token = (await renewBearer(first.reconnectKey)).json.access.accessToken as string;
    const big = await gw("/__gateway/files/write", { method: "POST", bearer: token, body: { root: "drafts", path: "big.md", content: "x".repeat(LIMITS.maxBodyBytes + 10) } });
    expect(big.status).toBe(413);
    let limited = false;
    for (let i = 0; i < LIMITS.perSessionWritesPerMinute + 5 && !limited; i++) limited = (await gw("/__gateway/crm/read", { method: "POST", bearer: token, body: { name: "crm.search", input: { query: "synthetic" } } })).status === 429;
    expect(limited).toBe(true);
  }, 120_000);
});

describe("revocation: immediate, everywhere", () => {
  test("revoking the identity ends its cookie, its bearer, its open stream and its reconnect key at once; the hub refuses it too", async () => {
    const first = await enrolBrowser("--label", "To be revoked");
    const token = (await renewBearer(first.reconnectKey)).json.access.accessToken as string;
    expect((await gw("/__version", { cookie: first.cookie })).status).toBe(200);
    expect((await gw("/__version", { bearer: token })).status).toBe(200);
    // An open live stream.
    const stream = await fetch(`${origin}/__events`, { headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": "198.51.100.5" } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read();
    expect(gateway.openStreams()).toBeGreaterThanOrEqual(1);
    const other = await enrolBrowser("--label", "Another identity");

    expect(cli("revoke-identity", first.identity.id).code).toBe(0);

    // The very next requests.
    const cookieNow = await gw("/__version", { cookie: first.cookie });
    const bearerNow = await gw("/__version", { bearer: token });
    expect([cookieNow.status, cookieNow.json.reason]).toEqual([401, "revoked"]);
    expect([bearerNow.status, bearerNow.json.reason]).toEqual([401, "revoked"]);
    expect((await gw("/__gateway/crm/read", { method: "POST", bearer: token, body: { name: "crm.snapshot" } })).status).toBe(401);
    expect((await renewBearer(first.reconnectKey)).status).toBe(401);
    // The open stream is closed from the gateway's side within the recheck interval.
    const ended = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })(),
      Bun.sleep(3_000).then(() => false),
    ]);
    expect(ended).toBe(true);
    // Another identity is untouched.
    expect((await gw("/__version", { cookie: other.cookie })).status).toBe(200);
    // The hub itself: a perfectly signed assertion for the revoked identity is refused there, so the gateway is not the only gate.
    const key = readFileSync(join(hub.dir, FILES.secret), "utf8").trim();
    const direct = async (identityId: string) =>
      (await fetch(`${hub.origin}/__gateway/me`, { headers: { via: VIA_VALUE, [ASSERTION_HEADER]: signAssertion(key, { method: "GET", target: "/__gateway/me", sessionId: "ef".repeat(12), caps: ["view"], identityId }) } })).status;
    expect(await direct(first.identity.id)).toBe(401);
    expect(await direct(other.identity.id)).toBe(200);
    expect(cli("identities").text).toMatch(new RegExp(`${first.identity.id}\\s+revoked`));
  });

  test("revoke everything, and the kill switch, stop sign-in and renewal as well", async () => {
    const first = await enrolBrowser();
    const unused = mintCode();
    expect(cli("revoke-identity", "--all").code).toBe(0);
    expect((await gw("/__version", { cookie: first.cookie })).status).toBe(401);
    expect((await renewBearer(first.reconnectKey)).status).toBe(401);
    expect((await gw("/gw/enrol", { method: "POST", ip: nextIp(), headers: { Origin: origin, ...ENROL }, body: { code: unused } })).status).toBe(401);
    const fresh = await enrolBrowser();
    expect(cli("kill", "on").code).toBe(0);
    try {
      expect((await gw("/__version", { cookie: fresh.cookie })).status).toBe(503);
      expect((await gw("/gw/renew", { method: "POST", ip: nextIp(), headers: ENROL, body: { reconnectKey: fresh.reconnectKey, mode: "bearer" } })).status).toBe(503);
      expect((await gw("/gw/enrol", { method: "POST", ip: nextIp(), headers: { Origin: origin, ...ENROL }, body: { code: mintCode() } })).status).toBe(503);
      expect((await gw("/gw/health")).status).toBe(503);
    } finally {
      cli("kill", "off");
    }
    expect((await gw("/__version", { cookie: fresh.cookie })).status).toBe(200);
  });
});

describe("what is written down", () => {
  test("no reconnect key, access token, cookie, code or CSRF token is in the audit, the state files, the hub's log or the process output", () => {
    const written = [...readdirSync(hub.dir).filter((n) => n !== FILES.secret).map((n) => {
      try {
        return readFileSync(join(hub.dir, n), "utf8");
      } catch {
        return ""; // a folder
      }
    }), ...lines].join("\n");
    expect(secrets.length).toBeGreaterThan(20);
    for (const s of secrets.filter((x) => typeof x === "string" && x.length >= 16)) expect([s.slice(0, 12), written.includes(s)]).toEqual([s.slice(0, 12), false]);
    for (const e of readAudit(hub.dir)) expect([null, "dot"]).toContain(e.person);
  });
});
