// OpenStreetMap lead source — free, no billing, the default (Google Places stays as an opt-in
// fallback in places.ts/engine.ts for when the key works). Two public services, both used
// politely:
//   1. Overpass (https://overpass-api.de/api/interpreter) for the actual business search, by tag
//      per vertical, inside a bounding box.
//   2. Nominatim (https://nominatim.openstreetmap.org) only to geocode an area *not* already in
//      the suburb table below, at <=1 request/second with a proper User-Agent, per Nominatim's
//      usage policy.
// OSM data is ODbL: it may be stored permanently (unlike Google Places content), provided
// "© OpenStreetMap contributors" attribution travels with it — every lead this file produces
// carries that in its `attribution` field, and the CRM's 30-day Google purge is scoped to
// `source = 'google'` so it never touches these rows (see crm.ts).
import type { Database } from "bun:sqlite";
import { countCall, knownPlaceIds, upsertLead, type Lead, type WebsiteCheck } from "./crm";
import { discoverWebsiteDetailed, type DiscoveryDeps } from "./discovery";
import { normaliseFindArea, normaliseWebsitePresence, type WebsitePresence } from "./find-input";
import { enrichWebsite, looksPersonal } from "./enrich";
import { checkExclusion } from "./exclusions";
import type { Vertical } from "./places";
import { scoreLead } from "./score";
import { EMPTY_SITE_AUDIT } from "./site-audit";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

export const VERTICAL_OSM_TAGS: Record<Vertical, { key: string; value: string }> = {
  dental: { key: "amenity", value: "dentist" },
  legal: { key: "office", value: "lawyer" },
  "real-estate": { key: "office", value: "estate_agent" },
};

export type BBox = { south: number; west: number; north: number; east: number };

/** Measured 24 Sep 2026: dentists 367, lawyers 99, real estate 440 inside this box. */
export const SYDNEY_BBOX: BBox = { south: -34.1, west: 150.6, north: -33.6, east: 151.35 };

// OSM's POI coverage is thinner than Google's, especially for small professional services in
// outer suburbs — measured 24 Sep 2026: a tight ~2 km box around Mount Druitt returned 0 tagged
// dentists, a ~6.5 km box returned 3. ~3.5 km half-width (a suburb plus its immediate surrounds)
// is a better trade-off between relevance and actually finding anything.
function box(lat: number, lon: number, halfLat = 0.032, halfLon = 0.038): BBox {
  return { south: lat - halfLat, west: lon - halfLon, north: lat + halfLat, east: lon + halfLon };
}

/** Western Sydney home patch, matching the Hermes nightly rotation (lead-hunt.py's AREAS list) so
 *  the cron never has to fall back to Nominatim for its usual suburbs. Centroids are
 *  approximate (~2 km boxes) — good enough for a business search; add more as the rotation grows. */
const SUBURB_CENTROIDS: Record<string, [number, number]> = {
  "mount druitt": [-33.7681, 150.8202], "rooty hill": [-33.7686, 150.8515], "st marys": [-33.7629, 150.7739],
  "blacktown": [-33.7688, 150.9061], "doonside": [-33.757, 150.8676], "plumpton": [-33.7429, 150.8447],
  "minchinbury": [-33.7702, 150.8298], "glendenning": [-33.7434, 150.8267], "colyton": [-33.7714, 150.8017],
  "oxley park": [-33.7614, 150.7904], "kingswood": [-33.7597, 150.7274], "penrith": [-33.7507, 150.6944],
  "werrington": [-33.7639, 150.7134], "seven hills": [-33.7778, 150.9349], "quakers hill": [-33.7304, 150.8757],
  "schofields": [-33.7075, 150.8698], "riverstone": [-33.679, 150.857], "glenwood": [-33.7346, 150.9349],
  "kellyville ridge": [-33.7132, 150.9126], "marsden park": [-33.7057, 150.8425], "erskine park": [-33.7889, 150.7808],
  "st clair": [-33.7913, 150.8047], "emu plains": [-33.75, 150.6614], "toongabbie": [-33.7853, 150.9553],
  "wentworthville": [-33.8073, 150.9722],
};

export const AREA_BBOX: Record<string, BBox> = Object.fromEntries(
  Object.entries(SUBURB_CENTROIDS).map(([name, [lat, lon]]) => [name, box(lat, lon)]),
);

