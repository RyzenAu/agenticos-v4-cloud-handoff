// Round 7 (3 Oct 2026): coding jobs stop honestly and recover. One synthetic probe per cause the owner's "stopped without a
// useful explanation or recovery control" and "approvals return to the same stopped state" reports traced to. Temp git repos,
// fake CLIs that speak the real protocols, a real approvals service; no real account and no network.
// Each test names the cause it proves. Every one of them failed (or could not be written) against the round 6 code.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { codingBlocker, codingResumeLabel } from "./pause-reason";
import { readableJob } from "./job-view";
import { FakeClaude } from "./runners/fakes";
import { inputQueue, requestKey } from "./runners/proc";
import type { RunnerEvent } from "./runners/types";
import { codexBinding, specDigest } from "./spec";
import { CodingStore } from "./store";
import { gitIn } from "./test-fixtures";
import { APPROVE, BUILDER_STEPS, OWNER, fastFixture, roots, settled, spec, until, world } from "./r6-world";
import { needsYouLine } from "../../src/components/coding/needs-you";

const close = (w: ReturnType<typeof world>) => { w.orch.close(); w.store.close(); w.approvals.close(); };
const node = (id: string, code: string, timeoutMs = 60_000) => ({ id: id as never, kind: "test" as const, argv: [process.execPath, "-e", code], cwd: ".", timeoutMs, counts: "bun" as const });
const PASS = `console.log("(pass) alpha [1ms]");console.log(" 1 pass");console.log(" 0 fail")`;
const FAIL = `console.log("(fail) alpha [1ms]");console.log(" 0 pass");console.log(" 1 fail");process.exit(1)`;
function withCommands(...commands: ReturnType<typeof node>[]) {
  const fx = fastFixture();
  roots.push(fx.root);
  return { ...fx, entry: { ...fx.entry, commands: [...commands, ...fx.entry.commands] } };
}
const prompts = (f: FakeClaude) => f.sent.filter((m: any) => m.type === "user").map((m: any) => String(m.message?.content ?? "")).join("\n");
const events = (w: ReturnType<typeof world>, id: string) => w.store.events(id, 0, 5000);
const owner = { personId: "usman" as const, via: "loopback-owner" as const, actor: "human" as const, deviceId: "usman-pc" };

