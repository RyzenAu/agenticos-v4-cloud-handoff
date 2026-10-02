// Round 6 (2 Oct 2026): coding-workspace reliability, one synthetic probe per failure point. Temp git repos, fake CLIs
// that speak the real protocols, no real account, no network. Each test names the DONE-WHEN item it proves.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codingBlocker } from "./pause-reason";
import { claudeBinding, draftSpec } from "./spec";
import { CodingStore } from "./store";
import { specDigest } from "./spec";
import { FakeClaude } from "./runners/fakes";
import { APPROVE, BUILDER_STEPS, OWNER, fastFixture, roots, settled, spec, until, world } from "./r6-world";

const SLOW = (ms: number) => ({ id: "fx.slow" as never, kind: "test" as const, argv: [process.execPath, "-e", `setTimeout(()=>{console.log("(pass) slow [1ms]");console.log(" 1 pass");console.log(" 0 fail")},${ms})`], cwd: ".", timeoutMs: 60_000, counts: "bun" as const });
function slowFixture(ms: number) {
  const fx = fastFixture();
  roots.push(fx.root);
  return { ...fx, entry: { ...fx.entry, commands: [SLOW(ms), ...fx.entry.commands] } };
}
const close = (w: ReturnType<typeof world>) => { w.orch.close(); w.store.close(); w.approvals.close(); };

describe("item 4: starting once creates exactly one execution", () => {
  test("a double click, a retry and a reconnect (same digest) start one builder and one reviewer", async () => {
    const w = world();
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      const digest = specDigest(s);
      const first = w.orch.confirmAndStart(job.id, OWNER, "ui", digest);
      const second = w.orch.confirmAndStart(job.id, OWNER, "ui", digest); // double click
      expect(first.state).toBe("preparing");
      expect(second.id).toBe(first.id);
      const done = await until(w, job.id, settled);
      const third = w.orch.confirmAndStart(job.id, OWNER, "typed", digest); // a retry after a reconnect
      expect(third.state).toBe("completed");
      await Bun.sleep(150);
      expect(done.runs.filter((r) => r.role === "builder")).toHaveLength(1);
      expect(w.launched.filter((l) => !l.args.includes("plan"))).toHaveLength(1);
      expect(w.launched).toHaveLength(2); // one builder and one reviewer, ever
      expect(w.store.getJob(job.id)!.runs).toHaveLength(2);
    } finally { close(w); }
  }, 600_000);
});

