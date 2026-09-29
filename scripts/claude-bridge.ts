import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogue, catalogueTask } from "./model-router/catalogue";
import { defaultReceiptSink } from "./model-router/defaults";
import type { HealthStore } from "./model-router/health";
import type { ReceiptSink } from "./model-router/receipts";
import { ProviderError, RouteError, runRouted } from "./model-router/router";
import { claudeFailure } from "./model-router/subscription-clients";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Claude on Usman's Claude subscription, for Hermes. An OpenAI-compatible endpoint
 * (`/v1/models`, `/v1/chat/completions`) that runs the official Claude Code CLI
 * headless (`claude -p`) under its own claude.ai login. Hermes never sees or borrows
 * Claude Code's OAuth tokens; it only sees text. Text only: no tools, no files, no MCP,
 * no CLAUDE.md or memory, so it suits Mixture-of-Agents reference experts.
 *
 * The HTTP path (`handle`, /__claude) runs through the model router (task bridge.claude) and writes
 * a router receipt per attempt; it answers as the model asked for (no fallback: Hermes keeps its
 * own chain). `complete()` stays the raw transport: in-process callers go through
 * routedChat/claudeChat, which write their own receipts, so no call is counted twice.
 */

/** The CLI's `--model` alias where it differs from the provider id (transport detail, by catalogue id). */
const CLI_ALIAS: Record<string, string> = { "claude/fable-5-1": "fable", "claude/haiku-4-5": "haiku" };
const routable = (status: string) => status === "verified" || status === "configured";
/** The models the bridge serves: task bridge.claude's candidates and selectable models (not every
 *  claude-sub entry: picker-only models are not served here). */
const claudeModels = () => {
  const t = catalogueTask("bridge.claude");
  const ids = [...(t?.candidates ?? []), ...(t?.selectable ?? [])];
  return catalogue().models.filter((m) => m.provider === "claude-sub" && routable(m.status) && ids.includes(m.id));
};

/** Model id a caller sends (the catalogue's provider id) -> the CLI's `--model` value. */
export const CLAUDE_BRIDGE_MODELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(claudeModels().map((m) => [m.providerModel, CLI_ALIAS[m.id] ?? m.providerModel])));
type BridgeModel = string;
export const CLAUDE_TASK = "bridge.claude";

/** The catalogue id for a model name a caller sends ("claude-opus-5-5" -> "claude/opus-5-5"). */
export function claudeCatalogueId(model: string): string | null {
  return claudeModels().find((m) => m.providerModel === model)?.id ?? null;
}

type Run = (args: string[], stdin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) => Promise<string>;
type Dependencies = { bin?: string; run?: Run; now?: () => number; maxParallel?: number; timeoutMs?: number;
  /** Router receipts and health for the HTTP path (default: the shared router files under `root`; in-memory under bun test). */
  root?: string; sink?: ReceiptSink; health?: HealthStore };

const MAX_BODY = 4 * 1024 * 1024;
const MAX_PROMPT = 400_000;
/** Anything that would switch Claude Code from the subscription to paid API billing. */
const BILLING_OVERRIDES = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;

export function defaultClaudeBin() {
  const tail = join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const candidates = [
    process.env.CLAUDE_BRIDGE_BIN,
    // A pinned copy, so updating Claude Code under running sessions is never needed.
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "claude-bridge", tail),
    process.env.APPDATA && join(process.env.APPDATA, "npm", tail),
  ].filter(Boolean) as string[];
  return candidates.find((path) => existsSync(path)) ?? "claude";
}

