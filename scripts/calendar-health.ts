// One honest answer to "is the calendar current?", shared by the Calendar page, the Business
// dashboard, the HUD and Jarvis' spoken status — plus the server-side refresh that keeps it
// current whether or not a page is open. Reads saved files and the connections status only:
// asking for health never starts Codex or calls Google.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  NATIVE_CALENDAR_PROBLEMS,
  type NativeCalendarProblem,
  type NativeCalendarSaved,
} from "./native-calendar-sync";
import { dataDirFor } from "./cloud/data-dir";

export const CALENDAR_SYNC_INTERVAL_MS = 15 * 60_000;
export const CALENDAR_FIRST_SYNC_MS = 45_000;
/** Older than this, calendar answers are labelled stale everywhere (matches jarvis-status). */
export const CALENDAR_STALE_MS = 6 * 3_600_000;
export const CONNECT_CALENDAR_ACTION =
  "Open Settings → Connections and connect Google (allow calendar access).";

export type CalendarAccountStatus = {
  id: string;
  connected: boolean;
  calendarAccess?: string;
  email?: string;
  error?: string;
  calendarCoverage?: { syncedAt?: string; eventCount?: number };
};
export type BackgroundRun = {
  source: string;
  ok: boolean;
  at: string;
  skipped?: string;
  error?: string;
};
export type CalendarBackgroundState = {
  intervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  results: BackgroundRun[];
};
export type CalendarHealth = {
  /** live: synced within 6 h · stale: older, no known fault · offline: older and refresh is failing · none: nothing connected */
  state: "live" | "stale" | "offline" | "none";
  source: "codex" | "google" | "outlook" | "cal" | null;
  sourceLabel: string | null;
  syncedAt: string | null;
  ageMs: number | null;
  savedEvents: number;
  /** One line for a card or tile, e.g. "Calendar offline since 22 Sept". */
  headline: string;
  /** What is wrong, in plain words, when something is. */
  problem?: string;
  /** The exact thing the owner has to do; absent when nothing needs doing. */
  ownerAction?: string;
  background: CalendarBackgroundState;
};

const SOURCE_LABEL: Record<string, string> = {
  codex: "Google Calendar via Codex",
  google: "Google Calendar",
  outlook: "Outlook Calendar",
  cal: "Cal.com",
};

function day(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}
/** "5 min", "3 h", "2 days" — short age for tiles and cards. */
export function ageLabel(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Pure: picks the freshest connected source and describes it. */
export function calendarHealth(input: {
  native: NativeCalendarSaved | null;
  accounts: CalendarAccountStatus[];
  background: CalendarBackgroundState | null;
  savedEvents: number;
  now?: number;
  timeZone?: string;
}): CalendarHealth {
  const now = input.now ?? Date.now();
  const background = input.background ?? {
    intervalMinutes: CALENDAR_SYNC_INTERVAL_MS / 60_000,
    lastRunAt: null,
    nextRunAt: null,
    results: [],
  };
  type Candidate = {
    source: CalendarHealth["source"];
    syncedAt: string | null;
    problem?: string;
    ownerAction?: string;
  };
  const candidates: Candidate[] = [];
  const native = input.native;
  if (native?.enabled) {
    const problem = native.problem as NativeCalendarProblem | undefined;
    candidates.push({
      source: "codex",
      syncedAt: native.coverage?.syncedAt ?? null,
      problem: problem
        ? problem === "sync-failed" && native.error
          ? native.error
          : NATIVE_CALENDAR_PROBLEMS[problem]?.message || native.error
        : undefined,
      ownerAction: problem ? NATIVE_CALENDAR_PROBLEMS[problem]?.ownerAction : undefined,
    });
  }
  for (const account of input.accounts) {
    if (!["google", "outlook", "cal"].includes(account.id)) continue;
    if (!account.connected || account.calendarAccess === "missing") continue;
    candidates.push({
      source: account.id as Candidate["source"],
      syncedAt: account.calendarCoverage?.syncedAt ?? null,
      problem: account.error,
      ownerAction: account.error
        ? `Open Settings → Connections and reconnect ${SOURCE_LABEL[account.id]}.`
        : undefined,
    });
  }
  const time = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : 0);
  const best = [...candidates].sort((a, b) => time(b.syncedAt) - time(a.syncedAt))[0];
  if (!best) {
    // A saved snapshot from a source that was switched off is still worth dating.
    const snapshot = native?.coverage?.syncedAt ?? null;
    return {
      state: "none",
      source: null,
      sourceLabel: null,
      syncedAt: snapshot,
      ageMs: snapshot ? Math.max(0, now - time(snapshot)) : null,
      savedEvents: input.savedEvents,
      headline: snapshot
        ? `No calendar connected · last synced ${day(snapshot, input.timeZone)}`
        : "No calendar connected",
      ownerAction: CONNECT_CALENDAR_ACTION,
      background,
    };
  }
  const ageMs = best.syncedAt ? Math.max(0, now - time(best.syncedAt)) : null;
  const old = ageMs === null || ageMs > CALENDAR_STALE_MS;
  const state: CalendarHealth["state"] = !old ? "live" : best.problem ? "offline" : "stale";
  const headline = !best.syncedAt
    ? best.problem
      ? "Calendar offline · never synced"
      : "Calendar not synced yet"
    : state === "live"
      ? `Calendar synced ${ageLabel(ageMs)}${ageMs !== null && ageMs < 60_000 ? "" : " ago"}`
      : state === "offline"
        ? `Calendar offline since ${day(best.syncedAt, input.timeZone)}`
        : `Calendar last synced ${ageLabel(ageMs)} ago`;
  return {
    state,
    source: best.source,
    sourceLabel: best.source ? SOURCE_LABEL[best.source] : null,
    syncedAt: best.syncedAt,
    ageMs,
    savedEvents: input.savedEvents,
    headline,
    problem: best.problem,
    ownerAction: best.problem ? best.ownerAction || CONNECT_CALENDAR_ACTION : undefined,
    background,
  };
}

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

