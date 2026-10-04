import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dataDirFor } from "../cloud/data-dir";
import { createArtifactStore } from "../computers/artifacts";
import { JobService } from "../jobs/service";
import { openCrm, crmPath } from "../leads/crm";
import type { Principal } from "../identity/principal";
import {
  connectCrmToHub,
  verifyAgentFromStores,
  verifyCommunicationEvidenceClosed,
} from "./hub-integration";
import { migrateCrm } from "./migrations";
import { createCrmMiddleware } from "./plugin";
import { closeCrmRuntime, crmRuntime } from "./runtime";
import { crmUpgradeState, CrmNeedsUpgradeError } from "./upgrade-guard";
import type { CrmChange } from "./store";

const founder = (personId: "usman" | "mehroz"): Principal => ({
  personId,
  via: "paired-session",
  actor: "human",
  displayName: personId,
  sessionId: `synthetic-session-${personId}-1`,
});
const roots: string[] = [];
const jobsOpen: JobService[] = [];
afterEach(() => {
  for (const j of jobsOpen.splice(0)) j.close();
  for (const root of roots.splice(0)) {
    closeCrmRuntime(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Bun on Windows keeps a closed SQLite file locked until GC; a temp folder may outlive the test */
    }
  }
});
const tmpRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "crm-hub-"));
  roots.push(root);
  return root;
};
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("a real crm.sqlite from before schema v1 is never upgraded by opening the runtime or the mounted route", async () => {
  const root = tmpRoot();
  mkdirSync(dataDirFor(root), { recursive: true });
  const file = crmPath(root);
  const legacy = openCrm(file);
  legacy
    .query(
      "INSERT INTO leads(place_id,vertical,name,phone) VALUES('p1','dental','Synthetic Dental','0400000000')",
    )
    .run();
  legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  legacy.close();
  const before = sha(file);
  expect(crmUpgradeState(root)).toEqual({ state: "needs-upgrade", version: 0 });
  expect(() => crmRuntime(root)).toThrow(CrmNeedsUpgradeError);
  // The mounted route says so plainly, answers 503 and opens nothing.
  const middleware = createCrmMiddleware({ root, token: "t", principal: () => founder("usman") });
  const replies: { status: number; body: any }[] = [];
  const res = {
    setHeader() {},
    end(text?: string) {
      replies.at(-1)!.body = text ? JSON.parse(text) : null;
    },
    set statusCode(v: number) {
      replies.push({ status: v, body: null });
    },
  };
  await middleware.handle(
    { url: "/__crm/snapshot", method: "GET", headers: { host: "localhost" }, socket: {} } as never,
    res as never,
    () => {},
  );
  expect(replies[0].status).toBe(503);
  expect(replies[0].body.code).toBe("needs-upgrade");
  expect(replies[0].body.error).toContain("one-time upgrade");
  middleware.close();
  expect(sha(file)).toBe(before);
  const check = new Database(file, { readonly: true });
  expect(
    check.query("SELECT name FROM sqlite_master WHERE name='crm_schema_migrations'").get(),
  ).toBeNull();
  check.close();
  // After the owner-run migration the same file opens, with the original lead preserved as a company.
  const owner = new Database(file);
  migrateCrm(owner);
  owner.close();
  expect(crmUpgradeState(root)).toEqual({ state: "ready" });
  expect(crmRuntime(root).store.snapshot().companies).toHaveLength(1);
});

test("a hub with no CRM file yet may create one at the current schema", () => {
  const root = tmpRoot();
  expect(crmUpgradeState(root)).toEqual({ state: "fresh" });
  expect(crmRuntime(root).store.snapshot().companies).toEqual([]);
});

function jobsFor(root: string) {
  const jobs = new JobService({ path: join(root, "jobs.sqlite") });
  jobsOpen.push(jobs);
  return jobs;
}

