// Track 8 (UI truth), audit F2 MEM-10: /memory's "Refresh daily" line never hangs on "Checking…".
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFRESH_SLOW_MS, refreshSettingsText } from "../../src/components/operator/memory-connections";

test("loading → checking; slow → says the server is slow; failed → says so; missing → not reported", () => {
  expect(refreshSettingsText({ hasData: false, error: null, slow: false })).toEqual({ text: "Checking refresh settings…", problem: false });
  expect(refreshSettingsText({ hasData: false, error: null, slow: true }).text).toBe("Still checking refresh settings (the server is slow)…");
  const failed = refreshSettingsText({ hasData: false, error: new Error("Operator request failed (500)"), slow: true });
  expect(failed).toEqual({ text: "Couldn't check refresh settings (Operator request failed (500))", problem: true });
  expect(failed.text).not.toContain("Checking");
  expect(refreshSettingsText({ hasData: true, error: null, slow: false })).toEqual({ text: "Refresh settings weren't reported", problem: true });
});

test("settings read → the real setting, whatever the timers say", () => {
  expect(refreshSettingsText({ refresh: { daily: true, note: "" }, hasData: true, error: null, slow: true }).text).toBe("While your OS is running");
  expect(refreshSettingsText({ refresh: { daily: false, note: "" }, hasData: true, error: new Error("later refetch failed"), slow: false }).text).toBe("Keep enabled sources up to date");
  expect(REFRESH_SLOW_MS).toBeLessThanOrEqual(15_000);
});

test("the component renders this line (no inline 'Checking…' without an error branch)", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/components/operator/memory-connections.tsx"), "utf8");
  expect(src).toContain("refreshSettingsText({");
  expect(src).not.toContain('!appsQuery.data?.refresh ? "Checking refresh settings…"');
});
