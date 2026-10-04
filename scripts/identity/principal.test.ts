import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRegistry, defaultHub } from "../devices/registry";
import { resolveTarget } from "../devices/route";
import { DeviceStore, SESSION_TTL_MS } from "../devices/store";
import { syntheticTailnetForTests } from "../remote-access";
import type { TargetDevice } from "../devices/types";
import {
  authorise,
  isHumanSession,
  gatewayBearerOk,
  isAtThisPc,
  pageTokenFor,
  pairingTokenFor,
  resolvePrincipal,
  resolveTelegramPrincipal,
  type Principal,
} from "./principal";

// Synthetic people and logins only. No real people.json, sessions or tokens are read.
const TAILNET = "hub.tail-test.ts.net";
const LOGINS = { usman: "owner@example.test", mehroz: "partner@example.test", stranger: "stranger@example.test" };
const TG = { usman: "1000001", mehroz: "2000002" };

let root: string;
let now: number;
let store: DeviceStore;
/** Serve and `tailscale status` simulated: the hub owns 100.64.0.1; every other tailnet address is another node. */
const ctx = () => ({ root, store, tailnetName: TAILNET, servePeer: () => true, tailnet: syntheticTailnetForTests(TAILNET, ["100.64.0.1"]) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "identity-"));
  mkdirSync(join(root, ".operator-data"));
  writeFileSync(
    join(root, ".operator-data", "people.json"),
    JSON.stringify({
      people: [
        { name: "Usman", role: "owner", tailscale: [LOGINS.usman], telegram: [TG.usman] },
        { name: "Mehroz", role: "co-founder", tailscale: [LOGINS.mehroz], telegram: [TG.mehroz] },
      ],
    }),
  );
  now = 1_800_000_000_000;
  store = new DeviceStore(root, { now: () => now });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Headers = Record<string, string>;
const req = (headers: Headers, remoteAddress = "127.0.0.1") => ({ socket: { remoteAddress }, headers });
const local = (extra: Headers = {}) => req({ host: "127.0.0.1:8081", ...extra });
const tailnet = (who: keyof typeof LOGINS, extra: Headers = {}) =>
  req({ host: `${TAILNET}:8443`, "tailscale-user-login": LOGINS[who], "x-forwarded-for": "100.64.0.7", ...extra });

