/**
 * Coding harness contracts (Stage E, V6 §7). TYPES ONLY: no runtime code, no imports.
 * Design: memory/master-v3/CODING-HARNESS.md (copied here in task C2).
 *
 * Amended in C2 for the OWNER DECISIONS of 28 Sep 2026, which override the design's §8:
 *  1. Three connected Codex accounts. A NEW job may be routed to another connected account when one
 *     reaches its limit; an in-progress or interrupted job never moves account (only an explicit,
 *     recorded ResumeRequest.reassignTo can). Receipts record the `account` and `model` that ran.
 *  2. openai-1's paid Codex credits stay enabled; receipts record credits before/after (per job where
 *     observable, otherwise per window, labelled). Nothing here purchases credits or changes top-up.
 *  4. Mehroz gets working access once Stage B's Principal lands; `requestedBy` records who asked.
 * Amended in C3 (28 Sep 2026, Track 3):
 *  - A third binding, `router`: Hermes, DeepSeek, MiMo, Cline and the other connected models run as
 *    selectable roles THROUGH the model router (scripts/model-router). The router may fall back
 *    automatically along the task's chain (owner rule), and the receipt names the model that ACTUALLY
 *    ran plus `fallbackFrom`; nothing ever claims the selected model ran when another did.
 *  - Receipts: provider/model are the real ones (strings, from the provider or the router), cost may be
 *    metered for router roles, and `allowance` is null where no window applies.
 *  - Policy rules added for C1C2's carried limits: reads outside the worktree, git config/worktree
 *    commands, run-time-built paths, the live checkout, and harmless bookkeeping tools.
 * Also: `gating` may be interrupted by a restart (recovery sets every active job to interrupted), and
 * role branches are `coding/<slug>-<id6>-<roleId>` because git can't hold both `coding/x` and
 * `coding/x/<role>` as refs.
 *
 * Invariants (tested by the implementation, not expressible in types alone):
 *  - A confirmed TaskSpec is immutable; edits create a new version and void approvals bound to the old digest.
 *  - Builder / test-author `owns` sets are pairwise disjoint; reviewer, planner and tester never write.
 *  - `person` / principals come from the verified OS session (Stage B), never a request body.
 *  - No field carries a secret, credential, email address or raw prompt; receipts also carry no paths or output.
 *  - AgentRun.state moves only along AgentRunTransitions; JobState only along JobTransitions.
 *  - A job is "completed" only with DoneGateResult.passed === true for the job's head sha.
 *  - Consequential actions are never agent tools; they are ApplyStep records behind a Stage B approval.
 */

// ───────────────────────────── primitives ─────────────────────────────

/** Opaque UUID v4. */
export type Uuid = string & { readonly __brand: "Uuid" };
/** ISO-8601 UTC timestamp. */
export type IsoTime = string & { readonly __brand: "IsoTime" };
/** 40-hex git commit id. */
export type GitSha = string & { readonly __brand: "GitSha" };
/** sha256 hex of a canonical JSON serialisation. */
export type Digest = string & { readonly __brand: "Digest" };
/** Registry key, e.g. "agentic-os", "mu-receptionist". */
export type RepoId = string & { readonly __brand: "RepoId" };
/** Registry command key, e.g. "rx.test.synthetic", "aos.typecheck". */
export type CommandId = string & { readonly __brand: "CommandId" };
/** Stable person id from people.json `id` (Stage B), e.g. "usman", "mehroz". Never a display name. */
export type PersonId = string & { readonly __brand: "PersonId" };
/** Device id from the Stage B device registry, e.g. "usman-pc". */
export type DeviceId = string & { readonly __brand: "DeviceId" };
/** Short role key inside one job, e.g. "builder-1", "reviewer". */
export type RoleId = string & { readonly __brand: "RoleId" };
/** Id of a stored artefact file under .operator-data/coding/<jobId>/ (never a path in events). */
export type ArtefactId = string & { readonly __brand: "ArtefactId" };

// ───────────────────────────── identity (Stage B) ─────────────────────────────

/** Resolved server-side by Stage B. A display name is personalisation, not identity. */
export type VerifiedPrincipal = {
  personId: PersonId;
  via: "local" | "tailnet" | "telegram" | "voice";
  deviceId: DeviceId;
  /** Stage B session id (hashed at rest). */
  sessionId: string;
};

export type CodingPermission = "coding.view" | "coding.create" | "coding.control" | "coding.approve";

// ───────────────────────────── accounts, models, routes ─────────────────────────────