describe("a job that could not get ready to start keeps its reason and a control that works", () => {
  test("an unsafe repo config: needs_owner with the cause, not a terminal 'failed' with a Resume that is refused; fixing it and pressing Start again runs the job", async () => {
    const w = world();
    try {
      gitIn(w.fx.canonical, "config", "filter.x.clean", "evil");
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, settled);
      expect(stopped.state).toBe("needs_owner");
      expect(stopped.stoppedBecause?.code).toBe("prepare_failed");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("prepare-failed");
      expect(b.text).toMatch(/couldn't get ready to start.*filter\.x\.clean.*No agent ran.*start it again/s);
      expect(b.text).not.toMatch(/\.\./);
      expect(codingResumeLabel(stopped)).toBe("Start it again");
      expect(needsYouLine(stopped)).toMatch(/couldn't get ready to start/);
      expect(w.launched).toHaveLength(0);
      // The owner removes the cause; the one control resumes from the very beginning and the job completes.
      gitIn(w.fx.canonical, "config", "--unset", "filter.x.clean");
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(done.state).toBe("completed");
      expect(w.launched.filter((l) => !l.args.includes("plan"))).toHaveLength(1);
    } finally { close(w); }
  }, 600_000);

  test("a hub that died while getting ready: Resume prepares first (it used to build on missing worktrees and fail the same way every time)", async () => {
    const fx = withCommands(node("fx.slow", `setTimeout(()=>{${PASS}},4000)`));
    const dataDir = join(fx.root, "coding-data");
    const w1 = world({ fx, dataDir });
    const s = spec(w1);
    s.baselineChecks = ["fx.slow" as never];
    const { job } = w1.orch.draft(s);
    w1.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    await until(w1, job.id, (j) => j.state === "preparing");
    await Bun.sleep(400);
    w1.store.close();
    const store2 = CodingStore.open(dataDir);
    const w2 = world({ fx, dataDir, store: store2, approvals: w1.approvals, spoken: w1.spoken });
    try {
      const interrupted = store2.getJob(job.id)!;
      expect(interrupted.state).toBe("interrupted");
      expect(interrupted.stoppedBecause?.code).toBe("restart");
      expect(codingBlocker(interrupted).text).toMatch(/hub restarted while .*getting ready.*Nothing was replayed.*Resume continues/s);
      expect(needsYouLine(interrupted)).toMatch(/hub restarted/);
      w2.orch.resume(job.id, { by: OWNER });
      const done = await until(w2, job.id, (j) => settled(j) && !w2.orch.running(job.id), 120_000);
      expect(done.state).toBe("completed");
      expect(store2.events(job.id, 0, 5000).filter((e) => e.type === "step" && /^Prepared:/.test((e.payload as any).label))).toHaveLength(1);
    } finally { w2.orch.close(); store2.close(); w1.orch.close(); w1.approvals.close(); }
  }, 600_000);

  test("a restart during the tests: the job says what was happening, and Resume does NOT prepare a second time", async () => {
    const fx = withCommands(node("fx.slow", `setTimeout(()=>{${PASS}},4000)`));
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
      const interrupted = store2.getJob(job.id)!;
      expect(codingBlocker(interrupted)).toMatchObject({ kind: "interrupted", label: "Resume" });
      expect(codingBlocker(interrupted).text).toMatch(/while the tests were running/);
      w2.orch.resume(job.id, { by: OWNER });
      const done = await until(w2, job.id, (j) => settled(j) && !w2.orch.running(job.id), 120_000);
      expect(done.state).toBe("completed");
      expect(store2.events(job.id, 0, 5000).filter((e) => e.type === "step" && /^Prepared:/.test((e.payload as any).label))).toHaveLength(1);
      expect(w2.launched.filter((l) => !l.args.includes("plan"))).toHaveLength(0); // the builder did not run again
    } finally { w2.orch.close(); store2.close(); w1.orch.close(); w1.approvals.close(); }
  }, 600_000);
});

