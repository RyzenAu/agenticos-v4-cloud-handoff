import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DUPLICATE_WINDOW_MS,
  ENDPOINTING,
  FALSE_INTERRUPTION_MS,
  INTERRUPT_CONFIRM_MS,
  answerStopQuestion,
  classifyStop,
  createDuplicateGuard,
  createMicReconnector,
  endpointHoldMs,
  remainingHoldMs,
  type MicStatus,
} from "../src/lib/voice-turns";
import { createVad } from "../src/lib/free-voice-client";

describe("adaptive endpointing", () => {
  test("a complete command gets no extra wait", () => {
    for (const t of ["Open a new Chrome tab.", "What's the weather in Sydney?", "Turn the lights on.", "Yes.", "Do you think so?", "It's ready."])
      expect(endpointHoldMs(t)).toBe(0);
  });
  test("a trailing filler, connector, comma or ellipsis waits for the rest", () => {
    expect(endpointHoldMs("Open a new Chrome tab and")).toBe(ENDPOINTING.fillerHoldMs);
    expect(endpointHoldMs("Open YouTube, and then")).toBe(ENDPOINTING.fillerHoldMs);
    expect(endpointHoldMs("Um")).toBe(ENDPOINTING.fillerHoldMs);
    expect(endpointHoldMs("Let me think, uh.")).toBe(ENDPOINTING.fillerHoldMs);
    expect(endpointHoldMs("Open a new Chrome tab,")).toBe(ENDPOINTING.commaHoldMs);
    expect(endpointHoldMs("Go to YouTube...")).toBe(ENDPOINTING.ellipsisHoldMs);
    expect(endpointHoldMs("Go to YouTube…")).toBe(ENDPOINTING.ellipsisHoldMs);
  });
  test("a dangling preposition or article waits only when nothing ended the sentence", () => {
    expect(endpointHoldMs("Search for")).toBe(ENDPOINTING.danglingHoldMs);
    expect(endpointHoldMs("Go to the")).toBe(ENDPOINTING.danglingHoldMs);
    expect(endpointHoldMs("Turn the lights on")).toBe(ENDPOINTING.danglingHoldMs);
    expect(endpointHoldMs("Turn the lights on.")).toBe(0);
    expect(endpointHoldMs("What is that?")).toBe(0);
  });
  test("the wait never passes the hard cap measured from the end of speech", () => {
    expect(remainingHoldMs("Um", 0)).toBe(ENDPOINTING.fillerHoldMs);
    expect(remainingHoldMs("Um", 1500)).toBe(ENDPOINTING.maxTotalMs - 1500);
    expect(remainingHoldMs("Um", ENDPOINTING.maxTotalMs + 400)).toBe(0);
    expect(remainingHoldMs("Open a tab.", 0)).toBe(0);
  });
  test("a genuine end answers faster than before: the VAD default is 650 ms, not 800", () => {
    expect(ENDPOINTING.minSilenceMs).toBe(650);
    expect(createVad().config.silenceMs).toBe(650);
  });
  test("an overall budget: silence plus the longest hold stays inside the maximum endpointing delay", () => {
    const longest = Math.max(ENDPOINTING.fillerHoldMs, ENDPOINTING.danglingHoldMs, ENDPOINTING.ellipsisHoldMs, ENDPOINTING.commaHoldMs);
    expect(ENDPOINTING.minSilenceMs + longest).toBeLessThanOrEqual(ENDPOINTING.maxTotalMs + ENDPOINTING.minSilenceMs);
    expect(ENDPOINTING.maxTotalMs).toBeLessThanOrEqual(3000);
  });
});

describe("interruption bounds", () => {
  test("barge-in start (250 ms) plus confirmation (500 ms) cancels within 0.8 s; a cough-length burst never does", () => {
    const vad = createVad();
    // Over Jarvis: loud and sustained starts the pause at 250 ms.
    let events: string[] = [];
    for (let ms = 0; ms < 300; ms += 50) events.push(vad.push(0.2, 50, true));
    expect(events.indexOf("start")).toBe(4); // 250 ms
    expect(INTERRUPT_CONFIRM_MS).toBe(500);
    expect(250 + INTERRUPT_CONFIRM_MS).toBeLessThan(800);
    // A 200 ms cough over him is below the barge-in duration: nothing starts.
    const cough = createVad();
    const coughEvents: string[] = [];
    for (let ms = 0; ms < 200; ms += 50) coughEvents.push(cough.push(0.2, 50, true));
    for (let ms = 0; ms < 1000; ms += 50) coughEvents.push(cough.push(0.001, 50, true));
    expect(coughEvents.every((e) => e === "idle")).toBe(true);
  });
  test("the false-interruption window is 2 s (our choice; LiveKit documents the knob, not a number)", () => {
    expect(FALSE_INTERRUPTION_MS).toBe(2000);
  });
});

