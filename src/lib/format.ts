/**
 * The ONE place the OS turns money, dates and times into words (L10, 29 Sep 2026; audit AUD-OS P2-6).
 *
 * Rules, everywhere in the app:
 *  - Money: Australian dollars are "A$1,234.50", never a bare "$". Any other currency is labelled
 *    ("US$0.97", "NZ$5"). Compact form: "A$100k", "A$1.2m".
 *  - Dates: en-AU, day then month, "Sept" (the en-AU abbreviation), never ISO in prose:
 *    "29 Sept" and, when the year matters, "29 Sept 2026".
 *  - Times: 12-hour, lower-case, no leading zero: "4:56 am", "12:05 pm". Never 24-hour, never "AM".
 *
 * Deterministic on purpose: nothing here depends on the ICU build's idea of "en-AU", so the server
 * render, the browser and the tests all print the same string.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export type DateInput = string | number | Date | null | undefined;

const NONE = "—";

/** Bare "YYYY-MM-DD" is a calendar day, not an instant: read it as that day in local time. */
function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number };

/** The wall-clock parts of `date`, in `timeZone` when given (else the machine's own zone). */
function partsOf(date: Date, timeZone?: string): Parts {
  if (!timeZone) return { y: date.getFullYear(), mo: date.getMonth(), d: date.getDate(), h: date.getHours(), mi: date.getMinutes(), s: date.getSeconds(), wd: date.getDay() };
  const f = new Intl.DateTimeFormat("en-AU", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23", weekday: "short" });
  const get: Record<string, string> = {};
  for (const p of f.formatToParts(date)) get[p.type] = p.value;
  return { y: Number(get.year), mo: Number(get.month) - 1, d: Number(get.day), h: Number(get.hour) % 24, mi: Number(get.minute), s: Number(get.second), wd: Math.max(0, WEEKDAYS.indexOf(get.weekday as (typeof WEEKDAYS)[number])) };
}

export interface FormatOptions {
  timeZone?: string;
}

/** 16:56 → "4:56 am". Midnight is "12:00 am", noon "12:00 pm". */
export function fmtTime(value: DateInput, opts: FormatOptions & { seconds?: boolean } = {}): string {
  const date = toDate(value);
  if (!date) return NONE;
  const p = partsOf(date, opts.timeZone);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const sec = opts.seconds ? `:${String(p.s).padStart(2, "0")}` : "";
  return `${h12}:${String(p.mi).padStart(2, "0")}${sec} ${p.h < 12 ? "am" : "pm"}`;
}

/** "29 Sept" (or "29 Sept 2026" with `year`, "Tue 29 Sept" with `weekday`). */
export function fmtDay(value: DateInput, opts: FormatOptions & { year?: boolean | "auto"; weekday?: boolean | "long"; longMonth?: boolean } = {}): string {
  const date = toDate(value);
  if (!date) return NONE;
  const p = partsOf(date, opts.timeZone);
  const showYear = opts.year === "auto" ? p.y !== partsOf(new Date(), opts.timeZone).y : Boolean(opts.year);
  const wd = opts.weekday === "long" ? `${WEEKDAYS_LONG[p.wd]} ` : opts.weekday ? `${WEEKDAYS[p.wd]} ` : "";
  return `${wd}${p.d} ${opts.longMonth ? MONTHS_LONG[p.mo] : MONTHS[p.mo]}${showYear ? ` ${p.y}` : ""}`;
}

/** "29 Sept, 4:56 am" — a date and a time in one label. */
export function fmtDateTime(value: DateInput, opts: FormatOptions & { year?: boolean | "auto"; weekday?: boolean | "long"; seconds?: boolean } = {}): string {
  const date = toDate(value);
  if (!date) return NONE;
  return `${fmtDay(date, opts)}, ${fmtTime(date, opts)}`;
}

/** "Sept 2026" / "September 2026": a month heading. */
export function fmtMonthYear(value: DateInput, opts: FormatOptions & { longMonth?: boolean } = {}): string {
  const date = toDate(value);
  if (!date) return NONE;
  const p = partsOf(date, opts.timeZone);
  return `${opts.longMonth ? MONTHS_LONG[p.mo] : MONTHS[p.mo]} ${p.y}`;
}

/** Weekday only: "Tue" / "Tuesday". */
export function fmtWeekday(value: DateInput, opts: FormatOptions & { long?: boolean } = {}): string {
  const date = toDate(value);
  if (!date) return NONE;
  const p = partsOf(date, opts.timeZone);
  return opts.long ? WEEKDAYS_LONG[p.wd] : WEEKDAYS[p.wd];
}

/**
 * The time of day when `value` is today, else the date. For dense lists (inbox rows).
 * `now` is injectable so tests don't depend on the clock.
 */
export function fmtWhenShort(value: DateInput, now: DateInput = Date.now(), opts: FormatOptions = {}): string {
  const date = toDate(value);
  const ref = toDate(now) ?? new Date();
  if (!date) return NONE;
  const a = partsOf(date, opts.timeZone);
  const b = partsOf(ref, opts.timeZone);
  return a.y === b.y && a.mo === b.mo && a.d === b.d ? fmtTime(date, opts) : fmtDay(date, { ...opts, year: a.y !== b.y });
}

// ── money ──────────────────────────────────────────────────────────────────────────────────────

/** Currency prefixes. AUD is "A$" everywhere in this OS; USD is "US$" so it is never read as AUD. */
const PREFIX: Record<string, string> = { AUD: "A$", USD: "US$", NZD: "NZ$", CAD: "C$", SGD: "S$", HKD: "HK$", GBP: "£", EUR: "€", JPY: "¥", INR: "₹", CHF: "CHF ", AED: "AED ", BRL: "R$", ZAR: "R" };

export function currencyPrefix(currency: string): string {
  const code = currency.toUpperCase();
  return PREFIX[code] ?? `${code} `;
}

function groups(n: number, minFrac: number, maxFrac: number): string {
  return new Intl.NumberFormat("en-AU", { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac }).format(n);
}

export interface MoneyOptions {
  /** "AUD" by default. Anything else prints with its own prefix ("US$"). */
  currency?: string;
  /** No cents: "A$1,235". */
  whole?: boolean;
  /** Cents shown only when the amount has them: "A$120" vs "A$120.50". */
  trimZeros?: boolean;
  /** Extra precision for sub-dollar amounts (per-call prices): "US$0.0042". */
  precise?: boolean;
}

/** 1234.5 → "A$1,234.50"; (0.97, USD) → "US$0.97". Missing values are "—", never "$0". */
export function fmtMoney(amount: number | null | undefined, opts: MoneyOptions = {}): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return NONE;
  const prefix = currencyPrefix(opts.currency ?? "AUD");
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  let body: string;
  if (opts.whole) body = groups(abs, 0, 0);
  else if (opts.precise && abs > 0 && abs < 1) body = groups(abs, 2, abs < 0.01 ? 4 : 3);
  else if (opts.trimZeros) body = Number.isInteger(abs) ? groups(abs, 0, 0) : groups(abs, 2, 2);
  else body = groups(abs, 2, 2);
  return `${sign}${prefix}${body}`;
}

