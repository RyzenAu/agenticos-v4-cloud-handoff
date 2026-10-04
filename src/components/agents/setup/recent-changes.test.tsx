// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { asBotView, seedBots, type BotHistoryEntry } from "@/lib/agent-bots";
import { RecentChanges, historyLine, newestFirst } from "./manage-section";

const dom = (el: ReactElement) => {
  const html = renderToStaticMarkup(el).replace(/<!-- -->/g, "");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return { document, text: document.body.textContent ?? "" };
};
const T = Date.parse("2026-10-03T03:14:00Z");
const e = (n: number, over: Partial<BotHistoryEntry> = {}): BotHistoryEntry => ({ at: T + n * 60_000, by: "mehroz", action: "edited", note: "instructions, memory", ...over });

describe("the hub's history is read, not dropped", () => {
  const raw = { ...seedBots()[0], readiness: { state: "ready", reasons: [] } };
  test("asBotView keeps well-formed entries (names of fields only) and drops junk", () => {
    const view = asBotView({ ...raw, history: [{ at: 1, by: "usman", action: "created" }, { at: 2, by: "mehroz", action: "edited", note: "purpose" }, { at: "x", action: "edited" }, { at: 3, action: "teleported" }, "nope"] });
    expect(view!.history).toEqual([{ at: 1, by: "usman", action: "created" }, { at: 2, by: "mehroz", action: "edited", note: "purpose" }]);
  });
  test("a bot with no history has no history key (nothing else about the view changes)", () => {
    expect("history" in asBotView(raw)!).toBe(false);
    expect("history" in asBotView({ ...raw, history: [] })!).toBe(false);
  });
});

describe("the lines", () => {
  test("each action reads as a short sentence; the hub's 'from research' is not doubled", () => {
    expect(historyLine(e(0))).toBe("Mehroz changed instructions, memory");
    expect(historyLine(e(0, { note: undefined }))).toBe("Mehroz changed its settings");
    expect(historyLine(e(0, { action: "created", by: "usman", note: undefined }))).toBe("Usman made it");
    expect(historyLine(e(0, { action: "duplicated", note: "from research" }))).toBe("Mehroz copied it from Research");
    expect(historyLine(e(0, { action: "archived", note: "after current work" }))).toBe("Mehroz archived it (after current work)");
    expect(historyLine(e(0, { action: "unarchived", note: undefined }))).toBe("Mehroz brought it back");
    expect(historyLine(e(0, { by: "unknown", note: "name" }))).toBe("Someone changed name");
  });
  test("newest first, whatever order the hub sent", () => {
    expect(newestFirst([e(1), e(3), e(2)]).map((x) => x.at - T)).toEqual([180_000, 120_000, 60_000]);
    expect(newestFirst(undefined)).toEqual([]);
  });
});

describe("Recent changes in Setup", () => {
  test("nothing recorded, nothing shown", () => {
    expect(dom(<RecentChanges bot={{}} />).document.querySelector('[data-testid="recent-changes"]')).toBeNull();
  });
  test("collapsed by default and calm: a count and the lines inert inside, newest first, with the person and a house-format time", () => {
    const r = dom(<RecentChanges bot={{ history: [e(0, { action: "created", by: "usman", note: undefined }), e(5)] }} />);
    const trigger = r.document.querySelector("button[aria-expanded]")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Recent changes");
    expect(trigger.textContent).toContain("2");
    const lines = [...r.document.querySelectorAll("li")];
    expect(lines.map((l) => l.querySelector("span")?.textContent)).toEqual(["Mehroz changed instructions, memory", "Usman made it"]);
    expect(lines[0]!.querySelector("time")!.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(r.document.querySelector('[id$="-panel"]')!.hasAttribute("inert")).toBe(true);
  });
  test("five lines, the rest behind Show all", () => {
    const history = Array.from({ length: 8 }, (_, i) => e(i));
    const r = dom(<RecentChanges bot={{ history }} />);
    expect(r.document.querySelectorAll("li").length).toBe(5);
    expect([...r.document.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Show all 8");
    expect(dom(<RecentChanges bot={{ history: history.slice(0, 5) }} />).document.querySelectorAll("button").length).toBe(1);
  });
});
