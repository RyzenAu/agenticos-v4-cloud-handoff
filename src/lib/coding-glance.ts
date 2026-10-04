// What one Coding job answers at a glance, as plain data (no React): the task in a sentence, who runs each role
// (asked for vs what the receipts report), what has finished, the ONE current blocker, and the next button.
// Built only from the server's job record and readable view; a field that wasn't reported says so, never a guess.
import { accountWords, codingBlocker, codingResumeLabel, type Blocker } from "../../scripts/coding/pause-reason";
import { modelLabel, type CodingAccounts, type CodingAccount, type CodingJob, type JobView } from "./coding-client";

/** "Claude Max 2", "Codex account 1", "a routed model" from an account slot. */
export { accountWords };

/** The task in one sentence: the objective's first sentence, bounded. */
export function taskSentence(objective: string): string {
  const flat = objective.replace(/\s+/g, " ").trim();
  const first = flat.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? flat;
  const base = first.length > 200 ? `${first.slice(0, 197).replace(/\s+\S*$/, "")}...` : first;
  return base.replace(/[.\s]+$/, "") + ".";
}

export type RoleRow = {
  roleId: string;
  role: string;
  /** What the plan (or the owner's move) asked for. */
  asked: string;
  /** What the receipts say ran; null until something has run. */
  reported: string | null;
  /** The account/model reported differ from those asked for. */
  differs: boolean;
  state: string | null;
};

const ROLE_NAME: Record<string, string> = { builder: "Builder", reviewer: "Reviewer", "test-author": "Test author" };
const where = (slot: string | null | undefined, model: string | null | undefined) => `${accountWords(slot)} · ${model ? modelLabel({ model } as never) : "model not reported"}`;

export function roleRows(view: JobView): RoleRow[] {
  const job = view.job;
  const runs = view.readable?.progress.runs ?? [];
  return job.spec.roles.filter((r) => r.agent).map((r) => {
    const run = [...runs].reverse().find((x) => x.roleId === r.roleId) ?? null;
    const bound = run?.who ?? r.agent!;
    const attempt = run?.attempts.filter((a) => a.outcome !== "did_not_run").at(-1) ?? null;
    const asked = where(bound.accountSlot, bound.model);
    const reportedModel = attempt?.reportedModel ?? null;
    const reported = attempt ? where(attempt.account, reportedModel) : null;
    const routed = bound.route === "model-router";
    const differs = !!attempt && !routed && !!reportedModel && (reportedModel !== bound.model || (!!attempt.account && attempt.account !== bound.accountSlot));
    return { roleId: r.roleId, role: ROLE_NAME[r.role] ?? r.role, asked: routed ? `a routed model · ${bound.model}` : asked, reported, differs, state: run?.state ?? null };
  });
}

/** What has finished, in short sentences, from the readable phases. */
export function finishedLines(view: JobView): string[] {
  const r = view.readable;
  if (!r) return [];
  const lines: string[] = [];
  const phase = (id: string) => r.progress.phases.find((p) => p.id === id)?.status;
  if (phase("building") === "done") lines.push(r.diff ? `Built: ${r.diff.totals.files} file${r.diff.totals.files === 1 ? "" : "s"} changed (${r.diff.headShort ?? "committed"}).` : "Built.");
  if (phase("testing") === "done" && r.tests.latest) {
    const t = r.tests.atHead;
    const l = r.tests.latest;
    if (t?.counted) lines.push(`Tests at that commit: ${t.passed} passed, ${t.failed} failed${t.timedOut ? `, and ${t.timedOut} check${t.timedOut === 1 ? "" : "s"} timed out (a timeout is not a pass)` : ""}.`);
    else if (t) lines.push(`Tests ran at that commit and ${t.allExitZero ? "passed" : "failed"}; the run did not report counts.`);
    else if (l.passed !== null || l.failed !== null) lines.push(`Tests are from an earlier commit, not this one: ${l.passed ?? 0} passed, ${l.failed ?? 0} failed.`);
    else lines.push(`Tests are from an earlier commit, not this one, and that run did not report counts.`);
  }
  if (r.review) lines.push(r.review.verdict === "approve" ? "Independent review: approved." : r.review.verdict === "request-changes" ? `Independent review: asked for changes (${r.review.findings.length} finding${r.review.findings.length === 1 ? "" : "s"}).` : "Independent review: couldn't assess.");
  if (r.progress.state === "completed") lines.push("Final check: passed.");
  return lines;
}

export type AccountChoice = { key: string; route: "claude-code-cli" | "codex-app-server"; accountSlot: string; accountLabel: string; model: string; same: boolean; recommended: boolean };

const weeklyFull = (a: CodingAccount) => "allowance" in a && !!a.allowance && (a.allowance.limitReached || a.allowance.windows.some((w) => (w.usedPercent ?? 0) >= 100));

/** Which accounts can run a role right now. Unknown readings are not "available by default" for Codex: isolation must be applied. */
export function accountAvailable(a: CodingAccount, accounts: CodingAccounts): boolean {
  if (!a.installed) return false;
  if (a.accountSlot.startsWith("claude:")) {
    const c = a as Extract<CodingAccount, { allowance: unknown }>;
    if ("connection" in c && c.connection?.state === "signed-out") return false;
    return !weeklyFull(a);
  }
  if (accounts.codexIsolation && accounts.codexIsolation.state !== "protected") return false;
  const reading = "reading" in a ? a.reading : null;
  return !(reading && reading.peakPercent !== null && reading.peakPercent >= 100);
}

const PREFERRED_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1"];

/**
 * The choices offered when a role's route can't run: only available accounts, only models different from the
 * builder's (a reviewer is never the builder's own model), default Claude Max 2 on a model that differs from the builder.
 * `current` (the role's own account) is offered first only when it is itself available.
 */
