// Every model the Dream's OpenRouter dropdown offered before E2 is still valid for the Dream task, under
// its own catalogue id (so the receipt names it), and any other saved id runs under the owner-choice entry.
import { expect, test } from "bun:test";
import { catalogueTask } from "../model-router/catalogue";
import { dreamOpenRouterOptions } from "../model-router/pickers";
import { dreamSelection } from "./core";

const PRE_E2 = ["anthropic/claude-fable-5", "anthropic/claude-sonnet-4.6", "openai/gpt-5.5", "google/gemini-3.5-flash", "meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-chat"];

test("the pre-E2 Dream dropdown is offered and every choice runs as picked", () => {
  const offered = dreamOpenRouterOptions().map((o) => o.id);
  for (const id of PRE_E2) {
    expect(offered).toContain(id);
    const s = dreamSelection("openrouter", { openRouterModel: id });
    expect(s.runs).toBe(id);
    expect(s.selected).not.toBe("openrouter/dream-owner-choice");
    expect(catalogueTask("dream.nightly")!.selectable).toContain(s.selected);
  }
});

test("any other plausible saved OpenRouter id still runs, under the owner-choice entry", () => {
  expect(dreamSelection("openrouter", { openRouterModel: "mistralai/some-model" })).toMatchObject({ selected: "openrouter/dream-owner-choice", runs: "mistralai/some-model" });
});

test("REVIEW-E12 M4: any plausible saved Claude model still goes to claude -p as saved", async () => {
  const { dreamLimits } = await import("./core");
  expect(dreamSelection("claude", { dream: { model: "claude-haiku-4-5" } })).toMatchObject({ runs: "claude-haiku-4-5" });
  expect(dreamSelection("claude", { dream: { model: "opus" } })).toMatchObject({ selected: "claude/dream-owner-choice", runs: "opus" });
  expect(dreamLimits({ dream: { model: "not valid!" } }).model).toBe("claude/sonnet-5");
});
