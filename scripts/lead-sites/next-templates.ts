// Motion-preserving templates for the two Next.js flagships (dental: Lantern Dental, real estate:
// Aldergate). Instead of a script-less HTML snapshot, each is a real `next build` static export
// WITH its client JS, so scroll scenes, reveals, menus and the header behave exactly as on the
// flagship. Built once per vertical:
//   1. copy the flagship into a build folder OUTSIDE its repo (dental: the working tree, which is
//      what's deployed; real estate: the pinned public Aldergate revision) — the flagship
//      repos are only ever read;
//   2. lay the overlay files over it (scripts/lead-sites/overlays/<vertical>/): the identity
//      becomes {{TOKENS}} in the SOURCE, so the server HTML, the RSC payload and the client
//      chunks all carry the same placeholder and hydration can't revert anything; invented
//      prospect facts are evidence-backed; property/profile examples remain clearly fictional;
//   3. apply the small asserted edits below, keep the preview browsing routes (no booking, no
//      API, no DB), and `next build` with output: "export";
//   4. copy out/ to <draftsRoot>/_templates/<vertical>/, prune unused images, and refuse the
//      template if any flagship identity survives in the HTML, the RSC payload OR the JS chunks,
//      or if a token sits inside a length-prefixed RSC text row (replacing it would corrupt it).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { templatesRoot, type Vertical } from "./templates";
import { assertPreviewDesign, DENTAL_PREVIEW_DESIGN } from "./design";
import { withoutOwnTexts } from "./own-values";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS = "C:\\Users\\Nebula PC\\source\\repos";
export const DEFAULT_BUILD_ROOT = process.env.MU_LEAD_SITE_BUILDS || "D:\\mu-lead-site-builds";

export type Edit = { file: string; from: string | RegExp; to: string };
export type NextTemplateSpec = {
  vertical: Extract<Vertical, "dental" | "real-estate">;
  flagship: string;
  repo: string;
  from: "worktree" | "HEAD";
  /** Pin the version which matches the owner's public reference. */
  sourceRevision?: string;
  liveUrl: string;
  /** Entries of src/app to keep; other routes and live APIs are deleted. */
  keepApp: string[];
  deletePaths: string[];
  edits: Edit[];
  /** Case-sensitive: must not appear in any HTML, RSC or JS file of the export. */
  residue: RegExp[];
  /** Offsets for the fixed preview banner (and any first-screen fixes). */
  css: string;
  /** Extra <head> HTML, e.g. preloading the first screen's image (mobile Lighthouse LCP). */
  head: string;
  design?: string;
};

/** The preview banner goes INSIDE the React tree (PreviewBanner.tsx), so hydration keeps it. */
const BANNER_EDITS: Edit[] = [
  { file: "src/app/layout.tsx", from: 'import "./globals.css";', to: 'import "./globals.css";\nimport { PreviewBanner } from "@/components/PreviewBanner";' },
  { file: "src/app/layout.tsx", from: "<body>", to: "<body>\n        <PreviewBanner />" },
];

