// Round 11 (defect 2), the command service's side: a Stop while the coding planner's question is pending skips Jev and reaches the coding harness,
// which drops the question. The bare whole-request Stop ("stop", "never mind") is answered before any coding words, so it drops the question too.
// Typed vs spoken (defect 5) rides on the coding turn. Synthetic; no model, no device.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { createCommandService, type Delegates } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

function rig(opts: { pending: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "stop-pending-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  cleanups.push(() => { try { jobs.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); });
  let pending = opts.pending;
  const calls: Array<{ utterance: string; channel?: string }> = [];
  const dropped: string[] = [];
  const coding: NonNullable<Delegates["coding"]> = async (utterance, turn) => {
    calls.push({ utterance, channel: turn.channel });
    if (pending) { pending = false; return { say: "Okay, I've dropped that coding request and its question. Nothing was started." }; }
    return null;
  };
  const delegates: Delegates = {
    coding,
    codingCancelPending: async (turn) => { dropped.push(turn.personId); const was = pending; pending = false; return was; },
    codingPendingQuestion: async () => pending,
  };
  const service = createCommandService({ jobs: () => jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "no device in this test" }), delegates, graceMs: 50, dedupeMs: 0 });
  const say = (utterance: string, source: "typed" | "voice" = "typed") => service.run({ principal: usman, body: { utterance, source } });
  return { calls, dropped, say, pending: () => pending };
}

describe("Stop while the coding planner's question is pending", () => {
  test("'please stop the coding job' and 'cancel the draft' go straight to the coding harness (a Stop skips Jev) and drop the question", async () => {
    for (const words of ["please stop the coding job", "cancel the draft"]) {
      const r = rig({ pending: true });
      const done = await r.say(words);
      expect([words, r.calls.map((c) => c.utterance)]).toEqual([words, [words]]);
      expect(done.said).toBe("Okay, I've dropped that coding request and its question. Nothing was started.");
      expect(done.decision?.op).toBe("coding.stop");
      expect(r.pending()).toBe(false);
    }
  });

  test("the bare Stop ('stop', 'never mind', 'stop that') drops the pending question as well as stopping commands", async () => {
    for (const words of ["stop", "never mind", "stop that"]) {
      const r = rig({ pending: true });
      const done = await r.say(words);
      expect(done.stopped).toBe(true);
      expect([words, r.dropped]).toEqual([words, ["usman"]]);
      expect(done.said).toMatch(/dropped the coding request/);
      expect(r.pending()).toBe(false);
    }
  });

  test("with nothing pending, a bare Stop says so as before and the coding harness isn't asked to stop anything", async () => {
    const r = rig({ pending: false });
    const done = await r.say("stop");
    expect(done.said).toBe("Nothing of yours was running.");
    expect(r.calls).toEqual([]);
  });
});

describe("review follow-ups (round 11)", () => {
  test("'forget it' / 'hold on' while the planner's either/or question is pending is the answer, never a stop", async () => {
    for (const words of ["forget it", "hold on"]) {
      const r = rig({ pending: true });
      const done = await r.say(words);
      expect([words, r.calls.map((c) => c.utterance)]).toEqual([words, [words]]);
      expect(done.stopped).toBeUndefined();
      expect(r.dropped).toEqual([]);
    }
  });

  test("with nothing pending, 'forget it' is still the whole-request Stop", async () => {
    const r = rig({ pending: false });
    const done = await r.say("forget it");
    expect(done.stopped).toBe(true);
    expect(r.calls).toEqual([]);
  });
});
