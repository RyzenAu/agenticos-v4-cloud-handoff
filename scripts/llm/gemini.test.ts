import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryReceiptSink } from "../model-router/receipts";
import {
  DIRECT_MODELS,
  OPENROUTER_MODELS,
  geminiGenerate,
  isFallbackWorthy,
  watchVideo,
} from "./gemini";

const root = mkdtempSync(join(tmpdir(), "gemini-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(
  join(root, ".env.local"),
  "GEMINI_API_KEY=fixture-gemini-key\nOPENROUTER_API_KEY=fixture-or-key\n",
);
// Isolated home so tests never read the real ~/.config/agentic-os.env keys.
const home = mkdtempSync(join(tmpdir(), "gemini-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const GEMINI_KEY = "fixture-gemini-key";
const OPENROUTER_KEY = "fixture-or-key";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** A scripted fetch: each call consumes the next handler, in order. */
function scripted(handlers: Array<(url: string, init: RequestInit) => Response>): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = handlers[i++];
    if (!handler) throw new Error(`Unexpected extra fetch call: ${url}`);
    return handler(url, init ?? {});
  }) as typeof fetch;
}

const DIRECT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const ok = (text: string) => () =>
  jsonResponse(200, { candidates: [{ content: { parts: [{ text }] } }] });

test("tier mapping comes from the catalogue: flash starts on free gemini-3.8-flash, pro has no direct model", () => {
  expect(DIRECT_MODELS.flash).toBe("gemini-3.8-flash");
  expect(DIRECT_MODELS.pro).toBeNull();
  expect(OPENROUTER_MODELS.flash).toBe("google/gemini-2.5-flash-lite");
  expect(OPENROUTER_MODELS.pro).toBe("google/gemini-3.1-pro-preview");
});

test("isFallbackWorthy: 404, 429, 5xx and RESOURCE_EXHAUSTED move on; 4xx client errors don't", () => {
  expect(isFallbackWorthy(404, "")).toBe(true);
  expect(isFallbackWorthy(429, "")).toBe(true);
  expect(isFallbackWorthy(503, '{"error":{"status":"UNAVAILABLE"}}')).toBe(true);
  expect(isFallbackWorthy(500, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toBe(true);
  expect(isFallbackWorthy(400, '{"error":"bad request"}')).toBe(false);
  expect(isFallbackWorthy(403, '{"error":"permission denied"}')).toBe(false);
});

test("flash tier: direct Gemini succeeds, OpenRouter is never called, a free receipt is written", async () => {
  const sink = new MemoryReceiptSink();
  const request = scripted([
    (url, init) => {
      expect(url).toBe(DIRECT("gemini-3.8-flash"));
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(GEMINI_KEY);
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "direct answer" }] } }],
      });
    },
  ]);
  const result = await geminiGenerate({
    tier: "flash",
    parts: [{ text: "hi" }],
    root,
    home,
    env: {},
    request,
    sink,
  });
  expect(result).toEqual({
    text: "direct answer",
    model: "gemini-3.8-flash",
    provider: "gemini",
    ms: expect.any(Number),
  });
  expect(sink.receipts).toHaveLength(1);
  expect(sink.receipts[0]).toMatchObject({
    task: "video.understand",
    model: "gemini/3.8-flash",
    route: "free",
    costUsd: null,
    costBasis: "free_tier_unverified",
    outcome: "succeeded",
  });
});

