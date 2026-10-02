import { describe, expect, test } from "bun:test";
import type { CodingJob } from "./contracts";
import { codingBlocker, codingPauseReason, codingResumeLabel } from "./pause-reason";
import { redactText } from "./redact";
import { gateCheckWords, namesBaselineTest, reviewIsBaselineOnly } from "./pause-reason";
import { needsYouLine } from "../../src/components/coding/needs-you";

const head = "a".repeat(40);
const fixture = (patch: Record<string, unknown> = {}) => ({ state: "needs_owner", headSha: head, runs: [], review: null, gate: null, ...patch }) as unknown as CodingJob;
const run = (roleId: string, state: string, message: string | null) => ({ roleId, role: "reviewer", state, error: message ? { message } : null });
const changes = { sha: head, verdict: "request-changes", findings: [{ severity: "major" }], criteria: [] };

describe("coding stops explain the current reason (synthetic)", () => {
  test("a rejected review offers a repair rather than asking for another generic approval", () => {
    const j = fixture({ review: changes });
    expect(needsYouLine(j)).toBe("Review needs fixes (1 serious finding). Resume sends them back to the builder.");
    expect(codingResumeLabel(j)).toBe("Fix review findings");
  });
  test("the current blocked reviewer is shown even if an old review asked for fixes", () => {
    const j = fixture({ review: changes, runs: [run("reviewer", "failed", "Codex roles are paused by the isolation preflight")] });
    expect(codingPauseReason(j)).toContain("Codex is paused");
    expect(codingBlocker(j)).toMatchObject({ kind: "reviewer-unavailable", roleId: "reviewer" });
    expect(codingResumeLabel(j)).toBe("Retry review");
    expect(codingResumeLabel(j, "Claude Max 2")).toBe("Retry review on Claude Max 2");
  });
  test("a recovered error from an earlier attempt does not hide the current review", () => {
    const j = fixture({ review: changes, runs: [run("reviewer", "failed", "old provider error"), run("reviewer", "succeeded", null)] });
    expect(codingPauseReason(j)).not.toContain("old provider error");
    expect(codingResumeLabel(j)).toBe("Fix review findings");
  });
  test("an inconclusive review offers a reviewer retry", () => {
    const j = fixture({ review: { ...changes, verdict: "cannot-assess" } });
    expect(codingResumeLabel(j)).toBe("Retry review");
  });
  test("stale review findings do not masquerade as the current completion failure", () => {
    const j = fixture({ review: { ...changes, sha: "b".repeat(40) }, gate: { sha: head, checks: [{ check: "checks-pass", passed: false, detail: "New test failure: alpha" }] } });
    expect(codingPauseReason(j)).toBe("The tests don't pass: New test failure: alpha.");
    expect(codingResumeLabel(j)).toBe("Re-run the done gate");
  });

  const BASE = "b".repeat(40);
  const ACL = "REVIEW-T3 R2: one --apply run, a complete --rollback (real icacls, SYNTHETIC home only) > known_hosts with inheritance off is denied";
  const roles = (owns: string[]) => [{ roleId: "builder-1", role: "builder", agent: { route: "model-router" }, owns: { globs: owns, newFiles: [] } }, { roleId: "reviewer", role: "reviewer", agent: { route: "model-router" }, owns: { globs: [], newFiles: [] } }];
  const baselineJob = (patch: Record<string, unknown> = {}) => fixture({
    spec: { repo: { baseSha: BASE }, roles: roles(["scripts/coding/shaper.ts", "scripts/coding/voice.ts"]) },
    tests: [{ sha: BASE, failedTests: [ACL], baseline: null }, { sha: head, failedTests: [ACL], baseline: { sha: BASE, failedTests: [ACL] } }],
    gate: { sha: head, passed: false, baselineFailures: [{ commandId: "aos.test-coding", failed: 1, names: [ACL] }], checks: [{ check: "checks-pass", passed: true, detail: "" }, { check: "done-when-evidenced", passed: false, detail: "no evidence for: c1" }] },
    ...patch,
  });
  test("missing tests the builder isn't allowed to write: says so, and the button doesn't promise tests", () => {
    const j = baselineJob({ review: { sha: head, verdict: "request-changes", criteria: [], findings: [
      { severity: "major", message: "No focused synthetic tests were added. The diff contains no new or modified test file." },
      { severity: "major", message: `The required suite does not pass: '${ACL}'` },
    ] } });
    const b = codingBlocker(j);
    expect(b.kind).toBe("review-missing-tests");
    expect(b.text).toContain("shaper.ts and voice.ts");
    expect(b.text).toContain("can't add them");
    expect(b.label).toBe("Fix the findings the builder can reach");
    expect(needsYouLine(j)).not.toMatch(/needs you|needs your decision/i);
  });
  test("a test-author or an owned test file means missing tests are fixable by Resume", () => {
    const j = baselineJob({ spec: { repo: { baseSha: BASE }, roles: roles(["src/a.ts", "src/a.test.ts"]) }, review: { sha: head, verdict: "request-changes", criteria: [], findings: [{ severity: "major", message: "No tests were added for the new branch." }] } });
    expect(codingBlocker(j).kind).toBe("review-changes");
  });
  test("a rejection that is only a baseline test failure offers a fresh review, not a rebuild", () => {
    const j = baselineJob({ review: { sha: head, verdict: "request-changes", criteria: [], findings: [{ severity: "major", message: `aos.test-coding does not pass: '${ACL}'` }, { severity: "nit", message: "locale edge case" }] } });
    expect(reviewIsBaselineOnly(j)).toBe(true);
    const b = codingBlocker(j);
    expect(b.kind).toBe("review-baseline-only");
    expect(b.text).toContain("already fails on the base commit");
    expect(b.label).toBe("Retry review with the baseline");
    const mixed = baselineJob({ review: { sha: head, verdict: "request-changes", criteria: [], findings: [{ severity: "major", message: `fails: '${ACL}'` }, { severity: "major", message: "a is wrong" }] } });
    expect(reviewIsBaselineOnly(mixed)).toBe(false);
  });
  test("approved review with only pre-existing failures left offers to re-run the gate; no 'redacted' words anywhere", () => {
    const j = baselineJob({ review: { sha: head, verdict: "approve", criteria: [], findings: [] } });
    const b = codingBlocker(j);
    expect(b.kind).toBe("gate-baseline");
    expect(b.label).toBe("Re-run the done gate");
    expect(b.text).toContain("pre-existing");
    const gated = baselineJob({ review: { sha: head, verdict: "approve", criteria: [], findings: [] }, gate: { sha: head, passed: false, baselineFailures: [], checks: [{ check: "review-approved-for-sha", passed: false, detail: "verdict request-changes" }, { check: "done-when-evidenced", passed: false, detail: "no evidence for: c1" }] } });
    const text = codingPauseReason(gated);
    expect(text).toContain("an independent review approved this commit");
    expect(text).not.toContain("[redacted]");
    expect(redactText(text)).toBe(text);
    expect(gateCheckWords("review-approved-for-sha")).not.toMatch(/-/);
  });
  test("an exhausted or signed-out account reads as an unavailable reviewer, not a generic stop", () => {
    for (const message of ["claude:max is at its limit: Weekly window at 100%", "Claude Max 2 (claude:max-2) isn't signed in: expired. Nothing ran"]) {
      const j = fixture({ runs: [run("reviewer", "failed", message)] });
      expect(codingBlocker(j).kind).toBe("reviewer-unavailable");
    }
    expect(codingBlocker(fixture({ runs: [{ roleId: "builder-1", role: "builder", state: "failed", error: { message: "no commit on its branch" } }] }))).toMatchObject({ kind: "role-stopped", label: "Retry the build" });
  });
  test("review fix 3: a task that names the baseline-failing test is not 'only a baseline failure'", () => {
    const j = baselineJob({ spec: { objective: `Fix the failing test: ${ACL}`, repo: { baseSha: BASE }, roles: roles(["a.ts"]) }, review: { sha: head, verdict: "request-changes", criteria: [], findings: [{ severity: "major", message: `aos.test-coding does not pass: '${ACL}'` }] } });
    expect(reviewIsBaselineOnly(j)).toBe(false);
    expect(namesBaselineTest("tidy the copy", [ACL])).toBe(false);
  });
  test("review fix 4: file-keyed names compare by bare name in findings", () => {
    const keyed = `scripts/x.test.ts :: ${ACL}`;
    const j = baselineJob({ tests: [{ sha: BASE, failedTests: [keyed], baseline: null }, { sha: head, failedTests: [keyed], baseline: { sha: BASE, failedTests: [keyed] } }], review: { sha: head, verdict: "request-changes", criteria: [], findings: [{ severity: "major", message: `fails: '${ACL}'` }] } });
    expect(reviewIsBaselineOnly(j)).toBe(true);
    expect(codingBlocker(j).text).not.toContain("::");
  });
});

