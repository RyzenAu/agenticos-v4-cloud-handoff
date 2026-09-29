// Safe overnight chores the Dream runs before it thinks. Both are read-mostly and cheap:
//  1. re-audit leads still marked "audit pending", via the lead engine's own rescan (the same code
//     path as `bun scripts/leads/cli.ts rescan`, limited to those leads and capped);
//  2. run the client-build QA (`bun scripts/site-draft/cli.ts qa`) on every client hub that has a
//     build, and flag a regression against the previous night.
// Neither sends, deploys, commits or edits a site: rescan only rewrites a lead's website/score/pitch
// fields (never status, owner or history), and QA works on a scratch copy of the build.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { crmPath, listLeads, openCrm } from "../leads/crm";
import { rescanLead } from "../leads/rescan";
import { clientBuildDir, readJson, writeJsonAtomic } from "./core";

const CLOSED = new Set(["won", "lost", "not_interested", "do_not_contact"]);

/** A promise can't be cancelled, so a timed-out re-audit keeps running; `stragglers` collects
 *  them so the CRM is only closed once they settle (and their errors are never unhandled). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string, stragglers: Promise<unknown>[]): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const settled = p.then(
    (v) => (clearTimeout(timer), v),
    (e) => {
      clearTimeout(timer);
      throw e;
    },
  );
  return Promise.race([
    settled,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        stragglers.push(settled.catch(() => undefined));
        reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`));
      }, ms);
    }),
  ]);
}

export async function reauditPendingLeads(repo: string, cap = 20, perLeadMs = 90_000) {
  const db = openCrm(crmPath(repo));
  const stragglers: Promise<unknown>[] = [];
  try {
    const pending = listLeads(db, { limit: 10_000 }).filter((l) => l.pitch === "audit_pending" && !l.excluded && !CLOSED.has(l.status));
    const batch = pending.slice(0, cap);
    const changed: { lead: string; from: string; to: string; score: number }[] = [];
    const errors: string[] = [];
    for (const lead of batch) {
      try {
        const c = await withTimeout(rescanLead(db, lead), perLeadMs, `re-audit of ${lead.name}`, stragglers);
        if (c.after.pitch !== c.before.pitch || c.after.score !== c.before.score)
          changed.push({ lead: lead.name, from: c.before.pitch, to: c.after.pitch, score: c.after.score });
      } catch (err) {
        errors.push(err instanceof Error ? err.message.slice(0, 160) : String(err));
      }
    }
    return { pending: pending.length, checked: batch.length, resolved: changed.filter((c) => c.to !== "audit_pending").length, changed, errors: errors.slice(0, 5) };
  } finally {
    // Give timed-out re-audits up to 3 minutes to finish their CRM write before closing.
    await Promise.race([Promise.all(stragglers), new Promise((r) => setTimeout(r, 180_000))]);
    db.close();
  }
}

export type QaOutcome = { repo: string; buildDir: string; buildSource: string; verdict: string; fails: number; warnings: number; report: string; regression: string | null; error?: string };

export function clientSiteQa(opts: { repo: string; bun: string; reposRoot: string; qaDir: string; date: string; timeoutMs?: number }): QaOutcome[] {
  mkdirSync(opts.qaDir, { recursive: true });
  const out: QaOutcome[] = [];
  let repos: string[] = [];
  try {
    repos = readdirSync(opts.reposRoot);
  } catch {
    return out;
  }
  for (const name of repos) {
    const hub = join(opts.reposRoot, name);
    if (!existsSync(join(hub, "CLIENT.md"))) continue;
    const build = clientBuildDir(hub);
    if (!build) continue;
    const dist = build.dir;
    const report = join(opts.qaDir, `${name}-${opts.date}.md`);
    const r = spawnSync(opts.bun, ["scripts/site-draft/cli.ts", "qa", "--dir", dist, "--evidence", "auto", "--out", report], {
      cwd: opts.repo, encoding: "utf-8", timeout: opts.timeoutMs ?? 10 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    });
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const verdict = /Verdict:\s*(READY|NOT READY)/.exec(text)?.[1] ?? "UNKNOWN";
    const m = /Fail issues:\s*(\d+),\s*warnings:\s*(\d+)/.exec(text);
    const fails = Number(m?.[1] ?? NaN);
    const warnings = Number(m?.[2] ?? NaN);
    const latestFile = join(opts.qaDir, `${name}-latest.json`);
    const prev = readJson<{ verdict: string; fails: number; date: string }>(latestFile);
    let regression: string | null = null;
    if (verdict === "UNKNOWN") regression = null;
    else if (prev && prev.date !== opts.date && (!("buildDir" in prev) || (prev as any).buildDir === build.dir)) {
      if (prev.verdict === "READY" && verdict === "NOT READY") regression = `was READY on ${prev.date}, now NOT READY`;
      else if (Number.isFinite(fails) && fails > prev.fails) regression = `fail issues rose from ${prev.fails} to ${fails} since ${prev.date}`;
    }
    const outcome: QaOutcome = {
      repo: name, buildDir: build.dir, buildSource: build.source, verdict, fails: Number.isFinite(fails) ? fails : -1, warnings: Number.isFinite(warnings) ? warnings : -1, report, regression,
      ...(verdict === "UNKNOWN" ? { error: text.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 240) || `exit ${r.status}` } : {}),
    };
    if (verdict !== "UNKNOWN") writeJsonAtomic(latestFile, { verdict, fails: outcome.fails, date: opts.date, buildDir: build.dir });
    out.push(outcome);
  }
  return out;
}
