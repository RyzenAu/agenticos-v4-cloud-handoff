/**
 * Fixed keyword signals shared by Call QA and the follow-up desk.
 *
 * These ROUTE, they never ASSESS. A match means "this call or enquiry mentions something the
 * SOP says must be routed a particular way" (000 advice, a transfer, a call back). Nothing here
 * decides whether a symptom is clinically serious; that judgement stays with the clinic's
 * registered practitioners (SOP §4, Ahpra and TGA rows).
 *
 * Lists follow SOP §5 "Urgent symptoms" for dental. Trades lists are a starting point for
 * tradies and are marked as such. The danger list (threats, violence, weapons, feeling unsafe at
 * home, self-harm) and the legal-urgent list (arrest, custody, police interview, court or a
 * deadline today/tomorrow) mirror the LEGAL playbook in src/lib/buildmaster/research.ts, and
 * src/lib/evals/checks.ts re-exports the danger list, so production grading and the evals agree.
 *
 * Audit 27 Sep 2026, findings B-H1 and B-H3 (receptionist repo commit b71965d), ported here:
 * B-H1 broadened LIFE_SAFETY_HEALTH/DANGER_LANGUAGE to catch missed emergencies (negated/stopped
 * breathing, collapse, choking, heart attack, stroke, seizure, overdose, poisoning, anaphylaxis,
 * an ambulance request, "I want to die", and contraction-aware danger phrasing). B-H3 is the
 * 000-advice negation fix, ported into flags.ts's claimsAdvice000, not this file.
 */

export type NicheKey = 'DENTAL' | 'MEDICAL' | 'TRADES' | 'LEGAL' | 'OTHER';

export function nicheKey(niche: string | null | undefined): NicheKey {
  const value = (niche ?? '').toUpperCase();
  if (value === 'DENTAL' || value === 'MEDICAL' || value === 'TRADES' || value === 'LEGAL') return value;
  return 'OTHER';
}

/** SOP §5: life-safety keywords that must stop everything with 000 advice. */
const LIFE_SAFETY_HEALTH_PARTS = [
  // SOP §5 originals: airway, bleeding, head/face trauma, consciousness, chest pain.
  "\\b(?:hard to (?:breathe|swallow)|can'?t (?:breathe|swallow)|cannot (?:breathe|swallow)|(?:trouble|difficulty) (?:breathing|swallowing)|uncontrolled bleeding|bleeding (?:won'?t|will not|isn'?t|is not|doesn'?t) stop|won'?t stop bleeding|(?:head|facial|face|jaw) (?:injury|trauma)|hit (?:my|his|her|their) (?:head|face)|unconscious|passed out|chest pains?)\\b",
  // Audit B-H1 (27 Sep): negated or stopped breathing, collapse, choking — these were previously
  // missed, so "My dad isn't breathing" raised no flag at all (lead review of 506d5ab).
  "\\b(?:isn'?t|is not|not|aren'?t|are not|wasn'?t|stopped|has stopped|hasn'?t been) breathing\\b",
  "\\b(?:collapsed|unresponsive|(?:is|'s|are|'re|was) choking|turning blue|gone blue)\\b",
  // Cardiac and stroke.
  '\\b(?:heart attack|cardiac arrest|(?:having|had|has had|is having|\'s having) a stroke|signs of (?:a )?stroke|(?:face|mouth) (?:is )?drooping)\\b',
  // Seizure: not a legal "seizure of assets / seizure order".
  '(?<!\\b(?:asset|assets|property|vehicle|car|goods|police|customs|drug|drugs|bank)\\s)\\bseizures?\\b(?!\\s+(?:of|order|orders|warrant|notice|notices))',
  "\\b(?:having|had|has had|is having|'s having) (?:a )?fit\\b|\\b(?:fitting|convuls(?:ing|ions?))\\b",
  // Overdose and poisoning (not food poisoning).
  "\\b(?:overdos(?:e|ed|es|ing)|od'?d|took too many (?:pills|tablets)|swallowed (?:a (?:whole )?bottle of|too many|a handful of|bleach|poison))\\b",
  "(?<!\\bfood\\s)\\bpoison(?:ed|ing)\\b",
  // Anaphylaxis.
  "\\b(?:anaphyla(?:xis|ctic)|(?:having|is having|'s having|going into) (?:an? )?(?:bad |severe |serious )?allergic reaction|throat (?:is |'s )?(?:closing|swelling|tightening)(?: up)?)\\b",
  // The caller asks for an ambulance themselves.
  "\\b(?:need|needs|needed|call|called|calling|get|getting|send|want) (?:an |the |a )?ambulance\\b|\\bambulance (?:now|please|asap)\\b",
];
const LIFE_SAFETY_HEALTH = new RegExp(LIFE_SAFETY_HEALTH_PARTS.join('|'), 'i');

