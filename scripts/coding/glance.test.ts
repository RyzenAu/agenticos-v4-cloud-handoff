import { describe, expect, test } from "bun:test";
import type { CodingAccounts, CodingJob } from "../../src/lib/coding-client";
import { accountAvailable, bindingNow, finishedLines, glanceOf, nextLabel, reassignChoices, taskSentence } from "../../src/lib/coding-glance";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"];
const claude = (accountSlot: string, label: string, weekly: number, state: "connected" | "signed-out" = "connected") => ({
  accountSlot, label, installed: true, cliVersion: "2.1.286", models: MODELS, connection: { state, reason: null, subscription: "max", checkedAt: null },
  allowance: { windows: [{ label: "Session (5-hour)", usedPercent: 10, resetsAt: null }, { label: "Weekly · all models", usedPercent: weekly, resetsAt: null }], limitReached: weekly >= 100 },
});
const codex = { accountSlot: "codex:openai-2", installed: true, cliVersion: "0.159.0", plan: "chatgpt-plus", creditsAllowed: false, home: "default", reading: { peakPercent: 40, resetsAt: null }, models: ["gpt-6-astra"] };
const accounts = (isolation: "paused" | "protected" = "paused", weeklyMax = 100): CodingAccounts => ({
  accounts: [claude("claude:max", "Claude Max", weeklyMax), claude("claude:max-2", "Claude Max 2", 16), codex] as never,
  codexIsolation: { state: isolation, label: "", detail: "", approvedAt: null, protectedPaths: null },
});
const job = {
  state: "needs_owner", headSha: "a".repeat(40), runs: [], tests: [], review: null, gate: null,
  spec: { objective: "Build the creative project. Read the brief first. Own only three files.", roles: [
    { roleId: "builder-1", role: "builder", agent: { route: "claude-code-cli", accountSlot: "claude:max-2", model: "claude-opus-5-5" }, owns: { globs: [], newFiles: [] } },
    { roleId: "reviewer", role: "reviewer", agent: { route: "codex-app-server", accountSlot: "codex:openai-2", model: "gpt-6-astra" }, owns: { globs: [], newFiles: [] } },
  ] },
} as unknown as CodingJob;

