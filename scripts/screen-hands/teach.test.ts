import { describe, expect, test } from "bun:test";
import { lessonShortcut } from "../../src/lib/lesson-words";
import { lessonTurn } from "../../src/lib/screen-lesson";
import { aimPoint, glideMs, overlayCommand, overlayExePath, parseOverlayEvent, ringRect, whereOn } from "./overlay";
import type { Snapshot, UiElement } from "./plan";
import {
  appName,
  clickOn,
  guideTarget,
  judgeProbe,
  judgeSnapshot,
  unaskedChoice,
  lessonControl,
  lessonIntent,
  parseGuide,
  parseLessonAction,
  parseProbe,
  restoreTo,
  stepLine,
  stepMode,
  typingSettled,
  type Probe,
} from "./teach";

let id = 1;
const el = (type: string, name: string, x: number, y: number, extra: Partial<UiElement> = {}): UiElement => ({
  id: id++, type, x, y, w: 100, h: 30, password: false, enabled: true, focused: false, hasValue: false, readOnly: false, name, aid: "", help: "", value: "", ...extra,
});
const WIN = { x: 0, y: 0, w: 1400, h: 900 };
const snap = (elements: UiElement[], focused: UiElement | null = null): Snapshot => ({ window: WIN, elements, focused, browser: false });
const probe = (p: Partial<Probe>): Probe => ({ front: 7, title: "notes.txt - Notepad", focused: null, at: null, ...p });

describe("routing: which words start or steer a lesson", () => {
  test("the owner's teach phrasings start a teach lesson with the task as the goal", () => {
    expect(lessonIntent("Jarvis, show me how to change the font")).toEqual({ mode: "teach", goal: "change the font" });
    expect(lessonIntent("teach me how to publish this post")).toEqual({ mode: "teach", goal: "publish this post" });
    expect(lessonIntent("teach me to add a table")).toEqual({ mode: "teach", goal: "add a table" });
    expect(lessonIntent("where do I click to change the font?")).toEqual({ mode: "teach", goal: "change the font" });
    expect(lessonIntent("walk me through setting up a signature")).toEqual({ mode: "teach", goal: "setting up a signature" });
    expect(lessonIntent("can you walk me through how to export this as a PDF")).toEqual({ mode: "teach", goal: "export this as a PDF" });
    expect(lessonIntent("how do I turn on word wrap in here")).toEqual({ mode: "teach", goal: "turn on word wrap" });
  });

  test("a take-over with a task starts a drive lesson", () => {
    expect(lessonIntent("take over and fill in this form")).toEqual({ mode: "drive", goal: "fill in this form" });
    expect(lessonIntent("you do it: change the font to Arial")).toEqual({ mode: "drive", goal: "change the font to Arial" });
  });

  test("everyday questions and orders are not lessons", () => {
    for (const u of ["how do I cook rice", "show me the weather", "teach me something", "open notepad", "click the Name field", "what's on my screen", "just do it", "where do I find my downloads", "where do I go to see my leads"])
      expect(lessonIntent(u)).toBeNull();
    expect(lessonIntent("where do I change the font")).toEqual({ mode: "teach", goal: "change the font" });
  });

  test("controls while a lesson runs", () => {
    const cases: Array<[string, string | null]> = [
      ["next", "next"], ["Done.", "next"], ["I did it", "next"], ["okay next", "next"], ["what's next?", "next"],
      ["skip", "skip"], ["skip this one", "skip"],
      ["just do it", "drive"], ["you do it", "drive"], ["take over", "drive"], ["Jarvis, you take over", "drive"], ["do it for me", "drive"],
      ["I can't find it", "stuck"], ["where is it?", "stuck"], ["I'm stuck", "stuck"], ["you do this one", "stuck"], ["do that one for me", "stuck"], ["you do the rest", "drive"],
      ["say that again", "repeat"], ["which one?", "repeat"],
      ["stop", "stop"], ["never mind", "stop"], ["that's enough", "stop"],
      ["let me do it", "teach"],
      ["yes", null], ["open notepad", null], ["what's the weather", null],
    ];
    for (const [u, want] of cases) expect([u, lessonControl(u)]).toEqual([u, want as any]);
  });

  test("mode per step: teach by default; stuck or two misses hand that step to Jarvis", () => {
    expect(stepMode("teach")).toBe("teach");
    expect(stepMode("teach", { misses: 1 })).toBe("teach");
    expect(stepMode("teach", { misses: 2 })).toBe("drive");
    expect(stepMode("teach", { stuck: true })).toBe("drive");
    expect(stepMode("drive")).toBe("drive");
  });
});

