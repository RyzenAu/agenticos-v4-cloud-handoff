import { describe, expect, test } from "bun:test";
import { clockWords, core, dueWords, formatRemaining, looksSecret, norm, parseClock, parseDuration, parseNumber, resolveClock, sir, spokenNumber, sydney, sydneyToEpoch, wordsToDigits } from "./text";

// Thursday 24 Sep 2026, 10:00 in Sydney (AEST, UTC+10).
const NOW = Date.UTC(2026, 8, 24, 0, 0);

describe("utterance clean-up", () => {
  test("wake word and politeness go, case stays for core", () => {
    expect(core("Hey Jarvis, can you type Hello There")).toBe("type Hello There");
    expect(norm("Jarvis, what's 18% of 4,850, please?")).toBe("what's 18% of 4850");
    expect(norm("OK Jarvis set a timer for 10 minutes please")).toBe("set a timer for 10 minutes");
  });
  test("numbers in words", () => {
    expect(parseNumber("twenty five")).toBe(25);
    expect(parseNumber("twenty-five")).toBe(25);
    expect(parseNumber("a")).toBe(1);
    expect(parseNumber("a couple of")).toBe(2);
    expect(parseNumber("2.5")).toBe(2.5);
    expect(parseNumber("five five")).toBeNull();
    expect(parseNumber("banana")).toBeNull();
    expect(wordsToDigits("twelve times seven")).toBe("12 times 7");
    expect(spokenNumber(873)).toBe("873");
    expect(spokenNumber(15.534279)).toBe("15.53");
    expect(sir("I couldn't reach it.")).toBe("I couldn't reach it, sir.");
  });
});

describe("durations", () => {
  test("the ways he says them", () => {
    expect(parseDuration("10 minutes")).toMatchObject({ seconds: 600, phrase: "10 minutes" });
    expect(parseDuration("90 seconds")?.seconds).toBe(90);
    expect(parseDuration("an hour and a half")?.seconds).toBe(5400);
    expect(parseDuration("one and a half hours")?.seconds).toBe(5400);
    expect(parseDuration("half an hour")?.seconds).toBe(1800);
    expect(parseDuration("1 hour 30 minutes")).toMatchObject({ seconds: 5400, phrase: "1 hour 30 minutes", single: null });
    expect(parseDuration("2 hours and 15 minutes")?.seconds).toBe(8100);
    expect(parseDuration("a minute")?.seconds).toBe(60);
    expect(parseDuration("five mins")?.seconds).toBe(300);
    expect(parseDuration("a couple of minutes")?.seconds).toBe(120);
    expect(parseDuration("10 minute")?.seconds).toBe(600);
  });
  test("not durations", () => {
    expect(parseDuration("the pasta")).toBeNull();
    expect(parseDuration("minutes")).toBeNull();
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("0 minutes")).toBeNull();
    expect(parseDuration("5 minutes 5 minutes")).toBeNull();
  });
  test("time remaining", () => {
    expect(formatRemaining(252_000)).toBe("4 minutes 12 seconds");
    expect(formatRemaining(3_900_000)).toBe("1 hour 5 minutes");
    expect(formatRemaining(42_000)).toBe("42 seconds");
    expect(formatRemaining(60_000)).toBe("1 minute");
  });
});

