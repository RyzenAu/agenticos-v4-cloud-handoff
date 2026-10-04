// R12 Departments: one department (its agents and what they are for, the work queue, hand-offs in and out, saved results, and the
// way into an agent's conversation), and the index of all six. Layout: R12-UI-SYSTEM.md "Department layout".
import { useMemo, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bot as BotIcon } from "lucide-react";
import { Button, DataTable, EmptyState, PageHeader, Section, Skeleton, WorkList, WorkRow, fmtRelative, type Column } from "@/components/ds";
import { workspaceHref } from "@/components/agents/workspace/bots";
import { DEPARTMENTS, DEPARTMENT_BY_ID, isAttention, isOpenWork, journeyTouches, type DeptTask, type DepartmentId } from "@/lib/departments";
import { cn } from "@/lib/utils";
import { Handoff, JourneySteps, WorkStatus, botName, taskMeta } from "./parts";
import { TaskDrawer } from "./task-drawer";
import { useDepartments, type DeptBot, type DepartmentsModel } from "./use-departments";

/** How many ended tasks the queue keeps under the open ones (the rest are on the agent's Tasks & Files tab). */
export const ENDED_SHOWN = 8;

/** Pure: the queue order. Needs-you first, then running and queued, then the most recent ended work. */
export function queueOrder(tasks: readonly DeptTask[]): DeptTask[] {
  const rank = (t: DeptTask) => (t.state === "needs-you" ? 0 : t.state === "working" ? 1 : t.state === "queued" ? 2 : 3);
  const open = tasks.filter((t) => isOpenWork(t.state)).sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const ended = tasks.filter((t) => !isOpenWork(t.state)).sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0)).slice(0, ENDED_SHOWN);
  return [...open, ...ended];
}

