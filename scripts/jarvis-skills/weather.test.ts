import { describe, expect, test } from "bun:test";
import { answerWeather, weatherIntent } from "./weather";

describe("weather phrases", () => {
  test("current conditions, no city named", () => {
    for (const phrase of ["what's the weather", "what's the weather like", "how's the weather", "what's it like outside", "how hot is it", "how cold is it", "what's the temperature"]) {
      const req = weatherIntent(phrase);
      expect(req).toMatchObject({ skill: "weather", focus: "conditions", when: "now" });
      expect(req?.city).toBeUndefined();
    }
  });
  test("a named city and a day", () => {
    expect(weatherIntent("how hot is it in Melbourne tomorrow")).toMatchObject({ focus: "conditions", when: "tomorrow", city: "melbourne" });
    expect(weatherIntent("what's the weather like in Sydney")).toMatchObject({ focus: "conditions", when: "now", city: "sydney" });
    expect(weatherIntent("what's the forecast today")).toMatchObject({ focus: "conditions", when: "today" });
  });
  test("rain questions default to today", () => {
    for (const phrase of ["is it going to rain", "will it rain", "is it going to rain today", "do I need an umbrella", "chance of rain"])
      expect(weatherIntent(phrase)).toMatchObject({ focus: "rain", when: "today" });
    expect(weatherIntent("is it going to rain tomorrow")).toMatchObject({ focus: "rain", when: "tomorrow" });
    expect(weatherIntent("will it rain in Perth tomorrow")).toMatchObject({ focus: "rain", when: "tomorrow", city: "perth" });
  });
  test("not weather questions", () => {
    for (const phrase of ["what's the time", "set a timer for weather", "how are you", "open weather app", ""]) expect(weatherIntent(phrase)).toBeNull();
  });
});

const forecast = (over: Partial<{ tempNow: number; apparent: number; code: number; isDay: 0 | 1; highToday: number; lowToday: number; rainToday: number; highTomorrow: number; lowTomorrow: number; rainTomorrow: number }> = {}) => ({
  current: { temperature_2m: over.tempNow ?? 18, apparent_temperature: over.apparent ?? 17, weather_code: over.code ?? 0, is_day: over.isDay ?? 1 },
  daily: {
    temperature_2m_max: [over.highToday ?? 22, over.highTomorrow ?? 24],
    temperature_2m_min: [over.lowToday ?? 12, over.lowTomorrow ?? 13],
    precipitation_probability_max: [over.rainToday ?? 10, over.rainTomorrow ?? 80],
  },
});

describe("answers", () => {
  const fetchWith = (raw: unknown) => (async (url: string) => {
    if (url.includes("geocoding-api")) return Response.json({ results: [{ name: new URL(url).searchParams.get("name"), latitude: -37.8, longitude: 144.9 }] });
    return Response.json(raw);
  }) as typeof fetch;

  test("current, city from the dashboard's own resolver", async () => {
    const said = await answerWeather({ skill: "weather", action: "report", focus: "conditions", when: "now" }, {
      fetch: fetchWith(forecast({ tempNow: 21, apparent: 20, code: 0 })),
      city: () => ({ name: "Sydney", source: "profile" }),
    });
    expect(said).toBe("Clear, 21° right now, feels like 20°.");
  });

  test("today asks for high/low and mentions rain only above 30%", async () => {
    const said = await answerWeather({ skill: "weather", action: "report", focus: "conditions", when: "today" }, {
      fetch: fetchWith(forecast({ tempNow: 15, code: 61, highToday: 18, lowToday: 10, rainToday: 70 })),
      city: () => ({ name: "Melbourne", source: "profile" }),
    });
    expect(said).toBe("Rain, 15° now, heading to 18° with a low of 10°, 70% chance of rain.");
  });

  test("tomorrow, named city", async () => {
    const said = await answerWeather({ skill: "weather", action: "report", focus: "conditions", when: "tomorrow", city: "Perth" }, {
      fetch: fetchWith(forecast({ code: 2, highTomorrow: 26, lowTomorrow: 15, rainTomorrow: 5 })),
    });
    expect(said).toBe("Tomorrow in Perth: partly cloudy, 15° to 26°.");
  });

  test("rain focus, low/medium/high phrasing", async () => {
    const low = await answerWeather({ skill: "weather", action: "report", focus: "rain", when: "today" }, { fetch: fetchWith(forecast({ rainToday: 5 })), city: () => ({ name: "Sydney", source: "profile" }) });
    expect(low).toBe("Unlikely today — 5% chance.");
    const mid = await answerWeather({ skill: "weather", action: "report", focus: "rain", when: "today" }, { fetch: fetchWith(forecast({ rainToday: 40 })), city: () => ({ name: "Sydney", source: "profile" }) });
    expect(mid).toBe("Maybe today — 40% chance, worth a coat.");
    const high = await answerWeather({ skill: "weather", action: "report", focus: "rain", when: "tomorrow", city: "Brisbane" }, { fetch: fetchWith(forecast({ rainTomorrow: 90 })) });
    expect(high).toBe("Yes in Brisbane, tomorrow — 90% chance of rain.");
  });

  test("no city anywhere throws, which the dispatcher turns into a spoken apology", async () => {
    const saved = { city: process.env.AGENTIC_WEATHER_CITY, lat: process.env.AGENTIC_WEATHER_LATITUDE, lon: process.env.AGENTIC_WEATHER_LONGITUDE };
    delete process.env.AGENTIC_WEATHER_CITY; delete process.env.AGENTIC_WEATHER_LATITUDE; delete process.env.AGENTIC_WEATHER_LONGITUDE;
    try {
      await expect(answerWeather({ skill: "weather", action: "report", focus: "conditions", when: "now" }, { fetch: fetchWith(forecast()), city: () => undefined })).rejects.toThrow("I don't have a city set for weather");
    } finally {
      if (saved.city !== undefined) process.env.AGENTIC_WEATHER_CITY = saved.city; else delete process.env.AGENTIC_WEATHER_CITY;
      if (saved.lat !== undefined) process.env.AGENTIC_WEATHER_LATITUDE = saved.lat; else delete process.env.AGENTIC_WEATHER_LATITUDE;
      if (saved.lon !== undefined) process.env.AGENTIC_WEATHER_LONGITUDE = saved.lon; else delete process.env.AGENTIC_WEATHER_LONGITUDE;
    }
  });
});
