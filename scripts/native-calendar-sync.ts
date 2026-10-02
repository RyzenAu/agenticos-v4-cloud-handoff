import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { withConnectedRead, type ConnectedTool } from "./codex-connected-read";
import { calendarRange, type CalendarCoverage } from "./calendar-read";
import type { CalendarEvent, OperatorState } from "../src/lib/operator";
import { dataDirFor } from "./cloud/data-dir";

const required = [
  "google_calendar.get_profile",
  "google_calendar.list_calendars",
  "google_calendar.search_events",
];
/** Why the Codex route can't refresh, so the UI names one cause and one owner action. */
export type NativeCalendarProblem =
  | "codex-missing"
  | "codex-unverified"
  | "account-changed"
  | "codex-unavailable"
  | "sync-failed";
export type NativeCalendarSaved = {
  enabled: boolean;
  account?: string;
  calendarId?: string;
  coverage?: CalendarCoverage;
  error?: string;
  problem?: NativeCalendarProblem;
  failedAt?: string;
};
type Saved = NativeCalendarSaved;
/** One sentence per cause. The owner action is the same everywhere calendar data is shown. */
export const NATIVE_CALENDAR_PROBLEMS: Record<
  NativeCalendarProblem,
  { message: string; ownerAction: string }
> = {
  "codex-missing": {
    message: "Google Calendar is no longer connected in Codex, so your calendar can't refresh.",
    ownerAction:
      "Open Settings → Connections and connect Google (allow calendar access), or reconnect the Google Calendar app in Codex.",
  },
  "codex-unverified": {
    message: "Codex's Google Calendar link couldn't be verified as one read-only account.",
    ownerAction:
      "Reconnect the Google Calendar app in Codex, or connect Google in Settings → Connections.",
  },
  "account-changed": {
    message: "The Google Calendar account in Codex is different from the one you chose here.",
    ownerAction:
      'Choose "Use Google Calendar" on the Calendar page to switch to it, or reconnect the original account in Codex.',
  },
  "codex-unavailable": {
    message: "Codex isn't answering, so your calendar can't refresh.",
    ownerAction: "Open Codex and check you're signed in. The calendar retries every 15 minutes.",
  },
  "sync-failed": {
    message: "The last calendar refresh failed.",
    ownerAction:
      "Refresh the calendar again. If it keeps failing, connect Google in Settings → Connections.",
  },
};
class CalendarSyncError extends Error {
  constructor(
    message: string,
    readonly problem: NativeCalendarProblem,
  ) {
    super(message);
  }
}
const text = (value: unknown, limit = 1000) =>
  typeof value === "string" ? value.slice(0, limit) : "";
/** Tells "the connector is gone" apart from "it's there but can't be trusted". */
function probe(tools: Record<string, ConnectedTool>): {
  account: string;
  problem?: NativeCalendarProblem;
} {
  const account = identity(tools);
  if (account) return { account };
  return {
    account: "",
    problem: required.some((name) => tools[name]) ? "codex-unverified" : "codex-missing",
  };
}
function identity(tools: Record<string, ConnectedTool>) {
  const account = text(tools[required[0]]?._meta?.link_owner_profile?.email, 300).toLowerCase();
  return account &&
    required.every(
      (name) =>
        tools[name]?.annotations?.readOnlyHint === true &&
        tools[name]?.annotations?.destructiveHint !== true &&
        text(tools[name]?._meta?.link_owner_profile?.email, 300).toLowerCase() === account,
    )
    ? account
    : "";
}

export function nativeCalendarEvent(
  raw: any,
  account: string,
  calendar: { id: string; name: string },
): CalendarEvent {
  const start = text(raw?.start, 80),
    end = text(raw?.end, 80),
    id = text(raw?.id, 1024);
  if (
    !id ||
    !start ||
    !end ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(end) < Date.parse(start)
  )
    throw new Error("Google Calendar returned an incomplete event. Saved events were preserved.");
  const prefix = `google:${createHash("sha256").update(account).digest("hex").slice(0, 12)}:`;
  // The connector also serializes date-only boundaries as offset-free midnight.
  const dateBoundary = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?)?$/;
  const allDay =
    dateBoundary.test(start) && dateBoundary.test(end) && end.slice(0, 10) > start.slice(0, 10);
  return {
    id: prefix + id,
    title: text(raw.summary) || "Busy",
    start: allDay ? start.slice(0, 10) : start,
    end: allDay ? end.slice(0, 10) : end,
    allDay,
    location: text(raw.location),
    notes: text(raw.description, 8000),
    actions: [],
    source: "google",
    calendarId: calendar.id,
    calendarName: calendar.name,
  };
}

/** Primary calendar only. Credentials stay in Codex; this adapter exposes no writes. */
/** How long a Codex calendar check is reused before status() re-checks in the background (was 60 s). */
export const DISCOVERY_TTL_MS = 5 * 60_000;

