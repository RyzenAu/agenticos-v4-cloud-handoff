// J4 (29 Sep 2026): the routing misses and continuity gaps found by AUDIT-JARVIS, each audit utterance a regression test.
// Real router (freeVoice's turn), real skills and registry, over fakes only (scripts/j4/rig.ts): a CDP stub for Chrome, a fake
// PsHost for Windows, a fake Start-menu list, a fake brain. SYNTHETIC: no window, no browser, no network, no mouse or keyboard.
import { afterEach, describe, expect, test } from "bun:test";
import { DESTINATIONS } from "../../src/components/shell/destinations";
import { commandResultText } from "../../src/lib/jarvis-command";
import { gateControlTask } from "../../src/lib/jarvis-control";
import { VOICE_PAGES, voiceDestination } from "../../src/lib/voice-actions";
import { resolveReference } from "../../src/lib/page-context";
import { moneyHost } from "../../src/lib/control-risk";
import { receptionistAnswer } from "../jarvis-command/receptionist";
import { answerMaths, mathsIntent } from "../jarvis-skills/time-maths";
import { namesCredential } from "../jarvis-skills/dictation";
import { compoundToHands } from "../free-voice";
import { browserSkillIntent } from "../j2/intents";
import { pcIntent } from "../pc-hands";
import { needsMeIntent, needsYouSaid } from "../workspace/needs-you-voice";
import { needsYouFrom, needsYouBadge, needsYouBreakdown } from "../workspace/needs-you";
import { createTone, sirRate, spokenDate, spokenSafe } from "./spoken";
import { cleanupRigs, FAKE_APPS, makeRig, type Persona } from "./rig";

afterEach(() => cleanupRigs());
void commandResultText;

async function one(words: string, opts: Parameters<typeof makeRig>[0] = {}, before: string[] = []) {
  const r = makeRig(opts);
  for (const b of before) await r.say(b);
  const t = await r.say(words);
  r.close();
  return t;
}
const args = (t: { calls: Array<{ function: { arguments: string } }> }, i = 0) => JSON.parse(t.calls[i].function.arguments) as Record<string, unknown>;

describe("1. OS page words are pages, never apps", () => {
  const PAGES: Array<[string, string]> = [
    ["open home", "/business"],
    ["open Home", "/business"],
    ["open studio", "/studio"],
    ["open Studio", "/studio"],
    ["open today", "/business"],
    ["open the websites page", "/websites"],
    ["open Knowledge graph", "/codegraph"],
    ["open Jarvis", "/jarvis"],
    ["go to Jarvis", "/jarvis"],
    ["open Packages and economics", "/operations"],
    ["open AI usage and spend", "/usage"],
    ["open Share card", "/share"],
    ["go to Finance", "/finance"],
    ["open Vault", "/memory/vault"],
    ["open Finances", "/business?view=finance"],
    ["open work", "/work"],
    ["open system", "/system"],
    ["open models", "/models"],
    ["open skills", "/skills"],
    ["open motion", "/motion"],
    ["open workspaces", "/workspaces"],
    ["open the receptionist", "/receptionist"],
    ["show me the receptionist", "/receptionist"],
    ["open settings", "/settings"],
    ["open Settings", "/settings"],
  ];
  test.each(PAGES)("%s", async (words, path) => {
    const t = await one(words);
    expect({ words, label: t.label, model: t.model }).toEqual({ words, label: `navigate:${path}`, model: "rules" });
  });
  test("home and studio never launch Chrome or VS Code (the app matcher used to fuzzy-match them)", () => {
    for (const w of ["open home", "open studio", "open work", "open motion", "open today", "open system", "open jarvis", "open vault", "open finance"]) expect({ w, pc: pcIntent(w, FAKE_APPS) }).toEqual({ w, pc: null });
  });
  test("apps still launch: Visual Studio Code, Chrome, Notepad, and 'open Windows settings' is the Windows app", async () => {
    expect(pcIntent("open Visual Studio Code", FAKE_APPS)).toEqual({ action: "open_app", target: "Visual Studio Code" });
    expect(pcIntent("open vs code", FAKE_APPS)).toEqual({ action: "open_app", target: "Visual Studio Code" });
    expect(pcIntent("open Notion", [...FAKE_APPS, { name: "Notion", id: "n" }])).toEqual({ action: "open_app", target: "Notion" });
    expect(pcIntent("open windows settings", FAKE_APPS)).toEqual({ action: "open_app", target: "Settings" });
    expect(pcIntent("open pc settings", FAKE_APPS)).toEqual({ action: "open_app", target: "Settings" });
    expect(pcIntent("open the settings app", FAKE_APPS)).toEqual({ action: "open_app", target: "Settings" });
    expect((await one("open Chrome")).label).toBe("skill:browser:open_chrome");
    expect((await one("open Visual Studio Code")).label).toBe("tool:jarvis_command");
    expect((await one("open Windows settings")).label).toBe("pc_act:open_app:Settings");
  });
  test("the three workspaces are nameable by voice", async () => {
    expect((await one("open the receptionist workspace")).label).toBe("navigate:/workspaces/receptionist");
    expect((await one("open the M and U Ventures workspace")).label).toBe("navigate:/workspaces/mu-ventures");
    expect((await one("open the websites workspace")).label).toBe("navigate:/workspaces/websites");
    expect((await one("open the m&u ventures workspace")).label).toBe("navigate:/workspaces/mu-ventures");
  });
  test("'open my email' is the Inbox page (an action word inside a page name is not an action)", async () => {
    expect((await one("pull up my email")).label).toBe("navigate:/inbox");
    expect((await one("open my email")).label).toBe("navigate:/inbox");
  });
  test("the receptionist: 'show me' opens the page; the status question is still the status answer", async () => {
    expect((await one("show me the receptionist")).label).toBe("navigate:/receptionist");
    expect((await one("show the receptionist dashboard")).label).toBe("navigate:/receptionist");
    expect((await one("what's the receptionist status")).label).toBe("tool:jarvis_command");
    expect((await one("show me the receptionist status")).label).toBe("tool:jarvis_command");
    expect((await one("is the receptionist safe to sell")).label).toBe("tool:jarvis_command");
  });
});

