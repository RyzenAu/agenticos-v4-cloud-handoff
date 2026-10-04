// Time, dates, quick maths and unit conversions: pure, local and instant (no model). Currency is
// the one exception: it needs today's rate, fetched from a free no-key service and cached; when
// neither service answers, Jarvis says so rather than guess a rate.
import { MONTHS, WEEKDAYS, cap, clockWords, norm, ordinal, parseNumber, sir, spokenNumber, sydney, sydneyToEpoch, wordsToDigits } from "./text";

export type TimeRequest =
  | { skill: "time"; action: "now"; place?: string }
  | { skill: "time"; action: "date" }
  | { skill: "time"; action: "weekday_of"; day: number; month?: number; year?: number; past?: boolean; claimed?: number }
  | { skill: "time"; action: "find_weekday"; weekday: number; day: number }
  | { skill: "time"; action: "date_of"; weekday: number; next?: boolean };
export type MathsRequest = { skill: "maths"; action: "calc"; expr: string; said: string };
export type UnitsRequest = { skill: "units"; action: "convert"; value: number; from: string; to: string };
export type CurrencyRequest = { skill: "currency"; action: "convert"; amount: number; from: string; to: string };

// --- time and date ------------------------------------------------------------------------------
const monthIndex = (word: string) => {
  const i = MONTHS.findIndex((m) => m === word || (word.length >= 3 && m.startsWith(word)));
  return i < 0 ? null : i + 1;
};
const weekdayIndex = (word: string) => {
  const i = WEEKDAYS.findIndex((d) => d === word || (word.length >= 3 && d.startsWith(word)));
  return i < 0 ? null : i;
};
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)";

/** Parses "the 3rd", "the 3rd of October", "October 3rd", "3 October 2027". */
function dateWords(text: string): { day: number; month?: number; year?: number } | null {
  const t = text.replace(/^the /, "").trim();
  let m = t.match(new RegExp(`^${DAY}(?: of)?(?: ${MONTH_RE})?(?: (\\d{4}))?$`));
  if (m) return { day: Number(m[1]), ...(m[2] ? { month: monthIndex(m[2])! } : {}), ...(m[3] ? { year: Number(m[3]) } : {}) };
  m = t.match(new RegExp(`^${MONTH_RE}(?: the)? ${DAY}(?: (\\d{4}))?$`));
  if (m) return { day: Number(m[2]), month: monthIndex(m[1])!, ...(m[3] ? { year: Number(m[3]) } : {}) };
  if (t === "christmas" || t === "christmas day") return { day: 25, month: 12 };
  if (t === "new year's day" || t === "new years day") return { day: 1, month: 1 };
  if (t === "anzac day") return { day: 25, month: 4 };
  if (t === "australia day") return { day: 26, month: 1 };
  return null;
}

/** Places he might ask the time in, by their IANA zone (his own is Sydney). */
export const TIME_ZONES: Record<string, string> = {
  london: "Europe/London", uk: "Europe/London", england: "Europe/London", britain: "Europe/London", dublin: "Europe/Dublin", ireland: "Europe/Dublin",
  paris: "Europe/Paris", france: "Europe/Paris", berlin: "Europe/Berlin", germany: "Europe/Berlin", madrid: "Europe/Madrid", rome: "Europe/Rome", amsterdam: "Europe/Amsterdam",
  istanbul: "Europe/Istanbul", turkey: "Europe/Istanbul", moscow: "Europe/Moscow", cairo: "Africa/Cairo", egypt: "Africa/Cairo", johannesburg: "Africa/Johannesburg",
  mecca: "Asia/Riyadh", makkah: "Asia/Riyadh", medina: "Asia/Riyadh", madinah: "Asia/Riyadh", riyadh: "Asia/Riyadh", "saudi arabia": "Asia/Riyadh", saudi: "Asia/Riyadh",
  dubai: "Asia/Dubai", uae: "Asia/Dubai", "abu dhabi": "Asia/Dubai", doha: "Asia/Qatar", qatar: "Asia/Qatar",
  karachi: "Asia/Karachi", lahore: "Asia/Karachi", islamabad: "Asia/Karachi", pakistan: "Asia/Karachi", delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", mumbai: "Asia/Kolkata", india: "Asia/Kolkata",
  dhaka: "Asia/Dhaka", bangladesh: "Asia/Dhaka", bangkok: "Asia/Bangkok", jakarta: "Asia/Jakarta", "kuala lumpur": "Asia/Kuala_Lumpur", malaysia: "Asia/Kuala_Lumpur",
  singapore: "Asia/Singapore", "hong kong": "Asia/Hong_Kong", beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai", china: "Asia/Shanghai", tokyo: "Asia/Tokyo", japan: "Asia/Tokyo", seoul: "Asia/Seoul",
  perth: "Australia/Perth", adelaide: "Australia/Adelaide", darwin: "Australia/Darwin", brisbane: "Australia/Brisbane", melbourne: "Australia/Melbourne", sydney: "Australia/Sydney", canberra: "Australia/Sydney", hobart: "Australia/Hobart",
  auckland: "Pacific/Auckland", "new zealand": "Pacific/Auckland", nz: "Pacific/Auckland",
  "new york": "America/New_York", nyc: "America/New_York", toronto: "America/Toronto", chicago: "America/Chicago", denver: "America/Denver",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles", "san francisco": "America/Los_Angeles", seattle: "America/Los_Angeles", vancouver: "America/Vancouver", "sao paulo": "America/Sao_Paulo",
};
const PLACE_RE = `(${Object.keys(TIME_ZONES).sort((a, b) => b.length - a.length).join("|")})`;