/** Trades starting list: danger to life or property. UNVERIFIED against a tradie SOP. */
const LIFE_SAFETY_TRADES =
  /\b(?:gas leak|smell(?:s|ing)? (?:of )?gas|sparking|electric(?:al)? shock|live wire|on fire|smoke (?:coming|pouring)|water (?:in|near) the (?:power|switchboard|fuse box))\b/i;

// --- Danger language: LIFE-SAFETY on every niche --------------------------------------------
// Violence and threats need a person doing them, so "is it going to hurt me?", "my tooth is
// hurting me" and "this toothache is killing me" never match. A question ("will she hurt me?")
// is excluded too. Built from parts so each piece stays readable.

/** Someone who could be doing the harm. `'s`/`'re` contractions are allowed after it (B-H1). */
const PERSON =
  "(?:he|she|he's|she's|they're|someone|somebody|my (?:ex(?:-(?:husband|wife|partner|boyfriend|girlfriend))?|partner|husband|wife|boyfriend|girlfriend|father|dad|stepfather|stepdad|mother|mum|mom|stepmother|stepmum|brother|sister|son|daughter|uncle|neighbour|neighbor|flatmate|housemate))";
/** Not straight after a question word: "will she hurt me?" is a dental patient, not a threat. */
const NOT_A_QUESTION = "(?<!\\b(?:will|would|could|can|does|did|might|should|won'?t|wouldn'?t|is|are|was|were)\\s+)";
/** "my husband's going to kill me", "my ex's been hitting me" (audit B-H1). */
const CONTRACTION = "(?:'s|'re)?";
/** Harm serious enough that "they" (an unnamed group) is enough of a person (audit B-H1). */
const SEVERE_HARM = '(?:kill|stab|shoot|strangle|bash|attack|burn|murder)';
const VICTIM =
  '(?:me|us|you|him|her|them|my (?:kids|children|son|daughter|baby|mum|mother|dad|father|sister|brother|partner|wife|husband|boyfriend|girlfriend|family)|the (?:kids|children|baby))';
const AUX = "(?:\\s+(?:has|had|have|is|was|were|are|just|keeps|kept|always|been|already|again|started|now))*";
/** Harm that has happened or is happening. */
const ACT =
  '(?:hurt|hurts|hurting|hit|hits|hitting|bashed|bashes|bashing|beat|beats|beating|beaten|punched|punches|punching|kicked|kicks|kicking|choked|chokes|choking|strangled|strangles|strangling|stabbed|shot|attacked|attacks|attacking|assaulted|assaults|assaulting|slapped|slaps|slapping)';
/** Harm that is threatened or intended. */
const INTENT =
  "(?:'ll|'d|\\s+(?:going to|gonna|threatened to|threatening to|threatens to|tried to|trying to|wants to|wanted to|will|would|said (?:he|she|they)(?:'d|'ll|'s going to|'s gonna| would| will| is going to| was going to| is gonna| was gonna)))";
const HARM = '(?:kill|hurt|harm|stab|shoot|strangle|choke|bash|beat|hit|attack|burn)';

