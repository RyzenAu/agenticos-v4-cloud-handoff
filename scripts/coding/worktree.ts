import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GitSha, RepoRegistryEntry, RoleId } from "./contracts";

/**
 * Worktree manager (CODING-HARNESS §3.3). Orchestrator only; agents never run git worktree commands.
 *
 * The canonical checkout is READ-ONLY to the harness: the only commands run there are `rev-parse`,
 * `worktree add/list/remove` (which write under .git/worktrees and create the job's own branch refs)
 * and `status` for evidence. Never stash, reset, checkout, clean, merge or commit in it, so its dirty
 * work is untouched. Worktrees are kept after a job; removal is owner-triggered and never recurses
 * through a junction (node_modules is unlinked first and its target is checked afterwards).
 */

export type GitResult = { ok: boolean; status: number | null; stdout: string; stderr: string };
export class GitError extends Error {
  constructor(readonly args: readonly string[], readonly result: GitResult) {
    // Name the subcommand (not a `-c` flag) and git's own `fatal:`/`error:` line.
    const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";
    const lines = result.stderr.split(/\r?\n/).filter(Boolean);
    const reason = lines.find((l) => /^(?:fatal|error):/.test(l)) ?? lines[0] ?? `exit ${result.status}`;
    super(`git ${sub} failed: ${reason}`);
  }
}

/** Git reads its own config and identity; variables that would redirect it to another repo don't pass. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|CONFIG.*|EXTERNAL_DIFF|DIFF_OPTS|SSH.*|ASKPASS|EDITOR|PAGER|EXEC_PATH|TRACE.*)$/i.test(name))
      delete env[name];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0"; // status never rewrites the index
  // System and global config still apply (EOL conversion must match the owner's and the agent's git);
  // their exec-capable keys are forced off below or refused by unsafeGitConfig.
  return env;
}

/**
 * Worktrees share the canonical `.git` common dir, so an agent that runs `git config` in its worktree
 * writes config the orchestrator's git would obey (review M1: core.fsmonitor ran a program on the
 * orchestrator's `git status`). Every harness git call forces the exec-capable settings off on the
 * command line, which wins over any config file; `assertSafeGitConfig` refuses the rest (filter and
 * merge drivers, includes, aliases …) because those can't be overridden generically.
 */
const NO_HOOKS = join(tmpdir(), "agentic-os-coding-no-hooks-dir-does-not-exist");
export const SAFE_GIT_CONFIG: readonly string[] = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", `core.hooksPath=${NO_HOOKS}`,
  "-c", "core.sshCommand=",
  "-c", "core.askPass=",
  "-c", "core.pager=",
  "-c", "core.editor=",
  "-c", "sequence.editor=",
  "-c", "diff.external=",
  "-c", "credential.helper=",
  "-c", "gpg.program=",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "protocol.allow=never",
];

