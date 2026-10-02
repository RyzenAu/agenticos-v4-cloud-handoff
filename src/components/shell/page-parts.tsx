// Small pieces every destination page shares: signal tiles, the drilldown list, exception rows.
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { StatusDot, type Tone } from "@/components/ds";
import { useOperator } from "@/lib/operator";
import { cn } from "@/lib/utils";
import { HONEST_LABEL, HONEST_MEANING, sourceLine, tileHonestState, type HonestState } from "@/lib/honest-state";
import { DESTINATION_BY_ID, visibleDrilldowns, type DestinationId } from "./destinations";
import { fmtDateTime, fmtDay } from "@/lib/format";

export type SignalTone = "danger" | "warn" | "success" | undefined;

/**
 * What a tile's number is, so zero, unknown, stale and a failed source never look alike:
 *   ok       live value (tone as given)
 *   zero     a real, read zero (tone as given; callers never pass "success" for a failed read)
 *   unknown  the source can't say (not connected, not measured): shows "Unknown", no tone
 *   stale    last value, older than it should be: shown with a "Stale" marker, success tone dropped
 *   failed   the source failed: shows "Couldn't read", danger text, never a number or success tone
 * and the six honest states (src/lib/honest-state.ts, NEXUS-ADDENDUM item 6), shown as a word on the tile:
 *   live            read from its source (ok and zero are live)
 *   simulated       demo, sample or estimated figures; never a success tone
 *   setup-required  not connected yet: shows "Setup required", never a number
 * With `source` / `lastSuccess` the tile says where the number came from and when that source last answered.
 */
export type SignalState = "ok" | "zero" | "unknown" | "stale" | "failed" | HonestState;

/** A recovery action for a tile that isn't ok: a link, or a button (e.g. retry). */
export type SignalRecovery = { label: string; to?: string; onClick?: () => void };

/** The state of a panel-style result (`{ ok, updatedAt }`) at `now`. */
export function panelSignalState(
  result: { ok: boolean; updatedAt?: string; stale?: unknown } | null | undefined,
  now: number,
  staleAfterMs = 15 * 60_000,
): SignalState | undefined {
  if (!result) return undefined;
  if (!result.ok) return "failed";
  // The server served its last good read because a fresh one failed (UI-truth M9).
  if (result.stale) return "stale";
  const t = result.updatedAt ? Date.parse(result.updatedAt) : NaN;
  return now && Number.isFinite(t) && now - t > staleAfterMs ? "stale" : "ok";
}

const STATE_TEXT: Partial<Record<SignalState, string>> = { unknown: "Unknown", failed: "Couldn't read", "setup-required": "Setup required" };

/**
 * The honest-state word for any metric (NEXUS-ADDENDUM item 6): live / simulated / stale / failed /
 * unknown / setup required. The word carries the meaning (colour only helps); the title explains it.
 */
export function HonestBadge({ state, className }: { state: HonestState; className?: string }) {
  return (
    <span className={cn("hs-state", className)} data-state={state} title={HONEST_MEANING[state]}>
      {HONEST_LABEL[state]}
    </span>
  );
}

/** "Source · last success 3 min ago" under a metric that isn't a SignalTile. */
export function MetricSource({ source, lastSuccess, now, className }: { source?: string; lastSuccess?: string | number | null; now: number; className?: string }) {
  const line = sourceLine(source, lastSuccess, now);
  return line ? (
    <span className={cn("block text-xs leading-snug text-muted-foreground", className)}>
      {line}
    </span>
  ) : null;
}

/**
 * One number with its meaning and where to act. `value === null` is the honest empty form
 * (an em dash and the hint saying why), never a zero that looks like data. `state` separates
 * zero / unknown / stale / failed; `updatedAt` adds the last-update time; `recovery` gives the
 * next step when the tile isn't ok.
 */