export function nativeCalendarSync(
  root: string,
  options: {
    load: () => OperatorState;
    save: (state: OperatorState) => void;
    connectedRead?: typeof withConnectedRead;
    /**
     * A quiet or preview copy (audit F3-26): a GET must not start a Codex app-server that reaches
     * the owner's real Google account from a synthetic home. status() then reports "not checked".
     */
    quiet?: boolean;
    /** Unused since T8c (status() no longer checks); kept so existing callers still type-check. */
    statusWaitMs?: number;
  },
) {
  const connectedRead = options.connectedRead || withConnectedRead;
  const directory = join(dataDirFor(root)),
    file = join(directory, "native-calendar.json");
  const read = (): Saved =>
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { enabled: false };
  const save = (value: Saved) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  let syncing = false;
  type Found = { at: number; account: string; problem?: NativeCalendarProblem };
  let cached: Found | undefined;
  let discovering: Promise<Found> | undefined;
  const discover = async () => {
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached;
    if (!discovering)
      discovering = connectedRead(root, async (client) => probe(client.tools))
        .then((found) => {
          cached = { at: Date.now(), ...found };
          return cached;
        })
        .finally(() => {
          discovering = undefined;
        });
    return discovering;
  };
  const api = {
    /**
     * GET /calendar/native. Never starts Codex (T8c, lead decision; the audit F3-26 quiet-copy rule
     * now applies everywhere): it answers from the last Codex check, which check(), a sync (the
     * refresh button, the calendar page's own action) or the 15-minute server background sync
     * made. Before any check it is the last-known saved choice, marked checked: false.
     */
    async status() {
      const saved = read();
      if (!cached) {
        return {
          ...saved,
          configured: saved.enabled,
          available: false,
          // The saved choice stands until a check says otherwise (it still refreshes on the schedule).
          enabled: saved.enabled,
          savedAccount: saved.account,
          readOnly: true,
          syncing,
          checked: false,
          canCheck: !options.quiet,
          checking: !!discovering,
          note: options.quiet
            ? "Not checked in a quiet preview copy: checking would start Codex with the owner's accounts."
            : discovering
              ? "Checking whether Codex has a Google Calendar connection…"
              : "Not checked yet. Use Check Codex to look for a Google Calendar connection.",
        };
      }
      const { account, problem: found } = cached;
      const problem: NativeCalendarProblem | undefined = !saved.enabled
        ? undefined
        : found
          ? found
          : saved.account && saved.account !== account
            ? "account-changed"
            : saved.problem;
      return {
        ...saved,
        configured: saved.enabled,
        available: !!account,
        enabled: saved.enabled && saved.account === account,
        account,
        savedAccount: saved.account,
        readOnly: true,
        syncing,
        checkedAt: new Date(cached.at).toISOString(),
        checking: !!discovering,
        problem,
        ownerAction: problem ? NATIVE_CALENDAR_PROBLEMS[problem].ownerAction : undefined,
        error: problem
          ? problem === "sync-failed" && saved.error
            ? saved.error
            : NATIVE_CALENDAR_PROBLEMS[problem].message
          : saved.error,
      };
    },
    /** POST /calendar/native/check: an explicit request to ask Codex now (refused on a quiet copy). */
    async check() {
      if (options.quiet) return api.status();
      cached = undefined;
      try {
        await discover();
        return api.status();
      } catch (error) {
        const saved = read();
        const problem: NativeCalendarProblem | undefined = saved.enabled ? "codex-unavailable" : undefined;
        return {
          ...(await api.status()),
          available: false,
          problem,
          ownerAction: problem ? NATIVE_CALENDAR_PROBLEMS[problem].ownerAction : undefined,
          error: (error as Error).message,
        };
      }
    },
    disable() {
      save({ ...read(), enabled: false });
      return { enabled: false };
    },
    async sync(input: { enable?: boolean; timeMin?: unknown; timeMax?: unknown } = {}) {
      if (syncing) throw new Error("Google Calendar is already refreshing.");
      const previous = read();
      if (!previous.enabled && input.enable !== true)
        throw new Error("Connect Google Calendar before refreshing.");
      const range = calendarRange(input);
      if (Date.parse(range.timeMax) - Date.parse(range.timeMin) > 100 * 86400000)
        throw new Error("Choose a calendar window of up to 100 days.");
      syncing = true;
      let reachedCodex = false;
      const unchanged = () => {
        if (JSON.stringify(read()) !== JSON.stringify(previous))
          throw new Error("Calendar settings changed during refresh. Saved events were preserved.");
      };
      try {
        return await connectedRead(root, async (client) => {
          reachedCodex = true;
          const { account, problem } = probe(client.tools);
          cached = { at: Date.now(), account, problem }; // status() reflects what this read found
          if (!account)
            throw new CalendarSyncError(
              "Connect Google Calendar in Codex, then check again here.",
              problem || "codex-missing",
            );
          if (previous.account && previous.account !== account && input.enable !== true)
            throw new CalendarSyncError(
              "Your Google Calendar account changed. Connect it again before refreshing.",
              "account-changed",
            );
          const verify = async () => {
            unchanged();
            const profile = await client.call(required[0], {});
            if (text((profile.profile || profile).email, 300).toLowerCase() !== account)
              throw new Error("The calendar profile does not match the connected account.");
            unchanged();
          };
          await verify();
          let calendar: { id: string; name: string } | undefined, pageToken: string | undefined;
          const seenCalendars = new Set<string>();
          for (let page = 0; page < 5 && !calendar; page++) {
            const result = await client.call(required[1], {
              max_results: 20,
              ...(pageToken ? { next_page_token: pageToken } : {}),
            });
            if (!Array.isArray(result.calendars) || result.calendars.length > 20)
              throw new Error("Google Calendar returned an incomplete calendar list.");
            const primary = result.calendars.find(
              (item: any) =>
                item.primary === true && ["owner", "writer", "reader"].includes(item.access_role),
            );
            if (primary && typeof primary.id === "string")
              calendar = { id: primary.id, name: text(primary.summary) || "Primary calendar" };
            if (calendar || !result.next_page_token) break;
            pageToken = text(result.next_page_token, 8000);
            if (!pageToken || seenCalendars.has(pageToken))
              throw new Error("Google Calendar repeated a calendar page.");
            seenCalendars.add(pageToken);
          }
          if (!calendar)
            throw new Error(
              "Your primary Google Calendar was not found. Saved events were preserved.",
            );
          const events = new Map<string, CalendarEvent>(),
            seen = new Set<string>();
          pageToken = undefined;
          let complete = false;
          for (let page = 0; page < 10; page++) {
            unchanged();
            const result = await client.call(required[2], {
              calendar_id: calendar.id,
              time_min: range.timeMin,
              time_max: range.timeMax,
              timezone_str: "UTC",
              max_results: 100,
              ...(pageToken ? { next_page_token: pageToken } : {}),
            });
            if (!Array.isArray(result.events) || result.events.length > 100)
              throw new Error("Google Calendar returned an incomplete event page.");
            for (const raw of result.events) {
              if (raw.status === "cancelled") continue;
              const event = nativeCalendarEvent(raw, account, calendar);
              if (
                Date.parse(event.start) < Date.parse(range.timeMax) &&
                Date.parse(event.end) >= Date.parse(range.timeMin)
              )
                events.set(event.id, event);
            }
            if (!result.next_page_token) {
              complete = true;
              break;
            }
            pageToken = text(result.next_page_token, 8000);
            if (!pageToken || seen.has(pageToken))
              throw new Error(
                "Google Calendar repeated an event page. Saved events were preserved.",
              );
            seen.add(pageToken);
          }
          if (!complete)
            throw new Error(
              "This window contains more than 1,000 events. Choose a shorter window.",
            );
          await verify();
          const state = options.load(),
            old = new Map(state.events.map((event) => [event.id, event]));
          const prefix = `google:${createHash("sha256").update(account).digest("hex").slice(0, 12)}:`;
          state.events = state.events.filter(
            (event) =>
              !events.has(event.id) &&
              !(
                event.id.startsWith(prefix) &&
                event.calendarId === calendar.id &&
                Date.parse(event.start) < Date.parse(range.timeMax) &&
                Date.parse(event.end) >= Date.parse(range.timeMin)
              ),
          );
          for (const event of events.values())
            state.events.push({
              ...event,
              notes: old.get(event.id)?.notes || event.notes,
              actions: old.get(event.id)?.actions || [],
            });
          const coverage: CalendarCoverage = {
            ...range,
            syncedAt: new Date().toISOString(),
            calendarCount: 1,
            eventCount: events.size,
            calendars: [calendar],
            complete: true,
          };
          options.save(state);
          save({ enabled: true, account, calendarId: calendar.id, coverage });
          cached = { at: Date.now(), account };
          return { events: events.size, account, coverage, readOnly: true };
        });
      } catch (error) {
        // Codex failing to start or answer never reaches the work callback: that's "unavailable".
        const problem: NativeCalendarProblem =
          error instanceof CalendarSyncError
            ? error.problem
            : reachedCodex
              ? "sync-failed"
              : "codex-unavailable";
        if (JSON.stringify(read()) === JSON.stringify(previous))
          save({
            ...previous,
            error: (error as Error).message,
            problem,
            failedAt: new Date().toISOString(),
          });
        throw error;
      } finally {
        syncing = false;
      }
    },
    /**
     * Server-side refresh (see calendar-health.ts): runs on OS start and every 15 minutes whether
     * or not a page is open. Only refreshes a calendar the owner already chose; never enables one.
     */
    async backgroundSync(now = Date.now()) {
      const saved = read();
      if (!saved.enabled) return { ok: true as const, skipped: "not-enabled" as const };
      if (syncing) return { ok: true as const, skipped: "busy" as const };
      try {
        const result = await api.sync({
          timeMin: new Date(now - 14 * 86400000).toISOString(),
          timeMax: new Date(now + 80 * 86400000).toISOString(),
        });
        return { ok: true as const, events: result.events };
      } catch (error) {
        return { ok: false as const, error: (error as Error).message, problem: read().problem };
      }
    },
  };
  return api;
}
