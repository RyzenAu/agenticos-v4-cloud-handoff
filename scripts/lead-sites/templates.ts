// Per-vertical TEMPLATES for founder-triggered lead previews, built ONCE from each vertical's
// flagship (read-only: the legal flagship is copied from its committed static files, the two
// Next.js flagships are snapshotted from their live deployments by snapshot.ts). Building a
// template:
//   1. copies/snapshots the flagship home page and its assets;
//   2. REMOVES every section that carries the flagship's invented facts — staff, listings, fees,
//      appointment times, reviews, insights, "why us" claims, practice policies;
//   3. turns the identity fields into {{TOKENS}} (business name, suburb, address, phone, email,
//      services, hours, logo text) and the services list into one {{{SERVICES}}} block;
//   4. checks that none of the flagship's own identity (names, streets, phone numbers, prices)
//      survived, and refuses to write the template if any did.
// Output: <draftsRoot>/_templates/<vertical>/{index.html, assets/…, template.json}. fill.ts then
// fills a copy per lead from verified evidence only.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { snapshotPage, type Fetcher } from "./snapshot";

// Bun's built-in HTMLRewriter (lol-html). Not in this project's tsc lib set (no bun-types).
declare const HTMLRewriter: any;

export type Vertical = "dental" | "legal" | "real-estate";
export const VERTICALS: Vertical[] = ["dental", "legal", "real-estate"];

export type TemplateSpec = {
  vertical: Vertical;
  flagship: string;
  /** Where the template came from (for template.json and the report). */
  source: { kind: "local"; dir: string; liveUrl: string; /** A git revision of the flagship to build from (read with git archive, so the working tree is never used). */ revision?: string } | { kind: "live"; url: string; project: string };
  /** Text that must NOT survive into the template (the flagship's own identity and invented facts). */
  residue: RegExp[];
  /** CSS injected with the template: reveal states the removed JS used to drive, the banner offset. */
  css: string;
  /** Selector → handler map applied with HTMLRewriter. */
  rewrite: (r: any) => any;
};

const REPOS = "C:\\Users\\Nebula PC\\source\\repos";

// ── shared helpers ──────────────────────────────────────────────────────────

const remove = { element(e: any) { e.remove(); } };
const inner = (html: string) => ({ element(e: any) { e.setInnerContent(html, { html: true }); } });
const attr = (name: string, value: string) => ({ element(e: any) { e.setAttribute(name, value); } });
/** Keeps the FIRST element matched as a repeatable item (fill.ts renders it once per verified
 *  service between the REPEAT markers) and removes the rest. */
function repeatFirst(counter: { n: number }, fill: (e: any) => void) {
  return { element(e: any) {
    counter.n += 1;
    if (counter.n > 1) return e.remove();
    e.before("<!--MU:REPEAT-->", { html: true });
    e.after("<!--/MU:REPEAT-->", { html: true });
    fill(e);
  } };
}
const attrs = (pairs: Record<string, string>) => ({ element(e: any) { for (const [k, v] of Object.entries(pairs)) e.setAttribute(k, v); } });

/** Head clean-up common to every template: one neutral title, no description/social/robots/canonical
 *  tags from the flagship, and two markers fill.ts injects the safeguards at. */
function commonHead(r: any) {
  return r
    .on("title", inner("{{TITLE}}"))
    .on('meta[name="description"]', remove)
    .on('meta[name="robots"]', remove)
    .on('meta[name="next-size-adjust"]', remove)
    .on('meta[property^="og:"]', remove)
    .on('meta[name^="twitter:"]', remove)
    .on('link[rel="canonical"]', remove)
    .on('link[rel="manifest"]', remove)
    .on("head", { element(e: any) { e.append("<!--MU:HEAD-->", { html: true }); } })
    .on("body", { element(e: any) { e.prepend("<!--MU:BODY-->", { html: true }); } })
    // Every form stays visibly a form but can never submit anywhere (CSP form-action 'none' too).
    .on("form", attrs({ action: "#", "data-mu-form": "disabled", onsubmit: "return false" }));
}

// ── legal: Marden & Rowe (static, committed) ───────────────────────────────

