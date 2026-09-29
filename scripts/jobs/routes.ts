// HTTP routes for the Job and Approval services. Pure handler: the plugin authenticates the transport
// (loopback/Host/Origin/page token) and resolves the Principal with the injected `resolvePrincipal`
// (B1's implementation plugs in there, and only B1's verified browser session sets `sessionId`).
// Every route needs a Principal (401 without one).
//
//   GET  /__jobs?kind=&state=&limit=          { jobs: JobSummary[] }
//   GET  /__jobs/events?after=<seq>           { events: JobEvent[], last }     (the chip and step log poll this)
//   GET  /__jobs/events?tail=1                { events: [], last }             (start following from now)
//   GET  /__jobs/<id>                         { job: Job }
//   POST /__jobs/<id>/cancel         {}       202 { result } | 409
//   POST /__jobs/<id>/release        {}                  202 { approval }  asks ONCE to release a quarantine
//   POST /__jobs/<id>/release        { approvalId }      200 released | 409 tree still present / not approved
//   GET  /__approvals?state=&limit=           { approvals: Approval[] }
//   GET  /__approvals/<id>                    { approval }
//   POST /__approvals/<id>/card      {}       { cardNonce, expiresAt }   only for a verified UI session (the rendered card)
//   POST /__approvals/<id>/decide    { decision: "approve"|"reject", evidence }   evidence is one of
//        { spokenYes: <STT event id>, questionId } | { uiConfirm: true, cardNonce } | { awayCode: "AB3D", cardNonce? }
//        | { telegramCode: "AB3D" }   (the Telegram gateway, for a request a process made)
//   A request a PROCESS made (a coding job, Hermes, a script) is never answered by uiConfirm: any local
//   program can drive the owner's browser. Only a spoken yes or the owner's Telegram DM code answer it.
//   POST /__approvals/<id>/cancel    {}
//
// Deliberately absent: a route that creates an arbitrary approval (only server modules request them), and
// a route that asks a spoken question (that is the server's own TTS path, `approvals.ask`, never HTTP:
// a local process must not be able to mark a question asked or supersede the real one).
// The approver is always the resolved Principal, never a body field.
import { argsDigest } from "../approvals/canonical";
import { mayWithdraw, type ApprovalService, type ApprovalState, type Evidence } from "../approvals/service";
import { publicView, type Principal } from "../approvals/principal";
import { JOB_KINDS, type JobKind, type JobService, type JobState } from "./service";

export type RouteInput = { method: string; path: string; url: URL; body?: unknown; principal: Principal | null };
export type RouteResult = { status: number; body: unknown };
export type RouteDeps = { jobs: () => JobService; approvals: () => ApprovalService };

const ID = "([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const JOB_STATES: readonly JobState[] = ["queued", "running", "awaiting-approval", "succeeded", "failed", "cancelled", "interrupted", "unknown"];
const APPROVAL_STATES: readonly ApprovalState[] = ["pending", "approved", "rejected", "cancelled", "expired", "consumed"];
const emptyObject = (b: unknown) => !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 0;
export const RELEASE_ACTION = "jobs.release-quarantine";
export const releaseArgs = (jobId: string) => ({ jobId: jobId.toLowerCase() });

function evidenceFrom(value: unknown): Evidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(",");
  if (keys === "awayCode" && typeof e.awayCode === "string" && e.awayCode.length <= 8) return { awayCode: e.awayCode };
  if (keys === "awayCode,cardNonce" && typeof e.awayCode === "string" && e.awayCode.length <= 8 && typeof e.cardNonce === "string") return { awayCode: e.awayCode, cardNonce: e.cardNonce };
  if (keys === "cardNonce,uiConfirm" && e.uiConfirm === true && typeof e.cardNonce === "string") return { uiConfirm: true, cardNonce: e.cardNonce };
  if (keys === "questionId,spokenYes" && typeof e.spokenYes === "string" && typeof e.questionId === "string") return { spokenYes: e.spokenYes, questionId: e.questionId };
  if (keys === "telegramCode" && typeof e.telegramCode === "string" && e.telegramCode.length <= 8) return { telegramCode: e.telegramCode };
  return null;
}

/**
 * AUDIT-A1-1 (and the F5 API sweep): every body is the HTTP view, so no requester, approver or job principal
 * carries its sessionId or deviceId (the card still binds to the session server-side).
 */
export async function jobsApprovalsRoute(input: RouteInput, deps: RouteDeps): Promise<RouteResult | null> {
  const result = await route(input, deps);
  return result && { status: result.status, body: publicView(result.body) };
}

