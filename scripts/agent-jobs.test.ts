import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AGENT_TASKS_ROOT, agentJobs, IMPROVE_OS_REFUSAL } from "./agent-jobs";
import { isOperatorSelfPath } from "../src/lib/memory-self-filter";
import type { AgentRunInput, AgentRunHandle } from "./agent-jobs-types";

const roots: string[] = [],
  services: ReturnType<typeof agentJobs>[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(deferShutdown = false) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-jobs-"));
  const tasks = mkdtempSync(join(tmpdir(), "jarvis-tasks-"));
  roots.push(root, tasks);
  const started: Array<{
    input: AgentRunInput;
    handle: AgentRunHandle;
    settle: () => void;
    responses: unknown[];
  }> = [];
  const start = (input: AgentRunInput) => {
    let settle!: () => void;
    const responses: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const handle: AgentRunHandle = {
      done,
      cancel: () => {
        input.onEvent({ type: "error", message: "Cancelled" });
        if (!deferShutdown) settle();
      },
      respond: (id, decision, answers) => {
        responses.push({ id, decision, answers });
        input.onEvent({ type: "input_resolved", id });
      },
    };
    input.signal.addEventListener("abort", () => handle.cancel());
    started.push({ input, handle, settle, responses });
    return handle;
  };
  const config = {
    start: { codex: start, claude: start },
    status: async () => [
      {
        id: "codex" as const,
        installed: true,
        signedIn: true,
        detail: "Fixture",
        tools: ["gmail.send_email"],
        checkedAt: new Date().toISOString(),
      },
    ],
  };
  const service = agentJobs(root, { ...config, tasksRoot: tasks });
  services.push(service);
  const create = (targets = ["codex"], prompt = "Create a local note") =>
    service.create({ requestId: randomUUID(), targets, prompt }).job;
  return { root, tasks, service, started, create, config: { ...config, tasksRoot: tasks } };
}

