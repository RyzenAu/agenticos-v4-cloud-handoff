// Meeting mode (docs/MEETING-MODE.md): Jarvis listens to a consented call, stays silent, then
// gives notes and coaching. This is the server-side state machine, and the consent gate lives
// here, not in the page, so no client can skip it:
//
//   idle ──start──▶ consent ──agreed──▶ listening ──end──▶ summarising ──▶ done
//                      │                    │
//                      └─declined─▶ declined (debrief offered)     stop (any time): wipe, idle
//
// Audio is accepted ONLY in `listening`, after a logged "they agreed". Each chunk is transcribed
// from RAM and dropped; the transcript lives in this process's memory until the summary is made,
// then is discarded unless he said "keep the transcript" for this one call.
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JEV_MODEL } from "../jev-client";
import { hashInput, recordDecisionShadow } from "../jev-shadow";
import { CONSENT_SCRIPT, inCallCommand, type MeetingGate } from "../../src/lib/meeting-words";
import { coachCall, renderNotes, type Llm, type MeetingNotes, type Source } from "./coach";
import { applyNotes, matchLead } from "./crm-sync";
import { cueForTag, cuesFor, mergeCues, type Cue, type ObjectionTag } from "./cues";
import { CUE_COOLDOWN_MS, type ChunkSpeaker, type ClassifyResult, type ObjectionChunkInput } from "./objection-jev";
import type { MeetingStore } from "./store";

export type MeetingPhase = "idle" | "consent" | "listening" | "summarising" | "failed" | "done" | "declined";
export type Channel = "voice" | "hud" | "cli";
/** Two-channel capture (docs/MEETING-MODE.md, "Two-channel capture"): the mic and a WASAPI
 *  loopback of the system output captured and transcribed separately, so real speaker labels
 *  reach objection-jev.ts. "mixed" is the original single-channel behaviour (speaker "unknown"),
 *  used whenever loopback isn't available or the call is on a phone's own speaker. */
export type CaptureMode = "two-channel" | "mixed";

export class MeetingGateError extends Error {
  /** 409 is the gate (wrong phase, wrong call); not-found, wrong-method and bad-input callers pass their own. */
  constructor(message: string, readonly status: number = 409) {
    super(message);
  }
}

