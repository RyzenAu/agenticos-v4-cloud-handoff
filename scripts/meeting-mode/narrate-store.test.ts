import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveDraft, deleteDraft, discardDraft, editDraft, getDraft, listDrafts, saveDraft, type SkillDraft } from "./narrate-store";
import type { SkillDraftContent } from "./narrate";

const tmp = () => mkdtempSync(join(tmpdir(), "narrate-store-"));

const CONTENT: SkillDraftContent = {
  name: "prepare-a-lead-call",
  title: "Prepare a lead call",
  summary: "Pull up the lead, check for recent info, call them, log the outcome.",
  steps: ["Open the CRM and pull up the lead", "Check their site and listing", "Call them", "Log the outcome"],
  tools: ["CRM", "phone"],
  decisionPoints: [{ step: "Log the outcome", requiresApproval: false, why: "Just a record" }],
};

describe("saveDraft / listDrafts / getDraft", () => {
  test("a saved draft is a plain file the owner can open, and starts as 'draft'", () => {
    const operatorData = join(tmp(), ".operator-data");
    const draft = saveDraft(operatorData, CONTENT, "how I prepare a lead call", "First I... That's it.", new Date("2026-09-25T00:00:00Z"));
    expect(draft.status).toBe("draft");
    expect(draft.id).toBe("prepare-a-lead-call-2026-09-25");
    expect(existsSync(join(operatorData, "skill-drafts", `${draft.id}.json`))).toBe(true);
    expect(getDraft(operatorData, draft.id)).toEqual(draft);
    expect(listDrafts(operatorData)).toEqual([draft]);
  });

  test("no skill-drafts folder yet is an empty list, not an error", () => {
    expect(listDrafts(join(tmp(), ".operator-data"))).toEqual([]);
  });
});

describe("editDraft", () => {
  test("only a pending draft can be edited", () => {
    const operatorData = join(tmp(), ".operator-data");
    const draft = saveDraft(operatorData, CONTENT, "topic", "transcript");
    const edited = editDraft(operatorData, draft.id, { title: "Prepare a lead call (revised)", steps: ["Open the CRM", "Call them"] });
    expect(edited.title).toBe("Prepare a lead call (revised)");
    expect(edited.steps).toEqual(["Open the CRM", "Call them"]);
    expect(edited.summary).toBe(CONTENT.summary); // untouched field is kept
    const discarded = discardDraft(operatorData, draft.id);
    expect(() => editDraft(operatorData, discarded.id, { title: "nope" })).toThrow("already discarded");
  });

  test("editing a draft that doesn't exist fails clearly", () => {
    expect(() => editDraft(join(tmp(), ".operator-data"), "nope", { title: "x" })).toThrow("doesn't exist");
  });
});

describe("discardDraft / deleteDraft", () => {
  test("discard marks it, delete removes the file (and its transcript) entirely", () => {
    const operatorData = join(tmp(), ".operator-data");
    const draft = saveDraft(operatorData, CONTENT, "topic", "the transcript text");
    const discarded = discardDraft(operatorData, draft.id);
    expect(discarded.status).toBe("discarded");
    expect(getDraft(operatorData, draft.id)?.status).toBe("discarded");
    deleteDraft(operatorData, draft.id);
    expect(getDraft(operatorData, draft.id)).toBeNull();
  });
});

describe("approveDraft", () => {
  test("writes SKILL.md into the Claude skills dir and the Hermes skills dir when given", () => {
    const root = tmp();
    const operatorData = join(root, ".operator-data");
    const claudeSkillsDir = join(root, "claude-skills");
    const hermesSkillsDir = join(root, "hermes-skills");
    const draft = saveDraft(operatorData, CONTENT, "how I prepare a lead call", "transcript");
    const approved = approveDraft(operatorData, draft.id, { claudeSkillsDir, hermesSkillsDir }, new Date("2026-09-25T01:00:00Z"));
    expect(approved.status).toBe("approved");
    expect(approved.installedTo).toHaveLength(2);
    const claudeMd = readFileSync(join(claudeSkillsDir, "prepare-a-lead-call", "SKILL.md"), "utf-8");
    expect(claudeMd).toContain("name: prepare-a-lead-call");
    expect(readFileSync(join(hermesSkillsDir, "prepare-a-lead-call", "SKILL.md"), "utf-8")).toBe(claudeMd);
    expect(getDraft(operatorData, draft.id)?.status).toBe("approved");
  });

  test("works with no Hermes skills dir (not every machine has Hermes installed)", () => {
    const root = tmp();
    const operatorData = join(root, ".operator-data");
    const draft = saveDraft(operatorData, CONTENT, "topic", "transcript");
    const approved = approveDraft(operatorData, draft.id, { claudeSkillsDir: join(root, "claude-skills"), hermesSkillsDir: null });
    expect(approved.installedTo).toHaveLength(1);
  });

  test("a discarded draft cannot be approved", () => {
    const root = tmp();
    const operatorData = join(root, ".operator-data");
    const draft = saveDraft(operatorData, CONTENT, "topic", "transcript");
    discardDraft(operatorData, draft.id);
    expect(() => approveDraft(operatorData, draft.id, { claudeSkillsDir: join(root, "claude-skills") })).toThrow("discarded");
  });

  test("never writes a skill until approveDraft is called — saving alone installs nothing", () => {
    const root = tmp();
    const operatorData = join(root, ".operator-data");
    saveDraft(operatorData, CONTENT, "topic", "transcript");
    expect(existsSync(join(root, "claude-skills", "prepare-a-lead-call"))).toBe(false);
  });
});
