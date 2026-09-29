#!/usr/bin/env bun
// First-audio latency benchmark for brain answers (a script, not a test: it calls Groq and the
// configured TTS, a few requests per question, spaced for Groq's free-tier 8k tokens/minute).
//
//   bun scripts/voice-latency-bench.ts --label before [--gap 25]
//
// For each question it measures, against the running OS (http://localhost:8081):
//   turn     POST /voice/free/turn → the brain's whole reply (what the client waits for today)
//   ttsAll   POST /voice/free/tts with the first speech chunk as the client groups it today
//   tts1     POST /voice/free/tts with the first sentence alone
//   stream   POST /voice/free/tts-stream with the first sentence: time to its first 120 ms of audio
// and reports first audio = turn + ttsAll (before) vs turn + stream (after). Nothing is spoken.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupForSpeech, splitSentences, stripMarkdownForSpeech } from "../src/lib/free-voice-client";

const QUESTIONS = [
  "What's the capital of Portugal?",
  "Tell me a quick joke about queuing.",
  "Explain what a directory junction is on Windows.",
  "How do I say thank you in Urdu?",
  "Give me one tip for opening a cold call with a dentist.",
];
const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const label = flag("label") ?? "run";
const gapMs = Number(flag("gap") ?? 25) * 1000;
const base = "http://localhost:8081";
const token = ((await (await fetch(`${base}/__token`)).json()) as { token: string }).token;
const post = async (path: string, body: unknown) => {
  const started = performance.now();
  const response = await fetch(`${base}/__operator${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token }, body: JSON.stringify(body) });
  return { response, started };
};
const timed = async (path: string, body: unknown) => {
  const { response, started } = await post(path, body);
  const data: any = await response.json().catch(() => ({}));
  return { data, ms: Math.round(performance.now() - started) };
};

/** Streamed speech: ms until the first 120 ms of PCM (what the client schedules first) and until the end. */
async function streamed(text: string) {
  const { response, started } = await post("/voice/free/tts-stream", { text });
  if (!response.body || !(response.headers.get("content-type") ?? "").includes("octet-stream")) return null;
  const rate = Number(response.headers.get("x-sample-rate")) || 24000;
  const reader = response.body.getReader();
  let bytes = 0, firstAudio = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (!firstAudio && bytes >= rate * 2 * 0.12) firstAudio = Math.round(performance.now() - started);
  }
  return { firstAudio: firstAudio || Math.round(performance.now() - started), done: Math.round(performance.now() - started), seconds: bytes / (rate * 2) };
}

type Row = { question: string; reply: string; turn: number; ttsAll: number; tts1: number; firstAudioBefore: number; firstAudioSplit: number; stream: Awaited<ReturnType<typeof streamed>> };
const rows: Row[] = [];
for (const [i, question] of QUESTIONS.entries()) {
  if (i) await new Promise((r) => setTimeout(r, gapMs));
  const turn = await timed("/voice/free/turn", { messages: [{ role: "user", content: question }] });
  const reply = String(turn.data?.content ?? "");
  if (!reply) {
    console.log(`skip (no spoken reply: ${JSON.stringify(turn.data).slice(0, 160)})  ${question}`);
    continue;
  }
  const sentences = splitSentences(stripMarkdownForSpeech(reply));
  // A unique suffix defeats the server's speech cache so each TTS is a real synthesis.
  const nonce = ` ${String.fromCharCode(8203).repeat(i + 1)}`;
  const ttsAll = await timed("/voice/free/tts", { text: groupForSpeech(sentences)[0] + nonce });
  const tts1 = await timed("/voice/free/tts", { text: sentences[0] + ` ${String.fromCharCode(8203).repeat(i + 10)}` });
  // A different invisible suffix again, so the streamed sentence is never a speech-cache hit.
  const stream = await streamed(sentences[0] + ` ${String.fromCharCode(8203).repeat(i + 20)}`);
  const row: Row = { question, reply, turn: turn.ms, ttsAll: ttsAll.ms, tts1: tts1.ms, firstAudioBefore: turn.ms + ttsAll.ms, firstAudioSplit: turn.ms + tts1.ms, stream };
  rows.push(row);
  console.log(`${question}\n  turn ${row.turn} ms + tts(all ${groupForSpeech(sentences)[0].length} chars) ${row.ttsAll} ms = first audio ${row.firstAudioBefore} ms; first sentence alone (${sentences[0].length} chars) ${row.tts1} ms → ${row.firstAudioSplit} ms; streamed: ${stream ? `first audio ${stream.firstAudio} ms (${row.turn + stream.firstAudio} ms after the turn), whole sentence ${stream.done} ms` : "not supported"}`);
}
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : 0);
const summary = [
  `questions: ${rows.length}`,
  `first audio today (turn + tts of the grouped reply): median ${med(rows.map((r) => r.firstAudioBefore))} ms`,
  `first sentence alone: median ${med(rows.map((r) => r.firstAudioSplit))} ms`,
  `turn + streamed first sentence: median ${med(rows.filter((r) => r.stream?.firstAudio).map((r) => r.turn + r.stream!.firstAudio))} ms`,
].join("\n");
console.log(`\n${summary}`);
const directory = join(import.meta.dir, "..", "docs", "jev-bench");
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, `voice-latency-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), summary, rows }, null, 1));
