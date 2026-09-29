// Google Places API (New) for the lead engine. Two calls only, chosen for cost:
//   1. Text Search with an IDs-only field mask ("Text Search Essentials (IDs Only)": free, unlimited);
//   2. Place Details for place IDs we have never seen ("Place Details Enterprise": 1,000 free a
//      month, then US$20 per 1,000), because phone and website only exist at that tier.
// The key is read from ~/.config/agentic-os.env and never logged or returned.
//
// Storage rule (27 Sep 2026, Google Maps Platform Service Specific Terms, Places §5.2–5.4, and the
// Places API (New) policies page — see docs/sales/dental-call-pack-2026-09-28/08-lead-source-decision.md):
// the ONLY Places value the CRM keeps is the place ID (exempt from the caching limits). Name,
// address, phone, website, rating, reviews, hours and the Maps URL are fetched live when a lead is
// displayed or prepped for a call (places-live.ts), held in memory for that one request, and shown
// with Google attribution. Nothing from a Details response is written to .operator-data.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERTICALS = {
  dental: { includedType: "dentist", query: "dentist" },
  "real-estate": { includedType: "real_estate_agency", query: "real estate agency" },
  legal: { includedType: "lawyer", query: "law firm" },
} as const;
export type Vertical = keyof typeof VERTICALS;

export function isVertical(value: unknown): value is Vertical {
  return typeof value === "string" && value in VERTICALS;
}

/** Google gives 1,000 Place Details Enterprise calls a month free; stay under it. Shared by the
 *  `find` path (engine.ts) and live display lookups (places-live.ts). */
export const MONTHLY_DETAILS_BUDGET = 900;

/** Attribution shown wherever Places content is rendered without a Google map (Places §5.2 and
 *  the Places API (New) policies page). Text form for CLI/Telegram; the OS drawer renders the same
 *  words. Check Google's current logo/attribution style guide before any client-facing use. */
export const PLACES_ATTRIBUTION = "Google Maps";

/** A Google place ID, as opposed to an `osm:<type>/<id>` or `manual:<slug>` CRM key. */
export function isGooglePlaceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{10,300}$/.test(id) && !id.startsWith("osm") && !id.startsWith("manual");
}

/** A Google Maps link built from the place ID alone (storable indefinitely), so a lead can link to
 *  its listing without keeping Google's own `googleMapsUri`. */
export function mapsUrlForPlaceId(placeId: string): string {
  return `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(placeId)}`;
}

export type PlaceDetails = {
  placeId: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  rating: number | null;
  reviews: number | null;
  status: string;
  mapsUrl: string;
  hours: string[];
};

const DETAIL_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "nationalPhoneNumber",
  "websiteUri",
  "rating",
  "userRatingCount",
  "businessStatus",
  "googleMapsUri",
  "regularOpeningHours.weekdayDescriptions",
].join(",");

export function placesKey(home = homedir()): string {
  try {
    for (const line of readFileSync(join(home, ".config", "agentic-os.env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*GOOGLE_PLACES_API_KEY\s*=\s*(.*)$/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* reported below without the path */
  }
  return "";
}

type Fetch = typeof fetch;

async function call(request: Fetch, url: string, key: string, fieldMask: string, body?: unknown) {
  const response = await request(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": fieldMask,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    // Google's message never contains the key; keep it short for Telegram.
    const message = String(data?.error?.message ?? response.statusText).slice(0, 200);
    throw new Error(`Places API ${response.status}: ${message}`);
  }
  return data;
}

/** Up to `max` place IDs (Google stops at 60 per query). Free: IDs-only mask. */
export async function searchPlaceIds(
  vertical: Vertical,
  area: string,
  max: number,
  key: string,
  request: Fetch = fetch,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const data = await call(request, "https://places.googleapis.com/v1/places:searchText", key, "places.id,nextPageToken", {
      textQuery: `${VERTICALS[vertical].query} in ${area}`,
      includedType: VERTICALS[vertical].includedType,
      strictTypeFiltering: true,
      regionCode: "au",
      languageCode: "en-AU",
      pageSize: 20,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const place of data.places ?? []) if (typeof place?.id === "string") ids.push(place.id);
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
  } while (pageToken && ids.length < max);
  return [...new Set(ids)].slice(0, max);
}

/** One Enterprise-tier Place Details call. */
export async function placeDetails(placeId: string, key: string, request: Fetch = fetch): Promise<PlaceDetails> {
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new Error("Not a place ID.");
  const p = await call(request, `https://places.googleapis.com/v1/places/${placeId}`, key, DETAIL_FIELDS);
  return {
    placeId,
    name: String(p.displayName?.text ?? ""),
    address: String(p.formattedAddress ?? ""),
    phone: String(p.nationalPhoneNumber ?? ""),
    website: String(p.websiteUri ?? ""),
    rating: typeof p.rating === "number" ? p.rating : null,
    reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    status: String(p.businessStatus ?? ""),
    mapsUrl: String(p.googleMapsUri ?? ""),
    hours: Array.isArray(p.regularOpeningHours?.weekdayDescriptions)
      ? p.regularOpeningHours.weekdayDescriptions.map(String)
      : [],
  };
}
