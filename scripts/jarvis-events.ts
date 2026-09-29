// Jarvis interjection gate: the one queue every proactive alert goes through (cron scripts,
// watchers, coaches). It decides — deterministically, with no model — whether an event may be
// spoken, shown on the HUD only, or flashed with a chime. It never sends, dials or messages
// anyone: the only output is a spoken line or a HUD entry on this PC.
//
// Rules (JARVIS-V3 research, section 2 "Proactive speech"):
//   - dedupe by key: a replayed alert with a live key is one event, never a second one;
//   - one alert per event: speech is claimed exactly once (POST /jarvis/events/claim);
//   - stale events expire and are dropped;
//   - a daily speech budget (12 a day by default; urgent exempt);
//   - quiet hours 22:00–07:00 Sydney (urgent exempt);
//   - quiet mode (switched on by him or by "shutdown"): nothing spoken, urgent flashes;
//   - call mode: nothing spoken, urgent flashes with a chime, the rest goes to the HUD;
//   - low priority is HUD/inbox only.
// "Never while he is speaking or Jarvis is mid-turn" is enforced by the voice client, which
// only speaks a claimed line when the conversation is idle.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Priority = "low" | "normal" | "urgent";
export type Delivery = "speak" | "hud" | "flash";
export type JarvisEvent = {
  id: string;
  seq: number;
  source: string;
  text: string;
  priority: Priority;
  dedupeKey: string;
  createdAt: string;
  expiresAt: string;
  /** What the gate decided when it arrived. A "speak" still needs a claim at speaking time. */
  delivery: Delivery;
  reason: string;
  spokenAt?: string;
  /** Set when no voice client had polled recently, so this also went out as a Windows toast. */
  toastedAt?: string;
};
export type QuietMode = { on: boolean; until: string | null };
export type GateState = {
  version: 1;
  seq: number;
  events: JarvisEvent[];
  /** dedupeKey → epoch ms until which the same key is a duplicate. */
  seen: Record<string, number>;
  quiet: QuietMode;
  callMode: boolean;
  spoken: { date: string; count: number };
};
export type GateOptions = {
  now?: () => number;
  dailyBudget?: number;
  quietHours?: { start: number; end: number };
  /**
   * How long since the last GET /jarvis/events poll before no voice client is assumed to be
   * listening (the panel isn't open). Default 30s. See POLL_FALLBACK_MS and onFallbackToast.
   */
  pollFallbackMs?: number;
  /**
   * Called once, synchronously, for an event that would have been spoken but no client has
   * polled recently — the Windows-toast fallback. Defaults to a no-op: this module stays
   * pure/side-effect-free by default, and the caller wires a real notifier, e.g.
   * `import { showWindowsToast } from "./windows/jarvis-toast"` and
   * `onFallbackToast: (event) => showWindowsToast(event.source, event.text)`.
   */
  onFallbackToast?: (event: JarvisEvent) => void;
};

export const DAILY_SPEECH_BUDGET = 12;
export const QUIET_HOURS = { start: 22, end: 7 };
export const POLL_FALLBACK_MS = 30_000;

/** True once `at` is far enough past the last poll that no client is assumed to be listening. */
export function pollIsStale(lastPolledAt: number, at: number, windowMs: number = POLL_FALLBACK_MS): boolean {
  return at - lastPolledAt > windowMs;
}
const MAX_TEXT = 300;
const MAX_EVENTS = 100;
const MAX_SEEN = 300;
const MAX_FILE_BYTES = 256 * 1024;
const HOUR = 3_600_000;
const DEFAULT_TTL: Record<Priority, number> = { low: 4 * HOUR, normal: 30 * 60_000, urgent: 2 * HOUR };
const MAX_TTL = 24 * HOUR;
/** A replay of the same key inside this window is the same event, even after it expired. */
const DEDUPE_WINDOW = 24 * HOUR;

const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

export function sydneyParts(ms: number) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

export function inQuietHours(ms: number, hours = QUIET_HOURS) {
  const { hour } = sydneyParts(ms);
  return hours.start > hours.end ? hour >= hours.start || hour < hours.end : hour >= hours.start && hour < hours.end;
}

