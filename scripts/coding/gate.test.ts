import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtefactId, CommandId, DoneCriterion, GitSha, IsoTime, OwnerAcceptance, PersonId, ReviewVerdict, RoleAssignment, RoleId, TaskSpec, TestResult, Uuid } from "./contracts";
import { eolOnlyFiles, parseCounts, parseFailedTests, runDoneGate, runRegistryCommand, testOutcome, type GateInput } from "./gate";
import { cleanup, commitIn, fixtureRepo, gitIn, write, type FixtureRepo } from "./test-fixtures";
import { canonicalSnapshot, createDetachedWorktree, createRoleWorktree, integrate, jobBranchName, sameSnapshot, UnsafeGitConfig } from "./worktree";

setDefaultTimeout(90_000);
const repos: FixtureRepo[] = [];
afterEach(() => { for (const r of repos.splice(0)) cleanup(r.root); });

const CHECK = "fx.test" as CommandId;
const limits = { maxWallMinutes: 30, maxTurns: 40, stopAtWindowPercent: 95 };
const opus = { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max", model: "claude-opus-5-5", cliVersion: "2.1.280" } as const;
const builder = (globs: string[], newFiles: string[] = []): RoleAssignment => ({
  roleId: "builder-1" as RoleId, role: "builder", agent: opus, access: "write", owns: { globs, newFiles }, dependsOn: [], limits,
});
const reviewerRole: RoleAssignment = { roleId: "reviewer" as RoleId, role: "reviewer", agent: opus, access: "read-only", owns: { globs: [], newFiles: [] }, dependsOn: ["builder-1" as RoleId], limits };
const DEFAULT_DONE: DoneCriterion[] = [
  { id: "d1", text: "the fixture check passes", evidence: "test", ref: CHECK },
  { id: "d2", text: "the reviewer confirms the change", evidence: "reviewer-confirms" },
  { id: "d3", text: "src/a.ts exists", evidence: "file-exists", ref: "src/a.ts" },
];

let counter = 0;
const id6 = () => (0x100000 + ++counter).toString(16).slice(-6);

type Built = { r: FixtureRepo; input: GateInput; builderPath: string };

/** One builder commits `files`; the orchestrator integrates, runs the check at head (and base), and a reviewer approves. */
async function build(files: Record<string, string>, options: { owns?: string[]; newFiles?: string[]; setupBase?: (r: FixtureRepo) => void; runBaseline?: boolean; doneWhen?: DoneCriterion[] } = {}): Promise<Built> {
  const r = fixtureRepo();
  repos.push(r);
  if (options.setupBase) {
    options.setupBase(r);
    r.baseSha = gitIn(r.canonical, "rev-parse", "HEAD").trim() as GitSha;
  }
  const id = id6();
  const jobBranch = jobBranchName("gate", id);
  const b = createRoleWorktree({ entry: r.entry, jobBranch, id6: id, roleId: "builder-1", baseSha: r.baseSha });
  commitIn(b.path, files);
  const merged = integrate({ entry: r.entry, jobBranch, id6: id, baseSha: r.baseSha, roleBranches: [b.branch!] });
  if (!merged.ok) throw new Error("fixture integration failed");
  const tester = createDetachedWorktree({ entry: r.entry, id6: id, name: "tester", sha: merged.sha });
  const run = await runRegistryCommand({ entry: r.entry, commandId: CHECK, worktreePath: tester.path, sha: merged.sha });
  let baseline: TestResult["baseline"] = null;
  if (options.runBaseline) {
    const baseTree = createDetachedWorktree({ entry: r.entry, id6: id, name: "baseline", sha: r.baseSha });
    const b0 = await runRegistryCommand({ entry: r.entry, commandId: CHECK, worktreePath: baseTree.path, sha: r.baseSha });
    baseline = { sha: r.baseSha, exitCode: b0.result.exitCode, failed: b0.result.counts.failed, failedTests: b0.result.failedTests };
  }
  const spec: GateInput["spec"] = {
    repo: { repoId: r.entry.id, baseRef: "main", baseSha: r.baseSha, jobBranch, excludesUncommittedCanonicalChanges: true },
    roles: [builder(options.owns ?? ["src/**"], options.newFiles ?? []), reviewerRole],
    checks: [CHECK],
    doneWhen: options.doneWhen ?? DEFAULT_DONE,
  } satisfies Pick<TaskSpec, "repo" | "roles" | "checks" | "doneWhen">;
  const review: ReviewVerdict = { reviewerRoleId: "reviewer" as RoleId, binding: opus, sha: merged.sha, verdict: "approve", findings: [], criteria: [{ criterionId: "d2", met: true, note: "checked" }] };
  const result: TestResult = { ...run.result, output: "a-00000000-0000-4000-8000-000000000000" as ArtefactId, baseline };
  return {
    r, builderPath: b.path,
    input: { entry: r.entry, spec, headSha: merged.sha, integrationPath: merged.path, roleWorktrees: [{ roleId: "builder-1", path: b.path }], tests: [result], review, testOutputs: { [CHECK]: run.output } },
  };
}
const check = (result: ReturnType<typeof runDoneGate>, name: string) => result.checks.find((c) => c.check === name)!;
const KEY = () => "sk-ant-" + "FAKEfakeFAKEfake1234567890abcdef";
const failWith = (names: string) => (r: FixtureRepo) => {
  write(r.canonical, "fails.txt", names);
  gitIn(r.canonical, "add", "fails.txt");
  gitIn(r.canonical, "commit", "-q", "-m", "known failures", "--", "fails.txt");
};

describe("coding done gate (§3.7)", () => {
  test("an owned, committed, tested, reviewed change passes every check, and the dirty canonical is untouched", async () => {
    const { r, input } = await build({ "src/a.ts": "export const a = 10;\n" });
    const before = canonicalSnapshot(r.canonical);
    const result = runDoneGate(input);
    expect(result.checks.map((c) => [c.check, c.passed])).toEqual([
      ["committed-and-clean", true], ["ownership", true], ["no-eol-only-churn", true], ["secret-scan", true],
      ["checks-pass", true], ["review-approved-for-sha", true], ["done-when-evidenced", true],
    ]);
    expect(result.passed).toBe(true);
    expect(result.sha).toBe(input.headSha);
    expect(input.tests[0]).toMatchObject({ ranBy: "orchestrator", exitCode: 0, counts: { passed: 3, failed: 0 }, failedTests: [] });
    expect(sameSnapshot(before, canonicalSnapshot(r.canonical))).toBe(true);
  });

  test("a file outside the builder's ownership fails the gate", async () => {
    const { input } = await build({ "src/a.ts": "export const a = 10;\n", "lib/c.ts": "export const c = 99;\n" });
    const result = runDoneGate(input);
    expect(result.passed).toBe(false);
    expect(check(result, "ownership").detail).toContain("lib/c.ts");
  });

  test("line-ending-only churn is flagged even when the file is owned", async () => {
    const { input } = await build({ "src/b.ts": "export const b = 2;\r\n" });
    const result = runDoneGate(input);
    expect(eolOnlyFiles(input.integrationPath, input.spec.repo.baseSha, input.headSha)).toEqual(["src/b.ts"]);
    expect(check(result, "ownership").passed).toBe(true);
    expect(check(result, "no-eol-only-churn").passed).toBe(false);
  });

  test("a secret in the diff fails, and the gate never repeats the value", async () => {
    const fake = KEY();
    const { input } = await build({ "src/config.ts": `export const apiKey = "${fake}";\n`, "src/.env": "TOKEN=abc\n" }, { newFiles: ["src/config.ts", "src/.env"] });
    const result = runDoneGate(input);
    const secret = check(result, "secret-scan");
    expect(secret.passed).toBe(false);
    expect(secret.detail).toContain("src/config.ts:1");
    expect(secret.detail).toContain("src/.env env-file");
    expect(JSON.stringify(result)).not.toContain(fake);
  });

  test("review B3 repro: a secret in a file marked binary by the job's own .gitattributes is still found", async () => {
    const { input } = await build({ ".gitattributes": "*.ts -diff\n", "src/a.ts": `export const k = "${KEY()}";\n` }, { owns: ["**"] });
    const secret = check(runDoneGate(input), "secret-scan");
    expect(secret.passed).toBe(false);
    expect(secret.detail).toContain("src/a.ts:1 anthropic-key");
    expect(secret.detail).toContain(".gitattributes gitattributes-changed");
  });

  test("review B3 repro: `* -diff` in the shared .git/info/attributes can't hide a secret either", async () => {
    const { r, input } = await build({ "src/a.ts": `export const k = "${KEY()}";\n` });
    writeFileSync(join(r.canonical, ".git", "info", "attributes"), "* -diff\n");
    const secret = check(runDoneGate(input), "secret-scan");
    expect(secret.passed).toBe(false);
    expect(secret.detail).toContain("src/a.ts:1 anthropic-key");
  });

  test("baseline credit is by failing-test identity: same failures allowed, a new regression never", async () => {
    // Same failing test before and after: allowed, and reported as pre-existing.
    const same = await build({ "src/a.ts": "export const a = 10;\n" }, {
      setupBase: failWith("alpha\n"), runBaseline: true,
      doneWhen: [{ id: "d1", text: "beta passes", evidence: "test", ref: "beta" }],
    });
    expect(same.input.tests[0]).toMatchObject({ exitCode: 1, counts: { failed: 1 }, failedTests: ["alpha"] });
    expect(same.input.tests[0].baseline).toMatchObject({ exitCode: 1, failed: 1, failedTests: ["alpha"], sha: same.input.spec.repo.baseSha });
    const ok = runDoneGate(same.input);
    expect(check(ok, "checks-pass").passed).toBe(true);
    expect(ok.baselineFailures).toEqual([{ commandId: CHECK, failed: 1 }]);
    expect(ok.passed).toBe(true);

    const t = same.input.tests[0];
    const variant = (x: TestResult) => check(runDoneGate({ ...same.input, tests: [x] }), "checks-pass").passed;
    expect(variant({ ...t, counts: { ...t.counts, failed: 2 }, failedTests: ["alpha", "delta"] })).toBe(false);
    expect(variant({ ...t, baseline: null })).toBe(false);
    expect(variant({ ...t, baseline: { ...t.baseline!, sha: "f".repeat(40) as GitSha } })).toBe(false);
    expect(variant({ ...t, failedTests: null })).toBe(false);
    expect(variant({ ...t, baseline: { ...t.baseline!, failedTests: null } })).toBe(false);
    expect(variant({ ...t, baseline: { ...t.baseline!, exitCode: 0, failed: 0, failedTests: [] } })).toBe(false);
  });

  test("review B4.2 repro: fixing the old failure while adding a new one (same count) fails the gate", async () => {
    const swapped = await build({ "fails.txt": "delta\n" }, { owns: ["src/**", "fails.txt"], setupBase: failWith("alpha\n"), runBaseline: true, doneWhen: [{ id: "d1", text: "beta", evidence: "test", ref: "beta" }] });
    expect(swapped.input.tests[0]).toMatchObject({ counts: { failed: 1 }, failedTests: ["delta"] });
    expect(swapped.input.tests[0].baseline).toMatchObject({ failed: 1, failedTests: ["alpha"] });
    const result = runDoneGate(swapped.input);
    expect(check(result, "checks-pass").passed).toBe(false);
    expect(check(result, "checks-pass").detail).toContain("1 new failing test");
    expect(result.passed).toBe(false);
  });

  test("review B4.1 repro: a named criterion needs an explicit PASS line; its own failing or skipped test is never evidence", async () => {
    const { input } = await build({ "src/a.ts": "export const a = 10;\n" });
    const named = (ref: string, output: string) => check(runDoneGate({
      ...input, spec: { ...input.spec, doneWhen: [{ id: "d9", text: ref, evidence: "test", ref }] }, testOutputs: { [CHECK]: output },
    }), "done-when-evidenced").passed;
    expect(named("handles the dental case", "(fail) handles the dental case [2.00ms]\n 0 fail")).toBe(false);
    expect(named("handles the dental case", "(skip) handles the dental case\n")).toBe(false);
    expect(named("handles the dental case", "console: handles the dental case\n")).toBe(false);
    expect(named("handles the dental case", "(pass) handles the dental case [1.00ms]\n(fail) retry > handles the dental case\n")).toBe(false);
    expect(named("dental", "(pass) handles the dental case [1.00ms]\n")).toBe(false);
    expect(named("handles the dental case", "(pass) handles the dental case [1.00ms]\n")).toBe(true);
    // A command-level criterion needs the command to exit 0, not just baseline credit.
    const failing = { ...input.tests[0], exitCode: 1, counts: { passed: 2, failed: 1, skipped: 0 }, failedTests: ["alpha"], baseline: { sha: input.spec.repo.baseSha, exitCode: 1, failed: 1, failedTests: ["alpha"] } };
    const withBaseline = runDoneGate({ ...input, tests: [failing] });
    expect(check(withBaseline, "checks-pass").passed).toBe(true);
    expect(check(withBaseline, "done-when-evidenced").passed).toBe(false);
  });

  test("a check that wasn't run by the orchestrator at this sha doesn't count", async () => {
    const { input } = await build({ "src/a.ts": "export const a = 10;\n" });
    const t = input.tests[0];
    expect(runDoneGate({ ...input, tests: [] }).passed).toBe(false);
    expect(check(runDoneGate({ ...input, tests: [{ ...t, sha: input.spec.repo.baseSha }] }), "checks-pass").passed).toBe(false);
    expect(check(runDoneGate({ ...input, tests: [{ ...t, timedOut: true, exitCode: null }] }), "checks-pass").passed).toBe(false);
  });

  test("review B4.3 repro: only an owner acceptance (Stage B) resolves a major; the reviewer can't accept its own findings", async () => {
    const { input } = await build({ "src/a.ts": "export const a = 10;\n" });
    const review = input.review!;
    const gate = (r: ReviewVerdict | null, ownerAcceptances: OwnerAcceptance[] = []) => check(runDoneGate({ ...input, review: r, ownerAcceptances }), "review-approved-for-sha").passed;
    const finding = { id: "f1", file: "src/a.ts", line: 1, message: "m" };
    const acceptance = (over: Partial<OwnerAcceptance> = {}): OwnerAcceptance => ({ findingId: "f1", sha: input.headSha, by: "usman" as PersonId, approvalId: "11111111-2222-4333-8444-555555555555" as Uuid, at: new Date().toISOString() as IsoTime, ...over });
    expect(gate(review)).toBe(true);
    expect(gate(null)).toBe(false);
    expect(gate({ ...review, sha: input.spec.repo.baseSha })).toBe(false);
    expect(gate({ ...review, verdict: "request-changes" })).toBe(false);
    // Reviewer self-marks: ignored.
    expect(gate({ ...review, findings: [{ ...finding, severity: "major", status: "accepted-by-owner" }] })).toBe(false);
    expect(gate({ ...review, findings: [{ ...finding, severity: "major", status: "fixed" }] })).toBe(false);
    expect(gate({ ...review, findings: [{ ...finding, severity: "blocker", status: "fixed" }] })).toBe(false);
    // A real owner acceptance for this finding and sha resolves a major, never a blocker.
    const major = { ...review, findings: [{ ...finding, severity: "major" as const, status: "open" as const }] };
    expect(gate(major, [acceptance()])).toBe(true);
    expect(gate(major, [acceptance({ by: "mehroz" as PersonId })])).toBe(false);
    expect(gate(major, [acceptance({ sha: input.spec.repo.baseSha })])).toBe(false);
    expect(gate(major, [acceptance({ approvalId: "not-an-approval" as Uuid })])).toBe(false);
    expect(gate(major, [acceptance({ findingId: "other" })])).toBe(false);
    expect(gate({ ...review, findings: [{ ...finding, severity: "blocker", status: "open" }] }, [acceptance()])).toBe(false);
    expect(gate({ ...review, findings: [{ ...finding, severity: "minor", status: "open" }] })).toBe(true);
  });

  test("uncommitted work in a role worktree, or a head that isn't the branch, fails 'committed'", async () => {
    const { input, builderPath } = await build({ "src/a.ts": "export const a = 10;\n" });
    write(builderPath, "src/a.ts", "left uncommitted\n");
    expect(check(runDoneGate(input), "committed-and-clean").passed).toBe(false);
    gitIn(builderPath, "checkout", "--", "src/a.ts");
    expect(check(runDoneGate(input), "committed-and-clean").passed).toBe(true);
    expect(check(runDoneGate({ ...input, headSha: input.spec.repo.baseSha }), "committed-and-clean").passed).toBe(false);
  });

  test("every done-when criterion needs evidence; an unmapped one fails", async () => {
    const { input } = await build({ "src/a.ts": "export const a = 10;\n" });
    const extra = { ...input.spec, doneWhen: [...input.spec.doneWhen, { id: "d4", text: "docs updated", evidence: "file-exists" as const, ref: "docs/new.md" }] };
    const result = runDoneGate({ ...input, spec: extra });
    expect(check(result, "done-when-evidenced").detail).toContain("d4");
    expect(check(runDoneGate({ ...input, spec: { ...input.spec, doneWhen: [] } }), "done-when-evidenced").passed).toBe(false);
    const named = { ...input.spec, doneWhen: [{ id: "d5", text: "gamma passes", evidence: "test" as const, ref: "gamma" }] };
    expect(check(runDoneGate({ ...input, spec: named }), "done-when-evidenced").passed).toBe(true);
  });

  test("review M1 repro: an agent-set exec-capable git config makes the gate refuse the repo", async () => {
    const { r, input, builderPath } = await build({ "src/a.ts": "export const a = 10;\n" });
    gitIn(builderPath, "config", "filter.evil.smudge", "cmd /c echo pwned");
    expect(() => runDoneGate(input)).toThrow(UnsafeGitConfig);
    gitIn(r.canonical, "config", "--unset", "filter.evil.smudge");
    expect(runDoneGate(input).passed).toBe(true);
  });

  test("the orchestrator runs a registry command only at the sha it claims", async () => {
    const { r, input } = await build({ "src/a.ts": "export const a = 10;\n" });
    await expect(runRegistryCommand({ entry: r.entry, commandId: CHECK, worktreePath: input.integrationPath, sha: r.baseSha })).rejects.toThrow("not at the sha");
    await expect(runRegistryCommand({ entry: r.entry, commandId: "fx.nope", worktreePath: input.integrationPath, sha: input.headSha })).rejects.toThrow("Unknown registry command");
  });
});

describe("runner output parsing", () => {
  test("bun, vitest, jest and node-test summaries; unknown stays null", () => {
    expect(parseCounts("bun", " 109 pass\n 4 skip\n 0 fail\n")).toEqual({ passed: 109, failed: 0, skipped: 4 });
    expect(parseCounts("vitest", " Tests  2 failed | 10 passed | 1 skipped (13)")).toEqual({ passed: 10, failed: 2, skipped: 1 });
    expect(parseCounts("jest", "Tests:       1 failed, 2 passed, 3 total")).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(parseCounts("node-test", "# pass 5\n# fail 1\n# skipped 0\n")).toEqual({ passed: 5, failed: 1, skipped: 0 });
    expect(parseCounts("none", " 5 pass")).toEqual({ passed: null, failed: null, skipped: null });
    expect(parseCounts("bun", "crashed before summary")).toEqual({ passed: null, failed: null, skipped: null });
  });
  test("failing test names are parsed; a name list that doesn't match the count is unknown", () => {
    const out = "(pass) a [1.00ms]\n(fail) suite > b fails [2.10ms]\n(fail) c\n 1 pass\n 2 fail\n";
    expect(parseFailedTests("bun", out, 2)).toEqual(["c", "suite > b fails"]);
    expect(parseFailedTests("bun", out, 3)).toBeNull();
    expect(parseFailedTests("none", out, 2)).toBeNull();
    expect(parseFailedTests("node-test", "not ok 1 - x\nok 2 - y\n", 1)).toEqual(["x"]);
  });
  test("testOutcome: pass lines, fail/skip lines, and mere mentions", () => {
    expect(testOutcome("(pass) x works [1ms]", "x works")).toBe("passed");
    expect(testOutcome("(fail) x works", "x works")).toBe("failed");
    expect(testOutcome("(todo) x works", "x works")).toBe("failed");
    expect(testOutcome("not ok 3 - x works", "x works")).toBe("failed");
    expect(testOutcome("log: x works", "x works")).toBe("absent");
    expect(testOutcome("(pass) y", "")).toBe("absent");
  });
  test("review R2: names match exactly (full name or last describe segment), never by substring", () => {
    const out = "(pass) suite > handles the dental case [1.00ms]\n(pass) dental booking works\nok 4 - tz edge # SKIP flaky\n";
    expect(testOutcome(out, "dental")).toBe("absent");
    expect(testOutcome(out, "handles the dental case")).toBe("passed");
    expect(testOutcome(out, "suite > handles the dental case")).toBe("passed");
    expect(testOutcome(out, "dental booking works")).toBe("passed");
    expect(testOutcome(out, "tz edge")).toBe("failed");
    expect(testOutcome("(pass) a > b\n(fail) c > b\n", "b")).toBe("failed");
  });
});
