// Website discovery for a lead OpenStreetMap (or Google) didn't tag with a `website`. The engine
// used to treat "no website tag" as "no website" — most of the time that's just OSM's thin
// coverage, not the truth (St Clair Dental, Mount Druitt, has a real site; OSM just never got the
// tag). This module actually looks before the scorer assumes, in the order docs/LEAD-ENGINE.md
// specifies:
//   (a) Hermes/Codex web search on the warm ChatGPT-subscription gateway (127.0.0.1:8642) — asked
//       for JSON only (url + confidence), never prose;
//   (b) a polite fetch of DuckDuckGo's HTML results, robots.txt honoured, rate-limited;
//   (c) a domain guess (name.com.au / name.com), accepted only if the fetched page actually
//       mentions the business name and suburb.
// Every result records its source and confidence so "no website" is never a bare assumption —
// only ever "no website found (checked <date>)" once all three have come back empty.
import { HERMES_API, hermesApiKey, hermesApiUp } from "../hermes-api";
import { ENRICH_USER_AGENT, robotsDisallowed } from "./enrich";
import type { Vertical } from "./places";
import { publicUrl } from "./site-audit";

export type DiscoverySource = "hermes" | "duckduckgo" | "searxng" | "guess" | "phone_finder";

export type DiscoveredWebsite = {
  url: string;
  source: DiscoverySource;
  /** 0..1. Hermes/DuckDuckGo results are trusted at whatever they report (capped to 1); a domain
   *  guess that merely resolves and mentions the business is capped lower (0.4) — it's a guess,
   *  not a search result. */
  confidence: number;
  /** ISO instant this discovery attempt ran, so a "no website found" reason always carries a
   *  concrete date rather than reading as a permanent fact. */
  checkedAt: string;
};

export type DiscoveryInput = {
  name: string;
  /** Suburb only (not the full "<suburb> NSW" area string, and never the broad region/hunt-area
   *  label like "Greater Sydney" — see localityFromAddress) — used in both the search query and
   *  the page-content verification. Empty when the address didn't yield one; verification then
   *  falls back to postcode/phone/street corroboration instead of skipping the check. */
  suburb: string;
  /** 25 Sep 2026 bugfix companion to `suburb` — parsed alongside it by localityFromAddress. Used
   *  as a secondary page-content signal when the suburb name itself doesn't appear (e.g. a page
   *  that gives its address as "Sydney NSW 2117" without naming the suburb). */
  postcode?: string;
  /** Used to require the verified page actually reads as a dental/legal/real-estate business —
   *  see VERTICAL_KEYWORDS. Without this, a business whose name happens to contain a big brand's
   *  name (live case, 24 Sep 2026: "ANZ Real Estate Consultants" vs an actual ANZ Bank branch
   *  page in the same suburb) can pass a plain name+suburb check while being someone else entirely. */
  vertical: Vertical;
  phone?: string;
  address?: string;
};

/** The actual suburb (and postcode, if present) from a lead's own street address — never the
 *  broad hunt-area/region label ("Greater Sydney", "Central Coast" etc.), which a real business
 *  page would never mention and which silently failed almost every suburb check in
 *  `pageMatchesBusiness` (25 Sep 2026 bug: rescan.ts/reaudit.ts were passing `lead.area` here
 *  instead of a parsed suburb — see the fix note there). Handles both
 *  "<street>, <suburb> NSW <postcode>" and "<street>, <postcode>" (no suburb name, OSM
 *  sometimes only tags a postcode). Returns "" for a field it can't find rather than guessing
 *  wrong — pageMatchesBusiness treats a missing suburb as "corroborate with postcode/phone/street
 *  instead", never as "skip the check entirely". */
