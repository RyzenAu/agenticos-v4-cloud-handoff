// Ported (the pure parts only) from Dot's historical branch refs/dot/hist/cloud/f1-flows-wip, scripts/flows/when.ts (commit 1e32908a,
// "M&U Cloud Handoff Import"). Licence check: that branch's LICENSE blob is byte-identical to this repository's own (Claude OS, Personal & Commercial Use
// License with Attribution), so the code is covered by the licence it already ships under; no third-party code is involved. Nothing from the branch's
// flows service, live ports or store is ported: this file reads words and returns data, and does nothing.
// What differs from the original: the only change is the import path of ./format (it was ../../src/lib/format).
/**
 * Australian dates and times from words (F1 flow 5). Pure and deterministic: every function takes `now`, and the
 * zone is Sydney's (AEST/AEDT), so "tomorrow at 3" means the owner's tomorrow whatever this machine's clock says.
 * Day before month ("3/10" is 3 October), 12-hour lower-case times in the replies ("3:00 pm").
 */
import { fmtDay, fmtTime } from "./format";

export const TZ = "Australia/Sydney";

export type Ymd = { y: number; mo: number; d: number };
export type Hm = { h: number; mi: number };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** The wall-clock parts of an instant in Sydney. */
export function sydneyParts(at: Date): Ymd & Hm & { wd: number } {
  const f = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short" });
  const get: Record<string, string> = {};
  for (const p of f.formatToParts(at)) get[p.type] = p.value;
  return { y: Number(get.year), mo: Number(get.month), d: Number(get.day), h: Number(get.hour) % 24, mi: Number(get.minute), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get.weekday) };
}

/** The instant a Sydney wall-clock time is (correct across the October and April clock changes). */
export function sydneyInstant(day: Ymd, time: Hm): Date {
  const guess = Date.UTC(day.y, day.mo - 1, day.d, time.h, time.mi);
  const wallOf = (ms: number) => { const p = sydneyParts(new Date(ms)); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); };
  let ms = guess - (wallOf(guess) - guess);
  ms = guess - (wallOf(ms) - ms); // once more: the offset at the answer, not at the guess
  return new Date(ms);
}

