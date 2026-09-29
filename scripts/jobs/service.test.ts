import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../approvals/principal";
import { JobService, type Receipt } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner", displayName: "Usman" };
let dir: string;
let clock: number;
const open: JobService[] = [];
const make = (extra: Partial<ConstructorParameters<typeof JobService>[0]> = {}) => {
  const s = new JobService({ path: join(dir, "jobs.sqlite"), now: () => clock, kill: async () => true, stopGraceMs: 50, accounting: async () => [{ pid: process.pid, ppid: 0, created: 0 }], ...extra });
  open.push(s);
  return s;
};
const restart = (s: JobService, extra: Partial<ConstructorParameters<typeof JobService>[0]> = {}) => {
  s.close();
  open.splice(open.indexOf(s), 1);
  return make(extra);
};
const newJob = (s: JobService, kind: "screen" | "away" | "control" | "coding" = "screen") =>
  s.create({ kind, principal: usman, targetDeviceId: "usman-pc", title: "Send the weekly report to ops@example.com" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-jobs-"));
  clock = Date.parse("2026-09-28T02:00:00Z");
});
afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {
      /* closed or running */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows WAL handle */
  }
});

describe("jobs and steps", () => {
  test("create → run → steps (masked) → succeeded, one history with events", async () => {
    const s = make();
    const job = newJob(s);
    expect(job.state).toBe("queued");
    expect(job.title).toContain("[email]");
    const r = await s.run(job.id, async (ctx) => {
      ctx.step({ intent: "Type the message 'call me on 0412 345 678'", executor: "uia", action: "[typed 24 characters]", ms: 12, outcome: "ok", jev: { op: "type", confidence: 0.91, policy: "act" } });
      ctx.step({ intent: "Press Send", executor: "uia", verification: { method: "uia-readback", ok: true }, ms: 30, outcome: "ok" });
      return { ok: true };
    });
    expect(r.admitted).toBe(true);
    expect(r.job!.state).toBe("succeeded");
    expect(r.job!.steps.map((x) => x.seq)).toEqual([1, 2]);
    expect(JSON.stringify(r.job!.steps)).not.toContain("345 678");
    const events = s.events(0).events;
    expect(events.filter((e) => e.type === "step").length).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "job", job: { state: "succeeded" } });
    expect(s.events(events.at(-1)!.seq).events.length).toBe(0);
    expect(s.head()).toBe(events.at(-1)!.seq);
  });

  test("create is idempotent on requestId, validates kind, principal and device", () => {
    const s = make();
    const a = s.create({ kind: "voice", principal: usman, targetDeviceId: "usman-pc", title: "x", requestId: "req-1" });
    const b = s.create({ kind: "voice", principal: usman, targetDeviceId: "usman-pc", title: "x", requestId: "req-1" });
    expect(b.id).toBe(a.id);
    expect(() => s.create({ kind: "trading" as never, principal: usman, targetDeviceId: "usman-pc", title: "x" })).toThrow();
    expect(() => s.create({ kind: "voice", principal: { personId: "bob" } as never, targetDeviceId: "usman-pc", title: "x" })).toThrow();
    expect(() => s.create({ kind: "voice", principal: usman, targetDeviceId: "", title: "x" })).toThrow();
  });

  test("a failing executor is failed; an awaiting-approval job resumes; a job can't run twice", async () => {
    const s = make();
    const job = newJob(s);
    const approvalId = "11111111-2222-4333-8444-555555555555";
    await s.run(job.id, async (ctx) => {
      ctx.awaitingApproval(approvalId);
      expect(s.get(job.id)!.state).toBe("awaiting-approval");
      ctx.resumed();
      return { ok: false, note: "The button wasn't there" };
    });
    expect(s.get(job.id)).toMatchObject({ state: "failed", approvalId });
    const again = await s.run(job.id, async () => ({ ok: true }));
    expect(again).toMatchObject({ admitted: false, reason: "not-queued" });
  });
});

