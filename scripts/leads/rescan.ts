// Re-run exclusion checks, website discovery, and scoring against leads already sitting in the
// CRM — the fix for the "OpenStreetMap lacks a website tag" bug (docs/LEAD-ENGINE.md): a lead
// added before discovery.ts/exclusions.ts existed keeps whatever wrong "no website" assumption it
// was given until this runs against it. Only website/score/pitch/reasons/exclusion fields change;
// status, owner, next_at, last_contact_at and activity history are never touched — the same
// columns `upsertLead`'s ON CONFLICT clause has always left alone.
import type { Database } from "bun:sqlite";
import { browserOverflowCheck, type BrowserAuditDeps } from "./browser-audit";
import type { Crawl4aiDeps } from "./crawl4ai";
import { listLeads, upsertLead, WEBSITE_NOT_VERIFIED, WEBSITE_NOT_VERIFIED_REASON, type Lead } from "./crm";
import { discoverWebsiteDetailed, localityFromAddress, type DiscoveryDeps } from "./discovery";
import { enrichWebsite, looksPersonal } from "./enrich";
import { checkExclusion } from "./exclusions";
import { scoreLead } from "./score";
import { EMPTY_SITE_AUDIT } from "./site-audit";

export type RescanAction = "excluded" | "website discovered" | "no website confirmed" | "rescored" | "site unverifiable" | "held for owner check";

export type RescanSnapshot = { website: string; score: number; pitch: string; excluded: boolean; topReason: string };

export type RescanChange = {
  leadId: number;
  name: string;
  before: RescanSnapshot;
  after: RescanSnapshot;
  action: RescanAction;
  /** NEW 25 Sep 2026 — from scoreLead's own `severity`/`verdict` (score.ts), not persisted to the
   *  CRM schema (out of scope for this pass): 0 for an excluded lead, since it was never scored. */
  severity: number;
  verdict: string;
};

export type RescanSummary = {
  total: number;
  excluded: number;
  hadRealWebsiteAlready: number;
  websiteDiscovered: number;
  confirmedNoWebsite: number;
  changes: RescanChange[];
  /** NEW 25 Sep 2026 — a lead's final pitch, counted (excludes excluded leads). */
  byPitch: Record<string, number>;
};

function snapshot(lead: { website: string; score: number; pitch: string; excluded: boolean; reasons: string[] }): RescanSnapshot {
  return { website: lead.website, score: lead.score, pitch: lead.pitch, excluded: lead.excluded, topReason: lead.reasons[0] ?? "" };
}

/** Re-checks and re-scores one existing lead in place. Never deletes it — an excluded lead is
 *  marked `excluded: true` with a reason, not removed. */
