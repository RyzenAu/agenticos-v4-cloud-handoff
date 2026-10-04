// Activity (audit F3-04): the jobs the OS actually recorded, read from the durable job history
// (GET /__jobs, scripts/jobs). It used to be a hard-coded empty list that said "No runs yet" as if
// that had been measured. Every state here says what was (or wasn't) read.
import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";
import type { Job, JobState, JobSummary } from "../../../scripts/jobs/types";
import { maskLine } from "@/lib/agent-feed";
import { useState } from "react";
import { Button, DetailDrawer, Details, EmptyState, Notice, PageSkeleton, Segmented, StatusLabel, Toolbar, type StatusState, type Tone } from "@/components/ds";

const KIND_LABEL: Record<string, string> = {
  voice: "Voice",
  screen: "Screen",
  control: "PC control",
  away: "Away mode",
  coding: "Coding",
  memory: "Memory",
  lesson: "Lesson",
  trigger: "Trigger",
};

export type ActivityRow = {
  id: string;
  title: string;
  kind: string;
  state: JobState;
  stateLabel: string;
  tone: Tone;
  started: string;
  startedIso: string;
  duration: string;
  steps: number;
  note: string;
};

function toneFor(state: JobState): Tone {
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "interrupted" || state === "unknown") return "danger";
  if (state === "running" || state === "queued") return "info";
  if (state === "awaiting-approval") return "warn";
  return "neutral";
}

/** R11: one status vocabulary. Interrupted and unknown are not failures, so they are not red (only a real failure is). */
export function statusStateFor(state: JobState): StatusState {
  if (state === "succeeded") return "done";
  if (state === "failed") return "failed";
  if (state === "running") return "running";
  if (state === "queued") return "pending";
  if (state === "awaiting-approval") return "needs-you";
  if (state === "cancelled") return "stopped";
  return "unknown";
}

/**
 * R12 rollout: the shared work words (R12-UI-SYSTEM "Status language"): Running, Queued, Needs your yes, Completed, Failed, Stopped,
 * Interrupted, Outcome unknown. The chip keeps its own live phrasing (JOB_STATE_LABEL in job-events); this page states the outcome.
 */
export const WORK_WORD: Record<JobState, string> = {
  queued: "Queued",
  running: "Running",
  "awaiting-approval": "Needs your yes",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted, not re-run",
  unknown: "Outcome unknown",
};

const FINISHED: readonly JobState[] = ["succeeded", "failed", "cancelled", "interrupted", "unknown"];

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function formatStarted(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(t);
}

/** Newest first; titles masked again on the client like the chip. Pure. */
export function activityRows(jobs: readonly JobSummary[]): ActivityRow[] {
  return [...jobs]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .map((j) => {
      const created = Date.parse(j.createdAt);
      const updated = Date.parse(j.updatedAt);
      return {
        id: j.id,
        title: maskLine(j.title, 140) || "Untitled job",
        kind: KIND_LABEL[j.kind] ?? j.kind,
        state: j.state,
        stateLabel: WORK_WORD[j.state] ?? j.state,
        tone: toneFor(j.state),
        started: formatStarted(j.createdAt),
        startedIso: j.createdAt,
        duration: FINISHED.includes(j.state) && Number.isFinite(created) && Number.isFinite(updated) ? formatDuration(updated - created) : "Still going",
        steps: j.stepCount,
        note: j.note ? maskLine(j.note, 160) : "",
      };
    });
}

/** The job a link pointed at (`/activity#job-<id>`): "Open job" from a conversation lands on THIS job, not on the list. */
export type SelectedRead = { id: string } & ({ status: "loading" } | { status: "missing" } | { status: "error"; message: string } | { status: "ok"; job: Job });

