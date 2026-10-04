/**
 * The "only at this PC" sites inside the SHARED /__operator mount (scripts/operator-plugin.ts and the modules it calls),
 * classified once, for the server role (MU_HUB_ROLE=server).
 *
 * operator-plugin computes `remote` (the caller is not the owner at the hub) and used it for two different things:
 * (a) DEVICE routing: a remote founder's device actions go to his OWN device (deviceDenied, resolveTarget): correct, kept
 *     as it is; and
 * (b) "only at this PC" permission refusals for SERVER-SIDE WORK, which on a headless server nobody could ever satisfy.
 * In the server role every such site is exactly one class:
 *
 *   device   personal desktop / the hub's screen, mic or OS apps: keeps the `remote` semantics (the requester's own
 *            companion, or an honest refusal). Never lifted.
 *   work     server-side work: allowed for a confirmed HUMAN founder session (serverWorkAllowed, the proof the gate asks
 *            for local-owner routes); a pending session, a bare Tailscale login or a program is refused with a clear
 *            line. `by` is always the verified signer.
 *   publish  outward / irreversible: confirmed session + a B2 approval where B2 has a kind for it. No /__operator site is
 *            outward today; lead-site deploy and take-down are the B2-gated ones (server-role.ts APPROVAL_GATED).
 *   console  hub configuration that stays at the server's console: keys and sign-ins, installed software.
 *
 * pc and cloud never consult any of this: outside the server role nothing here is asked and `remote` behaves as before.
 */

export type OperatorSiteClass = "device" | "work" | "publish" | "console";
export type OperatorSite = {
  id: string;
  /** Where it lives. */
  where: string;
  what: string;
  class: OperatorSiteClass;
  /** pc and cloud (unchanged) */
  before: string;
  /** server role */
  after: string;
  /** The B2 kind used, or why none applies. */
  b2?: string;
  /** Enforced centrally for founders: method + path under /__operator. Device sites enforce themselves with `remote`. */
  match?: (method: string, path: string) => boolean;
  /** A sample request per site (method, path) for the table-driven tests and the docs. */
  sample: [string, string];
};

const post = (re: RegExp) => (method: string, path: string) => method === "POST" && re.test(path);
const any = (re: RegExp) => (_method: string, path: string) => re.test(path);
const ONLY_AT_PC = 'refused to a remote caller ("only at this PC")';
const WORK_AFTER = 'confirmed human founder session; otherwise a clear "needs a confirmed browser session" line';
const DEVICE_AFTER = "unchanged: the requester's own companion, or an honest refusal";

