import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeadsApi, LocalOnly, validateFindBody, validateGoalBody, validateLogBody } from "./api";
import { openCrm, upsertLead } from "./crm";
import { draftTarget } from "./deals";

describe("leads API input validation", () => {
  test("validateLogBody", () => {
    expect(() => validateLogBody({})).toThrow("Choose a lead.");
    expect(() => validateLogBody({ lead: 1, outcome: "made-up" })).toThrow('Unknown outcome "made-up".');
    expect(() => validateLogBody({ lead: 1, kind: "text" })).toThrow("Unknown activity kind.");
    expect(() => validateLogBody({ lead: 1, by: "someone-else" })).toThrow("by must be usman or mehroz.");
    expect(() => validateLogBody({ lead: 1, next: "not-a-date" })).toThrow("That follow-up date isn't valid.");
    const ok = validateLogBody({ lead: 5, outcome: "interested", kind: "call", by: "Usman", note: "keen", next: "2026-10-01" }, new Date("2026-09-30T00:00:00Z"));
    expect(ok).toEqual({ lead: 5, outcome: "interested", kind: "call", by: "Usman", note: "keen", next: new Date("2026-10-01").toISOString() });
    // Audit F1-16: a call back with no date would never come due, so the server refuses it as the drawer does.
    for (const next of [undefined, null, ""]) expect(() => validateLogBody({ lead: 5, outcome: "call_back", next })).toThrow("A call back needs a date.");
    expect(validateLogBody({ lead: 5, outcome: "call_back", next: "2026-10-01" }, new Date("2026-09-30T00:00:00Z")).next).toBe(new Date("2026-10-01").toISOString());
  });
  test("validateGoalBody", () => {
    expect(() => validateGoalBody({ by: "someone", calls: 10 })).toThrow("by must be usman or mehroz.");
    expect(() => validateGoalBody({ by: "usman", calls: -1 })).toThrow("calls must be a number between 0 and 200.");
    expect(() => validateGoalBody({ by: "usman", calls: 500 })).toThrow("calls must be a number between 0 and 200.");
    expect(validateGoalBody({ by: "Mehroz", calls: 15.6 })).toEqual({ by: "mehroz", calls: 16 });
  });
  test("validateFindBody", () => {
    expect(() => validateFindBody({ vertical: "florist", area: "Sydney" })).toThrow(/vertical must be one of/);
    expect(() => validateFindBody({ vertical: "dental", area: "" })).toThrow(/Say where/);
    expect(() => validateFindBody({ vertical: "dental", area: "Sydney", source: "bing" })).toThrow(/source must be/);
    expect(validateFindBody({ vertical: "dental", area: "Parramatta NSW", max: 999 })).toEqual({ vertical: "dental", area: "Parramatta NSW", max: 30, source: "osm", websitePresence: "all" });
    // osm (free, no key) is the default when source isn't given
    expect(validateFindBody({ vertical: "dental", area: "Parramatta NSW" })).toEqual({ vertical: "dental", area: "Parramatta NSW", max: 20, source: "osm", websitePresence: "all" });
    expect(validateFindBody({ vertical: "dental", area: "Parramatta NSW", source: "google" })).toEqual({ vertical: "dental", area: "Parramatta NSW", max: 20, source: "google", websitePresence: "all" });
  });
});

