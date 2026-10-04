import { useId, useState, type ReactNode } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * R11 shared system: the one row above a list or table. Search on the left, the everyday filter (a Segmented or Tabs) beside it,
 * an "Advanced filters" group folded behind one button (with a count of what's active), and page-level actions on the right.
 * Wraps to two lines on a phone; never scrolls the page sideways.
 *
 *   <Toolbar
 *     search={{ value: q, onChange: setQ, placeholder: "Search jobs" }}
 *     filters={<Segmented … />}
 *     advanced={<>…selects…</>} advancedActive={2} onClearAdvanced={reset}
 *     summary="9 jobs"
 *     actions={<Button variant="outline">Export</Button>}
 *   />
 */
export function Toolbar({
  search,
  filters,
  advanced,
  advancedActive = 0,
  onClearAdvanced,
  summary,
  actions,
  className,
  label = "Filters",
}: {
  search?: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string };
  filters?: ReactNode;
  advanced?: ReactNode;
  /** How many advanced filters are set (shown on the button so a hidden filter is never a surprise). */
  advancedActive?: number;
  onClearAdvanced?: () => void;
  /** Result count or similar, quiet text. */
  summary?: ReactNode;
  actions?: ReactNode;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div role="group" aria-label={label} className={cn("ds-toolbar mb-4 flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {search && (
          <label className="relative flex h-10 min-w-0 flex-1 basis-56 items-center sm:max-w-sm">
            <span className="sr-only">{search.label ?? search.placeholder ?? "Search"}</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
            <input
              type="search"
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? "Search"}
              className="ds-interactive h-10 w-full rounded-full border border-border bg-inset pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground"
            />
            {search.value && (
              <button type="button" aria-label="Clear search" onClick={() => search.onChange("")} className="ds-interactive absolute right-1.5 grid size-7 place-items-center rounded-full text-muted-foreground hover:text-foreground">
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </label>
        )}
        {filters && <div className="min-w-0 max-w-full">{filters}</div>}
        {advanced && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className={cn("ds-interactive inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-sm font-medium", advancedActive > 0 ? "border-brand/60 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
          >
            <SlidersHorizontal aria-hidden="true" className="size-4" />
            Advanced filters
            {advancedActive > 0 && <span className="ds-num grid h-5 min-w-5 place-items-center rounded-full bg-brand-soft px-1.5 text-xs text-foreground">{advancedActive}</span>}
          </button>
        )}
        {(summary || actions) && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
            {actions}
          </div>
        )}
      </div>
      {advanced && (
        <div id={panelId} hidden={!open} className="rounded-2xl border border-border bg-inset p-3">
          <div className="flex flex-wrap items-end gap-3">{advanced}</div>
          {onClearAdvanced && advancedActive > 0 && (
            <button type="button" onClick={onClearAdvanced} className="ds-interactive mt-3 rounded-md text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground">
              Clear advanced filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
