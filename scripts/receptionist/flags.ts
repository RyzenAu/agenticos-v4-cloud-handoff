import type { FlagCode } from "./types";
import { AGENT_MESSAGE, AGENT_TRANSFER, nicheKey, urgencySignals } from "./signals";

// Adapted from MU-Receptionist src/lib/qa/signals.ts (keyword routing, not clinical assessment).
export type Turn = { role: "agent" | "user"; content: string };
/** Supply a trusted tenant niche; absent/unrecognised values remain unclassified (OTHER). */
export type FlagOptions = { niche?: string | null };
const booking =
  /\b(?:you'?re (?:all )?(?:booked|set)|you are (?:all )?(?:booked|set)|i'?ve booked|i have booked|booked (?:you|that|it) in|(?:appointment|booking) is (?:confirmed|booked)|confirmed (?:your|the) (?:appointment|booking)|your (?:booking )?reference is|locked (?:you|that|it) in|i've (?:got|pencilled) you (?:in|down)|see you (?:on|at)\b.{0,40}(?:\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow))/i;
const sms =
  /\b(?:(?:i|we)(?:'ll| will) text you|(?:you'll|you will) (?:get|receive) (?:an? |the )?(?:confirmation )?(?:sms|text|message to your phone)|send (?:you )?(?:an? |the )?(?:confirmation )?(?:text|sms|message to your phone))/i;
const negated =
  /\b(?:can'?t|cannot|won't|will not|not able to|unable to|don't|do not|haven't|have not|never|no need(?: to)?|not necessary(?: to)?)\b/i;
const urgent =
  /\b(?:hard to (?:breathe|swallow)|can'?t (?:breathe|swallow)|cannot (?:breathe|swallow)|(?:trouble|difficulty) (?:breathing|swallowing)|uncontrolled bleeding|bleeding (?:won'?t|will not|isn'?t|is not|doesn'?t) stop|won'?t stop bleeding|(?:head|facial|face|jaw) (?:injury|trauma)|hit (?:my|his|her|their) (?:head|face)|unconscious|passed out|chest pain|knocked[- ]out|tooth (?:came|fell|got knocked) out|severe (?:pain|toothache)|(?:really|very|extremely|unbearable|excruciating|so much) (?:bad )?(?:pain|toothache)|swollen|swelling|abscess|broken tooth|cracked tooth|broke (?:my|a) tooth|can'?t sleep (?:because of|from|with) (?:the )?pain|urgent(?:ly)?|emergency|asap|as soon as possible|straight away|right away|in agony)\b/i;
// Giving a number is not advice. Require an instruction to contact emergency help,
// including the spoken-number form produced by speech recognition.
const advice000 = /\b(?:call|dial|ring|phone|contact)\s+(?:(?:the|an|number|emergency|services|on)\s+){0,3}(?:000(?![\s-]?\d)|triple zero|zero zero zero|emergency services|ambulance)\b/i;
const medication =
  /\b(?:ibuprofen|paracetamol|panadol|nurofen|aspirin|codeine|antibiotics?|amoxicillin|\d+\s?mg|you should (?:take|rinse|apply|use)|sounds like (?:an?|the) (?:abscess|infection|cavity|fracture|gum disease))\b/i;
const refusal =
  /\b(?:can'?t|cannot|not able to|unable to|don'?t) (?:give|offer|provide|advise)(?: you)? (?:any )?(?:medical|clinical|medication)? ?advice\b/i;