export async function rescanLead(
  db: Database,
  lead: Lead,
  opts: {
    request?: typeof fetch; discovery?: DiscoveryDeps; browserRetry?: BrowserAuditDeps | false; crawl4ai?: Crawl4aiDeps | false;
    /** 25 Sep 2026: computes and returns what WOULD change (discovery + scoring run for real)
     *  without writing anything to the CRM — for the precision sample the second verification
     *  bugfix needed before trusting a full sweep. `db` is still read (findLead-adjacent lookups
     *  elsewhere aren't affected) but never written to for this lead. */
    dryRun?: boolean;
  } = {},
): Promise<RescanChange> {
  const request = opts.request ?? fetch;
  // A one-off data-quality pass, unlike the nightly `find` cron, is worth the extra time a real
  // browser retry costs — on by default here (pass `browserRetry: false` to skip it, e.g. tests).
  const browserRetry = opts.browserRetry ?? {};
  // Same reasoning, same default-on/opt-out-in-tests convention — see enrich.ts/crawl4ai.ts.
  const crawl4ai = opts.crawl4ai ?? {};
  const dryRun = opts.dryRun === true;
  const before = snapshot(lead);

  const exclusion = checkExclusion({ name: lead.name });
  if (exclusion.excluded) {
    const after = dryRun
      ? snapshot({ website: lead.website, score: 0, pitch: lead.pitch, excluded: true, reasons: [`excluded: ${exclusion.reason}`] })
      : snapshot(upsertLead(db, {
          placeId: lead.placeId, vertical: lead.vertical, area: lead.area, name: lead.name, phone: lead.phone,
          address: lead.address, website: lead.website, mapsUrl: lead.mapsUrl, rating: lead.rating, reviews: lead.reviews,
          emails: lead.emails, emailOk: false, score: 0, pitch: lead.pitch, reasons: [`excluded: ${exclusion.reason}`],
          googleAt: lead.googleAt, source: lead.source, attribution: lead.attribution,
          excluded: true, excludedReason: exclusion.reason,
          websiteSource: lead.websiteSource, websiteConfidence: lead.websiteConfidence, websiteCheckedAt: lead.websiteCheckedAt,
        }));
    return { leadId: lead.id, name: lead.name, before, after, action: "excluded", severity: 0, verdict: `Excluded: ${exclusion.reason}` };
  }

  // 25 Sep 2026 bugfix: this used to be `lead.area.replace(/\s*,?\s*NSW$/i, "").trim()` — `area` is
  // the broad hunt-region label ("Greater Sydney" for 800 of 963 leads on file), not a suburb, so
  // pageMatchesBusiness's suburb check was silently failing almost every time regardless of
  // whether the candidate site was actually correct. localityFromAddress parses the real suburb
  // (and postcode) from the lead's own street address instead.
  const { suburb, postcode } = localityFromAddress(lead.address);
  let finalUrl = lead.website;
  let websiteSource = lead.websiteSource || (lead.website ? "osm_tag" : "");
  let websiteConfidence = lead.websiteConfidence;
  let websiteCheckedAt = lead.websiteCheckedAt;
  let discoveredNow = false;
  // undefined = not attempted / no unverifiable outcome; a real (possibly "") string once
  // discoverWebsiteDetailed reports "unverifiable" — "" itself is a valid case (a franchise-brand
  // short-circuit never had a URL to name), so this can't be a plain truthy check.
  let unverifiable: { url: string; reason?: string } | undefined;

  // A website a founder has to confirm by hand (fix-wrong-website.ts: discovery once attached the
  // wrong organisation's site) is never re-guessed automatically — the same guess would come back.
  if (!finalUrl && lead.websiteSource === WEBSITE_NOT_VERIFIED) {
    return { leadId: lead.id, name: lead.name, before, after: before, action: "held for owner check", severity: 0, verdict: `Audit pending — ${WEBSITE_NOT_VERIFIED_REASON}` };
  }

  if (!finalUrl) {
    websiteCheckedAt = new Date().toISOString();
    const outcome = await discoverWebsiteDetailed(
      { name: lead.name, suburb, postcode, vertical: lead.vertical, phone: lead.phone, address: lead.address },
      { request, ...opts.discovery },
    );
    if (outcome.kind === "found") {
      finalUrl = outcome.site.url;
      websiteSource = `discovered_${outcome.site.source}`;
      websiteConfidence = outcome.site.confidence;
      discoveredNow = true;
    } else if (outcome.kind === "unverifiable") {
      unverifiable = { url: outcome.url, reason: outcome.reason };
    }
  }

  // A candidate site exists but couldn't be checked (blocked/erroring, or a franchise brand with
  // no suburb on file to disambiguate — see discovery.ts's verifyCandidate/FRANCHISE_BRANDS) —
  // genuinely unknown, so this stays `audit_pending` rather than either a confirmed website or a
  // confirmed "no website found", and skips the full site audit entirely since there's nothing
  // confirmed yet to audit.
  if (unverifiable) {
    const today = new Date().toISOString().slice(0, 10);
    const reason = `${unverifiable.reason ?? "site found but unverifiable"} (checked ${today})`;
    const after = dryRun
      ? snapshot({ website: "", score: 0, pitch: "audit_pending", excluded: false, reasons: [reason] })
      : snapshot(upsertLead(db, {
          placeId: lead.placeId, vertical: lead.vertical, area: lead.area, name: lead.name, phone: lead.phone,
          address: lead.address, website: "", mapsUrl: lead.mapsUrl, rating: lead.rating, reviews: lead.reviews,
          emails: lead.emails, emailOk: false, score: 0, pitch: "audit_pending", reasons: [reason],
          googleAt: lead.googleAt, source: lead.source, attribution: lead.attribution,
          excluded: false, excludedReason: "", websiteSource, websiteConfidence, websiteCheckedAt,
        }));
    return {
      leadId: lead.id, name: lead.name, before, after, action: "site unverifiable",
      severity: 0, verdict: `Audit pending — ${reason}`,
    };
  }

  let audit = EMPTY_SITE_AUDIT;
  const emails = new Set<string>(lead.emails);
  if (finalUrl) {
    const result = await enrichWebsite(finalUrl, request, browserRetry, crawl4ai);
    audit = result.audit;
    finalUrl = audit.finalUrl || finalUrl;
    for (const e of result.emails) emails.add(e.value);
    // The strict redesign bar (score.ts) needs a real, rendered 390px-mobile check — a plain
    // fetch (or the browser retry above, which only runs when the plain fetch failed) doesn't
    // always have it yet. A site whose plain fetch already succeeded still gets this one signal.
    if (audit.reachable && audit.overflowAt390 === null && browserRetry !== false) {
      const overflowAt390 = await browserOverflowCheck(finalUrl, browserRetry);
      if (overflowAt390 !== null) audit = { ...audit, overflowAt390 };
    }
  }
  const usableEmails = [...emails].filter((e) => !looksPersonal(e));
  const scored = scoreLead(
    { website: finalUrl, rating: lead.rating, reviews: lead.reviews, hours: [], noWebsiteCheckedAt: finalUrl ? null : websiteCheckedAt },
    audit,
    lead.vertical,
  );
  const after = dryRun
    ? snapshot({ website: finalUrl, score: scored.score, pitch: scored.pitch, excluded: false, reasons: scored.reasons })
    : snapshot(upsertLead(db, {
        placeId: lead.placeId, vertical: lead.vertical, area: lead.area, name: lead.name, phone: lead.phone,
        address: lead.address, website: finalUrl, mapsUrl: lead.mapsUrl, rating: lead.rating, reviews: lead.reviews,
        emails: usableEmails, emailOk: usableEmails.length > 0 && !audit.noUnsolicited, score: scored.score, pitch: scored.pitch,
        reasons: scored.reasons, googleAt: lead.googleAt, source: lead.source, attribution: lead.attribution,
        excluded: false, excludedReason: "", websiteSource, websiteConfidence, websiteCheckedAt,
      }));
  const action: RescanAction = discoveredNow ? "website discovered" : finalUrl ? "rescored" : "no website confirmed";
  return { leadId: lead.id, name: lead.name, before, after, action, severity: scored.severity, verdict: scored.verdict };
}

