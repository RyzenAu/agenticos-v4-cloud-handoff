import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AgentBinding, ApplyStep, CodingJob, GitSha, IsoTime, RepoId, RoleId, TaskSpec, Uuid } from "./contracts";
import { recoverySnapshot } from "./plugin";
import { CodingStore, LeaseHeld } from "./store";
import { cleanup, commitIn, fixtureRepo, gitIn, tempRoot, write } from "./test-fixtures";
import { worktreePathFor } from "./worktree";

/**
 * M1 (review T8b): the coding store opens without stalling the server's event loop. The lease
 * holder's start time and the recovery snapshot (git per role worktree) are awaited, not run with
 * spawnSync, and the recovery itself is unchanged. Synthetic stores and repos only.
 */

const roots: string[] = [];
const stores: CodingStore[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const c of children.splice(0)) try { c.kill(); } catch { /* gone */ }
  for (const r of roots.splice(0)) cleanup(r);
});
const root = () => { const r = tempRoot("coding-open-async-"); roots.push(r); return r; };
const keep = <T extends CodingStore>(s: T) => (stores.push(s), s);

const person = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "s" } as any;
const codex2: AgentBinding = { provider: "openai", route: "codex-app-server", accountSlot: "codex:openai-2", model: "gpt-6-astra", cliVersion: "0.154.0" };
const FIXED = new Date("2026-09-29T01:02:03.000Z");

function spec(roles: { roleId: string; access: "write" | "read" }[] = [{ roleId: "builder-1", access: "write" }]): TaskSpec {
  return {
    schema: "coding.taskspec", version: 1, id: randomUUID() as Uuid, revision: 1, createdAt: FIXED.toISOString() as IsoTime, requestedBy: person,
    source: { channel: "typed", utteranceDigest: "0".repeat(64) as any },
    repo: { repoId: "fixture" as RepoId, baseRef: "main", baseSha: "a".repeat(40) as GitSha, jobBranch: "coding/x-abcdef", excludesUncommittedCanonicalChanges: true },
    objective: "fix it", nonGoals: [], doneWhen: [], roleTemplate: "build-only", roles: roles as any, checks: [], baselineChecks: [], approvalPoints: [],
    allowDependencyChange: false, dataClass: "synthetic", jobLimits: { maxWallMinutes: 60, maxConcurrentAgents: 2 }, jev: null, planner: null,
    confirmation: { state: "unconfirmed" },
  };
}

/** A store left by a server that stopped with work in flight: a building job, a running run, a running apply. */
function inFlight(dir: string, jobId = randomUUID()) {
  const store = CodingStore.open(dir, { now: () => FIXED });
  const job = store.createJob({ id: jobId as Uuid, spec: spec(), state: "draft", headSha: null, diff: null, tests: [], review: null, gate: null, applies: [], executorDevice: "usman-pc" as any });
  for (const s of ["awaiting_confirmation", "preparing", "building"] as const) store.transitionJob(job.id, s);
  const run = store.addRun({ id: randomUUID() as Uuid, jobId: job.id, roleId: "builder-1" as RoleId, role: "builder", binding: codex2, nativeSessionId: null, worktree: { branch: "b", headAtStart: "a".repeat(40) as GitSha, detached: false } });
  store.transitionRun(run.id, "starting", "started");
  store.transitionRun(run.id, "running", "native_session_ready");
  const apply = { id: randomUUID(), jobId: job.id, action: "git.merge.protected", repoId: "fixture", fromSha: "a".repeat(40), toRef: "main", remote: null, idempotencyKey: "0".repeat(64), approval: {} as any, state: "running", verification: null } as unknown as ApplyStep;
  store.updateJob(job.id, { applies: [apply] });
  store.close();
  return { jobId: job.id, runId: run.id, applyId: apply.id as string };
}

/** Hold a fake lease: a live PID (a sleeping child) with a start time that doesn't match it. */
function plantLease(dir: string, pid: number, started: number) {
  const raw = new Database(join(dir, "coding.sqlite"));
  raw.query("INSERT OR REPLACE INTO lease (id, pid, instance, started) VALUES (1, ?, 'planted', ?)").run(pid, started);
  raw.close();
}

function sleeper(ms: number): ChildProcess {
  const c = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore", windowsHide: true });
  children.push(c);
  return c;
}

/** Measure the longest event-loop stall while `work` runs (a 5 ms ticker). */
async function loopWatch<T>(work: () => Promise<T> | T): Promise<{ value: T; maxGapMs: number; ticks: number; tookMs: number }> {
  let last = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks++;
  }, 5);
  const t0 = performance.now();
  try {
    const value = await work();
    const tookMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 20)); // let the ticker see the end of a synchronous stall
    return { value, maxGapMs, ticks, tookMs };
  } finally {
    clearInterval(timer);
  }
}

