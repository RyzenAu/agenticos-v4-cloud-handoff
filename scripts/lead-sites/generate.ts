// "Generate website" for ONE lead: copies its vertical's template (templates.ts), fills it from
// verified evidence only (fill.ts), and writes it to mu-site-drafts/<slug>/flagship-preview/ —
// a sub-folder, so the art-directed v2 draft that may already live in mu-site-drafts/<slug>/ is
// never overwritten. Generating is local only: nothing is deployed until a founder clicks
// "Deploy" and confirms (deploy.ts).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { findLead, logActivity, type Lead } from "../leads/crm";
import { applyOwnSiteFacts, gatherEvidence, type Evidence } from "../site-draft/evidence";
import type { QaIssue } from "../site-draft/qa";
import { auditDesignRules, localAssetText } from "../site-draft/design-rules";
import { auditAddedClaims, auditListingData, auditPageClaims, ownTexts, pagePlacements, withholdClaimServices, withoutOwnTexts } from "./own-values";
import { bannerText, escapeHtml, expiryFrom, notFoundPage, factsFromEvidence, fillExportText, fillTemplate, finishExportHtml, previewDomain, previewSlug, tokenValues, vercelConfig, type PreviewFacts } from "./fill";
import { exportResidue, flattenSegmentPayloads, NEXT_TEMPLATE_SPECS, TEXT_EXT } from "./next-templates";
import { MOTION_MARKER, withMotion, writeMotionAssets } from "./motion";
import { getPreview, upsertPreview, type PreviewRecord } from "./registry";
import { residueIn, TEMPLATE_SPECS, templatesRoot, type Vertical } from "./templates";
import { assertPreviewDesign } from "./design";
import { promisesIn, textPieces } from "./promise-phrases";
import { copyListingPhotos, readListingsFile, listingTexts, normaliseListings, STOCK_LEAK, writePropertyPages, type ListingInput, type NormalisedListings } from "./listings";

export const PREVIEW_SUBDIR = "flagship-preview";

export function previewProject(slug: string) {
  return `mu-preview-${slug}`.slice(0, 90).replace(/-+$/g, "");
}

export type GenerateOptions = {
  root: string;
  draftsRoot: string;
  by?: string;
  request?: typeof fetch;
  now?: Date;
  /** Tests pass evidence directly (no network). */
  evidence?: Evidence;
  /** A real-estate prospect's own listings (see listings.ts for the shape). With none, the preview shows an honest empty state. */
  listings?: ListingInput[];
  /** Folder that relative photo paths in `listings` are resolved against. */
  listingPhotosRoot?: string;
};

export type GenerateResult = {
  record: PreviewRecord; facts: PreviewFacts; dir: string; missing: string[]; design: QaIssue[];
  /** Real estate only: what became of the business's own listings, in words the founder can read (photos dropped, text withheld, files not found). */
  listings?: { shown: number; photosUsed: number; notes: string[]; photosFolder: string; source: "input" | "file" | "none"; /** One line for the Leads page. */ summary: string };
};

/** Where a lead's own listings live when the caller passes none: <drafts>/<lead>/listings.json, with its photographs in <drafts>/<lead>/listing-photos/. */
export const LISTINGS_FILE = "listings.json";
export const LISTING_PHOTOS_DIR = "listing-photos";

/** Leads we must never build a preview for. */
export function previewBlocker(lead: Lead): string | null {
  if (lead.excluded) return `This lead is excluded (${lead.excludedReason || "not a prospect"}).`;
  if (lead.status === "do_not_contact") return "This lead asked not to be contacted.";
  if (lead.status === "won") return "This is a client now — build their real site from the client project instead.";
  if (!(lead.vertical in TEMPLATE_SPECS)) return `No flagship template for the ${lead.vertical} vertical.`;
  return null;
}

/** The template's own <head> additions: banner-offset CSS and first-screen preloads. */
export function templateHeadFor(manifest: { css?: string; head?: string }): string {
  return `<style data-mu-template>${String(manifest.css ?? "")}</style>${String(manifest.head ?? "")}`;
}

