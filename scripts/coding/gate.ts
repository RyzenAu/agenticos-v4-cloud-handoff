import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { childEnv, terminateChild } from "../assistant-runtime";
import type {
  ArtefactId,
  CommandId,
  DiffFile,
  DiffSummary,
  DoneGateResult,
  GateCheck,
  GitSha,
  IsoTime,
  OwnerAcceptance,
  PersonId,
  RegistryCommand,
  RepoRegistryEntry,
  ReviewVerdict,
  RoleAssignment,
  RoleId,
  TaskSpec,
  TestResult,
} from "./contracts";
import { redactText, scanPatch } from "./redact";
import { commandById, ownsPath } from "./registry";
import { asSha, assertSafeGitConfig, git, worktreeState } from "./worktree";

/**
 * The coding done gate (CODING-HARNESS §3.7). A job is "completed" only if every check passes for the
 * job's exact head sha. It never trusts an agent's claim: tests count only when the orchestrator ran
 * them, failures are compared by test identity, and a review finding is only "accepted" by an owner
 * acceptance that came from Stage B approvals, never by a status the reviewer set.
 *   1 committed-and-clean  2 ownership + no-eol-only-churn  3 secret-scan  4 checks-pass
 *   5 review-approved-for-sha  6 done-when-evidenced
 * Before reading anything it refuses a repo whose shared git config was made exec-capable
 * (UnsafeGitConfig is thrown; the orchestrator puts the job in needs_owner).
 */

/** Every diff the gate reads: binary markings ignored, no textconv, no external diff, no colour. */
const DIFF_SAFE = ["--text", "--no-textconv", "--no-ext-diff", "--no-color"];

const writers = (roles: readonly RoleAssignment[]) => roles.filter((r) => r.access === "write" && (r.role === "builder" || r.role === "test-author"));

function numstat(cwd: string, base: string, head: string, extra: string[] = []): Map<string, { add: number | null; del: number | null }> {
  const out = new Map<string, { add: number | null; del: number | null }>();
  // --text: a file marked binary (`-diff` in .gitattributes or the shared .git/info/attributes) is
  // still counted line by line; no textconv or external diff program ever runs (review B3).
  const text = git(cwd, ["diff", ...DIFF_SAFE, "--numstat", "-z", "--no-renames", ...extra, base, head]).stdout;
  for (const record of text.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record.replace(/^\n/, ""));
    if (!m) continue;
    out.set(m[3], { add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]) });
  }
  return out;
}

/** Files whose whole change disappears when CR at end of line is ignored (the Python CRLF trap). */
export function eolOnlyFiles(cwd: string, base: string, head: string): string[] {
  const raw = numstat(cwd, base, head);
  const ignoring = numstat(cwd, base, head, ["--ignore-cr-at-eol"]);
  const files: string[] = [];
  for (const [file, counts] of raw) {
    if (counts.add === null) continue;
    if ((counts.add ?? 0) + (counts.del ?? 0) === 0) continue;
    const after = ignoring.get(file);
    if (!after || (after.add ?? 0) + (after.del ?? 0) === 0) files.push(file);
  }
  return files.sort();
}

/** The diff between base and head, with ownership and EOL-only flags per file. */
export function diffSummary(input: { cwd: string; baseSha: GitSha; headSha: GitSha; roles: readonly RoleAssignment[]; patch: ArtefactId }): DiffSummary {
  const { cwd, baseSha, headSha } = input;
  const statusText = git(cwd, ["diff", ...DIFF_SAFE, "--name-status", "-z", "--no-renames", baseSha, headSha]).stdout.split("\0");
  const counts = numstat(cwd, baseSha, headSha);
  const eol = new Set(eolOnlyFiles(cwd, baseSha, headSha));
  const files: DiffFile[] = [];
  for (let i = 0; i + 1 < statusText.length; i += 2) {
    const code = statusText[i].replace(/^\n/, "");
    const path = statusText[i + 1];
    if (!code || !path) continue;
    const owner = writers(input.roles).find((r) => ownsPath(r.owns, path));
    const c = counts.get(path);
    files.push({
      path,
      status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified",
      additions: c?.add ?? 0,
      deletions: c?.del ?? 0,
      ownedBy: (owner?.roleId as RoleId | undefined) ?? null,
      eolOnly: eol.has(path),
    });
  }
  return { baseSha, headSha, files, outsideOwnership: files.filter((f) => !f.ownedBy).map((f) => f.path), patch: input.patch };
}

