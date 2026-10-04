// Round 3 (25 Sep): form fill in one batch, one Jev call per step, lesson read-back and replay.
import { describe, expect, test } from "bun:test";
import type { WindowInfo } from "../jarvis-skills/windows";
import { FLAGS_OFF, type ScreenFlags } from "./flags";
import { businessDetails, conflicts, FORM_FILL_GOAL, fillableFields, fillLine, planFill, ruleFor, type Detail, type FillAsk } from "./form-fill";
import { jevStepAction, runScreenAct, type Hands, type JevStep, type Minds } from "./index";
import { createLesson, type LessonMinds, type ReplayStore } from "./lesson";
import type { Overlay } from "./overlay";
import type { Snapshot, UiElement } from "./plan";
import type { CoachPlan, CoachStep, LessonInput } from "./teach";

let nextId = 1;
const el = (type: string, name: string, y: number, extra: Partial<UiElement> = {}): UiElement => ({
  id: nextId++, type, x: 100, y, w: 220, h: 30, password: false, enabled: true, focused: false, hasValue: ["Edit", "Document", "ComboBox"].includes(type), readOnly: false, name, aid: "", help: "", value: "", ...extra,
});
const on = (patch: Partial<ScreenFlags>): ScreenFlags => ({ ...FLAGS_OFF, ...patch });
const signal = () => new AbortController().signal;
const snap = (elements: UiElement[], browser = false): Snapshot => ({ window: { x: 0, y: 0, w: 1200, h: 800 }, elements, focused: elements.find((e) => e.focused) ?? null, browser });

const PROFILE = {
  preferredName: "Usman",
  whatYouDo: "My business is M&U Ventures, run by me, Usman, and my business partner, Mehroz. We're building a business that provides custom websites, AI receptionists and practical automation for other businesses.\nMore text.",
};
const DETAILS = businessDetails(PROFILE);

// --- a fake window whose fields take the focus and the text --------------------------------------
type React = (target: UiElement, elements: UiElement[]) => void;
function fakeWindow(elements: UiElement[], react: React = () => undefined, win: WindowInfo = { handle: 7, process: "msedge", cls: "Chrome_WidgetWin_1", title: "Enquiry form - Microsoft Edge" }) {
  const log: string[] = [];
  const focusedEl = () => elements.find((e) => e.focused) ?? null;
  const find = (e: UiElement) => elements.find((x) => x.type === e.type && x.name === e.name) ?? null;
  const hands: Hands = {
    foreground: async () => win,
    windows: async () => [win],
    focus: async () => true,
    snapshot: async () => ({ ...snap(elements.map((e) => ({ ...e })), /edge|chrome/.test(win.process)) }),
    focused: async () => (focusedEl() ? { ...focusedEl()! } : null),
    at: async () => null,
    click: async (_h, x, y) => void log.push(`mouse ${x},${y}`),
    type: async (_h, text) => {
      const f = focusedEl();
      log.push(`type ${text} -> ${f?.name ?? "nothing"}`);
      if (f) f.value += text;
    },
    keys: async (_h, chord) => void log.push(`keys ${chord}`),
    wheel: async () => undefined,
    capture: async () => null,
    probe: async () => ({ front: win.handle, title: win.title, focused: focusedEl() ? { ...focusedEl()! } : null, at: null }),
    press: async (_h, element) => {
      const t = find(element);
      log.push(`press ${element.name}`);
      if (t && ["Edit", "Document", "ComboBox"].includes(t.type)) for (const e of elements) e.focused = e === t;
      if (t) react(t, elements);
      return "uia";
    },
  };
  return { hands, log, elements };
}
function form() {
  return [
    el("Edit", "First name", 100),
    el("Edit", "Last name", 140),
    el("Edit", "Business name", 180),
    el("Edit", "Email", 220),
    el("Edit", "Card number", 260),
    el("Edit", "Password", 300, { password: true }),
    el("Edit", "Tell us about your business", 340),
    el("Edit", "Who helps you run things?", 380),
    el("Edit", "Promo code", 420, { value: "SPRING" }),
    el("Button", "Submit", 480),
  ];
}
const act = (goal: string, hands: Hands, flags: ScreenFlags, minds: Minds = {}, details: Detail[] = DETAILS) =>
  runScreenAct({ goal }, { hands, minds, flags, signal: signal(), sleep: async () => undefined, details: () => details });

