// R11: a typed Jarvis request that is never dropped silently and never sent twice.
//
// The companion (voice-companion.tsx) is a lazily loaded overlay. `operator:voice-text` fired before it mounts is captured by the shell
// (shell/late.tsx) and replayed once it has, so a request on a slow link is NOT lost; it is late. Rules:
//   - ONE identity per composed request: the composer makes the request id once and carries it through the handover (`requestId`,
//     shaped like a command eventId so the companion can use it as one). Pressing Send again on the same words while that request is
//     still waiting is the same request: nothing new is dispatched.
//   - It is only "sent" when the companion says it took it (`operator:voice-text-accepted` for that id after durable completion in the typed lane). Until then the composer keeps
//     the words and, after a while, says it is waiting for save confirmation; it never claims "nothing was sent" while a replay is still possible.
//   - Editing or clearing the words cancels that request: the shell drops it from its replay queue (`late:cancel-queued`).
import { isDotGatewayUi } from "./dot-gateway";

export const VOICE_TEXT = "operator:voice-text";
export const VOICE_TEXT_ACCEPTED = "operator:voice-text-accepted";
export const VOICE_TEXT_STARTED = "operator:voice-text-started";
export const VOICE_TEXT_REJECTED = "operator:voice-text-rejected";
/** The shell's replay queue drops a captured event whose detail.requestId matches. */
export const CANCEL_QUEUED = "late:cancel-queued";
/** After this long without an acceptance, the composer says it is waiting for completion (it keeps waiting). */
export const SLOW_MS = 8_000;

