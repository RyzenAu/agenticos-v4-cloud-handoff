// scripts/llm/gemini.ts — Gemini access through the model router (Stage E1).
//
// Every fallback this file had before Stage E1 is kept (owner: nothing narrowed; paid fallbacks allowed):
//   - tier "flash" runs the router task video.understand: free Gemini first (gemini-3.8-flash, then
//     gemini-flash-latest; billing on the key is unverified, so their receipts say cost unknown), then the
//     pre-E1 PAID fallback, OpenRouter google/gemini-2.5-flash-lite (metered receipt, priced from OpenRouter's
//     usage.cost). A "high demand" 503/429 is still retried with backoff on the same Gemini model first.
//     As before E1 (isFallbackWorthy), only 404, 429, 5xx, quota bodies and no-answer move on; a 400 or a
//     401/403 ends the call, so an auth problem never becomes paid OpenRouter spend (REVIEW-E12 BL4b).
//   - tier "pro" is the owner's explicit choice of a PAID model (OpenRouter google/gemini-3.1-pro-preview), with
//     no fallback, exactly as before E1 (router task video.understand.pro): if it fails, the call fails clearly.
//   - skipDirect (photo-index) is the router task photo.index: its consented OpenRouter route only.
// Every attempt writes a router receipt (.operator-data/model-router/receipts.jsonl) with the model
// that actually ran and fallbackFrom. Direct calls are also still counted by the shared call counter
// (.operator-data/ai-usage-calls.json) for /usage's Gemini row.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { providerKey } from "../provider-config";
import { installCallCounter } from "../ai-usage/call-counter";
import { catalogueModel, modelByProviderId, taskChain } from "../model-router/catalogue";
import { httpProviderError } from "../model-router/clients";
import { type HealthStore } from "../model-router/health";
import { callHealth } from "../model-router/defaults";
import { routerReceiptSink, type ReceiptSink } from "../model-router/receipts";
import { ProviderError, RouteError, runRouted, type RouteChoice } from "../model-router/router";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

export type GeminiTier = "flash" | "pro";

/** The first free direct model for each tier, from the catalogue. `pro` has none: the direct key's
 * Pro model has no free tier (pricing page, checked 27 Sep 2026). */
export const DIRECT_MODELS: Record<GeminiTier, string | null> = {
  flash: taskChain("video.understand", "gemini")[0] ?? null,
  pro: null,
};

/** OpenRouter ids from the catalogue: flash-lite for the consented photo index, 3.1 Pro for the explicit pro tier. */
export const OPENROUTER_MODELS: Record<GeminiTier, string> = {
  flash: catalogueModel("openrouter/gemini-2.5-flash-lite").providerModel,
  pro: catalogueModel("openrouter/gemini-3.1-pro-preview").providerModel,
};

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { videoUrl: string };

export type GeminiGenerateOptions = {
  tier: GeminiTier;
  parts: GeminiPart[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Override the direct-Gemini model id (tests, or a future working Pro model). */
  model?: string;
  /** Override the OpenRouter model id (tests, or a pricier/cheaper choice for one call). */
  openRouterModel?: string;
  /** Pin OpenRouter to a single upstream provider. Needed for video_url + YouTube: only Google
   * AI Studio accepts YouTube links, Vertex AI (OpenRouter's other Gemini backend) rejects them. */
  openRouterProvider?: string;
  /** Extra fields merged into OpenRouter's `provider` routing object, e.g.
   * `{ data_collection: "deny", max_price: {...} }` for a consent-gated caller (photo-index) that
   * must never let a provider train on the image, and must never silently exceed a quoted price. */
  openRouterProviderOptions?: Record<string, unknown>;
  /** Skip the direct-Gemini attempt entirely and go straight to OpenRouter, regardless of tier.
   * For callers where "free-first" is wrong even for `flash` — e.g. photo-index's remote vision
   * path, which is consent-gated to OpenRouter's `data_collection: "deny"` guarantee and must
   * never fall through to Google's own free API (a different data-use policy) instead. */
  skipDirect?: boolean;
  /** Abort each HTTP attempt after this many ms (default 90s — a video call can be slow). */
  timeoutMs?: number;
  root?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
  ledgerFile?: string;
  /** Delays (ms) between retries of a direct-Gemini "high demand" (503/429) response, tried before
   *  giving up on the free direct API and falling over to paid OpenRouter. Default 10s/20s/40s —
   *  see isHighDemandRetryable. Tests override with `[]` or tiny values. */
  retryDelaysMs?: number[];
  /** Injectable delay, so a test never actually waits out a real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Receipt sink (defaults to the router's JSONL sink under `root`). */
  sink?: ReceiptSink;
  /** Router health (defaults to the shared file store; a test with an injected `request` gets a fresh one). */
  health?: HealthStore;
};

export type GeminiResult = {
  text: string;
  model: string;
  provider: "gemini" | "openrouter";
  ms: number;
  /** OpenRouter's own reported cost (`usage.cost`, USD) when available. Direct Gemini is free. */
  costUsd?: number;
  /** Set when the selected model was unavailable and a free one answered instead (catalogue id). */
  fallbackFrom?: string;
};

function directPartsBody(parts: GeminiPart[]) {
  return parts.map((p) => {
    if ("text" in p) return { text: p.text };
    if ("inlineData" in p) return { inline_data: { mime_type: p.inlineData.mimeType, data: p.inlineData.data } };
    return { file_data: { file_uri: p.videoUrl } };
  });
}

function openRouterContent(parts: GeminiPart[]) {
  return parts.map((p) => {
    if ("text" in p) return { type: "text" as const, text: p.text };
    if ("inlineData" in p)
      return { type: "image_url" as const, image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } };
    return { type: "video_url" as const, video_url: { url: p.videoUrl } };
  });
}