describe("form fill: the pure parts", () => {
  test("his details come from the business profile; nothing is invented", () => {
    const byKey = Object.fromEntries(DETAILS.map((d) => [d.key, d.value]));
    expect(byKey).toMatchObject({ first_name: "Usman", business: "M&U Ventures", partner: "Mehroz" });
    expect(byKey.services).toMatch(/^Custom websites, AI receptionists and practical automation for businesses\.$/);
    expect(byKey.email).toBeUndefined();
    expect(businessDetails({ preferredName: "Usman", email: "hello@example.com" }).find((d) => d.key === "email")?.value).toBe("hello@example.com");
    expect(businessDetails(null)).toEqual([]);
  });
  test("goals it answers to", () => {
    for (const g of ["fill this form with my business details", "fill in this form with my details", "fill it out using my details", "fill this form in for me", "complete the form with our company info"]) expect(FORM_FILL_GOAL.test(g)).toBe(true);
    for (const g of ["fill the name field with Test", "help me finish this form", "type my business name in there"]) expect(FORM_FILL_GOAL.test(g)).toBe(false);
  });
  test("only empty, ordinary text fields: never a password, card, code, search box or one he filled", () => {
    const names = fillableFields(snap(form())).map((e) => e.name);
    expect(names).toEqual(["First name", "Last name", "Business name", "Email", "Tell us about your business", "Who helps you run things?"]);
    expect(fillableFields(snap([el("Edit", "Search", 10), el("Edit", "Name", 50, { web: false })], true))).toEqual([]);
  });
  test("label rules and kind conflicts", () => {
    expect(ruleFor("Last name")).toBe("last_name");
    expect(ruleFor("First name")).toBe("first_name");
    expect(ruleFor("Company name")).toBe("business");
    expect(ruleFor("Email address")).toBe("email");
    expect(ruleFor("Who helps you run things?")).toBeNull();
    expect(conflicts("Email", "first_name")).toBe(true);
    expect(conflicts("Postcode", "business")).toBe(true);
    expect(conflicts("Who helps you run things?", "partner")).toBe(false);
  });
  test("rules first, then ONE Jev call for the leftovers; his values never go to Jev", async () => {
    const calls: unknown[] = [];
    const ask: FillAsk = async (fields, details) => {
      calls.push({ fields, details });
      return new Map(fields.map((f) => [f.id, { key: "partner", confidence: 0.83 }]));
    };
    const plan = await planFill(snap(form()), DETAILS, ask, { window: "Enquiry form" }, signal());
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toMatch(/Usman|M&U|Mehroz|Custom websites/);
    expect((calls[0] as { fields: Array<{ label: string }> }).fields.map((f) => f.label)).toEqual(["Who helps you run things?"]);
    expect(plan.matches.map((m) => [m.field.name, m.detail.value, m.via])).toEqual([
      ["First name", "Usman", "rules"],
      ["Business name", "M&U Ventures", "rules"],
      ["Tell us about your business", DETAILS.find((d) => d.key === "services")!.value, "rules"],
      ["Who helps you run things?", "Mehroz", "jev"],
    ]);
    expect(plan.unmatched.map((e) => e.name)).toEqual(["Last name", "Email"]);
  });
  test("an unsure or conflicting Jev answer leaves the field blank", async () => {
    const low: FillAsk = async (fields) => new Map(fields.map((f) => [f.id, { key: "partner", confidence: 0.4 }]));
    expect((await planFill(snap([el("Edit", "Who helps you run things?", 10)]), DETAILS, low, { window: "" }, signal())).matches).toEqual([]);
    const wrong: FillAsk = async (fields) => new Map(fields.map((f) => [f.id, { key: "first_name", confidence: 0.95 }]));
    expect((await planFill(snap([el("Edit", "Date of birth", 10)]), DETAILS, wrong, { window: "" }, signal())).matches).toEqual([]);
  });
  test("the line", () => {
    expect(fillLine(["First name", "Business name"], ["Email"], [], "Submit")).toBe('Filled "First name" and "Business name". I left "Email" blank: I don\'t have that saved. I haven\'t pressed "Submit".');
  });
});

