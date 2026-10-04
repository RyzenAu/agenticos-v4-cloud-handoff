import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJarvisEvents, inQuietHours, parseEventInput, pollIsStale, type GateOptions } from "./jarvis-events";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-events-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the handle briefly */ }
  }
});

// 24 Sep 2026, 10:00 Sydney (AEST, UTC+10) — daytime, outside quiet hours.
const DAY = Date.parse("2026-09-24T00:00:00Z");
// 23:30 Sydney.
const NIGHT = Date.parse("2026-09-24T13:30:00Z");
function gate(start = DAY, options: Omit<GateOptions, "now"> = {}) {
  let clock = start;
  const events = createJarvisEvents(root(), { now: () => clock, ...options });
  return { events, advance: (ms: number) => (clock += ms), set: (ms: number) => (clock = ms) };
}

describe("input", () => {
  test("validates source, text, priority and expiry; caps text at 300 characters", () => {
    expect(() => parseEventInput({ source: "watchdog", text: "x".repeat(301) }, DAY)).toThrow("300");
    expect(() => parseEventInput({ source: "", text: "hi" }, DAY)).toThrow("source");
    expect(() => parseEventInput({ source: "watchdog", text: "hi", priority: "critical" }, DAY)).toThrow("priority");
    expect(() => parseEventInput({ source: "watchdog", text: "hi", expiresAt: "2020-01-01T00:00:00Z" }, DAY)).toThrow("past");
    expect(() => parseEventInput({ source: "watchdog", text: "hi", dial: "0400000000" }, DAY)).toThrow("only");
    const parsed = parseEventInput({ source: "Watchdog", text: "  OS\u0000 down  " }, DAY);
    expect(parsed).toMatchObject({ source: "watchdog", text: "OS down", priority: "normal" });
    expect(parsed.dedupeKey).toMatch(/^watchdog:[0-9a-f]{16}$/);
    // A far-future expiry is capped at a day.
    expect(parseEventInput({ source: "a", text: "b", expiresAt: "2030-01-01T00:00:00Z" }, DAY).expiresAt).toBe(DAY + 24 * 3_600_000);
  });

  test("quiet hours are 22:00–07:00 Sydney", () => {
    expect(inQuietHours(DAY)).toBe(false);
    expect(inQuietHours(NIGHT)).toBe(true);
    expect(inQuietHours(Date.parse("2026-09-23T20:30:00Z"))).toBe(true); // 06:30 Sydney
    expect(inQuietHours(Date.parse("2026-09-23T21:00:00Z"))).toBe(false); // 07:00 Sydney
  });
});

