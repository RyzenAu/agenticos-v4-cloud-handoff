/**
 * Every /__* mount, classified (Stage B1 fix round, REVIEW-B1 B1-1/B1-2). The identity gate enforces
 * this table before any route runs. The settled principle (V7):
 *
 *   shared      Shared business data and work: any verified founder (the owner at this PC, or a
 *               founder signed in through Tailscale). Routes under it may still refuse device
 *               actions per request (/__operator resolves those through resolveTarget).
 *   local-owner The hub's own device: anything that spawns processes, agents or shells, approves
 *               tool use, reads or writes the hub's configuration and keys, or reads the owner's
 *               private hub data (transcripts, vaults, Hermes memory). Only the owner at this PC
 *               (loopback-owner). A remote founder's device commands go to his OWN device (the
 *               companion, Stage H), never here.
 *   self        Authenticates its callers with a stronger proof of its own (/__devices pairing and
 *               companion bearer tokens; the Hermes gateway bearer on /__away).
 *
 * DENY BY DEFAULT: a path that matches no entry is local-owner. `read` covers GET and HEAD; `write`
 * covers every other method. docs/IDENTITY-ROUTES.md is the human-readable copy, and
 * scripts/identity/routes.test.ts fails when a mounted route is missing from either.
 */

export type RouteClass = "shared" | "local-owner" | "self";
export type RouteRule = {
  read: RouteClass;
  write: RouteClass;
  why: string;
  /** Registered by a branch not merged yet; the route scan will find it once it lands. */
  expectedFrom?: string;
  /** A path inside another mount (that mount's handler serves it); the longer entry wins. */
  within?: string;
};

const SHARED = (why: string): RouteRule => ({ read: "shared", write: "shared", why });
const LOCAL = (why: string): RouteRule => ({ read: "local-owner", write: "local-owner", why });
const READ_SHARED = (why: string): RouteRule => ({ read: "shared", write: "local-owner", why });

