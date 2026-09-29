// A quick, polite look at a lead's own website: one GET of the home page (and the contact page
// only if the home page has no email). Plain HTML, no browser, 2 MB and 12 s limits. Emails come
// only from the business's own site, which is the Spam Act "conspicuous publication" route.
import { isIP } from "node:net";
import { isChallengePage } from "./challenge-page";

export type SiteAudit = {
  reachable: boolean;
  finalUrl: string;
  https: boolean;
  mobileViewport: boolean;
  onlineBooking: boolean;
  chatWidget: boolean;
  contactForm: boolean;
  responseMs: number | null;
  copyrightYear: number | null;
  platform: string;
  emails: string[];
  phones: string[];
  /** The site says it doesn't want unsolicited email: never email this lead. */
  noUnsolicited: boolean;
  error?: string;
  /** The HTTP status actually observed, when we got one at all (null for a connection-level
   *  failure — timeout, DNS, TLS handshake). Distinguishes "the server answered with an error"
   *  from "we couldn't reach it at all", which score.ts treats very differently. */
  statusCode: number | null;
  /** True only for a 5xx — real, verified evidence the site itself is broken, never a guess.
   *  A 4xx (very often just a WAF blocking our identified crawler, see docs/LEAD-ENGINE.md) is
   *  deliberately NOT "broken" — that stays ambiguous (audit_pending) until a browser retry. */
  broken: boolean;
  /** A TLS handshake/certificate failure specifically, distinct from a plain HTTP (no TLS at
   *  all) or a timeout/connection-refused. */
  sslError: boolean;
  /** Real-browser check only (browser-audit.ts), at a 390px mobile viewport: true if the
   *  rendered page overflows horizontally. null when not measured (a plain fetch can't tell). */
  overflowAt390: boolean | null;
  /** Legacy-tech tells (table-based layout, Flash, jQuery 1.x, frames, marquee/blink) — feeds the
   *  "clearly abandoned" severe signal alongside a stale copyright year. */
  outdatedTechSignals: string[];
  /** 25 Sep 2026 (Crawl4AI fallback): true when the content actually graded was a bot-protection
   *  challenge/interstitial page (Cloudflare, Sucuri, a generic "enable cookies" gate — see
   *  challenge-page.ts) rather than the real site. Always paired with `reachable: false` — never
   *  scored as a real site problem; score.ts turns this into `audit_pending`, reason
   *  "bot-protected", the same way an unreachable site does but with its own precise reason. */
  challengePage: boolean;
  /** The URL whose content everything above (mobileViewport, https, copyrightYear,
   *  outdatedTechSignals, onlineBooking, responseMs, emails…) was actually measured from. Equal
   *  to `finalUrl` normally; when the homepage itself errored, this is an inner page (About,
   *  Contact, Team…) found via sitemap.xml or a common path — never an error page's content
   *  (live case, 25 Sep 2026: Emu Plains Dentist Care's homepage 502'd, but its "Meet our team"/
   *  "Contact us" pages worked fine; grading the 502 page's missing viewport meta as "not
   *  mobile-friendly" was wrong). Empty when no usable page — homepage or inner — was found. */
  auditedUrl: string;
  /** e.g. "502 Bad Gateway" — set whenever the homepage itself didn't return 2xx, whether or not
   *  a working inner page was found to audit instead. Null when the homepage was fine. */
  homepageError: string | null;
  /** True only once the homepage returned a 5xx on two checks roughly a minute apart — a
   *  confirmed, real finding ("your homepage is down"), not a single blip and not a 4xx that
   *  might just be a WAF blocking our crawler. */
  homepageBroken: boolean;
  /** ISO instants of the first check and (if a 5xx triggered one) the confirming retry — so the
   *  "homepage down" reason always carries concrete dates/times, per docs/LEAD-ENGINE.md's rule
   *  that nothing here is a bare assumption. */
  homepageCheckedAt: string | null;
  homepageRetryCheckedAt: string | null;
};

const USER_AGENT = "Mozilla/5.0 (compatible; MU-Ventures-SiteCheck/1.0; +https://muventures.com.au)";
const MAX_BYTES = 2 * 1024 * 1024;

