import { CODING_REQUEST_MAX, codingTooLong } from "../../src/lib/commands/coding";
import { hasVerifiedUiSession, publicJson, publicView, type Principal } from "../approvals/principal";
import type { ApprovalService } from "../approvals/service";
import type { AccountsConfig } from "./accounts";
import { claudeAllowance, slotReadings } from "./accounts";
import { readApproval, type IsolationApproval } from "./codex-isolation";
import { modelsUsed } from "./receipts";
import type { AgentBinding, ApprovalAction, CodingEvent, CodingJob, CommandId, Handoff, JobState, RepoRegistry, UsageReceipt } from "./contracts";
import { verifiedFromApprovalPrincipal, OrchestratorError, type Orchestrator } from "./orchestrator";
import { redactText } from "./redact";
import { reposFor } from "./registry";
import type { createShaper } from "./shaper";
import { CLAUDE_MODELS, CODEX_MODELS, codexBinding, claudeBinding, routerBinding, specDigest } from "./spec";
import type { CodingStore } from "./store";

/**
 * `/__operator/coding/*` (CODING-HARNESS §5, contracts CodingRoutes). Pure handler: the plugin authenticates
 * the transport (loopback socket, Origin, Sec-Fetch-Site, the caller's OWN page token on writes) and
 * resolves B1's verified principal. Access (owner decisions 4 and 5): both founders, signed in, see and
 * control coding jobs in the shared workspace; jobs run on the shared connected accounts with the
 * requester recorded. Merges and pushes are never done here: `apply` only ASKS (B2), and B2 accepts only
 * the owner's spoken yes or his Telegram code for a job's own merge. A person is never read from a body.
 *
 *   GET  /coding/jobs?state=&repo=&limit=        { jobs }
 *   GET  /coding/jobs/:id                        { job, receipts, modelsUsed, approvals, handoff, events, liveRoles }
 *   GET  /coding/jobs/:id/events?after=N         SSE (poll=1 → { events, last })
 *   GET  /coding/artefacts/:jobId/:artefactId    text/plain (redacted)
 *   POST /coding/shape      { requestId, utterance, channel, draftId?, answer? }
 *   POST /coding/jobs       { specId, specDigest, requestId, confirmation: "ui"|"typed" }
 *   POST /coding/jobs/:id/(cancel|interrupt|resume|input|apply|tests/rerun)
 *   GET  /coding/repos · GET /coding/accounts · GET /coding/focus
 */

export type CodingRuntime = {
  store: CodingStore;
  orch: Orchestrator;
  shaper: ReturnType<typeof createShaper>;
  registry: () => RepoRegistry;
  accounts: () => AccountsConfig;
  approvals: () => ApprovalService | null;
  cliVersions: () => { claude: string | null; codex: string | null };
  /** Resolves once cliVersions() holds the real values (read async at first use; T8b). */
  cliVersionsReady?: () => Promise<void>;
  /** "Show me the tests" by voice: the Coding page opens this job on this tab. */
  focus: { jobId: string; tab: string; at: number } | null;
  plannerReceipts?: Map<string, UsageReceipt>;
  /** The owner's --apply record for Codex sandbox isolation (A1-6). Default: read from ~/.claude-os. */
  codexIsolationApproval?: () => IsolationApproval | null;
};

/**
 * Codex isolation in words for the Coding page (W-B, 29 Sep 2026). Read-only: it reports whether the
 * owner has run `--apply` (the approval record), never changes an ACL and never runs icacls. The harness
 * still re-checks the real ACLs before every Codex role and pauses Codex if that check fails.
 */
export type CodexIsolationStatus = { state: "paused" | "protected"; label: string; detail: string; approvedAt: string | null; protectedPaths: number | null };
export function codexIsolationStatus(approval: IsolationApproval | null): CodexIsolationStatus {
  if (!approval)
    return {
      state: "paused",
      label: "Codex paused until --apply",
      detail: "Codex roles won't start until you run `bun scripts/coding/codex-isolation.ts --apply` once, as yourself, from the live checkout. It adds Deny entries so Codex's sandbox can't read your logins and keys. Claude and routed roles are unaffected.",
      approvedAt: null,
      protectedPaths: null,
    };
  return {
    state: "protected",
    label: "Codex isolation applied",
    detail: "You ran --apply, so Codex's sandbox is denied your credential folders. The harness re-checks them before every Codex role and pauses Codex, with the reason, if a check fails.",
    approvedAt: approval.approvedAt,
    protectedPaths: approval.paths.length,
  };
}