describe("plain wording for gate stops (2 Oct 2026)", () => {
  const gated = (checks: unknown[]) => fixture({ review: { sha: head, verdict: "approve", criteria: [], findings: [] }, gate: { sha: head, passed: false, baselineFailures: [], checks } });
  test("files outside what the builder owns are named, with what to do", () => {
    const b = codingBlocker(gated([{ check: "ownership", passed: false, detail: "outside ownership: lib/c.ts, src/b.ts" }]));
    expect(b.kind).toBe("gate-failed");
    expect(b.text).toContain("files the builder isn't allowed to change (lib/c.ts, src/b.ts)");
    expect(b.text).toContain("reverted, or the plan's file ownership widened");
    expect(b.text).not.toContain("outside ownership:");
  });
  test("failing tests say the tests don't pass and why, alongside any other gate wait", () => {
    const b = codingBlocker(gated([{ check: "checks-pass", passed: false, detail: "fx.test: 2 new failing test(s) not failing on the base sha" }, { check: "done-when-evidenced", passed: false, detail: "no evidence for: c1" }]));
    expect(b.text).toContain("The tests don't pass: fx.test: 2 new failing test(s)");
    expect(b.text).toContain("Also waiting on: every done-when criterion has evidence");
  });
  test("a single baseline test reads 'fails', several read 'fail'", () => {
    const names = (n: string[]) => fixture({ spec: { repo: { baseSha: "b".repeat(40) } }, tests: [{ sha: "b".repeat(40), failedTests: n, baseline: null }], review: { sha: head, verdict: "request-changes", criteria: [], findings: n.map((x) => ({ severity: "major", message: `fails: '${x}'` })) } });
    expect(codingBlocker(names(["first thing is slow"])).text).toContain("1 test that already fails on the base commit");
    expect(codingBlocker(names(["first thing is slow", "second thing is wrong"])).text).toContain("2 tests that already fail on the base commit");
  });
});
