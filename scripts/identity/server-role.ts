import type { IncomingMessage } from "node:http";
import { routeRule } from "./routes";

/**
 * MU_HUB_ROLE=server: who may use the routes that routes.ts marks "local-owner" on a headless hub that nobody
 * sits at (scripts/cloud/hub-role.ts). Everything here is inert in the `pc` and `cloud` roles.
 *
 * The rule, in one place:
 *
 *   A local-owner route is open to a founder when ALL of these hold:
 *     1. the request really arrived through Tailscale Serve as that founder. That is whatever identity.ts /
 *        remote-access.ts / serve-peer.ts already verified (peer is tailscaled, this hub's tailnet Host, a
 *        Serve-stamped login listed in people.json, a source that is another node); this file never repeats
 *        or loosens it, it only reads the principal the gate already derived;
 *     2. that founder holds a CONFIRMED HUMAN SESSION: the principal is `paired-session` with actor `human`
 *        (a live, signed, non-pending mu_session cookie for that same person). A bare Tailscale login
 *        (`tailnet-person`, a process: a script on the founder's machine) does not qualify, for reads or
 *        writes, because these routes spawn agents and shells and read transcripts. This is the same proof
 *        the codebase already asks of session and device administration (devices/service.ts ADMIN_WRITES);
 *     3. the route is not in CONSOLE_ONLY below.
 *
 *   Companion/device bearer tokens, computers-bridge clients and the Hermes relay bearer are never browser
 *   principals, so they never reach this decision: the gate refuses them first, in every role.
 *
 * The loopback owner (a local program or the owner's browser at the hub) keeps today's access in every role,
 * console-only routes included.
 */

/**
 * CONSOLE-ONLY: stay loopback-only (the hub's own console) even in the server role. Each is something that
 * sets or removes provider keys, rewrites the hub's own tool configuration, restarts or updates hub software,
 * or is an internal bridge that only local programs call. A prefix matches itself and "/", "." sub-paths
 * (connect's rule), like routes.ts.
 */
export const CONSOLE_ONLY: Readonly<Record<string, string>> = {
  "/__design_set_key": "sets a provider key",
  "/__design_remove_key": "removes a provider key",
  "/__ccr_pin_routes": "rewrites claude-code-router config and restarts it",
  "/__dev_restart": "restarts the hub's dev server",
  "/__start_voice": "writes OPENAI_API_KEY into ~/.hermes/.env and respawns voice-lab (also a desktop voice route)",
  "/__hermes_cmd": "runs arbitrary hermes commands, including update --yes",
  "/__hermes_effort": "rewrites ~/.hermes/config.yaml",
  "/__hermes_moa_save": "rewrites ~/.hermes/config.yaml",
  // Added by judgement (same test: keys, tool configuration, hub software):
  "/__design_higgsfield_account": "disconnect wipes the hub's Higgsfield OAuth tokens (a provider credential); reads stay shared",
  "/__hermes_pantheon/install": "writes the hub's Hermes persona YAML (tool configuration)",
  "/__hermes_pantheon/create": "writes the hub's Hermes persona YAML (tool configuration)",
  "/__hermes_skill_sync": "copies skills into the hub's Hermes install (tool configuration)",
  "/__set_dream_engine": "changes the hub's Dream engine configuration",
  "/__ai_usage/settings": "changes hub usage settings",
  "/__claude": "Claude subscription bridge for Hermes: an internal service that only local programs call (its handler answers loopback-owner only)",
  "/__cline": "Cline bridge for Hermes: an internal service that only local programs call (its handler answers loopback-owner only)",
  "/__jev": "Jev approval guardian for Hermes: an internal service that only local programs call (its handler answers loopback-owner only)",
  // Publishing / outward actions that are NOT yet wired to a B2 approval stay console-only (fail closed). Lead sites'
  // deploy and take-down and the Design studio's social posting ARE wired (APPROVAL_GATED below), so they are open to a
  // confirmed founder.
};

