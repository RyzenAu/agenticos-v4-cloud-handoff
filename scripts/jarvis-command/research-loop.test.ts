// r5-conv: "Jarvis, use the research computer to research X" end to end through the conversation: routing + acknowledgement, progress and the result
// arriving live on the asker's own /__events stream (no refresh), one spoken update, honest endings, and replays that can never run anything.
//
// SYNTHETIC: the research computer and the web are test doubles (labelled below), the voice session is `fakeVoice` (no microphone, no TTS), and the
// stream is a real SSE server on 127.0.0.1. Real: JobService (SQLite), the conversation store (JSON on disk), the job-thread watcher, the activity bus
// and stream, the interjection gate, the computer-command parser and resolver, the command service.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerCommand } from "../computers/jarvis";
import { threadDeliver } from "../computers/research-wiring";
import { jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { JobService, type ExecutorContext } from "../jobs/service";
import { withComputerResolution } from "./computer-target";
import { loopRig, fakeVoice, memoryStorage, type LoopRig } from "./research-loop-rig";
import { createJarvisEvents } from "../jarvis-events";
import { createCommandService } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
};
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const SUBGOALS = ["find sources", "read", "compare", "save report", "return result"];
const subgoal = (ctx: ExecutorContext, i: number, status: "started" | "done" | "failed" | "skipped", text: string) =>
  ctx.step({ intent: `sub-goal ${i} of 5, ${SUBGOALS[i - 1]}: ${status}. ${text} (${status === "done" ? i : i - 1} of 5 done)`, executor: "research", ms: 0, outcome: status === "failed" ? "failed" : status === "done" ? "ok" : "note", verification: { method: "research-subgoal", ok: status === "failed" ? false : status === "done" ? true : null, evidence: `${i}/5` } });
const lease = (ctx: ExecutorContext, intent: string) => ctx.step({ intent, executor: "computer.lease", ms: 0, outcome: "note" });

const REPORT = ["Research: licence classes for home building in NSW", "- A contractor licence lets you contract with a homeowner [1]", "Sources:", "[1] Home building licences - https://www.fairtrading.nsw.gov.au/home-building-licences", "Uncertainties:", "- None found beyond the limits of the pages read."].join("\n");

/** SYNTHETIC shared computers behind the REAL computerCommand: starting a job creates a real job whose body is the test's. */
function syntheticComputers(jobs: JobService, list: { name: string; label: string }[], body: (jobId: string, ctx: ExecutorContext, goal: string) => Promise<any>) {
  const started: { computer: string; by: string; title: string; steps: unknown }[] = [];
  const service = {
    canPlanGoals: false,
    canResearch: true,
    list: () => list.map((c) => ({ name: c.name, label: c.label })),
    store: { get: (name: string) => list.find((c) => c.name === name) },
    deviceFor: () => ({ id: "synthetic-device" }),
    view: (name: string) => ({ id: `synthetic-${name}`, label: list.find((c) => c.name === name)?.label ?? name, state: "online", controller: { kind: "none" }, assigned: null, paused: null, takeoverPending: null }),
    jobView: () => null,
    lastJob: () => null,
    async startJob(input: { computer: string; by: string; principal: any; title: string; steps: { args: { goal: string } }[] }) {
      started.push({ computer: input.computer, by: input.by, title: input.title, steps: input.steps });
      const job = jobs.create({ kind: "control", principal: { personId: input.by, via: input.principal.via, actor: input.principal.actor } as never, targetDeviceId: `synthetic-${input.computer}`, title: input.title });
      void jobs.run(job.id, (ctx) => body(job.id, ctx, String(input.steps[0]?.args?.goal ?? "")));
      return { ok: true as const, jobId: job.id };
    },
  };
  return { service, started };
}

