// A coding job as the workspace lists it, and the coding accounts' real readiness.
import { describe, expect, test } from "bun:test";
import { codingFileOf, codingTaskOf, receiptsOf } from "./coding-view";
import { accountFacts, anyAccountFacts, modelsForSlot, slotsOf, type AccountsView } from "./accounts";
import { ACCOUNTS, fakeCodingJob, usageEvent } from "./test-rig";

describe("codingTaskOf", () => {
  test("a drafted plan waits for the person; a running job has no blocker; a finished one has an end time", () => {
    const draft = codingTaskOf(fakeCodingJob({ id: "a1111111-1111-4111-8111-111111111111", state: "awaiting_confirmation" }), []);
    expect(draft).toMatchObject({ phase: "waiting", state: "awaiting_confirmation", endedAt: null });
    expect(draft.blocker).toContain("Waiting for you to start it");
    const running = codingTaskOf(fakeCodingJob({ id: "a2222222-2222-4222-8222-222222222222", state: "building" }), []);
    expect(running).toMatchObject({ phase: "running", endedAt: null });
    expect(running.blocker).toBeUndefined();
    const done = codingTaskOf(fakeCodingJob({ id: "a3333333-3333-4333-8333-333333333333", state: "completed", head: "abc" }), []);
    expect(done).toMatchObject({ phase: "done", commit: "abc" });
    expect(typeof done.endedAt).toBe("number");
  });

  test("a job that needs its owner carries the coding page's own one-sentence blocker, in the task row", () => {
    const t = codingTaskOf(fakeCodingJob({ id: "a4444444-4444-4444-8444-444444444444", state: "needs_owner" }), []);
    expect(t).toMatchObject({ phase: "waiting", state: "needs_owner" });
    expect(typeof t.blocker).toBe("string");
    expect(t.blocker!.length).toBeGreaterThan(10);
  });

  test("receipts: the account and model that ACTUALLY ran (the provider's name for the model), once each, with the role", () => {
    const r = receiptsOf([usageEvent("claude:max-2", "claude-opus-5-5"), usageEvent("claude:max-2", "claude-opus-5-5"), usageEvent("codex:openai-2", "gpt-6-astra", "coding.review"), { type: "step", payload: {} }]);
    expect(r).toEqual([{ account: "claude:max-2", model: "claude-opus-5-5", role: "builder" }, { account: "codex:openai-2", model: "gpt-6-astra", role: "reviewer" }]);
  });

  test("tests count the newest run of each command (an older failing attempt doesn't hide a fix)", () => {
    const job = fakeCodingJob({ id: "a5555555-5555-4555-8555-555555555555", state: "completed", tests: [{ commandId: "unit", passed: 3, failed: 2, exitCode: 1 }, { commandId: "unit", passed: 5, failed: 0, exitCode: 0 }, { commandId: "types", passed: 1, failed: 0, exitCode: 0 }] });
    expect(codingTaskOf(job, []).tests).toEqual({ passed: 6, failed: 0 });
  });

  test("a files row exists only for a job that produced something", () => {
    expect(codingFileOf(fakeCodingJob({ id: "a6666666-6666-4666-8666-666666666666", state: "building" }), [])).toBeNull();
    const f = codingFileOf(fakeCodingJob({ id: "a7777777-7777-4777-8777-777777777777", state: "completed", head: "abc", files: [{ path: "x.ts", status: "added" }] }), [usageEvent("claude:max", "claude-sonnet-5-5")], ["crm:deal:1"]);
    expect(f).toMatchObject({ artifact: "coding:a7777777-7777-4777-8777-777777777777", commit: "abc", subjects: ["crm:deal:1"], files: [{ name: "x.ts", status: "added" }] });
  });
});

describe("the coding accounts' readiness", () => {
  const view = (patch: { claude?: Record<string, boolean | null>; claudeCli?: string | null; codexCli?: string | null; isolation?: boolean }): AccountsView => ({
    accounts: () => ACCOUNTS,
    cliVersions: () => ({ claude: patch.claudeCli === undefined ? "2.1.280" : patch.claudeCli, codex: patch.codexCli === undefined ? "0.154.0" : patch.codexCli }),
    claudeStatus: { current: () => ACCOUNTS.claude.map((c) => ({ slot: c.slot, connected: (patch.claude ?? {})[c.slot] ?? null, reason: (patch.claude ?? {})[c.slot] === false ? "not signed in on this profile" : null, subscription: null, checkedAt: null, sameAccountAs: null })), refresh: async () => undefined },
    codexIsolationApproval: () => (patch.isolation === false ? null : ({ version: 1, group: "g", paths: [], approvedAt: "2026-10-01T00:00:00Z" } as never)),
  });

  test("Claude: connected is ready; signed out is not, with the status' own reason; not checked is unknown, never ready", () => {
    const v = view({ claude: { "claude:max": true, "claude:max-2": false } });
    expect(accountFacts(v, "claude:max")).toMatchObject({ ready: true, label: "Claude Max" });
    expect(accountFacts(v, "claude:max-2")).toEqual({ ready: false, label: "Claude Max 2", reason: "not signed in on this profile" });
    expect(accountFacts(view({}), "claude:max")).toMatchObject({ ready: null });
    expect(accountFacts(view({ claudeCli: null, claude: { "claude:max": true } }), "claude:max")).toMatchObject({ ready: false, reason: expect.stringContaining("isn't installed") });
  });

  test("Codex: not ready until its sandbox isolation is applied; ready once it is", () => {
    expect(accountFacts(view({ isolation: false }), "codex:openai-2")).toMatchObject({ ready: false, reason: expect.stringContaining("isolation") });
    expect(accountFacts(view({}), "codex:openai-2")).toMatchObject({ ready: true });
    expect(accountFacts(view({ codexCli: null }), "codex:openai-2")).toMatchObject({ ready: false });
  });

  test("an unknown slot is not an account; the automatic pick is ready if any account is, unknown if none is but some are unchecked", () => {
    expect(accountFacts(view({}), "claude:max-9")).toMatchObject({ ready: false, reason: "it isn't a configured coding account" });
    expect(anyAccountFacts(view({ claude: { "claude:max": true } })).ready).toBe(true);
    expect(anyAccountFacts(view({ claude: { "claude:max": false, "claude:max-2": false }, isolation: false })).ready).toBe(false);
    expect(anyAccountFacts(view({ claude: { "claude:max": false }, isolation: false })).ready).toBe(null);
  });

  test("the slots and the models each runs", () => {
    expect(slotsOf(ACCOUNTS)).toEqual(["claude:max", "claude:max-2", "codex:openai-2"]);
    expect(modelsForSlot("claude:max-2")).toContain("claude-opus-5-5");
    expect(modelsForSlot("codex:openai-2")).toContain("gpt-6-astra");
    expect(modelsForSlot("other")).toEqual([]);
  });
});