function normaliseAreaName(area: string): string {
  return area.trim().toLowerCase().replace(/\s+/g, " ")
    .replace(/\s*,?\s*australia$/i, "").replace(/\s*,?\s*nsw$/i, "").trim();
}

/** The suburb table, or the whole-Sydney box for "Sydney"/"Greater Sydney" — no network call. */
export function tableBbox(area: string): BBox | null {
  const key = normaliseAreaName(area);
  if (key === "sydney" || key === "greater sydney") return SYDNEY_BBOX;
  return AREA_BBOX[key] ?? null;
}

const NOMINATIM_USER_AGENT = "MU-Ventures-LeadEngine/1.0 (+https://muventures.com.au; contact: muventuresau@muventures.com.au)";
let lastNominatimCallAt = 0;

/** Nominatim's usage policy caps unauthenticated use at 1 request/second. */
async function respectNominatimRate(): Promise<void> {
  const wait = 1_000 - (Date.now() - lastNominatimCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimCallAt = Date.now();
}

export async function nominatimBbox(area: string, request: typeof fetch = fetch): Promise<BBox | null> {
  await respectNominatimRate();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(area)}`;
  const response = await request(url, { headers: { "User-Agent": NOMINATIM_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => [])) as any;
  const hit = Array.isArray(data) ? data[0] : null;
  const bb = hit?.boundingbox;
  if (!Array.isArray(bb) || bb.length !== 4) return null;
  const [south, north, west, east] = bb.map(Number); // Nominatim's own order
  if ([south, north, west, east].some((n) => !Number.isFinite(n))) return null;
  return { south, west, north, east };
}

/** The suburb table first (instant, no network); Nominatim only for an area we don't have. */
export async function resolveBbox(area: string, request: typeof fetch = fetch): Promise<BBox> {
  const fromTable = tableBbox(area);
  if (fromTable) return fromTable;
  const fromNominatim = await nominatimBbox(area, request);
  if (fromNominatim) return fromNominatim;
  throw new Error(`Don't know where "${area}" is — try a listed western Sydney suburb, "Greater Sydney", or check the spelling.`);
}

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_USER_AGENT = "MU-Ventures-LeadEngine/1.0 (+https://muventures.com.au; contact: muventuresau@muventures.com.au)";

