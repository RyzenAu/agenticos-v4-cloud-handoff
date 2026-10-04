// Exercise the real voice -> coding entry -> command service -> conversation path. Only the coding
// orchestrator/store boundary is synthetic; no CLI, model, account or device is contacted.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingCommandEntry } from "../coding/command-entry";
import type { CodingJob, JobState } from "../coding/contracts";
import type { Orchestrator } from "../coding/orchestrator";
import { claudeBinding } from "../coding/spec";
import { createCodingVoice, type CodingVoiceDeps } from "../coding/voice";
import { conversationStore, jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { JobService } from "../jobs/service";
import { createCommandService, type CommandServiceDeps, type RunInput } from "./service";
import { createJobThreads } from "./threads";

const owner: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Synthetic founder" };
const JOB = "c0d1e2f3-1111-4222-8333-944445555666";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

function rig(options: { state?: JobState; resumeError?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coding-resume-"));
  let jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0, stopGraceMs: 50 });
  const conversations = conversationStore(join(dir, "conversations"));
  const binding = claudeBinding("claude-opus-5-5", "synthetic", "claude:max-2");
  // The confirmed job already exists, but no conversation has linked it (e.g. it was started on the
  // Coding page before a restart). Its stored account/model pin must not become a reassignment.
  const job = {
    id: JOB, state: options.state ?? "interrupted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeq: 0,
    spec: {
      objective: "Fix the synthetic greeting", requestedBy: { personId: "usman" }, repo: { repoId: "fixture" },
      roles: [{ roleId: "builder-1", role: "builder", agent: binding }],
      builderPin: { accountSlot: binding.accountSlot, model: binding.model }, confirmation: { state: "confirmed" },
    },
    runs: [], tests: [], applies: [], headSha: null, review: null, diff: null, gate: null,
  } as unknown as CodingJob;
  const resumeCalls: Array<{ id: string; options: Parameters<Orchestrator["resume"]>[1] }> = [];
  const cancellations: string[] = [];
  const codingStore = {
    getJob: (id: string) => id === JOB ? job : null,
    listJobs: () => [job],
    events: () => [],
  } as unknown as CodingVoiceDeps["store"];
  const orch = {
    resume: (id: string, input: Parameters<Orchestrator["resume"]>[1]) => {
      resumeCalls.push({ id, options: input });
      if (options.resumeError) throw new Error(options.resumeError);
      job.state = "building";
      return job;
    },
    cancel: (id: string) => { cancellations.push(id); job.state = "cancelled"; return job; },
    liveRoles: () => [],
  } as unknown as Orchestrator;
  const makeEntry = () => createCodingCommandEntry({ store: codingStore, voice: createCodingVoice({
    store: codingStore, orch, approvals: () => null, spoken: new SpokenConfirmationLedger(),
    shaper: { shape: async () => { throw new Error("Resume must not shape a new job"); } } as unknown as CodingVoiceDeps["shaper"],
    cliVersions: () => ({ claude: "synthetic", codex: "synthetic" }), setFocus: () => undefined, hubDeviceId: "usman-pc",
  }) });
  const threads = createJobThreads({
    conversations, jobs: () => jobs, pollMs: 60_000,
    coding: (id) => id === JOB ? { state: job.state, title: job.spec.objective, owner: "usman", receipts: [] } : null,
  });
  const makeService = () => {
    const entry = makeEntry();
    const deps: CommandServiceDeps = {
      jobs: () => jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "No synthetic device" }),
      delegates: { coding: entry.handle, codingMatches: () => true }, threads, graceMs: 50, dedupeMs: 0,
    };
    return createCommandService(deps);
  };
  cleanups.push(() => { threads.stop(); jobs.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = (utterance: string, eventId: string, source: "typed" | "voice" = "typed", principal = owner): RunInput => ({ principal, body: { utterance, eventId, source } });
  const entries = () => conversations.entriesAfter(jarvisThreadId("usman"), 0).filter((entry) => entry.jobId === JOB);
  return {
    job, jobs: () => jobs, conversations, threads, makeService, input, entries, resumeCalls, cancellations,
    reopenJobs() { jobs.close(); jobs = new JobService({ path: join(dir, "jobs.sqlite"), snapshotMs: 0, stopGraceMs: 50 }); },
  };
}

describe("resumed coding work is linked by the real command path", () => {
  for (const source of ["typed", "voice"] as const) {
    test(`${source} resume marks and links the existing job once; same-event replay never resumes it again`, async () => {
      const r = rig();
      await r.threads.start();
      const pinned = structuredClone({ pin: r.job.spec.builderPin, binding: r.job.spec.roles[0].agent });
      const service = r.makeService();
      const request = r.input("resume the coding job", `resume-${source}-01`, source);
      const done = await service.run(request);
      expect(done.numbers).toMatchObject({ codingJobId: JOB, codingJobState: "building", codingStarted: true });
      expect(done.said).toContain("Resumed");
      expect(r.conversations.get(jarvisThreadId("usman"))?.jobs).toContainEqual(expect.objectContaining({ jobId: JOB, kind: "coding" }));
      expect(r.entries().map((entry) => entry.state)).toEqual(["started"]);
      const replay = await service.run(request);
      expect(replay.numbers).toMatchObject({ codingJobId: JOB, codingStarted: true });
      expect(r.resumeCalls).toHaveLength(1);
      expect(r.resumeCalls[0].id).toBe(JOB);
      expect(Object.keys(r.resumeCalls[0].options)).toEqual(["by"]);
      expect(r.resumeCalls[0].options.by).toMatchObject({ personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "voice" });
      expect({ pin: r.job.spec.builderPin, binding: r.job.spec.roles[0].agent }).toEqual(pinned);
      expect(r.entries().map((entry) => entry.state)).toEqual(["started"]);
      r.job.state = "completed";
      await r.threads.reconcile();
      await r.threads.reconcile();
      expect(r.entries().map((entry) => entry.state)).toEqual(["started", "completed"]);
      expect(r.entries().at(-1)?.text).toContain(`/coding/${JOB}?tab=changes`);
    });
  }

  test("Stop that task after reconstructing the service targets the resumed job", async () => {
    const r = rig();
    await r.threads.start();
    await r.makeService().run(r.input("resume the coding job", "resume-stop-01"));
    const stopped = await r.makeService().run(r.input("stop that task", "resume-stop-02"));
    expect(stopped).toMatchObject({ stopped: true, jobId: JOB });
    expect(r.cancellations).toEqual([JOB]);
    expect(r.job.state).toBe("cancelled");
  });

  for (const utterance of ["how's the coding job going?", "show me the coding tests"]) {
    test(`${utterance} reports the existing job without linking it as started`, async () => {
      const r = rig({ state: "building" });
      await r.threads.start();
      const done = await r.makeService().run(r.input(utterance, "resume-read-01"));
      expect(done.numbers?.codingJobId).toBe(JOB);
      expect(done.numbers?.codingStarted).toBeUndefined();
      expect(r.resumeCalls).toEqual([]);
      expect(r.entries()).toEqual([]);
      expect(r.conversations.get(jarvisThreadId("usman"))?.jobs ?? []).toEqual([]);
    });
  }

  test("a thrown resume is reported without a started marker or thread link", async () => {
    const r = rig({ resumeError: "The pinned account is unavailable; nothing changed." });
    await r.threads.start();
    const done = await r.makeService().run(r.input("resume the coding job", "resume-failed-01"));
    expect(done.said).toContain("pinned account is unavailable");
    expect(done.numbers?.codingStarted).toBeUndefined();
    expect(r.job.state).toBe("interrupted");
    expect(r.entries()).toEqual([]);
    expect(r.conversations.get(jarvisThreadId("usman"))?.jobs ?? []).toEqual([]);
  });

  test("a process cannot resume or acquire a started marker", async () => {
    const r = rig();
    await r.threads.start();
    const done = await r.makeService().run(r.input("resume the coding job", "resume-process-01", "typed", { ...owner, actor: "process" }));
    expect(done.said).toContain("only a person can start, stop, pause, resume or merge");
    expect(done.numbers?.codingStarted).toBeUndefined();
    expect(r.resumeCalls).toEqual([]);
    expect(r.entries()).toEqual([]);
  });
});
