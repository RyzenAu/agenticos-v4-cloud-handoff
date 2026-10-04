import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Dispatcher, isRisky, type Observation } from "./dispatch";
import { identify, identifyCompanion, viaBridge, knownPeople, NAME_COOKIE, SESSION_COOKIE, type RequestIdentity } from "./identity";
import { authorise, permissionSummary, withDisplayName, type Principal, type Resource } from "./permissions";
import { defaultHub, DeviceRegistry, HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS, setActiveRegistry } from "./registry";
import { CODE_TTL_MS, DeviceStore, SESSION_TTL_MS, type SessionRow } from "./store";
import { normalisePersonId, type PersonId, type TargetDevice } from "./types";
import { pageTokenMatches } from "../identity/gate";
import { pageTokenFor, pairingTokenFor, safeEqual, sessionCookieValues } from "../identity/principal";
import type { ServePeerCheck } from "../identity/serve-peer";
import { serveSourceAddress, serveSourceNode, type TailnetSource } from "../remote-access";
import { hubIsDeviceFor, hubRole, type HubRole } from "../cloud/hub-role";

/**
 * /__devices — pairing, sessions, the name picker, paired devices, who's online, companion
 * transport and command routing. Mount with `server.middlewares.use("/__devices", svc.handle)`.
 *
 * Guards (never weaker than /__operator): loopback socket only; either a local Host with no
 * relay headers (Usman at this PC) or a Serve-relayed request from someone in people.json. Who the
 * caller is comes from the one identity contract (scripts/identity/principal.ts). A verified login
 * with no principal (Tailscale sign-in turned off for them, or a revoked session cookie) may only
 * see /me and pair again.
 * Browser writes need JSON, same-origin, not cross-site, and the page token when configured.
 * Companion routes need a paired bearer token whose owner matches the Tailscale login.
 */

export type DevicesServiceOptions = {
  root: string;
  /** The per-run page token (X-Claude-OS-Token) required on browser writes, when provided. */
  token?: string | (() => string);
  /** Override this PC's tailnet name (tests). Defaults to ownTailnetName(). */
  tailnetName?: string;
  /** Tests simulating Tailscale Serve over a plain loopback socket (see IdentityContext.servePeer). */
  servePeer?: ServePeerCheck;
  /** Tests: a synthetic tailnet snapshot (see IdentityContext.tailnet). */
  tailnet?: TailnetSource;
  now?: () => number;
  store?: DeviceStore;
  hub?: TargetDevice;
  /** Make this the registry resolveTarget() uses by default (the live server does this). */
  install?: boolean;
  /** Maximum long-poll wait for companions. */
  maxWaitMs?: number;
  /** How long the hub waits for a companion to say what happened to a command whose ack was lost (tests shorten it). */
  observeWaitMs?: number;
  /**
   * Where this hub runs (default: MU_HUB_ROLE). In the "cloud" and "server" roles the hub is a server, not anyone's PC: it is NOT
   * a device at all (not listed, not online, not a target, not a fallback), so Usman's PC is his paired companion,
   * exactly like Mehroz's, and "here" resolves to the requester's own companion or fails honestly as offline.
   */
  hubRole?: HubRole;
};

const LIMIT = 16 * 1024;
/** REVIEW-S1 F1: session and device administration; a human session only. */
/** Device routes a bare tailnet login may not use, read or write (acceptance #18). */
const BARE_LOGIN_REFUSED = new Set(["/commands", "/commands/cancel", "/devices", "/sessions"]);
const ADMIN_WRITES = new Set(["/pair/code", "/sessions/revoke", "/devices/revoke", "/policy/self-pair", "/policy/finance", "/sessions/confirm-code", "/sessions/approve"]);
const SEEN_WINDOW_MS = 2 * 60 * 1000;

/**
 * R7 review finding 1. A pending Tailscale browser is shown its own short match code (only to itself: /me, and the response to its own pairing call;
 * never in the session list an approver sees, so it cannot be copied from the approver's screen). It is derived from the session id. Approving needs that code typed from the NEW device's screen, and the
 * server checks it, so a program on the founder's machine that paired a pending session labelled "Desktop app" cannot be approved by a blind click: the
 * founder's real browser shows a different code.
 */
