// The Inspector's step log (Stage B2): every job in the ONE durable history (voice, screen, control,
// away, coding, memory, lesson), newest first, with its masked steps, Jev decisions, checks and state.
// "Interrupted, not re-run" and "Outcome unknown" are stated plainly; waiting for a yes is never "done".
import { useEffect, useState } from "react";
import { Badge, DeviceStatusSlot, EmptyState, deviceFromRecord } from "@/components/ds";
import type { Tone } from "@/components/ds/status";
import { JOB_STATE_LABEL, cancelJob, fetchJob, readJobs, startJobEventBridge, subscribeJobs, type Job, type JobState, type JobSummary, type Step } from "@/lib/job-events";
import { cn } from "@/lib/utils";
import { fmtTime } from "@/lib/format";

const TONE: Record<JobState, Tone> = {
  queued: "neutral",
  running: "accent",
  "awaiting-approval": "warn",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warn",
  unknown: "danger",
};
const ACTIVE: readonly JobState[] = ["queued", "running", "awaiting-approval"];

const time = (at: number) => fmtTime(new Date(at), { seconds: true });

function StepRow({ step }: { step: Step }) {
  const failed = step.outcome === "failed" || step.outcome === "refused" || step.verification?.ok === false;
  return (
    <li className="grid grid-cols-[56px_1fr] gap-2 text-xs">
      <span className="ds-num text-muted-foreground">{time(step.at)}</span>
      <span className={cn("min-w-0 [overflow-wrap:anywhere]", failed ? "text-danger" : "text-foreground")}>
        <span className="font-mono text-muted-foreground">{step.executor} </span>
        {step.intent}
        {step.jev && (
          <span className="text-muted-foreground">
            {" "}
            · Jev {step.jev.op} → {step.jev.policy} <span className="ds-num">{Math.round(step.jev.confidence * 100)}%</span>
          </span>
        )}
        {step.verification && <span className="text-muted-foreground"> · check {step.verification.ok === null ? "inconclusive" : step.verification.ok ? "passed" : "failed"}</span>}
      </span>
    </li>
  );
}

function JobRow({ job }: { job: JobSummary & { steps: Step[] } }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Job | null>(null);
  const [stopping, setStopping] = useState<"idle" | "sent" | "quarantined" | "failed" | "settled">("idle");
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchJob(job.id).then((j) => live && setFull(j));
    return () => {
      live = false;
    };
  }, [open, job.id, job.updatedAt]);
  const steps = full?.steps ?? job.steps;
  const who = job.principal.displayName ?? job.principal.personId;
  return (
    <li className="rounded-lg bg-inset px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <button type="button" className="min-w-0 text-left text-sm font-medium [overflow-wrap:anywhere]" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {job.title}
        </button>
        <Badge tone={TONE[job.state]}>{JOB_STATE_LABEL[job.state]}</Badge>
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {job.kind} · {who} · <DeviceStatusSlot device={deviceFromRecord(job)} /> · <span className="ds-num">{job.stepCount}</span> step{job.stepCount === 1 ? "" : "s"}
        {job.quarantined ? " · quarantined: the stop wasn't confirmed" : ""}
      </p>
      {job.note && <p className="mt-1 text-xs text-muted-foreground">{job.note}</p>}
      {ACTIVE.includes(job.state) && (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-danger underline-offset-2 hover:underline disabled:opacity-60"
          disabled={stopping === "sent"}
          onClick={() => {
            setStopping("sent");
            void cancelJob(job.id)
              .then((r) => setStopping(r.quarantined ? "quarantined" : r.ok && r.state && !ACTIVE.includes(r.state) ? "settled" : r.ok ? "sent" : "failed"))
              .catch(() => setStopping("failed"));
          }}
        >
          {stopping === "sent" ? "Stopping… (a few seconds at most)" : stopping === "quarantined" ? "Stop not confirmed: quarantined" : stopping === "failed" ? "Couldn't stop it. Try again" : stopping === "settled" ? "Stopped" : "Stop"}
        </button>
      )}
      {(open ? steps : steps.slice(-3)).length > 0 && (
        <ol className="mt-2 space-y-1 border-t border-border pt-2">
          {(open ? steps : steps.slice(-3)).map((s) => (
            <StepRow key={s.seq} step={s} />
          ))}
        </ol>
      )}
      {open && full && full.receipts.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
          {full.receipts.map((r, i) => (
            <li key={`${r.requestId}-${i}`}>
              {r.provider} {r.model} · {r.route}
              {r.fallbackFrom ? ` · fell back from ${r.fallbackFrom}` : ""} · {r.outcome}
              {r.costUsd === null ? "" : ` · US$${r.costUsd.toFixed(4)}`}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function JobStepLog() {
  const [jobs, setJobs] = useState(readJobs);
  useEffect(() => {
    const stop = startJobEventBridge();
    const off = subscribeJobs((list) => setJobs([...list]));
    setJobs(readJobs());
    return () => {
      off();
      stop();
    };
  }, []);
  if (!jobs.length)
    return <EmptyState variant="row" title="No jobs recorded yet" body="Voice, screen, away, control, coding and memory jobs appear here with every step, once they run." />;
  return (
    <ol className="space-y-3" aria-label="Jobs">
      {jobs.slice(0, 20).map((j) => (
        <JobRow key={j.id} job={j} />
      ))}
    </ol>
  );
}
