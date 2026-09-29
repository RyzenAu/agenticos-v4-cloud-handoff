import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { activities, findLead, getKickoff, type Lead } from "./crm";
import { isVerifiedFact } from "./score";
import { readSeoAudit } from "./seo-audit";
import { getPreview, readRegistry, type PreviewRecord } from "../lead-sites/registry";
import { draftFiles } from "./sales-backoffice";

export const STAGES = ["found", "verified", "scored", "audited", "preview", "contacted", "replied", "meeting", "proposal", "won", "building", "QA", "launched", "care plan"] as const;
export type Stage = typeof STAGES[number];
export type PipelineView = { leadId: number; stage: Stage; evidence: string; nextAction: string; owner: "agent" | "founder approval"; closed: boolean };
/**
 * What pipelineSummary reads once for every lead (UI-truth M10: the per-lead file checks made Today's
 * pipeline panel take ~2.3 s for 963 leads). Absent: each lead reads its own files, as before.
 */
export type PipelineContext = { previews: Map<number, PreviewRecord>; draftIds: Set<string>; auditIds: Set<string> };
const listDir = (dir: string) => new Set(existsSync(dir) ? readdirSync(dir) : []);
export function pipelineContext(root: string): PipelineContext {
  return {
    previews: new Map(readRegistry(root).map((p) => [p.leadId, p])),
    draftIds: listDir(join(root, ".operator-data", "drafts")),
    auditIds: listDir(join(root, ".operator-data", "seo-audits")),
  };
}

export function leadPipeline(root: string, db: Database, lead: Lead, ctx?: PipelineContext): PipelineView {
  const acts = activities(db, lead.id);
  const has = (kind: string) => acts.some(a => a.kind === kind || a.outcome === kind);
  const kickoff = getKickoff(db, lead.id);
  const milestone = (name: string) => kickoff?.milestones.some(m => m.name === name && m.state === "done") ?? false;
  const preview = ctx ? ctx.previews.get(lead.id) ?? null : getPreview(root, lead.id);
  const drafts = !ctx || ctx.draftIds.has(String(lead.id)) ? draftFiles(root, lead.id) : [];
  const audited = (!ctx || ctx.auditIds.has(String(lead.id))) && readSeoAudit(root, lead.id)?.ok === true;
  const completed: [Stage, boolean, string][] = [
    ["found", true, "CRM record"],
    ["verified", !!lead.websiteCheckedAt || lead.reasons.some(isVerifiedFact), "Site checked or a first-party fact recorded"],
    ["scored", lead.score > 0, `CRM score ${lead.score}`],
    ["audited", audited, "Completed site audit"],
    ["preview", !!preview, "Preview record"],
    ["contacted", !!lead.lastContactAt || has("call") || has("email") || ["to_call", "no_answer", "voicemail", "call_back", "emailed"].includes(lead.status) && !!lead.lastContactAt, "Contact activity"],
    ["replied", ["interested", "meeting", "proposal", "won"].includes(lead.status) || has("interested"), "Interested/reply outcome"],
    ["meeting", ["meeting", "proposal", "won"].includes(lead.status) || has("meeting"), "Meeting recorded"],
    ["proposal", lead.status === "proposal" || !!drafts.find(f => f === "proposal.md"), drafts.includes("proposal.md") ? "Proposal draft on disk (not sent)" : "Proposal outcome logged"],
    ["won", lead.status === "won" || has("won"), "Win recorded"],
    ["building", milestone("Build started"), "Build-start milestone completed"],
    ["QA", milestone("Review sent") && milestone("Revisions closed"), "Review and revisions milestones completed"],
    ["launched", milestone("Deployed") && milestone("Handover sent"), "Deployment and handover milestones completed"],
    ["care plan", acts.some(a => /care plan (active|started)/i.test(a.note)), "Care plan activation explicitly recorded"],
  ];
  // Delivery stages require a recorded win; a preview's temporary deployment is not client launch.
  const won = completed.find(([s]) => s === "won")![1];
  const [stage, , evidence] = [...completed].reverse().find(([s, ok]) => ok && (won || STAGES.indexOf(s) < STAGES.indexOf("building")))!;
  const closed = lead.excluded || ["lost", "not_interested", "do_not_contact"].includes(lead.status);
  if (closed) return { leadId: lead.id, stage, evidence, nextAction: "No outreach — review closed/excluded record only", owner: "founder approval", closed };
  const actions: Record<Stage, [string, "agent" | "founder approval"]> = {
    found: ["Verify business website and contact details", "agent"],
    verified: ["Score the lead against verified facts", "agent"],
    scored: ["Prepare a site audit for founder review", "agent"],
    audited: ["Prepare a private preview if suitable", "agent"],
    preview: ["Approve and make initial contact", "founder approval"],
    contacted: ["Review response and follow-up timing", "founder approval"],
    replied: ["Arrange a discovery meeting", "founder approval"],
    meeting: ["Draft proposal and agreement", "agent"],
    proposal: ["Review proposal, terms and deposit invoice before sharing", "founder approval"],
    won: ["Collect client assets and confirm kickoff", "founder approval"],
    building: ["Review build and run QA", "agent"],
    QA: ["Approve launch and client handover", "founder approval"],
    launched: ["Confirm care plan consent and start date", "founder approval"],
    "care plan": ["Review care plan renewal and support", "founder approval"],
  };
  return { leadId: lead.id, stage, evidence, nextAction: actions[stage][0], owner: actions[stage][1], closed };
}
/**
 * Stage counts plus honest totals (UI-truth H3). `total` is every CRM record, kept for the CLI;
 * `open` is what a person means by "open leads": not closed/lost, not excluded and not merged
 * into another record. `openCounts` counts only those open leads per stage. The four buckets
 * open + lost + excluded + merged always add up to `total`.
 */
export function pipelineSummary(root: string, db: Database) {
  const counts = Object.fromEntries(STAGES.map(s => [s, 0])) as Record<Stage, number>;
  const openCounts = Object.fromEntries(STAGES.map(s => [s, 0])) as Record<Stage, number>;
  // listLeads caps to its requested limit; paginate directly over ids to avoid truncation.
  const ids = (db.query("SELECT id FROM leads ORDER BY id").all() as { id: number }[]);
  const ctx = pipelineContext(root);
  let closed = 0, excluded = 0, merged = 0, lost = 0, open = 0;
  for (const { id } of ids) {
    const lead = findLead(db, id);
    if (!lead) continue;
    const view = leadPipeline(root, db, lead, ctx);
    counts[view.stage]++;
    if (view.closed) closed++;
    if (lead.mergedInto !== null) merged++;
    else if (lead.excluded) excluded++;
    else if (view.closed) lost++;
    if (!view.closed && !lead.excluded && lead.mergedInto === null) {
      open++;
      openCounts[view.stage]++;
    }
  }
  return { counts, openCounts, total: ids.length, closed, open, excluded, merged, lost };
}