describe("clock times", () => {
  test("settled when he says which half of the day", () => {
    expect(parseClock("7:30 pm")).toEqual({ hour: 19, minute: 30, meridiem: "pm", day: null });
    expect(parseClock("3pm")).toMatchObject({ hour: 15, minute: 0 });
    expect(parseClock("at 3 p.m.")).toMatchObject({ hour: 15 });
    expect(parseClock("12 am")).toMatchObject({ hour: 0 });
    expect(parseClock("12 pm")).toMatchObject({ hour: 12 });
    expect(parseClock("19:00")).toMatchObject({ hour: 19, meridiem: "pm" });
    expect(parseClock("1930")).toMatchObject({ hour: 19, minute: 30 });
    expect(parseClock("noon")).toMatchObject({ hour: 12, meridiem: "pm" });
    expect(parseClock("midnight")).toMatchObject({ hour: 0 });
    expect(parseClock("8 tonight")).toEqual({ hour: 20, minute: 0, meridiem: "pm", day: "today" });
    expect(parseClock("tomorrow morning at 7")).toEqual({ hour: 7, minute: 0, meridiem: "am", day: "tomorrow" });
    expect(parseClock("3 pm tomorrow")).toEqual({ hour: 15, minute: 0, meridiem: "pm", day: "tomorrow" });
    expect(parseClock("half past 7 in the evening")).toMatchObject({ hour: 19, minute: 30 });
    expect(parseClock("quarter to 8 am")).toMatchObject({ hour: 7, minute: 45 });
    expect(parseClock("seven thirty am")).toMatchObject({ hour: 7, minute: 30 });
    expect(parseClock("six oh five pm")).toMatchObject({ hour: 18, minute: 5 });
  });
  test("ambiguous stays ambiguous (the caller asks back)", () => {
    expect(parseClock("7:30")).toEqual({ hour: 7, minute: 30, meridiem: null, day: null });
    expect(parseClock("at 3")).toMatchObject({ hour: 3, meridiem: null });
  });
  test("not times", () => {
    expect(parseClock("the meeting")).toBeNull();
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("7:75")).toBeNull();
    expect(parseClock("15 am")).toBeNull();
  });
  test("Sydney wall clock, across daylight saving", () => {
    expect(sydney(NOW)).toMatchObject({ year: 2026, month: 9, day: 24, hour: 10, minute: 0, weekday: "Thursday" });
    expect(sydneyToEpoch(2026, 9, 24, 15, 0)).toBe(Date.UTC(2026, 8, 24, 5, 0));
    // 5 Oct 2026 is after DST starts (UTC+11).
    expect(sydneyToEpoch(2026, 10, 5, 9, 0)).toBe(Date.UTC(2026, 9, 4, 22, 0));
    expect(clockWords(Date.UTC(2026, 8, 24, 5, 0))).toBe("3 pm");
    expect(clockWords(Date.UTC(2026, 8, 23, 21, 30))).toBe("7:30 am");
  });
  test("resolving: later today, or tomorrow once passed", () => {
    expect(resolveClock(NOW, { hour: 15, minute: 0, meridiem: "pm", day: null })).toEqual({ at: Date.UTC(2026, 8, 24, 5, 0), tomorrow: false });
    expect(resolveClock(NOW, { hour: 9, minute: 0, meridiem: "am", day: null })).toEqual({ at: Date.UTC(2026, 8, 24, 23, 0), tomorrow: true });
    expect(resolveClock(NOW, { hour: 15, minute: 0, meridiem: "pm", day: "tomorrow" }).tomorrow).toBe(true);
    expect(dueWords(NOW, NOW + 18 * 60_000 + 30_000)).toBe("in 18 minutes");
    expect(dueWords(NOW, Date.UTC(2026, 8, 24, 5, 0))).toBe("at 3 pm");
    expect(dueWords(NOW, Date.UTC(2026, 8, 24, 23, 0))).toBe("tomorrow at 9 am");
  });
});

describe("secrets are recognised", () => {
  test("keys, tokens, passwords, cards", () => {
    for (const secret of [
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "sk_live_51Habcdefghijklmnop",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
      "password: hunter2",
      "my PIN is 4821",
      "GROQ_API_KEY=gsk_abcdefgh12345678",
      "4111 1111 1111 1111",
      "Tr0ub4dor&3xyz",
      "Bearer abcdefghijklmnop1234",
      "https://example.com/cb?access_token=abcdefghijkl1234",
    ])
      expect(looksSecret(secret)).toBe(true);
  });
  test("ordinary text is not", () => {
    for (const plain of [
      "Call Smile Dental about the Tuesday booking",
      "https://muventures.com.au/dental",
      "usman@example.com",
      "Meeting at 3:30pm with Brooke",
      "The invoice total is $4,850.00",
      "COVID-19 update",
      "",
    ])
      expect(looksSecret(plain)).toBe(false);
  });
});
