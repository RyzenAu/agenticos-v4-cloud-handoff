import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../approvals/principal";
import { ApprovalService } from "../approvals/service";
import { JobService } from "../jobs/service";
import type { AgencyFeedState } from "../receptionist/types";
import type { ActionDef } from "./actions";
import { BUILT_IN_ACTIONS } from "./actions";
import { tickRoutines } from "./routines";
import { slotsBetween, zonedToUtc } from "./schedule";
import { createTriggerService, SEED_IDS, type TriggerService } from "./service";
import { flagEvents, pollReceptionistFlags, syntheticEnquiry } from "./sources";
import { dedupeKey, safeFields, TriggerStore } from "./store";

const owner: Principal = { personId: "usman", via: "telegram-owner" };
let dir: string;
let clock: number;
const closers: Array<() => void> = [];

type Rig = { svc: TriggerService; jobs: JobService; approvals: ApprovalService; codes: string[]; close: () => void };
function rig(extra: { actions?: ActionDef[]; backoff?: (n: number) => number; deps?: Parameters<typeof createTriggerService>[0]["deps"]; feed?: Parameters<typeof createTriggerService>[0]["feed"] } = {}): Rig {
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), now: () => clock, kill: async () => true, stopGraceMs: 50, accounting: async () => [{ pid: process.pid, ppid: 0, created: 0 }] });
  const approvals = new ApprovalService({ path: join(dir, "approvals.sqlite"), now: () => clock });
  const codes: string[] = [];
  const svc = createTriggerService({
    path: join(dir, "triggers.sqlite"), jobs, approvals, now: () => clock, deps: extra.deps ?? { briefSummary: async () => ({ counts: { priorities: 3, leads: 2 } }) },
    feed: extra.feed, notifyCode: (c) => codes.push(c), retryBackoffMs: extra.backoff ?? (() => 60_000),
  });
  if (extra.actions) (svc.engine as unknown as { actions: Map<string, ActionDef> }).actions = new Map(extra.actions.map((a) => [a.id, a]));
  const close = () => {
    svc.close();
    try { jobs.close(); } catch { /* a job is still running */ }
    approvals.close();
  };
  closers.push(close);
  return { svc, jobs, approvals, codes, close };
}
const answer = (r: Rig, approvalId: string, code: string) => r.approvals.decide(approvalId, owner, "approve", { telegramCode: code });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trg-"));
  clock = Date.parse("2026-10-01T00:00:00Z");
});
afterEach(() => {
  for (const c of closers.splice(0)) {
    try { c(); } catch { /* already closed */ }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL handle */ }
});

