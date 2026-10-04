/**
 * The per-request assertion the gateway signs and the hub verifies (DOT-GATEWAY-DESIGN.md, "Gateway to hub trust").
 *
 *   X-MU-Gateway-Assertion: v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(key, "mu-gateway-assertion.v1." + payload))>
 *
 * Claims bind the assertion to ONE request: the method, the exact request target (path and query), the gateway session,
 * the person ("dot"), the capability set, a timestamp and a random nonce. The hub accepts it only on a loopback socket,
 * only inside a short window, and only once (the nonce). A person header, a copied cookie or a replayed assertion is useless.
 * The body is not covered: the hop is loopback on one machine, and the method and target already decide what may run.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GATEWAY_PERSON, LIMITS } from "./config";

export type AssertionClaims = {
  v: 1;
  /** Method, upper case. */
  m: string;
  /** The request target exactly as sent to the hub: path plus query. */
  p: string;
  /** The gateway session's PUBLIC id (never the cookie value). */
  sid: string;
  sub: typeof GATEWAY_PERSON;
  caps: string[];
  /** Milliseconds since the epoch, gateway clock. */
  ts: number;
  /** Random, single use. */
  n: string;
  /** The founder who granted the capability this request uses, when it uses one beyond `view`. */
  by?: string;
  /** Dot's identity (public id) behind the session, so the hub can refuse a revoked identity itself. */
  iid?: string;
  /** 1 when this is a WebSocket upgrade: an upgrade's assertion is never accepted as an ordinary request, or the reverse. */
  u?: 1;
};

const DOMAIN = "mu-gateway-assertion.v1.";
const sig = (key: string, payload: string) => createHmac("sha256", key).update(DOMAIN + payload).digest();

export function signAssertion(key: string, input: { method: string; target: string; sessionId: string; caps: string[]; delegatedBy?: string; identityId?: string; upgrade?: boolean; now?: number }): string {
  const claims: AssertionClaims = {
    v: 1,
    m: input.method.toUpperCase(),
    p: input.target,
    sid: input.sessionId,
    sub: GATEWAY_PERSON,
    caps: [...input.caps].sort(),
    ts: input.now ?? Date.now(),
    n: randomBytes(16).toString("base64url"),
    ...(input.delegatedBy ? { by: input.delegatedBy } : {}),
    ...(input.identityId ? { iid: input.identityId } : {}),
    ...(input.upgrade ? { u: 1 as const } : {}),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `v1.${payload}.${sig(key, payload).toString("base64url")}`;
}

export type VerifyResult = { ok: true; claims: AssertionClaims } | { ok: false; reason: "malformed" | "signature" | "claims" | "method" | "target" | "kind" | "expired" | "replay" };

/** Remembers nonces until their assertion could no longer be accepted anyway. Bounded. */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private readonly max = 50_000) {}
  /** True when this nonce is new (and now remembered); false on a replay. */
  take(nonce: string, expiresAt: number, now: number): boolean {
    if (this.seen.size >= this.max || this.seen.size % 512 === 511) for (const [k, t] of this.seen) if (t <= now) this.seen.delete(k);
    // Still full of live nonces: refuse rather than forget one (fail closed under a flood).
    if (this.seen.size >= this.max) return false;
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }
}

export function verifyAssertion(
  key: string,
  header: unknown,
  expect: { method: string; target: string; now?: number; skewMs?: number; nonces?: NonceCache; upgrade?: boolean },
): VerifyResult {
  if (typeof header !== "string" || header.length > 4096) return { ok: false, reason: "malformed" };
  const parts = header.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return { ok: false, reason: "malformed" };
  const want = sig(key, parts[1]);
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "signature" };
  let claims: AssertionClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as AssertionClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !claims || claims.v !== 1 || claims.sub !== GATEWAY_PERSON || typeof claims.sid !== "string" || !/^[a-f0-9]{16,64}$/.test(claims.sid) ||
    !Array.isArray(claims.caps) || claims.caps.some((c) => typeof c !== "string") || typeof claims.ts !== "number" || typeof claims.n !== "string" || claims.n.length < 16 ||
    (claims.by !== undefined && typeof claims.by !== "string") ||
    (claims.iid !== undefined && (typeof claims.iid !== "string" || !/^[a-f0-9]{8,32}$/.test(claims.iid)))
  )
    return { ok: false, reason: "claims" };
  if (claims.m !== String(expect.method).toUpperCase()) return { ok: false, reason: "method" };
  if (claims.p !== expect.target) return { ok: false, reason: "target" };
  if ((claims.u === 1) !== !!expect.upgrade) return { ok: false, reason: "kind" };
  const now = expect.now ?? Date.now();
  const skew = expect.skewMs ?? LIMITS.assertionSkewMs;
  if (Math.abs(now - claims.ts) > skew) return { ok: false, reason: "expired" };
  if (expect.nonces && !expect.nonces.take(claims.n, claims.ts + skew, now)) return { ok: false, reason: "replay" };
  return { ok: true, claims };
}
