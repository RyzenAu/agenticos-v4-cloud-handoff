// Deploy / take down ONE lead preview. Only ever called from a founder's click (the Leads drawer,
// behind a confirm dialog) or the CLI with an explicit --confirm <domain>; there is no bulk path.
// Every deploy and take-down is logged on the lead's activity.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { findLead, logActivity } from "../leads/crm";
import { latestGateResult } from "../qa/gate";
import { bannerText, expiryFrom, stampExpiry } from "./fill";
import { getPreview, patchPreview, readRegistry, type PreviewRecord } from "./registry";
import { assertPreviewDesign } from "./design";
import { dataDirFor } from "../cloud/data-dir";

const HERE = dirname(fileURLToPath(import.meta.url));
/** At most this many previews live at once — these are one-off previews, never a batch. */
export const MAX_LIVE_PREVIEWS = 5;

export type ShellResult = { ok: boolean; out: string };
/** Runs vercel.ps1 with the given named arguments. Injectable so tests never touch Vercel. */
export type Shell = (args: string[]) => Promise<ShellResult>;

export function powershellShell(timeoutMs = 240_000): Shell {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "vercel.ps1"), ...args],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const timer = setTimeout(() => { child.kill(); resolve({ ok: false, out: `${out}\nMU_ERROR timed out` }); }, timeoutMs);
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out: String(e) }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0 && out.includes("MU_DONE"), out }); });
    });
}

/** The deploy log, minus anything that looks like a token — safe to store as an error message. */
export function redact(out: string): string {
  return out.replace(/\b(?:token|secret|key)[=:]\s*\S+/gi, "[redacted]").replace(/\s+/g, " ").trim().slice(-600);
}

/** Keep the failed step and its provider error; omit successful upload help text. */
export function deploymentError(out: string): string {
  const error = /MU_ERROR[^\r\n]*/g;
  const errors = [...out.matchAll(error)];
  if (!errors.length) return redact(out);
  const last = errors.at(-1)!;
  const before = out.slice(0, last.index);
  const step = before.lastIndexOf("MU_STEP ");
  return redact(`${step >= 0 ? before.slice(step).replace(/^MU_STEP /, "") : ""} ${last[0].replace(/^MU_ERROR\s*/, "")}`);
}

export type LiveCheck = { status: number; banner: boolean; noindexHeader: boolean; matchesPreview?: boolean };
export type Checker = (url: string, business: string, assets?: string[]) => Promise<LiveCheck>;

export function previewAssets(html: string): string[] {
  return [...new Set([...html.matchAll(/(?:href|src)="(\/_next\/static\/[^"?#]+\.(?:css|js))"/g)].map((m) => m[1]))].sort();
}

/** GETs the live preview: 200, the banner text, and an X-Robots-Tag noindex header. */
export const liveCheck: Checker = async (url, business, assets) => {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "Cache-Control": "no-cache" } });
    const html = await res.text();
    const want = bannerText(business).replace(/&/g, "&amp;");
    return {
      status: res.status,
      banner: html.includes(want) || html.includes(bannerText(business)),
      noindexHeader: /noindex/i.test(res.headers.get("x-robots-tag") ?? ""),
      matchesPreview: new URL(res.url).host === new URL(url).host && (!assets?.length || assets.every((asset) => previewAssets(html).includes(asset))),
    };
  } catch {
    return { status: 0, banner: false, noindexHeader: false, matchesPreview: false };
  }
};

export type DeployOptions = {
  root: string;
  /** Must equal the preview's domain — the confirm dialog's typed/checked value. */
  confirm: string;
  by: string;
  shell?: Shell;
  check?: Checker;
  now?: Date;
  /** Waits between live checks while Vercel issues the certificate (tests pass 0). */
  retryMs?: number;
};

function stageDir(root: string, slug: string) {
  return join(dataDirFor(root), "lead-sites", slug);
}

/** Mirrors the generated preview into the staging folder, keeping its .vercel link. */
function stage(record: PreviewRecord, root: string, expiresAt: string): string {
  const dir = stageDir(root, record.slug);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) if (entry !== ".vercel") rmSync(join(dir, entry), { recursive: true, force: true });
  for (const entry of readdirSync(record.dir)) {
    if (entry === "PREVIEW.md" || entry === "evidence.json" || entry.startsWith(".env")) continue;
    cpSync(join(record.dir, entry), join(dir, entry), { recursive: true });
  }
  // The 30 days start at deploy. The draft's provisional expiry appears in every page and, for a
  // Next export, in its RSC payloads too: swap that exact value everywhere so hydration matches.
  const previous = /data-mu-expires="([^"]+)"/.exec(readFileSync(join(dir, "index.html"), "utf8"))?.[1];
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const file = join(dir, rel);
    if (!/\.(html|txt|js)$/i.test(rel) || rel.startsWith(".vercel") || !statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    const next = previous ? text.split(previous).join(expiresAt) : rel.endsWith(".html") ? stampExpiry(text, expiresAt) : text;
    if (next !== text) writeFileSync(file, next, "utf8");
  }
  return dir;
}

