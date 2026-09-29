import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activities, openCrm, upsertLead } from "./crm";
import {
  changeDetectionConfigFromEnv,
  forceRecheck,
  isWatchableUrl,
  pollChanges,
  readWatchSummary,
  renderPollResult,
  renderSyncResult,
  syncWatches,
  watchStatePath,
  type ChangeDetectionConfig,
} from "./watch";

const CFG: ChangeDetectionConfig = { baseUrl: "http://127.0.0.1:5000", apiKey: "test-key" };

function withCrm(run: (root: string, db: ReturnType<typeof openCrm>) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "watch-test-"));
    const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
    try {
      await run(root, db);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function seedLead(db: ReturnType<typeof openCrm>, overrides: Partial<Parameters<typeof upsertLead>[1]> = {}) {
  return upsertLead(db, {
    placeId: overrides.placeId ?? "osm:node/1", vertical: "dental", area: "Mount Druitt NSW",
    name: "Smile Dental", phone: "", address: "", website: "https://smiledental.example.com/",
    mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 50, pitch: "website",
    reasons: [], googleAt: null, source: "osm", attribution: "© OpenStreetMap contributors",
    ...overrides,
  } as any);
}

describe("watch: config and URL guard", () => {
  test("changeDetectionConfigFromEnv needs an API key", () => {
    // A fake, empty home dir so this never picks up the real machine's ~/.config/agentic-os.env.
    const noConfigHome = mkdtempSync(join(tmpdir(), "watch-no-config-"));
    try {
      expect(changeDetectionConfigFromEnv({}, noConfigHome)).toBeNull();
      expect(changeDetectionConfigFromEnv({ CHANGEDETECTION_API_KEY: "abc" }, noConfigHome)).toEqual({
        baseUrl: "http://127.0.0.1:5000", apiKey: "abc",
      });
      expect(
        changeDetectionConfigFromEnv({ CHANGEDETECTION_API_KEY: "abc", CHANGEDETECTION_BASE_URL: "http://127.0.0.1:5001/" }, noConfigHome),
      ).toEqual({ baseUrl: "http://127.0.0.1:5001", apiKey: "abc" });
    } finally {
      rmSync(noConfigHome, { recursive: true, force: true });
    }
  });

  test("isWatchableUrl only accepts http(s)", () => {
    expect(isWatchableUrl("https://example.com.au/")).toBe(true);
    expect(isWatchableUrl("http://example.com.au/")).toBe(true);
    expect(isWatchableUrl("javascript:alert(1)")).toBe(false);
    expect(isWatchableUrl("")).toBe(false);
    expect(isWatchableUrl("not a url")).toBe(false);
  });
});

describe("watch: syncWatches", () => {
  test(
    "creates a watch per open lead with a website, idempotently",
    withCrm(async (root, db) => {
      seedLead(db);
      const calls: { url: string; init?: RequestInit }[] = [];
      const request = (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ uuid: "uuid-1" }), { status: 201, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      const first = await syncWatches(db, CFG, root, request);
      expect(first).toEqual({ created: 1, alreadyWatched: 0, skipped: 0, total: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://127.0.0.1:5000/api/v1/watch");
      expect((calls[0].init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.url).toBe("https://smiledental.example.com/");
      expect(body.tag).toBe("lead:1");
      expect(body.fetch_backend).toBe("html_requests");

      // Replaying sync must not create a second watch or call the API again.
      const second = await syncWatches(db, CFG, root, request);
      expect(second).toEqual({ created: 0, alreadyWatched: 1, skipped: 0, total: 1 });
      expect(calls).toHaveLength(1);
      expect(renderSyncResult(second)).toContain("0 new watch(es)");
    }),
  );

  test(
    "skips a lead with no usable website and a closed lead",
    withCrm(async (root, db) => {
      seedLead(db, { placeId: "osm:node/2", website: "" });
      seedLead(db, { placeId: "osm:node/3" });
      db.query("UPDATE leads SET status = 'won' WHERE place_id = 'osm:node/3'").run();
      const request = (async () => {
        throw new Error("should not fetch: nothing watchable");
      }) as typeof fetch;
      const result = await syncWatches(db, CFG, root, request);
      expect(result).toEqual({ created: 0, alreadyWatched: 0, skipped: 0, total: 0 });
    }),
  );
});

describe("watch: pollChanges", () => {
  test(
    "notes a change onto the lead exactly once",
    withCrm(async (root, db) => {
      const lead = seedLead(db);
      const create = (async () => new Response(JSON.stringify({ uuid: "uuid-1" }), { status: 201 })) as typeof fetch;
      await syncWatches(db, CFG, root, create);

      let lastChanged = 1_790_000_000;
      const request = (async (url: string) => {
        expect(String(url)).toBe("http://127.0.0.1:5000/api/v1/watch/uuid-1");
        return new Response(JSON.stringify({ last_changed: lastChanged, title: "Smile Dental" }), { headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      const first = await pollChanges(db, CFG, root, request);
      expect(first.checked).toBe(1);
      expect(first.changed).toEqual([{ leadId: lead.id, url: lead.website, changedAt: new Date(lastChanged * 1000).toISOString() }]);
      const notes = activities(db, lead.id);
      expect(notes).toHaveLength(1);
      expect(notes[0].note).toContain("website changed");
      expect(renderPollResult(first, () => lead)).toContain("changed");

      // Same last_changed again: no new note, no duplicate activity.
      const second = await pollChanges(db, CFG, root, request);
      expect(second.changed).toHaveLength(0);
      expect(activities(db, lead.id)).toHaveLength(1);

      // A further real change is picked up as a second, distinct note.
      lastChanged += 1000;
      const third = await pollChanges(db, CFG, root, request);
      expect(third.changed).toHaveLength(1);
      expect(activities(db, lead.id)).toHaveLength(2);
    }),
  );

  test(
    "a dead watch (deleted upstream) doesn't stop the rest of the poll",
    withCrm(async (root, db) => {
      seedLead(db);
      const create = (async () => new Response(JSON.stringify({ uuid: "uuid-1" }), { status: 201 })) as typeof fetch;
      await syncWatches(db, CFG, root, create);
      const request = (async () => new Response("gone", { status: 404 })) as typeof fetch;
      const result = await pollChanges(db, CFG, root, request);
      expect(result.checked).toBe(1);
      expect(result.changed).toHaveLength(0);
    }),
  );

  test(
    "forceRecheck calls the recheck query param",
    withCrm(async (root) => {
      const calls: string[] = [];
      const request = (async (url: string) => {
        calls.push(String(url));
        return new Response("OK", { status: 200 });
      }) as typeof fetch;
      await forceRecheck(CFG, "uuid-9", request);
      expect(calls).toEqual(["http://127.0.0.1:5000/api/v1/watch/uuid-9?recheck=true"]);
    }),
  );
});

describe("watch: readWatchSummary", () => {
  test(
    "reads watch-state.json without any network call",
    withCrm(async (root, db) => {
      const empty = readWatchSummary(root);
      expect(empty).toEqual({ totalWatched: 0, changedThisWeek: [], leads: [] });

      seedLead(db);
      const create = (async () => new Response(JSON.stringify({ uuid: "uuid-1" }), { status: 201 })) as typeof fetch;
      await syncWatches(db, CFG, root, create);
      const request = (async () => new Response(JSON.stringify({ last_changed: Math.floor(Date.now() / 1000) }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
      await pollChanges(db, CFG, root, request);

      const summary = readWatchSummary(root);
      expect(summary.totalWatched).toBe(1);
      expect(summary.changedThisWeek).toHaveLength(1);
      expect(watchStatePath(root)).toContain(".operator-data");
    }),
  );
});