/** Re-runs every open lead in the CRM (won/lost/do_not_contact excluded by default — a deal
 *  already closed shouldn't have its history rewritten by a data-quality fix). */
export async function rescanAll(
  db: Database,
  opts: { request?: typeof fetch; discovery?: DiscoveryDeps; browserRetry?: BrowserAuditDeps | false; crawl4ai?: Crawl4aiDeps | false; includeClosed?: boolean } = {},
): Promise<RescanSummary> {
  const CLOSED = new Set(["won", "lost", "not_interested", "do_not_contact"]);
  const leads = listLeads(db, { limit: 500, includeExcluded: true }).filter((l) => opts.includeClosed || !CLOSED.has(l.status));
  const changes: RescanChange[] = [];
  for (const lead of leads) changes.push(await rescanLead(db, lead, opts));
  const byPitch: Record<string, number> = {};
  for (const c of changes) if (c.action !== "excluded") byPitch[c.after.pitch] = (byPitch[c.after.pitch] ?? 0) + 1;
  return {
    total: changes.length,
    excluded: changes.filter((c) => c.action === "excluded").length,
    hadRealWebsiteAlready: changes.filter((c) => c.action !== "excluded" && c.before.website).length,
    websiteDiscovered: changes.filter((c) => c.action === "website discovered").length,
    confirmedNoWebsite: changes.filter((c) => c.action === "no website confirmed").length,
    changes,
    byPitch,
  };
}

export function renderRescanSummary(summary: RescanSummary): string {
  const top10 = [...summary.changes]
    .filter((c) => c.action !== "excluded")
    .sort((a, b) => b.after.score - a.after.score)
    .slice(0, 10);
  const lines = [
    `Rescanned ${summary.total} lead(s): ${summary.hadRealWebsiteAlready} already had a real website, ` +
      `${summary.websiteDiscovered} website(s) found by discovery, ${summary.confirmedNoWebsite} confirmed genuinely without one, ` +
      `${summary.excluded} excluded (gov/legal aid/non-profit/chain).`,
    `By pitch: ${Object.entries(summary.byPitch).map(([p, n]) => `${p} ${n}`).join(", ") || "none"}.`,
    "",
    "Top 10 (by score) with verdicts:",
    ...top10.map((c, i) => `  ${i + 1}. #${c.leadId} ${c.name} — score ${c.after.score}, severity ${c.severity} — ${c.verdict}`),
    "",
    "Changes:",
    ...summary.changes
      .filter((c) => c.before.website !== c.after.website || c.before.pitch !== c.after.pitch || c.before.excluded !== c.after.excluded || c.before.score !== c.after.score)
      .map((c) => `  #${c.leadId} ${c.name}: ${c.action} — website "${c.before.website || "(none)"}" → "${c.after.website || "(none)"}", ` +
        `score ${c.before.score} → ${c.after.score}, pitch ${c.before.pitch} → ${c.after.pitch}${c.after.excluded ? " [EXCLUDED]" : ""}`),
  ];
  return lines.join("\n");
}
