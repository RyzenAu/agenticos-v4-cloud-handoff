import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { routedChat, type RoutedChatDeps, type RoutedChatOptions } from "../../model-router/chat";
import type { RunResult } from "../../model-router/router";
import type { OwnershipSpec } from "../contracts";
import { redactText } from "../redact";
import { ownsPath } from "../registry";
import { git } from "../worktree";
import { decider } from "./proc";
import { NO_USAGE, type RoleRunner, type RunnerEvent, type RunnerHandle, type RunnerOutcome, type RunnerStart, type RunnerStatus } from "./types";

/**
 * A routed text model as a coding role (task C3: "Hermes and DeepSeek (or another connected model) run as
 * selectable runners through the router"). One call through scripts/model-router (task `coding.router`),
 * so the owner's rules hold: the selected model runs if it can, otherwise the router falls back
 * AUTOMATICALLY along the chain (Hermes' Codex pool → DeepSeek → Cline → MiMo), and the receipt it
 * writes names the model that ACTUALLY ran plus `fallbackFrom`. No in-app cap. The outcome carries the
 * real provider, model and cost, so the job page never claims the selected model ran when another did.
 *
 * A text model has no tools, so:
 *  - builder: the prompt carries the owned files' current text; the model answers JSON
 *    {"files":[{"path","content"}],"summary"}; every path goes through the same policy engine (owned,
 *    inside the worktree, no secrets); allowed files are written and committed on the role branch;
 *  - reviewer: the orchestrator's review prompt already carries the diff and test results; the answer is
 *    the verdict JSON, returned as finalText.
 * There is no native session, so a resume is a fresh call with the worktree's current state.
 */

export type RouterRunnerOptions = {
  root?: string;
  deps?: RoutedChatDeps;
  /** Injected for tests (default: routedChat). */
  chat?: (options: RoutedChatOptions) => Promise<RunResult<string>>;
  timeoutMs?: number;
  /** Most bytes of owned-file text put into a builder prompt. */
  contextBytes?: number;
  /** The ownership of the role (builder) — the orchestrator passes the TaskSpec's. */
  owns?: (jobId: string, roleId: string) => OwnershipSpec | null;
};

const ROUTED_IDENTITY = ["-c", "user.name=AgenticOS routed role", "-c", "user.email=routed-role@agentic-os.invalid", "-c", "commit.gpgSign=false", "-c", "core.autocrlf=false"];

