import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, upsertLead } from "./crm";
import { rescanAll, rescanLead } from "./rescan";

const base = {
  vertical: "dental" as const, area: "St Clair NSW", address: "", mapsUrl: "", rating: null, reviews: null,
  emails: [] as string[], emailOk: false, googleAt: null, source: "osm" as const, attribution: "© OpenStreetMap contributors",
};

async function withDb<T>(fn: (db: ReturnType<typeof openCrm>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "crm-rescan-"));
  const db = openCrm(join(dir, "crm.sqlite"));
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("rescan: the St Clair Dental bug", () => {
  test("a lead OSM had no website tag for is re-scored once discovery finds the real site", () =>
    withDb(async (db) => {
      const lead = upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "St Clair Dental", phone: "0299990000", website: "",
        score: 45, pitch: "website", reasons: ["there's no website listed online"],
      });
      expect(lead.pitch).toBe("website");

      const html = `<html><head><meta name="viewport" content="width=device-width"></head><body>
        St Clair Dental, your local dentist in St Clair. <a href="mailto:reception@stclairdental.com.au">Email</a>
        © 2024</body></html>`;
      const request = (async (url: string) => {
        if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n");
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }) as typeof fetch;
      const discovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, guessSearch: async () => ({ url: "https://stclairdental.com.au/", source: "guess" as const, confidence: 0.4, checkedAt: new Date().toISOString() }) };

      // browserRetry: false — this test isn't exercising the mobile-390 check (see the dedicated
      // test below), and the site is already reachable via the mocked plain fetch, so leaving the
      // real default on here would launch an actual browser.
      const change = await rescanLead(db, lead, { request, discovery, browserRetry: false, crawl4ai: false });
      expect(change.action).toBe("website discovered");
      expect(change.before.website).toBe("");
      expect(change.after.website).toBe("https://stclairdental.com.au/");
      // Real, reachable, modern site with just a booking gap => "receptionist" (25 Sep 2026: "no
      // online booking" alone is a receptionist pitch, never a redesign) — but crucially, never
      // "website" (that would still claim they have no site at all).
      expect(change.after.pitch).toBe("receptionist");
      expect(change.after.pitch).not.toBe("website");
      expect(change.after.topReason).not.toMatch(/no website/i);

      const updated = findLead(db, lead.id)!;
      expect(updated.websiteSource).toBe("discovered_guess");
      expect(updated.websiteConfidence).toBe(0.4);
    }));

  test("a lead genuinely without a website gets a dated, verified reason — never a bare assumption", () =>
    withDb(async (db) => {
      const lead = upsertLead(db, { ...base, placeId: "osm:node/2", name: "No Site Dental", phone: "0299990001", website: "", score: 45, pitch: "website", reasons: [] });
      const request = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      const discovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, guessSearch: async () => null };
      const change = await rescanLead(db, lead, { request, discovery, crawl4ai: false });
      expect(change.action).toBe("no website confirmed");
      expect(change.after.topReason).toMatch(/^no website found \(checked \d{4}-\d{2}-\d{2}\)$/);
    }));

  test("an excluded org is marked excluded, not deleted, and never scored", () =>
    withDb(async (db) => {
      const lead = upsertLead(db, { ...base, vertical: "legal", placeId: "osm:node/3", name: "Legal Aid NSW", phone: "0299990002", website: "", score: 45, pitch: "website", reasons: [] });
      const change = await rescanLead(db, lead, { crawl4ai: false });
      expect(change.action).toBe("excluded");
      expect(change.after.score).toBe(0);
      const updated = findLead(db, lead.id)!;
      expect(updated.excluded).toBe(true);
      expect(updated.excludedReason).toMatch(/legal aid/i);
    }));

  test("merges a real-browser 390px overflow check into an already-reachable site's audit before scoring", () =>
    withDb(async (db) => {
      // A page that claims to be responsive (viewport meta present) but actually overflows at
      // 390px — only the real-browser check (not the plain-fetch mobileViewport regex) catches
      // this, and it must feed straight into the strict redesign bar (score.ts).
      const lead = upsertLead(db, {
        ...base, placeId: "osm:node/6", name: "Cramped Dental", phone: "0299990004", website: "https://cramped-dental.com.au/",
        score: 5, pitch: "receptionist", reasons: [],
      });
      const html = `<html><head><meta name="viewport" content="width=device-width"></head><body>
        Cramped Dental. Book online now. © 2026</body></html>`;
      const request = (async (url: string) => {
        if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n");
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }) as typeof fetch;
      const overflowCalls: string[] = [];
      const browserRetry = {
        runner: (async (args: string[]) => {
          overflowCalls.push(args.join(" "));
          if (args.includes("eval")) return { stdout: "true", ok: true };
          return { stdout: "", ok: true };
        }) as any,
      };

      const change = await rescanLead(db, lead, { request, browserRetry, crawl4ai: false });
      expect(overflowCalls.some((c) => c.includes("eval"))).toBe(true); // the check actually ran
      expect(change.after.pitch).toBe("redesign");
      expect(change.verdict).toContain("overflows at 390px");
    }));

  test("rescanAll's byPitch tally excludes excluded leads and counts each final pitch", () =>
    withDb(async (db) => {
      upsertLead(db, { ...base, placeId: "osm:node/7", name: "No Gaps Dental", phone: "0299990005", website: "", score: 45, pitch: "website", reasons: [] });
      upsertLead(db, { ...base, vertical: "legal", placeId: "osm:node/8", name: "Legal Aid NSW", phone: "0299990006", website: "", score: 45, pitch: "website", reasons: [] });
      const request = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      const discovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, guessSearch: async () => null };
      const summary = await rescanAll(db, { request, discovery, browserRetry: false, crawl4ai: false });
      expect(summary.byPitch.website).toBe(1); // No Gaps Dental: genuinely no website found
      expect(summary.byPitch.redesign).toBeUndefined(); // Legal Aid NSW is excluded, not counted here
    }));

  test("rescanAll skips a won lead by default and leaves it untouched", () =>
    withDb(async (db) => {
      const won = upsertLead(db, { ...base, vertical: "real-estate", placeId: "osm:node/4", name: "Bianca Brown Realty", phone: "0299990003", website: "biancabrownrealty.com.au", score: 100, pitch: "redesign", reasons: [] });
      db.query("UPDATE leads SET status = 'won' WHERE id = ?").run(won.id);
      const openLead = upsertLead(db, { ...base, placeId: "osm:node/5", name: "St Clair Dental", phone: "0299990000", website: "", score: 45, pitch: "website", reasons: [] });

      const request = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      const discovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, guessSearch: async () => null };
      const summary = await rescanAll(db, { request, discovery, crawl4ai: false });

      expect(summary.total).toBe(1); // the won lead is never touched
      expect(summary.changes.map((c) => c.leadId)).toEqual([openLead.id]);
      const stillWon = findLead(db, won.id)!;
      expect(stillWon.status).toBe("won");
      expect(stillWon.score).toBe(100); // untouched
    }));
});

