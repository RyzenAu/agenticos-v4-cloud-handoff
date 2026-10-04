// Questions Jarvis answers by its own rules and services, typed or spoken (Track 2; AUDIT-F2, AUDIT-F4):
// shared memory, finance, the receptionist feed, CRM lead actions, "remember to …" reminders, package
// prices and margins. Track 1's destination resolver would otherwise turn "receptionist status" into
// opening a page, and a typed "what did I spend this month" into a chat-model turn.
//
// Callers (the voice client's jarvis_command handler, and Track 1's palette) ask this FIRST: a match goes
// to the one command entry (runJarvisCommand / runTypedCommand → POST /__operator/screen/command), which
// runs the same service the spoken rule does and cites its source. Pure and browser-safe (no Node APIs).
import { matchFinanceIntent } from "../../scripts/finance/jarvis-intent";
import { matchStripeIntent } from "../../scripts/finance/stripe-jarvis-intent";
import { parseMemoryIntent } from "../../scripts/memory/voice-intents";
import { receptionistQuestion } from "../../scripts/jarvis-command/receptionist";
import { leadActionIn, rememberToReminder } from "../../scripts/jarvis-command/intents";
import { parsePriceQuery } from "../../scripts/jarvis-command/answers";
import { parseMarginQuery } from "../../scripts/jev-margin";

export type RuleAnswerKind = "memory" | "finance" | "receptionist" | "leads" | "reminder" | "price" | "margin";

/** Which rules service answers these words, or null (then the destination resolver decides). Pure. */
export function ruleAnswerIntent(text: string): RuleAnswerKind | null {
  const t = String(text ?? "").trim();
  if (!t || t.length > 600) return null;
  if (rememberToReminder(t)) return "reminder";
  if (parseMemoryIntent(t)) return "memory";
  if (leadActionIn(t)) return "leads";
  if (receptionistQuestion(t)) return "receptionist";
  if (parseMarginQuery(t)) return "margin";
  if (parsePriceQuery(t)) return "price";
  if (matchFinanceIntent(t) || matchStripeIntent(t)) return "finance";
  return null;
}
