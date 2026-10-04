import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempRoot } from "../test-fixtures";
import { codexAllowance, codexRunner } from "./codex";
import { FakeCodex, fakeSpawn, PLUS_LIMITS, type FakeCodexOptions } from "./fakes";
import type { PolicyFn, RunnerEvent, RunnerStart } from "./types";

const root = tempRoot("coding-codex-");
const cwd = join(root, "wt");
mkdirSync(join(cwd, "src"), { recursive: true });
afterAll(() => cleanup(root));

const allowAll: PolicyFn = () => ({ decision: "auto-allow", rule: "edit-owned", target: "x", message: "ok" });
const limits = (used: number, extra: Record<string, unknown> = {}) => ({ rateLimits: { ...PLUS_LIMITS.rateLimits, primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1790000000 }, ...extra } });

function run(fake: FakeCodexOptions, over: Partial<RunnerStart> = {}, opts: { killGraceMs?: number; slot?: "codex:openai-1" | "codex:openai-2" } = {}) {
  const proc = new FakeCodex(fake);
  const { spawn } = fakeSpawn(proc);
  const events: RunnerEvent[] = [];
  const controller = new AbortController();
  const handle = codexRunner({ binary: "C:/fake/codex.exe", spawn, platform: "linux", env: { PATH: "/bin", OPENAI_API_KEY: "sk-live-should-not-pass-123456", GITHUB_TOKEN: "x" }, killGraceMs: opts.killGraceMs ?? 300, softEndMs: 50, rpcTimeoutMs: 2000 }).start({
    jobId: "j", roleId: "builder-1", role: "builder",
    binding: { provider: "openai", route: "codex-app-server", accountSlot: opts.slot ?? "codex:openai-2", model: "gpt-6-astra", reasoningEffort: "medium", cliVersion: "0.154.0" },
    cwd, prompt: "Edit src/a.ts and commit.", system: "ROLE RULES", readOnly: false,
    session: { mode: "new", id: "unused" }, policy: allowAll, signal: controller.signal, onEvent: (e) => events.push(e),
    limits: { wallMs: 5000, maxTurns: 40, inputTimeoutMs: 400 }, stopAtWindowPercent: 95, creditsAllowed: false,
    ...over,
  });
  return { proc, handle, events, controller };
}

describe("Codex runner: launch and account", () => {
  test("handshake: ChatGPT account, limits read, thread with model/sandbox/untrusted approvals, prompt over JSON-RPC", async () => {
    const { proc, handle, events } = run({});
    const out = await handle.done;
    expect(out.status).toBe("succeeded");
    expect(proc.args).toEqual(["app-server", "--stdio", "-c", 'model_provider="openai"']);
    const m = proc.methods();
    expect(m.slice(0, 7)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read", "mcpServerStatus/list", "thread/start", "turn/start"]);
    const start = proc.sent.find((x) => x.method === "thread/start").params;
    expect(start).toMatchObject({ model: "gpt-6-astra", cwd, sandbox: "workspace-write", approvalPolicy: "untrusted", ephemeral: false });
    const turn = proc.sent.find((x) => x.method === "turn/start").params;
    expect(turn.input).toEqual([{ type: "text", text: "Edit src/a.ts and commit." }]);
    expect(turn.effort).toBe("medium");
    expect(events).toContainEqual({ type: "account", plan: "plus", accountType: "chatgpt" });
    expect(events.some((e) => e.type === "model" && e.model === "gpt-6-astra")).toBe(true);
    expect(out.accountPlan).toBe("plus");
    expect(out.allowanceEnd?.accountSlot).toBe("codex:openai-2");
  });
  test("env: allowlist only; the slot's CODEX_HOME passes", async () => {
    const { proc, handle } = run({}, { codexHome: "C:/codex-homes/openai-1" });
    await handle.done;
    const env = proc.options.env as Record<string, string>;
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CODEX_HOME).toBe("C:/codex-homes/openai-1");
    expect(env.RUST_LOG).toBe("error");
  });
  test("an API-key account is refused before any thread", async () => {
    const { proc, handle } = run({ account: { type: "apiKey" } });
    const out = await handle.done;
    expect(out.error?.code).toBe("signed_out");
    expect(proc.methods()).not.toContain("thread/start");
  });
  test("resume uses thread/resume; an unknown thread fails as a protocol error (the orchestrator decides the fallback)", async () => {
    const ok = run({ knownThreads: ["thread-9"] }, { session: { mode: "resume", id: "thread-9" } });
    const out = await ok.handle.done;
    expect(out.status).toBe("succeeded");
    expect(ok.proc.methods()).toContain("thread/resume");
    expect(out.sessionId).toBe("thread-9");
    const bad = run({ knownThreads: [] }, { session: { mode: "resume", id: "thread-9" } });
    const out2 = await bad.handle.done;
    expect(out2.status).toBe("failed");
    expect(out2.error?.code).toBe("protocol_error");
    expect(out2.error?.message).toStartWith("thread/resume failed");
  });
  test("the user's MCP servers are switched off for the role's thread", async () => {
    const { proc, handle, events } = run({ mcpServers: ["cua_repl", "codex_apps"] });
    await handle.done;
    expect(proc.sent.find((x) => x.method === "thread/start").params.config).toEqual({ "mcp_servers.cua_repl.enabled": false, "mcp_servers.codex_apps.enabled": false });
    expect(events.some((e) => e.type === "step" && e.label.includes("Switched off 2 MCP"))).toBe(true);
  });
  test("a resumed turn counts only its own tokens (the historical total re-sent after resume is the baseline)", async () => {
    const { handle } = run({ knownThreads: ["thread-9"], historyTotal: 18245, steps: [{ usage: { inputTokens: 32, outputTokens: 12 } }] }, { session: { mode: "resume", id: "thread-9" } });
    const out = await handle.done;
    expect(out.usage.inputTokens).toBe(1032);
    expect(out.usage.outputTokens).toBe(12);
  });
  test("read-only roles get the read-only sandbox", async () => {
    const { proc, handle } = run({}, { readOnly: true });
    await handle.done;
    expect(proc.sent.find((x) => x.method === "thread/start").params.sandbox).toBe("read-only");
  });
});