/** 404 (retired model), 429, any 5xx (Gemini's direct API returns a plain 503 "high demand,
 * UNAVAILABLE" fairly often in practice — confirmed both in scripts/vision.ts's own notes and
 * during this file's real end-to-end test, 25 Sep 2026), or a RESOURCE_EXHAUSTED quota body → the
 * router tries the next FREE Gemini model. Any other failure (bad request, auth, safety block, …)
 * is a real error and is thrown straight away. Never a reason to spend OpenRouter credit. */
export function isFallbackWorthy(status: number, bodyText: string): boolean {
  return status === 404 || status === 429 || status >= 500 || bodyText.includes("RESOURCE_EXHAUSTED");
}

/** 503 ("high demand"/UNAVAILABLE — Gemini's direct API's own common overload response) or 429
 *  (rate limit): both are transient, so a direct-Gemini failure of this shape is retried with
 *  backoff on the same free model before the router moves on. A 404 (model retired) or any other
 *  5xx isn't retried the same way — those aren't "busy right now", they're broken. */
export const HIGH_DEMAND_RETRY_DELAYS_MS = [10_000, 20_000, 40_000];

export function isHighDemandStatus(status: number | undefined): boolean {
  return status === 503 || status === 429;
}

type DirectAttempt =
  | { ok: true; result: GeminiResult }
  | { ok: false; fallback: boolean; status?: number; error: string };