export function buildOverpassQuery(vertical: Vertical, bbox: BBox): string {
  const { key, value } = VERTICAL_OSM_TAGS[vertical];
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:25];(node["${key}"="${value}"](${b});way["${key}"="${value}"](${b});relation["${key}"="${value}"](${b}););out center tags;`;
}

/** HTTP statuses Overpass returns when it is busy or its query timed out: worth a paced retry. */
export const OVERPASS_TRANSIENT = new Set([429, 502, 503, 504]);
/** Overpass failed; `transient` says a later retry may work (busy/timeout), `status` is the HTTP code. */
export class OverpassError extends Error {
  constructor(message: string, readonly status: number | null, readonly transient: boolean) { super(message); }
}

/**
 * Overpass endpoints, in order. Default: the main instance only. `OVERPASS_URLS` (comma-separated)
 * adds mirrors, e.g. "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter";
 * a mirror is only used when the owner has put it there.
 */
export function overpassEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.OVERPASS_URLS ?? "").split(",").map((u) => u.trim()).filter((u) => /^https:\/\/[^\s/]+\/\S*$/.test(u) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/\S*$/.test(u)); // loopback http: a local stub for browser tests only, unset by default
  return list.length ? [...new Set(list)] : [OVERPASS_URL];
}

export async function fetchOsmElements(vertical: Vertical, bbox: BBox, request: typeof fetch = fetch, url: string = OVERPASS_URL): Promise<any[]> {
  let response: Response;
  try {
    response = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": OVERPASS_USER_AGENT },
    body: `data=${encodeURIComponent(buildOverpassQuery(vertical, bbox))}`,
    signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && /timeout|timed out|abort/i.test(`${error.name} ${error.message}`);
    throw new OverpassError(timedOut ? "Overpass timeout: no answer in 30 s" : `Overpass unreachable: ${error instanceof Error ? error.name : "network error"}`, null, true);
  }
  if (!response.ok) throw new OverpassError(`Overpass ${response.status}: ${response.statusText}`, response.status, OVERPASS_TRANSIENT.has(response.status));
  const data = (await response.json().catch(() => ({}))) as { elements?: unknown };
  return Array.isArray(data.elements) ? (data.elements as any[]) : [];
}

/**
 * The nightly hunt's Overpass read: each endpoint gets a few paced tries on a busy/timeout answer
 * (429/502/503/504, no answer) at fixed pauses (0, 20, 60 s; Retry-After is not read), then the next endpoint. A
 * permanent error (400 bad query, 403) stops at once. The final error names the status, the
 * attempts and the hosts, so the Hermes wrapper can say "timed out" rather than "rate-limited".
 */
export async function fetchOsmElementsWithRetry(
  vertical: Vertical, bbox: BBox, request: typeof fetch = fetch,
  opts: { endpoints?: string[]; backoffsMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<any[]> {
  const endpoints = opts.endpoints ?? overpassEndpoints();
  const backoffs = opts.backoffsMs ?? [0, 20_000, 60_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: OverpassError | null = null, attempts = 0;
  for (const url of endpoints) {
    for (const wait of backoffs) {
      if (wait > 0) await sleep(wait);
      attempts++;
      try {
        return await fetchOsmElements(vertical, bbox, request, url);
      } catch (error) {
        if (!(error instanceof OverpassError)) throw error;
        last = error;
        if (!error.transient) throw error;
      }
    }
  }
  const hosts = endpoints.map((u) => { try { return new URL(u).host; } catch { return u; } }).join(", ");
  throw new OverpassError(`${last?.message ?? "Overpass failed"} (after ${attempts} attempts: ${hosts})`, last?.status ?? null, true);
}

export type OsmLead = {
  sourceId: string; // "osm:node/12345"
  name: string;
  phone: string;
  website: string;
  email: string;
  address: string;
  postcode: string;
  /** Explicit OSM locality tag, kept separately from the broader requested search area. */
  locality?: string;
  lat: number | null;
  lon: number | null;
  mapsUrl: string;
  attribution: string;
  /** Who actually runs this location (a franchisor, a department) — OSM `operator` tag, used by
   *  exclusions.ts alongside `name`. */
  operator: string;
  /** The chain/brand this location trades under — OSM `brand` tag. */
  brand: string;
};

function tagsGet(tags: Record<string, string> | undefined, ...keys: string[]): string {
  if (!tags) return "";
  for (const key of keys) if (tags[key]) return String(tags[key]).trim();
  return "";
}

function addressFrom(tags: Record<string, string> | undefined): string {
  if (!tags) return "";
  const streetPart = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const suburb = tags["addr:suburb"] || tags["addr:city"] || "";
  const state = tags["addr:state"] || (suburb ? "NSW" : "");
  const locality = [suburb, state, tags["addr:postcode"]].filter(Boolean).join(" ");
  return [streetPart, locality].filter(Boolean).join(", ");
}

/** Raw Overpass element -> lead shape, or null for an unnamed feature (not a callable lead). */
export function normaliseOsmElement(el: any): OsmLead | null {
  const tags = el?.tags as Record<string, string> | undefined;
  const name = String(tags?.name ?? "").trim();
  if (!name || !el?.type || el?.id === undefined) return null;
  const lat = typeof el.lat === "number" ? el.lat : (typeof el.center?.lat === "number" ? el.center.lat : null);
  const lon = typeof el.lon === "number" ? el.lon : (typeof el.center?.lon === "number" ? el.center.lon : null);
  return {
    sourceId: `osm:${el.type}/${el.id}`,
    name,
    phone: tagsGet(tags, "phone", "contact:phone"),
    website: tagsGet(tags, "website", "contact:website"),
    email: tagsGet(tags, "email", "contact:email"),
    address: addressFrom(tags),
    postcode: tags?.["addr:postcode"] ?? "",
    locality: tagsGet(tags, "addr:suburb") || tagsGet(tags, "addr:locality") || tagsGet(tags, "addr:city"),
    lat, lon,
    mapsUrl: lat !== null && lon !== null ? `https://www.openstreetmap.org/${el.type}/${el.id}` : "",
    attribution: OSM_ATTRIBUTION,
    operator: tagsGet(tags, "operator"),
    brand: tagsGet(tags, "brand"),
  };
}

/** Dedupes by OSM id (the same node can't appear twice from one query, but two runs might
 *  overlap) and then by name+postcode (a business mapped as both a node and a nearby building/way
 *  is a duplicate business, not two leads). */
