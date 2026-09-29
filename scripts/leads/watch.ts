// Prospect-monitoring feed: watches each open lead's own website through a local
// changedetection.io instance (pip install, no Docker; scripts/windows/changedetection.ps1)
// and writes a short note onto the lead when its site changes. This never emails, calls or
// messages anyone -- it only adds a CRM note and, optionally, a quiet Jarvis HUD event.
//
//   bun scripts/leads/cli.ts watch sync       add a changedetection watch for every open lead
//                                              with a website (idempotent -- replays are a no-op)
//   bun scripts/leads/cli.ts watch changes    poll changedetection for watches that changed,
//                                              note it on the lead, print what changed
//
// changedetection.io's own API: POST /api/v1/watch (create), GET /api/v1/watch/<uuid> (detail,
// includes last_changed), GET /api/v1/watch/<uuid>?recheck=true (force an immediate recheck).
// Auth is a single `x-api-key` header (its own default: API key checking is on from install).
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findLead, listLeads, logActivity, type Lead, type Status } from "./crm";

/** Same closed-for-good set as crm.ts's own CLOSED (not exported there) -- a closed lead's site
 *  is no longer worth watching for a buying-signal call. */
const CLOSED: Status[] = ["won", "lost", "not_interested", "do_not_contact"];

export type ChangeDetectionConfig = { baseUrl: string; apiKey: string };

/** Same convention as places.ts's placesKey(): the real key lives in ~/.config/agentic-os.env,
 *  never in process.env directly, and is never logged or returned wrapped in an error. */
export function changeDetectionApiKeyFromFile(home: string = homedir()): string {
  try {
    for (const line of readFileSync(join(home, ".config", "agentic-os.env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*CHANGEDETECTION_API_KEY\s*=\s*(.*)$/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* reported below as "not configured" */
  }
  return "";
}

/** Reads CHANGEDETECTION_API_KEY (required, from ~/.config/agentic-os.env, or process.env for
 *  tests/overrides) and CHANGEDETECTION_BASE_URL (default: the local pip-installed instance).
 *  Returns null if no key is found anywhere, so callers can give a plain "not configured"
 *  message instead of a raw fetch failure. */
export function changeDetectionConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): ChangeDetectionConfig | null {
  const apiKey = env.CHANGEDETECTION_API_KEY?.trim() || changeDetectionApiKeyFromFile(home);
  if (!apiKey) return null;
  return { baseUrl: (env.CHANGEDETECTION_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, ""), apiKey };
}

/** Only ever watch a plain http(s) URL -- guards against a malformed or javascript: website field. */
export function isWatchableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export type WatchRecord = {
  leadId: number;
  uuid: string;
  url: string;
  /** changedetection's own epoch-seconds `last_changed` last time we saw it (0 = never). */
  lastChanged: number;
  lastCheckedAt: string | null;
  lastNotedAt: string | null;
};
type WatchState = { version: 1; watches: Record<string, WatchRecord> };

function blankState(): WatchState {
  return { version: 1, watches: {} };
}

export function watchStatePath(root: string): string {
  return join(root, ".operator-data", "watch-state.json");
}

function readState(file: string): WatchState {
  try {
    if (!existsSync(file)) return blankState();
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || typeof data.watches !== "object") return blankState();
    return { version: 1, watches: data.watches };
  } catch {
    return blankState();
  }
}

function writeState(file: string, state: WatchState) {
  mkdirSync(join(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, file);
}

async function cdFetch(cfg: ChangeDetectionConfig, path: string, init: RequestInit = {}, request: typeof fetch = fetch): Promise<Response> {
  const response = await request(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { "x-api-key": cfg.apiKey, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`changedetection ${path} returned ${response.status}`);
  return response;
}

export type SyncResult = { created: number; alreadyWatched: number; skipped: number; total: number };

/** Idempotent: a lead that already has a watch (found in watch-state.json) is left alone, so
 *  running `sync` repeatedly (a cron, or a repeated CLI call) never creates duplicate watches. */
export async function syncWatches(
  db: Database,
  cfg: ChangeDetectionConfig,
  root: string,
  request: typeof fetch = fetch,
): Promise<SyncResult> {
  const file = watchStatePath(root);
  const state = readState(file);
  const leads = listLeads(db, { limit: 500 }).filter((lead) => lead.website && !CLOSED.includes(lead.status));

  let created = 0;
  let alreadyWatched = 0;
  let skipped = 0;
  for (const lead of leads) {
    const key = String(lead.id);
    if (state.watches[key]) {
      alreadyWatched++;
      continue;
    }
    if (!isWatchableUrl(lead.website)) {
      skipped++;
      continue;
    }
    const response = await cdFetch(
      cfg,
      "/api/v1/watch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: lead.website,
          tag: `lead:${lead.id}`,
          title: lead.name || lead.website,
          fetch_backend: "html_requests", // polite, plain-requests fetcher -- no browser
          time_between_check: { hours: 24 },
        }),
      },
      request,
    );
    const data = (await response.json()) as { uuid: string };
    state.watches[key] = { leadId: lead.id, uuid: data.uuid, url: lead.website, lastChanged: 0, lastCheckedAt: null, lastNotedAt: null };
    created++;
  }
  writeState(file, state);
  return { created, alreadyWatched, skipped, total: leads.length };
}

