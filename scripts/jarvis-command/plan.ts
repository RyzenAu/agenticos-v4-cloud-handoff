/**
 * Deterministic command shapes shared by every device (Track 2). Jev chooses between lanes when the
 * words are open; these rules only recognise shapes whose arguments code can fill exactly (an app on
 * the allow-list, a quoted line to type, a named site), so a remote companion gets a typed ExecutorCall
 * and never free text to interpret. Pure: no I/O.
 */
import type { ExecutorName, SpecialistId } from "./contracts";
import { appNameIn, builtinRegistry } from "./registry";
import { fileNameIn } from "../jev-files";
import { receptionistQuestion } from "./receptionist";
import { leadActionIn, rememberToReminder } from "./intents";
import { findQuoted, QUOTED } from "./quotes";

export { findQuoted, QUOTED };

/** "… on my laptop" / "… on Mehroz's PC" / "… here": the machine he named, split off his words. Pure. */
export function splitSpokenTarget(utterance: string): { utterance: string; spokenTarget?: string } {
  const re = /[,\s]+(?:on|using|from)\s+((?:my|his|this|the|usman'?s|mehroz'?s)\s+(?:own\s+)?(?:laptop|notebook|pc|computer|desktop|machine|study pc|home pc|main pc|work pc|surface)|(?:usman|mehroz)'?s?\s+(?:laptop|pc|computer|desktop|machine))\s*[.!?]?$/i;
  const m = re.exec(utterance);
  if (m) return { utterance: utterance.slice(0, m.index).trim(), spokenTarget: m[1].trim() };
  const here = /[,\s]+(?:here|on here|right here)\s*[.!?]?$/i.exec(utterance);
  if (here) return { utterance: utterance.slice(0, here.index).trim(), spokenTarget: "this pc" };
  return { utterance: utterance.trim() };
}

export type RulePlan =
  | { lane: "executor"; executor: ExecutorName; args: Record<string, unknown>; op: string; target?: string; why: string }
  | { lane: "delegate"; to: SpecialistId; op: string; why: string }
  /** A command whose first step an executor can do but whose next step it can't: nothing runs, he's told which (REVIEW-T2 #2). */
  | { lane: "unsupported"; op: string; said: string; why: string };

const quoted = (text: string) => findQuoted(text)?.text;

/** Action verbs a following clause may ask for ("…then email it to John", "…and save it as x.txt"). */
const FOLLOW_ON = /(?:[\s,;]+|^)(?:and then|and|then|after that|,)\s+(?:then\s+)?(?:press|hit|save|send|email|e-mail|mail|message|text|click|close|print|share|post|upload|delete|submit|copy|paste|open|attach|forward|reply|export|rename|move|format|search|play|call|run|show|present)\b/i;
/** A further step after the part an executor can do, in plain words, or null. Pure. */
export function followOnStep(rest: string): string | null {
  const m = FOLLOW_ON.exec(rest);
  return m ? rest.slice(m.index).replace(/^[\s,;]*(?:and then|and|then|after that)?[\s,]*(?:then\s+)?/i, "").replace(/[.!?]+$/, "").trim().slice(0, 80) : null;
}

/** A clause that asks for an action (its first word). Quoted text and URLs are masked before this runs. */
export const CLAUSE_ACTION = /^(?:please\s+)?(?:also\s+)?(?:press|hit|save|send|email|e-mail|mail|message|text|click|tap|close|print|share|post|upload|delete|submit|copy|paste|attach|forward|reply|export|rename|move|format|search|play|call|run|show|present|log ?in|login|sign ?in|sign up|pay|buy|book|schedule|download|install|go to|visit|navigate|open|launch|start|type|write|jot|put|add|create|make)\b/i;

/**
 * Any clause of his words, before OR after the part an executor can do, that asks for another action
 * ("email John and then open notepad and type hi", "open https://example.com and then click the first
 * link", "…then log in"): that clause, else null. `own` matches the executor's own clauses. Pure.
 */
export function strayStep(text: string, own: RegExp, maxOwn = Number.POSITIVE_INFINITY): string | null {
  const masked = text
    .replace(new RegExp(QUOTED.source, "gu"), "QUOTED")
    .replace(/\bhttps?:\/\/\S+/gi, "URL");
  const clauses = masked
    .split(/\s*(?:[,;]|\.\s+|\band then\b|\bthen\b|\band\b|\bafter that\b)\s*/i)
    .map((c) => c.replace(/[.!?]+$/, "").trim())
    .filter(Boolean);
  let owned = 0;
  for (const clause of clauses) {
    if (!CLAUSE_ACTION.test(clause)) continue;
    // The executor's own clause(s), up to how many it has ("open notepad" + "type …"); a second "open …"
    // after a URL is another step, not part of this one.
    if (own.test(clause) && ++owned <= maxOwn) continue;
    return clause.slice(0, 80);
  }
  return null;
}
/** Any clause after the first ("open github.com and scroll down" → "scroll down"), verb or not. Pure. */
export function extraClause(text: string): string | null {
  const masked = text.replace(new RegExp(QUOTED.source, "gu"), "QUOTED").replace(/\bhttps?:\/\/\S+/gi, "URL");
  const clauses = masked.split(/\s*(?:[,;]|\.\s+|\band then\b|\bthen\b|\band\b|\bafter that\b)\s*/i).map((c) => c.replace(/[.!?]+$/, "").trim()).filter(Boolean);
  return clauses.length > 1 ? clauses[1].slice(0, 80) : null;
}
const OWN_NOTEPAD = /^(?:please\s+)?(?:(?:open|launch|start)\b.*\bnotepad\b|(?:type|write|jot|put)\b)/i;
const OWN_DECK = /^(?:please\s+)?(?:(?:open|start|create|make|launch)\b.*\b(?:powerpoint|power point|presentation|deck|slide ?show)\b|add\b.*\bslide\b)/i;
const OWN_OPEN = /^(?:please\s+)?(?:open|go to|visit|pull up|show|bring up|find)\b/i;
/**
 * The named-deck lane's own clauses (REVIEW-T2 R6): create/open/show/present/edit a deck, add a slide (or its
 * title/subtitle), change/edit/set slide N, and present/show/play it. Any other action clause is another step.
 */
export const DECK_STEP =
  /^(?:please\s+)?(?:also\s+)?(?:(?:create|make|start|open|launch|show|present|edit|pull up|bring up)\b.*\b(?:deck|presentation|powerpoint|power point|slide ?show)\b|(?:add|with|plus)\b.*\b(?:slides?|title|subtitle)\b|(?:change|edit|set)\s+slide\s+\d{1,2}\b|(?:show|present|play)(?:\s+(?:it|this|that|them|the\s+(?:deck|presentation|slides?|slide ?show)))?(?:\s+(?:full ?screen|now|please))*$)/i;

/** "open Notepad and type 'hello' then press enter" → { line: "hello", extra: "press enter" }. Pure. */
export function notepadParts(text: string): { line: string; extra: string | null } | null {
  if (!/\bnotepad\b/i.test(text) || !/\b(?:type|write|jot|put)\b/i.test(text)) return null;
  const tail = text.slice(text.search(/\b(?:type|write|jot|put)\b/i));
  const q = findQuoted(tail);
  if (q) return { line: q.text, extra: followOnStep(tail.slice(q.index + q.length)) };
  const body = /^(?:type|write|jot down|jot|put)\s+(?:in\s+)?(.{1,400})$/i.exec(tail)?.[1] ?? "";
  const split = FOLLOW_ON.exec(body);
  const extra = split ? followOnStep(body.slice(split.index)) : null;
  const lineText = (split ? body.slice(0, split.index) : body).replace(/\s*(?:in(?:to)? (?:it|there|notepad|the new doc(?:ument)?))?\s*[.!?]?$/i, "");
  const line = lineText.replace(/^(?:(?:the|a) (?:line|text|note)\s+)?(?:saying|that says|reading)?\s*/i, "").trim().slice(0, 200);
  return line ? { line, extra } : null;
}

/** "open Notepad and type 'hello'" → the line to type (quoted, or everything after "type"). */
export function notepadLine(text: string): string | null {
  return notepadParts(text)?.line ?? null;
}

/** "open a new PowerPoint and add a title slide 'Q3 plan'" → the title (never saved). */
export function blankDeckTitle(text: string): string | null {
  if (!/\b(?:new|blank|empty)\s+(?:powerpoint|power point|presentation|deck|slide ?show)\b/i.test(text)) return null;
  if (/\b(?:called|named|save|saved|save as)\b/i.test(text)) return null; // a named deck is jev-powerpoint's (saved under a root)
  const q = quoted(text);
  if (q) return q;
  const m = /\btitle(?: slide)?\s+(?:saying|that says|reading|with|of)\s+(.{1,120}?)\s*[.!?]?$/i.exec(text);
  return m?.[1]?.trim() || "Title";
}
/** A step asked for after the new deck's title ("… 'Q3' and send it to Mehroz"), or null. Pure. */
export function blankDeckExtra(text: string): string | null {
  const q = findQuoted(text);
  return followOnStep(q ? text.slice(q.index + q.length) : text.replace(/^.*?\b(?:powerpoint|power point|presentation|deck|slide ?show)\b/i, ""));
}

const MEMORY = /^(?:please\s+)?(?:remember|save (?:this|that) to (?:the )?vault|what do (?:we|i) know about|forget|correct that)\b/i;

/** The deterministic plan for his words, or null (Jev and the rest of the entry decide). Pure. */
export function planRules(utterance: string): RulePlan | null {
  const t = utterance.trim();
  if (rememberToReminder(t)) return { lane: "delegate", to: "reminder", op: "reminder.set", why: "\"remember to …\" is a reminder: the reminder skill sets a real one" };
  if (leadActionIn(t)) return { lane: "delegate", to: "leads", op: "leads.action", why: "a CRM action on a named lead: the leads service, read back after the write" };
  if (MEMORY.test(t)) return { lane: "delegate", to: "memory", op: "memory.voice", why: "a memory request: the shared memory path (save, recall, correct, forget)" };
  if (receptionistQuestion(t)) return { lane: "delegate", to: "receptionist", op: `receptionist.${receptionistQuestion(t)}`, why: "the receptionist's state comes from its own dashboard and feed, cited" };
  // Any other action asked for in the same breath (before or after this one) means nothing runs, and the
  // step is named (REVIEW-T2 #2, R2): never half-done and called done.
  const stray = (op: string, can: string, step: string): RulePlan => ({
    lane: "unsupported",
    op,
    why: `another step ("${step}") that no executor runs in the same command`,
    said: `I can ${can}, but not "${step}" in the same command, so I haven't done any of it. Ask me for one step at a time.`,
  });
  const np = notepadParts(t);
  if (np) {
    const extra = np.extra ?? strayStep(t, OWN_NOTEPAD, 2);
    if (extra) return stray("notepad.type", "type that line into a new Notepad document", extra);
    return { lane: "executor", executor: "notepad.type", args: { text: np.line }, op: "notepad.type", target: "notepad", why: "a line typed into a NEW Notepad document, read back, never saved" };
  }
  const title = blankDeckTitle(t);
  if (title) {
    const extra = blankDeckExtra(t) ?? strayStep(t, OWN_DECK, 2);
    if (extra) return stray("deck.blank", "start a new PowerPoint with that title slide", extra);
    return { lane: "executor", executor: "deck.blank", args: { title }, op: "deck.blank", target: "powerpoint", why: "a new, never-saved PowerPoint with a title slide, read back from PowerPoint" };
  }
  const urlMatch = /\bopen\s+(https?:\/\/[^\s"']{3,200})/i.exec(t);
  if (urlMatch) {
    // REVIEW-T2 R3: the URL ends at trailing punctuation; ANY words after it (or an action before it) are
    // another step — no verb list ("…and scroll down", "…, then zoom in", "…and read it to me").
    const url = urlMatch[1].replace(/[,.;:!?)\]]+$/, "");
    const after = t.slice(urlMatch.index + urlMatch[0].length - (urlMatch[1].length - url.length)).replace(/^[\s,.;:!?)\]]+/, "").replace(/^(?:and then|and|then|after that)\s+/i, "").replace(/[.!?]+$/, "").trim().replace(/^(?:please|thanks|thank you|for me|now|mate|sir)(?:[\s,]+(?:please|thanks|thank you|for me|now|mate|sir))*$/i, "");
    const before = t.slice(0, urlMatch.index).replace(/^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:please\s+|can you\s+|could you\s+)?/i, "").trim();
    const extra = after || (before ? before.replace(/[\s,;]*(?:and then|and|then)?\s*$/i, "") : "") || strayStep(t, OWN_OPEN, 1);
    if (extra) return stray("open-url", `open ${safeHost(url)}`, extra.slice(0, 80));
    return { lane: "executor", executor: "open-url", args: { url }, op: "open-url", target: safeHost(url), why: "a public web page" };
  }
  const app = /^(?:please\s+)?(?:open|launch|start|fire up|bring up|run)\b/i.test(t) && !/\b(?:and|then)\b/i.test(t) ? appNameIn(t) : null;
  if (app) return { lane: "executor", executor: "app.open", args: { name: app }, op: "app.open", target: app, why: `open ${app} and confirm its window appeared` };
  // A document by name (after apps, so "open File Explorer" is the app, not a file called "Explorer";
  // "find my notes about pricing" is a question, not a file called "about pricing": AUDIT-F4 F15).
  const file = fileNameIn(t);
  // "open the deck Q3 plan and add a slide called Notes": every clause is a deck step, so the named-deck
  // lane has it (its own stray check asks about anything else), not a false ask from the file rule.
  // "open the deck Plan and show it" / "…and present it" is deck-only too (REVIEW-T2 R8): a show/present
  // step after the deck, with no slide word. A bare "open the deck Plan" stays the file rule's.
  const deckStepAfter = /\bslides?\b/i.test(t) || /(?:[,;]|\band\b|\bthen\b)\s*(?:then\s+)?(?:please\s+)?(?:show|present|play)\b/i.test(t);
  const deckOnly = /\b(?:deck|presentation|powerpoint|slide ?show)\b/i.test(t) && deckStepAfter && !strayStep(t, DECK_STEP);
  if (file && !deckOnly && !/^about\b/i.test(file) && !/\byou\s?tube\b/i.test(t)) {
    const extra = strayStep(t, OWN_OPEN, 1);
    if (extra) return stray("file.open", "open that file", extra);
    return { lane: "executor", executor: "file.open", args: { name: file }, op: "file.open", target: file, why: "a document by name inside that device's authorised folders" };
  }
  const site = /^(?:please\s+)?(?:open|go to|visit|pull up)\b/i.test(t) ? builtinRegistry().resolve(t).find((d) => d.kind === "website" && d.label !== "YouTube") : undefined;
  if (site) {
    const extra = extraClause(t) ?? strayStep(t, OWN_OPEN, 1);
    if (extra) return stray("open-url", `open ${site.label}`, extra);
    return { lane: "executor", executor: "open-url", args: { url: site.ref }, op: "open-url", target: site.label, why: `the public site ${site.label}` };
  }
  // "open github.com and sign in": a site plus another step → nothing runs (the website lane would drop it).
  const siteLead = /^(?:please\s+)?(?:open|go to|visit|pull up)\s+((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/i.exec(t);
  if (siteLead) {
    const extra = extraClause(t) ?? strayStep(t, OWN_OPEN, 1);
    if (extra) return stray("open-url", `open ${siteLead[1].toLowerCase()}`, extra);
  }
  // "open github.com": a bare public domain (never a file name with an extension).
  const domain = /^(?:please\s+)?(?:open|go to|visit|pull up)\s+((?:[a-z0-9-]+\.)+[a-z]{2,24})(\/[^\s"']*)?\s*[.!]?$/i.exec(t);
  if (domain && !/\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|md|png|jpe?g|gif|zip|json|html?)$/i.test(domain[1]))
    return { lane: "executor", executor: "open-url", args: { url: `https://${domain[1].toLowerCase()}${domain[2] ?? "/"}` }, op: "open-url", target: domain[1].toLowerCase(), why: `the public site ${domain[1].toLowerCase()}` };
  return null;
}

export function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "a page";
  }
}


/** "open the receptionist page" / "take me to leads" → the OS page (built-in registry), else null. Pure. */
export function osPageIn(utterance: string): { path: string; label: string } | null {
  if (!/^(?:please\s+)?(?:open|show(?: me)?|go to|take me to|pull up|bring up|switch to)\b/i.test(utterance.trim())) return null;
  if (/\b(?:file|document|deck|presentation|powerpoint|notepad|app|youtube|video|https?:)/i.test(utterance)) return null;
  const hit = builtinRegistry().resolve(utterance)[0];
  return hit?.kind === "os-page" ? { path: hit.ref, label: hit.label } : null;
}

export { leadActionIn, rememberToReminder, type LeadAction } from "./intents";
