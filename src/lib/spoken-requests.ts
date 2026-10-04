// Ported (the pure parts only) from Dot's historical branch refs/dot/hist/cloud/f1-flows-wip, scripts/flows/parse.ts (commit 1e32908a,
// "M&U Cloud Handoff Import"). Licence check: that branch's LICENSE blob is byte-identical to this repository's own (Claude OS, Personal & Commercial Use
// License with Attribution), so the code is covered by the licence it already ships under; no third-party code is involved. Nothing from the branch's
// flows service, live ports or store is ported: this file reads words and returns data, and does nothing.
// What differs from the original: the changes are the import paths (./sydney-when, and a type import of ChatCalendarDraft) and the calendarDraftFromWords adapter added at the end, which is NOT from the branch.
/**
 * Spoken or typed words for the two everyday "do it for me" flows (F1 flows 4 and 5): an email DRAFT (never a
 * send) and a calendar event. Pure: the words in, a typed request out, nothing done.
 */
import type { ChatCalendarDraft } from "./chat-calendar";
import { instantOf, parseWhen, type Hm, type Ymd } from "./sydney-when";

// ─────────────────────────── email drafts ───────────────────────────

export type EmailAsk = { toName: string; kind: "saying" | "about"; clause: string };

const TYPE = String.raw`(?:e-?mail|email|message|note)`;
const DRAFT_VERB = String.raw`(?:draft|write|compose|prepare|put together|start|make|create|send|shoot|fire off|dash off)`;
const LINK = String.raw`(saying|that says|telling (?:him|her|them)(?: that)?|to say|letting (?:him|her|them) know(?: that)?|to let (?:him|her|them) know(?: that)?|about|regarding|re:?)`;
const LEAD = String.raw`^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:i (?:want|need|'d like) you to\s+)?`;
const DRAFT_RE = new RegExp(`${LEAD}${DRAFT_VERB}\\s+(?:me\\s+)?(?:an?\\s+|the\\s+)?(?:quick\\s+|short\\s+|new\\s+)?${TYPE}\\s+(?:to|for)\\s+(.{2,60}?)\\s+${LINK}\\s+(.{3,400})$`, "i");
const PLAIN_RE = new RegExp(`${LEAD}(?:e-?mail|mail)\\s+(.{2,60}?)\\s+${LINK}\\s+(.{3,400})$`, "i");

/** "draft an email to Brooke saying the site preview is ready" → { toName: "Brooke", kind: "saying", clause }. */
export function emailDraftIn(utterance: string): EmailAsk | null {
  const t = utterance.trim().replace(/[.!?]+$/, "");
  const m = DRAFT_RE.exec(t) ?? PLAIN_RE.exec(t);
  if (!m) return null;
  const toName = m[1].trim().replace(/^(?:to\s+)?(?:my\s+)?/i, "").replace(/\s+(?:please|now)$/i, "").trim();
  if (!toName || /^(?:me|myself|everyone|everybody|all)$/i.test(toName)) return null;
  const link = m[2].toLowerCase();
  const kind = /^(?:about|regarding|re)/.test(link) ? "about" : "saying";
  const clause = m[3].trim().replace(/^that\s+/i, "");
  return { toName, kind, clause };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const withStop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The subject, greeting and body for an ask, in the sender's voice. Adds nothing he didn't say. */
export function composeEmail(ask: EmailAsk, from: string): { subject: string; body: string } {
  const clause = ask.clause.replace(/\s+/g, " ").trim();
  const first = ask.toName.split(/\s+/)[0];
  const subjectSource = clause.replace(/[.!?]+$/, "");
  const subject = capitalise(subjectSource.length > 60 ? `${subjectSource.slice(0, 57).replace(/\s+\S*$/, "")}…` : subjectSource);
  const line = ask.kind === "about" ? `I'm getting in touch about ${clause.replace(/[.!?]+$/, "")}.` : withStop(capitalise(clause));
  return { subject, body: `Hi ${first},\n\n${line}\n\nKind regards,\n${from}` };
}

// ─────────────────────────── calendar ───────────────────────────

export type CalendarAsk = {
  destination: "google" | "outlook" | null;
  title: string | null;
  day: Ymd | null;
  time: Hm | null;
  durationMin: number | null;
  relative: Date | null;
};

const CAL_VERB = /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:add|put|schedule|book(?: in)?|create|set up|pop|stick|block out|make|pencil in)\s+(.+)$/i;
const CAL_WHERE = /\s+(?:to|on|in|into|onto)\s+(?:my|the|our)\s+(?:(?:usman'?s|mehroz'?s|work|google|outlook)\s+)?calendar\b/i;

