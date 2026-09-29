// The Dream's model calls, through the model router (task dream.nightly). Every engine is one route:
// the owner's engine choice is the router's `selected` model (dream/core.ts dreamSelection), and every
// call writes a router receipt naming the model that ran. The CLI engines (claude -p, codex exec,
// hermes chat) still spawn their processes, unchanged (no model is passed that wasn't before); the
// spawn is the router's `invoke`. OpenRouter keeps its pre-E2 request (json_object output, same key
// lookup and headers) and adds the router's receipt.
//
// dream.nightly has no free fallback (a whole night's digest doesn't fit a free tier, and the owner
// chose the engine), so one call is one attempt. A failed night keeps the engine's own reason. The
// Dream always tries its engine, as before E2: another surface's recent limit on the same model
// (shared router health) never skips the night unheard.
import { httpProviderError, type ChatMessage } from "../model-router/clients";
import { defaultReceiptSink, defaultRequest } from "../model-router/defaults";
import { MemoryHealthStore, type HealthStore } from "../model-router/health";
import type { ReceiptSink, RouterReceipt } from "../model-router/receipts";
import { ProviderError, runRouted, type InvokeResult, type RouteChoice } from "../model-router/router";
import { claudeFailure } from "../model-router/subscription-clients";
import { DREAM_TASK, type DreamEngine } from "./core";

export type DreamReply = {
  text: string;
  /** The model the provider or CLI reported (null when it doesn't say). */
  providerModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd?: number | null;
};

export type DreamRouteDeps = {
  root: string;
  sink?: ReceiptSink;
  health?: HealthStore;
  /** Key presence by NAME (tests); default: the router's own lookup. */
  hasKey?: (name: string) => boolean;
  clock?: () => number;
};

export type DreamCallResult = { reply: DreamReply; receipt: RouterReceipt; choice: RouteChoice };

/** An engine failure the router can classify; the original message is kept for the night's status. */
export function engineFailure(error: unknown, engine: DreamEngine, aborted = false): ProviderError {
  if (error instanceof ProviderError) return error;
  if (engine === "claude") return claudeFailure(error, aborted);
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return httpProviderError(status, "");
  const message = String((error as Error)?.message ?? error);
  if (aborted) return new ProviderError("cancelled", "cancelled", { sent: "unknown" });
  if (/ENOENT|not installed|not recognized/i.test(message)) return new ProviderError("unavailable", `${engine} isn't installed`, { sent: false });
  if (/took longer than|timed out|ETIMEDOUT/i.test(message)) return new ProviderError("timeout", "timed out", { sent: "unknown" });
  return new ProviderError("unavailable", `${engine} failed`, { sent: "unknown" });
}

/**
 * One Dream model call through the router. `call` runs the engine (spawn or HTTP) for the routed
 * choice. Returns the reply and its receipt; throws the engine's own error (not the router's
 * "no eligible model") when the one attempt failed, after the receipt is written.
 */
export async function dreamCall(
  engine: DreamEngine,
  selection: { selected: string; providers: string[]; runs?: string | null },
  deps: DreamRouteDeps,
  call: (choice: RouteChoice, signal: AbortSignal) => Promise<DreamReply>,
  options: { parentRequestId?: string | null; sideEffects?: boolean } = {},
): Promise<DreamCallResult> {
  let lastError: Error | null = null;
  try {
    const run = await runRouted<DreamReply>({
      task: DREAM_TASK,
      caller: `scripts/run-dream (${engine})`,
      parentRequestId: options.parentRequestId ?? null,
      sink: deps.sink ?? defaultReceiptSink(deps.root),
      clock: deps.clock,
      // The hermes engine is an agent run that writes tonight's file itself: never re-run elsewhere.
      sideEffects: options.sideEffects,
      constraints: {
        selected: selection.selected,
        selectedBy: "owner",
        providers: selection.providers,
        health: deps.health ?? new MemoryHealthStore(),
        ...(deps.hasKey ? { hasKey: deps.hasKey } : {}),
      },
      invoke: async (choice, signal): Promise<InvokeResult<DreamReply>> => {
        let reply: DreamReply;
        try {
          reply = await call(choice, signal);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          throw engineFailure(error, engine, signal.aborted);
        }
        return {
          value: reply,
          providerModel: reply.providerModel,
          usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens },
          costUsd: reply.costUsd ?? null,
        };
      },
    });
    return { reply: run.value, receipt: run.receipt, choice: run.choice };
  } catch (error) {
    // After a failed attempt the router reports "no eligible model" (or the classified error); the
    // engine's own reason is what the night records. A refusal before any attempt stays the router's.
    if (lastError) throw lastError;
    throw error;
  }
}

/**
 * The OpenRouter engine's request, as before E2 (model as configured, json_object output, 0.4, 8,000
 * tokens, 10 minutes, same headers), plus usage.include so the receipt carries OpenRouter's reported
 * cost. Failures keep the pre-E2 message (status and body excerpt) for the night's status file.
 */
export function openRouterDreamCall(key: string, model: string, messages: ChatMessage[], options: { request?: typeof fetch } = {}) {
  return async (_choice: RouteChoice, signal: AbortSignal): Promise<DreamReply> => {
    const resp = await defaultRequest(options.request)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "http://127.0.0.1:8081", "X-Title": "Claude OS Dream" },
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, temperature: 0.4, max_tokens: 8000, usage: { include: true } }),
    });
    if (!resp.ok) throw Object.assign(new Error(`OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`), { status: resp.status });
    const data: any = await resp.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("OpenRouter returned no content");
    return {
      text: content,
      providerModel: typeof data?.model === "string" ? data.model : null,
      inputTokens: typeof data?.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : null,
      outputTokens: typeof data?.usage?.completion_tokens === "number" ? data.usage.completion_tokens : null,
      costUsd: typeof data?.usage?.cost === "number" ? data.usage.cost : null,
    };
  };
}

/** The model the Codex CLI runs when none is passed: the top-level `model = "..."` in its config.toml. */
export function codexConfigModel(toml: string | null): string | null {
  if (!toml) return null;
  const top = toml.split(/^\s*\[/m)[0];
  const m = /^\s*model\s*=\s*["']([^"'\r\n]{1,80})["']/m.exec(top);
  return m ? m[1] : null;
}

/** Hermes' default model: `model:` then `default: ...` in its config.yaml (its fallbacks may still answer). */
export function hermesConfigModel(yaml: string | null): string | null {
  if (!yaml) return null;
  const m = /^model:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+default:[ \t]*["']?([\w./:-]{1,80})["']?[ \t]*$/m.exec(yaml);
  return m ? m[1] : null;
}