describe("resolvePrincipal: verified sources only", () => {
  test("loopback owner: loopback socket, local Host, no relay headers", () => {
    for (const host of ["127.0.0.1:8081", "localhost:8081", "localhost", "[::1]:8081", "LOCALHOST:8081"])
      expect(resolvePrincipal(req({ host }), ctx())).toEqual({ personId: "usman", via: "loopback-owner", actor: "process", deviceId: "usman-pc", displayName: "Usman" });
    for (const socket of ["::1", "::ffff:127.0.0.1"]) expect(resolvePrincipal(req({ host: "127.0.0.1:8081" }, socket), ctx())?.via).toBe("loopback-owner");
  });

  test("not loopback, a foreign Host (DNS rebinding) or an empty Host is nobody", () => {
    expect(resolvePrincipal(req({ host: "127.0.0.1:8081" }, "192.168.1.20"), ctx())).toBeNull();
    expect(resolvePrincipal(req({ host: "evil.example:8081" }), ctx())).toBeNull();
    expect(resolvePrincipal(req({ host: "localhost.evil.example:8081" }), ctx())).toBeNull();
    expect(resolvePrincipal(req({ host: "" }), ctx())).toBeNull();
    expect(resolvePrincipal(req({}), ctx())).toBeNull();
  });

  test("any relay marker with Host: localhost is nobody (849f205, review M1/M4)", () => {
    for (const relay of [
      { "x-forwarded-for": "100.64.0.3" },
      { "x-forwarded-host": "localhost" },
      { "x-forwarded-proto": "https" },
      { forwarded: "for=100.64.0.3" },
      { via: "1.1 proxy" },
      { "x-real-ip": "100.64.0.3" },
      { "tailscale-user-login": LOGINS.usman },
      { "tailscale-funnel-request": "?1" },
      { "true-client-ip": "203.0.113.5" },
      { "cf-connecting-ip": "203.0.113.5" },
      { "x-client-ip": "203.0.113.5" },
      { "x-cluster-client-ip": "203.0.113.5" },
      { "x-original-host": "localhost" },
    ]) {
      expect(isAtThisPc(req({ host: "localhost:8081", ...relay }))).toBe(false);
      expect(resolvePrincipal(req({ host: "localhost:8081", ...relay }), ctx())).toBeNull();
    }
  });

  test("tailnet person: Serve-verified login in people.json, on this PC's own tailnet name", () => {
    expect(resolvePrincipal(tailnet("usman"), ctx())).toEqual({ personId: "usman", via: "tailnet-person", actor: "process", displayName: "Usman" });
    expect(resolvePrincipal(tailnet("mehroz"), ctx())).toEqual({ personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" });
    expect(resolvePrincipal(tailnet("stranger"), ctx())).toBeNull();
    // Another machine's tailnet name, or no login header (a tagged device, a Funnel visitor).
    expect(resolvePrincipal(req({ host: "other.tail-test.ts.net", "tailscale-user-login": LOGINS.usman }), ctx())).toBeNull();
    expect(resolvePrincipal(req({ host: TAILNET, "tailscale-funnel-request": "?1" }), ctx())).toBeNull();
    expect(resolvePrincipal(req({ host: TAILNET }), ctx())).toBeNull();
    // Serve relays from this machine only: a non-loopback socket is never trusted.
    expect(resolvePrincipal(req({ host: TAILNET, "tailscale-user-login": LOGINS.usman }, "100.64.0.9"), ctx())).toBeNull();
  });

  test("a typed or picked name never authenticates", () => {
    const claims = { "x-person": "usman", "x-user": "Usman", cookie: "mu_name=usman", authorization: "Bearer usman" };
    expect(resolvePrincipal(req({ host: TAILNET, ...claims }), ctx())).toBeNull();
    expect(resolvePrincipal(tailnet("stranger", claims), ctx())).toBeNull();
    expect(resolvePrincipal(tailnet("mehroz", { cookie: "mu_name=usman" }), ctx())?.personId).toBe("mehroz");
    expect(resolvePrincipal(local({ cookie: "mu_name=mehroz" }), ctx())?.displayName).toBe("Usman");
  });

  test("paired session: a live 30-day cookie for the same person; revoked or expired means signed out", () => {
    const { cookie, session } = store.mintSession("mehroz", "Phone", "tailnet");
    const withCookie = (c: string, who: keyof typeof LOGINS = "mehroz") => tailnet(who, { cookie: `mu_session=${encodeURIComponent(c)}` });
    const paired = resolvePrincipal(withCookie(cookie), ctx());
    expect(paired).toEqual({ personId: "mehroz", via: "paired-session", actor: "human", sessionId: store.sessionKey(session.id), displayName: "Mehroz" });
    // The server-only key is neither the public row id nor anything in the cookie.
    expect(paired?.sessionId).not.toBe(session.id);
    expect(cookie).not.toContain(paired!.sessionId!);
    // Someone else's cookie is ignored, never adopted.
    expect(resolvePrincipal(withCookie(cookie, "usman"), ctx())).toEqual({ personId: "usman", via: "tailnet-person", actor: "process", displayName: "Usman" });
    // A forged or tampered cookie is a dead cookie.
    expect(resolvePrincipal(withCookie(`${cookie}x`), ctx())).toBeNull();
    store.revokeSession(session.id);
    expect(resolvePrincipal(withCookie(cookie), ctx())).toBeNull();
    const second = store.mintSession("mehroz", "Laptop", "code");
    now += SESSION_TTL_MS + 1;
    expect(resolvePrincipal(withCookie(second.cookie), ctx())).toBeNull();
    // The bare login still works for a browser with no cookie, while Tailscale sign-in is on.
    expect(resolvePrincipal(tailnet("mehroz"), ctx())?.via).toBe("tailnet-person");
  });

  test("Tailscale sign-in turned off (revoke + require a code): only a paired session works", () => {
    const { cookie } = store.mintSession("mehroz", "Phone", "code");
    store.setSelfPair("mehroz", false);
    expect(resolvePrincipal(tailnet("mehroz"), ctx())).toBeNull();
    expect(resolvePrincipal(tailnet("mehroz", { cookie: `mu_session=${encodeURIComponent(cookie)}` }), ctx())?.via).toBe("paired-session");
    expect(resolvePrincipal(tailnet("usman"), ctx())?.via).toBe("tailnet-person");
  });

  test("companion: a paired bearer token whose owner matches the login it arrived with", () => {
    const usmanCompanion = store.registerCompanion("usman", { label: "Usman's laptop" });
    const mehrozCompanion = store.registerCompanion("mehroz", { label: "Mehroz's PC" });
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
    expect(resolvePrincipal(local(bearer(usmanCompanion.token)), ctx())).toMatchObject({ personId: "usman", via: "companion", deviceId: usmanCompanion.device.id });
    expect(resolvePrincipal(tailnet("mehroz", bearer(mehrozCompanion.token)), ctx())).toMatchObject({ personId: "mehroz", via: "companion", deviceId: mehrozCompanion.device.id });
    // Wrong login for the token, or Mehroz's token presented at this PC: refused outright.
    expect(resolvePrincipal(tailnet("usman", bearer(mehrozCompanion.token)), ctx())).toBeNull();
    expect(resolvePrincipal(local(bearer(mehrozCompanion.token)), ctx())).toBeNull();
    // A bearer that isn't a companion token (Hermes' dummy provider key) is not an identity claim.
    expect(resolvePrincipal(local(bearer("sk-local-dummy")), ctx())?.via).toBe("loopback-owner");
    // A web page can't use a companion token.
    expect(resolvePrincipal(local({ ...bearer(usmanCompanion.token), origin: "http://127.0.0.1:8081" }), ctx())?.via).toBe("loopback-owner");
  });
});

describe("Telegram owner via the Hermes gateway", () => {
  const dm = (userId: string, extra: Partial<{ platform: string; chatId: string; chatType: string }> = {}) => ({ platform: "telegram", userId, chatId: userId, chatType: "dm", ...extra });
  test("a listed sender's DM relayed by the verified gateway is that person", () => {
    expect(resolveTelegramPrincipal(dm(TG.usman), { root, gatewayVerified: true })).toEqual({ personId: "usman", via: "telegram-owner", actor: "human", displayName: "Usman" });
    expect(resolveTelegramPrincipal(dm(TG.mehroz), { root, gatewayVerified: true })?.personId).toBe("mehroz");
  });
  test("no gateway proof, an unlisted sender, a group or a forwarded chat is nobody; no fallback id", () => {
    expect(resolveTelegramPrincipal(dm(TG.usman), { root, gatewayVerified: false })).toBeNull();
    expect(resolveTelegramPrincipal(dm("9999999"), { root, gatewayVerified: true })).toBeNull();
    expect(resolveTelegramPrincipal(dm(TG.usman, { chatType: "group" }), { root, gatewayVerified: true })).toBeNull();
    expect(resolveTelegramPrincipal(dm(TG.usman, { chatId: "-100200300" }), { root, gatewayVerified: true })).toBeNull();
    expect(resolveTelegramPrincipal(dm(TG.usman, { platform: "whatsapp" }), { root, gatewayVerified: true })).toBeNull();
  });
  test("the gateway bearer is checked at this PC only, against the relay token file", () => {
    const tokenDir = join(root, ".operator-data", "away-mode");
    expect(gatewayBearerOk(local({ authorization: "Bearer synthetic-relay" }), root)).toBe(false); // no file yet
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, "relay.token"), "synthetic-relay");
    expect(gatewayBearerOk(local({ authorization: "Bearer synthetic-relay" }), root)).toBe(true);
    expect(gatewayBearerOk(local({ authorization: "Bearer wrong" }), root)).toBe(false);
    expect(gatewayBearerOk(tailnet("usman", { authorization: "Bearer synthetic-relay" }), root)).toBe(false);
    expect(gatewayBearerOk(req({ host: "localhost:8081", "x-forwarded-for": "1.2.3.4", authorization: "Bearer synthetic-relay" }), root)).toBe(false);
  });
});

