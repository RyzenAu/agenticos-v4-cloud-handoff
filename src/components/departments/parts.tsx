// R12 Departments: the small shared pieces the department views, Home and Jarvis use (status, hand-off lists, a journey's steps,
// CRM record links). Built only from @/components/ds; no page styling of its own.
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { HandoffStep, StatusLabel, fmtRelative } from "@/components/ds";
import { DEPARTMENT_BY_ID, JOURNEY_TASK_STATE, journeyNow, partyName, workStatus, type DeptTask, type DepartmentId, type HandoffView, type Journey, type Party, type WorkTaskState } from "@/lib/departments";
import type { DeptBot } from "./use-departments";

export const deptName = (id: DepartmentId) => DEPARTMENT_BY_ID[id].name;
export const botName = (bots: readonly Pick<DeptBot, "id" | "name">[], id: string | null) => (id ? (bots.find((b) => b.id === id)?.name ?? id.charAt(0).toUpperCase() + id.slice(1)) : null);

export function WorkStatus({ state, size = "sm", label }: { state: WorkTaskState; size?: "sm" | "md"; label?: string }) {
  const s = workStatus(state);
  return <StatusLabel state={s.state} label={label ?? s.label} size={size} />;
}

/** "Research · Running · started 4 min ago": the one meta line under a task's title. The state itself is the StatusLabel, not repeated here. */
export function taskMeta(t: DeptTask, bots: readonly Pick<DeptBot, "id" | "name">[], withDept = false): string {
  const who = botName(bots, t.botId);
  const when = t.endedAt ? `ended ${fmtRelative(t.endedAt)}` : t.startedAt ? `started ${fmtRelative(t.startedAt)}` : null;
  const dept = withDept ? deptName(t.department).split(" & ")[0] : null;
  return [dept, who && who !== dept ? who : null, when].filter(Boolean).join(" · ");
}

const partyLabel = (p: Party, bots: readonly Pick<DeptBot, "id" | "name">[]) => {
  const agent = botName(bots, p.agent);
  const dept = partyName(p);
  return agent && agent !== dept ? `${dept} (${agent})` : dept;
};

/** One hand-off as a readable step. `onOpenTask` opens the receiving task (a drawer on the department page). */
export function Handoff({ h, bots, onOpenTask }: { h: HandoffView; bots: readonly Pick<DeptBot, "id" | "name">[]; onOpenTask?: (taskId: string) => void }) {
  const status = workStatus(h.state);
  return (
    <HandoffStep
      as="li"
      from={partyLabel(h.from, bots)}
      to={partyLabel(h.to, bots)}
      label={h.label}
      status={{ state: status.state, label: status.label }}
      basis={h.basis === "inferred" ? "Inferred: same client record, the earlier work had finished" : "Journey step"}
      action={
        h.taskId && onOpenTask ? (
          <button type="button" className="min-h-9 font-medium text-foreground underline-offset-4 hover:underline" onClick={() => onOpenTask(h.taskId!)}>
            Open task
          </button>
        ) : undefined
      }
    />
  );
}

/** A journey (GET /__journeys) as its steps: who hands what to whom, each with its own state, output, failure or question. */
export function JourneySteps({ journey, bots, compact = false }: { journey: Journey; bots: readonly Pick<DeptBot, "id" | "name">[]; compact?: boolean }) {
  const now = journeyNow(journey);
  return (
    <section aria-label={journey.title} className="min-w-0 rounded-2xl border border-border bg-card px-4 py-3" data-journey={journey.id}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{journey.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{now.line}</p>
        </div>
        <WorkStatus state={JOURNEY_TASK_STATE[journey.state]} />
      </div>
      <ol className="mt-2 divide-y divide-border border-t border-border">
        {journey.steps.map((s, i) => {
          const prev = journey.steps[i - 1];
          const from = s.from ?? (prev ? prev.owner : { department: "jarvis" as const, agent: null });
          const status = workStatus(JOURNEY_TASK_STATE[s.state]);
          const line = s.failure
            ? `Failed: ${s.failure.reason}`
            : s.waitingFor
              ? `Waiting for you: ${s.waitingFor.question}`
              : s.completion?.summary
                ? s.completion.summary
                : s.expectedOutput
                  ? `Expected: ${s.expectedOutput}`
                  : undefined;
          const outs = [...(s.completion?.outputs ?? []), ...(s.failure?.saved ?? [])];
          return (
            <HandoffStep
              key={s.id}
              as="li"
              from={partyLabel(from, bots)}
              to={partyLabel(s.owner, bots)}
              label={s.title.charAt(0).toLowerCase() + s.title.slice(1)}
              status={{ state: status.state, label: status.label }}
              basis={compact && s.state === "queued" ? undefined : line}
              action={outs.length ? outs.map((o) => (
                <a key={o.href} href={o.href} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
                  {o.label} <ArrowUpRight aria-hidden="true" className="size-3" />
                </a>
              )) : undefined}
            />
          );
        })}
      </ol>
    </section>
  );
}

/** A CRM reference (`crm:company:<id>`) as a link with the record's name, read from the CRM's own record route. */
export function SubjectLink({ subject }: { subject: string }) {
  const q = useQuery({
    queryKey: ["crm-record-name", subject],
    queryFn: async () => {
      const r = await fetch(`/__crm/record?ref=${encodeURIComponent(subject)}`, { cache: "no-store" });
      const body = (await r.json().catch(() => null)) as { ok?: boolean; data?: { name?: string; title?: string } } | null;
      return body?.ok ? (body.data?.name || body.data?.title || null) : null;
    },
    staleTime: 60_000,
    retry: false,
  });
  const kind = subject.split(":")[1] ?? "record";
  return (
    <Link to="/crm" search={{ ref: subject } as never} className="font-medium text-foreground underline-offset-4 hover:underline [overflow-wrap:anywhere]">
      {q.data ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} record`}
    </Link>
  );
}
