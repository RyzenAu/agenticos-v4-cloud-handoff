import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WHAT_QUESTION, WHEN_QUESTION, answerAskBack, createScheduler, dueLine, meridiemReply, timerIntent, type TimerItem } from "./timers";
import type { ReminderTaskHost } from "../windows/reminder-tasks";

// Thursday 24 Sep 2026, 10:00 Sydney.
const NOW = Date.UTC(2026, 8, 24, 0, 0);
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-timers-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("timer and alarm phrases", () => {
  test("timers", () => {
    expect(timerIntent("set a timer for 10 minutes")).toEqual({ skill: "timer", action: "start", seconds: 600, phrase: "10 minutes" });
    expect(timerIntent("timer 90 seconds")).toMatchObject({ seconds: 90 });
    expect(timerIntent("Set a 10-minute timer.")).toMatchObject({ seconds: 600 });
    expect(timerIntent("set a pasta timer for 8 minutes")).toMatchObject({ seconds: 480, label: "pasta" });
    expect(timerIntent("start a timer for an hour and a half")).toMatchObject({ seconds: 5400 });
    expect(timerIntent("Jarvis, set a timer for 5 minutes for the oven")).toMatchObject({ seconds: 300, label: "oven" });
    expect(timerIntent("set a timer for 3 days")).toMatchObject({ skill: "say" });
  });
  test("alarms: settled times set, ambiguous ones ask back", () => {
    expect(timerIntent("set an alarm for 6 am tomorrow")).toEqual({ skill: "timer", action: "alarm", clock: { hour: 6, minute: 0, day: "tomorrow" } });
    expect(timerIntent("alarm at 19:30")).toMatchObject({ clock: { hour: 19, minute: 30 } });
    expect(timerIntent("alarm at 7:30")).toEqual({ skill: "say", text: "Is that 7:30 in the morning or the evening, sir?" });
    expect(timerIntent("wake me up at 6")).toMatchObject({ skill: "say" });
    expect(timerIntent("alarm at 7:30", "am")).toMatchObject({ action: "alarm", clock: { hour: 7, minute: 30 } });
  });
  test("left and cancel", () => {
    expect(timerIntent("how long left")).toEqual({ skill: "timer", action: "left" });
    expect(timerIntent("how much time is left on my timer")).toEqual({ skill: "timer", action: "left" });
    expect(timerIntent("cancel the timer")).toEqual({ skill: "timer", action: "cancel", kind: "timer" });
    expect(timerIntent("cancel all timers")).toEqual({ skill: "timer", action: "cancel", kind: "timer", all: true });
    expect(timerIntent("turn off the alarm")).toEqual({ skill: "timer", action: "cancel", kind: "alarm" });
    expect(timerIntent("cancel my reminders")).toEqual({ skill: "timer", action: "cancel", kind: "reminder", all: true });
    expect(timerIntent("cancel the reminder to call Smile Dental")).toEqual({ skill: "timer", action: "cancel", kind: "reminder", match: "call smile dental" });
  });
  test("things it must not catch", () => {
    for (const phrase of ["timer", "start the timer", "set a timer on my phone for 5 minutes", "cancel the meeting", "stop", "what's the time", "set the table", "remind", "alarm", "how long is the drive to Parramatta"])
      expect(timerIntent(phrase)).toBeNull();
  });
});

