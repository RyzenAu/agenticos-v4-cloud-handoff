// SEO audits via jev-seo (github.com/AgriciDaniel/jev-seo, MIT), vendored in an isolated venv on
// D: (D:\jev-seo\venv + D:\jev-seo\src, pinned to commit JEV_SEO_PINNED_COMMIT -- C: is low on
// disk, see AGENTS.md). Founder-clicked, one lead at a time: a single process-wide lock (not a
// per-lead one) enforces concurrency 1, so a second click anywhere -- even for a different lead --
// waits or fails with SeoAuditBusyError rather than running two crawls at once. Always the standard
// (~1c) mode: --full/DataForSEO is a paid API and is never passed here. The API key is resolved the
// same way this project already resolves it for Jev (provider-config.ts's TYPESAFE_API_KEY /
// JEV_API_KEY lookup) and is handed to the child process's environment only -- never written to a
// file, logged, printed or returned to any caller.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerKey } from "../provider-config";
import { dataDirFor } from "../cloud/data-dir";

/** github.com/AgriciDaniel/jev-seo -- reviewed commit, installed at D:\jev-seo\src. Bump deliberately. */
export const JEV_SEO_PINNED_COMMIT = "55a184a3b0d09565a4c84268f725a47784e62528";

const JEV_SEO_PYTHON = process.env.JEV_SEO_PYTHON || "D:\\jev-seo\\venv\\Scripts\\python.exe";
const JEV_SEO_SRC = process.env.JEV_SEO_SRC || "D:\\jev-seo\\src";

export const auditDir = (root: string, leadId: number) => join(dataDirFor(root), "seo-audits", String(leadId));
const recordPath = (root: string, leadId: number) => join(auditDir(root, leadId), "run.json");

export type SeoFinding = { id: string; severity: string; priority: string; category: string; title: string; evidence: string };
export type SeoAuditFiles = { pdf: boolean; xlsx: boolean; md: boolean; json: boolean };
export type SeoAuditRecord = {
  leadId: number;
  domain: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error: string | null;
  overall: number | null;
  grade: string | null;
  topFindings: SeoFinding[];
  costUsd: number | null;
  files: SeoAuditFiles;
};

export function readSeoAudit(root: string, leadId: number): SeoAuditRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(root, leadId), "utf8")) as SeoAuditRecord;
  } catch {
    return null;
  }
}

export function seoAuditFilePath(root: string, leadId: number, kind: "pdf" | "xlsx" | "md" | "json"): string {
  return join(auditDir(root, leadId), kind === "json" ? "audit.json" : `report.${kind}`);
}

function fileState(dir: string): SeoAuditFiles {
  return {
    pdf: existsSync(join(dir, "report.pdf")),
    xlsx: existsSync(join(dir, "report.xlsx")),
    md: existsSync(join(dir, "report.md")),
    json: existsSync(join(dir, "audit.json")),
  };
}

/** The action tracker (`audit.json`'s `actions`) is already sorted best-first (priority, then
 *  impact, then effort) by jev-seo's own scorer -- this only reshapes the top few for our UI and
 *  for the call-script prompt. Never invents wording: title/evidence are jev-seo's own text. */
export function topFindings(auditJson: any, n = 3): SeoFinding[] {
  const actions = Array.isArray(auditJson?.actions) ? auditJson.actions : [];
  return actions.slice(0, n).map((a: any) => ({
    id: String(a.id ?? a.action_id ?? ""),
    severity: String(a.severity ?? ""),
    priority: String(a.priority ?? ""),
    category: String(a.category ?? ""),
    title: String(a.title ?? "").slice(0, 200),
    evidence: String(a.evidence ?? "").slice(0, 300),
  }));
}

/** A short, spoken-style line naming the top findings -- the drawer's own preview of what the call
 *  script may cite. Mirrors outreach.ts's humaniseOpenerHook (same "at most 2, joined naturally"
 *  shape) but over jev-seo's own finding titles rather than score.ts's verdict string. */
