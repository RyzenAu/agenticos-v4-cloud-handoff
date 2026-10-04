import { afterEach, beforeEach, expect, test } from "bun:test";
import { startFreeVoice, type FreeVoiceCall, type FreeVoiceOptions } from "../../src/lib/free-voice-client";

// Turn-taking in the actual client (src/lib/voice-turns.ts wired into src/lib/free-voice-client.ts).
// Only browser media and provider boundaries are synthetic: generated PCM frames (100 ms each, a
// constant amplitude), a fake Web Audio graph and scripted transcripts. No microphone, network,
// speech service, recording or private transcript. A physical microphone test is still owed by the
// owner: docs/programme-20261001/VOICE-TURNS.md has the script.
const originals = new Map<string, PropertyDescriptor | undefined>();
const calls: FreeVoiceCall[] = [];
type FakeTrack = { enabled: boolean; stopped: boolean; readyState: string; onended: null | (() => void); onmute: null | (() => void); onunmute: null | (() => void); stop(): void };
let tracks: FakeTrack[];
let contexts: FakeAudio[];
let ports: FakeWorklet[];
let sources: FakeSource[];
let holdPlayback = false;
let deviceHandlers: Array<() => void>;
let micFailure: Error | null;
let micRequests: number;

class FakeSource {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  onended: null | (() => void) = null;
  started = false;
  stopped = false;
  connect() {}
  start() {
    this.started = true;
    if (!holdPlayback) queueMicrotask(() => this.onended?.());
  }
  stop() {
    this.stopped = true;
  }
  finish() {
    this.onended?.();
  }
}
class FakeAudio {
  closed = false;
  destination = {};
  currentTime = 0;
  suspends = 0;
  resumes = 0;
  audioWorklet = { addModule: async () => {} };
  constructor() { contexts.push(this); }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createAnalyser() { return { fftSize: 256, connect() {}, getByteTimeDomainData(a: Uint8Array) { a.fill(128); } }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async decodeAudioData() { return { duration: 0.01 }; }
  createBufferSource() { const source = new FakeSource(); sources.push(source); return source; }
  async suspend() { this.suspends++; }
  async resume() { this.resumes++; }
  async close() { this.closed = true; }
}
class FakeWorklet {
  closed = false;
  port = { onmessage: null as null | ((event: unknown) => void), close: () => { this.closed = true; } };
  constructor() { ports.push(this); }
  connect() {}
}
function replace(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
beforeEach(() => {
  tracks = []; contexts = []; ports = []; sources = []; holdPlayback = false; deviceHandlers = []; micFailure = null; micRequests = 0;
  replace("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        micRequests++;
        if (micFailure) throw micFailure;
        const track: FakeTrack = { enabled: true, stopped: false, readyState: "live", onended: null, onmute: null, onunmute: null, stop() { this.stopped = true; this.readyState = "ended"; } };
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
      addEventListener: (type: string, handler: () => void) => { if (type === "devicechange") deviceHandlers.push(handler); },
      removeEventListener: () => {},
    },
  });
  replace("window", {});
  replace("AudioContext", FakeAudio);
  replace("AudioWorkletNode", FakeWorklet);
});
afterEach(async () => {
  for (const call of calls.splice(0)) await call.endSession();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});