async function callDirect(
  model: string,
  options: GeminiGenerateOptions,
  key: string,
  request: typeof fetch,
): Promise<DirectAttempt> {
  const started = Date.now();
  let response: Response;
  try {
    response = await request(`${GEMINI_API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: directPartsBody(options.parts) }],
        generationConfig: { temperature: options.temperature ?? 0.2, maxOutputTokens: options.maxOutputTokens ?? 1024 },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
    });
  } catch (e) {
    return { ok: false, fallback: true, error: e instanceof Error ? e.message : String(e) };
  }
  const bodyText = await response.text();
  if (!response.ok)
    return { ok: false, fallback: isFallbackWorthy(response.status, bodyText), status: response.status, error: `${response.status} ${bodyText.slice(0, 300)}` };
  let data: any = {};
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, fallback: true, error: "invalid JSON response" };
  }
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? "")
    .join("")
    .trim();
  if (!text) return { ok: false, fallback: true, error: `empty response (finishReason: ${data?.candidates?.[0]?.finishReason ?? "unknown"})` };
  return { ok: true, result: { text, model, provider: "gemini", ms: Date.now() - started } };
}

/** Calls `callDirect`, retrying a "high demand" (503/429) response with backoff before giving up
 *  and letting the caller fall over to OpenRouter — free retries beat a paid fallback call. Any
 *  other failure shape (404, invalid JSON, empty response, network error) returns on the first try,
 *  same as before this existed. */
async function callDirectWithRetry(
  model: string,
  options: GeminiGenerateOptions,
  key: string,
  request: typeof fetch,
  log: (line: string) => void,
): Promise<DirectAttempt> {
  const delays = options.retryDelaysMs ?? HIGH_DEMAND_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = await callDirect(model, options, key, request);
  for (let i = 0; i < delays.length && !attempt.ok && attempt.fallback && isHighDemandStatus(attempt.status); i++) {
    log(`Gemini ${model}: high demand (${attempt.error.slice(0, 60)}) — retrying in ${delays[i] / 1000}s (attempt ${i + 2}/${delays.length + 1})`);
    await sleep(delays[i]);
    attempt = await callDirect(model, options, key, request);
  }
  return attempt;
}

async function callOpenRouter(
  model: string,
  options: GeminiGenerateOptions,
  key: string,
  request: typeof fetch,
): Promise<GeminiResult> {
  const started = Date.now();
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: openRouterContent(options.parts) }],
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxOutputTokens ?? 1024,
  };
  if (options.openRouterProvider || options.openRouterProviderOptions)
    body.provider = { ...(options.openRouterProvider ? { only: [options.openRouterProvider] } : {}), ...options.openRouterProviderOptions };
  body.usage = { include: true };
  const response = await request(OPENROUTER_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://muventures.com.au",
      "X-Title": "M&U Ventures - AgenticOS-v4",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
  });
  const bodyText = await response.text();
  if (!response.ok) throw httpProviderError(response.status, bodyText, response.headers);
  let data: any = {};
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new ProviderError("unknown", `OpenRouter ${model} returned invalid JSON.`, { httpStatus: response.status, sent: "unknown" });
  }
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  // The call RAN (200): an empty reply is not "refused before work". Cost stays what OpenRouter
  // reports, else unknown (REVIEW-E12 BL5); never booked as $0.
  if (!text)
    throw new ProviderError("unavailable", `OpenRouter ${model} returned an empty response.`, {
      httpStatus: response.status,
      sent: "unknown",
      costUsd: typeof data?.usage?.cost === "number" ? data.usage.cost : null,
    });
  return { text, model: data?.model ?? model, provider: "openrouter", ms: Date.now() - started, costUsd: typeof data?.usage?.cost === "number" ? data.usage.cost : undefined };
}

export const geminiLedgerDefault = (root: string = ROOT) => join(root, ".operator-data", "ai-usage-calls.json");

/** A failed direct attempt as a router ProviderError (no body text; quota bodies count as limits). */
function directFailure(attempt: Extract<DirectAttempt, { ok: false }>): ProviderError {
  // An empty or unreadable 200 RAN on Google's side: sent "unknown", cost unknown (REVIEW-E12 BL5).
  if (attempt.status === undefined) {
    const noAnswer = /empty response|invalid JSON/.test(attempt.error);
    return new ProviderError(noAnswer ? "unavailable" : "transport", "Gemini did not answer", { sent: "unknown" });
  }
  const error = /RESOURCE_EXHAUSTED/.test(attempt.error)
    ? new ProviderError("quota_exhausted", `HTTP ${attempt.status}: quota exhausted`, { httpStatus: attempt.status, sent: false })
    : httpProviderError(attempt.status, attempt.error);
  // The pre-E1 rule (isFallbackWorthy): only 404, 429, 5xx and quota bodies move on to the next model
  // (and, last, the paid OpenRouter leg). A 400 or 401/403 ends the call, as before (REVIEW-E12 BL4b).
  if (!attempt.fallback) error.opts.stop = true;
  return error;
}

/** The catalogue id the caller explicitly chose, or undefined for the task's own order. */
function selectedModel(options: GeminiGenerateOptions): string | undefined {
  const byOpenRouter = (id: string | undefined) => (id ? modelByProviderId("openrouter", id)?.id : undefined);
  const known = (label: string, id: string | undefined) => {
    if (!id) throw new Error(`${label} is not in the model catalogue (scripts/model-router/catalogue.json); add it there first.`);
    return id;
  };
  if (options.skipDirect) return options.openRouterModel ? known(options.openRouterModel, byOpenRouter(options.openRouterModel)) : undefined;
  if (options.tier === "pro") return options.openRouterModel ? known(options.openRouterModel, byOpenRouter(options.openRouterModel)) : "openrouter/gemini-3.1-pro-preview";
  if (options.model) return known(options.model, modelByProviderId("gemini", options.model)?.id);
  return undefined;
}

/**
 * Generates text (optionally over image/video parts) through the router: free Gemini first for
 * `flash`, the explicitly chosen paid Pro model for `pro` (falling back to free Gemini when it is
 * unavailable), consented OpenRouter only for `skipDirect`. Throws a clear error naming every model
 * and why it couldn't run. Never logs or throws a key, and never falls back from free to paid.
 */
export async function geminiGenerate(options: GeminiGenerateOptions): Promise<GeminiResult> {
  const root = options.root ?? ROOT;
  // Real runs (no injected `request`) get counted in the shared ledger; tests inject their own
  // fetch and skip this so they never touch .operator-data or globalThis.fetch. `flush()` in the
  // `finally` below matters for a short-lived CLI run (bun scripts/llm/watch-video.ts).
  // Install BEFORE resolving `fetch`: installCallCounter replaces globalThis.fetch.
  const counter = options.request ? null : installCallCounter(options.ledgerFile ?? geminiLedgerDefault(root));
  const request = options.request ?? fetch;
  const log = (line: string) => console.error(line);
  const key = (name: string) => providerKey(root, name, { home: options.home, env: options.env });
  try {
    const selected = selectedModel(options);
    const run = await runRouted<GeminiResult>({
      task: options.skipDirect ? "photo.index" : options.tier === "pro" ? "video.understand.pro" : "video.understand",
      caller: `scripts/llm/gemini (${options.skipDirect ? "photo-index" : `tier ${options.tier}`})`,
      sink: options.sink ?? routerReceiptSink(root),
      constraints: {
        selected,
        selectedBy: "owner",
        providers: options.skipDirect || options.tier === "pro" ? ["openrouter"] : ["gemini", "openrouter"],
        // Each call tries direct Gemini first, as before the router (REVIEW-E12 BL4b: a sit-out after one auth
        // failure would send every later flash call to paid OpenRouter).
        health: options.health ?? callHealth(root),
        hasKey: (name) => !!key(name),
      },
      invoke: async (choice: RouteChoice) => {
        if (choice.provider === "gemini") {
          const attempt = await callDirectWithRetry(choice.providerModel, options, key("GEMINI_API_KEY"), request, log);
          if (attempt.ok) return { value: attempt.result, providerModel: choice.providerModel };
          throw directFailure(attempt);
        }
        const result = await callOpenRouter(choice.providerModel, options, key("OPENROUTER_API_KEY"), request);
        return { value: result, providerModel: result.model, costUsd: result.costUsd ?? null };
      },
    });
    const result: GeminiResult = { ...run.value };
    if (run.receipt.fallbackFrom) result.fallbackFrom = run.receipt.fallbackFrom;
    return result;
  } catch (error) {
    if (error instanceof RouteError) throw new Error(error.message);
    if (error instanceof ProviderError) throw new Error(`Gemini request failed: ${error.message}. Not retried on another model (a request error or a cancel).`);
    throw error;
  } finally {
    counter?.flush();
  }
}

const YOUTUBE_URL = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=[\w-]+|youtu\.be\/[\w-]+)/;

/**
 * Watches a public YouTube video and answers a prompt about it, returning markdown.
 *
 * - Direct Gemini takes the URL as a `file_data.file_uri` part (Gemini's documented way to hand
 *   it a YouTube link without downloading anything).
 * - OpenRouter takes it as a `video_url` content part, pinned to the `google-ai-studio` provider:
 *   OpenRouter's other Gemini backend, Vertex AI, rejects YouTube links outright (checked 25 Sep
 *   2026 against openrouter.ai/docs/guides/overview/multimodal/videos).
 *
 * Only YouTube URLs are supported. For a video that isn't on YouTube (a local file, a private
 * upload, a non-YouTube host), neither path here works: Gemini's `file_data` needs either YouTube
 * or a file already uploaded through its Files API, and OpenRouter's `video_url` needs a direct
 * file URL (mp4/mpeg/mov/webm) or a base64 data URL, not an arbitrary webpage. The fallback for
 * that case is to download the video or audio locally with yt-dlp and feed the audio/frames in a
 * different way — this repo does not have yt-dlp installed (checked 25 Sep 2026), so that path is
 * documented only, not implemented, per instructions not to install new tooling silently.
 */
export async function watchVideo(
  url: string,
  prompt: string,
  options: Omit<GeminiGenerateOptions, "tier" | "parts"> & { tier?: GeminiTier } = {},
): Promise<GeminiResult> {
  if (!YOUTUBE_URL.test(url))
    throw new Error(
      "watchVideo only supports YouTube URLs (youtube.com/watch?v=... or youtu.be/...). " +
        "For other sources, download the video/audio locally with yt-dlp first — not automated here.",
    );
  return geminiGenerate({
    ...options,
    tier: options.tier ?? "flash",
    parts: [{ videoUrl: url }, { text: prompt }],
    openRouterProvider: options.openRouterProvider ?? "google-ai-studio",
    // 25 Sep 2026: flash was truncating mid-answer at the old 1024-token default — Gemini's
    // "thinking" tokens count against maxOutputTokens too, so a genuine answer about a whole video
    // routinely got cut off before any visible text came out. 8192 leaves real headroom for both.
    maxOutputTokens: options.maxOutputTokens ?? 8192,
  });
}
