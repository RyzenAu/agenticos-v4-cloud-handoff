// R12 Departments: one task's detail, in the shared DetailDrawer. Facts first (owner, what it is about, what it is waiting on, what came
// out of it), technical ids folded in Details. The primary action is the one that moves the task on: open the result when there is
// one, otherwise open the agent's conversation to intervene.
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Button, DetailDrawer, Details, fmtRelative } from "@/components/ds";
import { workspaceHref } from "@/components/agents/workspace/bots";
import type { DeptTask, HandoffView } from "@/lib/departments";
import { Handoff, SubjectLink, WorkStatus, botName, deptName } from "./parts";
import type { DeptBot } from "./use-departments";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-2.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function TaskDrawer({ task, bots, handoffs, onClose }: { task: DeptTask | null; bots: readonly DeptBot[]; handoffs: readonly HandoffView[]; onClose: () => void }) {
  const t = task;
  const agent = t ? botName(bots, t.botId) : null;
  const chat = t ? workspaceHref(t.botId, "chat") : null;
  const into = t ? handoffs.filter((h) => h.taskId === t.id) : [];
  return (
    <DetailDrawer
      open={!!t}
      onOpenChange={(o) => !o && onClose()}
      title={t?.title ?? ""}
      status={t ? <WorkStatus state={t.state} size="md" label={t.state === "needs-you" ? t.stateWord : undefined} /> : undefined}
      actions={
        t && chat ? (
          <>
            <Button asChild variant="outline">
              <a href={t.jobHref}>Open job</a>
            </Button>
            {t.result ? (
              <>
                <Button asChild variant="outline">
                  <Link to={chat.to as never} params={chat.params as never} search={chat.search as never}>Talk to {agent}</Link>
                </Button>
                <Button asChild variant="accent">
                  <a href={t.result.href} target={t.result.external ? "_blank" : undefined} rel="noreferrer">
                    Open result <ArrowUpRight aria-hidden="true" className="size-4" />
                  </a>
                </Button>
              </>
            ) : (
              <Button asChild variant="accent">
                <Link to={chat.to as never} params={chat.params as never} search={chat.search as never}>Talk to {agent}</Link>
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {t && (
        <>
          {t.blocker && (
            <p className="mb-4 rounded-xl bg-surface-raised px-4 py-3 text-sm text-foreground" data-task-blocker="">
              {t.blocker.charAt(0).toUpperCase() + t.blocker.slice(1)}
            </p>
          )}
          <dl className="divide-y divide-border">
            <Fact label="Owner">{agent && deptName(t.department).startsWith(agent) ? `${agent} agent` : `${agent} · ${deptName(t.department)}`}</Fact>
            <Fact label={t.endedAt ? "Ran" : "Started"}>
              {t.startedAt ? fmtRelative(t.startedAt) : "Not started yet"}
              {t.endedAt ? `, ended ${fmtRelative(t.endedAt)}` : ""}
            </Fact>
            {t.progress && <Fact label="Progress">{t.progress}</Fact>}
            {t.subjects.length > 0 && (
              <Fact label="About">
                <span className="flex flex-col gap-1">{t.subjects.map((s) => <SubjectLink key={s} subject={s} />)}</span>
              </Fact>
            )}
            {!t.result && (t.state === "finished" || t.state === "failed" || t.state === "stopped") && <Fact label="Result">Nothing was saved.</Fact>}
          </dl>
          {into.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-medium text-foreground">Handed over from</h3>
              <ul className="divide-y divide-border">{into.map((h) => <Handoff key={h.id} h={h} bots={bots} />)}</ul>
            </div>
          )}
          <Details className="mt-4" items={[{ label: "Job", value: t.id, mono: true }, { label: "Kind", value: t.kind === "coding" ? "Coding job" : "Computer job" }, { label: "Agent id", value: t.botId, mono: true }]} />
        </>
      )}
    </DetailDrawer>
  );
}