test("verifyAgent reads the saved job: agent, record, person and a finished state, never the caller's claim", async () => {
  const root = tmpRoot();
  const jobs = jobsFor(root);
  const deal = "crm:deal:" + "d".repeat(100);
  const job = jobs.create({
    kind: "control",
    principal: founder("usman"),
    targetDeviceId: "synthetic",
    title: "Synthetic research",
    bot: "research",
    subjects: [deal],
  });
  expect(job.subjects).toEqual([deal]); // a 100-character CRM id is a valid subject now
  const verify = verifyAgentFromStores({ jobs: () => jobs });
  const ref = { kind: "deal" as const, id: "d".repeat(100) };
  const by = { agent: "Research", jobId: job.id };
  expect(verify(by, founder("usman"), ref)).toBe(false); // not finished
  await jobs.run(job.id, async () => ({ ok: true, note: "done" }));
  expect(verify(by, founder("usman"), ref)).toBe(true);
  expect(verify(by, founder("mehroz"), ref)).toBe(false); // another person
  expect(verify({ agent: "Builder", jobId: job.id }, founder("usman"), ref)).toBe(false);
  expect(verify(by, founder("usman"), { kind: "deal", id: "other" })).toBe(false);
  expect(verify({ agent: "Research", jobId: "no-such-job" }, founder("usman"), ref)).toBe(false);
  expect(verifyCommunicationEvidenceClosed()).toBe(false);
  // A coding job: the saved link and the coding store's own state.
  const link = { bot: "builder", personId: "usman", subjects: ["crm:deal:x1"] };
  const coding = verifyAgentFromStores({
    jobs: () => jobs,
    codingLink: () => link,
    codingState: () => "completed",
  });
  expect(
    coding({ agent: "builder", jobId: "coding-1" }, founder("usman"), { kind: "deal", id: "x1" }),
  ).toBe(true);
  const running = verifyAgentFromStores({
    jobs: () => jobs,
    codingLink: () => link,
    codingState: () => "building",
  });
  expect(
    running({ agent: "builder", jobId: "coding-1" }, founder("usman"), { kind: "deal", id: "x1" }),
  ).toBe(false);
});

test("a finished job with a CRM subject adds at most one result activity, however often its event repeats", async () => {
  const root = tmpRoot();
  const jobs = jobsFor(root);
  const published: CrmChange[] = [];
  const stop = connectCrmToHub(root, {
    publish: (c) => published.push(c),
    jobs: () => jobs,
    role: () => "server",
    artifacts: () => createArtifactStore(join(dataDirFor(root), "computers", "artifacts")),
  });
  try {
    const store = crmRuntime(root).store;
    const company = store.createCompany(
      { name: "Synthetic result company" },
      { personId: "usman" },
    );
    const deal = store.createDeal(
      {
        companyId: company.id,
        title: "Synthetic site",
        service: "website",
        scope: "Five pages",
      } as never,
      { personId: "usman" },
    );
    const subject = `crm:deal:${deal.id}`;
    const job = jobs.create({
      kind: "control",
      principal: founder("usman"),
      targetDeviceId: "synthetic",
      title: "Research the competitors",
      bot: "research",
      subjects: [subject],
    });
    const other = jobs.create({
      kind: "control",
      principal: founder("usman"),
      targetDeviceId: "synthetic",
      title: "No record",
      bot: "research",
    });
    const failed = jobs.create({
      kind: "control",
      principal: founder("usman"),
      targetDeviceId: "synthetic",
      title: "Fails",
      bot: "research",
      subjects: [subject],
    });
    const artifacts = createArtifactStore(join(dataDirFor(root), "computers", "artifacts"));
    await jobs.run(job.id, async () => {
      artifacts.save({
        jobId: job.id,
        personId: "usman",
        kind: "research",
        title: "Report",
        summary: "s",
        host: "synthetic",
        computer: "c",
        outcome: "complete",
        main: "report.md",
        files: [{ name: "report.md", data: "# Synthetic" }],
      });
      return { ok: true, note: "saved" };
    });
    await jobs.run(other.id, async () => ({ ok: true, note: "done" }));
    await jobs.run(failed.id, async () => ({ ok: false, note: "nope" }));
    await new Promise((r) => setTimeout(r, 50));
    const results = () => store.snapshot().activities.filter((a) => a.eventId.endsWith(":result"));
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({
      eventId: `${job.id}:result`,
      kind: "agent-result",
      artifact: `artifact:${job.id}/report.md`,
    });
    expect(results()[0].ref).toEqual({ kind: "deal", id: deal.id });
    // The event repeating (a reconnect, a second listener) changes nothing.
    const op = crmRuntime(root).operations;
    const again = op.run(
      "crm.activity.add",
      {
        ref: { kind: "deal", id: deal.id },
        eventId: `${job.id}:result`,
        kind: "agent-result",
        title: results()[0].title,
        artifact: `artifact:${job.id}/report.md`,
        by: { agent: "research", jobId: job.id },
      },
      founder("usman"),
    );
    expect(results()).toHaveLength(1);
    expect(again.ok).toBe(true);
    // Events carry the ref and kind of change only, and none for the replay.
    for (const c of published) expect(Object.keys(c).sort()).toEqual(["at", "change", "ref"]);
    const activityEvents = published.filter(
      (c) => c.ref.kind === "company" || c.ref.kind === "deal",
    ).length;
    expect(activityEvents).toBeGreaterThan(0);
  } finally {
    stop();
  }
});

