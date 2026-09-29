import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPeople, tailnetPerson, type TailnetSource } from "../remote-access";
import { relayedByTailscaleServe, type ServePeerCheck } from "./serve-peer";
import { HUB_DEVICE_ID } from "../devices/registry";
import { resolveTarget as defaultResolveTarget } from "../devices/route";
import { DeviceStore, type SessionRow } from "../devices/store";
import { normalisePersonId, type PersonId, type ResolveContext, type ResolveResult } from "../devices/types";

/**
 * Stage B1: the ONE identity contract (TARGET-ARCHITECTURE §3.1 with the V7 amendments).
 *
 * `resolvePrincipal(req)` is the only function that says who is behind a request. Every action
 * route asks it, and a route answers 401 when it returns null. Verified sources only:
 *
 *   loopback-owner  socket is loopback AND Host is localhost/127.0.0.1/[::1] AND no relay header
 *                   (tailscale-*, x-forwarded-*, forwarded, via, x-real-ip; the 849f205 proxy rule).
 *                   Usman at his PC.
 *   paired-session  a Serve-relayed request (loopback socket, this PC's tailnet Host, a Serve-stamped
 *                   Tailscale-User-Login in people.json) that also carries a live, signed, 30-day
 *                   session cookie minted for that same person. Revocable.
 *   tailnet-person  the same Serve-verified login with no session cookie, when that person's
 *                   Tailscale sign-in is allowed (devices policy `selfPair`, on by default).
 *                   Revoking a session "and require a code" turns this path off for that person.
 *   companion       a paired companion's bearer token whose owner matches the login it arrived with.
 *   telegram-owner  a Telegram DM relayed by the Hermes gateway with the relay bearer token, whose
 *                   sender is listed in people.json (resolveTelegramPrincipal).
 *
 * A display name is personalisation only: it comes from people.json for the verified person and
 * never from a body, a query, a cookie the user picked, or a typed name. A presented session cookie
 * that no longer verifies (revoked, expired, re-keyed) means "signed out": the request gets no
 * principal until that browser pairs again; it never falls back to the bare Tailscale login.
 *
 * `authorise(principal, resource, action)` is the V7 policy: any verified founder has FULL shared
 * business access (no per-person business-data rules); machine-internal services answer only the
 * owner at this PC; device CONTROL is routing, not permission, and resolves to the requester's own
 * device through resolveTarget (scripts/devices/route.ts). The hub is never a fallback for anyone
 * else.
 */

export type PrincipalVia = "loopback-owner" | "paired-session" | "tailnet-person" | "telegram-owner" | "companion";

/**
 * human:   a person interacting now: a browser holding a live session cookie (HttpOnly,
 *          SameSite=Strict, Secure over Serve), or a Telegram DM the person typed.
 * process: a program acting for the person: Hermes, cron scripts, Codex/Claude agent jobs, a
 *          companion, curl, or any request with no session cookie (at this PC, or over the tailnet
 *          with a bare Tailscale login). B2 keeps "approver != requester" for these.
 * Limit, stated plainly: a program running as the owner's Windows account can drive his browser or
 * read its cookie store, so "human" is a boundary against agents and scripts calling the API, not
 * against malware on the owner's own account.
 */
export type PrincipalActor = "human" | "process";

export type Principal = {
  /** Verified. Never from a body, a query, a picked name or a display name. */
  personId: PersonId;
  via: PrincipalVia;
  actor: PrincipalActor;
  /**
   * Server-only key for the session cookie this request carried (a keyed hash of the stored session,
   * see DeviceStore.sessionKey). Never in /__token or any JSON; the public id the UI uses to revoke a
   * session is a different value and can't be turned into this one.
   */
  sessionId?: string;
  /** The device the request came from (the hub at this PC, or a companion). */
  deviceId?: string;
  /** Personalisation only: the people.json name of the verified person. */
  displayName: string;
};

export const SESSION_COOKIE = "mu_session";
const LOOPBACK_SOCKET = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

type Headers = Record<string, string | string[] | undefined>;
export type ReqLike = { socket?: { remoteAddress?: string | null }; headers?: Headers; url?: string; method?: string };

