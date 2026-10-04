// Browser client for the coding harness (/__operator/coding/*, Track 3 C5). Types come from the server's
// contract file (type-only import). Reads are plain GETs; writes carry the caller's own page token.
import type {
  AgentBinding,
  CodingEvent,
  CodingJob,
  Handoff,
  JobState,
  TaskSpec,
  TaskSpecValidation,
  UsageReceipt,
} from "../../scripts/coding/contracts";

import type { readableJob } from "../../scripts/coding/job-view";

export type { AgentBinding, CodingEvent, CodingJob, Handoff, JobState, TaskSpec, UsageReceipt };

export type ApprovalView = {
  applyStepId: string;
  approvalId: string;
  action: string;
  summary: string;
  state: string;
  expiresAt: string;
  answeredBy: string[];
  applyState: string;
  verification: { method: string; observed: string; at: string } | null;
};

export type JobView = {
  job: CodingJob;
  receipts: UsageReceipt[];
  approvals: ApprovalView[];
  handoff: Handoff | null;
  events: CodingEvent[];
  liveRoles: string[];
  specDigest: string;
  /** A paused job whose files have newer commits on the base branch: the commit and reason to prefill in "Mark superseded". */
  supersedeHint?: { ref: string; reason: string; commits: number } | null;
  /** Plain-words view built by the server (older servers omit it). */
  readable?: ReturnType<typeof readableJob>;
};

export type ShapeResponse =
  | { kind: "ask"; draftId: string; question: string; options?: string[] }
  | { kind: "draft"; spec: TaskSpec; jobId: string; specDigest: string; validation: TaskSpecValidation; spokenSummary: string }
  | { kind: "refused"; reason: string };

export type CodingRepo = { id: string; description: string; defaultBaseRef: string; checks?: { id: string; kind: string }[] };
export type AllowanceWindow = { label: string; usedPercent: number | null; resetsAt: string | null };
/** One Claude login (30 Sep 2026: several, each on its own profile). An older server sends only claude:max without `connection`. */
export type ClaudeCodingAccount = {
  accountSlot: string;
  provider?: "anthropic";
  label?: string;
  plan?: string;
  profile?: string;
  installed: boolean;
  cliVersion: string | null;
  /** From `claude auth status` on that profile; "unknown" until checked. A folder or a browser login is never "connected". */
  connection?: { state: "connected" | "signed-out" | "unknown"; reason: string | null; subscription: string | null; checkedAt: string | null };
  allowance: { windows: AllowanceWindow[]; limitReached: boolean } | null;
  models: readonly string[];
  /** Models a finished job has actually run on this account (receipts). */
  modelsVerified?: string[];
};
export type CodexCodingAccount = { accountSlot: string; installed: boolean; cliVersion: string | null; plan: string; creditsAllowed: boolean; home: string; reading: { peakPercent: number | null; resetsAt: string | null } | null; models: readonly string[] };
export type CodingAccount = ClaudeCodingAccount | CodexCodingAccount;
export const isClaudeAccount = (a: CodingAccount): a is ClaudeCodingAccount => a.accountSlot.startsWith("claude:");
export const claudeAccountLabel = (a: ClaudeCodingAccount) => a.label ?? (a.accountSlot === "claude:max" ? "Claude Max" : a.accountSlot);
export type CodingAccounts = {
  accounts: CodingAccount[];
  /** Absent on an older server: shown as "not checked". */
  codexIsolation?: { state: "paused" | "protected"; label: string; detail: string; technical?: string; approvedAt: string | null; protectedPaths: number | null };
};

const BASE = "/__operator/coding";

async function token(): Promise<string> {
  const r = await fetch("/__token");
  if (!r.ok) throw new Error("The local session token is unavailable. Refresh the page.");
  const t = (await r.json())?.token;
  if (typeof t !== "string") throw new Error("The local session token is unavailable. Refresh the page.");
  return t;
}

async function get<T>(path: string): Promise<T> {
  // A read never waits forever: a sleeping PC or a dropped tailnet must end as an error the page can show.
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out) throw new Error(out?.error ?? `Request failed (HTTP ${res.status})`);
  return out as T;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
    body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out || out.error) throw new Error(out?.error ?? `Request failed (HTTP ${res.status})`);
  return out as T;
}

