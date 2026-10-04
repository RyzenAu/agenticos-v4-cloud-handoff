// Workspace "Today" calling window. The rules themselves live in scripts/leads/outreach.ts
// (callWindow + NO_CALL_HOLIDAYS: Mon–Fri 9–8, Sat 9–5, never Sunday or a national or NSW public
// holiday incl. substitute days, recipient's Sydney time). This file only adds what the Today panel needs on top:
// when the window closes, when it next opens, and a short label. Pure; safe in the browser.
import { callWindow, NO_CALL_HOLIDAYS } from "../leads/outreach";

export const CALLING_RULES = "Mon–Fri 9 am–8 pm · Sat 9 am–5 pm · Sunday and public holidays: no calls";
const TZ = "Australia/Sydney";
const OPEN_MIN = 9 * 60;

type Parts = { y: number; m: number; d: number; weekday: string; minutes: number };

function sydneyParts(at: Date): Parts {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const ymdOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Sydney wall-clock (calendar date + minutes after midnight) → the UTC instant, DST-aware. */
export function sydneyWallToUtc(y: number, m: number, d: number, minutes: number): Date {
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = wall - 10 * 3_600_000; // AEST first; corrected below for AEDT
  for (let i = 0; i < 3; i++) {
    const p = sydneyParts(new Date(guess));
    const seen = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60);
    if (seen === wall) break;
    guess += wall - seen;
  }
  return new Date(guess);
}

export type CallingWindowStatus = {
  open: boolean;
  /** outreach.ts's own reason, e.g. "Sunday: no calls", "open until 8 pm". */
  why: string;
  /** Short line for the panel, e.g. "Open · closes 8 pm" or "Closed · Sunday". */
  label: string;
  /** ISO instant the current window closes (open only). */
  closesAt: string | null;
  /** ISO instant the next window opens (closed only; null when none within 14 days). */
  nextOpenAt: string | null;
  sydney: { date: string; weekday: string; time: string };
  rules: string;
};

export function callingWindowStatus(now: Date = new Date()): CallingWindowStatus {
  const w = callWindow(now);
  const p = sydneyParts(now);
  const time = `${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
  const sydney = { date: ymdOf(p.y, p.m, p.d), weekday: p.weekday, time };
  if (w.open) {
    const closeMin = p.weekday === "Sat" ? 17 * 60 : 20 * 60;
    return {
      open: true, why: w.why, label: `Open · closes ${p.weekday === "Sat" ? "5 pm" : "8 pm"}`,
      closesAt: sydneyWallToUtc(p.y, p.m, p.d, closeMin).toISOString(), nextOpenAt: null, sydney, rules: CALLING_RULES,
    };
  }
  let nextOpenAt: string | null = null;
  for (let i = 0; i <= 14; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (day.getUTCDay() === 0 || NO_CALL_HOLIDAYS.has(ymdOf(y, m, d))) continue;
    if (i === 0 && p.minutes >= OPEN_MIN) continue; // today's window already passed
    nextOpenAt = sydneyWallToUtc(y, m, d, OPEN_MIN).toISOString();
    break;
  }
  const reason = /holiday/.test(w.why) ? "public holiday" : /Sunday/.test(w.why) ? "Sunday" : /before 9/.test(w.why) ? "opens 9 am" : "after hours";
  return { open: false, why: w.why, label: `Closed · ${reason}`, closesAt: null, nextOpenAt, sydney, rules: CALLING_RULES };
}
