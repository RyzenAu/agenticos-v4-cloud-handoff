import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCard, renderCard } from "./card";
import { renderCoachingSummary, renderCoachNote } from "./coach";
import {
  coachingSummary, eventLogged, findLead, getKickoff, logActivity, nextMilestoneAction, openCrm,
  recordCoaching, recordWin, setMilestone, upsertLead,
} from "./crm";
import { followUpQueue, renderFollowUp } from "./followups";

function withDb(run: (db: ReturnType<typeof openCrm>) => void) {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-ops-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      run(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const base = {
  vertical: "dental" as const, area: "Mount Druitt NSW", address: "", website: "", mapsUrl: "",
  rating: null, reviews: null, googleAt: null,
};

describe("call-prep cards", () => {
  test(
    "builds from CRM data only, and says insufficient data when a signal is missing",
    withDb((db) => {
      const noAudit = upsertLead(db, { ...base, placeId: "p1", name: "Smile Dental", phone: "0299990000", emails: [], emailOk: false, score: 0, pitch: "website", reasons: [] });
      const card = buildCard(db, noAudit);
      expect(card.reasons).toEqual([{ text: "insufficient data: no score reasons on file", verified: false }]);
      expect(card.observation).toBe("insufficient data: no site-audit finding on file");
      expect(card.lastContact).toBeNull();
      expect(renderCard(card)).toContain("Last contact: insufficient data: never contacted");

      const withAudit = upsertLead(db, {
        ...base, placeId: "p2", name: "Druitt Dental", phone: "0299990001", emails: ["hi@druittdental.com.au"],
        emailOk: true, score: 70, pitch: "both", reasons: ["the site isn't on HTTPS", "there's no online booking"],
      });
      logActivity(db, withAudit, { kind: "call", outcome: "no_answer", by: "usman", note: "left a voicemail" });
      const card2 = buildCard(db, findLead(db, withAudit.id)!);
      expect(card2.observation).toBe("the site isn't on HTTPS");
      expect(card2.opener).toContain("Druitt Dental");
      expect(card2.lastContact?.outcome).toBe("no_answer");
      expect(card2.compliance.emailOk).toBe(true);
      expect(renderCard(card2)).toContain("Say:");

      logActivity(db, findLead(db, withAudit.id)!, { kind: "note", outcome: "do_not_contact" });
      const card3 = buildCard(db, findLead(db, withAudit.id)!);
      expect(card3.compliance.doNotContact).toBe(true);
      expect(card3.opener).toBe("");
      expect(renderCard(card3)).toContain("This lead asked not to be contacted.");
    }),
  );
});

describe("follow-up queue", () => {
  test(
    "surfaces the promised item, marks overdue, and never sends",
    withDb((db) => {
      const lead = upsertLead(db, {
        ...base, placeId: "p1", name: "Smile Dental", phone: "0299990000", emails: ["reception@smiledental.com.au"],
        emailOk: true, score: 70, pitch: "website", reasons: ["there's no online booking"],
      });
      logActivity(db, lead, {
        kind: "call", outcome: "call_back", by: "usman",
        note: "spoke to Sarah, keen on the website, call back Friday",
        nextAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), // 3 days ago: overdue
      });
      const queue = followUpQueue(db, "usman");
      expect(queue).toHaveLength(1);
      expect(queue[0].overdue).toBe(true);
      expect(queue[0].promised).toContain("call back Friday");
      expect(queue[0].draft.channel).toBe("call"); // has a phone; last touch was a call
      expect(renderFollowUp(queue[0])).toContain("OVERDUE");

      // No note on file: never invents one.
      const lead2 = upsertLead(db, { ...base, placeId: "p2", name: "No Note Realty", phone: "0299990002", emails: [], emailOk: false, score: 50, pitch: "website", reasons: [] });
      logActivity(db, lead2, { kind: "call", outcome: "call_back", by: "usman", nextAt: new Date(Date.now() - 86_400_000).toISOString() });
      const queue2 = followUpQueue(db, "usman");
      const noNote = queue2.find((f) => f.leadId === lead2.id)!;
      expect(noNote.promised).toBe("insufficient data: no note on the last activity");

      // Not due yet: excluded.
      const lead3 = upsertLead(db, { ...base, placeId: "p3", name: "Future Firm", phone: "0299990003", emails: [], emailOk: false, score: 40, pitch: "website", reasons: [] });
      logActivity(db, lead3, { kind: "call", outcome: "call_back", by: "usman", nextAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
      expect(followUpQueue(db, "usman").some((f) => f.leadId === lead3.id)).toBe(false);
    }),
  );

  test(
    "prefers email when the last touch was an email and the address is still usable",
    withDb((db) => {
      const lead = upsertLead(db, {
        ...base, placeId: "p1", name: "Smile Dental", phone: "0299990000", emails: ["reception@smiledental.com.au"],
        emailOk: true, score: 70, pitch: "receptionist", reasons: ["after-hours calls go unanswered"],
      });
      logActivity(db, lead, { kind: "email", outcome: "emailed", by: "usman", note: "sent the receptionist one-pager", nextAt: new Date(Date.now() - 86_400_000).toISOString() });
      const [item] = followUpQueue(db, "usman");
      expect(item.draft.channel).toBe("email");
      if (item.draft.channel === "email") expect(item.draft.to).toBe("reception@smiledental.com.au");
    }),
  );
});

describe("log idempotency (--event)", () => {
  test(
    "a replayed event id does not create a second activity",
    withDb((db) => {
      const lead = upsertLead(db, { ...base, placeId: "p1", name: "Smile Dental", phone: "0299990000", emails: [], emailOk: false, score: 60, pitch: "website", reasons: [] });
      expect(eventLogged(db, "evt-1")).toBe(false);
      const first = logActivity(db, lead, { kind: "call", outcome: "interested", by: "usman", note: "keen", eventId: "evt-1" });
      expect(eventLogged(db, "evt-1")).toBe(true);
      expect(first.status).toBe("interested");
      // Replay with the same event id and a different (wrong) outcome: must be a no-op.
      const replay = logActivity(db, findLead(db, lead.id)!, { kind: "call", outcome: "no_answer", by: "usman", eventId: "evt-1" });
      expect(replay.status).toBe("interested"); // unchanged
      const count = db.query("SELECT COUNT(*) AS n FROM activities WHERE lead_id = ?").get(lead.id) as { n: number };
      expect(count.n).toBe(1);
      // A different event id is a genuinely new activity.
      logActivity(db, findLead(db, lead.id)!, { kind: "call", outcome: "no_answer", by: "usman", eventId: "evt-2" });
      const count2 = db.query("SELECT COUNT(*) AS n FROM activities WHERE lead_id = ?").get(lead.id) as { n: number };
      expect(count2.n).toBe(2);
    }),
  );
});

describe("won + kickoff", () => {
  test(
    "records the win, builds a checklist by pitch, and stores nothing client-facing",
    withDb((db) => {
      const lead = upsertLead(db, {
        ...base, placeId: "p1", name: "Smile Dental", phone: "0299990000", emails: [], emailOk: false,
        score: 80, pitch: "both", reasons: [],
      });
      expect(getKickoff(db, lead.id)).toBeNull();
      const { lead: updated, kickoff } = recordWin(db, lead, { scope: "website rebuild + AI receptionist", by: "usman" });
      expect(updated.status).toBe("won");
      // Transfer isn't offered in any tier: forwarding and routing, never "transfer to" (review T5).
      expect(kickoff.access).toContain("Who can switch call forwarding on the practice's number, and the cover they want (after hours, overflow, all calls)");
      expect(kickoff.access.join(" ")).not.toMatch(/transfer/i);
      const milestoneNames = kickoff.milestones.map((m) => m.name);
      expect(milestoneNames).toContain("Receptionist go-live tests passed (booking, 000, routing, texts if on)");
      expect(milestoneNames).toContain("Deployed");
      expect(kickoff.milestones.every((m) => m.state === "pending")).toBe(true); // fresh win: nothing done yet

      const fetched = getKickoff(db, lead.id)!;
      expect(fetched.scope).toBe("website rebuild + AI receptionist");
      expect(JSON.stringify(fetched)).not.toMatch(/@|http/); // nothing client-facing sneaks in

      expect(() => recordWin(db, findLead(db, lead.id)!, { scope: "" })).toThrow(/Say the scope/);
    }),
  );

  test(
    "milestone state updates, and re-running won never resets progress already tracked",
    withDb((db) => {
      const lead = upsertLead(db, { ...base, placeId: "p2", name: "Bright Realty", phone: "0299991111", emails: [], emailOk: false, score: 70, pitch: "website", reasons: [] });
      recordWin(db, lead, { scope: "website build", by: "usman" });
      expect(nextMilestoneAction(getKickoff(db, lead.id)!)?.name).toBe("Content collected");

      const updated = setMilestone(db, lead.id, "content collected", { state: "partial", note: "one listing in, rest outstanding", by: "usman" });
      const contentCollected = updated.milestones.find((m) => m.name === "Content collected")!;
      expect(contentCollected.state).toBe("partial");
      expect(contentCollected.note).toBe("one listing in, rest outstanding");
      // Re-reading (idempotent) sees the same state.
      expect(getKickoff(db, lead.id)!.milestones.find((m) => m.name === "Content collected")!.state).toBe("partial");
      // The single next action is still this milestone (it isn't "done" yet).
      expect(nextMilestoneAction(getKickoff(db, lead.id)!)?.name).toBe("Content collected");

      setMilestone(db, lead.id, "Build started", { state: "done", completedAt: "2026-09-22T00:00:00.000Z", by: "usman" });
      const afterBuild = getKickoff(db, lead.id)!;
      expect(afterBuild.milestones.find((m) => m.name === "Build started")!.completedAt).toBe("2026-09-22T00:00:00.000Z");
      // Next action skips the done milestone and lands back on the still-partial one.
      expect(nextMilestoneAction(afterBuild)?.name).toBe("Content collected");

      // Re-running `won` (e.g. the founder repeats the phrase) must not wipe the tracked progress.
      recordWin(db, findLead(db, lead.id)!, { scope: "website build", by: "usman" });
      const afterRewon = getKickoff(db, lead.id)!;
      expect(afterRewon.milestones.find((m) => m.name === "Content collected")!.state).toBe("partial");
      expect(afterRewon.milestones.find((m) => m.name === "Build started")!.state).toBe("done");

      expect(() => setMilestone(db, lead.id, "not a real milestone", { state: "done" })).toThrow(/No milestone matches/);
    }),
  );
});

describe("call coaching", () => {
  test(
    "scores only the categories given, never invents the missing ones, and rejects out-of-range points",
    withDb((db) => {
      const lead = upsertLead(db, { ...base, placeId: "p1", name: "Smile Dental", phone: "0299990000", emails: [], emailOk: false, score: 60, pitch: "website", reasons: [] });
      const note = recordCoaching(db, lead, {
        by: "usman",
        categories: { opener: 12, discovery: 18, nextStep: 20 }, // value/objection/delivery not covered by the debrief
        objectionTag: "price",
        worked: "asked a great open question about their booking pain",
        improve: "slow down before the pitch",
        nextStep: "call back Friday 2pm",
      });
      expect(note.score).toBe(50); // 12 + 18 + 20
      expect(note.categories.value).toBeUndefined();
      expect(renderCoachNote(note)).toContain("Not observed: Value & fit, Objection handling, Delivery");
      expect(renderCoachNote(note)).toContain("no audio or transcript is stored");

      expect(() => recordCoaching(db, lead, { by: "usman", categories: { opener: 99 }, worked: "", improve: "", nextStep: "" })).toThrow(/opener must be between/);
      expect(() => recordCoaching(db, lead, { by: "usman", categories: { madeUp: 5 } as any, worked: "", improve: "", nextStep: "" })).toThrow(/Unknown coaching category/);
    }),
  );

  test(
    "trend summary: average score, top objection, repeated improvement",
    withDb((db) => {
      const lead = upsertLead(db, { ...base, placeId: "p1", name: "Smile Dental", phone: "0299990000", emails: [], emailOk: false, score: 60, pitch: "website", reasons: [] });
      recordCoaching(db, lead, { by: "usman", categories: { opener: 10, discovery: 20 }, objectionTag: "price", worked: "w", improve: "slow down", nextStep: "n" });
      recordCoaching(db, lead, { by: "usman", categories: { opener: 14, discovery: 22 }, objectionTag: "price", worked: "w", improve: "slow down", nextStep: "n" });
      recordCoaching(db, lead, { by: "usman", categories: { opener: 15 }, objectionTag: "timing", worked: "w", improve: "ask for the next step sooner", nextStep: "n" });
      const summary = coachingSummary(db, "usman", 30);
      expect(summary.count).toBe(3);
      expect(summary.averageScore).toBe(Math.round((30 + 36 + 15) / 3));
      expect(summary.averageByCategory.opener).toBeCloseTo(13, 0);
      expect(summary.topObjection).toEqual({ tag: "price", count: 2 });
      expect(summary.repeatedImprovement).toEqual({ text: "slow down", count: 2 });
      expect(renderCoachingSummary(summary)).toContain("Most common objection: price (2×)");
      expect(coachingSummary(db, "mehroz", 30).count).toBe(0); // filtered by founder
    }),
  );
});
