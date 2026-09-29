// Where a narrated-workflow draft lives: .operator-data/skill-drafts/<id>.json. One file per
// draft, so the OS review list (a new small component, not this file) can show, approve, edit or
// discard each independently. Nothing here installs a skill until approveDraft() is called
// explicitly — never automatically when the transcript finishes.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { draftSkillMarkdown, str, strList, type DecisionPoint, type SkillDraftContent } from "./narrate";

export type DraftStatus = "draft" | "approved" | "discarded";
export type SkillDraft = SkillDraftContent & {
  id: string;
  topic: string;
  /** Kept only here. Deleting the draft (deleteDraft) deletes the transcript with it. */
  transcript: string;
  status: DraftStatus;
  createdAt: string;
  reviewedAt?: string;
  installedTo?: string[];
};

const draftsDir = (operatorData: string) => join(operatorData, "skill-drafts");
const draftFile = (operatorData: string, id: string) => join(draftsDir(operatorData), `${id}.json`);

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** A safe, stable id: the skill's own slug plus the date, so two drafts on the same topic on
 *  different days don't collide and the filename stays readable. */
function draftId(name: string, now: Date): string {
  return `${name}-${now.toISOString().slice(0, 10)}`;
}

export function saveDraft(operatorData: string, content: SkillDraftContent, topic: string, transcript: string, now = new Date()): SkillDraft {
  const id = draftId(content.name, now);
  const draft: SkillDraft = { ...content, id, topic: topic.trim().slice(0, 200), transcript, status: "draft", createdAt: now.toISOString() };
  writeJsonAtomic(draftFile(operatorData, id), draft);
  return draft;
}

export function listDrafts(operatorData: string): SkillDraft[] {
  const dir = draftsDir(operatorData);
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf-8")) as SkillDraft;
      } catch {
        return null;
      }
    })
    .filter((d): d is SkillDraft => d !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDraft(operatorData: string, id: string): SkillDraft | null {
  const file = draftFile(operatorData, id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as SkillDraft;
  } catch {
    return null;
  }
}

export type DraftEdit = Partial<{ title: string; summary: string; steps: string[]; tools: string[]; decisionPoints: DecisionPoint[] }>;

/** Only a pending draft can be edited — an approved or discarded one is a record of what
 *  happened, not something to quietly rewrite. */
export function editDraft(operatorData: string, id: string, patch: DraftEdit, now = new Date()): SkillDraft {
  const draft = getDraft(operatorData, id);
  if (!draft) throw new Error("That draft doesn't exist.");
  if (draft.status !== "draft") throw new Error(`This draft is already ${draft.status} — start a new narration to change it.`);
  const next: SkillDraft = {
    ...draft,
    title: patch.title !== undefined ? str(patch.title, 120) : draft.title,
    summary: patch.summary !== undefined ? str(patch.summary, 400) : draft.summary,
    steps: patch.steps !== undefined ? strList(patch.steps, 20, 300) : draft.steps,
    tools: patch.tools !== undefined ? strList(patch.tools, 15, 80) : draft.tools,
    decisionPoints: patch.decisionPoints ?? draft.decisionPoints,
    reviewedAt: now.toISOString(),
  };
  writeJsonAtomic(draftFile(operatorData, id), next);
  return next;
}

export function discardDraft(operatorData: string, id: string, now = new Date()): SkillDraft {
  const draft = getDraft(operatorData, id);
  if (!draft) throw new Error("That draft doesn't exist.");
  const next: SkillDraft = { ...draft, status: "discarded", reviewedAt: now.toISOString() };
  writeJsonAtomic(draftFile(operatorData, id), next);
  return next;
}

/** The owner deletes a draft outright — and its transcript with it. Never automatic. */
export function deleteDraft(operatorData: string, id: string): void {
  rmSync(draftFile(operatorData, id), { force: true });
}

export type ApproveTargets = { claudeSkillsDir: string; hermesSkillsDir?: string | null };

/** Writes the SKILL.md into ~/.claude/skills/<name>/ and, if given, the Hermes skills folder too.
 *  This is the only place a narrated draft ever becomes a real, loadable skill — and only when
 *  called explicitly (the owner clicked "approve", or said "build skill candidate" — see
 *  skills/dream/SKILL.md for that same approval pattern on the Dream's skill candidates). */
export function approveDraft(operatorData: string, id: string, targets: ApproveTargets, now = new Date()): SkillDraft {
  const draft = getDraft(operatorData, id);
  if (!draft) throw new Error("That draft doesn't exist.");
  if (draft.status === "discarded") throw new Error("A discarded draft can't be approved — edit it back first, or narrate it again.");
  const markdown = draftSkillMarkdown(draft);
  const installedTo: string[] = [];
  const claudeDir = join(targets.claudeSkillsDir, draft.name);
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "SKILL.md"), markdown);
  installedTo.push(join(claudeDir, "SKILL.md"));
  if (targets.hermesSkillsDir) {
    try {
      const hermesDir = join(targets.hermesSkillsDir, draft.name);
      mkdirSync(hermesDir, { recursive: true });
      writeFileSync(join(hermesDir, "SKILL.md"), markdown);
      installedTo.push(join(hermesDir, "SKILL.md"));
    } catch {
      /* Hermes tree may not exist on this machine — the Claude Code install above still landed */
    }
  }
  const next: SkillDraft = { ...draft, status: "approved", reviewedAt: now.toISOString(), installedTo };
  writeJsonAtomic(draftFile(operatorData, id), next);
  return next;
}
