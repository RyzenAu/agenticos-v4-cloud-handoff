import { describe, expect, test } from "bun:test";
import { classifyTaskWithJevFallback, politeStrip } from "./jev-fallback";

const json = (value: unknown, ok = true) => ({ ok, json: async () => value }) as unknown as Response;
const SCREEN_TASK = "could you please open Notepad, type hello from away mode, then save it to D:\\tmp\\away-test\\notepad.txt";

describe("politeStrip", () => {
  test("strips only a leading politeness phrase, never punctuation or paths", () => {
    expect(politeStrip("could you please open Notepad")).toBe("open Notepad");
    expect(politeStrip("Jarvis, tidy Downloads")).toBe("tidy Downloads");
    expect(politeStrip("please save it to D:\\tmp\\a.txt")).toBe("save it to D:\\tmp\\a.txt");
    // No leading softener: unchanged, including the colon in the path.
    expect(politeStrip("open Notepad, save to D:\\tmp\\a.txt")).toBe("open Notepad, save to D:\\tmp\\a.txt");
  });
});

describe("classifyTaskWithJevFallback — rules first, always", () => {
  test("a task the rules already resolve never calls Jev at all", async () => {
    let called = false;
    const request = (async () => { called = true; return json({}); }) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback("run the lead phone-finder", null, { key: "k", request });
    expect(plan).toMatchObject({ route: "cli" });
    expect(called).toBe(false);
  });

  test("no Jev key at all: stays on the rules' answer (hermes) with no network call", async () => {
    let called = false;
    const request = (async () => { called = true; return json({}); }) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback("tidy Downloads", null, null);
    expect(plan).toEqual({ route: "hermes" });
    expect(called).toBe(false);
  });
});

describe("classifyTaskWithJevFallback — the Jev fallback itself", () => {
  test("Jev's guess is only honoured once the SAME deterministic parser builds a real plan from a politeness-stripped retry", async () => {
    const request = (async () => json({ answers: { route: { choice: "screen", confidence: 0.9 } } })) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback(SCREEN_TASK, null, { key: "k", request });
    expect(plan).toEqual({
      route: "screen",
      steps: [
        { kind: "open", app: "Notepad" },
        { kind: "act", goal: "type hello from away mode" },
        { kind: "save", path: "D:\\tmp\\away-test\\notepad.txt" },
      ],
    });
  });

  test("a low-confidence Jev answer is ignored — the rules' hermes answer stands", async () => {
    const request = (async () => json({ answers: { route: { choice: "screen", confidence: 0.4 } } })) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback(SCREEN_TASK, null, { key: "k", request });
    expect(plan).toEqual({ route: "hermes" });
  });

  test("Jev saying hermes changes nothing", async () => {
    const request = (async () => json({ answers: { route: { choice: "hermes", confidence: 0.95 } } })) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback(SCREEN_TASK, null, { key: "k", request });
    expect(plan).toEqual({ route: "hermes" });
  });

  test("Jev naming a route the deterministic parser still can't build from falls back to hermes, never a guessed plan", async () => {
    // No leading politeness phrase to strip, and no verb parseScreenTask recognises — Jev's
    // confident label alone can never manufacture steps.
    const request = (async () => json({ answers: { route: { choice: "screen", confidence: 0.95 } } })) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback("figure out the best plan for the launch", null, { key: "k", request });
    expect(plan).toEqual({ route: "hermes" });
  });

  test("an HTTP error from Jev leaves the rules' answer untouched", async () => {
    const request = (async () => json({}, false)) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback(SCREEN_TASK, null, { key: "k", request });
    expect(plan).toEqual({ route: "hermes" });
  });

  test("a thrown/timed-out request leaves the rules' answer untouched", async () => {
    const request = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback(SCREEN_TASK, null, { key: "k", request });
    expect(plan).toEqual({ route: "hermes" });
  });

  test("an unrecognised choice string is ignored, not trusted blindly", async () => {
    const request = (async () => json({ answers: { route: { choice: "delete_everything", confidence: 0.99 } } })) as unknown as typeof fetch;
    const plan = await classifyTaskWithJevFallback(SCREEN_TASK, null, { key: "k", request });
    expect(plan).toEqual({ route: "hermes" });
  });

  test("the Jev request never carries file ops, a recipe or steps — only the task text and a route question", async () => {
    let sentBody: any = null;
    const request = (async (_url: string, init: any) => { sentBody = JSON.parse(init.body); return json({ answers: {} }); }) as unknown as typeof fetch;
    await classifyTaskWithJevFallback(SCREEN_TASK, null, { key: "k", request });
    expect(sentBody.questions.route.type).toBe("choice");
    expect(Object.keys(sentBody.questions)).toEqual(["route"]);
    expect(sentBody.state).toEqual({ task: SCREEN_TASK });
  });
});