export function sessionMatchCode(sessionId: string): string {
  const h = createHash("sha256").update(`match|${sessionId}`).digest("hex").toUpperCase();
  return `${h.slice(0, 3)}-${h.slice(3, 6)}`;
}
export const normaliseMatchCode = (value: unknown) => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Where a Serve request came from, for the person who will approve it: the tailnet address and the node the hub resolved ("100.64.0.12#nABC"). */
function pairSource(req: IncomingMessage, tailnet: TailnetSource | undefined): string {
  const address = serveSourceAddress(req as never) ?? "unknown";
  const node = serveSourceNode(req as never, tailnet);
  return node.ok ? `${address}#${node.nodeId}` : address;
}

export function createDevicesService(options: DevicesServiceOptions) {
  const now = options.now ?? Date.now;
  const store = options.store ?? new DeviceStore(options.root, { now });
  const hub = options.hub ?? defaultHub();
  const role: HubRole = options.hubRole ?? hubRole();
  // Only the PC role lists the hub as a device. A cloud or server hub is nobody's PC, so it is never a target or a fallback.
  const registry = new DeviceRegistry(() => (hubIsDeviceFor(role) ? [hub, ...store.companions()] : store.companions()), now, PRESENCE_TTL_MS);
  const dispatcher = new Dispatcher(registry, now, options.observeWaitMs);
  const seen = new Map<PersonId, number>();
  const maxWait = options.maxWaitMs ?? 25_000;
  dispatcher.start();
  if (options.install) setActiveRegistry(registry);
  const idOpts = { root: options.root, store, tailnetName: options.tailnetName, servePeer: options.servePeer, tailnet: options.tailnet };
  const pageToken = () => (typeof options.token === "function" ? options.token() : options.token);

  /**
   * Who may administer a person's devices and sessions (codes, approve, revoke, policy). In the server role the founders are equal:
   * each controls his OWN devices only (Usman is not a super-admin); the console code CLI is the cross-person route. Elsewhere
   * permissions.ts decides as it always did.
   */
  function adminAuth(principal: Principal, person: PersonId) {
    if (role === "server" && principal.personId !== person) return { allowed: false as const, reason: "You manage only your own devices. For someone else's, make a one-time code at the server console." };
    return authorise(principal, { kind: "devices-admin", person });
  }

  function principalOf(req: IncomingMessage): Principal | null {
    const id = identify(req, idOpts);
    return id.principal ? withDisplayName(id.principal, id.picked) : null;
  }

  /** For other plugins: may this request touch that resource? */
  function authoriseRequest(req: IncomingMessage, resource: Resource) {
    return authorise(principalOf(req), resource, store.policy());
  }

  function send(res: ServerResponse, status: number, value: unknown, cookies: string[] = []) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    res.end(JSON.stringify(value));
  }

  function cookie(name: string, value: string, secure: boolean, maxAgeMs = SESSION_TTL_MS) {
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  async function body(req: IncomingMessage): Promise<any> {
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) throw Object.assign(new Error("JSON required"), { status: 415 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMIT) throw Object.assign(new Error("Too large"), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString() || "{}";
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : {};
    } catch {
      throw Object.assign(new Error("Bad JSON"), { status: 400 });
    }
  }

  function browserWriteBlocked(req: IncomingMessage, id: RequestIdentity, path: string): string | null {
    const host = String(req.headers.host ?? "");
    const own = `${id.secure ? "https" : "http"}://${host}`;
    if (req.headers.origin && req.headers.origin !== own) return "Unknown origin";
    if (req.headers["sec-fetch-site"] === "cross-site") return "Cross-site request blocked";
    const expected = pageToken();
    if (expected) {
      // The caller's OWN page token (Stage B1): internal at this PC, person-bound remotely; a verified
      // login with no principal may present its pairing-only token, and only to pair.
      const presented = req.headers["x-claude-os-token"];
      const pairing = !id.verified && !!id.tailnet && (path === "/pair/tailnet" || path === "/pair/redeem");
      // No principal and not pairing: the 401 below answers it.
      if (!id.verified && !pairing) return null;
      const ok = pairing
        ? typeof presented === "string" &&
          (safeEqual(presented, pairingTokenFor(id.tailnet!, expected)) || safeEqual(presented, pageTokenFor({ personId: id.tailnet!, via: "tailnet-person" }, expected)))
        : pageTokenMatches(id.verified, presented, expected);
      if (!ok) return "Refresh this page and try again.";
    }
    return null;
  }

  function sessionView(row: SessionRow, current?: string) {
    return { id: row.id, personId: row.personId, label: row.label, via: row.via, createdAt: row.createdAt, expiresAt: row.expiresAt, lastSeen: row.lastSeen, revoked: !!row.revokedAt, expired: row.expiresAt <= now(), current: row.id === current, pending: !!row.pending, ...(row.via === "tailnet" && row.pending && current === row.id ? { matchCode: sessionMatchCode(row.id) } : {}), ...(row.via === "tailnet" && row.source ? { source: row.source } : {}) };
  }

  /**
   * `viewer`: who is looking. The UI wording hook is `displayLabel`: "Offline" when the device is not online, else
   * "This PC" for the viewer's own device (`mine`), else its label. Data only; the pages decide how to show it.
   */
  function deviceView(d: TargetDevice, viewer?: PersonId) {
    const p = registry.presenceOf(d.id);
    const online = registry.isOnline(d);
    const mine = viewer !== undefined && d.owner === viewer;
    return {
      id: d.id, owner: d.owner, kind: d.kind, label: d.label, aliases: d.aliases, primary: !!d.primary,
      online, lastSeen: d.kind === "hub" ? now() : p?.lastSeen ?? null,
      micOwned: d.kind === "hub" ? null : p?.micOwned ?? null, busy: p?.busy ?? false,
      pairedAt: d.pairedAt ?? null, expiresAt: d.expiresAt ?? null, revoked: !!d.revokedAt,
      // Worker facts, as the companion itself reported them (null before its first heartbeat, or for the hub).
      workerVersion: d.kind === "hub" ? null : p?.version || null,
      capabilities: d.kind === "hub" ? null : p?.capabilities ?? null,
      interactive: d.kind === "hub" ? null : p?.interactive ?? null,
      mine,
      displayLabel: !online ? "Offline" : mine ? "This PC" : d.label,
    };
  }

  function people(root: string) {
    return knownPeople(root);
  }

  /**
   * R7-G journey B. In the server role a bare Tailscale login pairs a PENDING session. The identity layer deliberately ignores a pending
   * cookie (it is not a session: no principal, `session: null`), so before this the browser that holds it saw "Pair this device" again,
   * with a notice that said it was paired. The browser may be told about ITS OWN waiting session (a cookie it already presents) so the
   * page can say "waiting for a code" and stop offering the bare-login button. Nothing here makes it confirmed. The only code in it is that
   * session's own match code (sessionView adds it for the browser's CURRENT session), shown so the person can compare it on the confirming device;
   * no pairing code and no other session's code is ever shown.
   */
  function waitingSession(req: IncomingMessage, id: RequestIdentity) {
    if (!id.tailnet || id.session) return null;
    for (const value of sessionCookieValues(req.headers.cookie)) {
      const row = store.verifySession(value);
      if (row && row.pending && row.via === "tailnet" && row.personId === id.tailnet) return sessionView(row, row.id);
    }
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname.replace(/^\/__devices(?=\/|$)/, "").replace(/\/+$/, "") || "/";
      const method = req.method || "GET";
      if (path.startsWith("/companion/")) return await companionRoute(req, res, path, method, url);
      const id = identify(req, idOpts);
      if (!id.loopbackSocket) return send(res, 403, { error: "Local access only" });
      if (!id.local && !id.tailnet) return send(res, 403, { error: "Local host required" });
      const principal = id.principal ? withDisplayName(id.principal, id.picked) : null;
      if (principal) seen.set(principal.personId, now());
      if (method !== "GET") {
        const blocked = browserWriteBlocked(req, id, path);
        if (blocked) return send(res, 403, { error: blocked });
      }
      const policy = store.policy();

      if (method === "GET" && path === "/me") {
        const person = principal?.personId ?? id.tailnet;
        return send(res, 200, {
          authorised: !!principal,
          via: principal?.via ?? null,
          person: person ? people(options.root).find((p) => p.id === person) ?? { id: person, name: person } : null,
          // Stage B1: the one verified principal; its display name is what the UI and activity history show.
          // Never the server-only sessionId (B2's UI confirm binds to it).
          principal: id.verified ? { personId: id.verified.personId, via: id.verified.via, actor: id.verified.actor, displayName: id.verified.displayName } : null,
          displayAs: principal?.displayAs ?? id.picked ?? null,
          sharedOnly: !!principal?.sharedOnly,
          local: id.local,
          session: id.session ? sessionView(id.session, id.session.id) : null,
          // Server role: this browser's own pending tailnet session (see waitingSession); null otherwise.
          waitingSession: waitingSession(req, id),
          // AUDIT-A1-3: a browser at this PC whose hub session a navigation minted and nobody has confirmed
          // yet. REVIEW-S1 F2b: never a code here. Anything this browser can read, the program that forged
          // its navigation can read too; the code comes from a human context and is typed in.
          hubSession: id.local && id.session?.via === "hub" ? { pending: !!id.session.pending } : null,
          // A verified Tailscale login can always ask for a remembered (30-day, revocable) session.
          canSelfPair: !id.session && !!id.tailnet && policy.selfPair[id.tailnet] !== false,
          // The server's role, so the page can say how a code is made (console command) without guessing.
          hubRole: role,
          // Server role: a caller who is nobody (an unproven local process) is not shown who the founders are.
          people: role === "server" && !principal && !id.tailnet ? [] : people(options.root),
          permissions: permissionSummary(principal, policy),
        });
      }
      if (method === "POST" && path === "/pair/tailnet") {
        if (!id.tailnet) return send(res, 403, { error: "Open the OS through your Tailscale address to pair." });
        if (id.session) return send(res, 409, { error: "This device is already paired." });
        if (policy.selfPair[id.tailnet] === false) return send(res, 403, { error: "This account needs a pairing code from one of its paired devices." });
        const b = await body(req);
        // Server role: a bare Tailscale login is a PROCESS (a script on that person's machine can call this route), so the
        // session it earns is PENDING: shared access as before, but not a confirmed human session, so it does not open the
        // server's local-owner routes. A confirmed session approves it (POST /sessions/approve), or a one-time code does
        // (made by a confirmed session at /pair/code, or on the server console with scripts/identity/pair-code.ts).
        const pending = role === "server";
        if (pending) {
          // A script can call this route in a loop: keep at most a few unconfirmed browsers per person (oldest out).
          const open = store.sessions(id.tailnet).filter((x) => x.via === "tailnet" && x.pending && !x.revokedAt && x.expiresAt > now()).sort((a, b) => a.createdAt - b.createdAt);
          for (const old of open.slice(0, Math.max(0, open.length - 4))) store.revokeSession(old.id);
        }
        const { cookie: value, session } = store.mintSession(id.tailnet, String(b.label ?? ""), "tailnet", pending ? { pending: true, source: pairSource(req, options.tailnet) } : {});
        return send(res, 200, { paired: true, ...(pending ? { pending: true, needsApproval: true } : {}), session: sessionView(session, session.id) }, [cookie(SESSION_COOKIE, value, id.secure)]);
      }
      if (method === "POST" && path === "/pair/redeem") {
        if (!id.tailnet) return send(res, 403, { error: "Open the OS through your Tailscale address to pair." });
        if (id.session) return send(res, 409, { error: "This device is already paired." });
        const b = await body(req);
        // REVIEW-S1 R2-2: the lockout is this person's own (a verified login), not everyone's.
        const redeemed = store.redeemCode(String(b.code ?? ""), "browser", id.tailnet);
        if (!redeemed.ok) return send(res, 403, { error: redeemed.reason });
        if (redeemed.personId !== id.tailnet) return send(res, 403, { error: "That code was made for someone else." });
        const { cookie: value, session } = store.mintSession(id.tailnet, String(b.label ?? ""), "code");
        // The new cookie replaces this browser's pending one: retire that pending session now, so it is not left in the list for
        // someone to approve later. Only a pending session of THIS person that this very request presented is touched.
        for (const old of sessionCookieValues(req.headers.cookie)) {
          const row = store.verifySession(old);
          if (row && row.pending && row.via === "tailnet" && row.personId === id.tailnet) store.revokeSession(row.id);
        }
        return send(res, 200, { paired: true, session: sessionView(session, session.id) }, [cookie(SESSION_COOKIE, value, id.secure)]);
      }

      // Everything below needs an authorised device.
      if (!principal) return send(res, 401, { error: "Pair this device first." });

      // Acceptance #18 (review of 712f04eb, M1): a bare tailnet login (an unpaired, pending or revoked browser, or a script on the
      // founder's machine) may pair itself and read /me, but never drives a device, cancels a command or lists devices and sessions.
      if (id.verified?.via === "tailnet-person" && BARE_LOGIN_REFUSED.has(path))
        return send(res, 403, { error: "Confirm this browser first (System › Devices and people), then try again." });

      // REVIEW-S1 F1: device and session administration is for a person acting now (a confirmed browser
      // session or a paired device), never a program. Any local program holds the page token, so without
      // this it could list the owner's sessions and revoke his confirmed one, leaving him pending.
      if (method === "POST" && ADMIN_WRITES.has(path) && id.verified?.actor !== "human")
        return send(res, 403, {
          error: id.local && id.session?.pending
            ? "Confirm this browser first (System › Devices and people), then try again."
            : "Only a person using a confirmed browser or paired device can change devices and sessions.",
        });

      if (method === "POST" && path === "/name") {
        const b = await body(req);
        const picked = b.personId == null || b.personId === "" ? null : normalisePersonId(b.personId);
        if (b.personId && !picked) return send(res, 400, { error: "Unknown name." });
        const value = picked ? cookie(NAME_COOKIE, picked, id.secure) : cookie(NAME_COOKIE, "", id.secure, 0);
        const after = withDisplayName(id.principal!, picked);
        return send(res, 200, { displayAs: after.displayAs, sharedOnly: !!after.sharedOnly, permissions: permissionSummary(after, policy) }, [value]);
      }
      if (method === "POST" && path === "/pair/code") {
        const b = await body(req);
        const purpose = b.purpose === "companion" ? "companion" : "browser";
        const forPerson = b.personId ? normalisePersonId(b.personId) : principal.personId;
        if (!forPerson) return send(res, 400, { error: "Unknown person." });
        const d = adminAuth(principal, forPerson);
        if (!d.allowed) return send(res, 403, { error: d.reason });
        return send(res, 200, { ...store.createCode(forPerson, purpose, principal.personId), personId: forPerson, purpose });
      }
      if (method === "GET" && path === "/sessions") {
        // Server role: your own sessions only (the other founder's online status is in /devices, his session details are not yours to see).
        const all = role !== "server" && principal.personId === "usman" && !principal.sharedOnly;
        const rows = store.sessions(all ? undefined : principal.personId);
        return send(res, 200, { sessions: rows.map((r) => sessionView(r, principal.sessionId)) });
      }
      if (method === "POST" && path === "/sessions/confirm-code") {
        // AUDIT-A1-3 / REVIEW-S1 F2b: Usman acting now (a confirmed browser at this PC or his own paired
        // device) makes a one-time code, reads it on his screen and types it into the new browser. The
        // code is only ever in this response to a human session, never on the pending browser.
        const v = id.verified;
        if (!v || v.personId !== "usman" || v.actor !== "human" || principal.sharedOnly)
          return send(res, 403, { error: "Make a confirm code on a browser Usman already uses (System › Devices and people), or run the confirm-browser command in a terminal on this PC." });
        return send(res, 200, { ...store.createCode("usman", "hub", "usman"), purpose: "hub" });
      }
      if (method === "POST" && path === "/sessions/confirm") {
        // The pending browser at this PC confirms ITSELF with a code a human typed into it.
        if (!id.local || id.session?.via !== "hub") return send(res, 403, { error: "Only a new browser at this PC confirms itself with a code." });
        if (!id.session.pending) return send(res, 409, { error: "This browser is already confirmed." });
        const b = await body(req);
        const r = store.confirmHubSession(id.session.id, String(b.code ?? ""));
        return r.ok ? send(res, 200, { confirmed: sessionView(r.session, id.session.id) }) : send(res, 403, { error: r.reason });
      }
      if (method === "POST" && path === "/sessions/approve") {
        // Server role: a confirmed human session (either founder's) approves a new browser that paired with a bare Tailscale
        // login. The ADMIN_WRITES gate above has already required an actor-human principal.
        const b = await body(req);
        // A pending Tailscale browser of THIS person needs the code its own screen shows (other cases fall through to the store's own 403/404/409).
        const target = store.sessions().find((x) => x.id === String(b.sessionId ?? "") && !x.revokedAt && x.expiresAt > now());
        if (target && target.pending && target.via === "tailnet" && target.personId === principal.personId) {
          const given = normaliseMatchCode(b.matchCode);
          if (!given) return send(res, 400, { error: "Type the code shown on the new device to approve it." });
          if (given !== normaliseMatchCode(sessionMatchCode(target.id))) return send(res, 403, { error: "That code does not match the one on the new device, so it was not approved. If you do not recognise this browser, revoke it." });
        }
        const approved = store.approveSession(String(b.sessionId ?? ""), principal.personId);
        return approved.ok ? send(res, 200, { approved: sessionView(approved.session) }) : send(res, approved.status, { error: approved.reason });
      }
      if (method === "POST" && path === "/pair/console-code") {
        // Server role: a one-time code minted at the server's own console. Only the loopback owner WITH the local-owner
        // proof reaches this as a principal (an unproven loopback request is nobody), so reading the token file is the proof.
        // The founder types the code into his new browser (/pair/redeem), which earns a CONFIRMED session.
        if (role !== "server" || id.verified?.via !== "loopback-owner" || !id.local)
          return send(res, 403, { error: "Console codes are made at the server itself, with the local-owner token (scripts/identity/pair-code.ts)." });
        const b = await body(req);
        const who = normalisePersonId(b.personId);
        if (!who || !people(options.root).some((p) => p.id === who)) return send(res, 400, { error: "Unknown person." });
        return send(res, 200, { ...store.createCode(who, "browser", "usman"), personId: who, purpose: "browser", ttlMs: CODE_TTL_MS });
      }
      if (method === "POST" && path === "/sessions/revoke") {
        const b = await body(req);
        const row = store.sessions().find((s) => s.id === String(b.sessionId ?? ""));
        if (!row) return send(res, 404, { error: "No such session." });
        const d = adminAuth(principal, row.personId);
        if (!d.allowed) return send(res, 403, { error: d.reason });
        store.revokeSession(row.id);
        if (b.requireCode === true) store.setSelfPair(row.personId, false);
        const clear = row.id === principal.sessionId ? [cookie(SESSION_COOKIE, "", id.secure, 0)] : [];
        return send(res, 200, { revoked: row.id, selfPair: store.policy().selfPair[row.personId] }, clear);
      }
      if (method === "GET" && path === "/devices") {
        const t = now();
        const online = people(options.root).map((p) => ({
          ...p,
          online: registry.targets().some((d) => d.owner === p.id && d.kind === "companion" && registry.isOnline(d)) || t - (seen.get(p.id) ?? 0) <= SEEN_WINDOW_MS,
          lastSeen: seen.get(p.id) ?? null,
        }));
        return send(res, 200, { devices: registry.all().map((d) => deviceView(d, principal.personId)), people: online, heartbeatMs: HEARTBEAT_INTERVAL_MS, ttlMs: PRESENCE_TTL_MS });
      }
      if (method === "POST" && path === "/devices/revoke") {
        const b = await body(req);
        const device = store.companions().find((c) => c.id === String(b.deviceId ?? ""));
        if (!device) return send(res, 404, { error: "No such paired companion." });
        // Either founder may retire a shared cloud computer; a personal PC stays its owner's (Usman manages all).
        const d = device.owner === "shared" ? ({ allowed: true } as const) : adminAuth(principal, device.owner);
        if (!d.allowed) return send(res, 403, { error: d.reason });
        store.revokeCompanion(device.id);
        dispatcher.deviceOffline(device.id);
        return send(res, 200, { revoked: device.id });
      }
      if (method === "POST" && path === "/policy/self-pair") {
        const b = await body(req);
        const person = normalisePersonId(b.personId);
        if (!person) return send(res, 400, { error: "Unknown person." });
        const d = adminAuth(principal, person);
        if (!d.allowed) return send(res, 403, { error: d.reason });
        store.setSelfPair(person, b.allowed === true);
        return send(res, 200, { selfPair: store.policy().selfPair });
      }
      if (method === "POST" && path === "/policy/finance") {
        if (principal.personId !== "usman" || principal.sharedOnly) return send(res, 403, { error: "Only Usman can share his finance view." });
        const b = await body(req);
        const person = normalisePersonId(b.personId);
        if (!person || person === "usman") return send(res, 400, { error: "Choose who to share with." });
        store.setFinanceGrant(person, b.granted === true);
        return send(res, 200, { financeGrants: store.policy().financeGrants });
      }
      if (method === "GET" && path === "/authorise") {
        const resource = resourceFromQuery(url.searchParams, registry);
        if (!resource) return send(res, 400, { error: "Unknown resource." });
        return send(res, 200, authorise(principal, resource, policy));
      }
      if (method === "POST" && path === "/commands") {
        if (principal.sharedOnly) return send(res, 403, { error: "Device control needs your own paired device." });
        const b = await body(req);
        const executor = String(b.executor ?? "");
        // A click is not a spoken yes: risky actions only come through the Jarvis voice path.
        if (isRisky(executor, b.risk)) return send(res, 403, { error: "Send, pay, delete and publish need your own spoken yes through Jarvis." });
        const result = await dispatcher.submit(
          { personId: principal.personId, spokenTarget: typeof b.spokenTarget === "string" ? b.spokenTarget : undefined, executor, args: b.args && typeof b.args === "object" ? b.args : {} },
          { timeoutMs: Math.min(Number(b.timeoutMs) || 30_000, 120_000) },
        );
        return send(res, result.ok ? 200 : 409, result);
      }
      if (method === "POST" && path === "/commands/cancel") {
        const b = await body(req);
        const r = dispatcher.cancel(String(b.commandId ?? ""), principal.personId);
        return send(res, r.ok ? 200 : 409, r);
      }
      if (next) return next();
      return send(res, 404, { error: "Not found" });
    } catch (error: any) {
      return send(res, error?.status ?? 500, { error: error?.status ? error.message : "Something went wrong." });
    }
  }

  async function companionRoute(req: IncomingMessage, res: ServerResponse, path: string, method: string, url: URL) {
    // Companions are programs, never web pages.
    if (req.headers.origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none"))
      return send(res, 403, { error: "Not available to web pages" });
    if (method === "POST" && path === "/companion/pair") {
      const id = identify(req, idOpts);
      if (!id.loopbackSocket) return send(res, 403, { error: "Connect through the tailnet to pair." });
      const b = await body(req);
      // Through the computers bridge (it stamps x-mu-bridge) the caller can be any process on another host's loopback: it may redeem ONLY a
      // cloud computer's one-time code, in the bridge's own lockout bucket, never a person's code and never the shared "hub" bucket.
      const bridged = viaBridge(req);
      // A shared cloud computer pairs with a one-time code the hub itself made for its provisioning (scripts/computers):
      // the code names the computer and who provisioned it; the redeeming program claims nothing. It connects from the
      // same host or the allow-listed bridge, so no Tailscale login is involved, only the code.
      if (b && typeof b.code === "string" && store.read().codes.some((c) => c.purpose === "computer")) {
        const origin = bridged || !id.local ? "bridge" : "hub";
        const computer = store.redeemCode(String(b.code), "computer", undefined, origin);
        if (computer.ok && computer.computer) {
          const { device, token } = store.registerComputer(computer.computer, { label: String(b.label ?? "") });
          return send(res, 200, { deviceId: device.id, owner: device.owner, kind: device.kind, label: device.label, token, expiresAt: device.expiresAt, heartbeatMs: HEARTBEAT_INTERVAL_MS });
        }
        // Not a computer code: fall through (the person flow below gives its own refusal, and its own lockout).
        if (!computer.ok && /Too many/.test(computer.reason)) return send(res, 403, { error: computer.reason });
      }
      if (bridged) return send(res, 403, { error: "That code isn't valid here." });
      // Server role: a loopback request maps to Usman only WITH the local-owner token (an unproven local process, or a WSL user over
      // mirrored networking, is nobody). Pairing over Serve (a tailnet login) and the bridge paths above are unchanged.
      if (role === "server" && id.local && id.verified?.via !== "loopback-owner") return send(res, 403, { error: "Pairing a companion from this machine needs the local-owner token (scripts/identity/local-owner-token.ts path)." });
      if (!id.local && !id.tailnet) return send(res, 403, { error: "Connect through the tailnet to pair." });
      const who = id.local ? "usman" : id.tailnet!;
      // REVIEW-S1 N2: the lockout is per origin too. Every local program shares "hub"; a remote device is
      // its tailnet node, so a local program's wrong codes never lock the owner's other PC out.
      const source = id.local ? null : serveSourceNode(req, options.tailnet);
      const origin = id.local ? "hub" : source?.ok ? source.nodeId : "tailnet";
      const redeemed = store.redeemCode(String(b.code ?? ""), "companion", who, origin);
      if (!redeemed.ok) return send(res, 403, { error: redeemed.reason });
      if (redeemed.personId !== who) return send(res, 403, { error: "That code was made for someone else." });
      const aliases = Array.isArray(b.aliases) ? b.aliases.map(String) : [];
      const { device, token } = store.registerCompanion(who, { label: String(b.label ?? ""), aliases });
      return send(res, 200, { deviceId: device.id, owner: device.owner, label: device.label, token, expiresAt: device.expiresAt, heartbeatMs: HEARTBEAT_INTERVAL_MS });
    }
    const who = identifyCompanion(req, idOpts);
    if ("error" in who) return send(res, who.status, { error: who.error });
    const deviceId = who.device.id;
    if (method === "POST" && path === "/companion/heartbeat") {
      const b = await body(req);
      const wasOnline = registry.isOnline(who.device);
      registry.heartbeat(deviceId, {
        micOwned: b.micOwned === true,
        busy: b.busy === true,
        version: String(b.version ?? "").slice(0, 32),
        ...(Array.isArray(b.capabilities) ? { capabilities: b.capabilities.map((c: unknown) => String(c).slice(0, 40)).slice(0, 40) } : {}),
        ...("interactive" in b ? { interactive: typeof b.interactive === "boolean" ? b.interactive : null } : {}),
      });
      // Back after a drop: learn what became of anything it was holding (annotates only; nothing is ever re-sent).
      if (!wasOnline) dispatcher.reconcile(deviceId);
      // Idle yet holding a command it was sent a while ago: its process was restarted. Ask it (observe), don't wait out the whole timeout.
      if (b.busy !== true) dispatcher.reviewIdle(deviceId);
      return send(res, 200, { ok: true, deviceId, owner: who.device.owner, serverTime: now(), expiresAt: who.device.expiresAt });
    }
    if (method === "GET" && path === "/companion/next") {
      registry.heartbeat(deviceId);
      const wait = Math.max(0, Math.min(Number(url.searchParams.get("wait") ?? maxWait) || 0, maxWait));
      const item = await dispatcher.next(deviceId, wait);
      if (res.writableEnded || res.destroyed) {
        if (item) dispatcher.undeliver(deviceId, item); // the companion hung up; keep it for the next poll
        return;
      }
      return send(res, 200, { item });
    }
    if (method === "POST" && path === "/companion/result") {
      const b = await body(req);
      const accepted = dispatcher.complete(deviceId, String(b.commandId ?? ""), { ok: b.ok === true, output: b.output, error: typeof b.error === "string" ? b.error.slice(0, 500) : undefined });
      return send(res, accepted ? 200 : 409, { accepted });
    }
    if (method === "POST" && path === "/companion/progress") {
      const b = await body(req);
      return send(res, 200, { accepted: dispatcher.progress(deviceId, String(b.commandId ?? ""), b.step) });
    }
    if (method === "POST" && path === "/companion/observation") {
      // The companion's answer to "what happened to that command?": done (with its result), running,
      // interrupted (it started before a restart), cancelled, or unknown (no record: it never received it).
      const b = await body(req);
      const o = b.observation && typeof b.observation === "object" ? (b.observation as Record<string, unknown>) : {};
      const state = String(o.state ?? "");
      const observation: Observation | null =
        state === "done" ? { state: "done", ok: o.ok === true, output: o.output, error: typeof o.error === "string" ? o.error.slice(0, 500) : undefined }
        : state === "running" || state === "interrupted" || state === "cancelled" || state === "unknown" ? { state }
        : null;
      if (!observation) return send(res, 400, { error: "Unknown observation." });
      return send(res, 200, { accepted: dispatcher.reportObservation(deviceId, String(b.commandId ?? ""), observation) });
    }
    if (method === "POST" && path === "/companion/goodbye") {
      dispatcher.deviceOffline(deviceId);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Not found" });
  }

  function close() {
    dispatcher.close();
    if (options.install) setActiveRegistry(undefined);
  }

  return { handle, close, registry, dispatcher, store, principalOf, authoriseRequest, /** The verified identity behind a request (scripts/computers mounts its own routes on it). */ identify: (req: IncomingMessage) => identify(req, idOpts), /** Browser-write guard (origin, cross-site, page token) shared with other routes. */ browserWriteBlocked, hubRole: role, /** whether the hub's own PC is a controllable device (false in the cloud and server roles) */ hubIsDevice: hubIsDeviceFor(role) };
}

function resourceFromQuery(q: URLSearchParams, registry: DeviceRegistry): Resource | null {
  const kind = q.get("kind");
  if (kind === "business") return { kind: "business" };
  if (kind === "memory") {
    const scope = q.get("scope") === "shared" ? "shared" : normalisePersonId(q.get("scope"));
    return scope ? { kind: "memory", scope } : null;
  }
  if (kind === "finance") {
    const owner = normalisePersonId(q.get("owner") ?? "usman");
    return owner ? { kind: "finance", owner } : null;
  }
  if (kind === "device") {
    const device = registry.all().find((d) => d.id === q.get("deviceId"));
    return device ? { kind: "device", device } : null;
  }
  return null;
}

export type DevicesService = ReturnType<typeof createDevicesService>;