function spawnRun(bin: string): Run {
  return (args, stdin, env, cwd, timeoutMs) =>
    new Promise((resolve, reject) => {
      // Direct exe, no shell: npm .cmd shims can't be spawned, and the prompt goes
      // over stdin because Windows caps a command line at 32,767 characters.
      const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Claude Code took longer than ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (out.trim()) resolve(out);
        else reject(new Error(`Claude Code exited ${code}${err ? `: ${err.slice(0, 300)}` : ""}`));
      });
      child.stdin.end(stdin);
    });
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part: any) => (typeof part === "string" ? part : part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

/** System messages become the system prompt; the rest becomes one transcript. */
export function bridgePrompt(messages: unknown) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a non-empty array.");
  const system: string[] = [], turns: { role: string; text: string }[] = [];
  for (const message of messages as any[]) {
    const role = String(message?.role || ""), body = text(message?.content).trim();
    if (!body) continue;
    if (role === "system" || role === "developer") system.push(body);
    else if (role === "user" || role === "assistant" || role === "tool") turns.push({ role, text: body });
  }
  if (!turns.length) throw new Error("There is no user message to answer.");
  const prompt =
    turns.length === 1 && turns[0].role === "user"
      ? turns[0].text
      : turns
          .map((turn) => `${turn.role === "assistant" ? "Assistant" : turn.role === "tool" ? "Tool result" : "User"}:\n${turn.text}`)
          .join("\n\n") + "\n\nReply to the last User message as the Assistant.";
  if (prompt.length > MAX_PROMPT) throw new Error("The conversation is too long for the Claude bridge.");
  return { system: system.join("\n\n") || "You are a helpful expert. Answer directly.", prompt };
}

