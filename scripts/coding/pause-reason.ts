import type { CodingJob } from "./contracts";

/**
 * Why a coding job is stopped, in one plain sentence, and what the next button does. Pure and
 * browser-safe (type-only imports): the Coding page, the job card, the readable view and Jarvis all
 * use it, so the words never disagree. Only the CURRENT cause counts: an error from an attempt that
 * already recovered, or a review of an older commit, never hides what is wrong now.
 */

export type BlockerKind =
  | "reviewer-unavailable" // the reviewer's route can't run (Codex paused, account exhausted, signed out)
  | "role-stopped" // a role stopped with its own error
  | "role-limit" // a builder or tester paused at its account's limit
  | "review-changes" // the independent review asked for fixes the builder can make
  | "review-missing-tests" // ...but part of it is tests the builder isn't allowed to write
  | "review-baseline-only" // ...and every serious finding is a test that already fails on the base commit
  | "review-unassessed" // the reviewer couldn't assess
  | "gate-baseline" // only pre-existing test failures are left; the gate can be re-run
  | "gate-failed" // a completion check failed
  | "integration-conflict" // the builders' branches touch the same lines
  | "outside-worktrees" // a checkout outside the job's worktrees changed while it ran
  | "unexpected" // the harness itself hit an error between steps
  | "repair-no-change" // a repair pass in which no writer committed anything
  | "apply-failed" // an approved merge did not happen
  | "role-cancelled" // the owner stopped one role and left the job
  | "other";

export type Blocker = {
  kind: BlockerKind;
  /** The ONE current blocker, in plain words. */
  text: string;
  /** What the next button does, exactly. */
  label: string;
  /** The role the next button acts on (set when that role can be moved to another account). */
  roleId: string | null;
};

/** Gate check ids in words a person would say. Never pass the id through redaction: "pass: x-y-z" reads as a secret. */
const CHECK_WORDS: Record<string, string> = {
  "committed-and-clean": "everything committed and clean",
  ownership: "only owned files changed",
  "no-eol-only-churn": "no line-ending-only edits",
  "secret-scan": "no secrets in the change",
  "checks-pass": "the test commands pass",
  "review-approved-for-sha": "an independent review approved this commit",
  "done-when-evidenced": "every done-when criterion has evidence",
  "receipts-recorded": "every agent run has a usage receipt",
};
export const gateCheckWords = (check: string) => CHECK_WORDS[check] ?? check.replace(/-/g, " ");

const ROLE_WORDS: Record<string, string> = { reviewer: "The reviewer", builder: "The builder", "test-author": "The test author", tester: "The tester" };
const roleWords = (role: string, roleId: string) => ROLE_WORDS[role] ?? `${roleId[0]?.toUpperCase() ?? ""}${roleId.slice(1)}`;
const RETRY_LABEL: Record<string, string> = { reviewer: "Retry review", builder: "Retry the build", "test-author": "Retry the test author" };

const UNAVAILABLE = /\b(?:paused|isolation|limit|window|exhaust\w*|allowance|resets?|isn't signed in|isn't a Claude account|not signed in|unavailable|quota)\b/i;

/** An ISO time inside a message as a person would say it ("Mon 5 Oct, 12:00 pm"), so a reset time reads. */
export function readableTimes(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)\b/g, (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  });
}