async function setup(computers: { name: string; label: string }[] = [{ name: "research", label: "Research" }, { name: "builder", label: "Builder" }], body?: Parameters<typeof syntheticComputers>[3]) {
  const dir = mkdtempSync(join(tmpdir(), "research-loop-jobs-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 400, snapshotMs: 0 });
  const rig = await loopRig(jobs);
  cleanups.push(async () => {
    await rig.close();
    try { jobs.close(); } catch { /* still closing */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles close at GC on Windows */ }
  });
  const synthetic = syntheticComputers(jobs, computers, body ?? (async () => (await sleep(80), { ok: true, note: "done" })));
  const command = createCommandService({
    jobs: () => jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device in this test" }),
    delegates: { computers: withComputerResolution(() => synthetic.service.list(), (u, p) => computerCommand(synthetic.service as never, u, p)) },
    graceMs: 50, dedupeMs: 0, threads: rig.threads, deviceLabel: (id) => id,
  });
  const say = (principal: Principal, utterance: string, body: Record<string, unknown> = {}) => command.run({ principal, body: { utterance, ...body } as never });
  return { jobs, rig, synthetic, command, say };
}
const entriesOf = (rig: LoopRig, person = "usman") => rig.conversations.get(jarvisThreadId(person))?.entries ?? [];

describe("routing: the research computer is the one named Research, and the acknowledgement names the real job and target", () => {
  test("typed, any case: ONE job on the named shared computer; the reply carries the goal, the computer and the job id; the same event id runs nothing twice", async () => {
    const { rig, synthetic, say, jobs } = await setup();
    const goal = "research the licence classes for home building in NSW";
    const r = await say(usman, `Use the RESEARCH computer to ${goal}`, { eventId: "evt-typed-1" });
    expect(r.ok).toBe(true);
    expect(synthetic.started).toHaveLength(1);
    expect(synthetic.started[0]).toMatchObject({ computer: "research", by: "usman" });
    expect(r.jobId).toBeTruthy();
    expect(jobs.get(r.jobId!)).toMatchObject({ targetDeviceId: "synthetic-research", kind: "control" });
    expect(r.said).toContain("Started on research:");
    expect(r.said).toContain(goal);
    expect(r.said).toContain(`(job ${r.jobId!.slice(0, 8)})`);
    // The conversation's first entry says the same real thing.
    expect(entriesOf(rig)[0]).toMatchObject({ state: "started", jobId: r.jobId });
    expect(entriesOf(rig)[0].text).toContain(`job ${r.jobId!.slice(0, 8)}`);
    // The same event again (a reconnect resend, a double tap): the first outcome, no second job.
    await say(usman, `Use the RESEARCH computer to ${goal}`, { eventId: "evt-typed-1" });
    expect(synthetic.started).toHaveLength(1);
    expect(jobs.list({ limit: 10 })).toHaveLength(1);
  });

  test("spoken: a short acknowledgement that still names the target and the job", async () => {
    const { synthetic, say } = await setup();
    const r = await say(usman, "use the research computer to research dental clinics in Parramatta", { source: "voice" });
    expect(synthetic.started).toHaveLength(1);
    expect(r.said).toMatch(/Started on research/);
    expect(r.said).toMatch(/Job [0-9a-f]{8}\.$/);
  });

  test("the computer is found by its label when the stored name differs (case-insensitive), and the job goes to THAT computer", async () => {
    const { synthetic, say } = await setup([{ name: "rsch-1", label: "Research" }, { name: "builder", label: "Builder" }]);
    const r = await say(usman, "Use the research computer to research NSW licence classes");
    expect(r.ok).toBe(true);
    expect(synthetic.started.map((s) => s.computer)).toEqual(["rsch-1"]);
    expect(r.said).toContain("Started on rsch-1:");
  });

  test("absent: it says so by name and runs nothing anywhere else", async () => {
    const { synthetic, say, jobs } = await setup([{ name: "builder", label: "Builder" }]);
    const r = await say(usman, "Use the research computer to research NSW licence classes");
    expect(r.ok).toBe(false);
    expect(r.said).toMatch(/no shared computer called "research"/i);
    expect(r.said).toContain("builder");
    expect(synthetic.started).toHaveLength(0);
    expect(jobs.list({ limit: 5 })).toHaveLength(0);
  });

  test("ambiguous: two computers could be 'research', so it asks which and runs nothing", async () => {
    const { synthetic, say } = await setup([{ name: "research-a", label: "Research A" }, { name: "research-b", label: "Research B" }]);
    const r = await say(usman, "Use the research computer to research NSW licence classes");
    expect(r.ok).toBe(false);
    expect(r.said).toMatch(/More than one shared computer could be "research": research-a, research-b/);
    expect(synthetic.started).toHaveLength(0);
  });

  test("ownership is unchanged: both founders may assign a shared computer (by their own principal); a personal PC is never assignable this way", async () => {
    const { synthetic, say } = await setup();
    await say(mehroz, "Use the research computer to research NSW licence classes");
    expect(synthetic.started.map((s) => `${s.by}@${s.computer}`)).toEqual(["mehroz@research"]);
    // "usman's PC" is a personal machine, not a shared computer: the computers lane does not take it, and nothing starts there.
    await say(mehroz, "use usman's pc to research NSW licence classes", { source: "acceptance" });
    expect(synthetic.started).toHaveLength(1);
  });
});

describe("progress and the result reach the asker's conversation live, through /__events, with no refresh", () => {
  test("started, sub-goal steps, takeover-paused and resumed arrive while the job is still running; the result is ONE web-sourced entry with the saved file and the source links; then the job's end", async () => {
    const hold = defer();
    const body = async (jobId: string, ctx: ExecutorContext) => {
      subgoal(ctx, 1, "started", "Searching");
      subgoal(ctx, 1, "done", "3 candidate pages");
      await hold.promise;
      lease(ctx, "paused before the next move of step 1: mehroz is taking control");
      lease(ctx, "control returned to the agent; re-reading the computer before the next move of step 1");
      subgoal(ctx, 2, "done", "read fairtrading.nsw.gov.au");
      subgoal(ctx, 4, "started", "Saving report-20261002T031500.md in the computer's working folder");
      subgoal(ctx, 4, "done", "report-20261002T031500.md written and read back");
      const back = await threadDeliver(rig.conversations)({ jobId, by: "usman", title: "research", report: REPORT, file: "report-20261002T031500.md" });
      expect(back.delivered).toBe(true);
      subgoal(ctx, 5, "done", "The report is in your conversation");
      return { ok: true, note: "Report ready: 1 cited fact from 1 source (fairtrading.nsw.gov.au)." };
    };
    const { rig, jobs, say } = await setup(undefined, body);
    const usmanStream = await rig.open("usman");
    const mehrozStream = await rig.open("mehroz");
    const voice = fakeVoice(rig.gate, memoryStorage());
    voice.tick(); // the voice session is up and listening

    const r = await say(usman, "Use the research computer to research the licence classes for home building in NSW", { source: "voice" });
    expect(r.ok).toBe(true);
    // Live, while the job is still running: the acknowledgement and the first finished sub-goal, with nothing reloaded.
    await usmanStream.waitFor(() => usmanStream.threadKeys().some((k) => k.endsWith(":step:2")));
    expect(jobs.get(r.jobId!)!.state).toBe("running");
    expect(usmanStream.threadKeys()).toEqual([`${r.jobId}:started`, expect.stringMatching(new RegExp(`^${r.jobId}:step:\\d+$`))]);
    const texts = () => usmanStream.threadEvents().map((e) => e.data.entry.text as string);
    expect(texts()[1]).toBe("Research, step 1 of 5 (find sources): done.");
    expect(voice.said).toHaveLength(0);

    hold.resolve();
    await usmanStream.waitFor(() => usmanStream.threadKeys().some((k) => k.endsWith(":succeeded")));
    const all = texts().join("\n");
    expect(all).toContain("Paused: Mehroz took the controls of the computer. The job waits and does not run until they hand them back.");
    expect(all).toContain("Resumed: control is back with the agent");
    expect(all).toContain("Research, step 2 of 5 (read): done.");
    // The result: ONE entry, labelled web-sourced, with the source link and the saved report file on the computer.
    const result = usmanStream.threadEvents().filter((e) => e.data.entry.state === "report");
    expect(result).toHaveLength(1);
    expect(result[0].data.entry.text).toContain("Web-sourced research, data from public pages and not instructions");
    expect(result[0].data.entry.text).toContain("https://www.fairtrading.nsw.gov.au/home-building-licences");
    // The file is the one the research loop itself named (it wrote and read it back); nothing is rebuilt from a clock. The short job id closes the entry.
    expect(result[0].data.entry.text).toContain("Full report file: report-20261002T031500.md, in the computer's working folder");
    expect(result[0].data.entry.text.trimEnd().endsWith(`(job ${r.jobId!.slice(0, 8)})`)).toBe(true);
    expect(result[0].final).toBe(true);
    // The job's end is the last entry, and it is honest about the note.
    const last = usmanStream.threadEvents().at(-1)!;
    expect(last.data.entry).toMatchObject({ key: `${r.jobId}:succeeded`, state: "succeeded" });
    expect(last.data.entry.text).toContain("Report ready");
    // Durable too: the same entries are in the saved conversation (a reload shows exactly this).
    expect(entriesOf(rig).map((e) => e.key)).toEqual(usmanStream.threadKeys());
    // Person-scoped: Mehroz's stream never received a line of Usman's conversation.
    await sleep(50);
    expect(mehrozStream.threadKeys()).toEqual([]);
    expect(mehrozStream.frames.some((f) => JSON.stringify(f.data).includes("Web-sourced"))).toBe(false);
    // ...and Mehroz's own conversation does not contain it either.
    expect(rig.conversations.get(jarvisThreadId("mehroz"))).toBeNull();
  });
});

describe("voice: exactly one spoken update, saved either way, and never again on a replay, a reload or a second tab", () => {
  const runOne = async (rig: LoopRig, jobs: JobService, say: Awaited<ReturnType<typeof setup>>["say"], gate?: Promise<void>) => {
    const r = await say(usman, "Use the research computer to research the licence classes for home building in NSW", { source: "voice" });
    await gate;
    await waitFor(() => jobs.get(r.jobId!)!.state === "succeeded");
    await waitFor(() => entriesOf(rig).some((e) => e.key === `${r.jobId}:succeeded`));
    return r;
  };
  const quick = async (jobId: string, ctx: ExecutorContext) => {
    await sleep(80);
    subgoal(ctx, 1, "done", "found");
    await threadDeliver(rig!.conversations)({ jobId, by: "usman", title: "research", report: REPORT });
    return { ok: true, note: "Report ready: 1 cited fact from 1 source (fairtrading.nsw.gov.au)." };
  };
  let rig: LoopRig | undefined;

  test("an active voice session says one short line when the job really ends; a reload and a second tab (same browser storage) say nothing more", async () => {
    const s = await setup(undefined, quick);
    rig = s.rig;
    const storage = memoryStorage();
    const tabOne = fakeVoice(s.rig.gate, storage);
    tabOne.tick();
    await runOne(s.rig, s.jobs, s.say);
    tabOne.tick();
    expect(tabOne.said).toHaveLength(1);
    expect(tabOne.said[0]).toMatch(/is finished/);
    // Another tab of the same browser, and a page reload, join later: the same stable event id is already handled.
    const tabTwo = fakeVoice(s.rig.gate, storage);
    tabTwo.tick();
    const reloaded = fakeVoice(s.rig.gate, memoryStorage()); // even with NO browser memory the server's claim is exactly-once
    reloaded.tick();
    tabOne.tick();
    expect(tabTwo.said).toEqual([]);
    expect(reloaded.said).toEqual([]);
    expect(tabOne.said).toHaveLength(1);
    // The server side of the same fact: one gate event for the job's end, claimed once, persisted under the stable key.
    const events = s.rig.gate.list(0).events.filter((e) => e.source === "jarvis-job");
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toMatch(/^job:[0-9a-f-]{36}:succeeded$/);
    expect(events[0].spokenAt).toBeTruthy();
    // Telling the hub the same job end again (a restart re-read, a re-delivered notice) is a duplicate, not a second line.
    const entry = entriesOf(s.rig).find((e) => e.state === "succeeded")!;
    const again = s.rig.gate.submit({ source: "jarvis-job", text: entry.speak!, dedupeKey: `job:${entry.jobId}:succeeded` });
    expect(again).toMatchObject({ accepted: false, duplicate: true });
    tabOne.tick();
    expect(tabOne.said).toHaveLength(1);
  });

  test("no voice session (nobody polling): the durable entry is saved and the stream carries it; nothing is spoken, and the line goes to the toast fallback instead", async () => {
    const s = await setup(undefined, quick);
    rig = s.rig;
    const stream = await s.rig.open("usman");
    await runOne(s.rig, s.jobs, s.say);
    expect(entriesOf(s.rig).some((e) => e.state === "report")).toBe(true);
    expect(entriesOf(s.rig).some((e) => e.state === "succeeded")).toBe(true);
    await stream.waitFor(() => stream.threadKeys().some((k) => k.endsWith(":succeeded")));
    const ev = s.rig.gate.list(0).events.filter((e) => e.source === "jarvis-job");
    expect(ev).toHaveLength(1);
    expect(ev[0].spokenAt).toBeUndefined();
    expect(ev[0].toastedAt).toBeTruthy();
    expect(s.rig.toasts).toHaveLength(1);
  });

  test("the research result entry itself is never spoken, and a person who is not at this PC never has a line spoken here", async () => {
    const s = await setup(undefined, quick);
    rig = s.rig;
    const voice = fakeVoice(s.rig.gate, memoryStorage());
    voice.tick();
    await runOne(s.rig, s.jobs, s.say);
    voice.tick();
    expect(voice.said.join(" ")).not.toMatch(/Web-sourced|fairtrading|Sources/);
    // Mehroz's job (his session is not at this PC): his own conversation has the result, and nothing is spoken here for it.
    const r = await say2(s, mehroz);
    await waitFor(() => (s.rig.conversations.get(jarvisThreadId("mehroz"))?.entries ?? []).some((e) => e.key === `${r.jobId}:succeeded`));
    voice.tick();
    expect(voice.said).toHaveLength(1);
  });
  const say2 = (s: Awaited<ReturnType<typeof setup>>, who: Principal) => s.say(who, "Use the research computer to research another thing about NSW", { source: "voice" });
});

describe("a job that did not succeed never produces a success announcement", () => {
  test("stopped, failed (with its reason) and unknown-outcome jobs each leave an honest entry and an honest spoken line, and no 'finished'", async () => {
    const hold = defer();
    const body = async (_id: string, ctx: ExecutorContext, goal: string) => {
      const which = /topic (\w+)/.exec(goal)?.[1];
      await sleep(80);
      subgoal(ctx, 1, "done", "found");
      if (which === "cancel") {
        await Promise.race([hold.promise, new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }))]);
        return { ok: false, note: "Stopped on request." };
      }
      if (which === "fail") return { ok: false, note: "Couldn't read the page: it timed out." };
      return { ok: false, settle: "unknown" as const, note: "Step 2 (browser.navigate) may or may not have happened; I did not run it again." };
    };
    const { rig, jobs, say } = await setup(undefined, body);
    const voice = fakeVoice(rig.gate, memoryStorage());
    voice.tick();
    const start = (w: string) => say(usman, `Use the research computer to research topic ${w}`, { source: "voice" });
    const cancelled = await start("cancel");
    await waitFor(() => entriesOf(rig).some((e) => e.jobId === cancelled.jobId && e.key.includes(":step:")));
    await jobs.cancel(cancelled.jobId!);
    await waitFor(() => jobs.get(cancelled.jobId!)!.state === "cancelled");
    const failed = await start("fail");
    const unknown = await start("unknown");
    for (const j of [cancelled, failed, unknown]) await waitFor(() => entriesOf(rig).some((e) => e.jobId === j.jobId && !["started", "progress"].includes(e.state)));
    voice.tick();

    const endOf = (jobId?: string) => entriesOf(rig).find((e) => e.jobId === jobId && !["started", "progress", "report"].includes(e.state))!;
    expect(endOf(cancelled.jobId)).toMatchObject({ state: "cancelled" });
    expect(endOf(cancelled.jobId).text).toMatch(/^Stopped: .*Nothing further ran\./);
    expect(endOf(failed.jobId)).toMatchObject({ state: "failed" });
    expect(endOf(failed.jobId).text).toMatch(/^Failed: .*Couldn't read the page: it timed out\./);
    expect(endOf(unknown.jobId)).toMatchObject({ state: "unknown" });
    expect(endOf(unknown.jobId).text).toMatch(/^Ended without a confirmed outcome: .*may or may not have happened/);
    // Not one of them reads as a success, in the conversation or out loud.
    const everything = entriesOf(rig).filter((e) => !["started", "progress"].includes(e.state)).map((e) => e.text).join("\n");
    expect(everything).not.toMatch(/\bFinished\b|Report ready/);
    expect(voice.said).toHaveLength(3);
    expect(voice.said.filter((l) => /was stopped\.$/.test(l))).toHaveLength(1);
    expect(voice.said.filter((l) => /failed\.$/.test(l))).toHaveLength(1);
    expect(voice.said.filter((l) => /ended without a confirmed result\.$/.test(l))).toHaveLength(1);
    expect(voice.said.join(" ")).not.toMatch(/is finished/);
    // And no research result was returned for any of them.
    expect(entriesOf(rig).some((e) => e.state === "report")).toBe(false);
  });
});