describe("the final check stops that a bare re-run of the gate could never clear", () => {
  const builderThatFixesOnSecondRun = () => { let n = 0; return () => new FakeClaude({ steps: BUILDER_STEPS(++n === 1 ? "export const a = 41;\n" : "export const a = 42;\n") }); };
  const needs42 = node("fx.t42", `const s=require("fs").readFileSync("src/a.ts","utf8");if(/42/.test(s)){${PASS}}else{${FAIL}}`);

  test("the reviewer approved a commit whose own tests fail: the stop says so, and Resume sends the failure to the builder (it used to re-run the gate on the same results forever)", async () => {
    const fx = withCommands(needs42);
    const w = world({ fx, builder: builderThatFixesOnSecondRun() });
    try {
      const s = spec(w);
      s.checks = ["fx.t42" as never];
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(stopped.state).toBe("needs_owner");
      expect(stopped.review?.verdict).toBe("approve");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("tests-failing");
      expect(b.label).toBe("Fix the failing tests");
      expect(b.text).toMatch(/tests don't pass.*Resume sends the failure to the builder/s);
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(done.state).toBe("completed");
      const builders = w.launched.filter((l) => !l.args.includes("plan"));
      expect(builders).toHaveLength(2);
      expect(prompts(builders[1])).toMatch(/orchestrator's own test run at [0-9a-f]{40} fails.*fx\.t42/s);
      // New commit, new tests, new review: the finished job is verified at the NEW head.
      expect(done.gate?.passed).toBe(true);
      expect(done.gate?.sha).toBe(done.headSha);
      expect(done.review?.sha).toBe(done.headSha);
    } finally { close(w); }
  }, 600_000);

  test("a check that timed out: Resume runs the checks again (builder and reviewer are not run again) and the job completes", async () => {
    const base = fastFixture();
    roots.push(base.root);
    const marker = join(base.root, "late.marker");
    const late = node("fx.late", `const fs=require("fs");if(fs.existsSync(${JSON.stringify(marker)})){${PASS}}else{fs.writeFileSync(${JSON.stringify(marker)},"1");setTimeout(()=>{${PASS}},5000)}`, 800);
    const fx = { ...base, entry: { ...base.entry, commands: [late, ...base.entry.commands] } };
    const w = world({ fx });
    try {
      const s = spec(w);
      s.checks = ["fx.late" as never];
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(stopped.state).toBe("needs_owner");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("tests-timed-out");
      expect(b.label).toBe("Run the tests again");
      const spawnsBefore = w.launched.length;
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(done.state).toBe("completed");
      expect(w.launched.length).toBe(spawnsBefore); // one builder and one reviewer, ever
      expect(done.tests.filter((t) => t.sha === done.headSha)).toHaveLength(2);
    } finally { close(w); }
  }, 600_000);

  test("the reviewer blocks on a check that timed out (found on the synthetic hub): Resume runs the checks again, then a fresh review; the builder is not sent a repair it cannot make", async () => {
    const base = fastFixture();
    roots.push(base.root);
    const marker = join(base.root, "late2.marker");
    const late = node("fx.late", `const fs=require("fs");if(fs.existsSync(${JSON.stringify(marker)})){${PASS}}else{fs.writeFileSync(${JSON.stringify(marker)},"1");setTimeout(()=>{${PASS}},5000)}`, 800);
    const fx = { ...base, entry: { ...base.entry, commands: [late, ...base.entry.commands] } };
    let reviews = 0;
    const blocker = JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "blocker", file: null, line: null, message: "fx.late timed out with no exit code, so criterion c1 is unproven" }], criteria: [{ criterionId: "c2", met: true, note: "ok" }] });
    const w = world({ fx, reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? blocker : APPROVE } }) });
    try {
      const s = spec(w);
      s.checks = ["fx.late" as never];
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(stopped.state).toBe("needs_owner");
      expect(stopped.review?.verdict).toBe("request-changes");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("tests-timed-out");
      expect(b.label).toBe("Run the tests again");
      expect(b.text).toMatch(/fx\.late timed out at this commit.*a timeout is not a pass.*fresh review follows/s);
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(done.state).toBe("completed");
      expect(w.launched.filter((l) => !l.args.includes("plan"))).toHaveLength(1); // the builder ran once
      expect(w.launched.filter((l) => l.args.includes("plan"))).toHaveLength(2); // a fresh review after the tests passed
      expect(done.review?.verdict).toBe("approve");
    } finally { close(w); }
  }, 600_000);

  test("an approving review that still lists a major finding: the gate refuses it and no acceptance exists, so Resume repairs it instead of re-running the gate", async () => {
    let reviews = 0;
    const major = JSON.stringify({ verdict: "approve", findings: [{ id: "m1", severity: "major", file: "src/a.ts", line: 1, message: "a magic number" }], criteria: [{ criterionId: "c2", met: true, note: "ok" }] });
    const w = world({ builder: builderThatFixesOnSecondRun(), reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? major : APPROVE } }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(stopped.state).toBe("needs_owner");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("review-changes");
      expect(b.text).toMatch(/approved but left 1 serious finding/);
      expect(b.label).toBe("Fix review findings");
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(done.state).toBe("completed");
      expect(prompts(w.launched.filter((l) => !l.args.includes("plan"))[1])).toMatch(/a magic number/);
    } finally { close(w); }
  }, 600_000);

  test("an approval that never said whether a reviewer-confirmed item is met: only the review is retried, and is asked to answer it", async () => {
    let reviews = 0;
    const silent = JSON.stringify({ verdict: "approve", findings: [], criteria: [] });
    const w = world({ reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? silent : APPROVE } }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(stopped.state).toBe("needs_owner");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("review-unconfirmed");
      expect(b.text).toMatch(/never confirmed this done-when item: a is 42/);
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(done.state).toBe("completed");
      const all = w.launched;
      expect(all.filter((l) => !l.args.includes("plan"))).toHaveLength(1); // the builder ran once
      expect(all.filter((l) => l.args.includes("plan"))).toHaveLength(2);
      expect(prompts(all.filter((l) => l.args.includes("plan"))[1])).toMatch(/did not say whether these done-when criteria are met: c2/);
    } finally { close(w); }
  }, 600_000);
});