const BOOKING = [
  /hotdoc/i, /healthengine/i, /cliniko/i, /calendly/i, /centaurportal|d4w/i, /dentally/i, /corebook|coreplus/i,
  /nookal/i, /halaxy/i, /bookings?\.(?:[a-z0-9-]+\.)?(?:com|com\.au)/i, /book (?:an? )?(?:online|appointment|appraisal|consultation)/i,
  /book now/i, /acuityscheduling/i, /simplybook/i, /setmore/i,
];
const CHAT = [/intercom/i, /tawk\.to/i, /livechat/i, /drift\.com/i, /crisp\.chat/i, /tidio/i, /hubspot.*conversations/i, /podium/i];
const NO_UNSOLICITED = /(?:no|do not send|don't send)\s+(?:unsolicited|marketing|commercial|spam)|unsolicited (?:emails?|marketing) (?:is|are) not/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JUNK_EMAIL = /\.(?:png|jpe?g|gif|webp|svg)$|@(?:sentry|wixpress|example|domain|email)\.|^(?:name|your|user|email)@/i;
const AU_PHONE = /(?:\+61\s?|\(?0)[2378]\)?[\s-]?\d{4}[\s-]?\d{4}|(?:\+61\s?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}|1[38]00[\s-]?\d{3}[\s-]?\d{3}/g;

/** Legacy-tech tells for the "clearly abandoned" severe signal (only counts combined with a
 *  stale copyright year — see score.ts): a nested table layout (the pre-CSS way to lay out a
 *  page), Flash, jQuery 1.x, HTML frames, or a <marquee>/<blink> tag. Each is a strong, cheap,
 *  hard-to-fake tell that nobody has touched the site's actual build in a very long time. */
const OUTDATED_TECH: { pattern: RegExp; label: string }[] = [
  { pattern: /<table[^>]*>[\s\S]{0,2000}?<table[^>]*>/i, label: "nested table layout" },
  { pattern: /\.swf\b|shockwave-flash|<embed[^>]+flash/i, label: "Flash" },
  { pattern: /jquery[/.-]1\.\d/i, label: "jQuery 1.x" },
  { pattern: /<frameset[\s>]|<frame\s/i, label: "HTML frames" },
  { pattern: /<marquee[\s>]|<blink[\s>]/i, label: "marquee/blink tag" },
];

/** Common content-page paths to try when the homepage itself won't load and there's no sitemap
 *  (or the sitemap didn't help) — the pages most small-business sites actually have. */
export const COMMON_INNER_PATHS = ["/about", "/about-us", "/contact", "/contact-us", "/team", "/our-team", "/services"];

/** HTTP status text for the handful of codes this audit actually talks about — enough for a
 *  precise "502 Bad Gateway" without pulling in a full status-text table. */
const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
export function statusPhrase(status: number): string {
  return `${status} ${STATUS_TEXT[status] ?? "Error"}`;
}

/** Public web addresses only: no localhost, private ranges or credentials. */
export function publicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(?:localhost|.*\.local|.*\.internal|.*\.ts\.net)$/i.test(host)) return null;
  if (isIP(host)) {
    if (/^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)) return null;
    if (/^(?:::1|f[cd]|fe80)/i.test(host)) return null;
  }
  return url;
}

async function getPage(url: URL, request: typeof fetch) {
  const started = performance.now();
  const response = await request(url.href, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });
  const reader = response.body?.getReader();
  let html = "";
  if (reader) {
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  }
  return { html, ms: Math.round(performance.now() - started), finalUrl: response.url || url.href, ok: response.ok, status: response.status };
}

/** Same-host URLs from /sitemap.xml, content pages (about/contact/team/services) ranked first —
 *  a much better hit rate than guessing paths blind. Never throws; an absent or unparsable
 *  sitemap just yields no candidates and the caller falls through to COMMON_INNER_PATHS. */
