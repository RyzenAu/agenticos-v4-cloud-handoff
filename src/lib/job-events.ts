// Job events on the client (Stage B2): the Jarvis chip and the Inspector step log read the ONE durable
// job history (/__jobs), and `jarvis:progress` / `jarvis:decision` are emitted FROM job events, not from
// each surface's private state. The mapping functions are pure (unit-tested with bun). The bridge FOLLOWS the live
// activity stream (/__events, one connection per browser) and keeps a slow safety poll; with no stream it polls
// /__jobs/events as before (S-stream: the stream replaced the 2 s / 15 s poll, never the fallback).
import type { JarvisPhase, JarvisProgress } from "@/components/shell/jarvis-progress";
import type { Job, JobEvent, JobState, JobSummary, Step } from "../../scripts/jobs/types";
import { activityHub, type ActivityMessage, type ActivitySnapshot } from "./activity-stream";
import { maskGoal, maskLine } from "./agent-feed";

export type { Job, JobEvent, JobState, JobSummary, Step };

/** How long a finished job stays on the chip (matches jarvis-progress LINGER_MS). */
export const JOB_LINGER_MS = 90_000;
/** A job waiting for a yes shows "needs you" only while the question can still be answered. */
export const JOB_ASK_WINDOW_MS = 2 * 60_000;

const PHASE: Record<JobState, JarvisPhase> = {
  queued: "thinking",
  running: "acting",
  "awaiting-approval": "needs-you",
  succeeded: "done",
  failed: "error",
  cancelled: "error",
  interrupted: "error",
  unknown: "error",
};
export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: "Queued",
  running: "Working",
  "awaiting-approval": "Waiting for your yes",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted, not re-run",
  unknown: "Outcome unknown",
};

/** The chip's progress for one job. Pure. Labels are masked like the screen run log. */
export function progressFromJob(job: JobSummary): JarvisProgress {
  const phase = PHASE[job.state];
  const title = maskGoal(job.title, 40);
  const label = phase === "acting" || phase === "thinking" ? title || JOB_STATE_LABEL[job.state] : phase === "done" ? title || "Done" : JOB_STATE_LABEL[job.state];
  const at = Date.parse(job.updatedAt) || Date.parse(job.createdAt) || 0;
  return {
    phase,
    label,
    ...(job.state === "running" && job.lastStep ? { step: { index: job.stepCount, text: maskLine(job.lastStep.intent, 120) } } : {}),
    startedAt: Date.parse(job.createdAt) || undefined,
    taskId: job.id,
    source: "jev",
    at,
  };
}

