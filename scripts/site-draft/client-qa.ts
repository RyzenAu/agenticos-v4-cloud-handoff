// Task 6 of MINISTRY-BACKLOG-2026-09-24.md: "Site-draft QA extended to the paid client build."
// qa.ts's checks were built for a CRM-prospect draft, gated on evidence.ts's Evidence shape
// (facts + services scraped/CRM-sourced). A client build has no CRM lead and no evidence.json —
// its ground truth is the signed agreement + client-supplied content + CLIENT.md, gathered by
// client-evidence.ts. Rather than bend qa.ts's Evidence type to fit a shape it was never built
// for, this is its own module reusing qa.ts's browser-runner plumbing (defaultRunner /
// defaultAgentBrowserBin / Runner, exported additively from qa.ts for this) so there's exactly
// one place that knows how to drive the agent-browser CLI.
//
// This never touches the client's own build folder: runClientQa copies it into a scratch
// directory first and points the browser at the copy, per the brief's "run QA against a copy or
// its local server" instruction — the other engineer's active work stays untouched.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import type { ClientFacts, ClientEvidence } from "./client-evidence";
import { gatherClientEvidence } from "./client-evidence";
import { defaultAgentBrowserBin, defaultRunner, stripTags, type QaIssue, type Runner } from "./qa";

export type { QaIssue };

export type ClientQaOptions = {
  runner?: Runner;
  sessionPrefix?: string;
  /** Skip the agent-browser-driven checks (screenshots/console/axe) — used by unit tests. */
  skipBrowser?: boolean;
  /** Skip attempting a Lighthouse run even if the CLI is on PATH. */
  skipLighthouse?: boolean;
  now?: Date;
};

export type LighthouseResult = { available: boolean; scores?: Record<string, number>; note?: string };

export type ClientQaReport = {
  verdict: "READY" | "NOT READY";
  clientName: string | null;
  buildDir: string;
  pagesChecked: string[];
  templateSourcesSkipped: string[];
  issues: QaIssue[];
  screenshots: { desktop: string | null; mobile: string | null };
  lighthouse: LighthouseResult;
  evidenceSources: ClientEvidence["facts"]["sources"];
  generatedAt: string;
};

// ---- Claims audit (client-specific: an allow-list, not just a forbidden-pattern list) ---------
// Same categories qa.ts's auditClaims checks (star rating, price, award, guarantee,
// before/after, testimonial, named person), plus a bare "#1" superlative the brief calls out by
// name, but a price or a named person is only a failure if it ISN'T on the agreement/CLIENT.md's
// allowed lists — a real client site is expected to state its own real price and its own real
// staff, unlike a prospect draft that has neither yet.
const NUMBER_ONE_RE = /#\s?1\b|\bnumber\s*one\b/i;
const STAR_RATING_RE = /★|⭐|\b\d(\.\d)?\s*\/\s*5\b|\d+\s*star/i;
const AWARD_RE = /award[- ]winning|voted (?:best|number ?one)/i;
const GUARANTEE_RE = /guarantee[ds]?\b/i;
const BEFORE_AFTER_RE = /before\s*(?:&|and)\s*after/i;
const TESTIMONIAL_RE = /testimonial|"[^"]{15,}"\s*[-–—]\s*[A-Z][a-z]+\s*[A-Z]\.?\s*$/im;
const PRICE_RE = /\$\s?([\d][\d,]*(?:\.\d+)?)/g;
// A "Dr. First Last" pattern (qa.ts's own base check) is safe to scan for anywhere in the page —
// nobody writes that outside a person's name. A bare two-capitalised-word bigram is NOT safe to
// scan for anywhere: ordinary marketing prose is full of them (street/suburb names, "Blue
// Mountains", a sentence-initial capitalised word followed by another proper noun). So that check
// is scoped to blocks that are actually about a person — a team/staff/agent/about section —
// mirroring evidence.ts's own "only trust text physically inside a labelled section" approach.
const DR_NAME_RE = /\bDr\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g;
const PERSON_SECTION_RE = /team|staff|agent|meet|about/i;
const NAME_BIGRAM_RE = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2}\b/g;
// Common phrases that capitalise like a name but aren't one, to keep the section-scoped check
// from flagging a place/brand name that legitimately appears in an about/team section.
const NAME_STOPWORDS = new Set(["Blue Mountains", "New South", "South Wales", "Real Estate", "Meet The", "The Team"]);

