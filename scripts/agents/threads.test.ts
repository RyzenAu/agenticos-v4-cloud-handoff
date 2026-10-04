// A person's conversation with a bot: how it is created and kept, what a server entry carries (jobKind, blocker), that the request and reply entries are
// idempotent, that the live stream carries the new fields, and what a hub restart looks like on /__events.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botConversationKey, botThreadId, conversationStore, isJobThread, jarvisThreadId, parseBotConversationKey } from "../conversations";
import { JobService } from "../jobs/service";
import { loopRig, type LoopRig } from "../jarvis-command/research-loop-rig";
import { blockerFor, createJobThreads } from "../jarvis-command/threads";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agents-threads-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

describe("the bot conversation's id and creation", () => {
  test("a UUID derived from the readable key: stable, per person and bot, never the default thread's", () => {
    expect(botThreadId("usman", "research")).toBe(botThreadId("usman", "research"));
    expect(botThreadId("usman", "research")).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    const ids = new Set([botThreadId("usman", "research"), botThreadId("usman", "builder"), botThreadId("mehroz", "research"), jarvisThreadId("usman")]);
    expect(ids.size).toBe(4);
    expect(botConversationKey("usman", "builder")).toBe("agent:usman:builder");
    expect(parseBotConversationKey("agent:usman:builder")).toEqual({ personId: "usman", botId: "builder" });
    for (const bad of ["agent:usman", "agent::x", "agent:Usman:x", "jarvis:usman:x", "agent:usman:../x", undefined, 5]) expect(parseBotConversationKey(bad)).toBeNull();
    expect(isJobThread("bot") && isJobThread("jarvis") && !isJobThread(undefined) && !isJobThread("x")).toBe(true);
  });

  test("ensureThread: created once, owned by the person, with the bot's name; asking again returns it; another person gets their own", () => {
    const store = conversationStore(tmp());
    const a = store.ensureThread({ personId: "usman", bot: "research", title: "Research" })!;
    expect(a).toMatchObject({ id: botThreadId("usman", "research"), thread: "bot", bot: "research", personId: "usman", title: "Research", jobs: [], entries: [] });
    expect(store.ensureThread({ personId: "usman", bot: "research" })!.id).toBe(a.id);
    expect(store.list().length).toBe(1);
    const m = store.ensureThread({ personId: "mehroz", bot: "research" })!;
    expect(m.id).not.toBe(a.id);
    // A caller can't point a bot thread at some other conversation's id.
    expect(store.ensureThread({ personId: "usman", bot: "research", id: jarvisThreadId("usman") })!.id).toBe(a.id);
    expect(store.ensureThread({ personId: "usman", bot: "Not A Slug" })!.thread).toBe("jarvis");
  });

  test("a chat tab that saved the conversation first is adopted as the bot thread, its messages untouched; later saves keep the bot", () => {
    const store = conversationStore(tmp());
    const id = botThreadId("usman", "builder");
    store.save({ id, title: "typed first", messages: [{ role: "user", text: "hello" }] }, { personId: "usman", hub: true });
    const adopted = store.ensureThread({ personId: "usman", bot: "builder", title: "Builder" })!;
    expect(adopted).toMatchObject({ id, thread: "bot", bot: "builder", personId: "usman" });
    expect(adopted.messages.map((x) => x.text)).toEqual(["hello"]);
    const saved = store.save({ id, revision: 1, messages: [{ role: "user", text: "hello" }, { role: "oracle", text: "hi" }] }, { personId: "usman", hub: true });
    expect(store.get(id)).toMatchObject({ bot: "builder", thread: "bot" });
    expect(saved.messages.length).toBe(2);
  });

  test("another person's bot conversation is refused (null), never written to", () => {
    const store = conversationStore(tmp());
    store.ensureThread({ personId: "usman", bot: "research" });
    // Mehroz asks for HIS research thread: a different id. The only way to reach Usman's is the id itself, and an owned thread is never adopted.
    expect(store.ensureThread({ personId: "mehroz", id: botThreadId("usman", "research") })).toBeNull();
  });
});