export const OPERATOR_SITES: readonly OperatorSite[] = [
  // ── console: keys, sign-ins, installed software ────────────────────────────────────────────────────────────────
  {
    id: "connector-credentials", where: "operator-plugin HUB_CONNECTOR_WRITE", class: "console", sample: ["POST", "/connections/disconnect"],
    what: "connect, configure or disconnect the hub's Google/Outlook/Cal.com/Slack/Skool sign-ins; Notion and Granola config",
    before: ONLY_AT_PC, after: "console only (the hub's own credentials)",
    match: post(/^\/(?:connections\/(?:configure|start|disconnect|skool\/connect)|memory\/(?:notion|granola)-config)$/),
  },
  {
    id: "skill-approve", where: "meeting-mode/narrate-api skillDraftsRoute", class: "console", sample: ["POST", "/skill-drafts/abc/approve"],
    what: "approve a skill draft (installs a SKILL.md into the hub's Claude and Hermes skills folders)",
    before: ONLY_AT_PC, after: "console only (installed software)",
    match: post(/^\/skill-drafts\/[^/]+\/approve$/),
  },
  // ── work: server-side work ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: "connector-syncs", where: "operator-plugin HUB_CONNECTOR_WRITE", class: "work", sample: ["POST", "/memory/apps/sync-all"],
    what: "forced connector syncs, imports, the model-catalogue check, setup connection checks, mail-archive sync",
    before: ONLY_AT_PC, after: WORK_AFTER,
    match: post(/^\/(?:setup\/connections\/check|models\/refresh|memory\/apps\/(?:sync-all|refresh-settings|[a-z]+\/sync|[a-z]+)|memory\/import-(?:local|notion)|mail-archive\/(?:sync|pause|provider-search))$/),
  },
  {
    id: "apps-refresh", where: "operator-plugin /memory/apps", class: "work", sample: ["GET", "/memory/apps"],
    what: "rescan the hub's connected apps (?refresh=1)", before: "the refresh flag is ignored for a remote caller", after: WORK_AFTER,
    match: (method, path) => method === "GET" && path === "/memory/apps",
  },
  {
    id: "skill-drafts", where: "meeting-mode/narrate-api skillDraftsRoute", class: "work", sample: ["GET", "/skill-drafts"],
    what: "list, read, edit, discard and delete skill drafts (they can hold what a founder said)", before: ONLY_AT_PC, after: WORK_AFTER,
    match: (_method, path) => /^\/skill-drafts(?:\/|$)/.test(path) && !/\/approve$/.test(path),
  },
  {
    id: "agent-jobs", where: "agent-jobs-route", class: "work", sample: ["GET", "/agent-jobs"],
    what: "delegated Claude/Codex agent jobs on the server's own logins (the local-cli-agents group)",
    before: "refused on every path to any remote or relayed caller", after: WORK_AFTER,
    b2: "none: a job only ever drafts; coding applies already go through B2 (scripts/coding)",
    match: any(/^\/agent-jobs(?:\/|$)/),
  },
  {
    id: "model-router", where: "model-router/api", class: "work", sample: ["POST", "/model-router/probe"],
    what: "System > Models catalogue, health and the zero-cost provider probe (outbound list reads with the hub's keys)",
    before: "the probe is refused to a remote caller", after: WORK_AFTER, match: any(/^\/model-router(?:\/|$)/),
  },
  {
    id: "model-fleet-receipts", where: "model-fleet/receipt-sink", class: "work", sample: ["GET", "/model-fleet/receipts"],
    what: "read the Cline/fleet model usage receipts", before: "refused to a remote caller", after: WORK_AFTER, match: any(/^\/model-fleet\/receipts$/),
  },
  {
    id: "jarvis-settings", where: "operator-plugin /jarvis/settings", class: "work", sample: ["POST", "/jarvis/settings"],
    what: "who can reach Jarvis, his shorthand and greeting", before: ONLY_AT_PC, after: WORK_AFTER, match: post(/^\/jarvis\/settings$/),
  },
  {
    id: "jarvis-alerts", where: "operator-plugin /jarvis/*", class: "work", sample: ["POST", "/jarvis/quiet"],
    what: "Jarvis alerts, quiet mode, protocols", before: ONLY_AT_PC, after: WORK_AFTER,
    match: post(/^\/jarvis\/(?:events|events\/claim|quiet|protocol|protocol\/step)$/),
  },
  {
    id: "inbox-triage", where: "inbox-triage/service", class: "work", sample: ["GET", "/inbox/triage"],
    what: "the inbox triage overview, digest, alerts and settings", before: ONLY_AT_PC, after: WORK_AFTER, match: any(/^\/inbox\/triage(?:\/|$)/),
  },
  {
    id: "leads-find", where: "leads/api find()", class: "work", sample: ["POST", "/leads/find"],
    what: "Find leads (OpenStreetMap, or Google Places within the fixed monthly allowance of detail lookups)",
    before: "LocalOnly when remote (spends paid lookups and shares the OSM slot)",
    after: `${WORK_AFTER}; the fixed Google Places monthly allowance (MONTHLY_DETAILS_BUDGET) and rate limits still apply; by = the signer`,
    b2: "none: B2 has no kind for lookups; Google spend stays bounded by the fixed Places allowance", match: post(/^\/leads\/find$/),
  },
  {
    id: "leads-seo-audit", where: "leads/api seoAudit()", class: "work", sample: ["POST", "/leads/seo-audit"],
    what: "SEO audit of a lead's site", before: "LocalOnly when remote", after: `${WORK_AFTER}; by = the signer`, match: post(/^\/leads\/seo-audit$/),
  },
  {
    id: "triggers", where: "triggers/service handle()", class: "work", sample: ["POST", "/triggers/pause"],
    what: "pause, resume, disable and retry automation triggers", before: "refused to a remote caller", after: WORK_AFTER,
    match: (method, path) => method === "POST" && /^\/triggers\//.test(path),
  },
  {
    id: "automations", where: "operator-plugin /automations/*", class: "work", sample: ["POST", "/automations/run"],
    what: "run now, pause and resume Hermes cron automations", before: ONLY_AT_PC, after: WORK_AFTER, match: post(/^\/automations\/(?:run|pause|resume)$/),
  },
  // ── device: personal desktop, the hub's screen, mic and OS apps (kept exactly as they are) ───────────────────────
  { id: "connector-os-apps", where: "operator-plugin HUB_CONNECTOR_WRITE", class: "device", sample: ["POST", "/setup/open-privacy"], what: "the OS privacy pane, native calendar and connection syncs", before: ONLY_AT_PC, after: DEVICE_AFTER },
  { id: "open-url-browser-screen", where: "operator-plugin /open-url, /browser/act, /screen/act, /control/approval, /hermes/task", class: "device", sample: ["POST", "/screen/act"], what: "open a link, drive Chrome or the screen, approve a control task", before: "deviceDenied: the requester's own device, or refused", after: `${DEVICE_AFTER} (also 501 on the server: scripts/cloud/hub-role.ts)` },
  { id: "lessons", where: "screen-hands/routes lessonRoute", class: "device", sample: ["POST", "/screen/lesson"], what: "Jarvis lessons, overlay, pointer and courses on the screen", before: "refused to a remote caller", after: "refused for EVERY caller, the owner at the console included (the server has no desktop)" },
  { id: "away-mode", where: "away-mode/service awayRoute", class: "device", sample: ["POST", "/away"], what: "away mode on/off/stop/queue a task (it drives the PC's screen, windows and apps; also reached by voice and Telegram /task through /__away/telegram)", before: "owner role only when remote", after: "refused for EVERY caller (501 on the OS card, the same line by voice and Telegram): \"Away mode drives a desktop; on the server use your own PC's companion.\" The runner never ticks and a carried-over armed state is disarmed at start" },
  { id: "narrate", where: "operator-plugin /narrate/*", class: "device", sample: ["POST", "/narrate/start"], what: "Narrate my workflow (the PC's microphone)", before: ONLY_AT_PC, after: DEVICE_AFTER },
  { id: "control-audit-receipts", where: "operator-plugin /control/audit, jarvis-execution/routes", class: "device", sample: ["POST", "/control/audit"], what: "the control_pc audit log, execution receipts, quarantine and questions", before: ONLY_AT_PC, after: DEVICE_AFTER },
  { id: "jarvis-skill", where: "jarvis-skills/index run()", class: "device", sample: ["POST", "/jarvis/skill"], what: "voice skills: clipboard, typing, windows (a remote caller gets the pure answers only)", before: "REMOTE_SAFE skills only for a remote caller", after: "REMOTE_SAFE (pure answers) only for EVERY caller, the owner at the console included" },
  { id: "jarvis-events-read", where: "operator-plugin /jarvis/events GET", class: "device", sample: ["GET", "/jarvis/events"], what: "interjections the hub's own speakers claimed (local: !remote)", before: "local flag false for a remote caller", after: DEVICE_AFTER },
  { id: "meetings-voice", where: "operator-plugin /meeting/*, /voice/free/*", class: "device", sample: ["POST", "/voice/free/configure"], what: "meeting mode and the voice stack (the hub's mic and speakers)", before: "device rules (deviceDenied)", after: DEVICE_AFTER },
  { id: "quick-actions", where: "quick-actions.ts", class: "device", sample: ["POST", "/quick-actions/log"], what: "pins and run log (shared); the receptionist report that opens on the PC", before: "shared; the report opens on the PC only", after: "unchanged (the log's by is the signer)" },
];