export const codingClient = {
  list: (filter: { state?: string; repo?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as [string, string][]);
    return get<{ jobs: CodingJob[]; liveJobs: string[] }>(`/jobs${q.size ? `?${q}` : ""}`);
  },
  job: (id: string) => get<JobView>(`/jobs/${id}`),
  focus: () => get<{ focus: { jobId: string; tab: string; at: number } | null }>("/focus"),
  repos: () => get<{ repos: CodingRepo[] }>("/repos"),
  accounts: (refresh = false) => get<CodingAccounts>(`/accounts${refresh ? "?refresh=1" : ""}`),
  /** Before Start only: run a role on another account (and optionally model). Returns the revised draft. */
  setRoleAccount: (id: string, roleId: string, accountSlot: string, change: { route?: string; model?: string } = {}) =>
    post<Extract<ShapeResponse, { kind: "draft" }>>(`/jobs/${id}/account`, { roleId, accountSlot, ...change }),
  /** Before Start only: edit the plan's words (objective, done-when lines, non-goals). A new revision; the old digest can't start. */
  editPlan: (id: string, patch: { objective?: string; doneWhen?: { id?: string; text: string }[]; nonGoals?: string[] }) =>
    post<Extract<ShapeResponse, { kind: "draft" }>>(`/jobs/${id}/plan`, patch),
  artefact: async (jobId: string, artefactId: string) => {
    const res = await fetch(`${BASE}/artefacts/${jobId}/${artefactId}`);
    if (!res.ok) throw new Error(`Couldn't load it (HTTP ${res.status}).`);
    return res.text();
  },
  shape: (utterance: string, extra: { draftId?: string; answer?: string; replaces?: string } = {}) => post<ShapeResponse>("/shape", { utterance, channel: "ui", ...extra }),
  start: (jobId: string, specDigest: string) => post<{ job: CodingJob }>("/jobs", { specId: jobId, specDigest, confirmation: "ui" }),
  cancel: (id: string, roleId?: string) => post<{ job: CodingJob }>(`/jobs/${id}/cancel`, roleId ? { roleId } : {}),
  supersede: (id: string, ref: string, reason: string) => post<{ job: CodingJob }>(`/jobs/${id}/supersede`, { ref, reason }),
  unsupersede: (id: string) => post<{ job: CodingJob }>(`/jobs/${id}/unsupersede`, {}),
  interrupt: (id: string, roleId?: string) => post<{ job: CodingJob }>(`/jobs/${id}/interrupt`, roleId ? { roleId } : {}),
  resume: (id: string, extra: { roleId?: string; reassignTo?: { route: string; model: string; accountSlot?: string }; paidAcknowledged?: boolean; /** The owner's decision: a change he made to a checkout the job must not touch is accepted. */ acceptCheckoutChange?: boolean } = {}) => post<{ job: CodingJob }>(`/jobs/${id}/resume`, extra),
  input: (id: string, roleId: string, inputId: string, decision: "approve" | "deny", answers?: Record<string, string>) =>
    post<{ job: CodingJob }>(`/jobs/${id}/input`, { roleId, inputId, decision, ...(answers ? { answers } : {}) }),
  apply: (id: string, action: "git.merge.protected" | "git.push.production", toRef: string, remote?: string) =>
    post<{ apply: unknown; approval: { id: string; state: string; summary: string; expiresAt: string }; answeredBy: string[] }>(`/jobs/${id}/apply`, { action, toRef, ...(remote ? { remote } : {}) }),
  rerun: (id: string, commandId: string) => post<{ test: unknown }>(`/jobs/${id}/tests/rerun`, { commandId }),
};

/**
 * Live events for one job: SSE from the append-only store, resuming from the last seq after a reconnect,
 * with a poll fallback (the same endpoint) when EventSource isn't available or keeps failing.
 */
export function followJob(jobId: string, after: number, onEvent: (e: CodingEvent) => void, onState: (s: "live" | "polling" | "offline") => void): () => void {
  let last = after;
  let closed = false;
  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  const deliver = (e: CodingEvent) => {
    if (e.seq <= last) return;
    last = e.seq;
    onEvent(e);
  };
  const poll = async () => {
    if (closed) return;
    try {
      const out = await get<{ events: CodingEvent[]; last: number }>(`/jobs/${jobId}/events?poll=1&after=${last}`);
      out.events.forEach(deliver);
      onState("polling");
    } catch {
      onState("offline");
    }
    pollTimer = setTimeout(poll, 2000);
  };
  const open = () => {
    if (closed) return;
    if (typeof EventSource === "undefined" || failures >= 3) return void poll();
    source = new EventSource(`${BASE}/jobs/${jobId}/events?after=${last}`);
    source.addEventListener("coding", (m) => {
      failures = 0;
      onState("live");
      try { deliver(JSON.parse((m as MessageEvent).data)); } catch { /* malformed frame */ }
    });
    source.onopen = () => onState("live");
    source.onerror = () => {
      source?.close();
      source = null;
      failures++;
      onState("offline");
      setTimeout(open, Math.min(8000, 500 * 2 ** failures));
    };
  };
  open();
  return () => {
    closed = true;
    source?.close();
    if (pollTimer) clearTimeout(pollTimer);
  };
}

