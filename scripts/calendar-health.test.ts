import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarHealth, startCalendarBackgroundSync } from "./calendar-health";
import { nativeCalendarSync } from "./native-calendar-sync";
import type { OperatorState } from "../src/lib/operator";

const NOW = Date.parse("2026-09-24T00:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const coverage = (syncedAt: string) => ({
  timeMin: iso(NOW - 30 * 24 * HOUR),
  timeMax: iso(NOW + 30 * 24 * HOUR),
  syncedAt,
  calendarCount: 1,
  eventCount: 0,
  calendars: [],
  complete: true,
});
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("a fresh source is live and asks nothing of the owner", () => {
  const health = calendarHealth({
    native: { enabled: true, account: "a@example.test", coverage: coverage(iso(NOW - 5 * 60_000)) },
    accounts: [],
    background: null,
    savedEvents: 3,
    now: NOW,
  });
  expect(health).toMatchObject({ state: "live", source: "codex", headline: "Calendar synced 5 min ago" });
  expect(health.ownerAction).toBeUndefined();
});

test("a missing Codex connector is 'offline since', with one owner action, not 'account changed'", () => {
  const health = calendarHealth({
    native: {
      enabled: true,
      account: "a@example.test",
      coverage: coverage("2026-09-22T17:15:05Z"),
      problem: "codex-missing",
      error: "Connect Google Calendar in Codex, then check again here.",
    },
    accounts: [{ id: "google", connected: false, calendarAccess: "disconnected" }],
    background: null,
    savedEvents: 0,
    now: NOW,
    timeZone: "Australia/Sydney",
  });
  expect(health.state).toBe("offline");
  expect(health.headline).toBe("Calendar offline since 23 Sept");
  expect(health.problem).toContain("no longer connected in Codex");
  expect(health.problem).not.toContain("changed");
  expect(health.ownerAction).toContain("Settings → Connections");
});

test("old data without a known fault is stale; the freshest connected source wins", () => {
  const stale = calendarHealth({
    native: { enabled: true, account: "a@example.test", coverage: coverage(iso(NOW - 30 * HOUR)) },
    accounts: [],
    background: null,
    savedEvents: 0,
    now: NOW,
  });
  expect(stale).toMatchObject({ state: "stale", headline: "Calendar last synced 30 h ago" });
  const both = calendarHealth({
    native: { enabled: true, account: "a@example.test", coverage: coverage(iso(NOW - 48 * HOUR)), problem: "codex-missing" },
    accounts: [
      { id: "google", connected: true, calendarAccess: "granted", calendarCoverage: { syncedAt: iso(NOW - 10 * 60_000) } },
    ],
    background: null,
    savedEvents: 4,
    now: NOW,
  });
  expect(both).toMatchObject({ state: "live", source: "google" });
  expect(both.problem).toBeUndefined();
});

test("nothing connected says so and points at Connections", () => {
  const health = calendarHealth({ native: null, accounts: [], background: null, savedEvents: 0, now: NOW });
  expect(health).toMatchObject({ state: "none", headline: "No calendar connected" });
  expect(health.ownerAction).toContain("Settings → Connections");
});

test("background sync refreshes the chosen calendar without a page and records a missing connector", async () => {
  const root = mkdtempSync(join(tmpdir(), "calendar-health-"));
  roots.push(root);
  let state = { events: [], inbox: [] } as unknown as OperatorState;
  let tools: Record<string, any> = Object.fromEntries(
    ["get_profile", "list_calendars", "search_events"].map((suffix) => [
      `google_calendar.${suffix}`,
      { name: suffix, annotations: { readOnlyHint: true }, _meta: { link_owner_profile: { email: "a@example.test" } } },
    ]),
  );
  const connectedRead = async (_root: string, work: any) =>
    work({
      tools,
      call: async (name: string) =>
        name.endsWith("get_profile")
          ? { email: "a@example.test" }
          : name.endsWith("list_calendars")
            ? { calendars: [{ id: "a@example.test", summary: "Primary", primary: true, access_role: "owner" }] }
            : { events: [{ id: "e1", summary: "Standup", start: iso(NOW + HOUR), end: iso(NOW + 2 * HOUR) }] },
    });
  const native = nativeCalendarSync(root, {
    load: () => structuredClone(state),
    save: (next) => (state = structuredClone(next)),
    connectedRead,
  } as any);
  const accounts = { handle: async () => ({ accounts: [] }) };
  const background = startCalendarBackgroundSync(root, { native, accounts, firstDelayMs: 1e9, intervalMs: 15 * 60_000 });
  try {
    // Not chosen yet: the background never enables a calendar on its own.
    let run = await background.run();
    expect(run.results[0]).toMatchObject({ source: "codex", ok: true, skipped: "not-enabled" });
    expect(state.events).toHaveLength(0);

    await native.sync({ enable: true, timeMin: iso(NOW - 24 * HOUR), timeMax: iso(NOW + 24 * HOUR) });
    state.events = [];
    run = await background.run();
    expect(run.results[0]).toMatchObject({ source: "codex", ok: true });
    expect(state.events.map((e) => e.title)).toEqual(["Standup"]);
    expect(run.nextRunAt).not.toBeNull();
    expect(existsSync(join(root, ".operator-data", "calendar-background.json"))).toBe(true);

    // The connector disappears from Codex: recorded as codex-missing, saved events kept.
    tools = { "gmail.get_profile": tools["google_calendar.get_profile"] };
    run = await background.run();
    expect(run.results[0]).toMatchObject({ source: "codex", ok: false });
    const saved = JSON.parse(readFileSync(join(root, ".operator-data", "native-calendar.json"), "utf8"));
    expect(saved).toMatchObject({ enabled: true, problem: "codex-missing" });
    expect(state.events).toHaveLength(1);
    const status = await native.status();
    expect(status).toMatchObject({ configured: true, available: false, problem: "codex-missing" });
    expect(status.error).not.toContain("changed");
  } finally {
    background.stop();
  }
});
