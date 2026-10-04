import { businessClauses } from "./business-clauses";
import { crmIntentIn, type CrmIntent } from "./crm";
import { leadActionIn, type LeadAction } from "./intents";

export const MAX_BUSINESS_QUESTIONS = 4;
export type BusinessQuestion =
  | { to: "crm"; intent: Extract<CrmIntent, { kind: "next" | "drafts" | "search" | "overdue" | "promises" }>; words: string }
  | { to: "leads"; action: Extract<LeadAction, { action: "next" | "count" }>; words: string };
export type BusinessQuestions = { kind: "questions"; questions: BusinessQuestion[] } | { kind: "unsupported" };

/** Explicit read-only allow-list, never typed operations, navigation, drafts-to-create or mutations.
 * Validate the WHOLE request before any delegate runs; no partial single-rule match may swallow it. */
function question(words: string): BusinessQuestion | null {
  const intent = crmIntentIn(words);
  if (intent && (intent.kind === "next" || intent.kind === "drafts" || intent.kind === "search" || intent.kind === "overdue" || intent.kind === "promises")) return { to: "crm", intent, words };
  const action = leadActionIn(words);
  return action && (action.action === "next" || action.action === "count") ? { to: "leads", action, words } : null;
}

export function businessQuestionsIn(utterance: string): BusinessQuestions | null {
  const whole = crmIntentIn(utterance);
  // These forms explicitly delimit text/JSON to save or run. A question inside that payload
  // stays data, as it did before compound questions; target boundaries are checked by the parser.
  if (whole && (whole.kind === "note" || whole.kind === "named-note" || whole.kind === "task" || whole.kind === "typed" || whole.kind === "invalid")) return null;
  const clauses = businessClauses(utterance);
  if (clauses.length < 2) return null;
  const questions = clauses.map(question);
  // Other compound commands retain their own planners and confirmation paths.
  if (!questions.some(Boolean)) return null;
  if (utterance.length > 600 || clauses.length > MAX_BUSINESS_QUESTIONS || questions.some(q => !q)) return { kind: "unsupported" };
  return { kind: "questions", questions: questions as BusinessQuestion[] };
}
