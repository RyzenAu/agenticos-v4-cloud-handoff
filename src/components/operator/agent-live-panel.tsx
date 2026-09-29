// Live agent panel: when Jarvis hands work to Hermes, Claude Code / Codex, screen hands or an
// away-mode task, a panel slides in from the edge and streams the steps — tool calls, progress,
// then the result — the way a terminal would, inside the OS. Read-only. Sources are the existing
// streams: the voice companion's hand-off events (src/lib/agent-feed.ts), Hermes' own session
// (GET /__operator/hud/hermes), /agent-jobs and /away. Everything shown is redacted first.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Check, ChevronDown, ChevronRight, ChevronUp, Dot, Hand, Loader2, MessageSquareText, MonitorSmartphone, Moon, TerminalSquare, TriangleAlert, X } from "lucide-react";
import { dismissTask, feedStatus, redactText, setSteps, subscribeFeed, type FeedStep, type FeedTask } from "@/lib/agent-feed";
import { agentLabel, useAgentJobs, type AgentJob } from "./agent-jobs-panel";
import "./jarvis-hud-upgrade.css";

type HermesRun = { id: string; model: string | null; endedAt: string | null; activity: string | null; toolCalls: number; steps: FeedStep[] };
type AwayStatus = { on?: boolean; tasks?: { id: number; text: string; status: string; startedAt?: string; endedAt?: string; result?: string }[] };