describe("synthetic enquiry journey", () => {
  test("a new enquiry becomes ONE job, replays are deduplicated, sending needs approval and nothing is sent", async () => {
    const r = rig();
    const first = await r.svc.engine.deliver(syntheticEnquiry("ENQ-1001", "Urgent: swollen gum"));
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("job");
    const jobId = (first[0] as { jobId: string }).jobId;
    const job = r.jobs.get(jobId)!;
    expect(job.kind).toBe("trigger");
    // processed, drafted, and now waiting on the owner for the one external step
    expect(job.state).toBe("awaiting-approval");
    expect(job.steps.map((s) => s.intent).join(" | ")).toContain("Classified as urgent");
    expect(job.steps.map((s) => s.intent).join(" | ")).toContain("Not sent");
    const pending = r.approvals.list({ state: "pending" });
    expect(pending.map((a) => a.action)).toEqual(["message.send"]);
    expect(pending[0].requester.actor).toBe("process");
    // Replays (the same event again, three times) are one delivery and one job.
    for (let i = 0; i < 3; i++) expect((await r.svc.engine.deliver(syntheticEnquiry("ENQ-1001", "Urgent: swollen gum")))[0]).toMatchObject({ status: "duplicate", jobId });
    expect(r.jobs.list({ kind: "trigger" })).toHaveLength(1);
    const delivery = r.svc.detail(SEED_IDS.enquiry).deliveries[0];
    expect(delivery).toMatchObject({ status: "awaiting-approval", repeats: 3, attempts: 1, jobId });
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)!.stats).toMatchObject({ delivered: 1, duplicates: 3 });
    // The owner's code (as the Telegram DM would carry it) approves; the job settles and says nothing was sent.
    expect(r.codes).toHaveLength(1);
    expect(answer(r, pending[0].id, r.codes[0]).ok).toBe(true);
    await r.svc.engine.sweep();
    const done = r.jobs.get(jobId)!;
    expect(done.state).toBe("succeeded");
    expect(done.note).toContain("Nothing was sent");
    expect(r.svc.detail(SEED_IDS.enquiry).deliveries[0]).toMatchObject({ status: "succeeded", reason: "approved-not-sent" });
    // Approvals are single use: a second sweep does nothing.
    expect(await r.svc.engine.sweep()).toBe(0);
  });

  test("a rejected or expired approval cancels the job and sends nothing", async () => {
    const r = rig();
    const [res] = await r.svc.engine.deliver(syntheticEnquiry("ENQ-2", "Check-up"));
    const approval = r.approvals.list({ state: "pending" })[0];
    expect(r.approvals.decide(approval.id, owner, "reject").ok).toBe(true);
    await r.svc.engine.sweep();
    expect(r.jobs.get((res as { jobId: string }).jobId)!.state).toBe("cancelled");
    expect(r.svc.detail(SEED_IDS.enquiry).deliveries[0]).toMatchObject({ status: "rejected", reason: "approval-rejected" });
  });

  test("only ids, hashes and masked short fields are stored", async () => {
    const r = rig();
    await r.svc.engine.deliver(syntheticEnquiry("ENQ-3", "call me on 0412 345 678 or jo@example.com", { fields: { ref: "ENQ-3", topic: "call me on 0412 345 678 or jo@example.com", body: "x".repeat(500), nested: { a: 1 } } }));
    const stored = JSON.stringify(r.svc.detail(SEED_IDS.enquiry).deliveries[0]) + JSON.stringify(r.jobs.list({ kind: "trigger" })) + JSON.stringify(r.jobs.get(r.jobs.list()[0].id));
    expect(stored).not.toContain("345 678");
    expect(stored).not.toContain("jo@example.com");
    expect(stored).not.toContain("xxxxxxxx");
    expect(safeFields({ Bad: "nope", ref: "ok", n: 3, ok: true, long: "y".repeat(201) })).toEqual({ ref: "ok", n: 3, ok: true });
  });
});

describe("feedback-loop prevention", () => {
  test("what our own job produced, or an agent actor, never re-triggers", async () => {
    const r = rig();
    const [res] = await r.svc.engine.deliver(syntheticEnquiry("ENQ-9", "Whitening"));
    const jobId = (res as { jobId: string }).jobId;
    const before = r.jobs.list({ kind: "trigger" }).length;
    // "A draft was created" event about the draft our job wrote; a child version of it; an event our job id caused; an agent-authored event.
    const echoes = [
      syntheticEnquiry("draft:ENQ-9", "echo"),
      syntheticEnquiry("draft:ENQ-9:v2", "echo"),
      syntheticEnquiry("ENQ-9-reply", "echo", { originRef: "draft:ENQ-9" }),
      syntheticEnquiry("ENQ-9-update", "echo", { originRef: jobId }),
      syntheticEnquiry("ENQ-9-agent", "echo", { actor: "agent" }),
    ];
    const results = [];
    for (const e of echoes) results.push((await r.svc.engine.deliver(e))[0]);
    expect(results.map((x) => x.status)).toEqual(["ignored", "ignored", "ignored", "ignored", "ignored"]);
    expect(results.map((x) => (x as { reason: string }).reason)).toEqual(["self-output", "self-output", "self-output", "self-output", "agent-actor"]);
    expect(r.jobs.list({ kind: "trigger" }).length).toBe(before);
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)!.stats.ignored).toBe(5);
    // A genuinely new enquiry still works.
    expect((await r.svc.engine.deliver(syntheticEnquiry("ENQ-10", "Whitening")))[0].status).toBe("job");
  });

  test("a job id is recognised as ours even for a source that only knows the job", async () => {
    const r = rig();
    const [res] = await r.svc.engine.deliver(syntheticEnquiry("ENQ-11", "x"));
    expect(r.svc.store.isOwnOutput((res as { jobId: string }).jobId)).toBe(true);
    expect(r.svc.store.isOwnOutput("something-else")).toBe(false);
  });
});