describe("item 9: cancellation prevents every later step", () => {
  test("a stop while the first of two checks runs: the second check never runs, no reviewer starts, the job ends cancelled", async () => {
    const fx = slowFixture(2500);
    const w = world({ fx });
    try {
      const s = spec(w);
      s.checks = ["fx.slow" as never, "fx.test" as never];
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      for (let i = 0; i < 800 && !w.store.events(job.id, 0, 5000).some((e) => e.type === "step" && /Running fx\.slow/.test((e.payload as any).label ?? "")); i++) await Bun.sleep(25);
      w.orch.cancel(job.id);
      for (let i = 0; i < 800 && w.orch.running(job.id); i++) await Bun.sleep(25);
      const after = w.store.getJob(job.id)!;
      const ran = w.store.events(job.id, 0, 5000).filter((e) => e.type === "test").map((e) => (e.payload as any).commandId);
      expect(after.state).toBe("cancelled");
      expect(w.store.events(job.id, 0, 5000).filter((e) => e.type === "test" && (e.payload as any).sha !== w.fx.baseSha).map((e) => (e.payload as any).commandId)).toEqual(["fx.slow"]);
      expect(w.launched).toHaveLength(1); // the builder only
      expect(w.store.events(job.id, 0, 5000).some((e) => e.type === "gate")).toBe(false);
    } finally { close(w); }
  }, 600_000);

  test("a stop during the baseline run: no later check, no builder is ever started", async () => {
    const fx = slowFixture(2500);
    const w = world({ fx });
    try {
      const s = spec(w);
      s.checks = ["fx.slow" as never, "fx.test" as never];
      s.baselineChecks = ["fx.slow" as never, "fx.test" as never];
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      for (let i = 0; i < 800 && !w.store.events(job.id, 0, 5000).some((e) => e.type === "step" && /Baseline fx\.slow/.test((e.payload as any).label ?? "")); i++) await Bun.sleep(25);
      w.orch.cancel(job.id);
      for (let i = 0; i < 800 && w.orch.running(job.id); i++) await Bun.sleep(25);
      expect(w.store.getJob(job.id)!.state).toBe("cancelled");
      expect(w.store.events(job.id, 0, 5000).filter((e) => e.type === "test").map((e) => (e.payload as any).commandId)).toEqual(["fx.slow"]);
      expect(w.launched).toHaveLength(0);
      expect(w.store.getJob(job.id)!.runs).toHaveLength(0);
    } finally { close(w); }
  }, 600_000);

  test("a stop while the reviewer runs: no gate, no 'done', the reviewer's session is stopped", async () => {
    const w = world({ reviewer: () => new FakeClaude({ stall: true, steps: [{ wait: 30_000 }] }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, (j) => j.runs.some((r) => r.role === "reviewer" && r.state === "running"));
      w.orch.cancel(job.id);
      for (let i = 0; i < 800 && w.orch.running(job.id); i++) await Bun.sleep(25);
      const after = w.store.getJob(job.id)!;
      expect(after.state).toBe("cancelled");
      expect(after.gate).toBeNull();
      expect(w.store.events(job.id, 0, 5000).some((e) => e.type === "spoken" && /Done and verified/.test((e.payload as any).line))).toBe(false);
    } finally { close(w); }
  }, 600_000);
});

describe("item 10: a hub restart preserves accurate status", () => {
  test("a job that was running its tests when the hub died reads interrupted (never 'testing'), and nothing re-runs by itself", async () => {
    const fx = slowFixture(4000);
    const dataDir = join(fx.root, "coding-data");
    const w1 = world({ fx, dataDir });
    const s = spec(w1);
    s.checks = ["fx.slow" as never];
    const { job } = w1.orch.draft(s);
    w1.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    await until(w1, job.id, (j) => j.state === "testing");
    w1.store.close();
    const store2 = CodingStore.open(dataDir);
    try {
      expect(store2.getJob(job.id)!.state).toBe("interrupted");
      expect(store2.listJobs({ state: "testing" })).toHaveLength(0);
      expect(store2.getJob(job.id)!.runs.every((r) => !["starting", "running", "needs_input"].includes(r.state))).toBe(true);
    } finally { w1.orch.close(); store2.close(); w1.approvals.close(); }
  }, 600_000);
});

describe("item 11: scope violations name the offending files in plain words", () => {
  test("the blocker words for an ownership stop carry every file even for a long list", () => {
    const files = Array.from({ length: 6 }, (_, i) => `packages/application/src/features/billing/invoice-${i}.tsx`);
    const message = `changed files it doesn't own: ${files.join(", ")}`;
    const job = { state: "needs_owner", spec: { roles: [] }, tests: [], runs: [{ roleId: "builder-1", role: "builder", state: "failed", error: { code: "ownership_violation", message } }] } as never;
    const b = codingBlocker(job);
    for (const f of files) expect(b.text).toContain(f);
  });
});

describe("item 6: receipts record the model that actually responded", () => {
  test("a builder asked for Opus whose CLI reports Sonnet: the receipt keeps both, flags the mismatch, and the page words say so", async () => {
    const w = world({ builder: () => new FakeClaude({ steps: BUILDER_STEPS(), model: "claude-sonnet-5-5" }), reviewer: () => new FakeClaude({ result: { result: APPROVE } }) });
    try {
      const s = spec(w, { builderBinding: claudeBinding("claude-opus-5-5", "2.1.280") });
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, settled);
      const receipts = w.store.events(job.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any);
      const builder = receipts.find((r) => r.coding.roleId === "builder-1");
      expect(builder.requestedModel).toBe("claude-opus-5-5");
      expect(builder.providerModel).toBe("claude-sonnet-5-5");
      expect(builder.modelMismatch).toBe(true);
    } finally { close(w); }
  }, 600_000);
});

