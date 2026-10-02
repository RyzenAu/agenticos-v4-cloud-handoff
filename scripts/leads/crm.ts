// The M&U CRM: one SQLite file in .operator-data (never committed). Leads are keyed by a source
// id — a Google place ID (the only Places value Google lets us keep indefinitely) or an
// `osm:<type>/<id>` OpenStreetMap id, which is ODbL and may be kept permanently.
// 27 Sep 2026 (Places terms §5.3–5.4): a `source = 'google'` row stores the place ID and
// `places_checked_at` only. Its name, phone, address, website, rating and reviews are NOT stored —
// places-live.ts fetches them per request for display/call prep. A field on a Google row may hold
// a value only when `field_sources` records a non-Places origin for it (the practice's own site,
// a founder's manual check, OSM, discovery). places-cleanup.ts removes anything older that
// doesn't meet that bar. Our own findings (score, emails from the business's site, notes,
// outcomes) stay regardless of source.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Vertical } from "./places";
import { dataDirFor } from "../cloud/data-dir";

export type LeadSource = "google" | "osm";

export const STATUSES = [
  "new", "to_call", "no_answer", "voicemail", "call_back", "emailed", "interested",
  "meeting", "proposal", "won", "lost", "not_interested", "do_not_contact",
] as const;
export type Status = (typeof STATUSES)[number];
/** Outcomes that end outreach for good. */
const CLOSED: Status[] = ["won", "lost", "not_interested", "do_not_contact"];

export const WEBSITE_CHECKS = ["found", "none-verified", "check-failed", "search-unavailable", "not-checked"] as const;
export type WebsiteCheck = (typeof WEBSITE_CHECKS)[number];
export const normaliseWebsiteCheck = (v: unknown): WebsiteCheck => ((WEBSITE_CHECKS as readonly string[]).includes(v as string) ? (v as WebsiteCheck) : "not-checked");

export type Lead = {
  id: number;
  placeId: string;
  vertical: Vertical;
  area: string;
  name: string;
  phone: string;
  address: string;
  website: string;
  mapsUrl: string;
  rating: number | null;
  reviews: number | null;
  emails: string[];
  emailOk: boolean;
  score: number;
  pitch: string;
  reasons: string[];
  status: Status;
  owner: string;
  nextAt: string | null;
  lastContactAt: string | null;
  googleAt: string | null;
  createdAt: string;
  /** Where this lead came from. Defaults to "google" for rows written before this column existed. */
  source: LeadSource;
  /** Required attribution text for the source, e.g. "© OpenStreetMap contributors" for OSM rows. */
  attribution: string;
  /** True for a government body, legal aid/community service, non-profit, university, hospital,
   *  or national chain/franchise (see exclusions.ts) — kept on file, never scored or called. */
  excluded: boolean;
  excludedReason: string;
  /** How `website` was established: '' (not checked), 'osm_tag'/'google' (the directory already
   *  had it), or 'discovered_hermes'/'discovered_duckduckgo'/'discovered_guess' (scripts/leads/
   *  discovery.ts found it because the directory didn't). */
  websiteSource: string;
  /** Discovery's own confidence (0..1) for a discovered website; null when not discovered. */
  websiteConfidence: number | null;
  /** When a website check last ran for this lead (found or not) — backs the
   *  "no website found (checked <date>)" reason so that's never a bare assumption. */
  websiteCheckedAt: string | null;
  /** What the last website check established, written where the result is known (never inferred from dates or text):
   *  found (a website exists, listed or discovered), none-verified (a real search engine answered and nothing was found),
   *  check-failed (a candidate or the check itself could not be completed), search-unavailable (no search engine answered),
   *  not-checked (never checked, or a legacy row that cannot prove a check). Only none-verified may become "No website, verified". */
  websiteCheck: WebsiteCheck;
  /** Set once this lead has been folded into another (same discovered domain or phone) as a
   *  duplicate — the id it was merged into. The row is kept (never deleted) and `excluded`
   *  becomes true with a "duplicate of #<id>" reason, same as any other excluded lead. */
  mergedInto: number | null;
  /** How `phone` was established, mirroring `websiteSource`: '' (from the directory — OSM/Google —
   *  or never checked) or 'found_searxng'/'found_crawl4ai' when phone-finder.ts found it. The
   *  finder only ever fills an empty phone; it never overwrites one. */
  phoneSource: string;
  /** phone-finder.ts's confidence (0..1) for a found phone; null when not found by it. */
  phoneConfidence: number | null;
  /** When the phone finder last ran for this lead (found or not). */
  phoneCheckedAt: string | null;
  /** A weaker phone-finder result, shown as "suggested — verify" in the lead drawer and never
   *  used for calling until a founder confirms it. '' when there's none. */
  suggestedPhone: string;
  /** Google rows only: when the place ID was last looked up (find, or a live display lookup).
   *  The Places content itself is never stored. Optional so fixtures predating it still type-check. */
  placesCheckedAt?: string | null;
  /** Per-field origin for values that did NOT come from Google Places, e.g.
   *  `{ "emails": "website", "phone": "manual" }`. Values: "osm", "website" (the practice's own
   *  site), "manual" (a founder checked it), "discovered_*". places-cleanup.ts keeps a Google row's
   *  field only when this names a non-Places source for it. */
  fieldSources?: Record<string, string>;
};

/** `website_source` for a lead whose website a founder has to confirm by hand (e.g. discovery
 *  attached the wrong organisation's site). Automatic discovery never fills it again (rescan.ts). */
export const WEBSITE_NOT_VERIFIED = "not_verified";
export const WEBSITE_NOT_VERIFIED_REASON = "website not verified — owner to Google";

/** Field origins that mean "this value came from Google Places" — never storable beyond place_id. */
export const PLACES_FIELD_SOURCES = new Set(["google", "places", ""]);

export type Activity = { id: number; leadId: number; at: string; kind: string; outcome: string; note: string; by: string };

export function crmPath(root: string) {
  return join(dataDirFor(root), "crm.sqlite");
}