const addDays = (day: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(day.y, day.mo - 1, day.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const dayNumber = (day: Ymd) => Math.floor(Date.UTC(day.y, day.mo - 1, day.d) / 86_400_000);
const sameDay = (a: Ymd, b: Ymd) => a.y === b.y && a.mo === b.mo && a.d === b.d;
const validDay = (day: Ymd) => { const t = new Date(Date.UTC(day.y, day.mo - 1, day.d)); return t.getUTCFullYear() === day.y && t.getUTCMonth() === day.mo - 1 && t.getUTCDate() === day.d; };

export type When = {
  /** The calendar day, or null when none was said. */
  day: Ymd | null;
  /** The time of day, or null when none was said. */
  time: Hm | null;
  /** "for an hour", "for 45 minutes"; null when not said. */
  durationMin: number | null;
  /** "in 2 hours": an instant relative to now, instead of a day and time. */
  relative: Date | null;
  /** What was left of the words once the date and time phrases were taken out. */
  rest: string;
};

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const numberOf = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUM_WORDS[w.toLowerCase()] ?? NaN);

/** 12-hour clock words to 24-hour: with no am/pm, 1 to 6 is the afternoon, 7 to 11 the morning, 12 noon. */
export function clockHour(h: number, meridiem: "am" | "pm" | null): number {
  if (meridiem === "am") return h === 12 ? 0 : h;
  if (meridiem === "pm") return h === 12 ? 12 : h + 12;
  if (h >= 13) return h;
  if (h === 0) return 0;
  return h >= 7 && h <= 11 ? h : h === 12 ? 12 : h + 12;
}

/**
 * Pull the date, time and duration out of `text`. Anything not understood stays in `rest`. `now` is an instant;
 * days are read in Sydney. Pure.
 */
export function parseWhen(text: string, now: Date): When {
  let rest = ` ${text} `;
  const today = (() => { const p = sydneyParts(now); return { y: p.y, mo: p.mo, d: p.d } as Ymd; })();
  const todayWd = sydneyParts(now).wd;
  let day: Ymd | null = null;
  let time: Hm | null = null;
  let durationMin: number | null = null;
  let relative: Date | null = null;
  const take = (re: RegExp, on: (m: RegExpExecArray) => void) => {
    const m = re.exec(rest);
    if (!m) return false;
    on(m);
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
    return true;
  };

  // duration first, so "for 2 hours" isn't read as a time
  take(/\bfor\s+(?:about\s+|around\s+)?(half an hour|half hour|an hour|a hour|an hour and a half|one and a half hours?|(\d+(?:\.\d+)?|one|two|three|four|five|six)\s*(?:hours?|hrs?|h)|(\d+|ten|fifteen|twenty|thirty|forty[- ]five|forty five|forty|sixty|ninety)\s*(?:minutes?|mins?|m))\b/i, (m) => {
    const w = m[1].toLowerCase();
    if (/half an hour|half hour/.test(w)) durationMin = 30;
    else if (/^an? hour$/.test(w)) durationMin = 60;
    else if (/hour and a half|one and a half/.test(w)) durationMin = 90;
    else if (m[2]) durationMin = Math.round(numberOf(m[2].toLowerCase()) * 60);
    else if (m[3]) { const words: Record<string, number> = { ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, "forty-five": 45, sixty: 60, ninety: 90 }; durationMin = /^\d+$/.test(m[3]) ? Number(m[3]) : words[m[3].toLowerCase()] ?? null; }
  });
  if (durationMin !== null && (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 12 * 60)) durationMin = null;

  // "in 2 hours", "in 30 minutes"
  take(/\bin\s+(\d+|one|two|three|four|five|six|an?)\s*(hours?|hrs?|minutes?|mins?)\b/i, (m) => {
    const n = /^an?$/i.test(m[1]) ? 1 : numberOf(m[1].toLowerCase());
    if (Number.isFinite(n)) relative = new Date(now.getTime() + n * (/^h/i.test(m[2]) ? 3_600_000 : 60_000));
  });

  // day words
  take(/\bthe day after tomorrow\b/i, () => { day = addDays(today, 2); });
  if (!day) take(/\b(?:tomorrow|tmrw|tomorow)\b/i, () => { day = addDays(today, 1); });
  if (!day) take(/\b(?:today|tonight|this evening)\b/i, (m) => { day = today; if (/tonight|evening/i.test(m[0]) && !time) time = { h: 19, mi: 0 }; });
  if (!day)
    take(new RegExp(String.raw`\b(?:(this|next|coming|on)\s+)?(${WEEKDAYS.join("|")}|${Object.keys(WEEKDAY_ABBR).join("|")})\b`, "i"), (m) => {
      const w = m[2].toLowerCase();
      const wd = WEEKDAYS.includes(w) ? WEEKDAYS.indexOf(w) : WEEKDAY_ABBR[w];
      const mod = (m[1] ?? "").toLowerCase();
      // "next friday" is the Friday of NEXT week (Monday to Sunday weeks); "this friday" and a bare "friday" are the
      // coming one, today included.
      let ahead = (wd - todayWd + 7) % 7;
      if (mod === "next") ahead = 7 - ((todayWd + 6) % 7) + ((wd + 6) % 7);
      day = addDays(today, ahead);
    });
  // "the 3rd", "3rd of October", "3 October", "October 3rd", "3/10", "3/10/2026"
  if (!day) {
    const months = `${MONTHS.join("|")}|${Object.keys(MONTH_ABBR).join("|")}`;
    const monthOf = (w: string) => (MONTHS.includes(w.toLowerCase()) ? MONTHS.indexOf(w.toLowerCase()) + 1 : MONTH_ABBR[w.toLowerCase()]);
    const done = (y: number | null, mo: number, d: number) => {
      let candidate: Ymd = { y: y ?? today.y, mo, d };
      if (!validDay(candidate)) return;
      if (y === null && dayNumber(candidate) < dayNumber(today)) candidate = { ...candidate, y: candidate.y + 1 };
      day = candidate;
    };
    take(new RegExp(String.raw`\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${months})\b(?:\s+(\d{4}))?`, "i"), (m) => done(m[3] ? Number(m[3]) : null, monthOf(m[2]), Number(m[1])));
    if (!day) take(new RegExp(String.raw`\b(?:on\s+)?(${months})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`, "i"), (m) => done(m[3] ? Number(m[3]) : null, monthOf(m[1]), Number(m[2])));
    if (!day) take(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => done(m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null, Number(m[2]), Number(m[1])));
    if (!day) take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i, (m) => {
      const d = Number(m[1]);
      let candidate: Ymd = { y: today.y, mo: today.mo, d };
      if (!validDay(candidate) || dayNumber(candidate) < dayNumber(today)) { const next = addDays({ y: today.y, mo: today.mo, d: 1 }, 32); candidate = { y: next.y, mo: next.mo, d }; }
      if (validDay(candidate)) day = candidate;
    });
  }

  // times: noon / midnight, "half past 3", "quarter to 4", "3:30pm", "3pm", "at 3", "15:00"
  if (!time) take(/\b(?:at\s+)?(?:noon|midday)\b/i, () => { time = { h: 12, mi: 0 }; });
  if (!time) take(/\b(?:at\s+)?midnight\b/i, () => { time = { h: 0, mi: 0 }; });
  if (!time)
    take(/\b(?:at\s+)?(half|quarter)\s+(past|to)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*(am|pm|a\.m\.|p\.m\.))?(?:\s+in the\s+(morning|afternoon|evening))?\b/i, (m) => {
      let h = numberOf(m[3].toLowerCase());
      const mer = /a/i.test(m[4] ?? "") ? "am" : /p/i.test(m[4] ?? "") ? "pm" : m[5] ? (/morning/i.test(m[5]) ? "am" : "pm") : null;
      const minutes = m[1].toLowerCase() === "half" ? 30 : 15;
      let mi = 0;
      if (m[2].toLowerCase() === "past") mi = minutes; else { h = h - 1; mi = 60 - minutes; if (h < 1) h = 12; }
      time = { h: clockHour(h, mer), mi };
    });
  if (!time)
    take(/\b(?:at\s+|@\s*)?(\d{1,2})(?::|\.)(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?(?:\s+in the\s+(morning|afternoon|evening))?/i, (m) => {
      const h = Number(m[1]), mi = Number(m[2]);
      if (h > 23 || mi > 59) return;
      const mer = /a/i.test(m[3] ?? "") ? "am" : /p/i.test(m[3] ?? "") ? "pm" : m[4] ? (/morning/i.test(m[4]) ? "am" : "pm") : null;
      time = { h: h >= 13 ? h : clockHour(h, mer), mi };
    });
  if (!time)
    take(/\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)(?!\w)/i, (m) => { const h = Number(m[1]); if (h >= 1 && h <= 12) time = { h: clockHour(h, /a/i.test(m[2]) ? "am" : "pm"), mi: 0 }; });
  if (!time)
    take(/\b(?:at|@)\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*o'?clock)?(?:\s+in the\s+(morning|afternoon|evening))?(?!\s*(?:st|nd|rd|th|\/|:))\b/i, (m) => {
      const h = numberOf(m[1].toLowerCase());
      if (!(h >= 1 && h <= 23)) return;
      time = { h: m[2] ? clockHour(h, /morning/i.test(m[2]) ? "am" : "pm") : clockHour(h, null), mi: 0 };
    });

  return { day, time, durationMin, relative, rest: rest.replace(/\s+/g, " ").trim() };
}

/** The instant of a day and time in Sydney. */
export const instantOf = (day: Ymd, time: Hm) => sydneyInstant(day, time);

/**
 * "tomorrow 3:00 pm", "today 9:30 am", "Fri 2 Oct, 3:00 pm": how an added event is read back. 12-hour lower-case,
 * day before month, "Sept" for September. Pure.
 */
export function whenSaid(start: Date, now: Date): string {
  const s = sydneyParts(start);
  const n = sydneyParts(now);
  const time = fmtTime(start, { timeZone: TZ });
  if (sameDay(s, n)) return `today ${time}`;
  if (sameDay(s, addDays(n, 1))) return `tomorrow ${time}`;
  return `${fmtDay(start, { timeZone: TZ, weekday: true, year: s.y !== n.y })}, ${time}`;
}