export const ROUTES: Record<string, RouteRule> = {
  // ── self-authenticated ────────────────────────────────────────────────────────────────────
  "/__devices": { read: "self", write: "self", why: "pairing, sessions, companion bearer tokens (own proofs)" },
  "/__away": { read: "self", write: "self", why: "the Hermes gateway's relay bearer" },

  // ── shared business (both founders) ───────────────────────────────────────────────────────
  "/__operator": SHARED("the OS's business API; device actions inside it resolve through resolveTarget"),
  // C1: delegated agents run Claude and Codex on the hub's own logins, reads included (CODING-HARNESS C1 (a)).
  "/__operator/agent-jobs": { ...LOCAL("delegated Claude/Codex agents on the hub's own logins (C1)"), within: "/__operator" },
  // Stage E: System > Models reads the catalogue, health and receipt totals (metadata only); the probe
  // makes outbound list reads with the hub's own keys, so only the owner at this PC may run it.
  // Track 3 (owner decisions 4 and 5): coding jobs are shared work. Both founders, signed in, draft, start,
  // follow, stop and resume jobs on the shared connected accounts (requester recorded). Merges and pushes
  // are only ASKED here; B2 accepts the owner's spoken yes or Telegram code, never a click.
  "/__operator/coding": { ...SHARED("coding jobs: plan, progress, changes, tests, review; apply steps go through B2"), within: "/__operator" },
  "/__operator/model-router": { ...READ_SHARED("System > Models: catalogue, health and receipt totals (metadata only)"), within: "/__operator" },
  "/__operator/model-router/probe": { ...LOCAL("zero-cost provider list reads with the hub's own keys"), within: "/__operator" },
  "/__receptionist": SHARED("receptionist status, dashboard, sign-offs"),
  "/__workspace": SHARED("the Workspace page (read-only)"),
  "/__memory": SHARED("the shared memory pool"),
  "/__finance_manual": SHARED("business finance (NAB CSV)"),
  // B2 (scripts/jobs/plugin.ts, a regex-matched middleware): ONE job and approval history for both
  // founders. Writes (cancel, release, card, decide) are shared at the gate; B2's own principal rules
  // (approver/requester, human session, device) decide each one.
  // Agent F (scripts/computers/routes.ts): shared agent cloud computers. Shared at the gate (both founders, signed in); the routes then
  // require a PERSON (confirmed session or paired device) for lifecycle, takeover and input, and route every command through resolveTarget.
  "/__computers": SHARED("shared agent cloud computers: list, provision, run agent jobs, take over through a control lease; viewer only behind this auth"),
  // Agents workspace (scripts/agents/routes.ts): bots, their live readiness, tasks, files and conversations are shared reads for both founders.
  // PATCH (what a bot is set up to do) is server-side work: at the gate it is the hub owner's, which in the server role means a founder with a
  // CONFIRMED HUMAN session (or the owner at the hub itself); the route checks the same proof again and the caller's page token.
  "/__agents": READ_SHARED("the Agents workspace: bots with live readiness, their tasks, files and conversations; PATCH sets up what a bot does"),
  // CRM (scripts/crm/plugin.ts): companies, contacts, deals, tasks, projects and typed operations. Reads are for a verified founder. A write is the
  // hub owner's: at the gate that is the owner at this PC or, in the server role, a founder with a CONFIRMED HUMAN session; the route checks the same
  // proof again plus the caller's own page token. A bare tailnet login, a routine principal and a gateway principal never write.
  "/__crm": READ_SHARED("the CRM: records, deals, follow-ups, tasks and typed operations; writes need the owner at the hub or a confirmed human session"),
  "/__jobs": { ...SHARED("the shared job and step history; B2 decides cancel/release per principal"), expectedFrom: "f/stage-b2-approvals-jobs (scripts/jobs/plugin.ts)" },
  "/__approvals": { ...SHARED("the shared approvals; B2 decides card/decide/cancel per principal"), expectedFrom: "f/stage-b2-approvals-jobs (scripts/jobs/plugin.ts)" },
  // Track 1 (scripts/commands/plugin.ts): the command palette's device-target preview, and app/file NAMES on the
  // requester's OWN device (hub index only for the hub's owner). GET only, each principal's own page token.
  "/__commands": READ_SHARED("command palette: target preview (resolveTarget for the signed-in person) and own-device app/file names"),
  "/__ai_usage": READ_SHARED("AI usage reads; settings and rescans change the hub"),
  "/__version": READ_SHARED("build metadata"),
  "/__events": READ_SHARED("the live activity stream (SSE, GET only): job, approval, computer, lease, device and Jarvis notifications; a job or approval reaches the person it belongs to (business jobs and shared computers reach both founders); notifications never run anything"),
  "/__health": READ_SHARED("hub health: component status and recovery hints, no secrets"),
  "/__app_version": READ_SHARED("build metadata"),
  "/__live-data": READ_SHARED("dashboard data (see REVIEW-B1 M-4 for what it contains)"),
  "/__graphify_list": READ_SHARED("project graphs index"),
  "/__graphify_graph": READ_SHARED("one project graph"),
  "/__openrouter_credits": READ_SHARED("AI spend reporting"),
  "/__openrouter_key": READ_SHARED("AI key cap and usage (never the key)"),
  "/__design_higgsfield_account": READ_SHARED("Design account status; disconnect wipes hub OAuth tokens"),
  "/__design_media": READ_SHARED("Design studio assets"),
  "/__design_file": READ_SHARED("Design studio assets"),
  "/__design_ledger": READ_SHARED("Design studio assets"),
  "/__design_modes": READ_SHARED("Design systems"),
  "/__design_mode": READ_SHARED("Design system; writes change hub files"),
  "/__design_carousel": READ_SHARED("Design decks; writes change hub files"),
  "/__design_system_asset": READ_SHARED("Design system assets"),
  "/__design_system_file": READ_SHARED("Design system assets"),
  "/__design_system": READ_SHARED("Design systems; writes change hub files"),
  "/__design_project_file": READ_SHARED("Design projects"),
  "/__design_project": READ_SHARED("Design projects; writes change hub files"),
  "/__design_project_asset": READ_SHARED("Design project assets"),
  "/__design_makers": READ_SHARED("which maker lanes are signed in"),
  "/__design_skills": READ_SHARED("Design skill names"),
  "/__design_providers": READ_SHARED("connected engines (key tails only)"),
  "/__design_balance": READ_SHARED("provider balances"),
  "/__design_models": READ_SHARED("engine model lists"),
  "/__design_schema": READ_SHARED("model controls"),
  "/__design_cost": SHARED("a price estimate; runs nothing"),
  "/__design_higgsfield_requests": READ_SHARED("generation requests"),
  "/__design_jobs": READ_SHARED("running generations"),
  "/__design_index_status": READ_SHARED("asset index status"),
  "/__design_search": READ_SHARED("asset search"),

  // ── the hub's own device: local owner only ────────────────────────────────────────────────
  "/__claude": LOCAL("Claude subscription bridge for Hermes"),
  "/__cline": LOCAL("Cline bridge for Hermes"),
  "/__jev": LOCAL("Jev approval guardian for Hermes"),
  "/__claude_chat": LOCAL("runs Claude Code on the hub (skip-permissions, the owner's subscription)"),
  "/__claude_attach": LOCAL("streams a hub Claude turn"),
  "/__claude_abort": LOCAL("stops hub processes"),
  "/__claude_abort_all": LOCAL("stops hub processes"),
  "/__claude_chats": LOCAL("the owner's Claude sessions"),
  "/__claude_file": LOCAL("files from the owner's Claude sessions"),
  "/__claude_session": LOCAL("the owner's Claude transcripts"),
  "/__claude_commands": LOCAL("the owner's Claude slash commands"),
  "/__claude_models": LOCAL("hub Claude Code models"),
  "/__chat_title": LOCAL("spawns claude -p"),
  "/__sessions_live": LOCAL("hub chat processes"),
  "/__mcp_approvals": LOCAL("approves tool use in hub sessions"),
  "/__permission_decision": LOCAL("approves tool use in hub sessions"),
  "/__question_answer": LOCAL("answers hub agent questions"),
  "/__ccr_pin_routes": LOCAL("writes claude-code-router config, restarts it"),
  "/__hermes_chat": LOCAL("runs Hermes on the hub"),
  "/__hermes_cmd": LOCAL("runs hermes commands (incl. update --yes)"),
  "/__hermes_status": LOCAL("hub Hermes install state"),
  "/__hermes_models": LOCAL("hub Hermes config"),
  "/__hermes_effort": LOCAL("writes ~/.hermes/config.yaml"),
  "/__hermes_moa_save": LOCAL("writes ~/.hermes/config.yaml"),
  "/__hermes_skills": LOCAL("hub Hermes skills"),
  "/__hermes_profiles": LOCAL("spawns hermes profile list"),
  "/__hermes_connections": LOCAL("hub Hermes connections"),
  "/__hermes_memory": LOCAL("the owner's Hermes SOUL, MEMORY and USER"),
  "/__hermes_owner_profile": LOCAL("the owner's profile in Hermes' USER.md; POST rewrites it"),
  "/__hermes_skill_sync": LOCAL("copies the owner's Claude Code skills into Hermes"),
  "/__hermes_sessions": LOCAL("the owner's Hermes sessions"),
  "/__hermes_session": LOCAL("the owner's Hermes sessions"),
  "/__hermes_documents": LOCAL("hub documents (restore, permanent trash)"),
  "/__hermes_image_upload": LOCAL("writes files for hub Hermes"),
  "/__hermes_missions": LOCAL("hub Hermes missions"),
  "/__hermes_missions/optimize": LOCAL("runs a model turn on the hub"),
  "/__hermes_missions/create": LOCAL("hub Hermes missions"),
  "/__hermes_missions/tick": LOCAL("hub Hermes missions"),
  "/__hermes_missions/clear": LOCAL("hub Hermes missions"),
  "/__hermes_pantheon": LOCAL("hub persona YAML"),
  "/__hermes_pantheon/install": LOCAL("writes hub persona YAML"),
  "/__hermes_pantheon/validate": LOCAL("hub persona YAML"),
  "/__hermes_pantheon/create": LOCAL("writes hub persona YAML"),
  "/__hermes_pantheon_templates": LOCAL("hub persona templates"),
  "/__hermes_pantheon_sync": LOCAL("hub persona mirror"),
  "/__fish_tts": LOCAL("Hermes voice with the hub's key"),
  "/__start_voice": LOCAL("writes OPENAI_API_KEY into ~/.hermes/.env, respawns voice-lab"),
  "/__design_set_key": LOCAL("changes provider keys"),
  "/__design_remove_key": LOCAL("changes provider keys"),
  "/__design_author": LOCAL("runs codex on the hub"),
  "/__design_publish": LOCAL("publishes from the hub"),
  "/__design_export": LOCAL("writes hub project folders"),
  "/__design_reference": LOCAL("writes hub files"),
  "/__design_trash": LOCAL("deletes hub files"),
  "/__design_generate": LOCAL("spends provider credit; may spawn CLIs"),
  "/__design_cancel": LOCAL("stops hub processes"),
  "/__design_index_start": LOCAL("spawns the indexer"),
  "/__design_index_stop": LOCAL("stops the indexer"),
  "/__graphify_ingest": LOCAL("graphs any hub path, git clone of any URL"),
  "/__graphify_remove": LOCAL("deletes hub graph files"),
  "/__memory_note": LOCAL("reads every Obsidian vault on the hub, incl. the personal vault"),
  "/__just-installed": LOCAL("deletes a hub marker file on GET"),
  "/__refresh_data": LOCAL("machine scan of the hub"),
  "/__set_dream_engine": LOCAL("hub Dream config"),
  "/__dream_engines": LOCAL("hub Dream engines"),
  "/__dream_action": LOCAL("hub Dream state"),
  "/__trigger_dream": LOCAL("runs hermes --yolo on the hub"),
  "/__lead-sites": LOCAL("generates and deploys previews from the hub"),
  "/__websites": LOCAL("hub website checkouts and deploys"),
  "/__site-draft": LOCAL("hub site drafts"),
  "/__seo-audit-files": LOCAL("hub files"),
  "/__website-os/connect": LOCAL("hub preview inspection"),
  "/__motion": LOCAL("launches Claude Code / Codex, uploads, exports on the hub"),
  "/__dev_restart": LOCAL("hub dev-server status"),
};

/** Connect's own prefix rule: case-insensitive, then "/", "." or the end. */
function under(path: string, prefix: string) {
  const p = path.toLowerCase();
  const q = prefix.toLowerCase().replace(/\/+$/, "");
  if (!p.startsWith(q)) return false;
  const next = p.charAt(q.length);
  return next === "" || next === "/" || next === ".";
}

const KEYS = Object.keys(ROUTES).sort((a, b) => b.length - a.length);

/** The rule for a /__* path: the longest matching entry, else local-owner (deny by default). */
export function routeRule(path: string): RouteRule & { key: string | null } {
  const key = KEYS.find((k) => under(path, k)) ?? null;
  return key ? { ...ROUTES[key], key } : { read: "local-owner", write: "local-owner", why: "unclassified: deny by default", key: null };
}

export function routeClass(path: string, method: string): RouteClass {
  const rule = routeRule(path);
  return method === "GET" || method === "HEAD" ? rule.read : rule.write;
}