describe("CodingStore.openAsync: same recovery as open()", () => {
  test("interrupts the same runs, jobs and applies, and writes the same events and evidence", async () => {
    const a = join(root(), "coding");
    const ids = inFlight(a);
    const b = join(root(), "coding");
    cpSync(a, b, { recursive: true });
    const evidence = (j: CodingJob) => j.runs.map((r) => ({ roleId: r.roleId, head: "b".repeat(40) as GitSha, dirtyFiles: 2 }));

    const viaSync = keep(CodingStore.open(a, { now: () => FIXED, snapshot: evidence }));
    const seen: CodingJob[] = [];
    const viaAsync = keep(await CodingStore.openAsync(b, { now: () => FIXED, snapshot: async (j) => { seen.push(j); await new Promise((r) => setTimeout(r, 30)); return evidence(j); } }));

    expect(viaAsync.recovered).toEqual(viaSync.recovered);
    expect(viaAsync.recovered).toEqual({ jobs: [ids.jobId as Uuid], runs: [ids.runId as Uuid], applies: [ids.applyId as Uuid] });
    expect(viaAsync.getJob(ids.jobId)).toEqual(viaSync.getJob(ids.jobId));
    expect(viaAsync.events(ids.jobId)).toEqual(viaSync.events(ids.jobId));
    expect(viaAsync.events(ids.jobId).at(-1)).toMatchObject({ type: "recovery", payload: { interruptedRuns: [ids.runId], outcomeUnknownApplies: [ids.applyId], snapshot: [{ roleId: "builder-1", dirtyFiles: 2 }] } });
    // The snapshot saw the job as recovery leaves it, as open() does.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ state: "interrupted", runs: [{ state: "interrupted", pendingInput: null }], applies: [{ state: "outcome_unknown" }] });
    // Recovery replays nothing, and a second open recovers nothing.
    viaAsync.close(); stores.splice(stores.indexOf(viaAsync), 1);
    const again = keep(await CodingStore.openAsync(b, { now: () => FIXED }));
    expect(again.recovered).toEqual({ jobs: [], runs: [], applies: [] });
  });

  test("a snapshot that throws or rejects records no evidence, and recovery still completes", async () => {
    const d = join(root(), "coding");
    const ids = inFlight(d);
    const s = keep(await CodingStore.openAsync(d, { snapshot: async () => { throw new Error("git gone"); } }));
    expect(s.getJob(ids.jobId)!.state).toBe("interrupted");
    expect(s.events(ids.jobId).at(-1)).toMatchObject({ type: "recovery", payload: { snapshot: [] } });
  });

  test("the lease rule is unchanged: a live holder with a matching start keeps it, a reused PID loses it", async () => {
    const d = join(root(), "coding");
    inFlight(d);
    plantLease(d, 4242, 1000);
    await expect(CodingStore.openAsync(d, { pidAlive: () => true, pidStartTime: async () => 1000 })).rejects.toBeInstanceOf(LeaseHeld);
    await expect(CodingStore.openAsync(d, { pidAlive: () => true, pidStartTime: async () => null })).rejects.toBeInstanceOf(LeaseHeld); // unknown is not proof of reuse
    const s = keep(await CodingStore.openAsync(d, { pidAlive: () => true, pidStartTime: async () => 999_999_999 }));
    expect(s.recovered!.jobs).toHaveLength(1);
    // A refused open leaves nothing behind: the planted lease is intact for its holder.
    const d2 = join(root(), "coding");
    inFlight(d2);
    plantLease(d2, 4242, 1000);
    await expect(CodingStore.openAsync(d2, { pidAlive: () => true, pidStartTime: async () => 1000 })).rejects.toBeInstanceOf(LeaseHeld);
    const raw = new Database(join(d2, "coding.sqlite"), { readonly: true });
    expect(raw.query("SELECT pid, instance FROM lease").all()).toEqual([{ pid: 4242, instance: "planted" }]);
    raw.close();
  });

  test("a lease that changes hands while the start time is read is read again", async () => {
    const d = join(root(), "coding");
    inFlight(d);
    plantLease(d, 4242, 1000);
    const asked: number[] = [];
    const s = keep(await CodingStore.openAsync(d, {
      pidAlive: () => true,
      pidStartTime: async (pid) => {
        asked.push(pid);
        if (pid === 4242) { plantLease(d, 5151, 2000); return 1000; } // a new holder took over meanwhile
        return 999_999_999; // 5151's real start differs from its row: a reused PID
      },
    }));
    expect(asked).toEqual([4242, 5151]);
    expect(s.recovered!.jobs).toHaveLength(1);
  });
});