export type IdentityContext = {
  root: string;
  /** Sessions and companions (.operator-data/devices.json). Defaults to one store per root. */
  store?: DeviceStore;
  /** This PC's tailnet name (tests). Defaults to remote-access ownTailnetName(). */
  tailnetName?: string;
  /**
   * Did this request's socket really come from Tailscale Serve (AUDIT-A1-3 R3b)? Defaults to the OS
   * check in serve-peer.ts. Tests that simulate Serve over a plain loopback socket pass their own.
   */
  servePeer?: ServePeerCheck;
  /**
   * Which tailnet node is which (REVIEW-S1 R2-1): a Serve request whose tailnet source resolves to this
   * PC's own node (by stable node ID) is the self-loop, a program on this PC, never a remote founder,
   * and a source that can't be resolved is refused too. Defaults to the live `tailscale status` snapshot
   * (remote-access currentTailnetSnapshot). Tests pass a synthetic one (syntheticTailnetForTests).
   */
  tailnet?: TailnetSource;
};

// ---------------------------------------------------------------------------------------------
// The active context: the server installs it once; tests pass their own.

let active: IdentityContext | undefined;
const stores = new Map<string, DeviceStore>();

/** The live server installs its root (and, in tests, a store and tailnet name). */
export function configureIdentity(ctx: IdentityContext | undefined) {
  active = ctx;
}

function contextOf(ctx?: Partial<IdentityContext>): IdentityContext & { store: DeviceStore } {
  // A caller naming a different root gets that root's own store, not the live server's.
  const base: IdentityContext = ctx?.root && ctx.root !== active?.root ? { root: ctx.root } : (active ?? { root: process.cwd() });
  return {
    root: base.root,
    store: ctx?.store ?? base.store ?? storeFor(base.root),
    tailnetName: ctx?.tailnetName ?? base.tailnetName,
    servePeer: ctx?.servePeer ?? base.servePeer,
    tailnet: ctx?.tailnet ?? base.tailnet,
  };
}

/** The session store the identity layer uses for this context (the gate mints hub sessions in it). */
export function identityStore(ctx?: Partial<IdentityContext>): DeviceStore {
  return contextOf(ctx).store;
}

function storeFor(root: string) {
  let store = stores.get(root);
  if (!store) stores.set(root, (store = new DeviceStore(root)));
  return store;
}

