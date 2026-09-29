// The live mic path for "narrate my workflow": spawns narrate_capture.py (mic only — no WASAPI
// loopback, unlike dual_capture.py, since this is solo speech to Jarvis, not a call), transcribes
// each chunk with the same local whisper server meeting mode uses, and drives narrate.ts's pure
// session state machine. Nothing here writes audio to disk: chunks arrive as base64 WAV over a
// pipe, get decoded into memory, transcribed, and dropped — the same "never on disk" guarantee
// capture.ts documents for meeting mode, and stronger than "delete after transcription" since the
// file never exists in the first place. The file-input test path (transcribeAndDeleteFile, for the
// synthetic-narration test and for manual smoke testing with a pre-recorded clip) still deletes
// its temporary file as documented in narrate.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { localTranscriber, MEETING_HOME } from "./transcriber";
import { claudeBridge } from "../claude-bridge";
import {
  appendChunk, finishNarration, generateSkillDraft, isNarrationStopPhrase, RECORDING_INDICATOR,
  startNarration, transcriptOf, type ClaudeComplete, type NarrationSession, type SkillDraftContent,
} from "./narrate";
import { saveDraft, type SkillDraft } from "./narrate-store";
import type { RoutedChatDeps } from "../model-router/chat";
import type { HealthStore } from "../model-router/health";
import type { ReceiptSink } from "../model-router/receipts";

type Whisper = { transcribe: (wav: Uint8Array) => Promise<{ text: string; ms: number }> };
type Spawner = typeof spawn;
export type NarrateGate = "idle" | "recording";

export type NarrateServiceDeps = {
  operatorData: string;
  whisper: Whisper;
  complete: ClaudeComplete;
  model?: string;
  /** Model-router plumbing for the draft call (tests: env/home fakes, in-memory sink and health). */
  chat?: RoutedChatDeps;
  sink?: ReceiptSink;
  health?: HealthStore;
  python?: string;
  spawner?: Spawner;
  /** Shown wherever the caller puts a recording indicator — HUD, toast, spoken line. Required: a
   *  clear "I'm listening" signal is not optional for solo mic capture. */
  onIndicator: (text: string) => void;
  /** The finished draft, once the transcript has been turned into one (or the error, if the
   *  bridge/transcription failed) — the caller shows this, e.g. via skill-draft-review.tsx. */
  onDraft?: (draft: SkillDraft) => void;
  onError?: (message: string) => void;
};

