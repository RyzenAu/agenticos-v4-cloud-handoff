// Timers, alarms and reminders. One small scheduler persisted to
// .operator-data/jarvis-timers.json, so a timer set before a server restart still fires after it
// (late, and saying so). When one is due it posts a Jarvis event: timers and alarms are URGENT
// (spoken even in quiet hours, flashed in call mode), reminders are NORMAL (the gate may hold them
// for the HUD). Nothing here sends, dials or messages anyone.
//
// Pattern note: the persisted {id, dueAt} store + one armed timeout mirrors leon-ai's timer skill
// (MIT, github.com/leon-ai/leon, skills/native/timer_skill) in spirit; no code was copied.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  clockWords,
  dueWords,
  formatRemaining,
  norm,
  core,
  parseClock,
  parseDuration,
  resolveClock,
  withMeridiem,
  type Clock,
  type Meridiem,
} from "./text";
import { MIN_TASK_HORIZON_MS, type ReminderTaskHost } from "../windows/reminder-tasks";

export type TimerKind = "timer" | "alarm" | "reminder";
export type ClockSpec = { hour: number; minute: number; day: "today" | "tomorrow" | null };
export type TimerRequest =
  | { skill: "timer"; action: "start"; seconds: number; phrase: string; label?: string }
  | { skill: "timer"; action: "alarm"; clock: ClockSpec; label?: string }
  | { skill: "timer"; action: "cancel"; kind: TimerKind | "any"; all?: boolean; match?: string }
  | { skill: "timer"; action: "left" }
  | { skill: "reminder"; action: "set"; text: string; seconds?: number; clock?: ClockSpec; about?: boolean }
  | { skill: "reminder"; action: "list" };
/** A spoken question back instead of a guess ("3 in the morning or the afternoon?"). */
export type AskBack = { skill: "say"; text: string };

export const MAX_TIMER_SECONDS = 24 * 3600;
export const MAX_REMINDER_SECONDS = 30 * 86400;
const MAX_TEXT = 200;

// --- ask-backs ----------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");
function meridiemQuestion(clock: Clock) {
  const said = `${clock.hour}${clock.minute ? `:${pad(clock.minute)}` : ""}`;
  if (clock.hour === 12) return `Is that ${said} midday or midnight, sir?`;
  return `Is that ${said} in the morning or the ${clock.hour < 6 || clock.hour === 12 ? "afternoon" : "evening"}, sir?`;
}
export const WHEN_QUESTION = "When should I remind you, sir? A time, or in so many minutes.";
export const WHAT_QUESTION = "What should I remind you about, sir?";
const ASK_MERIDIEM = /^Is that [\d:]+ (?:in the morning or the (?:afternoon|evening)|midday or midnight), sir\?$/;

/** "pm", "the evening", "in the morning", "midnight" → which half of the day he meant. */
export function meridiemReply(utterance: string): Meridiem | null {
  const u = norm(utterance).replace(/\./g, "").replace(/^(?:it's |it is |that's |in )?(?:the )?/, "");
  if (/^(?:pm|p m|afternoon|evening|night|tonight|midday|noon|in the (?:afternoon|evening))$/.test(u)) return "pm";
  if (/^(?:am|a m|morning|midnight|in the morning)$/.test(u)) return "am";
  return null;
}

// --- parsing -----------------------------------------------------------------------------------
const spec = (c: Clock): ClockSpec => ({ hour: c.hour, minute: c.minute, day: c.day });
const LABEL_STOP = new Set(["a", "an", "the", "my", "new", "another", "one", "quick", "second", "minute", "hour"]);

function when(text: string): { seconds: number } | { clock: Clock } | "vague" | null {
  const t = text.trim().toLowerCase();
  const inMatch = t.match(/^in (.+)$/);
  if (inMatch) {
    const d = parseDuration(inMatch[1]);
    return d ? { seconds: d.seconds } : /^in the (?:morning|afternoon|evening)$|^in a (?:bit|while)$/.test(t) ? "vague" : null;
  }
  if (/^(?:later(?: on| today)?|soon|tomorrow|tonight|this (?:morning|afternoon|evening)|(?:tomorrow |in the )(?:morning|afternoon|evening))$/.test(t)) return "vague";
  if (!/^(?:at |tomorrow|today|tonight|this )/.test(t) && !/\bat \d/.test(t)) return null;
  const c = parseClock(t);
  return c ? { clock: c } : null;
}

