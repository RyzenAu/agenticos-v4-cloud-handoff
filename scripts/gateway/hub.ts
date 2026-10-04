/**
 * HUB SIDE of the Dot gateway: turns a signed gateway assertion into the one non-founder principal, and enforces the
 * capability table a second time (DOT-GATEWAY-DESIGN.md, "Identity mapping").
 *
 * The identity gate calls `screen(req)` first thing, for every request:
 *
 *   - no assertion header      -> null: the request is not from the gateway and everything is exactly as it was
 *                                 (founders, pairing, Tailscale, the local-owner proof: untouched);
 *   - an assertion header that does not verify, or gateway trust is off, or the kill switch is on
 *                              -> refused outright. It never falls through to another identity;
 *   - a valid assertion        -> the request is marked as the gateway principal (person "dot", via "gateway", a PROCESS
 *                                 actor: never a founder, never the loopback owner, never at the hub, never a human
 *                                 session), and is allowed only if policy.ts lists this method and path for a capability
 *                                 the assertion carries AND the hub's own route table classes it "shared".
 *
 * Trust is OFF unless the hub is started with MU_GATEWAY_TRUST=1, so a production hub ignores (refuses) assertions until
 * the owner turns it on. The key file is created by whichever of the hub and the gateway starts first.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PersonId } from "../devices/types";
import { isLoopbackSocket, markGatewayPrincipal, pageTokenFor, type Principal, type ReqLike } from "../identity/principal";
import { routeClass } from "../identity/routes";
import { NonceCache, verifyAssertion } from "./assertion";
import { ASSERTION_HEADER, CSRF_HEADER, FILES, GATEWAY_DISPLAY_NAME, GATEWAY_PERSON, gatewayDir, VIA_VALUE } from "./config";
import { isCapability, nonCanonical, permitted, type Capability } from "./policy";
import { ensureGatewaySecret, gatewaySecretReader } from "./secret";
import { ControlFile } from "./store";

export type GatewayScreen = null | { ok: true; principal: Principal } | { ok: false; status: 401 | 403 | 503; error: string; reason: string };

export type GatewayTrust = {
  enabled: boolean;
  /** For ordinary requests (the identity gate). */
  screen(req: ReqLike): GatewayScreen;
  /** For a WebSocket upgrade, which never passes the gate: the same check, for the upgrade's own handler. */
  screenUpgrade(req: ReqLike): GatewayScreen;
};

export type GatewayTrustOptions = {
  root: string;
  /** The per-run internal page token (as GateOptions.internalToken). */
  internalToken: () => string;
  /** Default: MU_GATEWAY_TRUST === "1". */
  enabled?: boolean;
  /** Default: MU_DATA_DIR/gateway. */
  dir?: string;
  now?: () => number;
  env?: Record<string, string | undefined>;
};

/**
 * "dot" is deliberately NOT a PersonId (scripts/devices/types.ts PERSON_IDS is the two founders). The principal carries it
 * through the founder-typed field so every `isPersonId`, `=== "usman"` and `=== "mehroz"` check in the hub fails closed
 * for Dot, and every record the hub writes for this request says "dot".
 */
const DOT = GATEWAY_PERSON as unknown as PersonId;

const refused = (status: 401 | 403 | 503, reason: string, error: string): GatewayScreen => ({ ok: false, status, error, reason });

