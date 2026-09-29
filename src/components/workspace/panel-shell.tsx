import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button, Notice, Skeleton, Surface, fmtRelative } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { PanelResult } from "./api";
import { fmtDateTime } from "@/lib/format";

/** Re-renders every `ms` so "3 min ago" labels and the Sydney clock stay current. Returns 0 until
 *  mounted, so the server render and the first client render match (no hydration mismatch). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function OpenLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to as any} className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
      {children}
      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
    </Link>
  );
}

/** "Updated 3 min ago", or "Stale · last good read 3 h ago" when the server served its last good
 *  read because a fresh one failed (review: /work used to show that as a normal update), or
 *  "Refresh failed · last read …" when the request for a newer read failed (server down or not
 *  answering) and the card still shows the previous one (Track 8). */
export function panelFreshness(result: PanelResult<unknown> | undefined, updated: string | null, now: number, fetching: boolean, loading: boolean, refreshFailed = false): string {
  if (fetching && !loading) return "Refreshing…";
  if (!updated) return loading ? "Loading…" : "Not loaded";
  if (refreshFailed) return `Refresh failed · last read ${fmtRelative(updated, now)}`;
  if (result?.ok && result.stale) return `Stale · last good read ${fmtRelative(updated, now)}${result.refreshing ? " · retrying" : ""}`;
  return `Updated ${fmtRelative(updated, now)}${result?.ok && result.refreshing ? " · refreshing" : ""}`;
}

/**
 * One Workspace card: title, "Updated …", a refresh button (a GET) and a link into the full
 * section, then loading / error / content. A failed source shows its own error; the rest of the
 * page is unaffected.
 */
export function PanelShell<T>({
  id,
  title,
  link,
  query,
  now,
  asOf,
  loadingRows = 3,
  className,
  children,
}: {
  id: string;
  title: string;
  link: { to: string; label: string };
  query: UseQueryResult<PanelResult<T>>;
  now: number;
  /** Optional source time shown instead of the fetch time (e.g. the receptionist's own snapshot). */
  asOf?: (data: T) => string | null;
  loadingRows?: number;
  className?: string;
  children: (data: T) => ReactNode;
}) {
  const result = query.data;
  const updated = result ? (result.ok && asOf ? asOf(result.data) ?? result.updatedAt : result.updatedAt) : null;
  // A refetch that failed keeps the previous result on screen: say so instead of "Updated …".
  const refreshFailed = Boolean(result && query.isError);
  const stale = refreshFailed || Boolean(result?.ok && result.stale);
  return (
    <Surface as="section" id={id} aria-labelledby={`${id}-title`} className={cn("flex min-w-0 flex-col gap-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-base font-semibold leading-snug text-foreground">{title}</h2>
          {/* L1 (29 Sep 2026): no "Updated just now" on every card. A routine update is for screen
              readers and hover only; stale, failed, refreshing and loading stay in view. */}
          {(() => {
            const text = panelFreshness(result, updated, now, query.isFetching, query.isLoading, refreshFailed);
            const routine = !stale && text.startsWith("Updated ") && !text.includes("refreshing");
            return (
              <p
                className={cn(routine ? "sr-only" : "mt-0.5 text-xs", stale ? "text-warn" : "text-muted-foreground")}
                title={updated ? fmtDateTime(new Date(updated), { year: true }) : undefined}
                data-stale={stale ? true : undefined}
                data-freshness={routine ? "routine" : undefined}
              >
                {text}
              </p>
            );
          })()}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label={`Refresh ${title}`}>
            <RefreshCw className={cn(query.isFetching && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
          </Button>
          <OpenLink to={link.to}>{link.label}</OpenLink>
        </div>
      </div>
      {query.isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label={`Loading ${title}`}>
          {Array.from({ length: loadingRows }, (_, i) => <Skeleton key={i} className="h-10 rounded-lg animate-none" />)}
        </div>
      ) : query.error && !result ? (
        <Notice tone="danger" title={`${title} couldn't be read`}>
          {query.error instanceof Error ? query.error.message : "The workspace server didn't answer."} Use refresh to retry.
        </Notice>
      ) : result && !result.ok ? (
        <Notice tone="danger" title={result.timedOut ? `${title} is taking too long` : `${title} is unavailable`}>
          {result.error}. The other panels are unaffected; refresh to retry.
        </Notice>
      ) : result && result.ok ? (
        <>
          {refreshFailed && (
            <Notice tone="warn" title="Couldn't refresh: showing the previous read">
              {query.error instanceof Error ? query.error.message : "The workspace server didn't answer."} These figures are from {fmtDateTime(new Date(result.updatedAt), { year: true })}. Use refresh to retry.
            </Notice>
          )}
          {!refreshFailed && result.stale && (
            <Notice tone="warn" title="Stale: showing the last good read">
              The latest read failed ({result.stale.error}); these figures are from {fmtDateTime(new Date(result.updatedAt), { year: true })}. Refresh to try again.
            </Notice>
          )}
          {children(result.data)}
        </>
      ) : null}
    </Surface>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn("flex min-w-0 items-start justify-between gap-3 rounded-lg bg-inset px-3 py-2.5", className)}>{children}</li>;
}

export function Metric({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "danger" | "warn" | "success" }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="min-w-0 rounded-lg bg-inset px-3 py-2.5">
      <div className="ds-label truncate">{label}</div>
      <div className={cn("ds-num mt-1 text-lg font-semibold leading-tight", empty ? "text-muted-foreground" : tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "success" ? "text-success" : "text-foreground")}>
        {empty ? "—" : value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
