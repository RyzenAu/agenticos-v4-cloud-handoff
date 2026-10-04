// R12 Jarvis: progress and results INLINE in the conversation. The thread's server entries for one job (started, steps, report, end)
// become one work card at the place the job started: who it was handed to ("Jarvis → Research: …"), its one state, the REAL step count
// (from the jobs API, never a count of thread lines or a backend sentence), what it is doing now, and its result, failure or question.
// Every update is kept, folded under the card. A journey (GET /__journeys) for this conversation renders as its steps instead of the
// separate cards of the jobs it ran.
import { useState } from "react";
import { ArrowUpRight, Square } from "lucide-react";
import { Button, Details, HandoffStep, RouteText, StatusLabel, fmtRelative } from "@/components/ds";
import { entryKind, hasSavedResult, jobIdOf, openJobHref, type EntryKind } from "@/lib/thread-events";
import { departmentOfBot, partyName, shortAsk, workStatus, type Journey, type WorkTaskState } from "@/lib/departments";
import { stopJobFromThread } from "@/lib/thread-stop";
import { JourneySteps } from "@/components/departments/parts";
import type { ThreadMessage } from "./jarvis-thread";

export type JobFacts = { id: string; title: string; state: string; bot: string | null; subjects: string[]; stepCount: number; createdAt: number; updatedAt: number };
export type ThreadItem = { type: "message"; m: ThreadMessage; index: number } | { type: "job"; jobId: string; entries: ThreadMessage[] } | { type: "journey"; journey: Journey };

/**
 * Pure: the thread as messages, job cards (one per job, at its first entry) and journeys (one per journey, at the first entry of any job
 * it ran; those jobs are not shown again as their own cards).
 */
export function groupThread(messages: readonly ThreadMessage[], journeys: readonly Journey[] = []): ThreadItem[] {
  const out: ThreadItem[] = [];
  const jobs = new Map<string, { type: "job"; jobId: string; entries: ThreadMessage[] }>();
  const journeyOf = new Map<string, Journey>();
  for (const j of journeys) for (const s of j.steps) if (s.jobId) journeyOf.set(s.jobId, j);
  const placed = new Set<string>();
  messages.forEach((m, index) => {
    const id = jobIdOf(m.via);
    if (!id) return void out.push({ type: "message", m, index });
    const journey = journeyOf.get(id);
    if (journey) {
      if (!placed.has(journey.id)) {
        placed.add(journey.id);
        out.push({ type: "journey", journey });
      }
      return;
    }
    let item = jobs.get(id);
    if (!item) {
      item = { type: "job", jobId: id, entries: [] };
      jobs.set(id, item);
      out.push(item);
    }
    item.entries.push(m);
  });
  return out;
}

const JOB_STATE: Record<string, WorkTaskState> = { queued: "queued", running: "working", "awaiting-approval": "needs-you", succeeded: "finished", failed: "failed", cancelled: "stopped", interrupted: "interrupted", unknown: "unknown" };
const KIND_STATE: Partial<Record<EntryKind, WorkTaskState>> = { started: "working", progress: "working", update: "working", waiting: "needs-you", finished: "finished", failed: "failed", stopped: "stopped", unknown: "unknown" };

/** Pure: the card's one state. The jobs API wins (it is the record); otherwise the newest thread entry that says something about state. */
export function jobCardState(entries: readonly ThreadMessage[], facts: JobFacts | null): WorkTaskState {
  if (facts && JOB_STATE[facts.state]) return JOB_STATE[facts.state];
  for (let i = entries.length - 1; i >= 0; i--) {
    const s = KIND_STATE[entryKind(entries[i].via) ?? "update"];
    if (s && entryKind(entries[i].via) !== "update") return s;
  }
  return "working";
}

const clean = (t: string) => t.replace(/\s*\(job [0-9a-f]{8}\)\.?\s*$/i, "").replace(/\nSaved result: [^\n]+$/m, "").trim();
const strip = (t: string) => clean(t).replace(/^(Started|Failed|Stopped|Finished|Waiting for you|Ended without a confirmed outcome):\s*/i, "").replace(/^Step \d+ of \d+:\s*/i, "");