describe("receipts", () => {
  const base: Receipt = {
    requestId: "r1", provider: "openrouter", model: "deepseek/deepseek-chat:free", route: "free", selectedBy: "rule", reason: "paid model limited",
    inputTokens: null, outputTokens: 120, costUsd: null, latencyMs: 820, outcome: "succeeded", fallbackFrom: "anthropic/claude-sonnet-4.6",
  };
  test("unknown stays null, fallbackFrom is kept, subscription records allowance not cash", () => {
    const s = make();
    const job = newJob(s);
    const a = s.receipt(job.id, base)!;
    expect(a).toMatchObject({ inputTokens: null, outputTokens: 120, costUsd: null, fallbackFrom: "anthropic/claude-sonnet-4.6" });
    const sub = s.receipt(job.id, { ...base, route: "subscription", costUsd: 0.12, fallbackFrom: null, allowance: { plan: "claude-max-20x", window: "5h", usedPct: null } })!;
    expect(sub.costUsd).toBeNull();
    expect(sub.allowance).toEqual({ plan: "claude-max-20x", window: "5h", usedPct: null });
    expect(() => s.receipt(job.id, { ...base, route: "free-ish" as never })).toThrow();
    expect(s.get(job.id)!.receipts.length).toBe(2);
  });
});

describe("cancel", () => {
  /** A fake OS process table: pid → creation time (ms). */
  const T0 = Date.parse("2026-09-28T01:59:00Z");
  const table = (rows: [number, number | null, number?][]) => async () => [
    { pid: process.pid, ppid: 0, created: T0 - 60_000 },
    ...rows.map(([pid, created, ppid]) => ({ pid, ppid: ppid ?? process.pid, created })),
  ];
  const waitForAbort = (ctx: { signal: AbortSignal }) => new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));

  test("a queued job is cancelled before it starts and never runs", async () => {
    const s = make();
    const job = newJob(s);
    expect(await s.cancel(job.id)).toMatchObject({ ok: true, state: "cancelled" });
    expect((await s.run(job.id, async () => ({ ok: true }))).admitted).toBe(false);
  });

  /** A live fake OS: processes with parents; a kill removes the process and its live descendants (taskkill /t). */
  function fakeOs(initial: [pid: number, ppid: number, created: number][], opts: { killable?: (pid: number) => boolean } = {}) {
    const procs = new Map(initial.map(([pid, ppid, created]) => [pid, { ppid, created }]));
    const killed: number[] = [];
    return {
      procs,
      killed,
      accounting: async () => [{ pid: process.pid, ppid: 0, created: T0 - 60_000 }, ...[...procs].map(([pid, p]) => ({ pid, ppid: p.ppid, created: p.created }))],
      kill: async (pid: number) => {
        killed.push(pid);
        if (opts.killable && !opts.killable(pid)) return true; // claims success, kills nothing
        const doomed = [pid];
        for (let i = 0; i < doomed.length; i++) for (const [c, p] of procs) if (p.ppid === doomed[i] && !doomed.includes(c)) doomed.push(c);
        for (const d of doomed) procs.delete(d);
        return true;
      },
    };
  }

  test("cooperative flag + executor abort + tree-kill of every registered child whose identity matches; the OS confirms", async () => {
    const os = fakeOs([[4242, process.pid, T0], [4343, process.pid, T0]]);
    const s = make({ kill: os.kill, accounting: os.accounting });
    const job = newJob(s);
    let sawFlag = false;
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(4242, T0);
      ctx.registerChild(4343, T0);
      await waitForAbort(ctx);
      sawFlag = ctx.cancelRequested();
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ ok: true, aborted: true, acknowledged: true, quarantined: false, state: "cancelled" });
    const done = await running;
    expect(sawFlag).toBe(true);
    expect(os.killed.sort()).toEqual([4242, 4343]);
    expect(os.procs.size).toBe(0);
    expect(done.job).toMatchObject({ state: "cancelled", cancelRequested: true, quarantined: false });
  });

  test("review R2 orphan: the parent exited, its detached child still runs: the orphan is found by its parent PID and killed", async () => {
    // 500 (registered) spawned 501 detached, then exited. Windows keeps 501's ppid = 500.
    const os = fakeOs([[500, process.pid, T0], [501, 500, T0 + 1_000]]);
    const s = make({ kill: os.kill, accounting: os.accounting, snapshotMs: 0 });
    const job = newJob(s, "control");
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(500, T0);
      os.procs.delete(500); // the parent exits; the orphan keeps running
      ctx.childExited(500);
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ acknowledged: true, quarantined: false, state: "cancelled" });
    await running;
    expect(os.killed).toEqual([501]);
    expect(os.procs.has(501)).toBe(false);
  });

  test("review R2 orphan: an orphan whose own parent ALSO exited is found from the snapshot taken while they were alive", async () => {
    // 600 → 601 → 602 (detached grandchild). 600 and 601 exit; 602's ppid (601) is dead.
    const os = fakeOs([[600, process.pid, T0], [601, 600, T0 + 1_000], [602, 601, T0 + 2_000]]);
    const s = make({ kill: os.kill, accounting: os.accounting, snapshotMs: 5 });
    const job = newJob(s, "control");
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(600, T0);
      await Bun.sleep(30); // periodic snapshots see 601 and 602 while alive
      os.procs.delete(600);
      os.procs.delete(601);
      ctx.childExited(600);
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(40);
    expect(await s.cancel(job.id)).toMatchObject({ acknowledged: true, quarantined: false });
    await running;
    expect(os.killed).toEqual([602]);
    expect(os.procs.size).toBe(0);
  });

  test("review R2 orphan: an orphan that survives the kill is NOT acknowledged: the job is quarantined, outcome unknown", async () => {
    const os = fakeOs([[700, process.pid, T0], [701, 700, T0 + 1_000]], { killable: (pid) => pid !== 701 });
    const s = make({ kill: os.kill, accounting: os.accounting, snapshotMs: 0 });
    const job = newJob(s, "control");
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(700, T0);
      os.procs.delete(700);
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ acknowledged: false, quarantined: true });
    expect((await running).job).toMatchObject({ state: "unknown", quarantineReason: "termination_unverified" });
    // The release waits for the orphan to be gone.
    expect(await s.releaseQuarantine(job.id, () => true)).toEqual({ ok: false, reason: "tree-present" });
    os.procs.delete(701);
    expect(await s.releaseQuarantine(job.id, () => true)).toEqual({ ok: true });
  });

  test("review R2 executor contract: after a stop, an executor must return not-ok; ok:true is recorded as completed and quarantined", async () => {
    const os = fakeOs([]);
    // Honours the contract: stops and returns not-ok → cancelled, acknowledged, no quarantine.
    const s = make({ kill: os.kill, accounting: os.accounting });
    const good = newJob(s, "coding");
    const g = s.run(good.id, async (ctx) => {
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(good.id)).toMatchObject({ state: "cancelled", acknowledged: true, quarantined: false });
    await g;
    // Breaks it: returns ok after the stop → the history says it completed, and the kind is held.
    const bad = newJob(s, "coding");
    const b = s.run(bad.id, async (ctx) => {
      await waitForAbort(ctx);
      return { ok: true };
    });
    await Bun.sleep(5);
    await s.cancel(bad.id);
    expect((await b).job).toMatchObject({ state: "succeeded", quarantined: true, quarantineReason: "stop_ignored" });
  });

  test("a stop that settles late says so (not 'Stopped on request')", async () => {
    const s = make({ accounting: table([]), stopGraceMs: 20 });
    const job = newJob(s, "lesson");
    const running = s.run(job.id, async () => {
      await Bun.sleep(80);
      return { ok: false };
    });
    await Bun.sleep(5);
    await s.cancel(job.id);
    const done = (await running).job!;
    expect(done.state).toBe("cancelled");
    expect(done.note).toContain("Stopped late");
    expect(done.quarantined).toBe(true);
  });

  test("an unacknowledged kill quarantines the job (outcome unknown) and blocks the kind until an approved release", async () => {
    let alive = true;
    const s = make({ kill: async () => false, accounting: async () => (alive ? table([[999, T0]])() : table([])()) });
    const job = newJob(s, "control");
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(999, T0);
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ acknowledged: false, quarantined: true });
    const settled = await running;
    expect(settled.job).toMatchObject({ state: "unknown", quarantined: true, quarantineReason: "termination_unverified" });
    const next = newJob(s, "control");
    expect(await s.run(next.id, async () => ({ ok: true }))).toMatchObject({ admitted: false, reason: "quarantined" });
    const other = newJob(s, "screen");
    expect((await s.run(other.id, async () => ({ ok: true }))).admitted).toBe(true);
    // Release: the tree must be gone (process table), then an approval must be consumed.
    expect(await s.releaseQuarantine(job.id, () => true)).toEqual({ ok: false, reason: "tree-present" });
    alive = false;
    expect(await s.releaseQuarantine(job.id, () => false)).toEqual({ ok: false, reason: "not-approved" });
    expect(await s.releaseQuarantine(job.id, () => true)).toEqual({ ok: true });
    expect((await s.run(next.id, async () => ({ ok: true }))).admitted).toBe(true);
    expect(s.get(job.id)!.state).toBe("unknown"); // released, still never re-run
  });

  test("review B3: an executor that ignores the stop and completes is recorded as succeeded, and the kind is quarantined", async () => {
    const s = make({ accounting: table([]) });
    const job = newJob(s, "away");
    let finish!: () => void;
    const late = new Promise<void>((resolve) => (finish = resolve));
    const running = s.run(job.id, async () => {
      await late; // never looks at the signal
      return { ok: true };
    });
    await Bun.sleep(5);
    const c = await s.cancel(job.id);
    // It didn't settle within the grace period: quarantined, outcome unknown for now.
    expect(c).toMatchObject({ acknowledged: false, quarantined: true, state: "unknown" });
    finish();
    const done = await running;
    // Then it completed: the history says what happened.
    expect(done.job).toMatchObject({ state: "succeeded", quarantined: true });
    expect(done.job!.note).toContain("stop wasn't honoured");
    const next = newJob(s, "away");
    expect(await s.run(next.id, async () => ({ ok: true }))).toMatchObject({ admitted: false, reason: "quarantined" });
  });

  test("review B3: completing right after the stop (within the grace period) is also succeeded + quarantined, never 'cancelled'", async () => {
    const s = make({ accounting: table([]) });
    const job = newJob(s, "screen");
    const running = s.run(job.id, async (ctx) => {
      await waitForAbort(ctx);
      return { ok: true };
    });
    await Bun.sleep(5);
    const c = await s.cancel(job.id);
    expect(c).toMatchObject({ state: "succeeded", quarantined: true, acknowledged: false });
    expect((await running).job).toMatchObject({ state: "succeeded", quarantined: true, quarantineReason: "stop_ignored" });
  });

  test("review H3: a child that already exited is never killed and doesn't quarantine", async () => {
    const killed: number[] = [];
    const s = make({ kill: async (pid) => (killed.push(pid), false), accounting: table([]) });
    const job = newJob(s);
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(5151, T0);
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ acknowledged: true, quarantined: false, state: "cancelled" });
    await running;
    expect(killed).toEqual([]);
  });

  test("review H3: a reused PID (same number, different creation time) is never killed", async () => {
    const killed: number[] = [];
    const s = make({ kill: async (pid) => (killed.push(pid), true), accounting: table([[6161, T0 + 3_600_000]]) });
    const job = newJob(s);
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(6161, T0);
      ctx.childExited(6161); // exited...
      ctx.registerChild(6161, T0); // (re-registered by a buggy executor: identity still decides)
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ acknowledged: true, quarantined: false });
    await running;
    expect(killed).toEqual([]);
  });

  test("review H3: a child whose identity can't be verified is not killed; the job is quarantined instead", async () => {
    const killed: number[] = [];
    const s = make({ kill: async (pid) => (killed.push(pid), true), accounting: table([[7171, null]]) });
    const job = newJob(s);
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(7171); // creation time read from the (fake) OS: unknown
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ quarantined: true });
    expect((await running).job).toMatchObject({ state: "unknown", quarantineReason: "identity_unverified" });
    expect(killed).toEqual([]);
  });

  test("an unreadable process table quarantines (fail closed), and the quarantine survives a restart", async () => {
    let s = make({ accounting: async () => Promise.reject(new Error("no table")) });
    const job = newJob(s);
    const running = s.run(job.id, async (ctx) => {
      ctx.registerChild(8181, T0);
      await waitForAbort(ctx);
      return { ok: false };
    });
    await Bun.sleep(5);
    expect(await s.cancel(job.id)).toMatchObject({ quarantined: true });
    await running;
    s = restart(s, { accounting: table([]) });
    s.recover();
    expect(s.quarantined("screen").map((j) => j.id)).toEqual([job.id]);
    // After the restart, release still checks the persisted tree (now gone) and needs the approval.
    expect(await s.releaseQuarantine(job.id, () => true)).toEqual({ ok: true });
  });

  test("a finished job can't be cancelled", async () => {
    const s = make();
    const job = newJob(s);
    await s.run(job.id, async () => ({ ok: true }));
    expect(await s.cancel(job.id)).toMatchObject({ ok: false, state: "succeeded" });
  });
});

