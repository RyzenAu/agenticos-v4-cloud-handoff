import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Badge, Button, EmptyState, Section, Segmented, StatTile, fmtCount, fmtPercent } from "@/components/ds";
import { FLAG_LABEL, type AgencyFeedState, type CallRow, type CallsBlock, type FeedCall } from "@/lib/receptionist";
import { aud, callTime, duration, maskedCaller, seconds } from "./format";

const MAX_FLAG_BADGES = 2;

export function Calls({ data }: { data: CallsBlock }) {
  if (!data.ok) return <Section title="Calls"><p className="text-xs text-muted-foreground">{data.reason}</p></Section>;
  return <AvailableCalls data={data} />;
}

function AvailableCalls({ data }: { data: Extract<CallsBlock, { ok: true }> }) {
  const [period, setPeriod] = useState(data.windows[0].count > 0 ? "Today" : "All time");
  const window = data.windows.find(w => w.label === period) ?? data.windows[2];
  const p50 = window.latencyP50Ms;
  const muted: string[] = [];
  muted.push(`Retell's own "successful" mark: ${window.successRate === null ? "not analysed" : fmtPercent(window.successRate)} (not a safety check)`);
  if (window.disconnectReasons.length > 0) muted.push(`Ended by: ${window.disconnectReasons.map(r => `${r.reason.replaceAll("_", " ")} ${fmtCount(r.count)}`).join(", ")}`);
  return <Section title="Calls" actions={<Segmented value={period} onChange={setPeriod} ariaLabel="Call period" options={data.windows.map(w => ({ value: w.label, label: w.label }))} />}>
    <div className="grid grid-cols-2 gap-3">
      <StatTile label="Calls" value={fmtCount(window.count)} hint={<>{fmtCount(window.answered)} connected · <span className={window.flaggedCalls > 0 ? "text-danger" : undefined}>{fmtCount(window.flaggedCalls)} flagged</span></>} />
      <StatTile label="Duration" value={duration(window.avgDurationSec)} hint={`p90 ${duration(window.p90DurationSec)}`} />
      <StatTile label="Latency" value={seconds(p50)} hint={`p90 ${seconds(window.latencyP90Ms)}`} tone={p50 !== null && p50 > 3000 ? "danger" : p50 !== null && p50 > 2000 ? "warn" : "default"} trend={data.latencyTrend.length >= 3 ? data.latencyTrend.map(p => p.p50Ms / 1000) : undefined} />
      <StatTile label="Cost" value={window.aud === null ? `US¢${window.usdCents.toFixed(2)}` : aud(window.aud)} hint={`${window.audPerMinute === null ? "AUD/min unavailable" : `${aud(window.audPerMinute)}/min`} · Retell`} />
    </div>
    <p className="mt-3 text-xs text-muted-foreground">{muted.join(" · ")}</p>
  </Section>;
}

export function RecentCalls({ data, feed }: { data: CallsBlock; feed: AgencyFeedState }) {
  const [more, setMore] = useState(false);
  // The production feed beats the Retell-API-only list whenever it is available: it carries the
  // QA flag codes and outcomes from the database.
  if (feed.ok) {
    const rows = feed.calls;
    return <Section title="Recent calls" description="From the MU-Receptionist production feed — QA flags and outcomes from the database.">
      {rows.length === 0 ? <EmptyState title="No calls in the feed" body="Ring +61 485 011 208 to make the first test call." /> : <>
        <ul className="space-y-2">{(more ? rows : rows.slice(0, 6)).map(call => <li key={call.id}><FeedCallRow call={call} /></li>)}</ul>
        {rows.length > 6 && <Button variant="ghost" size="xs" className="mt-2" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show all ${rows.length}`}</Button>}
      </>}
    </Section>;
  }
  if (!data.ok) return null;
  return <Section title="Recent calls">
    {data.recent.length === 0 ? <EmptyState title="No calls yet" body="Ring +61 485 011 208 to make the first test call." /> : <>
      <ul className="space-y-2">{(more ? data.recent : data.recent.slice(0, 6)).map(call => <li key={call.id}><RecentCall call={call} /></li>)}</ul>
      {data.recent.length > 6 && <Button variant="ghost" size="xs" className="mt-2" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show all ${data.recent.length}`}</Button>}
    </>}
  </Section>;
}