const LEGAL: TemplateSpec = {
  vertical: "legal",
  flagship: "Marden & Rowe",
  // Pinned: 3d530c9 is the revision the generator was verified against (contrast, 404, skip link, frame folder), so a rebuild is reproducible.
  source: { kind: "local", dir: join(REPOS, "muv-flagship-legal"), liveUrl: "https://mardenrowe.muventures.com.au/", revision: "3d530c9" },
  residue: [/Marden/i, /\bRowe\b/i, /Leichhardt/i, /Norton/i, /5550/, /0188/, /8:30am/i, /family law/i, /\$\s?\d/],
  // A long business name wraps inside the header; it must not widen the page (a fixed banner stretches to the widened page and is clipped).
  css: [`.site-header{top:var(--mu-banner-h,0px)!important}`, `a.wordmark{white-space:normal;min-width:0;overflow-wrap:anywhere}`, `.caption{font-size:max(12px,.75rem)!important}`, // Contrast (WCAG AA): the scroll band's inactive steps keep full-strength text; the active one is marked by a bar and weight, not by dimming.
    `.keys--live .keys-steps li{opacity:1!important;border-left:3px solid transparent;padding-left:.8rem}.keys--live .keys-steps li[aria-current="step"]{border-left-color:var(--accent)}.keys--live .keys-steps li:not([aria-current="step"]) .keys-t{font-weight:400}`, `.mu-skip{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.mu-skip:focus{position:fixed;width:auto;height:auto;margin:0;overflow:visible;clip:auto;left:8px;top:calc(var(--mu-banner-h,0px) + 8px);z-index:2147483601;background:#fff;color:#111;padding:10px 14px;outline:2px solid #111}`].join("\n"),
  rewrite: (r) => {
    const svc = { n: 0 };
    return commonHead(r)
      .on("p.demo-note", remove)
      .on("a.wordmark", inner("{{BUSINESS}}"))
      .on('header .nav a[href="#prepare"]', remove)
      // Keyboard visitors can jump past the header (the first Tab stop is the banner's own link, the second this one).
      .on("main", { element(e: any) { if (!e.getAttribute("id")) e.setAttribute("id", "main"); } })
      .on("header.site-header", { element(e: any) { e.before('<a class="mu-skip" href="#main">Skip to content</a>', { html: true }); } })
      .on("header .nav a.btn", attr("href", "{{PHONE_HREF}}"))
      .on("header .nav a.btn span.long", inner("Call {{PHONE}}"))
      .on("h1.display", inner("Talk it through with {{BUSINESS}}."))
      .on("p.lede", inner("{{BUSINESS}}, {{ADDRESS}}. The first step is one conversation about where things stand."))
      // The hero picker and the first-meeting tool are built around the flagship's four practice
      // areas — services this business may not offer — so both go.
      .on("form.hero-control", remove)
      .on("p.hero-alt", inner('<a href="#visit">Find the office</a>, or <a href="{{PHONE_HREF}}">call {{PHONE}}</a>.'))
      .on("section.tool-section", remove)
      .on("script#tool-data", remove)
      .on('section.statement', attr("aria-label", "About {{BUSINESS}}"))
      .on("h2.services-title", inner("Areas of practice"))
      // Motion layer hooks (motion.ts): a marquee of the verified areas between the statement and
      // the list, and a count line that counts up. Both hidden at fill time without enough facts.
      .on("section.services", { element(e: any) { e.before('<div data-mu-marquee aria-hidden="true"></div>', { html: true }); } })
      .on("div.services-intro", inner('<p class="svc-label">{{SERVICES_LABEL}}</p><p class="mu-count-line"><span data-mu-count>{{SERVICES_COUNT}}</span> {{SERVICES_NOUN}} listed</p><p class="muted">{{SERVICES_NOTE}}</p>'))
      .on("ul.svc-list li.svc", repeatFirst(svc, (e) => e.setAttribute("style", "--i:{{SVC_I}}")))
      .on("ul.svc-list li.svc span.svc-name", inner("{{SVC_NAME}}"))
      .on("ul.svc-list li.svc span.svc-scope", inner("{{SVC_NOTE}}"))
      .on("h2.call-title", inner("Visit {{BUSINESS}}"))
      .on("p.big--lead", inner('<span class="line"><span style="--i:0">{{STREET}}</span></span>'))
      .on("div.finale-side p", inner("{{ADDRESS}}. {{HOURS}}"))
      .on("div.finale-side a", attr("href", "{{PHONE_HREF}}"))
      .on("div.finale-side a", inner("Call {{PHONE}}"))
      .on("div.footer-grid", inner(
        '<div><p><strong>{{BUSINESS}}</strong></p><p>{{ADDRESS}}</p></div>' +
        '<div><p><a href="{{PHONE_HREF}}">{{PHONE}}</a></p>{{{EMAIL_PARA}}}<p class="footer-note">{{HOURS}}</p></div>' +
        '<div><p class="footer-note">{{DISCLAIMER}}</p></div>',
      ))
      .on("p.footer-mark", inner("{{BUSINESS}}"))
      .on("nav.callbar", inner('<a href="{{PHONE_HREF}}">Call us</a><a href="#visit">Office</a>'));
  },
};

