import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashInput, readShadow, recordDecisionShadow, shadowDir } from "./jev-shadow";

describe("hashInput", () => {
  test("is stable, short, and never the raw input", () => {
    const a = hashInput("the prospect's actual sensitive words");
    const b = hashInput("the prospect's actual sensitive words");
    const c = hashInput("something else entirely");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThanOrEqual(16);
    expect(a).not.toContain("sensitive");
  });
});

describe("recordDecisionShadow / readShadow", () => {
  test("round-trips a record under .operator-data/jev-shadow/<useCase>.jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-shadow-"));
    recordDecisionShadow(root, {
      caseId: "c1", useCase: "meeting-cues", timestamp: "2026-09-25T00:00:00.000Z", inputHash: hashInput("x"),
      questionVersion: "v1", model: "jev-latest", baselineDecision: ["price"], proposedDecision: ["price", "timing"],
      rawAnswers: { price: { noul: 0.9 } }, elapsedMs: 42, policyVersion: "meeting-cues-v1",
    });
    const rows = readShadow(root, "meeting-cues");
    expect(rows).toHaveLength(1);
    expect(rows[0].caseId).toBe("c1");
    expect(rows[0].proposedDecision).toEqual(["price", "timing"]);
    expect(readFileSync(join(shadowDir(root), "meeting-cues.jsonl"), "utf8")).not.toContain("\r");
  });

  test("never throws even if it can't write (best-effort, observational only)", () => {
    // A path a file can't be created under (its parent is a file, not a directory).
    const root = mkdtempSync(join(tmpdir(), "jev-shadow-"));
    const blocked = join(root, "blocked-file");
    require("node:fs").writeFileSync(blocked, "x");
    expect(() =>
      recordDecisionShadow(join(blocked, "nested"), {
        caseId: "c1", useCase: "meeting-cues", timestamp: "now", inputHash: "h", questionVersion: "v1",
        model: "jev-latest", baselineDecision: null, proposedDecision: null, rawAnswers: null, elapsedMs: 0, policyVersion: "v1",
      }),
    ).not.toThrow();
  });

  test("readShadow returns an empty array when nothing was ever recorded", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-shadow-"));
    expect(readShadow(root, "crm-duplicates")).toEqual([]);
  });

  test("sanitises the use case into a safe filename", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-shadow-"));
    recordDecisionShadow(root, {
      caseId: "c1", useCase: "../../etc-passwd", timestamp: "now", inputHash: "h", questionVersion: "v1",
      model: "jev-latest", baselineDecision: null, proposedDecision: null, rawAnswers: null, elapsedMs: 0, policyVersion: "v1",
    });
    const rows = readShadow(root, "../../etc-passwd");
    expect(rows).toHaveLength(1);
  });
});