export function narrateService(root: string, deps: NarrateServiceDeps) {
  const spawner = deps.spawner ?? spawn;
  const python = deps.python ?? join(MEETING_HOME, "venv", "Scripts", "python.exe");
  const script = join(root, "scripts", "meeting-mode", "narrate_capture.py");
  let child: ChildProcess | null = null;
  let session: NarrationSession | null = null;

  const gate = (): NarrateGate => (session && session.status === "recording" ? "recording" : "idle");

  async function onChunkText(text: string) {
    if (!session || session.status !== "recording") return;
    session = appendChunk(session, text);
    if (isNarrationStopPhrase(text)) await finish();
  }

  async function onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "error") {
      deps.onError?.(String(msg.message ?? "narrate_capture.py error"));
      return;
    }
    if (msg.type !== "chunk") return; // "level" updates are for a HUD meter, not handled here
    const wav = Buffer.from(String(msg.wav ?? ""), "base64");
    if (wav.length < 44) return; // not a real WAV
    let heard: { text: string };
    try {
      heard = await deps.whisper.transcribe(new Uint8Array(wav));
    } catch (error) {
      deps.onError?.(`Transcription failed: ${(error as Error).message}`);
      return;
    } finally {
      wav.fill(0); // gone the moment it's been heard — same as every other meeting-mode path
    }
    const text = heard.text.trim();
    if (text) await onChunkText(text);
  }

  function stopCapture() {
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    child = null;
  }

  /** "Jarvis, I'm going to walk you through how I do X." Refuses a second narration while one is
   *  already recording, rather than silently mixing two transcripts. */
  function start(topic: string): string {
    if (gate() === "recording") return "I'm already recording a walkthrough — say \"that's it\" first.";
    session = startNarration(topic);
    child = spawner(python, [script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => void onLine(line));
    child.on("error", (error) => {
      deps.onError?.((error as Error).message);
      child = null;
    });
    child.on("close", () => {
      child = null;
    });
    const indicator = RECORDING_INDICATOR(topic);
    deps.onIndicator(indicator);
    return indicator;
  }

  /** "That's it" (auto, mid-capture) or an explicit stop command: ends the recording, drafts the
   *  skill from whatever was heard, and saves it — never installs it (see narrate-store.ts). */
  async function finish(): Promise<SkillDraft | null> {
    if (!session) return null;
    stopCapture();
    const finished = finishNarration(session);
    session = null;
    deps.onIndicator("Stopped recording. Drafting a skill from the walkthrough…");
    const transcript = transcriptOf(finished);
    try {
      const content: SkillDraftContent = await generateSkillDraft({ complete: deps.complete, model: deps.model, chat: deps.chat, sink: deps.sink, health: deps.health, root }, finished.topic, transcript);
      const draft = saveDraft(deps.operatorData, content, finished.topic, transcript);
      deps.onDraft?.(draft);
      return draft;
    } catch (error) {
      deps.onError?.((error as Error).message);
      return null;
    }
  }

  /** Explicit "stop"/"cancel the walkthrough" — same as the stop phrase, exposed for a rule other
   *  than isNarrationStopPhrase to trigger (e.g. a client-side cancel button). */
  async function stop(): Promise<SkillDraft | null> {
    return finish();
  }

  return { gate, start, stop, finish };
}

export type NarrateService = ReturnType<typeof narrateService>;

/** Wraps a narrateService for free-voice.ts's `narrate` tool: `{action:"start", topic}` /
 *  `{action:"stop"}` in, the line to speak out — the same "rules already computed the answer"
 *  shape as meeting mode's tool result (see protocolFollowUp in scripts/free-voice.ts). */
export async function handleNarrateCall(service: NarrateService, args: { action: "start" | "stop"; topic?: string }): Promise<string> {
  if (args.action === "start") return service.start((args.topic ?? "").trim() || "a workflow");
  const draft = await service.stop();
  return draft
    ? `Got it. I've drafted a skill called "${draft.title}" with ${draft.steps.length} step${draft.steps.length === 1 ? "" : "s"}. Review it before it's built — nothing was installed.`
    : "I stopped recording, but there was nothing to draft a skill from.";
}

export type NarrateStatus = { gate: NarrateGate; indicator: string | null; lastDraftId: string | null; lastError: string | null };

/** Wired for real use in scripts/operator-plugin.ts: the real local whisper server (same one
 *  meeting mode uses) and the real Claude bridge (/__claude). `status()` is what a future HUD
 *  indicator or the voice client polls — kept here, not pushed through jarvis-events, so this
 *  stays independent of that queue's own dedupe/budget rules. */
export function narrateFullService(root: string, operatorData: string) {
  const whisper = localTranscriber(root);
  const bridge = claudeBridge();
  let status: NarrateStatus = { gate: "idle", indicator: null, lastDraftId: null, lastError: null };
  const service = narrateService(root, {
    operatorData,
    whisper,
    complete: bridge.complete,
    onIndicator: (text) => { status = { ...status, gate: service.gate(), indicator: text }; },
    onDraft: (draft) => { status = { ...status, gate: "idle", lastDraftId: draft.id, lastError: null }; },
    onError: (message) => { status = { ...status, gate: "idle", lastError: message }; },
  });
  return { ...service, status: () => status };
}
export type NarrateFullService = ReturnType<typeof narrateFullService>;
