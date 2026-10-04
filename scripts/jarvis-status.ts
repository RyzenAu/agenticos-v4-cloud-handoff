// "Status" on demand: one cached, read-only snapshot of what matters right now (next calendar
// commitment, calls vs target per founder, follow-ups due, work waiting on him, systems health),
// every figure carrying its source time and age. The spoken answer is built from it by plain
// code — no model call — so it's fast and never embellished. Unavailable or stale data is said
// to be so; it's never "all clear" unless every source actually reported.
import { sydneyParts } from "./jarvis-events";

export type CalendarItem = { id?: string; title: string; start: string; end?: string; allDay?: boolean };
export type FounderDay = { who: string; calls: number; target: number };
export type FollowUp = { name: string; dueAt: string | null };
export type NextCall = { id: number; name: string; vertical: string; status: string; area?: string; phone?: string; opener?: string };
/** Last night's lead hunt (scripts/leads/hunt.ts), so a failing hunt is never reported as fine. */
export type LeadHunt = { status: "ok" | "partial" | "failed" | "never"; problem?: string; ownerAction?: string; failingSince?: string | null };
export type Health = { total: number; broken: number; brokenNames: string[]; watchdog: string | null };

export type Source<T> = {
  ok: boolean;
  /** When the underlying data was produced (sync time, probe time), not when we read it. */
  at: string | null;
  ageMs: number | null;
  stale: boolean;
  data: T | null;
  error?: string;
  /** Display name for the tile, where the obvious one would mislead (e.g. "Agent approvals"). */
  label?: string;
  /** One-line freshness headline from the source itself, e.g. "Calendar offline since 22 Sept". */
  headline?: string;
  /** The exact step the owner must take to bring this source back, when one is needed. */
  ownerAction?: string;
};

export type StatusSnapshot = {
  generatedAt: string;
  mode: { mode: "normal" | "call" | "quiet"; callMode: boolean; quiet: { on: boolean; until: string | null }; quietHours: boolean; budget: { spoken: number; limit: number } } | null;
  next: Source<{ event: CalendarItem | null; tomorrowFirst: CalendarItem | null }>;
  calls: Source<{ founders: FounderDay[]; followUpsDue: number; overdue: FollowUp | null; followUps: FollowUp[]; hunt?: LeadHunt | null }>;
  nextCall: Source<NextCall | null>;
  approvals: Source<{ count: number }>;
  health: Source<Health>;
};

export type CalendarSnapshot = {
  events: CalendarItem[];
  syncedAt: string | null;
  connected: boolean;
  /** From scripts/calendar-health.ts: what's wrong, and what the owner has to do about it. */
  problem?: string;
  ownerAction?: string;
  headline?: string;
};
export type StatusSources = {
  calendar: () => CalendarSnapshot | Promise<CalendarSnapshot>;
  /** /leads/summary's `today` block: dayReport per founder. */
  leads: () => Promise<{ today: Record<string, { calls: number; target: number; followUpsDue: Array<{ name: string; nextAt: string | null }> }>; hunt?: LeadHunt }>;
  nextCall: () => Promise<NextCall | null>;
  /** Agent tasks waiting for his answer; null when the task store can't be read. */
  approvals: () => number | null | Promise<number | null>;
  capabilities: () => { generatedAt: string | null; capabilities: Array<{ id: string; name: string; status: string }> } | null;
  mode?: () => StatusSnapshot["mode"];
};

export const STALE_AFTER = { calendar: 6 * 3_600_000, health: 2 * 3_600_000 };
export const STATUS_CACHE_MS = 2000;

function source<T>(data: T, at: string | null, now: number, staleAfter = Infinity): Source<T> {
  const ageMs = at ? Math.max(0, now - Date.parse(at)) : null;
  return { ok: true, at, ageMs, stale: ageMs === null ? true : ageMs > staleAfter, data };
}
function failed<T>(error: unknown): Source<T> {
  return { ok: false, at: null, ageMs: null, stale: true, data: null, error: ((error as Error)?.message || "unavailable").slice(0, 160) };
}
async function attempt<T>(work: () => Promise<Source<T>> | Source<T>): Promise<Source<T>> {
  try {
    return await work();
  } catch (error) {
    return failed<T>(error);
  }
}

const timed = (e: CalendarItem) => !e.allDay && Number.isFinite(Date.parse(e.start));

