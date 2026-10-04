/**
 * TEST ONLY. Fake Claude Code and Codex app-server processes that speak the real wire protocols over
 * in-memory streams, driven by a script of steps. When the harness ALLOWS a step, the fake performs its
 * effect for real inside the role's worktree (writes a file, runs a git argv), so an orchestrator
 * end-to-end test sees genuine commits; when the harness denies it, nothing happens.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";

export type Effect =
  | { write: { path: string; content: string } }
  | { git: string[] }
  | { none: true };

export type ClaudeStep =
  | { tool: string; input: Record<string, unknown>; effect?: Effect }
  | { text: string }
  | { rateLimit: Record<string, unknown> }
  | { wait: number };

export type CodexStep =
  | { command: string; effect?: Effect }
  | { fileChange: { path: string; content: string } }
  | { question: { id: string; question: string; options?: { label: string }[] } }
  | { rateLimitsUpdated: Record<string, unknown> }
  | { reroute: { from: string; to: string } }
  | { text: string }
  | { usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningOutputTokens?: number } }
  | { wait: number };

const IDENTITY = { GIT_AUTHOR_NAME: "Fake Agent", GIT_AUTHOR_EMAIL: "agent@example.invalid", GIT_COMMITTER_NAME: "Fake Agent", GIT_COMMITTER_EMAIL: "agent@example.invalid" };

export function applyEffect(cwd: string, effect: Effect | undefined) {
  if (!effect || "none" in effect) return;
  if ("write" in effect) {
    const file = isAbsolute(effect.write.path) ? effect.write.path : join(cwd, effect.write.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, effect.write.content);
    return;
  }
  spawnSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...effect.git], { cwd, env: { ...process.env, ...IDENTITY }, windowsHide: true });
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  /** No pid: terminateChild never runs taskkill against a real process id. */
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  killed: string[] = [];
  args: string[] = [];
  options: any = {};
  /** Never close on kill (termination_unverified). */
  hang = false;
  sent: any[] = [];
  frame(value: unknown) { if (this.exitCode === null) this.stdout.write(`${JSON.stringify(value)}\n`); }
  close(code = 0) { if (this.exitCode === null) { this.exitCode = code; this.stdout.end(); this.emit("close", code); } }
  kill(signal = "SIGTERM") { this.killed.push(signal); if (!this.hang) queueMicrotask(() => this.close(1)); return true; }
}

// ─────────────────────────── Claude ───────────────────────────

export type FakeClaudeOptions = {
  steps?: ClaudeStep[];
  model?: string;
  /** Emitted in the final result. */
  result?: Partial<{ subtype: string; is_error: boolean; result: string; usage: Record<string, number>; modelUsage: Record<string, unknown>; total_cost_usd: number; num_turns: number }>;
  /** Fail initialize with this error text. */
  initError?: string;
  /** The session a --resume asks for doesn't exist. */
  missingSession?: boolean;
  hang?: boolean;
  /** Emit this line on stdout first (e.g. a secret-shaped string) to check redaction. */
  leak?: string;
  /** Never send the result (a turn that runs until killed). */
  stall?: boolean;
};

