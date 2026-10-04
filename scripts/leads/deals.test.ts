import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, logActivity, openCrm, recordWin, setGoal, setMilestone, upsertLead, type Lead } from "./crm";
import { buildCard, renderCard } from "./card";
import {
  crmOverview, daysInStage, DEFAULT_PROBABILITY, DEFAULT_STUCK_DAYS, dealEconomics, dealRows, leadDeal, monthNetCash, moveStage,
  readDeal, readRules, saveDeal, saveRules, stageTimeline, stuckCheck, type Rules,
} from "./deals";
import { leadPipeline } from "./lead-pipeline";
import { SHARED_LEDGER, openManualFinanceStore } from "../finance/manual-store";
import { syntheticSeptemberCsv } from "../finance/manual-fixtures";
import { searchCrm } from "./crm-search";
import { createLeadsApi } from "./api";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../../src/lib/receptionist-packages";

const NOW = new Date("2026-09-25T00:00:00Z"); // 10am Sydney
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function add(db: Database, over: Partial<Parameters<typeof upsertLead>[1]> = {}): Lead {
  return upsertLead(db, {
    placeId: `osm:node/${Math.random()}`, source: "osm", attribution: "© OpenStreetMap contributors", vertical: "dental",
    area: "Blacktown NSW", name: "Smile Co", phone: "02 9622 1234", address: "", website: "", mapsUrl: "", rating: null,
    reviews: null, emails: ["hello@smile.example"], emailOk: true, score: 50, pitch: "website", reasons: [], googleAt: null, ...over,
  });
}
/** Backdates every activity for a lead (logActivity always stamps "now"). */
const backdate = (db: Database, leadId: number, iso: string) => {
  db.query("UPDATE activities SET at = ? WHERE lead_id = ?").run(iso, leadId);
  db.query("UPDATE leads SET last_contact_at = ? WHERE id = ? AND last_contact_at IS NOT NULL").run(iso, leadId);
};

function withCrm(run: (root: string, db: Database) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "deals-"));
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  return Promise.resolve(run(root, db)).finally(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
}

const ESSENTIAL = getReceptionistPackage("receptionist-essential").pricing;
/** Only an approved setup fee counts towards deal value (catalogue setupStatus). */
const countedSetup = (p: typeof ESSENTIAL) => ((p.setupStatus ?? p.status) === "approved" ? p.setup.cents : 0);
const RULES: Rules = { probability: { ...DEFAULT_PROBABILITY }, stuckDays: { ...DEFAULT_STUCK_DAYS }, monthsCounted: 12 };
const EMPTY = { offer: null, packageId: null, setupCents: null, monthlyCents: null, probability: null, expectedClose: null, contactPref: "", updatedBy: "", updatedAt: null };

