/**
 * "Hey Jarvis" wake-word detector — a browser port of openWakeWord's streaming
 * inference (https://github.com/dscripka/openWakeWord, v0.5.1 hey_jarvis model).
 *
 * Split in two halves:
 *  - The detector core (`createWakeDetector`) is pure and environment-agnostic: it
 *    only needs three ONNX sessions behind the minimal `Session` interface below,
 *    so it can run under bun/node in tests or in the browser via onnxruntime-web.
 *  - `startWakeWord` is the thin browser layer: it loads onnxruntime-web, fetches
 *    the models, opens the microphone and feeds audio into the core.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Linear-interpolation resampler. Returns `input` unchanged when rates match. */
export function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/**
 * Parses a 16-bit PCM WAV file (mono or multi-channel, downmixed to mono).
 * Some producers (streamed TTS) leave the `data` chunk's size field wrong or
 * oversized, so the declared length is clamped to what the buffer actually holds.
 */
export function parseWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  if (bytes.length < 12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "RIFF")
    throw new Error("Not a RIFF/WAV file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let numChannels = 1;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkSize = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      numChannels = view.getUint16(offset + 10, true) || 1;
      sampleRate = view.getUint32(offset + 12, true) || 16000;
      bitsPerSample = view.getUint16(offset + 22, true) || 16;
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0) throw new Error("WAV file has no data chunk.");
  if (bitsPerSample !== 16) throw new Error(`Only 16-bit PCM WAV is supported (got ${bitsPerSample}-bit).`);
  const maxAvailable = bytes.length - dataOffset;
  const declared = dataSize >>> 0; // may be bogus/oversized for streamed writers
  const clamped = Math.max(0, Math.min(declared, maxAvailable));
  const frameBytes = 2 * numChannels;
  const usableBytes = clamped - (clamped % frameBytes);
  const frameCount = usableBytes / frameBytes;
  const dataView = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, usableBytes);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) sum += dataView.getInt16((i * numChannels + c) * 2, true);
    samples[i] = sum / numChannels / 32768;
  }
  return { sampleRate, samples };
}

// ---------------------------------------------------------------------------
// Detector core
// ---------------------------------------------------------------------------

/** A tensor-shaped value: environment-agnostic, no dependency on onnxruntime-web's own type. */
export interface WakeTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/** Minimal shape of an ONNX inference session, enough to drive the three wake models. */
export interface Session {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, WakeTensor>): Promise<Record<string, WakeTensor>>;
}

export type ModelName = "melspectrogram" | "embedding_model" | "hey_jarvis_v0.1";

export interface CreateWakeDetectorOptions {
  loadModel: (name: ModelName) => Promise<Session>;
  /** Score at/above which a chunk counts as a wake trigger. Default 0.5. */
  threshold?: number;
  /** Minimum time between two triggers, so one utterance can't fire twice. Default 2000ms. */
  refractoryMs?: number;
}

export interface WakeProcessResult {
  score: number;
  triggered: boolean;
}

export interface WakeDetector {
  /** Feeds 16kHz mono float32 samples (-1..1), arbitrary length. Returns the latest score. */
  process(chunk16k: Float32Array): Promise<WakeProcessResult>;
  reset(): void;
}

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280; // 80ms @ 16kHz
const CHUNK_MS = (CHUNK_SAMPLES / SAMPLE_RATE) * 1000;
const MEL_CONTEXT_SAMPLES = 160 * 3; // openWakeWord feeds the last 1280 + 160*3 samples per step
const MEL_WINDOW_SAMPLES = CHUNK_SAMPLES + MEL_CONTEXT_SAMPLES;
const RAW_BUFFER_MAX_SAMPLES = SAMPLE_RATE * 10; // bounded ~10s of raw audio history
const MEL_BINS = 32;
const MEL_INIT_FRAMES = 76; // window size fed to the embedding model
const MEL_BUFFER_MAX_FRAMES = 1000; // ~10s at ~100 mel frames/sec
const EMBEDDING_SIZE = 96;
const EMBEDDING_WINDOW = 16; // window size fed to the wake model
const FEATURE_BUFFER_MAX = 120;
const IGNORE_FIRST_CHUNKS = 5; // openWakeWord discards predictions for the first few chunks
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_REFRACTORY_MS = 2000;

function onesMelFrame(): Float32Array {
  return new Float32Array(MEL_BINS).fill(1);
}