const DANGER_PARTS = [
  // "my husband keeps hitting me", "he's been hurting the kids"
  `${NOT_A_QUESTION}\\b${PERSON}${CONTRACTION}${AUX}\\s+${ACT}\\s+${VICTIM}\\b`,
  // "he said he's going to kill me", "my ex will hurt the kids", "she'll kill me",
  // "my husband's going to kill me"
  `${NOT_A_QUESTION}\\b${PERSON}${CONTRACTION}${AUX}${INTENT}\\s+${HARM}\\s+${VICTIM}\\b`,
  // "they are going to kill me", "they'll kill us" — severe harm only, so an anxious patient's
  // "I'm worried they'll hurt me" is not a threat (audit B-H1).
  `${NOT_A_QUESTION}\\b(?:they|people|some (?:guy|guys|man|men|bloke|blokes|people))${AUX}${INTENT}\\s+${SEVERE_HARM}\\s+${VICTIM}\\b`,
  // "he's threatening me", "threatened to kill" — but not "threatening me with legal action"
  `\\bthreaten(?:ed|ing|s)?\\s+(?:to\\s+${HARM}\\b|${VICTIM}\\b(?!\\s+with\\s+(?:legal|court|a (?:lawsuit|court|claim|debt|letter|fine|bill|solicitor|lawyer)|proceedings|eviction|action|debt|collection|an? (?:agency|collector))))`,
  // weapons, anchored to a person or an attack
  `\\b${PERSON}${AUX}(?:\\s+(?:got|pulled(?: out)?|holding|waving|carrying|brandishing|came at me with|went for me with|threatened me with))*\\s+(?:a |an |his |her |their )?(?:knife|gun|firearm|weapon|rifle|shotgun|machete)\\b`,
  '\\b(?:came at|went for|attacked|threatened) (?:me|us) with (?:a |an )?(?:knife|gun|firearm|weapon|rifle|shotgun|machete)\\b',
  // feeling unsafe at home — not "I don't feel safe driving after the sedation"
  "\\b(?:don'?t|do not|doesn'?t|does not|never) feel safe(?=\\s*(?:at home|here|there|going home|to go home|in (?:my|our|the) (?:home|house|flat|unit)|around (?:him|her|them|my \\w+)|with (?:him|her|them|my (?:ex|partner|husband|wife|boyfriend|girlfriend|dad|father|stepdad|stepfather))|any ?more|[.,!?;]|$))",
  "(?:\\bnot|n't|\\bnever) safe (?:at home|here|to go home|going home|in (?:my|our|the) (?:home|house|flat|unit)|around (?:him|her|them))\\b",
  '\\bunsafe (?:at home|here|in (?:my|our|the) (?:home|house|flat|unit))\\b',
  '\\bin (?:immediate |real |serious )?danger\\b(?! of)',
  '\\b(?:domestic|family) (?:violence|abuse)\\b',
  // a protection order being breached
  '\\b(?:breach(?:ed|es|ing)?|broke|broken|breaking|violat(?:ed|es|ing)) (?:the |an |a |my |his |her |their |our )?(?:avo|advo|apvo|dvo|ivo|apprehended (?:domestic |personal )?violence order|intervention order|protection order|restraining order|family violence order)\\b',
  // self-harm — intent, not "I hurt myself falling off my bike"
  "\\b(?:kill(?:ing)? myself|suicid(?:e|al)|self[- ]harm(?:ing)?|end (?:my|my own) life|end it all|better off dead)\\b",
  "\\b(?:want|wanted|going|gonna|plan(?:ning)?|thinking (?:about|of)|thought about|feel like|might|urge) (?:to )?(?:hurt(?:ing)?|harm(?:ing)?|cut(?:ting)?) myself\\b",
  "\\b(?:don'?t|do not) want to (?:live|be alive|be here any ?more)\\b",
  // Audit B-H1: "I want to die", "I wish I was dead".
  "\\b(?:i|i'm|i am)\\s+(?:just\\s+|really\\s+|honestly\\s+)?(?:want|wanna|wanted|going|gonna|ready|about) (?:to )?die\\b|\\bwish (?:i was|i were|i'd) (?:dead|never born)\\b",
];

/**
 * Caller language meaning someone may be in danger: threats, violence, a weapon, feeling unsafe
 * at home, a protection order breached, or self-harm. LIFE-SAFETY on every niche — a dental or
 * trades line too — so the call must carry 000 advice. Re-exported by src/lib/evals/checks.ts
 * as CALLER_DANGER_LANGUAGE so the evals test exactly what production grades.
 */
export const DANGER_LANGUAGE = new RegExp(DANGER_PARTS.join('|'), 'i');

/**
 * Legal-urgent: someone arrested or in custody, police wanting an interview, court or a hearing
 * today/tomorrow, a deadline or limitation period today/tomorrow, bail, a warrant, settlement
 * today/tomorrow. URGENT on a LEGAL (or unclassified) line: routed to a human quickly by
 * transfer or message. No 000 line is required — nobody is in danger. Never "deadline next
 * month", "custody of my kids" or an arrest years ago.
 */