/** The first sentence of an agent error, bounded, with file-system detail dropped (those lists are long and not the point). */
function plainError(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  const paused = /Codex roles are paused/i.test(flat);
  if (paused) return "Codex is paused because its sandbox could still read your credential folders, so it can't run this role until that is fixed";
  // The CLI's own words for a sign-in refresh that lost a race with another Claude Code process (seen on the real hub, 2 Oct).
  if (/Failed to refresh OAuth token/i.test(flat)) return "Claude couldn't refresh its sign-in because another Claude Code process was refreshing it at the same time. That is usually transient, so trying again in a minute normally works; if it keeps happening, close other Claude Code sessions or sign that account in again";
  // "Claude did not complete this turn (the real cause ...)": the parenthesis IS the cause, so keep its start rather than dropping it.
  const cause = /^(Claude did not complete this turn) \((?:success |error )?([^)]{10,})\)/.exec(flat);
  if (cause) return `${cause[1]}: ${cause[2].replace(/\s*\bIts native session is kept.*$/i, "").slice(0, 160).replace(/[.\s]+$/, "")}`;
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  const cut = first.replace(/\s*\([^)]{60,}\)?/g, "").replace(/:\s.{140,}$/, "");
  return (cut.length > 200 ? `${cut.slice(0, 197)}...` : cut).replace(/[.\s]+$/, "");
}

/** The files named in an ownership stop ("changed files it doesn't own: a, b; ..."), whole, in order. Empty when the message names none. */
export function ownershipFiles(message: string): string[] {
  const m = /changed files it doesn't own:\s*([^;]*)/i.exec(message.replace(/\s+/g, " "));
  return m ? m[1].split(",").map((f) => f.trim()).filter(Boolean) : [];
}

/** "a, b and c" for a short list; the first ten and a count for a long one. Never cuts a name. */
const fileList = (files: readonly string[]) => (files.length <= 10 ? files.join(", ") : `${files.slice(0, 10).join(", ")} and ${files.length - 10} more`);

const sameSha = (a: string | null | undefined, b: string | null | undefined) => !!a && a === b;

/** Test names that also failed on the job's base commit (from the base run, or the baseline attached to a head run). */
export function baselineFailedNames(job: CodingJob): string[] {
  const names = new Set<string>();
  const base = job.spec?.repo?.baseSha;
  for (const t of job.tests ?? []) {
    if (sameSha(t.sha, base)) for (const n of t.failedTests ?? []) names.add(n);
    for (const n of t.baseline?.failedTests ?? []) names.add(n);
  }
  for (const b of job.gate?.baselineFailures ?? []) for (const n of b.names ?? []) names.add(n);
  return [...names];
}

/** A failing test's name without the `file :: ` prefix the gate adds so same-named tests in different files stay distinct. */
export const bareTestName = (name: string) => name.replace(/^.*? :: /, "");

/** A route that costs money per token (OpenRouter). Shared by the draft page, the account edit and Resume. */
export const isPaidBinding = (b: { model?: string | null } | null | undefined) => !!b?.model && b.model.startsWith("openrouter/");

/** Does this text name one of the baseline-failing tests (whole name, or its last ` > ` segment)? Then fixing it IS the task. */
export function namesBaselineTest(text: string, names: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return names.some((n) => {
    const bare = bareTestName(n).toLowerCase();
    const last = bare.split(" > ").pop()!.trim();
    return (bare.length >= 5 && hay.includes(bare)) || (last.length >= 12 && hay.includes(last));
  });
}

const serious = (job: CodingJob) => (job.review?.findings ?? []).filter((f) => f.severity === "major" || f.severity === "blocker");
const mentions = (message: string, names: readonly string[]) => names.some((n) => { const b = bareTestName(n); return b.length >= 12 && message.includes(b.slice(0, 50)); });

/** Every serious finding is about a test that already fails on the base commit. Only then is a fresh review (not a rebuild) right. */
export function reviewIsBaselineOnly(job: CodingJob): boolean {
  if (job.review?.verdict !== "request-changes" || !sameSha(job.review.sha, job.headSha)) return false;
  const names = baselineFailedNames(job);
  // A task whose point is fixing one of those tests is not "only a baseline failure".
  if (namesBaselineTest([job.spec?.objective ?? "", ...(job.spec?.doneWhen ?? []).map((d) => d.text)].join("\n"), names)) return false;
  const found = serious(job);
  return !!names.length && found.length > 0 && found.every((f) => mentions(f.message, names));
}

