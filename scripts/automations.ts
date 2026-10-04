// The Automations page: read-only view of Hermes' cron jobs plus run-now/pause/resume.
// Never spawns a shell (execFile with argument arrays, via capability-registry's
// resolveCommand — the same resolution `hermes cron list` already uses for the registry).
import { execFile } from "node:child_process";
import { parseCronList, resolveCommand } from "./capability-registry";
import { ServiceUnavailable } from "./http/errors";

export type AutomationDot = "green" | "amber" | "red";

export type Automation = {
  id: string;
  name: string;
  schedule: string;
  scheduleText: string;
  active: boolean;
  lastRunAt: string | null;
  lastStatus: string;
  nextRunAt: string | null;
  deliver: string;
  mode: string;
  dot: AutomationDot;
};

export type Exec = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** execFile with an argument array — no shell, so nothing in a job name is interpreted. */
export const execHermes: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    const [command, argv] = resolveCommand(file, args);
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
    const child = execFile(
      command,
      argv,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout || "", stderr: stderr || "" }),
    );
    child.stdin?.end();
  });

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const UNIT_NAMES: Record<string, string> = { s: "second", m: "minute", h: "hour", d: "day" };

function pad2(value: string | number) {
  return String(value).padStart(2, "0");
}

/** "1,3-5" → [1,3,4,5] within [lo, hi]; null for steps, names or anything else. */
function cronList(field: string, lo: number, hi: number): number[] | null {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(field)) return null;
  const out: number[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    const from = Number(range ? range[1] : part);
    const to = Number(range ? range[2] : part);
    if (from > to || from < lo || to > hi) return null;
    for (let v = from; v <= to; v++) out.push(v);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function cronDayList(dow: string): number[] | null {
  const days = cronList(dow, 0, 7);
  return days ? [...new Set(days.map((d) => d % 7))].sort((a, b) => a - b) : null;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: string[]) {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Runs of 3+ consecutive values collapse to "first–last". */
function runs(values: number[], name: (v: number) => string) {
  const parts: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    if (j - i >= 2) parts.push(`${name(values[i])}–${name(values[j])}`);
    else for (let k = i; k <= j; k++) parts.push(name(values[k]));
    i = j + 1;
  }
  return parts;
}

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

function dayOfWeekText(dow: string): string | null {
  if (dow === "*") return "Daily";
  const days = cronDayList(dow);
  if (!days || !days.length) return null;
  if (days.length === 7) return "Daily";
  if (days.join() === "1,2,3,4,5") return "Weekdays";
  if (days.join() === "0,6") return "Weekends";
  if (days.length === 1) return DAY_NAMES[days[0]];
  // Sunday-wrapped weeks read better starting Monday ("Mon–Sat, Sun" never happens: 0 sorts first).
  const monFirst = days[0] === 0 ? [...days.slice(1), 7] : days;
  return joinAnd(runs(monFirst, (d) => DAY_SHORT[d % 7]));
}

function timeText(min: string, hour: string): string | null {
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === "*") return `every ${every[1]} minutes`;
  if (!/^\d{1,2}$/.test(min) || Number(min) > 59) return null;
  if (hour === "*") return `hourly at :${pad2(min)}`;
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep) return `every ${hourStep[1]} hours at :${pad2(min)}`;
  const hours = cronList(hour, 0, 23);
  if (!hours) return null;
  return joinAnd(hours.map((h) => `${pad2(h)}:${pad2(min)}`));
}

/**
 * A Hermes cron schedule string ("every 15m", "30 8 * * 1-5", "0 0 1 1 *") into plain English:
 * lists and ranges of days ("Mon–Sat", "Mon, Wed and Fri"), several hours ("11:00, 14:00 and 16:00"),
 * day-of-month ("Monthly on the 1st") and month ("Yearly on 1 January"). Anything else stays raw.
 */
export function cronScheduleEnglish(schedule: string): string {
  const raw = (schedule || "").trim();
  if (!raw) return "Not scheduled";
  const every = /^every\s+(\d+)\s*([smhd])$/i.exec(raw);
  if (every) {
    const n = Number(every[1]);
    const unit = UNIT_NAMES[every[2].toLowerCase()] ?? "unit";
    return `Every ${n} ${unit}${n === 1 ? "" : "s"}`;
  }
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return raw;
  const [min, hour, dom, mon, dow] = fields;
  const time = timeText(min, hour);
  if (!time) return raw;
  const clock = /^\d/.test(time); // "08:30", not "every 15 minutes"
  const at = (lead: string) => (clock ? `${lead} ${time}` : `${lead}, ${time}`);

  if (dom === "*" && mon === "*") {
    if (!clock && dow === "*") return time[0].toUpperCase() + time.slice(1);
    const days = dayOfWeekText(dow);
    return days ? at(days) : raw;
  }
  // Cron ORs day-of-month with day-of-week when both are set: too easy to misread, so keep it raw.
  if (dow !== "*") return raw;
  const doms = dom === "*" ? null : cronList(dom, 1, 31);
  const months = mon === "*" ? null : cronList(mon, 1, 12);
  if ((dom !== "*" && !doms) || (mon !== "*" && !months)) return raw;
  if (doms && !months) return at(`Monthly on the ${joinAnd(doms.map(ordinal))}`);
  const monthNames = joinAnd(runs(months!, (m) => MONTH_NAMES[m - 1]));
  if (!doms) return at(`Daily in ${monthNames}`);
  if (months!.length === 1) return at(`Yearly on ${joinAnd(doms.map(String))} ${monthNames}`);
  return at(`On the ${joinAnd(doms.map(ordinal))} of ${monthNames}`);
}