// ── dental: Lantern Dental (Next.js, snapshotted from the live deploy) ─────

const DENTAL: TemplateSpec = {
  vertical: "dental",
  flagship: "Lantern Dental",
  source: { kind: "live", url: "https://muv-demo-dental.vercel.app/", project: join(REPOS, "muv-demo-dental") },
  residue: [/Lantern/i, /Rozelle/i, /Darling/i, /5550/, /0142/, /\$\s?\d/, /CDBS/, /bitewing/i, /oral health therapist/i],
  css: [
    // Without the removed JS, nothing may stay in its pre-animation state.
    `[data-m]{opacity:1!important;transform:none!important}`,
    `[class*="FlagshipOpening-module"][class*="__note"]{opacity:1!important}`,
    `[class*="Header-module"][class*="__header"]{top:var(--mu-banner-h,0px)!important}`,
  ].join("\n"),
  rewrite: (r) => {
    let footerHeads = 0, footerLists = 0;
    const need = { n: 0 }, foot = { n: 0 };
    return commonHead(r)
      .on('div[role="region"][aria-label="Demonstration notice"]', remove)
      .on('a[class*="__brand"]', attrs({ href: "#main", "aria-label": "{{BUSINESS}} home" }))
      .on('a[class*="__brand"] > span > span', { element(e: any) {
        // first span = name, second = suburb
        const style = e.getAttribute("style") || "";
        e.setInnerContent(style.includes("opacity") ? "{{SUBURB}}" : "{{BUSINESS}}", { html: true });
      } })
      .on('nav[aria-label="Primary"]', remove)
      .on('button[class*="__burger"]', remove)
      .on("#mobile-nav", remove)
      .on('a[class*="Header-module"][class*="__phone"]', attrs({ href: "{{PHONE_HREF}}" }))
      .on('a[class*="Header-module"][class*="__phone"]', inner("{{PHONE}}"))
      .on('a.btn[href="/book"]', attr("href", "#find-us"))
      .on('a.btn--sm[href="/book"]', inner("Contact"))
      .on('nav[aria-label="Quick booking"] a.btn', attr("href", "#find-us"))
      .on('a[class*="__callBtn"]', attrs({ href: "{{PHONE_HREF}}", "aria-label": "Call {{PHONE}}" }))
      .on("h1#promise", inner("Dentistry.<br/>In {{SUBURB}}."))
      .on('p[class*="__promise"]', inner("{{BUSINESS}}."))
      .on('p[class*="FlagshipOpening-module"][class*="__where"]', inner('<span class="nowrap">{{ADDRESS}}.</span>'))
      .on('a[class*="FlagshipOpening-module"][class*="__book"]', inner("Find the practice"))
      .on('a[href="#example-appointments"]', remove)
      .on('ol[class*="FlagshipOpening-module"][class*="__notes"]', remove)
      // The scroll-scrubbed second hero layer only makes sense with the removed motion JS.
      .on('div[class*="FlagshipOpening-module"][class*="__layer"][class*="__close"]', remove)
      // The header's translucent over-the-hero state is normally cleared by JS on scroll.
      .on('header[class*="Header-module"]', { element(e: any) {
        e.setAttribute("class", (e.getAttribute("class") || "").split(/\s+/).filter((c: string) => !/__sceneTop$/.test(c)).join(" "));
      } })
      .on('a[class*="__needGo"]', remove)
      .on('section[class*="FlagshipClose-module"] a.btn', inner("Find the practice"))
      .on('div[class*="FlagshipOpening-module"][class*="__progress"]', remove)
      .on('p[class*="__cap"], figcaption[class*="__cap"]', inner("Illustrative image, AI-generated for this preview. Not {{BUSINESS_POSS}} premises, staff or patients."))
      // Invented practice policies, fees, sample appointment times and the fee ledger: all removed.
      .on('section[class*="FlagshipVisit-module"]', remove)
      .on('section[class*="__firstVisit"]', remove)
      .on('div[class*="__factsFees"]', remove)
      .on('p[class*="__findNote"]', remove)
      // The "Came for something else?" cards become the verified services list.
      .on('h2#start-here', inner("{{SERVICES_LABEL}}"))
      .on('li[class*="__need"]', repeatFirst(need, () => {}))
      .on('span[class*="__needLabel"]', inner("{{SVC_NAME}}"))
      .on('span[class*="__needAnswer"]', inner("{{SVC_NOTE}}"))
      .on('address[class*="__address"]', inner("{{ADDRESS}}"))
      .on('table[class*="__hours"]', { element(e: any) { e.replace('<p style="margin:1rem 0">{{HOURS}}</p>', { html: true }); } })
      .on('p[class*="__findActions"]', inner('<a href="{{PHONE_HREF}}" class="textlink">Call {{PHONE}}</a>'))
      .on('h2[class*="FlagshipClose-module"][class*="__title"]', inner("Talk to {{BUSINESS}}."))
      .on('a[class*="FlagshipClose-module"][class*="__phone"]', attr("href", "{{PHONE_HREF}}"))
      .on('a[class*="FlagshipClose-module"][class*="__phone"]', inner("{{PHONE}}"))
      .on('div[class*="Footer-module"][class*="__brand"] > span > span', inner("{{BUSINESS}}"))
      .on('p[class*="Footer-module"][class*="__blurb"]', inner("{{BUSINESS}}, {{SUBURB}}."))
      .on('a[class*="Footer-module"][class*="__phone"]', attr("href", "{{PHONE_HREF}}"))
      .on('a[class*="Footer-module"][class*="__phone"]', inner("{{PHONE}}"))
      .on('div[class*="Footer-module"][class*="__brand"] p.small', inner("{{ADDRESS}}"))
      // Footer: the first column list (treatments) becomes the services; the second (practice
      // pages: team, FAQs, fees…) points at pages that don't exist here, so it goes.
      .on('h2[class*="Footer-module"][class*="__h"]', { element(e: any) {
        footerHeads += 1;
        if (footerHeads === 1) e.setInnerContent("{{SERVICES_LABEL}}", { html: true });
        else e.remove();
      } })
      .on('ul[class*="Footer-module"][class*="__list"]', { element(e: any) {
        footerLists += 1;
        if (footerLists > 1) e.remove();
      } })
      .on('ul[class*="Footer-module"][class*="__list"] li', repeatFirst(foot, (e) => e.setInnerContent("{{SVC_NAME}}", { html: true })))
      .on('div[class*="Footer-module"][class*="__legal"]', inner("<p>{{DISCLAIMER}}</p>"));
  },
};

