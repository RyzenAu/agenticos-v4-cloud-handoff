import { randomUUID } from "node:crypto";
import { emailDraftIn, calendarAddIn, composeEmail, isCalendarAdd } from "./parse";
import { FlowsStore, type EmailDraft, type EventAdd } from "./store";
import { instantOf, parseWhen, whenSaid, type Hm, type Ymd } from "./when";

/**
 * The everyday "do it for me" flows (F1, 29 Sep 2026), answered by rules before any model, typed or spoken:
 *
 *   "draft an email to Brooke saying the site preview is ready"  → an OS text draft, NEVER sent
 *   "add a meeting with Mehroz tomorrow at 3 to my calendar"     → added, read back, with an Undo
 *
 * Every line is built from what was stored and read back. Nothing is sent to anyone, no invitation goes out (no
 * guests are ever added), and a real Google or Outlook calendar is written only after the owner's own yes to the
 * exact event that was read out.
 */

export type FlowCaller = { id: string; name?: string; via?: string; actor?: string };
export type FlowReply = { say: string; navigate?: string };

export type CalendarReview = { reviewId: string; expiresAt: string; provider: string; account: string; calendar: { id: string; name: string }; event: { title: string; start: string; end: string; timeZone: string } };
/** The calendar underneath: the OS's own calendar, and (when connected with write access) Google or Outlook. */
export type CalendarPort = {
  addLocal(event: { title: string; start: string; end: string }): Promise<{ id: string }>;
  readLocal(id: string): Promise<{ id: string; title: string; start: string; end: string } | null>;
  removeLocal(id: string): Promise<boolean>;
  /** A connected calendar the owner can write to, or null (nothing connected, or read-only). */
  provider(requested?: "google" | "outlook" | null): Promise<{ provider: "google" | "outlook"; account: string; calendarId: string; calendarName: string } | null>;
  prepare(body: { provider: string; calendarId: string; title: string; start: string; end: string; timeZone: string; attendees: string[] }): Promise<CalendarReview>;
  create(body: { provider: string; reviewId: string; confirm: true }): Promise<{ status: "created" | "uncertain"; message?: string }>;
};

export type FlowsDeps = {
  root: string;
  store?: FlowsStore;
  now?: () => Date;
  contacts?: (name: string) => Promise<Array<{ name: string; email: string }>>;
  calendar?: CalendarPort | null;
  newId?: () => string;
};

type Pending =
  | { kind: "ask"; title: string | null; day: Ymd | null; time: Hm | null; durationMin: number | null; destination?: "google" | "outlook" | null; at: number }
  | { kind: "confirm"; review: CalendarReview; line: string; at: number };
type PersonState = { pending?: Pending; last?: { eventId: string; at: number } };