describe("events are notifications only: replaying or re-delivering one can never start, resume or re-run a job", () => {
  test("server: reconnecting with an old Last-Event-ID replays the entries and the job count, states, steps, started computers and gate are untouched", async () => {
    const quick = async (jobId: string, ctx: ExecutorContext) => {
      await sleep(80);
      subgoal(ctx, 1, "done", "found");
      await threadDeliver(rig.conversations)({ jobId, by: "usman", title: "research", report: REPORT });
      return { ok: true, note: "Report ready: 1 cited fact from 1 source (fairtrading.nsw.gov.au)." };
    };
    const { rig, jobs, say, synthetic } = await setup(undefined, quick);
    const first = await rig.open("usman");
    const r = await say(usman, "Use the research computer to research the licence classes for home building in NSW");
    await first.waitFor(() => first.threadKeys().some((k) => k.endsWith(":succeeded")));
    const hello = first.frames.find((f) => f.event === "hello")!.data;
    expect(hello.mode).toBe("snapshot");

    const before = JSON.stringify({ jobs: jobs.list({ limit: 20 }).map((j) => [j.id, j.state, j.stepCount, j.updatedAt]), started: synthetic.started.length, entries: entriesOf(rig), gate: rig.gate.list(0).events.length, head: rig.bus.head() });
    const jobEvents: unknown[] = [];
    const off = jobs.subscribe((e) => jobEvents.push(e));
    // The first frame's id is the position before everything: replay all of it, twice, from two "tabs".
    const startId = `${hello.epoch}:0`;
    const replayA = await rig.open("usman", { lastEventId: startId });
    const replayB = await rig.open("usman", { lastEventId: startId });
    await replayA.waitFor((f) => f.some((x) => x.data?.data?.entry?.key?.endsWith(":succeeded")));
    await replayB.waitFor((f) => f.some((x) => x.data?.data?.entry?.key?.endsWith(":succeeded")));
    expect(replayA.frames.find((f) => f.event === "hello")!.data.mode).toBe("replay");
    expect(replayA.threadKeys()).toEqual(first.threadKeys());
    await sleep(60);
    off();
    expect(jobEvents).toEqual([]);
    const after = JSON.stringify({ jobs: jobs.list({ limit: 20 }).map((j) => [j.id, j.state, j.stepCount, j.updatedAt]), started: synthetic.started.length, entries: entriesOf(rig), gate: rig.gate.list(0).events.length, head: rig.bus.head() });
    expect(after).toBe(before);
    expect(r.jobId).toBeTruthy();
    // Re-delivery inside the hub: the same entry key is a no-op (no second entry, no second notice), and re-reading the finished job adds nothing.
    const head = rig.bus.head();
    expect(rig.conversations.appendEntry(jarvisThreadId("usman"), { key: `${r.jobId}:succeeded`, jobId: r.jobId!, state: "succeeded", text: "again" })).toBeNull();
    await rig.threads.reconcile();
    expect(rig.bus.head()).toBe(head);
    expect(synthetic.started).toHaveLength(1);
  });

  test("a stream with no session gets nothing at all (401), and cannot be used to post anything (GET only)", async () => {
    const { rig } = await setup();
    expect((await rig.open(null)).status).toBe(401);
    const post = await fetch(`${rig.base}/__events`, { method: "POST", headers: { "x-person": "usman" }, body: JSON.stringify({ jobId: "x", action: "run" }) });
    expect(post.status).toBe(405);
  });
});