describe("item 14: every blocker says what is blocked, why, and the one action that unblocks it", () => {
  const base = { state: "needs_owner", spec: { roles: [], repo: { baseSha: "b".repeat(40) }, doneWhen: [], objective: "x" }, tests: [], review: null, gate: null, headSha: null, runs: [] };
  const at = "2026-10-02T00:00:00.000Z";
  const cases: [string, Record<string, unknown>, string, RegExp][] = [
    ["integration conflict", { stoppedBecause: { code: "integration_conflict", message: "Integrating builder-2 conflicted on src/a.ts, src/b.ts; nothing was resolved automatically.", at } }, "integration-conflict", /conflict.*src\/a\.ts, src\/b\.ts.*(stop this job|retry)/is],
    ["a change outside the worktrees", { stoppedBecause: { code: "outside_worktrees", message: "the fixture checkout changed: scratch.txt", at } }, "outside-worktrees", /outside.*scratch\.txt.*re-run the done gate/is],
    ["an unexpected harness error", { stoppedBecause: { code: "unexpected", message: "spawn git ENOENT", at } }, "unexpected", /spawn git ENOENT.*resume/is],
    ["a merge that did not happen", { stoppedBecause: { code: "apply_failed", message: "main is checked out in C:/x", at } }, "apply-failed", /merge did not happen.*checked out.*ask for the merge again/is],
    ["one role stopped by the owner", { runs: [{ roleId: "builder-1", role: "builder", state: "cancelled", error: null, history: [{ from: "running", to: "cancelled", reason: "owner_cancel", at }] }] }, "role-cancelled", /You stopped the builder.*Resume starts that step again/is],
    ["a signed-out reviewer", { runs: [{ roleId: "reviewer", role: "reviewer", state: "failed", error: { code: "signed_out", message: "Claude Max (claude:max) isn't signed in. Nothing ran; sign it in, or resume on another account." }, history: [] }] }, "reviewer-unavailable", /reviewer can't run.*(another account|available account)/is],
    ["a builder that left work uncommitted", { runs: [{ roleId: "builder-1", role: "builder", state: "failed", error: { code: "postcheck_failed", message: "no commit on its branch; 2 uncommitted file(s) left in its worktree" }, history: [] }] }, "role-stopped", /builder stopped.*uncommitted.*Retrying runs only this step/is],
  ];
  test.each(cases)("%s", (_name, patch, kind, words) => {
    const b = codingBlocker({ ...base, ...patch } as never);
    expect(b.kind).toBe(kind);
    expect(b.text).toMatch(words);
    expect(b.label.length).toBeGreaterThan(3);
    expect(b.text).not.toMatch(/Open it to see what needs attention/);
  });
  test("the last-resort sentence names the state and where to look", () => {
    const b = codingBlocker({ ...base } as never);
    expect(b.kind).toBe("other");
    expect(b.text).toContain("needs owner");
    expect(b.text).toContain("Progress tab");
  });
});

describe("item 12: a failing test shows its name and assertion; the full output stays folded away", () => {
  const OUT = [
    "scripts/x/sum.test.ts:",
    "(pass) sum > adds [0.10ms]",
    "1 | import { test, expect } from 'bun:test';",
    "5 |   expect(sum(2, 2)).toBe(5);",
    "                       ^",
    "error: expect(received).toBe(expected)",
    "",
    "Expected: 5",
    "Received: 4",
    "",
    "      at <anonymous> (D:/x/sum.test.ts:5:24)",
    "(fail) sum > adds large numbers [0.50ms]",
    "error: boom",
    "      at <anonymous> (D:/x/sum.test.ts:9:1)",
    "(fail) sum > explodes [0.20ms]",
    "",
    " 1 pass",
    " 2 fail",
  ].join("\n");
  test("the parser pairs each failing test with the assertion bun printed just before it", async () => {
    const { parseFailedTests, parseFailures } = await import("./gate");
    const names = parseFailedTests("bun", OUT, 2);
    const failures = parseFailures("bun", OUT, names);
    expect(failures).toEqual([
      { name: "scripts/x/sum.test.ts :: sum > adds large numbers", assertion: "expect(received).toBe(expected) · Expected: 5 · Received: 4" },
      { name: "scripts/x/sum.test.ts :: sum > explodes", assertion: "boom" },
    ]);
  });
  test("a runner that prints no names gives no failures, and an unreadable block gives a name with a null assertion", async () => {
    const { parseFailures } = await import("./gate");
    expect(parseFailures("none", OUT, null)).toEqual([]);
    expect(parseFailures("bun", "(fail) lonely [1ms]\n 1 fail", ["lonely"])).toEqual([{ name: "lonely", assertion: null }]);
  });
  test("the page rows show the bare test name, its file and the assertion; extra failures are counted, not listed", async () => {
    const { failureRows } = await import("../../src/components/coding/failed-tests");
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `a.test.ts :: t${i}`, assertion: `bad ${i}` }));
    const { rows, more } = failureRows(many, null, 5);
    expect(rows).toHaveLength(5);
    expect(more).toBe(3);
    expect(rows[0]).toEqual({ title: "t0", file: "a.test.ts", assertion: "bad 0" });
    expect(failureRows(null, ["only a name"]).rows[0]).toEqual({ title: "only a name", file: null, assertion: null });
  });
  test("a real failing check in a job: the job view carries the failing test, its assertion and nothing of the full output", async () => {
    const fx = fastFixture();
    roots.push(fx.root);
    const script = "console.log('(fail) pricing > totals include GST [0.4ms]'); console.log(' 0 pass'); console.log(' 1 fail'); process.exit(1)";
    const withAssertion = `console.log('error: expect(received).toBe(expected)'); console.log(''); console.log('Expected: 110'); console.log('Received: 100'); console.log('      at <anonymous> (x.test.ts:1:1)'); ${script}`;
    const w = world({ fx: { ...fx, entry: { ...fx.entry, commands: [{ ...fx.entry.commands[0], argv: [process.execPath, "-e", withAssertion] }] } } });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const done = await until(w, job.id, settled);
      const { readableJob } = await import("./job-view");
      const view = readableJob(done, w.store.events(job.id, 0, 5000));
      expect(view.tests.latest?.failures).toEqual([{ name: "pricing > totals include GST", assertion: "expect(received).toBe(expected) · Expected: 110 · Received: 100" }]);
      expect(JSON.stringify(view.tests)).not.toContain("at <anonymous>");
    } finally { close(w); }
  }, 600_000);
});