describe("Jarvis native task coordinator", () => {
  test("both runs start together in isolated directories, with Claude review only", () => {
    const f = fixture(),
      job = f.create(["codex", "claude"]);
    expect(f.started).toHaveLength(2);
    expect(job.runs.find((r) => r.agent === "codex")?.role).toBe("execute");
    expect(job.runs.find((r) => r.agent === "claude")?.role).toBe("review");
    expect(f.started.map((s) => s.input.readOnly).sort()).toEqual([false, true]);
    expect(new Set(f.started.map((s) => s.input.cwd)).size).toBe(2);
    expect(f.started.find((s) => !s.input.readOnly)?.input.prompt).toBe("Create a local note");
    expect(f.started.find((s) => s.input.readOnly)?.input.prompt).toContain(
      "independent review, not proof",
    );
  });
  test("Claude alone can execute the user's exact request without attaching OS context", () => {
    const f = fixture(),
      job = f.create(["claude"], "Summarize a file I name");
    expect(job.runs[0].role).toBe("execute");
    expect(f.started[0].input.readOnly).toBe(false);
    expect(f.started[0].input.prompt).toBe("Summarize a file I name");
  });
  test("matching request IDs deduplicate work and conflicting reuse is rejected", () => {
    const f = fixture(),
      body = { requestId: randomUUID(), targets: ["codex"], prompt: "Hello" };
    const first = f.service.create(body);
    expect(f.service.create(body).job.id).toBe(first.job.id);
    expect(f.started).toHaveLength(1);
    expect(() => f.service.create({ ...body, prompt: "Different" })).toThrow("different work");
  });
  test("bounds concurrent work and rejects invalid targets/extra inputs", () => {
    const f = fixture();
    f.create(["codex", "claude"]);
    f.create(["codex", "claude"]);
    expect(() => f.create()).toThrow("Four agents");
    expect(() => f.create(["codex", "codex"])).toThrow("Choose");
    expect(() =>
      f.service.create({
        requestId: randomUUID(),
        targets: ["codex"],
        prompt: "Hello",
        credentials: "ignored?",
      }),
    ).toThrow("Choose");
  });
  test("the OS workflow refuses to run in the live checkout and points to Coding", () => {
    const f = fixture();
    const body = {
      requestId: randomUUID(),
      targets: ["codex", "claude"],
      prompt: "Make the calendar clearer",
      workflow: "improve-os",
    };
    expect(() => f.service.create(body)).toThrow(IMPROVE_OS_REFUSAL);
    expect(IMPROVE_OS_REFUSAL).toContain("Use Coding");
    expect(f.started).toHaveLength(0);
    expect(f.service.list().jobs).toHaveLength(0);
    // The same work as an ordinary build still runs, isolated and with Claude read-only.
    const job = f.service.create({ ...body, workflow: "build" }).job;
    expect(f.started.every((s) => s.input.cwd.startsWith(join(f.tasks, job.id)))).toBe(true);
    expect(f.started.find((s) => s.input.readOnly)?.input.prompt).toContain("Do not execute external actions");
  });
  test("every run gets its own folder and the live checkout as its protected root", () => {
    const f = fixture(),
      job = f.create(["codex", "claude"]);
    for (const started of f.started) {
      expect(started.input.cwd).not.toBe(f.root);
      expect(started.input.cwd.startsWith(join(f.tasks, job.id))).toBe(true);
      expect(started.input.protectedRoot).toBe(f.root);
    }
  });
  test("build remains isolated and cannot accept caller-supplied paths or unknown workflows", () => {
    const f = fixture(),
      body = {
        requestId: randomUUID(),
        targets: ["codex"],
        prompt: "Build a new page",
        workflow: "build",
      };
    const job = f.service.create(body).job;
    expect(f.started[0].input.cwd).toBe(
      join(f.tasks, job.id, "codex"),
    );
    expect(f.started[0].input.prompt).toBe(body.prompt);
    expect(() => f.service.create({ ...body, cwd: "/tmp" })).toThrow("Choose");
    expect(() => f.service.create({ ...body, workflow: "anything" })).toThrow("Choose Build");
    expect(() => f.service.create({ ...body, workflow: "improve-os" }, true)).toThrow(
      "Choose Build",
    );
  });
  test("a retried OS-improvement request is refused every time and never starts an agent", () => {
    const f = fixture(true);
    const body = { requestId: randomUUID(), targets: ["codex"], prompt: "Improve Jarvis", workflow: "improve-os" };
    expect(() => f.service.create(body)).toThrow("Use Coding");
    expect(() => f.service.create(body)).toThrow("Use Coding");
    expect(f.started).toHaveLength(0);
  });
  test("stopping processes still count towards the concurrent task limit", async () => {
    const f = fixture(true);
    for (let i = 0; i < 4; i++) f.service.cancel({ jobId: f.create().id });
    expect(() => f.create()).toThrow("Four agents");
    f.started[0].settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.create().runs[0].status).toBe("running");
  });
  test("check success requires the real expected file, not an agent's success claim", () => {
    const f = fixture(),
      job = f.service.create({ requestId: randomUUID(), targets: ["codex", "claude"] }, true).job;
    expect(job.runs.every((r) => r.role === "check")).toBe(true);
    const [first, second] = f.started;
    writeFileSync(join(first.input.cwd, "agent-check.txt"), "JARVIS_AGENT_CHECK_OK\n");
    first.input.onEvent({ type: "done" });
    second.input.onEvent({ type: "done" });
    const result = f.service.list().jobs[0];
    expect(result.runs[0].status).toBe("completed");
    expect(result.runs[1].status).toBe("failed");
    expect(result.runs[1].error).toContain("expected file");
  });
  test("questions require exact job, agent and request ID, then clear when resolved", () => {
    const f = fixture(),
      job = f.create();
    f.started[0].input.onEvent({
      type: "input",
      id: "permission-1",
      kind: "question",
      title: "Which?",
      detail: "Pick",
      questions: [{ id: "q1", question: "Name" }],
    });
    expect(f.service.list().jobs[0].runs[0].status).toBe("needs_input");
    expect(() =>
      f.service.respond({ jobId: job.id, agent: "codex", requestId: "old", decision: "approve" }),
    ).toThrow("no longer");
    f.service.respond({
      jobId: job.id,
      agent: "codex",
      requestId: "permission-1",
      decision: "approve",
      answers: { q1: "Alice" },
    });
    expect(f.started[0].responses).toEqual([
      { id: "permission-1", decision: "approve", answers: { q1: "Alice" } },
    ]);
    expect(f.service.list().jobs[0].runs[0].pending).toBeUndefined();
    expect(() =>
      f.service.respond({
        jobId: job.id,
        agent: "codex",
        requestId: "permission-1",
        decision: "approve",
      }),
    ).toThrow("no longer");
  });
  test("stopping one agent preserves the other and late completion cannot undo cancellation", () => {
    const f = fixture(),
      job = f.create(["codex", "claude"]);
    f.service.cancel({ jobId: job.id, agent: "codex" });
    const stopped = f.started.find((s) => s.input.cwd.endsWith(`${sep}codex`))!;
    stopped.input.onEvent({ type: "done" });
    const result = f.service.list().jobs[0];
    expect(stopped.input.signal.aborted).toBe(true);
    expect(result.runs.find((r) => r.agent === "codex")?.status).toBe("cancelled");
    expect(result.runs.find((r) => r.agent === "claude")?.status).toBe("running");
  });
  test("persists privately, restores history without replaying interrupted work", () => {
    const f = fixture();
    f.create();
    const file = join(f.root, ".operator-data", "agent-jobs.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = agentJobs(f.root, f.config);
    services.push(restarted);
    expect(restarted.list().jobs[0].runs[0].status).toBe("interrupted");
    expect(restarted.list().jobs[0].runs[0].error).toContain("restarted");
    expect(restarted.list().jobs[0].runs[0].error).toContain("Nothing was replayed");
    expect(f.started).toHaveLength(1);
    // Interrupted stays interrupted: it can't be answered, cancelled into another state or relaunched.
    const job = restarted.list().jobs[0];
    expect(() => restarted.respond({ jobId: job.id, agent: "codex", requestId: "x", decision: "approve" })).toThrow("no longer");
    expect(restarted.cancel({ jobId: job.id }).job.runs[0].status).toBe("interrupted");
    expect(f.started).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });
  test("adapter failure and unexpected exit never become success", async () => {
    const f = fixture();
    f.create();
    f.started[0].settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.service.list().jobs[0].runs[0].status).toBe("failed");
    expect(f.service.list().jobs[0].runs[0].error).toContain("without confirming");
  });
  test("status separates native sign-in, tool discovery and a verified check", async () => {
    const f = fixture();
    const before = await f.service.status();
    expect(before.agents[0].signedIn).toBe(true);
    expect(before.agents[0].lastCheck).toBeUndefined();
    f.service.create({ requestId: randomUUID(), targets: ["codex"] }, true);
    writeFileSync(join(f.started[0].input.cwd, "agent-check.txt"), "JARVIS_AGENT_CHECK_OK\n");
    f.started[0].input.onEvent({ type: "done" });
    const after = await f.service.status();
    expect(after.agents[0].lastCheck?.status).toBe("completed");
    expect(after.agents[0].lastCheck?.detail).toContain("External actions were not tested");
  });
  test("task snapshots cannot mutate the job, and shutdown rejects new work", () => {
    const f = fixture(),
      job = f.create();
    job.prompt = "mutated";
    expect(f.service.list().jobs[0].prompt).toBe("Create a local note");
    f.service.close();
    expect(() => f.create()).toThrow("shutting down");
    expect(f.started[0].input.signal.aborted).toBe(true);
  });
  test("redacts known credentials and bounds progress/output", () => {
    const f = fixture();
    f.create();
    f.started[0].input.onEvent({ type: "text", text: "token sk-abcdefghijklmnop" });
    expect(f.service.list().jobs[0].runs[0].text).toContain("[redacted]");
    for (let i = 0; i < 70; i++)
      f.started[0].input.onEvent({ type: "progress", label: `Step ${i}` });
    f.started[0].input.onEvent({ type: "text", text: "x".repeat(50000) });
    const run = f.service.list().jobs[0].runs[0];
    expect(run.events).toHaveLength(60);
    expect(run.text.length).toBe(32000);
  });
});