export function dedupeOsmLeads(leads: OsmLead[]): OsmLead[] {
  const seenId = new Map<string, number>();
  const seenNamePostcode = new Map<string, number>();
  const out: OsmLead[] = [];
  for (const lead of leads) {
    const key = lead.name && lead.postcode ? `${lead.name.trim().toLowerCase()}|${lead.postcode}` : "";
    const existing = seenId.get(lead.sourceId) ?? (key ? seenNamePostcode.get(key) : undefined);
    if (existing !== undefined) {
      // A node and its building may carry complementary tags. Keep the first stable source ID
      // and prefer its existing values, but don't discard a website/contact on the duplicate.
      // This operates only on source results, never on a saved, user-corrected CRM record.
      const kept = { ...out[existing] };
      for (const field of ["phone", "website", "email", "address", "postcode", "locality", "operator", "brand"] as const) {
        if (!kept[field] && lead[field]) kept[field] = lead[field];
      }
      out[existing] = kept;
      seenId.set(lead.sourceId, existing);
      if (key) seenNamePostcode.set(key, existing);
      continue;
    }
    seenId.set(lead.sourceId, out.length);
    if (key) seenNamePostcode.set(key, out.length);
    out.push({ ...lead });
  }
  return out;
}

export async function searchOsm(vertical: Vertical, area: string, request: typeof fetch = fetch, retry?: Parameters<typeof fetchOsmElementsWithRetry>[3]): Promise<{ area: string; bbox: BBox; leads: OsmLead[] }> {
  const bbox = await resolveBbox(area, request);
  const elements = await fetchOsmElementsWithRetry(vertical, bbox, request, retry);
  const leads = dedupeOsmLeads(elements.map(normaliseOsmElement).filter((l): l is OsmLead => l !== null));
  return { area, bbox, leads };
}

export type OsmFindResult = {
  vertical: Vertical;
  area: string;
  source: "osm";
  searched: number;
  alreadyKnown: number;
  added: Lead[];
  noWebsite: number;
  withPhone: number;
  withEmail: number;
  flaggedPersonalEmails: number;
  attribution: string;
  /** Government/legal aid/non-profit/national chain — see exclusions.ts. Kept in the CRM, never scored. */
  excluded: number;
  /** OSM had no `website` tag, but discovery.ts actually found one before scoring ran. */
  discovered: number;
  /** Selection counts apply to fresh source records, before discovery/enrichment and its cap. */
  websitePresence: WebsitePresence;
  matched: number;
  filteredOut: number;
  limited: number;
  /** Website lookup was blocked/inconclusive, not evidence that the business has no site. */
  unverifiable: number;
};

/** find, via OpenStreetMap: Overpass search (free) -> skip ids already in the CRM -> exclude
 *  government/legal-aid/non-profit/national-chain results (exclusions.ts) -> for a lead with no
 *  `website` tag, actually look for one (discovery.ts) before assuming there isn't one -> enrich
 *  the real site (politely, capped concurrency, skipped past `enrichMax`) -> score -> CRM.
 *  Missing source tags select candidates only; failed discovery leaves absence unverified. */
