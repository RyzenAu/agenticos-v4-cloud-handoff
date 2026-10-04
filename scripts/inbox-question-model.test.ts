// Inbox questions go through the router (inbox.question): the original DeepSeek default, free
// fallbacks (Groq); every attempt leaves a receipt. No real model is called.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInboxQuestionAnswer, inboxQuestionModelAvailable, inboxSelection } from "./inbox-question-model";
import { testReceipts } from "./model-router/defaults";

const root = mkdtempSync(join(tmpdir(), "inbox-q-root-"));
const home = mkdtempSync(join(tmpdir(), "inbox-q-home-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const env = { OPENROUTER_API_KEY: "sk-or-fixture", GROQ_API_KEY: "gsk-fixture" } as NodeJS.ProcessEnv;
const ANSWER = JSON.stringify({ answer: "Sam replied on Tuesday.", references: ["m1"] });
const PRIVATE_EMAIL = "Excerpt: From sam@example.com — 'the quote is fine, invoice us'";

type Call = { url: string; body: any; auth: string };
function fake(reply: (url: string, body: any) => Response) {
  const calls: Call[] = [];
  const request = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: String((init.headers as Record<string, string>)?.Authorization ?? "") });
    return reply(url, body);
  }) as unknown as typeof fetch;
  return { calls, request };
}
const ok = (content: string, model: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], model, usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
const ours = () => testReceipts.receipts.filter((r) => r.caller.startsWith("scripts/inbox-question-model"));

beforeEach(() => {
  testReceipts.receipts.length = 0;
});