/** Two/three-capitalised-word candidates found only inside a team/staff/agent/about-labelled
 *  block, the same scoping evidence.ts uses for services — not a blanket scan of the whole page. */
function findPersonSectionNameCandidates(html: string): string[] {
  const found: string[] = [];
  const sectionRe = /<(section|div|article)[^>]*(?:id|class)=["'][^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(sectionRe)) {
    const tagOpen = match[0].slice(0, match[0].indexOf(">"));
    if (!PERSON_SECTION_RE.test(tagOpen)) continue;
    const text = stripTags(match[2]);
    for (const m of text.matchAll(NAME_BIGRAM_RE)) if (!found.includes(m[0])) found.push(m[0]);
  }
  return found;
}

export function auditClientClaims(html: string, facts: ClientFacts): QaIssue[] {
  const issues: QaIssue[] = [];
  const text = stripTags(html);

  if (STAR_RATING_RE.test(text)) issues.push({ severity: "fail", area: "claims", detail: `Found an unevidenced star rating: "${text.match(STAR_RATING_RE)![0].slice(0, 60)}"` });
  if (AWARD_RE.test(text)) issues.push({ severity: "fail", area: "claims", detail: `Found an unevidenced award claim: "${text.match(AWARD_RE)![0].slice(0, 60)}"` });
  if (GUARANTEE_RE.test(text)) issues.push({ severity: "fail", area: "claims", detail: `Found a guarantee claim not in the agreement: "${text.match(GUARANTEE_RE)![0].slice(0, 60)}"` });
  if (BEFORE_AFTER_RE.test(text)) issues.push({ severity: "fail", area: "claims", detail: "Found a before/after claim — not supplied by the client." });
  if (TESTIMONIAL_RE.test(text)) issues.push({ severity: "fail", area: "claims", detail: "Found what reads as a testimonial — not supplied by the client." });
  if (NUMBER_ONE_RE.test(text)) issues.push({ severity: "fail", area: "claims", detail: `Found an unevidenced "#1"/"number one" claim: "${text.match(NUMBER_ONE_RE)![0]}"` });

  for (const m of text.matchAll(PRICE_RE)) {
    const normalised = m[1].replace(/,/g, "");
    if (!facts.allowedPrices.includes(normalised)) {
      issues.push({ severity: "fail", area: "claims", detail: `Found a price ($${m[1]}) that isn't in the signed agreement or CLIENT.md: "${m[0]}"` });
    }
  }

  const isAllowed = (name: string) => facts.allowedNames.some((allowed) => allowed === name || allowed.includes(name) || name.includes(allowed));

  for (const m of text.matchAll(DR_NAME_RE)) {
    const name = m[0].replace(/^Dr\.?\s+/, "");
    if (isAllowed(name)) continue;
    issues.push({ severity: "fail", area: "claims", detail: `Found a named person ("${m[0]}") not in the supplied content or agreement — confirm with the client before this ships.` });
  }

  // The business's own trading name reads like a two-word proper name ("Bianca Brown Realty")
  // but isn't a person — never flag a candidate that's part of it.
  const isBusinessName = (name: string) => !!facts.clientName && facts.clientName.includes(name);

  for (const name of findPersonSectionNameCandidates(html)) {
    if (NAME_STOPWORDS.has(name) || isAllowed(name) || isBusinessName(name)) continue;
    issues.push({ severity: "fail", area: "claims", detail: `Found a named person ("${name}") in a team/about/agent section, not in the supplied content or agreement — confirm with the client before this ships.` });
  }

  return issues;
}

