#!/usr/bin/env bun
/**
 * Watch a public YouTube video and answer a prompt about it, printing markdown to stdout.
 * For video-study agents (and anyone at the terminal) — replaces one-off Gemini/OpenRouter calls.
 *
 * Usage:
 *   bun scripts/llm/watch-video.ts <youtube-url> "<prompt>" [--pro]
 *
 * --pro is an explicit choice of a PAID model (OpenRouter google/gemini-3.1-pro-preview), with no fallback
 * (as before E1): if it is unavailable, the call fails clearly. Without it: free Gemini first
 * (gemini-3.8-flash, then gemini-flash-latest), then paid OpenRouter google/gemini-2.5-flash-lite, as
 * before E1. The model that actually ran is printed and recorded (with its cost) in the router receipts.
 */
import { watchVideo } from "./gemini";

async function main() {
  const args = Bun.argv.slice(2);
  const pro = args.includes("--pro");
  const [url, prompt] = args.filter((a) => a !== "--pro");
  if (!url || !prompt) {
    console.error('Usage: bun scripts/llm/watch-video.ts <youtube-url> "<prompt>" [--pro]');
    process.exit(1);
  }
  try {
    const result = await watchVideo(url, prompt, { tier: pro ? "pro" : "flash" });
    console.log(`<!-- ${result.provider}:${result.model}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ""} · ${result.ms}ms -->\n\n${result.text}`);
  } catch (error) {
    console.error(`Could not watch that video: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) void main();
