// The command service's coding turn: typed and spoken words reach the coding entry with the VERIFIED caller, a non-coding turn
// falls through, a money-worded request never reaches it, and nothing here starts a job. Synthetic; no model, no device.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { createCommandService, type Delegates } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };
const program: Principal = { personId: "usman", via: "loopback-owner", actor: "process", displayName: "Usman" };

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

function rig(reply: (u: string) => { say: string; navigate?: string; jobId?: string; jobState?: string } | null) {
  const dir = mkdtempSync(join(tmpdir(), "coding-delegate-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  cleanups.push(() => { try { jobs.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); });
  const calls: Array<{ utterance: string; personId: string; actor: string; via: string; spokenYes: string | null }> = [];
  const coding: NonNullable<Delegates["coding"]> = async (utterance, turn) => (calls.push({ utterance, ...turn }), reply(utterance));
  const service = createCommandService({
    jobs: () => jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "no device in this test" }),
    delegates: { coding }, graceMs: 50, dedupeMs: 0,
  });
  const say = (principal: Principal, utterance: string, body: Record<string, unknown> = {}) => service.run({ principal, body: { utterance, source: "typed", ...body } });
  return { calls, say };
}

const DRAFT = { say: "Drafted. Codex builds, Opus reviews. Start it?", navigate: "/coding", jobId: "11111111-2222-3333-4444-555555555555", jobState: "awaiting_confirmation" };

describe("coding words through the command service", () => {
  test("'assign a builder to fix X and a reviewer to check it' is handed to the coding entry with the verified caller, and starts nothing", async () => {
    const { calls, say } = rig((u) => (/assign a builder/i.test(u) ? DRAFT : null));
    const done = await say(mehroz, "Jarvis, assign a builder to fix the calls table and a reviewer to check it", { spokenYes: "y1" });
    expect(calls).toEqual([{ utterance: "Jarvis, assign a builder to fix the calls table and a reviewer to check it", personId: "mehroz", actor: "human", via: "tailnet", spokenYes: "y1" }]);
    expect(done.ok).toBe(true);
    expect(done.said).toContain("Start it?");
    expect(done.navigate?.path).toBe("/coding");
    expect(done.numbers).toMatchObject({ codingJobId: DRAFT.jobId, codingJobState: "awaiting_confirmation" });
  });

  test("the caller is the principal, never the words: 'as usman' from Mehroz is still mehroz; a program is a process", async () => {
    const { calls, say } = rig(() => DRAFT);
    await say(mehroz, "assign a builder as usman to fix the calls table and a reviewer to check it");
    await say(program, "assign a builder to fix the calls table and a reviewer to check it");
    expect(calls.map((c) => [c.personId, c.actor, c.via])).toEqual([["mehroz", "human", "tailnet"], ["usman", "process", "local"]]);
  });

  test("a turn the coding entry doesn't own carries on to the other rules", async () => {
    const { calls, say } = rig(() => null);
    const done = await say(usman, "open the receptionist page");
    expect(calls.length).toBe(1);
    expect(done.kind).toBe("navigate");
  });

  test("a money-worded request never reaches the coding entry", async () => {
    const { calls, say } = rig(() => DRAFT);
    await say(usman, "pay the invoice from the bank with a builder and reviewer");
    expect(calls.length).toBe(0);
  });
});
