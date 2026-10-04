// R11: a typed Jarvis request that is never dropped silently and never sent twice.
//
// The companion (voice-companion.tsx) is a lazily loaded overlay. `operator:voice-text` fired before it mounts is captured by the shell
// (shell/late.tsx) and replayed once it has, so a request on a slow link is NOT lost; it is late. Rules:
//   - ONE identity per composed request: the composer makes the request id once and carries it through the handover (`requestId`,
//     shaped like a command eventId so the companion can use it as one). Pressing Send again on the same words while that request is
//     still waiting is the same request: nothing new is dispatched.
//   - It is only "sent" when the companion says it took it (`operator:voice-text-accepted` for that id). Until then the composer keeps
//     the words and, after a while, says it is still connecting; it never claims "nothing was sent" while a replay is still possible.
//   - Editing or clearing the words cancels that request: the shell drops it from its replay queue (`late:cancel-queued`).
export const VOICE_TEXT = "operator:voice-text";
export const VOICE_TEXT_ACCEPTED = "operator:voice-text-accepted";
/** The shell's replay queue drops a captured event whose detail.requestId matches. */
export const CANCEL_QUEUED = "late:cancel-queued";
/** After this long without an acceptance, the composer says it is still connecting (it keeps waiting). */
export const SLOW_MS = 8_000;

let seq = 0;
/** A request id that is also a valid command eventId (/^[\w:.-]{6,80}$/). */
export const newRequestId = () => `jr-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export type PendingSend = {
  readonly requestId: string;
  readonly text: string;
  /** Resolves "accepted" when the companion took it, "cancelled" when the person edited or cleared it first. */
  readonly done: Promise<"accepted" | "cancelled">;
  /** Edited or cleared before it was taken: stop waiting and drop it from the shell's replay queue. */
  cancel(): void;
};

/**
 * Hand one composed request to the companion. `onSlow` runs once if it hasn't been taken after `slowMs` (the request stays queued).
 * Waits until accepted or cancelled; there is no give-up that could make the person send it again under a new identity.
 */
export function sendJarvisRequest(text: string, opts: { requestId?: string; target?: EventTarget; slowMs?: number; onSlow?: () => void } = {}): PendingSend {
  const target = opts.target ?? window;
  const requestId = opts.requestId ?? newRequestId();
  const words = text.trim();
  let settle: (r: "accepted" | "cancelled") => void = () => undefined;
  const done = new Promise<"accepted" | "cancelled">((resolve) => (settle = resolve));
  let finished = false;
  const finish = (r: "accepted" | "cancelled") => {
    if (finished) return;
    finished = true;
    target.removeEventListener(VOICE_TEXT_ACCEPTED, onAccepted);
    clearTimeout(slow);
    settle(r);
  };
  const onAccepted = (event: Event) => {
    if ((event as CustomEvent<{ requestId?: unknown }>).detail?.requestId === requestId) finish("accepted");
  };
  target.addEventListener(VOICE_TEXT_ACCEPTED, onAccepted);
  const slow = setTimeout(() => !finished && opts.onSlow?.(), opts.slowMs ?? SLOW_MS);
  target.dispatchEvent(new CustomEvent(VOICE_TEXT, { detail: { request: words, requestId } }));
  return {
    requestId,
    text: words,
    done,
    cancel() {
      if (finished) return;
      target.dispatchEvent(new CustomEvent(CANCEL_QUEUED, { detail: { type: VOICE_TEXT, requestId } }));
      finish("cancelled");
    },
  };
}

/** The companion's side: say a typed request was taken (it is then queued to run). */
export function acceptJarvisRequest(detail: unknown, target: EventTarget = window) {
  const requestId = (detail as { requestId?: unknown } | null | undefined)?.requestId;
  if (typeof requestId === "string") target.dispatchEvent(new CustomEvent(VOICE_TEXT_ACCEPTED, { detail: { requestId } }));
}

/** Pure: does a Send press start a new request, or is it the same one still waiting? */
export function sendDecision(pending: { text: string } | null, words: string): "new" | "same" {
  return pending && pending.text === words.trim() ? "same" : "new";
}
