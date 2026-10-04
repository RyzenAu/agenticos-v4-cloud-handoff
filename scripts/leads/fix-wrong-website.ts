// Clears a website that discovery attached to the wrong organisation, 27 Sep 2026. First use:
// lead #252 "Dental Surgery", whose discovered_guess website `dental.com.au` is a dental-research
// charity, not the practice (docs/sales/dental-call-pack-2026-09-28/08-lead-source-decision.md).
//
// For every lead whose website is on the wrong domain (the named lead, plus any other lead carrying
// the same wrong domain — #398 was merged into #252 on that domain alone) it:
//   - clears website, marks website_source `not_verified`, clears its confidence/checked date;
//   - drops score reasons and emails that came from the wrong site, and the stored issues audit
//     (lead_issues) that audited the wrong site; puts the lead at pitch `audit_pending`, score 0,
//     with the reason "website not verified — owner to Google" so it can't rank on false evidence;
//   - removes that lead's cached call script (its opener quoted the wrong site's faults);
//   - logs a note activity recording what was cleared and why.
// `--unmerge` also reverses any merge whose recorded reason is that wrong domain (restores the
// merged lead as its own, non-excluded record). Phones, notes and activities are never touched.
//
// DRY RUN by default: prints what would change, writes nothing.
//   bun scripts/leads/fix-wrong-website.ts --lead 252 --domain dental.com.au [--unmerge] [--db <crm.sqlite>] [--root <repo>]
//   ... --apply   to write
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { crmPath, findLead, logActivity, openCrm, WEBSITE_NOT_VERIFIED, WEBSITE_NOT_VERIFIED_REASON } from "./crm";
import { scriptPath } from "./call-script";

export const NOT_VERIFIED_REASON = WEBSITE_NOT_VERIFIED_REASON;
export const NOT_VERIFIED_SOURCE = WEBSITE_NOT_VERIFIED;

type Row = Record<string, any>;

/** example.com.au from "https://www.example.com.au/path". '' when unparsable. */
export function domainOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export type WrongWebsiteFix = {
  leadId: number;
  name: string;
  oldWebsite: string;
  oldWebsiteSource: string;
  reasonsDropped: number;
  emailsDropped: string[];
  issuesAuditRemoved: boolean;
  callScript: string | null;
};

export type WrongWebsitePlan = {
  domain: string;
  target: number;
  fixes: WrongWebsiteFix[];
  /** Leads excluded as a "duplicate" of a fixed lead on the wrong domain alone. */
  suspectMerges: { leadId: number; mergedInto: number; reason: string }[];
  unmerge: boolean;
  applied: boolean;
};

function parse(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw || "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function planWrongWebsiteFix(
  db: Database,
  opts: { leadId: number; domain: string; unmerge?: boolean; root?: string | null },
): WrongWebsitePlan {
  const domain = domainOf(opts.domain);
  if (!domain) throw new Error("Give the wrong domain, e.g. --domain dental.com.au.");
  const target = db.query("SELECT * FROM leads WHERE id = ?").get(opts.leadId) as Row | null;
  if (!target) throw new Error(`No lead #${opts.leadId}.`);
  // Safety: refuse if the named lead no longer carries the wrong domain (already fixed, or a typo).
  if (domainOf(target.website) !== domain)
    throw new Error(`Lead #${opts.leadId}'s website is "${target.website || "(none)"}", not ${domain} — nothing to fix.`);
  const rows = (db.query("SELECT * FROM leads WHERE website != '' ORDER BY id").all() as Row[]).filter((r) => domainOf(r.website) === domain);
  let hasIssues = true;
  try {
    db.query("SELECT 1 FROM lead_issues LIMIT 1").get();
  } catch {
    hasIssues = false; // a CRM file that predates issues.ts
  }
  const fixes = rows.map((r): WrongWebsiteFix => {
    const reasons = parse(r.reasons);
    const emails = parse(r.emails);
    const script = opts.root ? scriptPath(opts.root, r.id) : null;
    return {
      leadId: r.id, name: r.name, oldWebsite: r.website, oldWebsiteSource: r.website_source ?? "",
      reasonsDropped: reasons.length,
      emailsDropped: emails.filter((e) => e.toLowerCase().split("@")[1]?.replace(/^www\./, "") === domain),
      issuesAuditRemoved: hasIssues && !!db.query("SELECT 1 FROM lead_issues WHERE lead_id = ?").get(r.id),
      callScript: script && existsSync(script) ? script : null,
    };
  });
  const fixedIds = new Set(fixes.map((f) => f.leadId));
  const suspectMerges = (db.query("SELECT id, merged_into, excluded_reason FROM leads WHERE merged_into IS NOT NULL").all() as Row[])
    .filter((r) => fixedIds.has(r.merged_into) && fixedIds.has(r.id) && String(r.excluded_reason).includes(domain))
    .map((r) => ({ leadId: r.id, mergedInto: r.merged_into, reason: r.excluded_reason }));
  return { domain, target: opts.leadId, fixes, suspectMerges, unmerge: !!opts.unmerge, applied: false };
}

