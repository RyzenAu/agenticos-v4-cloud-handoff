import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyJobEvents, decisionFromStep, focusJob, JOB_LINGER_MS, progressFromJob } from "../../src/lib/job-events";
import { parseProgress } from "../../src/components/shell/jarvis-progress";
import { createRunLog } from "../screen-hands/run-log";
import { mirrorRunLog } from "./mirror-run-log";
import { JobService, type JobSummary, type Step } from "./service";

let dir: string;
let jobs: JobService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-mirror-"));
  jobs = new JobService({ path: join(dir, "jobs.sqlite"), kill: async () => true });
});
afterEach(() => {
  jobs.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* WAL */
  }
});

describe("screen run log → the one job history", () => {
  test("a voice run becomes a screen job with masked steps, Jev decisions and its outcome", () => {
    const log = createRunLog();
    const off = mirrorRunLog(log, jobs);
    const run = log.start({ request: "email bob@example.com the report", source: "voice", executor: "uia" });
    run.step({ stage: "decision", text: "Jev: click Send", jev: { op: "click", confidence: 0.82, policy: "act", ms: 410, inputTokens: 900, outputTokens: 12 } });
    run.step({ stage: "check", text: "Sent folder shows it", verified: true });
    run.end({ ok: true, said: "Sent." });
    off();
    const [summary] = jobs.list();
    expect(summary).toMatchObject({ kind: "screen", state: "succeeded", stepCount: 2, targetDeviceId: "usman-pc", principal: { personId: "usman" } });
    expect(summary.title).not.toContain("bob@example.com");
    const job = jobs.get(summary.id)!;
    expect(job.steps[0].jev).toMatchObject({ op: "click", confidence: 0.82, policy: "act" });
    expect(job.steps[1].verification).toEqual({ method: "deterministic-check", ok: true });
  });

  test("an away run is an away job; a run that asks waits for a yes and a newer request supersedes it", () => {
    const log = createRunLog();
    mirrorRunLog(log, jobs);
    const a = log.start({ request: "delete the old draft", source: "away" });
    a.end({ ok: false, said: "Needs your code", ask: true });
    expect(jobs.list()[0]).toMatchObject({ kind: "away", state: "awaiting-approval" });
    const b = log.start({ request: "open notepad", source: "voice" });
    b.end({ ok: false, said: "Stopped", stopped: true });
    const states = Object.fromEntries(jobs.list().map((j) => [j.kind, j.state]));
    expect(states).toEqual({ away: "interrupted", screen: "cancelled" });
  });

  test("review item 9: the run that follows a yes continues the waiting job instead of marking it interrupted", () => {
    const log = createRunLog();
    mirrorRunLog(log, jobs);
    const ask = log.start({ request: "send the invoice email", source: "voice" });
    ask.end({ ok: false, said: "Shall I press Send?", ask: true });
    const press = log.start({ request: "send the invoice email", source: "voice" });
    press.step({ stage: "act", text: "Pressed Send", verified: true });
    press.end({ ok: true, said: "Sent." });
    const list = jobs.list();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ state: "succeeded", stepCount: 1 });
  });

  test("review item 3: steps mask OTPs, dotted cards, full-width e-mails, away codes and typed payloads", () => {
    const log = createRunLog();
    mirrorRunLog(log, jobs);
    const run = log.start({ request: "x", source: "voice" });
    for (const text of ["OTP 123456", "card 4111.1111.1111.1111", "ｂｏｂ＠example.com", "code AB3D", 'type "my secret" into Notes', "typed hunter2 into Password", "PIN 4821"])
      run.step({ stage: "note", text });
    run.end({ ok: true, said: "ok" });
    const dump = JSON.stringify(jobs.get(jobs.list()[0].id)!.steps);
    for (const leak of ["123456", "4111", "example.com", "AB3D", "my secret", "hunter2", "4821"]) expect(dump).not.toContain(leak);
  });

  test("a store failure never breaks the run", () => {
    const log = createRunLog();
    const ro = new JobService({ path: join(dir, "jobs.sqlite"), readOnly: true });
    mirrorRunLog(log, ro);
    const run = log.start({ request: "x", source: "voice" });
    expect(() => run.end({ ok: true, said: "ok" })).not.toThrow();
    ro.close();
  });
});