export type Provider = "anthropic" | "openai" | "router";
/** Stage E receipt `route`; these values extend the catalogue enum. `model-router` = a routed text role. */
export type CodingRoute = "claude-code-cli" | "codex-app-server" | "model-router";
/** Named by slot, never by email. One Claude login; three connected Codex logins (owner decision 1):
 * rotation applies to NEW jobs only, and the slot that actually ran is recorded on every receipt. */
export type CodexAccountSlot = "codex:openai-1" | "codex:openai-2" | "codex:openai-3";
/** A routed role's account: the router provider that actually ran (e.g. "router:openrouter",
 * "router:codex" = Hermes' Codex pool, "router:cline"). Known only after the call; the binding holds
 * "router:auto" until then. */
export type RouterAccountSlot = `router:${string}`;
export type AccountSlot = "claude:max" | CodexAccountSlot | RouterAccountSlot;
export type ClaudeModelId = "claude-opus-5-5" | "claude-sonnet-5" | "claude-fable-5-1" | "claude-haiku-4-5";
/** Verified in the native Codex 0.154.0 catalogue on 27 Sep 2026. gpt-6-sol is NOT available natively. */
export type CodexModelId = "gpt-6-astra" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.5";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type AgentBinding =
  | {
      provider: "anthropic";
      route: "claude-code-cli";
      accountSlot: "claude:max";
      model: ClaudeModelId;
      /** Pinned CLI version recorded at start, e.g. "2.1.280". */
      cliVersion: string;
    }
  | {
      provider: "openai";
      route: "codex-app-server";
      /** Chosen when the job is created; fixed for the life of the run (no mid-run rotation). */
      accountSlot: CodexAccountSlot;
      model: CodexModelId;
      reasoningEffort?: ReasoningEffort;
      cliVersion: string;
    }
  | {
      provider: "router";
      route: "model-router";
      /** "router:auto" until the call returns; the receipt carries the provider that ran. */
      accountSlot: RouterAccountSlot;
      /** The catalogue id SELECTED (e.g. "openrouter/deepseek-v4-pro", "codex/gpt-6-sol" via Hermes). */
      model: string;
      /** The router task whose chain supplies automatic fallbacks, e.g. "coding.router". */
      task: string;
      cliVersion: "router";
    };

// ───────────────────────────── repo registry ─────────────────────────────

export type RemoteClass = "backup-private" | "production";

export type RegistryCommand = {
  id: CommandId;
  kind: "test" | "typecheck" | "build" | "lint";
  /** Exact argv; spawned without a shell. No free-text commands anywhere. */
  argv: readonly string[];
  /** Relative to the worktree root. */
  cwd: string;
  timeoutMs: number;
  /** How to parse counts from output, if the runner prints them. */
  counts?: "bun" | "vitest" | "jest" | "node-test" | "none";
};

export type RepoRegistryEntry = {
  id: RepoId;
  description: string;
  canonicalPath: string;
  defaultBaseRef: string;
  /** Where coding worktrees are created, e.g. "<canonical>-wt". */
  worktreeParent: string;
  protectedBranches: readonly string[];
  remotes: readonly { name: string; class: RemoteClass; vercelLinked: boolean }[];
  commands: readonly RegistryCommand[];
  nodeModules: "junction" | "none" | "real-install-only";
  allowedPeople: readonly PersonId[];
  /** Extra read-deny globs beyond the global list (.env*, .operator-data/**, credentials*). */
  denyRead?: readonly string[];
};

export type RepoRegistry = { version: 1; repos: readonly RepoRegistryEntry[] };

// ───────────────────────────── TaskSpec ─────────────────────────────

export type RoleKind = "planner" | "builder" | "test-author" | "tester" | "reviewer";
export type RoleTemplate = "build+review" | "build+review+test-author" | "build-only" | "review-only" | "investigate";

/** Globs relative to the repo root (forward slashes). `newFiles` are exact paths the role may create. */
export type OwnershipSpec = {
  globs: readonly string[];
  newFiles: readonly string[];
};

export type RoleLimits = {
  maxWallMinutes: number;
  maxTurns: number;
  /** Stop (blocked_allowance) before any window reaches this percentage. Default 95. */
  stopAtWindowPercent: number;
};