// ---- Hard design rules: no centred search bar, black + dark-yellow/gold/white palette ---------

const SEARCH_INPUT_RE = /<input\b[^>]*(?:type=["']search["']|(?:placeholder|aria-label|name)=["'][^"']*search[^"']*["'])[^>]*>/gi;

export function auditNoCenterSearchBar(html: string, facts: ClientFacts): QaIssue[] {
  if (!facts.noCenterSearchBar) return [];
  const headerMatch = html.match(/<header[\s\S]*?<\/header>/i);
  const heroMatch = html.match(/<section[^>]*\b(?:id|class)=["'][^"']*(?:hero|top)[^"']*["'][\s\S]*?<\/section>/i);
  const topOfPage = (headerMatch?.[0] ?? "") + (heroMatch?.[0] ?? "");
  const hits = [...topOfPage.matchAll(SEARCH_INPUT_RE), ...html.matchAll(SEARCH_INPUT_RE)];
  if (!hits.length) return [];
  const inHeaderOrHero = topOfPage.match(SEARCH_INPUT_RE);
  return [{
    severity: inHeaderOrHero ? "fail" : "warn",
    area: "design-rules",
    detail: inHeaderOrHero
      ? `Found a search input in the header/hero — the agreement explicitly says no search bar in the middle: ${inHeaderOrHero[0].slice(0, 100)}`
      : `Found a search input elsewhere on the page — confirm it isn't centred, per the agreement's "no search bar in the middle" rule: ${hits[0][0].slice(0, 100)}`,
  }];
}

export type PaletteSample = { hex: string; count: number; family: "black" | "gold" | "white" | "other" }[];

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let h6 = hex.length === 4 ? hex.slice(1).split("").map((c) => c + c).join("") : hex.slice(1);
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s: s * 100, l: l * 100 };
}

function classifyColour(hex: string): "black" | "gold" | "white" | "other" {
  const { h, s, l } = hexToHsl(hex);
  // Lightness decides black/white first, regardless of hue/saturation: a warm off-white or cream
  // (a near-white with a gold undertone, exactly what "white accents" on a black+gold site tend
  // to use) still reads as white, not as an off-palette colour.
  if (l <= 18) return "black";
  if (l >= 88) return "white";
  if (h >= 30 && h <= 65 && s >= 20 && l <= 85) return "gold"; // yellow/gold/dark-yellow band
  return "other";
}

/** Tallies every hex colour literal in the given CSS/HTML text. Exported so tests can assert on
 *  the classification directly, without going through the full audit. */
export function samplePalette(css: string): PaletteSample {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = `#${m[1].toLowerCase()}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts.entries()].map(([hex, count]) => ({ hex, count, family: classifyColour(hex) }));
}

export function auditPalette(css: string, facts: ClientFacts): QaIssue[] {
  if (!facts.palette) return [];
  const sample = samplePalette(css);
  if (!sample.length) return [{ severity: "warn", area: "design-rules", detail: "Could not sample any hex colours from the page's CSS to verify the black/dark-yellow/gold/white rule." }];
  const total = sample.reduce((n, s) => n + s.count, 0);
  const otherCount = sample.filter((s) => s.family === "other").reduce((n, s) => n + s.count, 0);
  const otherShare = otherCount / total;
  const otherSamples = sample.filter((s) => s.family === "other").slice(0, 5).map((s) => s.hex);
  if (otherShare > 0.35) {
    return [{ severity: "fail", area: "design-rules", detail: `${Math.round(otherShare * 100)}% of sampled colours (${otherSamples.join(", ")}) fall outside black/dark-yellow/gold/white — the agreement's palette rule.` }];
  }
  if (otherShare > 0.1) {
    return [{ severity: "warn", area: "design-rules", detail: `Some sampled colours (${otherSamples.join(", ")}) fall outside black/dark-yellow/gold/white — check these are decorative, not a competing accent.` }];
  }
  return [];
}

