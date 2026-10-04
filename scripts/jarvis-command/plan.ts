/**
 * Deterministic command shapes shared by every device (Track 2). Jev chooses between lanes when the
 * words are open; these rules only recognise shapes whose arguments code can fill exactly (an app on
 * the allow-list, a quoted line to type, a named site), so a remote companion gets a typed ExecutorCall
 * and never free text to interpret. Pure: no I/O.
 */
import type { ExecutorName, SpecialistId } from "./contracts";
import { crmIntentIn } from "./crm";
import { businessQuestionsIn } from "./compound-questions";
import { appNameIn, builtinRegistry } from "./registry";
import { fileNameIn } from "../jev-files";
import { receptionistQuestion } from "./receptionist";
import { leadActionIn, rememberToReminder } from "./intents";
import { findQuoted, maskInstructionData, QUOTED } from "./quotes";

export { findQuoted, QUOTED };

/** "… on my laptop" / "… on Mehroz's PC" / "… here": the machine he named, split off his words. Pure. */
export function splitSpokenTarget(utterance: string): { utterance: string; spokenTarget?: string } {
  const re = /[,\s]+(?:on|using|from)\s+((?:my|his|this|the|usman'?s|mehroz'?s)\s+(?:own\s+)?(?:laptop|notebook|pc|computer|desktop|machine|study pc|home pc|main pc|work pc|surface)|(?:usman|mehroz)'?s?\s+(?:laptop|pc|computer|desktop|machine))\s*[.!?]?$/i;
  const m = re.exec(utterance);
  if (m) return { utterance: utterance.slice(0, m.index).trim(), spokenTarget: m[1].trim() };
  // Round 11: the machine named FIRST ("on my PC open YouTube and then open the file X"): the same split, so the rest is read as his steps.
  // Only a device ("on my PC", "using Mehroz's laptop"), never a folder or place on one ("From the desktop folder open report.pdf",
  // "on the desktop open notes.txt"): "desktop" here means the computer only with my/his/a person's name, and a folder word after it isn't a device.
  const lead = /^\s*(?:on|using)\s+((?:my|his|this|usman'?s|mehroz'?s)\s+(?:own\s+)?(?:laptop|notebook|pc|computer|desktop|machine|study pc|home pc|main pc|work pc|surface)|the\s+(?:laptop|notebook|pc|computer|machine|study pc|home pc|main pc|work pc|surface)|(?:usman|mehroz)'?s?\s+(?:laptop|pc|computer|desktop|machine))(?!\s+(?:folder|directory|drive|files?|screen|icons?)\b)[,\s]+(?=\S)/i.exec(utterance);
  if (lead) return { utterance: utterance.slice(lead[0].length).trim(), spokenTarget: lead[1].trim() };
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
/** YouTube work (search, a result, play/pause, watch) belongs to the hub's app-owned browser lane; a bare "open YouTube" is just a site open like any other. */
const YOUTUBE_WORK = /\b(?:search|play|pause|resume|unpause|watch|videos?|results?|click|summari[sz]e)\b/i;
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
  // No title asked for: "" (a blank new presentation), never a made-up "Title".
  return m?.[1]?.trim() || "";
}
/** "open Chrome and create a new tab", "open a new tab": the whole request is one blank tab in Jarvis Chrome. Pure. */
export function blankTabIn(text: string): boolean {
  const t = text.trim().replace(/^(?:(?:hey )?jarvis[,\s]+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/i, "").replace(/[\s,.!?]+(?:please|thanks|thank you)?[.!?]*$/i, "");
  return (
    /^(?:open|launch|start|fire up)\s+(?:up\s+)?(?:google\s+)?chrome\s*(?:,|\band\b|\bthen\b)\s*(?:and\s+)?(?:then\s+)?(?:create|open|make|start|add|give me|get me|put up)\s+(?:me\s+)?(?:a\s+)?(?:new|blank|fresh|another)\s+tab$/i.test(t) ||
    /^(?:create|open|make|start|add|give me|get me)\s+(?:me\s+)?(?:a\s+)?(?:new|blank|fresh)\s+(?:chrome\s+|browser\s+)?tab(?:\s+in\s+(?:google\s+)?chrome)?$/i.test(t) ||
    // "open a Chrome tab", "can you open a browser tab", "bring up a Chrome tab": a tab, not a window to bring forward (round 9: this was refused as "vague").
    /^(?:create|open|make|start|add|give me|get me|bring up|pull up|put up|have)\s+(?:me\s+)?(?:up\s+)?(?:a|another|one)\s+(?:google\s+)?(?:chrome|browser)\s+tab(?:\s+(?:open|up))?$/i.test(t)
  );
}
/** A step asked for after the new deck's title ("… 'Q3' and send it to Mehroz"), or null. Pure. */
export function blankDeckExtra(text: string): string | null {
  const q = findQuoted(text);
  return followOnStep(q ? text.slice(q.index + q.length) : text.replace(/^.*?\b(?:powerpoint|power point|presentation|deck|slide ?show)\b/i, ""));
}

const MEMORY = /^(?:please\s+)?(?:remember|save (?:this|that) to (?:the )?vault|what do (?:we|i) know about|forget|correct that)\b/i;

// ── web searches and linked steps (round 10) ──────────────────────────────────────────────────────────────────────
/** A polite lead in front of an order ("hey Jarvis, can you please ..."). */
const POLITE_LEAD = /^(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i;
/** "open Google" / "go to google.com" on its own: the search engine, with nothing searched yet. */
const OPEN_GOOGLE = /^(?:open|go to|pull up|bring up|load|visit)\s+(?:up\s+)?(?:google|google\.com|www\.google\.com)$/i;
/** The search clause after "open Google": "search for X", "and search X", "then look up X", "search it for X". */
const SEARCH_AFTER_OPEN = /^(?:and\s+)?(?:then\s+)?(?:search|look up|look for)(?:\s+(?:google|it|there))?(?:\s+for)?\s+(.+)$/i;
/** A whole search clause that names Google (or the web): "search Google for X", "google search X", "look up X on Google". */
const SEARCH_GOOGLE = [
  /^(?:search|look up|look for)\s+(?:on\s+)?(?:google|the web|the internet|online)\s+(?:for\s+)?(.+)$/i,
  /^google\s+search\s+(?:for\s+)?(.+)$/i,
  /^(?:search|look up)\s+(?:for\s+)?(.+?)\s+(?:on|in|with)\s+google$/i,
];

/**
 * The exact words to search for: a quoted phrase is taken as quoted; otherwise the words exactly as said, minus closing punctuation and a
 * trailing "please". Never reworded, never shortened (acceptance #3: the exact query). Pure.
 */
export function exactQuery(raw: string): string | null {
  let q = raw.trim();
  const quotedWhole = findQuoted(q);
  if (quotedWhole && quotedWhole.index === 0 && quotedWhole.length >= q.replace(/[.!?]+$/, "").length) return quotedWhole.text.slice(0, 300);
  q = q.replace(/[\s,]+(?:please|thanks|thank you|for me)\s*[.!?]*$/i, "").replace(/[.!?]+$/, "").trim();
  return q && q.length <= 300 ? q : null;
}

export const googleSearchUrl = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;

/** One Google search as a typed step: its results page, so the exact query is in the address and can be checked there. */
function searchStep(query: string): Extract<RulePlan, { lane: "executor" }> {
  return { lane: "executor", executor: "open-url", args: { url: googleSearchUrl(query), query }, op: "web.search", target: "google.com", why: "a Google search for exactly these words, opened as its results page" };
}

/** A single clause that is a Google search by itself ("search Google for X"), or null. Pure. */
function googleSearchClause(clause: string): Extract<RulePlan, { lane: "executor" }> | null {
  for (const re of SEARCH_GOOGLE) {
    const m = re.exec(clause);
    const q = m ? exactQuery(m[1]) : null;
    if (q) return searchStep(q);
  }
  return null;
}

/**
 * His words split into ordered clauses at "then", "and then", "after that", ";" or ", " and at "and" before another order verb. Quoted text
 * and URLs are data: a conjunction inside them never splits (offsets are kept by masking). Pure.
 */
export function orderedClauses(text: string): string[] {
  const masked = maskInstructionData(text);
  const splitter = /\s*;\s*|\s*,\s*(?:and\s+)?(?:then\s+)?|\s+and then\s+|\s+then\s+|\s+after that\s+|\s+and\s+(?=(?:open|go to|visit|pull up|bring up|launch|start|search|look up)\b)/gi;
  const parts: string[] = [];
  let from = 0;
  for (const m of masked.matchAll(splitter)) {
    parts.push(text.slice(from, m.index).trim());
    from = m.index! + m[0].length;
  }
  parts.push(text.slice(from).trim());
  return parts.map((p) => p.replace(/^(?:and\s+)?(?:then\s+)?/i, "").trim()).filter(Boolean);
}

/**
 * The words to search for when Jev has chosen "open a page or search on his device" for looser phrasing than the exact rules take
 * ("search for X", "google X", "look up X online", "find X on the web"). Exactly as said (exactQuery); null when no search phrase is
 * there, so the caller asks rather than inventing one. Pure.
 */
export function searchQueryIn(utterance: string): string | null {
  const t = utterance.trim().replace(POLITE_LEAD, "").replace(/^(?:open|go to|pull up)\s+(?:up\s+)?(?:google|google\.com|the browser|a browser|chrome)\s*(?:,|and|then)?\s*(?:then\s+)?/i, "");
  const exact = googleSearchClause(t);
  if (exact) return String(exact.args.query);
  const m = /^(?:search|google|look up|look for|find)(?:\s+(?:google|the web|the internet|online))?(?:\s+for)?\s+(.+?)(?:\s+(?:on|in|with|using)\s+(?:google|the web|the internet)|\s+online)?\s*[.!?]*$/i.exec(t);
  if (!m || /^google\s+chrome$/i.test(t)) return null;
  return exactQuery(m[1]);
}

/** A public site his words name ("open stripe.com", "go to the YouTube site"): its https address, or null. Never a private host. Pure. */
export function siteIn(utterance: string): string | null {
  const domain = /\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|au|co|dev|app|gov|edu|uk|nz)(?:\.[a-z]{2})?)\b(\/[^\s"']*)?/i.exec(utterance);
  if (domain && !/\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|md|png|jpe?g|gif|zip|json|html?)$/i.test(domain[1])) return `https://${domain[1].toLowerCase()}${domain[2] ?? "/"}`;
  const site = builtinRegistry().resolve(utterance).find((d) => d.kind === "website");
  return site ? site.ref : null;
}

export type LinkedStep ={ executor: ExecutorName; args: Record<string, unknown>; label: string };

/**
 * A request made only of exact, supported steps, in order (acceptance #3/#4): "Open Google, search for X, then open YouTube" →
 * [Google results for exactly X, YouTube]. "Open Google and search for X" is ONE step (the search). Any clause that is not an exact step
 * (a click, a form, "and tidy it up") makes the whole thing null: the caller's other rules (and Jev) decide it, nothing is half-planned.
 * Pure: no I/O.
 */
export function linkedSteps(utterance: string): LinkedStep[] | null {
  const text = utterance.trim().replace(POLITE_LEAD, "").replace(/[\s,.!?]+$/, "");
  if (!text || text.length > 600) return null;
  const clauses = orderedClauses(text);
  if (!clauses.length || clauses.length > MAX_LINKED_STEPS) return null;
  const steps: LinkedStep[] = [];
  for (let i = 0; i < clauses.length; i++) {
    // "open Gmail and then YouTube": a clause with no verb of its own after an open takes that open ("open YouTube"), its words unchanged.
    const c = i > 0 && steps.length && !CLAUSE_ACTION.test(clauses[i]) && !SEARCH_AFTER_OPEN.test(clauses[i]) ? `open ${clauses[i]}` : clauses[i];
    const next = clauses[i + 1];
    const searchNext = next ? SEARCH_AFTER_OPEN.exec(next) : null;
    if (OPEN_GOOGLE.test(c) && searchNext) {
      const q = exactQuery(searchNext[1]);
      if (!q) return null;
      steps.push({ ...pick(searchStep(q)), label: `search Google for "${q}"` });
      i++;
      continue;
    }
    const search = googleSearchClause(c);
    if (search) {
      steps.push({ ...pick(search), label: `search Google for "${String(search.args.query)}"` });
      continue;
    }
    const rule = planRules(c, { linked: false });
    // Round 11: a document by name is an exact step too ("open YouTube and then open the file X": two companion steps, in his order, each
    // checked on its own), so a compound with a file is never handed whole to the screen loop.
    if (rule?.lane !== "executor" || (rule.executor !== "open-url" && rule.executor !== "app.open" && rule.executor !== "file.open")) return null;
    // "Open Chrome and go to example.com" means the page IN that browser: a separate default-browser open would not be it, so a browser
    // named alongside other steps is not an exact plan (the screen loop on his PC takes it, as before).
    if (rule.executor === "app.open" && clauses.length > 1 && /^(?:chrome|edge|firefox|google chrome|microsoft edge|browser)$/i.test(String(rule.args.name ?? ""))) return null;
    steps.push({ ...pick(rule), label: rule.executor === "app.open" || rule.executor === "file.open" ? `open ${rule.target ?? rule.args.name}` : `open ${rule.target ?? safeHost(String(rule.args.url))}` });
  }
  return steps.length ? steps : null;
}
/** The most linked steps one request plans (the companion's typed-plan limit). */
export const MAX_LINKED_STEPS = 6;
const pick = (r: Extract<RulePlan, { lane: "executor" }>) => ({ executor: r.executor, args: r.args });

/** The deterministic plan for his words, or null (Jev and the rest of the entry decide). Pure. */
export function planRules(utterance: string, opts: { linked?: boolean } = {}): RulePlan | null {
  const t = utterance.trim();
  const questions = businessQuestionsIn(t);
  if (questions?.kind === "questions") return { lane: "delegate", to: "crm", op: "crm.questions", why: "bounded read-only business questions, in the requested order, through the existing CRM and Leads services" };
  if (questions?.kind === "unsupported") return { lane: "unsupported", op: "crm.questions", why: "not every clause is a supported read-only business question", said: "I can combine up to four supported read-only business questions. This request includes something else, so I haven't run any of it. Ask those parts separately." };
  if (rememberToReminder(t)) return { lane: "delegate", to: "reminder", op: "reminder.set", why: "\"remember to …\" is a reminder: the reminder skill sets a real one" };
  if (leadActionIn(t)) return { lane: "delegate", to: "leads", op: "leads.action", why: "a CRM action on a named lead: the leads service, read back after the write" };
  if (crmIntentIn(t)) return { lane: "delegate", to: "crm", op: "crm.operation", why: "a CRM request: the CRM's own typed operations, with the verified person and the open record, never a guess" };
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
  // A Google search, said whole ("search Google for X") or as "open Google and search for X": one exact step, the query exactly as said.
  if (opts.linked !== false) {
    const linked = linkedSteps(t);
    if (linked?.length === 1 && linked[0].args.query !== undefined) return { lane: "executor", executor: "open-url", args: linked[0].args, op: "web.search", target: "google.com", why: "a Google search for exactly these words, opened as its results page" };
  }
  const np = notepadParts(t);
  if (np) {
    const extra = np.extra ?? strayStep(t, OWN_NOTEPAD, 2);
    if (extra) return stray("notepad.type", "type that line into a new Notepad document", extra);
    return { lane: "executor", executor: "notepad.type", args: { text: np.line }, op: "notepad.type", target: "notepad", why: "a line typed into a NEW Notepad document, read back, never saved" };
  }
  const title = blankDeckTitle(t);
  if (title !== null) {
    const extra = blankDeckExtra(t) ?? strayStep(t, OWN_DECK, 2);
    if (extra) return stray("deck.blank", "start a new PowerPoint with that title slide", extra);
    return { lane: "executor", executor: "deck.blank", args: { title }, op: "deck.blank", target: "powerpoint", why: "a new, never-saved PowerPoint with a title slide, read back from PowerPoint" };
  }
  // A new tab is the plain Windows launch of Chrome with a blank page (a new tab in the window already open): no DevTools, no agent-browser.
  if (blankTabIn(t)) return { lane: "executor", executor: "app.open", args: { name: "chrome", newTab: true }, op: "browser.newtab", target: "chrome", why: "a new Chrome tab through the plain Windows launch, confirmed by a Chrome window in front" };
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
  // (A polite lead, "can you open Chrome?", is the same order.)
  const plain = t.replace(/^(?:(?:hey\s+)?jarvis[,\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i, "").replace(/[\s?]+$/, "");
  const app = /^(?:please\s+)?(?:open|launch|start|fire up|bring up|pull up|run)\b/i.test(plain) && !/\b(?:and|then)\b/i.test(plain) ? appNameIn(plain) : null;
  // "Bring up Chrome": the app in front is the outcome, so its window already open and now in front counts (the executor checks it is).
  const bringUp = /^(?:bring|pull)\s+up\b/i.test(plain);
  if (app) return { lane: "executor", executor: "app.open", args: { name: app, ...(bringUp ? { bringUp: true } : {}) }, op: "app.open", target: app, why: bringUp ? `bring ${app} to the front and confirm it is in front` : `open ${app} and confirm its window appeared` };
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
  const site = /^(?:please\s+)?(?:open|go to|visit|pull up)\b/i.test(t) ? builtinRegistry().resolve(t).find((d) => d.kind === "website" && (d.label !== "YouTube" || (!YOUTUBE_WORK.test(t) && !extraClause(t)))) : undefined;
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
    return { lane: "executor", executor: "open-url", args: { url: `https://${domain[1].toLowerCase() === "youtube.com" ? "www.youtube.com" : domain[1].toLowerCase()}${domain[2] ?? "/"}` }, op: "open-url", target: domain[1].toLowerCase(), why: `the public site ${domain[1].toLowerCase()}` };
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