/** Copies a Next export template to `dir`, replacing its tokens in every HTML/RSC/JS file and
 *  adding the services data + safeguards to each page. */
export function fillExportDir(templateDir: string, dir: string, facts: PreviewFacts, vertical: Vertical, now: Date, templateHead: string, extra: { listings?: unknown[] } = {}) {
  const observedOn = now.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" });
  const expiresAt = expiryFrom(now);
  const values = { ...tokenValues(facts, vertical, observedOn), BANNER: bannerText(facts.business || "this business"), EXPIRES: expiresAt };
  for (const rel of readdirSync(templateDir, { recursive: true }) as string[]) {
    const from = join(templateDir, rel);
    if (!statSync(from).isFile() || rel === "template.json") continue;
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (!TEXT_EXT.test(rel)) { copyFileSync(from, to); continue; }
    let text = fillExportText(readFileSync(from, "utf8"), values);
    if (/\.html$/i.test(rel)) text = withMotion(finishExportHtml(text, facts, facts.business || "this business", templateHead, expiresAt, extra), facts);
    writeFileSync(to, text, "utf8");
  }
  writeMotionAssets(dir);
  flattenSegmentPayloads(dir); // a cache built before the flat names existed still prefetches
}

/** The design gate every preview passes before it's kept: the motion layer is present, and the
 *  impeccable / mu-art-direction / mu-killer-site rules (site-draft/design-rules.ts) hold. Fails
 *  refuse the preview; warnings are recorded in PREVIEW.md for the founder. */
export function designGate(dir: string, vertical: Vertical): { fails: string[]; warnings: QaIssue[] } {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const issues = auditDesignRules({ html, ...localAssetText(dir, html), vertical });
  const fails = issues.filter((i) => i.severity === "fail").map((i) => i.detail);
  if (!html.includes(MOTION_MARKER) || !existsSync(join(dir, "_mu", "motion.js"))) fails.push("the motion layer (_mu/motion.js) is missing");
  return { fails, warnings: issues.filter((i) => i.severity === "warn") };
}

