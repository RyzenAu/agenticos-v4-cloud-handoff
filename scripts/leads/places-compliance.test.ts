// Google Places compliance (27 Sep 2026): the CRM stores a Google lead's place ID only; details
// are fetched live per request with attribution; the cleanup and wrong-website scripts are dry-run
// by default. All Places responses here are fixtures — nothing reaches Google.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLeadsApi } from "./api";
import { buildCard, renderCard } from "./card";
import { generateCallScript, PLACES_NAME_PLACEHOLDER, scriptPath } from "./call-script";
import { activities, callList, findLead, openCrm, upsertLead, type UpsertLeadInput } from "./crm";
import { applyWrongWebsiteFix, NOT_VERIFIED_REASON, planWrongWebsiteFix } from "./fix-wrong-website";
import { applyPlacesCleanup, planPlacesCleanup } from "./places-cleanup";
import { defaultPlacesLookup, hydrateLead, placesSession, type PlacesLookup } from "./places-live";
import type { PlaceDetails } from "./places";
import { rescanLead } from "./rescan";

const GOOGLE_ID = "ChIJgoogle00000001";

const DETAILS: PlaceDetails = {
  placeId: GOOGLE_ID, name: "Live Smile Dental", address: "1 Live St, Rooty Hill NSW 2766", phone: "(02) 9000 1111",
  website: "https://livesmile.example.com.au/", rating: 4.6, reviews: 88, status: "OPERATIONAL",
  mapsUrl: "https://maps.google.com/?cid=1", hours: ["Monday: 9:00 AM – 5:00 PM", "Saturday: Closed"],
};

function fixtureLookup(counter: { n: number }, details: PlaceDetails = DETAILS): PlacesLookup {
  return async (placeId) => {
    counter.n++;
    return { ...details, placeId };
  };
}

const base: Omit<UpsertLeadInput, "placeId"> = {
  vertical: "dental", area: "Rooty Hill NSW", name: "", phone: "", address: "", website: "", mapsUrl: "",
  rating: null, reviews: null, emails: [], emailOk: false, score: 50, pitch: "receptionist",
  reasons: ["the site isn't on HTTPS"], googleAt: null,
};

function tempCrm(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, db: openCrm(join(dir, ".operator-data", "crm.sqlite")), file: join(dir, ".operator-data", "crm.sqlite") };
}

function seedGoogle(db: Database, extra: Partial<UpsertLeadInput> = {}) {
  return upsertLead(db, { ...base, placeId: GOOGLE_ID, source: "google", placesCheckedAt: "2026-09-27T00:00:00.000Z", ...extra });
}

function rawRow(db: Database, id: number) {
  return db.query("SELECT name, phone, address, website, maps_url, rating, reviews FROM leads WHERE id = ?").get(id) as Record<string, unknown>;
}

