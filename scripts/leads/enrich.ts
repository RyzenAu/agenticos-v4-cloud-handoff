// Polite website enrichment for OSM-sourced leads: a business's own site is the cleanest consent
// story for the Spam Act's "conspicuous publication" exemption (see docs/LEAD-ENGINE.md), so this
// only ever reads the site itself — never a third-party enrichment API. Before fetching anything
// it checks robots.txt and honours a Disallow for the paths it wants (home page, contact page);
// site-audit.ts does the actual fetch + parse (home page, then a contact page if no email yet) so
// the same quality signals (HTTPS, mobile, booking, chat, platform, copyright year) feed scoring
// for every source. A personal-looking free-webmail address (firstname.lastname@gmail.com etc) is
// never treated as the business's published contact — it's flagged instead so a founder can look
// at it, never auto-emailed.
import { browserFetchAudit, type BrowserAuditDeps } from "./browser-audit";
import { needsRenderFallback } from "./challenge-page";
import { crawl4aiAudit, type Crawl4aiDeps } from "./crawl4ai";
import { auditSite, EMPTY_SITE_AUDIT, publicUrl, type SiteAudit } from "./site-audit";

export const ENRICH_USER_AGENT =
  "Mozilla/5.0 (compatible; MU-Ventures-LeadEngine/1.0; +https://muventures.com.au; contact: muventuresau@muventures.com.au)";

// firstname.lastname / firstname_lastname (optionally with trailing digits) at a free consumer
// webmail provider. Business addresses like info@, reception@, admin@ never match this shape.
const FREE_WEBMAIL = /@(gmail|hotmail|outlook|live|yahoo|icloud|bigpond|optusnet|aol|msn|protonmail)\.[a-z.]+$/i;
const PERSON_LOOKING_LOCAL = /^[a-z]+[._][a-z]+\d{0,3}$/i;

export function looksPersonal(email: string): boolean {
  const at = email.indexOf("@");
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return FREE_WEBMAIL.test(domain) && PERSON_LOOKING_LOCAL.test(local);
}

/** Minimal robots.txt reader: rules under `User-agent: *` only (we always identify with our own
 *  User-Agent, but no crawler targets this bot by name), longest-matching-prefix wins, an Allow
 *  overriding a shorter Disallow — the same precedence real crawlers use. */
export function parseRobots(text: string): { disallow: string[]; allow: string[] } {
  const disallow: string[] = [];
  const allow: string[] = [];
  let inStar = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      inStar = value === "*";
      continue;
    }
    if (!inStar) continue;
    if (field === "disallow" && value) disallow.push(value);
    if (field === "allow" && value) allow.push(value);
  }
  return { disallow, allow };
}

export function isDisallowed(robotsTxt: string, path: string): boolean {
  const { disallow, allow } = parseRobots(robotsTxt);
  const longest = (rules: string[]) => rules.filter((r) => path.startsWith(r)).sort((a, b) => b.length - a.length)[0];
  const bestDisallow = longest(disallow);
  if (!bestDisallow) return false;
  const bestAllow = longest(allow);
  return !(bestAllow && bestAllow.length >= bestDisallow.length);
}

/** True if robots.txt for this host disallows `path`. Fails open (false) if robots.txt can't be
 *  fetched at all — the same convention real crawlers use for a missing or broken robots.txt. */
export async function robotsDisallowed(url: URL, path: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`${url.protocol}//${url.host}/robots.txt`, {
      headers: { "User-Agent": ENRICH_USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    return isDisallowed(await response.text(), path || "/");
  } catch {
    return false;
  }
}

export type EnrichedContact = {
  emails: { value: string; source: string }[];
  flaggedPersonal: { value: string; source: string }[];
  phones: string[];
  audit: SiteAudit;
  robotsBlocked: boolean;
};

/** Fetches a lead's own site (politely: robots.txt honoured, our own User-Agent, site-audit's
 *  existing timeouts) and returns published phone/email plus quality signals for scoring. The
 *  caller is responsible for keeping concurrency reasonable across many leads (engine/osm.ts caps
 *  it at 4).
 *
 *  `browserRetry` (off by default — the nightly `find` cron stays fast and never launches a
 *  browser): when the plain fetch can't reach the site at all, retries once with a real browser
 *  (browser-audit.ts) before giving up. A timeout or a WAF blocking our honestly-identified
 *  crawler is our own limitation, not evidence their site is down — `cli.ts rescan` turns this on
 *  so a data-quality pass never reports "not loading" for a site that just needed a real browser.
 *
 *  `crawl4ai` (also off by default, same reasoning — see crawl4ai.ts): tried last, and only when
 *  the audit still looks weak or unreliable after the steps above (see challenge-page.ts's
 *  `needsRenderFallback` — unreachable, a confirmed bot-protection challenge page, or a plain-
 *  fetch read that extracted essentially nothing, the SPA-shell case). Optional throughout: if
 *  Crawl4AI isn't installed on this machine, this is a no-op and `audit` is left exactly as the
 *  steps above produced it. */
export async function enrichWebsite(
  website: string,
  request: typeof fetch = fetch,
  browserRetry: BrowserAuditDeps | false = false,
  crawl4ai: Crawl4aiDeps | false = false,
): Promise<EnrichedContact> {
  const none = { emails: [], flaggedPersonal: [], phones: [], audit: EMPTY_SITE_AUDIT, robotsBlocked: false };
  const url = publicUrl(website);
  if (!url) return none;
  if (await robotsDisallowed(url, url.pathname || "/", request)) return { ...none, robotsBlocked: true };
  let audit = await auditSite(website, request);
  if (!audit.reachable && browserRetry !== false) {
    const retried = await browserFetchAudit(website, browserRetry);
    if (retried) audit = retried;
  }
  if (crawl4ai !== false && needsRenderFallback(audit)) {
    const rendered = await crawl4aiAudit(audit.finalUrl || website, crawl4ai);
    if (rendered) audit = rendered;
  }
  const emails: { value: string; source: string }[] = [];
  const flaggedPersonal: { value: string; source: string }[] = [];
  const source = audit.finalUrl || website;
  for (const email of audit.emails) (looksPersonal(email) ? flaggedPersonal : emails).push({ value: email, source });
  return { emails, flaggedPersonal, phones: audit.phones, audit, robotsBlocked: false };
}
