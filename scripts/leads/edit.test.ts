import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeadsApi } from "./api";
import { openCrm, upsertLead, activities, findLead } from "./crm";
import { editLead, leadArtifactCurrent, leadEditVersion } from "./edit";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lead-edit-synthetic-"));
  const db = openCrm(join(root, "crm.sqlite"));
  const lead = upsertLead(db, { source: "osm", placeId: "manual:sample", vertical: "dental", area: "Sample NSW", name: "Sample Dental", phone: "0299990000", address: "Sample Road", website: "https://sample.example.invalid", mapsUrl: "", rating: null, reviews: null, emails: ["team@example.invalid"], emailOk: true, score: 80, pitch: "both", reasons: ["Synthetic issue"], googleAt: null });
  return { root, db, lead };
}
describe("persisted lead editing", () => {
  test("real API saves contact, assignment and follow-up; database reopen keeps them", async () => {
    const { root, db, lead } = fixture();
    const api = createLeadsApi(root, { db, placesLookup: null });
    try {
      const detail = await api.handle("/leads/detail", "GET", {}, new URLSearchParams({ id: String(lead.id) }), false);
      const result = await api.handle("/leads/edit", "POST", { lead: lead.id, version: detail.lead.editVersion, by: "mehroz", name: "Sample Updated", phone: "0299990001", emails: ["manager@example.invalid"], owner: "mehroz", status: "call_back", nextAt: "2026-10-10T01:00:00Z" }, new URLSearchParams(), false);
      expect(result.lead).toMatchObject({ name: "Sample Updated", owner: "mehroz", status: "call_back", lastContactAt: null, nextAt: "2026-10-10T01:00:00.000Z" });
      expect(result.lead.editVersion).not.toBe(detail.lead.editVersion);
      expect(activities(db, lead.id)[0]).toMatchObject({ kind: "lead_edit", by: "mehroz", outcome: "" });
    } finally { api.close(); }
    const reopened = openCrm(join(root, "crm.sqlite"));
    try { expect(findLead(reopened, lead.id)).toMatchObject({ name: "Sample Updated", phone: "0299990001", emails: ["manager@example.invalid"], owner: "mehroz", status: "call_back" }); } finally { reopened.close(); }
  });
  test("stale editor cannot overwrite a newer edit", () => {
    const { db, lead } = fixture();
    try {
      const version = leadEditVersion(lead);
      editLead(db, lead.id, { by: "usman", version, name: "First update" });
      expect(() => editLead(db, lead.id, { by: "mehroz", version, name: "Stale update" })).toThrow("changed while you were editing");
      expect(findLead(db, lead.id)?.name).toBe("First update");
    } finally { db.close(); }
  });
  test("invalid edits leave the entire row unchanged", () => {
    const { db, lead } = fixture();
    try {
      for (const patch of [{ name: "" }, { emails: ["bad"] }, { website: "javascript:alert(1)" }, { website: "https://user:secret@example.invalid" }, { status: "made-up" }, { owner: "someone" }, { nextAt: "tomorrow" }, { status: "call_back", nextAt: null }, { excluded: false }]) {
        expect(() => editLead(db, lead.id, { by: "usman", version: leadEditVersion(lead), ...patch })).toThrow();
        expect(findLead(db, lead.id)).toEqual(lead);
      }
    } finally { db.close(); }
  });
  test("contact corrections preserve opt-outs and never imply outreach permission", () => {
    const { db, lead } = fixture();
    try {
      db.query("UPDATE leads SET status = 'do_not_contact', email_ok = 0 WHERE id = ?").run(lead.id);
      const blocked = findLead(db, lead.id)!;
      expect(() => editLead(db, lead.id, { by: "usman", version: leadEditVersion(blocked), status: "new" })).toThrow("opt-out stays");
      const updated = editLead(db, lead.id, { by: "usman", version: leadEditVersion(blocked), emails: ["new@example.invalid"] });
      expect(updated.status).toBe("do_not_contact"); expect(updated.emailOk).toBe(false);
      expect(db.query("SELECT value FROM optouts WHERE value = ?").get("new@example.invalid")).not.toBeNull();
    } finally { db.close(); }
  });
  test("assignment doesn't copy ephemeral Places display fields into storage", () => {
    const { db, lead } = fixture();
    try {
      db.query("UPDATE leads SET source = 'google', name = '', phone = '', address = '', website = '' WHERE id = ?").run(lead.id);
      const stored = findLead(db, lead.id)!;
      const updated = editLead(db, lead.id, { by: "usman", version: leadEditVersion(stored), owner: "mehroz" });
      expect(updated).toMatchObject({ name: "", phone: "", address: "", website: "", owner: "mehroz" });
    } finally { db.close(); }
  });
  test("website correction retires outdated evidence without deleting files or contact history", () => {
    const { db, lead } = fixture();
    try {
      const updated = editLead(db, lead.id, { by: "usman", version: leadEditVersion(lead), website: "https://new.example.invalid" });
      expect(updated).toMatchObject({ score: 0, pitch: "audit_pending", reasons: [], websiteSource: "manual" });
      expect(leadArtifactCurrent(db, lead.id, "2020-01-01T00:00:00Z", true)).toBe(false);
      expect(leadArtifactCurrent(db, lead.id, "2099-01-01T00:00:00Z", true)).toBe(true);
      expect(updated.lastContactAt).toBeNull();
    } finally { db.close(); }
  });
  test("later directory refresh preserves the founder's correction", () => {
    const { db, lead } = fixture();
    try {
      editLead(db, lead.id, { by: "usman", version: leadEditVersion(lead), name: "Corrected business", website: "https://correct.example.invalid" });
      const { id, createdAt, status, owner, nextAt, lastContactAt, ...input } = lead;
      const refreshed = upsertLead(db, { ...input, name: "Old directory name", website: "https://old.example.invalid", fieldSources: { name: "osm", website: "osm" } });
      expect(refreshed).toMatchObject({ name: "Corrected business", website: "https://correct.example.invalid", websiteSource: "manual", pitch: "audit_pending", score: 0 });
      expect(refreshed.fieldSources?.name).toBe("manual");
    } finally { db.close(); }
  });
});
