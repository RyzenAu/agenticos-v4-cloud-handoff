// "What skills should I build?": reads the skill candidates the overnight Dream proposed (the
// 30-day skill-miner pass in scripts/dream/skill-miner.ts) and reads them back. Read-only — this
// never creates, installs or edits a skill. Building one is still a typed instruction to Claude
// Code ("build skill candidate 2"), per skills/dream/SKILL.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { norm } from "./text";

export type SkillCandidatesRequest = { skill: "skill_candidates"; action: "say" };

export function skillCandidatesIntent(utterance: string): SkillCandidatesRequest | null {
  const u = norm(utterance).replace(/^(?:jarvis|hey jarvis|so|okay|ok)[, ]+/, "");
  if (u.length > 90) return null;
  const about =
    /^what skills? should i (?:build|make|create)(?: next)?$/.test(u) ||
    /^(?:any |what )?skill candidates?(?: today| this morning)?$/.test(u) ||
    /^what should (?:become|i turn into) a skill$/.test(u) ||
    /^(?:read|tell me) (?:me )?(?:my |the )?skill candidates$/.test(u);
  return about ? { skill: "skill_candidates", action: "say" } : null;
}

export type SkillCandidate = {
  id: string;
  name: string;
  evidence: string[];
  steps: string[];
  route: "skill" | "cli" | "hermes" | "screen";
  effort: "S" | "M" | "L";
  jevFit: { fits: boolean; decision: string };
};

/** The most recent dream-YYYY-MM-DD.json under `stateDir`/dreams, or null. Best-effort: a missing
 *  or unreadable file is not an error, just nothing to report. */
export function latestSkillCandidates(stateDir: string): { date: string; candidates: SkillCandidate[] } | null {
  const dir = join(stateDir, "dreams");
  if (!existsSync(dir)) return null;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^dream-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  const latest = files.pop();
  if (!latest) return null;
  try {
    const doc = JSON.parse(readFileSync(join(dir, latest), "utf-8"));
    const candidates: SkillCandidate[] = Array.isArray(doc?.skillCandidates) ? doc.skillCandidates : [];
    return { date: String(doc?.date ?? latest.replace(/^dream-|\.json$/g, "")), candidates };
  } catch {
    return null;
  }
}

const ROUTE_WORD: Record<SkillCandidate["route"], string> = { skill: "a Claude Code skill", cli: "a CLI recipe", hermes: "a Hermes task", screen: "a screen routine" };

/** Three or four spoken sentences: how many candidates, the top one or two, how to approve. Pure. */
export function skillCandidatesLine(found: ReturnType<typeof latestSkillCandidates>): string {
  if (!found || found.candidates.length === 0)
    return "Last night's Dream didn't find a repeated task worth turning into a skill. Nothing to build yet.";
  const { candidates, date } = found;
  const top = candidates.slice(0, 2).map((c, i) => `${i + 1}) ${c.name}, as ${ROUTE_WORD[c.route]}, effort ${c.effort}`).join("; ");
  const restNote = candidates.length > 2 ? ` and ${candidates.length - 2} more on the dashboard` : "";
  return `From the ${date} Dream, I've got ${candidates.length} skill candidate${candidates.length === 1 ? "" : "s"}: ${top}${restNote}. Say "build skill candidate 1" or "2" if you want me to build one — I never build one on my own.`.replace(/\s+/g, " ").trim();
}

export function answerSkillCandidates(_req: SkillCandidatesRequest, deps: { stateDir: string }): string {
  return skillCandidatesLine(latestSkillCandidates(deps.stateDir));
}
