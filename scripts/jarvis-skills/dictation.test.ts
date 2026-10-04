import { describe, expect, test } from "bun:test";
import { answerType, refuseWindow, typeIntent } from "./dictation";
import { b64, type PsHost } from "./ps-host";

const row = (title: string, process = "notepad", cls = "Notepad", handle = 4242) => `${handle}\t${process}\t${cls}\t${title}`;
function fakePs(front: string, paste = "TYPED") {
  const scripts: string[] = [];
  const ps: PsHost = {
    run: async (script) => {
      scripts.push(script);
      if (script.includes("Foreground()")) return b64(front);
      if (script.includes("SendWait")) return paste;
      return "";
    },
    close: () => undefined,
    warm: () => undefined,
  };
  return { ps, scripts };
}

describe("dictation phrases", () => {
  test("type and dictate keep his words exactly", () => {
    expect(typeIntent("type hello world")).toEqual({ skill: "type", action: "type", text: "hello world" });
    expect(typeIntent("Type hello world.")).toEqual({ skill: "type", action: "type", text: "hello world" });
    expect(typeIntent("dictate: Dear Brooke, thanks for your time today. Talk soon.")).toEqual({ skill: "type", action: "type", text: "Dear Brooke, thanks for your time today. Talk soon." });
    expect(typeIntent("Jarvis, type out See you at 3")).toMatchObject({ text: "See you at 3" });
    expect(typeIntent("type this: Invoice #204 is attached")).toMatchObject({ text: "Invoice #204 is attached" });
  });
  test("not dictation", () => {
    for (const phrase of ["type", "what type of dentist is Brooke", "typing is slow", "type in the search box cats", "dictate", "stereotype this", "search for cats"])
      expect(typeIntent(phrase)).toBeNull();
  });
});

describe("which windows it will type into", () => {
  test("ordinary apps are fine", () => {
    expect(refuseWindow({ handle: 1, process: "notepad", cls: "Notepad", title: "Untitled - Notepad" })).toBeNull();
    expect(refuseWindow({ handle: 1, process: "Code", cls: "Chrome_WidgetWin_1", title: "index.ts - AgenticOS-v4 - Visual Studio Code" })).toBeNull();
    expect(refuseWindow({ handle: 1, process: "Obsidian", cls: "Chrome_WidgetWin_1", title: "Inbox - Obsidian Vault - Obsidian v1.9" })).toBeNull();
  });
  test("Windows itself, this OS, sign-in, password and bank windows are refused", () => {
    const refused = (w: any) => expect(refuseWindow(w)).not.toBeNull();
    refused(null);
    refused({ handle: 1, process: "explorer", cls: "Progman", title: "Program Manager" });
    refused({ handle: 1, process: "explorer", cls: "Shell_TrayWnd", title: "" });
    refused({ handle: 1, process: "SearchHost", cls: "Windows.UI.Core.CoreWindow", title: "Search" });
    refused({ handle: 1, process: "LockApp", cls: "x", title: "Windows Default Lock Screen" });
    refused({ handle: 1, process: "chrome", cls: "Chrome_WidgetWin_1", title: "Agentic OS — Your workspace - Google Chrome" });
    refused({ handle: 1, process: "chrome", cls: "Chrome_WidgetWin_1", title: "Sign in - Google Accounts - Google Chrome" });
    refused({ handle: 1, process: "chrome", cls: "Chrome_WidgetWin_1", title: "CommBank NetBank - Log on - Google Chrome" });
    refused({ handle: 1, process: "msedge", cls: "x", title: "Enter your password" });
    refused({ handle: 1, process: "1Password", cls: "x", title: "1Password" });
    refused({ handle: 1, process: "chrome", cls: "x", title: "Checkout - Stripe" });
  });
});

describe("typing", () => {
  test("pastes via the clipboard (restored after), text passed as base64, and says Typed. only after", async () => {
    const { ps, scripts } = fakePs(row("Untitled - Notepad"));
    const text = "Hi Brooke'; Stop-Computer; '";
    expect(await answerType({ skill: "type", action: "type", text }, ps)).toBe("Typed.");
    const paste = scripts.find((s) => s.includes("SendWait"))!;
    expect(paste).toContain(b64(text));
    expect(paste).not.toContain("Stop-Computer");
    expect(paste).toContain("-ne $h");
    expect(paste).not.toContain("{ENTER}");
    // His clipboard is put back afterwards, in a later command (apps read it lazily).
    const restore = scripts.findIndex((s) => s.includes("SetDataObject($s, $true)"));
    expect(restore).toBeGreaterThan(scripts.indexOf(paste));
  });
  test("refuses before touching the clipboard", async () => {
    const { ps, scripts } = fakePs(row("Sign in to your account - Google Chrome", "chrome", "Chrome_WidgetWin_1"));
    expect(await answerType({ skill: "type", action: "type", text: "hello" }, ps)).toContain("won't type into it");
    expect(scripts.some((s) => s.includes("SendWait"))).toBe(false);
  });
  test("a window change mid-way stops it; secrets are never typed", async () => {
    expect(await answerType({ skill: "type", action: "type", text: "hello" }, fakePs(row("Untitled - Notepad"), "MOVED").ps)).toContain("so I stopped");
    const { ps, scripts } = fakePs(row("Untitled - Notepad"));
    expect(await answerType({ skill: "type", action: "type", text: "sk-proj-abcdefghijklmnopqrstuvwxyz" }, ps)).toContain("Type that one yourself");
    expect(scripts).toEqual([]);
  });
});
