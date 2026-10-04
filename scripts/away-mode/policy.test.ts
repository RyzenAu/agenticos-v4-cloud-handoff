import { describe, expect, test } from "bun:test";
import {
  allowedPath,
  approvalReason,
  awayVoiceIntent,
  buttonVerdict,
  classifyTask,
  neverReason,
  neverWindow,
  newCode,
  parseFileOps,
  parseScreenTask,
  parseTelegram,
  sameCode,
} from "./policy";

const HOME = "C:\\Users\\Nebula PC";

describe("the never-list (even with approval)", () => {
  test.each([
    ["log in to my NAB account and download statements", "banking or finance"],
    ["check my CommBank balance", "banking or finance"],
    ["buy the domain muventures.co", "money"],
    ["pay the Vercel invoice", "money"],
    ["open Bitwarden and copy the Vercel password", "passwords or credentials"],
    ["sign in to Xero", "passwords or credentials"],
    ["turn off Windows Defender", "security settings"],
    ["disable the lock screen", "security settings"],
    ["install OBS", "installing software"],
    ["winget upgrade everything", "installing software"],
    ["email the client the proposal", "messaging other people"],
    ["send Mehroz the preview link", "messaging other people"],
    ["WhatsApp mum", "messaging other people"],
    ["post it on LinkedIn", "messaging other people"],
  ])("%s → %s", (task, why) => expect(neverReason(task)).toBe(why));

  test.each(["tidy Downloads", "download the invoices from Xero and file them", "export this spreadsheet to PDF", "run the lead phone-finder", "rebuild the preview for lead 194", "tidy Downloads and send me the list"])(
    "allowed: %s",
    (task) => expect(neverReason(task)).toBeNull(),
  );
});

describe("approval (one-time code)", () => {
  test.each(["delete that test file", "deploy the preview for lead 194", "empty the recycle bin", "overwrite the old report", "submit the form", "restart the PC"])("%s needs his code", (task) =>
    expect(approvalReason(task)).not.toBeNull(),
  );
  test.each(["tidy Downloads", "create a folder D:\\tmp\\x", "export this spreadsheet to PDF"])("%s runs on its own", (task) => expect(approvalReason(task)).toBeNull());
  test("final buttons: money, messaging and accounts are never; the rest need a code", () => {
    expect(buttonVerdict("Pay now")).toEqual({ never: "money" });
    expect(buttonVerdict("Send")).toEqual({ never: "messaging other people" });
    expect(buttonVerdict("Sign up")).toEqual({ never: "accounts and credentials" });
    expect("approval" in buttonVerdict("Delete")).toBe(true);
    expect("approval" in buttonVerdict("Submit")).toBe(true);
  });
  test("windows away mode never drives", () => {
    expect(neverWindow({ process: "WhatsApp", title: "WhatsApp" })).not.toBeNull();
    expect(neverWindow({ process: "chrome", title: "NetBank - CommBank - Google Chrome" })).not.toBeNull();
    expect(neverWindow({ process: "Notepad", title: "Untitled - Notepad" })).toBeNull();
  });
});

describe("routes: most direct first", () => {
  test("built-in file steps, with 'there' and 'that test file'", () => {
    const ops = parseFileOps('create a folder D:\\tmp\\away-test and write a text file there saying "hello from away mode"', null);
    expect(ops).toEqual([
      { op: "mkdir", path: "D:\\tmp\\away-test" },
      { op: "write", path: "D:\\tmp\\away-test\\note.txt", text: "hello from away mode" },
    ]);
    expect(parseFileOps("delete that test file", "D:\\tmp\\away-test\\note.txt")).toEqual([{ op: "delete", path: "D:\\tmp\\away-test\\note.txt" }]);
    expect(parseFileOps("delete that test file", null)).toBeNull();
    expect(parseFileOps("create a file called a.txt in D:\\tmp with hi", null)).toEqual([{ op: "write", path: "D:\\tmp\\a.txt", text: "hi" }]);
  });
  test("only safe folders", () => {
    expect(allowedPath("D:\\tmp\\x\\note.txt", HOME)).toBe(true);
    expect(allowedPath("C:\\Users\\Nebula PC\\Downloads\\a.pdf", HOME)).toBe(true);
    expect(allowedPath("C:\\Windows\\System32\\drivers\\etc\\hosts", HOME)).toBe(false);
    expect(allowedPath("D:\\tmp\\..\\Windows\\x", HOME)).toBe(false);
    expect(allowedPath("D:\\tmpfoo\\x", HOME)).toBe(false);
  });
  test("CLI recipes before clicking", () => {
    expect(classifyTask("run the lead phone-finder")).toMatchObject({ route: "cli", recipe: { argv: ["scripts/leads/cli.ts", "phones", "run"] } });
    expect(classifyTask("rebuild the preview for lead 194")).toMatchObject({ route: "cli", recipe: { argv: ["scripts/lead-sites/cli.ts", "generate", "194", "--by", "usman"] } });
  });
  test("a screen plan only when he names the app and the steps", () => {
    expect(parseScreenTask("open Notepad, type hello from away mode, then save it to D:\\tmp\\away-test\\notepad.txt")).toEqual([
      { kind: "open", app: "Notepad" },
      { kind: "act", goal: "type hello from away mode" },
      { kind: "save", path: "D:\\tmp\\away-test\\notepad.txt" },
    ]);
    expect(classifyTask("tidy Downloads")).toEqual({ route: "hermes" });
    expect(classifyTask("export this spreadsheet to PDF")).toEqual({ route: "hermes" });
  });
});

describe("Telegram commands and codes", () => {
  test("commands", () => {
    expect(parseTelegram("/away on")).toEqual({ cmd: "on" });
    expect(parseTelegram("/away@MnUJarvis_bot off")).toEqual({ cmd: "off" });
    expect(parseTelegram("/stop")).toEqual({ cmd: "stop" });
    expect(parseTelegram("/status")).toEqual({ cmd: "status" });
    expect(parseTelegram("/log 5")).toEqual({ cmd: "log", n: 5 });
    expect(parseTelegram("/task tidy Downloads")).toEqual({ cmd: "task", text: "tidy Downloads" });
    expect(parseTelegram("/away cancel 4")).toEqual({ cmd: "cancel", id: 4 });
    expect(parseTelegram("yes 7f3k")).toEqual({ cmd: "approve", code: "7F3K" });
    expect(parseTelegram("no 7F3K")).toEqual({ cmd: "deny", code: "7F3K" });
  });
  test("ordinary chat is left to Hermes: 'yes sure' is not a code", () => {
    for (const text of ["yes sure", "no thanks", "yes okay", "what's on my calendar", "/new"]) expect(parseTelegram(text)).toBeNull();
  });
  test("codes: four characters, at least one digit, no look-alikes, constant-time compare", () => {
    for (let i = 0; i < 200; i++) {
      const c = newCode();
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
      expect(c).toMatch(/\d/);
    }
    expect(newCode(() => 0)).toMatch(/\d/);
    expect(sameCode("7f3k", "7F3K")).toBe(true);
    expect(sameCode("7F3X", "7F3K")).toBe(false);
    expect(sameCode("7F3", "7F3K")).toBe(false);
  });
});

describe("voice", () => {
  test("on, off, a task", () => {
    expect(awayVoiceIntent("Jarvis, I'm heading out, away mode on")).toEqual({ on: true });
    expect(awayVoiceIntent("away mode off")).toEqual({ on: false });
    expect(awayVoiceIntent("while I'm away, tidy Downloads")).toEqual({ task: "tidy Downloads" });
    expect(awayVoiceIntent("open Notepad")).toBeNull();
  });
});
