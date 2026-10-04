/**
 * Turn-taking rules for the free Jarvis voice pipeline (src/lib/free-voice-client.ts). Pure and
 * unit tested: adaptive endpointing, "stop" disambiguation, the duplicate-submission guard and the
 * microphone reconnector. Patterns adapted from LiveKit Agents' turn handling (endpointing delays,
 * interruption with false-interruption recovery, resume after noise); none of its code is used.
 * See docs/programme-20261001/VOICE-TURNS.md.
 */

export type EndpointConfig = {
  /** Silence after speech that ends the utterance for the VAD (the "min endpointing delay"). */
  minSilenceMs: number;
  /** Extra wait after a trailing filler ("um", "so"), or a connector ("and", "then"). */
  fillerHoldMs: number;
  /** Extra wait after a dangling word with no end punctuation ("go to", "search for"). */
  danglingHoldMs: number;
  ellipsisHoldMs: number;
  commaHoldMs: number;
  /** Hard cap from end of speech to submission, whatever the text looks like (the "max endpointing delay"). */
  maxTotalMs: number;
  /** A new utterance this soon after an unsubmitted one continues it instead of replacing it. */
  mergeWindowMs: number;
};

export const ENDPOINTING: EndpointConfig = {
  minSilenceMs: 650,
  fillerHoldMs: 1500,
  danglingHoldMs: 1300,
  ellipsisHoldMs: 1200,
  commaHoldMs: 800,
  maxTotalMs: 2600,
  mergeWindowMs: 2600,
};

/** Speech over Jarvis pauses his playback at once (VAD barge-in start); voiced this long confirms it. */
export const INTERRUPT_CONFIRM_MS = 500;
/** Paused for a noise that never became words: resume after this (cf. LiveKit's false_interruption_timeout; its numeric default is not documented, 2 s is our choice). */
export const FALSE_INTERRUPTION_MS = 2000;
/** Same spoken/typed words inside this window are one command. Mirrors the command service's DEDUPE_MS (scripts/jarvis-command/service.ts). */
export const DUPLICATE_WINDOW_MS = 5000;
/** How long "Stop the task too?" waits for an answer. */
export const STOP_QUESTION_TTL_MS = 15_000;
export const STOP_TASK_QUESTION = "Stop the task too?";

const CONNECTORS = ["and", "then", "but", "or", "plus", "also", "because", "which", "if", "when", "while"];
const FILLERS = ["um", "umm", "uh", "uhh", "er", "erm", "hmm", "hmmm", "mm", "mmm", "ah", "you know", "i mean"];
/** Dangling only when the transcript has no end punctuation: "turn the lights on." is complete, "go to" is not. */
const DANGLING = ["to", "the", "a", "an", "my", "your", "our", "with", "for", "of", "in", "on", "at", "into", "onto", "from", "by", "that", "after", "before", "about", "as", "than", "so", "like", "well"];

const endsWithWord = (text: string, words: string[]) => words.some((w) => text === w || text.endsWith(` ${w}`));

/** Extra milliseconds to wait for the speaker to carry on, given the transcript of what they've said so far. 0 = complete. */
export function endpointHoldMs(transcript: string, config: EndpointConfig = ENDPOINTING): number {
  const raw = transcript.trim();
  if (!raw) return 0;
  if (/(?:…|\.{3})$/.test(raw)) return config.ellipsisHoldMs;
  if (/[,;:\-–—]$/.test(raw)) return config.commaHoldMs;
  const ended = /[.!?]$/.test(raw);
  const words = raw.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return 0;
  if (endsWithWord(words, FILLERS) || endsWithWord(words, CONNECTORS)) {
    // "...and." is still mid-clause; a full stop after a real word is not ("you know." is).
    return config.fillerHoldMs;
  }
  if (!ended && endsWithWord(words, DANGLING)) return config.danglingHoldMs;
  return 0;
}

/** Milliseconds still to wait before submitting, never beyond the hard cap measured from the end of speech. */
export function remainingHoldMs(transcript: string, sinceSpeechEndMs: number, config: EndpointConfig = ENDPOINTING): number {
  const hold = endpointHoldMs(transcript, config);
  if (hold <= 0) return 0;
  return Math.max(0, Math.min(hold, config.maxTotalMs - Math.max(0, sinceSpeechEndMs)));
}

/* ---------------------------------------------------------------------------------------- */
/* "Stop" disambiguation                                                                      */
/* ---------------------------------------------------------------------------------------- */

export type StopDecision =
  | { kind: "none" }
  /** Stop talking; leave any task running. */
  | { kind: "stop-speech" }
  /** Cancel the running task through the existing cancel path. */
  | { kind: "stop-task" }
  /** "Stop" while he is speaking AND a task runs: stop talking, then ask. */
  | { kind: "ambiguous" }
  /** The words meant a task but none is running. */
  | { kind: "no-task" }
  /** A bare "stop" with nothing speaking and nothing running: nothing to do. */
  | { kind: "nothing" };

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/^(?:hey |ok |okay )?jarvis[,.]?\s+/, "")
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Unambiguous: about his voice. Works whether or not a task runs. */
const SPEECH_ONLY = new Set(["quiet", "be quiet", "shush", "hush", "shut up", "silence", "stop talking", "stop speaking", "enough", "that's enough", "thats enough", "wait", "wait wait", "hold on", "hang on", "pause", "be quiet please", "quiet please"]);
/** Depends on the state: speech if he is talking, the task if only a task runs. */
const GENERIC = new Set(["stop", "stop please", "please stop", "stop that", "stop it", "stop now", "cancel", "cancel that", "cancel it", "never mind", "nevermind", "forget it", "abort"]);
/** Unambiguous: about the work. */
const TASK_ONLY = /^(?:please )?(?:stop|cancel|abort|kill|end)(?: (?:that|the|this|my|it))? (?:task|job|command|request|goal|run|process)(?: please| now)?$/;

