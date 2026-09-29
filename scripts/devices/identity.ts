import type { IncomingMessage } from "node:http";
import { readPeople, type TailnetSource } from "../remote-access";
import { identifyRequest, parseCookies, SESSION_COOKIE, type Principal as VerifiedPrincipal } from "../identity/principal";
import type { Principal } from "./permissions";
import type { ServePeerCheck } from "../identity/serve-peer";
import type { CompanionRow, DeviceStore, SessionRow } from "./store";
import { normalisePersonId, type PersonId } from "./types";

/**
 * Who is behind a request to /__devices. Since Stage B1 this is a view over the ONE identity
 * contract (scripts/identity/principal.ts resolvePrincipal): loopback owner at this PC, a paired
 * session, a Serve-verified Tailscale login (when that person's Tailscale sign-in is on), or a
 * companion. The Tailscale boundary does not move: remote identity always comes from tailnetPerson()
 * (loopback socket + this PC's tailnet Host + a Serve-stamped login listed in people.json).
 */

export { parseCookies, SESSION_COOKIE };
export const NAME_COOKIE = "mu_name";

export type RequestIdentity = {
  /** Socket is loopback (Tailscale Serve and local browsers both arrive this way). */
  loopbackSocket: boolean;
  /** At this PC: local Host and nothing that says it was relayed from the tailnet. */
  local: boolean;
  /** The Tailscale person, when relayed by Serve for someone in people.json. */
  tailnet: PersonId | null;
  /** The request arrived over HTTPS via Serve (so cookies get `Secure`). */
  secure: boolean;
  session: SessionRow | null;
  principal: Principal | null;
  /** The canonical principal (Stage B1), including its display name. */
  verified: VerifiedPrincipal | null;
  picked: PersonId | null;
};

const LEGACY_VIA = { "loopback-owner": "loopback", "paired-session": "session", "tailnet-person": "tailnet", companion: "companion" } as const;

/**
 * The devices module's own principal shape, derived from the canonical one. Its `sessionId` is the
 * PUBLIC row id the profile UI revokes by; the canonical Principal.sessionId (a server-only key)
 * never enters this module's responses.
 */
export function devicesPrincipal(p: VerifiedPrincipal | null, session: SessionRow | null = null): Principal | null {
  if (!p || p.via === "telegram-owner") return null;
  return { personId: p.personId, via: LEGACY_VIA[p.via], ...(session ? { sessionId: session.id } : {}), ...(p.deviceId ? { deviceId: p.deviceId } : {}) };
}

export type IdentifyOptions = { root: string; store: DeviceStore; tailnetName?: string; servePeer?: ServePeerCheck; tailnet?: TailnetSource };

export function identify(req: IncomingMessage, opts: IdentifyOptions): RequestIdentity {
  const id = identifyRequest(req, opts);
  // A companion token is for /__devices/companion/*; on the browser routes the caller is a browser.
  const verified = id.principal?.via === "companion" ? null : id.principal;
  const picked = normalisePersonId(parseCookies(req.headers.cookie)[NAME_COOKIE]);
  return { loopbackSocket: id.loopbackSocket, local: id.local, tailnet: id.tailnet, secure: id.secure, session: id.session, principal: devicesPrincipal(verified, id.session), verified, picked };
}

/** A companion's bearer token, cross-checked against the Tailscale login it arrived with. */
export function identifyCompanion(
  req: IncomingMessage,
  opts: IdentifyOptions,
): { device: CompanionRow; principal: Principal } | { error: string; status: number } {
  const id = identifyRequest(req, opts);
  if (!id.loopbackSocket) return { error: "Local access only", status: 403 };
  const auth = String(req.headers.authorization ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const device = opts.store.verifyCompanion(token);
  if (!device) return { error: "This companion is not paired, or its pairing expired or was revoked.", status: 401 };
  // Over the tailnet the Serve-stamped login must be the device's owner; at this PC only
  // Usman's own companions may connect (a local process is already Usman's).
  if (id.principal?.via !== "companion" || id.principal.deviceId !== device.id)
    return { error: "This companion's Tailscale login does not match its owner.", status: 403 };
  return { device, principal: { personId: device.owner, via: "companion", deviceId: device.id } };
}

/** People listed in people.json, as person ids (for the name picker). */
export function knownPeople(root: string): { id: PersonId; name: string }[] {
  const seen = new Set<PersonId>();
  const out: { id: PersonId; name: string }[] = [];
  for (const p of readPeople(root)) {
    const id = normalisePersonId(p.name);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, name: p.name });
    }
  }
  if (!out.length) return [{ id: "usman", name: "Usman" }, { id: "mehroz", name: "Mehroz" }];
  return out;
}