describe("leads API handle()", () => {
  function withApi(run: (api: ReturnType<typeof createLeadsApi>, db: ReturnType<typeof openCrm>) => Promise<void> | void) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), "leads-api-"));
      const db = openCrm(join(dir, "crm.sqlite"));
      const api = createLeadsApi("", { db });
      try {
        await run(api, db);
      } finally {
        api.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  test(
    "summary, list, detail, calls, log and goal round-trip",
    withApi(async (api, db) => {
      upsertLead(db, {
        placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "0299990000",
        address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: ["info@smiledental.com.au"],
        emailOk: true, score: 80, pitch: "both", reasons: ["no online booking"], googleAt: null,
      });
      const summary = await api.handle("/leads/summary", "GET", {}, new URLSearchParams(), false);
      expect(summary.pipeline).toEqual({ new: 1 });
      expect(summary.placesUsage.budget).toBe(900);

      const list = await api.handle("/leads/list", "GET", {}, new URLSearchParams({ vertical: "dental" }), false);
      expect(list.leads).toHaveLength(1);
      const leadId = list.leads[0].id;

      const detail = await api.handle("/leads/detail", "GET", {}, new URLSearchParams({ id: String(leadId) }), false);
      expect(detail.lead.name).toBe("Smile Dental");
      expect(detail.activities).toEqual([]);

      const calls = await api.handle("/leads/calls", "GET", {}, new URLSearchParams(), false);
      expect(calls.leads).toHaveLength(1);
      expect(calls.leads[0].opener).toContain("Smile Dental");

      const drafted = await api.handle("/leads/draft", "GET", {}, new URLSearchParams({ id: String(leadId) }), false);
      expect(drafted.sent).toBe(false);
      expect(drafted.body).toContain("Reply \"stop\"");

      const logged = await api.handle("/leads/log", "POST", { lead: leadId, outcome: "interested", kind: "call", by: "usman" }, new URLSearchParams(), false);
      expect(logged.lead.status).toBe("interested");

      const goalResult = await api.handle("/leads/goal", "POST", { by: "usman", calls: 20 }, new URLSearchParams(), false);
      expect(goalResult).toEqual({ by: "usman", calls: 20 });
    }),
  );

  test(
    "card, cards, followups, won and kickoff",
    withApi(async (api, db) => {
      upsertLead(db, {
        placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "0299990000",
        address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: ["info@smiledental.com.au"],
        emailOk: true, score: 80, pitch: "both", reasons: ["no online booking"], googleAt: null,
      });
      const list = await api.handle("/leads/list", "GET", {}, new URLSearchParams(), false);
      const id = list.leads[0].id;

      const oneCard = await api.handle("/leads/card", "GET", {}, new URLSearchParams({ id: String(id) }), false);
      expect(oneCard.name).toBe("Smile Dental");
      expect(oneCard.observation).toBe("no online booking");

      const many = await api.handle("/leads/cards", "GET", {}, new URLSearchParams(), false);
      expect(many.cards).toHaveLength(1);

      expect((await api.handle("/leads/followups", "GET", {}, new URLSearchParams(), false)).followUps).toEqual([]);

      const wonResult = await api.handle("/leads/won", "POST", { lead: id, scope: "website + receptionist", by: "usman" }, new URLSearchParams(), false);
      expect(wonResult.lead.status).toBe("won");
      expect(wonResult.kickoff.milestones.length).toBeGreaterThan(0);

      const kickoffResult = await api.handle("/leads/kickoff", "GET", {}, new URLSearchParams({ id: String(id) }), false);
      expect(kickoffResult.kickoff.scope).toBe("website + receptionist");

      await expect(api.handle("/leads/kickoff", "GET", {}, new URLSearchParams({ id: "999" }), false)).rejects.toThrow("Lead not found.");
    }),
  );

  test(
    "log with --event: a replay does not duplicate the activity",
    withApi(async (api, db) => {
      upsertLead(db, {
        placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "0299990000",
        address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false,
        score: 60, pitch: "website", reasons: [], googleAt: null,
      });
      const id = (await api.handle("/leads/list", "GET", {}, new URLSearchParams(), false)).leads[0].id;
      const first = await api.handle("/leads/log", "POST", { lead: id, outcome: "interested", by: "usman", event: "evt-1" }, new URLSearchParams(), false);
      expect(first.duplicate).toBe(false);
      const replay = await api.handle("/leads/log", "POST", { lead: id, outcome: "no_answer", by: "usman", event: "evt-1" }, new URLSearchParams(), false);
      expect(replay.duplicate).toBe(true);
      expect(replay.lead.status).toBe("interested"); // unchanged by the replay
    }),
  );

  test(
    "coach and coaching",
    withApi(async (api, db) => {
      upsertLead(db, {
        placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "0299990000",
        address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false,
        score: 60, pitch: "website", reasons: [], googleAt: null,
      });
      const id = (await api.handle("/leads/list", "GET", {}, new URLSearchParams(), false)).leads[0].id;
      const note = await api.handle(
        "/leads/coach", "POST",
        { lead: id, by: "usman", categories: { opener: 12, discovery: 20 }, objectionTag: "price", worked: "good rapport", improve: "ask for the date sooner", nextStep: "callback Friday" },
        new URLSearchParams(), false,
      );
      expect(note.score).toBe(32);
      const summary = await api.handle("/leads/coaching", "GET", {}, new URLSearchParams({ by: "usman" }), false);
      expect(summary.count).toBe(1);
      expect(summary.averageScore).toBe(32);
    }),
  );

  test(
    "find is refused for a remote session (spends paid Google lookups)",
    withApi(async (api) => {
      await expect(api.handle("/leads/find", "POST", { vertical: "dental", area: "Sydney" }, new URLSearchParams(), true)).rejects.toBeInstanceOf(LocalOnly);
    }),
  );

  describe("SEO audit guards", () => {
    test(
      "refused for a remote session (runs a real crawl and spends Jev budget)",
      withApi(async (api, db) => {
        const id = upsertLead(db, {
          placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "",
          address: "", website: "https://smiledental.example", mapsUrl: "", rating: null, reviews: null,
          emails: [], emailOk: false, score: 80, pitch: "redesign", reasons: [], googleAt: null,
        }).id;
        await expect(api.handle("/leads/seo-audit", "POST", { lead: id }, new URLSearchParams(), true)).rejects.toBeInstanceOf(LocalOnly);
      }),
    );

    test(
      "refused for a lead with no website on file",
      withApi(async (api, db) => {
        const id = upsertLead(db, {
          placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "",
          address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false,
          score: 80, pitch: "website", reasons: [], googleAt: null,
        }).id;
        await expect(api.handle("/leads/seo-audit", "POST", { lead: id }, new URLSearchParams(), false)).rejects.toThrow("This lead has no website on file.");
      }),
    );

    test(
      "refused for an excluded lead and for do_not_contact",
      withApi(async (api, db) => {
        const excluded = upsertLead(db, {
          placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Chain Dental", phone: "",
          address: "", website: "https://chain.example", mapsUrl: "", rating: null, reviews: null, emails: [],
          emailOk: false, score: 0, pitch: "none", reasons: [], googleAt: null, excluded: true, excludedReason: "national chain",
        }).id;
        await expect(api.handle("/leads/seo-audit", "POST", { lead: excluded }, new URLSearchParams(), false)).rejects.toThrow("Excluded leads never get an SEO audit.");

        const dnc = upsertLead(db, {
          placeId: "p2", vertical: "dental", area: "Mount Druitt NSW", name: "Quiet Dental", phone: "",
          address: "", website: "https://quiet.example", mapsUrl: "", rating: null, reviews: null, emails: [],
          emailOk: false, score: 10, pitch: "none", reasons: [], googleAt: null,
        }).id;
        await api.handle("/leads/log", "POST", { lead: dnc, outcome: "do_not_contact", kind: "call", by: "usman" }, new URLSearchParams(), false);
        await expect(api.handle("/leads/seo-audit", "POST", { lead: dnc }, new URLSearchParams(), false)).rejects.toThrow("This lead asked not to be contacted.");
      }),
    );

    test(
      "proposals and deposit invoices are refused for an excluded lead (audit F1-16)",
      withApi(async (api, db) => {
        const excluded = upsertLead(db, {
          placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Chain Dental", phone: "0299990000",
          address: "", website: "https://chain.example", mapsUrl: "", rating: null, reviews: null, emails: [],
          emailOk: false, score: 0, pitch: "website", reasons: [], googleAt: null, excluded: true, excludedReason: "national chain",
        });
        for (const path of ["/leads/proposal", "/leads/deposit-invoice"])
          await expect(api.handle(path, "POST", { lead: excluded.id }, new URLSearchParams(), false)).rejects.toThrow("Excluded leads don't get proposals or invoices.");
        const open = upsertLead(db, { ...excluded, placeId: "p2", name: "Open Dental", excluded: false, excludedReason: "" });
        expect(draftTarget(db, open).lead.id).toBe(open.id); // the same lead, not excluded, can be drafted
      }),
    );

    test(
      "GET status returns null before any audit has run",
      withApi(async (api, db) => {
        const id = upsertLead(db, {
          placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "",
          address: "", website: "https://smiledental.example", mapsUrl: "", rating: null, reviews: null,
          emails: [], emailOk: false, score: 80, pitch: "redesign", reasons: [], googleAt: null,
        }).id;
        const status = await api.handle("/leads/seo-audit", "GET", {}, new URLSearchParams({ id: String(id) }), false);
        expect(status.audit).toBeNull();
      }),
    );
  });

  test(
    "unknown path throws",
    withApi(async (api) => {
      await expect(api.handle("/leads/nope", "GET", {}, new URLSearchParams(), false)).rejects.toThrow("Choose a supported leads action.");
    }),
  );
});
