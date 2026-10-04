import { FIXTURE_ENTRY, FIXTURE_NAME, FIXTURE_PAGES } from "./audit-fixture";
import { Halt, WORKFLOW_LABEL, cut, gate, haltResult, makeProgress, mustCall, note, pullFile, tryCall, type WorkflowIO, type WorkflowResult } from "./common";

/**
 * Website audit: look at a site the way a visitor would, at a desktop and a phone width, and say what would stop or annoy them, most important first,
 * with a screenshot beside each finding. READ-ONLY: it opens pages, measures them and photographs them. It never clicks, types, fills or submits
 * anything; forms are counted, not touched; it never logs in; it follows only same-site links it has read, and only to read them.
 *
 * Authorised targets only: the exact host names the hub is configured with (default: M&U's own public demo site) or the built-in local fixture, a
 * synthetic clinic site written into the computer's own working folder with problems planted in it (audit-fixture.ts). Anything else is refused
 * before a computer is touched.
 *
 *   1 open       the home page (a public page in the computer's browser, or the fixture from its own folder)
 *   2 desktop    1280 x 800: measured and photographed
 *   3 phone      390 x 844 (mobile emulation): measured and photographed
 *   4 journeys   the home page's links are checked (a read-only GET each, or "is the file there" for the fixture), and the contact and service
 *                pages a visitor would go to are opened and read at phone width too
 *   5 report     prioritised findings, each with its evidence and screenshot; the report says what was NOT checked (contrast, keyboard order, speed)
 */

export const AUDIT_EXECUTOR = "audit";
export const AUDIT_STEPS = ["open the site", "desktop", "phone", "journeys", "report"] as const;
export const DEFAULT_AUDIT_SITES = ["dental-care-plus.muventures.com.au"];
export const DESKTOP = { width: 1280, height: 800 };
export const PHONE = { width: 390, height: 844 };

export type AuditParams = { url?: string; fixture?: string; allowedHosts?: string[] };
export type Target = { kind: "site"; url: URL; label: string } | { kind: "fixture"; label: string };