export type RoleAssignment = {
  roleId: RoleId;
  role: RoleKind;
  /** "tester" with agent null = the orchestrator's deterministic test run. */
  agent: AgentBinding | null;
  access: "write" | "read-only" | "none";
  /** Empty for read-only roles; disjoint across writing roles (validator). */
  owns: OwnershipSpec;
  dependsOn: readonly RoleId[];
  limits: RoleLimits;
  /** Extra role instructions, validated for secrets; the base prompt is built from the TaskSpec. */
  instructions?: string;
  /** Allowed only on a TaskSpec with allowDependencyChange; needs a real install. */
  mayChangeDependencies?: boolean;
  allowPublicDocsWeb?: boolean;
};

export type DoneCriterion = {
  id: string;
  text: string;
  /** How the gate will evidence it. */
  evidence: "test" | "typecheck" | "build" | "file-exists" | "reviewer-confirms";
  /** Test name pattern, file path or command id, per `evidence`. */
  ref?: string;
};

export type ApprovalAction =
  | "git.push.production"
  | "git.merge.protected"
  | "deploy"
  | "db.migrate.production"
  | "provider.config.change";

export type ApprovalPoint = {
  action: ApprovalAction;
  /** e.g. "merge into main of mu-receptionist (triggers a Vercel production deploy)". */
  describe: string;
  /** Offered after completion only; never an agent instruction. */
  when: "after-completion";
};

export type JevShapingRecord = {
  /** TypeSafe model identity returned, e.g. "jev-1.13.0". */
  model: string;
  latencyMs: number;
  decisions: readonly JevDecision[];
  /** Questions Jarvis asked before the spec was drafted, with the owner's choice. */
  clarifications: readonly { question: string; answer: string; at: IsoTime }[];
};

/**
 * Who was chosen for a role and why (role-choice.ts), in words the draft summary can say. `basis`: "named" =
 * the owner's own words; "jev" = Jev's typed pick was allowed; "preferred" = coding-prefs.json; "auto" = the
 * deterministic default order. Recorded on the draft; the RECEIPT still says what actually ran.
 */
export type RoleChoice = {
  role: "builder" | "reviewer" | "test-author";
  /** The selected model (binding.model). */
  model: string;
  accountSlot: string;
  /** Provider family used for independence: "anthropic" | "openai" | "router:<provider prefix>". */
  family: string;
  basis: "named" | "jev" | "preferred" | "auto";
  why: string;
};

export type JevDecision = {
  question: "lane" | "repo" | "roleTemplate" | "modelFor" | "consequential" | "complete" | "target";
  /** For modelFor: which role. */
  subject?: RoleKind;
  choice: string | null;
  confidence: number;
  /** Top alternatives, for the inspector. */
  probabilities?: Readonly<Record<string, number>>;
  policy: "act" | "look-again" | "ask";
};

export type TaskSpec = {
  schema: "coding.taskspec";
  version: 1;
  id: Uuid;
  /** Increments on every pre-confirmation edit; a confirmed spec never changes. */
  revision: number;
  createdAt: IsoTime;
  requestedBy: VerifiedPrincipal;
  source: {
    channel: "voice" | "typed" | "ui";
    /** sha256 of the utterance; the text itself lives only in the job's redacted request field. */
    utteranceDigest: Digest;
  };
  repo: {
    repoId: RepoId;
    baseRef: string;
    baseSha: GitSha;
    /** coding/<slug>-<id6> */
    jobBranch: string;
    /** Dirty canonical-checkout changes are never included; true = owner acknowledged. */
    excludesUncommittedCanonicalChanges: true;
  };
  objective: string;
  nonGoals: readonly string[];
  doneWhen: readonly DoneCriterion[];
  roleTemplate: RoleTemplate;
  roles: readonly RoleAssignment[];
  checks: readonly CommandId[];
  /** Recorded on the base sha before building, so baseline failures are known. */
  baselineChecks: readonly CommandId[];
  approvalPoints: readonly ApprovalPoint[];
  allowDependencyChange: boolean;
  dataClass: "synthetic" | "business-internal";
  jobLimits: { maxWallMinutes: number; maxConcurrentAgents: number };
  jev: JevShapingRecord | null;
  /** Optional: absent on specs drafted before role-choice.ts (their digests are unchanged). */
  roleChoices?: readonly RoleChoice[];
  planner: { binding: AgentBinding; sessionId: string } | null;
  confirmation:
    | { state: "unconfirmed" }
    | { state: "confirmed"; by: VerifiedPrincipal; via: "ui" | "spoken-yes" | "typed"; at: IsoTime; specDigest: Digest };
};