const RECENT_MS = 90_000;
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Follows one Hermes hand-off: reads its session back every 1.5 s until the task ends. */
function useHermesFollow(task: FeedTask | undefined) {
  const running = !!task && task.kind === "hermes" && !task.endedAt;
  const lastPoll = useRef(0);
  const query = useQuery<{ run: HermesRun | null }>({
    queryKey: ["hud-hermes", task?.id],
    queryFn: async () => {
      const r = await fetch(`/__operator/hud/hermes?since=${task!.startedAt}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    enabled: !!task && task.kind === "hermes" && (running || Date.now() - (task.endedAt ?? 0) < 6000),
    refetchInterval: running ? 1500 : false,
    retry: false,
  });
  useEffect(() => {
    const run = query.data?.run;
    if (!task || !run || query.dataUpdatedAt === lastPoll.current) return;
    lastPoll.current = query.dataUpdatedAt;
    if (run.steps.length) setSteps(task.id, run.steps);
  }, [query.data, query.dataUpdatedAt, task]);
  return query.data?.run ?? null;
}

function jobTask(job: AgentJob): FeedTask {
  const active = job.runs.some((r) => ["queued", "running", "needs_input"].includes(r.status));
  const failed = job.runs.some((r) => r.status === "failed");
  return {
    id: `job:${job.id}`,
    kind: "agent-job",
    jobId: job.id,
    title: job.prompt,
    agent: job.runs.map((r) => (r.agent === "claude" ? "Claude Code" : agentLabel(r.agent))).join(" + "),
    startedAt: Date.parse(job.createdAt),
    endedAt: active ? undefined : Date.parse(job.updatedAt),
    ok: active ? undefined : !failed,
    result: active ? undefined : job.runs.map((r) => r.text || r.error || "").filter(Boolean).join("\n\n"),
    steps: job.runs.flatMap((r) =>
      r.events.map((e) => ({ at: e.at, kind: "progress" as const, name: r.agent === "claude" ? "claude" : "codex", text: e.label })),
    ),
  };
}

function awayTask(task: NonNullable<AwayStatus["tasks"]>[number]): FeedTask {
  const active = ["queued", "running", "awaiting_approval"].includes(task.status);
  return {
    id: `away:${task.id}`,
    kind: "away",
    title: task.text,
    agent: "Away mode",
    startedAt: Date.parse(task.startedAt ?? new Date().toISOString()),
    endedAt: active ? undefined : Date.parse(task.endedAt ?? new Date().toISOString()),
    ok: active ? undefined : task.status === "done",
    result: task.result,
    steps: [{ at: task.startedAt ?? new Date().toISOString(), kind: "progress", text: task.status.replace(/_/g, " ") }],
  };
}

const KIND_ICON = { hermes: TerminalSquare, screen: MonitorSmartphone, "agent-job": Bot, away: Moon } as const;

export function AgentLivePanel() {
  const [feed, setFeed] = useState<FeedTask[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [closing, setClosing] = useState(false);
  useEffect(() => subscribeFeed(setFeed), []);
  // A new hand-off always brings the panel back, expanded.
  useEffect(() => {
    const onNew = () => {
      setCollapsed(false);
      setClosing(false);
    };
    window.addEventListener("jarvis:agent-feed", onNew);
    return () => window.removeEventListener("jarvis:agent-feed", onNew);
  }, []);

  const followedJobs = feed.filter((t) => t.kind === "agent-job" && t.jobId).map((t) => t.jobId!);
  const jobs = useAgentJobs(followedJobs.length > 0);
  const away = useQuery<AwayStatus>({
    queryKey: ["hud-away"],
    queryFn: async () => (await fetch("/__operator/away", { cache: "no-store" })).json(),
    refetchInterval: 8000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const tasks = useMemo(() => {
    const byJob = new Map((jobs.data?.jobs ?? []).map((j) => [j.id, j]));
    const list: FeedTask[] = feed.map((t) => (t.kind === "agent-job" && t.jobId && byJob.get(t.jobId) ? { ...jobTask(byJob.get(t.jobId)!), id: t.id } : t));
    for (const task of away.data?.tasks ?? []) {
      const active = ["running", "awaiting_approval"].includes(task.status);
      const recent = task.endedAt && now - Date.parse(task.endedAt) < RECENT_MS;
      if (away.data?.on && (active || recent)) list.push(awayTask(task));
    }
    return list
      .filter((t) => !hidden.has(t.id))
      .filter((t) => !t.endedAt || now - t.endedAt < RECENT_MS)
      .sort((a, b) => Number(!!a.endedAt) - Number(!!b.endedAt) || b.startedAt - a.startedAt);
  }, [feed, jobs.data, away.data, hidden, now]);

  const hermesTask = tasks.find((t) => t.kind === "hermes");
  const hermes = useHermesFollow(hermesTask);
  const live = tasks.some((t) => !t.endedAt);
  useEffect(() => {
    if (!tasks.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [tasks.length]);

  // Keep the list scrolled to the newest step while it's streaming.
  const log = useRef<HTMLDivElement>(null);
  const stepCount = tasks.reduce((n, t) => n + t.steps.length, 0);
  useEffect(() => {
    const el = log.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [stepCount]);

  if (!tasks.length) return null;
  const closeAll = () => {
    setClosing(true);
    window.setTimeout(() => {
      setHidden((set) => new Set([...set, ...tasks.map((t) => t.id)]));
      for (const t of tasks) if (!t.kind.startsWith("away") && !t.id.startsWith("job:")) dismissTask(t.id);
      setClosing(false);
    }, 200);
  };
  const lead = tasks[0];
  const LeadIcon = KIND_ICON[lead.kind];
  return (
    <aside className={`alp${collapsed ? " is-collapsed" : ""}${closing ? " is-closing" : ""}`} aria-label="Live agent work" data-live={live}>
      <header className="alp-head">
        <span className="alp-pulse" data-live={live} aria-hidden="true" />
        <button type="button" className="alp-title" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          <LeadIcon size={14} />
          <span>{live ? `${lead.agent} working` : `${lead.agent} done`}</span>
          <span className="alp-count">
            {tasks.length > 1 ? `${tasks.length} tasks` : `${lead.steps.length} step${lead.steps.length === 1 ? "" : "s"}`} · {clock((lead.endedAt ?? now) - lead.startedAt)}
          </span>
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button type="button" className="alp-icon" onClick={closeAll} aria-label="Close live agent panel">
          <X size={14} />
        </button>
      </header>
      {!collapsed && (
        <div className="alp-body" ref={log} role="log" aria-live="polite">
          {tasks.map((task) => {
            const Icon = KIND_ICON[task.kind];
            const isHermes = task.kind === "hermes" && task.id === hermesTask?.id;
            return (
              <section key={task.id} className="alp-task" data-state={feedStatus(task)}>
                <div className="alp-task-head">
                  <span className="alp-task-icon">
                    {feedStatus(task) === "needs-you" ? <Hand size={13} aria-label="Needs your yes" /> : task.endedAt ? task.ok ? <Check size={13} /> : <TriangleAlert size={13} /> : <Loader2 size={13} className="animate-spin" />}
                  </span>
                  <div>
                    <p className="alp-task-title">{task.title}</p>
                    <p className="alp-task-meta">
                      <Icon size={11} /> {task.agent}
                      {isHermes && hermes?.model ? ` · ${redactText(hermes.model, 40)}` : ""}
 · {clock((task.endedAt ?? now) - task.startedAt)}
                    </p>
                  </div>
                  {task.endedAt && (
                    <button type="button" className="alp-icon" aria-label="Dismiss task" onClick={() => (setHidden((s) => new Set([...s, task.id])), dismissTask(task.id))}>
                      <X size={12} />
                    </button>
                  )}
                </div>
                <ol className="alp-steps">
                  {task.steps.map((step, i) => (
                    <li key={i} data-kind={step.kind}>
                      <span className="alp-step-mark" aria-hidden="true">
                        {step.kind === "tool" ? <ChevronRight size={11} /> : step.kind === "result" ? <Check size={11} /> : step.kind === "error" ? <TriangleAlert size={11} /> : step.kind === "say" ? <MessageSquareText size={11} /> : <Dot size={11} />}
                      </span>
                      {step.name && <code className="alp-step-name">{step.name}</code>}
                      <span className="alp-step-text">{step.text}</span>
                    </li>
                  ))}
                  {!task.endedAt && (
                    <li data-kind="waiting" className="alp-cursor">
                      <span className="alp-step-mark" aria-hidden="true">
                        <ChevronRight size={11} />
                      </span>
                      <span className="alp-step-text">{isHermes && hermes?.activity ? hermes.activity : "working"}</span>
                      <i aria-hidden="true" />
                    </li>
                  )}
                </ol>
                {task.endedAt && task.result && <p className="alp-result">{task.result}</p>}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}