const TEST_FILE = /(?:^|[\\/._-])(?:tests?|specs?|__tests__)(?:[\\/._-]|$)|\.(?:test|spec)\./i;
/** The review wants tests, and no writing role may add a test file (the ownership in the confirmed plan has none). */
export function reviewNeedsTestsOutsideScope(job: CodingJob): boolean {
  if (job.review?.verdict !== "request-changes" || !sameSha(job.review.sha, job.headSha)) return false;
  const roles = job.spec?.roles ?? [];
  const writers = roles.filter((r) => (r.role === "builder" || r.role === "test-author") && r.agent);
  if (!writers.length) return false;
  if (writers.some((r) => r.role === "test-author" || [...r.owns.globs, ...r.owns.newFiles].some((p) => TEST_FILE.test(p)))) return false;
  const names = baselineFailedNames(job);
  const asksForTests = (text: string) => /\b(?:no|missing|without|add|adding|lack\w*|not (?:added|committed))\b[^.]{0,60}\btests?\b|\btests?\b[^.]{0,40}\b(?:missing|not added|not committed|were not|are missing)/i.test(text) && !mentions(text, names);
  return serious(job).some((f) => asksForTests(f.message)) || (job.review.criteria ?? []).some((c) => !c.met && asksForTests(c.note));
}

