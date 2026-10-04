// Tasks & Files: one row per piece of work a bot did, built from the existing job APIs (single source: no copy of any job is kept).
//  - computer jobs: GET /__jobs (kind "control", targetDeviceId = the bot's computer id), plus GET /__jobs/:id for steps and receipts
//  - coding jobs (Builder): /__operator/coding (list, and per-job receipts)
//  - GET /__agents/bots/:id/tasks, when the agents service (B1) is on the hub, supersedes both.
// Rules: "account and model" come from RECEIPTS only (what ran), never from what was asked for; a row never says finished without an
// observable outcome (a saved result, a step that ran, a verified gate); a blocker says what to do next.
import type { Job, JobSummary } from "../../../../scripts/jobs/types";
import type { ArtifactMeta } from "../../../../scripts/computers/artifacts";
import type { CodingJob, JobView, UsageReceipt } from "@/lib/coding-client";
import { jobLabel, jobStateLabel, modelLabel, testsSummary } from "@/lib/coding-client";
import { accountWords } from "@/lib/coding-glance";
import { needsYouLine } from "@/components/coding/needs-you";
import { codingBlocker, codingResumeLabel } from "../../../../scripts/coding/pause-reason";
import type { Tone } from "@/components/ds";
import type { Bot } from "../workspace/bots";

export type TaskState = "working" | "queued" | "needs-you" | "finished" | "failed" | "stopped" | "interrupted" | "unknown";
export type TaskSource = "computer" | "coding" | "service";
export type BlockerAction = { kind: "resume"; label: string; /** The owner accepts a change he made to a checkout the job must not touch (his click is the decision). */ accept?: boolean; /** What accepting covers (the paths that moved), shown on the control. */ detail?: string } | { kind: "tab"; tab: "computer" | "chat"; label: string } | { kind: "link"; href: string; label: string };
export type BotTask = {
  id: string;
  source: TaskSource;
  /** Which existing API a Stop or Resume goes to. */
  kind: "computer" | "coding";
  title: string;
  state: TaskState;
  /** The state in words; never "Finished" without an outcome. */
  stateWord: string;
  tone: Tone;
  startedAt: string | null;
  endedAt: string | null;
  /** What actually ran it, from receipts. `used` is false when nothing is recorded (the text then says so). */
  ran: { text: string; used: boolean };
  progress: string | null;
  review: string | null;
  tests: string | null;
  blocker: { text: string; action: BlockerAction | null } | null;
  /** The saved result. `external` opens in a new tab (a hub-served page); otherwise an in-app route. */
  result: { href: string; label: string; external: boolean } | null;
  /** Said when the job ended but nothing observable came out of it. */
  outcomeNote: string | null;
  /** Where the finished (or part-finished) work can be opened: its branch and changes, tests and review. Empty when there is nothing to open. */
  links: { label: string; href: string }[];
  /** Where the whole job lives: the Coding page or the Activity page. */
  jobHref: { href: string; label: string } | null;
  /** A coding job that has not been started yet: it waits for the owner's Start, so it has no start time and nothing to resume. */
  notStarted?: boolean;
  can: { cancel: boolean; resume: boolean };
};

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const TERMINAL: TaskState[] = ["finished", "failed", "stopped", "interrupted", "unknown"];
export const taskIsOpen = (t: Pick<BotTask, "state">) => !TERMINAL.includes(t.state);

// ------------------------------------------------------------------ what actually ran

type ReceiptLike = { provider?: string | null; account?: string | null; model?: string | null; providerModel?: string | null; requestedModel?: string | null };

/** Pure: the model NAME a person would say, without ids they would not know. */
const modelWords = (model: string) => modelLabel({ model } as never);

/** Pure: the words on the result button. A result already labelled "Open result" (coding jobs) is not joined to itself: "Open result: Open result". */
export function resultButtonText(label: string): string {
  return label === "Saved result" || label === "Open result" ? "Open result" : `Open result: ${label}`;
}

