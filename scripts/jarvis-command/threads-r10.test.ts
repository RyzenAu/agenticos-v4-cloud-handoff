// Round 10 (jobs owner): one finished entry per job. A coding store says `completed` where the job service says `succeeded`; the server keyed the
// entry by the raw state, so one finished job could be appended as `<id>:completed` AND `<id>:succeeded`, and spoken twice.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botThreadId, conversationStore, jarvisThreadId } from "../conversations";
import { threadDeliver } from "../computers/research-wiring";
import type { JobService } from "../jobs/service";
import { announceFor, createJobThreads, stateKey, type CodingSnapshot, type ThreadNotice } from "./threads";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "threads-r10-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const noJobs = () => ({ subscribe: () => () => undefined, get: () => null, list: () => [], step: () => null }) as unknown as JobService;
const JOB = "0b0d6d47-1111-4222-8333-944445555666";

describe("one finished entry per job and conversation", () => {
  test("`completed` and `succeeded` share one key: the second spelling appends nothing and announces nothing", async () => {
    const store = conversationStore(tmp());
    let reading: CodingSnapshot = { state: "building", title: "fix the greeting", receipts: [] };
    const threads = createJobThreads({ conversations: store, jobs: noJobs, coding: () => reading, pollMs: 60_000 });
    const notices: ThreadNotice[] = [];
    threads.onEntry((n) => notices.push(n));
    await threads.start();
    await threads.link({ personId: "usman", jobId: JOB, kind: "coding", title: "fix the greeting" });
    reading = { ...reading, state: "completed", receipts: [{ account: "claude:max-2", model: "claude-opus-5-5", providerModel: "claude-opus-5-5", role: "builder" }] };
    await threads.reconcile();
    // The same job reached again under the other spelling (a re-link, or a reader that maps the state): never a second finished entry.
    await threads.link({ personId: "usman", jobId: JOB, kind: "coding", title: "fix the greeting", attached: true });
    reading = { ...reading, state: "succeeded" };
    await threads.link({ personId: "usman", jobId: JOB, kind: "coding", title: "fix the greeting", attached: true });
    const entries = store.entriesAfter(jarvisThreadId("usman"), 0).filter((e) => e.jobId === JOB && /^(?:completed|succeeded)$/.test(e.state));
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe(`${JOB}:succeeded`);
    // The finished coding entry carries the way to its diff and the account and model that actually ran.
    expect(entries[0].text).toContain(`Ran on Claude Max 2: builder claude-opus-5-5. Changes: /coding/${JOB}?tab=changes (job 0b0d6d47)`);
    const spoken = notices.map((n) => n.announce?.key).filter(Boolean);
    expect(new Set(spoken).size).toBe(spoken.length);
    expect(spoken).toEqual([`job:${JOB}:succeeded`]);
    threads.stop();
  });

  test("an entry written before round 10 as `<id>:completed` is still the job's finished entry", async () => {
    const store = conversationStore(tmp());
    const t = store.ensureThread({ personId: "usman" })!;
    store.linkJob(t.id, { jobId: JOB, kind: "coding", title: "fix", state: "reviewing" });
    store.appendEntry(t.id, { key: `${JOB}:completed`, jobId: JOB, state: "completed", text: "Finished: fix." });
    const threads = createJobThreads({ conversations: store, jobs: noJobs, coding: () => ({ state: "succeeded", title: "fix", receipts: [] }), pollMs: 60_000 });
    await threads.start(); // the link's stored state was still open, so the watcher re-reads it on the way up
    expect(store.entriesAfter(t.id, 0).filter((e) => e.jobId === JOB).map((e) => e.key)).toEqual([`${JOB}:completed`]);
    threads.stop();
  });

  test("the spoken key uses the same spelling; other states are unchanged", () => {
    expect(stateKey("completed")).toBe("succeeded");
  });
});

