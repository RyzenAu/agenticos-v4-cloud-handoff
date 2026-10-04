import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm } from "../leads/crm";
import {
  dryRunMigration,
  migrateCrm,
  rollbackCrm,
  schemaVersion,
  synchroniseLegacy,
} from "./migrations";
import { migrationMain } from "./migrate";
const dbs: Database[] = [],
  dirs: string[] = [];
function fixture(file = ":memory:") {
  const db = openCrm(file);
  dbs.push(db);
  db.exec(`INSERT INTO leads(id,place_id,vertical,source,name,owner,status,next_at,field_sources) VALUES(7,'osm:node/7','dental','osm','Synthetic Clinic','usman','proposal','2026-10-06T00:00:00Z','{"name":"manual"}');
  INSERT INTO leads(id,place_id,vertical,source,name,excluded,excluded_reason,merged_into,status) VALUES(9,'osm:node/9','dental','osm','Duplicate',1,'duplicate of #7',7,'lost');
  INSERT INTO leads(id,place_id,vertical,source,name,phone,field_sources,status) VALUES(11,'google-11','dental','google','Transient','0299991111','{}','do_not_contact');
  INSERT INTO lead_deals(lead_id,setup_cents,monthly_cents,probability,expected_close,contact_pref) VALUES(7,180000,12000,0.65,'2026-10-15','Email only');
  INSERT INTO activities(id,lead_id,kind,outcome,note,by) VALUES(2,7,'meeting','proposal','Agreed synthetic scope','mehroz');
  INSERT INTO activity_events(event_id,activity_id,lead_id) VALUES('meeting:synthetic',2,7);
  INSERT INTO kickoffs(lead_id,scope,checklist,by) VALUES(7,'Original scope','{"intake":["Confirm content"],"assets":["Logo"],"access":["DNS approval"],"milestones":[{"name":"Build","state":"partial","note":"Started"}]}','usman');
  INSERT INTO optouts(value) VALUES('0299991111');
  INSERT INTO phone_findings(lead_id,checked_at,outcome,reason,sources) VALUES(7,'2026-10-01','found','Website evidence','["https://synthetic.example"]');`);
  return db;
}
const original = (db: Database) =>
  Object.fromEntries(
    [
      "leads",
      "activities",
      "activity_events",
      "lead_deals",
      "kickoffs",
      "optouts",
      "phone_findings",
    ].map((t) => [t, db.query(`SELECT * FROM ${t}`).all()]),
  );
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("versioned additive CRM migration", () => {
  test("dry run writes nothing and reports counts, source omissions, duplicate references", () => {
    const db = fixture();
    const before = JSON.stringify(db.query("SELECT * FROM sqlite_master").all());
    const originals = original(db);
    const report = dryRunMigration(db);
    expect(report.applied).toBe(false);
    expect(report.counts).toMatchObject({
      leads: 3,
      activities: 1,
      followUps: 1,
      kickoffs: 1,
      duplicates: 1,
      optouts: 1,
    });
    expect(report.relationships).toEqual({
      orphanActivities: 0,
      orphanDeals: 0,
      orphanKickoffs: 0,
      danglingDuplicates: 0,
    });
    expect(
      report.ambiguities.some((a) => a.leadId === 11 && a.code === "transient-fields-omitted"),
    ).toBe(true);
    expect(JSON.stringify(db.query("SELECT * FROM sqlite_master").all())).toBe(before);
    expect(original(db)).toEqual(originals);
  });
  test("migration and repeated sync preserve every original row and relation", () => {
    const db = fixture();
    const originals = original(db);
    const report = migrateCrm(db);
    expect(report.applied).toBe(true);
    expect(schemaVersion(db)).toBe(1);
    expect(migrateCrm(db).applied).toBe(false);
    synchroniseLegacy(db);
    expect(original(db)).toEqual(originals);
    const decode = (table: string, id: string) =>
      JSON.parse(
        (db.query(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string }).data,
      );
    expect(decode("crm_deals", "legacy-deal-7")).toMatchObject({
      oneOffCents: 180000,
      recurringCents: 12000,
      probability: 0.65,
      expectedClose: "2026-10-15",
      gstTreatment: "exclusive",
    });
    expect(decode("crm_companies", "legacy-company-9")).toMatchObject({
      status: "prospect",
      mergedInto: "legacy-company-7",
      excluded: true,
    });
    expect(decode("crm_companies", "legacy-company-11")).toMatchObject({
      name: "",
      phone: "",
      doNotContact: true,
    });
    expect(decode("crm_projects", "legacy-project-7").milestones[0]).toMatchObject({
      name: "Build",
      status: "in-progress",
      note: "Started",
    });
    expect(db.query("SELECT COUNT(*) AS n FROM crm_activities").get()).toEqual({ n: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  test("rollback on disposable copy removes all feature tables and permits a clean reapply", () => {
    const db = fixture();
    const originals = original(db);
    migrateCrm(db);
    db.exec(
      "INSERT INTO crm_automation_rules(id) VALUES('test'); INSERT INTO crm_csv_previews(id,data,created_at) VALUES('preview','{}','2026-10-02')",
    );
    expect(() => rollbackCrm(db, {} as any)).toThrow("disposable");
    rollbackCrm(db, { disposable: true, acknowledgeDataLoss: true });
    expect(schemaVersion(db)).toBe(0);
    expect(original(db)).toEqual(originals);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name='crm_automation_rules'").get(),
    ).toBeNull();
    migrateCrm(db);
    expect(original(db)).toEqual(originals);
  });
  test("unknown future schema is refused", () => {
    const db = fixture();
    migrateCrm(db);
    db.exec(
      "INSERT INTO crm_schema_migrations(version,applied_at,report) VALUES(999,'2026-10-02','{}')",
    );
    expect(() => migrateCrm(db)).toThrow("newer version");
  });
  test("migration CLI requires a verified new backup and restoration preserves baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-migration-"));
    dirs.push(dir);
    const file = join(dir, "crm.sqlite"),
      backup = join(dir, "backup.sqlite");
    const db = fixture(file),
      before = original(db);
    expect(() => migrationMain(["--db", file, "--apply"])).toThrow("backup");
    expect(schemaVersion(db)).toBe(0);
    migrationMain(["--db", file, "--apply", "--backup", backup]);
    expect(existsSync(backup)).toBe(true);
    const restored = new Database(backup, { readonly: true });
    dbs.push(restored);
    expect(original(restored)).toEqual(before);
    expect(schemaVersion(restored)).toBe(0);
    expect(schemaVersion(db)).toBe(1);
    expect(() => migrationMain(["--db", file, "--apply", "--backup", backup])).toThrow(
      "never overwritten",
    );
  });
});