export async function generatePreview(db: Database, ref: string | number, opts: GenerateOptions): Promise<GenerateResult> {
  const lead = findLead(db, ref);
  if (!lead) throw new Error(`No CRM lead matches "${ref}".`);
  const blocked = previewBlocker(lead);
  if (blocked) throw new Error(blocked);
  const vertical = lead.vertical as Vertical;
  const templateDir = join(templatesRoot(opts.draftsRoot), vertical);
  if (!existsSync(join(templateDir, "index.html")))
    throw new Error(`The ${vertical} template hasn't been built yet: run bun scripts/lead-sites/cli.ts templates`);
  // Validate before replacing a generated folder: a stale or unrelated cache must never
  // silently switch the owner's selected flagship to another design.
  assertPreviewDesign(vertical, readFileSync(join(templateDir, "index.html"), "utf8"));

  const now = opts.now ?? new Date();
  const slug = previewSlug(lead.name, lead.id);
  const leadDir = join(opts.draftsRoot, slug);
  const dir = join(leadDir, PREVIEW_SUBDIR);

  // Evidence: the CRM row + the business's own website, plus any own-site facts a founder already
  // recorded for the v2 draft of this lead. Never a guess.
  let evidence = opts.evidence ?? (await gatherEvidence(lead, { request: opts.request, now }));
  evidence = applyOwnSiteFacts(evidence, leadDir);
  const withholding = withholdClaimServices(factsFromEvidence(evidence, lead));
  const facts = withholding.facts;

  const manifest = existsSync(join(templateDir, "template.json")) ? JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8")) : {};
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); // our own generated folder
  mkdirSync(dir, { recursive: true });

  let listingResult: NormalisedListings | undefined;
  let listingPhotosFolder = "";
  let listingSourceUsed: "input" | "file" | "none" = "none";
  let listingFileNotesAll: string[] = [];
  if (manifest.kind === "next-export") {
    // A Next.js static export (dental, real estate): the same tokens are replaced in the HTML, the
    // RSC payload and the JS chunks, so hydration keeps the business's own text; then the page gets
    // its services data and the safeguards. See next-templates.ts.
    // A real-estate preview shows only the business's own listings: one property page and its photographs each, or an empty state.
    let listingInput: unknown = opts.listings;
    let listingSource: "input" | "file" | "none" = opts.listings ? "input" : "none";
    const listingFileNotes: string[] = listingFileNotesAll;
    if (vertical === "real-estate" && listingInput === undefined && existsSync(join(leadDir, LISTINGS_FILE))) {
      const read = readListingsFile(join(leadDir, LISTINGS_FILE));
      if (read.problem) listingFileNotes.push(read.problem);
      else { listingInput = read.value; listingSource = "file"; }
    }
    listingSourceUsed = listingSource;
    listingPhotosFolder = opts.listingPhotosRoot ?? join(leadDir, LISTING_PHOTOS_DIR);
    listingResult = vertical === "real-estate" ? normaliseListings(listingInput, { photosRoot: listingPhotosFolder, now, own: (v) => withoutOwnTexts(v, ownTexts(facts)) }) : undefined;
    fillExportDir(templateDir, dir, facts, vertical, now, templateHeadFor(manifest), listingResult ? { listings: listingResult.items } : {});
    if (listingResult) {
      writePropertyPages(dir, listingResult.items.map((l) => ({ slug: l.slug, title: escapeHtml(`${l.address.street}${l.address.suburb ? `, ${l.address.suburb}` : ""} — ${facts.business || "this business"} preview (not the official website)`) })));
      copyListingPhotos(dir, listingResult.photos);
      flattenSegmentPayloads(dir);
    }
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((r) => TEXT_EXT.test(r));
    const left = files.filter((r) => /{{[A-Z0-9_]+}}/.test(readFileSync(join(dir, r), "utf8")));
    // The claims audit reads EVERY page of the export, without the lead's own values (a published service that quotes a price is theirs).
    // Example figures (prices, "1 / 5") are the template's own labelled content, so for those only the words fill added are judged.
    const own = ownTexts(facts, listingResult ? listingTexts(listingResult.items) : []);
    const claims = new Map<string, QaIssue>(); // keyed "page: finding"
    for (const rel of files.filter((r) => /\.html$/i.test(r))) {
      const page = readFileSync(join(dir, rel), "utf8");
      const tpl = join(templateDir, rel);
      for (const issue of auditPageClaims(page, evidence, own, { skipFigures: true })) claims.set(`${rel}: ${issue.detail}`, issue);
      if (existsSync(tpl)) for (const issue of auditAddedClaims(readFileSync(tpl, "utf8"), page, evidence, own)) claims.set(`${rel}: ${issue.detail}`, issue);
    }
    // The listings live only in the preview data block, which the page-text audit cannot see: audit that JSON field by field as a backstop.
    const listingProblems = listingResult ? auditListingData(readFileSync(join(dir, "index.html"), "utf8"), evidence, ownTexts(facts, listingTexts(listingResult.items)), STOCK_LEAK) : [];
    for (const p of listingProblems) claims.set(`preview data: ${p}`, { severity: "fail", area: "claims", detail: p });
    // Nothing in a preview is sent: no page, its data block or its scripts may promise that a person will call, reply, confirm or be in touch.
    for (const rel of files.filter((r) => /\.html$/i.test(r))) {
      for (const { kind, text } of textPieces(readFileSync(join(dir, rel), "utf8"))) for (const hit of promisesIn(withoutOwnTexts(text, own))) claims.set(`${rel}: promise in ${kind}: ${hit}`, { severity: "fail", area: "claims", detail: `promises a person will act: "${hit}"` });
    }
    const spec = NEXT_TEMPLATE_SPECS[vertical as "dental" | "real-estate"];
    // Two leak checks. The cached template must carry no flagship identity at all, and the filled export must carry none once
    // the lead's own values are set aside (their surname, suburb, street, phone or service names may equal a flagship word).
    const residue = [...exportResidue(templateDir, spec).map((r) => `template ${r}`), ...exportResidue(dir, spec, own)];
    if (left.length || claims.size || residue.length) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`Refusing to write this preview: ${[...left.map((r) => `unfilled tokens in ${r}`), ...claims.keys(), ...residue].join("; ")}`);
    }
  } else {
    const template = readFileSync(join(templateDir, "index.html"), "utf8");
    const html = withMotion(fillTemplate(template, facts, vertical, { now }), facts);
    // Two independent checks before anything is written: the site-draft claims audit (stars,
    // prices, awards, guarantees, testimonials, named staff) and the flagship-residue check.
    const own = ownTexts(facts);
    const claims = auditPageClaims(html, evidence, own);
    const promises = textPieces(html).flatMap((p) => promisesIn(withoutOwnTexts(p.text, own)));
    if (promises.length) claims.push({ severity: "fail", area: "claims", detail: `promises a person will act: "${promises[0]}"` });
    if (claims.length) throw new Error(`Refusing to write this preview: ${claims.map((c) => c.detail).join("; ")}`);
    // The lead's own phone, address and name are not "flagship content" even when they contain a flagship fragment, but only as many times as the template places them.
    // The template itself must be clean (no own values set aside), and the filled page may hold the lead's values only as often as it placed them.
    const templateResidue = residueIn(template, TEMPLATE_SPECS[vertical]);
    const residue = [...templateResidue.map((r) => `template ${r}`), ...residueIn(html, TEMPLATE_SPECS[vertical], pagePlacements(template, facts, vertical))];
    if (residue.length) throw new Error(`Refusing to write this preview — flagship content survived: ${residue.join("; ")}`);
    if (existsSync(join(templateDir, "assets"))) cpSync(join(templateDir, "assets"), join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), html, "utf8");
    writeFileSync(join(dir, "404.html"), notFoundPage(facts, now), "utf8");
    writeMotionAssets(dir);
  }
  const design = designGate(dir, vertical);
  if (design.fails.length) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Refusing to write this preview (design rules): ${design.fails.join("; ")}`);
  }
  writeFileSync(join(dir, "vercel.json"), vercelConfig(), "utf8");
  writeFileSync(join(dir, ".vercelignore"), ".env*\nPREVIEW.md\nevidence.json\n", "utf8");
  writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");

  const missing: string[] = [];
  if (!facts.address) missing.push("street address");
  if (!facts.phone) missing.push("phone");
  if (!facts.services.length) missing.push("services");
  missing.push("opening hours");

  const domain = previewDomain(slug);
  writeFileSync(
    join(dir, "PREVIEW.md"),
    [
      `# ${facts.business} — flagship preview (${vertical})`,
      "",
      `Generated ${now.toISOString()} by ${opts.by || "a founder"} from the ${TEMPLATE_SPECS[vertical].flagship} flagship template.`,
      `Would deploy to https://${domain} (Vercel team nahda, project ${previewProject(slug)}) only when a founder clicks Deploy and confirms.`,
      "",
      "## Every fact on the page, and where it came from",
      "",
      ...facts.sources.map((s) => `- ${s.field}: ${s.value} — ${s.sourceLabel} (${s.sourceUrl})`),
      "",
      `Placeholders (no verified value): ${missing.join(", ")}.`,
      ...(withholding.withheld.length ? ["", `Withheld (reads as an award, guarantee or rating; confirm with the business before it is shown): ${withholding.withheld.join("; ")}.`] : []),
      "",
      "Safeguards: persistent 'not the official website' banner, noindex (meta + X-Robots-Tag), CSP with",
      "form-action 'none' and connect-src 'self' (no form posts, no third-party tracking), a 30-day expiry that",
      "replaces the page once passed, and a take-down in the Leads drawer.",
      "",
      "Motion: _mu/motion.js (scripts/lead-sites/motion.ts) on top of the template's own scenes: reveals, list",
      "stagger, photo drift, hero push-in, service count-up and a marquee of verified services only;",
      "prefers-reduced-motion gets a still page.",
      "",
      ...listingsReport(listingResult, listingFileNotesAll, listingPhotosFolder),
      "## Design checks (impeccable / mu-art-direction / mu-killer-site, site-draft/design-rules.ts)",
      "",
      ...(design.warnings.length ? design.warnings.map((w) => `- warning: ${w.detail}`) : ["- All rules pass."]),
      "",
    ].join("\n"),
    "utf8",
  );

  const previous = getPreview(opts.root, lead.id);
  const record = upsertPreview(opts.root, {
    leadId: lead.id,
    business: facts.business,
    vertical,
    slug,
    domain,
    url: `https://${domain}`,
    project: previewProject(slug),
    dir,
    // A regenerated preview that's already live stays live (its next Deploy pushes the update).
    status: previous?.status === "live" ? "live" : "generated",
    generatedAt: now.toISOString(),
    generatedBy: opts.by || "",
    deployedAt: previous?.status === "live" ? previous.deployedAt : null,
    deployedBy: previous?.status === "live" ? previous.deployedBy : null,
    expiresAt: previous?.status === "live" ? previous.expiresAt : null,
    takenDownAt: previous?.takenDownAt ?? null,
    takenDownBy: previous?.takenDownBy ?? null,
    verified: previous?.status === "live" ? previous.verified : null,
    lastError: null,
    serviceCount: facts.services.length,
    missing,
  });

  logActivity(db, lead, {
    kind: "note",
    note: `Flagship preview generated (${vertical} template) at ${dir} — ${facts.services.length} verified service(s); placeholders for ${missing.join(", ")}. Local only, not deployed.${listingActivity(listingResult, listingPhotosFolder, listingFileNotesAll)}`,
    by: opts.by || "",
    nextAt: lead.nextAt, // a note must never clear the follow-up date
  });
  const listings = listingResult
    ? { shown: listingResult.items.length, photosUsed: listingResult.photos.length, notes: [...listingFileNotesAll, ...listingResult.notes], photosFolder: listingPhotosFolder, source: listingSourceUsed, summary: listingSummary(listingResult, listingFileNotesAll) }
    : undefined;
  return { record, facts, dir, missing, design: design.warnings, ...(listings ? { listings } : {}) };
}