test("flash tier: a 404 moves to the second Gemini model (a pre-existing fallback, kept)", async () => {
  const sink = new MemoryReceiptSink();
  const request = scripted([
    () => jsonResponse(404, { error: { message: "model not found" } }),
    (url) => {
      expect(url).toBe(DIRECT("gemini-flash-latest"));
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "second free answer" }] } }],
      });
    },
  ]);
  const result = await geminiGenerate({
    tier: "flash",
    parts: [{ text: "hi" }],
    root,
    home,
    env: {},
    request,
    sink,
  });
  expect(result).toMatchObject({
    provider: "gemini",
    model: "gemini-flash-latest",
    text: "second free answer",
    fallbackFrom: "gemini/3.8-flash",
  });
  expect(
    sink.receipts.map((r) => [r.model, r.outcome, r.fallbackFrom, r.costUsd, r.costBasis]),
  ).toEqual([
    ["gemini/3.8-flash", "failed", null, 0, "refused_before_work"],
    ["gemini/flash-latest", "succeeded", "gemini/3.8-flash", null, "free_tier_unverified"],
  ]);
  expect(sink.receipts[1].reason).toContain("billing unverified, pre-existing");
});

test("flash tier: when both Gemini models are out it falls back to paid OpenRouter flash-lite (as before E1), with a paid receipt", async () => {
  const sink = new MemoryReceiptSink();
  const urls: string[] = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("google/gemini-2.5-flash-lite");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${OPENROUTER_KEY}`,
      );
      return jsonResponse(200, {
        model: "google/gemini-2.5-flash-lite",
        choices: [{ message: { content: "openrouter answer" } }],
        usage: { cost: 0.00021 },
      });
    }
    return jsonResponse(429, {
      error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" },
    });
  }) as typeof fetch;
  const result = await geminiGenerate({
    tier: "flash",
    parts: [{ text: "hi" }],
    root,
    home,
    env: {},
    request,
    retryDelaysMs: [],
    sink,
  });
  expect(result).toMatchObject({
    provider: "openrouter",
    text: "openrouter answer",
    fallbackFrom: "gemini/3.8-flash",
  });
  expect(urls).toEqual([
    DIRECT("gemini-3.8-flash"),
    DIRECT("gemini-flash-latest"),
    "https://openrouter.ai/api/v1/chat/completions",
  ]);
  expect(sink.receipts.at(-1)).toMatchObject({
    model: "openrouter/gemini-2.5-flash-lite",
    route: "metered",
    outcome: "succeeded",
    fallbackFrom: "gemini/3.8-flash",
    costUsd: 0.00021,
    costBasis: "provider_reported",
  });
});

test("flash tier: when Gemini and OpenRouter are all out it fails clearly", async () => {
  const request = (async (input: RequestInfo | URL) =>
    String(input).includes("openrouter.ai")
      ? jsonResponse(402, { error: { message: "Insufficient credits" } })
      : jsonResponse(429, {
          error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" },
        })) as typeof fetch;
  await expect(
    geminiGenerate({
      tier: "flash",
      parts: [{ text: "hi" }],
      root,
      home,
      env: {},
      request,
      retryDelaysMs: [],
    }),
  ).rejects.toThrow(/video\.understand: no eligible model.*Fail visibly/);
});

test("flash tier: a 429 retries the same free model with backoff", async () => {
  const request = scripted([
    () => jsonResponse(429, { error: { message: "rate limited" } }),
    ok("ok after one retry"),
  ]);
  const sleeps: number[] = [];
  const result = await geminiGenerate({
    tier: "flash",
    parts: [{ text: "hi" }],
    root,
    home,
    env: {},
    request,
    retryDelaysMs: [1],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect(result).toMatchObject({ text: "ok after one retry", model: "gemini-3.8-flash" });
  expect(sleeps).toEqual([1]);
});

test("flash tier: 503 'high demand' retries with the documented 10s/20s/40s backoff", async () => {
  const busy = () =>
    jsonResponse(503, { error: { status: "UNAVAILABLE", message: "The model is overloaded" } });
  const request = scripted([busy, busy, busy, ok("free after retries")]);
  const sleeps: number[] = [];
  const result = await geminiGenerate({
    tier: "flash",
    parts: [{ text: "hi" }],
    root,
    home,
    env: {},
    request,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect(sleeps).toEqual([10_000, 20_000, 40_000]);
  expect(result).toMatchObject({ provider: "gemini", text: "free after retries" });
});

test("a 404 (model retired) is not retried the 'high demand' way", async () => {
  const request = scripted([() => jsonResponse(404, { error: { message: "model not found" } })]);
  const sleeps: number[] = [];
  await expect(
    geminiGenerate({
      tier: "flash",
      parts: [{ text: "hi" }],
      root,
      home,
      env: {},
      request,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
  ).rejects.toThrow();
  expect(sleeps).toEqual([]);
});

test("flash tier: a RESOURCE_EXHAUSTED quota body counts as a limit and moves to the second Gemini model", async () => {
  const request = scripted([
    () => jsonResponse(400, { error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }),
    ok("ok after quota"),
  ]);
  const sink = new MemoryReceiptSink();
  expect(
    (
      await geminiGenerate({
        tier: "flash",
        parts: [{ text: "hi" }],
        root,
        home,
        env: {},
        request,
        sink,
      })
    ).text,
  ).toBe("ok after quota");
  expect(sink.receipts[0]).toMatchObject({
    outcome: "rate_limited",
    errorCode: "quota_exhausted",
    costUsd: 0,
    costBasis: "refused_before_work",
  });
});

test("flash tier: a real client error (400) throws without trying anything else", async () => {
  const request = scripted([() => jsonResponse(400, { error: { message: "invalid request" } })]);
  await expect(
    geminiGenerate({ tier: "flash", parts: [{ text: "hi" }], root, home, env: {}, request }),
  ).rejects.toThrow(/400/);
});

test("pro tier: the owner's paid choice goes to OpenRouter and is receipted as metered", async () => {
  const sink = new MemoryReceiptSink();
  const request = scripted([
    (url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(JSON.parse(String(init.body)).model).toBe("google/gemini-3.1-pro-preview");
      return jsonResponse(200, {
        model: "google/gemini-3.1-pro-preview",
        choices: [{ message: { content: "pro answer" } }],
        usage: { cost: 0.002 },
      });
    },
  ]);
  const result = await geminiGenerate({
    tier: "pro",
    parts: [{ text: "hi" }],
    root,
    home,
    env: {},
    request,
    sink,
  });
  expect(result).toMatchObject({ provider: "openrouter", model: "google/gemini-3.1-pro-preview" });
  expect(sink.receipts[0]).toMatchObject({
    route: "metered",
    selectedBy: "owner",
    costUsd: 0.002,
    costBasis: "provider_reported",
  });
});

test("pro tier: out of credit fails clearly with no fallback, exactly as before E1", async () => {
  const sink = new MemoryReceiptSink();
  const request = scripted([
    () => jsonResponse(402, { error: { message: "Insufficient credits" } }),
  ]);
  await expect(
    geminiGenerate({ tier: "pro", parts: [{ text: "hi" }], root, home, env: {}, request, sink }),
  ).rejects.toThrow(/video\.understand\.pro: no eligible model.*the pro tier has no fallback/);
  expect(sink.receipts.map((r) => [r.model, r.outcome, r.errorCode, r.fallbackFrom])).toEqual([
    ["openrouter/gemini-3.1-pro-preview", "rate_limited", "insufficient_funds", null],
    ["openrouter/gemini-3.1-pro-preview", "exhausted_free", "no_eligible_model", null],
  ]);
});

test("skipDirect (photo index) goes to consented OpenRouter only, forwards provider routing and reports OpenRouter's cost", async () => {
  const request = scripted([
    (url, init) => {
      const body = JSON.parse(String(init.body));
      // The caller's own routing options pass through unchanged; the router adds none.
      expect(body.provider).toEqual({
        data_collection: "deny",
        require_parameters: true,
        max_price: { prompt: 100, completion: 400 },
      });
      expect(body.usage).toEqual({ include: true });
      return jsonResponse(200, {
        choices: [{ message: { content: "described" } }],
        usage: { cost: 0.00013 },
      });
    },
  ]);
  const result = await geminiGenerate({
    tier: "flash",
    skipDirect: true,
    openRouterModel: OPENROUTER_MODELS.flash,
    parts: [{ text: "describe this" }],
    openRouterProviderOptions: {
      data_collection: "deny",
      require_parameters: true,
      max_price: { prompt: 100, completion: 400 },
    },
    root,
    home,
    env: {},
    request,
  });
  expect(result.text).toBe("described");
  expect(result.costUsd).toBeCloseTo(0.00013, 8);
});

test("skipDirect (photo index) has no automatic fallback", async () => {
  const request = scripted([() => jsonResponse(429, { error: { message: "rate limited" } })]);
  await expect(
    geminiGenerate({
      tier: "flash",
      skipDirect: true,
      parts: [{ text: "x" }],
      root,
      home,
      env: {},
      request,
    }),
  ).rejects.toThrow(/photo\.index: no eligible model.*Skip the photo/);
});

test("an id outside the catalogue is refused before any call", async () => {
  await expect(
    geminiGenerate({
      tier: "flash",
      model: "gemini-9-imaginary",
      parts: [{ text: "x" }],
      root,
      home,
      env: {},
      request: scripted([]),
    }),
  ).rejects.toThrow(/not in the model catalogue/);
});

test("throws a clear error naming both keys when neither Gemini nor OpenRouter is configured", async () => {
  const bareRoot = mkdtempSync(join(tmpdir(), "gemini-bare-"));
  const bareHome = mkdtempSync(join(tmpdir(), "gemini-bare-home-"));
  try {
    await expect(
      geminiGenerate({
        tier: "flash",
        parts: [{ text: "hi" }],
        root: bareRoot,
        home: bareHome,
        env: {},
        request: scripted([]),
      }),
    ).rejects.toThrow(/GEMINI_API_KEY missing.*OPENROUTER_API_KEY missing/);
  } finally {
    rmSync(bareRoot, { recursive: true, force: true });
    rmSync(bareHome, { recursive: true, force: true });
  }
});

test("never logs or throws the actual key value", async () => {
  const request = scripted([
    () => jsonResponse(400, { error: { message: "invalid request, key rejected" } }),
  ]);
  let caught: unknown;
  try {
    await geminiGenerate({ tier: "flash", parts: [{ text: "hi" }], root, home, env: {}, request });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = String((caught as Error).message);
  expect(message).not.toContain(GEMINI_KEY);
  expect(message).not.toContain(OPENROUTER_KEY);
  expect(message).toMatch(/Not retried on another model/);
});

test("watchVideo rejects a non-YouTube URL before making any network call", async () => {
  await expect(
    watchVideo("https://vimeo.com/12345", "What happens?", {
      root,
      home,
      env: {},
      request: scripted([]),
    }),
  ).rejects.toThrow(/YouTube/);
});

test("watchVideo sends file_data to free Gemini, and video_url pinned to AI Studio on the explicit pro tier", async () => {
  const directRequest = scripted([
    (url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.contents[0].parts[0]).toEqual({
        file_data: { file_uri: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
      });
      expect(body.contents[0].parts[1]).toEqual({ text: "What happens?" });
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: "a zoo" }] } }] });
    },
  ]);
  const direct = await watchVideo("https://www.youtube.com/watch?v=jNQXAC9IVRw", "What happens?", {
    root,
    home,
    env: {},
    request: directRequest,
  });
  expect(direct.text).toBe("a zoo");

  const proRequest = scripted([
    (url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.provider).toEqual({ only: ["google-ai-studio"] });
      const content = body.messages[0].content;
      expect(content.find((c: any) => c.type === "video_url").video_url.url).toBe(
        "https://youtu.be/jNQXAC9IVRw",
      );
      return jsonResponse(200, { choices: [{ message: { content: "a zoo, via openrouter" } }] });
    },
  ]);
  const pro = await watchVideo("https://youtu.be/jNQXAC9IVRw", "What happens?", {
    tier: "pro",
    root,
    home,
    env: {},
    request: proRequest,
  });
  expect(pro.text).toBe("a zoo, via openrouter");
  expect(pro.provider).toBe("openrouter");
});