/** The job the chip should show: the newest active one, else the newest recently finished. Pure. */
export function focusJob(jobs: readonly JobSummary[], now: number): JobSummary | null {
  const byNewest = [...jobs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const active = byNewest.find((j) => j.state === "running" || j.state === "queued");
  if (active) return active;
  const waiting = byNewest.find((j) => j.state === "awaiting-approval" && now - Date.parse(j.updatedAt) < JOB_ASK_WINDOW_MS);
  if (waiting) return waiting;
  const done = byNewest[0];
  return done && done.state !== "awaiting-approval" && now - Date.parse(done.updatedAt) < JOB_LINGER_MS ? done : null;
}

/** An Inspector decision entry for a step Jev decided. Pure; null when the step has no Jev decision. */
export function decisionFromStep(job: Pick<JobSummary, "id" | "kind">, step: Step): { title: string; detail: string; confidence: number; source: "jev"; key: string } | null {
  if (!step.jev) return null;
  return {
    title: maskLine(`${step.jev.op} → ${step.jev.policy}`, 140),
    detail: maskLine(`${job.kind} step ${step.seq}: ${step.intent}`, 600),
    confidence: Math.min(1, Math.max(0, step.jev.confidence)),
    source: "jev",
    key: `job:${job.id}:${step.seq}`,
  };
}

/** Fold events into the job map (summaries plus the steps seen live). Pure: returns a new map. */
export function applyJobEvents(
  state: ReadonlyMap<string, JobSummary & { steps: Step[] }>,
  events: readonly JobEvent[],
  maxJobs = 40,
): Map<string, JobSummary & { steps: Step[] }> {
  const next = new Map(state);
  for (const e of events) {
    const cur = next.get(e.jobId);
    if (e.type === "job") next.set(e.jobId, { ...e.job, steps: cur?.steps ?? [] });
    else if (e.type === "step" && cur) {
      if (!cur.steps.some((s) => s.seq === e.step.seq)) {
        const steps = [...cur.steps, e.step].slice(-80);
        next.set(e.jobId, { ...cur, steps, stepCount: Math.max(cur.stepCount, e.step.seq), lastStep: e.step });
      }
    }
  }
  if (next.size > maxJobs) {
    const keep = [...next.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, maxJobs);
    return new Map(keep.map((j) => [j.id, j]));
  }
  return next;
}

// --- the bridge (browser only) -----------------------------------------------------------------------
type Jobs = Map<string, JobSummary & { steps: Step[] }>;
let jobs: Jobs = new Map();
let last = 0;
let users = 0;
let timer: number | undefined;
let onVisible: (() => void) | undefined;
let onNudge: (() => void) | undefined;
let backoffUntil = 0;
let lastProgressKey = "";
let seeded = false;
let offActivity: (() => void) | undefined;
let releaseActivity: (() => void) | undefined;
const listeners = new Set<(jobs: readonly (JobSummary & { steps: Step[] })[]) => void>();

export function readJobs() {
  return [...jobs.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
export function subscribeJobs(listener: (jobs: readonly (JobSummary & { steps: Step[] })[]) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function publish(events: readonly JobEvent[]) {
  for (const e of events) {
    if (e.type !== "step") continue;
    const job = jobs.get(e.jobId);
    const decision = job ? decisionFromStep(job, e.step) : null;
    if (decision) window.dispatchEvent(new CustomEvent("jarvis:decision", { detail: decision }));
  }
  const focus = focusJob(readJobs(), Date.now());
  if (focus) {
    const p = progressFromJob(focus);
    const key = `${focus.id}:${focus.state}:${focus.stepCount}`;
    if (key !== lastProgressKey) {
      lastProgressKey = key;
      window.dispatchEvent(new CustomEvent("jarvis:progress", { detail: p }));
    }
  }
  const list = readJobs();
  for (const l of listeners) l(list);
}

/** The stream is the reliable source right now: connected, and the hub has spoken lately. */
function streamIsHealthy() {
  try {
    return typeof window !== "undefined" && activityHub().healthy();
  } catch {
    return false;
  }
}

/** A read got an answer while the stream is down or waiting out a backoff: the hub is back, so reconnect now. */
function hubAnswered() {
  if (streamIsHealthy()) return;
  try {
    activityHub().retryNow();
  } catch {
    /* no stream here */
  }
}

/** Fold a stream message into the job map: a snapshot replaces it (durable truth), an event extends it. Idempotent. */
export function applyActivityToJobs(
  state: ReadonlyMap<string, JobSummary & { steps: Step[] }>,
  cursor: number,
  m: ActivityMessage,
): { jobs: Map<string, JobSummary & { steps: Step[] }>; cursor: number; events: JobEvent[]; refetch: boolean } {
  if (m.kind === "snapshot") {
    const list = (m.snapshot.jobs ?? []) as JobSummary[];
    return {
      jobs: new Map(list.map((j) => [j.id, { ...j, steps: state.get(j.id)?.steps ?? (j.lastStep ? [j.lastStep] : []) }])),
      cursor: m.snapshot.jobsHead ?? cursor,
      events: [],
      refetch: false,
    };
  }
  if (m.event.topic !== "job") return { jobs: new Map(state), cursor, events: [], refetch: false };
  if (m.event.truncated || !m.event.data?.event) return { jobs: new Map(state), cursor, events: [], refetch: true };
  const seq = Number(m.event.data.jobSeq);
  // A replay or an overlapping poll can hand over an event already folded: the job log's own seq says so.
  if (Number.isFinite(seq) && seq <= cursor) return { jobs: new Map(state), cursor, events: [], refetch: false };
  const event = m.event.data.event as JobEvent;
  return { jobs: applyJobEvents(state, [event]), cursor: Number.isFinite(seq) ? seq : cursor, events: [event], refetch: false };
}

function onActivity(m: ActivityMessage) {
  const r = applyActivityToJobs(jobs, last, m);
  jobs = r.jobs;
  last = r.cursor;
  if (m.kind === "snapshot") seeded = true;
  if (r.events.length) lastActivityAt = Date.now();
  if (m.kind === "snapshot" || r.events.length) publish(r.events);
  if (r.refetch) void poll(false);
}

async function poll(first: boolean) {
  // The first load always happens (a page opened in the background must not claim "no jobs"); only the
  // repeat polls pause while the page is hidden.
  if (!first && typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (Date.now() < backoffUntil) return;
  try {
    if (!first && streamIsHealthy()) {
      // The stream is carrying the changes: this is only the slow safety read, the same scoped snapshot a reconnect gets.
      const r = await fetch("/__events/snapshot");
      if (!r.ok) throw new Error(String(r.status));
      const snap = (await r.json()) as ActivitySnapshot;
      const applied = applyActivityToJobs(jobs, last, { kind: "snapshot", snapshot: snap });
      jobs = applied.jobs;
      last = applied.cursor;
      seeded = true;
      return publish([]);
    }
    if (first) {
      const [list, head] = await Promise.all([fetch("/__jobs?limit=20"), fetch("/__jobs/events?tail=1")]);
      if (!list.ok || !head.ok) throw new Error(String(list.status));
      hubAnswered();
      const seed = ((await list.json()) as { jobs: JobSummary[] }).jobs ?? [];
      jobs = new Map(seed.map((j) => [j.id, { ...j, steps: j.lastStep ? [j.lastStep] : [] }]));
      last = ((await head.json()) as { last: number }).last ?? 0;
      seeded = true;
      return publish([]);
    }
    const r = await fetch(`/__jobs/events?after=${last}`);
    if (!r.ok) throw new Error(String(r.status));
    hubAnswered();
    const data = (await r.json()) as { events: JobEvent[]; last: number };
    if (data.last < last) return void (seeded = false); // the store was reset: reseed next tick
    last = data.last;
    if (data.events.length) {
      lastActivityAt = Date.now();
      jobs = applyJobEvents(jobs, data.events);
      publish(data.events);
    }
  } catch {
    // Signed out, a quiet preview server or the store is down: try again later, quietly.
    backoffUntil = Date.now() + 30_000;
  }
}

/** Idle polling is slow (15 s: 4 requests a minute); anything running or just changed polls fast. */
export const JOB_IDLE_POLL_MS = 15_000;
const JOB_BUSY_WINDOW_MS = 60_000;
let lastActivityAt = 0;

/** Pure: how long to wait before the next poll. */
export const JOB_SAFETY_POLL_MS = 60_000;
export function nextPollDelay(fastMs: number, jobList: readonly Pick<JobSummary, "state">[], sinceActivityMs: number, streamHealthy = false): number {
  // With a healthy stream the changes arrive by themselves: one safety read a minute, busy or not.
  if (streamHealthy) return JOB_SAFETY_POLL_MS;
  const busy = jobList.some((j) => j.state === "running" || j.state === "queued" || j.state === "awaiting-approval") || sinceActivityMs < JOB_BUSY_WINDOW_MS;
  return busy ? fastMs : Math.max(fastMs, JOB_IDLE_POLL_MS);
}

/** Something just started a job (the voice companion, a button): poll now and fast for a minute. */
export function nudgeJobEvents() {
  lastActivityAt = Date.now();
  try {
    window.dispatchEvent(new CustomEvent("jobs:nudge"));
  } catch {
    /* best effort: lastActivityAt already makes the next poll fast */
  }
}

/** Start following job events (ref-counted; the chip and the Inspector both call it). */
export function startJobEventBridge(intervalMs = 2_000): () => void {
  if (typeof window === "undefined") return () => {};
  users++;
  if (users === 1) {
    const tick = () => poll(!seeded);
    const loop = () => {
      timer = window.setTimeout(() => {
        void tick().finally(() => {
          if (users > 0) loop();
        });
      }, nextPollDelay(intervalMs, readJobs(), Date.now() - lastActivityAt, streamIsHealthy()));
    };
    void tick();
    loop();
    try {
      const hub = activityHub();
      releaseActivity = hub.acquire();
      offActivity = hub.subscribe(onActivity);
    } catch {
      /* no stream available: polling carries on */
    }
    // Catch up at once when the page comes back into view, or when something starts a job.
    onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    onNudge = () => {
      lastActivityAt = Date.now();
      // A healthy stream brings the new job's events by itself; only poll when it can't.
      if (!streamIsHealthy()) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("jobs:nudge", onNudge);
    window.addEventListener("jarvis:protocol", onVisible);
  }
  return () => {
    users = Math.max(0, users - 1);
    if (users === 0) {
      offActivity?.();
      releaseActivity?.();
      offActivity = releaseActivity = undefined;
    }
    if (users === 0 && timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
      if (onVisible) {
        document.removeEventListener("visibilitychange", onVisible);
        if (onNudge) window.removeEventListener("jobs:nudge", onNudge);
        window.removeEventListener("jarvis:protocol", onVisible);
      }
      onVisible = undefined;
    }
  };
}

/** Ask the server to stop a job (cooperative flag + abort + tree-kill). */
export async function cancelJob(id: string): Promise<{ ok: boolean; quarantined: boolean }> {
  const t = await fetch("/__token").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const token = typeof t?.token === "string" ? t.token : "";
  const r = await fetch(`/__jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-claude-os-token": token },
    body: "{}",
  });
  const data = (await r.json().catch(() => ({}))) as { result?: { quarantined?: boolean } };
  return { ok: r.status === 202, quarantined: Boolean(data.result?.quarantined) };
}

/** Full job (every step and receipt) for the step log's expanded view. */
export async function fetchJob(id: string): Promise<Job | null> {
  const r = await fetch(`/__jobs/${encodeURIComponent(id)}`).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as { job: Job }).job ?? null;
}
