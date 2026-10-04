// Round 11 (defect 3): a coding draft made in a Jarvis conversation reports back to THAT conversation however it is started. Before, only a typed
// "start it" linked the job; Start on the draft page (/coding/<id>) left the conversation with no progress and no result.
// Now the draft is linked as pending (the conversation is its origin, no entry yet); when it starts, from the conversation or the page, the
// conversation gets one "Started" entry, then its one final completion with the diff link and the account/model that ran. Synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore, jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { createCommandService, type Delegates } from "./service";
import { createJobThreads, type CodingSnapshot } from "./threads";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };
const JOB = "7a1b2c3d-1111-4222-8333-944445555666";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "draft-origin-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  const store = conversationStore(join(dir, "conv"));
  let reading: CodingSnapshot = { state: "awaiting_confirmation", title: "fix the greeting", receipts: [] };
  const threads = createJobThreads({ conversations: store, jobs: () => jobs, coding: () => reading, pollMs: 60_000 });
  cleanups.push(() => { threads.stop(); try { jobs.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); });
  const coding: NonNullable<Delegates["coding"]> = async (utterance) => {
    if (/^start it$/i.test(utterance)) { reading = { ...reading, state: "building" }; return { say: "Started. I'll keep the progress on screen.", navigate: "/coding", jobId: JOB, jobState: "building" }; }
    if (/how'?s the coding job/i.test(utterance)) return { say: "fix the greeting is waiting for you to start it.", jobId: JOB, jobState: reading.state };
    return { say: "Drafted: fix the greeting. Opus builds, Sonnet reviews. Start it?", navigate: "/coding", jobId: JOB, jobState: "awaiting_confirmation", drafted: true };
  };
  const service = createCommandService({ jobs: () => jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "none" }), delegates: { coding, codingMatches: () => true }, threads, graceMs: 50, dedupeMs: 0 });
  const say = (utterance: string, who: Principal = usman, extra: Record<string, unknown> = {}) => service.run({ principal: who, body: { utterance, source: "typed", ...extra } as never });
  const entries = (person = "usman") => store.entriesAfter(jarvisThreadId(person), 0).filter((e) => e.jobId === JOB);
  return { threads, say, entries, move: (s: Partial<CodingSnapshot>) => void (reading = { ...reading, ...s }) };
}

const RAN = [{ account: "claude:max-2", model: "claude-opus-5-5", providerModel: "claude-opus-5-5", role: "builder" }];

describe("a draft made in the conversation reports back there, however it is started", () => {
  test("'start it' typed on /jarvis arrives with the page context and still starts the draft (production 4 Oct)", async () => {
    const r = rig();
    await r.threads.start();
    await r.say("have a builder fix the greeting in the fixture app");
    const done = await r.say("start it", usman, { pageContext: { route: "/jarvis", title: "Jarvis", items: [] } });
    expect(done.said).toContain("Started");
    expect(done.said).not.toContain("can't tell which item");
  });

  test("interrupted by a hub restart, then resumed: the result of the resumed job comes back to the same conversation (production 4 Oct)", async () => {
    const r = rig();
    await r.threads.start();
    await r.say("have a builder fix the greeting in the fixture app");
    r.move({ state: "building" });
    await r.threads.reconcile();
    r.move({ state: "interrupted" }); // the hub restarted while the builder was working
    await r.threads.reconcile();
    expect(r.entries().map((e) => e.state)).toEqual(["started", "interrupted"]);
    r.move({ state: "building" }); // Resume pressed on the job's page
    await r.threads.reconcile();
    r.move({ state: "completed", receipts: RAN });
    await r.threads.reconcile();
    const states = r.entries().map((e) => e.state);
    expect(states.filter((x) => x === "completed")).toHaveLength(1);
    expect(r.entries().at(-1)!.text).toContain("Ran on Claude Max 2");
  });

  test("started with Start on the draft page: one Started entry, then one final entry with the diff link and what ran", async () => {
    const r = rig();
    await r.threads.start();
    const drafted = await r.say("have a builder fix the greeting in the fixture app");
    expect(drafted.said).toContain("Start it?");
    expect(r.entries()).toEqual([]); // the draft itself writes nothing to the conversation
    r.move({ state: "building" }); // Start pressed on /coding/<id>: the conversation was not involved
    await r.threads.reconcile();
    r.move({ state: "completed", receipts: RAN });
    await r.threads.reconcile();
    await r.threads.reconcile();
    const e = r.entries();
    expect(e.map((x) => x.state)).toEqual(["started", "completed"]);
    expect(e[0].text).toContain("Started: fix the greeting");
    expect(e[1].text).toContain(`Changes: /coding/${JOB}?tab=changes`);
    expect(e[1].text).toContain("Ran on Claude Max 2: builder claude-opus-5-5");
  });

  test("started by typing 'start it' in the conversation: still exactly one Started and one final entry", async () => {
    const r = rig();
    await r.threads.start();
    await r.say("have a builder fix the greeting in the fixture app");
    await r.say("start it");
    await r.threads.reconcile();
    r.move({ state: "completed", receipts: RAN });
    await r.threads.reconcile();
    expect(r.entries().map((x) => x.state)).toEqual(["started", "completed"]);
  });

  test("a draft cancelled before it started leaves nothing in the conversation, and a draft is never 'that task' for stop or status", async () => {
    const r = rig();
    await r.threads.start();
    await r.say("have a builder fix the greeting in the fixture app");
    expect(await r.threads.active("usman")).toEqual([]);
    r.move({ state: "cancelled" });
    await r.threads.reconcile();
    expect(r.entries()).toEqual([]);
  });
});

