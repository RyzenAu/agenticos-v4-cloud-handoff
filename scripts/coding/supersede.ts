// "Superseded": a paused job whose work already landed another way (a successor job, a hand fix) and must never be
// resumed or applied. The marking is a recorded, human-only action (POST /coding/jobs/:id/supersede). This file holds
// the pure rules and the read-only hint the page uses to prefill the reason.
import { git } from "./worktree";
import { redactText } from "./redact";
import type { CodingJob, RepoRegistryEntry } from "./contracts";

/** States a job can be marked superseded from: it is paused, or waiting on a merge nobody should now approve. */
export const SUPERSEDABLE_STATES = ["needs_owner", "blocked_allowance", "interrupted", "awaiting_approval"] as const;

/** A commit, branch or tag the newer work lives on. Plain ref characters only; never an option or a path. */
export const SUPERSEDE_REF = /^[A-Za-z0-9._/-]{1,100}$/;

export type SupersedeRefusal = string | null;

/** Plain reason a job can't be marked superseded now, or null when it can. */
export function supersedeRefusal(job: CodingJob, running: boolean): SupersedeRefusal {
  if (job.supersededBy) return `It is already marked superseded by ${job.supersededBy.ref}.`;
  if (running) return "That job is running right now. Stop or pause it first.";
  if (!(SUPERSEDABLE_STATES as readonly string[]).includes(job.state))
    return job.state === "completed" ? "A finished job is not paused. Leave it, or decline the merge." : `A ${job.state.replace("_", " ")} job can't be marked superseded; only a paused job can.`;
  return null;
}

/** Why Resume or Apply is refused on a superseded job, in the owner's words. */
export function supersededWords(job: CodingJob, verb: "resume" | "apply"): string {
  const s = job.supersededBy!;
  return `This job was marked superseded by ${s.ref} (${s.reason}). ${verb === "resume" ? "Resuming" : "Applying"} it could overwrite newer work, so it is closed. Start a new job if something is still missing.`;
}

export type SupersedeHint = { ref: string; reason: string; commits: number; basis: "files" | "folders" };

/** Does this ref name a commit in the repo? (A typo must not close a job for good.) */
export function refResolves(repoPath: string, ref: string): boolean {
  if (!SUPERSEDE_REF.test(ref) || ref.startsWith("-") || ref.includes("..")) return false;
  return git(repoPath, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{commit}"], { allowFail: true }).ok;
}

const cache = new Map<string, { at: number; hint: SupersedeHint | null }>();
const CACHE_MS = 60_000;

/** Files the job changed (exact), else the fixed prefix of each folder it owns (a weaker basis, worded that way). */
export function objectivePaths(job: CodingJob): { paths: string[]; basis: "files" | "folders" } {
  const keep = (list: Iterable<string>) => [...new Set(list)].filter((p) => p && !p.startsWith("-") && !p.startsWith("/") && !p.includes("..")).slice(0, 40);
  const changed = keep((job.diff?.files ?? []).map((f) => f.path));
  if (changed.length) return { paths: changed, basis: "files" };
  const owned: string[] = [];
  for (const r of job.spec.roles) {
    owned.push(...r.owns.newFiles);
    for (const g of r.owns.globs) owned.push(g.split(/[*?[{]/)[0].replace(/\/+$/, ""));
  }
  return { paths: keep(owned), basis: "folders" };
}

/**
 * A pointer, never a verdict: newer commits on the base branch touch the same files (or the folders this job owns).
 * Read-only git; null when nothing newer touches them or git can't say. Cached 60 s, expired entries pruned.
 */
export function supersedeHint(job: CodingJob, entry: RepoRegistryEntry | null, now = Date.now()): SupersedeHint | null {
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  if (!entry || job.supersededBy || !(SUPERSEDABLE_STATES as readonly string[]).includes(job.state)) return null;
  const key = job.id + "|" + (job.diff?.files.length ?? 0);
  const hit = cache.get(key);
  if (hit) return hit.hint;
  let hint: SupersedeHint | null = null;
  try {
    const { paths, basis } = objectivePaths(job);
    const base = job.spec.repo.baseSha;
    const tip = job.spec.repo.baseRef;
    if (paths.length && /^[0-9a-f]{7,40}$/i.test(base) && SUPERSEDE_REF.test(tip) && !tip.startsWith("-") && !tip.includes("..")) {
      const log = git(entry.canonicalPath, ["log", "--format=%h%x09%s", base + ".." + "refs/heads/" + tip, "--", ...paths.map((p) => ":(literal)" + p)], { allowFail: true });
      const lines = log.ok ? log.stdout.split(/\r?\n/).filter(Boolean) : [];
      if (lines.length) {
        const [sha, ...subject] = lines[0].split("\t");
        const n = lines.length;
        const where = basis === "files" ? "the same files" : "the folders this job owns";
        hint = { ref: sha, commits: n, basis, reason: redactText(n + " newer commit" + (n === 1 ? "" : "s") + " on " + tip + " touch " + where + "; the latest is \"" + subject.join(" ").slice(0, 120) + "\". Check before marking", 300) };
      }
    }
  } catch { hint = null; }
  cache.set(key, { at: now, hint });
  return hint;
}
