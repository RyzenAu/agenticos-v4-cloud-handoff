/**
 * Meeting mode in the page (docs/MEETING-MODE.md): the microphone side and the HUD's state.
 *
 * - Nothing is captured until the server says the meeting is `listening`, which it only does
 *   after a logged "they agreed". The mic isn't even opened before that.
 * - Audio lives in memory: small Float32 buffers, cut into ~8–18 s chunks at natural pauses,
 *   encoded to WAV, sent to the local transcriber through the OS server, then zeroed. Silent
 *   chunks are never sent. No recorder, no storage, no download.
 * - Jarvis doesn't speak during the call. The indicators are visual (the HUD's "listening ·
 *   12:34") and audible (a start chime, a soft pip every minute, an end chime).
 * - "Jarvis, end meeting" / "Jarvis, stop" are heard inside the captured audio (the normal voice
 *   session and the wake word are paused), and the HUD has End and Stop buttons.
 */
import { operatorRequest } from "./operator";
import { downsample, encodeWav } from "./free-voice-client";
import { CONSENT_SCRIPT, type MeetingAction } from "./meeting-words";

export type MeetingPhase = "idle" | "consent" | "listening" | "summarising" | "failed" | "done" | "declined";
/** "two-channel": the OS server captures the mic and a WASAPI loopback of the speakers itself
 *  (scripts/meeting-mode/capture.ts) — the browser's own mic is never opened for this call.
 *  "mixed": the original single mixed-channel capture below, used whenever loopback isn't
 *  available or the call is on a phone's own speaker. */
export type CaptureMode = "two-channel" | "mixed";
export type MeetingCue = { tag: string; title: string; line: string };
export type MeetingNotesView = {
  id: string;
  source: "meeting" | "debrief" | "granola";
  at: string;
  durationMs: number | null;
  title: string;
  recap: string;
  lead: { id: number; name: string } | null;
  summary: {
    who: string;
    needs: string[];
    objections: Array<{ tag: string; said: string; handled: string }>;
    decisions: string[];
    nextSteps: Array<{ what: string; who: string; when: string | null }>;
  };
  crm: { applied: boolean; detail: string; outcome: string; next: string | null; note: string };
  coaching: {
    score: number;
    categories: Record<string, number>;
    notObserved: string[];
    wentWell: string[];
    fixes: Array<{ issue: string; betterLine: string; framework: string }>;
    frameworks: string[];
  };
  followUps: Array<{ task: string; due: string | null; draft: string }>;
};

export type MeetingView = {
  open: boolean;
  phase: MeetingPhase;
  sessionId: string;
  lead: { id: number; name: string } | null;
  leadRef: string;
  script: string;
  startedAt: number | null;
  cuesOn: boolean;
  /** Explicit opt-in to send speech to Jev's cloud API (candidate #2, MINISTRY-JEV-BUSINESS.md) —
   *  a distinct action from local-recording consent above. The HUD must show a disclosure prompt
   *  before ever calling setCloudMeetingCues(true, true). */
  cloudCuesOptIn: boolean;
  cues: MeetingCue[];
  keepTranscript: boolean;
  captureMode: CaptureMode;
  /** Two-channel: both meters, filled from the server (capture.ts polls dual_capture.py at ~5
   *  Hz). Mixed: only `level` is live (the browser's own mic RMS); `levels` stays at zero. */
  levels: { me: number; prospect: number };
  level: number;
  silencePrompt: boolean;
  pip: boolean;
  chunks: number;
  sttAvgMs: number | null;
  notes: MeetingNotesView | null;
  markdown: string;
  error: string;
  busy: boolean;
};

const SAMPLE_RATE = 16_000;
const MIN_CHUNK_S = 8;
const MAX_CHUNK_S = 18;
const PAUSE_S = 0.5;
const SILENCE_ASK_MS = 90_000;
const PIP_EVERY_MS = 60_000;
const PIP_KEY = "jarvis:meeting-pip";