/** Whole cents → dollars, same rules as `fmtMoney`. */
export function fmtMoneyCents(cents: number | null | undefined, opts: MoneyOptions = {}): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return NONE;
  return fmtMoney(cents / 100, opts);
}

/** 100000 → "A$100k"; 1_250_000 → "A$1.25m"; under `compactFrom` (10,000) stays exact ("A$9,500"). */
export function fmtMoneyCompact(amount: number | null | undefined, opts: Pick<MoneyOptions, "currency"> & { compactFrom?: number } = {}): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return NONE;
  const prefix = currencyPrefix(opts.currency ?? "AUD");
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  if (abs < (opts.compactFrom ?? 10_000)) return `${sign}${prefix}${groups(abs, 0, abs < 100 && !Number.isInteger(abs) ? 2 : 0)}`;
  if (abs < 1_000_000) return `${sign}${prefix}${trim(abs / 1000)}k`;
  return `${sign}${prefix}${trim(abs / 1_000_000)}m`;
}
const trim = (n: number) => String(Math.round(n * 100) / 100);

/** "A$120/h": a rate with its unit. */
export function fmtRate(amount: number | null | undefined, unit: string, opts: MoneyOptions = {}): string {
  const v = fmtMoney(amount, { trimZeros: true, ...opts });
  return v === NONE ? NONE : `${v}/${unit}`;
}

