#!/usr/bin/env bun
// Auto-QA gate — run before any deploy. Never deploys anything itself; it only reads a local
// build (or fetches a local/already-live URL, read-only) and writes a PASS/FAIL report.
//
//   bun scripts/qa/gate.ts <site-dir-or-url> [--slug <name>] [--mode preview|production] [--root <repo-root>]
//
// <site-dir-or-url> is either a local static build directory (its index.html + assets are read
// straight off disk) or an http(s) URL already reachable on this machine (a local preview server,
// or a live site someone asks to be re-checked — this never triggers a deploy). --mode defaults to
// "preview" unless the path/URL contains "preview" is false and "prod" is found, or --mode is given
// explicitly — get it right by hand when in doubt, since preview vs production changes which way
// the noindex check gates.
//
// Writes JSON + Markdown to .operator-data/qa/<slug>-<date>.{json,md} and exits 1 on FAIL so it can
// gate a CI/deploy step. `latestGateResult` is exported for other code (the lead-preview deploy
// route) to check without re-running anything.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  altTextCheck, brokenLinksResult, contrastCheck, coreWebVitalsFallback, coreWebVitalsFromLighthouse,
  localLinkTargets, mobileRenderCheck, overallPass, reducedMotionCheck, robotsCheck, tenTellsChecklist,
  type CheckResult, type FileEntry, type PageWeight, type SiteMode,
} from "./checks";
import { dataDirFor } from "../cloud/data-dir";

const TEXT_EXT = new Set([".html", ".htm"]);
const CSS_EXT = new Set([".css"]);
const ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".js", ".mjs", ".css", ".woff", ".woff2", ".mp4", ".webm"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".vercel"]);

export function qaDir(root: string) {
  return join(dataDirFor(root), "qa");
}
export function qaReportBase(root: string, slug: string, date: string) {
  return join(qaDir(root), `${slug}-${date}`);
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push(full);
  }
  return out;
}

function readLocalBuild(dir: string) {
  const files = walk(dir);
  const htmlFiles: FileEntry[] = [];
  const cssFiles: FileEntry[] = [];
  const assetWeights: PageWeight[] = [];
  let robotsTxt: string | null = null;
  for (const full of files) {
    const rel = relative(dir, full).split("\\").join("/");
    const ext = extname(full).toLowerCase();
    if (rel === "robots.txt") robotsTxt = readFileSync(full, "utf8");
    if (TEXT_EXT.has(ext)) htmlFiles.push({ path: rel, content: readFileSync(full, "utf8") });
    if (CSS_EXT.has(ext)) cssFiles.push({ path: rel, content: readFileSync(full, "utf8") });
    if (ASSET_EXT.has(ext)) assetWeights.push({ path: rel, bytes: statSync(full).size });
  }
  return { htmlFiles, cssFiles, assetWeights, allFiles: files.map((f) => relative(dir, f).split("\\").join("/")) };
}

async function checkLocalBrokenLinks(dir: string, htmlFiles: FileEntry[]) {
  const targets = localLinkTargets(htmlFiles);
  const broken: { fromPage: string; target: string; reason: string }[] = [];
  let totalChecked = 0;
  for (const { path, targets: urls } of targets) {
    for (const url of urls) {
      totalChecked++;
      if (/^https?:\/\//i.test(url)) {
        try {
          const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000) });
          if (!res.ok && res.status !== 405) broken.push({ fromPage: path, target: url, reason: `HTTP ${res.status}` });
        } catch (err) {
          // Network checks are best-effort: an offline machine or a site that blocks HEAD never
          // fails the gate on that alone — it's recorded as skipped, not broken.
          totalChecked--;
        }
        continue;
      }
      const clean = url.split("#")[0].split("?")[0];
      if (!clean) continue;
      const target = clean.startsWith("/") ? join(dir, clean) : join(dir, path, "..", clean);
      const candidates = [target, join(target, "index.html"), `${target}.html`];
      if (!candidates.some((c) => existsSync(c))) broken.push({ fromPage: path, target: url, reason: "file not found in the local build" });
    }
  }
  return brokenLinksResult(broken, totalChecked);
}

