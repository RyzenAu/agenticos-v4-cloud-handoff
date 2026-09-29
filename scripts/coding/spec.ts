import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../approvals/canonical";
import { catalogueTask } from "../model-router/catalogue";
import type {
  AgentBinding,
  ApprovalPoint,
  ClaudeModelId,
  CodexModelId,
  CommandId,
  Digest,
  DoneCriterion,
  GitSha,
  IsoTime,
  JevShapingRecord,
  OwnershipSpec,
  RepoRegistry,
  RepoRegistryEntry,
  RoleAssignment,
  RoleId,
  RoleLimits,
  RoleTemplate,
  TaskSpec,
  TaskSpecValidation,
  Uuid,
  VerifiedPrincipal,
} from "./contracts";
import { scanLine } from "./redact";
import { checkOwnership, commandById, repoById } from "./registry";
import { git, jobBranchName, resolveBaseSha } from "./worktree";

/**
 * TaskSpec construction, digest and the deterministic validator (CODING-HARNESS §3.2). No model is
 * involved here: Jev and the planner PROPOSE; this code decides whether a spec may be confirmed.
 */

export const CLAUDE_MODELS: readonly ClaudeModelId[] = ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5"];
/** The native Codex 0.154.0 catalogue (verified 27 Sep; gpt-6-sol is NOT native, only via Hermes). */
export const CODEX_MODELS: readonly CodexModelId[] = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
export const ROUTER_TASK = "coding.router";

export const DEFAULT_LIMITS: RoleLimits = { maxWallMinutes: 45, maxTurns: 80, stopAtWindowPercent: 95 };
const REVIEW_LIMITS: RoleLimits = { maxWallMinutes: 30, maxTurns: 60, stopAtWindowPercent: 95 };

/** sha256 of the spec's canonical JSON WITHOUT its confirmation: what "Start it" confirms. */
export function specDigest(spec: TaskSpec): Digest {
  const { confirmation: _c, ...rest } = spec;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex") as Digest;
}

export const slugOf = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, 5).join("-").slice(0, 36) || "job";

