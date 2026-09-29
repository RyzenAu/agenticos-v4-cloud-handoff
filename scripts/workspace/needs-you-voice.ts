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
  coding?: Array<{ id: string; state: string; title: string }> | null;
};

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
  if (src.coding?.length) {
    const drafts = src.coding.filter((j) => j.state === "draft" || j.state === "awaiting_confirmation");
    const approvals = src.coding.length - drafts.length;
    parts.push(`${drafts.length ? `${plural(drafts.length, "coding draft")} waiting for your review and Start. ` : ""}${approvals ? `${plural(approvals, "coding decision")} waiting in Coding. ` : ""}Open Coding to review; nothing starts on its own.`);
  } else if (src.coding === null) parts.push("Coding decisions couldn't be read.");
  const said = parts.join(" ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}