describe("migration failure safety", () => {
  test("orphan legacy rows fail apply before creating schema while dry run explains them", () => {
    const db = fixture();
    db.query("INSERT INTO activities(lead_id,kind,note) VALUES(999,'note','Orphan')").run();
    expect(dryRunMigration(db).relationships.orphanActivities).toBe(1);
    expect(() => migrateCrm(db)).toThrow("relationships need review");
    expect(schemaVersion(db)).toBe(0);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name='crm_companies'").get()).toBeNull();
  });
});

describe("legacy duplicate ordering", () => {
  test("forward duplicate target canonicalises all related imported rows", () => {
    const db = openCrm(":memory:");
    dbs.push(db);
    db.exec(
      `INSERT INTO leads(id,place_id,vertical,source,name,excluded,merged_into,next_at) VALUES(1,'osm:node/1','dental','osm','Duplicate first',1,2,'2026-10-10T00:00:00Z'),(2,'osm:node/2','dental','osm','Keeper later',0,NULL,NULL); INSERT INTO activities(lead_id,kind,note) VALUES(1,'note','Original duplicate history'); INSERT INTO kickoffs(lead_id,scope,checklist) VALUES(1,'Scope','{"milestones":[]}')`,
    );
    migrateCrm(db);
    for (const [table, id] of [
      ["crm_deals", "legacy-deal-1"],
      ["crm_tasks", "legacy-followup-1"],
      ["crm_projects", "legacy-project-1"],
    ]) {
      const row = db.query(`SELECT company_id,data FROM ${table} WHERE id=?`).get(id) as {
        company_id: string;
        data: string;
      };
      expect(row.company_id).toBe("legacy-company-2");
      expect(JSON.parse(row.data).companyId).toBe("legacy-company-2");
    }
    expect(db.query("SELECT company_id FROM crm_activities").get()).toEqual({
      company_id: "legacy-company-2",
    });
    synchroniseLegacy(db);
    expect(db.query("SELECT company_id FROM crm_deals WHERE id='legacy-deal-1'").get()).toEqual({
      company_id: "legacy-company-2",
    });
  });
});

