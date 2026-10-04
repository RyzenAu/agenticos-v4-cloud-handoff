// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { CHAT_MIN, HANDLE, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, PANEL_STEP, PANEL_STORAGE_KEY, clampWidth, modeFor, panelMax, readPrefs, widthForKey, writePrefs } from "./panel-state";
import { resolveTab } from "./deep-link";

const memory = (seed?: string) => {
  const m = new Map<string, string>(seed === undefined ? [] : [[PANEL_STORAGE_KEY, seed]]);
  return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
};

describe("layout rules", () => {
  test("1200 and up is wide, 768 to 1199 is tablet, below is phone", () => {
    expect([1440, 1200, 1199, 768, 767, 390].map(modeFor)).toEqual(["wide", "wide", "tablet", "tablet", "phone", "phone"]);
  });

  test("the panel keeps its minimum and maximum, and never squeezes the conversation", () => {
    expect(clampWidth(100, 1400)).toBe(PANEL_MIN);
    expect(clampWidth(5000, 2400)).toBe(PANEL_MAX);
    expect(panelMax(1200)).toBe(1200 - CHAT_MIN - HANDLE);
    expect(clampWidth(900, 1200)).toBe(1200 - CHAT_MIN - HANDLE);
    expect(clampWidth(Number.NaN, 1400)).toBe(PANEL_DEFAULT);
  });

  test("keys: Left widens, Right narrows, Shift is a big step, Home and End are the limits, other keys are not ours", () => {
    expect(widthForKey("ArrowLeft", 440, 1400)).toBe(440 + PANEL_STEP);
    expect(widthForKey("ArrowRight", 440, 1400)).toBe(440 - PANEL_STEP);
    expect(widthForKey("ArrowLeft", 440, 1400, true)).toBe(536);
    expect(widthForKey("Home", 440, 1400)).toBe(PANEL_MIN);
    expect(widthForKey("End", 440, 1400)).toBe(panelMax(1400));
    expect(widthForKey("ArrowRight", PANEL_MIN, 1400)).toBe(PANEL_MIN);
    expect(widthForKey("a", 440, 1400)).toBeNull();
  });
});

describe("what the browser remembers", () => {
  test("round trip, and junk or missing storage is the default", () => {
    const { m, s } = memory();
    writePrefs({ open: true, width: 512 }, s);
    expect(readPrefs(s)).toEqual({ open: true, width: 512 });
    expect(readPrefs(memory("not json").s)).toEqual({ open: false, width: PANEL_DEFAULT });
    expect(readPrefs(memory(JSON.stringify({ open: "yes", width: 99999 })).s)).toEqual({ open: false, width: PANEL_MAX });
    expect(readPrefs(null)).toEqual({ open: false, width: PANEL_DEFAULT });
    expect(m.size).toBe(1);
  });

  test("storage that throws never breaks the layout", () => {
    const boom = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(readPrefs(boom)).toEqual({ open: false, width: PANEL_DEFAULT });
    expect(() => writePrefs({ open: true, width: 400 }, boom)).not.toThrow();
  });
});

describe("deep links", () => {
  test("?tab=computer lands on the conversation with the computer showing; the others are themselves", () => {
    expect(resolveTab("computer")).toEqual({ shown: "chat", openComputer: true });
    expect(resolveTab("chat")).toEqual({ shown: "chat", openComputer: false });
    expect(resolveTab("tasks")).toEqual({ shown: "tasks", openComputer: false });
    expect(resolveTab("setup")).toEqual({ shown: "setup", openComputer: false });
  });
});