describe("item 5: a model the user asked for that can't be run is reported, never replaced", () => {
  const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "s" } as never;
  async function shaped(utterance: string) {
    const { createShaper } = await import("./shaper");
    const { DEFAULT_ACCOUNTS } = await import("./accounts");
    const { fixtureRepo, cleanup } = await import("./test-fixtures");
    const fx = fixtureRepo();
    try {
      const registry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app", description: "fixture" }] } as never;
      const sh = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null, choice: () => ({ route: ((_t: string, c: { selected: string }) => ({ model: c.selected, fallbackFrom: null })) as never, hasKey: () => true, readings: [] }) });
      return await sh.shape({ utterance, channel: "typed", principal, usePlanner: false });
    } finally { cleanup(fx.root); }
  }
  test.each([
    ["In fixture-app, make src/a.ts export 42. Gemini builds and Opus reviews.", /Gemini isn't a model this harness can run/],
    ["In fixture-app, make src/a.ts export 42. Use GPT-4 to review.", /GPT-4 isn't a model/],
    ["In fixture-app, make src/a.ts export 42. Sonnet 4.5 builds.", /Sonnet 4\.5 isn't offered here; the Sonnet this harness runs is 5\.5/],
    ["In fixture-app, make src/a.ts export 42. Opus 4 builds, Sonnet reviews.", /Opus 4 isn't offered/],
  ])("%s", async (utterance, said) => {
    const r = await shaped(utterance);
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") { expect(r.reason).toMatch(said); expect(r.reason).toMatch(/haven't drafted this/); }
  });
  test("ordinary tasks that merely mention those words are not refused, and the offered versions pass", async () => {
    for (const u of ["In fixture-app, fix the Gemini API client in src/a.ts.", "In fixture-app, change src/a.ts to export 42. Opus 5.5 builds and Sonnet reviews.", "In fixture-app, make src/a.ts export 42. Sonnet 5 builds."]) {
      const r = await shaped(u);
      expect(r.kind).toBe("draft");
    }
  });
  test("the right model words still draft exactly what was asked", async () => {
    const r = await shaped("In fixture-app, make src/a.ts export 42. Sonnet builds and Opus reviews.");
    expect(r.kind).toBe("draft");
    if (r.kind === "draft") expect(r.spec.roles.map((x) => x.agent?.model).filter(Boolean)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  });
});

describe("item 7: a repair pass that changes nothing is said, keeps the findings, and is never re-tested", () => {
  const CHANGES = JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "major", file: "src/a.ts", line: 1, message: "wrong value: a must be 42" }], criteria: [{ criterionId: "c2", met: false, note: "a is 41" }] });
  test("no commit in the repair pass: the job waits with the findings kept; the NEXT Resume still carries them, commits, and gets a fresh test and review", async () => {
    let builds = 0;
    let reviews = 0;
    const w = world({
      builder: () => (++builds === 2 ? new FakeClaude({ steps: [{ text: "I looked again and changed nothing." }] }) : new FakeClaude({ steps: BUILDER_STEPS(builds === 1 ? "export const a = 41;\n" : "export const a = 42;\n") })),
      reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? CHANGES : APPROVE } }),
    });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const paused = await until(w, job.id, settled);
      expect(paused.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      w.orch.resume(job.id, { by: OWNER });
      const after = await until(w, job.id, (j) => settled(j) && j.runs.filter((r) => r.role === "builder").length === 2);
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(builds).toBe(2);
      expect(reviews).toBe(1); // no second review of the same commit
      expect(after.headSha).toBe(paused.headSha);
      expect(after.tests.filter((t) => t.sha === paused.headSha)).toHaveLength(1);
      const stopped = w.store.getJob(job.id)!;
      expect(stopped.state).toBe("needs_owner");
      expect(stopped.stoppedBecause?.code).toBe("repair_no_change");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("repair-no-change");
      expect(b.text).toContain("made no new commit");
      expect(b.text).toContain("findings are still open");
      // The next Resume goes back through the repair branch: the builder is given the findings, and a real fix is tested and reviewed afresh.
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => settled(j) && j.runs.filter((r) => r.role === "builder").length === 3);
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(builds).toBe(3);
      const third = w.launched.filter((l) => l.args[l.args.indexOf("--permission-mode") + 1] !== "plan")[2];
      expect(JSON.stringify(third.sent)).toContain("wrong value: a must be 42");
      expect(done.state).toBe("completed");
      expect(done.headSha).not.toBe(paused.headSha);
      expect(reviews).toBe(2);
      expect(done.review?.sha).toBe(done.headSha!);
      expect(done.tests.filter((t) => t.sha === done.headSha)).toHaveLength(1);
    } finally { close(w); }
  }, 600_000);

  test("two writers, one has nothing to fix: the other's real fix is integrated, tested and reviewed; the job is not failed", async () => {
    const builderFor = (cwd: string) => /builder-2/.test(cwd.replace(/\\/g, "/")) ? "b" : "a";
    let pass = 0;
    const calls: string[] = [];
    const w = world({
      builder: (cwd) => {
        const which = builderFor(cwd);
        calls.push(which);
        const file = which === "a" ? "src/a.ts" : "src/b.ts";
        const first = !calls.slice(0, -1).includes(which);
        if (!first && which === "a") return new FakeClaude({ steps: [{ text: "Nothing in my file to fix." }] });
        const content = first ? `export const v = 1;\n` : `export const v = 2;\n`;
        return new FakeClaude({ steps: [
          { tool: "Write", input: { file_path: file, content }, effect: { write: { path: file, content } } },
          { tool: "Bash", input: { command: `git add -- ${file}` }, effect: { git: ["add", "--", file] } },
          { tool: "Bash", input: { command: 'git commit -m "change"' }, effect: { git: ["commit", "-q", "-m", "change"] } },
          { text: "done" },
        ] });
      },
      reviewer: () => new FakeClaude({ result: { result: ++pass === 1 ? JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "major", file: "src/b.ts", line: 1, message: "b is wrong" }], criteria: [] }) : APPROVE } }),
    });
    try {
      const base = spec(w);
      const two = draftSpec({
        requestedBy: OWNER, channel: "voice", utterance: "x", entry: w.fx.entry, objective: "Set a and b in the fixture",
        doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test", ref: "alpha" }, { id: "c2", text: "a and b are set", evidence: "reviewer-confirms" }], roleTemplate: "build+review",
        builders: [{ binding: claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/a.ts"], newFiles: [] } }, { binding: claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/b.ts"], newFiles: [] } }],
        reviewer: { binding: claudeBinding("claude-sonnet-5-5", "2.1.280") }, checks: ["fx.test" as never], dataClass: "synthetic",
      });
      void base;
      const { job } = w.orch.draft(two);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(two));
      const paused = await until(w, job.id, settled);
      expect(paused.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => j.state === "completed");
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(done.headSha).not.toBe(paused.headSha);
      expect(done.review?.sha).toBe(done.headSha!);
      expect(done.tests.some((t) => t.sha === done.headSha)).toBe(true);
      expect(done.runs.filter((r) => r.state === "failed")).toHaveLength(0);
    } finally { close(w); }
  }, 600_000);
});