describe("form fill through screen_act (flag formFill)", () => {
  test("fills every match, reads each back, never touches the card, password or Submit", async () => {
    const w = fakeWindow(form());
    const fill: FillAsk = async (fields) => new Map(fields.map((f) => [f.id, { key: "partner", confidence: 0.8 }]));
    const done = await act("fill this form with my business details", w.hands, on({ formFill: true, denylist: true, recheck: true }), { fill });
    expect(done).toMatchObject({ ok: true, filled: 4, path: "jev", ask: true });
    expect(done.said).toMatch(/^Filled "First name", "Business name", "Tell us about your business" and "Who helps you run things?\?"\. I left "Last name" and "Email" blank: I don't have those saved\. I haven't pressed "Submit"\.$/);
    const by = Object.fromEntries(w.elements.map((e) => [e.name, e.value]));
    expect(by).toMatchObject({ "First name": "Usman", "Business name": "M&U Ventures", "Who helps you run things?": "Mehroz", "Last name": "", Email: "", "Card number": "", Password: "", "Promo code": "SPRING" });
    expect(w.log.some((l) => /Submit|Card|Password/.test(l))).toBe(false);
  });
  test("with the flag off it's the planner's, as before", async () => {
    const w = fakeWindow(form());
    expect(await act("fill this form with my business details", w.hands, FLAGS_OFF)).toMatchObject({ ok: false, said: expect.stringMatching(/planner/) });
    expect(w.log).toEqual([]);
  });
  test("no saved details: says so, types nothing", async () => {
    const w = fakeWindow(form());
    expect(await act("fill this form with my details", w.hands, on({ formFill: true }), {}, [])).toMatchObject({ ok: false, said: expect.stringMatching(/don't have your business details/) });
    expect(w.log).toEqual([]);
  });
  test("a banking window is never typed into", async () => {
    const w = fakeWindow(form(), undefined, { handle: 7, process: "msedge", cls: "x", title: "NetBank - Commonwealth Bank - Microsoft Edge" });
    const done = await act("fill this form with my details", w.hands, on({ formFill: true }));
    expect(done.ok).toBe(false);
    expect(w.log.filter((l) => l.startsWith("type"))).toEqual([]);
  });
});

describe("one Jev call per step (flag jevStep)", () => {
  const step = (p: Partial<JevStep>): JevStep => ({ op: "click", opConfidence: 0.9, id: 3, targetConfidence: 0.9, ms: 300, ...p });
  test("jevStepAction: only confident clicks on listed controls, scrolls, and done after something", () => {
    const pool = [{ id: 3 }, { id: 4 }];
    expect(jevStepAction(step({}), pool, [])).toEqual({ do: "click", id: 3 });
    expect(jevStepAction(step({ targetConfidence: 0.55 }), pool, [])).toBeNull();
    expect(jevStepAction(step({ opConfidence: 0.5 }), pool, [])).toBeNull();
    expect(jevStepAction(step({ id: 99 }), pool, [])).toBeNull();
    expect(jevStepAction(step({ op: "scroll_down" }), pool, [])).toEqual({ do: "scroll", dir: "down" });
    expect(jevStepAction(step({ op: "done" }), pool, [])).toBeNull();
    expect(jevStepAction(step({ op: "done" }), pool, ["clicked x"])).toBeNull();
    expect(jevStepAction(step({ op: "type" }), pool, [])).toBeNull();
    expect(jevStepAction(step({ op: "ask" }), pool, [])).toBeNull();
    expect(jevStepAction(null, pool, [])).toBeNull();
  });
  function settingsPage() {
    const els = [el("ListItem", "Profile", 100), el("ListItem", "Notifications", 140), el("CheckBox", "Email alerts", 300, { toggled: true })];
    const w = fakeWindow(els, (t) => {
      if (t.name === "Email alerts") t.toggled = !t.toggled;
    }, { handle: 9, process: "notepad", cls: "x", title: "Acme settings" });
    return w;
  }
  test("Jev confident: its click is used and Groq isn't asked; unsure: Groq decides", async () => {
    const w = settingsPage();
    const ids = Object.fromEntries(w.elements.map((e) => [e.name, e.id]));
    let groq = 0;
    let n = 0;
    const minds: Minds = {
      step: async () => (n++ === 0 ? step({ id: ids.Notifications }) : n === 2 ? step({ id: ids["Email alerts"], targetConfidence: 0.5 }) : step({ op: "done", opConfidence: 0.9 })),
      decide: async () => (groq++, groq === 1 ? { do: "click", id: ids["Email alerts"] } : { do: "done" }),
    };
    const done = await act("help me turn off email alerts", w.hands, on({ jevStep: true }), minds);
    expect(done).toMatchObject({ ok: false, outcome: "unverified", decisions: { jev: 1, model: 2 } });
    expect(groq).toBe(2);
    expect(w.log).toEqual(["press Notifications", "press Email alerts"]);
    expect(w.elements.find((e) => e.name === "Email alerts")?.toggled).toBe(false);
  });
  test("off: Jev isn't asked at all", async () => {
    const w = settingsPage();
    let jev = 0;
    await act("help me turn off email alerts", w.hands, FLAGS_OFF, { step: async () => (jev++, null), decide: async () => ({ do: "done" }) });
    expect(jev).toBe(0);
  });
  test("a Jev click still passes the final-button gate", async () => {
    const els = [el("Button", "Delete account", 100)];
    const w = fakeWindow(els, undefined, { handle: 9, process: "notepad", cls: "x", title: "Acme settings" });
    const done = await act("help me tidy up my account", w.hands, on({ jevStep: true }), { step: async () => step({ id: els[0].id }), decide: async () => ({ do: "done" }) });
    expect(done).toMatchObject({ ok: false, confirm: "Delete account" });
    expect(w.log).toEqual([]);
  });
});

// --- lessons: read-back and replay ---------------------------------------------------------------
function fakeOverlay(): Overlay {
  return {
    glide: async () => undefined, ring: () => undefined, caption: () => undefined, tap: () => undefined, flash: () => undefined, hide: () => undefined, watch: () => undefined,
    onClick: () => () => undefined, follow: () => undefined, home: () => undefined, thinking: () => undefined, stat: async () => null, excludeFromCapture: async () => true, warm: () => undefined, pid: () => null, affinity: true, close: () => undefined,
  };
}
const fast = { pollMs: 5, fullEveryMs: 15, settleMs: 1, replyMs: 3000, coachWaitMs: 5, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))) };
function memoryReplays(): ReplayStore & { saved: Map<string, CoachPlan> } {
  const saved = new Map<string, CoachPlan>();
  return { saved, get: (app, goal) => saved.get(`${app}|${goal}`) ?? null, save: (app, goal, steps) => void saved.set(`${app}|${goal}`, { steps, pitfalls: [], model: "replay", ms: 0 }) };
}
/** A settings app: Notifications opens its page (Email alerts appears); the switch flips. `dead` names never react. */
function settingsApp(dead: string[] = [], rename: Record<string, string> = {}) {
  const els: UiElement[] = [el("ListItem", "Profile", 100), el("ListItem", rename.Notifications ?? "Notifications", 140)];
  return fakeWindow(els, (t, all) => {
    if (dead.includes(t.name)) return;
    if (/Notifications|Alerts/.test(t.name) && !all.some((e) => e.name === "Email alerts")) {
      t.selected = true;
      all.push(el("CheckBox", "Email alerts", 300, { toggled: true }));
    } else if (t.name === "Email alerts") t.toggled = !t.toggled;
  }, { handle: 11, process: "acme", cls: "x", title: "Acme settings" });
}
function planner(order: string[]) {
  const calls: LessonInput[] = [];
  const minds: LessonMinds = {
    async next(input) {
      calls.push(input);
      const i = calls.length - 1;
      if (i >= order.length) return { do: "done", say: "Email alerts are off." };
      const line = input.elements.split("\n").find((l) => l.includes(`"${order[i]}"`));
      return { do: "click", id: line ? Number(line.split(" ")[0]) : -1 };
    },
  };
  return { minds, calls };
}

