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
import { auditClaims, type QaIssue } from "../site-draft/qa";
import { auditDesignRules, localAssetText } from "../site-draft/design-rules";
import { bannerText, expiryFrom, factsFromEvidence, fillExportText, fillTemplate, finishExportHtml, previewDomain, previewSlug, tokenValues, vercelConfig, type PreviewFacts } from "./fill";
import { exportResidue, NEXT_TEMPLATE_SPECS, TEXT_EXT } from "./next-templates";
import { MOTION_MARKER, withMotion, writeMotionAssets } from "./motion";
import { getPreview, upsertPreview, type PreviewRecord } from "./registry";
import { residueIn, TEMPLATE_SPECS, templatesRoot, type Vertical } from "./templates";
import { assertPreviewDesign } from "./design";

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
};

export type GenerateResult = { record: PreviewRecord; facts: PreviewFacts; dir: string; missing: string[]; design: QaIssue[] };

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
export function fillExportDir(templateDir: string, dir: string, facts: PreviewFacts, vertical: Vertical, now: Date, templateHead: string) {
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
    if (/\.html$/i.test(rel)) text = withMotion(finishExportHtml(text, facts, facts.business || "this business", templateHead, expiresAt), facts);
    writeFileSync(to, text, "utf8");
  }
  writeMotionAssets(dir);
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
  const facts = factsFromEvidence(evidence, lead);

  const manifest = existsSync(join(templateDir, "template.json")) ? JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8")) : {};
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); // our own generated folder
  mkdirSync(dir, { recursive: true });

  if (manifest.kind === "next-export") {
    // A Next.js static export (dental, real estate): the same tokens are replaced in the HTML, the
    // RSC payload and the JS chunks, so hydration keeps the business's own text; then the page gets
    // its services data and the safeguards. See next-templates.ts.
    fillExportDir(templateDir, dir, facts, vertical, now, templateHeadFor(manifest));
    const left = (readdirSync(dir, { recursive: true }) as string[]).filter((r) => TEXT_EXT.test(r) && /\{\{[A-Z0-9_]+\}\}/.test(readFileSync(join(dir, r), "utf8")));
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const claims = auditClaims(html, evidence).filter((i) => i.severity === "fail");
    const residue = exportResidue(dir, NEXT_TEMPLATE_SPECS[vertical as "dental" | "real-estate"]);
    if (left.length || claims.length || residue.length) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`Refusing to write this preview: ${[...left.map((r) => `unfilled tokens in ${r}`), ...claims.map((c) => c.detail), ...residue].join("; ")}`);
    }
  } else {
    const template = readFileSync(join(templateDir, "index.html"), "utf8");
    const html = withMotion(fillTemplate(template, facts, vertical, { now }), facts);
    // Two independent checks before anything is written: the site-draft claims audit (stars,
    // prices, awards, guarantees, testimonials, named staff) and the flagship-residue check.
    const claims = auditClaims(html, evidence).filter((i) => i.severity === "fail");
    if (claims.length) throw new Error(`Refusing to write this preview: ${claims.map((c) => c.detail).join("; ")}`);
    const residue = residueIn(html, TEMPLATE_SPECS[vertical]);
    if (residue.length) throw new Error(`Refusing to write this preview — flagship content survived: ${residue.join("; ")}`);
    if (existsSync(join(templateDir, "assets"))) cpSync(join(templateDir, "assets"), join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), html, "utf8");
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
      "",
      "Safeguards: persistent 'not the official website' banner, noindex (meta + X-Robots-Tag), CSP with",
      "form-action 'none' and connect-src 'self' (no form posts, no third-party tracking), a 30-day expiry that",
      "replaces the page once passed, and a take-down in the Leads drawer.",
      "",
      "Motion: _mu/motion.js (scripts/lead-sites/motion.ts) on top of the template's own scenes: reveals, list",
      "stagger, photo drift, hero push-in, service count-up and a marquee of verified services only;",
      "prefers-reduced-motion gets a still page.",
      "",
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
    note: `Flagship preview generated (${vertical} template) at ${dir} — ${facts.services.length} verified service(s); placeholders for ${missing.join(", ")}. Local only, not deployed.`,
    by: opts.by || "",
    nextAt: lead.nextAt, // a note must never clear the follow-up date
  });
  return { record, facts, dir, missing, design: design.warnings };
}
