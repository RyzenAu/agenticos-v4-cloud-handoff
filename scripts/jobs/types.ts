// Job / Step / Receipt (TARGET-ARCHITECTURE §3.3, receipts extended by V7 `fallbackFrom`). Pure types,
// shared by the server (scripts/jobs/service.ts) and the UI (src/lib/job-events.ts reads the JSON).
import type { Principal } from "../approvals/principal";

export type JobKind = "voice" | "command" | "screen" | "control" | "away" | "coding" | "memory" | "lesson" | "trigger";
export type JobState = "queued" | "running" | "awaiting-approval" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
export const JOB_KINDS: readonly JobKind[] = ["voice", "command", "screen", "control", "away", "coding", "memory", "lesson", "trigger"];
/** A CRM reference as a job stores it: `crm:<kind>:<id>` (the kinds of AGENTS-CRM-CONTRACTS.md §1). */
// The id half is exactly src/lib/crm-ref.ts's (first character alphanumeric, up to 160): a CRM record id the CRM accepts is one a job can carry.
export const SUBJECT_REF = /^crm:(?:company|contact|deal|project|document|lead):[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
export const BOT_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TERMINAL_STATES: readonly JobState[] = ["succeeded", "failed", "cancelled", "interrupted", "unknown"];

/** Jev's typed decision for a step (Stage C fills this; B2 stores it). */
export type JevDecisionRef = {
  op: string;
  confidence: number;
  policy: "act" | "look-again" | "ask" | "delegate" | "done" | string;
  delegateTo?: string;
  deviceId?: string;
  ms?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Who decided (round 10): "jev" only with a real Jev call behind it (then `ms`, `requestId`, `model` are that call's); a rule says "rule". */
  decidedBy?: "jev" | "rule" | "fallback" | "context" | "registry" | "unknown";
  /** The Jev call's router request id (its receipt), when Jev decided. */
  requestId?: string;
  /** The Jev model id that answered, when Jev decided. */
  model?: string;
  /** The finite options Jev was offered, and whether its answer came from the decision cache (Jev decisions only). */
  options?: string[];
  cached?: boolean;
};
export type StepOutcome = "ok" | "failed" | "skipped" | "refused" | "asked" | "cancelled" | "unknown" | "note";
export type Step = {
  seq: number;
  /** Epoch ms. */
  at: number;
  /** One short masked line: what this step is for. */
  intent: string;
  executor: string;
  target?: string;
  jev?: JevDecisionRef;
  /** The masked action performed ("press 'Send'", "[typed 12 characters]"). */
  action?: string;
  verification?: { method: string; ok: boolean | null; evidence?: string };
  approvalId?: string;
  ms: number;
  outcome: StepOutcome;
};
export type ReceiptRoute = "free" | "subscription" | "metered";
export type ReceiptOutcome = "succeeded" | "failed" | "cancelled" | "timed_out" | "termination_unverified" | "refused_policy" | "rate_limited" | "unknown";
export type Receipt = {
  requestId: string;
  provider: string;
  model: string;
  route: ReceiptRoute;
  selectedBy: "jev" | "rule" | "owner";
  reason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  allowance?: { plan: string; window: string; usedPct: number | null };
  latencyMs: number | null;
  outcome: ReceiptOutcome;
  /** V7: the model that was selected but unavailable/limited, when an automatic free fallback ran. */
  fallbackFrom: string | null;
};
export type Job = {
  id: string;
  kind: JobKind;
  principal: Principal;
  targetDeviceId: string;
  state: JobState;
  /** Masked one-line title ("Send the invoice email"). */
  title: string;
  requestId?: string;
  approvalId?: string;
  /** Cooperative stop flag (durable). */
  cancelRequested: boolean;
  quarantined: boolean;
  quarantineReason?: string;
  /** Short masked note for the terminal state ("Interrupted at restart: not re-run"). */
  note?: string;
  /** The agent bot this job was made for (Agents workspace), when it came through a bot's conversation. */
  bot?: string;
  /** CRM record references the work is about (`crm:deal:42`; see docs/programme-20261001/AGENTS-CRM-CONTRACTS.md). References only, never field values. */
  subjects?: string[];
  steps: Step[];
  receipts: Receipt[];
  createdAt: string;
  updatedAt: string;
};
export type JobSummary = Omit<Job, "steps" | "receipts"> & { stepCount: number; lastStep: Step | null };
export type JobEvent =
  | { seq: number; at: number; type: "job"; jobId: string; job: JobSummary }
  | { seq: number; at: number; type: "step"; jobId: string; step: Step }
  | { seq: number; at: number; type: "receipt"; jobId: string; receipt: Receipt };
