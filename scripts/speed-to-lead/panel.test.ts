import { describe, expect, test } from "bun:test";
import { projectSpeedToLead } from "./panel";
import type { EnquiryRecord } from "./store";

const record = (over: Partial<EnquiryRecord> = {}): EnquiryRecord => ({
  ref: "ab12cd34",
  topic: "Dental practice website",
  receivedAt: "2026-11-17T03:00:00.000Z",
  detectedAt: "2026-11-17T03:01:00.000Z",
  startedAt: "2026-11-17T03:00:00.000Z",
  dueAt: "2026-11-17T04:00:00.000Z",
  outsideHoursAtArrival: false,
  notifiedAt: "2026-11-17T03:01:30.000Z",
  status: "open",
  respondedAt: null,
  ...over,
});

describe("speed-to-lead: projectSpeedToLead", () => {
  test("projects an open enquiry's minutes since/due, not overdue", () => {
    const now = new Date("2026-11-17T03:20:00.000Z");
    const panel = projectSpeedToLead([record()], now);
    expect(panel.items).toEqual([
      {
        ref: "ab12cd34",
        topic: "Dental practice website",
        sinceMinutes: 20,
        dueInMinutes: 40,
        overdue: false,
      },
    ]);
    expect(panel.openCount).toBe(1);
    expect(panel.overdueCount).toBe(0);
  });

  test("flags overdue once past dueAt, with a negative dueInMinutes", () => {
    const now = new Date("2026-11-17T04:10:00.000Z");
    const panel = projectSpeedToLead([record()], now);
    expect(panel.items[0].overdue).toBe(true);
    expect(panel.items[0].dueInMinutes).toBe(-10);
    expect(panel.overdueCount).toBe(1);
  });

  test("drops responded enquiries and sorts the rest by soonest due", () => {
    const now = new Date("2026-11-17T03:00:00.000Z");
    const panel = projectSpeedToLead(
      [
        record({ ref: "later", dueAt: "2026-11-17T05:00:00.000Z" }),
        record({ ref: "sooner", dueAt: "2026-11-17T03:30:00.000Z" }),
        record({ ref: "done", status: "responded", respondedAt: now.toISOString() }),
      ],
      now,
    );
    expect(panel.items.map((i) => i.ref)).toEqual(["sooner", "later"]);
    expect(panel.openCount).toBe(2);
  });

  test("falls back to a generic label when topic is blank", () => {
    const panel = projectSpeedToLead([record({ topic: "" })], new Date("2026-11-17T03:00:00.000Z"));
    expect(panel.items[0].topic).toBe("General enquiry");
  });
});
