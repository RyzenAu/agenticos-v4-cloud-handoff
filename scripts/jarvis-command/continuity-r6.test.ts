// r6: conversation continuity for the four bot-computer workflows (research, builder, website audit, business preparation).
//
// The journey under test: assign -> acknowledgement -> live progress -> verified artifact -> exactly ONE completion, in the conversation that asked,
// and it stays true across a reconnect, a restart, a replayed event, a stop and a failure.
//
// Two layers, both SYNTHETIC computers (labelled), REAL everything else (JobService/SQLite, conversation store, job-thread watcher, bus + SSE stream over
// real HTTP, interjection gate, command service, computers service and lease, artifact store and routes):
//   A. "synthetic computers": a job whose body is the test's, behind the real computerCommand, for the rules that do not need a browser
//   B. "real hub": the real computers service on an in-process companion running the real Linux executors, driven by a spoken phrase
// The real-host runs are in docs/programme-20261001/BOT-WORKFLOWS-R6.md.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinuxExecutors } from "../../companion/linux/executors-linux";
import { canAnnounce, createAnnouncementQueue } from "../../src/lib/free-voice-client";
import { computerCommand } from "../computers/jarvis";
import { threadDeliver } from "../computers/research-wiring";
import { startComputersHub, pairPersonalPc, type ComputersHub } from "../computers/test-harness";
import { jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { JobService, type ExecutorContext } from "../jobs/service";
import { withComputerResolution } from "./computer-target";
import { fakeVoice, loopRig, memoryStorage, type LoopRig } from "./research-loop-rig";
import { createCommandService } from "./service";
import { createJobThreads, progressFor } from "./threads";
import { wireThreadNotices } from "./thread-notify";

setDefaultTimeout(60_000);
const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, ms = 6000) => {
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
const entriesOf = (rig: LoopRig, person = "usman") => rig.conversations.get(jarvisThreadId(person))?.entries ?? [];

// ------------------------------------------------------------------------------------------------------------- A. synthetic computers
type Kind = "research" | "builder" | "audit" | "bizprep";
const PHRASE: Record<Kind, string> = {
  research: "research the licence classes for home building in NSW",
  builder: "build an opening hours component for the clinic site",
  audit: "audit the demo clinic fixture",
  bizprep: "prepare a comparison table of three website packages",
};
const subgoal = (ctx: ExecutorContext, kind: Kind, i: number, name: string, status: "started" | "done" | "failed", text: string) =>
  ctx.step({ intent: `sub-goal ${i} of 5, ${name}: ${status}. ${text} (${status === "done" ? i : i - 1} of 5 done)`, executor: kind, ms: 0, outcome: status === "failed" ? "failed" : status === "done" ? "ok" : "note", verification: { method: kind === "research" ? "research-subgoal" : "workflow-subgoal", ok: status === "failed" ? false : status === "done" ? true : null, evidence: `${i}/5` } });

function syntheticComputers(jobs: JobService, list: { name: string; label: string }[], body: (jobId: string, ctx: ExecutorContext, goal: string, steps: { executor: string }[]) => Promise<any>) {
  const started: { computer: string; by: string; title: string; steps: { executor: string; args: Record<string, unknown> }[] }[] = [];
  const service = {
    canPlanGoals: false,
    canResearch: true,
    canWorkflows: true,
    list: () => list.map((c) => ({ name: c.name, label: c.label })),
    store: { get: (name: string) => list.find((c) => c.name === name) },
    deviceFor: () => ({ id: "synthetic-device" }),
    view: (name: string) => ({ id: `synthetic-${name}`, label: list.find((c) => c.name === name)?.label ?? name, state: "online", controller: { kind: "none" }, assigned: null, paused: null, takeoverPending: null }),
    jobView: () => null,
    lastJob: () => null,
    async startJob(input: { computer: string; by: string; principal: any; title: string; steps: { executor: string; args: Record<string, unknown> }[] }) {
      started.push({ computer: input.computer, by: input.by, title: input.title, steps: input.steps });
      const job = jobs.create({ kind: "control", principal: { personId: input.by, via: input.principal.via, actor: input.principal.actor } as never, targetDeviceId: `synthetic-${input.computer}`, title: input.title });
      void jobs.run(job.id, (ctx) => body(job.id, ctx, String(input.steps[0]?.args?.goal ?? input.steps[0]?.args?.brief ?? ""), input.steps));
      return { ok: true as const, jobId: job.id };
    },
  };
  return { service, started };
}

async function setup(body?: Parameters<typeof syntheticComputers>[2]) {
  const dir = mkdtempSync(join(tmpdir(), "continuity-r6-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 400, snapshotMs: 0 });
  const rig = await loopRig(jobs);
  cleanups.push(async () => {
    await rig.close();
    try { jobs.close(); } catch { /* closing */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles close at GC on Windows */ }
  });
  const synthetic = syntheticComputers(jobs, [{ name: "research", label: "Research" }, { name: "builder", label: "Builder" }], body ?? (async () => (await sleep(80), { ok: true, note: "done" })));
  const command = createCommandService({
    jobs: () => jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device in this test" }),
    delegates: { computers: withComputerResolution(() => synthetic.service.list(), (u, p) => computerCommand(synthetic.service as never, u, p)) },
    graceMs: 50, dedupeMs: 0, threads: rig.threads, deviceLabel: (id) => id,
  });
  const say = (principal: Principal, utterance: string, body: Record<string, unknown> = {}) => command.run({ principal, body: { utterance, ...body } as never });
  return { jobs, rig, synthetic, command, say, dir };
}

/** A body that behaves like a finished workflow: five sub-goals, then the one result entry, then success. */
const finishing = (kind: Kind, rigRef: () => LoopRig, hold?: Promise<void>) => async (jobId: string, ctx: ExecutorContext) => {
  const names = ["one", "two", "three", "four", "five"];
  for (let i = 1; i <= 4; i++) {
    subgoal(ctx, kind, i, names[i - 1], "done", `step ${i} ok`);
    if (i === 2 && hold) await hold;
    await sleep(15);
  }
  subgoal(ctx, kind, 5, names[4], "done", "kept");
  await threadDeliver(rigRef().conversations)({ jobId, by: "usman", title: kind, report: `${kind} result text`, artifact: `${kind} saved`, label: kind, web: kind === "research" || kind === "audit" });
  return { ok: true, note: `${kind} complete` };
};

describe("A. each workflow's progress, result and completion arrive once, in the asker's conversation", () => {
  for (const kind of ["research", "builder", "audit", "bizprep"] as const) {
    test(`${kind}: started, live progress, ONE result entry offering the saved result, ONE finished entry, ONE spoken line`, async () => {
      let rigRef!: LoopRig;
      const hold = defer();
      const s = await setup((id, ctx) => finishing(kind, () => rigRef, hold.promise)(id, ctx));
      rigRef = s.rig;
      const stream = await s.rig.open("usman");
      const voice = fakeVoice(s.rig.gate, memoryStorage());
      voice.tick();
      const r = await s.say(usman, `Use the builder computer to ${PHRASE[kind]}`, { source: "voice", eventId: `evt-${kind}-1` });
      expect(r.ok).toBe(true);
      expect(s.synthetic.started).toHaveLength(1);
      expect(s.synthetic.started[0].steps[0].executor).toBe(kind);
      expect(r.said).toMatch(/Job [0-9a-f]{8}\.$/);
      // progress is on the stream while the job is still running: nothing has been reloaded and the job has not ended
      await stream.waitFor(() => stream.threadEvents().some((e) => /step 2 of 5/.test(e.data.entry.text)));
      expect(s.jobs.get(r.jobId!)!.state).toBe("running");
      const label = { research: "Research", builder: "Builder", audit: "Website audit", bizprep: "Business preparation" }[kind];
      expect(stream.threadEvents().map((e) => e.data.entry.text as string).some((t) => t.startsWith(`${label}, step 1 of 5`))).toBe(true);
      expect(voice.said).toEqual([]);
      hold.resolve();
      await stream.waitFor(() => stream.threadKeys().some((k) => k.endsWith(":succeeded")));
      const entries = entriesOf(s.rig);
      const results = entries.filter((e) => e.state === "report");
      expect(results).toHaveLength(1);
      expect(results[0].text).toContain(`Saved result: ${kind} saved`);
      expect(/Web-sourced/.test(results[0].text)).toBe(kind === "research" || kind === "audit");
      expect(entries.filter((e) => e.state === "succeeded")).toHaveLength(1);
      expect(entries.at(-1)!.key).toBe(`${r.jobId}:succeeded`);
      voice.tick();
      voice.tick();
      expect(voice.said).toHaveLength(1);
      expect(voice.said[0]).toMatch(/is finished/);
    });
  }

  test("a person who was away finds the result waiting: the entries are durable, and a new stream or tab replays them in order without speaking again", async () => {
    let rigRef!: LoopRig;
    const s = await setup((id, ctx) => finishing("audit", () => rigRef)(id, ctx));
    rigRef = s.rig;
    const voice = fakeVoice(s.rig.gate, memoryStorage());
    voice.tick();
    const r = await s.say(usman, `Use the builder computer to ${PHRASE.audit}`, { source: "voice" });
    await waitFor(() => s.jobs.get(r.jobId!)!.state === "succeeded");
    await waitFor(() => entriesOf(s.rig).some((e) => e.key === `${r.jobId}:succeeded`));
    voice.tick();
    expect(voice.said).toHaveLength(1);
    // he comes back later: the store has it, and a brand new stream (no Last-Event-ID) is told about the thread from the start
    const keysStored = entriesOf(s.rig).map((e) => e.key);
    const later = await s.rig.open("usman");
    await later.waitFor((f) => f.some((x) => x.event === "hello"));
    const hello = later.frames.find((f) => f.event === "hello")!.data;
    const replay = await s.rig.open("usman", { lastEventId: `${hello.epoch}:0` });
    await replay.waitFor((f) => f.some((x) => x.data?.data?.entry?.key === `${r.jobId}:succeeded`));
    expect(replay.threadKeys()).toEqual(keysStored);
    voice.tick();
    await sleep(80);
    expect(voice.said).toHaveLength(1); // coming back is not a second announcement
  });
});

describe("A. nothing is duplicated by a replayed command, a replayed entry, a restart or a repeated completion", () => {
  test("the same event id from the same person is the same command: one job, one acknowledgement; another person's identical id is theirs", async () => {
    let rigRef!: LoopRig;
    const s = await setup((id, ctx) => finishing("builder", () => rigRef)(id, ctx));
    rigRef = s.rig;
    const a = await s.say(usman, `Use the builder computer to ${PHRASE.builder}`, { source: "voice", eventId: "evt-dup-0001" });
    const b = await s.say(usman, `Use the builder computer to ${PHRASE.builder}`, { source: "voice", eventId: "evt-dup-0001" });
    expect(b.jobId).toBe(a.jobId);
    expect(b.said).toBe(a.said);
    expect(s.synthetic.started).toHaveLength(1);
    const c = await s.say(mehroz, `Use the builder computer to ${PHRASE.builder}`, { source: "voice", eventId: "evt-dup-0001" });
    expect(c.jobId).not.toBe(a.jobId);
    expect(s.synthetic.started).toHaveLength(2);
    await waitFor(() => s.jobs.get(a.jobId!)!.state === "succeeded" && s.jobs.get(c.jobId!)!.state === "succeeded");
  });

  test("the completion is delivered once even if it is asked for twice, and a re-delivered entry changes nothing", async () => {
    let rigRef!: LoopRig;
    const s = await setup(async (jobId, ctx) => {
      await finishing("bizprep", () => rigRef)(jobId, ctx);
      // the same completion again (a replayed step, a second delivery path)
      const again = await threadDeliver(rigRef.conversations)({ jobId, by: "usman", title: "x", report: "bizprep result text", artifact: "bizprep saved", label: "bizprep", web: false });
      expect(again.where).toMatch(/already there/);
      return { ok: true, note: "done" };
    });
    rigRef = s.rig;
    const r = await s.say(usman, `Use the builder computer to ${PHRASE.bizprep}`, { source: "voice" });
    await waitFor(() => entriesOf(s.rig).some((e) => e.key === `${r.jobId}:succeeded`));
    expect(entriesOf(s.rig).filter((e) => e.state === "report")).toHaveLength(1);
    expect(entriesOf(s.rig).filter((e) => e.state === "succeeded")).toHaveLength(1);
  });

  test("a hub restart mid-job: steps taken while it was down are backfilled once, the end is appended and spoken exactly once", async () => {
    const hold = defer();
    let rigRef!: LoopRig;
    const s = await setup(async (jobId, ctx) => {
      subgoal(ctx, "audit", 1, "open", "done", "open");
      await hold.promise;
      subgoal(ctx, "audit", 2, "desktop", "done", "measured");
      await threadDeliver(rigRef.conversations)({ jobId, by: "usman", title: "audit", report: "Audit text", artifact: "Audit saved", label: "Website audit", web: true });
      return { ok: true, note: "Audit ready" };
    });
    rigRef = s.rig;
    const localFile = join(s.rig.dir, "thread-local.json");
    const voice = fakeVoice(s.rig.gate);
    voice.tick();
    const r = await s.say(usman, `Use the builder computer to ${PHRASE.audit}`, { source: "voice" });
    await waitFor(() => entriesOf(s.rig).some((e) => e.jobId === r.jobId && e.key.includes(":step:")));
    s.rig.threads.stop(); // the hub goes down
    hold.resolve();
    await waitFor(() => s.jobs.get(r.jobId!)!.state === "succeeded");
    const life2 = createJobThreads({ conversations: s.rig.conversations, jobs: () => s.jobs, pollMs: 60_000, localFile });
    const unwire = wireThreadNotices({ threads: life2, activity: s.rig.sources, events: s.rig.gate });
    cleanups.push(() => { life2.stop(); unwire(); });
    await life2.start();
    await life2.start(); // a second start is a no-op
    await waitFor(() => entriesOf(s.rig).some((e) => e.key === `${r.jobId}:succeeded`));
    voice.tick();
    voice.tick();
    expect(voice.said).toHaveLength(1);
    expect(entriesOf(s.rig).filter((e) => e.key === `${r.jobId}:succeeded`)).toHaveLength(1);
    expect(entriesOf(s.rig).filter((e) => e.state === "progress" && /step 2 of 5/.test(e.text))).toHaveLength(1);
    expect(entriesOf(s.rig).filter((e) => e.state === "report")).toHaveLength(1);
  });

  test("a job that was running when the hub died ends as 'not confirmed' (it is never re-run), and says so once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuity-r6-restart-"));
    const path = join(dir, "jobs.sqlite");
    const jobs1 = new JobService({ path, stopGraceMs: 200, snapshotMs: 0 });
    const rig1 = await loopRig(jobs1);
    const hold = defer();
    const synthetic = syntheticComputers(jobs1, [{ name: "builder", label: "Builder" }], async (_id, ctx) => {
      subgoal(ctx, "audit", 1, "open", "done", "open");
      await hold.promise;
      return { ok: true, note: "never" };
    });
    const command = createCommandService({ jobs: () => jobs1, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "n/a" }), delegates: { computers: withComputerResolution(() => synthetic.service.list(), (u, p) => computerCommand(synthetic.service as never, u, p)) }, graceMs: 50, dedupeMs: 0, threads: rig1.threads, deviceLabel: (id) => id });
    const r = await command.run({ principal: usman, body: { utterance: `Use the builder computer to ${PHRASE.audit}`, source: "voice" } as never });
    await waitFor(() => (rig1.conversations.get(jarvisThreadId("usman"))?.entries ?? []).some((e) => e.key.includes(":step:")));
    const jobId = r.jobId!;
    // the hub dies mid-job: the SQLite file stays, the watcher and the voice session are gone
    rig1.threads.stop();
    // A killed hub never closes anything: the second life opens the same SQLite file while the first life's job body is still "running".
    cleanups.push(async () => {
      hold.resolve();
      await sleep(120);
      try { jobs1.close(); } catch { /* closing */ }
    });
    const jobs2 = new JobService({ path, stopGraceMs: 200, snapshotMs: 0 });
    cleanups.push(() => { try { jobs2.close(); } catch { /* closing */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* handles */ } });
    expect(jobs2.recover()).toMatchObject({ unknown: 1 }); // startup recovery: running -> unknown, never re-run
    const after = jobs2.get(jobId)!;
    expect(after.state).toBe("unknown");
    const rig2 = await loopRig(jobs2);
    cleanups.push(() => rig2.close());
    // the second life reads the first life's conversation: copy the entries over (the rig keeps its own folder per life)
    const stored = rig1.conversations.get(jarvisThreadId("usman"))!;
    rig2.conversations.ensureThread({ id: stored.id, personId: "usman" });
    for (const j of stored.jobs ?? []) rig2.conversations.linkJob(stored.id, { jobId: j.jobId, kind: j.kind, title: j.title, state: "running" });
    rig2.threads.stop(); // the rig started its watcher before the conversation was copied in: start it again, as a restarted hub does on boot
    await rig2.threads.start();
    await waitFor(() => (rig2.conversations.get(stored.id)?.entries ?? []).some((e) => e.jobId === jobId && /^(interrupted|unknown)$/.test(e.state)));
    const end = (rig2.conversations.get(stored.id)!.entries ?? []).filter((e) => e.key.startsWith(`${jobId}:`) && /interrupted|unknown/.test(e.state));
    expect(end).toHaveLength(1);
    expect(end[0].text).toMatch(/^Ended without a confirmed outcome/);
    expect(end[0].text).toMatch(/was not re-run/);
    expect((rig2.conversations.get(stored.id)!.entries ?? []).some((e) => e.state === "report")).toBe(false);
    await rig2.threads.start();
    expect((rig2.conversations.get(stored.id)!.entries ?? []).filter((e) => e.key.startsWith(`${jobId}:`) && /interrupted|unknown/.test(e.state))).toHaveLength(1);
  });
});

