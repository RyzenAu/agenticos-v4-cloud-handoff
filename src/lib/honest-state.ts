// Honest data states (NEXUS-ADDENDUM item 6): every prominent metric says which of six things it is,
// where it came from and when that source last answered. Unknown never renders as 0 or "all clear".
// Pure; SignalTile (src/components/shell/page-parts.tsx) and the command palette use it.
import type { SourceState } from "./commands/types";
import { fmtDay } from "./format";

export type HonestState = SourceState;
export const HONEST_STATES: readonly HonestState[] = ["live", "simulated", "stale", "failed", "unknown", "setup-required"];

export const HONEST_LABEL: Record<HonestState, string> = {
  live: "Live",
  simulated: "Simulated",
  stale: "Stale",
  failed: "Couldn't read",
  unknown: "Unknown",
  "setup-required": "Setup required",
};

/** What each state means, for a tooltip or screen reader. */
export const HONEST_MEANING: Record<HonestState, string> = {
  live: "Read from its source just now.",
  simulated: "Sample, demo or estimated figures, not measured.",
  stale: "The last good value; the source hasn't answered since.",
  failed: "The source failed; no value is shown.",
  unknown: "The source can't say (not measured or not loaded).",
  "setup-required": "Not connected yet.",
};

/** A state that must never show a number or a success tone. */
export const hidesValue = (s: HonestState | undefined) => s === "failed" || s === "unknown" || s === "setup-required";

/** The legacy tile states (ok/zero/unknown/stale/failed) mapped onto the six. */
export function honestFromSignal(state: string | undefined): HonestState | undefined {
  if (state === undefined) return undefined;
  if (state === "ok" || state === "zero") return "live";
  return (HONEST_STATES as readonly string[]).includes(state) ? (state as HonestState) : "unknown";
}

/**
 * The state of a panel-style result (`{ ok, updatedAt, stale? }`) at `now`. `simulated` and
 * `setupRequired` come from the caller, who knows whether the data is demo data or unconnected.
 */
export function honestFromPanel(
  result: { ok: boolean; updatedAt?: string; stale?: unknown } | null | undefined,
  now: number,
  opts: { staleAfterMs?: number; simulated?: boolean; setupRequired?: boolean } = {},
): HonestState {
  if (opts.setupRequired) return "setup-required";
  if (!result) return "unknown";
  if (!result.ok) return "failed";
  if (result.stale) return "stale";
  const t = result.updatedAt ? Date.parse(result.updatedAt) : NaN;
  if (now && Number.isFinite(t) && now - t > (opts.staleAfterMs ?? 15 * 60_000)) return "stale";
  return opts.simulated ? "simulated" : "live";
}

/** "Receptionist feed · last success 3 min ago" (or "never"). */
export function sourceLine(source: string | undefined, lastSuccess: string | number | null | undefined, now: number): string {
  const parts: string[] = [];
  if (source) parts.push(source);
  if (lastSuccess !== undefined) {
    const t = typeof lastSuccess === "number" ? lastSuccess : lastSuccess ? Date.parse(lastSuccess) : NaN;
    if (!Number.isFinite(t)) parts.push("last success: never");
    else {
      const age = Math.max(0, now - t);
      parts.push(
        `last success ${age < 60_000 ? "just now" : age < 3_600_000 ? `${Math.floor(age / 60_000)} min ago` : age < 86_400_000 ? `${Math.floor(age / 3_600_000)} h ago` : fmtDay(new Date(t), { year: true })}`,
      );
    }
  }
  return parts.join(" · ");
}

/**
 * The state of a React Query read: an error with nothing to show is failed; an error over earlier data is
 * stale (the last good value); data older than `staleAfterMs` is stale; no data yet is unknown.
 */
export function honestFromQuery(
  q: { data?: unknown; error?: unknown; isError?: boolean; dataUpdatedAt?: number },
  now: number,
  opts: { staleAfterMs?: number; simulated?: boolean } = {},
): HonestState {
  const hasData = q.data !== undefined && q.data !== null;
  const errored = !!q.error || !!q.isError;
  if (!hasData) return errored ? "failed" : "unknown";
  if (errored) return "stale";
  // The data's own time when the payload has one (REVIEW-T1 fix 5), else when it was fetched.
  const at = payloadTime(q.data) ?? q.dataUpdatedAt;
  if (at && now && now - at > (opts.staleAfterMs ?? 15 * 60_000)) return "stale";
  return opts.simulated ? "simulated" : "live";
}

/**
 * A tile's badge from its state AND what it actually shows (REVIEW-T1 fix 5): a read with no value is
 * "unknown", never "live"; a read whose data is older than `staleAfterMs` is "stale", whatever the fetch
 * said. Failed, unknown, stale, simulated and setup-required stay what they are. Pure.
 */
export function tileHonestState(
  state: string | undefined,
  shown: { empty: boolean; at?: string | number | null; now?: number; staleAfterMs?: number },
): HonestState | undefined {
  const base = honestFromSignal(state);
  if (base !== "live") return base;
  if (shown.empty) return "unknown";
  const t = typeof shown.at === "number" ? shown.at : shown.at ? Date.parse(shown.at) : NaN;
  if (shown.now && Number.isFinite(t) && shown.now - t > (shown.staleAfterMs ?? 15 * 60_000)) return "stale";
  return "live";
}

/**
 * When the DATA was made, from the payload itself (generatedAt, updatedAt, checkedAt, asOf, or a
 * catalogue's updatedAt), in ms; null when the payload doesn't say. The fetch time is not the data's age.
 */
export function payloadTime(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  for (const v of [d.generatedAt, d.updatedAt, d.checkedAt, d.asOf, (d.catalogue as Record<string, unknown> | undefined)?.updatedAt]) {
    const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}