type Accounts = { handle: (path: string, method: string, body: any, res: any) => Promise<any> };
async function accountList(accounts: Accounts): Promise<CalendarAccountStatus[]> {
  try {
    const status = await accounts.handle("/connections", "GET", {}, undefined);
    return Array.isArray(status?.accounts) ? status.accounts : [];
  } catch {
    return [];
  }
}

/** Reader for the /calendar/health route and the Jarvis status tile. */
export function calendarHealthReader(
  root: string,
  deps: { accounts: Accounts; savedEvents: () => number; timeZone?: () => string | undefined },
) {
  const directory = join(dataDirFor(root));
  return async (now = Date.now()) =>
    calendarHealth({
      native: readJson<NativeCalendarSaved>(join(directory, "native-calendar.json")),
      accounts: await accountList(deps.accounts),
      background: readJson<CalendarBackgroundState>(join(directory, "calendar-background.json")),
      savedEvents: deps.savedEvents(),
      now,
      timeZone: deps.timeZone?.(),
    });
}

/**
 * Keeps every connected calendar current from the server: once shortly after the OS starts and
 * every 15 minutes after, independent of any open page. Read-only; never connects, enables or
 * switches an account — a broken source is recorded so the UI can name the owner action.
 */
export function startCalendarBackgroundSync(
  root: string,
  deps: {
    native: {
      backgroundSync: (
        now?: number,
      ) => Promise<{ ok: boolean; skipped?: string; error?: string; events?: number }>;
    };
    accounts: Accounts;
    intervalMs?: number;
    firstDelayMs?: number;
    now?: () => number;
    log?: (line: string) => void;
  },
) {
  const intervalMs = deps.intervalMs ?? CALENDAR_SYNC_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const directory = join(dataDirFor(root)),
    file = join(directory, "calendar-background.json");
  let running: Promise<CalendarBackgroundState> | undefined;
  const write = (state: CalendarBackgroundState) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  async function once(): Promise<CalendarBackgroundState> {
    const started = now();
    const results: BackgroundRun[] = [];
    const at = () => new Date(now()).toISOString();
    try {
      const result = await deps.native.backgroundSync(started);
      results.push({ source: "codex", ok: result.ok, at: at(), skipped: result.skipped, error: result.error });
    } catch (error) {
      results.push({ source: "codex", ok: false, at: at(), error: (error as Error).message });
    }
    for (const account of await accountList(deps.accounts)) {
      if (!["google", "outlook", "cal"].includes(account.id)) continue;
      // Same rule as the Calendar page's "Sync now": anything not known to lack calendar access.
      if (!account.connected || account.calendarAccess === "missing") continue;
      try {
        await deps.accounts.handle(
          "/connections/sync",
          "POST",
          {
            provider: account.id,
            calendarOnly: true,
            timeMin: new Date(started - 30 * 86400000).toISOString(),
            timeMax: new Date(started + 120 * 86400000).toISOString(),
          },
          {},
        );
        results.push({ source: account.id, ok: true, at: at() });
      } catch (error) {
        results.push({ source: account.id, ok: false, at: at(), error: (error as Error).message });
      }
    }
    const state: CalendarBackgroundState = {
      intervalMinutes: intervalMs / 60_000,
      lastRunAt: new Date(started).toISOString(),
      nextRunAt: new Date(started + intervalMs).toISOString(),
      results,
    };
    try {
      write(state);
    } catch (error) {
      deps.log?.(`[calendar] could not record the background sync: ${(error as Error).message}`);
    }
    for (const r of results)
      if (!r.ok) deps.log?.(`[calendar] ${r.source} refresh failed: ${(r.error || "").slice(0, 200)}`);
    return state;
  }
  const run = () => {
    running ??= once().finally(() => {
      running = undefined;
    });
    return running;
  };
  const tick = () => void run().catch(() => undefined);
  const first = setTimeout(tick, deps.firstDelayMs ?? CALENDAR_FIRST_SYNC_MS);
  const timer = setInterval(tick, intervalMs);
  (first as any).unref?.();
  (timer as any).unref?.();
  return {
    run,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
