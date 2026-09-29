import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { insidePath, realResolve } from "./agent-jobs-guard";
import { assistantBinary, claudeSignInStatus } from "./assistant-runtime";
import { discoverCodexModels } from "./assistant-adapters";
import { withConnectedRead } from "./codex-connected-read";
import { safeAgentText, startCodexJob } from "./agent-jobs-codex";
import { startClaudeJob } from "./agent-jobs-claude";
import type {
  AgentAdapterEvent,
  AgentId,
  AgentJob,
  AgentRun,
  AgentRunHandle,
  AgentRunInput,
  AgentStatus,
} from "./agent-jobs-types";

const ACTIVE = new Set(["queued", "running", "needs_input"]);
const CHECK_TEXT = "JARVIS_AGENT_CHECK_OK";
const CHECK_PROMPT = `Run this harmless local functionality check. In your current task directory, create agent-check.txt containing exactly ${CHECK_TEXT} followed by a newline. Read the file back using your tools and report its exact content. Do not read any other local files, use external apps, send messages, browse, change settings, or write outside this directory. This checks native generation and local tool execution only, not external sending permissions.`;
const now = () => new Date().toISOString();
/** OS changes never run in the live checkout (CODING-HARNESS C1 (d), owner decision 6). */
export const IMPROVE_OS_REFUSAL =
  "Improving this OS now runs in Coding, in an isolated worktree, so no agent edits the live checkout. Use Coding.";
const RESTART_INTERRUPTED =
  "Interrupted: the OS restarted before this agent finished. Nothing was replayed. Check its saved task and any external action before starting it again.";
const STOP_INTERRUPTED =
  "Interrupted: the OS stopped during this task. Nothing was replayed. Check its saved result before starting it again.";
type Start = (input: AgentRunInput) => AgentRunHandle;
type Options = {
  start?: Partial<Record<AgentId, Start>>;
  status?: () => Promise<AgentStatus[]>;
  maxActive?: number;
  /** Read the stored history without rewriting it (a quiet second server must not
      mark the live server's running tasks as failed). */
  readOnly?: boolean;
  /** Where task folders are made. Must be OUTSIDE the live checkout; defaults to AGENT_TASKS_ROOT. */
  tasksRoot?: string;
};
/** Task folders live outside the live checkout (review B2): an agent's folder, anything it climbs to
 * with `..`, and the project files Claude loads from it are never the OS repo or its .operator-data. */
