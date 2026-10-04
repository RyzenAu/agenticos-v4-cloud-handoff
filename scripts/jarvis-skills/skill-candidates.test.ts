import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerSkillCandidates, latestSkillCandidates, skillCandidatesIntent, skillCandidatesLine, type SkillCandidate } from "./skill-candidates";
import { skillIntent } from "./index";

const CANDIDATE: SkillCandidate = {
  id: "lead-source-triage",
  name: "Lead source triage",
  evidence: ["Same 3-step check done by hand on 6 of the last 30 days"],
  steps: ["Pull the lead", "Check the source", "Tag it"],
  route: "cli",
  effort: "S",
  jevFit: { fits: true, decision: "lead-source-classification" },
};

describe("what skills should I build", () => {
  test("words", () => {
    expect(skillCandidatesIntent("what skills should I build")).toEqual({ skill: "skill_candidates", action: "say" });
    expect(skillCandidatesIntent("what skills should I build next")).toEqual({ skill: "skill_candidates", action: "say" });
    expect(skillCandidatesIntent("any skill candidates")).toEqual({ skill: "skill_candidates", action: "say" });
    expect(skillCandidatesIntent("what's the weather")).toBeNull();
    expect(skillIntent("what skills should I build")).toEqual({ skill: "skill_candidates", action: "say" });
  });

  test("no dream file yet: says so plainly, never invents", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillcand-"));
    expect(latestSkillCandidates(stateDir)).toBeNull();
    expect(answerSkillCandidates({ skill: "skill_candidates", action: "say" }, { stateDir })).toMatch(/didn't find/);
  });

  test("reads the latest dream file's skillCandidates and speaks the top two", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skillcand-"));
    const dreamsDir = join(stateDir, "dreams");
    mkdirSync(dreamsDir, { recursive: true });
    writeFileSync(join(dreamsDir, "dream-2026-09-20.json"), JSON.stringify({ date: "2026-09-20", skillCandidates: [] }));
    writeFileSync(join(dreamsDir, "dream-2026-09-25.json"), JSON.stringify({ date: "2026-09-25", skillCandidates: [CANDIDATE, { ...CANDIDATE, id: "b", name: "Second one" }, { ...CANDIDATE, id: "c", name: "Third one" }] }));
    const found = latestSkillCandidates(stateDir);
    expect(found?.date).toBe("2026-09-25");
    expect(found?.candidates.length).toBe(3);
    const said = skillCandidatesLine(found);
    expect(said).toMatch(/3 skill candidates/);
    expect(said).toMatch(/Lead source triage/);
    expect(said).toMatch(/1 more on the dashboard/);
    expect(said).toMatch(/build skill candidate/);
  });

  test("never suggests building automatically", () => {
    const said = skillCandidatesLine({ date: "2026-09-25", candidates: [CANDIDATE] });
    expect(said).toMatch(/I never build one on my own/);
  });
});
