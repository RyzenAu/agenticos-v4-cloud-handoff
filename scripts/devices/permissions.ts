import { authorise as canonicalAuthorise } from "../identity/principal";
import type { DevicePolicy } from "./store";
import type { PersonId, TargetDevice } from "./types";

/**
 * Who may do what. One rule set, used by every server route that touches shared or private data.
 *
 *  - business: ONE shared workspace. Both founders, signed in, get full access to all business data:
 *              projects, workspace, receptionist, leads, finance and every memory scope
 *              (owner decisions V5 "one shared memory pool" and V7 "full workspace access for both";
 *              no separate business-data permissions). policy.financeGrants no longer gates anything.
 *  - devices:  control of a device — only its owner. Usman's PC belongs to Usman. A shared cloud computer (owner "shared")
 *              belongs to neither: both founders may control and take it over, each through a control lease.
 *
 * A principal is who the request is *authorised* as (loopback at this PC, a paired session, a
 * Serve-verified Tailscale login, or a companion whose Tailscale login matches), resolved by the one
 * identity contract (scripts/identity/principal.ts). The name picker never authorises anything: if the
 * picked name differs from the authorised person, the principal is limited to shared business
 * data — a name claim can only ever reduce access, never add to it.
 */

/** loopback = at this PC; session = a paired browser; tailnet = a Serve-verified login with no session (Stage B1). */
export type PrincipalVia = "loopback" | "session" | "tailnet" | "companion";
export type Principal = {
  personId: PersonId;
  via: PrincipalVia;
  sessionId?: string;
  deviceId?: string;
  /** Set when the picked display name differs from the authorised person. */
  sharedOnly?: boolean;
  /** The picked display name (personalisation only). */
  displayAs?: PersonId;
};

export type Resource =
  | { kind: "business" }
  | { kind: "memory"; scope: "shared" | PersonId }
  | { kind: "finance"; owner: PersonId }
  | { kind: "device"; device: Pick<TargetDevice, "id" | "owner"> }
  | { kind: "devices-admin"; person: PersonId };

export type Decision = { allowed: true } | { allowed: false; reason: string };

const DENY = (reason: string): Decision => ({ allowed: false, reason });
const ALLOW: Decision = { allowed: true };

const CANONICAL_VIA = { loopback: "loopback-owner", session: "paired-session", tailnet: "tailnet-person", companion: "companion" } as const;

/** Business data goes through the ONE policy (scripts/identity/principal.ts authorise, V7). */
function shared(principal: Principal): Decision {
  const d = canonicalAuthorise({ personId: principal.personId, via: CANONICAL_VIA[principal.via], actor: "process", displayName: principal.personId }, { kind: "business" }, "read");
  return d.ok ? ALLOW : DENY(d.reason);
}

export function authorise(principal: Principal | null, resource: Resource, policy: Pick<DevicePolicy, "financeGrants"> = { financeGrants: [] }): Decision {
  if (!principal) return DENY("Pair this device first.");
  const me = principal.personId;
  switch (resource.kind) {
    case "business":
      return shared(principal);
    case "memory":
      if (resource.scope === "shared") return shared(principal);
      // A mismatched picked name is not a login: it keeps only the shared pool.
      return principal.sharedOnly ? DENY("Sign in as yourself to see every memory scope.") : shared(principal);
    case "finance":
      void policy; // both founders read business finance (V7); grants are kept for compatibility only
      return principal.sharedOnly ? DENY("Sign in as yourself to see finance.") : shared(principal);
    case "device":
      if (principal.sharedOnly) return DENY("Device control needs the owner's own paired device.");
      // A shared cloud computer belongs to the business: both founders may control and take it over (scripts/computers).
      if (resource.device.owner === "shared") return ALLOW;
      return resource.device.owner === me ? ALLOW : DENY(`That device belongs to ${resource.device.owner}.`);
    case "devices-admin":
      // Managing sessions/devices: your own, or anyone's if you are Usman at full rights.
      if (principal.sharedOnly) return DENY("Manage devices from your own paired device.");
      return resource.person === me || me === "usman" ? ALLOW : DENY("You can only manage your own devices.");
  }
}

/** The picked name narrows; it never widens. */
export function withDisplayName(principal: Principal, picked: PersonId | null | undefined): Principal {
  if (!picked || picked === principal.personId) return { ...principal, displayAs: principal.personId };
  return { ...principal, displayAs: picked, sharedOnly: true };
}

/** A readable summary for the profile UI. */
export function permissionSummary(principal: Principal | null, policy: Pick<DevicePolicy, "financeGrants">) {
  if (!principal) return { business: false, memory: [] as string[], finance: false, devices: "none" as const };
  const memory = (["shared", "usman", "mehroz"] as const).filter((scope) => authorise(principal, { kind: "memory", scope }).allowed);
  return {
    business: authorise(principal, { kind: "business" }).allowed,
    memory,
    finance: authorise(principal, { kind: "finance", owner: "usman" }, policy).allowed,
    devices: principal.sharedOnly ? ("none" as const) : ("own" as const),
  };
}
