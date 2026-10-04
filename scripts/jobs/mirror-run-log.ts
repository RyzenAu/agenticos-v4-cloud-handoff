// Mirror the Jarvis screen run log (screen-hands/run-log.ts, in memory only) into the durable Job store,
// so voice, screen and away runs appear in the ONE job and step history today, before the gates
// themselves migrate. Read-only with respect to the gates: it subscribes to the run log and never
// changes what screen hands does. Steps are already masked by the loop and are masked again here.
import type { RunLog, RunRecord, RunStep } from "../screen-hands/run-log";
import type { Principal } from "../approvals/principal";
import { maskJobText, type JobService, type Step, type StepOutcome } from "./service";

const HUB_DEVICE = "usman-pc";
/** A confirm re-run continues the waiting job within the question window (2 min). */
const CONTINUE_WINDOW_MS = 2 * 60_000;

function stepOutcome(s: RunStep): StepOutcome {
  switch (s.stage) {
    case "refused":
      return "refused";
    case "ask":
      return "asked";
    case "act":
    case "check":
      return s.verified === false ? "failed" : "ok";
    case "unsure":
      return "unknown";
    default:
      return "note";
  }
}

export function stepFromRun(run: RunRecord, s: RunStep): Omit<Step, "seq" | "at"> {
  return {
    intent: `${s.stage}: ${s.text}`,
    executor: run.executor,
    ...(run.window ? { target: run.window } : {}),
    ...(s.jev ? { jev: { op: s.jev.op, confidence: s.jev.confidence, policy: s.jev.policy, ms: s.jev.ms, inputTokens: s.jev.inputTokens, outputTokens: s.jev.outputTokens, decidedBy: s.jev.by ?? "unknown" } } : {}),
    ...(s.verified !== undefined ? { verification: { method: "deterministic-check", ok: s.verified } } : {}),
    ms: 0,
    outcome: stepOutcome(s),
  };
}

/**
 * Screen hands runs only for the person at this PC today (its routes refuse remote callers), so a
 * mirrored run is the loopback owner's unless the run names its target owner. B1's device routing
 * replaces this when remote executors arrive.
 */
function principalOf(run: RunRecord): Principal {
  const owner = run.target?.owner;
  return owner === "mehroz" ? { personId: "mehroz", via: "companion", deviceId: run.target?.deviceId } : { personId: "usman", via: "loopback-owner" };
}

export function mirrorRunLog(runs: Pick<RunLog, "subscribe">, jobs: JobService): () => void {
  const seen = new Map<string, { jobId: string; steps: number; ended: boolean }>();
  let lastAwaiting: string | null = null;
  return runs.subscribe((run) => {
    // A command-service run already writes its own Job (scripts/jarvis-command/service.ts): one job, not two.
    if (run.jobId) return;
    try {
      let entry = seen.get(run.id);
      if (!entry && lastAwaiting) {
        // The run that follows a yes (the same request, re-sent with the confirm) continues the waiting job:
        // one job, not an "interrupted" one plus a new one.
        const waiting = jobs.get(lastAwaiting);
        if (waiting && waiting.state === "awaiting-approval" && waiting.title === maskJobText(run.request || "Screen task", 200) && Date.parse(waiting.updatedAt) >= run.startedAt - CONTINUE_WINDOW_MS) {
          jobs.resumed(waiting.id);
          entry = { jobId: waiting.id, steps: 0, ended: false };
          seen.set(run.id, entry);
          lastAwaiting = null;
        }
      }
      if (!entry) {
        const job = jobs.create({
          kind: run.source === "away" ? "away" : "screen",
          principal: principalOf(run),
          targetDeviceId: run.target?.deviceId || HUB_DEVICE,
          title: run.request || "Screen task",
          requestId: `screen-run:${run.id}`,
        });
        jobs.begin(job.id);
        // A DIFFERENT request supersedes a run that ended waiting for a yes (one open question at a time).
        if (lastAwaiting) jobs.finish(lastAwaiting, "interrupted", "Superseded by a newer request before a yes.");
        lastAwaiting = null;
        entry = { jobId: job.id, steps: 0, ended: false };
        seen.set(run.id, entry);
        while (seen.size > 200) seen.delete(seen.keys().next().value as string);
      }
      for (const s of run.steps.slice(entry.steps)) jobs.step(entry.jobId, stepFromRun(run, s));
      entry.steps = run.steps.length;
      if (run.outcome && !entry.ended) {
        entry.ended = true;
        const o = run.outcome;
        if (o.stopped) jobs.finish(entry.jobId, "cancelled", "Stopped.");
        else if (o.ask) {
          jobs.finish(entry.jobId, "awaiting-approval", "Waiting for your yes.");
          lastAwaiting = entry.jobId;
        } else jobs.finish(entry.jobId, o.ok ? "succeeded" : "failed", o.said);
      }
    } catch {
      // The history must never break a run (read-only store, full disk): the run log keeps its own copy.
    }
  });
}