describe("A. endings are honest: failure and cancellation say what happened, and neither pretends there is a result", () => {
  test("a workflow that fails says Failed with its reason; there is no result entry and no 'finished'", async () => {
    const s = await setup(async (_id, ctx) => {
      await sleep(80); // a job that ends inside the command's grace window is answered inline, not linked: this one outlives it
      subgoal(ctx, "builder", 1, "workspace", "done", "worktree ready");
      subgoal(ctx, "builder", 2, "write component", "failed", "The component was not written: it loads something from another address");
      return { ok: false, note: "The component was not written: it loads something from another address." };
    });
    const voice = fakeVoice(s.rig.gate);
    voice.tick();
    const r = await s.say(usman, `Use the builder computer to ${PHRASE.builder}`, { source: "voice" });
    await waitFor(() => entriesOf(s.rig).some((e) => e.key === `${r.jobId}:failed`));
    const failed = entriesOf(s.rig).find((e) => e.key === `${r.jobId}:failed`)!;
    expect(failed.text).toMatch(/^Failed:/);
    expect(failed.text).toContain("another address");
    expect(entriesOf(s.rig).some((e) => e.state === "report" || e.state === "succeeded")).toBe(false);
    expect(progressFor({ seq: 1, at: 1, executor: "builder", ms: 0, outcome: "failed", intent: "sub-goal 2 of 5, write component: failed. The component was not written", verification: { method: "workflow-subgoal", ok: false } })).toMatch(/^Builder, step 2 of 5 \(write component\): failed\./);
    voice.tick();
    expect(voice.said).toEqual([expect.stringMatching(/failed\.$/)]);
    expect(voice.said.join(" ")).not.toMatch(/finished/);
  });

  test("'stop that task' stops it through the job's cancel; the entry says nothing further ran; no result is added; the spoken line says stopped", async () => {
    const hold = defer();
    let afterStop = 0;
    const s = await setup(async (_id, ctx) => {
      subgoal(ctx, "audit", 1, "open", "done", "open");
      await Promise.race([hold.promise, new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }))]);
      if (!ctx.signal.aborted) afterStop++;
      return { ok: false, note: "Stopped on request." };
    });
    const voice = fakeVoice(s.rig.gate);
    voice.tick();
    const r = await s.say(usman, `Use the builder computer to ${PHRASE.audit}`, { source: "voice" });
    await waitFor(() => entriesOf(s.rig).some((e) => e.key.includes(":step:")));
    const stop = await s.say(usman, "stop that task", { source: "voice" });
    expect(stop.said).toMatch(/Stopped it\. Nothing further will run\./);
    await waitFor(() => entriesOf(s.rig).some((e) => e.key === `${r.jobId}:cancelled`));
    const stopped = entriesOf(s.rig).find((e) => e.key === `${r.jobId}:cancelled`)!;
    expect(stopped.text).toMatch(/^Stopped:.*Nothing further ran\./);
    expect(entriesOf(s.rig).some((e) => e.state === "report" || e.state === "succeeded")).toBe(false);
    voice.tick();
    expect(voice.said).toEqual([expect.stringMatching(/was stopped\.$/)]);
    hold.resolve();
    await sleep(60);
    expect(afterStop).toBe(0);
    expect(entriesOf(s.rig).filter((e) => e.key === `${r.jobId}:cancelled`)).toHaveLength(1);
  });
});

