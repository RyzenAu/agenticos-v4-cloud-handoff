// Who may use /__lead-sites, and how a preview link is chosen for them.
//
// Before: the owner at this PC only. Now: the owner at this PC, or a founder the identity layer has verified
// through the trusted Tailscale Serve path (a principal from people.json: paired-session or tailnet-person).
// Everyone else is still refused: no principal 401, a companion or a Telegram relay 403.
//
// Deploy and take-down publish to the public web from this PC's own Vercel login, so they stay with the owner
// at this PC (a remote founder asks for them there), exactly as before.
import { isBrowserPrincipal, type IdentityContext, type Principal, type ReqLike } from "../identity/principal";
import { pageTokenMatches, requestAtHub, requestPrincipal } from "../identity/gate";
import { safeEqual } from "../identity/principal";
import { PREVIEW_PORT, localPreviewUrl } from "./preview-server";
import { previewOriginPort, remotePreviewUrl } from "./preview-origin";

export type LeadSitesCaller = { principal: Principal; atPc: boolean };
export type LeadSitesAccess = { ok: true; caller: LeadSitesCaller } | { ok: false; status: 401 | 403; error: string };

const SIGN_IN = "Sign in first: use Agentic OS at this PC, or open it through your own Tailscale address.";
const OWNER_ONLY = "Deploying or taking down a preview publishes from this PC, so it can only be done here.";

/** Resolves the caller of a /__lead-sites request. Reads (and generate / thumbnail) need any verified founder. */
export function leadSitesCaller(req: ReqLike, ctx?: Partial<IdentityContext>): LeadSitesAccess {
  const principal = requestPrincipal(req, ctx);
  if (!principal) return { ok: false, status: 401, error: SIGN_IN };
  if (!isBrowserPrincipal(principal)) return { ok: false, status: 403, error: "Previews are for a founder signed in at a browser." };
  return { ok: true, caller: { principal, atPc: principal.via === "loopback-owner" } };
}

/** The routes that publish from this PC: owner at the PC only. */
export function needsOwnerAtPc(pathname: string): boolean {
  return pathname === "/deploy" || pathname === "/takedown";
}
export const OWNER_AT_PC_ONLY = OWNER_ONLY;

/**
 * The CSRF check for a write: the caller's OWN page token (the internal token at this PC; a person-bound one over
 * Serve). Under MU_HUB_ROLE=server the gate swaps an admitted founder's own token for the internal one before
 * handlers run, so the internal token is accepted from a founder ONLY when `admitted` (requestAtHub(req): true
 * for a founder solely through the gate's own grant, false in every other role). A raw internal token from a
 * remote caller the gate did not admit is still refused.
 */
export function writeTokenOk(caller: LeadSitesCaller, presented: unknown, internal: string, admitted = false): boolean {
  if (pageTokenMatches(caller.principal, presented, internal)) return true;
  return admitted && !caller.atPc && typeof presented === "string" && !!internal && safeEqual(presented, internal);
}
/** Did the identity gate itself admit this (remote) founder to this route? Works with or without the server-role gate. */
export function gateAdmitted(req: Parameters<typeof requestAtHub>[0], root: string): boolean {
  return requestAtHub(req, { root });
}

/** The Origin a write from this caller's page must carry: http on this PC's loopback, https through Serve. */
export function expectedOrigin(caller: LeadSitesCaller, host: string): string {
  return `${caller.atPc ? "http" : "https"}://${host}`;
}

/** A remote founder's `by` is the person the identity layer verified, never a body field; the owner at the PC keeps choosing. */
export function actingFounder(caller: LeadSitesCaller, bodyBy: string): string {
  return caller.atPc ? bodyBy : caller.principal.personId;
}

/**
 * Where a preview opens, derived from HOW the page was reached: the loopback origin (`<name>.localhost:<port>`)
 * for the owner at the hub's own PC, the hub's authenticated preview origin for anyone arriving over Serve.
 * Null when a remote caller's Host isn't a tailnet name (nothing sensible to point at).
 */
export function previewLinkFor(
  caller: LeadSitesCaller,
  host: string | undefined,
  name: string,
  ports: { local?: number; remote?: number } = {},
): string | null {
  if (caller.atPc) return localPreviewUrl(name, ports.local ?? PREVIEW_PORT);
  return remotePreviewUrl(host, name, ports.remote ?? previewOriginPort());
}