/** Validator output; a spec with errors cannot be confirmed. */
export type TaskSpecValidation = {
  ok: boolean;
  errors: readonly {
    code:
      | "repo_not_allowed"
      | "base_unresolved"
      | "ownership_overlap"
      | "ownership_empty"
      | "path_outside_repo"
      | "agent_config"
      | "unknown_command"
      | "model_not_entitled"
      | "allowance_low"
      | "metered_route"
      | "consequential_in_role"
      | "secret_in_text"
      | "limits_out_of_range";
    detail: string;
    roleId?: RoleId;
  }[];
  warnings: readonly string[];
};

// ───────────────────────────── state machines ─────────────────────────────

export type JobState =
  | "draft"
  | "awaiting_confirmation"
  | "preparing"
  | "building"
  | "integrating"
  | "testing"
  | "reviewing"
  | "gating"
  | "awaiting_approval"
  | "applying"
  | "completed"
  | "needs_owner"
  | "blocked_allowance"
  | "failed"
  | "cancelled"
  | "interrupted";

export type JobTransitions = {
  draft: "awaiting_confirmation" | "cancelled";
  awaiting_confirmation: "draft" | "preparing" | "cancelled";
  preparing: "building" | "reviewing" | "failed" | "cancelled" | "interrupted";
  building: "integrating" | "needs_owner" | "blocked_allowance" | "failed" | "cancelled" | "interrupted";
  integrating: "testing" | "needs_owner" | "failed" | "cancelled" | "interrupted";
  testing: "reviewing" | "building" | "needs_owner" | "failed" | "cancelled" | "interrupted";
  reviewing: "gating" | "building" | "needs_owner" | "blocked_allowance" | "failed" | "cancelled" | "interrupted";
  gating: "completed" | "needs_owner" | "failed" | "interrupted";
  completed: "awaiting_approval";
  awaiting_approval: "applying" | "completed" | "cancelled";
  applying: "completed" | "needs_owner" | "interrupted";
  needs_owner: "building" | "testing" | "reviewing" | "gating" | "cancelled" | "failed";
  blocked_allowance: "building" | "reviewing" | "cancelled";
  /** Leaving `interrupted` for work is an explicit owner resume, never automatic recovery. */
  interrupted: "building" | "testing" | "reviewing" | "gating" | "applying" | "cancelled" | "failed";
  failed: never;
  cancelled: never;
};

export type AgentRunState =
  | "queued"
  | "starting"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "termination_unverified"
  | "blocked_allowance";

/** Allowed next states. Terminal: succeeded, failed, cancelled, termination_unverified. */
export type AgentRunTransitions = {
  queued: "starting" | "cancelled" | "blocked_allowance" | "interrupted";
  starting: "running" | "failed" | "cancelled" | "interrupted" | "termination_unverified";
  running: "needs_input" | "succeeded" | "failed" | "cancelled" | "interrupted" | "termination_unverified" | "blocked_allowance";
  needs_input: "running" | "failed" | "cancelled" | "interrupted" | "termination_unverified";
  /** Resume = explicit owner action; re-enters via starting with the same native session. */
  interrupted: "starting" | "cancelled";
  blocked_allowance: "starting" | "cancelled";
  succeeded: never;
  failed: never;
  cancelled: never;
  termination_unverified: never;
};

export type AgentRunTransition<S extends AgentRunState = AgentRunState> = {
  from: S;
  to: AgentRunTransitions[S];
  at: IsoTime;
  reason: AgentRunReason;
};

export type AgentRunReason =
  | "started"
  | "native_session_ready"
  | "input_requested"
  | "input_resolved"
  | "agent_reported_done_postcheck_passed"
  | "agent_reported_done_postcheck_failed"
  | "agent_error"
  | "wall_limit"
  | "turn_limit"
  | "owner_cancel"
  | "owner_interrupt"
  | "server_restart"
  | "kill_unconfirmed"
  | "window_threshold"
  | "provider_limit_reached"
  | "owner_resume";

export type AgentRun = {
  id: Uuid;
  jobId: Uuid;
  roleId: RoleId;
  role: RoleKind;
  binding: AgentBinding;
  state: AgentRunState;
  /** Native session: Claude pre-assigned --session-id; Codex threadId. Used for resume. */
  nativeSessionId: string | null;
  /** Worktree this run acts in (write roles: own branch; read-only roles: detached at a sha). */
  worktree: { branch: string | null; headAtStart: GitSha; detached: boolean };
  attempt: number;
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
  lastSeq: number;
  pendingInput: InputRequest | null;
  /** Builder: commit produced. Reviewer: sha reviewed. */
  resultSha: GitSha | null;
  history: readonly AgentRunTransition[];
  error: { code: RunErrorCode; message: string } | null;
};

