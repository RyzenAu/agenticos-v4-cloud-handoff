import { randomUUID } from "node:crypto";
import type { OperatorState } from "../../src/lib/operator";
import type { CalendarPort, FlowsDeps } from "./service";

/**
 * The flows' live wiring on the hub (F1): the OS calendar through the operator state, a connected Google or
 * Outlook calendar through the existing reviewed-booking routes (/connections/calendar/*), and the recipient's
 * address from mail already in the inbox. Kept here so operator-plugin.ts only gains a few additive lines.
 * Never sends, deletes or invites anything.
 */

type Accounts = { handle(path: string, method: string, body: unknown, res: unknown): Promise<unknown> };
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function liveCalendarPort(options: { load: () => OperatorState; save: (state: OperatorState) => void; accounts?: Accounts | null; newId?: () => string }): CalendarPort {
  const newId = options.newId ?? (() => randomUUID().replace(/-/g, "").slice(0, 12));
  const accounts = options.accounts ?? null;
  const call = async (path: string, method: string, body: unknown) => (await accounts!.handle(path, method, body, {})) as any;
  return {
    async addLocal(event) {
      const state = options.load();
      const id = newId();
      state.events.push({ id, title: text(event.title, 250), start: event.start, end: event.end, allDay: false, location: "", attendees: "", notes: "", source: "local", actions: [] });
      options.save(state);
      return { id };
    },
    async readLocal(id) {
      const found = options.load().events.find((e) => e.id === id);
      return found ? { id: found.id, title: found.title, start: found.start, end: found.end } : null;
    },
    async removeLocal(id) {
      const state = options.load();
      const before = state.events.length;
      // Only an event this flow made (source "local"); an imported or synced one is never removed from here.
      state.events = state.events.filter((e) => !(e.id === id && e.source === "local"));
      if (state.events.length === before) return false;
      options.save(state);
      return true;
    },
    async provider(requested) {
      if (!accounts) return null;
      const status = await call("/connections", "GET", {});
      const account = (status?.accounts ?? []).find((a: any) => (a.id === "google" || a.id === "outlook") && (!requested || a.id === requested) && a.connected && a.capabilities?.calendarCreate === true);
      if (!account) return null;
      const list = await call("/connections/calendar/options", "POST", { provider: account.id });
      const calendar = (list?.calendars ?? [])[0];
      return calendar ? { provider: account.id, account: String(account.email ?? ""), calendarId: String(calendar.id), calendarName: String(calendar.name ?? "Calendar") } : null;
    },
    prepare: async (body) => (await call("/connections/calendar/prepare", "POST", body)) as any,
    create: async (body) => (await call("/connections/calendar/create", "POST", body)) as any,
  };
}

/** "Brooke Lindqvist <brooke@example.com>" → { name, email }; a bare address → its local part as the name. */
function contactOf(from: string): { name: string; email: string } | null {
  const angle = /^\s*"?([^"<]*?)"?\s*<([^<>\s@]+@[^<>\s]+)>\s*$/.exec(from);
  if (angle) return { name: angle[1].trim() || angle[2].split("@")[0], email: angle[2].trim() };
  const bare = /^\s*([^<>\s@]+@[^<>\s]+)\s*$/.exec(from);
  return bare ? { name: bare[1].split("@")[0], email: bare[1] } : null;
}

/** People already in the inbox whose name has this first name in it: the only source for an address. */
export function inboxContacts(load: () => OperatorState): NonNullable<FlowsDeps["contacts"]> {
  return async (name) => {
    const first = name.trim().split(/\s+/)[0]?.toLowerCase();
    if (!first || first.length < 2) return [];
    const wanted = new RegExp(`(?:^|[^a-z])${first.replace(/[^a-z0-9]/g, "")}(?:[^a-z]|$)`, "i");
    const seen = new Map<string, { name: string; email: string }>();
    for (const item of load().inbox ?? []) {
      if (item.direction === "outbound") continue;
      const who = contactOf(String(item.from ?? ""));
      if (who && wanted.test(who.name)) seen.set(who.email.toLowerCase(), who);
      if (seen.size > 5) break;
    }
    return [...seen.values()];
  };
}
