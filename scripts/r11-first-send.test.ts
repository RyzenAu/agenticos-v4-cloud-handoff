// Round 11 defect 1 (first send): the client-side ways a typed Jarvis request vanished, each reproduced on the synthetic hub (8191).
//  - Text typed into the /jarvis request box before hydration was wiped by React's hydration (same element, value "" ~0.9 s after load)
//    and its Send button stayed disabled: no POST at all.
//  - A request arriving while the companion was still busy (or paused) returned silently from execute() after the page had cleared its box.
//  - A transient 503 on the send showed nothing useful (the retry itself is covered in jarvis-command-client.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandEventId, createTypedQueue, pageChangedLine, PAUSED_LINE, QUEUED_LINE, TurnFailed, turnWithRetry, typedRequestId, typedSendGate } from "../src/lib/typed-send";
import { captureTypedRequest, runPersistedTypedRequest, runPersistedTypedTurn, TypedPersistenceFailure } from "../src/lib/typed-persistence";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("a typed request is never dropped silently", () => {
  test("busy queues, paused says so, idle runs", () => {
    expect(typedSendGate({ busy: false, paused: false })).toBe("run");
    expect(typedSendGate({ busy: true, paused: false })).toBe("queue");
    expect(typedSendGate({ busy: true, paused: true })).toBe("paused");
    expect(QUEUED_LINE).toMatch(/queued/i);
    expect(PAUSED_LINE).toMatch(/didn't send/i);
  });

  test("the queue is first in, first out, and bounded", () => {
    const q = createTypedQueue(2);
    expect(q.push("a")).toBe(true);
    expect(q.push("b")).toBe(true);
    expect(q.push("c")).toBe(false);
    expect([q.next(), q.next(), q.next()]).toEqual(["a", "b", undefined]);
  });

  test("the companion's execute() has no silent early return for busy/paused, queues instead, and clears a busy flag after a voice start", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).not.toContain("if (!request.trim() || busyRef.current || pausedRef.current) return;");
    expect(vc).toContain("typedSendGate({ busy: busyRef.current, paused: pausedRef.current, request })");
    expect(vc).toContain("typedQueue.current.push({ request, requestId })");
    expect(vc).toContain("} else if (busyOwner.current === owner) {");
    expect(vc).toContain("if (next) queueMicrotask(() => void execute(next.request, true, next.requestId));");
  });

  test("a request handed to the companion is sent at once, never behind a timer that a hidden or minimised window throttles", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).not.toContain("window.setTimeout(() => void executeRef.current(request.trim().slice(0, 600)), 0)");
    expect(vc).toContain("queueMicrotask(() => void executeRef.current(words, requestId))");
  });

  test("the companion shows the client's Reconnecting… line while a send is retried", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain('if (event.stage === "reconnect") { note(event.text);');
  });

  test("the /jarvis request box is read-only until hydrated, so pre-hydration typing can't be wiped", () => {
    // R11 UI-CORE: the request box is now the composer pinned under the Jarvis thread (jarvis-thread.tsx, rendered by jarvis-page.tsx).
    const page = read("src/components/shell/pages/jarvis-page.tsx");
    expect(page).toContain("<JarvisThread />");
    const composer = read("src/components/shell/pages/jarvis-thread.tsx");
    expect(composer).toContain("useEffect(() => setHydrated(true), []);");
    expect(composer).toContain("readOnly={!hydrated}");
    // a send before hydration is refused (the text stays in the box); the box clears only once the companion accepted the request
    expect(composer).toContain("if (!hydrated || !request.trim()) return;");
    // M5: one identity per composed request; Send on the same waiting words is the same request; the box clears only once accepted
    expect(composer).toContain('if (sendDecision(pendingRef.current, request) === "same") return;');
    expect(composer).toContain("sendJarvisRequest(request,");
    expect(composer.indexOf('if (outcome !== "accepted") return;')).toBeLessThan(composer.indexOf('setRequest("");'));
    // never "nothing was sent" while the shell may still replay it
    expect(composer).not.toContain("nothing was sent");
    // PR #7: the slow line now says it waits for the request AND reply to be confirmed saved; an explicit rejection keeps the words and id.
    expect(composer).toContain("Waiting for Jarvis to confirm your request and reply are saved.");
    expect(composer).toContain('if (outcome === "rejected") {');
    expect(composer.indexOf('if (outcome === "rejected") {')).toBeLessThan(composer.indexOf('setRequest("");'));
    expect(read("src/components/operator/voice-companion.tsx")).toContain("acceptJarvisRequest({ requestId });");
  });
});