/** The JSON object in a model's reply (code fences and chatter tolerated). */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { const v = JSON.parse(body.slice(start, end + 1)); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

function ownedContext(cwd: string, owns: OwnershipSpec, budget: number): string {
  const tracked = git(cwd, ["ls-files", "-z"], { allowFail: true }).stdout.split("\0").filter(Boolean);
  const files = [...new Set([...tracked.filter((f) => ownsPath(owns, f)), ...owns.newFiles])];
  let used = 0;
  const parts: string[] = [];
  for (const f of files.slice(0, 40)) {
    const full = join(cwd, f);
    let text = "(new file: does not exist yet)";
    if (existsSync(full) && lstatSync(full).isFile()) {
      const raw = readFileSync(full, "utf8");
      text = raw.length > 40_000 ? `${raw.slice(0, 40_000)}\n[truncated]` : raw;
    }
    if (used + text.length > budget) { parts.push(`--- ${f}\n(omitted: context budget)`); continue; }
    used += text.length;
    parts.push(`--- ${f}\n${text}`);
  }
  return parts.join("\n\n");
}

export function routerRunner(options: RouterRunnerOptions = {}): RoleRunner {
  return {
    kind: "model-router",
    start(input: RunnerStart): RunnerHandle {
      const startedAt = Date.now();
      let settled = false;
      const emit = (e: RunnerEvent) => { if (!settled) { try { input.onEvent(e); } catch { /* never breaks a run */ } } };
      const controller = new AbortController();
      let stopReason: "cancel" | "interrupt" | null = null;
      const policy = decider(input.policy, emit);
      let resolveDone!: (o: RunnerOutcome) => void;
      const done = new Promise<RunnerOutcome>((r) => { resolveDone = r; });
      const base = (): RunnerOutcome => ({ status: "failed", error: null, finalText: "", sessionId: null, providerModel: null, usage: { ...NO_USAGE }, valueUsdEquivalent: null, turns: 1, startedAt, endedAt: Date.now(), allowanceEnd: null, accountPlan: null, fallbackFrom: null, routedProvider: null, routedCost: null });
      const finish = (o: Partial<RunnerOutcome> & { status: RunnerStatus }) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener("abort", cancel);
        resolveDone({ ...base(), ...o, endedAt: Date.now() });
      };
      function cancel() { stopReason = "cancel"; controller.abort(); }
      function interrupt() { stopReason = "interrupt"; controller.abort(); }
      input.signal.addEventListener("abort", cancel, { once: true });

      queueMicrotask(async () => {
        const b = input.binding;
        if (b.route !== "model-router") return finish({ status: "failed", error: { code: "spawn_failed", message: "Not a routed binding." } });
        const builder = !input.readOnly;
        const owns = options.owns?.(input.jobId, input.roleId) ?? null;
        let prompt = input.prompt;
        if (builder) {
          if (!owns) return finish({ status: "failed", error: { code: "spawn_failed", message: "A routed builder needs its ownership." } });
          prompt += `\n\nYOUR OWNED FILES (current text):\n${ownedContext(input.cwd, owns, options.contextBytes ?? 120_000)}\n\nAnswer with ONLY one JSON object, no prose: {"files":[{"path":"<repo-relative path you own>","content":"<the complete new file text>"}],"summary":"<one paragraph: what you changed and why>"}. Include only files you change. Never include a file you don't own.`;
        }
        const freeOnly = b.model.startsWith("cline/");
        emit({ type: "step", label: `Routing to ${b.model} (${freeOnly ? "free routes only" : `automatic fallback along ${b.task}`})` });
        let run: RunResult<string>;
        try {
          run = await (options.chat ?? routedChat)({
            task: b.task,
            caller: `scripts/coding/runners/router (${input.role})`,
            messages: [{ role: "system", content: input.system }, { role: "user", content: prompt }],
            root: options.root,
            timeoutMs: options.timeoutMs ?? Math.min(input.limits.wallMs, 10 * 60_000),
            constraints: { selected: b.model, selectedBy: "owner", freeOnly },
            parentRequestId: input.jobId,
            signal: controller.signal,
            deps: options.deps,
          });
        } catch (e) {
          if (stopReason === "interrupt") return finish({ status: "interrupted" });
          if (stopReason === "cancel") return finish({ status: "cancelled", error: { code: "unknown", message: "Stopped by the owner." } });
          const err = e as { code?: string; message?: string };
          const exhausted = err.code === "exhausted_free" || err.code === "quota_exhausted" || err.code === "rate_limited";
          return finish({ status: exhausted ? "blocked_allowance" : "failed", error: { code: exhausted ? "limit_reached" : "unknown", message: redactText(err.message ?? "The routed model failed.", 600) } });
        }
        const r = run.receipt;
        emit({ type: "model", model: r.model, source: "router" });
        if (r.fallbackFrom) emit({ type: "step", label: `${r.fallbackFrom} was unavailable; the router ran ${r.model} instead`, detail: redactText(r.reason, 300) });
        const usage = { ...NO_USAGE, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
        emit({ type: "usage", usage });
        const common = {
          providerModel: r.model, routedProvider: r.provider, routedProviderModel: r.providerModel, fallbackFrom: r.fallbackFrom,
          routedCost: { basis: r.costBasis, usd: r.costUsd, priceAsOf: r.priceAsOf, route: r.route }, usage,
          valueUsdEquivalent: r.costUsd,
        };
        const reply = String(run.value ?? "");
        if (!builder) {
          emit({ type: "text", text: redactText(reply, 16_000), final: true });
          return finish({ status: "succeeded", finalText: redactText(reply, 32_000), ...common });
        }
        const json = extractJson(reply);
        const files = Array.isArray(json?.files) ? (json!.files as unknown[]) : null;
        if (!files) return finish({ status: "failed", error: { code: "protocol_error", message: "The routed model didn't answer with the files JSON." }, finalText: redactText(reply, 4000), ...common });
        const written: string[] = [];
        for (const raw of files.slice(0, 40)) {
          const f = raw as { path?: unknown; content?: unknown };
          if (typeof f?.path !== "string" || typeof f.content !== "string") continue;
          const rel = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
          const verdict = policy.decide("routed-file", `file-${written.length}-${rel}`, { kind: "file-change", paths: [rel] });
          if (verdict.decision !== "auto-allow") continue;
          const full = resolve(input.cwd, rel);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, f.content);
          written.push(rel);
        }
        const summary = typeof json?.summary === "string" ? json.summary : "";
        emit({ type: "text", text: redactText(summary, 4000), final: true });
        if (!written.length) return finish({ status: "succeeded", finalText: redactText(summary || "No owned file changed.", 8000), ...common });
        // The harness's safe git (hooks, fsmonitor and other exec-capable config forced off).
        const add = git(input.cwd, [...ROUTED_IDENTITY, "add", "--", ...written], { allowFail: true });
        const commit = add.ok
          ? git(input.cwd, [...ROUTED_IDENTITY, "commit", "--no-verify", "-q", "-m", `${input.roleId}: ${(summary.split("\n")[0] || "routed change").slice(0, 120)}\n\nModel that ran: ${r.model}${r.fallbackFrom ? ` (fallback from ${r.fallbackFrom})` : ""}`], { allowFail: true })
          : add;
        if (!commit.ok) return finish({ status: "failed", error: { code: "unknown", message: "The routed change couldn't be committed." }, ...common });
        emit({ type: "step", label: `Committed ${written.length} owned file(s)` });
        finish({ status: "succeeded", finalText: redactText(summary, 8000), ...common });
      });

      return {
        respond: () => { throw new Error("A routed role never waits for input."); },
        interrupt,
        cancel,
        done,
      };
    },
  };
}
