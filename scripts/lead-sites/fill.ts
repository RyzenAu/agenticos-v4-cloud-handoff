// Fills one vertical's template (templates.ts) for ONE lead, from verified evidence only, and adds
// the non-negotiable preview safeguards. Pure functions — no network, no disk — so every rule here
// is unit-tested (fill.test.ts).
//
// Facts come from scripts/site-draft/evidence.ts (the CRM row + the business's own website, each
// with a source URL). A field with no verified value gets a neutral placeholder ("to be
// confirmed"), never a guess. Staff, reviews, awards, prices and unlisted services never appear:
// the templates have no slot for them, and fill refuses output that the site-draft claims audit
// flags anyway.
import type { Evidence } from "../site-draft/evidence";
import type { Vertical } from "./templates";

export const PREVIEW_DAYS = 30;
export const PREVIEW_ZONE = "muventures.com.au";

export type PreviewService = { name: string; sourceUrl: string };
export type PreviewFacts = {
  business: string;
  suburb: string;
  /** One line, as published. Empty when neither the listing nor the site gave one. */
  address: string;
  phone: string;
  email: string;
  website: string;
  services: PreviewService[];
  /** Where each filled value came from, for PREVIEW.md and the drawer. */
  sources: { field: string; value: string; sourceUrl: string; sourceLabel: string }[];
};

/** "St Clair Dental" → "st-clair-dental" (same rule as site-draft's slugify, capped for a DNS label). */
export function previewSlug(name: string, id: number): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || `lead-${id}`;
}

export function previewDomain(slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) throw new Error(`"${slug}" isn't a valid subdomain label.`);
  return `${slug}.${PREVIEW_ZONE}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The number a "Call" link may dial, or "" when it can't be read as exactly one Australian number.
 *  Cuts an extension ("ext. 7", "x12") and a trailing note in brackets ("(a/h)"), drops the bracketed
 *  trunk zero after +61, strips punctuation, and accepts only a complete Australian pattern. A string
 *  holding two numbers, words, or a number we can't place is never guessed at: the page shows the text and no link.
 *  One exception, chosen on purpose: a bracketed note at the end ("(after hours 0412 345 678)", "(a/h)") is not part of the number. The first
 *  complete number is linked and the page keeps showing the full text as supplied, so the note and any second number stay readable as plain text. */
export function telHref(phone: string): string {
  let s = phone.trim();
  s = s.replace(/^(?:ph(?:one)?|tel(?:ephone)?|mob(?:ile)?|call|t|p|m)\s*[:.]\s*/i, "");
  s = s.replace(/\s*(?:\bext(?:ension|n)?\b\.?|\bx)\s*\d+\s*$/i, "");
  s = s.replace(/\s*\([^)]*[a-z][^)]*\)\s*$/i, "");
  s = s.replace(/^(\+\s*61[\s-]*)\(\s*0\s*\)/, "$1");
  if (/[a-z]/i.test(s) || /[\/,;&]/.test(s) || /\+.*\+/.test(s)) return "";
  const digits = s.replace(/[^\d+]/g, "");
  if (/^\+61[2-478]\d{8}$/.test(digits)) return `tel:${digits}`;
  if (/^0[2-478]\d{8}$/.test(digits)) return `tel:+61${digits.slice(1)}`;
  if (/^(?:13\d{4}|1[38]00\d{6})$/.test(digits)) return `tel:${digits}`;
  return "";
}

/** A mailto: link only for something that is plainly one email address. */
export function mailtoHref(email: string): string {
  const e = email.trim().replace(/^mailto:/i, "");
  // No query string or fragment (a "?bcc=" would add a hidden recipient), no escapes, no header characters, no second address.
  const bad = `\\s@<>"',;()?#%&=\\\\/:`;
  return new RegExp(`^[^${bad}]+@[^${bad}]+\\.[^${bad}.]{2,}$`).test(e) ? `mailto:${e}` : "";
}

