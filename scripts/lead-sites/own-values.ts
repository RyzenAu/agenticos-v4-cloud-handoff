// What a preview's OWN verified details are, so the safety checks can tell a lead's own words from
// something the template left behind. A lawyer in Leichhardt, a dentist on Darling Street, a firm named
// Rowe, a service called "Family law" or "Small claims under $20,000" is the business's own text: the
// leak and claims checks must not read it as the flagship's identity or an invented price. They must
// still catch a flagship name that is NOT one of those values.
import { auditClaims, stripTags, type QaIssue } from "../site-draft/qa";
import type { Evidence } from "../site-draft/evidence";
import { namesStaff, readsAsClaim } from "./own-claims";
import { promisesIn } from "./promise-phrases";
import { bannerText, escapeHtml, exportSafe, hostOf, possessive, tokenValues, type PreviewFacts } from "./fill";
import { decodeEntities, ownPlacements, withoutOwn, type OwnField, type OwnValue, type Vertical } from "./templates";

/** Every string the lead itself supplied, in each form a page can carry (plain, HTML-escaped and
 *  the character-stripped form an export stores), plus the pieces the template splits them into
 *  (street and suburb lines of the address). */
export function ownTexts(facts: PreviewFacts, extra: string[] = []): string[] {
  const parts = facts.address ? facts.address.split(",").map((p) => p.trim()).filter(Boolean) : [];
  const base = [
    facts.business,
    possessive(facts.business),
    facts.suburb,
    facts.address,
    ...parts,
    parts.slice(1).join(", "),
    facts.phone,
    facts.email,
    facts.website,
    hostOf(facts.website),
    ...facts.services.map((s) => s.name),
    ...facts.services.map((s) => hostOf(s.sourceUrl)),
    ...extra,
  ];
  const out = new Set<string>();
  for (const v of base) {
    const t = (v ?? "").trim();
    if (t.length < 4) continue;
    out.add(t);
    out.add(escapeHtml(t));
    out.add(exportSafe(t));
  }
  return [...out];
}

/** `text` with the lead's own values taken out wherever they appear. */
export function withoutOwnTexts(text: string, own: string[]): string {
  return withoutOwn(text, own.map((value) => ({ value, mask: true as const })));
}

const TOKEN = /\{\{\{?[A-Z0-9_]+\}?\}\}/g;

/** The words fill put on a page that the template did not: the page text with the template's own
 *  fixed text (everything between its {{TOKENS}}) removed. A page of unchanged example content has none. */
export function novelText(templateHtml: string, filledHtml: string): string {
  const segments = stripTags(templateHtml).split(TOKEN).map((s) => s.trim()).filter((s) => s.length >= 3);
  const filled = stripTags(filledHtml);
  let cursor = 0;
  const novel: string[] = [];
  for (const seg of segments) {
    const at = filled.indexOf(seg, cursor);
    if (at < 0) continue; // text the fill changed in place stays in the text that is audited
    novel.push(filled.slice(cursor, at));
    cursor = at + seg.length;
  }
  novel.push(filled.slice(cursor));
  return novel.join(" ");
}

/** Claims the claims audit refuses, read from the text a fill ADDED and without the lead's own values:
 *  a published service "Small claims under $20,000" is the business's wording, not an invented price. */
export function auditAddedClaims(templateHtml: string, filledHtml: string, evidence: Evidence, own: string[]): QaIssue[] {
  const text = withoutOwnTexts(decodeEntities(novelText(templateHtml, filledHtml)), own);
  return auditClaims(text, evidence).filter((i) => i.severity === "fail");
}

/** Findings about example figures: a template's own example text (a suburb's median price, a "1 / 5" photo counter) says these
 *  on purpose and is labelled as example content, so only words fill ADDED are judged for them. */
const FIGURE_FINDING = /star rating|price or discount/;

/** The audit for a whole page: every kind of claim (awards, guarantees, testimonials, named staff, before/after, ratings, prices),
 *  with the lead's own values set aside. `example` keeps the figure findings out for a page whose fixed text is a template's own. */
