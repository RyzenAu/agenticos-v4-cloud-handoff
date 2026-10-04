// Regressions from Away mode's live test (25 Sep, commit 020b3d6): the Save As file-name box, a
// path taken for a secret, and a trailing "Jarvis" cut from typed text.
import { describe, expect, test } from "bun:test";
import { isPathLike, looksSecret } from "../jarvis-skills/text";
import type { WindowInfo } from "../jarvis-skills/windows";
import { FLAGS_OFF } from "./flags";
import { appDialog, nativeHands, runScreenAct, usableWindow, type Hands } from "./index";
import { nativeScreen, WindowMoved, type NativeScreen } from "./native";
import { parseGoal, sensitiveText, vetAction, type UiElement } from "./plan";

const el = (type: string, name: string, extra: Partial<UiElement> = {}): UiElement => ({
  id: 1, type, x: 100, y: 100, w: 200, h: 24, password: false, enabled: true, focused: true, hasValue: true, readOnly: false, name, aid: "", help: "", value: "", ...extra,
});

describe("Save As / Open dialogs", () => {
  const saveAs: WindowInfo = { handle: 42, process: "Notepad", cls: "#32770", title: "Save as" };
  test("an app's common dialog is a window screen_act may work in; the shell's Run box isn't", () => {
    expect(appDialog(saveAs)).toBe(true);
    expect(usableWindow(saveAs)).toBe(true);
    expect(usableWindow({ handle: 7, process: "explorer", cls: "#32770", title: "Run" })).toBe(false);
    expect(usableWindow({ handle: 8, process: "consent", cls: "#32770", title: "User Account Control" })).toBe(false);
  });
  test("the dialog path reports exact input verification; elsewhere text is pasted", async () => {
    const calls: string[] = [];
    const native = {
      setDialogValue: async (h: number, t: string) => (calls.push(`set ${h} ${t}`), h === 42),
      type: async (h: number, t: string) => void calls.push(`paste ${h} ${t}`),
    } as unknown as NativeScreen;
    const hands = nativeHands({ run: async () => "", close: () => undefined, warm: () => undefined }, native);
    expect(await hands.type(42, String.raw`D:\tmp\away-test-0925\note.txt`)).toBe(true);
    expect(await hands.type(9, "hello")).toBeUndefined();
    expect(calls).toEqual([String.raw`set 42 D:\tmp\away-test-0925\note.txt`, "set 9 hello", "paste 9 hello"]);
  });
  test("native filename mismatch and stolen foreground fail without an ordinary-paste fallback", async () => {
    for (const response of ["failed", "moved"]) {
      const calls: string[] = [];
      const ps = { run: async (script: string) => (calls.push(script), response), close: () => undefined, warm: () => undefined };
      const hands = nativeHands(ps, nativeScreen(ps));
      const error = await hands.type(42, String.raw`D:\tmp\test.txt`).then(() => null, (error) => error);
      expect(error).toBeInstanceOf(response === "moved" ? WindowMoved : Error);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("SetDialogValue");
    }
  });
  test("screen_act types a path into the Save As file name, end to end", async () => {
    const name = el("Edit", "File name:", { aid: "1001" });
    const typed: string[] = [];
    const hands: Hands = {
      foreground: async () => saveAs,
      windows: async () => [saveAs],
      focus: async () => true,
      snapshot: async () => ({ window: { x: 0, y: 0, w: 800, h: 600 }, elements: [{ ...name }], focused: { ...name }, browser: false }),
      focused: async () => ({ ...name, value: typed.join("") }),
      at: async () => null,
      click: async () => undefined,
      type: async (_h, t) => (typed.push(t), true),
      keys: async () => undefined,
      wheel: async () => undefined,
      capture: async () => null,
    };
    const done = await runScreenAct({ goal: String.raw`type D:\tmp\away-test-0925\note.txt in there` }, { hands, flags: { ...FLAGS_OFF, denylist: true, recheck: true }, signal: new AbortController().signal, sleep: async () => undefined });
    expect(done).toMatchObject({ ok: true });
    expect(typed).toEqual([String.raw`D:\tmp\away-test-0925\note.txt`]);
  });
  test("a matching prefix with a different filename suffix is not a confirmed Save As name", async () => {
    const name = el("Edit", "File name:", { aid: "1001" });
    const intended = String.raw`D:\tmp\away-test-0925\correct.txt`;
    const wrong = String.raw`D:\tmp\away-test-0925\incorrect.txt`;
    const hands: Hands = {
      foreground: async () => saveAs, windows: async () => [saveAs], focus: async () => true,
      snapshot: async () => ({ window: { x: 0, y: 0, w: 800, h: 600 }, elements: [name], focused: name, browser: false }),
      focused: async () => ({ ...name, value: wrong }), at: async () => null, click: async () => undefined,
      type: async () => undefined, keys: async () => undefined, wheel: async () => undefined, capture: async () => null,
    };
    const result = await runScreenAct({ goal: `type ${intended} in there` }, { hands, flags: { ...FLAGS_OFF, denylist: true, recheck: true }, signal: new AbortController().signal, sleep: async () => undefined });
    expect(result).toMatchObject({ ok: false, said: expect.stringMatching(/did not read back exactly/) });
  });
});

