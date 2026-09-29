// scripts/model-router/allowance.ts — subscription allowance for route() (the >= 95% skip) and receipts.
//
// No extra provider call is made here. The /usage service (scripts/ai-usage/plugin.ts) already reads the
// Claude OAuth usage and each Codex account's wham/usage on a 15-minute cache; every snapshot it builds is
// published here, and route() reads the latest one when a caller doesn't pass its own `allowance`.
//
// Per provider:
//   - claude-sub: the Max plan's most-used window (session or weekly).
//   - codex / hermes: the pool is rotated by Hermes, so the pool is limited only when EVERY readable account
//     is; the allowance is the least-used account's most-used window. Choosing an account per call (slot
//     affinity) is E2/C2 work, when Codex callers move onto the router.
// A reading older than 30 minutes, or none at all, is unknown (null): unknown never blocks a call.
import type { AiUsageSnapshot, SubscriptionCard } from "../ai-usage/types";

export type Allowance = {
  plan: string;
  window: string;
  usedPct: number | null;
  resetsAt?: string | null;
};

export const ALLOWANCE_MAX_AGE_MS = 30 * 60_000;

type Latest = { at: number; snapshot: Pick<AiUsageSnapshot, "subscriptions"> };
const key = Symbol.for("mu.model-router.allowance.v1");
const registry = globalThis as typeof globalThis & { [key]?: Latest | null };

/** Called by the /usage service each time it builds a snapshot (survives Vite config reloads). */
export function publishUsageSnapshot(
  snapshot: Pick<AiUsageSnapshot, "subscriptions" | "generatedAt">,
) {
  registry[key] = { at: Date.parse(snapshot.generatedAt) || Date.now(), snapshot };
}

/** Test-only. */
export function clearPublishedUsage() {
  registry[key] = null;
}

function peak(
  card: SubscriptionCard,
): { label: string; used: number; resetsAt: string | null } | null {
  if (!card.status.ok || !card.status.windows.length) return null;
  const top = [...card.status.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return { label: top.label, used: top.usedPercent, resetsAt: top.resetsAt };
}

/** Allowance for a catalogue provider from one /usage snapshot; null when unreadable. */
export function allowanceFromSnapshot(
  snapshot: Pick<AiUsageSnapshot, "subscriptions">,
  provider: string,
): Allowance | null {
  if (provider === "claude-sub") {
    const cards = snapshot.subscriptions.filter((s) => s.provider === "anthropic");
    const readings = cards.map((c) => ({ c, p: peak(c) })).filter((x) => x.p);
    if (!readings.length) return null;
    const worst = readings.sort((a, b) => b.p!.used - a.p!.used)[0];
    return {
      plan: `Claude ${worst.c.plan}`,
      window: worst.p!.label,
      usedPct: worst.p!.used,
      resetsAt: worst.p!.resetsAt,
    };
  }
  if (provider === "codex" || provider === "hermes") {
    const cards = snapshot.subscriptions.filter((s) => s.provider === "openai");
    const readings = cards.map((c) => ({ c, p: peak(c) })).filter((x) => x.p);
    if (!readings.length) return null;
    const best = readings.sort((a, b) => a.p!.used - b.p!.used)[0];
    return {
      plan: `ChatGPT pool (${readings.length} of ${cards.length} accounts readable; least-used ${best.c.id.replace(/^codex:/, "")})`,
      window: best.p!.label,
      usedPct: best.p!.used,
      resetsAt: best.p!.resetsAt,
    };
  }
  return null;
}

/** The latest published /usage snapshot's subscription cards, or null when none is fresh (Track 3: the
 * coding harness reads each Codex account's windows to pick an account for a NEW job). */
export function latestSubscriptionCards(now = Date.now()): SubscriptionCard[] | null {
  const latest = registry[key];
  if (!latest || now - latest.at > ALLOWANCE_MAX_AGE_MS) return null;
  return [...latest.snapshot.subscriptions];
}

/** The latest published reading for a provider, or null when none is fresh. */
export function currentAllowance(provider: string, now = Date.now()): Allowance | null {
  const latest = registry[key];
  if (!latest || now - latest.at > ALLOWANCE_MAX_AGE_MS) return null;
  return allowanceFromSnapshot(latest.snapshot, provider);
}