export function SignalTile({
  label,
  value,
  hint,
  tone,
  to,
  search,
  loading,
  state,
  updatedAt,
  now,
  staleAfterMs,
  recovery,
  source,
  lastSuccess,
  quiet = false,
}: {
  label: string;
  value: ReactNode | null;
  hint?: ReactNode;
  tone?: SignalTone;
  to?: string;
  search?: Record<string, string>;
  loading?: boolean;
  state?: SignalState;
  updatedAt?: string | number | null;
  now?: number;
  staleAfterMs?: number;
  recovery?: SignalRecovery;
  /** Where the number comes from ("Receptionist feed", "NAB CSV import"). Shown with the last success. */
  source?: string;
  /** When the source last answered (defaults to `updatedAt`). */
  lastSuccess?: string | number | null;
  /**
   * L1 widget grid (29 Sep 2026): no "Live" chip and no "Updated just now" on the tile. Only a state
   * that changes the reading shows (Unknown, Stale, Failed, Simulated, Setup required); routine
   * freshness moves to the page foot. The tile fills its grid cell, recovery included.
   */
  quiet?: boolean;
}) {
  // Setup required keeps a word the source gave ("Not connected") but never a number.
  const stateText =
    state === "setup-required"
      ? typeof value === "number" || value === null || value === undefined || value === "" ? STATE_TEXT[state] : undefined
      : state ? STATE_TEXT[state] : undefined;
  const empty = !stateText && (value === null || value === undefined || value === "");
  const freshAt = lastSuccess !== undefined ? lastSuccess : updatedAt;
  // The badge follows the tile's REAL state (REVIEW-T1 fix 5): no value is never "Live", and data older
  // than its stale limit is "Stale" whatever the fetch said.
  const honest = tileHonestState(state, { empty, at: freshAt, now, staleAfterMs });
  // A failed or unknown read never carries a tone; a stale one never claims success.
  const shownTone = stateText
    ? state === "failed" ? "danger" : undefined
    : empty ? undefined : (honest === "stale" || honest === "simulated" || honest === "unknown") && tone === "success" ? undefined : tone;
  const shown = stateText ?? (empty ? "—" : value);
  const body = (
    <>
      <span className="sh-signal-label">
        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        {honest && !loading && !(quiet && (honest === "live" || stateText)) && (
          <HonestBadge state={honest} className="ml-auto shrink-0" />
        )}
        {to && !quiet && <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
      </span>
      {loading ? (
        // role="status" makes the label permitted (axe aria-prohibited-attr) and announces the load.
        <span role="status" className="h-6 w-16 animate-pulse rounded bg-inset motion-reduce:animate-none" aria-label={`${label} loading`} />
      ) : (
        <span className="sh-signal-value" data-tone={shownTone} data-empty={empty || stateText ? true : undefined} data-state={state}>
          {/* keyed so a changed value replays the one-off highlight */}
          <span key={String(stateText ?? (empty ? "—" : typeof value === "string" || typeof value === "number" ? value : ""))} className={empty || stateText ? undefined : "sh-tick"}>
            {shown}
          </span>
        </span>
      )}
      {hint && <span className="sh-signal-hint">{hint}</span>}
      {source && !loading && (
        <span className="sh-signal-hint sh-signal-source">Source: {source}</span>
      )}
      {state === "failed" && !loading ? (
        // A failed read shows when the source last answered, never the failure time as "Updated just now".
        lastSuccess ? (
          <span className="sh-signal-hint">
            {sourceLine(undefined, lastSuccess, now ?? Date.now())}
          </span>
        ) : (
          <span className="sh-signal-hint">No successful read yet</span>
        )
      ) : (
        freshAt !== undefined && now !== undefined && !loading && !(quiet && honest !== "stale") && (
          <Freshness at={freshAt} now={now} staleAfterMs={staleAfterMs} className="sh-signal-hint" />
        )
      )}
    </>
  );
  const needsRecovery = !!recovery && !(state === "ok" || state === "zero" || state === "live" || state === "simulated" || state === undefined || loading);
  if (quiet) {
    // Widget-grid form (L1): one card, the facts on top and ONE action at the foot, inside the card,
    // bottom-aligned like the Inbox source cards: the recovery when the read isn't ok, else Open.
    const pill = "ds-interactive inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-raised";
    const action =
      needsRecovery && recovery ? (
        recovery.to ? (
          <Link to={recovery.to as never} className={pill}>
            {recovery.label}
          </Link>
        ) : (
          <button type="button" onClick={recovery.onClick} className={pill}>
            {recovery.label}
          </button>
        )
      ) : to ? (
      <Link to={to as never} search={search as never} className={pill} aria-label={`Open ${label}`}>
        Open <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    ) : null;
    return (
      <div className="sh-signal h-full" data-signal-quiet="">
        {body}
        {action && <div className="mt-auto flex flex-wrap gap-2 pt-3">{action}</div>}
      </div>
    );
  }
  const tileClass = "sh-signal";
  const tile = to ? (
    <Link to={to as never} search={search as never} className={tileClass}>
      {body}
    </Link>
  ) : (
    <div className={tileClass}>{body}</div>
  );
  if (!recovery || state === "ok" || state === "zero" || state === "live" || state === "simulated" || state === undefined || loading) return tile;
  // The recovery sits beside the tile (a link can't hold a button).
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {tile}
      {recovery.to ? (
        <Link to={recovery.to as never} className="px-1 text-xs font-medium text-foreground underline underline-offset-2">
          {recovery.label}
        </Link>
      ) : (
        <button type="button" onClick={recovery.onClick} className="self-start px-1 text-xs font-medium text-foreground underline underline-offset-2">
          {recovery.label}
        </button>
      )}
    </div>
  );
}

