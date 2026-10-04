// Every migrated Jev call site goes through the one Jev client (scripts/jev-client.ts), so each
// decision leaves a router receipt. These call sites pass no sink of their own, so under `bun test`
// their receipts land in the in-memory `testReceipts` (scripts/model-router/defaults.ts). Fake
// transport only: nothing real is called.
import { describe, expect, test } from "bun:test";
import { JEV_MODEL, JEV_URL } from "./jev-client";
import { jevReflex } from "./jev";
import { askJev as askRouter } from "./jev-router";
import { judgeCommand, planHermesTask } from "./jev-hermes";
import { jevAsker } from "./leads/phone-finder";
import { classifyObjectionCues } from "./meeting-mode/objection-jev";
import { createSucceededAsk } from "./screen-hands/fuzzy-verify";
import { createControlAsk } from "./screen-hands/jev-control";
import { createPointMinds } from "./screen-hands/point";
import { createMinds } from "./screen-hands/index";
import { createLessonMinds } from "./screen-hands/lesson";
import { testReceipts } from "./model-router/defaults";
import type { UiElement } from "./screen-hands/plan";

/** A fake TypeSafe endpoint: checks the request is the client's, answers with `answers`. */
function jev(answers: Record<string, unknown>, status = 200) {
  const calls: { url: string; body: any }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 90, output_tokens: 0 } }), { status });
  }) as unknown as typeof fetch;
  return { calls, request };
}

/** Runs `run`, then returns the receipts it wrote (by caller prefix). */
async function receiptsOf(caller: string, run: () => Promise<unknown>) {
  const before = testReceipts.receipts.length;
  await run();
  return testReceipts.receipts.slice(before).filter((r) => r.caller.startsWith(caller));
}

const el = (id: number, name: string): UiElement => ({ id, type: "Button", x: 0, y: 0, w: 10, h: 10, password: false, enabled: true, focused: false, hasValue: false, readOnly: false, name, aid: "", help: "", value: "" });
const signal = () => new AbortController().signal;