export type RunErrorCode =
  | "not_installed"
  | "signed_out"
  | "spawn_failed"
  | "protocol_error"
  | "policy_violation"
  | "ownership_violation"
  | "postcheck_failed"
  | "limit_reached"
  | "timeout"
  | "output_limit"
  | "unknown";

// ───────────────────────────── inputs, policy ─────────────────────────────

export type InputRequest = {
  id: string;
  kind: "approval" | "question";
  /** Native tool name or Codex method, e.g. "Edit", "item/commandExecution/requestApproval". */
  nativeKind: string;
  title: string;
  /** Redacted detail. */
  detail: string;
  questions?: readonly { id: string; question: string; options?: readonly string[] }[];
  /** Why the policy engine escalated instead of deciding. */
  escalatedBecause: string;
  expiresAt: IsoTime;
};

export type PolicyDecision = {
  requestId: string;
  roleId: RoleId;
  nativeKind: string;
  decision: "auto-allow" | "auto-deny" | "escalate";
  rule:
    | "read-in-worktree"
    | "edit-owned"
    | "registry-command"
    | "git-local-safe"
    | "edit-not-owned"
    | "secret-path"
    | "git-consequential"
    | "dependency-install"
    | "deploy-tool"
    | "network"
    | "mcp-tool"
    | "destructive-fs"
    | "read-outside-worktree"
    | "git-config"
    | "runtime-path"
    | "live-checkout"
    | "harmless-tool"
    | "agent-config"
    | "unclassified";
  /** Redacted summary of the target (basename or command head), never full content. */
  target: string;
};

// ───────────────────────────── artefacts ─────────────────────────────

export type DiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  ownedBy: RoleId | null;
  eolOnly: boolean;
};

export type DiffSummary = {
  baseSha: GitSha;
  headSha: GitSha;
  files: readonly DiffFile[];
  outsideOwnership: readonly string[];
  /** Full patch stored as an artefact (redacted). */
  patch: ArtefactId;
};

export type TestResult = {
  commandId: CommandId;
  argv: readonly string[];
  sha: GitSha;
  /** Always "orchestrator": agent-reported results are never shown as test results. */
  ranBy: "orchestrator";
  exitCode: number | null;
  timedOut: boolean;
  counts: { passed: number | null; failed: number | null; skipped: number | null };
  /** Names of the failing tests, when the runner prints them and they match the count; else null. */
  failedTests: readonly string[] | null;
  durationMs: number;
  /** Redacted output tail. */
  output: ArtefactId;
  /** Baseline credit is by failing-test IDENTITY: every name failing now must have failed on base. */
  baseline: { sha: GitSha; exitCode: number | null; failed: number | null; failedTests: readonly string[] | null } | null;
};

export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

export type ReviewFinding = {
  id: string;
  severity: ReviewSeverity;
  file: string | null;
  line: number | null;
  message: string;
  /** ADVISORY: set by the reviewer (an agent), so the gate never trusts it. Only an OwnerAcceptance
   * from Stage B approvals resolves a major; a blocker always blocks. */
  status: "open" | "fixed" | "accepted-by-owner";
};

/**
 * The owner accepting one review finding for one sha. Created by the orchestrator from a consumed
 * Stage B approval by a verified principal, never from reviewer or request-body data.
 */
export type OwnerAcceptance = {
  findingId: string;
  sha: GitSha;
  by: PersonId;
  approvalId: Uuid;
  at: IsoTime;
};

export type ReviewVerdict = {
  reviewerRoleId: RoleId;
  binding: AgentBinding;
  sha: GitSha;
  verdict: "approve" | "request-changes" | "cannot-assess";
  findings: readonly ReviewFinding[];
  /** Per done-when criterion the reviewer was asked to confirm. */
  criteria: readonly { criterionId: string; met: boolean; note: string }[];
};

// ───────────────────────────── usage (Stage E receipt v2 superset) ─────────────────────────────

