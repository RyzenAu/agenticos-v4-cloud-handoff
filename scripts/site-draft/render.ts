// The premium scaffold: a complete, art-directed page rendered deterministically from
// evidence.json + the art direction + the generated media. It is the quality FLOOR of every
// draft: the Claude refine pass (build.ts) polishes it, but the orchestrator re-locks the
// headline and core copy (`data-lock`) and restores the scaffold if the refine breaks a guard.
//
// Motion (round 4, owner-approved technique from the Bianca Brown preview): the hero is ONE
// pinned scene. Scrolling drives a slow, eased camera push-in across a sharp high-resolution
// still that match-dissolves into a second, closer still. On wide screens the push-in is the
// Higgsfield film (made FROM the first still, all-intra encoded) scrubbed by scroll instead. The
// scroll is followed with inertia (about GSAP `scrub: 1`) by a ~6 KB frame-rate-independent
// runtime: no GSAP, no Lenis, transform and opacity only. Reduced motion or no JavaScript gets
// the first still, static.
//
// Components: hero (cinema | window | frame; phones always get the full-bleed version),
// statement (scroll-filled sentence beside the detail image), services (index list beside the
// section image), one evidence-safe tool per vertical, the dark finale (call + address), footer,
// mobile call bar, and the sources drawer. Every image is used exactly once (qa.ts enforces it).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, EvidenceFact } from "./evidence";
import type { Direction } from "./direction";
import type { ImageryMedia, ImageSet } from "./imagery";
import type { FontBundle } from "./fonts";

export type RenderInput = {
  evidence: Evidence;
  direction: Direction;
  media?: ImageryMedia;
  /** Fallback art (css-svg) when there is no generated media. */
  fallbackArt?: string;
  fonts?: FontBundle;
  generatedAt?: Date;
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const esc = escapeHtml;

function fact(evidence: Evidence, field: string): EvidenceFact | undefined {
  return evidence.facts.find((f) => f.field === field && f.status === "verified" && f.value);
}

/** "+61 2 9670 3195" -> "02 9670 3195" (Australian local format). */
export function displayPhone(phone: string): string {
  const compact = phone.replace(/[^\d+]/g, "");
  const mobile = /^\+614(\d{2})(\d{3})(\d{3})$/.exec(compact);
  if (mobile) return `04${mobile[1]} ${mobile[2]} ${mobile[3]}`;
  const m = /^\+61(\d)(\d{4})(\d{4})$/.exec(compact);
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`;
  return phone.trim();
}

export function telLink(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/** Street and locality from an address like "162 Bennett Road, St Clair NSW 2759". */
export function addressParts(address: string, fallbackSuburb: string): { street: string; streetName: string; locality: string } {
  const [first, ...rest] = address.split(",").map((s) => s.trim());
  const localityRaw = rest.join(", ");
  const locality = localityRaw.replace(/\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b.*$/i, "").trim() || fallbackSuburb;
  const streetName = (first || "").replace(/^\d+[a-z]?(?:[-/]\d+[a-z]?)?\s+/i, "").trim();
  return { street: first || "", streetName, locality };
}

export type Copy = {
  h1: string;
  lede: string;
  statement: string;
  statementBody: string;
  servicesTitle: string;
  servicesIntro: string;
  placeholders: string[];
  toolNav: string;
  visitTitle: string;
  callTitle: string;
  noun: string;
};

/** The locked copy: art direction owns these strings; the refine pass may not replace them. */
export const LOCKED_FIELDS = ["h1", "lede", "statement", "statementBody", "callTitle"] as const;

export function copyFor(evidence: Evidence, name: string, suburb: string, address: string, hasPhone: boolean): Copy {
  const { streetName, locality } = addressParts(address, suburb);
  const place = locality || suburb;
  const evidenced = evidence.services.length > 0;
  const at = address ? `${address}${address.includes(place) ? "" : `, ${place}`}` : place;
  if (evidence.vertical === "dental") {
    return {
      // Speaks to how the visitor feels about the visit, and claims nothing about the practice.
      // U+2011 (non-breaking hyphen) so "check-up" never splits across lines.
      h1: hasPhone ? "Book the check‑up you've been putting off." : `Your dental practice${streetName ? ` on ${streetName}` : ` in ${place}`}.`,
      lede: hasPhone ? `${name}, ${at}. Call the practice and ask for a time that suits you.` : `${name}, ${at}. Contact details to confirm with the practice.`,
      statement: "A visit starts with one call.",
      statementBody: `Ring the practice${streetName ? ` on ${streetName}` : ""}, say what the visit is for, ask for a time that suits you, and bring your questions with you.`,
      servicesTitle: "Treatments",
      servicesIntro: evidenced ? "As listed on the practice's own website." : `Placeholder rows. ${name}'s own treatment list goes here once the practice confirms it.`,
      placeholders: ["Check-ups and cleans", "Fillings", "Children's dental visits", "Crowns and bridges"],
      toolNav: "Before you call",
      visitTitle: "Find the practice",
      callTitle: hasPhone ? `Call ${name}` : `Visit ${name}`,
      noun: "practice",
    };
  }
  if (evidence.vertical === "legal") {
    return {
      h1: `Talk it through with a ${place} lawyer.`,
      lede: `${name}, ${at}. The first step is one conversation about where things stand.`,
      statement: "Most matters start with one conversation.",
      statementBody: "Bring the documents you have and the questions you can't answer yet. The first meeting is about working out where things stand and what happens next.",
      servicesTitle: "Areas of practice",
      servicesIntro: evidenced ? "As listed on the firm's own website." : `Placeholder rows. ${name}'s own practice areas go here once the firm confirms them.`,
      placeholders: ["Property and conveyancing", "Wills and estates", "Family law", "Commercial matters"],
      toolNav: "First meeting",
      visitTitle: "Find the office",
      callTitle: hasPhone ? `Call ${name}` : `Visit ${name}`,
      noun: "firm",
    };
  }
  return {
    h1: `Plan your next move in ${place}.`,
    lede: hasPhone ? `Pick the month you'd like to be settled, then call ${name} to set the real dates.` : `${name}, ${place}. Contact details to confirm with the office.`,
    statement: "Every move starts with a date.",
    statementBody: "Selling, buying or renting, count back from the day you want to be settled and plan the rest around it.",
    servicesTitle: "Services",
    servicesIntro: evidenced ? "As listed on the agency's own website." : `Placeholder rows. ${name}'s own services go here once the agency confirms them.`,
    placeholders: ["Selling", "Buying", "Leasing", "Property management"],
    toolNav: "Plan a sale",
    visitTitle: "Find the office",
    callTitle: hasPhone ? `Call ${name}` : `Visit ${name}`,
    noun: "agency",
  };
}

// --------------------------------------------------------------------------------------------
// Interactive element per vertical. Evidence-only: the tools never state a fact about the
// business. They help the VISITOR prepare, and route to the evidenced phone/address.