describe("reminder phrases", () => {
  test("when first or last, in or at", () => {
    expect(timerIntent("remind me in 20 minutes to call Smile Dental")).toEqual({ skill: "reminder", action: "set", text: "call Smile Dental", seconds: 1200 });
    expect(timerIntent("Remind me at 3 pm to send the proposal.")).toEqual({ skill: "reminder", action: "set", text: "send the proposal", clock: { hour: 15, minute: 0, day: null } });
    expect(timerIntent("remind me to send the proposal at 3pm")).toMatchObject({ text: "send the proposal", clock: { hour: 15 } });
    expect(timerIntent("remind me to look at the report at 4 pm")).toMatchObject({ text: "look at the report", clock: { hour: 16 } });
    expect(timerIntent("remind me tomorrow at 9 am to ring the bank")).toMatchObject({ text: "ring the bank", clock: { hour: 9, day: "tomorrow" } });
    expect(timerIntent("remind me about the dental call in 10 minutes")).toMatchObject({ text: "the dental call", seconds: 600, about: true });
    expect(timerIntent("what are my reminders")).toEqual({ skill: "reminder", action: "list" });
  });
  test("ambiguous or missing pieces ask back in one line", () => {
    expect(timerIntent("remind me at 3 to send the proposal")).toEqual({ skill: "say", text: "Is that 3 in the morning or the afternoon, sir?" });
    expect(timerIntent("remind me to call mum tomorrow")).toEqual({ skill: "say", text: WHEN_QUESTION });
    expect(timerIntent("remind me to call Smile Dental")).toEqual({ skill: "say", text: WHEN_QUESTION });
    expect(timerIntent("remind me in 5 minutes")).toEqual({ skill: "say", text: WHAT_QUESTION });
    expect(timerIntent("remind me")).toEqual({ skill: "say", text: WHAT_QUESTION });
  });
  test("his answer to the ask-back finishes the request", () => {
    expect(meridiemReply("PM")).toBe("pm");
    expect(meridiemReply("in the morning")).toBe("am");
    expect(meridiemReply("the afternoon")).toBe("pm");
    expect(meridiemReply("banana")).toBeNull();
    expect(answerAskBack("afternoon", "remind me at 3 to send the proposal", "Is that 3 in the morning or the afternoon, sir?")).toMatchObject({ text: "send the proposal", clock: { hour: 15 } });
    expect(answerAskBack("morning", "alarm at 7:30", "Is that 7:30 in the morning or the evening, sir?")).toMatchObject({ action: "alarm", clock: { hour: 7, minute: 30 } });
    expect(answerAskBack("in 20 minutes", "remind me to call Smile Dental", WHEN_QUESTION)).toMatchObject({ text: "call Smile Dental", seconds: 1200 });
    expect(answerAskBack("at 9 am", "remind me to call mum tomorrow", WHEN_QUESTION)).toMatchObject({ text: "call mum", clock: { hour: 9, day: "tomorrow" } });
    expect(answerAskBack("call the bank", "remind me in 5 minutes", WHAT_QUESTION)).toMatchObject({ text: "call the bank", seconds: 300 });
    // Not an answer: falls through to the normal rules.
    expect(answerAskBack("open Spotify", "remind me to call mum", WHEN_QUESTION)).toBeNull();
    expect(answerAskBack("never mind", "remind me in 5 minutes", WHAT_QUESTION)).toBeNull();
    expect(answerAskBack("pm", "remind me at 3 to x", "Sure thing.")).toBeNull();
  });
  test("not reminders", () => {
    for (const phrase of ["reminds me of the old site", "what reminded you", "the reminder email went out"]) expect(timerIntent(phrase)).toBeNull();
  });
});

