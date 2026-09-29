import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, listLeads, openCrm, usage } from "./crm";
import { HUNT_REGIONS, runHunt } from "./osm-hunt";

describe("osm-hunt: regions", () => {
  test("Greater Sydney is first and matches the bbox the owner specified", () => {
    expect(HUNT_REGIONS[0]).toMatchObject({ key: "greater-sydney", bbox: { south: -34.1, west: 150.6, north: -33.6, east: 151.35 } });
  });

  test("covers Blue Mountains, Central Coast, Wollongong/Illawarra and Newcastle, in that order after Sydney", () => {
    expect(HUNT_REGIONS.map((r) => r.key)).toEqual(["greater-sydney", "blue-mountains", "central-coast", "wollongong-illawarra", "newcastle"]);
  });
});

function withHunt<T>(fn: (dir: string, db: ReturnType<typeof openCrm>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "osm-hunt-"));
  const db = openCrm(join(dir, ".operator-data", "crm.sqlite"));
  return fn(dir, db).finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

const SYDNEY_ELEMENTS = [
  // Excluded: a national chain by name.
  { type: "node", id: 1, lat: -33.8, lon: 151.0, tags: { name: "Pacific Smiles Dental", phone: "0299990001" } },
  // Low data: no phone, no website tag.
  { type: "node", id: 2, lat: -33.8, lon: 151.0, tags: { name: "Quiet Dental Surgery" } },
  // Has an OSM website tag already — no discovery needed.
  { type: "node", id: 3, lat: -33.8, lon: 151.0, tags: { name: "Tagged Dental", phone: "0299990003", website: "https://tagged-dental.example.au/" } },
  // No tag, but a domain guess should find it (guessWebsite tries name.com.au). Carries a real
  // OSM address (25 Sep 2026: pageMatchesBusiness now requires suburb/postcode/phone/street
  // corroboration when it has one on file, rather than passing on name alone — see discovery.ts).
  {
    type: "node", id: 4, lat: -33.8, lon: 151.0,
    tags: { name: "Guessable Dental", phone: "0299990004", "addr:housenumber": "12", "addr:street": "Test Street", "addr:suburb": "Testville", "addr:postcode": "2000" },
  },
];