describe("A. two conversations are two conversations", () => {
  test("Usman's and Mehroz's results go only to their own thread and stream; neither can post into the other's by id", async () => {
    const s = await setup();
    // two real asks, two jobs, two owners
    const delivered: string[] = [];
    const jobBody = (by: "usman" | "mehroz") => async (jobId: string, ctx: ExecutorContext) => {
      await sleep(90);
      subgoal(ctx, "audit", 1, "open", "done", `${by} open`);
      await threadDeliver(s.rig.conversations)({ jobId, by, title: by, report: `Audit for ${by}`, artifact: `${by} audit`, label: "Website audit", web: true });
      delivered.push(by);
      return { ok: true, note: `${by} done` };
    };
    const synthetic = syntheticComputers(s.jobs, [{ name: "research", label: "Research" }, { name: "builder", label: "Builder" }], (id, ctx) => jobBody(s.jobs.get(id)!.principal.personId === "mehroz" ? "mehroz" : "usman")(id, ctx));
    const command = createCommandService({ jobs: () => s.jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "n/a" }), delegates: { computers: withComputerResolution(() => synthetic.service.list(), (u, p) => computerCommand(synthetic.service as never, u, p)) }, graceMs: 50, dedupeMs: 0, threads: s.rig.threads, deviceLabel: (id) => id });
    const us = await s.rig.open("usman");
    const them = await s.rig.open("mehroz");
    const [a, b] = await Promise.all([
      command.run({ principal: usman, body: { utterance: "Use the builder computer to audit the demo clinic fixture for usman", source: "voice" } as never }),
      command.run({ principal: mehroz, body: { utterance: "Use the research computer to audit the demo clinic fixture for mehroz", source: "voice" } as never }),
    ]);
    await waitFor(() => entriesOf(s.rig, "usman").some((e) => e.key === `${a.jobId}:succeeded`) && entriesOf(s.rig, "mehroz").some((e) => e.key === `${b.jobId}:succeeded`));
    // each person's own stream has delivered their end entry (the stream is a notification channel: give it a moment)
    await us.waitFor(() => us.threadKeys().some((k) => k.endsWith(":succeeded")), 6000);
    await them.waitFor(() => them.threadKeys().some((k) => k.endsWith(":succeeded")), 6000);
    const mine = entriesOf(s.rig, "usman").map((e) => e.text).join("\n");
    const theirs = entriesOf(s.rig, "mehroz").map((e) => e.text).join("\n");
    expect(mine).toContain("Audit for usman");
    expect(mine).not.toContain("Audit for mehroz");
    expect(theirs).toContain("Audit for mehroz");
    expect(theirs).not.toContain("Audit for usman");
    expect(us.threadEvents().every((e) => e.data.entry.jobId === a.jobId)).toBe(true);
    expect(them.threadEvents().every((e) => e.data.entry.jobId === b.jobId)).toBe(true);
    expect(us.threadKeys().length).toBeGreaterThan(2);
    // a delivery for a job in someone else's conversation is refused, never captured
    const wrong = await threadDeliver(s.rig.conversations)({ jobId: a.jobId!, by: "mehroz", title: "x", report: "intruder", artifact: "x", label: "x", web: false });
    expect(wrong.delivered).toBe(false);
    expect(entriesOf(s.rig, "usman").some((e) => e.text.includes("intruder"))).toBe(false);
    expect(delivered.sort()).toEqual(["mehroz", "usman"]);
  });
});