const TTL = 10 * 60_000;
const WHOLE_YES = /^(?:yes|yeah|yep|yes please|go ahead|do it|add it|confirm(?:ed)?|please do|sure|ok(?:ay)?)[.!]?$/i;
const WHOLE_NO = /^(?:no|nope|cancel(?: it)?|never ?mind|don'?t|do not|not now|forget it)[.!]?$/i;
const UNDO = /^(?:undo(?: that)?|cancel that|remove that|take (?:that|it) (?:off|out)|delete that)(?: (?:meeting|event|entry))?[.!]?$/i;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function createFlows(deps: FlowsDeps) {
  const store = deps.store ?? new FlowsStore(deps.root);
  const now = () => deps.now?.() ?? new Date();
  const newId = deps.newId ?? (() => randomUUID());
  const states = new Map<string, PersonState>();
  const stateOf = (id: string): PersonState => states.get(id) ?? (states.set(id, {}), states.get(id)!);

  /** The event, in the OS calendar or a connected one, and the line that says so (read back, never assumed). */
  async function place(person: string, caller: FlowCaller, ask: { title: string; day: Ymd | null; time: Hm | null; durationMin: number | null; relative?: Date | null; destination?: "google" | "outlook" | null }): Promise<FlowReply> {
    const port = deps.calendar;
    if (!port) return { say: "The calendar isn't available here, so nothing was added." };
    const start = ask.relative ? new Date(Math.round(ask.relative.getTime() / 60_000) * 60_000) : instantOf(ask.day!, ask.time!);
    const end = new Date(start.getTime() + (ask.durationMin ?? 60) * 60_000);
    const human = caller.actor === "human";
    if (!human) return { say: "A signed-in person needs to add calendar events. Nothing was added." };
    const target = await port.provider(ask.destination).catch(() => null);
    if (ask.destination && target?.provider !== ask.destination) return { say: `${ask.destination === "google" ? "Google Calendar" : "Outlook"} isn't connected with write access here, so nothing was added. Say add it to my calendar if you want a local event instead.` };
    if (target) {
      // A real calendar: the reviewed booking. What's read out is what gets written, after his own yes.
      try {
        const review = await port.prepare({ provider: target.provider, calendarId: target.calendarId, title: ask.title, start: start.toISOString(), end: end.toISOString(), timeZone: "Australia/Sydney", attendees: [] });
        const line = `Ready to add to ${target.provider === "google" ? "Google Calendar" : "Outlook"}: ${review.event.title}, ${whenSaid(new Date(review.event.start), now())}. Say yes to add it.`;
        stateOf(person).pending = { kind: "confirm", review, line, at: Date.now() };
        return { say: line };
      } catch (e) {
        return { say: `I couldn't get that ready in ${target.provider === "google" ? "Google Calendar" : "Outlook"}: ${(e as Error).message.slice(0, 120)}. Nothing was added.` };
      }
    }
    const made = await port.addLocal({ title: ask.title, start: start.toISOString(), end: end.toISOString() });
    const back = await port.readLocal(made.id);
    if (!back) return { say: "I tried to add it, but it doesn't show in your calendar, so I'm not calling it done." };
    const record: EventAdd = { id: newId(), title: back.title, start: back.start, end: back.end, where: "os", localId: back.id, createdAt: now().toISOString(), by: person, state: "added" };
    store.addEvent(record);
    stateOf(person).last = { eventId: record.id, at: Date.now() };
    return { say: `Added: ${back.title}, ${whenSaid(new Date(back.start), now())}`, navigate: "/calendar" };
  }

  /** Ask for what's missing, once; the next words fill it in. */
  function askFor(person: string, partial: { title: string | null; day: Ymd | null; time: Hm | null; durationMin: number | null; destination?: "google" | "outlook" | null }, line: string): FlowReply {
    stateOf(person).pending = { kind: "ask", ...partial, at: Date.now() };
    return { say: line };
  }

  async function complete(person: string, caller: FlowCaller, ask: { title: string | null; day: Ymd | null; time: Hm | null; durationMin: number | null; relative?: Date | null; destination?: "google" | "outlook" | null }): Promise<FlowReply> {
    if (!ask.title) return askFor(person, ask, "What should I call it?");
    if (!ask.relative) {
      if (!ask.day && !ask.time) return askFor(person, ask, "What day and time?");
      if (!ask.day) return askFor(person, ask, "What day?");
      if (!ask.time) return askFor(person, ask, "What time?");
      if (instantOf(ask.day, ask.time).getTime() <= now().getTime()) return askFor(person, { ...ask, day: null, time: null }, "That time has already passed. Which day and time?");
    }
    stateOf(person).pending = undefined;
    return place(person, caller, { ...ask, title: ask.title });
  }

  async function handle(utterance: string, turn: { caller: FlowCaller | null; spokenYes?: string | null; previousAssistant?: string | null }): Promise<FlowReply | null> {
    const caller = turn.caller;
    if (!caller?.id) return null;
    const person = caller.id;
    const text = utterance.trim().replace(/^(?:hey\s+)?jarvis[,\s]+/i, "");
    const s = stateOf(person);
    if (s.pending && Date.now() - s.pending.at > TTL) s.pending = undefined;

    // ── a reviewed real-calendar booking, waiting for his yes ──
    if (s.pending?.kind === "confirm") {
      const pending = s.pending;
      if (WHOLE_NO.test(text)) { s.pending = undefined; return { say: "Okay, not added." }; }
      if (WHOLE_YES.test(text)) {
        s.pending = undefined;
        if (caller.actor !== "human") return { say: "That needs you, signed in. Nothing was added." };
        if (turn.previousAssistant?.trim() !== pending.line) return { say: "That event review is no longer the current question. Nothing was added." };
        const port = deps.calendar;
        if (!port) return { say: "The calendar isn't available here, so nothing was added." };
        const r = await port.create({ provider: pending.review.provider, reviewId: pending.review.reviewId, confirm: true }).catch((e: Error) => ({ status: "uncertain" as const, message: e.message }));
        if (r.status !== "created") return { say: "I can't be sure it was added, so check your calendar before I try again." };
        store.addEvent({ id: newId(), title: pending.review.event.title, start: pending.review.event.start, end: pending.review.event.end, where: pending.review.provider === "outlook" ? "outlook" : "google", createdAt: now().toISOString(), by: person, state: "added" });
        return { say: `Added: ${pending.review.event.title}, ${whenSaid(new Date(pending.review.event.start), now())}`, navigate: "/calendar" };
      }
      s.pending = undefined; // anything else is a new request
    }

    // ── the answer to "what day and time?" ──
    if (s.pending?.kind === "ask") {
      const pending = s.pending;
      if (WHOLE_NO.test(text)) { s.pending = undefined; return { say: "Okay, not added." }; }
      const when = parseWhen(text, now());
      const progressed = !!(when.day || when.time || when.relative || when.durationMin);
      const asksTitle = pending.title === null && !progressed && text.length <= 80 && !calendarAddIn(text, now()) && !emailDraftIn(text);
      if (progressed || asksTitle) {
        const merged = { title: asksTitle ? cap(text.replace(/[.!?]+$/, "")) : pending.title, day: when.day ?? pending.day, time: when.time ?? pending.time, durationMin: when.durationMin ?? pending.durationMin, relative: when.relative, destination: pending.destination };
        return complete(person, caller, merged);
      }
      s.pending = undefined; // not an answer: a new request
    }

    // ── undo the event just added ──
    if (UNDO.test(text) && s.last && Date.now() - s.last.at < 15 * 60_000 && /^Added:/.test(turn.previousAssistant ?? "")) {
      const record = store.event(s.last.eventId);
      if (!record || record.state === "undone") return { say: "There's nothing to undo." };
      const undone = await undoRecord(record);
      s.last = undefined;
      return { say: undone ? `Removed: ${record.title}.` : "I couldn't remove it, so it's still on your calendar." };
    }

    // ── an email draft: never sent ──
    const email = emailDraftIn(text);
    if (email) {
      const found = deps.contacts ? await deps.contacts(email.toName).catch(() => []) : [];
      const addresses = [...new Map(found.map((c) => [c.email.toLowerCase(), c])).values()];
      const address = addresses.length === 1 ? addresses[0].email : null;
      const from = caller.name?.split(/\s+/)[0] || cap(caller.id);
      const { subject, body } = composeEmail(email, from);
      const draft: EmailDraft = { id: newId(), to: { name: email.toName, email: address }, subject, body, createdAt: now().toISOString(), by: person, via: caller.via === "voice" ? "voice" : "typed", state: "draft" };
      store.addDraft(draft);
      const first = email.toName.split(/\s+/)[0];
      return { say: `Draft saved in Inbox for review. Nothing was sent.${address ? "" : ` I don't have an address for ${first} yet.`}`, navigate: `/inbox?draft=${draft.id}` };
    }

    // ── a calendar event ──
    if (isCalendarAdd(text)) {
      const ask = calendarAddIn(text, now());
      if (!ask) return null;
      return complete(person, caller, ask);
    }
    return null;
  }

  async function undoRecord(record: EventAdd): Promise<boolean> {
    if (record.where !== "os" || !record.localId) return false;
    const removed = await deps.calendar?.removeLocal(record.localId).catch(() => false);
    if (removed && !(await deps.calendar?.readLocal(record.localId).catch(() => null))) { store.markUndone(record.id); return true; }
    return false;
  }

  return {
    handle,
    /** What the pages show: drafts to read and events just added (with Undo where it can be done). */
    recent() {
      const s = store.read();
      const cutoff = Date.now() - 24 * 3_600_000;
      return {
        emailDrafts: s.drafts.filter((d) => d.state === "draft").slice(-10).reverse(),
        events: s.events.filter((e) => Date.parse(e.createdAt) > cutoff).slice(-10).reverse().map((e) => ({ ...e, undoable: e.state === "added" && e.where === "os" })),
      };
    },
    discardDraft: (id: string) => store.discardDraft(id),
    updateDraft: (id: string, by: string, patch: { email: string | null; subject: string; body: string }) => store.updateDraft(id, by, patch),
    async undoEvent(id: string): Promise<{ ok: boolean; title?: string; reason?: string }> {
      const record = store.event(id);
      if (!record) return { ok: false, reason: "No such event." };
      if (record.state === "undone") return { ok: true, title: record.title };
      if (record.where !== "os") return { ok: false, reason: "That one is in a connected calendar; remove it there." };
      return (await undoRecord(record)) ? { ok: true, title: record.title } : { ok: false, reason: "It couldn't be removed from the calendar." };
    },
    isCalendarAdd,
    emailDraftIn,
  };
}

export type Flows = ReturnType<typeof createFlows>;
