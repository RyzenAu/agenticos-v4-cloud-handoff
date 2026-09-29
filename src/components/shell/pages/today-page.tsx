// Today's parts of the Home page (29 Sep 2026: Today merged INTO the Business brief, the landing page).
// useToday reads the Workspace panel sources (each its own small GET, so a slow one, like the site
// checks, never holds up the rest), the live agent feed and the calling window. TodayFocus and
// TodaySources render them. Read-only: every row opens the page where you act.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, AudioLines, ChevronRight, Database, Inbox, ListChecks, RefreshCw, Users } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Skeleton, StatusDot, Widget, WidgetEmpty, WidgetGrid } from "@/components/ds";
import { CalmSection, Pill } from "@/components/calm/calm";
import { refreshPanels, useWorkspacePanel, type PanelResult } from "@/components/workspace/api";
import { SpeedToLeadPanel } from "@/components/workspace/speed-to-lead-panel";
import { useNow } from "@/components/workspace/panel-shell";
import { CallingWindow } from "@/components/workspace/today-panel";
import { FEED_STATUS_LABEL, feedStatus, readFeed, subscribeFeed, type FeedTask } from "@/lib/agent-feed";
import { mergeRunning, runningFromFeed, RUNNING_SOURCES, type RunningItem } from "@/lib/running-now";
import { pendingUntilHydrated, useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";
import { useInspector, useInspectorFacts } from "../inspector";
import { openJarvis } from "../jarvis-slot";
import { Freshness, SignalTile, type Exception } from "../page-parts";
import { PANEL_LABEL, PANEL_SOURCE, TODAY_KEYS, focusLine, todayFacts, todayTiles, valueOf, type TodayKey } from "../today-facts";
import { NEEDS_YOU_LIST_SHOWN } from "../../../../scripts/workspace/needs-you";
import { fmtTime } from "@/lib/format";

function oldest(results: (PanelResult<unknown> | undefined)[]) {
  const times = results.filter(Boolean).map((r) => Date.parse(r!.updatedAt)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

function useFeed() {
  const [tasks, setTasks] = useState<FeedTask[]>([]);
  useEffect(() => {
    setTasks(readFeed());
    return subscribeFeed(setTasks);
  }, []);
  return tasks;
}

const STATUS_CLASS = { running: "text-muted-foreground", "needs-you": "text-warn", done: "text-success", failed: "text-danger" } as const;
const RUNNING_BADGE = { running: "Running", queued: "Queued", "needs-you": "Needs your answer" } as const;

/**
 * What's running on the server (UI-truth M8), through RUNNING_SOURCES adapters (agent jobs today;
 * the Stage B2 jobs service plugs in the same way). A source that can't be read is unknown, never
 * "nothing running".
 */
function useServerRunning() {
  return useQuery<{ items: RunningItem[]; failed: string[] }>({
    queryKey: ["today", "running-now"],
    queryFn: async () => {
      const results = await Promise.all(
        RUNNING_SOURCES.map(async (source) => {
          try {
            const res = await fetch(source.path, { cache: "no-store", headers: { Accept: "application/json" } });
            if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) throw new Error(`HTTP ${res.status}`);
            return { items: source.parse(await res.json()), failed: null };
          } catch {
            return { items: [] as RunningItem[], failed: source.label };
          }
        }),
      );
      return { items: results.flatMap((r) => r.items), failed: results.map((r) => r.failed).filter((f): f is string => !!f) };
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Today's model (29 Sep 2026, owner: Today merges INTO the Business brief, the home page). Every
 * source, fact and honest state the old /today page read, for TodayFocus and TodaySources.
 */
export function useToday() {
  const now = useNow(30_000);
  const client = useQueryClient();
  // Until hydration every source reads as loading, exactly as the server rendered it (merge review
  // U1): the sidebar may already have filled the needs-you cache, and a first client render that used
  // it would not match the server's skeleton.
  const hydrated = useHydrated();
  const live = {
    needsYou: useWorkspacePanel("needsYou"),
    today: useWorkspacePanel("today"),
    callQueue: useWorkspacePanel("callQueue"),
    receptionist: useWorkspacePanel("receptionist"),
    websites: useWorkspacePanel("websites"),
    email: useWorkspacePanel("email"),
    pipeline: useWorkspacePanel("pipeline"),
    enquiries: useWorkspacePanel("enquiries"),
  };
  const q = Object.fromEntries(Object.entries(live).map(([k, v]) => [k, pendingUntilHydrated(v, hydrated)])) as typeof live;
  const tasks = useFeed();
  const { publish } = useInspector();
  const loading = TODAY_KEYS.every((k) => q[k].isLoading);
  const checking = TODAY_KEYS.filter((k) => q[k].isLoading).map((k) => PANEL_LABEL[k]);
  const pipeline = valueOf(q.pipeline);
  const enquiries = valueOf(q.enquiries);
  const facts = todayFacts(q);
  const tiles = todayTiles(q, facts, now);
  const { approvals, exceptions, failed } = facts;
  // Retry and Refresh read the source again, never the server's recent read.
  const retry = (k: TodayKey) => void refreshPanels(client, k === "needsYou" || k === "today" || k === "email" ? [k, "needsYou"] : [k]);

  // Error detail goes to the Inspector, one entry per source (keyed, so remounts and refetches
  // update it instead of stacking copies); a source that answers again replaces its warning.
  const reported = useRef(new Set<TodayKey>());
  useEffect(() => {
    for (const k of TODAY_KEYS) {
      const r = q[k].data;
      const key = `today:source:${k}`;
      if (failed.includes(k)) {
        reported.current.add(k);
        const detail = r && !r.ok ? `${r.error} (${r.ms} ms${r.timedOut ? ", timed out" : ""})` : ((q[k].error as Error | null)?.message ?? "Request failed");
        publish({ key, title: `${PANEL_LABEL[k]} source failed`, detail, tone: "warn", source: "Today" });
      } else if (reported.current.has(k) && r?.ok) {
        reported.current.delete(k);
        publish({ key, title: `${PANEL_LABEL[k]} source answered again`, tone: "neutral", source: "Today" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed.join(), publish]);
  useInspectorFacts(
    "Today sources",
    loading
      ? null
      : Object.fromEntries(TODAY_KEYS.map((k) => {
          const r = q[k].data;
          return [
            PANEL_LABEL[k],
            r
              ? `${r.ok ? (r.stale ? "stale (refresh failed)" : "ok") : "failed"} · ${r.ms} ms${r.ok && r.reused ? " (reused read)" : ""} · ${fmtTime(new Date(r.updatedAt))}`
              : q[k].isError
                ? "request failed"
                : "not loaded",
          ];
        })),
  );

  const serverRunning = pendingUntilHydrated(useServerRunning(), hydrated);
  const running = mergeRunning(serverRunning.data?.items ?? [], runningFromFeed(tasks));
  const runningUnknown = serverRunning.isLoading ? "checking" : serverRunning.data?.failed.length ? serverRunning.data.failed.join(", ") : null;
  const recent = tasks.filter((t) => t.endedAt).slice(0, 3);
  const updated = oldest(Object.values(q).map((x) => x.data));
  const refreshing = Object.values(q).some((x) => x.isFetching);
  // Failed sources are shown once, on their own tile or section; the exception list only counts them.
  const failedNames = failed.map((k) => PANEL_LABEL[k].toLowerCase());

  const tileByKey = Object.fromEntries(tiles.map((t) => [t.key, t])) as Record<TodayKey, (typeof tiles)[number]>;
  const focus = focusLine(tileByKey, exceptions.length, loading);
  const firstStep = approvals[0] ?? null;
  // Open = not closed, excluded or merged (UI-truth H3); `total` is every CRM record.
  const pipelineLine = pipeline
    ? [
        pipeline.followUps.overdue ? `${pipeline.followUps.overdue} follow-ups overdue` : null,
        pipeline.followUps.dueToday ? `${pipeline.followUps.dueToday} due today` : null,
        pipeline.demosBooked ? `${pipeline.demosBooked} ${pipeline.demosBooked === 1 ? "demo" : "demos"} booked` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "No open follow-ups"
    : q.pipeline.isLoading
      ? "Checking the CRM…"
      : "Couldn't read the CRM";
  const enquirySummary = enquiries
    ? enquiries.overdueCount
      ? `${enquiries.overdueCount} past the reply window`
      : enquiries.openCount
        ? `${enquiries.openCount} open, none late`
        : enquiries.watcherScheduled === false
          ? "Enquiries aren't being watched yet"
          : "No open enquiries"
    : q.enquiries.isLoading
      ? "Checking…"
      : "Couldn't read enquiries";

  // L1 (29 Sep 2026): the "Waiting on you" count and its honest breakdown head the Needs you widget;
  // the other four tiles are one row of the grid. A failed or unknown read keeps its word and retry.
  const needsTile = tileByKey.needsYou;
  const needsBadge = q.needsYou.isLoading ? "Checking" : needsTile.value ?? (needsTile.state === "failed" ? "Couldn't read" : "Unknown");
  const needsRetry = needsTile.state === "failed" || needsTile.state === "unknown";
  const startAction = firstStep ? (
    firstStep.href.startsWith("/") ? (
      <Button asChild variant="accent" className="h-auto min-h-10 max-w-full whitespace-normal rounded-full px-5 py-2 text-left">
        <Link to={firstStep.href as never}>
          Start: {firstStep.title}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </Button>
    ) : (
      <Button asChild variant="accent" className="h-auto min-h-10 max-w-full whitespace-normal rounded-full px-5 py-2 text-left">
        <a href={firstStep.href} target="_blank" rel="noreferrer">
          Start: {firstStep.title}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
      </Button>
    )
  ) : (
    <Button variant="accent" className="h-10 rounded-full px-5" onClick={openJarvis}>
      Talk to Jarvis
    </Button>
  );

  return { now, client, q, tiles, approvals, exceptions, loading, checking, retry, serverRunning, running, runningUnknown, recent, updated, refreshing, failedNames, focus, enquiries, enquirySummary, pipeline, pipelineLine, needsTile, needsBadge, needsRetry, startAction };
}
export type TodayModel = ReturnType<typeof useToday>;

/**
 * Today's useful parts on the home page: Needs you (top 3, one gold Start), Needs attention (one
 * line each), the four quick stats (actions inside), and one line each for running work and
 * enquiries. Owner, 29 Sep 2026: "merge Today into the Business brief … no fluff".
 */
export function TodayFocus({ m }: { m: TodayModel }) {
  const { client, q, tiles, approvals, exceptions, loading, checking, retry, serverRunning, running, runningUnknown, recent, refreshing, failedNames, enquiries, enquirySummary, pipeline, pipelineLine, needsTile, needsBadge, needsRetry, startAction, now } = m;
  return (
    <div className="calm-today mb-10 min-w-0 [overflow-wrap:anywhere]" data-today-focus="">
      <WidgetGrid>
        {/* 1. What needs you, with the action. */}
        <Widget
          id="today-needs-you"
          span={2}
          icon={ListChecks}
          title="Needs you"
          badge={needsBadge}
          line={<span data-needs-you-breakdown>{needsTile.hint}</span>}
          action={
            <>
              {startAction}
              {approvals.length > NEXT_SHOWN && (
                <Link to="/work" className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  {approvals.length - NEXT_SHOWN} more in Work
                </Link>
              )}
              {needsRetry && !q.needsYou.isLoading && (
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => retry("needsYou")}>
                  Retry
                </Button>
              )}
            </>
          }
        >
          {/* Approvals that couldn't be read are shown once: the badge above says so, with a retry. */}
          {q.today.isLoading ? (
            <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading next actions">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          ) : !valueOf(q.today) ? (
            <WidgetEmpty title="Owner decisions couldn't be read" body="The approvals list didn't answer. Retry, or open Work." />
          ) : approvals.length ? (
            <>
              <ol className="calm-rows" aria-label="Next actions">
                {approvals.slice(0, NEXT_SHOWN).map((a) => (
                  <ActionRow key={a.id} a={a} />
                ))}
              </ol>
            </>
          ) : (
            <WidgetEmpty title="No owner decisions waiting" body="Decisions appear here when a track needs your yes." />
          )}
        </Widget>

        <Widget
          id="today-attention"
          span={2}
          icon={AlertCircle}
          title="Needs attention"
          badge={loading ? undefined : exceptions.length || undefined}
          line={checking.length && !loading ? `Still checking ${checking.join(", ").toLowerCase()}.` : undefined}
          action={
            // Refresh (fresh) reads every Today source again, never the server's recent read.
            <Button variant="outline" className="h-10 rounded-full px-5" disabled={refreshing} onClick={() => void refreshPanels(client)}>
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
              {refreshing ? "Refreshing" : "Refresh"}
            </Button>
          }
        >
          {loading ? (
            <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading exceptions">
              <Skeleton className="h-14 rounded-xl" />
              <Skeleton className="h-14 rounded-xl" />
            </div>
          ) : exceptions.length ? (
            <CalmExceptionList items={exceptions} />
          ) : checking.length ? (
            <Skeleton className="h-14 rounded-xl" />
          ) : (
            <WidgetEmpty
              title={failedNames.length ? "Nothing on fire in the sources that answered" : "Nothing on fire"}
              body={
                failedNames.length
                  ? `Not vouched for: ${failedNames.join(", ")} couldn't be read.`
                  : "Urgent flags, sites down and late enquiries show here."
              }
            />
          )}
        </Widget>

        {/* 2. The four signals, one row: calls, receptionist, sites, email. */}
        {tiles
          .filter((t) => t.key !== "needsYou")
          .map((t) => (
            <div key={t.key} className="calm-tile min-w-0" data-today-tile={t.key}>
              <SignalTile
                quiet
                label={t.label}
                loading={q[t.key].isLoading}
                value={t.value}
                state={t.state}
                tone={t.tone}
                // The calling window (was in the header) lives with the calls it governs.
                hint={t.key === "callQueue" && now ? <>{t.hint}<span className="mt-1.5 block"><CallingWindow now={now} /></span></> : t.hint}
                updatedAt={t.updatedAt}
                now={now}
                to={t.to}
                recovery={t.recovery ? (t.recovery.kind === "link" ? { label: t.recovery.label, to: t.recovery.to } : { label: t.recovery.label, onClick: () => retry(t.key) }) : undefined}
              />
            </div>
          ))}

        {/* 3. One line each (owner, 29 Sep): what's running, the enquiry reply clock, and open leads. */}
        <Widget
          id="today-running"
          span={2}
          icon={AudioLines}
          title="Running now"
          badge={running.length > 1 ? running.length : undefined}
          action={
            runningUnknown && runningUnknown !== "checking" ? (
              <Button variant="outline" className="h-10 rounded-full px-5" onClick={() => void serverRunning.refetch()}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {running.length ? (
            <p className="truncate text-base font-medium text-foreground" title={running.map((r) => `${r.title} · ${r.agent} · ${r.source}`).join("\n")}>
              {running[0].title}
              {running[0].state !== "running" && <span className="text-warn"> · {RUNNING_BADGE[running[0].state]}</span>}
              <span className="font-normal text-muted-foreground"> · {running[0].agent}</span>
            </p>
          ) : runningUnknown === "checking" ? (
            <Skeleton className="h-6 w-40 rounded-lg" />
          ) : runningUnknown ? (
            <p className="truncate text-base font-medium text-foreground" title={`${runningUnknown} didn't answer.`}>Unknown: the server's job list couldn't be read</p>
          ) : (
            <p
              className="text-base font-medium text-foreground"
              title={`No agent jobs on the server${serverRunning.dataUpdatedAt ? ` (checked ${fmtTime(new Date(serverRunning.dataUpdatedAt))})` : ""} and no hand-offs in this tab.${recent.length ? ` Recent: ${recent.map((r) => `${r.title} (${FEED_STATUS_LABEL[feedStatus(r)]})`).join(", ")}.` : ""}`}
            >
              Nothing running
            </p>
          )}
        </Widget>

        <Widget
          id="today-enquiries"
          icon={Inbox}
          title="Enquiries"
          badge={enquiries?.openCount ? enquiries.openCount : undefined}
          action={
            !enquiries && !q.enquiries.isLoading ? (
              <Button variant="outline" className="h-10 rounded-full px-5" onClick={() => retry("enquiries")}>
                Retry
              </Button>
            ) : enquiries?.openCount ? (
              <Button asChild variant="outline" className="h-10 rounded-full px-5">
                <Link to="/leads">Open leads</Link>
              </Button>
            ) : undefined
          }
        >
          <p className={cn("text-base font-medium", enquiries?.overdueCount ? "text-danger" : "text-foreground")}>{enquirySummary}</p>
        </Widget>

        {/* One value, one line: open leads, and the follow-ups behind them (overdue calls are on "Calls to make"). */}
        <Widget
          id="today-pipeline"
          icon={Users}
          title="Pipeline"
          value={q.pipeline.isLoading ? "…" : pipeline ? pipeline.open : null}
          line={pipelineLine}
          lineTone={pipeline?.followUps.overdue ? "warn" : q.pipeline.isLoading || pipeline ? "muted" : "warn"}
          action={
            pipeline || q.pipeline.isLoading ? (
              <Button asChild variant="outline" className="h-10 rounded-full px-5">
                <Link to="/leads">Open leads</Link>
              </Button>
            ) : (
              <Button variant="outline" className="h-10 rounded-full px-5" onClick={() => retry("pipeline")}>
                Retry
              </Button>
            )
          }
        />

        {/* The reply clock's list, only when something is open. */}
        {enquiries && enquiries.items.length > 0 && (
          <Widget id="today-enquiry-list" span={4} icon={Inbox} title="Open enquiries" badge={enquiries.items.length}>
            <SpeedToLeadPanel panel={enquiries} />
          </Widget>
        )}
      </WidgetGrid>
    </div>
  );
}

/** The ONE "Where these numbers come from" fold at the foot of the home page. `children` adds the Business brief's own sources. */
export function TodaySources({ m, children }: { m: TodayModel; children?: ReactNode }) {
  const { q, now } = m;
  return (
      <CalmSection
        className="mb-10" title="Where these numbers come from" icon={Database} persistKey="today-sources">
        <ul className="calm-rows">
          {TODAY_KEYS.map((k) => {
            const r = q[k].data;
            const state = q[k].isLoading ? "Checking" : r ? (r.ok ? (r.stale ? "Stale" : "Live") : "Couldn't read") : q[k].isError ? "Couldn't read" : "Not loaded";
            return (
              <li key={k} className="calm-row items-start">
                <span className="min-w-0 flex-1">
                  <span className="calm-row-title">{PANEL_LABEL[k]}</span>
                  <span className="calm-row-detail">Source: {PANEL_SOURCE[k]}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Pill tone={state === "Live" ? "success" : state === "Couldn't read" ? "danger" : state === "Stale" ? "warn" : "neutral"}>{state}</Pill>
                  {r && now ? <Freshness at={r.updatedAt} now={now} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
        {children ? <div className="mt-4 border-t border-border pt-4">{children}</div> : null}
      </CalmSection>
  );
}

/** How many next actions show on the home page; the rest are in Work. */
const NEXT_SHOWN = NEEDS_YOU_LIST_SHOWN;

function ActionRow({ a }: { a: { id: string; title: string; detail: string; href: string; progress?: string | null } }) {
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="calm-row-title">{a.title}</span>
          {a.progress && <Badge className="max-w-full truncate" title={a.progress}>{a.progress}</Badge>}
        </span>
        <span className="calm-row-detail truncate" title={a.detail}>{a.detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </>
  );
  return (
    <li>
      {a.href.startsWith("/") ? (
        <Link to={a.href as never} className="calm-row">
          {inner}
        </Link>
      ) : (
        <a href={a.href} target="_blank" rel="noreferrer" className="calm-row">
          {inner}
        </a>
      )}
    </li>
  );
}

function CalmExceptionList({ items }: { items: Exception[] }) {
  return (
    <ul className="calm-rows">
      {items.map((e) => {
        const inner = (
          <>
            <StatusDot tone={e.tone} label={<span className="sr-only">{e.tone === "danger" ? "Urgent" : e.tone === "warn" ? "Needs attention" : "Note"}</span>} />
            <span className="calm-row-title min-w-0 flex-1 truncate" title={typeof e.text === "string" ? e.text : undefined}>{e.text}</span>
            {e.to && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-muted-foreground">
                {e.action ?? "Open"}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </span>
            )}
          </>
        );
        return (
          <li key={e.id}>
            {e.to ? (
              e.to.startsWith("/") ? (
                <Link to={e.to as never} className="calm-row">
                  {inner}
                </Link>
              ) : (
                <a href={e.to} target="_blank" rel="noreferrer" className="calm-row">
                  {inner}
                </a>
              )
            ) : (
              <div className="calm-row">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
