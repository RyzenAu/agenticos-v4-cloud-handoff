// Rules answer first (Track 2's request, 28 Sep): words a Jarvis rules service answers (shared memory,
// finance, the receptionist, margins) are never turned into "open a page" by the command registry. On
// its own this branch checks the pure matchers it has; Track 2's `ruleAnswerIntent`
// (src/lib/jarvis-intents.ts, adds lead actions, reminders and prices) takes over through
// `setRuleAnswerIntent` when it is present (the palette loads it by file convention). Pure and
// browser-safe: nothing here may import server-side modules (the page would fail to load).
import { matchFinanceIntent } from "../../../scripts/finance/jarvis-intent";
import { matchStripeIntent } from "../../../scripts/finance/stripe-jarvis-intent";
import { receptionistIntent } from "../../../scripts/receptionist/jarvis-intent";

/**
 * Memory's spoken triggers, copied from scripts/memory/voice-intents.ts (that module now imports the
 * server-side approvals store, so it can't load in the browser). scripts/jarvis-route.test.ts checks this
 * copy agrees with parseMemoryIntent on a corpus, so a drift fails a test.
 */
const MEMORY_TRIGGERS: readonly RegExp[] = [
  /^(?:hey jarvis,?\s*)?(?:(?:approve|review|read(?: me)?|check) (?:the |any )?(?:pending|waiting) (?:forgets?|memory (?:deletions?|approvals?|forgets?))|what(?:'s| is| are) (?:waiting|pending) (?:for (?:my )?approval|to be approved)|(?:are there )?any (?:pending|waiting) (?:forgets?|memory approvals?))[?.!]?$/i,
  /^(?:hey jarvis,?\s*)?(?:please\s+)?(?:remember(?!\s+to\b)(?: that)?|make a note(?: that)?|note that|keep in mind(?: that)?)\b[:,]?\s+(.+)$/is,
  /^(?:hey jarvis,?\s*)?(?:please\s+)?(?:save (?:this|it) (?:to|in) (?:the )?(?:vault|wiki|obsidian)|add (?:this )?to (?:the )?(?:vault|wiki)|put (?:this|it) in (?:the )?(?:vault|wiki))\b[:,]?\s+(.+)$/is,
  /^(?:hey jarvis,?\s*)?(?:please\s+)?(?:save|move|put) (?:that|it) (?:to|in|into) (?:the )?(?:vault|wiki|obsidian)[.!]?$/i,
  /^(?:hey jarvis,?\s*)?(?:what do (?:we|you|i) know about|what did we (?:decide|say|agree) (?:about|on)|what(?:'s| is) saved (?:about|on)|do we have anything (?:on|about)|recall|look up in memory)\s+(.+)$/is,
  /^(?:hey jarvis,?\s*)?(?:correct that|correction|that's wrong|that is wrong|update that)\b[:,]?\s*(?:to\s+|it's\s+|it is\s+)?(.+)$/is,
  /^(?:hey jarvis,?\s*)?(?:correct|update|change) the (.+?) (?:fact|memory|note) to\s+(.+)$/is,
  /^(?:hey jarvis,?\s*)?(?:remove (?:that|it) from (?:the )?index|stop indexing (?:that|it)|unindex (?:that|it))[.!]?$/i,
  /^(?:hey jarvis,?\s*)?(?:forget (?:that|it|this)|delete that memory)[.!]?$/i,
  /^(?:hey jarvis,?\s*)?remove (?:the )?(.+?) from memory[.!]?$/is,
  /^(?:hey jarvis,?\s*)?(?:forget (?:about |what (?:i|we) said about |the )?|delete the memory (?:about|of) )(?!(?:it|that|this)[.!]?$)(.+?)(?: (?:fact|memory|note))?[.!]?$/is,
];

/** Would the memory rules take these words? Browser-safe. */
export function memoryWords(text: string): boolean {
  const t = String(text ?? "").trim();
  return !!t && t.length <= 1200 && MEMORY_TRIGGERS.some((re) => re.test(t));
}

export type RuleAnswerKind = "memory" | "finance" | "receptionist" | "leads" | "reminder" | "price" | "margin";
type Detector = (text: string) => RuleAnswerKind | null;

/** This branch's matchers (the same patterns the voice rules use), in Track 2's order. */
export const localRuleAnswerIntent: Detector = (text) => {
  const t = String(text ?? "").trim();
  if (!t || t.length > 600) return null;
  if (memoryWords(t)) return "memory";
  if (receptionistIntent(t)) return "receptionist";
  if (matchFinanceIntent(t) || matchStripeIntent(t)) return "finance";
  return null;
};

// In the browser (Vite), Track 2's detector is picked up by file convention as soon as it is in the build.
const T2: Record<string, { ruleAnswerIntent?: Detector }> =
  typeof import.meta.glob === "function" ? (import.meta.glob("../jarvis-intents.ts", { eager: true }) as Record<string, { ruleAnswerIntent?: Detector }>) : {};
const t2Detector = Object.values(T2)[0]?.ruleAnswerIntent;

let installed: Detector = typeof t2Detector === "function" ? t2Detector : localRuleAnswerIntent;
let override: Detector | null = null;
/** Track 2's ruleAnswerIntent, once it is part of the build (the server voice hook loads it at runtime). */
export function setRuleAnswerIntent(d: Detector | null) {
  installed = d ?? localRuleAnswerIntent;
}
/** Is Track 2's detector in effect (not just this branch's matchers)? */
export function hasTrack2RuleAnswers() {
  return (override ?? installed) !== localRuleAnswerIntent;
}
/** Tests only: use this detector until cleared with null (never touches the installed one). */
export function overrideRuleAnswerIntent(d: Detector | null) {
  override = d;
}
/** Which rules service answers these words, or null (then the registry decides). */
export function ruleAnswerFirst(text: string): RuleAnswerKind | null {
  try {
    return (override ?? installed)(text);
  } catch {
    return localRuleAnswerIntent(text);
  }
}
