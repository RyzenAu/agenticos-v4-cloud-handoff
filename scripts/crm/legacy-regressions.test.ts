import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead, findLead, logActivity } from "../leads/crm";
import { monthChanges } from "../leads/care-plan";
import { sydneyFollowupAt } from "../meeting-mode/crm-sync";
const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), "crm-legacy-regression-"));
  roots.push(p);
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
test("a note preserves the existing promise; a completed contact can clear it", () => {
  const db = openCrm(join(root(), "crm.sqlite"));
  try {
    upsertLead(db, {
      placeId: "osm:node/42",
      source: "osm",
      attribution: "Synthetic fixture",
      vertical: "dental",
      area: "Sydney",
      name: "Synthetic Clinic",
      phone: "",
      address: "",
      website: "",
      mapsUrl: "",
      rating: null,
      reviews: null,
      emails: [],
      emailOk: false,
      score: 0,
      pitch: "website",
      reasons: [],
      googleAt: null,
    });
    let lead = findLead(db, "osm:node/42")!;
    lead = logActivity(db, lead, { kind: "call", nextAt: "2026-11-02T22:00:00.000Z", by: "usman" });
    lead = logActivity(db, lead, {
      kind: "note",
      note: "Updated scope",
      nextAt: null,
      by: "mehroz",
    });
    expect(lead.nextAt).toBe("2026-11-02T22:00:00.000Z");
    lead = logActivity(db, lead, {
      kind: "call",
      outcome: "interested",
      nextAt: null,
      by: "mehroz",
    });
    expect(lead.nextAt).toBeNull();
  } finally {
    db.close();
  }
});
test("monthly care plans keep undated notes without claiming another month's dated work", () => {
  const r = root(),
    dir = join(r, ".operator-data", "care-plan", "synthetic");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "CHANGES.md"),
    "- [2026-09-03] September repair\n- [2026-10] October launch\n- Founder note without date\n",
  );
  expect(monthChanges(r, "synthetic", "2026-10").items).toEqual([
    "[2026-10] October launch",
    "Founder note without date",
  ]);
});
test("meeting follow-ups observe Sydney daylight savings and reject impossible dates", () => {
  expect(sydneyFollowupAt("2026-07-03")).toBe("2026-07-02T23:00:00.000Z");
  expect(sydneyFollowupAt("2026-12-03")).toBe("2026-12-02T22:00:00.000Z");
  expect(sydneyFollowupAt("2026-10-04")).toBe("2026-10-03T22:00:00.000Z");
  expect(() => sydneyFollowupAt("2026-02-30")).toThrow();
});