/**
 * Timer/alarm/reminder intents. `meridiem` settles an earlier "morning or evening?" ask-back.
 * Returns null for anything else (it goes on to the other rules, Jev and the brain).
 */
export function timerIntent(utterance: string, meridiem?: Meridiem): TimerRequest | AskBack | null {
  const u = norm(utterance).replace(/-/g, " ");
  if (!u || u.length > 240) return null;
  let m: RegExpMatchArray | null;

  // How long left.
  if (/^(?:how many (?:timers?|alarms?)(?: do i have| have i got| are (?:running|set|there|going))?|how (?:much time|long)(?: is| have i got| do i have)?(?: got)? left(?: on (?:the|my) (?:timer|alarm))?|how long is left(?: on (?:the|my) (?:timer|alarm))?|time left|(?:check|what's on|what is on) (?:the|my) timers?|how's (?:the|my) timer(?: going)?|what timers (?:do i have|are (?:running|set))|(?:any|are there any) timers(?: running| set)?)$/.test(u))
    return { skill: "timer", action: "left" };

  // Cancel.
  if ((m = u.match(/^(?:cancel|stop|clear|remove|delete|turn off|kill|scrap)\s+(all(?: of)?(?: my| the)?|the|my|that|this|both)?\s*(timers?|alarms?|reminders?)(?:\s+(?:to|about|for)\s+(.+))?$/))) {
    const kind = m[2].replace(/s$/, "") as TimerKind;
    const all = !!m[1]?.startsWith("all") || m[1] === "both" || (m[2].endsWith("s") && !m[3]);
    return { skill: "timer", action: "cancel", kind, ...(all ? { all: true } : {}), ...(m[3] ? { match: m[3].slice(0, 80) } : {}) };
  }
  if (/^(?:cancel|clear|stop) (?:all|everything)(?: timers?(?: and alarms)?)?$/.test(u)) return { skill: "timer", action: "cancel", kind: "any", all: true };

  // Reminders list.
  if (/^(?:what are|what're|list|read|tell me|show)(?: me)? my reminders|^what reminders (?:do i have|have i got|are (?:there|set))$|^(?:do i have|have i got) any reminders(?: set)?$|^any reminders$/.test(u))
    return { skill: "reminder", action: "list" };

  // Timers: "set a timer for 10 minutes", "timer 90 seconds", "set a 10 minute timer", "pasta timer 8 minutes".
  const verb = "(?:(?:set|start|put on|make|run|give me)(?: me)?\\s+)?";
  const named = "(?:\\s+(?:for|called|named)\\s+(?:the\\s+|my\\s+)?([a-z]+(?: [a-z]+)?))?";
  // "timer for 10 minutes" (duration after) or "10 minute timer" (duration before).
  const after = u.match(new RegExp(`^${verb}(?:a |an |another |the )?(?:([a-z]+)\\s+)?timer\\s+(?:(?:for|of|on)\\s+)?(.+?)${named}$`));
  const before = after ? null : u.match(new RegExp(`^${verb}(?:a |an |another )?(.+?)\\s+timer${named}$`));
  const durationText = after ? after[2] : before?.[1];
  const d = durationText ? parseDuration(durationText) : null;
  if (d) {
    if (d.seconds > MAX_TIMER_SECONDS) return { skill: "say", text: "I can only run timers up to a day, sir. Try a reminder for anything longer." };
    const label = (after ? after[1] ?? after[3] : before?.[2])?.trim();
    return { skill: "timer", action: "start", seconds: d.seconds, phrase: d.phrase, ...(label && !LABEL_STOP.has(label) && !/\d/.test(label) ? { label } : {}) };
  }

  // Alarms: "alarm at 7:30", "set an alarm for 6 am tomorrow", "wake me up at 6".
  if ((m = u.match(/^(?:(?:set|make|put)(?: me)?\s+)?(?:an?\s+|my\s+)?(?:([a-z]+)\s+)?alarm\s+(?:for|at|to)\s+(.+)$|^wake me(?: up)?\s+(?:at\s+)?(.+)$/))) {
    const text = m[2] ?? m[3];
    const clock = parseClock(text);
    if (!clock) return null;
    const settled = clock.meridiem ? clock : meridiem ? withMeridiem(clock, meridiem) : null;
    if (!settled) return { skill: "say", text: meridiemQuestion(clock) };
    const label = m[1] && !LABEL_STOP.has(m[1]) ? m[1] : undefined;
    return { skill: "timer", action: "alarm", clock: spec(settled), ...(label ? { label } : {}) };
  }

  // Reminders: "remind me in 20 minutes to call Smile Dental", "remind me to send the proposal at 3 pm".
  const original = core(utterance).replace(/[.!?]+$/, "").trim();
  const r = original.match(/^(?:(?:please\s+)?remind me|set (?:a |me a )?reminder|reminder)\b[\s:,]*(.*)$/i);
  if (!r) return null;
  let rest = r[1].trim();
  if (!rest) return { skill: "say", text: WHAT_QUESTION };
  let text = "";
  let about = /^about\b/i.test(rest);
  let found: ReturnType<typeof when> = null;
  // WHEN first: "in 20 minutes to …", "at 3 pm to …", "tomorrow at 9 to …".
  const lead = rest.match(/^((?:in|at|tomorrow|today|tonight|this)\b.*?)\s+(to|that|about)\s+(.+)$/i);
  if (lead) {
    const w = when(lead[1]);
    if (w) {
      found = w;
      text = lead[3];
      about = lead[2].toLowerCase() === "about";
    }
  }
  if (!found) {
    // "to X in 20 minutes", "to X at 3 pm", "about X tomorrow at 9": the first split whose tail is a time.
    const body = rest.replace(/^(?:to|that|about|for)\s+/i, "");
    if (body === rest && !/^(?:for|to|that|about)\b/i.test(rest)) {
      // "remind me 3 pm send the proposal" is too loose to act on.
      const loose = when(rest);
      if (loose) return { skill: "say", text: WHAT_QUESTION };
    }
    const splits = [...body.matchAll(/\s(?=(?:in|at|tomorrow|today|tonight|this)\b)/gi)].map((x) => x.index!);
    for (const at of splits) {
      const w = when(body.slice(at + 1));
      if (w) {
        found = w;
        text = body.slice(0, at);
        break;
      }
    }
    if (!found) text = body;
  }
  text = text.replace(/^(?:to|that|about)\s+/i, "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!text) return { skill: "say", text: WHAT_QUESTION };
  if (!found || found === "vague") return { skill: "say", text: WHEN_QUESTION };
  if ("seconds" in found) {
    if (found.seconds > MAX_REMINDER_SECONDS) return { skill: "say", text: "I only keep reminders for up to 30 days, sir." };
    return { skill: "reminder", action: "set", text, seconds: found.seconds, ...(about ? { about } : {}) };
  }
  const clock = found.clock.meridiem ? found.clock : meridiem ? withMeridiem(found.clock, meridiem) : null;
  if (!clock) return { skill: "say", text: meridiemQuestion(found.clock) };
  return { skill: "reminder", action: "set", text, clock: spec(clock), ...(about ? { about } : {}) };
}

/**
 * The owner's answer to one of our ask-backs, merged with the request that caused it. `previous`
 * is his earlier words, `asked` what Jarvis said back. Null when this isn't such an answer.
 */
export function answerAskBack(utterance: string, previous: string, asked: string): TimerRequest | AskBack | null {
  if (ASK_MERIDIEM.test(asked.trim())) {
    const half = meridiemReply(utterance);
    if (half) {
      const result = timerIntent(previous, half);
      return result && result.skill !== "say" ? result : null;
    }
    return null;
  }
  const reply = core(utterance).replace(/[.!?]+$/, "").trim();
  if (/^(?:never ?mind|cancel|forget it|no|nothing|stop|don't worry)\b/i.test(reply)) return null;
  if (asked.trim() === WHAT_QUESTION) {
    const what = reply.replace(/^(?:to|about|that)\s+/i, "");
    return what ? timerIntent(`${core(previous).replace(/[.!?]+$/, "")} to ${what}`) : null;
  }
  if (asked.trim() === WHEN_QUESTION) {
    const said = norm(utterance);
    const phrase = /^\d/.test(said) || /^(?:noon|midday|midnight)/.test(said) ? `at ${said}` : said;
    const w = when(phrase);
    if (!w || w === "vague") return null;
    return timerIntent(`${core(previous).replace(/[.!?]+$/, "")} ${phrase}`);
  }
  return null;
}

// --- the scheduler ------------------------------------------------------------------------------
export type TimerItem = {
  id: string;
  kind: TimerKind;
  createdAt: string;
  dueAt: string;
  /** timer: "10 minutes"; alarm: label; reminder: his words. */
  phrase?: string;
  label?: string;
  text?: string;
};
type Store = { version: 1; items: TimerItem[] };
type Submit = (body: { source: string; text: string; priority: "low" | "normal" | "urgent"; dedupeKey: string }) => unknown;
export type SchedulerOptions = {
  now?: () => number;
  submit: Submit;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /**
   * Windows-native backup: a reminder due more than MIN_TASK_HORIZON_MS out also gets a one-shot
   * Scheduled Task, so it still fires (as a toast) if this process isn't running at the time. See
   * ../windows/reminder-tasks.ts. Omit in tests to keep the scheduler pure — nothing here ever
   * shells out unless a host is passed in.
   */
  tasks?: ReminderTaskHost;
};

const MAX_ITEMS = 50;
const MAX_FILE = 128 * 1024;
const MAX_WAIT = 60_000;

/** "pasta timer", "10-minute timer", "timer for 1 hour 30 minutes". */
export function timerName(item: Pick<TimerItem, "label" | "phrase">) {
  if (item.label) return `${item.label} timer`;
  if (item.phrase && !/\d+ \w+ \d/.test(item.phrase)) return `${item.phrase.replace(/^(\S+) (\w+?)s?$/, "$1-$2")} timer`;
  return `timer for ${item.phrase ?? "a while"}`;
}

/** What Jarvis says when an item comes due; `lateMs` > 1 min adds that it was missed. */
export function dueLine(item: TimerItem, lateMs = 0) {
  const at = Date.parse(item.dueAt);
  let line: string;
  if (item.kind === "timer") line = `Your ${timerName(item)} is done, sir.`;
  else if (item.kind === "alarm") line = `It's ${clockWords(at)}, sir. ${item.label ? `Your ${item.label} alarm.` : "Your alarm."}`;
  else line = `Reminder, sir: ${item.text ?? "you asked me to remind you."}`;
  if (lateMs > 60_000) line += ` It was due at ${clockWords(at)}, while I was offline.`;
  return line.slice(0, 300);
}

export function createScheduler(root: string, options: SchedulerOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const tasks = options.tasks;
  const directory = join(root, ".operator-data");
  const file = join(directory, "jarvis-timers.json");
  let armed: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function read(): Store {
    try {
      if (!existsSync(file) || statSync(file).size > MAX_FILE) return { version: 1, items: [] };
      const data = JSON.parse(readFileSync(file, "utf8"));
      const items = Array.isArray(data?.items) ? data.items : [];
      return {
        version: 1,
        items: items.filter(
          (i: TimerItem) => i && typeof i.id === "string" && ["timer", "alarm", "reminder"].includes(i.kind) && Number.isFinite(Date.parse(i.dueAt)),
        ),
      };
    } catch {
      return { version: 1, items: [] };
    }
  }
  function write(store: Store) {
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temporary, JSON.stringify(store, null, 2));
    renameSync(temporary, file);
  }

  /** Fire everything due, then arm one timeout for the next (capped, so clock drift self-heals). */
  function tick() {
    if (closed) return;
    const at = now();
    const store = read();
    const due = store.items.filter((i) => Date.parse(i.dueAt) <= at + 250);
    if (due.length) {
      store.items = store.items.filter((i) => !due.includes(i));
      write(store);
      for (const item of due) {
        const late = at - Date.parse(item.dueAt);
        if (item.kind === "reminder" && tasks) {
          // Delivered in-process: record it (in case the task fires anyway, e.g. a near-miss
          // race) and drop the now-redundant backup task.
          tasks.markDelivered(item.id);
          void tasks.remove(item.id).catch(() => undefined);
        }
        try {
          options.submit({
            source: item.kind === "reminder" ? "jarvis-reminder" : "jarvis-timer",
            text: dueLine(item, late),
            // Hours late is history, not an emergency: the HUD shows it without a voice.
            priority: late > 2 * 3600_000 ? "low" : item.kind === "reminder" ? "normal" : "urgent",
            dedupeKey: `timer:${item.id}`,
          });
        } catch {
          /* the gate refused it (e.g. malformed); nothing else to do */
        }
      }
    }
    arm();
  }
  function arm() {
    if (armed) clearTimer(armed);
    armed = undefined;
    if (closed) return;
    const next = read().items.reduce((min, i) => Math.min(min, Date.parse(i.dueAt)), Infinity);
    if (!Number.isFinite(next)) return;
    const wait = Math.max(0, Math.min(next - now(), MAX_WAIT));
    armed = setTimer(tick, wait);
    (armed as { unref?: () => void }).unref?.();
  }

  function add(item: Omit<TimerItem, "id" | "createdAt">) {
    const store = read();
    if (store.items.length >= MAX_ITEMS) throw new Error("You've fifty timers and reminders already, sir. Cancel a few first.");
    const at = now();
    const full: TimerItem = { id: `t_${at.toString(36)}_${randomUUID().slice(0, 6)}`, createdAt: new Date(at).toISOString(), ...item };
    store.items.push(full);
    write(store);
    arm();
    // Backup Scheduled Task for reminders only, and only when it's worth the overhead — a timer
    // or alarm under the horizon relies on the in-process timeout alone (see MIN_TASK_HORIZON_MS).
    if (full.kind === "reminder" && tasks && Date.parse(full.dueAt) - at >= MIN_TASK_HORIZON_MS) {
      void tasks.register({ id: full.id, dueAt: full.dueAt, text: full.text ?? "" }).catch(() => undefined);
    }
    return full;
  }
  function remove(ids: string[]) {
    const store = read();
    const removed = tasks ? store.items.filter((i) => ids.includes(i.id)) : [];
    store.items = store.items.filter((i) => !ids.includes(i.id));
    write(store);
    arm();
    if (tasks) for (const item of removed) if (item.kind === "reminder") void tasks.remove(item.id).catch(() => undefined);
  }
  function list(kind?: TimerKind) {
    return read()
      .items.filter((i) => !kind || i.kind === kind)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  const describe = (i: TimerItem) =>
    i.kind === "timer" ? timerName(i) : i.kind === "alarm" ? `${i.label ? `${i.label} ` : ""}alarm for ${clockWords(Date.parse(i.dueAt))}` : `reminder to ${i.text}`;

  /** Runs one request; returns the line Jarvis says. */
  function handle(req: TimerRequest): string {
    const at = now();
    if (req.skill === "timer" && req.action === "start") {
      add({ kind: "timer", dueAt: new Date(at + req.seconds * 1000).toISOString(), phrase: req.phrase, ...(req.label ? { label: req.label } : {}) });
      return req.label ? `${req.label[0].toUpperCase()}${req.label.slice(1)} timer set for ${req.phrase}, sir.` : `Timer set for ${req.phrase}, sir.`;
    }
    if (req.skill === "timer" && req.action === "alarm") {
      const { at: due, tomorrow } = resolveClock(at, { ...req.clock, meridiem: req.clock.hour < 12 ? "am" : "pm" });
      add({ kind: "alarm", dueAt: new Date(due).toISOString(), ...(req.label ? { label: req.label } : {}) });
      return `Alarm set for ${clockWords(due)}${tomorrow ? " tomorrow" : ""}, sir.`;
    }
    if (req.skill === "reminder" && req.action === "set") {
      let due: number;
      if (req.seconds) due = at + req.seconds * 1000;
      else if (req.clock) due = resolveClock(at, { ...req.clock, meridiem: req.clock.hour < 12 ? "am" : "pm" }).at;
      else return WHEN_QUESTION;
      add({ kind: "reminder", dueAt: new Date(due).toISOString(), text: req.text });
      return `I'll remind you ${dueWords(at, due)} ${req.about ? "about" : "to"} ${req.text}, sir.`;
    }
    if (req.skill === "reminder" && req.action === "list") {
      const items = list("reminder");
      if (!items.length) return "You've no reminders set, sir.";
      const shown = items.slice(0, 4).map((i) => `${dueWords(at, Date.parse(i.dueAt))}, ${i.text}`);
      return `You have ${items.length} reminder${items.length === 1 ? "" : "s"}: ${shown.join("; ")}${items.length > 4 ? `; and ${items.length - 4} more` : ""}.`;
    }
    if (req.skill === "timer" && req.action === "left") {
      const items = list().filter((i) => i.kind !== "reminder");
      if (!items.length) return "No timers or alarms running, sir.";
      const lines = items.slice(0, 3).map((i) =>
        i.kind === "timer" ? `${formatRemaining(Date.parse(i.dueAt) - at)} left on your ${describe(i)}` : `your ${describe(i)} goes off ${dueWords(at, Date.parse(i.dueAt))}`,
      );
      const text = lines.join("; ");
      return `${text[0].toUpperCase()}${text.slice(1)}${items.length > 3 ? `, and ${items.length - 3} more` : ""}.`;
    }
    if (req.skill === "timer" && req.action === "cancel") {
      let items = list(req.kind === "any" ? undefined : req.kind);
      const noun = req.kind === "any" ? "timers, alarms or reminders" : `${req.kind}s`;
      if (!items.length) return `There are no ${noun} to cancel, sir.`;
      if (req.match) {
        const words = req.match.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const scored = items
          .map((i) => ({ i, hits: words.filter((w) => `${i.text ?? ""} ${i.label ?? ""} ${i.phrase ?? ""}`.toLowerCase().includes(w)).length }))
          .filter((x) => x.hits > 0)
          .sort((a, b) => b.hits - a.hits);
        if (!scored.length) return `I can't find a ${req.kind === "any" ? "timer or reminder" : req.kind} about that, sir.`;
        items = [scored[0].i];
      } else if (!req.all && items.length > 1) {
        // "Cancel the timer" with several running: the most recently set one.
        const latest = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        remove([latest.id]);
        return `Cancelled your ${describe(latest)}. ${items.length - 1} more still set, sir.`;
      }
      remove(items.map((i) => i.id));
      return items.length === 1 ? `Cancelled your ${describe(items[0])}, sir.` : `Cancelled all ${items.length} ${noun}, sir.`;
    }
    return "I didn't catch that timer, sir.";
  }

  function snapshot() {
    return {
      now: new Date(now()).toISOString(),
      items: list().map((i) => ({
        id: i.id,
        kind: i.kind,
        dueAt: i.dueAt,
        createdAt: i.createdAt,
        label: i.kind === "reminder" ? (i.text ?? "").slice(0, 80) : i.kind === "timer" ? (i.label ?? i.phrase ?? "Timer") : (i.label ?? "Alarm"),
      })),
    };
  }

  return {
    handle,
    snapshot,
    /** Fire anything missed while the server was down, then arm the next. */
    start() {
      closed = false;
      tick();
      // Crash/restart cleanup: a cancellation or firing that couldn't reach schtasks (process
      // killed mid-call) can leave an orphaned \MU\JarvisReminder-* task behind. Sweep them here.
      if (tasks) {
        const activeIds = read()
          .items.filter((i) => i.kind === "reminder")
          .map((i) => i.id);
        void tasks.cleanupStale(activeIds).catch(() => undefined);
      }
    },
    close() {
      closed = true;
      if (armed) clearTimer(armed);
      armed = undefined;
    },
    file,
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
