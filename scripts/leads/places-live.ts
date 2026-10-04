// Live Google Places details for display and call prep (27 Sep 2026). The CRM keeps only a
// Google lead's place ID (Places terms §5.4); everything a founder sees about it — name, phone,
// address, website, rating, reviews, hours, the Maps link — is fetched here when a lead is shown
// or prepped, held in a per-request in-memory cache, and never written to .operator-data. Every
// hydrated lead carries `placesLive.attribution` so the CLI, Telegram text and the OS drawer show
// Google attribution next to the data (§5.2: Places content without a Google map needs it).
//
// A value the CRM stores with a recorded non-Places source (the practice's own site, a founder's
// manual check, OSM) always wins over the live value — live data only fills blanks.
import type { Database } from "bun:sqlite";
import { countCall, usage, type Lead } from "./crm";
import {
  isGooglePlaceId, mapsUrlForPlaceId, MONTHLY_DETAILS_BUDGET, PLACES_ATTRIBUTION, placeDetails, placesKey, type PlaceDetails,
} from "./places";

export type PlacesLookup = (placeId: string) => Promise<PlaceDetails>;

export type PlacesLive = {
  /** Always "Google Maps": render it wherever these values are shown. */
  attribution: string;
  /** When this request fetched it. Not stored. */
  fetchedAt: string | null;
  /** Which Lead fields were filled from Google for this response only. */
  fields: string[];
  /** Hours as Google lists them (call-prep only; never stored). */
  hours: string[];
  businessStatus: string;
  /** Set when the live lookup couldn't run (no key, budget reached, API error). */
  error?: string;
};

export type LiveLead<T extends Lead = Lead> = T & { placesLive?: PlacesLive };

/** A Google-sourced lead whose display data has to come from a live lookup. */
export function isPlacesLead(lead: Pick<Lead, "source" | "placeId">): boolean {
  return lead.source === "google" && isGooglePlaceId(lead.placeId);
}

/** One per request (an API call, a CLI command). The cache is a plain Map that dies with it. */
export type PlacesSession = {
  details(placeId: string): Promise<PlaceDetails>;
  /** Place Details calls actually made (cache hits don't count). */
  readonly calls: number;
};

export function placesSession(lookup: PlacesLookup | null): PlacesSession {
  const cache = new Map<string, Promise<PlaceDetails>>();
  let calls = 0;
  return {
    details(placeId: string) {
      if (!lookup) return Promise.reject(new Error("Google Places isn't configured on this PC, so live details aren't available."));
      let pending = cache.get(placeId);
      if (!pending) {
        calls++;
        pending = lookup(placeId);
        cache.set(placeId, pending);
        pending.catch(() => cache.delete(placeId)); // don't cache a failure
      }
      return pending;
    },
    get calls() {
      return calls;
    },
  };
}

/** The real lookup: reads the key the same way the rest of the lead engine does (never logged),
 *  counts each call against the monthly Place Details budget and refuses once it's spent.
 *  Returns null when no key is configured. */
export function defaultPlacesLookup(db: Database, opts: { key?: string; request?: typeof fetch; budget?: number } = {}): PlacesLookup | null {
  // `bun test` never reaches Google with the operator's real key: tests inject a fixture lookup.
  if (opts.key === undefined && process.env.NODE_ENV === "test") return null;
  const key = opts.key ?? placesKey();
  if (!key) return null;
  const budget = opts.budget ?? MONTHLY_DETAILS_BUDGET;
  return async (placeId: string) => {
    if ((usage(db).details_enterprise ?? 0) >= budget) throw new Error("This month's Google Places budget is used up, so live details aren't available.");
    countCall(db, "details_enterprise");
    return placeDetails(placeId, key, opts.request ?? fetch);
  };
}

/** Fills a Google lead's blank display fields from a live details response (no network call). */
export function withPlaceDetails<T extends Lead>(lead: T, place: PlaceDetails, fetchedAt: string): LiveLead<T> {
  const fields: string[] = [];
  const fill = <K extends keyof Lead>(key: K, value: Lead[K], empty: (v: Lead[K]) => boolean) => {
    if (empty(lead[key]) && !empty(value)) fields.push(key as string);
    return empty(lead[key]) ? value : lead[key];
  };
  const blank = (v: unknown) => v === "" || v === null || v === undefined;
  const out = {
    ...lead,
    name: fill("name", place.name, blank),
    phone: fill("phone", place.phone, blank),
    address: fill("address", place.address, blank),
    website: fill("website", place.website, blank),
    mapsUrl: fill("mapsUrl", place.mapsUrl || mapsUrlForPlaceId(lead.placeId), blank),
    rating: fill("rating", place.rating, blank),
    reviews: fill("reviews", place.reviews, blank),
  } as LiveLead<T>;
  out.placesLive = { attribution: PLACES_ATTRIBUTION, fetchedAt, fields, hours: place.hours, businessStatus: place.status };
  return out;
}

/** A Google lead with its live details filled in (or an explained failure). Any other lead is
 *  returned unchanged. Never writes to the CRM. */
export async function hydrateLead<T extends Lead>(lead: T, session: PlacesSession, now = () => new Date()): Promise<LiveLead<T>> {
  if (!isPlacesLead(lead)) return lead;
  try {
    const place = await session.details(lead.placeId);
    return withPlaceDetails(lead, place, now().toISOString());
  } catch (error) {
    return {
      ...lead,
      mapsUrl: lead.mapsUrl || mapsUrlForPlaceId(lead.placeId),
      placesLive: {
        attribution: PLACES_ATTRIBUTION, fetchedAt: null, fields: [], hours: [], businessStatus: "",
        error: ((error as Error)?.message || "The live Google lookup failed.").slice(0, 200),
      },
    };
  }
}

export async function hydrateLeads<T extends Lead>(leads: T[], session: PlacesSession): Promise<LiveLead<T>[]> {
  const out: LiveLead<T>[] = [];
  for (const lead of leads) out.push(await hydrateLead(lead, session)); // sequential: bounded spend, cached repeats
  return out;
}

/** One line for text surfaces (CLI, Telegram): the attribution Google requires, plus what's live. */
export function placesAttributionLine(live: PlacesLive | undefined): string {
  if (!live) return "";
  if (live.error) return `Place details: not available (${live.error}) · ${live.attribution}`;
  const hours = live.hours.length ? ` · hours: ${live.hours.join("; ")}` : "";
  return `Place details live from ${live.attribution} (not stored)${hours}`;
}
