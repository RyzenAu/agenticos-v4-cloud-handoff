/**
 * What a coding job says about itself, in the shape the Jarvis thread reads (threads.ts CodingSnapshot): its real state, its objective, one
 * receipt per role turn naming the account and the model that ACTUALLY answered (provider-reported, else the requested one), and the result in a
 * few words (files changed, tests, review verdict, done gate). Pure: the caller passes the job record and its events from the coding store.
 */
import type { CodingEvent, CodingJob, UsageReceipt } from "../coding/contracts";
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
    job.gate ? `Done gate ${job.gate.passed ? "passed" : "not passed"}.` : "",
  ].filter(Boolean);
  return { state: job.state, title: job.spec.objective, receipts, ...(parts.length ? { detail: parts.join(" ") } : {}) };
}
