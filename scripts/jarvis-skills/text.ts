// Shared text helpers for Jarvis's instant skills: utterance clean-up, spoken numbers,
// durations, clock times, Sydney wall-clock maths and the "does this look like a secret?" check.
// All pure; no I/O.

export const TIME_ZONE = "Australia/Sydney";

/** Strip a wake word and politeness from the front, keeping the rest's case. */
export function core(utterance: string) {
  return utterance
    .replace(/[’`]/g, "'")
    .replace(/^\s*(?:(?:uh+|um+|umm+|er+m?|hmm+|ah+)[,\s]+)*(?:(?:okay|ok|right|alright)[,\s]+)?(?:hey\s+)?(?:jarvis[,:\s]+)?(?:(?:uh+|um+|umm+|er+m?|hmm+|ah+)[,\s]+)*/i, "")
    .replace(/^(?:can you|could you|would you|will you|please|jarvis)[,\s]+/i, "")
    .replace(/^(?:please)[,\s]+/i, "")
    .trim();
}

/** Lower-case, trailing punctuation and politeness gone, "4,850" → "4850", commas → spaces. */
export function norm(utterance: string) {
  return core(utterance)
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/,/g, " ")
    .replace(/\s+(?:please|for me|now|jarvis|sir|mate)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- numbers ----------------------------------------------------------------------------------
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "25", "2.5", "twenty five", "twenty-five", "a", "a couple of" → number; anything else → null. */
export function parseNumber(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (/^(?:a )?couple(?: of)?$/.test(t)) return 2;
  if (t === "half" || t === "a half") return 0.5;
  const words = t.split(" ");
  let total = 0,
    seen = false;
  for (const word of words) {
    if (word in TENS && !seen) total += TENS[word];
    else if (word in UNITS && (total % 10 === 0 || !seen)) total += UNITS[word];
    else if (word === "hundred" && seen) total *= 100;
    else return null;
    seen = true;
  }
  return seen ? total : null;
}

/** Replace runs of number words ("twelve times seven") with digits, for maths only. */
export function wordsToDigits(text: string) {
  const vocab = [...Object.keys(UNITS).filter((w) => !["a", "an", "oh"].includes(w)), ...Object.keys(TENS), "hundred"].join("|");
  return text.replace(new RegExp(`\\b(?:${vocab})(?:[\\s-]+(?:${vocab}))*\\b`, "g"), (run) => {
    const value = parseNumber(run);
    return value === null ? run : String(value);
  });
}

/** Round for speech: whole numbers stay whole, others keep up to `digits` decimals. */
export function spokenNumber(value: number, digits = 2) {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  const places = abs >= 100 ? Math.min(digits, 2) : abs >= 1 ? digits : Math.max(digits, 4);
  const rounded = Number(value.toFixed(places));
  return rounded.toLocaleString("en-AU", { maximumFractionDigits: places });
}

// --- durations --------------------------------------------------------------------------------
export type Duration = { seconds: number; phrase: string; single: { value: number; unit: "second" | "minute" | "hour" | "day" } | null };
const UNIT_SECONDS = { second: 1, minute: 60, hour: 3600, day: 86400 } as const;
function unitOf(word: string): keyof typeof UNIT_SECONDS | null {
  if (/^(?:s|secs?|seconds?)$/.test(word)) return "second";
  if (/^(?:m|mins?|minutes?)$/.test(word)) return "minute";
  if (/^(?:h|hrs?|hours?)$/.test(word)) return "hour";
  if (/^(?:d|days?)$/.test(word)) return "day";
  return null;
}
const plural = (value: number, unit: string) => `${spokenNumber(value)} ${unit}${value === 1 ? "" : "s"}`;

/** "10 minutes", "an hour and a half", "1 hour 30 minutes", "half an hour", "90 secs" → seconds. */
export function parseDuration(text: string): Duration | null {
  let t = text
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:a |one )?half (?:an|a) hour$/, "30 minutes")
    .replace(/^a half hour$/, "30 minutes")
    .replace(/\b(\d+(?:\.\d+)?|[a-z]+(?: [a-z]+)?) and a half (hours?|minutes?|days?)\b/, (_, n, u) => {
      const value = parseNumber(n);
      return value === null ? _ : `${value + 0.5} ${u}`;
    });
  // "an hour and a half" → "1.5 hours"
  t = t.replace(/\b(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve) (hours?|minutes?|days?) and a half\b/, (_, n, u) => {
    const value = parseNumber(n);
    return value === null ? _ : `${value + 0.5} ${u}`;
  });
  const tokens = t.replace(/\b(\d+(?:\.\d+)?)(s|m|h|d|secs?|mins?|hrs?)\b/g, "$1 $2").split(/\s+(?:and\s+)?|\s*,\s*/).filter(Boolean);
  let seconds = 0;
  const parts: Array<{ value: number; unit: keyof typeof UNIT_SECONDS }> = [];
  let pending: string[] = [];
  for (const token of tokens) {
    if (token === "and") continue;
    const unit = unitOf(token);
    if (!unit) {
      pending.push(token);
      if (pending.length > 3) return null;
      continue;
    }
    if (!pending.length) return null;
    const value = parseNumber(pending.join(" ").replace(/ of$/, ""));
    pending = [];
    if (value === null || value <= 0) return null;
    if (parts.some((p) => p.unit === unit)) return null;
    parts.push({ value, unit });
    seconds += value * UNIT_SECONDS[unit];
  }
  if (pending.length || !parts.length) return null;
  seconds = Math.round(seconds);
  if (seconds <= 0) return null;
  const phrase = parts.map((p) => plural(p.value, p.unit)).join(" ");
  const single = parts.length === 1 ? parts[0] : null;
  return { seconds, phrase, single };
}

/** "4 minutes 12 seconds", "1 hour 5 minutes", "42 seconds" for time remaining. */
export function formatRemaining(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400),
    hours = Math.floor((total % 86400) / 3600),
    minutes = Math.floor((total % 3600) / 60),
    seconds = total % 60;
  if (days) return [plural(days, "day"), hours ? plural(hours, "hour") : ""].filter(Boolean).join(" ");
  if (hours) return [plural(hours, "hour"), minutes ? plural(minutes, "minute") : ""].filter(Boolean).join(" ");
  if (minutes) return [plural(minutes, "minute"), seconds ? plural(seconds, "second") : ""].filter(Boolean).join(" ");
  return plural(seconds, "second");
}

// --- clock times ------------------------------------------------------------------------------
export type Meridiem = "am" | "pm";
export type Clock = { hour: number; minute: number; meridiem: Meridiem | null; day: "today" | "tomorrow" | null };

/**
 * "7:30", "7.30 pm", "seven thirty", "half past 7", "quarter to 8", "noon", "19:00", "3 pm tomorrow",
 * "tomorrow at 9 am", "8 tonight". hour is 0–23 when settled, or 1–12 with meridiem null when he
 * didn't say (the caller asks back rather than guessing).
 */
export function parseClock(text: string): Clock | null {
  let t = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
  let day: Clock["day"] = null;
  let meridiem: Meridiem | null = null;
  const take = (re: RegExp) => {
    const hit = re.test(t);
    if (hit) t = t.replace(re, " ");
    return hit;
  };
  if (take(/ tomorrow morning /)) (day = "tomorrow"), (meridiem = "am");
  else if (take(/ tomorrow (?:afternoon|evening|night) /)) (day = "tomorrow"), (meridiem = "pm");
  else if (take(/ tomorrow /)) day = "tomorrow";
  if (take(/ (?:tonight|this evening|this afternoon|in the (?:afternoon|evening)|at night) /)) {
    meridiem = "pm";
    day ??= "today";
  }
  if (take(/ (?:this morning|in the morning) /)) {
    meridiem = "am";
    day ??= "today";
  }
  if (take(/ today /)) day ??= "today";
  t = t.replace(/ at /g, " ").replace(/ o'?clock /g, " ").replace(/\s+/g, " ").trim();
  const mer = t.match(/\s*(?<![a-z])([ap])\.?\s?m\.?$/);
  if (mer) {
    meridiem = mer[1] === "a" ? "am" : "pm";
    t = t.slice(0, mer.index).trim();
  }
  if (!t) return null;
  if (/^(?:noon|midday|12 noon)$/.test(t)) return { hour: 12, minute: 0, meridiem: "pm", day };
  if (/^midnight$/.test(t)) return { hour: 0, minute: 0, meridiem: "am", day };
  let hour: number | null = null,
    minute = 0;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?$/))) {
    hour = Number(m[1]);
    minute = m[2] ? Number(m[2]) : 0;
  } else if ((m = t.match(/^(\d{1,2})(\d{2})$/)) && Number(m[1]) <= 23) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else if ((m = t.match(/^(half|quarter|\d{1,2}|[a-z]+(?: [a-z]+)?) (past|to|after) (\d{1,2}|[a-z]+)$/))) {
    const base = parseNumber(m[3]);
    const offset = m[1] === "half" ? 30 : m[1] === "quarter" ? 15 : parseNumber(m[1]);
    if (base === null || offset === null || offset >= 60) return null;
    if (m[2] === "to") {
      hour = base === 1 ? 12 : base - 1;
      if (base === 0) return null;
      minute = 60 - offset;
    } else {
      hour = base;
      minute = offset;
    }
  } else {
    // Words: "seven", "seven thirty", "six oh five", "eleven fifteen".
    const words = t.split(" ");
    const h = parseNumber(words[0]);
    if (h === null || !Number.isInteger(h)) return null;
    const rest = words.slice(1).join(" ");
    const min = !rest ? 0 : rest.startsWith("oh ") ? parseNumber(rest.slice(3)) : parseNumber(rest);
    if (min === null || (rest.startsWith("oh ") && min > 9)) return null;
    hour = h;
    minute = min;
  }
  if (hour === null || !Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59 || hour > 23) return null;
  if (meridiem) {
    if (hour === 0 || hour > 12) return hour > 12 && meridiem === "pm" ? { hour, minute, meridiem, day } : null;
    return { hour: meridiem === "am" ? hour % 12 : (hour % 12) + 12, minute, meridiem, day };
  }
  if (hour === 0 || hour > 12) return { hour, minute, meridiem: hour >= 12 ? "pm" : "am", day };
  return { hour, minute, meridiem: null, day };
}

/** Settle an ambiguous clock with "am"/"pm". */
export function withMeridiem(clock: Clock, meridiem: Meridiem): Clock {
  if (clock.meridiem) return clock;
  return { ...clock, hour: meridiem === "am" ? clock.hour % 12 : (clock.hour % 12) + 12, meridiem };
}

// --- Sydney wall clock ------------------------------------------------------------------------
const PARTS = new Intl.DateTimeFormat("en-AU", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "long",
  hourCycle: "h23",
});
export function sydney(ms: number) {
  const parts = PARTS.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}
function offsetAt(ms: number) {
  const p = sydney(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** Epoch ms for a Sydney wall-clock time (month 1–12; day may overflow, like Date.UTC). */
export function sydneyToEpoch(year: number, month: number, day: number, hour: number, minute: number) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let at = guess - offsetAt(guess);
  const second = guess - offsetAt(at);
  if (second !== at) at = second;
  return at;
}

/** The next moment matching a settled clock: today if still ahead, else tomorrow. */
export function resolveClock(now: number, clock: Clock): { at: number; tomorrow: boolean } {
  const today = sydney(now);
  const onDay = (offset: number) => sydneyToEpoch(today.year, today.month, today.day + offset, clock.hour, clock.minute);
  if (clock.day === "tomorrow") return { at: onDay(1), tomorrow: true };
  const at = onDay(0);
  return at > now + 5_000 ? { at, tomorrow: false } : { at: onDay(1), tomorrow: true };
}

/** "7:30 am", "3 pm", "12:05 am". */
export function clockWords(ms: number) {
  const p = sydney(ms);
  const h12 = p.hour % 12 || 12;
  return `${h12}${p.minute ? `:${String(p.minute).padStart(2, "0")}` : ""} ${p.hour < 12 ? "am" : "pm"}`;
}
export function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}
export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** When something is due, in words relative to now: "in 18 minutes", "at 3 pm", "tomorrow at 9 am". */
export function dueWords(now: number, at: number) {
  if (at - now < 60 * 60_000) return `in ${formatRemaining(Math.max(at - now, 1000)).replace(/ \d+ seconds?$/, "")}`;
  const a = sydney(at),
    n = sydney(now);
  const sameDay = a.year === n.year && a.month === n.month && a.day === n.day;
  const tomorrow = sydney(now + 86_400_000);
  const isTomorrow = a.year === tomorrow.year && a.month === tomorrow.month && a.day === tomorrow.day;
  if (sameDay) return `at ${clockWords(at)}`;
  if (isTomorrow) return `tomorrow at ${clockWords(at)}`;
  return `on ${a.weekday} the ${ordinal(a.day)} at ${clockWords(at)}`;
}

// --- secrets ------------------------------------------------------------------------------------
function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * True when text looks like a password, key, token, private key or card number. Deliberately
 * eager: a false alarm costs one "I won't read that aloud"; a miss reads a secret out loud.
 */
/** A file path or a file name: separated segments of ordinary name characters, or name.ext. Pure. */
export function isPathLike(token: string) {
  const t = token.replace(/^["'(]+|["').,;:!?]+$/g, "");
  if (/^[a-z]:[\\/]?$/i.test(t)) return true;
  const parts = t.replace(/^[a-z]:(?=[\\/])/i, "").split(/[\\/]+/).filter(Boolean);
  if (/[\\/]/.test(t) && parts.length >= 1 && parts.every((p) => /^[\w .()~$&+,-]+$/.test(p) && !/^[.]+$/.test(p))) return true;
  return /^[\w() ~&+,-]+(?:\.[\w-]+)*\.[a-z][a-z0-9]{0,4}$/i.test(t) && t.length <= 120;
}

export function looksSecret(text: string) {
  const t = text.trim();
  if (!t) return false;
  const patterns = [
    /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
    /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
    /\bbearer\s+[A-Za-z0-9._~+/-]{12,}/i,
    /\b(?:password|passwd|pwd|passcode|pass ?phrase|pin|secret|api[_ -]?key|access[_ -]?key|token|private[_ -]?key|client[_ -]?secret|otp|security code|cvv|cvc)\b\s*(?:is|[:=])\s*\S+/i,
    /^[A-Z][A-Z0-9_]{2,}\s*=\s*\S{8,}$/m,
    /[?&](?:token|key|secret|sig|signature|password|access_token|api_key)=[^&\s]{8,}/i,
  ];
  if (patterns.some((re) => re.test(t))) return true;
  for (const run of t.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  // One long unbroken token mixing character classes: a password or key, not a word, a link or a
  // path ("D:\tmp\away-test-0925\note.txt", "reports/2026-09/summary.pdf", "Report-2026.pdf").
  for (const token of t.split(/\s+/)) {
    if (/^https?:\/\//i.test(token) || /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(token) || isPathLike(token)) continue;
    const bare = token.replace(/^[("'[]+|[)"'\].,;:!?]+$/g, "");
    if (bare.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(bare) && /\d/.test(bare) && /[A-Za-z]/.test(bare)) return true;
    if (bare.length >= 8 && bare.length <= 128) {
      const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(bare)).length;
      if (classes >= 3 && /\d/.test(bare) && /[^A-Za-z0-9'-]/.test(bare) && !/^[\d:./-]+[ap]m?$/i.test(bare)) return true;
      if (classes >= 3 && /[a-z]/.test(bare) && /[A-Z]/.test(bare) && /\d/.test(bare) && bare.length >= 10 && !/^[A-Z][a-z]+\d*$/.test(bare)) return true;
    }
  }
  return false;
}

/** "I couldn't reach it." → "I couldn't reach it, sir." */
export const sir = (message: string) => message.trim().replace(/[.!]?$/, ", sir.");
