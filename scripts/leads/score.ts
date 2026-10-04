// Opportunity score, 0–100: how much a website rebuild and/or an AI receptionist would help this
// business. Signals are cheap (a directory listing + one page fetch, plus a real-browser check
// for a site being rescanned — see browser-audit.ts). Weights are a starting guess, not a
// measured model: see docs/LEAD-ENGINE.md, and tune them once real call outcomes exist. Works the
// same for a Google Places result or an OpenStreetMap one — only `website`, `rating`, `reviews`
// and `hours` are read, so either source's shape satisfies it.
//
// 25 Sep 2026 owner direction: "tighten the leads with websites, they genuinely have to be really
// bad for them to want a new one." `redesign` is now gated on objective, verified evidence — see
// SEVERE_* below — not a handful of small point nudges adding up. `severity`/`verdict` are new,
// additive fields (Scored keeps `score`/`reasons`/`pitch`, unchanged in type) for whoever's
// building the Leads UI around this.
import type { Vertical } from "./places";
import type { SiteAudit } from "./site-audit";

export type Pitch = "website" | "redesign" | "receptionist" | "both" | "audit_pending" | "none";

export type Scored = {
  score: number;
  reasons: string[];
  pitch: Pitch;
  /** NEW 25 Sep 2026. 0–100, purely "how objectively bad is the site" — distinct from `score`
   *  (the overall call-worthiness estimate, which also weighs phone/hours signals). Drives the
   *  strict redesign bar: only a lead with at least one severe, verified signal (or two-plus
   *  moderate signals plus a poor overall impression) scores above 0 here. */
  severity: number;
  /** NEW 25 Sep 2026. One line, e.g. "Redesign: not mobile-friendly, © 2016, LCP 7.8 s" or
   *  "Redesign (maybe): 4.1 s load, © 2022" or "Not a website prospect — decent, modern site". */
  verdict: string;
};

export type ScoreInput = {
  website: string;
  rating: number | null;
  reviews: number | null;
  hours: string[];
  /** Set when a discovery pass (scripts/leads/discovery.ts) actually looked for this business's
   *  website and found nothing with high confidence — never assumed from a missing OSM/Google
   *  tag. Drives the "no website found (checked <date>)" reason instead of a bare claim. */
  noWebsiteCheckedAt?: string | null;
};

/** True when the listed hours close before 6 pm on a weekday or the business shuts at weekends. */
export function limitedHours(hours: string[]): boolean {
  if (!hours.length) return false;
  const weekend = hours.filter((h) => /^(Saturday|Sunday)/i.test(h));
  const closedWeekend = weekend.length > 0 && weekend.every((h) => /closed/i.test(h));
  const earlyClose = hours.some((h) => /^(Mon|Tue|Wed|Thu|Fri)/i.test(h) && /[–-]\s*(?:[1-5]|12):\d{2}\s*PM/i.test(h));
  return closedWeekend || earlyClose;
}

const CURRENT_YEAR_LOOKBACK = 3; // "stale" copyright: 3+ years old
const ABANDONED_YEAR = 2021; // "clearly abandoned" copyright cutoff, per the owner's bar
const SLOW_MODERATE_MS = 3200;
const SLOW_SEVERE_MS = 6000; // LCP > 6s in the brief; responseMs is the closest thing this audit
// actually measures (no Lighthouse in this repo — see scripts/site-draft/qa.ts's own note on the
// same gap) — a real time-to-first-byte-ish figure, not a guess, just not literally LCP.

type Signal = { verdict: string; full: string };

function bookingPhrase(vertical: Vertical): string {
  return vertical === "dental" ? "there's no online booking" : vertical === "legal" ? "there's no way to book a consult online" : "there's no way to book an appraisal online";
}

/** The severe signals a reachable, healthy (non-5xx) page can show — any ONE, verified, is
 *  enough to justify "redesign" on its own. Each carries a terse verdict phrase and a fuller
 *  reasons[]-style sentence. */
