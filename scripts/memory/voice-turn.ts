/**
 * Jarvis → memory (Stage D). The voice turn (scripts/free-voice.ts `turn`) asks this first, by rules
 * and with no model call: "remember …", "save this to the vault …", "what do we know about …",
 * "correct that …", "forget …". A match goes to the ONE memory API (the same instance /__memory
 * serves), and the returned line is what Jarvis says. Anything else returns null and the turn
 * carries on as before.
 *
 * Per-person context lives HERE, on the server, never in the client's messages:
 *   - the ids the last memory answer used, so "correct that" / "forget that" has a referent;
 *   - the pending question (a forget plan, a conflict, a reaffirm), with when it was asked and the
 *     exact line asked, so a "yes" only counts right after that question.
 *
 * Forgetting a Hindsight memory (kind b) or vault content everywhere (kind c) needs the approval
 * path's own yes (Track 6, B2's service): Jarvis puts the question through the ONE question registry, and
 * the voice pipeline's server-recorded spoken-yes event, heard while that question was open, is redeemed by
 * the approval service once. A typed yes, a yes to another question or a replayed event can't approve; the
 * approval then stays pending (the Memory page's card, or the Telegram code for a program's request).
 * "Remove that from the index" (kind a, reversible) needs no approval (V7).
 */
import type { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import type { MemoryApi } from "./api";
import type { Principal } from "./types";
import { handleMemoryUtterance, parseMemoryIntent, type PendingMemoryAction, type VoiceOptions } from "./voice-intents";

/** A pending memory question stays answerable this long (the control gate's CONTROL_QUESTION_TTL_MS). */
export const MEMORY_QUESTION_TTL_MS = 2 * 60_000;
/** "correct that" / "forget that" refer back to the last answer for this long. */
const CONTEXT_TTL_MS = 10 * 60_000;
const YESISH = /^(?:yes|yeah|yep|confirm|confirmed|do it|go ahead|forget it|save it|approve(?:d)?|no|nope|cancel|stop|never ?mind|leave it|don't|keep both|replace)\b/i;

type State = { lastFactsUsed: string[]; lastAt: number; pending: PendingMemoryAction | null; askedAt: number; question: string };

export type MemoryVoiceTurn = (
  principal: Principal,
  utterance: string,
  turn?: { spokenYes?: string | null; previousAssistant?: string | null },
) => Promise<{ content: string; outcome: string; facts_used: string[] } | null>;

export function createMemoryVoiceTurn(options: { api: () => MemoryApi; spoken: SpokenConfirmationLedger; now?: () => number; /** The Jarvis notes file, read-only, searched alongside the memory (J3). */ notes?: VoiceOptions["notes"] }): MemoryVoiceTurn {
  const now = options.now ?? Date.now;
  const states = new Map<string, State>();

  return async (principal, utterance, turn = {}) => {
    const text = typeof utterance === "string" ? utterance.trim() : "";
    if (!text) return null;
    const t = now();
    const st = states.get(principal.id);
    const pendingLive =
      st?.pending && t - st.askedAt < MEMORY_QUESTION_TTL_MS && (turn.previousAssistant == null || turn.previousAssistant.trim() === st.question.trim())
        ? st.pending
        : null;
    // Cheap gate: only an explicit memory phrase, or an answer to OUR pending question, reaches the
    // API. "Actually, …" in ordinary speech goes to the brain (REVIEW-STAGE-D B4).
    if (!parseMemoryIntent(text) && !(pendingLive && YESISH.test(text))) return null;

    const api = options.api();
    const lastFactsUsed = st && t - st.lastAt < CONTEXT_TTL_MS ? st.lastFactsUsed : [];
    const reply = await handleMemoryUtterance(
      api,
      principal,
      text,
      { lastFactsUsed, pending: pendingLive },
      {
        channel: "voice",
        ...(options.notes ? { notes: options.notes } : {}),
        // The voice pipeline's own spoken-yes event for this turn. It is NOT redeemed here: B2's approval
        // service redeems it, bound to the question Jarvis put for this exact approval (Track 6).
        spokenYes: () => (typeof turn.spokenYes === "string" && turn.spokenYes ? turn.spokenYes : null),
      },
    );
    if (!reply.handled) return null;
    const next: State = {
      lastFactsUsed: reply.facts_used.length ? reply.facts_used : lastFactsUsed,
      lastAt: reply.facts_used.length ? t : (st?.lastAt ?? t),
      pending: reply.pending,
      // A re-asked question keeps its original moment only if it is the same pending action.
      askedAt: reply.pending ? (pendingLive && reply.pending === pendingLive ? st!.askedAt : t) : 0,
      question: reply.pending ? reply.spoken : "",
    };
    states.set(principal.id, next);
    return { content: reply.spoken, outcome: reply.outcome ?? "handled", facts_used: reply.facts_used };
  };
}