describe("A. speech respects mute, quiet mode and interruption", () => {
  test("quiet mode: the end of a workflow is written but not spoken; the conversation still has it when quiet mode ends", async () => {
    let rigRef!: LoopRig;
    const s = await setup((id, ctx) => finishing("builder", () => rigRef)(id, ctx));
    rigRef = s.rig;
    s.rig.gate.setQuiet({ on: true, minutes: 30 });
    const voice = fakeVoice(s.rig.gate, memoryStorage());
    voice.tick();
    const r = await s.say(usman, `Use the builder computer to ${PHRASE.builder}`, { source: "voice" });
    await waitFor(() => entriesOf(s.rig).some((e) => e.key === `${r.jobId}:succeeded`));
    voice.tick();
    voice.tick();
    expect(voice.said).toEqual([]);
    expect(entriesOf(s.rig).some((e) => e.key === `${r.jobId}:succeeded`)).toBe(true);
    const held = s.rig.gate.list(0).events.find((e) => e.dedupeKey === `job:${r.jobId}:succeeded`);
    expect(held?.delivery).toBe("hud");
  });

  test("the voice session speaks only into silence: muted, mid-turn or while he is talking it waits, drops stale lines, and a stop phrase is not an announcement", () => {
    const idle = { phase: "listening" as const, micMuted: false, userSpeaking: false, busy: false };
    expect(canAnnounce(idle)).toBe(true);
    expect(canAnnounce({ ...idle, micMuted: true })).toBe(false);
    expect(canAnnounce({ ...idle, userSpeaking: true })).toBe(false);
    expect(canAnnounce({ ...idle, busy: true })).toBe(false);
    expect(canAnnounce({ ...idle, phase: "speaking" })).toBe(false);
    let clock = 0;
    const q = createAnnouncementQueue({ maxAgeMs: 60_000, now: () => clock });
    expect(q.push("Audit the demo clinic is finished.")).toBe(true);
    expect(q.push("Audit the demo clinic is finished.")).toBe(false); // a duplicate is not queued twice
    expect(q.take({ ...idle, micMuted: true })).toBeNull(); // muted: it waits
    expect(q.take({ ...idle, userSpeaking: true })).toBeNull(); // he is talking: it waits
    expect(q.take(idle)).toBe("Audit the demo clinic is finished.");
    expect(q.take(idle)).toBeNull(); // said once
    q.push("Builder is finished.");
    clock += 61_000;
    expect(q.take(idle)).toBeNull(); // too late to be news: dropped, the conversation still has it
  });
});

