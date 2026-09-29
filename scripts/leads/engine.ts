// find: OpenStreetMap (Overpass, free, the default — see osm.ts) or Google Places (opt-in, only
// when its key works — see places.ts) → skip ids we already have → website audit → score → CRM.
import type { Database } from "bun:sqlite";
import { countCall, knownPlaceIds, upsertLead, usage, type Lead } from "./crm";
import { findLeadsOsm } from "./osm";
import { MONTHLY_DETAILS_BUDGET, placeDetails, placesKey, searchPlaceIds, type Vertical } from "./places";
import { withPlaceDetails, type LiveLead } from "./places-live";
import { scoreLead } from "./score";
import { auditSite } from "./site-audit";

export { MONTHLY_DETAILS_BUDGET };

export type Source = "osm" | "google";

export type FindResult = {
  vertical: Vertical;
  area: string;
  source: Source;
  searched: number;
  alreadyKnown: number;
  /** Google: each lead carries `placesLive` (its display fields come from this run's in-memory
   *  details and must be shown with Google attribution); the CRM row holds only the place ID. */
  added: LiveLead[];
  noWebsite: number;
  withPhone: number;
  withEmail: number;
  /** Google only. */
  skippedClosed?: number;
  budgetLeft?: number;
  stoppedForBudget?: boolean;
  /** OSM only. */
  flaggedPersonalEmails?: number;
  attribution?: string;
  /** OSM only: government/legal-aid/non-profit/national-chain leads kept but never scored. */
  excluded?: number;
  /** OSM only: had no `website` tag, but discovery.ts found one before scoring ran. */
  discovered?: number;
};

export type FindOpts = {
  vertical: Vertical;
  area: string;
  /** Defaults to "osm": free, no billing, no key needed. Pass "google" to use Places instead
   *  (only works while its key is valid — see docs/LEAD-ENGINE.md). */
  source?: Source;
  max?: number;
  enrichMax?: number;
  key?: string;
  request?: typeof fetch;
  budget?: number;
  concurrency?: number;
};

export async function findLeads(db: Database, opts: FindOpts): Promise<FindResult> {
  if ((opts.source ?? "osm") === "osm") {
    const result = await findLeadsOsm(db, {
      vertical: opts.vertical, area: opts.area, max: opts.max, enrichMax: opts.enrichMax,
      request: opts.request, concurrency: opts.concurrency,
    });
    return { ...result };
  }
  return findLeadsGoogle(db, opts);
}

async function findLeadsGoogle(db: Database, opts: FindOpts): Promise<FindResult> {
  const key = opts.key ?? placesKey();
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY isn't set in ~/.config/agentic-os.env.");
  const request = opts.request ?? fetch;
  const budget = opts.budget ?? MONTHLY_DETAILS_BUDGET;
  const max = Math.min(Math.max(opts.max ?? 20, 1), 60);
  const area = opts.area.trim().slice(0, 120);
  if (!area) throw new Error("Say where, e.g. \"Parramatta NSW\".");

  const ids = await searchPlaceIds(opts.vertical, area, max, key, request);
  countCall(db, "text_search_ids");
  const known = knownPlaceIds(db);
  const fresh = ids.filter((id) => !known.has(id));
  let left = budget - (usage(db).details_enterprise ?? 0);
  const allowed = fresh.slice(0, Math.max(left, 0));

  const added: LiveLead[] = [];
  let skippedClosed = 0;
  const queue = [...allowed];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const place = await placeDetails(id, key, request);
      countCall(db, "details_enterprise");
      left--;
      if (place.status && place.status !== "OPERATIONAL") {
        skippedClosed++;
        continue;
      }
      // The practice's own site is audited (its findings and published emails are ours to keep),
      // but nothing from the Details response is stored and nothing Places-only feeds the stored
      // score: rating, review count and hours are left out so no derived reason repeats them.
      const site = await auditSite(place.website, request);
      const scored = scoreLead({ website: place.website, rating: null, reviews: null, hours: [] }, site, opts.vertical);
      const checkedAt = new Date().toISOString();
      const stored = upsertLead(db, {
        // A number the practice publishes on its own site is ours to keep (source recorded).
        placeId: place.placeId, vertical: opts.vertical, area, name: "", phone: site.phones[0] ?? "", address: "", website: "", mapsUrl: "",
        rating: null, reviews: null, emails: site.emails,
        emailOk: site.emails.length > 0 && !site.noUnsolicited,
        score: scored.score, pitch: scored.pitch, reasons: scored.reasons, googleAt: null,
        source: "google", placesCheckedAt: checkedAt,
        fieldSources: {
          ...(site.emails.length ? { emails: "website" } : {}),
          ...(site.phones.length ? { phone: "website" } : {}),
        },
      });
      // What `find` reports back is display-only: the same in-memory details, attributed.
      added.push(withPlaceDetails(stored, { ...place, website: site.finalUrl || place.website }, checkedAt));
    }
  });
  await Promise.all(workers);
  added.sort((a, b) => b.score - a.score);
  return {
    vertical: opts.vertical, area, source: "google", searched: ids.length, alreadyKnown: ids.length - fresh.length, added,
    noWebsite: added.filter((l) => !l.website).length, withPhone: added.filter((l) => l.phone).length,
    withEmail: added.filter((l) => l.emails.length > 0).length,
    skippedClosed, budgetLeft: Math.max(left, 0), stoppedForBudget: allowed.length < fresh.length,
  };
}
