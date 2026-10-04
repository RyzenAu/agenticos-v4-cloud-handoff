// Round 9: the owner's broken voice journey, each failure pinned (A–D, F, G, I–M). Every test failed on b526e0b6 and passes with the fix.
// SYNTHETIC throughout: fake Jev/brain over a fake fetch, synthetic computers (scripts/agents/test-rig.ts), a fake Windows desktop, an empty
// device registry for a server-role hub. No real device, account, model or network.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerAsTask, misheardApp, namedBot } from "../agents/named";
import { makeRig, type Rig } from "../agents/test-rig";
import { CANCELLED_LINE, clarifiesInstead, deviceAnswer, deviceQuestion, freeVoice, REASK_AGAIN, REASK_LINE } from "../free-voice";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { resolveTarget } from "../devices/route";
import { staticRegistry } from "../devices/registry";
import type { Principal } from "../identity/principal";
import { createCommandService } from "./service";
import { planRules } from "./plan";
import { createWindowsExecutors, type WindowsDeps, type WinInfo } from "../executors/windows";
import { actsOnNamedTarget, askGuess, labelNamedInGoal, type ControlDecision } from "../screen-hands/jev-control";
import { createScreenHands, parseScreenRequest, type Hands } from "../screen-hands/index";
import { FLAGS_OFF } from "../screen-hands/flags";