function toolMarkup(vertical: Evidence["vertical"], name: string, phoneDisplay: string, tel: string): { html: string; data: string } {
  if (vertical === "dental") {
    const chips = [
      ["checkup", "A check-up and clean", "I'd like to book a check-up and clean."],
      ["pain", "Something is hurting", "I have a tooth that's hurting and I'd like to be seen as soon as I can."],
      ["new", "I'm a new patient", "I haven't been to the practice before."],
      ["child", "A visit for my child", "I'd like to ask about a visit for my child."],
      ["nervous", "I get nervous at the dentist", "I get nervous about dental visits, so I'd like to know what to expect."],
      ["cost", "I want to ask about costs", "Could you tell me roughly what the visit will cost, and whether I can use my health fund?"],
    ];
    return {
      html: `<div class="tool" data-tool="note">
  <div class="tool-intro" data-reveal>
    <h2 id="prepare-title" class="h2">Know what to say before you call.</h2>
    <p>Tap what applies. It becomes a few sentences you can read out on the phone, so the call takes a minute, not ten.</p>
  </div>
  <div class="tool-body" data-reveal>
    <fieldset class="chips"><legend class="sr-only">What the visit is about</legend>
      ${chips.map(([id, label]) => `<label class="chip"><input type="checkbox" name="reason" value="${id}"><span>${esc(label)}</span></label>`).join("\n      ")}
    </fieldset>
    <div class="note" aria-live="polite">
      <p class="note-text" data-note-text>Hi, I'd like to make an appointment. What times do you have available?</p>
      <div class="note-actions">
        <button type="button" class="btn btn--ghost" data-copy-note>Copy the note</button>
        ${tel ? `<a class="btn btn--solid" href="${tel}" data-magnetic>Call ${esc(phoneDisplay)}</a>` : ""}
      </div>
    </div>
  </div>
</div>`,
      data: JSON.stringify({ kind: "note", greeting: "Hi, ", open: "I'd like to make an appointment.", close: "What times do you have available?", lines: Object.fromEntries(chips.map(([id, , line]) => [id, line])) }),
    };
  }
  if (vertical === "legal") {
    const topics: [string, string, string[]][] = [
      ["property", "Buying or selling property", ["The contract for sale, if you have one", "Any strata or council documents you've received", "Your key dates: exchange, settlement, finance approval"]],
      ["estate", "A will or an estate", ["Any existing will and the date it was signed", "A list of assets and who holds them", "Names of executors or beneficiaries you have in mind"]],
      ["family", "A family matter", ["A short timeline of the important dates", "Any orders, agreements or letters already exchanged", "A list of what you'd most like resolved"]],
      ["dispute", "A dispute or a claim", ["Every letter, email and message about it, in date order", "Any contract or terms involved", "Deadlines on letters you've received"]],
      ["business", "A business matter", ["Your ABN and company details", "The agreement or document in question", "What decision you need to make, and by when"]],
    ];
    return {
      html: `<div class="tool" data-tool="checklist">
  <div class="tool-intro" data-reveal>
    <h2 id="prepare-title" class="h2">Walk into the first meeting prepared.</h2>
    <p>Choose what it's about. You'll get a short list of what to bring and what to ask. General preparation only, not legal advice; ask the firm whether it acts in that area.</p>
  </div>
  <div class="tool-body" data-reveal>
    <div class="segmented" role="radiogroup" aria-label="What the meeting is about">
      ${topics.map(([id, label], i) => `<button type="button" role="radio" class="seg" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-topic="${id}">${esc(label)}</button>`).join("\n      ")}
    </div>
    <div class="checklist" aria-live="polite">
      <div><h3 class="h3">Bring</h3><ul data-bring></ul></div>
      <div><h3 class="h3">Ask</h3>
      <ul>
        <li>How are fees worked out, and can I have an estimate in writing?</li>
        <li>Who will handle my matter day to day?</li>
        <li>What happens next, and roughly when?</li>
      </ul></div>
    </div>
  </div>
</div>`,
      data: JSON.stringify({ kind: "checklist", topics: Object.fromEntries(topics.map(([id, , bring]) => [id, bring])) }),
    };
  }
  // Days before settlement (typical NSW: 4 to 6 week campaign, settlement 42 days after exchange).
  const steps: [number, string, string][] = [
    [126, "Talk to the agency", "Ask for an appraisal and a plan for your timing."],
    [112, "Prepare the home", "Repairs, styling and photography."],
    [91, "Campaign goes live", "Listings, inspections and offers, usually over four to six weeks."],
    [42, "Exchange contracts", "The sale becomes binding."],
    [0, "Settlement", "In NSW, commonly 42 days after exchange."],
  ];
  return {
    html: `<div class="tool" data-tool="timeline">
  <div class="tool-intro" data-reveal>
    <h2 id="prepare-title" class="h2">Plan the sale backwards from moving day.</h2>
    <p>Pick the month you'd like to be settled. The plan works back from there. Typical NSW timings, a general guide only; ${esc(name)} will set the real plan with you.</p>
  </div>
  <div class="tool-body" data-reveal>
    <label class="field"><span>I'd like to be settled by</span>
      <select data-month></select>
    </label>
    <p class="muted timeline-note">Estimated dates from typical NSW timings, not a schedule.</p>
    <ol class="timeline" data-timeline aria-live="polite"></ol>
    ${tel ? `<a class="btn btn--solid" href="${tel}" data-magnetic>Call ${esc(phoneDisplay)} to plan it</a>` : ""}
  </div>
</div>`,
    data: JSON.stringify({ kind: "timeline", steps: steps.map(([days, title, detail]) => ({ days, title, detail })) }),
  };
}

// --------------------------------------------------------------------------------------------

function fontVars(direction: Direction): string {
  const t = direction.typePairing;
  const stretch = t.headingStretch ?? (t.heading === "Archivo" ? 62 : 100);
  return `--font-display: "${t.heading}", ui-serif, Georgia, serif; --font-body: "${t.body}", ui-sans-serif, system-ui, sans-serif; --display-weight: ${t.headingWeight}; --display-tracking: ${t.headingTracking}em; --display-case: ${t.headingCase}; --display-stretch: ${stretch}%;`;
}

function srcset(set: ImageSet): string {
  return set.sizes.map((s) => `${s.path} ${s.w}w`).join(", ");
}

function mid(set: ImageSet): string {
  return (set.sizes.find((s) => s.w >= 1200) ?? set.sizes[set.sizes.length - 1]).path;
}

/** One <picture> per image set: phones get the portrait crop, wider screens pick a width. */
function picture(set: ImageSet, opts: { sizes: string; priority: "high" | "low" | "lazy" | "deferred"; className?: string }): string {
  const loading = opts.priority === "lazy" ? ' loading="lazy"' : "";
  const fetchp = opts.priority === "high" ? ' fetchpriority="high"' : opts.priority === "low" ? ' fetchpriority="low"' : "";
  // "deferred": the dissolve target is invisible until the visitor scrolls, so it must not compete
  // with the first image for bandwidth; the runtime fills in the real sources after load.
  const d = opts.priority === "deferred" ? "data-" : "";
  const img = `<img${opts.className ? ` class="${opts.className}"` : ""} ${d}src="${mid(set)}" ${d}srcset="${srcset(set)}" sizes="${opts.sizes}" width="${set.width}" height="${set.height}" alt=""${loading}${fetchp} decoding="async">`;
  return `<picture>${set.mobile ? `<source media="(max-width: 767px)" ${d}srcset="${set.mobile}">` : ""}${img}</picture>`;
}

function heroStage(media: ImageryMedia | undefined, fallbackArt: string | undefined, variant: Direction["hero"], captionName: string, copyHtml: string): string {
  const sizes = variant === "frame" ? "(max-width: 767px) 100vw, 44vw" : "100vw";
  let layers: string;
  if (media?.heroWide) {
    const film = media.film?.approved ? `<video class="layer layer-film" data-film data-src="${media.film.mp4}" muted playsinline preload="none" aria-hidden="true" tabindex="-1"></video>` : "";
    layers = `<div class="layer layer-a" data-layer="a">${picture(media.heroWide, { sizes, priority: "high" })}</div>
        ${film}
        ${media.heroClose ? `<div class="layer layer-b" data-layer="b">${picture(media.heroClose, { sizes, priority: "deferred" })}</div>` : ""}`;
  } else {
    layers = `<div class="layer layer-a" data-layer="a">${fallbackArt ? `<img src="${fallbackArt}" alt="" width="800" height="500" fetchpriority="high" decoding="async">` : ""}</div>`;
  }
  const caption = media?.heroWide ? `<p class="caption hero-caption">Illustrative imagery, AI-generated for this concept. Not ${esc(captionName)}'s premises.</p>` : "";
  return `<div class="stage">
      <div class="stage-media" data-media>
        ${layers}
        <div class="grade" aria-hidden="true"></div>
      </div>
      <div class="hero-copy">${copyHtml}</div>
      ${caption}
    </div>`;
}