/** green: active, last run wasn't a failure. amber: paused. red: last run failed/errored. */
export function automationDot(active: boolean, lastStatus: string): AutomationDot {
  if (/fail|error|blocked/i.test(lastStatus)) return "red";
  return active ? "green" : "amber";
}

function splitCronBlocks(text: string): string[] {
  return text.split(/\n(?=\s*[0-9a-f]{12}\s*\[)/);
}

/** Richer than capability-registry's parseCronList (id, schedule, next run, mode) — built on
 *  top of it for the fields it already extracts (name, active, last status, deliver target). */
export function parseCronDetails(text: string): Automation[] {
  const basicByName = new Map(parseCronList(text).map((job) => [job.name, job]));
  const out: Automation[] = [];
  for (const block of splitCronBlocks(text)) {
    const head = /([0-9a-f]{12})\s*\[(\w+)\]/.exec(block);
    const name = /Name:\s+(.+)/.exec(block)?.[1]?.trim();
    if (!head || !name) continue;
    const basic = basicByName.get(name);
    const active = head[2] === "active";
    const schedule = /Schedule:\s+(.+)/.exec(block)?.[1]?.trim() ?? "";
    // A finished one-shot job prints "Next run:  None" (Python's str(None)) — treat that the
    // same as no line at all, rather than showing the literal word "None" on the page.
    const nextRunRaw = /Next run:\s+(\S+)/.exec(block)?.[1]?.trim() || null;
    const nextRunAt = nextRunRaw && nextRunRaw.toLowerCase() !== "none" ? nextRunRaw : null;
    const mode = /Mode:\s+(\S+)/.exec(block)?.[1]?.trim() ?? "agent";
    const lastRun = /Last run:\s+(\S+)\s+(.+)/.exec(block);
    const deliver = /Deliver:\s+(\S+)/.exec(block)?.[1]?.trim() ?? basic?.deliver ?? "";
    const lastStatus = lastRun?.[2]?.trim() ?? basic?.lastStatus ?? "";
    out.push({
      id: head[1],
      name,
      schedule,
      scheduleText: cronScheduleEnglish(schedule),
      active,
      lastRunAt: lastRun?.[1] ?? null,
      lastStatus,
      nextRunAt,
      deliver,
      mode,
      dot: automationDot(active, lastStatus),
    });
  }
  return out;
}

export class AutomationNotFound extends Error {}

export function createAutomationsApi(options: { exec?: Exec; cacheMs?: number; now?: () => number } = {}) {
  const exec = options.exec ?? execHermes;
  const now = options.now ?? Date.now;
  // `hermes cron list --all` takes 8-25 s (audit F3-15) and the page polls every 30 s: a list older
  // than cacheMs is still answered at once while ONE re-read runs in the background.
  const cacheMs = options.cacheMs ?? 120_000;
  let cache: { at: number; jobs: Automation[] } | null = null;
  let reading: Promise<Automation[]> | null = null;
  /** Bumped by every action, so a read that started before it never overwrites what it changed. */
  let generation = 0;

  let readingGeneration = -1;
  function read(): Promise<Automation[]> {
    // A read that started before an action can't answer for after it.
    if (reading && readingGeneration === generation) return reading;
    const started = generation;
    readingGeneration = started;
    // --all: plain `hermes cron list` hides paused jobs entirely, which would make a paused
    // automation vanish from the page instead of showing amber.
    const mine: Promise<Automation[]> = exec("hermes", ["cron", "list", "--all"], 60_000)
      .then((result) => {
        if (!result.ok) throw new ServiceUnavailable("Could not reach the Hermes cron scheduler.");
        const jobs = parseCronDetails(result.stdout);
        if (started === generation) cache = { at: now(), jobs };
        return jobs;
      })
      .finally(() => {
        if (reading === mine) reading = null;
      });
    reading = mine;
    return mine;
  }

  async function list(force = false): Promise<Automation[]> {
    if (!force && cache) {
      if (now() - cache.at >= cacheMs) void read().catch(() => undefined);
      return cache.jobs;
    }
    return read();
  }

  /** When the list shown was read, and whether a re-read is running (for the page's "checked" line). */
  function state() {
    return { checkedAt: cache ? new Date(cache.at).toISOString() : null, refreshing: Boolean(reading) };
  }

  async function find(name: string): Promise<Automation> {
    const jobs = await list();
    const job = jobs.find((j) => j.name === name);
    if (!job) throw new AutomationNotFound(`No automation named "${name}".`);
    return job;
  }

  async function act(kind: "run" | "pause" | "resume", name: string) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) throw new Error("Choose an automation.");
    const job = await find(trimmed);
    const args = kind === "run" ? ["cron", "run", job.id] : kind === "pause" ? ["cron", "pause", job.id] : ["cron", "resume", job.id];
    const result = await exec("hermes", args, 30_000);
    if (!result.ok)
      throw new Error(`hermes cron ${kind} failed: ${(result.stderr || result.stdout).trim().slice(0, 300) || "unknown error"}`);
    cache = null; // next read reflects the change
    generation++;
    return { ok: true, name: job.name, action: kind };
  }

  return {
    list,
    state,
    runNow: (name: string) => act("run", name),
    pause: (name: string) => act("pause", name),
    resume: (name: string) => act("resume", name),
  };
}
