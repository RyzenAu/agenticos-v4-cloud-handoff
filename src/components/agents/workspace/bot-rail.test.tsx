// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotRail, BotSelector, initialOf } from "./bot-selector";
import type { Bot } from "./bots";
import { shortStatus, statusAction, type BotStatus } from "./status";

const dom = (el: ReactElement) => {
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>).replace(/<!-- -->/g, "");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return { html, document, text: document.body.textContent ?? "" };
};
const bot = (id: string, over: Partial<Bot> = {}): Bot => ({ id, name: id[0]!.toUpperCase() + id.slice(1), purpose: "p", computer: id, coding: { enabled: false, accountSlot: null, model: null }, ...over });
const ARCHIVED = { lifecycle: "archived" as const, archived: { at: 1, by: "mehroz", afterCurrentWork: false }, rev: 4 };
const st = (kind: BotStatus["kind"], text: string, tone: BotStatus["tone"] = "neutral"): BotStatus => ({ kind, tone, text });

describe("shortStatus: the few words under a bot's name in the list", () => {
  test("each live state has its own short phrase; the long sentence stays in the header", () => {
    const b = bot("research");
    expect(shortStatus(st("ready", "Ready", "success"), b)).toBe("Ready");
    expect(shortStatus(st("ready", "Ready. The last job did not finish", "warn"), b)).toBe("Ready, last job unfinished");
    expect(shortStatus(st("needs-you", "Needs you: its computer failed, the viewer could not reach its screen. Reconnect it", "danger"), b)).toBe("Needs you");
    expect(shortStatus(st("offline", "Offline: its computer is stopped. Start it from Show computer beside the chat"), b)).toBe("Offline");
    expect(shortStatus(st("unconfigured", "No computer yet. Choose one in Setup"), b)).toBe("No computer");
    expect(shortStatus(st("held", "You have the controls of its computer", "accent"), b)).toBe("You have the controls");
    expect(shortStatus(st("held", "Mehroz has the controls of its computer", "info"), b)).toBe("Someone has the controls");
    expect(shortStatus(st("working", "Starting its computer", "info"), b)).toBe("Starting its computer");
  });
  test("working names the task, shortened to fit one line", () => {
    const line = shortStatus(st("working", "Working on find every dental clinic in Parramatta and compare their opening hours", "info"), bot("research"));
    expect(line.startsWith("Working on find every")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(34);
    expect(shortStatus(st("working", "Busy with Builder's task; ask again when it finishes", "info"), bot("research"))).toBe("Working");
  });
  test("an archived bot says so whatever else is true", () => {
    expect(shortStatus(st("offline", "Archived. It takes no new requests"), bot("old", ARCHIVED))).toBe("Archived");
    expect(shortStatus(st("working", "Archived. Its earlier jobs are finishing"), bot("old", { lifecycle: "archiving" }))).toBe("Archiving");
  });
  test("the mark is the first letter, upper case; a blank name still has one", () => {
    expect(initialOf("scout")).toBe("S");
    expect(initialOf("  ")).toBe("?");
  });
});

describe("the bot list", () => {
  const statuses = { research: st("needs-you", "Needs you: approve the step", "warn"), builder: st("ready", "Ready", "success"), old: st("offline", "Archived", "neutral") };
  const rail = (bots: Bot[], value: string, panel: "new" | "archived" | null = null) => dom(<BotRail bots={bots} value={value} statuses={statuses} onChange={() => {}} panel={panel} onPanel={() => {}} />);

  test("each row carries the name, the live words and a dot; the open bot is the checked one", () => {
    const r = rail([bot("research"), bot("builder")], "research");
    const rows = [...r.document.querySelectorAll('[role="radio"]')];
    expect(rows.map((x) => x.getAttribute("data-bot-row"))).toEqual(["research", "builder"]);
    expect(rows.map((x) => x.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(rows[0]!.textContent).toContain("Needs you");
    expect(rows[1]!.textContent).toContain("Ready");
    expect(rows[0]!.getAttribute("title")).toBe("Needs you: approve the step");
  });
  test("one tab stop for the whole list (roving focus), arrows move within it", () => {
    const r = rail([bot("research"), bot("builder")], "builder");
    expect([...r.document.querySelectorAll('[role="radio"]')].map((x) => x.getAttribute("tabindex"))).toEqual(["-1", "0"]);
    expect(r.document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Choose an agent");
  });
  test("archived bots stay out of the list unless one is open; Show archived (n) counts them", () => {
    const bots = [bot("research"), bot("old", ARCHIVED)];
    expect([...rail(bots, "research").document.querySelectorAll('[role="radio"]')].map((x) => x.getAttribute("data-bot-row"))).toEqual(["research"]);
    expect([...rail(bots, "old").document.querySelectorAll('[role="radio"]')].map((x) => x.getAttribute("data-bot-row"))).toEqual(["research", "old"]);
    expect([...rail(bots, "research").document.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Show archived (1)");
  });
  test("New bot and Show archived are real toggles for a region the page shows", () => {
    const toggles = [...rail([bot("research")], "research", "new").document.querySelectorAll("button[aria-controls]")];
    expect(toggles.map((b) => [b.getAttribute("aria-controls"), b.getAttribute("aria-expanded")])).toEqual([["new-bot", "true"], ["archived-bots", "false"]]);
  });
  test("a page that owns the panels gets none from the selector row", () => {
    const owned = dom(<BotSelector bots={[bot("research")]} value="research" kinds={{}} onChange={() => {}} panel="new" onPanel={() => {}} />);
    expect(owned.document.querySelector('[data-testid="new-bot"]')).toBeNull();
    const own = dom(<BotSelector bots={[bot("research")]} value="research" kinds={{}} onChange={() => {}} />);
    expect(own.document.querySelector('[role="radiogroup"]')).not.toBeNull();
  });
});

describe("statusAction: the one button beside a status that asks something", () => {
  const b = bot("research");
  test("a failed computer, a paused job and an approval all lead to the computer", () => {
    expect(statusAction(st("needs-you", "Needs you: its computer failed. Reconnect it", "danger"), b)).toEqual({ label: "Show computer", tab: "computer" });
    expect(statusAction(st("needs-you", "Needs you: Research's job is paused while you hold the controls. Return them", "warn"), b)?.tab).toBe("computer");
    expect(statusAction(st("needs-you", "Needs you: approve the step Research asked about", "warn"), b)?.tab).toBe("computer");
  });
  test("a coding job that waits leads to Tasks, an unassigned bot to Setup, a bot with a stopped computer to its computer", () => {
    expect(statusAction(st("needs-you", "Needs you: confirm the plan for the invoice export", "warn"), b)).toEqual({ label: "Open Tasks", tab: "tasks" });
    expect(statusAction(st("unconfigured", "No computer yet. Choose one in Setup"), bot("x", { computer: null }))).toEqual({ label: "Choose a computer", tab: "setup" });
    expect(statusAction(st("offline", "Offline: its computer is stopped"), b)?.tab).toBe("computer");
    expect(statusAction(st("offline", "Offline: nothing"), bot("x", { computer: null }))?.tab).toBe("setup");
    expect(statusAction(st("held", "You have the controls of its computer", "accent"), b)?.tab).toBe("computer");
  });
  test("ready and working ask nothing; an archived bot points at Setup, where it is brought back", () => {
    expect(statusAction(st("ready", "Ready", "success"), b)).toBeNull();
    expect(statusAction(st("working", "Working on a report", "info"), b)).toBeNull();
    expect(statusAction(st("offline", "Archived."), bot("old", ARCHIVED))).toEqual({ label: "Open Setup", tab: "setup" });
  });
});