describe("job events → jarvis:progress and jarvis:decision", () => {
  const now = Date.parse("2026-09-28T04:00:00Z");
  const base: JobSummary = {
    id: "5b0a3c7e-1111-4222-8333-444455556666", kind: "screen", principal: { personId: "usman", via: "loopback-owner" }, targetDeviceId: "usman-pc",
    state: "running", title: "Type 'my card is 4111 1111 1111 1111' into Notes", cancelRequested: false, quarantined: false,
    createdAt: new Date(now - 5_000).toISOString(), updatedAt: new Date(now - 1_000).toISOString(), stepCount: 2,
    lastStep: { seq: 2, at: now - 1_000, intent: "Typing into Notes", executor: "uia", ms: 10, outcome: "ok" },
  };

  test("progress maps states truthfully and passes the chip's own validation", () => {
    const running = progressFromJob(base);
    expect(running).toMatchObject({ phase: "acting", step: { index: 2, text: "Typing into Notes" }, taskId: base.id });
    expect(running.label).not.toContain("4111");
    expect(parseProgress(running)).toMatchObject({ phase: "acting" });
    expect(progressFromJob({ ...base, state: "awaiting-approval" })).toMatchObject({ phase: "needs-you", label: "Waiting for your yes" });
    expect(progressFromJob({ ...base, state: "unknown" })).toMatchObject({ phase: "error", label: "Outcome unknown" });
    expect(progressFromJob({ ...base, state: "interrupted" })).toMatchObject({ phase: "error", label: "Interrupted, not re-run" });
    expect(progressFromJob({ ...base, state: "succeeded" }).phase).toBe("done");
  });

  test("focus: active first, then a live question, then a recent finish; old finishes fall away", () => {
    const done = { ...base, id: "a", state: "succeeded" as const, updatedAt: new Date(now - 10_000).toISOString() };
    const run = { ...base, id: "b", state: "running" as const, updatedAt: new Date(now - 60_000).toISOString() };
    expect(focusJob([done, run], now)!.id).toBe("b");
    expect(focusJob([done], now)!.id).toBe("a");
    expect(focusJob([{ ...done, updatedAt: new Date(now - JOB_LINGER_MS - 1).toISOString() }], now)).toBeNull();
    const asking = { ...base, id: "c", state: "awaiting-approval" as const, updatedAt: new Date(now - 30_000).toISOString() };
    expect(focusJob([done, asking], now)!.id).toBe("c");
    expect(focusJob([{ ...asking, updatedAt: new Date(now - 5 * 60_000).toISOString() }], now)).toBeNull();
  });

  test("a Jev step becomes one keyed Inspector decision; other steps don't", () => {
    const step: Step = { seq: 3, at: now, intent: "Pick the Send button", executor: "uia", ms: 400, outcome: "ok", jev: { op: "click", confidence: 1.4, policy: "act" } };
    expect(decisionFromStep(base, step)).toMatchObject({ title: "click → act", confidence: 1, source: "jev", key: `job:${base.id}:3` });
    expect(decisionFromStep(base, { ...step, jev: undefined })).toBeNull();
  });

  test("applyJobEvents folds job and step events, dedupes steps and bounds the map", () => {
    let map = applyJobEvents(new Map(), [{ seq: 1, at: now, type: "job", jobId: base.id, job: base }]);
    const step: Step = { seq: 3, at: now, intent: "x", executor: "uia", ms: 1, outcome: "ok" };
    map = applyJobEvents(map, [{ seq: 2, at: now, type: "step", jobId: base.id, step }, { seq: 3, at: now, type: "step", jobId: base.id, step }]);
    expect(map.get(base.id)!.steps.length).toBe(1);
    expect(map.get(base.id)!.stepCount).toBe(3);
    const many = Array.from({ length: 50 }, (_, i) => ({ seq: 10 + i, at: now, type: "job" as const, jobId: `j${i}`, job: { ...base, id: `j${i}`, updatedAt: new Date(now + i).toISOString() } }));
    expect(applyJobEvents(map, many).size).toBe(40);
  });

  test("end to end: a job run in the service yields events the client maps to progress", async () => {
    const principal = { personId: "usman" as const, via: "loopback-owner" as const };
    const job = jobs.create({ kind: "memory", principal, targetDeviceId: "usman-pc", title: "Forget the old pricing note" });
    await jobs.run(job.id, async (ctx) => {
      ctx.step({ intent: "Plan the forget", executor: "memory-connector", ms: 3, outcome: "ok", jev: { op: "forget", confidence: 0.9, policy: "ask" } });
      return { ok: true };
    });
    const map = applyJobEvents(new Map(), jobs.events(0).events);
    const j = map.get(job.id)!;
    expect(j.state).toBe("succeeded");
    expect(progressFromJob(j).phase).toBe("done");
    expect(decisionFromStep(j, j.steps[0])).toMatchObject({ title: "forget → ask" });
  });
});