function severeSignals(site: SiteAudit, now: Date): Signal[] {
  const out: Signal[] = [];
  if (!site.mobileViewport || site.overflowAt390 === true) {
    out.push(
      site.overflowAt390 === true
        ? { verdict: "not mobile-friendly (overflows at 390px)", full: "the page overflows horizontally on a 390px mobile screen" }
        : { verdict: "not mobile-friendly", full: "the site isn't mobile-friendly (no viewport meta tag)" },
    );
  }
  if (!site.https) out.push({ verdict: "no HTTPS", full: "the site isn't on HTTPS" });
  else if (site.sslError) out.push({ verdict: "SSL error", full: "the site has an SSL/certificate error" });
  if (site.broken) out.push({ verdict: `broken (HTTP ${site.statusCode})`, full: `the site returns a server error (HTTP ${site.statusCode})` });
  if (site.homepageBroken) {
    const times = [site.homepageCheckedAt, site.homepageRetryCheckedAt].filter(Boolean).map((t) => t!.slice(0, 16).replace("T", " "));
    out.push({
      verdict: `homepage down (${site.homepageError})`,
      full: `the homepage returned ${site.homepageError} (checked twice, ${times.join(" and ")}) — real content is on their inner pages, audited below`,
    });
  }
  const abandoned = !!site.copyrightYear && site.copyrightYear < ABANDONED_YEAR && site.outdatedTechSignals.length > 0;
  if (abandoned) out.push({ verdict: `© ${site.copyrightYear}`, full: `clearly abandoned — © ${site.copyrightYear} and ${site.outdatedTechSignals.join(", ")}` });
  if (site.responseMs !== null && site.responseMs > SLOW_SEVERE_MS) {
    const s = (site.responseMs / 1000).toFixed(1);
    out.push({ verdict: `LCP ${s} s`, full: `the home page takes ${s} s to load (well past a usable load time)` });
  }
  return out;
}

/** Moderate signals: real, but none justify "redesign" alone — two or more, plus a poor overall
 *  impression, can. "No online booking" is deliberately excluded here: per the owner's direction
 *  it's a *receptionist* pitch on its own, never a redesign reason (see hasReceptionistGap). */
function moderateSignals(site: SiteAudit, now: Date, alreadyAbandoned: boolean): Signal[] {
  const out: Signal[] = [];
  if (site.responseMs !== null && site.responseMs >= SLOW_MODERATE_MS && site.responseMs <= SLOW_SEVERE_MS) {
    const s = (site.responseMs / 1000).toFixed(1);
    out.push({ verdict: `${s} s load`, full: `the home page takes ${s} s to load` });
  }
  if (!alreadyAbandoned && site.copyrightYear && site.copyrightYear <= now.getFullYear() - CURRENT_YEAR_LOOKBACK) {
    out.push({ verdict: `© ${site.copyrightYear}`, full: `the footer still says © ${site.copyrightYear}` });
  }
  if (["Wix", "Squarespace"].includes(site.platform)) {
    out.push({ verdict: `dated ${site.platform} template`, full: `the site is on a DIY builder (${site.platform})` });
  }
  // A homepage error seen once but not confirmed persistent (a 4xx, which is often just a WAF
  // block rather than real breakage, or a 5xx we didn't get to retry) is real but not yet
  // verified as ongoing — moderate, not the severe "homepage down" above.
  if (site.homepageError && !site.homepageBroken) {
    out.push({ verdict: `homepage returned ${site.homepageError} (unconfirmed)`, full: `the homepage returned ${site.homepageError} on this check (not yet confirmed persistent)` });
  }
  return out;
}