function servicesMarkup(evidence: Evidence, copy: Copy, image?: ImageSet): string {
  const evidenced = evidence.services.length > 0;
  const rows = evidenced
    ? evidence.services.map((s, i) => `<li class="svc" data-reveal="row" style="--i:${i}"><span class="svc-name">${esc(s.value)}</span><a class="svc-src" href="${esc(s.sourceUrl)}" rel="noopener">Source</a></li>`)
    : copy.placeholders.map((p, i) => `<li class="svc svc--placeholder" data-reveal="row" style="--i:${i}"><span class="svc-name">${esc(p)}</span></li>`);
  const heading = `<h2 id="services-title" class="h2 services-title">${esc(copy.servicesTitle)}</h2>`;
  return `<section class="services" id="services" aria-labelledby="services-title">
  ${image ? `<div class="services-band"><figure class="band-media" data-reveal="image"><div class="drift" data-drift>${picture(image, { sizes: "100vw", priority: "lazy" })}</div></figure><div class="wrap band-copy">${heading}</div></div>` : `<div class="wrap">${heading}</div>`}
  <div class="wrap services-grid">
    <div class="services-intro" data-reveal>${evidenced ? "" : `<p class="svc-label">Placeholder list</p>`}<p class="muted">${esc(copy.servicesIntro)}</p></div>
    <ul class="svc-list" data-rows>
      ${rows.join("\n      ")}
    </ul>
  </div>
</section>`;
}