/** Spawn git with an argv array, never a shell (paths contain spaces; Git Bash would rewrite `/` args). */
export function git(cwd: string, args: readonly string[], options: { allowFail?: boolean } = {}): GitResult {
  const r = spawnSync("git", [...SAFE_GIT_CONFIG, ...args], { cwd, env: gitEnv(), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const result = { ok: r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() };
  if (!result.ok && !options.allowFail) throw new GitError(args, result);
  return result;
}

/** Raw bytes, for the byte-identical `git status` evidence. */
export function gitBytes(cwd: string, args: readonly string[]): Buffer {
  const r = spawnSync("git", [...SAFE_GIT_CONFIG, ...args], { cwd, env: gitEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new GitError(args, { ok: false, status: r.status, stdout: "", stderr: String(r.stderr ?? "") });
  return r.stdout as Buffer;
}

/** Config keys that make git run a program, redirect it, or pull in another file. */
const UNSAFE_CONFIG = [
  /^core\.(?:fsmonitor|hookspath|sshcommand|askpass|editor|pager|gitproxy|worktree|alternaterefscommand|attributesfile|excludesfile)$/,
  /^(?:sequence\.editor|diff\.external|gpg\.program|gpg\.[^.]+\.program|web\.browser|credential\.helper|credential\..+\.helper)$/,
  /^diff\..+\.(?:command|textconv)$/, /^filter\..+\.(?:clean|smudge|process)$/, /^merge\..+\.driver$/,
  /^(?:alias|pager|difftool|mergetool|browser|instaweb|sendemail)\./,
  /^include\.path$/, /^includeif\..+\.path$/,
  /^remote\..+\.(?:uploadpack|receivepack|vcs|proxy)$/, /^uploadpack\.packobjectshook$/, /^http\..*(?:proxy|sslkey|sslcert|cookiefile)$/,
];
/** git-lfs installs its filter this way; allowed only with git-lfs's own commands. */
const ALLOWED_VALUE = (key: string, value: string) => /^filter\.lfs\.(?:clean|smudge|process)$/.test(key) && /^git-lfs (?:clean|smudge|filter-process)\b/.test(value);

/**
 * In the user's global (~/.gitconfig) and the system config, only what the SAFE_GIT_CONFIG overrides
 * can't neutralise counts: filter/merge drivers, includes and redirects. A global credential helper,
 * editor or pager is normal there and is already forced off for harness git. (Review R2 minor: an
 * agent can run `git config --global` too.)
 */
const NON_OVERRIDABLE = [
  /^filter\..+\.(?:clean|smudge|process)$/, /^merge\..+\.driver$/, /^include\.path$/, /^includeif\..+\.path$/,
  /^core\.(?:worktree|attributesfile)$/,
];

export type GitConfigScopes = { /** Tests only: read this file as the global config instead of ~/.gitconfig. */ globalFile?: string };

/** Exec-capable keys in the repo's config (common dir, per-worktree, global, system). Reading config runs nothing. */
export function unsafeGitConfig(repoPath: string, scopes: GitConfigScopes = {}): string[] {
  const found = new Set<string>();
  const sources: Array<[string[], RegExp[]]> = [
    [["--local"], UNSAFE_CONFIG],
    [["--worktree"], UNSAFE_CONFIG],
    [scopes.globalFile ? ["--file", scopes.globalFile] : ["--global"], NON_OVERRIDABLE],
    [["--system"], NON_OVERRIDABLE],
  ];
  for (const [scope, rules] of sources) {
    const r = git(repoPath, ["config", ...scope, "--list", "-z"], { allowFail: true });
    if (!r.ok) continue;
    for (const record of r.stdout.split("\0")) {
      if (!record) continue;
      const at = record.indexOf("\n");
      const key = (at < 0 ? record : record.slice(0, at)).toLowerCase();
      const value = at < 0 ? "" : record.slice(at + 1);
      if (rules.some((re) => re.test(key)) && !ALLOWED_VALUE(key, value)) found.add(key);
    }
  }
  return [...found].sort();
}

export class UnsafeGitConfig extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`The repo's git config now runs programs or pulls in other files (${keys.join(", ")}). The harness won't run git there until the owner removes them.`);
  }
}
/** Refuse to operate on a repo whose shared config an agent (or anyone) made exec-capable. */
export function assertSafeGitConfig(repoPath: string, scopes: GitConfigScopes = {}) {
  const keys = unsafeGitConfig(repoPath, scopes);
  if (keys.length) throw new UnsafeGitConfig(keys);
}

/** sha256 of the repo's local + worktree config: a change during a job is evidence of tampering. */
export function gitConfigFingerprint(repoPath: string): string {
  const hash = createHash("sha256");
  for (const scope of ["--local", "--worktree", "--global"]) hash.update(git(repoPath, ["config", scope, "--list", "-z"], { allowFail: true }).stdout).update("\0\0");
  return hash.digest("hex");
}

/** Integration merge commits are the orchestrator's, not an agent's or the owner's. */
const ORCHESTRATOR_IDENTITY = ["-c", "user.name=AgenticOS Coding", "-c", "user.email=coding-orchestrator@agentic-os.invalid"];

const SHA = /^[0-9a-f]{40}$/;
export function asSha(value: string): GitSha {
  const v = value.trim();
  if (!SHA.test(v)) throw new Error("Expected a 40-hex commit id.");
  return v as GitSha;
}

/** `baseSha` for a job: resolved in the canonical checkout by `rev-parse` only. */
export function resolveBaseSha(entry: RepoRegistryEntry, baseRef: string = entry.defaultBaseRef): GitSha {
  if (!/^[A-Za-z0-9._/@^~-]{1,200}$/.test(baseRef) || baseRef.startsWith("-")) throw new Error("Invalid base ref.");
  const r = git(entry.canonicalPath, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { allowFail: true });
  if (!r.ok) throw new Error(`The base ref ${baseRef} does not resolve in ${entry.id}.`);
  return asSha(r.stdout);
}

// ─────────────────────────── names ───────────────────────────

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID6 = /^[0-9a-f]{6}$/;
const ROLE = /^[a-z][a-z0-9-]{0,23}$/;

/** `coding/<slug>-<id6>`. */
export function jobBranchName(slug: string, id6: string): string {
  if (!SLUG.test(slug) || !ID6.test(id6)) throw new Error("Invalid job slug or id.");
  return `coding/${slug}-${id6}`;
}
/** `coding/<slug>-<id6>-<roleId>`: a sibling, not a child, of the job branch (git can't hold both
 * `coding/x` and `coding/x/<role>` as refs). */
export function roleBranchName(jobBranch: string, roleId: RoleId | string): string {
  if (!ROLE.test(roleId)) throw new Error("Invalid role id.");
  return `${jobBranch}-${roleId}`;
}
export function worktreePathFor(entry: RepoRegistryEntry, id6: string, name: string): string {
  if (!ID6.test(id6) || !ROLE.test(name)) throw new Error("Invalid worktree name.");
  return join(entry.worktreeParent, `coding-${id6}-${name}`);
}

// ─────────────────────────── evidence ───────────────────────────

export type CanonicalSnapshot = { head: string; branch: string; status: Buffer; stashes: string; dirtyContent: string };

/** sha256 over the dirty files' names and bytes: a further edit to an already-dirty file changes it
 * even though `git status` looks the same (review minor). Bounded: large files hash size+mtime only. */
function dirtyContentHash(canonicalPath: string, status: Buffer): string {
  const hash = createHash("sha256");
  const records = status.toString("utf8").split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) i++; // the next record is the rename source
    hash.update(record).update("\0");
    const file = join(canonicalPath, path);
    try {
      const info = statSync(file);
      if (!info.isFile()) continue;
      if (info.size > 8 * 1024 * 1024) hash.update(`${info.size}:${info.mtimeMs}`);
      else hash.update(readFileSync(file));
    } catch { hash.update("missing"); }
  }
  return hash.digest("hex");
}

