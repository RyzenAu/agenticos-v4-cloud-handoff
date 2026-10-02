// Triggers and routines: ONE model on top of the existing job and approval services (no second job
// engine). A trigger turns an app event (or a routine's schedule slot) into a deduplicated durable job.
//
// What is stored, and what is not: only ids, a hash of the event identity and a SHORT masked "safe"
// projection chosen by the source adapter (a ref, a topic, flag codes). Message bodies, caller names,
// numbers and e-mail addresses are never accepted into this store (safeFields masks and bounds them).

export type TriggerKind = "event" | "routine";
export type TriggerState = "active" | "paused" | "disabled";
/** draft: the action runs now but may only draft or record. review: an owner approval comes first. */
export type TriggerMode = "draft" | "review";
/** What a routine does when the host was down at its scheduled time. */
export type OfflinePolicy = "skip" | "run-once" | "review";
export const OFFLINE_POLICIES: readonly OfflinePolicy[] = ["skip", "run-once", "review"];

export type SafeValue = string | number | boolean;
export type SafeFields = Record<string, SafeValue>;

/** All conditions must hold (AND). Evaluated on the safe projection only. */
export type Condition =
  | { field: string; op: "eq"; value: SafeValue }
  | { field: string; op: "in"; value: SafeValue[] }
  | { field: string; op: "contains"; value: string }
  | { field: string; op: "exists" };

export type RoutineSchedule = { kind: "daily"; at: string; tz: string } | { kind: "interval"; everyMinutes: number };

export type TriggerDef = {
  id: string;
  name: string;
  kind: TriggerKind;
  /** "synthetic.enquiry" | "receptionist.flag" | "routine.schedule" | any source an adapter registers. */
  source: string;
  action: string;
  conditions: Condition[];
  mode: TriggerMode;
  state: TriggerState;
  /** Automatic attempts per delivery before it shows as failed. A manual retry is always allowed. */
  retryLimit: number;
  offlinePolicy?: OfflinePolicy;
  schedule?: RoutineSchedule;
  config: Record<string, SafeValue>;
  createdAt: number;
  updatedAt: number;
};

/** An event as an adapter hands it over: identity plus a safe projection, never a payload. */
export type TriggerEvent = {
  source: string;
  /** Stable id from the source (message id, call id, slot). The dedupe key derives from it. */
  eventId: string;
  occurredAt?: number;
  /** "agent" = produced by one of our own agents/jobs; such an event never triggers anything. */
  actor?: "agent" | "external" | "system";
  /** The id of whatever caused this event, when the source knows it (a draft, a sent mail, a job). */
  originRef?: string;
  fields: Record<string, unknown>;
};

export type DeliveryStatus = "queued" | "running" | "awaiting-approval" | "succeeded" | "retrying" | "failed" | "unknown" | "rejected" | "ignored";

export type DeliveryView = {
  id: number;
  triggerId: string;
  status: DeliveryStatus;
  /** A short code, never free text: self-output, action-error, interrupted, approval-rejected... */
  reason: string | null;
  attempts: number;
  repeats: number;
  receivedAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
  jobId: string | null;
  jobs: { attempt: number; jobId: string }[];
  safe: SafeFields;
  approvalId: string | null;
};

export type TriggerHealth = "active" | "paused" | "disabled" | "failing";
export type TriggerView = Omit<TriggerDef, "config"> & {
  health: TriggerHealth;
  stats: { delivered: number; duplicates: number; ignored: number; failed: number; pending: number };
  lastDelivery: DeliveryView | null;
  lastRun: RoutineRunView | null;
  nextRunAt: string | null;
};

export type RoutineOutcome = "ran" | "skipped-offline" | "ran-on-return" | "coalesced" | "review-requested";
export type RoutineRunView = { slot: string; outcome: RoutineOutcome; jobId: string | null; at: string; missed: number };