export function createGatewayTrust(options: GatewayTrustOptions): GatewayTrust {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? env.MU_GATEWAY_TRUST === "1";
  const dir = options.dir ?? gatewayDir(options.root, env);
  const now = options.now ?? Date.now;
  const nonces = new NonceCache();
  /** The founders' control file (re-read only when it changes): a revoked session or identity is refused HERE too, whatever the gateway signed. */
  const control = new ControlFile(dir);
  let secret: (() => string | null) | null = null;
  if (enabled) {
    try {
      ensureGatewaySecret(dir);
      secret = gatewaySecretReader(dir);
    } catch (error) {
      console.warn(`gateway trust is off: the assertion key could not be prepared (${(error as Error).name})`);
    }
  }

  function check(req: ReqLike, upgrade: boolean): GatewayScreen {
    const headers = req.headers ?? {};
    const presented = headers[ASSERTION_HEADER];
    if (presented === undefined) return null;
    // The assertion never reaches a handler or a bridge, whatever happens next.
    delete headers[ASSERTION_HEADER];
    if (!enabled || !secret) return refused(401, "trust-off", "This hub does not accept gateway requests.");
    if (existsSync(join(dir, FILES.kill))) return refused(503, "kill-switch", "The gateway is switched off.");
    // Only the gateway process on this machine: a loopback socket, the gateway's own Via, and nothing Tailscale stamped
    // (a Serve-relayed tailnet request also arrives on loopback, and must never be able to present an assertion).
    if (!isLoopbackSocket(req)) return refused(401, "not-loopback", "Gateway requests are accepted on loopback only.");
    if (Object.keys(headers).some((h) => /^tailscale-/i.test(h)) || String(headers.via ?? "") !== VIA_VALUE) return refused(401, "not-gateway", "Not a gateway request.");
    const key = secret();
    if (!key) return refused(401, "no-key", "This hub does not accept gateway requests.");
    const method = String(req.method || "GET").toUpperCase();
    const target = String(req.url || "/");
    // The gateway's strict target rule, again, here: ADS suffixes, colons, NUL, trailing dots or spaces, encoded separators.
    if (nonCanonical(target)) return refused(403, "target", "That is not available to the gateway.");
    const verified = verifyAssertion(key, Array.isArray(presented) ? presented[0] : presented, { method, target, now: now(), nonces, upgrade });
    if (!verified.ok) return refused(401, verified.reason, "The gateway assertion was not accepted.");
    const caps = verified.claims.caps.filter(isCapability) as Capability[];
    if (caps.length !== verified.claims.caps.length) return refused(401, "claims", "The gateway assertion was not accepted.");
    // Revocation is immediate at the hub as well: the founder's control file is the authority, not what the gateway signed a moment ago.
    const c = control.read();
    if (c.revokedSessions[verified.claims.sid] !== undefined || (verified.claims.iid !== undefined && c.revokedIdentities?.[verified.claims.iid] !== undefined)) return refused(401, "revoked", "This access was revoked by a founder.");

    const principal: Principal = {
      personId: DOT,
      via: "gateway",
      actor: "process",
      sessionId: `gw:${verified.claims.sid}`,
      displayName: GATEWAY_DISPLAY_NAME,
      capabilities: caps,
      ...(verified.claims.by ? { delegatedBy: verified.claims.by } : {}),
      ...(verified.claims.iid ? { gatewayIdentityId: verified.claims.iid } : {}),
    };
    // From here on this request IS the gateway principal, for the gate and for every handler (identifyRequest reads the mark).
    markGatewayPrincipal(req, principal);

    // The hub's own capability check: the same table the gateway used, and the hub's route classes on top.
    const q = target.search(/[?#]/);
    const path = q < 0 ? target : target.slice(0, q);
    // The gateway serves the UI itself and never forwards a non-/__ path: the hub refuses one outright (no dev-server files).
    if (!path.startsWith("/__")) return refused(403, "not-api", "That is not available to the gateway.");
    const allowed = permitted(method, path, caps, upgrade);
    if (!allowed.ok) return refused(403, allowed.reason, allowed.needs ? `That needs the ${allowed.needs} capability.` : "That is not available to the gateway.");
    if (path.startsWith("/__") && routeClass(path, method) !== "shared") return refused(403, "not-shared", "That is not available to the gateway.");

    // Nothing the internet sent may act as a credential here. The gateway already checked the page's origin and CSRF token,
    // and this assertion is bound to the method and path, so a write is handed the page token the handlers compare against.
    delete headers.cookie;
    delete headers.authorization;
    delete headers[CSRF_HEADER];
    if (method !== "GET" && method !== "HEAD") headers[CSRF_HEADER] = pageTokenFor(principal, options.internalToken());
    return { ok: true, principal };
  }

  return { enabled: enabled && !!secret, screen: (req) => check(req, false), screenUpgrade: (req) => check(req, true) };
}

/** The gateway principal's capabilities (empty for anyone else). Handlers use it for their own, third, check. */
export function gatewayCapabilities(principal: Principal | null): readonly string[] {
  return principal?.via === "gateway" ? (principal.capabilities ?? []) : [];
}