describe("deal economics", () => {
  test("offer defaults, first-year value and weighting by stage", () => {
    const web = dealEconomics({ pitch: "website" }, { stage: "meeting", closed: false }, EMPTY, RULES);
    // Website A$1,650 incl. GST is A$1,500 ex GST: every deal value is ex GST (owner, 28 Sep).
    expect([web.valueCents, web.probability, web.weightedCents, web.valueSource]).toEqual([150_000, 0.4, 60_000, "offer default"]);
    expect([web.valueInclGstCents, web.gstBasis]).toEqual([165_000, "ex GST"]);
    const rec = dealEconomics({ pitch: "receptionist" }, { stage: "proposal", closed: false }, EMPTY, RULES);
    const recValue = countedSetup(ESSENTIAL) + ESSENTIAL.monthly.cents * 12;
    expect([rec.setupCents, rec.monthlyCents, rec.valueCents]).toEqual([countedSetup(ESSENTIAL), ESSENTIAL.monthly.cents, recValue]);
    expect([rec.packageId, rec.priceStatus, rec.offerLabel]).toEqual(["receptionist-essential", ESSENTIAL.status, `AI receptionist · Essential (${ESSENTIAL.status}, ex GST)`]);
    expect(rec.weightedCents).toBe(Math.round(recValue * 0.6));
    const both = dealEconomics({ pitch: "both" }, { stage: "won", closed: false }, EMPTY, RULES);
    expect([both.setupCents, both.monthlyCents, both.probability]).toEqual([150_000 + countedSetup(ESSENTIAL), ESSENTIAL.monthly.cents, 1]);
    // The owner's example: "both" = A$1,500 + A$699 x 12 = A$9,888 ex GST (not the mixed A$10,038), A$10,876.80 incl. GST.
    expect([both.valueCents, both.valueInclGstCents]).toEqual([150_000 + countedSetup(ESSENTIAL) + ESSENTIAL.monthly.cents * 12, Math.round((150_000 + countedSetup(ESSENTIAL) + ESSENTIAL.monthly.cents * 12) * 1.1)]);
    expect([web.packageId, web.priceStatus]).toEqual([null, null]);
    expect(dealEconomics({ pitch: "audit_pending" }, { stage: "scored", closed: false }, EMPTY, RULES).offer).toBe("website");
  });
  test("a deal's catalogue package sets the receptionist price; website offers ignore it", () => {
    for (const pkg of RECEPTIONIST_PACKAGES) {
      const e = dealEconomics({ pitch: "receptionist" }, { stage: "proposal", closed: false }, { ...EMPTY, packageId: pkg.id }, RULES);
      expect([e.packageId, e.setupCents, e.monthlyCents, e.priceStatus]).toEqual([pkg.id, countedSetup(pkg.pricing), pkg.pricing.monthly.cents, pkg.pricing.status]);
      expect(e.offerLabel).toContain(pkg.shortName);
      expect(pkg.pricing.setup.gst).toBe("exclusive"); expect(pkg.pricing.monthly.gst).toBe("exclusive");
    }
    const web = dealEconomics({ pitch: "website" }, { stage: "proposal", closed: false }, { ...EMPTY, packageId: "receptionist-premium" }, RULES);
    expect([web.setupCents, web.monthlyCents, web.packageId]).toEqual([150_000, 0, null]);
  });
  test("custom value/probability override defaults; a closed lead weighs nothing", () => {
    const custom = dealEconomics({ pitch: "website" }, { stage: "replied", closed: false }, { ...EMPTY, setupCents: 200_000, probability: 0.5, offer: "redesign" }, RULES);
    expect([custom.offer, custom.valueCents, custom.probability, custom.probabilitySource, custom.valueSource, custom.weightedCents]).toEqual(["redesign", 200_000, 0.5, "custom", "custom", 100_000]);
    const lost = dealEconomics({ pitch: "website" }, { stage: "proposal", closed: true }, { ...EMPTY, probability: 0.9 }, RULES);
    expect([lost.probability, lost.probabilitySource, lost.weightedCents]).toEqual([0, "closed", 0]);
  });
});

describe("stuck rules", () => {
  test("over threshold with no future follow-up is stuck, with the stage's action", () => {
    const s = stuckCheck({ stage: "contacted", closed: false }, 6, null, RULES, NOW);
    expect(s).toEqual({ thresholdDays: 5, days: 6, action: expect.stringContaining("Second touch") });
    expect(stuckCheck({ stage: "contacted", closed: false }, 5, null, RULES, NOW)).toBeNull(); // at the threshold, not over
    expect(stuckCheck({ stage: "proposal", closed: false }, 30, daysAgo(-2), RULES, NOW)).toBeNull(); // follow-up booked
    expect(stuckCheck({ stage: "proposal", closed: false }, 30, daysAgo(1), RULES, NOW)?.thresholdDays).toBe(7); // follow-up passed
    expect(stuckCheck({ stage: "scored", closed: false }, 300, null, RULES, NOW)).toBeNull(); // backlog never stuck
    expect(stuckCheck({ stage: "meeting", closed: true }, 300, null, RULES, NOW)).toBeNull();
  });
  test("rules are configurable in one place, validated, and a stage can be switched off", () => withCrm((_root, db) => {
    expect(readRules(db).stuckDays.replied).toBe(3);
    const saved = saveRules(db, { stuckDays: { replied: 2, proposal: null }, probability: { meeting: 0.5 } });
    expect([saved.stuckDays.replied, saved.stuckDays.proposal, saved.probability.meeting, saved.probability.proposal]).toEqual([2, undefined, 0.5, 0.6]);
    expect(stuckCheck({ stage: "proposal", closed: false }, 99, null, saved, NOW)).toBeNull();
    expect(() => saveRules(db, { stuckDays: { replied: 0 } })).toThrow("whole number of days");
    expect(() => saveRules(db, { probability: { meeting: 1.5 } })).toThrow("between 0 and 1");
    expect(() => saveRules(db, { probability: { nope: 0.1 } })).toThrow("Unknown stage");
    expect(readRules(db).stuckDays.replied).toBe(2); // a rejected save changed nothing
  }));
});

