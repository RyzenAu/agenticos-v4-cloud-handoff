import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callList, dayReport, findLead, goal, isOptedOut, logActivity, openCrm, setGoal, upsertLead, usage } from "./crm";
import { purgeGoogleCache } from "./places-cleanup";
import { findLeads } from "./engine";
import { callWindow, emailDraft } from "./outreach";
import { limitedHours, scoreLead } from "./score";
import { analyseHtml, extractEmails, publicUrl } from "./site-audit";

const SITE = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><a href="mailto:reception@smiledental.com.au">Email us</a> Call (02) 9621 1234
<footer>© 2019 Smile Dental</footer></body></html>`;

function fakeFetch(calls: string[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    if (url.endsWith(":searchText")) {
      expect((init?.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("places.id,nextPageToken");
      return json({ places: [{ id: "ChIJaaaaaaaaaaaa" }, { id: "ChIJbbbbbbbbbbbb" }, { id: "ChIJcccccccccccc" }] });
    }
    if (url.includes("/v1/places/ChIJaaaaaaaaaaaa"))
      return json({ displayName: { text: "Smile Dental" }, nationalPhoneNumber: "(02) 9621 1234", websiteUri: "http://smiledental.com.au/",
        businessStatus: "OPERATIONAL", rating: 4.8, userRatingCount: 25, regularOpeningHours: { weekdayDescriptions: ["Monday: 9:00 AM – 5:00 PM", "Saturday: Closed", "Sunday: Closed"] } });
    if (url.includes("/v1/places/ChIJbbbbbbbbbbbb"))
      return json({ displayName: { text: "No Site Dental" }, nationalPhoneNumber: "(02) 9000 0000", businessStatus: "OPERATIONAL" });
    if (url.includes("/v1/places/ChIJcccccccccccc")) return json({ displayName: { text: "Gone Dental" }, businessStatus: "CLOSED_PERMANENTLY" });
    if (url.startsWith("http://smiledental.com.au")) return new Response(SITE, { headers: { "Content-Type": "text/html" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("lead engine", () => {
  test("find: free search, details only for new IDs, closed skipped, budget counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      const calls: string[] = [];
      const first = await findLeads(db, { vertical: "dental", area: "Mount Druitt NSW", source: "google", key: "test", request: fakeFetch(calls) });
      // Smile Dental: no HTTPS (severe, redesign-worthy), no online booking (receptionist gap),
      // © 2019. 27 Sep 2026 (Places terms): Google's hours, rating and review count no longer feed
      // the stored score, so it's severity 60 + 15 (no booking) = 75 (was 80 with +5 for reviews).
      // 25 Sep 2026 (issues.ts): a directory with no URL is no longer proof of "no website" —
      // "No Site Dental" is audit_pending (score 0) until a discovery pass actually looks.
      // `added` is display-only: names come from this run's in-memory details, with attribution.
      expect(first.added.map((l) => [l.name, l.score, l.pitch])).toEqual([["Smile Dental", 75, "both"], ["No Site Dental", 0, "audit_pending"]]);
      expect(first.added.every((l) => l.placesLive?.attribution === "Google Maps")).toBe(true);
      expect(first.skippedClosed).toBe(1);
      // The CRM row keeps the place ID and our own findings only — nothing from Place Details.
      const smile = findLead(db, "ChIJaaaaaaaaaaaa")!;
      expect([smile.name, smile.address, smile.website, smile.mapsUrl, smile.rating, smile.reviews]).toEqual(["", "", "", "", null, null]);
      expect(smile.source).toBe("google");
      expect(smile.placesCheckedAt).toBeTruthy();
      expect(smile.googleAt).toBeNull();
      // The phone the practice publishes on its own site is kept, with its source recorded.
      expect(smile.phone).toBe("(02) 9621 1234");
      expect(smile.fieldSources).toEqual({ emails: "website", phone: "website" });
      expect(smile.emails[0]).toBe("reception@smiledental.com.au");
      expect(smile.emailOk).toBe(true);
      expect(smile.reasons).toContain("the site isn't on HTTPS");
      expect(smile.reasons.some((r) => r.includes("© 2019"))).toBe(true);
      expect(smile.reasons.some((r) => /Google (reviews|rating)|after-hours/.test(r))).toBe(false);
      const noSite = findLead(db, "ChIJbbbbbbbbbbbb")!;
      expect([noSite.name, noSite.phone]).toEqual(["", ""]); // Google's phone isn't stored either
      expect(findLead(db, "No Site")).toBeNull();
      expect(usage(db).details_enterprise).toBe(3);

      const again = await findLeads(db, { vertical: "dental", area: "Mount Druitt NSW", source: "google", key: "test", request: fakeFetch([]) });
      expect(again.alreadyKnown).toBe(2);
      expect(usage(db).details_enterprise).toBe(4); // only the closed one is looked up again

      const capped = await findLeads(db, { vertical: "dental", area: "Rooty Hill NSW", source: "google", key: "test", request: fakeFetch([]), budget: 4 });
      expect(capped.stoppedForBudget).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRM: call list, outcomes, opt-out, and a Google purge that a call doesn't exempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      db.query("INSERT INTO leads (place_id, vertical, name, phone, emails, email_ok, score, google_at) VALUES ('ChIJlaw111111111', 'legal', 'Old Law', '0299990000', '[\"a@oldlaw.com.au\"]', 1, 70, '2026-01-01T00:00:00Z')").run();
      const lead = findLead(db, "Old Law")!;
      expect(callList(db).map((l) => l.id)).toEqual([lead.id]);
      logActivity(db, lead, { kind: "call", outcome: "no_answer", by: "usman" });
      expect(callList(db)).toHaveLength(0); // not again for three days
      // 27 Sep 2026: calling a lead doesn't make Google's name/phone ours to keep (the old 30-day,
      // contacted-exempt purge did). Only the place ID stays; the call history is ours.
      expect(purgeGoogleCache(db)).toBe(1);
      const purged = findLead(db, lead.id)!;
      expect([purged.name, purged.phone, purged.placeId]).toEqual(["", "", "ChIJlaw111111111"]);
      expect(purged.emails).toEqual(["a@oldlaw.com.au"]); // not Places content: kept
      logActivity(db, purged, { kind: "call", outcome: "do_not_contact" });
      expect(isOptedOut(db, "A@oldlaw.com.au")).toBe(true);
      expect(findLead(db, lead.id)!.emailOk).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("calling hours follow the Telemarketing Standard (Sydney time)", () => {
    expect(callWindow(new Date("2026-09-24T00:30:00Z")).open).toBe(true); // Thu 10:30
    expect(callWindow(new Date("2026-09-24T10:30:00Z")).open).toBe(false); // Thu 20:30
    expect(callWindow(new Date("2026-09-26T06:30:00Z")).open).toBe(true); // Sat 16:30
    expect(callWindow(new Date("2026-09-26T07:30:00Z")).open).toBe(false); // Sat 17:30
    expect(callWindow(new Date("2026-09-27T00:30:00Z")).open).toBe(false); // Sunday
    expect(callWindow(new Date("2026-12-24T23:30:00Z")).open).toBe(false); // Christmas Day
  });

  test("site parsing, scoring and drafts", () => {
    expect(publicUrl("http://192.168.1.10/")).toBeNull();
    expect(publicUrl("http://localhost:8081")).toBeNull();
    expect(publicUrl("https://smiledental.com.au")).not.toBeNull();
    expect(extractEmails('x@y.png info&#64;firm.com.au <a href="mailto:sam@gmail.com">', "www.firm.com.au")).toEqual(["info@firm.com.au", "sam@gmail.com"]);
    expect(analyseHtml("<p>Please, no unsolicited emails.</p>").noUnsolicited).toBe(true);
    expect(analyseHtml('<iframe src="https://www.hotdoc.com.au/widget">').onlineBooking).toBe(true);
    expect(limitedHours(["Monday: 9:00 AM – 5:00 PM", "Saturday: Closed", "Sunday: Closed"])).toBe(true);
    expect(limitedHours(["Monday: 8:00 AM – 8:00 PM", "Saturday: 9:00 AM – 1:00 PM", "Sunday: Closed"])).toBe(false);
    const s = scoreLead(
      { placeId: "x", name: "A", address: "", phone: "", website: "", rating: 4.9, reviews: 300, status: "OPERATIONAL", mapsUrl: "", hours: [] },
      { reachable: false, finalUrl: "", https: false, mobileViewport: false, onlineBooking: false, chatWidget: false, contactForm: false, responseMs: null, copyrightYear: null, platform: "", emails: [], phones: [], noUnsolicited: false },
      "dental",
    );
    expect(s.reasons[0]).toBe("no website on file yet — not checked (run rescan to look)");
    expect(s.pitch).toBe("audit_pending");
    const d = emailDraft({ name: "Smile Dental", vertical: "dental", reasons: ["there's no online booking"], pitch: "both" });
    expect(d.body).toContain("Reply \"stop\"");
    expect(d.body).toContain("M&U Ventures");
  });

  test("goals and today's scorecard: per founder, Sydney day, follow-ups due", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      const base = { vertical: "dental" as const, area: "Mount Druitt NSW", address: "", website: "", mapsUrl: "", rating: null, reviews: null,
        emails: [], emailOk: false, score: 60, pitch: "website" as const, reasons: [], googleAt: null };
      upsertLead(db, { ...base, placeId: "p1", name: "Smile Dental", phone: "(02) 9621 1234" });
      upsertLead(db, { ...base, placeId: "p2", name: "Druitt Realty", phone: "(02) 9000 0000" });
      setGoal(db, "Usman", 20);
      expect(goal(db, "usman")).toBe(20);
      logActivity(db, findLead(db, "p1")!, { kind: "call", outcome: "no_answer", by: "usman" });
      logActivity(db, findLead(db, "p2")!, { kind: "call", outcome: "call_back", by: "usman", nextAt: new Date(Date.now() - 3_600_000).toISOString() });
      logActivity(db, findLead(db, "p1")!, { kind: "call", outcome: "interested", by: "mehroz" });
      const usman = dayReport(db, "usman");
      expect(usman.target).toBe(20);
      expect(usman.calls).toBe(2);
      expect(usman.outcomes).toEqual({ no_answer: 1, call_back: 1 });
      expect(usman.followUpsDue.map((l) => l.name)).toEqual(["Druitt Realty"]);
      expect(dayReport(db, null).calls).toBe(3);
      expect(dayReport(db, "mehroz").followUpsDue).toEqual([]); // Druitt Realty is Usman's

    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
