// Motion that explains progress (NEXUS-ADDENDUM item 4): a pipeline's step is done only when the event
// that proves it has been CONFIRMED (a job/step event from /__jobs, a receptionist feed event). Nothing
// is inferred ahead of its event and nothing animates before it; with no events the list is static.
// Pure: the component (src/components/shell/progress-steps.tsx) animates only steps that became done
// after it mounted.
import type { JobSummary, Step } from "../../scripts/jobs/types";

export type StepState = "pending" | "active" | "done" | "failed";
export type PipelineStep = { key: string; label: string; proof: string };
export type Pipeline = { id: string; title: string; steps: readonly PipelineStep[] };
/** A confirmed event: which step it proves, when, and where it came from. `ok: false` = that step failed. */
export type ProgressEvent = { key: string; at: number; source: string; ok?: boolean; detail?: string };
export type StepView = PipelineStep & { state: StepState; at?: number; source?: string; detail?: string };

export const CALL_PIPELINE: Pipeline = {
  id: "call",
  title: "Receptionist call",
  steps: [
    { key: "answered", label: "Answered", proof: "call started event from the receptionist feed" },
    { key: "qualified", label: "Qualified", proof: "call analysis: the caller's intent and details captured" },
    { key: "calendar-confirmed", label: "Calendar confirmed", proof: "booking CONFIRMED by the calendar adapter" },
    { key: "team-notified", label: "Team notified", proof: "staff alert delivered" },
  ],
};

export const CODING_PIPELINE: Pipeline = {
  id: "coding",
  title: "Coding task",
  steps: [
    { key: "assigned", label: "Assigned", proof: "the job was created in the job history" },
    { key: "building", label: "Building", proof: "the job is running with an agent step" },
    { key: "review", label: "Review", proof: "a review step or the job waiting for your yes" },
    { key: "tests", label: "Tests", proof: "a step verified by tests" },
  ],
};

/**
 * Each step's state from confirmed events only. `active` is the first step without its event, and only
 * once an earlier step has happened and the run hasn't ended (so a new or finished run never pretends).
 */
export function stepStates(pipeline: Pipeline, events: readonly ProgressEvent[], opts: { ended?: boolean } = {}): StepView[] {
  const byKey = new Map<string, ProgressEvent>();
  for (const e of events) {
    const prev = byKey.get(e.key);
    if (!prev || e.at >= prev.at) byKey.set(e.key, e);
  }
  let seenAny = false;
  let activeGiven = false;
  const views = pipeline.steps.map((s) => {
    const e = byKey.get(s.key);
    if (e) {
      seenAny = true;
      return { ...s, state: (e.ok === false ? "failed" : "done") as StepState, at: e.at, source: e.source, ...(e.detail ? { detail: e.detail } : {}) };
    }
    return { ...s, state: "pending" as StepState };
  });
  if (seenAny && !opts.ended && !views.some((v) => v.state === "failed")) {
    // the first pending step after the last done one is the one in progress
    let lastDone = -1;
    views.forEach((v, i) => v.state === "done" && (lastDone = i));
    for (let i = lastDone + 1; i < views.length && !activeGiven; i++) {
      if (views[i].state === "pending") {
        views[i] = { ...views[i], state: "active" };
        activeGiven = true;
      }
    }
  }
  return views;
}

/** Coding progress from the ONE job history (Job/Step events). Pure. */
export function codingEvents(job: JobSummary & { steps?: readonly Step[] }): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  const created = Date.parse(job.createdAt);
  out.push({ key: "assigned", at: Number.isFinite(created) ? created : 0, source: "job created (/__jobs)" });
  const steps = job.steps ?? (job.lastStep ? [job.lastStep] : []);
  const building = steps.find((s) => s.outcome !== "note" && !/review|test/i.test(`${s.intent} ${s.executor}`));
  if (building) out.push({ key: "building", at: building.at, source: `step ${building.seq}: ${building.executor}` });
  const review = steps.find((s) => /review/i.test(`${s.intent} ${s.executor}`));
  if (review) out.push({ key: "review", at: review.at, source: `step ${review.seq}`, ok: review.outcome === "failed" ? false : undefined });
  // Waiting for his yes is review IN PROGRESS, not done (review item 12): no review event is added, so the
  // review step shows as the active one after building.
  const tests = steps.find((s) => s.verification && /test/i.test(s.verification.method) && s.verification.ok !== null);
  if (tests) out.push({ key: "tests", at: tests.at, source: `step ${tests.seq}: ${tests.verification!.method}`, ok: tests.verification!.ok === false ? false : undefined });
  if (job.state === "failed" || job.state === "cancelled" || job.state === "interrupted") {
    const next = CODING_PIPELINE.steps.find((s) => !out.some((e) => e.key === s.key));
    if (next) out.push({ key: next.key, at: Date.parse(job.updatedAt) || 0, source: `job ${job.state}`, ok: false, detail: job.note });
  }
  return out;
}

/** A receptionist call event as the feed will publish it (per-call events). */
export type CallFeedEvent = { callId: string; type: "call.started" | "call.analysed" | "booking.confirmed" | "booking.failed" | "alert.sent" | "alert.failed"; at: string; source?: string };

const CALL_KEY: Record<CallFeedEvent["type"], { key: string; ok?: boolean }> = {
  "call.started": { key: "answered" },
  "call.analysed": { key: "qualified" },
  "booking.confirmed": { key: "calendar-confirmed" },
  "booking.failed": { key: "calendar-confirmed", ok: false },
  "alert.sent": { key: "team-notified" },
  "alert.failed": { key: "team-notified", ok: false },
};

/** Call progress for one call from its feed events. Pure. */
export function callEvents(callId: string, feed: readonly CallFeedEvent[]): ProgressEvent[] {
  return feed
    .filter((e) => e.callId === callId)
    .map((e) => ({ key: CALL_KEY[e.type].key, at: Date.parse(e.at) || 0, source: e.source ?? "receptionist feed", ...(CALL_KEY[e.type].ok === false ? { ok: false } : {}) }));
}

/**
 * The event timeline of a recorded synthetic call (the team's own demo call, 28 Sep film plan): offsets in ms
 * from the call start. Used only for the clearly labelled "simulated replay"; the replay feeds these through
 * the same path as real events, one at a time, so each step still moves only on its event.
 */
export const SYNTHETIC_CALL_REPLAY: readonly { type: CallFeedEvent["type"]; offsetMs: number }[] = [
  { type: "call.started", offsetMs: 0 },
  { type: "call.analysed", offsetMs: 1400 },
  { type: "booking.confirmed", offsetMs: 2900 },
  { type: "alert.sent", offsetMs: 3800 },
];
