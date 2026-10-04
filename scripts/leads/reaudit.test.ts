import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, upsertLead } from "./crm";
import { runReaudit, runSample } from "./reaudit";

const base = {
  vertical: "dental" as const, area: "Mount Druitt NSW", address: "", mapsUrl: "", rating: null, reviews: null,
  emails: [] as string[], emailOk: false, googleAt: null, source: "osm" as const, attribution: "© OpenStreetMap contributors",
};

function withDb<T>(fn: (dir: string, db: ReturnType<typeof openCrm>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "reaudit-"));
  const db = openCrm(join(dir, ".operator-data", "crm.sqlite"));
  return fn(dir, db).finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

// Every test below passes these — a real fetch/browser call in a unit test would be slow, could
// hang, and (for a nonexistent .example.au domain) would never succeed anyway.
const noNetwork = (async () => new Response("not found", { status: 404 })) as typeof fetch;
const noDiscovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, searxngSearch: async () => null, guessSearch: async () => null };
// crawl4ai: false — same reason as browserRetry: false here. Without it, rescanLead's own
// default-on (`opts.crawl4ai ?? {}`) would try to spawn the real crwl.exe against these fake
// .example.au domains on any machine where Crawl4AI happens to be installed.
// The nightly Dream-window pause (1:15-2:30am Sydney) must not depend on when the suite runs.
const neverDreaming = () => false;
const mockOpts = { request: noNetwork, browserRetry: false as const, crawl4ai: false as const, discovery: noDiscovery, dreamWindow: neverDreaming };

describe("reaudit: only touches audit_pending / low-data leads, and never the frozen top 20", () => {
  test("re-audits an audit_pending lead and a low-data lead, leaves a fine 'redesign' lead untouched", () =>
    withDb(async (dir, db) => {
      const pending = upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "Pending Dental", phone: "0299990001", website: "https://pending-dental.example.au/",
        score: 0, pitch: "audit_pending", reasons: ["audit pending — couldn't load their site (checked 2026-09-24): timed out"],
      });
      const lowData = upsertLead(db, {
        ...base, placeId: "osm:node/2", name: "Low Data Dental", phone: "", website: "",
        score: 0, pitch: "website", reasons: ["low data — no phone and no website on file (audit skipped)"],
      });
      const fine = upsertLead(db, {
        ...base, placeId: "osm:node/3", name: "Already Scored Dental", phone: "0299990003", website: "https://scored-dental.example.au/",
        score: 90, pitch: "redesign", reasons: ["Redesign: not mobile-friendly"],
      });

      // Not in the frozen list (a different id range), but must still be skipped by the query
      // filter alone (pitch "redesign", no "low data" reason) — proves the filter itself works,
      // independent of the explicit freeze list.
      const progress = await runReaudit({ root: dir, ...mockOpts });

      expect(progress.processedIds.sort()).toEqual([pending.id, lowData.id].sort());
      expect(progress.processedIds).not.toContain(fine.id);

      const stillFine = findLead(db, fine.id)!;
      expect(stillFine.score).toBe(90); // completely untouched
      expect(stillFine.pitch).toBe("redesign");
    }));

  test("never touches a lead id in the frozen top-20 list, even if it happens to be audit_pending", () =>
    withDb(async (dir, db) => {
      // Force a lead to land at id 194 (one of the real frozen ids) by inserting placeholders first.
      for (let i = 1; i < 194; i++) upsertLead(db, { ...base, placeId: `osm:node/filler-${i}`, name: `Filler ${i}`, phone: "0299990000", website: "", score: 0, pitch: "none", reasons: [] });
      const frozen = upsertLead(db, {
        ...base, placeId: "osm:node/194", name: "Should Stay Frozen", phone: "0299990194", website: "https://frozen.example.au/",
        score: 0, pitch: "audit_pending", reasons: ["audit pending — couldn't load their site (checked 2026-09-24): timed out"],
      });
      expect(frozen.id).toBe(194);

      const progress = await runReaudit({ root: dir, ...mockOpts });
      expect(progress.processedIds).not.toContain(194);
      const stillFrozen = findLead(db, 194)!;
      expect(stillFrozen.pitch).toBe("audit_pending"); // untouched
    }));

  test("checkpoints and resumes: a second run doesn't reprocess a lead the first run already did", () =>
    withDb(async (dir, db) => {
      upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "Pending Dental", phone: "0299990001", website: "https://pending-dental.example.au/",
        score: 0, pitch: "audit_pending", reasons: ["audit pending — couldn't load their site (checked 2026-09-24): timed out"],
      });
      const first = await runReaudit({ root: dir, ...mockOpts });
      expect(first.processedIds).toHaveLength(1);
      const second = await runReaudit({ root: dir, ...mockOpts });
      expect(second.processedIds).toHaveLength(1); // still 1 — nothing left to do, not reprocessed
    }));

  test("a hard stop deadline in the past checkpoints immediately without processing anything", () =>
    withDb(async (dir, db) => {
      upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "Pending Dental", phone: "0299990001", website: "https://pending-dental.example.au/",
        score: 0, pitch: "audit_pending", reasons: ["audit pending — couldn't load their site (checked 2026-09-24): timed out"],
      });
      const progress = await runReaudit({ root: dir, hardStopAt: new Date(0), ...mockOpts });
      expect(progress.processedIds).toHaveLength(0);
    }));
});

