// One-off (and re-runnable) cleanup of Google Places content already stored in the CRM, 27 Sep
// 2026. Places terms §5.4 allow keeping the place ID indefinitely and nothing else from a Details
// response, so for every `source = 'google'` lead this clears name, phone, address, website,
// Maps URL, rating and reviews — EXCEPT a field whose recorded source is not Places (field_sources,
// or website_source / phone_source naming discovery, the phone finder, the practice's own site or
// a founder's manual check). It also drops the score reasons that only repeat Places content
// (hours, review count, star rating), moves `google_at` into `places_checked_at`, and removes cached
// call scripts written for those leads (they could quote the old stored name). OSM and manual rows
// are never touched. Our own findings (emails from the practice's site, audit reasons, notes,
// activities, outcomes) stay.
//
// DRY RUN by default: prints counts only, writes nothing.
//   bun scripts/leads/places-cleanup.ts [--db <crm.sqlite>] [--root <repo root>]          (dry run)
//   bun scripts/leads/places-cleanup.ts [--db <crm.sqlite>] [--root <repo root>] --apply  (writes)
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { crmPath, openCrm, parseFieldSources, PLACES_FIELD_SOURCES } from "./crm";
import { scriptPath } from "./call-script";

/** Lead field → column, for everything a Details response could have put on a row. */
export const PLACES_CONTENT_FIELDS = [
  ["name", "name"], ["phone", "phone"], ["address", "address"], ["website", "website"],
  ["mapsUrl", "maps_url"], ["rating", "rating"], ["reviews", "reviews"],
] as const;
export type PlacesContentField = (typeof PLACES_CONTENT_FIELDS)[number][0];

/** score.ts reasons built only from Places hours/reviews/rating (score-only, never [verified]). */
export const PLACES_DERIVED_REASONS: RegExp[] = [
  /^after-hours calls go unanswered \(closed evenings or weekends\)$/,
  /^there are only \d+ Google reviews$/,
  /^the Google rating is [\d.]+$/,
  /^Receptionist: after-hours calls go unanswered$/,
];

type Row = Record<string, any>;

/** Where a stored value on a Google row came from: its recorded non-Places source, or "places". */
export function fieldOrigin(row: Row, field: PlacesContentField): string {
  const recorded = parseFieldSources(row.field_sources)[field];
  if (recorded && !PLACES_FIELD_SOURCES.has(recorded)) return recorded;
  if (field === "website" && row.website_source && !PLACES_FIELD_SOURCES.has(row.website_source)) return row.website_source;
  if (field === "phone" && row.phone_source && !PLACES_FIELD_SOURCES.has(row.phone_source)) return row.phone_source;
  return "places";
}

const hasValue = (v: unknown) => v !== null && v !== undefined && v !== "";

export type PlacesCleanupPlan = {
  googleRows: number;
  /** Google rows with at least one change to make. */
  rowsToChange: number;
  /** Values to clear, per field. */
  clear: Record<PlacesContentField, number>;
  /** Values kept on Google rows because their recorded source isn't Places, per field. */
  keptNonPlaces: Record<PlacesContentField, number>;
  reasonsToRemove: number;
  googleAtToMove: number;
  callScriptsToRemove: number;
  applied: boolean;
};

type RowChange = { id: number; sets: Record<string, unknown>; callScript: string | null };

