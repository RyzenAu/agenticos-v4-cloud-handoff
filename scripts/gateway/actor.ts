/**
 * The Dot gateway's collaborator as other hub modules may recognise it. Dependency-free on purpose: the job store, the CRM
 * operations, the computers permissions and the device resolver import this and nothing else from the gateway.
 *
 * A gateway principal exists ONLY when the identity gate verified a signed, single-use assertion on a loopback socket
 * (scripts/gateway/hub.ts): person "dot", via "gateway", a PROCESS actor. It is never a founder, never the owner at the hub,
 * never a human session, so every founder check (`isPersonId`, B2's `isPrincipal`, `isHumanSession`, `hasVerifiedUiSession`)
 * stays false for it. The helpers below let a module that deliberately serves Dot say so in one exact place.
 */

/** The one external collaborator the gateway serves. Never a founder (scripts/devices/types.ts PERSON_IDS). */
export const GATEWAY_PERSON = "dot";
export const GATEWAY_VIA = "gateway";

export type GatewayActor = {
  personId: typeof GATEWAY_PERSON;
  via: typeof GATEWAY_VIA;
  actor: "process";
  /** "gw:<the gateway session's public id>". Never a cookie or token. */
  sessionId?: string;
  /** What the verified assertion carried (scripts/gateway/policy.ts CAPABILITIES). Absent on a STORED principal. */
  capabilities?: readonly string[];
  delegatedBy?: string;
};

/** Exactly the gateway collaborator: all three of person, via and actor. Anything else (a founder, a routine, a look-alike) is false. */
export function isGatewayActor(value: unknown): value is GatewayActor {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (p.personId !== GATEWAY_PERSON || p.via !== GATEWAY_VIA || p.actor !== "process") return false;
  for (const k of ["sessionId", "deviceId", "displayName"] as const) if (p[k] !== undefined && (typeof p[k] !== "string" || (p[k] as string).length > 200)) return false;
  return true;
}

/** Does this request's gateway principal hold the capability right now (as the verified assertion said)? False for everyone else. */
export function gatewayHolds(value: unknown, capability: string): boolean {
  return isGatewayActor(value) && Array.isArray(value.capabilities) && value.capabilities.includes(capability);
}

/** What a store keeps for a job or a record Dot made: who and how, never the session or the capability list. */
export const gatewayActorRef = (): GatewayActor => ({ personId: GATEWAY_PERSON, via: GATEWAY_VIA, actor: "process" });

/** The stable provenance label for records Dot makes through the gateway (CRM attribution, memory, file writes). */
export const gatewayProvenance = (principal: { sessionId?: string }) => ({ agent: GATEWAY_PERSON, jobId: String(principal.sessionId ?? "gw").slice(0, 80) });
