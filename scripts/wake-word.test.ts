import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWakeDetector,
  downsample,
  parseWav,
  type ModelName,
  type Session,
  type WakeTensor,
} from "../src/lib/wake-word";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/wake");
const MODELS_DIR = join(import.meta.dir, "..", "public", "wakeword");
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280;

const POSITIVE_FIXTURES = ["positive-daniel", "positive-diana", "positive-troy"];
const NEGATIVE_FIXTURES = ["negative-hey-there", "negative-travis", "negative-meeting"];

// --- Try to load onnxruntime-web under bun. If this fails entirely, every model-based
// test below is skipped with a clear reason instead of failing the whole suite. ---
let ort: typeof import("onnxruntime-web") | undefined;
let ortLoadError: unknown;
try {
  ort = await import("onnxruntime-web");
} catch (error) {
  ortLoadError = error;
}

const MODEL_FILES: Record<ModelName, string> = {
  melspectrogram: "melspectrogram.onnx",
  embedding_model: "embedding_model.onnx",
  "hey_jarvis_v0.1": "hey_jarvis_v0.1.onnx",
};

/** Wraps a real onnxruntime-web InferenceSession behind the pure `Session` interface. */
function adaptSession(session: import("onnxruntime-web").InferenceSession, ortModule: typeof import("onnxruntime-web")): Session {
  return {
    inputNames: session.inputNames,
    async run(feeds: Record<string, WakeTensor>) {
      const ortFeeds: Record<string, InstanceType<typeof ortModule.Tensor>> = {};
      for (const [key, tensor] of Object.entries(feeds))
        ortFeeds[key] = new ortModule.Tensor("float32", tensor.data, tensor.dims as number[]);
      const output = await session.run(ortFeeds);
      const result: Record<string, WakeTensor> = {};
      for (const [key, tensor] of Object.entries(output))
        result[key] = { data: tensor.data as Float32Array, dims: tensor.dims };
      return result;
    },
  };
}

async function loadDetector(threshold?: number) {
  if (!ort) throw new Error("onnxruntime-web unavailable");
  const ortModule = ort;
  const sessionCache = new Map<ModelName, Session>();
  async function loadModel(name: ModelName): Promise<Session> {
    const cached = sessionCache.get(name);
    if (cached) return cached;
    const bytes = readFileSync(join(MODELS_DIR, MODEL_FILES[name]));
    const session = await ortModule.InferenceSession.create(bytes);
    const adapted = adaptSession(session, ortModule);
    sessionCache.set(name, adapted);
    return adapted;
  }
  return createWakeDetector({ loadModel, threshold });
}

async function streamFixture(name: string) {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, `${name}.wav`)));
  const wav = parseWav(bytes);
  const at16k = downsample(wav.samples, wav.sampleRate, SAMPLE_RATE);
  const silence = new Float32Array(SAMPLE_RATE); // ~1s padding
  const padded = new Float32Array(silence.length * 2 + at16k.length);
  padded.set(silence, 0);
  padded.set(at16k, silence.length);
  padded.set(silence, silence.length + at16k.length);

  const detector = await loadDetector();
  let maxScore = 0;
  let triggerCount = 0;
  for (let offset = 0; offset + CHUNK_SAMPLES <= padded.length; offset += CHUNK_SAMPLES) {
    const { score, triggered } = await detector.process(padded.slice(offset, offset + CHUNK_SAMPLES));
    if (score > maxScore) maxScore = score;
    if (triggered) triggerCount++;
  }
  return { maxScore, triggerCount };
}

// ---------------------------------------------------------------------------
// Pure helper tests — always run, no model required.
// ---------------------------------------------------------------------------

