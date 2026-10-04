/**
 * HTTP for the ONE Jarvis command entry (Track 2), mounted under /__operator BEFORE the screen-only
 * routes, so a verified remote founder reaches it too (their command runs on THEIR device, never the hub):
 *
 *   POST /screen/command          CommandBody → NDJSON CommandStreamEvent lines, the last one "done"
 *   GET  /screen/command/attach   ?job=<id>&since=<seq> → NDJSON: the job's events after `since`, then live
 *   POST /screen/command/cancel   { jobId } → { ok, state }
 *
 * Identity is the caller's verified principal (B1), resolved by the host; any `personId` in the body is
 * ignored. The body is validated and bounded here; the page context is parsed by the service.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { mayUseBots, type Principal } from "../identity/principal";
import { botThreadId, parseBotConversationKey } from "../conversations";
import { SUBJECT_REF } from "../jobs/types";
import { COMMAND_ROUTE_HEADER, COMPANION_EXECUTORS, MAX_REMOTE_STEPS, type CommandBody, type CommandStreamEvent, type ExecutorName, type RemoteStep } from "./contracts";
import type { CommandService } from "./service";
import { BOT_NEEDS_SESSION } from "./linked-run";

/** A typed plan from the body: only companion executors, plain-object args, at most MAX_REMOTE_STEPS. Anything else is dropped whole. */
export function parseSteps(value: unknown): RemoteStep[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > MAX_REMOTE_STEPS) return undefined;
  const steps: RemoteStep[] = [];
  for (const raw of value) {
    const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const executor = typeof s?.executor === "string" ? (s.executor as ExecutorName) : null;
    if (!executor || !COMPANION_EXECUTORS.includes(executor)) return undefined;
    const args = s!.args && typeof s!.args === "object" && !Array.isArray(s!.args) && JSON.stringify(s!.args).length <= 4_000 ? (s!.args as Record<string, unknown>) : {};
    steps.push({ executor, args });
  }
  return steps;
}

/** Validate POST /screen/command. `personId` is never read (identity is the verified principal). */
export function parseCommandBody(body: unknown): CommandBody {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const utterance = typeof b.utterance === "string" ? b.utterance.trim().slice(0, 600) : "";
  if (!utterance) throw new Error("Say what Jarvis should do.");
  const source = b.source === "voice" || b.source === "typed" || b.source === "acceptance" ? b.source : "typed";
  const spokenTarget = typeof b.spokenTarget === "string" && b.spokenTarget.trim() ? b.spokenTarget.trim().slice(0, 60) : undefined;
  const spokenYes = typeof b.spokenYes === "string" && /^[a-f0-9-]{36}$/i.test(b.spokenYes) ? b.spokenYes : undefined;
  let pageContext: CommandBody["pageContext"];
  if (b.pageContext && typeof b.pageContext === "object" && JSON.stringify(b.pageContext).length <= 24_000) pageContext = b.pageContext as CommandBody["pageContext"];
  const steps = parseSteps(b.steps);
  // A conversation id is a UUID, or a bot conversation's readable key (agent:<personId>:<botId>; the service maps it to the verified person's own thread).
  const conversationId = typeof b.conversationId === "string" && (/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(b.conversationId) || parseBotConversationKey(b.conversationId)) ? b.conversationId : undefined;
  const targetBot = b.target && typeof b.target === "object" && !Array.isArray(b.target) && typeof (b.target as { bot?: unknown }).bot === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test((b.target as { bot: string }).bot) ? (b.target as { bot: string }).bot : undefined;
  const subjects = Array.isArray(b.subjects) ? (b.subjects as unknown[]).filter((v): v is string => typeof v === "string" && SUBJECT_REF.test(v)).slice(0, 8) : undefined;
  const eventId = typeof b.eventId === "string" && /^[\w:.-]{6,80}$/.test(b.eventId) ? b.eventId : undefined;
  return { utterance, source, ...(conversationId ? { conversationId } : {}), ...(targetBot ? { target: { bot: targetBot } } : {}), ...(subjects?.length ? { subjects } : {}), ...(eventId ? { eventId } : {}), ...(spokenTarget ? { spokenTarget } : {}), ...(spokenYes ? { spokenYes } : {}), ...(pageContext ? { pageContext } : {}), ...(steps ? { steps } : {}) };
}

function ndjson(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  return (event: unknown) => void (res.writableEnded || res.destroyed || res.write(`${JSON.stringify(event)}\n`));
}