/**
 * Pure: "Claude Max 2 · Claude Opus 5.5" from receipts. Only what ran: the model the provider reported (else the one the receipt says ran);
 * a difference from what was asked for is said, never swapped in. No receipts = `used: false` and a sentence that says so.
 */
export function ranWith(receipts: readonly ReceiptLike[] | null, emptyText: string): { text: string; used: boolean } {
  if (receipts === null) return { text: "Reading what ran…", used: false };
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const r of receipts) {
    const model = r.providerModel || r.model;
    if (!model) continue;
    const who = r.account ? accountWords(r.account) : r.provider ? r.provider : null;
    const asked = r.requestedModel && r.requestedModel !== model ? ` (asked for ${modelWords(r.requestedModel)})` : "";
    const line = `${who ? `${who} · ` : ""}${modelWords(model)}${asked}`;
    if (!seen.has(line)) {
      seen.add(line);
      parts.push(line);
    }
  }
  return parts.length ? { text: parts.join("; "), used: true } : { text: emptyText, used: false };
}

// ------------------------------------------------------------------ computer jobs

const COMPUTER_WORD: Record<JobSummary["state"], string> = { queued: "Queued", running: "Working", "awaiting-approval": "Needs your yes", succeeded: "Finished", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted, not replayed", unknown: "Outcome not known" };

export function computerTask(job: JobSummary, ctx: { artifact?: ArtifactMeta | null; detail?: Job | null; pausedJobId?: string | null }): BotTask {
  const { artifact = null, detail = null } = ctx;
  const paused = ctx.pausedJobId === job.id;
  const steps = detail?.steps.filter((s) => s.executor !== "context") ?? null;
  const ranSteps = steps?.filter((s) => s.outcome === "ok") ?? [];
  const lastIntent = steps?.at(-1)?.intent ?? job.lastStep?.intent ?? null;
  // "Finished" is earned: a saved result, or at least one step that actually ran.
  const observable = !!artifact || ranSteps.length > 0 || (!detail && job.lastStep?.outcome === "ok");
  let state: TaskState;
  let stateWord = COMPUTER_WORD[job.state];
  let tone: Tone;
  let blocker: BotTask["blocker"] = null;
  switch (job.state) {
    case "queued": state = "queued"; tone = "info"; break;
    case "running":
      if (paused) {
        state = "needs-you";
        tone = "warn";
        stateWord = "Paused";
        blocker = { text: "Paused while someone holds the controls. Return them and it carries on from the same step.", action: { kind: "tab", tab: "computer", label: "Go to the computer" } };
      } else { state = "working"; tone = "info"; }
      break;
    case "awaiting-approval":
      state = "needs-you";
      tone = "warn";
      blocker = { text: "Waiting for your spoken yes or Telegram code. It runs nothing until you answer.", action: { kind: "link", href: `/activity#job-${job.id}`, label: "See the question" } };
      break;
    case "succeeded":
      if (observable) { state = "finished"; tone = "success"; }
      else { state = "unknown"; tone = "warn"; stateWord = "Ended, nothing to show"; }
      break;
    case "failed": state = "failed"; tone = "danger"; break;
    case "cancelled": state = "stopped"; tone = "neutral"; break;
    case "interrupted": state = "interrupted"; tone = "warn"; break;
    default: state = "unknown"; tone = "warn";
  }
  if ((state === "failed" || state === "interrupted" || state === "unknown") && job.note) blocker = { text: clip(job.note, 220), action: { kind: "tab", tab: "chat", label: "Ask the bot again" } };
  const progress = steps ? (steps.length ? `${ranSteps.length} of ${steps.length} step${steps.length === 1 ? "" : "s"} ran${lastIntent && taskIsOpen({ state }) ? `. Now: ${clip(lastIntent.replace(/^step \d+ [\w.]+: /, ""), 90)}` : ""}` : "No steps recorded yet") : job.stepCount ? `${job.stepCount} step${job.stepCount === 1 ? "" : "s"} recorded` : null;
  return {
    id: job.id,
    source: "computer",
    kind: "computer",
    title: clip(job.title || "Untitled job"),
    state,
    stateWord,
    tone,
    startedAt: job.createdAt,
    endedAt: taskIsOpen({ state }) ? null : job.updatedAt,
    ran: ranWith(detail ? detail.receipts : null, "No model or account was recorded for this task."),
    progress,
    review: null,
    tests: null,
    blocker,
    result: artifact ? { href: `/__computers/artifacts/${artifact.id}`, label: artifact.title || "Saved result", external: true } : null,
    outcomeNote: state === "unknown" && job.state === "succeeded" ? "The job says it ended, but no step ran and no result was saved." : state === "finished" && !artifact ? (job.note?.trim() ? clip(job.note.trim(), 220) : "No saved result: it did its steps on the computer only.") : null,
    links: [],
    jobHref: { href: `/activity#job-${job.id}`, label: "Open job" },
    can: { cancel: state === "working" || state === "queued" || state === "needs-you", resume: false },
  };
}

// ------------------------------------------------------------------ coding jobs

const RESUMABLE = ["interrupted", "blocked_allowance", "needs_owner"];
const DONE = ["completed", "failed", "cancelled"];

/**
 * Pure: the one control a stopped coding job gets in Tasks. It is the job page's own next step (round 7): a plain Resume on a step whose
 * account is at its limit or signed out stopped in the same place straight away, so those go to the job page to move the step to another
 * account (an owner decision that is recorded there). Everything else resumes, under the button's real name ("Fix the failing tests").
 */
export function codingBlockerAction(job: CodingJob): BlockerAction | null {
  if (job.supersededBy) return null;
  if (!RESUMABLE.includes(job.state)) return { kind: "link", href: `/coding/${job.id}`, label: "Open the job" };
  const b = codingBlocker(job);
  const latest = [...job.runs].reverse().find((r) => r.roleId === b.roleId);
  const accountProblem = b.kind === "role-limit" || b.kind === "reviewer-unavailable" || (b.kind === "role-stopped" && latest?.error?.code === "signed_out");
  if (accountProblem) return { kind: "link", href: `/coding/${job.id}`, label: "Choose another account" };
  return { kind: "resume", label: codingResumeLabel(job), ...(b.kind === "checkout-changed" || b.kind === "outside-worktrees" ? { accept: true, ...(b.detail ? { detail: b.detail } : {}) } : {}) };
}

/** Pure: where to open the work of a coding job. Only what exists is offered, each on its own job tab. */
export function codingLinks(job: CodingJob): { label: string; href: string }[] {
  const base = `/coding/${job.id}`;
  const links: { label: string; href: string }[] = [];
  if (job.diff || job.headSha) links.push({ label: job.spec.repo?.jobBranch ? `Changes on ${job.spec.repo.jobBranch}` : "Changes", href: `${base}?tab=changes` });
  if (job.tests.length) links.push({ label: "Test results", href: `${base}?tab=tests` });
  if (job.review) links.push({ label: "Review", href: `${base}?tab=review` });
  return links;
}

/** Pure: a coding job as a task. `view` (receipts, readable progress) arrives per job; until it does the account/model line says it is reading. */
export function codingTask(job: CodingJob, view: JobView | null): BotTask {
  const label = jobLabel(job);
  // Verified means the gate passed for THIS head, not an older one (review finding 7).
  const verified = job.state === "completed" && job.gate?.passed === true && !!job.headSha && job.gate.sha === job.headSha;
  const mergedStep = job.applies?.find((a) => a.state === "succeeded" && a.action === "git.merge.protected");
  const branchName = job.spec.repo?.jobBranch ?? "its job branch";
  const doneNote = verified
    ? `Done and checked at ${job.headSha?.slice(0, 7) ?? "its last commit"}. ${mergedStep ? `Merged into ${mergedStep.toRef}${mergedStep.verification?.observed ? ` (${mergedStep.verification.observed.slice(0, 7)})` : ""}; the work is also on ${branchName}.` : `The work is on ${branchName}; nothing is merged until you say so.`}`
    : null;
  let state: TaskState;
  let stateWord = label.label;
  let tone = label.tone as Tone;
  switch (job.state) {
    case "preparing": case "building": case "integrating": case "testing": case "reviewing": case "gating": case "applying": state = "working"; break;
    case "draft": case "awaiting_confirmation": case "needs_owner": case "awaiting_approval": case "blocked_allowance": state = "needs-you"; break;
    case "interrupted": state = "interrupted"; break;
    case "completed":
      if (verified) state = "finished";
      else { state = "unknown"; stateWord = "Ended, not verified"; tone = "warn"; }
      break;
    case "failed": state = "failed"; break;
    case "cancelled": state = "stopped"; break;
    default: state = "unknown";
  }
  const needs = state === "needs-you" || state === "interrupted";
  const receipts: readonly UsageReceipt[] | null = view ? view.receipts : null;
  const asked = job.runs[0]?.binding ?? job.spec.roles.find((r) => r.agent)?.agent ?? null;
  const ran = ranWith(receipts, asked ? `Nothing has run yet. It is set to use ${accountWords(asked.accountSlot)}, ${modelLabel(asked)}.` : "Nothing has run yet.");
  const phase = view?.readable?.progress.phases.find((p) => p.status === "active");
  const review = job.review ? `${job.review.verdict === "approve" ? "Approved" : job.review.verdict === "request-changes" ? "Changes requested" : "Could not assess"} by ${accountWords(job.review.binding.accountSlot)}${job.review.findings.length ? `, ${job.review.findings.length} finding${job.review.findings.length === 1 ? "" : "s"}` : ""}` : null;
  const ts = testsSummary(job);
  const blocker: BotTask["blocker"] = needs
    ? { text: clip(needsYouLine(job), 220), action: codingBlockerAction(job) }
    : state === "failed" ? { text: clip(job.stoppedBecause?.message ?? job.runs.find((r) => r.error)?.error?.message ?? "It failed. The job page has the details.", 220), action: { kind: "link", href: `/coding/${job.id}`, label: "See why" } } : null;
  const done = DONE.includes(job.state);
  return {
    id: job.id,
    source: "coding",
    kind: "coding",
    title: clip(job.spec.objective),
    state,
    stateWord,
    tone,
    startedAt: job.createdAt,
    endedAt: done ? job.updatedAt : null,
    ran,
    progress: phase ? `${phase.label}${phase.detail ? `: ${clip(phase.detail, 80)}` : ""}` : state === "working" ? (view?.readable?.progress.stateText ?? "Working") : null,
    review,
    tests: job.tests.length ? ts.text : null,
    blocker,
    result: verified || job.state === "awaiting_approval" ? { href: `/coding/${job.id}?tab=changes`, label: "Open result", external: false } : null,
    outcomeNote: job.state === "completed" && !verified ? "The job says it finished, but the final check did not pass." : doneNote,
    links: codingLinks(job),
    jobHref: { href: `/coding/${job.id}`, label: "Open job" },
    notStarted: job.state === "draft" || job.state === "awaiting_confirmation",
    can: { cancel: !done && !job.supersededBy, resume: RESUMABLE.includes(job.state) && !job.supersededBy },
  };
}

// ------------------------------------------------------------------ from the agents service (B1), when it is there

const SERVICE_STATE: Record<string, [TaskState, string, Tone]> = {
  queued: ["queued", "Queued", "info"], running: ["working", "Working", "info"], working: ["working", "Working", "info"],
  "awaiting-approval": ["needs-you", "Needs your yes", "warn"], "needs-you": ["needs-you", "Needs you", "warn"], needs_owner: ["needs-you", "Needs you", "warn"],
  succeeded: ["finished", "Finished", "success"], completed: ["finished", "Finished", "success"], finished: ["finished", "Finished", "success"],
  failed: ["failed", "Failed", "danger"], cancelled: ["stopped", "Stopped", "neutral"], stopped: ["stopped", "Stopped", "neutral"],
  interrupted: ["interrupted", "Interrupted, not replayed", "warn"],
};
const str = (v: unknown, max = 300) => (typeof v === "string" && v ? v.slice(0, max) : null);
/** A time as ISO text: the agents service sends milliseconds (the older rows sent ISO text). */
const when = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : str(v, 40));
/** The service's `phase` word for a state this list has no word of its own for (a coding job's building, testing, blocked_allowance...). */
const PHASE_STATE: Record<string, [TaskState, Tone]> = { running: ["working", "info"], waiting: ["needs-you", "warn"], done: ["finished", "success"], failed: ["failed", "danger"], stopped: ["stopped", "neutral"] };
const CODING_STATES = new Set(["draft", "awaiting_confirmation", "preparing", "building", "integrating", "testing", "reviewing", "gating", "awaiting_approval", "applying", "completed", "needs_owner", "blocked_allowance", "failed", "cancelled", "interrupted"]);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** A review summary object ({ verdict, blockers, majors, minors }) in words; a plain string passes through. */
function reviewWords(v: unknown): string | null {
  if (typeof v === "string") return str(v, 160);
  if (!v || typeof v !== "object") return null;
  const r = v as { verdict?: unknown; blockers?: unknown; majors?: unknown; minors?: unknown };
  const head = r.verdict === "approve" ? "Approved" : r.verdict === "request-changes" ? "Changes requested" : r.verdict === "cannot-assess" ? "Could not assess" : null;
  if (!head) return null;
  const serious = (Number(r.blockers) || 0) + (Number(r.majors) || 0);
  const minors = Number(r.minors) || 0;
  return `${head}${serious ? `, ${plural(serious, "serious finding")}` : ""}${minors ? `, ${plural(minors, "minor note")}` : ""}`;
}
/** A test summary object ({ passed, failed }) in words; a plain string passes through. */
function testWords(v: unknown): string | null {
  if (typeof v === "string") return str(v, 160);
  if (!v || typeof v !== "object") return null;
  const t = v as { passed?: unknown; failed?: unknown };
  if (typeof t.passed !== "number" || typeof t.failed !== "number") return null;
  return `${t.passed} passed${t.failed ? `, ${t.failed} failed` : ", none failed"}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: one row of GET /__agents/bots/:id/tasks. Null when it has no id or title. A finished row with no result says so. */
export function serviceTask(raw: unknown): BotTask | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 80);
  const title = str(r.title, 200);
  if (!id || !title) return null;
  const coding = r.kind === "coding";
  const rawState = String(r.state);
  const phase = PHASE_STATE[String(r.phase)];
  // A state this list has no word for falls back to the row's own phase and, for a coding job, the job page's own wording (it used to read "Outcome not known").
  const known: [TaskState, string, Tone] = coding && CODING_STATES.has(rawState) && !SERVICE_STATE[rawState]
    ? [phase?.[0] ?? "unknown", jobStateLabel(rawState as never).label, (phase?.[1] ?? "warn") as Tone]
    : SERVICE_STATE[rawState] ?? (phase ? [phase[0], phase[0] === "working" ? "Working" : phase[0] === "needs-you" ? "Needs you" : phase[0] === "finished" ? "Finished" : phase[0] === "failed" ? "Failed" : "Stopped", phase[1]] as [TaskState, string, Tone] : (["unknown", "Outcome not known", "warn"] as [TaskState, string, Tone]));
  const art = str(r.resultArtifact, 200);
  const id0 = str(r.id, 80) ?? "";
  // A coding job's result is its own page: the changes on its branch. The job state "completed" is only ever reached through the final check.
  const codingResult = coding && (rawState === "completed" || rawState === "awaiting_approval") ? { href: `/coding/${id0}?tab=changes`, label: "Open result", external: false } : null;
  const result = art ? { href: UUID.test(art) ? `/__computers/artifacts/${art}` : art, label: "Open result", external: !art.startsWith("/coding") } : codingResult;
  let [state, stateWord, tone] = known;
  // Never "finished" without something to show for it.
  if (state === "finished" && !result) { state = "unknown"; stateWord = "Ended, nothing to show"; tone = "warn"; }
  const blockerRaw = r.blocker;
  const blockerText = typeof blockerRaw === "string" ? blockerRaw : blockerRaw && typeof blockerRaw === "object" ? str((blockerRaw as { text?: unknown }).text, 220) : null;
  const account = str(r.account, 80);
  const model = str(r.model, 120);
  const open = !TERMINAL.includes(state);
  // What ran: each receipt's account and model (the builder's and the reviewer's), never only the last one.
  const receipts = Array.isArray(r.receipts) ? r.receipts.filter((x): x is { account?: unknown; model?: unknown; role?: unknown } => !!x && typeof x === "object") : [];
  const receiptLines = [...new Set(receipts.map((x) => {
    const who = typeof x.account === "string" && x.account ? accountWords(x.account) : null;
    const m = typeof x.model === "string" && x.model ? modelWords(x.model) : null;
    const role = typeof x.role === "string" && x.role ? `${x.role[0].toUpperCase()}${x.role.slice(1)}: ` : "";
    return m || who ? `${role}${[who, m].filter(Boolean).join(" · ")}` : "";
  }).filter(Boolean))];
  const branch = str(r.branch, 120);
  const commit = str(r.commit, 40);
  const notStarted = coding && (rawState === "draft" || rawState === "awaiting_confirmation");
  const codingLinks: BotTask["links"] = coding && (branch || commit)
    ? [{ label: branch ? `Changes on ${branch}` : "Changes", href: `/coding/${id0}?tab=changes` }, ...(r.tests ? [{ label: "Test results", href: `/coding/${id0}?tab=tests` }] : []), ...(r.review ? [{ label: "Review", href: `/coding/${id0}?tab=review` }] : [])]
    : [];
  return {
    id,
    source: "service",
    kind: coding ? "coding" : "computer",
    title: clip(title),
    state,
    stateWord,
    tone,
    startedAt: when(r.startedAt),
    endedAt: when(r.endedAt),
    ran: receiptLines.length ? { text: receiptLines.join("; "), used: true } : account || model ? { text: [account ? accountWords(account) : null, model ? modelWords(model) : null].filter(Boolean).join(" · "), used: true } : { text: "No model or account was recorded for this task.", used: false },
    progress: str(r.progress, 160),
    review: reviewWords(r.review),
    tests: testWords(r.tests),
    blocker: blockerText
      ? { text: blockerText, action: coding ? (rawState === "interrupted" ? { kind: "resume", label: "Resume" } : { kind: "link", href: `/coding/${id}`, label: notStarted ? "Open the job to start it" : "Open the job" }) : null }
      : coding && state === "failed" ? { text: "It failed before finishing. The job page has the reason and the way on.", action: { kind: "link", href: `/coding/${id}`, label: "See why" } } : null,
    result,
    outcomeNote: coding && state === "finished" ? `Finished${commit ? ` · commit ${commit.slice(0, 7)}` : ""}. The work is on ${branch ?? "its job branch"}; the job page shows whether it has been merged.` : null,
    links: codingLinks,
    jobHref: coding ? { href: `/coding/${id}`, label: "Open job" } : { href: `/activity#job-${id}`, label: "Open job" },
    notStarted,
    can: { cancel: open, resume: coding && ["needs_owner", "blocked_allowance", "interrupted"].includes(rawState) },
  };
}