/** The first failing test at the job's head and what it said (name, then the assertion), or null. Bounded. */
export function failingTestWords(job: CodingJob): string | null {
  const run = (job.tests ?? []).filter((t) => sameSha(t.sha, job.headSha) && t.exitCode !== 0 && !t.timedOut).at(-1);
  if (!run) return null;
  const f = run.failures?.[0];
  const name = f ? bareTestName(f.name) : run.failedTests?.[0] ? bareTestName(run.failedTests[0]) : null;
  if (!name) return null;
  const failed = run.counts?.failed ?? 1;
  return `${name}${f?.assertion ? `: ${f.assertion}` : ""}${failed > 1 ? `, and ${failed - 1} more` : ""}`.slice(0, 300);
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The one current blocker and what the next button does. */
export function codingBlocker(job: CodingJob): Blocker {
  const seen = new Set<string>();
  const latestRuns = [...(job.runs ?? [])].reverse().filter((r) => {
    if (seen.has(r.roleId)) return false;
    seen.add(r.roleId);
    return true;
  });
  const stopped = latestRuns.find((r) => r.error && !["succeeded", "running", "starting"].includes(r.state));
  if (stopped) {
    const outside = stopped.error!.code === "ownership_violation" ? ownershipFiles(stopped.error!.message) : [];
    if (outside.length) {
      return { kind: "role-stopped", text: `${roleWords(stopped.role, stopped.roleId)} changed ${outside.length === 1 ? "a file" : `${outside.length} files`} it isn't allowed to change: ${fileList(outside)}. Revert ${outside.length === 1 ? "it" : "them"} in the worktree (or widen the plan's file ownership in a follow-up task), then retry the step.`, label: RETRY_LABEL[stopped.role] ?? "Retry this step", roleId: stopped.roleId };
    }
    const why = readableTimes(plainError(stopped.error!.message));
    if (stopped.role !== "reviewer" && (stopped.state === "blocked_allowance" || stopped.error!.code === "limit_reached")) {
      const unknownReset = /resetting/i.test(stopped.error!.message) ? "" : " (the reset time is unknown, so the account is treated as free again after about 5 hours)";
      return { kind: "role-limit", text: `${roleWords(stopped.role, stopped.roleId)} can't run: ${why}${unknownReset}. Nothing was lost and nothing reruns by itself. Move this step to another connected account, or Resume after the reset.`, label: RETRY_LABEL[stopped.role] ?? "Retry this step", roleId: stopped.roleId };
    }
    if (stopped.role === "reviewer" && (stopped.state === "blocked_allowance" || UNAVAILABLE.test(stopped.error!.message))) {
      return { kind: "reviewer-unavailable", text: `The reviewer can't run: ${why}. Nothing has been lost; the build and tests are kept. Move the review to an available account.`, label: "Retry review", roleId: stopped.roleId };
    }
    const next = stopped.error!.code === "signed_out" ? " Sign that account in again, or move this step to another connected account." : " Retrying runs only this step; everything that already finished is kept.";
    return { kind: "role-stopped", text: `${roleWords(stopped.role, stopped.roleId)} stopped: ${why}.${next}`, label: RETRY_LABEL[stopped.role] ?? "Retry this step", roleId: stopped.roleId };
  }
  const because = job.stoppedBecause;
  if (because && ["needs_owner", "interrupted"].includes(job.state)) {
    const msg = because.message.replace(/\s+/g, " ").trim().slice(0, 300);
    if (because.code === "integration_conflict") return { kind: "integration-conflict", text: `The builders' changes conflict and nothing was merged for you (${msg.replace(/^Integrating \S+ conflicted on /, "").replace(/; nothing was resolved automatically\.?$/, "")}). Fix the conflict by hand in the job's worktrees and retry, or stop this job and draft it again with the builders on separate files.`, label: "Retry the merge", roleId: null };
    if (because.code === "outside_worktrees") return { kind: "outside-worktrees", text: `Something outside the job's own worktrees changed while it ran (${msg}). Nothing was rolled back, because other work lives there. Check those paths, then re-run the done gate.`, label: "Re-run the done gate", roleId: null };
    if (because.code === "repair_no_change") return { kind: "repair-no-change", text: `${msg} The review findings are still open. Resume sends them to the builder again.`, label: "Send the findings again", roleId: null };
    if (because.code === "apply_failed") return { kind: "apply-failed", text: `The approved merge did not happen: ${msg}. The job itself is still verified and unchanged. Fix that, then ask for the merge again from the job's Result.`, label: "Re-check the job, then ask for the merge again", roleId: null };
    return { kind: "unexpected", text: `The harness hit an error between steps: ${msg}. Resume retries from that step; nothing that already finished is repeated.`, label: "Resume", roleId: null };
  }
  const cancelledRole = latestRuns.find((r) => r.state === "cancelled" && r.history.at(-1)?.reason === "owner_cancel");
  if (cancelledRole && job.state === "needs_owner" && !job.review) {
    return { kind: "role-cancelled", text: `You stopped the ${roleWords(cancelledRole.role, cancelledRole.roleId).replace(/^The /, "")}. Resume starts that step again; everything that already finished is kept.`, label: RETRY_LABEL[cancelledRole.role] ?? "Retry this step", roleId: cancelledRole.roleId };
  }
  if (sameSha(job.review?.sha, job.headSha)) {
    const review = job.review!;
    if (review.verdict === "request-changes") {
      const n = serious(job).length;
      if (reviewIsBaselineOnly(job)) {
        const names = baselineFailedNames(job);
        return { kind: "review-baseline-only", text: `The review rejected this only over ${count(names.length, "test")} that already ${names.length === 1 ? "fails" : "fail"} on the base commit (${names.map(bareTestName).join("; ").slice(0, 160)}). The change itself was not faulted. A fresh review can be told that.`, label: "Retry review with the baseline", roleId: null };
      }
      if (reviewNeedsTestsOutsideScope(job)) {
        return { kind: "review-missing-tests", text: `The review wants tests committed, but the builder may only change ${ownedList(job)}, so it can't add them. Resuming sends it the other findings only. To get the tests, widen the plan's file ownership in a follow-up task.`, label: "Fix the findings the builder can reach", roleId: null };
      }
      const failing = failingTestWords(job);
      return { kind: "review-changes", text: `Review needs fixes${n ? ` (${count(n, "serious finding")})` : ""}${failing ? ` and the tests fail at this commit: ${failing}` : ""}. Resume sends them back to the builder.`, label: "Fix review findings", roleId: null };
    }
    if (review.verdict === "cannot-assess") return { kind: "review-unassessed", text: "The reviewer couldn't assess the work. Only the review is retried; the build is kept.", label: "Retry review", roleId: "reviewer" };
  }
  const failed = job.gate && sameSha(job.gate.sha, job.headSha) ? job.gate.checks.filter((c) => !c.passed) : [];
  if (failed.length) {
    const onlyEvidence = failed.every((c) => c.check === "done-when-evidenced");
    if (onlyEvidence && (job.gate!.baselineFailures?.length ?? 0) > 0) {
      const names = baselineFailedNames(job);
      return { kind: "gate-baseline", text: `Only pre-existing test failures are left${names.length ? ` (${names.map(bareTestName).join("; ").slice(0, 160)})` : ""}. They fail on the base commit too, so the gate can count them as evidence with a baseline.`, label: "Re-run the done gate", roleId: null };
    }
    // The two a person most often hits get a sentence of their own: files the role may not change, and tests that fail now.
    const outside = failed.find((c) => c.check === "ownership");
    const tests = failed.find((c) => c.check === "checks-pass");
    if (outside || tests) {
      const parts: string[] = [];
      if (outside) {
        const files = outside.detail.replace(/^outside ownership:[ \t]*/, "").trim();
        parts.push(`The change touches files the builder isn't allowed to change (${files}). They have to be reverted, or the plan's file ownership widened in a follow-up task`);
      }
      if (tests) parts.push(`The tests don't pass: ${tests.detail.replace(/[ \t\r\n]+/g, " ").trim()}${failingTestWords(job) ? ` (${failingTestWords(job)})` : ""}`);
      const rest = failed.filter((c) => c !== outside && c !== tests).map((c) => gateCheckWords(c.check));
      return { kind: "gate-failed", text: (parts.join(". ") + (rest.length ? `. Also waiting on: ${rest.join("; ")}` : "") + ".").slice(0, 500), label: "Re-run the done gate", roleId: null };
    }
    return { kind: "gate-failed", text: `The done gate is waiting on: ${failed.map((c) => gateCheckWords(c.check)).join("; ")}.${failed[0] ? ` ${failed[0].detail}` : ""}`.replace(/\s+/g, " ").slice(0, 400), label: "Re-run the done gate", roleId: null };
  }
  return { kind: "other", text: `The job stopped in "${job.state.replace(/_/g, " ")}" with no recorded fault. Open its Progress tab to read the last steps, then Resume to continue from the step that isn't done.`, label: "Resume", roleId: null };
}

function ownedList(job: CodingJob): string {
  const paths = (job.spec?.roles ?? []).filter((r) => r.role === "builder" && r.agent).flatMap((r) => [...r.owns.globs, ...r.owns.newFiles]);
  const names = [...new Set(paths.map((p) => p.split(/[\\/]/).pop() ?? p))];
  return names.length ? names.join(" and ") : "its owned files";
}

/** Explain the current stop, not an error from an earlier attempt that already recovered. */
export function codingPauseReason(job: CodingJob): string {
  return codingBlocker(job).text;
}

/**
 * The next button's label. `moveTo` is the account a reviewer retry will run on when the owner chose to move it
 * ("Claude Max 2"); without it the retry stays on the same account.
 */
export function codingResumeLabel(job: CodingJob, moveTo?: string | null): string {
  if (!["needs_owner", "blocked_allowance", "interrupted"].includes(job.state)) return "Resume";
  if (job.state === "interrupted") return "Resume";
  const b = codingBlocker(job);
  // A role paused at its account's limit: moving it names the new account ("Retry review on Claude Max 2"); staying put is a plain Resume after the reset.
  if (moveTo && b.roleId && (b.kind === "reviewer-unavailable" || b.kind === "role-stopped" || b.kind === "role-limit" || b.kind === "review-unassessed")) return `${b.label} on ${moveTo}`;
  if (job.state !== "needs_owner") return "Resume";
  return b.label;
}