// 25 Sep 2026: dryRun added for the second verification-bugfix's precision sample — must compute
// the real before/after (real discovery, real scoring) while writing nothing to the CRM.
describe("rescan: dryRun writes nothing to the CRM", () => {
  test("reports what the site discovery/scoring WOULD produce, but the lead in the DB is untouched", () =>
    withDb(async (db) => {
      const lead = upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "St Clair Dental", phone: "0299990000", website: "",
        score: 45, pitch: "website", reasons: ["there's no website listed online"],
      });
      const html = `<html><body>St Clair Dental, your local dentist in St Clair.</body></html>`;
      const request = (async (url: string) => {
        if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n");
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }) as typeof fetch;
      const discovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, guessSearch: async () => ({ url: "https://stclairdental.com.au/", source: "guess" as const, confidence: 0.4, checkedAt: new Date().toISOString() }) };

      const change = await rescanLead(db, lead, { request, discovery, browserRetry: false, crawl4ai: false, dryRun: true });
      // The computed result is real — it would have found the site and moved off "website".
      expect(change.after.website).toBe("https://stclairdental.com.au/");
      expect(change.after.pitch).not.toBe("website");

      // But nothing was actually written — the DB row is exactly as it was before.
      const stillInDb = findLead(db, lead.id)!;
      expect(stillInDb.website).toBe("");
      expect(stillInDb.pitch).toBe("website");
      expect(stillInDb.score).toBe(45);
      expect(stillInDb.reasons).toEqual(["there's no website listed online"]);
    }));

  test("dryRun also leaves an excluded-by-name lead's row untouched", () =>
    withDb(async (db) => {
      const lead = upsertLead(db, {
        ...base, vertical: "legal", placeId: "osm:node/2", name: "Legal Aid NSW", phone: "0299990001", website: "",
        score: 45, pitch: "website", reasons: [],
      });
      const change = await rescanLead(db, lead, { dryRun: true, crawl4ai: false, browserRetry: false });
      expect(change.action).toBe("excluded");
      expect(change.after.excluded).toBe(true);
      const stillInDb = findLead(db, lead.id)!;
      expect(stillInDb.excluded).toBe(false); // untouched — dryRun never persists
    }));
});