/** First timed event still to start, and the first one on tomorrow's Sydney date. */
export function upcoming(events: CalendarItem[], now: number) {
  const sorted = events.filter(timed).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const event = sorted.find((e) => Date.parse(e.start) >= now) ?? null;
  const tomorrow = sydneyParts(now + 24 * 3_600_000).date;
  const tomorrowFirst = sorted.find((e) => sydneyParts(Date.parse(e.start)).date === tomorrow) ?? null;
  return { event, tomorrowFirst };
}

export async function buildStatus(sources: StatusSources, now = Date.now()): Promise<StatusSnapshot> {
  const [next, calls, nextCall, approvals, health] = await Promise.all([
    attempt(async () => {
      const cal = await sources.calendar();
      if (!cal.connected && !cal.events.length) throw new Error("No calendar is connected.");
      const result = source(upcoming(cal.events, now), cal.syncedAt, now, STALE_AFTER.calendar);
      if (cal.headline) result.headline = cal.headline;
      if (cal.problem) result.error = cal.problem.slice(0, 160);
      if (cal.ownerAction) result.ownerAction = cal.ownerAction;
      return result;
    }),
    attempt(async () => {
      const summary = await sources.leads();
      const founders = Object.entries(summary.today).map(([who, day]) => ({ who, calls: day.calls, target: day.target }));
      // Both founders' reports list shared (unowned) follow-ups; count each lead once.
      const byName = new Map<string, FollowUp>();
      for (const day of Object.values(summary.today))
        for (const lead of day.followUpsDue) byName.set(lead.name, { name: lead.name, dueAt: lead.nextAt });
      const followUps = [...byName.values()].sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""));
      const hunt = summary.hunt ?? null;
      const result = source({ founders, followUpsDue: followUps.length, overdue: followUps[0] ?? null, followUps: followUps.slice(0, 5), hunt }, new Date(now).toISOString(), now);
      if (hunt && (hunt.status === "failed" || hunt.status === "partial")) {
        const since = hunt.failingSince ? new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short" }).format(new Date(hunt.failingSince)) : null;
        result.headline = `Lead hunt ${hunt.status === "failed" ? "failing" : "partly failing"}${since ? ` since ${since}` : ""}`;
        if (hunt.ownerAction) result.ownerAction = hunt.ownerAction;
      }
      return result;
    }),
    attempt(async () => source(await sources.nextCall(), new Date(now).toISOString(), now)),
    attempt(async () => {
      const count = await sources.approvals();
      if (count === null) throw new Error("The task store isn't answering.");
      // Agent tasks paused for his answer, not unread email: say so wherever it's shown.
      return { ...source({ count }, new Date(now).toISOString(), now), label: "Agent approvals" };
    }),
    attempt(() => {
      const registry = sources.capabilities();
      if (!registry || !registry.generatedAt) throw new Error("The capability check hasn't run yet.");
      const broken = registry.capabilities.filter((c) => c.status === "broken");
      const watchdog = registry.capabilities.find((c) => c.id === "proactive.watchdog")?.status ?? null;
      return source(
        { total: registry.capabilities.length, broken: broken.length, brokenNames: broken.map((c) => c.name).slice(0, 5), watchdog },
        registry.generatedAt,
        now,
        STALE_AFTER.health,
      );
    }),
  ]);
  let mode: StatusSnapshot["mode"] = null;
  try {
    mode = sources.mode?.() ?? null;
  } catch {
    mode = null;
  }
  return { generatedAt: new Date(now).toISOString(), mode, next, calls, nextCall, approvals, health };
}