/** What must be byte-identical before and after a job touches this repo. Read-only: status runs with
 * optional locks off (no index refresh) and the exec-capable config forced off. */
export function canonicalSnapshot(canonicalPath: string): CanonicalSnapshot {
  assertSafeGitConfig(canonicalPath);
  const status = gitBytes(canonicalPath, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    head: git(canonicalPath, ["rev-parse", "HEAD"]).stdout.trim(),
    branch: git(canonicalPath, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }).stdout.trim(),
    status,
    stashes: git(canonicalPath, ["stash", "list"]).stdout,
    dirtyContent: dirtyContentHash(canonicalPath, status),
  };
}

export function sameSnapshot(a: CanonicalSnapshot, b: CanonicalSnapshot): boolean {
  return a.head === b.head && a.branch === b.branch && a.stashes === b.stashes && a.status.equals(b.status) && a.dirtyContent === b.dirtyContent;
}

/** Clean = no tracked changes and no untracked files. Uses the safe git config (not inspectRepo, whose
 * plain `git status` would obey an agent-set core.fsmonitor). */
export function worktreeState(path: string): { ok: boolean; dirty: number; error?: string } {
  const r = git(path, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFail: true });
  if (!r.ok) return { ok: false, dirty: 0, error: r.stderr.split(/\r?\n/)[0] || "not a git worktree" };
  return { ok: true, dirty: r.stdout.split("\0").filter(Boolean).length };
}

// ─────────────────────────── create ───────────────────────────

