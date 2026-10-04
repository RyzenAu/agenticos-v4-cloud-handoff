import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_STOP_WINDOW_MS, commandRequestId, type CommandAdmissionKey } from "./command-admission";
import { JobService, type CreateJobInput } from "./service";

let dir: string;
let clock: number;
const stores: JobService[] = [];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (eventId = "evt-durable-001", personId = "usman", binding = digest("synthetic command binding")): CommandAdmissionKey => ({ personId, eventId, binding });
const input: CreateJobInput = { kind: "command", principal: { personId: "usman", via: "loopback-owner", actor: "human" }, title: "Synthetic command", targetDeviceId: "usman-pc" };
const make = (readOnly = false) => {
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), now: () => clock, readOnly, snapshotMs: 0, stopGraceMs: 5 });
  stores.push(jobs);
  return jobs;
};
function restart(jobs: JobService) {
  jobs.close();
  stores.splice(stores.indexOf(jobs), 1);
  return make();
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-admission-"));
  clock = Date.parse("2026-10-04T00:00:00Z");
});
afterEach(() => {
  for (const jobs of stores.splice(0)) jobs.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("durable command admission", () => {
  test("one accepted event survives close/reopen before any job; a restart never grants another claim", () => {
    let jobs = make();
    const k = key();
    expect(jobs.claimCommand(k)).toMatchObject({ status: "claimed", record: { admittedAt: clock, outcome: null } });
    jobs = restart(jobs);
    expect(jobs.claimCommand(k)).toMatchObject({ status: "existing", record: { jobId: null, binding: k.binding } });
    expect(jobs.list()).toEqual([]);
  });

  test("identity is the whole founder/event pair and the original immutable binding", () => {
    const jobs = make();
    const k = key();
    expect(jobs.claimCommand(k).status).toBe("claimed");
    expect(jobs.claimCommand({ ...k, binding: digest("different conversation, target or pin") }).status).toBe("conflict");
    expect(jobs.commandAdmission(k.personId, k.eventId)!.binding).toBe(k.binding);
    expect(jobs.claimCommand({ ...k, personId: "mehroz" }).status).toBe("claimed");
    expect(jobs.claimCommand({ ...k, eventId: "evt-durable-002" }).status).toBe("claimed");
  });

  test("unknown, no-work, stopped and completed admissions all remain closed to automatic replay", () => {
    let jobs = make();
    for (const outcome of ["unknown", "no-work", "stopped", "completed"] as const) {
      const k = key(`evt-${outcome}`);
      jobs.claimCommand(k);
      expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome })!.outcome).toBe(outcome);
    }
    clock += 365 * 24 * 60 * 60_000;
    jobs = restart(jobs);
    for (const outcome of ["unknown", "no-work", "stopped", "completed"] as const) {
      expect(jobs.claimCommand(key(`evt-${outcome}`))).toMatchObject({ status: "existing", record: { outcome } });
    }
  });

  test("two connections share one claim, including an unresolved event with no process-local map", () => {
    const a = make(), b = make(), k = key();
    expect(a.claimCommand(k).status).toBe("claimed");
    expect(b.claimCommand(k).status).toBe("existing");
    expect(b.requestCommandStop(k.personId, k.eventId).outcome).toBe("unconfirmed");
    expect(a.commandAdmission(k.personId, k.eventId)!.stoppedAt).toBe(clock);
  });

  test("concurrent processes atomically grant only one claim", async () => {
    make();
    const modulePath = new URL("./command-admission.ts", import.meta.url).pathname;
    const program = `import { Database } from "bun:sqlite"; import { CommandAdmissionStore } from ${JSON.stringify(modulePath)};
      const db = new Database(${JSON.stringify(join(dir, "jobs.sqlite"))}); db.exec("PRAGMA busy_timeout=3000");
      const s = new CommandAdmissionStore(db, () => 1); console.log(s.claim(${JSON.stringify(key())}).status); db.close();`;
    const statuses = await Promise.all(Array.from({ length: 6 }, async () => {
      const child = Bun.spawn([process.execPath, "-e", program], { env: {}, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return stdout.trim();
    }));
    expect(statuses.filter((x) => x === "claimed")).toHaveLength(1);
    expect(statuses.filter((x) => x === "existing")).toHaveLength(5);
  }, 10_000);
});

describe("durable Stop tombstones", () => {
  test("Stop before any request survives restart and prevents admission without inventing a job", () => {
    let jobs = make();
    const k = key();
    expect(jobs.requestCommandStop(k.personId, k.eventId)).toMatchObject({ outcome: "prevented", record: { admittedAt: null, binding: null } });
    jobs = restart(jobs);
    expect(jobs.claimCommand(k)).toMatchObject({ status: "existing", record: { admittedAt: null, stoppedAt: clock } });
    expect(jobs.createCommandJob(input, k)).toBeNull();
    expect(jobs.list()).toEqual([]);
  });

  test("the 30-minute boundary belongs only to never-admitted stops", () => {
    const jobs = make(), k = key();
    jobs.requestCommandStop(k.personId, k.eventId);
    clock += COMMAND_STOP_WINDOW_MS;
    expect(jobs.claimCommand(k).status).toBe("existing");
    clock++;
    expect(jobs.commandAdmission(k.personId, k.eventId)).toBeNull();
    expect(jobs.claimCommand(k)).toMatchObject({ status: "claimed", record: { stoppedAt: null, stopUntil: null } });
  });

  test("Stop during an accepted request never expires or becomes falsely prevented after restart", () => {
    let jobs = make();
    const k = key();
    jobs.claimCommand(k);
    expect(jobs.requestCommandStop(k.personId, k.eventId).outcome).toBe("unconfirmed");
    clock += COMMAND_STOP_WINDOW_MS + 1;
    jobs = restart(jobs);
    expect(jobs.requestCommandStop(k.personId, k.eventId)).toMatchObject({ outcome: "unconfirmed", record: { stopUntil: null } });
    expect(jobs.createCommandJob(input, k)).toBeNull();
    expect(jobs.claimCommand(k).status).toBe("existing");
  });

  test("a late outcome can refine uncertainty but can neither clear Stop nor rebind its job", () => {
    const jobs = make(), k = key();
    const jobId = "11111111-2222-4333-8444-555555555555";
    jobs.claimCommand(k);
    jobs.requestCommandStop(k.personId, k.eventId);
    jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "unknown", jobId, jobKind: "coding" });
    clock++;
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed" })).toMatchObject({ outcome: "completed", jobId, jobKind: "coding", stoppedAt: clock - 1 });
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", jobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" })).toBeNull();
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", jobId, jobKind: "job" })).toBeNull();
    expect(jobs.settleCommand(k.personId, k.eventId, digest("foreign binding"), { outcome: "no-work" })).toBeNull();
  });

  test("repeated Stop extends only its unclaimed tombstone window, without admitting it", () => {
    const jobs = make(), k = key();
    const first = jobs.requestCommandStop(k.personId, k.eventId).record;
    clock += COMMAND_STOP_WINDOW_MS - 1;
    const second = jobs.requestCommandStop(k.personId, k.eventId).record;
    expect(second.stoppedAt).toBe(first.stoppedAt);
    expect(second.stopUntil).toBe(clock + COMMAND_STOP_WINDOW_MS);
    expect(second.admittedAt).toBeNull();
  });
});

