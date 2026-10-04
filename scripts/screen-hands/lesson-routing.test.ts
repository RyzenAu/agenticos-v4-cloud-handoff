import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice, protocolFollowUp } from "../free-voice";
import { BENCH_CASES, matches, specOf } from "../jev-bench-cases";
import { buildCall, CATEGORIES, tierOf } from "../jev-router";

// Lessons are routed by rules (no model call): the brain and Jev are never asked in these tests.
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the handle briefly */
    }
  }
});
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "lesson-routing-"));
  roots.push(dir);
  return dir;
};
const noNetwork = (async () => {
  throw new Error("no network in this test");
}) as unknown as typeof fetch;

async function route(text: string, lessonActive = false) {
  const voice = freeVoice(root(), { key: () => "", fetch: noNetwork, lessonActive: () => lessonActive });
  const result: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: text }] }).catch((e: Error) => ({ error: e.message }));
  const call = result.tool_calls?.[0]?.function;
  return call ? { name: call.name as string, args: JSON.parse(call.arguments) } : { name: null, args: {}, result };
}

describe("lesson routing (rules, no model call)", () => {
  test("the owner's phrasings start a teach lesson", async () => {
    for (const [text, goal] of [
      ["show me how to change the font", "change the font"],
      ["teach me how to publish this post", "publish this post"],
      ["where do I click to add a table", "add a table"],
      ["walk me through exporting this as a PDF", "exporting this as a PDF"],
    ]) expect(await route(text)).toEqual({ name: "screen_teach", args: { mode: "teach", goal } });
  });

  test("take over with a task starts a drive lesson, unless the task is outbound (control_pc's gate)", async () => {
    expect(await route("take over and fill in this form")).toEqual({ name: "screen_teach", args: { mode: "drive", goal: "fill in this form" } });
    expect((await route("take over and pay the invoice")).name).not.toBe("screen_teach");
  });

  test("while a lesson runs, next / just do it / stop steer it; with none running they don't", async () => {
    expect(await route("next", true)).toEqual({ name: "screen_teach", args: { control: "next" } });
    expect(await route("just do it", true)).toEqual({ name: "screen_teach", args: { control: "drive" } });
    expect(await route("I can't find it", true)).toEqual({ name: "screen_teach", args: { control: "stuck" } });
    expect(await route("stop", true)).toEqual({ name: "screen_teach", args: { control: "stop" } });
    expect((await route("next", false)).name).not.toBe("screen_teach");
  });

  test("screen_teach's result is spoken as it is (no model turn)", () => {
    const line = protocolFollowUp([
      { role: "user", content: "next" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "screen_teach", arguments: '{"control":"next"}' } }] },
      { role: "tool", tool_call_id: "a", content: "That one — Font, in the middle." },
    ]);
    expect(line).toBe("That one — Font, in the middle.");
  });
});

describe("Jev router catalogue and bench", () => {
  test("screen_teach is in the catalogue and maps to a lesson", () => {
    expect(CATEGORIES.screen_teach).toContain("Jarvis's own cursor");
    expect(tierOf("screen_teach")).toBe("show");
    expect(buildCall("screen_teach", "I've no idea how to add a signature in this, can you guide me", {}, { apps: [], skills: [] })).toEqual({
      name: "screen_teach",
      arguments: { goal: "I've no idea how to add a signature in this, can you guide me", mode: "teach" },
    });
    expect(buildCall("screen_teach", "take over and fill in this form", {}, { apps: [], skills: [] })).toEqual({ name: "screen_teach", arguments: { goal: "fill in this form", mode: "drive" } });
  });

  test("the bench's screen_teach group passes on the rules path", async () => {
    const cases = BENCH_CASES.filter((c) => c.group === "screen_teach" && c.expect.includes("screen_teach") && !c.expect.includes("screen"));
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      const r = await route(c.text);
      expect([c.text, matches(c.expect, { spec: specOf(r.name, r.args, "rules"), path: "rules", tool: r.name })]).toEqual([c.text, true]);
    }
  });
});