export type Exception = { id: string; tone: Tone; text: ReactNode; to?: string; action?: string };

export function ExceptionList({ items }: { items: Exception[] }) {
  return (
    <ul className="sh-list">
      {items.map((e) => {
        const inner = (
          <>
            <span className="mt-1.5 shrink-0">
              <StatusDot
                tone={e.tone}
                label={
                  <span className="sr-only">
                    {e.tone === "danger" ? "Urgent" : e.tone === "warn" ? "Needs attention" : "Note"}
                  </span>
                }
              />
            </span>
            <span className="min-w-0 flex-1 text-sm leading-snug text-foreground">{e.text}</span>
            {e.to && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-muted-foreground">
                {e.action ?? "Open"}
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
              </span>
            )}
          </>
        );
        return (
          <li key={e.id}>
            {e.to ? (
              e.to.startsWith("/") ? (
                <Link to={e.to as never} className="sh-row-link">
                  {inner}
                </Link>
              ) : (
                <a href={e.to} target="_blank" rel="noreferrer" className="sh-row-link">
                  {inner}
                </a>
              )
            ) : (
              <div className="sh-row-link">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Also in <destination>": its drilldowns as one-line rows with their purpose. */
export function DrilldownList({ id, title }: { id: DestinationId; title?: string }) {
  const destination = DESTINATION_BY_ID[id];
  const { state } = useOperator();
  const items = visibleDrilldowns(destination, state.settings);
  if (!items.length) return null;
  return (
    <nav
      aria-label={title ?? `${destination.label} tools`}
      className="mt-8 border-t border-border pt-4"
    >
      <ul className="flex flex-wrap gap-x-5 gap-y-1">
        {items.map((d) => (
          <li key={`${d.to}${d.view ?? ""}`}>
            <Link
              to={d.to as never}
              search={(d.view ? { view: d.view } : d.to === "/business" ? {} : undefined) as never}
              title={d.purpose}
              className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="shrink-0 text-muted-foreground">
                <d.icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span>{d.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** "Updated 3 min ago" with the exact time on hover; "Stale" once older than `staleAfterMs`. */
export function Freshness({ at, now, staleAfterMs = 15 * 60_000, className }: { at: string | number | null | undefined; now: number; staleAfterMs?: number; className?: string }) {
  if (!at || !now) return <span className={cn("text-xs text-muted-foreground", className)}>Not loaded yet</span>;
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return <span className={cn("text-xs text-muted-foreground", className)}>Time unknown</span>;
  const age = now - t;
  const label = age < 60_000 ? "just now" : age < 3_600_000 ? `${Math.floor(age / 60_000)} min ago` : age < 86_400_000 ? `${Math.floor(age / 3_600_000)} h ago` : fmtDay(new Date(t), { year: true });
  return (
    <span className={cn("text-xs", age > staleAfterMs ? "text-warn" : "text-muted-foreground", className)} title={fmtDateTime(new Date(t), { year: true })}>
      {age > staleAfterMs ? "Stale · updated " : "Updated "}
      {label}
    </span>
  );
}
