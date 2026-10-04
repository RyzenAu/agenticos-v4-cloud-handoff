// A real-browser check for a lead's site: (1) a retry when our polite, honestly-identified plain
// fetch (site-audit.ts) fails to load it at all — a timeout or a WAF block from OUR crawler is
// our own limitation, not evidence the business's site is down, so it must never be reported as a
// site problem; and (2) a genuine mobile-responsiveness measurement at a 390px viewport (the
// "objective, verified evidence" the strict redesign bar needs — a static viewport-meta check
// alone can't catch a page that claims to be responsive but still overflows). This repo has no
// Playwright dependency (checked before writing this, same conclusion scripts/site-draft/qa.ts
// already reached) — both reuse that file's own `agent-browser` CLI plumbing
// (`defaultAgentBrowserBin`/`defaultRunner`/`Runner`, imported not duplicated) rather than
// inventing a second way to drive a browser from this codebase.
import { defaultAgentBrowserBin, defaultRunner, type Runner } from "../site-draft/qa";
import { isChallengePage } from "./challenge-page";
import { analyseHtml, COMMON_INNER_PATHS, EMPTY_SITE_AUDIT, extractEmails, publicUrl, type SiteAudit } from "./site-audit";

/** Real Chromium cold-launch + a genuinely slow/heavy page can take a while — longer than the
 *  12s plain-fetch budget in site-audit.ts, but still bounded so one stuck site can't hang a
 *  whole `rescan` run. `defaultRunner` kills the subprocess and returns `ok:false` past this,
 *  exactly like site-draft/qa.ts's own screenshot calls. */
export const BROWSER_AUDIT_TIMEOUT_MS = 45_000;

/** iPhone-ish mobile viewport — the width the brief specifies (390px) with a plausible height. */
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;

/** A small tolerance (scrollbar width, subpixel rounding) so a page that's genuinely fine doesn't
 *  get flagged for a 1-2px rounding difference. */
const OVERFLOW_JS = `(() => { try { return document.documentElement.scrollWidth > (window.innerWidth + 8) ? "true" : "false"; } catch (e) { return "unknown"; } })()`;

export type BrowserAuditDeps = { runner?: Runner; sessionPrefix?: string };

/** Generic gateway/server-error page tells (nginx/Cloudflare/IIS default error pages, and the
 *  plain English a lot of hosts show) — never trust a mobile/content signal measured off one of
 *  these. Live case, 25 Sep 2026: Emu Plains Dentist Care's homepage rendered a 502 Bad Gateway
 *  page in-browser; its missing viewport meta got wrongly reported as "not mobile-friendly" for
 *  the real site. The CLI doesn't cheaply expose the main document's HTTP status (see
 *  `browserFetchAudit`'s own note on that gap), so this text heuristic is the next best check —
 *  short, generic pages matching one of these are refused rather than graded. */
const ERROR_PAGE_MARKERS = /\b50[0234]\b.{0,20}(bad gateway|gateway time-?out|service unavailable|internal server error)|bad gateway|gateway time-?out|service unavailable|this page isn.?t working|http error 5\d\d|nginx\/[\d.]+.{0,10}error/i;

/** True only for a short, generic page that reads like a gateway/server error, not a real
 *  business page that merely happens to mention one of these words in passing. */
function looksLikeErrorPage(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length < 1500 && ERROR_PAGE_MARKERS.test(text);
}

