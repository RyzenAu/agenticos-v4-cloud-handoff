import { describe, expect, test } from "bun:test";
import { isVerifiedFact, scoreLead } from "./score";
import { EMPTY_SITE_AUDIT, type SiteAudit } from "./site-audit";

const REACHABLE: SiteAudit = {
  ...EMPTY_SITE_AUDIT,
  reachable: true, finalUrl: "https://example.com.au/", https: true, mobileViewport: true,
  onlineBooking: true, responseMs: 400,
};

describe("score: a known-but-unreachable site is 'audit pending', never 'website' or a fabricated problem", () => {
  test("pitch is audit_pending, not website — the lead has a real, known domain", () => {
    const unreachable: SiteAudit = { ...EMPTY_SITE_AUDIT, reachable: false, error: "timed out" };
    const scored = scoreLead({ website: "https://stclairfamilydental.com.au/", rating: null, reviews: null, hours: [] }, unreachable, "dental");
    expect(scored.pitch).toBe("audit_pending");
  });

  test("the reason reads as our own audit failing, not their site being broken or absent", () => {
    const unreachable: SiteAudit = { ...EMPTY_SITE_AUDIT, reachable: false, error: "timed out" };
    const scored = scoreLead({ website: "https://stclairfamilydental.com.au/", rating: null, reviews: null, hours: [] }, unreachable, "dental");
    expect(scored.reasons[0]).toMatch(/^audit pending — couldn't load their site \(checked \d{4}-\d{2}-\d{2}\): timed out$/);
    expect(scored.reasons.join(" ")).not.toMatch(/no website/i);
  });

  test("an audit-pending reason is never tagged [verified] — it's not an observed fact about their site", () => {
    const unreachable: SiteAudit = { ...EMPTY_SITE_AUDIT, reachable: false, error: "not loading" };
    const scored = scoreLead({ website: "https://example.com.au/", rating: null, reviews: null, hours: [] }, unreachable, "legal");
    expect(scored.reasons.every((r) => !isVerifiedFact(r))).toBe(true);
  });

  test("a confirmed bot-protection challenge page is audit_pending with reason 'bot-protected' — never a fabricated 'bad website' finding (25 Sep 2026, Crawl4AI fallback)", () => {
    // Deliberately also carries signals that WOULD trip the severe/moderate bar if graded as a
    // real page (no viewport meta, no booking, stale-looking) — challengePage must short-circuit
    // before any of that is ever evaluated.
    const challenge: SiteAudit = { ...EMPTY_SITE_AUDIT, challengePage: true, error: "bot-protected", statusCode: 503 };
    const scored = scoreLead({ website: "https://example.com.au/", rating: null, reviews: null, hours: [] }, challenge, "dental");
    expect(scored.pitch).toBe("audit_pending");
    expect(scored.severity).toBe(0);
    expect(scored.score).toBe(0);
    expect(scored.reasons[0]).toMatch(/bot-protected/);
    expect(scored.verdict).toMatch(/bot-protected/);
    expect(scored.reasons.every((r) => !isVerifiedFact(r))).toBe(true);
  });

  test("a genuinely-no-website lead still pitches 'website', unaffected", () => {
    const scored = scoreLead({ website: "", rating: null, reviews: null, hours: [], noWebsiteCheckedAt: "2026-09-24T00:00:00Z" }, EMPTY_SITE_AUDIT, "dental");
    expect(scored.pitch).toBe("website");
    expect(scored.reasons[0]).toBe("no website found (checked 2026-09-24)");
  });

  test("a real, reachable site with a verified problem pitches 'redesign', never 'website'", () => {
    const problematic: SiteAudit = { ...REACHABLE, https: false, mobileViewport: false };
    const scored = scoreLead({ website: "https://example.com.au/", rating: null, reviews: null, hours: [] }, problematic, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.reasons).toContain("the site isn't on HTTPS");
  });
});

describe("score: the strict redesign bar (25 Sep 2026 owner direction — 'genuinely have to be really bad')", () => {
  const place = { website: "https://example.com.au/", rating: null, reviews: null, hours: [] };

  test("a decent, modern, reachable site is 'none' — not a website prospect, never redesign", () => {
    const decent: SiteAudit = { ...REACHABLE, copyrightYear: 2026, platform: "" };
    const scored = scoreLead(place, decent, "dental");
    expect(scored.pitch).toBe("none");
    expect(scored.severity).toBe(0);
    expect(scored.verdict).toBe("Not a website prospect — decent, modern site");
  });

  test("no online booking, alone, is a receptionist pitch — never redesign", () => {
    const noBooking: SiteAudit = { ...REACHABLE, onlineBooking: false, copyrightYear: 2026 };
    const scored = scoreLead(place, noBooking, "dental");
    expect(scored.pitch).toBe("receptionist");
    expect(scored.severity).toBe(0);
  });

  test("severe: not mobile-responsive (no viewport meta) qualifies redesign on its own", () => {
    const notMobile: SiteAudit = { ...REACHABLE, mobileViewport: false };
    const scored = scoreLead(place, notMobile, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.severity).toBeGreaterThanOrEqual(60);
    expect(scored.verdict).toContain("not mobile-friendly");
  });

  test("severe: horizontal overflow at 390px (real-browser check) qualifies even with a viewport meta tag", () => {
    // A page can claim to be responsive (viewport meta present) and still overflow — only a real
    // rendered check catches that; mobileViewport alone would have said "fine".
    const overflowing: SiteAudit = { ...REACHABLE, mobileViewport: true, overflowAt390: true };
    const scored = scoreLead(place, overflowing, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toContain("overflows at 390px");
  });

  test("severe: no HTTPS qualifies on its own", () => {
    const noHttps: SiteAudit = { ...REACHABLE, https: false };
    expect(scoreLead(place, noHttps, "dental").pitch).toBe("redesign");
  });

  test("severe: an SSL error qualifies even when the protocol itself is https", () => {
    const sslError: SiteAudit = { ...REACHABLE, https: true, sslError: true };
    const scored = scoreLead(place, sslError, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toContain("SSL error");
  });

  test("severe: broken (5xx) qualifies, and an error page's own content is never graded alongside it", () => {
    // onlineBooking:true isolates this to a pure "redesign" (no receptionist gap) so the
    // assertion below is about the broken-site signal specifically, not the "both" combo.
    const broken: SiteAudit = { ...EMPTY_SITE_AUDIT, reachable: false, broken: true, statusCode: 503, onlineBooking: true };
    const scored = scoreLead(place, broken, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toBe("Redesign: broken (HTTP 503)");
    expect(scored.reasons.filter((r) => isVerifiedFact(r))).toEqual(["Redesign: broken (HTTP 503)", "the site returns a server error (HTTP 503)"]);
  });

  test("severe: clearly abandoned needs BOTH a stale (<2021) copyright AND an outdated-tech tell — neither alone is severe", () => {
    const staleOnly: SiteAudit = { ...REACHABLE, copyrightYear: 2016, outdatedTechSignals: [] };
    expect(scoreLead(place, staleOnly, "dental").pitch).not.toBe("redesign"); // moderate only
    const techOnly: SiteAudit = { ...REACHABLE, copyrightYear: 2026, outdatedTechSignals: ["Flash"] };
    expect(scoreLead(place, techOnly, "dental").pitch).not.toBe("redesign");
    const both: SiteAudit = { ...REACHABLE, copyrightYear: 2016, outdatedTechSignals: ["Flash", "nested table layout"] };
    const scored = scoreLead(place, both, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toContain("© 2016");
  });

  test("severe: a slow load (LCP proxy) past 6s qualifies on its own", () => {
    const slow: SiteAudit = { ...REACHABLE, responseMs: 7800 };
    const scored = scoreLead(place, slow, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toContain("LCP 7.8 s");
  });

  test("matches the owner's own example verdict shape: not mobile-friendly + stale/abandoned + slow", () => {
    const bad: SiteAudit = { ...REACHABLE, mobileViewport: false, copyrightYear: 2016, outdatedTechSignals: ["nested table layout"], responseMs: 7800 };
    const scored = scoreLead(place, bad, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toBe("Redesign: not mobile-friendly, © 2016, LCP 7.8 s");
  });

  test("moderate signals alone (one) never qualify redesign", () => {
    const oneModerateOnly: SiteAudit = { ...REACHABLE, copyrightYear: 2023, responseMs: 400, platform: "" };
    const scored = scoreLead(place, oneModerateOnly, "dental");
    expect(scored.pitch).not.toBe("redesign");
  });

  test("two-plus moderate signals qualify, but only as a lower-confidence 'maybe'", () => {
    const twoModerate: SiteAudit = { ...REACHABLE, responseMs: 4200, copyrightYear: 2022 }; // 3.2-6s load + stale-but-not-abandoned ©
    const scored = scoreLead(place, twoModerate, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toContain("(maybe)");
    expect(scored.severity).toBeLessThan(60); // below the "confident" severe-signal floor
  });

  test("severe + a receptionist gap pitches 'both', not just 'redesign'", () => {
    const severeAndGap: SiteAudit = { ...REACHABLE, https: false, onlineBooking: false };
    const scored = scoreLead({ ...place, hours: ["Monday: 9:00 AM – 5:00 PM", "Saturday: Closed", "Sunday: Closed"] }, severeAndGap, "dental");
    expect(scored.pitch).toBe("both");
  });

  test("verdict reads correctly per vertical for the booking phrase", () => {
    const noBooking: SiteAudit = { ...REACHABLE, onlineBooking: false, copyrightYear: 2026 };
    expect(scoreLead(place, noBooking, "legal").reasons).toContain("there's no way to book a consult online");
    expect(scoreLead(place, noBooking, "real-estate").reasons).toContain("there's no way to book an appraisal online");
  });

  test("the real-estate 'no way to book an appraisal online' reason is tagged [verified] (regression: article mismatch 'a appraisal' vs 'an appraisal' silently broke this)", () => {
    const noBooking: SiteAudit = { ...REACHABLE, onlineBooking: false, copyrightYear: 2026 };
    expect(isVerifiedFact("there's no way to book an appraisal online")).toBe(true);
    expect(isVerifiedFact("there's no way to book a consult online")).toBe(true);
    const scored = scoreLead(place, noBooking, "real-estate");
    expect(scored.reasons.some((r) => r === "there's no way to book an appraisal online" && isVerifiedFact(r))).toBe(true);
  });
});

describe("score: the Emu Plains error-page trap (25 Sep 2026 owner correction)", () => {
  const place = { website: "https://emuplainsfamilydental.com.au/", rating: null, reviews: null, hours: [] };

  test("a confirmed-down homepage is its own severe, verified signal — worded precisely, never 'not mobile-friendly'", () => {
    // The real content (graded from an inner page, e.g. About Us) is fine — the only real issue
    // is the confirmed-broken homepage itself.
    const site: SiteAudit = {
      ...REACHABLE, auditedUrl: "https://emuplainsfamilydental.com.au/about-us/",
      homepageError: "502 Bad Gateway", homepageBroken: true,
      homepageCheckedAt: "2026-09-25T10:00:00.000Z", homepageRetryCheckedAt: "2026-09-25T10:01:00.000Z",
    };
    const scored = scoreLead(place, site, "dental");
    expect(scored.pitch).toBe("redesign");
    expect(scored.verdict).toBe("Redesign: homepage down (502 Bad Gateway)");
    expect(scored.reasons.join(" ")).not.toMatch(/not mobile-friendly/i);
    expect(scored.reasons.some((r) => r.includes("502 Bad Gateway") && r.includes("2026-09-25"))).toBe(true);
    expect(isVerifiedFact(scored.reasons[1])).toBe(true);
  });

  test("an unconfirmed homepage error (a single check, or a 4xx) is moderate, not severe, on its own", () => {
    const site: SiteAudit = { ...REACHABLE, homepageError: "403 Forbidden", homepageBroken: false };
    const scored = scoreLead(place, site, "dental");
    expect(scored.pitch).not.toBe("redesign"); // one moderate signal alone doesn't qualify
    expect(scored.reasons.some((r) => r.includes("403 Forbidden") && r.includes("unconfirmed"))).toBe(true);
  });

  test("no working page anywhere (homepage confirmed down, no inner page found) reads as 'homepage down', not a generic broken/audit-pending claim", () => {
    const site: SiteAudit = {
      ...EMPTY_SITE_AUDIT, reachable: false, broken: true,
      homepageError: "502 Bad Gateway", homepageBroken: true,
      homepageCheckedAt: "2026-09-25T10:00:00.000Z", homepageRetryCheckedAt: "2026-09-25T10:01:00.000Z",
    };
    const scored = scoreLead(place, site, "dental");
    expect(scored.pitch).not.toBe("audit_pending"); // confirmed broken, not merely unknown
    expect(scored.verdict).toContain("homepage down (502 Bad Gateway)");
    expect(scored.reasons.some((r) => r.includes("no working inner page could be found"))).toBe(true);
  });
});
