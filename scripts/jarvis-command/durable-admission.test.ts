import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "../jobs/service";
import { commandAdmissionKey } from "./admission";
import { createLinkedRunner } from "./linked-run";
import { createCommandService, type CommandServiceDeps, type RunInput } from "./service";
import type { CommandDoneEvent } from "./contracts";
import type { JobThreads } from "./threads";

const principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Synthetic founder" } as const;
const answer = (): CommandDoneEvent => ({ type: "done", ok: true, said: "Synthetic result.", kind: "answer", jobId: null, runId: "", targetDeviceId: null });
const input = (eventId = "event-restart-01", extra: Partial<RunInput["body"]> = {}): RunInput => ({ principal, body: { utterance: "research this synthetic example on Claude Max 2", source: "typed", eventId, ...extra } });
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "command-admission-"));
  let jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0, stopGraceMs: 50 });
  cleanup.push(() => { jobs.close(); rmSync(dir, { recursive: true, force: true }); });
  return { jobs: () => jobs, reopen() { jobs.close(); jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0, stopGraceMs: 50 }); } };
}

describe("durable command admission", () => {
  test("Stop before first send survives reopening the store and prevents every delegate", async () => {
    const f = fixture();
    f.jobs().requestCommandStop("usman", "event-stopped-01");
    f.reopen();
    let calls = 0;
    const run = createLinkedRunner({ jobs: f.jobs, isStop: () => false, core: async () => { calls++; return answer(); } });
    const result = await run(input("event-stopped-01"));
    expect(result).toMatchObject({ ok: true, stopped: true, verified: true, numbers: { stoppedBeforeStart: true } });
    expect(calls).toBe(0);
  });

  test("restart after admission but before job creation cannot reroute or run again", async () => {
    const f = fixture(); const request = input();
    f.jobs().claimCommand(commandAdmissionKey(request, request.body.eventId!));
    f.reopen(); let calls = 0;
    const run = createLinkedRunner({ jobs: f.jobs, isStop: () => false, core: async () => { calls++; return answer(); } });
    const result = await run(request);
    expect(result).toMatchObject({ ok: false, outcome: "unverified", numbers: { replayed: true } });
    expect(calls).toBe(0);
    expect(f.jobs().requestCommandStop("usman", request.body.eventId!).outcome).toBe("unconfirmed");
  });

  test("an exception after an external effect retains the claim both now and after restart", async () => {
    const f = fixture(); const request = input(); let effects = 0;
    const make = () => createLinkedRunner({ jobs: f.jobs, isStop: () => false, core: async () => { effects++; throw new Error("synthetic lost reply"); } });
    const first = make();
    await expect(first(request)).rejects.toThrow("synthetic lost reply");
    expect(await first(request)).toMatchObject({ ok: false, outcome: "unverified", numbers: { replayed: true } });
    f.reopen();
    expect(await make()(request)).toMatchObject({ ok: false, outcome: "unverified" });
    expect(effects).toBe(1);
  });

  test("completed requests without command jobs are not repeated after restart", async () => {
    const f = fixture(); let calls = 0;
    const make = () => createLinkedRunner({ jobs: f.jobs, isStop: () => false, core: async () => { calls++; return answer(); } });
    expect((await make()(input())).said).toBe("Synthetic result.");
    f.reopen();
    expect(await make()(input())).toMatchObject({ ok: true, numbers: { replayed: true } });
    expect(calls).toBe(1);
  });

  test("event identity is founder scoped and binds conversation, bot, words and account pins", async () => {
    const f = fixture(); const seen: string[] = [];
    const run = createLinkedRunner({ jobs: f.jobs, isStop: () => false, core: async (i) => { seen.push(i.body.utterance); return answer(); } });
    const original = input("event-binding-01", { conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", target: { bot: "research" } });
    await run(original);
    for (const body of [
      { ...original.body, conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...original.body, target: { bot: "builder" } },
      { ...original.body, utterance: "research this synthetic example on Claude Max 1" },
    ]) expect(await run({ ...original, body })).toMatchObject({ ok: false, refused: true });
    await run({ ...original, principal: { ...principal, personId: "mehroz" } });
    expect(seen).toEqual([original.body.utterance, original.body.utterance]);
  });

  test("binding ignores object order and page capture time, without storing command text", () => {
    const a = input("event-hash-01", { pageContext: { page: "/crm", capturedAt: 1, focused: { id: "7", kind: "company", label: "Synthetic" } } as never });
    const b = input("event-hash-01", { pageContext: { focused: { label: "Synthetic", kind: "company", id: "7" }, capturedAt: 9, page: "/crm" } as never });
    expect(commandAdmissionKey(a, a.body.eventId!).binding).toBe(commandAdmissionKey(b, b.body.eventId!).binding);
    const f = fixture(); const key = commandAdmissionKey(a, a.body.eventId!); f.jobs().claimCommand(key);
    expect(JSON.stringify(f.jobs().commandAdmission("usman", a.body.eventId!))).not.toContain(a.body.utterance);
  });

  test("Stop arriving while follow-up lookup waits prevents follow-up mutations", async () => {
    const f = fixture(); let release!: (value: unknown[]) => void; let touches = 0; let calls = 0;
    const threads = { noteLocal() {}, active: () => new Promise<unknown[]>((r) => { release = r; }), touch: () => { touches++; } } as unknown as JobThreads;
    const run = createLinkedRunner({ jobs: f.jobs, threads, isStop: () => false, core: async () => { calls++; return answer(); } });
    const request = input("event-followup-01", { utterance: "also include their hours" });
    const result = run(request);
    await new Promise((r) => setTimeout(r, 5));
    f.jobs().requestCommandStop("usman", request.body.eventId!);
    release([{ jobId: "11111111-1111-4111-8111-111111111111", kind: "job", title: "Synthetic task", state: "running", conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);
    expect(await result).toMatchObject({ stopped: true, numbers: { stoppedBeforeStart: true } });
    expect(touches).toBe(0); expect(calls).toBe(0);
  });

  test("a started external computer job remains the Stop target after reconstructing the command service", async () => {
    const f = fixture(); let jobId = ""; let running: Promise<unknown> | undefined;
    const deps: CommandServiceDeps = { jobs: f.jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "synthetic" }), delegates: { computers: async () => {
      const job = f.jobs().create({ kind: "command", principal, targetDeviceId: "synthetic-computer", title: "Synthetic external task" });
      jobId = job.id;
      running = f.jobs().run(job.id, async (ctx) => { await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false }; });
      return { ok: true, started: true, said: "Started.", jobId, deviceId: "synthetic-computer" };
    } } };
    await createCommandService(deps).run(input("event-computer-01", { utterance: "use the research computer to inspect the page" }));
    expect(f.jobs().commandAdmission("usman", "event-computer-01")).toMatchObject({ taskId: jobId, taskKind: "job" });
    expect(await createCommandService(deps).cancelEvent("event-computer-01", principal)).toMatchObject({ ok: true, outcome: "stopped", jobId });
    expect(f.jobs().get(jobId)?.state).toBe("cancelled");
    await running;
  });

  test("coding Stop targets the started coding task, not its succeeded command wrapper", async () => {
    const f = fixture(); const codingId = "c0d1e2f3-1111-4222-8333-944445555666"; const calls: string[] = [];
    const deps: CommandServiceDeps = { jobs: f.jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "synthetic" }), delegates: { codingMatches: () => true, coding: async (words) => {
      calls.push(words); return words.startsWith("stop the coding job") ? { say: "Stopped.", jobId: codingId, jobState: "cancelled" } : { say: "Started.", jobId: codingId, jobState: "building", started: true };
    } } };
    const result = await createCommandService(deps).run(input("event-coding-01", { utterance: "start it" }));
    const record = f.jobs().commandAdmission("usman", "event-coding-01")!;
    expect(record).toMatchObject({ jobId: result.jobId, taskId: codingId, taskKind: "coding" });
    expect(record.jobId).not.toBe(codingId);
    f.reopen();
    expect(await createCommandService(deps).cancelEvent("event-coding-01", principal)).toMatchObject({ ok: true, outcome: "stopped", jobId: codingId });
    expect(calls).toEqual(["start it", `stop the coding job ${codingId}`]);
    deps.delegates!.coding = async () => ({ say: "Stopped.", jobId: codingId });
    expect(await createCommandService(deps).cancelEvent("event-coding-01", principal)).toMatchObject({ ok: false, outcome: "unconfirmed" });
  });

  test("Stop winning wrapper creation after coding starts reports actual cancellation, never Nothing ran", async () => {
    const f = fixture(); const codingId = "c0d1e2f3-1111-4222-8333-944445555666"; const calls: string[] = [];
    const create = f.jobs().createCommandJob.bind(f.jobs());
    f.jobs().createCommandJob = (job, admission) => { f.jobs().requestCommandStop(admission.personId, admission.eventId); return create(job, admission); };
    const service = createCommandService({ jobs: f.jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "synthetic" }), delegates: { codingMatches: () => true, coding: async (words) => {
      calls.push(words); return words.startsWith("stop the coding job") ? { say: "Stopped.", jobId: codingId, jobState: "cancelled" } : { say: "Started.", jobId: codingId, jobState: "building", started: true };
    } } });
    const result = await service.run(input("event-race-01", { utterance: "start it" }));
    expect(result).toMatchObject({ ok: true, stopped: true, numbers: { codingJobId: codingId } });
    expect(result.numbers?.stoppedBeforeStart).toBeUndefined();
    expect(result.said).not.toContain("Nothing ran");
    expect(calls).toEqual(["start it", `stop the coding job ${codingId}`]);
  });

  test("a status result's job reference never becomes cancellation authority for that event", async () => {
    const f = fixture(); const job = f.jobs().create({ kind: "command", principal, targetDeviceId: "synthetic-computer", title: "Existing task" });
    const run = createLinkedRunner({ jobs: f.jobs, isStop: () => false, core: async () => ({ ...answer(), said: "It is still running.", jobId: job.id }) });
    await run(input("event-status-01", { utterance: "how is that going?" }));
    expect(f.jobs().commandAdmission("usman", "event-status-01")).toMatchObject({ jobId: null, taskId: null });
    const service = createCommandService({ jobs: f.jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "synthetic" }) });
    expect(await service.cancelEvent("event-status-01", principal)).toMatchObject({ ok: false, outcome: "unconfirmed" });
    expect(f.jobs().get(job.id)?.state).toBe("queued");
    await f.jobs().cancel(job.id);
  });

  test("Stop while a coding status lookup waits never stops the existing referenced task", async () => {
    const f = fixture(); const codingId = "c0d1e2f3-1111-4222-8333-944445555666"; const calls: string[] = [];
    let release!: () => void;
    const service = createCommandService({ jobs: f.jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "synthetic" }), delegates: { codingMatches: () => true, coding: async (words) => {
      calls.push(words); await new Promise<void>((resolve) => { release = resolve; });
      return { say: "The existing task is still building.", jobId: codingId, jobState: "building" };
    } } });
    const running = service.run(input("event-coding-status-01", { utterance: "how is the coding job going?" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(1);
    expect(await service.cancelEvent("event-coding-status-01", principal)).toMatchObject({ ok: false, outcome: "unconfirmed" });
    release(); await running;
    expect(calls).toEqual(["how is the coding job going?"]);
    expect(f.jobs().commandAdmission("usman", "event-coding-status-01")?.taskId).toBeNull();
  });

  test("replaying a coding admission does not touch conversation recency or a supplied foreign conversation", async () => {
    const f = fixture(); const request = input("event-readonly-replay", { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const key = commandAdmissionKey(request, request.body.eventId!);
    f.jobs().claimCommand(key);
    f.jobs().bindCommandTask(key, { taskId: "c0d1e2f3-1111-4222-8333-944445555666", taskKind: "coding" });
    f.reopen(); let touches = 0; let calls = 0;
    const threads = { status: async () => { touches++; return { said: "old job", state: "building" }; } } as unknown as JobThreads;
    const run = createLinkedRunner({ jobs: f.jobs, threads, isStop: () => false, core: async () => { calls++; return answer(); } });
    expect(await run(request)).toMatchObject({ numbers: { replayed: true, codingJobId: "c0d1e2f3-1111-4222-8333-944445555666" } });
    expect(touches).toBe(0); expect(calls).toBe(0);
  });
});
