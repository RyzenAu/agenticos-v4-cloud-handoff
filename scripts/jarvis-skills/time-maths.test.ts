import { describe, expect, test } from "bun:test";
import { answerCurrency, answerMaths, answerTime, answerUnits, convertIntent, convertUnits, evaluate, fetchRate, mathsIntent, timeIntent } from "./time-maths";

// Thursday 24 Sep 2026, 10:00 Sydney.
const NOW = Date.UTC(2026, 8, 24, 0, 0);

describe("time and date", () => {
  test("phrases", () => {
    expect(timeIntent("what time is it")).toEqual({ skill: "time", action: "now" });
    expect(timeIntent("Jarvis, what's the time?")).toEqual({ skill: "time", action: "now" });
    expect(timeIntent("what's the date")).toEqual({ skill: "time", action: "date" });
    expect(timeIntent("what day is it today")).toEqual({ skill: "time", action: "date" });
    expect(timeIntent("what day is Friday the 3rd")).toEqual({ skill: "time", action: "find_weekday", weekday: 5, day: 3 });
    expect(timeIntent("what day is the 3rd of October")).toEqual({ skill: "time", action: "weekday_of", day: 3, month: 10 });
    expect(timeIntent("what day of the week was the 1st")).toEqual({ skill: "time", action: "weekday_of", day: 1, past: true });
    expect(timeIntent("what day is Christmas")).toEqual({ skill: "time", action: "weekday_of", day: 25, month: 12 });
    expect(timeIntent("what's the date on Friday")).toEqual({ skill: "time", action: "date_of", weekday: 5 });
    expect(timeIntent("what date is next Friday")).toEqual({ skill: "time", action: "date_of", weekday: 5, next: true });
  });
  test("not time questions", () => {
    // A named city is a time zone now (25 Sep): London is Europe/London.
    expect(timeIntent("what's the time in London")).toEqual({ skill: "time", action: "now", place: "london" });
    expect(timeIntent("what time is it in Makkah")).toEqual({ skill: "time", action: "now", place: "makkah" });
    expect(timeIntent("what time is it in Narnia")).toBeNull();
    for (const phrase of ["what's the date of the meeting with Brooke", "when is my next meeting", "what day works for Brooke", "time to go", "what's on Friday"])
      expect(timeIntent(phrase)).toBeNull();
  });
  test("answers in Sydney time", () => {
    expect(answerTime({ skill: "time", action: "now" }, NOW)).toBe("It's 10 am, sir.");
    expect(answerTime({ skill: "time", action: "date" }, NOW)).toBe("It's Thursday the 24th of September, sir.");
    expect(answerTime({ skill: "time", action: "weekday_of", day: 3, month: 10 }, NOW)).toBe("The 3rd of October is a Saturday, sir.");
    expect(answerTime({ skill: "time", action: "weekday_of", day: 3, month: 10, claimed: 5 }, NOW)).toBe("The 3rd of October is a Saturday, sir, not a Friday.");
    // The 3rd has passed this month, so "the 3rd" means October's.
    expect(answerTime({ skill: "time", action: "weekday_of", day: 3 }, NOW)).toBe("The 3rd of October is a Saturday, sir.");
    expect(answerTime({ skill: "time", action: "weekday_of", day: 1, past: true }, NOW)).toBe("The 1st of September was a Tuesday, sir.");
    expect(answerTime({ skill: "time", action: "weekday_of", day: 31, month: 11 }, NOW)).toBe("November 2026 hasn't got a 31st, sir.");
    expect(answerTime({ skill: "time", action: "find_weekday", weekday: 5, day: 3 }, NOW)).toBe("The next Friday the 3rd is the 3rd of September 2027, sir.");
    expect(answerTime({ skill: "time", action: "date_of", weekday: 5 }, NOW)).toBe("Friday is the 25th of September, sir.");
    expect(answerTime({ skill: "time", action: "date_of", weekday: 4 }, NOW)).toBe("Today's Thursday, the 24th of September, sir.");
    expect(answerTime({ skill: "time", action: "date_of", weekday: 5, next: true }, NOW)).toBe("This coming Friday is the 25th of September; the one after is the 2nd of October, sir.");
  });
});

