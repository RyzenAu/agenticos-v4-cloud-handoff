import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compoundCalls, normaliseClause } from "./voice-compound";
import { answerDeploys, answerSettings, deploysIntent, deploysLine, parseDeploys, settingsIntent } from "./jarvis-skills/pc-control";
import type { PsHost } from "./jarvis-skills/ps-host";

const pc = (t: string) => (/^open (notepad|chrome|spotify)$/i.test(t) ? { action: "open_app" as const, target: t.slice(5) } : null);

describe("compound requests: every part a rule's, or nothing", () => {
  test("timer + notifications, open + type (typed only into the app just opened)", () => {
    expect(compoundCalls("set a 25-minute focus timer and mute notifications", {}, pc)).toEqual([
      { name: "skill", arguments: { skill: "timer", action: "start", seconds: 1500, phrase: "25 minutes" } },
      { name: "skill", arguments: { skill: "settings", action: "notifications", on: false } },
    ]);
    expect(compoundCalls("open Notepad and type a shopping list: milk, eggs, bread", {}, pc)).toEqual([
      { name: "pc_act", arguments: { action: "open_app", target: "Notepad" } },
      { name: "skill", arguments: { skill: "type", action: "type", text: "a shopping list: milk, eggs, bread", app: "Notepad" } },
    ]);
  });
  test("the Vercel status comes from the CLI; the dashboard opens only when he asked to see it", () => {
    expect(compoundCalls("open Chrome, go to my Vercel dashboard and tell me the last deploy status", {}, pc)).toEqual([
      { name: "open_url", arguments: { url: "https://vercel.com/dashboard" } },
      { name: "skill", arguments: { skill: "deploys", action: "latest" } },
    ]);
    expect(compoundCalls("what's my last deploy status", {}, pc)).toBeNull();
  });
  test("a part no rule answers, or anything outbound: not split", () => {
    expect(compoundCalls("open WhatsApp and message Mehroz hello", {}, pc)).toBeNull();
    expect(compoundCalls("open Spotify and play my liked songs", {}, pc)).toEqual([{ name: "open_url", arguments: { url: "https://open.spotify.com/collection/tracks" } }]);
    expect(compoundCalls("search YouTube for lo-fi beats", {}, pc)).toEqual([{ name: "open_url", arguments: { url: "https://www.youtube.com/results?search_query=lo-fi%20beats" } }]);
    expect(compoundCalls("set a timer for 2 minutes", {}, pc)).toBeNull();
    expect(compoundCalls("open notepad and email the list to Brooke", {}, pc)).toBeNull();
  });
  test("normaliseClause", () => {
    expect(normaliseClause("set a 25-minute focus timer")).toBe("set a timer for 25 minutes");
    expect(normaliseClause("and then start a 10 minute timer")).toBe("start a 10 minute timer".replace("start a 10 minute timer", "set a timer for 10 minutes"));
  });
});

