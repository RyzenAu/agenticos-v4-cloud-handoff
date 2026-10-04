// The Dream's model calls go through the router (task dream.nightly): the engine choice is the
// selected catalogue model, and every call writes a receipt naming the model that ran.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogueTask } from "../model-router/catalogue";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { DEFAULT_LIMITS, dreamLimits, dreamModelId, dreamModels, dreamSelection } from "./core";
import { codexConfigModel, dreamCall, hermesConfigModel, openRouterDreamCall } from "./engines";

const deps = (sink = new MemoryReceiptSink()) => ({ root: tmpdir(), sink, health: new MemoryHealthStore(), hasKey: () => true });

describe("model ids come from the catalogue", () => {
  test("the Dream's models are dream.nightly's candidates and selectable models", () => {
    const t = catalogueTask("dream.nightly")!;
    expect(dreamModels()).toEqual([...t.candidates, ...(t.selectable ?? [])]);
    expect(DEFAULT_LIMITS.model).toBe(t.candidates[0]);
  });
  test("engine choice = owner selection; each engine keeps the model it ran before E2", () => {
    expect(dreamSelection("claude", {})).toEqual({ selected: "claude/sonnet-5", providers: ["claude-sub"], runs: "claude-sonnet-5" });
    expect(dreamSelection("claude", { dream: { model: "claude-opus-5-5" } }).selected).toBe("claude/opus-5-5");
    expect(dreamSelection("claude", { dream: { model: "claude/fable-5-1" } }).selected).toBe("claude/fable-5-1");
    // codex exec runs the CLI's own configured model (nothing passed); the receipt names it.
    expect(dreamSelection("codex", {}, "gpt-6-astra")).toEqual({ selected: "codex/gpt-6-astra", providers: ["codex"], runs: "gpt-6-astra" });
    expect(dreamSelection("codex", {}, null)).toEqual({ selected: "codex/gpt-6-sol", providers: ["codex"], runs: null });
    expect(dreamSelection("hermes", {}, "gpt-6-sol")).toEqual({ selected: "codex/gpt-6-sol", providers: ["codex"], runs: "gpt-6-sol" });
    expect(dreamSelection("openrouter", {})).toEqual({ selected: "openrouter/claude-fable-5", providers: ["openrouter"], runs: "anthropic/claude-fable-5" });
  });
  test("the CLI's configured model is read from its own config", () => {
    expect(codexConfigModel('model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "other"\n')).toBe("gpt-6-astra");
    expect(codexConfigModel('[profiles.x]\nmodel = "other"\n')).toBeNull();
    expect(codexConfigModel(null)).toBeNull();
    expect(hermesConfigModel("model:\n  default: gpt-6-sol\n  provider: openai-codex\nagent:\n  model: gpt-6-astra\n")).toBe("gpt-6-sol");
    expect(hermesConfigModel("agent:\n  x: 1\n")).toBeNull();
  });
  test("any plausible OpenRouter model saved in config still runs, as before E2", () => {
    // The dashboard's picker saves OpenRouter's own id; it maps to the catalogue id.
    expect(dreamSelection("openrouter", { openRouterModel: "anthropic/claude-fable-5" }).selected).toBe("openrouter/claude-fable-5");
    expect(dreamSelection("openrouter", { openRouterModel: "openrouter/claude-fable-5" }).selected).toBe("openrouter/claude-fable-5");
    // Another id runs as saved, under the catalogue's OpenRouter owner-choice entry.
    const other = dreamSelection("openrouter", { openRouterModel: "xiaomi/mimo-v2.6-pro" });
    expect(other.runs).toBe("xiaomi/mimo-v2.6-pro");
    expect(other.selected).toMatch(/^openrouter\//);
    // An implausible id is ignored for the default, as before.
    expect(dreamSelection("openrouter", { openRouterModel: "bad model!" }).runs).toBe("anthropic/claude-fable-5");
    expect(dreamModelId("claude-sonnet-5", "openrouter")).toBeNull();
  });
  test("a Claude model outside the task runs as saved under the owner-choice entry; an implausible value gets the default", () => {
    expect(dreamLimits({ dream: { model: "openrouter/claude-fable-5" } }).model).toBe("claude/sonnet-5");
    expect(dreamLimits({ dream: { model: "claude-3-opus" } })).toMatchObject({ model: "claude/dream-owner-choice", cliModel: "claude-3-opus" });
  });
});

describe("receipts", () => {
  test("claude: one receipt per call with the model claude -p reported and its tokens", async () => {
    const sink = new MemoryReceiptSink();
    let pinned = "";
    const out = await dreamCall("claude", dreamSelection("claude", {}), deps(sink), async (choice) => {
      pinned = choice.providerModel;
      return { text: '{"report":{}}', providerModel: "claude-sonnet-5", inputTokens: 90_000, outputTokens: 4_000 };
    });
    expect(pinned).toBe("claude-sonnet-5");
    expect(out.reply.text).toContain("report");
    expect(sink.receipts).toHaveLength(1);
    expect(sink.receipts[0]).toMatchObject({
      task: "dream.nightly", caller: "scripts/run-dream (claude)", provider: "claude-sub", model: "claude/sonnet-5", providerModel: "claude-sonnet-5",
      route: "subscription", costBasis: "subscription_allowance", selectedBy: "owner", inputTokens: 90_000, outputTokens: 4_000, outcome: "succeeded", fallbackFrom: null,
    });
  });

  test("a repair retry is a new request linked to the first (never a replay)", async () => {
    const sink = new MemoryReceiptSink();
    const first = await dreamCall("claude", dreamSelection("claude", {}), deps(sink), async () => ({ text: "not json", providerModel: "claude-sonnet-5", inputTokens: 1, outputTokens: 1 }));
    await dreamCall("claude", dreamSelection("claude", {}), deps(sink), async () => ({ text: "{}", providerModel: "claude-sonnet-5", inputTokens: 1, outputTokens: 1 }), { parentRequestId: first.receipt.requestId });
    expect(sink.receipts).toHaveLength(2);
    expect(sink.receipts[1].requestId).not.toBe(sink.receipts[0].requestId);
    expect(sink.receipts[1].parentRequestId).toBe(sink.receipts[0].requestId);
  });

  test("a failed night keeps the engine's own reason, writes a failed receipt and never falls back to a free model", async () => {
    const sink = new MemoryReceiptSink();
    const calls: string[] = [];
    await expect(
      dreamCall("codex", dreamSelection("codex", {}, "gpt-6-astra"), deps(sink), async (choice) => {
        calls.push(choice.model);
        throw new Error("codex produced no output (exit 1). model not supported");
      }),
    ).rejects.toThrow("codex produced no output (exit 1)");
    expect(calls).toEqual(["codex/gpt-6-astra"]);
    expect(sink.receipts[0]).toMatchObject({ model: "codex/gpt-6-astra", route: "subscription", outcome: "failed", providerModel: null });
    expect(sink.receipts.every((r) => r.route !== "free")).toBe(true);
  });

  test("hermes: an agent run that writes the file itself is never re-run; providerModel stays null", async () => {
    const sink = new MemoryReceiptSink();
    const out = await dreamCall("hermes", dreamSelection("hermes", {}), deps(sink), async () => ({ text: "", providerModel: null, inputTokens: null, outputTokens: null }), { sideEffects: true });
    expect(out.receipt).toMatchObject({ task: "dream.nightly", caller: "scripts/run-dream (hermes)", model: "codex/gpt-6-sol", providerModel: null, outcome: "succeeded" });
    let runs = 0;
    await expect(
      dreamCall("hermes", dreamSelection("hermes", {}), deps(sink), async () => {
        runs++;
        throw new Error("hermes exited 1");
      }, { sideEffects: true }),
    ).rejects.toThrow("hermes exited 1");
    expect(runs).toBe(1);
  });

  test("openrouter: the pre-E2 request (model as configured, json_object) with a receipt of the reported model and cost", async () => {
    const sink = new MemoryReceiptSink();
    let body: any;
    let headers: any;
    const request = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      headers = init.headers;
      return new Response(JSON.stringify({ model: "anthropic/claude-fable-5", choices: [{ message: { content: '{"report":{"summaryLine":"x"}}' } }], usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.0421 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const messages = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }];
    const selection = dreamSelection("openrouter", {});
    const out = await dreamCall("openrouter", selection, deps(sink), openRouterDreamCall("sk-test", selection.runs!, messages, { request }));
    expect(body).toMatchObject({ model: "anthropic/claude-fable-5", response_format: { type: "json_object" }, temperature: 0.4, max_tokens: 8000 });
    expect(headers["X-Title"]).toBe("Claude OS Dream");
    expect(out.reply.text).toContain("summaryLine");
    expect(sink.receipts[0]).toMatchObject({ provider: "openrouter", model: "openrouter/claude-fable-5", providerModel: "anthropic/claude-fable-5", route: "metered", costUsd: 0.0421, costBasis: "provider_reported", inputTokens: 1000, outputTokens: 200 });
    // A failure keeps the pre-E2 message (status and body excerpt) for the night's status file.
    const failing = (async () => new Response("no credits left", { status: 402 })) as unknown as typeof fetch;
    await expect(dreamCall("openrouter", selection, deps(sink), openRouterDreamCall("sk-test", selection.runs!, messages, { request: failing }))).rejects.toThrow("OpenRouter HTTP 402: no credits left");
  });

  test("the Dream always tries its engine, whatever another surface's recent limit on that model", async () => {
    const sink = new MemoryReceiptSink();
    let ran = 0;
    // No health store passed: the shared one isn't consulted (as before E2, the night always tried).
    await dreamCall("claude", dreamSelection("claude", {}), { root: tmpdir(), sink, hasKey: () => true }, async () => (ran++, { text: "{}", providerModel: "claude-sonnet-5", inputTokens: 1, outputTokens: 1 }));
    expect(ran).toBe(1);
  });

  test("the nightly Claude guard is not applied to OpenRouter: no budget object is involved in its call", async () => {
    // runOpenRouter in run-dream.ts calls dreamCall directly; DreamBudget is only built in the claude pipeline.
    const src = await Bun.file(join(import.meta.dir, "..", "run-dream.ts")).text();
    const fn = src.slice(src.indexOf("async function runOpenRouter"), src.indexOf("// ---- the claude overnight pipeline"));
    expect(fn).not.toMatch(/DreamBudget|budget\./);
    expect(src).not.toContain("DEFAULT_OR_MODEL");
    expect(src).not.toMatch(/"claude-sonnet-5"|"anthropic\/claude-fable-5"/);
    // No model is passed to codex exec or hermes chat that wasn't passed before E2.
    expect(src).not.toMatch(/"-m"|--provider/);
  });
});