export function claudeBridge(dependencies: Dependencies = {}) {
  const run = dependencies.run ?? spawnRun(dependencies.bin ?? defaultClaudeBin());
  const now = dependencies.now ?? Date.now;
  const maxParallel = dependencies.maxParallel ?? 3;
  const timeoutMs = dependencies.timeoutMs ?? 10 * 60_000;
  const cwd = join(tmpdir(), "agentic-os-claude-bridge");
  let active = 0;
  const waiting: (() => void)[] = [];

  async function slot<T>(work: () => Promise<T>) {
    if (active >= maxParallel) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  async function complete(body: any) {
    const model = String(body?.model || "") as BridgeModel;
    if (!Object.hasOwn(CLAUDE_BRIDGE_MODELS, model))
      throw Object.assign(new Error(`Unknown model. Use one of: ${Object.keys(CLAUDE_BRIDGE_MODELS).join(", ")}.`), { status: 400 });
    const { system, prompt } = bridgePrompt(body?.messages);
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!BILLING_OVERRIDES.test(key)) env[key] = value;
    // Keep his CLAUDE.md files and memory out of every expert call.
    Object.assign(env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_ORG_MEMORY: "1" });
    mkdirSync(cwd, { recursive: true });
    const systemFile = join(cwd, `system-${randomUUID()}.txt`);
    const args = [
      "-p",
      "--model", CLAUDE_BRIDGE_MODELS[model],
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "project,local",
      "--no-session-persistence",
      "--output-format", "json",
      // A file, not an argument: Hermes' system prompts can exceed the 32,767-char command line.
      "--system-prompt-file", systemFile,
    ];
    let raw: string;
    try {
      writeFileSync(systemFile, system);
      raw = await slot(() => run(args, prompt, env, cwd, timeoutMs));
    } finally {
      rmSync(systemFile, { force: true });
    }
    let result: any;
    try {
      result = JSON.parse(raw.slice(raw.indexOf("{")));
    } catch {
      throw Object.assign(new Error("Claude Code returned something that was not JSON."), { status: 502 });
    }
    if (result?.is_error || typeof result?.result !== "string")
      throw Object.assign(new Error(`Claude Code failed: ${String(result?.result || "no result").slice(0, 300)}`), { status: 502 });
    const usage = result.usage || {};
    const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    return {
      id: `chatcmpl-claude-${now()}`,
      object: "chat.completion",
      created: Math.floor(now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: result.result }, finish_reason: "stop" }],
      usage: { prompt_tokens: input, completion_tokens: usage.output_tokens || 0, total_tokens: input + (usage.output_tokens || 0) },
    };
  }

  const root = dependencies.root ?? ROOT;
  const sink = dependencies.sink ?? defaultReceiptSink(root);
  // No shared health by default: as before E2, every request runs `claude -p` (a window another
  // caller saw used up is not assumed still used up). Tests and callers may pass a store.
  const health = dependencies.health;

  /**
   * One HTTP completion through the router (task bridge.claude): the requested model is selected
   * (the task's first candidate is the rule default) and every attempt writes a receipt. Errors
   * keep the status and message the caller always got; receipts keep only the sanitised class.
   */
  async function routed(body: any) {
    const model = String(body?.model || "");
    const id = claudeCatalogueId(model);
    if (!id) throw Object.assign(new Error(`Unknown model. Use one of: ${Object.keys(CLAUDE_BRIDGE_MODELS).join(", ")}.`), { status: 400 });
    try {
      bridgePrompt(body?.messages);
    } catch (error) {
      // 502 with the same message, as complete() always answered: checked here so a malformed
      // conversation is not recorded as a Claude failure.
      throw Object.assign(new Error((error as Error).message), { status: 502 });
    }
    const first = catalogueTask(CLAUDE_TASK)?.candidates[0];
    let last: Error | null = null;
    try {
      const result = await runRouted({
        task: CLAUDE_TASK,
        caller: "scripts/claude-bridge (/__claude)",
        sink,
        constraints: { ...(id === first ? {} : { selected: id, selectedBy: "owner" as const }), providers: ["claude-sub"], health },
        invoke: async (choice) => {
          try {
            const out = await complete({ ...body, model: choice.providerModel });
            return {
              value: out,
              // `claude -p --model` runs exactly the model it was given.
              providerModel: choice.providerModel,
              usage: { inputTokens: out.usage.prompt_tokens, outputTokens: out.usage.completion_tokens },
            };
          } catch (error) {
            last = error as Error;
            throw claudeFailure(error, false);
          }
        },
      });
      return result.value;
    } catch (error) {
      const failed = last as Error | null;
      if (failed) throw failed;
      if (error instanceof RouteError) {
        const why = error.skipped.map((s) => `${s.model}: ${s.why}`).join("; ").slice(0, 240);
        throw Object.assign(new Error(`Claude is unavailable right now (${why || error.code}).`), { status: /limited|exhausted/.test(why) ? 429 : 503 });
      }
      if (error instanceof ProviderError) throw Object.assign(new Error("Claude Code failed."), { status: 502 });
      throw error;
    }
  }

  function send(res: ServerResponse, status: number, value: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
  }

  /** Mounted at /__claude. Loopback only, and never from a browser page. */
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url || "/").split("?")[0].replace(/\/+$/, "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || ""))
      return send(res, 403, { error: { message: "Local access only" } });
    // Hermes sends neither header; any browser page does, so no website can spend his plan.
    if (req.headers.origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none"))
      return send(res, 403, { error: { message: "Not available to web pages" } });
    try {
      if (req.method === "GET" && path === "/v1/models")
        return send(res, 200, {
          object: "list",
          data: claudeModels().map((m) => ({ id: m.providerModel, object: "model", owned_by: "claude-subscription" })),
        });
      if (req.method !== "POST" || path !== "/v1/chat/completions") return send(res, 404, { error: { message: "Not found" } });
      if (!String(req.headers["content-type"] || "").includes("application/json"))
        return send(res, 415, { error: { message: "Send JSON" } });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return send(res, 413, { error: { message: "Request too large" } });
      }
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: { message: "Invalid JSON" } });
      }
      const completion = await routed(body);
      if (!body?.stream) return send(res, 200, completion);
      // Claude Code answers in one piece; stream it as one chunk for clients that asked.
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-store");
      const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: completion.choices[0].message.content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: completion.usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      const status = (error as { status?: number }).status ?? 502;
      if (!res.headersSent) send(res, status, { error: { message: (error as Error).message } });
      else res.end();
    }
  }

  return { handle, complete, routed };
}
