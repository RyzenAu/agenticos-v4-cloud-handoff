// Stage 1 of the site-draft v2 pipeline: gather PUBLIC evidence only, and never write a claim
// into a draft that isn't traceable to a source URL here. Two sources, both already public and
// already used elsewhere in this repo:
//   1. The CRM row itself (name, suburb, phone, address) — sourced from Google Places or OSM
//      when the lead was captured (see scripts/leads/crm.ts's header comment).
//   2. The lead's own website, if it has one — via the existing polite fetchers in
//      scripts/leads/enrich.ts / site-audit.ts, which already check robots.txt and cap
//      themselves to a home page + one follow-up page.
// Nothing here calls a paid API (no fresh Google Places lookup), invents a service, or reads a
// review/rating claim as a fact to publish — see mu-business-evidence's SKILL.md: a source's own
// sales claim is not proof, and missing facts stay missing rather than being guessed.
import { extractBrandTokens, stylesheetUrls, type BrandTokens } from "./brand";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lead } from "../leads/crm";
import { enrichWebsite, robotsDisallowed } from "../leads/enrich";
import { publicUrl } from "../leads/site-audit";

export type EvidenceStatus = "verified" | "missing";

export type EvidenceFact = {
  category: "business" | "contact" | "location" | "service";
  field: string;
  value: string;
  sourceUrl: string;
  sourceLabel: string;
  observedAt: string;
  status: EvidenceStatus;
};

export type Evidence = {
  leadId: number;
  name: string;
  vertical: Lead["vertical"];
  area: string;
  generatedAt: string;
  facts: EvidenceFact[];
  services: EvidenceFact[];
  hasOwnWebsite: boolean;
  ownSiteReachable: boolean;
  robotsBlocked: boolean;
  /** Vertical-specific compliance reminders for the build step (e.g. AHPRA for dental). */
  complianceNotes: string[];
  /** The business's own brand colours/fonts/logo, read from its live home page (brand.ts). */
  brand?: BrandTokens | null;
};

const COMPLIANCE_NOTES: Record<Lead["vertical"], string[]> = {
  dental: [
    "AHPRA advertising rules apply: no patient testimonials, no before/after photos, no claims implying a guaranteed clinical outcome.",
  ],
  legal: [
    "No outcome guarantees or 'best/leading' superlatives that aren't independently verifiable.",
  ],
  "real-estate": [
    "No sold-price or appraisal claims for this business unless they appear on its own public site.",
  ],
};

/** Suburb/area first component, matching generate.ts's own convention. */
function suburbOf(area: string): string {
  return area.replace(/\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s*\d{0,4}$/i, "").trim() || area || "";
}

// Phrases that look like reviews, prices, or "trust me" marketing rather than a literal,
// citable service name — excluded even when they appear as list/heading text on the business's
// own site, so a testimonial or a price line never rides in disguised as a "service".
const NOT_A_SERVICE = /\$\d|\d+%\s*off|guarantee[ds]?\b|best in|award[- ]winning|(?:five|\d+)[\s-]*star|★|review/i;
const SERVICE_SECTION = /service|practice-area|practice_area|treatment|what-we-do|our-work/i;
const SERVICE_PATH_GUESSES: Record<Lead["vertical"], string[]> = {
  dental: ["/services", "/treatments", "/our-services", "/dental-services"],
  legal: ["/services", "/practice-areas", "/our-services", "/areas-of-practice"],
  "real-estate": ["/services", "/our-services", "/property-management", "/selling"],
};

/** Literal list-item / heading text pulled from a section that looks like a services listing.
 *  Never infers a service from copy elsewhere on the page — only text physically present under a
 *  heading/section whose own id, class or heading text names it as services/practice areas. */
export function extractServiceCandidates(html: string, cap = 8): string[] {
  const found: string[] = [];
  const sectionRe = /<(section|div)[^>]*(?:id|class)=["'][^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const headingRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  const candidateBlocks: string[] = [];
  for (const match of html.matchAll(sectionRe)) {
    const tagOpen = match[0].slice(0, match[0].indexOf(">"));
    if (SERVICE_SECTION.test(tagOpen)) candidateBlocks.push(match[2]);
  }
  // Also: a heading naming the section, followed by the next <ul>/<ol> or a run of <h3>s.
  for (const match of html.matchAll(headingRe)) {
    if (!SERVICE_SECTION.test(strip(match[1]))) continue;
    const after = html.slice(match.index! + match[0].length, match.index! + match[0].length + 4000);
    candidateBlocks.push(after);
  }

  for (const block of candidateBlocks) {
    const items = [
      ...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi),
      ...block.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi),
    ].map((m) => strip(m[1]));
    for (const item of items) {
      if (item.length < 3 || item.length > 70) continue;
      if (NOT_A_SERVICE.test(item)) continue;
      if (!found.includes(item)) found.push(item);
      if (found.length >= cap) return found;
    }
  }
  return found;
}