describe("which job steps become a line in the conversation (pure)", () => {
  const step = (executor: string, intent: string, verification?: { method: string; ok: boolean | null }) => ({ seq: 3, at: 1, executor, intent, ms: 0, outcome: "note" as const, ...(verification ? { verification } : {}) });
  test("sub-goals that finished, failed or were skipped; a person taking the computer; control coming back. Nothing else.", async () => {
    const { progressFor } = await import("./threads");
    const sg = { method: "research-subgoal", ok: true };
    expect(progressFor(step("research", "sub-goal 3 of 5, compare: done. Compared 2 sources (3 of 5 done)", sg))).toBe("Research, step 3 of 5 (compare): done.");
    expect(progressFor(step("research", "sub-goal 2 of 5, read: failed. The page did not open (1 of 5 done)", sg))).toBe("Research, step 2 of 5 (read): failed. The page did not open");
    expect(progressFor(step("research", "sub-goal 2 of 5, read: started. Opening it (1 of 5 done)", sg))).toBeNull();
    expect(progressFor(step("research", "search \"nsw licences\": 8 results, 5 usable", { method: "web-search", ok: true }))).toBeNull();
    expect(progressFor(step("computer.lease", "paused before step 2 (page.text): usman is taking control"))).toMatch(/^Paused: Usman took the controls of the computer./);
    expect(progressFor(step("computer.lease", "control returned to the agent; re-reading the computer before step 2"))).toMatch(/^Resumed: /);
    expect(progressFor(step("companion", "step 1 echo: Echoed."))).toBeNull();
  });
});