function planRows(db: Database, root: string | null): { plan: PlacesCleanupPlan; changes: RowChange[] } {
  const zero = () => Object.fromEntries(PLACES_CONTENT_FIELDS.map(([f]) => [f, 0])) as Record<PlacesContentField, number>;
  const plan: PlacesCleanupPlan = {
    googleRows: 0, rowsToChange: 0, clear: zero(), keptNonPlaces: zero(),
    reasonsToRemove: 0, googleAtToMove: 0, callScriptsToRemove: 0, applied: false,
  };
  const changes: RowChange[] = [];
  const rows = db.query("SELECT * FROM leads WHERE source = 'google' AND place_id NOT LIKE 'osm:%' AND place_id NOT LIKE 'manual:%' ORDER BY id").all() as Row[];
  for (const row of rows) {
    plan.googleRows++;
    const sets: Record<string, unknown> = {};
    for (const [field, column] of PLACES_CONTENT_FIELDS) {
      if (!hasValue(row[column])) continue;
      if (fieldOrigin(row, field) === "places") {
        sets[column] = column === "rating" || column === "reviews" ? null : "";
        plan.clear[field]++;
      } else plan.keptNonPlaces[field]++;
    }
    let reasons: string[] = [];
    try {
      reasons = JSON.parse(row.reasons || "[]");
    } catch {
      reasons = [];
    }
    const keptReasons = reasons.filter((r) => !PLACES_DERIVED_REASONS.some((re) => re.test(String(r))));
    if (keptReasons.length !== reasons.length) {
      sets.reasons = JSON.stringify(keptReasons);
      plan.reasonsToRemove += reasons.length - keptReasons.length;
    }
    if (row.google_at) {
      sets.google_at = null;
      sets.places_checked_at = row.places_checked_at ?? row.google_at;
      plan.googleAtToMove++;
    }
    const script = root ? scriptPath(root, row.id) : null;
    const callScript = script && existsSync(script) ? script : null;
    if (callScript) plan.callScriptsToRemove++;
    if (Object.keys(sets).length || callScript) {
      plan.rowsToChange++;
      changes.push({ id: row.id, sets, callScript });
    }
  }
  return { plan, changes };
}

/** Counts only; writes nothing. `root` (the repo root) lets it count cached call scripts too. */
export function planPlacesCleanup(db: Database, opts: { root?: string | null } = {}): PlacesCleanupPlan {
  return planRows(db, opts.root ?? null).plan;
}

/** Applies the plan in one transaction, then removes the listed call-script cache files. */
export function applyPlacesCleanup(db: Database, opts: { root?: string | null } = {}): PlacesCleanupPlan {
  const { plan, changes } = planRows(db, opts.root ?? null);
  db.transaction(() => {
    for (const change of changes) {
      const columns = Object.keys(change.sets);
      if (!columns.length) continue;
      const params: Record<string, unknown> = { $id: change.id };
      for (const c of columns) params[`$${c}`] = change.sets[c];
      db.query(`UPDATE leads SET ${columns.map((c) => `${c} = $${c}`).join(", ")} WHERE id = $id`).run(params as any);
    }
  })();
  for (const change of changes) if (change.callScript) rmSync(change.callScript, { force: true });
  return { ...plan, applied: true };
}

/** Replaces the old 30-day `purgeGoogleCache`: same call shape (returns rows changed), strict rules. */
export function purgeGoogleCache(db: Database, opts: { root?: string | null } = {}): number {
  return applyPlacesCleanup(db, opts).rowsToChange;
}

export function renderCleanupPlan(plan: PlacesCleanupPlan, file: string): string {
  const fields = (counts: Record<string, number>) => Object.entries(counts).map(([f, n]) => `${f} ${n}`).join(", ");
  return [
    `${plan.applied ? "APPLIED" : "DRY RUN (nothing written)"} — Google Places cleanup of ${file}`,
    `Google-sourced leads: ${plan.googleRows} · leads to change: ${plan.rowsToChange}`,
    `Places values to clear: ${fields(plan.clear)}`,
    `Kept (recorded non-Places source): ${fields(plan.keptNonPlaces)}`,
    `Places-only score reasons to drop: ${plan.reasonsToRemove} · google_at → places_checked_at: ${plan.googleAtToMove} · cached call scripts to remove: ${plan.callScriptsToRemove}`,
    plan.applied ? "Place IDs kept. OSM and manual leads untouched." : "Re-run with --apply to write these changes. Place IDs are always kept; OSM and manual leads are never touched.",
  ].join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const root = resolve(flag("root") ?? resolve(import.meta.dir, "..", ".."));
  const file = resolve(flag("db") ?? crmPath(root));
  if (!existsSync(file)) {
    console.error(`No CRM at ${file}.`);
    process.exit(1);
  }
  const apply = argv.includes("--apply");
  // A dry run opens the file read-only: no schema migration, no write of any kind.
  const db = apply ? openCrm(file) : new Database(file, { readonly: true });
  try {
    const plan = apply ? applyPlacesCleanup(db, { root }) : planPlacesCleanup(db, { root });
    console.log(argv.includes("--json") ? JSON.stringify(plan, null, 2) : renderCleanupPlan(plan, file));
  } finally {
    db.close();
  }
}