export function seoOpenerHook(findings: SeoFinding[]): string {
  const phrases = findings.slice(0, 2).map((f) => f.title.replace(/\.$/, "").toLowerCase());
  if (!phrases.length) return "";
  return phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/** Verified facts a call-script prompt can safely cite: our own measurement of the lead's own
 *  site, same evidentiary standing as the CRM's own [verified] reasons. */
export function seoVerifiedFacts(findings: SeoFinding[]): string[] {
  return findings.map((f) => (f.evidence ? `${f.title} (${f.evidence})` : f.title));
}

let running: { leadId: number; startedAt: string } | null = null;

export class SeoAuditBusyError extends Error {}
export class SeoAuditConfigError extends Error {}

function childEnv(key: string): NodeJS.ProcessEnv {
  // Only this child process's environment carries the key; it is never written to disk or logged.
  return { ...process.env, TYPESAFE_API_KEY: key };
}

function runChild(
  spawnFn: typeof spawn,
  python: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(python, args, { cwd, env, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`jev-seo timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderrTail });
    });
  });
}

export type RunSeoAuditOptions = {
  root: string;
  timeoutMs?: number;
  maxPages?: number;
  /** "xlsx,md" by default: the PDF path needs WeasyPrint's native GTK/Pango/Cairo libraries, which
   *  aren't present on every Windows machine and are never installed automatically by this code
   *  (that would mean changing system-wide libraries/PATH, which we don't do without being asked).
   *  Once `jevseo doctor` reports weasyprint "ok" on a given machine, pass "pdf,xlsx,md". */
  formats?: string;
  spawnFn?: typeof spawn;
  /** The Python interpreter and the jev-seo source folder. Default: the D: install (or JEV_SEO_PYTHON / JEV_SEO_SRC).
   *  Injected by tests so nothing depends on which machine they run on: the "is it installed" check below runs before
   *  the one-audit-at-a-time lock is taken, so a machine without the D: install used to fail the lock test with a
   *  config error instead of the busy error it was written to see. */
  python?: string;
  src?: string;
  /** Test-only override for providerKey's lookup, so tests never depend on this machine's real
   *  ~/.config/agentic-os.env or process.env having (or lacking) a key. */
  env?: NodeJS.ProcessEnv;
  home?: string;
};

/** Runs one standard (never --full) jev-seo audit for a lead's own site. Read-only, polite crawl
 *  (jev-seo respects robots.txt and Crawl-delay itself); this only chooses a modest page cap and a
 *  hard wall-clock timeout so a slow or huge site can't hang the drawer. */
export async function runSeoAudit(
  lead: { id: number; website: string },
  opts: RunSeoAuditOptions,
): Promise<SeoAuditRecord> {
  if (!lead.website) throw new Error("This lead has no website on file.");
  if (running) throw new SeoAuditBusyError(`An SEO audit is already running (lead #${running.leadId}) -- wait for it to finish.`);
  const keyOpts = opts.env || opts.home ? { env: opts.env, home: opts.home } : undefined;
  const key = providerKey(opts.root, "TYPESAFE_API_KEY", keyOpts) || providerKey(opts.root, "JEV_API_KEY", keyOpts);
  if (!key) throw new SeoAuditConfigError("No TYPESAFE_API_KEY or JEV_API_KEY configured -- add one to ~/.config/agentic-os.env.");
  const python = opts.python ?? JEV_SEO_PYTHON;
  const src = opts.src ?? JEV_SEO_SRC;
  if (!existsSync(python)) throw new SeoAuditConfigError(`jev-seo isn't installed at ${python} -- set up the venv on D: first.`);

  const startedAt = new Date().toISOString();
  running = { leadId: lead.id, startedAt };
  const dir = auditDir(opts.root, lead.id);
  mkdirSync(dir, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000;
  const maxPages = opts.maxPages ?? 30;
  const formats = opts.formats ?? "xlsx,md";

  try {
    const args = [
      "-m", "jevseo", "run", lead.website,
      "--out", dir,
      "--max-pages", String(maxPages),
      "--time-budget", "240",
      "--formats", formats,
    ];
    const { code, stderrTail } = await runChild(opts.spawnFn ?? spawn, python, args, src, childEnv(key), timeoutMs);
    if (code !== 0) throw new Error(`jev-seo exited ${code}${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`);

    const auditJsonPath = join(dir, "audit.json");
    if (!existsSync(auditJsonPath)) throw new Error("jev-seo finished but wrote no audit.json.");
    const data = JSON.parse(readFileSync(auditJsonPath, "utf8"));
    const findings = topFindings(data, 3);
    const domain: string = data?.site?.domain ?? lead.website;

    // formats never includes "pdf" above -- jev-seo's own PDF path needs WeasyPrint, which needs
    // GTK/Pango/Cairo system libraries this machine doesn't have, and we don't install system-wide
    // libraries or change PATH to get them. seo_audit_pdf.py builds report.pdf itself instead, by
    // reusing jev-seo's own HTML report template (unmodified) and printing it with the headless
    // Chromium already vendored for other tools (D:\crawl4ai). Best-effort: a PDF-build failure
    // never fails the audit itself, since report.xlsx/report.md still stand.
    try {
      await runChild(
        opts.spawnFn ?? spawn,
        python,
        [join(opts.root, "scripts", "leads", "seo_audit_pdf.py"), "--dir", dir],
        src,
        childEnv(key),
        120_000,
      );
    } catch {
      // No report.pdf; the drawer falls back to "PDF not built on this machine yet."
    }

    // jev-seo has no theming hook (checked its CLI, templates and docs) -- brand the PDF with a
    // simple cover page instead, when one was built. Best-effort: a branding failure never fails
    // the audit itself, since the unbranded report is still useful.
    if (existsSync(join(dir, "report.pdf"))) {
      try {
        await runChild(
          opts.spawnFn ?? spawn,
          python,
          [
            join(opts.root, "scripts", "leads", "seo_audit_brand.py"),
            "--pdf", join(dir, "report.pdf"),
            "--domain", domain,
            ...(data?.scores?.overall != null ? ["--overall", String(data.scores.overall)] : []),
            ...(data?.scores?.grade ? ["--grade", String(data.scores.grade)] : []),
          ],
          src,
          childEnv(key),
          60_000,
        );
      } catch {
        // Unbranded report.pdf stands; the drawer still offers it.
      }
    }

    const record: SeoAuditRecord = {
      leadId: lead.id,
      domain: data?.site?.domain ?? lead.website,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      error: null,
      overall: data?.scores?.overall ?? null,
      grade: data?.scores?.grade ?? null,
      topFindings: findings,
      costUsd: data?.jev?.ledger?.cost_usd ?? null,
      files: fileState(dir),
    };
    writeFileSync(recordPath(opts.root, lead.id), JSON.stringify(record, null, 2));
    return record;
  } catch (error) {
    const record: SeoAuditRecord = {
      leadId: lead.id,
      domain: lead.website,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      overall: null,
      grade: null,
      topFindings: [],
      costUsd: null,
      files: fileState(dir),
    };
    writeFileSync(recordPath(opts.root, lead.id), JSON.stringify(record, null, 2));
    throw error;
  } finally {
    running = null;
  }
}