describe("item 6: a role re-run as a new run reads its own receipts, in the model list and in the page's run rows", () => {
  test("run 1 fails (no commit, CLI reported Haiku); the retry is a new run answered by Opus: each row shows its own model and outcome", async () => {
    let builds = 0;
    const w = world({ builder: () => (++builds === 1 ? new FakeClaude({ steps: [{ text: "Thought about it, committed nothing." }], model: "claude-haiku-4-5" }) : new FakeClaude({ steps: BUILDER_STEPS() })) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, settled);
      expect(stopped.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => j.state === "completed");
      await until(w, job.id, () => !w.orch.running(job.id));
      const events = w.store.events(job.id, 0, 5000);
      const builderRuns = done.runs.filter((r) => r.role === "builder");
      expect(builderRuns).toHaveLength(2);
      const { modelsUsed } = await import("./receipts");
      const rows = modelsUsed(done.runs, events).filter((r) => r.role === "builder");
      expect(rows.map((r) => [r.runState, r.actual])).toEqual([["failed", "claude-haiku-4-5"], ["succeeded", "claude-opus-5-5"]]);
      const { readableJob } = await import("./job-view");
      const view = readableJob(done, events);
      const runRows = view.progress.runs.filter((r) => r.role === "builder");
      expect(runRows.map((r) => r.attempts.map((a) => [a.reportedModel, a.outcome]))).toEqual([[["claude-haiku-4-5", "succeeded"]], [["claude-opus-5-5", "succeeded"]]]); // the receipt's outcome is the CLI turn's; the run row's state is the harness's verdict
    } finally { close(w); }
  }, 600_000);
});

