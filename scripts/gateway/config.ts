/**
 * Dot gateway: the names, files and limits shared by the gateway process, its CLI and the hub-side trust check.
 * Design: docs/programme-20261001/DOT-GATEWAY-DESIGN.md. Nothing here reads a secret.
 */
import { join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";

/** The one external collaborator the gateway serves. Never a founder (scripts/devices/types.ts PERSON_IDS). */
export { GATEWAY_PERSON } from "./actor";
import { GATEWAY_PERSON } from "./actor";
export const GATEWAY_DISPLAY_NAME = "Dot";

/** `__Host-`: the browser only accepts it with Secure, Path=/ and no Domain, so no other host or path can set or read it. */
export const SESSION_COOKIE_NAME = "__Host-mu_gw";
/** Gateway -> hub: the signed per-request assertion. The hub removes it before any handler runs. */
export const ASSERTION_HEADER = "x-mu-gateway-assertion";
/** Gateway -> hub: marks the request as relayed (scripts/identity/principal.ts RELAY_HEADER), so it is never "at this PC". */
export const VIA_VALUE = "1.1 mu-dot-gateway";
/** Hub -> gateway: record ids a write touched, for the audit entry. Removed before the response reaches the browser. */
export const RECORD_IDS_HEADER = "x-mu-record-ids";
/** The page token header the OS UI already sends on writes; through the gateway it carries the gateway's CSRF token. */
export const CSRF_HEADER = "x-claude-os-token";
export const ENROL_HEADER = "x-mu-gateway-enrol";
/** Dot's reconnect key and bearer access token carry a prefix so a log scanner (and a person) can tell what leaked. Never stored: only hashes. */
export const RECONNECT_KEY_PREFIX = "mugw_rk_";
export const ACCESS_TOKEN_PREFIX = "mugw_at_";

export const FILES = {
  /** Written only by the founder CLI: enrolment codes (hashed), capability grants, revocations. */
  control: "control.json",
  /** Written only by the gateway process: sessions (hashed tokens), used codes, enrolment lockout. */
  sessions: "sessions.json",
  /** Presence = refuse everything (gateway and hub both check it). */
  kill: "KILL",
  /** The gateway -> hub HMAC key. Restricted ACL, never logged or printed. */
  secret: "hub-assertion.key",
  /** The hub's clearly-marked test activities (crm.write proof until Dot's CRM ops land). */
  activities: "crm-test-activities.json",
} as const;

/** MU_DATA_DIR/gateway (or <root>/.operator-data/gateway). */
export function gatewayDir(root: string, env: Record<string, string | undefined> = process.env): string {
  return join(dataDirFor(root, env), "gateway");
}

export const LIMITS = {
  /** Enrolment codes. */
  codeMinutesDefault: 10,
  codeMinutesMax: 60,
  /** Sessions: idle and absolute expiry. */
  idleMinutesDefault: 120,
  sessionHoursDefault: 12,
  sessionHoursMax: 168,
  /** After a rotation the previous cookie value keeps working this long (requests already in flight). */
  rotationGraceMs: 15_000,
  /**
   * Dot's identity (its reconnect key): how long it lasts before a founder must enrol Dot again. Access itself is short
   * (the session limits above); the identity only lets Dot ask for new access, and a founder can revoke it at any moment.
   */
  identityDaysDefault: 30,
  identityDaysMax: 90,
  /** Live access sessions one identity may hold at once (parallel tasks); the oldest is ended when a new one would exceed it. */
  maxSessionsPerIdentity: 6,
  renewAttemptsPerIpPerMinute: 30,
  /** Capability grants always expire. */
  grantHoursDefault: 8,
  grantHoursMax: 720,
  /** Assertions: validity either side of the hub's clock. */
  assertionSkewMs: 30_000,
  /** Bodies and timeouts. */
  maxBodyBytes: 1024 * 1024,
  upstreamHeaderTimeoutMs: 30_000,
  upstreamTotalTimeoutMs: 120_000,
  /** Open streams and sockets are re-checked this often (revocation, expiry, kill switch). */
  recheckMs: 1_000,
  /** Rate limits (per minute unless said). */
  // The OS shell polls several panels on every page (status, activity, notices), so a browser session makes many small
  // reads; writes keep their own, much lower, limit below.
  perIpPerMinute: 3_000,
  perSessionPerMinute: 1_500,
  perSessionWritesPerMinute: 60,
  /** Per address; behind an edge with forwardedFor off every client shares one address, so this is then gateway-wide. */
  enrolAttemptsPerIpPerMinute: 30,
  enrolFailuresPerIp: 5,
  /** Wrong codes an unused code absorbs before it is burned (it can no longer be used; a founder makes a new one). */
  enrolFailuresPerCode: 20,
  /** Wrong codes across the gateway in the window that raise an alert (audit + console). It never locks the gateway. */
  enrolFailuresGlobal: 50,
  enrolWindowMs: 15 * 60_000,
  enrolLockoutMs: 15 * 60_000,
  maxStreamsPerSession: 8,
  maxSocketsPerSession: 4,
} as const;
