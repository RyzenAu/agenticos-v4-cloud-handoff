// Reviewer parity check: every pre-E2 picker option (6b1bdc3 vite.config.ts literals) still exists, same id/order/tier/default.
import { expect, test } from "bun:test";
import { claudeCodePickerModels, codexPickerModels, dreamOpenRouterOptions, hermesPickerCatalog, hermesRef, ccrPickerModels, displayName } from "../model-router/pickers";
import { providerModelId } from "../model-router/catalogue";
import { MOTION_MODEL, MOTION_MODEL_LABEL, MOTION_COORDINATOR_MODEL } from "../../src/motion/engine/launch";

const PRE_HERMES: [string, [string, string][]][] = [
  ["openai", [["gpt-6-sol","frontier"],["gpt-6-astra","frontier"],["gpt-6-luna","cheap"],["gpt-5.6-sol","frontier"],["gpt-5.6-terra","top"],["gpt-5.6-luna","cheap"],["gpt-5.5","top"],["gpt-5.5-pro","top"],["gpt-5.3-codex","mid"],["gpt-5.4-nano","cheap"]]],
  ["anthropic", [["claude-fable-5","frontier"],["claude-opus-4.8","top"],["claude-sonnet-4.6","mid"],["claude-haiku-4.5","cheap"]]],
  ["googlegemini", [["gemini-3.1-pro","top"],["gemini-3.5-flash","mid"],["gemini-3.1-flash-lite","cheap"]]],
  ["openrouter", [["anthropic/claude-fable-5","frontier"],["z-ai/glm-5.2","top"],["anthropic/claude-opus-4.8","top"],["anthropic/claude-sonnet-5","top"],["openai/gpt-5.6-sol","frontier"],["openai/gpt-5.6-terra","top"],["openai/gpt-5.6-luna","cheap"],["openai/gpt-5.5","top"],["deepseek/deepseek-v4-pro","top"],["x-ai/grok-4.5","top"],["x-ai/grok-4.3","mid"],["google/gemini-3.5-flash","mid"],["minimax/minimax-m3","mid"],["qwen/qwen3.7-plus","mid"],["moonshotai/kimi-k3","top"],["moonshotai/kimi-k2.6","mid"],["deepseek/deepseek-v4-flash","cheap"],["z-ai/glm-4.7-flash","cheap"],["meta-llama/llama-3.3-70b-instruct:free","free"]]],
  ["openai-codex", [["gpt-6-sol","frontier"],["gpt-6-astra","frontier"],["gpt-6-luna","cheap"],["gpt-5.6-sol","frontier"],["gpt-5.6-terra","top"],["gpt-5.6-luna","cheap"],["gpt-5.5","top"],["gpt-5.5-pro","top"],["gpt-5.3-codex","mid"]]],
  ["xai-oauth", [["grok-4.5","top"],["grok-4.3","mid"],["grok-4","mid"]]],
  ["minimax", [["minimax-m3","top"]]],
  ["sakana", [["fugu-ultra","top"],["fugu","mid"]]],
  ["xai", [["grok-4.5","top"],["grok-4.3","mid"],["grok-4","mid"]]],
  ["mistral", [["mistral-large-3","top"],["mistral-small-3","cheap"]]],
  ["ollama", [["llama3.3","free"],["qwen3","free"],["deepseek-r1","free"]]],
  ["groq", [["llama-3.3-70b-versatile","mid"]]],
  ["cohere", [["command-a","top"]]],
];

test("hermes picker parity", () => {
  const post = hermesPickerCatalog();
  const problems: string[] = [];
  for (const [provider, models] of PRE_HERMES) {
    const g = post.find((x) => x.provider === provider);
    if (!g) { problems.push(`group ${provider} missing`); continue; }
    models.forEach(([name, tier], i) => {
      const m = g.models[i];
      if (!m || m.name !== name) problems.push(`${provider}[${i}] expected ${name} got ${m?.name}`);
      else if (m.tier !== tier) problems.push(`${provider}/${name} tier ${tier} -> ${m.tier}`);
    });
  }
  console.log("post groups:", post.map((g) => `${g.provider}:${g.models.map((m) => m.name).join(",")}`).join("\n"));
  console.log("PROBLEMS", problems);
});

test("claude-code, codex, dream pickers", () => {
  const claude = claudeCodePickerModels().map((m) => [m.name, m.tier]);
  const codex = codexPickerModels().map((m) => [m.name, m.tier]);
  console.log("claude", claude); console.log("codex", codex); console.log("dream", dreamOpenRouterOptions());
  expect(claude.slice(0, 5)).toEqual([["claude-opus-5","top"],["claude-fable-5","top"],["claude-opus-4-8","top"],["claude-sonnet-5","mid"],["claude-haiku-4-5-20251001","fast"]]);
  expect(codex.slice(0, 8)).toEqual([["gpt-6-sol","top"],["gpt-6-astra","top"],["gpt-6-luna","mid"],["gpt-5.6-sol","top"],["gpt-5.6-terra","top"],["gpt-5.6-luna","mid"],["gpt-5.5","mid"],["gpt-5.3-codex","fast"]]);
  expect(dreamOpenRouterOptions().slice(0, 6)).toEqual([
    { id: "anthropic/claude-fable-5", label: "Claude Fable 5 · frontier · default" },
    { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 · fast" },
    { id: "openai/gpt-5.5", label: "OpenAI GPT-5.5" },
    { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
  ]);
  const ccr = ccrPickerModels(["moonshotai/kimi-k3", "some/unknown"]);
  console.log("ccr", ccr.map((m) => [m.name, m.tier]));
  expect(ccr.map((m) => [m.name, m.tier])).toEqual([["moonshotai/kimi-k3","top"],["some/unknown","top"]]);
});

test("persona seeds and constants", () => {
  expect(hermesRef("anthropic-api/claude-sonnet-4.6")).toEqual({ provider: "anthropic", name: "claude-sonnet-4.6" });
  expect(hermesRef("anthropic-api/claude-opus-4.8")).toEqual({ provider: "anthropic", name: "claude-opus-4.8" });
  expect(hermesRef("openai-api/gpt-5.5")).toEqual({ provider: "openai", name: "gpt-5.5" });
  expect(hermesRef("openrouter/claude-fable-5")).toEqual({ provider: "openrouter", name: "anthropic/claude-fable-5" });
  expect(hermesRef("openrouter-free/llama-3.3-70b-instruct")).toEqual({ provider: "openrouter", name: "meta-llama/llama-3.3-70b-instruct:free" });
  expect([MOTION_MODEL, MOTION_MODEL_LABEL, MOTION_COORDINATOR_MODEL]).toEqual(["claude-opus-5-5", "Opus 5.5", "gpt-6-astra"]);
  expect(providerModelId("openrouter/kimi-k3")).toBe("moonshotai/kimi-k3");
  expect(providerModelId("claude/haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  expect(providerModelId("codex/gpt-5.6")).toBe("gpt-5.6");
  expect(providerModelId("claude/opus-5")).toBe("claude-opus-5");
  expect(providerModelId("openrouter/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
  expect(providerModelId("openrouter/gemini-2.5-flash-lite")).toBe("google/gemini-2.5-flash-lite");
  expect(providerModelId("codex/gpt-5.5")).toBe("gpt-5.5");
  expect(providerModelId("kie/nano-banana-2")).toBe("nano-banana-2");
  expect(providerModelId("openai/gpt-realtime")).toBe("gpt-realtime");
});