export async function createWakeDetector(opts: CreateWakeDetectorOptions): Promise<WakeDetector> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const refractoryChunks = Math.max(1, Math.round((opts.refractoryMs ?? DEFAULT_REFRACTORY_MS) / CHUNK_MS));

  const melSession = await opts.loadModel("melspectrogram");
  const embeddingSession = await opts.loadModel("embedding_model");
  const wakeSession = await opts.loadModel("hey_jarvis_v0.1");

  async function runMel(window: Float32Array): Promise<Float32Array[]> {
    const feeds: Record<string, WakeTensor> = {
      [melSession.inputNames[0]]: { data: window, dims: [1, window.length] },
    };
    const out = await melSession.run(feeds);
    const tensor = Object.values(out)[0];
    if (!tensor) throw new Error("Melspectrogram model returned no output.");
    const frameCount = Math.floor(tensor.data.length / MEL_BINS);
    const frames: Float32Array[] = [];
    for (let f = 0; f < frameCount; f++) {
      const frame = new Float32Array(MEL_BINS);
      for (let c = 0; c < MEL_BINS; c++) frame[c] = tensor.data[f * MEL_BINS + c] / 10 + 2;
      frames.push(frame);
    }
    return frames;
  }

  async function runEmbedding(last76Frames: Float32Array[]): Promise<Float32Array> {
    const flat = new Float32Array(MEL_INIT_FRAMES * MEL_BINS);
    for (let f = 0; f < MEL_INIT_FRAMES; f++) {
      const frame = last76Frames[f] ?? onesMelFrame();
      flat.set(frame, f * MEL_BINS);
    }
    const feeds: Record<string, WakeTensor> = {
      [embeddingSession.inputNames[0]]: { data: flat, dims: [1, MEL_INIT_FRAMES, MEL_BINS, 1] },
    };
    const out = await embeddingSession.run(feeds);
    const tensor = Object.values(out)[0];
    if (!tensor) throw new Error("Embedding model returned no output.");
    return Float32Array.from(tensor.data.subarray(0, EMBEDDING_SIZE));
  }

  async function runWake(last16Embeddings: Float32Array[]): Promise<number> {
    const flat = new Float32Array(EMBEDDING_WINDOW * EMBEDDING_SIZE);
    for (let i = 0; i < EMBEDDING_WINDOW; i++) {
      const embedding = last16Embeddings[i];
      if (embedding) flat.set(embedding, i * EMBEDDING_SIZE);
    }
    const feeds: Record<string, WakeTensor> = {
      [wakeSession.inputNames[0]]: { data: flat, dims: [1, EMBEDDING_WINDOW, EMBEDDING_SIZE] },
    };
    const out = await wakeSession.run(feeds);
    const tensor = Object.values(out)[0];
    return tensor?.data[0] ?? 0;
  }

  // The embedding model's response to a pure "ones" mel window is constant, so it is
  // computed once and reused to pre-fill the feature buffer (matches openWakeWord's
  // pre-fill-from-silence behaviour without needing a second synthetic input).
  const seedEmbedding = await runEmbedding(Array.from({ length: MEL_INIT_FRAMES }, onesMelFrame));

  let rawBuffer = new Float32Array(0);
  let pending = new Float32Array(0); // samples not yet forming a full 1280-sample chunk
  let melBuffer: Float32Array[] = [];
  let featureBuffer: Float32Array[] = [];
  let chunkCount = 0;
  let refractoryRemaining = 0;

  function resetState(): void {
    rawBuffer = new Float32Array(0);
    pending = new Float32Array(0);
    melBuffer = Array.from({ length: MEL_INIT_FRAMES }, onesMelFrame);
    featureBuffer = Array.from({ length: EMBEDDING_WINDOW }, () => seedEmbedding);
    chunkCount = 0;
    refractoryRemaining = 0;
  }
  resetState();

  async function processOneChunk(chunk: Float32Array): Promise<WakeProcessResult> {
    chunkCount++;

    // openWakeWord's melspectrogram model expects int16-scale float32 samples, not -1..1.
    const scaled = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) scaled[i] = chunk[i] * 32767;
    const merged = new Float32Array(rawBuffer.length + scaled.length);
    merged.set(rawBuffer, 0);
    merged.set(scaled, rawBuffer.length);
    rawBuffer = merged.length > RAW_BUFFER_MAX_SAMPLES ? merged.slice(merged.length - RAW_BUFFER_MAX_SAMPLES) : merged;

    const windowInput =
      rawBuffer.length >= MEL_WINDOW_SAMPLES ? rawBuffer.slice(rawBuffer.length - MEL_WINDOW_SAMPLES) : rawBuffer;
    const newFrames = await runMel(windowInput);
    melBuffer = melBuffer.concat(newFrames);
    if (melBuffer.length > MEL_BUFFER_MAX_FRAMES) melBuffer = melBuffer.slice(melBuffer.length - MEL_BUFFER_MAX_FRAMES);

    const last76 = melBuffer.slice(-MEL_INIT_FRAMES);
    const embedding = await runEmbedding(last76);
    featureBuffer.push(embedding);
    if (featureBuffer.length > FEATURE_BUFFER_MAX) featureBuffer = featureBuffer.slice(-FEATURE_BUFFER_MAX);

    let score = 0;
    if (chunkCount > IGNORE_FIRST_CHUNKS) {
      const last16 = featureBuffer.slice(-EMBEDDING_WINDOW);
      score = await runWake(last16);
    }

    let triggered = false;
    if (refractoryRemaining > 0) {
      refractoryRemaining--;
    } else if (score >= threshold) {
      triggered = true;
      refractoryRemaining = refractoryChunks;
    }
    return { score, triggered };
  }

  return {
    async process(chunk16k: Float32Array): Promise<WakeProcessResult> {
      const combined = new Float32Array(pending.length + chunk16k.length);
      combined.set(pending, 0);
      combined.set(chunk16k, pending.length);

      let offset = 0;
      let last: WakeProcessResult = { score: 0, triggered: false };
      let anyTriggered = false;
      while (combined.length - offset >= CHUNK_SAMPLES) {
        last = await processOneChunk(combined.slice(offset, offset + CHUNK_SAMPLES));
        anyTriggered ||= last.triggered;
        offset += CHUNK_SAMPLES;
      }
      pending = combined.slice(offset);
      return { score: last.score, triggered: anyTriggered };
    },
    reset(): void {
      resetState();
    },
  };
}

