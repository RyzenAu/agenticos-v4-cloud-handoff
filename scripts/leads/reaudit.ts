#!/usr/bin/env bun
// A targeted, resumable re-audit of only the leads the new discovery tools (SearXNG) and the
// deep browser-based audit (rescan.ts's `browserRetry`) can actually improve: `audit_pending`
// (we couldn't load their site before) and "low data" (no phone, no site tag — discovery was
// skipped entirely during the OSM hunt to save time). Everything else in the CRM, including the
// current top 20, is left untouched by the default run — this never widens its own scope on its
// own.
//
//   bun scripts/leads/reaudit.ts run
//   bun scripts/leads/reaudit.ts run --all-website   (see below — an explicit, one-off widening)
//   bun scripts/leads/reaudit.ts sample [n]          (dry run, default 50 — writes nothing)
//   bun scripts/leads/reaudit.ts status
//
// `sample` picks n random `pitch === "website"` leads and runs the real discovery/scoring logic
// in dry-run mode (rescanLead's `dryRun: true` — every check is real, nothing is written) so the
// before/after can be hand-checked for precision before trusting a real `--all-website` sweep.
// 25 Sep 2026: `--all-website` is a deliberate, explicit opt-in widening for the one-off sweep
// that followed discovery.ts's suburb/aggregator verification bugfix (the `area`-as-suburb bug
// had been silently failing verification for the "website" pitch itself, not just
// audit_pending/low-data — see discovery.ts's localityFromAddress). It adds every non-excluded,
// non-frozen `pitch === "website"` lead to the candidate set, regardless of `processedIds` —
// still never touching FROZEN_TOP_20. The default `run` (no flag) is untouched and still only
// ever looks at audit_pending/low-data/phone-finder-flagged leads, exactly as before.
// Concurrency <= 3 (a semaphore, not per-batch serial waits) and — per the owner's instruction —
// this pauses itself between roughly 1:15 am and 2:30 am Sydney time while the nightly Dream run
// is on, resuming automatically after. Progress is checkpointed to
// .operator-data/reaudit-progress.json (atomic tmp+rename, same convention as osm-hunt.ts/
// agent-jobs.ts) so it's safe to stop and restart, and never left "mid-migration" — every lead is
// updated via a single upsertLead call, so at any instant every row in the CRM is fully consistent.
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserAuditDeps } from "./browser-audit";
import type { Crawl4aiDeps } from "./crawl4ai";
import { listLeads } from "./crm";
import { openCrm, crmPath } from "./crm";
import type { DiscoveryDeps } from "./discovery";
import { allWebsiteFindings, markWebsiteFlagDone, pendingWebsiteFlags } from "./phone-finder";
import { rescanLead, type RescanChange } from "./rescan";
import { dataDirFor } from "../cloud/data-dir";

const ROOT = join(import.meta.dir, "..", "..");
const CONCURRENCY = 3;

// 25 Sep 2026 owner instruction: these 20 leads are what tomorrow morning's "Today's calls" is
// built from — never touched by this pass, even though none of them are audit_pending/low-data
// today (a belt-and-suspenders freeze, not just a query filter).
const FROZEN_TOP_20 = new Set([194, 509, 532, 164, 188, 211, 218, 231, 292, 308, 309, 328, 330, 346, 409, 413, 429, 463, 479, 486]);

function progressPath(root: string): string {
  return join(dataDirFor(root), "reaudit-progress.json");
}

type Progress = { version: 1; startedAt: string; updatedAt: string; processedIds: number[]; total: number };

function loadProgress(root: string): Progress {
  const file = progressPath(root);
  if (!existsSync(file)) return { version: 1, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processedIds: [], total: 0 };
  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (stored?.version !== 1) throw new Error("bad version");
    return stored;
  } catch {
    return { version: 1, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processedIds: [], total: 0 };
  }
}

function saveProgress(root: string, progress: Progress): void {
  const dir = join(dataDirFor(root));
  mkdirSync(dir, { recursive: true });
  progress.updatedAt = new Date().toISOString();
  const file = progressPath(root);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(progress, null, 2));
  renameSync(temp, file);
}