describe("direct settings and deploys", () => {
  test("settings words", () => {
    expect(settingsIntent("turn on Bluetooth")).toEqual({ skill: "settings", action: "radio", radio: "bluetooth", on: true });
    expect(settingsIntent("switch wifi off")).toEqual({ skill: "settings", action: "radio", radio: "wifi", on: false });
    expect(settingsIntent("mute notifications")).toEqual({ skill: "settings", action: "notifications", on: false });
    expect(settingsIntent("do not disturb on")).toEqual({ skill: "settings", action: "notifications", on: false });
    expect(settingsIntent("notifications back on")).toEqual({ skill: "settings", action: "notifications", on: true });
    expect(settingsIntent("mute slack notifications")).toBeNull();
    expect(settingsIntent("make a new folder on my desktop called jarvis-suite-test")).toEqual({ skill: "settings", action: "folder", name: "jarvis-suite-test", where: "Desktop" });
    expect(settingsIntent("create a folder called ../../Windows in documents")).toBeNull();
  });
  test("a new folder is made once, never outside the folder named", async () => {
    const home = mkdtempSync(join(tmpdir(), "pc-control-"));
    mkdirSync(join(home, "Desktop"));
    const ps = {} as PsHost;
    expect(await answerSettings({ skill: "settings", action: "folder", name: "Test A", where: "Desktop" }, { ps, home })).toBe("Made the Test A folder in Desktop, sir.");
    expect(existsSync(join(home, "Desktop", "Test A"))).toBe(true);
    expect(await answerSettings({ skill: "settings", action: "folder", name: "Test A", where: "Desktop" }, { ps, home })).toMatch(/already/);
  });
  test("notifications: Do not disturb, switched in Settings and read back", async () => {
    const asked: string[] = [];
    const ps = {} as PsHost;
    expect(await answerSettings({ skill: "settings", action: "notifications", on: false }, { ps, dnd: async (w) => (asked.push(w), w) })).toMatch(/^Notifications are muted: Do not disturb is on/);
    expect(await answerSettings({ skill: "settings", action: "notifications", on: true }, { ps, dnd: async (w) => (asked.push(w), w) })).toBe("Notifications are back on, sir.");
    expect(asked).toEqual(["on", "off"]);
    await expect(answerSettings({ skill: "settings", action: "notifications", on: false }, { ps, dnd: async () => "off" })).rejects.toThrow();
    await expect(answerSettings({ skill: "settings", action: "notifications", on: false }, { ps, dnd: async () => "none" })).rejects.toThrow(/Do not disturb switch/);
  });
  test("theme words", () => {
    expect(settingsIntent("switch Windows to dark mode")).toEqual({ skill: "settings", action: "theme", dark: true });
    expect(settingsIntent("turn on light mode")).toEqual({ skill: "settings", action: "theme", dark: false });
    expect(settingsIntent("dark mode on")).toEqual({ skill: "settings", action: "theme", dark: true });
  });
  test("deploys: words, the CLI table and the line", async () => {
    expect(deploysIntent("open Chrome, go to my Vercel dashboard and tell me the last deploy status")).toEqual({ skill: "deploys", action: "latest" });
    expect(deploysIntent("did my last deploy work")).toEqual({ skill: "deploys", action: "latest" });
    expect(deploysIntent("deploy the dental site")).toBeNull();
    const table = [
      "> Deployments under nahda [387ms]",
      "  Age     Project                 Deployment                                   Status      Environment     Duration     Username",
      "  6h      nahda/bianca-preview    https://bianca-preview-iwb1-nahda.vercel.app  ● Ready     Production      3s           u",
      "  8h      nahda/muv-demo-dental   https://muv-demo-dental-2l25-nahda.vercel.app ● Error     Preview         38s          u",
      "  9h      nahda/muv-flagship      https://muv-flagship-hx2y-nahda.vercel.app    ● Ready     Production      2s           u",
    ].join("\n");
    const rows = parseDeploys(table);
    expect(rows.map((r) => [r.project, r.status, r.env])).toEqual([["bianca-preview", "Ready", "Production"], ["muv-demo-dental", "Error", "Preview"], ["muv-flagship", "Ready", "Production"]]);
    expect(deploysLine(rows)).toBe("Your last deploy, bianca-preview to production 6 hours ago, is ready. One recent deploy failed: muv-demo-dental, 8 hours ago, sir.");
    expect(await answerDeploys({ skill: "deploys", action: "latest" }, async () => table.replace(/Error/, "Ready"))).toBe("Your last deploy, bianca-preview to production 6 hours ago, is ready, and the 2 before it are all ready too, sir.");
  });
});

