/**
 * Pure command intents (Track 2) that both the server and the browser can import: no Node APIs.
 * Lead actions and "remember to …" reminders. plan.ts re-exports them for the server path.
 */

/** CRM statuses a spoken lead action may set (scripts/leads/crm.ts STATUSES), by the words he'd use. */
const LEAD_OUTCOMES: Array<[RegExp, string]> = [
  [/^no answer$|^didn'?t (?:answer|pick up)$/, "no_answer"],
  [/^(?:left a )?voicemail$/, "voicemail"],
  [/^call ?back$|^callback$/, "call_back"],
  [/^interested$/, "interested"],
  [/^not interested$/, "not_interested"],
  [/^meeting(?: booked)?$|^booked a meeting$/, "meeting"],
  [/^proposal(?: sent)?$/, "proposal"],
  [/^won$|^closed won$|^a win$/, "won"],
  [/^lost$|^closed lost$/, "lost"],
  [/^do not contact$|^don'?t contact$/, "do_not_contact"],
];
const outcomeOf = (words: string) => LEAD_OUTCOMES.find(([re]) => re.test(words.trim().toLowerCase()))?.[1] ?? null;

export type LeadAction = { action: "log"; lead: string; outcome: string } | { action: "status"; lead: string; outcome: string } | { action: "next" } | { action: "count" };
/**
 * "log a call to Synthetic Dental Co as no answer", "mark Synthetic Physio Studio as won",
 * "who should I call next" → a CRM action with a name code resolves (never a guessed lead). Pure.
 */
export function leadActionIn(utterance: string): LeadAction | null {
  const t = utterance.trim().replace(/[.!?]+$/, "");
  if (/^(?:how many open leads(?: do (?:we|i) have| are there)?|(?:what(?:'s| is) (?:the |our |my )?)?(?:open lead count|number of open leads)|(?:show(?: me)?|tell me) (?:the |our |my )?(?:open lead count|number of open leads))$/i.test(t)) return { action: "count" };
  if (/^(?:who should i call next|who(?:'s| is) next(?: to call)?|(?:what(?:'s| is) )?(?:my |the )?next (?:call|lead)(?: to call)?)$/i.test(t)) return { action: "next" };
  let m = /^(?:please\s+)?(?:log|record|note)\s+(?:a\s+|the\s+)?call\s+(?:to|with)\s+(.{2,80}?)\s+as\s+(.{2,30})$/i.exec(t);
  if (m) {
    const outcome = outcomeOf(m[2]);
    return outcome ? { action: "log", lead: m[1].trim(), outcome } : null;
  }
  m = /^(?:please\s+)?(?:mark|set|move)\s+(.{2,80}?)\s+(?:as|to)\s+(.{2,30})$/i.exec(t);
  if (m) {
    const outcome = outcomeOf(m[2]);
    return outcome ? { action: "status", lead: m[1].trim(), outcome } : null;
  }
  return null;
}

/**
 * "remember to call Mehroz at 5 pm" is a REMINDER, not a memory (AUDIT-F4 F13): rewritten to the reminder
 * skill's own words so it becomes a real reminder. "remember that …" stays memory. Pure.
 */
export function rememberToReminder(utterance: string): string | null {
  const m = /^(?:please\s+)?(?:jarvis,?\s+)?(?:remember to|don'?t let me forget to|make sure i)\s+(.{3,200})$/i.exec(utterance.trim());
  return m ? `remind me to ${m[1].replace(/[.!]+$/, "")}` : null;
}