describe("quick maths", () => {
  test("phrases become safe expressions", () => {
    expect(mathsIntent("what's 18% of 4,850")).toEqual({ skill: "maths", action: "calc", expr: "(18/100)*4850", said: "18% of 4850" });
    expect(mathsIntent("what is 12 times 7")).toMatchObject({ expr: "12 * 7" });
    expect(mathsIntent("what's twelve times seven")).toMatchObject({ expr: "12 * 7" });
    expect(mathsIntent("what's 200 plus GST")).toMatchObject({ expr: "(200*1.1)" });
    expect(mathsIntent("what's the square root of 144")).toMatchObject({ expr: "sqrt 144" });
    expect(mathsIntent("15% off 80")).toMatchObject({ expr: "80*(1-15/100)" });
    expect(mathsIntent("calculate 2 to the power of 10")).toMatchObject({ expr: "2 ^ 10" });
  });
  test("not maths", () => {
    for (const phrase of ["what is love", "what's the weather", "what is 5", "calculate my taxes", "what is the plan for today", "how much is the dental package", "what's 2 and a half hours"])
      expect(mathsIntent(phrase)).toBeNull();
  });
  test("the evaluator", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluate("-3 + 5")).toBe(2);
    expect(evaluate("sqrt 144")).toBe(12);
    expect(() => evaluate("2 +")).toThrow();
    expect(() => evaluate("2 3")).toThrow();
    expect(() => evaluate("process.exit()")).toThrow();
  });
  test("answers", () => {
    expect(answerMaths({ skill: "maths", action: "calc", expr: "(18/100)*4850", said: "18% of 4850" })).toBe("18% of 4850 is 873, sir.");
    expect(answerMaths({ skill: "maths", action: "calc", expr: "100 / 8", said: "100 divided by 8" })).toBe("100 divided by 8 is 12.5, sir.");
    expect(answerMaths({ skill: "maths", action: "calc", expr: "1 / 0", said: "1 over 0" })).toBe("That's undefined, sir: it divides by zero.");
  });
});

describe("units", () => {
  test("phrases", () => {
    expect(convertIntent("convert 25 km to miles")).toEqual({ skill: "units", action: "convert", value: 25, from: "km", to: "mi" });
    expect(convertIntent("how many feet in 3 metres")).toEqual({ skill: "units", action: "convert", value: 3, from: "m", to: "ft" });
    expect(convertIntent("how many cups in a litre")).toEqual({ skill: "units", action: "convert", value: 1, from: "l", to: "cup" });
    expect(convertIntent("30 degrees celsius in fahrenheit")).toMatchObject({ from: "c", to: "f" });
    expect(convertIntent("what's 70 kg in pounds")).toMatchObject({ from: "kg", to: "lb" });
    expect(convertIntent("100 km/h in mph")).toMatchObject({ from: "kmh", to: "mph" });
  });
  test("not conversions", () => {
    for (const phrase of ["convert this to PDF", "convert the lead", "25 km", "how many leads do I have", "how many emails today", "change to dark mode", "25 km in kilograms"])
      expect(convertIntent(phrase)).toBeNull();
  });
  test("maths is right", () => {
    expect(convertUnits(25, "km", "mi")).toBeCloseTo(15.534, 3);
    expect(convertUnits(30, "c", "f")).toBeCloseTo(86, 6);
    expect(convertUnits(0, "c", "k")).toBeCloseTo(273.15, 6);
    expect(() => convertUnits(1, "km", "kg")).toThrow();
    expect(answerUnits({ skill: "units", action: "convert", value: 25, from: "km", to: "mi" })).toBe("25 kilometres is about 15.53 miles, sir.");
    expect(answerUnits({ skill: "units", action: "convert", value: 1, from: "km", to: "m" })).toBe("1 kilometre is 1,000 metres, sir.");
  });
});

describe("currency", () => {
  test("phrases", () => {
    expect(convertIntent("AUD 200 in USD")).toEqual({ skill: "currency", action: "convert", amount: 200, from: "AUD", to: "USD" });
    expect(convertIntent("$200 in USD")).toMatchObject({ from: "AUD", to: "USD" });
    expect(convertIntent("convert 50 euros to Aussie dollars")).toMatchObject({ amount: 50, from: "EUR", to: "AUD" });
    expect(convertIntent("200 pounds in AUD")).toMatchObject({ from: "GBP", to: "AUD" });
    expect(convertIntent("how much is 1000 rupees in AUD")).toMatchObject({ from: "PKR" });
    expect(convertIntent("AUD 200 in AUD")).toBeNull();
  });
  test("live rate when a service answers, an honest no when none does", async () => {
    const calls: string[] = [];
    const ok = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ result: "success", rates: { USD: 0.656, AUD: 1 } }));
    }) as unknown as typeof fetch;
    expect(await answerCurrency({ skill: "currency", action: "convert", amount: 200, from: "AUD", to: "USD" }, ok)).toBe("200 Australian dollars is about 131.2 US dollars at today's rate, sir.");
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await answerCurrency({ skill: "currency", action: "convert", amount: 5, from: "NZD", to: "JPY" }, down)).toContain("I won't guess");
    // Falls back to the second service, and caches.
    const cache = new Map();
    const second = (async (url: string) =>
      url.includes("er-api") ? new Response("nope", { status: 500 }) : new Response(JSON.stringify({ rates: { EUR: 0.6 } }))) as unknown as typeof fetch;
    expect(await fetchRate("AUD", "EUR", second, cache, 0)).toEqual({ rate: 0.6, source: "the European Central Bank" });
    expect(await fetchRate("AUD", "EUR", down, cache, 1000)).toEqual({ rate: 0.6, source: "the European Central Bank" });
  });
});
