// Review REVIEW-JEV findings 1 and 2 (27 Sep 2026 night), on a fake Windows. Synthetic pages only.
//  1. The money fence runs before EVERY input, not just at the start: a page that moves to a bank, a
//     window renamed to a broker, or a browser whose address bar now shows a bank ends the run.
//  2. The final-button gate: the labels the old regex let through, Yes/OK in a follow-up dialog, the
//     unlabelled chat composer's Enter, and a spoken yes that covers ONE key press, as for clicks.
import { describe, expect, test } from "bun:test";
import type { WindowInfo } from "../jarvis-skills/windows";
import { createScreenHands, runScreenAct, type Hands, type Minds } from "./index";
import { AFFIRM_BUTTON, dialogTextOf, vetAction, type UiElement } from "./plan";
import { FLAGS_OFF } from "./flags";

let id = 5000;
const el = (type: string, name: string, y: number, extra: Partial<UiElement> = {}): UiElement => ({
  id: id++, type, x: 100, y, w: 300, h: 30, password: false, enabled: true, focused: false, hasValue: ["Edit", "Document"].includes(type), readOnly: false, name, aid: "", help: "", value: "", ...extra,
});
type Page = { elements: UiElement[]; title: string; onClick?: (e: UiElement, p: Page) => void };
function fake(page: Page, base: Omit<WindowInfo, "title"> = { handle: 7, process: "Notepad", cls: "Notepad" }) {
  const log: string[] = [];
  const win = () => ({ ...base, title: page.title });
  const under = (x: number, y: number) => page.elements.filter((e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h)[0] ?? null;
  const hands: Hands = {
    foreground: async () => win(),
    windows: async () => [win()],
    focus: async () => true,
    snapshot: async () => ({ window: { x: 0, y: 0, w: 1200, h: 800 }, elements: page.elements.map((e) => ({ ...e })), focused: page.elements.find((e) => e.focused) ?? null, browser: base.process === "chrome" }),
    focused: async () => page.elements.find((e) => e.focused) ?? null,
    at: async (x, y) => under(x, y),
    click: async (_h, x, y) => {
      const hit = under(x, y);
      log.push(`click ${hit?.name ?? "?"}`);
      if (hit) page.onClick?.(hit, page);
    },
    type: async (_h, t) => void log.push(`type ${t}`),
    keys: async (_h, k) => void log.push(`keys ${k}`),
    wheel: async () => void log.push("wheel"),
    capture: async () => null,
  };
  return { hands, log };
}
const run = (goal: string, hands: Hands, extra: Partial<Parameters<typeof runScreenAct>[1]> = {}, confirm?: string) =>
  runScreenAct({ goal, ...(confirm ? { confirm } : {}) }, { hands, flags: FLAGS_OFF, signal: new AbortController().signal, sleep: async () => undefined, ...extra });

describe("finding 1: the money fence is re-checked before every step", () => {
  test("the window's title turns into a bank mid-run: the next click never happens", async () => {
    const page: Page = { title: "Offers - Google Chrome", elements: [el("Button", "One", 100), el("Button", "Two", 160)] };
    page.onClick = (e, p) => void (e.name === "One" && (p.title = "NetBank - CommBank - Google Chrome"));
    const { hands, log } = fake(page);
    const done = await run("click One then click Two", hands);
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(log).toEqual(["click One"]);
  });
  test("a broker's window title (Stake) is refused even though no bank word appears", async () => {
    const page: Page = { title: "Stake | Wall St - Google Chrome", elements: [el("Button", "Buy", 100)] };
    const { hands, log } = fake(page, { handle: 8, process: "chrome", cls: "Chrome_WidgetWin_1" });
    expect(await run("click Buy", hands, {}, "Buy")).toMatchObject({ ok: false, refused: true });
    expect(log).toEqual([]);
  });
  test("the browser's address bar moves to a bank while the title stays harmless: refused", async () => {
    const bar = el("Edit", "Address and search bar", 20, { value: "youtube.com", web: false });
    const page: Page = { title: "New Tab - Google Chrome", elements: [bar, el("Button", "Go", 100), el("Button", "Next", 160)] };
    page.onClick = (e) => void (e.name === "Go" && (bar.value = "https://www.ing.com.au/securebanking/"));
    const { hands, log } = fake(page, { handle: 9, process: "chrome", cls: "Chrome_WidgetWin_1" });
    const done = await run("click Go then click Next", hands);
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(log).toEqual(["click Go"]);
  });
  test("the planner path (open goals) is fenced the same way", async () => {
    const page: Page = { title: "Shop - Google Chrome", elements: [el("Button", "Continue", 100), el("Button", "Transfer now", 160)] };
    page.onClick = (e, p) => void (e.name === "Continue" && (p.title = "Pay anyone - Westpac - Google Chrome"));
    const { hands, log } = fake(page);
    let n = 0;
    const minds: Minds = { decide: async (input) => ({ do: "click", id: Number(input.elements.split("\n").find((l) => l.includes(n++ === 0 ? "Continue" : "Transfer"))!.split(" ")[0]) }) };
    const done = await run("help me finish this page", hands, { minds });
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(log).toEqual(["click Continue"]);
  });
});

describe("finding 2: the final-button gate", () => {
  // Confirm purchase / Place order / Transfer / Pay moved to the money-button test below (refused, not asked).
  test.each(["Empty Recycle Bin", "Trash", "Move to Bin", "Discard", "Change password", "Approve", "Send", "Publish", "Delete account", "Commit changes", "Factory reset", "Revoke access", "Replace the file in the destination", "Don't save", "Close without saving", "Authorize", "Grant access", "Force push", "Leave group", "Block", "Reset"])(
    "%p asks for his spoken yes",
    (label) => {
      const v = vetAction({ do: "click", element: el("Button", label, 100) }, { focused: null });
      expect(v).toMatchObject({ ok: false, confirm: label });
      expect(vetAction({ do: "click", element: el("Button", label, 100) }, { focused: null, confirmed: label })).toEqual({ ok: true });
    },
  );
  test("harmless labels still press without a question", () => {
    for (const label of ["Next", "Cancel", "Format", "Reply", "Settings", "OK", "Yes", "Replace"]) expect({ label, v: vetAction({ do: "click", element: el("Button", label, 100) }, { focused: null }) }).toEqual({ label, v: { ok: true } });
  });
  test("Yes / OK in a follow-up dialog raised by a final press, or one that says it's final", () => {
    const yes = el("Button", "Yes", 100);
    expect(vetAction({ do: "click", element: yes }, { focused: null, followUp: true })).toMatchObject({ ok: false, confirm: "Yes" });
    const text = dialogTextOf({ elements: [el("Text", "Are you sure you want to permanently delete these 3 items?", 50)] }, "Delete Multiple Items");
    for (const label of ["Yes", "OK", "Continue", "Yes, delete"]) expect(vetAction({ do: "click", element: el("Button", label, 100) }, { focused: null, dialogText: text })).toMatchObject({ ok: false, confirm: label });
    // Enter / Space / Y on that dialog press its default button: the same question.
    for (const keys of ["enter", "space", "alt+y"]) expect(vetAction({ do: "key", keys, label: keys }, { focused: yes, dialogText: text })).toMatchObject({ ok: false, confirm: keys });
    // An ordinary dialog's OK is fine.
    expect(vetAction({ do: "click", element: el("Button", "OK", 100) }, { focused: null, dialogText: dialogTextOf({ elements: [el("Text", "Settings saved.", 50)] }, "Notepad") })).toEqual({ ok: true });
    expect(AFFIRM_BUTTON.test("Next")).toBe(false);
  });
  test("in a run: the confirmed Delete is pressed, the dialog's Yes it raised is asked about", async () => {
    const page: Page = { title: "Files - Explorer", elements: [el("Button", "Delete", 100)] };
    page.onClick = (e, p) => {
      if (e.name === "Delete") p.elements = [el("Text", "Move these files?", 50), el("Button", "Yes", 100), el("Button", "No", 160)];
    };
    const { hands, log } = fake(page);
    const done = await run("click Delete then click Yes", hands, {}, "Delete");
    expect(done).toMatchObject({ ok: false, confirm: "Yes" });
    expect(log).toEqual(["click Delete"]);
  });
  test("across runs: after a final press, the next run's dialog OK needs its own yes (server-side memory)", async () => {
    let now = 1_000_000;
    const page: Page = { title: "Settings - App", elements: [el("Button", "Delete", 100)] };
    page.onClick = (e, p) => {
      if (e.name === "Delete") p.elements = [el("Text", "Done.", 50), el("Button", "OK", 100)];
    };
    const f = fake(page);
    const screen = createScreenHands({ key: () => "", hands: f.hands, flags: () => ({ ...FLAGS_OFF }), audit: null, jarvisChrome: null, now: () => now });
    const signal = new AbortController().signal;
    expect(await screen.act({ goal: "click Delete", confirm: "Delete" }, signal)).toMatchObject({ ok: true });
    now += 10_000;
    expect(await screen.act({ goal: "click OK" }, signal)).toMatchObject({ ok: false, confirm: "OK" });
    expect(f.log).toEqual(["click Delete"]);
    // Two minutes later, an OK is an ordinary OK again.
    now += 3 * 60_000;
    expect(await screen.act({ goal: "click OK" }, signal)).toMatchObject({ ok: true });
    expect(f.log).toEqual(["click Delete", "click OK"]);
  });
  test("a spoken yes covers ONE key press (Enter on a focused Send), exactly as for clicks", async () => {
    const page: Page = { title: "Chat - App", elements: [el("Button", "Send", 100, { focused: true })] };
    const { hands, log } = fake(page);
    const done = await run("press enter then press enter", hands, {}, "enter");
    expect(done).toMatchObject({ ok: false, confirm: "enter" });
    expect(log).toEqual(["keys enter"]);
  });
  test("Ctrl+Enter's yes is single use too", async () => {
    const page: Page = { title: "Mail - App", elements: [el("Document", "", 100, { focused: true })] };
    const { hands, log } = fake(page);
    const done = await run("press ctrl+enter then press ctrl+enter", hands, {}, "ctrl+enter");
    expect(done).toMatchObject({ ok: false, confirm: "ctrl+enter" });
    expect(log).toEqual(["keys ctrl+enter"]);
  });
  test("Enter in an unlabelled chat composer (a Document) sends: it asks; in Notepad it doesn't", () => {
    const composer = el("Document", "", 100, { focused: true });
    expect(vetAction({ do: "key", keys: "enter", label: "enter" }, { focused: composer, window: { process: "WhatsApp", title: "WhatsApp" } })).toMatchObject({ ok: false, confirm: "enter" });
    expect(vetAction({ do: "key", keys: "enter", label: "enter" }, { focused: composer, browser: true, window: { process: "chrome", title: "(3) Messenger - Google Chrome" } })).toMatchObject({ ok: false, confirm: "enter" });
    expect(vetAction({ do: "key", keys: "enter", label: "enter" }, { focused: composer, window: { process: "Notepad", title: "notes.txt - Notepad" } })).toEqual({ ok: true });
  });
});
