import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useReceptionist, useReceptionistActions } from "@/lib/receptionist";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button, Notice, PageFoot, PageHeader, Skeleton, TabPanel, Tabs, type TabItem } from "@/components/ds";
import { useReceptionistDashboard, useReceptionistDashboardActions, type DashboardViewModel } from "@/lib/receptionist-dashboard";
import { staleNote } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Gates } from "../gates";
import { CallsAndBookings } from "./calls-bookings";
import { ClientsTable } from "./clients-table";
import { GoLiveChecklist } from "./go-live-checklist";
import { Overview } from "./overview";
import { feedReadAgreement, mergeSellExceptions, type SellSource } from "./sell-exceptions";
import { FlaggedCalls, NextStepBar, SellVerdict, SummaryTiles, TopAttention, jumpTo, useSellPageContext, type RxTab } from "./sell-status";
import { EconomicsByBasis } from "./economics-by-basis";
import { DashboardRetryProvider, useNow } from "./shared";
import { SmsPanel } from "./sms-panel";
import { UsageAndEconomics } from "./usage-economics";

const TABS_ID = "rx";
const TAB_IDS: RxTab[] = ["overview", "calls", "golive", "clients", "economics", "health"];

/**
 * os-shell mounts this at the Receptionist destination. D1 (29 Sep): four big tiles, one next step,
 * then tabs. Every section the page had is in a tab (nothing dropped); explanations and sources sit
 * behind (i), states (stale, failed, unknown) stay in view.
 */
export function ReceptionistDashboardPage() {
  const { data, error, isLoading } = useReceptionistDashboard();
  // The sell verdict, flagged calls and gates come from /__receptionist, independently of the feed.
  const receptionist = useReceptionist();
  const sell: SellSource = { data: receptionist.data, error: receptionist.error, isLoading: receptionist.isLoading };
  const actions = useReceptionistDashboardActions();
  const sellActions = useReceptionistActions();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [tab, setTab] = useState<RxTab>("overview");
  const onFocusCall = useSellPageContext(sell);
  const now = useNow();
  const foot = data ? staleNote(data.generatedAt, now) : null;
  // A shared link can open a tab (#calls, #golive …); the hash follows the tab without adding history.
  useEffect(() => {
    const h = window.location.hash.slice(1) as RxTab;
    if (TAB_IDS.includes(h)) setTab(h);
  }, []);
  const choose = useCallback((next: RxTab) => {
    setTab(next);
    try { window.history.replaceState(window.history.state, "", `#${next}`); } catch { /* ignore */ }
  }, []);
  /** A tile or the next step: open the tab, then bring the section into view. */
  const open = useCallback((next: RxTab, anchor?: string) => {
    choose(next);
    requestAnimationFrame(() => jumpTo(anchor ?? `${TABS_ID}-tabs`));
  }, [choose]);
  // RX-1: Refresh FORCES both reads (dashboard and sell status), each bypassing its server cache and
  // the feed's. Re-GETting the cached snapshot (the old invalidate) could keep a 60 s-old verdict.
  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    const results = await Promise.allSettled([actions.refresh(), sellActions.refresh()]);
    const failed = results.flatMap((r, i) =>
      r.status === "rejected" ? [`${i === 0 ? "Dashboard" : "Sell status"}: ${r.reason instanceof Error ? r.reason.message : "refresh failed"}`] : [],
    );
    if (failed.length) setRefreshError(failed.join(" · "));
    setRefreshing(false);
  }
  const retrySell = () => void sellActions.refresh().catch((e) => setRefreshError(`Sell status: ${e instanceof Error ? e.message : "refresh failed"}`));
  const flaggedCount = sell.data ? sell.data.incidents.length + (sell.data.awaitingRetest?.length ?? 0) : null;
  const openGates = sell.data ? sell.data.readiness.blockers.filter((b) => b.state !== "pass").length : null;
  const tabs: TabItem<RxTab>[] = [
    { id: "overview", label: "Overview" },
    { id: "calls", label: "Calls", count: flaggedCount },
    { id: "golive", label: "Go-live", count: openGates },
    { id: "clients", label: "Clients" },
    { id: "economics", label: "Economics" },
    { id: "health", label: "Health" },
  ];
  const panel = (id: RxTab, children: ReactNode) => (
    <TabPanel idBase={TABS_ID} id={id} active={tab === id} className="pt-8">
      {children}
    </TabPanel>
  );
  const needsDashboard = (render: (d: DashboardViewModel) => ReactNode) =>
    data ? (
      render(data)
    ) : isLoading ? (
      <LoadingShape />
    ) : (
      <p className="rounded-2xl bg-inset px-5 py-4 text-base text-muted-foreground">Dashboard couldn't be read. Refresh to try again.</p>
    );
  const sellData = sell.data;
  return (
    // No page-wide overflow-wrap:anywhere (RX-11): it broke table words mid-word at 390. Long free
    // text wraps where it's rendered (break-words), tables scroll sideways instead.
    <div className="min-w-0 break-words [&_button]:min-h-10 [&_a]:min-h-10" data-rx-page>
      <PageHeader
        title="Receptionist"
        // L1 (29 Sep 2026): one headline; freshness and sources moved to the page foot.
        description="Calls, clients and launch readiness."
        actions={
          <Button variant="outline" size="sm" className="h-10 rounded-full px-4" onClick={refresh} disabled={refreshing || isLoading}>
            <RefreshCw aria-hidden="true" className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      {refreshError && (
        <Notice tone="danger" title="Refresh failed" className="mb-6 rounded-2xl">
          {refreshError}
        </Notice>
      )}
      {error && (
        <Notice tone={data ? "warn" : "danger"} title={data ? "Dashboard couldn't be updated" : "Dashboard couldn't be read"} className="mb-6 rounded-2xl">
          {error.message}
          {data && " Showing the last snapshot."}
        </Notice>
      )}
      {sell.error && sellData && (
        <Notice tone="warn" title="Sell status couldn't be updated" className="mb-6 rounded-2xl">
          {sell.error.message} Showing the last read.</Notice>
      )}
      <FeedReadNotice dashboard={data} sell={sell} />

      {/* The next step comes first, in the page order too (keyboard and screen readers read what is seen). */}
      <NextStepBar sell={sell} onOpen={open} onRetry={retrySell} className="mb-4 lg:mb-6" />
      <SummaryTiles sell={sell} onOpen={open} controls={(t) => `${TABS_ID}-panel-${t}`} />

      <div id={`${TABS_ID}-tabs`} className="mt-10 scroll-mt-6">
        <Tabs tabs={tabs} value={tab} onChange={choose} idBase={TABS_ID} label="Receptionist sections" />
      </div>

      {/* Every tile's "retry" runs this same forced re-read (POST /__receptionist/dashboard/refresh). */}
      <DashboardRetryProvider value={refreshing ? null : () => void refresh()}>
        {panel("overview", <TopAttention sell={sell} onOpen={open} />)}
        {panel(
          "calls",
          <>
            {sellData && (
              <FlaggedCalls incidents={sellData.incidents} awaitingRetest={sellData.awaitingRetest} callsUnread={sellData.calls.ok ? null : sellData.calls.reason} onFocusCall={onFocusCall} />
            )}
            {needsDashboard((d) => (
              <>
                <CallsAndBookings data={d} />
                <SmsPanel data={d} />
              </>
            ))}
          </>,
        )}
        {panel(
          "golive",
          <>
            <div className="mb-12">
              <SellVerdict sell={sell} onRetry={retrySell} />
            </div>
            {sellData && (
              <Gates data={sellData.readiness} automated={sellData.health.find((item) => item.id === "evals")?.headline} />
            )}
            {needsDashboard((d) => (
              <GoLiveChecklist data={d} />
            ))}
          </>,
        )}
        {panel("clients", needsDashboard((d) => <ClientsTable data={d} />))}
        {panel(
          "economics",
          needsDashboard((d) => (
            <>
              <UsageAndEconomics data={d} sell={sell} />
              <EconomicsByBasis data={d} />
            </>
          )),
        )}
        {panel("health", needsDashboard((d) => <Health data={d} sell={sell} />))}
      </DashboardRetryProvider>

      {/* L10 (29 Sep 2026): no "Updated just now · Sources: ..." line in the reading path. The foot shows
          only when the read is stale or missing; the sources sit on hover. */}
      {foot && (
        <PageFoot
          collapsible={false}
          title="Sources: the Retell calls, flags and go-live gates (/__receptionist), and the MU-Receptionist agency feed."
        >
          <span className="text-warn">{foot}</span>
        </PageFoot>
      )}
    </div>
  );
}

