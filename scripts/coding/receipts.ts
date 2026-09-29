import { catalogue } from "../model-router/catalogue";
import type { ReceiptSink, RouterReceipt } from "../model-router/receipts";
import type { AgentBinding, AllowanceSnapshot, IsoTime, PersonId, RoleId, RoleKind, UsageReceipt, Uuid } from "./contracts";
import type { RunnerOutcome } from "./runners/types";

/**
 * One UsageReceipt per role turn (CODING-HARNESS §3.11, owner decisions 1 and 2):
 *  - `account` and `model` are what ACTUALLY ran: the slot the runner started on, and the model the
 *    provider reported (Claude modelUsage / Codex thread model or reroute / the router's choice). When the
 *    provider never said, `providerModel` is null and `model` stays the binding's with that gap visible.
 *  - subscription roles: cost basis `subscription_allowance`, usd null; Claude's total_cost_usd is a VALUE.
 *  - Codex credits before/after (scope "job" when both reads bracket this turn; null when unknown).
 *  - No prompt, output, path or email is stored (Stage E forbidden list).
 * Native roles also get a router receipt in the fleet ledger (task `coding`), so System > Models counts
 * them; routed roles already wrote theirs inside runRouted (never twice).
 */

const TASK: Record<RoleKind, UsageReceipt["task"]> = {
  planner: "coding.plan", builder: "coding.build", "test-author": "coding.test-author", tester: "coding.build", reviewer: "coding.review",
};

function outcomeOf(o: RunnerOutcome): UsageReceipt["outcome"] {
  switch (o.status) {
    case "succeeded": return "succeeded";
    case "cancelled": return "cancelled";
    case "interrupted": return "cancelled";
    case "termination_unverified": return "termination_unverified";
    case "blocked_allowance": return "rate_limited";
    default:
      if (o.error?.code === "timeout") return "timed_out";
      if (o.error?.code === "policy_violation") return "refused_policy";
      return "failed";
  }
}
function errorCodeOf(o: RunnerOutcome): UsageReceipt["errorCode"] {
  switch (o.error?.code) {
    case undefined: return null;
    case "limit_reached": return "quota";
    case "signed_out": return "auth";
    case "policy_violation": case "ownership_violation": return "policy";
    case "spawn_failed": case "not_installed": return "transport";
    case "protocol_error": case "output_limit": return "protocol";
    default: return null;
  }
}
const plan = (binding: AgentBinding, reported: string | null): string => {
  if (binding.route === "claude-code-cli") return "claude-max-20x";
  if (binding.route === "codex-app-server") return reported === "pro" ? "chatgpt-pro" : reported === "plus" ? "chatgpt-plus" : `chatgpt-${reported ?? "unknown"}`;
  return "router";
};
const peak = (s: AllowanceSnapshot | null) => {
  if (!s) return null;
  const v = s.windows.map((w) => w.usedPercent).filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};

export type ReceiptInput = {
  requestId: Uuid;
  parentRequestId: Uuid | null;
  jobId: Uuid;
  roleId: RoleId;
  role: RoleKind;
  turn: number;
  person: PersonId;
  binding: AgentBinding;
  dataClass: "synthetic" | "business-internal";
  outcome: RunnerOutcome;
  /** The allowance read before the turn (cached for Claude, live for Codex). */
  allowanceStart: AllowanceSnapshot | null;
  queueMs: number | null;
};

