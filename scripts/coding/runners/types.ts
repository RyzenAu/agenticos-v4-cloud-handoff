/**
 * The role-runner contract (CODING-HARNESS §3.4, task C3). Every runner (Claude Code over stream-json,
 * Codex over the app-server, a routed text model through scripts/model-router) implements `RoleRunner`.
 *
 * The orchestrator owns state (the store), worktrees, tests and the gate. A runner owns ONE native turn:
 * it launches the CLI (or makes the routed call), streams events, puts every native approval through
 * the injected policy BEFORE any human sees it, escalates only what policy can't decide, and reports an
 * honest outcome plus the usage it observed. A runner never retries, never replays, never rotates
 * accounts and never falls back to another CLI: those are orchestrator decisions (and a routed role's
 * automatic fallback is the router's, recorded on its receipt).
 */
import type {
  AgentBinding,
  AllowanceSnapshot,
  GuidanceUse,
  InputRequest,
  PolicyDecision,
  RoleKind,
  RunErrorCode,
} from "../contracts";

/** What the agent asked to do, normalised across CLIs, for the policy engine. */
export type PolicyRequest =
  /** Claude `can_use_tool` (Read, Edit, Write, Bash, WebFetch, mcp__x__y, AskUserQuestion …). */
  | { kind: "tool"; tool: string; input: Record<string, unknown> }
  /** Codex `item/commandExecution/requestApproval` (the command line and its cwd). */
  | { kind: "command"; command: string; cwd?: string | null }
  /** Codex `item/fileChange/requestApproval`, with the paths Codex announced on item/started. */
  | { kind: "file-change"; paths: readonly string[]; grantRoot?: string | null }
  /** Codex `item/permissions/requestApproval` (extra sandbox permissions for the turn). */
  | { kind: "permissions"; permissions: unknown; reason?: string | null }
  /** Codex `mcpServer/elicitation/request`, or any MCP tool call. */
  | { kind: "mcp"; server?: string | null; tool?: string | null }
  /** A question for the owner (Claude AskUserQuestion, Codex requestUserInput). Always escalated. */
  | { kind: "question"; questions: readonly { id: string; question: string; options?: readonly string[] }[] };

/** The policy engine's answer. `message` goes back to the agent on a deny ("outside your owned files …"). */
export type PolicyVerdict = Omit<PolicyDecision, "requestId" | "roleId" | "nativeKind"> & { message: string };

export type PolicyFn = (request: PolicyRequest) => PolicyVerdict;

/** Usage one turn observed. Unknown stays null, never 0. */
export type TurnUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

export const NO_USAGE: TurnUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null };

export type RunnerEvent =
  /** The native session id (Claude --session-id / Codex threadId). Emitted once it is known. */
  | { type: "session"; id: string }
  /** The model the PROVIDER reported running (Claude system/init + modelUsage, Codex thread model or
   * model/rerouted, the router's choice). Emitted every time it is learned or changes. */
  | { type: "model"; model: string; source: "init" | "usage" | "rerouted" | "router" }
  /** The account the CLI reported (plan only; never an email or id). */
  | { type: "account"; plan: string | null; accountType: string | null }
  | { type: "text"; text: string; final: boolean }
  | { type: "step"; label: string; detail?: string }
  /** Every native approval's policy decision, allow and deny included. */
  | { type: "policy"; nativeKind: string; requestId: string; verdict: PolicyVerdict }
  /** An escalation: the orchestrator shows it (UI card + spoken line) and answers with `respond`. */
  | { type: "input"; request: InputRequest }
  | { type: "input_resolved"; id: string; decision: "approve" | "deny" | "expired" }
  | { type: "allowance"; snapshot: AllowanceSnapshot }
  | { type: "usage"; usage: TurnUsage };

export type RunnerStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  /** Paused by the owner (turn interrupted); resumable on the same native session. */
  | "interrupted"
  /** A window reached the stop threshold or the provider limit, and no credits may be drawn. */
  | "blocked_allowance"
  /** The kill could not be confirmed within the grace period. */
  | "termination_unverified";