/** Is this "add … to my calendar"? Needs the calendar named, so "book a table" and "add a lead" are never it. */
export function isCalendarAdd(utterance: string): boolean {
  const t = utterance.trim().replace(/[.!?]+$/, "");
  return CAL_VERB.test(t) && CAL_WHERE.test(t);
}

/**
 * "add a meeting with Mehroz tomorrow at 3 to my calendar" → { title: "Meeting with Mehroz", day: tomorrow, time: 3 pm }.
 * A missing day or time comes back null so the caller can ask for it, once. `now` is an instant. Pure.
 */
export function calendarAddIn(utterance: string, now: Date): CalendarAsk | null {
  const t = utterance.trim().replace(/[.!?]+$/, "");
  const verb = CAL_VERB.exec(t);
  if (!verb || !CAL_WHERE.test(t)) return null;
  const middle = verb[1].replace(CAL_WHERE, " ").replace(/\s+/g, " ").trim();
  const when = parseWhen(middle, now);
  const destination = /\bgoogle\s+calendar\b/i.test(t) ? "google" : /\boutlook\s+calendar\b/i.test(t) ? "outlook" : null;
  return { title: titleFrom(when.rest), day: when.day, time: when.time, durationMin: when.durationMin, relative: when.relative, destination };
}

/** The event's name from what's left of his words: "a meeting with Mehroz on" → "Meeting with Mehroz". */
export function titleFrom(rest: string): string | null {
  let s = rest
    .replace(/^(?:a|an|the|another|new)\s+/i, "")
    .replace(/^(?:(?:calendar\s+)?event|entry|appointment|reminder)\s+(?:called|named|titled|for|about)\s+/i, "")
    .replace(/^(?:new\s+)?(?:calendar\s+)?event\s*$/i, "")
    .replace(/[\s,;:-]+$/g, "")
    .replace(/(?:\s+(?:on|at|for|to|from|by|around|about|this|next|in))+$/i, "")
    .replace(/^(?:on|at|for|to|from|by)\s+/i, "")
    .replace(/["“”]/g, "")
    .trim();
  if (!s) return null;
  // A name after "with" is a name, however the words were transcribed: "meeting with mehroz" → "Meeting with Mehroz".
  s = s.replace(/\bwith\s+(?!(?:the|a|an|my|our|your|his|her|their|some|all|no|us|me|him|them|team|staff|client|clients)\b)([a-z][a-z'-]*(?:\s+and\s+(?!(?:the|a|an|my|our)\b)[a-z][a-z'-]*)?)/g, (_m, names: string) => `with ${names.replace(/\b(?!and\b)[a-z]/g, (c) => c.toUpperCase())}`);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────────────────── into the existing calendar review card ───────────────────────────

/**
 * The words as the draft the existing review card (ChatCalendarReview) already shows, with no model call: an event needs a name, a day and a
 * time; anything missing comes back as ONE question, never a guess. Nothing is booked here: the card's own explicit controls do that. Default
 * length one hour. null: not a calendar request (it must name the calendar), so every other path is unchanged. Pure.
 */
export function calendarDraftFromWords(utterance: string, now: Date): ChatCalendarDraft | { question: string } | null {
  const ask = calendarAddIn(utterance, now);
  if (!ask) return null;
  if (!ask.title) return { question: "What should the event be called?" };
  let start: Date;
  if (ask.relative) start = ask.relative;
  else if (ask.day && ask.time) start = instantOf(ask.day, ask.time);
  else if (ask.day) return { question: "What time?" };
  else if (ask.time) return { question: "Which day?" };
  else return { question: "What day and time?" };
  const end = new Date(start.getTime() + (ask.durationMin ?? 60) * 60_000);
  return { title: ask.title, start: start.toISOString(), end: end.toISOString(), location: "", attendees: [] };
}