const DENTAL: NextTemplateSpec = {
  vertical: "dental",
  flagship: "Lantern Dental",
  repo: join(REPOS, "muv-demo-dental"),
  from: "worktree",
  liveUrl: "https://muv-demo-dental.vercel.app/",
  keepApp: ["page.tsx", "page.module.css", "layout.tsx", "globals.css"],
  deletePaths: ["src/proxy.ts", "src/middleware.ts"],
  residue: [/Lantern Dental/, /Rozelle/, /Darling Street/, /5550 0142/, /61255500142/, /Amara/, /Halloran/, /Natarajan/, /CDBS/, /bitewing/, /\$195/, /lanterndental/, /Saturday mornings/],
  css: `header[class*="Header-module"]{top:var(--mu-banner-h,0px)!important}
[id]{scroll-margin-top:calc(var(--mu-banner-h,0px) + 96px)}
h2[class*="Footer-module"][class*="__h"],[class*="__cap"]{font-size:max(12px,.75rem)}
a[data-mu-optional="email"]:not([href^="mailto:"]){display:none}
[data-mu-marquee]{color:var(--navy,#143a62)}`,
  head: '<link rel="preload" as="image" imagesrcset="/_img/640/img/generated/r15/lantern-room-wide.webp 640w, /_img/1080/img/generated/r15/lantern-room-wide.webp 1080w, /_img/1600/img/generated/r15/lantern-room-wide.webp 1600w, /_img/2400/img/generated/r15/lantern-room-wide.webp 2400w" imagesizes="100vw" fetchpriority="high">',
  design: DENTAL_PREVIEW_DESIGN,
  edits: [
    // Header: the treatments menu lists the verified services; every action stays on the page.
    { file: "src/components/Header.tsx", from: 'import { nav, site, treatments } from "@/lib/site";', to: 'import { nav, site } from "@/lib/site";\nimport { PreviewServiceLinks } from "./PreviewServices";' },
    { file: "src/components/Header.tsx", from: "  const groups = Array.from(new Set(treatments.map((t) => t.group)));\n", to: "" },
    {
      file: "src/components/Header.tsx",
      from: /<div className=\{s\.menuGrid\}>[\s\S]*?All treatments <Arrow size=\{16\} \/><\/Link>/,
      to: '<div className={s.menuGrid}><div><ul><PreviewServiceLinks onPick={() => setMenu(false)} /></ul></div></div>\n                    <a href="/#services" className={s.menuAll} onClick={() => setMenu(false)}>All treatments <Arrow size={16} /></a>',
    },
    { file: "src/components/Header.tsx", from: '<Link href="/book" className="btn btn--sm">Book</Link>', to: '<a href="/#find-us" className="btn btn--sm">Contact</a>' },
    {
      file: "src/components/Header.tsx",
      from: /<li><Link href="\/treatments" className=\{s\.drawerLink\}>Treatments<\/Link>[\s\S]*?<\/ul>\s*<\/li>/,
      to: '<li><a href="/#services" className={s.drawerLink} onClick={() => setOpen(false)}>Treatments</a>\n              <ul className={s.drawerSub}><PreviewServiceLinks onPick={() => setOpen(false)} /></ul>\n            </li>',
    },
    { file: "src/components/Header.tsx", from: "className={s.drawerLink}>{n.label}</Link>", to: "className={s.drawerLink} onClick={() => setOpen(false)}>{n.label}</Link>" },
    { file: "src/components/Header.tsx", from: '<Link href="/book" className="btn">Book an appointment</Link>', to: '<a href="/#find-us" className="btn">Find the practice</a>' },
    // Opening scene: same motion, neutral words built only from the practice's own facts.
    { file: "src/components/flagship/FlagshipOpening.tsx", from: 'import { ChooseExampleLink } from "@/components/ChooseExampleLink";\n', to: "" },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: /const NOTES = \[[\s\S]*?\];/, to: "const NOTES = [`Dental care in ${site.suburb}.`, `${site.address.line1}, ${site.address.suburb}.`, `Call ${site.phone}.`];" },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "Dentistry.<br />At your pace.", to: "Dentistry.<br />In {site.suburb}." },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "You’ll know the plan, the fee and the time before we start.", to: "{site.name}." },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "General dentistry in {site.suburb}.", to: "Dental care in {site.suburb}." },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: /<Link href="\/book" className=\{`btn btn--lg \$\{s\.book\}`\}>Book an appointment (<span className="arrow"><Arrow \/><\/span>)<\/Link>/, to: '<a href="#find-us" className={`btn btn--lg ${s.book}`}>Find the practice $1</a>' },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "<ChooseExampleLink className={s.times}>See example times <Arrow size={16} /></ChooseExampleLink>", to: '<a href="/#services" className={s.times}>See treatments <Arrow size={16} /></a>' },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: 'aria-label="What a visit is like"', to: 'aria-label="About the practice"' },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "Illustrative image, AI-generated for this concept. Not Lantern Dental’s premises, staff or patients.", to: "Illustrative image, AI-generated for this preview. Not {site.namePossessive} premises, staff or patients." },
    // "How a visit goes": the scroll story stays; its practice-specific claims don't.
    { file: "src/components/flagship/FlagshipVisit.tsx", from: 'import { ScrollScene } from "./ScrollScene";', to: 'import { ScrollScene } from "./ScrollScene";\nimport { site } from "@/lib/site";' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: 'const CAPTION = "Illustrative image, AI-generated for this concept. Not Lantern Dental’s premises, staff or patients.";', to: "const CAPTION = `Illustrative image, AI-generated for this preview. Not ${site.namePossessive} premises, staff or patients.`;" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"What is bothering you, and what you would like to change. Nothing happens in your mouth yet."', to: '"What is bothering you, and what you would like to change."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"Longer appointments, and an agreed signal to pause at any point."', to: '"The practice can explain how a first visit works."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"A full examination, with x-rays only when they are clinically due."', to: '"An examination, explained as it happens."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"At a first visit: a comprehensive examination, two bitewing x-rays, a scale and clean."', to: '"What a first visit includes is confirmed by the practice."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"A written plan with the fees on it, before any treatment starts."', to: '"The next step is agreed with you before any treatment starts."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"Health funds are claimed on the spot."', to: '"Fees are confirmed by the practice before treatment."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "Lantern Dental <span>Example only</span>", to: "{site.name} <span>Example only</span>" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "<dd>What we found and what comes next</dd>", to: "<dd>What was found and what comes next</dd>" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "<div><dt>The fee</dt><dd>Written down before treatment</dd></div>", to: "<div><dt>The options</dt><dd>Explained before you choose</dd></div>" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "A little more time.<br />A clearer plan.", to: "A clear conversation.<br />A clear plan." },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "Nothing happens in your mouth until you have said what you want and we have agreed it.", to: "An illustration of how a first visit could be explained. {site.name} would confirm the details." },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: /<Link href="\/new-patients" className=\{s\.more\}>What to bring, and what happens after (<span aria-hidden="true">→<\/span>)<\/Link>/, to: '<a href="#find-us" className={s.more}>Find the practice $1</a>' },
    // Contrast (WCAG AA): the dimmed, inactive steps of the scroll scene keep full-strength text; active versus inactive is shown by a bar and by weight.
    { file: "src/components/flagship/FlagshipVisit.module.css", from: "opacity: 0.42; transition: opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1);", to: "border-left: 3px solid transparent; padding-left: 0.9rem; color: var(--ink-2);\n    transition: border-color 0.6s cubic-bezier(0.22, 1, 0.36, 1);" },
    { file: "src/components/flagship/FlagshipVisit.module.css", from: ".scene[data-motion=\"on\"] .step:global(.is-on) { opacity: 1; }", to: ".scene[data-motion=\"on\"] .step:global(.is-on) { border-left-color: var(--ink); color: var(--ink); }\n  /* Inactive steps are never dimmed with opacity (that fails text contrast): the active one is marked by a bar and by heavier type. */\n  .scene[data-motion=\"on\"] .step:not(:global(.is-on)) .stepTitle { color: var(--ink-2); font-weight: 480; }" },
    // Logo text.
    { file: "src/components/Logo.tsx", from: "<span>Lantern Dental</span>", to: "<span>{site.name}</span>" },
    { file: "src/components/Logo.tsx", from: '>Rozelle</span>', to: ">{site.suburb}</span>" },
    { file: "src/components/Logo.tsx", from: /^/, to: 'import { site } from "@/lib/site";\n' },
    // Layout: no demo bar (the preview banner replaces it), one neutral title, noindex.
    { file: "src/app/layout.tsx", from: 'import { DemoBar } from "@/components/DemoBar";\n', to: "" },
    { file: "src/app/layout.tsx", from: /\s*<DemoBar \/>/, to: "" },
    { file: "src/app/layout.tsx", from: /export const metadata: Metadata = \{[\s\S]*?\n\};/, to: 'export const metadata: Metadata = {\n  title: "{{TITLE}}",\n  robots: { index: false, follow: false },\n};' },
    ...BANNER_EDITS,
  ],
};

