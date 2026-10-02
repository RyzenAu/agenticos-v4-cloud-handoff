#!/usr/bin/env bun
// Meeting mode live test, SYNTHETIC ONLY (docs/MEETING-MODE.md, "Verification"). Never point this
// at a real call.
//
// 1. Generates a two-voice mock cold call with Groq TTS (Orpheus: daniel = the founder, hannah =
//    a fictional practice manager at a fictional practice).
// 2. Baseline: the clean audio, chunked and sent straight to the local transcriber.
// 3. Live: plays it out of a speaker while meeting mode listens on the microphone, through the
//    real consent gate, local transcriber, subscription coach and a throwaway CRM.
// 4. Reports word error rate and latency, and writes the notes to Downloads.
//
//   bun scripts/meeting-mode/live-test.ts [--in 1] [--out 24] [--skip-live] [--show-heard] [--debug]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { providerKey } from "../provider-config";
import { httpProviderError } from "../model-router/clients";
import { defaultReceiptSink } from "../model-router/defaults";
import { MemoryHealthStore } from "../model-router/health";
import { runRouted } from "../model-router/router";
import { openCrm, upsertLead } from "../leads/crm";
import { renderNotes } from "./coach";
import { subscriptionLlm } from "./llm";
import { meetingMode } from "./session";
import { meetingStore } from "./store";
import { localTranscriber, MEETING_HOME } from "./transcriber";
import { dataDirFor } from "../cloud/data-dir";

const ROOT = resolve(import.meta.dir, "..", "..");
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

// A fictional practice and fictional people.
const DIALOGUE: Array<["usman" | "prospect", string]> = [
  ["prospect", "Good morning, Kookaburra Lane Dental, this is Priya speaking."],
  ["usman", "Hi Priya, it's Usman from M and U Ventures. We build websites and an AI receptionist for dental practices. Have you got a quick minute?"],
  ["prospect", "Um, I've got about two minutes before my next patient arrives. What's it about?"],
  ["usman", "Sure. We answer the phone when your front desk can't, so new patients don't go to voicemail. We can have it live within a week."],
  ["prospect", "Right. Well, we do miss a fair few calls at lunchtime, and after five when the front desk goes home."],
  ["usman", "Our receptionist books the appointment straight into your system, and it sounds really natural. Most practices love it."],
  ["prospect", "Okay, but how much does it cost? We're a small practice and money is tight at the moment."],
  ["usman", "It's four hundred and ninety nine dollars a month, and there's a setup fee of one thousand five hundred dollars."],
  ["prospect", "Hmm, that sounds too expensive for us, to be honest. We already have a receptionist."],
  ["usman", "I understand. It works alongside your receptionist, it doesn't replace her. It just catches the calls she can't get to."],
  ["prospect", "I'd have to talk to Doctor Chen about it. Can you just send me some info by email?"],
  ["usman", "Of course, I'll send some information through today. What's the best email for you?"],
  ["prospect", "It's reception at kookaburra lane dental dot com dot au."],
  ["usman", "Great, I'll send that through this afternoon. Thanks so much for your time, Priya."],
  ["prospect", "No worries, thanks, bye."],
  ["usman", "Jarvis, end meeting."],
];
const REFERENCE = DIALOGUE.slice(0, -1).map(([, line]) => line).join(" ");

