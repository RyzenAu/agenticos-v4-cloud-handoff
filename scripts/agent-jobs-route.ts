import { CODING_REQUEST_TOO_LONG, CODING_TASK_MAX, codingDraftHref } from "../src/lib/commands/coding";
import type { agentJobs } from "./agent-jobs";
import { RELAY_HEADER } from "./identity/principal";

/**
 * `/__operator/agent-jobs*`. Delegated agents run on this PC's own Claude and Codex logins, so a
 * remote (tailnet) caller is refused on EVERY agent-jobs path, reads included, before any work is
 * looked at or started (CODING-HARNESS §1.4 G1 / C1 (a)). Stage B's resolvePrincipal/authorise
 * replaces this default-deny once a verified principal can be granted coding permissions.
 * Returns false for paths that are not agent-jobs routes.
 */
export const REMOTE_AGENT_JOBS_REFUSAL = "Agent tasks run from this PC only.";

/**
 * A request that came through a relay (Tailscale Serve, a reverse proxy) is remote, whatever its Host
 * says: a relayed client can send `Host: localhost` and would otherwise look like the local owner
 * (review B1; the same rule 849f205 put on vite.config.ts isLoopback).
 */
// The ONE shared list lives with the identity contract (scripts/identity/principal.ts).
export { RELAY_HEADER };
export function relayed(headers: Record<string, unknown> | undefined): boolean {
  return !!headers && Object.keys(headers).some((name) => RELAY_HEADER.test(name));
}

/**
 * T3c: the old agent-jobs door no longer starts Codex or Claude. A task POST (the Tasks form, Hermes, any
 * page-token holder) becomes a coding draft: the answer names the /coding page, where the plan, repo and
 * agents are shown and only a signed-in person starts it, under the coding harness's policy, restricted
 * mode and tool allowlist. The connection check, answers to an agent's question and stop need a person
 * in a signed-in browser session too.
 */
export const AGENT_JOBS_DRAFTED = "Not started. It's a coding draft now: open it in Coding to see the plan, repo and agents, and start it there.";
export const AGENT_JOBS_HUMAN_ONLY = "That needs you, signed in to Agentic OS. A program holding the page token can't check, answer or stop agent tasks.";
const REQUEST_ID = /^[a-zA-Z0-9-]{16,80}$/;

/** A task body as a coding draft path, or the reason it can't be one (same checks the old create made). */
export function agentTaskDraft(body: unknown): { ok: true; path: string; request: string } | { ok: false; error: string } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || Object.keys(b).some((k) => !["requestId", "prompt", "targets", "workflow"].includes(k))) return { ok: false, error: "Choose an agent and describe the task." };
  if (typeof b.requestId !== "string" || !REQUEST_ID.test(b.requestId)) return { ok: false, error: "A valid task request ID is required." };
  const targets = b.targets;
  if (!Array.isArray(targets) || !targets.length || targets.length > 2 || targets.some((t) => t !== "codex" && t !== "claude") || new Set(targets).size !== targets.length)
    return { ok: false, error: "Choose Codex, Claude or both." };
  if (b.workflow !== undefined && b.workflow !== "build" && b.workflow !== "improve-os") return { ok: false, error: "Choose Build something or Improve this OS." };
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt || prompt.length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt)) return { ok: false, error: "Describe your task in up to 12,000 characters." };
  const text = b.workflow === "improve-os" && !/agentic ?os/i.test(prompt) ? `${prompt} in AgenticOS` : prompt;
  if (text.length > CODING_TASK_MAX) return { ok: false, error: CODING_REQUEST_TOO_LONG };
  const path = codingDraftHref(text, targets.length === 2 ? "both" : targets[0]);
  if (!path) return { ok: false, error: "Describe your task in a sentence." };
  return { ok: true, path, request: new URLSearchParams(path.split("?")[1]).get("request") ?? text };
}

export function isAgentJobsPath(path: string): boolean {
  return path === "/agent-jobs" || path.startsWith("/agent-jobs/");
}

export async function agentJobsRoute(input: {
  path: string;
  method: string;
  body: unknown;
  /** Truthy when the request came in over the tailnet (not the loopback owner). */
  remote: boolean;
  /** MU_HUB_ROLE=server: the identity layer admitted a confirmed human founder session, so a Serve relay header is expected. */
  serverWork?: boolean;
  /** The raw request headers: any relay header makes the request remote. */
  headers?: Record<string, unknown>;
  service: Pick<ReturnType<typeof agentJobs>, "list" | "status" | "create" | "respond" | "cancel">;
  send: (value: unknown, status?: number) => void;
  /** Who asked, from the verified principal (Stage B1); recorded on the job, never from the body. */
  requestedBy?: { personId: string; displayName: string; via: string };
  /** A person in a signed-in browser session (hasVerifiedUiSession), not a page-token program. */
  human?: boolean;
}): Promise<boolean> {
  const { path, method, body, remote, service, send } = input;
  if (!isAgentJobsPath(path)) return false;
  if (!input.serverWork && (remote || relayed(input.headers))) {
    send({ error: REMOTE_AGENT_JOBS_REFUSAL }, 403);
    return true;
  }
  if (path === "/agent-jobs" && method === "GET") return send(service.list()), true;
  if (path === "/agent-jobs/status" && method === "GET") return send(await service.status()), true;
  // A task never starts here, for anyone: it becomes a coding draft that a signed-in person starts.
  if (path === "/agent-jobs" && method === "POST") {
    const draft = agentTaskDraft(body);
    if (!draft.ok) return send({ error: draft.error }, 400), true;
    return send({ started: false, draft: { path: draft.path, request: draft.request }, message: AGENT_JOBS_DRAFTED }, 202), true;
  }
  if (method === "POST" && ["/agent-jobs/check", "/agent-jobs/respond", "/agent-jobs/cancel"].includes(path) && !input.human)
    return send({ error: AGENT_JOBS_HUMAN_ONLY }, 403), true;
  if (path === "/agent-jobs/check" && method === "POST") return send(service.create(body, true, input.requestedBy), 202), true;
  if (path === "/agent-jobs/respond" && method === "POST") return send(service.respond(body)), true;
  if (path === "/agent-jobs/cancel" && method === "POST") return send(service.cancel(body)), true;
  return false;
}