const REAL_ESTATE: NextTemplateSpec = {
  vertical: "real-estate",
  flagship: "Aldergate",
  repo: join(REPOS, "aldergate"),
  from: "HEAD",
  sourceRevision: "9f374eb",
  liveUrl: "https://aldergate.muventures.com.au/",
  keepApp: ["page.tsx", "home.module.css", "layout.tsx", "globals.css", "template.tsx", "buy", "rent", "sold", "property", "saved", "sell", "property-management", "suburbs", "agents", "insights", "about", "contact", "demonstration", "privacy", "terms", "accessibility", "legal.module.css", "not-found.tsx", "not-found.module.css", "icon.svg"],
  deletePaths: ["src/middleware.ts", "src/proxy.ts", "src/app/property/[slug]/opengraph-image.tsx"],
  // The fictional property/suburb dataset is intentionally retained, explicitly labelled.
  // Agency identity and contact details must never survive from the reference.
  residue: [/Aldergate/, /9000 0000/, /aldergate\.demo/, /0400[ -]?000[ -]?00\d/],
  // The hero copy is the mobile LCP element: show it at once instead of waiting for the reveal JS.
  css: `header[class*="Header-module"]{top:var(--mu-banner-h,0px)!important}
section[class*="home-module"][class*="__hero"] .reveal{opacity:1!important;transform:none!important;transition:none!important}
.pageEnter{animation:none!important}
[id]{scroll-margin-top:calc(var(--mu-banner-h,0px) + 88px)}
.eyebrow,.chip,[class*="Footer-module"][class*="__colHead"],[class*="__statTag"],[class*="__heroCardLabel"],[class*="__heroStrip"] li span,[class*="PropertyCard-module"][class*="__count"],[class*="AreaMap-module"][class*="__note"],[class*="__articleCat"],[class*="__otherHead"],[class*="__postcode"],[class*="insights-module"][class*="__cat"],[class*="AgentCard-module"][class*="__mono"] em,dl dt,[class*="article-module"][class*="__cat"],[class*="article-module"][class*="__relatedCat"],[class*="AgentCard-module"][class*="__mono"]{font-size:max(12px,.75rem)!important}
a[data-mu-optional="email"]:not([href^="mailto:"]){display:none}
a[class*="Header-module"][class*="__brand"]{min-width:0;flex:1 1 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a[class*="Header-module"][class*="__brand"] *{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button[class*="Header-module"][class*="__menuBtn"]{flex:none}
[data-mu-marquee]{color:var(--ink,#1c1a17);background:var(--paper,transparent)}`,
  head: '<link rel="preload" as="image" imagesrcset="/_img/640/photos/stock/hero-01.webp 640w, /_img/1080/photos/stock/hero-01.webp 1080w, /_img/1600/photos/stock/hero-01.webp 1600w, /_img/2400/photos/stock/hero-01.webp 2400w" imagesizes="100vw" fetchpriority="high">',
  edits: [
    { file: "src/app/about/page.tsx", from: "Open ${site.hours[0].time} weekdays and Saturday mornings.", to: "${site.hoursNote}" },
    { file: "src/components/search/SearchPage.tsx", from: "Houses, terraces, apartments and warehouse conversions across the six suburbs. Price guides and inspection times on every listing.", to: "Properties as supplied for this preview. Confirm price, availability and inspection times with the agency." },
    { file: "src/components/search/SearchPage.tsx", from: "Current rentals with inspection times and availability. Register for an inspection online and apply once you've seen it.", to: "Rentals as supplied for this preview. Confirm availability and inspection times with the agency." },
    { file: "src/components/search/SearchPage.tsx", from: "Recent results with the price where the vendor has agreed to publish it. Ask the agent for the comparables behind any guide.", to: "Sold and leased properties as supplied for this preview." },
    { file: "src/app/not-found.tsx", from: 'import styles from "./not-found.module.css";', to: 'import type { Metadata } from "next";\nimport styles from "./not-found.module.css";\n\nexport const metadata: Metadata = { title: "Page not found" };' },
    // Nothing in a preview is sent, so no page may promise a call, a reply, a reminder or a hand-over to a person (see the scan in repair-r8.test.ts).
    { file: "src/app/agents/page.tsx", from: "Tell us what you're trying to do and we'll put you with the right person.", to: "Start with what you are trying to do. This is a preview — enquiries aren't sent yet. The contact page shows how to reach the business." },
    { file: "src/app/property-management/page.tsx", from: "successTitle=\"Request received.\"", to: "successTitle=\"Preview only.\"" },
    { file: "src/app/property-management/page.tsx", from: "successBody=\"Callum or Hana will call to arrange an inspection, usually within one business day.\"", to: "successBody=\"This is a preview — enquiries aren't sent yet.\"" },
    { file: "src/app/property-management/page.tsx", from: "We&rsquo;ll inspect the property, compare it with current rentals and send a written estimate.", to: "A rental appraisal compares a property with current rentals. This is a preview — enquiries aren't sent yet." },
    { file: "src/app/rent/tenants/page.tsx", from: "successTitle=\"Request logged.\"", to: "successTitle=\"Preview only.\"" },
    { file: "src/app/rent/tenants/page.tsx", from: "successBody=\"Your property manager will acknowledge it the same business day and let you know what happens next.\"", to: "successBody=\"This is a preview — enquiries aren't sent yet.\"" },
    { file: "src/app/rent/tenants/page.tsx", from: "You'll hear from us within three, either way.", to: "The agency confirms the outcome either way." },
    { file: "src/app/sell/page.tsx", from: "We&rsquo;ll arrange a time to walk through the property and follow up with a written estimate. There is no obligation, and we won&rsquo;t keep calling.", to: "An appraisal request would ask for a time to walk through the property. This is a preview — enquiries aren't sent yet." },
    { file: "src/app/sell/page.tsx", from: "successTitle=\"Appraisal requested.\"", to: "successTitle=\"Preview only.\"" },
    { file: "src/app/sell/page.tsx", from: "successBody=\"We'll call to arrange a time that suits you, usually within one business day.\"", to: "successBody=\"This is a preview — enquiries aren't sent yet.\"" },
    { file: "src/app/terms/page.tsx", from: "No licensed agent will respond to enquiries made through this demonstration.", to: "Enquiries made through this demonstration are not sent to anyone." },
    { file: "src/data/articles.ts", from: "We will answer all four.", to: "Those four questions are worth putting to any agent." },
    { file: "src/data/faqs.ts", from: "We will confirm the notice periods that apply and send any renewal offer in writing.", to: "Notice periods depend on the lease and the tenancy law that applies, and a renewal offer is made in writing." },
    { file: "src/data/articles.ts", from: "and you will hear from us either way within three", to: "and the agency confirms the outcome either way" },
    { file: "src/components/assistant/Assistant.tsx", from: "and I'll hand you to ${agent.name} for anything I can't confirm.", to: "and anything I can't confirm is best asked of the agency directly. This is a preview, so nothing is passed on." },
    { file: "src/components/assistant/Assistant.tsx", from: "Leave my details for {agent.name.split(\" \")[0]} <Arrow />", to: "Try the question form <Arrow />" },
    { file: "src/components/assistant/Assistant.tsx", from: "Pass this conversation to {agent.name}", to: "This is a preview — questions aren't sent yet" },
    { file: "src/components/assistant/Assistant.tsx", from: "submitLabel=\"Send to agent\"", to: "submitLabel=\"Try the form\"" },
    { file: "src/components/assistant/Assistant.tsx", from: "successTitle=\"Sent to the agent.\"", to: "successTitle=\"Preview only.\"" },
    { file: "src/components/assistant/Assistant.tsx", from: "successBody={`${agent.name} will reply with the answers, usually within one business day.`}", to: "successBody=\"This is a preview — enquiries aren't sent yet.\"" },
    // The departments list on the contact page shows the business's one verified email (hidden when there is none), never a mailto of the placeholder text.
    { file: "src/app/contact/page.tsx", from: "<a href={`mailto:${d.email}`} className=\"link\">\n                  {d.email}\n                </a>", to: "<a href={site.emailHref} data-mu-optional=\"email\" className=\"link\">\n                  {site.email}\n                </a>" },
    // Plain statements in place of the business's voice promising to tell, say, suggest or arrange (see the promise scan).
    { file: "src/app/sell/page.tsx", from: "Where they help. We'll tell you when they don't.", to: "Useful for some properties and not for others." },
    { file: "src/app/about/page.tsx", from: "If your property is outside them, we'll say so and suggest someone who knows the area.", to: "A property outside them may be better served by an agent who knows that area." },
    { file: "src/app/sell/page.tsx", from: "Choose by area, or ask us and we'll tell you honestly who is the right fit.", to: "Choose by area." },
    { file: "src/data/articles.ts", from: "We'll walk through it with you.", to: "An appraisal is the usual first step." },
    { file: "src/data/articles.ts", from: "If you are unsuccessful we will tell you, and we will tell you what else we have coming.", to: "Unsuccessful applicants are told, and other available properties are worth watching." },
    { file: "src/data/faqs.ts", from: "We will tell you honestly whether styling, partial styling or simply decluttering will make the difference for your home, and we can arrange any of them.", to: "Whether styling, partial styling or simply decluttering makes the difference depends on the home." },
    { file: "src/data/faqs.ts", from: "and we will put them to the owner.", to: "and they are put to the owner." },
    { file: "src/data/faqs.ts", from: "You can, and we will put every offer to the vendor.", to: "You can, and an agent is obliged to pass every offer to the vendor." },
    { file: "src/data/faqs.ts", from: "We will explain the process at any inspection.", to: "The process is explained at the auction." },
    // The business's own listings (supplied per preview, read in the browser) replace the template's example stock everywhere it is read.
    { file: "src/lib/listings/adapters.ts", from: 'import { listings as demoListings } from "@/data/listings";', to: 'import { previewListings } from "./state";' },
    { file: "src/lib/listings/adapters.ts", from: "all: () => demoListings,", to: "all: () => previewListings()," },
    { file: "src/lib/listings/adapters.ts", from: 'name: "Demonstration dataset",', to: 'name: "Listings supplied for this preview",' },
    { file: "src/app/saved/SavedList.tsx", from: 'import { listings } from "@/data/listings";', to: 'import { allListings } from "@/lib/listings/queries";\nimport { useListings } from "@/lib/listings/store";\nimport type { Listing } from "@/data/types";' },
    { file: "src/app/saved/SavedList.tsx", from: "  const items = saved.map((s) => listings.find((l) => l.slug === s)).filter((l): l is (typeof listings)[number] => Boolean(l));", to: "  useListings();\n  const items = saved.map((s) => allListings().find((l) => l.slug === s)).filter((l): l is Listing => Boolean(l));" },
    { file: "src/components/property/PropertyCard.tsx", from: 'import { agentBySlug } from "@/data/agents";', to: 'import { agentBySlug } from "@/data/agents";\nimport { spec } from "@/lib/listings/spec";' },
    { file: "src/components/property/PropertyCard.tsx", from: "<Bed /> {l.beds}", to: '<Bed /> {spec(l, "beds")}' },
    { file: "src/components/property/PropertyCard.tsx", from: "<Bath /> {l.baths}", to: '<Bath /> {spec(l, "baths")}' },
    { file: "src/components/property/PropertyCard.tsx", from: "<Car /> {l.cars}", to: '<Car /> {spec(l, "cars")}' },
    // Tenants and selling pages: their cards come from the business's own listings, and say so plainly when it supplied none.
    { file: "src/app/rent/tenants/page.tsx", from: 'import { listingsByChannel } from "@/lib/listings/queries";', to: 'import { PreviewListingCards } from "@/components/PreviewListingCards";' },
    { file: "src/app/rent/tenants/page.tsx", from: '  const rentals = listingsByChannel("rent").slice(0, 3);\n', to: "" },
    { file: "src/app/rent/tenants/page.tsx", from: /<div className=\{styles\.grid3\}>\s*\{rentals\.map[\s\S]*?\)\)\}\s*<\/div>/, to: '<PreviewListingCards channel="rent" className={styles.grid3} />' },
    { file: "src/app/sell/page.tsx", from: 'import { recentlySold } from "@/lib/listings/queries";', to: 'import { PreviewListingCards } from "@/components/PreviewListingCards";' },
    { file: "src/app/sell/page.tsx", from: "  const sold = recentlySold(3);\n", to: "" },
    { file: "src/app/sell/page.tsx", from: /<div className=\{styles\.grid3\}>\s*\{sold\.map[\s\S]*?\)\)\}\s*<\/div>/, to: '<PreviewListingCards channel="sold" className={styles.grid3} />' },
    { file: "src/app/sell/page.tsx", from: 'title="Demonstration results." lede="Sold results shown here are fictional, like every listing on this site. On a real agency site this section reads from the same listing data as the search."', to: 'title="Recent results." lede="Sold and leased properties the agency supplied for this preview. Nothing here is another agency’s sales record."' },
    // A call or email link on an agent's page uses the business's own verified number (one complete number or none) and email, never the raw token text.
    { file: "src/app/agents/[slug]/page.tsx", from: 'import { agents, agentBySlug } from "@/data/agents";', to: 'import { agents, agentBySlug } from "@/data/agents";\nimport { site } from "@/data/site";' },
    { file: "src/app/agents/[slug]/page.tsx", from: '<a href={`tel:${a.phone.replace(/\\s/g, "")}`} className="btn btn--ink">', to: '<a href={site.phoneHref} className="btn btn--ink">' },
    { file: "src/app/agents/[slug]/page.tsx", from: '<a href={`mailto:${a.email}`} className="btn btn--outline">', to: '<a href={site.emailHref} data-mu-optional="email" className="btn btn--outline">' },
    { file: "src/app/agents/[slug]/page.tsx", from: "<Phone /> {a.phone}", to: "<Phone /> {site.phone}" },
    { file: "src/app/agents/[slug]/page.tsx", from: 'Email {a.name.split(" ")[0]}', to: "Email the agency" },
    // The browser-side event and storage names carried the example agency's name; they are neutral now (every listener and sender is renamed together).
    { file: "src/components/assistant/Assistant.tsx", from: "aldergate:open-assistant", to: "preview:open-assistant" },
    { file: "src/components/property/StickyBar.tsx", from: "aldergate:open-assistant", to: "preview:open-assistant" },
    { file: "src/components/search/SearchPage.tsx", from: "aldergate:layout", to: "preview:layout" },
    { file: "src/lib/saved.ts", from: "aldergate:saved", to: "preview:saved" },
    { file: "src/app/agents/[slug]/page.tsx", from: '<h2 className="h-2">{a.name.split(" ")[0]}&rsquo;s current listings</h2>', to: '<h2 className="h-2">Current listings</h2>' },
    { file: "src/app/agents/[slug]/page.tsx", from: 'Talk to {a.name.split(" ")[0]}.', to: "Talk to {site.name}." },
    { file: "src/app/layout.tsx", from: 'import { DemoBanner } from "@/components/shell/DemoBanner";\n', to: "" },
    { file: "src/app/layout.tsx", from: /\s*<DemoBanner \/>/, to: "" },
    { file: "src/app/layout.tsx", from: /\s*<script type="application\/ld\+json"[^\n]*\/>/, to: "" },
    { file: "src/app/layout.tsx", from: /export const metadata: Metadata = \{[\s\S]*?\n\};/, to: 'export const metadata: Metadata = { title: { default: "{{TITLE}}", template: "%s — {{BUSINESS}} preview (not the official website)" }, robots: { index: false, follow: false } };' },
    { file: "src/app/layout.tsx", from: /const orgJsonLd = \{[\s\S]*?\n\};\n/, to: "" },
    ...BANNER_EDITS,
  ],
};

