// @ts-ignore: bun:test is supplied by the isolated test runner.
import { describe, expect, test } from "bun:test";
import { captureTypedRequest, cancelTypedAdmission, hasTypedAdmissionCapacity, captureTypedExecutionContext, assertTypedExecutionContext, commandExecutionContext, resolvedTypedExecutionContext, durableTypedScope, runTypedRequestForScope, runScopedBotTypedTurn, runPersistedTypedRequest, runPersistedTypedTurn, saveTypedPart, TypedPersistenceFailure, type TypedPost } from "./typed-persistence";
import { acceptJarvisRequest, rejectJarvisRequest, startJarvisRequest, onJarvisRequestCancelled, retryRequestId, sendJarvisRequest, readInterruptedRequest, rememberInterruptedRequest } from "./jarvis-send";
import { createTypedQueue } from "./typed-send";
const ID = "jr-plain-review-1";
const CONVERSATION = "00000000-0000-0000-0000-000000000001";
const TEXT = "Reply with QA JARVIS 20261005 only.";
const ANSWER = "QA JARVIS 20261005";
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const ack = () => json({ saved: true, requestId: ID, conversationId: CONVERSATION });
const terminal = () => json({ content: ANSWER, persistence: { saved: true, requestId: ID, conversationId: CONVERSATION, complete: true } });

