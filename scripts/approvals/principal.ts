// The Principal B2 works with (TARGET-ARCHITECTURE §3.1). Stage B1 (scripts/identity) owns identity: its
// `requestPrincipal` is the resolver the routes use, and its `isHumanSession` / `isBrowserPrincipal` decide
// what counts as a person at a browser. This type is B1's Principal with `actor`/`displayName` optional, so
// B2's stored and test principals stay small; a missing actor means process (fail closed). Nothing here
// reads a person from a body or a display name: a Principal only ever comes from B1's resolver.
import type { IncomingHttpHeaders } from "node:http";
import { isBrowserPrincipal, isHumanSession, type Principal as IdentityPrincipal } from "../identity/principal";

export type PersonId = "usman" | "mehroz";
export type PrincipalVia = "loopback-owner" | "paired-session" | "tailnet-person" | "telegram-owner" | "companion";
/**
 * B1's actor (scripts/identity/principal.ts): `human` is a person interacting now (a browser holding a
 * live session cookie, or a Telegram DM they typed); `process` is a program acting for them (Hermes, cron,
 * a Codex/Claude job, curl, the companion). Missing = process (fail closed until B1 supplies it).
 * Limit, stated plainly: a program running as the owner's Windows account can drive his browser, so
 * "human" guards against agents and scripts calling the API, not against malware on his own account.
 */
export type PrincipalActor = "human" | "process";
export type Principal = {
  personId: PersonId;
  via: PrincipalVia;
  actor?: PrincipalActor;
  sessionId?: string;
  deviceId?: string;
  /** Personalisation only; never used for a decision. */
  displayName?: string;
};

/** Minimal request shape a resolver sees (a Node IncomingMessage satisfies it). */
export type PrincipalRequest = { headers: IncomingHttpHeaders; socket: { remoteAddress?: string | null } };
/** The ONE identity function: B1's requestPrincipal. Routes answer 401 when it returns null. */
export type ResolvePrincipal = (req: PrincipalRequest) => Principal | null;

const PEOPLE: readonly PersonId[] = ["usman", "mehroz"];
const VIAS: readonly PrincipalVia[] = ["loopback-owner", "paired-session", "tailnet-person", "telegram-owner", "companion"];

/** Structural check for a Principal handed across a module boundary (never trusts a body). */
export function isPrincipal(value: unknown): value is Principal {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (!PEOPLE.includes(p.personId as PersonId) || !VIAS.includes(p.via as PrincipalVia)) return false;
  if (p.actor !== undefined && p.actor !== "human" && p.actor !== "process") return false;
  for (const k of ["sessionId", "deviceId", "displayName"] as const)
    if (p[k] !== undefined && (typeof p[k] !== "string" || (p[k] as string).length > 200)) return false;
  return true;
}

/**
 * A verified interactive UI session: a signed-in browser session (B1's session cookie) that carries a
 * session id, at this PC, over the tailnet or on a paired device. A caller holding only the page token
 * (any local process: a coding agent, Hermes, a script) has no session id, so it is NOT a UI session.
 * Telegram and the companion are never a UI session.
 */
export function hasVerifiedUiSession(p: Principal): boolean {
  // B1: a human (live session cookie) at a browser (not Telegram, not the companion), with its session key.
  const q = p as unknown as IdentityPrincipal;
  return isHumanSession(q) && isBrowserPrincipal(q) && typeof p.sessionId === "string" && p.sessionId.length >= 8;
}

/**
 * A small, log-safe copy (no display name) for storage and every JSON view. The actor is always
 * recorded (missing = process). Never the sessionId: B1's server-only session key (`sk1.`) stays on the
 * in-memory Principal (card nonces bind to it there) and never reaches a store, a list or a response
 * (AUDIT-A1-1: it leaked cross-person through GET /__approvals).
 */
export function principalRef(p: Principal): Principal {
  return { personId: p.personId, via: p.via, actor: p.actor === "human" ? "human" : "process", ...(p.deviceId ? { deviceId: p.deviceId } : {}) };
}
/** A stored principal as the public view: rows written before AUDIT-A1-1 may still hold a sessionId. */
export function publicPrincipal(stored: unknown): Principal {
  if (!stored || typeof stored !== "object") return stored as Principal;
  const { sessionId: _serverOnly, ...rest } = stored as Principal;
  return rest;
}
/**
 * The HTTP view of a body (JSON.stringify replacer). A principal (any object with personId and via) keeps
 * who and how (personId, via, actor) but never its sessionId or deviceId, as /__devices/me shows it; and any
 * B1 session key (`sk1.`) value is dropped wherever it sits. The card binding stays server-side.
 */
export function publicJson(this: unknown, key: string, value: unknown) {
  if ((key === "sessionId" || key === "deviceId") && this && typeof this === "object" && "personId" in this && "via" in this) return undefined;
  return typeof value === "string" && value.startsWith("sk1.") ? undefined : value;
}
/** A response body as its HTTP view (see publicJson). */
export const publicView = <T>(body: T): T => (body === undefined ? body : JSON.parse(JSON.stringify(body, publicJson)));
/** A person acting now (not a program acting for them). */
export const isHuman = (p: Principal) => p.actor === "human";