export const NEXT_TEMPLATE_SPECS: Record<"dental" | "real-estate", NextTemplateSpec> = { dental: DENTAL, "real-estate": REAL_ESTATE };

export function applyEdit(text: string, edit: Edit): string {
  if (typeof edit.from === "string") {
    if (!text.includes(edit.from)) throw new Error(`${edit.file}: expected text not found: ${edit.from.slice(0, 80)}`);
    return text.split(edit.from).join(edit.to);
  }
  if (!edit.from.test(text)) throw new Error(`${edit.file}: pattern not found: ${edit.from}`);
  return text.replace(edit.from, edit.to);
}

/**
 * npm on Windows is a .cmd shim, which Node and Bun refuse to spawn without a shell (EINVAL since the
 * 2024 batch-file hardening). Run npm's own CLI script with node instead; never a shell.
 */
export function npmCommand(args: string[], platform = process.platform, find: () => { cli: string; node: string } | null = whereNpm): [string, string[]] {
  if (platform !== "win32") return ["npm", args];
  const found = find();
  if (!found) throw new Error("npm was not found on this PC (its npm-cli.js beside npm.cmd), so the template can't be built here.");
  return [found.node, [found.cli, ...args]];
}

/** npm's CLI script beside npm.cmd, and the node.exe installed beside it when there is one (the one npm was installed with), else `node` from PATH. */
function whereNpm(): { cli: string; node: string } | null {
  const r = spawnSync("where", ["npm.cmd"], { windowsHide: true, encoding: "utf8" });
  for (const line of (r.stdout ?? "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean)) {
    const cli = join(dirname(line), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(cli)) continue;
    const exe = join(dirname(line), "node.exe");
    return { cli, node: existsSync(exe) ? exe : "node" };
  }
  return null;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: String(e) }); });
  });
}

