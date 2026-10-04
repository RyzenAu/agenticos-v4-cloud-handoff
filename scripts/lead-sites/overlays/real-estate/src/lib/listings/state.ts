// PREVIEW TEMPLATE: the business's own listings, read in the browser from <script id="mu-preview-data" type="application/json">
// (the generator writes them into every page). The static pages are built without any property, so the markup the server
// renders and the markup hydration expects are both the empty state; the listings arrive after hydration. Nothing here is
// the template's example stock: a preview with no supplied listings shows an honest empty state, never another agency's homes.
// Plain module (no "use client"): the server-rendered pages read it too and simply see no listings.
import type { Listing } from "@/data/types";

export type ListingsState = { ready: boolean; items: Listing[] };

export const EMPTY: ListingsState = { ready: false, items: [] };
let state: ListingsState = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function load() {
  if (started || typeof document === "undefined") return;
  started = true;
  let items: Listing[] = [];
  try {
    const el = document.getElementById("mu-preview-data");
    const data = el?.textContent ? (JSON.parse(el.textContent) as { listings?: { items?: Listing[] } }) : {};
    items = Array.isArray(data.listings?.items) ? data.listings!.items! : [];
  } catch {
    items = [];
  }
  state = { ready: true, items };
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  // Loaded on the first subscription, which happens after hydration: the first client render still uses the server snapshot.
  queueMicrotask(load);
  return () => {
    listeners.delete(listener);
  };
}

export const snapshot = () => state;

/** The listings as of now (empty until loaded). The query helpers read this; components subscribe with useListings(). */
export function previewListings(): Listing[] {
  return state.items;
}