export type Worktree = { path: string; branch: string | null; sha: GitSha; nodeModules: { link: string; target: string } | null };

/** A junction to the canonical checkout's node_modules, when the registry allows it. Shared, so
 * installs in it are denied by the policy engine (C3). */
export function linkNodeModules(entry: RepoRegistryEntry, worktreePath: string): Worktree["nodeModules"] {
  if (entry.nodeModules !== "junction") return null;
  const target = join(entry.canonicalPath, "node_modules");
  if (!existsSync(target)) return null;
  const link = join(worktreePath, "node_modules");
  if (existsSync(link) || isLink(link)) throw new Error("node_modules already exists in the new worktree.");
  symlinkSync(target, link, "junction");
  return { link, target };
}

function assertNewPath(entry: RepoRegistryEntry, path: string) {
  if (existsSync(path)) throw new Error("That worktree folder already exists; it is kept, never reused.");
  if (!insidePath(path, entry.worktreeParent)) throw new Error("Worktrees are created only under the registry's worktree parent.");
}

/** A writing role's worktree on its own branch, from the base sha. */
export function createRoleWorktree(input: { entry: RepoRegistryEntry; jobBranch: string; id6: string; roleId: RoleId | string; baseSha: GitSha }): Worktree {
  const { entry } = input;
  const branch = roleBranchName(input.jobBranch, input.roleId);
  const path = worktreePathFor(entry, input.id6, input.roleId);
  assertNewPath(entry, path);
  assertSafeGitConfig(entry.canonicalPath);
  git(entry.canonicalPath, ["worktree", "add", "-b", branch, path, asSha(input.baseSha)]);
  return { path, branch, sha: asSha(input.baseSha), nodeModules: linkNodeModules(entry, path) };
}

/** A detached worktree at an exact sha: for the reviewer, the tester and the planner (read-only roles). */
export function createDetachedWorktree(input: { entry: RepoRegistryEntry; id6: string; name: string; sha: GitSha }): Worktree {
  const { entry } = input;
  const path = worktreePathFor(entry, input.id6, input.name);
  assertNewPath(entry, path);
  assertSafeGitConfig(entry.canonicalPath);
  git(entry.canonicalPath, ["worktree", "add", "--detach", path, asSha(input.sha)]);
  return { path, branch: null, sha: asSha(input.sha), nodeModules: linkNodeModules(entry, path) };
}

export type Integration =
  | { ok: true; path: string; branch: string; sha: GitSha; merged: string[] }
  | { ok: false; path: string; branch: string; conflictWith: string; conflicts: string[] };

/**
 * Merge each role branch into the job branch, in the job's own integration worktree (never the
 * canonical checkout). Ownership is disjoint, so a conflict is unexpected: it is aborted and reported
 * for the owner (job → needs_owner), never resolved automatically.
 */
export function integrate(input: { entry: RepoRegistryEntry; jobBranch: string; id6: string; baseSha: GitSha; roleBranches: readonly string[] }): Integration {
  const { entry } = input;
  const path = worktreePathFor(entry, input.id6, "job");
  assertSafeGitConfig(entry.canonicalPath);
  if (!existsSync(path)) {
    assertNewPath(entry, path);
    git(entry.canonicalPath, ["worktree", "add", "-b", input.jobBranch, path, asSha(input.baseSha)]);
    linkNodeModules(entry, path);
  }
  const merged: string[] = [];
  for (const branch of input.roleBranches) {
    if (!branch.startsWith(`${input.jobBranch}-`)) throw new Error("Only this job's role branches can be integrated.");
    const r = git(path, [...ORCHESTRATOR_IDENTITY, "merge", "--no-ff", "--no-edit", "--no-verify", "-m", `Integrate ${branch}`, branch], { allowFail: true });
    if (!r.ok) {
      const conflicts = git(path, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout.split("\n").filter(Boolean);
      git(path, ["merge", "--abort"], { allowFail: true });
      return { ok: false, path, branch: input.jobBranch, conflictWith: branch, conflicts };
    }
    merged.push(branch);
  }
  return { ok: true, path, branch: input.jobBranch, sha: asSha(git(path, ["rev-parse", "HEAD"]).stdout), merged };
}

// ─────────────────────────── list / remove ───────────────────────────

export type ListedWorktree = { path: string; head: string | null; branch: string | null; detached: boolean };

export function listWorktrees(entry: RepoRegistryEntry): ListedWorktree[] {
  const out: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of git(entry.canonicalPath, ["worktree", "list", "--porcelain"]).stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { current = { path: line.slice(9), head: null, branch: null, detached: false }; out.push(current); }
    else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.detached = true;
  }
  return out;
}

