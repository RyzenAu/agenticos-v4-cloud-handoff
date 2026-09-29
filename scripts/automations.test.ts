import { describe, expect, test } from "bun:test";
import { AutomationNotFound, automationDot, createAutomationsApi, cronScheduleEnglish, parseCronDetails } from "./automations";

const SAMPLE = [
  "  d9dc2f6b49fb [active]",
  "    Name:      jarvis-watchdog",
  "    Schedule:  every 15m",
  "    Repeat:    ∞",
  "    Next run:  2026-09-24T01:07:30.231118+10:00",
  "    Deliver:   telegram:8550678495",
  "    Script:    jarvis-watchdog.py",
  "    Mode:      no-agent (script stdout delivered directly)",
  "    Last run:  2026-09-24T00:52:30.231118+10:00  ok",
  "",
  "  c60f5ba54ac3 [active]",
  "    Name:      morning-brief",
  "    Schedule:  30 7 * * *",
  "    Repeat:    ∞",
  "    Next run:  2026-09-24T07:30:00+10:00",
  "    Deliver:   telegram:8550678495",
  "    Skills:    jarvis-capabilities, jev-decisions",
  "    Last run:  2026-09-23T20:38:57.744706+10:00  ok",
  "",
  "  ede730ae90d7 [active]",
  "    Name:      founders-weekly",
  "    Schedule:  0 8 * * 1",
  "    Next run:  2026-09-28T08:00:00+10:00",
  "    Deliver:   telegram:8550678495",
  "",
  "  a83b2e072c6b [paused]",
  "    Name:      lead-calls",
  "    Schedule:  30 8 * * 1-6",
  "    Next run:  2026-09-24T08:30:00+10:00",
  "    Deliver:   telegram:8550678495",
  "    Mode:      no-agent (script stdout delivered directly)",
  "    Last run:  2026-09-23T08:30:00+10:00  delivery_failed: 403",
].join("\n");

describe("cronScheduleEnglish", () => {
  test("every-N schedules", () => {
    expect(cronScheduleEnglish("every 15m")).toBe("Every 15 minutes");
    expect(cronScheduleEnglish("every 1m")).toBe("Every 1 minute");
    expect(cronScheduleEnglish("every 30m")).toBe("Every 30 minutes");
  });
  test("5-field cron schedules", () => {
    expect(cronScheduleEnglish("30 7 * * *")).toBe("Daily 07:30");
    expect(cronScheduleEnglish("0 8 * * 1")).toBe("Mondays 08:00");
    expect(cronScheduleEnglish("30 8 * * 1-5")).toBe("Weekdays 08:30");
    // Audit F3-14: a run of days reads as a range, not a slash-joined list.
    expect(cronScheduleEnglish("30 8 * * 1-6")).toBe("Mon–Sat 08:30");
    expect(cronScheduleEnglish("0 9 * * 0,6")).toBe("Weekends 09:00");
  });
  test("empty and unrecognised schedules", () => {
    expect(cronScheduleEnglish("")).toBe("Not scheduled");
    // Steps inside an hour window, names, L/? and both day fields set (cron ORs them) stay raw.
    expect(cronScheduleEnglish("*/15 9-17 * * 1-5")).toBe("*/15 9-17 * * 1-5");
    expect(cronScheduleEnglish("0 9 * * MON")).toBe("0 9 * * MON");
    expect(cronScheduleEnglish("0 9 L * *")).toBe("0 9 L * *");
    expect(cronScheduleEnglish("0 9 1 * 1")).toBe("0 9 1 * 1");
    expect(cronScheduleEnglish("0 25 * * *")).toBe("0 25 * * *");
  });
  // Audit F3-14: lists, ranges, several hours, day-of-month and month forms in plain English.
  test("lists, ranges and several times a day", () => {
    expect(cronScheduleEnglish("0 11,14,16 * * 1-5")).toBe("Weekdays 11:00, 14:00 and 16:00");
    expect(cronScheduleEnglish("0 8 * * 1,3,5")).toBe("Mon, Wed and Fri 08:00");
    expect(cronScheduleEnglish("0 8 * * 1,2,4")).toBe("Mon, Tue and Thu 08:00");
    expect(cronScheduleEnglish("0 9 * * 0,1")).toBe("Mon and Sun 09:00");
    expect(cronScheduleEnglish("0 9 * * 0-6")).toBe("Daily 09:00");
    expect(cronScheduleEnglish("0 9 * * 1-7")).toBe("Daily 09:00");
    expect(cronScheduleEnglish("*/5 * * * *")).toBe("Every 5 minutes");
    expect(cronScheduleEnglish("*/15 * * * 1-5")).toBe("Weekdays, every 15 minutes");
    expect(cronScheduleEnglish("5 * * * *")).toBe("Hourly at :05");
    expect(cronScheduleEnglish("0 */2 * * *")).toBe("Every 2 hours at :00");
  });
  test("day-of-month and month forms", () => {
    expect(cronScheduleEnglish("0 0 1 1 *")).toBe("Yearly on 1 January 00:00");
    expect(cronScheduleEnglish("0 9 1 * *")).toBe("Monthly on the 1st 09:00");
    expect(cronScheduleEnglish("30 18 1,15 * *")).toBe("Monthly on the 1st and 15th 18:30");
    expect(cronScheduleEnglish("0 9 22 * *")).toBe("Monthly on the 22nd 09:00");
    expect(cronScheduleEnglish("0 9 11-13 * *")).toBe("Monthly on the 11th, 12th and 13th 09:00");
    expect(cronScheduleEnglish("0 9 1 1,7 *")).toBe("On the 1st of January and July 09:00");
    expect(cronScheduleEnglish("0 9 * 12 *")).toBe("Daily in December 09:00");
  });
});