export type ChangedWatch = { leadId: number; url: string; changedAt: string };
export type PollResult = { checked: number; changed: ChangedWatch[] };

/** Polls every tracked watch's current state, notes a change onto its lead (idempotent: keyed on
 *  changedetection's own `last_changed` timestamp, so a repeat poll before the next real change
 *  is a no-op), and returns what changed this run. */
export async function pollChanges(
  db: Database,
  cfg: ChangeDetectionConfig,
  root: string,
  request: typeof fetch = fetch,
): Promise<PollResult> {
  const file = watchStatePath(root);
  const state = readState(file);
  const changed: ChangedWatch[] = [];
  const checkedAt = new Date().toISOString();

  for (const key of Object.keys(state.watches)) {
    const record = state.watches[key];
    let detail: { last_changed?: number; title?: string | null };
    try {
      const response = await cdFetch(cfg, `/api/v1/watch/${record.uuid}`, {}, request);
      detail = (await response.json()) as typeof detail;
    } catch (error) {
      continue; // a single dead watch (deleted in the changedetection UI, say) shouldn't stop the rest
    }
    record.lastCheckedAt = checkedAt;
    const lastChanged = Number(detail.last_changed) || 0;
    if (lastChanged > 0 && lastChanged > record.lastChanged) {
      const changedAt = new Date(lastChanged * 1000).toISOString();
      const lead = findLead(db, record.leadId);
      if (lead) {
        logActivity(db, lead, {
          kind: "note",
          note: `website changed ${changedAt.slice(0, 10)}: content changed on ${record.url}`,
          eventId: `watch:${record.uuid}:${lastChanged}`, // replaying this poll before a further change is a no-op
        });
      }
      record.lastChanged = lastChanged;
      record.lastNotedAt = checkedAt;
      changed.push({ leadId: record.leadId, url: record.url, changedAt });
    }
  }
  writeState(file, state);
  return { checked: Object.keys(state.watches).length, changed };
}

/** GET /api/v1/watch/<uuid>?recheck=true -- forces an immediate check instead of waiting for the
 *  24h schedule. Used to prove the sync -> change -> note flow works end to end. */
export async function forceRecheck(cfg: ChangeDetectionConfig, uuid: string, request: typeof fetch = fetch): Promise<void> {
  await cdFetch(cfg, `/api/v1/watch/${uuid}?recheck=true`, {}, request);
}

export type WatchSummary = {
  totalWatched: number;
  changedThisWeek: ChangedWatch[];
  leads: Array<{ leadId: number; url: string; lastCheckedAt: string | null; lastChangedAt: string | null }>;
};

/** Local-file summary for the /leads/watch route and Jarvis -- reads watch-state.json only, no
 *  network call, mirroring how hunt.ts's readHunt() reports the last lead-hunt run. */
export function readWatchSummary(root: string, now = Date.now()): WatchSummary {
  const state = readState(watchStatePath(root));
  const sevenDaysAgo = now - 7 * 24 * 3_600_000;
  const records = Object.values(state.watches);
  const changedThisWeek = records
    .filter((r) => r.lastNotedAt && Date.parse(r.lastNotedAt) >= sevenDaysAgo)
    .map((r) => ({ leadId: r.leadId, url: r.url, changedAt: new Date(r.lastChanged * 1000).toISOString() }));
  return {
    totalWatched: records.length,
    changedThisWeek,
    leads: records.map((r) => ({
      leadId: r.leadId,
      url: r.url,
      lastCheckedAt: r.lastCheckedAt,
      lastChangedAt: r.lastChanged ? new Date(r.lastChanged * 1000).toISOString() : null,
    })),
  };
}

export function renderSyncResult(result: SyncResult): string {
  return `${result.created} new watch(es), ${result.alreadyWatched} already watched, ${result.skipped} skipped (no usable website) -- ${result.total} open leads with a website.`;
}

export function renderPollResult(result: PollResult, leads: (id: number) => Lead | null): string {
  if (!result.changed.length) return `Checked ${result.checked} watch(es); no changes since the last poll.`;
  const lines = result.changed.map((c) => {
    const lead = leads(c.leadId);
    return `  #${c.leadId} ${lead?.name || "(lead)"} -- ${c.url} changed ${c.changedAt.slice(0, 10)}`;
  });
  return [`Checked ${result.checked} watch(es); ${result.changed.length} changed:`, ...lines].join("\n");
}
