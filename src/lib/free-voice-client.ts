/**
 * Free (non-realtime) voice engine: a turn-based STT -> LLM -> TTS pipeline driven entirely
 * by server calls injected through options. This module never calls fetch and never sees an
 * API key — stt/turn/tts are provided by the caller and do the network work server-side.
 */
import { runVoiceToolBatch, screenResultPause } from "./screen-result";
import { neutralisePageReads, pageReadForModel } from "./page-read";
import type { VoicePhase } from "./openai-voice-client";
import { isEarconEnabled, playAcknowledgeEarcon, type EarconAudioContext } from "./earcons";
import { validPersonality } from "./voice-personality";
import {
  ENDPOINTING,
  FALSE_INTERRUPTION_MS,
  INTERRUPT_CONFIRM_MS,
  STOP_QUESTION_TTL_MS,
  STOP_TASK_QUESTION,
  answerStopQuestion,
  classifyStop,
  createDuplicateGuard,
  utteranceEventId,
  createMicReconnector,
  remainingHoldMs,
  type EndpointConfig,
  type MicStatus,
} from "./voice-turns";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type FreeVoiceOptions = {
  signal: AbortSignal;
  stt: (wavBase64: string, signal: AbortSignal) => Promise<string>;
  turn: (
    messages: ChatMessage[],
    context: string[],
    signal: AbortSignal,
  ) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>;
  tts: (text: string, signal: AbortSignal) => Promise<{ audio: string; mime: string }>;
  /**
   * Streamed speech (raw 16-bit mono PCM) for the first sentence of a reply, played as it
   * arrives; null when the voice can't stream, and `tts` is used instead.
   */
  ttsStream?: (text: string, signal: AbortSignal) => Promise<{ stream: ReadableStream<Uint8Array>; sampleRate: number } | null>;
  onMessage: (role: "user" | "assistant", text: string) => void;
  onCaption: (text: string) => void;
  onPhase: (phase: VoicePhase) => void;
  onError: (message: string) => void;
  onDisconnect: () => void;
  /**
   * Runs a tool. `say` speaks one short progress line while it runs (e.g. screen_act's "One
   * moment." when a step is slow); the tool's result still comes back as usual.
   */
  onTool: (name: string, args: Record<string, unknown>, signal: AbortSignal, say: (line: string) => void) => Promise<string>;
  slowTools?: string[];
  /**
   * Work Jarvis left going on the server (a computer job, a coding job) outlives any one turn, so a "stop that task" with nothing running HERE is
   * still a stop of that work. When given, those words go to this (the one command path's stop, which cancels the right job or asks which) and
   * its line is spoken; null falls back to "Nothing is running." A bare "stop" only goes there when `hasBackgroundWork` says something is going.
   */
  backgroundStop?: (text: string, signal: AbortSignal) => Promise<string | null>;
  hasBackgroundWork?: () => boolean;
  greeting?: string;
  /** Read per clip so speed changes apply without restarting the conversation. */
  speechSpeed?: () => number;
  /**
   * "Act while I speak": asked with a stable partial transcript (browser interim results,
   * debounced) and returns a show-only tool call to run before he finishes, or null. Omit to
   * keep the classic turn-based behaviour. At most one speculative action per utterance.
   */
  reflex?: (partial: string, signal: AbortSignal) => Promise<{ name: string; arguments: Record<string, unknown> } | null>;
  /**
   * Latency instrumentation only (scripts/voice-latency.ts, docs/SCREEN-CONTROL.md): one call per
   * spoken command with four timestamps (speech end, route decided, action started, action done)
   * and the route that answered ("rules", "jev-router" or a brain model). Never awaited, never
   * changes routing or timing — the caller (voice-companion.tsx) fires a best-effort POST.
   */
  /**
   * Turn-taking tuning (src/lib/voice-turns.ts). Defaults are the shipped behaviour; tests shrink
   * the delays so a synthetic fixture runs in milliseconds.
   */
  endpointing?: Partial<EndpointConfig>;
  falseInterruptionMs?: number;
  micReconnectDelays?: number[];
  /** The microphone dropped (device change, permission blip) and was re-acquired or given up on; the session continues. */
  onMicStatus?: (status: MicStatus) => void;
  onLatency?: (entry: { id: string; route: string; speechEndAt: number; routeDecidedAt: number; actionStartedAt: number; actionDoneAt: number }) => void;
};