describe("review mode (the real-source shape)", () => {
  const feed = (flags: { callId: string; codes: string[]; at?: string }[]): AgencyFeedState =>
    ({ ok: true, qaFlags: flags.map((f) => ({ severity: "medium", orgId: null, at: f.at ?? new Date(clock - 3600_000).toISOString(), ...f })) }) as unknown as AgencyFeedState;

  test("a paused source creates nothing; switched on, each flag is held for review and runs only once approved", async () => {
    const r = rig();
    const read = async () => feed([{ callId: "call_A1", codes: ["urgent-wording"] }, { callId: "call_A2", codes: ["no-handoff"] }]);
    // Seeded paused: the poller isn't even consulted by tick(); a direct poll creates nothing.
    expect((await pollReceptionistFlags(r.svc.engine, read, { now: clock })).jobs).toBe(0);
    r.svc.setState(SEED_IDS.flags, "active");
    const poll = await pollReceptionistFlags(r.svc.engine, read, { now: clock });
    expect(poll).toMatchObject({ ok: true, seen: 2, jobs: 2, duplicates: 0 });
    // Polling again (the same open flags) is all duplicates.
    expect(await pollReceptionistFlags(r.svc.engine, read, { now: clock })).toMatchObject({ jobs: 0, duplicates: 2 });
    const jobs = r.jobs.list({ kind: "trigger" });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.state === "awaiting-approval")).toBe(true);
    // Held: the action has not run (no review step, nothing in the ledger).
    expect(r.jobs.get(jobs[0].id)!.steps.map((s) => s.intent).join()).toContain("Held for the owner");
    expect(r.svc.store.isOwnOutput("review:call_A1")).toBe(false);
    const approvals = r.approvals.list({ state: "pending" });
    expect(approvals.map((a) => a.action)).toEqual(["trigger.review", "trigger.review"]);
    // Approve the first, reject the second.
    expect(answer(r, approvals.find((a) => a.summary.includes("call_A1"))!.id, r.codes[0]).ok).toBe(true);
    expect(r.approvals.decide(approvals.find((a) => a.summary.includes("call_A2"))!.id, owner, "reject").ok).toBe(true);
    await r.svc.engine.sweep();
    const states = Object.fromEntries(r.jobs.list({ kind: "trigger" }).map((j) => [j.title.slice(-8), j.state]));
    expect(Object.values(states).sort()).toEqual(["cancelled", "succeeded"]);
    expect(r.svc.store.isOwnOutput("review:call_A1")).toBe(true);
    expect(r.svc.store.isOwnOutput("review:call_A2")).toBe(false);
  });

  test("a feed without a qaFlags list falls back to flagged calls, projected to id, codes and band only", () => {
    const calls = [
      { id: "call_F1", organizationId: "org1", startedAt: new Date(clock - 3600_000).toISOString(), summary: "Caller Jo asked about ...", callerMasked: "••• 123", qa: { flagCount: 2, topBand: "high", reviewStatus: null, flagCodes: ["urgent-wording", "no-handoff"] } },
      { id: "call_F2", organizationId: "org1", startedAt: new Date(clock - 3600_000).toISOString(), summary: "fine", qa: { flagCount: 0, topBand: null, reviewStatus: null, flagCodes: [] } },
    ];
    const events = flagEvents({ ok: true, qaFlags: null, calls } as unknown as AgencyFeedState, { now: clock });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: "call_F1:no-handoff+urgent-wording", fields: { callId: "call_F1", codes: "no-handoff,urgent-wording", severity: "high" } });
    expect(JSON.stringify(events)).not.toContain("Caller Jo");
    expect(JSON.stringify(events)).not.toContain("123");
  });

  test("an unreadable feed is a clear failure, never zero flags; old flags are skipped; the poll is capped", async () => {
    const r = rig();
    r.svc.setState(SEED_IDS.flags, "active");
    expect(await pollReceptionistFlags(r.svc.engine, async () => ({ ok: false, reason: "Agency feed not configured" }), { now: clock })).toMatchObject({ ok: false, reason: "Agency feed not configured" });
    const many = feed(Array.from({ length: 30 }, (_, i) => ({ callId: `c${i}`, codes: ["x"], at: i === 0 ? new Date(clock - 3 * 86400_000).toISOString() : undefined })));
    expect(flagEvents(many, { now: clock })).toHaveLength(10);
    expect(flagEvents(many, { now: clock }).some((e) => e.eventId.startsWith("c0:"))).toBe(false);
  });
});