describe("opening the store never stalls the event loop (M1 probe)", () => {
  test("probe control: the synchronous open blocks the loop for as long as its child runs", async () => {
    const d = join(root(), "coding");
    inFlight(d);
    const blocking = await loopWatch(() => keep(CodingStore.open(d, {
      snapshot: () => { spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { windowsHide: true }); return []; },
    })));
    expect(blocking.maxGapMs).toBeGreaterThan(500);
  });

  test("openAsync keeps the loop running through a slow lease check and a slow snapshot", async () => {
    const d = join(root(), "coding");
    inFlight(d);
    plantLease(d, 4242, 1000);
    const slow = (ms: number) => new Promise<void>((resolve) => {
      const c = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore", windowsHide: true });
      c.on("close", () => resolve());
    });
    const r = await loopWatch(() => CodingStore.openAsync(d, {
      pidAlive: () => true,
      pidStartTime: async () => { await slow(400); return 999_999_999; },
      snapshot: async (j) => { await slow(400); return j.runs.map((run) => ({ roleId: run.roleId, head: "c".repeat(40) as GitSha, dirtyFiles: 0 })); },
    }));
    keep(r.value);
    expect(r.tookMs).toBeGreaterThan(700);
    expect(r.maxGapMs).toBeLessThan(250);
    expect(r.ticks).toBeGreaterThan(40);
    expect(r.value.recovered!.jobs).toHaveLength(1);
  });

  test("real children: the OS start-time read (PowerShell on Windows) and git snapshot run async", async () => {
    const fx = fixtureRepo({ dirty: false });
    roots.push(fx.root);
    const d = join(fx.root, "coding-data");
    const ids = inFlight(d, randomUUID());
    // The role worktree recovery looks at: a real worktree with one commit and two dirty files.
    const wt = worktreePathFor(fx.entry, ids.jobId.replace(/-/g, "").slice(0, 6), "builder-1");
    gitIn(fx.canonical, "worktree", "add", "-q", "-b", "coding/x-abcdef-builder-1", wt);
    const head = commitIn(wt, { "src/a.ts": "export const a = 42;\n" });
    write(wt, "src/b.ts", "export const b = 99;\n");
    write(wt, "new.txt", "untracked\n");
    // A live process holds the lease row, recorded with a different start: a reused PID, so the
    // real processStartTimeAsync must ask the OS before the store can take over.
    const holder = sleeper(30_000);
    await new Promise((r) => setTimeout(r, 200));
    plantLease(d, holder.pid!, 1);

    const r = await loopWatch(() => CodingStore.openAsync(d, { snapshot: (job) => recoverySnapshot(fx.entry, job) }));
    const store = keep(r.value);
    expect(store.recovered!.jobs).toEqual([ids.jobId as Uuid]);
    expect(store.events(ids.jobId).at(-1)).toMatchObject({ type: "recovery", payload: { snapshot: [{ roleId: "builder-1", head, dirtyFiles: 2 }] } });
    expect(r.maxGapMs).toBeLessThan(250);
    try { spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: fx.canonical, windowsHide: true }); } catch { /* cleanup() removes it */ }
  }, 60_000);
});

describe("recoverySnapshot", () => {
  test("no registry entry, or a worktree git can't read, gives no evidence rather than an error", async () => {
    const fx = fixtureRepo({ dirty: false });
    roots.push(fx.root);
    const job = { id: randomUUID(), spec: spec() } as unknown as CodingJob;
    expect(await recoverySnapshot(undefined, job)).toEqual([]);
    // A missing worktree directory: git can't start there, as spawnSync's null stdout did.
    await expect(recoverySnapshot(fx.entry, job)).rejects.toBeTruthy();
    // Read-only roles are never looked at.
    const readOnly = { id: randomUUID(), spec: spec([{ roleId: "reviewer-1", access: "read" }]) } as unknown as CodingJob;
    expect(await recoverySnapshot(fx.entry, readOnly)).toEqual([]);
  });

  test("the plugin opens the store through openAsync and snapshots with async git only", async () => {
    const src = await Bun.file(join(import.meta.dir, "plugin.ts")).text();
    expect(src).not.toMatch(/\b(spawnSync|execSync|execFileSync)\s*\(/);
    expect(src).toContain("await CodingStore.openAsync(dataDir, {");
    expect(src).toContain("snapshot: (job) => recoverySnapshot(");
  });
});
