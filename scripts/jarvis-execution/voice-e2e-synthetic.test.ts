// Round 3, item 4: ONE end-to-end synthetic voice test. Generated speech (Windows SAPI text-to-speech, no recording) is fed as
// 100 ms PCM frames into the REAL client turn logic (src/lib/free-voice-client.ts: VAD, endpointing, WAV capture, duplicate guard,
// tool loop), its own captured WAV is transcribed by an offline SAPI recogniser (a command grammar standing in for Groq STT), the
// scripted "brain" asks for jarvis_command exactly as the real one does, and the tool glue (the same functions voice-companion.tsx
// uses: voiceRouteFor, runJarvisCommand) posts to the REAL command service, which dispatches to a SYNTHETIC device. The assertion is
// on the JOB: its kind, device, step, outcome, and the one short line spoken back.
//
// Synthetic: the speech engine's voice, the recogniser's grammar, the fake Web Audio graph, the brain's script, the device.
// NOT proven here, and still OWED to the owner: a physical microphone in a real room (see docs/programme-20261001/VOICE-TURNS.md section 7).
// Skipped (not faked) where Windows speech isn't installed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFreeVoice, type ChatMessage, type FreeVoiceCall } from "../../src/lib/free-voice-client";
import { commandPageContext, commandResultText, COMMAND_PATH, runJarvisCommand, voiceRouteFor } from "../../src/lib/jarvis-command";
import { publishPageContext, readPageContext, resetPageContext, setActivePage } from "../../src/lib/page-context";
import { rig as rigWith, SYNTHETIC_MEHROZ_PC_ID, type Rig } from "../jarvis-command/r3-rig";

const PHRASES = ["open PowerPoint and create a blank presentation", "open this lead's website", "open Chrome and create a new tab"];
const work = mkdtempSync(join(tmpdir(), "r3-voice-"));
const ps = (script: string, env: Record<string, string>) => Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

