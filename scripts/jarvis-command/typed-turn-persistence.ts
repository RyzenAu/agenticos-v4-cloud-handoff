/** Durable typed free-turn receipts, in the existing conversation store. No caller identity is taken from a request body. */
import { createHash } from "node:crypto";
import { ConversationForbidden, TypedPersistenceError, type TypedBinding, type conversationStore } from "../conversations";
import type { Principal } from "../identity/principal";

type Store = Pick<ReturnType<typeof conversationStore>, "beginTypedTurn" | "finishTypedTurn">;
type Result = Record<string, unknown>;
export class TypedTurnError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly content?: string) { super(message); this.name = "TypedTurnError"; }
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const MAX_IN_FLIGHT = 64;
const MAX_RECEIPT_BYTES = 128_000;
function canonical(value: unknown): string {
  const budget = { nodes: 0, bytes: 0 };
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 12 || ++budget.nodes > 10_000) throw new TypedTurnError("typed_binding_invalid", "The typed request is too complex. Nothing ran.", 400);
    if (typeof v === "string") budget.bytes += Buffer.byteLength(v);
    if (budget.bytes > MAX_RECEIPT_BYTES) throw new TypedTurnError("typed_binding_invalid", "The typed request is too large. Nothing ran.", 400);
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => { budget.bytes += Buffer.byteLength(k); return [k, visit(x, depth + 1)]; }));
    return v;
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json) > MAX_RECEIPT_BYTES) throw new TypedTurnError("typed_binding_invalid", "The typed request is too large. Nothing ran.", 400);
  return json;
}
/** Only fields the turn executes against. Cookies, tokens, claimed identities and unrelated fields are never fingerprinted or saved. */
const executionInput = (input: Record<string, unknown>) => {
  const fields = Object.fromEntries(["context", "sharing", "remote", "device", "spokenYes", "replyStyle", "replyPersonality", "target", "conversationId"].filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  const messages = Array.isArray(input.messages) ? input.messages.map((raw) => {
    const m = object(raw);
    return {
      role: m.role, content: m.content,
      ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
      ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls.map((rawCall) => {
        const call = object(rawCall), fn = object(call.function);
        return { id: call.id, type: call.type, function: { name: fn.name, arguments: fn.arguments } };
      }) } : {}),
    };
  }) : input.messages;
  return { ...fields, messages };
};
const storageError = (e: unknown): TypedTurnError => e instanceof TypedTurnError ? e : e instanceof ConversationForbidden
  ? new TypedTurnError("typed_conversation_forbidden", "That conversation is not your Jarvis conversation. Nothing was changed.", 403)
  : e instanceof TypedPersistenceError ? new TypedTurnError(e.code, e.message, e.status)
  : new TypedTurnError("typed_save_failed", "The typed request or reply could not be saved. Keep this request id and retry; do not send it as a new request.", 503);