describe("the scheduler", () => {
  function setup(start = NOW) {
    let clock = start;
    const events: any[] = [];
    let armed: { fn: () => void; at: number } | null = null;
    const root = temp();
    const scheduler = createScheduler(root, {
      now: () => clock,
      submit: (body) => void events.push(body),
      setTimer: ((fn: () => void, ms: number) => ((armed = { fn, at: clock + ms }), 1)) as any,
      clearTimer: (() => (armed = null)) as any,
    });
    const advance = (ms: number) => {
      clock += ms;
      while (armed && armed.at <= clock) {
        const fire = armed.fn;
        armed = null;
        fire();
      }
    };
    return { scheduler, events, advance, root };
  }

  test("a timer persists, counts down, and fires one URGENT event", () => {
    const { scheduler, events, advance, root } = setup();
    expect(scheduler.handle({ skill: "timer", action: "start", seconds: 600, phrase: "10 minutes" })).toBe("Timer set for 10 minutes, sir.");
    expect(JSON.parse(readFileSync(join(root, ".operator-data", "jarvis-timers.json"), "utf8")).items).toHaveLength(1);
    advance(5 * 60_000 + 48_000);
    expect(scheduler.handle({ skill: "timer", action: "left" })).toBe("4 minutes 12 seconds left on your 10-minute timer.");
    expect(scheduler.snapshot().items[0]).toMatchObject({ kind: "timer", label: "10 minutes" });
    advance(4 * 60_000 + 12_000);
    expect(events).toEqual([{ source: "jarvis-timer", text: "Your 10-minute timer is done, sir.", priority: "urgent", dedupeKey: expect.stringMatching(/^timer:t_/) }]);
    expect(scheduler.snapshot().items).toHaveLength(0);
  });

  test("reminders are normal priority and list in his words", () => {
    const { scheduler, events, advance } = setup();
    expect(scheduler.handle({ skill: "reminder", action: "set", text: "call Smile Dental", seconds: 1200 })).toBe("I'll remind you in 20 minutes to call Smile Dental, sir.");
    expect(scheduler.handle({ skill: "reminder", action: "set", text: "send the proposal", clock: { hour: 15, minute: 0, day: null } })).toBe("I'll remind you at 3 pm to send the proposal, sir.");
    expect(scheduler.handle({ skill: "reminder", action: "list" })).toBe("You have 2 reminders: in 20 minutes, call Smile Dental; at 3 pm, send the proposal.");
    advance(20 * 60_000);
    expect(events[0]).toMatchObject({ source: "jarvis-reminder", text: "Reminder, sir: call Smile Dental.".replace(/\.$/, ""), priority: "normal" });
  });

  test("alarms resolve to the next such time and announce the clock", () => {
    const { scheduler, events, advance } = setup();
    expect(scheduler.handle({ skill: "timer", action: "alarm", clock: { hour: 7, minute: 30, day: null } })).toBe("Alarm set for 7:30 am tomorrow, sir.");
    advance(21.5 * 3600_000);
    expect(events[0]).toMatchObject({ text: "It's 7:30 am, sir. Your alarm.", priority: "urgent" });
  });

  test("cancel: the latest, all, or by his words", () => {
    const { scheduler, advance } = setup();
    scheduler.handle({ skill: "timer", action: "start", seconds: 600, phrase: "10 minutes" });
    advance(1000);
    scheduler.handle({ skill: "timer", action: "start", seconds: 480, phrase: "8 minutes", label: "pasta" });
    expect(scheduler.handle({ skill: "timer", action: "cancel", kind: "timer" })).toBe("Cancelled your pasta timer. 1 more still set, sir.");
    expect(scheduler.handle({ skill: "timer", action: "cancel", kind: "timer", all: true })).toBe("Cancelled your 10-minute timer, sir.");
    expect(scheduler.handle({ skill: "timer", action: "cancel", kind: "timer" })).toBe("There are no timers to cancel, sir.");
    scheduler.handle({ skill: "reminder", action: "set", text: "call Smile Dental", seconds: 600 });
    scheduler.handle({ skill: "reminder", action: "set", text: "send the proposal", seconds: 900 });
    expect(scheduler.handle({ skill: "timer", action: "cancel", kind: "reminder", match: "the proposal" })).toBe("Cancelled your reminder to send the proposal, sir.");
    expect(scheduler.handle({ skill: "timer", action: "cancel", kind: "reminder", match: "gym" })).toBe("I can't find a reminder about that, sir.");
  });

  test("survives a restart: missed items fire late and say so; hours-late ones go quietly to the HUD", () => {
    const root = temp();
    const item = (id: string, minsAgo: number, kind: TimerItem["kind"] = "timer"): TimerItem => ({
      id,
      kind,
      createdAt: new Date(NOW - 3600_000 * 5).toISOString(),
      dueAt: new Date(NOW - minsAgo * 60_000).toISOString(),
      phrase: "10 minutes",
      text: "stretch",
    });
    mkdirSync(join(root, ".operator-data"), { recursive: true });
    writeFileSync(join(root, ".operator-data", "jarvis-timers.json"), JSON.stringify({ version: 1, items: [item("a", 5), item("b", 180, "reminder")] }));
    const events: any[] = [];
    const scheduler = createScheduler(root, { now: () => NOW, submit: (e) => void events.push(e), setTimer: (() => 1) as any, clearTimer: (() => undefined) as any });
    scheduler.start();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ priority: "urgent", text: expect.stringContaining("while I was offline") });
    expect(events[1]).toMatchObject({ priority: "low", dedupeKey: "timer:b" });
    scheduler.close();
  });

  test("a corrupt store is ignored, not fatal", () => {
    const root = temp();
    mkdirSync(join(root, ".operator-data"), { recursive: true });
    writeFileSync(join(root, ".operator-data", "jarvis-timers.json"), "{not json");
    const scheduler = createScheduler(root, { now: () => NOW, submit: () => undefined, setTimer: (() => 1) as any, clearTimer: (() => undefined) as any });
    expect(scheduler.snapshot().items).toEqual([]);
  });

  test("due lines", () => {
    const base = { id: "x", createdAt: "", dueAt: new Date(Date.UTC(2026, 8, 24, 5, 0)).toISOString() };
    expect(dueLine({ ...base, kind: "timer", phrase: "90 seconds" })).toBe("Your 90-second timer is done, sir.");
    expect(dueLine({ ...base, kind: "timer", phrase: "1 hour 30 minutes" })).toBe("Your timer for 1 hour 30 minutes is done, sir.");
    expect(dueLine({ ...base, kind: "alarm", label: "gym" })).toBe("It's 3 pm, sir. Your gym alarm.");
    expect(dueLine({ ...base, kind: "reminder", text: "send the proposal" })).toBe("Reminder, sir: send the proposal");
  });
});

