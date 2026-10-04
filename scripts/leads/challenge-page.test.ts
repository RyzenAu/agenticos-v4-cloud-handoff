import { describe, expect, test } from "bun:test";
import { isChallengePage, isWeakRead, needsRenderFallback } from "./challenge-page";
import { EMPTY_SITE_AUDIT, type SiteAudit } from "./site-audit";

const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body class="cf-browser-verification"><div id="cf-content">
Checking your browser before accessing example.com.au. This process is automatic. Your browser will
redirect to your requested content shortly. Please allow up to 5 seconds. Ray ID: 8a1b2c3d4e5f6789
</div></body></html>`;

const SUCURI_BLOCK = `<html><head><title>Sucuri WebSite Firewall - Access Denied</title></head>
<body><h1>Access Denied - Sucuri Website Firewall</h1><p>If you are the site owner, contact your
hosting provider.</p></body></html>`;

const GENERIC_COOKIE_GATE = `<html><body><p>Checking the site connection security. Please enable
cookies and reload the page to continue.</p></body></html>`;

const REAL_BUSINESS_PAGE = `<html><head><meta name="viewport" content="width=device-width">
<title>St Clair Dental</title></head><body><h1>St Clair Dental</h1><p>Your local dentist in
St Clair. Book online now.</p><footer>© 2025 St Clair Dental. We use cookies to improve your
experience — enable cookies in your browser for the best experience on this site.</footer>
<a href="mailto:reception@stclairdental.com.au">Email</a></body></html>`;

describe("challenge-page: bot-protection interstitial detection", () => {
  test("recognises a Cloudflare 'checking your browser' interstitial", () => {
    expect(isChallengePage(CLOUDFLARE_CHALLENGE)).toBe(true);
  });

  test("recognises a Sucuri firewall block page", () => {
    expect(isChallengePage(SUCURI_BLOCK)).toBe(true);
  });

  test("recognises the exact 'checking the site connection security' / 'enable cookies' phrasing from the brief", () => {
    expect(isChallengePage(GENERIC_COOKIE_GATE)).toBe(true);
  });

  test("never flags a real business page that merely mentions cookies in its own footer copy", () => {
    expect(isChallengePage(REAL_BUSINESS_PAGE)).toBe(false);
  });

  test("empty or missing HTML is never a challenge page (that's the plain 'unreachable' case instead)", () => {
    expect(isChallengePage("")).toBe(false);
  });

  test("a long, ordinary page is never flagged just for using a similar word once in passing", () => {
    const longPage = `<html><body>${"<p>Welcome to our clinic. ".repeat(200)}Please enable cookies for the best experience.</p></body></html>`;
    expect(isChallengePage(longPage)).toBe(false);
  });
});

describe("challenge-page: the render-fallback trigger logic", () => {
  const reachablePage = (overrides: Partial<SiteAudit> = {}): SiteAudit => ({ ...EMPTY_SITE_AUDIT, reachable: true, ...overrides });

  test("a normal, content-rich page is not a weak read", () => {
    const audit = reachablePage({ mobileViewport: true, onlineBooking: true, copyrightYear: 2025 });
    expect(isWeakRead(audit)).toBe(false);
    expect(needsRenderFallback(audit)).toBe(false);
  });

  test("a reachable page with nothing extracted at all (the SPA-shell case) is a weak read", () => {
    const audit = reachablePage(); // reachable, but every extracted signal is still at its empty default
    expect(isWeakRead(audit)).toBe(true);
    expect(needsRenderFallback(audit)).toBe(true);
  });

  test("one real signal (an email, say) is enough to not count as a weak read", () => {
    const audit = reachablePage({ emails: ["info@example.com.au"] });
    expect(isWeakRead(audit)).toBe(false);
    expect(needsRenderFallback(audit)).toBe(false);
  });

  test("an unreachable audit always needs the fallback, regardless of isWeakRead (which only applies to a reachable page)", () => {
    const audit: SiteAudit = { ...EMPTY_SITE_AUDIT, reachable: false, error: "timed out" };
    expect(isWeakRead(audit)).toBe(false); // not applicable — guarded by `!audit.reachable`
    expect(needsRenderFallback(audit)).toBe(true);
  });

  test("a confirmed challenge page always needs the fallback", () => {
    const audit: SiteAudit = { ...EMPTY_SITE_AUDIT, challengePage: true, error: "bot-protected" };
    expect(needsRenderFallback(audit)).toBe(true);
  });
});