export function classifyStop(text: string, state: { speaking: boolean; taskRunning: boolean }): StopDecision {
  const t = normalise(text);
  if (!t) return { kind: "none" };
  if (SPEECH_ONLY.has(t)) return { kind: "stop-speech" };
  if (TASK_ONLY.test(t)) return state.taskRunning ? { kind: "stop-task" } : { kind: "no-task" };
  if (GENERIC.has(t)) {
    if (state.speaking && state.taskRunning) return { kind: "ambiguous" };
    if (state.speaking) return { kind: "stop-speech" };
    if (state.taskRunning) return { kind: "stop-task" };
    return { kind: "nothing" };
  }
  return { kind: "none" };
}

/** The answer to "Stop the task too?": yes, no, or neither (a new request). */
export function answerStopQuestion(text: string): "yes" | "no" | null {
  const t = normalise(text);
  if (/^(?:yes|yeah|yep|yup|sure|please|do it|stop it|stop (?:it|that|the task|the job)|cancel (?:it|that|the task|the job))(?: please)?$/.test(t)) return "yes";
  if (/^(?:no|nope|nah|leave it|carry on|keep going|don't|do not|not yet|let it run|let it finish)(?: please)?$/.test(t)) return "no";
  return null;
}

/* ---------------------------------------------------------------------------------------- */
/* Duplicate-submission guard                                                                 */
/* ---------------------------------------------------------------------------------------- */

const ANSWER = /^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?|no|nope|leave it|next|again|continue)$/;

/**
 * The same words inside the window are one command. This only stops a second *brain turn* (and a
 * second spoken reply); a command that reaches the command service is deduped there too, on its own
 * 5 s key (scripts/jarvis-command/service.ts), which stays the authority. One-word answers and
 * "yes"/"no" are never treated as duplicates. A failed turn is forgotten so a retry goes through.
 */
export function createDuplicateGuard(windowMs = DUPLICATE_WINDOW_MS, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
  const exempt = (k: string) => !k || k.split(" ").length < 2 || ANSWER.test(k);
  return {
    /** True when this is a new command; false when the same words were accepted within the window. */
    accept(text: string): boolean {
      const k = key(text);
      const at = now();
      for (const [other, when] of seen) if (at - when > windowMs) seen.delete(other);
      if (exempt(k)) return true;
      if (seen.has(k)) return false;
      seen.set(k, at);
      return true;
    },
    forget(text: string) {
      seen.delete(key(text));
    },
  };
}

/* ---------------------------------------------------------------------------------------- */
/* Utterance event ids                                                                        */
/* ---------------------------------------------------------------------------------------- */

/**
 * A stable id for ONE spoken (or typed) command event: `session nonce + the turn's key + a hash of the tool and its arguments`.
 * The same event, sent again (the reflex's early call and the final turn, or a replay after the microphone or the stream
 * reconnected), carries the same id, so the command service returns the first outcome instead of running it twice. Two
 * different turns, or the same words typed again later, get different ids. `[\w:.-]`, at most 80 characters.
 */
export function utteranceEventId(nonce: string, turnKey: string, name: string, args: Record<string, unknown>): string {
  const text = `${name}|${JSON.stringify(args, Object.keys(args).sort())}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `utt-${nonce}-${turnKey}-${h.toString(36)}`.replace(/[^\w:.-]/g, "").slice(0, 80);
}

/* ---------------------------------------------------------------------------------------- */
/* Microphone reconnect                                                                       */
/* ---------------------------------------------------------------------------------------- */

export type MicStatus = "lost" | "reconnecting" | "restored" | "failed";

/** 0, 0.4, 1, 2, 4 s: a device switch settles in under a second; five tries is bounded. */
export const MIC_RECONNECT_DELAYS = [0, 400, 1000, 2000, 4000];

/**
 * Re-acquires the microphone after the device ended, changed or blipped, without touching the
 * conversation. Single-flight; a permission denial stops at once (asking again won't help).
 */
export function createMicReconnector<S>(options: {
  acquire: () => Promise<S>;
  onStream: (stream: S) => void;
  onStatus: (status: MicStatus) => void;
  isClosed: () => boolean;
  delays?: number[];
  wait?: (ms: number) => Promise<void>;
}) {
  const delays = options.delays ?? MIC_RECONNECT_DELAYS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let running: Promise<boolean> | null = null;
  const run = async (): Promise<boolean> => {
    options.onStatus("lost");
    for (const delay of delays) {
      if (options.isClosed()) return false;
      if (delay) await wait(delay);
      if (options.isClosed()) return false;
      options.onStatus("reconnecting");
      try {
        const stream = await options.acquire();
        if (options.isClosed()) return false;
        options.onStream(stream);
        options.onStatus("restored");
        return true;
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === "NotAllowedError" || name === "SecurityError") break;
      }
    }
    if (!options.isClosed()) options.onStatus("failed");
    return false;
  };
  return {
    lost(): Promise<boolean> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    get busy() {
      return running !== null;
    },
  };
}
