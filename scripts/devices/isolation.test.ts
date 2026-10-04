import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authorise, withDisplayName, type Principal } from "./permissions";
import { pageTokenFor } from "../identity/principal";
import { SESSION_TTL_MS } from "./store";
import { PAGE_TOKEN, startHub, TAILNET, type Hub } from "./test-harness";

// Two-user synthetic isolation over the real /__devices HTTP handler. Synthetic people only.
let hub: Hub;
beforeEach(async () => (hub = await startHub({ start: 1_800_000_000_000 })));
afterEach(async () => hub.close());

async function pairedMehroz(label = "Mehroz's PC browser") {
  const b = hub.browser("mehroz");
  const r = await b.post("/pair/tailnet", { label });
  expect(r.status).toBe(200);
  return b;
}

describe("the guard is never weaker than /__operator", () => {
  test("a tailnet login not in people.json is refused outright", async () => {
    expect((await hub.browser("stranger").get("/me")).status).toBe(403);
  });
  test("a foreign Host on a loopback socket is refused (DNS rebinding)", async () => {
    const r = await fetch(`${hub.base}/__devices/me`, { headers: { host: "evil.example.com" } });
    expect(r.status).toBe(403);
  });
  test("a Serve-relayed request cannot pose as local by sending Host: localhost", async () => {
    const r = await fetch(`${hub.base}/__devices/me`, { headers: { host: "localhost:8081", "tailscale-user-login": "partner@example.test" } });
    expect(r.status).toBe(403);
    const xff = await fetch(`${hub.base}/__devices/me`, { headers: { host: "localhost:8081", "x-forwarded-for": "100.64.0.7" } });
    expect(xff.status).toBe(403);
  });
  test("loopback owner access for Usman keeps working with no pairing at all", async () => {
    const r = await hub.browser("local").get("/me");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ authorised: true, via: "loopback", person: { id: "usman" }, permissions: { finance: true, devices: "own" } });
  });
});