describe("what he hears", () => {
  test("one short line naming the control and where it is", () => {
    expect(stepLine({ do: "click", element: el("Button", "Settings", 1300, 40) }, WIN, "teach")).toBe("That one — Settings, top right.");
    expect(stepLine({ do: "click", element: el("Button", "Publish", 1250, 30) }, WIN, "teach")).toBe("That one — Publish, top right.");
    expect(stepLine({ do: "click", element: el("Edit", "Name", 600, 420) }, WIN, "teach")).toBe("Click in Name, in the middle.");
    expect(stepLine({ do: "key", keys: "ctrl+s" }, WIN, "teach")).toBe("Press Ctrl+S.");
    expect(stepLine({ do: "click", element: el("Button", "Save", 40, 850) }, WIN, "drive")).toBe("Clicking Save.");
    expect(whereOn({ x: 20, y: 20, w: 10, h: 10 }, WIN)).toBe("top left");
  });
});

describe("advance detection: has he done the step?", () => {
  const settings = el("Button", "Settings", 1300, 40, { invokable: true });
  const step = { do: "click" as const, element: settings };

  test("nothing changed: keep waiting", () => {
    expect(judgeProbe(step, 7, settings, probe({ at: settings }), probe({ at: { ...settings } })).advanced).toBe(false);
  });
  test("a new window of the app (a dialog) opened", () => {
    expect(judgeProbe(step, 7, settings, probe({ at: settings }), probe({ front: 99, at: settings }))).toEqual({ advanced: true, why: "a new window opened" });
  });
  test("he glanced at Jarvis's page or another app: ignored", () => {
    expect(judgeProbe(step, 7, settings, probe({ at: settings }), probe({ front: 99, frontUnrelated: true }))).toEqual({ advanced: false, ignore: true });
  });
  test("the window's title changed", () => {
    expect(judgeProbe(step, 7, settings, probe({ at: settings }), probe({ title: "Settings - Notepad", at: settings })).advanced).toBe(true);
  });
  test("the menu or expander under the ring opened (UIA ExpandCollapse)", () => {
    const font = el("Button", "Font", 200, 450, { expanded: false });
    expect(judgeProbe({ do: "click", element: font }, 7, font, probe({ at: font }), probe({ at: { ...font, expanded: true } }))).toEqual({ advanced: true, why: "it opened" });
  });
  test("a checkbox got ticked; a tab got selected", () => {
    const box = el("CheckBox", "Word wrap", 200, 500, { toggled: false });
    expect(judgeProbe({ do: "click", element: box }, 7, box, probe({ at: box }), probe({ at: { ...box, toggled: true } })).advanced).toBe(true);
    const tab = el("TabItem", "Layout", 300, 60);
    expect(judgeProbe({ do: "click", element: tab }, 7, tab, probe({ at: tab }), probe({ at: { ...tab, selected: true } })).advanced).toBe(true);
  });
  test("a field took the focus", () => {
    const name = el("Edit", "Name", 300, 300, { hasValue: true });
    expect(judgeProbe({ do: "click", element: name }, 7, name, probe({ at: name }), probe({ at: name, focused: { ...name, focused: true } }))).toEqual({ advanced: true, why: "it has the focus" });
  });
  test("a different control under the ring now: take a proper look", () => {
    expect(judgeProbe(step, 7, settings, probe({ at: settings }), probe({ at: el("Button", "Back", 1300, 40) }))).toEqual({ advanced: false, check: true });
  });
  test("typing: seen as typing; settled after a pause or when he leaves the field", () => {
    const name = el("Edit", "Name", 300, 300, { hasValue: true });
    const typing = judgeProbe({ do: "type", element: name }, 7, name, probe({ focused: { ...name, focused: true } }), probe({ focused: { ...name, focused: true, value: "Te" } }));
    expect(typing).toEqual({ advanced: false, typing: true });
    expect(typingSettled(1000, 1500, false)).toBe(false);
    expect(typingSettled(1000, 2300, false)).toBe(true);
    expect(typingSettled(1000, 1100, true)).toBe(true);
  });

  test("full snapshot: a menu opened (new items appeared)", () => {
    const file = el("MenuItem", "File", 10, 40);
    const before = snap([file]);
    const after = snap([{ ...file }, el("MenuItem", "New tab", 10, 80), el("MenuItem", "Save", 10, 110)]);
    expect(judgeSnapshot({ do: "click", element: file }, file, before, after)).toEqual({ advanced: true, why: "something opened" });
  });
  test("full snapshot: the target went away (the page changed)", () => {
    const back = el("Button", "Back", 10, 10);
    expect(judgeSnapshot(step, settings, snap([settings, back]), snap([back])).advanced).toBe(true);
  });
  test("full snapshot: a scroll only moves things; the ring follows the control", () => {
    const a = el("Button", "One", 100, 300), b = el("Button", "Two", 100, 400), c = el("Button", "Three", 100, 500);
    const shifted = [a, b, c].map((e) => ({ ...e, y: e.y - 120 }));
    const v = judgeSnapshot({ do: "click", element: b }, b, snap([a, b, c]), snap(shifted));
    expect(v.advanced).toBe(false);
    expect(!v.advanced && v.moved?.y).toBe(280);
  });
  test("full snapshot: unchanged means keep waiting", () => {
    expect(judgeSnapshot(step, settings, snap([settings]), snap([{ ...settings }])).advanced).toBe(false);
  });
  test("an item in an open drop-down that he never named is his choice", () => {
    const family = el("ComboBox", "Family", 800, 380, { expanded: true });
    const calibri = el("ListItem", "Calibri", 800, 420);
    const s = snap([family, calibri]);
    expect(unaskedChoice(calibri, s, "change the font", [])).toBe("Family");
    expect(unaskedChoice(calibri, s, "change the font to Calibri", [])).toBeNull();
    expect(unaskedChoice(calibri, s, "change the font", ['he answered: "calibri"'])).toBeNull();
    expect(unaskedChoice(calibri, snap([{ ...family, expanded: false }, calibri]), "change the font", [])).toBeNull();
    expect(unaskedChoice(el("Button", "Save", 1, 1), s, "change the font", [])).toBeNull();
  });
  test("his click on the ringed control counts; one beside it doesn't", () => {
    expect(clickOn({ x: 1305, y: 45 }, settings)).toBe(true);
    expect(clickOn({ x: 1415, y: 45 }, settings, 10)).toBe(false);
  });
});

