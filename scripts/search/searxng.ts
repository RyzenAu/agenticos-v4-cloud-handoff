/**
 * The one SearXNG client (round 6). Lead discovery, the phone finder and bounded research all search through here, so "search is
 * down" and "search found nothing" can never be confused.
 *
 * Three answers, never two:
 *   results      a results page with hits.
 *   no_results   the search engines answered and have nothing for this query. A real, confirmed "nothing found".
 *   unavailable  nothing answered: SearXNG not running, a timeout, an HTTP error, a body that is not JSON, or SearXNG up with every
 *                requested engine refusing (rate-limit, CAPTCHA, suspended). The caller must say "I could not search", not "there
 *                are no results", and must not record a missing website, phone number or source as confirmed.
 *
 * Nothing here retries on its own: callers choose their pacing (the phone finder spaces queries, research stops after a few). The
 * health check (scripts/ops/dependencies.ts) is where bounded retry and backoff live.
 */

export const SEARXNG_URL = "http://127.0.0.1:18888";

export type SearchHit = { url: string; title: string; content: string };
export type UnavailableKind = "down" | "timeout" | "http" | "bad_json" | "engines_refused";

export type SearchOutcome =
  | { status: "results"; results: SearchHit[]; unresponsive: string[] }
  | { status: "no_results"; unresponsive: string[] }
  | { status: "unavailable"; kind: UnavailableKind; reason: string };

/** Thrown by callers that need an exception (the research search function, the phone finder). `name` survives bundling and instanceof checks. */
export class SearchUnavailable extends Error {
  override readonly name = "SearchUnavailable";
  constructor(
    message: string,
    readonly kind: UnavailableKind = "down",
  ) {
    super(message);
  }
}

export const isSearchUnavailable = (e: unknown): e is SearchUnavailable => e instanceof SearchUnavailable || (e as { name?: string } | null)?.name === "SearchUnavailable";

export type SearxngOptions = {
  base?: string;
  request?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Comma-separated engine names to ask for. When set, "every requested engine refused" is an outage. */
  engines?: string;
  categories?: string;
  language?: string;
  safesearch?: string;
};

type Body = { results?: { url?: unknown; title?: unknown; content?: unknown }[]; unresponsive_engines?: unknown } | null;

/** Pure: classify a decoded SearXNG response. `requestedEngines` is kept for callers and is not needed by the rule. */
export function classifySearxngBody(body: Body, requestedEngines = 0): SearchOutcome {
  if (!body || typeof body !== "object" || !Array.isArray(body.results)) return { status: "unavailable", kind: "bad_json", reason: "SearXNG answered but not with a results page" };
  const unresponsive = (Array.isArray(body.unresponsive_engines) ? body.unresponsive_engines : [])
    .map((e) => (Array.isArray(e) ? `${String(e[0])}${e[1] ? `: ${String(e[1])}` : ""}` : String(e)))
    .slice(0, 12);
  const results: SearchHit[] = [];
  for (const r of body.results) {
    if (typeof r?.url !== "string") continue;
    results.push({ url: r.url, title: typeof r.title === "string" ? r.title : "", content: typeof r.content === "string" ? r.content : "" });
  }
  if (results.length) return { status: "results", results, unresponsive };
  // Zero hits. With nothing returned we can never tell that any engine really answered, so ANY engine that refused (rate limit, CAPTCHA,
  // suspended, timed out) makes this "could not search", whether the instance runs one engine, two or ten, and whether a named engine is
  // disabled (it is simply absent from the list, so the ones that are present decide). Only a clean empty answer with no refusals is "no results".
  if (unresponsive.length >= 1) return { status: "unavailable", kind: "engines_refused", reason: `no engine returned results and ${unresponsive.length} refused (${unresponsive.join("; ")})` };
  return { status: "no_results", unresponsive };
}

export async function searxngQuery(query: string, options: SearxngOptions = {}): Promise<SearchOutcome> {
  const base = (options.base ?? process.env.MU_SEARXNG_URL ?? SEARXNG_URL).replace(/\/$/, "");
  const request = options.request ?? fetch;
  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (options.engines) url.searchParams.set("engines", options.engines);
  if (options.categories) url.searchParams.set("categories", options.categories);
  if (options.language) url.searchParams.set("language", options.language);
  if (options.safesearch) url.searchParams.set("safesearch", options.safesearch);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await request(url.href, { signal, headers: { accept: "application/json" } });
  } catch (e) {
    // A caller's own abort (a stopped job) is not an outage: let it propagate as the abort it is.
    if (options.signal?.aborted) throw e;
    const timedOut = timeout.aborted || (e as { name?: string })?.name === "TimeoutError";
    return { status: "unavailable", kind: timedOut ? "timeout" : "down", reason: timedOut ? "SearXNG did not answer in time" : "SearXNG is not running or not reachable" };
  }
  if (!res.ok) return { status: "unavailable", kind: "http", reason: `SearXNG answered HTTP ${res.status}` };
  const body = (await res.json().catch(() => null)) as Body;
  return classifySearxngBody(body, options.engines ? options.engines.split(",").filter(Boolean).length : 0);
}

/** The plain sentence a person reads when search is down. Never says "no results". */
export function unavailableSentence(reason: string): string {
  return `Web search is unavailable (${reason}), so I could not look. That is not the same as finding nothing.`;
}
