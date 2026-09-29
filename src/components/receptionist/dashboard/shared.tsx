import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Disclosure, fmtCount, fmtRelative, InfoTip, Notice } from "@/components/ds";
import { SignalTile, type SignalRecovery, type SignalTone } from "@/components/shell/page-parts";
import { ageText, blockIsStale, tileRecovery, tileState, type BlockMeta, type DashBlock, type TileRecovery } from "@/lib/receptionist-dashboard";
import type { UnknownCause } from "../../../../scripts/receptionist/dashboard";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/format";

/** cents (a whole number of AU cents) → "A$1,234.00"; null → "—" (never a fabricated zero). */
export function aud(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "—";
  return `A$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The dashboard's refresh action, shared so every tile's "retry" runs the same forced re-read. */
const RetryContext = createContext<(() => void) | null>(null);
export const DashboardRetryProvider = RetryContext.Provider;
export function useDashboardRetry() {
  return useContext(RetryContext);
}

/** The viewer's clock, ticking so "updated 3 min ago" and stale markers stay true while open. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The Clients section's anchor: where package assignment is explained (RX-9). */
export const CLIENTS_SECTION_ID = "rx-clients";

/**
 * "system" recoveries link to the System destination; "retry" ones run the dashboard refresh;
 * "assign" ones (unknown because a client has no package, RX-9) go to the Clients section, since a
 * retry can't fix them.
 */
export function toSignalRecovery(recovery: TileRecovery | null, retry: (() => void) | null): SignalRecovery | undefined {
  if (!recovery) return undefined;
  if (recovery.kind === "system") return { label: recovery.label, to: "/system" };
  if (recovery.kind === "assign")
    return { label: recovery.label, onClick: () => document.getElementById(CLIENTS_SECTION_ID)?.scrollIntoView({ behavior: "smooth", block: "start" }) };
  return retry ? { label: recovery.label, onClick: retry } : undefined;
}

/** A failed read's time line: the last SUCCESSFUL read, never the failed read's own time (RX-7). */
export function lastGoodText(asOf: string | null, now: number): string {
  const age = ageText(asOf, now);
  return age ? `Last good read ${age}` : "No successful read yet";
}

type AnyBlock = DashBlock<object>;

/**
 * One number from one block, with the zero / unknown / stale / failed discipline applied:
 * a failed read shows "Couldn't read" + the reason, a missing value shows "Unknown", an old read
 * is marked stale (and never success-coloured), and every tile shows its last-update time and,
 * when it isn't ok, the next step.
 */
export function DashTile({
  label,
  block,
  value,
  display,
  hint,
  unknownHint,
  unknownCause,
  lowerBound,
  unknownNeedsSetup = false,
  tone,
}: {
  label: string;
  block: AnyBlock;
  /** The raw value that decides the state (null/undefined = not reported). */
  value: number | string | boolean | null | undefined;
  /** How to show it, when not the raw value (e.g. "A$699.00"). */
  display?: ReactNode;
  hint?: ReactNode;
  /** Why the value is unknown, e.g. "No package assigned". */
  unknownHint?: ReactNode;
  /** What makes it unknown, when known: picks the recovery ("assign a package", not "retry"; RX-9). */
  unknownCause?: UnknownCause;
  /** The value counts only the clients that reported it: shown "at least N" (RX-3). */
  lowerBound?: boolean;
  /**
   * F2 RX-9: the unknown comes from setup or a client that didn't report it, so a retry can't fix it:
   * no retry offered. An explicit `unknownCause` (e.g. "unassigned-package") still picks its recovery.
   */
  unknownNeedsSetup?: boolean;
  tone?: SignalTone;
}) {
  const now = useNow();
  const retry = useDashboardRetry();
  const state = tileState(block, value, now);
  const cause: UnknownCause = unknownCause ?? (unknownNeedsSetup ? "not-available" : "not-reported");
  const recovery = toSignalRecovery(tileRecovery(block, state, cause), retry);
  // A failed read says why and when it last worked, never "Updated just now" (RX-7).
  const shownHint = !block.ok
    ? `${block.reason} · ${lastGoodText(block.asOf, now)}`
    : state === "unknown"
      ? (unknownHint ?? "Not reported by the source")
      : lowerBound
        ? <>At least: not known for every client{hint ? <> · {hint}</> : null}</>
        : hint;
  const raw = value === null || value === undefined ? null : (display ?? (typeof value === "boolean" ? (value ? "Yes" : "No") : typeof value === "number" ? fmtCount(value) : value));
  const shownValue = raw !== null && lowerBound && block.ok ? <>≥ {raw}</> : raw;
  return (
    <SignalTile
      label={label}
      value={shownValue}
      tone={tone}
      state={state}
      hint={shownHint}
      updatedAt={block.ok ? block.asOf : undefined}
      now={now}
      staleAfterMs={block.staleAfterMs}
      recovery={recovery}
      source={block.source}
    />
  );
}

/**
 * Where a number came from and how fresh it is. D1: a fresh read is a quiet (i) (source and time
 * inside); a failed, stale or never-read block keeps its state visible in short words.
 */
export function SourceLine({ block }: { block: BlockMeta & { ok?: boolean } }) {
  const now = useNow();
  const stale = blockIsStale(block, now);
  const detail = (
    <>
      Source: {block.source}
      {" · "}
      {block.ok === false
        ? lastGoodText(block.asOf, now)
        : block.asOf ? <span title={fmtDateTime(new Date(block.asOf), { year: true })}>{stale ? "Stale — " : ""}Updated {fmtRelative(block.asOf)}</span> : "No successful read yet"}
    </>
  );
  const visible = block.ok === false ? lastGoodText(block.asOf, now) : !block.asOf ? "No successful read yet" : stale ? `Stale — updated ${fmtRelative(block.asOf)}` : null;
  return (
    <div className="mt-2 flex items-center justify-end gap-1 text-xs text-muted-foreground">
      {visible && <span className="text-warn">{visible}</span>}
      <InfoTip label="Source and freshness">{detail}</InfoTip>
    </div>
  );
}

/** The recovery for a whole block, as a Notice action (button for retry, link for System). */
function RecoveryAction({ recovery }: { recovery: SignalRecovery | undefined }) {
  if (!recovery) return null;
  if (recovery.to) return <Link to={recovery.to as never} className="text-xs font-medium text-foreground underline underline-offset-2">{recovery.label}</Link>;
  return <Button variant="outline" size="sm" onClick={recovery.onClick}>{recovery.label}</Button>;
}

/**
 * Wraps a block in its ok/error state so every panel handles `{ok:false}` the same honest way:
 * a Notice with the reason and the next step, never a silently-empty table standing in for an error.
 */
export function BlockState<T extends object>({ block, render }: { block: DashBlock<T>; render: (data: T) => ReactNode }) {
  const retry = useDashboardRetry();
  if (!block.ok) return (
    <div>
      <Notice tone="warn" title="Couldn't read" action={<RecoveryAction recovery={toSignalRecovery(tileRecovery(block, "failed"), retry)} />}>{block.reason}</Notice>
      <SourceLine block={block} />
    </div>
  );
  const { ok: _ok, asOf: _asOf, source: _source, stale: _stale, staleAfterMs: _staleAfterMs, ...data } = block;
  return <>{render(data as unknown as T)}<SourceLine block={block} /></>;
}

const SEVERITY_LABEL: Record<"critical" | "warn", string> = { critical: "Critical", warn: "Warn" };
// D1: calm by design. Severity is a small dot plus its word; red is kept for the verdict and truly
// urgent calls at the top of the page, so a critical exception here is amber, a warning neutral.
const SEVERITY_DOT: Record<"critical" | "warn", string> = { critical: "bg-warn", warn: "bg-muted-foreground" };

/** One exception row: short title always visible, detail behind a disclosure. */
export function ExceptionRow({ item }: { item: { id: string; severity: "critical" | "warn"; title: string; detail: string } }) {
  return (
    <li className="py-0.5" data-severity={item.severity}>
      <Disclosure
        icon={<span className={cn("block size-2 rounded-full", SEVERITY_DOT[item.severity])} />}
        summary={item.title}
        meta={SEVERITY_LABEL[item.severity]}
      >
        <p className="break-words pl-5 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
      </Disclosure>
    </li>
  );
}

/**
 * Exceptions can only be "none" when every source was read (the feed AND the sell status): an unread
 * source says so, never "No open exceptions".
 */
export function ExceptionsList({ items, summary, complete = summary.ok, missing = [] }: { items: { id: string; severity: "critical" | "warn"; title: string; detail: string }[]; summary: DashBlock<{ count: number; critical: number }>; complete?: boolean; missing?: string[] }) {
  return (
    <BlockState block={summary} render={() => (
      <>
        {!complete && missing.length > 0 && <p className="mb-2 text-xs text-warn">Partial: {missing.join(" and ")} couldn't be read, so there may be more.</p>}
        {!items.length
          ? <p className="text-sm text-muted-foreground">{complete ? "No open exceptions in the last reads (agency feed and sell status)." : "Nothing known yet."}</p>
          : <ul className="divide-y divide-border rounded-2xl border border-border bg-card p-2 shadow-sm">{items.map((item) => <ExceptionRow key={item.id} item={item} />)}</ul>}
      </>
    )} />
  );
}

export const CHECKLIST_STATUS_TONE: Record<string, "success" | "warn" | "danger" | "neutral"> = {
  verified: "success",
  "in-progress": "warn",
  "not-started": "neutral",
  unknown: "neutral",
};
export const CHECKLIST_STATUS_LABEL: Record<string, string> = {
  verified: "Verified",
  "in-progress": "In progress",
  "not-started": "Not started",
  unknown: "Unknown",
};
