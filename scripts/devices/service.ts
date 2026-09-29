import type { IncomingMessage, ServerResponse } from "node:http";
import { Dispatcher, isRisky } from "./dispatch";
import { identify, identifyCompanion, knownPeople, NAME_COOKIE, SESSION_COOKIE, type RequestIdentity } from "./identity";
import { authorise, permissionSummary, withDisplayName, type Principal, type Resource } from "./permissions";
import { defaultHub, DeviceRegistry, HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS, setActiveRegistry } from "./registry";
import { DeviceStore, SESSION_TTL_MS, type SessionRow } from "./store";
import { normalisePersonId, type PersonId, type TargetDevice } from "./types";
import { pageTokenMatches } from "../identity/gate";
import { pageTokenFor, pairingTokenFor, safeEqual } from "../identity/principal";
import type { ServePeerCheck } from "../identity/serve-peer";
import { serveSourceNode, type TailnetSource } from "../remote-access";

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
};

const LIMIT = 16 * 1024;
/** REVIEW-S1 F1: session and device administration; a human session only. */
const ADMIN_WRITES = new Set(["/pair/code", "/sessions/revoke", "/devices/revoke", "/policy/self-pair", "/policy/finance", "/sessions/confirm-code"]);
const SEEN_WINDOW_MS = 2 * 60 * 1000;

