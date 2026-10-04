import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, needsCommandShell, realExecutable, type PlatformOptions } from "../../assistant-runtime";
import { cliHomeGuard } from "../../cli-home-guard";
import { claudeSlotEnv } from "../claude-status";
import type { AllowanceSnapshot, InputRequest, IsoTime, RunErrorCode } from "../contracts";
import { redactText } from "../redact";
import { runCapture } from "../../nonblocking-exec";
import { decider, detailOf, inputQueue, requestKey, isoIn, jsonLines, textCoalescer, verifiedKill, type Spawn } from "./proc";
import { contextModeLaunch, contextModePolicy, isContextModeTool, resolveContextMode, type ContextHelperLaunch } from "./context-helper";
import { NO_USAGE, type RoleRunner, type RunnerEvent, type RunnerHandle, type RunnerOutcome, type RunnerStart, type RunnerStatus, type TurnUsage } from "./types";

/**
 * Claude Code as a coding role (CODING-HARNESS §3.4, C3), over the native stream-json protocol:
 *  - the REAL claude.exe (never the npm shim), argv without a shell, prompt on stdin, system text by file;
 *  - a pre-assigned `--session-id` for a new role, `--resume <id>` for an explicit resume;
 *  - `--permission-mode manual` (plan for read-only roles) with `--permission-prompt-tool stdio`, so EVERY
 *    tool use reaches this runner's policy engine before any human; no MCP (`--strict-mcp-config` with an
 *    empty config); `--restricted` so NO user, project or local settings file (a builder-written
 *    .claude/settings*.json included) is loaded, file tools are confined to the worktree and writes to
 *    settings, git and tool config need the permission handler; hooks are off (`--settings`
 *    disableAllHooks); an explicit `--tools` allowlist (REVIEW-T3 F1: no Monitor, Task, Skill, cron...);
 *  - usage, the models that ran (`modelUsage`) and the API-equivalent value from the `result` message.
 * Never: --bare, --dangerously-skip-permissions, --fallback-model, -w/--worktree, ccr routes.
 */

export type ClaudeRunnerOptions = PlatformOptions & {
  binary?: string;
  spawn?: Spawn;
  /** How long to wait for `close` after a kill before reporting termination_unverified. */
  killGraceMs?: number;
  /** How long a finished turn may take to exit on its own (stdin closed) before the kill. */
  softEndMs?: number;
  initializeTimeoutMs?: number;
  /** Where the per-run system-prompt file goes (default os.tmpdir()). */
  tempDir?: string;
  /** The JavaScript runtime that starts the opt-in context helper's MCP server (default: this process's own runtime, bun). */
  contextRuntime?: string;
};

const MAX_PROMPT = 200_000;
const MAX_SCHEMA = 4096;
/** The only built-in tools a role gets (REVIEW-T3 F1). Everything else (Monitor, Task, Skill, Cron*, ...) is absent. */
export const CLAUDE_TOOLS_WRITE = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "NotebookEdit", "AskUserQuestion"];
export const CLAUDE_TOOLS_READ = ["Read", "Glob", "Grep", "Bash", "AskUserQuestion", "ExitPlanMode"];
/** Hooks from any settings source are off; the policy engine is the only gate (REVIEW-T3 F4). */
export const CLAUDE_SETTINGS = JSON.stringify({ disableAllHooks: true });
/** Belt and braces: the policy engine already denies these. */
export const CLAUDE_DISALLOWED = ["Monitor", "Task", "Agent", "Skill", "Bash(git push:*)", "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git reset:*)", "Bash(git config:*)", "Bash(git worktree:*)", "Bash(vercel:*)", "Bash(gh:*)"];