describe("lessons: every driven step is verified or unobserved", () => {
  test("a click that changes the window is verified; one that changes nothing is unobserved and said", async () => {
    const w = settingsApp(["Profile"]);
    const { minds } = planner(["Profile", "Notifications", "Email alerts"]);
    const lesson = createLesson({ goal: "turn off email alerts", mode: "drive" }, { hands: w.hands, overlay: fakeOverlay(), minds, flags: () => FLAGS_OFF, ...fast });
    const out = await lesson.started;
    expect(out.results?.map((r) => [r.did, r.status])).toEqual([
      ['I clicked "Profile"', "unobserved"],
      ['I clicked "Notifications"', "verified"],
      ['I clicked "Email alerts"', "verified"],
    ]);
    expect(out.said).toMatch(/^Email alerts are off\. I couldn't confirm one step on screen \(clicked "Profile"\)/);
  });
});

describe("lessons: replay with no model calls (flag replay)", () => {
  test("a verified take-over is saved; the same task replays without the planner, coach or Jev", async () => {
    const replays = memoryReplays();
    const first = planner(["Notifications", "Email alerts"]);
    const a = settingsApp();
    const one = createLesson({ goal: "turn off email alerts", mode: "drive" }, { hands: a.hands, overlay: fakeOverlay(), minds: { ...first.minds, replays }, flags: () => on({ replay: true }), ...fast });
    expect((await one.started).ok).toBe(true);
    expect(first.calls.length).toBe(3);
    const saved = [...replays.saved.values()][0];
    expect(saved.steps.map((s: CoachStep) => [s.do, s.label, s.control])).toEqual([["click", "Notifications", "ListItem"], ["click", "Email alerts", "CheckBox"]]);

    // Again, fresh window: no planner, no coach, no Jev.
    const b = settingsApp();
    let asked = 0;
    const counting: LessonMinds = { next: async () => (asked++, null), coach: async () => (asked++, null), pick: async () => (asked++, null), replays };
    const two = createLesson({ goal: "turn off email alerts", mode: "drive" }, { hands: b.hands, overlay: fakeOverlay(), minds: counting, flags: () => on({ replay: true }), ...fast });
    const out = await two.started;
    expect(out).toMatchObject({ ok: true, said: "Done." });
    expect(asked).toBe(0);
    expect(b.elements.find((e) => e.name === "Email alerts")?.toggled).toBe(false);
    expect(out.results?.every((r) => r.status === "verified")).toBe(true);
  });
  test("a renamed control: Jev repairs it; a lesson with an unobserved step isn't saved", async () => {
    const replays = memoryReplays();
    replays.save("Acme settings", "turn off email alerts", [
      { do: "click", label: "Notifications", control: "ListItem" },
      { do: "click", label: "Email alerts", control: "CheckBox" },
    ]);
    const w = settingsApp([], { Notifications: "Alerts" });
    let picks = 0;
    const minds: LessonMinds = {
      next: async () => null,
      pick: async (input) => (picks++, { id: input.candidates.find((c) => /Alerts/.test(c.text))?.id ?? null, confidence: 0.9, ms: 1 }),
      replays,
    };
    const lesson = createLesson({ goal: "turn off email alerts", mode: "drive" }, { hands: w.hands, overlay: fakeOverlay(), minds, flags: () => on({ replay: true }), ...fast });
    expect(await lesson.started).toMatchObject({ ok: true });
    expect(picks).toBe(1);

    const dead = memoryReplays();
    const p = planner(["Profile", "Notifications", "Email alerts"]);
    const d = settingsApp(["Profile"]);
    const l2 = createLesson({ goal: "turn off email alerts", mode: "drive" }, { hands: d.hands, overlay: fakeOverlay(), minds: { ...p.minds, replays: dead }, flags: () => on({ replay: true }), ...fast });
    await l2.started;
    expect(dead.saved.size).toBe(0);
  });
  test("a saved step that's gone: planning takes over", async () => {
    const replays = memoryReplays();
    replays.save("Acme settings", "turn off email alerts", [{ do: "click", label: "Nowhere", control: "ListItem" }]);
    const p = planner(["Notifications", "Email alerts"]);
    const w = settingsApp();
    const lesson = createLesson({ goal: "turn off email alerts", mode: "drive" }, { hands: w.hands, overlay: fakeOverlay(), minds: { ...p.minds, replays }, flags: () => on({ replay: true }), ...fast });
    expect(await lesson.started).toMatchObject({ ok: true });
    expect(p.calls.length).toBeGreaterThan(0);
    expect(w.elements.find((e) => e.name === "Email alerts")?.toggled).toBe(false);
  });
  test("off: nothing is saved or replayed", async () => {
    const replays = memoryReplays();
    const p = planner(["Notifications", "Email alerts"]);
    const w = settingsApp();
    await createLesson({ goal: "turn off email alerts", mode: "drive" }, { hands: w.hands, overlay: fakeOverlay(), minds: { ...p.minds, replays }, flags: () => FLAGS_OFF, ...fast }).started;
    expect(replays.saved.size).toBe(0);
  });
});

// --- voice: "open Discord so you can control it" → pc_act drive_app → POST /screen/cdp -------------
describe("open an Electron app for Jarvis to drive (voice routing)", () => {
  test("driveAppIntent: only a listed app, and only when he says it's for Jarvis to drive", async () => {
    const { driveAppIntent } = await import("./cdp");
    expect(driveAppIntent("Open Discord so you can control it")).toEqual({ app: "discord" });
    expect(driveAppIntent("launch VS Code for you to drive")).toEqual({ app: "vscode" });
    expect(driveAppIntent("open slack in control mode")).toEqual({ app: "slack" });
    expect(driveAppIntent("get obsidian open so jarvis can use it")).toEqual({ app: "obsidian" });
    expect(driveAppIntent("open discord")).toBeNull();
    expect(driveAppIntent("open notepad so you can control it")).toBeNull();
    expect(driveAppIntent("open obsidian so I can write")).toBeNull();
  });
  test("the Jev router's open_app becomes drive_app for those words", async () => {
    const { buildCall } = await import("../jev-router");
    expect(buildCall("pc.open_app", "open Discord so you can control it", {}, { apps: [], skills: [] })).toEqual({ name: "pc_act", arguments: { action: "drive_app", target: "discord" } });
  });
  test("the voice rules answer it with no model call", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { freeVoice } = await import("../free-voice");
    const calls: string[] = [];
    const voice = freeVoice(mkdtempSync(join(tmpdir(), "round3-voice-")), {
      key: (name: string) => ({ GROQ_API_KEY: "g", TYPESAFE_API_KEY: "t" })[name] ?? "",
      fetch: (async (url: string) => (calls.push(String(url)), new Response("{}"))) as unknown as typeof fetch,
    });
    const result: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: "open VS Code so you can drive it" }] });
    expect(result.model).toBe("rules");
    expect(result.tool_calls[0].function).toEqual({ name: "pc_act", arguments: JSON.stringify({ action: "drive_app", target: "vscode" }) });
    // Round 10: Jev is asked first; this fake answers nothing Jev-shaped, so the rule runs as the labelled fallback. No brain call.
    expect(calls.every((u) => u.includes("typesafe"))).toBe(true);
    expect(result.router).toMatchObject({ source: "fallback" });
  });
});