/** The PREVIEW.md section about the business's own listings. */
export function listingsReport(result: NormalisedListings | undefined, fileNotes: string[] = [], folder = ""): string[] {
  if (!result) return [];
  const by = (s: string) => result.items.filter((l) => l.status === s).length;
  return [
    "## Listings",
    "",
    result.items.length
      ? `The business's own listings: ${by("for-sale")} for sale, ${by("under-offer")} under offer, ${by("sold")} sold, ${by("for-rent")} for rent, ${by("leased")} leased; ${result.withdrawn} withdrawn (not shown). ${result.photos.length} photograph(s) copied in.`
      : "No listings were supplied. The Buy, Rent and Sold pages and the home page say so plainly; none of the template's example properties are shown.",
    ...(folder ? [`Photos folder looked in: ${folder}`] : []),
    ...[...fileNotes, ...result.notes].map((n) => `- ${n}`),
    "",
  ];
}

/** One line for the Leads page: what was shown, and whether anything was dropped. */
export function listingSummary(result: NormalisedListings | undefined, fileNotes: string[] = []): string {
  if (!result) return "";
  const problems = [...fileNotes, ...result.notes].filter((n) => /could not be read|not used|outside|not a usable|skipped|withheld|too large|only the first/i.test(n)).length;
  return `Listings: ${result.items.length} shown, ${result.photos.length} photo(s) used${problems ? `; ${problems} thing(s) left out (see the preview notes)` : ""}.`;
}

/** The listings sentence for the Leads timeline: photos that were supplied but dropped are said plainly, with the folder that was looked in. */
export function listingActivity(result: NormalisedListings | undefined, folder: string, fileNotes: string[] = []): string {
  if (!result) return "";
  if (fileNotes.length && !result.items.length) return ` Listings: none used. ${fileNotes.join(" ")}`;
  if (!result.items.length) return "";
  const dropped = result.notes.filter((n) => /photo/i.test(n) && /(not used|outside|not a usable|no photos folder|not found|skipped|only the first|total)/i.test(n));
  return ` Listings: ${result.items.length} shown, ${result.photos.length} photo(s) used${dropped.length ? `; ${dropped.length} photo problem(s): ${dropped.slice(0, 3).join(" ")} (photos folder: ${folder})` : ""}.`;
}