function fakeFetch(calls: string[]) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("overpass-api.de")) {
      return new Response(JSON.stringify({ elements: SYDNEY_ELEMENTS }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n");
    if (url === "https://tagged-dental.example.au/") {
      return new Response(`<html><head><meta name="viewport" content="width=device-width"></head><body>Tagged Dental © 2025</body></html>`, { headers: { "Content-Type": "text/html" } });
    }
    if (url === "https://guessabledental.com.au/") {
      return new Response(`<html><head><meta name="viewport" content="width=device-width"></head><body>Guessable Dental, your local dentist in Testville. © 2025</body></html>`, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

// osm-hunt keeps a module-level 5 s pause between Overpass queries (and discovery.ts a 2 s pause
// between DuckDuckGo calls), keyed off the real clock. Each test below runs one Overpass query, so
// every test after the first really sleeps out most of that 5 s pause, which put "a second run
// resumes" right on bun's 5 s default timeout. The pauses are production behaviour shared with
// other test files through module state, so they are not faked here (a frozen clock leaked a
// future timestamp into later files' DuckDuckGo waits); each test gets a budget instead.
const OVERPASS_PAUSE_TEST_MS = 20_000; // up to 5 s pause + ~1 s work under load, x3
describe("osm-hunt: one region/vertical, network fully mocked", () => {
  test("excludes chains, marks low-data leads without spending a lookup, discovers by domain guess, and inserts as status new / source osm", async () => {
    await withHunt(async (dir, db) => {
      const calls: string[] = [];
      const progress = await runHunt({
        root: dir, db, request: fakeFetch(calls),
        regions: [HUNT_REGIONS[0]], verticals: ["dental"],
      });

      const rp = progress.regions["greater-sydney"]!.dental!;
      expect(rp.status).toBe("done");
      expect(rp.searched).toBe(4);
      expect(rp.excluded).toBe(1);
      expect(rp.lowData).toBe(1);
      expect(rp.added).toBe(2); // Tagged Dental + Guessable Dental

      const chain = findLead(db, "osm:node/1")!;
      expect(chain.excluded).toBe(true);
      expect(chain.excludedReason).toMatch(/pacific smiles/i);

      const lowData = findLead(db, "osm:node/2")!;
      expect(lowData.excluded).toBe(false);
      expect(lowData.reasons[0]).toMatch(/^low data/);
      expect(lowData.status).toBe("new");
      expect(lowData.source).toBe("osm");

      const tagged = findLead(db, "osm:node/3")!;
      expect(tagged.website).toBe("https://tagged-dental.example.au/");
      expect(tagged.websiteSource).toBe("osm_tag");

      const guessed = findLead(db, "osm:node/4")!;
      expect(guessed.website).toBe("https://guessabledental.com.au/");
      expect(guessed.websiteSource).toBe("discovered_guess");
      expect(guessed.status).toBe("new");
      expect(guessed.source).toBe("osm");

      // Low-data lead never got a discovery lookup — no DuckDuckGo/domain-guess fetch for it.
      expect(calls.some((c) => c.includes("quiet"))).toBe(false);
    });
  }, OVERPASS_PAUSE_TEST_MS);

  test("a second run resumes from the checkpoint and never re-inserts or re-queries Overpass for a done region", async () => {
    await withHunt(async (dir, db) => {
      const overpassCalls: string[] = [];
      const request = (async (input: string | URL) => {
        const url = String(input);
        if (url.includes("overpass-api.de")) overpassCalls.push(url);
        return fakeFetch([])(input);
      }) as typeof fetch;

      await runHunt({ root: dir, db, request, regions: [HUNT_REGIONS[0]], verticals: ["dental"] });
      expect(overpassCalls).toHaveLength(1);

      await runHunt({ root: dir, db, request, regions: [HUNT_REGIONS[0]], verticals: ["dental"] });
      expect(overpassCalls).toHaveLength(1); // still 1 — the second run saw "done" and skipped Overpass entirely

      expect(listLeads(db, { limit: 500 }).length).toBe(3); // no duplicate rows from the second run
    });
  }, OVERPASS_PAUSE_TEST_MS);

  test("caps Hermes lookups at the given budget, tracked via crm.ts's usage()/countCall, sku hermes_discovery", async () => {
    // Real (module-level) DuckDuckGo rate-limiting (>=2s between calls, discovery.ts) applies
    // here even with a mocked fetch — two leads' worth of guess+DDG+Hermes legitimately takes
    // longer than bun:test's 5s default.
    // Plus the up-to-5 s Overpass pause left by the previous test: about 8 s worst case, x3.
    await withHunt(async (dir, db) => {
      // Every candidate here fails the guess AND DuckDuckGo, forcing every discovery down to Hermes.
      const elements = [
        { type: "node", id: 10, lat: -33.8, lon: 151.0, tags: { name: "Unfindable Dental One", phone: "0299990010" } },
        { type: "node", id: 11, lat: -33.8, lon: 151.0, tags: { name: "Unfindable Dental Two", phone: "0299990011" } },
      ];
      const request = (async (input: string | URL) => {
        const url = String(input);
        if (url.includes("overpass-api.de")) return new Response(JSON.stringify({ elements }), { headers: { "Content-Type": "application/json" } });
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n");
        return new Response("not found", { status: 404 }); // guess + DuckDuckGo both fail
      }) as typeof fetch;

      let hermesCalls = 0;
      const hermesSearch = async () => {
        hermesCalls++;
        return null; // simulate Hermes finding nothing, so both leads end up "no website found"
      };
      const progress = await runHunt({
        root: dir, db, request, regions: [HUNT_REGIONS[0]], verticals: ["dental"], hermesBudget: 1, hermesSearch,
      });
      // The budget check (countCall) runs before hermesSearch is called — exactly once, per the cap.
      expect(usage(db).hermes_discovery).toBe(1);
      expect(hermesCalls).toBe(1); // the second lead hit the budget and never called Hermes at all
      const rp = progress.regions["greater-sydney"]!.dental!;
      expect(rp.noWebsiteFound).toBe(2); // both end up "no website found" — one via Hermes, one via the exhausted budget
    });
  }, 25_000);
});