export type MeetingDeps = {
  store: MeetingStore;
  /** Local speech-to-text of one 16-bit mono WAV held in memory. */
  transcribe: (wav: Uint8Array) => Promise<{ text: string; ms: number }>;
  /** Start the local transcriber loading (captures nothing). */
  warm?: () => Promise<unknown>;
  llm: Llm;
  /** The lead engine CRM, opened on demand; null when unavailable. */
  crm?: () => Database | null;
  /** Granola notes of recent online meetings (Zoom/Meet), newest first. */
  recentGranola?: () => Promise<{ documents: Array<{ id: string; title: string; text: string }> }>;
  now?: () => Date;
  random?: () => string;
  /** A consent question left unanswered this long is cancelled. */
  consentTimeoutMs?: number;
  /**
   * Cloud objection classification (MINISTRY-JEV-BUSINESS.md candidate #2). Undefined means the
   * cloud path never runs at all — same behaviour as before this feature existed. Gated further
   * at the call site behind the session's own explicit cloud-cue opt-in.
   */
  cloudClassify?: (input: ObjectionChunkInput) => Promise<ClassifyResult | null>;
  /**
   * Who said this chunk. Meeting mode currently captures one mixed audio channel with no speaker
   * diarisation, so the honest default is always "unknown" — which correctly makes
   * classifyObjectionCues() abstain rather than guess who's talking. A future diarisation source
   * can supply a real value here; tests use it to exercise the "prospect" path.
   */
  speakerOf?: (text: string, priorSegments: readonly string[]) => ChunkSpeaker;
  /** Root path for the shared shadow-mode recorder (jev-shadow.ts). Undefined skips recording
   *  entirely — used in tests that don't want to touch disk. */
  shadowRoot?: string;
  /**
   * Two-channel capture (docs/MEETING-MODE.md): a quick, non-invasive check of whether a WASAPI
   * loopback of the default speaker is available — device enumeration only, it never opens a
   * stream, so it's safe to run while consent is still pending. Undefined, or a result of
   * "mixed", keeps the existing single mixed-channel browser capture (capture.ts, dual_capture.py
   * do nothing). Run fire-and-forget from start(), same pattern as warm().
   */
  probeCapture?: () => Promise<CaptureMode>;
  /** Two-channel capture starts only once "they agreed" — the same authorisation boundary as the
   *  browser's mic in mixed mode — and stops the instant listening ends for any reason. */
  onListeningStart?: (sessionId: string) => void;
  onListeningEnd?: () => void;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

const MAX_CHUNK = 4 * 1024 * 1024;

export function meetingMode(deps: MeetingDeps) {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? (() => randomBytes(4).toString("hex"));
  const consentTimeout = deps.consentTimeoutMs ?? 15 * 60_000;

  type State = {
    phase: MeetingPhase;
    sessionId: string;
    lead: { id: number; name: string } | null;
    leadRef: string;
    by: string;
    askedAt: number;
    startedAt: number | null;
    consentAt: string | null;
    cuesOn: boolean;
    cues: Cue[];
    keepTranscript: boolean;
    segments: string[];
    chunks: number;
    sttMs: number[];
    lastSpeechAt: number | null;
    lastNotesId: string | null;
    error: string;
    /** Explicit opt-in to send speech to Jev's cloud API — separate from local-recording consent. */
    cloudCuesOptIn: boolean;
    cloudCuesDisclosedAt: string | null;
    /** Rising per audio() call; a cloud classification result older than the current value is
     *  stale and discarded, per the Ministry's "discard stale results once a newer chunk lands". */
    chunkSeq: number;
    lastChunkText: string;
    /** Debounce: a tag already cued recently isn't cued again until this time passes. */
    cueCooldownUntil: Partial<Record<ObjectionTag, number>>;
    /** "mixed" until probeCapture() (fire-and-forget from start()) says otherwise. */
    captureMode: CaptureMode;
    /** Live input levels for the HUD's meters, 0..1. UI-only, never persisted. */
    levels: { me: number; prospect: number };
  };
  const fresh = (): State => ({
    phase: "idle", sessionId: "", lead: null, leadRef: "", by: "usman", askedAt: 0, startedAt: null, consentAt: null,
    cuesOn: false, cues: [], keepTranscript: false, segments: [], chunks: 0, sttMs: [], lastSpeechAt: null,
    lastNotesId: s?.lastNotesId ?? null, error: "",
    cloudCuesOptIn: false, cloudCuesDisclosedAt: null, chunkSeq: 0, lastChunkText: "", cueCooldownUntil: {},
    captureMode: "mixed", levels: { me: 0, prospect: 0 },
  });
  let s: State = undefined as unknown as State;
  s = fresh();

  const t = () => now().getTime();
  const day = () => now().toISOString().slice(0, 10).replace(/-/g, "");

  /** Overwrite then drop the in-memory transcript. */
  function wipe() {
    for (let i = 0; i < s.segments.length; i++) s.segments[i] = "";
    s.segments.length = 0;
  }

  function expireConsent() {
    if (s.phase === "consent" && t() - s.askedAt > consentTimeout) {
      wipe();
      s = fresh();
    }
  }

  function db(): Database | null {
    try {
      return deps.crm?.() ?? null;
    } catch {
      return null;
    }
  }

  function status() {
    expireConsent();
    const avg = s.sttMs.length ? Math.round(s.sttMs.reduce((a, b) => a + b, 0) / s.sttMs.length) : null;
    return {
      phase: s.phase, sessionId: s.sessionId, lead: s.lead, leadRef: s.leadRef, script: CONSENT_SCRIPT,
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      elapsedMs: s.startedAt && s.phase === "listening" ? t() - s.startedAt : 0,
      cuesOn: s.cuesOn, cues: s.cues, keepTranscript: s.keepTranscript, chunks: s.chunks, sttAvgMs: avg,
      silentMs: s.phase === "listening" ? t() - (s.lastSpeechAt ?? s.startedAt ?? t()) : 0,
      lastNotesId: s.lastNotesId, error: s.error, cloudCuesOptIn: s.cloudCuesOptIn,
      captureMode: s.captureMode, levels: s.levels,
    };
  }

  /** Label + timestamp only, never the transcript text that triggered it. */
  function logCue(tag: ObjectionTag, source: "local" | "cloud") {
    try {
      deps.store.logCue({ at: now().toISOString(), sessionId: s.sessionId, tag, source });
    } catch {
      /* logging the cue must never break the call */
    }
  }

  function gate(): MeetingGate {
    expireConsent();
    return s.phase === "consent" ? "consent" : s.phase === "listening" ? "listening" : "idle";
  }

  function start(input: { lead?: string | number | null; by?: string } = {}) {
    expireConsent();
    if (s.phase === "listening") throw new MeetingGateError("Meeting mode is already listening. Say \"end meeting\" or \"stop\" first.");
    if (s.phase === "summarising") throw new MeetingGateError("Still writing up the last call.");
    wipe();
    s = fresh();
    s.phase = "consent";
    s.sessionId = `m-${day()}-${random()}`;
    s.askedAt = t();
    s.by = (input.by || "usman").toLowerCase();
    s.leadRef = input.lead === undefined || input.lead === null ? "" : String(input.lead).slice(0, 80);
    const database = s.leadRef ? db() : null;
    if (database) {
      const { lead } = matchLead(database, s.leadRef);
      if (lead) s.lead = { id: lead.id, name: lead.name };
    }
    // Loading the model is not listening: nothing is captured until "they agreed".
    void deps.warm?.().catch(() => undefined);
    // Enumerating devices is not opening a stream either — same boundary. A slow or missing probe
    // just leaves captureMode at "mixed", the existing single-channel behaviour.
    if (deps.probeCapture) {
      const forSession = s.sessionId;
      deps
        .probeCapture()
        .then((mode) => {
          if (s.sessionId === forSession) s.captureMode = mode;
        })
        .catch(() => undefined);
    }
    return {
      ...status(),
      say: `Meeting mode is ready, and I'm not listening yet.${s.lead ? ` Lead: ${s.lead.name}.` : ""} The consent line is on screen. Tell me "they agreed" or "they said no".`,
    };
  }

  function consent(input: { sessionId?: string; answer: "agreed" | "declined"; confirmation?: string; by?: string; channel?: Channel }) {
    expireConsent();
    if (s.phase !== "consent") throw new MeetingGateError("There's no consent question open. Say \"meeting mode\" first.");
    if (input.sessionId && input.sessionId !== s.sessionId) throw new MeetingGateError("That consent answer was for a different call.");
    if (input.answer !== "agreed" && input.answer !== "declined") throw new MeetingGateError("Answer \"agreed\" or \"declined\".");
    const at = now().toISOString();
    deps.store.logConsent({
      at, sessionId: s.sessionId, answer: input.answer, lead: s.lead, leadRef: s.leadRef,
      confirmation: (input.confirmation || (input.answer === "agreed" ? "they agreed" : "they said no")).slice(0, 200),
      by: (input.by || s.by).toLowerCase(), channel: input.channel ?? "hud", audioStored: false,
    });
    if (input.answer === "declined") {
      wipe();
      const lead = s.lead, leadRef = s.leadRef;
      s = fresh();
      s.phase = "declined";
      s.lead = lead;
      s.leadRef = leadRef;
      return { ...status(), say: "Understood. Nothing will be captured. After the call, give me a quick debrief and I'll coach you from that." };
    }
    s.phase = "listening";
    s.consentAt = at;
    s.startedAt = t();
    s.lastSpeechAt = null;
    // Only now — consent is in — may two-channel capture actually open the mic/loopback streams.
    if (s.captureMode === "two-channel") deps.onListeningStart?.(s.sessionId);
    // Silent from here: the client plays its start chime and shows the indicator; no speech.
    return { ...status(), say: "" };
  }

  /**
   * Transcribed text → segments, local cue check, cloud classification. Shared by audio() (one
   * mixed WAV chunk transcribed here, the mixed-mode fallback) and chunk() (pre-transcribed text
   * from two-channel capture, capture.ts — transcribed there against the same local whisper
   * server so there's still exactly one transcription path). Returns the in-call command heard,
   * if any; the caller applies it (applyCommand) and may end up calling stop() itself.
   */
  function ingest(session: string, rawText: string, ms: number, opts: { speaker?: ChunkSpeaker; label?: "me" | "prospect" } = {}) {
    s.chunks++;
    s.sttMs.push(ms);
    let text = rawText.trim();
    const command = text ? inCallCommand(text) : null;
    if (command) text = text.replace(/\bjarvis\b[\s\S]*$/i, "").trim();
    if (text) {
      // Unlabelled (mixed mode, speaker "unknown") segments are stored exactly as before; a
      // two-channel chunk gets a "[me]"/"[prospect]" prefix so the notes, CRM and a kept
      // transcript carry the real speaker, not just the cue-classification path.
      s.segments.push(opts.label ? `[${opts.label}] ${text}` : text);
      s.lastSpeechAt = t();
      if (s.cuesOn) {
        const localCues = cuesFor(text);
        for (const cue of localCues) logCue(cue.tag as ObjectionTag, "local");
        if (localCues.length) s.cues = mergeCues(s.cues, localCues);
      }
      maybeClassifyCloud(session, text, opts.speaker);
      s.lastChunkText = text;
    }
    return command;
  }

  function applyCommand(command: string | null) {
    if (command === "keep_transcript") s.keepTranscript = true;
    else if (command === "cues_on") s.cuesOn = true;
    else if (command === "cues_off") (s.cuesOn = false), (s.cues = []);
    else if (command === "cloud_cues_on") setCloudCues(true, { disclosed: true });
    else if (command === "cloud_cues_off") setCloudCues(false);
  }

  async function audio(input: { sessionId?: string; audio?: string }) {
    if (s.phase !== "listening" || !input.sessionId || input.sessionId !== s.sessionId)
      throw new MeetingGateError("Not listening: meeting mode only accepts audio after the other party has agreed.");
    if (typeof input.audio !== "string" || input.audio.length > MAX_CHUNK * 1.4) throw new Error("Send one audio chunk of a few seconds.");
    const bytes = new Uint8Array(Buffer.from(input.audio, "base64"));
    const session = s.sessionId;
    let heard: { text: string; ms: number };
    try {
      if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") throw new Error("Audio must be a WAV chunk.");
      heard = await deps.transcribe(bytes);
    } finally {
      bytes.fill(0); // the chunk is gone once it's been heard
    }
    // Stopped or ended while this chunk was being transcribed: drop it.
    if (s.phase !== "listening" || s.sessionId !== session) return { ...status(), command: null, dropped: true };
    const command = ingest(session, heard.text, heard.ms);
    applyCommand(command);
    if (command === "stop") return { ...stop(session), command };
    return { ...status(), command, sttMs: heard.ms };
  }

  /**
   * A pre-transcribed chunk from two-channel capture (capture.ts, dual_capture.py): the mic
   * ("me") and a WASAPI loopback of the system output ("prospect") are captured and transcribed
   * as two independent streams, so a real speaker label reaches objection-jev.ts instead of the
   * "unknown" default. Same gate as audio(): only accepted while listening, for this session.
   */
  function chunk(input: { sessionId?: string; speaker?: "me" | "prospect"; text?: string; ms?: number }) {
    if (s.phase !== "listening" || !input.sessionId || input.sessionId !== s.sessionId)
      throw new MeetingGateError("Not listening: meeting mode only accepts audio after the other party has agreed.");
    const session = s.sessionId;
    const label: "me" | "prospect" = input.speaker === "prospect" ? "prospect" : "me";
    const speaker: ChunkSpeaker = label === "prospect" ? "prospect" : "founder";
    const command = ingest(session, String(input.text ?? ""), Number(input.ms) || 0, { speaker, label });
    applyCommand(command);
    if (command === "stop") return { ...stop(session), command };
    return { ...status(), command };
  }

  /** Set by capture.ts: the probe's guess, or a runtime downgrade if a stream that looked
   *  available couldn't actually be opened once listening began. */
  function setCaptureMode(mode: CaptureMode) {
    s.captureMode = mode;
  }

  /** Live input levels for the HUD's two meters, 0..1. UI-only — never logged or persisted. */
  function setLevels(me: number, prospect: number) {
    s.levels = { me: clamp01(me), prospect: clamp01(prospect) };
  }

  /**
   * Fire-and-forget cloud classification (candidate #2): never awaited by audio() itself, so a
   * slow or failed call can't add latency to transcription. The result is only applied if the
   * session is still the same one, still listening, and no newer chunk has landed in the
   * meantime (chunkSeq check) — a stale result is silently discarded, never shown late.
   */
  function maybeClassifyCloud(session: string, text: string, speakerOverride?: ChunkSpeaker) {
    if (!s.cuesOn || !s.cloudCuesOptIn || !deps.cloudClassify) return;
    s.chunkSeq++;
    const mySeq = s.chunkSeq;
    const chunkId = `${session}-${mySeq}`;
    const previousChunkText = s.lastChunkText;
    const capturedAt = now().toISOString();
    // chunk() (two-channel capture) already knows who's talking; audio() (mixed mode) falls back
    // to the deps.speakerOf default, "unknown" — which correctly makes classifyObjectionCues()
    // abstain, exactly as before this feature existed.
    const speaker = speakerOverride ?? (deps.speakerOf ?? (() => "unknown" as const))(text, s.segments);
    const localTags = s.cuesOn ? cuesFor(text).map((c) => c.tag) : [];
    const started = Date.now();
    deps
      .cloudClassify({ sessionId: session, chunkId, capturedAt, speaker, text, previousChunkText })
      .then((result) => {
        if (deps.shadowRoot) {
          recordDecisionShadow(deps.shadowRoot, {
            caseId: chunkId, useCase: "meeting-cues", timestamp: capturedAt, inputHash: hashInput(text),
            questionVersion: "objection-cues-v1", model: JEV_MODEL,
            baselineDecision: localTags, proposedDecision: result?.suggestedTags ?? null,
            rawAnswers: result?.answers ?? null, elapsedMs: result?.ms ?? Date.now() - started,
            error: result ? null : "abstained-or-failed", policyVersion: "meeting-cues-v1",
          });
        }
        if (!result || s.phase !== "listening" || s.sessionId !== session || s.chunkSeq !== mySeq) return; // stale, ended, or nothing to show
        const due = result.suggestedTags.filter((tag) => (s.cueCooldownUntil[tag] ?? 0) <= t());
        if (!due.length) return;
        for (const tag of due) {
          s.cueCooldownUntil[tag] = t() + CUE_COOLDOWN_MS;
          logCue(tag, "cloud");
        }
        s.cues = mergeCues(s.cues, due.map(cueForTag));
      })
      .catch(() => undefined);
  }

  function setCues(on: boolean) {
    s.cuesOn = !!on;
    if (!on) s.cues = [];
    return status();
  }

  /**
   * Cloud cues send speech to Jev's cloud API — a distinct action from local-recording consent,
   * so turning it on requires an explicit disclosure confirmation (the "I've told them, cloud
   * cues on" phrase itself, or the HUD's own disclosure prompt setting `disclosed: true`), never
   * just flipping `cuesOn`.
   */
  function setCloudCues(on: boolean, opts: { disclosed?: boolean } = {}) {
    if (s.phase !== "listening" && s.phase !== "consent")
      throw new MeetingGateError("Cloud cues only apply during a call. Say \"meeting mode\" first.");
    if (on && !opts.disclosed)
      throw new MeetingGateError(
        "Cloud cues need an explicit disclosure to the other party first — sending their words to Jev's cloud API isn't covered by the local recording consent alone.",
      );
    s.cloudCuesOptIn = !!on;
    const at = now().toISOString();
    s.cloudCuesDisclosedAt = on ? at : null;
    deps.store.logCloudCuesOptIn({ at, sessionId: s.sessionId, on: !!on, by: s.by });
    return { ...status(), say: on ? "Cloud cues on — I've noted the disclosure." : "Cloud cues off." };
  }

  function keepTranscript(on = true) {
    if (s.phase !== "listening" && s.phase !== "consent") throw new MeetingGateError("Say \"keep the transcript\" during the call it applies to.");
    s.keepTranscript = on;
    return { ...status(), say: on ? "I'll keep this call's transcript." : "The transcript will be discarded as usual." };
  }

  /** Stop at once and keep nothing from the call (consent withdrawn, wrong call, anything). */
  function stop(sessionId?: string) {
    if (sessionId && s.sessionId && sessionId !== s.sessionId) return { ...status(), say: "" };
    const was = s.phase;
    if (was === "listening") deps.onListeningEnd?.();
    wipe();
    s = fresh();
    return {
      ...status(),
      say: was === "listening" || was === "failed" ? "Stopped. Nothing from that call was kept." : was === "consent" ? "Meeting mode cancelled." : "Meeting mode is off.",
    };
  }

  function recordCrm(notes: MeetingNotes, leadRef?: string | number | null) {
    const database = db();
    if (!database) {
      notes.crm.detail = "CRM unavailable";
      return notes;
    }
    const ref = leadRef ?? (notes.lead ? notes.lead.id : null);
    const { lead, detail } = matchLead(database, ref, notes.crm.leadGuess);
    if (!lead) {
      notes.crm.detail = `not logged: ${detail}. Pick the lead to log it.`;
      return notes;
    }
    const result = applyNotes(database, notes, lead);
    notes.lead = result.lead;
    notes.crm.applied = true;
    notes.crm.detail = result.detail;
    return notes;
  }

  function finish(notes: MeetingNotes) {
    deps.store.saveNotes(notes);
    s.lastNotesId = notes.id;
    return { notes, markdown: renderNotes(notes), say: notes.recap };
  }

  async function end(input: { sessionId?: string; keepTranscript?: boolean } = {}) {
    if (s.phase !== "listening" && s.phase !== "failed") throw new MeetingGateError("Meeting mode isn't running.");
    if (input.sessionId && input.sessionId !== s.sessionId) throw new MeetingGateError("That was a different call.");
    if (s.phase === "listening") deps.onListeningEnd?.();
    const keep = !!input.keepTranscript || s.keepTranscript;
    const durationMs = s.startedAt ? t() - s.startedAt : null;
    s.phase = "summarising";
    const material = s.segments.join("\n");
    if (!material.trim()) {
      wipe();
      s.phase = "done";
      return { ...status(), notes: null, markdown: "", say: "I didn't hear anything I could transcribe, so there are no notes. Check the microphone placement." };
    }
    let notes: MeetingNotes;
    try {
      notes = await coachCall(deps.llm, {
        id: s.sessionId, source: "meeting", material, by: s.by, lead: s.lead, durationMs, transcriptKept: keep, consentAt: s.consentAt, now: now(),
      });
    } catch (error) {
      // The transcript stays in RAM only, so "end meeting" can retry; "stop" still wipes it.
      s.phase = "failed";
      s.error = (error as Error).message;
      return { ...status(), notes: null, markdown: "", say: `I couldn't write the notes: ${s.error.slice(0, 120)}. Say "end meeting" to try again, or "stop" to discard.` };
    }
    if (keep) deps.store.saveTranscript(notes.id, material);
    wipe();
    recordCrm(notes);
    const out = finish(notes);
    s.phase = "done";
    s.error = "";
    return { ...status(), ...out };
  }

  const stableId = (prefix: string, text: string) => `${prefix}-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

  /** Coaching from his own recount: no capture at all (the "they said no" route, and Telegram). */
  async function debrief(input: { text: string; lead?: string | number | null; by?: string }) {
    const text = String(input.text ?? "").trim();
    if (text.length < 12) throw new Error("Tell me a bit more about how the call went.");
    const database = db();
    const matched = input.lead !== undefined && input.lead !== null && database ? matchLead(database, input.lead).lead : null;
    const lead = matched ? { id: matched.id, name: matched.name } : s.phase === "declined" ? s.lead : null;
    const notes = await coachCall(deps.llm, {
      id: stableId("debrief", `${input.by ?? ""}|${input.lead ?? ""}|${text}`), source: "debrief", material: text, by: input.by || "usman", lead, now: now(),
    });
    recordCrm(notes, input.lead ?? lead?.id ?? null);
    if (s.phase === "declined") s = fresh();
    return finish(notes);
  }

  /** The Granola route (Zoom/Meet): the same coaching and CRM update as meeting mode. */
  async function granola(input: { query?: string; lead?: string | number | null; by?: string } = {}) {
    if (!deps.recentGranola) throw new Error("Granola isn't connected. Reconnect it in Memory, or use the meeting-wrap-up skill.");
    const { documents } = await deps.recentGranola();
    if (!documents.length) throw new Error("No Granola meetings from this week.");
    const terms = (String(input.query ?? "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !["with", "the", "call", "meeting", "last", "granola"].includes(w));
    const pick = terms.length
      ? documents.map((d) => ({ d, score: terms.filter((w) => (d.title + " " + d.text).toLowerCase().includes(w)).length })).sort((a, b) => b.score - a.score)[0]
      : { d: documents[0], score: 1 };
    if (!pick || pick.score === 0) throw new Error(`No recent Granola meeting mentions "${input.query}".`);
    const doc = pick.d;
    const database = db();
    const matched = input.lead !== undefined && input.lead !== null && database ? matchLead(database, input.lead).lead : null;
    const notes = await coachCall(deps.llm, {
      id: stableId("granola", doc.id), source: "granola", material: `Meeting: ${doc.title}\n${doc.text}`, by: input.by || "usman",
      lead: matched ? { id: matched.id, name: matched.name } : null, now: now(),
    });
    notes.title = notes.title || doc.title;
    recordCrm(notes, input.lead ?? null);
    return finish(notes);
  }

  /** Log notes that couldn't be matched to a lead automatically. Idempotent. */
  function logToLead(input: { notesId: string; lead: string | number }) {
    const notes = deps.store.notes(input.notesId);
    if (!notes) throw new Error("No notes with that id.");
    recordCrm(notes, input.lead);
    if (!notes.crm.applied) throw new Error(notes.crm.detail);
    return finish(notes);
  }

  return {
    status, gate, start, consent, audio, chunk, setCaptureMode, setLevels, setCues, setCloudCues, keepTranscript,
    stop, end, debrief, granola, logToLead, _state: () => s,
  };
}

export type MeetingMode = ReturnType<typeof meetingMode>;
export type { Source };