/**
 * THE THREE CATEGORIES in the server role (one place, so the next route has an obvious home):
 *
 *   1. PERSONAL DESKTOP CONTROL: the hub is nobody's desktop. windows-control, agent-browser and local-voice-stack answer
 *      501 "needs the companion" to every caller (scripts/cloud/hub-role.ts); a founder's "here" goes to his OWN
 *      companion or fails honestly. Never executed on the hub, never on the other founder's device.
 *   2. SERVER-SIDE WORK: the hub's shared CLIs, bridges and tools (Claude, Codex, Hermes, Cline, studio, graphs, ...).
 *      Open to a founder with a CONFIRMED human session, except the console-only set (keys, tool configuration,
 *      software, restarts) and every unclassified route.
 *   3. PUBLISHING / OUTWARD ACTIONS: confirmed founder session AND a B2 approval (ask, decide per B2's rules, run once).
 *      See APPROVAL_GATED. Anything outward that has no approval wiring yet is console-only until it does.
 */
export const SERVER_ROLE_CATEGORIES = {
  "personal-desktop-control": "501 for every caller; the requester's own companion or an honest failure",
  "server-side-work": "confirmed founder session",
  "publishing-outward": "confirmed founder session + B2 approval",
} as const;

/**
 * Category 3, wired: open at the gate to a confirmed founder, and the route itself will not act without an approved,
 * unconsumed B2 approval bound to what would go out (lead previews: scripts/lead-sites/publish-approval.ts; Design posts:
 * scripts/design-publish.ts; both on scripts/approvals/gated-action.ts). In the server role this holds for EVERY caller,
 * the owner at the console included. The B2 actions are content.publish / content.unpublish.
 */
export const APPROVAL_GATED: Readonly<Record<string, string>> = {
  "/__lead-sites/deploy": "publishes a lead preview to the public internet (B2: content.publish)",
  "/__lead-sites/takedown": "removes a published lead preview from the public internet (B2: content.unpublish)",
  "/__design_publish": "posts a carousel to social platforms through Blotato (B2: content.publish, bound to the caption, the slide bytes and the target accounts)",
};

/**
 * CONSOLE-ONLY FOR WRITES: reads stay open to a confirmed founder; any other method (PUT, DELETE, POST...) is loopback-only.
 * Persona YAML is the hub's own Hermes tool configuration, so editing or deleting one is the same class as install/create.
 */
export const CONSOLE_ONLY_WRITES: Readonly<Record<string, string>> = {
  "/__hermes_pantheon": "edits or deletes a persona YAML (the hub's Hermes tool configuration); install and create are console-only for every method",
  "/__hermes_pantheon_sync": "writes the hub's persona mirror (tool configuration)",
  "/__hermes_pantheon_templates": "writes the hub's persona templates (tool configuration)",
};

/**
 * Console-only is a GUARD RAIL, not a boundary. Founders can run Claude, Hermes and Codex on the server by design
 * ("full access for both"), and those agents can do anything the service account can. A stolen confirmed founder
 * session therefore means control of the server. The set keeps accidents, stray clicks and a stray script out of keys
 * and hub configuration; it does not contain a hostile session.
 */

/**
 * BORDERLINE, left OPEN in the server role (a founder with a human session may use them), and why:
 *   /__hermes_chat, /__claude_chat   the point of the server: run the hub's Claude/Hermes for the shared workspace
 *   /__hermes_missions*              missions are shared work; they run inside Hermes, they do not edit its config
 *   /__hermes_documents              restore / permanent-trash of hub documents is shared business housekeeping
 *   /__hermes_image_upload           writes an upload for Hermes, no configuration
 *   /__hermes_pantheon (reads, validate, templates, sync)   persona reading and validating; only install/create write
 *   /__design_generate, /__design_author   the founders' studio work (spends credit);
 *                                    credit spend is already visible in receipts and no cap exists by owner decision
 *                                    (/__design_publish is NOT here: it is APPROVAL_GATED above)
 *   /__graphify_ingest, /__graphify_remove   graph any hub path / delete hub graph files: broad, but shared work
 *   /__trigger_dream                 runs a Dream cycle
 *   /__mcp_approvals, /__permission_decision, /__question_answer   a founder approving tool use in hub sessions
 *   /__refresh_data                  machine scan of the hub
 *   /__lead-sites, /__websites, /__site-draft, /__seo-audit-files, /__website-os/connect, /__motion   the business's own site tooling
 */

