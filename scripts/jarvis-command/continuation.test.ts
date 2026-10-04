import { expect, test } from "bun:test";
import { planContinuation, taskClauses } from "./continuation";
import { createJarvisEntry, type EntryDeps } from "../jev-command";
import { stubResolveTarget } from "../jev-target";
import { createRunLog } from "../screen-hands/run-log";
import type { ScreenRequest, ScreenDone } from "../screen-hands/index";
import { parseGoal } from "../screen-hands/plan";
import { commandResultText } from "../../src/lib/jarvis-command";
import { confirmAnswer } from "../free-voice";

function rig(over: Partial<EntryDeps> = {}) {
  const runs = createRunLog();
  const screen: ScreenRequest[] = [],
    setup: string[] = [];
  const entry = createJarvisEntry({
    screen: {
      runs,
      act: async (req) => {
        screen.push(req);
        return {
          type: "done",
          ok: true,
          said: "Pressed ctrl+a.",
          steps: 1,
          ms: 1,
          stepMs: [1],
        } as ScreenDone;
      },
    },
    resolver: { resolve: stubResolveTarget, source: "stub" },
    jevKey: () => "",
    front: async () => ({ process: "notepad", title: "Untitled - Notepad", handle: 42 }),
    browser: async () => null,
    summarise: null,
    files: { open: async () => {}, titles: async () => [] },
    openApp: async (name) => ({ ok: true, said: `Opened ${name}.` }),
    notepad: async (text) => {
      setup.push(text);
      return { ok: true, verified: true, said: "Typed the requested line." };
    },
    ...over,
  });
  return { entry, screen, setup, runs };
}

test("quoted dictation and URLs never turn into extra task clauses", () => {
  expect(taskClauses('open Notepad and type "hello then click Submit" then press ctrl+a')).toEqual([
    "open Notepad",
    'type "hello then click Submit"',
    "press ctrl+a",
  ]);
  const p = planContinuation('Open Notepad and type "hello then click Submit" then press ctrl+a');
  expect(p?.setup).toMatchObject({
    executor: "notepad.type",
    args: { text: "hello then click Submit" },
  });
  expect(p?.remaining).toBe("press ctrl+a");
  expect(
    planContinuation("open https://example.test/?q=then%20click and click Contact then scroll down")
      ?.remaining,
  ).toBe("click Contact then scroll down");
});

test("existing exact dictation stays with its verified executor and quoted screen text stays literal", () => {
  expect(planContinuation('open Notepad and type "hello then click Submit"')).toBeNull();
  const longLiteral = "a".repeat(210) + " then click Submit";
  expect(parseGoal(`type "${longLiteral}" then press Tab`)).toEqual([
    { do: "type", text: longLiteral },
    { do: "key", keys: "tab", label: "tab" },
  ]);
  expect(parseGoal('click Name then type "hello then click Submit" then press Tab')).toEqual([
    { do: "click", target: "Name" },
    { do: "type", text: "hello then click Submit" },
    { do: "key", keys: "tab", label: "tab" },
  ]);
});

test("unknown specialist work and oversized tasks stay whole and do not become partial execution", () => {
  for (const text of [
    "open Notepad and type hello then email it to Bob",
    "open Paint then ask an agent to publish it",
    "open Paint then " + Array(9).fill("click Next").join(" then "),
  ])
    expect(planContinuation(text)).toBeNull();
});

test("verified setup and remaining actions share one run, and the whole request is not replayed", async () => {
  const r = rig();
  const done = await r.entry.handle(
    { utterance: 'open Notepad and type "hello" then press ctrl+a' },
    new AbortController().signal,
  );
  expect(done).toMatchObject({ ok: true, kind: "screen", verified: true });
  expect(r.setup).toEqual(["hello"]);
  expect(r.screen).toHaveLength(1);
  expect(r.screen[0]).toMatchObject({ goal: "press ctrl+a", jev: true, requireSpokenYes: true });
  expect(r.runs.list()).toHaveLength(1);
});

test("uncertain setup and cancellation never launch later actions", async () => {
  const controller = new AbortController();
  for (const verified of [false, null]) {
    const r = rig({
      notepad: async () => ({ ok: true, verified, said: "No read-back available." }),
    });
    expect(
      await r.entry.handle(
        { utterance: 'open Notepad and type "hello" then press ctrl+a' },
        controller.signal,
      ),
    ).toMatchObject({ ok: false, outcome: "unverified" });
    expect(r.screen).toHaveLength(0);
  }
  const r = rig({
    notepad: async () => {
      controller.abort();
      return { ok: true, verified: true, said: "Typed." };
    },
  });
  expect(
    await r.entry.handle(
      { utterance: 'open Notepad and type "hello" then press ctrl+a' },
      controller.signal,
    ),
  ).toMatchObject({ ok: false, stopped: true });
  expect(r.screen).toHaveLength(0);
});

test("secret requests are refused before the opening step", async () => {
  const r = rig();
  expect(
    await r.entry.handle(
      { utterance: 'open Notepad and type "hello" then type my password' },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, refused: true });
  expect(r.setup).toHaveLength(0);
  expect(r.screen).toHaveLength(0);
});

test("an approval resumes the unfinished goal, not the original opening request", async () => {
  const r = rig({
    screen: {
      runs: createRunLog(),
      act: async () => ({
        type: "done",
        ok: false,
        ask: true,
        confirm: "Submit",
        said: "Shall I press Submit?",
        steps: 1,
        ms: 1,
        stepMs: [1],
      }),
    },
  });
  const original = 'open Notepad and type "hello" then click Submit';
  const done = await r.entry.handle({ utterance: original }, new AbortController().signal);
  expect(done).toMatchObject({
    ok: false,
    ask: true,
    confirm: "Submit",
    resumeGoal: "click Submit",
  });
  const result = commandResultText({ ...done, jobId: "synthetic-job", targetDeviceId: "usman-pc" });
  const answer = confirmAnswer([
    { role: "user", content: original },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c",
          type: "function",
          function: { name: "jarvis_command", arguments: JSON.stringify({ utterance: original }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "c", content: result },
    { role: "assistant", content: done.said },
    { role: "user", content: "yes" },
  ]);
  expect(JSON.parse(answer!.call!.function.arguments)).toEqual({
    goal: "click Submit",
    confirmed: true,
  });
  expect(r.setup).toEqual(["hello"]);
});

test("the wrong foreground app stops the task after setup instead of typing into it", async () => {
  const r = rig({
    front: async () => ({ process: "chrome", title: "Synthetic unrelated page", handle: 11 }),
  });
  const done = await r.entry.handle(
    { utterance: 'open Notepad and type "hello" then press ctrl+a' },
    new AbortController().signal,
  );
  expect(done).toMatchObject({ ok: false, outcome: "unverified" });
  expect(r.screen).toHaveLength(0);
});
test("installed Claude uses verified app opening even when Jev is unavailable", async () => {
  const opened: string[] = [];
  const r = rig({
    apps: () => [{ name: "Claude", id: "synthetic-app" }],
    openApp: async (name) => {
      opened.push(name);
      return { ok: true, said: "Opened Claude.", checkedAt: 123 };
    },
  });
  expect(
    await r.entry.handle({ utterance: "open Claude app" }, new AbortController().signal),
  ).toMatchObject({ ok: true, kind: "app", verified: true, checkedAt: 123 });
  expect(opened).toEqual(["Claude"]);
});