export const LEGAL_URGENT_LANGUAGE = new RegExp(
  [
    "\\b(?:has|have|had|'s|'ve) (?:just |now |already )?been arrested\\b",
    '\\bjust (?:been |got |gotten )?arrested\\b',
    "\\b(?:was|were|got|been) arrested\\b(?![^.?!]{0,25}?\\b(?:(?:19|20)\\d\\d|years? ago|months ago|a (?:long )?(?:time|while) ago|when (?:i|he|she) was (?:young|younger|a kid|a teenager)))",
    "\\b(?:is|are|'s|'re) being arrested\\b|\\bunder arrest\\b",
    '\\bin (?:police |immigration )?custody\\b|\\bremanded\\b|\\bin the (?:cells|lock-?up|watch-?house)\\b|\\b(?:at|held at) the police station\\b',
    '\\bpolice (?:want|wants|wanted|have asked|asked|are asking|need|needs)(?: (?:him|her|me|them|us|my \\w+))? to (?:interview|question|speak (?:to|with)|talk (?:to|with)|come in|attend)\\b',
    '\\bpolice interview (?:is |at |on )?(?:today|tonight|tomorrow|now|this)\\b',
    '\\bquestioned by (?:the )?police\\b',
    '\\b(?:refused|denied) bail\\b|\\bbail (?:hearing|application)\\b|\\b(?:been|was|got|being) charged (?:with|by)\\b',
    '\\bwarrant (?:out )?for (?:my|his|her|their|your) arrest\\b|\\barrest warrant\\b',
    '\\b(?:court|trial|tribunal|hearing)\\b[^.?!]{0,30}?\\b(?:today|tonight|tomorrow|this (?:morning|afternoon))\\b',
    '\\b(?:today|tomorrow)\\b[^.?!]{0,20}?\\b(?:court|trial|tribunal)\\b',
    '\\b(?:deadline|limitation(?: period)?|time limit|cut-?off(?: date)?|due date|closing date)\\b[^.?!]{0,30}?\\b(?:today|tonight|tomorrow)\\b',
    "\\b(?:today|tomorrow|tonight)(?:'s| is)? (?:the )?(?:deadline|last day|cut-?off|due date)\\b",
    '\\blast day to (?:file|lodge|appeal|respond|reply|apply|serve|object|accept)\\b',
    '\\bsettlement\\b[^.?!]{0,20}?\\b(?:today|tomorrow)\\b|\\bsettl(?:es|ing) (?:today|tomorrow)\\b',
  ].join('|'),
  'i',
);

