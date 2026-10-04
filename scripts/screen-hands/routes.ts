// HTTP routes for lessons (teach / take over), mounted by operator-plugin.ts under /__operator:
//   POST /screen/lesson           {goal, mode: "teach"|"drive"}  → the first thing to say
//   POST /screen/lesson/control   {control} | {confirm} | {answer} → the next thing to say
//   GET  /screen/lesson/events?id=&since=  NDJSON: lines to announce as he works, state, the end
//   GET  /screen/lesson           → { active, id, goal, mode, state }
//   POST /screen/overlay          {inScreenshots: true} lets the Jarvis cursor show in screenshots
//        (for a demo or docs); by default it's excluded from every capture, vision included.
//   POST /screen/point            {question, kind?, target?, vision?} → one answer, pointed at (no clicks)
//   POST /screen/tutor            {on: boolean} → the line to say; GET /screen/tutor → status
//   GET  /screen/tutor/events?since=  NDJSON: tips to announce while he works
//   POST /screen/course           {action: start|continue|next|list, topic?, style?, vision?} → a course's
//        next lesson starts (its first line), or the course's status; GET /screen/course?topic=
//   POST /screen/cdp              {app} (flag `cdp`) → open VS Code/Slack/Obsidian/Discord with a
//        loopback-only DevTools port, only when he asks; GET /screen/cdp → sessions and flags
//   POST /screen/command          moved to scripts/jarvis-command/route.ts (Track 2): the ONE entry for typed and
//        spoken commands, for every verified founder, job-backed, routed to the requester's own device.
//   GET  /screen/runs[?id=]        the step log: run summaries (newest first) or one run in full
// Screen control runs on this PC only: a Tailscale session gets 403. "Stop" is /screen/stop, which
// ends lessons and hides the Jarvis cursor too.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parsePointRequest, type ScreenHands } from "./index";
import { parseLessonCommand, parseLessonRequest, type LessonEvent } from "./lesson";
import type { CourseIntent, LessonStyle } from "../../src/lib/lesson-words";
import { createLiveEntry } from "../jev-entry-server";
import type { JarvisEntry } from "../jev-command";

/** The live entry, built on first use per ScreenHands (one app browser per server). */
const entries = new WeakMap<object, JarvisEntry>();
export function entryFor(screen: ScreenHands): JarvisEntry {
  let entry = entries.get(screen);
  if (!entry) {
    entry = createLiveEntry({ screen }).entry;
    entries.set(screen, entry);
  }
  return entry;
}

/** Validate POST /screen/course. */
export function parseCourseRequest(body: unknown): CourseIntent & { vision: boolean } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const action = ["start", "continue", "next", "list"].includes(b.action as string) ? (b.action as CourseIntent["action"]) : null;
  if (!action) throw new Error("Start, continue or list which course?");
  const topic = typeof b.topic === "string" && b.topic.trim() ? b.topic.trim().slice(0, 80) : undefined;
  const style = ["show", "guide", "quiz"].includes(b.style as string) ? (b.style as LessonStyle) : undefined;
  return { action, ...(topic ? { topic } : {}), ...(style ? { style } : {}), vision: b.vision === true };
}