test("a committed change is published once; a replayed activity add publishes nothing more", () => {
  const root = tmpRoot();
  const published: CrmChange[] = [];
  const stop = connectCrmToHub(root, { publish: (c) => published.push(c), jobs: () => null });
  try {
    const rt = crmRuntime(root);
    const company = rt.store.createCompany(
      { name: "Synthetic once company" },
      { personId: "usman" },
    );
    const base = {
      ref: { kind: "company" as const, id: company.id },
      eventId: "synthetic:note:1",
      kind: "note",
      title: "A note",
    };
    expect(rt.operations.run("crm.activity.add", base, founder("usman")).ok).toBe(true);
    const afterFirst = published.length;
    expect(rt.operations.run("crm.activity.add", base, founder("usman")).ok).toBe(true);
    expect(published).toHaveLength(afterFirst);
    expect(JSON.stringify(published)).not.toContain("Synthetic once company");
  } finally {
    stop();
  }
});

const person = (
  via: Principal["via"],
  actor: "human" | "process",
  personId: "usman" | "mehroz" = "usman",
): Principal => ({ personId, via, actor, displayName: personId });

test("only a permitted principal's bot job writes the CRM, once; command jobs and every other principal write nothing", async () => {
  const cases: { name: string; principal: Principal; role: string; writes: boolean }[] = [
    {
      name: "paired confirmed session (server role)",
      principal: person("paired-session", "human"),
      role: "server",
      writes: true,
    },
    {
      name: "owner at the hub (pc role)",
      principal: person("loopback-owner", "human"),
      role: "pc",
      writes: true,
    },
    {
      name: "paired session on a pc hub",
      principal: person("paired-session", "human"),
      role: "pc",
      writes: false,
    },
    {
      name: "bare tailnet login",
      principal: person("tailnet-person", "process", "mehroz"),
      role: "server",
      writes: false,
    },
    {
      name: "telegram owner",
      principal: person("telegram-owner", "human"),
      role: "server",
      writes: false,
    },
    { name: "routine", principal: person("routine", "process"), role: "server", writes: false },
    {
      name: "gateway/companion",
      principal: person("companion", "process"),
      role: "server",
      writes: false,
    },
  ];
  for (const c of cases) {
    const root = tmpRoot();
    const jobs = jobsFor(root);
    const stop = connectCrmToHub(root, { jobs: () => jobs, role: () => c.role, retryMs: 20 });
    try {
      const store = crmRuntime(root).store;
      const company = store.createCompany(
        { name: "Synthetic principal company" },
        { personId: "usman" },
      );
      const subject = `crm:company:${company.id}`;
      const botJob = jobs.create({
        kind: "control",
        principal: c.principal,
        targetDeviceId: "synthetic",
        title: "Bot work",
        bot: "research",
        subjects: [subject],
      });
      const commandJob = jobs.create({
        kind: "command",
        principal: c.principal,
        targetDeviceId: "synthetic",
        title: "What is overdue?",
        subjects: [subject],
      });
      await jobs.run(botJob.id, async () => ({ ok: true, note: "done" }));
      await jobs.run(commandJob.id, async () => ({ ok: true, note: "done" }));
      await new Promise((r) => setTimeout(r, 80));
      const written = store.snapshot().activities.filter((a) => a.eventId.endsWith(":result"));
      expect(
        written.map((a) => a.eventId),
        c.name,
      ).toEqual(c.writes ? [`${botJob.id}:result`] : []);
      expect(JSON.stringify(written)).not.toContain("What is overdue");
    } finally {
      stop();
    }
  }
});

