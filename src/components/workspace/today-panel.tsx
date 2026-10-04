import { useState } from "react";
import { Button, DetailDrawer, Details, Disclosure, EmptyState, Notice, StatusDot, StatusLabel, WorkList, WorkRow } from "@/components/ds";
import { callingWindowStatus } from "../../../scripts/workspace/calling-window";
import { useWorkspacePanel, type Approval } from "./api";
import type { DecisionRecord } from "../../../scripts/workspace/decisions";
import { PanelShell } from "./panel-shell";
import { fmtProse } from "@/lib/format";
import { DecisionRow, PendingBrowserNote, plainSettingNames } from "./decision-row";

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
// R12 rollout: each decision is ONE row (title, one meta line, its state); the row opens the decision in a drawer, where the answer is
// recorded. The open decision is in the URL (`?decision=<id>`) when the page passes `openId`/`onOpen`, so Back closes it.
const FIRST = 3;

/** A page path in a meta line reads as the page's name ("on Receptionist"); the drawer keeps the links. */
const pageNames = (t: string) => t.replace(/(^|\s)\/([a-z][a-z-]*)/g, (_, sp: string, p: string) => `${sp}${p.charAt(0).toUpperCase()}${p.slice(1).replace(/-/g, " ")}`);
const approvalMeta = (a: Approval) => [pageNames(a.progress ? fmtProse(a.progress) : plainSettingNames(fmtProse(a.detail)).plain), a.since ? `raised ${a.since}` : null].filter(Boolean).join(" · ");
const recordWord = (r: DecisionRecord) => (r.answer === "completed" ? "Completed" : r.answer === "approved" ? "Approved" : "Declined");

export function TodayPanel({ now, openId, onOpen }: { now: number; openId?: string | null; onOpen?: (id: string | null) => void }) {
  const query = useWorkspacePanel("today");
  const [all, setAll] = useState(false);
  const [localId, setLocalId] = useState<string | null>(null);
  const current = onOpen ? (openId ?? null) : localId;
  const open = onOpen ?? setLocalId;
  return (
    <>
    <PanelShell id="ws-today" title="Needs your decision" link={{ to: "/operations", label: "Operations" }} query={query} now={now} loadingRows={4} className="rounded-none border-0 bg-transparent p-0 sm:p-0">
      {(data) => (
        <div className="space-y-3">
          {data.derivedError && <Notice tone="warn">{data.derivedError}. The list below is from the approvals list only.</Notice>}
          {data.approvals.length === 0 ? (
            <EmptyState variant="row" title="No business decisions waiting" body="Recorded decisions are below. Emails and agent questions have their own controls." />
          ) : (
            <>
              <PendingBrowserNote />
              <WorkList label="Owner decisions">
                {(all ? data.approvals : data.approvals.slice(0, FIRST)).map((a) => (
                  <WorkRow key={a.id} data-decision={a.id} title={plainSettingNames(fmtProse(a.title)).plain} meta={approvalMeta(a)} selected={current === a.id}
                    status={<StatusLabel state="needs-you" size="sm" label={a.recordable ? "Decide" : "Review"} />} onClick={() => open(a.id)} />
                ))}
              </WorkList>
              {data.approvals.length > FIRST && (
                <Button variant="outline" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                  {all ? "Show fewer" : `Show all ${data.approvals.length}`}
                </Button>
              )}
            </>
          )}
          {!!data.decisions?.length && (
            <details className="border-t border-border pt-3">
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Recorded decisions ({data.decisions.length})</summary>
              <WorkList label="Recorded decisions" className="mt-2">
                {data.decisions.map((r) => (
                  <WorkRow key={r.item.id} data-decision={r.item.id} title={plainSettingNames(fmtProse(r.item.title)).plain} meta={r.note || undefined} selected={current === r.item.id}
                    status={<StatusLabel state="done" size="sm" label={recordWord(r)} />} onClick={() => open(r.item.id)} />
                ))}
              </WorkList>
            </details>
          )}
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
    <DecisionDrawer openId={current} onOpen={open} />
    </>
  );
}

/** The open decision: its detail, the evidence link and the record form (DecisionRow), in the shared drawer. */
function DecisionDrawer({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const query = useWorkspacePanel("today");
  const data = query.data?.ok ? query.data.data : null;
  const record = data?.decisions?.find((r) => r.item.id === openId);
  const item = data?.approvals.find((a) => a.id === openId) ?? record?.item;
  return (
    <DetailDrawer open={!!item} onOpenChange={(o) => !o && onOpen(null)} title={item ? plainSettingNames(fmtProse(item.title)).plain : ""}
      status={item ? (record ? <StatusLabel state="done" label={recordWord(record)} /> : <StatusLabel state="needs-you" label={item.recordable ? "Decide" : "Review"} />) : undefined}>
      {item && (
        <ul className="-mx-4" data-decision-drawer={item.id}>
          <DecisionRow item={item} record={record} bare />
        </ul>
      )}
      {item && <Details items={[{ label: "Source", value: item.source }, ...(item.since ? [{ label: "Raised", value: item.since }] : []), { label: "Area", value: item.area }]} />}
    </DetailDrawer>
  );
}