export const AGENT_TASKS_ROOT = join(homedir(), ".agentic-os", "agent-tasks");
export function agentJobs(root: string, options: Options = {}) {
  const base = join(root, ".operator-data"),
    folder = options.tasksRoot ?? AGENT_TASKS_ROOT,
    file = join(base, "agent-jobs.json");
  if (insidePath(realResolve(folder), realResolve(root)))
    throw new Error("Agent task folders must be outside the live OS checkout.");
  const handles = new Map<string, { handle: AgentRunHandle; controller: AbortController }>();
  // A terminal UI state can precede process exit. Keep its slot and workspace
  // reserved until the adapter confirms shutdown through handle.done.
  const busy = (job: AgentJob, run: AgentRun) =>
    ACTIVE.has(run.status) || handles.has(`${job.id}:${run.agent}`);
  const jobs: AgentJob[] = [];
  let stopped = false,
    saveTimer: ReturnType<typeof setTimeout> | undefined;
  let metadata: { at: number; agents: AgentStatus[] } | undefined,
    metadataPending: Promise<AgentStatus[]> | undefined;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, jobs }, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }
  function scheduleSave() {
    if (!saveTimer) {
      saveTimer = setTimeout(save, 150);
      saveTimer.unref();
    }
  }
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
      throw new Error("Task history cannot be opened safely.");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (stored.version !== 1 || !Array.isArray(stored.jobs))
      throw new Error("Task history has an unsupported format.");
    for (const value of stored.jobs.slice(-30)) {
      if (!value || typeof value.id !== "string" || !Array.isArray(value.runs)) continue;
      // A restart interrupts; it is not a failure, and nothing is replayed. An interrupted run
      // stays interrupted until someone explicitly starts the work again.
      for (const run of value.runs)
        if (ACTIVE.has(run.status)) {
          run.status = "interrupted";
          run.pending = undefined;
          run.error = RESTART_INTERRUPTED;
        }
      jobs.push(value);
    }
    if (!options.readOnly) save();
  }
  function emit(job: AgentJob, run: AgentRun, event: AgentAdapterEvent, cwd: string) {
    if (!ACTIVE.has(run.status)) return;
    job.updatedAt = now();
    if (event.type === "session") run.sessionId = safeAgentText(event.id, 200);
    if (event.type === "text")
      run.text = safeAgentText(event.append ? run.text + event.text : event.text, 32000);
    if (event.type === "progress") {
      run.events.push({ id: randomUUID(), at: now(), label: safeAgentText(event.label, 300) });
      if (run.events.length > 60) run.events.splice(0, run.events.length - 60);
    }
    if (event.type === "input") {
      const { type: _, ...pending } = event;
      run.pending = pending;
      run.status = "needs_input";
    }
    if (event.type === "input_resolved" && run.pending?.id === event.id) {
      run.pending = undefined;
      run.status = "running";
    }
    if (event.type === "error") {
      run.status = "failed";
      run.error = safeAgentText(event.message);
      run.pending = undefined;
    }
    if (event.type === "done") {
      run.status = "completed";
      run.pending = undefined;
      if (job.kind === "check") {
        try {
          const checkFile = join(cwd, "agent-check.txt"),
            info = lstatSync(checkFile);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.size > 100 ||
            readFileSync(checkFile, "utf8").trim() !== CHECK_TEXT
          )
            throw new Error();
          run.events.push({
            id: randomUUID(),
            at: now(),
            label: "Verified: local file created and content matched",
          });
        } catch {
          run.status = "failed";
          run.error =
            "The agent finished, but its local tool check did not create the expected file.";
        }
      }
    }
    if (!ACTIVE.has(run.status)) save();
    else scheduleSave();
  }
  function launch(job: AgentJob, run: AgentRun) {
    // Every task works in its own folder. The live checkout is never the working directory, and the
    // adapters refuse edits that reach it (protectedRoot).
    const cwd = join(folder, job.id, run.agent),
      key = `${job.id}:${run.agent}`;
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const readOnly = run.role === "review";
    const request = job.prompt;
    const prompt = readOnly
      ? `You are independently reviewing the user's request while Codex executes it in a separate task. Provide a useful approach, risks or checks. Do not execute external actions, send messages, modify files or change settings. This is an independent review, not proof of Codex's result.\n\nUSER REQUEST:\n${request}`
      : job.kind === "check"
        ? CHECK_PROMPT
        : request;
    run.status = "running";
    try {
      const start =
        options.start?.[run.agent] || (run.agent === "codex" ? startCodexJob : startClaudeJob);
      const handle = start({
        cwd,
        prompt,
        signal: controller.signal,
        readOnly,
        protectedRoot: root,
        onEvent: (event) => emit(job, run, event, cwd),
      });
      handles.set(key, { handle, controller });
      void handle.done
        .catch(() =>
          emit(
            job,
            run,
            {
              type: "error",
              message: "The agent stopped unexpectedly. Check its task before trying again.",
            },
            cwd,
          ),
        )
        .finally(() => {
          handles.delete(key);
          if (ACTIVE.has(run.status))
            emit(
              job,
              run,
              { type: "error", message: "The agent exited without confirming completion." },
              cwd,
            );
        });
    } catch (error) {
      emit(job, run, { type: "error", message: (error as Error).message }, cwd);
    }
  }
  /**
   * `requestedBy` is the verified principal behind the request (Stage B1), recorded for the activity
   * history; it never comes from the body.
   */
  function create(body: any, check = false, requestedBy?: AgentJob["requestedBy"]) {
    if (stopped) throw new Error("Tasks are shutting down. Refresh the OS.");
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !["requestId", "prompt", "targets", "workflow"].includes(k))
    )
      throw new Error("Choose an agent and describe the task.");
    if (typeof body.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId))
      throw new Error("A valid task request ID is required.");
    if (
      !Array.isArray(body.targets) ||
      !body.targets.length ||
      body.targets.length > 2 ||
      body.targets.some((id: unknown) => !["codex", "claude"].includes(id as string)) ||
      new Set(body.targets).size !== body.targets.length
    )
      throw new Error("Choose Codex, Claude or both.");
    if (body.workflow !== undefined && (check || !["build", "improve-os"].includes(body.workflow)))
      throw new Error("Choose Build something or Improve this OS.");
    const workflow = body.workflow as AgentJob["workflow"];
    if (workflow === "improve-os") throw new Error(IMPROVE_OS_REFUSAL);
    const targets = [...body.targets].sort() as AgentId[];
    const prompt = check
      ? "Check agent functionality"
      : typeof body.prompt === "string"
        ? body.prompt.trim()
        : "";
    if (!prompt || prompt.length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt))
      throw new Error("Describe your task in up to 12,000 characters.");
    const existing = jobs.find((job) => job.requestId === body.requestId);
    if (existing) {
      if (
        existing.prompt !== prompt ||
        existing.workflow !== workflow ||
        existing.kind !== (check ? "check" : "task") ||
        JSON.stringify(existing.runs.map((r) => r.agent).sort()) !== JSON.stringify(targets)
      )
        throw new Error("That task request ID was already used for different work.");
      return { job: structuredClone(existing) };
    }
    if (
      jobs.reduce((count, job) => count + job.runs.filter((run) => busy(job, run)).length, 0) + targets.length >
      (options.maxActive ?? 4)
    )
      throw new Error("Four agents are already working. Stop one or wait for it to finish.");
    while (jobs.length >= 30) {
      const index = jobs.findIndex((j) => j.runs.every((r) => !busy(j, r)));
      if (index < 0) throw new Error("Wait for an existing task to finish.");
      jobs.splice(index, 1);
    }
    const job: AgentJob = {
      id: randomUUID(),
      requestId: body.requestId,
      prompt,
      ...(workflow ? { workflow } : {}),
      kind: check ? "check" : "task",
      ...(requestedBy ? { requestedBy: { personId: requestedBy.personId, displayName: requestedBy.displayName.slice(0, 40), via: requestedBy.via } } : {}),
      createdAt: now(),
      updatedAt: now(),
      runs: targets.map((agent) => ({
        agent,
        role: check ? "check" : targets.length === 2 && agent === "claude" ? "review" : "execute",
        status: "queued",
        text: "",
        events: [],
      })),
    };
    jobs.push(job);
    save();
    for (const run of job.runs) launch(job, run);
    return { job: structuredClone(job) };
  }
  async function status() {
    if (!metadata || Date.now() - metadata.at > 30000) {
      metadataPending ??= (async () => {
        if (options.status) return options.status();
        const [codex, claude] = await Promise.all([discoverCodexModels(), claudeSignInStatus()]);
        let tools: string[] = [];
        if (codex.ready) {
          try {
            tools = await withConnectedRead(
              root,
              async ({ tools }) => {
                const keyCapability = (name: string) =>
                  /\.(send_email|create_draft|reply_to_email|read_email|read_email_thread|slack_send_message)$/.test(
                    name,
                  )
                    ? 0
                    : 1;
                return Object.keys(tools)
                  .filter((name) =>
                    /^(gmail|microsoft_outlook_email|slack|notion|github)\./.test(name),
                  )
                  .sort((a, b) => keyCapability(a) - keyCapability(b) || a.localeCompare(b))
                  .slice(0, 100);
              },
              { timeoutMs: 20000 },
            );
          } catch {
            /* Metadata unavailable is distinct from model sign-in. */
          }
        }
        return [
          {
            id: "codex" as const,
            installed: !!assistantBinary("codex"),
            signedIn: codex.ready,
            detail: codex.detail,
            tools,
            checkedAt: now(),
          },
          {
            id: "claude" as const,
            installed: claude.installed,
            signedIn: claude.ready,
            detail: claude.detail,
            tools: [],
            checkedAt: now(),
          },
        ];
      })();
      try {
        metadata = { at: Date.now(), agents: await metadataPending };
      } finally {
        metadataPending = undefined;
      }
    }
    return {
      agents: metadata.agents.map((agent) => {
        const checked = [...jobs]
          .reverse()
          .find((j) => j.kind === "check" && j.runs.some((r) => r.agent === agent.id));
        const run = checked?.runs.find((r) => r.agent === agent.id);
        return {
          ...agent,
          ...(checked && run
            ? {
                lastCheck: {
                  status: run.status,
                  at: checked.updatedAt,
                  detail:
                    run.error ||
                    (run.status === "completed"
                      ? "Native task and local file check passed. External actions were not tested."
                      : "Check in progress"),
                },
              }
            : {}),
        };
      }),
    };
  }
  return {
    list: () => ({ jobs: structuredClone([...jobs].reverse()) }),
    create,
    status,
    respond(body: any) {
      if (
        !body ||
        !["codex", "claude"].includes(body.agent) ||
        !["approve", "deny"].includes(body.decision)
      )
        throw new Error("Choose a response to the current agent request.");
      const job = jobs.find((j) => j.id === body.jobId),
        run = job?.runs.find((r) => r.agent === body.agent);
      if (!job || !run || run.status !== "needs_input" || run.pending?.id !== body.requestId)
        throw new Error("This agent request is no longer waiting for input.");
      if (
        body.answers !== undefined &&
        (!body.answers ||
          typeof body.answers !== "object" ||
          Array.isArray(body.answers) ||
          Object.keys(body.answers).length > 5 ||
          Object.values(body.answers).some((v) => typeof v !== "string" || v.length > 4000))
      )
        throw new Error("Use short text answers for this request.");
      const active = handles.get(`${job.id}:${run.agent}`);
      if (!active) throw new Error("The task has stopped. Check its saved result.");
      active.handle.respond(body.requestId, body.decision, body.answers);
      return { job: structuredClone(job) };
    },
    cancel(body: any) {
      const job = jobs.find((j) => j.id === body?.jobId);
      if (!job) throw new Error("Task not found.");
      if (body.agent && !["codex", "claude"].includes(body.agent))
        throw new Error("Unknown agent.");
      for (const run of job.runs.filter((r) => !body.agent || r.agent === body.agent)) {
        if (!ACTIVE.has(run.status)) continue;
        run.status = "cancelled";
        run.pending = undefined;
        run.error =
          "Stopped. An external action already in progress may still complete; check its source before retrying.";
        handles.get(`${job.id}:${run.agent}`)?.controller.abort();
      }
      job.updatedAt = now();
      save();
      return { job: structuredClone(job) };
    },
    close() {
      if (stopped) return;
      stopped = true;
      for (const job of jobs)
        for (const run of job.runs)
          if (ACTIVE.has(run.status)) {
            run.status = "interrupted";
            run.pending = undefined;
            run.error = STOP_INTERRUPTED;
            handles.get(`${job.id}:${run.agent}`)?.controller.abort();
          }
      if (jobs.length) save();
      else clearTimeout(saveTimer);
    },
  };
}
