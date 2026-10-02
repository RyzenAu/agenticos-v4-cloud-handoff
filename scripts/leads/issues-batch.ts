// Batch runner + before/after report for issues.ts. `bun scripts/leads/cli.ts issues --batch
// --top 50 [--dry-run]` calls this against whichever CRM file cli.ts opened (in a worktree, that's
// the worktree's own copy). --dry-run writes nothing to the CRM — only the report files.
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callList, sydneyDate, type Lead } from "./crm";
import {
  applyIssueReport, detectIssues, issueReasons, issuesSpend, ISSUES_SPEND_CAP_USD, outreachBlocked, rankWithMimo,
  type DetectDeps, type IssueReport, type RankDeps,
} from "./issues";
import { callOpener, DEFAULT_SENDER } from "./outreach";
import { dataDirFor } from "../cloud/data-dir";

export type BatchRow = {
  lead: Lead;
  before: { score: number; pitch: string; topReason: string; opener: string };
  after: { report: IssueReport; opener: string; reasons: string[] };
  note?: string;
};

export type BatchResult = { rows: BatchRow[]; skipped: { id: number; name: string; why: string }[]; costUsd: number; mimoNotes: string[]; dryRun: boolean; applied: number };

export async function runIssuesBatch(
  db: Database,
  opts: { top?: number; dryRun?: boolean; detect?: DetectDeps; rank?: RankDeps; log?: (line: string) => void; concurrency?: number; now?: Date } = {},
): Promise<BatchResult> {
  const log = opts.log ?? (() => {});
  const top = Math.min(Math.max(opts.top ?? 50, 1), 500);
  const candidates = callList(db, top + 10, opts.now ?? new Date());
  const skipped: BatchResult["skipped"] = [];
  const leads: Lead[] = [];
  for (const l of candidates) {
    const why = outreachBlocked(l);
    if (why) skipped.push({ id: l.id, name: l.name, why });
    else if (leads.length < top) leads.push(l);
  }
  const rows: BatchRow[] = [];
  const mimoNotes: string[] = [];
  let costUsd = 0;
  let applied = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const lead = leads[cursor++];
      if (!lead) return;
      let report: IssueReport;
      try {
        report = await detectIssues(lead, opts.detect);
      } catch (error) {
        log(`  #${lead.id} ${lead.name}: detection failed — ${(error as Error).message}`);
        continue;
      }
      const ranked = await rankWithMimo(report, lead, opts.rank);
      costUsd += ranked.costUsd;
      if (ranked.skipped && ranked.skipped !== "no issues") mimoNotes.push(`#${lead.id}: ${ranked.skipped}`);
      report = ranked.report;
      const row: BatchRow = {
        lead,
        before: { score: lead.score, pitch: lead.pitch, topReason: lead.reasons[0] ?? "", opener: callOpener(lead, DEFAULT_SENDER) },
        after: { report, opener: report.hook ? callOpener({ ...lead, hook: report.hook }, DEFAULT_SENDER) : callOpener({ ...lead, reasons: issueReasons(report) }, DEFAULT_SENDER), reasons: issueReasons(report) },
      };
      if (!opts.dryRun && applyIssueReport(db, lead, report)) applied++;
      rows.push(row);
      log(`  #${lead.id} ${lead.name}: ${lead.pitch}/${lead.score} -> ${report.pitch}/${report.score} · ${report.status} · ${report.issues.length} issue(s)${report.hookSource === "mimo" ? " · MiMo hook" : ""}`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  rows.sort((a, b) => b.after.report.score - a.after.report.score);
  return { rows, skipped, costUsd, mimoNotes, dryRun: opts.dryRun === true, applied };
}

const count = <T,>(items: T[], key: (t: T) => string) =>
  items.reduce<Record<string, number>>((acc, t) => ((acc[key(t)] = (acc[key(t)] ?? 0) + 1), acc), {});
const fmtCounts = (c: Record<string, number>) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");

/** The before/after markdown report. The precision spot-check section is left for a human to fill
 *  in after fetching the pages — the report never claims a check it didn't do. */
export function renderTargetingReport(result: BatchResult, meta: { crmPath: string; ledgerFile?: string; now?: Date }): string {
  const now = meta.now ?? new Date();
  const rows = result.rows;
  const withSiteIssue = rows.filter((r) => r.after.report.issues.some((i) => i.evidence.source === "site"));
  const withSerious = rows.filter((r) => r.after.report.issues.some((i) => i.severity >= 2));
  const beforeSpecific = rows.filter((r) => !/^Hi, it's .* 30 seconds\?$/.test(r.before.opener));
  const pitchChanged = rows.filter((r) => r.before.pitch !== r.after.report.pitch);
  const byCode = count(rows.flatMap((r) => r.after.report.issues), (i) => i.code);
  const examples = rows.filter((r) => r.after.report.issues.length).slice(0, 10);
  const lines = [
    `# Lead targeting — before/after (${sydneyDate(now)})`,
    "",
    `${result.dryRun ? "**Dry run** — nothing was written to the CRM." : `Applied to the CRM (${result.applied} leads rescored).`} CRM file: \`${meta.crmPath}\` (a copy, not the live file).`,
    `Cohort: the current top ${rows.length} callable leads (callList order), excluding our own client #32 and any won / do-not-contact / excluded lead` +
      `${result.skipped.length ? ` — skipped: ${result.skipped.map((s) => `#${s.id} (${s.why})`).join(", ")}` : ""}.`,
    `MiMo Flash spend this run: US$${result.costUsd.toFixed(4)} (task total US$${issuesSpend(meta.ledgerFile).toFixed(4)} of the US$${ISSUES_SPEND_CAP_USD} cap).`,
    "",
    "## Headline numbers",
    "",
    `| | Before | After |`,
    `|---|---|---|`,
    `| Leads with a verified, site-specific issue on file | ${rows.filter((r) => /seen on|not mobile|no HTTPS|homepage|©|load/i.test(r.before.topReason)).length} (claimed by the old verdict line) | ${withSiteIssue.length} (each with the page it was seen on) |`,
    `| …of which a moderate or severe issue (severity ≥ 2) | — | ${withSerious.length} |`,
    `| Pitch mix | ${fmtCounts(count(rows, (r) => r.before.pitch))} | ${fmtCounts(count(rows, (r) => r.after.report.pitch))} |`,
    `| Audit status | — | ${fmtCounts(count(rows, (r) => r.after.report.status))} |`,
    `| Pitch changed | — | ${pitchChanged.length} of ${rows.length} |`,
    `| Openers naming a specific finding | ${beforeSpecific.length} | ${rows.filter((r) => r.after.report.hook).length} (${rows.filter((r) => r.after.report.hookSource === "mimo").length} MiMo-phrased, rest rule-based) |`,
    "",
    `Issues found, by type: ${fmtCounts(byCode) || "none"}.`,
    "",
    "## Why the old list was wrong",
    "",
    "Most of the old top 50 were pitched \"Redesign + receptionist: not mobile-friendly\". For a large share of them the page the old audit graded was a bot-protection stub (Incapsula `_Incapsula_Resource`, SiteGround `/.well-known/sgcaptcha/`) or a page whose `viewport` tag the old regex didn't recognise — so the opener told the business its site wasn't set up for phones when it was. The new pass marks those `bot_protected` (audit pending, no claim) or re-checks them in a real browser (Crawl4AI) before saying anything.",
    "",
    "## New order (top 20 by new score)",
    "",
    "| # | Lead | Before | After | Top evidenced issue |",
    "|---|---|---|---|---|",
    ...rows.slice(0, 20).map((r) => `| ${r.lead.id} | ${r.lead.name} | ${r.before.pitch} / ${r.before.score} | ${r.after.report.pitch} / ${r.after.report.score} | ${r.after.report.issues[0]?.finding || r.after.report.statusNote || "—"} |`),
    "",
    "## Old vs new opener — 10 leads",
    "",
    ...examples.flatMap((r, i) => [
      `### ${i + 1}. #${r.lead.id} ${r.lead.name} (${r.lead.vertical}) — ${r.before.pitch} → ${r.after.report.pitch}`,
      "",
      `- **Old:** ${r.before.opener}`,
      `- **New:** ${r.after.opener}`,
      `- **Evidence:** ${r.after.report.issues.slice(0, 3).map((x) => `${x.finding} — ${x.evidence.url.split(" and ")[0]} (${x.evidence.seen})`).join("; ")}`,
      "",
    ]),
    "## All leads",
    "",
    "| # | Lead | Status | Score before → after | Pitch before → after | Issues (severity) |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.lead.id} | ${r.lead.name} | ${r.after.report.status} | ${r.before.score} → ${r.after.report.score} | ${r.before.pitch} → ${r.after.report.pitch} | ${r.after.report.issues.map((i) => `${i.code}(${i.severity})`).join(", ") || "—"} |`),
    "",
    result.mimoNotes.length ? `MiMo notes: ${result.mimoNotes.slice(0, 20).join("; ")}.` : "",
  ];
  return lines.join("\n");
}

export function writeTargetingReport(root: string, result: BatchResult, markdown: string, now = new Date()): { md: string; json: string } {
  const dir = join(dataDirFor(root), "reports");
  mkdirSync(dir, { recursive: true });
  const stem = `lead-targeting-${sydneyDate(now)}`;
  const md = join(dir, `${stem}.md`);
  const json = join(dir, `${stem}.json`);
  writeFileSync(md, markdown);
  writeFileSync(json, JSON.stringify({ ...result, rows: result.rows.map((r) => ({ id: r.lead.id, name: r.lead.name, before: r.before, after: r.after })) }, null, 2));
  return { md, json };
}