export function localityFromAddress(address: string): { suburb: string; postcode: string } {
  const trimmed = (address ?? "").trim();
  if (!trimmed) return { suburb: "", postcode: "" };
  const withState = trimmed.match(/([A-Za-z][A-Za-z '.-]*?)\s+(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b\s*(\d{4})?/i);
  if (withState) return { suburb: withState[1].trim(), postcode: withState[2] ?? "" };
  if (!trimmed.includes(",")) return { suburb: "", postcode: "" }; // just a street (or too little to tell) — no state token to anchor on
  const seg = trimmed.split(",").pop()?.trim() ?? "";
  const pc = seg.match(/(\d{4})\s*$/);
  const suburb = seg.replace(/\d{4}\s*$/, "").trim();
  if (suburb && /[A-Za-z]/.test(suburb)) return { suburb, postcode: pc?.[1] ?? "" };
  return { suburb: "", postcode: pc?.[1] ?? "" }; // last segment was a bare postcode, not a suburb name
}

/** The street (minus a leading unit/street number) from the first comma-segment of an address —
 *  a fallback corroboration signal for pageMatchesBusiness when no suburb/postcode is known. */
function streetFromAddress(address: string): string {
  const first = (address ?? "").split(",")[0]?.trim() ?? "";
  const stripped = first.replace(/^[\d/-]+\s*/, "").trim();
  return stripped.length >= 3 ? stripped : "";
}

/** A handful of words that plausibly appear on a real page for this vertical — not exhaustive,
 *  just enough to tell "a dentist's site" from "an unrelated page that happens to share a word
 *  with the business's name and is based in the same suburb". */
const VERTICAL_KEYWORDS: Record<Vertical, RegExp> = {
  dental: /dental|dentist|orthodont|periodont|denture|oral health|smile|teeth/i,
  legal: /lawyer|solicitor|legal|law firm|attorney|litigation|conveyanc|migration agent/i,
  "real-estate": /real estate|realty|property|appraisal|listing|rental|for sale|estate agent/i,
};

/** A result is trusted enough to treat the business as "has a website" below this, it's kept on
 *  record but not acted on — the next method in the chain still gets a try. */
const CONFIDENCE_THRESHOLD = 0.5;

function now(): string {
  return new Date().toISOString();
}

// --- (a) Hermes / Codex web search, warm gateway ------------------------------------------------

const HERMES_SEARCH_TIMEOUT_MS = 45_000;

function extractJson(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Asks the warm Hermes gateway (Codex/ChatGPT subscription, `scripts/hermes-api.ts`) to search
 *  the web and reply with JSON only: `{"url": "...", "confidence": 0..1}` or
 *  `{"url": null, "confidence": 0}`. Returns null (never throws) if Hermes isn't configured,
 *  isn't warm, refuses, or replies with something that isn't that shape — the caller falls
 *  through to DuckDuckGo. */
export async function hermesWebsiteSearch(input: DiscoveryInput, request: typeof fetch = fetch): Promise<DiscoveredWebsite | null> {
  const key = hermesApiKey();
  if (!key) return null;
  if (!(await hermesApiUp(request))) return null;
  const prompt = [
    `Search the web for the official website of this Australian small business. Reply with JSON`,
    `only, no prose, no markdown fences: {"url": "https://...", "confidence": 0.0-1.0} if you`,
    `find their real official site, or {"url": null, "confidence": 0} if you can't find one with`,
    `reasonable confidence. Do not return a directory listing (Google Maps, Facebook, Yellow`,
    `Pages, True Local) as the url — only the business's own domain. Be careful of name`,
    `collisions with unrelated, larger organisations (e.g. a small business whose name happens to`,
    `contain a bank or big brand's name) — the site must actually be a ${input.vertical === "real-estate" ? "real estate agency" : input.vertical} business, not that other organisation.`,
    ``,
    `Business: ${input.name}`,
    `Suburb: ${input.suburb}`,
    input.phone ? `Phone (for matching, don't include in output): ${input.phone}` : "",
  ].filter(Boolean).join("\n");
  try {
    const response = await request(`${HERMES_API}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "hermes-agent", messages: [{ role: "user", content: prompt }], stream: false }),
      signal: AbortSignal.timeout(HERMES_SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as any;
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    const parsed = extractJson(text);
    if (parsed) searchAnswers++;
    if (!parsed || typeof parsed.url !== "string") return null;
    const url = publicUrl(parsed.url)?.href;
    if (!url) return null;
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    return { url, source: "hermes", confidence, checkedAt: now() };
  } catch {
    return null;
  }
}

/** 25 Sep 2026: how many times a web search backend actually answered (a real results page or a
 *  genuine zero-result answer). discoverWebsiteDetailed compares this before/after its cascade: if
 *  no backend answered at all (SearXNG down, DuckDuckGo serving its bot CAPTCHA, Hermes down), an
 *  empty cascade is "couldn't search", never a confirmed "no website" — the bug that told 17 of
 *  the top 20 dental leads they had no site when every one checked by hand did. */
let searchAnswers = 0;
export function searchAnswerCount(): number {
  return searchAnswers;
}

/** DuckDuckGo's anomaly/CAPTCHA page ("bots use DuckDuckGo too") has no result links, so parsing
 *  it as results reads as "nothing found". Only a page with result markup or DuckDuckGo's own
 *  no-results notice counts as an answer. */
export function duckDuckGoAnswered(html: string): boolean {
  if (/bots use DuckDuckGo too|anomaly-modal|challenge-form/i.test(html)) return false;
  return /class="result__a"|class="no-results"|No results found/i.test(html);
}

// --- (b) DuckDuckGo HTML results, politely -------------------------------------------------------

const DUCKDUCKGO_USER_AGENT =
  "Mozilla/5.0 (compatible; MU-Ventures-LeadEngine/1.0; +https://muventures.com.au; contact: muventuresau@muventures.com.au)";
const DUCKDUCKGO_URL = new URL("https://html.duckduckgo.com/html/");

/** DuckDuckGo's own scraping guidance for html.duckduckgo.com asks for no more than roughly one
 *  request every couple of seconds from a single client — same courtesy as Nominatim's 1 req/s in
 *  osm.ts, kept a little more conservative since this hits a results page, not an API. */
let lastDuckDuckGoCallAt = 0;
async function respectDuckDuckGoRate(): Promise<void> {
  const wait = 2_000 - (Date.now() - lastDuckDuckGoCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastDuckDuckGoCallAt = Date.now();
}

/** Skip directory/social/aggregator results — never treat a Google Maps, Facebook, Yellow Pages,
 *  True Local, Yelp, LinkedIn, Instagram or any of the many AU/global "business listing" sites
 *  (findglocal, cybo, australia247, n49, brownbook, opendi, …) as "their website". A directory
 *  page *about* a business routinely mentions its name and suburb too, so this list — not
 *  content matching — is what actually keeps a listing from being mistaken for the real site. */
// 25-26 Sep 2026: healthengine/healthdirect/dentist.com.au/localdentists.au/wheree all confirmed
// live as returning a per-business listing page that reads like the practice's own site (name,
// suburb and vertical words all present) — only the host tells them apart from the real thing.
export const NOT_A_WEBSITE =
  /(?:^|\.)(?:google|facebook|instagram|linkedin|yellowpages|truelocal|yelp|whitepages|hotfrog|startlocal|oneflare|localsearch|word-of-mouth|foursquare|tiktok|twitter|x|findglocal|cybo|australia247|n49|brownbook|opendi|wandersearch|tupalo|kompass|europages|manta|superpages|bizcommunity|spyfu|yellowbot|infobel|nicelocal|cylex[a-z.]*|dnb|zoominfo|craft\.co|crunchbase|glassdoor|indeed|seek|angi|houzz|dentistrynearme|healthengine|healthdirect|dentist|localdentists|wheree)\.[a-z.]+$/i;

/** DuckDuckGo's HTML results wrap the real target in a `/l/?uddg=<encoded>` redirect link. */
export function extractDuckDuckGoResults(html: string): string[] {
  const out: string[] = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/gi;
  for (const match of html.matchAll(linkPattern)) {
    let href = match[1].replace(/&amp;/g, "&");
    const uddg = href.match(/[?&]uddg=([^&]+)/)?.[1];
    if (uddg) href = decodeURIComponent(uddg);
    if (!/^https?:\/\//i.test(href)) continue;
    try {
      const url = new URL(href);
      if (NOT_A_WEBSITE.test(url.hostname)) continue;
      out.push(url.href);
    } catch {
      continue;
    }
  }
  return out;
}

/** True once the URL's own hostname contains a significant word from the business name (e.g.
 *  "mannahlawyers.com.au" for "Mannah Lawyers"). A directory page routinely *mentions* a
 *  business's name and suburb in its text too, so content alone can't tell a listing from the
 *  real site — the domain actually being theirs is the signal that does. */
export function hostnameMatchesBusiness(href: string, name: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  const significant = slugWords(name).filter((w) => !GENERIC_WORDS.has(w) && w.length >= 3);
  const words = significant.length ? significant : slugWords(name).filter((w) => w.length >= 3);
  return words.some((w) => hostname.includes(w));
}

export async function duckduckgoWebsiteSearch(input: DiscoveryInput, request: typeof fetch = fetch): Promise<DiscoveredWebsite | null> {
  const query = `${input.name} ${input.suburb} NSW official website`;
  const url = new URL(DUCKDUCKGO_URL.href);
  url.searchParams.set("q", query);
  if (await robotsDisallowed(url, url.pathname, request)) return null;
  await respectDuckDuckGoRate();
  try {
    const response = await request(url.href, { headers: { "User-Agent": DUCKDUCKGO_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const html = await response.text();
    if (!duckDuckGoAnswered(html)) return null;
    searchAnswers++;
    // The first result whose own domain plausibly belongs to the business — not just the first
    // result full stop, which is how a business-listing directory (not blocked by name/TLD, but
    // still not their site) used to get accepted as "their website".
    const match = extractDuckDuckGoResults(html).find((href) => hostnameMatchesBusiness(href, input.name));
    if (!match) return null;
    // A top organic result for "<business> <suburb> official website", on a domain that's
    // plausibly theirs, is a decent signal but not a certainty (DuckDuckGo doesn't hand back a
    // relevance score) — kept just above threshold so it's accepted on its own, but a Hermes
    // result with real confidence still wins first.
    return { url: match, source: "duckduckgo", confidence: 0.6, checkedAt: now() };
  } catch {
    return null;
  }
}

// --- SearXNG (self-hosted meta-search, WSL) — the "finding sites" step ahead of Hermes ----------
// 25 Sep 2026: SearXNG (github.com/searxng/searxng) running loopback-only inside the existing
// kali-linux WSL distro (scripts/windows/searxng.ps1/.vbs — never installs/resets the distro
// itself), aggregating DuckDuckGo/Brave/Google CSE in one query. Cheaper and more reliable than
// scraping DuckDuckGo's HTML directly (no redirect-link parsing, a real JSON API, several engines
// at once) — DuckDuckGo above stays as a fallback if SearXNG isn't running (e.g. before its first
// `searxng.ps1` run, or between reboots).
export const SEARXNG_URL = "http://127.0.0.1:18888";

let searxngWarned = false;

export async function searxngWebsiteSearch(input: DiscoveryInput, request: typeof fetch = fetch): Promise<DiscoveredWebsite | null> {
  const query = `${input.name} ${input.suburb} NSW official website`;
  const url = new URL("/search", SEARXNG_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  try {
    const response = await request(url.href, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { results?: { url?: string }[] } | null;
    if (!data || !Array.isArray(data.results)) return null;
    searchAnswers++;
    const urls = (data?.results ?? []).map((r) => r.url).filter((u): u is string => !!u);
    const match = urls
      .filter((href) => {
        try {
          return !NOT_A_WEBSITE.test(new URL(href).hostname);
        } catch {
          return false;
        }
      })
      .find((href) => hostnameMatchesBusiness(href, input.name));
    if (!match) return null;
    // Higher than the raw DuckDuckGo scrape's 0.6 — SearXNG already merged several engines'
    // rankings, so a hostname-matching top result here is a stronger signal.
    return { url: match, source: "searxng", confidence: 0.65, checkedAt: now() };
  } catch {
    // Not running (e.g. before scripts/windows/searxng.ps1's first run, or between reboots) is
    // an expected, silent fallback to DuckDuckGo — logged once per process, not per lead, so a
    // long hunt run doesn't spam its own log with the same fact hundreds of times.
    if (!searxngWarned) {
      searxngWarned = true;
      console.error(`SearXNG unreachable at ${SEARXNG_URL} — falling back to DuckDuckGo for website discovery this run. Start it: scripts\\windows\\searxng.ps1`);
    }
    return null;
  }
}

// --- (c) domain guess, verified against the page's own content -----------------------------------

const GENERIC_WORDS = new Set([
  "dental", "dentist", "dentistry", "clinic", "care", "centre", "center", "surgery", "family", "practice",
  "lawyers", "lawyer", "legal", "law", "solicitors", "associates", "chambers",
  "real", "estate", "realty", "realtors", "agents", "agency", "property", "properties",
  "pty", "ltd", "the", "and", "&", "co", "group", "services",
]);

/** 25 Sep 2026: a business's real domain very often swaps its OSM-tagged industry word for a
 *  different, equally common synonym — "Haberfield Dental Practice" is haberfielddentists.com.au,
 *  not -dental- or -practice- (recall miss confirmed live: the guess/search cascade never tried
 *  "dentists"). Tried in candidateSlugs alongside the name's own wording, combined with the name's
 *  core (every GENERIC_WORDS word stripped, not just the industry word actually present). */
const VERTICAL_SYNONYMS: Record<Vertical, string[]> = {
  dental: ["dentist", "dentists", "dental", "dentalcare"],
  legal: ["lawyers", "lawyer", "law", "solicitors"],
  "real-estate": ["realestate", "realty", "property", "re"],
};

function slugWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A handful of plausible domain slugs, most-specific first: the full name, then the name minus
 *  generic industry words (so "St Clair Dental" also tries "stclair" alongside "stclairdental"). */
/** More real small-business domains keep one industry word and drop only the extra descriptor
 *  than drop every generic word at once — "Marayong Dental Clinic" is actually
 *  marayongdental.com.au, not marayong.com.au or marayongdentalclinic.com.au. So besides the full
 *  name and the fully-generic-stripped name, this also tries stripping *trailing* generic words
 *  one at a time ("marayongdentalclinic" -> "marayongdental" -> "marayong"), which catches that
 *  middle ground without a combinatorial blow-up of every word subset. */
export function candidateSlugs(name: string, vertical?: Vertical): string[] {
  const words = slugWords(name);
  const slugs: string[] = [];
  const full = words.join("");
  if (full.length >= 3) slugs.push(full);
  let trailing = [...words];
  while (trailing.length > 1 && GENERIC_WORDS.has(trailing[trailing.length - 1])) {
    trailing = trailing.slice(0, -1);
    const slug = trailing.join("");
    if (slug.length >= 3) slugs.push(slug);
  }
  const significant = words.filter((w) => !GENERIC_WORDS.has(w)).join("");
  if (significant.length >= 3) slugs.push(significant);
  // 25 Sep 2026 recall fix: also try the name's core (every generic/industry word stripped)
  // combined with each common synonym for this vertical — see VERTICAL_SYNONYMS.
  if (vertical && significant.length >= 2) {
    for (const synonym of VERTICAL_SYNONYMS[vertical]) {
      const withSynonym = significant + synonym;
      if (withSynonym.length >= 3) slugs.push(withSynonym);
    }
  }
  return [...new Set(slugs)];
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

/** True if the fetched page's own text plausibly is this business: mentions a significant word
 *  from its name, the suburb it's supposed to be in, AND something that reads as this vertical.
 *  Cheap but real — the "Google Business name match" the brief asks for, done against the page
 *  itself rather than another API. The vertical check exists because name+suburb alone isn't
 *  enough when the business's name contains a common word or a big brand's name that shows up on
 *  an unrelated page in the same suburb (live case: "ANZ Real Estate Consultants" vs an actual
 *  ANZ Bank branch page, both mentioning "ANZ" and "Blacktown").
 *
 *  25 Sep 2026: when `suburb` is empty (the caller genuinely has no suburb name — see
 *  localityFromAddress), this used to just skip the location check entirely, i.e. accept on name
 *  match alone. That's too weak a bar on its own, so it now corroborates with the postcode, the
 *  phone number, or the street instead — whichever of those the caller actually has — and only
 *  falls back to name+vertical alone when none of postcode/phone/street/suburb is known at all.
 *
 *  25 Sep 2026, second bugfix: this used to filter GENERIC_WORDS out of the name before checking
 *  it, then accept on ANY one surviving word. For a name that's mostly generic industry wording
 *  ("Best Real Estate"), that left a single, weak, non-discriminating word ("best") as the whole
 *  check — live case: bestweb.com (a domain-investment portfolio site, nothing to do with real
 *  estate) matched purely on "best". Name-checking now uses every real word in the name (no
 *  GENERIC_WORDS filtering at all — that set stays for domain-slug generation only, where dropping
 *  an industry word is exactly the point) and requires a *majority* of them to actually appear on
 *  the page, not just one. */
export function pageMatchesBusiness(
  html: string,
  name: string,
  suburb: string,
  vertical?: Vertical,
  extra: { postcode?: string; phone?: string; address?: string } = {},
): boolean {
  const rawText = html.replace(/<[^>]+>/g, " ");
  const text = normalise(rawText);
  const words = slugWords(name).filter((w) => w.length >= 3);
  const nameWords = words.length ? words : slugWords(name);
  const nameMatches = nameWords.filter((w) => text.includes(w)).length;
  const nameHit = nameWords.length === 0 || nameMatches >= Math.ceil(nameWords.length / 2);
  const verticalHit = !vertical || VERTICAL_KEYWORDS[vertical].test(text);
  if (!nameHit || !verticalHit) return false;

  // 26 Sep 2026: an overseas namesake — same suburb NAME, different country — used to pass on the
  // suburb check alone (live case: beverlyhillsdentalclinic.com for "Beverly Hills Dental",
  // Sydney NSW 2209, whose page gives its address as Beverly Hills, California; "beverly hills"
  // is right there in the text either way). When we also have a postcode on file, it has to show
  // up too — a same-named overseas suburb essentially never quotes an unrelated AU postcode.
  const knownSuburb = suburb.trim();
  if (knownSuburb) {
    if (!text.includes(normalise(knownSuburb))) return false;
    const knownPostcode = (extra.postcode ?? "").trim();
    return !knownPostcode || text.includes(knownPostcode);
  }

  const postcode = (extra.postcode ?? "").trim();
  const phoneDigits = (extra.phone ?? "").replace(/\D/g, "");
  const street = streetFromAddress(extra.address ?? "");
  const checks: boolean[] = [];
  if (postcode) checks.push(text.includes(postcode));
  if (phoneDigits.length >= 8) checks.push(rawText.replace(/\D/g, "").includes(phoneDigits.slice(-8)));
  if (street) checks.push(text.includes(normalise(street)));

  // Nothing at all to corroborate with (no suburb, postcode, phone, or usable address) — name and
  // vertical are the only signal that exists; matches the previous behaviour for a lead with
  // truly no other data on file, rather than rejecting for lack of information we don't have.
  if (checks.length === 0) return true;
  return checks.some(Boolean);
}

// --- aggregator / directory rejection -----------------------------------------------------------
// 25 Sep 2026: a search or phone-finder hit can land on a third-party directory or franchise
// micro-site page that genuinely does mention the business (so pageMatchesBusiness alone would
// accept it) without being the business's own site — live cases: legallink.info (an AI legal
// directory) for "All Ashfield Legal", australianplanet.com (a real-estate listings aggregator)
// for "Ian Dinnerville Real Estate", and wheree.com (a templated franchise micro-site host) for
// both "No Gaps Dental" and "Laing + Simmons Parramatta" — the same host serving unrelated
// businesses across different verticals is the tell. Checked before any fetch, so a known
// aggregator never even gets treated as "blocked, therefore inconclusive".
const AGGREGATOR_HOSTS = [
  "wheree.com", "australianplanet.com", "legallink.info",
  "yellowpages.com.au", "whitepages.com.au", "truelocal.com.au", "hotfrog.com.au",
  "localsearch.com.au", "oneflare.com", "yelp.com", "yelp.com.au",
  "facebook.com", "instagram.com", "linkedin.com", "wordpress.com", "wixsite.com", "business.site",
  // 25-26 Sep 2026: confirmed live returning a genuine-looking per-business page (name, suburb and
  // vertical words all present) that isn't the practice's own site — see NOT_A_WEBSITE above.
  "healthengine.com.au", "healthdirect.com.au", "dentist.com.au", "localdentists.au", "findglocal.com",
];

function hostMatchesAggregator(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return AGGREGATOR_HOSTS.some((root) => host === root || host.endsWith(`.${root}`));
}

/** 25 Sep 2026, second bugfix: the old "name word appears in the host" bypass let a coincidental
 *  word overlap clear a real directory — finder.orthodonticsaustralia.org.au (an industry
 *  association's per-practice finder page, not "Orthodontics Sydney Wide"'s own site) matched
 *  because "orthodontics" happens to appear in both the business's descriptive name and the
 *  association's own domain. Two independent, host/path-shape-only signals now catch this
 *  regardless of any name overlap: an "association" word in the host, or a directory-shaped path
 *  segment — neither depends on the business's name at all, so a coincidental word can't clear
 *  either one the way it cleared the old bypass. */
const ASSOCIATION_HOST_WORDS = ["australia", "association", "institute", "society", "federation", "foundation", "college", "board"];

function looksLikeAssociationDomain(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return ASSOCIATION_HOST_WORDS.some((w) => host.includes(w));
}

/** A directory/finder path shape is a directory regardless of which host it's on or whether the
 *  business's name happens to overlap with that host — e.g. legallink.info's
 *  "/lawfirms/all-ashfield-legal", a "finder."-prefixed host, or a generic "/find-a-.../" path. */
function hasDirectoryShapedPath(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return (
    /^find(er)?[.-]/.test(host) ||
    /\/(finder|find-a-[a-z0-9-]*|lawfirms|agents?|listings?|profile|business|directory)(\/|$)/.test(path) ||
    /-[0-9a-f]{6,}$/i.test(path)
  );
}

/** A generic fallback for an aggregator not yet on the explicit list/patterns above: the URL's
 *  path spells out the business's own name/slug (the shape of a directory's per-business detail
 *  page) while the HOST itself doesn't contain any part of the business's name — a business's own
 *  domain almost always contains its own name; a directory host almost never does. */
function looksLikeDirectoryListing(url: URL, name: string): boolean {
  const nameWords = slugWords(name).filter((w) => !GENERIC_WORDS.has(w) && w.length >= 3);
  if (nameWords.length === 0) return false;
  const hostWords = slugWords(url.hostname.replace(/^www\./, ""));
  if (nameWords.some((w) => hostWords.some((h) => h.includes(w)))) return false; // the business's own domain naturally contains its own name
  const path = url.pathname.toLowerCase();
  const nameOnPath = nameWords.some((w) => path.includes(w));
  const directoryShaped = /\/(lawfirms|agents?|listings?|profile|business|directory)\//.test(path) || /-[0-9a-f]{6,}$/i.test(path);
  return nameOnPath && directoryShaped;
}

/** True if `rawUrl` is a known aggregator/franchise-microsite host, an industry-association
 *  domain, a directory/finder-shaped path, or shaped like one's per-business directory page —
 *  never accepted as "their own site" regardless of content match. The first three checks are
 *  host/path-shape only and never bypassed by a coincidental name-word overlap. */
export function isAggregatorOrDirectory(rawUrl: string, name: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    hostMatchesAggregator(url.hostname) ||
    looksLikeAssociationDomain(url.hostname) ||
    hasDirectoryShapedPath(url) ||
    looksLikeDirectoryListing(url, name)
  );
}

export async function guessWebsite(input: DiscoveryInput, request: typeof fetch = fetch): Promise<DiscoveredWebsite | null> {
  for (const slug of candidateSlugs(input.name, input.vertical)) {
    for (const domain of [`${slug}.com.au`, `${slug}.com`]) {
      const href = `https://${domain}/`;
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        continue;
      }
      try {
        if (await robotsDisallowed(url, "/", request)) continue;
        const response = await request(href, {
          headers: { "User-Agent": ENRICH_USER_AGENT, Accept: "text/html" },
          redirect: "follow",
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) continue;
        const html = await response.text();
        if (pageMatchesBusiness(html, input.name, input.suburb, input.vertical, { postcode: input.postcode, phone: input.phone, address: input.address })) {
          return { url: response.url || href, source: "guess", confidence: 0.4, checkedAt: now() };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// --- orchestration --------------------------------------------------------------------------

type DiscoveryMethod = (input: DiscoveryInput, request: typeof fetch) => Promise<DiscoveredWebsite | null>;

export type DiscoveryDeps = {
  request?: typeof fetch;
  hermesSearch?: DiscoveryMethod;
  duckduckgoSearch?: DiscoveryMethod;
  searxngSearch?: DiscoveryMethod;
  guessSearch?: DiscoveryMethod;
  /** Candidate URLs another step already turned up for this business (phone-finder.ts records
   *  any real-looking site its phone search hits for a no-website lead). Tried first, but only
   *  accepted after the same page-content check every search hit gets — a hint is never trusted
   *  on its own. */
  hints?: string[];
};

/** matched: confirmed this business's own site. rejected: a known aggregator/directory host, or a
 *  page that loaded fine but plainly isn't this business. unverifiable: blocked, erroring, or
 *  unreachable — genuinely can't tell either way. */
export type CandidateVerdict = "matched" | "rejected" | "unverifiable";

/**
 * A search result (Hermes/DuckDuckGo/SearXNG, unlike a domain guess) hasn't actually been checked
 * against the business yet — an LLM search can confidently hand back the wrong site (seen live,
 * 24 Sep 2026: Hermes returned "wealthre.com.au", a completely unrelated real-estate agency's
 * site, at 0.97 confidence for "ANZ Real Estate Consultants"). This fetches the candidate once
 * with the same identifying User-Agent the rest of the engine uses and checks its content:
 *   - a known aggregator/directory host, or shaped like one's per-business page → rejected outright,
 *     never fetched — a franchise micro-site or listings aggregator is never "their own site"
 *     regardless of what it says (live cases, 25 Sep 2026: wheree.com, australianplanet.com,
 *     legallink.info — see isAggregatorOrDirectory);
 *   - loads fine (2xx) but doesn't mention the business/suburb → rejected, it's the wrong site;
 *   - loads fine and matches → matched;
 *   - blocked, erroring, or unreachable → unverifiable. 25 Sep 2026 bugfix: this used to be
 *     treated as "inconclusive, keep it", which silently accepted a hint/guess/search hit as the
 *     business's confirmed website on nothing but a bot-wall's say-so (live cases: wheree.com and
 *     australianplanet.com return Cloudflare challenge pages to a plain fetch — never actually
 *     verified, just waved through because verification itself failed). A candidate that can't be
 *     checked is no longer accepted; the caller surfaces it as "found but unverifiable" instead.
 */
/** A page too thin to judge (JS shell, bot challenge, parked redirect stub). */
export function looksLikeStubOrChallenge(html: string): boolean {
  if (/cf-browser-verification|challenge-platform|sgcaptcha|sucuri_cloudproxy|incapsula|captcha|enable javascript|checking your browser/i.test(html) && html.length < 20_000) return true;
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // Thin AND script-driven (a JS shell or meta-refresh stub): nothing on it can be judged.
  return text.length < 200 && /<script|http-equiv=["']?refresh/i.test(html);
}

async function verifyCandidate(candidate: DiscoveredWebsite, input: DiscoveryInput, request: typeof fetch): Promise<CandidateVerdict> {
  if (isAggregatorOrDirectory(candidate.url, input.name)) return "rejected";
  try {
    const response = await request(candidate.url, {
      headers: { "User-Agent": ENRICH_USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    // 25 Sep 2026: only a real 200 page is evidence. A 202 or a tiny JS/bot-challenge stub (live
    // case: beyond32dental.com.au answers 202 with 535 bytes) has no business text in it, so
    // "didn't match" there meant "couldn't read", and the real site got rejected — then the lead
    // was told it had no website at all.
    if (response.status !== 200) return "unverifiable";
    const html = await response.text();
    if (looksLikeStubOrChallenge(html)) return "unverifiable";
    const matched = pageMatchesBusiness(html, input.name, input.suburb, input.vertical, {
      postcode: input.postcode, phone: input.phone, address: input.address,
    });
    return matched ? "matched" : "rejected";
  } catch {
    return "unverifiable"; // the fetch itself failed — same treatment as blocked
  }
}

/** SearXNG first, falling back to the DuckDuckGo scrape only if SearXNG itself returned nothing
 *  (not running, or genuinely no hit) — one "finding sites" slot in discoverWebsite's cascade,
 *  not two, so Hermes staying "last resort" doesn't shift. */
async function searxngThenDuckDuckGo(input: DiscoveryInput, request: typeof fetch): Promise<DiscoveredWebsite | null> {
  const viaSearxng = await searxngWebsiteSearch(input, request).catch(() => null);
  if (viaSearxng) return viaSearxng;
  return duckduckgoWebsiteSearch(input, request).catch(() => null);
}

export type DiscoveryOutcome =
  | { kind: "found"; site: DiscoveredWebsite }
  /** A candidate turned up (a phone-finder hint, or a search/Hermes hit) but every attempt to
   *  check it against the business's own content was blocked or failed — genuinely unknown, not
   *  "no website". The caller should leave the lead as `audit_pending` ("site found but
   *  unverifiable"), never claim either a confirmed website or a confirmed absence of one.
   *  `url` is "" for a franchise-brand-with-no-address short-circuit (see FRANCHISE_BRANDS) —
   *  there was never a candidate to name, just an inherent inability to tell which office it is.
   *  `reason`, when set, overrides the generic "site found but unverifiable" wording. */
  | { kind: "unverifiable"; url: string; checkedAt: string; reason?: string }
  | { kind: "none" };

// --- franchise/chain disambiguation ---------------------------------------------------------
// 25 Sep 2026: a national franchise brand's name alone never identifies *which* office a lead is
// — live cases: "Century 21" (Shore Real Estate, blank address on file) and "Stone Real Estate"
// (an address with only a postcode, no suburb name) both got attached to some OTHER office's page
// under the old logic, because the brand name plus vertical is easily satisfied by ANY franchisee
// or even the corporate homepage. Unlike a one-off small business, a franchise name is only ever
// safe to confirm against a real suburb NAME on file — a postcode or phone alone isn't enough
// (different offices of the same chain can share a postcode's general area, or list a head-office
// switchboard number). No suburb name known for a listed brand means "can't disambiguate" — this
// short-circuits the whole cascade (never even fetches a candidate) straight to `audit_pending`.
const FRANCHISE_BRANDS = [
  "century 21", "stone", "first national", "belle property", "raine & horne", "raine and horne",
  "lj hooker", "ray white", "mcgrath", "harcourts", "prd", "laing+simmons", "laing simmons",
  "bupa dental", "pacific smiles", "national dental care",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The matched brand string, or null — a whole-word match against the normalised name, so "Stone"
 *  doesn't fire on "Stonebridge Realty" (no word boundary inside a single run of letters). */
function matchesFranchiseBrand(name: string): string | null {
  const normalisedName = normalise(name);
  return FRANCHISE_BRANDS.find((brand) => new RegExp(`\\b${escapeRegExp(normalise(brand))}\\b`, "i").test(normalisedName)) ?? null;
}

function needsFranchiseDisambiguation(name: string, suburb: string): string | null {
  return suburb.trim().length === 0 ? matchesFranchiseBrand(name) : null;
}

/** 25 Sep 2026 owner direction: cheapest and most self-contained first, Hermes (shared ChatGPT
 *  Pro quota) last. Tries (a) any phone-finder hint, (b) a verified domain guess, (c) SearXNG
 *  (falling back to a DuckDuckGo scrape if SearXNG isn't running), (d) Hermes, in that order, and
 *  returns the first result whose confidence clears CONFIDENCE_THRESHOLD. Reports "none" (and the
 *  caller says "no website found (checked today)") only once every method has come back empty or
 *  rejected — never because a directory simply didn't carry a `website` tag — and reports
 *  "unverifiable" instead of "none" when at least one candidate existed but couldn't be checked. */
export async function discoverWebsiteDetailed(input: DiscoveryInput, deps: DiscoveryDeps = {}): Promise<DiscoveryOutcome> {
  const request = deps.request ?? fetch;
  const searchStep: DiscoveryMethod = deps.searxngSearch ?? deps.duckduckgoSearch ?? searxngThenDuckDuckGo;

  const franchiseBrand = needsFranchiseDisambiguation(input.name, input.suburb);
  if (franchiseBrand) {
    return {
      kind: "unverifiable",
      url: "",
      checkedAt: now(),
      reason: `"${franchiseBrand}" is a multi-location franchise brand and no suburb is on file to confirm which office this is`,
    };
  }

  let unverifiable: { url: string; checkedAt: string } | null = null;
  // Only the built-in search backends report whether they answered; injected test doubles don't.
  const usesBuiltInSearch = !deps.searxngSearch && !deps.duckduckgoSearch && !deps.hermesSearch;
  const answersBefore = searchAnswers;

  for (const hint of deps.hints ?? []) {
    const url = publicUrl(hint)?.href;
    if (!url) continue;
    const candidate: DiscoveredWebsite = { url, source: "phone_finder", confidence: 0.6, checkedAt: now() };
    const verdict = await verifyCandidate(candidate, input, request);
    if (verdict === "matched") return { kind: "found", site: candidate };
    if (verdict === "unverifiable") unverifiable ??= { url: candidate.url, checkedAt: candidate.checkedAt };
    // "rejected" (aggregator/directory host, or a page that loaded but plainly isn't them) — try the next hint/method.
  }
  const methods = [deps.guessSearch ?? guessWebsite, searchStep, deps.hermesSearch ?? hermesWebsiteSearch];
  for (const [index, method] of methods.entries()) {
    const result = await method(input, request).catch(() => null);
    if (!result) continue;
    // A domain guess has already been verified against the page's own content inside
    // guessWebsite (that's the whole reason it's trusted below CONFIDENCE_THRESHOLD at all) — a
    // search hit (SearXNG/DuckDuckGo/Hermes) hasn't, so it gets the same check here instead.
    if (result.source === "guess") return { kind: "found", site: result };
    const verdict = await verifyCandidate(result, input, request);
    if (verdict === "unverifiable") {
      unverifiable ??= { url: result.url, checkedAt: result.checkedAt };
      continue;
    }
    if (verdict === "rejected") continue;
    // Hermes is the last resort and, being an LLM search rather than a plain lookup, is accepted
    // on its own reported confidence rather than treated as "not found" just because it's last.
    const isLastMethod = index === methods.length - 1;
    if (result.confidence >= CONFIDENCE_THRESHOLD || isLastMethod) return { kind: "found", site: result };
  }
  if (unverifiable) return { kind: "unverifiable", ...unverifiable };
  if (usesBuiltInSearch && searchAnswers === answersBefore) {
    return {
      kind: "unverifiable", url: "", checkedAt: now(),
      reason: "no web search backend answered (SearXNG down, DuckDuckGo CAPTCHA or Hermes unavailable), so a missing website can't be confirmed",
    };
  }
  return { kind: "none" }; // every method came back empty or rejected — a genuine "no website found"
}

/** Thin, backward-compatible wrapper over discoverWebsiteDetailed for callers (osm.ts, tests) that
 *  only care about "found a confirmed site or not" — an "unverifiable" outcome is reported the
 *  same as "none" here, i.e. never silently claimed as a confirmed website. rescan.ts (the
 *  re-audit path this bug was found from) uses discoverWebsiteDetailed directly instead, since it
 *  needs to tell "no website" and "found but unverifiable" apart. */
export async function discoverWebsite(input: DiscoveryInput, deps: DiscoveryDeps = {}): Promise<DiscoveredWebsite | null> {
  const outcome = await discoverWebsiteDetailed(input, deps);
  return outcome.kind === "found" ? outcome.site : null;
}