/** Validated input for POST /jarvis/events. Throws a plain message on anything off. */
export function parseEventInput(body: unknown, now: number) {
  const input = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const allowed = ["source", "text", "priority", "dedupeKey", "expiresAt"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error(`Events take only ${allowed.join(", ")}.`);
  const source = typeof input.source === "string" ? clean(input.source).toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9 ._:-]{0,39}$/.test(source)) throw new Error("source must be a short name such as watchdog or crm-coach.");
  const text = typeof input.text === "string" ? clean(input.text) : "";
  if (!text) throw new Error("text is required.");
  if (text.length > MAX_TEXT) throw new Error(`text must be ${MAX_TEXT} characters or fewer.`);
  const priority = input.priority === undefined ? "normal" : input.priority;
  if (priority !== "low" && priority !== "normal" && priority !== "urgent") throw new Error("priority must be low, normal or urgent.");
  let dedupeKey = typeof input.dedupeKey === "string" ? clean(input.dedupeKey).slice(0, 120) : "";
  if (input.dedupeKey !== undefined && !dedupeKey) throw new Error("dedupeKey must be text.");
  if (!dedupeKey) dedupeKey = `${source}:${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 16)}`;
  let expires = now + DEFAULT_TTL[priority];
  if (input.expiresAt !== undefined) {
    const at = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
    if (!Number.isFinite(at)) throw new Error("expiresAt must be an ISO date.");
    if (at <= now) throw new Error("expiresAt is already in the past.");
    expires = Math.min(at, now + MAX_TTL);
  }
  return { source, text, priority: priority as Priority, dedupeKey, expiresAt: expires };
}

function blank(): GateState {
  return { version: 1, seq: 0, events: [], seen: {}, quiet: { on: false, until: null }, callMode: false, spoken: { date: "", count: 0 } };
}