/** Pure: newest first, one row per id (a job in two lists is one row). */
export function mergeTasks(...lists: BotTask[][]): BotTask[] {
  const byId = new Map<string, BotTask>();
  for (const t of lists.flat()) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0));
}

/** Pure: open work first (it is what needs a look), then the rest newest first. */
export function orderTasks(tasks: readonly BotTask[]): BotTask[] {
  const rank = (t: BotTask) => (t.state === "needs-you" ? 0 : taskIsOpen(t) ? 1 : 2);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0));
}

/** Pure: does this job belong to this bot's computer? (Personal PCs' jobs never match: the id must be the shared computer's.) */
export function jobIsOnComputer(job: Pick<JobSummary, "kind" | "targetDeviceId">, computerId: string | null): boolean {
  return !!computerId && job.kind === "control" && job.targetDeviceId === computerId;
}

export const botCanCode = (bot: Pick<Bot, "coding">) => bot.coding.enabled;

// ------------------------------------------------------------------ files

export type SavedFile = {
  id: string; title: string; summary: string; host: string; createdAt: string; outcome: string; main: string; files: { name: string; bytes: number }[]; computer: string;
  /** A coding job's output: its files are on a branch, opened on the job page (there is no saved copy to download). */
  coding?: { jobId: string; branch: string | null; commit: string | null; review: string | null; tests: string | null; files: { name: string; status: string | null }[] };
};