describe("item 10 (review finding 7): a NEW orchestrator over the reopened store runs nothing and reads interrupted", () => {
  test("hub dies while the tests run; the next hub's orchestrator starts no check, no role, and reports interrupted, not running", async () => {
    const fx = slowFixture(4000);
    const dataDir = join(fx.root, "coding-data");
    const w1 = world({ fx, dataDir });
    const s = spec(w1);
    s.checks = ["fx.slow" as never];
    const { job } = w1.orch.draft(s);
    w1.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    await until(w1, job.id, (j) => j.state === "testing");
    w1.store.close();
    const store2 = CodingStore.open(dataDir);
    const w2 = world({ fx, dataDir, store: store2, approvals: w1.approvals, spoken: w1.spoken });
    try {
      await Bun.sleep(1500); // long enough for any replay to have started a check or a role
      expect(w2.orch.active()).toEqual([]);
      expect(w2.orch.running(job.id)).toBeNull();
      expect(w2.orch.liveRoles(job.id)).toEqual([]);
      expect(w2.launched).toHaveLength(0);
      const after = store2.getJob(job.id)!;
      expect(after.state).toBe("interrupted");
      expect(store2.events(job.id, 0, 5000).filter((e) => e.type === "test" && (e.payload as any).sha !== fx.baseSha)).toHaveLength(0);
      const { readableJob } = await import("./job-view");
      const view = readableJob(after, store2.events(job.id, 0, 5000));
      expect(view.progress.state).toBe("interrupted");
      expect(view.progress.needsYou).toBeTruthy();
      // Only an explicit Resume starts anything, and it says where it continues from.
      w2.orch.resume(job.id, { by: OWNER });
      expect(store2.getJob(job.id)!.state).not.toBe("interrupted");
      w2.orch.cancel(job.id);
      for (let i = 0; i < 400 && w2.orch.running(job.id); i++) await Bun.sleep(25);
    } finally { w2.orch.close(); store2.close(); w1.orch.close(); w1.approvals.close(); }
  }, 600_000);
});