// ─────────────────────────── orchestrator test runs ───────────────────────────

const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");

/** Parse pass/fail/skip counts from a runner's summary. Unknown stays null, never 0. */
export function parseCounts(kind: RegistryCommand["counts"], output: string): TestResult["counts"] {
  const text = plain(output);
  const last = (re: RegExp) => { let n: number | null = null; for (const m of text.matchAll(re)) n = Number(m[1]); return n; };
  switch (kind) {
    case "bun": return { passed: last(/^\s*(\d+) pass\s*$/gm), failed: last(/^\s*(\d+) fail\s*$/gm), skipped: last(/^\s*(\d+) skip\s*$/gm) };
    case "vitest": return { passed: last(/(\d+) passed/g), failed: last(/(\d+) failed/g) ?? (/Tests\s+\d+ passed/.test(text) ? 0 : null), skipped: last(/(\d+) skipped/g) };
    case "jest": {
      const line = /^Tests:\s+(.*)$/m.exec(text)?.[1] ?? "";
      const n = (word: string) => (line ? Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0) : null);
      return { passed: n("passed"), failed: n("failed"), skipped: n("skipped") };
    }
    case "node-test": return { passed: last(/^# pass (\d+)$/gm), failed: last(/^# fail (\d+)$/gm), skipped: last(/^# skipped (\d+)$/gm) };
    default: return { passed: null, failed: null, skipped: null };
  }
}

/**
 * The NAMES of failing tests, so baseline accounting compares identities, not counts (review B4.2).
 * Null = unknown: an unsupported runner, or a name list that doesn't match the failure count.
 */
export function parseFailedTests(kind: RegistryCommand["counts"], output: string, failedCount: number | null): string[] | null {
  const text = plain(output);
  const grab = (re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[1].replace(/\s+\[[\d.]+\s*m?s\]\s*$/, "").trim()))];
  let names: string[] | null;
  switch (kind) {
    case "bun": names = grab(/^\(fail\)\s+(.+)$/gm); break;
    case "vitest": names = grab(/^\s*(?:×|✗|FAIL)\s+(.+)$/gm); break;
    case "jest": names = grab(/^\s*●\s+(.+)$/gm); break;
    case "node-test": names = grab(/^\s*not ok \d+ - (.+)$/gm); break;
    default: names = null;
  }
  if (names === null || failedCount === null) return null;
  return names.length === failedCount ? names.sort() : null;
}

/** A runner's per-test result line: its marker and the test's full name (timing and directives stripped). */
const RESULT_LINE = /^\s*(\(pass\)|\(fail\)|\(skip\)|\(todo\)|✓|✔|√|×|✗|✘|ok \d+ -|not ok \d+ -|●)\s+(.+?)\s*$/;

/**
 * How one named test fared, matched by EXACT name (review R2): the test's full name, or its last
 * ` > `-separated segment (bun prefixes describe blocks). "dental" does not match "handles the dental
 * case". Any fail/skip/todo result for that name wins over a pass.
 */
export function testOutcome(output: string, name: string): "passed" | "failed" | "absent" {
  const wanted = name.trim();
  if (!wanted) return "absent";
  let passed = false;
  for (const raw of plain(output).split(/\r?\n/)) {
    const m = RESULT_LINE.exec(raw);
    if (!m) continue;
    let full = m[2].replace(/\s+\[[\d.]+\s*m?s\]$/, "");
    const directive = /\s+#\s*(SKIP|TODO)\b.*$/i.exec(full);
    if (directive) full = full.slice(0, directive.index);
    const last = full.split(" > ").pop()!.trim();
    if (full.trim() !== wanted && last !== wanted) continue;
    if (directive || /^(?:\(fail\)|\(skip\)|\(todo\)|×|✗|✘|not ok|●)/.test(m[1])) return "failed";
    passed = true;
  }
  return passed ? "passed" : "absent";
}

export type CommandRun = { result: Omit<TestResult, "output" | "baseline">; output: string };