/** Sydney local time, 1:15 am - 2:30 am — the nightly Dream run's window. Checked once per lead
 *  (cheap) rather than once at start, so a run that's still going at 1:15 am pauses partway
 *  through instead of having already committed to running through it. */
function inDreamWindow(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 1 * 60 + 15 && mins <= 2 * 60 + 30;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitOutDreamWindow(log: (line: string) => void, dreamWindow: (now?: Date) => boolean = inDreamWindow): Promise<void> {
  if (!dreamWindow()) return;
  log("  paused: nightly Dream run window (~1:15-2:30am Sydney) — resuming after");
  while (dreamWindow()) await sleep(60_000);
  log("  resuming: Dream run window has passed");
}

export async function runReaudit(
  opts: {
    root?: string;
    log?: (line: string) => void;
    hardStopAt?: Date;
    /** Injected for tests: whether the nightly Dream window is open now (default: the Sydney clock). */
    dreamWindow?: (now?: Date) => boolean;
    /** Injectable for tests, so a test run never makes a real network/browser call. Defaults to
     *  real fetch + a real browser retry — this pass exists specifically to give audit_pending/
     *  low-data leads the deep, real-browser-backed audit the bulk hunt skipped. */
    request?: typeof fetch;
    browserRetry?: BrowserAuditDeps | false;
    /** Same "optional, on by default here" treatment as browserRetry — see crawl4ai.ts/enrich.ts.
     *  Tests pass `false` so a mocked run never spawns the real crwl.exe. */
    crawl4ai?: Crawl4aiDeps | false;
    discovery?: DiscoveryDeps;
    /** 25 Sep 2026 one-off widening — see the file header. Adds every non-excluded,
     *  non-frozen `pitch === "website"` lead to the candidate set regardless of `processedIds`. */
    includeAllWebsitePitch?: boolean;
  } = {},
): Promise<Progress> {
  const root = opts.root ?? ROOT;
  const log = opts.log ?? ((line: string) => console.log(line));
  const db = openCrm(crmPath(root));
  try {
    const progress = loadProgress(root);
    // Also: a no-website lead whose phone search (phone-finder.ts) turned up what looks like its
    // real site — re-audited here with that URL as a discovery hint (still content-verified, and
    // scored by the same strict rules), whether or not an earlier pass already processed it.
    const websiteFlags = pendingWebsiteFlags(db);
    // `--all-website` only: reuse a phone-finder find as a hint even if it was already marked
    // 'done' by an earlier (buggy) pass — re-verifying with the fixed matcher is the whole point,
    // and starting from the same candidate URL is faster than re-running guess/search from scratch.
    const allFindings = opts.includeAllWebsitePitch ? allWebsiteFindings(db) : null;
    const candidates = listLeads(db, { limit: 10_000 }).filter(
      (l) => !FROZEN_TOP_20.has(l.id) && (
        (websiteFlags.has(l.id) && !l.website) ||
        (!progress.processedIds.includes(l.id) && (l.pitch === "audit_pending" || l.reasons.some((r) => r.startsWith("low data")))) ||
        (opts.includeAllWebsitePitch === true && l.pitch === "website")
      ),
    );
    progress.total = progress.processedIds.length + candidates.length;
    log(`Re-audit: ${candidates.length} lead(s) left to process (${progress.processedIds.length} already done this run).`);

    let cursor = 0;
    let stopped = false;
    const worker = async () => {
      for (;;) {
        if (opts.hardStopAt && new Date() >= opts.hardStopAt) { stopped = true; return; }
        await waitOutDreamWindow(log, opts.dreamWindow);
        const index = cursor++;
        if (index >= candidates.length) return;
        const lead = candidates[index];
        try {
          const hint = websiteFlags.get(lead.id) ?? allFindings?.get(lead.id);
          const change = await rescanLead(db, lead, {
            request: opts.request,
            browserRetry: opts.browserRetry ?? {},
            crawl4ai: opts.crawl4ai ?? {},
            discovery: hint ? { ...opts.discovery, hints: [hint] } : opts.discovery,
          });
          if (websiteFlags.has(lead.id)) markWebsiteFlagDone(db, lead.id);
          log(`  #${lead.id} ${lead.name}: ${change.before.pitch} -> ${change.after.pitch} (score ${change.before.score} -> ${change.after.score})`);
        } catch (error) {
          log(`  #${lead.id} ${lead.name}: FAILED — ${(error as Error).message} (left for next run)`);
          continue; // never let one bad lead abort the whole pass
        }
        if (!progress.processedIds.includes(lead.id)) progress.processedIds.push(lead.id);
        if (progress.processedIds.length % 5 === 0) saveProgress(root, progress);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    saveProgress(root, progress);
    log(stopped ? "Re-audit: stopped at hard deadline — checkpointed cleanly, resumable." : "Re-audit: all candidates processed.");
    return progress;
  } finally {
    db.close();
  }
}

/** 25 Sep 2026: a random dry-run sample of `pitch === "website"` leads, for hand-checking
 *  precision before trusting a full `--all-website` sweep — writes nothing to the CRM (rescanLead
 *  runs for real: real discovery, real fetch/browser/crawl4ai, real scoring — just no upsertLead).
 *  Never touches FROZEN_TOP_20 (none of them are pitch "website" anyway, but consistent regardless). */
export async function runSample(
  opts: {
    root?: string; n?: number; log?: (line: string) => void;
    request?: typeof fetch; browserRetry?: BrowserAuditDeps | false; crawl4ai?: Crawl4aiDeps | false; discovery?: DiscoveryDeps;
    dreamWindow?: (now?: Date) => boolean;
  } = {},
): Promise<RescanChange[]> {
  const root = opts.root ?? ROOT;
  const log = opts.log ?? ((line: string) => console.log(line));
  const db = openCrm(crmPath(root));
  try {
    const pool = listLeads(db, { limit: 10_000 }).filter((l) => !FROZEN_TOP_20.has(l.id) && l.pitch === "website");
    // Fisher-Yates — a genuine random sample, not just "the first N by score/id order".
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const n = Math.min(opts.n ?? 50, pool.length);
    const sample = pool.slice(0, n);
    log(`Sample (DRY RUN — writes nothing to the CRM): ${sample.length} of ${pool.length} 'website'-pitch lead(s), chosen at random.`);

    const websiteFlags = pendingWebsiteFlags(db);
    const allFindings = allWebsiteFindings(db);
    const changes: RescanChange[] = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        await waitOutDreamWindow(log, opts.dreamWindow);
        const index = cursor++;
        if (index >= sample.length) return;
        const lead = sample[index];
        const hint = websiteFlags.get(lead.id) ?? allFindings.get(lead.id);
        try {
          const change = await rescanLead(db, lead, {
            request: opts.request,
            browserRetry: opts.browserRetry ?? {},
            crawl4ai: opts.crawl4ai ?? {},
            discovery: hint ? { ...opts.discovery, hints: [hint] } : opts.discovery,
            dryRun: true,
          });
          changes.push(change);
          const found = change.after.website ? ` [${change.after.website}]` : "";
          log(`  #${lead.id} ${lead.name}: ${change.before.pitch} -> ${change.after.pitch} (score ${change.before.score} -> ${change.after.score})${found}`);
        } catch (error) {
          log(`  #${lead.id} ${lead.name}: FAILED — ${(error as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const moved = changes.filter((c) => c.after.pitch !== "website").length;
    log(`Sample done: ${moved}/${changes.length} would move off 'website' pitch. Nothing was written to the CRM.`);
    return changes;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "status") {
    console.log(JSON.stringify(loadProgress(ROOT), null, 2));
  } else if (command === "sample") {
    const n = Number(args[1]) || 50;
    runSample({ n }).then(
      () => {},
      (error) => { console.error("Sample stopped:", (error as Error).message); process.exit(1); },
    );
  } else {
    const includeAllWebsitePitch = args.includes("--all-website");
    // Default hard stop: 6:55am today (leaves buffer before the owner's 7am/8am check).
    const hardStopAt = new Date();
    hardStopAt.setHours(6, 55, 0, 0);
    if (hardStopAt < new Date()) hardStopAt.setDate(hardStopAt.getDate() + 1);
    runReaudit({ hardStopAt, includeAllWebsitePitch }).then(
      (progress) => console.log(`Done. ${progress.processedIds.length}/${progress.total} processed this run.`),
      (error) => { console.error("Re-audit stopped:", (error as Error).message); process.exit(1); },
    );
  }
}