async function sitemapInnerUrls(base: URL, request: typeof fetch): Promise<string[]> {
  try {
    const response = await request(new URL("/sitemap.xml", base).href, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    const sameHost = locs.filter((l) => {
      try {
        return new URL(l).hostname === base.hostname;
      } catch {
        return false;
      }
    });
    const contentPage = /about|contact|team|service/i;
    return [...sameHost.filter((l) => contentPage.test(l)), ...sameHost.filter((l) => !contentPage.test(l))];
  } catch {
    return [];
  }
}

/** Finds a real, working content page when the homepage itself won't load: /sitemap.xml first
 *  (content pages prioritised), then a handful of common paths. Returns the first page that
 *  actually returns 2xx with a non-trivial body — never an error page, and never more than a
 *  handful of extra requests. Null if nothing worked, so the caller reports "couldn't find a
 *  working page" rather than grading whatever error page came back. */
async function findInnerPage(base: URL, request: typeof fetch): Promise<{ html: string; finalUrl: string } | null> {
  const sitemapUrls = await sitemapInnerUrls(base, request);
  const candidates = [...sitemapUrls, ...COMMON_INNER_PATHS.map((p) => new URL(p, base).href)];
  const tried = new Set<string>();
  for (const href of candidates.slice(0, 8)) {
    if (tried.has(href)) continue;
    tried.add(href);
    try {
      const url = publicUrl(href);
      if (!url || url.hostname !== base.hostname) continue;
      const page = await getPage(url, request);
      // Never treat a bot-protection interstitial as "a working inner page" — a WAF that blocks
      // the homepage routinely blocks every other path on the same host too, and its challenge
      // page easily clears the 200-char bar on its own.
      if (page.ok && page.html.trim().length > 200 && !isChallengePage(page.html)) return { html: page.html, finalUrl: page.finalUrl };
    } catch {
      continue;
    }
  }
  return null;
}

export function extractEmails(html: string, siteHost: string): string[] {
  const found = new Set<string>();
  const decoded = html.replace(/&#64;|\[at\]|\(at\)/gi, "@").replace(/%40/g, "@");
  for (const match of decoded.match(EMAIL) ?? []) {
    const email = match.toLowerCase().replace(/^mailto:/, "");
    if (JUNK_EMAIL.test(email)) continue;
    found.add(email);
  }
  // Addresses on the practice's own domain first: they are the ones it published for contact.
  const domain = siteHost.replace(/^www\./, "");
  return [...found].sort((a, b) => Number(b.endsWith(domain)) - Number(a.endsWith(domain))).slice(0, 5);
}

export function analyseHtml(html: string) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  const platform =
    /wp-content|wordpress/i.test(html) ? "WordPress"
    : /wix\.com|wixstatic/i.test(html) ? "Wix"
    : /squarespace/i.test(html) ? "Squarespace"
    : /shopify/i.test(html) ? "Shopify"
    : /webflow/i.test(html) ? "Webflow"
    : /_next\/|__NEXT_DATA__/i.test(html) ? "Next.js"
    : "";
  return {
    mobileViewport: /<meta[^>]+name=["']viewport["'][^>]*width=device-width/i.test(html),
    onlineBooking: BOOKING.some((p) => p.test(html)),
    chatWidget: CHAT.some((p) => p.test(html)),
    contactForm: /<form[\s\S]{0,4000}?(?:type=["']email["']|name=["'][^"']*(?:email|message)[^"']*["'])/i.test(html),
    copyrightYear: years.length ? Math.max(...years) : null,
    platform,
    phones: [...new Set((text.match(AU_PHONE) ?? []).map((p) => p.replace(/\s+/g, " ").trim()))].slice(0, 3),
    noUnsolicited: NO_UNSOLICITED.test(text),
    outdatedTechSignals: OUTDATED_TECH.filter((t) => t.pattern.test(html)).map((t) => t.label),
  };
}

/** The shape returned when there's nothing to say yet (no website, unreachable, robots-blocked).
 *  Exported so other lead sources (osm.ts/enrich.ts) can fall back to it without duplicating the shape. */
export const EMPTY_SITE_AUDIT: SiteAudit = {
  reachable: false, finalUrl: "", https: false, mobileViewport: false, onlineBooking: false, chatWidget: false,
  contactForm: false, responseMs: null, copyrightYear: null, platform: "", emails: [], phones: [], noUnsolicited: false,
  statusCode: null, broken: false, sslError: false, overflowAt390: null, outdatedTechSignals: [], challengePage: false,
  auditedUrl: "", homepageError: null, homepageBroken: false, homepageCheckedAt: null, homepageRetryCheckedAt: null,
};

/** Node/undici's fetch reports a TLS handshake/certificate failure as a plain TypeError whose
 *  `cause.code` (or message, on older runtimes) names the OpenSSL error — this is never confused
 *  with a timeout or a plain connection refusal, both of which get their own distinct codes. */
function isSslErrorCause(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } } | undefined)?.cause?.code ?? "";
  const message = String((error as Error)?.message ?? "");
  return /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate|ssl|tls handshake/i.test(message);
}

/** Audits a page's own content — the shared logic for a healthy homepage and for a
 *  found-instead inner page, so both are graded identically. Never called on an error page. */