describe("stage history and days in stage", () => {
  test("dates come from evidence; days in stage counts from the current stage", () => withCrm((root, db) => {
    const lead = add(db);
    db.query("UPDATE leads SET created_at = ? WHERE id = ?").run(daysAgo(20), lead.id);
    logActivity(db, lead, { kind: "call", outcome: "no_answer", by: "usman" });
    backdate(db, lead.id, daysAgo(9));
    const fresh = findLead(db, lead.id)!;
    const view = leadPipeline(root, db, fresh);
    expect(view.stage).toBe("contacted");
    const acts = db.query("SELECT id, lead_id as leadId, at, kind, outcome, note, by FROM activities WHERE lead_id = ? ORDER BY at").all(lead.id) as any[];
    const timeline = stageTimeline(root, db, fresh, view, acts);
    expect(timeline.map((e) => e.stage)).toEqual(["found", "contacted"]); // no issues pass yet: "scored" has no dated evidence
    expect(timeline.at(-1)).toMatchObject({ at: daysAgo(9), inferred: false });
    expect(daysInStage(timeline, NOW)).toEqual({ days: 9, since: daysAgo(9), inferred: false });
    const row = dealRows(root, db, [fresh], NOW).get(lead.id)!;
    expect(row.stuck).toMatchObject({ thresholdDays: 5, days: 9 });
    expect(row.economics.weightedCents).toBe(15_000); // 10% of A$1,500 ex GST
  }));
  test("an undated current stage falls back to the latest dated one and says so", () => {
    const t = [{ stage: "found" as const, at: daysAgo(4), evidence: "", inferred: false }, { stage: "verified" as const, at: null, evidence: "", inferred: true }];
    expect(daysInStage(t, NOW)).toEqual({ days: 4, since: daysAgo(4), inferred: true });
    expect(daysInStage([], NOW).days).toBeNull();
  });
});

describe("deal records", () => {
  test("partial saves, null clears, bad input rejected, contact preference kept", () => withCrm((root, db) => {
    const lead = add(db);
    expect(readDeal(db, lead.id).setupCents).toBeNull();
    saveDeal(db, lead.id, { setupCents: 180_000, contactPref: "  Email first; mornings only  " }, "usman");
    saveDeal(db, lead.id, { probability: 0.3, expectedClose: "2026-10-15" }, "mehroz");
    let d = readDeal(db, lead.id);
    expect([d.setupCents, d.probability, d.expectedClose, d.contactPref, d.updatedBy]).toEqual([180_000, 0.3, "2026-10-15", "Email first; mornings only", "mehroz"]);
    saveDeal(db, lead.id, { setupCents: null });
    d = readDeal(db, lead.id);
    expect([d.setupCents, d.probability]).toEqual([null, 0.3]);
    expect(() => saveDeal(db, lead.id, { setupCents: 12.5 })).toThrow("whole number of cents");
    expect(() => saveDeal(db, lead.id, { expectedClose: "next week" })).toThrow("date like");
    expect(() => saveDeal(db, lead.id, { offer: "seo" as any })).toThrow("Offer must be");
    expect(() => saveDeal(db, lead.id, { packageId: "receptionist-pilot" })).toThrow("Package must be");
    expect(readDeal(db, lead.id).packageId).toBeNull();
    saveDeal(db, lead.id, { offer: "receptionist", packageId: "receptionist-professional" });
    saveDeal(db, lead.id, { probability: 0.4 }); // a later edit keeps the package
    d = readDeal(db, lead.id);
    expect([d.offer, d.packageId, d.probability]).toEqual(["receptionist", "receptionist-professional", 0.4]);
    expect(leadDeal(root, db, findLead(db, lead.id)!).economics.monthlyCents).toBe(getReceptionistPackage("receptionist-professional").pricing.monthly.cents);
    saveDeal(db, lead.id, { packageId: null });
    expect(readDeal(db, lead.id).packageId).toBeNull();
    expect(() => saveDeal(db, 9999, {})).toThrow("Lead not found");
    expect(leadDeal(root, db, findLead(db, lead.id)!).contactPref).toBe("Email first; mornings only");
  }));
});

