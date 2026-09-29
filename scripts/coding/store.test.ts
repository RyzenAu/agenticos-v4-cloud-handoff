import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentBinding, AgentRunState, AgentRunTransition, ApplyStep, CodingJob, GitSha, IsoTime, RepoId, RoleId, TaskSpec, Uuid } from "./contracts";
import { CodingStore, CodingStoreError, JOB_TRANSITIONS, LeaseHeld, RUN_TRANSITIONS } from "./store";
import { cleanup, tempRoot } from "./test-fixtures";

const roots: string[] = [];
const stores: CodingStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) cleanup(r);
});
const dir = () => { const r = tempRoot("coding-store-"); roots.push(r); return join(r, "coding"); };
const open = (d: string, options: Parameters<typeof CodingStore.open>[1] = {}) => { const s = CodingStore.open(d, options); stores.push(s); return s; };
const closeOne = (s: CodingStore) => { s.close(); stores.splice(stores.indexOf(s), 1); };

const person = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "s" } as any;
const codex2: AgentBinding = { provider: "openai", route: "codex-app-server", accountSlot: "codex:openai-2", model: "gpt-6-astra", cliVersion: "0.154.0" };
const codex3: AgentBinding = { ...codex2, accountSlot: "codex:openai-3" };
const spec = (): TaskSpec => ({
  schema: "coding.taskspec", version: 1, id: randomUUID() as Uuid, revision: 1, createdAt: new Date().toISOString() as IsoTime, requestedBy: person,
  source: { channel: "typed", utteranceDigest: "0".repeat(64) as any },
  repo: { repoId: "fixture" as RepoId, baseRef: "main", baseSha: "a".repeat(40) as GitSha, jobBranch: "coding/x-abcdef", excludesUncommittedCanonicalChanges: true },
  objective: "fix it", nonGoals: [], doneWhen: [], roleTemplate: "build-only", roles: [], checks: [], baselineChecks: [], approvalPoints: [],
  allowDependencyChange: false, dataClass: "synthetic", jobLimits: { maxWallMinutes: 60, maxConcurrentAgents: 2 }, jev: null, planner: null,
  confirmation: { state: "unconfirmed" },
});
function newJob(store: CodingStore): CodingJob {
  return store.createJob({ id: randomUUID() as Uuid, spec: spec(), state: "draft", headSha: null, diff: null, tests: [], review: null, gate: null, applies: [], executorDevice: "usman-pc" as any });
}
function toBuilding(store: CodingStore, id: string) {
  for (const s of ["awaiting_confirmation", "preparing", "building"] as const) store.transitionJob(id, s);
}
function addRunning(store: CodingStore, jobId: string, roleId = "builder-1") {
  const run = store.addRun({ id: randomUUID() as Uuid, jobId: jobId as Uuid, roleId: roleId as RoleId, role: "builder", binding: codex2, nativeSessionId: null, worktree: { branch: "b", headAtStart: "a".repeat(40) as GitSha, detached: false } });
  store.transitionRun(run.id, "starting", "started");
  store.transitionRun(run.id, "running", "native_session_ready");
  return run.id;
}

