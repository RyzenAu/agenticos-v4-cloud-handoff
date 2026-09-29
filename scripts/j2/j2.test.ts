// J2: Jev routes, agent-browser is the hands, fixed commands do windows and apps. The 20 everyday commands, both of the
// owner's live transcripts and the safety gates, through the REAL router (freeVoice's turn, and guardToolCall for what
// Jev or the brain picks) and the REAL skills, with a CDP stub in place of Chrome and a fake PsHost in place of Windows.
// SYNTHETIC: no model, no network, no real window, no real browser.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice, guardToolCall } from "../free-voice";
import { createJarvisSkills } from "../jarvis-skills";
import { forgetReferent } from "../jarvis-skills/referent";
import { createAgentBrowserHands, minimalEnv, spawnRunner, type AbRun } from "./agent-browser";
import { fakeWindows, JARVIS_CHROME_PID, LEFT, MAIN } from "./fake-windows";
import { browserSkillIntent, catalogueSite } from "./intents";

const dirs: string[] = [];
afterEach(() => {
  forgetReferent();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "j2-"));
  dirs.push(d);
  return d;
};

// --- a CDP stub: the agent-browser CLI's answers over a few pages ----------------------------------------------------
// A control: `name` is the accessible name the snapshot shows (aria-label wins); the rest are what the page really carries.
type StubControl = { role: string; name: string; text?: string; aria?: string; title?: string; value?: string };
type StubPage = { title: string; text: string; controls?: StubControl[] };
const HOME: StubPage = {
  title: "M&U Ventures | Websites and automation",
  text: "M&U Ventures builds websites and automation for Australian small businesses. We start with a free preview. Ask us anything.",
  controls: [{ role: "link", name: "Contact" }, { role: "link", name: "Pricing" }, { role: "button", name: "Send message" }, { role: "button", name: "Pay now" }],
};
function cdpStub(pages: Record<string, StubPage> = {}, options: { failAttr?: boolean } = {}) {
  type Tab = { tabId: string; targetId: string; title: string; url: string; type: "page"; history: string[] };
  const tabs: Tab[] = [{ tabId: "t1", targetId: "T1", title: "New Tab", url: "chrome://newtab/", type: "page", history: ["chrome://newtab/"] }];
  let active = 0;
  let n = 1;
  const log: string[] = [];
  const clicked: string[] = [];
  const filled: string[] = [];
  const pageOf = (url: string): StubPage => pages[url] ?? (url.includes("muventures.com.au") && !url.includes("bianca") ? HOME : { title: `${new URL(url.startsWith("http") ? url : "https://x.test/").hostname}`, text: `The page at ${url}.`, controls: [] });
  const go = (t: Tab, url: string) => {
    t.url = url;
    t.title = url.startsWith("http") ? pageOf(url).title : "New Tab";
    t.history.push(url);
  };
  const tabsView = () => tabs.map((t, i) => ({ tabId: t.tabId, targetId: t.targetId, title: t.title, url: t.url, type: "page", active: i === active }));
  const run: AbRun = async (argv) => {
    const cmd = argv.slice(4).filter((a) => a !== "--json");
    const ok = (data: unknown = {}) => ({ code: 0, stdout: JSON.stringify({ success: true, data, error: null }) + "\n", stderr: "" });
    const bad = (error: string) => ({ code: 1, stdout: JSON.stringify({ success: false, data: null, error }) + "\n", stderr: "" });
    log.push(cmd.join(" "));
    const tab = tabs[active];
    const page = pageOf(tab.url);
    const [c, sub, arg] = cmd;
    if (c === "tab") {
      if (!sub) return ok({ tabs: tabsView() });
      if (sub === "new") {
        const t: Tab = { tabId: `t${++n}`, targetId: `T${n}`, title: "New Tab", url: "about:blank", type: "page", history: ["about:blank"] };
        tabs.push(t);
        active = tabs.length - 1;
        if (arg) go(t, arg);
        return ok({ tabId: t.tabId, targetId: t.targetId, url: t.url, total: tabs.length });
      }
      if (sub === "close") {
        if (tabs.length === 1) return bad("Cannot close the last tab");
        tabs.splice(active, 1);
        active = Math.min(active, tabs.length - 1);
        return ok({});
      }
      const i = tabs.findIndex((t) => t.tabId === sub || t.targetId === sub);
      if (i < 0) return bad(`No tab ${sub}`);
      active = i;
      return ok({ tabId: tabs[i].tabId, targetId: tabs[i].targetId, url: tabs[i].url });
    }
    if (c === "open") return go(tab, sub), ok({ url: sub });
    if (c === "back") {
      if (tab.history.length < 2) return bad("No previous page");
      tab.history.pop();
      tab.url = tab.history[tab.history.length - 1];
      return ok({ url: tab.url });
    }
    if (c === "forward" || c === "reload") return ok({ url: tab.url });
    if (c === "scroll") return ok({ scrolled: true });
    if (c === "get" && sub === "title") return ok({ title: page.title });
    if (c === "get" && sub === "url") return ok({ url: tab.url });
    const control = (ref: string) => (page.controls ?? [])[Number(ref.replace("@e", "")) - 1];
    if (c === "get" && sub === "text" && String(arg).startsWith("@e")) {
      const ctl = control(arg);
      return ctl ? ok({ text: ctl.text ?? ctl.name }) : bad("Element not found");
    }
    if (c === "get" && sub === "attr") {
      if (options.failAttr) return bad("Element not found");
      const ctl = control(sub === "attr" ? cmd[2] : "");
      const key = cmd[3] === "aria-label" ? "aria" : cmd[3];
      return ctl ? ok({ value: (ctl as Record<string, string | undefined>)[key] ?? null }) : bad("Element not found");
    }
    if (c === "get" && sub === "text") return ok({ text: page.text });
    if (c === "snapshot") {
      const refs: Record<string, { role: string; name: string }> = {};
      (page.controls ?? []).forEach((ctl, i) => (refs[`e${i + 1}`] = ctl));
      return ok({ refs, snapshot: Object.entries(refs).map(([r, v]) => `- ${v.role} "${v.name}" [ref=${r}]`).join("\n") });
    }
    if (c === "eval") return ok({ result: { title: page.title, url: tab.url, text: `${page.title}\n${page.text}`, nearby: "", controls: (page.controls ?? []).map((x) => x.name).join("\n"), embeds: false, progress: false } });
    if (c === "click") {
      clicked.push(sub);
      return ok({ clicked: sub });
    }
    if (c === "fill") {
      filled.push(`${sub}=${arg}`);
      return ok({});
    }
    return bad(`unknown command ${c}`);
  };
  return { run, tabs, log, clicked, filled, active: () => tabs[active], get count() { return tabs.length; } };
}