describe("Codex runner: policy branches", () => {
  test("file change: allow applies it (paths from item/started reach the policy)", async () => {
    const seen: unknown[] = [];
    const policy: PolicyFn = (r) => { seen.push(r); return allowAll(r); };
    const { proc, handle } = run({ steps: [{ fileChange: { path: "src/a.ts", content: "export const a = 2;\n" } }] }, { policy });
    await handle.done;
    expect(seen[0]).toMatchObject({ kind: "file-change", paths: ["src/a.ts"] });
    expect([...proc.answers.values()][0]).toEqual({ decision: "accept" });
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });
  test("auto-deny declines and the run continues", async () => {
    const policy: PolicyFn = () => ({ decision: "auto-deny", rule: "git-consequential", target: "x", message: "no" });
    const { proc, handle } = run({ steps: [{ command: "git push origin main" }] }, { policy });
    const out = await handle.done;
    expect([...proc.answers.values()][0]).toEqual({ decision: "decline" });
    expect(out.status).toBe("succeeded");
  });
  test("escalate → approve / deny / expire", async () => {
    const policy: PolicyFn = () => ({ decision: "escalate", rule: "unclassified", target: "x", message: "owner decides" });
    const a = run({ steps: [{ command: "make" }] }, { policy });
    for (let i = 0; i < 100 && !a.events.some((e) => e.type === "input"); i++) await Bun.sleep(5);
    const card = a.events.find((e) => e.type === "input") as Extract<RunnerEvent, { type: "input" }>;
    expect(card.request.detail).toBe("make");
    a.handle.respond(card.request.id, "approve");
    await a.handle.done;
    expect([...a.proc.answers.values()][0]).toEqual({ decision: "accept" });

    const b = run({ steps: [{ command: "make" }] }, { policy });
    for (let i = 0; i < 100 && !b.events.some((e) => e.type === "input"); i++) await Bun.sleep(5);
    const card2 = b.events.find((e) => e.type === "input") as Extract<RunnerEvent, { type: "input" }>;
    b.handle.respond(card2.request.id, "deny");
    await b.handle.done;
    expect([...b.proc.answers.values()][0]).toEqual({ decision: "decline" });

    const c = run({ steps: [{ command: "make" }] }, { policy });
    await c.handle.done;
    expect(c.events.some((e) => e.type === "input_resolved" && e.decision === "expired")).toBe(true);
    expect([...c.proc.answers.values()][0]).toEqual({ decision: "decline" });
  });
  test("a question is escalated and answered", async () => {
    const policy: PolicyFn = (r) => (r.kind === "question" ? { decision: "escalate", rule: "unclassified", target: "q", message: "q" } : allowAll(r));
    const { proc, handle, events } = run({ steps: [{ question: { id: "tz", question: "Which timezone?", options: [{ label: "AEST" }] } }] }, { policy });
    for (let i = 0; i < 100 && !events.some((e) => e.type === "input"); i++) await Bun.sleep(5);
    const card = events.find((e) => e.type === "input") as Extract<RunnerEvent, { type: "input" }>;
    handle.respond(card.request.id, "approve", { tz: "AEST" });
    await handle.done;
    expect([...proc.answers.values()][0]).toEqual({ answers: { tz: { answers: ["AEST"] } } });
  });
  test("25 denies stop the run as a policy violation", async () => {
    const policy: PolicyFn = () => ({ decision: "auto-deny", rule: "edit-not-owned", target: "x", message: "no" });
    const { handle } = run({ steps: Array.from({ length: 30 }, () => ({ command: "echo x > ../y" })) }, { policy });
    expect((await handle.done).error?.code).toBe("policy_violation");
  });
});

