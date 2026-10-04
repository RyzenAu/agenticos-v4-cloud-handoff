// "Jarvis, make a website for <prospect>" — v1. Turns one CRM lead into a local, static,
// single-page draft under mu-site-drafts/<slug>/ (outside this repo — see README there). No
// network calls, no LLM, no invented content: every field either comes straight from the CRM row
// (name, suburb, phone, address) or from VERTICAL_COPY's generic, business-agnostic service list.
// Never writes staff names, reviews, awards or photos of people, because none of that exists in
// the CRM for a lead with no current site.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { findLead, logActivity, type Lead } from "../leads/crm";
import { VERTICAL_COPY } from "./vertical-copy";

/** This file's own directory. `import.meta.dir` (Bun-only) is untyped under this project's
 * tsconfig (no bun-types); this works under both tsc and the Bun runtime. */
const HERE = dirname(fileURLToPath(import.meta.url));

export type DraftResult = {
  lead: Lead;
  slug: string;
  dir: string;
  indexPath: string;
  generatedAt: string;
};

/** "St Clair Dental" → "st-clair-dental". Falls back to the lead id if the name is empty/odd. */
export function slugify(name: string, fallbackId: number): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `lead-${fallbackId}`;
}

/** "+61 2 9670 3195" → "+61296703195" for a tel: link. Empty in, empty out. */
export function telHref(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Fills the shared template with one lead's real public details and its vertical's generic copy. */
export function renderDraftHtml(lead: Lead, template: string, now: Date = new Date()): string {
  const copy = VERTICAL_COPY[lead.vertical];
  const name = escapeHtml(lead.name || "Untitled business");
  const suburb = escapeHtml(suburbOf(lead.area));
  const phoneDisplay = escapeHtml(lead.phone || "Phone unavailable — check listing");
  const address = escapeHtml(lead.address || `${suburbOf(lead.area)} (exact address not on file)`);
  const serviceCards = copy.services
    .map((s) => `<div class="card"><h3>${escapeHtml(s)}</h3><p>Ask ${name} for current pricing and availability.</p></div>`)
    .join("\n      ");
  const tokens: Record<string, string> = {
    BUSINESS_NAME: name,
    SUBURB: suburb,
    VERTICAL_LABEL: escapeHtml(copy.label),
    TAGLINE: escapeHtml(copy.tagline),
    INTRO: escapeHtml(copy.intro),
    CTA_LABEL: escapeHtml(copy.ctaLabel),
    PHONE_DISPLAY: phoneDisplay,
    PHONE_TEL: telHref(lead.phone || ""),
    ADDRESS: address,
    ACCENT: copy.accent,
    GENERATED_AT: now.toISOString().slice(0, 10),
    SERVICE_CARDS: serviceCards,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => tokens[key] ?? "");
}

/** First component of "Mount Druitt NSW" → "Mount Druitt". Falls back to the raw area string. */
function suburbOf(area: string): string {
  return area.replace(/\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s*\d{0,4}$/i, "").trim() || area || "your area";
}

const TEMPLATE_PATH = join(HERE, "templates", "base.html");

/**
 * The default target for generated drafts: a sibling checkout next to the other M&U project
 * repos, deliberately outside this AgenticOS-v4 git repository (see docs/WEBSITE-DRAFTS.md).
 */
export function defaultDraftsRoot(): string {
  return join(process.env.USERPROFILE || process.env.HOME || ".", "source", "repos", "mu-site-drafts");
}

export async function draftSite(
  db: Database,
  ref: string | number,
  opts: { draftsRoot?: string; by?: string; now?: Date } = {},
): Promise<DraftResult> {
  const lead = findLead(db, ref);
  if (!lead) throw new Error(`No CRM lead matches "${ref}".`);
  if (!(lead.vertical in VERTICAL_COPY)) throw new Error(`No draft template for vertical "${lead.vertical}".`);
  const now = opts.now ?? new Date();
  const slug = slugify(lead.name, lead.id);
  const draftsRoot = opts.draftsRoot ?? defaultDraftsRoot();
  const dir = join(draftsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const html = renderDraftHtml(lead, template, now);
  const indexPath = join(dir, "index.html");
  writeFileSync(indexPath, html, "utf8");
  const readmePath = join(dir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      `# ${lead.name} — draft\n\nGenerated ${now.toISOString()} by Jarvis's site-draft flow for internal review only.\nNot published. Not sent to the lead. Source: M&U CRM lead #${lead.id} (${lead.source}).\n\nPreview: \`bun "${join(HERE, "serve.ts")}" "${dir}"\`\n`,
      "utf8",
    );
  }
  logActivity(db, lead, {
    kind: "note",
    note: `draft site ready: ${indexPath}`,
    by: opts.by ?? "jarvis",
  });
  return { lead, slug, dir, indexPath, generatedAt: now.toISOString() };
}
