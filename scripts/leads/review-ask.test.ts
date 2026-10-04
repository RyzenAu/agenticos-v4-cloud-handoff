import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, recordWin, setMilestone, upsertLead } from "./crm";
import { reviewAskQueue, renderReviewAsk } from "./review-ask";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "review-ask-"));
  const db = openCrm(join(dir, "crm.sqlite"));
  return { dir, db };
}

function seedWonLead(db: ReturnType<typeof openCrm>, placeId: string, name: string, deployedDaysAgo: number | null, asked = false) {
  upsertLead(db, {
    placeId, vertical: "dental", area: "Mount Druitt NSW", name, phone: "(02) 9621 1234",
    address: "1 Main St", website: "http://example.com.au", mapsUrl: "", rating: 4.5, reviews: 10,
    emails: ["hi@example.com.au"], emailOk: true, score: 90, pitch: "website",
    reasons: [], googleAt: null, source: "osm", attribution: "© OpenStreetMap contributors",
  });
  const lead = findLead(db, placeId)!;
  recordWin(db, lead, { scope: "website rebuild", by: "usman" });
  if (deployedDaysAgo !== null) {
    const date = new Date(Date.now() - deployedDaysAgo * 86_400_000).toISOString().slice(0, 10);
    setMilestone(db, lead.id, "Deployed", { state: "done", completedAt: date, by: "usman" });
  }
  if (asked) setMilestone(db, lead.id, "Review/referral asked", { state: "done", by: "usman" });
  return findLead(db, placeId)!;
}

describe("reviewAskQueue", () => {
  test("is empty when Deployed isn't done yet", () => {
    const { db } = setup();
    seedWonLead(db, "osm:node/1", "Not Deployed Yet", null);
    expect(reviewAskQueue(db).length).toBe(0);
  });

  test("is empty when Deployed was less than 14 days ago", () => {
    const { db } = setup();
    seedWonLead(db, "osm:node/2", "Recently Deployed", 3);
    expect(reviewAskQueue(db).length).toBe(0);
  });

  test("includes a lead deployed 14+ days ago with the ask still pending", () => {
    const { db } = setup();
    seedWonLead(db, "osm:node/3", "Overdue Ask Dental", 20);
    const queue = reviewAskQueue(db);
    expect(queue.length).toBe(1);
    expect(queue[0].name).toBe("Overdue Ask Dental");
    expect(queue[0].daysSinceDeployed).toBeGreaterThanOrEqual(19);
    expect(queue[0].draft.channel).toBe("email");
  });

  test("excludes a lead whose ask has already been sent", () => {
    const { db } = setup();
    seedWonLead(db, "osm:node/4", "Already Asked Dental", 30, true);
    expect(reviewAskQueue(db).length).toBe(0);
  });

  test("falls back to a call draft when there's no usable email", () => {
    const { db } = setup();
    upsertLead(db, {
      placeId: "osm:node/5", vertical: "dental", area: "Mount Druitt NSW", name: "No Email Dental", phone: "(02) 9000 0000",
      address: "1 Main St", website: "http://example.com.au", mapsUrl: "", rating: 4, reviews: 5,
      emails: [], emailOk: false, score: 80, pitch: "website",
      reasons: [], googleAt: null, source: "osm", attribution: "© OpenStreetMap contributors",
    });
    const lead = findLead(db, "osm:node/5")!;
    recordWin(db, lead, { scope: "website rebuild", by: "usman" });
    setMilestone(db, lead.id, "Deployed", { state: "done", completedAt: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10), by: "usman" });
    const queue = reviewAskQueue(db);
    expect(queue.length).toBe(1);
    expect(queue[0].draft.channel).toBe("call");
  });

  test("renderReviewAsk names the milestone command to close it", () => {
    const { db } = setup();
    seedWonLead(db, "osm:node/6", "Render Test Dental", 25);
    const text = renderReviewAsk(reviewAskQueue(db)[0]);
    expect(text).toContain("REVIEW/REFERRAL ASK DUE");
    expect(text).toContain('milestone 1 "Review/referral asked" --state done'.replace("1", String(reviewAskQueue(db)[0].leadId)));
  });
});