describe("review follow-ups (round 11): typed stop while busy, the queue's promise, and the page it was typed on", () => {
  test("a typed stop while busy or paused is a stop, never queued; other words still queue", () => {
    for (const w of ["stop", "cancel that", "never mind", "Jarvis, stop"]) expect([w, typedSendGate({ busy: true, paused: false, request: w })]).toEqual([w, "stop"]);
    expect(typedSendGate({ busy: false, paused: true, request: "stop" })).toBe("stop");
    expect(typedSendGate({ busy: true, paused: false, request: "stop the music in src/stop.ts" })).toBe("queue");
    expect(typedSendGate({ busy: false, paused: false, request: "stop" })).toBe("run");
  });

  test("the queued line says a stop cancels what is waiting too; a page change reports each waiting request as not run", () => {
    expect(QUEUED_LINE).toMatch(/stop cancels .* anything waiting/i);
    expect(pageChangedLine("explain this")).toContain('I didn\'t run "explain this"');
    const q = createTypedQueue();
    q.push("a");
    q.push("b");
    expect(q.drain()).toEqual(["a", "b"]);
    expect(q.size).toBe(0);
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain('if (gate === "stop") stop();');
    expect(vc).toContain("append(\"assistant\", pageChangedLine(waiting.request));");
  });
});

