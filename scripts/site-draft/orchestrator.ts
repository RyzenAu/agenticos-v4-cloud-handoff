// The site-draft pipeline (v3): evidence -> art direction (per-vertical design system) -> imagery
// (Higgsfield film + still) -> premium scaffold (render.ts, the quality floor) -> Claude refine
// pass on the owner's subscription (build.ts) -> guards (restore the scaffold if the refine broke
// anything) -> QA, with one bounded fix loop (mu-art-direction/impeccable's "one inspect, one
// fix, one confirm" rule), then a CRM note recording the outcome. `draftSite` (generate.ts) is
// untouched and stays available as the instant, zero-LLM `--fast` path — this is the slower,
// higher-quality default the brief asks for.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { findLead, logActivity, type Lead } from "../leads/crm";
import { slugify } from "./generate";
import { applyOwnSiteFacts, gatherEvidence, writeEvidence, type Evidence } from "./evidence";
import { applyBrandTokens, buildDirection, historyFromDrafts, loadSavedDirection, writeDirection } from "./direction";
import { buildImagery, type ImageryResult, type ImageryOptions } from "./imagery";
import { buildDraft, type BuildOptions } from "./build";
import { runQa, fixNotesFrom, auditClaims, auditAssetReuse, type QaReport, type QaOptions } from "./qa";
import { relockCopy, writeScaffold, RUNTIME_JS } from "./render";
import { selfHostFonts } from "./fonts";
import { checkImageRelevance, type RelevanceRun } from "./relevance";

