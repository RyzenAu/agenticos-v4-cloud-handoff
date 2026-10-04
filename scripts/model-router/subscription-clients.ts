// scripts/model-router/subscription-clients.ts — the router's invokers for the two SUBSCRIPTION
// transports: the Codex pool through Hermes' warm API server (127.0.0.1:8642), and Claude through the
// official `claude -p` (scripts/claude-bridge.ts, in-process). Same contract as clients.ts: one
// timeout, one abort path, errors classified into ProviderError without provider body text, and the
// model the provider says actually ran (null when it doesn't say).
import type { ChatMessage } from "./clients";
import { httpProviderError } from "./clients";
import type { InvokeResult, RouteChoice } from "./router";
import { ProviderError } from "./router";

export const HERMES_ENDPOINT = "http://127.0.0.1:8642";
/** Hermes' own name for the Codex pool provider (config.yaml `provider: openai-codex`). */
export const HERMES_CODEX_PROVIDER = "openai-codex";

export type HermesChatOptions = {
  messages: ChatMessage[];
  /** Hermes API server key (API_SERVER_KEY). Read by NAME at call time by the caller; never logged. */
  key: string;
  request?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
  effort?: "low" | "medium" | "high";
  /** Delete the Hermes session straight after (default true): nothing of the prompt stays in its history. */
  forget?: boolean;
  /**
   * Pin the request to the routed model (model + provider openai-codex). Default false: the gateway's
   * own configured model runs ("hermes-agent"), exactly as before the router, and the receipt records
   * the model Hermes reports.
   */
  pin?: boolean;
};

const SESSION = /^[A-Za-z0-9_-]{4,120}$/;

/**
 * One chat turn on the Codex pool via Hermes' API server. By default the gateway's configured model
 * runs (as before the router); with `pin` the request names the routed model (Hermes honours an
 * explicit model + provider per request). The receipt records the model Hermes reports, else null.
 */
export async function hermesChat(choice: RouteChoice, options: HermesChatOptions, signal: AbortSignal): Promise<InvokeResult<string>> {
  if (choice.provider !== "codex" && choice.provider !== "hermes") throw new ProviderError("policy", `hermesChat can't run ${choice.provider}`, { sent: false });
  if (!options.key) throw new ProviderError("auth", "Hermes API server isn't configured", { sent: false });
  const endpoint = options.endpoint ?? HERMES_ENDPOINT;
  const request = options.request ?? fetch;
  const pin = options.pin === true && choice.provider === "codex";
  const body: Record<string, unknown> = {
    model: pin ? choice.providerModel : "hermes-agent",
    ...(pin ? { provider: HERMES_CODEX_PROVIDER } : {}),
    messages: options.messages,
    stream: false,
    ...(options.effort ? { model_options: { reasoning: { effort: options.effort } } } : {}),
  };
  let res: Response;
  try {
    res = await request(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw new ProviderError("cancelled", "cancelled", { sent: "unknown" });
    if ((error as { name?: string })?.name === "TimeoutError") throw new ProviderError("timeout", "timed out", { sent: "unknown" });
    const refused = /ECONNREFUSED|ConnectionRefused|Unable to connect/i.test(`${(error as { code?: string })?.code ?? ""} ${(error as Error)?.message ?? ""}`);
    // Hermes not running did no work; anything else may have reached it.
    throw new ProviderError(refused ? "unavailable" : "transport", refused ? "Hermes isn't running" : "transport failure", { sent: refused ? false : "unknown" });
  }
  const session = res.headers.get("X-Hermes-Session-Id");
  if (options.forget !== false && session && SESSION.test(session))
    void request(`${endpoint}/api/sessions/${session}`, { method: "DELETE", headers: { Authorization: `Bearer ${options.key}` }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!res.ok) throw httpProviderError(res.status, await res.text().catch(() => ""), res.headers);
  const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }>; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
  if (!data) throw new ProviderError("unknown", "unreadable reply", { httpStatus: res.status, sent: "unknown" });
  const reported = typeof data.model === "string" && /^[\w.:/-]{1,80}$/.test(data.model) && data.model !== "hermes-agent" ? data.model : null;
  return {
    value: String(data.choices?.[0]?.message?.content ?? "").trim(),
    providerModel: reported,
    httpStatus: res.status,
    usage: {
      inputTokens: typeof data.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : null,
      outputTokens: typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : null,
    },
  };
}

/** The in-process Claude bridge's `complete` (scripts/claude-bridge.ts claudeBridge().complete). */
export type ClaudeComplete = (body: { model: string; messages: ChatMessage[] }) => Promise<{
  choices: Array<{ message: { content: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}>;

/** A claude -p failure, classified. The CLI's own text is used for the class only, never stored. */
export function claudeFailure(error: unknown, aborted: boolean): ProviderError {
  if (error instanceof ProviderError) return error;
  if (aborted) return new ProviderError("cancelled", "cancelled", { sent: "unknown" });
  const message = String((error as Error)?.message ?? "");
  if (/took longer than|timed out|TimeoutError/i.test(message)) return new ProviderError("timeout", "timed out", { sent: "unknown" });
  if (/usage limit|limit reached|rate limit|limit will reset|out of extra usage/i.test(message))
    return new ProviderError("quota_exhausted", "Claude subscription window used up", { sent: false });
  if (/not logged in|please run \/login|invalid api key|authentication/i.test(message)) return new ProviderError("auth", "Claude Code isn't signed in", { sent: false });
  if (/ENOENT|not recognized|cannot find/i.test(message)) return new ProviderError("unavailable", "Claude Code isn't installed", { sent: false });
  if (/Unknown model/i.test(message)) return new ProviderError("bad_request", "unknown Claude model", { sent: false });
  return new ProviderError("unavailable", "Claude Code failed", { sent: "unknown" });
}

/** One chat turn on the routed Claude model through the subscription (`claude -p`). */
export async function claudeChat(choice: RouteChoice, options: { complete: ClaudeComplete; messages: ChatMessage[] }, signal: AbortSignal): Promise<InvokeResult<string>> {
  if (choice.provider !== "claude-sub") throw new ProviderError("policy", `claudeChat can't run ${choice.provider}`, { sent: false });
  if (signal.aborted) throw new ProviderError("cancelled", "cancelled before start", { sent: false });
  let out: Awaited<ReturnType<ClaudeComplete>>;
  try {
    // claude -p has no abort hook here; an abort after the start is reported as cancelled below.
    out = await Promise.race([
      options.complete({ model: choice.providerModel, messages: options.messages }),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
  } catch (error) {
    throw claudeFailure(error, signal.aborted);
  }
  return {
    value: out.choices?.[0]?.message?.content ?? "",
    // The CLI runs exactly the model it was given (`--model`), so that is the model that ran.
    providerModel: choice.providerModel,
    usage: {
      inputTokens: typeof out.usage?.prompt_tokens === "number" ? out.usage.prompt_tokens : null,
      outputTokens: typeof out.usage?.completion_tokens === "number" ? out.usage.completion_tokens : null,
    },
  };
}
