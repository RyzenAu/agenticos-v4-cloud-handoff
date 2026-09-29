import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Disclosure, EmptyState, Notice, StatusDot } from "@/components/ds";
import { callingWindowStatus } from "../../../scripts/workspace/calling-window";
import { useWorkspacePanel, type Approval } from "./api";
import { PanelShell } from "./panel-shell";
import { fmtProse } from "@/lib/format";

const TZ = "Australia/Sydney";
export const sydneyDate = (at: number) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(at);
export const sydneyTime = (at: number | string) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(at));
const sydneyWhen = (at: string) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(at));

const AREA_LABEL: Record<Approval["area"], string> = {
  receptionist: "Receptionist",
  websites: "Websites",
  sales: "Sales",
  email: "Email",
  offers: "Offers",
  finance: "Finance",
  operations: "Operations",
};

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

function ApprovalItem({ item }: { item: Approval }) {
  const internal = item.href.startsWith("/");
  const body = (
    <>
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <span className="min-w-0 text-base font-medium leading-snug text-foreground">{fmtProse(item.title)}</span>
        <span className="shrink-0 self-start text-xs text-muted-foreground">{AREA_LABEL[item.area]}</span>
      </div>
      {/* L1: title plus one short line; the full detail and the source are on hover. */}
      <p className="mt-1 truncate text-sm text-muted-foreground" title={fmtProse(`${item.detail}
${item.source}${item.since ? ` · since ${item.since}` : ""}`)}>{fmtProse(item.detail)}</p>
      {item.progress && <p className="mt-1 truncate text-sm font-medium text-warn" title={fmtProse(item.progress)}>{fmtProse(item.progress)}</p>}
    </>
  );
  const cls = "ds-interactive block h-full rounded-xl px-4 py-3.5 hover:bg-surface-raised";
  return <li className="min-w-0">{internal ? <Link to={item.href as any} className={cls}>{body}</Link> : <a href={item.href} target="_blank" rel="noreferrer" className={cls}>{body}</a>}</li>;
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
          {data.derivedError && <Notice tone="warn">{data.derivedError}. The list below is from approvals.json only.</Notice>}
          {data.approvals.length === 0 ? (
            <EmptyState variant="row" title="Nothing waiting on you" body="No pending owner decisions. Add one to scripts/workspace/approvals.json when a decision is yours to make." />
          ) : (
            <>
              <ul className="-mx-4 divide-y divide-border" aria-label="Owner decisions">
                {(all ? data.approvals : data.approvals.slice(0, FIRST)).map((item) => <ApprovalItem key={item.id} item={item} />)}
              </ul>
              {data.approvals.length > FIRST && (
                <Button variant="outline" className="h-10 rounded-full px-5" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                  {all ? "Show fewer" : `Show all ${data.approvals.length}`}
                </Button>
              )}
            </>
          )}
          {data.approvalsErrors.length > 0 && (
            <div className="-mx-3 rounded-xl bg-warn-soft/40">
              <Disclosure
                summary={<span className="font-medium text-warn">Some approvals were skipped ({data.approvalsErrors.length})</span>}
                meta="Fix approvals.json"
              >
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {data.approvalsErrors.map((e) => <li key={e}>{fmtProse(e)}</li>)}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">Fix scripts/workspace/approvals.json.</p>
              </Disclosure>
            </div>
          )}
        </div>
      )}
    </PanelShell>
  );
}
