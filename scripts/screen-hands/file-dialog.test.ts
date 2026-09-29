import { describe, expect, test } from "bun:test";
import type { WindowInfo } from "../jarvis-skills/windows";
import type { PsHost } from "../jarvis-skills/ps-host";
import { FLAGS_OFF } from "./flags";
import { absolutePath, runFileDialog, type DialogOps, type FileDialogDeps } from "./file-dialog";
import { nativeHands, parseGoal, runScreenAct, type Hands } from "./index";
import { nativeScreen, parseDialogInfo } from "./native";
import type { UiElement } from "./plan";

// Synthetic only: no PowerShell, no desktop input.
const PATH = String.raw`D:\tmp\jarvis-acceptance\synthetic\note.txt`;
const notepad: WindowInfo = { handle: 7, process: "Notepad", cls: "Notepad", title: "Untitled - Notepad" };
const saveAs: WindowInfo = { handle: 42, process: "Notepad", cls: "#32770", title: "Save as" };
const prompt: WindowInfo = { handle: 43, process: "Notepad", cls: "#32770", title: "Confirm Save As" };
const island: WindowInfo = { handle: 44, process: "Notepad", cls: "RichEditD2DPT", title: "" };

type World = {
  front: WindowInfo;
  dialogOwner: number;
  button1: string;
  fileBox: boolean;
  readBack: boolean | "throw";
  /** What pressing Save does. */
  onSave: "close" | "replace" | "error" | "nothing";
  exists: boolean;
};
function world(over: Partial<World> = {}) {
  const w: World = { front: notepad, dialogOwner: notepad.handle, button1: "Save", fileBox: true, readBack: true, onSave: "close", exists: true, ...over };
  const log: string[] = [];
  let dialogOpen = false;
  const ops: DialogOps = {
    owner: async (h) => (h === saveAs.handle ? w.dialogOwner : h === prompt.handle ? saveAs.handle : 0),
    rootOwner: async (h) => (h === island.handle ? notepad.handle : 0),
    alive: async (h) => (h === saveAs.handle ? dialogOpen : h === prompt.handle ? w.front === prompt : true),
    info: async (h) => (h === saveAs.handle ? { fileBox: w.fileBox, button1: w.button1, button2: "Cancel" } : null),
    focusFileName: async (h) => (log.push(`focus ${h}`), true),
    setFileName: async (h, text) => {
      log.push(`set ${h} ${text}`);
      if (w.readBack === "throw") throw new Error("The Save As file name did not match after typing, so I did not save.");
      return w.readBack;
    },
    press: async (h, id, label) => {
      log.push(`press ${h} ${id} ${label}`);
      if (w.onSave === "close") {
        dialogOpen = false;
        w.front = { ...notepad, title: "note.txt - Notepad" };
      } else if (w.onSave === "replace") w.front = prompt;
      else if (w.onSave === "error") w.front = { ...prompt, title: "Save As" };
      return "invoke";
    },
    promptButtons: async () => (w.onSave === "replace" ? ["Yes", "No"] : ["OK"]),
    pressPrompt: async (h, label) => (log.push(`prompt ${h} ${label}`), (w.front = saveAs), true),
  };
  const deps = (signal = new AbortController().signal): FileDialogDeps => ({
    ops,
    foreground: async () => w.front,
    windows: async () => [w.front.handle === notepad.handle ? w.front : notepad],
    keys: async (h, chord) => {
      log.push(`keys ${h} ${chord}`);
      if (chord === "ctrl+shift+s" || chord === "ctrl+o") {
        dialogOpen = true;
        w.front = saveAs;
      }
    },
    signal,
    sleep: async () => undefined,
    vet: { deny: true, window: notepad },
    exists: () => w.exists,
    openMs: 50,
    closeMs: 50,
    now: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
  });
  return { w, log, ops, deps };
}

describe("file-dialog goals parse", () => {
  test("save and open phrasings become one file step", () => {
    expect(parseGoal(`save it as ${PATH}`)).toEqual([{ do: "file", kind: "save", name: PATH }]);
    expect(parseGoal("save this as Quarterly notes.txt")).toEqual([{ do: "file", kind: "save", name: "Quarterly notes.txt" }]);
    expect(parseGoal(`save the note to ${PATH}`)).toEqual([{ do: "file", kind: "save", name: PATH }]);
    expect(parseGoal(`open the file ${PATH}`)).toEqual([{ do: "file", kind: "open", name: PATH }]);
    expect(parseGoal(`open ${PATH}`)).toEqual([{ do: "file", kind: "open", name: PATH }]);
    expect(parseGoal(`type hello in there then save it as ${PATH}`)).toEqual([
      { do: "type", text: "hello" },
      { do: "file", kind: "save", name: PATH },
    ]);
  });
  test("a bare open stays a click; wildcards and multi-line names are refused", () => {
    expect(parseGoal("open the second link")).toEqual([{ do: "click", target: "the second link" }]);
    expect(parseGoal("save it as *.txt")).toBeNull();
    expect(parseGoal("save it")).toBeNull();
    expect(absolutePath(PATH)).toBe(true);
    expect(absolutePath("note.txt")).toBe(false);
  });
  test("the helper's DialogInfo answer", () => {
    expect(parseDialogInfo("1\tSave\tCancel\r\n")).toEqual({ fileBox: true, button1: "Save", button2: "Cancel" });
    expect(parseDialogInfo("none")).toBeNull();
  });
});