describe("parseWav", () => {
  test("parses a synthetic 16-bit mono PCM WAV and clamps an oversized data-chunk size", () => {
    const sampleRate = 16000;
    const samples = new Int16Array([0, 16384, -16384, 32767, -32768, 100]);
    const dataBytes = samples.length * 2;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    // Deliberately oversized/bogus size, like the streamed-TTS fixtures.
    view.setUint32(40, 0xffffffff, true);
    const full = new Uint8Array(44 + dataBytes);
    full.set(new Uint8Array(header), 0);
    for (let i = 0; i < samples.length; i++) full.set(new Uint8Array(new Int16Array([samples[i]]).buffer), 44 + i * 2);

    const parsed = parseWav(full);
    expect(parsed.sampleRate).toBe(sampleRate);
    expect(parsed.samples.length).toBe(samples.length);
    expect(parsed.samples[0]).toBeCloseTo(0, 5);
    expect(parsed.samples[1]).toBeCloseTo(16384 / 32768, 4);
    expect(parsed.samples[3]).toBeCloseTo(32767 / 32768, 4);
    expect(parsed.samples[4]).toBeCloseTo(-1, 4);
  });

  test("throws on a non-WAV buffer", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe("downsample", () => {
  test("returns input unchanged when rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsample(input, 16000, 16000)).toBe(input);
  });

  test("halves length and interpolates for a 2x rate reduction", () => {
    const input = new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]);
    const out = downsample(input, 32000, 16000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  test("produces a proportionally shorter signal for 24kHz -> 16kHz (fixture rate)", () => {
    const input = new Float32Array(2400).map((_, i) => Math.sin(i / 10));
    const out = downsample(input, 24000, 16000);
    expect(out.length).toBe(1600);
  });
});

// ---------------------------------------------------------------------------
// Model-based streaming tests.
// ---------------------------------------------------------------------------

if (!ort) {
  test.skip(
    `wake detector streaming (onnxruntime-web failed to load under bun: ${String(ortLoadError)})`,
    () => {},
  );
} else {
  describe("wake detector — positive fixtures", () => {
    for (const name of POSITIVE_FIXTURES) {
      test(`"${name}" triggers exactly once and scores above threshold`, async () => {
        const { maxScore, triggerCount } = await streamFixture(name);
        console.log(`[wake-word] ${name} max score = ${maxScore.toFixed(4)}`);
        expect(maxScore).toBeGreaterThan(0.5);
        expect(triggerCount).toBe(1);
      });
    }
  });

  describe("wake detector — negative fixtures", () => {
    for (const name of NEGATIVE_FIXTURES) {
      test(`"${name}" never triggers and stays below threshold`, async () => {
        const { maxScore, triggerCount } = await streamFixture(name);
        console.log(`[wake-word] ${name} max score = ${maxScore.toFixed(4)}`);
        expect(maxScore).toBeLessThan(0.5);
        expect(triggerCount).toBe(0);
      });
    }
  });

  describe("wake detector — non-speech audio", () => {
    test("silence never triggers", async () => {
      const detector = await loadDetector();
      const silence = new Float32Array(SAMPLE_RATE * 3);
      let maxScore = 0;
      let triggerCount = 0;
      for (let offset = 0; offset + CHUNK_SAMPLES <= silence.length; offset += CHUNK_SAMPLES) {
        const { score, triggered } = await detector.process(silence.slice(offset, offset + CHUNK_SAMPLES));
        if (score > maxScore) maxScore = score;
        if (triggered) triggerCount++;
      }
      console.log(`[wake-word] silence max score = ${maxScore.toFixed(4)}`);
      expect(maxScore).toBeLessThan(0.5);
      expect(triggerCount).toBe(0);
    });

    test("white noise never triggers", async () => {
      const detector = await loadDetector();
      const noise = new Float32Array(SAMPLE_RATE * 3);
      // Deterministic pseudo-random noise so the test is reproducible.
      let state = 42;
      for (let i = 0; i < noise.length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        noise[i] = ((state / 0x7fffffff) * 2 - 1) * 0.05;
      }
      let maxScore = 0;
      let triggerCount = 0;
      for (let offset = 0; offset + CHUNK_SAMPLES <= noise.length; offset += CHUNK_SAMPLES) {
        const { score, triggered } = await detector.process(noise.slice(offset, offset + CHUNK_SAMPLES));
        if (score > maxScore) maxScore = score;
        if (triggered) triggerCount++;
      }
      console.log(`[wake-word] white noise max score = ${maxScore.toFixed(4)}`);
      expect(maxScore).toBeLessThan(0.5);
      expect(triggerCount).toBe(0);
    });
  });

  describe("wake detector — session shape", () => {
    test("model input names match the expected pipeline", async () => {
      const bytes = readFileSync(join(MODELS_DIR, MODEL_FILES.melspectrogram));
      const session = await ort!.InferenceSession.create(bytes);
      expect(session.inputNames[0]).toBe("input");
    });
  });
}