describe("a merge approval is never lost between the yes and the merge", () => {
  async function waitingForMerge(w: ReturnType<typeof world>) {
    gitIn(w.fx.canonical, "branch", "production", w.fx.baseSha);
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
    expect(done.state).toBe("completed");
    const { approval } = await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER });
    return { job: done, approval };
  }
  const yes = (w: ReturnType<typeof world>, approvalId: string) => {
    const q = w.approvals.ask(approvalId, owner);
    while (Date.now() <= q.askedAt); // a person answers after the question: never in the same millisecond (a tie is rightly refused)
    const heard = w.spoken.record("yes, approve")!;
    return w.approvals.decide(approvalId, owner, "approve", { spokenYes: heard.id, questionId: q.questionId });
  };

  test("a yes given while the hub was not listening is acted on when it comes back, once", async () => {
    const w1 = world();
    const { job, approval } = await waitingForMerge(w1);
    w1.orch.close(); // the hub goes away; the approvals store keeps the decision
    expect(yes(w1, approval.id)).toMatchObject({ ok: true });
    expect(gitIn(w1.fx.canonical, "rev-parse", "production").trim()).toBe(w1.fx.baseSha);
    expect(w1.store.getJob(job.id)!.state).toBe("awaiting_approval"); // the round 6 hub stayed here for good
    const w2 = world({ fx: w1.fx, dataDir: w1.dataDir, store: w1.store, approvals: w1.approvals, spoken: w1.spoken });
    try {
      const after = w2.store.getJob(job.id)!;
      expect(after.state).toBe("completed");
      expect(after.applies[0].state).toBe("succeeded");
      const tip = gitIn(w1.fx.canonical, "rev-parse", "production").trim();
      expect(tip).toBe(after.applies[0].verification!.observed);
      expect(w2.approvals.get(approval.id)!.state).toBe("consumed");
      // A second look changes nothing: no second merge commit, no second consume.
      expect(w2.orch.reconcileApprovals()).toBe(0);
      expect(gitIn(w1.fx.canonical, "rev-parse", "production").trim()).toBe(tip);
    } finally { close(w2); }
  }, 600_000);

  test("an approval that ran out while the hub was off settles the job back to completed with the reason, and 'merge it' works again", async () => {
    let t = Date.now();
    const spokenLedger = new (await import("../jarvis-execution/voice-confirmation")).SpokenConfirmationLedger();
    const fx = fastFixture();
    roots.push(fx.root);
    const approvals = new ApprovalService({ path: join(fx.root, "approvals-expiry.sqlite"), spoken: spokenLedger, now: () => t });
    const w1 = world({ fx, approvals, spoken: spokenLedger });
    const { job } = await waitingForMerge(w1);
    w1.orch.close();
    t += 3 * 24 * 3600_000; // days pass with the hub off
    const w2 = world({ fx, dataDir: w1.dataDir, store: w1.store, approvals, spoken: spokenLedger });
    try {
      const after = w2.store.getJob(job.id)!;
      expect(after.state).toBe("completed");
      expect(after.applies[0].state).toBe("cancelled");
      expect(after.applies[0].approval.state).toBe("expired");
      const second = await w2.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER });
      expect(second.reused).toBe(false);
      expect(w2.store.getJob(job.id)!.state).toBe("awaiting_approval");
    } finally { close(w2); }
  }, 600_000);

  test("'merge it' again while that merge waits returns the SAME approval (the way a lost code is re-sent); a different merge is refused; a rejection settles the job", async () => {
    const w = world();
    try {
      const { job, approval } = await waitingForMerge(w);
      const again = await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER });
      expect(again).toMatchObject({ reused: true, approval: { id: approval.id } });
      expect(w.store.getJob(job.id)!.applies).toHaveLength(1);
      await expect(w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "master", by: OWNER })).rejects.toThrow(/already waiting for your yes.*Stop the job to withdraw/s);
      expect(w.approvals.decide(approval.id, owner, "reject")).toMatchObject({ ok: true });
      for (let i = 0; i < 100 && w.store.getJob(job.id)!.state === "awaiting_approval"; i++) await Bun.sleep(10);
      expect(w.store.getJob(job.id)!.state).toBe("completed");
      expect(w.store.getJob(job.id)!.applies[0].approval.state).toBe("rejected");
    } finally { close(w); }
  }, 600_000);
});

