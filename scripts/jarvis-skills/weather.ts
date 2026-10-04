// Weather: current conditions, today's high/low and "will it rain today/tomorrow". Reuses the
// dashboard's own Open-Meteo plumbing (scripts/business-today.ts) — no new keys, no new feed.
// Default city is whatever the dashboard's daily brief uses (profile city, then time zone, then
// the AGENTIC_WEATHER_* environment fallback); a named city goes through the same geocoder.
//
// Persona: dry and brief, "sir" rarely — only the dispatcher's automatic error suffix uses it
// (see jarvis-skills/index.ts's run(), which appends ", sir." to a thrown error's message).
import { norm } from "./text";
import { configuredWeather, geocodeUrl, json, parseGeocode, weatherCondition, weatherUrl, type WeatherCity, type WeatherLocation } from "../business-today";

export type WeatherRequest = { skill: "weather"; action: "report"; focus: "conditions" | "rain"; when: "now" | "today" | "tomorrow"; city?: string };
export type WeatherDeps = { fetch?: typeof fetch; city?: () => WeatherCity | undefined };

const RAIN_PATTERNS = [
  /^(?:is|will) it (?:going to |gonna )?rain(?:ing)?(?: at all)?\??$/,
  /^will it be raining\??$/,
  /^is there (?:a chance of |going to be )?rain\??$/,
  /^(?:what's|what is) the chance of rain\??$/,
  /^chance of rain\??$/,
  /^do i need (?:an|my) umbrella\??$/,
  /^should i (?:take|bring|carry) (?:an|my) umbrella\??$/,
];
const CONDITIONS_PATTERNS = [
  /^what(?:'s| is) the weather(?: like)?(?: outside)?\??$/,
  /^how(?:'s| is) the weather\??$/,
  /^what(?:'s| is) it like outside\??$/,
  /^how (?:hot|cold|warm) is it(?: outside)?\??$/,
  /^what(?:'s| is) the temperature\??$/,
  /^what(?:'s| is) the (?:weather )?forecast\??$/,
  /^what(?:'s| is) the high\??$/,
  /^what(?:'s| is) the low\??$/,
];

/** Pulls "tomorrow"/"today"/"now" off the end and reports which one it found. */
function stripTemporal(u: string): { rest: string; when: WeatherRequest["when"] } {
  let when: WeatherRequest["when"] = "now";
  let t = u;
  if (/\btomorrow\b/.test(t)) {
    when = "tomorrow";
    t = t.replace(/\btomorrow\b/g, "");
  } else if (/\btoday\b/.test(t)) {
    when = "today";
    t = t.replace(/\btoday\b/g, "");
  }
  // norm() already drops a bare trailing "now"; this also catches "right now" and the "right" it leaves behind.
  t = t.replace(/\bright now\b/g, "").replace(/\bnow\b/g, "").replace(/\bright$/, "");
  return { rest: t.replace(/\s+/g, " ").trim(), when };
}

/** "... in melbourne" at the end → the rest of the question plus the named city. */
function extractCity(t: string): { rest: string; city?: string } {
  const m = t.match(/^(.*?)\bin ([a-z][a-z .'-]{1,40})$/);
  if (!m) return { rest: t };
  const city = m[2].trim();
  return city ? { rest: m[1].trim(), city } : { rest: t };
}

export function weatherIntent(utterance: string): WeatherRequest | null {
  const u = norm(utterance).replace(/\bwhat's\b/g, "what is").replace(/\bhow's\b/g, "how is");
  if (!u || u.length > 100) return null;
  const { rest: withoutTime, when } = stripTemporal(u);
  const { rest, city } = extractCity(withoutTime);
  if (!rest) return null;
  const isRain = /\b(rain|raining|showers?|umbrella)\b/.test(rest);
  if (isRain && RAIN_PATTERNS.some((re) => re.test(rest)))
    return { skill: "weather", action: "report", focus: "rain", when: when === "now" ? "today" : when, ...(city ? { city } : {}) };
  if (!isRain && CONDITIONS_PATTERNS.some((re) => re.test(rest)))
    return { skill: "weather", action: "report", focus: "conditions", when, ...(city ? { city } : {}) };
  return null;
}

async function resolveLocation(req: WeatherRequest, deps: WeatherDeps, request: typeof fetch): Promise<{ location: WeatherLocation; label: string }> {
  const configured = configuredWeather();
  if (req.city) {
    const found = parseGeocode(await json(geocodeUrl(req.city), request), req.city);
    return { location: found, label: found.name };
  }
  const chosen = deps.city?.();
  const name = chosen?.name?.trim();
  if (name) {
    if (configured && configured.name.toLowerCase() === name.toLowerCase()) return { location: configured, label: configured.name };
    const found = parseGeocode(await json(geocodeUrl(name.split(",")[0].trim() || name), request), name);
    return { location: found, label: found.name };
  }
  if (configured) return { location: configured, label: configured.name };
  throw new Error("I don't have a city set for weather. Try naming one");
}

const round = (n: number) => Math.round(n);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export async function answerWeather(req: WeatherRequest, deps: WeatherDeps = {}): Promise<string> {
  const request = deps.fetch ?? fetch;
  const { location, label } = await resolveLocation(req, deps, request);
  const raw = await json(weatherUrl(location, 2), request);
  const c = raw?.current, d = raw?.daily;
  const idx = req.when === "tomorrow" ? 1 : 0;
  if (!c || !d || ![c.temperature_2m, c.apparent_temperature, c.weather_code, d.temperature_2m_max?.[idx], d.temperature_2m_min?.[idx]].every(finite) || ![0, 1].includes(c.is_day))
    throw new Error("The forecast didn't come through cleanly");
  const rainChance = finite(d.precipitation_probability_max?.[idx]) ? round(d.precipitation_probability_max[idx]) : undefined;
  const high = round(d.temperature_2m_max[idx]), low = round(d.temperature_2m_min[idx]);
  const cityBit = req.city ? ` in ${label}` : "";
  const dayWord = req.when === "tomorrow" ? "tomorrow" : "today";

  if (req.focus === "rain") {
    if (rainChance === undefined) return "Can't say — the forecast didn't come through cleanly.";
    if (rainChance < 20) return `Unlikely${cityBit} ${dayWord} — ${rainChance}% chance.`;
    if (rainChance < 60) return `Maybe${cityBit} ${dayWord} — ${rainChance}% chance, worth a coat.`;
    return `Yes${cityBit}, ${dayWord} — ${rainChance}% chance of rain.`;
  }

  const cond = weatherCondition(c.weather_code, c.is_day === 1);
  const rainBit = rainChance !== undefined && rainChance >= 30 ? `, ${rainChance}% chance of rain` : "";
  if (req.when === "tomorrow") return `Tomorrow${cityBit}: ${cond.label.toLowerCase()}, ${low}° to ${high}°${rainBit}.`;
  if (req.when === "today") return `${cond.label}${cityBit}, ${round(c.temperature_2m)}° now, heading to ${high}° with a low of ${low}°${rainBit}.`;
  return `${cond.label}${cityBit}, ${round(c.temperature_2m)}° right now, feels like ${round(c.apparent_temperature)}°.`;
}