describe("every Jev call site writes a router receipt", () => {
  test("voice reflex (scripts/jev.ts)", async () => {
    const fake = jev({ lane: { type: "choice", choice: "chat", confidence: 0.9 } });
    const got = await receiptsOf("scripts/jev.ts", () => jevReflex("tell me a joke", "k", fake.request));
    expect(fake.calls[0].url).toBe(JEV_URL);
    expect(fake.calls[0].body.model).toBe(JEV_MODEL);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ task: "jev.decision", caller: "scripts/jev.ts (voice.reflex)", provider: "typesafe", outcome: "succeeded", httpStatus: 200 });
  });

  test("a failed reflex is receipted with its status too", async () => {
    const got = await receiptsOf("scripts/jev.ts", () => jevReflex("open YouTube", "k", jev({}, 400).request));
    expect(got.map((r) => [r.outcome, r.httpStatus])).toContainEqual(["failed", 400]);
  });

  test("voice router (scripts/jev-router.ts), token counts kept", async () => {
    const fake = jev({ category: { type: "choice", choice: "brain", confidence: 0.9 } });
    let asked: Awaited<ReturnType<typeof askRouter>> = null;
    const got = await receiptsOf("scripts/jev-router.ts", async () => (asked = await askRouter("what's up", "k", { request: fake.request })));
    expect(asked).toMatchObject({ inputTokens: 90, outputTokens: 0 });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ task: "jev.decision", caller: "scripts/jev-router.ts (voice.router)", outcome: "succeeded" });
  });

  test("Hermes plan (jev.decision) and guardian (approval.guardian)", async () => {
    const plan = await receiptsOf("scripts/jev-hermes.ts", () => planHermesTask("open Notepad", { key: "k", request: jev({ effort: { choice: "low", confidence: 0.95 } }).request }));
    expect(plan[0]).toMatchObject({ task: "jev.decision", caller: "scripts/jev-hermes.ts (hermes.plan)" });
    const safe = { harmless: { noul: 0.97 }, destructive: { noul: 0.01 }, outbound: { noul: 0.01 }, manipulation: { noul: 0.01 } };
    const guard = await receiptsOf("scripts/jev-hermes.ts", () => judgeCommand("notepad.exe", "script execution", { key: "k", request: jev(safe).request }));
    expect(guard[0]).toMatchObject({ task: "approval.guardian", caller: "scripts/jev-hermes.ts (hermes.guardian)", outcome: "succeeded" });
  });

  test("lead phone finder", async () => {
    const got = await receiptsOf("scripts/leads/phone-finder.ts", () => jevAsker("k", jev({ manipulation: { noul: 0.01 } }).request)({ lead: "x" }, { manipulation: { type: "noul", instructions: "?" } }));
    expect(got[0]).toMatchObject({ caller: "scripts/leads/phone-finder.ts (leads.phone)", outcome: "succeeded" });
  });

  test("meeting objection cues", async () => {
    const input = { sessionId: "s", chunkId: "c1", capturedAt: new Date().toISOString(), speaker: "prospect" as const, text: "It's too expensive for us.", previousChunkText: "" };
    const got = await receiptsOf("scripts/meeting-mode/objection-jev.ts", () => classifyObjectionCues(input, { key: "k", request: jev({ price: { noul: 0.95 } }).request }));
    expect(got[0]).toMatchObject({ caller: "scripts/meeting-mode/objection-jev.ts (meeting.objection)", outcome: "succeeded" });
  });

  test("screen fuzzy verify, Jev control and the pointer", async () => {
    const fuzzy = await receiptsOf("scripts/screen-hands/fuzzy-verify.ts", () => createSucceededAsk({ key: () => "k", request: jev({ succeeded: { noul: 0.9 } }).request })({ intent: "turn on dark mode", app: "Settings", changes: "switched Dark mode (now on)" }, signal()));
    expect(fuzzy[0]).toMatchObject({ caller: "scripts/screen-hands/fuzzy-verify.ts (screen.verify)", outcome: "succeeded" });

    const control = await receiptsOf("scripts/screen-hands/jev-control.ts", () => createControlAsk({ key: () => "k", request: jev({ action: { choice: "done", confidence: 0.9 } }).request })({ model: JEV_MODEL, state: {}, questions: { action: { type: "choice", criteria: { done: "Complete" } } } }, signal()));
    expect(control[0]).toMatchObject({ caller: "scripts/screen-hands/jev-control.ts (screen.control)", outcome: "succeeded" });

    const minds = createPointMinds({ key: (n) => (n === "TYPESAFE_API_KEY" ? "k" : ""), request: jev({ control: { choice: "e3", confidence: 0.9 } }).request });
    let picked: unknown = null;
    const point = await receiptsOf("scripts/screen-hands/point.ts", async () => (picked = await minds.pick!({ request: "where's export", window: "Word", under: "", candidates: [{ id: 3, text: "Button Export PDF" }] }, signal())));
    expect(picked).toMatchObject({ id: 3, confidence: 0.9 });
    expect(point[0]).toMatchObject({ caller: "scripts/screen-hands/point.ts (screen.point)", outcome: "succeeded" });
  });

  test("a cancelled Jev control step still throws, as before", async () => {
    const controller = new AbortController();
    const hang = (async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const pending = createControlAsk({ key: () => "k", request: hang })({ model: JEV_MODEL, state: {}, questions: {} }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  test("screen hands: choose, step, fill and irreversible", async () => {
    const minds = (answers: Record<string, unknown>) => createMinds({ key: (n) => (n === "TYPESAFE_API_KEY" ? "k" : ""), request: jev(answers).request });
    const chosen = await receiptsOf("scripts/screen-hands/index.ts (screen.choose)", async () => {
      expect(await minds({ element: { choice: "e1", confidence: 0.9 } }).choose!("save", [el(1, "Open"), el(2, "Save")], signal())).toMatchObject({ id: 2 });
    });
    expect(chosen[0]).toMatchObject({ outcome: "succeeded" });
    const stepped = await receiptsOf("scripts/screen-hands/index.ts (screen.step)", async () => {
      const step = await minds({ op: { choice: "click", confidence: 0.9 }, target: { choice: "e7", confidence: 0.8 } }).step!({ goal: "save", window: "Notepad", focused: "", history: [], candidates: [{ id: 7, text: "Button Save" }] }, signal());
      expect(step).toMatchObject({ op: "click", id: 7 });
    });
    expect(stepped[0]).toMatchObject({ outcome: "succeeded" });
    const filled = await receiptsOf("scripts/screen-hands/index.ts (screen.fill)", async () => {
      const map = await minds({ f4: { choice: "email", confidence: 0.9 } }).fill!([{ id: 4, label: "Email" }], [{ key: "email", about: "his email address" }], { window: "Sign up" }, signal());
      expect(map?.get(4)).toEqual({ key: "email", confidence: 0.9 });
    });
    expect(filled[0]).toMatchObject({ outcome: "succeeded" });
    const irreversible = await receiptsOf("scripts/screen-hands/index.ts (screen.irreversible)", async () => {
      expect(await minds({ irreversible: { noul: 0.8 } }).irreversible!({ control: "Button", label: `Send receipt test ${Date.now()}`, app: "Mail" }, signal())).toBe(0.8);
    });
    expect(irreversible[0]).toMatchObject({ outcome: "succeeded" });
  });

  test("lesson: Jev picks the next control when Groq can't", async () => {
    const minds = createLessonMinds({ key: (n) => (n === "TYPESAFE_API_KEY" ? "k" : ""), request: jev({ next: { choice: "e9", confidence: 0.82 } }).request, hermes: null });
    const input = { goal: "change the font", window: "Notepad", elements: '4 MenuItem "File"\n9 Button "Settings"', focused: "nothing", history: [], guide: [], mode: "teach" as const };
    const got = await receiptsOf("scripts/screen-hands/lesson.ts", async () => expect(await minds.next(input, signal())).toEqual({ do: "click", id: 9 }));
    expect(got[0]).toMatchObject({ caller: "scripts/screen-hands/lesson.ts (screen.lesson)", outcome: "succeeded" });
  });
});