describe("gate rules", () => {
  test("dedupe: a replayed alert is one event, even after it expired", () => {
    const { events, advance } = gate();
    const first = events.submit({ source: "watchdog", text: "Hermes gateway is down.", dedupeKey: "hermes-down-24" });
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(events.submit({ source: "watchdog", text: "Hermes gateway is down.", dedupeKey: "hermes-down-24" })).toMatchObject({ accepted: false, duplicate: true });
    advance(2 * 3_600_000); // the event has expired (normal = 30 min)…
    expect(events.list(0).events).toHaveLength(0);
    // …but the same key is still the same alert.
    expect(events.submit({ source: "watchdog", text: "Hermes gateway is down.", dedupeKey: "hermes-down-24" }).accepted).toBe(false);
    // Without a key, identical text from the same source dedupes too.
    events.submit({ source: "coach", text: "Five calls to go." });
    expect(events.submit({ source: "coach", text: "five calls to go." }).duplicate).toBe(true);
  });

  test("one alert per event: speech is claimed exactly once", () => {
    const { events } = gate();
    const { event } = events.submit({ source: "calendar", text: "Standup in ten minutes." });
    expect(event!.delivery).toBe("speak");
    expect(events.claim({ id: event!.id })).toMatchObject({ speak: true, text: "Standup in ten minutes." });
    expect(events.claim({ id: event!.id })).toMatchObject({ speak: false, reason: "already spoken" });
    expect(events.list(0).events[0].spokenAt).toBeTruthy();
  });

  test("stale events expire and can't be claimed", () => {
    const { events, advance } = gate();
    const { event } = events.submit({ source: "calendar", text: "Meeting soon.", expiresAt: new Date(DAY + 60_000).toISOString() });
    advance(61_000);
    expect(events.claim({ id: event!.id })).toMatchObject({ speak: false, reason: "expired or unknown" });
    expect(events.list(0).events).toHaveLength(0);
  });

  test("low priority is HUD only", () => {
    const { events } = gate();
    const { event } = events.submit({ source: "coach", text: "Nice streak.", priority: "low" });
    expect(event!.delivery).toBe("hud");
    expect(events.claim({ id: event!.id }).speak).toBe(false);
  });

  test("daily budget: 12 spoken a day, then the HUD; urgent is exempt; resets the next day", () => {
    const { events, set } = gate(DAY, { dailyBudget: 2 });
    const say = (text: string, priority = "normal") => {
      const { event } = events.submit({ source: "coach", text, priority });
      return event!.delivery === "speak" ? events.claim({ id: event!.id }).speak : false;
    };
    expect(say("one")).toBe(true);
    expect(say("two")).toBe(true);
    expect(say("three")).toBe(false);
    expect(events.list(0).events.at(-1)!.reason).toBe("daily speech budget used");
    expect(say("server down", "urgent")).toBe(true);
    expect(events.status().budget).toEqual({ spoken: 2, limit: 2 });
    set(DAY + 24 * 3_600_000);
    expect(say("four")).toBe(true);
    expect(createJarvisEvents(root()).status().budget.limit).toBe(12);
  });

  test("quiet hours hold normal events; urgent still speaks", () => {
    const { events } = gate(NIGHT);
    expect(events.submit({ source: "coach", text: "Follow-up due." }).event!.delivery).toBe("hud");
    expect(events.submit({ source: "watchdog", text: "OS is down.", priority: "urgent" }).event!.delivery).toBe("speak");
    expect(events.status().mode).toBe("quiet");
  });

  test("call mode: nothing spoken; urgent only flashes; rules are re-checked at claim time", () => {
    const { events } = gate();
    const before = events.submit({ source: "calendar", text: "Standup soon." }).event!;
    events.setCallMode(true);
    expect(events.status().mode).toBe("call");
    expect(events.claim({ id: before.id })).toMatchObject({ speak: false });
    expect(events.submit({ source: "coach", text: "Next lead ready." }).event!.delivery).toBe("hud");
    const urgent = events.submit({ source: "watchdog", text: "Site is down.", priority: "urgent" }).event!;
    expect(urgent.delivery).toBe("flash");
    expect(events.claim({ id: urgent.id }).speak).toBe(false);
    events.setCallMode(false);
    expect(events.submit({ source: "coach", text: "Back to normal." }).event!.delivery).toBe("speak");
  });

  test("quiet mode on/off/until; a timed quiet lifts itself", () => {
    const { events, advance } = gate();
    expect(() => events.setQuiet({})).toThrow();
    expect(() => events.setQuiet({ on: true, until: "2020-01-01T00:00:00Z" })).toThrow("future");
    expect(events.setQuiet({ on: true, minutes: 30 }).quiet.on).toBe(true);
    expect(events.submit({ source: "coach", text: "Held." }).event!.delivery).toBe("hud");
    expect(events.submit({ source: "watchdog", text: "Urgent in quiet.", priority: "urgent" }).event!.delivery).toBe("flash");
    advance(31 * 60_000);
    expect(events.status().quiet).toEqual({ on: false, until: null });
    expect(events.setQuiet({ on: true }).quiet).toEqual({ on: true, until: null });
    expect(events.setQuiet({ on: false }).mode).toBe("normal");
  });

  // 150 submits = 150 real write-temp-then-rename cycles of the events file. Normally well under
  // a second, but measured 6.3 s with the disk busy under load; 20 s is 3x that.
  test("persists to .operator-data/jarvis-events.json, capped and small", () => {
    const dir = root();
    let clock = DAY;
    const events = createJarvisEvents(dir, { now: () => clock });
    for (let i = 0; i < 150; i++) events.submit({ source: "coach", text: `Event ${i}`, priority: "low" });
    const again = createJarvisEvents(dir, { now: () => clock });
    const listed = again.list(0);
    expect(listed.events.length).toBeLessThanOrEqual(100);
    expect(listed.seq).toBe(150);
    expect(again.list(149).events.map((e) => e.text)).toEqual(["Event 149"]);
    const file = join(dir, ".operator-data", "jarvis-events.json");
    expect(statSync(file).size).toBeLessThan(64 * 1024);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  }, 20_000);
});

