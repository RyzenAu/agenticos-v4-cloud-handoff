// Client-side view of the Jarvis layer (scripts/jarvis-events.ts, jarvis-status.ts,
// jarvis-protocols.ts): the types the HUD and the voice companion read, and small pure helpers
// for freshness labels. Read-only: nothing here can send, dial or change anything outside the OS.

export type Source<T> = {
  ok: boolean;
  at: string | null;
  ageMs: number | null;
  stale: boolean;
  data: T | null;
  error?: string;
  /** The server's display name where the obvious one would mislead ("Agent approvals"). */
  label?: string;
  /** One-line headline from the source, e.g. "Lead hunt failing since 27 Sept" (UI-truth M5). */
  headline?: string;
  ownerAction?: string;
};
export type CalendarItem = { id?: string; title: string; start: string; end?: string; allDay?: boolean };
export type NextCall = { id: number; name: string; vertical: string; status: string; area?: string; phone?: string; opener?: string };
export type JarvisMode = {
  mode: "normal" | "call" | "quiet";
  callMode: boolean;
  quiet: { on: boolean; until: string | null };
  quietHours: boolean;
  budget: { spoken: number; limit: number };
};
export type StatusSnapshot = {
  generatedAt: string;
  mode: JarvisMode | null;
  next: Source<{ event: CalendarItem | null; tomorrowFirst: CalendarItem | null }>;
  calls: Source<{ founders: { who: string; calls: number; target: number }[]; followUpsDue: number; overdue: { name: string; dueAt: string | null } | null }>;
  nextCall: Source<NextCall | null>;
  approvals: Source<{ count: number }>;
  health: Source<{ total: number; broken: number; brokenNames: string[]; watchdog: string | null }>;
};
export type JarvisEvent = {
  id: string;
  seq: number;
  source: string;
  text: string;
  priority: "low" | "normal" | "urgent";
  createdAt: string;
  expiresAt: string;
  delivery: "speak" | "hud" | "flash";
  reason: string;
  spokenAt?: string;
  /** The stable event id (for a job's end: `job:<jobId>:<state>`): this browser never speaks the same one twice, across reloads and tabs. */
  dedupeKey?: string;
};
export type EventsResponse = JarvisMode & { seq: number; events: JarvisEvent[] };
export type ProtocolRun = {
  id: string;
  name: string;
  label: string;
  ok: boolean;
  steps: { id: string; label: string; state: "pending" | "done" | "failed" | "skipped"; detail?: string; client?: boolean }[];
  said: string;
  navigate: string | null;
  card: NextCall | null;
};

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function agoLabel(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown age";
  if (ms < 45_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Age of a source as of now: its age when the snapshot was built plus the time since. */
export function sourceAge(source: Source<unknown>, snapshotAt: string, now = Date.now()) {
  if (source.ageMs === null) return null;
  return source.ageMs + Math.max(0, now - Date.parse(snapshotAt));
}

/** Sydney wall-clock time, "2:30 pm"; with the weekday when it isn't today. */
export function clockLabel(iso: string, now = Date.now()) {
  const date = new Date(iso);
  const tz = "Australia/Sydney";
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .format(date)
    .replace(/\s?([ap])\.?m\.?/i, " $1m")
    .toLowerCase();
  if (day(date) === day(new Date(now))) return time;
  if (day(date) === day(new Date(now + 86_400_000))) return `Tomorrow ${time}`;
  return `${new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short" }).format(date)} ${time}`;
}

/** "in 25 min", "in 3 h", "now", or "" once past. */
export function untilLabel(iso: string, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms < -60_000) return "";
  if (ms < 60_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours} h` : "";
}

/** One dot for the whole HUD: red when something's broken, amber when unknown or stale. */
export function healthTone(snapshot: StatusSnapshot | null, offline: boolean): "good" | "warn" | "bad" | "unknown" {
  if (!snapshot || offline) return "unknown";
  const health = snapshot.health;
  if (!health.ok || !health.data) return "unknown";
  if (health.data.broken > 0) return "bad";
  if (health.stale || (health.data.watchdog && !["working", "available"].includes(health.data.watchdog))) return "warn";
  return "good";
}

/** Idle cost: 3 reads per poll, 4 requests a minute, none while the tab is hidden (was 36 a minute). Protocol runs and timer changes refetch straight away. */
export const HUD_POLL_MS = 45_000;
/** The HUD calls its own data stale once the OS hasn't answered for this long. */
export const HUD_OFFLINE_AFTER_MS = 120_000;

/**
 * With the live stream healthy the HUD refetches on a hint (a Jarvis change, an approval, a finished job), so the
 * timer is only a safety net: 3 reads every 90 s (2 a minute, was 4). With no stream it is HUD_POLL_MS as before.
 */
export const HUD_SAFETY_POLL_MS = 90_000;
/** A stream that was open and then lost shows the HUD offline after this long without a word from the hub. */
export const HUD_STREAM_LOST_AFTER_MS = 12_000;

/**
 * Pure: is the HUD offline? Same rules as before (no data, a failed read, nothing heard for HUD_OFFLINE_AFTER_MS),
 * where "heard" now includes the stream's heartbeat, plus one faster rule: a stream that had connected and then
 * dropped means the hub is gone, shown after HUD_STREAM_LOST_AFTER_MS instead of waiting for the next poll.
 */
export function hudOffline(input: {
  hasData: boolean;
  isError: boolean;
  dataUpdatedAt: number;
  now: number;
  stream: { state: string; everOpened: boolean; lastSignalAt: number; lostAt: number };
}): boolean {
  if (!input.hasData || input.isError) return true;
  const heard = Math.max(input.dataUpdatedAt || 0, input.stream.lastSignalAt || 0);
  if (input.now - heard > HUD_OFFLINE_AFTER_MS) return true;
  return input.stream.everOpened && input.stream.state === "retrying" && input.stream.lostAt > 0 && input.now - input.stream.lostAt > HUD_STREAM_LOST_AFTER_MS;
}
