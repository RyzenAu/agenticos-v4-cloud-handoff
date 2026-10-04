// Wording a preview must never carry: nothing in a preview is sent, so no page may promise a call, a reply, a reminder, a confirmation or a
// hand-over to a person. The scan runs over the template source in the tests, over every built page of every export when a preview is generated,
// and over every built page and script of every vertical in the Quality Lab.
//
// Negation counts only when it sits shortly before the phrase in the same clause: "No licensed agent will respond ..." is not a promise, but
// "No obligation, we will call you back." is (the comma ends the clause), and "The sale price was not disclosed." does not switch the scan off for
// anything else in the same text.
const ACTS = "(?:call|contact|confirm|send|reply|respond|follow up|get back|reach out|arrange|be in touch|answer|acknowledge|email|text|ring|tell|say|suggest|let you know|advise|walk through|put|show|explain|find|match|organise|book)";
export const PROMISE_PHRASES: RegExp[] = [
  new RegExp(String.raw`\b(?:we|i)(?:'ll| will) ${ACTS}\b`),
  new RegExp(String.raw`\bour (?:team|agents?|office|staff|property managers?|reception|solicitors?|lawyers?|dentists?) (?:will|shall) ${ACTS}\b`),
  new RegExp(String.raw`\b(?:he|she|they|someone|somebody|an? (?:agent|person|member)|(?:the|licensed|listing|sales) (?:agent|agency|office|practice|firm|team|manager|property manager)|reception|your \w+(?: \w+)?) (?:will|shall) ${ACTS}\b`),
  /\b(?:callum|hana|imogen|theo|priya) (?:or \w+ )?will\b/,
  /will be in touch/, /call to arrange/, /call(?:s|ed)? you back/, /get back to you/, /hear from us/, /pass(?:ed)? this conversation/, /put you in touch/, /put you with/,
  /leave (?:my|your) details/, /send a reminder/, /within (?:one|1) business day/, /reply to every enquiry/, /will answer directly/,
  /sent to the agent/, /send to agent/, /request received/, /request logged/, /appraisal requested/, /enquiry sent/, /you(?:'re| are) registered/,
  /hand you to/, /we(?:'ll| will) hand/, /arrange a time/, /we can (?:arrange|organise|book)/,
];

const NEGATION = /^(?:no|not|never|nobody|nothing|none|without|cannot)$|n't$/;
/** How many words before a phrase a negation still applies to. */
const NEGATION_REACH = 5;

const flat = (text: string) => text.replace(/[‘’]/g, "'").replace(/&#x27;|&rsquo;|&#39;|\\u0027/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").toLowerCase();

/** True when a negation word sits within a few words before `index`, with no comma, full stop or other clause break between. */
function negatedBefore(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const breaks = [".", ",", ";", "!", "?", ":", "\n", " — "].map((b) => before.lastIndexOf(b));
  const clause = before.slice(Math.max(...breaks) + 1);
  const words = clause.split(/\s+/).filter(Boolean).slice(-NEGATION_REACH);
  return words.some((w) => NEGATION.test(w.replace(/^[^a-z']+|[^a-z']+$/g, "")));
}

/** The promising phrases found in `text` (apostrophes and case normalised), with a little context. */
export function promisesIn(text: string): string[] {
  const t = flat(text);
  const found: string[] = [];
  for (const re of PROMISE_PHRASES) {
    for (const m of t.matchAll(new RegExp(re.source, "g"))) {
      if (negatedBefore(t, m.index!)) continue;
      found.push(t.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 30));
      break;
    }
  }
  return found;
}

/** Every string a script carries as a literal ('...', "..." or `...`), so a promise inside client code is read as text and not lost in the syntax around it. */
export function scriptStrings(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\u0027|\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, " ");
    if (s.length >= 12) out.push(s);
  }
  return out;
}

/** Every string value in a parsed JSON value. */
export function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) jsonStrings(v, out);
  return out;
}

export type TextPiece = { kind: "page" | "data" | "script"; text: string };

/** The pieces of a built page that a visitor can read or that the page's code can show: its text, each string value of the preview data block, and each
 *  string literal of its scripts. Each piece is scanned on its own, so one sentence cannot hide another. */
export function textPieces(html: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  const data = /<script id="mu-preview-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (data) {
    try { for (const s of jsonStrings(JSON.parse(data))) pieces.push({ kind: "data", text: s }); } catch { pieces.push({ kind: "data", text: data }); }
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/id="mu-preview-data"/.test(m[1])) continue;
    for (const s of scriptStrings(m[2])) pieces.push({ kind: "script", text: s });
  }
  pieces.push({ kind: "page", text: html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ") });
  return pieces;
}
