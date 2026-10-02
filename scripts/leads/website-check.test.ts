// Round 6 review: a lead's website-check outcome is stored where the result is known, and only none-verified may become a verified absence.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, mergeLead, openCrm, upsertLead } from "./crm";
import { createLeadsApi } from "./api";
import { generateCallScript } from "./call-script";
import { saveIssueReport, type IssueReport } from "./issues";
import { findLeadsOsm } from "./osm";
import { rescanLead } from "./rescan";
import { SEARXNG_URL } from "./discovery";
import { applyIssueReport, detectIssues, readIssues } from "./issues";
import { dealRow, readRules } from "./deals";

const dirs: string[] = [];
const opened: Database[] = [];
afterEach(() => { for (const d of opened.splice(0)) { try { d.close(); } catch { /* already closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
function crm() { const dir = mkdtempSync(join(tmpdir(), "website-check-")); dirs.push(dir); const db = openCrm(join(dir, "crm.sqlite")); opened.push(db); return { dir, db }; }
const overpass = (names: string[]) => ({ elements: names.map((name, i) => ({ type: "node", id: i + 1, tags: { name, "addr:suburb": "Mount Druitt", "addr:postcode": "2770", phone: `(02) 9000 000${i}` } })) });
const noGuess = { guessSearch: async () => null };
const robotsBlocked = "User-agent: *\nDisallow: /\n";
const noNetwork = { request: (async () => { throw new Error("no network"); }) as never } as never;

function findWith(db: Database, names: string[], searx: (url: URL) => Response, extra?: (url: URL) => Response | undefined) {
  const request = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "overpass-api.de") return Response.json(overpass(names));
    if (url.origin === SEARXNG_URL) return searx(url);
    if (url.href === "https://html.duckduckgo.com/robots.txt") return new Response(robotsBlocked); // DuckDuckGo unusable
    const other = extra?.(url);
    if (other) return other;
    throw new Error("Unexpected synthetic request: " + url.href);
  }) as typeof fetch;
  return findLeadsOsm(db, { vertical: "dental", area: "Mount Druitt NSW", websitePresence: "missing", request, concurrency: 1, enrichMax: 0, discovery: noGuess });
}
const bareLead = (placeId: string, patch: Record<string, unknown> = {}) => ({ placeId, vertical: "dental", area: "Mount Druitt NSW", name: "Rescan Dental", phone: "", address: "1 Test St, Mount Druitt NSW 2770", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 0, pitch: "audit_pending", reasons: [], googleAt: null, source: "osm", ...patch }) as never;

describe("Find and rescan write the outcome where it is known", () => {
  test("a real engine answered with nothing: none-verified", async () => {
    const { db } = crm();
    const r = await findWith(db, ["Quiet Dental"], () => Response.json({ results: [], unresponsive_engines: [] }));
    expect(r.added[0]).toMatchObject({ websiteCheck: "none-verified" });
    expect(r.added[0].websiteCheckedAt).toBeTruthy();
  });
  test("SearXNG down and DuckDuckGo unusable: search-unavailable, with no check date", async () => {
    const { db } = crm();
    const r = await findWith(db, ["Offline Dental"], () => new Response("Unavailable", { status: 503 }));
    expect(r.added[0]).toMatchObject({ websiteCheck: "search-unavailable", websiteCheckedAt: null, pitch: "audit_pending" });
  });
  test("rescan: a franchise brand with no suburb is check-failed, and the date stamped before discovery decides nothing", async () => {
    const { db } = crm();
    const lead = upsertLead(db, bareLead("x:1", { name: "Century 21 Somewhere", address: "", area: "" }));
    const changed = await rescanLead(db, lead, { discovery: noGuess, browserRetry: false, crawl4ai: false });
    expect(changed.action).toBe("site unverifiable");
    const after = findLead(db, lead.id)!;
    expect(after.websiteCheck).toBe("check-failed");
    expect(after.websiteCheckedAt).toBeTruthy();
  });
  test("rescan: search down reads search-unavailable; an answered empty search reads none-verified", async () => {
    const { db } = crm();
    const down = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.origin === SEARXNG_URL) return new Response("x", { status: 503 });
      if (u.href === "https://html.duckduckgo.com/robots.txt") return new Response(robotsBlocked);
      throw new Error(u.href);
    }) as typeof fetch;
    const a = upsertLead(db, bareLead("x:a"));
    await rescanLead(db, a, { request: down, discovery: noGuess, browserRetry: false, crawl4ai: false });
    expect(findLead(db, a.id)!.websiteCheck).toBe("search-unavailable");
    const up = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.origin === SEARXNG_URL) return Response.json({ results: [], unresponsive_engines: [] });
      throw new Error(u.href);
    }) as typeof fetch;
    const b = upsertLead(db, bareLead("x:b"));
    await rescanLead(db, b, { request: up, discovery: noGuess, browserRetry: false, crawl4ai: false });
    expect(findLead(db, b.id)!.websiteCheck).toBe("none-verified");
  });
  test("a Hermes reply alone does not make none-verified", async () => {
    const { dir, db } = crm();
    const old = process.env.HERMES_HOME;
    process.env.HERMES_HOME = dir;
    await Bun.write(join(dir, ".env"), "API_SERVER_KEY=synthetic-test-key\n");
    try {
      const r = await findWith(db, ["Hermes Only Dental"], () => new Response("x", { status: 503 }), (url) =>
        url.pathname === "/health" ? Response.json({ ok: true })
        : url.pathname === "/v1/chat/completions" ? Response.json({ choices: [{ message: { content: '{"url": null, "confidence": 0}' } }] })
        : undefined);
      expect(r.added[0].websiteCheck).toBe("search-unavailable");
    } finally {
      if (old === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = old;
    }
  });
});

describe("legacy rows and the verified view", () => {
  function legacyDb() {
    const { dir } = crm();
    const path = join(dir, "legacy.sqlite");
    const raw = new Database(path);
    raw.exec("CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT UNIQUE NOT NULL, vertical TEXT NOT NULL, area TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', maps_url TEXT NOT NULL DEFAULT '', rating REAL, reviews INTEGER, emails TEXT NOT NULL DEFAULT '[]', email_ok INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, pitch TEXT NOT NULL DEFAULT '', reasons TEXT NOT NULL DEFAULT '[]', google_at TEXT, status TEXT NOT NULL DEFAULT 'new', owner TEXT NOT NULL DEFAULT '', next_at TEXT, last_contact_at TEXT, created_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00Z', website_checked_at TEXT)");
    raw.query("INSERT INTO leads (place_id, vertical, area, name, website, website_checked_at, pitch) VALUES ('a','dental','x','Has Site','https://a.example.test','2026-09-10T00:00:00Z','redesign'),('b','dental','x','Old Date','','2026-09-10T00:00:00Z','website'),('c','dental','x','Never','',NULL,'audit_pending')").run();
    raw.close();
    const db = openCrm(path);
    opened.push(db);
    return db;
  }
  test("migration: a saved website is found; an empty one is not-checked whatever its old date says; nothing becomes none-verified", () => {
    const db = legacyDb();
    const by = Object.fromEntries((db.query("SELECT name, website_check AS c FROM leads").all() as { name: string; c: string }[]).map((r) => [r.name, r.c]));
    expect(by).toEqual({ "Has Site": "found", "Old Date": "not-checked", Never: "not-checked" });
  });
  test("an issues pass on a legacy dated row is not a verified absence; on a none-verified row it is", async () => {
    const db = legacyDb();
    expect((await detectIssues(findLead(db, 2)!, noNetwork)).status).toBe("no_website_unverified");
    db.query("UPDATE leads SET website_check = 'none-verified' WHERE id = 2").run();
    expect((await detectIssues(findLead(db, 2)!, noNetwork)).status).toBe("no_website_verified");
  });
  test("a saved no_website_verified report is downgraded in the deal view unless the lead says none-verified", async () => {
    const db = legacyDb();
    db.query("UPDATE leads SET website_check = 'none-verified' WHERE id = 2").run();
    const lead = findLead(db, 2)!;
    applyIssueReport(db, lead, await detectIssues(lead, noNetwork));
    expect(readIssues(db, 2)!.status).toBe("no_website_verified");
    const ctx = { rules: readRules(db), now: new Date() };
    expect(dealRow("/tmp", db, findLead(db, 2)!, ctx as never).websiteStatus).toBe("no_website_verified");
    db.query("UPDATE leads SET website_check = 'not-checked' WHERE id = 2").run();
    expect(dealRow("/tmp", db, findLead(db, 2)!, ctx as never).websiteStatus).toBe("no_website_unverified"); // an old report cannot outvote the lead
  });
});

describe("review follow-ups", () => {
  const rawDb = (path: string, fn: (d: Database) => void) => { const d = new Database(path); fn(d); d.close(); };
  test("a crash between adding the column and the backfill is repaired on the next open", () => {
    const { dir } = crm();
    const path = join(dir, "partial.sqlite");
    const db0 = openCrm(path); db0.close();
    // Simulate the interrupted migration: the column exists (default not-checked) but the backfill never ran.
    rawDb(path, (d) => { d.exec("INSERT INTO leads (place_id, vertical, area, name, website, website_check) VALUES ('p','dental','x','Has Site','https://p.example.test','not-checked'),('q','dental','x','No Site','','not-checked')"); });
    const db = openCrm(path); opened.push(db);
    const by = Object.fromEntries((db.query("SELECT name, website_check AS c FROM leads").all() as { name: string; c: string }[]).map((r) => [r.name, r.c]));
    expect(by).toEqual({ "Has Site": "found", "No Site": "not-checked" });
  });
  test("an older build that adds a website without knowing the column is repaired on reopen", () => {
    const { dir } = crm();
    const path = join(dir, "oldbuild.sqlite");
    openCrm(path).close();
    rawDb(path, (d) => d.exec("INSERT INTO leads (place_id, vertical, area, name, website) VALUES ('o','dental','x','Old Build','https://o.example.test')")); // website_check takes its default
    const db = openCrm(path); opened.push(db);
    expect((db.query("SELECT website_check AS c FROM leads").get() as { c: string }).c).toBe("found");
  });
  test("a merge that fills in a website marks the kept lead found", () => {
    const { db } = crm();
    const keep = upsertLead(db, bareLead("m:keep", { name: "Keep Dental" }));
    const dup = upsertLead(db, bareLead("m:dup", { name: "Keep Dental", website: "https://keep.example.test" }));
    expect(findLead(db, keep.id)!.websiteCheck).toBe("not-checked");
    mergeLead(db, keep.id, dup.id);
    const kept = findLead(db, keep.id)!;
    expect(kept.website).toBe("https://keep.example.test");
    expect(kept.websiteCheck).toBe("found");
  });
  const oldReport = (leadId: number): IssueReport => ({
    leadId, checkedAt: "2026-09-20T00:00:00.000Z", website: "", auditedUrl: "", via: "none", status: "no_website_verified", statusNote: "no website found by discovery (checked 2026-09-20)",
    issues: [{ code: "no_website", finding: "No website found — search, directory and domain checks all came back empty (checked 2026-09-20)", short: "no website", say: "I couldn't find a website for you", evidence: { url: "", seen: "discovery checked: no site found", source: "directory" }, severity: 3, offer: "redesign" }],
    strengths: [], hook: "you have no website anywhere online", hookSource: "rule", score: 90, pitch: "website", verdict: "No website",
  } as never);
  test("the call script never leads with an old unproven 'no website' report", async () => {
    const { dir, db } = crm();
    const lead = upsertLead(db, bareLead("c:1", { reasons: [], pitch: "website", phone: "02 9000 0001" }));
    saveIssueReport(db, oldReport(lead.id));
    const prompts: string[] = [];
    const complete = async (body: any) => { prompts.push(body.messages.find((m: any) => m.role === "user").content); return { choices: [{ message: { content: JSON.stringify({ opener: "Hi", discovery: ["a", "b"], valuePitch: "v", objections: { price: "p", already_have_website: "a", send_email: "s", not_now: "n", ask_partner: "q" }, close: "c", followupEmail: { subject: "s", body: "Reply STOP to opt out." } }) } }] }; };
    await generateCallScript(db, findLead(db, lead.id)!, { root: dir, complete, free: null } as never).catch(() => {});
    expect(prompts[0]).toBeTruthy();
    expect(prompts[0]).not.toContain("No website found");
    expect(prompts[0]).not.toContain("you have no website anywhere online");
    // proven by a real search: the claim is allowed again
    db.query("UPDATE leads SET website_check = 'none-verified' WHERE id = ?").run(lead.id);
    await generateCallScript(db, findLead(db, lead.id)!, { root: dir, complete, free: null } as never).catch(() => {});
    expect(prompts.at(-1)).toContain("No website found");
  });
  test("the drawer payload drops old findings and hook for an unproven absence, and keeps them once proven", async () => {
    const { dir, db } = crm();
    const lead = upsertLead(db, bareLead("d:1", { pitch: "website" }));
    saveIssueReport(db, oldReport(lead.id));
    const api = createLeadsApi(dir, { db, placesLookup: null });
    const detail = async () => (await api.handle("/leads/detail", "GET", {}, new URLSearchParams({ id: String(lead.id) }), false)).issues;
    const before = await detail();
    expect(before.status).toBe("no_website_unverified");
    expect(before.top).toEqual([]);
    expect(before.hook).toBe("");
    db.query("UPDATE leads SET website_check = 'none-verified' WHERE id = ?").run(lead.id);
    const after = await detail();
    expect(after.status).toBe("no_website_verified");
    expect(after.top.length).toBe(1);
    expect(after.hook).toContain("no website");
    api.close();
  });
});