// Stage B1 (the one identity contract, scripts/identity/principal.ts) supersedes the earlier rule
// that a Tailscale login alone authorised nothing: a Serve-verified login in people.json IS a
// principal ("tailnet-person") while that person's Tailscale sign-in is on (policy.selfPair).
// Pairing remembers the browser for 30 days; "require a code" turns the bare login off.
describe("pairing: a verified Tailscale login signs in; pairing remembers the browser", () => {
  test("unpaired Mehroz is signed in by his Tailscale login and can still pair to be remembered", async () => {
    const b = hub.browser("mehroz");
    const me = await b.get("/me");
    expect(me.json).toMatchObject({ authorised: true, via: "tailnet", person: { id: "mehroz" }, session: null, canSelfPair: true });
    expect(me.json.principal).toEqual({ personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" });
    // Unconfirmed, he can check what he may do, but lists no devices or sessions (acceptance #18).
    expect((await b.get("/authorise?kind=business")).status).toBe(200);
    for (const path of ["/sessions", "/devices"]) expect((await b.get(path)).status).toBe(403);
    // Unconfirmed, he drives no device at all (acceptance #18)...
    expect((await b.post("/commands", { executor: "echo" })).status).toBe(403);
    // ...and confirmed, device control resolves to HIS devices; he has none, and Usman's PC is never the fallback.
    const cmd = await hub.browser("mehroz", { confirmed: true }).post("/commands", { executor: "echo" });
    expect(cmd.status).toBe(409);
    expect(JSON.stringify(cmd.json)).toContain("no device registered for mehroz");
  });
  test("with his Tailscale sign-in turned off, Mehroz can see who he is and pair by code, nothing else", async () => {
    expect((await hub.browser("local").post("/policy/self-pair", { personId: "mehroz", allowed: false })).status).toBe(200);
    const b = hub.browser("mehroz");
    const me = await b.get("/me");
    expect(me.json).toMatchObject({ authorised: false, person: { id: "mehroz" }, canSelfPair: false });
    for (const path of ["/sessions", "/devices", "/authorise?kind=business"]) expect((await b.get(path)).status).toBe(401);
    expect((await b.post("/commands", { executor: "echo" })).status).toBe(401);
    expect((await b.post("/pair/tailnet", {})).status).toBe(403);
  });
  test("pairing sets a 30-day HttpOnly, SameSite=Strict, Secure session cookie", async () => {
    const b = hub.browser("mehroz");
    const r = await b.post("/pair/tailnet", { label: "Study PC" });
    const c = r.setCookies.find((x) => x.startsWith("mu_session="))!;
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Secure");
    expect(c).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect((await b.get("/me")).json).toMatchObject({ authorised: true, via: "session", person: { id: "mehroz" }, session: { label: "Study PC" } });
  });
  test("Mehroz's cookie presented with Usman's Tailscale login is ignored", async () => {
    const m = await pairedMehroz();
    const u = hub.browser("usman");
    for (const [k, v] of m.jar) u.jar.set(k, v);
    // Still Usman, by his own login; the copied cookie never makes him Mehroz or a paired session.
    expect((await u.get("/me")).json).toMatchObject({ authorised: true, via: "tailnet", person: { id: "usman" }, session: null });
  });
  test("a one-time code from a paired device pairs a second browser — only for the same person", async () => {
    const m = await pairedMehroz();
    const code = (await m.post("/pair/code", { purpose: "browser" })).json.code;
    const usmanTries = await hub.browser("usman").post("/pair/redeem", { code });
    expect(usmanTries.status).toBe(403);
    const code2 = (await m.post("/pair/code", { purpose: "browser" })).json.code;
    const laptop = hub.browser("mehroz");
    expect((await laptop.post("/pair/redeem", { code: code2, label: "Laptop" })).status).toBe(200);
    expect((await laptop.post("/pair/redeem", { code: code2 })).status).toBe(409);
    expect((await hub.browser("mehroz").post("/pair/redeem", { code: code2 })).status).toBe(403);
  });
  test("Mehroz can't mint codes for Usman; Usman at his PC can mint for Mehroz", async () => {
    const m = await pairedMehroz();
    expect((await m.post("/pair/code", { personId: "usman" })).status).toBe(403);
    const r = await hub.browser("local").post("/pair/code", { personId: "mehroz", purpose: "companion" });
    expect(r.status).toBe(200);
    expect(r.json.personId).toBe("mehroz");
  });
});

describe("browser writes are CSRF-guarded", () => {
  test("missing page token, foreign origin, cross-site and non-JSON are refused", async () => {
    const b = hub.browser("mehroz");
    expect((await b.post("/pair/tailnet", {}, { "x-claude-os-token": "wrong" })).status).toBe(403);
    expect((await b.post("/pair/tailnet", {}, { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await b.post("/pair/tailnet", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // The internal token is the PC's alone: from the tailnet it is refused (Stage B1).
    expect((await b.post("/pair/tailnet", {}, { "x-claude-os-token": PAGE_TOKEN })).status).toBe(403);
    const own = pageTokenFor({ personId: "mehroz", via: "tailnet-person" }, PAGE_TOKEN);
    const r = await fetch(`${hub.base}/__devices/pair/tailnet`, { method: "POST", headers: { ...hub.headersFor("mehroz"), "x-claude-os-token": own, "content-type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(415);
    expect((await b.post("/pair/tailnet", {}, { origin: `https://${TAILNET}:8443` })).status).toBe(200);
  });
});

describe("one shared workspace (V7): both founders read all business data; devices stay per owner", () => {
  test("paired Mehroz: business, every memory scope and finance yes; Usman's PC no", async () => {
    const m = await pairedMehroz();
    const q = async (query: string) => (await m.get(`/authorise?${query}`)).json.allowed;
    expect(await q("kind=business")).toBe(true);
    expect(await q("kind=memory&scope=shared")).toBe(true);
    expect(await q("kind=memory&scope=mehroz")).toBe(true);
    expect(await q("kind=memory&scope=usman")).toBe(true);
    expect(await q("kind=finance&owner=usman")).toBe(true);
    expect(await q("kind=device&deviceId=usman-pc")).toBe(false);
  });
  test("Usman at his PC reads every scope too", async () => {
    const u = hub.browser("local");
    expect((await u.get("/authorise?kind=memory&scope=mehroz")).json.allowed).toBe(true);
    expect((await u.get("/authorise?kind=memory&scope=usman")).json.allowed).toBe(true);
    expect((await u.get("/authorise?kind=finance&owner=usman")).json.allowed).toBe(true);
  });
  test("the old finance grant no longer gates finance; only Usman can still change the policy", async () => {
    const m = await pairedMehroz();
    expect((await m.post("/policy/finance", { personId: "mehroz", granted: true })).status).toBe(403);
    const u = hub.browser("local");
    await u.post("/policy/finance", { personId: "mehroz", granted: false });
    expect((await m.get("/authorise?kind=finance&owner=usman")).json.allowed).toBe(true);
  });
});

describe("the name picker personalises; it never authorises", () => {
  test("Mehroz picking 'Usman' narrows him to shared data", async () => {
    const m = await pairedMehroz();
    const r = await m.post("/name", { personId: "usman" });
    expect(r.json).toMatchObject({ displayAs: "usman", sharedOnly: true });
    expect(r.setCookies.find((c) => c.startsWith("mu_name="))).toContain("Max-Age=2592000");
    expect((await m.get("/authorise?kind=memory&scope=usman")).json.allowed).toBe(false);
    expect((await m.get("/authorise?kind=memory&scope=mehroz")).json.allowed).toBe(false);
    expect((await m.get("/authorise?kind=business")).json.allowed).toBe(true);
    expect((await m.post("/commands", { executor: "echo" })).status).toBe(403);
    await m.post("/name", { personId: null });
    expect((await m.get("/authorise?kind=memory&scope=mehroz")).json.allowed).toBe(true);
  });
  test("someone at Usman's PC picking 'Mehroz' gets neither person's private data", async () => {
    const u = hub.browser("local");
    await u.post("/name", { personId: "mehroz" });
    const me = await u.get("/me");
    expect(me.json).toMatchObject({ displayAs: "mehroz", sharedOnly: true, permissions: { finance: false, memory: ["shared"], devices: "none" } });
  });
  test("a device with no principal cannot pick a name", async () => {
    expect((await hub.browser("local").post("/policy/self-pair", { personId: "mehroz", allowed: false })).status).toBe(200);
    expect((await hub.browser("mehroz").post("/name", { personId: "mehroz" })).status).toBe(401);
  });
  test("unit: a picked name can only reduce access", () => {
    const usman: Principal = { personId: "usman", via: "loopback" };
    const narrowed = withDisplayName(usman, "mehroz");
    expect(authorise(narrowed, { kind: "finance", owner: "usman" }).allowed).toBe(false);
    expect(authorise(narrowed, { kind: "device", device: { id: "usman-pc", owner: "usman" } }).allowed).toBe(false);
    expect(authorise(withDisplayName(usman, "usman"), { kind: "finance", owner: "usman" }).allowed).toBe(true);
    expect(authorise(null, { kind: "business" }).allowed).toBe(false);
  });
});

describe("sessions: expiry and revocation", () => {
  test("a session stops working after 30 days", async () => {
    const m = await pairedMehroz();
    hub.clock.advance(SESSION_TTL_MS - 60_000);
    expect((await m.get("/me")).json.authorised).toBe(true);
    hub.clock.advance(60_000);
    expect((await m.get("/me")).json.authorised).toBe(false);
  });
  test("each person sees their own sessions; Usman sees all", async () => {
    await pairedMehroz();
    const u = hub.browser("usman");
    await u.post("/pair/tailnet", { label: "Usman's phone" });
    const m2 = hub.browser("mehroz");
    await m2.post("/pair/tailnet", { label: "Second" });
    const mine = (await m2.get("/sessions")).json.sessions;
    expect(mine.every((s: any) => s.personId === "mehroz")).toBe(true);
    expect(mine.filter((s: any) => s.current)).toHaveLength(1);
    // Three paired browsers plus the owner's own confirmed browser at this PC.
    expect((await hub.browser("local").get("/sessions")).json.sessions).toHaveLength(4);
  });
  test("Mehroz can't revoke Usman's session; Usman can revoke Mehroz's and require a code", async () => {
    const m = await pairedMehroz();
    const u = hub.browser("usman");
    await u.post("/pair/tailnet", { label: "Usman's phone" });
    const all = (await hub.browser("local").get("/sessions")).json.sessions;
    const usmanSession = all.find((s: any) => s.personId === "usman").id;
    const mehrozSession = all.find((s: any) => s.personId === "mehroz").id;
    expect((await m.post("/sessions/revoke", { sessionId: usmanSession })).status).toBe(403);
    const r = await hub.browser("local").post("/sessions/revoke", { sessionId: mehrozSession, requireCode: true });
    expect(r.json.selfPair).toBe(false);
    expect((await m.get("/me")).json.authorised).toBe(false);
    // His Tailscale login alone no longer re-pairs; a code from Usman does.
    const again = hub.browser("mehroz");
    expect((await again.post("/pair/tailnet", {})).status).toBe(403);
    const code = (await hub.browser("local").post("/pair/code", { personId: "mehroz" })).json.code;
    expect((await again.post("/pair/redeem", { code })).status).toBe(200);
    expect((await again.get("/me")).json.authorised).toBe(true);
  });
  test("revoking your own current session clears its cookie", async () => {
    const m = await pairedMehroz();
    const id = (await m.get("/me")).json.session.id;
    const r = await m.post("/sessions/revoke", { sessionId: id });
    expect(r.setCookies.some((c) => c.startsWith("mu_session=;") && c.includes("Max-Age=0"))).toBe(true);
    // The remembered session is gone; only his bare Tailscale sign-in remains (while it is on).
    expect((await m.get("/me")).json).toMatchObject({ session: null, via: "tailnet" });
  });
  test("a session revoked from another device signs that browser out until it pairs again", async () => {
    const m = await pairedMehroz();
    const id = (await m.get("/me")).json.session.id;
    expect((await hub.browser("local").post("/sessions/revoke", { sessionId: id })).status).toBe(200);
    // The browser still holds the dead cookie: no principal, no fallback to the bare login.
    expect((await m.get("/me")).json).toMatchObject({ authorised: false, canSelfPair: true });
    expect((await m.get("/devices")).status).toBe(401);
    expect((await m.post("/pair/tailnet", { label: "Again" })).status).toBe(200);
    expect((await m.get("/me")).json).toMatchObject({ authorised: true, via: "session" });
  });
});