/** A job service with only what the watcher reads: get, subscribe, and a way to move a job and record a step (as the computers service does). */
function fakeJobs() {
  const listeners = new Set<(e: unknown) => void>();
  const jobs = new Map<string, { id: string; state: string; title: string; kind: string; steps: unknown[]; createdAt: string; note?: string }>();
  const svc = { subscribe: (l: (e: unknown) => void) => (listeners.add(l), () => void listeners.delete(l)), get: (id: string) => jobs.get(id) ?? null, list: () => [], step: () => null } as unknown as JobService;
  return {
    svc: () => svc,
    add: (id: string, title: string) => jobs.set(id, { id, state: "running", title, kind: "control", steps: [], createdAt: new Date().toISOString() }),
    move: (id: string, state: string, note?: string) => { Object.assign(jobs.get(id)!, { state, ...(note ? { note } : {}) }); for (const l of listeners) l({ type: "job", jobId: id }); },
    step: (id: string, n: number, intent: string) => {
      const step = { seq: n, at: n, executor: "research", ms: 0, outcome: "ok", intent, verification: { method: "research-subgoal", ok: true } };
      jobs.get(id)!.steps.push(step);
      for (const l of listeners) l({ type: "step", jobId: id, step });
    },
  };
}
const RJOB = "5a45b224-a33f-40d9-8db6-e2520fbe26b2";
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("a bot's job asked for from another conversation returns its result there (round 10)", () => {
  test("progress stays in the bot's conversation; the asking conversation gets the receipt and ONE end entry; spoken once", async () => {
    const store = conversationStore(tmp());
    const jobs = fakeJobs();
    jobs.add(RJOB, "research Acme Dental and Contoso Smiles");
    const threads = createJobThreads({ conversations: store, jobs: jobs.svc, pollMs: 60_000 });
    const notices: ThreadNotice[] = [];
    threads.onEntry((n) => notices.push(n));
    await threads.start();
    const home = jarvisThreadId("usman");
    const linked = await threads.link({ personId: "usman", bot: { id: "research", name: "Research" }, origin: home, jobId: RJOB, kind: "job", title: "research Acme Dental and Contoso Smiles" });
    const bot = linked!.conversationId;
    expect(bot).toBe(botThreadId("usman", "research"));
    jobs.step(RJOB, 1, "sub-goal 1 of 5, find sources: done.");
    jobs.move(RJOB, "succeeded", "Research finished.");
    await settle();
    const inBot = store.entriesAfter(bot, 0).filter((e) => e.jobId === RJOB).map((e) => e.state);
    const inHome = store.entriesAfter(home, 0).filter((e) => e.jobId === RJOB);
    expect(inBot).toEqual(["started", "progress", "succeeded"]);
    expect(inHome.map((e) => e.state)).toEqual(["started", "succeeded"]);
    expect(inHome[0].text).toBe("Started with Research: research Acme Dental and Contoso Smiles (job 5a45b224). Its progress is in Research's conversation; the result comes back here.");
    // "stop that task" / "how's it going" from the Jarvis thread find the job there too.
    expect(store.get(home)!.jobs!.map((j) => j.jobId)).toEqual([RJOB]);
    const announced = notices.map((n) => n.announce?.key).filter(Boolean);
    expect(new Set(announced)).toEqual(new Set([`job:${RJOB}:succeeded`])); // the gate dedupes on this key: one spoken line
    threads.stop();
  });

  test("a hub restart while it runs: both conversations are still told how it ended, once each", async () => {
    const dir = tmp();
    const store = conversationStore(dir);
    const jobs = fakeJobs();
    jobs.add(RJOB, "research Acme");
    const before = createJobThreads({ conversations: store, jobs: jobs.svc, pollMs: 60_000 });
    await before.start();
    await before.link({ personId: "usman", bot: { id: "research", name: "Research" }, origin: jarvisThreadId("usman"), jobId: RJOB, kind: "job", title: "research Acme" });
    before.stop();
    jobs.move(RJOB, "interrupted"); // the hub was down when it ended (JobService.recover)
    const after = createJobThreads({ conversations: conversationStore(dir), jobs: jobs.svc, pollMs: 60_000 });
    await after.start();
    for (const id of [botThreadId("usman", "research"), jarvisThreadId("usman")]) expect(store.entriesAfter(id, 0).filter((e) => e.jobId === RJOB && e.state === "interrupted").length).toBe(1);
    await after.reconcile();
    after.stop();
    const again = createJobThreads({ conversations: conversationStore(dir), jobs: jobs.svc, pollMs: 60_000 });
    await again.start();
    for (const id of [botThreadId("usman", "research"), jarvisThreadId("usman")]) expect(store.entriesAfter(id, 0).filter((e) => e.jobId === RJOB && e.state === "interrupted").length).toBe(1);
    again.stop();
  });

  test("an origin that is the bot's own conversation, or someone else's, adds nothing", async () => {
    const store = conversationStore(tmp());
    store.ensureThread({ personId: "mehroz" });
    const jobs = fakeJobs();
    jobs.add(RJOB, "research Acme");
    const threads = createJobThreads({ conversations: store, jobs: jobs.svc, pollMs: 60_000 });
    await threads.start();
    await threads.link({ personId: "usman", bot: { id: "research", name: "Research" }, origin: botThreadId("usman", "research"), jobId: RJOB, kind: "job", title: "research Acme" });
    await threads.link({ personId: "usman", bot: { id: "research", name: "Research" }, origin: jarvisThreadId("mehroz"), jobId: RJOB, kind: "job", title: "research Acme" });
    jobs.move(RJOB, "succeeded");
    await settle();
    expect(store.entriesAfter(jarvisThreadId("mehroz"), 0)).toEqual([]);
    expect(store.get(jarvisThreadId("usman"))).toBeNull();
    expect(store.entriesAfter(botThreadId("usman", "research"), 0).filter((e) => e.state === "succeeded").length).toBe(1);
    threads.stop();
  });

  test("the research report reaches both the bot's conversation and the asking one; a plain Jarvis job keeps only its originating one", async () => {
    const store = conversationStore(tmp());
    const jobs = fakeJobs();
    jobs.add(RJOB, "research Acme");
    const threads = createJobThreads({ conversations: store, jobs: jobs.svc, pollMs: 60_000 });
    await threads.start();
    await threads.link({ personId: "usman", bot: { id: "research", name: "Research" }, origin: jarvisThreadId("usman"), jobId: RJOB, kind: "job", title: "research Acme" });
    const deliver = threadDeliver(store);
    const r = await deliver({ jobId: RJOB, by: "usman", title: "research Acme", report: "Research: Acme\n- fact [1]", artifact: "Acme research" });
    expect(r).toEqual({ delivered: true, where: "your conversations" });
    for (const id of [botThreadId("usman", "research"), jarvisThreadId("usman")]) {
      const reports = store.entriesAfter(id, 0).filter((e) => e.state === "report");
      expect(reports.length).toBe(1);
      expect(reports[0].text).toContain("Saved result: Acme research");
    }
    expect((await deliver({ jobId: RJOB, by: "usman", title: "research Acme", report: "again" })).where).toContain("already");
    threads.stop();
  });
});

