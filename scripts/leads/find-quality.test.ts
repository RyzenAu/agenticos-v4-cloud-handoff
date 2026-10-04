import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { friendlyFindError, validateFindBody } from "./api";
import { findLead, openCrm, upsertLead } from "./crm";
import { findLeads } from "./engine";
import { findLeadsOsm, normaliseOsmElement, dedupeOsmLeads, tableBbox, AREA_BBOX, type OsmLead } from "./osm";
import type { DiscoveryDeps, DiscoveryInput } from "./discovery";

const noHits: DiscoveryDeps = {
  guessSearch: async () => null, searxngSearch: async () => null, hermesSearch: async () => null,
};
const element = (id: number, name: string, website = "") => ({
  type: "node", id, tags: { name, website, phone: `(02) 9000 ${String(id).padStart(4, "0")}`, "addr:postcode": "2770" },
});
function sourceFetch(elements: unknown[], other?: (url: string) => Response): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("overpass-api.de")) return Response.json({ elements });
    if (other) return other(url);
    throw new Error(`Unexpected request in synthetic test: ${url}`);
  }) as typeof fetch;
}
async function withCrm(run: (db: ReturnType<typeof openCrm>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "find-quality-"));
  const db = openCrm(join(dir, "crm.sqlite"));
  try { await run(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe("bounded discovery input", () => {
  test("validates a source website filter and keeps free OSM as the default", () => {
    expect(validateFindBody({ vertical: "dental", area: "  Mount   Druitt NSW  ", websitePresence: "missing" }))
      .toEqual({ vertical: "dental", area: "Mount Druitt NSW", max: 20, source: "osm", websitePresence: "missing" });
    expect(() => validateFindBody({ vertical: "dental", area: "Sydney", websitePresence: "verified" })).toThrow(/websitePresence/);
    expect(() => validateFindBody({ vertical: "dental", area: "Sydney", websitePresence: "missing", source: "google" })).toThrow(/OpenStreetMap only/);
    expect(() => validateFindBody({ vertical: "dental", area: "Sydney", websitePresence: null })).toThrow(/websitePresence/);
  });
  test("rejects malformed or silently truncated locations before any lookup", () => {
    for (const area of [{ city: "Sydney" }, ["Sydney"], 123]) {
      expect(() => validateFindBody({ vertical: "dental", area })).toThrow(/Area must/);
    }
    for (const area of ["Sydney\nNSW", "Sydney\0", "x".repeat(121)]) {
      expect(() => validateFindBody({ vertical: "dental", area })).toThrow(/Area must/);
    }
    expect(() => validateFindBody({ vertical: "dental", area: "   " })).toThrow(/Say where/);
    expect(tableBbox("  Mount  Druitt, NSW, Australia ")).toEqual(AREA_BBOX["mount druitt"]);
  });
  test("reports the actual provider when a search is refused", () => {
    expect(friendlyFindError(new Error("Overpass 403: Forbidden"), "osm").message).toBe("Overpass 403: Forbidden");
    expect(friendlyFindError(new Error("PERMISSION_DENIED"), "google").message).toContain("enable Places API");
  });
  test("the engine rejects the unsupported paid-filter combination before requesting a key or provider", async () => {
    await withCrm(async (db) => {
      let calls = 0;
      const request = (async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
      await expect(findLeads(db, { vertical: "dental", area: "Sydney", source: "google", websitePresence: "missing", request }))
        .rejects.toThrow(/OpenStreetMap only/);
      await expect(findLeads(db, { vertical: "dental", area: "x".repeat(121), request })).rejects.toThrow(/120 characters/);
      expect(calls).toBe(0);
    });
  });
});

describe("missing-site candidate discovery", () => {
  test("uses an explicit business locality for a broad region search without changing stored provenance", async () => {
    await withCrm(async (db) => {
      const source = element(1, "Locality Dental");
      const observed: DiscoveryInput[] = [];
      const result = await findLeadsOsm(db, {
        vertical: "dental", area: "Greater Sydney", enrichMax: 0,
        request: sourceFetch([{ ...source, tags: { ...source.tags, "addr:suburb": "Blacktown", "addr:city": "Sydney", "addr:postcode": "2148" } }]),
        discovery: { ...noHits, guessSearch: async (input) => { observed.push(input); return null; } },
      });
      expect(observed).toEqual([{
        name: "Locality Dental", suburb: "Blacktown", postcode: "2148", vertical: "dental",
        phone: "(02) 9000 0001", address: "Blacktown NSW 2148",
      }]);
      expect(result.area).toBe("Greater Sydney");
      expect(result.added[0]).toMatchObject({ area: "Greater Sydney", source: "osm", attribution: "© OpenStreetMap contributors" });
    });
  });
  test("keeps explicit locality tags through dedupe and conservatively normalizes an untagged search area", async () => {
    const first = normaliseOsmElement(element(1, "Locality Dental")) as OsmLead;
    const source = element(2, "Locality Dental");
    const second = normaliseOsmElement({ ...source, type: "way", tags: { ...source.tags, "addr:locality": "Rooty Hill" } }) as OsmLead;
    expect(dedupeOsmLeads([first, second])[0].locality).toBe("Rooty Hill");
    expect(first.locality).toBe("");
    await withCrm(async (db) => {
      const observed: DiscoveryInput[] = [];
      const result = await findLeadsOsm(db, {
        vertical: "dental", area: "Mount Druitt, NSW, Australia", enrichMax: 0,
        request: sourceFetch([element(1, "Untagged Dental")]),
        discovery: { ...noHits, guessSearch: async (input) => { observed.push(input); return null; } },
      });
      expect(observed[0].suburb).toBe("Mount Druitt");
      expect(result.added[0].area).toBe("Mount Druitt, NSW, Australia");
    });
  });
  test("filters before the cap, reports coverage, and does not alter a known user-corrected lead", async () => {
    await withCrm(async (db) => {
      const known = upsertLead(db, {
        placeId: "osm:node/1", source: "osm", vertical: "dental", area: "Owner's area", name: "Owner's corrected name",
        phone: "0412 345 678", address: "Owner's address", website: "https://corrected.example/", mapsUrl: "", rating: null, reviews: null,
        emails: [], emailOk: false, score: 20, pitch: "audit_pending", reasons: ["Owner's note"], googleAt: null,
      });
      const before = findLead(db, known.id);
      const result = await findLeadsOsm(db, {
        vertical: "dental", area: "Mount Druitt NSW", websitePresence: "missing", max: 1, enrichMax: 0,
        discovery: noHits, request: sourceFetch([
          element(1, "Source old name"), element(2, "Listed Dental", "https://listed.example/"),
          element(3, "Missing Dental"), element(4, "Next Dental"),
        ]),
      });
      expect(result).toMatchObject({ searched: 4, alreadyKnown: 1, matched: 2, filteredOut: 1, limited: 1, websitePresence: "missing", unverifiable: 0 });
      expect(result.added.map((lead) => lead.placeId)).toEqual(["osm:node/3"]);
      expect(result.added[0].websiteCheckedAt).toBeTruthy();
      expect(findLead(db, known.id)).toEqual(before);
      expect(findLead(db, "osm:node/2")).toBeNull();
      expect(findLead(db, "osm:node/4")).toBeNull();
    });
  });
  test("all remains the default and source selection never establishes website absence", async () => {
    await withCrm(async (db) => {
      const result = await findLeadsOsm(db, {
        vertical: "dental", area: "Mount Druitt NSW", enrichMax: 0, discovery: noHits,
        request: sourceFetch([element(1, "Listed Dental", "https://listed.example/"), element(2, "Missing Dental")]),
      });
      expect(result).toMatchObject({ websitePresence: "all", searched: 2, matched: 2, filteredOut: 0, limited: 0 });
      expect(result.added).toHaveLength(2);
    });
  });
  test("a candidate can gain a discovered website and stays in the result with a measured count", async () => {
    await withCrm(async (db) => {
      const result = await findLeadsOsm(db, {
        vertical: "dental", area: "Mount Druitt NSW", websitePresence: "missing", enrichMax: 0,
        request: sourceFetch([element(1, "Found Dental")]),
        discovery: { ...noHits, guessSearch: async () => ({ url: "https://found.example/", source: "guess", confidence: 0.9, checkedAt: "2026-10-01T00:00:00Z" }) },
      });
      expect(result).toMatchObject({ matched: 1, discovered: 1, noWebsite: 0, unverifiable: 0 });
      expect(result.added[0].website).toBe("https://found.example/");
      expect(result.added[0].websiteSource).toBe("discovered_guess");
    });
  });
  test("blocked website checks remain audit pending without a timestamp that could certify absence", async () => {
    await withCrm(async (db) => {
      const result = await findLeadsOsm(db, {
        vertical: "dental", area: "Mount Druitt NSW", websitePresence: "missing", enrichMax: 0,
        request: sourceFetch([element(1, "Blocked Dental")], () => new Response("Forbidden", { status: 403 })),
        discovery: { ...noHits, searxngSearch: async () => ({ url: "https://blocked.example/", source: "searxng", confidence: 0.9, checkedAt: "2026-10-01T00:00:00Z" }) },
      });
      expect(result).toMatchObject({ noWebsite: 1, discovered: 0, unverifiable: 1 });
      expect(result.added[0]).toMatchObject({ website: "", websiteCheckedAt: null, pitch: "audit_pending", score: 0, emailOk: false });
      expect(result.added[0].reasons).toEqual(["site found but unverifiable (checked 2026-10-01)"]);
      expect(result.added[0].reasons.join(" ")).not.toContain("no website found");
    });
  });
  test("complementary duplicate OSM tags keep listed websites out of missing-only selection", async () => {
    const first = normaliseOsmElement(element(1, "Duplicate Dental")) as OsmLead;
    const second = normaliseOsmElement({ ...element(2, "Duplicate Dental", "https://duplicate.example/"), type: "way" }) as OsmLead;
    const deduped = dedupeOsmLeads([first, second]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ sourceId: first.sourceId, website: second.website, phone: first.phone });
    expect(first.website).toBe(""); // source fixtures are not mutated
    await withCrm(async (db) => {
      const result = await findLeadsOsm(db, {
        vertical: "dental", area: "Mount Druitt NSW", websitePresence: "missing", discovery: noHits,
        request: sourceFetch([element(1, "Duplicate Dental"), { ...element(2, "Duplicate Dental", "https://duplicate.example/"), type: "way" }]),
      });
      expect(result).toMatchObject({ searched: 1, matched: 0, filteredOut: 1, limited: 0 });
      expect(result.added).toHaveLength(0);
    });
  });
});
