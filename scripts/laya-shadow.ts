// Opt-in shadow test for Laya (github.com/NandhaKishorM/laya, Apache-2.0): a local, Jev-compatible
// `POST /v1/systemone` server (ModernBERT/mmBERT, ~400M params) being evaluated as a possible
// primary router. See docs/LAYA.md for install/start instructions.
//
// When env LAYA_URL is set, the Jev router (scripts/jev-router.ts) also sends its exact question
// set to Laya, in parallel, purely to measure agreement and latency. Jarvis NEVER acts on Laya's
// answer — the router's real decision always comes from Jev (or the brain). Only intent ids,
// confidences and timings are appended to `.operator-data/laya-shadow.jsonl`; the utterance itself
// is never logged.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LAYA_TIMEOUT_MS = 1500; // same budget as the Jev call it shadows

/** Trimmed, trailing-slash-free base URL, or undefined when the shadow test is off (the default). */
export function layaUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.LAYA_URL?.trim();
  return url ? url.replace(/\/+$/, "") : undefined;
}

type LayaAnswers = Record<string, { choice?: string; confidence?: number; noul?: number; score?: number }>;

/** POSTs the identical Jev-shaped request body to Laya's `/v1/systemone`. Never throws. */
export async function queryLaya(base: string, body: unknown, request: typeof fetch = fetch, timeoutMs = LAYA_TIMEOUT_MS): Promise<{ answers: LayaAnswers; ms: number } | null> {
  const started = Date.now();
  try {
    const response = await request(`${base}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { answers?: LayaAnswers };
    if (!data?.answers || typeof data.answers !== "object") return null;
    return { answers: data.answers, ms: Date.now() - started };
  } catch {
    return null;
  }
}

export type ShadowEntry = {
  at: string;
  jevIntent: string;
  jevConfidence: number;
  jevMs: number;
  layaIntent: string | null;
  layaConfidence: number | null;
  layaMs: number | null;
  /** null when Laya didn't answer in time (a timeout/error is not counted as a disagreement). */
  agree: boolean | null;
};

const dirsReady = new Map<string, Promise<string>>();
function dataDir(root: string) {
  let ready = dirsReady.get(root);
  if (!ready) {
    ready = mkdir(join(root, ".operator-data"), { recursive: true }).then(() => join(root, ".operator-data"));
    dirsReady.set(root, ready);
  }
  return ready;
}

/** One JSON line per comparison. Best-effort: a logging failure never affects routing. */
export async function logShadow(entry: ShadowEntry, root = ROOT) {
  try {
    const dir = await dataDir(root);
    await appendFile(join(dir, "laya-shadow.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* shadow logging is best-effort; never surfaces to the caller */
  }
}