/**
 * Run one registry command at an exact sha, as the orchestrator: argv without a shell, cwd inside the
 * worktree, the allowlisted environment, a hard timeout with a tree kill, and a hard settle if the
 * process tree still holds its pipes after the kill. The output is redacted; the caller stores it.
 */
export async function runRegistryCommand(input: { entry: RepoRegistryEntry; commandId: CommandId | string; worktreePath: string; sha: GitSha; outputLimit?: number; killGraceMs?: number }): Promise<CommandRun> {
  const command = commandById(input.entry, input.commandId);
  if (!command) throw new Error(`Unknown registry command ${input.commandId}.`);
  const head = asSha(git(input.worktreePath, ["rev-parse", "HEAD"]).stdout);
  if (head !== input.sha) throw new Error("The worktree is not at the sha being tested.");
  const cwd = resolve(input.worktreePath, command.cwd);
  if (!(cwd + "/").replace(/\\/g, "/").toLowerCase().startsWith((resolve(input.worktreePath) + "/").replace(/\\/g, "/").toLowerCase()))
    throw new Error("A registry command cannot run outside its worktree.");
  const started = Date.now();
  const limit = input.outputLimit ?? 2_000_000;
  return await new Promise<CommandRun>((done) => {
    let output = "", timedOut = false, settled = false;
    let hardSettle: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command.argv[0], command.argv.slice(1), { cwd, env: childEnv({ extra: { CI: "1", NO_COLOR: "1" } }), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const take = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-limit); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardSettle);
      const counts = parseCounts(command.counts, output);
      done({
        result: {
          commandId: command.id,
          argv: [...command.argv],
          sha: input.sha,
          ranBy: "orchestrator",
          exitCode: timedOut ? null : exitCode,
          timedOut,
          counts,
          failedTests: parseFailedTests(command.counts, output, counts.failed),
          durationMs: Date.now() - started,
        },
        output: redactText(output, limit),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, "SIGKILL");
      // A grandchild holding the pipes (or a failed taskkill) must not hang the gate forever.
      hardSettle = setTimeout(() => finish(null), input.killGraceMs ?? 5_000);
    }, command.timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

// ─────────────────────────── the gate ───────────────────────────

export type GateInput = {
  entry: RepoRegistryEntry;
  spec: Pick<TaskSpec, "repo" | "roles" | "checks" | "doneWhen">;
  /** The job head the orchestrator believes is integrated. */
  headSha: GitSha;
  /** The integration worktree, on the job branch. */
  integrationPath: string;
  roleWorktrees: readonly { roleId: RoleId | string; path: string }[];
  /** Orchestrator-run results at headSha, each carrying its baseline (same command, base sha) if recorded. */
  tests: readonly TestResult[];
  review: ReviewVerdict | null;
  /** Redacted outputs by command id, for done-when criteria that name a test rather than a command. */
  testOutputs?: Readonly<Record<string, string>>;
  /**
   * Owner acceptances of review findings, read by the orchestrator from Stage B approvals. The
   * reviewer's own `status` field is never trusted (review B4.3).
   */
  ownerAcceptances?: readonly OwnerAcceptance[];
  /** Who may accept a finding. Defaults to the owner; Stage B's authorise() supplies it in C4. */
  acceptors?: readonly PersonId[];
  /**
   * Finished agent runs that have NO usage receipt (receipts.ts unreceiptedRuns). When supplied (even empty),
   * the gate adds "receipts-recorded": a run with no receipt can't be claimed as having run a model.
   */
  unreceipted?: readonly string[];
  now?: () => Date;
};

type Check = { check: GateCheck; passed: boolean; detail: string };

function committedAndClean(input: GateInput): Check {
  const problems: string[] = [];
  const branchHead = git(input.integrationPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.spec.repo.jobBranch}`], { allowFail: true }).stdout.trim();
  const worktreeHead = git(input.integrationPath, ["rev-parse", "HEAD"], { allowFail: true }).stdout.trim();
  if (branchHead !== input.headSha) problems.push(`job branch is at ${branchHead.slice(0, 7) || "nothing"}, not ${input.headSha.slice(0, 7)}`);
  if (worktreeHead !== input.headSha) problems.push("integration worktree is not at the job head");
  for (const { roleId, path } of [{ roleId: "job", path: input.integrationPath }, ...input.roleWorktrees]) {
    const state = worktreeState(path);
    if (!state.ok) problems.push(`${roleId}: ${state.error}`);
    else if (state.dirty) problems.push(`${roleId}: ${state.dirty} uncommitted file(s)`);
  }
  return { check: "committed-and-clean", passed: !problems.length, detail: problems.join("; ") || "job branch = head; every worktree clean" };
}

function ownership(input: GateInput): { owned: Check; eol: Check } {
  const base = input.spec.repo.baseSha;
  const changed = git(input.integrationPath, ["diff", ...DIFF_SAFE, "--name-only", "-z", "--no-renames", base, input.headSha]).stdout.split("\0").filter(Boolean);
  const owners = writers(input.spec.roles);
  const outside = changed.filter((file) => !owners.some((r) => ownsPath(r.owns, file)));
  const eol = eolOnlyFiles(input.integrationPath, base, input.headSha);
  return {
    owned: { check: "ownership", passed: !outside.length, detail: outside.length ? `outside ownership: ${outside.join(", ")}` : `${changed.length} changed file(s), all owned` },
    eol: { check: "no-eol-only-churn", passed: !eol.length, detail: eol.length ? `line-ending-only changes: ${eol.join(", ")}` : "no line-ending-only files" },
  };
}

function secrets(input: GateInput): Check {
  // --text so nothing hides behind a binary marking (review B3); -U0 so only the change is scanned.
  const patch = git(input.integrationPath, ["diff", ...DIFF_SAFE, "--no-renames", "-U0", input.spec.repo.baseSha, input.headSha]).stdout;
  const findings = scanPatch(patch);
  return {
    check: "secret-scan",
    passed: !findings.length,
    // Rule, file and line only: the matched value never enters the gate result.
    detail: findings.length ? findings.map((f) => `${f.file ?? "?"}${f.line ? `:${f.line}` : ""} ${f.rule}`).join("; ") : "no secrets in added lines or paths",
  };
}

function checksPass(input: GateInput, baselineFailures: { commandId: CommandId; failed: number }[], accepted: Set<CommandId>): Check {
  const problems: string[] = [];
  for (const id of input.spec.checks) {
    const result = [...input.tests].reverse().find((t) => t.commandId === id && t.sha === input.headSha && t.ranBy === "orchestrator");
    if (!result) { problems.push(`${id}: not run by the orchestrator at this sha`); continue; }
    if (result.timedOut) { problems.push(`${id}: timed out`); continue; }
    if (result.exitCode === 0) { accepted.add(id); continue; }
    // A failing check passes only when the SAME command failed on the base sha before the build, and
    // every test failing now also failed then, BY NAME. Unknown names on either side get no credit.
    const b = result.baseline;
    if (!b || b.sha !== input.spec.repo.baseSha) { problems.push(`${id}: exit ${result.exitCode ?? "?"} with no baseline recorded on the base sha`); continue; }
    if (b.exitCode === 0) { problems.push(`${id}: passed on the base sha, fails now`); continue; }
    if (!result.failedTests || !b.failedTests || result.counts.failed === null || b.failed === null) {
      problems.push(`${id}: failing tests can't be identified, so pre-existing failures can't be separated`);
      continue;
    }
    const before = new Set(b.failedTests);
    const fresh = result.failedTests.filter((name) => !before.has(name));
    if (fresh.length) { problems.push(`${id}: ${fresh.length} new failing test(s) not failing on the base sha`); continue; }
    baselineFailures.push({ commandId: id, failed: result.failedTests.length });
    accepted.add(id);
  }
  const note = baselineFailures.length ? `; pre-existing failures: ${baselineFailures.map((b) => `${b.commandId} ${b.failed}`).join(", ")}` : "";
  return { check: "checks-pass", passed: !problems.length, detail: (problems.join("; ") || `${input.spec.checks.length} check(s) passed`) + note };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reviewApproved(input: GateInput): Check {
  const r = input.review;
  if (!r) return { check: "review-approved-for-sha", passed: false, detail: "no independent review" };
  const problems: string[] = [];
  if (r.sha !== input.headSha) problems.push(`review is for ${r.sha.slice(0, 7)}, not ${input.headSha.slice(0, 7)}`);
  if (r.verdict !== "approve") problems.push(`verdict ${r.verdict}`);
  // The reviewer's `status` is advisory only. A blocker always blocks; a major passes only with an
  // owner acceptance for this finding at this sha, backed by a Stage B approval id.
  const acceptors = new Set(input.acceptors ?? (["usman"] as PersonId[]));
  const accepted = (findingId: string) => (input.ownerAcceptances ?? []).some((a) =>
    a.findingId === findingId && a.sha === input.headSha && acceptors.has(a.by) && UUID.test(a.approvalId));
  const blockers = r.findings.filter((f) => f.severity === "blocker");
  const majors = r.findings.filter((f) => f.severity === "major" && !accepted(f.id));
  if (blockers.length) problems.push(`${blockers.length} blocker(s)`);
  if (majors.length) problems.push(`${majors.length} major finding(s) without an owner acceptance`);
  return { check: "review-approved-for-sha", passed: !problems.length, detail: problems.join("; ") || `approved for ${input.headSha.slice(0, 7)}` };
}

function receiptsRecorded(missing: readonly string[]): Check {
  return { check: "receipts-recorded", passed: !missing.length, detail: missing.length ? `no usage receipt for: ${missing.join(", ")}` : "every agent run has its receipt (model, account, tokens)" };
}

/** `accepted` = checks the gate accepted at this sha (exit 0, or only pre-existing baseline failures). */
function doneWhen(input: GateInput, accepted: ReadonlySet<CommandId>): Check {
  const unmapped: string[] = [];
  for (const c of input.spec.doneWhen) {
    let ok = false;
    if (c.evidence === "test" || c.evidence === "typecheck" || c.evidence === "build") {
      const asCommand = c.ref ? [...input.tests].reverse().find((t) => t.commandId === c.ref && t.sha === input.headSha) : undefined;
      if (asCommand) ok = accepted.has(asCommand.commandId) && asCommand.exitCode === 0;
      else if (c.evidence === "test" && c.ref) {
        // A named test: it must have an explicit PASS line in an accepted command's output, and no
        // fail/skip/todo line anywhere (review B4.1: a failing test is never evidence).
        const outcomes = [...accepted].map((id) => testOutcome(input.testOutputs?.[id] ?? "", c.ref!));
        ok = outcomes.includes("passed") && !outcomes.includes("failed");
      }
    } else if (c.evidence === "file-exists") {
      ok = !!c.ref && git(input.integrationPath, ["cat-file", "-e", `${input.headSha}:${c.ref.replace(/\\/g, "/")}`], { allowFail: true }).ok;
    } else if (c.evidence === "reviewer-confirms") {
      ok = !!input.review && input.review.sha === input.headSha && input.review.criteria.some((x) => x.criterionId === c.id && x.met);
    }
    if (!ok) unmapped.push(c.id);
  }
  return {
    check: "done-when-evidenced",
    passed: !unmapped.length && input.spec.doneWhen.length > 0,
    detail: !input.spec.doneWhen.length ? "no done-when criteria" : unmapped.length ? `no evidence for: ${unmapped.join(", ")}` : `${input.spec.doneWhen.length} criteria evidenced`,
  };
}

/** Run the whole gate. It reads git and the inputs only; it changes nothing. */
export function runDoneGate(input: GateInput): DoneGateResult {
  const sha = asSha(input.headSha);
  assertSafeGitConfig(input.integrationPath);
  const baselineFailures: { commandId: CommandId; failed: number }[] = [];
  const accepted = new Set<CommandId>();
  const own = ownership(input);
  const checks: Check[] = [
    committedAndClean(input),
    own.owned,
    own.eol,
    secrets(input),
    checksPass(input, baselineFailures, accepted),
    reviewApproved(input),
    doneWhen(input, accepted),
    ...(input.unreceipted ? [receiptsRecorded(input.unreceipted)] : []),
  ];
  return { sha, passed: checks.every((c) => c.passed), checks, baselineFailures, at: (input.now?.() ?? new Date()).toISOString() as IsoTime };
}