// 25 Sep 2026: the one-off `--all-website` widening added alongside the suburb/aggregator
// verification bugfix — the default `run` must stay exactly as narrow as before.
describe("reaudit: --all-website (includeAllWebsitePitch) is opt-in only", () => {
  test("a plain 'website' pitch lead (no audit_pending/low-data reason, no phone-finder flag) is left alone by default", () =>
    withDb(async (dir, db) => {
      const lead = upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "Ordinary No-Website Dental", phone: "0299990001", website: "",
        score: 45, pitch: "website", reasons: ["no website found (checked 2026-09-20)"],
      });
      const progress = await runReaudit({ root: dir, ...mockOpts });
      expect(progress.processedIds).not.toContain(lead.id);
      expect(findLead(db, lead.id)!.pitch).toBe("website"); // untouched — default scope is unchanged
    }));

  test("the same lead IS reconsidered with includeAllWebsitePitch, but the frozen top-20 still isn't", () =>
    withDb(async (dir, db) => {
      const lead = upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "Ordinary No-Website Dental", phone: "0299990001", website: "",
        score: 45, pitch: "website", reasons: ["no website found (checked 2026-09-20)"],
      });
      for (let i = 2; i < 194; i++) upsertLead(db, { ...base, placeId: `osm:node/filler-${i}`, name: `Filler ${i}`, phone: "0299990000", website: "", score: 0, pitch: "none", reasons: [] });
      const frozen = upsertLead(db, {
        ...base, placeId: "osm:node/194", name: "Should Stay Frozen", phone: "0299990194", website: "",
        score: 45, pitch: "website", reasons: ["no website found (checked 2026-09-20)"],
      });
      expect(frozen.id).toBe(194);

      const progress = await runReaudit({ root: dir, includeAllWebsitePitch: true, ...mockOpts });
      expect(progress.processedIds).toContain(lead.id);
      expect(progress.processedIds).not.toContain(194); // FROZEN_TOP_20 wins even with the widening
      expect(findLead(db, 194)!.pitch).toBe("website"); // untouched
    }));
});

// 25 Sep 2026: `sample` — the dry-run precision check before trusting a real --all-website sweep.
describe("reaudit: sample (dry run) writes nothing and never exceeds the pool size", () => {
  test("samples only 'website'-pitch leads, skips the frozen top-20, and writes nothing to the CRM", () =>
    withDb(async (dir, db) => {
      const website = upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "Sample Dental", phone: "0299990001", website: "",
        score: 45, pitch: "website", reasons: ["no website found (checked 2026-09-20)"],
      });
      upsertLead(db, {
        ...base, placeId: "osm:node/2", name: "Already Scored Dental", phone: "0299990002", website: "https://scored.example.au/",
        score: 90, pitch: "redesign", reasons: [],
      });
      const request = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      const discovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, guessSearch: async () => null };

      const changes = await runSample({ root: dir, n: 50, request, discovery, browserRetry: false, crawl4ai: false, dreamWindow: neverDreaming });
      expect(changes).toHaveLength(1); // only the one 'website'-pitch lead is in the pool
      expect(changes[0].leadId).toBe(website.id);

      // Nothing written — the lead's DB row is exactly as it was before.
      const stillInDb = findLead(db, website.id)!;
      expect(stillInDb.pitch).toBe("website");
      expect(stillInDb.score).toBe(45);
    }));

  test("`n` never returns more than the pool actually has", () =>
    withDb(async (dir, db) => {
      upsertLead(db, {
        ...base, placeId: "osm:node/1", name: "Only One Dental", phone: "0299990001", website: "",
        score: 45, pitch: "website", reasons: [],
      });
      const request = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      const discovery = { hermesSearch: async () => null, duckduckgoSearch: async () => null, guessSearch: async () => null };
      const changes = await runSample({ root: dir, n: 50, request, discovery, browserRetry: false, crawl4ai: false, dreamWindow: neverDreaming });
      expect(changes).toHaveLength(1);
    }));
});