export function timeIntent(utterance: string): TimeRequest | null {
  const u = norm(utterance).replace(/\bwhat's\b/g, "what is").replace(/\s+/g, " ");
  if (u.length > 80) return null;
  // "what time is it in London", "what's the time in Makkah right now"
  const at = u.match(new RegExp(`^(?:what time is it|what is the time|what time|the time|time)(?: (?:right )?now)? in (?:the )?${PLACE_RE}(?: (?:right )?now| at the moment)?$`));
  if (at) return { skill: "time", action: "now", place: at[1] };
  if (/^(?:what time is it|what is the time|tell me the time|(?:the )?time|what's the time|got the time|do you have the time)(?: (?:right )?now| please| in sydney| here)?$/.test(u)) return { skill: "time", action: "now" };
  if (/^(?:what is (?:the date|today's date|the date today|today)|what date is it(?: today)?|what day is (?:it|today)(?: today)?|what is the day today|(?:today's )?date(?: today)?|what's today)$/.test(u)) return { skill: "time", action: "date" };
  let m: RegExpMatchArray | null;
  // "what day is Friday the 3rd": which month has a Friday the 3rd next.
  if ((m = u.match(new RegExp(`^(?:what (?:day|date|month) is|when is|when's) (?:a |the next )?${WEEKDAY_RE} the ${DAY}(?: of ${MONTH_RE})?$`)))) {
    const weekday = weekdayIndex(m[1])!;
    const day = Number(m[2]);
    if (day < 1 || day > 31) return null;
    if (m[3]) return { skill: "time", action: "weekday_of", day, month: monthIndex(m[3])!, claimed: weekday };
    return { skill: "time", action: "find_weekday", weekday, day };
  }
  // "what day is the 3rd of October", "what day of the week was the 1st".
  if ((m = u.match(/^what day(?: of the week)? (is|was|will be|falls on|does) (.+?)(?: fall on| land on)?$/))) {
    const date = dateWords(m[2].replace(/ this year$/, ""));
    if (date && date.day >= 1 && date.day <= 31) return { skill: "time", action: "weekday_of", ...date, ...(m[1] === "was" ? { past: true } : {}) };
    return null;
  }
  // "what's the date on Friday", "what date is next Friday", "when is this Friday".
  if ((m = u.match(new RegExp(`^(?:what is the date|what date is|what is the date on|when is|when's)(?: on)? (this |next |the coming )?${WEEKDAY_RE}$`)))) {
    return { skill: "time", action: "date_of", weekday: weekdayIndex(m[2])!, ...(m[1]?.trim() === "next" ? { next: true } : {}) };
  }
  return null;
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const weekdayOf = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
const longDate = (day: number, month: number, year?: number, thisYear?: number) =>
  `the ${ordinal(day)} of ${cap(MONTHS[month - 1])}${year && year !== thisYear ? ` ${year}` : ""}`;

export function answerTime(req: TimeRequest, now: number): string {
  const t = sydney(now);
  if (req.action === "now") {
    const zone = req.place ? TIME_ZONES[req.place.toLowerCase()] : undefined;
    if (req.place && zone && zone !== "Australia/Sydney") {
      const clock = new Intl.DateTimeFormat("en-AU", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true, weekday: "long" }).formatToParts(new Date(now));
      const get = (type: string) => clock.find((p) => p.type === type)?.value ?? "";
      const minute = get("minute");
      const day = get("weekday");
      const sameDay = day.toLowerCase() === t.weekday.toLowerCase();
      return `It's ${get("hour")}${minute === "00" ? "" : `:${minute}`} ${get("dayPeriod").toLowerCase()} in ${cap(req.place)}${sameDay ? "" : `, ${day}`}, sir.`;
    }
    return `It's ${clockWords(now)}, sir.`;
  }
  if (req.action === "date") return `It's ${t.weekday} the ${ordinal(t.day)} of ${cap(MONTHS[t.month - 1])}, sir.`;
  if (req.action === "weekday_of") {
    let year = req.year ?? t.year;
    let month = req.month ?? t.month;
    if (!req.year) {
      // No year: the next such date (or the last one, for "was"); no month: this month or the next.
      const key = (y: number, mo: number) => y * 10000 + mo * 100 + req.day;
      const today = key(t.year, t.month);
      if (req.month) {
        if (!req.past && key(year, month) < today) year++;
        if (req.past && key(year, month) > today) year--;
      } else if (!req.past && req.day < t.day) {
        month++;
        if (month > 12) (month = 1), year++;
      } else if (req.past && req.day > t.day) {
        month--;
        if (month < 1) (month = 12), year--;
      }
    }
    if (req.day > daysIn(year, month)) return `${cap(MONTHS[month - 1])} ${year} hasn't got a ${ordinal(req.day)}, sir.`;
    const weekday = cap(WEEKDAYS[weekdayOf(year, month, req.day)]);
    const date = longDate(req.day, month, year, t.year);
    if (req.claimed !== undefined && req.claimed !== weekdayOf(year, month, req.day))
      return `${cap(date)} is a ${weekday}, sir, not a ${cap(WEEKDAYS[req.claimed])}.`;
    return `${cap(date)} ${req.past ? "was" : "is"} a ${weekday}, sir.`;
  }
  if (req.action === "find_weekday") {
    let year = t.year,
      month = t.month;
    if (req.day < t.day) month++;
    for (let i = 0; i < 36; i++, month++) {
      if (month > 12) (month = 1), year++;
      if (req.day <= daysIn(year, month) && weekdayOf(year, month, req.day) === req.weekday) {
        const isThisMonth = year === t.year && month === t.month;
        return `The next ${cap(WEEKDAYS[req.weekday])} the ${ordinal(req.day)} is ${isThisMonth ? "this month, " : ""}${longDate(req.day, month, year, t.year)}, sir.`;
      }
    }
    return "I can't find one in the next three years, sir.";
  }
  // date_of: the coming weekday (today counts as "this"); "next" names both to avoid the classic muddle.
  const todayIndex = weekdayOf(t.year, t.month, t.day);
  const ahead = (req.weekday - todayIndex + 7) % 7;
  const at = (offset: number) => sydney(sydneyToEpoch(t.year, t.month, t.day + offset, 12, 0));
  const first = at(ahead),
    second = at(ahead + 7);
  const name = cap(WEEKDAYS[req.weekday]);
  if (req.next)
    return `This coming ${name} is ${longDate(first.day, first.month, first.year, t.year)}; the one after is ${longDate(second.day, second.month, second.year, t.year)}, sir.`;
  return ahead === 0 ? `Today's ${name}, ${longDate(t.day, t.month)}, sir.` : `${name} is ${longDate(first.day, first.month, first.year, t.year)}, sir.`;
}

// --- maths --------------------------------------------------------------------------------------
/** "what's 18% of 4,850", "12 times 7", "250 plus GST", "square root of 144" → a safe expression. */
export function mathsIntent(utterance: string): MathsRequest | null {
  const u = norm(utterance).replace(/\bwhat's\b/g, "what is");
  if (u.length > 120) return null;
  const m = u.match(/^(?:what is|what does|calculate|compute|work out|how much is|what are|what do you get for|quick maths)\s+(.+?)(?:\s+(?:equal|equals|make|come to))?$/) ?? u.match(/^(-?[\d$][\d.$]*\s*(?:%|percent)\s+(?:of|off)\s+.+)$/);
  if (!m) return null;
  const said = m[1].replace(/\s+/g, " ").trim();
  let e = ` ${wordsToDigits(said)} `
    .replace(/\$/g, "")
    .replace(/(\d)\s*(?:k|thousand)\b/g, "$1*1000")
    .replace(/(\d)\s*(?:million|mil|m)\b/g, "$1*1000000")
    .replace(/(\d)\s*(?:billion|bn)\b/g, "$1*1000000000")
    .replace(/ (?:gst on|the gst on) (\S+) /g, " ($1*0.1) ")
    .replace(/ (\S+) (?:plus|with|including|inc|incl) gst /g, " ($1*1.1) ")
    .replace(/ (\S+) (?:ex|excluding|without) gst /g, " ($1/1.1) ")
    .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent) (?:off|discount on) (\S+)/g, "$2*(1-$1/100)")
    .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent) of /g, "($1/100)*")
    .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)/g, "($1/100)")
    .replace(/ (?:the )?square root of /g, " sqrt ")
    .replace(/ (?:to the power of|to the|raised to) /g, " ^ ")
    .replace(/ squared /g, " ^2 ")
    .replace(/ cubed /g, " ^3 ")
    .replace(/ (?:plus|add|and) /g, " + ")
    .replace(/ (?:minus|take away|less|subtract) /g, " - ")
    .replace(/ (?:times|multiplied by|x|×) /g, " * ")
    .replace(/ (?:divided by|over|÷|divide by) /g, " / ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^[\d.\s+\-*/^()sqrt]+$/.test(e) || !/\d/.test(e) || !/[+\-*/^]|sqrt/.test(e.replace(/^-/, ""))) return null;
  try {
    evaluate(e);
  } catch {
    return null;
  }
  return { skill: "maths", action: "calc", expr: e.slice(0, 200), said: said.slice(0, 120) };
}

/** Shunting-yard evaluator for + - * / ^ ( ) sqrt and unary minus. Throws on anything else. */
export function evaluate(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?|sqrt|[+\-*/^()]/g);
  if (!tokens || tokens.join("") !== expr.replace(/\s+/g, "")) throw new Error("Not a sum.");
  const out: number[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3, neg: 4, sqrt: 4 };
  const right = new Set(["^", "neg", "sqrt"]);
  const apply = () => {
    const op = ops.pop()!;
    if (op === "neg" || op === "sqrt") {
      const a = out.pop();
      if (a === undefined) throw new Error("Not a sum.");
      out.push(op === "neg" ? -a : Math.sqrt(a));
      return;
    }
    const b = out.pop(),
      a = out.pop();
    if (a === undefined || b === undefined) throw new Error("Not a sum.");
    out.push(op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : a ** b);
  };
  let expectValue = true;
  for (const token of tokens) {
    if (/^\d/.test(token)) {
      if (!expectValue) throw new Error("Not a sum.");
      out.push(Number(token));
      expectValue = false;
    } else if (token === "(") {
      if (!expectValue) throw new Error("Not a sum.");
      ops.push(token);
    } else if (token === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") apply();
      if (ops.pop() !== "(") throw new Error("Not a sum.");
      expectValue = false;
    } else {
      const op = token === "-" && expectValue ? "neg" : token;
      if (op === "sqrt" || op === "neg") {
        if (!expectValue) throw new Error("Not a sum.");
        ops.push(op);
        continue;
      }
      if (expectValue) throw new Error("Not a sum.");
      while (ops.length && ops[ops.length - 1] !== "(" && (prec[ops[ops.length - 1]] > prec[op] || (prec[ops[ops.length - 1]] === prec[op] && !right.has(op)))) apply();
      ops.push(op);
      expectValue = true;
    }
  }
  while (ops.length) {
    if (ops[ops.length - 1] === "(") throw new Error("Not a sum.");
    apply();
  }
  if (out.length !== 1) throw new Error("Not a sum.");
  return out[0];
}