const versionCache = new Map<string, string | null>();
const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;
/** Blocking fallback, used only if nothing primed the cache (CLIs and tests; the server primes it). */
function cliVersion(binary: string): string | null {
  if (!versionCache.has(binary)) {
    try {
      // Even `--version` runs on the copy's home in a copy (it writes .claude.json): REVIEW-T3.
      const home = cliHomeGuard("claude", process.env);
      if (!home.ok) { versionCache.set(binary, null); return null; }
      const r = spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000, env: home.env });
      const v = VERSION_RE.exec(`${r.stdout}`)?.[0] ?? null;
      // A timeout or failed start is not cached (like cliVersionAsync): a cached null made the older CLI win for
      // the whole process and Opus 5.5 was refused (30 Sep 2026, live).
      if (v === null && (r.error || r.status !== 0)) return null;
      versionCache.set(binary, v);
    } catch { return null; }
  }
  return versionCache.get(binary) ?? null;
}
/** A binary's `--version` as an async child (T8b, review T8 S-6); fills the same per-process cache. */
export async function cliVersionAsync(binary: string): Promise<string | null> {
  if (versionCache.has(binary)) return versionCache.get(binary) ?? null;
  const home = cliHomeGuard("claude", process.env);
  let version: string | null = null;
  if (home.ok) {
    const r = await runCapture(binary, ["--version"], { timeout: 20_000, env: home.env });
    if (r.error) return null; // couldn't start, or timed out: not cached, so it's asked again (review T8b-F1)
    version = VERSION_RE.exec(r.stdout)?.[0] ?? null;
  }
  versionCache.set(binary, version);
  return version;
}
const newer = (a: string | null, b: string | null) => {
  const pa = (a ?? "0.0.0").split(".").map(Number), pb = (b ?? "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
};
/**
 * The Claude Code the harness runs: the NEWEST real claude.exe among the one on PATH and the pinned bridge
 * copy (owner decision 3). Verified 28 Sep: 2.1.278 (npm global) rejects claude-opus-5-5 as an unrecognised
 * model; 2.1.280 (the bridge copy) runs it. Cached per process.
 */
export function claudeCodingBinary(options: PlatformOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const onPath = realExecutable("claude", { platform, env });
  const localAppData = env.LOCALAPPDATA;
  const pinned = platform === "win32" && localAppData ? join(localAppData, "claude-bridge", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : null;
  const candidates = [onPath, pinned && existsSync(pinned) ? pinned : null].filter((x): x is string => !!x);
  if (candidates.length < 2) return candidates[0];
  // An unreadable version (a --version that timed out under load) never downgrades to the older PATH copy:
  // the pinned bridge copy is the known-good one (30 Sep 2026, live: Opus 5.5 was refused by 2.1.278).
  const versions = candidates.map((c) => cliVersion(c));
  if (versions.some((v) => v === null) && pinned && candidates.includes(pinned)) return pinned;
  return candidates.reduce((best, c) => (newer(cliVersion(c), cliVersion(best)) ? c : best));
}

/** The candidates claudeCodingBinary compares, with their versions read asynchronously first, so the pick never spawns. */
export async function primeClaudeCodingBinary(options: PlatformOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const onPath = realExecutable("claude", { platform, env });
  const localAppData = env.LOCALAPPDATA;
  const pinned = platform === "win32" && localAppData ? join(localAppData, "claude-bridge", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : null;
  const candidates = [onPath, pinned && existsSync(pinned) ? pinned : null].filter((x): x is string => !!x);
  if (candidates.length >= 2) await Promise.all(candidates.map((c) => cliVersionAsync(c)));
  return claudeCodingBinary(options);
}

/** The exact argv for a run (exported for tests and the live smoke's record). */
export function claudeArgs(input: Pick<RunnerStart, "binding" | "readOnly" | "session" | "limits" | "jsonSchema">, systemFile: string, helper?: ContextHelperLaunch | null): string[] {
  if (input.binding.route !== "claude-code-cli") throw new Error("Not a Claude binding.");
  const args = [
    "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-prompt-tool", "stdio",
    "--permission-mode", input.readOnly ? "plan" : "manual",
    "--model", input.binding.model,
    "--strict-mcp-config", "--mcp-config", helper ? helper.mcpConfig : '{"mcpServers":{}}',
    "--restricted",
    "--settings", CLAUDE_SETTINGS,
    "--tools", (input.readOnly ? CLAUDE_TOOLS_READ : CLAUDE_TOOLS_WRITE).join(","),
    "--max-turns", String(Math.max(1, Math.floor(input.limits.maxTurns))),
    "--append-system-prompt-file", systemFile,
    "--disallowedTools", ...CLAUDE_DISALLOWED, ...(helper ? helper.disallowed : []),
  ];
  if (input.session.mode === "new") args.push("--session-id", input.session.id);
  else args.push("--resume", input.session.id);
  if (input.jsonSchema) {
    const schema = JSON.stringify(input.jsonSchema);
    if (schema.length >= MAX_SCHEMA) throw new Error("The structured-output schema is too large for argv.");
    args.push("--json-schema", schema);
  }
  return args;
}

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function classify(text: string): { status: RunnerStatus; code: RunErrorCode; message: string } {
  if (/no conversation found|session .*not found|could not find (?:a )?session/i.test(text))
    return { status: "failed", code: "protocol_error", message: "native session not found: the Claude session can't be resumed." };
  if (/not logged in|not signed in|authentication|invalid api key|login required|please.*log ?in|oauth.*expired/i.test(text))
    return { status: "failed", code: "signed_out", message: "Claude Code needs sign-in. Open Claude Code and run /login." };
  if (/rate.?limit|usage limit|limit reached|quota|out of (?:usage|credits)/i.test(text))
    return { status: "blocked_allowance", code: "limit_reached", message: "Claude reported a usage limit. The role stopped and nothing was drawn beyond the plan." };
  if (/max.?turns|maximum number of turns/i.test(text)) return { status: "failed", code: "timeout", message: "The role reached its turn limit." };
  // Say what Claude said (redacted, short) so the owner can act on it; never a bare "failed".
  const said = redactText(text, 400).replace(/\s+/g, " ").trim().slice(0, 240);
  return { status: "failed", code: "unknown", message: `Claude did not complete this turn${said ? ` (${said})` : ""}. Its native session is kept for inspection.` };
}

export function claudeRunner(options: ClaudeRunnerOptions = {}): RoleRunner {
  return {
    kind: "claude-code-cli",
    start(input: RunnerStart): RunnerHandle {
      const platform = options.platform ?? process.platform;
      const startedAt = Date.now();
      const emit = (e: RunnerEvent) => { if (!settled) { try { input.onEvent(e); } catch { /* a listener never breaks a run */ } } };
      let child: ChildProcessWithoutNullStreams | undefined;
      let processClosed = false;
      const closeWaiters: Array<() => void> = [];
      let settled = false;
      let interrupted = false;
      let initialized = false;
      let sessionId: string | null = input.session.id;
      let providerModel: string | null = null;
      let usage: TurnUsage = { ...NO_USAGE };
      let value: number | null = null;
      let turns: number | null = null;
      let stderr = "";
      let completeText = "";
      let tempFolder: string | null = null;
      let lastAllowance: AllowanceSnapshot | null = null;
      let ranVersion: string | null = null;
      let resolveDone!: (o: RunnerOutcome) => void;
      const done = new Promise<RunnerOutcome>((r) => { resolveDone = r; });
      const timers: ReturnType<typeof setTimeout>[] = [];
      const text = textCoalescer(emit);
      // Opt-in context helper (context-helper.ts). Off = nothing below changes: same argv, same policy.
      const helperCheck = input.contextHelper ? resolveContextMode(input.contextHelper, options.env ?? process.env) : null;
      let helper: ContextHelperLaunch | null = null;
      const policy = decider(helperCheck?.ok ? contextModePolicy(input.policy, input.cwd) : input.policy, emit);
      const queue = inputQueue(emit, input.limits.inputTimeoutMs);
      const initId = `coding-init-${randomUUID()}`;

      const write = (message: unknown) => {
        if (!child || processClosed || child.stdin.destroyed) return;
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* close handles it */ }
      };
      const outcome = (status: RunnerStatus, error: RunnerOutcome["error"]): RunnerOutcome => ({
        status, error, finalText: redactText(completeText, 32_000), sessionId, providerModel, usage, valueUsdEquivalent: value,
        turns, startedAt, endedAt: Date.now(), allowanceEnd: lastAllowance, accountPlan: null, cliVersion: ranVersion,
      });
      async function finish(status: RunnerStatus, error: RunnerOutcome["error"] = null) {
        if (settled) return;
        text.stop();
        queue.clear();
        for (const t of timers) clearTimeout(t);
        input.signal.removeEventListener("abort", cancel);
        const out = outcome(status, error);
        settled = true;
        let confirmed = true;
        if (child && !processClosed)
          confirmed = await verifiedKill(child, () => processClosed, (fn) => closeWaiters.push(fn), {
            platform, env: options.env, graceMs: options.killGraceMs,
            // A finished or paused turn ends cleanly (the session is saved for --resume); a stop kills.
            softMs: status === "succeeded" || status === "interrupted" || status === "blocked_allowance" ? options.softEndMs ?? 3000 : 0,
          });
        if (tempFolder) { try { rmSync(tempFolder, { recursive: true, force: true }); } catch { /* temp */ } }
        if (!confirmed) {
          resolveDone({ ...out, status: "termination_unverified", error: { code: "unknown", message: "The Claude process tree didn't confirm it stopped within the grace period. Check for a stray claude.exe." }, endedAt: Date.now() });
          return;
        }
        resolveDone({ ...out, endedAt: Date.now() });
      }
      function cancel() { void finish("cancelled", { code: "unknown", message: "Stopped by the owner." }); }
      function interrupt() {
        if (settled) return;
        interrupted = true;
        write({ type: "control_request", request_id: `coding-interrupt-${randomUUID()}`, request: { subtype: "interrupt" } });
        // The turn ends with a result (or not): either way the process is stopped and the session kept.
        const t = setTimeout(() => void finish("interrupted"), 1500);
        t.unref?.();
        timers.push(t);
      }

      // VERIFIED on Claude Code 2.1.280 (28 Sep, live smoke): {type:"rate_limit_event", rate_limit_info:{status,
      // resetsAt, rateLimitType, overageStatus, unifiedWindows:{five_hour:{utilization,resetsAt}, seven_day:{…}}}}.
      const toIso = (v: unknown) => { const n = num(v); return n === null ? null : (new Date(n < 1e12 ? n * 1000 : n).toISOString() as IsoTime); };
      const pct = (u: unknown) => { const n = num(u); return n === null ? null : Math.round(n <= 1 ? n * 100 : n); };
      const allowanceFrom = (info: Record<string, any>): AllowanceSnapshot => {
        const unified = record(info.unifiedWindows) ? info.unifiedWindows : null;
        const LABEL: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly (Opus)", seven_day_sonnet: "weekly (Sonnet)" };
        const windows = unified
          ? Object.entries(unified).filter(([, w]) => record(w)).map(([k, w]: [string, any]) => ({ label: LABEL[k] ?? k.replace(/_/g, " "), usedPercent: pct(w.utilization), resetsAt: toIso(w.resetsAt) }))
          : [{ label: String(info.rateLimitType ?? "window").replace(/_/g, " "), usedPercent: pct(info.utilization), resetsAt: toIso(info.resetsAt) }];
        return {
          accountSlot: input.binding.route === "claude-code-cli" ? input.binding.accountSlot : "claude:max",
          windows,
          creditsWouldBeUsed: false,
          limitReached: info.status === "rejected",
          source: "anthropic-oauth-usage-cached",
          readAt: new Date().toISOString() as IsoTime,
        };
      };

      function onToolRequest(id: string, request: Record<string, any>) {
        const tool = String(request.tool_name ?? "");
        const toolInput: Record<string, unknown> = record(request.input) ? request.input : {};
        const isQuestion = tool === "AskUserQuestion";
        const questions = isQuestion && Array.isArray(toolInput.questions)
          ? (toolInput.questions as unknown[]).slice(0, 4).filter(record).map((q, i) => ({ id: `question-${i + 1}`, question: redactText(q.question, 2000), options: Array.isArray(q.options) ? q.options.slice(0, 8).map((o: any) => redactText(o?.label ?? o, 160)) : undefined }))
          : [];
        const req = isQuestion
          ? { kind: "question" as const, questions }
          : helper && isContextModeTool(tool)
            ? { kind: "tool" as const, tool, input: toolInput }
          : /^mcp__/.test(tool) || tool === "ListMcpResourcesTool" || tool === "ReadMcpResourceTool"
            ? { kind: "mcp" as const, server: tool.split("__")[1] ?? null, tool }
            : { kind: "tool" as const, tool, input: toolInput };
        const verdict = policy.decide(tool, id, req);
        const reply = (behavior: "allow" | "deny", message?: string, updatedInput?: Record<string, unknown>) =>
          write({ type: "control_response", response: { subtype: "success", request_id: id, response: behavior === "allow" ? { behavior: "allow", updatedInput: updatedInput ?? toolInput } : { behavior: "deny", message: message ?? "Denied by the coding policy." } } });
        if (verdict.decision === "auto-allow") return reply("allow");
        if (verdict.decision === "auto-deny") {
          reply("deny", verdict.message);
          if (policy.capped) void finish("failed", { code: "policy_violation", message: "The role kept asking for actions the coding policy refuses, so it was stopped." });
          return;
        }
        const card: InputRequest = {
          id,
          kind: isQuestion ? "question" : "approval",
          nativeKind: tool,
          title: isQuestion ? "The agent is asking you" : `Allow ${tool}?`,
          detail: isQuestion ? questions.map((q) => q.question).join("\n\n") : detailOf(toolInput),
          ...(isQuestion ? { questions } : {}),
          escalatedBecause: verdict.message,
          expiresAt: isoIn(input.limits.inputTimeoutMs),
        };
        queue.push(card, (decision, answers) => {
          if (decision === "approve") {
            const answerMap = isQuestion ? Object.fromEntries(questions.map((q) => [q.question, answers?.[q.id] ?? answers?.[q.question] ?? ""])) : null;
            reply("allow", undefined, answerMap ? { ...toolInput, answers: answerMap } : toolInput);
          } else reply("deny", "The owner declined this. Don't retry it; report what you needed in your summary.");
        }, isQuestion ? undefined : requestKey("claude", tool, input.cwd, toolInput));
      }

      function handle(m: Record<string, any>) {
        if (settled) return;
        if (m.type === "control_response" && m.response?.request_id === initId) {
          if (initialized) return;
          if (m.response.subtype !== "success") { const c = classify(String(m.response.error ?? "") + stderr); void finish(c.status, { code: c.code, message: c.message }); return; }
          initialized = true;
          emit({ type: "step", label: input.session.mode === "resume" ? "Claude resumed its session" : "Claude started" });
          write({ type: "user", message: { role: "user", content: input.prompt }, parent_tool_use_id: null, session_id: "" });
          return;
        }
        if (m.type === "control_request") {
          const id = typeof m.request_id === "string" ? m.request_id : null;
          if (!id) return;
          if (m.request?.subtype === "can_use_tool") return onToolRequest(id, m.request);
          write({ type: "control_response", response: { subtype: "error", request_id: id, error: "Not supported by the coding harness." } });
          return;
        }
        if (m.type === "control_cancel_request") return;
        if (m.type === "system") {
          if (m.subtype === "init") {
            if (typeof m.session_id === "string") { sessionId = m.session_id; emit({ type: "session", id: m.session_id }); }
            if (typeof m.model === "string") { providerModel = m.model; emit({ type: "model", model: m.model, source: "init" }); }
          }
          if (/rate_limit/.test(String(m.subtype ?? "")) && record(m.rate_limit_info ?? m)) onRateLimit(record(m.rate_limit_info) ? m.rate_limit_info : m);
          return;
        }
        // UNVERIFIED shape: Claude Code's stream may carry `{type:"rate_limit_event", rate_limit_info:{status, resetsAt, rateLimitType, utilization?}}`.
        if (m.type === "rate_limit_event") { if (record(m.rate_limit_info)) onRateLimit(m.rate_limit_info); return; }
        if (m.type === "assistant" && !m.parent_tool_use_id) {
          const content = Array.isArray(m.message?.content) ? m.message.content : [];
          const said = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
          if (said) { completeText = said; text.set(said); }
          for (const b of content) if (b?.type === "tool_use" && typeof b.name === "string") emit({ type: "step", label: `Using ${b.name}` });
          return;
        }
        if (m.type === "result") {
          const u = record(m.usage) ? m.usage : {};
          usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens), reasoningTokens: null };
          emit({ type: "usage", usage });
          if (record(m.modelUsage)) {
            const keys = Object.keys(m.modelUsage);
            const bound = input.binding.model;
            const top = keys.includes(bound) ? bound : keys.sort((a, b) => (num(m.modelUsage[b]?.outputTokens) ?? 0) - (num(m.modelUsage[a]?.outputTokens) ?? 0))[0];
            if (top) { providerModel = top; emit({ type: "model", model: top, source: "usage" }); }
          }
          value = num(m.total_cost_usd);
          turns = num(m.num_turns);
          if (typeof m.session_id === "string") sessionId = m.session_id;
          if (typeof m.result === "string" && m.result) completeText = m.result;
          if (m.structured_output !== undefined && m.structured_output !== null) completeText = JSON.stringify(m.structured_output);
          text.final(completeText);
          if (interrupted) return void finish("interrupted");
          if (m.is_error || m.subtype !== "success") {
            const c = classify(`${m.subtype ?? ""} ${typeof m.result === "string" ? m.result : ""} ${(m.errors ?? []).join?.(" ") ?? ""} ${stderr}`);
            return void finish(c.status, { code: c.code, message: c.message });
          }
          return void finish("succeeded");
        }
      }

      function onRateLimit(info: Record<string, any>) {
        const snapshot = allowanceFrom(info);
        lastAllowance = snapshot;
        emit({ type: "allowance", snapshot });
        const high = snapshot.windows.find((w) => w.usedPercent !== null && w.usedPercent >= input.stopAtWindowPercent) ?? (snapshot.limitReached ? snapshot.windows[0] : null);
        if (high) {
          write({ type: "control_request", request_id: `coding-interrupt-${randomUUID()}`, request: { subtype: "interrupt" } });
          void finish("blocked_allowance", { code: "limit_reached", message: `Claude's ${high.label} window is at ${high.usedPercent ?? "its limit"}%${high.resetsAt ? `, resetting ${high.resetsAt}` : ""}. The role stopped before the limit.` });
        }
      }

      queueMicrotask(() => {
        if (input.signal.aborted) return cancel();
        if (input.binding.route !== "claude-code-cli") return void finish("failed", { code: "spawn_failed", message: "Not a Claude binding." });
        const binary = options.binary ?? claudeCodingBinary({ platform, env: options.env });
        if (!binary) return void finish("failed", { code: "not_installed", message: "Claude Code is not installed." });
        if (needsCommandShell(binary, platform)) return void finish("failed", { code: "not_installed", message: "Only the real claude.exe is started, never its npm shim." });
        ranVersion = versionCache.get(binary) ?? null; // already read by the pick; never a new spawn here
        if (!input.prompt.trim() || input.prompt.length > MAX_PROMPT || input.prompt.includes("\0")) return void finish("failed", { code: "spawn_failed", message: "The role prompt is empty or too long." });
        let args: string[];
        try {
          const base = options.tempDir ?? tmpdir();
          mkdirSync(base, { recursive: true });
          tempFolder = mkdtempSync(join(base, "coding-claude-"));
          const systemFile = join(tempFolder, "system.md");
          if (input.contextHelper && helperCheck?.ok)
            helper = contextModeLaunch({ request: input.contextHelper, resolution: helperCheck, runtime: options.contextRuntime ?? process.execPath, worktree: input.cwd, sessionId: input.session.id });
          else if (input.contextHelper && helperCheck && !helperCheck.ok) emit({ type: "step", label: "Context helper not used", detail: helperCheck.reason });
          writeFileSync(systemFile, helper ? `${input.system}

${helper.guidance}` : input.system, { mode: 0o600 });
          args = claudeArgs(input, systemFile, helper);
        } catch (e) { return void finish("failed", { code: "spawn_failed", message: (e as Error).message }); }
        // F3-26: a preview or quiet copy runs Claude on ITS home (CLAUDE_CONFIG_DIR), never the owner's.
        const home = cliHomeGuard("claude", options.env ?? process.env);
        if (!home.ok) return void finish("failed", { code: "signed_out", message: home.reason });
        // The live server runs each account on its OWN profile (30 Sep 2026): the binding's slot picks the
        // login, nothing is copied between profiles, and a copy keeps its own home whatever the slot says.
        const profile = home.copy ? home.env : claudeSlotEnv({ configDir: input.claudeConfigDir ?? null }, home.env);
        const env = childEnv({ env: profile, extra: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
        try {
          child = (options.spawn ?? spawn)(binary, args, { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: false }) as ChildProcessWithoutNullStreams;
        } catch { return void finish("failed", { code: "spawn_failed", message: "Claude Code could not be started." }); }
        const lines = jsonLines(handle, (why) => void finish("failed", { code: why === "output limit" ? "output_limit" : "protocol_error", message: `Claude returned an ${why}.` }));
        child.on("error", () => void finish("failed", { code: "spawn_failed", message: "Claude Code could not be started." }));
        child.stdin.on("error", () => { /* close decides */ });
        child.stderr.on("data", (c) => { stderr = (stderr + String(c)).slice(-4000); });
        child.stdout.on("data", (c) => lines.write(c));
        child.on("close", () => {
          processClosed = true;
          for (const fn of closeWaiters.splice(0)) fn();
          if (!settled) {
            lines.end();
            if (settled) return;
            if (interrupted) return void finish("interrupted");
            const c = classify(stderr);
            void finish(c.status, { code: c.code, message: c.message });
          }
        });
        input.signal.addEventListener("abort", cancel, { once: true });
        write({ type: "control_request", request_id: initId, request: { subtype: "initialize", hooks: {} } });
        const init = setTimeout(() => { if (!initialized) void finish("failed", { code: "protocol_error", message: "Claude did not initialise in time." }); }, options.initializeTimeoutMs ?? 60_000);
        init.unref?.();
        const wall = setTimeout(() => void finish("failed", { code: "timeout", message: "The role reached its wall-clock limit." }), input.limits.wallMs);
        wall.unref?.();
        timers.push(init, wall);
      });

      return {
        respond: (id, decision, answers) => queue.respond(id, decision, answers),
        interrupt,
        cancel,
        done,
      };
    },
  };
}