export function openCrm(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id TEXT NOT NULL UNIQUE,
      vertical TEXT NOT NULL,
      area TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      maps_url TEXT NOT NULL DEFAULT '',
      rating REAL,
      reviews INTEGER,
      emails TEXT NOT NULL DEFAULT '[]',
      email_ok INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      pitch TEXT NOT NULL DEFAULT '',
      reasons TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      owner TEXT NOT NULL DEFAULT '',
      next_at TEXT,
      last_contact_at TEXT,
      google_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source TEXT NOT NULL DEFAULT 'google',
      attribution TEXT NOT NULL DEFAULT '',
      excluded INTEGER NOT NULL DEFAULT 0,
      excluded_reason TEXT NOT NULL DEFAULT '',
      website_source TEXT NOT NULL DEFAULT '',
      website_confidence REAL,
      website_checked_at TEXT,
      website_check TEXT NOT NULL DEFAULT 'not-checked',
      merged_into INTEGER,
      phone_source TEXT NOT NULL DEFAULT '',
      phone_confidence REAL,
      phone_checked_at TEXT,
      suggested_phone TEXT NOT NULL DEFAULT '',
      places_checked_at TEXT,
      field_sources TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      kind TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS places_usage (month TEXT NOT NULL, sku TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (month, sku));
    CREATE TABLE IF NOT EXISTS optouts (value TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS goals (who TEXT PRIMARY KEY, daily_calls INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    -- One row per dictation/webhook event ever applied to activities, so replaying the same
    -- event (a re-sent voice note, a retried webhook) never creates a second activity row.
    CREATE TABLE IF NOT EXISTS activity_events (
      event_id TEXT PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id),
      lead_id INTEGER NOT NULL,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    -- One internal kickoff checklist per won lead. Nothing here is sent to the client.
    CREATE TABLE IF NOT EXISTS kickoffs (
      lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
      scope TEXT NOT NULL,
      checklist TEXT NOT NULL,
      by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    -- A structured coaching note from a founder's own post-call debrief (never audio, never a
    -- transcript: NSW needs every party's consent to record a call, and live capture hasn't had
    -- legal review, so coaching only ever runs on what the founder recounts afterwards).
    CREATE TABLE IF NOT EXISTS coaching (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      activity_id INTEGER REFERENCES activities(id),
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      by TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL DEFAULT 0,
      categories TEXT NOT NULL DEFAULT '{}',
      objection_tag TEXT,
      worked TEXT NOT NULL DEFAULT '',
      improve TEXT NOT NULL DEFAULT '',
      next_step TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS leads_status ON leads(status, score DESC);
    -- phone-finder.ts: one row per lead it has checked — the evidence behind a found or suggested
    -- phone (source URLs, how many independent sources agreed, the match signals) and any real
    -- website the same search turned up for a no-website lead (queued for reaudit.ts, never
    -- rescored here).
    CREATE TABLE IF NOT EXISTS phone_findings (
      lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
      checked_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      e164 TEXT NOT NULL DEFAULT '',
      display TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT '',
      confidence REAL,
      agreeing INTEGER NOT NULL DEFAULT 0,
      sources TEXT NOT NULL DEFAULT '[]',
      signals TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '',
      website_found TEXT NOT NULL DEFAULT '',
      reaudit_state TEXT NOT NULL DEFAULT ''
    );
    -- OSM place -> suburb/road/postcode via Nominatim's /lookup (50 ids a request), cached so the
    -- phone finder can check a result's location for the many leads whose area is just a region.
    CREATE TABLE IF NOT EXISTS lead_locations (
      place_id TEXT PRIMARY KEY,
      suburb TEXT NOT NULL DEFAULT '',
      road TEXT NOT NULL DEFAULT '',
      postcode TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      lat REAL,
      lon REAL,
      looked_up_at TEXT NOT NULL
    );
    -- deals.ts (added 25 Sep 2026, additive): per-lead deal economics and the founder's
    -- "how they like to be contacted" note. Every column is optional — a lead with no row here
    -- simply uses the offer's default price and its stage's default probability.
    CREATE TABLE IF NOT EXISTS lead_deals (
      lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
      offer TEXT,
      setup_cents INTEGER,
      monthly_cents INTEGER,
      probability REAL,
      expected_close TEXT,
      contact_pref TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    -- deals.ts: small JSON settings (stage probabilities, stuck-too-long thresholds) that
    -- override the defaults in code. One row per key; absent = defaults.
    CREATE TABLE IF NOT EXISTS crm_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  // Migration for a CRM file created before OSM support: add the columns SQLite's
  // CREATE TABLE IF NOT EXISTS won't retrofit onto an existing table.
  const existing = new Set((db.query("PRAGMA table_info(leads)").all() as Row[]).map((r) => r.name));
  if (!existing.has("source")) db.exec("ALTER TABLE leads ADD COLUMN source TEXT NOT NULL DEFAULT 'google'");
  if (!existing.has("attribution")) db.exec("ALTER TABLE leads ADD COLUMN attribution TEXT NOT NULL DEFAULT ''");
  if (!existing.has("excluded")) db.exec("ALTER TABLE leads ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0");
  if (!existing.has("excluded_reason")) db.exec("ALTER TABLE leads ADD COLUMN excluded_reason TEXT NOT NULL DEFAULT ''");
  if (!existing.has("website_source")) db.exec("ALTER TABLE leads ADD COLUMN website_source TEXT NOT NULL DEFAULT ''");
  if (!existing.has("website_confidence")) db.exec("ALTER TABLE leads ADD COLUMN website_confidence REAL");
  if (!existing.has("website_checked_at")) db.exec("ALTER TABLE leads ADD COLUMN website_checked_at TEXT");
  // The column and its backfill are one step: a crash between them must not leave websites "not-checked" for good.
  // Conservative backfill: a saved website is "found"; an empty one stays "not-checked" however old its check date is,
  // because older runs stamped that date even when no search engine had answered. Nothing becomes none-verified here.
  if (!existing.has("website_check")) {
    db.transaction(() => {
      db.exec("ALTER TABLE leads ADD COLUMN website_check TEXT NOT NULL DEFAULT 'not-checked'");
      db.exec("UPDATE leads SET website_check = 'found' WHERE website <> ''");
    })();
  }
  // Idempotent repair on every open: an older build can add a website or merge two leads without knowing this column.
  db.exec("UPDATE leads SET website_check = 'found' WHERE website <> '' AND website_check <> 'found'");
  if (!existing.has("merged_into")) db.exec("ALTER TABLE leads ADD COLUMN merged_into INTEGER");
  if (!existing.has("phone_source")) db.exec("ALTER TABLE leads ADD COLUMN phone_source TEXT NOT NULL DEFAULT ''");
  if (!existing.has("phone_confidence")) db.exec("ALTER TABLE leads ADD COLUMN phone_confidence REAL");
  if (!existing.has("phone_checked_at")) db.exec("ALTER TABLE leads ADD COLUMN phone_checked_at TEXT");
  if (!existing.has("suggested_phone")) db.exec("ALTER TABLE leads ADD COLUMN suggested_phone TEXT NOT NULL DEFAULT ''");
  if (!existing.has("places_checked_at")) db.exec("ALTER TABLE leads ADD COLUMN places_checked_at TEXT");
  if (!existing.has("field_sources")) db.exec("ALTER TABLE leads ADD COLUMN field_sources TEXT NOT NULL DEFAULT '{}'");
  return db;
}

type Row = Record<string, any>;
function toLead(r: Row): Lead {
  return {
    id: r.id, placeId: r.place_id, vertical: r.vertical, area: r.area, name: r.name, phone: r.phone,
    address: r.address, website: r.website, mapsUrl: r.maps_url, rating: r.rating, reviews: r.reviews,
    emails: JSON.parse(r.emails || "[]"), emailOk: !!r.email_ok, score: r.score, pitch: r.pitch,
    reasons: JSON.parse(r.reasons || "[]"), status: r.status, owner: r.owner, nextAt: r.next_at,
    lastContactAt: r.last_contact_at, googleAt: r.google_at, createdAt: r.created_at,
    source: (r.source as LeadSource) || "google", attribution: r.attribution || "",
    excluded: !!r.excluded, excludedReason: r.excluded_reason || "",
    websiteSource: r.website_source || "", websiteConfidence: r.website_confidence ?? null,
    websiteCheckedAt: r.website_checked_at ?? null, websiteCheck: normaliseWebsiteCheck(r.website_check), mergedInto: r.merged_into ?? null,
    phoneSource: r.phone_source || "", phoneConfidence: r.phone_confidence ?? null,
    phoneCheckedAt: r.phone_checked_at ?? null, suggestedPhone: r.suggested_phone || "",
    placesCheckedAt: r.places_checked_at ?? null, fieldSources: parseFieldSources(r.field_sources),
  };
}

export function parseFieldSources(raw: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(typeof raw === "string" && raw ? raw : "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function knownPlaceIds(db: Database): Set<string> {
  return new Set((db.query("SELECT place_id FROM leads").all() as Row[]).map((r) => r.place_id));
}

export type UpsertLeadInput = Omit<
  Lead,
  "id" | "status" | "owner" | "nextAt" | "lastContactAt" | "createdAt" | "source" | "attribution" | "excluded" | "excludedReason" | "websiteSource" | "websiteConfidence" | "websiteCheckedAt" | "websiteCheck" | "mergedInto"
  | "phoneSource" | "phoneConfidence" | "phoneCheckedAt" | "suggestedPhone" | "placesCheckedAt" | "fieldSources"
> & {
  /** Defaults to "google" so every existing caller (and test) keeps behaving exactly as before. */
  source?: LeadSource;
  attribution?: string;
  excluded?: boolean;
  excludedReason?: string;
  websiteSource?: string;
  websiteConfidence?: number | null;
  websiteCheckedAt?: string | null;
  /** Omitted: kept from the existing row when its website is unchanged, else "found" for a website and "not-checked" for none. */
  websiteCheck?: WebsiteCheck;
  /** Google rows: when the place ID was looked up. Kept on re-upsert when omitted. */
  placesCheckedAt?: string | null;
  /** Per-field non-Places origins (see Lead.fieldSources). Kept on re-upsert when omitted/empty. */
  fieldSources?: Record<string, string>;
};

export function upsertLead(db: Database, lead: UpsertLeadInput) {
  // A later directory import must not undo a founder's corrections.
  const existing = findLead(db, lead.placeId);
  if (existing) {
    const manual = Object.fromEntries(Object.entries(existing.fieldSources ?? {}).filter(([key, source]) => source === "manual" && ["name", "phone", "address", "website", "emails"].includes(key)));
    lead = { ...lead, fieldSources: { ...lead.fieldSources, ...manual } };
    for (const key of Object.keys(manual)) (lead as any)[key] = (existing as any)[key];
    if (manual.website) Object.assign(lead, { websiteSource: existing.websiteSource, websiteConfidence: existing.websiteConfidence, websiteCheckedAt: existing.websiteCheckedAt, websiteCheck: existing.websiteCheck, score: existing.score, pitch: existing.pitch, reasons: existing.reasons });
    if (manual.emails || existing.status === "do_not_contact") lead.emailOk = existing.emailOk;
  }
  const optedOut = lead.emails.some((e) => isOptedOut(db, e));
  const source: LeadSource = lead.source ?? "google";
  const attribution = lead.attribution ?? "";
  const excluded = lead.excluded ?? false;
  const excludedReason = lead.excludedReason ?? "";
  const websiteSource = lead.websiteSource ?? "";
  const websiteConfidence = lead.websiteConfidence ?? null;
  const websiteCheckedAt = lead.websiteCheckedAt ?? null;
  const websiteCheck: WebsiteCheck = lead.websiteCheck ?? (existing && existing.website === lead.website ? existing.websiteCheck : lead.website ? "found" : "not-checked");
  const fieldSources = JSON.stringify(lead.fieldSources ?? {});
  db.query(`
    INSERT INTO leads (place_id, vertical, area, name, phone, address, website, maps_url, rating, reviews, emails, email_ok, score, pitch, reasons, google_at, status, source, attribution, excluded, excluded_reason, website_source, website_confidence, website_checked_at, website_check, places_checked_at, field_sources)
    VALUES ($placeId, $vertical, $area, $name, $phone, $address, $website, $mapsUrl, $rating, $reviews, $emails, $emailOk, $score, $pitch, $reasons, $googleAt, $status, $source, $attribution, $excluded, $excludedReason, $websiteSource, $websiteConfidence, $websiteCheckedAt, $websiteCheck, $placesCheckedAt, $fieldSources)
    ON CONFLICT(place_id) DO UPDATE SET name=excluded.name, phone=excluded.phone, address=excluded.address,
      website=excluded.website, maps_url=excluded.maps_url, rating=excluded.rating, reviews=excluded.reviews,
      emails=excluded.emails, email_ok=excluded.email_ok, score=excluded.score, pitch=excluded.pitch,
      reasons=excluded.reasons, google_at=excluded.google_at, source=excluded.source, attribution=excluded.attribution,
      excluded=excluded.excluded, excluded_reason=excluded.excluded_reason, website_source=excluded.website_source,
      website_confidence=excluded.website_confidence, website_checked_at=excluded.website_checked_at, website_check=excluded.website_check,
      places_checked_at=COALESCE(excluded.places_checked_at, places_checked_at),
      field_sources=CASE WHEN excluded.field_sources = '{}' THEN field_sources ELSE excluded.field_sources END
  `).run({
    $placeId: lead.placeId, $vertical: lead.vertical, $area: lead.area, $name: lead.name, $phone: lead.phone,
    $address: lead.address, $website: lead.website, $mapsUrl: lead.mapsUrl, $rating: lead.rating, $reviews: lead.reviews,
    $emails: JSON.stringify(lead.emails), $emailOk: lead.emailOk && !optedOut ? 1 : 0, $score: lead.score,
    $pitch: lead.pitch, $reasons: JSON.stringify(lead.reasons), $googleAt: lead.googleAt,
    $status: optedOut ? "do_not_contact" : "new", $source: source, $attribution: attribution,
    $excluded: excluded ? 1 : 0, $excludedReason: excludedReason, $websiteSource: websiteSource,
    $websiteConfidence: websiteConfidence, $websiteCheckedAt: websiteCheckedAt, $websiteCheck: websiteCheck,
    $placesCheckedAt: lead.placesCheckedAt ?? null, $fieldSources: fieldSources,
  });
  return findLead(db, lead.placeId)!;
}

/** By numeric id, place ID, or a unique piece of the name. */
export function findLead(db: Database, ref: string | number): Lead | null {
  const text = String(ref).trim();
  let row = /^\d+$/.test(text)
    ? (db.query("SELECT * FROM leads WHERE id = ?").get(Number(text)) as Row | null)
    : (db.query("SELECT * FROM leads WHERE place_id = ?").get(text) as Row | null);
  if (!row && text.length >= 3) {
    const rows = db.query("SELECT * FROM leads WHERE name LIKE ? LIMIT 2").all(`%${text}%`) as Row[];
    if (rows.length > 1) throw new Error(`More than one lead matches "${text}": use its number.`);
    row = rows[0] ?? null;
  }
  return row ? toLead(row) : null;
}

export function listLeads(
  db: Database,
  filter: { status?: string; vertical?: string; minScore?: number; limit?: number; includeExcluded?: boolean } = {},
): Lead[] {
  const where: string[] = [];
  const args: Record<string, string | number> = {};
  if (!filter.includeExcluded) where.push("excluded = 0");
  if (filter.status) (where.push("status = $status"), (args.$status = filter.status));
  if (filter.vertical) (where.push("vertical = $vertical"), (args.$vertical = filter.vertical));
  if (filter.minScore) (where.push("score >= $min"), (args.$min = filter.minScore));
  // Clamp raised 25 Sep 2026 (10,000, was 500) for the multi-region OSM hunt: dedupe.ts's
  // findDuplicateLeads scans the whole CRM via this same call, and a several-thousand-row CRM
  // silently missing duplicates past row 500 would defeat the point of deduping at all.
  args.$limit = Math.min(Math.max(filter.limit ?? 50, 1), 10_000);
  const sql = `SELECT * FROM leads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY score DESC, id LIMIT $limit`;
  return (db.query(sql).all(args) as Row[]).map(toLead);
}

/** Every excluded lead on file (government/legal aid/non-profit/chain, or a merged-away
 *  duplicate — see exclusions.ts / dedupe.ts), kept for the record, never called or emailed. */
export function excludedLeads(db: Database): Lead[] {
  return (db.query("SELECT * FROM leads WHERE excluded = 1 ORDER BY id").all() as Row[]).map(toLead);
}

/** Folds `mergeId` into `keepId` as a duplicate (same discovered domain or phone — see
 *  dedupe.ts). Never deletes the row: `mergeId` becomes `excluded` with a "duplicate of #<keepId>"
 *  reason and `merged_into = keepId`, so it's kept for the record but never scored/called again.
 *  Any field `keepId` doesn't already have (phone, address, emails, website) is filled in from
 *  `mergeId` — the richer record wins without ever overwriting a value `keepId` already had. Both
 *  leads get an activity note recording the merge. */
export function mergeLead(db: Database, keepId: number, mergeId: number, opts: { by?: string; reason?: string } = {}): { kept: Lead; merged: Lead } {
  if (keepId === mergeId) throw new Error("Can't merge a lead into itself.");
  const keep = findLead(db, keepId);
  const merge = findLead(db, mergeId);
  if (!keep) throw new Error(`No lead #${keepId} to merge into.`);
  if (!merge) throw new Error(`No lead #${mergeId} to merge.`);
  const phone = keep.phone || merge.phone;
  const address = keep.address || merge.address;
  const website = keep.website || merge.website;
  const mapsUrl = keep.mapsUrl || merge.mapsUrl;
  const emails = keep.emails.length ? keep.emails : merge.emails;
  const reason = opts.reason || `duplicate of #${keepId} (${keep.name || keep.placeId})`;
  db.transaction(() => {
    db.query(`UPDATE leads SET phone = $phone, address = $address, website = $website, maps_url = $mapsUrl, emails = $emails,
        website_check = CASE WHEN $website <> '' THEN 'found' ELSE website_check END WHERE id = $id`)
      .run({ $phone: phone, $address: address, $website: website, $mapsUrl: mapsUrl, $emails: JSON.stringify(emails), $id: keepId });
    db.query(`UPDATE leads SET excluded = 1, excluded_reason = $reason, merged_into = $keepId WHERE id = $id`)
      .run({ $reason: reason, $keepId: keepId, $id: mergeId });
  })();
  const kept = findLead(db, keepId)!;
  logActivity(db, kept, { kind: "note", note: `Merged #${mergeId} (${merge.name || merge.placeId}) into this record as a duplicate — kept the richer phone/address/site.`.slice(0, 2000), by: opts.by });
  return { kept: findLead(db, keepId)!, merged: findLead(db, mergeId)! };
}

/** Today's calls: open, non-excluded leads with a phone, due or never contacted, best first.
 *  A Google-sourced lead has no stored phone (Places terms), so it qualifies on its place ID and
 *  gets its phone live at call-prep time (places-live.ts); one whose live lookup finds no phone
 *  simply shows "no phone on file" on its card.
 *  `includeExcluded` (CLI `--all`) also surfaces excluded leads — off by default, since an
 *  excluded lead (government/legal aid/non-profit/chain, or a merged-away duplicate) is never
 *  meant to be called. */
export function callList(db: Database, n = 15, now = new Date(), includeExcluded = false): Lead[] {
  const iso = now.toISOString();
  const rows = db.query(`
    SELECT * FROM leads
    WHERE (excluded = 0 OR $includeExcluded)
      AND (phone != '' OR (source = 'google' AND place_id NOT LIKE 'osm:%' AND place_id NOT LIKE 'manual:%'))
      AND status NOT IN (${CLOSED.map((s) => `'${s}'`).join(",")}, 'interested', 'meeting', 'proposal')
      AND (next_at IS NULL OR next_at <= $now)
      AND (last_contact_at IS NULL OR last_contact_at <= $recent OR status = 'call_back')
    ORDER BY (status = 'call_back') DESC, score DESC LIMIT $n
  `).all({ $now: iso, $recent: new Date(now.getTime() - 3 * 86_400_000).toISOString(), $n: n, $includeExcluded: includeExcluded ? 1 : 0 }) as Row[];
  return rows.map(toLead);
}

/** True once `eventId` has already produced an activity — a replayed dictation or retried
 *  webhook can call `logActivity` again with the same id and it will be a no-op. */
export function eventLogged(db: Database, eventId: string): boolean {
  return !!db.query("SELECT 1 FROM activity_events WHERE event_id = ?").get(eventId);
}

export function logActivity(
  db: Database,
  lead: Lead,
  entry: {
    kind: "call" | "email" | "note" | "meeting";
    outcome?: Status | "";
    note?: string;
    by?: string;
    nextAt?: string | null;
    /** Idempotency key: pass the dictation/webhook's own id so a replay doesn't duplicate this activity. */
    eventId?: string;
  },
) {
  const outcome = entry.outcome ?? "";
  if (outcome && !STATUSES.includes(outcome)) throw new Error(`Unknown outcome "${outcome}".`);
  if (entry.eventId && eventLogged(db, entry.eventId)) return findLead(db, lead.id)!; // replay: already applied
  const at = new Date().toISOString();
  db.transaction(() => {
    const inserted = db.query("INSERT INTO activities (lead_id, at, kind, outcome, note, by) VALUES (?, ?, ?, ?, ?, ?)").run(
      lead.id, at, entry.kind, outcome, (entry.note ?? "").slice(0, 2000), entry.by ?? "",
    );
    if (entry.eventId) {
      db.query("INSERT OR IGNORE INTO activity_events (event_id, activity_id, lead_id) VALUES (?, ?, ?)").run(
        entry.eventId, Number(inserted.lastInsertRowid), lead.id,
      );
    }
    const contact = entry.kind === "call" || entry.kind === "email" || entry.kind === "meeting";
    // Adding context is not completing a promise. The old API sends null for a note without
    // a date, so keep the existing follow-up unless this is a contact/terminal outcome.
    const keepNext = entry.kind === "note" && !entry.nextAt && !["won", "lost", "not_interested", "do_not_contact"].includes(outcome);
    db.query(`UPDATE leads SET status = COALESCE(NULLIF($status, ''), status),
      last_contact_at = CASE WHEN $contact THEN $at ELSE last_contact_at END,
      next_at = CASE WHEN $keepNext THEN next_at ELSE $next END, owner = CASE WHEN owner = '' THEN $by ELSE owner END,
      google_at = CASE WHEN $contact THEN NULL ELSE google_at END WHERE id = $id`).run({
      $status: outcome, $contact: contact ? 1 : 0, $at: at, $next: entry.nextAt ?? null, $keepNext: keepNext ? 1 : 0, $by: entry.by ?? "", $id: lead.id,
    });
    if (outcome === "do_not_contact") {
      db.query("UPDATE leads SET email_ok = 0 WHERE id = ?").run(lead.id);
      for (const e of lead.emails) db.query("INSERT OR IGNORE INTO optouts (value) VALUES (?)").run(e.toLowerCase());
      if (lead.phone) db.query("INSERT OR IGNORE INTO optouts (value) VALUES (?)").run(lead.phone.replace(/\D/g, ""));
    }
  })();
  return findLead(db, lead.id)!;
}

export function activities(db: Database, leadId: number): Activity[] {
  return (db.query("SELECT * FROM activities WHERE lead_id = ? ORDER BY at DESC LIMIT 50").all(leadId) as Row[]).map((r) => ({
    id: r.id, leadId: r.lead_id, at: r.at, kind: r.kind, outcome: r.outcome, note: r.note, by: r.by,
  }));
}

export function isOptedOut(db: Database, value: string) {
  const key = value.includes("@") ? value.toLowerCase() : value.replace(/\D/g, "");
  return !!db.query("SELECT 1 FROM optouts WHERE value = ?").get(key);
}

// --- Daily targets and the day's scorecard (Sydney calendar day) ------------------------------
// Feeds Jarvis's call coach (nudges when a founder is behind) and the evening log in
// Desktop\Business - M&U Ventures\tracking\.
export const sydneyDate = (d: Date | string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));

export function setGoal(db: Database, who: string, dailyCalls: number) {
  db.query(`INSERT INTO goals (who, daily_calls) VALUES (?, ?)
    ON CONFLICT(who) DO UPDATE SET daily_calls = excluded.daily_calls, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(who.toLowerCase(), Math.max(0, Math.round(dailyCalls)));
}

export function goal(db: Database, who: string): number {
  return ((db.query("SELECT daily_calls FROM goals WHERE who = ?").get(who.toLowerCase()) as Row | null)?.daily_calls as number) ?? 0;
}

export type DayActivity = Activity & { leadName: string; vertical: string };
export type DayReport = {
  date: string;
  who: string | null;
  target: number;
  calls: number;
  meetings: number;
  outcomes: Record<string, number>;
  activities: DayActivity[];
  followUpsDue: Lead[];
};

export function dayReport(db: Database, who: string | null, now = new Date()): DayReport {
  const date = sydneyDate(now);
  const since = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const rows = db.query(`SELECT a.*, l.name AS lead_name, l.vertical AS vertical FROM activities a JOIN leads l ON l.id = a.lead_id
    WHERE a.at >= ? ORDER BY a.at`).all(since) as Row[];
  const acts = rows
    .filter((r) => sydneyDate(r.at) === date && (!who || r.by.toLowerCase() === who.toLowerCase()))
    .map((r) => ({ id: r.id, leadId: r.lead_id, at: r.at, kind: r.kind, outcome: r.outcome, note: r.note, by: r.by, leadName: r.lead_name, vertical: r.vertical }));
  const outcomes: Record<string, number> = {};
  for (const a of acts) if (a.kind === "call") outcomes[a.outcome || "logged"] = (outcomes[a.outcome || "logged"] ?? 0) + 1;
  // A follow-up is due once its date arrives; logging the lead again clears or moves next_at.
  // Excluded leads are never due (review T5: Leads, Today and the call queue must agree).
  const due = (db.query(`SELECT * FROM leads WHERE next_at IS NOT NULL AND COALESCE(excluded, 0) = 0 AND status NOT IN (${CLOSED.map((s) => `'${s}'`).join(",")})
    ORDER BY next_at`).all() as Row[])
    .filter((r) => sydneyDate(r.next_at) <= date && (!who || !r.owner || r.owner.toLowerCase() === who.toLowerCase()))
    .map(toLead);
  return {
    date, who, target: who ? goal(db, who) : 0,
    calls: acts.filter((a) => a.kind === "call").length,
    meetings: acts.filter((a) => a.kind === "meeting").length,
    outcomes, activities: acts, followUpsDue: due,
  };
}

export function pipeline(db: Database) {
  return Object.fromEntries((db.query("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all() as Row[]).map((r) => [r.status, r.n]));
}

// --- Places budget (month = Sydney calendar month) -------------------------------------------
export function month(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit" }).format(now);
}
export function usage(db: Database, now = new Date()): Record<string, number> {
  return Object.fromEntries((db.query("SELECT sku, calls FROM places_usage WHERE month = ?").all(month(now)) as Row[]).map((r) => [r.sku, r.calls]));
}
export function countCall(db: Database, sku: string, now = new Date()) {
  db.query("INSERT INTO places_usage (month, sku, calls) VALUES (?, ?, 1) ON CONFLICT(month, sku) DO UPDATE SET calls = calls + 1").run(month(now), sku);
}

// The old 30-day `purgeGoogleCache` (which also exempted any lead a founder had contacted) was
// replaced 27 Sep 2026 by places-cleanup.ts: Places content isn't storable for 30 days, or after a
// call either — only the place ID is. See docs/LEAD-ENGINE.md.

// --- Won deals: an internal kickoff checklist, never anything client-facing ------------------
// Milestone state lives on the existing `kickoffs.checklist` JSON blob (no new table) so
// `kickoff <lead>` can show, per milestone, where delivery actually is — not just a static
// task name — and the single next action. A milestone with no evidence yet stays "pending";
// "partial" is for a milestone that's genuinely started but not complete (e.g. some, not all,
// content collected); "done" carries the date it was actually completed.
export type MilestoneState = "pending" | "partial" | "done";
export type Milestone = { name: string; state: MilestoneState; note?: string; due?: string; completedAt?: string };

export type KickoffChecklist = {
  leadId: number;
  scope: string;
  by: string;
  createdAt: string;
  intake: string[];
  assets: string[];
  access: string[];
  milestones: Milestone[];
};

/** The delivery-playbook milestone set (see MINISTRY-AUTONOMY-BUSINESS-2026-09-24.md §c):
 *  content collected → build started → review sent → revisions closed → balance invoiced →
 *  deployed → handover sent → review/referral asked. */
const BASE_MILESTONES = [
  "Content collected", "Build started", "Review sent", "Revisions closed",
  "Balance invoiced", "Deployed", "Handover sent", "Review/referral asked",
] as const;

/** Standard internal kickoff tasks for a won deal. Nothing here is sent to the client — it's a
 *  founder checklist; `client-kickoff` drafts the actual intake request separately, for approval.
 *  If `existing` is given (re-running `won` on an already-won lead), a milestone's recorded state
 *  is carried over by name rather than reset to "pending" — recording a win again should never
 *  wipe delivery progress already tracked. */
function buildKickoffChecklist(lead: Lead, scope: string, by: string, existing?: KickoffChecklist | null): KickoffChecklist {
  const intake = [
    "Business hours, including any after-hours or on-call arrangement",
    "Who approves drafts and the final launch on their side",
    "Any existing content, domain or account they want kept",
  ];
  const assets = [
    "Logo (vector if they have one) and brand colours",
    "Photos of the practice, office or listings — or their OK to use stock",
    "Existing copy, testimonials or case studies they want reused",
  ];
  const access = ["Domain registrar login, or an agreed DNS change window", "Google Business Profile access (owner or manager)"];
  const names: string[] = [...BASE_MILESTONES];
  if (lead.pitch === "receptionist" || lead.pitch === "both") {
    // Transfer to a person isn't offered in any tier (catalogue; A3 audit): forwarding and routing, not transfer.
    access.push("Who can switch call forwarding on the practice's number, and the cover they want (after hours, overflow, all calls)");
    intake.push("Booking system in use, if any (Cal.com, Google, Cliniko, Dentally, none)");
    intake.push("Common caller questions, and anything the practice never wants answered automatically");
    names.splice(names.indexOf("Deployed"), 0, "Receptionist go-live tests passed (booking, 000, routing, texts if on)");
  }
  const milestones: Milestone[] = names.map((name) => {
    // Defensive against a checklist saved before milestones became objects (a plain string array):
    // an old-shaped entry just can't match, so it falls through to a fresh "pending" milestone
    // instead of throwing on a missing `.name`.
    const prior = existing?.milestones.find((m) => typeof m === "object" && m !== null && m.name?.toLowerCase() === name.toLowerCase());
    return prior ? { ...prior } : { name, state: "pending" };
  });
  return { leadId: lead.id, scope, by, createdAt: new Date().toISOString(), intake, assets, access, milestones };
}

/** Records the win (an activity, outcome `won`) and creates its kickoff checklist. Nothing is
 *  emailed, booked or provisioned — that stays behind a separate approval (see `client-kickoff`). */
export function recordWin(db: Database, lead: Lead, opts: { scope: string; by?: string }): { lead: Lead; kickoff: KickoffChecklist } {
  const scope = opts.scope.trim();
  if (!scope) throw new Error('Say the scope, e.g. --scope "website rebuild + AI receptionist".');
  const by = opts.by ?? "";
  const updated = logActivity(db, lead, { kind: "note", outcome: "won", note: `Won: ${scope}`.slice(0, 2000), by });
  const existing = getKickoff(db, updated.id);
  const kickoff = buildKickoffChecklist(updated, scope, by, existing);
  db.query(`INSERT INTO kickoffs (lead_id, scope, checklist, by) VALUES ($id, $scope, $checklist, $by)
    ON CONFLICT(lead_id) DO UPDATE SET scope = excluded.scope, checklist = excluded.checklist, by = excluded.by, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run({ $id: updated.id, $scope: scope, $checklist: JSON.stringify(kickoff), $by: by });
  return { lead: updated, kickoff };
}

/** The stored kickoff checklist for a won lead, or null if `won` hasn't been run for it yet. */
export function getKickoff(db: Database, leadId: number): KickoffChecklist | null {
  const row = db.query("SELECT checklist FROM kickoffs WHERE lead_id = ?").get(leadId) as Row | null;
  return row ? (JSON.parse(row.checklist) as KickoffChecklist) : null;
}

/** Updates one milestone's state on a won lead's kickoff checklist (found by exact name, or a
 *  unique substring), and leaves an audit-trail note on the lead's own activity history. Never
 *  touches the lead's status — a milestone is delivery progress, not a pipeline outcome. */
export function setMilestone(
  db: Database,
  leadId: number,
  ref: string,
  opts: { state: MilestoneState; note?: string; due?: string; completedAt?: string; by?: string },
): KickoffChecklist {
  const checklist = getKickoff(db, leadId);
  if (!checklist) throw new Error(`No kickoff on file for lead #${leadId}. Run \`won ${leadId} --scope "…"\` first.`);
  const text = ref.trim().toLowerCase();
  const exact = checklist.milestones.find((m) => m.name.toLowerCase() === text);
  const partial = checklist.milestones.filter((m) => m.name.toLowerCase().includes(text));
  const milestone = exact ?? (partial.length === 1 ? partial[0] : null);
  if (!milestone) {
    if (partial.length > 1) throw new Error(`More than one milestone matches "${ref}": ${partial.map((m) => m.name).join(", ")}.`);
    throw new Error(`No milestone matches "${ref}". Options: ${checklist.milestones.map((m) => m.name).join(", ")}.`);
  }
  milestone.state = opts.state;
  if (opts.note !== undefined) milestone.note = opts.note;
  if (opts.due !== undefined) milestone.due = opts.due;
  // Plain Sydney calendar date, not a full ISO instant: a milestone is "done on a day", and a
  // literal `.toISOString()` off a +10:00 offset renders one day early once we slice(0, 10) it.
  if (opts.state === "done") milestone.completedAt = opts.completedAt ?? sydneyDate(new Date());
  else delete milestone.completedAt;
  db.query("UPDATE kickoffs SET checklist = $checklist WHERE lead_id = $id").run({ $checklist: JSON.stringify(checklist), $id: leadId });
  const lead = findLead(db, leadId);
  if (lead) {
    logActivity(db, lead, {
      kind: "note",
      note: `Milestone: ${milestone.name} → ${milestone.state}${milestone.note ? `: ${milestone.note}` : ""}`.slice(0, 2000),
      by: opts.by,
    });
  }
  return checklist;
}

/** The single next action: the first milestone not yet "done", with whatever note/due date is on
 *  file — or null once every milestone is done. Feeds `kickoff <lead>`'s one-line next step. */
export function nextMilestoneAction(checklist: KickoffChecklist): { name: string; detail: string } | null {
  const next = checklist.milestones.find((m) => m.state !== "done");
  if (!next) return null;
  const bits: string[] = [];
  if (next.state === "partial") bits.push("in progress");
  if (next.note) bits.push(next.note);
  if (next.due) bits.push(`due ${next.due}`);
  return { name: next.name, detail: bits.join(" — ") };
}

// --- Prospect-site changes (changedetection.io), folded into the existing lead review ---------
// `watch.ts` already notes a verified change onto the lead's own activity history (kind "note",
// idempotent per changedetection's own last_changed timestamp). This just reads those notes back
// so `calls`/`list`/`stats` can surface a recent one as a reason to reach out — no new table, no
// new alert channel.
export type RecentSiteChange = { leadId: number; leadName: string; at: string; note: string };

export function recentSiteChanges(db: Database, days = 7, now = new Date()): RecentSiteChange[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return (db.query(`
    SELECT a.lead_id AS lead_id, a.at AS at, a.note AS note, l.name AS lead_name FROM activities a
    JOIN leads l ON l.id = a.lead_id
    WHERE a.kind = 'note' AND a.note LIKE 'website changed%' AND a.at >= ?
    ORDER BY a.at DESC
  `).all(since) as Row[]).map((r) => ({ leadId: r.lead_id, leadName: r.lead_name, at: r.at, note: r.note }));
}

// --- Call coaching: scored only from the founder's own post-call debrief --------------------
// Live call capture (recording or listening in) has NOT had legal review — NSW needs every
// party's consent to record a private conversation. Coaching only ever runs on what the founder
// recounts afterwards, and only fills a category it was actually told something about.
export const COACH_CATEGORIES = ["opener", "discovery", "value", "objection", "nextStep", "delivery"] as const;
export type CoachCategory = (typeof COACH_CATEGORIES)[number];
/** Points possible per category (sums to 100) — Opener 15 / Discovery 25 / Value 15 /
 *  Objection handling 20 / Next step 20 / Delivery 5. */
export const COACH_MAX: Record<CoachCategory, number> = { opener: 15, discovery: 25, value: 15, objection: 20, nextStep: 20, delivery: 5 };

export type CoachNote = {
  id: number;
  leadId: number;
  activityId: number | null;
  at: string;
  by: string;
  source: "debrief";
  score: number;
  categories: Partial<Record<CoachCategory, number>>; // a category missing here = "not observed" in the debrief
  objectionTag: string | null;
  worked: string;
  improve: string;
  nextStep: string;
};

function toCoachNote(r: Row): CoachNote {
  return {
    id: r.id, leadId: r.lead_id, activityId: r.activity_id, at: r.at, by: r.by, source: "debrief",
    score: r.score, categories: JSON.parse(r.categories || "{}"), objectionTag: r.objection_tag,
    worked: r.worked, improve: r.improve, nextStep: r.next_step,
  };
}

/** Records one coaching note. Every category score must be within its 0..max range; a category
 *  the debrief didn't cover should simply be left out, never guessed at. */
export function recordCoaching(
  db: Database,
  lead: Lead,
  entry: {
    activityId?: number | null;
    by?: string;
    categories: Partial<Record<CoachCategory, number>>;
    objectionTag?: string | null;
    worked: string;
    improve: string;
    nextStep: string;
  },
): CoachNote {
  for (const [cat, pts] of Object.entries(entry.categories)) {
    if (!COACH_CATEGORIES.includes(cat as CoachCategory)) throw new Error(`Unknown coaching category "${cat}".`);
    if (typeof pts === "number" && (pts < 0 || pts > COACH_MAX[cat as CoachCategory]))
      throw new Error(`${cat} must be between 0 and ${COACH_MAX[cat as CoachCategory]}.`);
  }
  const score = Object.entries(entry.categories).reduce((sum, [, pts]) => sum + (typeof pts === "number" ? pts : 0), 0);
  const inserted = db.query(`
    INSERT INTO coaching (lead_id, activity_id, by, score, categories, objection_tag, worked, improve, next_step)
    VALUES ($leadId, $activityId, $by, $score, $categories, $objectionTag, $worked, $improve, $nextStep)
  `).run({
    $leadId: lead.id, $activityId: entry.activityId ?? null, $by: entry.by ?? "", $score: score,
    $categories: JSON.stringify(entry.categories), $objectionTag: entry.objectionTag ?? null,
    $worked: (entry.worked ?? "").slice(0, 300), $improve: (entry.improve ?? "").slice(0, 300), $nextStep: (entry.nextStep ?? "").slice(0, 300),
  });
  return toCoachNote(db.query("SELECT * FROM coaching WHERE id = ?").get(Number(inserted.lastInsertRowid)) as Row);
}

export function coachingForLead(db: Database, leadId: number, limit = 10): CoachNote[] {
  return (db.query("SELECT * FROM coaching WHERE lead_id = ? ORDER BY at DESC LIMIT ?").all(leadId, limit) as Row[]).map(toCoachNote);
}

export type CoachingSummary = {
  days: number;
  who: string | null;
  count: number;
  averageScore: number | null;
  averageByCategory: Partial<Record<CoachCategory, number>>;
  topObjection: { tag: string; count: number } | null;
  repeatedImprovement: { text: string; count: number } | null;
};

/** Trend view over the last `days` days: average score, the categories dragging it down, the
 *  most common objection tag, and whether the same improvement keeps coming up. */
export function coachingSummary(db: Database, who: string | null, days = 7, now = new Date()): CoachingSummary {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = (db.query("SELECT * FROM coaching WHERE at >= ?" + (who ? " AND by = ?" : "") + " ORDER BY at DESC", ).all(
    ...(who ? [since, who.toLowerCase()] : [since]),
  ) as Row[]).map(toCoachNote);
  const count = rows.length;
  const averageScore = count ? Math.round(rows.reduce((s, r) => s + r.score, 0) / count) : null;
  const averageByCategory: Partial<Record<CoachCategory, number>> = {};
  for (const cat of COACH_CATEGORIES) {
    const seen = rows.filter((r) => typeof r.categories[cat] === "number");
    if (seen.length) averageByCategory[cat] = Math.round((seen.reduce((s, r) => s + (r.categories[cat] ?? 0), 0) / seen.length) * 10) / 10;
  }
  const objectionCounts = new Map<string, number>();
  for (const r of rows) if (r.objectionTag) objectionCounts.set(r.objectionTag, (objectionCounts.get(r.objectionTag) ?? 0) + 1);
  const topObjection = [...objectionCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const improveCounts = new Map<string, number>();
  for (const r of rows) {
    const key = r.improve.trim().toLowerCase();
    if (key) improveCounts.set(key, (improveCounts.get(key) ?? 0) + 1);
  }
  const topImprove = [...improveCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    days, who, count, averageScore, averageByCategory,
    topObjection: topObjection ? { tag: topObjection[0], count: topObjection[1] } : null,
    repeatedImprovement: topImprove && topImprove[1] > 1 ? { text: topImprove[0], count: topImprove[1] } : null,
  };
}