/** A ≤ 2 s cache so the HUD's poll and a spoken "status" share one read. */
export function createStatusCache(sources: StatusSources, options: { now?: () => number; ttlMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? STATUS_CACHE_MS;
  let cached: { at: number; value: Promise<StatusSnapshot> } | null = null;
  return {
    snapshot(): Promise<StatusSnapshot> {
      const at = now();
      if (cached && at - cached.at < ttl) return cached.value;
      const value = buildStatus(sources, at);
      cached = { at, value };
      value.catch(() => {
        if (cached?.value === value) cached = null;
      });
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}

// --- speaking it ------------------------------------------------------------------------------

export function ageWords(ms: number | null) {
  if (ms === null) return "an unknown time";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return "a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? "an hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "a day" : `${days} days`;
}

/** "2:30 pm", "tomorrow at 9 am", "on Friday at 10:15 am" — Sydney time. */
export function spokenTime(iso: string, now: number) {
  const ms = Date.parse(iso);
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().replace(/\./g, "");
  const clock = `${hour}${minute === "00" ? "" : `:${minute}`} ${period}`.trim();
  const day = sydneyParts(ms).date;
  if (day === sydneyParts(now).date) return `at ${clock}`;
  if (day === sydneyParts(now + 86_400_000).date) return `tomorrow at ${clock}`;
  const weekday = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "long" }).format(new Date(ms));
  return ms - now < 6 * 86_400_000 ? `on ${weekday} at ${clock}` : `on ${new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "long" }).format(new Date(ms))}`;
}

const name = (who: string) => (who ? who[0].toUpperCase() + who.slice(1) : who);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Open Settings → Connections and connect Google (…)." → a short spoken instruction. */
export function spokenAction(action?: string) {
  if (!action) return "";
  const first = action.split(/(?<=\.)\s/)[0].replace(/\s*\([^)]*\)/g, "").replace(/\s*→\s*/g, ", ");
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

export function commitmentSentence(s: StatusSnapshot, now: number) {
  const next = s.next;
  if (!next.ok || !next.data) return "I can't read your calendar right now, so I can't say what's next.";
  const event = next.data.event;
  if (next.stale) {
    const age = next.ageMs === null ? "" : ageWords(next.ageMs);
    const fix = next.ownerAction ? ` To fix it: ${spokenAction(next.ownerAction)}` : "";
    if (next.ageMs === null) return `Your calendar has never synced, so I can't vouch for what's next.${fix}`;
    return event
      ? `Your calendar last synced ${age} ago; as of then, next up was ${event.title} ${spokenTime(event.start, now)}.${fix}`
      : `Your calendar hasn't synced for ${age}, so I can't vouch for what's next.${fix}`;
  }
  return event ? `Next up: ${event.title}, ${spokenTime(event.start, now)}.` : "Nothing else is on your calendar.";
}

export function callsSentence(s: StatusSnapshot) {
  const calls = s.calls;
  if (!calls.ok || !calls.data) return "The CRM isn't answering, so I have no call figures.";
  const founders = calls.data.founders.map((f) => `${name(f.who)} ${f.calls}${f.target ? ` of ${f.target}` : ""}`).join(", ");
  const due = calls.data.followUpsDue;
  const hunt = calls.data.hunt;
  const huntLine = hunt && (hunt.status === "failed" || hunt.status === "partial")
    ? ` The nightly lead hunt ${hunt.status === "failed" ? "is failing" : "partly failed"}${hunt.problem ? `: ${hunt.problem.replace(/\s*\(\d{3}\)/, "")}` : ""}.`
    : "";
  return `Calls today: ${founders || "none logged"}; ${due ? `${plural(due, "follow-up")} due, starting with ${calls.data.overdue!.name}` : "no follow-ups due"}.${huntLine}`;
}

export function systemsSentence(s: StatusSnapshot) {
  const parts: string[] = [];
  const health = s.health;
  if (!health.ok || !health.data) parts.push("I have no systems check to go on");
  else if (health.data.broken)
    parts.push(`${plural(health.data.broken, "system")} ${health.data.broken === 1 ? "needs" : "need"} attention: ${health.data.brokenNames.join(", ")}`);
  else if (health.stale) parts.push(`systems looked fine at the last check, ${ageWords(health.ageMs)} ago`);
  else if (health.data.watchdog && health.data.watchdog !== "working" && health.data.watchdog !== "available")
    parts.push("systems report fine, but the watchdog itself isn't running");
  else parts.push("systems are healthy");
  const approvals = s.approvals;
  if (!approvals.ok || !approvals.data) parts.push("I can't see the task queue");
  else if (approvals.data.count) parts.push(`${plural(approvals.data.count, "agent task")} ${approvals.data.count === 1 ? "is" : "are"} waiting on your answer`);
  else parts.push("no agent tasks are waiting on you");
  const line = parts.join("; ");
  return `${line[0].toUpperCase()}${line.slice(1)}.`;
}

/** Three short spoken facts: next commitment, pipeline/overdue work, systems and approvals. */
export function statusSentences(s: StatusSnapshot, now = Date.parse(s.generatedAt)) {
  return [commitmentSentence(s, now), callsSentence(s), systemsSentence(s)];
}