describe("failure is visible and safe", () => {
  const boom = (name = "boom"): ActionDef => ({ id: "lead.process", effect: "none", label: name, run: async () => { throw new Error("token=sk-SECRETSECRET1234 leaked from provider"); } });

  test("retry limit, then a visible failed state; the exception text is never stored; manual retry makes a new linked job", async () => {
    const r = rig({ actions: [boom()] });
    const [res] = await r.svc.engine.deliver(syntheticEnquiry("ENQ-20", "x"));
    expect(res.status).toBe("job");
    let d = r.svc.detail(SEED_IDS.enquiry).deliveries[0];
    expect(d).toMatchObject({ status: "retrying", attempts: 1, reason: "action-failed" });
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)!.health).toBe("active"); // still retrying, not yet failing
    await r.svc.tick();
    expect(r.svc.detail(SEED_IDS.enquiry).deliveries[0].attempts).toBe(1); // backoff not due
    clock += 61_000;
    await r.svc.tick();
    clock += 61_000;
    await r.svc.tick();
    d = r.svc.detail(SEED_IDS.enquiry).deliveries[0];
    expect(d).toMatchObject({ status: "failed", attempts: 3 });
    expect(d.jobs).toHaveLength(3);
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)!.health).toBe("failing");
    const dump = JSON.stringify([r.jobs.list({ kind: "trigger" }), d, r.jobs.get(d.jobs[0].jobId)]);
    expect(dump).not.toContain("SECRET");
    expect(r.jobs.list({ kind: "trigger" }).every((j) => j.state === "failed")).toBe(true);
    // No further automatic attempts.
    clock += 3600_000;
    await r.svc.tick();
    expect(r.svc.detail(SEED_IDS.enquiry).deliveries[0].attempts).toBe(3);
    // Manual retry (the action works now).
    (r.svc.engine as unknown as { actions: Map<string, ActionDef> }).actions.set("lead.process", BUILT_IN_ACTIONS[0]);
    const retried = await r.svc.engine.retry(d.id);
    expect(retried).toMatchObject({ status: "awaiting-approval", attempts: 4 });
    expect(retried!.jobs).toHaveLength(4);
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)!.health).toBe("active");
  });

  test("an unknown outcome is never retried automatically, only by the owner", async () => {
    const r = rig();
    const [res] = await r.svc.engine.deliver(syntheticEnquiry("ENQ-21", "x"));
    const jobId = (res as { jobId: string }).jobId;
    // Simulate the hub dying mid-run: the delivery says running, the job is left 'unknown' by recovery.
    const id = r.svc.detail(SEED_IDS.enquiry).deliveries[0].id;
    r.svc.store.patch(id, { status: "running" });
    (r.jobs as unknown as { db: { query(s: string): { run(...a: unknown[]): void } } }).db.query("UPDATE jobs SET state='unknown' WHERE id=?").run(jobId);
    await r.svc.tick();
    expect(r.svc.detail(SEED_IDS.enquiry).deliveries[0]).toMatchObject({ status: "unknown", reason: "outcome-unknown" });
    clock += 3600_000;
    await r.svc.tick();
    expect(r.svc.detail(SEED_IDS.enquiry).deliveries[0].status).toBe("unknown");
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)!.health).toBe("failing");
    expect((await r.svc.engine.retry(id))!.attempts).toBe(2);
  });

  test("paused and disabled triggers create no jobs; pause is visible", async () => {
    const r = rig();
    r.svc.setState(SEED_IDS.enquiry, "paused");
    expect((await r.svc.engine.deliver(syntheticEnquiry("ENQ-30", "x")))[0].status).toBe("not-active");
    expect(r.jobs.list({ kind: "trigger" })).toHaveLength(0);
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)).toMatchObject({ health: "paused", state: "paused" });
    r.svc.setState(SEED_IDS.enquiry, "active");
    expect((await r.svc.engine.deliver(syntheticEnquiry("ENQ-30", "x")))[0].status).toBe("job");
    r.svc.setState(SEED_IDS.enquiry, "disabled");
    expect(r.svc.list().find((t) => t.id === SEED_IDS.enquiry)!.health).toBe("disabled");
  });
});

