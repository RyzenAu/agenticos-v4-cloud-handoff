// R12 Departments: reads the existing APIs once for every department view (Home, Departments, Jarvis). One source per fact: bots from the
// agents service, each bot's tasks and saved results from /__agents/bots/:id/{tasks,files}, journeys from GET /__journeys when the hub has
// it (feature-detected: a 404 means "not on this hub yet", and the views fall back to what jobs give).
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { readBots, isArchivedBot, type Bot } from "@/components/agents/workspace/bots";
import { serviceTask } from "@/components/agents/tasks/tasks";
import { streamRefetchInterval, useStreamInvalidate } from "@/lib/use-activity";
import { DEPARTMENTS, departmentOfBot, inferHandoffs, journeyHandoffs, parseJourney, type DeptTask, type DepartmentId, type HandoffView, type Journey } from "@/lib/departments";

type Json = Record<string, unknown>;
async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  try {
    const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
    const json = (r.headers.get("content-type") ?? "").includes("json");
    return { status: r.status, body: json ? await r.json().catch(() => null) : null };
  } catch {
    return { status: 0, body: null };
  }
}

const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

/** Pure: one row of /__agents/bots/:id/tasks as a department task (the state words are the Agents workspace's own, via serviceTask). */
export function deptTaskFrom(raw: unknown, botId: string, department: DepartmentId): DeptTask | null {
  const t = serviceTask(raw);
  if (!t) return null;
  const r = raw as Json;
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    stateWord: t.stateWord,
    botId,
    department,
    startedAt: ms(r.startedAt),
    endedAt: ms(r.endedAt),
    subjects: Array.isArray(r.subjects) ? r.subjects.filter((s): s is string => typeof s === "string").slice(0, 8) : [],
    kind: t.kind,
    progress: t.progress,
    blocker: t.blocker?.text ?? null,
    result: t.result ? { href: t.result.href, external: t.result.external } : null,
    jobHref: t.jobHref?.href ?? `/activity#job-${t.id}`,
  };
}

export type DeptResult = { id: string; title: string; summary: string; createdAt: number | null; href: string; external: boolean; botId: string; department: DepartmentId; subjects: string[] };

/** Pure: one row of /__agents/bots/:id/files as a saved result. A coding output opens on its job page (it has no saved copy). */
export function deptResultFrom(raw: unknown, botId: string, department: DepartmentId): DeptResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Json;
  const jobId = typeof r.jobId === "string" ? r.jobId : typeof r.artifact === "string" ? r.artifact.replace(/^artifact:/, "") : null;
  if (!jobId) return null;
  const coding = r.source === "coding";
  return {
    id: `${botId}:${jobId}`,
    title: typeof r.title === "string" && r.title ? r.title.slice(0, 160) : coding ? "Coding job" : "Saved result",
    summary: typeof r.summary === "string" ? r.summary.slice(0, 300) : "",
    createdAt: ms(r.createdAt),
    href: coding ? `/coding/${jobId.replace(/^coding:/, "")}?tab=changes` : `/__computers/artifacts/${encodeURIComponent(jobId)}`,
    external: !coding,
    botId,
    department,
    subjects: Array.isArray(r.subjects) ? r.subjects.filter((s): s is string => typeof s === "string").slice(0, 8) : [],
  };
}

export type JourneysRead = { status: "absent" } | { status: "error" } | { status: "ok"; journeys: Journey[] };
export async function readJourneys(query: { conversationId?: string; subject?: string } = {}): Promise<JourneysRead> {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => !!v) as [string, string][]).toString();
  const r = await getJson(`/__journeys${qs ? `?${qs}` : ""}`);
  if (r.status === 404 || r.status === 405 || r.status === 501) return { status: "absent" };
  const list = r.body && typeof r.body === "object" && Array.isArray((r.body as Json).journeys) ? ((r.body as Json).journeys as unknown[]) : null;
  if (r.status !== 200 || !list) return { status: "error" };
  return { status: "ok", journeys: list.map(parseJourney).filter((j): j is Journey => !!j).sort((a, b) => b.updatedAt - a.updatedAt) };
}

export function useJourneys(query: { conversationId?: string; subject?: string } = {}) {
  return useQuery({ queryKey: ["journeys", query.conversationId ?? "", query.subject ?? ""], queryFn: () => readJourneys(query), staleTime: 5_000, refetchInterval: (q: { state: { data?: JourneysRead } }) => (q.state.data?.status === "absent" ? false : streamRefetchInterval(20_000, 6_000)()), refetchIntervalInBackground: false, retry: false });
}

