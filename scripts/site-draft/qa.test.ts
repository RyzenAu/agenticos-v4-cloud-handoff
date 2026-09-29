import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditClaims, auditPageWeight, auditMotionPerformance, runQa, fixNotesFrom } from "./qa";
import type { Evidence } from "./evidence";

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "site-draft-qa-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    leadId: 1,
    name: "St Clair Dental",
    vertical: "dental",
    area: "Mount Druitt NSW",
    generatedAt: new Date().toISOString(),
    facts: [],
    services: [],
    hasOwnWebsite: false,
    ownSiteReachable: false,
    robotsBlocked: false,
    complianceNotes: [],
    ...overrides,
  };
}

describe("auditClaims", () => {
  test("passes clean, evidence-only copy", () => {
    const html = "<html><body><h1>St Clair Dental</h1><p>Call to check availability.</p></body></html>";
    expect(auditClaims(html, evidence())).toEqual([]);
  });

  test("fails on a star rating that isn't in evidence", () => {
    const html = "<html><body><p>Rated 5 stars by our patients!</p></body></html>";
    const issues = auditClaims(html, evidence());
    expect(issues.some((i) => i.severity === "fail" && /star/.test(i.detail))).toBe(true);
  });

  test("fails on a named staff member", () => {
    const html = "<html><body><p>Meet Dr. Jane Smith, our lead dentist.</p></body></html>";
    const issues = auditClaims(html, evidence());
    expect(issues.some((i) => /named staff/.test(i.detail))).toBe(true);
  });

  test("fails on a price claim", () => {
    const html = "<html><body><p>Check-ups from $49.</p></body></html>";
    const issues = auditClaims(html, evidence());
    expect(issues.some((i) => /price/.test(i.detail))).toBe(true);
  });
});

describe("auditPageWeight", () => {
  test("fails when index.html is missing", () => {
    const dir = tempDir();
    const issues = auditPageWeight(dir);
    expect(issues.some((i) => i.severity === "fail")).toBe(true);
  });

  test("warns on an external non-font host", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), `<html><head><script src="https://example-cdn.com/x.js"></script></head></html>`, "utf8");
    const issues = auditPageWeight(dir);
    expect(issues.some((i) => /external hosts/.test(i.detail))).toBe(true);
  });

  test("does not flag Google Fonts", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), `<html><head><link href="https://fonts.googleapis.com/css2?family=Inter"></head></html>`, "utf8");
    const issues = auditPageWeight(dir);
    expect(issues.some((i) => /external hosts/.test(i.detail))).toBe(false);
  });
});

describe("auditMotionPerformance", () => {
  test("fails motion with no reduced-motion guard", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), `<html><head><style>@keyframes fade{to{opacity:1}}</style></head><body>ok</body></html>`, "utf8");
    const issues = auditMotionPerformance(dir);
    expect(issues.some((i) => i.severity === "fail" && /reduced-motion/.test(i.detail))).toBe(true);
  });

  test("passes motion that has a reduced-motion guard", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "index.html"),
      `<html><head><style>@keyframes fade{to{opacity:1}} @media (prefers-reduced-motion: reduce){*{animation:none}}</style></head><body>ok</body></html>`,
      "utf8",
    );
    const issues = auditMotionPerformance(dir);
    expect(issues.some((i) => i.severity === "fail")).toBe(false);
  });

  test("warns on a render-blocking external script", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), `<html><head><script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script></head></html>`, "utf8");
    const issues = auditMotionPerformance(dir);
    expect(issues.some((i) => /defer\/async/.test(i.detail))).toBe(true);
  });

  test("does not warn when the script has defer", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), `<html><head><script defer src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script></head></html>`, "utf8");
    const issues = auditMotionPerformance(dir);
    expect(issues.some((i) => /defer\/async/.test(i.detail))).toBe(false);
  });
});

describe("runQa", () => {
  test("uses an injected runner and produces a report + files, without needing agent-browser installed", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html><body><h1>Test Co</h1></body></html>", "utf8");
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args.includes("errors")) return { ok: true, stdout: "[]" };
      if (args.includes("a11y")) return { ok: true, stdout: JSON.stringify({ violations: [] }) };
      return { ok: true, stdout: "" };
    };
    const report = await runQa(dir, "file:///x/index.html", evidence(), { runner });
    expect(report.pass).toBe(true);
    expect(calls.some((c) => c.includes("open"))).toBe(true);
    expect(calls.some((c) => c.includes("close"))).toBe(true);
  });

  test("fails the draft on a real console error", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), "<html><body>ok</body></html>", "utf8");
    const runner = async (args: string[]) => {
      if (args.includes("errors")) return { ok: true, stdout: JSON.stringify(["Uncaught TypeError: x is not a function"]) };
      if (args.includes("a11y")) return { ok: true, stdout: JSON.stringify({ violations: [] }) };
      return { ok: true, stdout: "" };
    };
    const report = await runQa(dir, "file:///x/index.html", evidence(), { runner });
    expect(report.pass).toBe(false);
    expect(report.issues.some((i) => i.area === "console")).toBe(true);
  });
});

describe("fixNotesFrom", () => {
  test("only includes fail-severity issues", () => {
    const notes = fixNotesFrom({
      pass: false,
      generatedAt: new Date().toISOString(),
      screenshots: { desktop: null, mobile: null },
      issues: [
        { severity: "fail", area: "console", detail: "boom" },
        { severity: "warn", area: "performance", detail: "heavy" },
      ],
    });
    expect(notes).toMatch("boom");
    expect(notes).not.toMatch("heavy");
  });
});