describe("release re-check (round 11): every Stop empties the queue; the typed turn's first hop retries and never swaps in another answer", () => {
  test("the pill's Stop runs every registered stop listener (the companion empties its queue there)", async () => {
    const { onDrivingStop, stopDriving } = await import("../src/lib/screen-drive");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    let cleared = 0;
    const off = onDrivingStop(() => void cleared++);
    try {
      await stopDriving();
    } finally {
      off();
      globalThis.fetch = realFetch;
    }
    expect(cleared).toBe(1);
    const vc = read("src/components/operator/voice-companion.tsx");
    // PR #7: every Stop still empties the queue, and now also tells each waiting composer its request was not run (rejectQueuedTyped drains it).
    expect(vc).toContain('useEffect(() => onDrivingStop(() => rejectQueuedTyped(() => "Stopped before this queued request ran.")), []);');
    expect(vc).toContain('if (TYPED_STOP.test(utterance)) rejectQueuedTyped(() => "Stopped before this queued request ran.");');
    const rejectBody = vc.slice(vc.indexOf("const rejectQueuedTyped = "), vc.indexOf("const rejectQueuedTyped = ") + 300);
    expect(rejectBody).toContain("for (const waiting of typedQueue.current.drain())");
    const stopBody = vc.slice(vc.indexOf("  function stop() {"), vc.indexOf("  function stop() {") + 300);
    expect(stopBody).toContain("rejectQueuedTyped(");
  });

  test("the first hop retries a 503 with the same request, then succeeds", async () => {
    let n = 0;
    const r = await turnWithRetry(async () => (++n === 1 ? new Response("", { status: 503 }) : Response.json({ content: "ok" })), [0, 0], async () => undefined);
    expect(n).toBe(2);
    expect(r.status).toBe(200);
  });

  test("after the last try it says the turn failed and that nothing ran (never a substituted chat answer)", async () => {
    let n = 0;
    const err = await turnWithRetry(async () => { n++; return new Response("", { status: 503 }); }, [0, 0], async () => undefined).catch((e) => e);
    expect(n).toBe(3);
    expect(err).toBeInstanceOf(TurnFailed);
    expect(String(err.message)).toMatch(/didn't go through.*HTTP 503.*Nothing ran/);
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).not.toMatch(/typedTurn\([^)]*\)\.catch\(\(\) => null\)/);
    // PR #7 moved the turn loop into src/lib/typed-persistence.ts: the scoped-bot lane keeps turnWithRetry; the durable founder lane
    // retries the identical stage on 502/503/504 and then fails as itself, never as a substituted answer or a command fallback.
    expect(read("src/lib/typed-persistence.ts")).toContain('turnWithRetry(() => post("/voice/free/turn", body, signal))');
    let calls = 0;
    const state = captureTypedRequest("jr-r11-retry", "hello", {});
    const failed = await runPersistedTypedTurn(state, async () => { calls++; return new Response("", { status: 503 }); }, new AbortController().signal, async () => { throw new Error("no tool may run"); }, [0, 0]).catch((e) => e);
    expect(calls).toBe(3);
    expect(failed).toBeInstanceOf(TypedPersistenceFailure);
    expect(String(failed.message)).toMatch(/HTTP 503.*no command fallback was run/);
  });

  test("a 400 is not retried", async () => {
    let n = 0;
    const r = await turnWithRetry(async () => { n++; return new Response("{}", { status: 400 }); }, [0, 0], async () => undefined);
    expect(n).toBe(1);
    expect(r.status).toBe(400);
  });

  test("the composer is told 'accepted' only when the request will run or wait its turn (not when paused or the queue is full)", () => {
    const q = createTypedQueue(1);
    expect(q.full).toBe(false);
    q.push("a");
    expect(q.full).toBe(true);
    const vc = read("src/components/operator/voice-companion.tsx");
    // PR #7: "accepted" now means durably saved (request and reply). Paused or a full queue is an explicit rejection, so the composer keeps its text.
    expect(vc).toContain("if (!waits) rejectJarvisRequest(requestId, line);");
    expect(vc.indexOf("acceptJarvisRequest({ requestId });\n      if (companionRetry")).toBeGreaterThan(vc.indexOf("const reply = await runTypedRequestForScope("));
    const launch = vc.slice(vc.indexOf("const launchText = "), vc.indexOf("const launchText = ") + 1200);
    expect(launch).not.toContain("acceptJarvisRequest");
  });

  test("bot coding drafts and starts record their origin; voice-turn drafts use the scoped conversation", () => {
    expect(read("scripts/agents/jarvis.ts")).toContain("{ codingDrafted: true }");
    const op = read("scripts/operator-plugin.ts");
    expect(op).toContain("await linkCodingDraft(turn.caller, r.jobId, utterance, turn.conversationId)");
    expect(read("scripts/free-voice.ts")).toContain("{ conversationId: input.conversationId }");
  });
});

