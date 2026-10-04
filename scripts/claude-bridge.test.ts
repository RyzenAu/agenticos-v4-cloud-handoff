import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { bridgePrompt, claudeBridge } from "./claude-bridge";

type Call = { args: string[]; stdin: string; env: NodeJS.ProcessEnv };
function fakeRun(result: unknown, calls: Call[] = []) {
  return async (args: string[], stdin: string, env: NodeJS.ProcessEnv) => {
    calls.push({ args, stdin, env });
    return typeof result === "string" ? result : JSON.stringify(result);
  };
}
const ok = { is_error: false, result: "Proposal text.", usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } };

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, remote = "127.0.0.1") {
  const req: any = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: { "content-type": "application/json", ...headers },
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield typeof body === "string" ? body : JSON.stringify(body);
    },
  });
  const res: any = {
    statusCode: 0,
    headersSent: false,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    write(chunk: string) { this.headersSent = true; this.body += chunk; },
    end(chunk = "") { this.headersSent = true; this.body += chunk; },
  };
  return { req, res };
}

describe("bridgePrompt", () => {
  test("system messages become the system prompt; one user turn passes through untouched", () => {
    expect(bridgePrompt([{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }])).toEqual({ system: "Be brief.", prompt: "Hi" });
  });
  test("a multi-turn conversation becomes a labelled transcript, text parts only", () => {
    const { prompt } = bridgePrompt([
      { role: "user", content: [{ type: "text", text: "Plan it" }, { type: "image_url", image_url: { url: "x" } }] },
      { role: "assistant", content: "Draft" },
      { role: "user", content: "Tighter" },
    ]);
    expect(prompt).toBe("User:\nPlan it\n\nAssistant:\nDraft\n\nUser:\nTighter\n\nReply to the last User message as the Assistant.");
  });
  test("rejects empty conversations", () => {
    expect(() => bridgePrompt([])).toThrow();
    expect(() => bridgePrompt([{ role: "system", content: "only system" }])).toThrow("no user message");
  });
});

describe("claudeBridge", () => {
  test("runs Claude Code text-only, on the subscription, without his CLAUDE.md or memory", async () => {
    const calls: Call[] = [];
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-pass";
    try {
      const bridge = claudeBridge({ run: fakeRun(ok, calls), now: () => 1_000_000 });
      const out: any = await bridge.complete({ model: "claude-opus-5-5", messages: [{ role: "user", content: "Q" }] });
      expect(out.choices[0].message.content).toBe("Proposal text.");
      expect(out.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 });
      const { args, stdin, env } = calls[0];
      expect(stdin).toBe("Q");
      expect(args).toContain("-p");
      expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
      expect(args[args.indexOf("--tools") + 1]).toBe("");
      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain("--no-session-persistence");
      expect(args).not.toContain("--bare"); // --bare drops the claude.ai login
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
  test("unknown models and Claude Code errors are reported, never faked", async () => {
    const bridge = claudeBridge({ run: fakeRun({ is_error: true, result: "Not logged in · Please run /login" }) });
    await expect(bridge.complete({ model: "gpt-6-sol", messages: [{ role: "user", content: "Q" }] })).rejects.toThrow("Unknown model");
    await expect(bridge.complete({ model: "claude-sonnet-5", messages: [{ role: "user", content: "Q" }] })).rejects.toThrow("Not logged in");
  });
  test("lists models and answers chat completions over HTTP, streamed or not", async () => {
    const bridge = claudeBridge({ run: fakeRun(ok) });
    let { req, res } = request("GET", "/v1/models");
    await bridge.handle(req, res);
    expect(JSON.parse(res.body).data.map((m: any) => m.id)).toContain("claude-opus-5-5");
    ({ req, res } = request("POST", "/v1/chat/completions", { model: "claude-haiku-4-5", messages: [{ role: "user", content: "Q" }], stream: true }));
    await bridge.handle(req, res);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain('"content":"Proposal text."');
    expect(res.body.trim().endsWith("data: [DONE]")).toBe(true);
  });
  test("refuses other machines, browser pages and non-JSON posts", async () => {
    const bridge = claudeBridge({ run: fakeRun(ok) });
    const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: "Q" }] };
    for (const [headers, remote, status] of [
      [{}, "192.168.1.20", 403],
      [{ origin: "https://evil.example" }, "127.0.0.1", 403],
      [{ "sec-fetch-site": "cross-site" }, "127.0.0.1", 403],
      [{ "content-type": "text/plain" }, "127.0.0.1", 415],
    ] as const) {
      const { req, res } = request("POST", "/v1/chat/completions", body, headers as Record<string, string>, remote);
      await bridge.handle(req, res);
      expect(res.statusCode).toBe(status);
    }
  });
});

