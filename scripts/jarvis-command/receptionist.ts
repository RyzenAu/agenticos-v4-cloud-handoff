/**
 * Receptionist questions by voice or typing (Track 2; AUDIT-F2 / AUDIT-F4 R03-R05): answered from the
 * receptionist dashboard snapshot (Retell + the MU-Receptionist agency feed), with the source and its
 * time named. A source that couldn't be read is said to be unknown, never zero. Pure over the snapshot.
 */
import type { ReceptionistSnapshot } from "../receptionist/types";
import { notesIntent } from "../jarvis-skills/notes-intent";

export type ReceptionistQuestion = "flagged" | "calls-today" | "bookings" | "safe-to-sell" | "status";

/** His words → which receptionist question, or null. Pure. */
export function receptionistQuestion(utterance: string): ReceptionistQuestion | null {
  const u = utterance.toLowerCase().replace(/[’']/g, "'").replace(/[?.!]+$/, "").trim();
  // A note or a thing to write down is not a question for the feed, even when it mentions the receptionist
  // ("write that down: the receptionist needs a go-live date" is a note; the notes skill saves it, J3).
  if (notesIntent(utterance)?.action === "add") return null;
  // Opening the page, or a price/margin question about the receptionist PACKAGE, isn't a question for the feed.
  if (/^(?:please\s+)?(?:open|go to|take me to|pull up|switch to|bring up)\b/.test(u) || /\b(?:margin|price|pricing|cost|how much|package|plan)\b/.test(u)) return null;
  // "Show me the receptionist" is the page, like "open the receptionist" (J4, AUDIT-JARVIS acc106); "show me the receptionist
  // status" / "how is the receptionist doing" are still the status answer.
  if (/^(?:please\s+)?show(?: me)?\s+(?:the\s+|my\s+)?(?:ai\s+)?receptionist(?:\s+(?:dashboard|page))?$/.test(u)) return null;
  // A long ramble that only wants to SEE the dashboard ("…I just want to see what the receptionist dashboard looks like").
  if (/\b(?:see|look at|show me|pull up)\b.{0,40}\breceptionist (?:dashboard|page)\b.{0,20}\blooks? like\b/.test(u)) return null;
  const named = /\breceptionist\b/.test(u);
  // Standalone phrasings that can only mean the receptionist; anything else must name it ("how many calls
  // have I made today" is his own outbound calls, the CRM's, not the receptionist's).
  if (/^(?:are there |any |show me |what are the |list the )?(?:the )?flagged calls?(?: today)?$|^any flags$/.test(u)) return "flagged";
  if (/^(?:is it|are we|is the receptionist) (?:safe|ready) to sell$/.test(u)) return "safe-to-sell";
  if (!named) return null;
  if (/\bflag(?:ged|s)?\b/.test(u)) return "flagged";
  if (/\b(?:safe|ready) to sell\b/.test(u)) return "safe-to-sell";
  if (/\bbookings?\b|\bbooked\b/.test(u)) return "bookings";
  if (/\bcalls?\b.*\btoday\b|\btoday'?s calls\b|\bhow many calls\b/.test(u)) return "calls-today";
  return "status";
}

const when = (iso: string | null | undefined) => {
  if (!iso) return "time unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "time unknown" : d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });
};

/** The spoken answer with its cited source. Never invents a count the snapshot doesn't have. Pure. */
export function receptionistAnswer(q: ReceptionistQuestion, s: ReceptionistSnapshot): { said: string; source: string; verified: boolean } {
  const source = `receptionist dashboard (Retell and the agency feed), read ${when(s.generatedAt)}`;
  const cite = (line: string) => `${line} Source: ${source}.`;
  if (q === "flagged") {
    const open = s.incidents ?? [];
    const waiting = s.awaitingRetest?.length ?? 0;
    if (!open.length) return { said: cite(`No flagged calls are open${waiting ? `; ${waiting} followed-up call${waiting === 1 ? " is" : "s are"} still waiting for a retest` : ""}.`), source, verified: true };
    // (A consequence already ends in a full stop: never say "..".)
    const first = open.slice(0, 2).map((i) => `${when(i.startedAt)}: ${String(i.consequence ?? "").trim().replace(/[.\s]+$/, "")}`).join("; ");
    return { said: cite(`${open.length} flagged call${open.length === 1 ? "" : "s"} to act on. ${first}.`), source, verified: true };
  }
  if (q === "calls-today") {
    if (!s.calls.ok) return { said: cite(`I can't read today's calls right now (${s.calls.reason}), so the count is unknown, not zero.`), source, verified: false };
    const today = s.calls.windows.find((w) => w.label === "Today");
    return today
      ? { said: cite(`${today.count} call${today.count === 1 ? "" : "s"} today, ${today.answered} answered.`), source, verified: true }
      : { said: cite("Today's call count isn't in the snapshot, so it's unknown."), source, verified: false };
  }
  if (q === "bookings") {
    if (!s.feed.ok) return { said: cite(`The agency feed isn't readable (${s.feed.reason}), so bookings are unknown, not zero.`), source, verified: false };
    const booked = s.feed.totals.byOutcome.find((o) => /book/i.test(o.name));
    const days = s.feed.windowDays;
    return booked
      ? { said: cite(`${booked.count} booking${booked.count === 1 ? "" : "s"} in the feed's last ${days ?? "?"} days.`), source, verified: true }
      : { said: cite(`The feed doesn't report a booking outcome for the last ${days ?? "?"} days, so bookings are unknown.`), source, verified: false };
  }
  if (q === "safe-to-sell") {
    const v = s.verdict;
    return { said: cite(`${v.decision}. ${v.facts.slice(0, 3).join("; ")}.${v.next ? ` Next: ${v.next}.` : ""}`), source, verified: true };
  }
  return { said: cite(s.sentence), source, verified: true };
}
