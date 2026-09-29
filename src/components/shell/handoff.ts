// One shared handoff signal for the shell (Command scene today, any tile tomorrow). A handoff is real work
// moving between two places: Jarvis handing a coding task to the coding harness, a receptionist call
// passing to Leads. It comes from the durable job history or from a `os:handoff` event that the owning
// track emits; nothing here invents one. Motion follows the state: a step that was just confirmed travels
// once, and stays still while the work is waiting on a yes, while you read or edit, while Jarvis speaks,
// and under reduced motion. Pure (no DOM); bun-tested.
import type { JobSummary } from "@/lib/job-events";
import type { HoldReason } from "@/lib/motion";

/** "staff" is a place with no Command-scene object: a handoff to it shows in the list and lights nothing. */
export type HandoffPlace = "jarvis" | "receptionist" | "leads" | "coding" | "memory" | "finance" | "staff";
/** "unknown": the source is missing, unreadable, stale or gives no confirmation. Never drawn as moving. */
export type HandoffState = "queued" | "running" | "needs-you" | "done" | "failed" | "unknown";
export type Handoff = {
  id: string;
  from: HandoffPlace;
  to: HandoffPlace;
  state: HandoffState;
  /** Masked, one line. */
  label: string;
  /** Epoch ms of this state. A new state replays the travel once; the same state never loops. */
  at: number;
  deviceId?: string;
  /** One plain line saying what the state rests on (for example "count from the agency feed, not a single call"). */
  basis?: string;
  source: "job-history" | "event" | "receptionist-feed";
};

export const HANDOFF_EVENT = "os:handoff";
/** A finished handoff stays visible this long; running and waiting ones stay until they change. */
export const HANDOFF_LINGER_MS = 90_000;
const PLACES: readonly HandoffPlace[] = ["jarvis", "receptionist", "leads", "coding", "memory", "finance", "staff"];
const STATES: readonly HandoffState[] = ["queued", "running", "needs-you", "done", "failed", "unknown"];

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Announce a handoff (the track that owns the real event calls this). Browser only. */
export function emitHandoff(detail: Omit<Handoff, "source" | "at"> & { at?: number }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(HANDOFF_EVENT, { detail }));
}

/** Validate an `os:handoff` detail; anything malformed is dropped, never repaired. */
export function parseHandoff(detail: unknown, now = Date.now()): Handoff | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id || !PLACES.includes(d.from as HandoffPlace) || !PLACES.includes(d.to as HandoffPlace) || d.from === d.to || !STATES.includes(d.state as HandoffState)) return null;
  return {
    id: clip(d.id, 80),
    from: d.from as HandoffPlace,
    to: d.to as HandoffPlace,
    state: d.state as HandoffState,
    label: clip(typeof d.label === "string" ? d.label : "", 60) || "Handed off",
    at: typeof d.at === "number" && Number.isFinite(d.at) ? d.at : now,
    ...(typeof d.deviceId === "string" && d.deviceId ? { deviceId: clip(d.deviceId, 60) } : {}),
    source: "event",
  };
}

const JOB_HANDOFF: Partial<Record<JobSummary["state"], HandoffState>> = {
  queued: "queued",
  running: "running",
  "awaiting-approval": "needs-you",
  succeeded: "done",
  failed: "failed",
};

/** The Jarvis → Coding handoff for the newest coding job in the history, or null when it has ended long ago. */
export function codingHandoff(jobs: readonly Pick<JobSummary, "id" | "kind" | "state" | "title" | "updatedAt" | "targetDeviceId">[], now: number): Handoff | null {
  const job = [...jobs].filter((j) => j.kind === "coding").sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const state = job && JOB_HANDOFF[job.state];
  if (!job || !state) return null;
  const at = Date.parse(job.updatedAt) || 0;
  const h: Handoff = { id: `job:${job.id}`, from: "jarvis", to: "coding", state, label: clip(job.title, 60) || "Coding task", at, ...(job.targetDeviceId ? { deviceId: job.targetDeviceId } : {}), source: "job-history" };
  return isVisible(h, now) ? h : null;
}

export function isVisible(h: Handoff, now: number) {
  // A receptionist-feed row is the feed's CURRENT state, rebuilt from every read (and dropped to "unknown" when the read goes
  // stale), so it stays while it is true instead of lingering by its read time.
  if (h.source === "receptionist-feed") return true;
  return h.state === "queued" || h.state === "running" || h.state === "needs-you" || h.state === "unknown" || now - h.at < HANDOFF_LINGER_MS;
}

/** Newest handoff per id, visible ones only, newest first. */
export function visibleHandoffs(list: readonly Handoff[], now: number): Handoff[] {
  const byId = new Map<string, Handoff>();
  for (const h of list) {
    const prev = byId.get(h.id);
    if (!prev || h.at >= prev.at) byId.set(h.id, h);
  }
  return [...byId.values()].filter((h) => isVisible(h, now)).sort((a, b) => b.at - a.at);
}

/**
 * Should this handoff travel (one 2D sweep) or sit still? Travel only for work that is moving (queued,
 * running) and only when nothing else has the reader's attention. Waiting on a yes, finished, or failed
 * never animates. `deciding` is ignored: the Command scene is itself a dialog, so it would always hold.
 */
export function handoffMotion(h: Pick<Handoff, "state">, holds: readonly HoldReason[], reduced: boolean): "travel" | "still" {
  if (reduced) return "still";
  if (h.state !== "queued" && h.state !== "running") return "still";
  return holds.some((r) => r !== "deciding") ? "still" : "travel";
}

export const HANDOFF_STATE_LABEL: Record<HandoffState, string> = {
  queued: "Queued",
  running: "Working",
  "needs-you": "Waiting for your yes",
  done: "Done",
  failed: "Failed",
  unknown: "Not confirmed",
};

export const PLACE_LABEL: Record<HandoffPlace, string> = {
  jarvis: "Jarvis",
  receptionist: "Receptionist",
  leads: "Leads",
  coding: "Coding",
  memory: "Memory",
  finance: "Finance",
  staff: "Staff",
};

/** One sweep per handoff state per browser session: a refresh, a retry or reopening the scene never replays it. */
export function claimSweep(key: string, seen: Set<string>): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}
