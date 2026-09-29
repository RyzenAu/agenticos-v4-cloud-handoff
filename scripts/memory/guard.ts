/**
 * Intentional curated capture only. The vault stores short facts someone chose to keep —
 * never raw chats, call transcripts, audio, bank records or email bodies.
 *
 * Secrets (owner decision, 28 Sep 2026, REVIEW-STAGE-D B2): ONLY credentials and financial secrets
 * are refused, everywhere (remember, save to the vault, corrections, and vault notes before sync):
 * passwords and login pairs (whatever the value looks like), API keys and tokens, BSB plus account
 * numbers, card numbers, TFNs, and bank codes / one-time codes. Matching runs on a normalised copy
 * (number words to digits, separators between digits removed) so "062-000", "4111.1111.1111.1111",
 * "one two three…" and a password with no digits are caught. Ordinary personal and business data
 * (phone numbers, emails, addresses, names, dates, health, pay) is NOT screened: it is fine to store
 * and sync. A refused secret is not stored anywhere, not even locally.
 * Every refusal names the category, never echoes the content back.
 */

export const MAX_FACT_CHARS = 800;
/** A fact longer than this is refused without being scanned (the 800-character limit is checked after the scan, so a secret still names its category). */
export const MAX_FACT_SCAN_CHARS = 20_000;
export const MAX_FACT_LINES = 8;
export const MAX_TITLE_CHARS = 90;

export type GuardResult =
  | { ok: true }
  | { ok: false; code: "empty" | "too-large" | "prohibited-content"; category?: Category; message: string };

type Category = "raw-chat" | "call-transcript" | "audio" | "bank-record" | "secret" | "government-id" | "one-time-code" | "email-body" | "too-long";

const MESSAGES: Record<Category, string> = {
  "too-long": "That is too long to check for passwords, keys and card details, so it isn't stored. Save the one fact worth keeping, in a sentence.",
  "raw-chat": "That looks like a raw chat log. Save the one fact worth keeping, in a sentence.",
  "call-transcript": "That looks like a call transcript. Transcripts are never stored; save the outcome as a short fact.",
  audio: "Audio can't be stored in the vault. Save what was decided, in words.",
  "bank-record": "That looks like bank account or card details, or a statement. Those are never stored.",
  secret: "That looks like a password, key or token. Secrets are never stored in memory.",
  "government-id": "That looks like a tax file number. TFNs are never stored.",
  "one-time-code": "That looks like a bank or one-time code. Those are never stored.",
  "email-body": "That looks like an email body. Save the fact from it instead, and link the thread by reference.",
};

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const CHAT_LABEL = /^(user|assistant|human|ai|me|you|jarvis|claude|gpt|bot|usman|mehroz|q|a)\s*[:>]/i;
const CALL_LABEL = /^(caller|agent|receptionist|customer|patient|speaker\s*\d+|operator|rep)\s*[:>]/i;
const TIMESTAMP_LINE = /^\[?\(?\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?\]?\)?\s*[-–:]?\s*\S/i;
const WHATSAPP_LINE = /^\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/;
const EMAIL_HEADER = /^(from|to|cc|bcc|subject|sent|date|reply-to)\s*:/i;
const SIGN_OFF = /^(regards|kind regards|best regards|warm regards|many thanks|thanks|cheers|sincerely|best|yours (truly|sincerely|faithfully)),?$/i;
const GREETING = /^(dear|hi|hello|hey|good (morning|afternoon|evening))\b[^.!?]{0,40},$/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{16,}/,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bsk-or-[A-Za-z0-9_-]{12,}/,
];

const NUMBER_WORDS: Record<string, string> = { zero: "0", oh: "0", nought: "0", nil: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

/** Cyrillic and Greek letters that look like Latin ones ("раssword" with a Cyrillic а). Folded before matching. */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I",
  "ο": "o", "α": "a", "ν": "v", "ρ": "p", "Ο": "O", "Α": "A", "Ε": "E", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ρ": "P", "Τ": "T", "Χ": "X", "Υ": "Y", "Ζ": "Z", "Β": "B", "Η": "H",
};
const CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/** The value 0-9 of a non-ASCII decimal digit (Arabic-Indic, Devanagari, mathematical…): its offset in its run of ten. Remembered per code point. */
const DIGIT_VALUE = new Map<number, string>();
function digitOf(ch: string): string {
  const cp = ch.codePointAt(0)!;
  let v = DIGIT_VALUE.get(cp);
  if (v === undefined) {
    let start = cp;
    for (let n = 0; n < 60 && /\p{Nd}/u.test(String.fromCodePoint(start - 1)); n++) start--;
    v = String((cp - start) % 10);
    DIGIT_VALUE.set(cp, v);
  }
  return v;
}

