// Warm Hermes: voice tasks go to the running gateway's OpenAI-compatible API server
// (127.0.0.1:8642, API_SERVER_KEY in Hermes' .env) instead of spawning `hermes chat` per task.
// Measured 24 Sep: a trivial turn took 12.8 s through a fresh CLI process (58 plugins, MCP
// discovery, every toolset) and 2.0 s warm. The key is read at call time and never returned.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { planHermesTask, taskOf, type HermesPlan } from "./jev-hermes";

export const HERMES_API = "http://127.0.0.1:8642";

function hermesHome() {
  return process.env.HERMES_HOME || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes");
}

export function hermesApiKey(home = hermesHome()): string {
  try {
    for (const line of readFileSync(join(home, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*API_SERVER_KEY\s*=\s*(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* not configured */
  }
  return "";
}

export async function hermesApiUp(request: typeof fetch = fetch) {
  try {
    const r = await request(`${HERMES_API}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export class HermesApiUnavailable extends Error {
  /** Jev's plan for the task, so the CLI fallback can still pass `-t <toolsets>`. */
  plan?: HermesPlan | null;
}

export const WARM_PROMPT = "Agentic OS warm-up ping, not a task: reply with the single word ready. Do not use any tools.";
let lastWarm = 0;

/**
 * Warms Hermes when the voice panel opens: one tiny turn so the first real control_pc task finds
 * the gateway's model connection and prompt cache hot. 24 Sep, "open Notepad" after 20 min idle:
 * first model call 3.5 s and 8.0 s overall, straight after 2.4 s and 6.1 s. At most every 5 min
 * (a real task counts), and never when the API server isn't configured.
 */
export async function warmHermes(options: { request?: typeof fetch; now?: () => number; key?: string } = {}) {
  const now = (options.now ?? Date.now)();
  if (now - lastWarm < 5 * 60_000) return { warmed: false, reason: "recently warm" };
  const key = options.key ?? hermesApiKey();
  if (!key) return { warmed: false, reason: "not configured" };
  lastWarm = now;
  const started = Date.now();
  const response = await (options.request ?? fetch)(`${HERMES_API}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "hermes-agent", messages: [{ role: "user", content: WARM_PROMPT }], stream: false, model_options: { reasoning: { effort: "low" } } }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  return { warmed: Boolean(response?.ok), ms: Date.now() - started };
}
/** For tests: forget the last warm-up. */
export function resetHermesWarm() {
  lastWarm = 0;
}

/** Jarvis's control_pc brief (jarvisTaskPrompt): only these get a Jev plan. */
const JARVIS_BRIEF = "You are acting as Jarvis's hands";

/** Session IDs Hermes hands back: letters, digits, _ and - only (they become file names there). */
export function safeSessionId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{4,120}$/.test(value) ? value : undefined;
}

/**
 * One task on the warm gateway. Throws HermesApiUnavailable when the API server isn't
 * configured or reachable, so the caller can fall back to the CLI path.
 */
export async function runWarmTask(
  prompt: string,
  options: {
    sessionId?: string;
    signal?: AbortSignal;
    request?: typeof fetch;
    /** Jev's plan for a Jarvis task; by default planned here (null = don't plan). */
    plan?: ((task: string) => Promise<HermesPlan | null>) | null;
    /**
     * A model for this one request instead of the gateway default (Hermes honours an explicit
     * provider per request), e.g. { model: "gpt-6-astra", provider: "openai-codex" } for the
     * lesson coach, with its reasoning effort.
     */
    model?: { model: string; provider: string; effort?: "low" | "medium" | "high" };
  } = {},
): Promise<{ text: string; sessionId?: string; ms: number; plan?: HermesPlan | null }> {
  const request = options.request ?? fetch;
  const started = Date.now();
  lastWarm = started; // a real task warms Hermes as well as any ping would
  // Jev (~0.3 s) picks the reasoning effort: a one-step job ("open Notepad") runs at "low"
  // instead of the configured "medium". Only for Jarvis's brief; chat and other callers unchanged.
  const planner = options.plan === undefined ? (task: string) => planHermesTask(task) : options.plan;
  const plan = planner && prompt.startsWith(JARVIS_BRIEF) ? await planner(taskOf(prompt)).catch(() => null) : null;
  const unavailable = (message: string) => Object.assign(new HermesApiUnavailable(message), { plan });
  const key = hermesApiKey();
  if (!key) throw unavailable("Hermes API server isn't configured.");
  let response: Response;
  try {
    response = await request(`${HERMES_API}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(safeSessionId(options.sessionId) ? { "X-Hermes-Session-Id": options.sessionId! } : {}),
      },
      body: JSON.stringify({
        model: options.model?.model ?? "hermes-agent",
        ...(options.model ? { provider: options.model.provider } : {}),
        messages: [{ role: "user", content: prompt }],
        stream: false,
        // api_server.py honours model_options.reasoning per request; toolsets it does not.
        ...(options.model?.effort ? { model_options: { reasoning: { effort: options.model.effort } } } : plan?.effort ? { model_options: { reasoning: { effort: plan.effort } } } : {}),
      }),
      signal: options.signal ?? AbortSignal.timeout(15 * 60_000),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw unavailable("Hermes API server isn't reachable.");
  }
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status >= 502)
    throw unavailable(`Hermes API server answered ${response.status}.`);
  const data = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) return { text: `Hermes reported an error: ${String(data?.error?.message ?? response.statusText).slice(0, 400)}`, ms: Date.now() - started, plan };
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  return { text, sessionId: safeSessionId(response.headers.get("X-Hermes-Session-Id")), ms: Date.now() - started, plan };
}
