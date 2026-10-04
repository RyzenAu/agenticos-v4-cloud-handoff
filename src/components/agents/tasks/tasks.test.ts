// Round 7: a coding job in Tasks gets the job page's own next step (never a plain Resume that stops in the same place), says why it
// stopped, and a finished job links to its branch, tests and review. Pure functions over synthetic jobs.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import type { CodingJob } from "@/lib/coding-client";
import { codingBlockerAction, codingLinks, codingTask, computerTask, fileHref, resultButtonText, serviceFiles, serviceTask } from "./tasks";

const at = "2026-10-03T00:00:00.000Z";
const binding = { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max", model: "claude-opus-5-5", cliVersion: "2.1.280" };
const run = (o: Record<string, unknown> = {}) => ({ id: "r1", jobId: "x", roleId: "builder-1", role: "builder", binding, state: "failed", nativeSessionId: null, worktree: { branch: "b", headAtStart: "a", detached: false }, attempt: 1, startedAt: at, endedAt: at, lastSeq: 1, pendingInput: null, resultSha: null, history: [], error: null, ...o });
function job(o: Partial<CodingJob> & { state: CodingJob["state"] }): CodingJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    spec: { objective: "Fix the booking form", roles: [{ roleId: "builder-1", role: "builder", agent: binding }], doneWhen: [], nonGoals: [], checks: [], repo: { repoId: "app", baseSha: "b".repeat(40), jobBranch: "coding/app-111111" } },
    runs: [], headSha: "c".repeat(40) as never, diff: null, tests: [], review: null, gate: null, applies: [], executorDevice: "usman-pc", createdAt: at, updatedAt: at, lastSeq: 3, ...o,
  } as unknown as CodingJob;
}

