/**
 * The Dot gateway process (DOT-GATEWAY-DESIGN.md). Loopback only; the internet edge (Tailscale Funnel, when the owner turns
 * it on) points at this port and nothing else.
 *
 *   browser ──TLS──> edge ──> 127.0.0.1:<gateway> ──signed assertion──> 127.0.0.1:<hub>
 *
 * It is not a general proxy. There is ONE upstream, fixed at start-up and required to be loopback; no part of a request
 * chooses where it goes. Requests are rebuilt, not relayed: only an allow-list of request headers travels on, so no cookie,
 * Authorization, Tailscale-*, X-Forwarded-*, Forwarded, Via or identity header from the internet ever reaches the hub.
 * Every decision is default deny (policy.ts), and the hub checks the same table again for the principal the assertion names.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { signAssertion } from "./assertion";
import { AuditLog, parseRecordIds, type AuditEntry } from "./audit";
import { ACCESS_TOKEN_PREFIX, ASSERTION_HEADER, CSRF_HEADER, ENROL_HEADER, GATEWAY_DISPLAY_NAME, GATEWAY_PERSON, LIMITS, RECORD_IDS_HEADER, SESSION_COOKIE_NAME, VIA_VALUE } from "./config";
import { enrolPage, pageCsp, testUpdatePage } from "./pages";
import { hasDevQuery, isPagePath, METHODS, nonCanonical, permitted, type Capability } from "./policy";
import { RateLimiter } from "./ratelimit";
import { ensureGatewaySecret, gatewaySecretReader } from "./secret";
import { ControlFile, effectiveCapabilities, expiryView, identityExpiry, isKilled, SessionFile, type AccessMode, type SessionRow } from "./store";
import { loadUi, matchesPage, type UiBundle } from "./ui";

/** A request path as a template for the audit: plain words kept, anything id-like replaced by "*", at most 8 segments. */
export function pathTemplate(path: string): string {
  const segments = path.split("/").slice(1, 9).map((s) => {
    let seg = s;
    try {
      seg = decodeURIComponent(s);
    } catch {
      return "*";
    }
    if (!seg) return "";
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^\d+$/.test(seg) || /@/.test(seg) || /\d/.test(seg) && seg.length >= 8 || seg.length > 40 || !/^[A-Za-z0-9_.-]+$/.test(seg)) return "*";
    return seg;
  });
  return `/${segments.join("/")}`.slice(0, 120);
}

