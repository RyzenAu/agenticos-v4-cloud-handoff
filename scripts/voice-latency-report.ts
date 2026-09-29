#!/usr/bin/env bun
// Prints p50/p90 per route from the last N spoken commands logged to
// .operator-data/voice-latency.jsonl (scripts/voice-latency.ts). Reads only; makes no request and
// drives nothing on screen — safe to run any time.
//
//   bun scripts/voice-latency-report.ts [N]        (default 200)
import { readVoiceLatency, summariseByRoute } from "./voice-latency";

function main() {
  const n = Number(process.argv[2] ?? 200);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  const root = process.cwd();
  const entries = readVoiceLatency(root, limit);
  if (!entries.length) {
    console.log(`No voice latency entries in .operator-data/voice-latency.jsonl yet (looked in ${root}).`);
    return;
  }
  const stats = summariseByRoute(entries);
  const width = Math.max(5, ...stats.map((s) => s.route.length));
  console.log(`Last ${entries.length} command${entries.length === 1 ? "" : "s"} (speech end → action done, ms):\n`);
  console.log(`${"route".padEnd(width)}  n    p50    p90    min    max`);
  for (const s of stats)
    console.log(`${s.route.padEnd(width)}  ${String(s.n).padStart(3)}  ${String(s.p50).padStart(5)}  ${String(s.p90).padStart(5)}  ${String(s.min).padStart(5)}  ${String(s.max).padStart(5)}`);
}

if (import.meta.main) main();