// ─────────────────────────── display helpers (pure) ───────────────────────────

export type Tone = "neutral" | "accent" | "success" | "warn" | "danger" | "info";

/** The job state in words and a tone. Colour never carries it alone. "Waiting for approval" ≠ done. */
export function jobStateLabel(state: JobState): { label: string; tone: Tone } {
  switch (state) {
    case "draft": return { label: "Draft: needs fixes", tone: "warn" };
    case "awaiting_confirmation": return { label: "Waiting for you to start it", tone: "info" };
    case "preparing": return { label: "Preparing", tone: "accent" };
    case "building": return { label: "Building", tone: "accent" };
    case "integrating": return { label: "Integrating", tone: "accent" };
    case "testing": return { label: "Testing", tone: "accent" };
    case "reviewing": return { label: "In review", tone: "accent" };
    case "gating": return { label: "At the final check", tone: "accent" };
    case "awaiting_approval": return { label: "Waiting for approval (not merged)", tone: "warn" };
    case "applying": return { label: "Applying the approved step", tone: "accent" };
    case "completed": return { label: "Done and verified", tone: "success" };
    case "needs_owner": return { label: "Needs you", tone: "warn" };
    case "blocked_allowance": return { label: "Paused at an account limit", tone: "warn" };
    case "failed": return { label: "Failed", tone: "danger" };
    case "cancelled": return { label: "Stopped", tone: "neutral" };
    case "interrupted": return { label: "Interrupted: not replayed", tone: "warn" };
  }
}

/** The label for a whole job: a job closed as superseded reads "Superseded", never "Stopped" or "Needs you". */
export function jobLabel(job: Pick<CodingJob, "state" | "supersededBy">): { label: string; tone: Tone } {
  return job.supersededBy ? { label: "Superseded", tone: "neutral" } : jobStateLabel(job.state);
}

export function runStateLabel(state: string): { label: string; tone: Tone } {
  switch (state) {
    case "queued": return { label: "Queued", tone: "neutral" };
    case "starting": return { label: "Starting", tone: "accent" };
    case "running": return { label: "Working", tone: "accent" };
    case "needs_input": return { label: "Needs you", tone: "warn" };
    case "succeeded": return { label: "Finished (checked)", tone: "success" };
    case "failed": return { label: "Failed", tone: "danger" };
    case "cancelled": return { label: "Stopped", tone: "neutral" };
    case "interrupted": return { label: "Interrupted: not replayed", tone: "warn" };
    case "termination_unverified": return { label: "Stop not confirmed", tone: "danger" };
    case "blocked_allowance": return { label: "At account limit", tone: "warn" };
    default: return { label: state, tone: "neutral" };
  }
}

export const ACTIVE_STATES: readonly JobState[] = ["preparing", "building", "integrating", "testing", "reviewing", "gating", "applying"];
export const NEEDS_YOU: readonly JobState[] = ["awaiting_confirmation", "needs_owner", "awaiting_approval", "interrupted", "blocked_allowance", "draft"];

export function modelLabel(b: AgentBinding | null | undefined): string {
  if (!b) return "orchestrator (no model)";
  const names: Record<string, string> = {
    "claude-opus-5-5": "Claude Opus 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-sonnet-5": "Claude Sonnet 5 (older id)", "claude-fable-5-1": "Claude Fable 5.1", "claude-haiku-4-5": "Claude Haiku 4.5",
    "gpt-6-astra": "Codex GPT-6 Astra", "gpt-5.6-sol": "Codex GPT-5.6 Sol", "gpt-5.5": "Codex GPT-5.5",
  };
  return names[b.model] ?? b.model;
}

/** "214 passed · 0 failed", or "not run" (an agent's claim is never shown as a result). */
export function testsSummary(job: CodingJob): { text: string; tone: Tone } {
  // The newest run of each check at this head: a check run again after a timeout counts once, as what it now says (round 7).
  const at = [...new Map(job.tests.filter((t) => t.sha === job.headSha).map((t) => [t.commandId, t] as const)).values()];
  if (!at.length) return { text: "Tests not run", tone: "neutral" };
  const passed = at.reduce((n, t) => n + (t.counts.passed ?? 0), 0);
  const failed = at.reduce((n, t) => n + (t.counts.failed ?? 0), 0);
  const timedOut = at.filter((t) => t.timedOut).length;
  const bad = at.some((t) => t.exitCode !== 0);
  return { text: `${passed} passed · ${failed} failed${timedOut ? ` · ${timedOut} timed out` : ""}`, tone: bad ? "danger" : "success" };
}

export function elapsed(fromIso: string, toIso?: string | null): string {
  const ms = Math.max(0, (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso));
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
