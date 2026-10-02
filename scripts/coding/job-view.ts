import type { AgentBinding, CodingJob, ContextSource, ExecutionLocation, JobState, RoleAssignment, UsageReceipt } from "./contracts";
import { baselineFailedNames, codingBlocker } from "./pause-reason";

/**
 * The readable view of one coding job (1 Oct 2026): everything a page needs to show plan, progress, diff,
 * review and result WITHOUT re-deriving it from raw events. Pure; built from the job and its events. The Coding
 * page (Agent C) renders it; nothing here is HTML. Returned as `readable` on GET /coding/jobs/:id next to the raw
 * `job`, `receipts`, `modelsUsed`, `events`.
 *
 * Fields (all always present unless marked "or null"):
 *   plan      { objective, nonGoals[], doneWhen[{id,text,evidence,met|null,note|null}], checks[], roles[{roleId,role,who,owns[],why|null}] }
 *   progress  { state, stateText, needsYou|null, phases[{id,label,status,detail|null}], runs[{...}], fallbacks[{...}], recent[] }
 *   diff      { baseSha, headSha, totals{files,additions,deletions}, files[{path,status,additions,deletions,ownedBy|null}], outsideOwnership[], patchArtefact } or null
 *   tests     { atHead{runs,passed,failed,allExitZero,counted}|null, latest{sha,command,passed,failed,skipped,exitCode,timedOut,failedTests|null,matchesHead}|null, baselineFailed|null, runs }
 *   review    { verdict, sha, reviewer{roleId,account,model}|null, findings[{id,severity,file,line,message,status}], criteria[{id,met,note}] } or null
 *   result    { state, headSha|null, jobBranch, gate{passed,at,checks[{check,passed,detail}]}|null, merged, nextStep }
 *   context   { sources[] } the context sources supplied to the latest turn of each role
 *   location  "this-pc" | "cloud" | null: where the agents ran (from the receipts)
 */

type EventLike = { seq?: number; type: string; roleId: string | null; at?: string; payload: unknown };

const STATE_TEXT: Record<JobState, string> = {
  draft: "A draft with problems", awaiting_confirmation: "Waiting for you to start it", preparing: "Preparing the worktrees", building: "Building",
  integrating: "Merging the builders' branches", testing: "Running the tests", reviewing: "Being reviewed", gating: "At the done gate",
  awaiting_approval: "Waiting for your approval", applying: "Applying the approved step", completed: "Done and verified", needs_owner: "Waiting for you",
  blocked_allowance: "Paused at an account limit", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted; nothing was replayed",
};
const ORDER = ["building", "integrating", "testing", "reviewing", "gating"] as const;
const PHASE_LABEL: Record<(typeof ORDER)[number], string> = { building: "Build", integrating: "Merge branches", testing: "Tests", reviewing: "Review", gating: "Done gate" };

const who = (b: AgentBinding | null | undefined) => (b ? { route: b.route, accountSlot: b.accountSlot, model: b.model } : null);
const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : null);