/** Field-compatible with model-catalogue.json `receipt.fields`; coding adds `coding` and `valueUsdEquivalent`. */
export type UsageReceipt = {
  requestId: Uuid;
  parentRequestId: Uuid | null;
  attempt: number;
  /** Router roles: the catalogue id originally selected when a different model ran. Null otherwise. */
  fallbackFrom: string | null;
  startedAt: IsoTime;
  endedAt: IsoTime;
  task: "coding.plan" | "coding.build" | "coding.test-author" | "coding.review";
  caller: "scripts/coding/orchestrator";
  person: PersonId;
  route: CodingRoute;
  /** The provider that ran: "anthropic", "openai", or the router's provider id ("openrouter", "codex", "cline" …). */
  provider: string;
  /** The account that actually ran this turn (owner decision 1). Same as allowance.accountSlot. */
  account: AccountSlot;
  /** The model that RAN (for a routed role, the router's choice after any fallback). */
  model: string;
  /** Identity the provider reported (Claude modelUsage key / Codex model), or null. */
  providerModel: string | null;
  costClass: "subscription" | "metered" | "free";
  dataClass: "synthetic" | "business-internal";
  outcome:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "termination_unverified"
    | "refused_policy"
    | "rate_limited";
  errorCode: "quota" | "auth" | "policy" | "transport" | "protocol" | null;
  latencyMs: { queue: number | null; provider: number | null; total: number };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    audioSeconds: null;
    characters: null;
    images: null;
  };
  /** Subscription roles: usd null (an allowance, not spend). Router roles carry the router's cost basis. */
  cost: { basis: "subscription_allowance" | "provider_reported" | "catalogue_price" | "free" | "free_tier_unverified" | "credits" | "unknown"; usd: number | null; capId: null; priceAsOf: string | null };
  /** Claude total_cost_usd etc.: API-equivalent VALUE, never spend. Null for Codex. */
  valueUsdEquivalent: number | null;
  allowance: {
    plan: "claude-max-20x" | "chatgpt-plus" | "chatgpt-pro" | string;
    accountSlot: AccountSlot;
    window: string;
    usedPercentAtLastRead: number | null;
    readAt: IsoTime | null;
    usedPercentAtEnd: number | null;
  } | null;
  /**
   * Codex credits (owner decision 2: openai-1's paid credits stay enabled and are recorded accurately).
   * `scope` says what the before/after pair covers: this job's turn when observable, otherwise the
   * account window it was read in. Unknown stays null, never 0. Null for Claude.
   */
  credits: {
    before: number | null;
    after: number | null;
    scope: "job" | "window";
    readAt: IsoTime | null;
  } | null;
  contextTrimmed: boolean;
  coding: { jobId: Uuid; roleId: RoleId; turn: number; cliVersion: string };
};

export type AllowanceSnapshot = {
  accountSlot: AccountSlot;
  windows: readonly { label: string; usedPercent: number | null; resetsAt: IsoTime | null }[];
  /** Codex: credits would be drawn past the plan limit. Allowed where the owner enabled them (openai-1,
   * decision 2) and recorded on the receipt; never a trigger to buy credits or change top-up. */
  creditsWouldBeUsed: boolean;
  /** Codex credit balance at readAt, when the account reports one. */
  creditsBalance?: number | null;
  limitReached: boolean;
  source: "anthropic-oauth-usage-cached" | "codex-app-server-ratelimits";
  readAt: IsoTime;
};

// ───────────────────────────── approvals (Stage B reference) ─────────────────────────────

/**
 * Reference to a Stage B durable approval (ENTITY-MAP row 13). The harness never stores the grant;
 * it holds this reference and asks Stage B to consume it exactly once.
 */
export type ApprovalRequestRef = {
  approvalId: Uuid;
  subject: { kind: "coding.apply"; jobId: Uuid; applyStepId: Uuid };
  action: ApprovalAction;
  /** sha256 over {action, repoId, remote|branch, fromSha, toRef, specDigest}. Any change voids it. */
  digest: Digest;
  requestedBy: VerifiedPrincipal;
  /** Always the owner for production actions. */
  approverPersonId: PersonId;
  targetDeviceId: DeviceId;
  summary: string;
  state: "pending" | "approved" | "rejected" | "expired" | "cancelled" | "consumed";
  issuedVia: "ui" | "spoken-yes" | "typed" | null;
  createdAt: IsoTime;
  expiresAt: IsoTime;
  consumedAt: IsoTime | null;
};

export type ApplyStep = {
  id: Uuid;
  jobId: Uuid;
  action: ApprovalAction;
  repoId: RepoId;
  fromSha: GitSha;
  toRef: string;
  remote: string | null;
  idempotencyKey: Digest;
  approval: ApprovalRequestRef;
  state: "awaiting_approval" | "running" | "succeeded" | "failed" | "outcome_unknown" | "cancelled";
  /** Read back from the source, e.g. ls-remote sha, merge commit, deployment id. */
  verification: { method: "ls-remote" | "merge-commit" | "deploy-api"; observed: string; at: IsoTime } | null;
};

