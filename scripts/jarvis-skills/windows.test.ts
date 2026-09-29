import { describe, expect, test } from "bun:test";
import { answerWindow, parseWindowRows, pickWindow, windowIntent, type WindowInfo } from "./windows";
import { b64, type PsHost } from "./ps-host";

const win = (handle: number, process: string, title: string, cls = "Win"): WindowInfo => ({ handle, process, cls, title });
const WINDOWS: WindowInfo[] = [
  win(10, "chrome", "Agentic OS — Your workspace - Google Chrome"),
  win(11, "Code", "index.ts - AgenticOS-v4 - Visual Studio Code"),
  win(12, "WhatsApp.Root", "WhatsApp"),
  win(13, "chrome", "YouTube - Google Chrome"),
  win(14, "Spotify", "Spotify Premium"),
  win(15, "explorer", "Program Manager", "Progman"),
  win(16, "notepad", "Untitled - Notepad"),
];

describe("window phrases", () => {
  test("each command", () => {
    expect(windowIntent("show desktop")).toEqual({ skill: "window", action: "show_desktop" });
    expect(windowIntent("minimize everything")).toEqual({ skill: "window", action: "show_desktop" });
    expect(windowIntent("bring my windows back")).toEqual({ skill: "window", action: "restore_all" });
    expect(windowIntent("switch to Chrome")).toEqual({ skill: "window", action: "switch", target: "chrome" });
    expect(windowIntent("switch over to WhatsApp")).toEqual({ skill: "window", action: "switch", target: "whatsapp" });
    expect(windowIntent("maximise this")).toEqual({ skill: "window", action: "maximise" });
    expect(windowIntent("make it full screen")).toEqual({ skill: "window", action: "maximise" });
    expect(windowIntent("minimise this window")).toEqual({ skill: "window", action: "minimise" });
    expect(windowIntent("snap left")).toEqual({ skill: "window", action: "snap_left" });
    expect(windowIntent("move this window to the right half")).toEqual({ skill: "window", action: "snap_right" });
  });
  test("not window commands", () => {
    for (const phrase of ["switch to call mode", "switch to the inbox", "switch to the next tab", "switch to dark mode", "show my calendar", "restore", "move the meeting to Friday", "open chrome", "close this window", "go to the desktop folder in explorer"])
      expect(windowIntent(phrase)).toBeNull();
  });
});

describe("picking the window", () => {
  test("by process, alias, title or a close misspelling; front-most wins", () => {
    expect(pickWindow(WINDOWS, "chrome")?.handle).toBe(10);
    expect(pickWindow(WINDOWS, "vs code")?.handle).toBe(11);
    expect(pickWindow(WINDOWS, "whatsapp")?.handle).toBe(12);
    expect(pickWindow(WINDOWS, "youtube")?.handle).toBe(13);
    expect(pickWindow(WINDOWS, "spotfy")?.handle).toBe(14);
    expect(pickWindow(WINDOWS, "notepad")?.handle).toBe(16);
  });
  test("nothing close enough → null (and never the desktop shell)", () => {
    expect(pickWindow(WINDOWS, "excel")).toBeNull();
    expect(pickWindow(WINDOWS, "program manager")).toBeNull();
    expect(pickWindow(WINDOWS, "")).toBeNull();
  });
  test("rows from the helper", () => {
    expect(parseWindowRows("10\tchrome\tChrome_WidgetWin_1\tA - B\n\nbad row\n11\tCode\tX\tfile.ts")).toEqual([
      { handle: 10, process: "chrome", cls: "Chrome_WidgetWin_1", title: "A - B" },
      { handle: 11, process: "Code", cls: "X", title: "file.ts" },
    ]);
  });
});

describe("acting", () => {
  function fakePs(focusResult = "True") {
    const scripts: string[] = [];
    const ps: PsHost = {
      run: async (script) => {
        scripts.push(script);
        if (script.includes("List()")) return b64(WINDOWS.map((w) => `${w.handle}\t${w.process}\t${w.cls}\t${w.title}`).join("\n"));
        if (script.includes("Foreground()")) return b64("16\tnotepad\tNotepad\tUntitled - Notepad");
        if (script.includes("Focus(")) return focusResult;
        return "OK";
      },
      close: () => undefined,
      warm: () => undefined,
    };
    return { ps, scripts };
  }
  test("switch focuses the handle it picked; says so when Windows refuses; says when none is open", async () => {
    const { ps, scripts } = fakePs();
    expect(await answerWindow({ skill: "window", action: "switch", target: "whatsapp" }, ps)).toBe("Switched to WhatsApp, sir.");
    expect(scripts.at(-1)).toBe("[JarvisWin]::Focus(12)");
    expect(await answerWindow({ skill: "window", action: "switch", target: "chrome" }, fakePs("False").ps)).toContain("wouldn't bring Google Chrome");
    expect(await answerWindow({ skill: "window", action: "switch", target: "excel" }, ps)).toBe(`I can't see a excel window open, sir. Say "open excel" and I'll launch it.`);
  });
  test("maximise, snap and desktop", async () => {
    const { ps, scripts } = fakePs();
    expect(await answerWindow({ skill: "window", action: "maximise" }, ps)).toBe("Maximised, sir.");
    expect(scripts.at(-1)).toContain("ShowWindow([IntPtr]::new(16), 3)");
    expect(await answerWindow({ skill: "window", action: "snap_left" }, ps)).toBe("Snapped left, sir.");
    expect(scripts.at(-1)).toContain("Chord(0x5B, 0x25)");
    expect(await answerWindow({ skill: "window", action: "show_desktop" }, ps)).toBe("Desktop's clear, sir.");
  });
});
