// Where is this hub running? (cloud programme, Agent A; server role added for the headless Ryzen-PC hub)
//
//   MU_HUB_ROLE unset or "pc"   the hub is Usman's Windows PC. Nothing here changes any behaviour.
//   MU_HUB_ROLE=cloud           the hub is a Linux VM. Features that drive a PC (native Windows control, the
//                               local Claude/Codex/Hermes CLIs, the agent browser, this machine's voice
//                               stack) are not available at the hub. Their routes answer 501 with one plain
//                               line -- "runs on your PC, needs the companion" -- instead of crashing on a
//                               missing .exe or, worse, claiming success.
//   MU_HUB_ROLE=server          the hub is a headless Windows PC that nobody sits at (the always-on Ryzen-PC).
//                               It keeps the local Claude/Codex/Hermes/Cline CLIs and their bridges, but it is
//                               nobody's desktop: native control, the agent browser and the local voice stack
//                               answer 501 exactly as in the cloud role, for every caller, and the hub is not a
//                               device. Signed-in founders arriving through Tailscale Serve may use the hub's
//                               shared server-side capabilities that "local-owner" otherwise reserves for the
//                               owner at the keyboard (scripts/identity/server-role.ts decides which).
//
// The gate is a route table, not a scatter of platform checks: one list to read, one test to prove it, and
// the default role leaves every request untouched.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export type HubRole = "pc" | "cloud" | "server";

/** The role from the environment. Anything but the exact words "cloud" or "server" is the PC (the safe default). */
export function hubRole(env: Record<string, string | undefined> = process.env): HubRole {
  const word = (env.MU_HUB_ROLE ?? "").trim().toLowerCase();
  return word === "cloud" ? "cloud" : word === "server" ? "server" : "pc";
}

/** Is the hub's own desktop a controllable device? Only in the PC role: cloud and server hubs are nobody's PC. */
export function hubIsDeviceFor(role: HubRole): boolean {
  return role === "pc";
}

export type PcOnlyCapability = {
  id: string;
  label: string;
  /** Matches the request path (query string removed). */
  match: RegExp;
  /** What to tell the person, in the OS's plain voice. */
  say: string;
  /**
   * Stays available at a `server` hub (it uses the machine's CLIs and bridges, not its desktop). The cloud
   * role has neither, so the cloud still refuses it.
   */
  availableOnServer?: boolean;
};

const NEEDS_COMPANION = "This runs on your PC and needs the companion. It isn't available on the cloud hub.";
const NEEDS_COMPANION_SERVER = "This runs on your own PC and needs the companion. The server has no desktop of its own.";

/**
 * Every hub route that only makes sense on the owner's PC. Anything not listed keeps working in the cloud
 * (business data, CRM, jobs, approvals, memory, finance, receptionist feed, design, leads).
 */
export const PC_ONLY_CAPABILITIES: PcOnlyCapability[] = [
  {
    id: "windows-control",
    label: "Native PC control (screen, mouse, keyboard, apps)",
    // NOT /screen/command*: that is the one Jarvis command path, and in cloud role it routes each step to the
    // requester's own companion (the hub is not a device), so it must stay mounted.
    match: /^\/__operator\/(?:screen\/(?:act|stop)|pc\/act|cad\/act|open-url|vision\/describe)(?:[\/.]|$)/,
    say: NEEDS_COMPANION,
  },
  {
    id: "agent-browser",
    label: "Agent browser (Jarvis drives a local Chrome)",
    match: /^\/__operator\/browser\/act(?:[\/.]|$)/,
    say: NEEDS_COMPANION,
  },
  {
    id: "local-cli-agents",
    label: "Local Claude, Codex and Hermes command-line agents",
    match: /^\/__(?:claude|claude_[a-z_]+|hermes|hermes_[a-z_]+|cline|ccr_pin_routes|mcp_approvals|permission_decision|question_answer|chat_title|sessions_live|trigger_dream|dream_action|dream_engines|set_dream_engine)(?:[\/.]|$)|^\/__operator\/(?:agent-jobs|hermes\/task)(?:[\/.]|$)/,
    say: NEEDS_COMPANION,
    availableOnServer: true,
  },
  {
    id: "local-voice-stack",
    label: "This machine's voice stack (microphone, wake word, local speech)",
    match: /^\/__(?:start_voice|fish_tts)(?:[\/.]|$)/,
    say: NEEDS_COMPANION,
  },
];

export type PcOnlyHit = { capability: PcOnlyCapability };

/**
 * The PC-only capability a path belongs to, or null. Pure. The match is on the LOWERCASED path with the router's own
 * boundary rule (connect mounts case-insensitively, and a prefix is followed by "/", "." or the end), so
 * /__OPERATOR/screen/act, /__fish_tts.x and /__START_VOICE reach the same handlers and meet the same 501.
 */
export function pcOnlyCapabilityFor(pathname: string): PcOnlyCapability | null {
  const path = pathname.toLowerCase();
  return PC_ONLY_CAPABILITIES.find((c) => c.match.test(path)) ?? null;
}

/** Does this role refuse the capability? cloud refuses all of them; server only the desktop ones; pc none. */
export function capabilityRefusedIn(cap: PcOnlyCapability, role: HubRole): boolean {
  if (role === "cloud") return true;
  if (role === "server") return !cap.availableOnServer;
  return false;
}

/** What the person is told when this role refuses the capability. */
export function sayFor(cap: PcOnlyCapability, role: HubRole): string {
  return role === "server" ? NEEDS_COMPANION_SERVER : cap.say;
}

/** The body every gated route answers with (never a success shape). */
export function needsCompanionBody(cap: PcOnlyCapability, role: HubRole) {
  return { ok: false, status: "needs-companion", capability: cap.id, hubRole: role, error: sayFor(cap, role) };
}

/** For the health page and docs: what this hub does not do itself. */
export function pcOnlyReport(role: HubRole) {
  return PC_ONLY_CAPABILITIES.map((c) => {
    const refused = capabilityRefusedIn(c, role);
    return {
      id: c.id,
      label: c.label,
      status: refused ? "runs-on-your-pc" : "runs-here",
      detail: refused ? sayFor(c, role) : "Runs on this PC.",
    };
  });
}

type Next = (err?: unknown) => void;

/**
 * Connect middleware. In the PC role it is a pass-through; in the cloud role it refuses every PC-only route; in
 * the server role it refuses the desktop-control ones (windows-control, agent-browser, local-voice-stack) and
 * leaves the CLI-agent bridges alone. It looks at the path only, so the answer is the same for every caller,
 * a loopback one included.
 */
export function hubRoleGate(role: HubRole) {
  return (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (role === "pc") return next();
    // A "#fragment" is never part of the path a router sees; strip it as well as the query before matching (N1).
    const pathname = (req.url ?? "").split("#")[0].split("?")[0].replace(/\/+$/, "") || "/";
    const cap = pcOnlyCapabilityFor(pathname);
    if (!cap || !capabilityRefusedIn(cap, role)) return next();
    res.statusCode = 501;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(needsCompanionBody(cap, role)));
  };
}

/** Vite plugin. Mounted after the identity gate, so callers who are not signed in still get 401 first. */
export function hubRolePlugin(role: HubRole = hubRole()): Plugin {
  return {
    name: "mu-hub-role-gate",
    configureServer(server) {
      if (role !== "pc") server.middlewares.use(hubRoleGate(role));
    },
  };
}