export type GatewayConfig = {
  /** MU_DATA_DIR/gateway. */
  dir: string;
  port: number;
  /** The hub: http://127.0.0.1:<port>. Loopback only, no path. */
  upstream: string;
  /** The ONE origin browsers use, e.g. https://ryzen-pc.tailnet-name.ts.net. Host and Origin must match it exactly. */
  publicOrigin: string;
  /**
   * The edge in front (Funnel, a tunnel) reaches us on loopback, so the socket's address is always 127.0.0.1. When true, the
   * LAST X-Forwarded-For entry is used as the client address, for rate limiting and the audit only. Never for identity.
   */
  forwardedFor?: boolean;
  recheckMs?: number;
  /**
   * The built UI (scripts/gateway/build-ui.ts: dist/client with gateway-ui-manifest.json). The gateway serves it itself and
   * never forwards a non-/__ path to the hub. Without it the gateway serves the API only (every page and file is 404).
   */
  uiDir?: string;
  /** Lines the process prints (start, stop, stream closures). Value-free by construction. */
  log?: (line: string) => void;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Request headers that travel on to the hub. Everything else is dropped. */
const FORWARD_REQUEST = ["accept", "accept-language", "content-type", "last-event-id", "cache-control", "pragma", "if-none-match", "if-modified-since", "range", "user-agent", "sec-fetch-dest", "sec-fetch-mode"];
/** Response headers that never reach the browser (the gateway sets its own cookie, security and framing headers). */
const DROP_RESPONSE = /^(?:set-cookie|content-encoding|content-length|transfer-encoding|connection|keep-alive|server|x-powered-by|via|date|location|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|cross-origin-.*|access-control-.*|x-mu-.*|proxy-.*|alt-svc)$/i;

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Robots-Tag": "noindex, nofollow",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const FALLBACK_CSP = "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'";

type SocketData = { session: string; capability: Capability; ip: string; route: string; upstream: WebSocket; pending: Array<string | ArrayBuffer>; openedAt: number };
type OpenStream = { session: string; capability: Capability; close: (reason: string) => void };

export function validateConfig(config: GatewayConfig) {
  const up = new URL(config.upstream);
  if (up.protocol !== "http:" || !LOOPBACK_HOSTS.has(up.hostname) || (up.pathname !== "/" && up.pathname !== "") || up.search || up.username || up.password)
    throw new Error("The gateway's upstream must be the hub on loopback, e.g. http://127.0.0.1:8081 (no path, no credentials).");
  const pub = new URL(config.publicOrigin);
  if (pub.origin !== config.publicOrigin.replace(/\/$/, "") || (pub.protocol !== "https:" && !LOOPBACK_HOSTS.has(pub.hostname)))
    throw new Error("The gateway's public origin must be a bare https origin (http is accepted only for a loopback test origin).");
  return { upstreamOrigin: up.origin, publicOrigin: pub.origin, publicHost: pub.host };
}

export function startGateway(config: GatewayConfig) {
  const { upstreamOrigin, publicOrigin, publicHost } = validateConfig(config);
  const log = config.log ?? ((line: string) => console.log(`[gateway] ${line}`));
  ensureGatewaySecret(config.dir);
  const secret = gatewaySecretReader(config.dir);
  const control = new ControlFile(config.dir);
  const sessions = new SessionFile(config.dir);
  const audit = new AuditLog(config.dir);
  const limiter = new RateLimiter();
  const enrolFailures = new RateLimiter();
  const ui: UiBundle | null = config.uiDir ? loadUi(config.uiDir) : null;
  /** Failed sign-ins since start (in memory) for the global alert; the per-code count lives in sessions.json. */
  let alertedAt = 0;
  const streams = new Set<OpenStream>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let killedLogged = false;

  // ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────

  const withSecurity = (headers: Headers) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return headers;
  };
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: withSecurity(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra })) });
  const page = (status: number, render: (nonce: string) => string, extra: Record<string, string> = {}) => {
    const nonce = randomBytes(16).toString("base64");
    const headers = withSecurity(new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": pageCsp(nonce), ...extra }));
    headers.set("X-Frame-Options", "DENY");
    return new Response(render(nonce), { status, headers });
  };
  const cookie = (value: string) => `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  const clearCookie = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

  /**
   * The access token(s) this request presents, and how. `Authorization: Bearer mugw_at_...` is Dot's own programs (no
   * browser sends it by itself, so such a request needs no CSRF token); otherwise the browser's cookie.
   */
  function presented(req: Request): { tokens: string[]; mode: AccessMode } {
    const auth = req.headers.get("authorization") ?? "";
    // Only a bearer carrying the gateway's own prefix is an access token; any other Authorization header is ignored (and never forwarded).
    const value = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : "";
    if (value.startsWith(ACCESS_TOKEN_PREFIX)) return { tokens: [value.slice(ACCESS_TOKEN_PREFIX.length)], mode: "bearer" };
    return { tokens: presentedTokens(req), mode: "cookie" };
  }

  function presentedTokens(req: Request): string[] {
    const out: string[] = [];
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
        const v = part.slice(eq + 1).trim();
        if (v && !out.includes(v)) out.push(v);
      }
      if (out.length >= 4) break;
    }
    return out;
  }

  /** A client address worth keying a lockout on: not the loopback that every edge-relayed request shares. */
  const addressKnown = (ip: string) => !/^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1|unknown)$/.test(ip);

  function clientIp(req: Request, server: Server<SocketData>): string {
    const peer = server.requestIP(req)?.address ?? "unknown";
    if (!config.forwardedFor || !/^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(peer)) return peer;
    const last = (req.headers.get("x-forwarded-for") ?? "").split(",").pop()?.trim() ?? "";
    return /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last : peer;
  }

  /** The CSRF token for a session: bound to the session AND its current cookie value, so a rotation changes it. */
  function csrfFor(session: SessionRow, tokenHash = session.tokenHash): string | null {
    const key = secret();
    return key ? createHmac("sha256", key).update(`mu-gateway-csrf|${session.id}|${tokenHash}`).digest("base64url") : null;
  }
  function csrfOk(session: SessionRow, presented: string | null): boolean {
    if (!presented) return false;
    const candidates = [csrfFor(session), session.prevTokenHash && (session.prevValidUntil ?? 0) > Date.now() ? csrfFor(session, session.prevTokenHash) : null];
    const got = Buffer.from(presented);
    return candidates.some((c) => {
      if (!c) return false;
      const want = Buffer.from(c);
      return want.length === got.length && timingSafeEqual(want, got);
    });
  }

  function closeSession(sessionId: string, reason: string) {
    for (const s of [...streams]) if (s.session === sessionId) s.close(reason);
    for (const ws of [...sockets])
      if (ws.data.session === sessionId) {
        try {
          ws.close(1008, reason);
        } catch {
          /* gone */
        }
      }
  }

  /** Open streams and sockets: still signed in, still holding the capability, gateway still on? Otherwise closed now. */
  function recheck() {
    const now = Date.now();
    const killed = isKilled(config.dir);
    if (killed && !killedLogged) {
      killedLogged = true;
      log("kill switch is ON: refusing everything");
      audit.write({ event: "kill-switch", person: null, session: null, ip: "-", outcome: "denied", reason: "kill-switch-on" });
    } else if (!killed) killedLogged = false;
    const c = control.read();
    const caps = effectiveCapabilities(c, now).caps;
    for (const s of [...streams]) {
      if (killed) s.close("kill-switch");
      else if (!sessions.alive(s.session, c, now)) s.close("session-ended");
      else if (!caps.includes(s.capability)) s.close("capability-revoked");
    }
    for (const ws of [...sockets]) {
      const why = killed ? "kill-switch" : !sessions.alive(ws.data.session, c, now) ? "session-ended" : !caps.includes(ws.data.capability) ? "capability-revoked" : null;
      if (why) {
        try {
          ws.close(1008, why);
        } catch {
          /* gone */
        }
      }
    }
    sessions.flushIfStale(now);
    if (now % 60_000 < (config.recheckMs ?? LIMITS.recheckMs)) {
      limiter.prune(now);
      enrolFailures.prune(now);
    }
  }
  const recheckTimer = setInterval(recheck, config.recheckMs ?? LIMITS.recheckMs);

  // ── the request ────────────────────────────────────────────────────────────────────────────────────────────────

  async function handle(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const started = Date.now();
    const ip = clientIp(req, server);
    const method = req.method.toUpperCase();
    const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return json(400, { error: "Bad request." });
    }
    const path = url.pathname;
    const base: Omit<AuditEntry, "at" | "outcome"> = { event: "request", person: null, session: null, ip, method: (METHODS as readonly string[]).includes(method) ? method : "OTHER" };
    const deny = (status: number, reason: string, error: string, more: Partial<AuditEntry> = {}, headers: Record<string, string> = {}) => {
      audit.write({ ...base, ...more, status, outcome: "denied", reason, ms: Date.now() - started });
      return json(status, { error }, headers);
    };

    // 0. The kill switch beats everything, the sign-in page included.
    if (isKilled(config.dir)) {
      if (path === "/gw/health") return json(503, { ok: false, disabled: true });
      return deny(503, "kill-switch", "The gateway is switched off.");
    }

    // 1. One host, one origin. An absolute-form target or a foreign Host never picks a destination: there is only one upstream.
    if ((req.headers.get("host") ?? "").toLowerCase() !== publicHost || url.host.toLowerCase() !== publicHost) return deny(421, "host", "Unknown host.");
    if (url.username || url.password) return deny(400, "target", "Use a plain path.");
    const odd = nonCanonical(path + url.search);
    if (odd) return deny(400, "target", odd);
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== publicOrigin) return deny(403, "origin", "Unknown origin.");
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && !(site === "none" && (method === "GET" || method === "HEAD") && !upgrade)) return deny(403, "cross-site", "Cross-site request blocked.");
    if (!(METHODS as readonly string[]).includes(method)) return deny(405, "method", "Method not allowed.");

    // 2. Per-address limit (before any hashing or disk work).
    const ipWait = limiter.hit(`ip|${ip}`, LIMITS.perIpPerMinute, 60_000, started);
    if (ipWait) return deny(429, "rate-ip", "Too many requests. Slow down.", {}, { "Retry-After": String(ipWait) });

    // 3. The gateway's own, sign-in side.
    if (path === "/gw/health") return method === "GET" || method === "HEAD" ? json(200, { ok: true }) : deny(405, "method", "GET only.", { route: "/gw/health" });
    if (path === "/gw/enrol") {
      if (method === "GET" || method === "HEAD") return page(200, enrolPage);
      if (method === "POST") return enrol(req, ip, started, origin);
      return deny(405, "method", "Method not allowed.", { route: "/gw/enrol" });
    }
    if (path === "/gw/renew") return method === "POST" ? renew(req, ip, started, origin) : deny(405, "method", "POST only.", { route: "/gw/renew" });

    // 4. Who is this? The access token (the browser's cookie, or a bearer from Dot's own program), nothing else.
    const c = control.read();
    let session: SessionRow | null = null;
    let viaPrevious = false;
    let why = "none";
    const { tokens, mode } = presented(req);
    for (const token of tokens) {
      const check = sessions.verify(token, c, started, mode);
      if (check.ok) {
        session = check.session;
        viaPrevious = check.viaPrevious;
        break;
      }
      why = check.reason;
    }
    if (!session) {
      const headers: Record<string, string> = why === "none" || mode === "bearer" ? {} : { "Set-Cookie": clearCookie };
      audit.write({ ...base, status: 401, outcome: "denied", reason: `session-${why}`, ms: Date.now() - started });
      const navigation = !upgrade && method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
      if (navigation) return page(401, enrolPage, headers);
      // `renew` tells Dot's program what to do next: its reconnect key gets new access; a revoked identity needs a founder.
      return json(401, { error: why === "revoked" ? "This access was revoked by a founder." : "Sign in first.", reason: why, signIn: "/gw/enrol", renew: "/gw/renew" }, headers);
    }
    base.person = GATEWAY_PERSON;
    base.session = session.id;
    if (session.identityId) base.identity = session.identityId;

    const write = method !== "GET" && method !== "HEAD";
    const sWait = limiter.hit(`s|${session.id}`, LIMITS.perSessionPerMinute, 60_000, started) || (write ? limiter.hit(`w|${session.id}`, LIMITS.perSessionWritesPerMinute, 60_000, started) : 0);
    if (sWait) return deny(429, "rate-session", "Too many requests. Slow down.", {}, { "Retry-After": String(sWait) });

    // 5. Capabilities in force now. A change of privilege rotates the cookie (the old value lives only for requests in flight).
    const { caps, grantedBy } = effectiveCapabilities(c, started);
    const setCookies: string[] = [];
    if (!viaPrevious && caps.join(",") !== [...session.caps].sort().join(",")) {
      if (mode === "bearer") sessions.retag(session, caps);
      else setCookies.push(cookie(sessions.rotate(session, caps, started)));
      audit.write({ ...base, event: "session-rotated", outcome: "allowed", reason: "privilege-change" });
    }
    const finish = (res: Response) => {
      for (const sc of setCookies) res.headers.append("Set-Cookie", sc);
      return res;
    };

    // 6. Writes: the page's own origin and the session's CSRF token, on every non-GET, before anything else is considered.
    //    A bearer request is not ambient (no browser attaches it), so there is nothing to forge: the token itself is the proof.
    //    Any Origin it does carry was already required to be the gateway's own (step 1).
    if (write && mode === "cookie") {
      if (origin !== publicOrigin) return finish(deny(403, "origin-required", "This request must come from the gateway's own pages."));
      if (!csrfOk(session, req.headers.get(CSRF_HEADER))) return finish(deny(403, "csrf", "Refresh this page and try again."));
    }

    // 7. The gateway's own, signed-in side.
    if (path === "/__token") {
      if (method !== "GET") return finish(deny(405, "method", "GET only.", { route: "/__token" }));
      const token = csrfFor(session);
      return finish(token ? json(200, { token }) : deny(503, "no-key", "The gateway is not ready.", { route: "/__token" }));
    }
    if (path === "/gw/me" && (method === "GET" || method === "HEAD")) {
      const now = Date.now();
      return finish(
        json(200, {
          person: GATEWAY_PERSON,
          displayName: GATEWAY_DISPLAY_NAME,
          session: { id: session.id, mode, createdAt: session.createdAt, expiresAt: session.expiresAt, idleMinutes: Math.round(session.idleMs / 60_000) },
          identity: identityView(session),
          renew: { path: "/gw/renew", how: "POST { reconnectKey, mode } with X-MU-Gateway-Enrol: 1 for new access in a new task or after this access expires." },
          // When the identity and each grant end, and renewSoon when either ends within 7 days: ask the owner in good time.
          expiry: expiryView(c, sessions.identity(session.identityId), now),
          capabilities: caps.map((name) => ({ name, grantedBy: grantedBy[name] ?? null, expiresAt: c.grants.find((g) => g.capability === name && g.expiresAt > now)?.expiresAt ?? null })),
        }),
      );
    }
    if (path === "/gw/logout" && method === "POST") {
      sessions.end(session, "logout");
      closeSession(session.id, "logout");
      audit.write({ ...base, event: "logout", route: "/gw/logout", status: 200, outcome: "allowed" });
      return json(200, { ok: true }, mode === "bearer" ? {} : { "Set-Cookie": clearCookie });
    }
    if (path === "/gw/test-update" && (method === "GET" || method === "HEAD")) return finish(page(200, testUpdatePage));
    if (path === "/gw" || path.startsWith("/gw/")) return finish(deny(404, "not-listed", "Not found.", { route: "unlisted" }));

    // 8. The UI: served by the gateway itself from the built bundle, never forwarded. Exact manifest paths, the SPA shell
    //    for a page path, and 404 for everything else (dev-server paths, source, maps, checkout files, transform queries).
    if (!path.startsWith("/__")) {
      const notFound = (reason: string) => finish(deny(404, reason, "Not found.", { route: "unlisted" }));
      if (upgrade || (method !== "GET" && method !== "HEAD")) return notFound("not-listed");
      if (!ui) return notFound("no-ui");
      if (hasDevQuery(url.search)) return notFound("dev-query");
      // The shell only for one of the app's own routes (the manifest's page list), never for an arbitrary path.
      const file = ui.files.get(path) ?? (isPagePath(path) && matchesPage(path, ui.pages) ? ui.files.get(ui.shell) : undefined);
      if (!file) return notFound("not-listed");
      const headers = withSecurity(new Headers({ "Content-Type": file.type, "Content-Security-Policy": FALLBACK_CSP }));
      headers.set("Cache-Control", path.startsWith("/assets/") && file.path !== ui.files.get(ui.shell)?.path ? "private, max-age=31536000, immutable" : "private, no-cache");
      audit.write({ ...base, route: file === ui.files.get(path) ? "ui-file" : "page", capability: "view", status: 200, outcome: "allowed", ms: Date.now() - started });
      return finish(new Response(method === "HEAD" ? null : Bun.file(file.path), { status: 200, headers }));
    }

    // 9. The /__ allow-list. Unknown routes do not exist.
    const allowed = permitted(method, path, caps, upgrade);
    if (!allowed.ok) {
      const needs = allowed.needs;
      return finish(
        deny(403, needs ? "capability" : "not-listed", needs ? `That needs the ${needs} capability, which a founder has not granted.` : "That is not available through the gateway.", {
          // A refused /__ route the policy does not list is audited by its path TEMPLATE (ids, numbers, emails and long tokens become
          // "*"; never the query string or a body), so the next missing route is diagnosable from the audit alone.
          route: allowed.template ?? `unlisted ${pathTemplate(path)}`,
          capability: needs,
        }),
      );
    }
    const { decision } = allowed;
    const key = secret();
    if (!key) return finish(deny(503, "no-key", "The gateway is not ready.", { route: decision.template, capability: decision.capability }));
    const delegatedBy = decision.capability === "view" ? undefined : grantedBy[decision.capability];
    const entry: Omit<AuditEntry, "at" | "outcome"> = { ...base, route: decision.template, capability: decision.capability, ...(delegatedBy ? { delegatedBy } : {}) };

    // The upstream target: the fixed origin plus this path and query, in the exact form the hub will receive (and the assertion signs).
    const upstreamUrl = new URL(upstreamOrigin + path + url.search);
    const target = upstreamUrl.pathname + upstreamUrl.search;
    const headers = new Headers();
    for (const name of FORWARD_REQUEST) {
      const v = req.headers.get(name);
      if (v !== null) headers.set(name, v);
    }
    headers.set("accept-encoding", "identity");
    headers.set("via", VIA_VALUE);
    headers.set(ASSERTION_HEADER, signAssertion(key, { method, target, sessionId: session.id, caps, delegatedBy, identityId: session.identityId, upgrade }));

    if (upgrade) return socket(req, server, { session, decision, ip, headers, upstreamUrl, entry, started });

    let body: ArrayBuffer | undefined;
    if (write) {
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > LIMITS.maxBodyBytes) return finish(deny(413, "body-too-large", "That request is too large.", entry));
      try {
        body = await req.arrayBuffer();
      } catch {
        return finish(deny(400, "body", "The request body could not be read.", entry));
      }
      if (body.byteLength > LIMITS.maxBodyBytes) return finish(deny(413, "body-too-large", "That request is too large.", entry));
    }

    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => abort.abort(), LIMITS.upstreamHeaderTimeoutMs);
    let up: Response;
    try {
      up = await fetch(upstreamUrl, { method, headers, body, redirect: "manual", signal: abort.signal, decompress: false } as RequestInit);
    } catch {
      clearTimeout(timer);
      audit.write({ ...entry, status: 502, outcome: "allowed", reason: "upstream-unreachable", ms: Date.now() - started });
      return finish(json(502, { error: "Agentic OS is not answering right now." }));
    }
    clearTimeout(timer);

    const out = withSecurity(new Headers());
    up.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.test(name)) out.append(name, value);
    });
    if (!out.has("content-security-policy")) out.set("Content-Security-Policy", FALLBACK_CSP);
    // An authenticated answer is never stored by a shared cache, and not by the browser unless the hub said how.
    if (!out.has("cache-control")) out.set("Cache-Control", "private, no-store");
    if (up.status >= 300 && up.status < 400) {
      // A redirect never names the hub's own address, and never leaves the gateway's origin.
      const location = rewriteLocation(up.headers.get("location"), upstreamUrl);
      if (!location) {
        abort.abort();
        audit.write({ ...entry, status: 502, outcome: "allowed", reason: "redirect-blocked", ms: Date.now() - started });
        return finish(json(502, { error: "That redirect is not available through the gateway." }));
      }
      out.set("Location", location);
    }
    const recordIds = write ? parseRecordIds(up.headers.get(RECORD_IDS_HEADER)) : [];
    audit.write({ ...entry, status: up.status, outcome: "allowed", ...(recordIds.length ? { recordIds } : {}), ms: Date.now() - started });

    if (!up.body || method === "HEAD" || up.status === 204 || up.status === 304) return finish(new Response(null, { status: up.status, headers: out }));

    const isStream = (up.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
    if (isStream && [...streams].filter((s) => s.session === session!.id).length >= LIMITS.maxStreamsPerSession) {
      abort.abort();
      return finish(json(429, { error: "Too many live streams open; close another tab." }, { "Retry-After": "10" }));
    }
    if (isStream) server.timeout(req, 0);
    else timer = setTimeout(() => abort.abort(), LIMITS.upstreamTotalTimeoutMs);

    // The body is pumped by hand so a revocation can end it from this side at once.
    const reader = up.body.getReader();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let done = false;
    const open: OpenStream = {
      session: session.id,
      capability: decision.capability,
      close(reason) {
        if (done) return;
        done = true;
        streams.delete(open);
        clearTimeout(timer);
        abort.abort();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        if (isStream) audit.write({ ...entry, event: "stream-closed", outcome: "allowed", reason });
      },
    };
    const bodyOut = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        void (async () => {
          try {
            for (;;) {
              const { done: end, value } = await reader.read();
              if (end || done) break;
              ctrl.enqueue(value);
            }
          } catch {
            /* aborted, or the hub went away */
          }
          open.close("upstream-ended");
        })();
      },
      cancel() {
        open.close("client-left");
      },
    });
    if (isStream) streams.add(open);
    return finish(new Response(bodyOut, { status: up.status, headers: out }));
  }

  function rewriteLocation(location: string | null, from: URL): string | null {
    if (!location) return null;
    try {
      const u = new URL(location, from);
      if (u.origin !== upstreamOrigin && !(LOOPBACK_HOSTS.has(u.hostname) && u.port === new URL(upstreamOrigin).port)) return null;
      return u.pathname + u.search + u.hash;
    } catch {
      return null;
    }
  }

  // ── sign-in ────────────────────────────────────────────────────────────────────────────────────────────────────

  async function enrol(req: Request, ip: string, started: number, origin: string | null): Promise<Response> {
    const base = { person: null, session: null, ip, method: "POST", route: "/gw/enrol" } as const;
    const refuse = (status: number, reason: string, error: string, headers: Record<string, string> = {}) => {
      audit.write({ event: "enrol-failed", ...base, status, outcome: "denied", reason });
      return json(status, { error }, headers);
    };
    // The custom header plus JSON is what a cross-site form cannot send. A browser sign-in (which sets the cookie) must also
    // come from the gateway's own page; a program asking for a bearer token has no Origin (one it does send was checked above).
    if (req.headers.get(ENROL_HEADER) !== "1" || !(req.headers.get("content-type") ?? "").includes("application/json")) return refuse(403, "origin-required", "Use the sign-in page.");
    const c = control.read();
    const attemptWait = limiter.hit(`enrol|${ip}`, LIMITS.enrolAttemptsPerIpPerMinute, 60_000, started);
    if (attemptWait) return refuse(429, "rate-enrol", "Too many attempts. Wait and try again.", { "Retry-After": String(attemptWait) });
    // Per address only when the address means something (a forwarded client address, or a direct peer). Behind an edge with
    // forwardedFor off every request is 127.0.0.1, and one attacker must not lock Dot out: the per-code limit protects then.
    const ipLocked = addressKnown(ip) && enrolFailures.count(`f|${ip}`, started) >= LIMITS.enrolFailuresPerIp;
    if (ipLocked) return refuse(429, "locked-out", "Sign-in is locked for this address after too many wrong codes. Try again later.", { "Retry-After": String(Math.ceil(LIMITS.enrolLockoutMs / 1000)) });
    let code = "";
    let mode: AccessMode = "cookie";
    try {
      if (Number(req.headers.get("content-length") ?? "0") > 2048) throw new Error("large");
      const body = (await req.json()) as { code?: unknown; mode?: unknown };
      code = typeof body?.code === "string" ? body.code.slice(0, 64) : "";
      if (body?.mode === "bearer") mode = "bearer";
    } catch {
      return refuse(400, "body", "Enter the code.");
    }
    if (mode === "cookie" && origin !== publicOrigin) return refuse(403, "origin-required", "Use the sign-in page.");
    const redeemed = code ? sessions.redeem(code, c, effectiveCapabilities(c, started).caps, started, mode) : null;
    if (!redeemed) {
      if (addressKnown(ip)) enrolFailures.hit(`f|${ip}`, LIMITS.enrolFailuresPerIp, LIMITS.enrolLockoutMs, started);
      // Every wrong guess counts against EVERY unused code; a code that has absorbed enough guesses is burned (sessions.ts).
      const { burned, recent } = sessions.enrolFailed(c, started);
      for (const id of burned) audit.write({ event: "enrol-failed", person: null, session: null, ip: "-", route: "/gw/enrol", outcome: "denied", reason: `code-burned:${id}` });
      if (recent >= LIMITS.enrolFailuresGlobal && started - alertedAt > LIMITS.enrolWindowMs) {
        alertedAt = started;
        log(`ALERT: ${recent} wrong sign-in codes in the last ${Math.round(LIMITS.enrolWindowMs / 60_000)} minutes; unused codes absorb them and burn. Check the audit.`);
        audit.write({ event: "enrol-failed", person: null, session: null, ip: "-", route: "/gw/enrol", outcome: "denied", reason: "global-alert" });
      }
      // The same answer and roughly the same time for wrong, used and expired codes.
      await new Promise((r) => setTimeout(r, 250));
      return refuse(401, "bad-code", "That code is not valid. Codes work once and expire within minutes.");
    }
    audit.write({ event: "enrol", person: GATEWAY_PERSON, session: redeemed.session.id, identity: redeemed.identity.id, ip, method: "POST", route: "/gw/enrol", status: 200, outcome: "allowed", delegatedBy: redeemed.session.enrolledBy });
    // The reconnect key is shown ONCE, here. Only its hash is kept; a founder cannot read it back, only revoke it.
    return json(200, { ok: true, person: GATEWAY_PERSON, reconnectKey: redeemed.reconnectKey, ...accessView(redeemed.session, redeemed.token, mode) }, mode === "cookie" ? { "Set-Cookie": cookie(redeemed.token) } : {});
  }

  const identityView = (session: SessionRow) => {
    const identity = sessions.identity(session.identityId);
    return identity ? { id: identity.id, label: identity.label, enrolledBy: identity.enrolledBy, createdAt: identity.createdAt, expiresAt: identityExpiry(identity, control.read()) } : null;
  };
  /** What a sign-in or a renewal answers: when the access ends, and the bearer token itself only in bearer mode. */
  const accessView = (session: SessionRow, token: string, mode: AccessMode) => ({
    identity: identityView(session),
    access: { mode, session: session.id, expiresAt: session.expiresAt, idleMinutes: Math.round(session.idleMs / 60_000), ...(mode === "bearer" ? { accessToken: ACCESS_TOKEN_PREFIX + token, header: "Authorization: Bearer <accessToken>" } : {}) },
  });

  // ── renewal: the reconnect key buys a new short-lived access session ──────────────────────────────────────────────

  async function renew(req: Request, ip: string, started: number, origin: string | null): Promise<Response> {
    const base = { person: null, session: null, ip, method: "POST", route: "/gw/renew" } as const;
    const refuse = (status: number, reason: string, error: string, headers: Record<string, string> = {}) => {
      audit.write({ event: "renew-failed", ...base, status, outcome: "denied", reason });
      return json(status, { error }, headers);
    };
    if (req.headers.get(ENROL_HEADER) !== "1" || !(req.headers.get("content-type") ?? "").includes("application/json")) return refuse(403, "origin-required", "Send JSON with the X-MU-Gateway-Enrol header.");
    const wait = limiter.hit(`renew|${ip}`, LIMITS.renewAttemptsPerIpPerMinute, 60_000, started);
    if (wait) return refuse(429, "rate-renew", "Too many attempts. Wait and try again.", { "Retry-After": String(wait) });
    let key = "";
    let mode: AccessMode = "cookie";
    try {
      if (Number(req.headers.get("content-length") ?? "0") > 2048) throw new Error("large");
      const body = (await req.json()) as { reconnectKey?: unknown; mode?: unknown };
      key = typeof body?.reconnectKey === "string" ? body.reconnectKey.slice(0, 128) : "";
      if (body?.mode === "bearer") mode = "bearer";
    } catch {
      return refuse(400, "body", "Send { reconnectKey }.");
    }
    if (mode === "cookie" && origin !== publicOrigin) return refuse(403, "origin-required", "Use the sign-in page.");
    const c = control.read();
    const renewed = key ? sessions.renew(key, c, effectiveCapabilities(c, started).caps, started, mode) : null;
    if (!renewed) {
      // One answer and roughly one time for an unknown key, a revoked identity and an expired one.
      await new Promise((r) => setTimeout(r, 250));
      return refuse(401, "bad-key", "That reconnect key is not valid. It may have expired or been revoked; ask a founder for a new sign-in code.");
    }
    audit.write({ event: "renew", person: GATEWAY_PERSON, session: renewed.session.id, identity: renewed.identity.id, ip, method: "POST", route: "/gw/renew", status: 200, outcome: "allowed", delegatedBy: renewed.identity.enrolledBy });
    return json(200, { ok: true, person: GATEWAY_PERSON, ...accessView(renewed.session, renewed.token, mode) }, mode === "cookie" ? { "Set-Cookie": cookie(renewed.token) } : {});
  }

  // ── WebSocket: authenticated at the upgrade, re-checked while open ─────────────────────────────────────────────

  async function socket(
    req: Request,
    server: Server<SocketData>,
    ctx: { session: SessionRow; decision: { capability: Capability; template: string }; ip: string; headers: Headers; upstreamUrl: URL; entry: Omit<AuditEntry, "at" | "outcome">; started: number },
  ): Promise<Response | undefined> {
    const { session, decision, entry } = ctx;
    const refuse = (status: number, reason: string, error: string) => {
      audit.write({ ...entry, status, outcome: "denied", reason, ms: Date.now() - ctx.started });
      return json(status, { error });
    };
    // A browser always sends Origin on a WebSocket; without it this is not one of the gateway's pages.
    if (req.headers.get("origin") !== publicOrigin) return refuse(403, "origin-required", "Unknown origin.");
    if ([...sockets].filter((s) => s.data.session === session.id).length >= LIMITS.maxSocketsPerSession) return refuse(429, "too-many-sockets", "Too many live connections.");
    const wsUrl = new URL(ctx.upstreamUrl);
    wsUrl.protocol = "ws:";
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._-]{1,40}$/.test(s));
    const forward: Record<string, string> = {};
    for (const name of ["via", ASSERTION_HEADER, "user-agent"]) {
      const v = ctx.headers.get(name);
      if (v) forward[name] = v;
    }
    const upstream = new WebSocket(wsUrl, { headers: forward, ...(protocols.length ? { protocols } : {}) } as never);
    upstream.binaryType = "arraybuffer";
    const pending: Array<string | ArrayBuffer> = [];
    upstream.onmessage = (e) => pending.push(e.data as string | ArrayBuffer);
    const opened = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000);
      upstream.onopen = () => (clearTimeout(t), resolve(true));
      upstream.onerror = () => (clearTimeout(t), resolve(false));
      upstream.onclose = () => (clearTimeout(t), resolve(false));
    });
    if (!opened) {
      try {
        upstream.close();
      } catch {
        /* never opened */
      }
      return refuse(502, "upstream-refused", "That live connection is not available.");
    }
    const data: SocketData = { session: session.id, capability: decision.capability, ip: ctx.ip, route: decision.template, upstream, pending, openedAt: Date.now() };
    const ok = server.upgrade(req, { data, headers: upstream.protocol ? { "Sec-WebSocket-Protocol": upstream.protocol } : undefined });
    if (!ok) {
      upstream.close();
      return refuse(400, "upgrade-failed", "Expected a WebSocket upgrade.");
    }
    audit.write({ ...entry, status: 101, outcome: "allowed", ms: Date.now() - ctx.started });
    return undefined;
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: config.port,
    idleTimeout: 60,
    // Bun drops the connection above this; the gateway's own limit (LIMITS.maxBodyBytes) answers 413 well below it.
    maxRequestBodySize: 8 * LIMITS.maxBodyBytes,
    async fetch(req, srv) {
      try {
        return await handle(req, srv);
      } catch (error) {
        console.error(`[gateway] request failed: ${(error as Error)?.name ?? "error"}`);
        return json(500, { error: "Something went wrong." });
      }
    },
    websocket: {
      maxPayloadLength: 1_048_576,
      idleTimeout: 120,
      open(ws) {
        sockets.add(ws);
        const up = ws.data.upstream;
        for (const m of ws.data.pending.splice(0)) ws.send(m);
        up.onmessage = (e) => {
          try {
            ws.send(e.data as string | ArrayBuffer);
          } catch {
            /* closing */
          }
        };
        const gone = () => {
          try {
            ws.close(1000, "upstream-closed");
          } catch {
            /* gone */
          }
        };
        up.onclose = gone;
        up.onerror = gone;
      },
      message(ws, message) {
        try {
          ws.data.upstream.send(message as string);
        } catch {
          ws.close(1011, "upstream-gone");
        }
      },
      close(ws, _code, reason) {
        sockets.delete(ws);
        try {
          ws.data.upstream.close();
        } catch {
          /* gone */
        }
        audit.write({ event: "socket-closed", person: GATEWAY_PERSON, session: ws.data.session, ip: ws.data.ip, route: ws.data.route, capability: ws.data.capability, outcome: "allowed", reason: String(reason || "client-left").slice(0, 40) });
      },
    },
  });

  log(`listening on 127.0.0.1:${server.port} for ${publicOrigin}; upstream ${upstreamOrigin}`);

  return {
    port: server.port,
    openStreams: () => streams.size,
    openSockets: () => sockets.size,
    async stop() {
      clearInterval(recheckTimer);
      for (const s of [...streams]) s.close("gateway-stopped");
      for (const ws of [...sockets]) ws.close(1001, "gateway-stopped");
      sessions.close();
      await server.stop(true);
    },
  };
}

export type Gateway = ReturnType<typeof startGateway>;
