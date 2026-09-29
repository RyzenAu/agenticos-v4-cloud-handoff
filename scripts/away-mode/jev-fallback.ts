// Rules first, always. classifyTask() (policy.ts) is the fast, free, already-audited path and
// stays untouched and synchronous — this file only adds a slower, optional SECOND opinion for the
// case it already falls through to: nothing matched, so it would go to "hermes".
//
// Safety, by construction, not by convention:
//   - Jev is asked for a LABEL only (one of the same four routes classifyTask already returns —
//     "route", not "recipe"). It never sees or supplies file ops, a CLI recipe or screen steps.
//   - A label change is only ever HONOURED if the SAME deterministic parser classifyTask already
//     uses (parseFileOps / cliRecipe / parseScreenTask) can independently build a real plan —
//     from the task's own words, at most with politeStrip()'s narrow, punctuation-preserving
//     cleanup below. Jev can relabel; it can never construct a step, a path or a command itself.
//     (normaliseUtterance from jev-router.ts was considered and rejected for this: it turns
//     colons and periods into spaces, which mangles a real "D:\tmp\file.txt" path — fine for
//     spoken voice commands, unsafe for away-mode's typed/Telegram task text.)
//   - neverReason()/approvalReason() in runner.ts run on the task's own original text, completely
//     unconditioned on which route this file picks — see execute()'s and addTask()'s calls. This
//     file cannot loosen, skip or reorder that gate; it only changes which of the four already-
//     gated executors ends up running the same never-checked, same approval-checked task.
//   - No key, a timeout, a malformed reply, a low-confidence answer, or any error at all: the
//     rules' own answer stands unchanged. Jev is strictly additive and fails silently to "hermes".
import { classifyTask, cliRecipe, parseFileOps, parseScreenTask, stripSelfReport, type Route, type RouteName } from "./policy";
import { JEV_MODEL, JEV_URL } from "../jev";

export const JEV_FALLBACK_DEADLINE_MS = 1200;
export const JEV_FALLBACK_MIN_CONFIDENCE = 0.7;

const ROUTE_CHOICES: Record<RouteName, string> = {
  file: "A file operation on his own PC: make a folder, write a new text file, or delete one already named.",
  cli: "One of a small fixed set of known CLI recipes (e.g. the lead phone-finder, a lead preview rebuild).",
  screen: "Opening a named app, then clicking, typing or a short sequence in it.",
  hermes: "Anything else: research, multi-app work, or it just doesn't clearly fit the other three.",
};

export type Jev = { key: string; request?: typeof fetch; timeoutMs?: number };

/** Strips a leading politeness phrase only — never touches punctuation, colons or paths (unlike
 *  jev-router.ts's normaliseUtterance, which is for spoken commands, not typed text with real file
 *  paths). "Could you please open Notepad..." -> "open Notepad...", a variant classifyTask()
 *  itself never tries (it only applies stripSelfReport, a different, trailing-clause strip). */
export function politeStrip(text: string): string {
  return text.replace(/^\s*(?:hey\s+)?jarvis[,:]?\s*/i, "").replace(/^\s*(?:could|can|would|will)\s+you\s+(?:please\s+)?/i, "").replace(/^\s*please\s+/i, "").trim();
}

/** Retries the ONE parser matching a route guess against a couple of text variants. Returns the
 *  resulting plan only if that deterministic parser actually produced one — never a guess dressed
 *  up as a plan. */
function tryRoute(guess: RouteName, variants: string[], lastPath: string | null): Route | null {
  for (const text of variants) {
    if (guess === "file") {
      const ops = parseFileOps(text, lastPath);
      if (ops) return { route: "file", ops };
    } else if (guess === "cli") {
      const recipe = cliRecipe(text);
      if (recipe) return { route: "cli", recipe };
    } else if (guess === "screen") {
      const steps = parseScreenTask(text);
      if (steps) return { route: "screen", steps };
    }
  }
  return null;
}

/**
 * The away-mode router the queue should call instead of the bare classifyTask(): rules first,
 * instant, no network, exactly as today. Only for a task the rules call "hermes" does it spend one
 * bounded Jev call asking whether it's really a file/cli/screen task in disguise — and only when
 * Jev is confident does it even bother trying politeStrip()'s cleanup (a variant plain classifyTask
 * never tries on its own), so Jev's one job is deciding "is a second, narrower attempt worth it and
 * on which parser", never supplying the plan itself. See the file header for exactly what Jev can
 * and cannot change.
 */
export async function classifyTaskWithJevFallback(task: string, lastPath: string | null, jev: Jev | null): Promise<Route> {
  const rulesPlan = classifyTask(task, lastPath);
  if (rulesPlan.route !== "hermes" || !jev?.key) return rulesPlan;

  let guess: RouteName | null = null;
  try {
    const response = await (jev.request ?? fetch)(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${jev.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { task: stripSelfReport(task).slice(0, 600) },
        questions: {
          route: {
            type: "choice",
            instructions: "Which route genuinely fits this away-mode task? Pick hermes unless one of the other three is a clear, confident fit — when in doubt, hermes.",
            criteria: ROUTE_CHOICES,
          },
        },
      }),
      signal: AbortSignal.timeout(jev.timeoutMs ?? JEV_FALLBACK_DEADLINE_MS),
    });
    if (response.ok) {
      const data = (await response.json()) as { answers?: { route?: { choice?: string; confidence?: number } } };
      const answer = data.answers?.route;
      if (answer?.choice && answer.choice in ROUTE_CHOICES && (answer.confidence ?? 0) >= JEV_FALLBACK_MIN_CONFIDENCE) guess = answer.choice as RouteName;
    }
  } catch {
    return rulesPlan; // any failure or timeout: the rules' own answer stands, unchanged
  }
  if (!guess || guess === "hermes") return rulesPlan;
  // classifyTask() already tried stripSelfReport(task) internally and got nowhere; politeStrip is
  // the one variant it never tries — this is the only place it's attempted, and only because Jev
  // was confident enough to make it worth the extra try.
  return tryRoute(guess, [politeStrip(task)], lastPath) ?? rulesPlan;
}
