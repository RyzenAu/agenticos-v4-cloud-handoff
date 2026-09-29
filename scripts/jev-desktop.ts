/**
 * The Jarvis desktop entry point: Jev decides what he wants before anything on screen is touched.
 *
 * One request through the voice router's own Jev tree (scripts/jev-router.ts: category + every
 * sub-choice + the outbound/complete nouls, all evaluated in parallel), with the window in front as
 * context. Desktop work — screen_act, and the router's "hermes" (multi-step PC work) or page actions
 * when a window is the target — goes to the Jev-first control loop (screen-hands/jev-control.ts);
 * anything else is handed back to Jarvis's other tools, never acted on here.
 *
 * His typed payloads never reach the router's state either: they are replaced with placeholders
 * first (goalSlots), exactly as the control loop does. Confidence: >= 0.6 routes; below that Jarvis
 * asks him. No key or no answer means "unavailable" and the caller decides (the screen route falls
 * back to screen_act, which is what was asked of it).
 */
import { askJev, resolveIntent, type JevAnswers } from "./jev-router";
import { goalSlots, JEV_CONTROL_ACT } from "./screen-hands/jev-control";

export type DesktopRoute =
  | { kind: "screen"; intent: string; confidence: number; outbound: number; ms: number; inputTokens?: number; outputTokens?: number; answers: JevAnswers }
  | { kind: "open_app"; intent: string; confidence: number; outbound: number; ms: number; inputTokens?: number; outputTokens?: number; answers: JevAnswers }
  | { kind: "elsewhere"; intent: string; confidence: number; outbound: number; ms: number; inputTokens?: number; outputTokens?: number; answers: JevAnswers }
  | { kind: "unsure"; intent: string; confidence: number; outbound: number; ms: number; inputTokens?: number; outputTokens?: number; answers: JevAnswers }
  | { kind: "unavailable"; reason: string };

/** Intents that are work on the window in front (the Jev control loop), with a window as the target. */
export function desktopKind(intent: string, windowInFront: boolean): "screen" | "open_app" | "elsewhere" {
  if (intent === "screen_act") return "screen";
  if (intent === "pc.open_app") return "open_app";
  // "Real multi-step work on the PC" and page actions: with a window in front to work on, that is
  // the control loop's job (Hermes stays for work with no window to drive).
  if (windowInFront && (intent === "hermes" || intent.startsWith("browser."))) return "screen";
  return "elsewhere";
}

/** Plain words for the narration: "work on this window (screen_act, 91%)". */
export function routeLine(route: DesktopRoute): string {
  if (route.kind === "unavailable") return `Jev routing unavailable (${route.reason}).`;
  const pct = `${Math.round(route.confidence * 100)}%`;
  const what =
    route.kind === "screen" ? "work on the window in front" : route.kind === "open_app" ? "open an app" : route.kind === "unsure" ? "unclear" : "a job for another of my tools";
  return `Jev: ${what} (${route.intent}, ${pct})${route.outbound > 0.35 ? "; it may send, pay or delete, so I'll ask before any final button" : ""}.`;
}

export async function routeDesktopCommand(
  utterance: string,
  options: { key: string; request?: typeof fetch; window?: { process: string; title: string } | null; timeoutMs?: number },
): Promise<DesktopRoute> {
  if (!utterance.trim()) return { kind: "unavailable", reason: "nothing was said" };
  if (!options.key) return { kind: "unavailable", reason: "no Jev key" };
  const slots = goalSlots(utterance);
  const context: Record<string, string> = options.window
    ? { front_window: `${options.window.process} "${slots.redact(options.window.title).slice(0, 80)}"`, where: "He is at his PC, talking about the window in front." }
    : {};
  const asked = await askJev(slots.goal, options.key, { request: options.request, timeoutMs: options.timeoutMs ?? 2000, context });
  if (!asked) return { kind: "unavailable", reason: "no answer" };
  const { intent, confidence } = resolveIntent(asked.answers);
  const outbound = typeof asked.answers.outbound?.noul === "number" ? asked.answers.outbound.noul : 0;
  const base = { intent, confidence, outbound, ms: asked.ms, answers: asked.answers, ...(asked.inputTokens !== undefined ? { inputTokens: asked.inputTokens } : {}), ...(asked.outputTokens !== undefined ? { outputTokens: asked.outputTokens } : {}) };
  if (confidence < JEV_CONTROL_ACT) return { kind: "unsure", ...base };
  return { kind: desktopKind(intent, !!options.window), ...base };
}
