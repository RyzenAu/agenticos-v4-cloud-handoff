// Monthly care-plan report draft, one per won client. Re-runs the SEO audit and an uptime/response
// check, lists the month's changes (from git log against a client repo, or a CHANGES.md file kept
// per client), and writes a client-friendly email + an HTML report -- draft only, into
// .operator-data/drafts/care-plan/<slug>/<month>/. Nothing here sends an email or touches a repo
// other than reading its log.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { previewSlug } from "../lead-sites/fill";
import { mimoBulkEnabled, MIMO_MODELS } from "../llm/mimo";
import { callMimo } from "../llm/mimo";
import type { Lead } from "./crm";
import { readSeoAudit, runSeoAudit, type SeoAuditRecord } from "./seo-audit";
import { auditSite, type SiteAudit } from "./site-audit";

export function carePlanClientSlug(lead: Lead): string {
  return previewSlug(lead.name || `lead-${lead.id}`, lead.id);
}

export function carePlanMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

export function carePlanDir(root: string, slug: string, month: string) {
  return join(root, ".operator-data", "drafts", "care-plan", slug, month);
}

function changesFilePath(root: string, slug: string): string {
  return join(root, ".operator-data", "care-plan", slug, "CHANGES.md");
}

/** Changes for the month from a per-client CHANGES.md (one `- ` bullet per change, founders keep
 *  it updated by hand), falling back to `git log` against an explicit client repo path if given.
 *  Never both -- CHANGES.md wins when it exists, since a client repo path isn't always known here. */
export function monthChanges(root: string, slug: string, month: string, repoPath?: string): { source: "changes-file" | "git-log" | "none"; items: string[] } {
  const file = changesFilePath(root, slug);
  if (existsSync(file)) {
    const items = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .filter((l) => !month || l.includes(`[${month}`) || true) // CHANGES.md has no date field of its own yet -- surfaces everything on file
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter(Boolean);
    return { source: "changes-file", items };
  }
  if (repoPath && existsSync(repoPath)) {
    try {
      const since = `${month}-01`;
      const [y, m] = month.split("-").map(Number);
      const untilDate = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
      const until = untilDate.toISOString().slice(0, 10);
      const out = execFileSync("git", ["log", `--since=${since}`, `--until=${until}`, "--pretty=%s"], { cwd: repoPath, encoding: "utf8", timeout: 15_000 });
      const items = out.split("\n").map((l) => l.trim()).filter(Boolean);
      return { source: "git-log", items };
    } catch {
      return { source: "none", items: [] };
    }
  }
  return { source: "none", items: [] };
}

export type CarePlanData = {
  lead: Lead;
  slug: string;
  month: string;
  generatedAt: string;
  seo: { ok: boolean; note: string; topFindings: string[] };
  uptime: { ok: boolean; reachable: boolean; responseMs: number | null; statusCode: number | null; note: string };
  changes: { source: "changes-file" | "git-log" | "none"; items: string[] };
};

/** Gathers this month's evidence for one won client. Re-runs the SEO audit (best-effort -- a
 *  missing jev-seo install or API key never fails the whole report, it just notes the audit was
 *  skipped) and a plain uptime/response check (site-audit.ts, the same one leads use). */
export async function gatherCarePlanData(
  db: Database,
  lead: Lead,
  opts: {
    root: string;
    month?: string;
    repoPath?: string;
    now?: Date;
    skipSeoAudit?: boolean;
    runSeoAuditFn?: typeof runSeoAudit;
    auditSiteFn?: typeof auditSite;
  },
): Promise<CarePlanData> {
  const now = opts.now ?? new Date();
  const month = opts.month ?? carePlanMonth(now);
  const slug = carePlanClientSlug(lead);
  const runSeoAuditFn = opts.runSeoAuditFn ?? runSeoAudit;
  const auditSiteFn = opts.auditSiteFn ?? auditSite;

  let seo: CarePlanData["seo"] = { ok: false, note: "No website on file.", topFindings: [] };
  if (lead.website) {
    try {
      let record: SeoAuditRecord;
      if (opts.skipSeoAudit) {
        const existing = readSeoAudit(opts.root, lead.id);
        if (!existing) throw new Error("no audit on file and --skip-seo-audit was given");
        record = existing;
      } else {
        record = await runSeoAuditFn(lead, { root: opts.root });
      }
      seo = { ok: record.ok, note: record.ok ? "Audit refreshed this run." : record.error ?? "Audit reported no result.", topFindings: record.topFindings.map((f) => f.title) };
    } catch (err) {
      seo = { ok: false, note: `SEO audit skipped: ${(err as Error).message}`, topFindings: [] };
    }
  }

  let uptime: CarePlanData["uptime"] = { ok: false, reachable: false, responseMs: null, statusCode: null, note: "No website on file." };
  if (lead.website) {
    try {
      const audit: SiteAudit = await auditSiteFn(lead.website);
      uptime = {
        ok: audit.reachable && !audit.broken,
        reachable: audit.reachable,
        responseMs: audit.responseMs,
        statusCode: audit.statusCode,
        note: audit.reachable ? `Responded${audit.responseMs !== null ? ` in ${audit.responseMs}ms` : ""} (HTTP ${audit.statusCode ?? "?"}).` : `Unreachable: ${audit.error ?? "no response"}.`,
      };
    } catch (err) {
      uptime = { ok: false, reachable: false, responseMs: null, statusCode: null, note: `Uptime check failed: ${(err as Error).message}` };
    }
  }

  const changes = monthChanges(opts.root, slug, month, opts.repoPath);

  return { lead, slug, month, generatedAt: now.toISOString(), seo, uptime, changes };
}

