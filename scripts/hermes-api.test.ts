import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jarvisTaskPrompt } from "../src/lib/jarvis-control";
import { HERMES_API, HermesApiUnavailable, WARM_PROMPT, resetHermesWarm, runWarmTask, warmHermes } from "./hermes-api";

// A throwaway Hermes home with a fake API_SERVER_KEY: the real one is never read by tests.
let home = "";
let previous: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  writeFileSync(join(home, ".env"), "API_SERVER_KEY=test-key\n");
  previous = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
});
afterAll(() => {
  if (previous === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

const hermes = (sent: any[], status = 200) =>
  (async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Notepad is open, sir." } }] }), { status, headers: { "X-Hermes-Session-Id": "api-abc123" } });
  }) as unknown as typeof fetch;

describe("warm Hermes with a Jev plan", () => {
  test("a Jarvis task gets Jev's reasoning effort as model_options", async () => {
    const sent: any[] = [];
    const planned: string[] = [];
    const result = await runWarmTask(jarvisTaskPrompt("open Notepad"), {
      request: hermes(sent),
      plan: async (task) => (planned.push(task), { effort: "low", toolsets: ["terminal", "file"], confidence: 1, ms: 5 }),
    });
    expect(planned).toEqual(["open Notepad"]);
    expect(sent[0].url).toBe(`${HERMES_API}/v1/chat/completions`);
    expect(sent[0].body.model_options).toEqual({ reasoning: { effort: "low" } });
    expect(result).toMatchObject({ text: "Notepad is open, sir.", sessionId: "api-abc123", plan: { effort: "low" } });
  });
  test("no plan, a failed plan or a non-Jarvis prompt leaves the request as it was", async () => {
    const sent: any[] = [];
    await runWarmTask(jarvisTaskPrompt("tidy my desktop"), { request: hermes(sent), plan: async () => ({ toolsets: [], confidence: 0.4, ms: 1 }) });
    await runWarmTask(jarvisTaskPrompt("tidy my desktop"), { request: hermes(sent), plan: async () => { throw new Error("jev down"); } });
    await runWarmTask("Summarise this chat", { request: hermes(sent), plan: async () => { throw new Error("must not be called"); } });
    await runWarmTask(jarvisTaskPrompt("open Notepad"), { request: hermes(sent), plan: null });
    for (const request of sent) expect(request.body.model_options).toBeUndefined();
  });
  test("an unreachable API server carries the plan for the CLI fallback's toolsets", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const error = await runWarmTask(jarvisTaskPrompt("open Notepad"), { request: down, plan: async () => ({ toolsets: ["terminal", "file"], confidence: 1, ms: 1 }) }).catch((e) => e);
    expect(error).toBeInstanceOf(HermesApiUnavailable);
    expect(error.plan).toMatchObject({ toolsets: ["terminal", "file"] });
  });
});

describe("warming Hermes when the voice panel opens", () => {
  test("one tiny low-effort turn, then nothing for five minutes (a real task counts too)", async () => {
    resetHermesWarm();
    const sent: any[] = [];
    let now = 1_000_000;
    const first = await warmHermes({ request: hermes(sent), now: () => now });
    expect(first.warmed).toBe(true);
    expect(sent[0].body.messages[0].content).toBe(WARM_PROMPT);
    expect(sent[0].body.model_options).toEqual({ reasoning: { effort: "low" } });
    now += 60_000;
    expect((await warmHermes({ request: hermes(sent), now: () => now })).warmed).toBe(false);
    now += 5 * 60_000;
    expect((await warmHermes({ request: hermes(sent), now: () => now })).warmed).toBe(true);
    expect(sent).toHaveLength(2);
    resetHermesWarm();
    await runWarmTask(jarvisTaskPrompt("open Notepad"), { request: hermes(sent), plan: null });
    expect((await warmHermes({ request: hermes(sent) })).reason).toBe("recently warm");
  });
  test("no API key, no warm-up", async () => {
    resetHermesWarm();
    expect(await warmHermes({ key: "", request: hermes([]) })).toEqual({ warmed: false, reason: "not configured" });
  });
});