async function auditPageContent(page: { html: string; finalUrl: string; ms: number; status: number }, url: URL, request: typeof fetch) {
  const final = publicUrl(page.finalUrl) ?? url;
  const facts = analyseHtml(page.html);
  let emails = extractEmails(page.html, final.hostname);
  let noUnsolicited = facts.noUnsolicited;
  if (!emails.length) {
    const link = page.html.match(/href=["']([^"']*contact[^"']*)["']/i)?.[1];
    const contact = link ? publicUrl(new URL(link, final).href) : null;
    if (contact && contact.hostname === final.hostname) {
      const contactPage = await getPage(contact, request).catch(() => null);
      if (contactPage) {
        emails = extractEmails(contactPage.html, final.hostname);
        noUnsolicited ||= analyseHtml(contactPage.html).noUnsolicited;
      }
    }
  }
  return { facts, final, emails, noUnsolicited, responseMs: page.ms, statusCode: page.status };
}

/**
 * When the homepage returns a 5xx, waits ~60s and checks it again before calling it
 * `homepageBroken` — a single blip isn't a verified finding (docs/LEAD-ENGINE.md: nothing here is
 * a bare assumption). Either way, a homepage error never stops the audit: a real content page
 * (About/Contact/Team, via sitemap.xml or a common path) is graded instead — see findInnerPage.
 * Only that page's content is ever graded; the error page's is not. The ~60s cost only applies to
 * the rare lead whose homepage is actually erroring — most calls return as fast as before.
 */
/** Injectable so tests can skip the real ~60s wait — production always gets the real one. */
export async function auditSite(website: string, request: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<SiteAudit> {
  const empty = EMPTY_SITE_AUDIT;
  const url = publicUrl(website);
  if (!url) return { ...empty, error: website ? "not a public web address" : "no website" };
  try {
    const home = await getPage(url, request);
    // Checked before the ok/error branch below: a bot-protection interstitial can arrive on a 200
    // (a WAF that serves its challenge page rather than refusing outright) just as easily as on a
    // 403/503 — either way it's never the real site, so it must never reach the "grade this page's
    // content" path (site-audit.test.ts's own Emu Plains fix set the precedent for this: an
    // error/interstitial page's viewport meta, copyright year etc. are never real findings).
    if (isChallengePage(home.html)) {
      return { ...empty, error: "bot-protected", challengePage: true, statusCode: home.status, homepageCheckedAt: new Date().toISOString() };
    }
    if (home.ok) {
      const { facts, final, emails, noUnsolicited, responseMs, statusCode } = await auditPageContent(home, url, request);
      return {
        ...facts, reachable: true, finalUrl: final.href, auditedUrl: final.href, https: final.protocol === "https:",
        responseMs, emails, noUnsolicited, statusCode, broken: false, sslError: false, overflowAt390: null, challengePage: false,
        homepageError: null, homepageBroken: false, homepageCheckedAt: null, homepageRetryCheckedAt: null,
      };
    }

    // Homepage errored. Record it precisely, confirm a 5xx with a second check ~60s later, then
    // look for a real content page instead of grading the error page.
    const homepageCheckedAt = new Date().toISOString();
    let homepageBroken = false;
    let homepageRetryCheckedAt: string | null = null;
    if (home.status >= 500) {
      await sleep(60_000);
      const retry = await getPage(url, request).catch(() => null);
      homepageRetryCheckedAt = new Date().toISOString();
      homepageBroken = !retry || retry.status >= 500;
    }
    const homepageError = statusPhrase(home.status);

    const inner = await findInnerPage(url, request);
    if (inner) {
      const { facts, final, emails, noUnsolicited, responseMs, statusCode } = await auditPageContent(
        { html: inner.html, finalUrl: inner.finalUrl, ms: 0, status: 200 },
        url,
        request,
      );
      return {
        ...facts, reachable: true, finalUrl: final.href, auditedUrl: final.href, https: final.protocol === "https:",
        responseMs, emails, noUnsolicited, statusCode, broken: false, sslError: false, overflowAt390: null, challengePage: false,
        homepageError, homepageBroken, homepageCheckedAt, homepageRetryCheckedAt,
      };
    }

    // No working page found at all (homepage down, no inner page reachable either): never grade
    // an error page's content — this is the "audit pending" / confirmed-"broken" state, nothing else.
    return {
      ...empty,
      error: homepageError,
      statusCode: home.status,
      broken: homepageBroken,
      homepageError, homepageBroken, homepageCheckedAt, homepageRetryCheckedAt,
    };
  } catch (error) {
    return {
      ...empty,
      error: (error as Error).name === "TimeoutError" ? "timed out" : isSslErrorCause(error) ? "SSL error" : "unreachable",
      sslError: isSslErrorCause(error),
    };
  }
}
