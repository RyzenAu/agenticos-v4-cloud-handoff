import { expect, test } from "bun:test";
import raw from "./catalogue.json";
import { catalogue, taskChain, validateCatalogue } from "./catalogue";

const clone = () => JSON.parse(JSON.stringify(raw));

test("the catalogue file passes its own schema", () => {
  expect(validateCatalogue(raw)).toEqual([]);
  expect(catalogue().schema).toBe("mu.model-catalogue/v2");
});

test("every model has provider, providerModel, modality, tools, route, health probe and a cost basis", () => {
  for (const m of catalogue().models) {
    expect(m.provider.length).toBeGreaterThan(0);
    expect(m.providerModel.length).toBeGreaterThan(0);
    expect(m.modality.in.length).toBeGreaterThan(0);
    expect(typeof m.tools).toBe("boolean");
    expect(["free", "subscription", "metered"]).toContain(m.route);
    expect(m.cost.basis.length).toBeGreaterThan(0);
    expect(m.lastProbe === null || Number.isFinite(Date.parse(m.lastProbe.at))).toBe(true);
  }
});

test("no paid route is labelled free, and a subscription is never free", () => {
  for (const m of catalogue().models) {
    if (m.route !== "free") expect(m.cost.basis).not.toBe("free");
    if (m.route === "free") expect(["free", "free-promotional"]).toContain(m.costClass);
    if (m.provider === "claude-sub" || m.provider === "codex") expect(m.route).toBe("subscription");
    if (m.provider === "openrouter")
      expect(m.route === "free").toBe(m.providerModel.endsWith(":free"));
    if (["typesafe", "elevenlabs", "deepseek"].includes(m.provider))
      expect(m.route).toBe("metered");
  }
  for (const p of catalogue().providers) if (p.freeVerified) expect(p.route).toBe("free");
});

test("schema rejects a paid model labelled free, a subscription labelled free and an unconfigured metered primary", () => {
  const a = clone();
  a.models.find((m: any) => m.id === "openrouter/mimo-v2.6-flash").cost = { basis: "free" };
  expect(validateCatalogue(a).join()).toMatch(/metered model is labelled free/);

  const b = clone();
  const opus = b.models.find((m: any) => m.id === "claude/opus-5-5");
  opus.route = "free";
  opus.costClass = "free";
  opus.cost = { basis: "free" };
  expect(validateCatalogue(b).join()).toMatch(/subscription provider/);

  const c = clone();
  c.tasks["voice.brain"].candidates.push("openrouter/mimo-v2.6-flash");
  expect(validateCatalogue(c).join()).toMatch(/free-only task lists metered/);

  const d = clone();
  d.tasks["bulk.text"].candidates.unshift("openrouter/mimo-v2.6-pro");
  expect(validateCatalogue(d).join()).toMatch(/as the first candidate must be configured/);
  const d2 = clone();
  d2.tasks["bulk.text"].candidates.push("openrouter/mimo-v2.6-pro"); // owner, 28 Sep: paid models may be fallbacks
  expect(validateCatalogue(d2)).toEqual([]);

  const e = clone();
  e.models.find((m: any) => m.id === "openrouter-free/qwen3.8-27b").providerModel =
    "qwen/qwen3.8-27b";
  expect(validateCatalogue(e).join()).toMatch(/exact :free id/);
});

test("schema rejects tasks that route to stale or excluded models and unknown ids", () => {
  const a = clone();
  a.tasks["bulk.text"].candidates.push("cline/pixel-canary");
  expect(validateCatalogue(a).join()).toMatch(/excluded model cline\/pixel-canary/);
  const b = clone();
  b.tasks["voice.tts"].candidates.push("groq/llama-3.3-70b-versatile");
  expect(validateCatalogue(b).join()).toMatch(/stale model/);
  const c = clone();
  c.tasks["critique"].candidates.push("nobody/nothing");
  expect(validateCatalogue(c).join()).toMatch(/unknown model/);
  const d = clone();
  d.providers[0].keyNames = ["lower-case-value"];
  expect(validateCatalogue(d).join()).toMatch(/env NAMES/);
});

test("taskChain gives routable provider ids and drops stale ones", () => {
  expect(taskChain("screen.plan", "groq")).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  expect(taskChain("voice.brain", "groq")).toEqual([
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
  ]);
  expect(taskChain("research.web", "groq")).toEqual([]);
  expect(() => taskChain("no.such.task", "groq")).toThrow();
});