/** SOP §5: dental-urgent (in hours: warm transfer; out of hours: on-call chain). */
const URGENT_DENTAL =
  /\b(?:knocked[- ]out|tooth (?:came|fell|got knocked) out|severe (?:pain|toothache)|(?:really|very|extremely|unbearable|excruciating|so much) (?:bad )?(?:pain|toothache)|swollen|swelling|abscess|broken tooth|cracked tooth|broke (?:my|a) tooth|can'?t sleep (?:because of|from|with) (?:the )?pain)\b/i;

/** Trades starting list. UNVERIFIED against a tradie SOP. */
const URGENT_TRADES =
  /\b(?:burst pipe|flood(?:ing|ed)?|no (?:hot )?water|no power|power(?:'s| is)? out|overflowing|sewage|locked out|roof (?:is )?leaking)\b/i;

const URGENT_GENERIC = /\b(?:urgent(?:ly)?|emergency|asap|as soon as possible|straight away|right away|in agony)\b/i;

export interface UrgencySignals {
  lifeSafety: boolean;
  urgent: boolean;
  /** Which list matched, for the audit trail. Never the matched text. */
  hits: string[];
}

export function urgencySignals(rawText: string, niche: NicheKey): UrgencySignals {
  // Transcribers emit curly apostrophes ("he’s"); the lists are written with straight ones.
  const text = rawText.replace(/[‘’ʼ]/g, "'");
  const hits: string[] = [];
  const lifeHealth = LIFE_SAFETY_HEALTH.test(text);
  const lifeTrades = LIFE_SAFETY_TRADES.test(text);
  const lifeDanger = DANGER_LANGUAGE.test(text);
  if (lifeHealth) hits.push('life_safety_health');
  if (lifeTrades) hits.push('life_safety_trades');
  if (lifeDanger) hits.push('life_safety_danger');

  const dental = URGENT_DENTAL.test(text);
  const trades = URGENT_TRADES.test(text);
  const legal = LEGAL_URGENT_LANGUAGE.test(text);
  const generic = URGENT_GENERIC.test(text);
  if (dental) hits.push('urgent_dental');
  if (trades) hits.push('urgent_trades');
  if (legal) hits.push('urgent_legal');
  if (generic) hits.push('urgent_generic');

  // Health and danger life-safety apply to every niche: a caller who can't breathe, or who says
  // her partner is threatening her, gets 000 advice from a plumber's or a dentist's line too.
  // Trades lists only count for non-health tenants.
  const lifeSafety = lifeHealth || lifeDanger || (lifeTrades && niche !== 'DENTAL' && niche !== 'MEDICAL');
  const urgent =
    lifeSafety ||
    generic ||
    (dental && (niche === 'DENTAL' || niche === 'MEDICAL' || niche === 'OTHER')) ||
    (trades && (niche === 'TRADES' || niche === 'OTHER')) ||
    (legal && (niche === 'LEGAL' || niche === 'OTHER'));
  return { lifeSafety, urgent, hits };
}

/**
 * The agent gave 000 advice. A bare "000" only counts when it is not part of a longer digit run,
 * so reading back a callback number such as 0400 000 123 is never mistaken for the 000 line.
 */
export const AGENT_000_ADVICE =
  /(?<!\d[\s-]?)\b000\b(?![\s-]?\d)|\b(?:triple zero|emergency services|call an ambulance)\b/i;
export const AGENT_TRANSFER = /\b(?:put(?:ting)? you through|transfer(?:ring)? you|connect(?:ing)? you|hand(?:ing)? you over)\b/i;
export const AGENT_MESSAGE =
  /\b(?:take a message|taken a message|pass (?:this|that|it|your message|that message) on|(?:someone|the team|a staff member|the dentist|the practice|we)(?:'ll| will) (?:call|ring|get back to) you|call you back|ring you back|get back to you|on-?call)\b/i;
export const AGENT_BOOKING_CLAIM =
  /\b(?:you'?re (?:all )?(?:booked|set)|you are (?:all )?(?:booked|set)|i'?ve booked|i have booked|booked (?:you|that|it) in|(?:appointment|booking) is (?:confirmed|booked)|confirmed (?:your|the) (?:appointment|booking)|your (?:booking )?reference is)\b/i;
export const CALLER_HUMAN_REQUEST =
  /\b(?:(?:speak|talk) (?:to|with) (?:a |an |the )?(?:real )?(?:person|human|someone|somebody|receptionist|staff|reception|manager)|real person|put me through|transfer me|is there (?:a person|anyone|someone)|operator|(?:don'?t|do not) want to (?:talk|speak) to a (?:robot|bot|machine|computer))\b/i;
export const AGENT_CLARIFY =
  /\b(?:(?:sorry|pardon),? (?:i )?(?:didn'?t|did not) (?:catch|get|understand)|could you (?:please )?(?:repeat|say that again)|i'?m not sure i understand|can you say that again|i didn'?t quite get that)\b/i;
export const CALLER_FRUSTRATION =
  /\b(?:this is (?:ridiculous|useless|stupid|a joke|hopeless)|forget it|never ?mind|waste of (?:my )?time|so (?:annoying|frustrating)|you'?re (?:not (?:listening|helping)|useless)|i give up|stupid (?:robot|bot|machine)|hopeless|what a joke|f+u+c+k\w*|bloody (?:hell|useless))\b/i;
export const AGENT_MEDICATION = /\b(?:ibuprofen|paracetamol|panadol|nurofen|aspirin|codeine|antibiotics?|amoxicillin|\d+\s?mg)\b/i;
export const AGENT_ADVICE_REFUSAL =
  /\b(?:can'?t|cannot|not able to|unable to|don'?t) (?:give|offer|provide|advise)(?: you)? (?:any )?(?:medical|clinical|medication)? ?advice\b/i;

/**
 * Text aimed at a grader, classifier or the assistant itself. Caller and transcript text is
 * untrusted; a match ADDS a flag and never unlocks anything.
 */
export const INJECTION =
  /\b(?:ignore (?:all |any |the )?(?:previous|prior|above|your|earlier) (?:instructions|rules|prompts?)|system prompt|you are now|mark (?:this|the) (?:call|message|enquiry) as|(?:grader|reviewer|classifier|evaluator|triage|ai|assistant|jev)[,:]? (?:please )?(?:ignore|approve|mark|rate|classify|send)|do not flag|don'?t flag|(?:this|the) (?:call|message) (?:is|was) (?:fine|perfect|compliant|not urgent)|as an ai language model|send (?:an? )?(?:sms|text) to)\b/i;

const MONEY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s?dollars?\b/gi;

/** Dollar amounts in a piece of text, as whole cents. */
export function moneyAmounts(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(MONEY)) {
    const raw = (match[1] ?? match[2] ?? '').replace(/,/g, '');
    const value = Number(raw);
    if (Number.isFinite(value)) out.push(Math.round(value * 100));
  }
  return out;
}
