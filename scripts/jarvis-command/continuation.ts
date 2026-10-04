/** Verified setup followed by work on that same app or browser page. */
import { maskInstructionData } from "./quotes";
import { planRules, type RulePlan } from "./plan";
import { parseGoal } from "../screen-hands/plan";

export type ContinuationPlan = {
  setup: Extract<RulePlan, { lane: "executor" }>;
  remaining: string;
};

/** Offsets stay identical: conjunctions inside dictated text and URLs are data. */
export function taskClauses(text: string): string[] {
  const masked = maskInstructionData(text);
  const splitter =
    /\s*,?\s+(?:and then|then|after that)\s+|\s+and\s+(?=(?:click|press|hit|scroll|type|write|select|choose|fill|open|start|launch|save|search|find|navigate|read)\b)/gi;
  const parts: string[] = [];
  let from = 0;
  for (const m of masked.matchAll(splitter)) {
    parts.push(text.slice(from, m.index).trim());
    from = m.index! + m[0].length;
  }
  parts.push(text.slice(from).trim());
  return parts;
}

/** Plan the complete shape before opening anything; specialist tasks keep their own lanes. */
export function planContinuation(utterance: string): ContinuationPlan | null {
  if (utterance.length > 600) return null;
  // Existing exact executors own the whole request (notably fresh Notepad dictation).
  if (planRules(utterance)?.lane === "executor") return null;
  const text = utterance
    .replace(
      /^\s*(?:(?:hey )?jarvis[,\s]+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/i,
      "",
    )
    .trim();
  const clauses = taskClauses(text);
  if (clauses.length < 2 || clauses.length > 8 || clauses.some((c) => !c)) return null;
  for (let n = clauses.length - 1; n >= 1; n--) {
    const setup = planRules(clauses.slice(0, n).join(" and "));
    if (
      setup?.lane !== "executor" ||
      !["app.open", "open-url", "notepad.type", "deck.blank"].includes(setup.executor)
    )
      continue;
    const remaining = clauses.slice(n).join(" then ");
    if (remaining.length > 300) continue;
    const steps = parseGoal(remaining);
    if (!steps || steps.some((s) => s.do === "say" || s.do === "file")) continue;
    // Another named app/page needs its own verified setup, not an assumed screen click.
    if (clauses.slice(n).some((c) => planRules(c)?.lane === "executor")) continue;
    return { setup, remaining };
  }
  return null;
}