describe("runFileDialog (synthetic dialog)", () => {
  test("happy path: Ctrl+Shift+S, our own dialog, focus, exact read-back, Save by id, file on disk", async () => {
    const { log, deps } = world();
    const got = await runFileDialog("save", PATH, notepad, deps());
    expect(got).toMatchObject({ ok: true, verified: true, check: "file", pressed: "invoke" });
    expect(log).toEqual([`keys 7 ctrl+shift+s`, `focus 42`, `set 42 ${PATH}`, `press 42 1 Save`]);
  });
  test("already in the dialog: no chord, the dialog's owner is the window checked", async () => {
    const { w, log, deps } = world();
    w.front = saveAs;
    const d = deps();
    // The dialog is open already.
    await d.keys(99, "ctrl+shift+s");
    log.length = 0;
    const got = await runFileDialog("save", "note.txt", saveAs, d);
    expect(got).toMatchObject({ ok: true, check: "title" });
    expect(log[0]).toBe("focus 42");
  });
  test("a dialog owned by another window is never used", async () => {
    const { log, deps } = world({ dialogOwner: 555 });
    const got = await runFileDialog("save", PATH, notepad, deps());
    expect(got.ok).toBe(false);
    expect(got.said).toMatch(/No Save As dialog came up/);
    expect(log.filter((l) => !l.startsWith("keys"))).toEqual([]);
  });
  test("a dialog whose button 1 isn't Save is left alone", async () => {
    const { log, deps } = world({ button1: "Open" });
    const got = await runFileDialog("save", PATH, notepad, deps());
    expect(got).toMatchObject({ ok: false });
    expect(log.some((l) => l.startsWith("press") || l.startsWith("set"))).toBe(false);
  });
  test("a read-back mismatch never presses Save", async () => {
    for (const readBack of [false, "throw"] as const) {
      const { log, deps } = world({ readBack });
      const got = await runFileDialog("save", PATH, notepad, deps());
      expect(got.ok).toBe(false);
      expect(log.some((l) => l.startsWith("press"))).toBe(false);
    }
  });
  test("a replace prompt is answered No: nothing overwritten", async () => {
    const { log, deps } = world({ onSave: "replace" });
    const got = await runFileDialog("save", PATH, notepad, deps());
    expect(got.ok).toBe(false);
    expect(got.said).toMatch(/answered No, so nothing was overwritten/);
    expect(log).toContain("prompt 43 No");
    expect(log).not.toContain("prompt 43 Yes");
  });
  test("an error prompt is left for him and reported", async () => {
    const { log, deps } = world({ onSave: "error" });
    const got = await runFileDialog("save", PATH, notepad, deps());
    expect(got.ok).toBe(false);
    expect(got.said).toMatch(/nothing was saved/);
    expect(log.some((l) => l.startsWith("prompt"))).toBe(false);
  });
  test("closed but not on disk is unverified, not success", async () => {
    const { deps } = world({ exists: false });
    expect(await runFileDialog("save", PATH, notepad, deps())).toMatchObject({ ok: false, outcome: "unverified" });
  });
  test("a dialog that never closes is unverified", async () => {
    const { deps } = world({ onSave: "nothing" });
    expect(await runFileDialog("save", PATH, notepad, deps())).toMatchObject({ ok: false, outcome: "unverified" });
  });
  test("a card-number or code file name is refused before any key", async () => {
    const { log, deps } = world();
    expect((await runFileDialog("save", "4111 1111 1111 1111", notepad, deps())).ok).toBe(false);
    expect(log).toEqual([]);
  });
  test("an abort stops before pressing Save", async () => {
    const { log, deps } = world();
    const controller = new AbortController();
    const d = deps(controller.signal);
    const keys = d.keys;
    d.keys = async (h, chord) => {
      await keys(h, chord);
      controller.abort();
    };
    const got = await runFileDialog("save", PATH, notepad, d);
    expect(got).toMatchObject({ ok: false, stopped: true });
    expect(log.some((l) => l.startsWith("press"))).toBe(false);
  });
});