describe("review regressions", () => {
  test("a hub restart mid-job: progress recorded while it was down is backfilled, the person is still 'at this PC' (persisted), and the end is spoken exactly once", async () => {
    const hold = defer();
    const { rig, jobs, say } = await setup(undefined, async (_id, ctx) => {
      await sleep(60);
      subgoal(ctx, 1, "done", "found");
      await hold.promise;
      subgoal(ctx, 2, "done", "read");
      return { ok: true, note: "Report ready: 1 cited fact from 1 source." };
    });
    const { createJobThreads } = await import("./threads");
    const { wireThreadNotices } = await import("./thread-notify");
    const localFile = join(rig.dir, "thread-local.json"); // where the first hub life remembered the person is at this PC
    const life1 = rig.threads;
    const voice = fakeVoice(rig.gate);
    voice.tick();
    const r = await say(usman, "Use the research computer to research the licence classes for home building in NSW", { source: "voice" });
    await waitFor(() => entriesOf(rig).some((e) => e.jobId === r.jobId && e.key.includes(":step:")));
    // The hub goes down; the job keeps going; one more step lands while nothing is watching.
    life1.stop();
    hold.resolve();
    await waitFor(() => jobs.get(r.jobId!)!.state === "succeeded");
    // The hub comes back: a new watcher with the same files.
    const life2 = createJobThreads({ conversations: rig.conversations, jobs: () => jobs, pollMs: 60_000, localFile });
    const unwire2 = wireThreadNotices({ threads: life2, activity: rig.sources, events: rig.gate });
    cleanups.push(() => { life2.stop(); unwire2(); });
    expect(life2.isLocal("usman")).toBe(true); // not forgotten with the process
    await life2.start();
    await waitFor(() => entriesOf(rig).some((e) => e.key === `${r.jobId}:succeeded`));
    voice.tick();
    voice.tick();
    expect(voice.said).toHaveLength(1);
    expect(voice.said[0]).toMatch(/is finished/);
    expect(entriesOf(rig).filter((e) => e.key === `${r.jobId}:succeeded`)).toHaveLength(1);
    // The step recorded while it was down is there, once, and was not spoken.
    expect(entriesOf(rig).filter((e) => e.state === "progress" && e.text.includes("step 2 of 5"))).toHaveLength(1);
    await life2.start();
    expect(voice.said).toHaveLength(1);
  });

  test("the computer is found even when its name is not the word said, and a goal that uses the word is not mangled", async () => {
    const { synthetic, say } = await setup([{ name: "research-2", label: "Research" }]);
    const r = await say(usman, "research halal ETFs on the research computer");
    expect(r.ok).toBe(true);
    expect(synthetic.started).toHaveLength(1);
    expect(synthetic.started[0]).toMatchObject({ computer: "research-2", title: "research halal ETFs" });
    const shown = await say(usman, "show me the research computer");
    expect(shown.said).toMatch(/Research|research-2/);
    expect(shown.said).not.toMatch(/no shared computer/i);
    expect(synthetic.started).toHaveLength(1); // showing starts nothing
  });

  test("the HUD list: a job-end line is returned to its owner only, and a remote read neither shows it nor counts as a listening voice session", async () => {
    const { rig } = await setup();
    rig.gate.submit({ source: "jarvis-job", text: "x is finished.", dedupeKey: "job:abc:succeeded", person: "usman" });
    expect(rig.gate.list(0, { person: "usman", local: true }).events).toHaveLength(1);
    expect(rig.gate.list(0, { person: "mehroz", local: false }).events).toHaveLength(0);
    // Unscoped alerts (watchdogs and the like) are everyone's, as before.
    rig.gate.submit({ source: "watchdog", text: "Backup failed.", dedupeKey: "wd:1" });
    expect(rig.gate.list(0, { person: "mehroz", local: false }).events.map((e) => e.source)).toEqual(["watchdog"]);
    // A remote GET does not refresh the poll time: with no local listener the next speak event still goes to the toast fallback.
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    let clock = Date.parse("2026-10-02T02:00:00Z"); // midday in Sydney
    const toasts: string[] = [];
    const gate = createJarvisEvents(dir, { now: () => clock, quietHours: { start: 0, end: 0 }, onFallbackToast: (e) => toasts.push(e.text) });
    gate.list(0, { person: "usman", local: true });
    clock += 60_000; // the voice session has not polled for a minute
    gate.list(0, { person: "mehroz", local: false }); // a remote read does not make it "listening"
    gate.submit({ source: "watchdog", text: "Backup failed.", dedupeKey: "wd:1" });
    expect(toasts).toEqual(["Backup failed."]);
    gate.list(0, { person: "usman", local: true }); // a local poll does
    gate.submit({ source: "watchdog", text: "Backup failed again.", dedupeKey: "wd:2" });
    expect(toasts).toEqual(["Backup failed."]);
  });

  test("only a real report file name is ever printed as the saved file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deliver-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { conversationStore } = await import("../conversations");
    const store = conversationStore(dir);
    const t = store.ensureThread({ personId: "usman" })!;
    store.linkJob(t.id, { jobId: "11111111-2222-3333-4444-555555555555", kind: "job", title: "x", state: "running" });
    const deliver = threadDeliver(store as never);
    await deliver({ jobId: "11111111-2222-3333-4444-555555555555", by: "usman", title: "x", report: "R", file: "../../etc/passwd" });
    expect(store.get(t.id)!.entries![0].text).not.toContain("Full report file");
    expect(store.get(t.id)!.entries![0].text).toContain("(job 11111111)");
  });
});
