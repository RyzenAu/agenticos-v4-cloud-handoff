import { ChevronRight } from "lucide-react";
import { leadDate, websiteVerification } from "@/lib/call-queue";
import {
  statusLabel,
  suburbOf,
  VERTICAL_LABEL,
  type BoardLead,
  type Preview,
  type Vertical,
} from "@/lib/leads";

/** A scanning list, not a stack of mini dashboards. The existing drawer owns contact,
 * evidence, source details and actions. Unknown website status stays visible here. */
export function LeadRows({
  leads,
  onOpen,
  now,
  previews,
}: {
  leads: BoardLead[];
  onOpen: (id: number) => void;
  now: number;
  previews?: ReadonlyMap<number, Pick<Preview, "status">>;
}) {
  return (
    <ul
      aria-label="Lead results"
      className="overflow-hidden rounded-2xl border border-border bg-card divide-y divide-border"
    >
      {leads.map((lead) => {
        const overdue = !!lead.nextAt && Date.parse(lead.nextAt) < now && !lead.deal.closed;
        const preview = previews?.get(lead.id);
        return (
          <li key={lead.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onOpen(lead.id)}
              aria-label={`Open ${lead.name || "lead"}`}
              className="transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand focus-visible:-outline-offset-2 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 px-4 py-4 text-left hover:bg-surface-raised sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_auto] sm:px-5"
            >
              <span className="min-w-0 sm:col-start-1 sm:row-start-1">
                <span className="block text-base font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
                  {lead.name ||
                    (lead.source === "google"
                      ? "Google place · details not loaded"
                      : "Name not on file")}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {[suburbOf(lead.area), VERTICAL_LABEL[lead.vertical as Vertical] ?? lead.vertical]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="mt-2 block text-xs text-muted-foreground">
                  {websiteVerification(lead)}
                </span>
                {lead.source === "google" && (lead.placesLive?.attribution || lead.attribution) && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {lead.placesLive?.attribution || lead.attribution}
                  </span>
                )}
              </span>
              <span className="col-start-1 min-w-0 sm:col-start-2 sm:row-start-1">
                <span className="block text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">
                  {lead.deal.nextAction}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {statusLabel(lead.status)} · {lead.owner || "Unassigned"}
                  {preview ? ` · Preview ${statusLabel(preview.status).toLowerCase()}` : ""}
                </span>
                {lead.nextAt && (
                  <span
                    className={`mt-2 block text-xs ${overdue ? "text-warn" : "text-muted-foreground"}`}
                  >
                    {overdue ? "Overdue · " : "Due · "}
                    {leadDate(lead.nextAt)} Sydney
                  </span>
                )}
                {lead.deal.stuck && (
                  <span className="mt-2 block text-xs text-warn">
                    Needs attention · {lead.deal.stuck.days} days in stage
                  </span>
                )}
              </span>
              <ChevronRight
                aria-hidden="true"
                className="col-start-2 row-start-1 size-4 self-center text-muted-foreground sm:col-start-3"
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