/** Pure: the bot that handed work to this job before it (same CRM record, finished earlier in this thread), or null. */
export function handedFrom(facts: JobFacts | null, all: ReadonlyMap<string, JobFacts>): JobFacts | null {
  if (!facts?.bot || !facts.subjects.length) return null;
  const mine = departmentOfBot({ id: facts.bot }).id;
  return [...all.values()]
    .filter((o) => o.id !== facts.id && o.bot && o.state === "succeeded" && o.updatedAt <= facts.createdAt && departmentOfBot({ id: o.bot }).id !== mine && o.subjects.some((s) => facts.subjects.includes(s)))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

const nameOf = (bot: string) => partyName({ department: departmentOfBot({ id: bot }).id, agent: bot });

export function JobCard({ jobId, entries, facts, all, running, onChanged }: { jobId: string; entries: ThreadMessage[]; facts: JobFacts | null; all: ReadonlyMap<string, JobFacts>; running: boolean; onChanged: () => void }) {
  const [stop, setStop] = useState<{ busy: boolean; said: string | null }>({ busy: false, said: null });
  const state = jobCardState(entries, facts);
  const status = workStatus(state);
  const first = entries[0];
  const title = facts?.title ?? (first ? strip(first.text) : `Job ${jobId.slice(0, 8)}`);
  const report = [...entries].reverse().find((e) => entryKind(e.via) === "result");
  const last = entries.at(-1);
  const lastKind = entryKind(last?.via);
  const now = state === "working" ? [...entries].reverse().find((e) => entryKind(e.via) === "progress") : undefined;
  const ending = lastKind === "failed" || lastKind === "waiting" || lastKind === "unknown" || lastKind === "stopped" ? last : undefined;
  const resultHref = report && hasSavedResult(report.text) ? openJobHref(report.via, report.text) : null;
  const href = [...entries].reverse().map((e) => openJobHref(e.via, e.text)).find(Boolean) ?? `/activity#job-${jobId}`;
  const isCoding = href.startsWith("/coding/");
  const from = handedFrom(facts, all);
  const steps = facts ? (state === "queued" && !facts.stepCount ? "Not started yet" : `${facts.stepCount} step${facts.stepCount === 1 ? "" : "s"}`) : null;
  const when = facts ? (state === "queued" ? `asked ${fmtRelative(facts.createdAt)}` : state === "working" ? `started ${fmtRelative(facts.createdAt)}` : `updated ${fmtRelative(facts.updatedAt)}`) : null;
  const updates = entries.filter((e) => e !== report);
  return (
    <li className="max-w-[min(48rem,100%)] rounded-2xl border border-border bg-card px-4 py-3" data-job-card={jobId} data-state={state}>
      {facts?.bot ? (
        <HandoffStep from={from?.bot ? nameOf(from.bot) : "Jarvis"} to={nameOf(facts.bot)} label={shortAsk(title, 140)} status={{ state: status.state, label: status.label }} basis={from ? "Inferred: same client record, after its work finished" : undefined} className="py-0" />
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{title}</p>
          <StatusLabel state={status.state} label={status.label} size="sm" />
        </div>
      )}
      {(steps || when) && <p className="mt-1 text-xs text-muted-foreground" data-job-steps={facts?.stepCount ?? undefined}>{[steps, when].filter(Boolean).join(" · ")}</p>}
      {now && <p className="mt-2 text-sm text-foreground">Now: {strip(now.text)}</p>}
      {report && <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground"><RouteText>{clean(report.text)}</RouteText></p>}
      {ending && <p className={`mt-2 text-sm ${lastKind === "failed" ? "text-danger" : "text-foreground"}`}><RouteText>{strip(ending.text).replace(/^./, (c) => c.toUpperCase())}</RouteText></p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-4">
        {resultHref && (
          <a href={resultHref} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline">
            Open the result <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
        )}
        <a href={href} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {isCoding ? "See the changes" : "Open job"} <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </a>
        {running && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 rounded-full px-3"
            disabled={stop.busy}
            data-stop-job={jobId}
            onClick={async () => {
              setStop({ busy: true, said: null });
              const said = await stopJobFromThread(jobId);
              setStop({ busy: false, said });
              onChanged();
            }}
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" /> {stop.busy ? "Stopping…" : "Stop"}
          </Button>
        )}
      </div>
      {stop.said && <p role="status" className="text-sm text-foreground">{stop.said}</p>}
      {updates.length > 0 && (
        <Details summary="Updates" meta={String(updates.length)} className="mt-1">
          <ol className="flex flex-col gap-1">
            {updates.map((e, i) => <li key={`${i}:${e.via}`}>{clean(e.text)}</li>)}
          </ol>
        </Details>
      )}
    </li>
  );
}

export function JourneyItem({ journey }: { journey: Journey }) {
  return (
    <li className="max-w-[min(48rem,100%)]" data-thread-journey={journey.id}>
      <JourneySteps journey={journey} bots={[]} />
    </li>
  );
}