// ── real estate: Aldergate (Next.js, snapshotted from the live deploy) ─────

const REAL_ESTATE: TemplateSpec = {
  vertical: "real-estate",
  flagship: "Aldergate",
  source: { kind: "live", url: "https://aldergate-demo.vercel.app/", project: join(REPOS, "aldergate") },
  residue: [/Aldergate/i, /Balmain/i, /Birchgrove/i, /Lilyfield/i, /Annandale/i, /Leichhardt/i, /Rozelle/i, /Darling/i, /9000 0000/, /\$\s?\d/, /Imogen|Theo Marchetti|Priya Raman/, /aldergate\.demo/i],
  css: [
    `.reveal,.pageEnter{opacity:1!important;transform:none!important;animation:none!important}`,
    // The header's light-on-dark state was swapped by JS on scroll; pin it over the hero instead.
    `[class*="Header-module"][class*="__header"]{position:absolute!important;left:0;right:0;top:var(--mu-banner-h,0px)!important}`,
    `section[class*="home-module"][class*="__hero"]{margin-top:0!important}`,
    `.mu-svc{list-style:none;margin:2rem 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0 2rem}`,
    `.mu-svc li{padding:1.1rem 0;border-top:1px solid currentColor;border-top-color:color-mix(in srgb,currentColor 22%,transparent)}`,
    `.mu-svc b{display:block;font-weight:600;font-size:1.1rem}.mu-svc span{display:block;opacity:.7;font-size:.9rem;margin-top:.25rem}`,
  ].join("\n"),
  rewrite: (r) => {
    let sectionIndex = 0;
    return commonHead(r)
      .on('div[class*="DemoBanner-module"]', remove)
      .on('a[class*="Header-module"][class*="__brand"]', attrs({ href: "#main", "aria-label": "{{BUSINESS}} home" }))
      .on('span[class*="Wordmark-module"][class*="__mark"]', inner("{{BUSINESS}}"))
      .on('nav[aria-label="Primary"]', remove)
      .on('a[aria-label="Saved properties"]', remove)
      .on('a[class*="Header-module"][class*="__phone"]', attrs({ href: "{{PHONE_HREF}}", "aria-label": "Call {{PHONE}}" }))
      .on('a[class*="Header-module"][class*="__cta"]', attr("href", "#contact"))
      .on('a[class*="Header-module"][class*="__cta"]', inner("Contact"))
      .on('button[class*="Header-module"][class*="__menuBtn"]', remove)
      .on("#site-menu", remove)
      .on('p[class*="__heroEyebrow"]', inner("{{SUBURB}}"))
      .on('h1[class*="__heroTitle"]', inner("Real estate in {{SUBURB}}, <em>{{BUSINESS}}.</em>"))
      .on('p[class*="__heroLede"]', inner("{{ADDRESS}}."))
      .on('form[class*="HeroSearch-module"]', remove)
      .on('div[class*="__heroCard"]', remove)
      .on('div[class*="__heroStrip"]', remove)
      // Sections after the hero, in order: listings, sell/manage claims, recent activity, the
      // listing assistant, agents, suburbs, insights, "why us", final CTA. Only the last survives;
      // the first becomes the verified services block.
      .on("main section.section", { element(e: any) {
        const cls = e.getAttribute("class") || "";
        if (cls.includes("finalCta")) return;
        sectionIndex += 1;
        if (sectionIndex === 1) {
          e.setAttribute("id", "services");
          e.setInnerContent(
            '<div class="container container--wide"><div class="SectionHead-module__ufP8IW__head"><div class="SectionHead-module__ufP8IW__text">' +
            '<p class="eyebrow">Services</p><h2 class="h-2">{{SERVICES_LABEL}}</h2><p class="lede SectionHead-module__ufP8IW__lede">{{SERVICES_NOTE}}</p>' +
            '</div></div><ul class="mu-svc"><!--MU:REPEAT--><li><b>{{SVC_NAME}}</b><span>{{SVC_NOTE}}</span></li><!--/MU:REPEAT--></ul></div>', { html: true });
          return;
        }
        e.remove();
      } })
      .on('section[class*="__finalCta"]', attr("id", "contact"))
      .on('section[class*="__finalCta"] h2', inner("Talk to {{BUSINESS}}."))
      .on('section[class*="__finalCta"] p.lede', inner("Buying, selling, renting or leasing out, the first conversation is the same: what do you need, and what would help."))
      .on('div[class*="__finalActions"]', inner('<a class="btn btn--oxblood btn--lg" href="{{PHONE_HREF}}">Call {{PHONE}}</a>{{{EMAIL_BUTTON}}}'))
      .on('p[class*="Footer-module"][class*="__tagline"]', inner("Real estate in {{SUBURB}}."))
      .on('address[class*="Footer-module"]', inner('{{ADDRESS}}<br/><a href="{{PHONE_HREF}}">{{PHONE}}</a>{{{EMAIL_LINE}}}'))
      .on('nav[class*="Footer-module"][class*="__col"]', remove)
      .on('div[class*="Footer-module"][class*="__bottom"]', inner("<p>{{DISCLAIMER}}</p>"));
  },
};

