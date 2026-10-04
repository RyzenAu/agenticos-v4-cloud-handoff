#!/usr/bin/env bun
/**
 * Agent "done" gate — a read-only sanity check to run before calling a build task finished.
 *
 * Usage:
 *   bun scripts/agent-done-gate.ts <repo-path> [<repo-path> ...] [--test "<command>"]
 *
 * For each repo path given, prints:
 *   - the current branch (or "(detached or unknown)" if HEAD isn't on a named branch)
 *   - whether the working tree is clean
 *   - uncommitted files, split into tracked-modified (git already knows about the file; it has
 *     local edits) and untracked (a new file git has never seen)
 *   - how many commits on this branch haven't been pushed to its upstream, or "no upstream set" if
 *     the branch isn't tracking one at all
 *   - with --test "<command>", runs that command in the repo (via the shell) and reports
 *     pass/fail from its exit code
 *
 * Exit code is non-zero if ANY repo:
 *   - isn't a git repository / doesn't exist,
 *   - has uncommitted changes (tracked-modified or untracked), or
 *   - was given --test and that command's exit code was non-zero.
 * An unpushed-commit count alone does NOT fail the gate — a repo can be clean and fully committed
 * but simply not pushed yet; that's informational, not a "not done" signal on its own.
 *
 * Every git call here is read-only: status, rev-parse, rev-list — never fetch, pull, commit,
 * checkout, reset, stash, clean, or anything else that changes a repo. This script never modifies
 * any repo it's pointed at (the optional --test command is the caller's own choice, not this
 * script reaching into the tree).
 *
 * Examples:
 *   bun scripts/agent-done-gate.ts .
 *   bun scripts/agent-done-gate.ts . ../other-repo --test "bun test scripts"
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type RepoReport = {
  repo: string;
  ok: boolean; // resolvable as a git repository at all
  error?: string;
  branch: string;
  clean: boolean;
  trackedModified: string[];
  untracked: string[];
  /** Set once a branch is confirmed to have an upstream; null otherwise. */
  upstream: string | null;
  /** null when there's no upstream to compare against, or the comparison itself failed. */
  unpushedCount: number | null;
  test?: { command: string; passed: boolean; exitCode: number | null; output: string };
};

// Raw, untrimmed stdout: `git status --porcelain=v1`'s status codes start with a significant
// leading space (" M file.txt"), which a whole-string .trim() would eat off the first line only —
// callers trim() themselves where a single-line, no-leading-space value is expected (branch name,
// upstream ref, a count).
function runGit(repo: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim() };
}

function empty(repo: string, error: string): RepoReport {
  return { repo, ok: false, error, branch: "", clean: false, trackedModified: [], untracked: [], upstream: null, unpushedCount: null };
}

/** Inspects one repo. Read-only: no git call here can change the repo's state. `testCommand`, if
 *  given, is the one exception — it runs whatever the caller asked for, in that repo's directory. */
export function inspectRepo(repoPath: string, testCommand?: string): RepoReport {
  const absolute = resolve(repoPath);
  if (!existsSync(absolute)) return empty(repoPath, `no such path: ${absolute}`);

  const insideWorkTree = runGit(absolute, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== "true") return empty(repoPath, `not a git repository: ${absolute}`);

  const branchResult = runGit(absolute, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.ok && branchResult.stdout.trim() ? branchResult.stdout.trim() : "(detached or unknown)";

  const status = runGit(absolute, ["status", "--porcelain=v1"]);
  const trackedModified: string[] = [];
  const untracked: string[] = [];
  for (const rawLine of status.stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const code = rawLine.slice(0, 2);
    const path = rawLine.slice(3);
    if (code === "??") untracked.push(path);
    else trackedModified.push(path);
  }
  const clean = trackedModified.length === 0 && untracked.length === 0;

  let upstream: string | null = null;
  let unpushedCount: number | null = null;
  const upstreamResult = runGit(absolute, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstreamResult.ok && upstreamResult.stdout.trim()) {
    upstream = upstreamResult.stdout.trim();
    const countResult = runGit(absolute, ["rev-list", "--count", `${upstream}..HEAD`]);
    const count = countResult.stdout.trim();
    if (countResult.ok && /^\d+$/.test(count)) unpushedCount = Number(count);
  }

  const report: RepoReport = { repo: repoPath, ok: true, branch, clean, trackedModified, untracked, upstream, unpushedCount };
  if (testCommand) {
    const testResult = spawnSync(testCommand, { cwd: absolute, encoding: "utf8", shell: true });
    report.test = {
      command: testCommand,
      passed: testResult.status === 0,
      exitCode: testResult.status,
      output: `${testResult.stdout ?? ""}${testResult.stderr ?? ""}`.trim(),
    };
  }
  return report;
}

export function unpushedLine(report: RepoReport): string {
  if (report.unpushedCount !== null) return `${report.unpushedCount} commit(s) ahead of ${report.upstream}`;
  if (report.upstream) return `could not compare against upstream (${report.upstream})`;
  return "no upstream set";
}

export function formatReport(report: RepoReport): string {
  const lines: string[] = [`## ${report.repo}`];
  if (!report.ok) {
    lines.push(`  ERROR: ${report.error}`);
    return lines.join("\n");
  }
  lines.push(`  branch: ${report.branch}`);
  lines.push(`  clean: ${report.clean ? "yes" : "no"}`);
  if (report.trackedModified.length) lines.push(`  tracked-modified (${report.trackedModified.length}): ${report.trackedModified.join(", ")}`);
  if (report.untracked.length) lines.push(`  untracked (${report.untracked.length}): ${report.untracked.join(", ")}`);
  lines.push(`  unpushed: ${unpushedLine(report)}`);
  if (report.test) {
    lines.push(`  test (${report.test.command}): ${report.test.passed ? "PASS" : `FAIL (exit ${report.test.exitCode ?? "?"})`}`);
    if (!report.test.passed && report.test.output) lines.push(`    ${report.test.output.split("\n").slice(-20).join("\n    ")}`);
  }
  return lines.join("\n");
}

/** True (gate fails) if any repo isn't a usable git repo, has uncommitted changes, or (when
 *  --test was given) failed its test command. Unpushed commits alone never fail the gate. */
export function gateFails(reports: RepoReport[]): boolean {
  return reports.some((r) => !r.ok || !r.clean || (r.test ? !r.test.passed : false));
}

function main(): void {
  const args = process.argv.slice(2);
  let testCommand: string | undefined;
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--test") {
      testCommand = args[++i];
      continue;
    }
    repos.push(args[i]);
  }
  if (repos.length === 0) {
    console.error('Usage: bun scripts/agent-done-gate.ts <repo-path> [<repo-path> ...] [--test "<command>"]');
    process.exitCode = 2;
    return;
  }
  const reports = repos.map((r) => inspectRepo(r, testCommand));
  for (const report of reports) console.log(`${formatReport(report)}\n`);
  const failed = gateFails(reports);
  console.log(failed ? "GATE: FAILED — see above (dirty tree, missing repo, or failing test)." : "GATE: clean.");
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) main();