describe("Codex runner: usage, model, limits, credits", () => {
  test("the turn's token usage is the delta; a reroute is reported, never hidden", async () => {
    const { handle, events } = run({ steps: [{ usage: { inputTokens: 500, outputTokens: 40, cachedInputTokens: 200, reasoningOutputTokens: 7 } }, { reroute: { from: "gpt-6-astra", to: "gpt-5.5" } }] });
    const out = await handle.done;
    expect(out.usage).toEqual({ inputTokens: 1500, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 7 });
    expect(out.providerModel).toBe("gpt-5.5");
    expect(events.some((e) => e.type === "model" && e.source === "rerouted" && e.model === "gpt-5.5")).toBe(true);
  });
  test("at the stop threshold before starting: blocked_allowance, no thread", async () => {
    const { proc, handle } = run({ rateLimits: limits(96) });
    const out = await handle.done;
    expect(out.status).toBe("blocked_allowance");
    expect(out.error?.message).toContain("no credits were drawn");
    expect(proc.methods()).not.toContain("thread/start");
  });
  test("limit reached on openai-1 with credits enabled: it proceeds and says so (owner decision 2)", async () => {
    const r = limits(100, { credits: { hasCredits: true, unlimited: false, balance: "107.40" }, rateLimitReachedType: "primary" });
    const { handle, events } = run({ rateLimits: r, rateLimitsAfter: limits(100, { credits: { hasCredits: true, unlimited: false, balance: "106.90" } }) }, { creditsAllowed: true }, { slot: "codex:openai-1" });
    const out = await handle.done;
    expect(out.status).toBe("succeeded");
    expect(events.some((e) => e.type === "step" && e.label.includes("drawing its paid Codex credits"))).toBe(true);
    const first = events.find((e) => e.type === "allowance") as Extract<RunnerEvent, { type: "allowance" }>;
    expect(first.snapshot.creditsBalance).toBe(107.4);
    expect(out.allowanceEnd?.creditsBalance).toBe(106.9);
  });
  test("the same limit without credit permission blocks", async () => {
    const r = limits(100, { credits: { hasCredits: true, unlimited: false, balance: "107.40" }, rateLimitReachedType: "primary" });
    const { handle } = run({ rateLimits: r }, { creditsAllowed: false }, { slot: "codex:openai-1" });
    expect((await handle.done).status).toBe("blocked_allowance");
  });
  test("a mid-turn limit update interrupts the turn → blocked_allowance", async () => {
    const { proc, handle } = run({ steps: [{ rateLimitsUpdated: { primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: 1790000000 } } }, { wait: 500 }] });
    const out = await handle.done;
    expect(out.status).toBe("blocked_allowance");
    expect(proc.methods()).toContain("turn/interrupt");
  });
  test("allowance parsing: windows, reset times, credits, limit", () => {
    const a = codexAllowance("codex:openai-2", PLUS_LIMITS);
    expect(a.windows.map((w) => w.label)).toEqual(["5-hour", "weekly"]);
    expect(a.windows[0].resetsAt).toBe(new Date(1790000000 * 1000).toISOString());
    expect(a.limitReached).toBe(false);
    expect(a.creditsBalance).toBe(0);
  });
});

describe("Codex runner: stops", () => {
  test("interrupt → interrupted", async () => {
    const { handle } = run({ stall: true, steps: [{ wait: 2000 }] });
    await Bun.sleep(50);
    handle.interrupt();
    const out = await handle.done;
    expect(out.status).toBe("interrupted");
    expect(out.sessionId).toBe("thread-1");
  });
  test("cancel → cancelled; a hung child → termination_unverified", async () => {
    const a = run({ stall: true, steps: [{ wait: 2000 }] });
    await Bun.sleep(50);
    a.handle.cancel();
    expect((await a.handle.done).status).toBe("cancelled");
    const b = run({ stall: true, hang: true, steps: [{ wait: 2000 }] }, {}, { killGraceMs: 150 });
    await Bun.sleep(50);
    b.handle.cancel();
    expect((await b.handle.done).status).toBe("termination_unverified");
  });
  test("a failed turn is failed; the wall limit is a timeout", async () => {
    const a = run({ turnStatus: "failed" });
    expect((await a.handle.done).status).toBe("failed");
    const b = run({ stall: true, steps: [{ wait: 3000 }] }, { limits: { wallMs: 120, maxTurns: 5, inputTimeoutMs: 1000 } });
    const out = await b.handle.done;
    expect(out.error?.code).toBe("timeout");
  });
  test("text is redacted", async () => {
    const secret = "sk-ant-api03-" + "Q".repeat(40);
    const { handle, events } = run({ steps: [{ text: `token ${secret}` }] });
    await handle.done;
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
