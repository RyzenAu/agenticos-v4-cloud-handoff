// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { parseCalendarDraft } from "./chat-calendar";
import { calendarAddIn, calendarDraftFromWords, composeEmail, emailDraftIn, isCalendarAdd, titleFrom } from "./spoken-requests";
import { clockHour, instantOf, parseWhen, sydneyInstant, sydneyParts, whenSaid } from "./sydney-when";

// Reconciliation recommendation 3 (R7): the pure Sydney date and email-draft parser, ported from Dot's historical branch (see the file headers for the
// licence check). Everything is a function of `now`; the machine's own clock and zone never matter. "Now" is Tue 29 Sep 2026, 12:00 in Sydney (AEST).
const NOW = new Date("2026-09-29T02:00:00.000Z");
const ymd = (d: { y: number; mo: number; d: number } | null) => (d ? `${d.y}-${String(d.mo).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : null);
const hm = (t: { h: number; mi: number } | null) => (t ? `${String(t.h).padStart(2, "0")}:${String(t.mi).padStart(2, "0")}` : null);

describe("Sydney wall-clock time", () => {
  test("parts are read in Sydney whatever the instant", () => {
    expect(sydneyParts(NOW)).toMatchObject({ y: 2026, mo: 9, d: 29, h: 12, mi: 0, wd: 2 });
    expect(sydneyParts(new Date("2026-09-29T14:30:00Z"))).toMatchObject({ d: 30, h: 0, mi: 30 }); // already tomorrow in Sydney
  });

  test("the instant of a Sydney time is right either side of both clock changes (first Sunday of October and of April)", () => {
    const at = (y: number, mo: number, d: number, h: number) => sydneyInstant({ y, mo, d }, { h, mi: 0 }).toISOString();
    expect(at(2026, 10, 3, 15)).toBe("2026-10-03T05:00:00.000Z"); // Saturday, AEST +10
    expect(at(2026, 10, 5, 15)).toBe("2026-10-05T04:00:00.000Z"); // Monday after the change, AEDT +11
    expect(at(2026, 4, 4, 15)).toBe("2026-04-04T04:00:00.000Z"); // Saturday, AEDT +11
    expect(at(2026, 4, 6, 15)).toBe("2026-04-06T05:00:00.000Z"); // Monday after it ends, AEST +10
    expect(at(2026, 10, 4, 12)).toBe("2026-10-04T01:00:00.000Z"); // the day of the change, after 3 am: AEDT
  });

  test("twelve-hour words: no am/pm means 1 to 6 is the afternoon, 7 to 11 the morning", () => {
    expect([clockHour(3, null), clockHour(9, null), clockHour(12, null), clockHour(15, null), clockHour(12, "am"), clockHour(12, "pm"), clockHour(3, "am")]).toEqual([15, 9, 12, 15, 0, 12, 3]);
  });
});

describe("parseWhen", () => {
  test("tomorrow at 3, today, the day after tomorrow", () => {
    const a = parseWhen("meeting with Mehroz tomorrow at 3", NOW);
    expect([ymd(a.day), hm(a.time), a.rest]).toEqual(["2026-09-30", "15:00", "meeting with Mehroz"]);
    expect(ymd(parseWhen("lunch today at noon", NOW).day)).toBe("2026-09-29");
    expect(hm(parseWhen("lunch today at noon", NOW).time)).toBe("12:00");
    expect(ymd(parseWhen("the day after tomorrow", NOW).day)).toBe("2026-10-01");
  });

  test("weekdays: a bare or 'this' weekday is the coming one; 'next' is the Monday-to-Sunday week after", () => {
    expect(ymd(parseWhen("on friday", NOW).day)).toBe("2026-10-02");
    expect(ymd(parseWhen("this friday", NOW).day)).toBe("2026-10-02");
    expect(ymd(parseWhen("next friday", NOW).day)).toBe("2026-10-09");
    expect(ymd(parseWhen("tuesday", NOW).day)).toBe("2026-09-29"); // today included
    expect(ymd(parseWhen("next tuesday", NOW).day)).toBe("2026-10-06");
  });

  test("dates are day before month: 3/10 is 3 October; a date already gone this year is next year", () => {
    expect(ymd(parseWhen("on 3/10", NOW).day)).toBe("2026-10-03");
    expect(ymd(parseWhen("3 October", NOW).day)).toBe("2026-10-03");
    expect(ymd(parseWhen("October 3rd", NOW).day)).toBe("2026-10-03");
    expect(ymd(parseWhen("the 3rd of October 2027", NOW).day)).toBe("2027-10-03");
    expect(ymd(parseWhen("1 March", NOW).day)).toBe("2027-03-01");
    expect(ymd(parseWhen("31/2", NOW).day)).toBeNull(); // not a date
    expect(ymd(parseWhen("the 12th", NOW).day)).toBe("2026-10-12");
  });

  test("times", () => {
    const t = (s: string) => hm(parseWhen(s, NOW).time);
    expect([t("at 3:30pm"), t("at 9am"), t("half past 3"), t("quarter to 4"), t("15:45"), t("midnight"), t("at 10 in the morning"), t("at 7 in the evening")]).toEqual(["15:30", "09:00", "15:30", "15:45", "15:45", "00:00", "10:00", "19:00"]);
    expect(t("tonight")).toBe("19:00");
    expect(t("nothing about time")).toBeNull();
  });

  test("durations are taken out first so they are not read as times; in 2 hours is relative", () => {
    expect(parseWhen("call for an hour tomorrow at 2", NOW)).toMatchObject({ durationMin: 60 });
    expect(parseWhen("workshop for 45 minutes", NOW).durationMin).toBe(45);
    expect(parseWhen("sync for half an hour", NOW).durationMin).toBe(30);
    expect(parseWhen("block for 2 hours", NOW).durationMin).toBe(120);
    expect(parseWhen("a meeting for 1 minute", NOW).durationMin).toBeNull(); // under five minutes is not a meeting
    expect(parseWhen("ring the plumber in 2 hours", NOW).relative?.toISOString()).toBe("2026-09-29T04:00:00.000Z");
  });

  test("whenSaid reads it back the way the owner says it", () => {
    expect(whenSaid(instantOf({ y: 2026, mo: 9, d: 30 }, { h: 15, mi: 0 }), NOW)).toBe("tomorrow 3:00 pm");
    expect(whenSaid(instantOf({ y: 2026, mo: 9, d: 29 }, { h: 9, mi: 30 }), NOW)).toBe("today 9:30 am");
    expect(whenSaid(instantOf({ y: 2026, mo: 10, d: 2 }, { h: 15, mi: 0 }), NOW)).toMatch(/Fri.*2.*, 3:00 pm$/);
  });
});

describe("email drafts (a draft, never a send)", () => {
  test("the asks that mean a draft, and what the clause is", () => {
    expect(emailDraftIn("draft an email to Brooke saying the site preview is ready")).toEqual({ toName: "Brooke", kind: "saying", clause: "the site preview is ready" });
    expect(emailDraftIn("Jarvis, please write a quick message to Mehroz telling him that the deposit landed.")).toMatchObject({ toName: "Mehroz", kind: "saying", clause: "the deposit landed" });
    expect(emailDraftIn("email Brooke about the Parramatta quote")).toMatchObject({ toName: "Brooke", kind: "about", clause: "the Parramatta quote" });
  });

  test("words that are not a draft ask, or have no real recipient, are not one", () => {
    expect(emailDraftIn("draft an email to me saying hello")).toBeNull();
    expect(emailDraftIn("draft an email to everyone saying hello")).toBeNull();
    expect(emailDraftIn("what is the weather")).toBeNull();
    expect(emailDraftIn("draft an email")).toBeNull();
  });

  test("the body adds nothing that was not said", () => {
    const mail = composeEmail({ toName: "Brooke Smith", kind: "saying", clause: "the site preview is ready" }, "Usman");
    expect(mail.subject).toBe("The site preview is ready");
    expect(mail.body).toBe("Hi Brooke,\n\nThe site preview is ready.\n\nKind regards,\nUsman");
    expect(composeEmail({ toName: "Brooke", kind: "about", clause: "the quote" }, "Usman").body).toContain("I'm getting in touch about the quote.");
    expect(composeEmail({ toName: "B", kind: "saying", clause: "x".repeat(200) }, "U").subject.length).toBeLessThanOrEqual(61);
  });
});

describe("calendar asks", () => {
  test("it must name the calendar, so booking a table or adding a lead is never one", () => {
    expect(isCalendarAdd("add a meeting with Mehroz tomorrow at 3 to my calendar")).toBe(true);
    expect(isCalendarAdd("book a table for two tomorrow")).toBe(false);
    expect(isCalendarAdd("add a lead called Vet Group")).toBe(false);
    expect(calendarAddIn("book a table for two tomorrow", NOW)).toBeNull();
  });

  test("title, day, time, duration and destination", () => {
    const a = calendarAddIn("add a meeting with mehroz tomorrow at 3 for an hour to my Google Calendar", NOW)!;
    expect(a.title).toBe("Meeting with Mehroz");
    expect([ymd(a.day), hm(a.time), a.durationMin, a.destination]).toEqual(["2026-09-30", "15:00", 60, "google"]);
    expect(calendarAddIn("schedule the dental review on friday at 10am in my calendar", NOW)).toMatchObject({ title: "Dental review", destination: null });
  });

  test("titleFrom strips the glue and names a person after 'with'", () => {
    expect(titleFrom("a meeting with mehroz on")).toBe("Meeting with Mehroz");
    expect(titleFrom("the event called Site review")).toBe("Site review");
    expect(titleFrom("a new event")).toBeNull();
    expect(titleFrom("meeting with the team")).toBe("Meeting with the team");
  });
});

describe("into the existing review card", () => {
  test("a full ask is the draft the card already takes, with no model: the card's own parser accepts it", () => {
    const d = calendarDraftFromWords("add a meeting with Mehroz tomorrow at 3 to my calendar", NOW);
    expect(d).toEqual({ title: "Meeting with Mehroz", start: "2026-09-30T05:00:00.000Z", end: "2026-09-30T06:00:00.000Z", location: "", attendees: [] });
    expect(parseCalendarDraft(JSON.stringify(d))).toMatchObject({ title: "Meeting with Mehroz", start: "2026-09-30T05:00:00.000Z" });
  });

  test("a duration is honoured; a relative time is relative", () => {
    const d = calendarDraftFromWords("put a standup on my calendar tomorrow at 9am for 30 minutes", NOW) as { start: string; end: string };
    expect(Date.parse(d.end) - Date.parse(d.start)).toBe(30 * 60_000);
  });

  test("anything missing is one question, never a guess; not a calendar ask is null", () => {
    expect(calendarDraftFromWords("add a meeting with Mehroz tomorrow to my calendar", NOW)).toEqual({ question: "What time?" });
    expect(calendarDraftFromWords("add a meeting with Mehroz at 3 to my calendar", NOW)).toEqual({ question: "Which day?" });
    expect(calendarDraftFromWords("add a meeting with Mehroz to my calendar", NOW)).toEqual({ question: "What day and time?" });
    expect(calendarDraftFromWords("add an event tomorrow at 3 to my calendar", NOW)).toEqual({ question: "What should the event be called?" });
    expect(calendarDraftFromWords("what is on my calendar", NOW)).toBeNull();
  });

  test("the sydney day is the owner's day even when the machine's clock is elsewhere: just after midnight in Sydney it is already tomorrow", () => {
    const lateUtc = new Date("2026-09-29T14:30:00Z"); // 00:30 Wed 30 Sep in Sydney
    const d = calendarDraftFromWords("add a meeting tomorrow at 3 to my calendar", lateUtc) as { start: string };
    expect(d.start).toBe("2026-10-01T05:00:00.000Z");
  });
});
