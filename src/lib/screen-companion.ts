/**
 * The voice client's side of the companion cursor (after Clicky): one-shot pointing ("where's the
 * export button?") and the opt-in proactive tutor ("watch me and help if I get stuck"). The work
 * runs on the server (scripts/screen-hands/point.ts and tutor.ts); this keeps the tutor's state for
 * the pill and for "stop", and follows its tip stream so a tip is announced when the conversation
 * is idle. Design: docs/CLICKY-COMPARISON.md.
 */
import { tutorIntent } from "./companion-words";
import { tidyWords } from "./lesson-words";
import { driveState, startDriving, stopDrivingState, subscribeDrive } from "./screen-drive";

type Post = <T>(path: string, body: unknown, signal: AbortSignal) => Promise<T>;
export type PointReply = { ok: boolean; said: string; via: string; label?: string; ms?: { point: number | null; arrived: number | null; total: number } };

let tutorOn = false;
let stream: AbortController | null = null;
let unsubscribe: (() => void) | null = null;

export function tutorActive() {
  return tutorOn;
}

/** One question about his screen, answered by pointing. Returns the line to speak. */
export async function pointAt(args: Record<string, unknown>, options: { post: Post; signal: AbortSignal; vision: boolean }): Promise<PointReply> {
  const question = typeof args.question === "string" ? args.question.trim().slice(0, 300) : "";
  if (!question) return { ok: false, said: "Point at what, sir?", via: "none" };
  const kind = args.kind === "find" || args.kind === "this" ? args.kind : undefined;
  const target = typeof args.target === "string" && args.target.trim() ? args.target.trim().slice(0, 80) : undefined;
  return options.post<PointReply>("/screen/point", { question, ...(kind ? { kind } : {}), ...(target ? { target } : {}), vision: options.vision }, options.signal);
}

/** While the tutor watches, the pill says so (and its Stop turns it off, via /screen/stop). */
function showWatching() {
  if (tutorOn && !driveState().on) startDriving("Watching for when you're stuck", () => undefined, "watching");
}

function follow(since: number, announce: (line: string) => void) {
  stream?.abort();
  const controller = new AbortController();
  stream = controller;
  void (async () => {
    try {
      const response = await fetch(`/__operator/screen/tutor/events?since=${since}`, { signal: controller.signal });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event: { type?: string; said?: string; on?: boolean };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "tip" && event.said) announce(event.said);
          else if (event.type === "state" && event.on === false) return forgetTutor();
        }
      }
    } catch {
      /* aborted, or the OS restarted: the tutor ended with it */
    }
  })();
}

/** Forget the tutor client-side: the stream closes and the "watching" pill goes. */
export function forgetTutor() {
  tutorOn = false;
  stream?.abort();
  stream = null;
  unsubscribe?.();
  unsubscribe = null;
  if (driveState().on && driveState().mode === "watching") stopDrivingState();
}

/** Switch the tutor on or off; returns the line to speak. */
export async function setTutor(on: boolean, options: { post: Post; signal: AbortSignal; announce: (line: string) => void }): Promise<string> {
  const reply = await options.post<{ said: string; on: boolean; seq?: number }>("/screen/tutor", { on }, options.signal);
  if (reply.on) {
    tutorOn = true;
    follow(reply.seq ?? 0, options.announce);
    unsubscribe?.();
    // A lesson or a screen_act run takes the pill for a while; the watching pill comes back after.
    let watching = false;
    unsubscribe = subscribeDrive((s) => {
      // The pill's Stop while watching: the server's /screen/stop has switched the tutor off.
      if (watching && !s.on) return forgetTutor();
      watching = s.on && s.mode === "watching";
      if (!s.on) setTimeout(showWatching, 0);
    });
    showWatching();
  } else forgetTutor();
  return reply.said;
}

type TurnMessage = { role: string; content: string | null };
type TurnReply = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };

/**
 * While the tutor watches, "stop", "stop watching" or "tutor off" switch it off with no model call.
 * Null: an ordinary turn.
 */
export function tutorTurn(messages: TurnMessage[], on = tutorOn): TurnReply | null {
  const last = messages[messages.length - 1];
  if (!on || last?.role !== "user") return null;
  const words = tidyWords(last.content ?? "").toLowerCase().replace(/[?!.,]+$/g, "");
  const off = tutorIntent(last.content ?? "")?.on === false || /^(?:stop|stop it|that'?s enough|quiet|be quiet|shush|leave me alone)$/.test(words);
  if (!off) return null;
  return { content: null, tool_calls: [{ id: `tutor_${Date.now().toString(36)}`, type: "function", function: { name: "screen_tutor", arguments: JSON.stringify({ on: false }) } }] };
}
