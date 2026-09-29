// "Progress from confirmed events" on the Jarvis page (NEXUS-ADDENDUM item 4). Two pipelines:
//   coding task   assigned → building → review → tests, from the ONE job history (/__jobs, job-events.ts)
//   receptionist  answered → qualified → calendar confirmed → team notified, from per-call feed events
// A step moves only when its event is confirmed. The agency feed doesn't publish per-call events yet, so
// the call pipeline says "setup required" and stays static; its replay of a recorded synthetic call is
// labelled "simulated" and feeds those events one at a time through the same path.
import { useEffect, useRef, useState } from "react";
import { Code2, PhoneCall, Play, Square } from "lucide-react";
import { Button, Disclosure, Widget } from "@/components/ds";
import { HONEST_LABEL } from "@/lib/honest-state";
import { readJobs, startJobEventBridge, subscribeJobs, type JobSummary, type Step } from "@/lib/job-events";
import { CALL_PIPELINE, CODING_PIPELINE, SYNTHETIC_CALL_REPLAY, callEvents, codingEvents, stepStates, type CallFeedEvent } from "@/lib/progress-steps";
import { ProgressSteps } from "./progress-steps";

type Tracked = JobSummary & { steps: Step[] };
const ENDED = new Set(["succeeded", "failed", "cancelled", "interrupted", "unknown"]);

function useCodingJob() {
  const [job, setJob] = useState<Tracked | null>(null);
  const [read, setRead] = useState(false);
  useEffect(() => {
    const stop = startJobEventBridge();
    const pick = (jobs: readonly Tracked[]) => {
      setRead(true);
      setJob(jobs.find((j) => j.kind === "coding") ?? null);
    };
    pick(readJobs());
    const unsub = subscribeJobs(pick);
    return () => {
      unsub();
      stop();
    };
  }, []);
  return { job, read };
}

export function ProgressPanel() {
  const { job, read } = useCodingJob();
  const coding = job ? stepStates(CODING_PIPELINE, codingEvents(job), { ended: ENDED.has(job.state) }) : stepStates(CODING_PIPELINE, []);

  const [replay, setReplay] = useState<CallFeedEvent[] | null>(null);
  const timers = useRef<number[]>([]);
  const stopReplay = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };
  useEffect(() => stopReplay, []);
  function startReplay() {
    stopReplay();
    const base = Date.now();
    setReplay([]);
    for (const e of SYNTHETIC_CALL_REPLAY)
      timers.current.push(
        window.setTimeout(() => setReplay((r) => [...(r ?? []), { callId: "synthetic-replay", type: e.type, at: new Date(base + e.offsetMs).toISOString(), source: "simulated replay" }]), e.offsetMs),
      );
  }
  const call = stepStates(CALL_PIPELINE, replay ? callEvents("synthetic-replay", replay) : [], { ended: replay?.length === SYNTHETIC_CALL_REPLAY.length });

  // L2 (29 Sep): two widgets in the Jarvis page's grid. The steps stay in view with their state word;
  // what each waiting step needs is on hover, and each pipeline's source and caveat fold under
  // "How this is tracked".
  return (
    <>
      <Widget
        icon={Code2}
        span={2}
        title={job ? `Coding task · ${job.title}` : "Coding task"}
        badge={HONEST_LABEL[!read ? "unknown" : job ? "live" : "unknown"]}
        data-progress="coding"
      >
        <ProgressSteps compact steps={coding} label="Coding task progress" />
        <Disclosure className="mt-2" triggerClassName="-mx-3" summary={<span className="text-muted-foreground">How this is tracked</span>}>
          <p className="text-sm text-muted-foreground">
            {job ? `Source: job history (/__jobs) · ${job.state}` : read ? "No coding job in the job history yet. When one is assigned its steps appear here as they are confirmed." : "Reading the job history…"}
          </p>
        </Disclosure>
      </Widget>
      <Widget
        icon={PhoneCall}
        span={2}
        title={`Receptionist call${replay ? " · synthetic replay" : ""}`}
        badge={HONEST_LABEL[replay ? "simulated" : "setup-required"]}
        data-progress="call"
        action={
          replay && replay.length < SYNTHETIC_CALL_REPLAY.length ? (
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => { stopReplay(); setReplay(null); }}>
              <Square className="h-3.5 w-3.5" aria-hidden="true" /> Stop replay
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="rounded-full" onClick={startReplay}>
              <Play className="h-3.5 w-3.5" aria-hidden="true" /> Replay a synthetic call
            </Button>
          )
        }
      >
        <ProgressSteps compact steps={call} label="Receptionist call progress" />
        <Disclosure className="mt-2" triggerClassName="-mx-3" summary={<span className="text-muted-foreground">How this is tracked</span>}>
          <p className="text-sm text-muted-foreground">
            {replay
              ? "Simulated: the event timeline of a recorded synthetic call, fed one event at a time through the same path real events will use."
              : "Setup required: the agency feed publishes per-client totals, not per-call events, so live calls can't be followed step by step yet."}
          </p>
        </Disclosure>
      </Widget>
    </>
  );
}