describe("durability across a hub restart", () => {
  test("dedupe and the event-to-job link survive; a delivery claimed but never given a job is finished on the next tick", async () => {
    const a = rig();
    const [res] = await a.svc.engine.deliver(syntheticEnquiry("ENQ-40", "x"));
    const jobId = (res as { jobId: string }).jobId;
    // Crash window: a second event is recorded, but the process dies before its job exists.
    a.svc.store.claim(SEED_IDS.enquiry, dedupeKey("synthetic.enquiry", "ENQ-41"), { ref: "ENQ-41", topic: "x" }, null);
    a.close();
    const b = rig();
    // Recovery (the single owner) turns the awaiting-approval job into 'interrupted'; the approval itself stays pending.
    expect(b.jobs.recover()).toMatchObject({ interrupted: 1 });
    expect((await b.svc.engine.deliver(syntheticEnquiry("ENQ-40", "x")))[0]).toMatchObject({ status: "duplicate", jobId });
    await b.svc.tick();
    const rows = b.svc.detail(SEED_IDS.enquiry).deliveries;
    expect(rows.map((d) => d.status).sort()).toEqual(["awaiting-approval", "awaiting-approval"]);
    // The original job is interrupted (restart) and ENQ-41 got its job from reconcile: two jobs, none duplicated.
    expect(b.jobs.list({ kind: "trigger" })).toHaveLength(2);
    expect(b.jobs.get(jobId)!.state).toBe("interrupted");
    // The approval outlived the restart: answering it still settles the delivery, and the job note says what happened.
    const pending = b.approvals.list({ state: "pending" }).find((x) => x.jobId === jobId)!;
    expect(answer(b, pending.id, b.codes[0] ?? "").ok).toBe(false); // no code was re-sent after the restart: it cannot be answered by guessing
    expect(b.approvals.decide(pending.id, owner, "reject").ok).toBe(true);
    await b.svc.engine.sweep();
    expect(b.svc.detail(SEED_IDS.enquiry).deliveries.find((d) => d.jobId === jobId)).toMatchObject({ status: "rejected" });
  });
});

