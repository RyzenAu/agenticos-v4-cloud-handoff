import { turnWithRetry } from "./typed-send";

export type TypedReply = { content?: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
export type TypedMessage = { role: string; content: string | null; tool_calls?: TypedReply["tool_calls"]; tool_call_id?: string };
export type TypedPost = (path: string, body: unknown, signal: AbortSignal) => Promise<Response>;
const UUID = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;

/** A jarvis_command tool result's spoken line (src/lib/jarvis-command.ts commandResultText), or null. */
function commandResultSaid(result: unknown): string | null {
  try {
    const v = JSON.parse(String(result ?? "")) as { type?: unknown; said?: unknown };
    return v?.type === "command_result" && typeof v.said === "string" && v.said.trim() ? v.said : null;
  } catch { return null; }
}

/** A failed typed decision never authorizes switching to the command path. */
export class TypedPersistenceFailure extends Error {
  constructor(message: string, readonly answer?: string, readonly retryable = false) { super(message); }
}

export type TypedExecutionContext<Page = unknown, Route = unknown> = {
  pageContext: Page;
  routeContext: Route;
  pathname: string;
  personId?: string;
  scope: { conversationId?: string; target?: { bot: string } };
  spokenYes: string | null;
};

/** Client-owned context travels separately from model tool arguments. */
export function captureTypedExecutionContext<Page, Route>(context: TypedExecutionContext<Page, Route>): TypedExecutionContext<Page, Route> {
  // Typed words cannot reuse a prior spoken approval, even when the text is identical.
  return { ...JSON.parse(JSON.stringify(context)), spokenYes: null };
}
/** Only reference identity can retarget an action; a job/progress/source refresh is not a new origin. */
function pageReferenceIdentity(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const value = snapshot as Record<string, unknown>;
  const item = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return raw ?? null;
    const v = raw as Record<string, unknown>;
    return { kind: v.kind, id: v.id, to: v.to, focus: v.focus, search: v.search && typeof v.search === "object" ? Object.fromEntries(Object.entries(v.search).sort(([a], [b]) => a.localeCompare(b))) : v.search };
  };
  const page = value.page && typeof value.page === "object" ? { path: (value.page as Record<string, unknown>).path, destination: (value.page as Record<string, unknown>).destination } : value.page;
  return { page, selection: item(value.selection), focused: item(value.focused) };
}
export function assertTypedExecutionContext<Page, Route>(captured: TypedExecutionContext<Page, Route>, current: TypedExecutionContext<Page, Route>): void {
  if (captured.pathname !== current.pathname || captured.personId !== current.personId || JSON.stringify(captured.scope) !== JSON.stringify(current.scope) || JSON.stringify(pageReferenceIdentity(captured.routeContext)) !== JSON.stringify(pageReferenceIdentity(current.routeContext))) {
    throw new TypedPersistenceFailure("The page or conversation changed before this typed action. Execution is paused; check the saved conversation before starting another request.");
  }
}
/** This is the command adapter boundary: a typed context suppresses every live context getter. */
export function commandExecutionContext<Page, Route>(captured: TypedExecutionContext<Page, Route> | undefined, live: () => TypedExecutionContext<Page, Route>): TypedExecutionContext<Page, Route> {
  return captured ?? live();
}
/** Keep the captured target and page; only the verified server may resolve the previously omitted conversation. */
export function resolvedTypedExecutionContext<Page, Route>(state: TypedRequest, captured: TypedExecutionContext<Page, Route>): TypedExecutionContext<Page, Route> {
  return { ...captured, scope: { ...captured.scope, ...(state.conversationId ? { conversationId: state.conversationId } : {}) } };
}

export type TypedRequest = {
  requestId: string;
  text: string;
  options: Record<string, unknown>;
  conversationId?: string;
  userSaved: boolean;
  answer?: string;
  pendingAnswer?: string;
  /** The last command line a tool spoke during this request (a jarvis_command result): the reply if the turn cannot finish. */
  toolSaid?: string;
  saved: boolean;
  running: boolean;
  started?: boolean;
  controller?: AbortController;
  blocked?: Error;
  turn?: { messages: TypedMessage[]; step: number; commands: number; body?: Record<string, unknown> };
};

export function hasTypedAdmissionCapacity(records: { size: number }, cancelled: { size: number }): boolean {
  return records.size < 64 && cancelled.size < 64;
}

/** Cancel only work that has not started effects, including the pre-microtask and companion-queue windows. */
export function cancelTypedAdmission<T extends { requestId: string }>(requestId: string, records: Map<string, TypedRequest>, cancelled: Set<string>, queue: { drain(): T[]; push(item: T): boolean }): boolean {
  const state = records.get(requestId);
  if (state?.started) return false;
  // Once tombstones fill, the companion refuses fresh admission until reload; existing queued records still cancel.
  if (cancelled.size < 64) cancelled.add(requestId);
  if (state) {
    state.running = false;
    state.blocked = new DOMException("Cancelled before this request started.", "AbortError");
    state.controller?.abort();
  }
  for (const waiting of queue.drain()) if (waiting.requestId !== requestId) queue.push(waiting);
  return true;
}