export async function commandRoute(input: {
  path: string;
  method: string;
  url: URL;
  body: unknown;
  principal: Principal;
  req: IncomingMessage;
  res: ServerResponse;
  service: CommandService;
  send: (value: unknown, status?: number) => void;
  memoryCaller?: unknown;
}): Promise<boolean> {
  const { path, method, url, body, principal, res, service, send } = input;
  // Marks every answer of this route, so a client (and whoever reads its log) can tell a hub answer from one made in front of it.
  if (path.startsWith("/screen/command") && !res.headersSent && typeof res.setHeader === "function") res.setHeader(COMMAND_ROUTE_HEADER, "1");
  if (path === "/screen/command" && method === "POST") {
    let request: CommandBody;
    try {
      request = parseCommandBody(body);
    } catch (error) {
      send({ type: "done", ok: false, said: (error as Error).message, kind: "ask", jobId: null, runId: "", targetDeviceId: null }, 400);
      return true;
    }
    const write = ndjson(res);
    let jobId: string | null = null;
    let finished = false;
    let sentDone = false;
    const listener = (e: CommandStreamEvent) => {
      if (e.type === "job") jobId = e.jobId;
      if (e.type === "done") sentDone = true;
      write(e);
    };
    // A dropped stream isn't a stop: the job keeps running for the reconnect grace period (see service).
    res.once("close", () => void (!finished && jobId && service.dropped(jobId, listener)));
    try {
      const done = await service.run({ principal, body: request, memoryCaller: input.memoryCaller }, listener);
      // Answers that need no job (a stop, an empty request) come back without a stream: send the done.
      if (!sentDone) write(done);
    } catch (error) {
      // A job already started before the fault: say so, and that its outcome is not known to this reply, so a resend is not taken for a fresh start.
      write({ type: "done", ok: false, said: (jobId ? `Jarvis started it but hit a fault afterwards: ${(error as Error).message}` : `Jarvis couldn't do that: ${(error as Error).message}`).slice(0, 200), kind: "unavailable", jobId, runId: "", targetDeviceId: null, ...(jobId ? { outcome: "unverified" } : {}) });
    }
    finished = true;
    if (!res.writableEnded) res.end();
    return true;
  }
  if (path === "/screen/command/attach" && method === "GET") {
    const job = (url.searchParams.get("job") || "").slice(0, 64);
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    let detach: () => void = () => undefined;
    const write = ndjson(res);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      detach();
      if (!res.writableEnded) res.end();
    };
    const listener = (e: CommandStreamEvent) => {
      write(e);
      if (e.type === "done") queueMicrotask(end);
    };
    const attached = service.attach(job, principal, since, listener);
    if (!attached.ok) {
      write({ type: "done", ok: false, said: attached.reason, kind: "unavailable", jobId: job || null, runId: "", targetDeviceId: null });
      end();
      return true;
    }
    detach = attached.detach;
    res.once("close", () => {
      if (!ended) service.dropped(job, listener);
      ended = true;
    });
    return true;
  }
  // GET /screen/command/thread?conversation=<id>&after=<seq> -> { conversationId, entries }: the server-appended job results in this person's
  // Jarvis thread (the voice client says the short ones at a pause; the activity stream shows them). Reads only.
  if (path === "/screen/command/thread" && method === "GET") {
    const raw = url.searchParams.get("conversation") || "";
    const key = parseBotConversationKey(raw);
    const conversation = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(raw) ? raw : key && key.personId === principal.personId ? botThreadId(key.personId, key.botId) : undefined;
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    // A bot's conversation is for a confirmed person or the owner at the hub (a bare tailnet login reads nothing of it); the default thread is unchanged.
    if ((key || service.isBotThread(principal.personId, conversation)) && !mayUseBots(principal)) return send({ error: BOT_NEEDS_SESSION }, 403), true;
    const r = service.threadUpdates(principal, conversation, after);
    return r ? (send(r), true) : (send({ error: "That conversation is someone else's." }, 403), true);
  }
  // POST /screen/command/thread/say { requestId, part, role, text }: a typed request or its reply saved into the caller's own default Jarvis thread.
  if (path === "/screen/command/thread/say" && method === "POST") {
    const b = (body ?? {}) as { requestId?: unknown; part?: unknown; role?: unknown; text?: unknown };
    const requestId = typeof b.requestId === "string" && /^[\w:.-]{6,80}$/.test(b.requestId) ? b.requestId : "";
    const part = b.part === "user" || b.part === "reply" || b.part === "note" ? b.part : null;
    const role = b.role === "user" || b.role === "assistant" ? b.role : null;
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 4000) : "";
    if (!requestId || !part || !role || !text) return send({ ok: false, error: "Say what to save." }, 400), true;
    const id = service.threadSay(principal, { requestId, part, role, text });
    return send(id ? { ok: true, conversationId: id } : { ok: false, error: "The Jarvis thread couldn't be written." }, id ? 200 : 503), true;
  }
  // { jobId } stops that job; { eventId } (his Stop before the job id reached him) stops that command, before it starts if it hasn't.
  // 200 only for a confirmed stop (or one prevented before any job existed); 409 with `outcome` otherwise ("already-ended", "unconfirmed").
  if (path === "/screen/command/cancel" && method === "POST") {
    const b = (body ?? {}) as { jobId?: unknown; eventId?: unknown };
    const jobId = typeof b.jobId === "string" ? b.jobId.slice(0, 64) : "";
    const eventId = typeof b.eventId === "string" && /^[\w:.-]{6,80}$/.test(b.eventId) ? b.eventId : "";
    if (!jobId && !eventId) return send({ ok: false, error: "Which job?" }, 400), true;
    const r = jobId ? await service.cancel(jobId, principal) : await service.cancelEvent(eventId, principal);
    send(r, r.ok ? 200 : 409);
    return true;
  }
  return false;
}
