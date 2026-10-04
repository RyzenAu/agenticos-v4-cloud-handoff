import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Server-only configuration; values must never enter client-visible state. */
export function providerKey(root: string, name: string, options: {
  home?: string; env?: NodeJS.ProcessEnv;
} = {}): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return "";
  const env = options.env ?? process.env;
  if (env[name]?.trim()) return env[name]!.trim();
  const home = options.home ?? homedir();
  for (const file of [join(root, ".env.local"), join(home, ".config/agentic-os.env"), join(home, ".hermes/.env")]) {
    try {
      const match = readFileSync(file, "utf8").match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)$`, "m"));
      if (!match) continue;
      let value = match[1].trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "").trim();
      if (value) return value;
    } catch { /* An unconfigured provider is an ordinary fresh-install state. */ }
  }
  return "";
}

// --- OpenRouter "never purchased credits" gate --------------------------------------------------
// 25 Sep 2026: an OpenRouter key that has never had credit purchased against it (confirmed live:
// an account balance of US$9.99 but a key cap of $0) fails every paid completion with a 402 (or a
// 403 whose body talks about credits/purchase) — the same failure, every single call, for the rest
// of the process. Every caller that might fall back to OpenRouter (scripts/llm/gemini.ts,
// scripts/llm/mimo.ts) shares this one process-wide flag so a bulk run notices once, says so once,
// and then skips OpenRouter outright instead of re-trying (and re-failing) it per lead/per call.
let openRouterNoCreditsSeen = false;
let openRouterNoCreditsWarned = false;

/** True once this process has seen a genuine "no purchased credits" response from OpenRouter. */
export function openRouterCreditsExhausted(): boolean {
  return openRouterNoCreditsSeen;
}

/** Feed every OpenRouter failure through this; it's a no-op unless the response is the specific
 *  "never purchased credits" shape. Never throws, never logs a key. `log` defaults to
 *  console.error but tests inject a silent collector so a run's own output stays clean. */
export function noteOpenRouterFailure(status: number, bodyText: string, log: (line: string) => void = (l) => console.error(l)): void {
  const looksLikeNoCredits = status === 402 || (status === 403 && /credit/i.test(bodyText));
  if (!looksLikeNoCredits) return;
  openRouterNoCreditsSeen = true;
  if (!openRouterNoCreditsWarned) {
    openRouterNoCreditsWarned = true;
    log(`OpenRouter: key has no purchased credit (HTTP ${status}) — skipping OpenRouter for the rest of this process.`);
  }
}

/** Test-only: clears the per-process "no credits" memory so one test's finding doesn't leak into
 *  the next. Production code never calls this. */
export function resetOpenRouterCreditsGateForTests(): void {
  openRouterNoCreditsSeen = false;
  openRouterNoCreditsWarned = false;
}