function templateEmail(data: CarePlanData): { subject: string; body: string } {
  const kickoff = data.lead.name;
  const changeLines = data.changes.items.length ? data.changes.items.map((c) => `- ${c}`).join("\n") : "- No changes recorded this month.";
  const seoLine = data.seo.ok
    ? data.seo.topFindings.length
      ? `Top items from this month's SEO check: ${data.seo.topFindings.slice(0, 3).join("; ")}.`
      : "This month's SEO check found no new issues."
    : `SEO check: ${data.seo.note}`;
  const body = [
    `Hi,`,
    ``,
    `A quick update on ${kickoff}'s site for ${data.month}:`,
    ``,
    `Uptime: ${data.uptime.note}`,
    seoLine,
    ``,
    `What we did this month:`,
    changeLines,
    ``,
    `Let us know if you'd like anything changed or added.`,
    ``,
    `M&U Ventures`,
  ].join("\n");
  return { subject: `${kickoff} — monthly care plan (${data.month})`, body };
}

/** MiMo-polished prose over the deterministic template (MIMO_BULK=1 only, and best-effort -- a
 *  failed or disabled call just leaves the plain template in place, never blocks the draft). */
async function polishEmail(root: string, draft: { subject: string; body: string }, data: CarePlanData): Promise<{ subject: string; body: string; model: string }> {
  if (!mimoBulkEnabled()) return { ...draft, model: "template (MIMO_BULK not set)" };
  try {
    const result = await callMimo({
      root,
      task: "care-plan-email",
      model: MIMO_MODELS.flash,
      maxTokens: 600,
      messages: [
        { role: "system", content: "You rewrite a short, factual monthly client care-plan email in plain Australian English. Never invent a fact not already in the draft -- only rephrase for warmth and clarity. Keep every fact (uptime, SEO note, changes list) intact. Reply with the email body only, no subject line, no markdown fences." },
        { role: "user", content: draft.body },
      ],
    });
    return { subject: draft.subject, body: result.text.trim() || draft.body, model: result.model };
  } catch (err) {
    return { ...draft, model: `template (MiMo failed: ${(err as Error).message.slice(0, 100)})` };
  }
}

function renderHtmlReport(data: CarePlanData, email: { subject: string; body: string }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<title>${esc(email.subject)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;line-height:1.5;color:#222}h1{font-size:1.25rem}ul{padding-left:1.2rem}</style>",
    "</head><body>",
    `<h1>${esc(email.subject)}</h1>`,
    `<p><strong>Uptime:</strong> ${esc(data.uptime.note)}</p>`,
    `<p><strong>SEO:</strong> ${esc(data.seo.ok ? (data.seo.topFindings.slice(0, 3).join("; ") || "No new issues.") : data.seo.note)}</p>`,
    "<p><strong>Changes this month:</strong></p>",
    data.changes.items.length ? `<ul>${data.changes.items.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : "<p>No changes recorded this month.</p>",
    `<p style="color:#888;font-size:.85rem">Draft only -- generated ${esc(data.generatedAt)}. Nothing here has been sent.</p>`,
    "</body></html>",
  ].join("\n");
}

export type CarePlanDraft = { data: CarePlanData; email: { subject: string; body: string; model: string }; paths: { emailPath: string; reportPath: string } };

export async function buildCarePlanDraft(
  db: Database,
  lead: Lead,
  opts: {
    root: string;
    month?: string;
    repoPath?: string;
    now?: Date;
    skipSeoAudit?: boolean;
    runSeoAuditFn?: typeof runSeoAudit;
    auditSiteFn?: typeof auditSite;
  },
): Promise<CarePlanDraft> {
  const data = await gatherCarePlanData(db, lead, opts);
  const template = templateEmail(data);
  const email = await polishEmail(opts.root, template, data);
  const dir = carePlanDir(opts.root, data.slug, data.month);
  mkdirSync(dir, { recursive: true });
  const emailPath = join(dir, "email.md");
  const reportPath = join(dir, "report.html");
  writeFileSync(emailPath, `Subject: ${email.subject}\n\n${email.body}\n`);
  writeFileSync(reportPath, renderHtmlReport(data, email));
  return { data, email, paths: { emailPath, reportPath } };
}

export function renderCarePlanSummary(draft: CarePlanDraft): string {
  return [
    `Care plan draft · ${draft.data.lead.name} · ${draft.data.month}`,
    `Uptime: ${draft.data.uptime.note}`,
    `SEO: ${draft.data.seo.note}`,
    `Changes: ${draft.data.changes.items.length} (${draft.data.changes.source})`,
    `Email model: ${draft.email.model}`,
    `Written: ${draft.paths.emailPath}`,
    `         ${draft.paths.reportPath}`,
    "Draft only -- nothing sent.",
  ].join("\n");
}
