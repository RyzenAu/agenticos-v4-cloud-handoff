import { expect, test } from "bun:test";
import { createAgentBrowserHands, type AbRun } from "./agent-browser";
import { browserSearchFollowUp, protocolFollowUp, emptyActionAcknowledgement } from "../free-voice";
import { freeVoice } from "../free-voice";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrowserSkill } from "./browser-skill";
import { pcIntent } from "../pc-hands";

test("starting an installed AI app does not disappear into its website alias", () => {
  const apps = [{name: "Claude", id: "synthetic-claude"}];
  expect(pcIntent("Hey Jarvis, can you start Claude?", apps)).toEqual({action: "open_app", target: "Claude"});
  expect(pcIntent("Open the Claude app", apps)).toEqual({action: "open_app", target: "Claude"});
  expect(pcIntent("Open Claude", apps)).toBeNull();
  expect(pcIntent("Start Claude", [])).toBeNull();
  expect(pcIntent("Start Claude and send a message", apps)).toBeNull();
});

const tab = (id: string, url = "chrome://newtab/") => ({ targetId: id, url });
test("bare acknowledgements cannot finish action requests, but ordinary questions stay conversational", () => {
  for (const said of ["All set, sir.", "At your service, sir.", "Done."]) {
    expect(emptyActionAcknowledgement("Hey Jarvis, can you start Claude?", said)).toBe(true);
    expect(emptyActionAcknowledgement("Can you explain Chrome tabs?", said)).toBe(false);
  }
  expect(emptyActionAcknowledgement("Open Claude", "Which Claude app do you mean?")).toBe(false);
  expect(emptyActionAcknowledgement("Open Claude", "I couldn't open Claude.")).toBe(false);
});
test("a model's empty completion retries once and cannot claim success if no tool is produced", async () => {
  const root = mkdtempSync(join(tmpdir(), "mu-empty-action-"));
  const choices: string[] = [];
  try {
    const voice = freeVoice(root, {
      key: (name) => name === "GROQ_API_KEY" ? "synthetic-key" : "",
      fetch: (async (_url, init) => {
        choices.push(JSON.parse(String(init?.body)).tool_choice);
        return new Response(JSON.stringify({ choices: [{ message: { content: "All set, sir." } }] }), { headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    const result: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: "Can you run a UV unwrap in Blender?" }] });
    expect(choices).toEqual(["auto", "required"]);
    expect(result.content).toContain("I haven't carried that out");
    expect(result.tool_calls).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function rig(before: unknown, after: unknown) {
  let reads = 0, opens = 0;
  const run: AbRun = async (args) => {
    const command = args.slice(4, -1);
    if (command[1] === "new") { opens++; return { code: 1, stdout: JSON.stringify({ success: false, error: "Operation timed out." }), stderr: "" }; }
    const tabs = reads++ === 0 ? before : after;
    return { code: 0, stdout: JSON.stringify({ success: tabs !== null, data: { tabs } }), stderr: "" };
  };
  return { hands: createAgentBrowserHands({ run }), count: () => opens };
}
test("a timeout can confirm one new tab without repeating the navigation", async () => {
  const r = rig([tab("old")], [tab("old"), tab("new")]);
  expect(await r.hands.open("chrome://newtab/")).toMatchObject({ ok: true, targetId: "new" });
  expect(r.count()).toBe(1);
});

test("browser readiness is checked before navigation, including generic timeout failures", async () => {
  const r = rig([], []);
  const said = await runBrowserSkill({ skill: "browser", action: "new_tab" }, { hands: r.hands, ensure: async () => false, present: async () => null });
  expect(said).toContain("couldn't connect to Jarvis Chrome");
  expect(r.count()).toBe(0);
});
test("old tabs, missing snapshots, other URLs and multiple candidates never become false success", async () => {
  for (const [before, after] of [[ [tab("old")], [tab("old")] ], [null, [tab("new")]], [[], [tab("new", "https://example.test/")]], [[], [tab("a"), tab("b")]]]) {
    const r = rig(before, after);
    const result = await r.hands.open("chrome://newtab/");
    expect(result.ok).toBe(false);
    expect(result.said).toContain("couldn't confirm");
    expect(r.count()).toBe(1);
  }
});
test("PC and browser outcomes are spoken verbatim, including failures", () => {
  for (const name of ["pc_act", "browser_act"]) for (const content of ["Done: Claude is opening.", "Not done: Chrome did not respond."]) {
    expect(protocolFollowUp([
      { role: "user", content: "Start Claude" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name, arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content },
    ])).toBe(content);
  }
});

test("first-result continuation requires an explicit request and a successful matching search result", () => {
  const history = (firstResult: boolean, content: string): any[] => [
    { role: "user", content: "Search Google for dentists and open the first result" },
    { role: "assistant", tool_calls: [{ id: "s", function: { name: "skill", arguments: JSON.stringify({ skill: "browser", action: "search", query: "dentists", firstResult }) } }] },
    { role: "tool", tool_call_id: "s", content },
  ];
  const success = 'Searched Google for "dentists" in Chrome on your main screen.';
  expect(browserSearchFollowUp(history(true, success))?.goal).toContain("excluding sponsored results");
  expect(browserSearchFollowUp(history(false, success))).toBeNull();
  expect(browserSearchFollowUp(history(true, "Chrome took too long to respond."))).toBeNull();
  expect(browserSearchFollowUp([...history(true, success), { role: "user", content: "Stop" }])).toBeNull();
  const mismatched = history(true, success); mismatched[2].tool_call_id = "other";
  expect(browserSearchFollowUp(mismatched)).toBeNull();
});

test("the real voice turn continues a successful search once, then reports the screen outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "mu-navigation-flow-"));
  try {
    const voice = freeVoice(root, { key: () => "", fetch: (async () => { throw Error("No model should be called"); }) as typeof fetch });
    const messages: any[] = [{ role: "user", content: "Search Google for dentists and open the first result" }];
    const first: any = await voice.handle("/voice/free/turn", { messages });
    expect(first.tool_calls[0].function.name).toBe("skill");
    messages.push({ role: "assistant", content: null, tool_calls: first.tool_calls }, { role: "tool", tool_call_id: first.tool_calls[0].id, content: 'Searched Google for "dentists" in Chrome on your main screen.' });
    const next: any = await voice.handle("/voice/free/turn", { messages });
    expect(next.tool_calls[0].function.name).toBe("screen_act");
    expect(JSON.parse(next.tool_calls[0].function.arguments).goal).toContain("Check the destination loaded");
    messages.push({ role: "assistant", content: null, tool_calls: next.tool_calls }, { role: "tool", tool_call_id: next.tool_calls[0].id, content: "Opened the first result and checked its page title." });
    const done: any = await voice.handle("/voice/free/turn", { messages });
    expect(done.content).toBe("Opened the first result and checked its page title.");
    expect(done.tool_calls).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