describe("stop disambiguation", () => {
  const speaking = { speaking: true, taskRunning: false };
  const both = { speaking: true, taskRunning: true };
  const job = { speaking: false, taskRunning: true };
  const idle = { speaking: false, taskRunning: false };
  test("'stop', 'quiet', 'shut up' while he speaks stop the speech only", () => {
    for (const t of ["Stop.", "stop", "Quiet", "Shut up!", "be quiet", "Jarvis, stop", "That's enough."]) expect(classifyStop(t, speaking)).toEqual({ kind: "stop-speech" });
  });
  test("'quiet' and 'shut up' are about his voice even when a task runs", () => {
    for (const t of ["Quiet.", "Shut up.", "Shush"]) expect(classifyStop(t, both)).toEqual({ kind: "stop-speech" });
  });
  test("'stop that task', 'cancel the job' and a bare 'stop' cancel the task while he is silent", () => {
    for (const t of ["Stop that task.", "Cancel the job.", "stop the task", "Abort the task", "Stop.", "Cancel that", "never mind"]) expect(classifyStop(t, job)).toEqual({ kind: "stop-task" });
  });
  test("a task-specific phrase cancels the task even while he speaks", () => {
    expect(classifyStop("Stop that task", both)).toEqual({ kind: "stop-task" });
  });
  test("a bare 'stop' with both speech and a task is ambiguous", () => {
    for (const t of ["Stop", "Stop it.", "Cancel that", "Stop please"]) expect(classifyStop(t, both)).toEqual({ kind: "ambiguous" });
  });
  test("nothing to stop: a bare stop does nothing; a task phrase says nothing is running", () => {
    expect(classifyStop("Stop.", idle)).toEqual({ kind: "nothing" });
    expect(classifyStop("Stop that task.", idle)).toEqual({ kind: "no-task" });
  });
  test("a real command that merely starts with a stop word is not a stop", () => {
    for (const t of ["Stop the timer in ten minutes", "Cancel my meeting with Mehroz", "Stop by the shop", "Wait for the build to finish and tell me", ""]) expect(classifyStop(t, both)).toEqual({ kind: "none" });
  });
  test("the answer to 'Stop the task too?'", () => {
    for (const t of ["Yes", "yeah.", "Stop it", "yes please", "Cancel it"]) expect(answerStopQuestion(t)).toBe("yes");
    for (const t of ["No", "nope.", "Carry on", "keep going", "Leave it"]) expect(answerStopQuestion(t)).toBe("no");
    for (const t of ["What's the weather", "Open YouTube", ""]) expect(answerStopQuestion(t)).toBeNull();
  });
});

describe("duplicate-submission guard", () => {
  test("the same words inside the window are one command; after it they are new", () => {
    let now = 1_000;
    const guard = createDuplicateGuard(DUPLICATE_WINDOW_MS, () => now);
    expect(guard.accept("Open the operations page.")).toBe(true);
    now += 2000;
    expect(guard.accept("open the operations page")).toBe(false); // case and punctuation don't matter
    expect(guard.accept("Open the finance page")).toBe(true);
    now += DUPLICATE_WINDOW_MS + 1;
    expect(guard.accept("Open the operations page.")).toBe(true);
  });
  test("answers and single words are never duplicates; a failed turn is forgotten", () => {
    let now = 0;
    const guard = createDuplicateGuard(5000, () => now);
    for (const word of ["yes", "Yes.", "next", "Go ahead"]) {
      expect(guard.accept(word)).toBe(true);
      expect(guard.accept(word)).toBe(true);
    }
    expect(guard.accept("Check my calendar")).toBe(true);
    guard.forget("check my calendar.");
    expect(guard.accept("Check my calendar")).toBe(true);
  });
  test("its window mirrors the command service's own 5 s dedupe, which stays the authority for commands", () => {
    expect(DUPLICATE_WINDOW_MS).toBe(5000);
    const service = readFileSync(join(import.meta.dir, "jarvis-command", "service.ts"), "utf8");
    expect(service).toContain("deps.dedupeMs ?? 5_000");
    expect(service).toContain("const dedupeKey =");
    // Proved end to end in scripts/jarvis-command/context-device.test.ts ("the same words ... attach to one job and dispatch once").
  });
});

describe("mic reconnector", () => {
  const harness = (acquire: () => Promise<string>, delays = [0, 10, 20], closed = () => false) => {
    const statuses: MicStatus[] = [];
    const streams: string[] = [];
    const waits: number[] = [];
    const mic = createMicReconnector<string>({ acquire, onStream: (s) => streams.push(s), onStatus: (s) => statuses.push(s), isClosed: closed, delays, wait: async (ms) => void waits.push(ms) });
    return { mic, statuses, streams, waits };
  };
  test("re-acquires on the first try", async () => {
    const h = harness(async () => "new-stream");
    expect(await h.mic.lost()).toBe(true);
    expect(h.streams).toEqual(["new-stream"]);
    expect(h.statuses).toEqual(["lost", "reconnecting", "restored"]);
  });
  test("backs off between tries and succeeds when the device returns", async () => {
    let n = 0;
    const h = harness(async () => { if (++n < 3) throw new DOMException("gone", "NotFoundError"); return "back"; });
    expect(await h.mic.lost()).toBe(true);
    expect(h.waits).toEqual([10, 20]);
    expect(h.streams).toEqual(["back"]);
  });
  test("is single-flight, bounded and reports failure once", async () => {
    let n = 0;
    const h = harness(async () => { n++; throw new DOMException("gone", "NotFoundError"); });
    const [a, b] = [h.mic.lost(), h.mic.lost()];
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(n).toBe(3);
    expect(h.statuses.filter((s) => s === "failed")).toHaveLength(1);
  });
  test("a permission denial stops retrying straight away", async () => {
    let n = 0;
    const h = harness(async () => { n++; throw new DOMException("no", "NotAllowedError"); });
    expect(await h.mic.lost()).toBe(false);
    expect(n).toBe(1);
  });
  test("a closed session does not reconnect", async () => {
    let n = 0;
    const h = harness(async () => { n++; return "x"; }, [0], () => true);
    expect(await h.mic.lost()).toBe(false);
    expect(n).toBe(0);
  });
});