// ---------------------------------------------------------------------------
// Browser layer
// ---------------------------------------------------------------------------

const MODEL_URLS: Record<ModelName, string> = {
  melspectrogram: "/wakeword/melspectrogram.onnx",
  embedding_model: "/wakeword/embedding_model.onnx",
  "hey_jarvis_v0.1": "/wakeword/hey_jarvis_v0.1.onnx",
};

const WORKLET_NAME = "wake-word-capture";

/** AudioWorkletProcessor source, loaded from a Blob URL so no extra file is needed. */
const WORKLET_SOURCE = `
class WakeWordCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", WakeWordCapture);
`;

export interface StartWakeWordOptions {
  signal: AbortSignal;
  onWake: (score: number) => void;
  onError: (message: string) => void;
  /**
   * "needs-gesture": the browser's autoplay policy is holding audio until the user
   * clicks or presses a key on the page (typical right after a reload).
   */
  onState?: (state: "listening" | "needs-gesture") => void;
  threshold?: number;
}

export interface WakeWordHandle {
  stop(): void;
  pause(): void;
  resume(): void;
  readonly listening: boolean;
}

/** ~1s of 16kHz audio; if the processing backlog grows past this we drop and resync. */
const BACKLOG_LIMIT_SAMPLES = SAMPLE_RATE * 1;

