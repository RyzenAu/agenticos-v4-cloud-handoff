// Review T5 should-fix: an excluded lead with a due follow-up inflated the Leads overview ("8 calls
// to make today"), the To do list and Today's "Follow-ups due today" while the call queue said 5.
// dayReport (the one source of those counts) now leaves excluded leads out. SYNTHETIC CRM only.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayReport, findLead, logActivity, openCrm, upsertLead } from "./crm";

test("an excluded lead is never a due follow-up", () => {
  const db = openCrm(join(mkdtempSync(join(tmpdir(), "crm-excl-")), "crm.sqlite"));
  const base = { vertical: "dental" as const, area: "Mount Druitt NSW", address: "", website: "", mapsUrl: "", rating: null, reviews: null,
    emails: [], emailOk: false, score: 60, pitch: "website" as const, reasons: [], googleAt: null };
  upsertLead(db, { ...base, placeId: "p1", name: "Synthetic Open Dental", phone: "(02) 9000 0001" });
  upsertLead(db, { ...base, placeId: "p2", name: "Synthetic Excluded Clinic", phone: "(02) 9000 0002", excluded: true, excludedReason: "government" } as never);
  const past = new Date(Date.now() - 3_600_000).toISOString();
  logActivity(db, findLead(db, "p1")!, { kind: "call", outcome: "call_back", by: "usman", nextAt: past });
  logActivity(db, findLead(db, "p2")!, { kind: "call", outcome: "call_back", by: "usman", nextAt: past });
  const due = dayReport(db, null).followUpsDue.map((l: { name: string }) => l.name);
  expect(due).toEqual(["Synthetic Open Dental"]);
});

test("the server refuses a follow-up dated before today (Sydney), like the drawer", async () => {
  const { validateLogBody } = await import("./api");
  const now = new Date("2026-09-28T02:00:00Z"); // 12 pm Sydney
  const body = (next: string) => ({ lead: "1", outcome: "call_back", kind: "call", next, by: "usman" });
  expect(() => validateLogBody(body("2020-01-01"), now)).toThrow("in the past");
  expect(() => validateLogBody(body("2026-09-27T09:00:00+10:00"), now)).toThrow("in the past");
  expect(validateLogBody(body("2026-09-28T09:00:00+10:00"), now).next).toBe("2026-09-27T23:00:00.000Z");
  expect(validateLogBody(body("2026-10-02"), now).next).not.toBeNull();
});
