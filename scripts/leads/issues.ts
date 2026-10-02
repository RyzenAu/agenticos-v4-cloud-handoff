// Evidence-backed issue detection per lead (25 Sep 2026, owner: "the leads almost always have
// websites and don't target actual issues"). The old pipeline pitched "website" whenever a
// directory had no URL, and its openers were a generic "your site isn't set up for phones" — which
// a hand check showed was often wrong: several top-50 "not mobile-friendly" leads were really an
// Incapsula or SiteGround bot wall that the plain fetch graded as if it were the homepage.
//
// This module looks at the lead's own site (reusing site-audit.ts's fetch rules and analyseHtml,
// challenge-page.ts, and crawl4ai.ts as a real-browser fallback) and records only issues it can
// point at: every Issue carries the URL it was seen on and a short quote of what was (or wasn't)
// there. Ranking and hooks are deterministic and never send lead data to a model.
//
// Nothing here sends, dials or emails. Writes go only to the CRM file the caller opened, and only
// when the caller asks (see saveIssueReport / applyIssueReport).
import type { Database } from "bun:sqlite";
import { isChallengePage } from "./challenge-page";
import { crawl4aiFetch, type Crawl4aiDeps } from "./crawl4ai";
import type { Lead } from "./crm";
import { leadArtifactCurrent } from "./edit";
import { NOT_A_WEBSITE } from "./discovery";
import type { Pitch } from "./score";
import { analyseHtml, publicUrl, statusPhrase } from "./site-audit";

export type Offer = "redesign" | "receptionist" | "both";
export type Severity = 1 | 2 | 3;

export type IssueCode =
  | "no_website" | "homepage_down" | "ssl_error" | "no_https" | "not_mobile" | "phone_only" | "no_booking"
  | "no_after_hours" | "slow_load" | "broken_links" | "no_cta" | "no_tap_to_call" | "stale_copyright"
  | "outdated_tech" | "dated_builder" | "seo_basics" | "weak_rating" | "few_reviews";

export type Issue = {
  code: IssueCode;
  /** Plain-English finding, as a founder would read it on the card. */
  finding: string;
  /** Terse label for a verdict line, e.g. "phone-only contact". */
  short: string;
  /** Spoken phrase that follows "I noticed …" in an opener. */
  say: string;
  evidence: { url: string; seen: string; source: "site" | "directory" };
  severity: Severity;
  offer: Offer;
};

export type IssueStatus = "ok" | "no_website_verified" | "no_website_unverified" | "unreachable" | "bot_protected" | "not_their_site";

export type IssueReport = {
  leadId: number;
  checkedAt: string;
  website: string;
  auditedUrl: string;
  /** How the audited HTML was obtained: our plain fetch, or a real-browser render (Crawl4AI). */
  via: "fetch" | "crawl4ai" | "none";
  status: IssueStatus;
  statusNote: string;
  issues: Issue[];
  /** Things the site already does well — used to push a modern, well-run site down the list. */
  strengths: string[];
  hook: string;
  hookSource: "mimo" | "rule" | "none";
  score: number;
  pitch: Pitch;
  verdict: string;
};

export const ISSUES_TASK = "leads-issue-targeting";
export const ISSUES_SPEND_CAP_USD = 1;
/** Our own clients — never prospected, whatever their status says. #32 Bianca Brown Realty. */
export const OWN_CLIENT_IDS = new Set([32]);
const NO_OUTREACH: string[] = ["won", "do_not_contact", "lost", "not_interested"];

/** True when a lead must never get an opener, call script or outreach rescoring. */
export function outreachBlocked(lead: Pick<Lead, "id" | "status" | "excluded">): string | null {
  if (OWN_CLIENT_IDS.has(lead.id)) return "our own client";
  if (lead.excluded) return "excluded";
  if (NO_OUTREACH.includes(lead.status)) return `status ${lead.status}`;
  return null;
}

// ── fetching ────────────────────────────────────────────────────────────────────────────────────

const USER_AGENT = "Mozilla/5.0 (compatible; MU-Ventures-SiteCheck/1.0; +https://muventures.com.au)";
const MAX_BYTES = 2 * 1024 * 1024;

type Page = { finalUrl: string; status: number; ok: boolean; html: string; ms: number };

async function getPage(href: string, request: typeof fetch, timeoutMs = 15_000): Promise<Page> {
  const started = performance.now();
  const response = await request(href, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let html = "";
  const reader = response.body?.getReader();
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
  return { finalUrl: response.url || href, status: response.status, ok: response.ok, html, ms: Math.round(performance.now() - started) };
}

function isSslError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } } | undefined)?.cause?.code ?? "";
  const message = String((error as Error)?.message ?? "");
  return /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate|ssl|tls handshake/i.test(message);
}

export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

/** A page with next to no readable text and no links is a JS shell, a redirect stub or a bot
 *  wall the fingerprint list doesn't know yet (SiteGround's sgcaptcha meta-refresh, Incapsula's
 *  resource loader) — never graded as the real site. */
export function isUnreadablePage(html: string): boolean {
  if (isChallengePage(html)) return true;
  if (/_Incapsula_Resource|\/\.well-known\/sgcaptcha\/|<meta[^>]+http-equiv=["']?refresh[^>]+captcha/i.test(html)) return true;
  const links = (html.match(/<a\b[^>]*href=/gi) ?? []).length;
  return visibleText(html).length < 200 && links < 3;
}

// ── HTML signals (on top of site-audit.ts's analyseHtml) ────────────────────────────────────────

export type Anchor = { href: string; text: string };

export function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!href) continue;
    out.push({ href: (href[1] ?? href[2] ?? href[3] ?? "").trim(), text: visibleText(m[2]).slice(0, 80) });
  }
  return out;
}

