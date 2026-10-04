import type { CodingJob } from "./contracts";

/**
 * Why a coding job is stopped, in one plain sentence, and what the next button does. Pure and
 * browser-safe (type-only imports): the Coding page, the job card, the readable view and Jarvis all
 * use it, so the words never disagree. Only the CURRENT cause counts: an error from an attempt that
 * already recovered, or a review of an older commit, never hides what is wrong now.
 */

/** An account slot as a person says it ("Claude Max 2"); never the slot id. Pure. */
export function accountWords(slot: string | null | undefined): string {
  if (!slot) return "an account that isn't reported";
  const claude = /^claude:max(?:-(\d+))?$/.exec(slot);
  if (claude) return `Claude Max${claude[1] ? ` ${claude[1]}` : ""}`;
  const codex = /^codex:openai-(\d+)$/.exec(slot);
  if (codex) return `Codex account ${codex[1]}`;
  if (slot === "model-router" || slot.startsWith("router")) return "a routed model";
  return slot;
}

/** A role id as a person says it: "builder-1" is "Builder", "builder-2" "Builder 2", "reviewer" "Reviewer"; no id is "The system". Pure. */
export function roleLabel(roleId: string | null | undefined): string {
  if (!roleId) return "The system";
  const m = /^([a-z-]+?)(?:-(\d+))?$/.exec(roleId);
  const base = (m?.[1] ?? roleId).replace(/-/g, " ");
  const name = base.charAt(0).toUpperCase() + base.slice(1);
  return m?.[2] && m[2] !== "1" ? `${name} ${m[2]}` : name;
}

export type BlockerKind =
  | "reviewer-unavailable" // the reviewer's route can't run (Codex paused, account exhausted, signed out)
  | "role-stopped" // a role stopped with its own error
  | "role-limit" // a builder or tester paused at its account's limit
  | "review-changes" // the independent review asked for fixes the builder can make
  | "review-missing-tests" // ...but part of it is tests the builder isn't allowed to write
  | "review-baseline-only" // ...and every serious finding is a test that already fails on the base commit
  | "review-unconfirmed" // the reviewer approved but never said whether a reviewer-confirmed done-when criterion is met
  | "tests-timed-out" // a check timed out at the head: the same tests, run again, can pass
  | "tests-failing" // a check fails at the head and the review didn't catch it: the builder gets the failure
  | "review-unassessed" // the reviewer couldn't assess
  | "gate-baseline" // only pre-existing test failures are left; the gate can be re-run
  | "gate-failed" // a completion check failed
  | "interrupted" // paused by the owner or by a restart; nothing was replayed
  | "stopped" // the owner stopped the whole job: it ends here and is not resumed
  | "failed" // the job ended in failure
  | "prepare-failed" // the job never got as far as its first builder (snapshot, baseline or worktree failed)
  | "integration-conflict" // the builders' branches touch the same lines
  | "outside-worktrees" // a checkout outside the job's worktrees changed while it ran
  | "checkout-changed" // a checkout the job must not touch changed during a role's turn: usually the owner's own commit, pull or edit
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
  /** What the next button would accept, when it accepts something (the checkout paths that moved), so the control itself can show it. */
  detail?: string;
};

/** What a role's error starts with when the canonical or live checkout moved during its turn (the snapshot guard, round 7). */
export const CHECKOUT_CHANGED = "A checkout this job must not touch changed while it ran";
export const isCheckoutChange = (message: string | null | undefined) => !!message && message.includes(CHECKOUT_CHANGED);