/**
 * Prose guard: finds unlabelled "$" amounts ("$100k", "$0") and ISO dates in a rendered string.
 * Used by tests to keep the touched pages honest; returns the offending fragments.
 */
export function formatViolations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^A-Za-z$])\$\d[\d,.]*[kKmM]?/g)) out.push(m[0].trim());
  for (const m of text.matchAll(/\b20\d\d-\d\d-\d\d\b/g)) out.push(m[0]);
  for (const m of text.matchAll(/\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/g)) out.push(m[0]);
  return out;
}

// ── freshness ──────────────────────────────────────────────────────────────────────────────────

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export function fmtAgo(value: DateInput, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return NONE;
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) {
    const d = Math.floor(s / 86_400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return fmtDay(date, { year: "auto" });
}

/**
 * The page-foot freshness line, only when it carries meaning: null while the data is fresh (the
 * reader needs nothing), "Stale: last read 3 h ago" once it is older than `staleAfterMs`, and
 * "No successful read yet" when there is no time at all. Routine "Updated just now" never shows.
 */
export function staleNote(at: DateInput, now: number, staleAfterMs = 15 * 60_000): string | null {
  if (!now) return null;
  const date = toDate(at);
  if (!date) return "No successful read yet";
  return now - date.getTime() > staleAfterMs ? `Stale: last read ${fmtAgo(date, now)}` : null;
}

/**
 * Display-time tidy for text that arrives from a source as prose: an ISO day ("2026-09-28") becomes
 * "28 Sept 2026" and a year-month ("2026-08") becomes "Aug 2026". Text without either passes through.
 */
export function fmtProse(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return text
    // A date inside a file path or an id ("dental-call-pack-2026-09-28/v3-live-2026-09-27.md") is part of a name: left alone.
    .replace(/(?<![\w/\\.-])(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\w/\\-])(?!\.\w)/g, (m) => fmtDay(m, { year: true, timeZone: "UTC" }))
    .replace(/(?<![\w/\\.-])(20\d\d)-(0[1-9]|1[0-2])(?![\w/\\-])(?!\.\w)/g, (_m, y: string, mo: string) => `${MONTHS[Number(mo) - 1]} ${y}`)
    .replace(/\b(\d{1,2}) Sep\b(?!t)/g, "$1 Sept")
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)Z\b/g, (_m, h: string, mi: string) => `${Number(h) % 12 === 0 ? 12 : Number(h) % 12}:${mi} ${Number(h) < 12 ? "am" : "pm"} UTC`);
}

/** Text from a USD-priced source ("listed $0.14/$0.28"): a bare "$" becomes "US$" so it is never read as AUD. */
export function fmtUsdProse(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return text.replace(/(^|[^A-Za-z$])\$(?=\d)/g, "$1US$");
}

/** Both tidy-ups for data prose from a USD-priced source (model catalogue notes, probe results). */
export function fmtDataProse(text: string | null | undefined): string {
  return fmtUsdProse(fmtProse(text));
}

/** Owner-written text that means Australian dollars ("Scale to $100k/month"): a bare "$" becomes "A$". */
export function fmtAudProse(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return text.replace(/(^|[^A-Za-z$])\$(?=\d)/g, "$1A$");
}
