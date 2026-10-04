import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { DeviceStore, SessionRow } from "../devices/store";
import {
  configureIdentity,
  identifyRequest,
  identityStore,
  isAtHub,
  isAtThisPc,
  isBrowserPrincipal,
  markLoopbackUnproven,
  pageTokenFor,
  pairingTokenFor,
  safeEqual,
  SESSION_COOKIE,
  type IdentityContext,
  type Principal,
  type ReqLike,
  type RequestIdentity,
} from "./principal";
import { routeClass, routeRule } from "./routes";
import { peerImage, relayedByTailscaleServe, type ServePeerCheck } from "./serve-peer";
import { tailnetSnapshotWait, type TailnetSource } from "../remote-access";
import { hubRole, type HubRole } from "../cloud/hub-role";
import { createLocalOwnerProof, markLocalOwnerProven, type LocalOwnerProof } from "./local-owner-token";
import { grantServerFounder, isServerFounderGrant, serverRoleDecision } from "./server-role";
import { createGatewayTrust, type GatewayTrust } from "../gateway/hub";

/**
 * The identity gate: the first thing every request meets after the dev-restart coalescer.
 *
 *  - It resolves the principal once (resolvePrincipal's rules) and remembers it for the request, so
 *    downstream routes read the same answer with requestPrincipal(req).
 *  - Cross-origin is refused on every /__* route: an Origin that isn't this request's own origin,
 *    or Sec-Fetch-Site cross-site / same-site (another localhost port is same-site), gets 403. Vite's
 *    own CORS is off (vite.config.ts server.cors: false), so no other origin can read a response.
 *  - Every /__* route is classified (scripts/identity/routes.ts, deny by default): "shared" needs a
 *    verified founder, "local-owner" needs the owner at this PC, "self" routes prove their callers
 *    themselves (/__devices, /__away). No principal → 401; the wrong principal → 403.
 *  - The app itself (every non-/__ path, Vite's source and static serving included) is served only
 *    to a verified founder. A verified Tailscale login with no principal (revoked session, "require a
 *    code") gets a self-contained pairing page and nothing else; anyone else gets 401.
 *  - GET /__token: the per-run internal token to the owner at this PC (unchanged; local scripts read
 *    it too), a person-bound derived token to a remote founder, a pairing-only token to a login that
 *    has to pair. The internal token never leaves this PC and is NEVER substituted for a remote
 *    token: a remote request presenting the raw internal token has it removed, so every legacy
 *    `=== REFRESH_TOKEN` check fails for remote callers. Shared routes check a remote founder's own
 *    token with pageTokenOk().
 */

const TOKEN_HEADER = "x-claude-os-token";

/**
 * Why a request target isn't canonical, or null. The gate classifies the RAW path, so anything a
 * downstream router or handler might normalise differently is refused up front (REVIEW-B1 R2):
 * absolute-form targets ("GET http://host/__x", which connect's parseurl routes by its pathname),
 * "." or ".." segments, "//", backslashes, and encoded dot, slash, backslash, percent or NUL.
 */