/** Plain file-by-file copy (no .env files). Bun's cpSync on Windows can leave handles open,
 *  which later keeps next's hard-linked export files from being deleted. */
function copyTree(src: string, dst: string) {
  if (statSync(src).isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return;
  }
  for (const rel of readdirSync(src, { recursive: true }) as string[]) {
    if (/(^|[\\/])\.env[^\\/]*$/.test(rel)) continue;
    const from = join(src, rel);
    if (!statSync(from).isFile()) continue;
    mkdirSync(dirname(join(dst, rel)), { recursive: true });
    copyFileSync(from, join(dst, rel));
  }
}

const SKIP_COPY = new Set(["node_modules", ".next", ".git", ".vercel", "out", "review", "memory", "docs", ".impeccable"]);

/** Fresh flagship source in <buildRoot>/<vertical>/ (keeps node_modules), overlays + edits applied. */
export function prepareSource(spec: NextTemplateSpec, work: string) {
  mkdirSync(work, { recursive: true });
  for (const entry of readdirSync(work)) if (entry !== "node_modules") rmSync(join(work, entry), { recursive: true, force: true });
  if (spec.from === "worktree") {
    for (const entry of readdirSync(spec.repo)) {
      if (SKIP_COPY.has(entry) || entry.startsWith(".env")) continue;
      copyTree(join(spec.repo, entry), join(work, entry));
    }
  } else {
    const tar = join(work, "..", `${spec.vertical}-head.tar`);
    const archived = spawnSync("git", ["-C", spec.repo, "archive", "--format=tar", "-o", tar, spec.sourceRevision ?? "HEAD"], { windowsHide: true });
    if (archived.status !== 0) throw new Error(`git archive failed: ${archived.stderr}`);
    // Relative path: GNU tar reads "D:\…" as a remote host.
    const untar = spawnSync("tar", ["-xf", `../${spec.vertical}-head.tar`], { cwd: work, windowsHide: true });
    rmSync(tar, { force: true });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
    for (const entry of readdirSync(work)) if (entry.startsWith(".env")) rmSync(join(work, entry), { force: true });
  }
  copyTree(join(HERE, "overlays", spec.vertical), work);
  const app = join(work, "src", "app");
  for (const entry of readdirSync(app)) if (!spec.keepApp.includes(entry)) rmSync(join(app, entry), { recursive: true, force: true });
  for (const p of spec.deletePaths) rmSync(join(work, p), { recursive: true, force: true });
  for (const edit of spec.edits) {
    const file = join(work, edit.file);
    // Edits are written for LF; a git-archived checkout may be CRLF.
    writeFileSync(file, applyEdit(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), edit), "utf8");
  }
  if (spec.vertical === "real-estate") {
    for (const file of walk(join(work, "src")).filter((f) => /\.(tsx?|css)$/.test(f))) {
      // JSX text must remain text, not an accidental {{BUSINESS}} object expression.
      // Actual branding comes from the tokenised site object and Wordmark.
      writeFileSync(file, readFileSync(file, "utf8").replace(/Aldergate/g, "the agency"));
    }
  }
}

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => join(dir, p)).filter((p) => statSync(p).isFile());
}
export const TEXT_EXT = /\.(html|js|txt|json|css|rsc)$/i;

