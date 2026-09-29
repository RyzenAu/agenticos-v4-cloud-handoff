// Activity (audit F3-04): the jobs the OS actually recorded, read from the durable job history
// (GET /__jobs, scripts/jobs). It used to be a hard-coded empty list that said "No runs yet" as if
// that had been measured. Every state here says what was (or wasn't) read.
import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";
import type { JobState, JobSummary } from "../../../scripts/jobs/types";
import { JOB_STATE_LABEL } from "@/lib/job-events";
import { maskLine } from "@/lib/agent-feed";
import { Badge, EmptyState, Notice, PageSkeleton, type Tone } from "@/components/ds";

const KIND_LABEL: Record<string, string> = {
  voice: "Voice",
  screen: "Screen",
  control: "PC control",
  away: "Away mode",
  coding: "Coding",
  memory: "Memory",
  lesson: "Lesson",
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
        stateLabel: JOB_STATE_LABEL[j.state] ?? j.state,
        tone: toneFor(j.state),
        started: formatStarted(j.createdAt),
        startedIso: j.createdAt,
        duration: FINISHED.includes(j.state) && Number.isFinite(created) && Number.isFinite(updated) ? formatDuration(updated - created) : "Still going",
        steps: j.stepCount,
        note: j.note ? maskLine(j.note, 160) : "",
      };
    });
}

export type ActivityRead =
  | { status: "loading" }
  | { status: "error"; message: string; signedOut?: boolean }
  | { status: "ok"; jobs: readonly JobSummary[]; stale?: boolean };

const SCOPE =
  "Jobs the OS ran through Jarvis: voice, screen, PC control, away mode, coding and memory. Claude Code sessions you run yourself aren't recorded here; their totals are on AI usage.";

export function ActivityView({ read, onRetry }: { read: ActivityRead; onRetry?: () => void }) {
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
  const rows = activityRows(read.jobs);
  if (rows.length === 0) {
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
      {read.stale && (
        <Notice tone="warn" className="mb-3" title="Couldn't refresh: showing the previous read">
          The latest jobs may be missing.
        </Notice>
      )}
      <p className="mb-3 text-xs text-muted-foreground">
        {rows.length} most recent job{rows.length === 1 ? "" : "s"}, newest first. {SCOPE}{" "}
        <Link to="/usage" className="underline underline-offset-2 hover:text-foreground">
          AI usage
        </Link>
      </p>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-inset text-muted-foreground">
            <tr className="[&_th]:ds-label [&_th]:whitespace-nowrap">
              <th className="px-4 py-3 text-left font-medium">Job</th>
              <th className="px-4 py-3 text-left font-medium">Kind</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Started</th>
              <th className="hidden px-4 py-3 text-left font-medium md:table-cell">Took</th>
              <th className="hidden px-4 py-3 text-right font-medium md:table-cell">Steps</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3">
                  <div className="text-sm">{r.title}</div>
                  {r.note && <div className="mt-0.5 text-xs text-muted-foreground">{r.note}</div>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs">{r.kind}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  <Badge tone={r.tone}>{r.stateLabel}</Badge>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  <time dateTime={r.startedIso}>{r.started}</time>
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 text-xs tabular-nums md:table-cell">{r.duration}</td>
                <td className="hidden px-4 py-3 text-right text-xs tabular-nums md:table-cell">{r.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
