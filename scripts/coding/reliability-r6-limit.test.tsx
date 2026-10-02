// Round 6, items 8 and 14: a role paused at its account's limit gets one plain sentence and a way forward that never
// offers the exhausted account again (found on the real test hub: the page offered Fable and Haiku on the account that
// had just hit its weekly limit, because that account's usage reading was unknown).
import { describe, expect, test } from "bun:test";
import { codingBlocker, codingResumeLabel, readableTimes } from "./pause-reason";
import { modelsUsed, unreceiptedRuns } from "./receipts";
import { glanceOf, limitedSlots, reassignChoices } from "../../src/lib/coding-glance";

const sha = "a".repeat(40);
const RESET = "2026-10-05T02:00:00.000Z";
const binding = (slot: string, model: string) => ({ provider: "anthropic", route: "claude-code-cli", accountSlot: slot, model, cliVersion: "2.1.286" });
const blockedJob = (extra: Record<string, unknown> = {}) => ({
  id: "j", state: "blocked_allowance", headSha: null, review: null, gate: null, tests: [], diff: null, applies: [],
  spec: { objective: "Do x", doneWhen: [], repo: { baseSha: sha }, roles: [{ roleId: "builder-1", role: "builder", agent: binding("claude:max", "claude-sonnet-5-5") }, { roleId: "reviewer", role: "reviewer", agent: binding("claude:max", "claude-opus-5-5") }] },
  runs: [{ roleId: "builder-1", role: "builder", state: "blocked_allowance", binding: binding("claude:max", "claude-sonnet-5-5"), history: [], error: { code: "limit_reached", message: `Claude's weekly window is at 100%, resetting ${RESET}. The role stopped before the limit.` } }],
  ...extra,
}) as never;
const account = (slot: string, models: string[]) => ({ accountSlot: slot, installed: true, label: slot, connection: { state: "connected" }, allowance: null, models }) as never;
const accounts = (slots: string[]) => ({ accounts: slots.map((s) => account(s, ["claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5"])), codexIsolation: null }) as never;