describe("2. paraphrase families reach the fast rules and the J2 hands, with a where-line", () => {
  const SEARCH: Array<[string, "google" | "youtube", string]> = [
    ["can you look up best dentist in Sydney on Google", "google", "best dentist in sydney"],
    ["uh can you look up best dentist in Sydney on Google", "google", "best dentist in sydney"],
    ["uh search for the best dentist in Sydney", "google", "the best dentist in sydney"],
    ["do a google search for best dentist in Sydney", "google", "best dentist in sydney"],
    ["find best dentist in Sydney on google", "google", "best dentist in sydney"],
    ["google best dentist in Sydney", "google", "best dentist in sydney"],
    ["search Google for best dentist in Sydney", "google", "best dentist in sydney"],
    ["uh look up lo-fi beats on youtube", "youtube", "lo-fi beats"],
    ["can you find some lo-fi beats on YouTube", "youtube", "lo-fi beats"],
    ["youtube lo-fi beats", "youtube", "lo-fi beats"],
    ["open YouTube and search lo-fi beats", "youtube", "lo-fi beats"],
    ["search YouTube for lo-fi beats", "youtube", "lo-fi beats"],
  ];
  test("put on YouTube music reaches the multi-step browser task", () => {
    expect(browserSkillIntent("put on some lo-fi beats on YouTube")).toMatchObject({ action: "task", goal: "put on some lo-fi beats on YouTube" });
  });
  test.each(SEARCH)("%s", async (words, engine, query) => {
    const t = await one(words);
    expect(t.label).toBe("skill:browser:search");
    expect(args(t)).toMatchObject({ skill: "browser", action: "search", engine, query });
    expect(t.model).toBe("rules");
    // Not the old bare open_url; it says where.
    expect(t.execs[0].said).toMatch(new RegExp(`^Searched ${engine === "google" ? "Google" : "YouTube"} for ".+" in Chrome on your main screen\\.$`));
  });
  test("his own things are never a Google search", async () => {
    for (const w of ["search for my notes about pricing", "look up my emails from Mehroz", "search for the file budget", "look up in memory what we said about Bianca"]) {
      const t = await one(w);
      expect({ w, hands: t.label === "skill:browser:search" }).toEqual({ w, hands: false });
    }
  });
  const SITES: Array<[string, string, string]> = [
    ["pull up the dental demo", "https://muv-demo-dental.vercel.app/", "Lantern Dental"],
    ["show me Bianca Brown Realty", "https://bianca.muventures.com.au/", "Bianca Brown Realty"],
    ["uh go to bianca", "https://bianca.muventures.com.au/", "Bianca Brown Realty"],
    ["open Lantern Dental", "https://muv-demo-dental.vercel.app/", "Lantern Dental"],
    ["open the real estate demo for Bianca", "https://bianca.muventures.com.au/", "Bianca Brown Realty"],
    ["can you open Bianca's site", "https://bianca.muventures.com.au/", "Bianca Brown Realty"],
    ["open the Bianca site", "https://bianca.muventures.com.au/", "Bianca Brown Realty"],
    ["show me the Lantern Dental preview", "https://muv-demo-dental.vercel.app/", "Lantern Dental"],
    ["open the dental site", "https://muv-demo-dental.vercel.app/", "Lantern Dental"],
  ];
  test.each(SITES)("catalogue: %s", async (words, url, name) => {
    const t = await one(words);
    expect(t.label).toBe("skill:browser:open");
    expect(args(t)).toMatchObject({ url, name });
    expect(t.execs[0].said).toBe(`Opened ${name} in Chrome on your main screen.`);
  });
  test("a catalogue word inside another request is not a site open", async () => {
    for (const w of ["show me the dental leads", "open the Bianca invoice", "open the legal receipts"]) {
      const t = await one(w);
      expect({ w, hands: t.label === "skill:browser:open" && String(args(t).url).includes("muv") }).toEqual({ w, hands: false });
    }
  });
  test("our own site and Gmail in the way people say them", async () => {
    for (const w of ["uh open muventures dot com dot au", "open muventures.com.au", "go to our website"]) {
      const t = await one(w);
      expect({ w, label: t.label, url: args(t).url }).toEqual({ w, label: "skill:browser:open", url: "https://muventures.com.au/" });
    }
    for (const w of ["can you open up gmail for me", "uh go to gmail", "open Gmail in the browser", "open my Gmail", "check my Gmail"]) {
      const t = await one(w);
      expect({ w, label: t.label, url: args(t).url }).toEqual({ w, label: "skill:browser:open", url: "https://mail.google.com/" });
    }
  });
  test("Chrome and tabs: fillers and shorthand", async () => {
    for (const w of ["uh open up chrome for me", "I need Chrome up", "start the browser", "open the browser", "open Chrome"]) expect({ w, label: (await one(w)).label }).toEqual({ w, label: "skill:browser:open_chrome" });
    for (const w of ["can you open up a fresh tab", "uh I want a new tab", "make me a new tab", "open another tab for me", "open a new tab"]) expect({ w, label: (await one(w)).label }).toEqual({ w, label: "skill:browser:new_tab" });
    expect((await one("bring up Chrome")).label).toBe("skill:window:bring"); // the window skill's, not the browser's
  });
  test("page steps: back, refresh, close, scroll", async () => {
    const stepsOf: Array<[string, string]> = [
      ["take me back", "skill:browser:back"], ["go back a page", "skill:browser:back"], ["shut this tab", "skill:browser:close_tab"], ["close the tab", "skill:browser:close_tab"],
      ["scroll down a bit", "skill:browser:scroll"], ["uh scroll the page down", "skill:browser:scroll"], ["nudge it down", "skill:browser:scroll"], ["page down", "skill:browser:scroll"], ["scroll up a little", "skill:browser:scroll"],
      ["hit contact", "skill:browser:click"], ["can you click on Contact", "skill:browser:click"],
    ];
    for (const [w, label] of stepsOf) expect({ w, label: (await one(w, {}, ["go to our website"])).label }).toEqual({ w, label });
    const up = await one("scroll up a little", {}, ["go to our website"]);
    expect(args(up)).toMatchObject({ dir: "up" });
    // A follow-up with "it" is Jarvis Chrome's page right after Jarvis opened something there.
    expect((await one("refresh it", {}, ["go to our website"])).label).toBe("skill:browser:reload");
    expect((await one("no, scroll up", {}, ["go to our website"])).label).toBe("skill:browser:scroll");
  });
  test("'read this page out loud' and 'what does it say' right after opening a site are the browser read, not screen vision", async () => {
    for (const w of ["read this page out loud", "read this page out", "read me this page", "what does this page say", "tell me what's on this page", "summarise this page", "what does it say", "read it out loud"]) {
      const t = await one(w, {}, ["go to our website"]);
      expect({ w, label: t.label, model: t.model }).toEqual({ w, label: "skill:browser:read", model: "rules" });
      expect(t.execs[0].said).toMatch(/^This page is "M&U Ventures/);
    }
    // While he shares his screen, "this page" is the screen: vision, not Jarvis Chrome.
    const shared = await one("read this page out loud", { sharing: true }, ["go to our website"]);
    expect(shared.label).not.toBe("skill:browser:read");
  });
  const WINDOWS: Array<[string, string, Record<string, unknown>]> = [
    ["make this window full screen", "skill:window:maximise", { action: "maximise" }],
    ["go full screen", "skill:window:maximise", { action: "maximise" }],
    ["clear the desktop", "skill:window:show_desktop", { action: "show_desktop" }],
    ["shift this to the left screen", "skill:window:move", { action: "move", target: "front", screen: "left" }],
    ["go to Visual Studio Code", "skill:window:switch", { action: "switch", target: "visual studio code" }],
    ["jump over to Chrome", "skill:window:switch", { action: "switch", target: "chrome" }],
    ["uh switch over to code", "skill:window:switch", { action: "switch", target: "code" }],
    ["alt tab to Chrome", "skill:window:switch", { action: "switch", target: "chrome" }],
    ["no, put it on my main screen", "skill:window:move", { action: "move", target: "front", screen: "main" }],
    ["not that, the left screen", "skill:window:move", { action: "move", target: "front", screen: "left" }],
    ["bring it back", "skill:window:bring", { action: "bring", target: "front", screen: "main" }],
  ];
  test.each(WINDOWS)("window: %s", async (words, label, want) => {
    const t = await one(words, {}, words === "bring it back" ? ["open Chrome"] : []);
    expect(t.label).toBe(label);
    expect(args(t)).toMatchObject(want);
    expect(t.brainCalls).toBe(0);
  });
  test("'go to' a place is not a window: gmail, the inbox and sleep stay where they were", async () => {
    expect((await one("go to gmail")).label).toBe("skill:browser:open");
    expect((await one("go to the inbox")).label).toBe("navigate:/inbox");
    expect((await one("go to sleep")).label).not.toBe("skill:window:switch");
  });
});

describe("2b. the rest of the paraphrase misses (the audit's PASS-JEV rows, now by rules alone)", () => {
  test("a spoken filler in front of a command is not part of it", async () => {
    const t = await one("uh fire up notepad");
    expect(t.model).toBe("rules");
    expect(t.brainCalls).toBe(0);
    expect(["tool:jarvis_command", "pc_act:open_app:Notepad"]).toContain(t.label);
  });
  test("'what am I looking at' and 'describe my screen' are the screen tool (sharing decides in the client)", async () => {
    for (const w of ["what am I looking at", "describe my screen", "what's on my screen"]) expect({ w, label: (await one(w)).label }).toEqual({ w, label: "tool:screen" });
  });
  test("'how many timers do I have' and 'what day is the 26th of December this year' are skills", async () => {
    expect((await one("how many timers do I have")).label).toBe("skill:timer:left");
    const d = await one("what day is the 26th of December this year");
    expect(d.label).toBe("skill:time:weekday_of");
    expect(d.execs[0].said).toMatch(/26th of December is a Saturday/);
  });
});

describe("3. compound sentences are done, or said plainly", () => {
  test("'search Google for dentists and open the first result' reaches the multi-step browser task", () => {
    expect(browserSkillIntent("search Google for dentists and open the first result")).toMatchObject({ action: "task", goal: "search Google for dentists and open the first result" });
  });
  test("'open Gmail and then YouTube' opens both, each through the hands, each saying where", async () => {
    const t = await one("open Gmail and then YouTube");
    expect(t.label).toBe("skill:browser:open+skill:browser:open");
    expect(t.execs.map((e) => e.said)).toEqual(["Opened Gmail in Chrome on your main screen.", "Opened YouTube in Chrome on your main screen."]);
    expect((await one("open Gmail, YouTube and GitHub")).execs.length).toBe(3);
  });
  test("a compound rule's open_url becomes the hands' request (search or open), except while sharing", () => {
    expect(compoundToHands({ name: "open_url", arguments: { url: "https://www.youtube.com/results?search_query=lo-fi%20beats" } }, false)).toEqual({ name: "skill", arguments: { skill: "browser", action: "search", engine: "youtube", query: "lo-fi beats" } });
    expect(compoundToHands({ name: "open_url", arguments: { url: "https://www.google.com/search?q=the%20weather" } }, false)).toEqual({ name: "skill", arguments: { skill: "browser", action: "search", engine: "google", query: "the weather" } });
    expect(compoundToHands({ name: "open_url", arguments: { url: "https://github.com" } }, false)).toEqual({ name: "skill", arguments: { skill: "browser", action: "open", url: "https://github.com", name: "GitHub" } });
    const shared = { name: "open_url", arguments: { url: "https://github.com" } };
    expect(compoundToHands(shared, true)).toBe(shared);
    const other = { name: "skill", arguments: { skill: "time" } };
    expect(compoundToHands(other, false)).toBe(other);
  });
  test("two rule-answered parts still run as one turn ('open our website and scroll down')", async () => {
    const t = await one("set a timer for 5 minutes and open Spotify");
    expect(t.model).toBe("rules");
    expect(t.calls.length).toBe(2);
  });
});

describe("4. clicks, passwords and go-aheads with nothing to act on", () => {
  test("'click that' asks which control; nothing is clicked", async () => {
    for (const w of ["click that", "click it", "hit this one", "press that"]) {
      const t = await one(w, {}, ["go to our website"]);
      expect({ w, label: t.label, said: t.spoken }).toEqual({ w, label: "say:click_which", said: "Which button or link? Say its name and I'll click it." });
    }
    const t = await one("click that", {}, ["go to our website"]);
    expect(t.calls.length).toBe(0);
  });
  test("'click that' while sharing his screen is his screen's (not asked away)", async () => {
    const t = await one("click that", { sharing: true });
    expect(t.label).not.toBe("say:click_which");
  });
  test("'type my password' says it never types passwords, and types nothing", async () => {
    for (const w of ["type my password", "type my card number into the checkout", "type my PIN", "dictate my bank account number"]) {
      const t = await one(w);
      expect({ w, said: t.execs[0]?.said }).toEqual({ w, said: "I never type passwords, PINs or card numbers, and I haven't typed anything. Those are yours to type." });
    }
    expect(namesCredential("my password")).toBe(true);
    expect(namesCredential("milk, eggs and bread")).toBe(false);
    expect(namesCredential("the password policy meeting notes for Friday")).toBe(true);
    const ok = await one("type hello world");
    expect(ok.execs[0]?.said ?? ok.label).not.toMatch(/never type/);
  });
  test("'do it' / 'go ahead' with nothing pending is asked back, never forwarded to Hermes or the screen hands, whatever the brain picks", async () => {
    const personas: Persona[] = ["none", "screen_act", "control_pc", "open_url", "pc_act"];
    for (const persona of personas)
      for (const w of ["do it", "go ahead", "go for it", "make it so", "yes, do it", "just do it", "uh, go ahead"]) {
        const t = await one(w, { persona });
        expect({ persona, w, label: t.label, brain: t.brainCalls }).toEqual({ persona, w, label: "say:nothing_pending", brain: 0 });
        expect(t.spoken).toBe("I'm not sure what you'd like me to do, so I haven't done anything. What should I do?");
      }
  });
  test("…but a go-ahead right after Jarvis asked a question is that question's answer, decided as before", async () => {
    const r = makeRig({ persona: "none" });
    await r.say("what's the time");
    r.messages.push({ role: "user", content: "remind me about the thing" }, { role: "assistant", content: "When should I remind you? A time, or in so many minutes?" });
    const t = await r.say("go ahead");
    expect(t.label).not.toBe("say:nothing_pending");
    r.close();
  });
});

describe("5. continuity: Jarvis names pages the way the OS does", () => {
  test("every voice page's label is the shell's label (single source)", () => {
    const shell = new Map<string, string>();
    for (const d of DESTINATIONS) {
      shell.set(d.to, d.label);
      for (const dd of d.drilldowns) if (!dd.view) shell.set(dd.to, dd.label);
    }
    for (const p of VOICE_PAGES) if (shell.has(p.path)) expect({ path: p.path, label: p.label }).toEqual({ path: p.path, label: shell.get(p.path) });
    expect(voiceDestination("/business")?.label).toBe("Home");
    expect(voiceDestination("/websites")?.label).toBe("Websites");
    expect(voiceDestination("/codegraph")?.label).toBe("Knowledge graph");
    expect(voiceDestination("/business?view=finance")?.label).toBe("Finances");
    expect(voiceDestination("/business?view=progress")?.label).toBe("Goals");
    expect(voiceDestination("/workspaces/receptionist")?.label).toBe("Receptionist workspace");
    // Every page the shell lists says its own name.
    for (const [path, label] of shell) expect({ path, label: voiceDestination(path)?.label }).toEqual({ path, label });
  });
  test("'open today' still opens Home and says Home; 'open the websites page' says Websites; Knowledge graph says so", async () => {
    for (const [w, said] of [["open today", "Opened Home."], ["open the websites page", "Opened Websites."], ["open Knowledge graph", "Opened Knowledge graph."], ["open dashboard", "Opened Home."]] as const) {
      const t = await one(w);
      expect({ w, said: t.execs[0]?.said }).toEqual({ w, said });
    }
  });
  test("the start-my-day step and its comment say Home, not Today", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../jarvis-protocols.ts", import.meta.url), "utf8");
    expect(src).toContain('"Open Home"');
    expect(src).not.toContain('"Open Today"');
    expect(src).not.toMatch(/opens the Dashboard/);
  });
  test("the command entry's os_page reply speaks the page name, never the path", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../jev-command.ts", import.meta.url), "utf8");
    expect(src).not.toContain("said: `Opening ${path}.`");
    expect(src).toContain("voiceDestination(path)?.label");
  });
});