async function hasLighthouse(): Promise<boolean> {
  const bin = process.platform === "win32" ? "where" : "which";
  return new Promise((res) => {
    try {
      const child = spawn(bin, ["lighthouse"], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => res(false));
      child.on("close", (code) => res(code === 0));
    } catch {
      res(false);
    }
  });
}

function inferMode(target: string, given?: string): SiteMode {
  if (given === "preview" || given === "production") return given;
  const t = target.toLowerCase();
  if (/preview|draft|-pr-|staging/.test(t)) return "preview";
  if (/(^https?:\/\/)?(www\.)?[a-z0-9-]+\.(com|com\.au|net|org)\//.test(t) && !/preview/.test(t)) return "production";
  return "preview"; // safer default: assume it must NOT be indexable until told otherwise
}

export type GateReport = {
  slug: string;
  target: string;
  mode: SiteMode;
  generatedAt: string;
  pass: boolean;
  results: CheckResult[];
};

export function renderMarkdown(report: GateReport): string {
  const badge = report.pass ? "PASS" : "FAIL";
  const lines = [
    `# QA gate — ${report.slug}`,
    "",
    `**${badge}** · ${report.mode} · ${report.target} · ${report.generatedAt}`,
    "",
    ...report.results.map((r) => {
      const box = { pass: "[x]", fail: "[FAIL]", warn: "[warn]", skip: "[skip]" }[r.severity];
      const head = `## ${box} ${r.title}`;
      const body = [r.detail, ...(r.evidence?.length ? r.evidence.map((e) => `- ${e}`) : [])].join("\n");
      return `${head}\n\n${body}`;
    }),
  ];
  return lines.join("\n\n");
}

export function writeReport(root: string, report: GateReport): { jsonPath: string; mdPath: string } {
  mkdirSync(qaDir(root), { recursive: true });
  const date = report.generatedAt.slice(0, 10);
  const base = qaReportBase(root, report.slug, date);
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath };
}

/** The most recent gate report on file for a slug, or null if none has ever run. Used to make the
 *  deploy button refuse when the latest run for this exact site failed — never blocks a site that
 *  simply hasn't been gated yet (that's a "hasn't run" state, not a failure). */
export function latestGateResult(root: string, slug: string): { pass: boolean; date: string; jsonPath: string; mdPath: string } | null {
  const dir = qaDir(root);
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((f) => f.startsWith(`${slug}-`) && f.endsWith(".json"))
    .sort()
    .reverse();
  if (!matches.length) return null;
  const jsonPath = join(dir, matches[0]);
  const report = JSON.parse(readFileSync(jsonPath, "utf8")) as GateReport;
  const date = matches[0].slice(slug.length + 1, -".json".length);
  return { pass: report.pass, date, jsonPath, mdPath: jsonPath.replace(/\.json$/, ".md") };
}