describe("atomic command job creation", () => {
  test("binds before publishing; another connection can cancel the committed job immediately", async () => {
    const jobs = make(), observer = make(), k = key();
    jobs.claimCommand(k);
    const observed: Array<string | null | undefined> = [];
    jobs.subscribe((event) => observed.push(observer.commandAdmission(k.personId, k.eventId)?.jobId));
    const job = jobs.createCommandJob(input, k)!;
    expect(observed).toEqual([job.id]);
    expect(observer.requestCommandStop(k.personId, k.eventId).record.jobId).toBe(job.id);
    expect(await observer.cancel(job.id)).toMatchObject({ state: "cancelled" });
    let ran = false;
    await jobs.run(job.id, async () => (ran = true, { ok: true }));
    expect(ran).toBe(false);
  });

  test("a stop on another connection winning first leaves no job or job event", () => {
    const jobs = make(), other = make(), k = key();
    jobs.claimCommand(k);
    other.requestCommandStop(k.personId, k.eventId);
    expect(jobs.createCommandJob(input, k)).toBeNull();
    expect(jobs.list()).toEqual([]);
    expect(jobs.events(0).events).toEqual([]);
  });

  test("one claim yields one job and preserves the original target on a duplicate create", () => {
    const jobs = make(), k = key();
    jobs.claimCommand(k);
    const first = jobs.createCommandJob(input, k)!;
    const second = jobs.createCommandJob({ ...input, targetDeviceId: "another-pc" }, k)!;
    expect(second.id).toBe(first.id);
    expect(second.targetDeviceId).toBe("usman-pc");
    expect(jobs.list()).toHaveLength(1);
    expect(jobs.events(0).events).toHaveLength(1);
  });

  test("missing, conflicting, settled or other-founder admission cannot create a job", () => {
    const jobs = make(), k = key();
    expect(jobs.createCommandJob(input, k)).toBeNull();
    jobs.claimCommand(k);
    expect(jobs.createCommandJob(input, { ...k, binding: digest("different pin") })).toBeNull();
    expect(() => jobs.createCommandJob({ ...input, principal: { ...input.principal, personId: "mehroz" } }, k)).toThrow();
    jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "unknown" });
    expect(jobs.createCommandJob(input, k)).toBeNull();
    expect(jobs.list()).toEqual([]);
  });

  test("a legacy request-key job is adopted without creating another", () => {
    const jobs = make(), k = key();
    const first = jobs.create({ ...input, requestId: commandRequestId(k.personId, k.eventId) });
    jobs.claimCommand(k);
    expect(jobs.createCommandJob(input, k)!.id).toBe(first.id);
    expect(jobs.commandAdmission(k.personId, k.eventId)!.jobId).toBe(first.id);
    expect(jobs.list()).toHaveLength(1);
  });

  test("pruning the old job does not reopen its admitted event", () => {
    const jobs = make(), k = key();
    jobs.claimCommand(k);
    const job = jobs.createCommandJob(input, k)!;
    jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed" });
    const db = new Database(join(dir, "jobs.sqlite"));
    db.query("DELETE FROM jobs WHERE id=?").run(job.id);
    db.close();
    expect(jobs.claimCommand(k).status).toBe("existing");
    expect(jobs.createCommandJob(input, k)).toBeNull();
    expect(jobs.list()).toEqual([]);
  });

  test("a failure validating the queued job preserves the accepted event and starts nothing", () => {
    const jobs = make(), k = key();
    jobs.claimCommand(k);
    expect(() => jobs.createCommandJob({ ...input, targetDeviceId: "invalid target" }, k)).toThrow();
    expect(jobs.commandAdmission(k.personId, k.eventId)).toMatchObject({ binding: k.binding, outcome: null, jobId: null });
    expect(jobs.claimCommand(k).status).toBe("existing");
    expect(jobs.list()).toEqual([]);
  });

  test("a failed binding rolls back the job insert without deleting the durable claim", () => {
    const jobs = make(), k = key();
    jobs.claimCommand(k);
    const db = new Database(join(dir, "jobs.sqlite"));
    db.exec("CREATE TRIGGER reject_command_binding BEFORE UPDATE OF job_id ON command_admissions WHEN NEW.job_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic bind fault'); END");
    db.close();
    expect(() => jobs.createCommandJob(input, k)).toThrow("synthetic bind fault");
    expect(jobs.list()).toEqual([]);
    expect(jobs.events(0).events).toEqual([]);
    expect(jobs.claimCommand(k)).toMatchObject({ status: "existing", record: { jobId: null } });
  });
});