export const TEMPLATE_SPECS: Record<Vertical, TemplateSpec> = { legal: LEGAL, dental: DENTAL, "real-estate": REAL_ESTATE };

export function templatesRoot(draftsRoot: string) {
  return join(draftsRoot, "_templates");
}

/** Visible text + attribute values, minus <style>/<svg> — what a visitor (or a screen reader) sees. */
export function visibleText(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*?\s(?:alt|aria-label|title|content|placeholder)=["']([^"']*)["'][^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The flagship identity/facts that survived a transform (must be empty to ship a template). */
export function residueIn(html: string, spec: Pick<TemplateSpec, "residue">, own: OwnValue[] = []): string[] {
  return residueInText(visibleText(html), spec, own);
}

/** A lead's own value, optionally with how many times the generator placed it in the page (a plain string counts as once). */
export type OwnValue = string | { value: string; max?: number; mask?: boolean };
/** An own value to look for: `mask` for fields that legitimately appear in several formats and places (the phone and the email). */
export type OwnField = string | { value: string; mask: true };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const occurrences = (text: string, part: string) => (part ? (text.match(new RegExp(escapeRegex(part), "gi")) ?? []).length : 0);

/** Decodes the HTML entities a page or a fact can carry, so "&amp;" and "&" compare equal. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
}

/** How many times each own value was placed in what a visitor sees: for every token that shows in the unfilled template's VISIBLE text
 *  (not data-* attributes, JSON-LD or scripts), its count there times the count of the value in the token's filled text (the disclaimer
 *  holds the name several times). Residue that equals an own value is allowed exactly this many times; a value the template never places gets none. */
export function ownPlacements(templateHtml: string, tokenValues: Record<string, string>, own: OwnField[]): OwnValue[] {
  const template = decodeEntities(visibleText(templateHtml));
  const values = own.map((field) => decodeEntities(typeof field === "string" ? field : field.value).trim());
  return own.map((field, i) => {
    const value = values[i];
    // A longer own value that contains this one (the street address holds the suburb) is removed first, so what sits inside it is not counted twice.
    const containers = values.filter((o) => o.length > value.length && o.toLowerCase().includes(value.toLowerCase()));
    let max = 0;
    for (const [token, filled] of Object.entries(tokenValues)) {
      let text = decodeEntities(filled);
      for (const c of containers) text = text.replace(new RegExp(escapeRegex(c), "gi"), " ");
      max += occurrences(template, `{{${token}}}`) * occurrences(text, value);
    }
    return typeof field === "string" ? { value, max } : { value, max, mask: true };
  });
}

/** The lead's OWN verified values are not flagship residue even when they contain a flagship fragment: a real number such as 02 9555 0188 holds
 *  "5550" and "0188", and a business called "Rowe & Co" holds "Rowe". Only the phone and email FIELDS (`mask`) are removed wherever they appear.
 *  Every other value (name, suburb, street address) is removed only as many times as it was placed, so a flagship word that equals the name or
 *  suburb ("Marden", "Leichhardt") still fails when it shows up an extra time, including a suburb that is also inside the address. Case and
 *  entities are ignored when matching. */
export function withoutOwn(text: string, own: OwnValue[]): string {
  let out = decodeEntities(text);
  const budget = new Map<string, number>();
  const masked = new Set<string>();
  for (const raw of own) {
    const v = decodeEntities(typeof raw === "string" ? raw : raw.value).trim();
    if (v.length < 4) continue;
    if (typeof raw !== "string" && raw.mask) {
      masked.add(v);
      masked.add(v.replace(/\s+/g, ""));
      const digits = v.replace(/\D/g, "");
      if (digits.length >= 6) masked.add(digits);
    } else budget.set(v.toLowerCase(), Math.max(budget.get(v.toLowerCase()) ?? 0, typeof raw === "string" ? 1 : (raw.max ?? 0)));
  }
  for (const v of [...masked].sort((x, y) => y.length - x.length)) out = out.replace(new RegExp(escapeRegex(v), "gi"), " ");
  // Longest first, so the address is taken out (using its own budget) before the suburb inside it is counted.
  for (const [v, max] of [...budget].sort((x, y) => y[0].length - x[0].length)) {
    let left = max;
    out = out.replace(new RegExp(escapeRegex(v), "gi"), (m) => (left-- > 0 ? " " : m));
  }
  return out;
}

function residueInText(visible: string, spec: Pick<TemplateSpec, "residue">, own: OwnValue[]): string[] {
  const text = withoutOwn(visible, own);
  return spec.residue.filter((re) => re.test(text)).map((re) => `${re} → "${(re.exec(text)?.[0] ?? "").slice(0, 40)}"`);
}

export async function applyRewrite(html: string, spec: TemplateSpec): Promise<string> {
  const rewriter = spec.rewrite(new HTMLRewriter());
  let out: string = await rewriter.transform(new Response(html)).text();
  // Next.js leaves React text-boundary comments everywhere; they carry nothing a template needs.
  out = out.replace(/<!--\s*-->/g, "").replace(/<!--\/?\$-->/g, "");
  out = out.replace("<!--MU:HEAD-->", `<style data-mu-template>${spec.css}</style><!--MU:HEAD-->`);
  return out;
}

/** Deletes files under <dir>/assets that neither the page nor its stylesheets/scripts reference
 *  (the images of removed listings, staff and fee sections). Only ever touches our own template. */
export function pruneUnusedAssets(dir: string, html: string) {
  const assetsDir = join(dir, "assets");
  if (!existsSync(assetsDir)) return;
  const all = (readdirSync(assetsDir, { recursive: true }) as string[]).map((p) => p.replace(/\\/g, "/"));
  const files = all.filter((p) => statSync(join(assetsDir, p)).isFile());
  const referencing = html + files.filter((p) => /\.(css|js)$/.test(p)).map((p) => readFileSync(join(assetsDir, p), "utf8")).join("\n");
  for (const p of files) {
    const name = p.split("/").pop()!;
    if (/\.(css|js)$/.test(p) && html.includes(name)) continue;
    // A numbered frame sequence is named at run time ("assets/film/keys/" + n): keep the whole folder when the code names the folder.
    const folderNamed = p.includes("/") && referencing.includes(`assets/${p.slice(0, p.lastIndexOf("/") + 1)}`);
    if (!referencing.includes(name) && !folderNamed) unlinkSync(join(assetsDir, p));
  }
}

export type TemplateManifest = {
  vertical: Vertical;
  flagship: string;
  source: TemplateSpec["source"];
  builtAt: string;
  tokens: string[];
};

/** Extracts one git revision of a repo into `into` (our own folder, replaced each time). Relative tar path: GNU tar reads "D:\..." as a remote host. */
export function archiveRevision(repo: string, revision: string, into: string): string {
  if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error(`"${revision}" is not a git revision.`);
  if (existsSync(into)) rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const tarName = `${revision}.tar`;
  const tar = join(into, "..", tarName);
  const archived = spawnSync("git", ["-C", repo, "archive", "--format=tar", "-o", tar, revision], { windowsHide: true, encoding: "utf8" });
  if (archived.status !== 0) throw new Error(`git archive ${revision} failed: ${archived.stderr}`);
  const untar = spawnSync("tar", ["-xf", `../${tarName}`], { cwd: into, windowsHide: true, encoding: "utf8" });
  rmSync(tar, { force: true });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  return into;
}

/** Builds one vertical's template into <draftsRoot>/_templates/<vertical>/. */
export async function buildTemplate(vertical: Vertical, draftsRoot: string, fetcher?: Fetcher): Promise<{ dir: string; manifest: TemplateManifest }> {
  const spec = TEMPLATE_SPECS[vertical];
  const dir = join(templatesRoot(draftsRoot), vertical);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); // our own generated folder only
  mkdirSync(dir, { recursive: true });
  let html: string;
  if (spec.source.kind === "local") {
    const src = spec.source.revision ? archiveRevision(spec.source.dir, spec.source.revision, join(draftsRoot, "_sources", vertical)) : spec.source.dir;
    html = readFileSync(join(src, "index.html"), "utf8");
    cpSync(join(src, "assets"), join(dir, "assets"), { recursive: true });
  } else {
    html = (await snapshotPage(spec.source.url, dir, fetcher)).html;
  }
  const out = await applyRewrite(html, spec);
  const residue = residueIn(out, spec);
  if (residue.length) throw new Error(`The ${vertical} template still carries flagship content: ${residue.join("; ")}`);
  const tokens = [...new Set([...out.matchAll(/\{\{\{?([A-Z_]+)\}?\}\}/g)].map((m) => m[1]))].sort();
  writeFileSync(join(dir, "index.html"), out, "utf8");
  pruneUnusedAssets(dir, out);
  const manifest: TemplateManifest = { vertical, flagship: spec.flagship, source: spec.source, builtAt: new Date().toISOString(), tokens };
  writeFileSync(join(dir, "template.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest };
}
