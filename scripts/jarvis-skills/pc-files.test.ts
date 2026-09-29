import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerFileJob, fileJobIntent, homePlace } from "./pc-files";
import type { PsHost } from "./ps-host";
import { clipboardIntent } from "./clipboard";
import { settingsIntent } from "./pc-control";

const ps = {} as PsHost;
describe("file jobs: words", () => {
  test("places are his home folders only", () => {
    expect(homePlace("the jarvis-suite-files folder in my Downloads")).toBe("Downloads/jarvis-suite-files");
    expect(homePlace("my Documents")).toBe("Documents");
    expect(homePlace("../../Windows in my Downloads")).toBeNull();
  });
  test("each job", () => {
    expect(fileJobIntent("zip the jarvis-suite-files folder in my Downloads")).toEqual({ skill: "filejob", action: "zip", folder: "Downloads/jarvis-suite-files" });
    expect(fileJobIntent("copy report.txt from the jarvis-suite-files folder in my Downloads to my Documents")).toEqual({ skill: "filejob", action: "copy", file: "report.txt", from: "Downloads/jarvis-suite-files", to: "Documents" });
    expect(fileJobIntent("save report.txt in my jarvis-suite-files folder as a PDF")).toEqual({ skill: "filejob", action: "pdf", file: "report.txt", from: "Downloads/jarvis-suite-files" });
    expect(fileJobIntent("take a screenshot")).toEqual({ skill: "filejob", action: "screenshot" });
    expect(fileJobIntent("put the total of the Sales column in the cell under it")).toEqual({ skill: "filejob", action: "excel_sum", column: "Sales" });
    expect(fileJobIntent("make the first line bold")).toEqual({ skill: "filejob", action: "word_format", which: "first", style: "bold" });
    expect(fileJobIntent(String.raw`copy the file to C:\Windows`)).toBeNull();
    expect(clipboardIntent("copy M&U Ventures to my clipboard")).toEqual({ skill: "clipboard", action: "copy", text: "M&U Ventures" });
    expect(settingsIntent("open my clipboard history")).toEqual({ skill: "settings", action: "clipboard_history" });
  });
});
describe("file jobs: never over an existing file", () => {
  test("copy and move", async () => {
    const home = mkdtempSync(join(tmpdir(), "pcfiles-"));
    mkdirSync(join(home, "Downloads", "x"), { recursive: true });
    mkdirSync(join(home, "Documents"));
    writeFileSync(join(home, "Downloads", "x", "a.txt"), "a");
    expect(await answerFileJob({ skill: "filejob", action: "copy", file: "a.txt", from: "Downloads/x", to: "Documents" }, { ps, home })).toBe("Copied a.txt to Documents, sir.");
    expect(existsSync(join(home, "Downloads", "x", "a.txt"))).toBe(true);
    expect(await answerFileJob({ skill: "filejob", action: "move", file: "a.txt", from: "Downloads/x", to: "Documents" }, { ps, home })).toMatch(/already a a.txt in Documents/);
    expect(await answerFileJob({ skill: "filejob", action: "move", file: "a.txt", from: "Downloads/x", to: "Desktop" }, { ps, home })).toBe("Moved a.txt to Desktop, sir.");
    expect(existsSync(join(home, "Downloads", "x", "a.txt"))).toBe(false);
    expect(await answerFileJob({ skill: "filejob", action: "zip", folder: "Downloads/nope" }, { ps, home })).toMatch(/can't find/);
  });
});

describe(String.raw`D:\tmp as a work root`, () => {
  test("places", async () => {
    const { placeFromWords, resolvePlace } = await import("./places");
    expect(placeFromWords(String.raw`D:\tmp\jarvis-suite\files`)).toBe("D:/tmp/jarvis-suite/files");
    expect(placeFromWords(String.raw`D:\tmp\..\Windows`)).toBeNull();
    expect(resolvePlace("D:/tmp/a", String.raw`C:\Users\x`, String.raw`D:\tmp`)).toBe(String.raw`D:\tmp\a`);
    expect(resolvePlace("C:/Windows")).toBeNull();
    expect(fileJobIntent(String.raw`zip the D:\tmp\jarvis-suite\files folder`)).toEqual({ skill: "filejob", action: "zip", folder: "D:/tmp/jarvis-suite/files" });
    expect(fileJobIntent(String.raw`copy report.txt from D:\tmp\jarvis-suite\files to D:\tmp\jarvis-suite\copies`)).toMatchObject({ action: "copy", from: "D:/tmp/jarvis-suite/files", to: "D:/tmp/jarvis-suite/copies" });
    expect(fileJobIntent(String.raw`take a screenshot and save it in D:\tmp\jarvis-suite`)).toEqual({ skill: "filejob", action: "screenshot", to: "D:/tmp/jarvis-suite" });
  });
  test("a job in a work root", async () => {
    const work = mkdtempSync(join(tmpdir(), "work-"));
    mkdirSync(join(work, "f"));
    writeFileSync(join(work, "f", "a.txt"), "a");
    expect(await answerFileJob({ skill: "filejob", action: "copy", file: "a.txt", from: "D:/tmp/f", to: "D:/tmp/g" }, { ps, home: work, workRoot: work })).toBe(String.raw`Copied a.txt to D:\tmp\g, sir.`);
    expect(existsSync(join(work, "g", "a.txt"))).toBe(true);
  });
});

describe("clipboard history", () => {
  test("off: says so and presses nothing; on: Win+V", async () => {
    const { answerSettings } = await import("./pc-control");
    const off: string[] = [];
    const psOff: PsHost = { run: async (s) => (off.push(s), ""), close: () => undefined, warm: () => undefined };
    expect(await answerSettings({ skill: "settings", action: "clipboard_history" }, { ps: psOff })).toMatch(/switched off/);
    expect(off.some((s) => /Chord/.test(s))).toBe(false);
    const on: string[] = [];
    const psOn: PsHost = { run: async (s) => (on.push(s), /EnableClipboardHistory/.test(s) ? "1" : "ok"), close: () => undefined, warm: () => undefined };
    expect(await answerSettings({ skill: "settings", action: "clipboard_history" }, { ps: psOn })).toMatch(/Windows\+V/);
    expect(on.some((s) => /Chord\(0x5B, 0x56\)/.test(s))).toBe(true);
  });
});