/** The central decision class for a /__operator path, or null (no site, or a device site that enforces itself). */
export function operatorSiteClass(method: string, path: string): OperatorSiteClass | null {
  for (const site of OPERATOR_SITES) if (site.match?.(method, path)) return site.class;
  return null;
}

/**
 * Other plugins checked for the same pattern (nothing to change): site-draft, websites (read-only), lead-sites, seo-audit-files
 * and Motion call refuseUnlessAtThisPc / isLocalRequest, which honour the gate's admission of a confirmed founder; the design
 * routes use the same isAtHub guards (vite.config.ts) and so follow the gate; control receipts and jarvis skills are device
 * sites above. Left as they are on purpose: the per-person conversation scope (conversations.list({ hub: isAtHub })), which
 * decides whose chats a listing shows, not who may do work.
 */
export const SERVER_WORK_NEEDS_SESSION = "That runs on the server and needs a confirmed browser session: pair this browser first (System › Devices and people), then try again.";
export const SERVER_CONSOLE_ONLY_LINE = "That changes the server's own keys, sign-ins or installed software, so it can only be done at the server itself.";

/**
 * ONE helper for "may this caller do server-side work": the server role AND a confirmed human founder session (the same
 * proof the identity gate asks for local-owner routes: a live, signed, non-pending session through the trusted Serve
 * path, principal paired-session with actor human). False in every other role, so pc and cloud keep `remote` as it was.
 */
export function serverWorkAllowed(principal: { via: string; actor?: string } | null | undefined, role: string): boolean {
  return role === "server" && !!principal && principal.via === "paired-session" && principal.actor === "human";
}

/**
 * The central refusal for a REMOTE caller (not the owner at the hub) on a classified site, or null. Server role only: in
 * any other role this returns null and the sites' own `remote` checks decide exactly as before.
 */
export function operatorRemoteRefusal(role: string, method: string, path: string, serverWork: boolean): { status: 403; error: string } | null {
  if (role !== "server") return null;
  const cls = operatorSiteClass(method, path);
  if (cls === "console") return { status: 403, error: SERVER_CONSOLE_ONLY_LINE };
  if ((cls === "work" || cls === "publish") && !serverWork) return { status: 403, error: SERVER_WORK_NEEDS_SESSION };
  return null;
}