let view: MeetingView = {
  open: false, phase: "idle", sessionId: "", lead: null, leadRef: "", script: CONSENT_SCRIPT, startedAt: null,
  cuesOn: false, cloudCuesOptIn: false, cues: [], keepTranscript: false, captureMode: "mixed", levels: { me: 0, prospect: 0 },
  level: 0, silencePrompt: false, pip: readPip(), chunks: 0,
  sttAvgMs: null, notes: null, markdown: "", error: "", busy: false,
};
const listeners = new Set<(v: MeetingView) => void>();

function readPip() {
  try {
    return localStorage.getItem(PIP_KEY) !== "off";
  } catch {
    return true;
  }
}

function set(patch: Partial<MeetingView>) {
  view = { ...view, ...patch };
  for (const l of listeners) l(view);
  window.dispatchEvent(new CustomEvent("jarvis:meeting", { detail: { phase: view.phase } }));
}

export function meetingView() {
  return view;
}
export function subscribeMeeting(listener: (v: MeetingView) => void) {
  listeners.add(listener);
  listener(view);
  return () => void listeners.delete(listener);
}
/** True while the mic belongs to meeting mode: the voice session and wake word stand down. */
export function meetingListening() {
  return view.phase === "listening" || view.phase === "summarising";
}

type ServerStatus = {
  phase: MeetingPhase; sessionId: string; lead: MeetingView["lead"]; leadRef: string; script: string; startedAt: string | null;
  cuesOn: boolean; cloudCuesOptIn?: boolean; cues: MeetingCue[]; keepTranscript: boolean; chunks: number; sttAvgMs: number | null; error: string;
  captureMode?: CaptureMode; levels?: { me: number; prospect: number };
  say?: string; command?: string | null; notes?: MeetingNotesView | null; markdown?: string;
};

function apply(s: ServerStatus) {
  set({
    phase: s.phase, sessionId: s.sessionId, lead: s.lead, leadRef: s.leadRef, script: s.script || CONSENT_SCRIPT,
    startedAt: s.startedAt ? Date.parse(s.startedAt) : null, cuesOn: s.cuesOn, cloudCuesOptIn: s.cloudCuesOptIn ?? view.cloudCuesOptIn,
    cues: s.cues ?? [], keepTranscript: s.keepTranscript,
    captureMode: s.captureMode ?? "mixed", levels: s.levels ?? { me: 0, prospect: 0 },
    chunks: s.chunks, sttAvgMs: s.sttAvgMs, error: s.error || "",
    ...(s.notes !== undefined ? { notes: s.notes, markdown: s.markdown ?? "" } : {}),
  });
  startCapturePoll();
}

/* ------------------------------------------------------------------------------------------ */
/* Sounds: the audible indicator                                                                */
/* ------------------------------------------------------------------------------------------ */

let toneContext: AudioContext | null = null;
function tones(freqs: number[], gain = 0.12, each = 0.14) {
  try {
    toneContext ??= new AudioContext();
    const ctx = toneContext;
    void ctx.resume();
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.value = f;
      const t0 = ctx.currentTime + i * each;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
      g.gain.linearRampToValueAtTime(0, t0 + each);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + each + 0.02);
    });
  } catch {
    /* no audio output: the HUD still shows the indicator */
  }
}
const startChime = () => tones([660, 880]);
const endChime = () => tones([880, 660]);
const pipTone = () => tones([1320], 0.035, 0.08);

