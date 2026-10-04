// Round 11 final review B1: a Stop by event id before the job id reached the client. Some lanes start real work before a job exists in the job
// service (a coding "start it", an agent, a shared computer). Before: cancelEvent answered "prevented" whenever no command job existed, the coding
// job started anyway, and the UI said "Stopped before it started. Nothing ran." while it ran. Now: every such lane checks the stop just before it
// calls out; while the event's run is in progress the stop is "unconfirmed" (never "prevented"); and work a lane started during the stop is
// stopped and reported as it really ended. Synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { createCommandService, type Delegates } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const JOB = "c0d1e2f3-1111-4222-8333-944445555666";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

function rig(opts: { slow?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stop-lanes-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  cleanups.push(() => { try { jobs.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); });
  let release: () => void = () => undefined;
  const entered = new Promise<void>((r) => (release = r));
  let gate: () => void = () => undefined;
  const held = new Promise<void>((r) => (gate = r));
  const calls: string[] = [];
  const coding: NonNullable<Delegates["coding"]> = async (utterance) => {
    calls.push(utterance);
    if (/^stop the coding job /.test(utterance)) return { say: "Stopped the coding job. Its working copies are kept.", jobId: JOB };
    release();
    if (opts.slow) await held;
    return { say: "Started. I'll keep the progress on screen.", jobId: JOB, jobState: "building", started: true };
  };
  const service = createCommandService({ jobs: () => jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "none" }), delegates: { coding, codingMatches: () => true }, graceMs: 50, dedupeMs: 0 });
  return { service, calls, entered, gate: () => gate() };
}

describe("Stop by event id against a lane that starts work before a job exists", () => {
  test("Stop arriving while 'start it' is starting the coding job: 'unconfirmed' (never 'prevented'); the job it started is stopped and the reply says so", async () => {
    const r = rig({ slow: true });
    const run = r.service.run({ principal: usman, body: { utterance: "start it", source: "typed", eventId: "evt-lane-1" } });
    await r.entered;
    const stop = await r.service.cancelEvent("evt-lane-1", usman);
    expect(stop.outcome).toBe("unconfirmed");
    expect(stop.ok).toBe(false);
    r.gate();
    const done = await run;
    expect(done.said).toBe("Your stop arrived as it was starting. Stopped the coding job. Its working copies are kept.");
    expect(done.said).not.toContain("Nothing ran");
    expect(r.calls).toEqual(["start it", `stop the coding job ${JOB}`]);
  });

  test("Stop recorded before the run reaches the coding lane: the coding harness is never called, and it's 'stopped before it started'", async () => {
    const r = rig();
    const stop = await r.service.cancelEvent("evt-lane-2", usman);
    expect(stop.outcome).toBe("prevented");
    const done = await r.service.run({ principal: usman, body: { utterance: "start it", source: "typed", eventId: "evt-lane-2" } });
    expect(done.said).toBe("Stopped before it started. Nothing ran.");
    expect(r.calls).toEqual([]);
  });
});
