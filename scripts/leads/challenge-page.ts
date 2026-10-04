// Bot-protection challenge/interstitial pages (Cloudflare "checking your browser", Sucuri's
// firewall block, a generic "enable cookies" gate, etc.) — a real, live response, just never the
// business's actual site. Grading one of these as if it were the homepage is exactly the same
// mistake site-audit.ts already fixed once for a 502 Bad Gateway page (Emu Plains Dentist Care,
// 25 Sep 2026, docs/LEAD-ENGINE.md): the strict redesign bar (score.ts) must never see this
// content as "no viewport meta" or "no online booking" — a real page it never got to look at. This
// module only detects; site-audit.ts, browser-audit.ts and crawl4ai.ts all use it at the point
// they have HTML in hand, and score.ts turns a detected challenge page into `audit_pending`
// ("bot-protected"), never a fabricated site problem.
import type { SiteAudit } from "./site-audit";

/** Technical fingerprints (class names, cookie names, boilerplate copy) that essentially never
 *  appear on an ordinary small-business page — matched against the *raw* HTML (they often live in
 *  a class="…" or id="…" attribute, which a plain text-strip would throw away) regardless of page
 *  length. */
const STRONG_MARKERS: RegExp[] = [
  /cf[-_]browser[-_]verification|__cf_chl_|cf_chl_opt|cf-chl-|checking your browser before accessing|attention required!\s*\|\s*cloudflare|cloudflare ray id/i,
  /sucuri[-_ ]?website[-_ ]?firewall|sucuri_cloudproxy|access denied.{0,30}sucuri/i,
  /checking the site connection security/i, // exact phrase from the owner's brief
  /please stand by,?\s*while we are checking your browser/i,
  /unusual traffic from your computer network/i, // Google's own automated-query block page
  /perimeterx|_px-captcha|px-captcha/i,
  /akamai[-_ ]?bot[-_ ]?manager|reese84|distil_r_captcha|distilnetworks/i,
  /\bimperva\b|incap_ses_|visid_incap_/i,
  // 25 Sep 2026 (issues.ts): Incapsula's resource-loader stub and SiteGround's captcha redirect —
  // both were graded as "not mobile-friendly" homepages in the top-50 call list before this.
  /_Incapsula_Resource|\/\.well-known\/sgcaptcha\//i,
];

/** Softer phrasing that real pages could plausibly contain in passing (a cookie-consent banner
 *  mentions "enable cookies" too) — only trusted on a short, otherwise-empty page, the same
 *  "genuinely an interstitial, not a real page that happens to use the phrase" gate
 *  browser-audit.ts's looksLikeErrorPage already uses for gateway-error pages. */
const WEAK_MARKERS: RegExp[] = [
  // Moved from STRONG_MARKERS 25 Sep 2026: plenty of real small-business sites load reCAPTCHA or
  // hCaptcha on their contact form, which made a whole working site read as "bot-protected". On
  // its own, a captcha script only means "challenge page" when the page is otherwise near-empty.
  /hcaptcha|recaptcha\/api\.js|grecaptcha/i,
  /enable (?:javascript and )?cookies (?:to continue|and (?:try again|reload)|to proceed)/i,
  /just a moment\s*\.{3}/i,
  /checking your (?:connection|browser)(?:\s+before)?/i,
  /verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot\??|i'?m not a robot/i,
  /one more step.{0,40}complete (?:the )?security check/i,
  /this process is automatic.{0,60}(?:redirected|forwarded)/i,
  /your (?:browser|request) (?:has been|was) (?:blocked|flagged)/i,
];

/** Short-page gate for the weak markers: a real interstitial is a handful of lines, not a full
 *  business page that merely mentions cookies in a footer banner. */
const WEAK_MARKER_TEXT_LIMIT = 2000;

function visibleText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** True only for a genuine bot-protection interstitial — never for a real business page that
 *  merely mentions cookies, captchas or "unusual traffic" somewhere on an otherwise normal page. */
export function isChallengePage(html: string): boolean {
  if (!html || !html.trim()) return false;
  if (STRONG_MARKERS.some((p) => p.test(html))) return true;
  const text = visibleText(html);
  return text.length < WEAK_MARKER_TEXT_LIMIT && WEAK_MARKERS.some((p) => p.test(text) || p.test(html));
}

/** A page that loaded (2xx, real HTTP response) but whose plain-fetch read extracted essentially
 *  nothing a real small-business page almost always has — no viewport meta, no booking/chat/
 *  contact-form tell, no recognised platform, no copyright year, no email or phone found. The
 *  common cause is a client-rendered SPA shell (React/Vue/etc. that only fills in content via JS
 *  our plain `fetch` never runs) rather than an outright bot wall, but the fix is the same: a real
 *  browser render is worth trying before trusting this as "the site". Never called on an
 *  unreachable/challenge-page audit — those already trigger the fallback for their own reason. */
export function isWeakRead(audit: SiteAudit): boolean {
  if (!audit.reachable) return false;
  return (
    !audit.mobileViewport &&
    !audit.onlineBooking &&
    !audit.chatWidget &&
    !audit.contactForm &&
    !audit.platform &&
    audit.copyrightYear === null &&
    audit.emails.length === 0 &&
    audit.phones.length === 0
  );
}

/**
 * Whether a render fallback (Crawl4AI, see crawl4ai.ts) is worth trying against this audit: it
 * couldn't be loaded at all, it was a confirmed bot-protection challenge page, or the plain fetch
 * came back with essentially nothing (a likely JS-rendered shell). Kept as one function so
 * enrich.ts's orchestration and this module's own tests agree on exactly one definition of "weak
 * or unreliable read".
 */
export function needsRenderFallback(audit: SiteAudit): boolean {
  return audit.challengePage || !audit.reachable || isWeakRead(audit);
}