describe("schedule arithmetic", () => {
  test("daily slots in a zone, across a day boundary and DST", () => {
    const sydney = (y: number, m: number, d: number, hh: number, mm: number) => zonedToUtc(y, m, d, hh, mm, "Australia/Sydney");
    // Sydney moves to daylight time on 4 Oct 2026: 7:30 on the 1st is UTC+10, on the 5th UTC+11.
    expect(new Date(sydney(2026, 10, 1, 7, 30)).toISOString()).toBe("2026-09-30T21:30:00.000Z");
    expect(new Date(sydney(2026, 10, 5, 7, 30)).toISOString()).toBe("2026-10-04T20:30:00.000Z");
    const slots = slotsBetween({ kind: "daily", at: "07:30", tz: "Australia/Sydney" }, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-06T00:00:00Z"));
    expect(slots.map((s) => new Date(s).toISOString())).toEqual(["2026-10-01T21:30:00.000Z", "2026-10-02T21:30:00.000Z", "2026-10-03T20:30:00.000Z", "2026-10-04T20:30:00.000Z", "2026-10-05T20:30:00.000Z"]);
    expect(slotsBetween({ kind: "interval", everyMinutes: 30 }, 0, 3600_000 * 2)).toHaveLength(4);
  });
});

describe("routines and the offline policy", () => {
  // 07:30 Sydney on 2 Oct 2026 is 2026-10-01T21:30:00Z.
  const SLOT = Date.parse("2026-10-01T21:30:00Z");
  async function scenario(policy: "skip" | "run-once" | "review") {
    clock = SLOT - 10 * 60_000; // 07:20: the host is up, the routine is registered and ticks once
    const a = rig();
    a.svc.store.upsert({ id: SEED_IDS.summary, name: "Morning business summary", kind: "routine", source: "routine.schedule", action: "brief.summary", conditions: [], mode: "draft", retryLimit: 2, offlinePolicy: policy, schedule: { kind: "daily", at: "07:30", tz: "Australia/Sydney" }, config: {} });
    a.svc.setState(SEED_IDS.summary, "active"); // seeded paused: the owner opts in from Automations
    await a.svc.tick();
    expect(a.jobs.list({ kind: "trigger" })).toHaveLength(0);
    a.close(); // the hub goes down before 07:30 ...
    clock = SLOT + 105 * 60_000; // ... and comes back at 09:15
    const b = rig();
    b.jobs.recover();
    await b.svc.tick();
    return b;
  }
  const routine = (r: Rig) => r.svc.detail(SEED_IDS.summary);

  test("the morning summary is seeded PAUSED: it never runs until the owner switches it on, and works fully once on", async () => {
    clock = SLOT - 10 * 60_000;
    const a = rig();
    expect(routine(a).trigger).toMatchObject({ state: "paused", nextRunAt: null });
    await a.svc.tick();
    clock = SLOT + 60_000;
    await a.svc.tick();
    expect(a.jobs.list({ kind: "trigger" })).toHaveLength(0);
    expect(routine(a).runs).toHaveLength(0);
    a.close();
    // A restart never undoes the choice either way.
    const b = rig();
    expect(routine(b).trigger.state).toBe("paused");
    b.svc.setState(SEED_IDS.summary, "active");
    expect(routine(b).trigger.nextRunAt).not.toBeNull();
    clock = SLOT + 24 * 3600_000 - 10 * 60_000;
    await b.svc.tick();
    clock = SLOT + 24 * 3600_000 + 60_000;
    await b.svc.tick();
    const jobs = b.jobs.list({ kind: "trigger" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("succeeded");
  });

  test("skip: the missed window is recorded, nothing runs", async () => {
    const b = await scenario("skip");
    expect(b.jobs.list({ kind: "trigger" })).toHaveLength(0);
    expect(routine(b).runs[0]).toMatchObject({ outcome: "skipped-offline", jobId: null });
    await b.svc.tick();
    expect(routine(b).runs).toHaveLength(1);
  });

  test("run-once: one late job for the missed window, flagged as late, never twice", async () => {
    const b = await scenario("run-once");
    const jobs = b.jobs.list({ kind: "trigger" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("succeeded");
    expect(b.jobs.get(jobs[0].id)!.steps.map((s) => s.intent).join()).toContain("Ran late after the host was offline");
    expect(routine(b).runs[0]).toMatchObject({ outcome: "ran-on-return", jobId: jobs[0].id });
    await b.svc.tick();
    clock += 60_000;
    await b.svc.tick();
    expect(b.jobs.list({ kind: "trigger" })).toHaveLength(1);
    expect(routine(b).trigger.lastRun).toMatchObject({ outcome: "ran-on-return" });
  });

  test("review: a held job asks the owner; it runs only when approved", async () => {
    const b = await scenario("review");
    const jobs = b.jobs.list({ kind: "trigger" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("awaiting-approval");
    expect(b.approvals.list({ state: "pending" }).map((x) => x.action)).toEqual(["trigger.review"]);
    expect(routine(b).runs[0]).toMatchObject({ outcome: "review-requested" });
    expect(answer(b, b.approvals.list({ state: "pending" })[0].id, b.codes[0]).ok).toBe(true);
    await b.svc.engine.sweep();
    expect(b.jobs.get(jobs[0].id)!.state).toBe("succeeded");
  });

  test("several missed days coalesce into one run; an on-time slot runs normally", async () => {
    clock = SLOT - 10 * 60_000;
    const a = rig();
    a.svc.setState(SEED_IDS.summary, "active");
    await a.svc.tick();
    a.close();
    clock = Date.parse("2026-10-04T20:31:00Z"); // down for three days, back one minute after the 5 Oct 07:30 slot
    const b = rig();
    b.jobs.recover();
    await b.svc.tick();
    const runs = routine(b).runs;
    expect(runs.map((r) => r.outcome).sort()).toEqual(["coalesced", "coalesced", "ran", "ran-on-return"]);
    // Default policy is run-once: the three late windows become ONE job, and the on-time one runs as usual.
    expect(b.jobs.list({ kind: "trigger" })).toHaveLength(2);
  });

  test("a paused routine does not catch up when resumed", async () => {
    clock = SLOT - 10 * 60_000;
    const a = rig();
    a.svc.setState(SEED_IDS.summary, "active");
    await a.svc.tick();
    a.svc.setState(SEED_IDS.summary, "paused");
    clock = SLOT + 60 * 60_000;
    await a.svc.tick();
    a.svc.setState(SEED_IDS.summary, "active");
    clock += 60_000;
    await a.svc.tick();
    expect(a.jobs.list({ kind: "trigger" })).toHaveLength(0);
  });

  test("tickRoutines on its own is idempotent per slot", async () => {
    clock = SLOT - 60_000;
    const a = rig();
    a.svc.setState(SEED_IDS.summary, "active");
    await tickRoutines(a.svc.engine, clock);
    clock = SLOT + 30_000;
    expect(await tickRoutines(a.svc.engine, clock)).toMatchObject({ ran: 1 });
    expect(await tickRoutines(a.svc.engine, clock)).toMatchObject({ ran: 0 });
    expect(a.jobs.list({ kind: "trigger" })).toHaveLength(1);
  });
});

describe("the store", () => {
  // Open Dot review C9: a stored output ref is data, never a LIKE pattern.
  test("the loop guard treats % and _ in a ref literally", () => {
    const s = new TriggerStore(join(dir, "like.sqlite"));
    closers.push(() => s.close());
    s.recordOutput("draft_1", "job-a", "trg-x", "draft");
    s.recordOutput("note%", "job-b", "trg-x", "note");
    s.recordOutput("back\\slash", "job-c", "trg-x", "note");
    expect(s.isOwnOutput("draft_1:v2")).toBe(true); // a real child still matches
    expect(s.isOwnOutput("draftX1:v2")).toBe(false); // _ is not "any one character"
    expect(s.isOwnOutput("note%:v2")).toBe(true);
    expect(s.isOwnOutput("notebook:7")).toBe(false); // % is not "anything"
    expect(s.isOwnOutput("back\\slash:1")).toBe(true);
    expect(s.isOwnOutput("backXslash:1")).toBe(false);
  });
  test("dedupe key is stable and source-scoped", () => {
    expect(dedupeKey("a", "1")).toBe(dedupeKey("a", "1"));
    expect(dedupeKey("a", "1")).not.toBe(dedupeKey("b", "1"));
    const s = new TriggerStore(join(dir, "x.sqlite"));
    closers.push(() => s.close());
    s.upsert({ id: "trg-x", name: "x", kind: "event", source: "s", action: "a", conditions: [], mode: "draft", retryLimit: 1, config: {} });
    s.setState("trg-x", "paused");
    s.upsert({ id: "trg-x", name: "x2", kind: "event", source: "s", action: "a", conditions: [], mode: "draft", retryLimit: 1, config: {} });
    expect(s.get("trg-x")).toMatchObject({ name: "x2", state: "paused" }); // a re-seed never undoes a pause
  });
});