describe("inbox questions through the router", () => {
  test("default: the original DeepSeek v4.1 Flash on OpenRouter, receipted", async () => {
    const { calls, request } = fake((url) => ok(ANSWER, "deepseek/deepseek-v4.1-flash"));
    const text = await generateInboxQuestionAnswer(root, "", PRIVATE_EMAIL, undefined, new AbortController().signal, { request, env, home });
    expect(text).toBe(ANSWER);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(calls[0].body.provider).toBeUndefined(); // no data policy imposed (owner, 28 Sep)
    const [r] = ours();
    expect(r).toMatchObject({ task: "inbox.question", model: "openrouter/deepseek-v4.1-flash", route: "metered", outcome: "succeeded", selectedBy: "rule", fallbackFrom: null });
    // The receipt holds metadata only: never the email, the answer or the key.
    expect(JSON.stringify(r)).not.toContain("sam@example.com");
    expect(JSON.stringify(r)).not.toContain("sk-or-fixture");
  });

  test("OpenRouter unavailable (404) -> free Groq, with fallbackFrom", async () => {
    const { calls, request } = fake((url) =>
      url.includes("openrouter") ? new Response(JSON.stringify({ error: { message: "No endpoints found matching your data policy" } }), { status: 404 }) : ok(ANSWER, "openai/gpt-oss-120b"),
    );
    const text = await generateInboxQuestionAnswer(root, "", PRIVATE_EMAIL, undefined, new AbortController().signal, { request, env, home });
    expect(text).toBe(ANSWER);
    expect(calls.map((c) => c.url)).toEqual(["https://openrouter.ai/api/v1/chat/completions", "https://api.groq.com/openai/v1/chat/completions"]);
    expect(calls[1].body.model).toBe("openai/gpt-oss-120b");
    expect(ours().map((r) => [r.model, r.outcome, r.httpStatus, r.fallbackFrom, r.route])).toEqual([
      ["openrouter/deepseek-v4.1-flash", "failed", 404, null, "metered"],
      ["groq/gpt-oss-120b", "succeeded", 200, "openrouter/deepseek-v4.1-flash", "free"],
    ]);
  });

  test("OpenRouter and Groq out: no Hermes/Codex leg (email text never reaches a tool-using agent)", async () => {
    const { calls, request } = fake((url) => (url.includes("openrouter") ? new Response("{}", { status: 402 }) : new Response(JSON.stringify({ error: { message: "Rate limit reached, try again in 20s" } }), { status: 429 })));
    await expect(generateInboxQuestionAnswer(root, "", PRIVATE_EMAIL, undefined, new AbortController().signal, { request, env, home, hermesKey: () => "hermes-fixture" })).rejects.toThrow(/matching conversations/);
    expect(calls.some((c) => c.url.includes("8642"))).toBe(false);
    expect(ours().some((r) => r.provider === "codex")).toBe(false);
  });

  test("the default route sends reasoning off, as the pre-router harness did", async () => {
    const { calls, request } = fake(() => ok(ANSWER, "deepseek/deepseek-v4.1-flash"));
    await generateInboxQuestionAnswer(root, "", PRIVATE_EMAIL, undefined, new AbortController().signal, { request, env, home });
    expect(calls[0].body.reasoning).toEqual({ effort: "none" });
  });

  test("every route exhausted: a clear failure and receipts for each attempt", async () => {
    const { calls, request } = fake(() => new Response("{}", { status: 503 }));
    await expect(generateInboxQuestionAnswer(root, "", PRIVATE_EMAIL, undefined, new AbortController().signal, { request, env, home })).rejects.toThrow(/matching conversations/);
    expect(calls.every((c) => /openrouter|groq/.test(c.url))).toBe(true);
    expect(ours().at(-1)!.outcome).toBe("exhausted_free");
  });

  test("the owner's choice maps to the catalogue; any other deepseek/* pick is still allowed (as before)", () => {
    expect(inboxSelection(undefined)).toEqual({});
    expect(inboxSelection({ backend: "deepseek", provider: "openrouter", name: "deepseek/deepseek-v4.1-flash" })).toEqual({});
    expect(inboxSelection({ backend: "deepseek", provider: "openrouter", name: "deepseek/deepseek-v4-pro" })).toEqual({ selected: "openrouter/deepseek-v4-pro", selectedBy: "owner" });
    expect(inboxSelection({ backend: "deepseek", provider: "openrouter", name: "deepseek/deepseek-chat" })).toEqual({ selected: "openrouter/deepseek-owner-choice", selectedBy: "owner" });
    expect(inboxSelection({ backend: "local", provider: "ollama", name: "qwen3:8b" })).toEqual({ selected: "local/on-device", selectedBy: "owner", providers: ["local"] });
  });

  test("availability is by key NAME: none configured -> unavailable", () => {
    const bare = mkdtempSync(join(tmpdir(), "inbox-q-bare-"));
    try {
      expect(inboxQuestionModelAvailable(bare, "", undefined, { env: {}, home: bare })).toBe(false);
      expect(inboxQuestionModelAvailable(bare, "", undefined, { env: { GROQ_API_KEY: "gsk-fixture" }, home: bare })).toBe(true);
      expect(inboxQuestionModelAvailable(bare, "", undefined, { env: { OPENROUTER_API_KEY: "sk-or-fixture" }, home: bare })).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("an owner-picked deepseek/* model outside the catalogue runs as picked, receipted with the model OpenRouter reports", async () => {
    const { calls, request } = fake(() => ok(ANSWER, "deepseek/deepseek-chat-v3"));
    const text = await generateInboxQuestionAnswer(root, "", PRIVATE_EMAIL, { backend: "deepseek", provider: "openrouter", name: "deepseek/deepseek-chat" }, new AbortController().signal, { request, env, home });
    expect(text).toBe(ANSWER);
    expect(calls[0].body).toMatchObject({ model: "deepseek/deepseek-chat", max_tokens: 4096 });
    expect(ours().at(-1)).toMatchObject({ model: "openrouter/deepseek-owner-choice", providerModel: "deepseek/deepseek-chat-v3", selectedBy: "owner", route: "metered", outcome: "succeeded" });
  });
});