export function claudeBinding(model: ClaudeModelId, cliVersion: string): AgentBinding {
  return { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max", model, cliVersion };
}
export function codexBinding(model: CodexModelId, slot: "codex:openai-1" | "codex:openai-2" | "codex:openai-3", cliVersion: string, effort: "low" | "medium" | "high" = "medium"): AgentBinding {
  return { provider: "openai", route: "codex-app-server", accountSlot: slot, model, reasoningEffort: effort, cliVersion };
}
export function routerBinding(model: string): AgentBinding {
  return { provider: "router", route: "model-router", accountSlot: "router:auto", model, task: ROUTER_TASK, cliVersion: "router" };
}

export type DraftInput = {
  requestedBy: VerifiedPrincipal;
  channel: "voice" | "typed" | "ui";
  utterance: string;
  entry: RepoRegistryEntry;
  baseRef?: string;
  objective: string;
  nonGoals?: string[];
  doneWhen: DoneCriterion[];
  roleTemplate: RoleTemplate;
  builders: { binding: AgentBinding; owns: OwnershipSpec; instructions?: string }[];
  testAuthor?: { binding: AgentBinding; owns: OwnershipSpec } | null;
  reviewer?: { binding: AgentBinding } | null;
  checks: CommandId[];
  baselineChecks?: CommandId[];
  approvalPoints?: ApprovalPoint[];
  dataClass?: "synthetic" | "business-internal";
  jev?: JevShapingRecord | null;
  planner?: TaskSpec["planner"];
  now?: () => Date;
  id?: Uuid;
};

/** Build an UNCONFIRMED TaskSpec (revision 1) from shaped decisions. */
export function draftSpec(input: DraftInput): TaskSpec {
  const id = input.id ?? (randomUUID() as Uuid);
  const baseRef = input.baseRef ?? input.entry.defaultBaseRef;
  const baseSha = resolveBaseSha(input.entry, baseRef);
  const roles: RoleAssignment[] = [];
  input.builders.forEach((b, i) => roles.push({
    roleId: `builder-${i + 1}` as RoleId, role: "builder", agent: b.binding, access: "write", owns: b.owns, dependsOn: [], limits: DEFAULT_LIMITS,
    ...(b.instructions ? { instructions: b.instructions } : {}),
  }));
  if (input.testAuthor) roles.push({
    roleId: "test-author" as RoleId, role: "test-author", agent: input.testAuthor.binding, access: "write", owns: input.testAuthor.owns,
    dependsOn: roles.filter((r) => r.role === "builder").map((r) => r.roleId), limits: DEFAULT_LIMITS,
  });
  roles.push({ roleId: "tester" as RoleId, role: "tester", agent: null, access: "none", owns: { globs: [], newFiles: [] }, dependsOn: roles.map((r) => r.roleId), limits: DEFAULT_LIMITS });
  if (input.reviewer) roles.push({
    roleId: "reviewer" as RoleId, role: "reviewer", agent: input.reviewer.binding, access: "read-only", owns: { globs: [], newFiles: [] },
    dependsOn: ["tester" as RoleId], limits: REVIEW_LIMITS,
  });
  const at = (input.now?.() ?? new Date()).toISOString() as IsoTime;
  return {
    schema: "coding.taskspec",
    version: 1,
    id,
    revision: 1,
    createdAt: at,
    requestedBy: input.requestedBy,
    source: { channel: input.channel, utteranceDigest: createHash("sha256").update(input.utterance).digest("hex") as Digest },
    repo: { repoId: input.entry.id, baseRef, baseSha, jobBranch: jobBranchName(slugOf(input.objective), id.replace(/-/g, "").slice(0, 6)), excludesUncommittedCanonicalChanges: true },
    objective: input.objective.trim(),
    nonGoals: input.nonGoals ?? [],
    doneWhen: input.doneWhen,
    roleTemplate: input.roleTemplate,
    roles,
    checks: input.checks,
    baselineChecks: input.baselineChecks ?? input.checks,
    approvalPoints: input.approvalPoints ?? [],
    allowDependencyChange: false,
    dataClass: input.dataClass ?? "business-internal",
    jobLimits: { maxWallMinutes: 120, maxConcurrentAgents: 3 },
    jev: input.jev ?? null,
    planner: input.planner ?? null,
    confirmation: { state: "unconfirmed" },
  };
}

/** An edit before confirmation: a new revision (approvals bound to the old digest are void). */
export function reviseSpec(spec: TaskSpec, patch: Partial<Pick<TaskSpec, "objective" | "doneWhen" | "roles" | "checks" | "nonGoals" | "roleTemplate">>): TaskSpec {
  if (spec.confirmation.state === "confirmed") throw new Error("A confirmed spec is immutable.");
  return { ...spec, ...patch, revision: spec.revision + 1, confirmation: { state: "unconfirmed" } };
}

const CONSEQUENTIAL = /\b(?:git\s+push|push(?:ing)?\s+(?:to|it)|merge|merging|deploy|deploying|publish|release|migrate\s+deploy|vercel|production)\b/i;

function secretIn(text: string): boolean {
  return text.split(/\r?\n/).some((line) => scanLine(line).length > 0);
}

/**
 * The deterministic validator (§3.2). `trackedFiles` defaults to the files at the base sha. A spec with
 * any error can't be confirmed.
 */
export function validateSpec(spec: TaskSpec, registry: RepoRegistry, options: { trackedFiles?: readonly string[] } = {}): TaskSpecValidation {
  const errors: TaskSpecValidation["errors"][number][] = [];
  const warnings: string[] = [];
  const entry = repoById(registry, spec.repo.repoId);
  if (!entry) return { ok: false, errors: [{ code: "repo_not_allowed", detail: `${spec.repo.repoId} is not in the coding registry` }], warnings };
  if (!entry.allowedPeople.includes(spec.requestedBy.personId)) errors.push({ code: "repo_not_allowed", detail: `${spec.requestedBy.personId} may not use ${entry.id}` });
  let tracked = options.trackedFiles;
  try {
    const sha = resolveBaseSha(entry, spec.repo.baseRef);
    if (sha !== spec.repo.baseSha) errors.push({ code: "base_unresolved", detail: `${spec.repo.baseRef} is now ${sha.slice(0, 7)}, not ${spec.repo.baseSha.slice(0, 7)}` });
    tracked ??= git(entry.canonicalPath, ["ls-tree", "-r", "-z", "--name-only", spec.repo.baseSha]).stdout.split("\0").filter(Boolean);
  } catch (e) {
    errors.push({ code: "base_unresolved", detail: (e as Error).message });
    tracked ??= [];
  }
  for (const p of checkOwnership(spec.roles, tracked)) errors.push({ code: p.code, detail: p.detail, roleId: p.roleId });
  for (const id of [...spec.checks, ...spec.baselineChecks]) if (!commandById(entry, id)) errors.push({ code: "unknown_command", detail: `${id} is not a registry command of ${entry.id}` });
  const writers = spec.roles.filter((r) => r.access === "write");
  if (!writers.length && !["review-only", "investigate"].includes(spec.roleTemplate)) errors.push({ code: "ownership_empty", detail: "no builder" });
  for (const r of spec.roles) {
    if ((r.role === "reviewer" || r.role === "planner" || r.role === "tester") && r.access === "write") errors.push({ code: "ownership_overlap", detail: `${r.role} can never write`, roleId: r.roleId });
    if (r.role === "tester" && r.agent) errors.push({ code: "consequential_in_role", detail: "the tester is the orchestrator's own test run", roleId: r.roleId });
    const l = r.limits;
    if (l.maxWallMinutes < 1 || l.maxWallMinutes > 240 || l.maxTurns < 1 || l.maxTurns > 500 || l.stopAtWindowPercent < 50 || l.stopAtWindowPercent > 99)
      errors.push({ code: "limits_out_of_range", detail: `${r.roleId} limits`, roleId: r.roleId });
    const b = r.agent;
    if (b?.route === "claude-code-cli" && !CLAUDE_MODELS.includes(b.model)) errors.push({ code: "model_not_entitled", detail: `${b.model} is not a Claude Code model`, roleId: r.roleId });
    if (b?.route === "codex-app-server" && !CODEX_MODELS.includes(b.model)) errors.push({ code: "model_not_entitled", detail: `${b.model} is not in the native Codex catalogue (gpt-6-sol runs only via Hermes: pick a routed role)`, roleId: r.roleId });
    if (b?.route === "model-router") {
      const task = catalogueTask(b.task);
      if (!task || (!task.candidates.includes(b.model) && !(task.selectable ?? []).includes(b.model))) errors.push({ code: "model_not_entitled", detail: `${b.model} is not a ${b.task} model`, roleId: r.roleId });
      else if (!task.candidates.includes(b.model)) warnings.push(`${r.roleId}: ${b.model} is a selectable (possibly metered) model; its receipt records the real cost.`);
    }
    if (r.instructions && CONSEQUENTIAL.test(r.instructions)) errors.push({ code: "consequential_in_role", detail: "role instructions can't ask for push/merge/deploy; those are approval points", roleId: r.roleId });
    if (r.instructions && secretIn(r.instructions)) errors.push({ code: "secret_in_text", detail: `${r.roleId} instructions`, roleId: r.roleId });
  }
  if (spec.jobLimits.maxWallMinutes < 1 || spec.jobLimits.maxWallMinutes > 480 || spec.jobLimits.maxConcurrentAgents < 1 || spec.jobLimits.maxConcurrentAgents > 4)
    errors.push({ code: "limits_out_of_range", detail: "job limits" });
  if (secretIn(spec.objective) || spec.doneWhen.some((d) => secretIn(d.text)) || spec.nonGoals.some(secretIn)) errors.push({ code: "secret_in_text", detail: "objective, done-when or non-goals" });
  if (!spec.doneWhen.length) errors.push({ code: "ownership_empty", detail: "no done-when criteria" });
  for (const a of spec.approvalPoints) if (a.when !== "after-completion") errors.push({ code: "consequential_in_role", detail: `${a.action} must be offered after completion` });
  if (entry.remotes.some((r) => r.vercelLinked)) warnings.push("This repo's origin is Vercel-linked: any push to it deploys. Pushes and merges happen only after your approval.");
  return { ok: errors.length === 0, errors, warnings };
}

/** Confirm a validated spec (bound to the digest the person saw). */
export function confirmSpec(spec: TaskSpec, by: VerifiedPrincipal, via: "ui" | "spoken-yes" | "typed", digest: Digest, now = new Date()): TaskSpec {
  if (spec.confirmation.state === "confirmed") throw new Error("Already confirmed.");
  if (specDigest(spec) !== digest) throw new Error("The spec changed since it was shown; confirm the new version.");
  return { ...spec, confirmation: { state: "confirmed", by, via, at: now.toISOString() as IsoTime, specDigest: digest } };
}

export const shortSha = (sha: GitSha | string | null) => (sha ? sha.slice(0, 7) : "none");
