// Jarvis progress: the data contract between the Jev track and the shell's Jarvis chip/panel.
// Pure (no Vite-only APIs) so it can be unit-tested with bun. See jarvis-slot.tsx for the contract.
import { feedTitle, maskGoal, maskLine, type FeedTask } from "@/lib/agent-feed";

export type JarvisPhase = "idle" | "listening" | "thinking" | "acting" | "needs-you" | "done" | "error";

export type JarvisProgress = {
  phase: JarvisPhase;
  /** Sentence case, ≤ 40 characters: "Opening Chrome", "Waiting for your yes". */
  label: string;
  /** The current step of a multi-step run. */
  step?: { index: number; total?: number; text: string };
  /** Epoch ms the run started (drives the elapsed time). */
  startedAt?: number;
  /** Agent-feed / execution id, so the Inspector can show the full run. */
  taskId?: string;
  source: "jev" | "voice" | "agent-feed";
  /** Epoch ms of this update. */
  at: number;
};

export type JarvisChipProps = { progress: JarvisProgress; onOpen: () => void; compact: boolean };
export type JarvisPanelProps = { progress: JarvisProgress; history: readonly JarvisProgress[]; onOpen: () => void };


export const IDLE: JarvisProgress = { phase: "idle", label: "Jarvis", source: "voice", at: 0 };
export const LINGER_MS = 90_000;
const PHASES: readonly JarvisPhase[] = ["idle", "listening", "thinking", "acting", "needs-you", "done", "error"];

/** Validates an incoming `jarvis:progress` detail; anything malformed is ignored. */
export function parseProgress(detail: unknown, now = Date.now()): JarvisProgress | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (!PHASES.includes(d.phase as JarvisPhase)) return null;
  // Masked like the screen run log: a label may carry his dictated goal.
  const label = typeof d.label === "string" ? maskGoal(d.label, 60) : "";
  const s = d.step as Record<string, unknown> | undefined;
  const step =
    s && typeof s.index === "number" && typeof s.text === "string"
      ? { index: Math.max(1, Math.floor(s.index)), total: typeof s.total === "number" ? Math.max(1, Math.floor(s.total)) : undefined, text: maskLine(s.text, 120) }
      : undefined;
  return {
    phase: d.phase as JarvisPhase,
    label: label || defaultLabel(d.phase as JarvisPhase),
    step,
    startedAt: typeof d.startedAt === "number" ? d.startedAt : undefined,
    taskId: typeof d.taskId === "string" ? d.taskId.slice(0, 80) : undefined,
    source: d.source === "voice" || d.source === "agent-feed" ? d.source : "jev",
    at: typeof d.at === "number" ? d.at : now,
  };
}

export function defaultLabel(phase: JarvisPhase) {
  return { idle: "Jarvis", listening: "Listening", thinking: "Thinking", acting: "Working", "needs-you": "Needs your yes", done: "Done", error: "Stopped" }[phase];
}

/**
 * Progress from the agent feed: the newest running task, else the newest finished one. A run that
 * stopped for his yes is `needs-you` (never `done`) until its confirmation window closes; labels
 * are masked like the screen run log, whatever the task carries.
 */
export function progressFromFeed(tasks: readonly FeedTask[], now = Date.now()): JarvisProgress | null {
  const running = tasks.find((t) => !t.endedAt);
  const task = running ?? tasks[0];
  if (!task) return null;
  const waiting = !running && task.needsYou ? task.needsYou : null;
  const until = waiting ? (waiting.until ?? (task.endedAt ?? 0) + LINGER_MS) : (task.endedAt ?? 0) + LINGER_MS;
  if (!running && now > until) return null;
  const last = task.steps[task.steps.length - 1];
  return {
    phase: running ? "acting" : waiting ? "needs-you" : task.ok ? "done" : "error",
    label: waiting ? defaultLabel("needs-you") : feedTitle(task.title, 60) || task.agent,
    step: running && last ? { index: task.steps.length, text: maskLine(last.text, 120) } : undefined,
    startedAt: task.startedAt,
    taskId: task.id,
    source: "agent-feed",
    at: task.endedAt ?? (last ? Date.parse(last.at) || task.startedAt : task.startedAt),
  };
}