// ---------------------------------------------------------------------------------------------
// Request facts

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(Array.isArray(header) ? header.join(";") : header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function isLoopbackSocket(req: ReqLike) {
  return LOOPBACK_SOCKET.has(req.socket?.remoteAddress ?? "");
}

/**
 * THE relay-header list (one list for the whole OS): anything a proxy (Tailscale Serve or Funnel, a
 * reverse proxy, a CDN, anything else) stamps on a relayed request. Tailscale-*, X-Forwarded-*
 * (incl. -For, -Host, -Proto), Forwarded, Via, X-Real-IP, X-Original-URL/-Host/-Forwarded-For,
 * CF-Connecting-IP, True-Client-IP, X-Client-IP and X-Cluster-Client-IP. Any of them means "not at
 * this PC".
 */
export const RELAY_HEADER =
  /^(?:tailscale-.+|x-forwarded-.+|forwarded|via|x-real-ip|x-original-(?:url|host|forwarded-for)|cf-connecting-ip|true-client-ip|x-client-ip|x-cluster-client-ip)$/i;
export function hasRelayHeaders(req: ReqLike) {
  return Object.keys(req.headers ?? {}).some((h) => RELAY_HEADER.test(h));
}

/** A browser or process at this PC: loopback socket, a local Host (never empty), and nothing relayed. */
export function isAtThisPc(req: ReqLike) {
  if (!isLoopbackSocket(req) || hasRelayHeaders(req)) return false;
  return LOCAL_HOST.test(String(req.headers?.host ?? ""));
}

// Every asset request at this PC resolves a principal; people.json is re-read at most every 2 s.
const names = new Map<string, { at: number; byId: Map<PersonId, string> }>();

export function displayNameFor(root: string, personId: PersonId): string {
  const now = Date.now();
  let cached = names.get(root);
  if (!cached || now - cached.at > 2_000) {
    const byId = new Map<PersonId, string>();
    for (const p of readPeople(root)) {
      const id = normalisePersonId(p.name);
      if (id && !byId.has(id) && p.name.trim()) byId.set(id, p.name.trim().slice(0, 40));
    }
    names.set(root, (cached = { at: now, byId }));
  }
  return cached.byId.get(personId) ?? personId.charAt(0).toUpperCase() + personId.slice(1);
}

export type SessionCookieState = "none" | "valid" | "other-person" | "dead";

export type RequestIdentity = {
  loopbackSocket: boolean;
  /** At this PC (loopback-owner facts). */
  local: boolean;
  /** The Serve-verified person, whether or not they hold a principal. */
  tailnet: PersonId | null;
  /** Arrived over HTTPS via Serve (cookies get Secure). */
  secure: boolean;
  session: SessionRow | null;
  sessionCookie: SessionCookieState;
  principal: Principal | null;
};

/**
 * Everything the identity layer knows about a request. `principal` is the verified caller (or null);
 * the rest lets /__devices offer pairing to a verified login that has no principal yet.
 */
export function identifyRequest(req: ReqLike, ctx?: Partial<IdentityContext>): RequestIdentity {
  const c = contextOf(ctx);
  const loopbackSocket = isLoopbackSocket(req);
  const local = isAtThisPc(req);
  const none: RequestIdentity = { loopbackSocket, local, tailnet: null, secure: false, session: null, sessionCookie: "none", principal: null };
  if (!loopbackSocket) return none;

  const companion = companionPrincipal(req, c, local);
  if (companion === "refused") return none;

  if (local) {
    if (companion) return { ...none, principal: companion };
    const owner: Principal = { personId: "usman", via: "loopback-owner", actor: "process", deviceId: HUB_DEVICE_ID, displayName: displayNameFor(c.root, "usman") };
    const cookie = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
    const row = cookie ? c.store.verifySession(cookie) : null;
    // The owner's browser at this PC holds a hub session cookie (minted by the gate on navigation).
    // A local process doesn't. A dead or someone else's cookie never locks the owner out: he stays
    // the loopback owner, just not an interactive session until the next page load mints one.
    // A PENDING hub session (minted by a navigation, which any local program can forge: AUDIT-A1-3) is
    // still the owner, but a process caller with no session key until a confirmed session confirms it.
    if (row && row.personId === "usman" && row.pending) return { ...none, session: row, sessionCookie: "valid", principal: owner };
    if (row && row.personId === "usman")
      return { ...none, session: row, sessionCookie: "valid", principal: { ...owner, actor: "human", sessionId: c.store.sessionKey(row.id) } };
    return { ...none, sessionCookie: !cookie ? "none" : row ? "other-person" : "dead", principal: owner };
  }

  const tailnet = servePerson(req, c);
  if (!tailnet) return none;
  const base = { ...none, tailnet, secure: true };
  if (companion) return { ...base, principal: companion };

  const cookie = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
  if (cookie) {
    const row = c.store.verifySession(cookie);
    if (!row) return { ...base, sessionCookie: "dead" };
    if (row.personId === tailnet && !row.pending)
      return {
        ...base,
        session: row,
        sessionCookie: "valid",
        principal: { personId: tailnet, via: "paired-session", actor: "human", sessionId: c.store.sessionKey(row.id), displayName: displayNameFor(c.root, tailnet) },
      };
    // Someone else's cookie in this browser (a shared browser, a copied cookie): ignored, never used.
    return tailnetSignIn(c, { ...base, sessionCookie: "other-person" }, tailnet);
  }
  return tailnetSignIn(c, base, tailnet);
}

/**
 * The Serve-verified person (remote-access tailnetPerson), consulted only for a request that looks
 * relayed by Serve: a login header and a MagicDNS (*.ts.net) Host, which Vite's allowedHosts
 * requires anyway. tailnetPerson then insists the Host is THIS PC's own tailnet name, the socket's
 * peer is tailscaled, and the tailnet source is another node, not this PC (REVIEW-S1 R2-1).
 */
function servePerson(req: ReqLike, c: IdentityContext): PersonId | null {
  if (!String(req.headers?.["tailscale-user-login"] ?? "").trim()) return null;
  if (!/\.ts\.net(:\d+)?$/i.test(String(req.headers?.host ?? ""))) return null;
  const person = tailnetPerson(req, c.root, c.tailnetName, c.servePeer ?? relayedByTailscaleServe, c.tailnet);
  return person ? normalisePersonId(person.name) : null;
}

function tailnetSignIn(c: IdentityContext & { store: DeviceStore }, base: RequestIdentity, tailnet: PersonId): RequestIdentity {
  if (c.store.policy().selfPair[tailnet] === false) return base;
  // No session cookie: a browser that hasn't paired, or a script on that person's machine. Process.
  return { ...base, principal: { personId: tailnet, via: "tailnet-person", actor: "process", displayName: displayNameFor(c.root, tailnet) } };
}

/**
 * A companion's bearer token, when one is presented and verifies. A bearer that isn't a companion
 * token (Hermes' dummy provider key, say) is not an identity claim and is ignored. A companion token
 * whose owner doesn't match the login it arrived with is refused outright.
 */
function companionPrincipal(req: ReqLike, c: IdentityContext & { store: DeviceStore }, local: boolean): Principal | "refused" | null {
  const auth = String(req.headers?.authorization ?? "");
  if (!auth.startsWith("Bearer ")) return null;
  // Companions are programs, never web pages.
  if (req.headers?.origin) return null;
  const device = c.store.verifyCompanion(auth.slice(7).trim());
  if (!device) return null;
  const owner: PersonId | null = local ? "usman" : servePerson(req, c);
  if (owner !== device.owner) return "refused";
  return { personId: device.owner, via: "companion", actor: "process", deviceId: device.id, displayName: displayNameFor(c.root, device.owner) };
}

/** THE function. Null means: no verified caller; the route answers 401. */
export function resolvePrincipal(req: ReqLike, ctx?: Partial<IdentityContext>): Principal | null {
  return identifyRequest(req, ctx).principal;
}

/** A person using the OS UI or its APIs (not a companion program or a Telegram relay). */
export function isBrowserPrincipal(p: Principal | null): p is Principal {
  return !!p && (p.via === "loopback-owner" || p.via === "paired-session" || p.via === "tailnet-person");
}

/** At this PC in person: the only principal the hub's own screen, mic and settings act for. */
export function isAtHub(p: Principal | null) {
  return !!p && p.via === "loopback-owner";
}

/** A person interacting now (a live session cookie or their own Telegram DM), not a program. */
export function isHumanSession(p: Principal | null): p is Principal & { actor: "human" } {
  return !!p && p.actor === "human";
}

// ---------------------------------------------------------------------------------------------
// Telegram, via the Hermes gateway

export type TelegramSender = { platform: string; userId: string; chatId: string; chatType: string };

/** The Hermes gateway's relay bearer (.operator-data/away-mode/relay.token); never created here. */
export function gatewayBearerOk(req: ReqLike, root: string): boolean {
  if (!isAtThisPc(req)) return false;
  const presented = String(req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
  let expected = "";
  try {
    expected = readFileSync(join(root, ".operator-data", "away-mode", "relay.token"), "utf8").trim();
  } catch {
    return false;
  }
  return !!expected && safeEqual(presented, expected);
}

/**
 * A Telegram message's sender, verified: the gateway authenticated itself with its relay bearer,
 * and the sender's numeric Telegram id is listed for a person in people.json, in a direct message
 * from that same user. No hard-coded fallback id: an unlisted sender is nobody.
 */
export function resolveTelegramPrincipal(sender: TelegramSender, opts: { root: string; gatewayVerified: boolean }): Principal | null {
  if (!opts.gatewayVerified) return null;
  if (sender.platform !== "telegram" || sender.chatType !== "dm") return null;
  const id = String(sender.userId ?? "").trim();
  if (!/^\d{5,15}$/.test(id) || String(sender.chatId ?? "").trim() !== id) return null;
  const person = readPeople(opts.root).find((p) => (p.telegram ?? []).some((t) => String(t).trim() === id));
  const personId = person ? normalisePersonId(person.name) : null;
  // A DM the person typed in their own Telegram: interactive.
  return personId ? { personId, via: "telegram-owner", actor: "human", displayName: displayNameFor(opts.root, personId) } : null;
}

// ---------------------------------------------------------------------------------------------
// authorise (V7)

export type Resource =
  /** Shared workspace data and work: leads, CRM, receptionist, finance, memory, coding, chat. */
  | { kind: "business"; area?: string }
  /** Machine-internal services for local processes (Claude/Cline bridges, the Jev guardian). */
  | { kind: "internal"; service: string }
  /**
   * Acting on a device. `executor: "hub"` means the code runs on THIS PC; `presence` means it acts
   * on the screen, mic or settings in front of the person, so they must be at this PC.
   */
  | { kind: "device"; executor: "hub" | "dispatch"; spokenTarget?: string; deviceId?: string; presence?: boolean };

export type Action = "read" | "write" | "run" | "control" | "configure";

export type Authorisation = { ok: true; targetDeviceId?: string } | { ok: false; status: 401 | 403; reason: string };

export type AuthoriseDeps = { resolveTarget?: (ctx: ResolveContext) => ResolveResult; hubDeviceId?: string };

export function authorise(principal: Principal | null, resource: Resource, action: Action = "read", deps: AuthoriseDeps = {}): Authorisation {
  if (!principal) return { ok: false, status: 401, reason: "Sign in first: use Agentic OS at this PC, or open it through your own Tailscale address." };
  switch (resource.kind) {
    case "business":
      // V7: one shared workspace; both founders, signed in, get full access. No per-person rules.
      return { ok: true };
    case "internal":
      return principal.via === "loopback-owner"
        ? { ok: true }
        : { ok: false, status: 403, reason: `${resource.service} is internal to this PC and only answers local programs.` };
    case "device":
      return authoriseDevice(principal, resource, action, deps);
  }
}

function authoriseDevice(principal: Principal, resource: Extract<Resource, { kind: "device" }>, _action: Action, deps: AuthoriseDeps): Authorisation {
  const hub = deps.hubDeviceId ?? HUB_DEVICE_ID;
  const resolve = deps.resolveTarget ?? ((ctx: ResolveContext) => defaultResolveTarget(ctx));
  let result: ResolveResult;
  try {
    result = resolve({
      personId: principal.personId,
      spokenTarget: resource.spokenTarget,
      // A browser session isn't a device; the hub at this PC and companions are.
      originDeviceId: principal.via === "loopback-owner" || principal.via === "companion" ? principal.deviceId : undefined,
    });
  } catch (error) {
    return { ok: false, status: 403, reason: `Couldn't work out which device that's for (${(error as Error).message.slice(0, 80)}), so nothing ran.` };
  }
  if (!result.ok) return { ok: false, status: 403, reason: `Not done: ${result.reason}. Nothing ran on ${principal.personId === "usman" ? "any device" : "Usman's PC"}.` };
  if (resource.deviceId && result.deviceId !== resource.deviceId)
    return { ok: false, status: 403, reason: `That device isn't the one this is for (${result.deviceId}). Nothing ran.` };
  if (resource.executor === "hub") {
    // The hub executes only for its own owner; for anyone else the command is theirs to run on their own device.
    if (result.deviceId !== hub)
      return { ok: false, status: 403, reason: `That runs on your own device (${result.deviceId}), not Usman's PC. Sending it there arrives with the companion; nothing ran here.` };
    if (resource.presence && principal.via !== "loopback-owner")
      return { ok: false, status: 403, reason: "That acts on this PC's screen, so it runs only for someone at the PC. Nothing ran." };
  }
  return { ok: true, targetDeviceId: result.deviceId };
}

// ---------------------------------------------------------------------------------------------
// Page tokens: the internal per-run token never leaves this PC

/**
 * The page token a browser sends back on writes (X-Claude-OS-Token). At this PC it is the per-run
 * internal token, exactly as before (local cron scripts read it from /__token too). A remote
 * principal gets a token derived from it and bound to their person (so pairing a signed-in browser
 * doesn't invalidate the page it's on); the gate accepts it only from a request that resolves to
 * that same person, and maps it to the internal token for the downstream checks. The internal
 * token is never handed to a remote principal, and a leaked one is useless from the tailnet. Every
 * remote token changes when the server restarts (the internal token rotates).
 */
export function pageTokenFor(principal: Pick<Principal, "personId" | "via">, internalToken: string): string {
  if (principal.via === "loopback-owner") return internalToken;
  return derive(internalToken, `page|${principal.personId}`);
}

/** For a Serve-verified login with no principal yet: good only for /__devices/pair/*. */
export function pairingTokenFor(personId: PersonId, internalToken: string): string {
  return derive(internalToken, `pair|${personId}`);
}

function derive(secret: string, label: string) {
  return `p1.${createHmac("sha256", secret).update(label).digest("base64url")}`;
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
