// Stage E2 routing rules, after the owner's 28 Sep correction ("its all my data"):
// - data use (retention, training) is not a routing constraint;
// - paid -> free automatic fallback stays, and a task's declared last resorts (a subscription, or a
//   paid model the owner approved) run only after every candidate, receipted with their real route.
import { describe, expect, test } from "bun:test";
import { catalogueModel, validateCatalogue } from "./catalogue";
import raw from "./catalogue.json";
import { openAiCompatibleChat } from "./clients";
import { MemoryHealthStore } from "./health";
import { MemoryReceiptSink } from "./receipts";
import { ProviderError, route, RouteError, runRouted, type RouteConstraints } from "./router";

const NOW = Date.parse("2026-09-28T02:00:00Z");
const base = (extra: RouteConstraints = {}): RouteConstraints => ({ hasKey: () => true, now: NOW, ...extra });
const limited = (...ids: string[]) =>
  new MemoryHealthStore({ models: Object.fromEntries(ids.map((id) => [id, { state: "limited", until: new Date(NOW + 60_000).toISOString(), lastProbe: null, lastFailure: null, detail: "HTTP 429" }])) });

describe("data use is not a routing constraint", () => {
  test("models that may train are eligible for any data class", () => {
    for (const dataClass of ["private", "business-internal", "public"] as const) {
      const c = route("vision.screen", base({ dataClass, health: limited("codex/gpt-6-sol", "groq/qwen3.8-27b") }));
      expect(c).toMatchObject({ model: "gemini/3.8-flash", route: "free", fallbackFrom: "codex/gpt-6-sol" });
      expect(catalogueModel(c.model).dataUse).toBe("may-train");
    }
  });
  test("OpenRouter calls carry no imposed data policy", async () => {
    let sent: any = null;
    const request = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "deepseek/deepseek-v4.1-flash" }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await openAiCompatibleChat(route("inbox.question", base()), { env: { OPENROUTER_API_KEY: "sk-or-test" }, home: "Z:/no-home", root: "Z:/no-root", request, messages: [{ role: "user", content: "x" }] }, new AbortController().signal);
    expect(out.httpStatus).toBe(200);
    expect(sent.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(sent.provider).toBeUndefined();
  });
});

describe("inbox questions", () => {
  test("default is the original DeepSeek v4.1 Flash on OpenRouter", () => {
    expect(route("inbox.question", base())).toMatchObject({ model: "openrouter/deepseek-v4.1-flash", provider: "openrouter", route: "metered", fallbackFrom: null, lastResort: false });
  });
  test("then free Groq; no Codex leg (third-party email never reaches Hermes' tool-using agent; REVIEW-E12 M3)", () => {
    expect(route("inbox.question", base({ health: limited("openrouter/deepseek-v4.1-flash") }))).toMatchObject({ model: "groq/gpt-oss-120b", route: "free", fallbackFrom: "openrouter/deepseek-v4.1-flash" });
    expect(() => route("inbox.question", base({ health: limited("openrouter/deepseek-v4.1-flash", "groq/gpt-oss-120b", "groq/gpt-oss-20b") }))).toThrow(RouteError);
  });
  test("an on-device model the owner chose stays on-device", () => {
    expect(route("inbox.question", base({ selected: "local/on-device", providers: ["local"] }))).toMatchObject({ model: "local/on-device", route: "free" });
    expect(() => route("inbox.question", base({ selected: "local/on-device", providers: ["local"], health: limited("local/on-device") }))).toThrow();
  });
});

describe("last resorts", () => {
  test("vision.point keeps its pre-router order: Claude, GPT-6 via Hermes, free Gemini, then (new) free Groq", () => {
    expect(route("vision.point", base()).model).toBe("claude/sonnet-5");
    expect(route("vision.point", base({ health: limited("claude/sonnet-5") }))).toMatchObject({ model: "codex/gpt-6-sol", route: "subscription", fallbackFrom: "claude/sonnet-5" });
    expect(route("vision.point", base({ health: limited("claude/sonnet-5", "codex/gpt-6-sol") })).model).toBe("gemini/3.8-flash");
    const last = route("vision.point", base({ health: limited("claude/sonnet-5", "codex/gpt-6-sol", "gemini/3.8-flash", "gemini/3.7-flash", "gemini/flash-latest", "gemini/3.6-flash") }));
    expect(last).toMatchObject({ model: "groq/qwen3.8-27b", route: "free" });
  });
  test("paid candidates are automatic fallbacks in chain order (owner, 28 Sep; E1)", () => {
    const c = route("summary.private", base({ health: limited("claude/haiku-4-5") }));
    expect(c).toMatchObject({ model: "claude/sonnet-5", route: "subscription", fallbackFrom: "claude/haiku-4-5" });
  });
  test("a last resort may be an owner-approved paid model, never a free one", () => {
    const paid = JSON.parse(JSON.stringify(raw));
    paid.tasks["inbox.question"].lastResort = ["codex/gpt-6-sol", "openrouter/mimo-v2.6-flash"];
    expect(validateCatalogue(paid)).toEqual([]);
    const free = JSON.parse(JSON.stringify(raw));
    free.tasks["inbox.question"].lastResort = ["gemini/3.8-flash"];
    expect(validateCatalogue(free).join()).toMatch(/is free; list it in candidates/);
  });
  test("a last-resort attempt is receipted with its real route, never as free", async () => {
    const sink = new MemoryReceiptSink();
    const run = await runRouted({
      task: "voice.tts",
      caller: "last-resort.test",
      sink,
      constraints: base({ health: new MemoryHealthStore() }),
      invoke: async (choice) => {
        if (choice.provider !== "elevenlabs") throw new ProviderError("rate_limited", "limited", { sent: false, httpStatus: 429 });
        return { value: "audio", providerModel: "eleven_flash_v2_5" };
      },
    });
    expect(run.value).toBe("audio");
    expect(sink.receipts.at(-1)).toMatchObject({ model: "elevenlabs/flash-v2-5", route: "metered", fallbackFrom: "groq/orpheus-v1-english", outcome: "succeeded" });
    expect(sink.receipts.map((r) => r.model)).toEqual(["groq/orpheus-v1-english", "gemini/3.1-flash-tts-preview", "elevenlabs/flash-v2-5"]);
  });
});
