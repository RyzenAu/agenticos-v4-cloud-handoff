// The coding system pipeline as six plain steps (W-B, 29 Sep 2026): draft → plan → builder → tests →
// independent review → merge approval. Pure: the Coding list and job pages draw a lane from it, and the
// empty state teaches the same six steps. Honest rules carried from CODING-HARNESS §5.3:
//   - a step is "done" only on evidence (a confirmed plan, a builder commit, the ORCHESTRATOR's own test
//     run at the head, a reviewer verdict for the head, a verified apply step), never on an agent's claim;
//   - "waiting for approval" is never done; merge is never implied by "completed";
//   - a stopped job says where it stopped and why (interrupted is "not replayed").
import type { CodingJob, JobState } from "./coding-client";

export type StepId = "draft" | "plan" | "build" | "tests" | "review" | "merge";
export type StepStatus = "done" | "current" | "you" | "blocked" | "failed" | "todo" | "optional";

export type PipelineStep = {
  id: StepId;
  label: string;
  /** What this step is, in one short line (for the explainer and tooltips). */
  what: string;
  status: StepStatus;
  /** The step's state in words, e.g. "214 passed · 0 failed" or "Waiting for you to start it". */
  detail: string;
};

export const PIPELINE: readonly { id: StepId; label: string; what: string }[] = [
  { id: "draft", label: "Draft", what: "You say what should change, typed or to Jarvis. A program may draft too." },
  { id: "plan", label: "Plan", what: "Opus reads the repo (read-only) and writes the plan: files, checks, done-when. Nothing starts until you press Start." },
  { id: "build", label: "Builder", what: "An agent edits only the files the plan gives it, in its own working copy, and commits to a job branch." },
  { id: "tests", label: "Tests", what: "The coding system itself runs the repo's registered checks at that commit. An agent saying 'tests pass' never counts." },
  { id: "review", label: "Independent review", what: "A fresh read-only agent checks the exact commit against the plan and gives a verdict." },
  { id: "merge", label: "Merge approval", what: "Only if you want it: merging or pushing waits for your spoken yes or your Telegram code. Never a click, never an agent." },
];

const STATUS_WORD: Record<StepStatus, string> = {
  done: "Done",
  current: "Running now",
  you: "Needs you",
  blocked: "Paused",
  failed: "Stopped here",
  todo: "Not yet",
  optional: "Your call",
};
export const stepStatusWord = (s: StepStatus) => STATUS_WORD[s];

const ORDER: StepId[] = ["draft", "plan", "build", "tests", "review", "merge"];

/** Where an active or waiting state sits in the lane. */
const AT: Partial<Record<JobState, StepId>> = {
  draft: "draft",
  awaiting_confirmation: "plan",
  preparing: "build",
  building: "build",
  integrating: "build",
  testing: "tests",
  reviewing: "review",
  gating: "review",
  awaiting_approval: "merge",
  applying: "merge",
};

function testsAtHead(job: CodingJob) {
  return job.headSha ? job.tests.filter((t) => t.sha === job.headSha) : [];
}

/** The furthest step with evidence, for a job that stopped (failed, interrupted, needs you, at a limit). */
function stoppedAt(job: CodingJob): StepId {
  if (job.applies.length) return "merge";
  if (job.review) return "review";
  if (testsAtHead(job).length) return "tests";
  if (job.runs.some((r) => r.role === "builder" || r.role === "test-author")) return "build";
  if (job.spec.confirmation.state === "confirmed") return "build";
  return "plan";
}

function builderDetail(job: CodingJob) {
  const builders = job.runs.filter((r) => r.role === "builder");
  const files = job.diff?.files.length ?? 0;
  if (job.diff) return `${files} file${files === 1 ? "" : "s"} changed${job.headSha ? ` · ${job.headSha.slice(0, 7)}` : ""}`;
  if (builders.some((r) => r.state === "needs_input")) return "A builder is asking you something";
  if (builders.some((r) => r.state === "running" || r.state === "starting")) return "Editing its files";
  if (!builders.length && (job.state === "cancelled" || job.state === "failed")) return "The builder never started";
  return builders.length ? "Builder ran" : "Waiting for the plan to start";
}

function testsDetail(job: CodingJob) {
  const at = testsAtHead(job);
  if (!at.length) return "Not run yet";
  const passed = at.reduce((n, t) => n + (t.counts.passed ?? 0), 0);
  const failed = at.reduce((n, t) => n + (t.counts.failed ?? 0), 0);
  const unknown = at.some((t) => t.counts.passed === null && t.counts.failed === null);
  return unknown && !passed && !failed ? `${at.length} check${at.length === 1 ? "" : "s"} ran · counts unknown` : `${passed} passed · ${failed} failed`;
}

function reviewDetail(job: CodingJob) {
  const r = job.review;
  if (!r) return "No verdict yet";
  const word = r.verdict === "approve" ? "Approved" : r.verdict === "request-changes" ? "Changes requested" : "Couldn't assess";
  const stale = job.headSha && r.sha !== job.headSha ? " (an older commit)" : "";
  return `${word}${stale}`;
}