describe("delegated task identity", () => {
  const taskId = "11111111-2222-4333-8444-555555555555";

  test("an explicit-start task is bound before wrapper creation without settling admission", () => {
    const jobs = make(), k = key();
    jobs.claimCommand(k);
    expect(jobs.bindCommandTask(k, { taskId, taskKind: "coding", outcome: "completed" } as never))
      .toMatchObject({ outcome: null, jobId: null, taskId, taskKind: "coding" });
    const wrapper = jobs.createCommandJob(input, k)!;
    expect(wrapper).not.toBeNull();
    expect(jobs.commandAdmission(k.personId, k.eventId))
      .toMatchObject({ outcome: null, jobId: wrapper.id, jobKind: "job", taskId, taskKind: "coding" });
  });

  test("Stop between explicit task binding and wrapper creation can identify the task and blocks the wrapper", () => {
    const jobs = make(), other = make(), k = key();
    jobs.claimCommand(k);
    expect(() => jobs.bindCommandTask(k, { taskId } as never)).toThrow("id and kind");
    jobs.bindCommandTask(k, { taskId, taskKind: "coding" });
    expect(other.requestCommandStop(k.personId, k.eventId))
      .toMatchObject({ outcome: "unconfirmed", record: { jobId: null, taskId, taskKind: "coding" } });
    expect(jobs.createCommandJob(input, k)).toBeNull();
    expect(jobs.list()).toEqual([]);
  });

  test("explicit-start binding rejects missing or mismatched admissions and conflicting tasks", () => {
    const jobs = make(), k = key();
    expect(jobs.bindCommandTask(k, { taskId, taskKind: "coding" })).toBeNull();
    jobs.claimCommand(k);
    expect(jobs.bindCommandTask({ ...k, binding: digest("different command") }, { taskId, taskKind: "coding" })).toBeNull();
    jobs.bindCommandTask(k, { taskId, taskKind: "coding" });
    expect(jobs.bindCommandTask(k, { taskId, taskKind: "job" })).toBeNull();
    expect(jobs.commandAdmission(k.personId, k.eventId))
      .toMatchObject({ outcome: null, jobId: null, taskId, taskKind: "coding" });
  });

  test("the wrapper and its effective coding task both survive restart and Stop", () => {
    let jobs = make();
    const k = key();
    jobs.claimCommand(k);
    const wrapper = jobs.createCommandJob(input, k)!;
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", taskId, taskKind: "coding" }))
      .toMatchObject({ jobId: wrapper.id, jobKind: "job", taskId, taskKind: "coding" });
    jobs = restart(jobs);
    expect(jobs.requestCommandStop(k.personId, k.eventId)).toMatchObject({
      outcome: "unconfirmed", record: { jobId: wrapper.id, jobKind: "job", taskId, taskKind: "coding" },
    });
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "stopped" }))
      .toMatchObject({ taskId, taskKind: "coding", stoppedAt: clock });
    expect(jobs.claimCommand(k).status).toBe("existing");
  });

  test("an effective task can be recorded before any wrapper without rebinding either identity", () => {
    const jobs = make(), k = key();
    const wrapperId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    jobs.claimCommand(k);
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "unknown", taskId, taskKind: "coding" }))
      .toMatchObject({ jobId: null, jobKind: null, taskId, taskKind: "coding" });
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", jobId: wrapperId }))
      .toMatchObject({ jobId: wrapperId, jobKind: "job", taskId, taskKind: "coding" });
    const before = jobs.commandAdmission(k.personId, k.eventId);
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "stopped", taskId: wrapperId, taskKind: "coding" })).toBeNull();
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "stopped", taskId, taskKind: "job" })).toBeNull();
    expect(jobs.settleCommand(k.personId, k.eventId, digest("other conversation"), { outcome: "stopped", taskId, taskKind: "coding" })).toBeNull();
    expect(jobs.commandAdmission(k.personId, k.eventId)).toEqual(before);
  });

  test("task ids and paired kinds are validated before any outcome changes", () => {
    const jobs = make(), k = key();
    jobs.claimCommand(k);
    expect(() => jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", taskId: "raw task title" })).toThrow("task id");
    expect(() => jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", taskKind: "coding" })).toThrow("task id");
    expect(() => jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", taskId, taskKind: "raw payload" } as never)).toThrow("task kind");
    expect(jobs.commandAdmission(k.personId, k.eventId)).toMatchObject({ outcome: null, taskId: null, taskKind: null });
    const db = new Database(join(dir, "jobs.sqlite"));
    expect(() => db.query("UPDATE command_admissions SET task_id=?").run(taskId)).toThrow();
    expect(() => db.query("UPDATE command_admissions SET task_kind='coding'").run()).toThrow();
    db.close();
  });

  test("existing ledgers get additive nullable task columns without losing admission or wrapper binding", () => {
    const k = key(), wrapperId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const db = new Database(join(dir, "jobs.sqlite"), { create: true });
    db.exec(`CREATE TABLE command_admissions (
      person_id TEXT NOT NULL, event_id TEXT NOT NULL, binding TEXT, admitted_at INTEGER,
      stopped_at INTEGER, stop_until INTEGER, outcome TEXT, job_id TEXT, job_kind TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(person_id,event_id)
    )`);
    db.query(`INSERT INTO command_admissions(person_id,event_id,binding,admitted_at,outcome,job_id,job_kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(k.personId, k.eventId, k.binding, clock, "completed", wrapperId, "job", clock, clock);
    db.close();
    const jobs = make();
    expect(jobs.claimCommand(k)).toMatchObject({ status: "existing", record: { jobId: wrapperId, jobKind: "job", outcome: "completed", taskId: null, taskKind: null } });
    expect(jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", taskId, taskKind: "coding" }))
      .toMatchObject({ jobId: wrapperId, taskId, taskKind: "coding" });
    const migrated = new Database(join(dir, "jobs.sqlite"));
    expect(() => migrated.query("UPDATE command_admissions SET task_kind=NULL").run()).toThrow();
    expect(() => migrated.query("UPDATE command_admissions SET task_id=NULL").run()).toThrow();
    expect(() => migrated.query("UPDATE command_admissions SET task_kind='unsupported'").run()).toThrow();
    migrated.close();
  });
});

describe("compatibility and data minimization", () => {
  test("the full 80-character event id is durable and maps to a collision-resistant job key", () => {
    const jobs = make();
    const a = key(`${"e".repeat(78)}-a`), b = key(`${"e".repeat(78)}-b`);
    jobs.claimCommand(a);
    jobs.claimCommand(b);
    const ja = jobs.createCommandJob(input, a)!, jb = jobs.createCommandJob(input, b)!;
    expect(ja.id).not.toBe(jb.id);
    expect(ja.requestId).toMatch(/^cmd-hash:[a-f0-9]{64}$/);
    expect(ja.requestId!.length).toBeLessThanOrEqual(80);
    expect(commandRequestId("usman", "evt-short")).toBe("cmd:usman:evt-short");
    expect(commandRequestId("usman", a.eventId)).not.toBe(commandRequestId("mehroz", a.eventId));
    expect(jobs.byRequest(commandRequestId("usman", a.eventId))!.id).toBe(ja.id);
  });

  test("read-only opens can inspect but cannot claim, stop, settle or create", () => {
    const jobs = make(), k = key();
    jobs.claimCommand(k);
    const reader = make(true);
    expect(reader.commandAdmission(k.personId, k.eventId)!.binding).toBe(k.binding);
    expect(() => reader.claimCommand(k)).toThrow("read-only");
    expect(() => reader.requestCommandStop(k.personId, k.eventId)).toThrow("read-only");
    expect(() => reader.settleCommand(k.personId, k.eventId, k.binding, { outcome: "unknown" })).toThrow("read-only");
    expect(() => reader.createCommandJob(input, k)).toThrow("read-only");
  });

  test("migration is additive to an existing store and preserves its jobs", () => {
    let jobs = make();
    const job = jobs.create(input);
    jobs.close();
    stores.splice(stores.indexOf(jobs), 1);
    const db = new Database(join(dir, "jobs.sqlite"));
    db.exec("DROP TABLE command_admissions");
    db.close();
    jobs = make();
    expect(jobs.get(job.id)!.title).toBe(input.title);
    expect(jobs.claimCommand(key()).status).toBe("claimed");
  });

  test("stores no body, raw binding, session, prompt or result payload; validates bounded fields", () => {
    const jobs = make();
    const raw = "pin password: synthetic-secret, email fixture@example.com";
    const k = key("evt-private", "usman", digest(raw));
    expect(() => jobs.claimCommand({ ...k, binding: raw })).toThrow("digest");
    jobs.claimCommand({ ...k, body: raw, sessionId: "sk1.synthetic-session" } as never);
    jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "no-work", result: raw } as never);
    expect(() => jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: raw } as never)).toThrow();
    expect(() => jobs.settleCommand(k.personId, k.eventId, k.binding, { outcome: "completed", jobId: raw })).toThrow();
    expect(() => jobs.claimCommand(key("bad id"))).toThrow();
    expect(() => commandRequestId("usman", "e".repeat(81))).toThrow();
    const db = new Database(join(dir, "jobs.sqlite"), { readonly: true });
    const dump = JSON.stringify(db.query("SELECT * FROM command_admissions").all());
    db.close();
    expect(dump).not.toContain("synthetic-secret");
    expect(dump).not.toContain("fixture@example.com");
    expect(dump).not.toContain("sk1.");
    expect(dump).not.toContain("result");
  });
});
