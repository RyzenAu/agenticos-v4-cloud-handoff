// Month-to-date Claude token totals from this PC's Claude Code transcripts (~/.claude/projects).
//
// Reads ONLY the usage/model/id/timestamp fields of assistant lines (see extractTranscriptUsage);
// message text is never parsed, kept or logged. Incremental: each file is read from where the last
// scan stopped, in chunks, yielding to the event loop so the dev server stays responsive while the
// first scan (several GB) runs. One API response is written as several transcript lines that share
// a message id + request id; those are counted once (the older aggregator counted each line).
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractTranscriptUsage } from "./parsers";
import type { TokenCounts } from "./prices";

export type ModelTotals = { requests: number; counts: TokenCounts };
export type TranscriptTotals = { byModel: Record<string, ModelTotals>; files: number; scannedAt: string; complete: boolean };

const CHUNK = 8 * 1024 * 1024;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function walk(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 6) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export function createTranscriptScanner(options: { dir: string; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  let monthKey = "";
  let monthStart = 0;
  let monthEnd = 0;
  const files = new Map<string, { offset: number; carry: string }>();
  const seen = new Set<string>();
  let byModel: Record<string, ModelTotals> = {};
  let running: Promise<TranscriptTotals> | null = null;
  let last: TranscriptTotals | null = null;

  const reset = (d: Date) => {
    monthKey = `${d.getFullYear()}-${d.getMonth()}`;
    monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    files.clear();
    seen.clear();
    byModel = {};
  };

  const consume = (line: string) => {
    if (!line.includes('"usage":{')) return;
    const u = extractTranscriptUsage(line);
    if (!u || u.timestampMs < monthStart || u.timestampMs >= monthEnd) return;
    if (u.key) {
      if (seen.has(u.key)) return;
      seen.add(u.key);
    }
    const model = u.model.replace(/\[[^\]]*\]$/, "");
    const row = (byModel[model] ??= { requests: 0, counts: { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 } });
    row.requests++;
    row.counts.input += u.counts.input;
    row.counts.output += u.counts.output;
    row.counts.cacheRead += u.counts.cacheRead;
    row.counts.write5m += u.counts.write5m;
    row.counts.write1h += u.counts.write1h;
  };

  async function readFrom(path: string, size: number) {
    let state = files.get(path);
    if (!state || size < state.offset) state = { offset: 0, carry: "" };
    if (size === state.offset) {
      files.set(path, state);
      return;
    }
    const handle = await open(path, "r");
    try {
      let offset = state.offset;
      let carry = state.carry;
      const buffer = Buffer.allocUnsafe(CHUNK);
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead;
        const text = carry + buffer.toString("utf8", 0, bytesRead);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) consume(line);
        await yieldToLoop();
      }
      // A partial trailing line waits for the next scan (the writer may still be mid-line).
      files.set(path, { offset, carry: carry.length > 32 * 1024 * 1024 ? "" : carry });
    } finally {
      await handle.close();
    }
  }

  async function run(): Promise<TranscriptTotals> {
    const d = now();
    if (`${d.getFullYear()}-${d.getMonth()}` !== monthKey) reset(d);
    const paths = await walk(options.dir);
    let counted = 0;
    let complete = true;
    for (const path of paths) {
      try {
        const s = await stat(path);
        if (s.mtimeMs < monthStart) continue;
        counted++;
        await readFrom(path, s.size);
      } catch {
        complete = false; // a file vanished or is locked; the rest still count
      }
    }
    last = { byModel: structuredClone(byModel), files: counted, scannedAt: new Date().toISOString(), complete };
    return last;
  }

  return {
    /** Runs (or joins) a scan. */
    scan(): Promise<TranscriptTotals> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    last: () => last,
    scanning: () => running !== null,
  };
}