describe("recovery: a named control that isn't on this page", () => {
  function app() {
    const els = [el("ListItem", "Profile", 100), el("ListItem", "Notifications", 140)];
    return fakeWindow(els, (t, all) => {
      if (t.name === "Notifications" && !all.some((e) => e.name === "Email alerts")) all.push(el("CheckBox", "Email alerts", 300, { toggled: true }));
      else if (t.name === "Email alerts") t.toggled = !t.toggled;
    }, { handle: 9, process: "acme", cls: "x", title: "Acme settings" });
  }
  test("the planner finds the way to it and finishes the task", async () => {
    const w = app();
    const ids = () => Object.fromEntries(w.elements.map((e) => [e.name, e.id]));
    let n = 0;
    const minds: Minds = { decide: async () => (n++ === 0 ? { do: "click", id: ids().Notifications } : n === 2 ? { do: "click", id: ids()["Email alerts"] } : { do: "done" }) };
    const done = await act("click Email alerts", w.hands, FLAGS_OFF, minds);
    expect(done).toMatchObject({ ok: false, outcome: "unverified", path: "model" });
    expect(w.elements.find((e) => e.name === "Email alerts")?.toggled).toBe(false);
  });
  test("without a planner he's asked, as before", async () => {
    const w = app();
    expect(await act("click Email alerts", w.hands, FLAGS_OFF, {})).toMatchObject({ ok: false, said: expect.stringMatching(/can't see "Email alerts"/) });
  });
});

describe("Enter in an editor isn't a form submit", () => {
  test("Excel's Name Box: Enter goes; a web form field still asks; a chat box still asks", async () => {
    const { vetAction } = await import("./plan");
    const box = el("ComboBox", "Name Box");
    const enter = { do: "key" as const, keys: "enter", label: "enter" };
    expect(vetAction(enter, { focused: box, window: { process: "EXCEL", title: "Book1 - Excel" } }).ok).toBe(true);
    expect(vetAction(enter, { focused: el("Edit", "Full name"), window: { process: "msedge", title: "Enquiry - Microsoft Edge" } }).ok).toBe(false);
    expect(vetAction(enter, { focused: el("Edit", "Type a message"), window: { process: "EXCEL", title: "x" } }).ok).toBe(false);
  });
});
