// Screen questions and pointing go through the router (vision.screen / vision.point) with receipts;
// Gemini Flash (free) is a fallback again (owner, 28 Sep: data use is not a constraint).
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPointEyes } from "./claude-vision";
import { MemoryReceiptSink } from "./model-router/receipts";
import { askVision, describeScreen } from "./vision";

const root = mkdtempSync(join(tmpdir(), "vision-route-"));
const env = { GROQ_API_KEY: "gsk-fixture", GEMINI_API_KEY: "gem-fixture", OPENROUTER_API_KEY: "sk-or-fixture" } as NodeJS.ProcessEnv;
const home = root;
const FRAME = { image: "QUJD", mime: "image/jpeg" };
const refused = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8642"), { code: "ECONNREFUSED" }));

type Call = { url: string; body: any };
function fake(reply: (url: string, body: any) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const request = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    return reply(url, body);
  }) as unknown as typeof fetch;
  return { calls, request };
}
const ok = (content: string, model: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], model }), { status: 200 });
const noOpenRouter = (calls: Call[]) => expect(calls.some((c) => c.url.includes("openrouter"))).toBe(false);
const gemini = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

let sink: MemoryReceiptSink;
beforeEach(() => {
  sink = new MemoryReceiptSink();
});

describe("screen questions (vision.screen)", () => {
  test("GPT-6 via Hermes (the gateway's own model, as before), with a subscription receipt naming the reported model", async () => {
    const { calls, request } = fake((url) => (url.endsWith("/v1/chat/completions") ? ok("Your dashboard shows A$1,200.", "gpt-6-sol") : new Response("", { status: 204 })));
    const out = await describeScreen(root, { ...FRAME, question: "what's the total?" }, request, { sink, env, home, hermesKey: () => "hermes-fixture" });
    expect(out.answer).toBe("Your dashboard shows A$1,200.");
    expect(out.model).toBe("gpt-6-sol (Hermes, ChatGPT subscription)");
    expect(calls[0].body).toMatchObject({ model: "hermes-agent" });
    expect(sink.receipts[0].providerModel).toBe("gpt-6-sol");
    expect(calls[0].body.messages[0].content[1].image_url.url).toBe("data:image/jpeg;base64,QUJD");
    expect(sink.receipts.map((r) => [r.task, r.model, r.route, r.outcome])).toEqual([["vision.screen", "codex/gpt-6-sol", "subscription", "succeeded"]]);
    noOpenRouter(calls);
  });

  test("Hermes down -> free Groq; Groq limited too -> free Gemini Flash; never paid OpenRouter", async () => {
    const first = fake((url) => (url.includes("8642") ? refused() : ok("A Save button, top right.", "qwen/qwen3.8-27b")));
    const out = await describeScreen(root, { ...FRAME, question: "where's save?" }, first.request, { sink, env, home, hermesKey: () => "hermes-fixture" });
    expect(out.answer).toBe("A Save button, top right.");
    expect(first.calls.find((c) => c.url.includes("groq"))!.body.model).toBe("qwen/qwen3.8-27b");
    expect(sink.receipts.map((r) => [r.model, r.outcome, r.fallbackFrom])).toEqual([
      ["codex/gpt-6-sol", "failed", null],
      ["groq/qwen3.8-27b", "succeeded", "codex/gpt-6-sol"],
    ]);
    noOpenRouter(first.calls);

    const second = fake((url) =>
      url.includes("8642") ? refused() : url.includes("groq") ? new Response(JSON.stringify({ error: { message: "try again in 30s" } }), { status: 429 }) : gemini("The Save button, top right."),
    );
    const secondSink = new MemoryReceiptSink();
    const out2 = await describeScreen(root, { ...FRAME, question: "x" }, second.request, { sink: secondSink, env, home, hermesKey: () => "hermes-fixture" });
    expect(out2).toMatchObject({ answer: "The Save button, top right.", model: "gemini-3.8-flash" });
    expect(second.calls.find((c) => c.url.includes("generativelanguage"))!.url).toContain("/gemini-3.8-flash:generateContent");
    expect(secondSink.receipts.at(-1)).toMatchObject({ model: "gemini/3.8-flash", route: "free", outcome: "succeeded", fallbackFrom: "codex/gpt-6-sol" });
    noOpenRouter(second.calls);

    const third = fake((url) => (url.includes("8642") ? refused() : new Response(JSON.stringify({ error: { message: "try again in 30s" } }), { status: 429 })));
    await expect(describeScreen(root, { ...FRAME, question: "x" }, third.request, { sink: new MemoryReceiptSink(), env, home, hermesKey: () => "hermes-fixture" })).rejects.toThrow(/couldn't read the screen/);
    expect(await askVision(root, FRAME, "which box?", { request: third.request, env, home, hermesKey: () => "hermes-fixture" })).toBeNull();
    noOpenRouter(third.calls);
  });
});

describe("pointing (vision.point)", () => {
  test("the warm Claude session answers first, receipted as the Claude subscription", async () => {
    const { calls, request } = fake(() => ok("never", "x"));
    const look = createPointEyes(root, { look: async () => '{"x":1,"y":2}' }, { request, sink, env, home, hermesKey: () => "h" });
    expect(await look("QUJD", "where?", new AbortController().signal)).toEqual({ text: '{"x":1,"y":2}', model: "claude-sonnet-5 (subscription)" });
    expect(calls).toHaveLength(0);
    expect(sink.receipts[0]).toMatchObject({ task: "vision.point", model: "claude/sonnet-5", route: "subscription", providerModel: "claude-sonnet-5", outcome: "succeeded" });
  });

  test("pre-router order: Claude can't answer -> GPT-6 via Hermes; Hermes down -> free Gemini (then Groq)", async () => {
    const { calls, request } = fake((url) => {
      if (url.includes("generativelanguage")) return new Response(JSON.stringify({ error: { message: "Rate limit reached, try again in 9s" } }), { status: 429 });
      if (url.includes("groq")) return ok('{"x":7,"y":8}', "qwen/qwen3.8-27b");
      if (url.endsWith("/v1/chat/completions")) return ok('{"x":5,"y":6}', "gpt-6-sol");
      return new Response("", { status: 204 });
    });
    const look = createPointEyes(root, { look: async () => null }, { request, sink, env, home, hermesKey: () => "h" });
    const out = await look("QUJD", "where?", new AbortController().signal);
    expect(out).toEqual({ text: '{"x":5,"y":6}', model: "gpt-6-sol (Hermes, subscription)" });
    expect(sink.receipts.map((r) => [r.model, r.outcome, r.route])).toEqual([
      ["claude/sonnet-5", "failed", "subscription"],
      ["codex/gpt-6-sol", "succeeded", "subscription"],
    ]);
    expect(sink.receipts.at(-1)!.fallbackFrom).toBe("claude/sonnet-5");

    const down = fake((url) => {
      if (url.includes("8642")) return refused();
      if (url.includes("generativelanguage")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"x":1,"y":1}' }] } }] }), { status: 200 });
      return ok("never", "x");
    });
    const sink2 = new MemoryReceiptSink();
    const look2 = createPointEyes(root, { look: async () => null }, { request: down.request, sink: sink2, env, home, hermesKey: () => "h" });
    expect(await look2("QUJD", "where?", new AbortController().signal)).toEqual({ text: '{"x":1,"y":1}', model: "gemini-3.8-flash" });
    expect(sink2.receipts.map((r) => r.model)).toEqual(["claude/sonnet-5", "codex/gpt-6-sol", "gemini/3.8-flash"]);
    noOpenRouter([...calls, ...down.calls]);
  });
});