/** This harness's worktrees for a repo (under the registry parent, named coding-*). */
export function listCodingWorktrees(entry: RepoRegistryEntry): ListedWorktree[] {
  return listWorktrees(entry).filter((w) => insidePath(w.path, entry.worktreeParent) && /[\\/]coding-[0-9a-f]{6}-[a-z][a-z0-9-]*$/.test(w.path));
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

const fold = (value: string) => {
  let v = resolve(value);
  try { v = realpathSync.native(v); } catch { /* not created yet: compare as given */ }
  return v.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
};
export function insidePath(child: string, parent: string): boolean {
  const a = fold(child), b = fold(parent);
  return a === b || a.startsWith(b + "/");
}

/** Every symlink/junction below `root`, found with lstat only: nothing is ever followed. */
export function linksInside(root: string, skip: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (skip.has(full)) continue;
      if (item.isSymbolicLink() || isLink(full)) { found.push(full); continue; }
      if (item.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

export type Removal =
  | { removed: true; path: string; junctionTarget: string | null }
  | { removed: false; path: string; reason: string };

/**
 * Owner-triggered cleanup of one coding worktree. The node_modules junction is unlinked on its own
 * (the link, not its contents) and verified gone; any other link inside refuses the removal; git then
 * removes the worktree WITHOUT --force, so a dirty worktree is kept. The junction's target must still
 * exist afterwards, or this throws loudly.
 */
export function removeWorktree(entry: RepoRegistryEntry, path: string): Removal {
  const full = resolve(path);
  if (!insidePath(full, entry.worktreeParent) || insidePath(full, entry.canonicalPath))
    return { removed: false, path: full, reason: "not a coding worktree of this repo" };
  const listed = listCodingWorktrees(entry).find((w) => fold(w.path) === fold(full));
  if (!listed) return { removed: false, path: full, reason: "not a registered coding worktree" };
  const unsafe = unsafeGitConfig(entry.canonicalPath);
  if (unsafe.length) return { removed: false, path: full, reason: new UnsafeGitConfig(unsafe).message };

  const link = join(full, "node_modules");
  let target: string | null = null;
  if (isLink(link)) {
    target = readlinkSync(link);
    // Only the junction the harness made (to the canonical node_modules) is unlinked. A re-pointed link
    // (e.g. at the canonical root) is left alone and flagged for the owner (review minor B7).
    if (fold(target) !== fold(join(entry.canonicalPath, "node_modules")))
      return { removed: false, path: full, reason: `node_modules points at ${target}, not the canonical node_modules; inspect it by hand` };
    unlinkSync(link); // removes the junction itself; never recurses into its target
    if (isLink(link) || existsSync(link)) throw new Error("The node_modules junction could not be unlinked; nothing was removed.");
    if (!existsSync(target)) throw new Error(`Junction target ${target} is missing after unlinking the link. Stop and inspect.`);
  }
  const restore = (reason: string): Removal => {
    if (target && !isLink(link) && !existsSync(link)) symlinkSync(target, link, "junction");
    return { removed: false, path: full, reason };
  };
  const others = linksInside(full, new Set([join(full, ".git")]));
  if (others.length) return restore(`it contains ${others.length} other link(s); remove them by hand first`);

  const r = git(entry.canonicalPath, ["worktree", "remove", full], { allowFail: true });
  if (!r.ok) return restore(`git kept it: ${r.stderr.split("\n")[0] || "dirty or locked"}`);
  if (target && !existsSync(target)) throw new Error(`Junction target ${target} is missing after cleanup. Stop and inspect.`);
  return { removed: true, path: full, junctionTarget: target };
}