test("a command job that carries no bot is never recorded, even with a CRM subject", async () => {
  const root = tmpRoot();
  const jobs = jobsFor(root);
  const stop = connectCrmToHub(root, { jobs: () => jobs, role: () => "pc", retryMs: 20 });
  try {
    const store = crmRuntime(root).store;
    const company = store.createCompany({ name: "Synthetic quiet company" }, { personId: "usman" });
    const job = jobs.create({
      kind: "control",
      principal: person("loopback-owner", "human"),
      targetDeviceId: "synthetic",
      title: "No bot",
      subjects: [`crm:company:${company.id}`],
    });
    await jobs.run(job.id, async () => ({ ok: true, note: "done" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(store.snapshot().activities).toHaveLength(0);
  } finally {
    stop();
  }
});

test("a result the CRM could not take (needs its upgrade, busy) is retried and then recorded exactly once, including after a restart", async () => {
  const root = tmpRoot();
  const jobs = jobsFor(root);
  const owner = person("loopback-owner", "human");
  const company = crmRuntime(root).store.createCompany(
    { name: "Synthetic retry company" },
    { personId: "usman" },
  );
  const subject = `crm:company:${company.id}`;
  // The job finished while the hub was not connected (a restart, or the CRM not open yet).
  const job = jobs.create({
    kind: "control",
    principal: owner,
    targetDeviceId: "synthetic",
    title: "Late work",
    bot: "research",
    subjects: [subject],
  });
  await jobs.run(job.id, async () => ({ ok: true, note: "done" }));
  let failures = 2;
  const calls: string[] = [];
  const stop = connectCrmToHub(root, {
    jobs: () => jobs,
    role: () => "pc",
    retryMs: 20,
    run: (name, input, principal) => {
      calls.push(name);
      if (failures-- > 0)
        throw Object.assign(new Error("needs upgrade"), { name: "CrmNeedsUpgradeError" });
      return crmRuntime(root).operations.run(name, input, principal);
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 250));
    const results = () =>
      crmRuntime(root)
        .store.snapshot()
        .activities.filter((a) => a.eventId === `${job.id}:result`);
    expect(results()).toHaveLength(1);
    expect(calls.length).toBeGreaterThanOrEqual(3); // two refused attempts, then the write
    const settled = calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.length).toBe(settled); // done: no more attempts
  } finally {
    stop();
  }
  // Another restart finds it already recorded: still one.
  const again = connectCrmToHub(root, { jobs: () => jobs, role: () => "pc", retryMs: 20 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(
      crmRuntime(root)
        .store.snapshot()
        .activities.filter((a) => a.eventId === `${job.id}:result`),
    ).toHaveLength(1);
  } finally {
    again();
  }
});

test("the startup backfill still finds an older missed bot result when more than 200 newer jobs are not bot jobs", async () => {
  const root = tmpRoot();
  const jobs = jobsFor(root);
  const owner = person("loopback-owner", "human");
  const company = crmRuntime(root).store.createCompany(
    { name: "Synthetic old result company" },
    { personId: "usman" },
  );
  const old = jobs.create({
    kind: "control",
    principal: owner,
    targetDeviceId: "synthetic",
    title: "Old bot work",
    bot: "research",
    subjects: [`crm:company:${company.id}`],
  });
  await jobs.run(old.id, async () => ({ ok: true, note: "done" }));
  for (let i = 0; i < 210; i++) {
    const j = jobs.create({
      kind: "command",
      principal: owner,
      targetDeviceId: "synthetic",
      title: `Question ${i}`,
    });
    await jobs.run(j.id, async () => ({ ok: true, note: "done" }));
  }
  const stop = connectCrmToHub(root, { jobs: () => jobs, role: () => "pc", retryMs: 20 });
  try {
    await new Promise((r) => setTimeout(r, 300));
    expect(
      crmRuntime(root)
        .store.snapshot()
        .activities.filter((a) => a.eventId === `${old.id}:result`),
    ).toHaveLength(1);
  } finally {
    stop();
  }
}, 60_000);