describe("review M2: a draft's report-back is never captured by another person", () => {
  test("Usman drafts; Mehroz asks how the coding job is going (a reply naming Usman's draft); Usman presses Start on the page: everything lands in Usman's conversation only", async () => {
    const r = rig();
    await r.threads.start();
    await r.say("have a builder fix the greeting in the fixture app");
    await r.say("how's the coding job going?", mehroz);
    r.move({ state: "building" });
    await r.threads.reconcile();
    r.move({ state: "completed", receipts: RAN });
    await r.threads.reconcile();
    expect(r.entries("mehroz")).toEqual([]);
    expect(r.entries("usman").map((x) => x.state)).toEqual(["started", "completed"]);
  });

  test("a status reply that names a draft never makes the asking conversation its origin", async () => {
    const r = rig();
    await r.threads.start();
    await r.say("how's the coding job going?", mehroz);
    r.move({ state: "building" });
    await r.threads.reconcile();
    expect(r.entries("mehroz")).toEqual([]);
  });

  test("an existing watch is never taken over by another person's link", async () => {
    const r = rig();
    await r.threads.start();
    await r.say("have a builder fix the greeting in the fixture app");
    await r.threads.link({ personId: "mehroz", jobId: JOB, kind: "coding", title: "x", pending: true });
    await r.threads.link({ personId: "mehroz", jobId: JOB, kind: "coding", title: "x" });
    r.move({ state: "completed", receipts: RAN });
    await r.threads.reconcile();
    expect(r.entries("mehroz").filter((e) => e.state === "completed")).toEqual([]);
    expect(r.entries("usman").map((x) => x.state)).toContain("completed");
  });
});

describe("review follow-ups: a pending draft writes nothing until it starts, and isn't polled forever", () => {
  test("draft → awaiting confirmation writes no 'waiting' entry", async () => {
    const r = rig();
    r.move({ state: "draft" });
    await r.threads.start();
    await r.say("have a builder fix the greeting in the fixture app");
    r.move({ state: "awaiting_confirmation" });
    await r.threads.reconcile();
    expect(r.entries()).toEqual([]);
  });

  test("a draft never started within a day stops being watched (a later start is not reported from a stale watch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ttl-"));
    let t = Date.parse("2026-10-04T00:00:00Z");
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
    const store = conversationStore(join(dir, "conv"));
    let reads = 0;
    let state = "awaiting_confirmation";
    const threads = createJobThreads({ conversations: store, jobs: () => jobs, coding: () => (reads++, { state, title: "fix", receipts: [] }), pollMs: 60_000, now: () => t });
    cleanups.push(() => { threads.stop(); try { jobs.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); });
    await threads.start();
    await threads.link({ personId: "usman", jobId: JOB, kind: "coding", title: "fix", pending: true });
    t += 25 * 60 * 60_000;
    await threads.reconcile();
    const after = reads;
    state = "building";
    await threads.reconcile();
    expect(reads).toBe(after);
    expect(store.entriesAfter(jarvisThreadId("usman"), 0).filter((e) => e.jobId === JOB)).toEqual([]);
  });
});