describe("board moves", () => {
  test("forward moves write an activity and keep the follow-up; backwards and closed are refused", () => withCrm((root, db) => {
    const lead = add(db);
    logActivity(db, lead, { kind: "call", outcome: "call_back", nextAt: "2026-10-01T00:00:00.000Z", by: "usman" });
    const moved = moveStage(root, db, findLead(db, lead.id)!, { to: "meeting", by: "mehroz", note: "Tues 2pm" });
    expect(moved.pipeline.stage).toBe("meeting");
    expect(moved.lead.status).toBe("meeting");
    expect(moved.lead.nextAt).toBe("2026-10-01T00:00:00.000Z");
    const last = db.query("SELECT kind, outcome, note, by FROM activities WHERE lead_id = ? ORDER BY id DESC LIMIT 1").get(lead.id);
    expect(last).toEqual({ kind: "note", outcome: "meeting", note: "Moved to Meeting on the board — Tues 2pm", by: "mehroz" });
    expect(() => moveStage(root, db, findLead(db, lead.id)!, { to: "replied" })).toThrow("only move forward");
    expect(() => moveStage(root, db, findLead(db, lead.id)!, { to: "building" })).toThrow("delivery stages");
    expect(() => moveStage(root, db, findLead(db, lead.id)!, { to: "won" })).toThrow("scope");
    const won = moveStage(root, db, findLead(db, lead.id)!, { to: "won", scope: "Website rebuild", by: "usman" });
    expect(won.pipeline.stage).toBe("won");
    expect(() => moveStage(root, db, findLead(db, lead.id)!, { to: "lost" })).toThrow("won client");
    const other = add(db);
    moveStage(root, db, other, { to: "lost" });
    expect(() => moveStage(root, db, findLead(db, other.id)!, { to: "meeting" })).toThrow("closed");
  }));
  test("moving to contacted records the channel honestly", () => withCrm((root, db) => {
    const lead = add(db);
    const r = moveStage(root, db, lead, { to: "contacted", kind: "email", by: "usman" });
    expect([r.pipeline.stage, r.lead.status]).toEqual(["contacted", "emailed"]);
    const dnc = add(db);
    logActivity(db, dnc, { kind: "call", outcome: "do_not_contact" });
    expect(() => moveStage(root, db, findLead(db, dnc.id)!, { to: "replied" })).toThrow("asked not to be contacted");
  }));
});