/** Pure: the bot's saved results (the hub keeps its own copy, so they open with the computer off). Newest first. */
export function botFiles(artifacts: readonly ArtifactMeta[], computer: string | null): SavedFile[] {
  return artifacts
    .filter((a) => !!computer && a.computer === computer)
    .map((a) => ({ id: a.id, title: a.title || "Saved result", summary: a.summary, host: a.host, createdAt: a.createdAt, outcome: a.outcome, main: a.main, files: a.files.map((f) => ({ name: f.name, bytes: f.bytes })), computer: a.computer }))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

/** Pure: GET /__agents/bots/:id/files rows ({ artifact, title, jobId, createdAt, files[] }) as saved files; unknown rows are dropped. */
export function serviceFiles(raw: unknown): SavedFile[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedFile[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const rawId = str(r.artifact, 80) ?? str(r.jobId, 80);
    if (!rawId) continue;
    // A computer result is addressed by its BARE job id (the artifacts route takes nothing else): the service labels it `artifact:<jobId>` (F-01).
    const id = r.source === "coding" ? rawId : (str(r.jobId, 80) ?? rawId.replace(/^artifact:/, ""));
    if (r.source === "coding") {
      // A coding job's files are on its branch: no bytes, no download, and no computer artefact to open (those links were broken).
      const jobId = str(r.jobId, 80) ?? id.replace(/^coding:/, "");
      const listed = Array.isArray(r.files) ? r.files.filter((f): f is { name: string; status?: unknown } => !!f && typeof (f as { name?: unknown }).name === "string").map((f) => ({ name: f.name, status: str(f.status, 20) })) : [];
      out.push({ id, title: str(r.title, 160) ?? "Coding job", summary: "", host: "", createdAt: when(r.createdAt) ?? "", outcome: "", main: listed[0]?.name ?? "", files: [], computer: "", coding: { jobId, branch: str(r.branch, 120), commit: str(r.commit, 40), review: reviewWords(r.review), tests: testWords(r.tests), files: listed } });
      continue;
    }
    const files = Array.isArray(r.files) ? r.files.filter((f): f is { name: string; bytes?: number } => !!f && typeof (f as { name?: unknown }).name === "string").map((f) => ({ name: f.name, bytes: typeof f.bytes === "number" ? f.bytes : 0 })) : [];
    out.push({ id, title: str(r.title, 160) ?? "Saved result", summary: str(r.summary, 300) ?? "", host: str(r.host, 80) ?? "", createdAt: str(r.createdAt, 40) ?? "", outcome: str(r.outcome, 40) ?? "", main: str(r.main, 80) ?? files[0]?.name ?? "", files, computer: "" });
  }
  return out.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

/** The saved result's page, or one of its files; `download` asks the hub to send it as a download (`?download=1`). */
export const fileHref = (id0: string, name?: string, download = false) => ((id) => name ? `/__computers/artifacts/${encodeURIComponent(id)}/f/${encodeURIComponent(name)}${download ? "?download=1" : ""}` : `/__computers/artifacts/${encodeURIComponent(id)}`)(id0.replace(/^artifact:/, ""));
export const fmtBytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