describe("release re-check M4: after a restart a job's result goes to its owner's conversation, not whoever asked its status", () => {
  test("Mehroz's conversation also holds Usman's coding job (she asked about it, and was updated last); after a restart the result lands in Usman's only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m4-restart-"));
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
    const store = conversationStore(join(dir, "conv"));
    let reading: CodingSnapshot = { state: "building", title: "fix the greeting", owner: "usman", receipts: [] };
    const u = store.ensureThread({ personId: "usman" })!;
    store.linkJob(u.id, { jobId: JOB, kind: "coding", title: "fix", state: "building" });
    await new Promise((r) => setTimeout(r, 5));
    const m = store.ensureThread({ personId: "mehroz" })!;
    store.linkJob(m.id, { jobId: JOB, kind: "coding", title: "fix", state: "building" });
    const threads = createJobThreads({ conversations: store, jobs: () => jobs, coding: () => reading, pollMs: 60_000 });
    cleanups.push(() => { threads.stop(); try { jobs.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); });
    await threads.start(); // the "restart"
    reading = { ...reading, state: "completed", receipts: RAN };
    await threads.reconcile();
    expect(store.entriesAfter(jarvisThreadId("mehroz"), 0).filter((e) => e.jobId === JOB)).toEqual([]);
    expect(store.entriesAfter(jarvisThreadId("usman"), 0).filter((e) => e.jobId === JOB).map((e) => e.state)).toEqual(["completed"]);
  });

  test("a status reply naming an open coding job (not started by this turn) is never linked as started", async () => {
    const r = rig();
    await r.threads.start();
    r.move({ state: "building" });
    await r.say("how's the coding job going?", mehroz);
    expect(r.entries("mehroz")).toEqual([]);
  });
});

describe("round 11 (UI-core follow-up): typed requests and replies are saved into the person's own Jarvis thread", () => {
  test("keyed by the request id (a repeat writes nothing), in the caller's own default thread, user then reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "say-"));
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
    const store = conversationStore(join(dir, "conv"));
    const threads = createJobThreads({ conversations: store, jobs: () => jobs, pollMs: 60_000 });
    cleanups.push(() => { threads.stop(); try { jobs.close(); } catch { /* closing */ } rmSync(dir, { recursive: true, force: true }); });
    const service = createCommandService({ jobs: () => jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "none" }), threads, graceMs: 50, dedupeMs: 0 });
    service.threadSay(usman, { requestId: "req-abc-123", part: "user", role: "user", text: "what time is it" });
    service.threadSay(usman, { requestId: "req-abc-123", part: "reply", role: "assistant", text: "It's half past noon." });
    service.threadSay(usman, { requestId: "req-abc-123", part: "user", role: "user", text: "what time is it" });
    const mine = store.get(jarvisThreadId("usman"))!;
    expect(mine.messages.map((m) => [m.role, m.text])).toEqual([["user", "what time is it"], ["oracle", "It's half past noon."]]);
    expect(store.get(jarvisThreadId("mehroz"))).toBeNull();
  });
});

describe("round 11: a client save of the thread never erases the typed exchange the server wrote", () => {
  test("the companion saving its transcript list (without the server's typed messages) keeps them", () => {
    const dir = mkdtempSync(join(tmpdir(), "say-save-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = conversationStore(dir);
    const t = store.ensureThread({ personId: "usman" })!;
    store.appendMessage(t.id, { key: "req-1:user", role: "user", text: "what time is it" });
    store.appendMessage(t.id, { key: "req-1:reply", role: "oracle", text: "Half past noon." });
    const now = store.get(t.id)!;
    store.save({ id: t.id, revision: now.revision ?? 0, messages: [{ role: "user", text: "an older voice turn" }] }, { personId: "usman" } as never);
    expect(store.get(t.id)!.messages.map((m) => m.text)).toEqual(["what time is it", "Half past noon.", "an older voice turn"]);
  });
});