export async function deployPreview(db: Database, leadId: number, opts: DeployOptions): Promise<PreviewRecord> {
  const lead = findLead(db, leadId);
  if (!lead) throw new Error("Lead not found.");
  const record = getPreview(opts.root, lead.id);
  if (!record) throw new Error("Generate the preview first.");
  if (!existsSync(join(record.dir, "index.html"))) throw new Error("The generated preview is missing — generate it again.");
  assertPreviewDesign(record.vertical, readFileSync(join(record.dir, "index.html"), "utf8"));
  if (opts.confirm.trim().toLowerCase() !== record.domain) throw new Error(`Confirm by passing the exact domain: ${record.domain}`);
  if (!opts.by.trim()) throw new Error("Say which founder is deploying.");
  if (lead.excluded || lead.status === "do_not_contact") throw new Error("This lead can't have a preview.");
  const live = readRegistry(opts.root).filter((p) => p.status === "live" && p.leadId !== lead.id);
  if (live.length >= MAX_LIVE_PREVIEWS)
    throw new Error(`${live.length} previews are already live. Take one down first — previews are one-off, never a batch.`);

  // Auto-QA gate (scripts/qa/gate.ts): refuse a deploy whose latest run for this exact preview
  // failed. A site that has never been gated isn't blocked here -- that's "hasn't run", not "FAIL".
  const gate = latestGateResult(opts.root, record.slug);
  if (gate && !gate.pass)
    throw new Error(`QA gate FAILED for this preview (run ${gate.date}) -- see ${gate.mdPath}. Run \`bun scripts/qa/gate.ts ${dirname(record.dir)} --slug ${record.slug}\` again after fixing it.`);

  const now = opts.now ?? new Date();
  const expiresAt = expiryFrom(now);
  patchPreview(opts.root, lead.id, { status: "deploying", lastError: null });
  const dir = stage(record, opts.root, expiresAt);
  const assets = previewAssets(readFileSync(join(dir, "index.html"), "utf8"));
  const shell = opts.shell ?? powershellShell();
  const result = await shell(["-Action", "deploy", "-Project", record.project, "-Stage", dir, "-Domain", record.domain]);
  if (!result.ok) {
    const error = deploymentError(result.out);
    patchPreview(opts.root, lead.id, { status: record.status === "live" ? "live" : "failed", lastError: error });
    logActivity(db, lead, { kind: "note", note: `Preview deploy to ${record.url} FAILED (by ${opts.by}): ${error.slice(0, 300)}`, by: opts.by, nextAt: lead.nextAt });
    throw new Error(`Deploy failed: ${error.slice(0, 300)}`);
  }

  // Verify the live subdomain: 200, the banner, and the noindex header.
  const check = opts.check ?? liveCheck;
  let verified: LiveCheck = { status: 0, banner: false, noindexHeader: false };
  for (let attempt = 0; attempt < 8; attempt++) {
    verified = await check(record.url, record.business, assets);
    if (verified.status === 200 && verified.banner && verified.noindexHeader && verified.matchesPreview !== false) break;
    if (opts.retryMs !== 0) await new Promise((r) => setTimeout(r, opts.retryMs ?? 8_000));
  }
  const ok = verified.status === 200 && verified.banner && verified.noindexHeader && verified.matchesPreview !== false;
  const updated = patchPreview(opts.root, lead.id, {
    status: ok ? "live" : "failed",
    deployedAt: now.toISOString(),
    deployedBy: opts.by,
    expiresAt,
    takenDownAt: null,
    takenDownBy: null,
    verified: { at: new Date().toISOString(), ...verified },
    lastError: ok ? null : `Uploaded, but the public address isn't serving the checked preview yet (status ${verified.status}, banner ${verified.banner}, noindex ${verified.noindexHeader}, matching preview ${verified.matchesPreview ?? "unknown"}). Check the domain mapping before sharing it.`,
  });
  const expiresOn = new Date(expiresAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" });
  logActivity(db, lead, {
    kind: "note",
    note: `Preview deployed to ${record.url} by ${opts.by} (Vercel project ${record.project}); expires ${expiresOn}. Live check: HTTP ${verified.status}, banner ${verified.banner ? "shown" : "MISSING"}, noindex header ${verified.noindexHeader ? "set" : "MISSING"}. Not sent to anyone.`,
    by: opts.by,
    nextAt: lead.nextAt,
  });
  return updated;
}

export async function takeDownPreview(db: Database, leadId: number, opts: { root: string; by: string; shell?: Shell; now?: Date }): Promise<PreviewRecord> {
  const lead = findLead(db, leadId);
  if (!lead) throw new Error("Lead not found.");
  const record = getPreview(opts.root, lead.id);
  if (!record) throw new Error("No preview on file for this lead.");
  if (!opts.by.trim()) throw new Error("Say which founder is taking it down.");
  const shell = opts.shell ?? powershellShell();
  const result = await shell(["-Action", "takedown", "-Project", record.project]);
  if (!result.ok) {
    const error = redact(result.out);
    patchPreview(opts.root, lead.id, { lastError: `Take-down failed: ${error}` });
    logActivity(db, lead, { kind: "note", note: `Preview take-down of ${record.url} FAILED (by ${opts.by}): ${error.slice(0, 300)}`, by: opts.by, nextAt: lead.nextAt });
    throw new Error(`Take-down failed: ${error.slice(0, 300)}`);
  }
  const now = (opts.now ?? new Date()).toISOString();
  const updated = patchPreview(opts.root, lead.id, { status: "taken_down", takenDownAt: now, takenDownBy: opts.by, lastError: null });
  logActivity(db, lead, {
    kind: "note",
    note: `Preview taken down by ${opts.by}: ${record.url} and Vercel project ${record.project} removed. The local copy stays at ${record.dir}.`,
    by: opts.by,
    nextAt: lead.nextAt,
  });
  return updated;
}
