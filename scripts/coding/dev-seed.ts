/**
 * SYNTHETIC coding jobs for UI checks (Track 3 C5 browser fixtures): one job in each state the Coding
 * page must render honestly (running, needs input, blocked at a limit, interrupted, waiting for approval,
 * completed and verified, needs owner, failed, draft). Writes ONLY to CODING_DATA_DIR (required) — never
 * the live store. Every job is labelled synthetic (dataClass) and uses a fake repo id.
 *
 *   CODING_DATA_DIR=D:\agent-scratch\t3\coding-ui bun scripts/coding/dev-seed.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentBinding, CodingJob, GitSha, IsoTime, JobState, RoleId, TaskSpec, TestResult, Uuid } from "./contracts";
import { CodingStore } from "./store";

const dir = process.env.CODING_DATA_DIR;
if (!dir) throw new Error("Set CODING_DATA_DIR to a scratch folder; the seed never touches the live store.");
if (/[\\/]\.operator-data[\\/]coding$/i.test(dir)) throw new Error("Refusing to seed the live coding store.");
if (existsSync(`${dir}/coding.sqlite`)) throw new Error(`${dir} already has a store; use a fresh folder.`);

const sha = (n: number) => (n.toString(16).padStart(2, "0").repeat(20)) as GitSha;
const opus: AgentBinding = { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max", model: "claude-opus-5-5", cliVersion: "2.1.280" };
const codex: AgentBinding = { provider: "openai", route: "codex-app-server", accountSlot: "codex:openai-2", model: "gpt-6-astra", reasoningEffort: "medium", cliVersion: "0.154.0" };
const deepseek: AgentBinding = { provider: "router", route: "model-router", accountSlot: "router:auto", model: "openrouter/deepseek-v4-pro", task: "coding.router", cliVersion: "router" };
const now = Date.now();
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString() as IsoTime;

function spec(objective: string, repo: string, builder: AgentBinding, reviewer: AgentBinding): TaskSpec {
  const id = randomUUID() as Uuid;
  return {
    schema: "coding.taskspec", version: 1, id, revision: 1, createdAt: iso(40),
    requestedBy: { personId: "usman" as never, via: "voice", deviceId: "usman-pc" as never, sessionId: "synthetic" },
    source: { channel: "voice", utteranceDigest: "0".repeat(64) as never },
    repo: { repoId: repo as never, baseRef: "main", baseSha: sha(1), jobBranch: `coding/${objective.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${id.slice(0, 6)}`, excludesUncommittedCanonicalChanges: true },
    objective, nonGoals: ["No dependency changes"],
    doneWhen: [{ id: "c1", text: "Calls grouped by the organisation's timezone", evidence: "reviewer-confirms" }, { id: "c2", text: "rx.test.synthetic passes", evidence: "test", ref: "rx.test.synthetic" }],
    roleTemplate: "build+review",
    roles: [
      { roleId: "builder-1" as RoleId, role: "builder", agent: builder, access: "write", owns: { globs: ["src/app/(dashboard)/calls/**", "src/lib/dates/**"], newFiles: ["src/lib/dates/tz.test.ts"] }, dependsOn: [], limits: { maxWallMinutes: 45, maxTurns: 80, stopAtWindowPercent: 95 } },
      { roleId: "tester" as RoleId, role: "tester", agent: null, access: "none", owns: { globs: [], newFiles: [] }, dependsOn: ["builder-1" as RoleId], limits: { maxWallMinutes: 45, maxTurns: 80, stopAtWindowPercent: 95 } },
      { roleId: "reviewer" as RoleId, role: "reviewer", agent: reviewer, access: "read-only", owns: { globs: [], newFiles: [] }, dependsOn: ["tester" as RoleId], limits: { maxWallMinutes: 30, maxTurns: 60, stopAtWindowPercent: 95 } },
    ],
    checks: ["rx.test.synthetic" as never], baselineChecks: ["rx.test.synthetic" as never], approvalPoints: [],
    allowDependencyChange: false, dataClass: "synthetic", jobLimits: { maxWallMinutes: 120, maxConcurrentAgents: 3 },
    jev: { model: "jev-latest", latencyMs: 312, decisions: [{ question: "repo", choice: repo, confidence: 0.55, policy: "look-again" }], clarifications: [{ question: "Which one: the receptionist app or the OS page?", answer: "the client app", at: iso(41) }] },
    planner: null,
    confirmation: { state: "confirmed", by: { personId: "usman" as never, via: "voice", deviceId: "usman-pc" as never, sessionId: "synthetic" }, via: "spoken-yes", at: iso(39), specDigest: "0".repeat(64) as never },
  };
}

const store = CodingStore.open(dir);
const PATCH = `diff --git a/src/lib/dates/tz.ts b/src/lib/dates/tz.ts\n--- a/src/lib/dates/tz.ts\n+++ b/src/lib/dates/tz.ts\n@@ -1,3 +1,6 @@\n-export const dayOf = (d: Date) => d.toISOString().slice(0, 10);\n+export function dayOf(d: Date, tz = "Australia/Sydney") {\n+  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);\n+}\n`;

function job(objective: string, target: JobState, options: { builder?: AgentBinding; reviewer?: AgentBinding; runs?: Array<[RoleId, string]>; tests?: boolean; review?: "approve" | "request-changes"; diff?: boolean; gate?: boolean; input?: boolean; blocked?: boolean } = {}) {
  const s = spec(objective, "mu-receptionist", options.builder ?? opus, options.reviewer ?? opus);
  const draft = target === "draft" || target === "awaiting_confirmation";
  const created = store.createJob({ id: s.id, spec: draft ? { ...s, confirmation: { state: "unconfirmed" } } : s, state: "draft", headSha: null, diff: null, tests: [], review: null, gate: null, applies: [], executorDevice: "usman-pc" as never });
  const id = created.id;
  const path: JobState[] = ({ draft: [], awaiting_confirmation: ["awaiting_confirmation"], preparing: ["awaiting_confirmation", "preparing"], building: ["awaiting_confirmation", "preparing", "building"], reviewing: ["awaiting_confirmation", "preparing", "building", "integrating", "testing", "reviewing"], needs_owner: ["awaiting_confirmation", "preparing", "building", "integrating", "testing", "reviewing", "gating", "needs_owner"], completed: ["awaiting_confirmation", "preparing", "building", "integrating", "testing", "reviewing", "gating", "completed"], awaiting_approval: ["awaiting_confirmation", "preparing", "building", "integrating", "testing", "reviewing", "gating", "completed", "awaiting_approval"], blocked_allowance: ["awaiting_confirmation", "preparing", "building", "blocked_allowance"], interrupted: ["awaiting_confirmation", "preparing", "building", "interrupted"], failed: ["awaiting_confirmation", "preparing", "failed"], cancelled: ["awaiting_confirmation", "preparing", "building", "cancelled"] } as Record<string, JobState[]>)[target] ?? [];
  const add = (roleId: RoleId, binding: AgentBinding) => store.addRun({ id: randomUUID() as Uuid, jobId: id as Uuid, roleId, role: roleId === "reviewer" ? "reviewer" : "builder", binding, nativeSessionId: binding.route === "claude-code-cli" ? randomUUID() : "thread-synthetic", worktree: { branch: roleId === "reviewer" ? null : `${s.repo.jobBranch}-${roleId}`, headAtStart: sha(1), detached: roleId === "reviewer" } });
  let builderRun: ReturnType<typeof add> | null = null;
  for (const st of path) {
    if (st === "building" && !builderRun) {
      store.appendEvent(id, "step", null, { label: "Snapshotted the canonical and live checkouts (they must not change)" });
      builderRun = add("builder-1" as RoleId, options.builder ?? opus);
      store.transitionRun(builderRun.id, "starting", "started");
      store.transitionRun(builderRun.id, "running", "native_session_ready");
      store.appendEvent(id, "spoken", null, { line: "Started. The builder is working in its own worktree." });
      store.appendEvent(id, "policy", "builder-1" as RoleId, { requestId: "r1", roleId: "builder-1" as RoleId, nativeKind: "Read", decision: "auto-allow", rule: "read-in-worktree", target: "Read calls/page.tsx" });
      store.appendEvent(id, "policy", "builder-1" as RoleId, { requestId: "r2", roleId: "builder-1" as RoleId, nativeKind: "Edit", decision: "auto-deny", rule: "edit-not-owned", target: "Edit src/app/layout.tsx" });
      store.appendEvent(id, "step", "builder-1" as RoleId, { label: "Using Edit" });
    }
    if (st === "integrating" && builderRun) {
      store.transitionRun(builderRun.id, "succeeded", "agent_reported_done_postcheck_passed", { resultSha: sha(2) });
      store.appendEvent(id, "spoken", null, { line: "The builder changed 2 files and committed." });
    }
    store.transitionJob(id, st);
    if (st === "testing" && options.tests !== false) {
      const out = store.putArtefact(id, "(pass) groups 23:30 UTC into the next AEST day [2.1ms]\n(pass) existing dashboard renders [4.0ms]\n 214 pass\n 0 fail\n");
      const base: TestResult = { commandId: "rx.test.synthetic" as never, argv: ["node", "scripts/synthetic-runner.mjs"], sha: sha(1), ranBy: "orchestrator", exitCode: 0, timedOut: false, counts: { passed: 212, failed: 0, skipped: null }, failedTests: [], durationMs: 41_200, output: out, baseline: null };
      const head: TestResult = { ...base, sha: sha(2), counts: { passed: 214, failed: 0, skipped: null }, durationMs: 43_900, baseline: { sha: sha(1), exitCode: 0, failed: 0, failedTests: [] } };
      store.updateJob(id, { headSha: sha(2), tests: [base, head] });
      if (options.diff !== false) {
        const patch = store.putArtefact(id, PATCH);
        store.updateJob(id, { diff: { baseSha: sha(1), headSha: sha(2), files: [{ path: "src/lib/dates/tz.ts", status: "modified", additions: 3, deletions: 1, ownedBy: "builder-1" as RoleId, eolOnly: false }, { path: "src/lib/dates/tz.test.ts", status: "added", additions: 24, deletions: 0, ownedBy: "builder-1" as RoleId, eolOnly: false }], outsideOwnership: [], patch } });
      }
      store.appendEvent(id, "test", null, head);
    }
    if (st === "reviewing") {
      const r = add("reviewer" as RoleId, options.reviewer ?? opus);
      store.transitionRun(r.id, "starting", "started");
      store.transitionRun(r.id, "running", "native_session_ready");
      if (target !== "reviewing") store.transitionRun(r.id, "succeeded", "agent_reported_done_postcheck_passed", { resultSha: sha(2) });
      const verdict = options.review ?? "approve";
      if (target !== "reviewing") store.updateJob(id, { review: { reviewerRoleId: "reviewer" as RoleId, binding: options.reviewer ?? opus, sha: sha(2), verdict, findings: verdict === "approve" ? [{ id: "f1", severity: "minor", file: "src/lib/dates/tz.ts", line: 2, message: "Name the default timezone constant.", status: "open" }] : [{ id: "b1", severity: "blocker", file: "src/app/(dashboard)/calls/page.tsx", line: 40, message: "Still formats with the server's timezone.", status: "open" }], criteria: [{ criterionId: "c1", met: verdict === "approve", note: verdict === "approve" ? "grouped by org tz" : "server tz still used" }] } });
    }
    if (st === "gating") {
      const passed = options.review !== "request-changes";
      const gate = { sha: sha(2), passed, checks: [
        { check: "committed-and-clean" as const, passed: true, detail: "job branch = head; every worktree clean" },
        { check: "ownership" as const, passed: true, detail: "2 changed file(s), all owned" },
        { check: "no-eol-only-churn" as const, passed: true, detail: "no line-ending-only files" },
        { check: "secret-scan" as const, passed: true, detail: "no secrets in added lines or paths" },
        { check: "checks-pass" as const, passed: true, detail: "1 check(s) passed" },
        { check: "review-approved-for-sha" as const, passed, detail: passed ? `approved for ${sha(2).slice(0, 7)}` : "verdict request-changes; 1 blocker(s)" },
        { check: "done-when-evidenced" as const, passed, detail: passed ? "2 criteria evidenced" : "no evidence for: c1" },
      ], baselineFailures: [], at: iso(2) };
      store.updateJob(id, { gate });
      store.appendEvent(id, "gate", null, gate);
    }
  }
  if (options.input && builderRun) {
    store.transitionRun(builderRun.id, "needs_input", "input_requested", { pendingInput: { id: "req-9", kind: "approval", nativeKind: "Bash", title: "Allow Bash?", detail: "make generate-fixtures", escalatedBecause: "The coding policy can't decide this one, so the owner is being asked.", expiresAt: iso(-8) } });
    store.appendEvent(id, "input_request", "builder-1" as RoleId, { id: "req-9", kind: "approval", nativeKind: "Bash", title: "Allow Bash?", detail: "make generate-fixtures", escalatedBecause: "The coding policy can't decide this one, so the owner is being asked.", expiresAt: iso(-8) });
  }
  if (target === "interrupted" && builderRun) {
    store.transitionRun(builderRun.id, "interrupted", "server_restart");
    store.appendEvent(id, "spoken", null, { line: "The OS restarted during the build. The builder was interrupted and nothing was repeated. Say 'resume' to continue." });
  }
  if (target === "failed") store.appendEvent(id, "error", null, { code: "unknown", message: "The base ref main does not resolve in mu-receptionist." });
  if (target === "blocked_allowance" && builderRun) {
    store.transitionRun(builderRun.id, "blocked_allowance", "provider_limit_reached", { error: { code: "limit_reached", message: "Claude's 5-hour window is at 96%, resetting at 2 am. The role stopped before the limit." } });
    store.appendEvent(id, "allowance", "builder-1" as RoleId, { accountSlot: "claude:max", windows: [{ label: "5-hour", usedPercent: 96, resetsAt: iso(-120) }], creditsWouldBeUsed: false, limitReached: false, source: "anthropic-oauth-usage-cached", readAt: iso(3) });
  }
  if (target === "awaiting_approval") {
    const j = store.getJob(id)!;
    const approvalId = randomUUID() as Uuid;
    const apply = { id: randomUUID() as Uuid, jobId: id as Uuid, action: "git.merge.protected" as const, repoId: "mu-receptionist" as never, fromSha: sha(2), toRef: "main", remote: null, idempotencyKey: "0".repeat(64) as never, approval: { approvalId, subject: { kind: "coding.apply" as const, jobId: id as Uuid, applyStepId: randomUUID() as Uuid }, action: "git.merge.protected" as const, digest: "0".repeat(64) as never, requestedBy: j.spec.requestedBy, approverPersonId: "usman" as never, targetDeviceId: "usman-pc" as never, summary: `Merge ${j.spec.repo.jobBranch} @ ${sha(2).slice(0, 7)} into main of mu-receptionist; this triggers a Vercel deployment`, state: "pending" as const, issuedVia: null, createdAt: iso(1), expiresAt: iso(-59), consumedAt: null }, state: "awaiting_approval" as const, verification: null };
    store.updateJob(id, { applies: [apply] });
    store.appendEvent(id, "approval_request", null, apply.approval);
  }
  // Receipts for every agent run: the account and model that ran.
  for (const run of store.getJob(id)!.runs) {
    store.appendEvent(id, "usage", run.roleId, {
      requestId: randomUUID() as Uuid, parentRequestId: id as Uuid, attempt: 1, fallbackFrom: run.binding.route === "model-router" ? "codex/gpt-6-sol" : null, startedAt: iso(30), endedAt: iso(20),
      task: run.role === "reviewer" ? "coding.review" : "coding.build", caller: "scripts/coding/orchestrator", person: "usman" as never,
      route: run.binding.route, provider: run.binding.route === "model-router" ? "openrouter" : run.binding.provider, account: run.binding.route === "model-router" ? "router:openrouter" : run.binding.accountSlot,
      model: run.binding.route === "model-router" ? "openrouter/deepseek-v4-pro" : run.binding.model, providerModel: run.binding.route === "model-router" ? "deepseek/deepseek-v4-pro" : run.binding.model,
      costClass: run.binding.route === "model-router" ? "metered" : "subscription", dataClass: "synthetic", outcome: "succeeded", errorCode: null,
      latencyMs: { queue: 120, provider: 600_000, total: 600_120 },
      usage: { inputTokens: run.binding.route === "codex-app-server" ? null : 48_210, outputTokens: 6_130, cacheReadTokens: 390_000, cacheWriteTokens: 21_000, reasoningTokens: null, audioSeconds: null, characters: null, images: null },
      cost: run.binding.route === "model-router" ? { basis: "catalogue_price", usd: 0.0412, capId: null, priceAsOf: "2026-09-27" } : { basis: "subscription_allowance", usd: null, capId: null, priceAsOf: null },
      valueUsdEquivalent: run.binding.route === "claude-code-cli" ? 1.84 : null,
      allowance: run.binding.route === "model-router" ? null : { plan: run.binding.route === "claude-code-cli" ? "claude-max-20x" : "chatgpt-plus", accountSlot: run.binding.accountSlot, window: "5-hour / weekly", usedPercentAtLastRead: 38, readAt: iso(30), usedPercentAtEnd: 41 },
      credits: run.binding.route === "codex-app-server" ? { before: 0, after: 0, scope: "job", readAt: iso(20) } : null,
      contextTrimmed: false, coding: { jobId: id as Uuid, roleId: run.roleId, turn: 1, cliVersion: run.binding.cliVersion },
    });
  }
  return id;
}

const ids = [
  job("Group receptionist calls by the organisation's timezone", "building", { input: true }),
  job("Show yesterday's calls under yesterday in the calls table", "completed"),
  job("Add a CSV export to the bookings page", "awaiting_approval", { builder: codex }),
  job("Fix the missed-call banner copy", "blocked_allowance"),
  job("Rename the flagged-calls filter", "interrupted"),
  job("Make the call summary respect the org timezone", "needs_owner", { review: "request-changes", reviewer: deepseek }),
  job("Refactor the date helpers", "failed", { tests: false }),
  job("Tidy the dashboard empty state", "awaiting_confirmation"),
  job("Review the SMS consent copy", "reviewing"),
];
store.close();
console.log(`Seeded ${ids.length} SYNTHETIC coding jobs in ${dir}`);
