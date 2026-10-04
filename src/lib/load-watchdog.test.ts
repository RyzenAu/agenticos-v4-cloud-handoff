// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { LOAD_WATCHDOG_MS, LOAD_WATCHDOG_SCRIPT } from "./load-watchdog";

test("the inline watchdog is self-contained, bounded and offers Reload", () => {
  // Serialised into the page: it must not reference module-level names.
  expect(LOAD_WATCHDOG_SCRIPT).not.toContain("GLOBAL");
  expect(LOAD_WATCHDOG_SCRIPT).toContain(`(window,${LOAD_WATCHDOG_MS})`);
  expect(LOAD_WATCHDOG_MS).toBeLessThanOrEqual(30_000);
  expect(LOAD_WATCHDOG_SCRIPT).toContain("Reload");
  // It runs and arms a timer without throwing in a minimal window.
  let armed = 0;
  const w: Record<string, unknown> = { setTimeout: (_f: () => void, ms: number) => { armed = ms; return 1; }, clearTimeout: () => {} };
  new Function("window", LOAD_WATCHDOG_SCRIPT)(w);
  expect(armed).toBe(LOAD_WATCHDOG_MS);
  expect(typeof (w.__agenticOsLoadWatchdog as { cancel: () => void }).cancel).toBe("function");
});
