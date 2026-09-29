// Client-side feed of work Jarvis has handed off: a Hermes run (control_pc), a screen task
// (screen_act), a Claude Code / Codex job (delegate_task). The voice companion reports start,
// steps and the end here; the live agent panel (agent-live-panel.tsx) shows it and fills in the
// detail from the existing streams (Hermes state via /hud/hermes, /agent-jobs, /away).
// Text shown here is redacted again at render time; nothing is persisted.

export type FeedKind = "hermes" | "screen" | "agent-job" | "away";
export type FeedStepKind = "tool" | "result" | "say" | "error" | "progress";
export type FeedStep = { at: string; kind: FeedStepKind; name?: string; text: string };
export type FeedTask = {
  id: string;
  kind: FeedKind;
  title: string;
  /** Who is doing it, in words ("Hermes", "Screen hands", "Claude Code"). */
  agent: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  result?: string;
  steps: FeedStep[];
  /** agent-job: the job id to follow on /agent-jobs. */
  jobId?: string;
  /**
   * Set when the run stopped to wait for his yes (a screen run's final button). The task is ended
   * but NOT done: every surface shows "Needs your yes" until `until` (epoch ms), never "Done".
   */
  needsYou?: { what?: string; until?: number };
};

/** One status for every surface, so an awaiting run never reads as done or failed. */
export type FeedStatus = "running" | "needs-you" | "done" | "failed";
export function feedStatus(task: Pick<FeedTask, "endedAt" | "ok" | "needsYou">): FeedStatus {
  if (!task.endedAt) return "running";
  if (task.needsYou) return "needs-you";
  return task.ok ? "done" : "failed";
}
export const FEED_STATUS_LABEL: Record<FeedStatus, string> = { running: "Running", "needs-you": "Needs your yes", done: "Done", failed: "Failed" };

type Listener = (tasks: FeedTask[]) => void;
let tasks: FeedTask[] = [];
const listeners = new Set<Listener>();
const MAX_TASKS = 8;
const MAX_STEPS = 60;

const emit = () => {
  for (const listener of listeners) listener(tasks);
};