/** Capture scope/style once. A retry must not silently change the principal conversation or decision body. */
export function captureTypedRequest(requestId: string, text: string, options: Record<string, unknown>): TypedRequest {
  const copy = JSON.parse(JSON.stringify(options)) as Record<string, unknown>;
  const conversationId = copy.conversationId;
  if (conversationId !== undefined && (typeof conversationId !== "string" || !UUID.test(conversationId))) throw new TypedPersistenceFailure("The conversation is not valid. Nothing was sent.");
  return { requestId, text, options: copy, ...(typeof conversationId === "string" ? { conversationId } : {}), userSaved: false, saved: false, running: false };
}

function failure(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }

/** The user append is a barrier: no routing, model call or tool may start before its durable acknowledgement. */
export async function saveTypedPart(state: TypedRequest, part: "user" | "reply", text: string, post: TypedPost, signal: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await post("/screen/command/thread/say", { requestId: state.requestId, ...(state.conversationId ? { conversationId: state.conversationId } : {}), part, role: part === "user" ? "user" : "assistant", text }, signal);
  } catch (error) {
    throw new TypedPersistenceFailure(`${part === "user" ? "Your request" : "The reply"} is not confirmed saved: ${failure(error, "connection lost")}. Retry this same request.`, part === "reply" ? text : undefined, true);
  }
  const body = await response.json().catch(() => ({})) as { saved?: boolean; requestId?: string; conversationId?: string; error?: string };
  if (!response.ok || body.saved !== true || body.requestId !== state.requestId || !body.conversationId || !UUID.test(body.conversationId) || (state.conversationId && body.conversationId !== state.conversationId)) {
    throw new TypedPersistenceFailure(`${part === "user" ? "Your request" : "The reply"} is not confirmed saved. ${body.error || `HTTP ${response.status}; missing or mismatched save acknowledgement.`} Retry this same request.`, part === "reply" ? text : undefined, true);
  }
  // An omitted conversation is resolved by the verified server once, before any effect.
  state.conversationId = body.conversationId;
  if (part === "user") state.userSaved = true;
  else state.saved = true;
}

/** The new server protocol is for the person's Jarvis thread; scoped bot turns retain their existing path. */
export function durableTypedScope(options: Record<string, unknown>): boolean {
  return !(options.target && typeof options.target === "object" && (options.target as { bot?: unknown }).bot);
}

/** Original scoped-bot turn shape, with no founder persistence or new opt-in fields. */
export async function runScopedBotTypedTurn(state: TypedRequest, post: TypedPost, signal: AbortSignal, tool: (call: NonNullable<TypedReply["tool_calls"]>[number], commandIndex: number) => Promise<string>): Promise<string> {
  const messages: TypedMessage[] = [{ role: "user", content: state.text }];
  let commands = 0;
  for (let step = 0; step < 5; step++) {
    const body = JSON.parse(JSON.stringify({ ...state.options, messages, typed: true }));
    const response = await turnWithRetry(() => post("/voice/free/turn", body, signal));
    const reply = await response.json().catch(() => ({})) as TypedReply & { error?: string; code?: string };
    if (!response.ok) {
      if (reply.code?.startsWith("typed_")) throw new TypedPersistenceFailure(reply.error || reply.code);
      throw new Error(reply.error || `Jarvis answered HTTP ${response.status}.`);
    }
    if (!reply.tool_calls?.length) return reply.content ?? "";
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) messages.push({ role: "tool", tool_call_id: call.id, content: String(await tool(call, call.function.name === "jarvis_command" ? commands++ : commands)).slice(0, 4000) });
  }
  return "That needed more steps than I can take in one go. Give it to me in smaller pieces.";
}

/** The scope switch never strips or replaces a bot's conversation/target. */
export async function runTypedRequestForScope(state: TypedRequest, effect: () => Promise<string>, post: TypedPost, signal: AbortSignal): Promise<string> {
  return durableTypedScope(state.options) ? runPersistedTypedRequest(state, effect, post, signal) : effect();
}

/** Run once; a reply-save retry can only retry the save. Unknown execution cannot become a new command. */
export async function runPersistedTypedRequest(state: TypedRequest, effect: () => Promise<string>, post: TypedPost, signal: AbortSignal): Promise<string> {
  if (state.blocked) throw state.blocked;
  if (!state.userSaved) await saveTypedPart(state, "user", state.text, post, signal);
  if (state.answer === undefined) {
    try { signal.throwIfAborted(); state.answer = await effect(); }
    catch (error) {
      if (!(error instanceof TypedPersistenceFailure && error.retryable && state.turn)) {
        state.blocked = error instanceof Error ? error : new Error(String(error));
        // Final: this request will not run again, so what the person is shown is its reply, saved once after the request (5 Oct QA:
        // a command answer was shown but only the request reached the conversation). A retryable save failure keeps its retry instead.
        await saveFinalOutcome(state, finalOutcomeText(state, error), post);
      }
      throw error;
    }
  }
  if (!state.saved) await saveTypedPart(state, "reply", state.answer, post, signal);
  return state.answer;
}

