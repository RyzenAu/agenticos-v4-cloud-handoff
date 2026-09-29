import { describe, expect, test } from "bun:test";
import { catalogue } from "./catalogue";
import {
  catalogueLabel,
  catalogueSpendPrice,
  ccrPickerModels,
  claudeCodePickerModels,
  codexPickerModels,
  displayName,
  dreamOpenRouterOptions,
  hermesPickerCatalog,
  hermesRef,
  pickerCostLabel,
  pickerTier,
  routableChatModels,
} from "./pickers";

const all = () => [
  ...hermesPickerCatalog().flatMap((g) => g.models),
  ...claudeCodePickerModels(),
  ...codexPickerModels(),
];
const byId = (id: string) => catalogue().models.find((m) => m.id === id)!;
const names = (entries: { name: string }[]) => entries.map((e) => e.name);

// The pickers exactly as vite.config.ts hard-coded them before E2 (the regression baseline).
const PRE_E2_HERMES: Record<string, string[]> = {
  openai: ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro", "gpt-5.3-codex", "gpt-5.4-nano"],
  anthropic: ["claude-fable-5", "claude-opus-4.8", "claude-sonnet-4.6", "claude-haiku-4.5"],
  googlegemini: ["gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
  openrouter: [
    "anthropic/claude-fable-5", "z-ai/glm-5.2", "anthropic/claude-opus-4.8", "anthropic/claude-sonnet-5", "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "openai/gpt-5.5", "deepseek/deepseek-v4-pro", "x-ai/grok-4.5", "x-ai/grok-4.3",
    "google/gemini-3.5-flash", "minimax/minimax-m3", "qwen/qwen3.7-plus", "moonshotai/kimi-k3", "moonshotai/kimi-k2.6",
    "deepseek/deepseek-v4-flash", "z-ai/glm-4.7-flash", "meta-llama/llama-3.3-70b-instruct:free",
  ],
  "openai-codex": ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro", "gpt-5.3-codex"],
  "xai-oauth": ["grok-4.5", "grok-4.3", "grok-4"],
  minimax: ["minimax-m3"],
  sakana: ["fugu-ultra", "fugu"],
  xai: ["grok-4.5", "grok-4.3", "grok-4"],
  mistral: ["mistral-large-3", "mistral-small-3"],
  ollama: ["llama3.3", "qwen3", "deepseek-r1"],
  cohere: ["command-a"],
};
const PRE_E2_GROUP_ORDER = ["openai", "anthropic", "googlegemini", "openrouter", "openai-codex", "xai-oauth", "minimax", "sakana", "xai", "mistral", "ollama", "groq", "cohere"];

describe("pickers keep every pre-E2 option (E2 moves ids, never narrows)", () => {
  test("the Hermes picker offers every pre-E2 model, in its pre-E2 order, first in each group", () => {
    const groups = hermesPickerCatalog();
    for (const [provider, want] of Object.entries(PRE_E2_HERMES)) {
      const g = groups.find((x) => x.provider === provider);
      expect(g).toBeDefined();
      expect(names(g!.models).slice(0, want.length)).toEqual(want);
    }
    // Pre-E2 groups keep their order; newer groups come after.
    const order = groups.map((g) => g.provider).filter((p) => PRE_E2_GROUP_ORDER.includes(p));
    expect(order).toEqual(PRE_E2_GROUP_ORDER);
  });

  test("pre-E2 tiers are kept", () => {
    const or = hermesPickerCatalog().find((g) => g.provider === "openrouter")!.models;
    expect(or.find((m) => m.name === "anthropic/claude-fable-5")!.tier).toBe("frontier");
    expect(or.find((m) => m.name === "deepseek/deepseek-v4-pro")!.tier).toBe("top");
    expect(or.find((m) => m.name === "meta-llama/llama-3.3-70b-instruct:free")!.tier).toBe("free");
    expect(claudeCodePickerModels().find((m) => m.name === "claude-haiku-4-5-20251001")!.tier).toBe("fast");
  });

  test("Claude Code and Codex pickers: pre-E2 list first, then newer catalogue models", () => {
    expect(names(claudeCodePickerModels()).slice(0, 5)).toEqual(["claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    expect(names(claudeCodePickerModels())).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5"]));
    expect(names(codexPickerModels()).slice(0, 8)).toEqual(["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex"]);
    // The bare fallback id is a code fallback, not a pick.
    expect(names(codexPickerModels())).not.toContain("gpt-5.6");
    for (const m of [...claudeCodePickerModels(), ...codexPickerModels()]) expect(m.route).toBe("subscription");
  });

  test("the Dream OpenRouter dropdown keeps its pre-E2 list, labels and default", () => {
    expect(dreamOpenRouterOptions().slice(0, 6)).toEqual([
      { id: "anthropic/claude-fable-5", label: "Claude Fable 5 · frontier · default" },
      { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 · fast" },
      { id: "openai/gpt-5.5", label: "OpenAI GPT-5.5" },
      { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
    ]);
  });

  test("persona seed refs resolve to the pre-E2 provider/model pairs", () => {
    expect(hermesRef("anthropic-api/claude-sonnet-4.6")).toEqual({ provider: "anthropic", name: "claude-sonnet-4.6" });
    expect(hermesRef("openai-api/gpt-5.5")).toEqual({ provider: "openai", name: "gpt-5.5" });
    expect(hermesRef("openrouter/claude-fable-5")).toEqual({ provider: "openrouter", name: "anthropic/claude-fable-5" });
    expect(hermesRef("openrouter-free/llama-3.3-70b-instruct")).toEqual({ provider: "openrouter", name: "meta-llama/llama-3.3-70b-instruct:free" });
    expect(hermesRef("cline/deepseek-v4.1-flash")).toEqual({ provider: "cline-free", name: "deepseek-v4.1-flash" });
  });

  test("ccr models the catalogue doesn't know are kept, not dropped", () => {
    const rows = ccrPickerModels(["anthropic/claude-fable-5", "someone/new-model"]);
    expect(names(rows)).toEqual(["anthropic/claude-fable-5", "someone/new-model"]);
    expect(rows[1].cost).toMatch(/not in the catalogue/);
  });
});

describe("pickers stay honest", () => {
  test("stale, excluded and not-configured models are never offered", () => {
    const offered = new Set(all().map((e) => e.id));
    const hidden = catalogue().models.filter((m) => m.status === "stale" || m.status === "excluded" || m.status === "not-configured");
    expect(hidden.length).toBeGreaterThan(0);
    for (const m of hidden) expect(offered.has(m.id)).toBe(false);
    for (const id of ["cline/pixel-canary", "groq/llama-3.3-70b-versatile", "groq/compound"])
      expect(offered.has(id)).toBe(false);
  });

  test("no paid model is labelled free, and a subscription is never free", () => {
    for (const e of all()) {
      if (e.route !== "free") {
        expect(e.tier).not.toBe("free");
        expect(e.cost).not.toMatch(/free/i);
      }
      if (e.route === "subscription") expect(e.cost).toMatch(/subscription/i);
      if (e.route === "metered") expect(e.cost).toMatch(/^Metered/);
      if (e.tier === "free") expect(e.route).toBe("free");
    }
    for (const m of catalogue().models) {
      if (m.route !== "free") {
        expect(pickerTier(m)).not.toBe("free");
        expect(pickerTier(m, "free")).not.toBe("free");
        expect(pickerCostLabel(m)).not.toMatch(/free/i);
      }
    }
  });

  test("a free tier whose billing is unverified says so", () => {
    expect(pickerCostLabel(byId("gemini/3.8-flash"))).toBe("Free tier (billing unverified)");
    expect(pickerCostLabel(byId("groq/gpt-oss-120b"))).toBe("Free");
  });

  test("newer catalogue chat models are appended to their provider's group", () => {
    const flat = hermesPickerCatalog().flatMap((g) => g.models.map((m) => `${g.provider}/${m.name}`));
    expect(flat).toContain("groq/openai/gpt-oss-120b");
    expect(flat).toContain("cline-free/deepseek-v4.1-flash");
    expect(flat).toContain("claude-sub/claude-opus-5-5");
    expect(flat).toContain("openrouter/xiaomi/mimo-v2.6-flash");
    expect(flat.some((x) => /whisper|orpheus|tts|jev|owner-selected|\*/.test(x))).toBe(false);
    expect(dreamOpenRouterOptions().some((o) => o.id.includes("*"))).toBe(false);
  });

  test("tiers for newer entries come from route and cost", () => {
    expect(pickerTier(byId("groq/gpt-oss-120b"))).toBe("free");
    expect(pickerTier(byId("claude/fable-5-1"))).toBe("frontier");
    expect(pickerTier(byId("openrouter/mimo-v2.6-flash"))).toBe("cheap");
    expect(pickerTier(byId("codex/gpt-6-sol"))).toBe("mid"); // no price: unknown -> default tier, never free
  });

  test("spend prices come from the catalogue, with the date", () => {
    expect(catalogueSpendPrice(byId("openrouter/claude-fable-5"))).toEqual({ inputUsdPerM: 10, outputUsdPerM: 50, priceAsOf: "2026-09-27" });
    expect(catalogueSpendPrice(byId("claude/opus-5-5"))).toBeNull();
    expect(catalogueSpendPrice(byId("groq/gpt-oss-120b"))).toBeNull();
  });

  test("display names", () => {
    expect(displayName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(displayName("gpt-6-sol")).toBe("GPT-6 Sol");
    expect(displayName("deepseek/deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(catalogueLabel("google/gemini-2.5-flash-lite", "openrouter")).toBe("Gemini 2.5 Flash Lite");
    expect(catalogueLabel("claude-opus-4-7")).toBeNull();
  });

  test("routableChatModels never returns a stale id", () => {
    for (const m of routableChatModels()) expect(["verified", "configured"]).toContain(m.status);
  });
});