/** The real skills, wired to a CDP stub and a fake Windows. */
function rig(pages: Record<string, StubPage> = {}, windows = fakeWindows(), stubOptions: { failAttr?: boolean } = {}) {
  const cdp = cdpStub(pages, stubOptions);
  const hands = createAgentBrowserHands({ run: cdp.run, port: 9222 });
  const launched: string[] = [];
  const skills = createJarvisSkills(temp(), {
    events: { submit: () => undefined },
    now: () => Date.UTC(2026, 8, 29),
    ps: windows.ps,
    vault: () => null,
    browser: { hands, ensure: async () => false },
    windows: {
      launch: async (a) => (launched.push(a), `${a} is opening.`),
      jarvisChromePid: async () => JARVIS_CHROME_PID,
      activateTab: async (id) => hands.activate(id),
    },
  });
  /** Run one tool call the router produced, the way the client does: a `skill` call goes to the skills. */
  const run = async (call: { name: string; args: Record<string, unknown> }) => {
    expect(call.name).toBe("skill");
    return skills.run(call.args);
  };
  return { cdp, hands, windows, skills, run, launched };
}

// --- the voice turn -------------------------------------------------------------------------------------------------
type Msg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
/** A brain that ALWAYS reaches for the screen hands (the worst case the owner saw): if the rules let it through, it shows. */
function voice(options: { inFront?: () => Promise<boolean>; jev?: (utterance: string) => Record<string, unknown> | null } = {}) {
  const calls: string[] = [];
  const v = freeVoice(temp(), {
    key: (name: string) => ({ GROQ_API_KEY: "synthetic", TYPESAFE_API_KEY: options.jev ? "synthetic" : "" } as Record<string, string>)[name] ?? "",
    jarvisChromeInFront: options.inFront ?? (async () => true),
    fetch: (async (url: string, init: any) => {
      if (String(url).includes("typesafe")) {
        calls.push("jev");
        const said = JSON.parse(init.body)?.input ?? JSON.stringify(init.body);
        const answers = options.jev?.(String(said));
        return new Response(JSON.stringify({ answers: answers ?? { category: { choice: "brain", confidence: 0.95 } } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      calls.push("brain");
      const message = { content: null, tool_calls: [{ id: "b1", type: "function", function: { name: "screen_act", arguments: JSON.stringify({ goal: "explore" }) } }] };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const turn = async (words: string | Msg[]) => {
    const r: any = await v.handle("/voice/free/turn", { messages: typeof words === "string" ? [{ role: "user", content: words }] : words });
    const fn = r?.tool_calls?.[0]?.function as { name: string; arguments: string } | undefined;
    return { model: r.model as string, name: fn?.name, args: fn ? (JSON.parse(fn.arguments || "{}") as Record<string, unknown>) : {}, content: r.content as string | null, raw: r };
  };
  return { v, turn, calls };
}

describe("the 20 everyday commands, through the real router (no brain, no Hermes)", () => {
  const OWN = "https://muventures.com.au/";
  // words → [tool, args]. Every one is decided by rules: the brain (which here always says screen_act) is never asked.
  const TABLE: Array<[number, string, string, Record<string, unknown> | "any"]> = [
    [1, "open Chrome", "skill", { skill: "browser", action: "open_chrome" }],
    [2, "bring up Chrome", "skill", { skill: "window", action: "bring", target: "chrome", screen: "main" }],
    [2, "bring it up", "skill", { skill: "window", action: "bring", target: "front", screen: "main" }],
    [2, "put it on my main screen", "skill", { skill: "window", action: "move", target: "front", screen: "main" }],
    [3, "go to our website", "skill", { skill: "browser", action: "open", url: OWN, name: "muventures.com.au" }],
    [3, "open MU Ventures website", "skill", { skill: "browser", action: "open", url: OWN, name: "muventures.com.au" }],
    [4, "open a new tab", "skill", { skill: "browser", action: "new_tab" }],
    [5, "search Google for best dentist in Sydney", "skill", { skill: "browser", action: "search", engine: "google", query: "best dentist in sydney" }],
    [6, "open my Gmail", "skill", { skill: "browser", action: "open", url: "https://mail.google.com/", name: "Gmail" }],
    [7, "open YouTube and search lo-fi beats", "skill", { skill: "browser", action: "search", engine: "youtube", query: "lo-fi beats" }],
    [8, "open the Bianca site", "skill", { skill: "browser", action: "open", url: "https://bianca.muventures.com.au/", name: "Bianca Brown Realty" }],
    [9, "go back", "skill", { skill: "browser", action: "back" }],
    [9, "refresh", "skill", { skill: "browser", action: "reload" }],
    [9, "close this tab", "skill", { skill: "browser", action: "close_tab" }],
    [10, "scroll down", "skill", { skill: "browser", action: "scroll", dir: "down" }],
    [11, "read me this page", "skill", { skill: "browser", action: "read" }],
    [12, "open Notepad", "jarvis_command", { utterance: "open Notepad" }],
    [12, "open PowerPoint", "jarvis_command", { utterance: "open PowerPoint" }],
    [13, "move this to my other screen", "skill", { skill: "window", action: "move", target: "front", screen: "other" }],
    [13, "move this to my left screen", "skill", { skill: "window", action: "move", target: "front", screen: "left" }],
    [14, "maximise", "skill", { skill: "window", action: "maximise" }],
    [14, "minimise", "skill", { skill: "window", action: "minimise" }],
    [14, "snap left", "skill", { skill: "window", action: "snap_left" }],
    [15, "show desktop", "skill", { skill: "window", action: "show_desktop" }],
    [15, "restore windows", "skill", { skill: "window", action: "restore_all" }],
    [16, "switch to Chrome", "skill", { skill: "window", action: "switch", target: "chrome" }],
    [16, "switch to VS Code", "skill", { skill: "window", action: "switch", target: "vs code" }],
    [17, "what's on my screen", "screen", { question: "what's on my screen", listen: false }],
    [18, "open the receptionist dashboard", "navigate", { path: "/receptionist" }],
    [19, "find the Dental site in the catalogue and open its preview", "skill", { skill: "browser", action: "open", url: "https://muv-demo-dental.vercel.app/", name: "Lantern Dental" }],
    [20, 'click "Contact" on this page', "skill", { skill: "browser", action: "click", target: "Contact" }],
  ];
  test.each(TABLE)("%d. %s", async (_n, words, tool, args) => {
    const { turn, calls } = voice();
    const r = await turn(words);
    expect({ words, model: r.model, tool: r.name, args: r.args }).toEqual({ words, model: "rules", tool, args });
    expect(calls).toEqual([]);
  });
  test("all 20 numbered commands are covered", () => {
    expect([...new Set(TABLE.map((t) => t[0]))]).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
  test("the page steps are Jarvis Chrome's only while it's what he's looking at; else his real window's (screen hands)", async () => {
    const { turn } = voice({ inFront: async () => false });
    for (const words of ["go back", "scroll down", "refresh", 'click "Contact" on this page']) {
      const r = await turn(words);
      expect({ words, tool: r.name }).toEqual({ words, tool: "screen_act" });
    }
    // Opening things doesn't depend on what's in front.
    expect((await turn("open a new tab")).name).toBe("skill");
    expect((await turn("go to our website")).name).toBe("skill");
  });
  test("while he shares his screen, 'this page' is his screen: no browser hands for page steps", async () => {
    const { v } = voice();
    const r: any = await v.handle("/voice/free/turn", { messages: [{ role: "user", content: "scroll down" }], sharing: true });
    expect(r.tool_calls[0].function.name).toBe("screen_act");
  });
  test("what's on my screen is the ONLY command that reaches the vision tool", () => {
    expect(TABLE.filter((t) => t[2] === "screen").map((t) => t[0])).toEqual([17]);
  });
});

describe("the same 20, executed: CDP stub + fake Windows (each answer says WHERE)", () => {
  test("1-4: open Chrome, bring it up, our website, a new tab", async () => {
    const r = rig();
    expect(await r.run({ name: "skill", args: { skill: "browser", action: "open_chrome" } })).toMatchObject({ ok: true, said: "Opened Chrome on your main screen." });
    const site = await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://muventures.com.au/", name: "muventures.com.au" } });
    expect(site.said).toBe("Opened muventures.com.au in Chrome on your main screen.");
    expect(r.cdp.active().url).toBe("https://muventures.com.au/");
    // Jarvis Chrome's window (pid 4242), never his own Chrome (78) or the Jarvis app (5), was moved and focused.
    expect(r.windows.foreground()).toBe(77);
    expect(r.windows.at[77].mon).toBe(MAIN.id);
    expect(r.windows.at[78]).toBeUndefined();
    const tab = await r.run({ name: "skill", args: { skill: "browser", action: "new_tab" } });
    expect(tab.said).toBe("Opened a new tab in Chrome on your main screen.");
    expect(r.cdp.count).toBe(3);
    expect(r.cdp.log.filter((l) => l.startsWith("tab new"))).toEqual(["tab new https://muventures.com.au/", "tab new chrome://newtab/"]);
  });
  test("5-8: search Google, open Gmail, YouTube search, the Bianca site", async () => {
    const r = rig();
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "search", engine: "google", query: "best dentist in sydney" } })).said).toBe('Searched Google for "best dentist in sydney" in Chrome on your main screen.');
    expect(r.cdp.active().url).toBe("https://www.google.com/search?q=best%20dentist%20in%20sydney");
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://mail.google.com/", name: "Gmail" } })).said).toBe("Opened Gmail in Chrome on your main screen.");
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "search", engine: "youtube", query: "lo-fi beats" } })).said).toBe('Searched YouTube for "lo-fi beats" in Chrome on your main screen.');
    expect(r.cdp.active().url).toBe("https://www.youtube.com/results?search_query=lo-fi%20beats");
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://bianca.muventures.com.au/", name: "Bianca Brown Realty" } })).said).toBe("Opened Bianca Brown Realty in Chrome on your main screen.");
  });
  test("9-11: back, refresh, close this tab, scroll, read the page", async () => {
    const r = rig();
    await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://muventures.com.au/" } });
    await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://mail.google.com/", name: "Gmail" } });
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "scroll", dir: "down" } })).said).toBe("Scrolled down.");
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "reload" } })).said).toBe("Refreshed.");
    const read = (await r.run({ name: "skill", args: { skill: "browser", action: "read" } })).said;
    expect(read).toContain("The page at https://mail.google.com/");
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "close_tab" } })).said).toBe("Tab closed.");
    expect(r.cdp.active().url).toBe("https://muventures.com.au/");
    const home = (await r.run({ name: "skill", args: { skill: "browser", action: "read" } })).said;
    expect(home).toMatch(/^This page is "M&U Ventures \| Websites and automation" \(muventures\.com\.au\)\. It says: M&U Ventures builds websites/);
    expect(await r.hands.tabs()).toHaveLength(2);
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "back" } })).said).toBe("Gone back.");
    // Nothing further back: it says so instead of pretending.
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "back" } })).said).toMatch(/^I couldn't go back/);
  });
  test("20: click \"Contact\" clicks the link; nothing else", async () => {
    const r = rig();
    await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://muventures.com.au/" } });
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "click", target: "Contact" } })).said).toBe('Clicked "Contact".');
    expect(r.cdp.clicked).toEqual(["@e1"]);
    expect((await r.run({ name: "skill", args: { skill: "browser", action: "click", target: "Nonexistent" } })).said).toMatch(/can't see "Nonexistent"/);
    expect(r.cdp.clicked).toEqual(["@e1"]);
  });
  test("12-16: apps and windows are fixed commands (fake Windows), none needs the brain or the browser", async () => {
    const r = rig();
    const say = async (args: Record<string, unknown>) => (await r.skills.run(args)).said;
    // (The window in front, as Windows reports it, is what maximise acts on.)
    expect(await say({ skill: "window", action: "maximise" })).toBe("Maximised, sir.");
    expect(await say({ skill: "window", action: "snap_left" })).toBe("Snapped left, sir.");
    expect(await say({ skill: "window", action: "show_desktop" })).toBe("Desktop's clear, sir.");
    expect(await say({ skill: "window", action: "restore_all" })).toBe("Windows restored, sir.");
    expect(await say({ skill: "window", action: "switch", target: "vs code" })).toBe("Switched to Visual Studio Code, sir.");
    expect(r.windows.foreground()).toBe(79);
    expect(await say({ skill: "window", action: "switch", target: "chrome" })).toMatch(/^Switched to /);
    expect(await say({ skill: "window", action: "bring", target: "notepad", screen: "left" })).toMatch(/on the left/);
    expect(r.cdp.log).toEqual([]); // the browser was never touched
  });
  test("13: 'move this to my other screen' after opening the site moves Jarvis Chrome, not the Jarvis app", async () => {
    const r = rig();
    await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://muventures.com.au/", name: "muventures.com.au" } });
    const said = (await r.skills.run({ skill: "window", action: "move", target: "front", screen: "other" })).said;
    expect(said).toMatch(/is on the left screen now|is on your other screen/);
    expect(r.windows.at[77].mon).toBe(LEFT.id);
    expect(r.windows.at[5]).toBeUndefined();
  });
});