export type RouteInput = { method: string; path: string; url: URL; body: unknown; principal: Principal | null };
export type RouteOutput =
  | { status: number; body: unknown }
  | { status: 200; sse: { jobId: string; after: number } }
  | { status: 200; text: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB = /^\/coding\/jobs\/([0-9a-f-]{36})(?:\/(cancel|interrupt|resume|input|apply|events|tests\/rerun))?$/i;
const JOB_STATES: readonly (JobState | "needs-you")[] = ["draft", "awaiting_confirmation", "preparing", "building", "integrating", "testing", "reviewing", "gating", "awaiting_approval", "applying", "completed", "needs_owner", "blocked_allowance", "failed", "cancelled", "interrupted", "needs-you"];
const seen = new Map<string, { at: number; out: RouteOutput }>();

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Idempotent POSTs: the same person, route and requestId get the same answer for 10 minutes. The key is
 * per principal and path, so one person's requestId never replays another person's (or another route's)
 * answer.
 */
function once(principal: Principal, path: string, requestId: unknown, run: () => Promise<RouteOutput> | RouteOutput): Promise<RouteOutput> | RouteOutput {
  const id = typeof requestId === "string" && UUID.test(requestId) ? `${principal.personId}|${principal.via}|${path}|${requestId.toLowerCase()}` : null;
  const t = Date.now();
  for (const [k, v] of seen) if (t - v.at > 10 * 60_000) seen.delete(k);
  if (id && seen.has(id)) return seen.get(id)!.out;
  const out = run();
  if (id) Promise.resolve(out).then((o) => seen.set(id, { at: Date.now(), out: o })).catch(() => undefined);
  return out;
}

/** A binding the owner asked to reassign a role to (validated; never free-form). */
export function bindingFrom(value: unknown, rt: CodingRuntime): AgentBinding | null {
  const v = obj(value);
  const model = str(v.model, 80);
  const versions = rt.cliVersions();
  if (v.route === "claude-code-cli" && (CLAUDE_MODELS as readonly string[]).includes(model)) return claudeBinding(model as never, versions.claude ?? "unknown");
  if (v.route === "codex-app-server" && (CODEX_MODELS as readonly string[]).includes(model)) {
    const slot = str(v.accountSlot, 30);
    const cfg = rt.accounts().codex.find((c) => c.slot === slot) ?? rt.accounts().codex[0];
    if (!cfg) return null;
    return codexBinding(model as never, cfg.slot, versions.codex ?? "unknown");
  }
  if (v.route === "model-router" && model) return routerBinding(model);
  return null;
}

function receiptsOf(rt: CodingRuntime, jobId: string): UsageReceipt[] {
  return rt.store.events(jobId, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as UsageReceipt);
}

function approvalsOf(rt: CodingRuntime, job: CodingJob) {
  const service = rt.approvals();
  return job.applies.map((a) => {
    const live = service?.get(a.approval.approvalId) ?? null;
    return {
      applyStepId: a.id,
      approvalId: a.approval.approvalId,
      action: a.action,
      summary: a.approval.summary,
      state: live?.state ?? a.approval.state,
      expiresAt: live?.expiresAt ?? a.approval.expiresAt,
      // What answers it (B2): a process-requested merge takes the owner's spoken yes or his Telegram code.
      answeredBy: ["spoken yes (owner)", "Telegram code (owner)"],
      applyState: a.state,
      verification: a.verification,
    };
  });
}

export function jobView(rt: CodingRuntime, job: CodingJob) {
  const events = rt.store.events(job.id, Math.max(0, job.lastSeq - 400), 400);
  return {
    job,
    receipts: receiptsOf(rt, job.id),
    /** Per role turn: the model SELECTED vs the model that RAN (from its receipt), and why when they differ. */
    modelsUsed: modelsUsed(job.runs, rt.store.events(job.id, 0, 5000)),
    approvals: approvalsOf(rt, job),
    handoff: (rt.orch.handoffFor(job.id) ?? null) as Handoff | null,
    events,
    liveRoles: rt.orch.liveRoles(job.id),
    specDigest: specDigest(job.spec),
  };
}

/** Human-only coding actions (REVIEW-T3 F6): a program holding the page token can read, and draft, but never act. */
export const HUMAN_ONLY = "Starting, stopping, resuming or approving coding work needs you, signed in. A program holding the page token can't do it.";

/**
 * The coding API. Every JSON body leaves as its public view (REVIEW-T3 F6, S1 style): principals keep
 * who and how, never a sessionId or deviceId, and no B1 session key anywhere.
 */
export async function codingRoute(input: RouteInput, rt: CodingRuntime): Promise<RouteOutput | null> {
  if (input.path.startsWith("/coding/")) await rt.cliVersionsReady?.();
  const out = await codingRouteRaw(input, rt);
  return out && "body" in out ? { ...out, body: publicView(out.body) } : out;
}

async function codingRouteRaw(input: RouteInput, rt: CodingRuntime): Promise<RouteOutput | null> {
  const { method, path, url } = input;
  if (path !== "/coding" && !path.startsWith("/coding/")) return null;
  const principal = input.principal;
  if (!principal) return { status: 401, body: { error: "Sign in first." } };
  // Only drafting is open to a program; every POST that starts, stops, answers or approves needs a person
  // in a signed-in browser session (not the page token, not Telegram, not the companion).
  if (method === "POST" && path !== "/coding/shape" && !hasVerifiedUiSession(principal)) return { status: 403, body: { error: HUMAN_ONLY } };
  const who = verifiedFromApprovalPrincipal(principal);
  const body = obj(input.body);
  try {
    if (path === "/coding/jobs" && method === "GET") {
      const state = url.searchParams.get("state") as JobState | "needs-you" | null;
      if (state && !JOB_STATES.includes(state)) return { status: 400, body: { error: "Unknown state" } };
      const jobs = rt.store.listJobs({ state: state ?? undefined, repo: url.searchParams.get("repo") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50) || 50 });
      return { status: 200, body: { jobs, liveJobs: rt.orch.active() } };
    }
    if (path === "/coding/repos" && method === "GET")
      return { status: 200, body: { repos: reposFor(rt.registry(), principal.personId).map((r) => ({ id: r.id, description: r.description, defaultBaseRef: r.defaultBaseRef, checks: r.commands.map((c) => ({ id: c.id, kind: c.kind })) })) } };
    if (path === "/coding/accounts" && method === "GET") {
      const readings = slotReadings();
      const versions = rt.cliVersions();
      return {
        status: 200,
        body: {
          accounts: [
            { accountSlot: "claude:max", installed: !!versions.claude, cliVersion: versions.claude, allowance: claudeAllowance(), models: CLAUDE_MODELS },
            ...rt.accounts().codex.map((c) => ({ accountSlot: c.slot, installed: !!versions.codex, cliVersion: versions.codex, plan: c.plan, creditsAllowed: c.creditsAllowed, home: c.codexHome ? "own CODEX_HOME" : "default ~/.codex", reading: readings.find((r) => r.slot === c.slot) ?? null, models: CODEX_MODELS })),
          ],
          codexIsolation: codexIsolationStatus((rt.codexIsolationApproval ?? (() => readApproval()))()),
        },
      };
    }
    if (path === "/coding/focus" && method === "GET") {
      const f = rt.focus && Date.now() - rt.focus.at < 2 * 60_000 ? rt.focus : null;
      return { status: 200, body: { focus: f } };
    }
    if (path === "/coding/shape" && method === "POST") {
      return await once(principal, path, body.requestId, async () => {
        const channel = body.channel === "typed" || body.channel === "voice" ? body.channel : "ui";
        if (!body.draftId && typeof body.utterance === "string" && body.utterance.trim().length > CODING_REQUEST_MAX)
          return { status: 400, body: { error: codingTooLong(CODING_REQUEST_MAX) } };
        // A program may draft, but the Claude planner (Max allowance) runs only for a signed-in person (R3).
        const r = await rt.shaper.shape({ utterance: str(body.utterance), channel, principal: who, draftId: str(body.draftId, 40) || undefined, answer: str(body.answer, 600) || undefined, usePlanner: hasVerifiedUiSession(principal) });
        if (r.kind !== "draft") return { status: 200, body: r };
        const { job, validation } = rt.orch.draft(r.spec);
        const planner = rt.plannerReceipts?.get(r.spec.id);
        if (planner) { rt.store.appendEvent(job.id, "usage", "planner" as never, planner); rt.plannerReceipts!.delete(r.spec.id); }
        return { status: 200, body: { kind: "draft", spec: job.spec, jobId: job.id, specDigest: specDigest(job.spec), validation, spokenSummary: r.spokenSummary } };
      });
    }
    if (path === "/coding/jobs" && method === "POST") {
      return await once(principal, path, body.requestId, () => {
        const id = str(body.specId, 40);
        if (!UUID.test(id)) return { status: 400, body: { error: "specId is required" } };
        // A spoken yes is bound to the question Jarvis asked; only the voice path (voice.ts) holds that
        // STT event, so a POST can't claim one.
        const via = body.confirmation === "typed" ? "typed" : body.confirmation === "ui" ? "ui" : null;
        if (!via) return { status: 400, body: { error: "Confirm in the UI or by typing; a spoken yes comes through Jarvis." } };
        const job = rt.orch.confirmAndStart(id, who, via, str(body.specDigest, 80) as never);
        return { status: 202, body: { job } };
      });
    }
    if (path.startsWith("/coding/artefacts/") && method === "GET") {
      const m = /^\/coding\/artefacts\/([0-9a-f-]{36})\/(a-[0-9a-f-]{36})$/i.exec(path);
      if (!m) return { status: 404, body: { error: "Unknown artefact" } };
      return { status: 200, text: rt.store.readArtefact(m[1], m[2]) };
    }
    const m = JOB.exec(path);
    if (!m) return { status: 404, body: { error: "Unknown coding route" } };
    const [, id, action] = m;
    const job = rt.store.getJob(id);
    if (!job) return { status: 404, body: { error: "No such coding job." } };
    if (!action && method === "GET") return { status: 200, body: jobView(rt, job) };
    if (action === "events" && method === "GET") {
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      if (url.searchParams.get("poll") === "1") {
        const events = rt.store.events(id, after, 500);
        return { status: 200, body: { events, last: events.at(-1)?.seq ?? after } };
      }
      return { status: 200, sse: { jobId: id, after } };
    }
    if (method !== "POST") return { status: 405, body: { error: "POST only" } };
    return await once(principal, path, body.requestId, async () => {
      switch (action) {
        case "cancel": return { status: 200, body: { job: rt.orch.cancel(id, str(body.roleId, 30) || undefined) } };
        case "interrupt": return { status: 200, body: { job: rt.orch.interrupt(id, str(body.roleId, 30) || undefined) } };
        case "resume": {
          const reassignTo = body.reassignTo ? bindingFrom(body.reassignTo, rt) : undefined;
          if (body.reassignTo && !reassignTo) return { status: 400, body: { error: "That model isn't one the harness can run." } };
          return { status: 200, body: { job: rt.orch.resume(id, { roleId: str(body.roleId, 30) || undefined, reassignTo: reassignTo ?? undefined, by: who }) } };
        }
        case "input": {
          const decision = body.decision === "approve" ? "approve" : body.decision === "deny" ? "deny" : null;
          if (!decision) return { status: 400, body: { error: "approve or deny" } };
          const answers = obj(body.answers);
          const clean = Object.fromEntries(Object.entries(answers).filter(([, v]) => typeof v === "string").map(([k, v]) => [k.slice(0, 80), redactText(v, 2000)]));
          return { status: 200, body: { job: rt.orch.respond(id, str(body.roleId, 30), str(body.inputId, 200), decision, clean) } };
        }
        case "apply": {
          const act = body.action as ApprovalAction;
          if (!["git.merge.protected", "git.push.production", "deploy"].includes(act)) return { status: 400, body: { error: "Unknown action" } };
          const r = await rt.orch.requestApply(id, { action: act, toRef: str(body.toRef, 100), remote: str(body.remote, 60) || null, by: who });
          return { status: 202, body: { apply: r.apply, approval: { id: r.approval.id, state: r.approval.state, summary: r.approval.summary, expiresAt: r.approval.expiresAt }, answeredBy: ["spoken yes (owner)", "Telegram code (owner)"] } };
        }
        case "tests/rerun": {
          const test = await rt.orch.rerunTest(id, str(body.commandId, 80) as CommandId);
          return { status: 200, body: { test } };
        }
      }
      return { status: 404, body: { error: "Unknown action" } };
    });
  } catch (e) {
    const status = e instanceof OrchestratorError ? e.status : /Unknown artefact/.test((e as Error).message) ? 404 : 400;
    return { status, body: { error: redactText((e as Error).message, 400) } };
  }
}

/** SSE frames for events after `after`, then a heartbeat; the client resumes from the last id. */
export function sseFrames(events: readonly CodingEvent[]): string {
  return events.map((e) => `id: ${e.seq}\nevent: coding\ndata: ${JSON.stringify(e, publicJson)}\n\n`).join("");
}