/**
 * ONE agency-feed state for the page (RX-1): the sell status and the dashboard read the feed
 * separately (full vs metadata view), so when the two reads disagree the page says so, with each
 * read's time, instead of showing two different feed errors as if both were current.
 */
function FeedReadNotice({ dashboard, sell }: { dashboard: DashboardViewModel | undefined; sell: SellSource }) {
  const agreement = feedReadAgreement(dashboard?.feedRead, sell.data);
  if (!agreement || agreement.agree) return null;
  return (
    <Notice tone="warn" title="The two agency-feed reads on this page disagree" className="mb-6 rounded-2xl">
      {agreement.lines.join(" · ")}. Refresh re-reads both.
    </Notice>
  );
}

function LoadingShape() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading receptionist dashboard">
      <Skeleton className="h-16 w-full rounded-2xl animate-none" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl animate-none" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-2xl animate-none" />
    </div>
  );
}

/** Channel health, the counts and every open exception (the old overview block), plus the agent line. */
function Health({ data, sell }: { data: DashboardViewModel; sell: SellSource }) {
  const agentHref = "https://dashboard.retellai.com/";
  return (
    <>
      <Overview data={data} exceptions={mergeSellExceptions({ items: data.exceptions, summary: data.exceptionSummary }, sell)} />
      {data.agentReadiness.ok && (
        <p className="text-sm text-muted-foreground">
          Agent{" "}
          {data.agentReadiness.published ? `published v${data.agentReadiness.version ?? "?"}` : `draft v${data.agentReadiness.version ?? "?"}`}
          {" · "}
          {data.agentReadiness.agentEditNote}
          {" · "}
          <a href={agentHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
            Open in Retell <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </p>
      )}
    </>
  );
}
