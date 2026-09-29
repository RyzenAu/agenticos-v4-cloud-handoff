// "Running now" on Today (UI-truth M8): what is running on the SERVER, not just what this browser
// tab started. Jobs come through a small adapter so the Stage B2 jobs service can replace the
// source without touching the page:
//
//   agentJobsAdapter   GET /__operator/agent-jobs (Claude Code / Codex jobs the OS runs)
//   (B2 jobs service)  add another adapter with the same shape and list it in RUNNING_SOURCES
//
// The tab's own hand-offs (src/lib/agent-feed.ts) are merged in, one row per job id.
import { redactText, type FeedTask } from "./agent-feed";

export type RunningItem = {
  /** Stable id: the server job id, or the feed task id for tab-only hand-offs. */
  id: string;
  title: string;
  agent: string;
  state: "running" | "queued" | "needs-you";
  detail: string;
  startedAt: string | null;
  /** Where this row comes from, shown beside it. */
  source: string;
};

export type RunningAdapter = {
  id: string;
  label: string;
  path: string;
  parse(body: unknown): RunningItem[];
};

const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
type JobRun = { agent?: string; status?: string; pending?: { title?: string }; events?: { label?: string }[] };
type Job = { id?: string; prompt?: string; createdAt?: string; runs?: JobRun[] };

/** Active runs of /__operator/agent-jobs: running, queued or waiting for the owner's answer. */
export const agentJobsAdapter: RunningAdapter = {
  id: "agent-jobs",
  label: "Agent jobs (server)",
  path: "/__operator/agent-jobs",
  parse(body) {
    const jobs = Array.isArray((body as { jobs?: unknown })?.jobs) ? ((body as { jobs: Job[] }).jobs) : [];
    const out: RunningItem[] = [];
    for (const job of jobs) {
      if (typeof job?.id !== "string") continue;
      const active = (job.runs ?? []).filter((r) => r?.status === "running" || r?.status === "queued" || r?.status === "needs_input");
      if (!active.length) continue;
      // One row per job: the most urgent run speaks for it (waiting on him > running > queued).
      const run = active.find((r) => r.status === "needs_input") ?? active.find((r) => r.status === "running") ?? active[0];
      const state = run.status === "needs_input" ? "needs-you" : run.status === "running" ? "running" : "queued";
      const last = run.events?.[run.events.length - 1]?.label;
      out.push({
        id: `job:${job.id}`,
        title: redactText(job.prompt || "Agent job", 90),
        agent: AGENT_NAME[run.agent ?? ""] ?? "Agent",
        state,
        detail: redactText(state === "needs-you" ? `Waiting for your answer${run.pending?.title ? `: ${run.pending.title}` : ""}` : last || (state === "queued" ? "Queued" : "Running"), 140),
        startedAt: typeof job.createdAt === "string" ? job.createdAt : null,
        source: agentJobsAdapter.label,
      });
    }
    return out;
  },
};

export const RUNNING_SOURCES: RunningAdapter[] = [agentJobsAdapter];

/** This tab's running hand-offs as rows (a finished or awaiting one is not "running"). */
export function runningFromFeed(tasks: FeedTask[]): RunningItem[] {
  return tasks
    .filter((t) => !t.endedAt)
    .map((t) => {
      const last = t.steps[t.steps.length - 1];
      return {
        id: t.jobId ? `job:${t.jobId}` : `feed:${t.id}`,
        title: t.title,
        agent: t.agent,
        state: "running" as const,
        detail: last ? `Step ${t.steps.length}: ${last.text}` : "Starting",
        startedAt: new Date(t.startedAt).toISOString(),
        source: "This tab",
      };
    });
}

/** Server rows first (they're the truth for a job), then tab-only hand-offs; one row per id. */
export function mergeRunning(server: RunningItem[], local: RunningItem[]): RunningItem[] {
  const seen = new Set<string>();
  return [...server, ...local].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