export function readableJob(job: CodingJob, events: readonly EventLike[]) {
  const spec = job.spec;
  const receipts = events.filter((e) => e.type === "usage").map((e) => e.payload as UsageReceipt);
  const steps = events.filter((e) => e.type === "step").map((e) => ({ roleId: e.roleId, at: e.at ?? null, payload: e.payload as { label?: string; detail?: string } }));
  const sameHead = (sha: string | null | undefined) => !!sha && sha === job.headSha;

  // ── plan
  const met = (id: string) => job.review?.criteria.find((c) => c.criterionId === id) ?? null;
  const plan = {
    objective: spec.objective,
    nonGoals: [...spec.nonGoals],
    doneWhen: spec.doneWhen.map((d) => {
      const r = met(d.id);
      const atHeadRun = d.evidence !== "reviewer-confirms" && d.ref ? job.tests.filter((t) => t.commandId === d.ref && sameHead(t.sha)).at(-1) : undefined;
      // The recorded gate decides whether a failing command had ONLY pre-existing failures (same test names on the base commit).
      const baselineOnly = !!atHeadRun && atHeadRun.exitCode !== 0 && job.gate?.sha === job.headSha && (job.gate.baselineFailures ?? []).some((b) => b.commandId === d.ref);
      const testOk = d.evidence === "test" && d.ref ? job.tests.some((t) => t.commandId === d.ref && sameHead(t.sha) && t.exitCode === 0) || baselineOnly : null;
      const baselineNote = baselineOnly ? `Only pre-existing failures: ${baselineFailedNames(job).join("; ") || "same tests as on the base commit"}.` : null;
      return { id: d.id, text: d.text, evidence: d.evidence, met: d.evidence === "reviewer-confirms" ? (r ? r.met : null) : testOk, note: baselineNote ?? (r?.note || null) };
    }),
    checks: [...spec.checks],
    roles: spec.roles.filter((r: RoleAssignment) => r.agent).map((r) => ({
      roleId: r.roleId, role: r.role, who: who(r.agent), owns: [...r.owns.globs, ...r.owns.newFiles.map((f) => `${f} (new)`)],
      why: spec.roleChoices?.find((c) => c.role === r.role)?.why ?? null,
    })),
  };

  // ── progress
  const idx = (ORDER as readonly string[]).indexOf(job.state);
  const finished = job.state === "completed";
  const phaseStatus = (p: (typeof ORDER)[number], i: number): "done" | "active" | "pending" | "blocked" | "failed" => {
    if (finished) return "done";
    if (["needs_owner", "failed", "blocked_allowance", "interrupted", "cancelled"].includes(job.state)) {
      const at = job.tests.length && !job.headSha ? 0 : job.review ? 4 : job.headSha && job.tests.some((t) => sameHead(t.sha)) ? 3 : job.headSha ? 2 : 0;
      if (i < at) return "done";
      if (i === at) return job.state === "blocked_allowance" ? "blocked" : job.state === "failed" ? "failed" : "blocked";
      return "pending";
    }
    if (idx < 0) return job.state === "awaiting_approval" || job.state === "applying" ? "done" : "pending";
    return i < idx ? "done" : i === idx ? "active" : "pending";
  };
  const fallbackSteps = steps.filter((s) => s.payload.label?.startsWith("Automatic fallback: ") && s.roleId);
  const fallbacks = fallbackSteps.map((s) => {
    const m = /^Automatic fallback: (\S+) (\S+) → (\S+)$/.exec(s.payload.label ?? "");
    return m ? { roleId: m[1], from: m[2], to: m[3], at: s.at, why: s.payload.detail ?? null } : { roleId: s.roleId, from: null, to: null, at: s.at, why: s.payload.detail ?? s.payload.label ?? null };
  });
  const runRows = job.runs.map((r) => {
    // A receipt that names its run belongs to that run only; two runs of one role each count their turns from 1 (round 6).
    const turns = receipts.filter((x) => x.coding?.roleId === r.roleId && (!x.coding.runId || x.coding.runId === r.id)).sort((a, b) => a.coding.turn - b.coding.turn);
    // An attempt that never started (its account was at its limit before it began) has no provider receipt: say so,
    // naming the account it was moved from when a fallback recorded it, so the page shows both attempts.
    const moved = fallbacks.filter((x) => x.roleId === r.roleId);
    const didNotRun = Array.from({ length: Math.max(0, r.attempt) }, (_, i) => i + 1).filter((t) => !turns.some((x) => x.coding.turn === t))
      .map((t, i) => {
        const from = moved[i]?.from ?? null;
        return { turn: t, account: from ? from.split("/")[0] : null, requestedModel: from ? from.split("/")[1] ?? null : null, reportedModel: null, modelMismatch: null, outcome: "did_not_run" as const, location: null };
      });
    return {
      roleId: r.roleId, role: r.role, state: r.state, attempt: r.attempt, who: who(r.binding), error: r.error ? r.error.message : null,
      /** One row per attempt that ran: which account and model asked for, which reported, how it ended. */
      attempts: [...turns.map((t) => ({ turn: t.coding.turn, account: t.account as string | null, requestedModel: (t.requestedModel ?? t.model) as string | null, reportedModel: t.providerModel, modelMismatch: t.modelMismatch ?? null, outcome: t.outcome as string, location: (t.executionLocation ?? null) as string | null })), ...didNotRun].sort((a, b) => a.turn - b.turn),
    };
  });
  const last = (n: number) => steps.slice(-n).map((s) => s.payload.label ?? "");
  const blocker = codingBlocker(job);
  const needsYou = ["needs_owner", "awaiting_approval", "interrupted", "blocked_allowance", "awaiting_confirmation", "draft"].includes(job.state)
    ? (job.state === "needs_owner" || job.state === "blocked_allowance" ? blocker.text : STATE_TEXT[job.state])
    : null;
  const progress = {
    state: job.state, stateText: STATE_TEXT[job.state], needsYou,
    /** The ONE current blocker and what the next button does (null unless the job is waiting on the owner). */
    blocker: job.state === "needs_owner" || job.state === "blocked_allowance" ? { kind: blocker.kind, text: blocker.text, label: blocker.label, roleId: blocker.roleId } : null,
    phases: ORDER.map((p, i) => ({ id: p, label: PHASE_LABEL[p], status: phaseStatus(p, i), detail: p === "testing" && job.tests.length ? `${job.tests.filter((t) => sameHead(t.sha)).length} run at the current head` : null })),
    runs: runRows, fallbacks, recent: last(8),
  };

  // ── diff
  const diff = job.diff && {
    baseSha: job.diff.baseSha, headSha: job.diff.headSha, baseShort: short(job.diff.baseSha), headShort: short(job.diff.headSha),
    totals: { files: job.diff.files.length, additions: job.diff.files.reduce((n, f) => n + f.additions, 0), deletions: job.diff.files.reduce((n, f) => n + f.deletions, 0) },
    files: job.diff.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, ownedBy: f.ownedBy ?? null })),
    outsideOwnership: [...job.diff.outsideOwnership], patchArtefact: job.diff.patch,
  };

  // ── tests
  const atHead = job.tests.filter((t) => sameHead(t.sha));
  const latestRun = atHead.at(-1) ?? job.tests.at(-1) ?? null;
  const base = job.tests.find((t) => t.baseline === null && !sameHead(t.sha)) ?? null;
  const tests = {
    latest: latestRun && {
      sha: latestRun.sha, command: latestRun.commandId, passed: latestRun.counts.passed, failed: latestRun.counts.failed, skipped: latestRun.counts.skipped,
      exitCode: latestRun.exitCode, timedOut: latestRun.timedOut, failedTests: latestRun.failedTests ? [...latestRun.failedTests] : null, failures: (latestRun.failures ?? []).map((f) => ({ name: f.name, assertion: f.assertion })), matchesHead: sameHead(latestRun.sha),
    },
    // The same totals the page header shows: every run at the current head, added together (a run with no counts adds nothing).
    atHead: atHead.length ? { runs: atHead.length, passed: atHead.reduce((n, t) => n + (t.counts.passed ?? 0), 0), failed: atHead.reduce((n, t) => n + (t.counts.failed ?? 0), 0), allExitZero: atHead.every((t) => t.exitCode === 0), counted: atHead.some((t) => t.counts.passed !== null || t.counts.failed !== null) } : null,
    baselineFailed: base ? base.counts.failed : null,
    runs: job.tests.length,
  };

  // ── review
  const reviewerRun = [...job.runs].reverse().find((r) => r.role === "reviewer" && r.worktree.headAtStart === job.review?.sha);
  const review = job.review && {
    verdict: job.review.verdict, sha: job.review.sha, forCurrentHead: sameHead(job.review.sha),
    reviewer: reviewerRun ? { roleId: reviewerRun.roleId, account: reviewerRun.binding.accountSlot, model: reviewerRun.binding.model } : null,
    findings: job.review.findings.map((f) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, message: f.message, status: f.status })),
    criteria: job.review.criteria.map((c) => ({ id: c.criterionId, met: c.met, note: c.note })),
  };

  // ── result
  const applied = job.applies.filter((a) => a.state === "succeeded");
  const result = {
    state: job.state, headSha: job.headSha, headShort: short(job.headSha), jobBranch: spec.repo.jobBranch,
    gate: job.gate && { passed: job.gate.passed, at: job.gate.at, checks: job.gate.checks.map((c) => ({ check: c.check, passed: c.passed, detail: c.detail })) },
    merged: applied.some((a) => /merge/i.test(String(a.action))),
    applies: job.applies.map((a) => ({ action: a.action, state: a.state, toRef: a.toRef })),
    nextStep: job.state === "completed" ? (applied.length ? "Applied." : "Nothing is merged. Say \"merge it\" (needs your approval) or review the diff first.")
      : job.state === "blocked_allowance" ? "Paused at an account limit: wait, or move the role to another account." : job.state === "needs_owner" ? `Next: ${blocker.label}.` : STATE_TEXT[job.state],
  };

  // ── context and location, from the latest receipt of each role
  const latestPerRole = new Map<string, UsageReceipt>();
  for (const r of receipts) if (r.coding) latestPerRole.set(r.coding.roleId, r);
  const sources: (ContextSource & { roleId: string })[] = [];
  for (const [roleId, r] of latestPerRole) for (const s of r.contextSources ?? []) sources.push({ ...s, roleId });
  const locations = new Set(receipts.map((r) => r.executionLocation).filter((x): x is ExecutionLocation => !!x));

  return {
    plan, progress, diff, tests, review, result,
    context: { sources: sources.slice(0, 24) },
    location: locations.size === 1 ? [...locations][0] : locations.size > 1 ? ("mixed" as const) : null,
  };
}