/** What a role is ACTUALLY on now: its latest run's binding (a move made earlier sticks), else the plan's. */
export function bindingNow(job: CodingJob, roleId: string) {
  const run = [...job.runs].reverse().find((r) => r.roleId === roleId);
  return run?.binding ?? job.spec.roles.find((r) => r.roleId === roleId)?.agent ?? null;
}

/**
 * The accounts any of this job's runs was stopped on at a limit, while that limit still holds: the weekly or 5-hour
 * window is the ACCOUNT's, so no other model on it helps, whichever role hit it. The reset time comes from the run's own
 * error; no reset time = still held. (Round 6: the page offered Fable and Haiku on the account that had just hit its weekly limit.)
 */
/** How long an account stays excluded when its limit message gave no reset time. */
export const UNKNOWN_RESET_HOLD_MS = 5 * 60 * 60_000;

export function limitedSlots(job: CodingJob, now: number = Date.now(), events: readonly { type: string; at?: string; payload?: unknown }[] = []): Set<string> {
  const out = new Set<string>();
  const RESET = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
  // No reset time in the message: held for a bounded while from when it stopped (a limit with no end would lock the account out of the job for good).
  const hold = (slot: string, message: string | undefined, at: string | undefined) => {
    const reset = RESET.exec(message ?? "")?.[1];
    if (reset) { if (Date.parse(reset) > now) out.add(slot); return; }
    const since = at ? Date.parse(at) : NaN;
    if (Number.isNaN(since) || now - since < UNKNOWN_RESET_HOLD_MS) out.add(slot);
  };
  for (const run of job.runs) if (run.state === "blocked_allowance" || run.error?.code === "limit_reached") hold(run.binding.accountSlot, run.error?.message, run.history.at(-1)?.at);
  // A resumed run keeps one record, so the account it was stopped on is also read from the job's own log ("Account at its limit: <slot>").
  for (const e of events) {
    if (e.type !== "step") continue;
    const p = e.payload as { label?: string; detail?: string } | undefined;
    const m = /^Account at its limit: (\S+)$/.exec(p?.label ?? "");
    if (m) hold(m[1], p?.detail, e.at);
  }
  return out;
}

export function reassignChoices(job: CodingJob, roleId: string, accounts: CodingAccounts, now: number = Date.now(), events: readonly { type: string; at?: string; payload?: unknown }[] = []): { options: AccountChoice[]; defaultKey: string | null } {
  const role = job.spec.roles.find((r) => r.roleId === roleId);
  if (!role?.agent) return { options: [], defaultKey: null };
  const mine = bindingNow(job, roleId) ?? role.agent;
  // Independence is judged against what the counterpart actually ran on, not the plan's original binding.
  const counterpart = job.spec.roles.find((r) => r.agent && (role.role === "reviewer" ? r.role === "builder" : role.role === "builder" ? r.role === "reviewer" : false));
  const against = counterpart ? bindingNow(job, counterpart.roleId) : null;
  const options: AccountChoice[] = [];
  const limited = limitedSlots(job, now, events);
  for (const a of accounts.accounts) {
    if (!accountAvailable(a, accounts)) continue;
    if (limited.has(a.accountSlot)) continue;
    const route = a.accountSlot.startsWith("claude:") ? "claude-code-cli" as const : "codex-app-server" as const;
    const models = [...a.models].filter((m) => !(against && against.route === route && against.model === m));
    // One recommended model per account: the preferred order, else the first allowed.
    const best = PREFERRED_MODELS.find((m) => models.includes(m)) ?? models[0];
    for (const m of models.sort((x, y) => (x === best ? -1 : y === best ? 1 : 0))) {
      options.push({
        key: `${a.accountSlot}|${m}`, route, accountSlot: a.accountSlot,
        accountLabel: "label" in a && a.label ? a.label : accountWords(a.accountSlot), model: m,
        same: mine.accountSlot === a.accountSlot && mine.model === m, recommended: m === best,
      });
    }
  }
  // Default: Claude Max 2 on its recommended model; else the role's own account when it still works; else the first.
  const max2 = options.find((o) => o.accountSlot === "claude:max-2" && o.recommended);
  const same = options.find((o) => o.same);
  const first = options.find((o) => o.recommended) ?? options[0];
  const own = options.some((o) => o.accountSlot === mine.accountSlot);
  const defaultOption = own ? same ?? first : max2 ?? first;
  return { options, defaultKey: defaultOption?.key ?? null };
}

export type Glance = {
  task: string;
  roles: RoleRow[];
  finished: string[];
  blocker: Blocker | null;
  /** The role whose route can be moved on Resume, when the blocker is about that role. */
  moveRole: string | null;
};

/** Everything the five answers need. `blocker` is null unless the job is waiting on the owner. */
export function glanceOf(view: JobView): Glance {
  const job = view.job;
  // Stopped, failed and interrupted jobs say why too (audit F-04); a job marked superseded already says so in its own notice.
  const waiting = ["needs_owner", "blocked_allowance", "interrupted", "cancelled", "failed"].includes(job.state) && !job.supersededBy;
  const blocker = waiting ? codingBlocker(job) : null;
  const movable = !!blocker && !!blocker.roleId && ["reviewer-unavailable", "review-unassessed", "role-stopped", "role-limit"].includes(blocker.kind);
  return { task: taskSentence(job.spec.objective), roles: roleRows(view), finished: finishedLines(view), blocker, moveRole: movable ? blocker!.roleId : null };
}

/** The next button's label given the owner's chosen account (null = keep the role where it is). */
export function nextLabel(job: CodingJob, choice: AccountChoice | null): string {
  return codingResumeLabel(job, choice && !choice.same ? choice.accountLabel : null);
}