/** Tokens inside a length-prefixed RSC text row ("…:T<hex>,") can't be replaced safely. */
export function tokensInRscTextRows(html: string): string[] {
  const bad: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    let payload = "";
    try { payload = JSON.parse(m[1]); } catch { continue; }
    for (const row of payload.matchAll(/(?:^|\n)[0-9a-f]+:T([0-9a-f]+),/g)) {
      const start = row.index! + row[0].length;
      const text = payload.slice(start, start + parseInt(row[1], 16));
      const tok = /\{\{[A-Z0-9_]+\}\}/.exec(text);
      if (tok) bad.push(tok[0]);
    }
  }
  return bad;
}

/** Flagship identity left in an export. `own` is the lead's own verified text (own-values.ts): where a residue
 *  word sits inside one of those values it is the business's, not the flagship's. The template itself is scanned
 *  with no own values at all (a cache that still carries a flagship name is dirty whoever the lead is). */
export function exportResidue(dir: string, spec: Pick<NextTemplateSpec, "residue">, own: string[] = []): string[] {
  const hits: string[] = [];
  for (const file of walk(dir).filter((f) => TEXT_EXT.test(f))) {
    if (relative(dir, file) === "template.json") continue; // the build's own record (it names the flagship); never copied into a preview
    const text = readFileSync(file, "utf8");
    const raw = spec.residue.filter((re) => re.test(text));
    if (!raw.length) continue;
    const left = own.length ? withoutOwnTexts(text, own) : text;
    for (const re of raw) if (re.test(left)) hits.push(`${relative(dir, file)}: ${re}`);
  }
  return hits;
}