function DepartmentNav({ current }: { current: DepartmentId | null }) {
  return (
    <nav aria-label="Departments" className="-mx-1 mb-5 overflow-x-auto px-1 pb-1">
      <ul className="flex w-max gap-1.5">
        <li>
          <Link to="/departments" className={cn("ds-interactive inline-flex min-h-10 items-center rounded-full px-3.5 text-sm", current === null ? "bg-brand-soft font-medium text-foreground" : "text-muted-foreground hover:bg-surface-raised hover:text-foreground")} aria-current={current === null ? "page" : undefined}>
            All
          </Link>
        </li>
        {DEPARTMENTS.map((d) => (
          <li key={d.id}>
            <Link to="/departments/$dept" params={{ dept: d.id }} className={cn("ds-interactive inline-flex min-h-10 items-center whitespace-nowrap rounded-full px-3.5 text-sm", current === d.id ? "bg-brand-soft font-medium text-foreground" : "text-muted-foreground hover:bg-surface-raised hover:text-foreground")} aria-current={current === d.id ? "page" : undefined}>
              {d.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Loading() {
  return (
    <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading departments">
      <Skeleton className="h-14 rounded-2xl" />
      <Skeleton className="h-40 rounded-2xl" />
    </div>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return <EmptyState title="Departments can't list their work" body={reason} action={<Button asChild variant="outline"><Link to="/agents/workspace">Open Agents</Link></Button>} />;
}

/** "2 running · 1 needs you" for a set of tasks; null when nothing is open. */
export function openSummary(tasks: readonly DeptTask[]): string | null {
  const n = (s: DeptTask["state"]) => tasks.filter((t) => t.state === s).length;
  const parts = [n("needs-you") ? `${n("needs-you")} need${n("needs-you") === 1 ? "s" : ""} you` : null, n("working") ? `${n("working")} running` : null, n("queued") ? `${n("queued")} queued` : null, n("failed") ? `${n("failed")} failed` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// ------------------------------------------------------------------ index

type Row = { id: DepartmentId; name: string; purpose: string; agents: DeptBot[]; tasks: DeptTask[]; results: number };

export function DepartmentsIndex() {
  const m = useDepartments();
  const navigate = useNavigate();
  const rows: Row[] = useMemo(() => (m.status === "ok" ? DEPARTMENTS.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose, agents: m.bots.filter((b) => b.department === d.id), tasks: m.tasks.filter((t) => t.department === d.id), results: m.results.filter((r) => r.department === d.id).length })) : []), [m]);
  const columns: Column<Row>[] = [
    { key: "name", header: "Department", cell: (r) => <span className="block"><span className="block font-medium text-foreground">{r.name}</span><span className="block text-xs text-muted-foreground">{r.purpose}</span></span> },
    { key: "agents", header: "Agents", cell: (r) => (r.agents.length ? r.agents.map((a) => a.name).join(", ") : <span className="text-muted-foreground">None yet</span>), width: "22%", hideBelow: "lg" },
    { key: "work", header: "Open work", cell: (r) => openSummary(r.tasks) ?? <span className="text-muted-foreground">Nothing open</span>, width: "28%" },
    { key: "results", header: "Results", cell: (r) => r.results || <span className="text-muted-foreground">0</span>, align: "right", width: "7rem" },
  ];
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]" data-departments-index="">
      <PageHeader title="Departments" spacing="tight" primaryAction={<Button asChild variant="accent"><Link to="/jarvis">Ask Jarvis</Link></Button>} />
      <DepartmentNav current={null} />
      {m.status === "loading" ? <Loading /> : m.status === "unavailable" ? <Unavailable reason={m.reason} /> : (
        <>
          <DataTable caption="Departments" columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => void navigate({ to: "/departments/$dept", params: { dept: r.id } })} rowLabel={(r) => `Open ${r.name}`} />
          <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-2">
            <Section title="Hand-offs between departments" className="mb-0">
              {m.handoffs.length ? (
                <ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">{m.handoffs.slice(0, 6).map((h) => <Handoff key={h.id} h={h} bots={m.bots} />)}</ul>
              ) : (
                <EmptyState variant="row" title="No hand-offs yet" body="When one department's finished work feeds another's, it shows here." />
              )}
            </Section>
            {m.journeys.length > 0 && (
              <Section title="Journeys" className="mb-0">
                <div className="flex flex-col gap-3">{m.journeys.slice(0, 3).map((j) => <JourneySteps key={j.id} journey={j} bots={m.bots} compact />)}</div>
              </Section>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one department

function AsideBlock({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground">
        {title}
        {count ? <span className="text-xs font-normal text-muted-foreground">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function DepartmentPage({ dept, taskId, onTask }: { dept: DepartmentId; taskId: string | null; onTask: (id: string | null) => void }) {
  const m = useDepartments();
  return <DepartmentView dept={dept} m={m} taskId={taskId} onTask={onTask} />;
}

export function DepartmentView({ dept, m, taskId, onTask }: { dept: DepartmentId; m: DepartmentsModel; taskId: string | null; onTask: (id: string | null) => void }) {
  const d = DEPARTMENT_BY_ID[dept];
  const ok = m.status === "ok" ? m : null;
  const bots = ok ? ok.bots.filter((b) => b.department === dept) : [];
  const tasks = ok ? ok.tasks.filter((t) => t.department === dept) : [];
  const queue = queueOrder(tasks);
  const attention = tasks.filter((t) => isAttention(t.state));
  const results = ok ? ok.results.filter((r) => r.department === dept) : [];
  const handIn = ok ? ok.handoffs.filter((h) => h.to.department === dept) : [];
  const handOut = ok ? ok.handoffs.filter((h) => h.from.department === dept) : [];
  const journeys = ok ? ok.journeys.filter((j) => journeyTouches(j, dept)) : [];
  const lead = bots[0] ?? null;
  const chat = lead ? workspaceHref(lead.id, "chat") : null;
  const selected = ok ? (ok.tasks.find((t) => t.id === taskId) ?? null) : null;
  const allBots = ok?.bots ?? [];
  const columns: Column<DeptTask>[] = [
    { key: "title", header: "Task", cell: (t) => <span className="font-medium text-foreground" data-dept-task-title="">{t.title}</span> },
    { key: "state", header: "State", cell: (t) => <WorkStatus state={t.state} />, width: "9.5rem" },
    { key: "owner", header: "Owner", cell: (t) => botName(allBots, t.botId), width: "8rem", hideBelow: "md" },
    { key: "when", header: "Updated", cell: (t) => fmtRelative(t.endedAt ?? t.startedAt), width: "7.5rem", align: "right" },
  ];
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]" data-department={dept}>
      <PageHeader
        title={d.name}
        description={d.purpose}
        spacing="tight"
        actions={d.records ? <Button asChild variant="outline"><Link to={d.records.to as never}>{d.records.label}</Link></Button> : undefined}
        primaryAction={
          chat && lead ? (
            <Button asChild variant="accent"><Link to={chat.to as never} params={chat.params as never} search={chat.search as never}>Assign work to {lead.name}</Link></Button>
          ) : (
            <Button asChild variant="accent"><Link to="/agents/workspace">Add an agent</Link></Button>
          )
        }
      />
      <DepartmentNav current={dept} />
      {m.status === "loading" ? <Loading /> : m.status === "unavailable" ? <Unavailable reason={m.reason} /> : (
        <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex min-w-0 flex-col gap-8">
            {attention.length > 0 && (
              <section aria-label="Needs attention" className="min-w-0">
                <h2 className="mb-2 text-sm font-semibold text-foreground">Needs attention</h2>
                <WorkList label="Needs attention">
                  {attention.map((t) => (
                    <WorkRow key={t.id} data-dept-task={t.id} title={t.title} meta={t.blocker ? `${botName(allBots, t.botId)} · ${t.blocker}` : taskMeta(t, allBots)} status={<WorkStatus state={t.state} />} onClick={() => onTask(t.id)} selected={taskId === t.id} />
                  ))}
                </WorkList>
              </section>
            )}
            <section aria-label="Work queue" className="min-w-0">
              <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground">
                Work queue <span className="text-xs font-normal text-muted-foreground">{openSummary(tasks) ?? "Nothing open"}</span>
              </h2>
              <DataTable
                caption={`${d.name} work queue`}
                columns={columns}
                rows={queue}
                rowKey={(t) => t.id}
                onRowClick={(t) => onTask(t.id)}
                rowLabel={(t) => `Open task: ${t.title}`}
                selectedKey={taskId}
                data-testid="dept-queue"
                empty={<EmptyState variant="row" title="No work yet" body={lead ? `Ask ${lead.name} for something and it shows here.` : "Add an agent to this department first."} />}
              />
              {ok && ok.unreadable.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Couldn't read the work of {ok.unreadable.join(", ")}, so it is missing here.</p>}
            </section>
            {journeys.length > 0 && (
              <section aria-label="Journeys" className="min-w-0">
                <h2 className="mb-2 text-sm font-semibold text-foreground">Journeys this department is part of</h2>
                <div className="flex flex-col gap-3">{journeys.map((j) => <JourneySteps key={j.id} journey={j} bots={allBots} />)}</div>
              </section>
            )}
            <section aria-label="Saved results" className="min-w-0">
              <h2 className="mb-2 text-sm font-semibold text-foreground">Saved results</h2>
              {results.length ? (
                <WorkList label="Saved results">
                  {results.slice(0, 8).map((r) => (
                    <WorkRow key={r.id} title={r.title} meta={[botName(allBots, r.botId), r.createdAt ? fmtRelative(r.createdAt) : null, r.summary].filter(Boolean).join(" · ")} href={r.href} />
                  ))}
                </WorkList>
              ) : (
                <EmptyState variant="row" title="No saved results yet" body="Finished work that keeps a report or a file shows here." />
              )}
            </section>
          </div>
          <aside className="flex min-w-0 flex-col gap-8" aria-label={`${d.name}: agents and hand-offs`}>
            <AsideBlock title="Agents" count={bots.length}>
              {bots.length ? (
                <WorkList label="Agents">
                  {bots.map((b) => {
                    const h = workspaceHref(b.id, "chat");
                    return (
                      <WorkRow key={b.id} data-dept-agent={b.id} title={<span className="inline-flex items-center gap-2"><BotIcon aria-hidden="true" className="size-4 text-muted-foreground" />{b.name}</span>} meta={b.purpose || "No responsibility written yet"} to={h.to} params={h.params} search={h.search}>
                        <span className="mt-1 block text-xs font-medium text-foreground">Open conversation</span>
                      </WorkRow>
                    );
                  })}
                </WorkList>
              ) : (
                <EmptyState variant="row" title="No agent here yet" body="Add one in Agents; name it for this department's work." action={<Button asChild variant="outline" size="sm"><Link to="/agents/workspace">Open Agents</Link></Button>} />
              )}
            </AsideBlock>
            <AsideBlock title="Hand-offs in" count={handIn.length}>
              {handIn.length ? <ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">{handIn.map((h) => <Handoff key={h.id} h={h} bots={allBots} onOpenTask={(id) => onTask(id)} />)}</ul> : <p className="text-sm text-muted-foreground">Nothing handed in.</p>}
            </AsideBlock>
            <AsideBlock title="Hand-offs out" count={handOut.length}>
              {handOut.length ? <ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">{handOut.map((h) => <Handoff key={h.id} h={h} bots={allBots} />)}</ul> : <p className="text-sm text-muted-foreground">Nothing handed on.</p>}
            </AsideBlock>
            {ok && !ok.journeysOnHub && (handIn.length > 0 || handOut.length > 0) && (
              <p className="text-xs text-muted-foreground">This hub doesn't record hand-offs yet; the ones above are inferred from jobs about the same client record.</p>
            )}
          </aside>
        </div>
      )}
      <TaskDrawer task={selected} bots={allBots} handoffs={ok?.handoffs ?? []} onClose={() => onTask(null)} />
    </div>
  );
}