async function speak(text: string) {
  if (!text.trim()) return;
  try {
    const out = await operatorRequest<{ audio: string; mime: string }>("/voice/free/tts", { text: text.slice(0, 590) });
    await new Audio(`data:${out.mime};base64,${out.audio}`).play();
  } catch {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-AU";
      speechSynthesis.speak(u);
    } catch {
      /* text is on screen anyway */
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Capture                                                                                      */
/* ------------------------------------------------------------------------------------------ */

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let node: ScriptProcessorNode | null = null;
let blocks: Float32Array[] = [];
let blockSamples = 0;
let voiced = 0;
let quietRun = 0;
let noiseFloor = 0.004;
let lastVoiceAt = 0;
let asked = false;
let timer: number | null = null;
let capturePollTimer: number | null = null;
let lastPip = 0;
const queue: string[] = [];
let sending = false;

function wipeBlocks() {
  for (const b of blocks) b.fill(0);
  blocks = [];
  blockSamples = 0;
  voiced = 0;
  quietRun = 0;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Cut the buffered audio into one WAV chunk (only if someone spoke in it) and queue it. */
function cut() {
  if (!context || !blockSamples) return;
  const rate = context.sampleRate;
  const merged = new Float32Array(blockSamples);
  let at = 0;
  for (const b of blocks) merged.set(b, at), (at += b.length);
  const hadSpeech = voiced * 4096 > rate * 0.4;
  wipeBlocks();
  if (hadSpeech) {
    const pcm = downsample(merged, rate, SAMPLE_RATE);
    const wav = encodeWav(pcm, SAMPLE_RATE);
    queue.push(toBase64(wav));
    wav.fill(0);
    pcm.fill(0);
  }
  merged.fill(0);
  void drain();
}

async function drain() {
  if (sending) return;
  sending = true;
  try {
    while (queue.length && view.phase === "listening") {
      const audio = queue.shift()!;
      try {
        const out = await operatorRequest<ServerStatus>("/meeting/audio", { sessionId: view.sessionId, audio });
        apply(out);
        if (out.command === "end") void endMeeting();
        else if (out.command === "stop") {
          stopCapture();
          endChime();
        }
      } catch (error) {
        const message = (error as Error).message;
        if (/Not listening/i.test(message)) {
          stopCapture();
          await refreshMeeting();
          return;
        }
        set({ error: message });
      }
    }
  } finally {
    sending = false;
  }
}

async function startCapture() {
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the microphone here (it needs localhost or HTTPS).");
  // Speakerphone next to the mic: keep the far voice. Echo cancellation and noise suppression
  // are tuned for a headset and would thin out the other party; auto gain helps a quiet phone.
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
  });
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  context = new Ctx();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  node = context.createScriptProcessor(4096, 1, 1);
  lastVoiceAt = Date.now();
  asked = false;
  node.onaudioprocess = (e) => {
    if (view.phase !== "listening") return;
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const speaking = rms > Math.max(0.012, noiseFloor * 3);
    if (!speaking) noiseFloor = noiseFloor * 0.98 + rms * 0.02;
    if (speaking) (voiced++, (quietRun = 0), (lastVoiceAt = Date.now()));
    else quietRun += input.length;
    blocks.push(input.slice());
    blockSamples += input.length;
    const rate = context!.sampleRate;
    const seconds = blockSamples / rate;
    // Long chunks at natural pauses (better accuracy), but a short phrase followed by a real pause
    // ("Jarvis, end meeting.") goes at once, so a spoken command acts within a couple of seconds.
    if ((seconds >= MIN_CHUNK_S && quietRun >= rate * PAUSE_S) || (seconds >= 1.5 && quietRun >= rate * 1.2) || seconds >= MAX_CHUNK_S) cut();
    set({ level: Math.min(1, rms * 8) });
  };
  // Through a muted gain, so the processor runs without playing the room back out.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute).connect(context.destination);
  lastPip = Date.now();
  timer = window.setInterval(() => {
    if (view.phase !== "listening") return;
    const now = Date.now();
    if (view.pip && now - lastPip >= PIP_EVERY_MS) (lastPip = now), pipTone();
    const silent = now - lastVoiceAt;
    if (silent >= SILENCE_ASK_MS && !asked) {
      asked = true;
      set({ silencePrompt: true });
      // The line itself goes through the mic: "Jarvis, end meeting" in reply is heard as a command.
      void speak("It's gone quiet. Has the call finished? Say: Jarvis, end meeting. Or press End.");
    } else if (silent < SILENCE_ASK_MS && view.silencePrompt) {
      asked = false;
      set({ silencePrompt: false });
    }
  }, 1000);
  startChime();
}

/**
 * Two-channel mode: the mic is never opened here (the OS server captures it), so there's no
 * onaudioprocess loop feeding `apply()` new chunk counts, cues or levels. Poll status instead
 * while it's actually running — stops itself the moment the phase or capture mode changes.
 */
function startCapturePoll() {
  if (capturePollTimer || view.phase !== "listening" || view.captureMode !== "two-channel") return;
  capturePollTimer = window.setInterval(() => void refreshMeeting(), 700);
}
function stopCapturePoll() {
  if (capturePollTimer) window.clearInterval(capturePollTimer);
  capturePollTimer = null;
}

function stopCapture() {
  stopCapturePoll();
  if (timer) window.clearInterval(timer);
  timer = null;
  if (node) node.onaudioprocess = null;
  node?.disconnect();
  node = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void context?.close().catch(() => undefined);
  context = null;
  wipeBlocks();
  for (let i = 0; i < queue.length; i++) queue[i] = "";
  queue.length = 0;
  set({ level: 0, silencePrompt: false });
}

/* ------------------------------------------------------------------------------------------ */
/* Actions (HUD buttons and the voice tool)                                                     */
/* ------------------------------------------------------------------------------------------ */

async function run<T>(work: () => Promise<T>): Promise<T | null> {
  set({ busy: true, error: "" });
  try {
    return await work();
  } catch (error) {
    set({ error: (error as Error).message });
    return null;
  } finally {
    set({ busy: false });
  }
}

export async function refreshMeeting() {
  try {
    apply(await operatorRequest<ServerStatus>("/meeting/status"));
  } catch {
    /* server restarting */
  }
}

export async function startMeeting(lead?: string) {
  // The lead it was started from is shown in the panel at once (AUDIT-F1 F1-04), before the server answers.
  set({ open: true, notes: null, markdown: "", ...(lead ? { leadRef: lead } : {}) });
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/start", { lead: lead || null }));
  if (out) apply(out);
  return out?.say ?? "";
}

export async function answerConsent(answer: "agreed" | "declined") {
  const out = await run(() =>
    operatorRequest<ServerStatus>("/meeting/consent", { sessionId: view.sessionId, answer, confirmation: answer === "agreed" ? "they agreed (HUD)" : "they said no (HUD)", channel: "hud" }),
  );
  if (!out) return "";
  apply(out);
  // Two-channel: the OS server opens the mic and loopback itself (capture.ts) — the browser's
  // mic is never opened for this call. Mixed mode (loopback unavailable, iPhone speaker, etc.)
  // keeps the original single-mic capture below.
  if (out.phase === "listening" && out.captureMode !== "two-channel") {
    await startCapture().catch(async (e) => {
      set({ error: (e as Error).message });
      await operatorRequest("/meeting/stop", { sessionId: view.sessionId }).catch(() => undefined);
      await refreshMeeting();
    });
  }
  return out.say ?? "";
}

export async function endMeeting(keepTranscript = false) {
  const wasListening = view.phase === "listening";
  // Flush what's buffered (it's the end of the call), then close the mic before summarising.
  // A no-op in two-channel mode: there's nothing browser-side to flush or wait on.
  if (wasListening) cut();
  for (let waited = 0; (sending || queue.length) && waited < 60_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
  stopCapture();
  if (wasListening) endChime();
  set({ phase: "summarising" });
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/end", { sessionId: view.sessionId, keepTranscript }));
  if (out) {
    apply(out);
    void speak(out.say ?? "");
  } else await refreshMeeting();
  return out?.say ?? "";
}

export async function stopMeeting() {
  const wasListening = view.phase === "listening";
  stopCapture();
  if (wasListening) endChime();
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/stop", {}));
  if (out) apply(out);
  return out?.say ?? "";
}

export async function setMeetingCues(on: boolean) {
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/cues", { on }));
  if (out) apply(out);
}

/**
 * `disclosed` must only ever be true right after the HUD has shown its own disclosure text to
 * the founder and he's confirmed he told the other party — this call carries no proof of that on
 * its own, session.ts's setCloudCues() is the actual gate that refuses `true` without it.
 */
export async function setCloudMeetingCues(on: boolean, disclosed = false) {
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/cloud-cues", { on, disclosed }));
  if (out) apply(out);
}

export async function keepMeetingTranscript() {
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/keep", { on: true }));
  if (out) apply(out);
}

export function setMeetingPip(on: boolean) {
  try {
    localStorage.setItem(PIP_KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
  set({ pip: on });
}

export async function submitDebrief(text: string, lead?: string) {
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/debrief", { text, lead: lead || null }));
  if (out) set({ open: true, phase: "done", notes: out.notes ?? null, markdown: out.markdown ?? "" });
  return out?.say ?? "";
}

export async function coachGranola(query?: string, lead?: string) {
  set({ open: true });
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/granola", { query: query || "", lead: lead || null }));
  if (out) set({ phase: "done", notes: out.notes ?? null, markdown: out.markdown ?? "" });
  return out?.say ?? "";
}

export async function logNotesToLead(lead: string) {
  if (!view.notes) return;
  const out = await run(() => operatorRequest<ServerStatus>("/meeting/log", { notesId: view.notes!.id, lead }));
  if (out) set({ notes: out.notes ?? view.notes, markdown: out.markdown ?? view.markdown });
}

export async function openLastNotes() {
  const list = await run(() => operatorRequest<{ notes: Array<{ id: string }> }>("/meeting/notes"));
  const id = list?.notes?.[0]?.id;
  if (!id) return set({ open: true, error: "There are no call notes yet." });
  const out = await run(() => operatorRequest<{ notes: MeetingNotesView; markdown: string }>(`/meeting/notes/${encodeURIComponent(id)}`));
  if (out) set({ open: true, phase: view.phase === "idle" ? "done" : view.phase, notes: out.notes, markdown: out.markdown });
}

export function closeMeetingPanel() {
  if (view.phase === "listening" || view.phase === "summarising" || view.phase === "consent") return;
  set({ open: false, notes: null, markdown: "", error: "", phase: "idle" });
}

/**
 * The voice tool ("meeting"): run one action and return what Jarvis should say. An empty
 * string means "say nothing" (the call has started; the voice session steps aside).
 */
export async function meetingVoiceAction(action: MeetingAction, args: { lead?: string; text?: string } = {}): Promise<string> {
  switch (action) {
    case "start":
      return startMeeting(args.lead);
    case "agreed":
    case "declined":
      set({ open: true });
      return answerConsent(action);
    case "end":
      void endMeeting();
      return "";
    case "stop":
      return stopMeeting();
    case "cues_on":
    case "cues_off":
      await setMeetingCues(action === "cues_on");
      return action === "cues_on" ? "Cue cards on." : "Cue cards off.";
    case "cloud_cues_on":
      // Reaching this action at all already required his own words confirming the disclosure
      // (meeting-words.ts's "I've told them, cloud cues on") — that phrase IS the confirmation.
      await setCloudMeetingCues(true, true);
      return view.error || "Cloud cues on — I've noted the disclosure.";
    case "cloud_cues_off":
      await setCloudMeetingCues(false);
      return "Cloud cues off.";
    case "keep_transcript":
      await keepMeetingTranscript();
      return "I'll keep this call's transcript.";
    case "script":
      set({ open: true });
      return `Say this to them: ${view.script}`;
    case "debrief": {
      set({ open: true, phase: "summarising" });
      const said = await submitDebrief(args.text ?? "", args.lead);
      return said || view.error || "I couldn't coach that one.";
    }
    case "granola": {
      set({ phase: "summarising" });
      const said = await coachGranola(args.text, args.lead);
      return said || view.error || "I couldn't coach that Granola meeting.";
    }
    case "last":
      await openLastNotes();
      return view.notes ? `The last call's notes are on screen. ${view.notes.recap}` : "There are no call notes yet.";
  }
}