let counter = 0;
function sessionName(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function runnerFor(deps: BrowserAuditDeps): Runner {
  return deps.runner ?? defaultRunner(defaultAgentBrowserBin(), BROWSER_AUDIT_TIMEOUT_MS);
}

/** Opens `url` in its own fresh session at the 390px mobile viewport (viewport set before the
 *  first real navigation, so the page's own responsive CSS/media queries see it from the start —
 *  the same staged-state pattern agent-browser's own docs recommend). Always closes the session,
 *  even on error. */
async function withMobileSession<T>(
  url: URL,
  deps: BrowserAuditDeps,
  fn: (run: Runner, S: string[]) => Promise<T>,
): Promise<T | null> {
  const run = runnerFor(deps);
  const S = ["--session", sessionName(deps.sessionPrefix ?? "lead-audit")];
  try {
    await run([...S, "open"]); // blank, so viewport is staged before the first real navigation
    await run([...S, "set", "viewport", String(MOBILE_WIDTH), String(MOBILE_HEIGHT)]);
    const opened = await run([...S, "open", url.href, "--json"]);
    if (!opened.ok) return null;
    return await fn(run, S);
  } catch {
    return null;
  } finally {
    await run([...S, "close"]).catch(() => {});
  }
}

/** True/false if measured, null if the browser couldn't load the page or the check itself
 *  failed — never guessed. Standalone and cheap (no HTML capture) for a site whose plain-fetch
 *  audit already succeeded and just needs this one extra signal. */
export async function browserOverflowCheck(website: string, deps: BrowserAuditDeps = {}): Promise<boolean | null> {
  const url = publicUrl(website);
  if (!url) return null;
  const result = await withMobileSession(url, deps, async (run, S) => {
    // Defense in depth: `website` should already be a real content page by the time this is
    // called (site-audit.ts's own error-page fallback runs first) — but never measure "overflow"
    // off an error page if one somehow still shows up here.
    const htmlResult = await run([...S, "get", "html", "html"]);
    if (htmlResult.ok && looksLikeErrorPage(htmlResult.stdout)) return null;
    const evalResult = await run([...S, "eval", OVERFLOW_JS]);
    if (!evalResult.ok) return null;
    const out = evalResult.stdout.trim();
    return out === "true" ? true : out === "false" ? false : null;
  });
  return result ?? null;
}

/**
 * Opens `website` in a real browser (agent-browser CLI), at the 390px mobile viewport, and if it
 * loads, returns a SiteAudit built from the actually-rendered page — same shape and same
 * `analyseHtml`/`extractEmails` logic site-audit.ts's plain fetch uses, plus a real
 * `overflowAt390` measurement, so scoring gets the mobile-responsiveness signal for free on a
 * retry. Returns null (never throws) if the browser itself can't load it either, so the caller
 * can report "audit pending" rather than inventing a site problem.
 */
export async function browserFetchAudit(website: string, deps: BrowserAuditDeps = {}): Promise<SiteAudit | null> {
  const url = publicUrl(website);
  if (!url) return null;
  return withMobileSession(url, deps, async (run, S) => {
    let htmlResult = await run([...S, "get", "html", "html"]);
    if (!htmlResult.ok || !htmlResult.stdout.trim()) return null;
    let html = htmlResult.stdout;
    let homepageError: string | null = null;
    let homepageBroken = false;

    // The homepage itself rendered an error page (a gateway/server error, not the real site) or a
    // bot-protection challenge page (25 Sep 2026, Crawl4AI fallback work: a real Chromium render
    // can still be shown a WAF's interstitial) — never grade either; try a few common content
    // pages in the same session instead. This mirrors site-audit.ts's plain-fetch fallback, minus
    // the sitemap step (kept bounded: a browser hop is expensive, and the plain-fetch path already
    // tried the sitemap first).
    const initialChallenge = isChallengePage(html);
    if (looksLikeErrorPage(html) || initialChallenge) {
      homepageError = initialChallenge ? "bot-protected" : "error page"; // the CLI doesn't expose the real HTTP status cheaply — see below
      homepageBroken = !initialChallenge; // a challenge page is blocked, not "down" — never the same finding
      let found = false;
      for (const path of COMMON_INNER_PATHS) {
        const candidate = new URL(path, url).href;
        const reopened = await run([...S, "open", candidate, "--json"]);
        if (!reopened.ok) continue;
        const retryHtml = await run([...S, "get", "html", "html"]);
        if (retryHtml.ok && retryHtml.stdout.trim() && !looksLikeErrorPage(retryHtml.stdout) && !isChallengePage(retryHtml.stdout)) {
          html = retryHtml.stdout;
          found = true;
          break;
        }
      }
      if (!found) {
        if (initialChallenge) {
          // Never a fabricated mobile/HTTPS/etc finding, and never "broken" either — a confirmed
          // bot wall is its own state (score.ts: audit_pending, reason "bot-protected").
          return { ...EMPTY_SITE_AUDIT, challengePage: true, error: "bot-protected", homepageCheckedAt: new Date().toISOString() };
        }
        // No working page found at all — never grade the error page. Reported as "homepage
        // down", not a fabricated mobile/HTTPS/etc finding.
        return {
          ...EMPTY_SITE_AUDIT,
          reachable: false,
          broken: true,
          homepageError,
          homepageBroken,
          homepageCheckedAt: new Date().toISOString(),
          homepageRetryCheckedAt: null,
        };
      }
    }

    const urlResult = await run([...S, "get", "url"]);
    const finalHref = urlResult.ok && urlResult.stdout.trim() ? urlResult.stdout.trim() : url.href;
    const final = publicUrl(finalHref) ?? url;
    const overflowResult = await run([...S, "eval", OVERFLOW_JS]);
    const overflowOut = overflowResult.ok ? overflowResult.stdout.trim() : "";
    const overflowAt390 = overflowOut === "true" ? true : overflowOut === "false" ? false : null;
    const facts = analyseHtml(html);
    return {
      ...facts,
      reachable: true,
      finalUrl: final.href,
      auditedUrl: final.href,
      https: final.protocol === "https:",
      // Not a plain-fetch timing (a real browser waits for a fully rendered page, not just
      // first bytes) — null rather than a number that would be compared against the same
      // "3000ms is slow" threshold plain fetches use.
      responseMs: null,
      emails: extractEmails(html, final.hostname),
      // A real browser that rendered real content isn't "broken" by this check's own definition
      // (a verified 5xx) — the CLI doesn't cheaply expose the main document's HTTP status, so
      // this stays a documented gap rather than a guess.
      statusCode: null,
      broken: false,
      sslError: false,
      overflowAt390,
      challengePage: false,
      homepageError,
      homepageBroken: false, // resolved: a working page was found, so it's not "down"
      homepageCheckedAt: homepageError ? new Date().toISOString() : null,
      homepageRetryCheckedAt: null,
    };
  });
}