export function nonCanonicalTarget(url: string): string | null {
  if (!url.startsWith("/") || url.startsWith("//")) return "Use a plain path.";
  const q = url.search(/[?#]/);
  const path = q < 0 ? url : url.slice(0, q);
  if (path.includes("\\")) return "Backslashes aren't allowed in paths.";
  if (/%(2e|2f|5c|25|00)/i.test(path)) return "Encoded dots, slashes or percents aren't allowed in paths.";
  if (path.includes("//")) return "Empty path segments aren't allowed.";
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return "Dot segments aren't allowed in paths.";
  return null;
}

const identities = new WeakMap<object, RequestIdentity>();

/** Connect's own prefix rule (case-insensitive, then "/", "." or the end), so the gate matches what mounts. */
export function under(path: string, prefix: string) {
  const p = path.toLowerCase();
  const q = prefix.toLowerCase();
  if (!p.startsWith(q)) return false;
  const next = p.charAt(q.length);
  return next === "" || next === "/" || next === ".";
}

function pathOf(req: ReqLike) {
  const url = req.url || "/";
  const q = url.search(/[?#]/);
  return q < 0 ? url : url.slice(0, q);
}

/** The request's identity, resolved once and shared by the gate and every route after it. */
export function requestIdentity(req: ReqLike, ctx?: Partial<IdentityContext>): RequestIdentity {
  const cached = identities.get(req);
  if (cached) return cached;
  const id = identifyRequest(req, ctx);
  identities.set(req, id);
  return id;
}

/** The verified principal for this request, or null (the route answers 401). */
export function requestPrincipal(req: ReqLike, ctx?: Partial<IdentityContext>): Principal | null {
  return requestIdentity(req, ctx).principal;
}

/** Does this presented page token belong to this principal? Pure; constant-time. */
export function pageTokenMatches(principal: Principal | null, presented: unknown, internalToken: string): boolean {
  if (!principal || !isBrowserPrincipal(principal) || typeof presented !== "string" || !presented || !internalToken) return false;
  return safeEqual(presented, pageTokenFor(principal, internalToken));
}

/** The CSRF check for a shared route's write: the caller's OWN page token (internal only at this PC). */
export function pageTokenOk(req: ReqLike, internalToken: string, ctx?: Partial<IdentityContext>): boolean {
  return pageTokenMatches(requestPrincipal(req, ctx), req.headers?.[TOKEN_HEADER], internalToken);
}

export type GateOptions = {
  root: string;
  /** The per-run internal page token (vite.config.ts REFRESH_TOKEN). */
  internalToken: () => string;
  store?: DeviceStore;
  tailnetName?: string;
  /** Tests simulating Tailscale Serve over a plain loopback socket (see IdentityContext.servePeer). */
  servePeer?: ServePeerCheck;
  /** Tests: a synthetic tailnet snapshot (see IdentityContext.tailnet). */
  tailnet?: TailnetSource;
  /**
   * Which program made a page navigation at this PC (REVIEW-S1 N1: pending hub sessions are capped per
   * source). Defaults to the image of the socket's peer process (serve-peer peerImage). Tests pass their own.
   */
  navigationSource?: (req: IncomingMessage) => string | null;
  /**
   * The hub role (default: MU_HUB_ROLE). Only "server" changes a decision: a founder with a confirmed human
   * session, arriving through Serve, may use local-owner routes except the console-only set
   * (scripts/identity/server-role.ts). In "pc" and "cloud" the gate is exactly what it always was.
   */
  role?: HubRole;
  /**
   * Server role only: the local-owner proof checker (default: the token file under the data directory, created
   * at startup). A loopback request without it is nobody (scripts/identity/local-owner-token.ts). Tests inject one.
   */
  localOwnerProof?: LocalOwnerProof;
  /**
   * The Dot gateway's hub-side trust (scripts/gateway/hub.ts). Default: on only when MU_GATEWAY_TRUST=1. A request with no
   * gateway assertion is untouched by it; one with an assertion is the gateway principal or is refused, never anything else.
   */
  gateway?: GatewayTrust;
};

/** A short tag for a navigation's source program: its file name and a hash of its full path. */
export function sourceTag(image: string | null): string | null {
  if (!image) return null;
  const name = image.slice(Math.max(image.lastIndexOf("\\"), image.lastIndexOf("/")) + 1).toLowerCase().slice(0, 48);
  return `${name}#${createHash("sha256").update(image.toLowerCase()).digest("hex").slice(0, 8)}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

const SIGN_IN = "Sign in first: use Agentic OS at this PC, or open it through your own Tailscale address.";
const HUB_ONLY = "That runs on Usman's PC, so only he can use it, at the PC. Your own device's version arrives with the companion.";
const SERVER_CONSOLE_ONLY = "That changes the server's own keys, configuration or software, so it can only be done at the server itself.";
export const CONFIRM_FIRST = "Confirm this browser first (System › Devices and people), then try again. Until then it can't see conversations, jobs or business records.";
/** The only shared routes a bare tailnet login may use: data-free status the confirm/pair screen needs. */
const TAILNET_LOGIN_MAY: readonly string[] = ["/__version", "/__health"];
const SERVER_NEEDS_SESSION ="That runs on the server and needs a confirmed browser session: pair this browser first (System › Devices and people), then try again.";

/** Refused when it comes from another origin (another localhost port included). */
export function crossOrigin(req: ReqLike, secure: boolean): string | null {
  const site = String(req.headers?.["sec-fetch-site"] ?? "");
  if (site === "cross-site" || site === "same-site") return "Cross-site request blocked";
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    const own = `${secure ? "https" : "http"}://${String(req.headers?.host ?? "")}`;
    if (String(origin).toLowerCase() !== own.toLowerCase()) return "Unknown origin";
  }
  return null;
}

export function createPrincipalGate(options: GateOptions) {
  const ctx: Partial<IdentityContext> = { root: options.root, store: options.store, tailnetName: options.tailnetName, servePeer: options.servePeer, tailnet: options.tailnet };
  const role: HubRole = options.role ?? hubRole();
  // Created at startup in the server role only; pc and cloud never touch the file.
  const proof: LocalOwnerProof | null = role === "server" ? (options.localOwnerProof ?? createLocalOwnerProof(options.root)) : null;
  const gateway: GatewayTrust = options.gateway ?? createGatewayTrust({ root: options.root, internalToken: options.internalToken });

  function serveToken(req: IncomingMessage, res: ServerResponse, id: RequestIdentity) {
    if ((req.method || "GET") !== "GET") return sendJson(res, 405, { error: "GET only" });
    const internal = options.internalToken();
    if (id.principal && isBrowserPrincipal(id.principal)) return sendJson(res, 200, { token: pageTokenFor(id.principal, internal) });
    if (!id.principal && id.tailnet) return sendJson(res, 200, { token: pairingTokenFor(id.tailnet, internal), scope: "pairing" });
    return sendJson(res, 401, { error: SIGN_IN });
  }

  /**
   * The owner's browser at this PC gets its own session on a page navigation: an HttpOnly,
   * SameSite=Strict cookie (http on loopback, so no Secure) that page script can't read and no
   * response ever echoes. That is what makes it a HUMAN session; Hermes, cron scripts and agent jobs
   * call /__* without it and resolve as PROCESS callers (Principal.actor). Only navigations mint,
   * the store keeps at most MAX_HUB_SESSIONS live hub sessions, and the id is never in any JSON.
   *
   * AUDIT-A1-3: the two navigation headers are something any local program can send, so what a
   * navigation mints is PENDING (a process caller) once this PC has trusted a hub session: it becomes
   * human only when a confirmed session confirms the code it shows (System › Devices and people), or the owner runs the
   * local confirm-browser command. Pending mints are capped apart and never evict a confirmed session.
   * A confirmed session navigating near its end is renewed, so a browser in use never lapses.
   */
  function mintHubSession(req: IncomingMessage, res: ServerResponse, renew?: SessionRow | null) {
    if ((req.method || "GET") !== "GET") return;
    if (req.headers["sec-fetch-dest"] !== "document" || req.headers["sec-fetch-mode"] !== "navigate") return;
    try {
      const store = identityStore(ctx);
      const minted = renew ? store.renewHubSession(renew) : store.mintHubSession("This PC's browser", (options.navigationSource ?? ((r) => sourceTag(peerImage(r))))(req));
      if (!minted) return;
      const { cookie } = minted;
      const prior = res.getHeader("Set-Cookie");
      const mine = `${SESSION_COOKIE}=${encodeURIComponent(cookie)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; SameSite=Strict`;
      res.setHeader("Set-Cookie", [...(Array.isArray(prior) ? prior : prior ? [String(prior)] : []), mine]);
    } catch {
      /* the page still loads; the owner just isn't an interactive session until the next page load */
    }
  }

  /**
   * REVIEW-S1 R2-1: a Serve-relayed request (its socket's peer really is tailscaled) is only believed once
   * its tailnet source resolves to a node in a fresh `tailscale status` snapshot. When the live snapshot is
   * stale or doesn't know the source, wait for one refresh (bounded) first; the decision itself stays
   * synchronous and fails closed. An injected snapshot (tests) is used as it is.
   */
  function snapshotWait(req: IncomingMessage): Promise<void> | null {
    if (options.tailnet) return null;
    if (!String(req.headers["tailscale-user-login"] ?? "").trim() || !/\.ts\.net(:\d+)?$/i.test(String(req.headers.host ?? ""))) return null;
    try {
      if (!(options.servePeer ?? relayedByTailscaleServe)(req)) return null;
    } catch {
      return null;
    }
    return tailnetSnapshotWait(req);
  }

  return function principalGate(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
    // The Dot gateway (scripts/gateway): a request carrying its assertion is verified and held to the capability table here,
    // before anything else resolves an identity. Refused outright when it does not verify; null (no assertion) changes nothing.
    const viaGateway = gateway.screen(req);
    if (viaGateway && !viaGateway.ok) return sendJson(res, viaGateway.status, { error: viaGateway.error });
    // Server role: on a headless hub any local process (and every WSL user, over mirrored networking) reaches
    // loopback. A loopback request is the owner only with the local-owner proof; otherwise it is marked, before
    // anything resolves an identity, and every later resolution of it (here or in a handler) is anonymous.
    // The proof headers are always stripped, so no handler or bridge ever sees the secret.
    if (proof) {
      const atPc = isAtThisPc(req);
      const carried = proof.check(req);
      if (atPc) (carried ? markLocalOwnerProven : markLoopbackUnproven)(req);
    }
    const odd = nonCanonicalTarget(req.url || "");
    if (odd) return sendJson(res, 400, { error: odd });
    const wait = snapshotWait(req);
    if (wait) {
      // REVIEW-S1 N4: a throw inside the deferred gate reaches the error handler (as the synchronous path
      // does); otherwise it would be an unhandled rejection and the request would never get an answer.
      wait
        .then(
          () => gate(req, res, next),
          () => gate(req, res, next),
        )
        .catch((error: unknown) => next(error ?? new Error("identity gate failed")));
      return;
    }
    return gate(req, res, next);
  };

  function gate(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
    const path = pathOf(req);
    const method = req.method || "GET";
    const id = requestIdentity(req, ctx);

    if (!path.startsWith("/__")) {
      // The app shell and everything Vite serves: verified founders only.
      // A bare tailnet login (unpaired, pending or revoked browser) never gets the app's files: Vite would serve the project root
      // (source, evidence screenshots, src/data/live-data.json). It gets the self-contained pairing page instead (acceptance #18).
      if (id.principal && isBrowserPrincipal(id.principal) && id.principal.via !== "tailnet-person") {
        if (id.principal.via === "loopback-owner") {
          if (id.sessionCookie !== "valid") mintHubSession(req, res);
          else if (id.session && id.session.via === "hub" && !id.session.pending) mintHubSession(req, res, id.session);
        }
        return next();
      }
      // A verified login that has to pair gets the pairing page, never the app's files or data.
      if (id.tailnet) {
        if (method !== "GET" && method !== "HEAD") return sendJson(res, 401, { error: SIGN_IN });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
        return void res.end(method === "HEAD" ? undefined : PAIRING_PAGE);
      }
      return sendJson(res, 401, { error: SIGN_IN });
    }

    // Server role liveness for the Windows supervisor: an unproven loopback GET /__version answers a data-free ok
    // (no build info, no identity), so the probe needs no secret. Everything else on loopback needs the proof.
    if (proof && id.local && !id.principal && (method === "GET" || method === "HEAD") && path === "/__version") return sendJson(res, 200, { ok: true });
    const refused = crossOrigin(req, id.secure);
    if (refused) return sendJson(res, 403, { error: refused });
    // The internal token is only ever presented by the owner at this PC.
    if (req.headers[TOKEN_HEADER] !== undefined && id.principal?.via !== "loopback-owner") {
      const presented = req.headers[TOKEN_HEADER];
      if (typeof presented === "string" && safeEqual(presented, options.internalToken())) delete req.headers[TOKEN_HEADER];
    }
    if (under(path, "/__token")) return serveToken(req, res, id);

    const cls = routeClass(path, method);
    if (cls === "self") return next();
    if (!id.principal) return sendJson(res, 401, { error: SIGN_IN, signIn: "/__devices/me" });
    if (!isBrowserPrincipal(id.principal)) return sendJson(res, 403, { error: "Companions talk to /__devices/companion only." });
    // A bare tailnet login (an unpaired, unconfirmed or revoked browser) reads and writes no shared business data: conversations, jobs,
    // coding jobs, agents, memory, CRM and accounts need a confirmed person (master brief acceptance #18; production 4 Oct: an unpaired
    // browser could list the Jarvis conversation, its thread and the job history). Pairing itself uses the "self" routes above.
    if (cls === "shared" && id.principal.via === "tailnet-person" && path.startsWith("/__") && !TAILNET_LOGIN_MAY.some((p) => under(path, p)))
      return sendJson(res, 403, { error: CONFIRM_FIRST, confirm: "/__devices/me", route: routeRule(path).key ?? "unclassified" });
    if (cls === "local-owner" && id.principal.via !== "loopback-owner") {
      const route = routeRule(path).key ?? "unclassified";
      if (role !== "server") return sendJson(res, 403, { error: HUB_ONLY, route });
      // Server role: a founder's confirmed human session, through the trusted Serve path, may use the hub's
      // shared server-side capabilities, except the console-only set. serverRoleDecision only reads the
      // identity derived above; it never re-derives or loosens it.
      const decision = serverRoleDecision(path, id, method);
      if (!decision.ok)
        return sendJson(res, 403, { error: decision.reason === "console-only" ? SERVER_CONSOLE_ONLY : SERVER_NEEDS_SESSION, route, reason: decision.reason });
      // The route's own checks (requestAtHub, refuseUnlessAtThisPc, the legacy `=== REFRESH_TOKEN` write check)
      // were written for the owner at this PC: record the gate's decision, and when the founder presented his OWN
      // page token, hand the handlers the internal one they compare against. Any other value is left as sent.
      grantServerFounder(req);
      const presented = req.headers[TOKEN_HEADER];
      if (pageTokenMatches(id.principal, presented, options.internalToken())) req.headers[TOKEN_HEADER] = options.internalToken();
    }
    return next();
  }
}

/** The Vite plugin: installs the identity context and the gate ahead of every other route. */
export function identityGatePlugin(options: GateOptions): Plugin {
  return {
    name: "agentic-os-identity-gate",
    configureServer(server) {
      configureIdentity({ root: options.root, store: options.store, tailnetName: options.tailnetName, servePeer: options.servePeer, tailnet: options.tailnet });
      server.middlewares.use(createPrincipalGate(options));
    },
  };
}

/**
 * For routes that act with this PC's own tools and stay "at this PC only" (site drafts, lead-site
 * deploys, local files): the verified principal must be the owner at this PC. 401 with no principal,
 * 403 for someone signed in remotely. Relay headers with Host: localhost are nobody (849f205, M4).
 */
export function refuseUnlessAtThisPc(req: ReqLike, message: string, ctx?: Partial<IdentityContext>): { status: 401 | 403; error: string } | null {
  const principal = requestPrincipal(req, ctx);
  if (!principal || !isBrowserPrincipal(principal)) return { status: 401, error: SIGN_IN };
  // Server role: the gate already admitted this founder to this local-owner route (server-role.ts).
  return principal.via === "loopback-owner" || isServerFounderGrant(req) ? null : { status: 403, error: message };
}

/**
 * AUDIT-A1-2: the request is AT THE HUB in person: the owner at this PC (loopback socket, a local Host,
 * no relay header: the loopback-owner principal). Never a founder signed in over Tailscale, a companion
 * or a Telegram relay. This is what every inline hub-route guard means; the B1 route table stays the
 * outer layer. (No page token or session is asked for here: any loopback caller can read /__token, so
 * neither proves locality; the hub's writes check the token themselves for CSRF.)
 */
export function requestAtHub(req: ReqLike, ctx?: Partial<IdentityContext>): boolean {
  // MU_HUB_ROLE=server: a founder the gate admitted to a local-owner route (never a console-only one) counts
  // as "at the hub" for that request only. Nothing sets the grant but the gate; it is false in every other role.
  return isAtHub(requestPrincipal(req, ctx)) || isServerFounderGrant(req);
}

/**
 * For a READ_SHARED route (scripts/identity/routes.ts): any verified founder may read (GET/HEAD), as the
 * B1 table says; anything else needs the owner at the hub.
 */
export function founderMayRead(req: ReqLike, ctx?: Partial<IdentityContext>): boolean {
  const method = req.method || "GET";
  return method === "GET" || method === "HEAD" ? isBrowserPrincipal(requestPrincipal(req, ctx)) : requestAtHub(req, ctx);
}

/**
 * Served instead of the app to a verified Tailscale login with no principal. Self-contained (no app
 * files), talks only to /__token, /__devices/me and /__devices/pair/*, then reloads.
 */
export const PAIRING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair this device · Agentic OS</title>
<style>
:root{color-scheme:light dark;--bg:#0b0b0c;--fg:#f3f1ea;--muted:#a8a49a;--line:#2a2a2d;--accent:#c9a54a}
@media (prefers-color-scheme:light){:root{--bg:#f7f5ef;--fg:#141414;--muted:#5d5a52;--line:#d8d4c9;--accent:#8a6d1f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:0 auto;padding:3rem 1rem}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:var(--muted)}
label{display:grid;gap:.25rem;margin-top:1rem;font-size:.9rem}
input{min-height:2.75rem;padding:0 .75rem;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:inherit;font:inherit}
button{margin-top:1rem;min-height:2.75rem;padding:0 1rem;border:0;border-radius:.5rem;background:var(--accent);color:#0b0b0c;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}[role=alert]{color:#e0735b}
</style></head>
<body><main>
<h1>Pair this device</h1>
<p id="who">Checking who you are…</p>
<label>Name this device<input id="label" maxlength="48" placeholder="e.g. Study PC"></label>
<div id="self" hidden><button id="pair">Pair with my Tailscale login</button></div>
<form id="codeForm"><label><span id="codeLabel">Or a one-time code from one of your paired devices</span><input id="code" autocomplete="one-time-code" maxlength="12" placeholder="ABCD-EFGH"></label><button type="submit">Use code</button></form>
<p id="msg" role="alert" aria-live="polite"></p>
</main>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (t) => ($("msg").textContent = t);
  let token = "";
  try { token = (await (await fetch("/__token")).json()).token || ""; } catch {}
  try {
    const me = await (await fetch("/__devices/me")).json();
    $("who").textContent = me.person ? "Tailscale says this is " + me.person.name + ". Pair once and this device stays signed in for 30 days." : "Open Agentic OS through your own Tailscale address.";
    $("self").hidden = !me.canSelfPair;
    const waiting = me.waitingSession;
    if (waiting && waiting.pending) {
      $("self").hidden = true;
      $("who").textContent = "This device is paired and waiting to be confirmed" + (waiting.matchCode ? ". Match code: " + waiting.matchCode : "") + ". Confirm it in System › Devices and people on a browser you already use, or enter a one-time code below.";
    }
    if (me.hubRole === "server") $("codeLabel").textContent = "A one-time code made on the hub PC (run: bun scripts/identity/pair-code.ts --for " + (typeof me.person === "string" ? me.person : (me.person && me.person.id) || "usman") + " --port 8081), or in System › Devices and people on a browser you already use";
  } catch { $("who").textContent = "Couldn't reach Agentic OS."; }
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Pairing failed.");
    location.reload();
  }
  $("pair").onclick = () => post("/__devices/pair/tailnet", { label: $("label").value }).catch((e) => say(e.message));
  $("codeForm").onsubmit = (e) => { e.preventDefault(); if ($("code").value.trim()) post("/__devices/pair/redeem", { code: $("code").value, label: $("label").value }).catch((err) => say(err.message)); };
})();
</script></body></html>`;