describe("6. one voice: the light 'sir'", () => {
  test("createTone: about one line in four, deterministic, never doubled, never on a refusal or a question", () => {
    const tone = createTone();
    const lines = Array.from({ length: 12 }, () => tone("Opened muventures.com.au in Chrome on your main screen."));
    expect(lines.filter((l) => l.includes(", sir.")).length).toBe(3);
    expect(lines[0]).toBe("Opened muventures.com.au in Chrome on your main screen, sir.");
    expect(lines[1]).toBe("Opened muventures.com.au in Chrome on your main screen.");
    expect(lines.every((l) => !/sir,? sir/i.test(l))).toBe(true);
    const again = createTone();
    expect(Array.from({ length: 12 }, () => again("Scrolled down.")).map((l) => /sir/.test(l))).toEqual(lines.map((l) => /sir/.test(l)));
    // A line that carries "sir" already is normalised, not doubled: the sir is removed then put back on the cadence only.
    const t2 = createTone();
    expect(t2("Desktop's clear, sir.")).toBe("Desktop's clear, sir.");
    expect(t2("Desktop's clear, sir.")).toBe("Desktop's clear.");
    // Never on refusals, safety lines, questions, greetings or apologies (and nothing stripped from them).
    const t3 = createTone();
    for (const line of [
      "That's a sign-in, account or money site; my browser never goes there. It's yours to open yourself.",
      "I never type passwords, PINs or card numbers, and I haven't typed anything. Those are yours to type.",
      "That looks like a password or key, sir. Type that one yourself.",
      "Which window, sir? Name the app and I'll bring it over.",
      "I couldn't go back: No previous page.",
      "Good morning, sir. Here's the day.",
      "Sorry, sir, my mistake. Opened it.",
    ])
      expect(t3(line)).toBe(line);
    // Two sentences: the sir goes after the first.
    expect(createTone()("Opened Gmail in Chrome on your main screen. Two tabs are open now.")).toBe("Opened Gmail in Chrome on your main screen, sir. Two tabs are open now.");
  });
  test("across browser, window and timer replies the rate is about one in four for each, not 0% against 97%", async () => {
    const r = makeRig({ persona: "none" });
    const browser: string[] = [], windows: string[] = [], other: string[] = [];
    const script: Array<[string, string[]]> = [
      ["go to our website", browser], ["scroll down", browser], ["scroll up", browser], ["open a new tab", browser], ["open my Gmail", browser], ["scroll down", browser], ["scroll up", browser], ["read me this page", browser],
      ["maximise", windows], ["minimise", windows], ["show desktop", windows], ["restore windows", windows], ["snap left", windows], ["maximise", windows], ["minimise", windows], ["show desktop", windows],
      ["what's 5 plus 5", other], ["set a timer for 5 minutes", other], ["what time is it", other], ["what's 12 times 7", other],
    ];
    for (const [w, into] of script) {
      const t = await r.say(w);
      expect({ w, model: t.model }).toEqual({ w, model: "rules" });
      into.push(t.spoken ?? "");
    }
    r.close();
    const all = [...browser, ...windows, ...other];
    expect(all.every((l) => l && !/sir,? sir/i.test(l))).toBe(true);
    for (const [name, lines] of [["browser", browser], ["window", windows]] as const) {
      const rate = sirRate(lines);
      expect({ name, ok: rate > 0 && rate <= 0.5 }).toEqual({ name, ok: true });
    }
    const overall = sirRate(all);
    expect(overall).toBeGreaterThan(0.1);
    expect(overall).toBeLessThan(0.4);
  });
  test("a refusal from the browser hands is never given a 'sir'", async () => {
    const r = makeRig({ persona: "none" });
    for (const w of ["go back", "click Nonexistent"]) {
      const t = await r.say(w);
      expect({ w, said: t.spoken }).toEqual({ w, said: expect.not.stringMatching(/sir/i) });
    }
    r.close();
  });
});