describe("the one control a stopped coding job gets in Tasks", () => {
  test("a builder at its account's limit: Tasks sends you to move it, and still offers Resume for after the reset (a plain Resume stopped in the same place at once)", () => {
    const limited = job({ state: "blocked_allowance", runs: [run({ state: "blocked_allowance", error: { code: "limit_reached", message: "Claude hit its usage limit." } })] as never });
    expect(codingBlockerAction(limited)).toEqual({ kind: "link", href: `/coding/${limited.id}`, label: "Choose another account" });
    const t = codingTask(limited, null);
    expect(t.blocker?.action?.kind).toBe("link");
    expect(t.blocker?.text).toMatch(/can't run/);
    expect(t.can.resume).toBe(true);
  });

  test("a signed-out reviewer is an account problem; a failing test is not", () => {
    const reviewer = { ...run({ roleId: "reviewer", role: "reviewer", state: "failed", error: { code: "signed_out", message: "Claude Max (claude:max) isn't signed in." } }) };
    const signedOut = job({ state: "needs_owner", runs: [reviewer] as never });
    expect(codingBlockerAction(signedOut)?.kind).toBe("link");
    const failing = job({
      state: "needs_owner", headSha: "c".repeat(40) as never,
      spec: { objective: "x", roles: [{ roleId: "builder-1", role: "builder", agent: binding }], doneWhen: [], nonGoals: [], checks: ["unit"], repo: { repoId: "app", baseSha: "b".repeat(40), jobBranch: "coding/app-111111" } } as never,
      tests: [{ commandId: "unit", sha: "c".repeat(40), exitCode: 1, timedOut: false, counts: { passed: 0, failed: 1 }, failedTests: ["a"], ranBy: "orchestrator", baseline: null }] as never,
      review: { verdict: "approve", sha: "c".repeat(40), findings: [], criteria: [], binding } as never,
      gate: { sha: "c".repeat(40), passed: false, checks: [{ check: "checks-pass", passed: false, detail: "unit: exit 1 with no baseline recorded on the base sha" }] } as never,
      runs: [run({ state: "succeeded" })] as never,
    });
    expect(codingBlockerAction(failing)).toEqual({ kind: "resume", label: "Fix the failing tests" });
    expect(codingTask(failing, null).blocker?.text).toMatch(/tests don't pass/);
  });

  test("a job that never got ready: its reason, and one button that starts it again", () => {
    const stopped = job({ state: "needs_owner", headSha: null, stoppedBecause: { code: "prepare_failed", message: "The repo's git config now runs programs.", at } as never });
    const t = codingTask(stopped, null);
    expect(t.blocker?.text).toMatch(/couldn't get ready to start: The repo's git config now runs programs\. No agent ran/);
    expect(t.blocker?.action).toEqual({ kind: "resume", label: "Start it again" });
  });

  test("a job a restart interrupted says what was happening", () => {
    const stopped = job({ state: "interrupted", stoppedBecause: { code: "restart", message: "The hub restarted while the tests were running. Nothing was replayed.", at } as never });
    const t = codingTask(stopped, null);
    expect(t.blocker?.text).toMatch(/hub restarted while the tests were running.*Resume continues/s);
    expect(t.blocker?.action).toEqual({ kind: "resume", label: "Resume" });
  });
});

describe("finished work is reachable and reads as finished", () => {
  const done = job({
    state: "completed", headSha: "d".repeat(40) as never,
    diff: { files: [{ path: "src/a.ts" }] } as never,
    tests: [{ commandId: "unit", sha: "d".repeat(40), exitCode: 0, counts: { passed: 3, failed: 0, skipped: 0 } }] as never,
    review: { verdict: "approve", sha: "d".repeat(40), findings: [], criteria: [], binding } as never,
    gate: { passed: true, sha: "d".repeat(40), checks: [] } as never,
  });
  test("a verified job names its branch, links the changes, tests and review, and says nothing is merged until asked", () => {
    const t = codingTask(done, null);
    expect(t.state).toBe("finished");
    expect(t.outcomeNote).toMatch(/Done and checked at ddddddd.*coding\/app-111111.*nothing is merged until you say so/);
    expect(t.links.map((l) => l.href)).toEqual([`/coding/${done.id}?tab=changes`, `/coding/${done.id}?tab=tests`, `/coding/${done.id}?tab=review`]);
    expect(t.links[0].label).toBe("Changes on coding/app-111111");
    expect(t.result?.href).toBe(`/coding/${done.id}?tab=changes`);
  });
  test("only what exists is linked", () => {
    expect(codingLinks(job({ state: "needs_owner", headSha: null }))).toEqual([]);
    expect(codingLinks(job({ state: "needs_owner", tests: [{}] as never })).map((l) => l.label)).toEqual(["Changes on coding/app-111111", "Test results"]);
  });
  test("a job that ended without a passed gate never reads as finished", () => {
    const t = codingTask(job({ state: "completed", gate: null }), null);
    expect(t.state).toBe("unknown");
    expect(t.outcomeNote).toMatch(/final check did not pass/);
  });
});

describe("rows from the agents service for a coding job (the shape the live hub sent on 3 Oct: it read 'Ended, nothing to show' for a finished, verified job)", () => {
  const row = {
    id: "20e9c2f8-7372-4f12-8449-2fbf0d21c9df", kind: "coding", title: "Greeting with an exclamation mark", state: "completed", phase: "done",
    startedAt: Date.parse("2026-10-03T00:00:00.000Z"), endedAt: Date.parse("2026-10-03T00:05:00.000Z"), account: "claude:max-2", model: "claude-opus-5-5",
    review: { verdict: "approve", blockers: 0, majors: 0, minors: 0 }, tests: { passed: 2, failed: 0 }, branch: "coding/r7-app-20e9c2", commit: "cefc155f6ef2fc14df53cf391a57679a0a5d3a81",
    receipts: [{ account: "claude:max-2", model: "claude-sonnet-5-5", role: "builder" }, { account: "claude:max-2", model: "claude-opus-5-5", role: "reviewer" }],
  };
  test("a completed coding row is finished, with its result, times, what ran for each role, review, tests, branch and links", () => {
    const t = serviceTask(row)!;
    expect(t.state).toBe("finished");
    expect(t.stateWord).toBe("Finished");
    expect(t.result).toEqual({ href: `/coding/${row.id}?tab=changes`, label: "Open result", external: false });
    expect(t.startedAt).toBe("2026-10-03T00:00:00.000Z");
    expect(t.endedAt).toBe("2026-10-03T00:05:00.000Z");
    expect(t.ran).toEqual({ text: "Builder: Claude Max 2 · Claude Sonnet 5.5; Reviewer: Claude Max 2 · Claude Opus 5.5", used: true });
    expect(t.review).toBe("Approved");
    expect(t.tests).toBe("2 passed, none failed");
    expect(t.outcomeNote).toMatch(/^Finished · commit cefc155\. The work is on coding\/r7-app-20e9c2; the job page shows whether it has been merged\.$/);
    expect(t.outcomeNote).not.toMatch(/checked|final-check|done-gate/);
    expect(t.links.map((l) => l.href)).toEqual([`/coding/${row.id}?tab=changes`, `/coding/${row.id}?tab=tests`, `/coding/${row.id}?tab=review`]);
  });
  test("a coding state the list had no word for is read from its phase and the job page's own words, never 'Outcome not known'", () => {
    expect(serviceTask({ ...row, state: "building", phase: "running" })).toMatchObject({ state: "working", stateWord: "Building" });
    expect(serviceTask({ ...row, state: "blocked_allowance", phase: "waiting" })).toMatchObject({ state: "needs-you", stateWord: "Paused at an account limit" });
    expect(serviceTask({ ...row, state: "awaiting_approval", phase: "waiting" })).toMatchObject({ state: "needs-you", stateWord: "Waiting for approval (not merged)" });
    expect(serviceTask({ ...row, state: "testing", phase: "running", review: undefined })!.review).toBeNull();
  });
  test("a coding job's saved-file row opens the job (no computer artefact, no '0 B', no download that cannot work)", () => {
    const [file] = serviceFiles([{ artifact: `coding:${row.id}`, title: "Greeting", jobId: row.id, createdAt: Date.parse("2026-10-03T00:05:00.000Z"), source: "coding", files: [{ name: "greeting.ts", bytes: null, status: "modified" }], branch: row.branch, commit: row.commit, review: row.review, tests: row.tests }]);
    expect(file.files).toEqual([]);
    expect(file.createdAt).toBe("2026-10-03T00:05:00.000Z");
    expect(file.coding).toEqual({ jobId: row.id, branch: "coding/r7-app-20e9c2", commit: row.commit, review: "Approved", tests: "2 passed, none failed", files: [{ name: "greeting.ts", status: "modified" }] });
  });
});

describe("a finished computer job with no saved copy says why, and downloads use ?download=1", () => {
  const summary = (note?: string) => ({ id: "22222222-2222-4222-8222-222222222222", kind: "control", principal: { personId: "usman" }, targetDeviceId: "dev-research", state: "succeeded", title: "Research three sites", cancelRequested: false, quarantined: false, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:05:00.000Z", stepCount: 3, lastStep: { seq: 3, at: 1, intent: "wrote note", executor: "file.write", ms: 5, outcome: "ok" }, ...(note ? { note } : {}) }) as never;
  test("the job's own note replaces the generic line; with no note the generic line stays", () => {
    expect(computerTask(summary("Partial: the result could not be kept as a saved result."), {}).outcomeNote).toBe("Partial: the result could not be kept as a saved result.");
    expect(computerTask(summary(), {}).outcomeNote).toBe("No saved result: it did its steps on the computer only.");
  });
  test("fileHref builds the download address with ?download=1 and the page address without", () => {
    expect(fileHref("abc", "report one.md", true)).toBe("/__computers/artifacts/abc/f/report%20one.md?download=1");
    expect(fileHref("abc", "report one.md")).toBe("/__computers/artifacts/abc/f/report%20one.md");
    expect(fileHref("abc")).toBe("/__computers/artifacts/abc");
  });
});

describe("review findings 6 and 7: honest finished notes and an accept control that shows what it accepts", () => {
  const head = "d".repeat(40);
  const finished = (over: Record<string, unknown> = {}) => job({ state: "completed", headSha: head as never, gate: { passed: true, sha: head, checks: [] } as never, applies: [], ...over });
  test("an unmerged verified job says nothing is merged; a merged one names the merge", () => {
    expect(codingTask(finished(), null).outcomeNote).toMatch(/Done and checked at ddddddd.*nothing is merged until you say so/);
    const merged = finished({ applies: [{ state: "succeeded", action: "git.merge.protected", toRef: "main", verification: { observed: "e".repeat(40) } }] as never });
    const note = codingTask(merged, null).outcomeNote!;
    expect(note).toMatch(/Merged into main \(eeeeeee\)/);
    expect(note).not.toMatch(/nothing is merged/);
  });
  test("a gate that passed for an OLDER head is not 'verified'", () => {
    const stale = finished({ gate: { passed: true, sha: "a".repeat(40), checks: [] } as never });
    const t = codingTask(stale, null);
    expect(t.state).toBe("unknown");
    expect(t.outcomeNote).toMatch(/final check did not pass/);
  });
  test("accepting a checkout change carries the moved paths on the control", () => {
    const stopped = job({ state: "needs_owner", runs: [run({ state: "failed", error: { code: "policy_violation", message: "A checkout this job must not touch changed while it ran (the live OS checkout: docs/a.md, src/b.ts)." } })] as never });
    expect(codingBlockerAction(stopped)).toEqual({ kind: "resume", label: "Accept the change and retry", accept: true, detail: "the live OS checkout: docs/a.md, src/b.ts" });
    expect(codingTask(stopped, null).blocker?.text).toMatch(/your change|an agent's/);
  });
});

describe("the result button's words", () => {
  test("a label is never joined to itself", () => {
    expect(resultButtonText("Open result")).toBe("Open result");
    expect(resultButtonText("Saved result")).toBe("Open result");
    expect(resultButtonText("Canberra report")).toBe("Open result: Canberra report");
  });
});

describe("audit 1, F-14: one honest card for each coding row from the service", () => {
  const base = { id: "11111111-1111-4111-8111-111111111111", kind: "coding", title: "Fix the form", startedAt: Date.parse("2026-10-03T00:00:00.000Z"), endedAt: null, account: "claude:max-2", model: "claude-opus-5-5" };
  test("a job that has not been started: no start time, nothing to resume, and one way in (Open the job to start it)", () => {
    const t = serviceTask({ ...base, state: "awaiting_confirmation", phase: "waiting", blocker: "Waiting for you to start it (the plan is drafted, nothing has run)." })!;
    expect(t.notStarted).toBe(true);
    expect(t.can.resume).toBe(false);
    expect(t.blocker?.action).toEqual({ kind: "link", href: `/coding/${base.id}`, label: "Open the job to start it" });
    expect(t.links).toEqual([]);
  });
  test("a finished job prints a commit as a commit, with one set of links and no jargon", () => {
    const t = serviceTask({ ...base, state: "completed", phase: "done", endedAt: base.startedAt + 60_000, branch: "coding/x", commit: "0202020202020202020202020202020202020202", tests: { passed: 1, failed: 0 } })!;
    expect(t.outcomeNote).toBe("Finished · commit 0202020. The work is on coding/x; the job page shows whether it has been merged.");
    expect(t.links.map((l) => l.label)).toEqual(["Changes on coding/x", "Test results"]);
    expect(t.outcomeNote).not.toMatch(/gate|carry/i);
  });
  test("an interrupted job offers the Resume its text promises; a failed one says where to find the reason", () => {
    const i = serviceTask({ ...base, state: "interrupted", phase: "unknown", blocker: "The hub restarted while the tests were running. Nothing was replayed." })!;
    expect(i.blocker?.action).toEqual({ kind: "resume", label: "Resume" });
    expect(i.can.resume).toBe(true);
    const f = serviceTask({ ...base, state: "failed", phase: "failed" })!;
    expect(f.blocker?.text).toMatch(/failed before finishing/);
    expect(f.blocker?.action).toMatchObject({ kind: "link", label: "See why" });
  });
  test("the time line of an unstarted job says it is waiting, not 'still going'", async () => {
    const { timeLine } = await import("./tasks-tab");
    expect(timeLine({ startedAt: "2026-10-03T00:00:00.000Z", endedAt: null, notStarted: true })).toMatch(/waiting for you to start it/);
    expect(timeLine({ startedAt: "2026-10-03T00:00:00.000Z", endedAt: null, notStarted: true })).not.toMatch(/still going/);
  });
});

describe("audit 1, F-23 and F-25", () => {
  test("a saved result's summary loses its markdown marks", async () => {
    const { plainSummary } = await import("./tasks-tab");
    expect(plainSummary("- Found three sites\n- Two have no booking page\n**Next:** call them")).toBe("Found three sites. Two have no booking page. Next: call them");
  });
  test("the Coding list's filter is part of the address (only a known filter is kept)", async () => {
    const { Route } = await import("../../../routes/coding.index");
    const v = (Route.options as unknown as { validateSearch: (s: Record<string, unknown>) => Record<string, unknown> }).validateSearch;
    expect(v({ filter: "needs-you" })).toEqual({ filter: "needs-you" });
    expect(v({ filter: "bogus", request: "fix x" })).toEqual({ request: "fix x" });
    expect(v({})).toEqual({});
  });
});
