// Screen sharing with Jarvis (24 Sep; design from the Ministry + GPT-6 Astra research):
// - he starts it and picks the window/tab (getDisplayMedia); Chrome shows its own sharing bar
//   and the OS shows "Jarvis can see this" with pause and stop;
// - frames are taken only when he asks something about the screen, downscaled to a JPEG,
//   sent once and dropped; nothing is stored or uploaded in the background;
// - optional tab/system audio keeps a rolling 30 s buffer in memory only, for "what did they
//   just say?"; it's cleared on pause/stop.
// Sending a frame to a vision model is a separate, remembered permission (cloudVision).

export type ShareState = {
  sharing: boolean;
  paused: boolean;
  label: string;
  audio: boolean;
  cloudVision: boolean;
  lastChangeAt: number | null;
  error?: string;
};

const AUDIO_RATE = 16_000;
const AUDIO_SECONDS = 30;
const CLOUD_KEY = "jarvis:cloud-vision";

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let sampler: number | null = null;
let previous: Uint8ClampedArray | null = null;
let audioContext: AudioContext | null = null;
let audioNode: ScriptProcessorNode | null = null;
let ring: Float32Array | null = null;
let ringPos = 0;
let ringFilled = 0;
const listeners = new Set<(s: ShareState) => void>();

function readCloud() {
  try {
    return localStorage.getItem(CLOUD_KEY) === "on";
  } catch {
    return false;
  }
}

let state: ShareState = { sharing: false, paused: false, label: "", audio: false, cloudVision: false, lastChangeAt: null };

function set(patch: Partial<ShareState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function shareState(): ShareState {
  return { ...state, cloudVision: readCloud() };
}

export function subscribeShare(listener: (s: ShareState) => void) {
  listeners.add(listener);
  listener(shareState());
  return () => void listeners.delete(listener);
}

export function setCloudVision(on: boolean) {
  try {
    localStorage.setItem(CLOUD_KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
  set({ cloudVision: on });
}

export function screenShareSupported() {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

/** Mean absolute difference between two small greyscale thumbnails, 0–255. */
export function frameDifference(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  if (a.length !== b.length || !a.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** 16-bit mono PCM WAV from float samples. */
export function floatToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const ascii = (o: number, t: string) => [...t].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

function thumbnail(): Uint8ClampedArray | null {
  if (!video || video.readyState < 2) return null;
  const c = document.createElement("canvas");
  c.width = 48;
  c.height = 27;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(video, 0, 0, c.width, c.height);
  const rgba = g.getImageData(0, 0, c.width, c.height).data;
  const grey = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0; i < grey.length; i++) grey[i] = (rgba[i * 4] * 3 + rgba[i * 4 + 1] * 6 + rgba[i * 4 + 2]) / 10;
  return grey;
}

function startAudio(track: MediaStreamTrack) {
  try {
    audioContext = new AudioContext({ sampleRate: AUDIO_RATE });
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    ring = new Float32Array(AUDIO_RATE * AUDIO_SECONDS);
    ringPos = 0;
    ringFilled = 0;
    audioNode = audioContext.createScriptProcessor(4096, 1, 1);
    audioNode.onaudioprocess = (e) => {
      if (!ring || state.paused) return;
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        ring[ringPos] = input[i];
        ringPos = (ringPos + 1) % ring.length;
      }
      ringFilled = Math.min(ring.length, ringFilled + input.length);
    };
    // Connected through a muted gain so the processor runs without playing the tab twice.
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    source.connect(audioNode);
    audioNode.connect(mute);
    mute.connect(audioContext.destination);
    set({ audio: true });
  } catch {
    set({ audio: false });
  }
}

export async function startShare(options: { audio?: boolean } = {}) {
  if (!screenShareSupported()) throw new Error("This browser can't share its screen.");
  if (stream) return shareState();
  const media = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 5 },
    audio: options.audio ? { suppressLocalAudioPlayback: false } : false,
    // Chrome hints: don't offer this OS tab itself; let him switch surfaces mid-share.
    ...({ selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: options.audio ? "include" : "exclude" } as object),
  } as DisplayMediaStreamOptions);
  stream = media;
  const track = media.getVideoTracks()[0];
  track.addEventListener("ended", () => stopShare());
  video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play().catch(() => undefined);
  const audioTrack = media.getAudioTracks()[0];
  if (audioTrack) startAudio(audioTrack);
  previous = null;
  // Change detection only (cheap, local): lets Jarvis say "that changed" and keeps the HUD honest.
  sampler = window.setInterval(() => {
    if (state.paused) return;
    const now = thumbnail();
    if (!now) return;
    if (!previous || frameDifference(previous, now) > 6) set({ lastChangeAt: Date.now() });
    previous = now;
  }, 1000);
  set({ sharing: true, paused: false, label: track.label || "your screen", error: undefined, cloudVision: readCloud() });
  return shareState();
}

export function pauseShare(paused: boolean) {
  if (!stream) return;
  for (const t of stream.getTracks()) t.enabled = !paused;
  if (paused && ring) {
    ring.fill(0);
    ringFilled = 0;
  }
  set({ paused });
}

export function stopShare() {
  if (sampler) window.clearInterval(sampler);
  sampler = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  previous = null;
  audioNode?.disconnect();
  audioNode = null;
  void audioContext?.close().catch(() => undefined);
  audioContext = null;
  ring = null;
  ringFilled = 0;
  set({ sharing: false, paused: false, label: "", audio: false, lastChangeAt: null });
}

/** A fresh frame as a downscaled JPEG (base64, no data: prefix). Never stored. */
export async function captureFrame(maxWidth = 1280, quality = 0.72): Promise<{ image: string; mime: string }> {
  if (!stream || !video) throw new Error("Screen sharing is off. Press Share screen first.");
  if (state.paused) throw new Error("Screen sharing is paused.");
  if (video.readyState < 2) await new Promise((r) => setTimeout(r, 300));
  const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round((video.videoWidth || 1280) * scale));
  c.height = Math.max(1, Math.round((video.videoHeight || 720) * scale));
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", quality);
  return { image: url.slice(url.indexOf(",") + 1), mime: "image/jpeg" };
}

/** The last `seconds` of shared audio as a base64 WAV (in memory only), or null without audio. */
export function recentAudio(seconds = 20): string | null {
  if (!ring || !ringFilled || state.paused) return null;
  const n = Math.min(ringFilled, Math.round(seconds * AUDIO_RATE));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ring[(ringPos - n + i + ring.length) % ring.length];
  const wav = floatToWav(out, AUDIO_RATE);
  let binary = "";
  for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
  return btoa(binary);
}
