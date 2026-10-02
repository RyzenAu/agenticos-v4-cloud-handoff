import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { CrmStore } from "./store";
import { JobService } from "../jobs/service";
import { openCrm } from "../leads/crm";

async function simultaneous(mode: string, file: string, barrier: string, id = "") {
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn(
      [process.execPath, join(import.meta.dir, "concurrency-worker.ts"), mode, file, barrier, id],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off" },
      },
    ),
  );
  const until = Date.now() + 5000;
  while (
    readdirSync(dirname(barrier)).filter(
      (p) => p.startsWith(`${basename(barrier)}.`) && p.endsWith(".ready"),
    ).length < children.length
  ) {
    if (Date.now() > until) {
      children.forEach((p) => p.kill());
      throw new Error("Synthetic workers did not reach their barrier.");
    }
    await Bun.sleep(5);
  }
  writeFileSync(barrier, "synthetic-start");
  return Promise.all(
    children.map(async (p) => {
      const [output, error, exit] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(exit, error).toBe(0);
      return JSON.parse(output) as {
        ok: boolean;
        result?: string | number;
        code?: string;
        error?: string;
      };
    }),
  );
}
test("concurrent fresh migrations preserve original records and create one schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-concurrent-migration-")),
    file = join(dir, "crm.sqlite");
  try {
    const legacy = openCrm(file);
    legacy.exec(
      "INSERT INTO leads(place_id,vertical,source,name) VALUES('osm:node/77','dental','osm','Synthetic preserved lead')",
    );
    const before = legacy.query("SELECT * FROM leads").all();
    legacy.close();
    const results = await simultaneous("migration", file, join(dir, "start"));
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    const db = new Database(file);
    expect(db.query("SELECT * FROM leads").all()).toEqual(before);
    expect(
      (db.query("SELECT COUNT(*) n FROM crm_schema_migrations").get() as { n: number }).n,
    ).toBe(1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
test("concurrent activity retries commit one event and stale edits conflict rather than overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-concurrent-retry-")),
    file = join(dir, "crm.sqlite");
  try {
    const db = new Database(file);
    db.exec("PRAGMA journal_mode=WAL");
    const store = new CrmStore(db);
    const company = store.createCompany(
      { name: "Synthetic concurrent company" },
      { personId: "usman" },
    );
    const results = await simultaneous("activity", file, join(dir, "activity-start"), company.id);
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    expect(new Set(results.map((r) => r.result)).size).toBe(1);
    expect(store.snapshot().activities).toHaveLength(1);
    const edits = await simultaneous("update", file, join(dir, "update-start"), company.id);
    expect(edits.filter((r) => r.ok)).toHaveLength(1);
    expect(
      edits.filter((r) => !r.ok).every((r) => r.code === "conflict"),
      JSON.stringify(edits),
    ).toBe(true);
    expect(store.getCompany(company.id)?.version).toBe(2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("concurrent automation retries share one durable job and one enquiry action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-concurrent-automation-")),
    file = join(dir, "crm.sqlite");
  try {
    const db = new Database(file);
    db.exec("PRAGMA journal_mode=WAL");
    const store = new CrmStore(db);
    const jobs = new JobService({ path: join(dir, "jobs.sqlite") });
    const results = await simultaneous("automation", file, join(dir, "start"));
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    const snapshot = store.snapshot();
    expect(snapshot.companies).toHaveLength(1);
    expect(snapshot.contacts).toHaveLength(1);
    expect(snapshot.activities).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(jobs.list({ kind: "trigger" })).toHaveLength(1);
    expect(jobs.list({ kind: "trigger" })[0].state).toBe("succeeded");
    jobs.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