/**
 * OWNER-PRIVATE DATA (criterion 4). These routes serve the hub owner's own Claude transcripts and files, Hermes
 * SOUL/MEMORY/USER and sessions, and every Obsidian vault on the hub (the personal vault included). The standing
 * owner decision is "one shared workspace, separate logins, full access for both, no data-permission split", so
 * in the server role they are OPEN to both founders.
 *
 * TO REVERSE THAT CHOICE, change the next line to `false`: the eight routes then join the console-only set
 * (loopback only) and nothing else changes.
 */
export const OWNER_PRIVATE_OPEN_TO_BOTH_FOUNDERS = true;

export const OWNER_PRIVATE_ROUTES: Readonly<Record<string, string>> = {
  "/__claude_chats": "the owner's Claude session list",
  "/__claude_session": "the owner's Claude transcripts",
  "/__claude_file": "files from the owner's Claude sessions",
  "/__hermes_memory": "the owner's Hermes SOUL, MEMORY and USER",
  "/__hermes_owner_profile": "the owner's profile in Hermes' USER.md (POST rewrites it)",
  "/__hermes_sessions": "the owner's Hermes sessions",
  "/__hermes_session": "one of the owner's Hermes sessions",
  "/__memory_note": "reads every Obsidian vault on the hub, including the personal vault",
};

/** Connect's own prefix rule: case-insensitive, then "/", "." or the end. */
function under(path: string, prefix: string) {
  const p = path.toLowerCase();
  const q = prefix.toLowerCase().replace(/\/+$/, "");
  if (!p.startsWith(q)) return false;
  const next = p.charAt(q.length);
  return next === "" || next === "/" || next === ".";
}

/** The console-only entry a path falls under (longest wins), with why; null when a founder may use it. */
export function consoleOnlyRule(path: string, ownerPrivateOpen: boolean = OWNER_PRIVATE_OPEN_TO_BOTH_FOUNDERS, method: string = "GET"): { key: string; why: string } | null {
  const write = method !== "GET" && method !== "HEAD";
  const all: Array<[string, string]> = [...Object.entries(CONSOLE_ONLY), ...(write ? Object.entries(CONSOLE_ONLY_WRITES) : []), ...(ownerPrivateOpen ? [] : Object.entries(OWNER_PRIVATE_ROUTES))];
  let best: [string, string] | null = null;
  for (const entry of all) if (under(path, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best ? { key: best[0], why: best[1] } : null;
}

export type ServerRoleDecision = { ok: true } | { ok: false; reason: "console-only" | "needs-human-session"; key?: string };

/**
 * The decision for a request the gate already knows is a local-owner route and NOT the loopback owner.
 * `id` is the gate's own RequestIdentity; nothing is re-derived here.
 */
export function serverRoleDecision(
  path: string,
  id: { principal: { via: string; actor: string; personId: string } | null; tailnet: string | null; sessionCookie: string; session: { pending?: boolean } | null },
  method: string = "GET",
): ServerRoleDecision {
  // Deny by default survives: a /__* path that routes.ts does not classify (Vite's own /__open-in-editor, a route
  // added and not yet classified) is local-owner AND console-only here, so a founder never reaches it.
  if (routeRule(path).key === null) return { ok: false, reason: "console-only" };
  const closed = consoleOnlyRule(path, undefined, method);
  if (closed) return { ok: false, reason: "console-only", key: closed.key };
  const p = id.principal;
  const confirmedHuman =
    !!p && p.via === "paired-session" && p.actor === "human" && id.tailnet === p.personId && id.sessionCookie === "valid" && !!id.session && !id.session.pending;
  return confirmedHuman ? { ok: true } : { ok: false, reason: "needs-human-session" };
}

/**
 * Requests the gate admitted to a local-owner route under the server role. Inline hub-only guards in the route
 * handlers (requestAtHub, refuseUnlessAtThisPc, motion's isLocalRequest) honour it, so one decision at the gate
 * is the whole decision. A WeakSet keyed by the request object: it cannot be set from headers, a body or a
 * cookie, only by the gate, and it dies with the request.
 */
const granted = new WeakSet<object>();
export function grantServerFounder(req: object) {
  granted.add(req);
}
export function isServerFounderGrant(req: IncomingMessage | object): boolean {
  return granted.has(req);
}
