import { describe, expect, test } from "bun:test";
import { ageWords, buildStatus, createStatusCache, spokenTime, statusSentences, upcoming, type StatusSources } from "./jarvis-status";

// 24 Sep 2026, 10:00 Sydney.
const NOW = Date.parse("2026-09-24T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

function sources(overrides: Partial<StatusSources> = {}): StatusSources {
  return {
    calendar: () => ({
      events: [
        { title: "Old standup", start: iso(NOW - HOUR) },
        { title: "Discovery call with Smile Dental", start: "2026-09-24T04:30:00Z" }, // 2:30 pm
        { title: "All-day thing", start: "2026-09-24", allDay: true },
        { title: "Mosque then planning", start: "2026-09-24T23:00:00Z" }, // 9 am tomorrow
      ],
      syncedAt: iso(NOW - 10 * 60_000),
      connected: true,
    }),
    leads: async () => ({
      today: {
        usman: { calls: 7, target: 20, followUpsDue: [{ name: "Harbour Dental", nextAt: iso(NOW - 26 * HOUR) }] },
        mehroz: { calls: 3, target: 15, followUpsDue: [{ name: "Harbour Dental", nextAt: iso(NOW - 26 * HOUR) }, { name: "Parra Legal", nextAt: iso(NOW - HOUR) }] },
      },
    }),
    nextCall: async () => ({ id: 4, name: "Bright Smiles", vertical: "dental", status: "to_call", area: "Parramatta" }),
    approvals: () => 1,
    capabilities: () => ({
      generatedAt: iso(NOW - 20 * 60_000),
      capabilities: [
        { id: "voice.free", name: "Voice", status: "working" },
        { id: "proactive.watchdog", name: "Watchdog", status: "working" },
      ],
    }),
    ...overrides,
  };
}

describe("snapshot", () => {
  test("next event skips past and all-day items; tomorrow's first is found", () => {
    const { event, tomorrowFirst } = upcoming((sources().calendar() as any).events, NOW);
    expect(event?.title).toBe("Discovery call with Smile Dental");
    expect(tomorrowFirst?.title).toBe("Mosque then planning");
  });

  test("every source carries its time and age; shared follow-ups count once", async () => {
    const s = await buildStatus(sources(), NOW);
    expect(s.next).toMatchObject({ ok: true, stale: false, ageMs: 10 * 60_000 });
    expect(s.calls.data).toMatchObject({ followUpsDue: 2, overdue: { name: "Harbour Dental" } });
    expect(s.calls.data!.founders).toEqual([{ who: "usman", calls: 7, target: 20 }, { who: "mehroz", calls: 3, target: 15 }]);
    expect(s.health.data).toMatchObject({ broken: 0, watchdog: "working" });
    expect(s.approvals.data).toEqual({ count: 1 });
  });

  test("a failing source is unavailable, not zero, and the rest still report", async () => {
    const s = await buildStatus(sources({ leads: async () => { throw new Error("database is locked"); }, approvals: () => null }), NOW);
    expect(s.calls).toMatchObject({ ok: false, data: null, error: "database is locked" });
    expect(s.approvals.ok).toBe(false);
    expect(s.next.ok).toBe(true);
  });

  test("cached for 2 seconds", async () => {
    let reads = 0;
    let clock = NOW;
    const cache = createStatusCache(sources({ approvals: () => ++reads }), { now: () => clock });
    await cache.snapshot();
    clock += 1500;
    await cache.snapshot();
    expect(reads).toBe(1);
    clock += 600;
    await cache.snapshot();
    expect(reads).toBe(2);
  });
});

describe("spoken status (no model)", () => {
  test("three short facts: next commitment, calls and follow-ups, systems and approvals", async () => {
    const lines = statusSentences(await buildStatus(sources(), NOW), NOW);
    expect(lines).toEqual([
      "Next up: Discovery call with Smile Dental, at 2:30 pm.",
      "Calls today: Usman 7 of 20, Mehroz 3 of 15; 2 follow-ups due, starting with Harbour Dental.",
      "Systems are healthy; 1 agent task is waiting on your answer.",
    ]);
  });

  test("stale data is labelled with its age", async () => {
    const s = await buildStatus(
      sources({
        calendar: () => ({ events: [], syncedAt: iso(NOW - 2 * 24 * HOUR), connected: true }),
        capabilities: () => ({ generatedAt: iso(NOW - 5 * HOUR), capabilities: [] }),
      }),
      NOW,
    );
    const [next, , systems] = statusSentences(s, NOW);
    expect(next).toBe("Your calendar hasn't synced for 2 days, so I can't vouch for what's next.");
    expect(systems).toContain("at the last check, 5 hours ago");
    expect(systems).not.toMatch(/healthy|all clear/i);
  });

  test("a failing lead hunt is said, with its fix on the tile", async () => {
    const s = await buildStatus(
      sources({
        leads: async () => ({
          today: { usman: { calls: 0, target: 20, followUpsDue: [] } },
          hunt: { status: "failed", problem: "Google Places refused the key (403)", ownerAction: "Enable Places API (New) for the key.", failingSince: "2026-09-23T15:30:32Z" },
        }),
      }),
      NOW,
    );
    expect(s.calls.headline).toBe("Lead hunt failing since 24 Sept");
    expect(s.calls.ownerAction).toContain("Places API (New)");
    expect(statusSentences(s, NOW)[1]).toBe(
      "Calls today: Usman 0 of 20; no follow-ups due. The nightly lead hunt is failing: Google Places refused the key.",
    );
  });

  test("an offline calendar names the owner's fix and the tile says what it counts", async () => {
    const s = await buildStatus(
      sources({
        calendar: () => ({
          events: [],
          syncedAt: iso(NOW - 2 * 24 * HOUR),
          connected: true,
          problem: "Google Calendar is no longer connected in Codex, so your calendar can't refresh.",
          ownerAction: "Open Settings → Connections and connect Google (allow calendar access), or reconnect the Google Calendar app in Codex.",
          headline: "Calendar offline since 22 Sept",
        }),
      }),
      NOW,
    );
    expect(s.next).toMatchObject({ ok: true, stale: true, headline: "Calendar offline since 22 Sept" });
    expect(s.next.ownerAction).toContain("Settings → Connections");
    expect(s.approvals.label).toBe("Agent approvals");
    expect(statusSentences(s, NOW)[0]).toBe(
      "Your calendar hasn't synced for 2 days, so I can't vouch for what's next. To fix it: Open Settings, Connections and connect Google, or reconnect the Google Calendar app in Codex.",
    );
  });

  test("never 'all clear' when a source is unavailable", async () => {
    const s = await buildStatus(
      sources({
        calendar: () => ({ events: [], syncedAt: null, connected: false }),
        leads: async () => { throw new Error("down"); },
        capabilities: () => null,
        approvals: () => null,
      }),
      NOW,
    );
    const text = statusSentences(s, NOW).join(" ");
    expect(text).toBe(
      "I can't read your calendar right now, so I can't say what's next. The CRM isn't answering, so I have no call figures. I have no systems check to go on; I can't see the task queue.",
    );
    expect(text).not.toMatch(/all clear|healthy/i);
  });

  test("broken systems are named", async () => {
    const s = await buildStatus(
      sources({ capabilities: () => ({ generatedAt: iso(NOW), capabilities: [{ id: "a", name: "Jarvis Chrome", status: "broken" }, { id: "b", name: "Obsidian", status: "broken" }] }) }),
      NOW,
    );
    expect(statusSentences(s, NOW)[2]).toBe("2 systems need attention: Jarvis Chrome, Obsidian; 1 agent task is waiting on your answer.");
  });

  test("times and ages read naturally", () => {
    expect(spokenTime("2026-09-24T04:30:00Z", NOW)).toBe("at 2:30 pm");
    expect(spokenTime("2026-09-24T23:00:00Z", NOW)).toBe("tomorrow at 9 am");
    expect(spokenTime("2026-09-26T00:15:00Z", NOW)).toBe("on Saturday at 10:15 am");
    expect(ageWords(30_000)).toBe("a minute");
    expect(ageWords(3 * HOUR)).toBe("3 hours");
    expect(ageWords(50 * HOUR)).toBe("2 days");
  });
});