describe("the owner's two live transcripts, end to end", () => {
  test("transcript 1: open a Chrome tab, bring it to my front screen (was: moved the Jarvis app, then 'screen sharing is off' three times)", async () => {
    const win = fakeWindows({ jarvisChromeOn: "left" });
    const r = rig({}, win);
    const { turn } = voice();
    const history: Msg[] = [];
    const step = async (words: string) => {
      history.push({ role: "user", content: words });
      const t = await turn(history);
      expect({ words, model: t.model, tool: t.name }).toEqual({ words, model: "rules", tool: "skill" });
      const result = await r.skills.run(t.args);
      history.push({ role: "assistant", content: null, tool_calls: t.raw.tool_calls });
      history.push({ role: "tool", tool_call_id: t.raw.tool_calls[0].id, content: result.said });
      const spoken = await turn(history);
      history.push({ role: "assistant", content: spoken.content });
      return { args: t.args, said: result.said, spoken: String(spoken.content) };
    };
    const one = await step("Can you open a Chrome tab for me?");
    expect(one.args).toEqual({ skill: "browser", action: "new_tab" });
    // (The light "sir" is one voice helper on about one line in four, J4: the content is what this transcript pins.)
    expect(one.spoken.replace(/, sir./, ".")).toBe("Opened a new tab in Chrome on your main screen.");
    expect(win.at[77].mon).toBe(MAIN.id);
    const two = await step("Can you bring it to my front screen?");
    expect(two.args).toEqual({ skill: "window", action: "bring", target: "front", screen: "main" });
    expect(two.said).toMatch(/Chrome|New Tab/);
    expect(two.said).not.toMatch(/shell 0\.2\.1|Jarvis/);
    const three = await step("I didn't see it on my main screen.");
    expect(three.args).toMatchObject({ skill: "window", action: "bring", screen: "main" });
    const four = await step("I'm saying I don't see the Chrome tab on my front screen.");
    expect(four.args).toMatchObject({ skill: "window", action: "bring", screen: "main" });
    expect(win.foreground()).toBe(77);
    expect(win.at[5]).toBeUndefined(); // the Jarvis app window was never moved
    expect(win.at[78]).toBeUndefined(); // nor his own Chrome
  });
  test("transcript 2: bring up Chrome, go to MU Ventures main website, bring it up, yep (was: hidden .com, then screen hands wandered YouTube)", async () => {
    const win = fakeWindows({ jarvisChromeOn: "left" });
    const r = rig({}, win);
    const { turn, calls } = voice();
    const a = await turn("Can you bring up Chrome on my screen?");
    expect(a.args).toEqual({ skill: "window", action: "bring", target: "chrome", screen: "main" });
    expect((await r.skills.run(a.args)).said).toMatch(/Chrome/);
    expect(win.at[77].mon).toBe(MAIN.id); // Jarvis Chrome (pid 4242), not his own Chrome
    expect(win.at[78]).toBeUndefined();
    const b = await turn("Can you go to MU Ventures main website?");
    expect(b.args).toMatchObject({ skill: "browser", action: "open", url: "https://muventures.com.au/" });
    const opened = await r.skills.run(b.args);
    expect(opened.said).toBe("Opened muventures.com.au in Chrome on your main screen.");
    expect(r.cdp.active().url).toBe("https://muventures.com.au/");
    for (const words of ["Can you bring it up?", "bring it to the front", "show me that tab", "put it on my screen"]) {
      const c = await turn(words);
      expect({ words, model: c.model, tool: c.name, args: c.args }).toEqual({ words, model: "rules", tool: "skill", args: { skill: "window", action: "bring", target: "front", screen: "main" } });
      expect((await r.skills.run(c.args)).said).not.toMatch(/Jarvis|shell/);
    }
    // "yep" with nothing pending is not a task: it never starts a screen loop.
    const yep = await turn("yep");
    expect(yep.name).not.toBe("screen_act");
    expect(calls.filter((c) => c === "brain").length).toBeLessThanOrEqual(1);
  });
});