let seq = 0;
/** A request id that is also a valid command eventId (/^[\w:.-]{6,80}$/). */
export const newRequestId = () => `jr-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export type PendingSend = {
  readonly requestId: string;
  readonly text: string;
  /** Resolves accepted after durable completion, rejected on an explicit failure, or cancelled on editing. */
  readonly done: Promise<"accepted" | "cancelled" | "rejected">;
  /** Durable admission/completion failed; keep this identity and the composed words for retry. */
  readonly failure?: string;
  /** Effects have begun; editing only detaches this waiter and cannot promise cancellation. */
  readonly started: boolean;
  /** Stop waiting. Before effects start, also cancel shell replay and companion queue admission. */
  cancel(): void;
};

/**
 * Hand one composed request to the companion. `onSlow` runs once if completion has not arrived after `slowMs`.
 * Waits until accepted, rejected or cancelled; there is no give-up that could make the person send it again under a new identity.
 */
export function sendJarvisRequest(text: string, opts: { requestId?: string; target?: EventTarget; slowMs?: number; onSlow?: () => void } = {}): PendingSend {
  if (isDotGatewayUi()) return sendDotTask(text, opts);
  const target = opts.target ?? window;
  const requestId = opts.requestId ?? newRequestId();
  const words = text.trim();
  let settle: (r: "accepted" | "cancelled" | "rejected") => void = () => undefined;
  const done = new Promise<"accepted" | "cancelled" | "rejected">((resolve) => (settle = resolve));
  let finished = false;
  let failure: string | undefined;
  let started = false;
  const finish = (r: "accepted" | "cancelled" | "rejected") => {
    if (finished) return;
    finished = true;
    target.removeEventListener(VOICE_TEXT_ACCEPTED, onAccepted);
    target.removeEventListener(VOICE_TEXT_REJECTED, onRejected);
    target.removeEventListener(VOICE_TEXT_STARTED, onStarted);
    clearTimeout(slow);
    settle(r);
  };
  const onAccepted = (event: Event) => {
    if ((event as CustomEvent<{ requestId?: unknown }>).detail?.requestId === requestId) finish("accepted");
  };
  const onStarted = (event: Event) => {
    if ((event as CustomEvent<{ requestId?: unknown }>).detail?.requestId === requestId) started = true;
  };
  const onRejected = (event: Event) => {
    const detail = (event as CustomEvent<{ requestId?: unknown; reason?: string }>).detail;
    if (detail?.requestId !== requestId) return;
    failure = detail.reason || "The request is not confirmed saved. Retry the same request.";
    finish("rejected");
  };
  target.addEventListener(VOICE_TEXT_ACCEPTED, onAccepted);
  target.addEventListener(VOICE_TEXT_REJECTED, onRejected);
  target.addEventListener(VOICE_TEXT_STARTED, onStarted);
  const slow = setTimeout(() => !finished && opts.onSlow?.(), opts.slowMs ?? SLOW_MS);
  target.dispatchEvent(new CustomEvent(VOICE_TEXT, { detail: { request: words, requestId } }));
  return {
    requestId,
    text: words,
    done,
    get failure() { return failure; },
    get started() { return started; },
    cancel() {
      if (finished) return;
      if (!started) target.dispatchEvent(new CustomEvent(CANCEL_QUEUED, { detail: { type: VOICE_TEXT, requestId } }));
      finish("cancelled");
    },
  };
}

/**
 * Dot's browser (the gateway's UI bundle only): the request goes straight to Dot's own task route, POST /__gateway/tasks (tasks.run,
 * the Jev-led command path as Dot, no device lanes). The request id is its eventId, so a retry is the same task and the hub saves the
 * request (and a plain reply) into Dot's OWN Jarvis thread once. "accepted" when the hub answered for it; the words stay otherwise.
 */
export function sendDotTask(text: string, opts: { requestId?: string; slowMs?: number; onSlow?: () => void; fetcher?: typeof fetch } = {}): PendingSend {
  const requestId = opts.requestId ?? newRequestId();
  const words = text.trim();
  const f = opts.fetcher ?? fetch;
  let cancelled = false;
  const slow = setTimeout(() => !cancelled && opts.onSlow?.(), opts.slowMs ?? SLOW_MS);
  const done = (async (): Promise<"accepted" | "cancelled"> => {
    try {
      const token = String(((await (await f("/__token")).json()) as { token?: unknown }).token ?? "");
      const r = await f("/__gateway/tasks", { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token }, body: JSON.stringify({ text: words, eventId: requestId }) });
      return r.ok && !cancelled ? "accepted" : "cancelled";
    } catch {
      return "cancelled";
    } finally {
      clearTimeout(slow);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("operator:conversations-changed"));
    }
  })();
  return {
    requestId,
    text: words,
    done,
    started: false,
    cancel() {
      cancelled = true;
    },
  };
}

/** The companion acknowledges only after the request and answer have durable save acknowledgements. */
export function acceptJarvisRequest(detail: unknown, target: EventTarget = window) {
  const requestId = (detail as { requestId?: unknown } | null | undefined)?.requestId;
  if (typeof requestId === "string") target.dispatchEvent(new CustomEvent(VOICE_TEXT_ACCEPTED, { detail: { requestId } }));
}

/** Pure: does a Send press start a new request, or is it the same one still waiting? */
export function sendDecision(pending: { text: string } | null, words: string): "new" | "same" {
  return pending && pending.text === words.trim() ? "same" : "new";
}

/** An explicit failure unlocks Send without losing its identity or words. */
export function rejectJarvisRequest(requestId: string, reason: string, target: EventTarget = window) {
  target.dispatchEvent(new CustomEvent(VOICE_TEXT_REJECTED, { detail: { requestId, reason } }));
}

/** The composer retains a failed identity until its words change; a retry never becomes a fresh request. */
export function retryRequestId(previous: { requestId: string; text: string } | null, text: string): string | undefined {
  return previous?.text === text.trim() ? previous.requestId : undefined;
}

const INTERRUPTED_KEY = "jarvis-pending-durable-request";
export type InterruptedRequest = { requestId: string; text: string };
/** Store only the current composer identity. A reload cannot reconstruct completed browser tool steps safely. */
export function rememberInterruptedRequest(request: InterruptedRequest | null, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try { const target = storage ?? sessionStorage; if (request) target.setItem(INTERRUPTED_KEY, JSON.stringify(request)); else target.removeItem(INTERRUPTED_KEY); } catch { /* session storage unavailable */ }
}
export function readInterruptedRequest(storage?: Pick<Storage, "getItem">): InterruptedRequest | null {
  try {
    const saved = JSON.parse((storage ?? sessionStorage).getItem(INTERRUPTED_KEY) || "null") as InterruptedRequest | null;
    return saved && typeof saved.requestId === "string" && /^[\w:.-]{6,80}$/.test(saved.requestId) && typeof saved.text === "string" && saved.text.length <= 600 ? saved : null;
  } catch { return null; }
}


/** Admission and completion are distinct: the draft still waits for saving after effects have begun. */
export function startJarvisRequest(requestId: string, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent(VOICE_TEXT_STARTED, { detail: { requestId } }));
}
export function onJarvisRequestCancelled(cancel: (requestId: string) => void, target: EventTarget = window): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ type?: string; requestId?: unknown }>).detail;
    if (detail?.type === VOICE_TEXT && typeof detail.requestId === "string" && /^[\w:.-]{6,80}$/.test(detail.requestId)) cancel(detail.requestId);
  };
  target.addEventListener(CANCEL_QUEUED, listener);
  return () => target.removeEventListener(CANCEL_QUEUED, listener);
}
