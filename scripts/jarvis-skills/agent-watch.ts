// Agent alerts: when a delegated Codex/Claude job (agent-jobs) finishes, fails or stops to wait for
// him, or a chat turn in the OS waits on an approval card or finishes a long run, Jarvis posts one
// normal-priority event ("Codex has finished your task: fix the dental hero."). Status only: the
// label is the first few words of HIS task, never the agent's output, questions or transcript.
// Each alert has a dedupe key per job/run/state, so a restart or a replayed poll can't repeat it.
import { looksSecret } from "./text";

export type RunStatus = "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled" | "interrupted";
export type WatchedJob = {
  id: string;
  prompt: string;
  kind: "task" | "check";
  runs: Array<{ agent: "codex" | "claude"; role?: string; status: RunStatus; pending?: { id: string; kind: "approval" | "question" } }>;
};
export type LiveChat = { chatId: string; sessionId?: string; model?: string; startedAt: number; waiting?: number };
export type Alert = { source: string; text: string; priority: "normal"; dedupeKey: string };
export type WatchState = {
  seeded: boolean;
  runs: Record<string, string>;
  chats: Record<string, { startedAt: number; model?: string; waiting: boolean; episodes: number }>;
};

/** Chat runs shorter than this finish while he's still looking at them; no need to announce. */
export const CHAT_ANNOUNCE_AFTER_MS = 2 * 60_000;

const AGENT = { codex: "Codex", claude: "Claude" } as const;

/** "fix the dental hero image on mobile please" → "fix the dental hero image on mobile". */
export function taskLabel(prompt: string) {
  const first = prompt.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const words = first
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "")
    .replace(/\S{25,}/g, "")
    .replace(/^(?:(?:hey )?(?:jarvis|codex|claude)[,:\s]+)?(?:can you|could you|would you|please)\s+/i, "")
    .replace(/[`"“”*#>_[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  const label = words.slice(0, 8).join(" ").replace(/[.,;:!?]+$/, "");
  if (!label || looksSecret(label)) return null;
  return words.length > 8 ? `${label}…` : label;
}

const chatAgent = (model = "") =>
  /claude|sonnet|opus|haiku|fable/i.test(model) ? "Claude" : /codex|gpt|openai/i.test(model) ? "Codex" : "Your agent";

/**
 * One poll: compares jobs and live chats with what was seen last time and returns the alerts to post
 * and the next state. The first poll only records, so alerts never replay after a restart. Pure.
 */
export function agentAlerts(state: WatchState, jobs: WatchedJob[], chats: LiveChat[] | null, now: number): { alerts: Alert[]; state: WatchState } {
  const next: WatchState = { seeded: true, runs: { ...state.runs }, chats: { ...state.chats } };
  const alerts: Alert[] = [];
  for (const job of jobs) {
    if (job.kind === "check") continue;
    const label = taskLabel(job.prompt);
    const task = label ? `your task, “${label}”` : "your task";
    for (const run of job.runs) {
      const key = `${job.id}:${run.agent}`;
      const signature = run.status === "needs_input" ? `needs_input:${run.pending?.id ?? ""}` : run.status;
      const before = state.runs[key];
      next.runs[key] = signature;
      if (!state.seeded || before === signature) continue;
      const who = AGENT[run.agent] ?? "Your agent";
      if (run.status === "needs_input")
        alerts.push({
          source: "agent-watch",
          text: `${who} is waiting for your ${run.pending?.kind === "approval" ? "approval" : "answer"} on ${task}. It's in Tasks.`,
          priority: "normal",
          dedupeKey: `agent:${key}:input:${run.pending?.id ?? "x"}`,
        });
      else if (run.status === "completed")
        alerts.push({ source: "agent-watch", text: `${who} has finished ${task}.`, priority: "normal", dedupeKey: `agent:${key}:completed` });
      else if (run.status === "failed")
        alerts.push({ source: "agent-watch", text: `${who} couldn't finish ${task}. The details are in Tasks.`, priority: "normal", dedupeKey: `agent:${key}:failed` });
      else if (run.status === "interrupted")
        alerts.push({ source: "agent-watch", text: `${who} was interrupted on ${task}. Nothing was repeated; it's in Tasks.`, priority: "normal", dedupeKey: `agent:${key}:interrupted` });
    }
  }
  if (chats) {
    const live = new Map(chats.map((c) => [c.chatId, c]));
    for (const chat of chats) {
      const seen = state.chats[chat.chatId];
      const sameRun = seen && seen.startedAt === chat.startedAt;
      const waiting = (chat.waiting ?? 0) > 0;
      const episodes = sameRun ? seen.episodes : 0;
      const nowWaiting = waiting && !(sameRun && seen.waiting);
      next.chats[chat.chatId] = { startedAt: chat.startedAt, model: chat.model, waiting, episodes: episodes + (nowWaiting ? 1 : 0) };
      if (state.seeded && nowWaiting)
        alerts.push({
          source: "agent-watch",
          text: `${chatAgent(chat.model)} is waiting for your answer in chat.`,
          priority: "normal",
          dedupeKey: `chat:${chat.chatId}:${chat.startedAt}:wait:${episodes + 1}`,
        });
    }
    for (const [chatId, seen] of Object.entries(state.chats)) {
      if (live.has(chatId)) continue;
      delete next.chats[chatId];
      if (state.seeded && now - seen.startedAt >= CHAT_ANNOUNCE_AFTER_MS)
        alerts.push({ source: "agent-watch", text: `${chatAgent(seen.model)} has finished in chat.`, priority: "normal", dedupeKey: `chat:${chatId}:${seen.startedAt}:done` });
    }
  }
  // Forget runs of jobs that have dropped out of history.
  const alive = new Set(jobs.flatMap((j) => j.runs.map((r) => `${j.id}:${r.agent}`)));
  for (const key of Object.keys(next.runs)) if (!alive.has(key)) delete next.runs[key];
  return { alerts, state: next };
}