describe("morning overview", () => {
  test("one sentence, tiles, to-do and upcoming from real rows", () => withCrm((root, db) => {
    const stuck = add(db, { name: "Stuck Dental" });
    logActivity(db, stuck, { kind: "call", outcome: "interested", by: "usman" });
    backdate(db, stuck.id, daysAgo(6));
    const overdue = add(db, { name: "Overdue Legal", vertical: "legal" });
    logActivity(db, overdue, { kind: "call", outcome: "call_back", nextAt: daysAgo(2), by: "usman" });
    backdate(db, overdue.id, daysAgo(3));
    const proposal = add(db, { name: "Proposal Realty", pitch: "receptionist" });
    logActivity(db, proposal, { kind: "note", outcome: "proposal", nextAt: daysAgo(-3) });
    const client = add(db, { name: "Client Co" });
    recordWin(db, client, { scope: "Website", by: "usman" });
    setMilestone(db, client.id, "Content collected", { state: "partial", due: "2026-09-24" });
    add(db, { name: "Fresh Lead" });

    const o = crmOverview(root, db, { now: NOW, receivables: [{ client: "Client Co", amountAud: 825, note: "balance" }] });
    expect(o.tiles.stuck.count).toBe(1);
    expect(o.stuck[0]).toMatchObject({ name: "Stuck Dental", stage: "replied", thresholdDays: 3 });
    expect(o.tiles.followUps).toEqual({ overdue: 1, dueToday: 0 });
    expect(o.tiles.proposals).toEqual({ count: 1, valueCents: countedSetup(ESSENTIAL) + ESSENTIAL.monthly.cents * 12 });
    expect(o.tiles.pipeline.count).toBe(3); // replied + contacted + proposal
    expect(o.tiles.builds).toEqual({ active: 1, tasksDue: 1 });
    expect(o.tiles.invoices.cents).toBe(82_500);
    expect(o.tiles.netCash).toBeNull(); // nothing imported: the tile hides
    expect(o.sentence).toMatch(/^\d+ on today's call sheet \(\d+ due\), 1 follow-up overdue, 1 deal stuck and 1 build task due\.$/); // 10am Friday: calls open
    expect(o.todo[0]).toMatchObject({ overdue: true });
    expect(o.todo.some((t) => t.kind === "build task" && t.detail === "Content collected")).toBe(true);
    expect(o.upcoming.map((u) => u.name)).toContain("Proposal Realty");
  }));
  test("net cash comes from the NAB CSV ledger, never the retired finance.sqlite (review T5 R2 B1)", () => withCrm((root, db) => {
    // A populated legacy file (transfers and a Stripe payout that the old tile counted as "margin")…
    const legacy = new Database(join(root, ".operator-data", "finance.sqlite"), { create: true });
    legacy.exec("CREATE TABLE transactions (id TEXT, amount REAL, direction TEXT, status TEXT, post_date TEXT)");
    legacy.query("INSERT INTO transactions VALUES ('a', 5000, 'credit', 'posted', '2026-09-05'), ('b', 825, 'credit', 'posted', '2026-09-18'), ('c', -2000, 'debit', 'posted', '2026-09-06')").run();
    legacy.close();
    // …is ignored: with no NAB CSV imported the tile hides.
    expect(monthNetCash(root, NOW)).toBeNull();
    // With the NAB ledger: cash in/out/net, transfers and Stripe payouts excluded, coverage stated.
    const store = openManualFinanceStore(":memory:");
    store.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "test");
    const n = monthNetCash(root, NOW, { store })!;
    expect(n).toMatchObject({ month: "2026-09", inCents: 82_500, statement: "NAB CSV imported, as of 26 Sep 2026" });
    expect(n.netCents).toBe(n.inCents! - n.outCents!);
    expect(n.inCents).not.toBe(582_500); // the legacy A$5,000 transfer and A$825 payout aren't income
    expect(["full", "partial"]).toContain(n.coverage);
    expect(crmOverview(root, db, { now: NOW, ledgerStore: store, receivables: [] }).tiles.netCash).toMatchObject({ netCents: n.netCents });
    // A month no import covers is unknown, not zero.
    expect(monthNetCash(root, new Date("2026-11-02T00:00:00Z"), { store })).toMatchObject({ coverage: "none", netCents: null });
    store.close();
  }));
});

describe("search", () => {
  test("finds leads, contacts, proposals and clients", () => withCrm((root, db) => {
    const a = add(db, { name: "Rooty Hill Dental", emails: ["frontdesk@rootyhill.example"], phone: "02 9625 7777" });
    add(db, { name: "Other Place" });
    logActivity(db, a, { kind: "note", outcome: "proposal" });
    const c = add(db, { name: "Rooty Realty" });
    recordWin(db, c, { scope: "Website", by: "usman" });
    const hits = searchCrm(root, db, "rooty").hits;
    expect(hits.filter((h) => h.group === "leads").map((h) => h.title)).toEqual(expect.arrayContaining(["Rooty Hill Dental", "Rooty Realty"]));
    expect(hits.find((h) => h.group === "proposals")?.leadId).toBe(a.id);
    expect(hits.find((h) => h.group === "clients")?.detail).toBe("Client · Website");
    expect(searchCrm(root, db, "frontdesk").hits.find((h) => h.group === "contacts")?.title).toBe("frontdesk@rootyhill.example");
    expect(searchCrm(root, db, "9625 7777").hits.find((h) => h.group === "contacts")?.title).toBe("02 9625 7777");
    expect(searchCrm(root, db, "r").hits).toEqual([]);
    expect(searchCrm(root, db, "100%_").hits).toEqual([]);
  }));
});