describe("Coding job at a glance (synthetic)", () => {
  test("a Codex reviewer that can't run defaults to Claude Max 2 on a model different from the builder's", () => {
    const { options, defaultKey } = reassignChoices(job, "reviewer", accounts());
    expect(defaultKey).toBe("claude:max-2|claude-sonnet-5-5");
    // Only available accounts: Claude Max is at 100% weekly, Codex isolation is paused.
    expect(options.map((o) => o.accountSlot)).not.toContain("claude:max");
    expect(options.map((o) => o.accountSlot)).not.toContain("codex:openai-2");
    expect(options.every((o) => o.accountSlot === "claude:max-2")).toBe(true);
  });
  test("a reviewer is never offered the builder's own model", () => {
    const { options } = reassignChoices(job, "reviewer", accounts());
    expect(options.some((o) => o.model === "claude-opus-5-5")).toBe(false);
    expect(options.some((o) => o.model === "claude-sonnet-5-5")).toBe(true);
  });
  test("Codex joins the choices only once its isolation is protected and its plan has room; a signed-out Claude never does", () => {
    const protectedCodex = reassignChoices(job, "reviewer", accounts("protected"));
    expect(protectedCodex.options.map((o) => o.accountSlot)).toContain("codex:openai-2");
    expect(protectedCodex.defaultKey).toBe("codex:openai-2|gpt-6-astra");
    const signedOut = accounts();
    (signedOut.accounts[1] as { connection: { state: string } }).connection.state = "signed-out";
    expect(reassignChoices(job, "reviewer", signedOut).options).toHaveLength(0);
    expect(accountAvailable(signedOut.accounts[1], signedOut)).toBe(false);
  });
  test("the next button names the account the owner chose, and only when it moves", () => {
    const { options, defaultKey } = reassignChoices(job, "reviewer", accounts());
    const reviewJob = { ...job, runs: [{ roleId: "reviewer", role: "reviewer", state: "failed", error: { message: "Codex roles are paused: sandbox" } }] } as unknown as CodingJob;
    expect(nextLabel(reviewJob, options.find((o) => o.key === defaultKey)!)).toBe("Retry review on Claude Max 2");
    expect(nextLabel(reviewJob, null)).toBe("Retry review");
  });
  test("the glance answers the five questions from the job record alone", () => {
    const reviewJob = { ...job, runs: [{ roleId: "reviewer", role: "reviewer", state: "failed", error: { message: "Codex roles are paused: sandbox" } }] } as unknown as CodingJob;
    const g = glanceOf({ job: reviewJob, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "x" });
    expect(g.task).toBe("Build the creative project.");
    expect(g.roles.map((r) => [r.role, r.reported])).toEqual([["Builder", null], ["Reviewer", null]]);
    expect(g.blocker?.kind).toBe("reviewer-unavailable");
    expect(g.moveRole).toBe("reviewer");
    expect(taskSentence("x".repeat(400)).length).toBeLessThanOrEqual(201);
  });
  test("review fix 2: the reviewer is judged against the builder's latest run binding, not the plan's", () => {
    const moved = { ...job, runs: [{ roleId: "builder-1", role: "builder", state: "succeeded", binding: { route: "claude-code-cli", accountSlot: "claude:max-2", model: "claude-sonnet-5-5" } }] } as unknown as CodingJob;
    expect(bindingNow(moved, "builder-1")?.model).toBe("claude-sonnet-5-5");
    const { options, defaultKey } = reassignChoices(moved, "reviewer", accounts());
    expect(options.some((o) => o.model === "claude-sonnet-5-5")).toBe(false);
    expect(options.some((o) => o.model === "claude-opus-5-5")).toBe(true);
    expect(defaultKey).toBe("claude:max-2|claude-opus-5-5");
  });
});

describe("Done so far uses the counts the header shows (2 Oct 2026)", () => {
  const readable = (atHead: unknown, latest: unknown) => ({
    progress: { phases: [{ id: "building", status: "done" }, { id: "testing", status: "done" }], state: "needs_owner", runs: [] },
    diff: { totals: { files: 2 }, headShort: "abc1234" }, tests: { atHead, latest }, review: null,
  });
  const view = (r: unknown) => ({ job, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "x", readable: r }) as never;
  test("totals across the runs at the head, never a question mark", () => {
    const lines = finishedLines(view(readable({ runs: 2, passed: 346, failed: 1, allExitZero: false, counted: true }, { passed: null, failed: null, exitCode: 1 })));
    expect(lines).toContain("Tests at that commit: 346 passed, 1 failed.");
    expect(lines.join(" ")).not.toContain("?");
  });
  test("a run that reported no counts says so instead of printing question marks", () => {
    const lines = finishedLines(view(readable({ runs: 1, passed: 0, failed: 0, allExitZero: true, counted: false }, { passed: null, failed: null, exitCode: 0 })));
    expect(lines).toContain("Tests ran at that commit and passed; the run did not report counts.");
  });
});

describe("Done so far when the only tests are from an earlier commit", () => {
  test("it says so and shows those counts instead of claiming the current commit was tested", () => {
    const r = { progress: { phases: [{ id: "building", status: "done" }, { id: "testing", status: "done" }], state: "needs_owner", runs: [] }, diff: null, tests: { atHead: null, latest: { passed: 340, failed: 2, exitCode: 1, matchesHead: false } }, review: null };
    const lines = finishedLines({ job, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "x", readable: r } as never);
    expect(lines).toContain("Tests are from an earlier commit, not this one: 340 passed, 2 failed.");
    expect(lines.join(" ")).not.toContain("at that commit");
  });
});