// Windows-native backup reminders (Task Scheduler): the scheduler only ever talks to the
// injected ReminderTaskHost, so these never shell out to a real schtasks.
describe("windows backup reminder tasks", () => {
  function mockTasks() {
    const registered: { id: string; dueAt: string; text: string }[] = [];
    const removed: string[] = [];
    const delivered: string[] = [];
    const cleanupCalls: string[][] = [];
    const tasks: ReminderTaskHost = {
      register: async (item) => {
        registered.push(item);
        return true;
      },
      remove: async (id) => {
        removed.push(id);
      },
      markDelivered: (id) => {
        delivered.push(id);
      },
      cleanupStale: async (activeIds) => {
        cleanupCalls.push(activeIds);
      },
    };
    return { tasks, registered, removed, delivered, cleanupCalls };
  }
  function setup(tasks: ReminderTaskHost, start = NOW) {
    let clock = start;
    const events: any[] = [];
    let armed: { fn: () => void; at: number } | null = null;
    const root = temp();
    const scheduler = createScheduler(root, {
      now: () => clock,
      submit: (body) => void events.push(body),
      setTimer: ((fn: () => void, ms: number) => ((armed = { fn, at: clock + ms }), 1)) as any,
      clearTimer: (() => (armed = null)) as any,
      tasks,
    });
    const advance = (ms: number) => {
      clock += ms;
      while (armed && armed.at <= clock) {
        const fire = armed.fn;
        armed = null;
        fire();
      }
    };
    return { scheduler, events, advance, root };
  }

  test("a reminder due beyond the horizon registers a backup task", () => {
    const { tasks, registered } = mockTasks();
    const { scheduler } = setup(tasks);
    scheduler.handle({ skill: "reminder", action: "set", text: "call the bank", seconds: 20 * 60 });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ text: "call the bank" });
  });

  test("a reminder under the horizon skips the backup task entirely", () => {
    const { tasks, registered } = mockTasks();
    const { scheduler } = setup(tasks);
    scheduler.handle({ skill: "reminder", action: "set", text: "quick one", seconds: 5 * 60 });
    expect(registered).toHaveLength(0);
  });

  test("a reminder exactly at the horizon still registers (>=, not >)", () => {
    const { tasks, registered } = mockTasks();
    const { scheduler } = setup(tasks);
    scheduler.handle({ skill: "reminder", action: "set", text: "on the line", seconds: 600 });
    expect(registered).toHaveLength(1);
  });

  test("cancelling a reminder deletes its backup task", () => {
    const { tasks, removed } = mockTasks();
    const { scheduler } = setup(tasks);
    scheduler.handle({ skill: "reminder", action: "set", text: "call the bank", seconds: 20 * 60 });
    scheduler.handle({ skill: "timer", action: "cancel", kind: "reminder", all: true });
    expect(removed).toHaveLength(1);
  });

  test("cancelling a timer or alarm never touches the reminder task host", () => {
    const { tasks, removed, registered } = mockTasks();
    const { scheduler } = setup(tasks);
    scheduler.handle({ skill: "timer", action: "start", seconds: 20 * 60, phrase: "20 minutes" });
    scheduler.handle({ skill: "timer", action: "cancel", kind: "timer", all: true });
    expect(registered).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  test("firing in-process marks it delivered and drops the now-redundant backup task", () => {
    const { tasks, delivered, removed } = mockTasks();
    const { scheduler, advance, events } = setup(tasks);
    scheduler.handle({ skill: "reminder", action: "set", text: "call the bank", seconds: 20 * 60 });
    const id = scheduler.snapshot().items[0].id;
    advance(20 * 60_000);
    expect(events).toHaveLength(1);
    expect(delivered).toEqual([id]);
    expect(removed).toEqual([id]);
  });

  test("start() sweeps stale tasks, passing only currently-active reminder ids", () => {
    const { tasks, cleanupCalls } = mockTasks();
    const root = temp();
    const scheduler = createScheduler(root, { now: () => NOW, submit: () => undefined, setTimer: (() => 1) as any, clearTimer: (() => undefined) as any, tasks });
    scheduler.handle({ skill: "reminder", action: "set", text: "call the bank", seconds: 20 * 60 });
    const id = scheduler.snapshot().items[0].id;
    scheduler.start();
    expect(cleanupCalls).toEqual([[id]]);
  });

  test("start() sweep excludes timers/alarms and anything already fired", () => {
    const { tasks, cleanupCalls } = mockTasks();
    const root = temp();
    mkdirSync(join(root, ".operator-data"), { recursive: true });
    writeFileSync(
      join(root, ".operator-data", "jarvis-timers.json"),
      JSON.stringify({
        version: 1,
        items: [
          { id: "a", kind: "timer", createdAt: new Date(NOW).toISOString(), dueAt: new Date(NOW + 3600_000).toISOString(), phrase: "1 hour" },
          { id: "b", kind: "reminder", createdAt: new Date(NOW).toISOString(), dueAt: new Date(NOW + 3600_000).toISOString(), text: "x" },
        ],
      }),
    );
    const scheduler = createScheduler(root, { now: () => NOW, submit: () => undefined, setTimer: (() => 1) as any, clearTimer: (() => undefined) as any, tasks });
    scheduler.start();
    expect(cleanupCalls).toEqual([["b"]]);
  });

  test("with no tasks host wired, reminders behave exactly as before (no crash, no calls to make)", () => {
    const root = temp();
    const events: any[] = [];
    const scheduler = createScheduler(root, { now: () => NOW, submit: (e) => void events.push(e) });
    expect(scheduler.handle({ skill: "reminder", action: "set", text: "call the bank", seconds: 20 * 60 })).toBe("I'll remind you in 20 minutes to call the bank, sir.");
    scheduler.start();
  });
});