/** One call row from the agency feed: outcome and QA codes from the production database. */
function FeedCallRow({ call }: { call: FeedCall }) {
  const qa = call.qa;
  const codes = qa?.flagCodes ?? [];
  const shown = codes.slice(0, MAX_FLAG_BADGES);
  const rest = codes.slice(MAX_FLAG_BADGES);
  return <div className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-3 shadow-sm lg:grid-cols-[11rem_minmax(0,1fr)_auto] sm:p-4">
    <div className="min-w-0 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">{callTime(call.startedAt)}</p>
      <p className="mt-1">{maskedCaller(call.callerMasked)}</p>
      <p className="ds-num mt-0.5">{duration(call.durationSeconds)}</p>
    </div>
    <p className="min-w-0 line-clamp-2 text-sm text-foreground" title={call.summary ?? undefined}>{call.summary || "No summary available"}</p>
    <div className="flex min-w-0 flex-wrap items-start gap-1.5 lg:justify-end">
      {call.outcome && <Badge>{call.outcome}</Badge>}
      {(call.sentiment ?? "").toLowerCase() === "positive" && <Badge tone="success">Positive</Badge>}
      {(call.sentiment ?? "").toLowerCase() === "negative" && <Badge tone="danger">Negative</Badge>}
      {qa === null ? <Badge>Not graded</Badge> : <>
        {qa.topBand === "critical" && qa.reviewStatus !== "resolved" && <Badge tone="danger">Critical open</Badge>}
        {shown.map(code => <Badge key={code} tone="danger" title={`QA flag: ${code}`}>{codeLabel(code)}</Badge>)}
        {rest.length > 0 && <Badge title={rest.join(", ")}>+{rest.length}</Badge>}
        {codes.length === 0 && <Badge tone={qa.flagCount ? "danger" : "success"}>{qa.flagCount ? `QA · ${fmtCount(qa.flagCount)} flags` : "QA clear"}</Badge>}
      </>}
      {call.providerCallId && <Button variant="ghost" size="icon-sm" asChild><a href={`https://dashboard.retellai.com/call-history?history=${encodeURIComponent(call.providerCallId)}`} target="_blank" rel="noreferrer" aria-label="Open call in Retell" title="Open call in Retell"><ExternalLink aria-hidden="true" /></a></Button>}
    </div>
  </div>;
}

// QA engine codes are strings; show them readable without inventing a label.
const codeLabel = (code: string) => code.replaceAll("_", " ").toLowerCase();

function RecentCall({ call }: { call: CallRow }) {
  const shown = call.flags.slice(0, MAX_FLAG_BADGES);
  const rest = call.flags.slice(MAX_FLAG_BADGES);
  return <div className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-3 shadow-sm lg:grid-cols-[11rem_minmax(0,1fr)_auto] sm:p-4">
    <div className="min-w-0 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">{callTime(call.startedAt)}</p>
      <p className="mt-1">{call.kind === "web" ? "Web test" : maskedCaller(call.from)}</p>
      <p className="ds-num mt-0.5">{duration(call.durationSec)} · {seconds(call.latencyP50Ms)}</p>
    </div>
    <p className="min-w-0 line-clamp-2 text-sm text-foreground" title={call.summary ?? undefined}>{call.summary || "No summary available"}</p>
    <div className="flex min-w-0 flex-wrap items-start gap-1.5 lg:justify-end">
      {(call.sentiment === "Positive" || call.sentiment === "Negative") && <Badge tone={call.sentiment === "Positive" ? "success" : "danger"}>{call.sentiment}</Badge>}
      {shown.map(flag => <Badge key={flag} tone="danger">{FLAG_LABEL[flag]}</Badge>)}
      {rest.length > 0 && <Badge title={rest.map(f => FLAG_LABEL[f]).join(", ")}>+{rest.length}</Badge>}
      {!call.checked ? <Badge>Not checked</Badge> : call.flags.length === 0 && <Badge tone="success">No flags</Badge>}
      <Button variant="ghost" size="icon-sm" asChild><a href={call.retellUrl} target="_blank" rel="noreferrer" aria-label="Open call in Retell" title="Open call in Retell"><ExternalLink aria-hidden="true" /></a></Button>
    </div>
  </div>;
}
