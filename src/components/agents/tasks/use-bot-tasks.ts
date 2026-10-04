// Reads a bot's tasks and saved files from the existing APIs (or the agents service when it is on the hub). Nothing is cached or copied
// beyond react-query's own cache, so a job has one source and cannot diverge between this tab, Coding, Activity and Computers.
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Job, JobSummary } from "../../../../scripts/jobs/types";
import type { ArtifactMeta } from "../../../../scripts/computers/artifacts";
import { codingClient, type JobView } from "@/lib/coding-client";
import { fetchJob } from "@/lib/job-events";
import { streamRefetchInterval, useStreamInvalidate } from "@/lib/use-activity";
import type { ComputerView } from "@/lib/computers-client";
import type { Bot } from "../workspace/bots";
import { botFiles, codingTask, computerTask, jobIsOnComputer, mergeTasks, orderTasks, serviceFiles, serviceTask, taskIsOpen, type BotTask, type SavedFile } from "./tasks";

const DETAIL_LIMIT = 12;

type Json = Record<string, unknown>;
async function readJson(url: string): Promise<{ ok: boolean; status: number; body: Json | unknown[] | null }> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const json = (r.headers.get("content-type") ?? "").includes("json");
    return { ok: r.ok && json, status: r.status, body: json ? ((await r.json().catch(() => null)) as Json | unknown[] | null) : null };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** The agents service's task list, or "absent" when this hub doesn't have it (then the jobs APIs are read directly). */
export async function readServiceTasks(botId: string): Promise<{ status: "ok"; tasks: BotTask[] } | { status: "absent" } | { status: "error"; reason: string }> {
  const r = await readJson(`/__agents/bots/${encodeURIComponent(botId)}/tasks?limit=50`);
  if (r.ok && r.body && !Array.isArray(r.body) && Array.isArray(r.body.tasks)) return { status: "ok", tasks: r.body.tasks.map(serviceTask).filter((t): t is BotTask => !!t) };
  if (r.status === 0) return { status: "error", reason: "The hub couldn't be reached." };
  if (r.status === 401 || r.status === 403) return { status: "error", reason: "Sign in as a founder to see tasks." };
  return { status: "absent" };
}

async function readServiceFiles(botId: string): Promise<SavedFile[] | null> {
  const r = await readJson(`/__agents/bots/${encodeURIComponent(botId)}/files`);
  if (!r.ok || !r.body) return null;
  const rows = Array.isArray(r.body) ? r.body : Array.isArray((r.body as Json).files) ? (r.body as Json).files : null;
  return rows ? serviceFiles(rows) : null;
}

async function readControlJobs(): Promise<JobSummary[] | null> {
  const r = await readJson("/__jobs?kind=control&limit=100");
  return r.ok && r.body && !Array.isArray(r.body) && Array.isArray(r.body.jobs) ? (r.body.jobs as JobSummary[]) : null;
}

async function readArtifacts(): Promise<ArtifactMeta[] | null> {
  const r = await readJson("/__computers/artifacts");
  return r.ok && r.body && !Array.isArray(r.body) && Array.isArray(r.body.artifacts) ? (r.body.artifacts as ArtifactMeta[]) : null;
}

export type BotWork =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ok"; tasks: BotTask[]; files: SavedFile[]; source: "agents-service" | "jobs"; stale: boolean; notice: string | null };