function words(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\bm and u\b/g, "m&u").split(/\s+/).filter(Boolean);
}
/** Word error rate: word-level edit distance / reference length. */
export function wer(reference: string, hypothesis: string) {
  const r = words(reference), h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

function pcmOf(wav: Uint8Array): { pcm: Float32Array; rate: number } {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let rate = 24000, off = 12;
  while (off < wav.length - 8) {
    const id = String.fromCharCode(...wav.subarray(off, off + 4)), size = v.getUint32(off + 4, true);
    if (id === "fmt ") rate = v.getUint32(off + 12, true);
    if (id === "data") {
      const n = Math.min(size, wav.length - off - 8) >> 1;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = v.getInt16(off + 8 + i * 2, true) / 32768;
      return { pcm, rate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error("No PCM in WAV");
}
function resample(x: Float32Array, from: number, to: number) {
  if (from === to) return x;
  const out = new Float32Array(Math.floor((x.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const p = (i * from) / to, a = Math.floor(p), f = p - a;
    out[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? 0) * f;
  }
  return out;
}
function wavOf(pcm: Float32Array, rate = 16000) {
  const out = new Uint8Array(44 + pcm.length * 2), v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  ascii(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); ascii(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return out;
}

/** The page's chunker (src/lib/meeting-mode.ts): ≥8 s on a 0.5 s pause, a phrase then 1.2 s quiet, or 18 s. */
function chunker(onChunk: (pcm: Float32Array) => void) {
  const rate = 16000, block = 1600;
  let buf: number[] = [], quiet = 0, voiced = 0, floor = 0.002;
  const flush = () => {
    if (voiced * block > rate * 0.4) onChunk(Float32Array.from(buf));
    buf = [], (quiet = 0), (voiced = 0);
  };
  return {
    push(samples: Float32Array) {
      for (let i = 0; i < samples.length; i += block) {
        const part = samples.subarray(i, i + block);
        let s = 0;
        for (const x of part) s += x * x;
        const rms = Math.sqrt(s / part.length);
        if (rms > Math.max(0.004, floor * 3)) (voiced++, (quiet = 0));
        else (quiet += part.length), (floor = floor * 0.98 + rms * 0.02);
        for (const x of part) buf.push(x);
        const secs = buf.length / rate;
        if ((secs >= 8 && quiet >= rate * 0.5) || (secs >= 1.5 && quiet >= rate * 1.2) || secs >= 18) flush();
      }
    },
    flush,
  };
}
/** Stand-in for the browser's autoGainControl on a quiet speaker-to-mic path. */
function normalise(pcm: Float32Array) {
  let peak = 0;
  for (const x of pcm) peak = Math.max(peak, Math.abs(x));
  const g = peak > 0 ? Math.min(40, 0.6 / peak) : 1;
  return pcm.map((x) => x * g);
}

async function tts(line: string, voice: string, key: string): Promise<Uint8Array> {
  // Synthetic lines are cached between runs (Orpheus allows 10 a minute and 100 a day).
  const cache = join(tmpdir(), "meeting-live-tts-cache");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${voice}-${Bun.hash(line).toString(16)}.wav`);
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  for (let attempt = 0; attempt < 6; attempt++) {
    const out = await ttsOnce(line, voice, key);
    if (out) return writeFileSync(file, out), out;
    await new Promise((r) => setTimeout(r, 12_000));
  }
  throw new Error("Groq TTS stayed rate-limited.");
}

/** One synthetic line through the router (voice.tts, Groq Orpheus from the catalogue, data class
 *  synthetic), with a receipt. null = rate-limited (the caller waits and retries, as before). */
async function ttsOnce(line: string, voice: string, key: string): Promise<Uint8Array | null> {
  let limited = false;
  let failure: Error | null = null;
  try {
    const run = await runRouted<Uint8Array>({
      task: "voice.tts",
      caller: "scripts/meeting-mode/live-test (synthetic call)",
      sink: defaultReceiptSink(ROOT),
      constraints: { providers: ["groq"], hasKey: () => !!key, health: new MemoryHealthStore() },
      invoke: async (choice, signal) => {
        const r = await fetch("https://api.groq.com/openai/v1/audio/speech", {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: choice.providerModel, voice, input: line, response_format: "wav" }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        if (r.status === 429) {
          limited = true;
          throw httpProviderError(429, "");
        }
        if (!r.ok) {
          failure = new Error(`Groq TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
          throw httpProviderError(r.status, "");
        }
        return { value: new Uint8Array(await r.arrayBuffer()), providerModel: choice.providerModel, usage: { characters: line.length } };
      },
    });
    return run.value;
  } catch (error) {
    if (limited) return null;
    throw failure ?? error;
  }
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "meeting-live-"));
  const key = providerKey(ROOT, "GROQ_API_KEY");
  if (!key) throw new Error("GROQ_API_KEY is not configured.");
  console.log(`Generating ${DIALOGUE.length} synthetic lines with Groq TTS…`);
  const parts: Float32Array[] = [];
  for (const [who, line] of DIALOGUE) {
    const { pcm, rate } = pcmOf(await tts(line, who === "usman" ? "daniel" : "hannah", key));
    parts.push(resample(pcm, rate, 16000), new Float32Array(16000 * 0.7));
  }
  const call = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) call.set(p, at), (at += p.length);
  const callSeconds = call.length / 16000;
  const synthetic = join(scratch, "synthetic-call.wav");
  writeFileSync(synthetic, wavOf(call)); // synthetic role-play only, deleted at the end

  const whisper = localTranscriber(ROOT);
  const warmStart = Date.now();
  const warm = (await whisper.warm()) as { model: string; device: string };
  console.log(`Transcriber: ${warm.model} on ${warm.device} (ready in ${Date.now() - warmStart} ms)`);

  // Baseline: the same chunker on the clean audio, no speaker or room.
  const cleanChunks: Float32Array[] = [];
  const c = chunker((pcm) => cleanChunks.push(pcm));
  c.push(call);
  c.flush();
  const cleanTexts: string[] = [], cleanMs: number[] = [];
  for (const pcm of cleanChunks) {
    const out = await whisper.transcribe(wavOf(pcm));
    cleanTexts.push(out.text), cleanMs.push(out.ms);
    if (process.argv.includes("--debug")) console.log(`  clean chunk ${(pcm.length / 16000).toFixed(1)} s: ${out.text}`);
  }
  const cleanHyp = cleanTexts.join(" ").replace(/jarvis[, ]+end (the )?meeting\.?/i, "");
  const cleanWer = wer(REFERENCE, cleanHyp);
  console.log(`Clean WER ${(cleanWer * 100).toFixed(1)}% over ${cleanChunks.length} chunks, mean ${Math.round(cleanMs.reduce((a, b) => a + b, 0) / cleanMs.length)} ms/chunk`);

  const report: string[] = [];
  let notesMd = "";
  let liveLine = "Live speaker-to-mic run skipped.";
  if (!process.argv.includes("--skip-live")) {
    const dataRoot = mkdtempSync(join(tmpdir(), "meeting-live-data-"));
    const db = openCrm(join(dataRoot, "crm.sqlite"));
    upsertLead(db, {
      placeId: "synthetic-kookaburra", name: "Kookaburra Lane Dental", vertical: "dental", area: "Synthetic NSW", address: "", website: "", mapsUrl: "",
      rating: null, reviews: null, emails: [], emailOk: false, score: 60, pitch: "receptionist", reasons: [], googleAt: null, phone: "",
    });
    const meeting = meetingMode({ store: meetingStore(dataRoot), transcribe: (w) => whisper.transcribe(w), llm: subscriptionLlm(), crm: () => db });
    const { sessionId } = meeting.start({ lead: "Kookaburra Lane Dental", by: "usman" });
    meeting.consent({ sessionId, answer: "agreed", confirmation: "synthetic role-play (no real person)", channel: "cli" });
    meeting.keepTranscript(true); // kept only so this test can measure accuracy
    const latencies: number[] = [];
    let ended = false;
    const pending: Promise<void>[] = [];
    let chain = Promise.resolve();
    const live = chunker((pcm) => {
      const cutAt = Date.now();
      const wav = wavOf(normalise(pcm));
      chain = chain.then(async () => {
        if (ended || meeting.status().phase !== "listening") return;
        if (process.argv.includes("--debug")) console.log(`  live chunk ${(pcm.length / 16000).toFixed(1)} s: ${(await whisper.transcribe(wav)).text}`);
        const out = await meeting.audio({ sessionId, audio: Buffer.from(wav).toString("base64") });
        latencies.push(Date.now() - cutAt);
        if (out.command === "end") ended = true;
      });
      pending.push(chain);
    });
    console.log(`Playing ${callSeconds.toFixed(0)} s through output ${flag("out", "24")} into input ${flag("in", "1")}…`);
    const python = join(MEETING_HOME, "venv", "Scripts", "python.exe");
    const child = spawn(python, [join(import.meta.dir, "play_and_listen.py"), synthetic, flag("in", "1"), flag("out", "24"), "3"], { stdio: ["ignore", "pipe", "inherit"] });
    let carry = Buffer.alloc(0);
    let peak = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      const all = Buffer.concat([carry, chunk]);
      const n = all.length >> 1;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) (pcm[i] = all.readInt16LE(i * 2) / 32768), (peak = Math.max(peak, Math.abs(pcm[i])));
      carry = all.subarray(n * 2);
      live.push(pcm);
    });
    const callEnd = await new Promise<number>((r) => child.on("close", () => r(Date.now())));
    live.flush();
    await Promise.all(pending);
    const summaryStart = Date.now();
    const out = await meeting.end();
    const summaryMs = Date.now() - summaryStart;
    const keptFile = readdirSync(join(dataDirFor(dataRoot), "meeting-mode", "notes")).find((f) => f.endsWith(".transcript.txt"));
    const liveHyp = keptFile ? readFileSync(join(dataDirFor(dataRoot), "meeting-mode", "notes", keptFile), "utf8") : "";
    const liveWer = wer(REFERENCE, liveHyp);
    const sttAvg = meeting.status().sttAvgMs;
    liveLine = `Live speaker→mic WER ${(liveWer * 100).toFixed(1)}% · ${latencies.length} chunks · STT ${sttAvg ?? "?"} ms/chunk on the GPU · chunk-cut→text ${Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length))} ms mean · end of call → notes ${((Date.now() - callEnd) / 1000).toFixed(1)} s (coach ${(summaryMs / 1000).toFixed(1)} s, ${out.notes?.model ?? "no model"}) · mic peak ${peak.toFixed(3)} before gain · "Jarvis, end meeting" heard: ${ended ? "yes" : "no"}`;
    console.log(liveLine);
    if (out.notes) notesMd = renderNotes(out.notes);
    // Off by default: a room mic can also pick up whoever else is nearby. Check it before sharing.
    if (process.argv.includes("--show-heard")) report.push("### What the microphone heard (synthetic, kept for this test only)", "", "> " + liveHyp.replace(/\n/g, " ").slice(0, 3000), "");
    db.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }

  const cleanLine = `Clean (no speaker/mic) WER ${(cleanWer * 100).toFixed(1)}% · ${cleanChunks.length} chunks · ${Math.round(cleanMs.reduce((a, b) => a + b, 0) / cleanMs.length)} ms/chunk`;
  const md = [
    "# Meeting mode · synthetic sample",
    "",
    `Generated ${new Date().toISOString()} by \`bun scripts/meeting-mode/live-test.ts\`. **Synthetic role-play only**: a fictional practice and fictional people, voiced by Groq TTS (Orpheus: daniel as Usman, hannah as \"Priya\"). No real person was recorded, and no audio was written to disk by meeting mode (the synthetic WAV used for playback was deleted after the run).`,
    "",
    "## Accuracy and latency",
    "",
    `- Call length: ${callSeconds.toFixed(0)} s, ${words(REFERENCE).length} words in the script`,
    `- Transcriber: faster-whisper ${warm.model} on ${warm.device} (local)`,
    `- ${cleanLine}`,
    `- ${liveLine}`,
    "",
    ...report,
    "## The notes and coaching meeting mode produced",
    "",
    notesMd || "_(live run skipped)_",
    "",
    "## The script (reference)",
    "",
    ...DIALOGUE.map(([who, line]) => `- **${who === "usman" ? "Usman" : "Priya"}:** ${line}`),
  ].join("\n");
  const downloads = join(homedir(), "Downloads");
  if (!existsSync(downloads)) mkdirSync(downloads, { recursive: true });
  writeFileSync(join(downloads, "meeting-mode-sample.md"), md);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Wrote ${join(downloads, "meeting-mode-sample.md")}`);
}

if (import.meta.main)
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