export function scoreLead(place: ScoreInput, site: SiteAudit, vertical: Vertical, now = new Date()): Scored {
  const today = now.toISOString().slice(0, 10);

  if (!place.website) {
    const phone = phoneSignals(place);
    // 25 Sep 2026 (issues.ts targeting pass): "website" is only pitched once a discovery pass has
    // actually looked and found nothing. A directory with no URL on file is not evidence — most
    // businesses have a site the directory just doesn't know about.
    if (!place.noWebsiteCheckedAt) {
      const reason = "no website on file yet — not checked (run rescan to look)";
      return { score: 0, reasons: [reason, ...phone.reasons], pitch: "audit_pending", severity: 0, verdict: "Audit pending — no website on file, not yet checked" };
    }
    const reason = `no website found (checked ${place.noWebsiteCheckedAt.slice(0, 10)})`;
    return { score: Math.min(100, 45 + phone.score), reasons: [reason, ...phone.reasons], pitch: "website", severity: 0, verdict: "No website found" };
  }

  // 25 Sep 2026 (Crawl4AI fallback): a confirmed bot-protection challenge page (Cloudflare,
  // Sucuri, a generic "enable cookies" gate — see challenge-page.ts) is a live response, just
  // never the business's real site. Checked first, ahead of the generic unreachable case below,
  // so the reason always names the actual cause rather than a bare "couldn't load it" — and,
  // critically, so it can never fall through to the severe/moderate evaluation further down and
  // get scored as a genuinely bad site off the interstitial's own missing viewport meta/booking/
  // etc. The strict "genuinely bad site" bar still applies to everything else unchanged.
  if (site.challengePage) {
    const reason = `bot-protected — couldn't get past the site's challenge page to see it (checked ${today})`;
    return { score: 0, reasons: [reason], pitch: "audit_pending", severity: 0, verdict: `Audit pending — bot-protected (checked ${today})` };
  }

  // A domain we know about, but couldn't load at all (timeout, WAF block, DNS/TLS failure short
  // of a verified 5xx) is genuinely unknown, not evidence of anything — "audit pending", never a
  // guessed problem or a bare "no website" claim.
  if (!site.reachable && !site.broken) {
    const reason = `audit pending — couldn't load their site (checked ${today})${site.error ? `: ${site.error}` : ""}`;
    return { score: 0, reasons: [reason], pitch: "audit_pending", severity: 0, verdict: `Audit pending — couldn't load their site (checked ${today})` };
  }

  // Reachable (or a verified 5xx with no working inner page either — see site-audit.ts's
  // findInnerPage — which counts as reachable-enough-to-judge): the actual strict redesign
  // evaluation. An error page's body is never the real site, so when nothing but the error
  // itself could be found, that's the only evidence — never grade its viewport meta or footer.
  const severe: Signal[] = site.broken
    ? [
        site.homepageBroken
          ? {
              verdict: `homepage down (${site.homepageError})`,
              full: `the homepage returned ${site.homepageError} (checked twice, ${[site.homepageCheckedAt, site.homepageRetryCheckedAt].filter(Boolean).map((t) => t!.slice(0, 16).replace("T", " ")).join(" and ")}), and no working inner page could be found either`,
            }
          : { verdict: `broken (HTTP ${site.statusCode})`, full: `the site returns a server error (HTTP ${site.statusCode})` },
      ]
    : severeSignals(site, now);
  const abandoned = severe.some((s) => s.verdict.startsWith("©"));
  const moderate = site.broken ? [] : moderateSignals(site, now, abandoned);
  const maybe = severe.length === 0 && moderate.length >= 2;

  const hasReceptionistGap = limitedHours(place.hours) || !site.onlineBooking;
  const redesignWorthy = severe.length > 0 || maybe;

  const reasons: string[] = [];
  // Once there's at least one severe (or two-plus moderate, "maybe") signal, show the full
  // picture — severe facts first, moderate ones too — not just the single signal that tipped it.
  const facts = [...severe, ...moderate];
  for (const f of facts) reasons.push(f.full);
  if (!site.onlineBooking) reasons.push(bookingPhrase(vertical));

  let pitch: Pitch;
  let verdict: string;
  let severity: number;
  if (redesignWorthy && hasReceptionistGap) {
    pitch = "both";
    severity = severityScore(severe.length, moderate.length, maybe);
    verdict = `${maybe ? "Redesign (maybe) + receptionist" : "Redesign + receptionist"}: ${facts.map((f) => f.verdict).slice(0, 3).join(", ")}`;
  } else if (redesignWorthy) {
    pitch = "redesign";
    severity = severityScore(severe.length, moderate.length, maybe);
    verdict = `${maybe ? "Redesign (maybe)" : "Redesign"}: ${facts.map((f) => f.verdict).slice(0, 3).join(", ")}`;
  } else if (hasReceptionistGap) {
    pitch = "receptionist";
    severity = 0;
    verdict = limitedHours(place.hours) ? "Receptionist: after-hours calls go unanswered" : "Receptionist: no online booking";
  } else if (facts.length > 0) {
    // A single moderate signal (not enough to qualify redesign) is still real, worth keeping —
    // e.g. an unconfirmed homepage error. Only a site with truly nothing to report is "none".
    pitch = "none";
    severity = 0;
    verdict = `Not a website prospect (minor): ${facts.map((f) => f.verdict).slice(0, 2).join(", ")}`;
  } else {
    pitch = "none";
    severity = 0;
    verdict = "Not a website prospect — decent, modern site";
    reasons.length = 0; // nothing to report — a decent site shouldn't carry stale filler as its headline
  }

  const phone = phoneSignals(place);
  if (limitedHours(place.hours)) reasons.unshift("after-hours calls go unanswered (closed evenings or weekends)");
  reasons.push(...phone.reasons.filter((r) => !reasons.includes(r)));
  const score = Math.min(100, severity + phone.score + (hasReceptionistGap ? 15 : 0));

  return { score, reasons: [verdict, ...dedupe(reasons)], pitch, severity, verdict };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function severityScore(severeCount: number, moderateCount: number, maybe: boolean): number {
  if (severeCount > 0) return Math.min(100, 60 + (severeCount - 1) * 15);
  if (maybe) return Math.min(55, 30 + moderateCount * 5);
  return 0;
}

/** Reviews/rating are directory-only signals (score-only, never [verified]) that nudge the call
 *  priority a little either way — kept separate from the strict redesign evidence above. */
function phoneSignals(place: ScoreInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (place.reviews !== null && place.reviews < 40) (score += 5), reasons.push(`there are only ${place.reviews} Google reviews`);
  if (place.rating !== null && place.rating < 4.2) (score += 5), reasons.push(`the Google rating is ${place.rating}`);
  return { score, reasons };
}

// A reason is "verified" when it's a fact this run actually observed on the business's own site
// (no website, unreachable, no HTTPS/SSL, not mobile-friendly, broken/5xx, abandoned, slow load,
// stale copyright, DIY builder, no online booking). Anything else (limited hours, review count,
// star rating) comes from the directory listing, not from looking at the site itself — real, but
// a directory signal, not a site problem seen firsthand.
const VERIFIED_SITE_FACT =
  /^(there's no website listed online|no website found \(checked|Redesign|the website is |the site isn't on HTTPS|the site has an SSL|the site isn't mobile-friendly|the page overflows horizontally|the site returns a server error|the homepage returned |clearly abandoned|there's no online booking|there's no way to book (?:a consult|an appraisal) online|the home page takes |the footer still says ©|the site is on a DIY builder)/i;

/** True if `reason` is a directly-observed site problem rather than a score-only inference
 *  (limited hours, review count, star rating — read from the directory listing, not the site). */
export function isVerifiedFact(reason: string): boolean {
  // issues.ts findings carry their own evidence: "<finding> — seen on <url> (<date>)".
  return VERIFIED_SITE_FACT.test(reason) || ISSUE_EVIDENCE.test(reason);
}

const ISSUE_EVIDENCE = / — seen on https?:\/\/\S+ \(\d{4}-\d{2}-\d{2}\)$/;