describe("durable typed request and real composer event adapter", () => {
  test("failed user append retains text+identity, visibly rejects, and blocks every effect; same-ID retry saves both", async () => {
    const bus = new EventTarget();
    const state = captureTypedRequest(ID, TEXT, {});
    let effects = 0;
    let fail = true;
    const calls: unknown[] = [];
    const post: TypedPost = async (path, body) => {
      calls.push(body);
      if (path.endsWith("/say")) return fail ? json({ error: "disk full", code: "typed_save_failed" }, 503) : ack();
      return terminal();
    };
    const send = () => sendJarvisRequest(TEXT, { target: bus, requestId: ID, slowMs: 1000 });
    const run = async () => {
      try {
        await runPersistedTypedRequest(state, async () => { effects++; return runPersistedTypedTurn(state, post, signal(), async () => { throw Error("No tool expected"); }, []); }, post, signal());
        acceptJarvisRequest({ requestId: ID }, bus);
      } catch (e) { rejectJarvisRequest(ID, (e as Error).message, bus); }
    };
    const first = send();
    await run();
    expect(await first.done).toBe("rejected");
    expect(first.failure).toContain("disk full");
    expect(first.text).toBe(TEXT);
    expect(retryRequestId(first, TEXT)).toBe(ID);
    expect(effects).toBe(0);
    fail = false;
    const retry = send();
    await run();
    expect(await retry.done).toBe("accepted");
    expect(effects).toBe(1);
    expect(state.answer).toBe(ANSWER);
    expect(state.saved).toBe(true);
    expect((calls[0] as any).requestId).toBe((calls[1] as any).requestId);
    expect(calls.length).toBe(3); // user failed, user saved, server terminal reply saved; no duplicate client reply append
  });

  test("an answered route retries only the reply save, retaining all answer bytes", async () => {
    const state = captureTypedRequest(ID, TEXT, {});
    const answer = `  ${ANSWER}\n${"x".repeat(4100)}\n`;
    let effects = 0;
    let fails = true;
    const saves: any[] = [];
    const post: TypedPost = async (_path, body) => { saves.push(body); return (body as any).part === "reply" && fails ? json({ error: "full" }, 503) : ack(); };
    const effect = async () => { effects++; return answer; };
    try { await runPersistedTypedRequest(state, effect, post, signal()); throw Error("Expected failure"); }
    catch (e) { expect(e).toBeInstanceOf(TypedPersistenceFailure); expect((e as TypedPersistenceFailure).answer).toBe(answer); }
    expect(state.answer).toBe(answer);
    fails = false;
    expect(await runPersistedTypedRequest(state, effect, post, signal())).toBe(answer);
    expect(effects).toBe(1);
    expect(saves[1]).toEqual(saves[2]);
    expect(saves[2].text).toBe(answer);
  });

  test("typed reply-save failure resumes exact stage body, preserves the answer, and never replays completed tools", async () => {
    const options = { replyStyle: "short", origin: { page: "/jarvis" } };
    const state = captureTypedRequest(ID, TEXT, options);
    let tools = 0;
    let fail = true;
    const bodies: any[] = [];
    const post: TypedPost = async (path, body) => {
      if (path.endsWith("/say")) return ack();
      bodies.push(JSON.parse(JSON.stringify(body)));
      if ((body as any).turnIndex === 0) return json({ content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "jarvis_command", arguments: "{}" } }], persistence: { requestId: ID, conversationId: CONVERSATION, saved: true, complete: false } });
      return fail ? json({ error: "reply not saved", code: "typed_save_failed", saved: false, content: ANSWER }, 503) : terminal();
    };
    const effect = () => runPersistedTypedTurn(state, post, signal(), async () => { tools++; return "finished tool"; }, []);
    await expect(runPersistedTypedRequest(state, effect, post, signal())).rejects.toMatchObject({ answer: ANSWER, retryable: true });
    options.replyStyle = "long";
    options.origin.page = "/different";
    fail = false;
    expect(await runPersistedTypedRequest(state, effect, post, signal())).toBe(ANSWER);
    expect(tools).toBe(1);
    expect(bodies.map(b => b.turnIndex)).toEqual([0, 1, 1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[2].origin.page).toBe("/jarvis");
    expect(bodies[2].requestId).toBe(ID);
    expect(bodies[2].messages.at(-1).content).toBe("finished tool");
  });

  test.each(["typed_request_conflict", "typed_outcome_unknown", "typed_conversation_forbidden", "typed_reply_too_large"])("%s blocks fallback and future effect retries", async (code: string) => {
    const state = captureTypedRequest(ID, TEXT, {});
    let turns = 0;
    let commands = 0;
    const post: TypedPost = async path => path.endsWith("/say") ? ack() : (turns++, json({ code, error: code }, 409));
    const effect = () => runPersistedTypedTurn(state, post, signal(), async () => { commands++; return "bad"; }, []);
    await expect(runPersistedTypedRequest(state, effect, post, signal())).rejects.toThrow(code);
    await expect(runPersistedTypedRequest(state, effect, post, signal())).rejects.toThrow(code);
    expect(turns).toBe(1);
    expect(commands).toBe(0);
  });

  test("HTTP 200 without a matching durable acknowledgement is an explicit failure", async () => {
    const state = captureTypedRequest(ID, TEXT, {});
    state.conversationId = CONVERSATION;
    await expect(runPersistedTypedTurn(state, async () => json({ content: ANSWER }), signal(), async () => "", [])).rejects.toMatchObject({ answer: ANSWER, retryable: false });
  });

  test("a user-save acknowledgement for another conversation cannot authorize an effect", async () => {
    const state = captureTypedRequest(ID, TEXT, { conversationId: CONVERSATION });
    await expect(saveTypedPart(state, "user", TEXT, async () => json({ saved: true, requestId: ID, conversationId: "00000000-0000-0000-0000-000000000002" }), signal())).rejects.toThrow("not confirmed saved");
    expect(state.userSaved).toBe(false);
  });

  test("HTTP/network retry uses an unchanged stage and identity", async () => {
    const state = captureTypedRequest(ID, TEXT, {});
    state.conversationId = CONVERSATION;
    const bodies: unknown[] = [];
    const post: TypedPost = async (_path, body) => { bodies.push(JSON.parse(JSON.stringify(body))); return bodies.length === 1 ? json({}, 502) : terminal(); };
    expect(await runPersistedTypedTurn(state, post, signal(), async () => "", [0])).toBe(ANSWER);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  test("session storage preserves the interrupted identity across reload; edited words do not reuse it", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    rememberInterruptedRequest({ requestId: ID, text: TEXT }, storage);
    expect(readInterruptedRequest(storage)).toEqual({ requestId: ID, text: TEXT });
    expect(retryRequestId(readInterruptedRequest(storage), TEXT)).toBe(ID);
    expect(retryRequestId(readInterruptedRequest(storage), "changed words")).toBeUndefined();
    rememberInterruptedRequest(null, storage);
    expect(readInterruptedRequest(storage)).toBeNull();
  });

  test("a later connection failure does not discard the already generated unsaved answer", async () => {
    const state = captureTypedRequest(ID, TEXT, {});
    let phase = 0;
    const post: TypedPost = async path => {
      if (path.endsWith("/say")) return ack();
      if (phase++ === 0) return json({ error: "disk", code: "typed_save_failed", content: ANSWER }, 503);
      throw new Error("connection lost");
    };
    const effect = () => runPersistedTypedTurn(state, post, signal(), async () => "", []);
    await expect(runPersistedTypedRequest(state, effect, post, signal())).rejects.toMatchObject({ answer: ANSWER });
    await expect(runPersistedTypedRequest(state, effect, post, signal())).rejects.toMatchObject({ answer: ANSWER, retryable: true });
  });

  test("aborting during the initial append prevents routing even if that save finishes", async () => {
    const state = captureTypedRequest(ID, TEXT, {});
    const controller = new AbortController();
    let effects = 0;
    const post: TypedPost = async () => { controller.abort(); return ack(); };
    await expect(runPersistedTypedRequest(state, async () => { effects++; return ANSWER; }, post, controller.signal)).rejects.toThrow();
    expect(effects).toBe(0);
    await expect(runPersistedTypedRequest(state, async () => { effects++; return ANSWER; }, post, signal())).rejects.toThrow();
    expect(effects).toBe(0);
  });

  test("the bounded tool checkpoint refuses an oversized tool batch before executing it", async () => {
    const state = captureTypedRequest(ID, TEXT, {});
    state.conversationId = CONVERSATION;
    let tools = 0;
    const post: TypedPost = async () => json({ tool_calls: Array.from({ length: 21 }, (_, i) => ({ id: String(i), type: "function", function: { name: "anything", arguments: "{}" } })), persistence: { saved: true, requestId: ID, conversationId: CONVERSATION, complete: false } });
    await expect(runPersistedTypedTurn(state, post, signal(), async () => { tools++; return ""; }, [])).rejects.toThrow("tool limit");
    expect(tools).toBe(0);
  });


  test("scoped bot input stays on the legacy turn path with its exact conversation and target", async () => {
    const options = { conversationId: CONVERSATION, target: { bot: "builder-agent" }, replyStyle: "brief" };
    const state = captureTypedRequest(ID, TEXT, options);
    const calls: { path: string; body: any }[] = [];
    const post: TypedPost = async (path, body) => { calls.push({ path, body }); return json({ content: ANSWER }); };
    expect(durableTypedScope(options)).toBe(false);
    expect(await runTypedRequestForScope(state, () => runScopedBotTypedTurn(state, post, signal(), async () => ""), post, signal())).toBe(ANSWER);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/voice/free/turn");
    expect(calls[0].body).toEqual({ ...options, messages: [{ role: "user", content: TEXT }], typed: true });
    expect(calls[0].body.requestId).toBeUndefined();
    expect(calls[0].body.turnIndex).toBeUndefined();
    expect(state.userSaved).toBe(false);
  });


  test("the actual command context boundary never reads live replacement scope/page or model-supplied context", () => {
    const live = { pageContext: { page: { path: "/jarvis" } }, routeContext: { page: "A" }, pathname: "/jarvis", personId: "owner-a", scope: { conversationId: CONVERSATION, target: { bot: "bot-a" } }, spokenYes: "original-yes" };
    const captured = captureTypedExecutionContext(live);
    live.pageContext.page.path = "/different";
    live.scope.target.bot = "bot-b";
    const state = captureTypedRequest(ID, TEXT, captured.scope);
    let liveReads = 0;
    const boundary = commandExecutionContext(resolvedTypedExecutionContext(state, captured), () => { liveReads++; return live; });
    const forgedModelArgs = { conversationId: "forged", target: { bot: "forged" }, pageContext: "forged" };
    const actualCommand = { ...forgedModelArgs, pageContext: boundary.pageContext, spokenYes: boundary.spokenYes, ...boundary.scope };
    expect(liveReads).toBe(0);
    expect(actualCommand).toEqual({ conversationId: CONVERSATION, target: { bot: "bot-a" }, pageContext: { page: { path: "/jarvis" } }, spokenYes: null });
    expect(commandExecutionContext(undefined, () => live)).toBe(live); // existing voice path still uses live context
  });

  test("scope changing while user-save is awaited blocks the actual route adapter before any effect", async () => {
    let current = { pageContext: null, routeContext: { page: "A" }, pathname: "/jarvis", personId: "owner-a", scope: {}, spokenYes: null };
    const captured = captureTypedExecutionContext(current);
    const state = captureTypedRequest(ID, TEXT, {});
    let effects = 0;
    const post: TypedPost = async () => { current = { ...current, routeContext: { page: "B" } }; return ack(); };
    await expect(runPersistedTypedRequest(state, async () => { assertTypedExecutionContext(captured, current); effects++; return ANSWER; }, post, signal())).rejects.toThrow("page or conversation changed");
    expect(effects).toBe(0);
  });

  test("scope changing during model await cannot retarget a jarvis_command tool", async () => {
    let current = { pageContext: null, routeContext: { page: "A" }, pathname: "/jarvis", personId: "owner-a", scope: { conversationId: CONVERSATION }, spokenYes: null };
    const captured = captureTypedExecutionContext(current);
    const state = captureTypedRequest(ID, TEXT, captured.scope);
    let commands = 0;
    const post: TypedPost = async path => {
      if (path.endsWith("/say")) return ack();
      current = { ...current, scope: { conversationId: "00000000-0000-0000-0000-000000000002" } };
      return json({ tool_calls: [{ id: "retarget", type: "function", function: { name: "jarvis_command", arguments: "{}" } }], persistence: { saved: true, requestId: ID, conversationId: CONVERSATION, complete: false } });
    };
    await expect(runPersistedTypedRequest(state, () => runPersistedTypedTurn(state, post, signal(), async () => { assertTypedExecutionContext(captured, current); commands++; return "bad"; }, []), post, signal())).rejects.toThrow("page or conversation changed");
    expect(commands).toBe(0);
  });

  test("cancel before companion microtask or while queued removes admission and preserves FIFO for other requests", async () => {
    const bus = new EventTarget();
    const queue = createTypedQueue<{ requestId: string }>();
    const records = new Map();
    const cancelled = new Set<string>();
    const remove = onJarvisRequestCancelled(id => { cancelTypedAdmission(id, records, cancelled, queue); }, bus);
    const before = sendJarvisRequest(TEXT, { requestId: ID, target: bus });
    before.cancel();
    expect(await before.done).toBe("cancelled");
    expect(cancelled.has(ID)).toBe(true); // execute's pre-microtask admission guard
    const second = captureTypedRequest("jr-queued-review", TEXT, {});
    records.set(second.requestId, second);
    queue.push({ requestId: "jr-first" }); queue.push({ requestId: second.requestId }); queue.push({ requestId: "jr-last" });
    const queued = sendJarvisRequest(TEXT, { requestId: second.requestId, target: bus });
    queued.cancel();
    expect(await queued.done).toBe("cancelled");
    expect(queue.drain()).toEqual([{ requestId: "jr-first" }, { requestId: "jr-last" }]);
    expect(second.blocked?.name).toBe("AbortError");
    remove();
  });

  test("cancelling during initial append aborts pre-effect admission; editing after started only detaches the waiter", async () => {
    const bus = new EventTarget();
    const state = captureTypedRequest(ID, TEXT, {});
    state.controller = new AbortController();
    const records = new Map([[ID, state]]);
    const cancelled = new Set<string>();
    const queue = createTypedQueue<{ requestId: string }>();
    const remove = onJarvisRequestCancelled(id => { cancelTypedAdmission(id, records, cancelled, queue); }, bus);
    const pending = sendJarvisRequest(TEXT, { requestId: ID, target: bus });
    let effects = 0;
    await expect(runPersistedTypedRequest(state, async () => { effects++; return ANSWER; }, async () => { pending.cancel(); return ack(); }, state.controller.signal)).rejects.toThrow();
    expect(effects).toBe(0);
    expect(state.controller.signal.aborted).toBe(true);
    const started = sendJarvisRequest(TEXT, { requestId: "jr-started-review", target: bus });
    startJarvisRequest(started.requestId, bus);
    expect(started.started).toBe(true);
    started.cancel();
    expect(await started.done).toBe("cancelled");
    expect(cancelled.has(started.requestId)).toBe(false); // no claim that already owned effects were cancelled
    remove();
  });


  test("own job/timestamp/source updates during a tool do not reject the next tool on the same page", async () => {
    let context = { pageContext: null, routeContext: { page: { path: "/jarvis", destination: "jarvis", title: "Jarvis" }, selection: { kind: "lead", id: "lead-a", label: "Before", facts: { amount: "1" } }, focused: null, job: null as unknown, at: 1, sources: [] as unknown[] }, pathname: "/jarvis", scope: {}, spokenYes: null };
    const captured = captureTypedExecutionContext(context);
    const state = captureTypedRequest(ID, TEXT, {});
    let steps = 0;
    let tools = 0;
    const post: TypedPost = async path => {
      if (path.endsWith("/say")) return ack();
      if (steps++ > 0) return terminal();
      return json({ tool_calls: [1, 2].map(id => ({ id: `tool-${id}`, type: "function", function: { name: "jarvis_command", arguments: "{}" } })), persistence: { saved: true, requestId: ID, conversationId: CONVERSATION, complete: false } });
    };
    const result = await runPersistedTypedRequest(state, () => runPersistedTypedTurn(state, post, signal(), async () => {
      assertTypedExecutionContext(captured, context);
      tools++;
      context = { ...context, routeContext: { ...context.routeContext, job: { id: "own-job", state: "running" }, at: 99, sources: [{ lastSuccess: "new" }], selection: { ...context.routeContext.selection, label: "Refreshed", facts: { amount: "2" } } } };
      return "done";
    }, []), post, signal());
    expect(result).toBe(ANSWER);
    expect(tools).toBe(2);
    expect(() => assertTypedExecutionContext(captured, { ...context, routeContext: { ...context.routeContext, selection: { ...context.routeContext.selection, id: "lead-b" } } })).toThrow("page or conversation changed");
  });

  test("saturated cancellation tombstones stop fresh admission but still cancel known unstarted work", () => {
    const cancelled = new Set(Array.from({ length: 64 }, (_, i) => `jr-cancelled-${i}`));
    const state = captureTypedRequest(ID, TEXT, {});
    state.controller = new AbortController();
    const records = new Map([[ID, state]]);
    const queue = createTypedQueue<{ requestId: string }>();
    queue.push({ requestId: ID });
    expect(hasTypedAdmissionCapacity(new Map(), cancelled)).toBe(false);
    expect(cancelTypedAdmission(ID, records, cancelled, queue)).toBe(true);
    expect(state.controller.signal.aborted).toBe(true);
    expect(queue.size).toBe(0);
    expect(cancelled.size).toBe(64);
  });

});
