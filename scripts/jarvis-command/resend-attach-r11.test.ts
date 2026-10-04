// Round 11 review M3: a resend of the same event id while the first run is still going used to await the final result without ever passing on
// the `job` event, so a Stop on the resend had no job id: it sent no cancel and said "Stopped." while the job ran on. Now the resend replays
// the first run's stream (job event first) and follows it live, so the client can cancel by id. Synthetic.
import { describe, expect, test } from "bun:test";
import type { CommandDoneEvent, CommandStreamEvent } from "./contracts";
import { createLinkedRunner } from "./linked-run";
import { JobService } from "../jobs/service";

const principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" } as never;
const DONE: CommandDoneEvent = { type: "done", ok: true, said: "Opened it.", kind: "app", jobId: "job-1", runId: "", targetDeviceId: "hub" };

describe("a resend follows the first run's stream", () => {
  test("the resend sees the job event (replayed), later events live, and the done once; the command runs once", async () => {
    let release!: () => void;
    let runs = 0;
    const jobs = new JobService({ path: ":memory:", snapshotMs: 0 });
    const run = createLinkedRunner({
      core: async (_input, emit) => {
        runs++;
        emit({ type: "job", jobId: "job-1", targetDeviceId: "hub", seq: 0 });
        await new Promise<void>((r) => (release = r));
        emit({ type: "narrate", stage: "act", text: "Opening it.", seq: 1 });
        emit(DONE);
        return DONE;
      },
      jobs: () => jobs,
      isStop: () => false,
    });
    const first: CommandStreamEvent[] = [];
    const second: CommandStreamEvent[] = [];
    const body = { utterance: "open notepad", source: "typed" as const, eventId: "evt-resend-1" };
    const a = run({ principal, body }, (e) => first.push(e));
    await new Promise((r) => setTimeout(r, 5));
    const b = run({ principal, body }, (e) => second.push(e));
    await new Promise((r) => setTimeout(r, 5));
    expect(second.map((e) => e.type)).toEqual(["job"]);
    release();
    const [da, db] = await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(da.said).toBe("Opened it.");
    expect(db.said).toBe("Opened it.");
    expect(second.map((e) => e.type)).toEqual(["job", "narrate", "done"]);
    expect(first.map((e) => e.type)).toEqual(["job", "narrate", "done"]);
    jobs.close();
  });
});