export function createJarvisEvents(root: string, options: GateOptions = {}) {
  const now = options.now ?? Date.now;
  const budget = options.dailyBudget ?? DAILY_SPEECH_BUDGET;
  const hours = options.quietHours ?? QUIET_HOURS;
  const pollFallbackMs = options.pollFallbackMs ?? POLL_FALLBACK_MS;
  const onFallbackToast = options.onFallbackToast ?? (() => {});
  const directory = join(root, ".operator-data");
  const file = join(directory, "jarvis-events.json");
  // Not persisted: purely a live "is anyone listening" signal for this process. Losing it on
  // restart just means the next eligible event assumes nobody's connected — the safe default.
  let lastPolledAt = 0;

  function read(): GateState {
    try {
      if (!existsSync(file) || statSync(file).size > MAX_FILE_BYTES) return blank();
      const data = JSON.parse(readFileSync(file, "utf8"));
      const state = { ...blank(), ...data } as GateState;
      if (!Array.isArray(state.events) || typeof state.seen !== "object" || !state.seen) return blank();
      return state;
    } catch {
      return blank();
    }
  }

  function write(state: GateState) {
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, file);
  }

  /** Drop expired events and old dedupe keys; lift a timed quiet mode that has run out. */
  function prune(state: GateState, at: number) {
    state.events = state.events.filter((e) => Date.parse(e.expiresAt) > at).slice(-MAX_EVENTS);
    const seen = Object.entries(state.seen).filter(([, until]) => until > at);
    state.seen = Object.fromEntries(seen.slice(-MAX_SEEN));
    if (state.quiet.on && state.quiet.until && Date.parse(state.quiet.until) <= at) state.quiet = { on: false, until: null };
    const today = sydneyParts(at).date;
    if (state.spoken.date !== today) state.spoken = { date: today, count: 0 };
    return state;
  }

  function mode(state: GateState, at: number) {
    return {
      quiet: state.quiet,
      quietHours: inQuietHours(at, hours),
      quietHoursWindow: `${String(hours.start).padStart(2, "0")}:00–${String(hours.end).padStart(2, "0")}:00 Sydney`,
      callMode: state.callMode,
      mode: state.callMode ? ("call" as const) : state.quiet.on || inQuietHours(at, hours) ? ("quiet" as const) : ("normal" as const),
      budget: { spoken: state.spoken.count, limit: budget },
    };
  }

  /** The rule table. Pure given the state and the clock. */
  function decide(state: GateState, priority: Priority, at: number): { delivery: Delivery; reason: string } {
    if (priority === "low") return { delivery: "hud", reason: "low priority stays on the HUD" };
    if (state.callMode)
      return priority === "urgent"
        ? { delivery: "flash", reason: "call mode: urgent flashes with a chime, no speech" }
        : { delivery: "hud", reason: "call mode: held for the HUD" };
    if (state.quiet.on)
      return priority === "urgent"
        ? { delivery: "flash", reason: "quiet mode: urgent flashes, no speech" }
        : { delivery: "hud", reason: "quiet mode: held for the HUD" };
    if (priority === "urgent") return { delivery: "speak", reason: "urgent" };
    if (inQuietHours(at, hours)) return { delivery: "hud", reason: "quiet hours" };
    if (state.spoken.count >= budget) return { delivery: "hud", reason: "daily speech budget used" };
    return { delivery: "speak", reason: "eligible" };
  }

  function submit(body: unknown) {
    const at = now();
    const input = parseEventInput(body, at);
    const state = prune(read(), at);
    const live = state.events.find((e) => e.dedupeKey === input.dedupeKey);
    if (live || state.seen[input.dedupeKey]) {
      return { accepted: false, duplicate: true, event: live ?? null, ...mode(state, at) };
    }
    const { delivery, reason } = decide(state, input.priority, at);
    const event: JarvisEvent = {
      id: `ev_${at.toString(36)}_${(state.seq + 1).toString(36)}`,
      seq: ++state.seq,
      source: input.source,
      text: input.text,
      priority: input.priority,
      dedupeKey: input.dedupeKey,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(input.expiresAt).toISOString(),
      delivery,
      reason,
    };
    // Windows-toast fallback: this event would have been spoken, but no voice client has
    // polled recently enough to assume the panel is open — so it would otherwise vanish.
    if (delivery === "speak" && pollIsStale(lastPolledAt, at, pollFallbackMs)) {
      event.toastedAt = new Date(at).toISOString();
      onFallbackToast(event);
    }
    state.events.push(event);
    state.seen[input.dedupeKey] = Math.max(input.expiresAt, at + DEDUPE_WINDOW);
    write(prune(state, at));
    return { accepted: true, duplicate: false, event, ...mode(state, at) };
  }

  function list(since: unknown) {
    const at = now();
    lastPolledAt = at; // a GET here is what "a voice client is listening" means.
    const state = prune(read(), at);
    const after = Number.isFinite(Number(since)) ? Number(since) : 0;
    return { seq: state.seq, events: state.events.filter((e) => e.seq > after), ...mode(state, at) };
  }

  /**
   * The voice client asks just before speaking. Only the first claim of a "speak" event wins, and
   * the rules are re-checked now: call mode or quiet may have started since it arrived.
   */
  function claim(body: unknown) {
    const id = body && typeof body === "object" ? (body as Record<string, unknown>).id : undefined;
    if (typeof id !== "string" || !id) throw new Error("Choose an event.");
    const at = now();
    const state = prune(read(), at);
    const event = state.events.find((e) => e.id === id);
    if (!event) return { speak: false, reason: "expired or unknown" };
    if (event.spokenAt) return { speak: false, reason: "already spoken" };
    if (event.delivery !== "speak") return { speak: false, reason: event.reason };
    const { delivery, reason } = decide(state, event.priority, at);
    if (delivery !== "speak") {
      event.delivery = delivery;
      event.reason = reason;
      write(state);
      return { speak: false, reason };
    }
    event.spokenAt = new Date(at).toISOString();
    if (event.priority !== "urgent") state.spoken.count++;
    write(state);
    return { speak: true, text: event.text, event };
  }

  function setQuiet(body: unknown) {
    const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (typeof input.on !== "boolean") throw new Error("Say on: true or on: false.");
    const at = now();
    const state = prune(read(), at);
    let until: string | null = null;
    if (input.on) {
      if (input.until !== undefined && input.minutes !== undefined) throw new Error("Give until or minutes, not both.");
      if (input.until !== undefined) {
        const ms = typeof input.until === "string" ? Date.parse(input.until) : NaN;
        if (!Number.isFinite(ms) || ms <= at) throw new Error("until must be a future ISO date.");
        until = new Date(Math.min(ms, at + 7 * 24 * HOUR)).toISOString();
      } else if (input.minutes !== undefined) {
        const minutes = Number(input.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 7 * 24 * 60) throw new Error("minutes must be between 1 and a week.");
        until = new Date(at + minutes * 60_000).toISOString();
      }
    }
    state.quiet = { on: input.on, until };
    write(state);
    return mode(state, at);
  }

  function setCallMode(on: boolean) {
    const at = now();
    const state = prune(read(), at);
    state.callMode = on;
    write(state);
    return mode(state, at);
  }

  function status() {
    const at = now();
    return mode(prune(read(), at), at);
  }

  return { submit, list, claim, setQuiet, setCallMode, status, file };
}

export type JarvisEvents = ReturnType<typeof createJarvisEvents>;
