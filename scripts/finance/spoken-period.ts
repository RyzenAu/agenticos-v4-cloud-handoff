// Spoken periods for finance questions (AUDIT-F2 FIN-1): "last month" was answered with this
// month's figure. One parser for every finance voice path: today, yesterday, this/last week, this/
// last month, the last N days, a named month, this/last financial year (Australian: 1 July to
// 30 June) and this/last calendar year. Pure: parse without a date, resolve against Sydney's today.
export type SpokenPeriod =
  | { kind: "today" } | { kind: "yesterday" }
  | { kind: "this-week" } | { kind: "last-week" }
  | { kind: "this-month" } | { kind: "last-month" }
  | { kind: "last-days"; days: number }
  | { kind: "named-month"; month: number }
  | { kind: "this-fy" } | { kind: "last-fy" }
  | { kind: "this-year" } | { kind: "last-year" }
  | { kind: "all" };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));
const WORD_NUMBERS: Record<string, number> = { seven: 7, fourteen: 14, thirty: 30, sixty: 60, ninety: 90 };
const MONTH_RE = new RegExp(`\\b(?:in|for|during|over|of)\\s+(${MONTHS.join("|")}|${SHORT.map((s) => s.toLowerCase()).join("|")}|sept)\\b`);

/** The phrases a period can be said with, so they can be stripped from a spend category ("software last month"). */
export const PERIOD_PHRASE = new RegExp(
  "\\s*\\b(?:(?:this|last|the last|past|the past|previous|current)\\s+(?:financial year|fy|calendar year|year|month|week|fortnight|quarter|\\d{1,3} days|(?:seven|fourteen|thirty|sixty|ninety) days)" +
  "|today|yesterday|so far|all time|ever|(?:in|for|during|over)\\s+(?:" + MONTHS.join("|") + "|" + SHORT.map((s) => s.toLowerCase()).join("|") + "|sept))\\b.*$",
);

/** The period a question names, or null when it names none (callers default to this month). */
export function parseSpokenPeriod(input: string): SpokenPeriod | null {
  const t = String(input ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  if (/\b(last|previous) (financial year|fy)\b/.test(t)) return { kind: "last-fy" };
  if (/\b(this|current) (financial year|fy)\b|\bfinancial year to date\b|\bfytd\b|\bthe financial year\b/.test(t)) return { kind: "this-fy" };
  if (/\b(last|previous) (calendar )?year\b/.test(t)) return { kind: "last-year" };
  if (/\b(this|current) (calendar )?year\b|\byear to date\b|\bytd\b/.test(t)) return { kind: "this-year" };
  const days = /\b(?:last|past|previous) (\d{1,3}|seven|fourteen|thirty|sixty|ninety) days\b/.exec(t);
  if (days) { const n = WORD_NUMBERS[days[1]] ?? Number(days[1]); if (n >= 1 && n <= 366) return { kind: "last-days", days: n }; }
  if (/\b(last|past) fortnight\b/.test(t)) return { kind: "last-days", days: 14 };
  if (/\b(last|past|previous) (quarter|three months|3 months)\b/.test(t)) return { kind: "last-days", days: 90 };
  if (/\b(last|previous) month\b/.test(t)) return { kind: "last-month" };
  if (/\b(this|current) month\b|\bmonth to date\b|\bso far this month\b/.test(t)) return { kind: "this-month" };
  if (/\b(last|previous) week\b/.test(t)) return { kind: "last-week" };
  if (/\b(this|current) week\b/.test(t)) return { kind: "this-week" };
  if (/\byesterday\b/.test(t)) return { kind: "yesterday" };
  if (/\btoday\b/.test(t)) return { kind: "today" };
  const named = MONTH_RE.exec(t);
  if (named) { const m = named[1] === "sept" ? 8 : MONTHS.findIndex((x) => x === named[1] || x.slice(0, 3) === named[1]); if (m >= 0) return { kind: "named-month", month: m + 1 }; }
  if (/\b(all time|in total|ever|overall)\b/.test(t)) return { kind: "all" };
  return null;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthEnd = (y: number, m: number) => iso(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
const nice = (day: string) => { const [y, m, d] = day.split("-").map(Number); return `${d} ${SHORT[m - 1]} ${y}`; };

export type ResolvedPeriod = { from: string | null; to: string | null; label: string };

/** Dates for a spoken period, as of `today` (YYYY-MM-DD, Sydney). A named month is its most recent occurrence. */
export function resolveSpokenPeriod(p: SpokenPeriod, today: string): ResolvedPeriod {
  const [y, m] = today.split("-").map(Number);
  const fyStartYear = m >= 7 ? y : y - 1;
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  switch (p.kind) {
    case "today": return { from: today, to: today, label: "today" };
    case "yesterday": { const d = addDays(today, -1); return { from: d, to: d, label: `yesterday (${nice(d)})` }; }
    case "this-week": return { from: addDays(today, -6), to: today, label: "the last 7 days" };
    case "last-week": { const from = addDays(today, -weekday - 7), to = addDays(from, 6); return { from, to, label: `last week (${nice(from)} to ${nice(to)})` }; }
    case "this-month": return { from: iso(y, m, 1), to: today, label: "this month" };
    case "last-month": { const ly = m === 1 ? y - 1 : y, lm = m === 1 ? 12 : m - 1; return { from: iso(ly, lm, 1), to: monthEnd(ly, lm), label: `last month (${LONG[lm - 1]} ${ly})` }; }
    case "last-days": return { from: addDays(today, -(p.days - 1)), to: today, label: `the last ${p.days} days` };
    case "named-month": { const yy = p.month > m ? y - 1 : y; const to = p.month === m && yy === y ? today : monthEnd(yy, p.month); return { from: iso(yy, p.month, 1), to, label: `in ${LONG[p.month - 1]} ${yy}` }; }
    case "this-fy": return { from: iso(fyStartYear, 7, 1), to: today, label: `this financial year (from ${nice(iso(fyStartYear, 7, 1))})` };
    case "last-fy": return { from: iso(fyStartYear - 1, 7, 1), to: iso(fyStartYear, 6, 30), label: `last financial year (${fyStartYear - 1}–${String(fyStartYear).slice(2)})` };
    case "this-year": return { from: iso(y, 1, 1), to: today, label: `this calendar year` };
    case "last-year": return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31), label: `last calendar year (${y - 1})` };
    case "all": return { from: null, to: null, label: "across all imported data" };
  }
}

/** A spoken period as the NAB CSV summary's Period ("all" stays "all"; everything else is a date range). */
export function summaryPeriodFor(p: SpokenPeriod, today: string): "all" | { from: string; to: string } {
  const r = resolveSpokenPeriod(p, today);
  return r.from && r.to ? { from: r.from, to: r.to } : "all";
}
