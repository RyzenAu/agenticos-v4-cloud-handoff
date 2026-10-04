import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Badge, Button, Notice, PageHeader, Skeleton, fmtRelative } from "@/components/ds";
import { useReceptionist, useReceptionistActions, type ReceptionistSnapshot } from "@/lib/receptionist";
import { cn } from "@/lib/utils";
import { lineNumber } from "./format";
import { Calls, RecentCalls } from "./calls";
import { Commercial } from "./commercial";
import { FollowUps, Quality } from "./follow-ups";
import { Gates } from "./gates";
import { HealthStrip } from "./health";
import { Decision } from "./verdict";
import { fmtDateTime } from "@/lib/format";

export function ReceptionistPage() {
  const { data, error, isLoading } = useReceptionist();
  const actions = useReceptionistActions();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try { await actions.refresh(); }
    catch (e) { setRefreshError(e instanceof Error ? e.message : "Refresh failed"); }
    finally { setRefreshing(false); }
  }
  return (
    <div className="min-w-0 max-w-[1400px] [overflow-wrap:anywhere] [&_button]:min-h-10 [&_a]:min-h-10">
      <PageHeader title="Receptionist"
        description={`The AI receptionist on ${data ? lineNumber(data.agent.number) : "the receptionist line"} — whether it's answering, what happened on calls, and whether it's safe to sell.`}
        meta={data && <Badge title={fmtDateTime(new Date(data.generatedAt), { year: true })}>Updated {fmtRelative(data.generatedAt)}</Badge>}
        actions={<>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing || isLoading}>
            <RefreshCw aria-hidden="true" className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {data && <Button variant="ghost" size="sm" asChild><a href={data.agent.retellUrl} target="_blank" rel="noreferrer">Open in Retell <ExternalLink aria-hidden="true" /></a></Button>}
        </>}
      />
      {refreshError && <Notice tone="danger" title="Refresh failed" className="mb-6">{refreshError}</Notice>}
      {error && <Notice tone={data ? "warn" : "danger"} title={data ? "Receptionist status couldn't be updated" : "Receptionist status couldn't be read"} className="mb-6">{error.message}{data && " Showing the last snapshot."}</Notice>}
      {isLoading && <LoadingShape />}
      {data && <Loaded data={data} />}
    </div>
  );
}

function LoadingShape() {
  return <div className="space-y-8" aria-busy="true" aria-label="Loading receptionist status">
    <Skeleton className="h-28 w-full rounded-xl animate-none" />
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl animate-none" />)}</div>
    <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Skeleton className="h-96 rounded-xl animate-none" />
      <div className="space-y-8">
        <Skeleton className="h-80 rounded-xl animate-none" />
        <Skeleton className="h-40 rounded-xl animate-none" />
      </div>
    </div>
    <Skeleton className="h-64 rounded-xl animate-none" />
    <Skeleton className="h-64 rounded-xl animate-none" />
    <Skeleton className="h-64 rounded-xl animate-none" />
  </div>;
}

function Loaded({ data }: { data: ReceptionistSnapshot }) {
  return <>
    <div className="mb-8"><Decision verdict={data.verdict} generatedAt={data.generatedAt} incidents={data.incidents} /></div>
    <div className="mb-8"><HealthStrip items={data.health} /></div>
    <div className="mb-12 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0"><Gates data={data.readiness} automated={data.health.find(item => item.id === "evals")?.headline} /></div>
      <div className="min-w-0"><Calls data={data.calls} /><Quality data={data.feed} /></div>
    </div>
    <div className="mb-12"><RecentCalls data={data.calls} feed={data.feed} /></div>
    <div className="mb-12"><FollowUps data={data.feed} /></div>
    <Commercial data={data.commercial} />
  </>;
}
