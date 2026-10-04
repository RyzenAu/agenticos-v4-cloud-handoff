// "What needs me?" by voice (J4, AUDIT-JARVIS #8 / C22): answered from the SAME two workspace panels the Home page's
// "Needs you" widget reads (`needsYou` for the count and its breakdown, `today` for the waiting decisions), through the same
// functions (needs-you.ts) and the same list length (top NEEDS_YOU_LIST_SHOWN, the rest are "in Work"). No model, no second
// source: Jarvis and Home can't disagree. A part that couldn't be read is said to be unknown, never zero. Pure.
import type { PanelResult } from "./aggregate";
import { NEEDS_YOU_LIST_SHOWN, needsYouBadge, needsYouBreakdown, type NeedsYouPanel } from "./needs-you";

/** The two panels Home reads for this widget (scripts/workspace/sources.ts). */
export type NeedsYouSources = {
  needsYou: PanelResult<NeedsYouPanel>;
  today: PanelResult<{ approvals: { id: string; title: string }[]; derivedError?: string | null }>;
  /**
   * Coding jobs waiting on the person (see `codingWaiting`). Absent: this caller has no coding source, nothing is said about it. Null: the coding
   * store could not be read, which is said, never counted as zero.
   */
  coding?: CodingWaiting[] | null;
};

export type CodingWaiting = { id: string; state: string; title: string };
/** A coding job that is a draft the person has not started: it needs their review and Start. Everything else waiting is a decision (approval, owner, limit, input). */
const isDraft = (state: string) => state === "draft" || state === "awaiting_confirmation";

/** The slice of the coding store the voice answer reads (scripts/coding/store.ts listJobs). */
export type CodingStoreLike = { listJobs(filter: { state?: "needs-you" | "draft" | "awaiting_confirmation"; limit?: number }): Array<{ id: string; state: string; spec: { objective: string } }> };

/**
 * The coding jobs waiting on the person: the coding page's own "needs you" set (owner, approval, interrupted, allowance, a run needing input) plus
 * drafts and plans waiting for Start. One row per job. Reads only; nothing here starts, resumes or approves anything.
 */
export function codingWaiting(store: CodingStoreLike, limit = 50): CodingWaiting[] {
  const seen = new Set<string>();
  const out: CodingWaiting[] = [];
  for (const state of ["needs-you", "draft", "awaiting_confirmation"] as const) {
    for (const j of store.listJobs({ state, limit })) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      out.push({ id: j.id, state: j.state, title: String(j.spec.objective ?? "").replace(/\s+/g, " ").trim().slice(0, 100) });
    }
  }
  return out;
}

/** "what needs me", "what needs me today", "what do I need to do (today)", "what's waiting on me", "anything need me". */
const NEEDS_ME =
  /^(?:what|whats)(?:'s| is)?\s+(?:needs?|waiting on|left for|on for)\s+(?:me|my plate)(?:\s+(?:today|now|right now|this morning|this afternoon|at the moment))?$|^what\s+do\s+i\s+(?:need|have)\s+to\s+do(?:\s+(?:today|now|right now|this morning|this afternoon|next))?$|^(?:is there )?anything\s+(?:that\s+)?(?:needs?|waiting on)\s+me(?:\s+(?:today|now|right now))?$|^what\s+(?:do\s+you\s+need|needs)\s+(?:from\s+me|my\s+(?:yes|approval|decision))(?:\s+(?:today|now|right now))?$/i;

export function needsMeIntent(utterance: string): boolean {
  const u = String(utterance ?? "")
    .replace(/[’`]/g, "'")
    .replace(/^\s*(?:(?:hey|ok|okay)[,\s]+)?(?:jarvis[,\s]+)?(?:(?:can|could) you (?:tell me|say)[,\s]+)?/i, "")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+(?:please|jarvis|sir)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return u.length > 0 && u.length <= 80 && NEEDS_ME.test(u);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The breakdown the page shows ("3 decisions · 2 emails · agent approvals unknown"), as a spoken list. */
const spokenBreakdown = (panel: NeedsYouPanel) => needsYouBreakdown(panel).split(" · ").join(", ");

export function needsYouSaid(src: NeedsYouSources): string {
  const parts: string[] = [];
  const panel = src.needsYou.ok ? src.needsYou.data : null;
  const badge = panel ? needsYouBadge(panel) : null;
  if (!panel || badge === null) {
    parts.push("I can't read the needs-you count right now, so I won't guess.");
  } else if (panel.total === 0 && panel.complete) {
    parts.push("Nothing needs you right now.");
  } else {
    const floor = panel.complete ? "" : "at least ";
    parts.push(`${floor}${plural(panel.total, "thing needs", "things need")} you: ${spokenBreakdown(panel)}.`);
  }
  // The waiting decisions, in the page's order, deduped by id, top NEEDS_YOU_LIST_SHOWN (what the Home list shows).
  if (src.today.ok) {
    const seen = new Set<string>();
    const approvals = src.today.data.approvals.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
    if (approvals.length) {
      const top = approvals.slice(0, NEEDS_YOU_LIST_SHOWN).map((a) => String(a.title).trim().replace(/[.\s]+$/, ""));
      const more = approvals.length - top.length;
      parts.push(`${top.length === 1 ? "The decision waiting" : "First up"}: ${top.join("; ")}.${more > 0 ? ` ${plural(more, "more")} in Work.` : ""}`);
    }
  } else parts.push("The list of waiting decisions couldn't be read.");
  // Coding jobs waiting for the person: drafts to review and Start, and decisions held in Coding. The page's own count does not include them
  // (it counts approvals, emails and agent runs), so they are said as their own sentence and never folded into that number.
  if (src.coding === null) parts.push("Coding decisions couldn't be read.");
  else if (src.coding?.length) {
    const drafts = src.coding.filter((j) => isDraft(j.state)).length;
    const decisions = src.coding.length - drafts;
    // "Nothing needs you" followed by waiting coding work would contradict itself.
    if (parts[0] === "Nothing needs you right now.") parts[0] = "No decisions or emails need you right now.";
    const waiting = [drafts ? `${plural(drafts, "coding draft")} waiting for your review and Start` : "", decisions ? `${plural(decisions, "coding decision")} waiting in Coding` : ""].filter(Boolean).join(", and ");
    parts.push(`${waiting}. Open Coding to review; nothing starts on its own.`);
  }
  const said = parts.join(" ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}