// serve.ts uses `Bun.serve` directly and is deliberately never `import`ed as a TS module anywhere
// in this repo's tsc-checked graph (see generate.ts's own header comment: no bun-types installed,
// so Bun-only globals stay invisible to `tsc --noEmit`) — plugin.ts spawns it as a subprocess
// instead. QA here uses a `file://` URL for the same reason: no HTTP server needed just to let a
// browser render one static folder, and it keeps this pipeline runnable with `bun test` (no port
// binding) as well as under plain `tsc`.
function fileUrlFor(indexPath: string): string {
  return `file:///${indexPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

export type DraftV2Options = {
  draftsRoot?: string;
  by?: string;
  now?: Date;
  request?: typeof fetch;
  buildOptions?: BuildOptions;
  qaOptions?: QaOptions;
  imageCap?: number;
  designServerUrl?: string;
  skipHiggsfield?: boolean;
  /** Skip the whole build+QA stage — evidence and direction only. Used by tests. */
  skipBuild?: boolean;
  /** Ship the scaffold without the Claude refine pass (fast, zero LLM use). */
  skipRefine?: boolean;
  /** Test seam / override for the vision relevance check (skipped under bun test unless given). */
  relevanceRun?: RelevanceRun;
  imageryOptions?: Partial<ImageryOptions>;
};

/** What a refine pass must not remove. Returns the missing items (empty = safe to keep). */
export function scaffoldGuards(html: string, evidence: Evidence, scaffold: string): string[] {
  const missing: string[] = [];
  const need = (ok: boolean, label: string) => {
    if (!ok) missing.push(label);
  };
  need(/INTERNAL DRAFT/.test(html), "internal draft banner");
  need(/<dialog[^>]+id="sources"/.test(html), "sources drawer");
  need(/<h1[\s>]/.test(html), "h1");
  need(/assets\/site\.js/.test(html), "motion runtime script");
  need(/prefers-reduced-motion/.test(html), "reduced-motion CSS");
  need(/id="tool-data"/.test(html), "interactive tool data");
  for (const id of ["services", "prepare", "visit", "call"]) need(new RegExp(`id="${id}"`).test(html), `#${id} section`);
  for (const hook of ["data-hero", "data-media", "data-scene", "data-fill", "data-rows", "data-header", "data-finale"]) need(html.includes(hook), hook);
  for (const m of scaffold.matchAll(/data-lock="([\w-]+)"/g)) need(html.includes(`data-lock="${m[1]}"`), `locked copy (${m[1]})`);
  for (const issue of auditAssetReuse(html)) if (!auditAssetReuse(scaffold).length) missing.push(issue.detail);
  if (/data-callbar/.test(scaffold)) need(/data-callbar/.test(html), "mobile call bar");
  if (/AI-generated for this concept/.test(scaffold)) need(/AI-generated for this concept/.test(html), "illustrative caption");
  const phone = evidence.facts.find((f) => f.field === "phone" && f.value)?.value;
  if (phone) need(html.includes(`tel:${phone.replace(/[^\d+]/g, "")}`), "tel: link");
  const hosts = (doc: string) => [...doc.matchAll(/(?:src|href)=["'](https?:\/\/[^"'/]+)/gi)].map((m) => m[1]);
  const allowed = new Set(hosts(scaffold));
  for (const h of hosts(html)) if (!/fonts\.(googleapis|gstatic)\.com/.test(h) && !allowed.has(h)) missing.push(`new external host ${h}`);
  for (const issue of auditClaims(html, evidence)) if (issue.severity === "fail") missing.push(issue.detail);
  return missing;
}

/** Keep the refined page only if it passes the guards; otherwise restore the scaffold. The
 *  headline and core copy are re-locked first: the refine pass may polish around them, never
 *  replace them (St Clair's refine swapped the art-directed headline for an address on 24 Sep). */
export function guardOrRestore(dir: string, evidence: Evidence, scaffold: string): { missing: string[]; relocked: string[] } {
  const indexPath = join(dir, "index.html");
  // The motion runtime is tested code; a refine pass may not change it.
  writeFileSync(join(dir, "assets", "site.js"), RUNTIME_JS, "utf8");
  let html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  let relocked: string[] = [];
  if (html) {
    const r = relockCopy(html, scaffold);
    html = r.html;
    relocked = r.changed;
    writeFileSync(indexPath, html, "utf8");
  }
  const missing = html ? scaffoldGuards(html, evidence, scaffold) : ["index.html missing"];
  if (missing.length) writeFileSync(indexPath, scaffold, "utf8");
  return { missing, relocked };
}

export type DraftV2Result = {
  lead: Lead;
  slug: string;
  dir: string;
  indexPath: string;
  evidence: Evidence;
  imagery: ImageryResult;
  qa: QaReport | null;
  buildMs: number;
  attempts: number;
  previewPort: number | null;
};

export function defaultDraftsRoot(): string {
  return join(process.env.USERPROFILE || process.env.HOME || ".", "source", "repos", "mu-site-drafts");
}

export async function draftSiteV2(db: Database, ref: string | number, opts: DraftV2Options = {}): Promise<DraftV2Result> {
  const lead = findLead(db, ref);
  if (!lead) throw new Error(`No CRM lead matches "${ref}".`);
  const now = opts.now ?? new Date();
  const slug = slugify(lead.name, lead.id);
  const draftsRoot = opts.draftsRoot ?? defaultDraftsRoot();
  const dir = join(draftsRoot, slug);
  mkdirSync(dir, { recursive: true });

  const evidence = applyOwnSiteFacts(await gatherEvidence(lead, { request: opts.request, now }), dir);
  writeEvidence(dir, evidence);

  // Stable across re-drafts; otherwise seeded, avoiding directions sibling drafts already use.
  // Then brand-locked to the business's own colour where it reads (brand.ts, applyBrandTokens).
  const direction = applyBrandTokens(loadSavedDirection(dir) ?? buildDirection(lead, historyFromDrafts(draftsRoot, lead.vertical, slug)), evidence.brand);
  const { mdPath } = writeDirection(dir, lead, direction);
  const directionMd = readFileSync(mdPath, "utf8");

  const imagery = await buildImagery(dir, direction, {
    cap: opts.imageCap ?? 3,
    vertical: lead.vertical,
    designServerUrl: opts.designServerUrl,
    skipHiggsfield: opts.skipHiggsfield,
    ...opts.imageryOptions,
  });

  const indexPath = join(dir, "index.html");

  if (opts.skipBuild) {
    return { lead, slug, dir, indexPath, evidence, imagery, qa: null, buildMs: 0, attempts: 0, previewPort: null };
  }

  const fonts = await selfHostFonts(dir, direction.typePairing.googleFamilies);
  // Every hero and section image must visibly belong to the vertical (owner, 24 Sep 2026).
  const relevance =
    imagery.media && (opts.relevanceRun || process.env.NODE_ENV !== "test")
      ? await checkImageRelevance(dir, lead.vertical, imagery.media, { run: opts.relevanceRun })
      : { issues: [], verdicts: [] };
  const qaOptions = { ...opts.qaOptions, extraIssues: [...(opts.qaOptions?.extraIssues ?? []), ...relevance.issues] };
  const fallbackArt = imagery.assets.find((a) => a.role === "fallback" && a.path.endsWith("hero.svg"))?.path;
  const { html: scaffold } = writeScaffold(dir, { evidence, direction, media: imagery.media, fallbackArt, fonts, generatedAt: now });

  let attempts = 0;
  let totalMs = 0;
  const notes: string[] = [];
  if (!opts.skipRefine) {
    attempts = 1;
    const first = await buildDraft(dir, evidence, directionMd, imagery, opts.buildOptions);
    totalMs += first.ms;
    if (!first.ok) {
      writeFileSync(join(dir, "BUILD-ERROR.md"), `Claude refine pass failed: ${first.error}\n\nThe premium scaffold was kept as index.html.\n`, "utf8");
      writeFileSync(indexPath, scaffold, "utf8");
      notes.push(`refine pass build failed (${first.error.slice(0, 160)}); scaffold kept`);
    } else {
      const { missing, relocked } = guardOrRestore(dir, evidence, scaffold);
      if (relocked.length) notes.push(`refine pass rewrote locked copy (${relocked.join(", ")}); re-locked`);
      if (missing.length) notes.push(`refine pass removed ${missing.slice(0, 4).join(", ")}; scaffold restored`);
    }
  }

  const previewUrl = fileUrlFor(indexPath);
  let qa = await runQa(dir, previewUrl, evidence, qaOptions);

  if (!qa.pass && !opts.skipRefine) {
    // One bounded fix pass, per mu-art-direction / impeccable: inspect once, fix once, confirm
    // once. Never loop further even if it's still failing after this.
    attempts += 1;
    const fixNotes = fixNotesFrom(qa);
    writeFileSync(join(dir, "QA-first-pass.md"), `# QA on the first refined page

${fixNotes}
`, "utf8");
    const second = await buildDraft(dir, evidence, directionMd, imagery, { ...opts.buildOptions, fixNotes });
    totalMs += second.ms;
    if (second.ok) {
      const { missing } = guardOrRestore(dir, evidence, scaffold);
      if (missing.length) notes.push(`fix pass removed ${missing.slice(0, 4).join(", ")}; scaffold restored`);
      qa = await runQa(dir, previewUrl, evidence, qaOptions);
    }
  }

  if (!qa.pass && !opts.skipRefine && readFileSync(indexPath, "utf8") !== scaffold) {
    // The refined page still fails after its fix pass: ship the scaffold, which is tested.
    writeFileSync(indexPath, scaffold, "utf8");
    const scaffoldQa = await runQa(dir, previewUrl, evidence, qaOptions);
    if (scaffoldQa.pass) {
      qa = scaffoldQa;
      notes.push("refined page failed QA twice; scaffold shipped");
    }
  }

  const status = qa.pass ? "QA PASS" : "QA REVIEW NEEDED";
  logActivity(db, lead, {
    kind: "note",
    note: `draft site v4 ready: ${indexPath} — ${status} (${direction.name} / ${direction.hero}; ${attempts} Claude pass${attempts === 1 ? "" : "es"}, ${Math.round(totalMs / 1000)}s build time; imagery ${imagery.engine}${imagery.reused ? " reused" : ""}${notes.length ? `; ${notes.join("; ")}` : ""}). Preview: \`bun scripts/site-draft/serve.ts "${dir}"\`. Nothing published or sent.`,
    by: opts.by ?? "jarvis",
  });

  return { lead, slug, dir, indexPath, evidence, imagery, qa, buildMs: totalMs, attempts, previewPort: null };
}