describe("screen_act uses the shared dialog path", () => {
  const doc: UiElement = { id: 1, type: "Document", name: "Text editor", aid: "", help: "", x: 0, y: 0, w: 500, h: 400, password: false, enabled: true, focused: true, hasValue: true, readOnly: false, value: "" };
  test("type, then 'save it as' a full path: ok only with the file on disk", async () => {
    const { w, log, ops, deps } = world();
    const d = deps();
    let typedText = "";
    const hands: Hands = {
      foreground: async () => w.front,
      windows: d.windows,
      focus: async () => true,
      snapshot: async () => ({ window: { x: 0, y: 0, w: 500, h: 400 }, elements: [{ ...doc, value: typedText }], focused: { ...doc, value: typedText }, browser: false }),
      focused: async () => ({ ...doc, value: typedText }),
      at: async () => null,
      click: async () => undefined,
      type: async (_h, text) => void (typedText = text),
      keys: d.keys,
      wheel: async () => undefined,
      capture: async () => null,
      dialog: ops,
    };
    const run = (exists: boolean) =>
      runScreenAct({ goal: `type hello in there then save it as ${PATH}`, onlyWindow: 7 }, { hands, signal: new AbortController().signal, sleep: async () => undefined, flags: { ...FLAGS_OFF, denylist: true, recheck: true }, exists: () => exists });
    const ok = await run(true);
    expect(ok).toMatchObject({ ok: true });
    expect(log).toContain(`press 42 1 Save`);
    w.front = notepad;
    w.exists = false;
    const missing = await run(false);
    expect(missing).toMatchObject({ ok: false, outcome: "unverified" });
  });
  test("nativeHands drives the dialog by control id through fixed helper calls", async () => {
    const scripts: string[] = [];
    const answers: Record<string, string> = { FocusFileName: "focused", PressDialogButton: Buffer.from("invoke").toString("base64"), SetDialogValue: "set" };
    const ps: PsHost = {
      run: async (script) => {
        scripts.push(script);
        const hit = Object.keys(answers).find((k) => script.includes(`::${k}(`));
        return hit ? answers[hit] : "";
      },
      close: () => undefined,
      warm: () => undefined,
    };
    const hands = nativeHands(ps, nativeScreen(ps));
    expect(hands.dialog).toBeDefined();
    expect(await hands.dialog!.focusFileName(42)).toBe(true);
    expect(await hands.dialog!.setFileName(42, PATH)).toBe(true);
    expect(await hands.dialog!.press(42, 1, "Save")).toBe("invoke");
    expect(scripts.some((s) => s.includes("PressDialogButton(42, 1,"))).toBe(true);
    // The path only ever travels as base64, never as PowerShell source.
    expect(scripts.some((s) => s.includes("jarvis-acceptance"))).toBe(false);
  });
});

describe("Windows 11 Notepad specifics (found live 27 Sep)", () => {
  test("the chord goes to the app's own editor island in front (root owner is his window), never another window's", async () => {
    const { w, log, deps } = world();
    const island: WindowInfo = { handle: 44, process: "Notepad", cls: "RichEditD2DPT", title: "" };
    w.front = island;
    const got = await runFileDialog("save", PATH, notepad, deps());
    expect(got.ok).toBe(true);
    expect(log[0]).toBe("keys 44 ctrl+shift+s");
    // A foreign window in front: input goes to his window handle, where the native Front check refuses it.
    const other = world();
    other.w.front = { handle: 999, process: "Other", cls: "Other", title: "Other" };
    await runFileDialog("save", PATH, notepad, other.deps());
    expect(other.log[0]).toBe("keys 7 ctrl+shift+s");
  });
  test("when the accelerator opens nothing, File → Save as is tried through the menu", async () => {
    const { w, log, deps } = world();
    const d = deps();
    d.keys = async (h, chord) => void log.push(`keys ${h} ${chord}`); // the accelerator is ignored
    let menus = 0;
    d.menu = async (kind) => {
      menus++;
      log.push(`menu ${kind}`);
      w.front = saveAs;
      return true;
    };
    d.openMs = 5000;
    const got = await runFileDialog("save", PATH, notepad, d);
    expect(menus).toBe(1);
    expect(got).toMatchObject({ ok: true, verified: true });
    expect(got.did).toContain("chose File, Save as");
  });
  test("a dialog whose File name box is late is waited for briefly, then used", async () => {
    const { w, ops, deps } = world();
    let calls = 0;
    const info = ops.info;
    ops.info = async (h) => (++calls < 3 ? { fileBox: false, button1: "Save", button2: "Cancel" } : info(h));
    w.front = notepad;
    expect((await runFileDialog("save", PATH, notepad, deps())).ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
  test("a File name box that refuses focus a few times is retried, then fails closed", async () => {
    const { ops, log, deps } = world();
    let n = 0;
    ops.focusFileName = async () => ++n >= 3;
    expect((await runFileDialog("save", PATH, notepad, deps())).ok).toBe(true);
    const never = world();
    never.ops.focusFileName = async () => false;
    const got = await runFileDialog("save", PATH, notepad, never.deps());
    expect(got.ok).toBe(false);
    expect(never.log.some((l) => l.startsWith("set") || l.startsWith("press"))).toBe(false);
    void log;
  });
});