describe("a builder paused at its account's limit", () => {
  test("the blocker says what is blocked, why with the reset time as a person would say it, and the one way forward", () => {
    const b = codingBlocker(blockedJob());
    expect(b.kind).toBe("role-limit");
    expect(b.text).toContain("The builder can't run: Claude's weekly window is at 100%, resetting ");
    expect(b.text).not.toContain("2026-10-05T02:00");
    expect(b.text).not.toContain("The role stopped before the limit");
    expect(b.text).toMatch(/Move this step to another connected account, or Resume after the reset\.$/);
    expect(b.roleId).toBe("builder-1");
  });
  test("the exhausted account is never offered again, on any model; another connected account is", () => {
    const job = blockedJob();
    const now = Date.parse(RESET) - 3_600_000;
    expect([...limitedSlots(job, now)]).toEqual(["claude:max"]);
    const only = reassignChoices(job, "builder-1", accounts(["claude:max"]), now);
    expect(only.options).toEqual([]); // so the page says no account can run it right now
    const two = reassignChoices(job, "builder-1", accounts(["claude:max", "claude:max-2"]), now);
    expect(two.options.length).toBeGreaterThan(0);
    expect(two.options.every((o) => o.accountSlot === "claude:max-2")).toBe(true);
    expect(two.options.find((o) => o.key === two.defaultKey)?.model).toBe("claude-sonnet-5-5");
  });
  test("once the window has reset the account is offered again", () => {
    const job = blockedJob();
    const after = Date.parse(RESET) + 60_000;
    expect(limitedSlots(job, after).size).toBe(0);
    expect(reassignChoices(job, "builder-1", accounts(["claude:max"]), after).options.length).toBeGreaterThan(0);
  });
  test("the limit is the account's: a later failed attempt on another account does not make the exhausted one look usable", () => {
    const job = blockedJob({ state: "needs_owner", runs: [...(blockedJob() as { runs: unknown[] }).runs, { roleId: "builder-1", role: "builder", state: "failed", binding: binding("claude:max-2", "claude-sonnet-5-5"), history: [], error: { code: "unknown", message: "boom" } }] });
    const now = Date.parse(RESET) - 3_600_000;
    const slots = reassignChoices(job, "builder-1", accounts(["claude:max", "claude:max-2"]), now).options.map((o) => o.accountSlot);
    expect(new Set(slots)).toEqual(new Set(["claude:max-2"]));
  });
  test("a resumed run keeps one record, so the exhausted account is also read from the job's own log", () => {
    const moved = blockedJob({ state: "needs_owner", runs: [{ roleId: "builder-1", role: "builder", state: "failed", binding: binding("claude:max-2", "claude-sonnet-5-5"), history: [], error: { code: "unknown", message: "boom" } }] });
    const events = [{ type: "step", payload: { label: "Account at its limit: claude:max", detail: `Claude's weekly window is at 100%, resetting ${RESET}.` } }];
    const now = Date.parse(RESET) - 3_600_000;
    expect(new Set(reassignChoices(moved, "builder-1", accounts(["claude:max", "claude:max-2"]), now).options.map((o) => o.accountSlot))).toEqual(new Set(["claude:max", "claude:max-2"]));
    expect(new Set(reassignChoices(moved, "builder-1", accounts(["claude:max", "claude:max-2"]), now, events).options.map((o) => o.accountSlot))).toEqual(new Set(["claude:max-2"]));
    expect(new Set(reassignChoices(moved, "builder-1", accounts(["claude:max", "claude:max-2"]), Date.parse(RESET) + 1, events).options.map((o) => o.accountSlot))).toEqual(new Set(["claude:max", "claude:max-2"]));
  });
  test("a role that did not hit a limit is unaffected", () => {
    const job = blockedJob({ state: "needs_owner", runs: [{ roleId: "builder-1", role: "builder", state: "failed", binding: binding("claude:max", "claude-sonnet-5-5"), history: [], error: { code: "postcheck_failed", message: "no commit on its branch" } }] });
    expect(limitedSlots(job).size).toBe(0);
    expect(reassignChoices(job, "builder-1", accounts(["claude:max"])).options.length).toBeGreaterThan(0);
  });
  test("the page's glance names the role to move and carries the sentence", () => {
    const g = glanceOf({ job: blockedJob(), readable: null, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "x" } as never);
    expect(g.moveRole).toBe("builder-1");
    expect(g.blocker?.kind).toBe("role-limit");
  });
  test("the next button names where the paused role goes; staying put is a plain Resume after the reset", () => {
    const job = blockedJob();
    expect(codingResumeLabel(job, "Claude Max 2")).toBe("Retry the build on Claude Max 2");
    expect(codingResumeLabel(job, null)).toBe("Resume");
    const reviewer = blockedJob({ runs: [{ roleId: "reviewer", role: "reviewer", state: "blocked_allowance", binding: binding("claude:max", "claude-opus-5-5"), history: [], error: { code: "limit_reached", message: `Claude's weekly window is at 100%, resetting ${RESET}.` } }] });
    expect(codingResumeLabel(reviewer, "Claude Max 2")).toBe("Retry review on Claude Max 2");
    expect(codingResumeLabel({ ...(job as object), state: "interrupted" } as never, "Claude Max 2")).toBe("Resume");
  });
  test("times inside a message read as a date and a time, and a bare sentence is untouched", () => {
    expect(readableTimes(`resetting ${RESET}.`)).toMatch(/resetting \w{3}, 5 Oct, \d{1,2}:\d{2}\s?[ap]m\./i);
    expect(readableTimes("nothing to change here")).toBe("nothing to change here");
  });
});

describe("a turn the CLI could not complete says why (real failure seen on the test hub, 2 Oct)", () => {
  const real = "Claude did not complete this turn (success Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again). Its native session is kept for inspection.";
  test("a lost sign-in refresh reads as a transient clash with the way out, not as 'did not complete this turn'", () => {
    const b = codingBlocker(blockedJob({ state: "needs_owner", runs: [{ roleId: "builder-1", role: "builder", state: "failed", binding: binding("claude:max-2", "claude-sonnet-5-5"), history: [], error: { code: "unknown", message: real } }] }));
    expect(b.kind).toBe("role-stopped");
    expect(b.text).toContain("another Claude Code process was refreshing it at the same time");
    expect(b.text).toContain("usually transient");
    expect(b.text).toContain("Retrying runs only this step");
    expect(b.label).toBe("Retry the build");
  });
  test("any other 'did not complete' keeps its cause instead of dropping the parenthesis", () => {
    const b = codingBlocker(blockedJob({ state: "needs_owner", runs: [{ roleId: "builder-1", role: "builder", state: "failed", binding: binding("claude:max", "claude-sonnet-5-5"), history: [], error: { code: "unknown", message: "Claude did not complete this turn (error_max_turns after 80 turns without a final answer). Its native session is kept for inspection." } }] }));
    expect(b.text).toContain("Claude did not complete this turn: error_max_turns after 80 turns without a final answer");
    expect(b.text).not.toContain("native session");
  });
});