describe("pollIsStale", () => {
  test("stale once more than the window has passed since the last poll", () => {
    expect(pollIsStale(0, 30_000, 30_000)).toBe(false);
    expect(pollIsStale(0, 30_001, 30_000)).toBe(true);
    expect(pollIsStale(1_000, 5_000, 30_000)).toBe(false);
  });
});

describe("Windows-toast fallback (no voice client polling)", () => {
  test("toasts a speak-eligible event when nobody has ever polled", () => {
    const toasted: string[] = [];
    const { events } = gate(DAY, { onFallbackToast: (event) => toasted.push(event.text) });
    const { event } = events.submit({ source: "watchdog", text: "Hermes gateway is down.", priority: "urgent" });
    expect(event!.delivery).toBe("speak");
    expect(toasted).toEqual(["Hermes gateway is down."]);
    expect(event!.toastedAt).toBeTruthy();
  });

  test("does not toast when a client polled recently", () => {
    const toasted: string[] = [];
    const { events } = gate(DAY, { onFallbackToast: (event) => toasted.push(event.text) });
    events.list(0); // the voice panel is open and polling
    const { event } = events.submit({ source: "coach", text: "Five calls to go." });
    expect(event!.delivery).toBe("speak");
    expect(toasted).toEqual([]);
    expect(event!.toastedAt).toBeUndefined();
  });

  test("toasts again once the last poll goes stale", () => {
    const toasted: string[] = [];
    const { events, advance } = gate(DAY, { onFallbackToast: (event) => toasted.push(event.text) });
    events.list(0);
    advance(31_000); // past the 30s default fallback window, no further poll
    events.submit({ source: "coach", text: "Standup in ten." });
    expect(toasted).toEqual(["Standup in ten."]);
  });

  test("pollFallbackMs is configurable", () => {
    const toasted: string[] = [];
    const { events, advance } = gate(DAY, { pollFallbackMs: 5000, onFallbackToast: (event) => toasted.push(event.text) });
    events.list(0);
    advance(4000);
    events.submit({ source: "coach", text: "Not stale yet." });
    expect(toasted).toEqual([]);
    advance(2000); // now 6s since the poll
    events.submit({ source: "coach", text: "Now it is stale." });
    expect(toasted).toEqual(["Now it is stale."]);
  });

  test("never toasts an event that would not have been spoken anyway", () => {
    const toasted: string[] = [];
    const { events } = gate(NIGHT, { onFallbackToast: (event) => toasted.push(event.text) }); // quiet hours
    events.submit({ source: "coach", text: "Low priority.", priority: "low" });
    events.submit({ source: "coach", text: "Held for quiet hours." }); // normal, but hushed
    expect(toasted).toEqual([]);
  });

  test("call mode and quiet mode suppress the toast just like they suppress speech", () => {
    const toasted: string[] = [];
    const { events } = gate(DAY, { onFallbackToast: (event) => toasted.push(event.text) });
    events.setCallMode(true);
    events.submit({ source: "coach", text: "Held during the call." });
    events.submit({ source: "watchdog", text: "Flashes only.", priority: "urgent" });
    expect(toasted).toEqual([]);
  });

  test("a duplicate submission never toasts twice", () => {
    const toasted: string[] = [];
    const { events } = gate(DAY, { onFallbackToast: (event) => toasted.push(event.text) });
    events.submit({ source: "watchdog", text: "Site is down.", dedupeKey: "site-down" });
    events.submit({ source: "watchdog", text: "Site is down.", dedupeKey: "site-down" });
    expect(toasted).toEqual(["Site is down."]);
  });

  test("defaults to a no-op notifier — submitting never throws without one configured", () => {
    const { events } = gate(DAY);
    expect(() => events.submit({ source: "watchdog", text: "No notifier wired.", priority: "urgent" })).not.toThrow();
  });
});