/** The job id a URL hash names (#job-<uuid>), or null. Pure. */
export function jobIdFromHash(hash: string): string | null {
  const m = /^#?job-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(hash.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Workflow jobs (research, builder, website audit, business preparation) keep a saved result that opens from the OS. Pure. */
export function savedResultFor(job: Pick<Job, "id" | "state" | "steps">): string | null {
  return job.state === "succeeded" && job.steps.some((s) => ["research", "builder", "audit", "bizprep"].includes(s.executor)) ? `/__computers/artifacts/${job.id}` : null;
}

export type ActivityRead =
  | { status: "loading" }
  | { status: "error"; message: string; signedOut?: boolean }
  | { status: "ok"; jobs: readonly JobSummary[]; stale?: boolean };

const SCOPE =
  "Jobs the OS ran through Jarvis: voice, screen, PC control, away mode, coding and memory. Claude Code sessions you run yourself aren't recorded here; their totals are on AI usage.";

/** The agent a job belongs to, when it does: "Open in <Agent> workspace" links to that bot's Tasks & Files. */
export type WorkspaceLink = { botId: string; name: string };

function SelectedJob({ selected, workspace, onClose }: { selected: SelectedRead; workspace?: WorkspaceLink | null; onClose?: () => void }) {
  const box = "mb-4 scroll-mt-20 rounded-xl border border-border bg-card px-4 py-3";
  if (selected.status === "loading") return <div className={box} data-testid="selected-job" aria-busy="true"><p className="text-sm text-muted-foreground">Reading job {selected.id.slice(0, 8)}…</p></div>;
  if (selected.status === "missing" || selected.status === "error")
    return (
      <Notice tone="warn" className="mb-4" title={`Job ${selected.id.slice(0, 8)} isn't in the job history`}>
        {selected.status === "error" ? `${selected.message}. ` : ""}It may be older than the history keeps, or it was never recorded on this OS. The recent jobs are below.
      </Notice>
    );
  const j = selected.job;
  const saved = savedResultFor(j);
  const created = Date.parse(j.createdAt);
  const updated = Date.parse(j.updatedAt);
  const finished = FINISHED.includes(j.state);
  const steps = j.steps.filter((s) => s.executor !== "context").slice(-14);
  // R11: on the page the job opens in the shared detail drawer (the one every other record uses). Without a close handler (static renders) it stays an inline panel.
  if (onClose) {
    return (
      <DetailDrawer
        open
        onOpenChange={(o) => !o && onClose()}
        title={maskLine(j.title, 140) || "Untitled job"}
        status={<StatusLabel state={statusStateFor(j.state)} label={WORK_WORD[j.state] ?? j.state} size="sm" />}
        description={`Job ${j.id.slice(0, 8)} · ${formatStarted(j.createdAt)}${finished && Number.isFinite(created) && Number.isFinite(updated) ? ` · took ${formatDuration(updated - created)}` : " · still going"}`}
        actions={
          <>
            {workspace && (
              <Button asChild variant="outline">
                <Link to="/agents/workspace/$botId" params={{ botId: workspace.botId }} search={{ tab: "tasks" }}>Open in {workspace.name} workspace</Link>
              </Button>
            )}
            {saved && (
              <Button asChild variant="accent">
                <a href={saved} target="_blank" rel="noopener noreferrer">Open saved result</a>
              </Button>
            )}
          </>
        }
      >
        <div data-testid="selected-job">
          {j.note && <p className="mb-3 text-sm text-muted-foreground">{maskLine(j.note, 200)}</p>}
          {steps.length > 0 && (
            <ol className="grid gap-2 text-[13px]">
              {steps.map((st) => (
                <li key={st.seq} className={st.outcome === "failed" || st.verification?.ok === false ? "text-danger" : ""}>
                  <span className="font-mono text-muted-foreground">{st.executor} </span>
                  {maskLine(st.intent, 200)}
                </li>
              ))}
            </ol>
          )}
          {j.steps.length > steps.length && <p className="mt-2 text-[13px] text-muted-foreground">Showing the last {steps.length} of {j.steps.length} steps.</p>}
        </div>
      </DetailDrawer>
    );
  }
  return (
    <section className={box} data-testid="selected-job" aria-label={`Job ${j.id.slice(0, 8)}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{maskLine(j.title, 140) || "Untitled job"}</h2>
        <StatusLabel state={statusStateFor(j.state)} label={WORK_WORD[j.state] ?? j.state} size="sm" />
        <span className="text-xs text-muted-foreground">
          job {j.id.slice(0, 8)} · {formatStarted(j.createdAt)}
          {finished && Number.isFinite(created) && Number.isFinite(updated) ? ` · took ${formatDuration(updated - created)}` : " · still going"}
        </span>
        {saved && (
          <a className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent" href={saved} target="_blank" rel="noopener noreferrer">
            Open saved result
          </a>
        )}
        {workspace && (
          <Link className={`${saved ? "" : "ml-auto "}rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent`} to="/agents/workspace/$botId" params={{ botId: workspace.botId }} search={{ tab: "tasks" }}>
            Open in {workspace.name} workspace
          </Link>
        )}
      </div>
      {j.note && <p className="mt-1 text-xs text-muted-foreground">{maskLine(j.note, 200)}</p>}
      {steps.length > 0 && (
        <ol className="mt-2 grid gap-1 text-xs">
          {steps.map((s) => (
            <li key={s.seq} className={s.outcome === "failed" || s.verification?.ok === false ? "text-danger" : ""}>
              <span className="font-mono text-muted-foreground">{s.executor} </span>
              {maskLine(s.intent, 200)}
            </li>
          ))}
        </ol>
      )}
      {j.steps.length > steps.length && <p className="mt-1 text-xs text-muted-foreground">Showing the last {steps.length} of {j.steps.length} steps.</p>}
    </section>
  );
}

type StatusFilter = "all" | "attention" | "running" | "done" | "stopped";
const FILTER_STATES: Record<Exclude<StatusFilter, "all">, JobState[]> = {
  attention: ["failed", "interrupted", "unknown", "awaiting-approval"],
  running: ["running", "queued"],
  done: ["succeeded"],
  stopped: ["cancelled"],
};

export function ActivityView({ read, onRetry, selected, workspace, onCloseSelected }: { read: ActivityRead; onRetry?: () => void; selected?: SelectedRead | null; workspace?: WorkspaceLink | null; onCloseSelected?: () => void }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  if (read.status === "loading") return <PageSkeleton variant="list" rows={5} label="Reading the job history" />;
  if (read.status === "error") {
    return (
      <Notice
        tone={read.signedOut ? "warn" : "danger"}
        title={read.signedOut ? "Sign in to see the job history" : "Couldn't read the job history"}
        action={
          onRetry ? (
            <button type="button" onClick={onRetry} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent">
              Try again
            </button>
          ) : undefined
        }
      >
        {read.signedOut ? "Jobs are private to the people signed in to this OS." : `${read.message}. Nothing is shown rather than an empty list that might be wrong.`}
      </Notice>
    );
  }
  const allRows = activityRows(read.jobs);
  const needle = q.trim().toLowerCase();
  const rows = allRows.filter((r) => (filter === "all" || FILTER_STATES[filter].includes(r.state)) && (!needle || `${r.title} ${r.note}`.toLowerCase().includes(needle)));
  // R11: a column that says the same word on every row is noise; Kind shows only when the kinds differ.
  const showKind = new Set(rows.map((r) => r.kind)).size > 1;
  if (allRows.length === 0 && !selected) {
    return (
      <EmptyState
        icon={History}
        title="The job history is empty"
        body={
          <>
            Read just now: no jobs have been recorded on this OS yet. {SCOPE}{" "}
            <Link to="/usage" className="underline underline-offset-2 hover:text-foreground">
              Open AI usage
            </Link>
          </>
        }
      />
    );
  }
  return (
    <div data-testid="activity-jobs" data-stale={read.stale ? "true" : undefined}>
      {selected && <SelectedJob selected={selected} workspace={workspace} onClose={selected.status === "ok" ? onCloseSelected : undefined} />}
      {read.stale && (
        <Notice tone="warn" className="mb-3" title="Couldn't refresh: showing the previous read">
          The latest jobs may be missing.
        </Notice>
      )}
      <Toolbar
        label="Job filters"
        search={{ value: q, onChange: setQ, placeholder: "Search jobs", label: "Search jobs" }}
        filters={
          <Segmented
            ariaLabel="Job status"
            value={filter}
            onChange={(v) => setFilter(v as StatusFilter)}
            options={[
              { value: "all", label: "All" },
              { value: "attention", label: "Needs attention" },
              { value: "running", label: "Running" },
              { value: "done", label: "Completed" },
              { value: "stopped", label: "Stopped" },
            ]}
          />
        }
        summary={`${rows.length} of ${allRows.length} recent jobs, newest first`}
      />
      {rows.length === 0 && (
        <EmptyState
          variant="row"
          title="No jobs match"
          action={<Button variant="outline" size="sm" onClick={() => { setQ(""); setFilter("all"); }}>Clear filters</Button>}
        />
      )}
      <div className={rows.length === 0 ? "hidden" : "overflow-x-auto rounded-2xl border border-border bg-card"}>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr className="[&_th]:ds-label [&_th]:whitespace-nowrap">
              <th className="px-4 py-3 text-left font-medium">Job</th>
              {showKind && <th className="hidden px-4 py-3 text-left font-medium lg:table-cell">Kind</th>}
              <th className="hidden px-4 py-3 text-left font-medium sm:table-cell">Status</th>
              <th className="hidden px-4 py-3 text-left font-medium sm:table-cell">Started</th>
              <th className="hidden px-4 py-3 text-left font-medium md:table-cell">Took</th>
              <th className="hidden px-4 py-3 text-right font-medium md:table-cell">Steps</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} id={`job-${r.id}`} data-selected={selected?.id === r.id ? "true" : undefined} className={selected?.id === r.id ? "bg-surface-raised" : "hover:bg-surface-raised"}>
                <td className="px-4 py-3">
                  <a className="text-sm font-medium hover:underline" href={`#job-${r.id}`} aria-current={selected?.id === r.id ? "true" : undefined}>{r.title}</a>
                  {r.note && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{r.note}</div>}
                  {/* Phone: the status and time sit under the title instead of squeezing it into a narrow column. */}
                  <div className="mt-2 flex flex-wrap items-center gap-2 sm:hidden">
                    <StatusLabel state={statusStateFor(r.state)} label={r.stateLabel} size="sm" />
                    <time dateTime={r.startedIso} className="text-[13px] text-muted-foreground">{r.started}</time>
                  </div>
                </td>
                {showKind && <td className="hidden whitespace-nowrap px-4 py-3 text-[13px] lg:table-cell">{r.kind}</td>}
                <td className="hidden whitespace-nowrap px-4 py-3 sm:table-cell">
                  <StatusLabel state={statusStateFor(r.state)} label={r.stateLabel} size="sm" />
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground sm:table-cell">
                  <time dateTime={r.startedIso}>{r.started}</time>
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 text-[13px] tabular-nums md:table-cell">{r.duration}</td>
                <td className="hidden px-4 py-3 text-right text-xs tabular-nums md:table-cell">{r.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Details summary="What is recorded here" className="mt-3 max-w-[48rem]">
        {SCOPE}{" "}
        <Link to="/usage" className="underline underline-offset-2 hover:text-foreground">
          AI usage
        </Link>
      </Details>
    </div>
  );
}