describe("item 6: each receipt belongs to its own run (found on the real hub: two runs of one role shared turn numbers)", () => {
  const run = (id: string, state: string, attempt: number, slot: string) => ({ id, roleId: "builder-1", role: "builder", state, attempt, binding: binding(slot, "claude-sonnet-5-5") });
  const receipt = (runId: string | undefined, turn: number, account: string, model: string, outcome: string) => ({ type: "usage", roleId: "builder-1", payload: { model, account, outcome, usage: { inputTokens: 1, outputTokens: 1 }, cost: { usd: null, basis: "subscription_allowance" }, coding: { roleId: "builder-1", turn, ...(runId ? { runId } : {}) } } });
  const events = [
    receipt("run-a", 1, "claude:max", "claude-sonnet-5-5", "rate_limited"),
    receipt("run-a", 2, "claude:max-2", "claude-sonnet-5-5", "failed"),
    receipt("run-b", 2, "claude:max-2", "claude-haiku-4-5", "succeeded"), // run-b's first turn died with the hub: no receipt for it
  ] as never;
  test("run B's turns read from run B's receipts: its first turn (killed with the hub) has none, its second shows the model that answered", () => {
    const rows = modelsUsed([run("run-a", "failed", 2, "claude:max-2"), run("run-b", "succeeded", 2, "claude:max-2")] as never, events);
    expect(rows.map((r) => [r.attempt, r.hasReceipt, r.actual, r.account])).toEqual([
      [1, true, "claude-sonnet-5-5", "claude:max"],
      [2, true, "claude-sonnet-5-5", "claude:max-2"],
      [1, false, null, null],
      [2, true, "claude-haiku-4-5", "claude:max-2"],
    ]);
  });
  test("a finished run whose own receipt is missing is not covered by another run's receipt for the same turn number", () => {
    const only = [receipt("run-a", 2, "claude:max-2", "claude-sonnet-5-5", "failed")] as never;
    expect(unreceiptedRuns([run("run-b", "succeeded", 2, "claude:max-2")] as never, only)).toEqual(["builder-1 (attempt 2)"]);
    expect(unreceiptedRuns([run("run-a", "succeeded", 2, "claude:max-2")] as never, only)).toEqual([]);
  });
  test("receipts written before round 6 (no run id) still match by role and turn", () => {
    const legacy = [receipt(undefined, 1, "claude:max", "claude-opus-5-5", "succeeded")] as never;
    expect(modelsUsed([run("run-a", "succeeded", 1, "claude:max")] as never, legacy)[0]).toMatchObject({ hasReceipt: true, actual: "claude-opus-5-5" });
    expect(unreceiptedRuns([run("run-a", "succeeded", 1, "claude:max")] as never, legacy)).toEqual([]);
  });
});

describe("item 12 in the blocker: a review that wants fixes says which test fails and what it asserted", () => {
  const failedRun = (sha: string) => ({ commandId: "r6.test", argv: ["bun", "test"], sha, ranBy: "orchestrator", exitCode: 1, timedOut: false, counts: { passed: 0, failed: 2, skipped: null }, failedTests: ["src/greet.test.ts :: greeting says hello", "src/greet.test.ts :: other"], failures: [{ name: "src/greet.test.ts :: greeting says hello", assertion: "expect(received).toBe(expected) · Expected: \"hello\" · Received: \"hello world\"" }, { name: "src/greet.test.ts :: other", assertion: null }], output: "a-x", baseline: null, durationMs: 5 });
  const job = (extra: Record<string, unknown> = {}) => ({
    id: "j", state: "needs_owner", headSha: "c".repeat(40), diff: null, gate: null, applies: [], runs: [],
    tests: [failedRun("c".repeat(40))],
    review: { sha: "c".repeat(40), verdict: "request-changes", findings: [{ id: "f1", severity: "blocker", file: null, line: null, message: "criterion not met", status: "open" }], criteria: [] },
    spec: { objective: "Do x", doneWhen: [], repo: { baseSha: "b".repeat(40) }, roles: [{ roleId: "builder-1", role: "builder", agent: binding("claude:max-2", "claude-sonnet-5-5"), owns: { globs: ["src/greet.ts"], newFiles: [] } }] },
    ...extra,
  }) as never;
  test("name, assertion and the count of the rest are in the sentence", () => {
    const b = codingBlocker(job());
    expect(b.kind).toBe("review-changes");
    expect(b.text).toContain("Review needs fixes (1 serious finding) and the tests fail at this commit: greeting says hello: expect(received).toBe(expected)");
    expect(b.text).toContain("Received: \"hello world\"");
    expect(b.text).toContain(", and 1 more");
    expect(b.text).toMatch(/Resume sends them back to the builder\.$/);
  });
  test("tests that passed, or failed at an older commit, add nothing", () => {
    expect(codingBlocker(job({ tests: [{ ...(failedRun("c".repeat(40)) as object), exitCode: 0 }] })).text).toBe("Review needs fixes (1 serious finding). Resume sends them back to the builder.");
    expect(codingBlocker(job({ tests: [failedRun("d".repeat(40))] })).text).toBe("Review needs fixes (1 serious finding). Resume sends them back to the builder.");
  });
});
