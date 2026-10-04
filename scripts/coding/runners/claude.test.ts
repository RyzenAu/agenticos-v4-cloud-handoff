import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempRoot } from "../test-fixtures";
import { claudeRunner } from "./claude";
import { FakeClaude, fakeSpawn, type FakeClaudeOptions } from "./fakes";
import type { PolicyFn, RunnerEvent, RunnerStart } from "./types";

const root = tempRoot("coding-claude-");
const cwd = join(root, "wt");
mkdirSync(cwd, { recursive: true });
afterAll(() => cleanup(root));

const SESSION = "11111111-2222-4333-8444-555555555555";
const allowAll: PolicyFn = () => ({ decision: "auto-allow", rule: "read-in-worktree", target: "x", message: "ok" });

function run(fake: FakeClaudeOptions, over: Partial<RunnerStart> = {}, opts: { killGraceMs?: number } = {}) {
  const proc = new FakeClaude(fake);
  const { spawn } = fakeSpawn(proc);
  const events: RunnerEvent[] = [];
  const controller = new AbortController();
  const handle = claudeRunner({ binary: "C:/fake/claude.exe", spawn, platform: "linux", env: { PATH: "/bin", OPENROUTER_API_KEY: "sk-or-secret-value-123456", ANTHROPIC_BASE_URL: "http://proxy" }, killGraceMs: opts.killGraceMs ?? 300, softEndMs: 50, tempDir: root }).start({
    jobId: "j", roleId: "builder-1", role: "builder",
    binding: { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max", model: "claude-opus-5-5", cliVersion: "2.1.280" },
    cwd, prompt: "Edit src/a.ts. Commit it.", system: "ROLE RULES: stay in your worktree.", readOnly: false,
    session: { mode: "new", id: SESSION }, policy: allowAll, signal: controller.signal, onEvent: (e) => events.push(e),
    limits: { wallMs: 5000, maxTurns: 40, inputTimeoutMs: 400 }, stopAtWindowPercent: 95, creditsAllowed: false,
    ...over,
  });
  return { proc, handle, events, controller };
}

describe("Claude runner: launch", () => {
  test("argv: model, pre-assigned session, manual permissions, no MCP, no user settings, no forbidden flags", async () => {
    const { proc, handle } = run({});
    const out = await handle.done;
    expect(out.status).toBe("succeeded");
    const a = proc.args;
    expect(a).toContain("--model"); expect(a[a.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(a[a.indexOf("--session-id") + 1]).toBe(SESSION);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("manual");
    expect(a[a.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(a).toContain("--strict-mcp-config");
    // REVIEW-T3 F1/F4: no settings files, hooks off, an explicit tool allowlist without Monitor/Task/Skill.
    expect(a).toContain("--restricted");
    expect(JSON.parse(a[a.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true });
    const tools = a[a.indexOf("--tools") + 1].split(",");
    expect(tools).toContain("Edit");
    for (const t of ["Monitor", "Task", "Skill", "CronCreate", "WebFetch"]) expect(tools).not.toContain(t);
    expect(a).toContain("Monitor");
    for (const bad of ["--bare", "--dangerously-skip-permissions", "--fallback-model", "-w", "--worktree"]) expect(a).not.toContain(bad);
    // Prompt on stdin, never argv; system text in a file that is gone afterwards.
    expect(a.join(" ")).not.toContain("Edit src/a.ts");
    expect(proc.sent.find((m) => m.type === "user")?.message?.content).toBe("Edit src/a.ts. Commit it.");
    const file = a[a.indexOf("--append-system-prompt-file") + 1];
    expect(file).toBeTruthy();
    expect(existsSync(file)).toBe(false);
  });
  test("resume uses --resume and plan mode for read-only roles", async () => {
    const { proc, handle } = run({}, { session: { mode: "resume", id: SESSION }, readOnly: true });
    await handle.done;
    expect(proc.args[proc.args.indexOf("--resume") + 1]).toBe(SESSION);
    expect(proc.args).not.toContain("--session-id");
    expect(proc.args[proc.args.indexOf("--permission-mode") + 1]).toBe("plan");
  });
  test("the child gets the allowlisted env only (no keys, no ANTHROPIC_* override)", async () => {
    const { proc, handle } = run({});
    await handle.done;
    const env = proc.options.env as Record<string, string>;
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
  test("a missing native session on resume is a protocol error, not a silent new session", async () => {
    const { handle } = run({ missingSession: true }, { session: { mode: "resume", id: SESSION } });
    const out = await handle.done;
    expect(out.status).toBe("failed");
    expect(out.error).toMatchObject({ code: "protocol_error" });
    expect(out.error!.message).toContain("native session not found");
  });
  test("a too-large schema fails before spawning", async () => {
    const { handle } = run({}, { jsonSchema: { x: "y".repeat(5000) } });
    expect((await handle.done).status).toBe("failed");
  });
});

describe("Claude runner: policy branches", () => {
  const edit = { tool: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } } as const;
  test("auto-allow answers allow with the original input", async () => {
    const { proc, handle, events } = run({ steps: [edit] });
    await handle.done;
    expect(proc.decisions[0]).toMatchObject({ behavior: "allow", updatedInput: edit.input });
    expect(events.find((e) => e.type === "policy")).toMatchObject({ nativeKind: "Edit", verdict: { decision: "auto-allow" } });
  });
  test("auto-deny answers deny with the policy message and the run continues", async () => {
    const policy: PolicyFn = () => ({ decision: "auto-deny", rule: "edit-not-owned", target: "x", message: "outside your owned files" });
    const { proc, handle } = run({ steps: [edit, { text: "Reported instead." }] }, { policy });
    const out = await handle.done;
    expect(proc.decisions[0]).toMatchObject({ behavior: "deny", message: "outside your owned files" });
    expect(out.status).toBe("succeeded");
  });
  test("escalate → input card → approve", async () => {
    const policy: PolicyFn = () => ({ decision: "escalate", rule: "unclassified", target: "x", message: "owner decides" });
    const { proc, handle, events } = run({ steps: [{ tool: "Bash", input: { command: "make" } }] }, { policy });
    for (let i = 0; i < 50 && !events.some((e) => e.type === "input"); i++) await Bun.sleep(5);
    const card = events.find((e) => e.type === "input") as Extract<RunnerEvent, { type: "input" }>;
    expect(card.request).toMatchObject({ kind: "approval", nativeKind: "Bash", escalatedBecause: "owner decides" });
    expect(() => handle.respond("wrong-id", "approve")).toThrow();
    handle.respond(card.request.id, "approve");
    await handle.done;
    expect(proc.decisions[0].behavior).toBe("allow");
    expect(events).toContainEqual({ type: "input_resolved", id: card.request.id, decision: "approve" });
  });
  test("escalate → deny", async () => {
    const policy: PolicyFn = () => ({ decision: "escalate", rule: "unclassified", target: "x", message: "?" });
    const { proc, handle, events } = run({ steps: [{ tool: "Bash", input: { command: "make" } }] }, { policy });
    for (let i = 0; i < 50 && !events.some((e) => e.type === "input"); i++) await Bun.sleep(5);
    const card = events.find((e) => e.type === "input") as Extract<RunnerEvent, { type: "input" }>;
    handle.respond(card.request.id, "deny");
    await handle.done;
    expect(proc.decisions[0].behavior).toBe("deny");
  });
  test("escalate → no answer → expired deny", async () => {
    const policy: PolicyFn = () => ({ decision: "escalate", rule: "unclassified", target: "x", message: "?" });
    const { proc, handle, events } = run({ steps: [{ tool: "Bash", input: { command: "make" } }] }, { policy });
    await handle.done;
    expect(proc.decisions[0].behavior).toBe("deny");
    expect(events.some((e) => e.type === "input_resolved" && e.decision === "expired")).toBe(true);
  });
  test("a question is escalated and the answers go back to Claude", async () => {
    const q = { tool: "AskUserQuestion", input: { questions: [{ question: "Which timezone?", options: [{ label: "AEST" }, { label: "UTC" }] }] } };
    const policy: PolicyFn = (r) => ({ decision: r.kind === "question" ? "escalate" : "auto-allow", rule: "unclassified", target: "q", message: "question" });
    const { proc, handle, events } = run({ steps: [q] }, { policy });
    for (let i = 0; i < 50 && !events.some((e) => e.type === "input"); i++) await Bun.sleep(5);
    const card = events.find((e) => e.type === "input") as Extract<RunnerEvent, { type: "input" }>;
    expect(card.request.kind).toBe("question");
    handle.respond(card.request.id, "approve", { "question-1": "AEST" });
    await handle.done;
    expect((proc.decisions[0].updatedInput as any).answers).toEqual({ "Which timezone?": "AEST" });
  });
  test("an MCP tool is presented to policy as MCP", async () => {
    const seen: string[] = [];
    const policy: PolicyFn = (r) => { seen.push(r.kind); return { decision: "auto-deny", rule: "mcp-tool", target: "m", message: "no MCP" }; };
    const { handle } = run({ steps: [{ tool: "mcp__filesystem__write_file", input: { path: "x" } }] }, { policy });
    await handle.done;
    expect(seen).toEqual(["mcp"]);
  });
  test("25 denies stop the run as a policy violation", async () => {
    const policy: PolicyFn = () => ({ decision: "auto-deny", rule: "edit-not-owned", target: "x", message: "no" });
    const { handle } = run({ steps: Array.from({ length: 30 }, () => edit) }, { policy });
    const out = await handle.done;
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("policy_violation");
  });
});

describe("Claude runner: usage, limits, stops", () => {
  test("usage, the model that ran and the API-equivalent value come from the result", async () => {
    const { handle, events } = run({ result: { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, modelUsage: { "claude-haiku-4-5": { outputTokens: 1 }, "claude-opus-5-5": { outputTokens: 20 } }, total_cost_usd: 0.5, num_turns: 4 } });
    const out = await handle.done;
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: null });
    expect(out.providerModel).toBe("claude-opus-5-5");
    expect(out.valueUsdEquivalent).toBe(0.5);
    expect(out.turns).toBe(4);
    expect(out.sessionId).toBe(SESSION);
    expect(events.some((e) => e.type === "session" && e.id === SESSION)).toBe(true);
  });
  test("a different model in modelUsage is reported as what ran", async () => {
    const { handle } = run({ model: "claude-sonnet-5", result: { modelUsage: { "claude-sonnet-5": { outputTokens: 9 } } } });
    expect((await handle.done).providerModel).toBe("claude-sonnet-5");
  });
  test("a rejected rate-limit event stops the role as blocked_allowance", async () => {
    const { handle, events } = run({ steps: [{ rateLimit: { status: "rejected", resetsAt: 1790000000, rateLimitType: "five_hour" } }, { wait: 50 }] });
    const out = await handle.done;
    expect(out.status).toBe("blocked_allowance");
    expect(events.some((e) => e.type === "allowance")).toBe(true);
  });
  test("the VERIFIED 2.1.280 shape (unifiedWindows) gives every window; the end reading reaches the outcome", async () => {
    const { handle, events } = run({ steps: [{ rateLimit: { status: "allowed", resetsAt: 1790578800, rateLimitType: "five_hour", overageStatus: "rejected", unifiedWindows: { five_hour: { utilization: 0.65, resetsAt: 1790578800 }, seven_day: { utilization: 0.17, resetsAt: 1791165600 } } } }] });
    const out = await handle.done;
    expect(out.status).toBe("succeeded");
    const snap = (events.find((e) => e.type === "allowance") as any).snapshot;
    expect(snap.windows).toEqual([{ label: "5-hour", usedPercent: 65, resetsAt: new Date(1790578800000).toISOString() }, { label: "weekly", usedPercent: 17, resetsAt: new Date(1791165600000).toISOString() }]);
    expect(out.allowanceEnd?.windows[0].usedPercent).toBe(65);
    const high = run({ steps: [{ rateLimit: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: 1790578800 } } } }, { wait: 50 }] });
    expect((await high.handle.done).status).toBe("blocked_allowance");
  });
  test("utilisation at the stop threshold stops it too", async () => {
    const { handle } = run({ steps: [{ rateLimit: { status: "allowed_warning", utilization: 0.96, rateLimitType: "seven_day" } }, { wait: 50 }] });
    expect((await handle.done).status).toBe("blocked_allowance");
  });
  test("interrupt → interrupted (the session is kept)", async () => {
    const { handle } = run({ steps: [{ wait: 2000 }], stall: true });
    await Bun.sleep(30);
    handle.interrupt();
    const out = await handle.done;
    expect(out.status).toBe("interrupted");
    expect(out.sessionId).toBe(SESSION);
  });
  test("cancel → cancelled", async () => {
    const { handle } = run({ stall: true, steps: [{ wait: 2000 }] });
    await Bun.sleep(30);
    handle.cancel();
    expect((await handle.done).status).toBe("cancelled");
  });
  test("a child that never closes → termination_unverified", async () => {
    const { handle } = run({ stall: true, hang: true, steps: [{ wait: 2000 }] }, {}, { killGraceMs: 150 });
    await Bun.sleep(30);
    handle.cancel();
    const out = await handle.done;
    expect(out.status).toBe("termination_unverified");
  });
  test("the wall limit fails the run with a timeout", async () => {
    const { handle } = run({ stall: true, steps: [{ wait: 3000 }] }, { limits: { wallMs: 100, maxTurns: 5, inputTimeoutMs: 1000 } });
    const out = await handle.done;
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("timeout");
  });
  test("a sign-in failure is reported as signed_out", async () => {
    const { handle } = run({ initError: "Not logged in. Please run /login" });
    const out = await handle.done;
    expect(out.error?.code).toBe("signed_out");
  });
  test("every emitted text is redacted", async () => {
    const secret = "sk-ant-api03-" + "Z".repeat(40);
    const { handle, events } = run({ leak: `here is ${secret}`, result: { result: `final ${secret}` } });
    const out = await handle.done;
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(out.finalText).not.toContain(secret);
  });
});
