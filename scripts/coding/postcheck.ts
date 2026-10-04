import type { CodingEvent } from "./contracts";

/**
 * Why a builder's own `git commit` didn't happen: the policy refusals for this role since its turn began.
 * A run that ends with "no commit" or "uncommitted files" used to say only that, so the owner (or a
 * resume) repeated a whole model turn without knowing the commit itself was being refused (job 674f43,
 * 1 Oct 2026). Only refusals of git add/commit are named; nothing from the command beyond its verb and
 * the rule is repeated (a commit message can carry anything).
 */
export function commitRefusalNote(events: readonly CodingEvent[], roleId: string, sinceMs: number): string | null {
  const refused = events.filter((e): e is Extract<CodingEvent, { type: "policy" }> =>
    e.type === "policy" && e.roleId === roleId && Date.parse(e.at) >= sinceMs && e.payload.decision !== "auto-allow" && /^\s*(?:cd\s+\S+\s*&&\s*)?git\s+(?:add|commit)\b/i.test(e.payload.target ?? ""));
  if (!refused.length) return null;
  const rules = [...new Set(refused.map((e) => e.payload.rule))].join(", ");
  return `its git commit was refused by the coding policy ${refused.length} time${refused.length === 1 ? "" : "s"} (rule: ${rules}); the work is in its working copy, staged or not`;
}
