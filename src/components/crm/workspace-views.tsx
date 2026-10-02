import { useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  Circle,
  ClipboardList,
  Columns3,
  List,
  Plus,
} from "lucide-react";
import { Button, EmptyState, Section, Segmented, Surface } from "@/components/ds";
import type { CrmOperationInputMap, CrmOperationName } from "@/lib/crm-client";
import { Input } from "@/components/ui/input";
import type { CrmRef, CrmSnapshot, Deal, Pipeline, Task } from "../../../scripts/crm/types";
import { SALES_STAGES } from "../../../scripts/crm/types";
import { fmtDay, fmtDateTime, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NativeSelect, ownerName, ownerOptions } from "./controls";
import {
  isOpenTask,
  matchesSearch,
  pipelineTotals,
  stageForDeal,
  taskOrder,
  taskUrgency,
} from "./selectors";
import type { EditorTarget } from "./record-editor";
import { AutomationRules } from "./automation-rules";
export type WorkspaceActions = {
  edit: (target: EditorTarget) => void;
  open: (ref: CrmRef, tab?: "overview" | "timeline" | "deals" | "delivery") => void;
  run: <N extends CrmOperationName>(name: N, input: CrmOperationInputMap[N]) => Promise<void>;
  busy: boolean;
};
export const money = (cents: number) => fmtMoney(cents / 100, { currency: "AUD", trimZeros: true });
export function TaskRows({
  tasks,
  snapshot,
  actions,
  compact = false,
}: {
  tasks: Task[];
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
  compact?: boolean;
}) {
  return (
    <ul className="divide-y divide-border">
      {tasks.map((task) => {
        const company = snapshot.companies.find((c) => c.id === task.companyId),
          urgency = taskUrgency(task, Date.now(), company?.timezone || "Australia/Sydney");
        return (
          <li key={task.id} className="flex min-w-0 items-start gap-3 py-4 first:pt-0 last:pb-0">
            <Button
              className="mt-0.5 shrink-0"
              size="icon"
              variant="ghost"
              disabled={actions.busy}
              aria-label={`${task.status === "done" ? "Reopen" : "Complete"} ${task.title}`}
              onClick={() =>
                void actions.run(task.status === "done" ? "crm.task.reopen" : "crm.task.complete", {
                  id: task.id,
                  expectedVersion: task.version,
                })
              }
            >
              {task.status === "done" ? (
                <Check className="size-5 text-success" />
              ) : (
                <Circle className="size-5 text-muted-foreground" />
              )}
            </Button>
            <div className="min-w-0 flex-1">
              <button
                className="ds-interactive max-w-full rounded text-left text-sm font-medium leading-relaxed hover:underline"
                onClick={() => actions.edit({ kind: "task", record: task })}
              >
                {task.title}
              </button>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {company && (
                  <button
                    className="ds-interactive rounded hover:text-foreground hover:underline"
                    onClick={() =>
                      actions.open(
                        { kind: "company", id: company.id },
                        task.projectId ? "delivery" : "overview",
                      )
                    }
                  >
                    {company.name}
                  </button>
                )}
                <span>{ownerName(task.owner)}</span>
                <span
                  className={cn("ds-num", isOpenTask(task) && urgency === "overdue" && "text-warn")}
                >
                  {task.dueAt
                    ? `${urgency === "overdue" && isOpenTask(task) ? "Overdue · " : ""}${fmtDateTime(task.dueAt, { timeZone: company?.timezone || "Australia/Sydney" })}`
                    : "No due date"}
                </span>
              </div>
              {!compact && task.description && (
                <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
                  {task.description}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions.edit({ kind: "task", record: task })}
            >
              Edit
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
export function TodayView({
  snapshot,
  actions,
}: {
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
}) {
  const [owner, setOwner] = useState("");
  const active = snapshot.tasks
    .filter((t) => isOpenTask(t) && (!owner || t.owner === owner))
    .sort(taskOrder);
  const urgency = (task: Task) =>
    taskUrgency(
      task,
      Date.now(),
      snapshot.companies.find((c) => c.id === task.companyId)?.timezone || "Australia/Sydney",
    );
  const due = active.filter((t) => ["today", "overdue"].includes(urgency(t)));
  const meetings = active
    .filter((t) => t.kind === "meeting" && urgency(t) === "upcoming")
    .slice(0, 6);
  const delivery = active
    .filter((t) => ["delivery", "renewal"].includes(t.kind) && !due.includes(t))
    .slice(0, 6);
  const nextActions = snapshot.deals
    .filter((d) => (!owner || d.owner === owner) && stageForDeal(snapshot, d)?.category === "open")
    .sort((a, b) => (a.nextActionDue || "9999").localeCompare(b.nextActionDue || "9999"));
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Due dates are shown in each company’s time zone
        </p>
        <label className="flex items-center gap-3 text-sm">
          Owner
          <NativeSelect className="w-40" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Both founders</option>
            <option value="usman">Usman</option>
            <option value="mehroz">Mehroz</option>
          </NativeSelect>
        </label>
      </div>
      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Section
            title="Your next moves"
            description={
              due.length
                ? `${due.length} ${due.length === 1 ? "task needs" : "tasks need"} attention today`
                : "Follow-ups, promises and meetings due today"
            }
            actions={
              <Button variant="outline" onClick={() => actions.edit({ kind: "task" })}>
                <Plus className="size-4" />
                Add task
              </Button>
            }
          >
            {due.length ? (
              <Surface>
                <TaskRows tasks={due} snapshot={snapshot} actions={actions} />
              </Surface>
            ) : (
              <EmptyState
                icon={Check}
                title="Nothing due right now"
                body="Scheduled follow-ups and promises will appear here. Add a task to make the next commitment clear."
              />
            )}
          </Section>
          <Section
            title="Deal next actions"
            description="The next step is separate from a deal’s estimated value"
          >
            {nextActions.length ? (
              <Surface padding="none">
                <ul className="divide-y divide-border">
                  {nextActions.slice(0, 8).map((deal) => (
                    <li
                      key={deal.id}
                      className="flex min-w-0 items-start justify-between gap-3 p-5"
                    >
                      <div className="min-w-0">
                        <button
                          className="ds-interactive rounded text-left text-sm font-medium hover:underline"
                          onClick={() => actions.open({ kind: "deal", id: deal.id }, "deals")}
                        >
                          {deal.nextAction || "Choose the next action"}
                        </button>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {snapshot.companies.find((c) => c.id === deal.companyId)?.name} ·{" "}
                          {deal.title}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ownerName(deal.owner)} ·{" "}
                          {deal.nextActionDue ? fmtDateTime(deal.nextActionDue) : "Date not set"}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => actions.edit({ kind: "deal", record: deal })}
                      >
                        {deal.nextAction ? "Edit" : "Set action"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Surface>
            ) : (
              <EmptyState
                variant="row"
                title="No open deals"
                body="Add a deal from a company record to plan the next step."
              />
            )}
          </Section>
        </div>
        <div className="min-w-0">
          <Section title="Coming up" description="Upcoming meetings recorded in the CRM">
            {meetings.length ? (
              <Surface>
                <TaskRows tasks={meetings} snapshot={snapshot} actions={actions} compact />
              </Surface>
            ) : (
              <EmptyState
                icon={CalendarDays}
                variant="row"
                title="No upcoming meetings recorded"
                body="Add a meeting task or link an existing meeting in the timeline."
              />
            )}
          </Section>
          <Section title="Delivery and renewals" description="Keep client commitments moving">
            {delivery.length ? (
              <Surface>
                <TaskRows tasks={delivery} snapshot={snapshot} actions={actions} compact />
              </Surface>
            ) : (
              <EmptyState
                variant="row"
                icon={ClipboardList}
                title="No upcoming delivery tasks"
                body="Delivery projects hold milestones, requests and renewal dates."
              />
            )}
          </Section>
          <Surface padding="sm">
            <h3 className="text-sm font-medium">Shared responsibility</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Usman and Mehroz share access. Record ownership shows who is responsible for the next
              step.
            </p>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <a className="ds-interactive rounded underline underline-offset-4" href="/calendar">
                Open Calendar ↗
              </a>
              <a className="ds-interactive rounded underline underline-offset-4" href="/inbox">
                Open Inbox ↗
              </a>
            </div>
          </Surface>
        </div>
      </div>
      <AutomationRules />
    </>
  );
}
export function DealCard({
  deal,
  snapshot,
  actions,
}: {
  deal: Deal;
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
}) {
  const company = snapshot.companies.find((c) => c.id === deal.companyId);
  return (
    <Surface padding="sm" className="min-w-0">
      <button
        className="ds-interactive max-w-full rounded text-left text-sm font-semibold hover:underline"
        onClick={() => actions.open({ kind: "deal", id: deal.id }, "deals")}
      >
        {deal.title}
      </button>
      <p className="mt-1 text-sm text-muted-foreground break-words">
        {company?.name ?? "Company unavailable"}
      </p>
      <p className="ds-num mt-4 text-base font-medium">{money(deal.oneOffCents)}</p>
      <p className="ds-num text-xs text-muted-foreground">
        {money(deal.recurringCents)} / month ·{" "}
        {deal.gstTreatment === "not-applicable" ? "GST n/a" : `GST ${deal.gstTreatment}`}
      </p>
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-sm">{deal.nextAction || "Next action not set"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {deal.nextActionDue ? fmtDay(deal.nextActionDue) : "No due date"} ·{" "}
          {ownerName(deal.owner)}
        </p>
      </div>
      <Button
        variant="ghost"
        className="mt-2 -ml-2"
        size="sm"
        onClick={() => actions.edit({ kind: "deal", record: deal })}
      >
        Edit deal
        <ArrowUpRight className="size-4" />
      </Button>
    </Surface>
  );
}
export function PipelineView({
  snapshot,
  actions,
  configure,
}: {
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
  configure: (pipeline: Pipeline) => void;
}) {
  const [mode, setMode] = useState<"board" | "table">("board"),
    [owner, setOwner] = useState(""),
    [query, setQuery] = useState(""),
    [pipelineId, setPipelineId] = useState(snapshot.pipelines[0]?.id ?? "sales");
  const pipeline = snapshot.pipelines.find((p) => p.id === pipelineId),
    stages = pipeline?.stages ?? SALES_STAGES;
  const deals = snapshot.deals.filter(
    (d) =>
      d.pipelineId === pipelineId &&
      (!owner || d.owner === owner) &&
      matchesSearch(
        [d.title, d.service, d.scope, snapshot.companies.find((c) => c.id === d.companyId)?.name],
        query,
      ),
  );
  const totals = pipelineTotals(snapshot, deals);
  return (
    <>
      <div className="mb-6 flex flex-wrap gap-3">
        <Input
          type="search"
          className="min-h-11 w-full sm:max-w-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search deals or companies"
          aria-label="Search deals or companies"
        />
        <NativeSelect
          className="w-full sm:w-44"
          aria-label="Pipeline"
          value={pipelineId}
          onChange={(e) => setPipelineId(e.target.value)}
        >
          {snapshot.pipelines.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          className="w-full sm:w-44"
          aria-label="Deal owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          <option value="">Both founders</option>
          <option value="usman">Usman</option>
          <option value="mehroz">Mehroz</option>
        </NativeSelect>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented
            value={mode}
            onChange={setMode}
            ariaLabel="Pipeline layout"
            options={[
              { value: "board", label: "Board" },
              { value: "table", label: "Table" },
            ]}
          />
          {pipeline && (
            <Button variant="outline" onClick={() => configure(pipeline)}>
              Edit stages
            </Button>
          )}
          <Button variant="accent" onClick={() => actions.edit({ kind: "deal" })}>
            <Plus className="size-4" />
            Add deal
          </Button>
        </div>
      </div>
      <Surface className="mb-8" padding="sm">
        <dl className="grid gap-5 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">Estimated open pipeline, ex GST</dt>
            <dd className="ds-num mt-1 text-lg font-semibold">{money(totals.estimatedOneOff)}</dd>
            <dd className="ds-num text-xs text-muted-foreground">
              + {money(totals.estimatedRecurring)} / month · {totals.openCount} open deals
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Won business, ex GST</dt>
            <dd className="ds-num mt-1 text-lg font-semibold">{money(totals.wonOneOff)}</dd>
            <dd className="ds-num text-xs text-muted-foreground">
              + {money(totals.wonRecurring)} / month · {totals.wonCount} won deals
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Invoices and money received</dt>
            <dd className="mt-1 text-sm">Tracked in Finance</dd>
            <dd className="mt-2">
              <a
                href="/finance"
                className="ds-interactive rounded text-sm underline underline-offset-4"
              >
                Open Finance ↗
              </a>
            </dd>
          </div>
        </dl>
        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          Unweighted AUD totals excluding GST, calculated from each deal’s recorded GST treatment.
          Deal cards retain the agreed values. Won is a sales outcome, not payment confirmation.
        </p>
      </Surface>
      {!deals.length ? (
        <EmptyState
          icon={Columns3}
          title={
            snapshot.deals.length ? "No deals match this view" : "Your sales pipeline starts here"
          }
          body={
            snapshot.deals.length
              ? "Try a different owner, pipeline or search term."
              : "Add a company and a deal with an owner, agreed scope and a clear next action."
          }
        />
      ) : mode === "board" ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stages
            .filter((s) => !s.archived || deals.some((d) => d.stageId === s.id))
            .map((stage) => {
              const items = deals.filter((d) => d.stageId === stage.id);
              return (
                <section
                  key={stage.id}
                  className="min-w-0 rounded-2xl bg-inset p-3"
                  aria-label={`${stage.name} deals`}
                >
                  <div className="mb-4 flex items-center justify-between gap-2 px-1 pt-1">
                    <h2 className="text-base font-semibold">
                      {stage.name}
                      {stage.archived ? " (archived)" : ""}
                    </h2>
                    <span className="ds-num text-sm text-muted-foreground">{items.length}</span>
                  </div>
                  <div className="space-y-3">
                    {items.map((deal) => (
                      <DealCard key={deal.id} deal={deal} snapshot={snapshot} actions={actions} />
                    ))}
                    {!items.length && (
                      <p className="px-1 py-4 text-sm text-muted-foreground">
                        No deals at this stage
                      </p>
                    )}
                  </div>
                </section>
              );
            })}
        </div>
      ) : (
        <Surface padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <caption className="sr-only">
                Sales pipeline with owners, AUD values, dates and next actions
              </caption>
              <thead className="bg-inset text-xs text-muted-foreground">
                <tr>
                  {[
                    "Deal / company",
                    "Stage",
                    "Owner",
                    "One-off / recurring",
                    "Close date",
                    "Next action",
                    "",
                  ].map((label, i) => (
                    <th key={i} scope="col" className="p-4 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deals.map((deal) => (
                  <tr key={deal.id} className="hover:bg-surface-raised">
                    <td className="p-4">
                      <button
                        className="ds-interactive rounded text-left font-medium hover:underline"
                        onClick={() => actions.open({ kind: "deal", id: deal.id }, "deals")}
                      >
                        {deal.title}
                      </button>
                      <div className="mt-1 text-muted-foreground">
                        {snapshot.companies.find((c) => c.id === deal.companyId)?.name}
                      </div>
                    </td>
                    <td className="p-4">
                      <NativeSelect
                        aria-label={`Stage for ${deal.title}`}
                        value={deal.stageId}
                        disabled={actions.busy}
                        onChange={(e) => {
                          if (
                            ["won", "lost"].includes(
                              stages.find((s) => s.id === e.target.value)?.category ?? "",
                            )
                          )
                            actions.edit({
                              kind: "deal",
                              record: { ...deal, stageId: e.target.value },
                            });
                          else
                            void actions.run("crm.deal.move", {
                              id: deal.id,
                              expectedVersion: deal.version,
                              stageId: e.target.value,
                            });
                        }}
                      >
                        {stages
                          .filter((s) => !s.archived || s.id === deal.stageId)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </NativeSelect>
                    </td>
                    <td className="p-4">{ownerName(deal.owner)}</td>
                    <td className="ds-num p-4 whitespace-nowrap">
                      {money(deal.oneOffCents)}
                      <div className="text-xs text-muted-foreground">
                        {money(deal.recurringCents)} / month
                      </div>
                    </td>
                    <td className="ds-num p-4 whitespace-nowrap">{fmtDay(deal.expectedClose)}</td>
                    <td className="max-w-xs p-4">
                      {deal.nextAction || "Not set"}
                      <div className="ds-num mt-1 text-xs text-muted-foreground">
                        {fmtDay(deal.nextActionDue)}
                      </div>
                    </td>
                    <td className="p-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => actions.edit({ kind: "deal", record: deal })}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </>
  );
}