describe("migration", () => {
  test("additive and idempotent over an existing CRM file: data kept, tables added once", () => {
    const root = mkdtempSync(join(tmpdir(), "deals-migrate-"));
    try {
      const file = join(root, "crm.sqlite");
      // A CRM as it was before this change: every table except the two new ones, with data.
      const old = openCrm(file);
      old.exec("DROP TABLE lead_deals; DROP TABLE crm_settings;");
      add(old, { name: "Kept Dental" });
      logActivity(old, findLead(old, 1)!, { kind: "call", outcome: "interested" });
      old.close();
      const a = openCrm(file);
      saveDeal(a, 1, { contactPref: "SMS only" });
      a.close();
      const b = openCrm(file); // second run must not throw or reset anything
      expect(b.query("SELECT count(*) AS n FROM leads").get()).toEqual({ n: 1 });
      expect(findLead(b, 1)).toMatchObject({ name: "Kept Dental", status: "interested" });
      expect(b.query("SELECT count(*) AS n FROM activities").get()).toEqual({ n: 1 });
      expect(readDeal(b, 1).contactPref).toBe("SMS only");
      const tables = (b.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(["lead_deals", "crm_settings"]));
      b.close();
    } finally {
      Bun.gc(true); // Windows keeps a closed SQLite file locked until its handle is collected
      try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir; the OS cleans it */ }
    }
  });
});

describe("api routes", () => {
  test("overview, deal save, move, rules, search and list with deals", () => withCrm(async (root, db) => {
    const api = createLeadsApi(root, { db, hunt: () => ({ status: "never", ranAt: null, area: null, added: 0, errors: [], overdue: false }) as any });
    const lead = add(db, { name: "Api Dental" });
    const p = new URLSearchParams();
    expect((await api.handle("/leads/overview", "GET", null, p, false) as any).sentence).toMatch(/deals? stuck.$/);
    const saved = await api.handle("/leads/deal", "POST", { lead: lead.id, setupCents: 150_000, probability: "", contactPref: "Text before calling", by: "usman" }, p, false) as any;
    expect([saved.deal.economics.setupCents, saved.deal.record.probability, saved.deal.contactPref]).toEqual([150_000, null, "Text before calling"]);
    await expect(api.handle("/leads/deal", "POST", { lead: lead.id, by: "someone" }, p, false)).rejects.toThrow("by must be");
    const moved = await api.handle("/leads/move", "POST", { lead: lead.id, to: "replied", by: "usman" }, p, false) as any;
    expect(moved.pipeline.stage).toBe("replied");
    expect((await api.handle("/leads/rules", "POST", { stuckDays: { replied: 4 } }, p, false) as any).stuckDays.replied).toBe(4);
    const list = await api.handle("/leads/list", "GET", null, new URLSearchParams("deals=1"), false) as any;
    expect(list.leads[0].deal).toMatchObject({ stage: "replied", contactPref: "Text before calling" });
    expect((await api.handle("/leads/list", "GET", null, p, false) as any).leads[0].deal).toBeUndefined();
    const detail = await api.handle("/leads/detail", "GET", null, new URLSearchParams(`id=${lead.id}`), false) as any;
    expect(detail.deal.timeline.at(-1).stage).toBe("replied");
    expect((await api.handle("/leads/search", "GET", null, new URLSearchParams("q=api"), false) as any).hits[0].title).toBe("Api Dental");
  }));
});

describe("contact preference and call queue", () => {
  test("the call-prep card carries the contact preference into the script header", () => withCrm((_root, db) => {
    const lead = add(db);
    expect(buildCard(db, lead).contactPref).toBe("");
    saveDeal(db, lead.id, { contactPref: "Text first, mornings only" });
    const card = buildCard(db, findLead(db, lead.id)!);
    expect(card.contactPref).toBe("Text first, mornings only");
    expect(renderCard(card).split("\n")[1]).toBe("How they like to be contacted: Text first, mornings only");
  }));
  test("today's call count follows the founders' daily targets, not the whole backlog", () => withCrm((root, db) => {
    for (let i = 0; i < 15; i++) add(db, { name: `Lead ${i}` });
    const opts = { now: NOW, receivables: [] };
    expect(crmOverview(root, db, opts).callsToday).toBe(10); // no targets set: a default of 10
    setGoal(db, "usman", 3); setGoal(db, "mehroz", 2);
    const o = crmOverview(root, db, opts);
    expect(o.callsToday).toBe(5);
    expect(o.sentence.startsWith("5 on today's call sheet (0 due)")).toBe(true); // first calls only: none are call-backs due
    const night = crmOverview(root, db, { ...opts, now: new Date("2026-09-25T11:00:00Z") }); // 9pm Sydney
    expect(night.sentence.startsWith("Calling hours are closed: 5 on the call sheet for the next calling window (0 due)")).toBe(true);
  }));
});
