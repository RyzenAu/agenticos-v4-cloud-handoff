/**
 * What a coding job says about itself, in the shape the Jarvis thread reads (threads.ts CodingSnapshot): its real state, its objective, one
 * receipt per role turn naming the account and the model that ACTUALLY answered (provider-reported, else the requested one), and the result in a
 * few words (files changed, tests, review verdict, final check). Pure: the caller passes the job record and its events from the coding store.
 */
import type { CodingEvent, CodingJob, UsageReceipt } from "../coding/contracts";
import { codingBlocker } from "../coding/pause-reason";
import type { CodingSnapshot } from "./threads";

const ROLE: Record<string, string> = { "coding.build": "builder", "coding.review": "reviewer", "coding.plan": "planner", "coding.test-author": "test author" };

export function codingSnapshotOf(job: CodingJob, events: readonly Pick<CodingEvent, "type" | "payload">[]): CodingSnapshot {
  const receipts = events
    .filter((e) => e.type === "usage")
    .map((e) => e.payload as unknown as UsageReceipt)
    .map((r) => ({ account: r.account, model: r.model, providerModel: r.providerModel ?? null, ...(ROLE[r.task] ? { role: ROLE[r.task] } : {}) }));
  const files = job.diff?.files?.length;
  const lastTest = job.tests?.at(-1);
  const parts = [
    typeof files === "number" ? `${files} file${files === 1 ? "" : "s"} changed.` : "",
    lastTest ? `Tests ${lastTest.exitCode === 0 ? "passed" : "failed"}.` : "",
    job.review ? `Review: ${String(job.review.verdict).replace(/_/g, " ")}.` : "",
    job.gate ? `Final check ${job.gate.passed ? "passed" : "not passed"}.` : "",
  ].filter(Boolean);
  // What the person is being asked for, when the job is waiting on them: the approval that answers it, or the one current blocker in plain words.
  const approvalId = job.state === "awaiting_approval" ? job.applies.at(-1)?.approval?.approvalId : undefined;
  const blocker = job.state === "needs_owner" || job.state === "blocked_allowance" || job.state === "interrupted" ? codingBlocker(job).text : undefined;
  return { state: job.state, title: job.spec.objective, ...(job.spec?.requestedBy?.personId ? { owner: job.spec.requestedBy.personId } : {}), receipts, ...(parts.length ? { detail: parts.join(" ") } : {}), ...(approvalId ? { approvalId } : {}), ...(blocker ? { blocker } : {}) };
}