/** Any viewport meta at all, in any attribute order, quoted or not. analyseHtml's stricter check
 *  (name before content, width=device-width) misses real responsive sites; an issue is raised only
 *  when there's no viewport tag whatsoever. */
export function hasViewportMeta(html: string): boolean {
  return /<meta\b[^>]*\bname\s*=\s*["']?viewport\b/i.test(html);
}

const BOOKING_ENGINES: [RegExp, string][] = [
  [/hotdoc/i, "HotDoc"], [/healthengine/i, "HealthEngine"], [/cliniko/i, "Cliniko"], [/calendly/i, "Calendly"],
  [/centaurportal|d4w/i, "Centaur/D4W"], [/dentally/i, "Dentally"], [/corebook|coreplus/i, "Coreplus"], [/nookal/i, "Nookal"],
  [/halaxy/i, "Halaxy"], [/acuityscheduling/i, "Acuity"], [/simplybook/i, "SimplyBook"], [/setmore/i, "Setmore"],
  [/bookings\.gettimely|gettimely/i, "Timely"], [/appointuit|automed|healthkit/i, "online booking"],
  [/rex(?:software)?\.com|realestate\.com\.au\/.*apprais|appraisal-?request/i, "appraisal request"],
];
const BOOKING_LINK = /\b(book(?:ing)?s?\b|appointment|apprais|schedule a|request a (?:call|consult)|free consult)/i;
const BOOKING_HREF = /book|appointment|apprais|schedule|reserve/i;
const FORM_TELLS = /<form[\s\S]{0,6000}?(?:<textarea|type=["']?email|name=["'][^"']*(?:email|message|phone)[^"']*["'])|wpcf7|gform_wrapper|wpforms|ninja-forms|formidable|hs-form|hbspt\.forms|jotform|typeform|elementor-form|fluentform|forminator|wix-forms|sqs-block-form|formspree/i;
const CHAT_TELLS = /intercom|tawk\.to|livechat|drift\.com|crisp\.chat|tidio|hubspot.*conversations|podium|zendesk.*widget|olark|smartsupp|chatbot|messenger-?widget|livehelp/i;
const CTA_TEXT = /\b(book|call|contact|enquir|appointment|get in touch|quote|apprais|consult|schedule|request|make an? )/i;

export type PageSignals = {
  booking: { found: boolean; via: string };
  form: boolean;
  chat: boolean;
  telLink: boolean;
  phonesInText: string[];
  cta: boolean;
  viewport: boolean;
  title: string;
  metaDescription: boolean;
  generator: string;
};

export function pageSignals(html: string): PageSignals {
  const links = anchors(html);
  const engine = BOOKING_ENGINES.find(([p]) => p.test(html));
  const bookingLink = links.find((a) => (BOOKING_LINK.test(a.text) || BOOKING_HREF.test(a.href)) && !/^mailto:|^tel:/i.test(a.href) && !/blog|news|article/i.test(a.href));
  const buttonTexts = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => visibleText(m[1]));
  const facts = analyseHtml(html);
  return {
    booking: engine ? { found: true, via: engine[1] } : bookingLink ? { found: true, via: `"${bookingLink.text || bookingLink.href}" link` } : facts.onlineBooking ? { found: true, via: "booking wording" } : { found: false, via: "" },
    form: FORM_TELLS.test(html) || facts.contactForm,
    chat: CHAT_TELLS.test(html) || facts.chatWidget,
    telLink: /href\s*=\s*["']?tel:/i.test(html),
    phonesInText: facts.phones,
    cta: links.some((a) => CTA_TEXT.test(a.text) || /^tel:|^mailto:/i.test(a.href)) || buttonTexts.some((t) => CTA_TEXT.test(t)),
    viewport: hasViewportMeta(html),
    title: visibleText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    metaDescription: /<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*\bcontent\s*=\s*["'][^"']{10,}/i.test(html) ||
      /<meta\b[^>]*\bcontent\s*=\s*["'][^"']{10,}["'][^>]*\bname\s*=\s*["']?description/i.test(html),
    generator: html.match(/<meta\b[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']generator["']/i)?.[1] ?? "",
  };
}

/** Opening hours as the site itself states them — only the parts that matter for an after-hours
 *  pitch (a weekday close at or before 6 pm, or closed at the weekend). Returns the quoted snippet
 *  as evidence, or null when the page doesn't state hours this parser can read with confidence. */
export function statedHours(text: string): { snippet: string; closesEarly: boolean; closedWeekend: boolean } | null {
  const closedWeekend = text.match(/\b(sat(?:urday)?|sun(?:day)?)s?\b[^a-z0-9]{0,4}(?:[:\-–]\s*)?closed\b|\bclosed\s+(?:on\s+)?(?:sat(?:urday)?s?|sun(?:day)?s?|weekends?|public holidays? (?:and|&) (?:sun|weekends))\b/i);
  const weekday = text.match(/\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?)\b[^0-9]{0,24}?(\d{1,2})(?:[:.](\d{2}))?\s*(am|a\.m\.)?\s*(?:-|–|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pm|p\.m\.)/i);
  let closesEarly = false;
  if (weekday) {
    const close = Number(weekday[5]);
    closesEarly = close >= 1 && close <= 6;
  }
  if (!closedWeekend && !closesEarly) return null;
  const m = closesEarly ? weekday! : closedWeekend!;
  const at = m.index ?? 0;
  const start = Math.max(0, at - 10);
  let snippet = text.slice(start, at + m[0].length + 30).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = snippet.replace(/^\S*\s/, ""); // don't start mid-word
  return { snippet: snippet.slice(0, 140), closesEarly, closedWeekend: !!closedWeekend };
}

/** National portals, chain head offices and directory hosts: never "their own website". */
const PORTAL_HOSTS = /(?:^|\.)(?:domain\.com\.au|realestate\.com\.au|allhomes\.com\.au|rent\.com\.au|bupadental\.com\.au|bupa\.com\.au|pacificsmilesdental\.com\.au|nationaldentalcare\.com\.au|maven?dental\.com\.au|raywhite\.com|ljhooker\.com\.au|harcourts\.com\.au|mcgrath\.com\.au|firstnational\.com\.au|century21\.com\.au|prd\.com\.au|belleproperty\.com|wheree\.com|australianplanet\.com|legallink\.info|lawpath\.com\.au|healthengine\.com\.au|hotdoc\.com\.au|whitecoat\.com\.au)$/i;

export function isPortalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PORTAL_HOSTS.test(host) || NOT_A_WEBSITE.test(host);
}

// ── detection ───────────────────────────────────────────────────────────────────────────────────

export type DetectDeps = {
  request?: typeof fetch;
  now?: Date;
  /** Real-browser fallback for a bot wall / JS shell; pass false in tests. */
  crawl4ai?: Crawl4aiDeps | false;
  /** Check a sample of internal links for 404s (a few extra requests per lead). Default true. */
  checkLinks?: boolean;
  sleep?: (ms: number) => Promise<void>;
};

const SLOW_MS = 4_000;
const VERY_SLOW_MS = 7_000;

function site(url: string, seen: string): Issue["evidence"] {
  return { url, seen: seen.slice(0, 220), source: "site" };
}

const BOOK_WORD: Record<string, string> = { dental: "book an appointment", legal: "book a consult", "real-estate": "book an appraisal" };

export async function detectIssues(lead: Lead, deps: DetectDeps = {}): Promise<IssueReport> {
  const request = deps.request ?? fetch;
  const now = deps.now ?? new Date();
  const checkedAt = now.toISOString();
  const today = checkedAt.slice(0, 10);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base: IssueReport = {
    leadId: lead.id, checkedAt, website: lead.website, auditedUrl: "", via: "none", status: "ok", statusNote: "",
    issues: [], strengths: [], hook: "", hookSource: "none", score: 0, pitch: "audit_pending", verdict: "",
  };
  const directoryIssues = reviewIssues(lead);

  if (!lead.website) {
    // Only an explicit none-verified outcome (a real search engine answered and found nothing) may become a verified absence;
    // a check date alone proves nothing (older runs stamped it even when search was down).
    if (lead.websiteCheck === "none-verified") {
      const checked = (lead.websiteCheckedAt ?? checkedAt).slice(0, 10);
      return finalise({
        ...base, status: "no_website_verified", statusNote: `no website found by discovery (checked ${checked})`,
        issues: [{
          code: "no_website", finding: `No website found — search, directory and domain checks all came back empty (checked ${checked})`,
          short: "no website", say: `I couldn't find a website for ${lead.name || "you"} anywhere online`,
          evidence: { url: lead.mapsUrl || "", seen: `discovery checked ${checked}: no site found`, source: "directory" }, severity: 3, offer: "redesign",
        }, ...directoryIssues],
      }, lead);
    }
    return finalise({ ...base, status: "no_website_unverified", statusNote: "no website on file and nobody has looked for one yet — run rescan first" }, lead);
  }

  // Always the home page: discovery sometimes stored an inner page (a contact page, a booking
  // page, even a post-sitemap URL), and "the home page has no …" must be about the home page.
  const stored = publicUrl(lead.website);
  const url = stored ? publicUrl(new URL("/", stored).href) : null;
  if (!url) return finalise({ ...base, status: "unreachable", statusNote: "website on file isn't a public web address" }, lead);
  if (isPortalHost(url.hostname)) {
    return finalise({ ...base, status: "not_their_site", statusNote: `the website on file (${url.hostname}) is a portal, chain or directory page, not their own site` }, lead);
  }

  // 1. The home page, by plain fetch (same honest User-Agent and limits as site-audit.ts).
  let page: Page | null = null;
  let fetchError = "";
  try {
    page = await getPage(url.href, request);
  } catch (error) {
    fetchError = (error as Error).name === "TimeoutError" ? "timed out" : isSslError(error) ? "SSL error" : "unreachable";
  }
  const issues: Issue[] = [];
  const strengths: string[] = [];

  // A certificate failure is a real, visible problem (browsers show a full-page warning), but only
  // claimed once a second attempt fails the same way.
  if (fetchError === "SSL error") {
    let again = "";
    try {
      await getPage(url.href, request);
    } catch (error) {
      again = isSslError(error) ? "SSL error" : "other";
    }
    if (again === "SSL error") {
      issues.push({
        code: "ssl_error", finding: "Security certificate error: browsers show a full-page \"connection is not private\" warning",
        short: "certificate error", say: "your site's security certificate is failing, so browsers show a warning page before anyone gets in",
        evidence: site(url.href, `TLS/certificate error on two separate connections (${today})`), severity: 3, offer: "redesign",
      });
      return finalise({ ...base, auditedUrl: url.href, via: "fetch", issues: [...issues, ...directoryIssues] }, lead);
    }
  }

  if (page && page.status >= 500) {
    await sleep(30_000);
    const retry = await getPage(url.href, request).catch(() => null);
    if (!retry || retry.status >= 500) {
      issues.push({
        code: "homepage_down", finding: `The home page returned ${statusPhrase(page.status)} on two checks 30 seconds apart`,
        short: `homepage ${page.status}`, say: "your home page was showing a server error when I checked",
        evidence: site(url.href, `HTTP ${page.status} at ${checkedAt.slice(11, 16)} UTC and again on retry${retry ? ` (HTTP ${retry.status})` : ""}`),
        severity: 3, offer: "redesign",
      });
      return finalise({ ...base, auditedUrl: url.href, via: "fetch", issues: [...issues, ...directoryIssues] }, lead);
    }
    page = retry;
  }

  let html = page && page.ok ? page.html : "";
  let finalHref = page?.finalUrl || url.href;
  let via: IssueReport["via"] = "fetch";
  let loadMs: number | null = page && page.ok ? page.ms : null;

  // 2. A bot wall, JS shell, 4xx or network failure: try a real browser before judging anything.
  if (!html || isUnreadablePage(html)) {
    const blocked = !!html && isUnreadablePage(html);
    const rendered = deps.crawl4ai === false ? null : await crawl4aiFetch(url.href, deps.crawl4ai ?? {});
    if (rendered && rendered.html.trim() && !isUnreadablePage(rendered.html) && (rendered.statusCode === null || rendered.statusCode < 400)) {
      html = rendered.html;
      finalHref = rendered.finalUrl || url.href;
      via = "crawl4ai";
      loadMs = null; // a browser render time isn't comparable to the plain-fetch threshold
    } else if (fetchError === "SSL error" && rendered === null) {
      return finalise({ ...base, status: "unreachable", statusNote: `couldn't load their site (SSL error on our fetch; browser check unavailable) — checked ${today}` }, lead);
    } else {
      const why = blocked ? "bot-protected (a security check page, not their real site)" : page ? `HTTP ${page.status}` : fetchError || "unreachable";
      return finalise({ ...base, status: blocked ? "bot_protected" : "unreachable", statusNote: `couldn't see their real site: ${why} — checked ${today}` }, lead);
    }
  }

  const final = publicUrl(finalHref) ?? url;
  const signals = pageSignals(html);
  const facts = analyseHtml(html);
  const links = anchors(html);

  // 3. Contact page (booking/forms/hours often live there, not on the home page).
  let contactHtml = "";
  let contactUrl = "";
  const contactLink = links.find((a) => /contact|get-in-touch|enquir/i.test(a.href) || /^contact/i.test(a.text));
  if (contactLink && via === "fetch") {
    const target = safeUrl(contactLink.href, final);
    if (target && target.hostname === final.hostname && target.href !== final.href) {
      const contact = await getPage(target.href, request, 12_000).catch(() => null);
      if (contact?.ok && !isUnreadablePage(contact.html)) {
        contactHtml = contact.html;
        contactUrl = contact.finalUrl || target.href;
      }
    }
  }
  const contactSignals = contactHtml ? pageSignals(contactHtml) : null;
  const booking = signals.booking.found ? signals.booking : contactSignals?.booking.found ? contactSignals.booking : { found: false, via: "" };
  const form = signals.form || !!contactSignals?.form;
  const chat = signals.chat || !!contactSignals?.chat;
  const phones = [...new Set([...signals.phonesInText, ...(contactSignals?.phonesInText ?? [])])];
  const checkedPages = [final.href, contactUrl].filter(Boolean).join(" and ");
  const bookWord = BOOK_WORD[lead.vertical] ?? "book";

  if (booking.found) strengths.push(`online booking (${booking.via})`);
  if (chat) strengths.push("live chat");
  if (signals.viewport) strengths.push("mobile viewport set");
  if (final.protocol === "https:") strengths.push("HTTPS");
  if (facts.copyrightYear && facts.copyrightYear >= now.getFullYear() - 1) strengths.push(`© ${facts.copyrightYear}`);
  if (loadMs !== null && loadMs < 1_500) strengths.push(`fast load (${(loadMs / 1000).toFixed(1)} s)`);

  // Contact paths.
  const viaEmail = /href\s*=\s*["']?mailto:|mailto:/i.test(`${html} ${contactHtml}`);
  if (!booking.found && !form && (phones.length || signals.telLink)) {
    issues.push({
      code: "phone_only",
      finding: `${viaEmail ? "Phone or email only" : "Phone is the only way in"}: no online booking and no enquiry form on ${contactUrl ? "the home or contact page" : "the home page"}`,
      short: viaEmail ? "phone/email-only contact" : "phone-only contact",
      say: viaEmail
        ? `the only way to ${bookWord} from your website is to ring or email — there's no online booking or enquiry form`
        : `the only way to ${bookWord} from your website is to ring — there's no online booking or enquiry form`,
      evidence: site(checkedPages, `no booking widget/link and no enquiry <form> found; phone shown: ${phones[0] ?? "tap-to-call link"}${viaEmail ? "; email link present" : ""}`),
      severity: lead.vertical === "real-estate" ? 2 : 3, offer: "both",
    });
  } else if (!booking.found) {
    issues.push({
      code: "no_booking",
      finding: `No way to ${bookWord} online — only a phone number and an enquiry form`,
      short: "no online booking",
      say: `there's no way to ${bookWord} online — it's call or fill in a form and wait`,
      evidence: site(checkedPages, "enquiry form present, but no booking widget or booking link"),
      severity: lead.vertical === "real-estate" ? 1 : 2, offer: "both",
    });
  }

  // After hours: the site's own stated hours, with nothing to catch calls outside them.
  const hours = statedHours(visibleText(`${html} ${contactHtml}`));
  if (hours && !booking.found && !chat) {
    issues.push({
      code: "no_after_hours",
      finding: `Stated hours ${hours.closesEarly ? "finish by 6 pm" : "have the weekend closed"}, with no online booking or chat to catch calls outside them`,
      short: hours.closesEarly ? "closes by 6 pm, no after-hours option" : "closed weekends, no after-hours option",
      say: `your hours ${hours.closesEarly ? "finish around 5 or 6" : "have you closed on the weekend"}, and there's nothing on the site to catch people who call after that`,
      evidence: site(checkedPages, `hours on the page: "${hours.snippet}"`),
      severity: 2, offer: "receptionist",
    });
  }

  // Mobile.
  if (!signals.viewport) {
    issues.push({
      code: "not_mobile", finding: "Not set up for phones: the page has no viewport tag, so mobiles show a zoomed-out desktop page",
      short: "no mobile viewport", say: "your site shows the full desktop page shrunk down on a phone",
      evidence: site(final.href, `no <meta name="viewport"> in the page source${via === "crawl4ai" ? " (real-browser render)" : ""}`),
      severity: 3, offer: "redesign",
    });
  }

  // HTTPS: only claimed when https:// genuinely fails, not merely because a directory listed http://.
  if (final.protocol === "http:") {
    const https = new URL(final.href);
    https.protocol = "https:";
    let httpsWorks = false;
    let httpsNote = "";
    try {
      const probe = await getPage(https.href, request, 10_000);
      httpsWorks = probe.ok && !isUnreadablePage(probe.html);
      httpsNote = `https:// returned HTTP ${probe.status}`;
    } catch (error) {
      httpsNote = isSslError(error) ? "https:// failed with a certificate error" : "https:// didn't connect";
    }
    if (!httpsWorks) {
      issues.push({
        code: "no_https", finding: "No working HTTPS: browsers label the site \"Not secure\"",
        short: "not secure (no HTTPS)", say: "Chrome flags your site as \"Not secure\" because it has no working https",
        evidence: site(final.href, `site served over http://; ${httpsNote}`), severity: 3, offer: "redesign",
      });
    }
  }

  // Speed: measured twice, the faster read kept, so one slow moment isn't reported as a slow site.
  if (loadMs !== null && loadMs > SLOW_MS) {
    const again = await getPage(final.href, request).catch(() => null);
    const best = again?.ok ? Math.min(loadMs, again.ms) : loadMs;
    if (best > SLOW_MS) {
      const s = (best / 1000).toFixed(1);
      issues.push({
        code: "slow_load", finding: `Slow: the home page took ${s} s to download on the faster of two checks`,
        short: `${s} s load`, say: `your home page took about ${Math.round(best / 1000)} seconds to load when I checked`,
        evidence: site(final.href, `plain download ${(loadMs / 1000).toFixed(1)} s, then ${again?.ok ? (again.ms / 1000).toFixed(1) : "—"} s (Sydney, ${today})`),
        severity: best > VERY_SLOW_MS ? 3 : 2, offer: "redesign",
      });
    }
  }

  // Broken internal links.
  if (deps.checkLinks !== false && via === "fetch") {
    const broken = await brokenLinks(links, final, request);
    if (broken.checked > 0 && broken.broken.length) {
      issues.push({
        code: "broken_links", finding: `${broken.broken.length} of ${broken.checked} menu/page links checked are broken (404)`,
        short: `${broken.broken.length} broken link${broken.broken.length === 1 ? "" : "s"}`,
        say: `${broken.broken.length === 1 ? "one of the links" : "a few of the links"} on your site go${broken.broken.length === 1 ? "es" : ""} to a "page not found"`,
        evidence: site(final.href, `404: ${broken.broken.slice(0, 3).join(", ")}`), severity: broken.broken.length >= 2 ? 2 : 1, offer: "redesign",
      });
    }
  }

  // Calls to action.
  if (!signals.cta) {
    issues.push({
      code: "no_cta", finding: "No clear call to action on the home page — no Book, Call or Contact button or link",
      short: "no call to action", say: "there's no obvious Book or Call button on your home page",
      evidence: site(final.href, "no link or button text matching book/call/contact/enquire/appointment, and no tel:/mailto: link"),
      severity: 2, offer: "redesign",
    });
  } else if (phones.length && !signals.telLink && !contactSignals?.telLink) {
    issues.push({
      code: "no_tap_to_call", finding: `The phone number (${phones[0]}) isn't tap-to-call on mobile`,
      short: "phone not tap-to-call", say: "your phone number on the site isn't tap-to-call on a mobile",
      evidence: site(final.href, `number shown as text (${phones[0]}); no tel: link`), severity: 1, offer: "redesign",
    });
  }

  // Staleness.
  const year = now.getFullYear();
  if (facts.copyrightYear && facts.copyrightYear <= year - 3) {
    issues.push({
      code: "stale_copyright", finding: `The footer still says © ${facts.copyrightYear}`,
      short: `© ${facts.copyrightYear}`, say: `the footer still says ${facts.copyrightYear}, so it looks like the site hasn't been touched in a while`,
      evidence: site(final.href, `footer copyright year ${facts.copyrightYear}`), severity: facts.copyrightYear <= year - 5 ? 2 : 1, offer: "redesign",
    });
  }
  const oldTech = facts.outdatedTechSignals.filter((t) => t !== "nested table layout" || (facts.copyrightYear ?? year) <= year - 5);
  if (oldTech.length) {
    issues.push({
      code: "outdated_tech", finding: `Built on old technology: ${oldTech.join(", ")}`,
      short: oldTech[0], say: "the site's built on some fairly old technology",
      evidence: site(final.href, `found in page source: ${oldTech.join(", ")}`), severity: oldTech.some((t) => /Flash|frames/.test(t)) ? 2 : 1, offer: "redesign",
    });
  }
  const builder = datedBuilder(signals.generator, html);
  if (builder) {
    issues.push({
      code: "dated_builder", finding: `Running on ${builder.label}`, short: builder.label,
      say: `it's running on ${builder.label}`, evidence: site(final.href, builder.seen), severity: builder.severity, offer: "redesign",
    });
  }
  if (!signals.title || !signals.metaDescription) {
    const missing = [!signals.title && "page title", !signals.metaDescription && "meta description"].filter(Boolean).join(" or ");
    issues.push({
      code: "seo_basics", finding: `Google has little to show: the home page has no ${missing}`,
      short: `no ${missing}`, say: `your home page has no ${missing}, so Google makes one up`,
      evidence: site(final.href, `missing in <head>: ${missing}`), severity: 1, offer: "redesign",
    });
  }

  return finalise({ ...base, auditedUrl: final.href, via, issues: [...issues, ...directoryIssues], strengths }, lead);
}

function safeUrl(href: string, base: URL): URL | null {
  if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) return null;
  try {
    return publicUrl(new URL(href, base).href);
  } catch {
    return null;
  }
}

async function brokenLinks(links: Anchor[], base: URL, request: typeof fetch): Promise<{ checked: number; broken: string[] }> {
  const seen = new Set<string>();
  const targets: URL[] = [];
  for (const a of links) {
    const u = safeUrl(a.href, base);
    if (/['"+\[\]{}<>]|\$\{/.test(a.href)) continue; // a JS-built href, not a real link
    if (!u || u.hostname !== base.hostname) continue;
    if (/\.(?:pdf|jpe?g|png|gif|webp|svg|docx?|xlsx?|zip|mp4)$/i.test(u.pathname)) continue;
    u.hash = "";
    if (u.pathname === base.pathname || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    targets.push(u);
    if (targets.length >= 8) break;
  }
  const broken: string[] = [];
  let checked = 0;
  await Promise.all(targets.map(async (t) => {
    try {
      const r = await request(t.href, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
      checked++;
      if (r.status === 404 || r.status === 410) broken.push(t.pathname);
      await r.body?.cancel().catch(() => {});
    } catch {
      /* a timeout isn't evidence of a broken link */
    }
  }));
  return { checked, broken };
}

function datedBuilder(generator: string, html: string): { label: string; seen: string; severity: Severity } | null {
  const wp = generator.match(/WordPress\s+(\d+)\.(\d+)/i);
  if (wp && Number(wp[1]) < 5) return { label: `WordPress ${wp[1]}.${wp[2]} (years out of date)`, seen: `generator meta: "${generator}"`, severity: 2 };
  const joomla = generator.match(/Joomla!?\s*(\d+(?:\.\d+)?)/i);
  if (joomla && Number(joomla[1]) < 4) return { label: `Joomla ${joomla[1]} (end of life)`, seen: `generator meta: "${generator}"`, severity: 2 };
  if (/weebly/i.test(generator) || /editmysite\.com/i.test(html)) return { label: "a Weebly template", seen: "Weebly assets in the page source", severity: 1 };
  if (/Starfield Technologies|GoDaddy Website Builder/i.test(`${generator} ${html.slice(0, 20000)}`)) return { label: "GoDaddy's website builder", seen: "GoDaddy Website Builder markers in the page source", severity: 1 };
  if (/jimdo/i.test(generator)) return { label: "a Jimdo template", seen: `generator meta: "${generator}"`, severity: 1 };
  return null;
}

/** Directory signals — real, but from the listing, not the site; tagged source "directory". */
function reviewIssues(lead: Lead): Issue[] {
  const out: Issue[] = [];
  if (lead.rating !== null && lead.rating < 4.2 && (lead.reviews ?? 0) >= 5) {
    out.push({
      code: "weak_rating", finding: `Google rating is ${lead.rating} from ${lead.reviews} reviews`, short: `${lead.rating}★ rating`,
      say: `your Google rating is sitting at ${lead.rating}`, evidence: { url: lead.mapsUrl, seen: `listing: ${lead.rating}★, ${lead.reviews} reviews`, source: "directory" },
      severity: 1, offer: "both",
    });
  }
  return out;
}

// ── scoring and pitch ─────────────────────────────────────────────────────────────────────────────

const WEIGHT: Record<Severity, number> = { 3: 24, 2: 12, 1: 4 };
const RECEPTIONIST_CODES = new Set<IssueCode>(["phone_only", "no_booking", "no_after_hours"]);

/** Priority 0–100 from evidenced issues: fixable, high-value problems score; a modern site with
 *  nothing to fix is pushed to the bottom. Never claims more than the evidence. */
export function scoreIssues(report: Pick<IssueReport, "status" | "issues" | "strengths">, lead: Pick<Lead, "vertical" | "reviews">): { score: number; pitch: Pitch; verdict: string } {
  if (report.status === "no_website_verified") {
    // 25 Sep 2026: automatic search has repeatedly "confirmed" no website for practices that
    // plainly have one (search backend down, CAPTCHA, bot stubs, no suburb on file, wrong-country
    // namesakes). A no-website pitch now needs a 30-second human check first, so these rank high
    // in the audit queue instead of going straight to "you don't have a website" on a call.
    return { score: Math.min(100, 60 + (lead.vertical !== "real-estate" ? 10 : 0) + demand(lead)), pitch: "audit_pending", verdict: "No website found by automatic search: Google the name to confirm before pitching a new site" };
  }
  if (report.status !== "ok") {
    const label: Record<string, string> = {
      no_website_unverified: "Audit pending — no website on file, not yet checked",
      unreachable: "Audit pending — couldn't load their site",
      bot_protected: "Audit pending — bot-protected site",
      not_their_site: "Audit pending — website on file isn't theirs",
    };
    return { score: 0, pitch: "audit_pending", verdict: label[report.status] ?? "Audit pending" };
  }
  const siteIssues = report.issues;
  if (!siteIssues.length) return { score: 5, pitch: "none", verdict: "Nothing evidenced to fix — modern, working site" };

  const sum = (pred: (i: Issue) => boolean) => siteIssues.filter(pred).reduce((n, i) => n + WEIGHT[i.severity], 0);
  let score = Math.min(75, sum(() => true));
  const receptionistFit = siteIssues.some((i) => RECEPTIONIST_CODES.has(i.code) && i.severity >= 2);
  if (receptionistFit && lead.vertical !== "real-estate") score += 10;
  score += demand(lead);
  const maxSeverity = Math.max(...siteIssues.map((i) => i.severity));
  if (maxSeverity === 1) score = Math.min(score, 25);
  if (report.strengths.length >= 4 && maxSeverity < 3) score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const redesignW = siteIssues.filter((i) => i.offer === "redesign").reduce((n, i) => n + WEIGHT[i.severity], 0);
  const receptionW = siteIssues.filter((i) => i.offer !== "redesign").reduce((n, i) => n + WEIGHT[i.severity], 0);
  // Redesign only on real weight (a severe issue or several moderate ones), per the owner's
  // "they genuinely have to be really bad" bar; minor tidy-ups alone never make a redesign pitch.
  const redesignWorthy = redesignW >= 24;
  const receptionistWorthy = receptionW >= 12;
  const pitch: Pitch = redesignWorthy && receptionistWorthy ? "both" : redesignWorthy ? "redesign" : receptionistWorthy ? "receptionist" : "none";
  const label = pitch === "both" ? "Receptionist + redesign" : pitch === "redesign" ? "Redesign" : pitch === "receptionist" ? "Receptionist" : "Minor only";
  const top = [...siteIssues].sort((a, b) => b.severity - a.severity).slice(0, 3).map((i) => i.short);
  return { score: pitch === "none" ? Math.min(score, 20) : score, pitch, verdict: `${label}: ${top.join(", ")}` };
}

function demand(lead: Pick<Lead, "reviews">): number {
  if (lead.reviews === null) return 0;
  return lead.reviews >= 40 ? 10 : lead.reviews >= 15 ? 5 : 0;
}

function finalise(report: IssueReport, lead: Lead): IssueReport {
  const ordered = [...report.issues].sort((a, b) => b.severity - a.severity);
  const scored = scoreIssues({ ...report, issues: ordered }, lead);
  // Only a moderate or severe issue is worth opening a call with; a lone tidy-up isn't.
  const top = ordered[0] && ordered[0].severity >= 2 ? ordered[0] : null;
  return { ...report, issues: ordered, ...scored, hook: top ? top.say : "", hookSource: top ? "rule" : "none" };
}

// Deterministic ranking; the old paid provider path is disabled.
/** Compatibility counter for old batch callers. No provider calls or ledger access remain. */
export function issuesSpend(_ledgerFile?: string): number { return 0; }

const HYPE = /!|\b(guarantee|amazing|incredible|skyrocket|boost your|10x|revolution|game.?changer|losing (?:thousands|a fortune)|we (?:can|will)|our (?:team|agency))\b/i;

/** Accepts a model hook only when it reads as a plain observation built from the evidence: short,
 *  no hype, no promises, and no number that isn't already in the evidence. */
/** Words a hook must use to be about a given issue — so the model can't open with a minor
 *  tidy-up when a severe problem was found. */
const TOPIC: Partial<Record<IssueCode, RegExp>> = {
  phone_only: /\b(ring|call|phone|form|book)/i, no_booking: /\bbook/i, no_after_hours: /hours|after|weekend|evening|close/i,
  not_mobile: /phone|mobile|desktop|shrunk|zoom/i, no_https: /secure|https/i, ssl_error: /certificate|warning|secure/i,
  homepage_down: /error|down|50\d/i, slow_load: /second|slow|load/i, broken_links: /link|not found|404/i,
  no_cta: /button|book|call|contact/i, stale_copyright: /20\d\d|updated|touched/i, no_website: /website|online|site/i,
};
const PHONE_NUMBER = /(?:\+?61|\(?0\d\)?)[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{0,4}/;

export function acceptableHook(hook: string, report: IssueReport): boolean {
  const h = hook.trim();
  if (h.length < 20 || h.length > 220) return false;
  if (HYPE.test(h)) return false;
  if (PHONE_NUMBER.test(h)) return false; // never read a business its own number back
  const topic = report.issues[0] ? TOPIC[report.issues[0].code] : undefined;
  if (topic && !topic.test(h)) return false;
  const evidenceText = report.issues.map((i) => `${i.finding} ${i.evidence.seen} ${i.say}`).join(" ");
  for (const n of h.match(/\d+(?:\.\d+)?/g) ?? []) if (!evidenceText.includes(n)) return false;
  return true;
}

export type RankDeps = { root?: string; ledgerFile?: string; request?: typeof fetch; env?: NodeJS.ProcessEnv; cap?: number };

/** Local evidence-only ranking, with stable severity order and no outbound requests. */
export async function rankIssues(report: IssueReport, lead: Lead, _deps: RankDeps = {}): Promise<{ report: IssueReport; costUsd: number; skipped?: string }> {
  return { report: finalise(report, lead), costUsd: 0, skipped: "deterministic local ranking; no model used" };
}
/** @deprecated Compatibility alias for out-of-scope CLI/batch callers. Never calls MiMo. */
export const rankWithMimo = rankIssues;

// ── storage (only the CRM file the caller opened) ────────────────────────────────────────────────

function issuesTableExists(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lead_issues'").get();
}

export function ensureIssuesTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS lead_issues (
    lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
    checked_at TEXT NOT NULL,
    report TEXT NOT NULL
  )`);
}

/** The stored report, or null. Read-only: never creates the table, so a read against a CRM that
 *  hasn't had an issues pass yet changes nothing. */
export function readIssues(db: Database, leadId: number): IssueReport | null {
  if (!issuesTableExists(db)) return null;
  const row = db.query("SELECT report FROM lead_issues WHERE lead_id = ?").get(leadId) as { report: string } | null;
  if (!row) return null;
  try {
    const report = JSON.parse(row.report) as IssueReport;
    return leadArtifactCurrent(db, leadId, report.checkedAt, true) ? report : null;
  } catch {
    return null;
  }
}

/**
 * The stored report, with an unproven "no website" claim removed. A report that says no_website_verified is only believed while the
 * lead itself says none-verified; older reports were built from a bare check date. Otherwise the findings and the hook are dropped
 * (nothing is shown rather than a claim nobody proved) and the status reads no_website_unverified.
 */
export function trustedReport(report: IssueReport | null, lead: Pick<Lead, "websiteCheck">): IssueReport | null {
  if (!report || report.status !== "no_website_verified" || lead.websiteCheck === "none-verified") return report;
  return { ...report, status: "no_website_unverified", statusNote: "no website on file and no search has proved there isn't one", issues: [], hook: "", strengths: [] };
}
export function readTrustedIssues(db: Database, lead: Pick<Lead, "id" | "websiteCheck">): IssueReport | null {
  return trustedReport(readIssues(db, lead.id), lead);
}

/** The stored hook for an opener, or null when there's no report or the lead is off-limits. */
export function issueHook(db: Database, lead: Pick<Lead, "id" | "status" | "excluded"> & Partial<Pick<Lead, "websiteCheck">>): string | null {
  if (outreachBlocked(lead)) return null;
  return trustedReport(readIssues(db, lead.id), { websiteCheck: lead.websiteCheck ?? "not-checked" })?.hook || null;
}

/** Reasons in the CRM's existing shape: verdict first, then each finding with where it was seen.
 *  Site findings end "— seen on <url> (<date>)", which score.ts's isVerifiedFact recognises. */
export function issueReasons(report: IssueReport): string[] {
  const date = report.checkedAt.slice(0, 10);
  const lines = report.issues.map((i) =>
    i.evidence.source === "site" && i.evidence.url ? `${i.finding} — seen on ${i.evidence.url.split(" and ")[0]} (${date})` : `${i.finding} (${i.code === "no_website" ? "discovery" : "Google listing"})`,
  );
  if (report.status !== "ok" && report.status !== "no_website_verified") lines.push(report.statusNote);
  return [report.verdict, ...lines];
}

export function saveIssueReport(db: Database, report: IssueReport): void {
  ensureIssuesTable(db);
  db.query(`INSERT INTO lead_issues (lead_id, checked_at, report) VALUES ($id, $at, $report)
    ON CONFLICT(lead_id) DO UPDATE SET checked_at = excluded.checked_at, report = excluded.report`)
    .run({ $id: report.leadId, $at: report.checkedAt, $report: JSON.stringify(report) });
}

/** Saves the report and rescores the lead from it (score, pitch, reasons only — status, owner,
 *  follow-ups and history are never touched). Refuses off-limits leads. */
export function applyIssueReport(db: Database, lead: Lead, report: IssueReport): boolean {
  if (outreachBlocked(lead)) return false;
  db.transaction(() => {
    saveIssueReport(db, report);
    db.query("UPDATE leads SET score = $score, pitch = $pitch, reasons = $reasons WHERE id = $id")
      .run({ $score: report.score, $pitch: report.pitch, $reasons: JSON.stringify(issueReasons(report)), $id: lead.id });
  })();
  return true;
}

/** Top-N issues for a card: finding + evidence link. */
export function topIssues(report: IssueReport | null, n = 3) {
  return (report?.issues ?? []).slice(0, n).map((i) => ({
    code: i.code, finding: i.finding, severity: i.severity, offer: i.offer,
    url: i.evidence.url.split(" and ")[0], seen: i.evidence.seen, source: i.evidence.source,
  }));
}