export function buildReceipt(input: ReceiptInput): UsageReceipt {
  const o = input.outcome;
  const b = input.binding;
  const routed = b.route === "model-router";
  const provider = routed ? o.routedProvider ?? "unknown" : b.provider;
  const account = routed ? (`router:${o.routedProvider ?? "unknown"}` as const) : b.accountSlot;
  const model = routed ? o.providerModel ?? b.model : o.providerModel ?? b.model;
  const start = input.allowanceStart;
  const end = o.allowanceEnd;
  const creditsKnown = b.route === "codex-app-server" && (start?.creditsBalance !== undefined || end?.creditsBalance !== undefined);
  const cost: UsageReceipt["cost"] = routed
    ? { basis: (o.routedCost?.basis as UsageReceipt["cost"]["basis"]) ?? "unknown", usd: o.routedCost?.usd ?? null, capId: null, priceAsOf: o.routedCost?.priceAsOf ?? null }
    : { basis: "subscription_allowance", usd: null, capId: null, priceAsOf: null };
  return {
    requestId: input.requestId,
    parentRequestId: input.parentRequestId,
    attempt: input.turn,
    fallbackFrom: routed ? o.fallbackFrom ?? null : null,
    startedAt: new Date(o.startedAt).toISOString() as IsoTime,
    endedAt: new Date(o.endedAt).toISOString() as IsoTime,
    task: TASK[input.role],
    caller: "scripts/coding/orchestrator",
    person: input.person,
    route: b.route,
    provider,
    account,
    model,
    providerModel: routed ? o.routedProviderModel ?? null : o.providerModel,
    // A routed role's class is the route that RAN (free Cline, a subscription via Hermes, metered OpenRouter).
    costClass: routed ? o.routedCost?.route ?? (cost.basis === "subscription_allowance" ? "subscription" : cost.basis === "free" ? "free" : "metered") : "subscription",
    dataClass: input.dataClass,
    outcome: outcomeOf(o),
    errorCode: errorCodeOf(o),
    latencyMs: { queue: input.queueMs, provider: o.endedAt - o.startedAt, total: o.endedAt - o.startedAt + (input.queueMs ?? 0) },
    usage: { ...o.usage, audioSeconds: null, characters: null, images: null },
    cost,
    valueUsdEquivalent: b.route === "claude-code-cli" ? o.valueUsdEquivalent : null,
    allowance: routed
      ? null
      : {
          plan: plan(b, o.accountPlan),
          accountSlot: b.accountSlot,
          window: (start ?? end)?.windows.map((w) => w.label).join(" / ") || "unknown",
          usedPercentAtLastRead: peak(start),
          readAt: start?.readAt ?? null,
          usedPercentAtEnd: peak(end),
        },
    credits: creditsKnown
      ? { before: start?.creditsBalance ?? null, after: end?.creditsBalance ?? null, scope: start?.creditsBalance != null && end?.creditsBalance != null ? "job" : "window", readAt: end?.readAt ?? start?.readAt ?? null }
      : null,
    contextTrimmed: false,
    coding: { jobId: input.jobId, roleId: input.roleId, turn: input.turn, cliVersion: b.cliVersion },
  };
}

/** Catalogue id for a native model (claude-opus-5-5 → claude/opus-5-5; gpt-6-astra → codex/gpt-6-astra). */
export function catalogueIdFor(provider: "claude-sub" | "codex", providerModel: string): string | null {
  const m = catalogue().models.find((x) => x.provider === provider && x.providerModel === providerModel);
  return m?.id ?? null;
}

/** The fleet-ledger row for a native role turn (routed roles already have theirs). */
export function routerReceiptFor(r: UsageReceipt, selectedBy: RouterReceipt["selectedBy"]): RouterReceipt | null {
  if (r.route === "model-router") return null;
  const provider = r.route === "claude-code-cli" ? "claude-sub" : "codex";
  const model = catalogueIdFor(provider, r.model) ?? `${provider === "claude-sub" ? "claude" : "codex"}/${r.model}`.slice(0, 80);
  const outcome: RouterReceipt["outcome"] = r.outcome === "rate_limited" ? "rate_limited" : r.outcome === "refused_policy" ? "refused_policy" : r.outcome === "timed_out" ? "timed_out" : r.outcome === "termination_unverified" ? "termination_unverified" : r.outcome === "cancelled" ? "cancelled" : r.outcome === "succeeded" ? "succeeded" : "failed";
  return {
    schema: "mu.router-receipt/v1",
    requestId: r.requestId,
    attempt: r.attempt,
    parentRequestId: r.parentRequestId,
    task: "coding",
    caller: `scripts/coding/orchestrator (${r.task} ${r.account})`,
    provider,
    model,
    providerModel: r.providerModel,
    route: "subscription",
    selectedBy,
    reason: `${r.task} on ${r.account}`,
    fallbackFrom: null,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    characters: null,
    audioSeconds: null,
    costUsd: null,
    costBasis: "subscription_allowance",
    priceAsOf: null,
    allowance: r.allowance ? { plan: r.allowance.plan, window: r.allowance.window, usedPct: r.allowance.usedPercentAtLastRead } : null,
    latencyMs: r.latencyMs.total,
    outcome,
    errorCode: r.errorCode === "quota" ? "quota_exhausted" : r.errorCode === "auth" ? "auth" : r.errorCode === "policy" ? "policy" : r.errorCode === "transport" ? "transport" : null,
    httpStatus: null,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    sent: true,
  };
}

/** Write the fleet-ledger row; a ledger failure never fails the job (the coding store keeps its copy). */
export async function writeFleetReceipt(sink: ReceiptSink | null, receipt: UsageReceipt, selectedBy: RouterReceipt["selectedBy"]) {
  const row = routerReceiptFor(receipt, selectedBy);
  if (!row || !sink) return false;
  try { await sink.write(row); return true; } catch { return false; }
}