export class FakeClaude extends FakeProcess {
  decisions: Array<{ tool: string; behavior: string; message?: string; updatedInput?: unknown }> = [];
  private waiting = new Map<string, (r: any) => void>();
  constructor(readonly o: FakeClaudeOptions = {}) {
    super();
    this.hang = !!o.hang;
    let buf = "";
    this.stdin.on("data", (chunk) => {
      buf += String(chunk);
      let at: number;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        if (line.trim()) this.onMessage(JSON.parse(line));
      }
    });
    this.stdin.on("finish", () => { if (!this.hang) queueMicrotask(() => this.close(0)); });
  }
  get sessionArg() {
    const i = this.args.indexOf("--session-id");
    const r = this.args.indexOf("--resume");
    return i >= 0 ? this.args[i + 1] : r >= 0 ? this.args[r + 1] : null;
  }
  private onMessage(m: any) {
    this.sent.push(m);
    if (m.type === "control_request" && m.request?.subtype === "initialize") {
      if (this.o.initError) return this.frame({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: this.o.initError } });
      return this.frame({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    }
    if (m.type === "control_request" && m.request?.subtype === "interrupt") {
      this.interrupted = true;
      return this.frame({ type: "result", subtype: "error_during_execution", is_error: true, session_id: this.sessionArg, num_turns: 1 });
    }
    if (m.type === "control_response") {
      const resolve = this.waiting.get(m.response?.request_id);
      if (resolve) { this.waiting.delete(m.response.request_id); resolve(m.response.response); }
      return;
    }
    if (m.type === "user") void this.run();
  }
  interrupted = false;
  private async run() {
    await tick();
    if (this.o.leak) this.frame({ type: "assistant", message: { id: "leak", content: [{ type: "text", text: this.o.leak }] } });
    if (this.o.missingSession && this.args.includes("--resume")) {
      this.stderr.write("No conversation found with session ID");
      return this.frame({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID" });
    }
    this.frame({ type: "system", subtype: "init", session_id: this.sessionArg ?? "s-1", model: this.o.model ?? "claude-opus-5-5", mcp_servers: [] });
    let n = 0;
    const cwd = this.options.cwd as string;
    for (const step of this.o.steps ?? []) {
      if (this.interrupted || this.exitCode !== null) return;
      if ("wait" in step) { await tick(step.wait); continue; }
      if ("text" in step) { this.frame({ type: "assistant", message: { id: `m${n++}`, content: [{ type: "text", text: step.text }] } }); continue; }
      if ("rateLimit" in step) { this.frame({ type: "rate_limit_event", rate_limit_info: step.rateLimit }); await tick(5); continue; }
      const id = `req-${n++}`;
      const answer = new Promise<any>((r) => this.waiting.set(id, r));
      this.frame({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: step.tool, input: step.input } });
      const response = await answer;
      this.decisions.push({ tool: step.tool, behavior: response?.behavior, message: response?.message, updatedInput: response?.updatedInput });
      if (response?.behavior === "allow") applyEffect(cwd, step.effect);
    }
    if (this.o.stall || this.interrupted || this.exitCode !== null) return;
    const r = this.o.result ?? {};
    this.frame({
      type: "result", subtype: r.subtype ?? "success", is_error: r.is_error ?? false, result: r.result ?? "Done.",
      session_id: this.sessionArg ?? "s-1", num_turns: r.num_turns ?? 3, total_cost_usd: r.total_cost_usd ?? 0.0123,
      usage: r.usage ?? { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 900, cache_creation_input_tokens: 300 },
      modelUsage: r.modelUsage ?? { [this.o.model ?? "claude-opus-5-5"]: { inputTokens: 120, outputTokens: 45 } },
    });
  }
}

// ─────────────────────────── Codex ───────────────────────────

export type FakeCodexOptions = {
  steps?: CodexStep[];
  account?: { type: string; planType?: string } | null;
  rateLimits?: Record<string, unknown>;
  /** A second read after the turn (credits after). */
  rateLimitsAfter?: Record<string, unknown>;
  model?: string;
  failMethod?: string;
  turnStatus?: "completed" | "failed" | "interrupted";
  hang?: boolean;
  stall?: boolean;
  /** Thread ids this app-server knows (thread/resume of any other fails). */
  knownThreads?: string[];
  /** MCP servers the user's config would start (mcpServerStatus/list). */
  mcpServers?: string[];
  /** After thread/resume, re-send the thread's historical token total (VERIFIED real behaviour). */
  historyTotal?: number;
};

export const PLUS_LIMITS = { rateLimits: { primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1790500000 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, spendControlReached: false, planType: "plus", rateLimitReachedType: null } };

export class FakeCodex extends FakeProcess {
  answers = new Map<string, any>();
  private waiting = new Map<string, (r: any) => void>();
  private reads = 0;
  thread = "thread-1";
  constructor(readonly o: FakeCodexOptions = {}) {
    super();
    this.hang = !!o.hang;
    let buf = "";
    this.stdin.on("data", (chunk) => {
      buf += String(chunk);
      let at: number;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        if (line.trim()) this.onMessage(JSON.parse(line));
      }
    });
    this.stdin.on("finish", () => { if (!this.hang) queueMicrotask(() => this.close(0)); });
  }
  methods() { return this.sent.filter((m) => m.method).map((m) => m.method); }
  notify(method: string, params: Record<string, unknown> = {}) { this.frame({ method, params: { threadId: this.thread, turnId: "turn-1", ...params } }); }
  private onMessage(m: any) {
    this.sent.push(m);
    if (m.method === undefined && m.id !== undefined) {
      this.answers.set(String(m.id), m.result ?? m.error);
      const w = this.waiting.get(String(m.id));
      if (w) { this.waiting.delete(String(m.id)); w(m.result ?? m.error); }
      return;
    }
    if (m.id === undefined) return;
    queueMicrotask(() => {
      if (m.method === this.o.failMethod) return this.frame({ id: m.id, error: { code: -1, message: `${m.method} refused` } });
      switch (m.method) {
        case "initialize": return this.frame({ id: m.id, result: { userAgent: "fake" } });
        case "account/read": return this.frame({ id: m.id, result: { account: this.o.account === undefined ? { type: "chatgpt", planType: "plus" } : this.o.account } });
        case "account/rateLimits/read": {
          this.reads++;
          const r = this.reads > 1 && this.o.rateLimitsAfter ? this.o.rateLimitsAfter : this.o.rateLimits ?? PLUS_LIMITS;
          return this.frame({ id: m.id, result: r });
        }
        case "mcpServerStatus/list": return this.frame({ id: m.id, result: { data: (this.o.mcpServers ?? []).map((name) => ({ name, tools: {} })), nextCursor: null } });
        case "thread/start": return this.frame({ id: m.id, result: { thread: { id: this.thread }, model: this.o.model ?? m.params?.model ?? "gpt-6-astra" } });
        case "thread/resume": {
          const known = this.o.knownThreads ?? [];
          if (!known.includes(m.params?.threadId)) return this.frame({ id: m.id, error: { code: -32600, message: "thread not found" } });
          this.thread = m.params.threadId;
          this.frame({ id: m.id, result: { thread: { id: this.thread }, model: this.o.model ?? m.params?.model ?? "gpt-6-astra" } });
          if (this.o.historyTotal) {
            const h = { totalTokens: this.o.historyTotal, inputTokens: this.o.historyTotal, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
            this.frame({ method: "thread/tokenUsage/updated", params: { threadId: this.thread, turnId: "turn-previous", tokenUsage: { total: h, last: h, modelContextWindow: null } } });
          }
          return;
        }
        case "turn/start": {
          this.frame({ id: m.id, result: { turn: { id: "turn-1" } } });
          this.notify("turn/started", { turn: { id: "turn-1" } });
          return void this.run();
        }
        case "turn/interrupt": {
          this.frame({ id: m.id, result: {} });
          this.interrupted = true;
          return this.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
        }
        default: return this.frame({ id: m.id, result: {} });
      }
    });
  }
  interrupted = false;
  private ask(method: string, params: Record<string, unknown>, id: string) {
    const answer = new Promise<any>((r) => this.waiting.set(id, r));
    this.frame({ id, method, params: { threadId: this.thread, turnId: "turn-1", ...params } });
    return answer;
  }
  private async run() {
    await tick();
    const cwd = this.options.cwd as string;
    let n = 0;
    const base = this.o.historyTotal ?? 0;
    const first = { totalTokens: 0, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    let usage = { ...first, inputTokens: base + 1000 };
    this.notify("thread/tokenUsage/updated", { tokenUsage: { total: usage, last: first, modelContextWindow: null } });
    for (const step of this.o.steps ?? []) {
      if (this.interrupted || this.exitCode !== null) return;
      if ("wait" in step) { await tick(step.wait); continue; }
      if ("text" in step) { this.notify("item/agentMessage/delta", { delta: step.text }); continue; }
      if ("reroute" in step) { this.notify("model/rerouted", { fromModel: step.reroute.from, toModel: step.reroute.to, reason: "capacity" }); continue; }
      if ("rateLimitsUpdated" in step) { this.frame({ method: "account/rateLimits/updated", params: { rateLimits: step.rateLimitsUpdated } }); await tick(5); continue; }
      if ("usage" in step) {
        usage = { ...usage, inputTokens: usage.inputTokens + step.usage.inputTokens, outputTokens: usage.outputTokens + step.usage.outputTokens, cachedInputTokens: usage.cachedInputTokens + (step.usage.cachedInputTokens ?? 0), reasoningOutputTokens: usage.reasoningOutputTokens + (step.usage.reasoningOutputTokens ?? 0) };
        this.notify("thread/tokenUsage/updated", { tokenUsage: { total: usage, last: usage, modelContextWindow: null } });
        continue;
      }
      if ("question" in step) {
        await this.ask("item/tool/requestUserInput", { itemId: `q${n}`, questions: [step.question] }, `srv-${n++}`);
        continue;
      }
      if ("command" in step) {
        const itemId = `cmd${n}`;
        this.notify("item/started", { item: { type: "commandExecution", id: itemId, command: step.command } });
        const r = await this.ask("item/commandExecution/requestApproval", { itemId, command: step.command, cwd, reason: null }, `srv-${n++}`);
        if (r?.decision === "accept") applyEffect(cwd, step.effect);
        continue;
      }
      const itemId = `fc${n}`;
      this.notify("item/started", { item: { type: "fileChange", id: itemId, changes: [{ path: step.fileChange.path, kind: "update" }] } });
      const r = await this.ask("item/fileChange/requestApproval", { itemId, reason: null, grantRoot: null }, `srv-${n++}`);
      if (r?.decision === "accept") applyEffect(cwd, { write: step.fileChange });
      this.notify("item/completed", { item: { type: "fileChange", id: itemId, status: r?.decision === "accept" ? "completed" : "declined", changes: [{ path: step.fileChange.path }] } });
    }
    if (this.o.stall || this.interrupted || this.exitCode !== null) return;
    this.notify("item/completed", { item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Changed the owned file and committed." } });
    this.notify("turn/completed", { turn: { id: "turn-1", status: this.o.turnStatus ?? "completed" } });
  }
}

/** A spawn function that hands out the given fakes in order and records each launch. */
export function fakeSpawn<T extends FakeProcess>(...fakes: T[]) {
  const launched: T[] = [];
  const fn = ((binary: string, args: string[], options: any) => {
    const fake = fakes.shift();
    if (!fake) throw new Error("No fake left to spawn.");
    fake.args = args;
    fake.options = { ...options, binary };
    launched.push(fake);
    return fake;
  }) as any;
  return { spawn: fn, launched };
}