export async function findLeadsOsm(
  db: Database,
  opts: {
    vertical: Vertical; area: string; max?: number; enrichMax?: number; request?: typeof fetch; concurrency?: number;
    websitePresence?: WebsitePresence;
    /** Injectable for tests: skip live discovery calls (Hermes/DuckDuckGo/domain guess). */
    discovery?: DiscoveryDeps;
  },
): Promise<OsmFindResult> {
  const request = opts.request ?? fetch;
  const area = normaliseFindArea(opts.area);
  const websitePresence = normaliseWebsitePresence(opts.websitePresence);
  const suburb = area.replace(/(?:,\s*|\s+)Australia$/i, "").replace(/(?:,\s*|\s+)NSW$/i, "").trim();
  const { leads } = await searchOsm(opts.vertical, area, request);
  countCall(db, "osm_overpass_query");
  const known = knownPlaceIds(db);
  const fresh = leads.filter((l) => !known.has(l.sourceId));
  const matching = websitePresence === "missing" ? fresh.filter((l) => !l.website) : fresh;
  const max = Math.max(opts.max ?? fresh.length, 1);
  const queue = matching.slice(0, max);
  const limited = matching.length - queue.length;
  const enrichMax = Math.max(opts.enrichMax ?? 60, 0);
  let enriched = 0;

  const added: Lead[] = [];
  let flaggedPersonalEmails = 0;
  let excludedCount = 0;
  let discoveredCount = 0;
  let unverifiableCount = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, queue.length)) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const exclusion = checkExclusion({ name: item.name, operator: item.operator, brand: item.brand });
      if (exclusion.excluded) {
        excludedCount++;
        added.push(
          upsertLead(db, {
            placeId: item.sourceId, vertical: opts.vertical, area, name: item.name,
            phone: item.phone, address: item.address, website: item.website, mapsUrl: item.mapsUrl,
            rating: null, reviews: null, emails: [], emailOk: false,
            score: 0, pitch: "website", reasons: [`excluded: ${exclusion.reason}`], googleAt: null,
            source: "osm", attribution: item.attribution, excluded: true, excludedReason: exclusion.reason,
          }),
        );
        continue;
      }

      const emails = new Set<string>(item.email ? [item.email.toLowerCase()] : []);
      const phones = new Set<string>(item.phone ? [item.phone] : []);
      let audit = EMPTY_SITE_AUDIT;
      let finalUrl = item.website;
      let websiteSource = item.website ? "osm_tag" : "";
      let websiteConfidence: number | null = item.website ? 1 : null;
      let websiteCheckedAt: string | null = null;
      let websiteCheck: WebsiteCheck = item.website ? "found" : "not-checked";
      let unverifiableReason: string | null = null;

      if (!finalUrl) {
        const outcome = await discoverWebsiteDetailed(
          { name: item.name, suburb: item.locality || suburb, postcode: item.postcode, vertical: opts.vertical, phone: item.phone, address: item.address },
          { request, ...opts.discovery },
        );
        if (outcome.kind === "found") {
          discoveredCount++;
          finalUrl = outcome.site.url;
          websiteSource = `discovered_${outcome.site.source}`;
          websiteConfidence = outcome.site.confidence;
          websiteCheckedAt = outcome.site.checkedAt;
          websiteCheck = "found";
        } else if (outcome.kind === "none") {
          websiteCheckedAt = new Date().toISOString();
          websiteCheck = "none-verified"; // discovery only reports "none" once a real search engine answered
        } else {
          websiteCheck = outcome.cause === "search-unavailable" ? "search-unavailable" : "check-failed";
          unverifiableCount++;
          // This timestamp is consumed elsewhere as absence evidence when website is blank.
          // An attempted but inconclusive check must therefore leave it empty.
          unverifiableReason = `${outcome.reason ?? "site found but unverifiable"} (checked ${outcome.checkedAt.slice(0, 10)})`;
        }
      }

      if (finalUrl && enriched < enrichMax) {
        enriched++;
        const result = await enrichWebsite(finalUrl, request);
        audit = result.audit;
        finalUrl = audit.finalUrl || finalUrl;
        for (const e of result.emails) emails.add(e.value);
        for (const p of result.phones) phones.add(p);
        flaggedPersonalEmails += result.flaggedPersonal.length;
      }
      const usableEmails = [...emails].filter((e) => !looksPersonal(e));
      const scored = scoreLead(
        { website: finalUrl, rating: null, reviews: null, hours: [], noWebsiteCheckedAt: finalUrl ? null : websiteCheckedAt },
        audit,
        opts.vertical,
      );
      if (unverifiableReason) scored.reasons = [unverifiableReason];
      added.push(
        upsertLead(db, {
          placeId: item.sourceId, vertical: opts.vertical, area, name: item.name,
          phone: [...phones][0] ?? "", address: item.address, website: finalUrl, mapsUrl: item.mapsUrl,
          rating: null, reviews: null, emails: usableEmails, emailOk: usableEmails.length > 0 && !audit.noUnsolicited && !unverifiableReason,
          score: scored.score, pitch: scored.pitch, reasons: scored.reasons, googleAt: null,
          source: "osm", attribution: item.attribution,
          websiteSource, websiteConfidence, websiteCheckedAt, websiteCheck,
        }),
      );
    }
  });
  await Promise.all(workers);
  added.sort((a, b) => b.score - a.score);
  return {
    vertical: opts.vertical, area, source: "osm", searched: leads.length, alreadyKnown: leads.length - fresh.length,
    added, noWebsite: added.filter((l) => !l.excluded && !l.website).length, withPhone: added.filter((l) => l.phone).length,
    withEmail: added.filter((l) => l.emails.length > 0).length, flaggedPersonalEmails, attribution: OSM_ATTRIBUTION,
    excluded: excludedCount, discovered: discoveredCount,
    websitePresence, matched: matching.length, filteredOut: fresh.length - matching.length, limited,
    unverifiable: unverifiableCount,
  };
}