export type RunnerOutcome = {
  status: RunnerStatus;
  error: { code: RunErrorCode; message: string } | null;
  /** The agent's final message (redacted). The orchestrator never treats it as proof of anything. */
  finalText: string;
  sessionId: string | null;
  /** The model the provider reported, or null if it never said. */
  providerModel: string | null;
  /** The routed role's catalogue id that ran, when different from the binding's selection. */
  fallbackFrom?: string | null;
  /** The router provider that ran (router roles), e.g. "openrouter". */
  routedProvider?: string | null;
  /** The provider's own model id for a routed role (e.g. "deepseek/deepseek-v4-pro"), when reported. */
  routedProviderModel?: string | null;
  usage: TurnUsage;
  /** Claude total_cost_usd (API-equivalent VALUE, not spend); router provider cost for metered roles. */
  valueUsdEquivalent: number | null;
  /** Router roles: the router's cost basis and USD (metered spend is real; subscription is not). */
  routedCost?: { basis: string; usd: number | null; priceAsOf: string | null; route?: "free" | "subscription" | "metered" } | null;
  turns: number | null;
  startedAt: number;
  endedAt: number;
  /** Allowance at the end of the turn, when the runner could read it. */
  allowanceEnd: AllowanceSnapshot | null;
  /** Codex: which plan the account reported, to check it matches the slot. */
  accountPlan: string | null;
  /** The CLI version that actually ran this turn (the binding's is only what was known at draft time). */
  cliVersion?: string | null;
  /** Engineering guidance supplied to (or withheld from) this turn, set by `withGuidance` (guidance.ts). */
  guidance?: readonly GuidanceUse[];
};

export type SessionMode =
  /** A new native session. Claude: this id is passed as --session-id (pre-assigned). Codex: ignored. */
  | { mode: "new"; id: string }
  /** Continue a native session: Claude --resume <id>; Codex thread/resume {threadId}. */
  | { mode: "resume"; id: string };

export type RunnerStart = {
  jobId: string;
  roleId: string;
  role: RoleKind;
  binding: AgentBinding;
  /** The role's worktree (write roles: their branch; read-only roles: detached at a sha). */
  cwd: string;
  /** Built from the TaskSpec only (never memory, inbox, transcripts or env). Sent on stdin, never argv. */
  prompt: string;
  /** Extra system text (role rules), sent by file or protocol field, never argv. */
  system: string;
  readOnly: boolean;
  session: SessionMode;
  policy: PolicyFn;
  signal: AbortSignal;
  onEvent: (event: RunnerEvent) => void;
  limits: { wallMs: number; maxTurns: number; inputTimeoutMs: number };
  /** Stop before any window reaches this percentage (blocked_allowance). */
  stopAtWindowPercent: number;
  /** owner decision 2: may this account draw paid credits past its plan limit (openai-1 only)? */
  creditsAllowed: boolean;
  /** Codex only: the CODEX_HOME of the slot's own login, null = the default ~/.codex. */
  codexHome?: string | null;
  /** Claude roles: the slot's own CLAUDE_CONFIG_DIR (null = the default ~/.claude login, "claude:max"). */
  claudeConfigDir?: string | null;
  /** Claude roles, opt-in: the per-run context helper (runners/context-helper.ts). Absent = today's behaviour exactly. */
  contextHelper?: import("./context-helper").ContextHelperRequest;
  /** Reviewer/planner structured output: a JSON Schema (kept small; sent by file where the CLI allows). */
  jsonSchema?: Record<string, unknown>;
};

export type RunnerHandle = {
  /** Answer an escalated input. Throws if that input is not the one waiting. */
  respond(inputId: string, decision: "approve" | "deny", answers?: Record<string, string>): void;
  /** "Pause it": interrupt the current turn; the outcome is `interrupted` (resumable). */
  interrupt(): void;
  /** Stop: the outcome is `cancelled` (or `termination_unverified`). */
  cancel(): void;
  done: Promise<RunnerOutcome>;
};

export interface RoleRunner {
  readonly kind: AgentBinding["route"];
  start(input: RunnerStart): RunnerHandle;
}