const NON_ASCII = /[^\x00-\x7f]/;
/** Literal HTML character references: "&#49;", "&#x31;", and the double-encoded "&amp;#x31;". */
const ENTITY = /&(?:amp;)*#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi;
function decodeEntities(text: string): string {
  let t = text;
  // Up to three rounds ("&#38;#49;" decodes to "&#49;", which is one more round): the fold stays idempotent.
  for (let round = 0; round < 3 && t.includes("&"); round++) {
    const next = t.replace(ENTITY, (m, hex?: string, dec?: string) => {
      const cp = hex ? parseInt(hex, 16) : parseInt(dec as string, 10);
      return cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    });
    if (next === t) break;
    t = next;
  }
  return t;
}
/** Invisible characters: format characters, everything Unicode marks default-ignorable (VS1-16, U+034F, the Hangul fillers U+115F/1160/3164/FFA0, the Mongolian selectors…), and the braille blank U+2800. */
const IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu;
/** Combining marks stuck to a digit ("4́111"), and the keycap mark of "1️⃣". */
const DIGIT_MARKS = /(\p{Nd})\p{M}+/gu;
/** Accents and other combining marks, for the copies the credential and number rules read ("Passwórd" becomes "Password"). */
const stripMarks = (s: string) => (NON_ASCII.test(s) ? s.normalize("NFD").replace(/\p{M}/gu, "") : s);

let foldKey: string | null = null;
let foldOut = "";
function foldOnce(text: string): string {
  const t = decodeEntities(text);
  // Pure ASCII: nothing else to fold.
  if (!NON_ASCII.test(t)) return t;
  return t
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .replace(DIGIT_MARKS, "$1")
    .replace(/(?![0-9])\p{Nd}/gu, digitOf)
    .replace(CONFUSABLE, (c) => CONFUSABLES[c]);
}

/**
 * The text every secret rule reads (J3 review F1, J5 review F3): literal HTML character references decoded ("&#49;",
 * "&amp;#x31;"), NFKC (full-width letters and digits become plain ones), every invisible character removed (zero-width
 * space and joiners, U+2060, the byte-order mark, the soft hyphen, bidi marks, variation selectors, U+034F, the Hangul
 * fillers, the braille blank), combining marks stuck to digits removed, other scripts' digits turned into 0-9, and
 * look-alike Cyrillic and Greek letters turned into Latin. Linear in the length of the text, idempotent, and the last
 * text folded (or produced by a fold) is remembered, so the several rules that each fold their input share one pass.
 */
export function foldForMatching(text: string): string {
  if (text === foldKey || text === foldOut) return foldOut;
  const out = foldOnce(text);
  if (text.length <= 300_000) {
    foldKey = text;
    foldOut = out;
  }
  return out;
}

const NUMBER_WORD_ALT = Object.keys(NUMBER_WORDS).join("|");
const DOUBLE_WORDS = new RegExp(`\\b(double|triple)\\s+(${NUMBER_WORD_ALT}|\\d)\\b`, "g");
const SINGLE_WORDS = new RegExp(`\\b(${NUMBER_WORD_ALT})\\b`, "g");
/** One to six groups of two or more digit-like characters (digits, l, o), not touching a letter: bounded, so linear. */
const LOOKALIKE_RUN = /(?<![a-z])[0-9lo]{2,}(?:[\s.\-\/_,]+[0-9lo]{2,}){0,5}(?![a-z])/g;

/**
 * The copy the secret rules match against: lower case, number words as digits ("double four" → 44),
 * and every separator between two digits removed ("062-000", "4111.1111", "0412 345 678", "(02) 98").
 */
export function normaliseForSecrets(text: string): string {
  let t = stripMarks(foldForMatching(text)).toLowerCase().replace(/[\u2010-\u2015\u2212]/g, "-");
  t = t.replace(DOUBLE_WORDS, (_, k: string, d: string) => (NUMBER_WORDS[d] ?? d).repeat(k === "double" ? 2 : 3));
  t = t.replace(SINGLE_WORDS, (w: string) => NUMBER_WORDS[w]);
  // Letters standing in for digits inside a run of digit groups ("4l11 1l11", "5500 OOOO OOOO 0004"): l is 1 and o is 0,
  // only where every group is made of digits, l and o and at least one real digit is present.
  t = t.replace(LOOKALIKE_RUN, (m) => (/\d/.test(m) ? m.replace(/l/g, "1").replace(/o/g, "0") : m));
  // Separators between digits, "x"/"×" included ("4111x1111x1111x1111").
  for (let i = 0; i < 3; i++) t = t.replace(/(\d)(?:[\s.\-\/_,()×\u00b7\u2022\u2219\u22c5\u30fb\u2027]|x(?=\d))+(?=\d)/g, "$1");
  return t;
}

/**
 * The text the credential rules read (REVIEW-STAGE-D R2-2): NFKC (full-width letters and digits become
 * plain ones), zero-width characters removed, and a word spelled out letter by letter
 * ("s u n f l o w e r", "p-a-s-s-w-o-r-d") joined back up. Case is kept (mixed case is a value shape).
 */
export function normaliseForCredentials(text: string): string {
  let t = stripMarks(foldForMatching(text));
  // Four or more single letters/digits separated by spaces, dots or dashes: one spelled-out token.
  t = t.replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][ .\-_]){3,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (m) => m.replace(/[ .\-_]/g, ""));
  return t;
}

