import { describe, expect, test } from "bun:test";
import { callingWindowStatus, sydneyWallToUtc } from "../workspace/calling-window";
import { addBusinessMinutes, isOverdue, startClock } from "./clock";

// All fixture dates are in Nov 2026 — a plain working week with no NSW/national public holiday,
// verified against outreach.ts's own NATIONAL_HOLIDAYS/NSW_PUBLIC_HOLIDAYS sets. Tue 17 Nov 2026,
// Fri 20 Nov 2026, Sat 21 Nov 2026, Sun 22 Nov 2026, Mon 23 Nov 2026.

describe("speed-to-lead: addBusinessMinutes", () => {
  test("stays within an open window untouched", () => {
    const start = sydneyWallToUtc(2026, 11, 17, 10 * 60); // Tue 10:00 am
    expect(callingWindowStatus(start).open).toBe(true);
    const after = addBusinessMinutes(start, 30);
    expect(after.getTime()).toBe(start.getTime() + 30 * 60_000);
  });

  test("rolls a weekday-evening enquiry over the closed window to the next business day", () => {
    // Tue 17 Nov, 19:50 (10 min before the 8pm Mon–Fri close).
    const start = sydneyWallToUtc(2026, 11, 17, 19 * 60 + 50);
    const status = callingWindowStatus(start);
    expect(status.open).toBe(true);
    const after = addBusinessMinutes(start, 60); // 10 min left tonight, 50 min carry over
    // Next business day (Wed 18 Nov) opens 9:00 am; 50 minutes in is 9:50 am.
    const expected = sydneyWallToUtc(2026, 11, 18, 9 * 60 + 50);
    expect(after.getTime()).toBe(expected.getTime());
  });

  test("rolls a Friday-evening enquiry over the weekend onto Saturday's shorter window", () => {
    // Fri 20 Nov, 19:45 (15 min before Friday's 8pm close).
    const start = sydneyWallToUtc(2026, 11, 20, 19 * 60 + 45);
    const after = addBusinessMinutes(start, 60); // 15 min left Friday, 45 min carry over
    // Saturday 21 Nov opens 9:00 am; 45 minutes in is 9:45 am (Sunday never opens at all).
    const expected = sydneyWallToUtc(2026, 11, 21, 9 * 60 + 45);
    expect(after.getTime()).toBe(expected.getTime());
  });

  test("an enquiry landing outside hours starts counting from the next open instant", () => {
    // Sunday, mid-afternoon: never open.
    const start = sydneyWallToUtc(2026, 11, 22, 15 * 60);
    expect(callingWindowStatus(start).open).toBe(false);
    const after = addBusinessMinutes(start, 20);
    const expected = sydneyWallToUtc(2026, 11, 23, 9 * 60 + 20); // Monday 9:20 am
    expect(after.getTime()).toBe(expected.getTime());
  });
});

describe("speed-to-lead: startClock", () => {
  test("an in-hours enquiry starts its clock immediately", () => {
    const receivedAt = sydneyWallToUtc(2026, 11, 17, 14 * 60); // Tue 2:00 pm
    const clock = startClock(receivedAt, 60);
    expect(clock.outsideHoursAtArrival).toBe(false);
    expect(clock.startedAt).toBe(receivedAt.toISOString());
    expect(clock.dueAt).toBe(sydneyWallToUtc(2026, 11, 17, 15 * 60).toISOString()); // 3:00 pm
  });

  test("an after-hours enquiry defers its start, but the alert (elsewhere) is never delayed", () => {
    const receivedAt = sydneyWallToUtc(2026, 11, 22, 22 * 60); // Sunday 10:00 pm
    const clock = startClock(receivedAt, 60);
    expect(clock.outsideHoursAtArrival).toBe(true);
    expect(clock.startedAt).toBe(sydneyWallToUtc(2026, 11, 23, 9 * 60).toISOString()); // Monday 9:00 am
    expect(clock.dueAt).toBe(sydneyWallToUtc(2026, 11, 23, 10 * 60).toISOString()); // Monday 10:00 am
  });
});

describe("speed-to-lead: isOverdue", () => {
  test("false before the deadline, true after", () => {
    const dueAt = sydneyWallToUtc(2026, 11, 17, 15 * 60).toISOString();
    expect(isOverdue(dueAt, sydneyWallToUtc(2026, 11, 17, 14 * 60 + 59))).toBe(false);
    expect(isOverdue(dueAt, sydneyWallToUtc(2026, 11, 17, 15 * 60 + 1))).toBe(true);
  });
});