export async function runGate(target: string, opts: { root: string; slug?: string; mode?: string; now?: Date }): Promise<GateReport> {
  const now = opts.now ?? new Date();
  const isUrl = /^https?:\/\//i.test(target);
  const slug = opts.slug ?? (isUrl ? new URL(target).hostname : target.split(/[\\/]/).filter(Boolean).pop() ?? "site");
  const mode = inferMode(target, opts.mode);
  const results: CheckResult[] = [];

  if (isUrl) {
    // A reachable local preview server or an already-live site — read-only. No deploy, no crawl
    // beyond the one page, since this gate is meant to run fast, right before a deploy decision.
    let html = "";
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(8000) });
      html = await res.text();
    } catch (err) {
      results.push({ id: "fetch", title: "Fetch target", severity: "fail", detail: `Couldn't fetch ${target}: ${(err as Error).message}` });
      const report: GateReport = { slug, target, mode, generatedAt: now.toISOString(), pass: false, results };
      return report;
    }
    const htmlFiles: FileEntry[] = [{ path: "/", content: html }];
    let robotsTxt: string | null = null;
    try {
      const robotsRes = await fetch(new URL("/robots.txt", target).toString(), { signal: AbortSignal.timeout(4000) });
      if (robotsRes.ok) robotsTxt = await robotsRes.text();
    } catch {
      // robots.txt fetch failing doesn't fail the gate on its own -- the meta-tag check still runs.
    }
    results.push(
      contrastCheck(htmlFiles, []),
      altTextCheck(htmlFiles),
      mobileRenderCheck(htmlFiles, []),
      robotsCheck(htmlFiles, robotsTxt, mode),
      reducedMotionCheck(htmlFiles, []),
      coreWebVitalsFallback(htmlFiles, []),
    );
    const tenTells = tenTellsChecklist(htmlFiles);
    if (tenTells) results.push(tenTells);
  } else {
    const dir = resolve(target);
    if (!existsSync(dir)) throw new Error(`No such directory: ${dir}`);
    const { htmlFiles, cssFiles, assetWeights } = readLocalBuild(dir);
    const robotsTxtFile = join(dir, "robots.txt");
    const robotsTxt = existsSync(robotsTxtFile) ? readFileSync(robotsTxtFile, "utf8") : null;

    results.push(contrastCheck(htmlFiles, cssFiles));
    results.push(altTextCheck(htmlFiles));
    results.push(await checkLocalBrokenLinks(dir, htmlFiles));
    results.push(mobileRenderCheck(htmlFiles, cssFiles));
    results.push(robotsCheck(htmlFiles, robotsTxt, mode));
    results.push(reducedMotionCheck(htmlFiles, cssFiles));
    if (await hasLighthouse()) {
      // Left as a hand-off: running Lighthouse needs a live local server, not a static dir, and
      // starting one is the caller's job (e.g. `preview` script). If it's on PATH we say so in the
      // report instead of silently falling back, but still return usable numbers via the fallback
      // so `gate.ts` never needs a browser to produce a report.
      results.push({ ...coreWebVitalsFallback(htmlFiles, assetWeights), detail: "Lighthouse is installed on this machine but gate.ts doesn't drive a browser -- run `lighthouse <url> --view` against a served preview for real field numbers. Static fallback below:\n\n" + coreWebVitalsFallback(htmlFiles, assetWeights).detail });
    } else {
      results.push(coreWebVitalsFallback(htmlFiles, assetWeights));
    }
    const tenTells = tenTellsChecklist(htmlFiles);
    if (tenTells) results.push(tenTells);
  }

  const report: GateReport = { slug, target, mode, generatedAt: now.toISOString(), pass: overallPass(results), results };
  return report;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

async function main() {
  const argv = process.argv.slice(2);
  const target = argv[0];
  if (!target) {
    console.error("Usage: bun scripts/qa/gate.ts <site-dir-or-url> [--slug <name>] [--mode preview|production] [--root <repo-root>]");
    process.exit(2);
  }
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  const root = flags.root ? resolve(flags.root) : resolve(HERE, "..", "..");
  const report = await runGate(target, { root, slug: flags.slug, mode: flags.mode });
  const { jsonPath, mdPath } = writeReport(root, report);
  console.log(renderMarkdown(report));
  console.log(`\nReport written to ${jsonPath} and ${mdPath}`);
  process.exit(report.pass ? 0 : 1);
}

// process.argv[1] is this file's own path when run directly (`bun scripts/qa/gate.ts …`), the
// same check deploy.ts/vercel.ps1's siblings use -- avoids relying on Bun-only `import.meta.main`
// so this file typechecks cleanly even when pulled into the Vite (browser-lib) TS graph.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