export function answerMaths(req: MathsRequest) {
  let value: number;
  try {
    value = evaluate(req.expr);
  } catch {
    return "I couldn't make a sum of that, sir.";
  }
  if (!Number.isFinite(value)) return "That's undefined, sir: it divides by zero.";
  if (Number.isNaN(value)) return "That hasn't got a real answer, sir.";
  // Money is said in cents: "14.83", never "14.8335" (J4). Percentages, GST, discounts and dollar figures are money.
  const money = /\bgst\b|\$|\bdollars?\b|\bbucks\b|%|\bpercent\b|\bdiscount\b|\bprice\b|\bcost\b|\bprofit\b|\brevenue\b|\bsalary\b|\btax\b/i.test(req.said);
  const said = money ? value.toLocaleString("en-AU", { maximumFractionDigits: 2 }) : spokenNumber(value, 4);
  return `${req.said.replace(/\s*\?$/, "")} is ${said}, sir.`.replace(/^./, (c) => c.toUpperCase());
}

// --- units --------------------------------------------------------------------------------------
type Unit = { dim: string; factor: number; name: [string, string] };
const U = (dim: string, factor: number, one: string, many: string): Unit => ({ dim, factor, name: [one, many] });
export const UNITS: Record<string, Unit> = {
  mm: U("length", 0.001, "millimetre", "millimetres"),
  cm: U("length", 0.01, "centimetre", "centimetres"),
  m: U("length", 1, "metre", "metres"),
  km: U("length", 1000, "kilometre", "kilometres"),
  in: U("length", 0.0254, "inch", "inches"),
  ft: U("length", 0.3048, "foot", "feet"),
  yd: U("length", 0.9144, "yard", "yards"),
  mi: U("length", 1609.344, "mile", "miles"),
  nmi: U("length", 1852, "nautical mile", "nautical miles"),
  mg: U("mass", 1e-6, "milligram", "milligrams"),
  g: U("mass", 0.001, "gram", "grams"),
  kg: U("mass", 1, "kilogram", "kilograms"),
  t: U("mass", 1000, "tonne", "tonnes"),
  oz: U("mass", 0.028349523125, "ounce", "ounces"),
  lb: U("mass", 0.45359237, "pound", "pounds"),
  st: U("mass", 6.35029318, "stone", "stone"),
  ml: U("volume", 0.001, "millilitre", "millilitres"),
  l: U("volume", 1, "litre", "litres"),
  tsp: U("volume", 0.005, "teaspoon", "teaspoons"),
  tbsp: U("volume", 0.02, "tablespoon", "tablespoons"),
  cup: U("volume", 0.25, "cup", "cups"),
  floz: U("volume", 0.0295735295625, "US fluid ounce", "US fluid ounces"),
  pint: U("volume", 0.56826125, "pint", "pints"),
  gal: U("volume", 3.785411784, "US gallon", "US gallons"),
  ukgal: U("volume", 4.54609, "imperial gallon", "imperial gallons"),
  kmh: U("speed", 1 / 3.6, "kilometre an hour", "kilometres an hour"),
  mph: U("speed", 0.44704, "mile an hour", "miles an hour"),
  ms: U("speed", 1, "metre a second", "metres a second"),
  kn: U("speed", 0.514444, "knot", "knots"),
  sqm: U("area", 1, "square metre", "square metres"),
  sqft: U("area", 0.09290304, "square foot", "square feet"),
  ha: U("area", 10000, "hectare", "hectares"),
  acre: U("area", 4046.8564224, "acre", "acres"),
  sqkm: U("area", 1e6, "square kilometre", "square kilometres"),
  c: U("temp", 1, "degree Celsius", "degrees Celsius"),
  f: U("temp", 1, "degree Fahrenheit", "degrees Fahrenheit"),
  k: U("temp", 1, "kelvin", "kelvin"),
};
const UNIT_ALIASES: Array<[RegExp, string]> = [
  [/^(?:millimet(?:re|er)s?|mm)$/, "mm"],
  [/^(?:centimet(?:re|er)s?|cms?)$/, "cm"],
  [/^(?:met(?:re|er)s?|m)$/, "m"],
  [/^(?:kilomet(?:re|er)s?|kms?|k's|kays)$/, "km"],
  [/^(?:inch(?:es)?|in|")$/, "in"],
  [/^(?:foot|feet|ft)$/, "ft"],
  [/^(?:yards?|yds?)$/, "yd"],
  [/^(?:miles?|mi)$/, "mi"],
  [/^(?:nautical miles?)$/, "nmi"],
  [/^(?:milligrams?|mg)$/, "mg"],
  [/^(?:grams?|grammes?|g)$/, "g"],
  [/^(?:kilograms?|kilos?|kgs?)$/, "kg"],
  [/^(?:tonnes?|metric tons?)$/, "t"],
  [/^(?:ounces?|oz)$/, "oz"],
  [/^(?:pounds?|lbs?)$/, "lb"],
  [/^(?:stone|stones|st)$/, "st"],
  [/^(?:millilit(?:re|er)s?|mls?|mils)$/, "ml"],
  [/^(?:lit(?:re|er)s?|l)$/, "l"],
  [/^(?:teaspoons?|tsp)$/, "tsp"],
  [/^(?:tablespoons?|tbsp)$/, "tbsp"],
  [/^(?:cups?)$/, "cup"],
  [/^(?:(?:us )?fluid ounces?|fl oz)$/, "floz"],
  [/^(?:pints?)$/, "pint"],
  [/^(?:(?:us )?gallons?|gal)$/, "gal"],
  [/^(?:imperial gallons?|uk gallons?)$/, "ukgal"],
  [/^(?:km\/?h|kph|kilomet(?:re|er)s (?:an|per) hour|k's (?:an|per) hour)$/, "kmh"],
  [/^(?:mph|miles (?:an|per) hour)$/, "mph"],
  [/^(?:m\/s|met(?:re|er)s (?:a|per) second)$/, "ms"],
  [/^(?:knots?)$/, "kn"],
  [/^(?:square met(?:re|er)s?|sq m|sqm|m2)$/, "sqm"],
  [/^(?:square f(?:oo|ee)t|sq ft|sqft)$/, "sqft"],
  [/^(?:hectares?|ha)$/, "ha"],
  [/^(?:acres?)$/, "acre"],
  [/^(?:square kilomet(?:re|er)s?|sq km)$/, "sqkm"],
  [/^(?:(?:degrees? )?(?:celsius|centigrade|c)|°c)$/, "c"],
  [/^(?:(?:degrees? )?(?:fahrenheit|f)|°f)$/, "f"],
  [/^(?:kelvin|k)$/, "k"],
];
export function unitKey(word: string): string | null {
  const w = word.trim().toLowerCase().replace(/\s+/g, " ").replace(/^(?:the |a |an )/, "");
  return UNIT_ALIASES.find(([re]) => re.test(w))?.[1] ?? null;
}

// --- currency -----------------------------------------------------------------------------------
export const CURRENCIES: Record<string, [string, string]> = {
  AUD: ["Australian dollar", "Australian dollars"],
  USD: ["US dollar", "US dollars"],
  EUR: ["euro", "euros"],
  GBP: ["British pound", "British pounds"],
  NZD: ["New Zealand dollar", "New Zealand dollars"],
  CAD: ["Canadian dollar", "Canadian dollars"],
  JPY: ["yen", "yen"],
  CNY: ["yuan", "yuan"],
  INR: ["Indian rupee", "Indian rupees"],
  PKR: ["Pakistani rupee", "Pakistani rupees"],
  SGD: ["Singapore dollar", "Singapore dollars"],
  HKD: ["Hong Kong dollar", "Hong Kong dollars"],
  AED: ["UAE dirham", "UAE dirhams"],
  SAR: ["Saudi riyal", "Saudi riyals"],
  MYR: ["ringgit", "ringgit"],
  IDR: ["rupiah", "rupiah"],
  CHF: ["Swiss franc", "Swiss francs"],
  THB: ["baht", "baht"],
  PHP: ["Philippine peso", "Philippine pesos"],
  KRW: ["won", "won"],
  BDT: ["taka", "taka"],
  TRY: ["Turkish lira", "Turkish lira"],
};
const CURRENCY_ALIASES: Array<[RegExp, string]> = [
  [/^(?:aud|a\$|au\$|aussie dollars?|australian dollars?|bucks|dollars?|\$)$/, "AUD"],
  [/^(?:usd|us\$|us dollars?|american dollars?|u\.?s\.? dollars?|greenbacks?)$/, "USD"],
  [/^(?:eur|euros?|€)$/, "EUR"],
  [/^(?:gbp|british pounds?|pounds? sterling|sterling|quid|£|uk pounds?)$/, "GBP"],
  [/^(?:nzd|kiwi dollars?|new zealand dollars?|nz dollars?)$/, "NZD"],
  [/^(?:cad|canadian dollars?)$/, "CAD"],
  [/^(?:jpy|yen|japanese yen)$/, "JPY"],
  [/^(?:cny|rmb|yuan|chinese yuan|renminbi)$/, "CNY"],
  [/^(?:inr|indian rupees?)$/, "INR"],
  [/^(?:pkr|pakistani rupees?|rupees?)$/, "PKR"],
  [/^(?:sgd|singapore dollars?)$/, "SGD"],
  [/^(?:hkd|hong kong dollars?)$/, "HKD"],
  [/^(?:aed|dirhams?|uae dirhams?)$/, "AED"],
  [/^(?:sar|riyals?|saudi riyals?)$/, "SAR"],
  [/^(?:myr|ringgit|malaysian ringgit)$/, "MYR"],
  [/^(?:idr|rupiah|indonesian rupiah)$/, "IDR"],
  [/^(?:chf|swiss francs?)$/, "CHF"],
  [/^(?:thb|baht|thai baht)$/, "THB"],
  [/^(?:php|philippine pesos?)$/, "PHP"],
  [/^(?:krw|won|korean won)$/, "KRW"],
  [/^(?:bdt|taka)$/, "BDT"],
  [/^(?:try|turkish lira)$/, "TRY"],
];
export function currencyKey(word: string): string | null {
  const w = word.trim().toLowerCase().replace(/\s+/g, " ").replace(/^(?:the |in |into )/, "");
  return CURRENCY_ALIASES.find(([re]) => re.test(w))?.[1] ?? null;
}

/**
 * "convert 25 km to miles", "25 kilometres in miles", "how many feet in 3 metres", "AUD 200 in USD",
 * "how much is 50 euros in Aussie dollars". Currency when both sides are currencies ("pounds" is
 * money only next to another currency), otherwise physical units of the same kind.
 */
export function convertIntent(utterance: string): UnitsRequest | CurrencyRequest | null {
  const u = norm(utterance)
    .replace(/\bwhat's\b/g, "what is")
    .replace(/(\d)\s*(k|thousand)\b(?! ?(?:m|ms|g|gs|w|mh|m\/h|ph))/g, "$1000")
    .replace(/°\s*([cf])\b/g, " degrees $1");
  if (u.length > 120) return null;
  const NUM = "(-?[\\d.]+|[a-z]+(?: [a-z]+)?)";
  const VERB = "^(?:convert|change|what is|how much is|how many is|how much are)?\\s*";
  // Each shape gives [value, from, to]; the first whose pieces all make sense wins.
  const shapes: Array<() => [string, string, string] | null> = [
    () => {
      const m = u.match(new RegExp(`${VERB}(?:the\\s+)?([a-z$€£]{1,4}\\$?)\\s?${NUM}\\s+(?:in|to|into)\\s+(.+)$`));
      return m && currencyKey(m[1]) ? [m[2], m[1], m[3]] : null;
    },
    () => {
      const m = u.match(new RegExp(`${VERB}(\\$)?${NUM}\\s*(.+?)\\s+(?:in|to|into|in to)\\s+(.+)$`));
      return m ? [m[2], m[1] && !currencyKey(m[3]) ? "$" : m[3], m[4]] : null;
    },
    () => {
      const m = u.match(/^how many (.+?) (?:are |is )?(?:there )?in (?:a|an|one) (.+)$/);
      return m ? ["1", m[2], m[1]] : null;
    },
    () => {
      const m = u.match(new RegExp(`^how many (.+?) (?:are |is )?(?:there )?in\\s+${NUM}\\s*(.+)$`));
      return m ? [m[2], m[3], m[1]] : null;
    },
    () => {
      const m = u.match(new RegExp(`^how many (.+?) (?:is|are)\\s+${NUM}\\s*(.+)$`));
      return m ? [m[2], m[3], m[1]] : null;
    },
  ];
  for (const shape of shapes) {
    const found = shape();
    if (!found) continue;
    const [value, rawFrom, rawTo] = found;
    const to = rawTo.replace(/\?$/, "").replace(/^the /, "").trim();
    const from = rawFrom.trim();
    const amount = /^-?[\d.]+$/.test(value) ? Number(value) : parseNumber(value);
    if (amount === null || !Number.isFinite(amount)) continue;
    const fromMoney = from.startsWith("$") ? "AUD" : currencyKey(from);
    const toMoney = currencyKey(to);
    if (toMoney && (fromMoney || /^pounds?$/.test(from))) {
      const source = fromMoney ?? "GBP";
      if (source === toMoney) continue;
      return { skill: "currency", action: "convert", amount, from: source, to: toMoney };
    }
    const a = unitKey(from),
      b = unitKey(to);
    if (!a || !b || a === b || UNITS[a].dim !== UNITS[b].dim) continue;
    return { skill: "units", action: "convert", value: amount, from: a, to: b };
  }
  return null;
}

export function convertUnits(value: number, from: string, to: string) {
  const a = UNITS[from],
    b = UNITS[to];
  if (!a || !b || a.dim !== b.dim) throw new Error("Those aren't the same kind of unit.");
  if (a.dim === "temp") {
    const kelvin = from === "c" ? value + 273.15 : from === "f" ? (value - 32) * (5 / 9) + 273.15 : value;
    return to === "c" ? kelvin - 273.15 : to === "f" ? (kelvin - 273.15) * (9 / 5) + 32 : kelvin;
  }
  return (value * a.factor) / b.factor;
}

export function answerUnits(req: UnitsRequest) {
  let result: number;
  try {
    result = convertUnits(req.value, req.from, req.to);
  } catch (error) {
    return sir((error as Error).message);
  }
  const name = (key: string, n: number) => UNITS[key].name[Math.abs(n) === 1 ? 0 : 1];
  const exact = Math.abs(result - Math.round(result * 100) / 100) < 1e-9;
  return `${spokenNumber(req.value, 3)} ${name(req.from, req.value)} is ${exact ? "" : "about "}${spokenNumber(result, 2)} ${name(req.to, result)}, sir.`;
}

type RateCache = Map<string, { at: number; rates: Record<string, number>; source: string }>;
const RATE_TTL = 6 * 3600_000;

/** Today's rate from a free no-key service (open.er-api.com, then Frankfurter/ECB), cached 6 h. */
export async function fetchRate(from: string, to: string, request: typeof fetch = fetch, cache: RateCache = defaultCache, now = Date.now()) {
  const hit = cache.get(from);
  if (hit && now - hit.at < RATE_TTL && hit.rates[to]) return { rate: hit.rates[to], source: hit.source };
  const sources: Array<{ url: string; name: string; read: (data: any) => Record<string, number> | null }> = [
    { url: `https://open.er-api.com/v6/latest/${from}`, name: "open.er-api.com", read: (d) => (d?.result === "success" && d.rates ? d.rates : null) },
    { url: `https://api.frankfurter.app/latest?from=${from}`, name: "the European Central Bank", read: (d) => (d?.rates ? { ...d.rates, [from]: 1 } : null) },
  ];
  for (const source of sources) {
    try {
      const response = await request(source.url, { signal: AbortSignal.timeout(3000), headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const rates = source.read(await response.json());
      const rate = Number(rates?.[to]);
      if (!rates || !Number.isFinite(rate) || rate <= 0) continue;
      const clean: Record<string, number> = {};
      for (const [code, value] of Object.entries(rates)) if (/^[A-Z]{3}$/.test(code) && Number.isFinite(Number(value))) clean[code] = Number(value);
      cache.set(from, { at: now, rates: clean, source: source.name });
      return { rate, source: source.name };
    } catch {
      /* try the next service */
    }
  }
  return null;
}
const defaultCache: RateCache = new Map();

export async function answerCurrency(req: CurrencyRequest, request?: typeof fetch) {
  const found = await fetchRate(req.from, req.to, request);
  const name = (code: string, n: number) => (CURRENCIES[code] ?? [code, code])[n === 1 ? 0 : 1];
  if (!found) return `That needs today's exchange rate and I can't reach a rate service right now, sir, so I won't guess.`;
  const result = req.amount * found.rate;
  return `${spokenNumber(req.amount)} ${name(req.from, req.amount)} is about ${spokenNumber(result, 2)} ${name(req.to, result)} at today's rate, sir.`;
}