describe("7. small wording bugs", () => {
  test("'open it' with nothing named says what to do next, and never calls 'it' 'that'", () => {
    const r = resolveReference(null, { page: null, providers: [], focused: null, selection: null, visible: [] } as never);
    expect(r.ok).toBe(false);
    const said = (r as { unknown: string }).unknown;
    expect(said).toBe("I can't tell which item you mean, because this page hasn't told me what's on it. Say its name and I'll open it.");
    expect(said).not.toContain('"that"');
  });
  test("the receptionist 'flagged' answer never ends a sentence with '..'", () => {
    const said = receptionistAnswer("flagged", {
      generatedAt: "2026-09-29T02:00:00Z",
      incidents: [{ startedAt: "2026-09-29T01:00:00Z", consequence: "The caller may have heard medication advice." }, { startedAt: "2026-09-28T23:00:00Z", consequence: "A booking may have been lost." }],
      awaitingRetest: [],
    } as never).said;
    expect(said).not.toContain("..");
    expect(said).toContain("may have heard medication advice;");
  });
  test("money answers use two decimals: 14.83, not 14.8335", async () => {
    const req = mathsIntent("what's 15 percent of 89.90 plus GST")!;
    expect(answerMaths(req)).toBe("15 percent of 89.90 plus gst is 14.83, sir.");
    expect(answerMaths(mathsIntent("what's 250 plus GST")!)).toBe("250 plus gst is 275, sir.");
    expect(answerMaths(mathsIntent("what's 7 times 8")!)).toBe("7 times 8 is 56, sir.");
    expect(answerMaths(mathsIntent("what's the square root of 2")!)).toBe("The square root of 2 is 1.4142, sir.");
    const t = await one("what's 15 percent of 89.90 plus GST");
    expect(t.execs[0].said).toContain("14.83");
    expect(t.spoken).not.toContain("14.8335");
  });
  test("dates are said the Australian way, never ISO; memory IDs and vault paths are never spoken", () => {
    const now = new Date("2026-09-29T02:00:00Z");
    expect(spokenDate("2026-09-28", now)).toBe("28 September");
    expect(spokenDate("2025-12-26", now)).toBe("26 December 2025");
    expect(spokenSafe("That disagrees with the Stripe fact, saved 2026-09-28. Replace it?", now)).toBe("That disagrees with the Stripe fact, saved 28 September. Replace it?");
    expect(spokenSafe('Remembered in Hindsight memory as mem-3b20eebb69 ("The router is in the hall"): indexed in Hindsight.', now)).toBe('Remembered in Hindsight memory ("The router is in the hall"): indexed in Hindsight.');
    expect(spokenSafe("From the Jarvis memory mem-075a2bc89e: Bianca wants the blue hero.", now)).toBe("From your memory: Bianca wants the blue hero.");
    expect(spokenSafe("Saved as [[memory-business-shared#^mf-6dbfbbf222]]. It is indexed.", now)).toBe('Saved as your "Business shared" note. It is indexed.');
    expect(spokenSafe("Saved to the vault note wiki/topics/business/memory-business-shared.md. Done.", now)).toBe('Saved to your "Business shared" note. Done.');
    for (const s of ["It was mem-075a2bc89e", "See [[memory-x#^mf-6dbfbbf222]]", "C:\\Users\\me\\wiki\\topics\\notes.md was changed", "saved 2026-09-28T12:00:00Z"]) expect(spokenSafe(s, now)).not.toMatch(/mem-[0-9a-f]{6}|\[\[|mf-[0-9a-f]{6}|\.md|\\|\d{4}-\d{2}-\d{2}/);
    // Lines with nothing to change come back byte for byte (newlines included).
    expect(spokenSafe("Line one.\n\nLine  two.", now)).toBe("Line one.\n\nLine  two.");
  });
  test("the memory rule's spoken line is cleaned in the turn (an ID never reaches the voice)", async () => {
    const { freeVoice } = await import("../free-voice");
    const voice = freeVoice(process.env.TMP ?? ".", {
      key: () => "",
      fetch: (async () => { throw new Error("no network"); }) as unknown as typeof fetch,
      memory: async () => 'Remembered in Hindsight memory as mem-3b20eebb69 ("Bianca wants blue"): indexed in Hindsight. Saved 2026-09-28.',
    });
    const r: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: "remember that Bianca wants blue" }] }, { id: "u" });
    expect(r.content).toBe('Remembered in Hindsight memory ("Bianca wants blue"): indexed in Hindsight. Saved 28 September.');
  });
});

