// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { focusReturnTarget } from "./dialog-focus";

const el = (isConnected: boolean, rects: number) => ({ isConnected, getClientRects: () => ({ length: rects }) }) as unknown as HTMLElement;

test("focus goes back to a connected, visible opener only", () => {
  const shown = el(true, 1);
  expect(focusReturnTarget(shown)).toBe(shown);
  expect(focusReturnTarget(el(true, 0))).toBeNull(); // in the page but hidden: focus() would do nothing
  expect(focusReturnTarget(el(false, 1))).toBeNull(); // removed from the page
  expect(focusReturnTarget(null)).toBeNull();
});
