import type { CommandId, DoneCriterion, RepoRegistryEntry } from "./contracts";
import { siteBrief, siteObjective, skillsInRequest, SITE_SKILLS } from "../../src/lib/site-maker";
import { redactText } from "./redact";
import type { PlannerDraft } from "./shaper";
import { git, resolveBaseSha } from "./worktree";

/**
 * The plan for a "make a site" draft (F1, 29 Sep 2026). A site request is built by the Websites page (or by
 * Jarvis from the same words, src/lib/site-maker.ts), so its shape is known: the repo is named, the skills are
 * listed, the limits are fixed. That is enough to draft the plan WITHOUT the read-only Claude planner (no
 * allowance spent, no wait): the builder owns the site's own source folders, the checks are the repo's build
 * (or typecheck) commands, and the brief the builder gets is written from the chosen skills.
 *
 * Drafting reads the repo (`git ls-tree` at the base commit). It never changes it, and nothing starts until a
 * signed-in person presses Start (or says start after "Draft ready").
 */

/** Top-level folders a site's source lives in. Anything else (scripts, docs, review, memory, config) is not owned. */
const SITE_DIRS = ["src", "app", "components", "pages", "public", "styles", "assets", "content"];
/** Top-level files a static site is made of. */
const SITE_FILE = /^[A-Za-z0-9._-]+\.(?:html|css)$/;

/** What the builder owns in this repo at its base commit, from the tracked top level. Null: nothing looks like a site. */
export function siteOwns(entry: RepoRegistryEntry): { globs: string[]; newFiles: string[] } | null {
  const sha = resolveBaseSha(entry, entry.defaultBaseRef);
  const top = git(entry.canonicalPath, ["ls-tree", "-z", sha]).stdout.split("\0").filter(Boolean)
    .map((row) => { const m = /^\d+ (blob|tree|commit) [0-9a-f]+\t(.+)$/.exec(row); return m ? { kind: m[1], name: m[2] } : null; })
    .filter((x): x is { kind: string; name: string } => !!x);
  const globs = [
    ...top.filter((t) => t.kind === "tree" && SITE_DIRS.includes(t.name)).map((t) => `${t.name}/**`),
    ...top.filter((t) => t.kind === "blob" && SITE_FILE.test(t.name)).map((t) => t.name),
  ];
  return globs.length ? { globs, newFiles: [] } : null;
}

/** The owner's own brief words inside a site request ("Brief: calm and premium."), or "". */
function briefIn(request: string): string {
  const m = /\bBrief:\s*(.+?)\.\s+(?=Apply these skills|Claims only)/.exec(request.replace(/\s+/g, " "));
  return m ? m[1].trim().slice(0, 300) : "";
}

const CHECK_ORDER: Array<"typecheck" | "build" | "lint"> = ["typecheck", "build", "lint"];

export function siteDraftPlan(entry: RepoRegistryEntry, request: string): PlannerDraft | null {
  const owns = siteOwns(entry);
  if (!owns) return null;
  const skills = skillsInRequest(request);
  const checkCommands = CHECK_ORDER.flatMap((kind) => entry.commands.filter((c) => c.kind === kind).slice(0, 1));
  const checks = checkCommands.map((c) => c.id) as CommandId[];
  const objective = siteObjective(request);
  const motion = skills.some((id) => SITE_SKILLS.find((s) => s.id === id)?.group === "motion");
  const brief = briefIn(request);
  const doneWhen: DoneCriterion[] = [
    ...checkCommands.map((c, i) => ({
      id: `c${i + 1}`,
      text: `${c.id} passes at the integrated commit`,
      evidence: (c.kind === "build" ? "build" : "typecheck") as DoneCriterion["evidence"],
      ref: c.id,
    })),
    { id: `c${checks.length + 1}`, text: objective, evidence: "reviewer-confirms" },
    { id: `c${checks.length + 2}`, text: "Every claim on the site is backed by public evidence or is a marked placeholder: no invented staff, reviews, awards, prices or hours", evidence: "reviewer-confirms" },
    { id: `c${checks.length + 3}`, text: `The pages hold up at 1440 px and 390 px wide${motion ? ", and every animation has a reduced-motion fallback" : ""}`, evidence: "reviewer-confirms" },
  ];
  const instructions = redactText([
    brief ? `The owner's brief: ${brief}.` : "",
    siteBrief(skills),
    "Existing images in the repo may be unrelated or unsafe (a medical photo, another city's streets): look at an image before you reuse it, and prefer a marked placeholder to a wrong photo.",
  ].filter(Boolean).join("\n"), 3000);
  return {
    objective,
    nonGoals: ["No changes outside the owned files", "No dependency changes", "No paid image or video generation", "Nothing goes live and no DNS changes"],
    doneWhen,
    builders: [{ owns, instructions }],
    checks,
  };
}
