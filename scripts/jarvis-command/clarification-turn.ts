/** The admitted command boundary for a durable routing question. No executor or model runs here. */
import { randomUUID } from "node:crypto";

import { commandAdmissionKey } from "./admission";
import { clarificationRequest, type ClarificationRequest, type ClarificationRoute, type ClarificationPin, type ClarificationAuthority } from "./clarification";
import { parsePageContext } from "./context";
import type { Principal } from "../identity/principal";
import type { CommandDoneEvent } from "./contracts";
import type { RunInput } from "./service";
import type { JobThreads } from "./threads";

export type RoutingTurn = {
  authority: ClarificationAuthority;
  generation: string;
  conversationId: string;
  request: ClarificationRequest;
  originalEventId: string | null;
  selection?: ClarificationRoute;
  pin?: ClarificationPin | null;
  questionId?: string;
  askJobId?: string;
  targetDeviceId?: string | null;
};
const done = (said: string, kind: CommandDoneEvent["kind"] = "refused", extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent => ({ type: "done", ok: false, said, kind, jobId: null, runId: "", targetDeviceId: null, ...(kind === "refused" ? { refused: true } : {}), ...extra });

export function routingAuthority(principal: Principal): ClarificationAuthority | null {
  return principal.actor === "human" && ["paired-session", "loopback-owner"].includes(principal.via) ? "founder-session" : principal.actor === "process" && principal.via === "gateway" ? "gateway" : null;
}

/** Called after immutable reply admission, before bot scope or follow-up interpretation. */
export function prepareRoutingTurn(input: RunInput, threads: JobThreads | undefined, now: number, isStop: (words: string) => boolean): RunInput | CommandDoneEvent {
  const { principal, body } = input;
  const authority = routingAuthority(principal);
  if (!threads || typeof threads.beginRoutingTurn !== "function" || !authority || body.source === "acceptance" || body.source === "away") return input;
  const eventId = typeof body.eventId === "string" && /^[\w:.-]{6,80}$/.test(body.eventId) ? body.eventId : "";
  const generation = randomUUID();
  let prepared: ReturnType<JobThreads["beginRoutingTurn"]>;
  try {
    prepared = threads.beginRoutingTurn(principal.personId, body.conversationId, generation, {
      authority, utterance: String(body.utterance ?? ""), eventId,
      binding: input.admission?.binding ?? commandAdmissionKey(input, eventId || generation).binding,
      now, target: body.target, spokenTarget: body.spokenTarget, subjects: body.subjects, hasSteps: !!body.steps?.length, stop: isStop(String(body.utterance ?? "").trim()),
    });
  } catch {
    if (isStop(String(body.utterance ?? "").trim())) return { ...input, routingContextFailed: true };
    return done("I couldn't save this conversation's request context, so nothing new was started. Try again with the full request.", "unavailable");
  }
  // Compatibility stores have no durable adapter. An invalid/unowned conversation never falls back to another conversation.
  if (!prepared) return input;
  const { conversationId, transition } = prepared;
  if (transition.kind === "resume") {
    const { request, choice, record } = transition;
    const target = choice.route.kind === "bot" ? { bot: choice.route.bot } : request.target;
    return {
      ...input,
      // The actual reply still owns admission, Stop and source. The old request supplies only task data.
      body: { ...request, source: body.source ?? "typed", ...(body.eventId ? { eventId: body.eventId } : {}), ...(target ? { target } : {}) },
      routing: { authority, generation, conversationId, request, originalEventId: record.originalEventId, selection: choice.route, pin: transition.pin, questionId: record.id, askJobId: record.askJobId, targetDeviceId: record.targetDeviceId },
    };
  }
  if (transition.kind === "cancelled" && isStop(String(body.utterance ?? "").trim())) return { ...input, routingCancelled: true };
  if (transition.kind === "cancelled") return done("Dropped the request that was waiting for your route choice. Nothing was started.", "answer", { ok: true, stopped: true, numbers: { clarificationCancelled: true } });
  if (transition.kind === "expired") return done("That route question has expired, so nothing ran. Please send the full request again.", "ask", { ask: true });
  if (transition.kind === "ambiguous") return done("That name matches more than one offered route. Which exact agent or option do you mean? Nothing ran.", "ask", { ask: true });
  if (transition.kind === "conflict") return done("That answer does not match this request's saved binding. Nothing new was started. Send the full request with a new request ID.");
  if (transition.kind === "already-answered" || transition.kind === "replay") return done("That route question was already answered or dropped. Check its original conversation or job; nothing was started again.", "answer", { outcome: "unverified", numbers: { clarificationReplay: true } });
  const pageContext = parsePageContext(body.pageContext);
  return { ...input, routing: { authority, generation, conversationId, request: clarificationRequest({ ...body, ...(pageContext ? { pageContext } : { pageContext: undefined }) }, conversationId), originalEventId: typeof body.eventId === "string" && /^[\w:.-]{6,80}$/.test(body.eventId) ? body.eventId : null } };
}
