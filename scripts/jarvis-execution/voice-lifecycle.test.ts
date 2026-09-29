import { afterEach, beforeEach, expect, test } from "bun:test";
import { startFreeVoice, PARTIAL_STABLE_MS, type FreeVoiceCall, type FreeVoiceOptions } from "../../src/lib/free-voice-client";

// Actual client orchestration; only browser media and provider boundaries are synthetic.
// No microphones, network, speech services, browser storage or real transcripts.
const originals = new Map<string, PropertyDescriptor | undefined>();
const calls: FreeVoiceCall[] = [];
let tracks: Array<{ enabled: boolean; stopped: boolean; stop(): void }>;
let contexts: FakeAudio[];
let ports: FakeWorklet[];
class FakeAudio {
  closed = false;
  destination = {};
  currentTime = 0;
  audioWorklet = { addModule: async () => {} };
  constructor() { contexts.push(this); }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createAnalyser() { return { fftSize: 256, connect() {}, getByteTimeDomainData(a: Uint8Array) { a.fill(128); } }; }
  createMediaStreamSource() { return { connect() {} }; }
  async decodeAudioData() { return { duration: 0.01 }; }
  createBufferSource() {
    const source = { buffer: null, onended: null as null | (() => void), connect() {}, start() { queueMicrotask(() => source.onended?.()); }, stop() {} };
    return source;
  }
  async resume() {}
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
  tracks = []; contexts = []; ports = [];
  replace("navigator", { mediaDevices: { getUserMedia: async () => {
    const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } });
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
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Synthetic lifecycle condition did not settle");
}
async function fixture(over: Partial<FreeVoiceOptions> = {}) {
  const phases: string[] = [], messages: string[] = [], errors: string[] = [];
  let disconnects = 0, turns = 0, stt = 0;
  const controller = new AbortController();
  const call = await startFreeVoice({
    signal: controller.signal,
    stt: async () => { stt++; return "Synthetic request"; },
    turn: async () => { turns++; return { content: "Synthetic answer for this turn." }; },
    tts: async () => ({ audio: "AA==", mime: "audio/wav" }),
    onTool: async () => "Synthetic result",
    onPhase: (p) => phases.push(p), onMessage: (_role, text) => messages.push(text),
    onCaption() {}, onError: (e) => errors.push(e), onDisconnect: () => { disconnects++; },
    ...over,
  });
  calls.push(call);
  return { call, controller, phases, messages, errors, get turns() { return turns; }, get stt() { return stt; }, get disconnects() { return disconnects; } };
}
function frame(amplitude: number, count: number) {
  for (let i = 0; i < count; i++) ports.at(-1)!.port.onmessage?.({ data: { samples: new Float32Array(1600).fill(amplitude), sampleRate: 16000 } });
}

test("actual client accepts two synthetic PCM turns and relistens after each playback", async () => {
  const f = await fixture();
  for (let i = 1; i <= 2; i++) {
    frame(0.1, 7); frame(0, 9);
    await until(() => f.turns === i && f.phases.at(-1) === "listening");
  }
  expect(f.stt).toBe(2);
  expect(f.messages.filter((t) => t === "Synthetic answer for this turn.")).toHaveLength(2);
  expect(f.errors).toEqual([]);
});
test("interruption aborts the actual tool signal and suppresses late completion", async () => {
  let release!: (text: string) => void;
  let signal: AbortSignal | undefined;
  const f = await fixture({
    turn: async () => ({ content: null, tool_calls: [{ id: "synthetic-tool", type: "function", function: { name: "navigate", arguments: "{}" } }] }),
    onTool: async (_n, _a, s) => { signal = s; return new Promise((r) => { release = r; }); },
  });
  f.call.sendUserMessage("Synthetic navigation");
  await until(() => !!signal);
  f.call.sendUserActivity();
  expect(signal!.aborted).toBe(true);
  release("Late synthetic success");
  await new Promise((r) => setTimeout(r, 10));
  expect(f.messages).not.toContain("Late synthetic success");
  expect(f.phases.at(-1)).toBe("listening");
});
test("pending speculative navigation is cancelled by turn interruption and Stop", async () => {
  for (const stop of [false, true]) {
    let recognition: any, toolSignal: AbortSignal | undefined;
    let release!: (value: string) => void;
    class Recognition {
      onresult: any; onend: any; onerror: any;
      constructor() { recognition = this; }
      start() {} stop() {}
    }
    replace("window", { SpeechRecognition: Recognition });
    const f = await fixture({ reflex: async () => ({ name: "navigate", arguments: { path: "/operations" } }),
      onTool: async (_name, _args, signal) => { toolSignal = signal; return new Promise((resolve) => release = resolve); } });
    frame(0.1, 7);
    recognition.onresult({ resultIndex: 0, results: [[{ transcript: "Show synthetic operations" }]] });
    await Bun.sleep(PARTIAL_STABLE_MS + 15);
    await until(() => !!toolSignal);
    expect(toolSignal!.aborted).toBe(false);
    if (stop) await f.call.endSession(); else f.call.sendUserActivity();
    expect(toolSignal!.aborted).toBe(true);
    release("Late speculative success");
    await Bun.sleep(5);
    expect(f.messages).not.toContain("Late speculative success");
  }
});
test("mute disables track and prevents new captured turns; unmute restores capture", async () => {
  const f = await fixture();
  f.call.setMicMuted(true);
  frame(0.1, 7); frame(0, 9);
  expect(tracks[0].enabled).toBe(false);
  expect(f.stt).toBe(0);
  f.call.setMicMuted(false);
  frame(0.1, 7); frame(0, 9);
  await until(() => f.turns === 1 && f.phases.at(-1) === "listening");
  expect(tracks[0].enabled).toBe(true);
});
test("mute discards a partly captured utterance; unmute requires fresh speech", async () => {
  const f = await fixture();
  frame(0.1, 7);
  f.call.setMicMuted(true);
  frame(0, 9);
  expect(f.stt).toBe(0);
  f.call.setMicMuted(false);
  frame(0, 9);
  await new Promise((r) => setTimeout(r, 10));
  expect(f.stt).toBe(0);
  frame(0.1, 7); frame(0, 9);
  await until(() => f.stt === 1);
  expect(f.stt).toBe(1);
});
test("ending twice releases media once; fresh connection has no old turn history", async () => {
  const f = await fixture();
  f.call.sendUserMessage("Synthetic previous turn");
  await until(() => f.turns === 1 && f.phases.at(-1) === "listening");
  await f.call.endSession(); await f.call.endSession();
  expect(f.disconnects).toBe(1);
  expect(tracks.every((t) => t.stopped)).toBe(true);
  expect(contexts.every((c) => c.closed)).toBe(true);
  expect(ports.every((p) => p.closed)).toBe(true);
  let history = "";
  const next = await fixture({ turn: async (messages) => { history = JSON.stringify(messages); return { content: "New answer" }; } });
  next.call.sendUserMessage("Synthetic next turn");
  await until(() => history.length > 0);
  expect(history).not.toContain("Synthetic previous turn");
});
test("permission denied rejects without constructing audio contexts", async () => {
  replace("navigator", { mediaDevices: { getUserMedia: async () => { throw new DOMException("Synthetic denial", "NotAllowedError"); } } });
  await expect(fixture()).rejects.toThrow("Synthetic denial");
  expect(contexts).toHaveLength(0);
});
test("provider failure returns to listening and typed fallback can continue", async () => {
  let count = 0;
  const f = await fixture({ turn: async () => { if (++count === 1) throw new Error("Synthetic unavailable"); return { content: "Recovered synthetic answer." }; } });
  f.call.sendUserMessage("Synthetic failure");
  await until(() => f.errors.length === 1);
  expect(f.phases.at(-1)).toBe("listening");
  f.call.sendUserMessage("Synthetic retry");
  await until(() => f.messages.includes("Recovered synthetic answer.") && f.phases.at(-1) === "listening");
});

test("mute stops the independent browser recogniser and does not auto-restart it", async () => {
  let starts = 0, stops = 0;
  class Recogniser {
    onend?: () => void;
    start() { starts++; }
    stop() { stops++; this.onend?.(); }
  }
  replace("window", { SpeechRecognition: Recogniser });
  const f = await fixture({ reflex: async () => null });
  expect(starts).toBe(1);
  f.call.setMicMuted(true);
  expect(stops).toBe(1);
  expect(starts).toBe(1);
  f.call.setMicMuted(false);
  expect(starts).toBe(2);
});