describe("a path is not a secret; a password still is", () => {
  test("paths and file names", () => {
    for (const p of [String.raw`D:\tmp\away-test-0925\note.txt`, String.raw`C:\Users\Nebula PC\notes.txt`, "reports/2026-09/summary.pdf", "Report-2026.pdf", "Screenshot 2026-09-18 101500.png"]) {
      expect(sensitiveText(p)).toBeNull();
      expect(looksSecret(p)).toBe(false);
    }
    expect(isPathLike(String.raw`D:\tmp\away-test-0925\note.txt`)).toBe(true);
  });
  test("real secrets are still caught", () => {
    for (const s of ["Hunter2!xQ9", "sk-live-abc123def456ghi789jkl", "password: hunter22", "4111 1111 1111 1111", "123456"]) expect(sensitiveText(s)).not.toBeNull();
    expect(isPathLike("Hunter2!xQ9")).toBe(false);
    expect(isPathLike("ab/cd12!X")).toBe(false);
  });
  test("and a password or PIN field is refused whatever is typed, path or not", () => {
    const pw = el("Edit", "Password", { password: true });
    expect(vetAction({ do: "type", text: String.raw`D:\tmp\note.txt`, field: pw }, { focused: pw }).ok).toBe(false);
    const pin = el("Edit", "PIN");
    expect(vetAction({ do: "type", text: "notes.txt", field: pin }, { focused: pin, deny: true }).ok).toBe(false);
    const box = el("Edit", "File name:", { aid: "1001" });
    expect(vetAction({ do: "type", text: String.raw`D:\tmp\away-test-0925\note.txt`, field: box }, { focused: box, deny: true }).ok).toBe(true);
  });
});

describe("typed text keeps its words", () => {
  test("a trailing Jarvis, please or thanks is part of what's typed", () => {
    expect(parseGoal("type hello from Jarvis")).toEqual([{ do: "type", text: "hello from Jarvis" }]);
    expect(parseGoal("hey Jarvis, type thanks Jarvis")).toEqual([{ do: "type", text: "thanks Jarvis" }]);
    expect(parseGoal("type see you soon please")).toEqual([{ do: "type", text: "see you soon please" }]);
    expect(parseGoal("fill in the name field with Jarvis")).toEqual([{ do: "click", target: "name" }, { do: "type", text: "Jarvis", into: "name" }]);
  });
  test("only the spoken command is tidied", () => {
    expect(parseGoal("click Next please")).toEqual([{ do: "click", target: "Next" }]);
    expect(parseGoal("scroll down, Jarvis")).toEqual([{ do: "scroll", dir: "down", amount: 6 }]);
    expect(parseGoal("type hello.")).toEqual([{ do: "type", text: "hello" }]);
    expect(parseGoal("type see you...")).toEqual([{ do: "type", text: "see you..." }]);
  });
});
