// Round 11 defect 1 (first send): the client-side ways a typed Jarvis request vanished, each reproduced on the synthetic hub (8191).
//  - Text typed into the /jarvis request box before hydration was wiped by React's hydration (same element, value "" ~0.9 s after load)
//    and its Send button stayed disabled: no POST at all.
//  - A request arriving while the companion was still busy (or paused) returned silently from execute() after the page had cleared its box.
//  - A transient 503 on the send showed nothing useful (the retry itself is covered in jarvis-command-client.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandEventId, createTypedQueue, pageChangedLine, PAUSED_LINE, QUEUED_LINE, TurnFailed, turnWithRetry, typedRequestId, typedSendGate } from "../src/lib/typed-send";

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
    expect(composer).toContain("Still connecting to Jarvis");
    expect(read("src/components/operator/voice-companion.tsx")).toContain("acceptJarvisRequest((event as CustomEvent).detail);");
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
    expect(vc).toContain("useEffect(() => onDrivingStop(() => typedQueue.current.clear()), []);");
    expect(vc).toContain("if (TYPED_STOP.test(utterance)) typedQueue.current.clear();");
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
    expect(vc).not.toMatch(/typedTurn\(current, request\)\.catch\(\(\) => null\)/);
    expect(vc).toContain("turnWithRetry(() => voicePost(\"/voice/free/turn\"");
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
    expect(vc).toContain("if (taken) acceptJarvisRequest((event as CustomEvent).detail);");
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
    expect(vc).toContain("eventId: commandEventId(requestId, commands++)");
    expect(vc).toContain("reply = await typedTurn(current, request, requestId)");
  });

  test("the typed request and its reply (plain answers too) go to /screen/command/thread/say", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain('voicePost("/screen/command/thread/say"');
    expect(vc).toContain('sayToThread(requestId, "user", "user", request)');
    expect(vc).toContain('sayToThread(requestId, "reply", "assistant", reply)');
  });
});

describe("round 11 staging: a turn that can't run on this hub goes to the command path, never a different kind of answer", () => {
  test("a non-transient turn error runs the typed request through runJarvisCommand with the same request id; a transient one says it failed", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain('const out = await jarvisCommand({ utterance: request, typed: true, eventId: commandEventId(requestId, 0) }, fallback.signal);');
    expect(vc).toContain("if (e instanceof TurnFailed || (e as Error)?.name === \"AbortError\") return e instanceof TurnFailed ? e.message : \"Stopped.\";");
  });
});

describe("final review B2: a Stop from the panel or Escape reaches the typed request's hub call", () => {
  test("the typed turn's controller lives in a ref that stop() aborts; the fallback runs through the command tool with that signal", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    const stopBody = vc.slice(vc.indexOf("  function stop() {"), vc.indexOf("  function stop() {") + 600);
    expect(stopBody).toContain("typedTurnAbort.current?.abort();");
    const turnBody = vc.slice(vc.indexOf("async function typedTurn("), vc.indexOf("async function typedTurn(") + 400);
    expect(turnBody).toContain("typedTurnAbort.current = controller;");
    expect(vc).toContain("typedTurnAbort.current = fallback;");
    // No typed-request command call without a signal any more.
    expect(vc).not.toContain('runJarvisCommand({ utterance: request, source: "typed"');
  });
});