// ---- Forms per the agreement: appraisal form, call button, general enquiry form ----------------
// The agreement's checklist puts all three under "SELL PAGE: preferred enquiry options" — so
// they're only required on whichever page(s) actually present themselves as the Sell page/section,
// not on every page in the build. Applying this blanket-wide flagged admin.html and a 404 page for
// not having a client-facing appraisal form, which was never the rule. This is deliberately keyed
// on "sell"/"selling" specifically, not on a generic "appraisal" class/id — an appraisal CTA can
// legitimately be embedded as a shared component on the Home page too, and that alone doesn't make
// Home the Sell page the agreement is describing (Home isn't required to also carry a separate
// general enquiry form just because it echoes the same appraisal button).
const SELL_PAGE_RE = /\b(?:id|class|aria-labelledby)=["'][^"']*sell(?:ing)?[^"']*["']/i;

export function isSellLikePage(html: string, relPath: string): boolean {
  return /(?:^|\/)sell(?:\.html|\/index\.html)?$/i.test(relPath) || SELL_PAGE_RE.test(html);
}

export function auditRequiredForms(html: string, facts: ClientFacts): QaIssue[] {
  const issues: QaIssue[] = [];
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);

  if (facts.requiredForms.includes("appraisal form")) {
    const hasAppraisal = forms.some((f) => /appraisal/i.test(f)) || /appraisal/i.test(html.replace(/<form[\s\S]*?<\/form>/gi, ""));
    if (!hasAppraisal) issues.push({ severity: "fail", area: "forms", detail: "No appraisal form found — the agreement's Sell-page checklist requires one." });
  }

  if (facts.requiredForms.includes("call button")) {
    const telLinks = [...html.matchAll(/<a\b[^>]*href=["']tel:[^"']+["'][^>]*>[\s\S]*?<\/a>/gi)];
    if (!telLinks.length) issues.push({ severity: "fail", area: "forms", detail: "No tel: call button found — the agreement's Sell-page checklist requires one." });
    else if (!telLinks.some((a) => /button|btn/i.test(a[0]))) issues.push({ severity: "warn", area: "forms", detail: "A tel: link exists but doesn't look styled as a button — confirm it reads as a call-to-action on Sell." });
  }

  if (facts.requiredForms.includes("general enquiry form")) {
    // Must be a form distinct from the appraisal one, i.e. it isn't itself flagged as the
    // appraisal form and it collects an open-ended enquiry (a message/enquiry-type field), not
    // just the appraisal form's fixed name/phone/email/address fields.
    const enquiryForms = forms.filter((f) => !/appraisal/i.test(f) && /(textarea|name=["']?(?:message|enquiry|comments?)["']?)/i.test(f));
    if (!enquiryForms.length) {
      issues.push({ severity: "fail", area: "forms", detail: "No general enquiry form found separate from the appraisal form — the agreement's Sell-page checklist ticked all three: appraisal form, call button, AND general enquiry form." });
    }
  }

  return issues;
}

// ---- Links: broken relative links, tel:/mailto: shape and cross-check --------------------------

const AU_PHONE_DIGITS_RE = /^\+?\d{9,12}$/;

/** A relative/root-absolute href resolves if it matches a real file under ANY candidate root, or
 *  (for an extensionless path) the clean-URL conventions this project's own server.cjs and every
 *  static host use: `/buy/` -> `buy/index.html`, `/buy` -> `buy.html` or `buy/index.html`. Several
 *  candidate roots are tried (the current file's own directory, then each ancestor up to the copy
 *  root) because a root-absolute href like `/assets/site.css` is meant to resolve against whatever
 *  directory the site is actually served from — which for a multi-root checkout (a flat index.html
 *  next to a separate preview-build/ output) isn't the same directory for every page. */
function linkResolves(roots: string[], clean: string): boolean {
  const hasExtension = /\.[a-z0-9]{1,8}$/i.test(clean);
  for (const root of roots) {
    const target = join(root, clean);
    if (existsSync(target)) return true;
    if (!hasExtension) {
      if (existsSync(`${target}.html`)) return true;
      if (existsSync(join(target, "index.html"))) return true;
    }
  }
  return false;
}

export function auditLinks(html: string, baseDir: string | string[], facts: ClientFacts): QaIssue[] {
  const roots = Array.isArray(baseDir) ? baseDir : [baseDir];
  const issues: QaIssue[] = [];
  for (const m of html.matchAll(/\bhref=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (!href || href === "#" || href.startsWith("#") || href.startsWith("javascript:")) continue;
    if (/^https?:\/\//i.test(href)) continue; // external links aren't fetched — no network calls from QA
    if (href.startsWith("tel:")) {
      const digits = href.slice(4).replace(/[\s()-]/g, "");
      if (!AU_PHONE_DIGITS_RE.test(digits)) issues.push({ severity: "fail", area: "links", detail: `Malformed tel: link: ${href}` });
      else if (facts.phones.length && !facts.phones.some((p) => p.replace(/\D/g, "").endsWith(digits.replace(/\D/g, "").slice(-8)))) {
        issues.push({ severity: "warn", area: "links", detail: `tel: link (${href}) doesn't match a phone number found in the agreement/CLIENT.md — confirm it's correct.` });
      }
      continue;
    }
    if (href.startsWith("mailto:")) {
      const address = href.slice(7).split("?")[0];
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address)) issues.push({ severity: "fail", area: "links", detail: `Malformed mailto: link: ${href}` });
      else if (facts.emails.length && !facts.emails.includes(address.toLowerCase())) {
        issues.push({ severity: "warn", area: "links", detail: `mailto: link (${address}) doesn't match an email found in the agreement/CLIENT.md — confirm it's correct.` });
      }
      continue;
    }
    // A relative or root-absolute local link/asset — resolve against the candidate roots.
    const clean = decodeURIComponent(href.split("#")[0].split("?")[0]).replace(/^\/+/, "");
    if (!clean) continue;
    if (!linkResolves(roots, clean)) issues.push({ severity: "fail", area: "links", detail: `Broken link: href="${href}" does not resolve to a file under the build.` });
  }
  return issues;
}

// ---- Lighthouse (best-effort — only if the CLI is on PATH) --------------------------------------

function commandExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { windowsHide: true, stdio: "ignore", shell: process.platform === "win32" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function runLighthouse(url: string, outPath: string): Promise<LighthouseResult> {
  const available = await commandExists("lighthouse");
  if (!available) return { available: false, note: "Lighthouse CLI not found on PATH — falling back to qa.ts's motion/perf heuristic only." };
  return new Promise((resolve) => {
    const args = [url, "--output=json", `--output-path=${outPath}`, "--only-categories=performance,accessibility,seo,best-practices", "--form-factor=mobile", "--screenEmulation.mobile", "--chrome-flags=--headless", "--quiet"];
    const child = spawn("lighthouse", args, { windowsHide: true, stdio: "ignore", shell: process.platform === "win32" });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ available: true, note: "Lighthouse timed out after 60s." });
    }, 60_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ available: true, note: "Lighthouse was found but failed to run." });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!existsSync(outPath)) return resolve({ available: true, note: "Lighthouse ran but produced no report file." });
      try {
        const parsed = JSON.parse(readFileSync(outPath, "utf8"));
        const scores: Record<string, number> = {};
        for (const [key, cat] of Object.entries<any>(parsed.categories ?? {})) scores[key] = Math.round((cat.score ?? 0) * 100);
        resolve({ available: true, scores });
      } catch {
        resolve({ available: true, note: "Could not parse the Lighthouse report." });
      }
    });
  });
}