describe("round 11 (UI-core follow-up): the composer's request id is the command's identity; the exchange is saved to the Jarvis thread", () => {
  test("the composer's requestId is used as the command eventId (numbered after the first command); a bad one is replaced", () => {
    expect(typedRequestId("jr-abc12345")).toBe("jr-abc12345");
    expect(typedRequestId("bad id with spaces")).toMatch(/^typed-/);
    expect(commandEventId("jr-abc12345", 0)).toBe("jr-abc12345");
    expect(commandEventId("jr-abc12345", 1)).toBe("jr-abc12345.2");
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain("const requestId = typedRequestId((event as CustomEvent<{ requestId?: unknown }>).detail?.requestId);");
    // PR #7: the turn loop numbers commands itself (commandIndex); the typed request's id is still the command eventId.
    expect(vc).toContain("eventId: commandEventId(state.requestId, commandIndex)");
    expect(vc).toContain("reply = await typedTurn(current, durable, controller)");
  });

  test("the durable turn numbers each jarvis_command after the first, from the composer's request id", async () => {
    const state = captureTypedRequest("jr-abc12345", "do two things", {});
    state.conversationId = "11111111-2222-3333-4444-555555555555";
    const seen: number[] = [];
    let step = 0;
    const ack = (complete: boolean) => ({ requestId: "jr-abc12345", conversationId: "11111111-2222-3333-4444-555555555555", saved: true, complete });
    const call = (id: string) => ({ id, type: "function" as const, function: { name: "jarvis_command", arguments: "{}" } });
    const reply = await runPersistedTypedTurn(state, async () => Response.json(step++ === 0 ? { content: null, tool_calls: [call("a"), call("b")], persistence: ack(false) } : { content: "done", persistence: ack(true) }), new AbortController().signal, async (_c, i) => { seen.push(i); return "ok"; }, []);
    expect(reply).toBe("done");
    expect(seen.map((i) => commandEventId("jr-abc12345", i))).toEqual(["jr-abc12345", "jr-abc12345.2"]);
  });

  test("the typed request and its reply (plain answers too) go to /screen/command/thread/say", async () => {
    // PR #7: the saves moved into runPersistedTypedRequest and are awaited: the request is saved BEFORE anything runs, the reply after.
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain("const reply = await runTypedRequestForScope(durable, async () => {");
    const order: string[] = [];
    const state = captureTypedRequest("jr-say-0001", "Reply with QA JARVIS 20261005 only.", {});
    const post = async (path: string, body: { part?: string; requestId?: string }) => { order.push(`${path}:${body.part}`); return Response.json({ saved: true, requestId: body.requestId, conversationId: "11111111-2222-3333-4444-555555555555" }); };
    const answer = await runPersistedTypedRequest(state, async () => { order.push("effect"); return "QA JARVIS 20261005"; }, post as never, new AbortController().signal);
    expect(answer).toBe("QA JARVIS 20261005");
    expect(order).toEqual(["/screen/command/thread/say:user", "effect", "/screen/command/thread/say:reply"]);
  });
});

describe("round 11 staging: a turn that can't run on this hub goes to the command path, never a different kind of answer", () => {
  test("a non-transient turn error runs the typed request through runJarvisCommand with the same request id; a transient one says it failed", () => {
    // PR #7: only the scoped-bot lane keeps this fallback (same request id, the request's own Stop signal). The durable founder lane rethrows:
    // an unknown or unsaved outcome must never become a second, different command.
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain("if (durableTypedScope(durable.options) || error instanceof TypedPersistenceFailure) throw error;");
    expect(vc).toContain("const out = await jarvisCommand({ utterance: request, typed: true, eventId: commandEventId(requestId, 0) }, controller.signal, undefined, resolvedTypedExecutionContext(durable, durable.execution));");
    expect(vc).toContain('if (error instanceof TurnFailed || error.name === "AbortError") return error instanceof TurnFailed ? error.message : "Stopped.";');
  });
});

describe("final review B2: a Stop from the panel or Escape reaches the typed request's hub call", () => {
  test("the typed turn's controller lives in a ref that stop() aborts; the fallback runs through the command tool with that signal", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    const stopBody = vc.slice(vc.indexOf("  function stop() {"), vc.indexOf("  function stop() {") + 600);
    expect(stopBody).toContain("typedTurnAbort.current?.abort();");
    const turnBody = vc.slice(vc.indexOf("async function typedTurn("), vc.indexOf("async function typedTurn(") + 400);
    expect(turnBody).toContain("typedTurnAbort.current = controller;");
    // PR #7: one controller per typed request, set before its save/route/turn, covers the scoped-bot fallback too (no separate fallback controller).
    const execBody = vc.slice(vc.indexOf("  async function execute("));
    expect(execBody.indexOf("typedTurnAbort.current = controller;")).toBeLessThan(execBody.indexOf("const reply = await runTypedRequestForScope("));
    expect(vc).toContain("}, voicePost, controller.signal);");
    // No typed-request command call without a signal any more.
    expect(vc).not.toContain('runJarvisCommand({ utterance: request, source: "typed"');
  });
});