describe("rename by date (direct, undoable)", () => {
  test("words → folder", async () => {
    const { filesIntent } = await import("./jarvis-skills/pc-control");
    expect(filesIntent("rename the screenshots in the jarvis-suite-shots folder in my Downloads by date")).toEqual({ skill: "files", action: "rename_by_date", folder: "Downloads/jarvis-suite-shots", kind: "screenshots" });
    expect(filesIntent("rename my screenshots by date")).toEqual({ skill: "files", action: "rename_by_date", folder: "Pictures/Screenshots", kind: "screenshots" });
    expect(filesIntent("undo the rename")).toEqual({ skill: "files", action: "undo_rename" });
    expect(filesIntent(String.raw`rename the files in C:\Windows by date`)).toBeNull();
  });
  test("renames in date order, a second one that day gets ' 2', and undo puts them back", async () => {
    const { answerFiles, datedNames } = await import("./jarvis-skills/pc-control");
    const { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } = await import("node:fs");
    expect(datedNames([{ name: "b.png", ms: Date.parse("2026-09-20T10:00") }, { name: "a.PNG", ms: Date.parse("2026-09-18T10:00") }, { name: "c.png", ms: Date.parse("2026-09-20T12:00") }])).toEqual([
      { from: "a.PNG", to: "2026-09-18.png" },
      { from: "b.png", to: "2026-09-20.png" },
      { from: "c.png", to: "2026-09-20 2.png" },
    ]);
    const home = mkdtempSync(join(tmpdir(), "rename-"));
    const root = mkdtempSync(join(tmpdir(), "rename-root-"));
    const dir = join(home, "Downloads", "shots");
    mkdirSync(dir, { recursive: true });
    for (const [n, d] of [["Screenshot 1.png", "2026-09-18T10:00"], ["Screenshot 2.png", "2026-09-19T10:00"], ["notes.txt", "2026-09-19T10:00"]] as const) {
      writeFileSync(join(dir, n), "x");
      utimesSync(join(dir, n), new Date(d), new Date(d));
    }
    expect(await answerFiles({ skill: "files", action: "rename_by_date", folder: "Downloads/shots", kind: "screenshots" }, { root, home })).toMatch(/^Renamed 2 screenshots by date/);
    expect(readdirSync(dir).sort()).toEqual(["2026-09-18.png", "2026-09-19.png", "notes.txt"]);
    expect(await answerFiles({ skill: "files", action: "undo_rename" }, { root, home })).toMatch(/^Put 2 files back/);
    expect(readdirSync(dir).sort()).toEqual(["Screenshot 1.png", "Screenshot 2.png", "notes.txt"]);
  });
});

describe("the brain's screen_act keeps his whole task", () => {
  test("a goal cut to its first click becomes his own words; a plain order stays", async () => {
    const { guardToolCall } = await import("./free-voice");
    const call = (goal: string) => ({ id: "c1", type: "function" as const, function: { name: "screen_act", arguments: JSON.stringify({ goal }) } });
    const goalOf = (c: { function: { arguments: string } }) => JSON.parse(c.function.arguments).goal;
    expect(goalOf(guardToolCall(call("click Notifications"), "turn off email alerts in this app"))).toBe("turn off email alerts in this app");
    // (J2: a plain click on a named control is the agent-browser hands', not a screen goal.)
    expect(JSON.parse(guardToolCall(call("click Next"), "click Next on this page").function.arguments)).toEqual({ skill: "browser", action: "click", target: "Next" });
    expect(goalOf(guardToolCall(call("click Next"), "click Next in there"))).toBe("click Next");
    expect(goalOf(guardToolCall(call("help me finish this form"), "help me finish this form"))).toBe("help me finish this form");
  });
  test("window management is never a click job, even when the brain picks screen_act (25 Sep: it clicked his other monitor)", async () => {
    const { guardToolCall } = await import("./free-voice");
    const call = (name: string, args: Record<string, unknown>) => ({ id: "c1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
    for (const said of ["Can you bring the tab in front of my screen right now?", "Can you open my Chrome tab? It's not showing up in my front screen.", "bring the Chrome browser up on my main screen"]) {
      const out = guardToolCall(call("screen_act", { goal: said }), said);
      expect(out.function.name).toBe("skill");
      expect(JSON.parse(out.function.arguments)).toMatchObject({ skill: "window", action: "bring", screen: "main" });
    }
    const shared = guardToolCall(call("browser_act", { action: "click", target: "tab" }), "put Chrome on my other screen", { sharing: true });
    expect(JSON.parse(shared.function.arguments)).toEqual({ skill: "window", action: "move", target: "chrome", screen: "other" });
    // A real click on a screen stays a click.
    expect(guardToolCall(call("screen_act", { goal: "click Submit" }), "click Submit on my main screen").function.name).toBe("screen_act");
  });
});
