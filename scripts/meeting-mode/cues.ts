// Live cue cards for meeting mode (off by default; docs/MEETING-MODE.md). Local keyword rules,
// no model call, so a card appears within a chunk of the prospect saying it and nothing extra
// leaves the PC. The lines are M&U's own, built from the installed playbook skills
// (objection-destroyer, cold-outreach-board, alex-hormozi-pitch): explore before answering,
// anchor to the cost of the problem, always leave with a dated next step.

export type ObjectionTag = "price" | "incumbent" | "send_info" | "timing" | "trust_privacy" | "relevance" | "think_about_it";
export type Cue = { tag: ObjectionTag | "next_step"; title: string; line: string };

const RULES: Array<{ tag: Cue["tag"]; test: RegExp; title: string; line: string }> = [
  {
    tag: "price",
    test: /\b(?:too (?:expensive|much)|how much (?:is|does|would)|what(?:'s| does) it cost|out of (?:our|the) budget|can't afford|pricey|cheaper|the price)\b/i,
    title: "They raised price",
    line: "Anchor to front-desk cover: \"Who answers the phone when your front desk is busy, at lunch or with a patient? What's one new client worth to you?\"",
  },
  {
    tag: "incumbent",
    test: /\b(?:already (?:have|got|use)|we've got (?:a|someone)|our (?:receptionist|web ?(?:guy|designer|developer)|agency) (?:does|handles)|happy with (?:our|what we))\b/i,
    title: "They have someone already",
    line: "Don't knock them. Find the gap: \"What happens to calls after hours or when the desk's flat out?\"",
  },
  {
    tag: "send_info",
    test: /\b(?:send (?:me|us) (?:some |an? )?(?:info|information|details|email|something)|email (?:me|us) (?:the )?(?:details|info)|send it through)\b/i,
    title: "\"Send me some info\"",
    line: "Agree, then book the look: \"Happy to. Can we put ten minutes in on Thursday so I can walk you through it?\"",
  },
  {
    tag: "timing",
    test: /\b(?:not a good time|bad time|(?:too|really|flat out) busy|call (?:me )?back (?:later|next)|maybe next (?:month|year|quarter)|not right now)\b/i,
    title: "Timing",
    line: "Get a specific slot, not \"later\": \"Totally fair. Is Tuesday at 2 or Thursday at 10 better?\"",
  },
  {
    tag: "trust_privacy",
    test: /\b(?:privacy|patient (?:data|records|information)|client data|is (?:it|this) a scam|a robot|sounds like (?:a )?(?:bot|ai)|data (?:security|breach)|where is (?:the )?data)\b/i,
    title: "Trust or privacy",
    line: "Name the safeguard plainly: they approve the script, calls go to them when it matters, and no recordings are kept without consent.",
  },
  {
    tag: "relevance",
    test: /\b(?:not interested|don't need (?:it|that|one|a website|anything)|we're (?:fine|good|all good)|doesn't (?:apply|suit) us)\b/i,
    title: "\"Not interested\"",
    line: "Ask before you answer: \"Fair enough. Out of curiosity, what happens to calls when everyone's with a client?\"",
  },
  {
    tag: "think_about_it",
    test: /\b(?:think about it|have a think|talk (?:to|with) my (?:partner|business partner|wife|husband|boss)|get back to you|mull it over)\b/i,
    title: "\"I'll think about it\"",
    line: "Label it and explain the concern away: \"Sounds like something's holding you back. Is it the price, or whether it'll work for you?\"",
  },
];

/** Cards triggered by one new chunk of transcript, in order of appearance, one per tag. */
export function cuesFor(text: string): Cue[] {
  const hits = RULES.map((rule) => ({ rule, at: text.search(rule.test) })).filter((h) => h.at >= 0);
  hits.sort((a, b) => a.at - b.at);
  return hits.map(({ rule }) => ({ tag: rule.tag, title: rule.title, line: rule.line }));
}

/** Keeps the latest 1–3 cards, newest first, never the same tag twice. */
export function mergeCues(current: Cue[], fresh: Cue[], max = 3): Cue[] {
  const out: Cue[] = [];
  for (const cue of [...fresh.slice().reverse(), ...current]) {
    if (out.some((c) => c.tag === cue.tag)) continue;
    out.push(cue);
    if (out.length >= max) break;
  }
  return out;
}

const CARD_BY_TAG = new Map(RULES.map((rule) => [rule.tag, { title: rule.title, line: rule.line }]));

/**
 * The same fixed card text `cuesFor`'s regex rules use, for a tag Jev's cloud classifier
 * (objection-jev.ts) detected instead of the regex. Jev never authors the coaching line — this is
 * code-owned text, same guardrail as everywhere else Jev is used: it may only add a suggestion,
 * never generate the content a human sees.
 */
export function cueForTag(tag: ObjectionTag): Cue {
  const card = CARD_BY_TAG.get(tag);
  if (!card) throw new Error(`No card text for objection tag "${tag}".`);
  return { tag, title: card.title, line: card.line };
}