describe("Jev routes what the rules miss; the brain never picks browser tools", () => {
  const jevBrowser = (action: string) => ({ category: { choice: "browser", confidence: 0.99 }, browser_action: { choice: action, confidence: 0.99 }, outbound: { noul: 0 }, multi: { noul: 0 }, complete: { noul: 1 } });
  test("a Jev browser paraphrase becomes the same hands call as the rule", async () => {
    const { turn } = voice({ jev: () => jevBrowser("back") });
    const r = await turn("hop to the previous page for me");
    expect(r.model).toBe("jev-router");
    expect(r.name).toBe("skill");
    expect(r.args).toEqual({ skill: "browser", action: "back" });
  });
  test("Jev's website answer opens through the hands, with a where-line", async () => {
    const { turn } = voice({ jev: () => ({ category: { choice: "website", confidence: 0.99 }, site: { choice: "https://github.com", confidence: 0.99 }, outbound: { noul: 0 }, multi: { noul: 0 }, complete: { noul: 1 } }) });
    const r = await turn("who runs github");
    expect(r.name).toBe("skill");
    expect(r.args).toEqual({ skill: "browser", action: "open", url: "https://github.com" });
    const rg = rig();
    expect((await rg.skills.run(r.args)).said).toBe("Opened github.com in Chrome on your main screen.");
  });
  test("a brain that picks screen_act / browser_act / open_url / control_pc for these is corrected by code", () => {
    const call = (name: string, args: Record<string, unknown>) => ({ id: "c", type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
    const out = (c: ReturnType<typeof call>, said: string, o: { sharing?: boolean } = {}) => {
      const g = guardToolCall(c, said, o);
      return { name: g.function.name, args: JSON.parse(g.function.arguments) };
    };
    expect(out(call("screen_act", { goal: "go to our website" }), "go to our website")).toEqual({ name: "skill", args: { skill: "browser", action: "open", url: "https://muventures.com.au/", name: "muventures.com.au" } });
    expect(out(call("control_pc", { task: "open my gmail" }), "open my Gmail").args).toMatchObject({ skill: "browser", action: "open", url: "https://mail.google.com/" });
    expect(out(call("screen", { question: "x" }), "open a new tab").args).toEqual({ skill: "browser", action: "new_tab" });
    expect(out(call("browser_act", { action: "scroll_down" }), "nudge it down a bit").args).toEqual({ skill: "browser", action: "scroll", dir: "down" });
    expect(out(call("open_url", { url: "https://muventures.com/" }), "open the site").args).toEqual({ skill: "browser", action: "open", url: "https://muventures.com.au/" });
    // A LOOK question still gets the vision tool.
    expect(out(call("screen", { question: "what's on my screen" }), "what's on my screen").name).toBe("screen");
  });
  test("screen_act is retired for focus and site requests; it keeps a concrete goal", () => {
    const call = (goal: string) => ({ id: "c", type: "function" as const, function: { name: "screen_act", arguments: JSON.stringify({ goal }) } });
    const out = (goal: string, said = goal) => {
      const g = guardToolCall(call(goal), said);
      return { name: g.function.name, args: JSON.parse(g.function.arguments) };
    };
    expect(out("bring it up").args).toEqual({ skill: "window", action: "bring", target: "front", screen: "main" });
    expect(out("focus the MU Ventures site", "get me to it").args).toEqual({ skill: "window", action: "bring", target: "front", screen: "main" });
    expect(out("go to example.com", "take me there")).toEqual({ name: "skill", args: { skill: "browser", action: "open", url: "https://example.com/" } });
    expect(out("click Submit").name).toBe("screen_act");
    expect(out("type hello in the Name field").name).toBe("screen_act");
  });
});

describe("safety gates are the same for the hands (S2c final button, money context, money host, S2e verdict)", () => {
  const BANK = "https://www.commbank.com.au/netbank";
  test("a final button is never pressed by the hands, and nothing is clicked", async () => {
    const r = rig();
    await r.run({ name: "skill", args: { skill: "browser", action: "open", url: "https://muventures.com.au/" } });
    for (const target of ["Send message", "Pay now"]) {
      const said = (await r.run({ name: "skill", args: { skill: "browser", action: "click", target } })).said;
      expect(said).toMatch(/final|money|Not done|send/i);
    }
    expect(r.cdp.clicked).toEqual([]);
    // In the rule layer a final-button phrase never becomes a browser-skill click at all.
    expect(browserSkillIntent("press send")).toBeNull();
    expect(browserSkillIntent("click pay now")).toBeNull();
    expect(browserSkillIntent("click submit")).toBeNull();
  });
  test("a money host never opens (bank, broker, exchange, betting, payment)", async () => {
    const r = rig();
    const said = (await r.run({ name: "skill", args: { skill: "browser", action: "open", url: BANK } })).said;
    expect(said).toMatch(/Not done: that's a bank, broker, exchange, betting or payment site/);
    expect(r.cdp.log.some((l) => l.includes("commbank"))).toBe(false);
    expect(r.cdp.count).toBe(1);
  });
  test("a click on a money page is refused even for an ordinary link", async () => {
    const r = rig({
      "https://shop.example.test/step2": {
        title: "Checkout",
        text: "Order total $89.00. Card number, expiry, CVC. Place your order.",
        controls: [{ role: "link", name: "Continue" }, { role: "textbox", name: "Card number" }],
      },
    });
    await r.hands.open("https://shop.example.test/step2");
    const click = await r.hands.click("Continue");
    expect(click.ok).toBe(false);
    expect(click.said).toMatch(/^Not done: /);
    expect(r.cdp.clicked).toEqual([]);
  });
  test("secrets refusals are unchanged: a secret-bearing target is never clicked or opened", async () => {
    const r = rig();
    await r.hands.open("https://muventures.com.au/");
    const said = (await r.hands.click("the .env file")).said;
    expect(said).toMatch(/secret/i);
    expect(r.cdp.clicked).toEqual([]);
  });
  test("the browser skill is never allowed remotely", async () => {
    const r = rig();
    expect(await r.skills.run({ skill: "browser", action: "open", url: "https://muventures.com.au/" }, { remote: true })).toMatchObject({ ok: false });
    expect(r.cdp.log).toEqual([]);
  });
  test("a bad request is rejected, not run", async () => {
    const r = rig();
    for (const body of [{ skill: "browser", action: "open", url: "file:///c:/secrets.txt" }, { skill: "browser", action: "open", url: "javascript:alert(1)" }, { skill: "browser", action: "nope" }, { skill: "browser", action: "click" }])
      expect(await r.skills.run(body)).toMatchObject({ ok: false });
    expect(r.cdp.log).toEqual([]);
  });
});

describe("catalogue names", () => {
  test("client sites resolve from the websites catalogue, never a guess", () => {
    expect(catalogueSite("the dental", true)?.url).toBe("https://muv-demo-dental.vercel.app/");
    expect(catalogueSite("bianca")?.url).toBe("https://bianca.muventures.com.au/");
    expect(catalogueSite("the banana")).toBeNull();
    expect(browserSkillIntent("open the banana site")).toBeNull();
  });
  test("his own words that aren't browser commands are left alone", () => {
    for (const w of ["what's the weather", "set a timer for ten minutes", "go back to sleep", "close this window", "scroll through my emails and tell me", "open Notepad", "what's on my screen"]) expect(browserSkillIntent(w)).toBeNull();
  });
});

describe("Jarvis Chrome not running, and the runner", () => {
  test("a refused connection starts Jarvis Chrome once (the launcher), then opens; if it can't start, it says so", async () => {
    const cdp = cdpStub();
    let up = false;
    let started = 0;
    const flaky: AbRun = async (argv, t) => (up ? cdp.run(argv, t) : { code: 1, stdout: JSON.stringify({ success: false, data: null, error: "connect ECONNREFUSED 127.0.0.1:9222" }) + "\n", stderr: "" });
    const hands = createAgentBrowserHands({ run: flaky, port: 9222 });
    const { runBrowserSkill } = await import("./browser-skill");
    const deps = { hands, present: async () => "Google Chrome is up on your main screen, sir.", ensure: async () => ((started++, (up = true))) };
    expect(await runBrowserSkill({ skill: "browser", action: "open", url: "https://muventures.com.au/" }, deps)).toBe("Opened muventures.com.au in Chrome on your main screen.");
    expect(started).toBe(1);
    up = false;
    const dead = await runBrowserSkill({ skill: "browser", action: "open", url: "https://muventures.com.au/" }, { ...deps, ensure: async () => false });
    expect(dead).toMatch(/^The browser didn't open it/);
  });
  test("the runner answers when the CLI exits or prints its line, even if a daemon keeps the pipes open", async () => {
    // A child that prints one JSON line and then lingers (like agent-browser's first call, which leaves its daemon holding the pipes).
    const run = spawnRunner(process.execPath);
    const started = Date.now();
    const r = await run(["-e", 'console.log(JSON.stringify({success:true,data:{ok:1},error:null})); setTimeout(()=>{}, 4000)'], 3000);
    expect(JSON.parse(r.stdout.trim())).toEqual({ success: true, data: { ok: 1 }, error: null });
    expect(Date.now() - started).toBeLessThan(2500);
    // A child that never answers is cut off at the timeout, not waited on.
    const hung = await run(["-e", "setTimeout(()=>{}, 5000)"], 400);
    expect(hung.code).toBe(-1);
    expect(hung.stderr).toMatch(/timed out/);
  });
});

describe("REVIEW-J2 F1: every name a control carries is checked before it is pressed", () => {
  const page = (controls: StubControl[]): Record<string, StubPage> => ({ "https://labels.example.test/p": { title: "Labels", text: "An ordinary page.", controls } });
  const opened = async (controls: StubControl[], stub: { failAttr?: boolean } = {}) => {
    const r = rig(page(controls), fakeWindows(), stub);
    await r.hands.open("https://labels.example.test/p");
    return r;
  };
  test("visible Delete under aria-label Next is final: refused, nothing pressed", async () => {
    const r = await opened([{ role: "button", name: "Next", aria: "Next", text: "Delete" }]);
    const c = await r.hands.click("Next");
    expect(c.ok).toBe(false);
    expect(c.said).toMatch(/final "Delete" button/);
    expect(r.cdp.clicked).toEqual([]);
  });
  test("a final title, value or alt behind an innocent name is final too", async () => {
    for (const control of [
      { role: "button", name: "Go", aria: "Go", text: "Go", title: "Post" },
      { role: "button", name: "Go", aria: "Go", text: "", value: "Confirm" },
      { role: "link", name: "Go", aria: "Go", text: "Go", alt: "Unsubscribe" },
    ] as StubControl[]) {
      const r = await opened([control]);
      const c = await r.hands.click("Go");
      expect({ control, ok: c.ok }).toEqual({ control, ok: false });
      expect(r.cdp.clicked).toEqual([]);
    }
  });
  test("two names that disagree hide one: not pressed (a harmless pair on their own)", async () => {
    const r = await opened([{ role: "button", name: "Details about pricing", aria: "Details about pricing", text: "Learn more" }]);
    const c = await r.hands.click("Details about pricing");
    expect(c.ok).toBe(false);
    expect(c.said).toMatch(/labelled two different ways/);
    expect(r.cdp.clicked).toEqual([]);
  });
  test("names that agree, or a title that only adds a tooltip, still click", async () => {
    const r = await opened([{ role: "link", name: "Contact us", aria: "Contact us", text: "Contact", title: "Get in touch" }]);
    expect((await r.hands.click("Contact")).ok).toBe(true);
    expect(r.cdp.clicked).toEqual(["@e1"]);
  });
  test("if the other names can't be read, it fails closed", async () => {
    const r = await opened([{ role: "link", name: "Contact" }], { failAttr: true });
    const c = await r.hands.click("Contact");
    expect(c.ok).toBe(false);
    expect(c.said).toMatch(/couldn't read everything/);
    expect(r.cdp.clicked).toEqual([]);
  });
});

describe("REVIEW-J2 F2/F3: no typing hands; a minimal environment for the third-party CLI", () => {
  test("the hands have no way to type into a page", () => {
    const hands = createAgentBrowserHands({ run: cdpStub().run });
    expect(Object.keys(hands)).not.toContain("fill");
    expect(Object.keys(hands)).not.toContain("type");
  });
  test("minimalEnv keeps what a Windows program needs and AGENT_BROWSER_*, and drops everything else", () => {
    const env = minimalEnv({ PATH: "p", Path: "p2", SystemRoot: "C:\\Windows", TEMP: "t", APPDATA: "a", AGENT_BROWSER_HEADED: "0", GROQ_API_KEY: "secret", OPENROUTER_API_KEY: "secret", J2_SENTINEL: "secret", HOME: "h" });
    expect(Object.keys(env).sort()).toEqual(["AGENT_BROWSER_HEADED", "APPDATA", "HOME", "PATH", "Path", "SystemRoot", "TEMP"].sort());
    expect(Object.values(env)).not.toContain("secret");
  });
  test("a sentinel variable in the server's environment never reaches the spawned process", async () => {
    process.env.J2_SENTINEL_KEY = "sentinel-value";
    try {
      const r = await spawnRunner(process.execPath)(["-e", 'console.log(JSON.stringify({success:true,data:{leaked: process.env.J2_SENTINEL_KEY !== undefined, hasPath: !!(process.env.PATH || process.env.Path)},error:null}))'], 5000);
      expect(JSON.parse(r.stdout.trim()).data).toEqual({ leaked: false, hasPath: true });
    } finally {
      delete process.env.J2_SENTINEL_KEY;
    }
  });
});