test("a read-only copy never rewrites the live server's task history at start-up", () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-jobs-ro-"));
  roots.push(root);
  mkdirSync(join(root, ".operator-data"), { recursive: true });
  const file = join(root, ".operator-data", "agent-jobs.json");
  const stored = JSON.stringify({ version: 1, jobs: [{ id: "job-1", runs: [{ agent: "codex", status: "running" }] }] });
  writeFileSync(file, stored);
  const quiet = agentJobs(root, { readOnly: true });
  services.push(quiet);
  expect(readFileSync(file, "utf8")).toBe(stored);
  const live = agentJobs(root);
  services.push(live);
  expect(JSON.parse(readFileSync(file, "utf8")).jobs[0].runs[0].status).toBe("interrupted");
});

test("task folders live outside the live checkout; a tasks root inside it is refused (review B2)", () => {
  expect(AGENT_TASKS_ROOT).toBe(join(homedir(), ".agentic-os", "agent-tasks"));
  const root = mkdtempSync(join(tmpdir(), "jarvis-jobs-in-"));
  roots.push(root);
  expect(() => agentJobs(root, { tasksRoot: join(root, ".operator-data", "agent-tasks") })).toThrow("outside the live OS checkout");
  expect(() => agentJobs(root, { tasksRoot: root })).toThrow("outside the live OS checkout");
  // The memory filter still recognises the OS's own Claude task transcripts at the new location.
  const cwd = join(AGENT_TASKS_ROOT, "0123abcd", "claude");
  expect(isOperatorSelfPath(cwd)).toBe(true);
  expect(isOperatorSelfPath(cwd.replace(/[^A-Za-z0-9]/g, "-"))).toBe(true);
  expect(isOperatorSelfPath(join(homedir(), "source", "repos", "app"))).toBe(false);
});

test("stopping the OS with work active leaves it interrupted, not failed, and a restart keeps it so", () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-jobs-stop-"));
  const tasksRoot = mkdtempSync(join(tmpdir(), "jarvis-tasks-stop-"));
  roots.push(root, tasksRoot);
  const starts: AgentRunInput[] = [];
  const start = (input: AgentRunInput): AgentRunHandle => {
    starts.push(input);
    return { done: new Promise<void>(() => {}), cancel: () => {}, respond: () => {} };
  };
  const service = agentJobs(root, { start: { codex: start, claude: start }, tasksRoot });
  service.create({ requestId: randomUUID(), targets: ["codex"], prompt: "Long task" });
  service.close();
  const stored = JSON.parse(readFileSync(join(root, ".operator-data", "agent-jobs.json"), "utf8"));
  expect(stored.jobs[0].runs[0].status).toBe("interrupted");
  expect(stored.jobs[0].runs[0].error).toContain("stopped");
  const again = agentJobs(root, { start: { codex: start, claude: start }, tasksRoot });
  services.push(again);
  expect(again.list().jobs[0].runs[0].status).toBe("interrupted");
  expect(starts).toHaveLength(1);
});
