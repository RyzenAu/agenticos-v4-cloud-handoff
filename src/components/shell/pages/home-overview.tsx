// R12 Home (owner: "what needs our attention, active work and useful results; nothing else above the fold").
//
// Three sections, each ONE hairline list of work rows (src/components/ds/work-row.tsx):
//   1. Needs your attention: owner decisions (open in a drawer with their Record decision control), agent work that needs you or
//      failed, journey steps waiting on you, and the exceptions Today already computes (a site down, a late enquiry, a stale routine).
//   2. Active work: journeys in flight and every department's running and queued tasks.
//   3. Recent results: the saved results the departments produced.
// The business signals (calls, receptionist, sites, email, pipeline, enquiries) follow below the fold in one compact grid, then the
// brief, quick actions and the folded detail. Nothing was removed from Home; it was put in order.
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button, DetailDrawer, EmptyState, Skeleton, StatusLabel, WorkList, WorkRow, fmtRelative } from "@/components/ds";
import { refreshPanels, type Approval } from "@/components/workspace/api";
import { DecisionRow, PendingBrowserNote, plainSettingNames } from "@/components/workspace/decision-row";
import { SpeedToLeadPanel } from "@/components/workspace/speed-to-lead-panel";
import { CallingWindow } from "@/components/workspace/today-panel";
import { useDepartments } from "@/components/departments/use-departments";
import { WorkStatus, botName, taskMeta } from "@/components/departments/parts";
import { JOURNEY_TASK_STATE, isAttention, journeyNow, type DeptTask } from "@/lib/departments";
import { fmtProse } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SignalTile } from "../page-parts";
import { valueOf } from "../today-facts";
import type { TodayModel } from "./today-page";

/** How many rows each Home list shows before "N more". */
export const HOME_ROWS = { attention: 4, active: 5, results: 4 } as const;

function Heading({ id, title, count, action }: { id: string; title: string; count?: number | null; action?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
      <h2 id={id} className="flex items-baseline gap-2 text-base font-semibold text-foreground">
        {title}
        {count ? <span className="text-sm font-normal text-muted-foreground">{count}</span> : null}
      </h2>
      {action}
    </div>
  );
}

function More({ to, children, hash }: { to: string; hash?: string; children: ReactNode }) {
  return (
    <Link to={to as never} hash={hash} className="inline-flex min-h-10 items-center px-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
      {children}
    </Link>
  );
}

const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();