/** Next 16 writes each route's segment payloads inside a folder (buy/__next.buy/__PAGE__.txt, property/<slug>/__next.property/$d$slug/__PAGE__.txt)
 *  but the browser asks for them by one dotted name (buy/__next.buy.__PAGE__.txt). A static host serves only the files that exist, so every
 *  in-site link prefetch answered 404 (a console error per link, and no instant navigation). This writes the dotted file beside each folder one.
 *  Safe to run again. Returns how many files it added. */
export function flattenSegmentPayloads(dir: string): number {
  let added = 0;
  for (const file of walk(dir)) {
    const rel = relative(dir, file).replace(/\\/g, "/");
    const m = /^((?:.*\/)?__next\.[^/]+)\/(.+\.txt)$/.exec(rel);
    if (!m) continue;
    const flat = join(dir, `${m[1]}.${m[2].replace(/\//g, ".")}`);
    if (existsSync(flat)) continue;
    copyFileSync(file, flat);
    added++;
  }
  return added;
}

/** Deletes images/photos/credits the export doesn't reference (portraits, listing photos). */
export function pruneExport(dir: string, dryRun = false): number {
  let removed = 0;
  const files = walk(dir);
  const text = files.filter((f) => TEXT_EXT.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  for (const f of files) {
    const rel = relative(dir, f).replace(/\\/g, "/");
    if (/(^|\/)CREDITS[^/]*$/i.test(rel)) { if (!dryRun) unlinkSync(f); removed++; continue; }
    if (rel.startsWith("_next/")) continue;
    if (isDynamicMotionAsset(text, rel)) continue;
    if (!/\.(jpe?g|png|webp|avif|svg|gif|ico|mp4|webm)$/i.test(rel)) continue;
    if (!text.includes(rel) && !text.includes(rel.split("/").pop()!)) { if (!dryRun) unlinkSync(f); removed++; }
  }
  return removed;
}

/** The flagship constructs frame filenames at runtime; substring pruning must keep the
 * sequence, including mobile frames, rather than ship a blank scrolling canvas. */
export function isDynamicMotionAsset(text: string, rel: string): boolean {
  return rel.replace(/\\/g, "/").startsWith("motion/approach/") && text.includes("/motion/approach/");
}

/** Waits until a folder has stopped changing for ~6 s (max ~90 s). next build's export workers
 *  keep copying public/ into out/ after the CLI itself has returned. */
async function settle(dir: string, mustExist: string[] = []) {
  let last = "";
  let stable = 0;
  for (let i = 0; i < 45 && stable < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!mustExist.every((p) => existsSync(join(dir, p)))) continue;
    const files = walk(dir);
    const sig = `${files.length}:${files.reduce((a, f) => a + statSync(f).size, 0)}`;
    stable = sig === last ? stable + 1 : 0;
    last = sig;
  }
}

/** Deletes public/ images and credits that no kept source file references (staff portraits,
 *  listing photos…) BEFORE the build — next's export hard-links public/ into out/ and on
 *  Windows those links can't be removed while its workers linger. */