describe("preserved migration details", () => {
  test("invalid original followup is retained as a reviewable undated task", () => {
    const db = fixture();
    db.query("UPDATE leads SET next_at='not-a-date' WHERE id=7").run();
    expect(dryRunMigration(db).ambiguities.some((a) => a.code === "invalid-follow-up-date")).toBe(
      true,
    );
    const result = migrateCrm(db);
    expect(result.validation?.tasks).toBe(1);
    const task = JSON.parse(
      (
        db.query("SELECT data FROM crm_tasks WHERE id='legacy-followup-7'").get() as {
          data: string;
        }
      ).data,
    );
    expect(task.dueAt).toBeNull();
    expect(task.description).toContain("not-a-date");
  });
  test("known stage outcome history is imported in original event order", () => {
    const db = fixture();
    db.query(
      "INSERT INTO activities(lead_id,at,kind,outcome,note) VALUES(7,'2026-09-28T00:00:00Z','call','interested','Qualified')",
    ).run();
    migrateCrm(db);
    const d = JSON.parse(
      (db.query("SELECT data FROM crm_deals WHERE id='legacy-deal-7'").get() as { data: string })
        .data,
    );
    expect(d.stageHistory.map((h: any) => h.stageId)).toEqual(["qualified", "proposal"]);
    expect(d.stageHistory[0].at).toBe("2026-09-28T00:00:00Z");
  });
});

test("runtime migration writes and verifies a consistent pre-upgrade backup once", async () => {
  const { openCrmStore } = await import("./store");
  const { crmPath } = await import("../leads/crm");
  const prior = process.env.MU_DATA_DIR,
    dir = mkdtempSync(join(tmpdir(), "crm-runtime-backup-"));
  dirs.push(dir);
  process.env.MU_DATA_DIR = dir;
  try {
    const file = crmPath(dir),
      db = fixture(file),
      before = original(db);
    const s = openCrmStore(dir);
    const report = JSON.parse(
      (
        s.db.query("SELECT report FROM crm_schema_migrations WHERE version=1").get() as {
          report: string;
        }
      ).report,
    );
    expect(report.backupPath).toBeTruthy();
    const backup = new Database(report.backupPath, { readonly: true });
    dbs.push(backup);
    expect(original(backup)).toEqual(before);
    expect(schemaVersion(backup)).toBe(0);
    s.close();
    const again = openCrmStore(dir);
    expect(
      JSON.parse(
        (
          again.db.query("SELECT report FROM crm_schema_migrations WHERE version=1").get() as {
            report: string;
          }
        ).report,
      ).backupPath,
    ).toBe(report.backupPath);
    again.close();
  } finally {
    if (prior === undefined) delete process.env.MU_DATA_DIR;
    else process.env.MU_DATA_DIR = prior;
  }
});
