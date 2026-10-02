// CLI entry for "Jarvis, draft a website for <lead>" — used directly by Hermes (see the
// mu-site-draft skill) and by the /__site-draft/draft operator endpoint (scripts/site-draft/plugin.ts).
//   bun scripts/site-draft/cli.ts draft "St Clair Dental"              # selected dental flagship
//   bun scripts/site-draft/cli.ts draft 1 --serve                      # own-origin local preview
//   bun scripts/site-draft/cli.ts draft 1 --bespoke                    # explicit custom Claude design
//   bun scripts/site-draft/cli.ts draft 1 --bespoke --fast             # explicit generic draft (v1)
//   bun scripts/site-draft/cli.ts draft 1 --build-timeout 480000       # override the build time cap (ms)
//
// Task 6 (MINISTRY-BACKLOG-2026-09-24.md): QA for a PAID CLIENT build, before any preview goes
// out — separate from the "draft" command above, which is for CRM-prospect drafts only.
//   bun scripts/site-draft/cli.ts qa --dir <path> --evidence <file|auto>
import { openCrm, crmPath } from "../leads/crm";
import { defaultDraftsRoot } from "./orchestrator";
import { draftForLead } from "./dispatch";
import { localPreviewUrl, startPreviewServer } from "../lead-sites/preview-server";
import { startDraftServer } from "./serve";
import { runClientQa, renderClientQaReport } from "./client-qa";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

async function runQaCommand(rest: string[]) {
  const dirIdx = rest.indexOf("--dir");
  const dir = dirIdx >= 0 ? rest[dirIdx + 1] : undefined;
  if (!dir || !existsSync(dir)) {
    console.error('Usage: bun scripts/site-draft/cli.ts qa --dir "<path to client build>" [--evidence <path-to-CLIENT.md>|auto] [--out <report path>]');
    process.exit(1);
    return;
  }
  const evidenceIdx = rest.indexOf("--evidence");
  const evidence = evidenceIdx >= 0 ? rest[evidenceIdx + 1] : "auto";
  const outIdx = rest.indexOf("--out");
  const buildDir = resolve(dir);
  const report = await runClientQa(buildDir, { evidence });
  const md = renderClientQaReport(report);

  const outPath = outIdx >= 0
    ? resolve(rest[outIdx + 1])
    : join(buildDir, "..", "review", `QA-REPORT-${report.generatedAt.slice(0, 10)}.md`);
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, md, "utf8");

  console.log(`Verdict: ${report.verdict}`);
  console.log(`Fail issues: ${report.issues.filter((i) => i.severity === "fail").length}, warnings: ${report.issues.filter((i) => i.severity === "warn").length}`);
  console.log(`Report written to ${outPath}`);
  if (report.verdict === "NOT READY") process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest0] = process.argv.slice(2);
  if (cmd === "qa") {
    await runQaCommand(rest0);
    return;
  }
  const [ref, ...rest] = rest0;
  if (cmd !== "draft" || !ref) {
    console.error('Usage: bun scripts/site-draft/cli.ts draft "<lead name or id>" [--serve] [--bespoke|--flagship] [--fast] [--by <name>] [--build-timeout <ms>]');
    console.error('       bun scripts/site-draft/cli.ts qa --dir "<path>" [--evidence <file>|auto]');
    process.exit(1);
  }
  const serve = rest.includes("--serve");
  const fast = rest.includes("--fast");
  const byIdx = rest.indexOf("--by");
  const by = byIdx >= 0 ? rest[byIdx + 1] : "jarvis-cli";
  const timeoutIdx = rest.indexOf("--build-timeout");
  const buildTimeoutMs = timeoutIdx >= 0 ? Number(rest[timeoutIdx + 1]) : undefined;
  const root = process.cwd();
  const db = openCrm(crmPath(root));
  const started = Date.now();

  let draft: Awaited<ReturnType<typeof draftForLead>>;
  try {
    draft = await draftForLead(db, ref, { root, draftsRoot: defaultDraftsRoot(), by, fast,
      mode: rest.includes("--bespoke") ? "bespoke" : rest.includes("--flagship") ? "flagship" : undefined,
      buildOptions: buildTimeoutMs ? { timeoutMs: buildTimeoutMs } : undefined });
  } finally { db.close(); }
  if (draft.kind === "flagship") {
    const { record } = draft.result;
    console.log(`Flagship preview ready for ${record.business}: ${record.dir}`);
    console.log(`Preview: ${localPreviewUrl(record.slug)} (local only, not deployed)`);
    if (serve) {
      const preview = startPreviewServer({ root, draftsRoot: defaultDraftsRoot() });
      preview.server.ref();
    }
    return;
  }
  if (draft.kind === "fast") {
    const result = draft.result;
    const ms = Date.now() - started;
    console.log(`[fast] Draft ready for ${result.lead.name}: ${result.indexPath} (${ms}ms)`);
    if (serve) {
      const server = startDraftServer(result.dir);
      console.log(`Preview: http://127.0.0.1:${server.port}`);
    }
    return;
  }

  const result = draft.result;
  const ms = Date.now() - started;
  const qaLine = result.qa ? (result.qa.pass ? "QA PASS" : `QA REVIEW NEEDED (${result.qa.issues.filter((i) => i.severity === "fail").length} fail issue(s))`) : "build failed — see BUILD-ERROR.md";
  console.log(`Draft ready for ${result.lead.name}: ${result.indexPath}`);
  console.log(`  ${qaLine} — ${result.attempts} build attempt(s), ${Math.round(result.buildMs / 1000)}s build time, ${ms}ms total`);
  console.log(`  Imagery: ${result.imagery.engine} (${result.imagery.assets.length} asset(s), ${result.imagery.totalCredits.toFixed(1)} Higgsfield credit(s))`);
  if (serve) {
    const server = startDraftServer(result.dir);
    console.log(`Preview: http://127.0.0.1:${server.port}`);
  }
}

if (import.meta.main) main();