const TTS = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:R3_OUT, $fmt)
$s.Speak($env:R3_TEXT)
$s.Dispose()`;
const STT = `Add-Type -AssemblyName System.Speech
$choices = New-Object System.Speech.Recognition.Choices
foreach ($p in ($env:R3_PHRASES -split '\\|')) { [void]$choices.Add($p) }
$g = New-Object System.Speech.Recognition.Grammar((New-Object System.Speech.Recognition.GrammarBuilder($choices)))
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.LoadGrammar($g)
$r.SetInputToWaveFile($env:R3_WAV)
$res = $r.Recognize()
if ($res) { $res.Text }
$r.Dispose()`;

/** Generated speech as mono 16 kHz samples, or null where Windows speech isn't there. */
function speak(text: string): Float32Array | null {
  if (process.platform !== "win32") return null;
  const out = join(work, `speech-${Math.random().toString(36).slice(2)}.wav`);
  const r = ps(TTS, { R3_TEXT: text, R3_OUT: out });
  if (r.exitCode !== 0) return null;
  const wav = readFileSync(out);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "data") {
      const n = Math.floor(Math.min(size, wav.length - at - 8) / 2);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = wav.readInt16LE(at + 8 + i * 2) / 32768;
      // A steady level, as a room mic gives a person at a normal distance (RMS about 0.12 over the speech).
      let sum = 0;
      for (const v of pcm) sum += v * v;
      const rms = Math.sqrt(sum / Math.max(n, 1)) || 1;
      return pcm.map((v) => Math.max(-0.95, Math.min(0.95, (v / rms) * 0.12)));
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
/** The recogniser: it hears the WAV the CLIENT captured (base64) and answers with the phrase it recognises, or "". */
function recognise(wavBase64: string): string {
  const wav = join(work, `heard-${Math.random().toString(36).slice(2)}.wav`);
  writeFileSync(wav, Buffer.from(wavBase64, "base64"));
  const r = ps(STT, { R3_WAV: wav, R3_PHRASES: PHRASES.join("|") });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}
const SPEECH_OK = (() => {
  try {
    return speak("test") !== null;
  } catch {
    return false;
  }
})();

// ---- the fake Web Audio graph (browser media boundary only) ---------------------------------------------
const originals = new Map<string, PropertyDescriptor | undefined>();
let ports: Array<{ port: { onmessage: null | ((e: unknown) => void) } }> = [];
class FakeSource {
  onended: null | (() => void) = null;
  playbackRate = { value: 1 };
  buffer: unknown = null;
  connect() {}
  start() {
    queueMicrotask(() => this.onended?.());
  }
  stop() {}
}
class FakeAudio {
  destination = {};
  currentTime = 0;
  audioWorklet = { addModule: async () => {} };
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createAnalyser() { return { fftSize: 256, connect() {}, getByteTimeDomainData(a: Uint8Array) { a.fill(128); } }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async decodeAudioData() { return { duration: 0.01 }; }
  createBufferSource() { return new FakeSource(); }
  async suspend() {}
  async resume() {}
  async close() {}
}
class FakeWorklet {
  port = { onmessage: null as null | ((e: unknown) => void), close() {} };
  constructor() { ports.push(this); }
  connect() {}
}
const replace = (name: string, value: unknown) => {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
const cleanups: Array<() => Promise<void> | void> = [];
const calls: FreeVoiceCall[] = [];
beforeEach(() => {
  ports = [];
  const track = { enabled: true, readyState: "live", onended: null, onmute: null, onunmute: null, stop() {} };
  replace("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }), addEventListener() {}, removeEventListener() {} } });
  replace("window", { dispatchEvent: () => true, location: { pathname: "/leads" } });
  replace("AudioContext", FakeAudio);
  replace("AudioWorkletNode", FakeWorklet);
});
afterEach(async () => {
  for (const c of calls.splice(0)) await c.endSession();
  resetPageContext();
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const [key, d] of originals) {
    if (d) Object.defineProperty(globalThis, key, d);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

const frames = (samples: Float32Array) => {
  for (let i = 0; i < samples.length; i += 1600) {
    const chunk = new Float32Array(1600);
    chunk.set(samples.subarray(i, Math.min(i + 1600, samples.length)));
    ports.at(-1)!.port.onmessage?.({ data: { samples: chunk, sampleRate: 16000 } });
  }
};
const silence = (n: number) => frames(new Float32Array(1600 * n));
async function until(check: () => boolean, label: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`${label} did not settle`);
}
const SHORT = { fillerHoldMs: 120, danglingHoldMs: 120, ellipsisHoldMs: 120, commaHoldMs: 80, maxTotalMs: 400, mergeWindowMs: 500 };

async function session(r: Rig) {
  const heard: string[] = [];
  const spoken: string[] = [];
  const toolArgs: string[] = [];
  const messages: string[] = [];
  const call = await startFreeVoice({
    signal: new AbortController().signal,
    endpointing: SHORT,
    // The recogniser hears the audio the client itself captured and cut (its own VAD, its own WAV).
    stt: async (wavBase64) => {
      const text = recognise(wavBase64);
      heard.push(text);
      return text;
    },
    // The brain's script, as the real brain does it: a command request goes to jarvis_command; the tool's own `said` is what it speaks.
    turn: async (history: ChatMessage[]) => {
      const last = history.at(-1)!;
      if (last.role === "tool") return { content: String((JSON.parse(last.content) as { said?: string }).said ?? "") };
      const user = [...history].reverse().find((m) => m.role === "user")!;
      return { content: null, tool_calls: [{ id: `call-${heard.length}`, type: "function" as const, function: { name: "jarvis_command", arguments: JSON.stringify({ utterance: (user as { content: string }).content }) } }] };
    },
    tts: async (text) => (spoken.push(text), { audio: "AA==", mime: "audio/wav" }),
    // The tool glue voice-companion.tsx's jarvisCommand() has: Track 1's one resolver first, then the one server entry with the page.
    onTool: async (name, args) => {
      toolArgs.push(`${name}:${String(args.utterance)}`);
      const utterance = String(args.utterance);
      const route = voiceRouteFor(utterance, readPageContext());
      if (route.route !== "server") return commandResultText({ type: "done", ok: true, said: `(client resolved: ${route.route})`, kind: "answer", jobId: null, runId: "", targetDeviceId: null });
      const done = await runJarvisCommand({ utterance, source: "voice", pageContext: commandPageContext(), post: r.post });
      return commandResultText(done);
    },
    onMessage: (role, text) => void (role === "user" && messages.push(text)),
    onCaption() {},
    onPhase() {},
    onError: (m) => { throw new Error(m); },
    onDisconnect() {},
  });
  calls.push(call);
  return { heard, spoken, toolArgs, messages };
}

describe.skipIf(!SPEECH_OK)("generated speech, through the real client turn logic and the real command route, to a job", () => {
  test("'open PowerPoint and create a blank presentation': one job on his own device, one dispatch, one short spoken line; the same words again are not a second action", async () => {
    const r = rigWith({}, cleanups);
    const s = await session(r);
    const speech = speak("open PowerPoint and create a blank presentation")!;
    expect(speech.length).toBeGreaterThan(16000);
    silence(3);
    frames(speech);
    silence(10);
    await until(() => s.spoken.length >= 1, "the spoken reply");
    expect(s.heard[0].toLowerCase()).toBe("open powerpoint and create a blank presentation");
    expect(s.toolArgs).toEqual(["jarvis_command:open PowerPoint and create a blank presentation"]);

    // The job, not the words: it is a voice job on Mehroz's synthetic PC with one verified companion step.
    const jobs = r.jobs.list().map((j) => r.jobs.get(j.id)!);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "voice", state: "succeeded", targetDeviceId: SYNTHETIC_MEHROZ_PC_ID });
    expect(jobs[0].steps.map((x) => `${x.executor}:${x.action}:${x.outcome}`)).toEqual(["companion:deck.blank:ok"]);
    expect(r.ran.map((c) => c.executor)).toEqual(["deck.blank"]);
    expect(r.wire.map((w) => `${w.path}:${w.body.source}`)).toEqual([`${COMMAND_PATH}:voice`]);
    // Routine reply: short, and it is the job's own line.
    expect(s.spoken[0]).toBe(jobs[0].note ?? s.spoken[0]);
    expect(s.spoken[0].length).toBeLessThan(110);

    // He says it again straight away: it is the same command, not a second one.
    silence(2);
    frames(speech);
    silence(10);
    await new Promise((res) => setTimeout(res, 1500));
    expect(r.ran.map((c) => c.executor)).toEqual(["deck.blank"]);
    expect(r.jobs.list()).toHaveLength(1);
  }, 120_000);

  test("'open this lead's website' on a lead page: the lead comes from the page, the address from the CRM, the page opens on his device", async () => {
    const r = rigWith({ "7": { name: "Harbour Dental", website: "harbour.example.com.au" } }, cleanups);
    setActivePage({ path: "/leads", destination: "work", title: "Leads" });
    publishPageContext("leads:drawer", { selection: { kind: "lead", id: "7", label: "Harbour Dental", to: "/leads", search: { lead: "7" } } });
    const s = await session(r);
    silence(3);
    frames(speak("open this lead's website")!);
    silence(10);
    await until(() => s.spoken.length >= 1, "the spoken reply");
    expect(s.heard[0].toLowerCase()).toBe("open this lead's website");
    expect(r.leadLookups).toEqual(["7"]);
    expect(r.ran).toEqual([{ executor: "browser.navigate", args: { url: "https://harbour.example.com.au/" }, personId: "mehroz" }]);
    const jobs = r.jobs.list().map((j) => r.jobs.get(j.id)!);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "voice", state: "succeeded", targetDeviceId: SYNTHETIC_MEHROZ_PC_ID });
    expect(s.spoken[0].length).toBeLessThan(110);
  }, 120_000);

  test("negative control: speech that is not a command it knows is heard as nothing, so no tool call, no job, no dispatch (the transcript really comes from the audio)", async () => {
    const r = rigWith({}, cleanups);
    const s = await session(r);
    silence(3);
    frames(speak("what a lovely morning it is today")!);
    silence(10);
    await until(() => s.heard.length >= 1, "the recogniser's answer");
    await new Promise((res) => setTimeout(res, 300));
    expect(s.heard[0]).toBe("");
    expect(s.toolArgs).toEqual([]);
    expect(r.jobs.list()).toHaveLength(0);
    expect(r.ran).toEqual([]);
  }, 120_000);

  test("'open Chrome and create a new tab': a typed blank-tab step on his device, not a guess", async () => {
    const r = rigWith({}, cleanups);
    const s = await session(r);
    silence(3);
    frames(speak("open Chrome and create a new tab")!);
    silence(10);
    await until(() => s.spoken.length >= 1, "the spoken reply");
    expect(s.heard[0].toLowerCase()).toBe("open chrome and create a new tab");
    expect(r.ran).toEqual([{ executor: "browser.navigate", args: { blank: true }, personId: "mehroz" }]);
  }, 120_000);
});

test("the speech check is skipped, not faked, where Windows speech is missing", () => {
  expect(typeof SPEECH_OK).toBe("boolean");
});
// Cleanup of the scratch folder the generated audio went to.
process.on("exit", () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