export async function startWakeWord(options: StartWakeWordOptions): Promise<WakeWordHandle> {
  const { signal } = options;
  signal.throwIfAborted();

  // Loaded dynamically so the ~14MB onnxruntime-web runtime is only fetched when
  // wake-word listening is actually enabled.
  // The plain WASM build: the default export pulls the WebGPU (JSEP) build, which
  // needs different runtime files and gains nothing for three tiny CPU models.
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads = 1;

  async function loadModel(name: ModelName): Promise<Session> {
    const response = await fetch(MODEL_URLS[name]);
    if (!response.ok) throw new Error(`Could not fetch the ${name} model (HTTP ${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const session = await ort.InferenceSession.create(bytes);
    return {
      inputNames: session.inputNames,
      async run(feeds) {
        const ortFeeds: Record<string, InstanceType<typeof ort.Tensor>> = {};
        for (const [key, tensor] of Object.entries(feeds))
          ortFeeds[key] = new ort.Tensor("float32", tensor.data, tensor.dims as number[]);
        const output = await session.run(ortFeeds);
        const result: Record<string, WakeTensor> = {};
        for (const [key, tensor] of Object.entries(output))
          result[key] = { data: tensor.data as Float32Array, dims: tensor.dims };
        return result;
      },
    };
  }

  let detector: WakeDetector;
  try {
    detector = await createWakeDetector({ loadModel, threshold: options.threshold });
  } catch (error) {
    throw new Error(`The wake-word models could not be loaded: ${(error as Error).message}`);
  }
  signal.throwIfAborted();

  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Microphone access requires localhost or HTTPS in a supported browser.");
  let microphone: MediaStream;
  try {
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw new Error(`Microphone access was denied or unavailable (${(error as Error).name}).`);
  }
  if (signal.aborted) {
    microphone.getTracks().forEach((t) => t.stop());
    signal.throwIfAborted();
  }

  // A 16 kHz context lets the browser resample the mic with a proper anti-alias filter;
  // linear decimation from 48 kHz would fold noise into the band the models listen to.
  // Some browsers refuse to connect a mic to a context at a different rate, so fall back.
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  let audioContext!: AudioContext;
  let source: MediaStreamAudioSourceNode | undefined;
  for (const rate of [SAMPLE_RATE, undefined]) {
    try {
      audioContext = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext();
      await audioContext.audioWorklet.addModule(workletUrl);
      source = audioContext.createMediaStreamSource(microphone);
      break;
    } catch (error) {
      void audioContext?.close().catch(() => {});
      if (rate === undefined) {
        microphone.getTracks().forEach((t) => t.stop());
        URL.revokeObjectURL(workletUrl);
        throw new Error(`This browser could not start wake-word audio capture: ${(error as Error).message}`);
      }
    }
  }

  let stopped = false;
  let paused = false;
  let node: AudioWorkletNode | undefined;
  const gestureEvents = ["pointerdown", "keydown"] as const;
  const arm = () => void audioContext.resume().catch(() => {});
  const disarm = () => gestureEvents.forEach((type) => window.removeEventListener(type, arm));

  let nativeBacklog: number[] = [];
  let sample16kBacklog = new Float32Array(0);
  let busy = false;

  const stopMicrophone = () => microphone?.getTracks().forEach((t) => t.stop());

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    try {
      node?.port.close();
      node?.disconnect();
      source?.disconnect();
    } catch {
      // ignore teardown races
    }
    disarm();
    stopMicrophone();
    void audioContext.close().catch(() => {});
    URL.revokeObjectURL(workletUrl);
  };

  signal.addEventListener("abort", cleanup, { once: true });

  function appendNative(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) nativeBacklog.push(chunk[i]);
  }

  function drainNativeInto16k(): void {
    if (nativeBacklog.length === 0) return;
    const native = Float32Array.from(nativeBacklog);
    nativeBacklog = [];
    const down = downsample(native, audioContext.sampleRate, SAMPLE_RATE);
    if (down.length === 0) return;
    const merged = new Float32Array(sample16kBacklog.length + down.length);
    merged.set(sample16kBacklog, 0);
    merged.set(down, sample16kBacklog.length);
    sample16kBacklog = merged;
  }

  async function pump(): Promise<void> {
    if (busy || stopped || paused) return;
    drainNativeInto16k();
    if (sample16kBacklog.length > BACKLOG_LIMIT_SAMPLES) {
      // Fell behind by more than ~1s: drop the stale backlog and resync the detector
      // rather than silently losing continuity without acknowledging it.
      sample16kBacklog = sample16kBacklog.slice(sample16kBacklog.length - CHUNK_SAMPLES);
      detector.reset();
    }
    if (sample16kBacklog.length < CHUNK_SAMPLES) return;
    const chunk = sample16kBacklog.slice(0, CHUNK_SAMPLES);
    sample16kBacklog = sample16kBacklog.slice(CHUNK_SAMPLES);
    busy = true;
    try {
      const { score, triggered } = await detector.process(chunk);
      if (triggered) options.onWake(score);
    } catch {
      options.onError("Wake-word inference failed; listening was reset.");
      detector.reset();
    } finally {
      busy = false;
      if (!stopped && !paused && sample16kBacklog.length >= CHUNK_SAMPLES) void pump();
    }
  }

  if (stopped) throw new DOMException("Wake word stopped.", "AbortError");

  node = new AudioWorkletNode(audioContext, WORKLET_NAME);
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (stopped || paused) return;
    try {
      appendNative(event.data);
      void pump();
    } catch {
      // Never throw from inside the audio callback.
      options.onError("Wake-word audio processing hit an unexpected error.");
    }
  };
  source!.connect(node);

  // Autoplay policy: without a click or key press since page load the context stays
  // suspended and the detector would be silently deaf. Arm on the first gesture.
  const reportState = () =>
    options.onState?.(audioContext.state === "running" ? "listening" : "needs-gesture");
  audioContext.addEventListener("statechange", () => {
    if (audioContext.state === "running") disarm();
    if (!stopped) reportState();
  });
  if (audioContext.state !== "running") {
    gestureEvents.forEach((type) => window.addEventListener(type, arm, { passive: true }));
    arm();
  }
  reportState();

  return {
    stop(): void {
      cleanup();
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      nativeBacklog = [];
      sample16kBacklog = new Float32Array(0);
      detector.reset();
      paused = false;
    },
    get listening(): boolean {
      return !stopped && !paused;
    },
  };
}