export function useBotTasks(bot: Bot | null, computer: ComputerView | null): BotWork {
  const id = bot?.id ?? "";
  const enabled = !!bot;
  useStreamInvalidate([["agent-tasks", id], ["agent-jobs"], ["agent-coding"]], ["job", "computer"], { debounceMs: 200, enabled });
  const service = useQuery({ queryKey: ["agent-tasks", id], queryFn: () => readServiceTasks(id), enabled, staleTime: 3_000, refetchInterval: streamRefetchInterval(20_000, 6_000), refetchIntervalInBackground: false, retry: false });
  const viaJobs = enabled && service.data?.status === "absent";
  const jobs = useQuery({ queryKey: ["agent-jobs"], queryFn: readControlJobs, enabled: viaJobs && !!computer?.id, staleTime: 3_000, refetchInterval: streamRefetchInterval(20_000, 6_000), refetchIntervalInBackground: false, retry: false });
  const coding = useQuery({ queryKey: ["agent-coding"], queryFn: () => codingClient.list(), enabled: viaJobs && !!bot?.coding.enabled, staleTime: 3_000, refetchInterval: streamRefetchInterval(20_000, 6_000), refetchIntervalInBackground: false, retry: false });
  const artifacts = useQuery({ queryKey: ["computer-artifacts"], queryFn: readArtifacts, enabled, staleTime: 5_000, refetchInterval: streamRefetchInterval(30_000, 10_000), refetchIntervalInBackground: false, retry: false });
  const serviceFilesQ = useQuery({ queryKey: ["agent-files", id], queryFn: () => readServiceFiles(id), enabled: enabled && service.data?.status === "ok", staleTime: 5_000, retry: false });

  const mine = useMemo(() => (jobs.data ?? []).filter((j) => jobIsOnComputer(j, computer?.id ?? null)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [jobs.data, computer?.id]);
  const codingJobs = useMemo(() => (coding.data?.jobs ?? []).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [coding.data]);

  // Steps and receipts arrive per job, for the newest few; the rest show what the list itself knows.
  const detailQueries = useQueries({
    queries: mine.slice(0, DETAIL_LIMIT).map((j) => ({
      queryKey: ["agent-job-detail", j.id],
      queryFn: () => fetchJob(j.id),
      staleTime: 5_000,
      refetchInterval: ["queued", "running", "awaiting-approval"].includes(j.state) ? 3_000 : false,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });
  const viewQueries = useQueries({
    queries: codingJobs.slice(0, DETAIL_LIMIT).map((j) => ({
      queryKey: ["agent-coding-view", j.id],
      queryFn: () => codingClient.job(j.id),
      // The receipts change as the job runs; a finished job's do not.
      staleTime: ["completed", "failed", "cancelled"].includes(j.state) ? 60_000 : 4_000,
      refetchInterval: ["completed", "failed", "cancelled"].includes(j.state) ? (false as const) : 5_000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });

  return useMemo<BotWork>(() => {
    if (!bot) return { status: "loading" };
    if (service.isLoading) return { status: "loading" };
    if (service.data?.status === "error") return { status: "error", reason: service.data.reason };
    const arts = artifacts.data ?? [];
    if (service.data?.status === "ok") {
      const files = serviceFilesQ.data ?? botFiles(arts, bot.computer);
      return { status: "ok", tasks: orderTasks(service.data.tasks), files, source: "agents-service", stale: service.isError, notice: null };
    }
    if (service.isError) return { status: "error", reason: "The hub couldn't be reached." };
    if ((jobs.isLoading && !!computer?.id) || (coding.isLoading && bot.coding.enabled)) return { status: "loading" };
    // A source that failed is said, never hidden behind a shorter list that looks complete.
    const problems: string[] = [];
    if (computer?.id && (jobs.isError || jobs.data === null)) problems.push("the computer's jobs");
    if (bot.coding.enabled && coding.isError) problems.push("the coding jobs");
    const sources = (computer?.id ? 1 : 0) + (bot.coding.enabled ? 1 : 0);
    if (sources > 0 && problems.length === sources) return { status: "error", reason: "The jobs service didn't answer, so nothing can be listed. Nothing is shown rather than a guess." };
    const artifactById = new Map(arts.map((a) => [a.id, a]));
    const computerTasks = mine.map((j, i) => {
      const detail: Job | null | undefined = i < DETAIL_LIMIT ? detailQueries[i]?.data : undefined;
      return computerTask(j, { artifact: artifactById.get(j.id) ?? null, detail: detail ?? null, pausedJobId: computer?.paused?.jobId ?? null });
    });
    const codingTasks = bot.coding.enabled
      ? codingJobs.map((j, i) => codingTask(j, i < DETAIL_LIMIT ? ((viewQueries[i]?.data as JobView | undefined) ?? null) : null))
      : [];
    return { status: "ok", tasks: orderTasks(mergeTasks(computerTasks, codingTasks)), files: botFiles(arts, bot.computer), source: "jobs", stale: false, notice: problems.length ? `Couldn't read ${problems.join(" or ")}, so those are missing from this list.` : null };
  }, [bot, computer?.id, computer?.paused?.jobId, service.data, service.isLoading, service.isError, jobs.data, jobs.isLoading, jobs.isError, coding.data, coding.isLoading, coding.isError, artifacts.data, serviceFilesQ.data, mine, codingJobs, detailQueries, viewQueries]);
}

/** Pure: how many tasks are open, for the tab's count. */
export const openTaskCount = (tasks: readonly BotTask[]) => tasks.filter(taskIsOpen).length;