describe("authorise (V7)", () => {
  const owner: Principal = { personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc", displayName: "Usman" };
  const usmanRemote: Principal = { personId: "usman", via: "tailnet-person", actor: "process", displayName: "Usman" };
  const mehroz: Principal = { personId: "mehroz", via: "paired-session", actor: "human", sessionId: "sk1.x", displayName: "Mehroz" };
  const hubOnly = { resolveTarget: (c: Parameters<typeof resolveTarget>[0]) => resolveTarget(c, staticRegistry([defaultHub()])) };

  test("no principal is 401 for everything", () => {
    for (const r of [{ kind: "business" }, { kind: "internal", service: "x" }, { kind: "device", executor: "hub" }] as const)
      expect(authorise(null, r)).toMatchObject({ ok: false, status: 401 });
  });

  test("any verified founder gets full shared business access; no per-person rules", () => {
    for (const p of [owner, usmanRemote, mehroz]) {
      for (const area of ["leads", "finance", "memory", "receptionist", "workspace", "coding"])
        expect(authorise(p, { kind: "business", area }, "write")).toEqual({ ok: true });
    }
  });

  test("machine-internal services answer only the owner at this PC", () => {
    expect(authorise(owner, { kind: "internal", service: "The Claude bridge" }, "run")).toEqual({ ok: true });
    expect(authorise(usmanRemote, { kind: "internal", service: "The Claude bridge" }, "run")).toMatchObject({ ok: false, status: 403 });
    expect(authorise(mehroz, { kind: "internal", service: "The Claude bridge" }, "run")).toMatchObject({ ok: false, status: 403 });
  });

  test("device control resolves to the requester's OWN device; the hub is never Mehroz's fallback", () => {
    expect(authorise(owner, { kind: "device", executor: "hub", presence: true }, "control", hubOnly)).toEqual({ ok: true, targetDeviceId: "usman-pc" });
    const m = authorise(mehroz, { kind: "device", executor: "hub", presence: true }, "control", hubOnly);
    expect(m).toMatchObject({ ok: false, status: 403 });
    expect((m as { reason: string }).reason).toContain("no device registered for mehroz");
    // Naming Usman's PC doesn't help.
    const named = authorise(mehroz, { kind: "device", executor: "hub", spokenTarget: "on Usman's PC" }, "control", hubOnly);
    expect((named as { reason: string }).reason).toContain("belongs to usman");
    // Usman away from the PC: it's his device, but screen/mic actions need him at it.
    expect(authorise(usmanRemote, { kind: "device", executor: "hub", presence: true }, "control", hubOnly)).toMatchObject({ ok: false, status: 403 });
    expect(authorise(usmanRemote, { kind: "device", executor: "hub" }, "control", hubOnly)).toEqual({ ok: true, targetDeviceId: "usman-pc" });
  });

  test("with a companion of his own, Mehroz's command targets it, never the hub", () => {
    let t = 1_000;
    const laptop: TargetDevice = { id: "mehroz-laptop", owner: "mehroz", kind: "companion", label: "Mehroz's laptop", aliases: ["laptop"], primary: true };
    const registry = staticRegistry([defaultHub(), laptop], () => t);
    const deps = { resolveTarget: (c: Parameters<typeof resolveTarget>[0]) => resolveTarget(c, registry) };
    // Offline: refused, not re-routed.
    const offline = authorise(mehroz, { kind: "device", executor: "hub", presence: true }, "control", deps);
    expect((offline as { reason: string }).reason).toContain("device offline");
    registry.heartbeat("mehroz-laptop");
    const onHub = authorise(mehroz, { kind: "device", executor: "hub", presence: true }, "control", deps);
    expect(onHub).toMatchObject({ ok: false, status: 403 });
    expect((onHub as { reason: string }).reason).toContain("mehroz-laptop");
    expect(authorise(mehroz, { kind: "device", executor: "dispatch" }, "control", deps)).toEqual({ ok: true, targetDeviceId: "mehroz-laptop" });
    t += 1;
  });
});

describe("page tokens: the internal token never leaves this PC", () => {
  const internal = "synthetic-internal-token";
  test("at this PC the page token is the internal one; remotely it is person-bound", () => {
    const owner: Principal = { personId: "usman", via: "loopback-owner", deviceId: "usman-pc", displayName: "Usman" };
    expect(pageTokenFor(owner, internal)).toBe(internal);
    // Pairing a signed-in browser keeps the token its page already holds.
    expect(pageTokenFor({ personId: "mehroz", via: "paired-session", sessionId: "a", displayName: "Mehroz" }, internal)).toBe(
      pageTokenFor({ personId: "mehroz", via: "tailnet-person", displayName: "Mehroz" }, internal),
    );
    const tokens = [
      pageTokenFor({ personId: "usman", via: "tailnet-person", displayName: "Usman" }, internal),
      pageTokenFor({ personId: "mehroz", via: "tailnet-person", displayName: "Mehroz" }, internal),
      pairingTokenFor("mehroz", internal),
      pairingTokenFor("usman", internal),
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const t of tokens) {
      expect(t).not.toContain(internal);
      expect(t.startsWith("p1.")).toBe(true);
    }
    // A new server run (new internal token) invalidates every remote token.
    expect(pageTokenFor({ personId: "mehroz", via: "tailnet-person", displayName: "Mehroz" }, "next-run")).not.toBe(tokens[1]);
  });
});

describe("human session vs process caller (for B2's approver rule)", () => {
  test("the owner's browser at this PC is human only with its hub session cookie; a local process is a process", () => {
    expect(resolvePrincipal(local(), ctx())?.actor).toBe("process"); // Hermes, cron, an agent job, curl
    const { cookie, session } = store.mintSession("usman", "This PC's browser", "hub");
    const browser = resolvePrincipal(local({ cookie: `mu_session=${encodeURIComponent(cookie)}` }), ctx());
    expect(browser).toMatchObject({ personId: "usman", via: "loopback-owner", actor: "human", sessionId: store.sessionKey(session.id) });
    expect(isHumanSession(browser)).toBe(true);
    // A dead cookie never locks the owner out at his PC: still the owner, but a process caller.
    store.revokeSession(session.id);
    expect(resolvePrincipal(local({ cookie: `mu_session=${encodeURIComponent(cookie)}` }), ctx())).toMatchObject({ via: "loopback-owner", actor: "process" });
    // Mehroz's cookie at Usman's PC doesn't make the caller a human Usman session.
    const m = store.mintSession("mehroz", "Phone", "tailnet");
    const at = resolvePrincipal(local({ cookie: `mu_session=${encodeURIComponent(m.cookie)}` }), ctx());
    expect(at).toMatchObject({ personId: "usman", actor: "process" });
    expect(at?.sessionId).toBeUndefined();
  });

  test("remote: a paired session is human; a bare Tailscale login and a companion are processes", () => {
    const { cookie } = store.mintSession("mehroz", "Phone", "tailnet");
    expect(resolvePrincipal(tailnet("mehroz", { cookie: `mu_session=${encodeURIComponent(cookie)}` }), ctx())?.actor).toBe("human");
    expect(resolvePrincipal(tailnet("mehroz"), ctx())?.actor).toBe("process");
    const c = store.registerCompanion("mehroz", { label: "PC" });
    expect(resolvePrincipal(tailnet("mehroz", { authorization: `Bearer ${c.token}` }), ctx())?.actor).toBe("process");
  });

  test("hub sessions are capped, so a script can't pile them up", () => {
    for (let i = 0; i < 20; i++) store.mintSession("usman", "This PC's browser", "hub");
    expect(store.sessions("usman").filter((s) => s.via === "hub" && !s.revokedAt).length).toBe(8);
  });
});