/** Keys, tokens and anything inside a .env path, masked before display (mirrors scripts/hud-feed.ts). */
export function redactText(text: unknown, max = 240): string {
  let s = String(text ?? "")
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[token]")
    .replace(/\bbearer\s+\S{8,}/gi, "bearer [token]")
    .replace(/(?:[A-Za-z]:)?[^\s"'`]*[\\/]?\.env(?:\.[A-Za-z0-9_-]+)?\b[^\s"'`]*/g, "[.env hidden]")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=[hidden]")
    .replace(/\b[A-Za-z0-9_\-+/]{40,}={0,2}/g, "[hidden]")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

// Mirrors scripts/screen-hands/run-log.ts maskLine (not imported: that module is server-side).
const MASK_EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/gi;
const MASK_DIGITS = /\d[\d -]{6,}\d/g;
/** The run log's defensive masking: e-mail addresses and long digit runs (ISO dates stay). Pure. */
export function maskLine(text: unknown, max = 300): string {
  return String(text ?? "")
    .replace(MASK_EMAIL, "[email]")
    .replace(MASK_DIGITS, (m) => (/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) || m.replace(/\D/g, "").length < 7 ? m : "[number]"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// The run log records his goal with dictated text and file names as placeholders
// (scripts/screen-hands/jev-control.ts goalSlots). This mirrors that grammar on the client, so the
// chip and the feed never show more of a dictated goal than the run log does.
const CLAUSE_SPLIT = /(\s*,?\s+(?:and then|then|after that)\s+|\s*,\s*(?=(?:click|tap|press|hit|select|choose|pick|tick|untick|check|uncheck|type|enter|write|put|fill|scroll|go|open|focus|turn|switch|enable|disable|save|paste|set|change)\b)|\s+and\s+(?=(?:click|tap|press|type|enter|write|put|fill|open|save|paste|set|change)\b))/i;
const TYPE_CLAUSE = /^((?:please |now |then |jarvis,? )*(?:type|write|enter|put|input|key in|pop|paste)(?: in| out)?) (.+?)((?: (?:in|into|on) (?:there|here|it|this|that)(?: (?:field|box|bit|space))?| (?:in|into) (?:the |this |that )?.+?(?: field| box| input| bar| area)| here| there)?)([.!?]?)$/i;
const FILL_CLAUSE = /^((?:please |now |then |jarvis,? )*(?:fill(?: in| out)?|set|change) (?:the |this |that )?.+? (?:with|to|as)) (.+)$/i;
const SAVE_CLAUSE = /^((?:please |now |then |jarvis,? )*save(?: (?:it|this|that|the (?:file|note|document|doc|text)))? (?:as|to|into|under) (?:a file (?:called|named) )?)(.+)$/i;
const OPEN_CLAUSE = /^((?:please |now |then |jarvis,? )*open (?:the )?file (?:called |named )?)(.+)$|^((?:please |now |then |jarvis,? )*open )(["“']?(?:[a-z]:[\\/]|\\\\).+)$/i;
const QUOTED = /"[^"]{2,}"|“[^”]{2,}”|'[^']{3,}'/g;
const PATH = /(?:[a-z]:[\\/]|\\\\)[^\s"'`]+|\b[\w-]+\.(?:txt|docx?|xlsx?|csv|pdf|pptx?|md|json|png|jpe?g|zip)\b/gi;

/** His dictated goal with typed text as ⟨text N⟩ and files as ⟨file N⟩, then maskLine. Pure. */
export function maskGoal(goal: unknown, max = 160): string {
  let texts = 0;
  let files = 0;
  const parts = String(goal ?? "").replace(/\s+/g, " ").trim().split(CLAUSE_SPLIT);
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part; // a separator kept by the capture group
    let m = TYPE_CLAUSE.exec(part);
    if (m) return `${m[1]} ⟨text ${++texts}⟩${m[3]}${m[4]}`;
    m = FILL_CLAUSE.exec(part);
    if (m) return `${m[1]} ⟨text ${++texts}⟩`;
    m = SAVE_CLAUSE.exec(part);
    if (m) return `${m[1]}⟨file ${++files}⟩`;
    m = OPEN_CLAUSE.exec(part);
    if (m) return `${m[1] ?? m[3]}⟨file ${++files}⟩`;
    return part;
  });
  const masked = out
    .join("")
    .replace(QUOTED, () => `⟨text ${++texts}⟩`)
    .replace(PATH, () => `⟨file ${++files}⟩`);
  return maskLine(masked, max);
}

/** A feed title as every surface shows it: secrets redacted, then masked like the run log. */
export function feedTitle(title: unknown, max = 160): string {
  return maskGoal(redactText(title, 600), max);
}

export function readFeed() {
  return tasks;
}

export function subscribeFeed(listener: Listener) {
  listeners.add(listener);
  listener(tasks);
  return () => {
    listeners.delete(listener);
  };
}

export function startTask(task: Omit<FeedTask, "id" | "startedAt" | "steps"> & { id?: string; steps?: FeedStep[] }) {
  const id = task.id ?? `${task.kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const entry: FeedTask = { ...task, id, title: feedTitle(task.title), startedAt: Date.now(), steps: task.steps ?? [] };
  tasks = [entry, ...tasks.filter((t) => t.id !== id)].slice(0, MAX_TASKS);
  emit();
  window.dispatchEvent(new CustomEvent("jarvis:agent-feed", { detail: { id } }));
  return id;
}

export function addStep(id: string, step: Omit<FeedStep, "at"> & { at?: string }) {
  let changed = false;
  tasks = tasks.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    const next: FeedStep = { at: step.at ?? new Date().toISOString(), kind: step.kind, name: step.name, text: maskLine(redactText(step.text)) };
    return { ...t, steps: [...t.steps, next].slice(-MAX_STEPS) };
  });
  if (changed) emit();
}

/** Replace a task's steps wholesale (e.g. the Hermes run read back from its own session). */
export function setSteps(id: string, steps: FeedStep[]) {
  tasks = tasks.map((t) => (t.id === id ? { ...t, steps: steps.slice(-MAX_STEPS).map((s) => ({ ...s, text: maskLine(redactText(s.text)) })) } : t));
  emit();
}

export function endTask(id: string, outcome: { ok: boolean; result?: string; needsYou?: FeedTask["needsYou"] }) {
  tasks = tasks.map((t) =>
    t.id === id
      ? {
          ...t,
          endedAt: Date.now(),
          // Waiting for a yes is not success, whatever the caller passed.
          ok: outcome.needsYou ? false : outcome.ok,
          result: outcome.result ? maskLine(redactText(outcome.result, 600), 600) : t.result,
          needsYou: outcome.needsYou ? { what: outcome.needsYou.what ? maskLine(redactText(outcome.needsYou.what, 80), 80) : undefined, until: outcome.needsYou.until } : undefined,
        }
      : t,
  );
  emit();
}

export function dismissTask(id: string) {
  tasks = tasks.filter((t) => t.id !== id);
  emit();
}

/** For tests. */
export function resetFeed() {
  tasks = [];
  emit();
}
