import { useState } from "react";
import { Button, Disclosure, EmptyState, Notice, StatusDot } from "@/components/ds";
import { callingWindowStatus } from "../../../scripts/workspace/calling-window";
import { useWorkspacePanel } from "./api";
import { PanelShell } from "./panel-shell";
import { fmtProse } from "@/lib/format";
import { DecisionRow, PendingBrowserNote } from "./decision-row";

const TZ = "Australia/Sydney";
export const sydneyDate = (at: number) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(at);
export const sydneyTime = (at: number | string) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(at));
const sydneyWhen = (at: string) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(at));

/** The calling window, computed in the browser from the same rules the call queue uses. */
export function CallingWindow({ now }: { now: number }) {
  const w = callingWindowStatus(new Date(now));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <StatusDot tone={w.open ? "success" : "warn"} label={<span className="font-medium text-foreground">Calling hours {w.open ? "open" : "closed"}</span>} />
      <span className="text-xs text-muted-foreground">
        {w.open && w.closesAt ? `Until ${sydneyTime(w.closesAt)}` : w.nextOpenAt ? `${w.label.replace(/^Closed · /, "")} · next window ${sydneyWhen(w.nextOpenAt)}` : w.label}
      </span>
    </div>
  );
}

// Work (W-B, 29 Sep 2026): three at a time in one calm column; the rest behind "Show all".
const FIRST = 3;

export function TodayPanel({ now }: { now: number }) {
  const query = useWorkspacePanel("today");
  const [all, setAll] = useState(false);
  return (
    <PanelShell id="ws-today" title="Owner approvals" link={{ to: "/operations", label: "Operations" }} query={query} now={now} loadingRows={4} className="rounded-2xl p-5 sm:p-6">
      {(data) => (
        <div className="space-y-3">
          {data.derivedError && <Notice tone="warn">{data.derivedError}. The list below is from the approvals list only.</Notice>}
          {data.approvals.length === 0 ? (
            <EmptyState variant="row" title="No business decisions waiting" body="Recorded decisions are below. Emails and agent questions have their own controls." />
          ) : (
            <>
              <PendingBrowserNote />
              <ul className="-mx-4 divide-y divide-border" aria-label="Owner decisions">
                {(all ? data.approvals : data.approvals.slice(0, FIRST)).map((item) => <DecisionRow key={item.id} item={item} />)}
              </ul>
              {data.approvals.length > FIRST && (
                <Button variant="outline" className="h-10 rounded-full px-5" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                  {all ? "Show fewer" : `Show all ${data.approvals.length}`}
                </Button>
              )}
            </>
          )}
          {!!data.decisions?.length && <details className="border-t border-border pt-3"><summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Recorded decisions ({data.decisions.length})</summary><ul className="-mx-4 divide-y divide-border" aria-label="Recorded decisions">{data.decisions.map(record => <DecisionRow key={record.item.id} item={record.item} record={record} />)}</ul></details>}
          {data.approvalsErrors.length > 0 && (
            <div className="-mx-3 rounded-xl bg-warn-soft/40">
              <Disclosure
                summary={<span className="font-medium text-warn">{data.approvalsErrors.length === 1 ? "One approval couldn't be read" : `${data.approvalsErrors.length} approvals couldn't be read`}</span>}
                meta="Left out of the list"
              >
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {data.approvalsErrors.map((e) => <li key={e}>{fmtProse(e)}</li>)}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">These entries are left out until they are corrected, so they are not counted above.</p>
              </Disclosure>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  );
}
