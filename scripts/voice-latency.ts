/**
 * Voice latency instrumentation (25 Sep 2026, docs/SCREEN-CONTROL.md): one JSON line per spoken
 * command in `.operator-data/voice-latency.jsonl`, carrying four timestamps —
 *   speechEndAt      the VAD's end-of-speech moment (src/lib/free-voice-client.ts, handleUtterance)
 *   routeDecidedAt   when the route ("rules", "jev-router" or a brain model) picked a tool
 *   actionStartedAt  just before the client dispatches that tool (dispatchTool)
 *   actionDoneAt     just after the tool's result comes back
 * plus the route name and (for a Groq/Gemini model) which one. Measurement only: nothing here
 * changes routing or ever blocks a real command, and a bad write never surfaces to the caller —
 * see the try/catch in recordVoiceLatency, the same shape as scripts/jev-shadow.ts.
 *
 * `bun scripts/voice-latency-report.ts [N]` reads the last N lines (default 200) and prints
 * p50/p90 per route, for the live 10-command bench the owner runs later when idle.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type VoiceLatencyEntry = {
  id: string;
  route: string;
  speechEndAt: number;
  routeDecidedAt: number;
  actionStartedAt: number;
  actionDoneAt: number;
};

export function voiceLatencyFile(root: string): string {
  return join(root, ".operator-data", "voice-latency.jsonl");
}

const MAX_ID = 80;
const MAX_ROUTE = 60;
/** A day either side of now: catches a clock that's obviously wrong without being fussy about skew. */
const MAX_SKEW_MS = 24 * 60 * 60_000;

/** Validates and normalises one entry; throws with a plain reason for anything malformed. */
export function parseVoiceLatencyEntry(raw: unknown): VoiceLatencyEntry {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id.trim().slice(0, MAX_ID) : "";
  const route = typeof b.route === "string" ? b.route.trim().slice(0, MAX_ROUTE) : "";
  if (!id) throw new Error("Voice latency needs an id.");
  if (!route) throw new Error("Voice latency needs a route.");
  const num = (name: string): number => {
    const v = b[name];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`Voice latency needs a numeric ${name}.`);
    return Math.round(v);
  };
  const speechEndAt = num("speechEndAt");
  const routeDecidedAt = num("routeDecidedAt");
  const actionStartedAt = num("actionStartedAt");
  const actionDoneAt = num("actionDoneAt");
  const now = Date.now();
  for (const [name, t] of [["speechEndAt", speechEndAt], ["routeDecidedAt", routeDecidedAt], ["actionStartedAt", actionStartedAt], ["actionDoneAt", actionDoneAt]] as const)
    if (Math.abs(t - now) > MAX_SKEW_MS) throw new Error(`Voice latency ${name} looks wrong (too far from now).`);
  if (routeDecidedAt < speechEndAt || actionStartedAt < routeDecidedAt || actionDoneAt < actionStartedAt)
    throw new Error("Voice latency timestamps must be non-decreasing: speech end, route decided, action started, action done.");
  return { id, route, speechEndAt, routeDecidedAt, actionStartedAt, actionDoneAt };
}

/**
 * Appends one validated entry to the log. Best-effort and silent on a write failure (disk full, a
 * missing folder that mkdir also can't make): a measurement problem must never surface as a
 * failure of the voice turn that produced it.
 */
export function recordVoiceLatency(root: string, raw: unknown): VoiceLatencyEntry | null {
  try {
    const entry = parseVoiceLatencyEntry(raw);
    const dir = join(root, ".operator-data");
    mkdirSync(dir, { recursive: true });
    appendFileSync(voiceLatencyFile(root), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  } catch {
    return null;
  }
}

/** The last `limit` well-formed entries (oldest first); a corrupt line is skipped, not fatal. */
export function readVoiceLatency(root: string, limit = 200): VoiceLatencyEntry[] {
  const file = voiceLatencyFile(root);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const tail = lines.slice(-Math.max(1, limit));
  const out: VoiceLatencyEntry[] = [];
  for (const line of tail) {
    try {
      out.push(parseVoiceLatencyEntry(JSON.parse(line)));
    } catch {
      /* a corrupt or half-written line is skipped, not fatal */
    }
  }
  return out;
}

export type RouteStats = { route: string; n: number; p50: number; p90: number; min: number; max: number };

/** Nearest-rank percentile over already-sorted values (0 for an empty list). */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/** End-to-end (speech end → action done) ms per route, with p50/p90, most-used route first. */
export function summariseByRoute(entries: VoiceLatencyEntry[]): RouteStats[] {
  const byRoute = new Map<string, number[]>();
  for (const e of entries) {
    const ms = e.actionDoneAt - e.speechEndAt;
    (byRoute.get(e.route) ?? byRoute.set(e.route, []).get(e.route)!).push(ms);
  }
  return [...byRoute.entries()]
    .map(([route, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { route, n: sorted.length, p50: percentile(sorted, 50), p90: percentile(sorted, 90), min: sorted[0], max: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.n - a.n || a.route.localeCompare(b.route));
}

/** A short, evenly-spaced id for one spoken command, for correlating its four timestamps. */
export function newVoiceLatencyId(): string {
  return `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
