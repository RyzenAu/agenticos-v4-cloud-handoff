// What happens to a typed Jarvis request that arrives while the companion can't run it at once (round 11, defect 1).
// Before: the companion's execute() returned silently when a previous request was still running or Jarvis was paused, while the Jarvis page
// had already cleared its box, so the request vanished with no network call and nothing in the conversation. Now it is never dropped:
// it waits its turn (shown as queued), or, when paused, the conversation says it wasn't sent.

export type TypedSendState = { busy: boolean; paused: boolean; /** The words, so a Stop is never queued behind what it should stop. */ request?: string };
export type TypedSendDecision = "run" | "queue" | "paused" | "stop";

/** A whole typed stop ("stop", "cancel that", "never mind"): it stops what is running (and empties the queue) instead of waiting behind it. */
export const TYPED_STOP = /^(?:(?:please|ok(?:ay)?|jarvis)[,\s]+)*(?:stop|cancel|abort|never\s*mind)(?:[,\s]+(?:it|that|this|now|please|everything|all))*[\s.!]*$/i;

/** Run now, queue behind the request still running, stop what is running, or say Jarvis is paused. Never "drop". */
export function typedSendGate(state: TypedSendState): TypedSendDecision {
  if ((state.busy || state.paused) && TYPED_STOP.test(String(state.request ?? "").trim())) return "stop";
  if (state.paused) return "paused";
  if (state.busy) return "queue";
  return "run";
}

export const QUEUED_LINE = "Queued: it runs as soon as your last request finishes. Saying stop cancels that request and anything waiting, this included.";
/** Said for each waiting request when the page changes before its turn ("explain this" must run against the page it was typed on). */
export const pageChangedLine = (request: string) => `I didn't run "${request.slice(0, 80)}": the page changed before its turn. Send it again here if you still want it.`;
export const PAUSED_LINE = "Jarvis is paused, so I didn't send that. Resume, then send it again.";

/** One id per composed request, in the command eventId format (the composer's requestId when it sent one; else made here). */
export const REQUEST_ID = /^[\w:.-]{6,70}$/;
export function typedRequestId(given?: unknown): string {
  return typeof given === "string" && REQUEST_ID.test(given) ? given : `typed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** The eventId for the n-th command a typed turn runs (0-based): the request's own id first, then numbered, so each is ONE command at the hub. */
export function commandEventId(requestId: string, n: number): string {
  return n === 0 ? requestId : `${requestId}.${n + 1}`;
}

/** Statuses of a turn that may simply be retried (a proxy or a restarting hub, for a moment). */
const TURN_TRANSIENT = new Set([502, 503, 504]);

/**
 * The typed request's first hop (POST /voice/free/turn) with the same transient-retry rule as the command send (release re-check M6): a dropped
 * connection or a 502/503/504 is tried again after a short pause; anything else, or the last failure, is thrown with what happened. The turn
 * itself only decides (rules, tool calls); nothing it returns has run yet, so asking again cannot do anything twice.
 */
export async function turnWithRetry(send: () => Promise<Response>, delaysMs: readonly number[] = [400, 1200, 3000], sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Response> {
  let last = "";
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await send();
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      last = (error as Error)?.message || "network error";
    }
    if (response && !TURN_TRANSIENT.has(response.status)) return response;
    if (response) {
      last = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
    }
    if (attempt >= delaysMs.length) throw new TurnFailed(last, attempt + 1);
    await sleep(delaysMs[attempt]);
  }
}

/** The typed turn could not be reached: said plainly, never replaced by a different kind of answer. */
export class TurnFailed extends Error {
  constructor(readonly why: string, readonly tries: number) {
    super(`That didn't go through: Jarvis couldn't be reached (${why}, tried ${tries} time${tries === 1 ? "" : "s"}). Nothing ran. Send it again in a moment.`);
  }
}

/** A small FIFO of requests waiting for the running one, bounded so a stuck run can't pile up work behind it. */
export function createTypedQueue<T = string>(max = 5) {
  const items: T[] = [];
  return {
    /** False when full: the caller says so instead of queueing. */
    push(request: T): boolean {
      if (items.length >= max) return false;
      items.push(request);
      return true;
    },
    next(): T | undefined {
      return items.shift();
    },
    clear() {
      items.length = 0;
    },
    /** Take everything waiting (to say each one wasn't run). */
    drain(): T[] {
      return items.splice(0);
    },
    get size() {
      return items.length;
    },
    /** No room for another: a request would be refused, not queued. */
    get full() {
      return items.length >= max;
    },
  };
}