export function pruneSourcePublic(work: string): number {
  const pub = join(work, "public");
  if (!existsSync(pub)) return 0;
  const src = walk(join(work, "src")).filter((f) => /\.(tsx?|css|json)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  let removed = 0;
  for (const f of walk(pub)) {
    const rel = relative(pub, f).replace(/\\/g, "/");
    const name = rel.split("/").pop()!;
    if (isDynamicMotionAsset(src, rel)) continue;
    if (/^CREDITS/i.test(name) || (/\.(jpe?g|png|webp|avif|gif|mp4|webm|svg)$/i.test(name) && !src.includes(name) && !src.includes(`"${name.replace(/\.[^.]+$/, "")}"`))) { unlinkSync(f); removed++; } // data files may name images without the extension
  }
  return removed;
}

export type NextTemplateManifest = {
  kind: "next-export";
  vertical: string;
  flagship: string;
  source: { repo: string; from: string; liveUrl: string; revision?: string; head?: string; dirty?: boolean; preparedDigest?: string };
  builtAt: string;
  tokens: string[];
  css: string;
  head: string;
  design?: string;
};

/** What a template was built from, so a rebuild can be reproduced: the pinned revision (real estate), or for a working-tree source (dental) the repo's HEAD, whether the tree had
 *  uncommitted changes, and a SHA-256 over the prepared source after the overlays and edits. */
export function provenance(spec: NextTemplateSpec, work: string): { revision?: string; head?: string; dirty?: boolean; preparedDigest?: string } {
  const git = (args: string[]) => spawnSync("git", ["-C", spec.repo, ...args], { windowsHide: true, encoding: "utf8" });
  const head = git(["rev-parse", "--short", "HEAD"]).stdout?.trim();
  const dirty = spec.from === "worktree" && Boolean(git(["status", "--porcelain", "--", "src", "public", "package.json"]).stdout?.trim());
  const hash = createHash("sha256");
  const src = join(work, "src");
  if (existsSync(src)) for (const f of walk(src).sort()) { hash.update(relative(src, f).replace(/\\/g, "/")); hash.update(readFileSync(f)); }
  return { ...(spec.sourceRevision ? { revision: spec.sourceRevision } : {}), ...(head ? { head } : {}), dirty, preparedDigest: hash.digest("hex") };
}

export async function buildNextTemplate(vertical: "dental" | "real-estate", draftsRoot: string, buildRoot = DEFAULT_BUILD_ROOT, log: (s: string) => void = () => {}) {
  const spec = NEXT_TEMPLATE_SPECS[vertical];
  const work = join(buildRoot, vertical);
  log(`preparing ${work}`);
  prepareSource(spec, work);
  if (!existsSync(join(work, "node_modules", "next"))) {
    log("npm ci");
    const npm = await run(...npmCommand(["ci", "--no-audit", "--no-fund"]), work);
    if (npm.code !== 0) throw new Error(`npm ci failed: ${npm.out.slice(-800)}`);
  }
  log(`removed ${pruneSourcePublic(work)} unused public files`);
  const out = join(work, "out");
  const publicDirs = existsSync(join(work, "public")) ? readdirSync(join(work, "public")).filter((e) => statSync(join(work, "public", e)).isDirectory()) : [];
  const nextBuild = async () => {
    log("next build");
    rmSync(out, { recursive: true, force: true });
    const built = await run(process.execPath.includes("bun") ? "node" : process.execPath, [join(work, "node_modules", "next", "dist", "bin", "next"), "build"], work);
    // The CLI can return before the export workers finish writing out/: wait for it.
    for (let i = 0; i < 60 && built.code === 0 && !existsSync(join(out, "index.html")); i++) await new Promise((r) => setTimeout(r, 1000));
    if (built.code !== 0 || !existsSync(join(out, "index.html"))) throw new Error(`next build failed: ${built.out.slice(-1500)}`);
    await settle(out, ["index.html", ...publicDirs]);
    return built;
  };
  let built = await nextBuild();
  // Second pass: drop public files the built page never references (listing photos, portraits
  // that data files mention but the preview doesn't render), then build again.
  const unused = pruneExport(out, true);
  if (unused > 0) {
    const text = walk(out).filter((f) => TEXT_EXT.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    let removed = 0;
    for (const f of walk(join(work, "public"))) {
      if (isDynamicMotionAsset(text, relative(join(work, "public"), f))) continue;
      const name = relative(join(work, "public"), f).replace(/\\/g, "/").split("/").pop()!;
      const stem = name.replace(/\.[^.]+$/, "");
      if (/\.(jpe?g|png|webp|avif|gif|mp4|webm|svg)$/i.test(name) && !text.includes(name) && !text.includes(`/${stem}.webp`)) { unlinkSync(f); removed++; }
    }
    log(`removed ${removed} more unused public files; rebuilding`);
    built = await nextBuild();
  }
  // Responsive WebP widths for next/image (the export has no optimiser): see image-loader.js.
  const variants = spawnSync("node", ["make-image-variants.mjs"], { cwd: work, windowsHide: true, encoding: "utf8" });
  if (variants.status !== 0) throw new Error(`image variants failed: ${variants.stderr || variants.stdout}`);
  log(`rendered ${String(variants.stdout).trim()} image variants`);

  const dir = join(templatesRoot(draftsRoot), vertical);
  rmSync(dir, { recursive: true, force: true }); // our own generated folder
  for (const file of walk(join(work, "out"))) {
    const target = join(dir, relative(join(work, "out"), file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target); // a real copy, never a link to next's output
  }
  flattenSegmentPayloads(dir);
  const residue = exportResidue(dir, spec);
  if (residue.length) throw new Error(`The ${vertical} export still carries flagship content: ${residue.slice(0, 8).join("; ")}`);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assertPreviewDesign(vertical, html);
  const unsafe = tokensInRscTextRows(html);
  if (unsafe.length) throw new Error(`Tokens inside RSC text rows (would corrupt on fill): ${unsafe.join(", ")}`);
  const tokens = new Set<string>();
  for (const f of walk(dir).filter((p) => TEXT_EXT.test(p))) for (const m of readFileSync(f, "utf8").matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) tokens.add(m[1]);
  const manifest: NextTemplateManifest = {
    kind: "next-export",
    vertical,
    flagship: spec.flagship,
    source: { repo: spec.repo, from: spec.from, liveUrl: spec.liveUrl, ...provenance(spec, work) },
    builtAt: new Date().toISOString(),
    tokens: [...tokens].sort(),
    css: spec.css,
    head: spec.head,
    ...(spec.design ? { design: spec.design } : {}),
  };
  writeFileSync(join(dir, "template.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest, buildLog: built.out.slice(-1200) };
}
