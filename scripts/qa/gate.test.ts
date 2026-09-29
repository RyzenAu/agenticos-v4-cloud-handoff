import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestGateResult, qaDir, renderMarkdown, runGate, writeReport } from "./gate";

// Synthetic fixtures only, per AGENTS.md -- never touches a real client build.
const scratchDirs: string[] = [];
function makeSite(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "qa-gate-"));
  scratchDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf("\\") === -1 ? full.lastIndexOf("/") : Math.max(full.lastIndexOf("\\"), full.lastIndexOf("/"))), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

describe("runGate (local directory)", () => {
  test("a clean preview build passes", async () => {
    const dir = makeSite({
      "index.html": [
        "<html><head>",
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta name="robots" content="noindex">',
        "</head><body>",
        '<img src="a.png" alt="Logo">',
        '<a href="/about">About</a>',
        "</body></html>",
      ].join("\n"),
      "about/index.html": [
        "<html><head>",
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta name="robots" content="noindex">',
        "</head><body>hi</body></html>",
      ].join("\n"),
      "a.png": "x",
    });
    const report = await runGate(dir, { root: dir, slug: "clean-site", mode: "preview" });
    expect(report.pass).toBe(true);
    expect(report.results.find((r) => r.id === "robots-noindex")?.severity).toBe("pass");
  });

  test("a preview build missing noindex fails the gate", async () => {
    const dir = makeSite({
      "index.html": '<html><head><meta name="viewport" content="width=device-width"></head><body>hi</body></html>',
    });
    const report = await runGate(dir, { root: dir, slug: "leaky-preview", mode: "preview" });
    expect(report.pass).toBe(false);
    expect(report.results.find((r) => r.id === "robots-noindex")?.severity).toBe("fail");
  });

  test("a production build with noindex left in fails the gate", async () => {
    const dir = makeSite({
      "index.html": '<html><head><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"></head><body>hi</body></html>',
    });
    const report = await runGate(dir, { root: dir, slug: "prod-site", mode: "production" });
    expect(report.pass).toBe(false);
  });

  test("a missing alt attribute fails the gate", async () => {
    const dir = makeSite({
      "index.html": '<html><head><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"></head><body><img src="a.png"></body></html>',
    });
    const report = await runGate(dir, { root: dir, slug: "no-alt", mode: "preview" });
    expect(report.pass).toBe(false);
    expect(report.results.find((r) => r.id === "alt-text")?.severity).toBe("fail");
  });

  test("a broken local link fails the gate", async () => {
    const dir = makeSite({
      "index.html": '<html><head><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"></head><body><a href="/nowhere">gone</a></body></html>',
    });
    const report = await runGate(dir, { root: dir, slug: "broken-link", mode: "preview" });
    expect(report.pass).toBe(false);
    expect(report.results.find((r) => r.id === "broken-links")?.severity).toBe("fail");
  });

  test("throws on a missing directory", async () => {
    await expect(runGate(join(tmpdir(), "does-not-exist-qa-gate"), { root: tmpdir() })).rejects.toThrow();
  });
});

describe("report writing + latestGateResult", () => {
  test("writes JSON + Markdown and latestGateResult reads it back", async () => {
    const dir = makeSite({
      "index.html": '<html><head><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"></head><body>hi</body></html>',
    });
    const report = await runGate(dir, { root: dir, slug: "round-trip", mode: "preview", now: new Date("2026-09-25T00:00:00Z") });
    const { jsonPath, mdPath } = writeReport(dir, report);
    expect(jsonPath).toContain("round-trip-2026-09-25.json");
    expect(mdPath).toContain("round-trip-2026-09-25.md");
    const latest = latestGateResult(dir, "round-trip");
    expect(latest?.pass).toBe(true);
    expect(latest?.date).toBe("2026-09-25");
  });

  test("latestGateResult is null when nothing has run for that slug", () => {
    const dir = makeSite({});
    expect(latestGateResult(dir, "never-run")).toBeNull();
  });

  test("latestGateResult picks the most recent date for a slug with multiple runs", async () => {
    const dir = makeSite({ "index.html": '<html><head><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width"></head></html>' });
    const older = await runGate(dir, { root: dir, slug: "multi", mode: "preview", now: new Date("2026-09-01T00:00:00Z") });
    writeReport(dir, older);
    const newer = await runGate(dir, { root: dir, slug: "multi", mode: "preview", now: new Date("2026-09-20T00:00:00Z") });
    writeReport(dir, newer);
    expect(latestGateResult(dir, "multi")?.date).toBe("2026-09-20");
  });

  test("renderMarkdown includes the PASS/FAIL badge and every check title", () => {
    const md = renderMarkdown({
      slug: "x", target: "x", mode: "preview", generatedAt: "2026-01-01T00:00:00Z", pass: false,
      results: [{ id: "a", title: "Thing checked", severity: "fail", detail: "broke" }],
    });
    expect(md).toContain("FAIL");
    expect(md).toContain("Thing checked");
  });
});

describe("qaDir", () => {
  test("nests under .operator-data/qa", () => {
    expect(qaDir("C:/root")).toBe(join("C:/root", ".operator-data", "qa"));
  });
});