describe("places-live: fetched per request, cached in memory, attributed, never stored", () => {
  test("hydrates a Google lead's blanks with attribution, one lookup per place per session, and writes nothing", async () => {
    const { dir, db } = tempCrm("places-live-");
    try {
      const lead = seedGoogle(db, { emails: ["hello@livesmile.example.com.au"], fieldSources: { emails: "website" } });
      const counter = { n: 0 };
      const session = placesSession(fixtureLookup(counter));
      const live = await hydrateLead(lead, session);
      const again = await hydrateLead(lead, session);
      expect(counter.n).toBe(1); // in-memory cache for the request
      expect(again.name).toBe("Live Smile Dental");
      expect([live.name, live.phone, live.address, live.website, live.rating, live.reviews]).toEqual(
        ["Live Smile Dental", "(02) 9000 1111", "1 Live St, Rooty Hill NSW 2766", "https://livesmile.example.com.au/", 4.6, 88]);
      expect(live.placesLive?.attribution).toBe("Google Maps");
      expect(live.placesLive?.hours).toEqual(DETAILS.hours);
      expect(live.placesLive?.fields).toContain("name");
      expect(live.emails).toEqual(["hello@livesmile.example.com.au"]);
      // Nothing from the lookup reached the CRM.
      expect(rawRow(db, lead.id)).toEqual({ name: "", phone: "", address: "", website: "", maps_url: "", rating: null, reviews: null });
      // A fresh session (the next request) looks it up again: the cache doesn't outlive a request.
      await hydrateLead(lead, placesSession(fixtureLookup(counter)));
      expect(counter.n).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stored value with a recorded non-Places source wins over the live one; OSM leads are untouched", async () => {
    const { dir, db } = tempCrm("places-live-src-");
    try {
      const lead = seedGoogle(db, { phone: "(02) 9111 2222", fieldSources: { phone: "manual" } });
      const counter = { n: 0 };
      const live = await hydrateLead(lead, placesSession(fixtureLookup(counter)));
      expect(live.phone).toBe("(02) 9111 2222");
      expect(live.placesLive?.fields).not.toContain("phone");
      const osm = upsertLead(db, { ...base, placeId: "osm:node/1", name: "OSM Dental", source: "osm", attribution: "© OpenStreetMap contributors" });
      const same = await hydrateLead(osm, placesSession(fixtureLookup(counter)));
      expect(same).toEqual(osm);
      expect(counter.n).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed or unconfigured lookup is explained, still attributed, and not cached", async () => {
    const { dir, db } = tempCrm("places-live-err-");
    try {
      const lead = seedGoogle(db);
      let calls = 0;
      const flaky: PlacesLookup = async () => {
        calls++;
        if (calls === 1) throw new Error("Places API 503: backend error");
        return DETAILS;
      };
      const session = placesSession(flaky);
      const failed = await hydrateLead(lead, session);
      expect(failed.placesLive?.error).toMatch(/503/);
      expect(failed.placesLive?.attribution).toBe("Google Maps");
      expect(failed.mapsUrl).toContain(`query_place_id=${GOOGLE_ID}`); // built from the place ID alone
      expect((await hydrateLead(lead, session)).name).toBe("Live Smile Dental"); // failure wasn't cached
      const none = await hydrateLead(lead, placesSession(null));
      expect(none.placesLive?.error).toMatch(/isn't configured/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default lookup never uses the real key under bun test, and refuses once the monthly budget is spent", async () => {
    const { dir, db } = tempCrm("places-live-budget-");
    try {
      expect(defaultPlacesLookup(db)).toBeNull();
      const hosts: string[] = [];
      const request = (async (url: string) => {
        hosts.push(new URL(String(url)).host);
        return new Response(JSON.stringify({ displayName: { text: "Fixture Dental" }, businessStatus: "OPERATIONAL" }), { headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch;
      const lookup = defaultPlacesLookup(db, { key: "fixture-key", request, budget: 1 })!;
      expect((await lookup(GOOGLE_ID)).name).toBe("Fixture Dental");
      await expect(lookup(GOOGLE_ID)).rejects.toThrow(/budget/);
      expect(hosts).toEqual(["places.googleapis.com"]); // the fixture fetch, once
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("display surfaces show live Google data with attribution", () => {
  test("card text carries the attribution line; a Google lead with no stored phone still makes the call list", async () => {
    const { dir, db } = tempCrm("places-card-");
    try {
      const lead = seedGoogle(db);
      expect(callList(db).map((l) => l.id)).toEqual([lead.id]);
      const live = await hydrateLead(lead, placesSession(fixtureLookup({ n: 0 })));
      const card = buildCard(db, live);
      expect(card.name).toBe("Live Smile Dental");
      expect(card.phone).toBe("(02) 9000 1111");
      const text = renderCard(card);
      expect(text).toContain("Place details live from Google Maps (not stored)");
      expect(text).toContain("Saturday: Closed");
      // Without a live lookup the card says so instead of showing a stale copy.
      expect(buildCard(db, lead).name).toBe("(Google place: live details unavailable)");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("API detail/card/cards/calls hydrate live with attribution and leave the CRM row blank", async () => {
    const { dir, db } = tempCrm("places-api-");
    try {
      const lead = seedGoogle(db);
      const counter = { n: 0 };
      const api = createLeadsApi(dir, { db, placesLookup: fixtureLookup(counter), hunt: () => ({ status: "never" }) as any });
      const detail = (await api.handle("/leads/detail", "GET", {}, new URLSearchParams({ id: String(lead.id) }), false)) as any;
      expect(detail.lead.name).toBe("Live Smile Dental");
      expect(detail.lead.placesLive.attribution).toBe("Google Maps");
      const card = (await api.handle("/leads/card", "GET", {}, new URLSearchParams({ id: String(lead.id) }), false)) as any;
      expect(card.placesLive.attribution).toBe("Google Maps");
      const cards = (await api.handle("/leads/cards", "GET", {}, new URLSearchParams({ n: "5" }), false)) as any;
      expect(cards.cards[0].name).toBe("Live Smile Dental");
      const calls = (await api.handle("/leads/calls", "GET", {}, new URLSearchParams(), false)) as any;
      expect(calls.leads[0].phone).toBe("(02) 9000 1111");
      expect(calls.leads[0].placesLive.attribution).toBe("Google Maps");
      expect(counter.n).toBe(4); // one per request: each request has its own in-memory cache
      // The list view is not hydrated (no bulk lookups) and nothing was written.
      const list = (await api.handle("/leads/list", "GET", {}, new URLSearchParams(), false)) as any;
      expect(list.leads[0].name).toBe("");
      expect(rawRow(db, lead.id)).toEqual({ name: "", phone: "", address: "", website: "", maps_url: "", rating: null, reviews: null });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the call-script prompt never carries a Google lead's live name, so neither the model nor the cached script holds it", async () => {
    const { dir, db } = tempCrm("places-script-");
    try {
      const lead = await hydrateLead(seedGoogle(db), placesSession(fixtureLookup({ n: 0 })));
      const prompts: string[] = [];
      const reply = { opener: `Hi, is that ${PLACES_NAME_PLACEHOLDER}? It's Usman from M&U Ventures.`, discovery: ["q"], valuePitch: "v",
        objections: { price: "p", already_have_website: "a", send_email: "s", not_now: "n", ask_partner: "k" }, close: "c",
        followupEmail: { subject: "s", body: "Reply STOP to opt out." } };
      const complete = async (body: any) => {
        prompts.push(body.messages.map((m: any) => m.content).join("\n"));
        return { choices: [{ message: { content: JSON.stringify(reply) } }] };
      };
      await generateCallScript(db, lead, { root: dir, complete });
      expect(prompts[0]).toContain(`Business: ${PLACES_NAME_PLACEHOLDER}`);
      expect(prompts[0]).not.toContain("Live Smile Dental");
      expect(prompts[0]).not.toContain("9000 1111");
      expect(readFileSync(scriptPath(dir, lead.id), "utf8")).not.toContain("Live Smile Dental");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("call-script model chain", () => {
  test("Claude, then Cline DeepSeek V4.1 Flash, then Cline Muse Spark 1.3 — and no paid MiMo fallback", async () => {
    const source = readFileSync(join(import.meta.dir, "call-script.ts"), "utf8");
    expect(source).not.toMatch(/callMimo|mimoBulkEnabled|MIMO_MODELS|llm\/mimo/);
    const { FREE_SCRIPT_MODELS } = await import("./call-script");
    expect([...FREE_SCRIPT_MODELS]).toEqual(["deepseek-v4.1-flash", "muse-spark-1.3"]);
    const { CLINE_BRIDGE_MODELS } = await import("../cline-bridge");
    for (const model of FREE_SCRIPT_MODELS) expect(model in CLINE_BRIDGE_MODELS).toBe(true);

    const { dir, db } = tempCrm("places-chain-");
    const prev = process.env.MIMO_BULK;
    process.env.MIMO_BULK = "1"; // even with the old opt-in flag set, nothing paid is tried
    try {
      const lead = upsertLead(db, { ...base, placeId: "osm:node/5", name: "Chain Dental", source: "osm", attribution: "© OpenStreetMap contributors" });
      const tried: string[] = [];
      const claude = async () => {
        throw new Error("Claude usage limit reached");
      };
      const free = async (body: any) => {
        tried.push(body.model);
        throw new Error("free model down");
      };
      await expect(generateCallScript(db, lead, { root: dir, complete: claude, free })).rejects.toThrow("Claude usage limit reached");
      expect(tried).toEqual(["deepseek-v4.1-flash", "muse-spark-1.3"]);
    } finally {
      if (prev === undefined) delete process.env.MIMO_BULK;
      else process.env.MIMO_BULK = prev;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A CRM shaped like one written before this change: Google rows with Places content stored. */
function seedLegacy(db: Database, dir: string) {
  const g1 = upsertLead(db, {
    ...base, placeId: "ChIJlegacy000000001", name: "Legacy Dental", phone: "(02) 9000 0001", address: "2 Old Rd",
    website: "https://legacy.example.com.au/", mapsUrl: "https://maps.google.com/?cid=2", rating: 3.9, reviews: 12,
    emails: ["front@legacy.example.com.au"], emailOk: true,
    reasons: ["the site isn't on HTTPS", "there are only 12 Google reviews", "the Google rating is 3.9", "after-hours calls go unanswered (closed evenings or weekends)"],
    googleAt: "2026-08-01T00:00:00.000Z",
  }); // source defaults to "google", exactly like pre-OSM rows
  // Website found by our own discovery and a phone confirmed by a founder: not Places content.
  const g2 = upsertLead(db, {
    ...base, placeId: "ChIJlegacy000000002", name: "Checked Dental", phone: "(02) 9000 0002", address: "3 Old Rd",
    website: "https://checked.example.com.au/", websiteSource: "discovered_searxng", rating: 4.9, reviews: 300,
    fieldSources: { phone: "manual" }, googleAt: "2026-09-20T00:00:00.000Z",
  });
  const osm = upsertLead(db, {
    ...base, placeId: "osm:node/77", name: "OSM Dental", phone: "(02) 9000 0077", address: "7 Map St",
    website: "https://osm.example.com.au/", mapsUrl: "https://www.openstreetmap.org/node/77", source: "osm", attribution: "© OpenStreetMap contributors",
  });
  mkdirSync(join(dir, ".operator-data", "leads", "call-scripts"), { recursive: true });
  writeFileSync(scriptPath(dir, g1.id), JSON.stringify({ opener: "Hi Legacy Dental" }));
  writeFileSync(scriptPath(dir, osm.id), JSON.stringify({ opener: "Hi OSM Dental" }));
  return { g1, g2, osm };
}

describe("places-cleanup: removes stored Places content, keeps place_id and non-Places fields", () => {
  test("dry run counts only and writes nothing; --apply clears exactly the Places-sourced values", () => {
    const { dir, db } = tempCrm("places-cleanup-");
    try {
      const { g1, g2, osm } = seedLegacy(db, dir);
      const before = JSON.stringify(db.query("SELECT * FROM leads ORDER BY id").all());
      const plan = planPlacesCleanup(db, { root: dir });
      expect(plan).toEqual({
        googleRows: 2, rowsToChange: 2,
        clear: { name: 2, phone: 1, address: 2, website: 1, mapsUrl: 1, rating: 2, reviews: 2 },
        keptNonPlaces: { name: 0, phone: 1, address: 0, website: 1, mapsUrl: 0, rating: 0, reviews: 0 },
        reasonsToRemove: 3, googleAtToMove: 2, callScriptsToRemove: 1, applied: false,
      });
      expect(JSON.stringify(db.query("SELECT * FROM leads ORDER BY id").all())).toBe(before);
      expect(existsSync(scriptPath(dir, g1.id))).toBe(true);

      const applied = applyPlacesCleanup(db, { root: dir });
      expect(applied.applied).toBe(true);
      const a = findLead(db, g1.id)!;
      expect([a.placeId, a.name, a.phone, a.address, a.website, a.mapsUrl, a.rating, a.reviews]).toEqual(["ChIJlegacy000000001", "", "", "", "", "", null, null]);
      expect(a.emails).toEqual(["front@legacy.example.com.au"]); // from the practice's own site
      expect(a.reasons).toEqual(["the site isn't on HTTPS"]);
      expect([a.googleAt, a.placesCheckedAt]).toEqual([null, "2026-08-01T00:00:00.000Z"]);
      expect(existsSync(scriptPath(dir, g1.id))).toBe(false);
      const b = findLead(db, g2.id)!;
      expect([b.phone, b.website, b.name, b.rating]).toEqual(["(02) 9000 0002", "https://checked.example.com.au/", "", null]);
      // OSM rows and their cached scripts are never touched.
      expect(findLead(db, osm.id)).toEqual(osm);
      expect(existsSync(scriptPath(dir, osm.id))).toBe(true);
      // Idempotent: a second run has nothing left to do.
      expect(planPlacesCleanup(db, { root: dir }).rowsToChange).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Runs the real CLI twice as separate bun processes (start-up plus module load each).
  // Measured 3.5 s under load against the 5 s default; 15 s is about 3x that + headroom.
  test("the CLI is a read-only dry run by default (no schema migration either) and writes only with --apply", () => {
    const { dir, db, file } = tempCrm("places-cleanup-cli-");
    try {
      seedLegacy(db, dir);
      db.exec("ALTER TABLE leads DROP COLUMN field_sources"); // look like a CRM from before this change
      db.close();
      const copy = join(dir, "copy.sqlite");
      copyFileSync(file, copy);
      const bytes = readFileSync(copy);
      const script = resolve(import.meta.dir, "places-cleanup.ts");
      const dry = Bun.spawnSync(["bun", script, "--db", copy, "--root", dir], { env: { ...process.env } });
      const out = dry.stdout.toString();
      expect(dry.exitCode).toBe(0);
      expect(out).toContain("DRY RUN (nothing written)");
      expect(out).toContain("Google-sourced leads: 2 · leads to change: 2");
      expect(readFileSync(copy).equals(bytes)).toBe(true);
      const wet = Bun.spawnSync(["bun", script, "--db", copy, "--root", dir, "--apply"], { env: { ...process.env } });
      expect(wet.exitCode).toBe(0);
      expect(wet.stdout.toString()).toContain("APPLIED");
      const check = new Database(copy, { readonly: true });
      expect((check.query("SELECT COUNT(*) AS n FROM leads WHERE source = 'google' AND name != ''").get() as any).n).toBe(0);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("fix-wrong-website: lead #252's dental.com.au", () => {
  function seed252(db: Database, dir: string) {
    const lead = upsertLead(db, {
      ...base, placeId: "osm:node/7844965971", area: "Greater Sydney", name: "Dental Surgery", phone: "+61 2 9698 1273",
      website: "https://dental.com.au/", websiteSource: "discovered_guess", websiteConfidence: 0.4, websiteCheckedAt: "2026-09-24T15:59:30.087Z",
      emails: ["info@dental.com.au"], emailOk: true, score: 42,
      reasons: ["Phone is the only way in — seen on https://dental.com.au/ (2026-09-25)"], source: "osm", attribution: "© OpenStreetMap contributors",
    });
    const dup = upsertLead(db, {
      ...base, placeId: "osm:node/13399495261", area: "Greater Sydney", name: "Dental Surgery", phone: "+61 2 9797 0334",
      website: "https://dental.com.au/", websiteSource: "discovered_guess", source: "osm", attribution: "© OpenStreetMap contributors",
      excluded: true, excludedReason: "duplicate of #1 (Dental Surgery) — matched by domain (dental.com.au)",
    });
    db.query("UPDATE leads SET merged_into = ? WHERE id = ?").run(lead.id, dup.id);
    db.exec("CREATE TABLE IF NOT EXISTS lead_issues (lead_id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, report TEXT NOT NULL)");
    db.query("INSERT INTO lead_issues (lead_id, checked_at, report) VALUES (?, '2026-09-25', '{}')").run(lead.id);
    mkdirSync(join(dir, ".operator-data", "leads", "call-scripts"), { recursive: true });
    writeFileSync(scriptPath(dir, lead.id), "{}");
    return { lead, dup };
  }

  test("dry run describes the fix without writing; --apply clears both, marks not verified, and notes it", () => {
    const { dir, db } = tempCrm("fix-252-");
    try {
      const { lead, dup } = seed252(db, dir);
      const before = JSON.stringify(db.query("SELECT * FROM leads ORDER BY id").all());
      const plan = planWrongWebsiteFix(db, { leadId: lead.id, domain: "dental.com.au", root: dir, unmerge: true });
      expect(plan.fixes.map((f) => f.leadId)).toEqual([lead.id, dup.id]);
      expect(plan.fixes[0]).toMatchObject({ emailsDropped: ["info@dental.com.au"], issuesAuditRemoved: true });
      expect(plan.suspectMerges).toEqual([{ leadId: dup.id, mergedInto: lead.id, reason: expect.stringContaining("dental.com.au") }]);
      expect(JSON.stringify(db.query("SELECT * FROM leads ORDER BY id").all())).toBe(before);

      applyWrongWebsiteFix(db, { leadId: lead.id, domain: "dental.com.au", root: dir, unmerge: true, by: "usman" });
      const fixed = findLead(db, lead.id)!;
      expect([fixed.website, fixed.websiteSource, fixed.websiteConfidence, fixed.pitch, fixed.score]).toEqual(["", "not_verified", null, "audit_pending", 0]);
      expect(fixed.reasons).toEqual([NOT_VERIFIED_REASON]);
      expect(fixed.reasons[0]).toBe("website not verified — owner to Google");
      expect([fixed.emails, fixed.emailOk, fixed.phone]).toEqual([[], false, "+61 2 9698 1273"]);
      expect(db.query("SELECT 1 FROM lead_issues WHERE lead_id = ?").get(lead.id)).toBeNull();
      expect(existsSync(scriptPath(dir, lead.id))).toBe(false);
      expect(activities(db, lead.id)[0].note).toMatch(/Website cleared: https:\/\/dental\.com\.au\/ .*owner to Google/);
      const restored = findLead(db, dup.id)!;
      expect([restored.website, restored.excluded, restored.mergedInto]).toEqual(["", false, null]);
      expect(activities(db, dup.id)[0].note).toMatch(/Dropped 1 reason\(s\) taken from that site\. Un-merged from #\d+/);
      expect(activities(db, lead.id)[0].note).toContain("Dropped 1 reason(s), the issues audit and 1 email(s) taken from that site.");
      // Nothing left to fix: a second run refuses rather than guessing.
      expect(() => planWrongWebsiteFix(db, { leadId: lead.id, domain: "dental.com.au" })).toThrow(/nothing to fix/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without --unmerge the suspect merge is reported but left alone", () => {
    const { dir, db } = tempCrm("fix-252-keep-");
    try {
      const { lead, dup } = seed252(db, dir);
      applyWrongWebsiteFix(db, { leadId: lead.id, domain: "https://www.dental.com.au", root: dir });
      const kept = findLead(db, dup.id)!;
      expect([kept.website, kept.excluded, kept.mergedInto]).toEqual(["", true, lead.id]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rescan never re-guesses a website marked not verified", async () => {
    const { dir, db } = tempCrm("fix-252-rescan-");
    try {
      const { lead } = seed252(db, dir);
      applyWrongWebsiteFix(db, { leadId: lead.id, domain: "dental.com.au", root: dir });
      const requested: string[] = [];
      const request = (async (url: string) => {
        requested.push(String(url));
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      const change = await rescanLead(db, findLead(db, lead.id)!, { request, browserRetry: false, crawl4ai: false });
      expect(change.action).toBe("held for owner check");
      expect(requested).toEqual([]);
      expect(findLead(db, lead.id)!.website).toBe("");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