export function HomeOverview({ m }: { m: TodayModel }) {
  const d = useDepartments();
  const [decision, setDecision] = useState<Approval | null>(null);
  const ok = d.status === "ok" ? d : null;
  const bots = ok?.bots ?? [];

  // 1. attention
  const agentAttention: DeptTask[] = ok ? ok.tasks.filter((t) => isAttention(t.state)) : [];
  const waitingSteps = ok ? ok.journeys.flatMap((j) => j.steps.filter((s) => s.state === "waiting" || s.state === "failed").map((s) => ({ j, s }))) : [];
  const decisions = m.approvals.slice(0, 3);
  const attentionCount = m.approvals.length + agentAttention.length + waitingSteps.length + m.exceptions.length;
  const decisionsLoading = m.q.today.isLoading;
  const decisionsUnread = !decisionsLoading && !valueOf(m.q.today);

  // 2. active
  const journeysActive = ok ? ok.journeys.filter((j) => j.state === "running" || j.state === "queued") : [];
  const active = ok ? ok.tasks.filter((t) => t.state === "working" || t.state === "queued") : [];

  // 3. results
  const results = ok?.results ?? [];

  return (
    <div className="min-w-0 [overflow-wrap:anywhere]" data-home-overview="">
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <section aria-labelledby="home-attention" className="min-w-0" data-home-section="attention">
          <Heading
            id="home-attention"
            title="Needs your attention"
            count={m.loading ? null : attentionCount}
            action={
              <button
                type="button"
                className="ds-interactive grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:opacity-60"
                disabled={m.refreshing}
                onClick={() => void refreshPanels(m.client)}
                aria-label={m.refreshing ? "Refreshing" : "Refresh"}
                title={m.refreshing ? "Refreshing" : "Refresh"}
              >
                <RefreshCw className={cn("size-4", m.refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
              </button>
            }
          />
          {decisionsLoading && m.loading ? (
            <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading what needs you">
              <Skeleton className="h-14 rounded-2xl" />
              <Skeleton className="h-14 rounded-2xl" />
            </div>
          ) : attentionCount === 0 && !decisionsUnread ? (
            <EmptyState variant="row" title={m.failedNames.length ? "Nothing waiting that could be read" : "Nothing needs you"} body={m.failedNames.length ? `Couldn't read ${m.failedNames.join(", ")}. Refresh to check.` : "Decisions, agent questions, failures and late enquiries show here."} />
          ) : (
            <>
            {decisions.length > 0 && <PendingBrowserNote />}
            <WorkList label="Needs your attention" className="mt-1">
              {decisionsUnread && <WorkRow title="Owner decisions couldn't be read" meta="The approvals list didn't answer. Refresh, or open Work." status={<StatusLabel state="unknown" label="Unknown" size="sm" />} to="/work" />}
              {decisions.map((a) => (
                <WorkRow key={a.id} data-home-decision={a.id} title={plainSettingNames(fmtProse(a.title)).plain} meta={`Decision · ${firstSentence(plainSettingNames(fmtProse(a.detail)).plain)}`} status={<StatusLabel state="needs-you" label="Decide" size="sm" />} onClick={() => setDecision(a)} selected={decision?.id === a.id} />
              ))}
              {waitingSteps.map(({ j, s }) => (
                <WorkRow key={`${j.id}:${s.id}`} title={`${s.title}: ${j.title}`} meta={s.failure ? s.failure.reason : (s.waitingFor?.question ?? "Waiting for you")} status={<WorkStatus state={JOURNEY_TASK_STATE[s.state]} />} to="/jarvis" />
              ))}
              {agentAttention.slice(0, HOME_ROWS.attention).map((t) => (
                <WorkRow key={t.id} data-home-task={t.id} title={t.title} meta={t.blocker ? `${botName(bots, t.botId)} · ${t.blocker}` : taskMeta(t, bots, true)} status={<WorkStatus state={t.state} />} to="/departments/$dept" params={{ dept: t.department }} search={{ task: t.id }} />
              ))}
              {m.exceptions.map((e) => (
                <WorkRow key={e.id} title={e.text} meta={e.action ?? undefined} status={<StatusLabel state={e.tone === "danger" ? "failed" : e.tone === "warn" ? "blocked" : "idle"} label={e.tone === "danger" ? "Urgent" : e.tone === "warn" ? "Check" : "Note"} size="sm" />} {...(e.to?.startsWith("/") ? { to: e.to } : e.to ? { href: e.to } : {})} />
              ))}
            </WorkList>
            </>
          )}
          <div className="mt-1 flex flex-wrap gap-x-4">
            {m.approvals.length > decisions.length && <More to="/work" hash="ws-today">{m.approvals.length - decisions.length} more decisions in Work</More>}
            {agentAttention.length > HOME_ROWS.attention && <More to="/departments">{agentAttention.length - HOME_ROWS.attention} more in Departments</More>}
            <More to="/inbox">Inbox{m.q.needsYou.data?.ok && m.q.needsYou.data.data.parts.email.count !== null ? ` (${m.q.needsYou.data.data.parts.email.count})` : ""}</More>
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-8">
          <section aria-labelledby="home-active" className="min-w-0" data-home-section="active">
            <Heading id="home-active" title="Active work" count={journeysActive.length + active.length || null} action={<More to="/departments">Departments</More>} />
            {d.status === "loading" ? (
              <Skeleton className="h-14 rounded-2xl" />
            ) : d.status === "unavailable" ? (
              <EmptyState variant="row" title={m.running.length ? m.running[0].title : "Agent work can't be listed"} body={m.running.length ? `${m.running[0].agent} · from ${m.running[0].source}` : d.reason} />
            ) : journeysActive.length + active.length === 0 ? (
              <EmptyState variant="row" title="Nothing running" body="Ask Jarvis for something and it shows here while it runs." />
            ) : (
              <WorkList label="Active work">
                {journeysActive.map((j) => {
                  const now = journeyNow(j);
                  return <WorkRow key={j.id} data-home-journey={j.id} title={j.title} meta={now.line} status={<WorkStatus state={JOURNEY_TASK_STATE[j.state]} />} to={now.step && now.step.owner.department !== "jarvis" ? "/departments/$dept" : "/jarvis"} params={now.step && now.step.owner.department !== "jarvis" ? { dept: now.step.owner.department } : undefined} />;
                })}
                {active.slice(0, HOME_ROWS.active).map((t) => (
                  <WorkRow key={t.id} data-home-task={t.id} title={t.title} meta={taskMeta(t, bots, true)} status={<WorkStatus state={t.state} />} to="/departments/$dept" params={{ dept: t.department }} search={{ task: t.id }} />
                ))}
              </WorkList>
            )}
            {active.length > HOME_ROWS.active && <More to="/departments">{active.length - HOME_ROWS.active} more running or queued</More>}
          </section>

          <section aria-labelledby="home-results" className="min-w-0" data-home-section="results">
            <Heading id="home-results" title="Recent results" />
            {d.status === "loading" ? (
              <Skeleton className="h-14 rounded-2xl" />
            ) : results.length === 0 ? (
              <EmptyState variant="row" title="No saved results yet" body="Reports and files the agents keep show here." />
            ) : (
              <WorkList label="Recent results">
                {results.slice(0, HOME_ROWS.results).map((r) => (
                  <WorkRow key={r.id} title={r.title} meta={[botName(bots, r.botId), r.createdAt ? fmtRelative(r.createdAt) : null].filter(Boolean).join(" · ")} href={r.href} />
                ))}
              </WorkList>
            )}
          </section>
        </div>
      </div>

      <DetailDrawer open={!!decision} onOpenChange={(o) => !o && setDecision(null)} title={decision ? plainSettingNames(fmtProse(decision.title)).plain : ""} status={<StatusLabel state="needs-you" label="Your decision" />}>
        {decision && (
          <ul className="-mx-4">
            <DecisionRow item={decision} />
          </ul>
        )}
      </DetailDrawer>
    </div>
  );
}

/** Below the fold: the business signals Today reads, as one compact grid (each tile keeps its own action and honest state). */
export function HomeSignals({ m }: { m: TodayModel }) {
  const { q, tiles, now, retry, enquiries, enquirySummary, pipeline, pipelineLine } = m;
  return (
    <section aria-labelledby="home-signals" className="mb-10 mt-10 min-w-0" data-home-section="signals">
      <h2 id="home-signals" className="mb-3 text-base font-semibold text-foreground">Business signals</h2>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
                hint={t.key === "callQueue" && now ? <>{t.hint}<span className="mt-1.5 block"><CallingWindow now={now} /></span></> : t.hint}
                updatedAt={t.updatedAt}
                now={now}
                to={t.to}
                search={t.search}
                recovery={t.recovery ? (t.recovery.kind === "link" ? { label: t.recovery.label, to: t.recovery.to } : { label: t.recovery.label, onClick: () => retry(t.key) }) : undefined}
              />
            </div>
          ))}
        <div className="calm-tile min-w-0" data-today-tile="pipeline">
          <SignalTile quiet label="Pipeline" loading={q.pipeline.isLoading} value={pipeline ? pipeline.open : null} state={pipeline ? "live" : q.pipeline.isLoading ? undefined : "failed"} hint={pipelineLine} to="/leads" recovery={!pipeline && !q.pipeline.isLoading ? { label: "Retry", onClick: () => retry("pipeline") } : undefined} />
        </div>
        <div className="calm-tile min-w-0" data-today-tile="enquiries">
          <SignalTile quiet label="Enquiries" loading={q.enquiries.isLoading} value={enquiries ? enquiries.openCount : null} state={enquiries ? "live" : q.enquiries.isLoading ? undefined : "failed"} tone={enquiries?.overdueCount ? "danger" : undefined} hint={enquirySummary} to="/leads" recovery={!enquiries && !q.enquiries.isLoading ? { label: "Retry", onClick: () => retry("enquiries") } : undefined} />
        </div>
      </div>
      {enquiries && enquiries.items.length > 0 && (
        <div className="mt-4 rounded-2xl border border-border bg-card p-4">
          <SpeedToLeadPanel panel={enquiries} />
        </div>
      )}
    </section>
  );
}

export function HomeAskJarvis() {
  return (
    <Button asChild variant="accent">
      <Link to="/jarvis">Ask Jarvis</Link>
    </Button>
  );
}