/** Which target a request names, or why it is refused. Pure. The hosts are exact names (no wildcard), so a sibling site is never audited by accident. */
export function resolveTarget(params: AuditParams, allowed: string[] = DEFAULT_AUDIT_SITES): { ok: true; target: Target } | { ok: false; reason: string } {
  if (typeof params.fixture === "string" && params.fixture.trim()) {
    return params.fixture.trim().toLowerCase() === FIXTURE_NAME ? { ok: true, target: { kind: "fixture", label: "the local demo clinic fixture (synthetic)" } } : { ok: false, reason: `There is one built-in fixture, "${FIXTURE_NAME}".` };
  }
  let url: URL;
  try {
    url = new URL(String(params.url ?? "").trim());
  } catch {
    return { ok: false, reason: "That is not a web address, so there is nothing to audit." };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:") return { ok: false, reason: "Only https pages are audited." };
  if (url.username || url.password) return { ok: false, reason: "No credentials in the address." };
  if (url.port && url.port !== "443") return { ok: false, reason: "Only the standard https port is audited." };
  if (/brooke/i.test(host)) return { ok: false, reason: "That site is not one of M&U's own demo sites, so it is not audited." };
  if (!allowed.map((h) => h.toLowerCase()).includes(host)) return { ok: false, reason: `${host} is not on the list of sites this OS may audit (${allowed.join(", ")}). Only M&U's own public demo sites, or the local fixture, are audited.` };
  url.hash = "";
  return { ok: true, target: { kind: "site", url, label: host } };
}

export type Analysis = {
  ok?: boolean; title: string; lang: string; viewportMeta: string; url: string; viewport: { w: number; h: number }; scrollWidth: number; overflowX: number; pageHeight: number; h1: number; headings: string[];
  links: { text: string; href: string; w: number; h: number; top: number; sameSite: boolean }[]; linksWithoutName: number; tel: boolean; controls: number; smallTargets: number; smallTargetSamples: string[]; controlsWithoutName: number;
  images: number; imagesNoAlt: number; imagesBroken: number; brokenImageSamples: string[]; smallestText: number | null; smallTextElements: number; textElements: number; forms: number; fields: number; fieldsNoLabel: number;
  cta: { text: string; top: number; aboveFold: boolean }[]; ctaAboveFold: boolean; hasNav: boolean;
};
export type PageRead = { page: string; device: "desktop" | "phone"; width: number; analysis: Analysis; shot: string | null };
export type LinkCheck = { from: string; text: string; target: string; status: number | null; ok: boolean; note: string };
export type Finding = { priority: 1 | 2 | 3; title: string; evidence: string; page: string; device: string; shot: string | null; /** A title with nothing the page wrote in it: the only form that goes into a conversation entry. */ short?: string };

/**
 * A link or page address on the audited site, or null. EXACT host (no sibling, look-alike or sub-domain), https only, the standard port, no credentials.
 * Every address the audit opens or checks passes this on the hub; the page's own idea of "same site" is never trusted. Pure.
 */
export function authorisedUrl(href: string, site: string): URL | null {
  let u: URL;
  let base: URL;
  try {
    u = new URL(href);
    base = new URL(site);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  if (u.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  u.hash = "";
  return u;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Text the page controls, made safe to put in a report or a line: no control characters or newlines, no markdown link, table or heading characters, capped. Pure. */
export function safeText(v: unknown, n: number): string {
  return typeof v === "string" ? v.replace(CONTROL, " ").replace(/[\[\]|`*#<>\\]/g, "").replace(/\s+/g, " ").trim().slice(0, n) : "";
}
const num = (v: unknown, max = 100_000): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0);
const bool = (v: unknown) => v === true;
/** A plain file name a file address names (to check that it exists), or null. Never throws. */
export function fileNameOf(href: string): string | null {
  let name = "";
  try {
    name = decodeURIComponent(href.replace(/^file:\/\/.*\//, "").replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : null;
}
/** The fixture page name a file address names (one of the built-in pages, the only files that are ever OPENED), or null. */
export function fixtureNameOf(href: string): string | null {
  const name = fileNameOf(href);
  return name && Object.prototype.hasOwnProperty.call(FIXTURE_PAGES, name) ? name : null;
}

export type Scope = { kind: "site"; host: string; label?: string } | { kind: "fixture"; label?: string };
/**
 * The in-page read is DATA from a page we do not control. It is rebuilt field by field (types checked, numbers clamped, strings cleaned and capped, lists
 * capped), its "same site" flags are recomputed here, and the address the page was at must be the authorised site (or one of the fixture's own files):
 * a late redirect or script navigation ends the audit of that page rather than being reported under the allowed host. Pure.
 */
export function sanitizeAnalysis(raw: unknown, scope: Scope): { ok: true; analysis: Analysis } | { ok: false; reason: string } {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object" || a.ok !== true || typeof a.title !== "string" || typeof a.url !== "string") return { ok: false, reason: "the computer's measurements were not in the expected shape" };
  const url = String(a.url);
  const site = scope.kind === "site" ? "https://" + scope.host : "";
  if (scope.kind === "site" && !authorisedUrl(url, site)) {
    let where = "another address";
    try {
      where = safeText(new URL(url).hostname, 60) || where;
    } catch {
      /* not an address */
    }
    return { ok: false, reason: "the page left the authorised site (it was at " + where + ")" };
  }
  if (scope.kind === "fixture" && !(/^file:\/\//.test(url) && fixtureNameOf(url))) return { ok: false, reason: "the page left the authorised site (it was not one of the fixture's own pages)" };
  const list = (v: unknown, n: number, len: number) => (Array.isArray(v) ? v.slice(0, n).map((x) => safeText(x, len)).filter(Boolean) : []);
  const vp = (a.viewport ?? {}) as Record<string, unknown>;
  const links: Analysis["links"] = [];
  for (const l of Array.isArray(a.links) ? a.links.slice(0, 30) : []) {
    const o = l as Record<string, unknown>;
    let u: URL;
    try {
      u = new URL(String(o.href ?? ""));
    } catch {
      continue;
    }
    links.push({ text: safeText(o.text, 50), href: u.href.slice(0, 120), w: num(o.w, 10_000), h: num(o.h, 10_000), top: num(o.top, 1_000_000), sameSite: scope.kind === "site" ? !!authorisedUrl(u.href, site) : u.protocol === "file:" && !!fileNameOf(u.href) });
  }
  const analysis: Analysis = {
    ok: true, title: safeText(a.title, 160), lang: safeText(a.lang, 12), viewportMeta: safeText(a.viewportMeta, 80), url: url.slice(0, 160), viewport: { w: num(vp.w, 20_000), h: num(vp.h, 20_000) },
    scrollWidth: num(a.scrollWidth, 1_000_000), overflowX: num(a.overflowX), pageHeight: num(a.pageHeight, 10_000_000), h1: num(a.h1, 1000), headings: list(a.headings, 14, 70),
    links, linksWithoutName: num(a.linksWithoutName, 1000), tel: bool(a.tel), controls: num(a.controls, 100_000), smallTargets: num(a.smallTargets, 100_000), smallTargetSamples: list(a.smallTargetSamples, 5, 60), controlsWithoutName: num(a.controlsWithoutName, 100_000),
    images: num(a.images, 100_000), imagesNoAlt: num(a.imagesNoAlt, 100_000), imagesBroken: num(a.imagesBroken, 100_000), brokenImageSamples: list(a.brokenImageSamples, 3, 80),
    smallestText: typeof a.smallestText === "number" && Number.isFinite(a.smallestText) ? Math.min(999, Math.max(0, a.smallestText)) : null, smallTextElements: num(a.smallTextElements, 100_000), textElements: num(a.textElements, 100_000),
    forms: num(a.forms, 10_000), fields: num(a.fields, 100_000), fieldsNoLabel: num(a.fieldsNoLabel, 100_000),
    cta: (Array.isArray(a.cta) ? a.cta.slice(0, 4) : []).map((c) => ({ text: safeText((c as Record<string, unknown>).text, 40), top: num((c as Record<string, unknown>).top, 1_000_000), aboveFold: bool((c as Record<string, unknown>).aboveFold) })),
    ctaAboveFold: bool(a.ctaAboveFold), hasNav: bool(a.hasNav),
  };
  return { ok: true, analysis };
}

const PRIORITY_WORDS = ["", "Fix first: a visitor is blocked or misled", "Should fix: a visitor is made to work harder", "Minor"];

/** Findings from what was measured, most important first. Pure: the same reads always give the same findings. */
export function buildFindings(reads: PageRead[], links: LinkCheck[]): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => {
    const dup = out.find((x) => x.title === f.title && x.page === f.page);
    if (dup) {
      if (!dup.device.includes(f.device)) dup.device = `${dup.device} and ${f.device}`;
      return;
    }
    out.push(f);
  };
  for (const r of reads) {
    const a = r.analysis;
    const phone = r.device === "phone";
    const f = (priority: 1 | 2 | 3, title: string, evidence: string) => add({ priority, title, evidence, page: r.page, device: r.device, shot: r.shot });
    if (!a.title.trim()) f(1, "The page has no title", "document.title is empty, so browser tabs, bookmarks and search results show no name.");
    if (phone && a.overflowX > 8) f(1, "The page is wider than a phone screen", `At ${r.width} px wide the page scrolls sideways by ${a.overflowX} px (its content is ${a.scrollWidth} px wide), so visitors have to pan to read it.`);
    if (phone && !a.viewportMeta) f(1, "No mobile viewport setting", `The page has no viewport setting, so a phone lays it out ${a.viewport.w} px wide instead of ${r.width} px and shrinks everything.`);
    if (a.imagesBroken > 0) f(1, `${a.imagesBroken} image${a.imagesBroken === 1 ? "" : "s"} failed to load`, `Broken: ${a.brokenImageSamples.join(", ") || "see screenshot"}.`);
    if (r.page === "home" && a.cta.length === 0 && !a.tel) f(1, "No way to book or contact is offered on the home page", "No visible button or link says book, contact, call, enquire, quote or schedule, and there is no phone link.");
    else if (r.page === "home" && phone && !a.ctaAboveFold && !a.tel) f(2, "The way to book or contact is below the first phone screen", `The first one (\"${a.cta[0]?.text ?? ""}\") starts ${a.cta[0]?.top ?? "?"} px down; the phone screen is ${r.width === PHONE.width ? PHONE.height : "shorter"} px high.`);
    if (phone && a.smallTargets >= 3) f(2, "Tap targets are too small for a thumb", `${a.smallTargets} of ${a.controls} tappable items are under 32 px on their smaller side (${a.smallTargetSamples.slice(0, 3).join("; ")}).`);
    else if (phone && a.smallTargets > 0) f(3, "A few tap targets are small", `${a.smallTargets} tappable item${a.smallTargets === 1 ? " is" : "s are"} under 32 px (${a.smallTargetSamples.slice(0, 2).join("; ")}).`);
    if (a.smallTextElements > 0 && a.smallestText !== null) f(a.smallTextElements > 3 ? 2 : 3, "Some text is too small to read comfortably", `The smallest text is ${a.smallestText} px; ${a.smallTextElements} of ${a.textElements} text blocks are under 12 px.`);
    if (a.imagesNoAlt > 0) f(2, `${a.imagesNoAlt} image${a.imagesNoAlt === 1 ? " has" : "s have"} no alt text`, "A screen reader announces these as an unnamed image, and they are blank if the picture does not load.");
    if (a.fieldsNoLabel > 0) f(2, `${a.fieldsNoLabel} form field${a.fieldsNoLabel === 1 ? " has" : "s have"} no label`, `${a.fieldsNoLabel} of ${a.fields} fields rely on placeholder text alone, which disappears when typing and is not read as a label. (The form was not filled or submitted.)`);
    if (a.linksWithoutName > 0) f(2, `${a.linksWithoutName} link${a.linksWithoutName === 1 ? " has" : "s have"} no readable name`, "A link with no text or label cannot be understood out of context.");
    if (a.h1 === 0) f(3, "The page has no main heading", "No h1 element, so the page's subject is not marked up.");
    if (a.h1 > 1) f(3, `The page has ${a.h1} main headings`, "More than one h1 element; one per page is the usual rule.");
    if (!a.lang) f(3, "The page does not say what language it is in", "No lang attribute on the html element.");
  }
  for (const l of links) if (!l.ok) add({ priority: 1, short: "Broken link", title: `Broken link: "${cut(safeText(l.text || l.target, 40), 40)}"`, evidence: `On ${l.from}, this link goes to ${cut(l.target, 80)}, which ${l.status === null ? l.note : `answers HTTP ${l.status} (${l.note})`}. A visitor following it reaches a dead end.`, page: l.from, device: "any", shot: null });
  return out.sort((a, b) => a.priority - b.priority);
}

const KEY_LINK = /\b(?:contact|book|appointment|enquir|price|pricing|fees?|services?|treatments?|about|team)\b/i;
/** The links worth checking and the pages worth opening, from the home page's own links. Pure. */
export function pickJourney(links: Analysis["links"], pageUrl: string): { check: Analysis["links"]; open: Analysis["links"] } {
  const seen = new Set<string>();
  const uniq = links.filter((l) => {
    const key = l.href.replace(/#.*$/, "");
    if (!l.sameSite || !key || key === pageUrl.replace(/#.*$/, "") || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const key = uniq.filter((l) => KEY_LINK.test(l.text) || KEY_LINK.test(l.href));
  const rest = uniq.filter((l) => !key.includes(l));
  return { check: [...key, ...rest].slice(0, 12), open: key.slice(0, 2) };
}

const dev = (d: string) => (d === "phone" ? "phone" : d);
function reportMarkdown(input: { target: Target; findings: Finding[]; reads: PageRead[]; links: LinkCheck[]; shots: Set<string>; notes: string[] }): string {
  const { findings } = input;
  const counts = [1, 2, 3].map((p) => findings.filter((f) => f.priority === p).length);
  const lines: string[] = [
    `# Website audit: ${input.target.label}`,
    "",
    "**Read-only.** Pages were opened, measured and photographed at a desktop and a phone width. Nothing was clicked, typed, filled in or submitted, and nobody was logged in.",
    "",
    "## At a glance",
    `- ${counts[0]} to fix first, ${counts[1]} that should be fixed, ${counts[2]} minor.`,
    `- ${input.reads.length} page view${input.reads.length === 1 ? "" : "s"} measured (${[...new Set(input.reads.map((r) => `${r.page} on ${dev(r.device)}`))].join(", ")}); ${input.links.length} link${input.links.length === 1 ? "" : "s"} checked, ${input.links.filter((l) => !l.ok).length} broken.`,
    ...input.notes.map((n) => `- ${n}`),
    "",
    "## Findings, most important first",
  ];
  if (!findings.length) lines.push("Nothing that would stop or annoy a visitor was found in what was measured.");
  findings.forEach((f, i) => {
    lines.push("", `### ${i + 1}. P${f.priority}: ${f.title}`, `*${PRIORITY_WORDS[f.priority]}. Seen on the ${f.page} page${f.device === "any" ? "" : `, ${f.device}`}.*`, "", f.evidence);
    if (f.shot && input.shots.has(f.shot)) lines.push("", `![${f.page} on ${f.device}](${f.shot})`);
  });
  lines.push("", "## Screenshots", ...input.reads.filter((r) => r.shot && input.shots.has(r.shot)).flatMap((r) => [`**${r.page}, ${dev(r.device)} (${r.width} px)**`, "", `![${r.page} ${r.device}](${r.shot})`, ""]));
  lines.push("## Links checked", "", "| From | Link | Goes to | Result |", "| --- | --- | --- | --- |", ...input.links.map((l) => `| ${l.from} | ${cut(l.text || "(no text)", 30).replace(/\|/g, "/")} | ${cut(l.target, 50).replace(/\|/g, "/")} | ${l.ok ? "OK" : "BROKEN"}: ${l.status === null ? l.note : `HTTP ${l.status}`} |`));
  lines.push("", "## Not checked", "- Colour contrast and keyboard order (they need a different read).", "- Speed under a slow connection.", "- Anything behind a login, and what happens after a form is submitted (forms are never submitted).");
  return lines.join("\n");
}

/** A page (or its address) was not the authorised site: that page is dropped from the audit, never reported under the allowed host. */
class LeftSite extends Error {}

export async function runAudit(input: { params: AuditParams; io: WorkflowIO; limits?: { wallMs?: number } }): Promise<WorkflowResult> {
  const { io } = input;
  const clock = io.now ?? Date.now;
  const t0 = clock();
  const wallMs = input.limits?.wallMs ?? 6 * 60_000;
  const over = () => clock() - t0 > wallMs;
  const mark = makeProgress(io, "audit", AUDIT_STEPS);
  const resolved = resolveTarget(input.params, input.params.allowedHosts ?? DEFAULT_AUDIT_SITES);
  if (!resolved.ok) return { ok: false, outcome: "failed", note: `${resolved.reason} Nothing was opened.`, wallMs: 0 };
  const target = resolved.target;
  const allowed = input.params.allowedHosts ?? DEFAULT_AUDIT_SITES;
  const scope: Scope = target.kind === "site" ? { kind: "site", host: target.url.hostname.toLowerCase(), label: target.label } : { kind: "fixture", label: target.label };
  const siteOrigin = target.kind === "site" ? target.url.origin : "";
  const reads: PageRead[] = [];
  const links: LinkCheck[] = [];
  const notes: string[] = [];
  try {
    // 1 open
    mark(0, "started", `Opening ${target.label}`);
    let tabId = "";
    const openPage = async (what: { url?: string; file?: string }, label: string): Promise<string | null> => {
      // EVERY page this audit opens passes the allow-list again on the hub: exact host and port, https, the audited host and no other.
      if (what.url) {
        const again = resolveTarget({ url: what.url }, allowed);
        if (!again.ok || again.target.kind !== "site" || again.target.url.hostname.toLowerCase() !== (scope as { host: string }).host) throw new Halt("failed", "A page outside the authorised site was about to be opened, so nothing further was opened.");
      }
      if (what.file && !Object.prototype.hasOwnProperty.call(FIXTURE_PAGES, what.file)) throw new Halt("failed", "That is not one of the fixture's own pages, so it was not opened.");
      const r = what.file
        ? await tryCall(io, "fixture.open", { name: what.file }, `open ${label}`, over)
        : await tryCall(io, "browser.navigate", { url: what.url }, `open ${label}`, over, { timeoutMs: 60_000 });
      if (r.kind === "failed") return null;
      const t = (r.data as { tabId?: unknown } | undefined)?.tabId;
      return typeof t === "string" ? t : "";
    };
    if (target.kind === "fixture") {
      for (const [name, text] of Object.entries(FIXTURE_PAGES)) await mustCall(io, "file.write", { name, text }, `write fixture ${name}`, over);
      const t = await openPage({ file: FIXTURE_ENTRY }, "the fixture home page");
      if (t === null) throw new Halt("failed", "The fixture home page did not open on the computer.");
      tabId = t;
    } else {
      const t = await openPage({ url: target.url.href }, target.label);
      if (t === null) throw new Halt("failed", `${target.label} did not open on the computer (the site refused it or did not answer), so there is nothing to audit.`);
      tabId = t;
    }
    mark(0, "done", `${target.label} is open`);

    // 2 desktop, 3 phone
    const readView = async (page: string, device: "desktop" | "phone", tab: string, size: { width: number; height: number }) => {
      const label = `${page}-${device}`;
      const r = await mustCall(io, "page.audit", { label, width: size.width, height: size.height, ...(tab ? { tabId: tab } : {}) }, `read ${page} at ${size.width} px`, over);
      const d = r.data as { analysis?: unknown; shot?: unknown } | undefined;
      if (!d?.analysis) throw new Halt("failed", `The computer returned no measurements for the ${page} page at ${size.width} px.`);
      const clean = sanitizeAnalysis(d.analysis, scope);
      if (!clean.ok) throw new LeftSite(`The ${page} page: ${clean.reason}, so the audit of it ended and nothing from that page is in this report.`);
      const read: PageRead = { page, device, width: size.width, analysis: clean.analysis, shot: typeof d.shot === "string" && /^shot-[a-z0-9-]{1,40}\.jpg$/.test(d.shot) ? d.shot : null };
      reads.push(read);
      return read;
    };
    mark(1, "started", `Measuring at ${DESKTOP.width} x ${DESKTOP.height}`);
    const home = await readView("home", "desktop", tabId, DESKTOP).catch((e) => {
      if (e instanceof LeftSite) throw new Halt("failed", e.message);
      throw e;
    });
    mark(1, "done", `Desktop: ${home.analysis.links.length} links, ${home.analysis.images} images, ${home.analysis.controls} controls read`);
    mark(2, "started", `Measuring at ${PHONE.width} x ${PHONE.height} (phone)`);
    const homePhone = await readView("home", "phone", tabId, PHONE);
    mark(2, "done", `Phone: ${homePhone.analysis.overflowX > 8 ? `the page scrolls sideways by ${homePhone.analysis.overflowX} px; ` : ""}${homePhone.analysis.smallTargets} small tap target${homePhone.analysis.smallTargets === 1 ? "" : "s"}`);

    // 4 journeys
    mark(3, "started", "Checking the links a visitor would follow");
    const journey = pickJourney(home.analysis.links, home.analysis.url);
    const items: Record<string, unknown>[] = [];
    const pairs: { text: string; target: string; item: Record<string, unknown> }[] = [];
    for (const l of journey.check) {
      let item: Record<string, unknown> | null = null;
      if (target.kind === "fixture") {
        const name = fileNameOf(l.href);
        if (name) item = { file: name };
      } else {
        const ok = authorisedUrl(l.href, siteOrigin);
        if (ok) item = { url: ok.href };
      }
      if (item) {
        items.push(item);
        pairs.push({ text: l.text, target: String(item.file ?? item.url), item });
      }
    }
    if (items.length) {
      const r = await mustCall(io, "page.links", { items }, `check ${items.length} links`, over);
      const results = ((r.data as { results?: { target: string; status: number | null; ok: boolean; note: string }[] } | undefined)?.results ?? []);
      for (const [i, res] of results.entries()) links.push({ from: "home", text: pairs[i]?.text ?? "", target: pairs[i]?.target ?? res.target, status: res.status, ok: res.ok, note: res.note });
    }
    // The pages a visitor would go to next, at phone width (a failed open is a finding already via the link check).
    let opened = 0;
    for (const l of journey.open) {
      // The address is judged here, again, before anything is opened: a link the page calls "same site" that is not (a look-alike host, another port) is skipped.
      const fixtureName = target.kind === "fixture" ? fixtureNameOf(l.href) : null;
      const siteUrl = target.kind === "site" ? authorisedUrl(l.href, siteOrigin) : null;
      if (!fixtureName && !siteUrl) continue;
      const lc = links.find((x) => x.target === (fixtureName ?? siteUrl!.href));
      if (lc && !lc.ok) continue;
      const pageName = cut(l.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page", 20) || "page";
      const t = fixtureName ? await openPage({ file: fixtureName }, pageName) : await openPage({ url: siteUrl!.href }, pageName);
      if (t === null) {
        notes.push(`The ${pageName} page did not open on the computer, so it was not measured.`);
        continue;
      }
      try {
        await readView(pageName, "phone", t, PHONE);
        opened++;
      } catch (e) {
        if (!(e instanceof LeftSite)) throw e;
        notes.push(e.message);
      }
    }
    mark(3, "done", `${links.length} link${links.length === 1 ? "" : "s"} checked (${links.filter((l) => !l.ok).length} broken); ${opened} more page${opened === 1 ? "" : "s"} read at phone width`);

    // 5 report: findings, then the pictures are brought back and the report is kept
    mark(4, "started", "Writing the findings and bringing the screenshots back");
    const findings = buildFindings(reads, links);
    const shots = new Map<string, Buffer>();
    let missing = 0;
    for (const r of reads) {
      if (!r.shot) continue;
      const b = await pullFile(io, r.shot, 2 * 1024 * 1024, over);
      if (b) shots.set(r.shot, b);
      else missing++;
    }
    if (missing) notes.push(`${missing} screenshot${missing === 1 ? "" : "s"} could not be brought back from the computer, so ${missing === 1 ? "it is" : "they are"} not in this report.`);
    const md = reportMarkdown({ target, findings, reads, links, shots: new Set(shots.keys()), notes });
    const p1 = findings.filter((f) => f.priority === 1).length;
    const summary = `${findings.length} finding${findings.length === 1 ? "" : "s"} (${p1} to fix first) on ${target.label}, desktop and phone, with ${shots.size} screenshot${shots.size === 1 ? "" : "s"}.`;
    const complete = missing === 0 && reads.some((r) => r.device === "desktop") && reads.some((r) => r.device === "phone");
    const saveRes = io.artifact({
      kind: "audit", title: `Website audit: ${cut(target.label, 60)}`, summary, outcome: complete ? "complete" : "partial", main: "audit.md",
      files: [{ name: "audit.md", data: md }, { name: "findings.json", data: JSON.stringify({ target: target.label, findings, links, reads: reads.map((r) => ({ page: r.page, device: r.device, width: r.width, shot: r.shot, analysis: { ...r.analysis, links: r.analysis.links.length } })) }, null, 2) }, ...[...shots].map(([name, data]) => ({ name, data }))],
    });
    const top = findings.slice(0, 3).map((f) => `P${f.priority} ${f.short ?? f.title}`).join("; ");
    const back = await io.deliver(`${WORKFLOW_LABEL.audit}: ${cut(target.label, 60)}\n${summary}${top ? `\nTop findings: ${top}.` : ""}\nRead-only: nothing was clicked, filled in or submitted.`, { artifact: saveRes.ok ? saveRes.title : null, label: WORKFLOW_LABEL.audit, web: target.kind === "site" }).catch(() => ({ delivered: false, where: "delivery failed" }));
    mark(4, saveRes.ok ? "done" : "failed", saveRes.ok ? `Saved result kept${back.delivered ? " and returned to your conversation" : ` (${back.where})`}` : `The result could not be kept on the hub (${saveRes.reason})`);
    note(io, "audit", `audit ${complete && saveRes.ok ? "complete" : "partial"}: ${findings.length} findings in ${Math.round((clock() - t0) / 1000)} s`, complete && saveRes.ok ? "ok" : "unknown");
    return { ok: true, outcome: complete && saveRes.ok ? "complete" : "partial", note: `Audit ${complete && saveRes.ok ? "ready" : "partly ready"}: ${summary}${notes.length ? ` ${notes[0]}` : ""}`, wallMs: clock() - t0 };
  } catch (e) {
    return haltResult(e, t0, clock);
  }
}
