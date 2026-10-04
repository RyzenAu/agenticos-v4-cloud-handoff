// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { DOUBLE_CLICK_MS, guardDoubleClick } from "./double-click";

/** `detail` is the browser's click count: 1 a single click, 2 the second click of a double-click, 0 a link opened from the keyboard. */
const click = (detail: number, isLink = true) => {
  const calls = { prevented: 0 };
  const target = { closest: (sel: string) => (isLink && sel === "a" ? {} : null) } as unknown as EventTarget;
  return { event: { target, detail, preventDefault: () => calls.prevented++, stopPropagation: () => {} }, calls };
};

test("the second click of a double-click is ignored, a later one is not", () => {
  const last = { current: 0 };
  const first = click(1);
  expect(guardDoubleClick(first.event, last, 10_000)).toBe(false);
  const second = click(2); // the row under the pointer has changed: this would have been Goals
  expect(guardDoubleClick(second.event, last, 10_000 + 30)).toBe(true);
  expect(second.calls.prevented).toBe(1);
  const later = click(1);
  expect(guardDoubleClick(later.event, last, 10_000 + DOUBLE_CLICK_MS + 1)).toBe(false);
});

test("round 8: a deliberate single click on another link right after arriving goes through (Automations, then Memory, 300 ms apart)", () => {
  const last = { current: 0 };
  expect(guardDoubleClick(click(1).event, last, 20_000)).toBe(false);
  const next = click(1);
  expect(guardDoubleClick(next.event, last, 20_000 + 300)).toBe(false);
  expect(next.calls.prevented).toBe(0);
  const immediate = click(1);
  expect(guardDoubleClick(immediate.event, last, 20_000 + 300)).toBe(false);
});

test("a link opened from the keyboard (detail 0) is never held back, however soon", () => {
  const last = { current: 30_000 };
  const k = click(0);
  expect(guardDoubleClick(k.event, last, 30_010)).toBe(false);
  expect(k.calls.prevented).toBe(0);
});

test("clicks that are not on a link (the rail toggle, the badge area) are never held back", () => {
  const last = { current: 10_000 };
  const c = click(2, false);
  expect(guardDoubleClick(c.event, last, 10_010)).toBe(false);
  expect(c.calls.prevented).toBe(0);
});
