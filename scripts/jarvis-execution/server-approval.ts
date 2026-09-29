import { createHash, randomUUID } from "node:crypto";
import { jarvisTaskPrompt, requiresSpokenYes } from "../../src/lib/jarvis-control";
import { controlTaskRefusal } from "../../src/lib/control-risk";
import { SPOKEN_YES_TTL_MS, spokenConfirmations, type SpokenConfirmationLedger } from "./voice-confirmation";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
type Binding = { task: string; requestId: string; approvalNonce?: string };
/** Shares the authenticated loopback host's trust boundary. No prompt/response storage.
 * Restart invalidates outstanding grants; a grant is never reconstructed from client data.
 */
/** How long a server-asked control question stays answerable (the client's CONFIRM_TTL_MS). */
export const CONTROL_QUESTION_TTL_MS = 2 * 60 * 1000;
export class ControlDispatchGate {
  private grants = new Map<string, { taskHash: string; requestId: string; issued: number; expires: number; spokenAt: number }>();
  private used = new Set<string>();
  /** Questions this server put to him ("Shall I … ?"), by task hash → when asked. Single use. */
  private questions = new Map<string, { at: number; question: string }>();
  constructor(private now = Date.now, private spoken: SpokenConfirmationLedger = spokenConfirmations) {}
  /**
   * The server asks (A-M3 binding for control grants, 27 Sep night; review finding 2 / Stage 0 F2):
   * record that the read-back question for THIS exact task is being put to him now. `issue` then
   * accepts only a spoken yes said AFTER this moment, for this task, once. A yes to an earlier
   * question, to small talk, or to a different task can't approve it. Holds no text: a hash and a time.
   */
  ask(value: unknown) {
    const task = (value as { task?: unknown } | null)?.task;
    if (typeof task !== "string" || !task.trim() || task !== task.trim() || task.length > 2000) throw new Error("Invalid control question");
    const now = this.now();
    for (const [key, q] of this.questions) if (now - q.at >= CONTROL_QUESTION_TTL_MS) this.questions.delete(key);
    // One question outstanding at a time (REVIEW-SAFETY §3 residual): a new question supersedes any
    // earlier one, so a single yes can never answer "either of two tasks". Since R3 the registry is the
    // ledger's, shared with screen and lesson questions: a yes is stamped with the question it answered.
    this.questions.clear();
    const { id } = this.spoken.ask("control");
    this.questions.set(digest(task), { at: now, question: id });
    return { askedAt: now, expiresAt: now + CONTROL_QUESTION_TTL_MS };
  }
  private binding(value: unknown): Binding {
    const b = value as Binding;
    if (!b || typeof b.task !== "string" || !b.task.trim() || b.task !== b.task.trim() || b.task.length > 2000 ||
        typeof b.requestId !== "string" || !uuid.test(b.requestId)) throw new Error("Invalid control binding");
    return b;
  }
  /** Only the host's authenticated local approval endpoint may invoke this.
   *
   * A-M3 fix (27 Sep): the grant is bound to a spoken-yes event the voice pipeline's own STT
   * recorded server-side (voice-confirmation.ts): `confirmation` must be `{ spokenYes: <event id> }`
   * for an unused event said within SPOKEN_YES_TTL_MS. A string ("yes", the old client-minted
   * literal) is refused outright, and so is a typed yes (typed turns never create an event). The
   * redeemed event's time is kept on the grant. Since 27 Sep night the event must also have been said
   * after this server's own question for this exact task (`ask`), not just in the last 60 s. Residual boundary: the server can't tell a real
   * microphone from synthetic audio posted by a page-token holder (see voice-confirmation.ts). */
  issue(value: unknown, confirmation: unknown) {
    const b = this.binding(value);
    // Money, banks and secrets are never approvable here either (REVIEW-SAFETY-R3 §3: issue had no money check).
    if (controlTaskRefusal(b.task)) throw new Error("That task is refused whatever the approval (money, a bank or broker, or a secret)");
    if (this.used.has(b.requestId)) throw new Error("A fresh explicit approval is required");
    if (typeof confirmation === "string") throw new Error("A client-asserted yes is not an approval; a fresh explicit spoken approval is required");
    const eventId = confirmation && typeof confirmation === "object" ? (confirmation as { spokenYes?: unknown }).spokenYes : undefined;
    const now = this.now();
    for (const [key, grant] of this.grants) if (grant.expires <= now) this.grants.delete(key);
    if (this.grants.size >= 1024) throw new Error("Too many pending approvals");
    // Bound to the server-asked question for this exact task (as screen confirms are): the yes must
    // come after it, and the question is spent once a grant is issued.
    const taskKey = digest(b.task);
    const asked = this.questions.get(taskKey);
    const askedAt = asked?.at;
    if (asked === undefined || askedAt === undefined || now < askedAt || now - askedAt >= CONTROL_QUESTION_TTL_MS) throw new Error("A fresh explicit spoken approval is required (no question was asked for this task)");
    const yes = this.spoken.redeem(eventId, { after: askedAt, maxAgeMs: SPOKEN_YES_TTL_MS, question: asked.question });
    if (!yes) throw new Error("A fresh explicit spoken approval is required");
    this.questions.delete(taskKey);
    const nonce = randomUUID(), expiresAt = now + 120_000;
    this.grants.set(digest(nonce), { taskHash: digest(b.task), requestId: b.requestId, issued: now, expires: expiresAt, spokenAt: yes.at });
    return { nonce, taskHash: digest(b.task), expiresAt };
  }
  /** Atomic synchronous admission immediately before process launch. Replay denied even
   * for reversible actions. The id set is bounded fail-closed, never evicted to allow replay.
   */
  consume(value: unknown, prompt: string) {
    const b = this.binding(value);
    if (prompt !== jarvisTaskPrompt(b.task)) throw new Error("Control prompt does not match approved task");
    if (controlTaskRefusal(b.task)) throw new Error("That task is refused whatever the approval (money, a bank or broker, or a secret)");
    if (this.used.has(b.requestId) || this.used.size >= 100_000) throw new Error("Control request replay or capacity limit");
    if (requiresSpokenYes(b.task)) {
      if (typeof b.approvalNonce !== "string" || !uuid.test(b.approvalNonce)) throw new Error("Control approval required");
      const key = digest(b.approvalNonce), grant = this.grants.get(key), now = this.now();
      if (!grant || grant.taskHash !== digest(b.task) || grant.requestId !== b.requestId || now < grant.issued || now >= grant.expires)
        throw new Error("Control approval invalid or expired");
      this.grants.delete(key);
    }
    this.used.add(b.requestId);
  }
}
export const controlDispatchGate = new ControlDispatchGate();

/** Used by the real CLI response and synthetic transport tests. Completed responses do
 * not kill work; a disconnected in-flight response immediately invokes owned-child Stop.
 */
export function bindControlDisconnect(response: { writableEnded: boolean; once(event: "close", listener: () => void): unknown }, stop: () => void) {
  response.once("close", () => { if (!response.writableEnded) stop(); });
}