describe("review finding 6: honest words for an unknown reset, a reworded objective, a failed merge", () => {
  test("a limit with no reset time: the account is held for a bounded time, then offered again, and the page says the time is unknown", async () => {
    const { limitedSlots, UNKNOWN_RESET_HOLD_MS } = await import("../../src/lib/coding-glance");
    const at = "2026-10-02T00:00:00.000Z";
    const job = { state: "blocked_allowance", runs: [{ roleId: "builder-1", role: "builder", state: "blocked_allowance", binding: { accountSlot: "claude:max", model: "m" }, history: [{ from: "running", to: "blocked_allowance", at, reason: "provider_limit_reached" }], error: { code: "limit_reached", message: "Claude hit its usage limit." } }] } as never;
    const t0 = Date.parse(at);
    expect([...limitedSlots(job, t0 + 60_000)]).toEqual(["claude:max"]);
    expect(limitedSlots(job, t0 + UNKNOWN_RESET_HOLD_MS + 1).size).toBe(0);
    const logged = [{ type: "step", at, payload: { label: "Account at its limit: claude:max-2", detail: "no time given" } }];
    expect([...limitedSlots({ runs: [] } as never, t0 + 1000, logged)]).toEqual(["claude:max-2"]);
    expect(limitedSlots({ runs: [] } as never, t0 + UNKNOWN_RESET_HOLD_MS + 1, logged).size).toBe(0);
    const b = codingBlocker({ ...(job as object), spec: { roles: [] }, tests: [] } as never);
    expect(b.text).toContain("the reset time is unknown");
    expect(b.text).toContain("about 5 hours");
  });
  test("editing the objective rewords the reviewer line that was written from it (and only that one)", async () => {
    const { planPatch } = await import("./routes");
    const job = { spec: { objective: "Set a to 42", doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test", ref: "alpha" }, { id: "c2", text: "Set a to 42", evidence: "reviewer-confirms" }, { id: "c3", text: "Keep types", evidence: "reviewer-confirms" }] } } as never;
    const out = planPatch(job, { objective: "Set a to 43 instead" }) as { patch: { doneWhen: { id: string; text: string }[] } };
    expect(out.patch.doneWhen.map((d) => d.text)).toEqual(["alpha passes", "Set a to 43 instead", "Keep types"]);
    const own = planPatch(job, { objective: "Set a to 43 instead", doneWhen: [{ id: "c2", text: "a is exactly 43" }] }) as { patch: { doneWhen: { id: string; text: string }[] } };
    expect(own.patch.doneWhen.find((d) => d.id === "c2")!.text).toBe("a is exactly 43"); // a person's own rewording wins
  });
  test("a merge that did not happen names the action the button really does", () => {
    const b = codingBlocker({ state: "needs_owner", runs: [], tests: [], spec: { roles: [] }, stoppedBecause: { code: "apply_failed", message: "main is checked out", at: "2026-10-02T00:00:00.000Z" } } as never);
    expect(b.kind).toBe("apply-failed");
    expect(b.label).toBe("Re-check the job, then ask for the merge again");
    expect(b.label).not.toMatch(/done gate/);
  });
});