export function applyWrongWebsiteFix(
  db: Database,
  opts: { leadId: number; domain: string; unmerge?: boolean; root?: string | null; by?: string },
): WrongWebsitePlan {
  const plan = planWrongWebsiteFix(db, opts);
  db.transaction(() => {
    for (const fix of plan.fixes) {
      const row = db.query("SELECT emails FROM leads WHERE id = ?").get(fix.leadId) as Row;
      const emails = parse(row.emails).filter((e) => !fix.emailsDropped.includes(e));
      db.query(`UPDATE leads SET website = '', website_source = $source, website_confidence = NULL, website_checked_at = NULL, website_check = 'not-checked',
          reasons = $reasons, pitch = 'audit_pending', score = 0, emails = $emails,
          email_ok = CASE WHEN $hasEmails THEN email_ok ELSE 0 END WHERE id = $id`).run({
        $source: NOT_VERIFIED_SOURCE, $reasons: JSON.stringify([NOT_VERIFIED_REASON]), $emails: JSON.stringify(emails),
        $hasEmails: emails.length ? 1 : 0, $id: fix.leadId,
      });
      if (fix.issuesAuditRemoved) db.query("DELETE FROM lead_issues WHERE lead_id = ?").run(fix.leadId);
    }
    if (plan.unmerge) {
      for (const m of plan.suspectMerges) {
        db.query("UPDATE leads SET excluded = 0, excluded_reason = '', merged_into = NULL WHERE id = ?").run(m.leadId);
      }
    }
  })();
  for (const fix of plan.fixes) {
    const lead = findLead(db, fix.leadId)!;
    const unmerged = plan.unmerge && plan.suspectMerges.some((m) => m.leadId === fix.leadId);
    logActivity(db, lead, {
      kind: "note",
      by: opts.by ?? "",
      note: (`Website cleared: ${fix.oldWebsite} (${fix.oldWebsiteSource || "source not recorded"}) is not this practice — ` +
        `${plan.domain} belongs to another organisation. ${NOT_VERIFIED_REASON[0].toUpperCase()}${NOT_VERIFIED_REASON.slice(1)}. ` +
        `Dropped ${fix.reasonsDropped} reason(s)${fix.issuesAuditRemoved ? ", the issues audit" : ""}` +
        `${fix.emailsDropped.length ? ` and ${fix.emailsDropped.length} email(s)` : ""} taken from that site.` +
        `${unmerged ? ` Un-merged from #${plan.suspectMerges.find((m) => m.leadId === fix.leadId)!.mergedInto}: that merge matched on ${plan.domain} alone.` : ""}`).slice(0, 2000),
    });
    if (fix.callScript) rmSync(fix.callScript, { force: true });
  }
  return { ...plan, applied: true };
}

export function renderWrongWebsitePlan(plan: WrongWebsitePlan, file: string): string {
  return [
    `${plan.applied ? "APPLIED" : "DRY RUN (nothing written)"} — clear wrong website ${plan.domain} (lead #${plan.target}) in ${file}`,
    ...plan.fixes.map((f) =>
      `  #${f.leadId} ${f.name}: website ${f.oldWebsite} (${f.oldWebsiteSource || "?"}) → '' [${NOT_VERIFIED_SOURCE}]; ` +
      `reasons ${f.reasonsDropped} → 1 ("${NOT_VERIFIED_REASON}"); pitch → audit_pending, score → 0; ` +
      `emails dropped ${f.emailsDropped.length}; issues audit removed: ${f.issuesAuditRemoved ? "yes" : "no"}; cached call script removed: ${f.callScript ? "yes" : "no"}`),
    ...(plan.suspectMerges.length
      ? [`Merges made on ${plan.domain} alone: ${plan.suspectMerges.map((m) => `#${m.leadId} → #${m.mergedInto}`).join(", ")} — ` +
        (plan.unmerge ? (plan.applied ? "un-merged." : "will be un-merged (--unmerge).") : "left as is; add --unmerge to restore them as separate leads.")]
      : []),
    plan.applied ? "Each changed lead has a note activity recording this." : "Re-run with --apply to write.",
  ].join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const root = resolve(flag("root") ?? resolve(import.meta.dir, "..", ".."));
  const file = resolve(flag("db") ?? crmPath(root));
  const leadId = Number(flag("lead"));
  const domain = flag("domain") ?? "";
  if (!Number.isInteger(leadId) || leadId <= 0 || !domain) {
    console.error("Usage: bun scripts/leads/fix-wrong-website.ts --lead <id> --domain <wrong domain> [--unmerge] [--db <file>] [--apply]");
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`No CRM at ${file}.`);
    process.exit(1);
  }
  const apply = argv.includes("--apply");
  const db = apply ? openCrm(file) : new Database(file, { readonly: true });
  try {
    const opts = { leadId, domain, unmerge: argv.includes("--unmerge"), root, by: flag("by") };
    const plan = apply ? applyWrongWebsiteFix(db, opts) : planWrongWebsiteFix(db, opts);
    console.log(argv.includes("--json") ? JSON.stringify(plan, null, 2) : renderWrongWebsitePlan(plan, file));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