describe("claudeBridge through the model router", () => {
  const { MemoryReceiptSink } = require("./model-router/receipts") as typeof import("./model-router/receipts");
  const { MemoryHealthStore } = require("./model-router/health") as typeof import("./model-router/health");
  const { providerModelId } = require("./model-router/catalogue") as typeof import("./model-router/catalogue");

  test("model ids come from the catalogue; the CLI alias for Fable and Haiku is transport detail", async () => {
    const { CLAUDE_BRIDGE_MODELS, claudeCatalogueId } = await import("./claude-bridge");
    expect(CLAUDE_BRIDGE_MODELS[providerModelId("claude/fable-5-1")]).toBe("fable");
    expect(CLAUDE_BRIDGE_MODELS[providerModelId("claude/haiku-4-5")]).toBe("haiku");
    expect(CLAUDE_BRIDGE_MODELS[providerModelId("claude/opus-5-5")]).toBe(providerModelId("claude/opus-5-5"));
    expect(claudeCatalogueId(providerModelId("claude/sonnet-5"))).toBe("claude/sonnet-5");
    expect(claudeCatalogueId("gpt-6-sol")).toBeNull();
  });

  test("an HTTP completion writes one receipt naming the catalogue model, the subscription route and who chose it", async () => {
    const sink = new MemoryReceiptSink();
    const calls: Call[] = [];
    const bridge = claudeBridge({ run: fakeRun(ok, calls), sink, health: new MemoryHealthStore() });
    let { req, res } = request("POST", "/v1/chat/completions", { model: providerModelId("claude/haiku-4-5"), messages: [{ role: "user", content: "Q" }] });
    await bridge.handle(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls[0].args[calls[0].args.indexOf("--model") + 1]).toBe("haiku");
    expect(sink.receipts).toHaveLength(1);
    expect(sink.receipts[0]).toMatchObject({
      task: "bridge.claude", caller: "scripts/claude-bridge (/__claude)", provider: "claude-sub", model: "claude/haiku-4-5",
      providerModel: "claude-haiku-4-5", route: "subscription", selectedBy: "owner", costBasis: "subscription_allowance",
      costUsd: null, fallbackFrom: null, outcome: "succeeded", inputTokens: 15, outputTokens: 7,
    });
    // The task's own first candidate is the rule default.
    ({ req, res } = request("POST", "/v1/chat/completions", { model: providerModelId("claude/sonnet-5"), messages: [{ role: "user", content: "Q" }] }));
    await bridge.handle(req, res);
    expect(sink.receipts[1]).toMatchObject({ model: "claude/sonnet-5", selectedBy: "rule", outcome: "succeeded" });
  });

  test("a Claude failure is receipted (no free fallback: Hermes keeps its chain) and the caller still gets Claude's error", async () => {
    const sink = new MemoryReceiptSink();
    const bridge = claudeBridge({ run: fakeRun({ is_error: true, result: "Not logged in · Please run /login" }), sink, health: new MemoryHealthStore() });
    const { req, res } = request("POST", "/v1/chat/completions", { model: providerModelId("claude/opus-5-5"), messages: [{ role: "user", content: "Q" }] });
    await bridge.handle(req, res);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error.message).toContain("Not logged in");
    expect(sink.receipts.map((r) => [r.model, r.outcome, r.errorCode])).toEqual([
      ["claude/opus-5-5", "failed", "auth"],
      ["claude/opus-5-5", "exhausted_free", "no_eligible_model"],
    ]);
    expect(sink.receipts.every((r) => r.provider === "claude-sub" && r.route === "subscription")).toBe(true);
    expect(JSON.stringify(sink.receipts)).not.toContain("Not logged in");
  });

  test("unknown models (400) and empty conversations (502, as before) are refused before routing; complete() stays a raw transport", async () => {
    const sink = new MemoryReceiptSink();
    const bridge = claudeBridge({ run: fakeRun(ok), sink, health: new MemoryHealthStore() });
    for (const [body, status] of [[{ model: "gpt-6-sol", messages: [{ role: "user", content: "Q" }] }, 400], [{ model: providerModelId("claude/sonnet-5"), messages: [] }, 502]] as const) {
      const { req, res } = request("POST", "/v1/chat/completions", body);
      await bridge.handle(req, res);
      expect(res.statusCode).toBe(status);
    }
    // In-process callers route through routedChat/claudeChat, which write their own receipt.
    await bridge.complete({ model: providerModelId("claude/sonnet-5"), messages: [{ role: "user", content: "Q" }] });
    expect(sink.receipts).toHaveLength(0);
  });

  test("/v1/models lists the catalogue's Claude models", async () => {
    const bridge = claudeBridge({ run: fakeRun(ok) });
    const { req, res } = request("GET", "/v1/models");
    await bridge.handle(req, res);
    const ids = JSON.parse(res.body).data.map((m: any) => m.id).sort();
    expect(ids).toEqual(["claude/fable-5-1", "claude/haiku-4-5", "claude/opus-5-5", "claude/sonnet-5"].map(providerModelId).sort());
  });

  test("with no health store (the default), a failure doesn't stop the next request from running claude -p", async () => {
    const sink = new MemoryReceiptSink();
    let calls = 0;
    const bridge = claudeBridge({ sink, run: async () => { calls++; return JSON.stringify(calls === 1 ? { is_error: true, result: "Claude usage limit reached" } : ok); } });
    for (const status of [502, 200]) {
      const { req, res } = request("POST", "/v1/chat/completions", { model: providerModelId("claude/opus-5-5"), messages: [{ role: "user", content: "Q" }] });
      await bridge.handle(req, res);
      expect(res.statusCode).toBe(status);
    }
    expect(calls).toBe(2);
  });
});