describe("restart", () => {
  test("running → unknown and never re-run; queued/awaiting → interrupted; finished untouched", async () => {
    let s = make();
    const running = newJob(s);
    const queued = newJob(s);
    const waiting = newJob(s);
    const finished = newJob(s);
    await s.run(finished.id, async () => ({ ok: true }));
    s.begin(running.id);
    s.begin(waiting.id);
    s.finish(waiting.id, "awaiting-approval", "Waiting for a yes");
    s = restart(s);
    expect(s.recover()).toEqual({ unknown: 1, interrupted: 2 });
    expect(s.get(running.id)).toMatchObject({ state: "unknown" });
    expect(s.get(running.id)!.note).toContain("not re-run");
    expect(s.get(queued.id)!.state).toBe("interrupted");
    expect(s.get(waiting.id)!.state).toBe("interrupted");
    expect(s.get(finished.id)!.state).toBe("succeeded");
    let ran = 0;
    for (const id of [running.id, queued.id, waiting.id]) {
      const r = await s.run(id, async () => (ran++, { ok: true }));
      expect(r.admitted).toBe(false);
      expect(s.begin(id)).toBe(false);
    }
    expect(ran).toBe(0);
  });

  test("steps and receipts survive the restart", async () => {
    let s = make();
    const job = newJob(s);
    await s.run(job.id, async (ctx) => {
      ctx.step({ intent: "Open Outlook", executor: "uia", ms: 5, outcome: "ok" });
      return { ok: true };
    });
    s = restart(s);
    s.recover();
    expect(s.get(job.id)!.steps.length).toBe(1);
    expect(s.list({ kind: "screen" })[0]).toMatchObject({ id: job.id, stepCount: 1 });
  });

  test("the store holds no raw digits or e-mails", async () => {
    const s = make();
    const job = newJob(s);
    s.begin(job.id);
    s.step(job.id, { intent: "Card 4111 1111 1111 1111 for bob@example.com", executor: "uia", ms: 1, outcome: "note" });
    s.close();
    open.splice(0);
    const db = new Database(join(dir, "jobs.sqlite"), { readonly: true });
    const dump = JSON.stringify([db.query("SELECT * FROM jobs").all(), db.query("SELECT * FROM steps").all(), db.query("SELECT * FROM events").all()]);
    db.close();
    expect(dump).not.toContain("4111");
    expect(dump).not.toContain("bob@example.com");
    expect(dump).not.toContain("ops@example.com");
  });
});
