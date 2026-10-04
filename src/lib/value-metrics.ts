// The one place "value" figures are calculated. Two different things were being shown under
// similar names, from different bases and periods, so pages disagreed ($904 · $2,656 · $11,830 ·
// $50,699):
//
//   1. API-equivalent value — what the AI work would have cost at API token prices. Comes from
//      scripts/aggregate.ts (`summary.value`), over actual rolling windows. It is not money saved.
//   2. Time saved — skill runs × minutes per run × the owner's hourly rate. The rate is the
//      profile's (Settings → Profile); when unset, $120/h is assumed and the label says so.
//
// Every surface should call these helpers and print the returned label next to the number.
import { useWorkspaceProfile, type HourlyRate } from "./workspace-profile";
import { fmtMoney } from "./format";

export type ValueWindow = 7 | 28 | 30;

type LiveValue = {
  summary?: {
    valueExtracted7d?: number;
    value?: { last7d?: number; last28d?: number; last30d?: number; currency?: string };
  };
};

/** API-equivalent value for a real window (never a 7-day figure scaled up). null = not known. */
export function apiEquivalentValue(ld: LiveValue | null | undefined, days: ValueWindow): number | null {
  const value = ld?.summary?.value;
  const figure =
    days === 7
      ? (value?.last7d ?? ld?.summary?.valueExtracted7d)
      : days === 28
        ? value?.last28d
        : value?.last30d;
  return typeof figure === "number" && Number.isFinite(figure) ? figure : null;
}

export function apiValueLabel(days: ValueWindow) {
  return `API-equivalent value · last ${days} days`;
}
export const API_VALUE_NOTE =
  "What this AI work would have cost at API token prices. It is not money saved or earned.";

/** Return on subscriptions: 30-day API-equivalent value ÷ monthly subscription cost. */
export function subscriptionMultiple(ld: LiveValue | null | undefined, monthlySubscriptions: number) {
  const value = apiEquivalentValue(ld, 30);
  if (value === null || !(monthlySubscriptions > 0)) return null;
  return value / monthlySubscriptions;
}

/** Time saved in minutes, priced at the one hourly rate. */
export function timeSavedValue(minutes: number, rate: HourlyRate) {
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  return { minutes: safe, amount: (safe / 60) * rate.rate, currency: rate.currency, label: rate.label, assumed: rate.assumed };
}

/** Skill runs in a window, from the 7-day counter the aggregator emits. */
export function runsInWindow(uses7d: number, days: ValueWindow) {
  return (Math.max(0, uses7d) / 7) * days;
}

/** The rate every time-saved figure must use: the profile's, or an assumption that says so. */
export function useValueRate(): HourlyRate & { loading: boolean } {
  const profile = useWorkspaceProfile();
  return { ...profile.rate, loading: profile.isLoading };
}

export function formatValue(amount: number, currency = "USD") {
  return fmtMoney(amount, { currency, whole: true });
}