describe("automationDot", () => {
  test("green when active and last run wasn't a failure", () => {
    expect(automationDot(true, "ok")).toBe("green");
    expect(automationDot(true, "")).toBe("green");
  });
  test("amber when paused", () => {
    expect(automationDot(false, "")).toBe("amber");
  });
  test("red when the last run failed", () => {
    expect(automationDot(true, "delivery_failed: 403")).toBe("red");
    expect(automationDot(false, "error: timeout")).toBe("red");
  });
});

describe("parseCronDetails", () => {
  test("extracts id, schedule, next run, mode, deliver, dot", () => {
    const jobs = parseCronDetails(SAMPLE);
    expect(jobs).toHaveLength(4);
    const watchdog = jobs.find((j) => j.name === "jarvis-watchdog")!;
    expect(watchdog).toMatchObject({
      id: "d9dc2f6b49fb",
      schedule: "every 15m",
      scheduleText: "Every 15 minutes",
      active: true,
      nextRunAt: "2026-09-24T01:07:30.231118+10:00",
      deliver: "telegram:8550678495",
      mode: "no-agent",
      lastStatus: "ok",
      dot: "green",
    });
    const brief = jobs.find((j) => j.name === "morning-brief")!;
    expect(brief.mode).toBe("agent"); // no Mode: line → uses the LLM agent
    expect(brief.scheduleText).toBe("Daily 07:30");
    const leadCalls = jobs.find((j) => j.name === "lead-calls")!;
    expect(leadCalls.active).toBe(false);
    expect(leadCalls.dot).toBe("red"); // last run failed, even though paused now
    expect(leadCalls.scheduleText).toBe("Mon–Sat 08:30"); // F3-14: a range, not a slash-joined list
  });

  test("a finished one-shot job's literal 'Next run:  None' becomes null, not the word \"None\"", () => {
    const oneShot = [
      "  935f40e5efdf [completed]",
      "    Name:      business-dream-test",
      "    Schedule:  0 0 1 1 *",
      "    Repeat:    1/1",
      "    Next run:  None",
    ].join("\n");
    const jobs = parseCronDetails(oneShot);
    expect(jobs[0].nextRunAt).toBeNull();
  });
});