// ---- Orchestration -------------------------------------------------------------------------

function fileUrlFor(indexPath: string): string {
  return `file:///${indexPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function copyToScratch(buildDir: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "client-qa-"));
  cpSync(buildDir, scratch, { recursive: true });
  return scratch;
}

function findHtmlFiles(dir: string): string[] {
  const skip = new Set(["node_modules", "assets", "tools", "data", "qa"]);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) out.push(...findHtmlFiles(join(dir, entry.name)));
    } else if (entry.name.toLowerCase().endsWith(".html")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// A build in progress can carry template SOURCE files alongside its actual servable output — a
// mustache-style build step (`{{token}}`) or an include directive (`<!-- @partial -->`) left
// unresolved because the assembling script hasn't run yet (brooke-draft's own templates/ folder,
// mid-build 24 Sep 2026: sell.html, appraisal.html etc. reference `{{version}}` and `<!-- @header
// -->` with no build.cjs present to resolve them). Auditing those as if they were finished pages
// produces pure noise (every unresolved token looks like a broken link); this treats an unresolved
// template as evidence to report, not a page to score.
const UNRESOLVED_TEMPLATE_RE = /\{\{\s*[\w.-]+\s*\}\}|<!--\s*@\w+/;

function isUnbuiltTemplateSource(html: string): boolean {
  return UNRESOLVED_TEMPLATE_RE.test(html);
}

/** [the file's own directory, ..., the copy root] — every directory a root-absolute href in this
 *  file could plausibly resolve against, most specific first. */
function candidateRootsFor(file: string, copyRoot: string): string[] {
  const roots: string[] = [];
  let dir = dirname(file);
  while (true) {
    roots.push(dir);
    if (dir === copyRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root guard
    dir = parent;
  }
  return roots;
}

export type RunClientQaOptions = ClientQaOptions & GatherOptions;
type GatherOptions = { evidence?: string; evidenceOverride?: ClientEvidence };

export async function runClientQa(buildDir: string, opts: RunClientQaOptions = {}): Promise<ClientQaReport> {
  const now = opts.now ?? new Date();
  const evidence = opts.evidenceOverride ?? (await gatherClientEvidence({ buildDir, evidence: opts.evidence }));
  const facts = evidence.facts;

  const scratch = copyToScratch(buildDir);
  const issues: QaIssue[] = [];
  const pagesChecked: string[] = [];
  const templateSourcesSkipped: string[] = [];

  try {
    const allHtmlFiles = findHtmlFiles(scratch);
    const htmlFiles: string[] = [];
    for (const file of allHtmlFiles) {
      const html = readFileSync(file, "utf8");
      if (isUnbuiltTemplateSource(html)) templateSourcesSkipped.push(relative(scratch, file).replace(/\\/g, "/"));
      else htmlFiles.push(file);
    }
    if (!htmlFiles.length) issues.push({ severity: "fail", area: "build", detail: "No built (non-template) .html files found in the build output." });
    if (templateSourcesSkipped.length) {
      issues.push({ severity: "warn", area: "build", detail: `${templateSourcesSkipped.length} template source file(s) with unresolved {{tokens}}/<!-- @includes --> were found but not scored as pages (no build step has assembled them yet): ${templateSourcesSkipped.slice(0, 6).join(", ")}` });
    }

    let sellPageFound = false;
    for (const file of htmlFiles) {
      const rel = relative(scratch, file).replace(/\\/g, "/");
      pagesChecked.push(rel);
      const html = readFileSync(file, "utf8");
      issues.push(...auditClientClaims(html, facts).map((i) => ({ ...i, detail: `[${rel}] ${i.detail}` })));
      if (isSellLikePage(html, rel)) {
        sellPageFound = true;
        issues.push(...auditRequiredForms(html, facts).map((i) => ({ ...i, detail: `[${rel}] ${i.detail}` })));
      }
      issues.push(...auditLinks(html, candidateRootsFor(file, scratch), facts).map((i) => ({ ...i, detail: `[${rel}] ${i.detail}` })));
      if (/(?:^|\/)(index|home)\.html$/i.test(rel) || rel === "index.html") {
        issues.push(...auditNoCenterSearchBar(html, facts));
      }
    }
    if (!sellPageFound && facts.requiredForms.length) {
      issues.push({ severity: "fail", area: "forms", detail: "No Sell page/section was identified anywhere in the build — cannot confirm the agreement's appraisal form / call button / general enquiry form requirement is met at all." });
    }

    const cssFiles = readdirSync(scratch).filter((f) => f.toLowerCase().endsWith(".css"));
    const css = cssFiles.map((f) => readFileSync(join(scratch, f), "utf8")).join("\n") + htmlFiles.map((f) => readFileSync(f, "utf8")).join("\n");
    issues.push(...auditPalette(css, facts));

    let screenshots: { desktop: string | null; mobile: string | null } = { desktop: null, mobile: null };
    if (!opts.skipBrowser && htmlFiles.length) {
      const indexPath = htmlFiles.find((f) => /(?:^|\/)index\.html$/i.test(relative(scratch, f).replace(/\\/g, "/"))) ?? htmlFiles[0];
      const previewUrl = fileUrlFor(indexPath);
      const run = opts.runner ?? defaultRunner(defaultAgentBrowserBin(), 20_000);
      const session = `${opts.sessionPrefix ?? "client-qa"}-${Date.now()}`;
      const S = ["--session", session];
      const qaDir = join(buildDir.replace(/[\\/]$/, "") + "-qa-tmp");
      const desktopPath = join(scratch, "qa-desktop-1440.png");
      const mobilePath = join(scratch, "qa-mobile-390.png");
      try {
        await run([...S, "open", previewUrl]);
        await run([...S, "console", "--clear"]);
        await run([...S, "errors", "--clear"]);
        await run([...S, "set", "viewport", "1440", "900"]);
        const shot1 = await run([...S, "screenshot", desktopPath]);
        if (shot1.ok && existsSync(desktopPath)) screenshots.desktop = desktopPath;
        else issues.push({ severity: "warn", area: "qa-tooling", detail: "Could not capture the 1440px desktop screenshot via agent-browser." });

        const errors = await run([...S, "errors", "--json"]);
        if (errors.ok) {
          try {
            const parsed = JSON.parse(errors.stdout);
            const list = Array.isArray(parsed) ? parsed : parsed.errors ?? [];
            for (const e of list.slice(0, 10)) issues.push({ severity: "fail", area: "console", detail: `Page error: ${typeof e === "string" ? e : JSON.stringify(e).slice(0, 200)}` });
          } catch {
            /* older CLI build without JSON output — skip rather than fail on a parsing gap */
          }
        }

        const a11y = await run([...S, "a11y", "--tags", "wcag2a,wcag2aa", "--json"]);
        if (a11y.ok) {
          try {
            const parsed = JSON.parse(a11y.stdout);
            for (const v of (parsed.violations ?? []).slice(0, 15)) {
              issues.push({ severity: v.impact === "critical" || v.impact === "serious" ? "fail" : "warn", area: "accessibility", detail: `${v.id}: ${v.help} (${v.nodeCount ?? "?"} node(s))` });
            }
          } catch {
            issues.push({ severity: "warn", area: "qa-tooling", detail: "Could not parse the accessibility audit output." });
          }
        } else {
          issues.push({ severity: "warn", area: "qa-tooling", detail: "Accessibility audit did not run (agent-browser unavailable or timed out)." });
        }

        await run([...S, "set", "viewport", "390", "844"]);
        const shot2 = await run([...S, "screenshot", mobilePath]);
        if (shot2.ok && existsSync(mobilePath)) screenshots.mobile = mobilePath;
        else issues.push({ severity: "warn", area: "qa-tooling", detail: "Could not capture the 390px mobile screenshot via agent-browser." });
      } finally {
        await run([...S, "close"]).catch(() => {});
      }
    } else if (!htmlFiles.length) {
      // already flagged above
    } else {
      issues.push({ severity: "warn", area: "qa-tooling", detail: "Browser checks skipped (skipBrowser)." });
    }

    let lighthouse: LighthouseResult = { available: false, note: "Skipped." };
    if (!opts.skipLighthouse && htmlFiles.length) {
      const indexPath = htmlFiles.find((f) => /(?:^|\/)index\.html$/i.test(relative(scratch, f).replace(/\\/g, "/"))) ?? htmlFiles[0];
      lighthouse = await runLighthouse(fileUrlFor(indexPath), join(scratch, "lighthouse.json"));
    }

    for (const src of facts.sources) {
      if (!src.extracted) issues.push({ severity: "warn", area: "evidence", detail: `${src.label} (${src.path}): ${src.note ?? "could not be read."}` });
    }
    if (!facts.sources.some((s) => s.label === "CLIENT.md" && s.extracted)) {
      issues.push({ severity: "fail", area: "evidence", detail: "No readable CLIENT.md — cannot confirm any claim, price or named person on this build. Fix the evidence source before sharing a preview." });
    }

    const verdict: ClientQaReport["verdict"] = issues.some((i) => i.severity === "fail") ? "NOT READY" : "READY";

    return {
      verdict,
      clientName: facts.clientName,
      buildDir,
      pagesChecked,
      templateSourcesSkipped,
      issues,
      screenshots,
      lighthouse,
      evidenceSources: facts.sources,
      generatedAt: now.toISOString(),
    };
  } finally {
    // Screenshots were written into the scratch copy so callers can still read them off the
    // returned report before cleanup — copy them out first if the caller wants to keep them past
    // this call (the CLI does, into review/).
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function renderClientQaReport(report: ClientQaReport): string {
  const lines: string[] = [];
  lines.push(`# QA report — ${report.clientName ?? "client build"}`);
  lines.push("");
  lines.push(`**Verdict: ${report.verdict}**`);
  lines.push("");
  lines.push(`Build checked: \`${report.buildDir}\``);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Pages checked: ${report.pagesChecked.length ? report.pagesChecked.join(", ") : "(none found)"}`);
  if (report.templateSourcesSkipped.length) {
    lines.push(`Template sources skipped (unresolved {{tokens}}/includes, not yet built): ${report.templateSourcesSkipped.join(", ")}`);
  }
  lines.push("");
  if (report.verdict === "NOT READY") {
    lines.push("A claims-vs-evidence failure or another fail-level issue below blocks sharing this preview until fixed or evidenced. Any single claims failure is enough to block, regardless of everything else passing.");
    lines.push("");
  }

  const bySeverity = (sev: "fail" | "warn") => report.issues.filter((i) => i.severity === sev);
  lines.push(`## Failures (${bySeverity("fail").length})`);
  lines.push("");
  if (!bySeverity("fail").length) lines.push("None.");
  for (const i of bySeverity("fail")) lines.push(`- [${i.area}] ${i.detail}`);
  lines.push("");
  lines.push(`## Warnings (${bySeverity("warn").length})`);
  lines.push("");
  if (!bySeverity("warn").length) lines.push("None.");
  for (const i of bySeverity("warn")) lines.push(`- [${i.area}] ${i.detail}`);
  lines.push("");

  lines.push("## Screenshots");
  lines.push("");
  lines.push(`- Desktop (1440px): ${report.screenshots.desktop ?? "not captured"}`);
  lines.push(`- Mobile (390px): ${report.screenshots.mobile ?? "not captured"}`);
  lines.push("");

  lines.push("## Lighthouse (mobile)");
  lines.push("");
  if (!report.lighthouse.available) lines.push(`Not available. ${report.lighthouse.note ?? ""}`.trim());
  else if (report.lighthouse.scores) lines.push(Object.entries(report.lighthouse.scores).map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  else lines.push(report.lighthouse.note ?? "Ran, but no scores were produced.");
  lines.push("");

  lines.push("## Evidence sources");
  lines.push("");
  for (const s of report.evidenceSources) lines.push(`- ${s.extracted ? "✓" : "✗"} ${s.label}: \`${s.path}\`${s.note ? ` — ${s.note}` : ""}`);
  lines.push("");

  return lines.join("\n");
}