export type AgentWatchOptions = {
  jobs: () => { jobs: WatchedJob[] } | undefined;
  chats?: () => Promise<LiveChat[] | null>;
  submit: (alert: Alert) => unknown;
  intervalMs?: number;
  now?: () => number;
};

export function createAgentWatch(options: AgentWatchOptions) {
  let state: WatchState = { seeded: false, runs: {}, chats: {} };
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const now = options.now ?? Date.now;
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const jobs = options.jobs()?.jobs ?? [];
      let chats: LiveChat[] | null = null;
      try {
        chats = options.chats ? await options.chats() : null;
      } catch {
        chats = null;
      }
      // A failed chat read keeps the chat state as it was (no false "finished").
      const result = agentAlerts(state, jobs, chats, now());
      if (chats === null) result.state.chats = state.chats;
      state = result.state;
      for (const alert of result.alerts) {
        try {
          options.submit(alert);
        } catch {
          /* the gate refused one; the rest still go */
        }
      }
    } finally {
      busy = false;
    }
  }
  return {
    poll,
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), options.intervalMs ?? 10_000);
      (timer as { unref?: () => void }).unref?.();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Parses GET /__sessions_live. */
export function parseLiveChats(body: unknown): LiveChat[] {
  const runs = (body as { runs?: unknown })?.runs;
  if (!Array.isArray(runs)) return [];
  return runs
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as any).chatId === "string" && Number.isFinite(Number((r as any).startedAt)))
    .map((r) => ({
      chatId: String(r.chatId).slice(0, 120),
      startedAt: Number(r.startedAt),
      ...(typeof r.model === "string" ? { model: r.model.slice(0, 80) } : {}),
      ...(Number.isFinite(Number(r.waiting)) ? { waiting: Number(r.waiting) } : {}),
    }));
}
