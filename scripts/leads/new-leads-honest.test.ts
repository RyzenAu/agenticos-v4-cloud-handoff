// L1b (29 Sep 2026): "new this week" must be measured. The live CRM's 963 leads were all inserted in one
// OSM load on 24 Sep, so "824 new this week" equalled the open total: a bulk-import date, not inflow.
// The count is only a number when the CRM has history older than the window; otherwise it is null with a reason.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead } from "./crm";
import { crmOverview } from "./deals";
import { projectPipeline } from "../workspace/projections";

const NOW = new Date("2026-09-29T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function withCrm(run: (root: string, db: Database) => void) {
  const root = mkdtempSync(join(tmpdir(), "newleads-"));
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  try { run(root, db); } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
let n = 0;
const add = (db: Database, createdAt: string) => {
  const lead = upsertLead(db, {
    placeId: `osm:node/${++n}`, source: "osm", attribution: "© OpenStreetMap contributors", vertical: "dental", area: "Blacktown NSW", name: `Clinic ${n}`,
    phone: "", address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 50, pitch: "website", reasons: [], googleAt: null,
  });
  db.query("UPDATE leads SET created_at = ? WHERE id = ?").run(createdAt, lead.id);
  return lead;
};

describe("new leads this week are measured, never a first-load count", () => {
  test("every lead added inside the window (a first bulk load): unknown, with the reason", () => {
    withCrm((root, db) => {
      for (let i = 0; i < 5; i++) add(db, daysAgo(5));
      const t = crmOverview(root, db, { now: NOW, receivables: [] }).tiles.newLeads;
      expect(t.count).toBeNull();
      expect(t.note).toContain("CRM began 2026-09-24");
    });
  });
  test("with history older than the window, only leads created in the last 7 days count", () => {
    withCrm((root, db) => {
      add(db, daysAgo(40));
      add(db, daysAgo(20));
      add(db, daysAgo(6));
      add(db, daysAgo(1));
      const t = crmOverview(root, db, { now: NOW, receivables: [] }).tiles.newLeads;
      expect(t.count).toBe(2);
      expect(t.note ?? null).toBeNull();
    });
  });
  test("an empty CRM really has zero new leads", () => {
    withCrm((root, db) => {
      expect(crmOverview(root, db, { now: NOW, receivables: [] }).tiles.newLeads.count).toBe(0);
    });
  });
  test("the workspace projection passes null and the reason through instead of inventing a number", () => {
    const p = projectPipeline({ summary: { total: 5, open: 5 }, statusCounts: null, overview: { tiles: { newLeads: { count: null, note: "CRM began 2026-09-24: its first load isn't \"new\"." } } } });
    expect(p.newLeads7d).toBeNull();
    expect(p.newLeads7dNote).toContain("first load");
    expect(projectPipeline({ summary: null, statusCounts: null, overview: { tiles: { newLeads: { count: 3 } } } }).newLeads7d).toBe(3);
  });
});
