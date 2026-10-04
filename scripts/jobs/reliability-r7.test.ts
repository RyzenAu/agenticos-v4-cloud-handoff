// Round 7 (H-08): Stop on a job that no worker in this process holds must settle, with a reason, in a bounded time. It used to set a durable
// flag, leave the job "running", and the page said "Stopping…" for ever. Synthetic: a temp jobs database, a job row made "running" by hand
// (the shape of a worker that died, or of a seeded job nobody ever ran).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../approvals/principal";
import { JobService } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner", displayName: "Usman" };
let dir: string;
let service: JobService | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "r7-jobs-")); });
afterEach(() => { try { service?.close(); } catch { /* closed */ } service = null; try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const make = (grace = 150, extra: Partial<ConstructorParameters<typeof JobService>[0]> = {}) => (service = new JobService({ path: join(dir, "jobs.sqlite"), kill: async () => true, stopGraceMs: grace, accounting: async () => [{ pid: process.pid, ppid: 0, created: 0 }], ...extra }));
const heldByNobody = (s: JobService, state: "running" | "awaiting-approval" = "running") => {
  const job = s.create({ kind: "control", principal: usman, targetDeviceId: "dev-research", title: "Check three dental sites" });
  new Database(join(dir, "jobs.sqlite")).query("UPDATE jobs SET state=? WHERE id=?").run(state, job.id);
  return job.id;
};

describe("Stop on a job nobody holds", () => {
  test("a running job with no holder is closed as stopped, with the reason on it, within the grace period (not left 'running' with only a flag)", async () => {
    const s = make(150);
    const id = heldByNobody(s);
    const started = Date.now();
    const r = await s.cancel(id);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toMatchObject({ ok: true, state: "cancelled", aborted: false, quarantined: false });
    const job = s.get(id)!;
    expect(job.state).toBe("cancelled");
    expect(job.cancelRequested).toBe(true);
    expect(job.note).toMatch(/Stopped\. No worker was holding this job, and none answered the stop within 1 second.*Every process it had recorded was checked and is no longer running/);
    // A second Stop is told it is already over, and changes nothing.
    expect(await s.cancel(id)).toMatchObject({ ok: false, state: "cancelled" });
  });

  test("a job waiting on an approval with no holder settles the same way", async () => {
    const s = make(100);
    const id = heldByNobody(s, "awaiting-approval");
    expect((await s.cancel(id)).state).toBe("cancelled");
  });

  test("when another process honours the stop flag in time, its own outcome stands and the reply says it was acknowledged", async () => {
    const s = make(1000);
    const id = heldByNobody(s);
    setTimeout(() => new Database(join(dir, "jobs.sqlite")).query("UPDATE jobs SET state='cancelled', note='Stopped by the worker that held it.' WHERE id=?").run(id), 120);
    const r = await s.cancel(id);
    expect(r).toMatchObject({ ok: true, state: "cancelled", acknowledged: true });
    expect(s.get(id)!.note).toBe("Stopped by the worker that held it.");
  });
});

describe("review finding 3: a stop with no holder still honours the durable record of the job's processes", () => {
  const record = (id: string, pid: number, created: number, exited: 0 | 1) => new Database(join(dir, "jobs.sqlite")).query("INSERT INTO children (job_id, pid, created, exited) VALUES (?, ?, ?, ?)").run(id, pid, created, exited);
  test("a recorded process that is still alive: verified kill, the kill is checked, and the job is quarantined as unknown (never 'cancelled')", async () => {
    const killed: number[] = [];
    // The process stays in the table after the kill: the stop cannot be acknowledged.
    const s = make(100, { kill: async (pid) => { killed.push(pid); return true; }, accounting: async () => [{ pid: 4242, ppid: 1, created: 1_000_000 }] });
    const id = heldByNobody(s);
    record(id, 4242, 1_000_000, 0);
    const r = await s.cancel(id);
    expect(killed).toContain(4242);
    expect(r).toMatchObject({ ok: true, quarantined: true });
    expect(s.get(id)!.state).toBe("unknown");
    expect(s.get(id)!.quarantined).toBe(true);
  });
  test("a recorded process that is gone (or whose pid now belongs to another process): closed as stopped, nothing killed", async () => {
    const killed: number[] = [];
    const s = make(100, { kill: async (pid) => { killed.push(pid); return true; }, accounting: async () => [{ pid: 4343, ppid: 1, created: 9_999_999_999 }] });
    const id = heldByNobody(s);
    record(id, 4242, 1_000_000, 0); // not in the table at all
    record(id, 4343, 1_000_000, 1); // reused pid: a different creation time
    const r = await s.cancel(id);
    expect(killed).toEqual([]);
    expect(r).toMatchObject({ ok: true, state: "cancelled", quarantined: false });
  });
});