export type DeptBot = Bot & { department: DepartmentId; mappedBy: "table" | "name" | "default" };
export type DepartmentsModel =
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | {
      status: "ok";
      bots: DeptBot[];
      tasks: DeptTask[];
      results: DeptResult[];
      handoffs: HandoffView[];
      journeys: Journey[];
      journeysOnHub: boolean;
      /** Bots whose work couldn't be read (named, so a shorter list never looks complete). */
      unreadable: string[];
    };

export function useDepartments(): DepartmentsModel {
  useStreamInvalidate([["dept-tasks"], ["dept-files"]], ["job"], { debounceMs: 300 });
  const botsQ = useQuery({ queryKey: ["dept-bots"], queryFn: readBots, staleTime: 10_000, retry: false });
  const bots: DeptBot[] = useMemo(() => (botsQ.data?.status === "ok" ? botsQ.data.bots.filter((b) => !isArchivedBot(b)).map((b) => { const d = departmentOfBot(b); return { ...b, department: d.id, mappedBy: d.by }; }) : []), [botsQ.data]);
  const service = botsQ.data?.status === "ok" && botsQ.data.source === "agents-service";
  const taskQs = useQueries({ queries: bots.map((b) => ({ queryKey: ["dept-tasks", b.id], queryFn: () => getJson(`/__agents/bots/${encodeURIComponent(b.id)}/tasks?limit=50`), enabled: service, staleTime: 3_000, refetchInterval: streamRefetchInterval(20_000, 6_000), refetchIntervalInBackground: false, retry: false })) });
  const fileQs = useQueries({ queries: bots.map((b) => ({ queryKey: ["dept-files", b.id], queryFn: () => getJson(`/__agents/bots/${encodeURIComponent(b.id)}/files`), enabled: service, staleTime: 5_000, refetchInterval: streamRefetchInterval(30_000, 10_000), refetchIntervalInBackground: false, retry: false })) });
  const journeysQ = useJourneys();
  const taskData = taskQs.map((q) => q.data);
  const fileData = fileQs.map((q) => q.data);
  return useMemo<DepartmentsModel>(() => {
    if (botsQ.isLoading) return { status: "loading" };
    if (botsQ.data?.status === "unavailable") return { status: "unavailable", reason: botsQ.data.reason };
    if (!botsQ.data) return { status: "unavailable", reason: "The agents list couldn't be read." };
    if (!service) return { status: "unavailable", reason: "This hub doesn't run the agents service, so departments can't list their work yet." };
    if (taskData.some((d) => d === undefined)) return { status: "loading" };
    const tasks: DeptTask[] = [];
    const results: DeptResult[] = [];
    const unreadable: string[] = [];
    bots.forEach((b, i) => {
      const t = taskData[i];
      const rows = t && t.status === 200 && t.body && Array.isArray((t.body as Json).tasks) ? ((t.body as Json).tasks as unknown[]) : null;
      if (!rows) unreadable.push(b.name);
      for (const raw of rows ?? []) {
        const task = deptTaskFrom(raw, b.id, b.department);
        if (task) tasks.push(task);
      }
      const f = fileData[i];
      const files = f && f.status === 200 && f.body && Array.isArray((f.body as Json).files) ? ((f.body as Json).files as unknown[]) : [];
      for (const raw of files) {
        const r = deptResultFrom(raw, b.id, b.department);
        if (r) results.push(r);
      }
    });
    const journeys = journeysQ.data?.status === "ok" ? journeysQ.data.journeys : [];
    // A hand-off a journey records wins over one inferred for the same receiving task.
    const recorded = journeys.flatMap(journeyHandoffs);
    const covered = new Set(recorded.map((h) => h.taskId).filter(Boolean));
    const handoffs = [...recorded, ...inferHandoffs(tasks).filter((h) => !covered.has(h.taskId))].sort((a, b) => b.at - a.at);
    tasks.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    results.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return { status: "ok", bots, tasks, results, handoffs, journeys, journeysOnHub: journeysQ.data?.status === "ok", unreadable };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botsQ.isLoading, botsQ.data, service, bots, JSON.stringify(taskData.map((d) => d?.body ?? null)), JSON.stringify(fileData.map((d) => d?.body ?? null)), journeysQ.data]);
}

export const DEPARTMENT_ORDER: readonly DepartmentId[] = DEPARTMENTS.map((d) => d.id);
