/**
 * Pure command intents (Track 2) that both the server and the browser can import: no Node APIs.
 * Lead actions and "remember to …" reminders. plan.ts re-exports them for the server path.
 */

/** CRM statuses a spoken lead action may set (scripts/leads/crm.ts STATUSES), by the words he'd use. */
const LEAD_OUTCOMES: Array<[RegExp, string]> = [
  [/^(?:got )?no (?:answer|reply|response)$|^(?:they |he |she )?(?:didn'?t|did not|never) (?:answer|pick up|pick it up)$|^not answered$|^unanswered$/, "no_answer"],
  [/^(?:(?:left|got|went to) (?:a )?)?voice ?mail$|^left a message$/, "voicemail"],
  [/^call ?back$|^callback$|^call (?:me |us )?back(?: later)?$|^wants a call ?back$/, "call_back"],
  [/^interested$|^keen$/, "interested"],
  [/^not interested$|^uninterested$/, "not_interested"],
  [/^meeting(?: booked)?$|^booked a meeting$|^meeting set$/, "meeting"],
  [/^proposal(?: sent)?$|^sent (?:a |the )?proposal$/, "proposal"],
  [/^won$|^closed won$|^a win$|^a client$|^signed$/, "won"],
  [/^lost$|^closed lost$/, "lost"],
  [/^do not contact$|^don'?t contact$|^do not call$|^don'?t call$/, "do_not_contact"],
];
const outcomeOf = (words: string) => LEAD_OUTCOMES.find(([re]) => re.test(words.trim().toLowerCase().replace(/[.!,]+$/, "")))?.[1] ?? null;
/** "it", "this", "that one": nothing names a lead, so it isn't a CRM command (never a guess). */
const PRONOUN = /^(?:it|this|that|them|him|her|this one|that one|the last one|last one|the lead|that lead|this lead)$/i;

export type LeadAction = { action: "log"; lead: string; outcome: string } | { action: "status"; lead: string; outcome: string } | { action: "next" };
/**
 * "log a call to Synthetic Dental Co as no answer", "log a call with Harbour Dental, voicemail", "I called Harbour
 * Dental, no answer", "mark Synthetic Physio Studio as won", "mark the dentist in Parramatta won",
 * "who should I call next" → a CRM action with a name code resolves (never a guessed lead). Pure.
 */
export function leadActionIn(utterance: string): LeadAction | null {
  const t = utterance.trim().replace(/^(?:hey\s+)?jarvis[,\s]+/i, "").replace(/[.!?]+$/, "");
  if (/^(?:who should i call next|who(?:'s| is) next(?: to call)?|(?:what(?:'s| is) )?(?:my |the )?next (?:call|lead)(?: to call)?)$/i.test(t)) return { action: "next" };
  const named = (lead: string, outcome: string | null, kind: "log" | "status"): LeadAction | null => {
    const name = lead.trim().replace(/[,;:\s]+$/, "");
    if (!outcome || PRONOUN.test(name)) return null;
    return { action: kind, lead: name, outcome };
  };
  let m = /^(?:please\s+)?(?:log|record|note|add)\s+(?:a\s+|the\s+|my\s+)?call\s+(?:to|with|for)\s+(.{2,80}?)\s*(?:\s+as\s+|\s*[,:;-]\s*|\s+-\s+)(.{2,30})$/i.exec(t);
  if (m) return named(m[1], outcomeOf(m[2]), "log");
  m = /^(?:i\s+)?(?:just\s+)?(?:called|rang|phoned|tried)\s+(.{2,80}?)\s*(?:[,:;-]\s*|\s+and\s+(?:got\s+|it went to\s+|it was\s+)?)(.{2,30})$/i.exec(t);
  if (m) return named(m[1], outcomeOf(m[2]), "log");
  m = /^(?:please\s+)?(?:mark|set|move)\s+(.{2,80}?)\s+(?:as|to)\s+(.{2,30})$/i.exec(t);
  if (m) return named(m[1], outcomeOf(m[2]), "status");
  // "mark the dentist in Parramatta won": the outcome is the last word or two, no "as".
  m = /^(?:please\s+)?mark\s+(.{2,80}?)\s+(won|lost|interested|not interested|closed won|closed lost)$/i.exec(t);
  if (m) return named(m[1], outcomeOf(m[2]), "status");
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