describe("createAutomationsApi", () => {
  function fakeExec(stdout = SAMPLE, ok = true) {
    const calls: { file: string; args: string[] }[] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { ok, stdout, stderr: ok ? "" : "boom" };
    };
    return { exec, calls };
  }

  test("lists and caches for cacheMs", async () => {
    const { exec, calls } = fakeExec();
    const api = createAutomationsApi({ exec, cacheMs: 10_000 });
    const first = await api.list();
    const second = await api.list();
    expect(first).toHaveLength(4);
    expect(second).toBe(first); // cached, no second exec call
    expect(calls).toHaveLength(1);
    // --all: plain `hermes cron list` hides paused jobs, which would make a paused automation
    // vanish from the page instead of showing amber (found by hand: pausing a real job made it
    // disappear from the page until --all was added).
    expect(calls[0]).toEqual({ file: "hermes", args: ["cron", "list", "--all"] });
    await api.list(true); // force bypasses the cache
    expect(calls).toHaveLength(2);
  });

  test("runNow resolves the job's id and clears the cache", async () => {
    const { exec, calls } = fakeExec();
    const api = createAutomationsApi({ exec, cacheMs: 10_000 });
    const result = await api.runNow("morning-brief");
    expect(result).toEqual({ ok: true, name: "morning-brief", action: "run" });
    expect(calls.at(-1)).toEqual({ file: "hermes", args: ["cron", "run", "c60f5ba54ac3"] });
    // Cache was cleared: the next list() call re-fetches.
    await api.list();
    expect(calls).toHaveLength(3); // list, run's own list, list again
  });

  test("pause and resume", async () => {
    const { exec, calls } = fakeExec();
    const api = createAutomationsApi({ exec, cacheMs: 10_000 });
    await api.pause("jarvis-watchdog");
    expect(calls.at(-1)).toEqual({ file: "hermes", args: ["cron", "pause", "d9dc2f6b49fb"] });
    await api.resume("jarvis-watchdog");
    expect(calls.at(-1)).toEqual({ file: "hermes", args: ["cron", "resume", "d9dc2f6b49fb"] });
  });

  test("unknown automation name throws AutomationNotFound", async () => {
    const { exec } = fakeExec();
    const api = createAutomationsApi({ exec, cacheMs: 10_000 });
    await expect(api.runNow("does-not-exist")).rejects.toBeInstanceOf(AutomationNotFound);
  });

  test("a failing hermes call surfaces its stderr", async () => {
    const { exec } = fakeExec(SAMPLE, false);
    const api = createAutomationsApi({ exec, cacheMs: 10_000 });
    await expect(api.list()).rejects.toThrow("Could not reach the Hermes cron scheduler.");
  });
});

// Track 8 / audit F3-15: `hermes cron list --all` takes 8-25 s and the page polls every 30 s.
describe("createAutomationsApi: stale-while-revalidate", () => {
  test("an old list is answered at once while one re-read runs; an action makes the next read fresh", async () => {
    let t = 0;
    const calls: string[][] = [];
    let release: (out: string) => void = () => {};
    const exec = (_file: string, args: string[]) =>
      new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
        calls.push(args);
        if (args[1] !== "list") return resolve({ ok: true, stdout: "", stderr: "" });
        release = (stdout) => resolve({ ok: true, stdout, stderr: "" });
      });
    const api = createAutomationsApi({ exec, cacheMs: 1_000, now: () => t });
    const first = api.list(); // cold: waits for the read
    release(SAMPLE);
    expect(await first).toHaveLength(4);
    expect(api.state().refreshing).toBe(false);
    t = 5_000; // older than cacheMs
    const started = performance.now();
    expect(await api.list()).toHaveLength(4); // answered from the old list...
    expect(performance.now() - started).toBeLessThan(50);
    expect(api.state().refreshing).toBe(true); // ...while one re-read runs
    await api.list();
    expect(calls.filter((a) => a[1] === "list")).toHaveLength(2); // not one per poll
    release(SAMPLE);
    await Bun.sleep(0);
    expect(api.state().checkedAt).toBe(new Date(5_000).toISOString());
    // An action: the next list can't be the pre-action one, even if a read was in flight.
    t = 20_000;
    void api.list(); // stale → background read starts
    const pending = release;
    await api.pause("morning-brief");
    const after = api.list(); // cache cleared by the action: a new read, not the in-flight one
    expect(calls.filter((a) => a[1] === "list")).toHaveLength(4);
    release(SAMPLE);
    pending(SAMPLE);
    expect(await after).toHaveLength(4);
  });
});