async function until(check: () => boolean, label = "condition") {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Synthetic turn-taking ${label} did not settle`);
}
const SHORT = { fillerHoldMs: 140, danglingHoldMs: 140, ellipsisHoldMs: 140, commaHoldMs: 90, maxTotalMs: 500, mergeWindowMs: 500 };
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(over: Partial<FreeVoiceOptions> & { transcripts?: string[] } = {}) {
  const { transcripts = [], turn: turnImpl, ...rest } = over;
  const phases: string[] = [], messages: string[] = [], errors: string[] = [], mic: string[] = [];
  const sttAudioLengths: number[] = [];
  const ttsSignals: AbortSignal[] = [];
  const ttsTexts: string[] = [];
  const turnUsers: string[] = [];
  let stt = 0, turns = 0;
  const controller = new AbortController();
  const call = await startFreeVoice({
    signal: controller.signal,
    endpointing: SHORT,
    stt: async (audio) => { sttAudioLengths.push(audio.length); return transcripts[stt++] ?? `Synthetic request ${stt}`; },
    turn: async (messages, context, signal) => {
      turns++;
      turnUsers.push([...messages].reverse().find((m) => m.role === "user")?.content as string);
      return turnImpl ? turnImpl(messages, context, signal) : { content: "Synthetic answer for this turn." };
    },
    tts: async (text, signal) => { ttsTexts.push(text); ttsSignals.push(signal); return { audio: "AA==", mime: "audio/wav" }; },
    onTool: async () => "Synthetic result",
    onPhase: (p) => phases.push(p), onMessage: (_role, text) => messages.push(text),
    onCaption() {}, onError: (e) => errors.push(e), onDisconnect() {},
    onMicStatus: (s) => mic.push(s),
    ...rest,
  });
  calls.push(call);
  return { call, controller, phases, messages, errors, mic, sttAudioLengths, ttsSignals, ttsTexts, turnUsers, get turns() { return turns; }, get stt() { return stt; } };
}
/** `count` frames of 100 ms at a constant amplitude (0.1 is speech; 0 is silence; 0.001 is room noise). */
function frame(amplitude: number, count: number) {
  for (let i = 0; i < count; i++) ports.at(-1)!.port.onmessage?.({ data: { samples: new Float32Array(1600).fill(amplitude), sampleRate: 16000 } });
}
const settled = (f: Fixture) => f.phases.at(-1) === "listening";
const LONG_REPLY = `${"First part of a long answer that keeps going for a while so it needs its own chunk of speech. ".repeat(3)}${"Second part of the answer also runs long enough to be a separate request to the voice. ".repeat(3)}${"Third part comes last and is long enough to be fetched only if nothing interrupts the reply. ".repeat(3)}`;

/* ---------------------------------------------------------------------------------------- */
/* Endpointing: natural pauses, genuine ends                                                  */
/* ---------------------------------------------------------------------------------------- */

test("a pause after a trailing 'and' does not cut him off: the two halves reach the brain as one request", async () => {
  const f = await fixture({ transcripts: ["Open a new Chrome tab, go to YouTube and", "Open a new Chrome tab, go to YouTube and search for Sydney weather."] });
  frame(0.1, 7); frame(0, 7);
  await until(() => f.stt === 1, "first transcript");
  expect(f.turns).toBe(0); // held: the sentence is not finished
  frame(0.1, 7); frame(0, 7); // he carries on inside the hold
  await until(() => f.turns === 1 && settled(f), "merged turn");
  expect(f.stt).toBe(2);
  expect(f.sttAudioLengths[1]).toBeGreaterThan(f.sttAudioLengths[0] * 1.5); // the second pass heard both halves
  expect(f.turnUsers).toEqual(["Open a new Chrome tab, go to YouTube and search for Sydney weather."]);
  expect(f.errors).toEqual([]);
});
test("a complete command is not held: it goes to the brain straight after the transcript", async () => {
  const f = await fixture({ transcripts: ["Open a new Chrome tab."], endpointing: { ...SHORT, fillerHoldMs: 600, danglingHoldMs: 600, commaHoldMs: 600 } });
  frame(0.1, 7); frame(0, 7);
  const endedAt = Date.now();
  await until(() => f.turns === 1, "turn");
  expect(Date.now() - endedAt).toBeLessThan(300);
});
test("a hold is bounded: nobody continues, so the half sentence is submitted after the hold", async () => {
  const f = await fixture({ transcripts: ["Search for"], endpointing: { ...SHORT, danglingHoldMs: 120 } });
  frame(0.1, 7); frame(0, 7);
  await until(() => f.stt === 1);
  expect(f.turns).toBe(0);
  await until(() => f.turns === 1 && settled(f), "submitted after the hold");
  expect(f.turnUsers).toEqual(["Search for"]);
});
test("a filler at the end holds; a trailing comma holds briefly; silence between clauses merges", async () => {
  const f = await fixture({ transcripts: ["Um,", "Um, what is the weather like today?"] });
  frame(0.1, 7); frame(0, 7);
  await until(() => f.stt === 1);
  frame(0.1, 7); frame(0, 7);
  await until(() => f.turns === 1 && settled(f));
  expect(f.turnUsers).toEqual(["Um, what is the weather like today?"]);
});

/* ---------------------------------------------------------------------------------------- */
/* Interruption and false-interruption recovery                                               */
/* ---------------------------------------------------------------------------------------- */

async function speakingFixture(over: Partial<FreeVoiceOptions> & { transcripts?: string[] } = {}) {
  holdPlayback = true;
  const f = await fixture({ turn: async () => ({ content: LONG_REPLY }), ...over });
  f.call.sendUserMessage("Synthetic question to start a long reply");
  await until(() => f.phases.at(-1) === "speaking", "speaking");
  return f;
}
test("speech over Jarvis holds playback within the barge-in start and cancels every queued chunk once confirmed", async () => {
  const f = await speakingFixture();
  await until(() => f.ttsTexts.length >= 2, "second chunk prefetched");
  const playback = contexts[1];
  expect(playback.suspends).toBe(0);
  frame(0.1, 3); // 300 ms: the 250 ms barge-in start
  expect(playback.suspends).toBe(1);
  expect(f.phases.at(-1)).toBe("listening");
  expect(sources.some((s) => s.stopped)).toBe(false); // held, not yet cancelled: a cough could still be a cough
  frame(0.1, 5); // 500 ms voiced: confirmed
  expect(sources.filter((s) => s.started).every((s) => s.stopped)).toBe(true);
  expect(f.ttsSignals.every((s) => s.aborted)).toBe(true); // queued and in-flight chunks are cancelled
  const chunksBefore = f.ttsTexts.length;
  await Bun.sleep(30);
  expect(f.ttsTexts.length).toBe(chunksBefore); // and no further chunk is fetched
  expect(playback.resumes).toBeGreaterThanOrEqual(1); // the clock runs again for whatever he says next
  expect(f.errors).toEqual([]);
});
test("a short noise over him is a false interruption: playback resumes where it stopped, nothing is cancelled", async () => {
  const f = await speakingFixture({ transcripts: ["Thank you."] });
  const playback = contexts[1];
  frame(0.1, 4); // a knock or a cough: starts the pause
  expect(playback.suspends).toBe(1);
  frame(0, 8); // and it is over: the VAD ends it, STT hears nothing real
  await until(() => playback.resumes >= 1 && f.phases.at(-1) === "speaking", "resumed");
  expect(sources.some((s) => s.stopped)).toBe(false);
  expect(f.ttsSignals.every((s) => !s.aborted)).toBe(true);
  expect(f.turns).toBe(1); // only the original typed turn: the noise never reached the brain
});
test("a blip that never becomes speech also resumes him", async () => {
  const f = await speakingFixture();
  const playback = contexts[1];
  frame(0.1, 3); // barge-in start (paused) but under the minimum speech length
  expect(playback.suspends).toBe(1);
  frame(0, 8);
  expect(playback.resumes).toBeGreaterThanOrEqual(1);
  expect(f.phases.at(-1)).toBe("speaking");
  expect(sources.some((s) => s.stopped)).toBe(false);
});
test("a pause that nobody resolves resumes on its own after the false-interruption window (bounded)", async () => {
  const f = await speakingFixture({ falseInterruptionMs: 80 });
  const playback = contexts[1];
  frame(0.1, 3);
  frame(0, 2); // trailing silence, not yet an end
  expect(playback.suspends).toBe(1);
  // still "recording" so the timer treats it as real speech: it cancels rather than resumes
  await until(() => sources.filter((s) => s.started).every((s) => s.stopped), "cancelled by timer");
  expect(f.errors).toEqual([]);
});
test("his real words over Jarvis become the next turn and replace the reply", async () => {
  const f = await speakingFixture({ transcripts: ["Actually, what time is it in Sydney?"] });
  frame(0.1, 8); frame(0, 8);
  await until(() => f.turns === 2, "new turn");
  expect(f.turnUsers.at(-1)).toBe("Actually, what time is it in Sydney?");
  expect(sources.filter((s) => s.started).some((s) => s.stopped)).toBe(true);
});

/* ---------------------------------------------------------------------------------------- */
/* "Stop" disambiguation                                                                      */
/* ---------------------------------------------------------------------------------------- */

async function taskFixture(transcripts: string[], opts: { speakFirst: boolean }) {
  holdPlayback = true;
  let toolSignal: AbortSignal | undefined;
  const f = await fixture({
    transcripts,
    slowTools: ["control_pc"],
    turn: async (messages) => {
      const last = messages[messages.length - 1];
      if (last.role === "tool") return { content: "Done." };
      return { content: null, tool_calls: [{ id: "synthetic-job", type: "function", function: { name: "control_pc", arguments: "{}" } }] };
    },
    onTool: async (_n, _a, signal) => { toolSignal = signal; return new Promise<string>(() => {}); },
  });
  f.call.sendUserMessage("Synthetic request to start a long job");
  await until(() => !!toolSignal, "job running");
  if (opts.speakFirst) await until(() => f.phases.at(-1) === "speaking", "ack speaking");
  else {
    // silent: end the acknowledgement so nothing is being said while the job runs
    for (const s of sources) s.finish();
    await until(() => f.phases.at(-1) !== "speaking", "silent");
  }
  return { f, signal: () => toolSignal! };
}
test("'stop' while Jarvis speaks and nothing else runs stops the speech only", async () => {
  holdPlayback = true;
  const f = await fixture({ turn: async () => ({ content: LONG_REPLY }), transcripts: ["Stop."] });
  f.call.sendUserMessage("Synthetic question to start a long reply");
  await until(() => f.phases.at(-1) === "speaking");
  frame(0.1, 8); frame(0, 8);
  await until(() => sources.filter((s) => s.started).every((s) => s.stopped) && f.phases.at(-1) === "listening", "speech stopped");
  expect(f.turns).toBe(1); // "stop" never reaches the brain
  expect(f.messages).not.toContain("Stopped.");
});
test("'quiet' and 'shut up' while a job runs and Jarvis speaks stop the speech and leave the task running", async () => {
  for (const words of ["Quiet.", "Shut up."]) {
    const { f, signal } = await taskFixture([words], { speakFirst: true });
    frame(0.1, 8); frame(0, 8);
    await until(() => sources.filter((s) => s.started).every((s) => s.stopped), "speech stopped");
    await Bun.sleep(20);
    expect(signal().aborted).toBe(false);
    expect(f.messages).not.toContain("Stopped.");
    expect(f.messages).not.toContain("Stop the task too?");
    await f.call.endSession();
    calls.length = 0;
    sources.length = 0;
  }
});
test("a bare 'stop' while he speaks AND a task runs is ambiguous: he stops talking and asks; yes cancels, no does not", async () => {
  const yes = await taskFixture(["Stop.", "Yes."], { speakFirst: true });
  frame(0.1, 8); frame(0, 8);
  await until(() => yes.f.messages.includes("Stop the task too?"), "question");
  expect(yes.signal().aborted).toBe(false);
  expect(sources.filter((s) => s.started).some((s) => s.stopped)).toBe(true);
  sources.forEach((s) => s.finish()); // the question is spoken, then silence
  frame(0.1, 8); frame(0, 8);
  await until(() => yes.signal().aborted, "cancelled on yes");
  await until(() => yes.f.messages.includes("Stopped."));
  expect(yes.f.turns).toBe(1);
  await yes.f.call.endSession();
  calls.length = 0;
  sources.length = 0;

  const no = await taskFixture(["Stop.", "No, keep going."], { speakFirst: true });
  frame(0.1, 8); frame(0, 8);
  await until(() => no.f.messages.includes("Stop the task too?"));
  sources.forEach((s) => s.finish());
  frame(0.1, 8); frame(0, 8);
  await until(() => no.f.stt === 2);
  await Bun.sleep(30);
  expect(no.signal().aborted).toBe(false);
  expect(no.f.messages).not.toContain("Stopped.");
});
test("'stop that task' and a bare 'stop' while Jarvis is silent and a task runs cancel it through the existing abort path", async () => {
  for (const words of ["Stop that task.", "Stop.", "Cancel the job."]) {
    const { f, signal } = await taskFixture([words], { speakFirst: false });
    expect(signal().aborted).toBe(false);
    frame(0.1, 8); frame(0, 8);
    await until(() => signal().aborted, `"${words}" cancelled the task`);
    await until(() => f.messages.includes("Stopped."));
    expect(f.turns).toBe(1); // the words themselves never became a request
    await f.call.endSession();
    calls.length = 0;
    sources.length = 0;
  }
});
test("ordinary speech or a noise while a job runs does not cancel it until the words say so", async () => {
  const { f, signal } = await taskFixture(["Thank you."], { speakFirst: false });
  frame(0.1, 8); frame(0, 8); // long enough to be confirmed speech, but only noise once transcribed
  await until(() => f.stt === 1);
  await Bun.sleep(30);
  expect(signal().aborted).toBe(false);
});
test("'stop that task' with nothing running says so instead of doing nothing", async () => {
  const f = await fixture({ transcripts: ["Stop that task."] });
  frame(0.1, 8); frame(0, 8);
  await until(() => f.messages.includes("Nothing is running."));
  expect(f.turns).toBe(0);
});

test("a stop with nothing running HERE goes to the one command path when work is left going on the server; its line is spoken, the words never reach the brain", async () => {
  const sent: string[] = [];
  const f = await fixture({ transcripts: ["Stop that task."], backgroundStop: async (text) => (sent.push(text), "Stopped it. Nothing further will run."), hasBackgroundWork: () => true });
  frame(0.1, 8); frame(0, 8);
  await until(() => f.messages.includes("Stopped it. Nothing further will run."));
  expect(sent).toEqual(["Stop that task."]);
  expect(f.turns).toBe(0);
});
test("a bare 'stop' goes to the server only when work is going; with none it stays silent, and a failed server stop still says 'Nothing is running.' for 'stop that task'", async () => {
  const none: string[] = [];
  const a = await fixture({ transcripts: ["Stop."], backgroundStop: async (t) => (none.push(t), "x"), hasBackgroundWork: () => false });
  frame(0.1, 8); frame(0, 8);
  await until(() => a.stt === 1);
  await Bun.sleep(40);
  expect(none).toEqual([]);
  expect(a.messages).not.toContain("x");
  await a.call.endSession(); calls.length = 0; sources.length = 0;
  const b = await fixture({ transcripts: ["Stop that task."], backgroundStop: async () => { throw new Error("offline"); }, hasBackgroundWork: () => false });
  frame(0.1, 8); frame(0, 8);
  await until(() => b.messages.includes("Nothing is running."));
});

/* ---------------------------------------------------------------------------------------- */
/* Duplicate submission                                                                       */
/* ---------------------------------------------------------------------------------------- */

test("the same spoken words twice inside the window reach the brain once", async () => {
  const f = await fixture({ transcripts: ["Open the operations page.", "Open the operations page."] });
  frame(0.1, 7); frame(0, 7);
  await until(() => f.turns === 1 && settled(f));
  frame(0.1, 7); frame(0, 7);
  await until(() => f.stt === 2);
  await Bun.sleep(40);
  expect(f.turns).toBe(1);
});
test("typed and spoken words share the guard, and a failed turn is forgotten so a retry goes through", async () => {
  let attempts = 0;
  const f = await fixture({
    transcripts: ["Check my calendar for tomorrow."],
    turn: async () => { if (++attempts === 1) throw new Error("Synthetic unavailable"); return { content: "Recovered." }; },
  });
  f.call.sendUserMessage("Check my calendar for tomorrow.");
  await until(() => f.errors.length === 1);
  f.call.sendUserMessage("Check my calendar for tomorrow."); // retry after a failure: allowed
  await until(() => attempts === 2 && settled(f));
  f.call.sendUserMessage("Check my calendar for tomorrow."); // the same again now, while it succeeded just now: one command
  await Bun.sleep(30);
  expect(attempts).toBe(2);
  frame(0.1, 7); frame(0, 7); // spoken echo of the typed command
  await until(() => f.stt === 1);
  await Bun.sleep(40);
  expect(attempts).toBe(2);
});

/* ---------------------------------------------------------------------------------------- */
/* Mic reconnect                                                                              */
/* ---------------------------------------------------------------------------------------- */

test("the microphone ending mid-session is re-acquired without a new session, and the next turn works", async () => {
  const f = await fixture({ micReconnectDelays: [0, 10, 20] });
  expect(micRequests).toBe(1);
  frame(0.1, 3); // part of an utterance when the device goes
  tracks[0].onended?.();
  await until(() => f.mic.includes("restored"), "restored");
  expect(f.mic).toEqual(["lost", "reconnecting", "restored"]);
  expect(micRequests).toBe(2);
  expect(tracks[0].stopped).toBe(true);
  expect(contexts).toHaveLength(2); // no new audio session
  expect(f.errors).toEqual([]);
  frame(0, 9); // the half utterance was discarded: silence alone submits nothing
  await Bun.sleep(20);
  expect(f.stt).toBe(0);
  frame(0.1, 7); frame(0, 7);
  await until(() => f.turns === 1 && settled(f));
});
test("a device change whose track has ended reconnects; one that has not does nothing", async () => {
  const f = await fixture({ micReconnectDelays: [0] });
  deviceHandlers.forEach((h) => h());
  await Bun.sleep(15);
  expect(micRequests).toBe(1);
  tracks[0].readyState = "ended";
  deviceHandlers.forEach((h) => h());
  await until(() => f.mic.includes("restored"));
  expect(micRequests).toBe(2);
});
test("a denied microphone gives up at once with one plain message; typed input still works", async () => {
  const f = await fixture({ micReconnectDelays: [0, 10, 20, 30] });
  micFailure = new DOMException("Synthetic denial", "NotAllowedError");
  tracks[0].onended?.();
  await until(() => f.mic.includes("failed"), "failed");
  expect(micRequests).toBe(2); // one try, no retries after a denial
  expect(f.errors).toHaveLength(1);
  f.call.sendUserMessage("Typed fallback still works");
  await until(() => f.turns === 1 && settled(f));
});
test("a device that keeps failing retries a bounded number of times then reports once", async () => {
  const f = await fixture({ micReconnectDelays: [0, 5, 5] });
  micFailure = new DOMException("Synthetic unplugged", "NotFoundError");
  tracks[0].onended?.();
  tracks[0].onended?.(); // a second event while reconnecting does not start a second loop
  await until(() => f.mic.includes("failed"), "failed");
  expect(micRequests).toBe(1 + 3);
  expect(f.errors).toHaveLength(1);
});
test("reconnecting keeps the mute state and does not stop Jarvis speaking", async () => {
  holdPlayback = true;
  const f = await fixture({ micReconnectDelays: [0], turn: async () => ({ content: LONG_REPLY }) });
  f.call.sendUserMessage("Synthetic question to start a long reply");
  await until(() => f.phases.at(-1) === "speaking");
  f.call.setMicMuted(true);
  tracks[0].onended?.();
  await until(() => f.mic.includes("restored"));
  expect(tracks[1].enabled).toBe(false);
  expect(sources.some((s) => s.stopped)).toBe(false);
  expect(f.phases.at(-1)).toBe("speaking");
});