export function createTypedTurnPersistence(store: Store) {
  // A completed response whose write failed stays here so retry can save it without calling the model/rules again.
  // In-flight entries share the same promise. Durable pending receipts protect restarts without this map.
  const running = new Map<string, { fingerprint: string; promise?: Promise<Result>; result?: Result }>();
  return async function persist(body: unknown, principal: Principal | undefined, execute: () => Promise<Result>): Promise<Result> {
    const input = object(body);
    // Compatibility for voice and older callers. An opt-in request must supply the whole contract.
    if (input.typed !== true || input.requestId === undefined) return execute();
    if (!principal || !["usman", "mehroz"].includes(principal.personId) || principal.actor !== "human" || !["paired-session", "loopback-owner"].includes(principal.via))
      throw new TypedTurnError("typed_identity_required", "A verified founder session is needed to save this typed request. Nothing ran.", 403);
    if (object(input.target).bot !== undefined)
      throw new TypedTurnError("typed_conversation_forbidden", "A scoped bot turn must use its existing bot conversation path.", 403);
    const requestId = input.requestId;
    const index = input.turnIndex;
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 60)
      throw new TypedTurnError("typed_binding_invalid", "A typed turn needs between 1 and 60 messages. Nothing ran.", 400);
    const messages = input.messages.map(object);
    if (messages.some((m) => m.tool_calls !== undefined && (!Array.isArray(m.tool_calls) || m.tool_calls.length > 8)))
      throw new TypedTurnError("typed_binding_invalid", "A typed reply can contain at most eight tool calls. Nothing ran.", 400);
    const first = messages[0];
    if (typeof requestId !== "string" || !/^[\w:.-]{6,80}$/.test(requestId) || !Number.isInteger(index) || Number(index) < 0 || Number(index) > 4 ||
        first?.role !== "user" || typeof first.content !== "string" || !first.content.trim() || first.content.length > 8_000 || messages.slice(1).some((m) => m.role === "user") ||
        (input.conversationId !== undefined && (typeof input.conversationId !== "string" || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.conversationId))))
      throw new TypedTurnError("typed_binding_invalid", "A typed request needs its unchanged request id, conversation, original words and turn index (0–4). Nothing ran.", 400);
    const binding: TypedBinding = { personId: principal.personId, requestId, ...(typeof input.conversationId === "string" ? { conversationId: input.conversationId } : {}) };
    const fingerprint = createHash("sha256").update(canonical(executionInput(input))).digest("hex");
    const key = `${principal.personId}|${requestId}|${index}`;
    if (!running.has(key) && running.size >= MAX_IN_FLIGHT) throw new TypedTurnError("typed_save_busy", "Too many typed replies are waiting to be saved. Nothing ran; retry after the saved replies are recovered.", 503);
    let prior: ReturnType<Store["beginTypedTurn"]>;
    try { prior = store.beginTypedTurn(binding, { text: first.content, index: Number(index), fingerprint }); }
    catch (error) { throw storageError(error); }
    const decorate = (result: Result): Result => ({ ...result, persistence: { requestId, conversationId: prior.conversationId, saved: true, complete: !Array.isArray(result.tool_calls) || !result.tool_calls.length } });
    if (prior.state === "complete" && prior.result) return decorate(prior.result);
    const existing = running.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw new TypedTurnError("typed_request_conflict", "That request turn already has different input. Nothing ran.", 409);
    if (existing?.promise) return existing.promise;
    if (prior.state === "pending" && !existing?.result)
      throw new TypedTurnError("typed_outcome_unknown", "That typed turn reached the hub earlier, but its outcome was not saved. It was not run again. Check the conversation and any jobs before sending a new request.", 409);
    const entry: { fingerprint: string; promise?: Promise<Result>; result?: Result } = existing ?? { fingerprint };
    running.set(key, entry);
    const run = async (): Promise<Result> => {
      try {
        let result = entry.result;
        if (!result) {
          try { result = await execute(); }
          catch { throw new TypedTurnError("typed_outcome_unknown", "The typed turn failed before its result was saved. It was not run again. Check the conversation and any jobs before sending a new request.", 409); }
        }
        try { canonical(result); }
        catch { throw new TypedTurnError("typed_reply_too_large", "The typed reply is too large to save safely. The request remains saved and was not run again.", 502); }
        entry.result = result;
        const complete = !Array.isArray(result.tool_calls) || result.tool_calls.length === 0;
        // An empty no-tool reply is not a successfully persisted exchange.
        if (complete && (typeof result.content !== "string" || !result.content.trim()))
          throw new TypedTurnError("typed_reply_missing", "Jarvis returned no reply to save. The request remains saved; it was not run again.", 502);
        try {
          store.finishTypedTurn(binding, { text: first.content as string, index: Number(index), fingerprint, result, ...(complete ? { reply: result.content as string } : {}) });
        } catch (error) {
          const failure = storageError(error);
          throw new TypedTurnError(failure.code, failure.message, failure.status, complete && typeof result.content === "string" ? result.content : undefined);
        }
        running.delete(key);
        return decorate(result);
      } finally { entry.promise = undefined; if (!entry.result) running.delete(key); }
    };
    entry.promise = run();
    return entry.promise;
  };
}
