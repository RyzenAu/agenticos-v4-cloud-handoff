// Meeting notes (and CAD code, through the same routedLlm) go through the model router with their
// pre-E2 order kept: Claude Sonnet, then Hermes (the Codex pool, the old fallback), with free Groq
// added after. One receipt per attempt, each with its real route.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { routedLlm, subscriptionLlm } from "./llm";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "meeting-llm-"));
  dirs.push(d);
  return d;
};
const NOTES = '{"summary":"ok"}';
const chat = (content: string, model: string) => new Response(JSON.stringify({ model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });

function harness(options: { claude: (body: any) => Promise<any>; groq?: (body: any) => Response; hermes?: (body: any) => Response; groqKey?: boolean }) {
  const dir = tmp();
  const sink = new MemoryReceiptSink();
  const hits: string[] = [];
  const request = (async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init.body));
    if (url.includes("api.groq.com")) {
      hits.push(`groq:${body.model}`);
      return options.groq ? options.groq(body) : new Response("{}", { status: 503 });
    }
    if (url.includes("127.0.0.1:8642")) {
      hits.push(`hermes:${body.model}`);
      return options.hermes ? options.hermes(body) : new Response("{}", { status: 503 });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  const deps = {
    env: options.groqKey === false ? {} : { GROQ_API_KEY: "gsk_test" },
    home: dir,
    request,
    hermesKey: () => "hermes-test",
    claude: async (body: any) => {
      hits.push(`claude:${body.model}`);
      return options.claude(body);
    },
  };
  return { dir, sink, hits, deps, health: new MemoryHealthStore() };
}
const llmFor = (h: ReturnType<typeof harness>) => subscriptionLlm({ deps: h.deps, sink: h.sink, health: h.health, root: h.dir });

describe("meeting notes: meeting.notes through the router, pre-E2 order kept", () => {
  test("Claude Sonnet first; its receipt names the model that ran", async () => {
    const h = harness({ claude: async () => ({ choices: [{ message: { content: NOTES } }] }) });
    const out = await llmFor(h)("system", "transcript");
    expect(out).toEqual({ text: NOTES, model: "claude-sonnet-5 (Claude subscription)" });
    expect(h.hits).toEqual(["claude:claude-sonnet-5"]);
    expect(h.sink.receipts).toHaveLength(1);
    expect(h.sink.receipts[0]).toMatchObject({
      task: "meeting.notes", caller: "scripts/meeting-mode/llm (meeting notes)", provider: "claude-sub", model: "claude/sonnet-5",
      providerModel: "claude-sonnet-5", route: "subscription", outcome: "succeeded",
    });
  });

  test("Claude out -> Hermes (the old fallback) next, receipted as a subscription, on the gateway's own model", async () => {
    const h = harness({ claude: async () => { throw new Error("Claude usage limit reached"); }, hermes: (b) => chat(NOTES, "gpt-6-sol") });
    const out = await llmFor(h)("s", "p");
    expect(h.hits).toEqual(["claude:claude-sonnet-5", "hermes:hermes-agent"]);
    expect(out.model).toBe("gpt-6-sol (Hermes, ChatGPT subscription)");
    expect(h.sink.receipts.map((r) => [r.model, r.route, r.outcome])).toEqual([
      ["claude/sonnet-5", "subscription", "rate_limited"],
      ["codex/gpt-6-sol", "subscription", "succeeded"],
    ]);
    expect(h.sink.receipts[1]).toMatchObject({ fallbackFrom: "claude/sonnet-5", providerModel: "gpt-6-sol" });
  });

  test("Claude and Hermes out -> free Groq is added after them", async () => {
    const h = harness({ claude: async () => { throw new Error("Claude usage limit reached"); }, groq: (b) => chat(NOTES, b.model) });
    const out = await llmFor(h)("s", "p");
    expect(h.hits).toEqual(["claude:claude-sonnet-5", "hermes:hermes-agent", "groq:openai/gpt-oss-120b"]);
    expect(out.model).toBe("openai/gpt-oss-120b (groq free)");
    expect(h.sink.receipts.at(-1)).toMatchObject({ model: "groq/gpt-oss-120b", route: "free", costUsd: 0 });
  });

  test("a reply with no JSON moves on to Hermes, as a new linked request", async () => {
    const h = harness({ claude: async () => ({ choices: [{ message: { content: "Sorry, I can't." } }] }), hermes: () => chat(NOTES, "gpt-6-sol") });
    const out = await llmFor(h)("s", "p");
    expect(out.text).toBe(NOTES);
    const [first, second] = h.sink.receipts;
    expect(first).toMatchObject({ model: "claude/sonnet-5", outcome: "succeeded" });
    expect(second).toMatchObject({ model: "codex/gpt-6-sol", outcome: "succeeded" });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.parentRequestId).toBe(first.requestId);
  });

  test("Claude and Hermes are tried even when the router has them sitting out (as before E2)", async () => {
    const h = harness({ claude: async () => ({ choices: [{ message: { content: NOTES } }] }), groqKey: false });
    const later = new Date(Date.now() + 30 * 60_000).toISOString();
    h.health.markModel("claude/sonnet-5", { state: "limited", until: later });
    h.health.markModel("codex/gpt-6-sol", { state: "limited", until: later });
    const out = await llmFor(h)("s", "p");
    expect(out.text).toBe(NOTES);
    expect(h.hits).toEqual(["claude:claude-sonnet-5"]);
  });

  test("when every model fails, Claude's own reason is kept in the error", async () => {
    const h = harness({ claude: async () => { throw new Error("Claude Code exited 1"); }, groqKey: false });
    await expect(llmFor(h)("s", "p")).rejects.toThrow(/Claude: Claude Code exited 1/);
    expect(h.hits).toEqual(["claude:claude-sonnet-5", "hermes:hermes-agent"]);
  });

  test("routedLlm on cad.code keeps the same order", async () => {
    const h = harness({ claude: async () => ({ choices: [{ message: { content: "```python\nresult = 1\n```" } }] }) });
    const llm = routedLlm({ task: "cad.code", caller: "test (cad)", usable: (t) => t.includes("```"), deps: h.deps, sink: h.sink, health: h.health, root: h.dir });
    await llm("s", "p");
    expect(h.sink.receipts[0]).toMatchObject({ task: "cad.code", model: "claude/sonnet-5", selectedBy: "rule" });
  });
});
