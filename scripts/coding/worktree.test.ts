import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, commitIn, fixtureRepo, gitIn, write, type FixtureRepo } from "./test-fixtures";
import {
  canonicalSnapshot,
  createDetachedWorktree,
  createRoleWorktree,
  git,
  gitConfigFingerprint,
  integrate,
  UnsafeGitConfig,
  unsafeGitConfig,
  assertSafeGitConfig,
  jobBranchName,
  listCodingWorktrees,
  removeWorktree,
  resolveBaseSha,
  roleBranchName,
  sameSnapshot,
} from "./worktree";

// Real git in temp repos: slower than a unit test, so a loaded machine mustn't time these out.
setDefaultTimeout(60_000);
const repos: FixtureRepo[] = [];
afterEach(() => { for (const r of repos.splice(0)) cleanup(r.root); });
const repo = (dirty = true) => { const r = fixtureRepo({ dirty }); repos.push(r); return r; };

describe("coding worktrees", () => {
  test("create → build → integrate → keep leaves the dirty canonical checkout byte-identical", () => {
    const r = repo();
    const before = canonicalSnapshot(r.canonical);
    const dirtyBefore = readFileSync(join(r.canonical, "docs/readme.md"), "utf8");
    expect(before.status.length).toBeGreaterThan(0); // really dirty: staged, unstaged and untracked

    const base = resolveBaseSha(r.entry);
    expect(base).toBe(r.baseSha);
    const job = jobBranchName("fix-calls", "a1b2c3");
    const b1 = createRoleWorktree({ entry: r.entry, jobBranch: job, id6: "a1b2c3", roleId: "builder-1", baseSha: base });
    const b2 = createRoleWorktree({ entry: r.entry, jobBranch: job, id6: "a1b2c3", roleId: "builder-2", baseSha: base });
    // The canonical's uncommitted edits are NOT in the worktree: it starts at the base commit.
    expect(readFileSync(join(b1.path, "docs/readme.md"), "utf8")).toBe("# Fixture\n");
    expect(existsSync(join(b1.path, "scratch.txt"))).toBe(false);
    commitIn(b1.path, { "src/a.ts": "export const a = 10;\n" });
    commitIn(b2.path, { "lib/c.ts": "export const c = 30;\n" });

    const merged = integrate({ entry: r.entry, jobBranch: job, id6: "a1b2c3", baseSha: base, roleBranches: [b1.branch!, b2.branch!] });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(gitIn(merged.path, "show", `${merged.sha}:src/a.ts`)).toBe("export const a = 10;\n");
    expect(gitIn(merged.path, "show", `${merged.sha}:lib/c.ts`)).toBe("export const c = 30;\n");
    const reviewer = createDetachedWorktree({ entry: r.entry, id6: "a1b2c3", name: "reviewer", sha: merged.sha });
    expect(gitIn(reviewer.path, "rev-parse", "HEAD").trim()).toBe(merged.sha);

    // Kept: every worktree still exists and is listed.
    expect(listCodingWorktrees(r.entry).map((w) => w.path.replace(/\\/g, "/").split("/").pop()).sort())
      .toEqual(["coding-a1b2c3-builder-1", "coding-a1b2c3-builder-2", "coding-a1b2c3-job", "coding-a1b2c3-reviewer"]);
    const after = canonicalSnapshot(r.canonical);
    expect(sameSnapshot(before, after)).toBe(true);
    expect(after.status.equals(before.status)).toBe(true);
    expect(readFileSync(join(r.canonical, "docs/readme.md"), "utf8")).toBe(dirtyBefore);
    expect(gitIn(r.canonical, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  test("role branches are siblings of the job branch, so git can hold both", () => {
    expect(roleBranchName(jobBranchName("x", "abcdef"), "builder-1")).toBe("coding/x-abcdef-builder-1");
    expect(() => jobBranchName("Bad Slug", "abcdef")).toThrow();
    expect(() => roleBranchName("coding/x-abcdef", "../main")).toThrow();
  });

  test("node_modules is a junction to the canonical checkout's, not a copy", () => {
    const r = repo();
    const w = createRoleWorktree({ entry: r.entry, jobBranch: jobBranchName("nm", "0000aa"), id6: "0000aa", roleId: "builder-1", baseSha: r.baseSha });
    expect(w.nodeModules).not.toBeNull();
    expect(lstatSync(join(w.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(w.path, "node_modules/pkg/index.js"), "utf8")).toBe("module.exports = 1;\n");
    // Ignored, so the worktree is still clean.
    expect(gitIn(w.path, "status", "--porcelain")).toBe("");
  });

  test("a conflict is aborted and reported, never resolved automatically", () => {
    const r = repo();
    const job = jobBranchName("clash", "0000bb");
    const b1 = createRoleWorktree({ entry: r.entry, jobBranch: job, id6: "0000bb", roleId: "builder-1", baseSha: r.baseSha });
    const b2 = createRoleWorktree({ entry: r.entry, jobBranch: job, id6: "0000bb", roleId: "builder-2", baseSha: r.baseSha });
    commitIn(b1.path, { "src/a.ts": "export const a = 'one';\n" });
    commitIn(b2.path, { "src/a.ts": "export const a = 'two';\n" });
    const result = integrate({ entry: r.entry, jobBranch: job, id6: "0000bb", baseSha: r.baseSha, roleBranches: [b1.branch!, b2.branch!] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflictWith).toBe(b2.branch!);
    expect(result.conflicts).toEqual(["src/a.ts"]);
    expect(gitIn(result.path, "status", "--porcelain")).toBe("");
  });

  test("integration refuses branches that aren't this job's", () => {
    const r = repo();
    expect(() => integrate({ entry: r.entry, jobBranch: jobBranchName("j", "0000cc"), id6: "0000cc", baseSha: r.baseSha, roleBranches: ["main"] })).toThrow("this job's role branches");
  });

  test("cleanup unlinks the node_modules junction without following it; the target survives", () => {
    const r = repo();
    const w = createRoleWorktree({ entry: r.entry, jobBranch: jobBranchName("clean", "0000dd"), id6: "0000dd", roleId: "builder-1", baseSha: r.baseSha });
    const target = join(r.canonical, "node_modules");
    const before = canonicalSnapshot(r.canonical);
    const result = removeWorktree(r.entry, w.path);
    expect(result).toMatchObject({ removed: true });
    expect(existsSync(w.path)).toBe(false);
    // The junction target and its contents are untouched.
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(join(target, "pkg/index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(sameSnapshot(before, canonicalSnapshot(r.canonical))).toBe(true);
  });

  test("a dirty worktree is kept (no --force), with its junction restored", () => {
    const r = repo();
    const w = createRoleWorktree({ entry: r.entry, jobBranch: jobBranchName("dirty", "0000ee"), id6: "0000ee", roleId: "builder-1", baseSha: r.baseSha });
    write(w.path, "src/a.ts", "uncommitted\n");
    const result = removeWorktree(r.entry, w.path);
    expect(result.removed).toBe(false);
    expect(existsSync(join(w.path, "src/a.ts"))).toBe(true);
    expect(lstatSync(join(w.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(r.canonical, "node_modules/pkg/index.js"))).toBe(true);
  });

  test("any other link inside a worktree refuses the removal, and nothing is followed", () => {
    const r = repo();
    const w = createRoleWorktree({ entry: r.entry, jobBranch: jobBranchName("link", "0000ff"), id6: "0000ff", roleId: "builder-1", baseSha: r.baseSha });
    const outside = join(r.root, "precious");
    write(r.root, "precious/keep.txt", "keep me\n");
    symlinkSync(outside, join(w.path, "src", "sneaky"), "junction");
    const result = removeWorktree(r.entry, w.path);
    expect(result.removed).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(r.canonical, "node_modules/pkg/index.js"))).toBe(true);
  });

  test("only registered coding worktrees under the registry parent can be removed", () => {
    const r = repo();
    expect(removeWorktree(r.entry, r.canonical)).toMatchObject({ removed: false });
    expect(removeWorktree(r.entry, join(r.entry.worktreeParent, "coding-123456-nope"))).toMatchObject({ removed: false });
    expect(existsSync(r.canonical)).toBe(true);
  });

  test("review M1 repro: core.fsmonitor set from an agent's worktree never runs for harness git, and the repo is refused", () => {
    const r = repo();
    const w = createRoleWorktree({ entry: r.entry, jobBranch: jobBranchName("fsmon", "0000a1"), id6: "0000a1", roleId: "builder-1", baseSha: r.baseSha });
    const marker = join(r.root, "fsmonitor-ran.txt");
    // The agent writes the SHARED config from its own worktree (git runs this value through a shell).
    gitIn(w.path, "config", "core.fsmonitor", `echo ran > "${marker.replace(/\\/g, "/")}"`);
    expect(unsafeGitConfig(r.canonical)).toEqual(["core.fsmonitor"]);
    // Control: plain git (as the owner's own `git status` would) DOES run it, so the attack is real.
    gitIn(r.canonical, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // Harness git forces fsmonitor off on the command line, so nothing runs even before refusal.
    git(r.canonical, ["status", "--porcelain"]);
    expect(existsSync(marker)).toBe(false);
    expect(() => canonicalSnapshot(r.canonical)).toThrow(UnsafeGitConfig);
    expect(() => createRoleWorktree({ entry: r.entry, jobBranch: jobBranchName("fsmon", "0000a2"), id6: "0000a2", roleId: "builder-1", baseSha: r.baseSha })).toThrow(UnsafeGitConfig);
    expect(removeWorktree(r.entry, w.path)).toMatchObject({ removed: false });
    expect(existsSync(marker)).toBe(false);
  });

  test("filter/merge drivers, aliases, includes and hooks paths are refused; git-lfs's own filter is allowed", () => {
    const r = repo();
    const fingerprint = gitConfigFingerprint(r.canonical);
    for (const [key, value] of [["filter.x.smudge", "evil"], ["merge.x.driver", "evil"], ["alias.st", "!evil"], ["include.path", "../x"], ["core.hooksPath", "hooks"], ["diff.x.textconv", "evil"], ["core.sshCommand", "evil"]]) {
      gitIn(r.canonical, "config", key, value);
      expect(unsafeGitConfig(r.canonical)).toEqual([key.toLowerCase()]);
      expect(gitConfigFingerprint(r.canonical)).not.toBe(fingerprint);
      gitIn(r.canonical, "config", "--unset", key);
    }
    gitIn(r.canonical, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    expect(unsafeGitConfig(r.canonical)).toEqual([]);
  });

  test("review R2: the global config is checked too, for what the command-line overrides can't neutralise", () => {
    const r = repo();
    const globalFile = join(r.root, "global.gitconfig");
    // A normal global config: git-lfs's filter, a credential helper, an editor. None is refused.
    writeFileSync(globalFile, "[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n[credential]\n\thelper = manager\n[core]\n\teditor = code --wait\n");
    expect(unsafeGitConfig(r.canonical, { globalFile })).toEqual([]);
    // An agent's `git config --global filter.x.smudge …` or an include is refused.
    writeFileSync(globalFile, "[filter \"x\"]\n\tsmudge = evil\n[include]\n\tpath = ~/evil.gitconfig\n");
    expect(unsafeGitConfig(r.canonical, { globalFile })).toEqual(["filter.x.smudge", "include.path"]);
    expect(() => assertSafeGitConfig(r.canonical, { globalFile })).toThrow(UnsafeGitConfig);
  });

  test("a further edit to an already-dirty file is caught by the snapshot, though git status looks the same", () => {
    const r = repo();
    const before = canonicalSnapshot(r.canonical);
    write(r.canonical, "docs/readme.md", "# Fixture\nunsaved notes from another agent, edited again\n");
    const after = canonicalSnapshot(r.canonical);
    expect(after.status.equals(before.status)).toBe(true);
    expect(sameSnapshot(before, after)).toBe(false);
  });

  test("a node_modules link re-pointed away from the canonical node_modules is flagged, not removed", () => {
    const r = repo();
    const w = createRoleWorktree({ entry: r.entry, jobBranch: jobBranchName("repoint", "0000a3"), id6: "0000a3", roleId: "builder-1", baseSha: r.baseSha });
    const link = join(w.path, "node_modules");
    unlinkSync(link);
    symlinkSync(r.canonical, link, "junction");
    const result = removeWorktree(r.entry, w.path);
    expect(result).toMatchObject({ removed: false });
    expect((result as { reason: string }).reason).toContain("not the canonical node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(r.canonical, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  test("git errors name the subcommand and git's own reason", () => {
    const r = repo();
    try { git(r.canonical, ["rev-parse", "--verify", "no-such-ref"]); throw new Error("expected failure"); }
    catch (e) { expect((e as Error).message).toMatch(/^git rev-parse failed: fatal:/); }
  });

  test("worktree folders are never reused, and the base ref must resolve", () => {
    const r = repo();
    const job = jobBranchName("once", "000011");
    createRoleWorktree({ entry: r.entry, jobBranch: job, id6: "000011", roleId: "builder-1", baseSha: r.baseSha });
    expect(() => createRoleWorktree({ entry: r.entry, jobBranch: job, id6: "000011", roleId: "builder-1", baseSha: r.baseSha })).toThrow("already exists");
    expect(() => resolveBaseSha(r.entry, "no-such-branch")).toThrow("does not resolve");
    expect(() => resolveBaseSha(r.entry, "--output=x")).toThrow("Invalid base ref");
  });
});

describe("insidePath through a junction (Ryzen: source\repos is a junction to C:\mu-hub\repos)", () => {
  test("a not-yet-created worktree under a junctioned parent is inside it; a sibling outside is not", () => {
    const { mkdtempSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { insidePath } = require("./worktree") as typeof import("./worktree");
    const base = mkdtempSync(join(tmpdir(), "wt-junction-"));
    try {
      mkdirSync(join(base, "real", "_coding-worktrees", "app"), { recursive: true });
      mkdirSync(join(base, "elsewhere"), { recursive: true });
      symlinkSync(join(base, "real"), join(base, "repos"), "junction");
      const parent = join(base, "repos", "_coding-worktrees", "app");
      expect(insidePath(join(parent, "coding-abc123-builder"), parent)).toBe(true);
      expect(insidePath(join(base, "real", "_coding-worktrees", "app", "coding-abc123-builder"), parent)).toBe(true);
      expect(insidePath(join(base, "elsewhere", "coding-abc123-builder"), parent)).toBe(false);
      expect(insidePath(join(base, "repos", "_coding-worktrees", "app-evil", "x"), parent)).toBe(false);
    } finally {
      unlinkSync(join(base, "repos"));
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("worktrees behind a junctioned parent (Ryzen: the registry path goes through source\repos, git lists C:/mu-hub/repos)", () => {
  test("git lists the real path; only the real-path comparison finds the existing worktree, so a re-run reuses it", () => {
    const { insidePath, listWorktrees, createDetachedWorktree, worktreePathFor } = require("./worktree") as typeof import("./worktree");
    const { fixtureRepo, cleanup } = require("./test-fixtures") as typeof import("./test-fixtures");
    const r = fixtureRepo();
    const link = join(r.root, "wt-link");
    try {
      symlinkSync(r.entry.worktreeParent, link, "junction");
      const entry = { ...r.entry, worktreeParent: link };
      createDetachedWorktree({ entry, id6: "abc123", name: "tests-1234567", sha: r.baseSha });
      const path = worktreePathFor(entry, "abc123", "tests-1234567");
      const listed = listWorktrees(entry).map((w) => w.path);
      const naive = (a: string, b: string) => a.split("\\").join("/").toLowerCase() === b.split("\\").join("/").toLowerCase();
      expect(listed.some((p) => naive(p, path))).toBe(false); // the old comparison: "not there", so it tried to create it again
      expect(listed.some((p) => insidePath(p, path) && insidePath(path, p))).toBe(true);
    } finally {
      try { unlinkSync(link); } catch { /* already gone */ }
      cleanup(r.root);
    }
  });
});