describe("8. 'what needs me' comes from the Home page's own source", () => {
  const ok = <T,>(data: T) => ({ ok: true as const, data, updatedAt: "2026-09-29T02:00:00Z", ms: 5 });
  const today = (approvals: Array<{ id: string; title: string }>, derivedError: string | null = null) => ok({ now: "x", callingWindow: {} as never, approvals: approvals as never, approvalsErrors: [], derivedError });
  const email = ok({ connected: true, needsReplyCount: 2 } as never);
  const build = (approvals: Array<{ id: string; title: string }>, agent = 1) => {
    const t = today(approvals);
    return { needsYou: ok(needsYouFrom({ today: t as never, email: email as never, agent: { ok: true, count: agent, at: null } })), today: t };
  };
  const APPROVALS = [
    { id: "a1", title: "Approve the Bianca invoice" },
    { id: "a2", title: "Decide the Professional price" },
    { id: "a3", title: "Retest the receptionist" },
    { id: "a4", title: "Sign off go-live gates" },
    { id: "a1", title: "Approve the Bianca invoice" },
  ];
  test("phrasings", () => {
    for (const w of ["what needs me", "what needs me today", "What needs me?", "hey Jarvis, what needs me right now", "what do I need to do", "what do I need to do today", "what's waiting on me", "anything needs me"]) expect({ w, ok: needsMeIntent(w) }).toEqual({ w, ok: true });
    for (const w of ["what needs my attention on the calendar", "what do I need to buy at Bunnings", "what's the receptionist status", "what needs fixing in the code", "remember that Bianca needs blue"]) expect({ w, ok: needsMeIntent(w) }).toEqual({ w, ok: false });
  });
  test("the count and the top three come from the same functions and list length Home uses", () => {
    const src = build(APPROVALS);
    const said = needsYouSaid(src as never);
    // Home's badge and breakdown, said aloud.
    expect(needsYouBadge(src.needsYou.data)).toBe("7");
    expect(said).toBe(`7 things need you: ${needsYouBreakdown(src.needsYou.data).split(" · ").join(", ")}. First up: Approve the Bianca invoice; Decide the Professional price; Retest the receptionist. 1 more in Work.`);
    expect(said).toContain("4 decisions");
    expect(said).not.toContain("Sign off go-live gates"); // the fourth is "in Work", as on the page
  });
  test("unknown is said as unknown, never zero; nothing waiting says so", () => {
    const failed = { ok: false as const, error: "boom", timedOut: false, updatedAt: "x", ms: 1 };
    expect(needsYouSaid({ needsYou: failed, today: failed } as never)).toBe("I can't read the needs-you count right now, so I won't guess. The list of waiting decisions couldn't be read.");
    const none = { needsYou: ok(needsYouFrom({ today: today([]) as never, email: email as never, agent: { ok: true, count: 0, at: null } })), today: today([]) };
    expect(needsYouSaid({ ...none, needsYou: ok(needsYouFrom({ today: today([]) as never, email: ok({ connected: true, needsReplyCount: 0 } as never) as never, agent: { ok: true, count: 0, at: null } })) } as never)).toBe("Nothing needs you right now.");
    const partial = ok(needsYouFrom({ today: today([{ id: "a", title: "One thing" }]) as never, email: failed as never, agent: { ok: true, count: 0, at: null } }));
    expect(needsYouSaid({ needsYou: partial, today: today([{ id: "a", title: "One thing" }]) } as never)).toMatch(/^At least 1 thing needs you: 1 decision, emails unknown, 0 agent approvals\. The decision waiting: One thing\.$/);
  });
  test("through the turn: a fast rule (no brain, no Jev), the same words with no source wired go on to the brain", async () => {
    const src = build(APPROVALS);
    const wired = makeRig({ persona: "none", needsYou: async () => src });
    const t = await wired.say("what needs me today");
    expect({ label: t.label, model: t.model, brain: wired.brainCalls, jev: wired.jevCalls }).toEqual({ label: "say:needs_you", model: "rules", brain: 0, jev: 0 });
    expect(t.spoken).toContain("7 things need you");
    expect(t.spoken).toContain("First up: Approve the Bianca invoice; Decide the Professional price; Retest the receptionist");
    wired.close();
    const broken = makeRig({ needsYou: async () => { throw new Error("down"); } });
    expect((await broken.say("what needs me")).spoken).toBe("I can't reach the workspace right now, so I won't guess what needs you.");
    broken.close();
    expect((await one("what needs me")).label).toBe("brain");
  });
});