const BOTS = [{ id: "research", name: "Research" }, { id: "builder", name: "Builder" }];
const owner: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const ownerCaller = { id: "usman", name: "Usman", via: "tailnet", actor: "human" };
const dirs: string[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Call = { id: string; type: "function"; function: { name: string; arguments: string } };
type Reply = { content: string | null; tool_calls?: Call[]; model?: string };
/** The voice engine with no network: Jev answers `jevCategory` for every utterance; the brain records its request and says it was reached. */
function voice(opts: { jevCategory?: string; bots?: typeof BOTS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "r9-route-"));
  dirs.push(root);
  const brainBodies: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url.includes("typesafe")) return Response.json({ answers: { category: { choice: opts.jevCategory ?? "brain", confidence: opts.jevCategory ? 0.95 : 0.2 }, outbound: { noul: 0.01 }, complete: { noul: 0.95 } } });
    if (url.includes("/chat/completions")) {
      brainBodies.push(String(init?.body ?? ""));
      return Response.json({ choices: [{ message: { role: "assistant", content: "[brain]" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const v = freeVoice(root, {
    key: (n) => ({ GROQ_API_KEY: "g", TYPESAFE_API_KEY: "j" } as Record<string, string>)[n] ?? "",
    fetch: fetcher,
    sink: new MemoryReceiptSink(),
    health: new MemoryHealthStore(),
    bots: () => opts.bots ?? BOTS,
    hub: () => ({ name: "Ryzen-PC", role: "server" as const }),
    companions: () => [],
  });
  const turn = async (messages: unknown[], extra: Record<string, unknown> = { remote: true }) => (await v.handle("/voice/free/turn", { messages, ...extra }, ownerCaller)) as Reply;
  return { turn, brainBodies };
}
const user = (content: string) => ({ role: "user" as const, content });
/** A control_pc read-back waiting for his yes (what the live session's first turn left pending). */
const pendingControl = (task: string) => [
  user("Can you run a builder for me and open Chrome on it?"),
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "control_pc", arguments: JSON.stringify({ task }) } }] },
  { role: "tool", tool_call_id: "c1", content: `CONFIRMATION REQUIRED: ${task}` },
  { role: "assistant", content: `Shall I ${task}?` },
];
const commandArgs = (r: Reply) => (r.tool_calls?.[0]?.function.name === "jarvis_command" ? (JSON.parse(r.tool_calls[0].function.arguments) as { utterance: string; bot?: boolean }) : null);

describe("A. naming a bot routes the work to that bot", () => {
  test("the grammar: every way he named the Builder, and what is left of the words", () => {
    expect(namedBot("use the builder agent", BOTS)).toMatchObject({ bot: { id: "builder" }, kind: "bare" });
    expect(namedBot("So I want you to use the Builder Agent", BOTS)).toMatchObject({ bot: { id: "builder" }, kind: "bare" });
    expect(namedBot("tell the builder to open a Chrome tab", BOTS)).toMatchObject({ bot: { id: "builder" }, kind: "task", task: "open a Chrome tab" });
    expect(namedBot("builder, open Chrome", BOTS)).toMatchObject({ bot: { id: "builder" }, kind: "task", task: "open Chrome" });
    expect(namedBot("in my agents, have the builder open a Chrome tab", BOTS)).toMatchObject({ bot: { id: "builder" }, task: "open a Chrome tab" });
    expect(namedBot("Can you run a builder for me and open Chrome on it?", BOTS)).toMatchObject({ bot: { id: "builder" }, task: "open Chrome" });
    expect(namedBot("So why can't you launch the Builder?", BOTS)).toMatchObject({ bot: { id: "builder" }, kind: "bare" });
    // Unchanged: the old shapes, the task kept exactly as said.
    expect(namedBot("Ask Research to find the contact page.", BOTS)).toMatchObject({ bot: { id: "research" }, task: "find the contact page." });
    expect(namedBot("stop the research task", BOTS)).toMatchObject({ bot: { id: "research" }, kind: "stop" });
    // Not a bot: a plain request that happens to contain a bot's name.
    expect(namedBot("start research on dental clinics in Parramatta", BOTS)).toBeNull();
    expect(namedBot("open Chrome", BOTS)).toBeNull();
  });

  test("the voice rules send each one to the command path as the bot's request (never device control, the coding harness or the brain)", async () => {
    const v = voice();
    for (const words of ["use the builder agent", "tell the builder to open a Chrome tab", "builder, open Chrome", "in my agents, have the builder open a Chrome tab"]) {
      const r = await v.turn([user(words)]);
      expect({ words, args: commandArgs(r) }).toEqual({ words, args: { utterance: words, bot: true } });
    }
    expect(v.brainBodies).toHaveLength(0);
  });

  test("the command path runs it on the Builder's own computer, and a Builder with no usable computer says so with the fix", async () => {
    const rig = await makeRig({ role: "server" });
    rigs.push(rig);
    const b = rig.botCommands;
    const service = createCommandService({ jobs: () => rig.jobs, entry: () => null, hubDeviceId: "", role: () => "server", resolveTarget: (ctx) => resolveTarget(ctx, staticRegistry([])), delegates: { coding: rig.sharedCoding as never }, bots: { scope: b.scope, nameOf: b.nameOf, threadIds: b.threadIds, run: b.run }, graceMs: 50, dedupeMs: 0, threads: rig.threads });
    const run = (utterance: string) => service.run({ principal: owner, body: { utterance, source: "voice" } as never });
    const tab = await run("builder, open a Chrome tab");
    expect(tab).toMatchObject({ ok: true });
    expect(rig.started.at(-1)).toMatchObject({ computer: "builder", bot: "builder", title: "open a Chrome tab" });
    // Named with no task: where it stands, and a different wording the second time.
    await new Promise((r) => setTimeout(r, 30));
    const first = await run("use the builder agent");
    const second = await run("use the builder agent");
    expect(first.said).toMatch(/What should Builder do\?/);
    expect(second.said).toMatch(/What should Builder do\?/);
    expect(second.said).not.toBe(first.said);
    // The Builder's computer is off: said plainly, with where to start it. Nothing runs anywhere else.
    rig.views.set("builder", { ...rig.views.get("builder")!, state: "offline" });
    const before = rig.started.length;
    const off = await run("builder, open Chrome");
    expect(off.ok).toBe(false);
    expect(off.said).toMatch(/Start Builder's computer in Agents › Builder › Computer/);
    expect((await run("use the builder agent")).said).toMatch(/^Builder's computer is offline\. Start it in Agents › Builder › Computer/);
    expect(rig.started.length).toBe(before);
  });
});

describe("B/F. device control of his own PC with no companion", () => {
  test("'my PC' is his own device: with none registered it is 'no device', never 'none of your devices is called my PC'", () => {
    expect(resolveTarget({ personId: "usman", spokenTarget: "my PC" }, staticRegistry([]))).toEqual({ ok: false, reason: "no device registered for usman" });
    expect(resolveTarget({ personId: "usman", spokenTarget: "this pc" }, staticRegistry([]))).toEqual({ ok: false, reason: "no device registered for usman" });
    // A device of his with another name is still matched by name, as before.
    const laptop = { id: "lap", owner: "usman" as const, kind: "companion" as const, label: "Usman's laptop", aliases: ["laptop"] };
    expect(resolveTarget({ personId: "usman", spokenTarget: "my laptop" }, staticRegistry([laptop], () => 0)).ok).toBe(false); // offline (no heartbeat): never re-routed
  });

  test("one plain, actionable line, and a shorter one if asked again; the id-style reason never spoken", async () => {
    const rig = await makeRig({ role: "server" });
    rigs.push(rig);
    const b = rig.botCommands;
    const service = createCommandService({ jobs: () => rig.jobs, entry: () => null, hubDeviceId: "", role: () => "server", resolveTarget: (ctx) => resolveTarget(ctx, staticRegistry([])), bots: { scope: b.scope, nameOf: b.nameOf, threadIds: b.threadIds, run: b.run }, graceMs: 50, dedupeMs: 0 });
    const first = await service.run({ principal: owner, body: { utterance: "open Notepad on my PC", source: "voice" } as never });
    expect(first).toMatchObject({ ok: false, refused: true });
    expect(first.said).toMatch(/^Nothing ran\. The hub runs on a server with no screen of its own, and your PC has no companion paired/);
    expect(first.said).toMatch(/Code for a companion/);
    expect(first.said).toMatch(/Builder, open a Chrome tab/);
    expect(first.said).not.toMatch(/no device registered|none of your devices/);
    const again = await service.run({ principal: owner, body: { utterance: "open a Chrome tab on this PC", source: "voice" } as never });
    expect(again.said).toMatch(/^Still no companion on your PC/);
    expect(again.said).not.toBe(first.said);
    // The reason stays in the job's decision log.
    expect(rig.jobs.get(first.jobId!)?.steps.some((s) => /no device registered for usman/.test(s.intent ?? ""))).toBe(true);
  });

  test("a remote speaker's device skill (bring a window up, type) goes to the command path, never 'only works at the PC itself'", async () => {
    const v = voice();
    const r = await v.turn([user("bring up chrome")]);
    expect(commandArgs(r)).toEqual({ utterance: "bring up chrome" });
    // Round 10 (owner decision): at the hub Jev decides first and its decision stands. This synthetic Jev answers "brain" below its act
    // threshold, so the brain has it; the rules never replace Jev's decision, and it never becomes the remote command path.
    const local = await v.turn([user("bring up chrome")], { remote: false });
    expect(local.tool_calls?.[0]?.function.name).not.toBe("jarvis_command");
    expect(local.content).toBe("[brain]");
  });
});

describe("C/G. questions about the device and where the OS runs, from facts", () => {
  test("recognised: what device is this, which computer am I on, where is the OS running, I am at the PC", () => {
    expect(deviceQuestion("What device is this?")).toBe("device");
    expect(deviceQuestion("which computer am I on")).toBe("device");
    expect(deviceQuestion("Where is the agentic OS running?")).toBe("where");
    expect(deviceQuestion("where is the genetic OS running")).toBe("where");
    expect(deviceQuestion("I am at the PC.")).toBe("at-pc");
    expect(deviceQuestion("what's on my screen")).toBeNull();
    expect(deviceQuestion("open Chrome on this device")).toBeNull();
  });

  test("answered by rules even when Jev reads it as 'look at the screen', never the screen-sharing line", async () => {
    const v = voice({ jevCategory: "screen" });
    const r = await v.turn([user("What device is this?")], { remote: true, device: "Usman's desktop app" });
    expect(r.model).toBe("rules");
    expect(r.content).toBe(`You're on "Usman's desktop app", a client of the hub: Agentic OS runs on Ryzen-PC, the always-on server, and you reach it over Tailscale. This PC has no companion paired, so I can't control it from here yet: make a code in Profile, "Code for a companion", and pair it on this PC.`);
    const where = await v.turn([user("Where is the agentic OS running?")]);
    expect(where.content).toMatch(/^Agentic OS runs on Ryzen-PC, the always-on server\./);
    expect(where.content).not.toMatch(/cloud/i);
    // At the hub itself.
    expect(deviceAnswer("device", { hub: "Ryzen-PC", role: "server", remote: false, device: null, companions: null })).toBe("You're at Ryzen-PC, the always-on server, the hub itself: Agentic OS runs on this machine. It has no desktop of its own for me to drive.");
  });

  test("Jev's 'screen' for words that never ask to look goes to the brain, and the brain is told where things run", async () => {
    const v = voice({ jevCategory: "screen" });
    // Round 10: a founder not at the hub has every task decided by Jev in the command path (one call, full catalogue).
    expect(commandArgs(await v.turn([user("explain how the hub and my computer connect")]))).toEqual({ utterance: "explain how the hub and my computer connect" });
    // At the hub, Jev's "look" for words that never ask to look is the brain's, told where things run.
    const r = await v.turn([user("explain how the hub and my computer connect")], { remote: false });
    expect(r.tool_calls).toBeUndefined();
    expect(r.content).toBe("[brain]");
    expect(v.brainBodies.join("\n")).toMatch(/Agentic OS runs on Ryzen-PC \(hub role: server, a headless always-on Windows PC, not the cloud\)/);
    // A real look request still gets the screen tool.
    const look = await v.turn([user("can you see my screen")], { remote: false });
    expect(look.tool_calls?.[0]?.function.name).toBe("screen");
  });
});

describe("D. confirmation: a bot named, or words that say what he meant, are not a yes or a no", () => {
  test("'No, I want to use the builder agent' to a pending question → the Builder (not 'Okay, I've left it')", async () => {
    const v = voice();
    const r = await v.turn([...pendingControl("run a builder until Chrome opens on it"), user("No, I want to use the builder agent")]);
    expect(r.content).not.toBe(CANCELLED_LINE);
    expect(commandArgs(r)).toEqual({ utterance: "No, I want to use the builder agent", bot: true });
    // A plain no is still a no.
    expect((await v.turn([...pendingControl("open the downloads folder"), user("no")])).content).toBe(CANCELLED_LINE);
  });

  test("words that say what he meant ('Chrome, Chrome, Chrome tab') are routed as a new request, never asked yes/no again", async () => {
    expect(clarifiesInstead("Chrome, Chrome, Chrome tab")).toBe(true);
    expect(clarifiesInstead("A Chrome tab")).toBe(true);
    expect(clarifiesInstead("okay wait")).toBe(false);
    expect(clarifiesInstead("yes?")).toBe(false);
    const v = voice();
    const r = await v.turn([...pendingControl("start a crowd"), user("Chrome, Chrome, Chrome tab")]);
    expect(r.content ?? "").not.toMatch(/^I didn't hear a clear yes/);
    expect(r.content ?? "").not.toMatch(/same answer again/);
  });

  test("a hedge is asked about once, and the second ask is new words (the repeat guard never fires on a first clarification)", async () => {
    const v = voice();
    const first = await v.turn([...pendingControl("open the downloads folder"), user("okay wait")]);
    expect(first.content).toBe(`${REASK_LINE} Say yes to go ahead, or no to leave it.`);
    const second = await v.turn([...pendingControl("open the downloads folder"), user("okay wait"), { role: "assistant", content: first.content }, user("hmm, maybe")]);
    expect(second.content).toBe(REASK_AGAIN);
    expect(second.content).not.toMatch(/same answer again/);
  });

  test("a misheard target asks what was meant in plain words, and his answer goes to that bot", async () => {
    expect(misheardApp("start a crowd")).toEqual({ heard: "start a crowd", meant: "open Chrome" });
    expect(misheardApp("open notepad")).toBeNull();
    expect(misheardApp("open calendar")).toBeNull();
    expect(answerAsTask("Chrome, Chrome, Chrome tab")).toBe("open Chrome tab");
    expect(answerAsTask("A Chrome tab")).toBe("open A Chrome tab");
    const v = voice();
    const ask = `I heard "start a crowd" — did you mean "open Chrome"? Nothing ran. What should Builder do?`;
    const history = [user("tell it to start a crowd"), { role: "assistant", content: ask }];
    expect(commandArgs(await v.turn([...history, user("A Chrome tab")]))).toEqual({ utterance: "tell Builder to open A Chrome tab", bot: true });
    expect(commandArgs(await v.turn([...history, user("yes")]))).toEqual({ utterance: "tell Builder to open Chrome", bot: true });
    // "Tell it to …" right after he named the Builder.
    expect(commandArgs(await v.turn([user("use the builder agent"), { role: "assistant", content: "Builder is ready." }, user("Tell it to open Chrome")]))).toEqual({ utterance: "tell Builder to open Chrome", bot: true });
    // His own device is never the bot's.
    expect(commandArgs(await v.turn([...history, user("open a Chrome tab on my PC")]))?.bot).toBeUndefined();
    // A hesitation is not a task for the bot.
    for (const pause of ["let me think", "hold on", "um", "hmm, one second"]) expect({ pause, args: commandArgs(await v.turn([...history, user(pause)])) }).not.toMatchObject({ args: { bot: true } });
  });
});

describe("I/J/L. opening Chrome and a tab on his own PC", () => {
  test("'Can you open a Chrome tab (on this PC)?' is a new tab, not a vague window goal", () => {
    expect(planRules("Can you open a Chrome tab")).toMatchObject({ lane: "executor", executor: "app.open", args: { name: "chrome", newTab: true } });
    expect(planRules("open a browser tab")).toMatchObject({ executor: "app.open", args: { newTab: true } });
    expect(planRules("can you open chrome?")).toMatchObject({ executor: "app.open", args: { name: "chrome" } });
  });

  test("'bring up Chrome': its existing window in front is success, checked", async () => {
    expect(planRules("bring up chrome")).toMatchObject({ executor: "app.open", args: { name: "chrome", bringUp: true } });
    const wins: WinInfo[] = [{ handle: 1, process: "app", cls: "app", title: "Agentic OS" }, { handle: 2, process: "chrome", cls: "Chrome_WidgetWin_1", title: "New Tab - Google Chrome" }];
    let front = 1;
    const deps = {
      platform: "win32",
      roots: [],
      windows: async () => wins,
      foreground: async () => wins.find((w) => w.handle === front) ?? null,
      // Chrome's launcher hands over to the running Chrome: no new window, the existing one comes to the front.
      startApp: async () => void (front = 2),
      shellOpen: async () => undefined,
      focus: async () => true,
      keys: async () => undefined,
      typeText: async () => undefined,
      editorText: async () => null,
      runPs: async () => ({ code: 0, stdout: "", stderr: "" }),
      sleep: async () => undefined,
      timing: { appWaitMs: 5, pollMs: 1 },
    } satisfies WindowsDeps;
    const ex = createWindowsExecutors(deps);
    const brought = await ex["app.open"]({ name: "chrome", bringUp: true }, { signal: new AbortController().signal });
    expect(brought).toMatchObject({ ok: true, verified: true, said: "Chrome is in front." });
    front = 1;
    const opened = await ex["app.open"]({ name: "chrome" }, { signal: new AbortController().signal });
    expect(opened.verified).toBeNull(); // "open Chrome" still wants a NEW window to call it confirmed
  });

  test("the app he named is open but behind: its window is brought to the front and worked on, not 'Chrome isn't the window in front'", async () => {
    const log: string[] = [];
    const app = { handle: 1, process: "agentic-os", cls: "app", title: "Agentic OS" };
    const chrome = { handle: 2, process: "chrome", cls: "Chrome_WidgetWin_1", title: "New Tab - Google Chrome" };
    let front = app.handle;
    const hands: Hands = {
      foreground: async () => (front === chrome.handle ? chrome : app),
      windows: async () => [app, chrome],
      focus: async (h) => (log.push(`focus ${h}`), (front = h), true),
      snapshot: async () => ({ window: { x: 0, y: 0, w: 800, h: 600 }, elements: [], focused: null, browser: true }),
      focused: async () => null,
      at: async () => null,
      click: async () => void log.push("click"),
      type: async () => void log.push("type"),
      keys: async () => void log.push("keys"),
      wheel: async () => void log.push("wheel"),
      capture: async () => null,
    };
    const screen = createScreenHands({ key: () => "", hands, flags: () => ({ ...FLAGS_OFF }), audit: null, jarvisChrome: null });
    const done = await screen.act(parseScreenRequest({ goal: "click the new tab button in chrome" }), new AbortController().signal);
    expect(log).toContain("focus 2");
    expect(done.said).not.toMatch(/isn't the window in front/);
    // A window that is never driven (a bank) is never brought forward either: refused before any focus.
    log.length = 0;
    front = app.handle;
    chrome.title = "CommBank NetBank - Google Chrome";
    const bank = await screen.act(parseScreenRequest({ goal: "click the new tab button in chrome" }), new AbortController().signal);
    expect(log.filter((l) => l.startsWith("focus"))).toEqual([]);
    expect(bank).toMatchObject({ ok: false, refused: true });
  });
});

describe("opening a browser never needs agent-browser (owner feedback)", () => {
  test("every opening phrasing plans the plain open-app / open-url executor, never browser.navigate", () => {
    const plans = ["open a Chrome tab", "can you open a Chrome tab", "open a new tab", "open Chrome and create a new tab", "open Chrome", "bring up chrome", "open github.com", "open https://example.com", "go to example.org"].map((u) => ({ u, p: planRules(u) }));
    for (const { u, p } of plans) {
      expect({ u, lane: p?.lane }).toEqual({ u, lane: "executor" });
      expect({ u, ok: ["app.open", "open-url"].includes((p as { executor: string }).executor) }).toEqual({ u, ok: true });
    }
  });

  const desktop = (opts: { chrome: boolean }) => {
    const wins: WinInfo[] = [{ handle: 1, process: "chrome", cls: "Chrome_WidgetWin_1", title: "Inbox - Google Chrome" }, { handle: 2, process: "app", cls: "app", title: "Agentic OS" }];
    let front = 2;
    const launched: Array<{ exe: string; url?: string }> = [];
    const shell: string[] = [];
    const deps = {
      platform: "win32", roots: [], windows: async () => wins, foreground: async () => wins.find((w) => w.handle === front) ?? null,
      startApp: async (exe: string, o?: { url?: string }) => {
        if (!opts.chrome) throw new Error("This command cannot be run because the file cannot be found.");
        launched.push({ exe, ...(o?.url ? { url: o.url } : {}) });
        // Chrome hands the page to the window already open: a new tab there, and that window comes to the front.
        wins[0] = { ...wins[0], title: "New Tab - Google Chrome" };
        front = 1;
      },
      shellOpen: async (target: string) => void shell.push(target),
      focus: async () => true, keys: async () => undefined, typeText: async () => undefined, editorText: async () => null,
      runPs: async () => ({ code: 0, stdout: "", stderr: "" }), sleep: async () => undefined, timing: { appWaitMs: 5, pollMs: 1 },
    } satisfies WindowsDeps;
    return { ex: createWindowsExecutors(deps), launched, shell };
  };
  const signal = () => ({ signal: new AbortController().signal });

  test("a companion with no agent-browser opens the tab with Chrome's own launch (about:blank as a new tab)", async () => {
    const d = desktop({ chrome: true });
    const r = await d.ex["app.open"]({ name: "chrome", newTab: true }, signal());
    expect(r).toMatchObject({ ok: true, verified: true, said: "Opened a new Chrome tab." });
    expect(d.launched).toEqual([{ exe: "chrome.exe", url: "about:blank" }]);
    expect(d.shell).toEqual([]);
    const site = await d.ex["app.open"]({ name: "chrome", url: "https://example.com/" }, signal());
    expect(site).toMatchObject({ ok: true, said: "Opened example.com in Chrome." });
    // Only plain http(s) pages: anything else is refused before Windows is asked.
    expect(await d.ex["app.open"]({ name: "chrome", url: "file:///C:/x" }, signal())).toMatchObject({ ok: false, data: { refused: true } });
  });

  test("Chrome not installed: the default browser, said plainly", async () => {
    const d = desktop({ chrome: false });
    const r = await d.ex["app.open"]({ name: "chrome", newTab: true }, signal());
    expect(r).toMatchObject({ ok: true, verified: null });
    expect(r.said).toBe("Chrome isn't installed here, so I opened a page in your default browser instead.");
    expect(d.shell).toEqual(["https://www.google.com/"]);
  });
});

describe("K/M. the screen loop's guesses", () => {
  const d = (patch: Partial<ControlDecision>): ControlDecision => ({ op: "click", opConfidence: 0.5, target: null, targetConfidence: 0.3, text: null, textConfidence: 0, key: null, keyConfidence: 0, file: null, fileConfidence: 0, lastOk: null, complete: null, window: null, windowConfidence: 0, ...patch });
  test("a click on the control his words name (Mohammed ≈ Muhammad) is what he asked for", () => {
    expect(labelNamedInGoal("Click on the Mohammed Khan profile", 'button "Open Muhammad profile"')).toBe(true);
    expect(labelNamedInGoal("click on my profile", 'button "Open Muhammad profile"')).toBe(false);
    expect(labelNamedInGoal("click submit", 'button "Cancel"')).toBe(false);
    // Short words match exactly: spelling tolerance is for name-length words only.
    expect(labelNamedInGoal("click the older one", 'button "Order"')).toBe(false);
    expect(labelNamedInGoal("click the Usman profile", 'button "Open Osman profile"')).toBe(false);
    expect(labelNamedInGoal("click the Usman profile", 'button "Open Usman profile"')).toBe(true);
  });
  test("a named control acts only with at least minimal confidence", () => {
    const target = { id: 4, text: 'button "Open Muhammad profile"' } as never;
    expect(actsOnNamedTarget(d({ target }), 0.35, "Click on the Mohammed Khan profile")).toBe(true);
    expect(actsOnNamedTarget(d({ target }), 0.2, "Click on the Mohammed Khan profile")).toBe(false);
    expect(actsOnNamedTarget(d({ op: "type", target }), 0.5, "Click on the Mohammed Khan profile")).toBe(false);
  });
  test("never an empty guess", () => {
    expect(askGuess(d({ target: null }), 0.3)).toBe("");
    expect(askGuess(d({ target: { id: 4, text: 'button "Open Muhammad profile"' } as never }), 0.3)).toMatch(/^ My best guess was to click button "Open Muhammad profile"\.$/);
  });
});
