// scripts/model-router/clients.ts — OpenAI-compatible chat adapters the router can invoke directly
// (OpenRouter, Groq). One timeout, one abort path and one sanitised error classification per call.
// Keys come from providerKey() by NAME and never leave this function; errors never carry body text.
import { providerKey } from "../provider-config";
import { catalogueModel, catalogueProvider } from "./catalogue";
import type { InvokeResult, RouteChoice } from "./router";
import { ProviderError } from "./router";

const ENDPOINTS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

export const CHAT_PROVIDERS = Object.keys(ENDPOINTS);

export type ChatContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
export type ChatMessage = { role: "system" | "user" | "assistant"; content: ChatContent };

/** Retry-After (seconds or date) or Groq's "try again in 7.5s", in ms; null when absent. */
export function retryAfterMs(headers: Headers | null, body: string): number | null {
  const h = headers?.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 6 * 3_600_000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 6 * 3_600_000));
  }
  const m = /try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(body);
  if (m) return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3])) * 1000;
  return null;
}

/** HTTP failure -> sanitised ProviderError. Every HTTP error reply means the work was not done (sent:false),
 *  except 5xx, where the provider may have acted before failing. */
export function httpProviderError(
  status: number,
  bodyText: string,
  headers: Headers | null = null,
): ProviderError {
  const body = bodyText.slice(0, 2000);
  const retry = retryAfterMs(headers, body);
  if (status === 402 || (status === 403 && /credit|balance|insufficient|purchase/i.test(body)))
    return new ProviderError(
      "insufficient_funds",
      `HTTP ${status}: provider balance or credit exhausted`,
      { httpStatus: status, sent: false, retryAfterMs: retry },
    );
  if (status === 429)
    return /quota|per day|RPD|TPD|RESOURCE_EXHAUSTED|daily/i.test(body)
      ? new ProviderError("quota_exhausted", `HTTP 429: quota exhausted`, {
          httpStatus: status,
          sent: false,
          retryAfterMs: retry,
        })
      : new ProviderError("rate_limited", `HTTP 429: rate limited`, {
          httpStatus: status,
          sent: false,
          retryAfterMs: retry,
        });
  if (status === 401 || status === 403)
    return new ProviderError("auth", `HTTP ${status}: not authorised`, {
      httpStatus: status,
      sent: false,
    });
  if (status === 404)
    return new ProviderError("not_found", `HTTP 404: model not found`, {
      httpStatus: status,
      sent: false,
    });
  if (status === 400 || status === 413 || status === 422)
    return new ProviderError("bad_request", `HTTP ${status}: request refused`, {
      httpStatus: status,
      sent: false,
    });
  if (status >= 500)
    return new ProviderError("unavailable", `HTTP ${status}: provider unavailable`, {
      httpStatus: status,
      sent: "unknown",
      retryAfterMs: retry,
    });
  return new ProviderError("unknown", `HTTP ${status}`, { httpStatus: status, sent: "unknown" });
}

export type ChatOptions = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  root: string;
  request?: typeof fetch;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra OpenRouter `provider` routing fields. */
  openRouterProvider?: Record<string, unknown>;
  /** Extra top-level body fields for an OpenRouter call (e.g. reasoning: { effort: "none" }). */
  openRouterBody?: Record<string, unknown>;
};

/**
 * One chat completion on the routed model. An OpenRouter `:free` model is sent with
 * provider.max_price 0, so a wrong id can never spend the funded key.
 */
export async function openAiCompatibleChat(
  choice: RouteChoice,
  options: ChatOptions,
  signal: AbortSignal,
): Promise<InvokeResult<string>> {
  const endpoint = ENDPOINTS[choice.provider];
  if (!endpoint)
    throw new ProviderError("policy", `No direct client for ${choice.provider}`, { sent: false });
  const provider = catalogueProvider(choice.provider);
  const key = provider.keyNames
    .map((n) => providerKey(options.root, n, { home: options.home, env: options.env }))
    .find(Boolean);
  if (!key)
    throw new ProviderError("auth", `${provider.keyNames.join("/")} not configured`, {
      sent: false,
    });
  const model = catalogueModel(choice.model);
  const body: Record<string, unknown> = {
    // choice.providerModel is the catalogue's id, or the owner's exact pick for an owner-choice entry.
    model: choice.providerModel || model.providerModel,
    messages: options.messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 1024,
  };
  if (choice.provider === "openrouter") {
    const routing: Record<string, unknown> = { ...(options.openRouterProvider ?? {}) };
    if (choice.route === "free") routing.max_price = { prompt: 0, completion: 0 };
    if (Object.keys(routing).length) body.provider = routing;
    body.usage = { include: true };
    if (options.openRouterBody) for (const [k, v] of Object.entries(options.openRouterBody)) if (!(k in body)) body[k] = v;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (choice.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://muventures.com.au";
    headers["X-Title"] = "M&U Ventures - AgenticOS";
  }
  const request = options.request ?? fetch;
  let res: Response;
  try {
    res = await request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 90_000)]),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (signal.aborted) throw new ProviderError("cancelled", "cancelled", { sent: "unknown" });
    if (name === "TimeoutError")
      throw new ProviderError("timeout", "timed out", { sent: "unknown" });
    // A connection that never opened did no work; anything else may have reached the provider.
    const code = (error as { code?: string })?.code ?? "";
    const neverSent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ConnectionRefused/i.test(
      `${code} ${(error as Error)?.message ?? ""}`,
    );
    throw new ProviderError("transport", "transport failure", {
      sent: neverSent ? false : "unknown",
    });
  }
  if (!res.ok) throw httpProviderError(res.status, await res.text().catch(() => ""), res.headers);
  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    model?: string;
  } | null;
  if (!data)
    throw new ProviderError("unknown", "unreadable reply", {
      httpStatus: res.status,
      sent: "unknown",
    });
  return {
    value: data.choices?.[0]?.message?.content ?? "",
    providerModel: typeof data.model === "string" ? data.model : null,
    usage: {
      inputTokens: typeof data.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : null,
      outputTokens:
        typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : null,
    },
    costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
    httpStatus: res.status,
  };
}
