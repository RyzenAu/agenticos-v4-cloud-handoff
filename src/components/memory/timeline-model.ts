import type { MemoryRow } from "./client";

export const MEMORY_RANGES = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "Past 7 days" },
  { value: "30d", label: "Past 30 days" },
  { value: "90d", label: "Past 90 days" },
] as const;
export type MemoryRange = (typeof MEMORY_RANGES)[number]["value"];
export type MemoryDay = { key: string; date: string | null; rows: MemoryRow[] };

/** A view of the records already returned by the memory service, not a second index. */
export function memoryTimeline(rows: readonly MemoryRow[], range: MemoryRange, now = Date.now()): MemoryDay[] {
  const since = range === "all" ? -Infinity : now - Number.parseInt(range) * 86400000;
  const timestamp = (row: MemoryRow) => Date.parse(row.date);
  const sorted = rows.filter((row) => range === "all" || (timestamp(row) >= since && timestamp(row) <= now))
    .map((row, order) => ({ row, order, time: timestamp(row) }))
    .sort((a, b) => (Number.isFinite(b.time) ? b.time : -Infinity) - (Number.isFinite(a.time) ? a.time : -Infinity) || a.order - b.order);
  const days = new Map<string, MemoryDay>();
  for (const { row, time } of sorted) {
    const date = new Date(time);
    const known = Number.isFinite(time);
    // Calendar grouping follows the same device timezone as the existing date formatter.
    const key = known ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : "unknown";
    const group = days.get(key) ?? { key, date: known ? row.date : null, rows: [] };
    group.rows.push(row);
    days.set(key, group);
  }
  return [...days.values()];
}