describe("his pointer after a SendInput fallback", () => {
  test("put back where it was", () => expect(restoreTo({ x: 10, y: 20 }, { x: 500, y: 300 }, { x: 500, y: 300 })).toEqual({ x: 10, y: 20 }));
  test("left alone if he has grabbed the mouse since", () => expect(restoreTo({ x: 10, y: 20 }, { x: 500, y: 300 }, { x: 640, y: 90 })).toBeNull());
  test("nothing to do if it was already there, or unknown", () => {
    expect(restoreTo({ x: 500, y: 300 }, { x: 500, y: 300 }, { x: 500, y: 300 })).toBeNull();
    expect(restoreTo(null, { x: 500, y: 300 }, { x: 500, y: 300 })).toBeNull();
  });
});

describe("the planner, the web lookup and the native text", () => {
  test("planner actions", () => {
    expect(parseLessonAction('{"do":"click","id":4}')).toEqual({ do: "click", id: 4 });
    expect(parseLessonAction('{"do":"type","id":2}')).toEqual({ do: "type", id: 2 });
    expect(parseLessonAction('{"do":"unsure"}')).toEqual({ do: "unsure" });
    expect(parseLessonAction('{"do":"done","say":"Now pick the font you like."}')).toEqual({ do: "done", say: "Now pick the font you like." });
    expect(parseLessonAction('{"do":"rm -rf"}')).toBeNull();
    expect(parseLessonAction("not json")).toBeNull();
  });
  test("a web answer becomes numbered steps; each names its control", () => {
    const guide = parseGuide('Here you go:\n1. Click the "Settings" gear at the top right [1].\n2. Expand **Font**.\n3) Pick a family from "Family".\nThanks');
    expect(guide).toEqual(['Click the "Settings" gear at the top right .', "Expand **Font**.", 'Pick a family from "Family".']);
    expect(guide.map(guideTarget)).toEqual(["Settings", "Font", "Family"]);
    expect(guideTarget("Open the menu")).toBeNull();
    expect(appName("notes.txt - Notepad", "Notepad")).toBe("Notepad");
    expect(appName("", "msedge")).toBe("Microsoft Edge");
  });
  test("the native probe rows", () => {
    const p = parseProbe("P\t123\tnotes.txt - Notepad\nF\t-1\tDocument\t10\t20\t300\t200\tefv\tText editor\t\t\thello\nA\t-1\tButton\t1300\t40\t30\t30\teCI\tFont\t\t\t\n");
    expect(p.front).toBe(123);
    expect(p.title).toBe("notes.txt - Notepad");
    expect(p.focused).toMatchObject({ type: "Document", focused: true, value: "hello" });
    expect(p.at).toMatchObject({ type: "Button", name: "Font", expanded: false, invokable: true });
  });
});

