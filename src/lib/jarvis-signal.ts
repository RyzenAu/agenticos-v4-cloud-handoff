// A tiny client-side bus for "what is Jarvis doing right now": the voice phase, which brain is
// answering, and a live audio meter. The voice companion publishes; the model orb (and anything
// else that wants to react) reads it every frame without re-rendering React. Nothing here talks
// to the network — it only mirrors state the voice companion already has.

export type BrainId = "jarvis" | "claude" | "sol" | "groq" | "jev" | "mimo" | "gemini";
export type SignalPhase = "idle" | "connecting" | "listening" | "thinking" | "speaking";
export type AudioMeter = () => { mic: number; out: number };

export type JarvisSignal = {
  phase: SignalPhase;
  /** A voice session is open (mic live). */
  active: boolean;
  brain: BrainId;
  /** The raw model / route the brain came from, for a tooltip ("openai/gpt-oss-120b"). */
  model: string;
  /** Reads the real analysers of the running voice session (0..1). Null when no session. */
  meter: AudioMeter | null;
  /** Something is working in the background (Hermes, an agent job, a screen task). */
  working: boolean;
};

export const BRAINS: Record<BrainId, { label: string; hint: string }> = {
  jarvis: { label: "Jarvis", hint: "Ready" },
  claude: { label: "Claude", hint: "Claude Code / Claude on the subscription" },
  sol: { label: "GPT-6 Sol", hint: "Hermes on GPT-6 Sol / Astra / Codex" },
  groq: { label: "Groq", hint: "Fast voice brain on Groq" },
  jev: { label: "Jev", hint: "Rules and the Jev router, no model call" },
  mimo: { label: "MiMo", hint: "Xiaomi MiMo" },
  gemini: { label: "Gemini", hint: "Gemini fallback" },
};

/**
 * Which brain a model or route name belongs to. Order matters: gpt-oss and qwen run on Groq, so
 * the Groq check comes before the OpenAI one.
 */
export function brainFromModel(model: string | null | undefined): BrainId {
  const m = String(model ?? "").toLowerCase().trim();
  if (!m) return "jarvis";
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return "claude";
  if (/mimo|xiaomi/.test(m)) return "mimo";
  if (m === "rules" || /\bjev\b|jev-router|typesafe/.test(m)) return "jev";
  if (/gemini/.test(m)) return "gemini";
  if (/groq|gpt-oss|qwen|llama|kimi|whisper|orpheus|mixtral/.test(m)) return "groq";
  if (/gpt|openai|astra|\bsol\b|codex|hermes|\bo[1-9]\b/.test(m)) return "sol";
  return "jarvis";
}

type Listener = (signal: JarvisSignal) => void;

const state: JarvisSignal = {
  phase: "idle",
  active: false,
  brain: "jarvis",
  model: "",
  meter: null,
  working: false,
};
const listeners = new Set<Listener>();
let held: { brain: BrainId; model: string } | null = null;

export function readSignal(): JarvisSignal {
  return state;
}

export function publishSignal(partial: Partial<JarvisSignal>) {
  let changed = false;
  for (const key of Object.keys(partial) as (keyof JarvisSignal)[]) {
    if (state[key] !== partial[key]) {
      (state as Record<string, unknown>)[key] = partial[key];
      changed = true;
    }
  }
  if (changed) for (const listener of listeners) listener(state);
}

/** The brain that answered the last turn (a `/voice/free/turn` reply's `model`). */
export function noteBrain(model: string | null | undefined) {
  if (!model || held) return;
  publishSignal({ brain: brainFromModel(model), model });
}

/**
 * While a long task runs on another brain (Hermes on Sol, Claude Code), the orb takes that
 * brain's colour. Returns a release function that puts the previous brain back.
 */
export function holdBrain(brain: BrainId, model: string) {
  const previous = { brain: state.brain, model: state.model };
  held = { brain, model };
  publishSignal({ brain, model, working: true });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held = null;
    publishSignal({ ...previous, working: false });
  };
}

// Dev builds only: lets the console (and the HUD screenshot check) drive the orb by hand.
if (typeof window !== "undefined" && import.meta.env?.DEV)
  (window as unknown as { __jarvisSignal?: unknown }).__jarvisSignal = { publish: publishSignal, read: readSignal };

export function subscribeSignal(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