describe("server entries: jobKind, blocker, and the request / reply pair", () => {
  test("appendEntry stores jobKind and blocker (trimmed), and the same key twice is one entry", () => {
    const store = conversationStore(tmp());
    const t = store.ensureThread({ personId: "usman", bot: "research" })!;
    const e = store.appendEntry(t.id, { key: "j:failed", jobId: "j", state: "failed", text: "Failed.", jobKind: "computer", blocker: { kind: "failed", recovery: "x".repeat(400), approvalId: "a".repeat(200) } })!;
    expect(e).toMatchObject({ jobKind: "computer", blocker: { kind: "failed" } });
    expect(e.blocker!.recovery!.length).toBe(240);
    expect(e.blocker!.approvalId!.length).toBe(80);
    expect(store.appendEntry(t.id, { key: "j:failed", jobId: "j", state: "failed", text: "again" })).toBeNull();
    expect(store.get(t.id)!.entries!.length).toBe(1);
  });

  test("request and ack entries say nothing about any job's state, and a replayed command writes nothing twice", () => {
    const dir = tmp();
    const store = conversationStore(dir);
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0 });
    cleanups.push(() => { try { jobs.close(); } catch { /* closing */ } });
    const threads = createJobThreads({ conversations: store, jobs: () => jobs, pollMs: 60_000 });
    const bot = { id: "research", name: "Research" };
    const t = store.ensureThread({ personId: "usman", bot: "research" })!;
    store.linkJob(t.id, { jobId: "j1", kind: "job", title: "x", state: "running" });
    expect(threads.note({ personId: "usman", bot, commandId: "cmd-000001", role: "request", text: "find clinics, call me on 0412 345 678 or me@example.com" })).not.toBeNull();
    expect(threads.note({ personId: "usman", bot, commandId: "cmd-000001", role: "request", text: "find clinics" })).toBeNull();
    expect(threads.note({ personId: "usman", bot, commandId: "cmd-000001", role: "ack", text: "Started.", jobId: "j1" })).not.toBeNull();
    const log = store.get(t.id)!.entries!;
    expect(log.map((e) => [e.key, e.state])).toEqual([["cmd-000001:request", "request"], ["cmd-000001:ack", "ack"]]);
    // Masked like every job line: the number and the address are not kept.
    expect(log[0].text).not.toContain("0412 345 678");
    expect(log[0].text).not.toContain("me@example.com");
    // The linked job's own state was not touched by the ack.
    expect(store.get(t.id)!.jobs![0].state).toBe("running");
  });

  test("blockerFor: waiting is an approval (with its id), a limit is its own allowance kind, failed and unsure are failed, done and stopped need nothing", () => {
    const r = (patch: Partial<Parameters<typeof blockerFor>[1]> = {}) => ({ state: "x", title: "t", note: null, steps: 0, lastStep: null, receipts: [], ...patch });
    expect(blockerFor("awaiting-approval", r({ approvalId: "ap1" }))).toMatchObject({ kind: "needs-approval", approvalId: "ap1" });
    expect(blockerFor("awaiting_approval", r({ approvalId: "ap2" }))).toMatchObject({ kind: "needs-approval", approvalId: "ap2" });
    expect(blockerFor("needs_owner", r({ blockerText: "The builders' branches conflict." }))).toMatchObject({ kind: "needs-owner", recovery: "The builders' branches conflict." });
    expect(blockerFor("blocked_allowance", r())).toMatchObject({ kind: "allowance" });
    expect(blockerFor("failed", r())).toMatchObject({ kind: "failed" });
    expect(blockerFor("interrupted", r())?.recovery).toContain("not re-run");
    expect(blockerFor("unknown", r())?.kind).toBe("failed");
    for (const s of ["succeeded", "completed", "cancelled", "running", "building"]) expect(blockerFor(s, r())).toBeUndefined();
  });
});

describe("the live stream and a hub restart", () => {
  let rig: LoopRig | null = null;
  afterEach(async () => {
    await rig?.close();
    rig = null;
  });
  const setup = async () => {
    const dir = tmp();
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0, stopGraceMs: 300 });
    cleanups.push(() => { try { jobs.close(); } catch { /* closing */ } });
    rig = await loopRig(jobs);
    return { jobs, rig };
  };

  test("a bot thread entry reaches the person's own /__events stream with its jobKind and blocker, once, and never reaches the other founder", async () => {
    const { rig: r } = await setup();
    const usman = await r.open("usman");
    const mehroz = await r.open("mehroz");
    const t = r.conversations.ensureThread({ personId: "usman", bot: "builder", title: "Builder" })!;
    r.conversations.appendEntry(t.id, { key: "c1:awaiting_approval", jobId: "c1", state: "awaiting_approval", text: "Waiting for you: merge.", jobKind: "coding", blocker: { kind: "needs-approval", approvalId: "ap-9", recovery: "Answer it from the job." } });
    r.conversations.appendEntry(t.id, { key: "c1:awaiting_approval", jobId: "c1", state: "awaiting_approval", text: "dup" });
    await usman.waitFor((f) => f.some((x) => x.data?.topic === "thread"));
    await Bun.sleep(50);
    const ev = usman.threadEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ conversationId: t.id, eventId: `${t.id}:c1:awaiting_approval`, entry: { key: "c1:awaiting_approval", jobKind: "coding", blocker: { kind: "needs-approval", approvalId: "ap-9" } } });
    expect(mehroz.threadEvents()).toHaveLength(0);
  });

  test("a restart: a client that reconnects with an old Last-Event-ID gets hello(snapshot) then a snapshot (a new epoch), and the thread entries are caught up from the thread endpoint, not the stream", async () => {
    const { rig: r } = await setup();
    const first = await r.open("usman");
    await first.waitFor((f) => f.some((x) => x.event === "hello"));
    const oldEpoch = first.frames.find((x) => x.event === "hello")!.data.epoch as string;
    // The hub restarts: a new bus epoch. The client presents the id it last saw from the old one.
    const { ActivityBus } = await import("../events/bus");
    expect(new ActivityBus().epoch).not.toBe(oldEpoch);
    const again = await r.open("usman", { lastEventId: `${oldEpoch}0:5` });
    await again.waitFor((f) => f.some((x) => x.event === "snapshot"));
    const hello = again.frames.find((x) => x.event === "hello")!.data;
    // Same process here, so the epoch matches; an id that is AHEAD of the head cannot be replayed either, so it lands on a snapshot too.
    expect(hello.mode).toBe("snapshot");
    const snap = again.frames.find((x) => x.event === "snapshot")!.data;
    expect(Object.keys(snap)).toEqual(expect.arrayContaining(["jobs", "approvals", "computers", "devices", "epoch", "head"]));
    // The snapshot carries no conversation entries: they are read from the conversation (the thread endpoint), after a seq.
    expect(JSON.stringify(snap)).not.toContain("entries");
  });
});