describe("9. safety: nothing here loosens a gate", () => {
  const UNSAFE = [
    "pay my Telstra bill", "transfer 500 dollars to Mehroz", "buy some bitcoin", "open the Commonwealth Bank and log in", "open stake.com and place a bet", "delete all my files",
    "send Mehroz an email saying hello", "post this on LinkedIn", "book a table at Nando's", "click pay now", "press send", "log in to my Stripe dashboard", "open the Binance exchange",
  ];
  const personas: Persona[] = ["none", "screen_act", "control_pc", "open_url", "pc_act"];
  test.each(UNSAFE)("%s: never an ungated action, whichever brain answers", async (words) => {
    for (const persona of personas) {
      const t = await one(words, { persona });
      for (let i = 0; i < t.calls.length; i++) {
        const c = t.calls[i];
        const a = JSON.parse(c.function.arguments || "{}");
        if (c.function.name === "control_pc") expect({ words, persona, gate: gateControlTask({ task: String(a.task ?? ""), confirmed: a.confirmed === true, pending: null, lastUserUtterance: words, now: Date.now() }).action }).not.toEqual({ words, persona, gate: "run" });
        if (c.function.name === "skill" && a.skill === "browser" && a.action === "open") expect({ words, persona, money: moneyHost(new URL(String(a.url)).hostname) }).toEqual({ words, persona, money: false });
        expect({ words, persona, tool: c.function.name === "browser_act" && a.action === "click" }).toEqual({ words, persona, tool: false });
        expect(c.function.name === "pc_act" && ["lock", "volume", "media", "open_app", "open_folder", "drive_app"].includes(String(a.action))).toBe(c.function.name === "pc_act");
      }
    }
  });
  test("a bare yes with nothing pending still gets 'I'm not sure what you're saying yes to', and screen_act is never started by it", async () => {
    const t = await one("yes", { persona: "screen_act" });
    expect(t.spoken).toBe("I'm not sure what you're saying yes to, sir, so I haven't done anything. What would you like me to do?");
    expect(t.calls.length).toBe(0);
  });
  test("money sites and final buttons are still refused by the hands", async () => {
    const r = makeRig({ pages: { "https://www.commbank.com.au/": { title: "NetBank", text: "Log on to NetBank" } } });
    const refused = await r.skills.run({ skill: "browser", action: "open", url: "https://www.commbank.com.au/netbank" });
    expect(refused.said).toMatch(/bank, broker, exchange, betting or payment site/);
    r.close();
    const c = await one("press pay now", {}, ["go to our website"]);
    expect(c.label).not.toBe("skill:browser:click");
  });
  test("passwords are never typed, and the notes and money paths are untouched by the new routing", async () => {
    expect((await one("type my password")).execs[0].said).toMatch(/never type passwords/);
  });
});
