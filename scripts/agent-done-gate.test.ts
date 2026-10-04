import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateFails, inspectRepo, unpushedLine } from "./agent-done-gate";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

// Every git call is a real process spawn, which costs ~0.3 s each on a loaded Windows machine
// (measured 28 Sep 2026 with parallel agents running). Build the one-commit template repo once
// and copy it per test, so each test only pays for the git calls it actually exercises.
let template = "";
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "agent-done-gate-template-"));
  git(template, "init -b main -q");
  git(template, 'config user.email "eval@example.com"');
  git(template, 'config user.name "Eval"');
  writeFileSync(join(template, "file.txt"), "hello\n");
  git(template, "add file.txt");
  git(template, 'commit -q -m "initial commit"');
}, 30_000);
afterAll(() => rmSync(template, { recursive: true, force: true }));

/** A throwaway repo with one commit on `main`, isolated from the real user's git config. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-done-gate-"));
  dirs.push(dir);
  cpSync(template, dir, { recursive: true });
  return dir;
}
// Per-test budget for the tests below, which still spawn git (inspectRepo runs several git
// commands per call, and the push test several more): the slowest measured 9 s under load
// with the old per-test fixture, times 3.
const GIT_TEST_TIMEOUT_MS = 30_000;

test("a fresh, single-commit repo with no upstream: clean, no unpushed count, gate passes", () => {
  const dir = freshRepo();
  const report = inspectRepo(dir);
  expect(report.ok).toBe(true);
  expect(report.branch).toBe("main");
  expect(report.clean).toBe(true);
  expect(report.trackedModified).toEqual([]);
  expect(report.untracked).toEqual([]);
  expect(report.upstream).toBeNull();
  expect(report.unpushedCount).toBeNull();
  expect(unpushedLine(report)).toBe("no upstream set");
  expect(gateFails([report])).toBe(false);
}, GIT_TEST_TIMEOUT_MS);

test("an untracked file and a modified tracked file are reported separately, and fail the gate", () => {
  const dir = freshRepo();
  writeFileSync(join(dir, "file.txt"), "hello, edited\n"); // tracked-modified
  writeFileSync(join(dir, "new.txt"), "brand new\n"); // untracked
  const report = inspectRepo(dir);
  expect(report.clean).toBe(false);
  expect(report.trackedModified).toEqual(["file.txt"]);
  expect(report.untracked).toEqual(["new.txt"]);
  expect(gateFails([report])).toBe(true);
}, GIT_TEST_TIMEOUT_MS);

test("a bare repo pushed to a local remote reports 0 unpushed; a local commit ahead reports 1", () => {
  const remote = mkdtempSync(join(tmpdir(), "agent-done-gate-remote-"));
  dirs.push(remote);
  git(remote, "init --bare -q");

  const dir = freshRepo();
  git(dir, `remote add origin "${remote.replace(/\\/g, "/")}"`);
  git(dir, "push -q -u origin main");

  const pushed = inspectRepo(dir);
  expect(pushed.upstream).toBe("origin/main");
  expect(pushed.unpushedCount).toBe(0);
  expect(unpushedLine(pushed)).toBe("0 commit(s) ahead of origin/main");
  expect(gateFails([pushed])).toBe(false); // clean AND has an upstream — still passes

  writeFileSync(join(dir, "another.txt"), "more work\n");
  git(dir, "add another.txt");
  git(dir, 'commit -q -m "second commit"');
  const ahead = inspectRepo(dir);
  expect(ahead.clean).toBe(true); // committed, not just staged
  expect(ahead.unpushedCount).toBe(1);
  expect(gateFails([ahead])).toBe(false); // unpushed alone never fails the gate
}, GIT_TEST_TIMEOUT_MS);

test("a non-git directory and a missing path are both reported as errors, and fail the gate", () => {
  const plainDir = mkdtempSync(join(tmpdir(), "agent-done-gate-plain-"));
  dirs.push(plainDir);
  const notGit = inspectRepo(plainDir);
  expect(notGit.ok).toBe(false);
  expect(notGit.error).toMatch(/not a git repository/);

  const missing = inspectRepo(join(plainDir, "does-not-exist"));
  expect(missing.ok).toBe(false);
  expect(missing.error).toMatch(/no such path/);

  expect(gateFails([notGit])).toBe(true);
  expect(gateFails([missing])).toBe(true);
}, GIT_TEST_TIMEOUT_MS);

test("--test runs the given command in the repo and reports pass/fail; a failing test fails the gate even on a clean tree", () => {
  const dir = freshRepo();
  const passing = inspectRepo(dir, process.platform === "win32" ? "exit 0" : "true");
  expect(passing.test?.passed).toBe(true);
  expect(gateFails([passing])).toBe(false);

  const failing = inspectRepo(dir, process.platform === "win32" ? "exit 1" : "false");
  expect(failing.clean).toBe(true); // the tree itself is still clean
  expect(failing.test?.passed).toBe(false);
  expect(gateFails([failing])).toBe(true); // but a failing test still fails the gate
}, GIT_TEST_TIMEOUT_MS);

test("never writes to the repo: running inspectRepo (with or without --test) leaves it exactly as clean as it started", () => {
  const dir = freshRepo();
  inspectRepo(dir, process.platform === "win32" ? "exit 0" : "true");
  const after = inspectRepo(dir);
  expect(after.clean).toBe(true);
  expect(after.trackedModified).toEqual([]);
  expect(after.untracked).toEqual([]);
}, GIT_TEST_TIMEOUT_MS);
