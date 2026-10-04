// Speed-to-lead: Today panel data (metadata-only). Same discipline as
// scripts/workspace/projections.ts — every field built by hand from an EnquiryRecord, so nothing
// but ref/topic/timestamps can reach the page. Pure; the os-shell track wires this into a real
// panel (see docs/SPEED-TO-LEAD.md) — this file only produces the data.
import type { EnquiryPanel, EnquiryPanelItem } from "../../src/lib/speed-to-lead";
import { isOverdue } from "./clock";
import type { EnquiryRecord } from "./store";

export function projectSpeedToLead(records: EnquiryRecord[], now: Date = new Date()): EnquiryPanel {
  const items: EnquiryPanelItem[] = records
    .filter((r) => r.status === "open")
    .map((r) => ({
      ref: r.ref,
      topic: r.topic || "General enquiry",
      sinceMinutes: Math.max(0, Math.round((now.getTime() - Date.parse(r.receivedAt)) / 60_000)),
      dueInMinutes: Math.round((Date.parse(r.dueAt) - now.getTime()) / 60_000),
      overdue: isOverdue(r.dueAt, now),
    }))
    .sort((a, b) => a.dueInMinutes - b.dueInMinutes);
  return { items, openCount: items.length, overdueCount: items.filter((i) => i.overdue).length };
}