function mergeDetail(job: CodingJob) {
  const a = [...job.applies].reverse()[0];
  if (!a) return job.state === "completed" ? "Not asked. Say 'merge it' to Jarvis when you want it." : "Only after review, and only if you ask";
  if (a.state === "succeeded") return a.verification ? `Done and verified (${a.verification.method})` : "Done";
  if (a.state === "awaiting_approval") return "Waiting for your spoken yes or Telegram code";
  if (a.state === "running") return "Applying the approved step";
  if (a.state === "outcome_unknown") return "Outcome unknown: read back from the source, never re-run";
  return a.state === "failed" ? "The approved step failed" : "Withdrawn";
}

/** The six steps for one job, each with an honest status and a one-line state. */
export function pipelineFor(job: CodingJob): PipelineStep[] {
  const state = job.state;
  const terminalStop = ["failed", "cancelled", "interrupted", "needs_owner", "blocked_allowance"].includes(state);
  const at: StepId = terminalStop ? stoppedAt(job) : state === "completed" ? "merge" : (AT[state] ?? "draft");
  const atIndex = ORDER.indexOf(at);

  const tests = testsAtHead(job);
  const testsFailed = tests.some((t) => t.exitCode !== 0);
  const reviewBad = job.review && job.review.verdict !== "approve";

  return PIPELINE.map((p, i) => {
    let status: StepStatus;
    if (i < atIndex) status = "done";
    else if (i > atIndex) status = "todo";
    else if (state === "completed") status = job.applies.some((a) => a.state === "succeeded") ? "done" : "optional";
    else if (state === "draft") status = "you";
    else if (state === "awaiting_confirmation") status = "you";
    else if (state === "awaiting_approval") status = "you";
    else if (state === "needs_owner") status = "you";
    else if (state === "interrupted" || state === "blocked_allowance") status = "blocked";
    else if (state === "failed" || state === "cancelled") status = "failed";
    else status = "current";

    // Evidence overrides: a failing run or a non-approve verdict is shown on its own step, whatever the job state.
    if (p.id === "tests" && tests.length && status === "done" && testsFailed) status = "failed";
    if (p.id === "review" && reviewBad && status === "done") status = "failed";

    const detail =
      p.id === "draft"
        ? state === "draft" ? "The draft needs fixes before it can start" : `${job.spec.source.channel === "voice" ? "Spoken" : "Typed"} by ${job.spec.requestedBy.personId}`
        : p.id === "plan"
          ? state === "awaiting_confirmation" ? "Plan ready: waiting for you to press Start" : job.spec.confirmation.state === "confirmed" ? `Confirmed (revision ${job.spec.revision})` : "Not confirmed"
          : p.id === "build" ? builderDetail(job)
            : p.id === "tests" ? testsDetail(job)
              : p.id === "review" ? reviewDetail(job)
                : mergeDetail(job);
    const blockedWhy =
      status === "blocked"
        ? state === "interrupted" ? "Interrupted: nothing was replayed" : "Paused at an account limit"
        : status === "failed" && (state === "failed" || state === "cancelled") && i === atIndex
          ? state === "cancelled" ? "Stopped by you" : "Failed here"
          : null;
    return { id: p.id, label: p.label, what: p.what, status, detail: blockedWhy ? `${blockedWhy} · ${detail}` : detail };
  });
}

/** How far along the lane is, for a ring: steps with status done (merge counts only when it happened). */
export function pipelineProgress(steps: readonly PipelineStep[]): { done: number; of: number } {
  return { done: steps.filter((s) => s.status === "done").length, of: steps.length };
}

/** A sample request for the empty state. It only fills the box; nothing is drafted until you press Draft. */
export function sampleRequest(repoId?: string | null): string {
  return `In ${repoId || "<repo>"}, the page clock should tick every 30 seconds, not every second. Opus builds, another Opus reviews. Show me the tests and what changed.`;
}

/** The coding system policy in plain words (T3 rules; shown on the Coding page, never weakened here). */
export const HARNESS_POLICY: readonly { title: string; body: string }[] = [
  { title: "A person starts every job", body: "A program holding the page token can only draft a plan. Starting, stopping, resuming and approving need a founder signed in. Start is bound to the exact plan you saw, so a changed plan needs a new Start." },
  { title: "Agents only touch their own files", body: "Each builder may edit only the files its plan lists, in its own separate copy of the repo. Your working copy, your logins and keys, and the OS's data are never theirs to read or change." },
  { title: "Restricted tools", body: "No installs in shared folders, no git push, merge, reset or clean, no deploy tools, no network or web unless the plan allows public docs, no MCP tools. Anything unclassified is asked of you." },
  { title: "No deploys, no merges by agents", body: "Merging or pushing is a separate step the coding system performs only after your spoken yes or your Telegram code, and then checks the result at the source." },
  { title: "Tests are the coding system's own", body: "Test counts come only from the coding system running the repo's registered checks at the exact commit. An independent read-only reviewer checks that same commit." },
];