/** Gate check ids in words a person would say. Never pass the id through redaction: "pass: x-y-z" reads as a secret. */
const CHECK_WORDS: Record<string, string> = {
  "committed-and-clean": "everything committed and clean",
  ownership: "only owned files changed",
  "no-eol-only-churn": "no line-ending-only edits",
  "secret-scan": "no secrets in the change",
  "checks-pass": "the test commands pass",
  "review-approved-for-sha": "an independent review approved this commit",
  "done-when-evidenced": "every item under \"Done when\" has evidence",
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

/** The reviewer said approve but left a finding the final check refuses: a blocker, or a major with no owner acceptance (none can be given). */
export function approvedWithSeriousFindings(job: CodingJob): boolean {
  return job.review?.verdict === "approve" && sameSha(job.review.sha, job.headSha) && serious(job).length > 0;
}

/** A failure that also failed on the base commit, by name: the gate counts those as pre-existing, not as a fault of the change. */
const excused = (t: NonNullable<CodingJob["tests"]>[number]) => {
  const b = t.baseline;
  return !!b && b.exitCode !== 0 && !!t.failedTests?.length && !!b.failedTests && t.failedTests.every((n) => b.failedTests!.some((o) => o === n || (!(n.includes(" :: ") && o.includes(" :: ")) && bareTestName(n) === bareTestName(o))));
};

/**
 * What the final check rejected about the CHECKS at the head: timed out or missing (running them again can pass) and failing
 * (the builder has to fix something). Empty unless the gate itself failed on them, so a pre-existing failure never counts.
 */
export function headCheckProblems(job: CodingJob): { retest: string[]; failing: string[] } {
  const none = { retest: [] as string[], failing: [] as string[] };
  const gate = job.gate;
  if (!gate || !sameSha(gate.sha, job.headSha) || gate.checks.find((c) => c.check === "checks-pass")?.passed !== false) return none;
  const out = { retest: [] as string[], failing: [] as string[] };
  for (const id of job.spec?.checks ?? []) {
    const t = [...(job.tests ?? [])].reverse().find((x) => x.commandId === id && sameSha(x.sha, job.headSha));
    if (!t || t.timedOut) out.retest.push(id);
    else if (t.exitCode !== 0 && !excused(t)) out.failing.push(id);
  }
  return out;
}

/**
 * Checks whose latest run at the head timed out. A timeout is not a result: the reviewer (rightly) refuses to call it a pass and asks for
 * changes the builder cannot make, so the owner's way forward is to run the checks again, not to send the builder a repair (round 7).
 */
export function timedOutChecksAtHead(job: CodingJob): string[] {
  if (!job.headSha) return [];
  return (job.spec?.checks ?? []).filter((id) => {
    const t = [...(job.tests ?? [])].reverse().find((x) => x.commandId === id && sameSha(x.sha, job.headSha));
    return !!t?.timedOut;
  });
}

/** Reviewer-confirmed done-when criteria the approving review never marked as met (the gate has no other evidence for them). */
export function unconfirmedCriteria(job: CodingJob): { id: string; text: string }[] {
  const review = job.review;
  if (review?.verdict !== "approve" || !sameSha(review.sha, job.headSha)) return [];
  return (job.spec?.doneWhen ?? []).filter((d) => d.evidence === "reviewer-confirms" && !review.criteria.some((c) => c.criterionId === d.id && c.met)).map((d) => ({ id: d.id, text: d.text }));
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
      return { kind: "role-stopped", text: `${roleWords(stopped.role, stopped.roleId)} changed ${outside.length === 1 ? "a file" : `${outside.length} files`} it isn't allowed to change: ${fileList(outside)}. Revert ${outside.length === 1 ? "it" : "them"} in its working copy (or widen the plan's file ownership in a follow-up task), then retry the step.`, label: RETRY_LABEL[stopped.role] ?? "Retry this step", roleId: stopped.roleId };
    }
    if (isCheckoutChange(stopped.error!.message)) {
      const detail = stopped.error!.message.replace(/\s+/g, " ").trim().slice(0, 420);
      const moved = /\((.*)\)\.?\s*$/.exec(detail)?.[1] ?? detail;
      return { kind: "checkout-changed", text: `${detail} The agents are meant to work only in their own working copies, so this is your change (a commit, pull or edit), or an agent's if one broke that rule: look at the paths. Retrying as it is would stop in the same place: accept the change (it is recorded on the job) and ${roleWords(stopped.role, stopped.roleId).toLowerCase()} runs again, or stop the job.`, label: "Accept the change and retry", roleId: stopped.roleId, detail: moved };
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
    if (because.code === "input_declined") return { kind: "interrupted", text: `${msg} Resume starts that step again on a fresh turn; it asks again if it still needs this.`, label: "Resume", roleId: null };
    if (because.code === "restart") return { kind: "interrupted", text: `${msg} Resume continues from the step that isn't done; everything that finished is kept.`, label: "Resume", roleId: null };
    if (because.code === "prepare_failed") return { kind: "prepare-failed", text: `The job couldn't get ready to start: ${msg.replace(/[.\s]+$/, "")}. No agent ran and nothing in your project was changed. Fix that, then start it again; it begins from the beginning.`, label: "Start it again", roleId: null };
    if (because.code === "integration_conflict") return { kind: "integration-conflict", text: `The builders' changes conflict and nothing was merged for you (${msg.replace(/^Integrating \S+ conflicted on /, "").replace(/; nothing was resolved automatically\.?$/, "")}). Fix the conflict by hand in the job's working copies and retry, or stop this job and draft it again with the builders on separate files.`, label: "Retry the merge", roleId: null };
    if (because.code === "outside_worktrees") return { kind: "outside-worktrees", text: `Something outside the job's own working copies changed while it ran (${msg}). Nothing was rolled back, because other work lives there. Check those paths, then re-run the final check. If the change is yours (a commit, pull or edit), or you are content with an agent's, accept it first; the acceptance is recorded on the job.`, label: "Accept the change and re-run the gate", roleId: null, detail: msg };
    if (because.code === "repair_no_change") return { kind: "repair-no-change", text: `${msg} ${/failing tests/.test(msg) ? "The failing tests are" : "The review findings are"} still open. Resume sends ${/failing tests/.test(msg) ? "them" : "them"} to the builder again.`, label: "Send the findings again", roleId: null };
    if (because.code === "apply_failed") return { kind: "apply-failed", text: `The approved merge did not happen: ${msg}. The job itself is still verified and unchanged. Fix that, then ask for the merge again from the job's Result.`, label: "Re-check the job, then ask for the merge again", roleId: null };
    return { kind: "unexpected", text: `The coding system hit an error between steps: ${msg}. Resume retries from that step; nothing that already finished is repeated.`, label: "Resume", roleId: null };
  }
  const cancelledRole = latestRuns.find((r) => r.state === "cancelled" && r.history.at(-1)?.reason === "owner_cancel");
  if (cancelledRole && job.state === "needs_owner" && !job.review) {
    return { kind: "role-cancelled", text: `You stopped the ${roleWords(cancelledRole.role, cancelledRole.roleId).replace(/^The /, "")}. Resume starts that step again; everything that already finished is kept.`, label: RETRY_LABEL[cancelledRole.role] ?? "Retry this step", roleId: cancelledRole.roleId };
  }
  const timedOut = timedOutChecksAtHead(job);
  if (timedOut.length && ["needs_owner", "blocked_allowance", "interrupted"].includes(job.state)) {
    return { kind: "tests-timed-out", text: `${timedOut.join(", ")} timed out at this commit, and a timeout is not a pass, so nothing past the tests can be confirmed. Running ${timedOut.length === 1 ? "it" : "them"} again changes nothing else; the build is kept${sameSha(job.review?.sha, job.headSha) && job.review?.verdict !== "approve" ? " and a fresh review follows" : ""}.`, label: "Run the tests again", roleId: null };
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
    if (approvedWithSeriousFindings(job)) {
      const n = serious(job).length;
      return { kind: "review-changes", text: `The reviewer approved but left ${count(n, "serious finding")}, and the final check won't pass with those open. Resume sends them back to the builder, then runs fresh tests and a fresh review.`, label: "Fix review findings", roleId: null };
    }
    if (review.verdict === "cannot-assess") return { kind: "review-unassessed", text: "The reviewer couldn't assess the work. Only the review is retried; the build is kept.", label: "Retry review", roleId: "reviewer" };
  }
  const failed = job.gate && sameSha(job.gate.sha, job.headSha) ? job.gate.checks.filter((c) => !c.passed) : [];
  if (failed.length) {
    const onlyEvidence = failed.every((c) => c.check === "done-when-evidenced");
    const unconfirmed = onlyEvidence ? unconfirmedCriteria(job) : [];
    if (unconfirmed.length && !(job.gate!.baselineFailures?.length ?? 0)) {
      return { kind: "review-unconfirmed", text: `The reviewer approved but never confirmed ${unconfirmed.length === 1 ? "this done-when item" : "these done-when items"}: ${unconfirmed.map((c) => c.text).join("; ").slice(0, 200)}. Only the review is retried, and it is asked to say yes or no to each.`, label: "Retry review", roleId: "reviewer" };
    }
    if (onlyEvidence && (job.gate!.baselineFailures?.length ?? 0) > 0) {
      const names = baselineFailedNames(job);
      return { kind: "gate-baseline", text: `Only pre-existing test failures are left${names.length ? ` (${names.map(bareTestName).join("; ").slice(0, 160)})` : ""}. They fail on the base commit too, so the gate can count them as evidence with a baseline.`, label: "Re-run the final check", roleId: null };
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
      // Re-running only the gate re-reads the same results: say what actually changes them (round 7).
      const probs = tests && !outside ? headCheckProblems(job) : { retest: [] as string[], failing: [] as string[] };
      const hasBuilder = (job.spec?.roles ?? []).some((r) => r.role === "builder" && r.agent);
      const kind: BlockerKind = probs.retest.length ? "tests-timed-out" : probs.failing.length && hasBuilder ? "tests-failing" : "gate-failed";
      const label = kind === "tests-timed-out" ? "Run the tests again" : kind === "tests-failing" ? "Fix the failing tests" : "Re-run the final check";
      const how = kind === "tests-timed-out" ? " Running them again changes nothing else; the build and review are kept." : kind === "tests-failing" ? " Resume sends the failure to the builder, then runs fresh tests and a fresh review." : "";
      return { kind, text: (parts.join(". ") + (rest.length ? `. Also waiting on: ${rest.join("; ")}` : "") + "." + how).slice(0, 560), label, roleId: null };
    }
    return { kind: "gate-failed", text: `The final check is waiting on: ${failed.map((c) => gateCheckWords(c.check)).join("; ")}.${failed[0] ? ` ${failed[0].detail}` : ""}`.replace(/\s+/g, " ").slice(0, 400), label: "Re-run the final check", roleId: null };
  }
  if (job.state === "cancelled" && !job.supersededBy) {
    const at = [...(job.runs ?? [])].reverse().find((r) => r.state === "cancelled" || r.state === "interrupted");
    return { kind: "stopped", text: `You stopped this job${at ? ` while the ${roleWords(at.role, at.roleId).replace(/^The /, "").toLowerCase()} was working` : ""}. It can't be resumed; its working copies and history are kept. If the work is still wanted, draft it again.`, label: "Draft it again", roleId: null };
  }
  if (job.state === "failed") {
    const why = job.stoppedBecause?.message ?? [...(job.runs ?? [])].reverse().find((r) => r.error)?.error?.message ?? null;
    return { kind: "failed", text: `The job failed${why ? `: ${readableTimes(plainError(why))}` : " before it could say why. Open the progress log for the last steps"}. Nothing was changed in your project. A failed job can't be resumed: draft it again once that is fixed.`, label: "Draft it again", roleId: null };
  }
  if (job.state === "interrupted") {
    const paused = latestRuns.find((r) => r.state === "interrupted");
    const why = paused?.history.at(-1)?.reason === "owner_interrupt" ? `You paused the ${roleWords(paused.role, paused.roleId).replace(/^The /, "")}.` : paused ? `The ${roleWords(paused.role, paused.roleId).replace(/^The /, "")} was stopped part-way, by a restart or by the harness protecting your files.` : "The job was paused part-way.";
    return { kind: "interrupted", text: `${why} Nothing was replayed. Resume continues from the step that isn't done; everything that finished is kept.`, label: "Resume", roleId: paused?.roleId ?? null };
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
  if (job.state === "cancelled" || job.state === "failed") return codingBlocker(job).label;
  if (!["needs_owner", "blocked_allowance", "interrupted"].includes(job.state)) return "Resume";
  if (job.state === "interrupted") return "Resume";
  const b = codingBlocker(job);
  // A role paused at its account's limit: moving it names the new account ("Retry review on Claude Max 2"); staying put is a plain Resume after the reset.
  if (moveTo && b.roleId && (b.kind === "reviewer-unavailable" || b.kind === "role-stopped" || b.kind === "role-limit" || b.kind === "review-unassessed")) return `${b.label} on ${moveTo}`;
  if (job.state !== "needs_owner") return "Resume";
  return b.label;
}