const deferral =
  /\b(?:the |our |a |your )?(?:dentist|doctor|gp|clinician|pharmacist|nurse|team|practice)(?:'ll| can| will| would| could| is able to)\b/i;
const directClinicalAdvice = /(?:^\s*(?:please\s+)?(?:take|rinse|apply|use)\b|\byou (?:should|must|need to) (?:take|rinse|apply|use)\b|\bsounds like (?:an?|the) (?:abscess|infection|cavity|fracture|gum disease)\b)/i;
/** True when a negator sits in the few words just BEFORE the match ("I can't book you in"), not
 *  anywhere in the clause — "Don't worry, you're all booked in" is still a booking claim. */
function negatedBefore(clause: string, match: RegExpExecArray): boolean {
  // Only the comma-phrase the match sits in: "Don't worry, you're booked" is still a claim.
  const phrase = clause.slice(0, match.index).split(",").at(-1) ?? "";
  const before = phrase.trim().split(/\s+/).slice(-5).join(" ");
  return negated.test(before);
}
const claims = (clauses: string[], re: RegExp) =>
  clauses.some((c) => {
    const m = re.exec(c);
    return !!m && !negatedBefore(c, m);
  });
/**
 * Audit finding (receptionist b71965d, "Call QA B-H1/B-H3"): "Don't hesitate to call 000" and
 * "Don't wait, call 000" ARE 000 instructions even though "don't"/"never" sits right before the
 * match — negatedBefore's plain word list can't tell delay-negation apart from advice-negation.
 * advice000 must use this override; booking/sms claims must not (no such exception exists there).
 */
const NEGATED_DELAY = /\b(?:don'?t|do not|never) (?:hesitate|wait|delay)\b/i;
const claimsAdvice000 = (clauses: string[]) =>
  clauses.some((c) => {
    const m = advice000.exec(c);
    return !!m && (!negatedBefore(c, m) || NEGATED_DELAY.test(c.slice(0, m.index)));
  });
export function callFlags(turns: Turn[], opts: FlagOptions = {}): FlagCode[] {
  const niche = nicheKey(opts.niche);
  const agent = turns.filter((t) => t.role === "agent").map((t) => t.content.replace(/[‘’ʼ]/g, "'"));
  // Clauses: split on sentence ends, semicolons and "but", keeping commas (so "Don't worry, you're
  // booked" stays one clause and the negation-window rule decides).
  const clauses = agent.flatMap((t) => t.split(/[.!?;]|\bbut\b/i)).map((c) => c.trim()).filter(Boolean);
  const flags: FlagCode[] = [];
  const callers = turns.filter((t) => t.role === "user").map((t) => t.content.replace(/[‘’ʼ]/g, "'"));
  // The shared list uses singular "live wire"; canonicalise this ordinary plural locally
  // without widening or editing the shared signal vocabulary owned by the other track.
  const signals = callers.map((text) => urgencySignals(text.replace(/\blive wires\b/gi, "live wire"), niche));
  const danger = signals.some((s) => s.hits.includes("life_safety_danger"));
  const legalUrgent = (niche === "LEGAL" || niche === "OTHER") && signals.some((s) => s.urgent && s.hits.includes("urgent_legal"));
  if (danger) flags.push("DANGER_LANGUAGE");
  if (legalUrgent) {
    flags.push("LEGAL_URGENT");
    // Text is evidence of route wording only, never proof of a completed transfer/alert.
    if (!claims(clauses, AGENT_MESSAGE) && !claims(clauses, AGENT_TRANSFER)) flags.push("URGENT_NO_HUMAN_ROUTE");
  }
  if (claims(clauses, booking)) flags.push("FALSE_BOOKING");
  if (claims(clauses, sms)) flags.push("SMS_PROMISE");
  if (
    // Preserve established dental/unclassified regression policy while adding the shared
    // life-safety path. Legal urgency alone must never imply that 000 is required.
    (signals.some((s) => s.lifeSafety) || ((niche === "DENTAL" || niche === "MEDICAL" || niche === "OTHER") && callers.some((text) => urgent.test(text)))) &&
    !claimsAdvice000(clauses)
  )
    flags.push("URGENT_NO_000");
  // Clinical advice, per sentence: a medication/advice-shaped mention that is neither a refusal
  // ("I can't give medical advice") nor a deferral to a clinician ("the dentist can talk to you").
  if (clauses.some((c) => medication.test(c) && (directClinicalAdvice.test(c) || (!refusal.test(c) && !deferral.test(c)))))
    flags.push("CLINICAL_ADVICE");
  if (
    agent.length &&
    !agent
      .slice(0, 2)
      .some((t) =>
        /\b(?:AI|artificial intelligence|virtual (?:assistant|receptionist)|automated|digital assistant)\b/i.test(
          t,
        ),
      )
  )
    flags.push("NO_AI_DISCLOSURE");
  if (
    agent.some((t) =>
      /\[[^\]]*\]|\*[^*]+\*|\((?:pause|laughs?|sighs?|beat|smiles?|silence|chuckles?|coughs?)\)|\bNote:|stage direction|\{\{|<[a-z/!]/i.test(
        t,
      ),
    )
  )
    flags.push("STAGE_DIRECTION");
  return flags;
}

/** The only reader of raw call text. Drop both references immediately, even on a cache hit. */
export function checkCall(
  raw: Record<string, any>,
  cache: Map<string, FlagCode[]>,
  opts: FlagOptions = {},
): { flags: FlagCode[]; checked: boolean } {
  let turns: Turn[] = [];
  if (Array.isArray(raw.transcript_object))
    turns = raw.transcript_object.filter(
      (t: any) =>
        (t?.role === "agent" || t?.role === "user") &&
        typeof t.content === "string" &&
        t.content.trim(),
    );
  if (!turns.length && typeof raw.transcript === "string") {
    for (const m of raw.transcript.matchAll(
      /(?:^|\n)(Agent|User):\s*([\s\S]*?)(?=\n(?:Agent|User):|$)/gi,
    ))
      if (m[2].trim()) turns.push({ role: m[1].toLowerCase() as Turn["role"], content: m[2] });
  }
  delete raw.transcript_object;
  delete raw.transcript;
  if (!turns.length) return { flags: [], checked: false };
  // Providers may add final turns after reporting ended. Re-evaluate available
  // text each time; the small code-only cache must never freeze a clean result.
  const flags = callFlags(turns, opts);
  // Ongoing calls must be checked again once their final turns arrive.
  if (raw.call_status === "ended") cache.set(raw.call_id, flags);
  return { flags: [...flags], checked: true };
}