/** Words that introduce a credential's value: "is", "is now", "changed to", "set … to", "stored as", ":". */
const INTRODUCER = new Set(["is", "was", "are", "were", "now", "to", "as", "=", ":", "-", "—", "–", "->", "=>", "is:", "was:", "now:", "to:", "as:", "be"]);
/** Words that can sit between the label, the introducer and the value ("is the same as the old one: X"). */
const FILLER = new Set([
  "has", "had", "been", "currently", "still", "just", "changed", "change", "updated", "update", "set", "stored", "saved", "kept",
  "the", "same", "old", "new", "one", "a", "an", "our", "my", "your", "his", "her", "their", "this", "that", "it's", "its", "it",
  "i", "we", "you", "they", "and", "then", "also", "again", "here", "for", "of", "on", "at", "“", "\"", "'", "–", "—",
]);
/**
 * Words that make the sentence ABOUT a credential rather than giving one ("the password is required",
 * "the login is broken"). They clear it only when no value-shaped token (digit, symbol, mixed case)
 * follows them, so "the password is required: Xk9#…" is still caught.
 */
const NOT_A_VALUE = new Set([
  "required", "needed", "reset", "expired", "shared", "managed", "missing", "wrong", "correct", "strong", "weak", "long", "short",
  "unknown", "written", "sent", "broken", "working", "down", "fixed", "slow", "failing", "locked", "disabled", "enabled", "done",
  "ok", "okay", "fine", "via", "through", "handled", "separate", "different", "in", "with", "by", "not", "being", "going",
  "protected", "expiring", "rotated", "secure", "safe", "private", "hidden", "encrypted", "sso", "optional", "blank", "empty",
  "changing", "due", "valid", "invalid", "incorrect", "case-sensitive", "sensitive", "complex", "simple",
]);
const LOCATION = new Set(["on", "in", "at", "under", "behind", "inside", "near", "beside", "within", "taped", "printed"]);
/** Nouns right after a label that make it a compound, not a value ("password manager", "pin the message"). */
const COMPOUND = /^(policy|policies|manager|managers|reset|resets|rules|field|prompt|box|page|screen|strength|hint|generator|portal|expiry|change|changes|budget|budgets|count|counts|limit|limits|usage|cost|costs|price|window|length|requirements?|the (message|note|post|chat|thread|file|tab))\b/i;
const valueShaped = (t: string) => /\d/.test(t) || /[^\p{L}\p{N}'’.,;:!?()"“”-]/u.test(t) || (/\p{Ll}/u.test(t) && /\p{Lu}/u.test(t.slice(1)));

/**
 * Strong labels: whatever follows an introducer is a credential ("the Xero password is now
 * sunflowerfield", "wifi pw sunflower"). Weak labels ("key", "secret", "token", "code", "pin"): only a
 * value-shaped token, or a long one ending the clause ("the key is sunflowerfield"), so "the secret is
 * consistency: call back fast" and "the key dates are Monday" stay.
 */
const STRONG = /(?<![\w/])(p[a@4][s$5]{1,2} ?w(?:[o0]r|r[o0])ds?|passwd|pwd|pw|pass ?phrase|pass ?code|credentials?|(?:wi-?fi|network|router|wpa2?|ssid|api|access|secret|private|license|licence|product|recovery|encryption)[ _-]?(?:keys?|codes?|phrase|tokens?)|(?:access|auth(?:entication)?|bearer|refresh|personal access)[ _-]?tokens?|seed phrase)(?![\w/-])/gi;
const WEAK = /(?<![\w/])(keys?|secrets?|tokens?|codes?|pin)(?![\w/-])/gi;
/** Labels a value may follow directly, with no introducer ("wifi pw sunflower"). */
const DIRECT = /^(pw|pwd|passwd|pass ?code|pass ?phrase)$/i;
const NOT_SECRET_CODE = /\b(discount|promo|promotion|coupon|voucher|referral|post|postal|zip|area|country|dress|source|error|status|colou?r|qr|bar|tracking|booking|confirmation|reference|invite)\s*$/i;

/** Anything that can introduce a value: an introducer word, a colon, an equals sign or a dash. Without one, only the very first token can be a value. */
const INTRO_HINT = /[:=\-—–]|\b(?:is|was|are|were|now|to|as|be)\b/i;

function valueAfter(label: string, rest: string, weak: boolean): boolean {
  const head = rest.slice(0, 160);
  const strip = (t: string) => t.replace(/^["'“(]+|["'”),;]+$/g, "");
  let tokens: string[];
  const limit = 14;
  if (!INTRO_HINT.test(head)) {
    // Nothing after the label can introduce a value, so only its first token can be one: the same answer, far cheaper on a text that repeats the label.
    const first = /^[ \t]*(\S+)/.exec(head);
    tokens = first ? [strip(first[1].replace(/[.!?]+$/, ""))].filter(Boolean) : [];
  } else {
    const clause = head.split(/(?<=[^\s.])[.!?](?=\s|$)|\n/)[0];
    tokens = clause.split(/\s+/).map(strip).filter(Boolean);
  }
  let introduced = false;
  let sawState = false;
  // After a state word ("required", "in", "on the fridge") a value counts only after an explicit ":" or
  // "=" ("the password is required: Xk9#…"); "required to be 12 characters" is a rule, not a value.
  let stateColon = false;
  for (let i = 0; i < tokens.length && i < limit; i++) {
    const raw = tokens[i];
    const t = raw.toLowerCase();
    const bare = t.replace(/[:=]$/, "");
    if (sawState && (/[:=]$/.test(raw) || t === ":" || t === "=")) stateColon = true;
    if (INTRODUCER.has(t) || /[:=]$/.test(raw)) {
      introduced = true;
      if (INTRODUCER.has(t) || FILLER.has(bare) || INTRODUCER.has(bare) || !bare) continue;
      // "password: X" → the colon was on the label side; "one: X" → filler. Anything else: this token IS the value.
    }
    // Where it is, not what it is: "the password is on the fridge", "the code is on the invite".
    if (introduced && LOCATION.has(bare)) {
      sawState = true;
      continue;
    }
    if (FILLER.has(bare) || !bare) continue;
    if (NOT_A_VALUE.has(bare)) {
      sawState = true;
      if (/[:=]$/.test(raw)) stateColon = true; // "required: Xk9#…"
      continue;
    }
    if (sawState) {
      if (stateColon && valueShaped(raw)) return true;
      continue;
    }
    if (!introduced) {
      // Direct values: "wifi pw sunflower"; a value-shaped token right after any label; else a qualifier ("for the Xero account").
      if (i === 0 && (DIRECT.test(label) || valueShaped(raw))) return !weak || valueShaped(raw);
      continue;
    }
    if (bare.length < 3) continue;
    if (!weak) return true;
    if (valueShaped(raw)) return true;
    return i === tokens.length - 1 && bare.length >= 10;
  }
  return false;
}

const WORD_TOKEN = /^[\w-]{1,60}$/;
const DOMAIN_TOKEN = /^[\w-]{1,60}[.,;!?]*$/;

/**
 * Speech-to-text spellings back to symbols: "admin slash X" and "admin forward slash X" → "admin / X", "login admin
 * colon X" → "login admin : X", "usman at example dot com" → "usman@example.com". One pass over the words, no
 * backtracking (J3 review F2: the old `(\S+)\s+at\s+…` regex was quadratic on one long unbroken token).
 */
function spokenForm(text: string): string {
  const parts = text.split(/(\s+)/);
  const w: string[] = [];
  const s: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    w.push(parts[i]);
    s.push(parts[i + 1] ?? "");
  }
  const out: Array<[string, string]> = [];
  for (let i = 0; i < w.length; i++) {
    const lw = w[i].length <= 12 ? w[i].toLowerCase() : "";
    if (lw === "slash" || lw === "backslash") {
      const prev = out[out.length - 1];
      if (prev && /^(?:forward|back)$/i.test(prev[0])) out.pop();
      out.push(["/", s[i]]);
      continue;
    }
    if (lw === "colon") {
      out.push([":", s[i]]);
      continue;
    }
    const prev = out[out.length - 1];
    if (lw === "at" && prev && prev[0].length <= 80 && (w[i + 2] ?? "").toLowerCase() === "dot" && WORD_TOKEN.test(w[i + 1] ?? "") && DOMAIN_TOKEN.test(w[i + 3] ?? "")) {
      out.pop();
      let addr = `${prev[0]}@${w[i + 1]}.${w[i + 3]}`;
      let j = i + 3;
      while ((w[j + 1] ?? "").toLowerCase() === "dot" && DOMAIN_TOKEN.test(w[j + 2] ?? "")) {
        addr += `.${w[j + 2]}`;
        j += 2;
      }
      out.push([addr, s[j]]);
      i = j;
      continue;
    }
    out.push([w[i], s[i]]);
  }
  return out.map(([word, sep]) => word + sep).join("");
}

const CUE = /\b(?:(log-?in|log in|logon|sign[- ]?in|creds?|credentials?)|(user ?name|usr|user|account|e-?mail|router|modem|portal|details|wi-?fi|network))\b/giu;
const IDENT = String.raw`([^\s,;:/=]{1,60})`;
const JOIN = String.raw`(\s*[/,;:—–]\s*|\s+-\s+|\s+(?:and|with|plus|then)\s+|\s+)(?:(?:it|that)(?:['’]s|\s+is)\s+)?`;
const SECRET = String.raw`((?:(?:the|my)\s+)?(?:password|passwd|pass|pwd|pw)\b\s*(?:is|:|=)?\s*)?([^\s,;]{3,60})`;
/** After the cue: skip up to 40 characters, an "is" (or a colon), then identity, joiner, secret ("router login is admin / X"). */
const AFTER_INTRO = new RegExp(String.raw`^[^.\n]{0,40}?(?:\b(?:is|are|was|now|as)\b|[:=])\s*(?:the\s+|my\s+)?${IDENT}${JOIN}${SECRET}`, "iu");
/** After the cue, straight to the identity ("creds admin / X", "cred: jane/X", "log in as jane, X", "login admin : X"). */
const AFTER_DIRECT = new RegExp(String.raw`^\s*(?:(?:as|is|for)\s+)?[:=]?\s*(?:the\s+|my\s+)?${IDENT}${JOIN}${SECRET}`, "iu");
/** The cue comes after the pair: "admin / Sunflower99 for the router". */
const PAIR_THEN_CUE = /(?<![\w@./-])([a-z][a-z0-9._-]{1,30}|[^\s@]{1,30}@\S{1,40})\s*\/\s*([^\s,;/]{8,60})\s+(?:for|on|to)\s+(?:the\s+|my\s+)?(?:[\w-]+\s+){0,2}?(?:router|login|account|portal|modem|wifi|wi-fi|server|admin)\b/iu;
const NOT_IDENT = /^(?:the|a|an|with|and|not|no|none|n\/a|is|are|was|it|this|that|my|our|your|broken|required|missing|unknown)$/i;

/** A value shaped like a password: 8+ characters, letters, and a digit (or a symbol with mixed case). */
function strongSecret(token: string, allowHyphenWords: boolean): boolean {
  const t = token.replace(/^["'“(]+|["'”),;.!?]+$/g, "");
  if (t.length < 8 || /[@/\\]|:\/\//.test(t) || !/\p{L}/u.test(t)) return false;
  const digit = /\d/.test(t);
  const mixed = /\p{Ll}/u.test(t) && /\p{Lu}/u.test(t);
  const symbol = /[^\p{L}\p{N}]/u.test(t);
  // "Nexus-v2-Release" is a name made of words, not a password (unless a login cue says it is one).
  if (!allowHyphenWords && /^(?:\p{L}+|v\d+|\d+)(?:-(?:\p{L}+|v\d+|\d+))+$/u.test(t)) return false;
  return digit || (symbol && mixed);
}
/** A date, a year or a campaign code ("12-Oct-2026", "Q4-Launch2026", "MU-Ventures-2026") is not a password. */
const campaignLike = (t: string) => /(?:19|20)\d\d/.test(t) || /^q[1-4][-_]/i.test(t) || /\d{1,2}[-/.](?:[a-z]{3,9}|\d{1,2})[-/.]\d{2,4}/i.test(t);
/** A whole token that is a date ("12-Oct-2026", "2026-10-12", "12/10/2026"): never a password, after any cue. */
const dateToken = (t: string) => /^\d{1,4}[-/.](?:[a-z]{3,9}|\d{1,2})[-/.]\d{2,4}$/i.test(t);
/** A quarter-prefixed code, a date, or a hyphenated name carrying a year ("Q4-Launch2026", "MU-Ventures-2026"): structure a password rarely has. */
const campaignStructure = (t: string) => dateToken(t) || /^q[1-4][-_]/i.test(t) || (t.includes("-") && /(?:19|20)\d\d/.test(t));
/** Business identifiers that are shaped like a password ("Invoice10042", "Sprint14Plan", "Ticket88231"): a noun and a number. */
const BUSINESS_ID = /^(?:invoice|inv|proposal|quote|ticket|sprint|version|firmware|order|ref|reference|job|case|project|release|build|batch|task|issue|report|po|booking|receipt)[-_]?\d{2,}[A-Za-z]*$/i;
/** Cue words whose secret is a device or portal login, not a business note ("router: admin / Summer2026"). */
const DEVICE_CUE = /^(?:router|modem|portal|details|wi-?fi|network)$/i;
/**
 * Is this secret-shaped token really a date, a code name or a business identifier (J5, review R2 section 3)? The year
 * exemption is only for WEAK cues ("the account is X with 2026-renewals"): after login, sign in, cred(s), a router or
 * portal, or a "/" or ":" pair, only a whole date counts (or a quarter code or a hyphenated name with a year, on a weak
 * cue). A password that merely contains a year ("Summer2026", "Coventry2019") is refused after any of those.
 */
function notAPassword(secret: string, strong: boolean, device: boolean, pairSeparator: boolean, moreWordsFollow: boolean): boolean {
  if (dateToken(secret)) return true;
  if (strong) return false;
  if (!pairSeparator && BUSINESS_ID.test(secret)) return true;
  if (campaignStructure(secret)) return true;
  // A year inside a plain word ("Sunflower2026 attached", "DentalDemo2026 preview") is a name only when more words follow it; at the end of the clause it is a password.
  return !device && !pairSeparator && moreWordsFollow && campaignLike(secret);
}
/** An identity that reads like a login name: an email, or one lowercase word ("admin", "jane", "usman"). */
const loginLike = (id: string) => id.includes("@") || /^[a-z][a-z0-9._-]{1,30}$/.test(id);

/**
 * A spoken or written credential PAIR (J3 review F3 and F4). A credential cue (login, log in, sign in, cred(s), or
 * a weaker one such as user, account, email, router, details), an identity, a joiner ("/", "slash", ":", a comma,
 * "and", "with", or just the next line) and a password-shaped secret that is not a date or a campaign code.
 * Strong cues (login, sign in, cred) accept any identity; weak cues need an identity that reads like a login name
 * ("the account is Mehroz with 12-Oct-2026 renewal date" and "user is Mehroz and Q4-Launch2026 campaign" are not
 * credentials). Every regex here is bounded, and each cue reads at most 160 characters after it.
 */
function credentialPair(text: string): boolean {
  for (const m of text.matchAll(CUE)) {
    const strong = !!m[1];
    const device = !strong && DEVICE_CUE.test(m[2] ?? "");
    const start = (m.index ?? 0) + m[0].length;
    const after = text.slice(start, start + 160).split(/\.\s/)[0];
    for (const re of [AFTER_INTRO, AFTER_DIRECT]) {
      const p = re.exec(after);
      if (!p) continue;
      const ident = p[1].replace(/[.!?]+$/, "");
      const joiner = p[2];
      const viaLabel = !!p[3];
      const secret = p[4].replace(/[.!?]+$/, "");
      if (NOT_IDENT.test(ident)) continue;
      const punctuated = /[/,;:]/.test(joiner) || /\S/.test(joiner.replace(/\s+/g, ""));
      const identOk = strong || loginLike(ident);
      if (viaLabel) {
        // "… and the pass is bluesky": a password-labelled value needs no shape, only to be a value.
        if (identOk && !FILLER.has(secret.toLowerCase()) && !NOT_A_VALUE.has(secret.toLowerCase())) return true;
        continue;
      }
      if (!strongSecret(secret, strong) || notAPassword(secret, strong, device, /[/:]/.test(joiner), /^\s+[\p{L}\p{N}]/u.test(after.slice(p[0].length)))) continue;
      if (strong || (identOk && (punctuated || ident.includes("@")))) return true;
    }
  }
  const t = PAIR_THEN_CUE.exec(text);
  return !!t && strongSecret(t[2], false) && !dateToken(t[2]);
}

/** A credential stated as a value, however it is phrased. */
function credential(text: string, norm: string): boolean {
  const cred = normaliseForCredentials(text);
  for (const [re, weak] of [
    [STRONG, false],
    [WEAK, true],
  ] as const) {
    re.lastIndex = 0;
    for (const m of cred.matchAll(re)) {
      const rest = cred.slice(m.index! + m[0].length, m.index! + m[0].length + 240);
      if (COMPOUND.test(rest.trimStart())) continue;
      if (weak && /codes?/i.test(m[0]) && NOT_SECRET_CODE.test(cred.slice(0, m.index!))) continue;
      if (valueAfter(m[0], rest, weak)) return true;
    }
  }
  const lower = cred.toLowerCase();
  // "Use X as the Xero password": the value comes first.
  for (const m of cred.matchAll(/\b(?:use|using|uses|used)\s+(\S{3,})\s+as\s+(?:the\s+|our\s+|my\s+|a\s+|its\s+|new\s+)*(?:[\w-]+\s+){0,3}?(p[a@4][s$5]{1,2} ?w(?:[o0]r|r[o0])ds?|pw|pwd|pass ?(?:phrase|code)|pin|wi-?fi key|key|login)\b/gi)) {
    const v = m[1].toLowerCase();
    if (!FILLER.has(v) && !NOT_A_VALUE.has(v) && !["it", "that", "this", "same"].includes(v)) return true;
  }
  // "Xero: jane.admin / Winter-Is-Coming", "Wifi: KestrelGuest / sunflowerfield": a username-shaped
  // name, a slash, then a value.
  for (const m of cred.matchAll(/(?:^|[\s(])[\p{L}][\p{L}\p{N} .&'-]{0,30}:\s*(\S+)\s*\/\s*(\S{3,})/gu)) {
    const user = m[1];
    const userShaped = /\p{L}/u.test(user) && (/[.@_]/.test(user) || /\p{Lu}/u.test(user.slice(1)) || /\p{L}\d|\d\p{L}/u.test(user));
    const time = /^\d{1,2}([:.]\d{2})?\s*(am|pm)?$/i;
    if (userShaped && !time.test(m[2])) return true;
  }
  // "netflix — usman@example.com / Sunflower99" (an em or en dash as the joiner): the name, a slash, then a password-shaped value.
  for (const m of cred.matchAll(/[—–]\s*(\S{1,60})\s*\/\s*(\S{3,60})/gu)) {
    const user = m[1];
    if (strongSecret(m[2], true) && (user.includes("@") || loginLike(user) || /\p{Lu}/u.test(user.slice(1)) || /\p{L}\d|\d\p{L}/u.test(user))) return true;
  }
  // "pin 4821", "passcode 0000": a pin-like label followed by digits.
  if (/\b(pin|passcode|pass code|door code|alarm code|gate code|lock code)\s*(?:number|no\.?|#)?\s*(?:is|was|:|=|-)?\s*\d{3,}/.test(norm)) return true;
  // Login pairs: "login admin / Winter-Is-Coming", "user jane pass bluesky", "username: jane password: hunter".
  if (/\b(login|username|user name|user|email|e-mail)\b\s*(?:is|:|=)?\s*\S+\s*(?:\/|,|and)?\s*(?:pass(?:word)?|pwd|pw)\b\s*(?:is|:|=)?\s*\S{3,}/.test(lower)) return true;
  if (/\b(login|username|user)\s*(?:is|:)?\s*\S+\s*\/\s*\S{3,}/.test(lower)) return true;
  // The same pairs as they are SPOKEN ("admin slash Sunflower99", "usman at example dot com and Sunflower99").
  const spoken = spokenForm(cred);
  if (spoken !== cred) {
    const sl = spoken.toLowerCase();
    if (/\b(login|username|user name|user|email|e-mail)\b\s*(?:is|:|=)?\s*\S+\s*(?:\/|,|and)?\s*(?:pass(?:word)?|pwd|pw)\b\s*(?:is|:|=)?\s*\S{3,}/.test(sl)) return true;
    if (/\b(login|username|user)\s*(?:is|:)?\s*\S+\s*\/\s*\S{3,}/.test(sl)) return true;
  }
  if (credentialPair(spoken)) return true;
  // "sign in to Xero with admin@kestrel.test and Winter-Is-Coming": two values, one credential-shaped.
  for (const m of cred.matchAll(/\b(?:sign|log)(?:\s|-)?(?:in|on)\b[^.\n]{0,60}?\bwith\s+(\S+)\s+and\s+(\S{3,})/gi))
    if (m[1].includes("@") || valueShaped(m[1]) || valueShaped(m[2])) return true;
  return false;
}

/** A key split by spaces ("sk_live_51H8x Yz9ab CDE…"): join the run after a known prefix and test it. */
function splitKey(text: string): boolean {
  const t = text.normalize("NFKC");
  for (const m of t.matchAll(/(?<![A-Za-z0-9])(sk[-_]|rk_|pk_|ghp_|gh[ousr]_|github_pat_|xox[abprs]-|AIza|AKIA)/g)) {
    const joined = t.slice(m.index!, m.index! + 200).split(/[.,;\n]/)[0].replace(/\s+/g, "");
    if (SECRET_PATTERNS.some((re) => re.test(joined))) return true;
  }
  return false;
}

/** Bank and one-time codes: "OTP 482913", "the NetCode is 55 21 09", "verification code: four eight…". */
function oneTimeCode(norm: string): boolean {
  return /\b(otp|(?:one|1)[- ]time (?:pass ?code|password|code|pin)|verification code|security code|sms code|2fa code|(?:two|2)[- ]factor code|mfa code|netcode|auth(?:orisation|orization)? code|bank code|access code)\b\D{0,20}\d{4,8}\b/.test(norm);
}

/** TFN checksum (weights 1,4,3,7,5,8,6,9,10; mod 11). */
function tfnChecksum(d: string) {
  if (!/^\d{9}$/.test(d)) return false;
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  return [...d].reduce((n, c, i) => n + Number(c) * w[i], 0) % 11 === 0;
}

/**
 * A key or token by shape, whatever it's called: a 32+ char run of mixed-case letters and
 * digits, or bare hex. Paths and slugs (lowercase words and dashes) pass, and so do full git
 * SHAs (40 hex) and sha256 digests (64 hex), which are references rather than secrets.
 */
function highEntropyToken(text: string) {
  for (const m of text.matchAll(/[A-Za-z0-9_+=-]{32,}/g)) {
    const t = m[0];
    if (/^[0-9a-f]+$/i.test(t)) {
      if (t.length !== 40 && t.length !== 64) return true;
      continue;
    }
    const digits = (t.match(/[0-9]/g) || []).length;
    if (/[A-Z]/.test(t) && /[a-z]/.test(t) && digits >= 3 && (t.match(/-/g) || []).length <= 3) return true;
  }
  return false;
}

const BANK_WORDS = /\b(bsb|bank|account|acct|acc|a\/c|cba|commbank|commonwealth|anz|nab|westpac|wbc|bendigo|ing|macquarie|suncorp|boq|st\.? george|bankwest|ubank|up bank|hsbc|citi|amex|visa|mastercard|debit|credit card|card)\b/;

function bankRecord(text: string, ls: string[], norm = normaliseForSecrets(text)) {
  // A BSB: the word near six digits ("BSB is 062-000", "bsb 062 000"), or six digits then an account
  // number of 6-10 digits in bank context ("CBA 062000 12345678").
  if (/\bbsb\b\D{0,20}\d{6}(?!\d)/.test(norm)) return true;
  if (BANK_WORDS.test(text.toLowerCase()) && /(?<!\d)\d{3}[\s.-]?\d{3}(?!\d)\D{1,20}\d(?:[\s.-]?\d){5,9}(?!\d)/.test(text)) return true;
  // An account number: the word near 6-10 digits ("account 1234 5678", "acc no. 1234-5678").
  if (/\b(account|acct|acc|a\/c)\b(?:\s*(?:no\.?|number|num|#))?\D{0,12}\d{6,10}(?!\d)/.test(norm)) return true;
  if (/\b(opening|closing|available)\s+balance\b/i.test(text) && /\$?\d[\d,]*\.\d{2}/.test(text)) return true;
  if (/\bstatement (period|number)\b/i.test(text)) return true;
  // A card number: 13-19 digits passing Luhn, however it was written (spaces, dots, dashes, words).
  for (const m of norm.matchAll(/\d{13,19}/g)) if (luhn(m[0])) return true;
  const txLines = ls.filter((l) => /\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(l) && /-?\$?\d[\d,]*\.\d{2}\b/.test(l));
  return txLines.length >= 2;
}

/** A tax file number: the word near 8-9 digits, or 9 digits that pass the TFN checksum in tax context. */
function governmentId(text: string, norm = normaliseForSecrets(text)) {
  if (/\b(tfn|tax file(?: number| no\.?)?)\b\D{0,20}\d{8,9}(?!\d)/.test(norm)) return true;
  if (/\btax\b/.test(norm)) for (const m of norm.matchAll(/(?<!\d)\d{9}(?!\d)/g)) if (tfnChecksum(m[0])) return true;
  return false;
}

function audio(text: string) {
  if (/data:audio\//i.test(text)) return true;
  // A long unbroken base64 run is an encoded blob (audio or otherwise), not a fact.
  return /[A-Za-z0-9+/]{200,}={0,2}/.test(text);
}

/** The prohibited category a text falls in, or null. Order matters: the most specific wins. */
function prohibited(rawCombined: string, rawText: string, _ls: string[], opts: { chat: boolean; email: boolean; speakerLabels: boolean }): Category | null {
  // Too long to scan is refused, never waved through unscanned (J5: the scan is linear, but its length is bounded all the same).
  if (rawCombined.length > MAX_NOTE_CHARS || rawText.length > MAX_NOTE_CHARS) return "too-long";
  if (audio(rawCombined)) return "audio";
  // Invisible characters, other scripts' digits and look-alike letters are folded away before any rule reads the text.
  const combined = foldForMatching(rawCombined);
  if (combined.length > MAX_NOTE_CHARS) return "too-long";
  const text = rawText === rawCombined ? combined : foldForMatching(rawText);
  const ls = lines(text);
  const norm = normaliseForSecrets(combined);
  const nfkc = combined.normalize("NFKC");
  if (SECRET_PATTERNS.some((re) => re.test(nfkc)) || splitKey(combined) || highEntropyToken(nfkc) || credential(combined, norm)) return "secret";
  if (oneTimeCode(norm)) return "one-time-code";
  if (governmentId(combined, norm)) return "government-id";
  if (bankRecord(combined, ls, norm)) return "bank-record";
  const callLines = opts.speakerLabels ? ls.filter((l) => CALL_LABEL.test(l)).length : 0;
  if (callLines >= 2 || (callLines >= 1 && /\btranscript\b/i.test(combined))) return "call-transcript";
  if (opts.speakerLabels && /\b(call|voicemail)\s+transcript\b/i.test(combined) && ls.length >= 2) return "call-transcript";
  if (ls.filter((l) => /^\[?\d{1,2}:\d{2}:\d{2}\]?/.test(l)).length >= 2) return "call-transcript";
  if (opts.email) {
    if (ls.filter((l) => EMAIL_HEADER.test(l)).length >= 2 || /^on .{4,80} wrote:$/im.test(text)) return "email-body";
    if (ls.length >= 3 && GREETING.test(ls[0]) && ls.slice(-3).some((l) => SIGN_OFF.test(l))) return "email-body";
  }
  if (opts.chat) {
    if (ls.filter((l) => CHAT_LABEL.test(l)).length + callLines >= 2) return "raw-chat";
    if (ls.filter((l) => TIMESTAMP_LINE.test(l) || WHATSAPP_LINE.test(l)).length >= 2) return "raw-chat";
  }
  return null;
}

/**
 * The sensitive category a piece of text falls in (a secret, tax file number, one-time code, bank or card
 * detail, or an encoded blob), or null. The same rules `remember that …` uses, with no size, chat or
 * transcript shaping: for callers that must HIDE such text (a page read aloud), not store a fact.
 */
export function sensitiveCategory(text: string): Category | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const c = prohibited(text, text, lines(text), { chat: false, email: false, speakerLabels: false });
  return c === "secret" || c === "government-id" || c === "one-time-code" || c === "bank-record" || c === "audio" || c === "too-long" ? c : null;
}

/** Screen one candidate fact. Order matters: the most specific category wins. */
export function screenFact(text: unknown, title?: unknown): GuardResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, code: "empty", message: "There's nothing to save." };
  if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_CHARS))
    return { ok: false, code: "too-large", message: `Keep the title under ${MAX_TITLE_CHARS} characters.` };
  // A memory is at most 800 characters: anything over the scan limit is refused unread, not scanned in full first.
  if (text.length > MAX_FACT_SCAN_CHARS)
    return { ok: false, code: "too-large", message: `A memory is one curated fact: at most ${MAX_FACT_CHARS} characters and ${MAX_FACT_LINES} lines. That is too long to check, so it isn't stored.` };
  const combined = `${typeof title === "string" ? title + "\n" : ""}${text}`;
  const category = prohibited(combined, text, lines(text), { chat: true, email: true, speakerLabels: true });
  if (category) return { ok: false, code: "prohibited-content", category, message: MESSAGES[category] };
  const ls = lines(text);
  if (text.length > MAX_FACT_CHARS || ls.length > MAX_FACT_LINES)
    return {
      ok: false,
      code: "too-large",
      message: `A memory is one curated fact: at most ${MAX_FACT_CHARS} characters and ${MAX_FACT_LINES} lines. Link the document by reference instead.`,
    };
  return { ok: true };
}

export const MAX_NOTE_CHARS = 200_000;

/**
 * Screen a whole Obsidian note before it is indexed. Curated notes may hold FAQs, email
 * templates and (when declared `type: script`) call scripts, so chat/email shapes pass; the
 * credential, government-id, bank, audio and transcript shapes never do.
 */
export function screenNote(text: string, options: { script?: boolean } = {}): GuardResult {
  if (!text.trim()) return { ok: false, code: "empty", message: "Empty note." };
  if (text.length > MAX_NOTE_CHARS) return { ok: false, code: "too-large", message: `Notes over ${MAX_NOTE_CHARS} characters are not indexed.` };
  const category = prohibited(text, text, lines(text), { chat: false, email: false, speakerLabels: !options.script });
  return category ? { ok: false, code: "prohibited-content", category, message: MESSAGES[category] } : { ok: true };
}

/** Origin notes/refs are short labels, and get the same screening. */
export function screenOrigin(origin: { ref?: unknown; note?: unknown }): GuardResult {
  for (const value of [origin.ref, origin.note]) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 300)
      return { ok: false, code: "too-large", message: "Keep the source reference short (a path, link or one-line note)." };
    const r = screenFact(value);
    if (!r.ok && r.code === "prohibited-content") return r;
  }
  return { ok: true };
}
