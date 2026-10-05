/**
 * Read lanes for the OS's own data (5 Oct, founder testing): plain questions answered from the real services by rule, before Jev and
 * without a model. Calendar (the saved events the Calendar page shows), "what needs my attention" (the same panels Home reads) and an
 * agent's status (the job store). AI spend is the ai_usage skill, a deal's stage and next action are the CRM's own intents. Pure parsing
 * and wording here; the services are handed in by the caller. Nothing here writes, opens or sends anything.
 */
import { needsMeIntent } from "../workspace/needs-you-voice";
import { aiUsageIntent } from "../ai-usage/jarvis-intent";
import { crmIntentIn } from "./crm";

export type OsRead = { kind: "calendar"; day: "today" | "tomorrow" } | { kind: "needs" } | { kind: "agent"; botId: string; name: string };

const clean = (utterance: string) =>
  String(utterance ?? "")
    .replace(/[’`]/g, "'")
    .replace(/^\s*(?:(?:hey|ok|okay)[,\s]+)?(?:jarvis[,\s]+)?/i, "")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const CALENDAR =
  /^(?:what(?:'s| is| do i have)|what have i got|anything|do i have anything|show(?: me)?|tell me)\s+(?:(?:is\s+)?on\s+)?(?:in\s+)?(?:my|the|our)\s+(?:calendar|schedule|diary)(?:\s+(?:for|on))?\s*(today|tomorrow)?$|^(?:what(?:'s| is)|what have i got|do i have anything)\s+(?:on\s+)?(today|tomorrow)(?:\s+(?:on|in)\s+(?:my|the)\s+(?:calendar|schedule|diary))?$|^(?:what|which)\s+(?:meetings|events|appointments)\s+do\s+i\s+have\s+(today|tomorrow)$|^(?:my\s+)?(?:calendar|schedule)\s+(?:for\s+)?(today|tomorrow)$/i;
/** "what needs my attention (right now)", "what needs attention", "anything need my attention", beside needs-you-voice's own forms. */
const ATTENTION = /^(?:what(?:'s| is)?|anything|is there anything(?: that)?|does anything)\s+(?:needs?|needing|waiting for)\s+(?:my|our)?\s*attention(?:\s+(?:today|now|right now|at the moment))?$/i;
const AGENT_STATUS = (name: string) =>
  new RegExp(String.raw`^(?:what(?:'s| is)\s+(?:the\s+)?${name}(?:\s+(?:agent|bot))?\s+(?:working on|doing|up to|busy with)(?:\s+(?:now|right now|at the moment))?|what(?:'s| is)\s+(?:the\s+)?${name}(?:\s+(?:agent|bot))?(?:'s)?\s+status|(?:is\s+)?(?:the\s+)?${name}(?:\s+(?:agent|bot))?\s+(?:busy|idle|free|working)(?:\s+(?:now|right now))?|status\s+of\s+(?:the\s+)?${name}(?:\s+(?:agent|bot))?)$`, "i");

/** The OS read in these words, or null. `bots`: the agents this person may see (their names are the only ones matched). */
export function osReadIn(utterance: string, bots: readonly { id: string; name: string }[] = []): OsRead | null {
  const u = clean(utterance);
  if (!u || u.length > 120) return null;
  const c = CALENDAR.exec(u);
  if (c) return { kind: "calendar", day: (c[1] ?? c[2] ?? c[3] ?? c[4] ?? "today").toLowerCase() === "tomorrow" ? "tomorrow" : "today" };
  if (ATTENTION.test(u) || needsMeIntent(utterance)) return { kind: "needs" };
  for (const b of bots) {
    const name = b.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (name && AGENT_STATUS(name).test(u)) return { kind: "agent", botId: b.id, name: b.name };
  }
  return null;
}

/** "this month" unless he said last month ("how much did we spend on AI last month"). */
export function aiSpendAsked(utterance: string): { month: "this" | "last" } | null {
  const intent = aiUsageIntent(utterance);
  if (!intent || intent.action !== "spend" || ("provider" in intent && intent.provider) || ("wontPay" in intent && intent.wontPay)) return null;
  return { month: /\b(?:last|previous)\s+month\b/i.test(utterance) ? "last" : "this" };
}

export type AiTotalsLike = { month: { label: string }; totals: { fixedAud: number; meteredAud: number; monthAud: number; projectedAud: number; unknown: readonly string[] } };
const aud = (n: number) => `A$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** The figure the Finance page shows as "AI spend, month to date" (the /__ai_usage snapshot's totals), as one typed answer. Pure. */
export function aiSpendSaid(snap: AiTotalsLike, month: "this" | "last"): string {
  const t = snap.totals;
  const name = snap.month.label.split(" ")[0] || "month";
  const now = `AI spend so far this ${name} is ${aud(t.monthAud)}: ${aud(t.fixedAud)} in subscriptions and ${aud(t.meteredAud)} of metered API use. On track for ${aud(t.projectedAud)} by month end.${t.unknown.length ? ` Not in the total: ${t.unknown.length} item${t.unknown.length === 1 ? "" : "s"} with no readable price.` : ""}`;
  return month === "last" ? `I only have the current month's AI spend here, not last month's total, so I won't guess it. ${now}` : now;
}

/**
 * Is this one of the OS's own read questions (calendar, needs-attention, AI spend, an agent's status, a deal's stage or next action, or a
 * follow-up on "that deal")? The voice turn sends these to the command path BEFORE the brain, for a founder at the hub or remote alike, so
 * the brain never answers them from old notes. Pure.
 */
export function osQuestionIn(utterance: string, bots: readonly { id: string; name: string }[] = []): boolean {
  if (osReadIn(utterance, bots) || aiSpendAsked(utterance)) return true;
  const crm = crmIntentIn(utterance);
  if (crm && "kind" in crm && (crm.kind === "stage" || crm.kind === "next")) return true;
  const u = clean(utterance);
  return u.length <= 120 && /\b(?:stage|next\s+actions?)\b/i.test(u) && /\b(?:that|this|the same)\s+(?:deal|opportunity|client|company|customer|project|record|one)\b|\bit\b/i.test(u) && isQuestion(u);
}

/** A question, by its shape: a question word first, or a question mark last. Only ever used to ANSWER, never to act. */
export function isQuestion(utterance: string): boolean {
  const u = String(utterance ?? "").replace(/^\s*(?:(?:hey|ok|okay)[,\s]+)?(?:jarvis[,\s]+)?/i, "").trim();
  return /\?\s*$/.test(u) || /^(?:what|who|whom|whose|why|how|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will|has|have|am)\b/i.test(u);
}

export type CalendarEventLike = { title: string; start: string; end: string; allDay?: boolean; location?: string };

const dayKey = (ms: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const clock = (ms: number, timeZone: string) => new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(ms).replace(/\s/g, " ").toLowerCase();

/** That day's saved events, in order, as one answer. Days are the hub's own (Sydney unless told otherwise). Pure. */
export function calendarSaid(events: readonly CalendarEventLike[], day: "today" | "tomorrow", now = Date.now(), timeZone = "Australia/Sydney"): string {
  const want = dayKey(now + (day === "tomorrow" ? 86_400_000 : 0), timeZone);
  const rows = events
    .map((e) => ({ e, start: Date.parse(e.start), end: Date.parse(e.end) }))
    .filter((r) => Number.isFinite(r.start))
    // An all-day event's date is its own (stored at UTC midnight); a timed one is on the day it starts, or spans it.
    .filter((r) => (r.e.allDay ? r.e.start.slice(0, 10) <= want && (Number.isFinite(r.end) ? new Date(r.end - 1).toISOString().slice(0, 10) : r.e.start.slice(0, 10)) >= want : dayKey(r.start, timeZone) === want || (r.start < now && Number.isFinite(r.end) && dayKey(r.end - 1, timeZone) >= want && dayKey(r.start, timeZone) <= want)))
    .sort((a, b) => Number(!!b.e.allDay) - Number(!!a.e.allDay) || a.start - b.start);
  if (!rows.length) return `Nothing is on your calendar ${day}, from the events saved here.`;
  const line = (r: (typeof rows)[number]) => `${r.e.allDay ? "all day" : clock(r.start, timeZone)}: ${r.e.title.trim().slice(0, 80) || "an untitled event"}${r.e.location?.trim() ? ` (${r.e.location.trim().slice(0, 40)})` : ""}`;
  const shown = rows.slice(0, 8).map(line).join("; ");
  return `${rows.length} ${rows.length === 1 ? "event" : "events"} ${day}: ${shown}${rows.length > 8 ? `; and ${rows.length - 8} more` : ""}.`;
}

export type AgentJobLike = { id: string; state: string; title: string; createdAt: string; updatedAt: string; note?: string };
const OPEN = new Set(["queued", "running", "awaiting-approval"]);
const ago = (iso: string, now: number) => {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(mins)) return "at an unknown time";
  if (mins < 2) return "just now";
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
};
const STATE_WORDS: Record<string, string> = { succeeded: "finished", failed: "failed", cancelled: "was stopped", unknown: "ended with an unknown outcome", "awaiting-approval": "is waiting for a decision", queued: "is queued", running: "is running" };

/** What an agent is doing now, from the job store: its open job, or idle with its last job and when. `jobs`: newest first. Pure. */
export function agentStatusSaid(name: string, jobs: readonly AgentJobLike[], now = Date.now()): string {
  const open = jobs.filter((j) => OPEN.has(j.state));
  if (open.length) {
    const j = open[0];
    return `${name} ${j.state === "awaiting-approval" ? "is waiting for a decision on" : j.state === "queued" ? "has queued" : "is working on"} "${j.title.slice(0, 100)}" (started ${ago(j.createdAt, now)})${open.length > 1 ? `, with ${open.length - 1} more open` : ""}.`;
  }
  const last = jobs[0];
  if (!last) return `${name} is idle and has no jobs on record here.`;
  return `${name} is idle. Its last job, "${last.title.slice(0, 100)}", ${STATE_WORDS[last.state] ?? last.state} ${ago(last.updatedAt, now)}.`;
}