// ------------------------------------------------------------------------------------------------------------- B. the real hub
describe("B. the real hub: spoken phrase -> job -> live progress -> verified artifact -> one completion; one control holder; ownership", () => {
  let hub: ComputersHub | undefined;
  let rig: LoopRig | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    await rig?.close();
    rig = undefined;
    await hub?.close();
    hub = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function realHub() {
    const workdirs = new Map<string, string>();
    hub = await startComputersHub({
      artifacts: true,
      workflows: { delegate: null, allowedAuditHosts: ["dental-care-plus.muventures.com.au"], hostLabel: () => "synthetic in-process computer" },
      research: { search: null, delegate: null, deliver: (i) => threadDeliver(rig!.conversations)(i) },
    });
    hub.host.executorsFor = (name) => {
      let d = workdirs.get(name);
      if (!d) {
        d = mkdtempSync(join(tmpdir(), `real-${name}-`));
        dirs.push(d);
        workdirs.set(name, d);
      }
      // a slow browser read, so a founder has time to ask for the computer in the middle of the audit
      const ex = createLinuxExecutors({ name, workdir: d, browser: undefined, resolve: async () => ["93.184.216.34"] });
      return ex;
    };
    for (const name of ["builder", "research"]) {
      expect((await hub.api("usman", "POST", "/", { name })).status).toBe(200);
      await hub.waitFor("online", () => hub!.computers.view(name).state === "online");
    }
    rig = await loopRig(hub.jobs);
    const command = createCommandService({
      jobs: () => hub!.jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device in this test" }),
      delegates: { computers: withComputerResolution(() => hub!.computers.list().map((c) => ({ name: c.name, label: c.label })), (u, p) => computerCommand(hub!.computers, u, p)) },
      graceMs: 50, dedupeMs: 0, threads: rig.threads, deviceLabel: (id) => id,
    });
    return { hub, rig, command, workdirs };
  }

  test("a spoken business-preparation request on the real hub: acknowledgement with the job id, progress live, a verified artifact that opens, ONE result and ONE finish; the other founder sees nothing", async () => {
    const { hub: h, rig: r, command, workdirs } = await realHub();
    const stream = await r.open("usman");
    const other = await r.open("mehroz");
    const voice = fakeVoice(r.gate, memoryStorage());
    voice.tick();
    const ack = await command.run({ principal: usman, body: { utterance: "Use the builder computer to prepare a comparison table of three website packages", source: "voice", eventId: "evt-real-0001" } as never });
    expect(ack.ok).toBe(true);
    expect(ack.said).toMatch(/Job [0-9a-f]{8}\.$/);
    await stream.waitFor(() => stream.threadKeys().some((k) => k.endsWith(":succeeded")), 40_000);
    const entries = stream.threadEvents().map((e) => e.data.entry as { key: string; state: string; text: string });
    expect(entries[0].state).toBe("started");
    expect(entries.filter((e) => e.state === "progress").map((e) => e.text).join("\n")).toMatch(/Business preparation, step \d of 5 \(.*\): done\./);
    const result = entries.filter((e) => e.state === "report");
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("Saved result: Comparison: Starter / Standard / Plus");
    expect(entries.filter((e) => e.state === "succeeded")).toHaveLength(1);
    // the artifact is really there and opens from the OS route, for its owner only
    const page = await h.api("usman", "GET", `/artifacts/${ack.jobId}`);
    expect(page.status).toBe(200);
    expect(Buffer.from(page.bytes!).toString()).toContain("Comparison: Starter / Standard / Plus");
    expect((await h.api("mehroz", "GET", `/artifacts/${ack.jobId}`)).status).toBe(404);
    expect(other.threadKeys()).toEqual([]);
    expect(readdirSync(workdirs.get("builder")!).some((f) => /^comparison-.*\.md$/.test(f))).toBe(true);
    voice.tick();
    voice.tick();
    expect(voice.said).toHaveLength(1);
    expect(voice.said[0]).toMatch(/is finished/);
    // a replayed utterance with the same event id runs nothing
    const jobsBefore = h.jobs.list({ limit: 20 }).length;
    const again = await command.run({ principal: usman, body: { utterance: "Use the builder computer to prepare a comparison table of three website packages", source: "voice", eventId: "evt-real-0001" } as never });
    expect(again.jobId).toBe(ack.jobId);
    expect(h.jobs.list({ limit: 20 }).length).toBe(jobsBefore);
  });

  test("one control holder at a time: a founder takes the computer mid-job (the job pauses at a boundary), the other founder cannot take it or send input, and when it is handed back the job finishes with ONE completion", async () => {
    const { hub: h, rig: r, command } = await realHub();
    // make the job long enough to take over: a slow wait step on the builder before the result
    const orig = h.host.executorsFor;
    h.host.executorsFor = (name) => {
      const ex = orig(name);
      const write = ex["file.write"];
      ex["file.write"] = async (a, c) => (await sleep(400), write(a, c));
      return ex;
    };
    await h.computers.lifecycle("builder", "stop", {});
    await h.computers.lifecycle("builder", "start", {});
    await h.waitFor("online again", () => h.computers.view("builder").state === "online");
    const stream = await r.open("usman");
    const ack = await command.run({ principal: usman, body: { utterance: "Use the builder computer to prepare a comparison table of three website packages", source: "voice" } as never });
    await h.waitFor("the job to be running", () => h.jobs.get(ack.jobId!)?.state === "running");
    expect((await h.api("usman", "POST", "/builder/takeover", {})).status).toBe(200);
    await h.waitFor("the agent to hand over", () => h.computers.view("builder").controller.kind === "person");
    await stream.waitFor(() => stream.threadEvents().some((e) => /^Paused: you took the controls/.test(e.data.entry.text)));
    expect(h.jobs.get(ack.jobId!)!.state).toBe("running"); // paused, not finished
    // the other founder: no control, no input
    const mTake = await h.api("mehroz", "POST", "/builder/takeover", {});
    expect(JSON.stringify(mTake.json)).not.toMatch(/"state":"held"/);
    expect(h.computers.view("builder").controller).toMatchObject({ kind: "person", who: expect.stringMatching(/usman/i) });
    expect((await h.api("mehroz", "POST", "/builder/input", { executor: "file.write", args: { name: "intruder.txt", text: "x" } })).status).toBe(409);
    expect((await h.api("usman", "POST", "/builder/input", { executor: "file.write", args: { name: "human.txt", text: "by usman" } })).status).toBe(200);
    expect((await h.api("usman", "POST", "/builder/return", {})).status).toBe(200);
    await h.waitFor("the job to finish", () => h.computers.jobView(ack.jobId!)?.state === "succeeded", 30_000);
    await stream.waitFor(() => stream.threadKeys().some((k) => k.endsWith(":succeeded")));
    const entries = entriesOf(r);
    expect(entries.filter((e) => e.state === "report")).toHaveLength(1);
    expect(entries.filter((e) => e.state === "succeeded")).toHaveLength(1);
    expect(entries.map((e) => e.text).join("\n")).toContain("Resumed: control is back with the agent");
  });

  test("a personal PC stays its owner's: the other founder cannot start a workflow on it or see it as a target, while the shared computers are open to both", async () => {
    const { hub: h } = await realHub();
    const pc = await pairPersonalPc(h, "usman");
    expect(h.computers.targets("usman").some((t: { id: string }) => t.id === pc.deviceId)).toBe(true);
    expect(h.computers.targets("mehroz").some((t: { id: string }) => t.id === pc.deviceId)).toBe(false);
    const toPc = await h.api("mehroz", "POST", "/usmans-pc/jobs", { agent: "t", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "x" } }] });
    expect(toPc.status).toBe(404); // a personal PC is not a computer a job can be assigned to here
    const shared = await h.api("mehroz", "POST", "/builder/jobs", { agent: "t", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "mehroz's" } }] });
    expect(shared.status).toBe(200);
    await h.waitFor("mehroz's job", () => h.computers.jobView(shared.json.jobId)?.state === "succeeded", 30_000);
    expect(h.artifacts!.get(shared.json.jobId, "mehroz")).not.toBeNull();
    expect(h.artifacts!.get(shared.json.jobId, "usman")).toBeNull(); // his result is his, not the other founder's
    expect(pc.ran).toEqual([]); // nothing ran on the personal PC
  });
});
