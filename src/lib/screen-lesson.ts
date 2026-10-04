/**
 * The voice client's side of a lesson (Jarvis teaching a task with his own cursor, or taking over).
 * The lesson runs on the server (scripts/screen-hands/lesson.ts); this keeps its state for the
 * pill and for routing his next words ("next", "just do it", "yes" to a final button), and follows
 * its event stream so lines Jarvis says while he works ("That one — Font, in the middle.") are
 * announced as soon as he's done a step. Design: docs/SCREEN-CONTROL.md, "Teach mode".
 */
import { lessonShortcut, type LessonCommand, type LessonMode, type LessonState } from "./lesson-words";
import { setDriveMode, startDriving, stopDriving, stopDrivingState } from "./screen-drive";

export type LessonReply = { id: string; said: string; state: LessonState; confirm?: string; ok?: boolean; detail?: string; seq?: number };
type Post = <T>(path: string, body: unknown, signal: AbortSignal) => Promise<T>;
type Current = { id: string; goal: string; state: LessonState; confirm?: string };

let current: Current | null = null;
let stream: AbortController | null = null;

export function currentLesson(): Current | null {
  return current;
}

/** What his words do to the running lesson, if anything (no model call). */
export function lessonCommandFor(utterance: string): LessonCommand | null {
  return lessonShortcut(utterance, current);
}

const pillMode = (state: LessonState) => (state === "teaching" ? "teaching" : "driving");

function apply(reply: LessonReply) {
  if (!current || current.id !== reply.id) return;
  if (reply.state === "ended") return endLesson();
  current = { ...current, state: reply.state, ...(reply.confirm ? { confirm: reply.confirm } : { confirm: undefined }) };
  setDriveMode(pillMode(reply.state), reply.said);
}

/** Forget the lesson client-side: the pill goes, the stream closes. */
export function endLesson() {
  stream?.abort();
  stream = null;
  current = null;
  stopDrivingState();
}

/** Follow the lesson's events: announce each new line, keep the pill and routing state current. */
function follow(id: string, announce: (line: string) => void, since = 0) {
  stream?.abort();
  const controller = new AbortController();
  stream = controller;
  void (async () => {
    try {
      const response = await fetch(`/__operator/screen/lesson/events?id=${encodeURIComponent(id)}&since=${since}`, { signal: controller.signal });
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
          let event: { type?: string; said?: string; state?: LessonState; confirm?: string; step?: string };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (!current || current.id !== id) return;
          if (event.type === "say" && event.said) {
            announce(event.said);
            apply({ id, said: event.said, state: event.state ?? current.state, ...(event.confirm ? { confirm: event.confirm } : {}) });
          } else if (event.type === "state" && event.state) {
            current = { ...current, state: event.state };
            setDriveMode(pillMode(event.state), event.step);
          } else if (event.type === "end") return endLesson();
        }
      }
    } catch {
      /* aborted, or the OS restarted: the lesson ended with it */
    }
  })();
}

/** Start a lesson on the window he's looking at; returns the first line to speak. */
export async function startLesson(goal: string, mode: LessonMode, options: { post: Post; signal: AbortSignal; announce: (line: string) => void }): Promise<LessonReply> {
  endLesson();
  const reply = await options.post<LessonReply>("/screen/lesson", { goal, mode }, options.signal);
  if (reply.state === "ended") return reply;
  current = { id: reply.id, goal, state: reply.state, ...(reply.confirm ? { confirm: reply.confirm } : {}) };
  // The pill's Stop ends the lesson on the server too (/screen/stop).
  startDriving(goal, () => undefined, pillMode(reply.state));
  setDriveMode(pillMode(reply.state), reply.said);
  // Only events after this reply: an older state event must not undo a pending confirmation.
  follow(reply.id, options.announce, reply.seq ?? 0);
  return reply;
}

/**
 * A course (Teach Mode 2.0): start, continue or list it. When a lesson starts, it's followed exactly
 * like startLesson's; otherwise the reply is just the line to say.
 */
export async function startCourse(
  body: { action: "start" | "continue" | "next" | "list"; topic?: string; style?: "show" | "guide" | "quiz"; vision?: boolean },
  options: { post: Post; signal: AbortSignal; announce: (line: string) => void },
): Promise<LessonReply> {
  if (body.action !== "list") endLesson();
  const reply = await options.post<LessonReply>("/screen/course", body, options.signal);
  if (reply.state === "ended" || !reply.id) return reply;
  const goal = body.topic ? `${body.topic} lesson` : "lesson";
  current = { id: reply.id, goal, state: reply.state, ...(reply.confirm ? { confirm: reply.confirm } : {}) };
  startDriving(goal, () => undefined, pillMode(reply.state));
  setDriveMode(pillMode(reply.state), reply.said);
  follow(reply.id, options.announce, reply.seq ?? 0);
  return reply;
}

/** Steer the running lesson; returns the next line to speak. */
export async function commandLesson(command: LessonCommand, options: { post: Post; signal: AbortSignal; spokenYes?: string | null }): Promise<LessonReply> {
  const id = current?.id ?? "";
  if ("control" in command && command.control === "stop") {
    // Instant, whatever the network does: the pill and cursor go now, the server confirms.
    const reply = await options.post<LessonReply>("/screen/lesson/control", command, options.signal).catch(() => ({ id, said: "Stopped.", state: "ended" as const }));
    endLesson();
    await stopDriving();
    return reply;
  }
  // A confirm carries the server-recorded spoken-yes event; the server refuses a confirm without one.
  const body = "confirm" in command && options.spokenYes ? { ...command, spokenYes: options.spokenYes } : command;
  const reply = await options.post<LessonReply>("/screen/lesson/control", body, options.signal);
  apply(reply);
  return reply;
}

type TurnMessage = { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string } }> };
type TurnReply = { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };

/**
 * The voice turn, short-circuited while a lesson runs (no model call, ~0 ms):
 * - his "next" / "you do it" / "stop" / "yes" / answer → one screen_teach call;
 * - screen_teach's result is already the line to say → spoken as it is, not rephrased.
 * Null: an ordinary turn for the server.
 */
export function lessonTurn(messages: TurnMessage[], lesson: Current | null = current): TurnReply | null {
  const last = messages[messages.length - 1];
  if (!last) return null;
  if (last.role === "tool") {
    let i = messages.length - 1;
    const results: TurnMessage[] = [];
    while (i >= 0 && messages[i].role === "tool") results.unshift(messages[i--]);
    const call = messages[i];
    if (call?.role === "assistant" && call.tool_calls?.length && call.tool_calls.every((c) => c.function.name === "screen_teach"))
      return { content: results.map((r) => r.content ?? "").join(" ").trim() || null };
    return null;
  }
  if (last.role !== "user") return null;
  const command = lessonShortcut(last.content ?? "", lesson);
  if (!command) return null;
  return { content: null, tool_calls: [{ id: `lesson_${Date.now().toString(36)}`, type: "function", function: { name: "screen_teach", arguments: JSON.stringify(command) } }] };
}