export function createDevicesService(options: DevicesServiceOptions) {
  const now = options.now ?? Date.now;
  const store = options.store ?? new DeviceStore(options.root, { now });
  const hub = options.hub ?? defaultHub();
  const registry = new DeviceRegistry(() => [hub, ...store.companions()], now, PRESENCE_TTL_MS);
  const dispatcher = new Dispatcher(registry, now);
  const seen = new Map<PersonId, number>();
  const maxWait = options.maxWaitMs ?? 25_000;
  dispatcher.start();
  if (options.install) setActiveRegistry(registry);
  const idOpts = { root: options.root, store, tailnetName: options.tailnetName, servePeer: options.servePeer, tailnet: options.tailnet };
  const pageToken = () => (typeof options.token === "function" ? options.token() : options.token);

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
    return { id: row.id, personId: row.personId, label: row.label, via: row.via, createdAt: row.createdAt, expiresAt: row.expiresAt, lastSeen: row.lastSeen, revoked: !!row.revokedAt, expired: row.expiresAt <= now(), current: row.id === current, pending: !!row.pending };
  }

  function deviceView(d: TargetDevice) {
    const p = registry.presenceOf(d.id);
    return {
      id: d.id, owner: d.owner, kind: d.kind, label: d.label, aliases: d.aliases, primary: !!d.primary,
      online: registry.isOnline(d), lastSeen: d.kind === "hub" ? now() : p?.lastSeen ?? null,
      micOwned: d.kind === "hub" ? null : p?.micOwned ?? null, busy: p?.busy ?? false,
      pairedAt: d.pairedAt ?? null, expiresAt: d.expiresAt ?? null, revoked: !!d.revokedAt,
    };
  }

  function people(root: string) {
    return knownPeople(root);
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
          // AUDIT-A1-3: a browser at this PC whose hub session a navigation minted and nobody has confirmed
          // yet. REVIEW-S1 F2b: never a code here. Anything this browser can read, the program that forged
          // its navigation can read too; the code comes from a human context and is typed in.
          hubSession: id.local && id.session?.via === "hub" ? { pending: !!id.session.pending } : null,
          // A verified Tailscale login can always ask for a remembered (30-day, revocable) session.
          canSelfPair: !id.session && !!id.tailnet && policy.selfPair[id.tailnet] !== false,
          people: people(options.root),
          permissions: permissionSummary(principal, policy),
        });
      }
      if (method === "POST" && path === "/pair/tailnet") {
        if (!id.tailnet) return send(res, 403, { error: "Open the OS through your Tailscale address to pair." });
        if (id.session) return send(res, 409, { error: "This device is already paired." });
        if (policy.selfPair[id.tailnet] === false) return send(res, 403, { error: "This account needs a pairing code from one of its paired devices." });
        const b = await body(req);
        const { cookie: value, session } = store.mintSession(id.tailnet, String(b.label ?? ""), "tailnet");
        return send(res, 200, { paired: true, session: sessionView(session, session.id) }, [cookie(SESSION_COOKIE, value, id.secure)]);
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
        return send(res, 200, { paired: true, session: sessionView(session, session.id) }, [cookie(SESSION_COOKIE, value, id.secure)]);
      }

      // Everything below needs an authorised device.
      if (!principal) return send(res, 401, { error: "Pair this device first." });

      // REVIEW-S1 F1: device and session administration is for a person acting now (a confirmed browser
      // session or a paired device), never a program. Any local program holds the page token, so without
      // this it could list the owner's sessions and revoke his confirmed one, leaving him pending.
      if (method === "POST" && ADMIN_WRITES.has(path) && id.verified?.actor !== "human")
        return send(res, 403, {
          error: id.local && id.session?.pending
            ? "Confirm this browser first (Profile), then try again."
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
        const d = authorise(principal, { kind: "devices-admin", person: forPerson });
        if (!d.allowed) return send(res, 403, { error: d.reason });
        return send(res, 200, { ...store.createCode(forPerson, purpose, principal.personId), personId: forPerson, purpose });
      }
      if (method === "GET" && path === "/sessions") {
        const all = principal.personId === "usman" && !principal.sharedOnly;
        const rows = store.sessions(all ? undefined : principal.personId);
        return send(res, 200, { sessions: rows.map((r) => sessionView(r, principal.sessionId)) });
      }
      if (method === "POST" && path === "/sessions/confirm-code") {
        // AUDIT-A1-3 / REVIEW-S1 F2b: Usman acting now (a confirmed browser at this PC or his own paired
        // device) makes a one-time code, reads it on his screen and types it into the new browser. The
        // code is only ever in this response to a human session, never on the pending browser.
        const v = id.verified;
        if (!v || v.personId !== "usman" || v.actor !== "human" || principal.sharedOnly)
          return send(res, 403, { error: "Make a confirm code on a browser Usman already uses (Profile), or run the confirm-browser command in a terminal on this PC." });
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
      if (method === "POST" && path === "/sessions/revoke") {
        const b = await body(req);
        const row = store.sessions().find((s) => s.id === String(b.sessionId ?? ""));
        if (!row) return send(res, 404, { error: "No such session." });
        const d = authorise(principal, { kind: "devices-admin", person: row.personId });
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
        return send(res, 200, { devices: registry.all().map(deviceView), people: online, heartbeatMs: HEARTBEAT_INTERVAL_MS, ttlMs: PRESENCE_TTL_MS });
      }
      if (method === "POST" && path === "/devices/revoke") {
        const b = await body(req);
        const device = store.companions().find((c) => c.id === String(b.deviceId ?? ""));
        if (!device) return send(res, 404, { error: "No such paired companion." });
        const d = authorise(principal, { kind: "devices-admin", person: device.owner });
        if (!d.allowed) return send(res, 403, { error: d.reason });
        store.revokeCompanion(device.id);
        dispatcher.deviceOffline(device.id);
        return send(res, 200, { revoked: device.id });
      }
      if (method === "POST" && path === "/policy/self-pair") {
        const b = await body(req);
        const person = normalisePersonId(b.personId);
        if (!person) return send(res, 400, { error: "Unknown person." });
        const d = authorise(principal, { kind: "devices-admin", person });
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
      if (!id.loopbackSocket || (!id.local && !id.tailnet)) return send(res, 403, { error: "Connect through the tailnet to pair." });
      const b = await body(req);
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
      registry.heartbeat(deviceId, { micOwned: b.micOwned === true, busy: b.busy === true, version: String(b.version ?? "").slice(0, 32) });
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

  return { handle, close, registry, dispatcher, store, principalOf, authoriseRequest };
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
