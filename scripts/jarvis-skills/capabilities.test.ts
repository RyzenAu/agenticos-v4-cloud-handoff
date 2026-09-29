import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABILITIES, answerCapabilities, capabilitiesIntent, capabilitiesLine, capabilitiesPage, lastSuite } from "./capabilities";
import { skillIntent } from "./index";

describe("what can you do on my PC", () => {
  test("words", () => {
    expect(capabilitiesIntent("what can you do on my PC")).toEqual({ skill: "capabilities", action: "say" });
    expect(capabilitiesIntent("show me what you can do on my PC")).toEqual({ skill: "capabilities", action: "show" });
    expect(capabilitiesIntent("what can you do about the leak")).toBeNull();
    expect(skillIntent("what are your capabilities")).toEqual({ skill: "capabilities", action: "say" });
  });
  test("every ability names real suite checks; the page marks each from the last run", () => {
    const root = mkdtempSync(join(tmpdir(), "caps-"));
    mkdirSync(join(root, ".operator-data"));
    writeFileSync(join(root, ".operator-data", "jarvis-e2e-last.json"), JSON.stringify({ at: "2026-09-25T00:00:00Z", rows: [{ id: "maths", say: "what's 18% of 4,850", ok: true, ms: 12 }, { id: "zip-folder", say: "zip it", ok: false, ms: 900 }, { id: "vscode-tests", say: "vs code", ok: false, skipped: "his VS Code", ms: 0 }] }));
    const suite = lastSuite(root);
    expect(capabilitiesLine(suite, false)).toMatch(/In my last check-up, 1 of 2 everyday tasks worked end to end\./);
    const page = capabilitiesPage(suite);
    expect(page).toMatch(/works · 0\.0 s/);
    expect(page).toMatch(/failed last run/);
    expect(page).toMatch(/skipped/);
    expect(ABILITIES.every((a) => a.checks.length && a.examples.length)).toBe(true);
  });
  test("show writes the page and opens it", async () => {
    const root = mkdtempSync(join(tmpdir(), "caps-"));
    const opened: string[] = [];
    const said = await answerCapabilities({ skill: "capabilities", action: "show" }, { root, open: (f) => opened.push(f) });
    expect(said).toMatch(/The full list is on screen\./);
    expect(readFileSync(opened[0], "utf8")).toMatch(/What Jarvis can do on this PC/);
  });
});
