import { useId, useMemo, useState, type ReactNode } from "react";
import { Button, EmptyState, Segmented } from "@/components/ds";
import { fmtDay } from "@/lib/format";
import type { MemoryRow } from "./client";
import { MEMORY_RANGES, memoryTimeline, type MemoryRange } from "./timeline-model";

/** V4.4 timeline idea, using M&U's existing records, source links and detail actions. */
export function MemoryBrowser({ rows, renderRow }: { rows: MemoryRow[]; renderRow: (row: MemoryRow) => ReactNode }) {
  const id = useId();
  const [view, setView] = useState<"list" | "timeline">("timeline");
  const [range, setRange] = useState<MemoryRange>("all");
  const groups = useMemo(() => memoryTimeline(rows, range), [rows, range]);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const items = (list: MemoryRow[]) => <ul className="space-y-3">{list.map((row) => <li key={`${row.id}:${row.status}`}>{renderRow(row)}</li>)}</ul>;
  return <div>
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <Segmented ariaLabel="Memory view" value={view} options={[{ value: "timeline", label: "Timeline" }, { value: "list", label: "List" }]} onChange={setView} />
      <div className="flex flex-col gap-1 text-sm text-muted-foreground"><label htmlFor={id}>Updated</label>
        <select id={id} value={range} onChange={(e) => setRange(e.target.value as MemoryRange)} className="min-h-11 rounded-lg border border-border bg-card px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {MEMORY_RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>
    </div>
    <p className="mb-4 text-sm text-muted-foreground" role="status">{count} of {rows.length} loaded items · newest first · device time</p>
    {!count ? <EmptyState title="No items in this date range" body="Choose a wider range to see older records." action={<Button variant="outline" onClick={() => setRange("all")}>Show any time</Button>} /> : view === "list" ? items(groups.flatMap((g) => g.rows)) :
      <div className="space-y-6">{groups.map((g) => <section key={g.key} aria-label={g.date ? fmtDay(g.date, { year: true }) : "Date unavailable"}>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground"><span className="size-1.5 rounded-full bg-primary" aria-hidden />{g.date ? fmtDay(g.date, { weekday: true, year: true }) : "Date unavailable"}<span className="ml-auto tabular-nums">{g.rows.length}</span></h3>
        {items(g.rows)}
      </section>)}</div>}
  </div>;
}