describe("coding store", () => {
  test("uses WAL and one writer; events get a per-job seq in order", () => {
    const d = dir();
    const store = open(d);
    const probe = new Database(join(d, "coding.sqlite"), { readonly: true });
    expect((probe.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    probe.close();
    const a = newJob(store), b = newJob(store);
    store.transitionJob(a.id, "awaiting_confirmation");
    store.appendEvent(a.id, "step", null, { label: "one" });
    store.appendEvent(b.id, "step", null, { label: "b-one" });
    store.appendEvent(a.id, "step", null, { label: "two" });
    expect(store.events(a.id).map((e) => [e.seq, e.type])).toEqual([[1, "state"], [2, "step"], [3, "step"]]);
    expect(store.events(b.id).map((e) => e.seq)).toEqual([1]);
    expect(store.events(a.id, 1).map((e) => e.seq)).toEqual([2, 3]); // SSE resume after seq 1
    expect(store.getJob(a.id)!.lastSeq).toBe(3);
  });

  test("a second writer is refused while the lease holder lives; a dead holder's lease is taken over", () => {
    const d = dir();
    const first = open(d);
    expect(() => CodingStore.open(d)).toThrow(LeaseHeld);
    closeOne(first);
    // Simulate a crashed server: its lease row remains, but the PID is gone.
    const raw = new Database(join(d, "coding.sqlite"));
    raw.query("INSERT OR REPLACE INTO lease (id, pid, instance, started) VALUES (1, 999999, 'crashed', 1)").run();
    raw.close();
    expect(() => open(d, { pidAlive: () => false })).not.toThrow();
  });

  test("a live PID with a different start time is a reused PID, not the holder", () => {
    const d = dir();
    closeOne(open(d));
    const raw = new Database(join(d, "coding.sqlite"));
    raw.query("INSERT OR REPLACE INTO lease (id, pid, instance, started) VALUES (1, 4242, 'old', 1000)").run();
    raw.close();
    expect(() => CodingStore.open(d, { pidAlive: () => true, pidStartTime: () => 1000 })).toThrow(LeaseHeld);
    expect(() => open(d, { pidAlive: () => true, pidStartTime: () => 999_999_999 })).not.toThrow();
  });

  test("restart: active runs and jobs become interrupted, running applies outcome_unknown, and nothing is replayed", () => {
    const d = dir();
    const store = open(d);
    const job = newJob(store);
    toBuilding(store, job.id);
    const runId = addRunning(store, job.id);
    const queued = store.addRun({ id: randomUUID() as Uuid, jobId: job.id, roleId: "builder-2" as RoleId, role: "builder", binding: codex2, nativeSessionId: null, worktree: { branch: "b2", headAtStart: "a".repeat(40) as GitSha, detached: false } });
    const apply = { id: randomUUID(), jobId: job.id, action: "git.merge.protected", repoId: "fixture", fromSha: "a".repeat(40), toRef: "main", remote: null, idempotencyKey: "0".repeat(64), approval: {} as any, state: "running", verification: null } as unknown as ApplyStep;
    store.updateJob(job.id, { applies: [apply] });
    const lastSeqBefore = store.getJob(job.id)!.lastSeq;
    closeOne(store); // the server stops with work in flight

    const launches: string[] = [];
    const restarted = open(d, { snapshot: (j) => j.runs.map((r) => ({ roleId: r.roleId, head: "b".repeat(40) as GitSha, dirtyFiles: 2 })) });
    const after = restarted.getJob(job.id)!;
    expect(after.state).toBe("interrupted");
    expect(after.runs.find((r) => r.id === runId)!.state).toBe("interrupted");
    expect(after.runs.find((r) => r.id === runId)!.history.at(-1)).toMatchObject({ from: "running", to: "interrupted", reason: "server_restart" });
    expect(after.runs.find((r) => r.id === queued.id)!.state).toBe("queued");
    expect(after.applies[0].state).toBe("outcome_unknown");
    expect(restarted.recovered).toEqual({ jobs: [job.id], runs: [runId], applies: [apply.id] });
    const events = restarted.events(job.id, lastSeqBefore);
    expect(events.map((e) => e.type)).toEqual(["state", "state", "recovery"]);
    expect(events[2].payload).toMatchObject({ interruptedRuns: [runId], outcomeUnknownApplies: [apply.id], snapshot: [{ dirtyFiles: 2 }, { dirtyFiles: 2 }] });
    expect(launches).toEqual([]); // the store has no launcher; recovery replays nothing

    // Interrupted stays interrupted: no automatic resume, and another restart adds nothing.
    expect(() => restarted.transitionJob(job.id, "building")).toThrow("until the owner resumes");
    expect(() => restarted.transitionRun(runId, "starting", "started")).toThrow("explicit owner resume");
    const seq = restarted.getJob(job.id)!.lastSeq;
    closeOne(restarted);
    const again = open(d);
    expect(again.recovered).toEqual({ jobs: [], runs: [], applies: [] });
    expect(again.getJob(job.id)!.lastSeq).toBe(seq);
  });

  test("an explicit owner resume restarts the same run on the same account, or a recorded reassignment", () => {
    const d = dir();
    const store = open(d);
    const job = newJob(store);
    toBuilding(store, job.id);
    const runId = addRunning(store, job.id);
    closeOne(store);
    const s = open(d);
    s.transitionJob(job.id, "building", { resume: true });
    // No silent move to another account: the binding can't change without an owner resume.
    expect(() => s.transitionRun(runId, "cancelled", "owner_cancel", { reassignTo: codex3 })).toThrow("explicit resume");
    const resumed = s.transitionRun(runId, "starting", "owner_resume");
    expect(resumed).toMatchObject({ state: "starting", attempt: 2, binding: { accountSlot: "codex:openai-2" } });
    s.transitionRun(runId, "running", "native_session_ready");
    s.transitionRun(runId, "interrupted", "owner_interrupt");
    const moved = s.transitionRun(runId, "starting", "owner_resume", { reassignTo: codex3 });
    expect(moved.binding.accountSlot).toBe("codex:openai-3");
    expect(s.events(job.id).some((e) => e.type === "step" && JSON.stringify(e.payload).includes("codex:openai-2 gpt-6-astra → codex:openai-3"))).toBe(true);
  });

  test("state changes follow the contract tables only", () => {
    const store = open(dir());
    const job = newJob(store);
    expect(() => store.transitionJob(job.id, "completed")).toThrow("can't move");
    toBuilding(store, job.id);
    for (const s of ["integrating", "testing", "reviewing", "gating"] as const) store.transitionJob(job.id, s);
    // "completed" needs a passed gate for the job's head sha.
    expect(() => store.transitionJob(job.id, "completed")).toThrow("passed gate");
    store.updateJob(job.id, { headSha: "c".repeat(40) as GitSha, gate: { sha: "c".repeat(40) as GitSha, passed: true, checks: [], baselineFailures: [], at: new Date().toISOString() as IsoTime } });
    expect(store.transitionJob(job.id, "completed").state).toBe("completed");
    const runId = addRunning(store, job.id);
    store.transitionRun(runId, "succeeded", "agent_reported_done_postcheck_passed");
    expect(() => store.transitionRun(runId, "running", "started")).toThrow("can't move");
    expect(() => store.transitionRun(runId, "interrupted", "server_restart")).toThrow("can't move");
    // Every terminal state is terminal in both tables.
    for (const s of ["succeeded", "failed", "cancelled", "termination_unverified"] as AgentRunState[]) expect(RUN_TRANSITIONS[s]).toEqual([]);
    expect(JOB_TRANSITIONS.failed).toEqual([]);
    expect(JOB_TRANSITIONS.cancelled).toEqual([]);
    // Compile-time: the contract rejects interrupted → succeeded.
    // @ts-expect-error interrupted can only go to starting or cancelled
    const bad: AgentRunTransition<"interrupted"> = { from: "interrupted", to: "succeeded", at: "x" as IsoTime, reason: "owner_resume" };
    void bad;
  });

  test("payloads and artefacts are redacted before they are stored", () => {
    const d = dir();
    const store = open(d);
    const job = newJob(store);
    const fake = "sk-ant-" + "FAKEfakeFAKEfake1234567890abcdef";
    store.appendEvent(job.id, "text", null, { text: `the key is ${fake} and password=hunter2hunter2`, final: true });
    const raw = new Database(join(d, "coding.sqlite"), { readonly: true });
    const stored = (raw.query("SELECT payload FROM events WHERE job_id = ?").all(job.id) as { payload: string }[]).map((r) => r.payload).join("\n");
    raw.close();
    expect(stored).not.toContain(fake);
    expect(stored).not.toContain("hunter2hunter2");
    const id = store.putArtefact(job.id, `output ${fake}\n` + "x".repeat(600 * 1024));
    const text = store.readArtefact(job.id, id);
    expect(text).not.toContain(fake);
    expect(text.length).toBeLessThan(530 * 1024);
    expect(readdirSync(join(d, job.id))).toEqual([`${id}.txt`]);
    expect(() => store.readArtefact(job.id, "../../coding.sqlite")).toThrow(CodingStoreError);
    expect(() => store.appendEvent(job.id, "state" as any, null, {} as any)).toThrow("transitions only");
  });

  test("a quiet second server reads the store read-only: no lease, no recovery, no writes", () => {
    const d = dir();
    const writer = open(d);
    const job = newJob(writer);
    toBuilding(writer, job.id);
    addRunning(writer, job.id);
    const reader = open(d, { readOnly: true });
    expect(reader.recovered).toBeNull();
    expect(reader.getJob(job.id)!.state).toBe("building");
    expect(reader.events(job.id).length).toBe(writer.events(job.id).length);
    expect(() => newJob(reader)).toThrow("read-only");
    expect(() => reader.transitionJob(job.id, "cancelled")).toThrow("read-only");
    expect(writer.getJob(job.id)!.state).toBe("building");
    expect(existsSync(join(d, "coding.sqlite"))).toBe(true);
    expect(readFileSync(join(d, "coding.sqlite")).length).toBeGreaterThan(0);
  });

  test("needs-you lists jobs waiting on the owner", () => {
    const store = open(dir());
    const idle = newJob(store);
    const waiting = newJob(store);
    toBuilding(store, waiting.id);
    const runId = addRunning(store, waiting.id);
    store.transitionRun(runId, "needs_input", "input_requested", { pendingInput: { id: "i1", kind: "approval", nativeKind: "Edit", title: "t", detail: "d", escalatedBecause: "unclassified", expiresAt: new Date().toISOString() as IsoTime } });
    expect(store.listJobs({ state: "needs-you" }).map((j) => j.id)).toEqual([waiting.id]);
    expect(store.listJobs().map((j) => j.id).sort()).toEqual([idle.id, waiting.id].sort());
    expect(store.listJobs({ repo: "other" })).toEqual([]);
  });
});