/** Pre-authorised by V6 §1: private backup pushes to verified owner repos. Recorded, not approved. */
export type BackupPush = { jobId: Uuid; remote: string; ref: string; sha: GitSha; at: IsoTime; verified: boolean };

// ───────────────────────────── control requests ─────────────────────────────

export type CancelRequest = {
  jobId: Uuid;
  /** Omit to cancel the whole job. */
  roleId?: RoleId;
  requestedBy: VerifiedPrincipal;
  reason: "owner" | "voice-stop" | "limit" | "policy";
  /** Client idempotency key. */
  requestId: Uuid;
};

export type InterruptRequest = {
  jobId: Uuid;
  roleId?: RoleId;
  requestedBy: VerifiedPrincipal;
  requestId: Uuid;
};

export type ResumeRequest = {
  jobId: Uuid;
  roleId?: RoleId;
  requestedBy: VerifiedPrincipal;
  requestId: Uuid;
  /** Owner may explicitly reassign a blocked role to another binding (recorded, never automatic). */
  reassignTo?: AgentBinding;
};

export type InputResponse = {
  jobId: Uuid;
  roleId: RoleId;
  inputId: string;
  decision: "approve" | "deny";
  answers?: Readonly<Record<string, string>>;
  requestedBy: VerifiedPrincipal;
};

// ───────────────────────────── events ─────────────────────────────

export type EventBase<T extends string, P> = {
  jobId: Uuid;
  seq: number;
  at: IsoTime;
  type: T;
  roleId: RoleId | null;
  payload: P;
};

export type CodingEvent =
  | EventBase<"state", { scope: "job"; from: JobState; to: JobState } | { scope: "run"; runId: Uuid; from: AgentRunState; to: AgentRunState; reason: AgentRunReason }>
  | EventBase<"jev", JevDecision>
  | EventBase<"plan", { specId: Uuid; revision: number; specDigest: Digest; summary: string }>
  | EventBase<"step", { label: string; detail?: string }>
  | EventBase<"text", { text: string; final: boolean }>
  | EventBase<"input_request", InputRequest>
  | EventBase<"input_resolved", { inputId: string; decision: "approve" | "deny" | "expired"; by: PersonId | "policy" }>
  | EventBase<"policy", PolicyDecision>
  | EventBase<"diff", DiffSummary>
  | EventBase<"test", TestResult>
  | EventBase<"review", ReviewVerdict>
  | EventBase<"usage", UsageReceipt>
  | EventBase<"allowance", AllowanceSnapshot>
  | EventBase<"approval_request", ApprovalRequestRef>
  | EventBase<"approval_resolved", { approvalId: Uuid; state: ApprovalRequestRef["state"] }>
  | EventBase<"apply", ApplyStep>
  | EventBase<"backup", BackupPush>
  | EventBase<"gate", DoneGateResult>
  | EventBase<"handoff", { handoffId: Uuid; memory: "saved" | "skipped-writes-off" | "failed"; workLinked: boolean }>
  | EventBase<"recovery", { interruptedRuns: readonly Uuid[]; outcomeUnknownApplies: readonly Uuid[]; snapshot: readonly { roleId: RoleId; head: GitSha; dirtyFiles: number }[] }>
  | EventBase<"spoken", { line: string }>
  | EventBase<"error", { code: RunErrorCode; message: string }>;

export type CodingEventType = CodingEvent["type"];

// ───────────────────────────── done gate ─────────────────────────────

export type GateCheck =
  | "committed-and-clean"
  | "ownership"
  | "no-eol-only-churn"
  | "secret-scan"
  | "checks-pass"
  | "review-approved-for-sha"
  | "done-when-evidenced"
  /** Present only when the orchestrator supplied the run list: every finished agent run has its usage receipt. */
  | "receipts-recorded";

export type DoneGateResult = {
  sha: GitSha;
  passed: boolean;
  checks: readonly { check: GateCheck; passed: boolean; detail: string }[];
  /** Failures on the base sha, by the same command, recorded before building. */
  baselineFailures: readonly { commandId: CommandId; failed: number }[];
  at: IsoTime;
};

// ───────────────────────────── job + handoff ─────────────────────────────

export type CodingJob = {
  id: Uuid;
  spec: TaskSpec;
  state: JobState;
  runs: readonly AgentRun[];
  headSha: GitSha | null;
  diff: DiffSummary | null;
  tests: readonly TestResult[];
  review: ReviewVerdict | null;
  gate: DoneGateResult | null;
  applies: readonly ApplyStep[];
  executorDevice: DeviceId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  lastSeq: number;
};