export async function lessonRoute(input: {
  path: string;
  method: string;
  url: URL;
  body: unknown;
  remote: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  screen: ScreenHands;
  send: (value: unknown, status?: number) => void;
}): Promise<boolean> {
  const { path, method, url, body, remote, res, screen, send } = input;
  if (!path.startsWith("/screen/lesson") && !path.startsWith("/screen/tutor") && path !== "/screen/overlay" && path !== "/screen/point" && path !== "/screen/cdp" && path !== "/screen/course" && path !== "/screen/runs") return false;
  if (remote) {
    send({ error: "Screen control runs on this PC only." }, 403);
    return true;
  }
  if (path === "/screen/runs" && method === "GET") {
    const id = (url.searchParams.get("id") || "").slice(0, 64);
    if (id) {
      const run = screen.runs.get(id);
      send(run ? { run } : { error: "No such run (the log is in memory and clears on restart)." }, run ? 200 : 404);
    } else send({ runs: screen.runs.list() });
    return true;
  }
  if (path === "/screen/course" && method === "GET") {
    send({ course: screen.courses.status(url.searchParams.get("topic") ?? undefined) });
    return true;
  }
  if (path === "/screen/course" && method === "POST") {
    let request;
    try {
      request = parseCourseRequest(body);
    } catch (error) {
      send({ id: "", said: (error as Error).message, state: "ended" }, 400);
      return true;
    }
    // Building a new course can take several seconds; if he goes away first, it's dropped.
    const controller = new AbortController();
    res.once("close", () => void (res.writableEnded || controller.abort()));
    try {
      send(await screen.courses.handle(request, { vision: request.vision, signal: controller.signal }));
    } catch (error) {
      send({ id: "", said: `The course didn't start: ${(error as Error).message}`.slice(0, 200), state: "ended" });
    }
    return true;
  }
  if (path === "/screen/cdp" && method === "GET") {
    send({ flags: screen.flags(), sessions: screen.cdpSessions() });
    return true;
  }
  if (path === "/screen/cdp" && method === "POST") {
    const app = typeof (body as { app?: unknown } | null)?.app === "string" ? ((body as { app: string }).app.trim().slice(0, 60)) : "";
    if (!app) {
      send({ ok: false, said: "Open which app for driving?" }, 400);
      return true;
    }
    try {
      send(await screen.openForDriving(app));
    } catch (error) {
      send({ ok: false, said: `I couldn't open it: ${(error as Error).message}`.slice(0, 200) });
    }
    return true;
  }
  if (path === "/screen/overlay" && method === "POST") {
    const b = (body ?? {}) as { inScreenshots?: unknown };
    const excluded = await screen.overlay.excludeFromCapture(b.inScreenshots !== true);
    send({ inScreenshots: b.inScreenshots === true, ok: excluded, pid: screen.overlay.pid() });
    return true;
  }
  if (path === "/screen/point" && method === "POST") {
    let request;
    try {
      request = parsePointRequest(body);
    } catch (error) {
      send({ ok: false, said: (error as Error).message, via: "none" }, 400);
      return true;
    }
    const controller = new AbortController();
    res.once("close", () => void (res.writableEnded || controller.abort()));
    try {
      send(await screen.point(request, controller.signal));
    } catch (error) {
      send({ ok: false, said: `I couldn't point: ${(error as Error).message}`.slice(0, 200), via: "none" });
    }
    return true;
  }
  if (path === "/screen/tutor" && method === "GET") {
    send(screen.tutor.status());
    return true;
  }
  if (path === "/screen/tutor" && method === "POST") {
    const b = (body ?? {}) as { on?: unknown };
    if (typeof b.on !== "boolean") {
      send({ said: "Say whether the tutor should be on or off.", on: screen.tutor.on }, 400);
      return true;
    }
    send({ said: screen.tutor.set(b.on), on: screen.tutor.on, seq: screen.tutor.status().seq });
    return true;
  }
  if (path === "/screen/tutor/events" && method === "GET") {
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-store");
    let closed = false;
    const beat = setInterval(() => void (res.writableEnded || res.write("\n")), 15_000);
    beat.unref?.();
    let stop: () => void = () => undefined;
    stop = screen.tutor.subscribe(since, (event) => {
      if (closed || res.writableEnded) return;
      res.write(`${JSON.stringify(event)}\n`);
      if (event.type === "state" && !event.on) finish();
    });
    function finish() {
      if (closed) return;
      closed = true;
      stop();
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    }
    res.once("close", finish);
    return true;
  }
  if (path === "/screen/lesson" && method === "GET") {
    send(screen.lessons.status());
    return true;
  }
  if (path === "/screen/lesson" && method === "POST") {
    let request;
    try {
      request = parseLessonRequest(body);
    } catch (error) {
      send({ said: (error as Error).message, state: "ended" }, 400);
      return true;
    }
    // If the caller goes away before hearing the first line, nobody is steering: stop it.
    res.once("close", () => void (res.writableEnded || screen.stopAll()));
    try {
      send(await screen.lessons.start(request));
    } catch (error) {
      send({ said: `The lesson couldn't start: ${(error as Error).message}`.slice(0, 200), state: "ended" });
    }
    return true;
  }
  if (path === "/screen/lesson/control" && method === "POST") {
    let command;
    try {
      command = parseLessonCommand(body);
    } catch (error) {
      send({ said: (error as Error).message, state: "ended" }, 400);
      return true;
    }
    // A confirm needs the voice pipeline's spoken-yes event (REVIEW-SAFETY finding 4).
    const spokenYes = typeof (body as { spokenYes?: unknown } | null)?.spokenYes === "string" && /^[a-f0-9-]{36}$/i.test((body as { spokenYes: string }).spokenYes) ? (body as { spokenYes: string }).spokenYes : undefined;
    send(await screen.lessons.command(command, { requireSpokenYes: true, ...(spokenYes ? { spokenYes } : {}) }));
    return true;
  }
  if (path === "/screen/lesson/events" && method === "GET") {
    const id = (url.searchParams.get("id") || "").slice(0, 80);
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-store");
    let closed = false;
    let stop: () => void = () => undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      stop();
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    };
    const write = (event: LessonEvent) => {
      if (closed || res.writableEnded) return;
      res.write(`${JSON.stringify(event)}\n`);
      if (event.type === "end") finish();
    };
    // A blank line now and then keeps proxies and the browser from timing the stream out.
    const beat = setInterval(() => void (res.writableEnded || res.write("\n")), 15_000);
    beat.unref?.();
    res.once("close", finish);
    stop = screen.lessons.subscribe(id, since, write);
    return true;
  }
  return false;
}
