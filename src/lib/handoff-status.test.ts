// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { handoffJob, handoffStatus, latestKindFor, openJobs, type ThreadLine } from "./handoff-status";

const A = "b4b4ce6c-0000-4000-8000-000000000001";
const B = "adeb5a02-0000-4000-8000-000000000002";
const line = (id: string, key: string, text = ""): ThreadLine => ({ role: "oracle", text, via: `job:${id}:${key}` });

describe("a hand-off row follows its job through the conversation (production, 4 Oct: a stopped job said Done)", () => {
  const started = "Research started: research the super rate. It runs on its own computer. (job b4b4ce6c)";
  test("stopped, finished, failed and unclear jobs say so; only a finished job is Done-like", () => {
    expect(handoffStatus("done", "Done", started, [line(A, "started"), line(A, "cancelled")])).toEqual({ phase: "waiting", word: "Stopped" });
    expect(handoffStatus("done", "Done", started, [line(A, "started"), line(A, "succeeded")])).toEqual({ phase: "done", word: "Finished" });
    expect(handoffStatus("done", "Done", started, [line(A, "started"), line(A, "failed")])).toEqual({ phase: "failed", word: "Failed" });
    expect(handoffStatus("done", "Done", started, [line(A, "started"), line(A, "interrupted")])).toEqual({ phase: "waiting", word: "Outcome unclear" });
  });
  test("a job still going is Running; one the thread hasn't shown yet is Handed off, never Done", () => {
    expect(handoffStatus("done", "Done", started, [line(A, "started"), line(A, "step:1")])).toEqual({ phase: "running", word: "Running" });
    expect(handoffStatus("done", "Done", started, [])).toEqual({ phase: "waiting", word: "Handed off" });
  });
  test("a hand-off with no job, or not ended, keeps the feed's own word", () => {
    expect(handoffStatus("done", "Done", "www.youtube.com is open in the browser.", [])).toEqual({ phase: "done", word: "Done" });
    expect(handoffStatus("running", "Running", started, [line(A, "cancelled")])).toEqual({ phase: "running", word: "Running" });
    expect(handoffStatus("failed", "Failed", undefined, [])).toEqual({ phase: "failed", word: "Failed" });
  });
  test("the job is read from the result's (job …) tail; another job's entries don't count", () => {
    expect(handoffJob(started)).toBe("b4b4ce6c");
    expect(handoffJob("Opened YouTube.")).toBeNull();
    expect(latestKindFor([line(B, "started"), line(B, "succeeded")], "b4b4ce6c")).toBeNull();
  });
});

describe("which jobs get a Stop button in the conversation", () => {
  test("started and not ended; an ended job has none; progress keeps it open", () => {
    expect([...openJobs([line(A, "started"), line(A, "step:2"), line(B, "started"), line(B, "succeeded")])]).toEqual([A]);
    expect([...openJobs([line(A, "started"), line(A, "cancelled")])]).toEqual([]);
    expect([...openJobs([{ role: "user", text: "hello" }])]).toEqual([]);
  });
});

describe("Stop from the conversation says what the hub confirmed", () => {
  test("confirmed, already ended, unconfirmed, and a coding job through its own stop", async () => {
    const { stopJobFromThread } = await import("./thread-stop");
    const cancel = (outcome: string, state?: string) => (async () => ({ outcome, state })) as never;
    expect(await stopJobFromThread(A, { cancel: cancel("stopped", "cancelled") })).toBe("Stopped.");
    expect(await stopJobFromThread(A, { cancel: cancel("already-ended", "succeeded") })).toBe("It had already finished before the stop arrived.");
    expect(await stopJobFromThread(A, { cancel: cancel("unconfirmed") })).toContain("Stop requested; not yet confirmed");
    expect(await stopJobFromThread(A, { cancel: cancel("unreachable") })).not.toMatch(/^Stopped\./);
    expect(await stopJobFromThread(A, { cancel: cancel("no-job"), coding: async () => ({ job: { state: "cancelled" } }) })).toBe("Stopped.");
    expect(await stopJobFromThread(A, { cancel: cancel("no-job"), coding: async () => ({ job: { state: "building" } }) })).toContain("Stop requested; not yet confirmed");
    expect(await stopJobFromThread(A, { cancel: cancel("no-job"), coding: async () => { throw new Error("x"); } })).toContain("not yet confirmed");
  });
});