export type Handoff = {
  id: Uuid;
  jobId: Uuid;
  repoId: RepoId;
  baseSha: GitSha;
  jobBranch: string;
  headSha: GitSha | null;
  /** Honest end state; a failed or interrupted job still gets a handoff. */
  outcome: "completed-verified" | "completed-awaiting-approval" | "applied" | "needs-owner" | "failed" | "cancelled" | "interrupted";
  objective: string;
  changedFiles: readonly { path: string; status: DiffFile["status"] }[];
  tests: readonly { commandId: CommandId; passed: number | null; failed: number | null; exitCode: number | null }[];
  review: { verdict: ReviewVerdict["verdict"]; blockers: number; majors: number; minors: number } | null;
  usage: readonly { roleId: RoleId; model: string; accountSlot: AccountSlot; turns: number; inputTokens: number | null; outputTokens: number | null }[];
  followUps: readonly string[];
  notDone: readonly string[];
  links: {
    job: string;
    work: string | null;
    /** Stage D vault source, when memory writes were on. */
    memory: { kind: "vault"; note_id: string; link: string } | null;
  };
  createdAt: IsoTime;
};

// ───────────────────────────── routes (/__operator/coding/*) ─────────────────────────────

export type CodingRoutes = {
  "GET /coding/jobs": { query: { state?: JobState | "needs-you"; repo?: RepoId; limit?: number }; response: { jobs: readonly CodingJob[] } };
  "GET /coding/jobs/:id": { response: { job: CodingJob } };
  "GET /coding/jobs/:id/events": { query: { after?: number }; response: "text/event-stream of CodingEvent" };
  "GET /coding/artefacts/:jobId/:artefactId": { response: "text/plain (redacted)" };
  "POST /coding/shape": {
    body: { requestId: Uuid; utterance: string; channel: "voice" | "typed" | "ui"; draftId?: Uuid; answer?: string };
    response:
      | { kind: "ask"; draftId: Uuid; question: string; options?: readonly string[] }
      | { kind: "draft"; spec: TaskSpec; validation: TaskSpecValidation; spokenSummary: string }
      | { kind: "refused"; reason: string };
  };
  "POST /coding/jobs": { body: { specId: Uuid; specDigest: Digest; requestId: Uuid; confirmation: "ui" | "spoken-yes" | "typed"; spokenEventId?: string }; response: { job: CodingJob } };
  "POST /coding/jobs/:id/cancel": { body: CancelRequest; response: { job: CodingJob } };
  "POST /coding/jobs/:id/interrupt": { body: InterruptRequest; response: { job: CodingJob } };
  "POST /coding/jobs/:id/resume": { body: ResumeRequest; response: { job: CodingJob } };
  "POST /coding/jobs/:id/input": { body: InputResponse; response: { job: CodingJob } };
  "POST /coding/jobs/:id/apply": { body: { action: ApprovalAction; toRef: string; remote?: string; requestId: Uuid }; response: { apply: ApplyStep } };
  "POST /coding/jobs/:id/tests/rerun": { body: { commandId: CommandId; requestId: Uuid }; response: { test: TestResult } };
  "GET /coding/repos": { response: { repos: readonly Pick<RepoRegistryEntry, "id" | "description" | "defaultBaseRef">[] } };
  "GET /coding/accounts": { response: { accounts: readonly (AllowanceSnapshot & { installed: boolean; signedIn: boolean; cliVersion: string | null; models: readonly string[] })[] } };
};

// ───────────────────────────── voice ─────────────────────────────

export type CodingVoiceIntent =
  | { intent: "start"; utterance: string }
  | { intent: "edit-draft"; utterance: string }
  | { intent: "confirm-start" }
  | { intent: "status"; jobHint?: string }
  | { intent: "show"; tab: "changes" | "tests" | "review" | "usage" | "plan" }
  | { intent: "stop"; roleHint?: RoleKind }
  | { intent: "pause" }
  | { intent: "resume" }
  | { intent: "apply"; action: "git.merge.protected" | "git.push.production" | "deploy" }
  | { intent: "approve-asked" }
  | { intent: "reject-asked" };

/** Spoken lines are templates filled from verified state only. */
export type SpokenProgressTemplate =
  | "draft-ready"
  | "started"
  | "builder-committed"
  | "tests-result"
  | "review-result"
  | "done-verified"
  | "needs-input"
  | "allowance-paused"
  | "interrupted-not-replayed"
  | "approval-question"
  | "applied-verified"
  | "apply-outcome-unknown";