describe("the overlay's maths and protocol", () => {
  test("glide time: quick hops, never slow across monitors", () => {
    expect(glideMs(null, { x: 5, y: 5 })).toBe(220);
    expect(glideMs({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(0);
    expect(glideMs({ x: 0, y: 0 }, { x: 300, y: 0 })).toBe(260);
    expect(glideMs({ x: -1920, y: 0 }, { x: 2500, y: 1400 })).toBe(650);
  });
  test("aim: the centre, or near the label on wide rows", () => {
    expect(aimPoint({ x: 100, y: 100, w: 40, h: 20 })).toEqual({ x: 120, y: 110 });
    expect(aimPoint({ x: 214, y: 446, w: 1012, h: 68 })).toEqual({ x: 270, y: 480 });
    // An open settings section (UIA's rectangle covers its whole body): aim and ring its header.
    const open = { x: 52, y: 288, w: 1020, h: 322, expanded: true };
    expect(aimPoint(open)).toEqual({ x: 108, y: 322 });
    expect(ringRect(open)).toEqual({ x: 52, y: 288, w: 1020, h: 72 });
    expect(ringRect({ x: 1, y: 2, w: 30, h: 20 })).toEqual({ x: 1, y: 2, w: 30, h: 20 });
  });
  test("commands carry validated numbers and base64 text only", () => {
    expect(overlayCommand.move({ x: 10.4, y: -1080 }, 300)).toBe("move 10 -1080 300");
    expect(overlayCommand.say('"; Remove-Item C:\\ -Recurse #')).toMatch(/^say [A-Za-z0-9+/=]+$/);
    expect(overlayCommand.say("")).toBe("say");
    expect(() => overlayCommand.ring({ x: NaN, y: 0, w: 1, h: 1 })).toThrow();
  });
  test("the compiled helper's file name carries the source hash, so an edit rebuilds it", () => {
    const one = overlayExePath("C:/Local", "class A {}"), two = overlayExePath("C:/Local", "class B {}");
    expect(one).toMatch(/AgenticOS[\\/]jarvis-overlay[\\/]jarvis-overlay-[0-9a-f]{12}\.exe$/);
    expect(one).not.toBe(two);
    expect(overlayExePath("C:/Local", "class A {}")).toBe(one);
  });
  test("events", () => {
    expect(parseOverlayEvent("ready 1 123")).toEqual({ type: "ready", affinity: true });
    expect(parseOverlayEvent("click left -500 300")).toEqual({ type: "click", button: "left", x: -500, y: 300 });
    expect(parseOverlayEvent("click left x y")).toBeNull();
    expect(parseOverlayEvent("nonsense")).toBeNull();
  });
});


describe("the voice client steers a running lesson with no model call", () => {
  const teaching = { state: "teaching" as const };
  test("controls while teaching; ordinary words pass through", () => {
    expect(lessonShortcut("next", teaching)).toEqual({ control: "next" });
    expect(lessonShortcut("just do it", teaching)).toEqual({ control: "drive" });
    expect(lessonShortcut("stop", teaching)).toEqual({ control: "stop" });
    expect(lessonShortcut("what's the weather", teaching)).toBeNull();
    expect(lessonShortcut("next", null)).toBeNull();
    expect(lessonShortcut("next", { state: "ended" })).toBeNull();
  });
  test("a final button: only a clear yes confirms that one button; no leaves it", () => {
    const confirm = { state: "confirm" as const, confirm: "Submit" };
    expect(lessonShortcut("yes", confirm)).toEqual({ confirm: "Submit" });
    expect(lessonShortcut("yes, but wait", confirm)).toBeNull();
    expect(lessonShortcut("no", confirm)).toEqual({ control: "skip" });
    expect(lessonShortcut("stop", confirm)).toEqual({ control: "stop" });
    expect(lessonShortcut("what's the weather", confirm)).toBeNull();
  });
  test("Jarvis asked a question: his next words are the answer", () => {
    expect(lessonShortcut("Arial please", { state: "ask" })).toEqual({ answer: "Arial" });
    expect(lessonShortcut("never mind", { state: "ask" })).toEqual({ control: "stop" });
  });
  test("the turn: a control becomes one screen_teach call, and its result is spoken as it is", () => {
    const lesson = { id: "l1", goal: "change the font", state: "teaching" as const };
    const call = lessonTurn([{ role: "user", content: "next" }], lesson);
    expect(call?.tool_calls?.[0].function).toEqual({ name: "screen_teach", arguments: '{"control":"next"}' });
    const spoken = lessonTurn(
      [
        { role: "user", content: "next" },
        { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "screen_teach" } }] },
        { role: "tool", content: "That one — Font, in the middle." },
      ],
      lesson,
    );
    expect(spoken).toEqual({ content: "That one — Font, in the middle." });
    expect(lessonTurn([{ role: "user", content: "what's the time" }], lesson)).toBeNull();
    expect(lessonTurn([{ role: "user", content: "next" }], null)).toBeNull();
  });
});
