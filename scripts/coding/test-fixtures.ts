import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitSha, RepoRegistryEntry, RepoId } from "./contracts";
import { linksInside } from "./worktree";

/** Synthetic git repos for the coding tests. Nothing here touches a real checkout. */

export function tempRoot(prefix = "coding-"): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** Remove a temp tree WITHOUT following links: every symlink/junction is unlinked first. */
export function cleanup(root: string) {
  try {
    for (const link of linksInside(root)) unlinkSync(link);
  } catch { /* already gone */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
}

const IDENTITY = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };

export function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY }, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/**
 * A check script in bun's output format. `fails.txt` lists failing test NAMES, one per line: the three
 * standard tests (alpha, beta, gamma) fail when named, and any other name is an extra failing test.
 */
const CHECK_SCRIPT = `import { readFileSync } from "node:fs";
const names = readFileSync("fails.txt", "utf8").split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
const standard = ["alpha", "beta", "gamma"];
for (const t of standard) console.log(names.includes(t) ? \`(fail) \${t} [1.00ms]\` : \`(pass) \${t} [1.00ms]\`);
for (const n of names.filter((n) => !standard.includes(n))) console.log(\`(fail) \${n} [1.00ms]\`);
console.log(\` \${standard.filter((t) => !names.includes(t)).length} pass\`);
console.log(\` \${names.length} fail\`);
process.exit(names.length ? 1 : 0);
`;

export type FixtureRepo = { root: string; canonical: string; entry: RepoRegistryEntry; baseSha: GitSha };

/**
 * A canonical checkout on `main` with one commit, an ignored node_modules, and (by default) DIRTY
 * work: an unstaged edit, a staged edit and an untracked file, as another agent would leave it.
 */
export function fixtureRepo(options: { dirty?: boolean } = {}): FixtureRepo {
  const root = tempRoot();
  const canonical = join(root, "canonical");
  mkdirSync(canonical);
  gitIn(canonical, "init", "-q", "-b", "main");
  gitIn(canonical, "config", "core.autocrlf", "false");
  write(canonical, ".gitignore", "node_modules\n");
  write(canonical, "src/a.ts", "export const a = 1;\n");
  write(canonical, "src/b.ts", "export const b = 2;\n");
  write(canonical, "lib/c.ts", "export const c = 3;\n");
  write(canonical, "docs/readme.md", "# Fixture\n");
  write(canonical, "checks.ts", CHECK_SCRIPT);
  write(canonical, "fails.txt", "");
  gitIn(canonical, "add", "-A");
  gitIn(canonical, "commit", "-q", "-m", "base");
  write(canonical, "node_modules/pkg/index.js", "module.exports = 1;\n");
  if (options.dirty !== false) {
    write(canonical, "docs/readme.md", "# Fixture\nunsaved notes from another agent\n");
    write(canonical, "src/b.ts", "export const b = 22;\n");
    gitIn(canonical, "add", "src/b.ts");
    write(canonical, "scratch.txt", "untracked work in progress\n");
  }
  const baseSha = gitIn(canonical, "rev-parse", "HEAD").trim() as GitSha;
  const entry: RepoRegistryEntry = {
    id: "fixture" as RepoId,
    description: "synthetic fixture repo",
    canonicalPath: canonical,
    defaultBaseRef: "main",
    worktreeParent: join(root, "wt"),
    protectedBranches: ["main", "master", "production"],
    remotes: [],
    commands: [{ id: "fx.test" as any, kind: "test", argv: [process.execPath, "checks.ts"], cwd: ".", timeoutMs: 60_000, counts: "bun" }],
    nodeModules: "junction",
    allowedPeople: ["usman" as any, "mehroz" as any],
  };
  mkdirSync(entry.worktreeParent);
  return { root, canonical, entry, baseSha };
}

/** Commit as a builder would, in its own worktree, adding exact paths only. */
export function commitIn(worktree: string, files: Record<string, string>, message = "builder change"): GitSha {
  for (const [path, text] of Object.entries(files)) write(worktree, path, text);
  gitIn(worktree, "add", "--", ...Object.keys(files));
  gitIn(worktree, "commit", "-q", "-m", message);
  return gitIn(worktree, "rev-parse", "HEAD").trim() as GitSha;
}
