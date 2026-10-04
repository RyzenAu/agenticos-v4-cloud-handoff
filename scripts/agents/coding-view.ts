import type { CodingEvent, CodingJob, UsageReceipt } from "../coding/contracts";
import { codingBlocker } from "../coding/pause-reason";
import { maskJobText } from "../jobs/service";
import type { BotFile, BotTask } from "./types";

/**
 * A coding job as the Agents workspace lists it: the job record and its usage receipts in, one task row and one files row out. Pure: the
 * caller reads the record and events from the coding store. The account and model are the ones that ACTUALLY answered (the receipts), never
 * the ones that were selected; a job with no receipt yet has none to show.
 */

const ROLE: Record<string, string> = { "coding.build": "builder", "coding.review": "reviewer", "coding.plan": "planner", "coding.test-author": "test author" };
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

export const CODING_PHASE: Record<string, BotTask["phase"]> = {
  draft: "waiting",
  awaiting_confirmation: "waiting",
  preparing: "running",
  building: "running",
  integrating: "running",
  testing: "running",
  reviewing: "running",
  gating: "running",
  applying: "running",
  awaiting_approval: "waiting",
  needs_owner: "waiting",
  blocked_allowance: "waiting",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "unknown",
};
const ENDED = new Set(["completed", "failed", "cancelled", "interrupted"]);

export const JOB_PHASE: Record<string, BotTask["phase"]> = {
  queued: "running",
  running: "running",
  "awaiting-approval": "waiting",
  succeeded: "done",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "unknown",
  unknown: "unknown",
};

export function receiptsOf(events: readonly Pick<CodingEvent, "type" | "payload">[]): NonNullable<BotTask["receipts"]> {
  const out: NonNullable<BotTask["receipts"]> = [];
  for (const e of events) {
    if (e.type !== "usage") continue;
    const r = e.payload as unknown as UsageReceipt;
    if (!r?.account) continue;
    const row = { account: r.account, model: r.providerModel ?? r.model, ...(ROLE[r.task] ? { role: ROLE[r.task] } : {}) };
    if (!out.some((x) => x.account === row.account && x.model === row.model && x.role === row.role)) out.push(row);
  }
  return out;
}

const reviewOf = (job: CodingJob): BotTask["review"] | undefined =>
  job.review
    ? {
        verdict: job.review.verdict,
        blockers: job.review.findings.filter((f) => f.severity === "blocker").length,
        majors: job.review.findings.filter((f) => f.severity === "major").length,
        minors: job.review.findings.filter((f) => f.severity === "minor").length,
      }
    : undefined;

/** The newest run of each test command: what is true now, not an older attempt. */
const testsOf = (job: CodingJob): BotTask["tests"] | undefined => {
  if (!job.tests?.length) return undefined;
  const latest = new Map<string, (typeof job.tests)[number]>();
  for (const t of job.tests) latest.set(t.commandId, t);
  let passed = 0;
  let failed = 0;
  for (const t of latest.values()) {
    passed += t.counts.passed ?? 0;
    failed += t.counts.failed ?? (t.exitCode === 0 ? 0 : 1);
  }
  return { passed, failed };
};

export function codingTaskOf(job: CodingJob, events: readonly Pick<CodingEvent, "type" | "payload">[], subjects?: string[]): BotTask {
  const receipts = receiptsOf(events);
  const last = receipts.at(-1);
  const phase = CODING_PHASE[job.state] ?? "unknown";
  const blocked = phase === "waiting" && job.state !== "draft" && job.state !== "awaiting_confirmation" && job.state !== "awaiting_approval";
  const review = reviewOf(job);
  const tests = testsOf(job);
  return {
    id: job.id,
    kind: "coding",
    title: maskJobText(job.spec.objective, 140) || "Coding job",
    state: job.state,
    phase,
    startedAt: ms(job.createdAt),
    endedAt: ENDED.has(job.state) ? ms(job.updatedAt) : null,
    ...(last ? { account: last.account, model: last.model } : {}),
    ...(blocked || job.state === "interrupted" ? { blocker: maskJobText(codingBlocker(job).text, 240) } : {}),
    ...(job.state === "awaiting_confirmation" || job.state === "draft" ? { blocker: "Waiting for you to start it (the plan is drafted, nothing has run)." } : {}),
    ...(review ? { review } : {}),
    ...(tests ? { tests } : {}),
    branch: job.spec.repo.jobBranch,
    ...(job.headSha ? { commit: job.headSha } : {}),
    ...(receipts.length ? { receipts } : {}),
    ...(subjects?.length ? { subjects } : {}),
  };
}

/** A coding job's outputs as a files row: the branch, the commit, the files it changed, the review, the tests and what ran. Only a job that has produced something. */
export function codingFileOf(job: CodingJob, events: readonly Pick<CodingEvent, "type" | "payload">[], subjects?: string[]): BotFile | null {
  const task = codingTaskOf(job, events, subjects);
  const files = (job.diff?.files ?? []).map((f) => ({ name: f.path, bytes: null, status: f.status }));
  if (!job.headSha && !files.length && !task.review && !task.tests) return null;
  return {
    artifact: `coding:${job.id}`,
    title: task.title,
    jobId: job.id,
    createdAt: ms(job.updatedAt) || task.startedAt,
    source: "coding",
    files,
    branch: task.branch,
    ...(task.commit ? { commit: task.commit } : {}),
    ...(task.review ? { review: task.review } : {}),
    ...(task.tests ? { tests: task.tests } : {}),
    ...(task.receipts ? { receipts: task.receipts } : {}),
    ...(subjects?.length ? { subjects } : {}),
  };
}