describe("an approval the owner gives inside a turn is not asked for again", () => {
  const card = (id: string, title = "Allow Bash?") => ({ id, kind: "approval" as const, nativeKind: "Bash", title, detail: "make build", escalatedBecause: "unclassified", expiresAt: new Date(Date.now() + 1000).toISOString() as never });
  test("the queue keeps the owner's answer for an identical request, never keeps an expiry, and never keeps a question", async () => {
    const seen: RunnerEvent[] = [];
    const q = inputQueue((e) => seen.push(e), 60);
    const answers: string[] = [];
    q.push(card("r1"), (d) => answers.push(`r1:${d}`), "Bash:make build");
    q.respond("r1", "approve");
    q.push(card("r2"), (d) => answers.push(`r2:${d}`), "Bash:make build"); // the same request again
    expect(answers).toEqual(["r1:approve", "r2:approve"]);
    expect(seen.filter((e) => e.type === "input")).toHaveLength(1); // only the first was put to the owner
    expect(seen.some((e) => e.type === "step" && /earlier answer.*allowed/.test(e.label))).toBe(true);
    q.push(card("r3"), (d) => answers.push(`r3:${d}`), "Bash:make deploy"); // a different request is still asked
    expect(seen.filter((e) => e.type === "input")).toHaveLength(2);
    q.respond("r3", "deny");
    q.push(card("r4"), (d) => answers.push(`r4:${d}`), "Bash:make deploy");
    expect(answers.slice(-2)).toEqual(["r3:deny", "r4:deny"]);
    // An expiry is not an answer.
    q.push(card("r5"), (d) => answers.push(`r5:${d}`), "Bash:slow");
    await Bun.sleep(120);
    expect(answers.at(-1)).toBe("r5:deny");
    const before = seen.filter((e) => e.type === "input").length;
    q.push(card("r6"), (d) => answers.push(`r6:${d}`), "Bash:slow");
    expect(seen.filter((e) => e.type === "input").length).toBe(before + 1);
    q.clear();
  });

  test("end to end: a builder that asks for the same command twice is asked once, and finishes", async () => {
    const w = world({ builder: () => new FakeClaude({ steps: [{ tool: "Bash", input: { command: "make build" } }, { tool: "Bash", input: { command: "make build" } }, ...BUILDER_STEPS()] }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const waiting = await until(w, job.id, (j) => j.runs.some((r) => r.state === "needs_input"));
      const run = waiting.runs.find((r) => r.state === "needs_input")!;
      w.orch.respond(job.id, run.roleId, run.pendingInput!.id, "approve");
      const done = await until(w, job.id, settled);
      expect(done.state).toBe("completed");
      expect(events(w, job.id).filter((e) => e.type === "input_request")).toHaveLength(1);
      expect(w.launched[0].decisions.filter((d) => d.tool === "Bash" && (d.updatedInput as { command?: string } | undefined)?.command === "make build").map((d) => d.behavior)).toEqual(["allow", "allow"]);
    } finally { close(w); }
  }, 600_000);

  test("a request that runs out unanswered is named as the reason the builder stopped (it used to read 'no commit on its branch')", async () => {
    const w = world({ inputTimeoutMs: 700, builder: () => new FakeClaude({ steps: [{ tool: "Bash", input: { command: "make build" } }, { text: "I could not run it, so I stopped." }] }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(stopped.state).toBe("needs_owner");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("role-stopped");
      expect(b.text).toMatch(/builder stopped: its request "Allow Bash\?" was not answered within 1 second, so it was declined/);
      expect(b.text).toMatch(/Retrying runs only this step/);
    } finally { close(w); }
  }, 600_000);
});

describe("receipts say what actually answered, and a mismatch is visible", () => {
  test("a builder asked for Opus on a pinned account whose CLI answers as Sonnet: requested and responding model both recorded, flagged in the job view and the step log", async () => {
    const w = world({ builder: () => new FakeClaude({ steps: BUILDER_STEPS(), model: "claude-sonnet-5-5" }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const done = await until(w, job.id, settled);
      const view = readableJob(done, events(w, job.id));
      const run = view.progress.runs.find((r) => r.roleId === "builder-1")!;
      expect(run.attempts[0]).toMatchObject({ requestedModel: "claude-opus-5-5", reportedModel: "claude-sonnet-5-5", modelMismatch: true });
      expect(events(w, job.id).some((e) => e.type === "step" && /Model mismatch: asked for claude-opus-5-5, the CLI reported claude-sonnet-5-5/.test((e.payload as any).label))).toBe(true);
    } finally { close(w); }
  }, 600_000);
});


describe("a checkout the job must not touch changed while a role ran (usually the owner's own commit): said in words, never a loop", () => {
  test("the stop names what moved; Resume as it is is refused with the reason; accepting the change is recorded and the job then carries on", async () => {
    const w = world({ builder: () => new FakeClaude({ steps: [{ wait: 1200 }, ...BUILDER_STEPS()] }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, (j) => j.runs.some((r) => r.state === "running"));
      gitIn(w.fx.canonical, "commit", "--allow-empty", "-q", "-m", "the owner commits in his own checkout");
      const stopped = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(stopped.state).toBe("needs_owner");
      const b = codingBlocker(stopped);
      expect(b.kind).toBe("checkout-changed");
      expect(b.text).toMatch(/A checkout this job must not touch changed while it ran \(.*checkout: .*HEAD moved [0-9a-f]{7} → [0-9a-f]{7}.*your change \(a commit, pull or edit\), or an agent's.*accept the change/s);
      expect(b.label).toBe("Accept the change and retry");
      expect(b.detail).toMatch(/the live OS checkout|checkout: .*HEAD moved/); // the moved paths travel with the control
      // Resuming as it is would stop at the same place every time: refused, with the cause, and nothing starts.
      const spawned = w.launched.length;
      expect(() => w.orch.resume(job.id, { by: OWNER })).toThrow(/Resuming would stop in the same place.*accept it/s);
      expect(w.launched.length).toBe(spawned);
      expect(w.store.getJob(job.id)!.state).toBe("needs_owner");
      // The owner's decision, recorded; the job carries on and completes.
      w.orch.resume(job.id, { by: OWNER, acceptCheckoutChange: true });
      const done = await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      expect(done.state).toBe("completed");
      expect(events(w, job.id).some((e) => e.type === "step" && /Owner accepted a change to a checkout the job must not touch \(usman\)/.test((e.payload as any).label))).toBe(true);
    } finally { close(w); }
  }, 600_000);
});

describe("test totals count each check once, as what it says now (they added every run, so a rerun read '5 passed' for two tests)", () => {
  const head = "d".repeat(40);
  const run = (commandId: string, over: Record<string, unknown>) => ({ commandId, sha: head, exitCode: 0, timedOut: false, counts: { passed: 2, failed: 0, skipped: 0 }, ...over });
  const job = (tests: unknown[]) => ({ headSha: head, tests }) as never;
  test("a check that timed out and was then run again counts once and passes; the timeout alone is named and is not a pass", async () => {
    const { testsSummary } = await import("../../src/lib/coding-client");
    expect(testsSummary(job([run("unit", {}), run("late", { exitCode: null, timedOut: true, counts: { passed: null, failed: null, skipped: null } }), run("unit", {}), run("late", { counts: { passed: 1, failed: 0, skipped: 0 } })]))).toEqual({ text: "3 passed · 0 failed", tone: "success" });
    expect(testsSummary(job([run("unit", {}), run("late", { exitCode: null, timedOut: true, counts: { passed: null, failed: null, skipped: null } })]))).toEqual({ text: "2 passed · 0 failed · 1 timed out", tone: "danger" });
  });
  test("the job page's line says the same, and names a timeout", async () => {
    const { glanceOf } = await import("../../src/lib/coding-glance");
    const base = { state: "needs_owner", headSha: head, spec: { roles: [], repo: { baseSha: "b".repeat(40), jobBranch: "coding/x" }, doneWhen: [], nonGoals: [], objective: "x", checks: [], baselineChecks: [] }, review: null, gate: null, runs: [], applies: [], diff: null, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
    const view = (tests: unknown[]) => {
      const j = { ...base, tests } as never;
      return { job: j, readable: readableJob(j, []), receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "d" } as never;
    };
    const timedOut = run("late", { exitCode: null, timedOut: true, counts: { passed: null, failed: null, skipped: null } });
    const lines = glanceOf(view([run("unit", {}), timedOut])).finished.join(" ");
    expect(lines).toMatch(/Tests at that commit: 2 passed, 0 failed, and 1 check timed out \(a timeout is not a pass\)/);
    expect(glanceOf(view([run("unit", {}), timedOut, run("unit", {}), run("late", { counts: { passed: 1, failed: 0, skipped: 0 } })])).finished.join(" ")).toMatch(/Tests at that commit: 3 passed, 0 failed\./);
  });
});

describe("jobs nobody holds (the post-boot seed: H-08 and H-12): Deny and Stop settle, once, with the reason", () => {
  async function seededLive() {
    const w = world();
    writeFileSync(join(w.dataDir, "..", ".gate-seed.json"), "{}"); // the gate seed's marker, beside the store (review finding 5)
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "dev-seed.ts")], { env: { ...process.env, CODING_DATA_DIR: w.dataDir, CODING_SEED_PHASE: "live" } });
    expect(child.exitCode).toBe(0);
    const jobs = w.store.listJobs({ limit: 20 });
    return { w, asking: jobs.find((j) => j.runs.some((r) => r.state === "needs_input"))!, reviewing: jobs.find((j) => j.state === "reviewing")! };
  }
  test("the live seed writes beside a store this process holds, and the two jobs stay in flight", async () => {
    const { w, asking, reviewing } = await seededLive();
    try {
      expect(asking.state).toBe("building");
      expect(asking.runs.find((r) => r.state === "needs_input")?.pendingInput?.title).toBe("Allow Bash?");
      expect(reviewing.runs.some((r) => r.state === "running")).toBe(true);
      expect(w.store.listJobs({ state: "interrupted" })).toHaveLength(0);
    } finally { close(w); }
  });
  test("Deny on a request whose role is not running here is written once, closes the run as interrupted and leaves Resume as the way on", async () => {
    const { w, asking } = await seededLive();
    try {
      const run = asking.runs.find((r) => r.state === "needs_input")!;
      const after = w.orch.respond(asking.id, run.roleId, run.pendingInput!.id, "deny");
      expect(after.state).toBe("interrupted");
      expect(after.runs.find((r) => r.id === run.id)!.state).toBe("interrupted");
      const resolved = events(w, asking.id).filter((e) => e.type === "input_resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0].payload).toMatchObject({ inputId: run.pendingInput!.id, decision: "deny", by: "usman" });
      expect(events(w, asking.id).some((e) => e.type === "step" && /Your no was recorded, but the builder that asked is no longer running here/.test((e.payload as any).label))).toBe(true);
      // A second Deny finds nothing waiting and writes nothing more.
      expect(() => w.orch.respond(asking.id, run.roleId, run.pendingInput!.id, "deny")).toThrow(/isn't waiting for input/);
      expect(events(w, asking.id).filter((e) => e.type === "input_resolved")).toHaveLength(1);
    } finally { close(w); }
  });
  test("Stop on a job nobody holds settles at once: the job is cancelled and no run is left 'running'", async () => {
    const { w, reviewing } = await seededLive();
    try {
      const after = w.orch.cancel(reviewing.id);
      expect(after.state).toBe("cancelled");
      expect(after.runs.filter((r) => ["starting", "running", "needs_input"].includes(r.state))).toHaveLength(0);
      expect(after.runs.some((r) => r.state === "cancelled")).toBe(true);
    } finally { close(w); }
  });
});

describe("review finding 1: a Stop while Codex isolation is awaited launches nothing", () => {
  test("Stop during the isolation check: the run and job end cancelled and no Codex process is ever started", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({ codexIsolation: async () => { await gate; return { ok: true, message: "" }; } });
    try {
      const s = spec(w, { builderBinding: codexBinding("gpt-6-astra", "codex:openai-2", "0.154.0") as never });
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, (j) => j.runs.some((r) => r.state === "starting"), 60_000);
      const after = w.orch.cancel(job.id);
      expect(after.state).toBe("cancelled");
      release();
      await Bun.sleep(1200);
      expect(w.codexLaunched).toHaveLength(0);
      const final = w.store.getJob(job.id)!;
      expect(final.state).toBe("cancelled");
      expect(final.runs.every((r) => r.state === "cancelled")).toBe(true);
    } finally { close(w); }
  }, 120_000);
});

describe("review finding 2: reading a job never performs the merge", () => {
  test("GET /coding/jobs and GET /coding/jobs/:id do not reconcile approvals (a decision is acted on at start-up or by the owner's own 'merge it', never by a read)", async () => {
    const { codingRoute } = await import("./routes");
    const { DEFAULT_ACCOUNTS } = await import("./accounts");
    const w = world();
    try {
      gitIn(w.fx.canonical, "branch", "production", w.fx.baseSha);
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, (j) => settled(j) && !w.orch.running(job.id));
      await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER });
      let reconciled = 0;
      const orch = { ...w.orch, reconcileApprovals: () => { reconciled++; return 0; } };
      const rt = { store: w.store, orch, registry: () => w.registry, accounts: () => DEFAULT_ACCOUNTS, approvals: () => w.approvals, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }) } as never;
      const principal = { personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc", sessionId: "sk1.owner-session-key" } as never;
      const get = (path: string) => codingRoute({ method: "GET", path, url: new URL(`http://x${path}`), body: {}, principal }, rt);
      expect(((await get("/coding/jobs")) as { status: number }).status).toBe(200);
      expect(((await get(`/coding/jobs/${job.id}`)) as { status: number }).status).toBe(200);
      expect(reconciled).toBe(0);
    } finally { close(w); }
  }, 600_000);
});

describe("review finding 4: an in-turn answer is remembered only for the very same request", () => {
  test("the key covers the working directory, the grant root and the whole input (no truncation)", () => {
    const base = requestKey("codex", "item/fileChange/requestApproval", "/wt/a", { paths: ["a.ts"], grantRoot: null });
    expect(requestKey("codex", "item/fileChange/requestApproval", "/wt/a", { paths: ["a.ts"], grantRoot: null })).toBe(base);
    expect(requestKey("codex", "item/fileChange/requestApproval", "/wt/b", { paths: ["a.ts"], grantRoot: null })).not.toBe(base); // another worktree
    expect(requestKey("codex", "item/fileChange/requestApproval", "/wt/a", { paths: ["a.ts"], grantRoot: "/wt" })).not.toBe(base); // a wider grant
    const long = "x".repeat(25_000);
    expect(requestKey("claude", "Bash", "/wt/a", { command: `${long}1` })).not.toBe(requestKey("claude", "Bash", "/wt/a", { command: `${long}2` }));
  });
  test("through the queue: two requests identical for 20,000 characters and different after are each put to the owner", () => {
    const seen: RunnerEvent[] = [];
    const q = inputQueue((e) => seen.push(e), 60_000);
    const card = (id: string) => ({ id, kind: "approval" as const, nativeKind: "Bash", title: "Allow Bash?", detail: "x", escalatedBecause: "x", expiresAt: new Date(Date.now() + 60_000).toISOString() as never });
    const long = "x".repeat(25_000);
    q.push(card("r1"), () => undefined, requestKey("claude", "Bash", "/wt/a", { command: `${long}1` }));
    q.respond("r1", "approve");
    q.push(card("r2"), () => undefined, requestKey("claude", "Bash", "/wt/a", { command: `${long}2` }));
    expect(seen.filter((e) => e.type === "input")).toHaveLength(2);
    q.clear();
  });
});

describe("review finding 5: the live coding seed writes only beside the gate seed's marker", () => {
  test("by hand against a store with no marker next to it, it refuses and writes nothing", () => {
    const w = world();
    try {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "dev-seed.ts")], { env: { ...process.env, CODING_DATA_DIR: w.dataDir, CODING_SEED_PHASE: "live" }, stderr: "pipe" });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toMatch(/only runs beside the gate seed's marker/);
      expect(w.store.listJobs({ limit: 20 })).toHaveLength(0);
    } finally { close(w); }
  });
});
