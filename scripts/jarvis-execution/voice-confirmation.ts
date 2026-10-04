/**
 * Spoken-yes events recorded by the voice pipeline itself (audit A-M3, 27 Sep 2026).
 *
 * The only writer is the server's own speech-to-text for the owner's voice turn
 * (scripts/free-voice.ts, POST /voice/free/stt with `turn: true`): when the transcript it just got
 * back from the STT provider is a clear, unqualified, whole-utterance yes (confirmationReply), one event is recorded here
 * and its id goes back to the client with the transcript. Approvals then REDEEM an event:
 *
 *  - ControlDispatchGate.issue (Hermes control grants) needs `{ spokenYes: <id> }`, never a string.
 *    A client-asserted "yes" (the old A-M3 rubber stamp) is refused.
 *  - screen_act's final-button confirm over HTTP needs an event recorded AFTER the server's own
 *    pending question for that exact button (scripts/screen-hands/index.ts, createScreenHands).
 *
 * Each event is single use, expires after SPOKEN_YES_TTL_MS, holds no text (time only), and
 * never survives a restart. Typed chat has no event, so a typed "yes" can't approve a final action.
 *
 * Residual trust boundary, stated plainly: the server cannot tell a real microphone from synthetic
 * WAV audio posted by a same-origin script holding the page token. This binds approval to the voice
 * pipeline's own transcription (not to a client flag), which is what A-M3 asked for; it is not
 * speaker verification.
 */
import { randomUUID } from "node:crypto";
import { confirmationReply } from "../../src/lib/jarvis-control";

export const SPOKEN_YES_TTL_MS = 60_000;
/** How long a question put to him stays open (the screen, lesson and control confirm windows: 2 min). */
export const QUESTION_TTL_MS = 2 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type SpokenYes = { id: string; at: number };
export type QuestionSurface = "screen" | "lesson" | "control";

/**
 * ONE question registry across screen, lesson and control_pc (REVIEW-SAFETY-R3 findings 6-7, extending
 * 46c47fc's one-question rule to all three): at most one question is open at a time (a new one, from
 * any surface, supersedes the last), and each spoken yes is stamped with the question open when it was
 * heard. A yes can only redeem THAT question: a yes said after a control_pc question never presses an
 * older screen "Delete", and one yes can't answer two screen questions.
 */
export class SpokenConfirmationLedger {
  private events = new Map<string, { at: number; used: boolean; question: string | null }>();
  private open: { id: string; at: number; surface: QuestionSurface } | null = null;
  constructor(
    private now: () => number = Date.now,
    private max = 64,
  ) {}

  private prune(now: number) {
    for (const [id, e] of this.events) if (e.used || now - e.at >= SPOKEN_YES_TTL_MS) this.events.delete(id);
    while (this.events.size >= this.max) this.events.delete(this.events.keys().next().value as string);
    if (this.open && now - this.open.at >= QUESTION_TTL_MS) this.open = null;
  }

  /** A surface puts a question to him now: it becomes the ONE open question (any earlier one is closed). */
  ask(surface: QuestionSurface): { id: string; at: number } {
    const at = this.now();
    this.prune(at);
    this.open = { id: randomUUID(), at, surface };
    return { id: this.open.id, at };
  }

  /** The open question, if any (status and tests). */
  openQuestion(): { id: string; at: number; surface: QuestionSurface } | null {
    this.prune(this.now());
    return this.open ? { ...this.open } : null;
  }

  /**
   * The voice pipeline's STT result for the owner's turn. Records an event only for a clear, whole-utterance
   * yes, stamped with the open question. A no or a new request ("okay, open notepad instead") closes the
   * open question, so no later yes can answer it (AUDIT F4 F1); an unclear reply leaves it open to re-ask.
   */
  record(transcript: string): SpokenYes | null {
    if (typeof transcript !== "string") return null;
    const reply = confirmationReply(transcript);
    if (reply !== "yes") {
      if (reply === "no" || reply === "new-request") this.open = null;
      return null;
    }
    const at = this.now();
    this.prune(at);
    const id = randomUUID();
    const question = this.open && at >= this.open.at ? this.open.id : null;
    this.events.set(id, { at, used: false, question });
    return { id, at };
  }

  /**
   * Use one event (single use, fresh). `after`: the event must have been said after this moment
   * (the server's own pending question), so a yes to something earlier can't approve this.
   * `question`: the event must have been heard while THIS question was the open one.
   */
  redeem(id: unknown, options: { after?: number; maxAgeMs?: number; question?: string } = {}): SpokenYes | null {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const event = this.events.get(id);
    const now = this.now();
    if (!event || event.used) return null;
    const maxAge = Math.min(options.maxAgeMs ?? SPOKEN_YES_TTL_MS, SPOKEN_YES_TTL_MS);
    if (now < event.at || now - event.at >= maxAge) return null;
    if (options.after !== undefined && !(event.at > options.after)) return null;
    if (options.question !== undefined && event.question !== options.question) return null;
    event.used = true;
    this.events.delete(id);
    if (options.question !== undefined && this.open?.id === options.question) this.open = null;
    return { id, at: event.at };
  }

  /** Outstanding (unused, unexpired) events: a count only, for status and tests. */
  outstanding(): number {
    const now = this.now();
    let n = 0;
    for (const e of this.events.values()) if (!e.used && now - e.at < SPOKEN_YES_TTL_MS) n++;
    return n;
  }
}

/** The process-wide ledger: the voice STT route writes it, the approval paths redeem it. */
export const spokenConfirmations = new SpokenConfirmationLedger();
