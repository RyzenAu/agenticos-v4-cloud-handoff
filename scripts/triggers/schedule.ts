// Schedule arithmetic for routines: pure functions, no timers. A routine has no in-memory cron: the
// engine asks "which scheduled slots fall in (cursor, now]?" on every tick, and the cursor is durable, so
// a restart or a host that was down is visible as slots that were due while nobody was ticking.
import type { RoutineSchedule } from "./types";

const MAX_SLOTS = 500;

function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads y-m-d hh:mm (DST-safe: re-checks the offset once). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

function localDate(instant: number, tz: string): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant)).split("-").map(Number);
  return { y, m, d };
}

export function validSchedule(s: unknown): s is RoutineSchedule {
  if (!s || typeof s !== "object") return false;
  const x = s as Record<string, unknown>;
  if (x.kind === "interval") return typeof x.everyMinutes === "number" && Number.isInteger(x.everyMinutes) && x.everyMinutes >= 1 && x.everyMinutes <= 7 * 24 * 60;
  if (x.kind !== "daily" || typeof x.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.at) || typeof x.tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: x.tz });
    return true;
  } catch {
    return false;
  }
}

/** Slot instants (ms) strictly after `after` and at or before `upTo`, oldest first. */
export function slotsBetween(schedule: RoutineSchedule, after: number, upTo: number): number[] {
  if (upTo <= after) return [];
  const out: number[] = [];
  if (schedule.kind === "interval") {
    const step = schedule.everyMinutes * 60_000;
    for (let t = (Math.floor(after / step) + 1) * step; t <= upTo && out.length < MAX_SLOTS; t += step) out.push(t);
    return out;
  }
  const [hh, mm] = schedule.at.split(":").map(Number);
  const start = localDate(after - 24 * 3600_000, schedule.tz);
  for (let i = 0; i < 400 && out.length < MAX_SLOTS; i++) {
    // Calendar arithmetic through Date.UTC keeps month and year rollovers right.
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const slot = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, schedule.tz);
    if (slot > upTo) break;
    if (slot > after) out.push(slot);
  }
  return out;
}

/** The next slot after `from`, for display. */
export function nextSlot(schedule: RoutineSchedule, from: number): number | null {
  return slotsBetween(schedule, from, from + 8 * 24 * 3600_000)[0] ?? null;
}
