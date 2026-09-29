// Two-channel capture for meeting mode (docs/MEETING-MODE.md, "Two-channel capture"). A
// Windows-only child process (dual_capture.py) records the default microphone ("me") and a
// WASAPI loopback of the default output device ("prospect": whatever Zoom/Meet/Teams/a softphone
// is playing) as two independent streams, so real speaker labels reach objection-jev.ts instead
// of the "unknown" default that made it abstain on every real call.
//
// Boundaries this module holds, mirroring the mixed-mode browser capture it sits alongside:
// - probe() only enumerates devices — it never opens a stream, so it's safe to run before
//   consent (session.ts calls it from start(), while the consent question is still open).
// - start() is only ever called by session.ts once "they agreed" (onListeningStart).
// - Nothing here writes audio to disk. Each chunk is base64 WAV over a pipe, transcribed by the
//   same local whisper server as the browser's mixed-mode path (deps.whisper — one transcription
//   path, not two), then the raw bytes are dropped.
// - The mic also hears the speakers. If a "me" chunk's text closely matches a "prospect" chunk
//   transcribed moments earlier, it's bleed, not the founder's own words — dropped, never sent on.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { MEETING_HOME } from "./transcriber";
import type { CaptureMode, MeetingMode } from "./session";

type Whisper = { transcribe: (wav: Uint8Array) => Promise<{ text: string; ms: number }> };
type Spawner = typeof spawn;

/** Word-set Dice coefficient: cheap, order-independent, good enough to catch "the mic just heard
 *  the same sentence the loopback did" without needing a real alignment. */
function similarity(a: string, b: string): number {
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Above this Dice score, and within BLEED_WINDOW_MS of each other, a "me" chunk is treated as
 *  the prospect's voice bleeding through the speakers into the mic, not the founder talking. */
export const BLEED_SIMILARITY = 0.72;
export const BLEED_WINDOW_MS = 3000;

export function dualCapture(
  root: string,
  deps: { whisper: Whisper; meeting: () => MeetingMode; python?: string; spawner?: Spawner; onError?: (message: string) => void },
) {
  const spawner = deps.spawner ?? spawn;
  const python = deps.python ?? join(MEETING_HOME, "venv", "Scripts", "python.exe");
  const script = join(root, "scripts", "meeting-mode", "dual_capture.py");
  let child: ChildProcess | null = null;
  let lastProspect: { text: string; at: number } | null = null;

  /** Device enumeration only (docs/MEETING-MODE.md's "the mic isn't even opened" boundary) —
   *  never opens a stream. Safe to call while consent is still pending. */
  async function probe(): Promise<CaptureMode> {
    try {
      const out = await new Promise<{ ok?: boolean }>((resolve, reject) => {
        const p = spawner(python, [script, "--probe"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        let buf = "";
        const timer = setTimeout(() => {
          p.kill();
          reject(new Error("probe timed out"));
        }, 4000);
        p.stdout?.on("data", (d) => (buf += String(d)));
        p.on("close", () => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(buf.trim().split("\n").filter(Boolean).pop() || "{}"));
          } catch (error) {
            reject(error);
          }
        });
        p.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      return out.ok ? "two-channel" : "mixed";
    } catch {
      return "mixed";
    }
  }

  async function onLine(sessionId: string, line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const meeting = deps.meeting();
    if (msg.type === "mode") {
      meeting.setCaptureMode(msg.mode === "two-channel" ? "two-channel" : "mixed");
      return;
    }
    if (msg.type === "level") {
      meeting.setLevels(Number(msg.me) || 0, Number(msg.prospect) || 0);
      return;
    }
    if (msg.type === "error") {
      deps.onError?.(String(msg.message ?? "dual_capture.py error"));
      return;
    }
    if (msg.type !== "chunk" || (msg.speaker !== "me" && msg.speaker !== "prospect")) return;
    const speaker = msg.speaker as "me" | "prospect";
    const wav = Buffer.from(String(msg.wav ?? ""), "base64");
    if (wav.length < 44) return; // not a real WAV — never send it on
    let heard: { text: string; ms: number };
    try {
      heard = await deps.whisper.transcribe(new Uint8Array(wav));
    } catch {
      return; // a transcription failure on one channel must never break the call
    } finally {
      wav.fill(0); // gone once it's been heard, same as every other path here
    }
    const text = heard.text.trim();
    if (!text) return;
    const at = Number(msg.cutAt) || Date.now();
    if (speaker === "prospect") {
      lastProspect = { text, at };
    } else if (lastProspect && Math.abs(lastProspect.at - at) <= BLEED_WINDOW_MS && similarity(lastProspect.text, text) >= BLEED_SIMILARITY) {
      return; // dropped: the mic heard the prospect's voice through the speakers, not the founder
    }
    try {
      meeting.chunk({ sessionId, speaker, text, ms: heard.ms });
    } catch {
      /* the call may have ended between this chunk landing and here */
    }
  }

  function start(sessionId: string) {
    if (child) return;
    lastProspect = null;
    const proc = spawner(python, [script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HF_HOME: join(MEETING_HOME, "hf") },
    });
    child = proc;
    if (proc.stdout) createInterface({ input: proc.stdout }).on("line", (line) => void onLine(sessionId, line));
    proc.on("close", () => {
      if (child === proc) child = null;
    });
    proc.on("error", (error) => {
      deps.onError?.((error as Error).message);
      if (child === proc) child = null;
    });
  }

  function stop() {
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    child = null;
    lastProspect = null;
  }

  return { probe, start, stop };
}

export type DualCapture = ReturnType<typeof dualCapture>;
