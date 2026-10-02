import { expect, test } from "bun:test";
import { validPersonality, personalityInstructions } from "../src/lib/voice-personality";

test("corrupt preferences cannot produce an invalid voice speed or unbounded prompt", () => {
  for (const bad of [
    null,
    "invalid",
    { humour: 99, speed: NaN },
    { humour: -1, speed: Infinity },
  ]) {
    expect(validPersonality(bad)).toEqual({ humour: 1, prompt: "", speed: 1 });
  }
  expect(validPersonality({ speed: 99 }).speed).toBe(1.15);
  expect(validPersonality({ speed: -99 }).speed).toBe(0.85);
  expect(validPersonality({ prompt: "a".repeat(2000) }).prompt).toHaveLength(1000);
  expect(personalityInstructions(undefined)).toBe("");
});