export function auditPageClaims(filledHtml: string, evidence: Evidence, own: string[], opts: { skipFigures?: boolean } = {}): QaIssue[] {
  const text = withoutOwnTexts(decodeEntities(stripTags(filledHtml)), own);
  return auditClaims(text, evidence).filter((i) => i.severity === "fail" && !(opts.skipFigures && FIGURE_FINDING.test(i.detail)));
}

/** How many times each of the lead's values was placed in a static (single-file) page, so a flagship word that equals one of them
 *  is excused exactly that often and no more. Counts every token of the template, the banner the safeguards add, the street and
 *  suburb lines the address is split into, and the verified services (rendered once per service). */
export function pagePlacements(template: string, facts: PreviewFacts, vertical: Vertical): OwnValue[] {
  const nl = String.fromCharCode(10);
  const business = facts.business || "this business";
  const names = facts.services.map((s) => s.name);
  const notes = facts.services.map((s) => `Listed on ${hostOf(s.sourceUrl) || hostOf(facts.website) || "their website"}`);
  const tokens = { ...tokenValues(facts, vertical, ""), SVC_NAME: names.join(nl), SVC_NOTE: notes.join(nl), SAFEGUARD_BODY: bannerText(business) };
  const parts = facts.address ? facts.address.split(",").map((p) => p.trim()).filter(Boolean) : [];
  const own: OwnField[] = [
    { value: facts.phone, mask: true },
    facts.address,
    ...parts.filter((p) => p !== facts.address),
    facts.business,
    facts.suburb,
    { value: facts.email, mask: true },
    hostOf(facts.website),
    ...names,
  ];
  return ownPlacements(template.replace("<!--MU:BODY-->", "{{SAFEGUARD_BODY}}"), tokens, own);
}

/** A service name that reads as a claim (own-claims.ts), or promises that a person will act ("we will call you back"), is withheld from the page and listed in PREVIEW.md for a person to confirm. The business's own words are otherwise set aside from the scans. */
export function withholdClaimServices(facts: PreviewFacts): { facts: PreviewFacts; withheld: string[] } {
  const withheld = facts.services.filter((s) => readsAsClaim(s.name) || promisesIn(s.name).length).map((s) => s.name);
  if (!withheld.length) return { facts, withheld };
  const keep = (name: string) => !withheld.includes(name);
  return { facts: { ...facts, services: facts.services.filter((s) => keep(s.name)), sources: facts.sources.filter((s) => !(s.field === "service" && !keep(s.value))) }, withheld };
}

/** The backstop for listings: reads the preview data JSON that is actually written into the pages (script tags are invisible to the page-text
 *  audit) and refuses on any claim, or any trace of the template's example agency. Only the address is the business's own exempt text; price, result,
 *  captions and credits are audited like every other field. */
export function auditListingData(indexHtml: string, evidence: Evidence, own: string[], stock: RegExp[]): string[] {
  const raw = /<script id="mu-preview-data" type="application\/json">([\s\S]*?)<\/script>/.exec(indexHtml)?.[1];
  if (!raw) return [];
  let items: any[] = [];
  try { items = JSON.parse(raw).listings?.items ?? []; } catch { return ["the preview data block is not valid JSON"]; }
  const problems: string[] = [];
  for (const l of items) {
    const fields: [string, string][] = [["headline", l.headline], ...(l.description ?? []).map((d: string): [string, string] => ["description", d]), ...(l.features ?? []).map((f: string): [string, string] => ["feature", f]), ...(l.photos ?? []).flatMap((p: any): [string, string][] => [["photo caption", p.alt], ["photo credit", p.credit ?? ""]]), ["price", l.priceDisplay ?? ""], ["result", l.resultDisplay ?? ""], ["price note", l.priceNote ?? ""]];
    for (const [name, value] of fields) {
      if (!value) continue;
      const text = withoutOwnTexts(decodeEntities(String(value)), own);
      if (stock.some((re) => re.test(text))) problems.push(`listing ${l.id}: ${name} names the template's example agency`);
      if (readsAsClaim(String(value), { priceLine: name === "price" || name === "result" }) || namesStaff(String(value))) problems.push(`listing ${l.id}: ${name} reads as a claim`);
      for (const issue of auditClaims(text, evidence)) if (issue.severity === "fail" && !/price or discount/.test(issue.detail)) problems.push(`listing ${l.id}: ${name}: ${issue.detail}`);
    }
  }
  return problems;
}
