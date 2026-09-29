import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, upsertLead } from "./crm";
import { findDuplicateLeads, mergeDuplicates } from "./dedupe";

const base = {
  vertical: "dental" as const, area: "Mount Druitt NSW", mapsUrl: "", rating: null, reviews: null,
  emails: [] as string[], emailOk: false, score: 35, pitch: "website" as const, reasons: [], googleAt: null,
  source: "osm" as const, attribution: "© OpenStreetMap contributors",
};

function withDb<T>(fn: (db: ReturnType<typeof openCrm>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "crm-dedupe-"));
  const db = openCrm(join(dir, "crm.sqlite"));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("dedupe: the St Clair Dental / St Clair Family Dental bug", () => {
  test("two OSM rows discovered to the same domain are detected as one duplicate group", () =>
    withDb((db) => {
      upsertLead(db, { ...base, placeId: "osm:node/1", name: "St Clair Dental", phone: "", address: "", website: "https://stclairfamilydental.com.au/" });
      upsertLead(db, { ...base, placeId: "osm:node/2", name: "St Clair Family Dental", phone: "0299991234", address: "12 Main St, St Clair", website: "https://www.stclairfamilydental.com.au/" });
      upsertLead(db, { ...base, placeId: "osm:node/3", name: "Unrelated Dental", phone: "0299999999", address: "", website: "https://unrelated-dental.com.au/" });

      const groups = findDuplicateLeads(db);
      expect(groups).toHaveLength(1);
      expect(groups[0].matchedBy).toBe("domain");
      expect(groups[0].leads.map((l) => l.name).sort()).toEqual(["St Clair Dental", "St Clair Family Dental"]);
    }));

  test("merging keeps the richer record's phone/address and marks the other excluded, never deleting it", () =>
    withDb((db) => {
      const thin = upsertLead(db, { ...base, placeId: "osm:node/1", name: "St Clair Dental", phone: "", address: "", website: "https://stclairfamilydental.com.au/" });
      const rich = upsertLead(db, { ...base, placeId: "osm:node/2", name: "St Clair Family Dental", phone: "0299991234", address: "12 Main St, St Clair", website: "https://www.stclairfamilydental.com.au/" });

      const results = mergeDuplicates(db);
      expect(results).toHaveLength(1);
      expect(results[0].keepId).toBe(rich.id); // the richer record (has phone + address) is kept
      expect(results[0].mergedIds).toEqual([thin.id]);

      const kept = findLead(db, rich.id)!;
      expect(kept.phone).toBe("0299991234");
      expect(kept.address).toBe("12 Main St, St Clair");
      expect(kept.excluded).toBe(false);

      const merged = findLead(db, thin.id)!;
      expect(merged.excluded).toBe(true);
      expect(merged.mergedInto).toBe(rich.id);
      expect(merged.excludedReason).toMatch(new RegExp(`duplicate of #${rich.id}`));
      // The merged row is kept on file, not deleted.
      expect(merged.name).toBe("St Clair Dental");
    }));

  test("detects a duplicate by phone when the domains don't match (or aren't known yet)", () =>
    withDb((db) => {
      const a = upsertLead(db, { ...base, placeId: "osm:node/1", name: "Smile Dental", phone: "(02) 9621 1234", address: "", website: "" });
      const b = upsertLead(db, { ...base, placeId: "osm:node/2", name: "Smile Dental Practice", phone: "02 9621 1234", address: "1 High St", website: "" });
      const groups = findDuplicateLeads(db);
      expect(groups).toHaveLength(1);
      expect(groups[0].matchedBy).toBe("phone");
      expect(groups[0].leads.map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
    }));

  test("mergeDuplicates is a no-op when nothing matches", () =>
    withDb((db) => {
      upsertLead(db, { ...base, placeId: "osm:node/1", name: "A Dental", phone: "0299990001", address: "", website: "https://a-dental.com.au/" });
      upsertLead(db, { ...base, placeId: "osm:node/2", name: "B Dental", phone: "0299990002", address: "", website: "https://b-dental.com.au/" });
      expect(mergeDuplicates(db)).toEqual([]);
    }));
});
