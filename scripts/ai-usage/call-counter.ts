// Counts this OS's own calls to providers that have no usage or billing API (Groq, Gemini,
// TypeSafe/Jev, Google Places). It wraps the server process's global fetch once: for a matching
// host it records the day, the endpoint kind (from the URL path; the query string, which can carry
// a key, is never read) and the provider's own x-ratelimit-* response headers. Request and
// response bodies are never touched. Counts live in .operator-data/ai-usage-calls.json.
//
// Scope: only traffic from the Agentic OS server process. Hermes (a separate Python process) and
// other apps using the same keys are not seen, so these are floors, labelled "est.".
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { classifyAiRequest, parseRateLimitHeaders, type RateLimitHeaders } from "./parsers";

export type CallCounts = {
  version: 1;
  since: string;
  /** day (YYYY-MM-DD, local) → "provider:kind" → counts */
  days: Record<string, Record<string, { calls: number; errors: number }>>;
  /** Latest provider rate-limit headers per "provider:kind". */
  headers: Record<string, RateLimitHeaders & { at: string }>;
};

const STATE = Symbol.for("agentic-os.ai-usage.call-counter");

export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function emptyCounts(now = new Date()): CallCounts {
  return { version: 1, since: now.toISOString(), days: {}, headers: {} };
}

export function readCounts(file: string): CallCounts | null {
  try {
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data?.version === 1 && data.days && typeof data.days === "object" ? (data as CallCounts) : null;
  } catch {
    return null;
  }
}

/** Adds one call to the counts (pure; exported for tests). Keeps ~62 days. */
export function recordCall(
  counts: CallCounts,
  url: string,
  status: number | null,
  headers: RateLimitHeaders | null,
  now = new Date(),
): boolean {
  const cls = classifyAiRequest(url);
  if (!cls) return false;
  const key = `${cls.provider}:${cls.kind}`;
  const day = localDay(now);
  const bucket = (counts.days[day] ??= {});
  const row = (bucket[key] ??= { calls: 0, errors: 0 });
  row.calls++;
  if (status === null || status >= 400) row.errors++;
  if (headers) counts.headers[key] = { ...headers, at: now.toISOString() };
  const days = Object.keys(counts.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 62))) delete counts.days[old];
  return true;
}

type CounterState = { file: string; counts: CallCounts; timer: ReturnType<typeof setTimeout> | null };

function writeNow(state: CounterState) {
  try {
    mkdirSync(dirname(state.file), { recursive: true });
    const tmp = `${state.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state.counts));
    renameSync(tmp, state.file);
  } catch {
    /* counting is best-effort; never break a provider call over it */
  }
}

function persist(state: CounterState) {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    writeNow(state);
  }, 3000);
  // Never keeps a long-running server process (the debounce window is fine there — the next
  // write, or the process's own exit hooks, catches up). A short-lived CLI process must call
  // `flush()` itself before it exits, since an unref'd timer never gets the chance to fire.
  (state.timer as { unref?: () => void }).unref?.();
}

/** Installs the counter once per process (Vite re-runs the config on restart). `flush()` writes
 * immediately (clearing any pending debounce) — call it before a short-lived process (a CLI
 * script, not the long-running server) exits, or its last few calls are silently lost. */
export function installCallCounter(file: string): { counts: () => CallCounts; flush: () => void } {
  const g = globalThis as unknown as Record<symbol, CounterState | undefined>;
  const existing = g[STATE];
  if (existing) {
    existing.file = file;
    return {
      counts: () => existing.counts,
      flush: () => {
        if (existing.timer) clearTimeout(existing.timer);
        existing.timer = null;
        writeNow(existing);
      },
    };
  }
  const state: CounterState = { file, counts: readCounts(file) ?? emptyCounts(), timer: null };
  g[STATE] = state;
  const original = globalThis.fetch;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!classifyAiRequest(url)) return original(input as RequestInfo, init);
    try {
      const response = await original(input as RequestInfo, init);
      recordCall(state.counts, url, response.status, parseRateLimitHeaders((n) => response.headers.get(n)));
      persist(state);
      return response;
    } catch (error) {
      recordCall(state.counts, url, null, null);
      persist(state);
      throw error;
    }
  }) as typeof fetch;
  Object.assign(wrapped, original);
  globalThis.fetch = wrapped;
  return {
    counts: () => state.counts,
    flush: () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      writeNow(state);
    },
  };
}
