import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead } from "./crm";
import { purgeGoogleCache } from "./places-cleanup";
import { findLeadsOsm } from "./osm";
import { enrichWebsite, isDisallowed, looksPersonal } from "./enrich";
import { findLeads } from "./engine";
import {
  AREA_BBOX,
  buildOverpassQuery,
  dedupeOsmLeads,
  normaliseOsmElement,
  resolveBbox,
  SYDNEY_BBOX,
  tableBbox,
  type OsmLead,
} from "./osm";
import { analyseHtml } from "./site-audit";

describe("osm: area resolution", () => {
  test("the suburb table answers instantly, no network needed", async () => {
    expect(tableBbox("Mount Druitt NSW")).toEqual(AREA_BBOX["mount druitt"]);
    expect(tableBbox("blacktown")).toEqual(AREA_BBOX["blacktown"]);
    expect(tableBbox("Sydney")).toEqual(SYDNEY_BBOX);
    expect(tableBbox("Greater Sydney")).toEqual(SYDNEY_BBOX);
    expect(tableBbox("Nowhereville NSW")).toBeNull();
    const neverCalled = (async () => { throw new Error("should not fetch"); }) as typeof fetch;
    await expect(resolveBbox("Mount Druitt NSW", neverCalled)).resolves.toEqual(AREA_BBOX["mount druitt"]);
  });

  test("falls back to Nominatim for an area not in the table, rate-limited and identified", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const request = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
      return new Response(JSON.stringify([{ boundingbox: ["-33.90", "-33.80", "151.00", "151.10"] }]), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const bbox = await resolveBbox("Neverland NSW", request);
    expect(bbox).toEqual({ south: -33.9, north: -33.8, west: 151.0, east: 151.1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("nominatim.openstreetmap.org");
    expect(calls[0].url).toContain("countrycodes=au");
    expect(calls[0].headers["User-Agent"]).toContain("MU-Ventures-LeadEngine");
  });

  test("an area nowhere to be found throws a clear error", async () => {
    const request = (async () => new Response("[]", { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    await expect(resolveBbox("Nowhereville NSW", request)).rejects.toThrow(/Don't know where/);
  });
});

describe("osm: Overpass query + parsing", () => {
  test("the query asks for the right tag inside the bbox, with center for ways/relations", () => {
    const q = buildOverpassQuery("dental", SYDNEY_BBOX);
    expect(q).toContain('["amenity"="dentist"]');
    expect(q).toContain("-34.1,150.6,-33.6,151.35");
    expect(q).toContain("out center tags;");
    expect(buildOverpassQuery("legal", SYDNEY_BBOX)).toContain('["office"="lawyer"]');
    expect(buildOverpassQuery("real-estate", SYDNEY_BBOX)).toContain('["office"="estate_agent"]');
  });

  test("normalises a node element, a way with a center, and drops unnamed features", () => {
    const node = normaliseOsmElement({
      type: "node", id: 111, lat: -33.77, lon: 150.82,
      tags: { name: "Smile Dental", phone: "(02) 9621 1234", website: "http://smiledental.com.au", "addr:postcode": "2770", "addr:suburb": "Mount Druitt" },
    });
    expect(node).toMatchObject({ sourceId: "osm:node/111", name: "Smile Dental", phone: "(02) 9621 1234", postcode: "2770" });
    expect(node!.mapsUrl).toBe("https://www.openstreetmap.org/node/111");
    expect(node!.attribution).toBe("© OpenStreetMap contributors");

    const way = normaliseOsmElement({ type: "way", id: 222, center: { lat: -33.8, lon: 150.9 }, tags: { name: "Blacktown Realty", "contact:phone": "0299990000" } });
    expect(way).toMatchObject({ sourceId: "osm:way/222", phone: "0299990000" });

    expect(normaliseOsmElement({ type: "node", id: 3, tags: {} })).toBeNull(); // no name: not a callable lead
  });

  test("dedupes by OSM id, then by name+postcode", () => {
    const a: OsmLead = { sourceId: "osm:node/1", name: "Smile Dental", phone: "", website: "", email: "", address: "", postcode: "2770", lat: null, lon: null, mapsUrl: "", attribution: "x" };
    const dupeId = { ...a };
    const dupeNamePostcode = { ...a, sourceId: "osm:way/2" };
    const distinct = { ...a, sourceId: "osm:node/9", name: "Other Dental" };
    expect(dedupeOsmLeads([a, dupeId, dupeNamePostcode, distinct]).map((l) => l.sourceId)).toEqual(["osm:node/1", "osm:node/9"]);
  });
});

describe("enrich: robots.txt, personal-email flagging", () => {
  test("robots parsing: longest match wins, Allow overrides a shorter Disallow", () => {
    const robots = "User-agent: *\nDisallow: /\nAllow: /contact\n";
    expect(isDisallowed(robots, "/")).toBe(true);
    expect(isDisallowed(robots, "/contact")).toBe(false);
    expect(isDisallowed("User-agent: *\nDisallow:\n", "/anything")).toBe(false); // blank Disallow = allow all
  });

  test("looksPersonal flags firstname.lastname@freemail, not business addresses", () => {
    expect(looksPersonal("sarah.jones@gmail.com")).toBe(true);
    expect(looksPersonal("john_smith2@hotmail.com")).toBe(true);
    expect(looksPersonal("reception@smiledental.com.au")).toBe(false);
    expect(looksPersonal("info@gmail.com")).toBe(false); // no firstname.lastname shape
    expect(looksPersonal("sarah.jones@smiledental.com.au")).toBe(false); // own domain, not free webmail
  });

  test("enrichWebsite skips a site whose robots.txt disallows /, and never fetches it", async () => {
    const fetched: string[] = [];
    const request = (async (url: string) => {
      fetched.push(String(url));
      if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /\n");
      return new Response("<html>should never be reached</html>");
    }) as typeof fetch;
    const result = await enrichWebsite("https://blocked-site.example/", request);
    expect(result.robotsBlocked).toBe(true);
    expect(result.emails).toEqual([]);
    expect(fetched).toEqual(["https://blocked-site.example/robots.txt"]);
  });

  test("enrichWebsite reads the homepage when robots.txt allows it, and flags a personal email separately", async () => {
    const html = `<html><head><meta name="viewport" content="width=device-width"></head><body>
      Call (02) 9621 1234 or 1300 555 123. <a href="mailto:reception@smiledental.com.au">Email</a>
      <a href="mailto:sarah.jones@gmail.com">Sarah</a></body></html>`;
    const request = (async (url: string) => {
      if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n", { status: 200 });
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    const result = await enrichWebsite("https://smiledental.com.au/", request);
    expect(result.emails.map((e) => e.value)).toEqual(["reception@smiledental.com.au"]);
    expect(result.flaggedPersonal.map((e) => e.value)).toEqual(["sarah.jones@gmail.com"]);
    expect(result.emails[0].source).toBe("https://smiledental.com.au/");
    expect(result.phones).toContain("(02) 9621 1234");
  });
});

describe("site-audit: AU phone formats", () => {
  test("recognises landlines, tollfree/1800, and mobiles in several written forms", () => {
    expect(analyseHtml("Call (02) 9621 1234 today.").phones).toContain("(02) 9621 1234");
    expect(analyseHtml("Call +61 2 9621 1234 today.").phones).toContain("+61 2 9621 1234");
    expect(analyseHtml("Freecall 1300 555 123 or 1800 234 567.").phones).toEqual(expect.arrayContaining(["1300 555 123", "1800 234 567"]));
    expect(analyseHtml("Mobile 0412 345 678 after hours.").phones).toContain("0412 345 678");
  });
});

describe("osm: findLeadsOsm end-to-end (network mocked)", () => {
  function fakeFetch() {
    return (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("overpass-api.de")) {
        return new Response(
          JSON.stringify({
            elements: [
              { type: "node", id: 1, lat: -33.77, lon: 150.82, tags: { name: "Smile Dental", phone: "(02) 9621 1234", website: "https://smiledental.com.au", "addr:postcode": "2770" } },
              { type: "node", id: 2, lat: -33.77, lon: 150.83, tags: { name: "No Site Dental", phone: "(02) 9000 0000", "addr:postcode": "2770" } },
              { type: "node", id: 3, tags: {} }, // unnamed: dropped
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n");
      if (url.startsWith("https://smiledental.com.au")) {
        return new Response(
          `<html><head><meta name="viewport" content="width=device-width"></head><body>© 2019 <a href="mailto:reception@smiledental.com.au">Email</a></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("searches, enriches sites, scores, and stores osm-sourced rows the Google purge never touches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-osm-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      const result = await findLeadsOsm(db, { vertical: "dental", area: "Mount Druitt NSW", request: fakeFetch() });
      expect(result.source).toBe("osm");
      expect(result.attribution).toBe("© OpenStreetMap contributors");
      expect(result.added).toHaveLength(2);
      expect(result.noWebsite).toBe(1);
      expect(result.withPhone).toBe(2);
      expect(result.withEmail).toBe(1);

      const smile = result.added.find((l) => l.name === "Smile Dental")!;
      expect(smile.source).toBe("osm");
      expect(smile.attribution).toBe("© OpenStreetMap contributors");
      expect(smile.emails).toEqual(["reception@smiledental.com.au"]);
      expect(smile.googleAt).toBeNull();

      // A years-old, definitely-Google-only lead should be purged; the fresh OSM rows never are.
      db.query("UPDATE leads SET google_at = '2000-01-01T00:00:00Z' WHERE place_id = 'osm:node/1'").run();
      const purged = purgeGoogleCache(db);
      expect(purged).toBe(0); // source='osm': the purge query never matches it despite the old google_at

      // a second run doesn't re-add the same OSM ids
      const again = await findLeadsOsm(db, { vertical: "dental", area: "Mount Druitt NSW", request: fakeFetch() });
      expect(again.alreadyKnown).toBe(2);
      expect(again.added).toHaveLength(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a google row's Places content is purged whatever its age, unlike an osm row", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-osm-purge-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      const base = { vertical: "dental" as const, area: "x", address: "a", website: "w", mapsUrl: "m", rating: null, reviews: null, emails: [], emailOk: false, score: 1, pitch: "website" as const, reasons: [] };
      upsertLead(db, { ...base, placeId: "ChIJold", name: "Old Google Lead", phone: "1", googleAt: "2000-01-01T00:00:00Z" }); // source defaults to "google"
      upsertLead(db, { ...base, placeId: "osm:node/9", name: "Old OSM Lead", phone: "2", googleAt: null, source: "osm", attribution: "© OpenStreetMap contributors" });
      expect(purgeGoogleCache(db)).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine: source selection", () => {
  test("defaults to OSM (Overpass), never touching Google Places, unless source: \"google\" is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-source-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      const hosts: string[] = [];
      const request = (async (url: string) => {
        hosts.push(new URL(String(url)).host);
        if (String(url).includes("overpass-api.de")) return new Response(JSON.stringify({ elements: [] }), { headers: { "Content-Type": "application/json" } });
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      const result = await findLeads(db, { vertical: "dental", area: "Mount Druitt NSW", request });
      expect(result.source).toBe("osm");
      expect(hosts).toEqual(["overpass-api.de"]);
      expect(hosts.some((h) => h.includes("googleapis"))).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