async function fetchServicesPage(
  homeUrl: URL,
  vertical: Lead["vertical"],
  request: typeof fetch,
): Promise<{ url: string; services: string[] } | null> {
  for (const path of SERVICE_PATH_GUESSES[vertical]) {
    const candidate = publicUrl(new URL(path, homeUrl).href);
    if (!candidate) continue;
    if (await robotsDisallowed(candidate, candidate.pathname, request)) continue;
    try {
      const res = await request(candidate.href, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MU-Ventures-LeadEngine/1.0; +https://muventures.com.au)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const services = extractServiceCandidates(html);
      if (services.length) return { url: candidate.href, services };
    } catch {
      // Politely give up on this guess and try the next.
    }
  }
  return null;
}

export async function gatherEvidence(
  lead: Lead,
  opts: { request?: typeof fetch; now?: Date } = {},
): Promise<Evidence> {
  const request = opts.request ?? fetch;
  const now = opts.now ?? new Date();
  const observedAt = now.toISOString();
  const suburb = suburbOf(lead.area);
  const sourceLabel = lead.source === "osm" ? "OpenStreetMap" : "Google Business listing";
  const sourceUrl = lead.mapsUrl || (lead.source === "osm" ? "https://www.openstreetmap.org/" : "https://www.google.com/maps");

  const facts: EvidenceFact[] = [];
  const push = (category: EvidenceFact["category"], field: string, value: string, url = sourceUrl, label = sourceLabel) => {
    facts.push({ category, field, value, sourceUrl: url, sourceLabel: label, observedAt, status: value ? "verified" : "missing" });
  };
  push("business", "name", lead.name);
  push("location", "suburb", suburb);
  push("location", "address", lead.address);
  push("contact", "phone", lead.phone);

  let hasOwnWebsite = false;
  let ownSiteReachable = false;
  let robotsBlocked = false;
  const services: EvidenceFact[] = [];
  let brand: BrandTokens | null = null;

  if (lead.website) {
    hasOwnWebsite = true;
    const enriched = await enrichWebsite(lead.website, request);
    robotsBlocked = enriched.robotsBlocked;
    ownSiteReachable = enriched.audit.reachable;
    if (enriched.audit.reachable) {
      const home = publicUrl(enriched.audit.finalUrl || lead.website);
      if (home && !robotsBlocked) {
        // Home page itself, in case the listing IS the services list (single-page sites).
        try {
          const res = await request(home.href, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; MU-Ventures-LeadEngine/1.0; +https://muventures.com.au)" },
            signal: AbortSignal.timeout(10_000),
          });
          const html = res.ok ? await res.text() : "";
          if (html) {
            // Brand tokens (colours, fonts, logo) from the page plus ONE first-party stylesheet.
            let css = "";
            const sheet = stylesheetUrls(html, home.href)[0];
            if (sheet) {
              try {
                const cssRes = await request(sheet, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MU-Ventures-LeadEngine/1.0; +https://muventures.com.au)" }, signal: AbortSignal.timeout(8_000) });
                if (cssRes.ok) css = (await cssRes.text()).slice(0, 400_000);
              } catch {
                /* best-effort only */
              }
            }
            brand = extractBrandTokens(html, home.href, css, observedAt);
          }
          const homeServices = extractServiceCandidates(html);
          for (const s of homeServices) {
            services.push({ category: "service", field: "service", value: s, sourceUrl: home.href, sourceLabel: "Business's own website", observedAt, status: "verified" });
          }
        } catch {
          /* best-effort only */
        }
        if (!services.length) {
          const found = await fetchServicesPage(home, lead.vertical, request);
          if (found) {
            for (const s of found.services) {
              services.push({ category: "service", field: "service", value: s, sourceUrl: found.url, sourceLabel: "Business's own website", observedAt, status: "verified" });
            }
          }
        }
      }
    }
  }

  const evidence: Evidence = {
    leadId: lead.id,
    name: lead.name,
    vertical: lead.vertical,
    area: lead.area,
    generatedAt: observedAt,
    facts,
    services: services.slice(0, 8),
    hasOwnWebsite,
    ownSiteReachable,
    robotsBlocked,
    complianceNotes: COMPLIANCE_NOTES[lead.vertical] ?? [],
    brand,
  };
  return evidence;
}

/** Facts a person read on the business's OWN current website (for sites the polite fetcher
 *  can't parse, e.g. JS-rendered pages), kept beside the draft as `own-site-facts.json`:
 *  { "sourceUrl": "...", "observedAt": "YYYY-MM-DD", "phone"?, "address"?, "suburb"?, "services"?: [] }.
 *  Each value must be copied from that page; it then outranks the directory listing. Ratings,
 *  client counts and years-in-business are deliberately not accepted here. */
export type OwnSiteFacts = { sourceUrl: string; observedAt?: string; phone?: string; address?: string; suburb?: string; services?: string[] };

export function applyOwnSiteFacts(evidence: Evidence, dir: string): Evidence {
  const path = join(dir, "own-site-facts.json");
  if (!existsSync(path)) return evidence;
  let own: OwnSiteFacts;
  try {
    own = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return evidence;
  }
  const url = publicUrl(own.sourceUrl ?? "");
  if (!url) return evidence;
  const observedAt = own.observedAt ? new Date(own.observedAt).toISOString() : evidence.generatedAt;
  const fact = (category: EvidenceFact["category"], field: string, value: string): EvidenceFact => ({ category, field, value, sourceUrl: url.href, sourceLabel: "Business's own website", observedAt, status: "verified" });
  const facts = evidence.facts.slice();
  for (const [field, category] of [["phone", "contact"], ["address", "location"], ["suburb", "location"]] as const) {
    const value = own[field]?.trim();
    if (!value) continue;
    const i = facts.findIndex((f) => f.field === field);
    if (i >= 0) facts[i] = fact(category, field, value);
    else facts.push(fact(category, field, value));
  }
  const services = evidence.services.length ? evidence.services : (own.services ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 8).map((s) => fact("service", "service", s));
  return { ...evidence, facts, services, hasOwnWebsite: true };
}

export function writeEvidence(dir: string, evidence: Evidence): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "evidence.json");
  writeFileSync(path, JSON.stringify(evidence, null, 2), "utf8");
  return path;
}
