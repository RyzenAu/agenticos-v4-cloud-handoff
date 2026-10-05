import type { ArtifactInput } from "../artifacts";
import type { ItemCoverage, Fact, Metrics, Source } from "../research";
import { AUDIT_EXECUTOR, DEFAULT_AUDIT_SITES, resolveTarget, runAudit, type AuditParams } from "./audit";
import { BIZPREP_EXECUTOR, readInfo, runBizprep, type BizParams } from "./bizprep";
import { BUILDER_EXECUTOR, runBuilder, type BuilderParams } from "./builder";
import { type WorkflowIO, type WorkflowKind, type WorkflowResult } from "./common";

/**
 * The four bot-computer workflows as job steps. Research is the older loop (research.ts, executor "research"); the other three are the executors
 * "builder", "audit" and "bizprep". This file is the one place the computers service asks "is this a workflow step, is it valid, and run it".
 */

export { AUDIT_EXECUTOR, BIZPREP_EXECUTOR, BUILDER_EXECUTOR, DEFAULT_AUDIT_SITES };
export const WORKFLOW_EXECUTORS: readonly string[] = [BUILDER_EXECUTOR, AUDIT_EXECUTOR, BIZPREP_EXECUTOR];
export const isWorkflowExecutor = (s: string): s is WorkflowKind => WORKFLOW_EXECUTORS.includes(s);

/** What the computer must run for each workflow (a computer on an older companion says so up front, before anything is touched). */
export const NEEDS: Record<WorkflowKind, string[]> = {
  builder: ["build.component", "file.chunk"],
  audit: ["page.audit", "page.links", "file.chunk", "file.write"],
  bizprep: ["file.write"],
};

export type WorkflowOptions = { allowedAuditHosts?: string[] };

/** Validate a workflow step's arguments up front. The step runs with exactly the arguments returned. Pure. */
export function validateWorkflowStep(executor: WorkflowKind, args: Record<string, unknown> | undefined, options: WorkflowOptions = {}): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  const a = args ?? {};
  if (executor === "builder") {
    const brief = String(a.brief ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (brief.length < 3) return { ok: false, reason: "A builder step needs a brief: what to build or change." };
    return { ok: true, args: { brief } };
  }
  if (executor === "audit") {
    const r = resolveTarget({ url: typeof a.url === "string" ? a.url : undefined, fixture: typeof a.fixture === "string" ? a.fixture : undefined }, options.allowedAuditHosts ?? DEFAULT_AUDIT_SITES);
    if (!r.ok) return { ok: false, reason: `${r.reason} Nothing was opened.` };
    return { ok: true, args: r.target.kind === "fixture" ? { fixture: a.fixture } : { url: r.target.url.href } };
  }
  const kind = a.kind === "proposal" ? "proposal" : "comparison";
  const brief = String(a.brief ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (a.info !== undefined && !readInfo(a.info)) return { ok: false, reason: "The information needs 2 to 5 options, each with a name and a whole-cent price." };
  return { ok: true, args: { kind, brief, ...(a.info !== undefined ? { info: a.info } : {}) } };
}

export async function runWorkflow(executor: WorkflowKind, args: Record<string, unknown>, io: WorkflowIO, options: WorkflowOptions = {}): Promise<WorkflowResult> {
  if (executor === "builder") return runBuilder({ params: args as unknown as BuilderParams, io });
  if (executor === "audit") return runAudit({ params: { ...(args as AuditParams), allowedHosts: options.allowedAuditHosts ?? DEFAULT_AUDIT_SITES }, io });
  return runBizprep({ params: args as unknown as BizParams, io });
}

/** The research report as an artifact: the full report as markdown, what was asked for item by item, and the facts and sources as data. Pure. */
export function researchArtifact(i: { goal: string; reports: { concise: string; full: string }; sources: Source[]; facts: Fact[]; items: ItemCoverage[]; outcome: "complete" | "partial"; metrics: Metrics }): Pick<ArtifactInput, "kind" | "title" | "summary" | "outcome" | "main" | "files"> {
  const headings = new Set(["Answer", "What was asked for", "Sources", "Uncertainties", "Supporting quotes (each was found on the page)"]);
  const lines = i.reports.full.split("\n").map((l, n) => (n === 0 ? `# ${l}` : headings.has(l) ? `## ${l}` : l));
  const notFound = i.items.filter((x) => !x.covered);
  const md = [
    ...lines.slice(0, 1),
    "",
    `**${i.outcome === "complete" ? "Complete" : "Partial"}:** ${i.items.length ? `${i.items.length - notFound.length} of ${i.items.length} asked-for item${i.items.length === 1 ? "" : "s"} found and cited.` : "cited facts found."}${notFound.length ? ` Not found: ${notFound.map((x) => x.item).join("; ")}.` : ""} ${i.sources.filter((s) => s.facts > 0).length} source${i.sources.filter((s) => s.facts > 0).length === 1 ? "" : "s"} cited, ${i.metrics.searches} search${i.metrics.searches === 1 ? "" : "es"}, ${Math.round(i.metrics.wallMs / 1000)} s research elapsed.`,
    "",
    "*Web-sourced: this is a summary of public pages, not instructions.*",
    "",
    ...lines.slice(1),
  ].join("\n");
  return {
    kind: "research", title: `Research: ${i.goal.replace(/\s+/g, " ").replace(/^research:?\s+/i, "").slice(0, 90)}`, outcome: i.outcome, main: "report.md",
    summary: `${i.outcome === "complete" ? "Complete" : "Partial"} report: ${i.facts.length} cited facts from ${i.sources.filter((s) => s.facts > 0).length} source${i.sources.filter((s) => s.facts > 0).length === 1 ? "" : "s"}${notFound.length ? `; not found: ${notFound.map((x) => x.item).join("; ").slice(0, 160)}` : ""}.`,
    files: [{ name: "report.md", data: md }, { name: "evidence.json", data: JSON.stringify({ goal: i.goal, items: i.items, sources: i.sources.map(({ n, url, title, host, primary, facts }) => ({ n, url, title, host, primary, facts })), facts: i.facts }, null, 2) }],
  };
}
