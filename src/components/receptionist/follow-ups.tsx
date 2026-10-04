import { useState } from "react";
import { Badge, Button, EmptyState, Section, StatTile, fmtCount, fmtRelative } from "@/components/ds";
import type { AgencyFeedState, TriageItem } from "@/lib/receptionist";
import { callTime, maskedCaller } from "./format";

const MAX_ROWS = 6;

/**
 * QA totals from the agency feed (graded / flagged / critical open), in the Calls area.
 * A counter the feed didn't send renders as "—", never as a zero.
 */
export function Quality({ data }: { data: AgencyFeedState }) {
  if (!data.ok) return null;
  const t = data.totals;
  const value = (v: number | null) => (v === null ? null : fmtCount(v));
  const flaggedTone = t.qaFlagged === null ? "default" : t.qaFlagged > 0 ? "danger" : "success";
  const criticalTone = t.qaCriticalOpen === null ? "default" : t.qaCriticalOpen > 0 ? "danger" : "success";
  return (
    <Section title="Quality"
      description={`QA from the MU-Receptionist production feed · generated ${fmtRelative(data.generatedAt)}`}>
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Graded" value={value(t.qaGraded)} hint="Calls with a QA review" />
        <StatTile label="Flagged" value={value(t.qaFlagged)} tone={flaggedTone} hint="Calls with QA flag codes" />
        <StatTile label="Critical open" value={value(t.qaCriticalOpen)} tone={criticalTone} hint="Critical band, unresolved" />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {`${fmtCount(t.calls)} calls in the last ${data.windowDays ?? "—"} days · ${fmtCount(t.completed)} completed · ${fmtCount(t.failed)} failed · ${fmtCount(t.totalMinutes)} min`}
      </p>
    </Section>
  );
}

/** Pending triage items from the agency feed — the "Follow-ups" panel. */
export function FollowUps({ data }: { data: AgencyFeedState }) {
  const [more, setMore] = useState(false);
  if (!data.ok)
    return <Section title="Follow-ups"><p className="text-xs text-muted-foreground">{data.reason}</p></Section>;
  const t = data.totals;
  return (
    <Section title="Follow-ups" description="Pending triage from the MU-Receptionist production database.">
      <p className="mb-4 text-xs text-muted-foreground">
        {`${fmtCount(t.triagePending)} pending · ${fmtCount(t.triageDone)} done${t.oldestPendingTriageAt ? ` · oldest ${callTime(t.oldestPendingTriageAt)}` : ""}`}
      </p>
      {data.followUps.length === 0 ? (
        <EmptyState title="Nothing pending" body="Every triage item has been done." />
      ) : (
        <>
          <ul className="space-y-2">
            {(more ? data.followUps : data.followUps.slice(0, MAX_ROWS)).map(item => <li key={item.id}><FollowUpRow item={item} /></li>)}
          </ul>
          {data.followUps.length > MAX_ROWS && (
            <Button variant="ghost" size="xs" className="mt-2" onClick={() => setMore(!more)}>
              {more ? "Show fewer" : `Show all ${data.followUps.length}`}
            </Button>
          )}
        </>
      )}
    </Section>
  );
}

const urgencyTone = (urgency: string | null) =>
  /urgent|high|emergency|critical/i.test(urgency ?? "") ? "danger" : /medium|moderate/i.test(urgency ?? "") ? "warn" : "neutral";

function FollowUpRow({ item }: { item: TriageItem }) {
  return (
    <div className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-3 shadow-sm lg:grid-cols-[11rem_minmax(0,1fr)_auto] sm:p-4">
      <div className="min-w-0 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{item.contactFirstName ?? "Name unavailable"}</p>
        <p className="mt-1">{callTime(item.receivedAt)}</p>
        <p className="ds-num mt-0.5">{maskedCaller(item.callerMasked)}</p>
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm text-foreground">{item.intent ?? "No intent recorded"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Urgency: {item.urgency ?? "—"}{item.alertPriority ? ` · alert ${item.alertPriority}` : ""}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-start gap-1.5 lg:justify-end">
        {item.urgency && <Badge tone={urgencyTone(item.urgency)}>{item.urgency}</Badge>}
        {item.callbackNeeded ? <Badge tone="warn">Callback needed</Badge> : <Badge>No callback</Badge>}
        <Badge title={item.status ?? undefined}>{item.status ?? "Pending"}</Badge>
      </div>
    </div>
  );
}