async function route(input: RouteInput, deps: RouteDeps): Promise<RouteResult | null> {
  const { method, path, url } = input;
  const isJobs = path === "/__jobs" || path.startsWith("/__jobs/");
  const isApprovals = path === "/__approvals" || path.startsWith("/__approvals/");
  if (!isJobs && !isApprovals) return null;
  const principal = input.principal;
  if (!principal) return { status: 401, body: { error: "Sign in to see or act on jobs and approvals." } };
  try {
    if (isJobs) {
      const jobs = deps.jobs();
      if (path === "/__jobs") {
        if (method !== "GET") return { status: 405, body: { error: "GET only" } };
        const kind = url.searchParams.get("kind") as JobKind | null;
        const state = url.searchParams.get("state") as JobState | null;
        if (kind && !JOB_KINDS.includes(kind)) return { status: 400, body: { error: "Unknown kind" } };
        if (state && !JOB_STATES.includes(state)) return { status: 400, body: { error: "Unknown state" } };
        return { status: 200, body: { jobs: jobs.list({ kind: kind ?? undefined, state: state ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50) || 50 }) } };
      }
      if (path === "/__jobs/events") {
        if (method !== "GET") return { status: 405, body: { error: "GET only" } };
        // tail=1: just the head seq, so a new client follows from now instead of replaying history.
        if (url.searchParams.get("tail") === "1") return { status: 200, body: { events: [], last: jobs.head() } };
        return { status: 200, body: jobs.events(Number(url.searchParams.get("after") ?? 0) || 0) };
      }
      const m = new RegExp(`^/__jobs/${ID}(?:/(cancel|release))?$`, "i").exec(path);
      if (!m) return { status: 404, body: { error: "Unknown job route" } };
      const id = m[1].toLowerCase();
      if (!m[2]) {
        if (method !== "GET") return { status: 405, body: { error: "GET only" } };
        const job = jobs.get(id);
        return job ? { status: 200, body: { job } } : { status: 404, body: { error: "No such job" } };
      }
      if (method !== "POST") return { status: 405, body: { error: "POST only" } };
      if (m[2] === "cancel") {
        if (!emptyObject(input.body)) return { status: 400, body: { error: "Cancel takes an empty JSON object; authority is server-derived." } };
        const result = await jobs.cancel(id);
        return { status: result.ok ? 202 : result.state === null ? 404 : 409, body: { result } };
      }
      // Release a quarantine: consequential, so asked once and consumed once, after the tree is gone.
      const job = jobs.get(id);
      if (!job) return { status: 404, body: { error: "No such job" } };
      if (!job.quarantined) return { status: 409, body: { error: "That job kind isn't quarantined." } };
      const approvals = deps.approvals();
      if (emptyObject(input.body)) {
        const r = approvals.request({
          action: RELEASE_ACTION,
          args: releaseArgs(id),
          requester: principal,
          origin: "principal",
          jobId: id,
          summary: `Release the hold on ${job.kind} jobs (stopped job: ${job.title}). Only do this once you've checked it stopped.`,
        });
        return r.ok ? { status: 202, body: { approval: r.approval } } : { status: 409, body: { error: r.refusal.reason } };
      }
      const approvalId = (input.body as { approvalId?: unknown } | undefined)?.approvalId;
      if (typeof approvalId !== "string" || !UUID.test(approvalId) || Object.keys(input.body as object).length !== 1)
        return { status: 400, body: { error: "Release takes {} to ask, or { approvalId } once approved." } };
      const result = await jobs.releaseQuarantine(id, () => approvals.consume(approvalId, argsDigest(RELEASE_ACTION, releaseArgs(id))).ok);
      return { status: result.ok ? 200 : 409, body: { result, job: jobs.get(id) } };
    }
    const approvals = deps.approvals();
    if (path === "/__approvals") {
      if (method !== "GET") return { status: 405, body: { error: "GET only" } };
      const state = url.searchParams.get("state") as ApprovalState | null;
      if (state && !APPROVAL_STATES.includes(state)) return { status: 400, body: { error: "Unknown state" } };
      return { status: 200, body: { approvals: approvals.list({ state: state ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50) || 50 }) } };
    }
    const m = new RegExp(`^/__approvals/${ID}(?:/(card|decide|cancel))?$`, "i").exec(path);
    if (!m) return { status: 404, body: { error: "Unknown approval route" } };
    const id = m[1].toLowerCase();
    if (!m[2]) {
      if (method !== "GET") return { status: 405, body: { error: "GET only" } };
      const approval = approvals.get(id);
      return approval ? { status: 200, body: { approval } } : { status: 404, body: { error: "No such approval" } };
    }
    if (method !== "POST") return { status: 405, body: { error: "POST only" } };
    if (m[2] === "card") {
      if (!emptyObject(input.body)) return { status: 400, body: { error: "A card takes an empty JSON object." } };
      const card = approvals.card(id, principal);
      return card ? { status: 200, body: card } : { status: 403, body: { error: "Confirming needs a signed-in browser session and a pending approval. A new browser at this PC must be confirmed first (Profile)." } };
    }
    if (m[2] === "cancel") {
      if (!emptyObject(input.body)) return { status: 400, body: { error: "Cancel takes an empty JSON object." } };
      const current = approvals.get(id);
      if (current && (current.state === "pending" || current.state === "approved") && !mayWithdraw(current, principal))
        return { status: 403, body: { error: "Only a person, or whoever asked for it, can cancel this." } };
      return approvals.cancel(id, "cancelled-by-person", principal) ? { status: 200, body: { approval: approvals.get(id) } } : { status: 409, body: { error: "Nothing to cancel" } };
    }
    const body = (input.body ?? {}) as { decision?: unknown; evidence?: unknown };
    if (body.decision !== "approve" && body.decision !== "reject") return { status: 400, body: { error: "decision must be approve or reject" } };
    const evidence = evidenceFrom(body.evidence);
    if (body.decision === "approve" && !evidence) return { status: 400, body: { error: "Approval needs evidence: a spoken yes to the question, a UI confirm from the card, or the away code." } };
    const result = approvals.decide(id, principal, body.decision, evidence ?? undefined);
    return result.ok ? { status: 200, body: { approval: result.approval } } : { status: result.code === "unknown" ? 404 : 409, body: result };
  } catch {
    return { status: 503, body: { error: "The job and approval stores are unavailable." } };
  }
}