function sourcesDrawer(evidence: Evidence, media: ImageryMedia | undefined): string {
  const rows = [...evidence.facts, ...evidence.services]
    .map((f) => `<tr><td>${esc(f.field)}</td><td>${f.value ? esc(f.value) : "<em>missing</em>"}</td><td>${f.status}</td><td><a href="${esc(f.sourceUrl)}" rel="noopener">${esc(f.sourceLabel)}</a></td></tr>`)
    .join("");
  return `<dialog class="sources" id="sources" aria-labelledby="sources-title">
  <div class="sources-inner">
    <h2 id="sources-title" class="h3">Where every fact on this page comes from</h2>
    <p>Internal review only. Anything not in this table is layout, general guidance or a labelled placeholder, never a claim about the business.</p>
    <div class="table-wrap"><table><thead><tr><th>Field</th><th>Value</th><th>Status</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p>${media ? "Imagery: AI-generated for this concept (see CREDITS.md). No people, no real premises." : "Imagery: generated pattern art, no photography."}</p>
    ${evidence.complianceNotes.length ? `<p class="muted">This vertical's advertising rules were applied (listed in evidence.json).</p>` : ""}
    <form method="dialog"><button class="btn btn--solid">Close</button></form>
  </div>
</dialog>`;
}

/** Writes the scaffold (index.html + scaffold.html + assets/site.js) into a draft folder. */
export function writeScaffold(draftDir: string, input: RenderInput): { html: string; indexPath: string } {
  mkdirSync(join(draftDir, "assets"), { recursive: true });
  writeFileSync(join(draftDir, "assets", "site.js"), RUNTIME_JS, "utf8");
  const html = renderSite(input);
  const indexPath = join(draftDir, "index.html");
  writeFileSync(indexPath, html, "utf8");
  writeFileSync(join(draftDir, "scaffold.html"), html, "utf8");
  return { html, indexPath };
}

export function renderSite(input: RenderInput): string {
  const { evidence, direction, media } = input;
  const p = direction.palette;
  const dark = p.mode === "dark";
  const name = fact(evidence, "name")?.value ?? evidence.name;
  const suburb = fact(evidence, "suburb")?.value ?? evidence.area.replace(/\s+NSW.*$/i, "");
  const address = fact(evidence, "address")?.value ?? "";
  const phone = fact(evidence, "phone")?.value ?? "";
  const mapsUrl = (fact(evidence, "address") ?? fact(evidence, "name"))?.sourceUrl ?? "";
  const phoneDisplay = phone ? displayPhone(phone) : "";
  const tel = phone ? telLink(phone) : "";
  const copy = copyFor(evidence, name, suburb, address, Boolean(phone));
  const tool = toolMarkup(evidence.vertical, name, phoneDisplay, tel);
  const hero = direction.hero;
  const locality = addressParts(address, suburb).locality || suburb;
  const fonts = input.fonts ?? { css: "", preload: [], linkHref: `https://fonts.googleapis.com/css2?${direction.typePairing.googleFamilies.map((f) => `family=${f}`).join("&")}&display=swap` };

  const wide = media?.heroWide;
  const preloads = [
    ...fonts.preload.map((f) => `<link rel="preload" as="font" type="font/woff2" href="${f}" crossorigin>`),
    wide?.mobile ? `<link rel="preload" as="image" href="${wide.mobile}" media="(max-width: 767px)" fetchpriority="high">` : "",
    wide ? `<link rel="preload" as="image" imagesrcset="${srcset(wide)}" imagesizes="${hero === "frame" ? "44vw" : "100vw"}" media="(min-width: 768px)" fetchpriority="high">` : "",
  ].filter(Boolean).join("\n");

  const primaryCta = tel
    ? `<a class="btn btn--solid btn--lg" href="${tel}" data-magnetic><span>Call ${esc(phoneDisplay)}</span></a>`
    : `<a class="btn btn--solid btn--lg" href="#visit" data-magnetic><span>${esc(copy.visitTitle)}</span></a>`;
  const secondaryCta = mapsUrl ? `<a class="btn btn--ghost btn--lg" href="${esc(mapsUrl)}" rel="noopener">Get directions</a>` : `<a class="btn btn--ghost btn--lg" href="#services">${esc(copy.servicesTitle)}</a>`;
  const heroControl =
    evidence.vertical === "legal"
      ? `<form class="hero-control" data-hero-control="topic" action="#prepare"><label><span>What's it about?</span><select data-hero-select aria-label="What the matter is about"></select></label><button class="btn btn--solid" type="submit">Get my first-meeting list</button></form>`
      : evidence.vertical === "real-estate"
        ? `<form class="hero-control" data-hero-control="month" action="#prepare"><label><span>I'd like to be settled by</span><select data-hero-select aria-label="Month you'd like to be settled"></select></label><button class="btn btn--solid" type="submit">Plan my sale</button></form>`
        : "";
  const heroActions = heroControl
    ? `${heroControl}<p class="hero-alt">${tel ? `Or call <a href="${tel}">${esc(phoneDisplay)}</a>` : `Or <a href="#visit">${esc(copy.visitTitle.toLowerCase())}</a>`}${mapsUrl ? `, or <a href="${esc(mapsUrl)}" rel="noopener">get directions</a>` : ""}.</p>`
    : `<div class="actions">${primaryCta}${secondaryCta}</div>`;
  const heroCopy = `<h1 class="display" data-lock="h1">${esc(copy.h1)}</h1>
        <p class="lede" data-lock="lede">${esc(copy.lede)}</p>
        ${heroActions}`;
  const words = copy.statement.split(/\s+/).map((w) => `<span class="w">${esc(w)}</span>`).join(" ");
  const markSize = Math.min(13, Math.round((150 / Math.max(8, name.length)) * 10) / 10);

  return `<!doctype html>
<html lang="en-AU" data-mode="${p.mode}" data-hero="${hero}" data-vertical="${evidence.vertical}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} | ${esc(locality)} (internal draft)</title>
<meta name="description" content="${esc(copy.lede)}">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${p.paper}">
<link rel="icon" href="data:,">
<script>try{if(!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.classList.add("motion-on")}catch(e){}</script>
${preloads}
${fonts.linkHref ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${fonts.linkHref}">` : ""}
<style>
${fonts.css}
:root { --paper: ${p.paper}; --ink: ${p.ink}; --accent: ${p.accent}; --accent-soft: ${p.accentSoft}; --surface: ${p.surface}; --muted: ${p.muted}; --line: ${p.line}; --accent-ink: ${p.accentInk}; ${fontVars(direction)} --gutter: clamp(20px, 4.4vw, 64px); --max: 1400px; --edge: max(var(--gutter), calc((100vw - var(--max)) / 2 + var(--gutter))); --rhythm: clamp(80px, 9vw, 140px); --radius: ${direction.shape?.media ?? "22px"}; --btn-radius: ${direction.shape?.button ?? "999px"}; --ease: cubic-bezier(.16,1,.3,1); color-scheme: ${p.mode}; --end-bg: ${dark ? `color-mix(in srgb, ${p.paper} 60%, #000)` : p.ink}; --end-ink: ${dark ? p.ink : p.paper}; --end-muted: ${dark ? p.muted : `color-mix(in srgb, ${p.paper} 74%, ${p.ink})`}; --end-line: ${dark ? p.line : `color-mix(in srgb, ${p.paper} 22%, ${p.ink})`}; --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.3'/%3E%3C/svg%3E"); }
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 1.125rem/1.6 var(--font-body); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; overflow-x: clip; }
::selection { background: var(--accent); color: var(--accent-ink); }
img, video { display: block; max-width: 100%; }
a { color: inherit; text-underline-offset: .22em; text-decoration-thickness: 1px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wrap { width: 100%; max-width: var(--max); margin-inline: auto; padding-inline: var(--gutter); }
.display, .h2, .wordmark, .big, .call-number, .footer-mark, .svc-name, .statement-text { font-family: var(--font-display); font-weight: var(--display-weight); letter-spacing: var(--display-tracking); font-stretch: var(--display-stretch); font-optical-sizing: auto; }
.display, .h2 { text-transform: var(--display-case); }
.display { font-size: clamp(2.9rem, 6.4vw, 6.4rem); line-height: .96; margin: 0 0 .32em; text-wrap: balance; max-width: 13ch; }
.h2 { font-size: clamp(2.1rem, 4.4vw, 4rem); line-height: 1; margin: 0 0 .45em; text-wrap: balance; }
.h3 { font: 600 .95rem/1.3 var(--font-body); margin: 0 0 .7em; color: var(--muted); }
.muted { color: var(--muted); }
.lede { font-size: clamp(1.08rem, 1.35vw, 1.28rem); line-height: 1.5; max-width: 40ch; margin: 0 0 2rem; }
.caption { font-size: .78rem; line-height: 1.4; color: var(--muted); margin: 0; }

/* draft chrome */
.draft-bar { position: relative; z-index: 60; display: flex; gap: 12px; align-items: center; justify-content: center; padding: 2px 16px; background: #111; color: #f2f2f2; font: 600 .78rem/1.3 var(--font-body); letter-spacing: .04em; }
.draft-bar button { font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 999px; padding: 0 16px; min-height: 44px; cursor: pointer; letter-spacing: 0; }

/* header */
.site-header { position: sticky; top: 0; z-index: 50; background: var(--paper); transition: transform .6s var(--ease), background-color .4s, box-shadow .4s, color .4s; }
.site-header .wrap { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 76px; }
.site-header.is-solid { box-shadow: 0 1px 0 var(--line); }
.site-header.is-hidden { transform: translateY(-100%); }
.wordmark { font-size: 1.3rem; line-height: 1; text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; white-space: nowrap; }
.nav { display: flex; gap: clamp(18px, 2.4vw, 38px); align-items: center; }
.nav a:not(.btn) { text-decoration: none; font-weight: 500; font-size: .95rem; padding: 12px 2px; position: relative; }
.nav a:not(.btn)::after { content: ""; position: absolute; left: 0; right: 0; bottom: 6px; height: 1px; background: currentColor; transform: scaleX(0); transform-origin: right; transition: transform .5s var(--ease); }
.nav a:not(.btn):hover::after { transform: scaleX(1); transform-origin: left; }
.btn .short { display: none; }

/* buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 48px; padding: 0 24px; border-radius: var(--btn-radius); font: 600 .98rem/1 var(--font-body); text-decoration: none; cursor: pointer; border: 1px solid transparent; transition: background-color .3s, color .3s, border-color .3s, transform .5s var(--ease); }
.btn--lg { min-height: 58px; padding: 0 32px; font-size: 1.04rem; }
.btn--solid { background: var(--accent); color: var(--accent-ink); }
.btn--solid:hover { background: color-mix(in srgb, var(--accent) 86%, var(--ink)); }
.btn--ink { background: var(--ink); color: var(--paper); }
.btn--ink:hover { background: color-mix(in srgb, var(--ink) 84%, var(--paper)); }
.btn--ghost { border-color: currentColor; background: transparent; color: inherit; }
.btn--ghost:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
.hero-control { display: flex; flex-wrap: wrap; gap: 14px 18px; align-items: end; max-width: 560px; }
.hero-control label { display: grid; gap: 6px; flex: 1 1 240px; font-size: .85rem; font-weight: 600; }
.hero-control select { font: 500 1.05rem var(--font-body); min-height: 52px; border: 0; border-bottom: 1px solid currentColor; border-radius: 0; background: transparent; color: inherit; padding: 0 2px; }
.hero-control select option { color: #111; }
.hero-alt { margin: 16px 0 0; font-size: 1rem; }
.hero-alt a { display: inline-flex; min-height: 44px; align-items: center; font-weight: 600; }

/* hero: one pinned scene */
.hero { position: relative; }
.stage { position: relative; height: calc(100svh - 124px); min-height: 600px; overflow: hidden; }
.stage-media { position: absolute; inset: 0; overflow: hidden; background: var(--accent-soft); }
.layer { position: absolute; inset: 0; overflow: hidden; }
.layer img, .layer-film { width: 100%; height: 100%; object-fit: cover; }
.layer-a { transform-origin: 50% 46%; }
.layer-b { opacity: 0; transform-origin: 50% 50%; }
.layer-film { opacity: 0; }
.grade { position: absolute; inset: 0; pointer-events: none; background-image: var(--grain), linear-gradient(180deg, color-mix(in srgb, ${p.ink} 10%, transparent), transparent 40%); opacity: .5; mix-blend-mode: soft-light; }
.hero-copy { position: relative; z-index: 2; }
.hero-caption { position: absolute; z-index: 3; right: var(--gutter); bottom: 18px; max-width: 32ch; text-align: right; }
.motion-on .hero { height: 260vh; }
.motion-on .stage { position: sticky; top: 0; height: 100svh; }
.motion-on .layer { will-change: transform, opacity; backface-visibility: hidden; }

/* cinema: full bleed, headline anchored low */
[data-hero="cinema"] .hero { margin-top: -76px; }
[data-hero="cinema"] .stage { height: 100svh; }
[data-hero="cinema"] .hero-copy { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 var(--gutter) clamp(56px, 9vh, 104px); max-width: calc(var(--max)); margin-inline: auto; color: #fff; }
[data-hero="cinema"] .hero-copy .lede { color: rgba(255,255,255,.92); }
[data-hero="cinema"] .display { max-width: 16ch; font-size: clamp(2.8rem, 5.6vw, 5.6rem); }
[data-hero="cinema"] .grade { opacity: 1; mix-blend-mode: normal; background-image: linear-gradient(90deg, rgba(0,0,0,.52) 0%, rgba(0,0,0,.18) 46%, rgba(0,0,0,0) 68%), linear-gradient(0deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 45%), linear-gradient(180deg, rgba(0,0,0,.38) 0%, rgba(0,0,0,0) 22%), var(--grain); }
[data-hero="cinema"] .hero-caption { color: rgba(255,255,255,.88); }
[data-hero="cinema"] .site-header:not(.is-solid) { background: transparent; color: #fff; }
[data-hero="cinema"] .site-header:not(.is-solid) .btn--ink { box-shadow: 0 0 0 1px rgba(255,255,255,.55); }
[data-hero="cinema"] .site-header.is-solid { background: var(--paper); }

/* window: the masthead, then a full-bleed band of image */
[data-hero="window"] .stage { display: grid; grid-template-rows: auto 1fr; }
[data-hero="window"] .hero-copy { order: -1; width: 100%; max-width: var(--max); margin-inline: auto; padding: clamp(20px, 4vh, 48px) var(--gutter) clamp(24px, 4vh, 44px); display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); column-gap: clamp(32px, 5vw, 96px); align-items: end; }
[data-hero="window"] .display { grid-row: span 3; font-size: clamp(3.4rem, 8.4vw, 8.6rem); line-height: .88; max-width: 11ch; margin: 0; }
[data-hero="window"] .lede { margin-bottom: 18px; }
[data-hero="window"] .stage-media { position: relative; inset: auto; min-height: 0; }
[data-hero="window"] .hero-caption { color: rgba(255,255,255,.9); text-shadow: 0 1px 10px rgba(0,0,0,.5); }

/* frame: split, the image in a tall frame that bleeds off the right edge */
[data-hero="frame"] .stage { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); align-items: center; column-gap: clamp(32px, 5vw, 88px); padding-left: max(var(--gutter), calc((100vw - var(--max)) / 2 + var(--gutter))); }
[data-hero="frame"] .stage-media { position: relative; inset: auto; height: calc(100% - 64px); border-radius: ${direction.shape?.arch ? "999px 0 0 0" : "var(--radius) 0 0 var(--radius)"}; }
[data-hero="frame"] .hero-copy { grid-column: 1; grid-row: 1; }
[data-hero="frame"] .stage-media { grid-column: 2; grid-row: 1; }
[data-hero="frame"] .display { max-width: 14ch; }
[data-hero="frame"] .hero-caption { left: max(var(--gutter), calc((100vw - var(--max)) / 2 + var(--gutter))); right: auto; bottom: 24px; text-align: left; max-width: 44ch; }

/* statement beside the detail image */
.statement { padding-block: var(--rhythm); }
.statement-grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: clamp(32px, 6vw, 110px); align-items: center; }
.statement-text { font-size: clamp(2.6rem, 5.6vw, 5.4rem); line-height: 1; margin: 0 0 .5em; max-width: 12ch; text-wrap: balance; text-transform: var(--display-case); }
.statement-body { font-size: clamp(1.12rem, 1.4vw, 1.3rem); line-height: 1.55; color: var(--muted); max-width: 38ch; margin: 0; }
.statement-text .w { color: var(--ink); transition: color .35s; }
.motion-on .statement-text .w { color: var(--muted); }
.motion-on .statement-text .w.is-on { color: var(--ink); }
.statement-media { margin: 0 calc(-1 * var(--edge)) 0 0; border-radius: var(--radius) 0 0 var(--radius); overflow: hidden; aspect-ratio: 4 / 5; background: var(--accent-soft); }

/* services */
.section { padding-block: var(--rhythm); }
.services { padding-bottom: var(--rhythm); }
.services-band { position: relative; height: clamp(380px, 68vh, 720px); overflow: hidden; background: var(--ink); }
.band-media { position: absolute; inset: 0; margin: 0; }
.band-media::after { content: ""; position: absolute; inset: 0; background: linear-gradient(0deg, rgba(0,0,0,.6) 0%, rgba(0,0,0,.16) 40%, rgba(0,0,0,0) 62%); }
.band-copy { position: absolute; left: 0; right: 0; bottom: 0; padding-bottom: clamp(28px, 5vw, 64px); }
.services-title { color: #fff; font-size: clamp(3rem, 8vw, 8rem); line-height: .9; margin: 0; }
.services > .wrap > .services-title { color: var(--ink); padding-top: var(--rhythm); }
.services-grid { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 8fr); gap: clamp(32px, 7vw, 128px); align-items: start; padding-top: clamp(40px, 6vw, 88px); }
.services-intro { max-width: 32ch; margin: 0; position: sticky; top: 104px; }
.drift { height: 124%; margin-top: -12%; }
.drift picture, .drift img { width: 100%; height: 100%; object-fit: cover; }
.svc-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.svc { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: clamp(24px, 3vw, 36px) 2px; border-bottom: 1px solid var(--line); }
.svc-name { font-size: clamp(1.7rem, 3vw, 2.8rem); line-height: 1.05; text-transform: var(--display-case); transition: transform .6s var(--ease); }
.svc:hover .svc-name { transform: translateX(12px); }
.svc-label { display: inline-block; margin: 0 0 12px; font-size: .85rem; font-weight: 600; color: var(--ink); border-bottom: 1px dashed var(--muted); padding-bottom: 2px; }
.services-intro p.muted { margin: 0; }
.svc-src { flex: none; font-size: .85rem; font-weight: 600; color: var(--muted); min-height: 44px; display: inline-flex; align-items: center; }

/* tool */
.tool-section { padding-block: var(--rhythm); background: var(--surface); }
.tool { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: clamp(32px, 7vw, 128px); align-items: start; }
.tool-intro p { max-width: 40ch; color: var(--muted); font-size: 1.12rem; }
.chips { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
.chip { position: relative; }
.chip input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
.chip span { display: inline-flex; align-items: center; min-height: 48px; padding: 0 20px; border-radius: var(--btn-radius); border: 1px solid var(--line); background: var(--paper); font-weight: 500; transition: background-color .3s, color .3s, border-color .3s, transform .4s var(--ease); }
.chip input:checked + span { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.chip input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 3px; }
.note { margin-top: 28px; padding: clamp(24px, 3vw, 40px); background: var(--paper); border-radius: var(--radius); border: 1px solid var(--line); }
.note-text { font-family: var(--font-display); font-weight: var(--display-weight); letter-spacing: var(--display-tracking); font-size: clamp(1.4rem, 2.2vw, 2rem); line-height: 1.22; margin: 0 0 24px; transition: opacity .25s, transform .5s var(--ease); }
.note-text.swap { opacity: 0; transform: translateY(6px); }
.note-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.segmented { display: flex; flex-wrap: wrap; gap: 8px; }
.seg { font: 500 .98rem/1.2 var(--font-body); min-height: 48px; padding: 0 18px; border-radius: var(--btn-radius); border: 1px solid var(--line); background: var(--paper); color: var(--ink); cursor: pointer; transition: background-color .3s, color .3s; }
.seg[aria-checked="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.checklist { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
.checklist ul { margin: 0; padding-left: 1.1em; }
.checklist li { margin: .6em 0; font-size: 1.15rem; line-height: 1.4; }
.checklist li.pop { animation: pop .6s var(--ease) both; }
@keyframes pop { from { opacity: 0; transform: translateX(-10px); } }
.field { display: grid; gap: 8px; font-weight: 600; max-width: 360px; }
.field select { font: 500 1.05rem var(--font-body); min-height: 52px; border: 0; border-bottom: 1px solid var(--ink); border-radius: 0; background: transparent; color: var(--ink); padding: 0 2px; }
.timeline-note { margin: 18px 0 0; font-size: .92rem; }
.timeline { list-style: none; margin: 20px 0 28px; padding: 0; position: relative; }
.timeline::before { content: ""; position: absolute; left: 7px; top: 8px; bottom: 8px; width: 1px; background: var(--line); }
.timeline li { position: relative; padding: 0 0 22px 36px; }
.timeline li.pop { animation: pop .6s var(--ease) both; }
.timeline li::before { content: ""; position: absolute; left: 0; top: 6px; width: 15px; height: 15px; border-radius: 50%; background: var(--surface); border: 2px solid var(--ink); }
.timeline li:last-child::before { background: var(--ink); }
.timeline .when { display: block; font-weight: 600; font-size: 1rem; color: var(--muted); }
.timeline .what { display: block; font-family: var(--font-display); font-weight: var(--display-weight); font-stretch: var(--display-stretch); font-size: clamp(1.5rem, 2vw, 1.9rem); line-height: 1.15; }
.timeline .detail { color: var(--muted); display: block; }

/* the dark finale: the call is the headline */
.finale { background: var(--end-bg); color: var(--end-ink); padding-block: var(--rhythm) clamp(64px, 8vw, 110px); }
.finale a { color: var(--end-ink); }
.finale-grid { display: grid; grid-template-columns: minmax(0, 8fr) minmax(0, 4fr); gap: clamp(32px, 6vw, 96px); align-items: end; }
.call-title { font: 600 clamp(1.05rem, 1.5vw, 1.3rem)/1.3 var(--font-body); margin: 0 0 14px; color: var(--end-muted); }
.call-number { display: inline-block; min-height: 44px; font-size: clamp(3.2rem, 10vw, 10rem); line-height: .92; letter-spacing: -.035em; text-decoration: none; padding-block: .04em; white-space: nowrap; }
.call-number:hover { text-decoration: underline; text-decoration-thickness: .035em; text-underline-offset: .1em; }
.big { font-size: clamp(1.9rem, 3.4vw, 3rem); line-height: 1.05; margin: 28px 0 0; text-transform: var(--display-case); }
.big .line { display: block; overflow: hidden; padding-bottom: .06em; }
.big .line > span { display: block; transition: transform 1.1s var(--ease); transition-delay: calc(var(--i, 0) * 90ms); }
.motion-on .finale:not(.in) .big .line > span { transform: translateY(105%); }
.big--lead { font-size: clamp(3rem, 7.4vw, 7.4rem); line-height: .95; margin-top: 8px; }
.finale-side { display: grid; gap: 14px; justify-items: start; }
.finale-side p { margin: 0; color: var(--end-muted); max-width: 30ch; }
.finale .btn--ghost { color: var(--end-ink); }
.finale :focus-visible { outline-color: var(--end-ink); }

/* footer */
.site-footer { background: var(--end-bg); color: var(--end-ink); border-top: 1px solid var(--end-line); padding-top: clamp(40px, 5vw, 64px); overflow: hidden; }
.site-footer a { color: var(--end-ink); display: inline-flex; align-items: center; min-height: 44px; }
.footer-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px; font-size: .95rem; }
.footer-grid p { margin: 0 0 .3em; }
.footer-note { color: var(--end-muted); font-size: .85rem; }
.footer-mark { font-size: min(13rem, ${markSize}vw); line-height: .82; letter-spacing: -.035em; text-transform: var(--display-case); margin: clamp(40px, 6vw, 80px) 0 0; white-space: nowrap; }

/* reveals: nothing is hidden unless motion is on */
.motion-on [data-reveal]:not(.in) { opacity: 0; transform: translateY(26px); }
.motion-on [data-reveal="image"]:not(.in) { opacity: 0; transform: scale(1.04); }
[data-reveal] { transition: opacity 1s var(--ease), transform 1.2s var(--ease); transition-delay: calc(var(--i, 0) * 70ms); }

/* sticky mobile call bar */
.callbar { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 55; display: none; gap: 10px; padding: 8px; border-radius: 999px; background: var(--ink); box-shadow: 0 18px 40px -16px rgba(0,0,0,.5); transform: translateY(140%); transition: transform .5s var(--ease); }
.callbar.is-on { transform: none; }
.callbar.is-away { transform: translateY(140%); }
.callbar a { flex: 1; min-height: 48px; display: flex; align-items: center; justify-content: center; border-radius: 999px; font-weight: 600; text-decoration: none; color: var(--paper); }
.callbar a:first-child { background: var(--accent); color: var(--accent-ink); }

/* sources */
.sources { max-width: min(920px, calc(100vw - 32px)); width: 100%; border: 0; border-radius: 16px; padding: 0; background: var(--paper); color: var(--ink); }
.sources::backdrop { background: rgba(0,0,0,.5); }
.sources-inner { padding: clamp(20px, 4vw, 40px); }
.table-wrap { overflow-x: auto; }
.sources table { width: 100%; border-collapse: collapse; font-size: .9rem; }
.sources th, .sources td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }

@media (max-width: 900px) {
  .services-grid, .tool, .footer-grid, .finale-grid, .statement-grid, .checklist { grid-template-columns: 1fr; }
  .statement-media { max-width: 520px; margin-left: auto; }
}
/* phones: every hero becomes the full-bleed version, copy over the image */
@media (max-width: 767px) {
  .nav a:not(.btn) { display: none; }
  .nav .btn { min-height: 44px; padding: 0 18px; font-size: .92rem; }
  .btn .long { display: none; }
  .btn .short { display: inline; }
  .wordmark { font-size: 1.08rem; }
  .callbar { display: flex; }
  body { padding-bottom: 76px; }
  [data-hero] .hero { margin-top: 0; }
  [data-hero] .site-header, [data-hero="cinema"] .site-header:not(.is-solid) { background: var(--paper); color: var(--ink); }
  [data-hero="cinema"] .site-header:not(.is-solid) .btn--ink { box-shadow: none; }
  [data-hero] .stage { display: block; height: calc(100svh - 120px); min-height: 560px; padding: 0; }
  .motion-on [data-hero] .stage, .motion-on .stage { height: calc(100svh - 76px); }
  .motion-on .hero { height: 200vh; }
  [data-hero] .stage-media { position: absolute; inset: 0; height: auto; border-radius: 0; }
  [data-hero] .grade { opacity: 1; mix-blend-mode: normal; background-image: linear-gradient(0deg, rgba(0,0,0,.74) 0%, rgba(0,0,0,.4) 34%, rgba(0,0,0,0) 56%), linear-gradient(180deg, rgba(0,0,0,.22) 0%, rgba(0,0,0,0) 16%); }
  .hero-control + .hero-alt { display: none; }
  .services-band { height: 52vh; }
  [data-hero] .hero-copy { position: absolute; left: 0; right: 0; bottom: 0; display: block; padding: 0 var(--gutter) 20px; color: #fff; }
  [data-hero] .hero-copy .lede { color: rgba(255,255,255,.92); margin-bottom: 14px; font-size: 1rem; line-height: 1.45; }
  [data-hero] .display { font-size: clamp(2.3rem, 10.4vw, 3.2rem); line-height: .96; max-width: 13ch; margin-bottom: .26em; }
  [data-hero="window"] .display { font-size: clamp(2.5rem, 11.6vw, 3.6rem); line-height: .9; }
  .hero-control select { min-height: 46px; }
  .hero-control label { gap: 2px; }
  [data-hero] .hero-caption { top: 10px; bottom: auto; right: 12px; left: auto; text-align: right; color: rgba(255,255,255,.82); text-shadow: 0 1px 6px rgba(0,0,0,.6); font-size: .66rem; line-height: 1.3; max-width: 30ch; }
  .hero .actions { flex-wrap: nowrap; gap: 10px; }
  .hero .actions .btn--lg { flex: 1 1 auto; min-height: 52px; padding: 0 16px; font-size: .98rem; }
  .btn--lg { width: 100%; }
  .hero .actions .btn--lg { width: auto; }
  .hero-control { gap: 10px; }
  .hero-control .btn { width: 100%; }
  .call-number { font-size: clamp(2.6rem, 13vw, 4rem); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; scroll-behavior: auto !important; }
  .layer-film { display: none; }
}
</style>
</head>
<body>
<div class="draft-bar" role="note"><span>INTERNAL DRAFT — not for distribution</span><button type="button" data-open-sources aria-haspopup="dialog">Sources</button></div>
<header class="site-header" data-header>
  <div class="wrap">
    <a class="wordmark" href="#top">${esc(name)}</a>
    <nav class="nav" aria-label="Main">
      <a href="#services">${esc(copy.servicesTitle)}</a>
      <a href="#prepare">${esc(copy.toolNav)}</a>
      <a href="#visit">${esc(copy.visitTitle.replace(/^Find the /, "").replace(/^./, (c) => c.toUpperCase()))}</a>
      ${tel ? `<a class="btn btn--ink" href="${tel}" data-magnetic aria-label="Call ${esc(phoneDisplay)}"><span class="long">Call ${esc(phoneDisplay)}</span><span class="short" aria-hidden="true">Call</span></a>` : mapsUrl ? `<a class="btn btn--ink" href="${esc(mapsUrl)}" rel="noopener" data-magnetic><span class="long">Get directions</span><span class="short" aria-hidden="true">Directions</span></a>` : ""}
    </nav>
  </div>
</header>
<main>
  <section class="hero hero--${hero}" id="top" data-scene aria-label="Introduction">
    ${heroStage(media, input.fallbackArt, hero, name, heroCopy)}
  </section>
  <section class="statement" aria-label="About ${esc(name)}">
    <div class="wrap statement-grid">
      <div class="statement-copy">
        <p class="statement-text" data-fill data-lock="statement">${words}</p>
        <p class="statement-body" data-lock="statementBody" data-reveal>${esc(copy.statementBody)}</p>
      </div>
      ${media?.detail ? `<figure class="statement-media" data-reveal="image"><div class="drift" data-drift>${picture(media.detail, { sizes: "(max-width: 900px) 80vw, 28vw", priority: "lazy" })}</div></figure>` : ""}
    </div>
  </section>
  ${servicesMarkup(evidence, copy, media?.section)}
  <section class="tool-section" id="prepare" aria-labelledby="prepare-title">
    <div class="wrap">${tool.html}</div>
  </section>
  <section class="finale" id="visit" aria-labelledby="call-title" data-finale>
    <div class="wrap finale-grid" id="call">
      <div>
        <h2 id="call-title" class="call-title" data-lock="callTitle">${esc(copy.callTitle)}</h2>
        ${tel ? `<a class="call-number" href="${tel}" data-magnetic>${esc(phoneDisplay)}</a>` : ""}
        <p class="big${tel ? "" : " big--lead"}">${(address ? address.split(",").map((x) => x.trim()) : [suburb]).map((l, i) => `<span class="line"><span style="--i:${i}">${esc(l)}</span></span>`).join("")}</p>
      </div>
      <div class="finale-side">
        ${tel ? `<p>Say what it's about, and ask for a time that suits you.</p>` : `<p>Phone number to confirm with the ${copy.noun}.</p>`}
        ${mapsUrl ? `<a class="btn btn--ghost btn--lg" href="${esc(mapsUrl)}" rel="noopener">Open in maps</a>` : ""}
      </div>
    </div>
  </section>
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div><p><strong>${esc(name)}</strong></p>${address ? `<p>${esc(address)}</p>` : `<p>${esc(suburb)}</p>`}</div>
      <div>${tel ? `<p><a href="${tel}">${esc(phoneDisplay)}</a></p>` : ""}${mapsUrl ? `<p><a href="${esc(mapsUrl)}" rel="noopener">Directions</a></p>` : ""}</div>
      <div><p class="footer-note">Redesign concept by M&amp;U Ventures. Internal draft, not published. Imagery is illustrative and AI-generated.</p></div>
    </div>
    <p class="footer-mark" aria-hidden="true" data-footer-mark>${esc(name)}</p>
  </div>
</footer>
${tel ? `<nav class="callbar" aria-label="Quick contact" data-callbar><a href="${tel}">Call ${esc(phoneDisplay)}</a>${mapsUrl ? `<a href="${esc(mapsUrl)}" rel="noopener">Directions</a>` : ""}</nav>` : mapsUrl ? `<nav class="callbar" aria-label="Quick contact" data-callbar><a href="${esc(mapsUrl)}" rel="noopener">Get directions</a><a href="#visit">Find the office</a></nav>` : ""}
${sourcesDrawer(evidence, media)}
<script type="application/json" id="tool-data">${tool.data.replace(/</g, "\\u003c")}</script>
<script src="assets/site.js" defer></script>
</body>
</html>
`;
}

/** Re-applies the art-directed copy after a refine pass: any `data-lock` element keeps the
 *  scaffold's inner HTML. Returns the fixed page and the locks the refine had changed or lost. */
export function relockCopy(html: string, scaffold: string): { html: string; changed: string[]; missing: string[] } {
  const re = /<(\w+)([^>]*?\bdata-lock="([\w-]+)"[^>]*)>([\s\S]*?)<\/\1>/g;
  const locked = new Map<string, string>();
  for (const m of scaffold.matchAll(re)) locked.set(m[3], m[4]);
  const seen = new Set<string>();
  const changed: string[] = [];
  const out = html.replace(re, (whole, tag: string, attrs: string, key: string, inner: string) => {
    const want = locked.get(key);
    if (want === undefined) return whole;
    seen.add(key);
    if (inner === want) return whole;
    changed.push(key);
    return `<${tag}${attrs}>${want}</${tag}>`;
  });
  return { html: out, changed, missing: [...locked.keys()].filter((k) => !seen.has(k)) };
}

// The runtime: no library, ES5-style (no template literals, so it can live in this file).
export const RUNTIME_JS = String.raw`
(function () {
  var doc = document.documentElement;
  var motion = doc.classList.contains("motion-on");
  var fine = window.matchMedia("(pointer: fine)").matches;
  var conn = navigator.connection || {};
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.addEventListener) reduce.addEventListener("change", function () { location.reload(); });

  // Sources drawer
  var dlg = document.getElementById("sources");
  document.querySelectorAll("[data-open-sources]").forEach(function (b) {
    b.addEventListener("click", function () { if (dlg && dlg.showModal) dlg.showModal(); });
  });

  // ---------------------------------------------------------------- the tool (always on)
  var dataEl = document.getElementById("tool-data");
  var tool = dataEl ? JSON.parse(dataEl.textContent) : null;
  var pop = function (el, i) { el.classList.remove("pop"); void el.offsetWidth; el.style.animationDelay = (i * 60) + "ms"; el.classList.add("pop"); };
  if (tool && tool.kind === "note") {
    var noteEl = document.querySelector("[data-note-text]");
    var boxes = document.querySelectorAll('input[name="reason"]');
    var render = function () {
      var picked = [];
      boxes.forEach(function (b) { if (b.checked) picked.push(tool.lines[b.value]); });
      var text = picked.length ? tool.greeting + picked.join(" ") + " " + tool.close : tool.greeting + tool.open.charAt(0).toLowerCase() + tool.open.slice(1) + " " + tool.close;
      if (!motion) { noteEl.textContent = text; return; }
      noteEl.classList.add("swap");
      setTimeout(function () { noteEl.textContent = text; noteEl.classList.remove("swap"); }, 180);
    };
    boxes.forEach(function (b) { b.addEventListener("change", render); });
    var copyBtn = document.querySelector("[data-copy-note]");
    if (copyBtn) copyBtn.addEventListener("click", function () {
      var done = function () { copyBtn.textContent = "Copied"; setTimeout(function () { copyBtn.textContent = "Copy the note"; }, 1800); };
      if (navigator.clipboard) navigator.clipboard.writeText(noteEl.textContent).then(done, done); else done();
    });
  }
  if (tool && tool.kind === "checklist") {
    var bring = document.querySelector("[data-bring]");
    var segs = Array.prototype.slice.call(document.querySelectorAll("[data-topic]"));
    var show = function (id) {
      bring.innerHTML = "";
      tool.topics[id].forEach(function (item, i) { var li = document.createElement("li"); li.textContent = item; bring.appendChild(li); if (motion) pop(li, i); });
      segs.forEach(function (s) { var on = s.getAttribute("data-topic") === id; s.setAttribute("aria-checked", on ? "true" : "false"); s.tabIndex = on ? 0 : -1; });
    };
    segs.forEach(function (s, idx) {
      s.addEventListener("click", function () { show(s.getAttribute("data-topic")); });
      s.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        var next = segs[(idx + (e.key === "ArrowRight" ? 1 : -1) + segs.length) % segs.length];
        next.focus(); next.click(); e.preventDefault();
      });
    });
    show(segs[0].getAttribute("data-topic"));
  }
  if (tool && tool.kind === "timeline") {
    var sel = document.querySelector("[data-month]");
    var list = document.querySelector("[data-timeline]");
    var now = new Date();
    for (var m = 4; m <= 12; m++) {
      var d = new Date(now.getFullYear(), now.getMonth() + m, 15);
      var o = document.createElement("option");
      o.value = d.toISOString();
      o.textContent = d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
      if (m === 6) o.selected = true;
      sel.appendChild(o);
    }
    var fmt = function (date) { return date.toLocaleDateString("en-AU", { day: "numeric", month: "long" }); };
    var plan = function () {
      var target = new Date(sel.value);
      list.innerHTML = "";
      tool.steps.forEach(function (s, i) {
        var when = new Date(target.getTime() - s.days * 86400000);
        var li = document.createElement("li");
        li.innerHTML = '<span class="when"></span><span class="what"></span><span class="detail"></span>';
        li.querySelector(".when").textContent = "Around " + fmt(when);
        li.querySelector(".what").textContent = s.title;
        li.querySelector(".detail").textContent = s.detail;
        list.appendChild(li);
        if (motion) pop(li, i);
      });
    };
    sel.addEventListener("change", plan);
    plan();
  }
  // Hero control: the same choice as the tool below, one tap from the first screen.
  var heroForm = document.querySelector("[data-hero-control]");
  if (heroForm && tool) {
    var heroSel = heroForm.querySelector("[data-hero-select]");
    if (tool.kind === "checklist") document.querySelectorAll("[data-topic]").forEach(function (b) { var o = document.createElement("option"); o.value = b.getAttribute("data-topic"); o.textContent = b.textContent; heroSel.appendChild(o); });
    if (tool.kind === "timeline") Array.prototype.forEach.call(document.querySelector("[data-month]").options, function (o) { heroSel.appendChild(o.cloneNode(true)); });
    heroForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (tool.kind === "checklist") { var btn = document.querySelector('[data-topic="' + heroSel.value + '"]'); if (btn) btn.click(); }
      if (tool.kind === "timeline") { var ts = document.querySelector("[data-month]"); ts.value = heroSel.value; ts.dispatchEvent(new Event("change")); }
      document.getElementById("prepare").scrollIntoView({ behavior: motion ? "smooth" : "auto" });
    });
  }

  // ---------------------------------------------------------------- header and call bar
  var header = document.querySelector("[data-header]");
  var callbar = document.querySelector("[data-callbar]");
  var own = Array.prototype.slice.call(document.querySelectorAll("[data-finale], #prepare"));
  var lastY = window.scrollY;
  var chrome = function () {
    var y = window.scrollY;
    if (header) {
      header.classList.toggle("is-solid", y > 40);
      if (y < 400 || y < lastY - 2) header.classList.remove("is-hidden");
      else if (y > lastY + 2) header.classList.add("is-hidden");
    }
    if (callbar) {
      var h = window.innerHeight;
      callbar.classList.toggle("is-on", y > h * 0.6);
      callbar.classList.toggle("is-away", own.some(function (el) { var r = el.getBoundingClientRect(); return r.top < h - 40 && r.bottom > h - 120; }));
    }
    lastY = y;
  };
  window.addEventListener("scroll", chrome, { passive: true });
  chrome();

  if (!motion) return;

  // The dissolve target loads after the page has, so it never slows the first image.
  var fillDeferred = function () {
    document.querySelectorAll("[data-srcset], img[data-src]").forEach(function (el) {
      if (el.dataset.srcset) { el.srcset = el.dataset.srcset; el.removeAttribute("data-srcset"); }
      if (el.tagName === "IMG" && el.dataset.src) { el.src = el.dataset.src; el.removeAttribute("data-src"); }
    });
  };
  if (document.readyState === "complete") fillDeferred(); else window.addEventListener("load", fillDeferred);

  // ---------------------------------------------------------------- reveals
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -12% 0px" });
    document.querySelectorAll("[data-reveal], [data-finale]").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll("[data-reveal], [data-finale]").forEach(function (el) { el.classList.add("in"); });
  }

  // ---------------------------------------------------------------- the scroll engine
  var clamp = function (v, a, b) { return Math.min(b === undefined ? 1 : b, Math.max(a || 0, v)); };
  var span = function (p, a, b) { return clamp((p - a) / (b - a)); };
  var sine = function (t) { return 0.5 - Math.cos(Math.PI * t) / 2; };
  var smooth = function (t) { return t * t * t * (t * (6 * t - 15) + 10); };
  var TAU = 0.3; // inertia time constant, about GSAP scrub: 1
  var cache = new Map();
  var set = function (el, prop, value) { var c = cache.get(el) || {}; if (c[prop] !== value) { el.style[prop] = value; c[prop] = value; cache.set(el, c); } };
  var tf = function (s, y) { return "translate3d(0," + (y || 0).toFixed(2) + "%,0) scale(" + s.toFixed(4) + ")"; };
  var tracks = [];
  var measure = function () { tracks.forEach(function (t) { var r = t.el.getBoundingClientRect(); t.top = r.top + window.scrollY; t.h = t.el.offsetHeight; }); };

  // Hero scene: a still push-in that match-dissolves into the close still; on wide screens the
  // film (made from the first still) is scrubbed instead of the first push.
  var scene = document.querySelector("[data-scene]");
  var A = document.querySelector('[data-layer="a"]');
  var B = document.querySelector('[data-layer="b"]');
  var F = document.querySelector("[data-film]");
  var filmReady = false;
  var wide = window.matchMedia("(min-width: 900px)");
  if (scene && A) tracks.push({ el: scene, run: function (y, t) {
    var p = clamp((y - t.top) / Math.max(1, t.h - window.innerHeight));
    if (filmReady) {
      var fp = sine(span(p, 0, 0.64));
      var target = fp * Math.max(0, F.duration - 0.05);
      if (!F.seeking && Math.abs(F.currentTime - target) > 0.02) F.currentTime = target;
      set(A, "opacity", (1 - smooth(span(p, 0, 0.04))).toFixed(3));
      set(A, "transform", tf(1));
      set(F, "opacity", (smooth(span(p, 0, 0.04)) * (1 - smooth(span(p, 0.58, 0.8)))).toFixed(3));
      if (B) { set(B, "opacity", smooth(span(p, 0.5, 0.8)).toFixed(3)); set(B, "transform", tf(1 + 0.06 * sine(span(p, 0.5, 1)))); }
    } else {
      set(A, "transform", tf(1 + 0.3 * sine(span(p, 0, 0.78))));
      set(A, "opacity", (B ? 1 - smooth(span(p, 0.46, 0.74)) : 1).toFixed(3));
      if (B) { set(B, "opacity", smooth(span(p, 0.36, 0.7)).toFixed(3)); set(B, "transform", tf(1 + 0.05 * sine(span(p, 0.36, 1)))); }
    }
  } });

  // Statement: the sentence fills word by word as it crosses the screen.
  var fill = document.querySelector("[data-fill]");
  if (fill) {
    var words = Array.prototype.slice.call(fill.querySelectorAll(".w"));
    tracks.push({ el: fill, run: function (y, t) {
      var vh = window.innerHeight;
      var p = clamp((y + vh * 0.85 - t.top) / (t.h + vh * 0.4));
      var n = Math.round(p * words.length);
      words.forEach(function (w, i) { w.classList.toggle("is-on", i < n); });
    } });
  }
  // Images drift inside their frames.
  document.querySelectorAll("[data-drift]").forEach(function (el) {
    tracks.push({ el: el.parentNode, run: function (y, t) {
      var vh = window.innerHeight;
      var p = clamp((y + vh - t.top) / (t.h + vh));
      set(el, "transform", "translate3d(0," + ((0.5 - p) * 12).toFixed(2) + "%,0)");
    } });
  });
  // The footer wordmark rises as the page ends.
  var mark = document.querySelector("[data-footer-mark]");
  if (mark) tracks.push({ el: mark.parentNode, run: function (y, t) {
    var vh = window.innerHeight;
    var p = clamp((y + vh - t.top) / t.h);
    set(mark, "transform", "translate3d(0," + ((1 - p) * 40).toFixed(2) + "%,0)");
  } });

  var shown = window.scrollY, last = 0, raf = 0;
  var tick = function (now) {
    raf = 0;
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    var goal = window.scrollY;
    shown += (goal - shown) * (1 - Math.exp(-dt / TAU));
    if (Math.abs(goal - shown) < 0.5) shown = goal;
    for (var i = 0; i < tracks.length; i++) tracks[i].run(shown, tracks[i]);
    if (shown !== goal) raf = requestAnimationFrame(tick); else last = 0;
  };
  var kick = function () { if (!raf) raf = requestAnimationFrame(tick); };
  measure();
  tracks.forEach(function (t) { t.run(shown, t); });
  window.addEventListener("scroll", kick, { passive: true });
  window.addEventListener("resize", function () { measure(); kick(); });
  window.addEventListener("load", function () { measure(); kick(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); kick(); });

  // The film: wide screens only, after load, never under Save-Data. All-intra, so seeks are instant.
  var armFilm = function () {
    if (!F || !wide.matches || conn.saveData || F.dataset.loaded) return;
    F.dataset.loaded = "1";
    F.src = F.dataset.src;
    F.preload = "auto";
    F.addEventListener("loadeddata", function () { F.pause(); filmReady = true; measure(); kick(); }, { once: true });
    F.load();
  };
  var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1200); };
  if (document.readyState === "complete") idle(armFilm); else window.addEventListener("load", function () { idle(armFilm); });

  // Magnetic calls to action (fine pointers only).
  if (fine) {
    document.querySelectorAll("[data-magnetic]").forEach(function (el) {
      el.addEventListener("pointermove", function (e) { var r = el.getBoundingClientRect(); el.style.transform = "translate3d(" + ((e.clientX - r.left - r.width / 2) * 0.22).toFixed(1) + "px," + ((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1) + "px,0)"; });
      el.addEventListener("pointerleave", function () { el.style.transform = ""; });
    });
  }
})();
`;
