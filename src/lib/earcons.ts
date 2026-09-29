/**
 * The "I heard you" earcon: a short, quiet, synthesised chime (no audio files, no copyrighted
 * sound assets) played the instant a turn ends — or the wake word fires — so the owner gets an
 * immediate confirmation while STT/the brain do the slower work behind it. Two soft sine
 * partials with a fast fade-in/out: no clicks, no loudness spike, nothing that reads as a
 * notification "ding".
 */

/** Minimal shape of the two AudioParam methods this needs — real or faked in tests. */
export interface EarconAudioParam {
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
}
export interface EarconGainNode {
  gain: EarconAudioParam;
  connect(destination: unknown): void;
}
export interface EarconOscillatorNode {
  type: string;
  frequency: EarconAudioParam;
  connect(destination: unknown): void;
  start(time?: number): void;
  stop(time?: number): void;
}
/** Minimal shape of an AudioContext this needs — real or faked in tests. */
export interface EarconAudioContext {
  currentTime: number;
  createGain(): EarconGainNode;
  createOscillator(): EarconOscillatorNode;
}

export type EarconOptions = {
  /** Hz of the two sine partials. A soft interval, not a harsh beep. */
  frequencies?: readonly [number, number];
  durationMs?: number;
  /** Peak linear gain. Kept low — this confirms, it doesn't announce. */
  gain?: number;
};

const DEFAULT_FREQUENCIES: readonly [number, number] = [880, 1318.5];
const DEFAULT_DURATION_MS = 120;
const DEFAULT_GAIN = 0.05;
const ATTACK_MS = 10;

/**
 * Synthesise and play the acknowledgement chime on the given context, routed through
 * `destination` (pass the session's output gain node so mute/volume apply to it too). Pure
 * side effect, no audio files — cheap enough to call the instant end-of-speech or the wake
 * word fires.
 */
export function playAcknowledgeEarcon(context: EarconAudioContext, destination: unknown, options: EarconOptions = {}): void {
  const frequencies = options.frequencies ?? DEFAULT_FREQUENCIES;
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const gain = options.gain ?? DEFAULT_GAIN;
  const now = context.currentTime;
  const duration = durationMs / 1000;
  const attack = Math.min(ATTACK_MS / 1000, duration / 4);

  const master = context.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(gain, now + attack);
  master.gain.linearRampToValueAtTime(0, now + duration);
  master.connect(destination);

  for (const frequency of frequencies) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.connect(master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }
}

const STORAGE_KEY = "jarvis:earcon";
export type EarconStorage = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(storage?: EarconStorage): EarconStorage | undefined {
  if (storage) return storage;
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** The acknowledgement chime is on by default; only an explicit "off" turns it off. Never throws. */
export function isEarconEnabled(storage?: EarconStorage): boolean {
  const target = resolveStorage(storage);
  if (!target) return true;
  try {
    return target.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Persist the chime setting. Best-effort: a private window or blocked storage never throws. */
export function setEarconEnabled(enabled: boolean, storage?: EarconStorage): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    /* blocked storage: the in-memory default (on) still applies for this session */
  }
}