/** The words a final failure leaves on screen: an unsaved answer or the command's own line, then why it stopped. */
export function finalOutcomeText(state: TypedRequest, error: unknown): string {
  const answer = (error instanceof TypedPersistenceFailure ? error.answer : undefined) ?? state.pendingAnswer ?? state.toolSaid;
  const why = error instanceof DOMException && error.name === "AbortError" ? "Stopped." : error instanceof Error ? error.message : String(error);
  return [answer, why].filter((part, i, all) => !!part && all.indexOf(part) === i).join("\n\n").slice(0, 20_000);
}
/** Best effort, never on the (possibly aborted) request signal; the server's keyed reply makes a repeat a no-op and a conflict a refusal. */
async function saveFinalOutcome(state: TypedRequest, text: string, post: TypedPost): Promise<void> {
  if (!state.userSaved || state.saved || !text.trim()) return;
  await saveTypedPart(state, "reply", text, post, AbortSignal.timeout(8000)).catch(() => undefined);
}

/** Retry only the identical stage, retaining the last HTTP error body (including an unsaved answer). */
async function postTypedStage(send: () => Promise<Response>, delays: readonly number[], signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await send();
      if (!response.ok) {
        const error = await response.clone().json().catch(() => ({})) as { code?: string };
        // Typed errors contain the save/uncertainty contract, possibly the only copy of an unsaved answer.
        if (error.code?.startsWith("typed_")) return response;
      }
      if (![502, 503, 504].includes(response.status) || attempt >= delays.length) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal.aborted || attempt >= delays.length) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delays[attempt]);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

/** Keeps the exact stage body and completed tool results for retry; nothing already executed is rerun. */
export async function runPersistedTypedTurn(state: TypedRequest, post: TypedPost, signal: AbortSignal, tool: (call: NonNullable<TypedReply["tool_calls"]>[number], commandIndex: number) => Promise<string>, delays: readonly number[] = [400, 1200, 3000]): Promise<string> {
  const turn = state.turn ??= { messages: [{ role: "user", content: state.text }], step: 0, commands: 0 };
  for (; turn.step < 5; turn.step++) {
    turn.body ??= JSON.parse(JSON.stringify({ ...state.options, messages: turn.messages, typed: true, requestId: state.requestId, turnIndex: turn.step, ...(state.conversationId ? { conversationId: state.conversationId } : {}) }));
    let response: Response;
    try { response = await postTypedStage(() => post("/voice/free/turn", turn.body, signal), delays, signal); }
    catch (error) {
      throw new TypedPersistenceFailure(`The typed reply is not confirmed saved: ${failure(error, "connection lost")}. Retry this same request; earlier tools will not be rerun.`, state.pendingAnswer, signal.aborted ? false : true);
    }
    const parsed = await response.json().catch(() => ({})) as TypedReply & { error?: string; code?: string; persistence?: { requestId?: string; conversationId?: string; saved?: boolean; complete?: boolean } };
    if (typeof parsed.content === "string" && !parsed.tool_calls?.length) state.pendingAnswer = parsed.content;
    if (!response.ok) throw new TypedPersistenceFailure(`${parsed.error || `Jarvis answered HTTP ${response.status}.`} The typed request was not completed; no command fallback was run.`, state.pendingAnswer, (parsed.code === "typed_save_failed" || parsed.code === "typed_save_busy" || (!parsed.code && [502, 503, 504].includes(response.status))));
    const ack = parsed.persistence;
    const terminal = !parsed.tool_calls?.length;
    if (!ack || ack.saved !== true || ack.requestId !== state.requestId || ack.conversationId !== state.conversationId || ack.complete !== terminal) throw new TypedPersistenceFailure("The typed reply has no matching save acknowledgement. Execution is paused; do not resend it as a new request.", terminal && typeof parsed.content === "string" ? parsed.content : undefined);
    if (terminal) {
      if (typeof parsed.content !== "string" || !parsed.content.trim()) throw new TypedPersistenceFailure("The saved typed reply was empty. Execution is paused.");
      state.saved = true;
      state.pendingAnswer = undefined;
      return parsed.content;
    }
    if (turn.messages.filter((message) => message.role === "tool").length + parsed.tool_calls!.length > 20) throw new TypedPersistenceFailure("Jarvis reached the tool limit. Earlier tools may have run; do not resend this as a new request.");
    turn.messages.push({ role: "assistant", content: parsed.content ?? null, tool_calls: parsed.tool_calls });
    for (const call of parsed.tool_calls!) {
      const result = await tool(call, call.function.name === "jarvis_command" ? turn.commands++ : turn.commands);
      const said = commandResultSaid(result);
      if (said) state.toolSaid = said;
      turn.messages.push({ role: "tool", tool_call_id: call.id, content: String(result ?? "").slice(0, 4000) });
    }
    turn.body = undefined;
  }
  throw new TypedPersistenceFailure("Jarvis reached the step limit. Earlier tools may have run; do not resend this as a new request.");
}