export function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Only the verified facts in evidence.json (plus the business's own published email). */
export function factsFromEvidence(evidence: Evidence, lead: { website: string; emails: string[]; emailOk: boolean }): PreviewFacts {
  const verified = (field: string) => evidence.facts.find((f) => f.field === field && f.status === "verified" && f.value.trim());
  const name = verified("name");
  const suburb = verified("suburb");
  const address = verified("address");
  const phone = verified("phone");
  const sources: PreviewFacts["sources"] = [];
  for (const f of [name, suburb, address, phone]) if (f) sources.push({ field: f.field, value: f.value, sourceUrl: f.sourceUrl, sourceLabel: f.sourceLabel });
  const services = evidence.services
    .filter((s) => s.status === "verified" && s.value.trim())
    .map((s) => ({ name: s.value.trim(), sourceUrl: s.sourceUrl }));
  for (const s of services) sources.push({ field: "service", value: s.name, sourceUrl: s.sourceUrl, sourceLabel: "Business's own website" });
  // An email counts only if the business published it on its own site (enrich.ts) and hasn't opted out.
  // With no website on file there is no own site to have published it, so a CRM email of unknown origin is never labelled as one.
  const email = lead.emailOk && lead.website.trim() && lead.emails[0] ? lead.emails[0] : "";
  if (email) sources.push({ field: "email", value: email, sourceUrl: lead.website, sourceLabel: "Business's own website" });
  return {
    business: (name?.value ?? evidence.name).trim(),
    suburb: (suburb?.value ?? "").trim(),
    address: (address?.value ?? "").trim(),
    phone: (phone?.value ?? "").trim(),
    email,
    website: lead.website,
    services,
    sources,
  };
}

const CONTACT_ANCHOR: Record<Vertical, string> = { legal: "#visit", dental: "/#find-us", "real-estate": "/contact" };
const SERVICE_WORD: Record<Vertical, { listed: string; none: string }> = {
  legal: { listed: "Areas of practice listed by", none: "Areas of practice to be confirmed" },
  dental: { listed: "Treatments listed by", none: "Treatments to be confirmed" },
  "real-estate": { listed: "Services listed by", none: "Services to be confirmed" },
};
/** The count line's noun ("6 treatments listed"), singular and plural. */
const SERVICE_NOUN: Record<Vertical, [string, string]> = {
  dental: ["treatment", "treatments"],
  legal: ["area of practice", "areas of practice"],
  "real-estate": ["service", "services"],
};
const ADVICE_NOTE: Record<Vertical, string> = {
  legal: " Nothing here is legal advice.",
  dental: " Nothing here is clinical advice.",
  "real-estate": "",
};

/** "Harbour Lawyers" → "Harbour Lawyers’", "Smile Dental" → "Smile Dental’s". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

export function bannerText(business: string): string {
  return `Preview concept prepared by M&U Ventures for ${business}. Not the official ${business} website.`;
}

/** Every text token, already HTML-escaped. */
export function tokensFor(facts: PreviewFacts, vertical: Vertical, observedOn: string): Record<string, string> {
  return Object.fromEntries(Object.entries(tokenValues(facts, vertical, observedOn)).map(([k, v]) => [k, escapeHtml(v)]));
}

const TAGLINE: Record<Vertical, string> = { dental: "Dental care in", legal: "Legal help in", "real-estate": "Real estate in" };

/** Every token's plain-text value (unescaped). */
export function tokenValues(facts: PreviewFacts, vertical: Vertical, observedOn: string): Record<string, string> {
  const b = facts.business || "this business";
  const host = hostOf(facts.website);
  const suburb = facts.suburb || "your area";
  const address = facts.address || (facts.suburb ? `${facts.suburb} (street address to be confirmed)` : "Address to be confirmed");
  const street = facts.address ? facts.address.split(",")[0].trim() : suburb;
  const words = SERVICE_WORD[vertical];
  const t: Record<string, string> = {
    BANNER: bannerText(b),
    TITLE: `${b} — preview concept by M&U Ventures (not the official website)`,
    BUSINESS: b,
    BUSINESS_POSS: possessive(b),
    SUBURB: suburb,
    ADDRESS: address,
    STREET: street,
    PHONE: facts.phone || "Phone to be confirmed",
    PHONE_HREF: telHref(facts.phone) || CONTACT_ANCHOR[vertical],
    HOURS: `Opening hours to be confirmed with ${b}.`,
    SERVICES_LABEL: facts.services.length ? `${words.listed} ${b}` : words.none,
    SERVICES_NOTE: facts.services.length
      ? `As published on ${host || "the business’s own website"} (checked ${observedOn}). Nothing is listed here that ${b} hasn’t published.`
      : `This preview lists no services ${b} hasn’t published itself. They would come from the practice.`,
    DISCLAIMER:
      `${bannerText(b)} It is not affiliated with or endorsed by ${b}. Business details come from ${possessive(b)} public listing` +
      `${host ? ` and ${host}` : ""}; imagery is illustrative and AI-generated.${ADVICE_NOTE[vertical]}`,
    TAGLINE: `${TAGLINE[vertical]} ${suburb}`,
    ADDRESS_LINE1: facts.address ? street : "Street address to be confirmed",
    ADDRESS_LINE2: facts.address ? facts.address.split(",").slice(1).join(",").trim() || suburb : suburb,
    EMAIL: facts.email || "Email to be confirmed",
    EMAIL_HREF: mailtoHref(facts.email) || CONTACT_ANCHOR[vertical],
    // The count line's number (motion.ts counts it up; fill-time CSS hides the line at zero).
    SERVICES_COUNT: String(facts.services.length),
    SERVICES_NOUN: SERVICE_NOUN[vertical][facts.services.length === 1 ? 0 : 1],
  };
  return t;
}

/** Raw-HTML tokens (already built from escaped parts). */
function rawTokens(facts: PreviewFacts): Record<string, string> {
  const email = escapeHtml(facts.email);
  const plain = Boolean(mailtoHref(facts.email));
  return {
    EMAIL_BUTTON: plain ? `<a class="btn btn--outline btn--lg" href="mailto:${email}">Email ${email}</a>` : "",
    EMAIL_LINE: plain ? `<br/><a href="mailto:${email}">${email}</a>` : "",
    EMAIL_PARA: plain ? `<p><a href="mailto:${email}">${email}</a></p>` : "",
  };
}

/** The services list items, verified or one neutral "to be confirmed" row. */
export function serviceItems(facts: PreviewFacts, business: string): { name: string; note: string }[] {
  const host = hostOf(facts.website);
  return facts.services.length
    ? facts.services.map((s) => ({ name: s.name, note: `Listed on ${hostOf(s.sourceUrl) || host || "their website"}` }))
    : [{ name: `To be confirmed with ${business}`, note: "Nothing is listed that the business hasn’t published." }];
}

/** A value that is safe raw inside HTML text/attributes, a JS string literal AND the JSON-in-JS
 *  RSC payload of a Next export: no quotes, backslashes, angle brackets, braces or control
 *  characters (apostrophes become ’). */
export function exportSafe(value: string): string {
  return value
    .replace(/'/g, "’")
    .replace(/"/g, (_m, at: number, whole: string) => (at === 0 || /[\s(\[—–-]/.test(whole[at - 1]) ? "“" : "”"))
    .replace(/[\\`<>{}\u0000-\u001f\u2028\u2029]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Replaces {{TOKENS}} in one file of a Next export (HTML, RSC .txt or JS chunk). */
export function fillExportText(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => (k in values ? exportSafe(values[k]) : m));
}

/** Adds the preview data, the safeguards and the template's banner-offset CSS to one HTML page. */
export function finishExportHtml(html: string, facts: PreviewFacts, business: string, templateHead: string, expiresAt: string, extra: { listings?: unknown[] } = {}): string {
  const data = JSON.stringify({ services: serviceItems(facts, business).map((s) => ({ name: exportSafe(s.name), note: exportSafe(s.note) })), ...(extra.listings ? { listings: { items: extra.listings } } : {}) })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const head = `<script id="mu-preview-data" type="application/json">${data}</script>${templateHead}${safeguardHead()}`;
  let out = html.replace(/<meta name="robots"[^>]*>/gi, "");
  // A bare "&" in a name (Smith & Co) is invalid in a <title>: some scrapers and link previews cut the title at it.
  out = out.replace(/<title>([\s\S]*?)<\/title>/i, (_m, t: string) => `<title>${t.replace(/&(?!(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);)/gi, "&amp;")}</title>`);
  out = out.replace("</head>", `${head}</head>`);
  // The banner is rendered by the template's own React tree (PreviewBanner.tsx), so hydration
  // keeps it; this <head> script (outside React) adds the expiry, height offset and form block.
  out = out.replace("</head>", `<script>document.addEventListener("DOMContentLoaded",function(){${safeguardJs(business)}});</script></head>`);
  if (!out.includes(`data-mu-expires="${expiresAt}"`)) throw new Error("The page's preview banner is missing its expiry.");
  if (!out.includes("mu-preview-banner") || !out.includes("mu-preview-data")) throw new Error("Couldn't add the preview safeguards to the page.");
  return out;
}

/** Renders every <!--MU:REPEAT-->…<!--/MU:REPEAT--> block once per verified service. */
export function renderRepeats(html: string, facts: PreviewFacts, business: string): string {
  const items = serviceItems(facts, business);
  return html.replace(/<!--MU:REPEAT-->([\s\S]*?)<!--\/MU:REPEAT-->/g, (_, item: string) =>
    items
      .map((it, i) => item.replace(/\{\{SVC_NAME\}\}/g, escapeHtml(it.name)).replace(/\{\{SVC_NOTE\}\}/g, escapeHtml(it.note)).replace(/\{\{SVC_I\}\}/g, String(i)))
      .join(""),
  );
}

export const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  // 'self' only: a Next export prefetches its own RSC payloads; nothing third-party (no tracking).
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/** The persistent banner, noindex, CSP (no tracking, no form posts) and the 30-day expiry. */
export function safeguardHead(): string {
  return [
    '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">',
    '<meta name="googlebot" content="noindex, nofollow">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    "<style data-mu-preview>",
    ".mu-preview-banner{position:fixed;inset:0 0 auto 0;z-index:2147483600;background:#101014;color:#f4f2f8;font:500 13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;padding:8px 16px;text-align:center;letter-spacing:0;box-sizing:border-box;max-width:100vw;overflow-wrap:anywhere;box-shadow:0 1px 0 rgba(255,255,255,.08)}",
    ".mu-preview-banner a{color:#f4f2f8;text-decoration:underline;text-underline-offset:2px;margin-left:.5em;white-space:nowrap}",
    // Space reserved for the banner from the FIRST paint, so it never pushes the page down on load.
    // Measured 25 Sep 2026 (Chromium, 10 real business names): 1 line = 35px, 2 = 54px, 3 = 73px,
    // 4 = 91px; phones 320-430px mostly wrap to 3 lines, tablets 768-1023px to 2, desktop to 1.
    // These are the defaults; the head script below replaces them with the banner's own measured
    // height before the first frame is painted (name length and the phone's system font vary).
    ":root{--mu-banner-h:73px}",
    "@media (min-width:768px){:root{--mu-banner-h:54px}}",
    "@media (min-width:1024px){:root{--mu-banner-h:35px}}",
    "body{padding-top:var(--mu-banner-h)!important}",
    "form[data-mu-form] [type=submit],form[data-mu-form] button{cursor:not-allowed}",
    ".mu-expired{min-height:100vh;display:grid;place-items:center;padding:24px;font:500 16px/1.5 system-ui,sans-serif;background:#101014;color:#f4f2f8;text-align:center}",
    "html[data-mu-expired] body>*:not(.mu-expired-notice){display:none!important}",
    "html[data-mu-expired] body{padding-top:0!important}html[data-mu-expired] .mu-expired-notice{background:#101014!important;color:#f4f2f8!important;opacity:1!important;display:grid!important}",
    "</style>",
    `<script>${BANNER_RESERVE_JS}</script>`,
  ].join("\n");
}

/** Measures the banner the moment it's parsed and before each early frame is painted (animation
 *  frame callbacks run before paint), so the reserved space is exact from the first frame on any
 *  device font. Only sets --mu-banner-h; the banner itself is untouched. */
export const BANNER_RESERVE_JS =
  "(function(){var d=document.documentElement,o;" +
  "function m(){var b=document.querySelector('.mu-preview-banner');if(b&&b.offsetHeight){d.style.setProperty('--mu-banner-h',b.offsetHeight+'px');return true}return false}" +
  "function f(){m();if(document.readyState==='loading')requestAnimationFrame(f)}requestAnimationFrame(f);" +
  "if(window.MutationObserver){o=new MutationObserver(function(){if(m())o.disconnect()});o.observe(d,{childList:true,subtree:true})}" +
  "})();";

export function safeguardBody(business: string, expiresAt: string): string {
  return [
    `<div class="mu-preview-banner" role="note" aria-label="Preview notice" data-mu-expires="${escapeHtml(expiresAt)}">${escapeHtml(bannerText(business))}<a href="https://muventures.com.au" rel="noopener">About M&amp;U Ventures</a></div>`,
    `<script>(function(){${safeguardJs(business)}})();</script>`,
  ].join("");
}

/** Expiry (once past data-mu-expires the page is hidden behind a notice), banner-height offset and form blocking.
 *  The expiry never rewrites the page's own DOM: it marks <html> and APPENDS the notice, and a style rule hides everything else.
 *  Replacing document.body would make a React page (the dental and real-estate exports) fail hydration and re-render the whole
 *  site over the notice, so the expiry would silently not apply. The same script is on every page of every export, so a direct
 *  visit to a nested route, a refresh and the 404 page all expire together. */
export function safeguardJs(business: string): string {
  const b = escapeHtml(business);
  return [
    "var b=document.querySelector('.mu-preview-banner');if(!b)return;",
    "var e=Date.parse(b.getAttribute('data-mu-expires')||'');",
    `if(e&&Date.now()>e){var msg='<p>This preview concept for ${b.replace(/'/g, "\\'")} has expired and is no longer available.<br>Prepared by M&amp;U Ventures. Not the official website.</p>';var css='html[data-mu-expired] body>*:not(.mu-expired-notice){display:none!important}html[data-mu-expired] body{padding-top:0!important}html[data-mu-expired] .mu-expired-notice{background:#101014!important;color:#f4f2f8!important;opacity:1!important;display:grid!important}.mu-expired{min-height:100vh;display:grid;place-items:center;padding:24px;font:500 16px/1.5 system-ui,sans-serif;background:#101014;color:#f4f2f8;text-align:center}';var x=function(){var d=document.documentElement;if(!d.hasAttribute('data-mu-expired'))d.setAttribute('data-mu-expired','1');if(!document.getElementById('mu-expired-style')){var st=document.createElement('style');st.id='mu-expired-style';st.textContent=css;(document.head||d).appendChild(st);}var n=document.querySelector('.mu-expired-notice');if(document.body&&!n){n=document.createElement('main');n.className='mu-expired mu-expired-notice';n.setAttribute('role','alert');document.body.appendChild(n);}if(n&&n.textContent.indexOf('has expired')<0)n.innerHTML=msg;};x();if(typeof MutationObserver!=='undefined'){new MutationObserver(x).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['data-mu-expired']});}addEventListener('load',function(){setTimeout(x,0);setTimeout(x,1500);});return;}`,
    "var s=function(){document.documentElement.style.setProperty('--mu-banner-h',b.offsetHeight+'px')};s();addEventListener('resize',s);",
    "document.addEventListener('submit',function(ev){if(ev.target&&ev.target.hasAttribute&&ev.target.hasAttribute('data-mu-form')){ev.preventDefault();}},true);",
  ].join("");
}

/** Re-stamps the expiry (at deploy time the 30 days start from the deploy, not the draft). */
export function stampExpiry(html: string, expiresAt: string): string {
  return html.replace(/data-mu-expires="[^"]*"/, `data-mu-expires="${escapeHtml(expiresAt)}"`);
}

export function expiryFrom(from: Date): string {
  return new Date(from.getTime() + PREVIEW_DAYS * 86_400_000).toISOString();
}

/** Fills a template and applies every safeguard. Throws if any token is left unfilled. */
export function fillTemplate(template: string, facts: PreviewFacts, vertical: Vertical, opts: { now?: Date; expiresAt?: string } = {}): string {
  const now = opts.now ?? new Date();
  const observedOn = now.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" });
  const tokens = tokensFor(facts, vertical, observedOn);
  let html = renderRepeats(template, facts, facts.business || "this business");
  const raw = rawTokens(facts);
  html = html.replace(/\{\{\{([A-Z_]+)\}\}\}/g, (m, k: string) => (k in raw ? raw[k] : m));
  html = html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in tokens ? tokens[k] : m));
  const left = [...html.matchAll(/\{\{\{?([A-Z_]+)\}?\}\}/g)].map((m) => m[1]);
  if (left.length) throw new Error(`Template tokens left unfilled: ${[...new Set(left)].join(", ")}`);
  if (!html.includes("<!--MU:HEAD-->") || !html.includes("<!--MU:BODY-->")) throw new Error("Template is missing its safeguard markers.");
  // Belt and braces: no third-party script or analytics can ride along.
  html = html.replace(/<script\b[^>]*\bsrc=["'](?:https?:)?\/\/[^"']*["'][^>]*>\s*<\/script>/gi, "");
  html = html.replace("<!--MU:HEAD-->", safeguardHead());
  html = html.replace("<!--MU:BODY-->", safeguardBody(facts.business || "this business", opts.expiresAt ?? expiryFrom(now)));
  return html;
}

/** The static legal preview's own 404 page (a Next export brings its own): a mistyped address shows the preview's banner, a way back and
 *  the verified number, not the host's default page. Carries the same safeguards (noindex, banner, expiry) as every other page. */
export function notFoundPage(facts: PreviewFacts, now: Date): string {
  const b = facts.business || "this business";
  const phone = telHref(facts.phone);
  return [
    `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(`Page not found — ${b} preview (not the official website)`)}</title>`,
    safeguardHead(),
    `<style>.mu-nf{max-width:40rem;margin:0 auto;padding:4rem 1.25rem;font:400 1.05rem/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1f}.mu-nf h1{font-size:2rem;line-height:1.15;margin:0 0 1rem}.mu-nf a{color:inherit}.mu-skip{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.mu-skip:focus{position:fixed;width:auto;height:auto;margin:0;overflow:visible;clip:auto;left:8px;top:calc(var(--mu-banner-h,0px) + 8px);z-index:2147483601;background:#fff;color:#111;padding:10px 14px;outline:2px solid #111}</style>`,
    `</head><body>`,
    safeguardBody(b, expiryFrom(now)),
    `<a class="mu-skip" href="#main">Skip to content</a>`,
    `<main id="main" class="mu-nf"><h1>That page is not here.</h1><p>This is a preview of a possible website for ${escapeHtml(b)}. <a href="/">Back to the preview</a>${phone ? ` or <a href="${phone}">call ${escapeHtml(facts.phone)}</a>` : ""}.</p></main>`,
    `</body></html>`,
  ].join("");
}

/** Vercel static config: noindex + CSP as real HTTP headers, clean URLs, no framework build. */
export function vercelConfig(): string {
  return JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      framework: null,
      cleanUrls: true,
      headers: [
        {
          source: "/(.*)",
          headers: [
            { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
            { key: "Content-Security-Policy", value: `${CSP}; frame-ancestors 'none'` },
            { key: "Referrer-Policy", value: "no-referrer" },
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          ],
        },
      ],
    },
    null,
    2,
  );
}