/** A short, distinct id for one spoken command, derived from its speech-end timestamp. */
export function newLatencyId(speechEndAt: number): string {
  return `v_${speechEndAt.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Words of the partial the final transcript still contains: guards against a misheard start. */
export function partialStillHolds(partial: string, final: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const said = new Set(words(final));
  const heard = words(partial);
  return heard.length > 0 && heard.filter((w) => said.has(w)).length / heard.length >= 0.75;
}

/** Debounce for partials: fire once the interim text has been stable this long. */
export const PARTIAL_STABLE_MS = 200;

export type FreeVoiceCall = {
  model: string;
  voice: string;
  greet: () => void;
  endSession: () => Promise<void>;
  setMicMuted: (muted: boolean) => void;
  setVolume: (options: { volume: number }) => void;
  getInputVolume: () => number;
  getOutputVolume: () => number;
  resumeAudio: () => Promise<void>;
  sendContextualUpdate: (text: string) => void;
  sendUserMessage: (text: string) => void;
  sendUserActivity: () => void;
  /**
   * Speak a line without a user turn (a proactive interjection). Spoken only while the
   * conversation is idle — listening, mic on, he isn't speaking and no turn is running —
   * otherwise queued until it is. Barge-in cancels it like any reply. Returns false once closed.
   */
  announce: (text: string) => boolean;
  /**
   * Play the instant "I heard you" acknowledgement chime on demand — e.g. from a wake-word
   * detector, the moment it fires, so the owner gets confirmation before Jarvis has answered.
   * Same rules as the automatic end-of-speech chime: respects mute, the earcon setting, and
   * never plays over Jarvis's own voice.
   */
  chime: () => void;
};

/* ---------------------------------------------------------------------------------------- */
/* Pure helpers (unit tested)                                                                 */
/* ---------------------------------------------------------------------------------------- */

/** Encode mono PCM samples ([-1, 1], clipped) into a 16-bit WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // subchunk1 size (PCM)
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    const value = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    view.setInt16(offset, Math.round(value), true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/** Simple averaging decimator. Identity when the rates already match. */
export function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  if (toRate > fromRate) return input.slice();
  if (input.length === 0) return new Float32Array(0);
  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(newLength);
  let offset = 0;
  for (let i = 0; i < newLength; i++) {
    const nextOffset = Math.min(input.length, Math.round((i + 1) * ratio));
    let sum = 0,
      count = 0;
    for (let j = offset; j < nextOffset; j++) {
      sum += input[j];
      count++;
    }
    output[i] = count ? sum / count : 0;
    offset = Math.max(nextOffset, offset + 1);
  }
  return output;
}

export type VadConfig = {
  /** RMS above which a frame counts as speech. */
  startRms: number;
  /** RMS below which a frame counts as silence once speech is active. */
  stopRms: number;
  /** Sustained above-threshold time required before speech is confirmed. */
  startMs: number;
  /** Sustained below-threshold time required before confirmed speech ends. */
  silenceMs: number;
  /** Confirmed utterances shorter than this are discarded instead of ended. */
  minSpeechMs: number;
  /** Force-end an utterance after this much continuous speech. */
  maxSpeechMs: number;
  /** Multiplier applied to startRms when the assistant is speaking (barge-in guard). */
  bargeInRmsMultiplier: number;
  /** Sustained above-threshold time required to confirm a barge-in. */
  bargeInStartMs: number;
};
export type VadEvent = "idle" | "start" | "speech" | "end" | "discard";

const DEFAULT_VAD_CONFIG: VadConfig = {
  startRms: 0.02,
  stopRms: 0.012,
  startMs: 150,
  silenceMs: ENDPOINTING.minSilenceMs,
  minSpeechMs: 350,
  maxSpeechMs: 30000,
  bargeInRmsMultiplier: 2.5,
  bargeInStartMs: 250,
};

/** Pure RMS-energy VAD state machine. `assistantSpeaking` raises the bar for barge-in. */
export function createVad(overrides: Partial<VadConfig> = {}) {
  const config: VadConfig = { ...DEFAULT_VAD_CONFIG, ...overrides };
  let active = false;
  let aboveMs = 0;
  let belowMs = 0;
  // speechMs is the voiced-only duration (frozen once trailing silence starts); totalMs is the
  // full elapsed duration since onset (including any trailing silence), used for the hard cap.
  let speechMs = 0;
  let totalMs = 0;

  const reset = () => {
    active = false;
    aboveMs = 0;
    belowMs = 0;
    speechMs = 0;
    totalMs = 0;
  };

  const push = (rms: number, frameMs: number, assistantSpeaking = false): VadEvent => {
    const startThreshold = assistantSpeaking ? config.startRms * config.bargeInRmsMultiplier : config.startRms;
    const startDuration = assistantSpeaking ? config.bargeInStartMs : config.startMs;

    if (!active) {
      if (rms >= startThreshold) {
        aboveMs += frameMs;
        if (aboveMs >= startDuration) {
          active = true;
          speechMs = aboveMs;
          totalMs = aboveMs;
          aboveMs = 0;
          belowMs = 0;
          return "start";
        }
        return "idle";
      }
      aboveMs = 0;
      return "idle";
    }

    totalMs += frameMs;
    if (totalMs >= config.maxSpeechMs) {
      reset();
      return "end";
    }
    if (rms < config.stopRms) {
      belowMs += frameMs;
      if (belowMs >= config.silenceMs) {
        const longEnough = speechMs >= config.minSpeechMs;
        reset();
        return longEnough ? "end" : "discard";
      }
      return "speech";
    }
    belowMs = 0;
    speechMs += frameMs;
    return "speech";
  };

  return { push, reset, config };
}

const NOISE_PHRASES = new Set([
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching!",
  "you",
  "bye",
  "bye bye",
  "goodbye",
  "see you next time",
  "subscribe",
  "please subscribe",
  "",
]);

/** True for empty/silence-hallucination transcripts Whisper commonly emits on quiet audio. */
export function isNoiseTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[.!?,\-\s]+$/.test(trimmed)) return true;
  const stripped = trimmed
    .toLowerCase()
    .replace(/^[.!?,\-\s]+/, "")
    .replace(/[.!?,\-\s]+$/, "");
  return NOISE_PHRASES.has(stripped);
}

const ABBREVIATION_PATTERNS = [
  /\be\.g\./gi,
  /\bi\.e\./gi,
  /\bmr\./gi,
  /\bmrs\./gi,
  /\bms\./gi,
  /\bdr\./gi,
  /\bprof\./gi,
  /\bsr\./gi,
  /\bjr\./gi,
  /\bst\./gi,
  /\bvs\./gi,
  /\betc\./gi,
  /\bapprox\./gi,
  /\bvol\./gi,
  /\bfig\./gi,
  /\binc\./gi,
  /\bltd\./gi,
  /\bno\./gi,
];
const SENTINEL = "\u0000";

function protectAbbreviations(text: string): string {
  let out = text;
  for (const pattern of ABBREVIATION_PATTERNS) {
    out = out.replace(pattern, (match) => match.replace(/\./g, SENTINEL));
  }
  out = out.replace(/(\d)\.(\d)/g, (_m, a: string, b: string) => `${a}${SENTINEL}${b}`);
  return out;
}

function restoreAbbreviations(text: string): string {
  return text.split(SENTINEL).join(".");
}

function mergeShortFragments(parts: string[], minLength: number): string[] {
  const result = [...parts];
  let guard = 0;
  while (guard++ < 1000) {
    const shortIndex = result.findIndex((s) => s.length < minLength);
    if (shortIndex === -1 || result.length <= 1) break;
    if (shortIndex === 0) {
      result[1] = `${result[0]} ${result[1]}`.trim();
      result.splice(0, 1);
    } else {
      result[shortIndex - 1] = `${result[shortIndex - 1]} ${result[shortIndex]}`.trim();
      result.splice(shortIndex, 1);
    }
  }
  return result;
}

function hardWrap(sentence: string, maxLength: number): string[] {
  if (sentence.length <= maxLength) return [sentence];
  const parts: string[] = [];
  let remaining = sentence;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf(",", maxLength);
    if (cut < maxLength * 0.2) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.2) cut = maxLength - 1;
    parts.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/** Split text into speakable sentence chunks: punctuation/newline aware, abbreviation-safe. */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const protectedText = protectAbbreviations(trimmed);
  const rough = protectedText
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => restoreAbbreviations(s).trim())
    .filter(Boolean);
  const merged = mergeShortFragments(rough, 20);
  return merged.flatMap((s) => hardWrap(s, 300)).filter(Boolean);
}

/**
 * Pack sentences into as few speech requests as possible. Groq's free Orpheus voice
 * allows 100 requests a day, so a typical one-to-three sentence reply goes out as one
 * request rather than one per sentence.
 */
/**
 * Speech chunks when the first one can be streamed: the first sentence alone (it starts playing
 * while ElevenLabs is still producing it), then the rest packed as usual.
 */
export function chunksForStreaming(sentences: string[], maxChars = 280): string[] {
  if (sentences.length <= 1) return sentences;
  return [sentences[0], ...groupForSpeech(sentences.slice(1), maxChars)];
}

/**
 * Turns a stream of little-endian 16-bit PCM byte chunks into Float32 sample blocks of at least
 * `minSamples` (the last may be shorter), carrying an odd trailing byte across chunk boundaries.
 */
export function createPcmFramer(minSamples: number) {
  let carry: Uint8Array = new Uint8Array(0);
  let pending: Float32Array[] = [];
  let pendingSamples = 0;
  const take = () => {
    const out = new Float32Array(pendingSamples);
    let offset = 0;
    for (const block of pending) out.set(block, offset), (offset += block.length);
    pending = [];
    pendingSamples = 0;
    return out;
  };
  return {
    push(chunk: Uint8Array): Float32Array[] {
      const bytes = carry.length ? new Uint8Array(carry.length + chunk.length) : chunk;
      if (carry.length) bytes.set(carry), bytes.set(chunk, carry.length);
      const usable = bytes.length - (bytes.length % 2);
      carry = bytes.slice(usable);
      const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
      const samples = new Float32Array(usable / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      if (samples.length) pending.push(samples), (pendingSamples += samples.length);
      return pendingSamples >= minSamples ? [take()] : [];
    },
    flush(): Float32Array[] {
      return pendingSamples ? [take()] : [];
    },
  };
}

export function groupForSpeech(sentences: string[], maxChars = 280): string[] {
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + sentence.length <= maxChars) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}

/** Strip markdown decoration before sending text to TTS. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 6000;

function capContent(message: ChatMessage, maxChars: number): ChatMessage {
  if (typeof message.content === "string" && message.content.length > maxChars) {
    return { ...message, content: message.content.slice(0, maxChars) } as ChatMessage;
  }
  return message;
}

/** Keep the most recent messages, capping content length, without orphaning a tool result. */
export function trimHistory(
  messages: ChatMessage[],
  maxMessages: number = MAX_HISTORY_MESSAGES,
  maxMessageChars: number = MAX_MESSAGE_CHARS,
): ChatMessage[] {
  const capped = messages.map((m) => capContent(m, maxMessageChars));
  if (capped.length <= maxMessages) return capped;
  let start = capped.length - maxMessages;
  while (start > 0 && capped[start].role === "tool") start--;
  return capped.slice(start);
}

export const INTERRUPTED_TOOL_RESULT = "Interrupted before this finished; the outcome is unknown.";

/**
 * What is actually sent each turn. Chat-completions APIs reject an assistant tool call
 * without a result, which an interruption mid-tool leaves behind, so those get a
 * placeholder. And Groq's free tier allows 8,000 tokens a minute, so results from earlier
 * turns are cut short and only the recent conversation is kept.
 */
export function prepareHistory(
  messages: ChatMessage[],
  limits: { maxMessages?: number; olderToolChars?: number; recentToolChars?: number } = {},
): ChatMessage[] {
  const { maxMessages = 16, olderToolChars = 300, recentToolChars = 2000 } = limits;
  const repaired: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "tool") continue; // results are consumed with their call below
    repaired.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const ids = new Set(message.tool_calls.map((call) => call.id));
    const answered = new Set<string>();
    while (i + 1 < messages.length && messages[i + 1].role === "tool") {
      const result = messages[++i] as Extract<ChatMessage, { role: "tool" }>;
      if (ids.has(result.tool_call_id) && !answered.has(result.tool_call_id)) {
        answered.add(result.tool_call_id);
        repaired.push(result);
      }
    }
    for (const call of message.tool_calls)
      if (!answered.has(call.id))
        repaired.push({ role: "tool", tool_call_id: call.id, content: INTERRUPTED_TOOL_RESULT });
  }
  let lastUser = -1;
  repaired.forEach((m, index) => {
    if (m.role === "user") lastUser = index;
  });
  const budgeted = repaired.map((m, index) =>
    m.role === "tool"
      ? { ...m, content: (index < lastUser ? pageReadForModel(repaired, index) : m.content).slice(0, index < lastUser ? olderToolChars : recentToolChars) }
      : m,
  );
  return trimHistory(budgeted, maxMessages);
}

export type AnnounceGate = {
  phase: VoicePhase;
  micMuted: boolean;
  /** Confirmed speech is being recorded (he is talking). */
  userSpeaking: boolean;
  /** A turn (STT, model, tool or reply) is still in flight. */
  busy: boolean;
};

/** Jarvis may interject only into silence: never over him, mid-turn, or with the mic off. */
export function canAnnounce(gate: AnnounceGate): boolean {
  return gate.phase === "listening" && !gate.micMuted && !gate.userSpeaking && !gate.busy;
}

/**
 * Interjections waiting for a quiet moment. Small and short-lived: a line that couldn't be
 * said within `maxAgeMs` is dropped (the HUD still shows it), and a duplicate isn't queued twice.
 */
export function createAnnouncementQueue(options: { max?: number; maxAgeMs?: number; now?: () => number } = {}) {
  const max = options.max ?? 3;
  const maxAgeMs = options.maxAgeMs ?? 120_000;
  const now = options.now ?? Date.now;
  let items: { text: string; at: number }[] = [];
  const fresh = () => {
    const at = now();
    items = items.filter((item) => at - item.at <= maxAgeMs);
  };
  return {
    push(text: string) {
      const line = text.trim().slice(0, 600);
      if (!line) return false;
      fresh();
      if (items.some((item) => item.text === line)) return false;
      items.push({ text: line, at: now() });
      while (items.length > max) items.shift();
      return true;
    },
    /** The next line to say, if the gate allows speaking now. */
    take(gate: AnnounceGate): string | null {
      fresh();
      if (!items.length || !canAnnounce(gate)) return null;
      return items.shift()!.text;
    },
    get size() {
      fresh();
      return items.length;
    },
    clear() {
      items = [];
    },
  };
}

/**
 * Rotates through a small pool of phrase variants without repeating the immediately previous
 * pick, so routine acknowledgements ("On it.", "Right away.") don't feel like a recording on
 * loop. `random` is injectable for deterministic tests; defaults to `Math.random`.
 */
export function createPhraseRotator(phrases: string[], random: () => number = Math.random): () => string {
  if (!phrases.length) throw new Error("createPhraseRotator needs at least one phrase.");
  let last = -1;
  return () => {
    if (phrases.length === 1) return phrases[0];
    let index = Math.floor(random() * phrases.length) % phrases.length;
    if (index === last) index = (index + 1) % phrases.length;
    last = index;
    return phrases[index];
  };
}

/**
 * The client's own fixed lines, in the film J.A.R.V.I.S.'s voice: short, calm, dry; a little wit
 * in a minority of them, and "sir" only now and then. Tool results are untouched.
 */
export const GREETING_PHRASES = ["Sir.", "At your service.", "Go ahead.", "Listening.", "What are we doing?"];
export const ACKNOWLEDGE_PHRASES = ["On it.", "Right away.", "One moment.", "Working on it.", "Leave it with me."];
export const VOICE_UNAVAILABLE_PHRASES = ["My voice has dropped out; the text still works.", "I've lost my voice for the moment.", "No voice just now, I'm afraid. Text is fine."];
export const THINKING_FAILED_PHRASES = ["That one got away from me. Try again?", "Lost the thread there. Once more?", "My fault. Say that again?"];
export const MISHEARD_PHRASES = ["Didn't catch that.", "Once more?", "Say again, sir?"];
/** When a turn runs out of steps. */
export const TOO_MANY_STEPS = "That needed more steps than I can take in one go. Give it to me in smaller pieces.";

/**
 * "Sir" now and then, not in every line: keeps it in at most one reply in `every` (the first one
 * counts) and drops it from the rest ("Done, sir." → "Done."). Deterministic, so tests can pin it.
 */
export function createSirLimiter(every = 3) {
  let count = 0;
  return (text: string) => {
    if (!/\bsir\b/i.test(text)) return text;
    const keep = count++ % every === 0;
    if (keep) return text;
    return (
      text
        // "Lisbon, sir." → "Lisbon."
        .replace(/,\s*sir(?=[.!?,;:]|$)/gi, "")
        // "Sir, which one?" / "Done. Sir, anything else?" → "Which one?" / "Done. Anything else?"
        .replace(/(^|[.!?]\s+)sir[,.!]?\s+(\p{L})/giu, (_m, lead: string, c: string) => lead + c.toUpperCase())
        // A lone "Sir." tacked on the end: "Shukriya. Sir." → "Shukriya."
        .replace(/([.!?])\s+sir[.!?]*\s*$/i, "$1")
        // "Right away sir." → "Right away."
        .replace(/\s+sir(?=[.!?])/gi, "")
        .trim()
    );
  };
}

/** Very short, deliberate interruption cues — never a real multi-word command ("stop the timer"
 * still goes to the brain). Matched only after trimming/lowercasing/dropping end punctuation. */
const STOP_PHRASES = new Set([
  "stop",
  "stop please",
  "please stop",
  "wait",
  "wait wait",
  "hold on",
  "hang on",
  "quiet",
  "shush",
  "that's enough",
  "thats enough",
  "enough",
  "never mind",
  "nevermind",
  "cancel",
  "cancel that",
]);

/** True for a short, deliberate interruption ("stop", "wait", "that's enough") — never a
 * longer real command that merely starts with one of those words. */
export function isStopPhrase(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .trim()
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ");
  return STOP_PHRASES.has(normalized);
}

function normalizeForOverlap(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalised token overlap (Sørensen–Dice) between two strings, in [0, 1]. */
export function tokenOverlapRatio(a: string, b: string): number {
  const tokensA = normalizeForOverlap(a);
  const tokensB = normalizeForOverlap(b);
  if (!tokensA.length || !tokensB.length) return 0;
  const remaining = new Map<string, number>();
  for (const token of tokensB) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let matched = 0;
  for (const token of tokensA) {
    const count = remaining.get(token) ?? 0;
    if (count > 0) {
      matched++;
      remaining.set(token, count - 1);
    }
  }
  return (2 * matched) / (tokensA.length + tokensB.length);
}

export type EchoCheck = {
  /** What the STT just returned. */
  transcript: string;
  /** The full text of the line Jarvis most recently spoke (or is speaking). */
  ttsText: string;
  /** Jarvis is speaking right now. */
  ttsActive: boolean;
  /** Milliseconds since Jarvis finished speaking (ignored while `ttsActive`). */
  msSinceTtsEnded: number;
  /** How long after he stops speaking his own voice can still be mistaken for an echo. */
  windowMs?: number;
  /** Normalised token-overlap ratio at/above which a transcript counts as an echo. */
  threshold?: number;
};

/**
 * True when a heard transcript is very likely Jarvis's own voice bleeding back through open
 * speakers rather than something he said — so the turn is dropped instead of answering itself.
 * A short, deliberate interruption ("stop", "wait") is never treated as an echo, so barge-in
 * keeps working even when it happens to share a word with his own line.
 */
export function isLikelyTtsEcho(check: EchoCheck): boolean {
  const { transcript, ttsText, ttsActive, msSinceTtsEnded, windowMs = 4000, threshold = 0.6 } = check;
  if (!transcript.trim() || !ttsText.trim()) return false;
  if (isStopPhrase(transcript)) return false;
  if (!ttsActive && msSinceTtsEnded > windowMs) return false;
  return tokenOverlapRatio(transcript, ttsText) >= threshold;
}

/* ---------------------------------------------------------------------------------------- */
/* Browser plumbing (not covered by unit tests — no browser APIs there)                      */
/* ---------------------------------------------------------------------------------------- */

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._buffered = 0;
    this._chunkSamples = Math.max(1, Math.round(sampleRate * 0.02));
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const channel = input[0];
      this._chunks.push(channel.slice());
      this._buffered += channel.length;
      if (this._buffered >= this._chunkSamples) {
        const merged = new Float32Array(this._buffered);
        let offset = 0;
        for (const chunk of this._chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this.port.postMessage({ samples: merged, sampleRate: sampleRate }, [merged.buffer]);
        this._chunks = [];
        this._buffered = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

function encodeBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type EarlyAction = { id: number; name: string; args: Record<string, unknown>; partial: string; result: string };

export async function startFreeVoice(options: FreeVoiceOptions): Promise<FreeVoiceCall> {
  const { signal } = options;
  signal.throwIfAborted();
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Microphone access requires localhost or HTTPS in a supported browser.");

  const slowTools = new Set(options.slowTools ?? []);
  const pickGreeting = createPhraseRotator(GREETING_PHRASES);
  const pickAcknowledge = createPhraseRotator(ACKNOWLEDGE_PHRASES);
  const pickVoiceUnavailable = createPhraseRotator(VOICE_UNAVAILABLE_PHRASES);
  const pickThinkingFailed = createPhraseRotator(THINKING_FAILED_PHRASES);
  const pickMisheard = createPhraseRotator(MISHEARD_PHRASES);
  const sparingSir = createSirLimiter();

  let closed = false;
  let micMuted = false;
  let phase: VoicePhase = "listening";
  let generation = 0;
  let turnController: AbortController | null = null;
  // Turn-taking (src/lib/voice-turns.ts): how long to wait, what is still undecided, what is running.
  const endpoint: EndpointConfig = { ...ENDPOINTING, ...options.endpointing };
  const falseInterruptionMs = options.falseInterruptionMs ?? FALSE_INTERRUPTION_MS;
  const duplicates = createDuplicateGuard();
  /** turn()/tool calls of the current turn still awaited: "a task is running". Reset when a turn is superseded. */
  let inFlight = 0;
  let speechToken = 0;
  /** Aborts every queued/in-flight TTS fetch of the speech being said; replaced whenever speech is stopped. */
  let speechAbort = new AbortController();
  /** Jarvis's playback is held (speech over him, not yet known to be words). */
  let paused: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let stopQuestionAt = 0;
  let utteranceSeq = 0;
  let holdWake: (() => void) | null = null;
  /** The newest utterance not yet handed to the brain: a continuation merges into it instead of replacing it. */
  let pending: { seq: number; chunks: Float32Array[]; endAt: number; submitted: boolean; controller: AbortController; speakingAtOnset: boolean; early: EarlyAction | null } | null = null;
  let utteranceSpeakingAtOnset = false;
  let history: ChatMessage[] = [];
  const context: string[] = [];

  let workletUrl: string | undefined;
  let workletNode: AudioWorkletNode | undefined;
  let outputGain: GainNode | undefined;
  let inputMeter: AnalyserNode | undefined;
  let outputMeter: AnalyserNode | undefined;
  let activeSource: AudioBufferSourceNode | undefined;
  /** Blocks of a streamed sentence scheduled on the playback clock (see playPcmStream). */
  const streamSources = new Set<AudioBufferSourceNode>();
  let pendingStop: (() => void) | undefined;

  const preroll: Float32Array[] = [];
  const PREROLL_SAMPLES = (16000 * 300) / 1000;
  let prerollSamples = 0;
  let recording = false;
  let interrupted = false;
  let voicedSamples = 0;
  let utteranceChunks: Float32Array[] = [];

  const vad = createVad({ silenceMs: endpoint.minSilenceMs });

  // "Act while I speak": one speculative show-only action per utterance, from partials.
  let utteranceId = 0;
  // The utterance the final turn has taken over; a late reflex answer for it is dropped.
  let consumedId = 0;
  // Event identity of the current turn (Open Dot V): the same utterance's early and final calls, or a replay after a reconnect, share it,
  // so the command service runs the command once. A typed turn gets its own key; the same words typed again later are a new command.
  const eventNonce = Math.random().toString(36).slice(2, 8);
  let typedTurns = 0;
  let turnEventKey = "u0";
  /** jarvis_command carries its event id; every other tool is untouched. */
  const withEventId = (name: string, args: Record<string, unknown>, key: string) => (name === "jarvis_command" ? { ...args, eventId: utteranceEventId(eventNonce, key, name, args) } : args);
  let speculated: EarlyAction | null = null;
  let partialText = "";
  let partialTimer: ReturnType<typeof setTimeout> | undefined;
  let reflexController: AbortController | null = null;
  let recognition: { start: () => void; stop: () => void; onresult: unknown; onend: unknown; onerror: unknown } | undefined;
  let resultsSeen = 0;
  let resultStart = 0;

  // TTS-echo suppression: what Jarvis most recently said (or is saying), and when he last
  // stopped, so a transcript that fuzzy-matches his own voice bleeding through open speakers
  // can be dropped instead of answered. See isLikelyTtsEcho().
  let lastTtsText = "";
  let ttsActive = false;
  let ttsEndedAt = 0;

  // Proactive interjections wait here for a quiet moment (see announce()).
  const announcements = createAnnouncementQueue();
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  let pumpAnnouncements: () => void = () => {};
  const scheduleAnnouncements = (delayMs = 900) => {
    if (closed || !announcements.size) return;
    if (announceTimer) clearTimeout(announceTimer);
    // A short pause after his last word or Jarvis's last reply, so it never feels like a
    // barge-in of its own.
    announceTimer = setTimeout(() => pumpAnnouncements(), delayMs);
  };

  const setPhase = (next: VoicePhase) => {
    if (closed) return;
    // While his playback is held for a possible interruption he is not "speaking": the orb and the barge-in bar stay down.
    if (paused && next === "speaking") return;
    phase = next;
    options.onPhase(next);
    if (next === "listening") scheduleAnnouncements();
  };

  const stopPlayback = () => {
    for (const source of streamSources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    streamSources.clear();
    if (activeSource) {
      try {
        activeSource.onended = null;
        activeSource.stop();
      } catch {
        /* already stopped */
      }
      activeSource = undefined;
    }
    if (pendingStop) {
      const resolve = pendingStop;
      pendingStop = undefined;
      resolve();
    }
  };

  /** Freezes / releases the playback clock, so held speech continues exactly where it stopped. */
  const holdAudio = (hold: boolean) => {
    try {
      const done = hold ? playbackContext.suspend() : playbackContext.resume();
      void Promise.resolve(done).catch(() => undefined);
    } catch {
      /* a context without suspend/resume: the pause simply doesn't freeze the clock */
    }
  };

  /** Stops what Jarvis is saying and cancels every queued TTS chunk and fetch. Never touches a running task. */
  const stopSpeech = () => {
    speechToken++;
    speechAbort.abort();
    speechAbort = new AbortController();
    stopPlayback();
    clearPause();
    ttsActive = false;
    ttsEndedAt = Date.now();
  };

  /** Drops the pause without resuming the clock while sources still exist: callers have already stopped them. */
  const clearPause = () => {
    if (!paused) return;
    clearTimeout(paused.timer);
    paused = null;
    holdAudio(false);
  };

  /** Speech over Jarvis: hold his playback at once; the words (or a noise) decide whether it resumes. */
  const pauseSpeech = () => {
    if (closed || paused || phase !== "speaking") return;
    const timer = setTimeout(() => {
      if (!paused) return;
      // Still talking after the window: it is a real interruption. Nothing heard: resume (cf. LiveKit's resume_false_interruption).
      if (recording) confirmInterruption();
      else resumeSpeech();
    }, falseInterruptionMs);
    paused = { at: Date.now(), timer };
    holdAudio(true);
    setPhase("listening");
  };

  const resumeSpeech = () => {
    if (!paused) return;
    clearTimeout(paused.timer);
    paused = null;
    holdAudio(false);
    if (ttsActive) setPhase("speaking");
  };

  const settle = () => {
    if (paused) return;
    setPhase(inFlight > 0 ? "thinking" : ttsActive ? "speaking" : "listening");
  };

  /** Confirmed speech over him (or over a pause): cancel what he was saying. The task, if any, keeps running. */
  const confirmInterruption = () => {
    if (!paused && phase !== "speaking") return;
    stopSpeech();
    options.onCaption("");
    settle();
  };

  const invalidateCurrentTurn = () => {
    generation++;
    inFlight = 0;
    turnController?.abort();
    reflexController?.abort();
    turnController = null;
    stopSpeech();
  };

  const acquireMic = () =>
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  let microphone: MediaStream | undefined;
  microphone = await acquireMic();
  if (closed || signal.aborted) {
    microphone.getTracks().forEach((t) => t.stop());
    signal.throwIfAborted();
    throw new Error("Voice connection stopped.");
  }

  const captureContext = new AudioContext();
  const playbackContext = new AudioContext();
  outputGain = playbackContext.createGain();
  outputMeter = playbackContext.createAnalyser();
  outputMeter.fftSize = 256;
  outputGain.connect(outputMeter);
  outputGain.connect(playbackContext.destination);

  let micSource = captureContext.createMediaStreamSource(microphone);
  inputMeter = captureContext.createAnalyser();
  inputMeter.fftSize = 256;
  micSource.connect(inputMeter);

  // Device change or a permission blip: the track ends (or stays muted); re-acquire it and rewire
  // the capture graph. The session, history and any running task are untouched.
  let muteTimer: ReturnType<typeof setTimeout> | undefined;
  let resetCapture: () => void = () => {};
  const mic = createMicReconnector<MediaStream>({
    acquire: acquireMic,
    isClosed: () => closed,
    delays: options.micReconnectDelays,
    onStatus: (status) => {
      options.onMicStatus?.(status);
      if (status === "failed") options.onError("The microphone isn't available. Check it is connected and allowed, then start Jarvis again.");
    },
    onStream: (stream) => {
      const old = microphone;
      microphone = stream;
      try {
        micSource.disconnect();
      } catch {
        /* a source that never connected */
      }
      for (const track of old?.getTracks() ?? []) {
        track.onended = null;
        track.stop();
      }
      micSource = captureContext.createMediaStreamSource(stream);
      micSource.connect(inputMeter!);
      if (workletNode) micSource.connect(workletNode);
      stream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
      resetCapture();
      watchMic(stream);
    },
  });
  const reconnectMic = () => {
    if (closed || mic.busy) return;
    resetCapture();
    void mic.lost();
  };
  function watchMic(stream: MediaStream) {
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (stream === microphone) reconnectMic();
      };
      track.onmute = () => {
        clearTimeout(muteTimer);
        muteTimer = setTimeout(() => {
          if (stream === microphone) reconnectMic();
        }, 3000);
      };
      track.onunmute = () => clearTimeout(muteTimer);
    }
  }
  const onDeviceChange = () => {
    if (microphone?.getAudioTracks().some((t) => t.readyState === "ended")) reconnectMic();
  };
  watchMic(microphone);
  navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);

  const end = async () => {
    if (closed) return;
    closed = true;
    generation++;
    turnController?.abort();
    reflexController?.abort();
    announcements.clear();
    if (announceTimer) clearTimeout(announceTimer);
    if (partialTimer) clearTimeout(partialTimer);
    clearTimeout(muteTimer);
    if (paused) clearTimeout(paused.timer);
    pending?.controller.abort();
    holdWake?.();
    navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    if (recognition) {
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    }
    stopSpeech();
    try {
      workletNode?.port.close();
    } catch {
      /* ignore */
    }
    microphone?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    if (workletUrl) URL.revokeObjectURL(workletUrl);
    await Promise.allSettled([captureContext.close(), playbackContext.close()]);
    options.onDisconnect();
  };
  signal.addEventListener("abort", () => void end(), { once: true });

  try {
    const workletBlob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    workletUrl = URL.createObjectURL(workletBlob);
    await captureContext.audioWorklet.addModule(workletUrl);
    signal.throwIfAborted();
    if (closed) throw new Error("Voice connection stopped.");

    workletNode = new AudioWorkletNode(captureContext, "capture-processor");
    micSource.connect(workletNode);
    const silentGain = captureContext.createGain();
    silentGain.gain.value = 0;
    workletNode.connect(silentGain);
    silentGain.connect(captureContext.destination);

    const readVolume = (node?: AnalyserNode) => {
      if (!node || closed) return 0;
      const values = new Uint8Array(node.fftSize);
      node.getByteTimeDomainData(values);
      const sumSquares = values.reduce((n, v) => n + Math.pow((v - 128) / 128, 2), 0);
      return Math.min(1, Math.sqrt(sumSquares / values.length) * 4);
    };

    const playBuffer = (buffer: AudioBuffer): Promise<void> =>
      new Promise((resolve) => {
        stopPlayback();
        const source = playbackContext.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = validPersonality({ speed: options.speechSpeed?.() }).speed;
        source.connect(outputGain!);
        activeSource = source;
        pendingStop = resolve;
        source.onended = () => {
          if (activeSource === source) activeSource = undefined;
          if (pendingStop === resolve) pendingStop = undefined;
          resolve();
        };
        source.start();
      });

    /**
     * Plays streamed PCM as it arrives: blocks of ~120 ms are scheduled back to back on the
     * playback clock. Resolves true once everything played (or he interrupted after it began),
     * false if nothing could be played, so the caller falls back to the whole-clip voice.
     */
    const playPcmStream = async (stream: ReadableStream<Uint8Array>, sampleRate: number, current: () => boolean): Promise<boolean> => {
      stopPlayback();
      const framer = createPcmFramer(Math.round(sampleRate * 0.12));
      const reader = stream.getReader();
      let at = 0;
      let last: AudioBufferSourceNode | undefined;
      const schedule = (samples: Float32Array) => {
        const buffer = playbackContext.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
        const source = playbackContext.createBufferSource();
        source.buffer = buffer;
        const speed = validPersonality({ speed: options.speechSpeed?.() }).speed;
        source.playbackRate.value = speed;
        source.connect(outputGain!);
        at = Math.max(at, playbackContext.currentTime + 0.03);
        source.start(at);
        at += buffer.duration / speed;
        streamSources.add(source);
        source.onended = () => streamSources.delete(source);
        if (!last) setPhase("speaking");
        last = source;
      };
      try {
        for (;;) {
          if (!current()) {
            void reader.cancel().catch(() => undefined);
            return !!last;
          }
          const { value, done } = await reader.read();
          if (done) break;
          for (const block of framer.push(value)) schedule(block);
        }
        for (const block of framer.flush()) schedule(block);
      } catch {
        if (!last) return false;
      }
      const final = last;
      if (!final || !current()) return !!final;
      await new Promise<void>((resolve) => {
        pendingStop = resolve;
        final.onended = () => {
          streamSources.delete(final);
          if (pendingStop === resolve) pendingStop = undefined;
          resolve();
        };
      });
      return true;
    };

    // Each speak() call takes a token; a newer one (e.g. the answer after "On it.")
    // supersedes it, and only the current speaker may change the phase. Otherwise the
    // acknowledgement finishing mid-answer would flip the phase and lower the barge-in bar
    // while Jarvis is still talking.
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const confirmSamples = (16000 * INTERRUPT_CONFIRM_MS) / 1000;
    /** Confirmed speech of his is in progress: a reply waits for him rather than talking over him. */
    const userTalking = () => recording && voicedSamples >= confirmSamples;
    const speak = async (
      text: string,
      turnSignal: AbortSignal,
      myGeneration: number,
      endPhase: VoicePhase = "listening",
    ) => {
      if (closed) return;
      const mine = ++speechToken;
      const speechSignal = speechAbort.signal;
      const fetchSignal = AbortSignal.any([turnSignal, speechSignal]);
      const current = () => mine === speechToken && myGeneration === generation && !closed && !turnSignal.aborted && !speechSignal.aborted;
      const split = splitSentences(stripMarkdownForSpeech(text));
      // With a streaming voice the first sentence goes alone and starts playing as it arrives.
      const sentences = options.ttsStream ? chunksForStreaming(split) : groupForSpeech(split);
      if (!sentences.length) return;
      for (let waited = 0; userTalking() && current() && waited < 8000; waited += 40) await sleep(40);
      if (!current()) return;
      // Tracked for TTS-echo suppression (isLikelyTtsEcho): what he's about to say, and that
      // he's saying it now. A newer speak() call (e.g. the real answer superseding "On it.")
      // naturally overwrites this with the more current line.
      lastTtsText = text;
      ttsActive = true;
      const fetches: Array<Promise<{ audio: string; mime: string }>> = [];
      const fetchAt = (i: number) => {
        if (!fetches[i]) {
          fetches[i] = options.tts(sentences[i], fetchSignal);
          fetches[i].catch(() => undefined); // awaited later, or dropped if he interrupts
        }
        return fetches[i];
      };
      try {
        let start = 0;
        if (options.ttsStream) {
          if (sentences.length > 1) fetchAt(1); // the rest is fetched while sentence one plays
          const live = await options.ttsStream(sentences[0], fetchSignal).catch(() => null);
          if (!current()) return;
          if (live && (await playPcmStream(live.stream, live.sampleRate, current).catch(() => false))) start = 1;
          if (!current()) return;
        }
        for (let i = start; i < sentences.length; i++) {
          if (!current()) return;
          let result: { audio: string; mime: string };
          try {
            result = await fetchAt(i);
          } catch (error) {
            if (current()) {
              options.onError((error as Error)?.message || pickVoiceUnavailable());
              setPhase("listening");
            }
            return;
          }
          if (!current()) return;
          if (i + 1 < sentences.length) fetchAt(i + 1);
          let buffer: AudioBuffer;
          try {
            const bytes = base64ToBytes(result.audio);
            buffer = await playbackContext.decodeAudioData(bytes.buffer as ArrayBuffer);
          } catch {
            continue;
          }
          if (!current()) return;
          setPhase("speaking");
          await playBuffer(buffer);
        }
        if (current()) setPhase(endPhase);
      } finally {
        // Only the still-current speaker clears the echo window; a superseded call (the ack
        // pre-empted by the real answer) must not stomp the newer one's active/ended state.
        if (mine === speechToken) {
          ttsActive = false;
          ttsEndedAt = Date.now();
        }
      }
    };

    /** Counts one awaited piece of this turn's work ("a task is running") for as long as this turn is current. */
    const working = async <T,>(myGeneration: number, run: () => Promise<T>): Promise<T> => {
      if (myGeneration === generation) inFlight++;
      try {
        return await run();
      } finally {
        if (myGeneration === generation && inFlight > 0) inFlight--;
      }
    };

    const runModelLoop = async (controller: AbortController, myGeneration: number, speechEndAt: number, onFail?: () => void) => {
      let rounds = 0;
      let acknowledged = false;
      // Latency instrumentation only (scripts/voice-latency.ts): the route and the first action's
      // start/end, logged once per command. Never gates or slows anything below.
      const commandId = newLatencyId(speechEndAt);
      const eventKey = turnEventKey;
      let routeDecidedAt: number | null = null;
      let route: string | null = null;
      let latencyLogged = false;
      for (;;) {
        if (myGeneration !== generation || closed) return;
        let result: { content: string | null; tool_calls?: ToolCall[]; model?: string };
        try {
          result = await working(myGeneration, () => options.turn(prepareHistory(history), context, controller.signal));
        } catch (error) {
          if (myGeneration !== generation || closed) return;
          if ((error as { name?: string })?.name === "AbortError") return;
          onFail?.();
          options.onError((error as Error)?.message || pickThinkingFailed());
          setPhase("listening");
          return;
        }
        if (myGeneration !== generation || closed) return;
        if (routeDecidedAt === null) {
          routeDecidedAt = Date.now();
          route = typeof result.model === "string" && result.model ? result.model : "rules";
        }

        if (result.tool_calls && result.tool_calls.length) {
          rounds++;
          history.push({
            role: "assistant",
            content: result.content ?? null,
            tool_calls: result.tool_calls,
          });
          if (rounds > 6) {
            const fallback = TOO_MANY_STEPS;
            options.onMessage("assistant", fallback);
            history.push({ role: "assistant", content: fallback });
            await speak(fallback, controller.signal, myGeneration);
            return;
          }
          const pause = await runVoiceToolBatch(result.tool_calls, async (call) => {
            if (myGeneration !== generation || closed) throw new DOMException("Stopped", "AbortError");
            let args: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(call.function.arguments || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                args = parsed as Record<string, unknown>;
            } catch {
              args = {};
            }
            if (slowTools.has(call.function.name) && !acknowledged) {
              acknowledged = true;
              void speak(pickAcknowledge(), controller.signal, myGeneration, "thinking").catch(() => {});
            }
            let toolResult: string;
            // Latency instrumentation: the first tool this command runs, whichever round it's in.
            const actionStartedAt = !latencyLogged ? Date.now() : null;
            try {
              const say = (line: string) => {
                if (myGeneration === generation && !closed && !controller.signal.aborted) void speak(line, controller.signal, myGeneration, "thinking").catch(() => {});
              };
              toolResult = await working(myGeneration, () => options.onTool(call.function.name, withEventId(call.function.name, args, eventKey), controller.signal, say));
            } catch {
              toolResult =
                "This action could not finish. Ask the user to try again. Do not claim it happened.";
            }
            if (actionStartedAt !== null && !latencyLogged) {
              latencyLogged = true;
              options.onLatency?.({ id: commandId, route: route ?? "rules", speechEndAt, routeDecidedAt: routeDecidedAt ?? actionStartedAt, actionStartedAt, actionDoneAt: Date.now() });
            }
            if (myGeneration !== generation || closed) throw new DOMException("Stopped", "AbortError");
            return toolResult;
          }, (id, content) => history.push({ role: "tool", tool_call_id: id, content: content.slice(0, 4000) }));
          if (pause !== null) {
            options.onMessage("assistant", pause);
            history.push({ role: "assistant", content: pause });
            await speak(pause, controller.signal, myGeneration);
            setPhase("listening");
            return;
          }
          continue;
        }

        const content = sparingSir(result.content ?? "");
        if (content) {
          options.onMessage("assistant", content);
          // A page read aloud is spoken and shown, but history keeps only its neutral line (src/lib/page-read.ts).
          history.push({ role: "assistant", content: neutralisePageReads(history, content) });
          await speak(content, controller.signal, myGeneration);
        } else {
          setPhase("listening");
        }
        return;
      }
    };

    // Instant "I heard you" acknowledgement: fires the moment the VAD confirms end of speech
    // (and can be called again for a wake-word trigger — see the exported FreeVoiceCall.chime
    // hook), so the owner hears something within ~50ms while STT/the brain do the slow work.
    // Never chimes over Jarvis's own voice, respects mute (routed through outputGain) and the
    // localStorage "jarvis:earcon" off switch.
    const playAcknowledgeChime = () => {
      if (closed || micMuted || phase === "speaking" || paused || !outputGain) return;
      if (!isEarconEnabled()) return;
      try {
        playAcknowledgeEarcon(playbackContext as unknown as EarconAudioContext, outputGain);
      } catch {
        /* best-effort: never let the chime break the turn */
      }
    };

    /** A short line of his own (a stop confirmation, the stop question): spoken and shown, never a turn, never in the model's history. */
    const sayLine = (line: string) => {
      if (closed) return;
      options.onMessage("assistant", line);
      void speak(line, speechAbort.signal, generation).catch(() => {});
    };

    /** "Stop that task": the existing cancel path. Aborting the turn aborts its tool signal, which cancels the command job. */
    const cancelTask = () => {
      invalidateCurrentTurn();
      options.onCaption("");
      setPhase("listening");
      sayLine("Stopped.");
    };

    const handleUtterance = async (
      chunks: Float32Array[],
      speechEndAt: number = Date.now(),
      speakingAtOnset = false,
      inheritedEarly: EarlyAction | null = null,
    ) => {
      if (closed) return;
      // Whatever ran early for this utterance travels with it; later partials can't add more.
      if (partialTimer) clearTimeout(partialTimer);
      reflexController?.abort();
      consumedId = utteranceId;
      turnEventKey = `u${consumedId}`;
      const early = speculated ?? inheritedEarly;
      speculated = null;
      const totalLength = chunks.reduce((n, c) => n + c.length, 0);
      if (totalLength === 0) return;
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const wavBase64 = encodeBase64(encodeWav(merged, 16000));

      // Nothing of the running turn is touched until these words are known to be a real new request:
      // a cough, an echo, "stop" or a continuation of this very sentence must not kill a task or a reply.
      const seq = ++utteranceSeq;
      const sttGeneration = generation;
      const sttController = new AbortController();
      const entry = { seq, chunks, endAt: speechEndAt, submitted: false, controller: sttController, speakingAtOnset, early };
      pending = entry;
      const stale = () => closed || seq !== utteranceSeq || sttGeneration !== generation;
      const release = () => {
        if (pending === entry) pending = null;
      };
      if (!paused) setPhase("thinking");
      let text = "";
      try {
        text = await options.stt(wavBase64, sttController.signal);
        if (stale()) return;
        if (!text || isNoiseTranscript(text)) {
          // Noise that briefly held his voice: he carries on where he stopped.
          release();
          resumeSpeech();
          settle();
          return;
        }
        if (stopQuestionAt && Date.now() - stopQuestionAt <= STOP_QUESTION_TTL_MS) {
          const answer = answerStopQuestion(text);
          stopQuestionAt = 0;
          if (answer) {
            release();
            options.onCaption("");
            if (answer === "yes") cancelTask();
            else {
              resumeSpeech();
              settle();
            }
            return;
          }
        }
        const stop = classifyStop(text, { speaking: speakingAtOnset || paused !== null, taskRunning: inFlight > 0 });
        if (stop.kind !== "none") {
          // A deliberate stop never becomes a request to the brain. What it stops depends on what is going on.
          release();
          options.onCaption("");
          if (stop.kind === "stop-speech") {
            stopSpeech();
            settle();
          } else if (stop.kind === "stop-task") cancelTask();
          else if (stop.kind === "ambiguous") {
            stopSpeech();
            stopQuestionAt = Date.now();
            settle();
            sayLine(STOP_TASK_QUESTION);
          } else if (stop.kind === "no-task" || (stop.kind === "nothing" && options.hasBackgroundWork?.())) {
            stopSpeech();
            settle();
            if (options.backgroundStop) {
              const generationAtStop = generation;
              void options.backgroundStop(text, speechAbort.signal).then((line) => {
                if (generationAtStop !== generation) return;
                if (line) sayLine(line);
                else if (stop.kind === "no-task") sayLine("Nothing is running.");
              }).catch(() => {
                if (stop.kind === "no-task") sayLine("Nothing is running.");
              });
            } else if (stop.kind === "no-task") sayLine("Nothing is running.");
          } else {
            resumeSpeech();
            settle();
          }
          return;
        }
        if (isLikelyTtsEcho({ transcript: text, ttsText: lastTtsText, ttsActive, msSinceTtsEnded: Date.now() - ttsEndedAt })) {
          // Almost certainly Jarvis's own voice bleeding back through open speakers: drop it, and let him finish.
          release();
          resumeSpeech();
          settle();
          return;
        }
        // Adaptive endpointing: a trailing filler or a dangling "and" means he has not finished.
        const hold = remainingHoldMs(text, Date.now() - speechEndAt, endpoint);
        if (hold > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, hold);
            holdWake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          holdWake = null;
          if (stale()) return;
        }
        // He started again: his next utterance decides (it merges into this one, or was only a blip).
        while (recording && !stale()) await sleep(30);
        if (stale()) return;
        entry.submitted = true;
        release();
        if (!duplicates.accept(text)) {
          // The same words again within the window: one command, not two.
          options.onCaption("");
          resumeSpeech();
          settle();
          return;
        }
      } catch (error) {
        if (stale()) return;
        if ((error as { name?: string })?.name !== "AbortError") {
          release();
          resumeSpeech();
          options.onError((error as Error)?.message || pickMisheard());
          setPhase("listening");
        }
        return;
      }

      // A real new request: it supersedes whatever was running or being said.
      invalidateCurrentTurn();
      const myGeneration = generation;
      const controller = new AbortController();
      turnController = controller;
      setPhase("thinking");
      try {
        options.onMessage("user", text);
        history.push({ role: "user", content: text.slice(0, MAX_MESSAGE_CHARS) });
        if (early && partialStillHolds(early.partial, text)) {
          // Already done while he spoke: record it as this turn's tool call so the brain only
          // confirms, and nothing runs twice.
          const id = `early_${early.id}_${Date.now().toString(36)}`;
          history.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: early.name, arguments: JSON.stringify(early.args) } }] });
          history.push({ role: "tool", tool_call_id: id, content: early.result.slice(0, 4000) });
          const pause = screenResultPause(early.name, early.result);
          if (pause !== null) {
            options.onMessage("assistant", pause);
            history.push({ role: "assistant", content: pause });
            await speak(pause, controller.signal, myGeneration);
            setPhase("listening");
            return;
          }
        } else if (early) {
          context.push(`Before he finished, Jarvis already ran ${early.name} ${JSON.stringify(early.args)} from the partial "${early.partial.slice(0, 120)}". His full request differs: do what he actually asked, and don't repeat that action unless he asked for it.`);
          while (context.length > 8) context.shift();
        }
        await runModelLoop(controller, myGeneration, speechEndAt, () => duplicates.forget(text));
      } catch (error) {
        if (myGeneration !== generation || closed) return;
        if ((error as { name?: string })?.name !== "AbortError") {
          duplicates.forget(text);
          options.onError((error as Error)?.message || pickMisheard());
          setPhase("listening");
        }
      } finally {
        if (turnController === controller) turnController = null;
      }
    };

    resetCapture = () => {
      recording = false;
      interrupted = false;
      voicedSamples = 0;
      utteranceChunks = [];
      preroll.length = 0;
      prerollSamples = 0;
      vad.reset();
      if (partialTimer) clearTimeout(partialTimer);
      reflexController?.abort();
      consumedId = utteranceId;
      partialText = "";
    };

    const handleCaptureFrame = (rawSamples: Float32Array, nativeRate: number) => {
      const down = nativeRate > 16000 ? downsample(rawSamples, nativeRate, 16000) : rawSamples;
      if (!down.length) return;
      const frameMs = (down.length / 16000) * 1000;
      let sumSquares = 0;
      for (let i = 0; i < down.length; i++) sumSquares += down[i] * down[i];
      const rms = Math.sqrt(sumSquares / down.length);

      preroll.push(down);
      prerollSamples += down.length;
      while (prerollSamples > PREROLL_SAMPLES && preroll.length > 1) {
        const removed = preroll.shift();
        if (removed) prerollSamples -= removed.length;
      }

      // Speech over Jarvis holds his playback at once (the VAD's barge-in start: loud and sustained,
      // not a click). Only confirmed speech (INTERRUPT_CONFIRM_MS voiced) cancels what he was saying
      // and only the words decide anything else: a cough or a door never kills a reply or a task.
      const event = vad.push(rms, frameMs, phase === "speaking");
      switch (event) {
        case "start":
          recording = true;
          interrupted = false;
          voicedSamples = 0;
          utteranceChunks = preroll.slice();
          utteranceId++;
          partialText = "";
          resultStart = resultsSeen;
          utteranceSpeakingAtOnset = phase === "speaking";
          if (utteranceSpeakingAtOnset) pauseSpeech();
          break;
        case "speech":
          if (recording) {
            utteranceChunks.push(down);
            // "speech" also covers the trailing-silence frames; count voiced ones only.
            if (rms >= vad.config.stopRms) voicedSamples += down.length;
            if (voicedSamples >= confirmSamples && !interrupted) {
              interrupted = true;
              confirmInterruption();
            }
          }
          break;
        case "end": {
          if (recording) utteranceChunks.push(down);
          recording = false;
          // The VAD's own end-of-speech moment: the "speech end" timestamp for latency logging.
          const speechEndAt = Date.now();
          playAcknowledgeChime();
          let finished = utteranceChunks;
          utteranceChunks = [];
          // A pause inside one sentence: the earlier words, not yet sent to the brain, join this utterance.
          const carry = pending && !pending.submitted ? pending : null;
          if (carry) {
            carry.controller.abort();
            holdWake?.();
            finished = [...carry.chunks, ...finished];
          }
          void handleUtterance(finished, speechEndAt, utteranceSpeakingAtOnset || !!carry?.speakingAtOnset, carry?.early ?? null);
          break;
        }
        case "discard":
          recording = false;
          utteranceChunks = [];
          // A blip that never became speech: if it had paused him, he carries on.
          resumeSpeech();
          break;
        default:
          break;
      }
    };

    // Partial transcripts from the browser's own recogniser (Chrome/Edge), used only to decide
    // early; the words Jarvis answers are still the Groq transcript of the whole utterance.
    const Recognition =
      (window as unknown as Record<string, unknown>).SpeechRecognition ??
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    if (options.reflex && typeof Recognition === "function") {
      const reflex = options.reflex;
      const rec = new (Recognition as new () => Record<string, unknown>)();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-AU";
      const tryEarly = (text: string, id: number) => {
        if (closed || speculated || !recording || id !== utteranceId || id <= consumedId || phase === "speaking") return;
        reflexController?.abort();
        const controller = new AbortController();
        reflexController = controller;
        void reflex(text, controller.signal)
          .then(async (call) => {
            if (!call || closed || speculated || id !== utteranceId || id <= consumedId || controller.signal.aborted) return;
            speculated = { id, name: call.name, args: call.arguments, partial: text, result: "Early action still pending. Outcome unknown; do not repeat automatically." };
            const mine = speculated;
            try {
              mine.result = await options.onTool(call.name, withEventId(call.name, call.arguments, `u${id}`), AbortSignal.any([signal, controller.signal]), () => {});
              if (controller.signal.aborted) mine.result = "This early action was interrupted. Its outcome is unknown; do not repeat automatically.";
            } catch {
              mine.result = "This action could not finish. Do not claim it happened.";
            }
          })
          .catch(() => {});
      };
      rec.onresult = (event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
        if (closed || micMuted) return;
        resultsSeen = event.results.length;
        let text = "";
        for (let i = Math.max(resultStart, 0); i < event.results.length; i++) text += event.results[i][0].transcript;
        text = text.trim();
        if (!text || text === partialText) return;
        partialText = text;
        if (partialTimer) clearTimeout(partialTimer);
        const id = utteranceId;
        partialTimer = setTimeout(() => {
          if (partialText === text) tryEarly(text, id);
        }, PARTIAL_STABLE_MS);
      };
      rec.onerror = () => {};
      rec.onend = () => {
        if (closed || micMuted) return;
        resultsSeen = 0;
        resultStart = 0;
        try {
          (rec.start as () => void)();
        } catch {
          /* already running */
        }
      };
      try {
        (rec.start as () => void)();
        recognition = rec as unknown as typeof recognition;
      } catch {
        recognition = undefined;
      }
    }

    pumpAnnouncements = () => {
      if (closed) return;
      const gate = { phase, micMuted, userSpeaking: recording, busy: turnController !== null };
      if (!canAnnounce(gate)) {
        // Still busy: try again shortly (setPhase("listening") also re-schedules).
        if (!gate.micMuted) scheduleAnnouncements(1500);
        return;
      }
      const line = announcements.take(gate);
      if (!line) return;
      const myGeneration = generation;
      const controller = new AbortController();
      turnController = controller;
      // In the history as Jarvis's own words, so "do it" or "details" has context.
      options.onMessage("assistant", line);
      history.push({ role: "assistant", content: line.slice(0, MAX_MESSAGE_CHARS) });
      void speak(line, controller.signal, myGeneration).finally(() => {
        if (turnController === controller) turnController = null;
        scheduleAnnouncements();
      });
    };

    workletNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
      if (closed || micMuted) return;
      handleCaptureFrame(event.data.samples, event.data.sampleRate);
    };

    setPhase("listening");

    return {
      model: "free",
      voice: "free",
      greet: () => {
        if (closed) return;
        invalidateCurrentTurn();
        const myGeneration = generation;
        const controller = new AbortController();
        turnController = controller;
        const greeting = options.greeting ?? pickGreeting();
        options.onMessage("assistant", greeting);
        history.push({ role: "assistant", content: greeting });
        void speak(greeting, controller.signal, myGeneration).finally(() => {
          if (turnController === controller) turnController = null;
        });
      },
      endSession: async () => end(),
      setMicMuted: (muted: boolean) => {
        if (closed || micMuted === muted) return;
        micMuted = muted;
        microphone?.getAudioTracks().forEach((t) => (t.enabled = !muted));
        if (muted) {
          // Do not submit pre-mute audio when silence arrives after unmuting.
          resetCapture();
          resumeSpeech();
        }
        // Browser SpeechRecognition owns a separate microphone stream; disabling our
        // getUserMedia track alone does not mute it. onend must not restart while muted.
        try { if (muted) recognition?.stop(); else recognition?.start(); } catch { /* already stopped/running */ }
        if (!muted) scheduleAnnouncements();
      },
      announce: (text: string) => {
        if (closed) return false;
        if (announcements.push(text)) scheduleAnnouncements(250);
        return true;
      },
      chime: () => playAcknowledgeChime(),
      setVolume: ({ volume }: { volume: number }) => {
        if (outputGain) outputGain.gain.value = Math.max(0, Math.min(1, volume));
      },
      getInputVolume: () => readVolume(inputMeter),
      getOutputVolume: () => readVolume(outputMeter),
      resumeAudio: async () => {
        await Promise.all([captureContext.resume(), playbackContext.resume()]);
      },
      sendContextualUpdate: (text: string) => {
        if (closed) return;
        context.push(text.slice(0, 2000));
        while (context.length > 8) context.shift();
      },
      sendUserMessage: (text: string) => {
        if (closed) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        // Typed and spoken words share one guard: the same words within the window are one command.
        if (!duplicates.accept(trimmed)) return;
        invalidateCurrentTurn();
        turnEventKey = `t${++typedTurns}`;
        const myGeneration = generation;
        const controller = new AbortController();
        turnController = controller;
        options.onMessage("user", trimmed);
        history.push({ role: "user", content: trimmed.slice(0, MAX_MESSAGE_CHARS) });
        setPhase("thinking");
        // A typed message has no VAD end-of-speech; "now" is its speech-end for latency logging.
        void runModelLoop(controller, myGeneration, Date.now(), () => duplicates.forget(trimmed)).catch((error) => {
          // Tool batches reject when interrupted. Typed turns need the same rejection
          // boundary as handleUtterance, otherwise Stop emits an unhandled promise.
          if (myGeneration !== generation || closed || controller.signal.aborted) return;
          if ((error as { name?: string })?.name !== "AbortError")
            options.onError((error as Error)?.message || pickThinkingFailed());
          setPhase("listening");
        }).finally(() => {
          if (turnController === controller) turnController = null;
        });
      },
      sendUserActivity: () => {
        if (closed) return;
        invalidateCurrentTurn();
        options.onCaption("");
        setPhase("listening");
      },
    };
  } catch (error) {
    await end();
    throw error;
  }
}