describe("an interrupted coding job asks for the owner's Resume (round 10)", () => {
  test("after a hub restart: the entry says nothing was replayed and the work is kept, and its action is the owner's (needs-owner), not 'failed'", async () => {
    const store = conversationStore(tmp());
    const t = store.ensureThread({ personId: "usman" })!;
    store.linkJob(t.id, { jobId: JOB, kind: "coding", title: "fix the greeting", state: "building" });
    const threads = createJobThreads({ conversations: store, jobs: noJobs, coding: () => ({ state: "interrupted", title: "fix the greeting", receipts: [], blocker: "The hub restarted while the builder was working. Nothing was replayed." }), pollMs: 60_000 });
    await threads.start();
    const e = store.entriesAfter(t.id, 0).find((x) => x.state === "interrupted")!;
    expect(e.text).toBe("Interrupted: fix the greeting. Nothing was replayed; its work so far is kept. The hub restarted while the builder was working. Nothing was replayed. (job 0b0d6d47)");
    expect(e.blocker).toEqual({ kind: "needs-owner", recovery: "The hub restarted while the builder was working. Nothing was replayed." });
    threads.stop();
  });
});

describe("unchanged spellings", () => {
  test("the spoken key uses the same spelling; other states are unchanged", () => {
    expect(stateKey("completed")).toBe("succeeded");
    for (const s of ["succeeded", "failed", "cancelled", "interrupted", "needs_owner"]) expect(stateKey(s)).toBe(s);
    const at = new Date().toISOString();
    expect(announceFor({ seq: 1, key: "k", at, jobId: "j", state: "completed", text: "t", speak: "done" })!.key).toBe("job:j:succeeded");
    expect(announceFor({ seq: 1, key: "k", at, jobId: "j", state: "failed", text: "t", speak: "failed" })!.key).toBe("job:j:failed");
  });
});
