/**
 * Which Business tab is open lives in the URL (`/business?view=…`) and nowhere else, so the tabs,
 * the address bar, Back/Forward and the sidebar always agree (audit F1-21). The page reads the
 * router's validated search; a tab change is a router navigation, never a hand-made replaceState.
 */
export type BusinessView = "overview" | "finance" | "progress" | "audience";
export const BUSINESS_VIEWS: readonly BusinessView[] = ["overview", "finance", "progress", "audience"];

/** The page h1, the tab and the browser title name the open tab; only Overview is "Home". Progress is called Goals everywhere (owner-facing name). */
export const BUSINESS_VIEW_TITLE: Record<BusinessView, string> = { overview: "Home", finance: "Finances", progress: "Goals", audience: "Audience" };

/** `/business` search as the route validates it. Other keys (platform, record, dev…) pass through. */
export type BusinessSearch = {
  /** Absent means Overview. "growth" is the old name for Audience, rewritten on arrival. */
  view?: Exclude<BusinessView, "overview"> | "growth";
  [key: string]: unknown;
};

export function validateBusinessSearch(search: Record<string, unknown>): BusinessSearch {
  const { view, ...rest } = search;
  const known = view === "growth" || (typeof view === "string" && view !== "overview" && (BUSINESS_VIEWS as readonly string[]).includes(view));
  return known ? { ...rest, view: view as BusinessSearch["view"] } : rest;
}

/** The tab a validated search opens. */
export function businessViewOf(search: Pick<BusinessSearch, "view">): BusinessView {
  if (search.view === "growth") return "audience";
  return search.view ?? "overview";
}

/**
 * The search for opening `next`. Overview has no `view`; leaving Audience drops its own
 * `platform` and `record`; opening Audience can name a platform and ask for the record form.
 */
export function businessSearchFor(
  previous: Record<string, unknown>,
  next: BusinessView,
  audience: { platform?: string; record?: boolean } = {},
): BusinessSearch {
  const { view: _view, platform, record, ...rest } = previous;
  if (next === "overview") return rest;
  if (next !== "audience") return { ...rest, view: next };
  const chosen = audience.platform ?? platform;
  return {
    ...rest,
    view: "audience",
    ...(chosen ? { platform: chosen } : {}),
    // A number, so the router writes `record=1` (a string "1" would be JSON-quoted in the URL).
    ...(audience.record ? { record: 1 } : record !== undefined ? { record } : {}),
  };
}
