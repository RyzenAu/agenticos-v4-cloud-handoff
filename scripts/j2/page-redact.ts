// "Read me this page" must never speak or store a secret, and never pass a page's instructions on as Jarvis's own
// words. The page text is cut into sentences and each one goes through the SAME checks the screen hands use
// (`looksSecret` and `sensitiveText` for keys, passwords and card numbers; `INJECTION` for text written at an
// assistant) plus the memory guard's rules (bank, BSB, TFN, one-time codes, login pairs). What trips one is
// replaced by "[hidden]". Nothing here forks a filter: it only composes the shared ones.
//
// J3 review F1: the text is first folded (invisible characters gone, other scripts' digits and look-alike letters
// made plain, as the guard does), and a secret split over several lines is judged as a RUN: a card number shown as
// one group per line (digits or number words), or a label ("Pwd", "CVC") with its value on the lines after it.
//
// J5 review F2: a label carries over a whole HEADER BLOCK. A table shown one cell per line ("Username / Password /
// Email / … / admin / Sunflower99!") puts the value rows well after the label, so a label hides the rest of the run of
// short cell-like lines it sits in (up to 48), markdown rows ("| Password | x |") and JSON ({"pass": "…"}) are read
// as labelled values, recovery and seed phrases hide their words, and an IBAN is hidden whole or one group per line.
import { looksSecret } from "../jarvis-skills/text";
import { foldForMatching, normaliseForSecrets, sensitiveCategory } from "../memory/guard";
import { INJECTION, sensitiveText } from "../screen-hands/plan";
import { PAGE_READ_KEPT } from "../../src/lib/page-read";

export const HIDDEN = "[hidden]";
/** Said once when something was hidden. */
export const HIDDEN_NOTE = "I hid some sensitive text (card, key, password or code details) rather than read it out.";
export const INJECTED_NOTE = "I also skipped text that reads like instructions aimed at me.";
/** What goes into the conversation history in place of the page's words. */
export const READ_KEPT = PAGE_READ_KEPT;

/** Card-like runs (13 to 19 digits, spaced or dashed, Luhn or not) and card security codes. */
const CARD_RUN = /(?<!\d)(?:\d[ \-.]?){13,19}(?!\d)/;
const SECURITY_CODE = /\b(?:cvv|cvc|cvn|csc|security code)\b/i;
/** Words that name a secret: what follows one is probably its value. */
const LABEL_WORDS =
  "pass(?:word|code|phrase|wd)?|pwd|pw|pin|cvv|cvc|cvn|csc|security code|card number|account number|bsb|tfn|tax file number|otp|one[- ]time (?:code|password)|verification code|api key|secret(?: key)?|client secret|token|(?:access|auth|refresh|bearer) token|recovery(?: (?:phrase|words?|codes?|key|seed))?|seed(?: (?:phrase|words?))?|backup (?:phrase|words?|codes?)|mnemonic|iban|swift(?: code)?|private key";
/** A label with no value of its own ("Password", "Pwd", "CVC", "Card number", "Recovery phrase", "IBAN"): what follows is probably its value. */
const LABEL_ONLY = new RegExp(`^(?:[\\w ]{0,20})\\b(?:${LABEL_WORDS})\\b[\\s:=-]*$`, "i");
/** A JSON or config line that hands over a secret by its key: {"pass": "…"}, "recovery": "…", seed_phrase = …, iban: … */
const SECRET_KEY_VALUE =
  /["']?\b(?:pass|passwd|pwd|pw|password|passcode|passphrase|secret|client[_ -]?secret|token|(?:access|auth|refresh|bearer)[_ -]?token|api[_ -]?key|recovery(?:[_ -]?(?:phrase|words?|codes?|key|seed))?|seed(?:[_ -]?(?:phrase|words?))?|backup[_ -]?(?:phrase|words?|codes?)|mnemonic|iban|private[_ -]?key|pin|otp|cvv|cvc)\b["']?\s*[:=]\s*["'[]?\s*[^\s"',\]}]/i;
const NUMBER_WORD = /\b(?:zero|oh|nought|nil|one|two|three|four|five|six|seven|eight|nine|double|triple)\b/gi;
/** How many short value lines a label carries on, how many numeric pieces make one run, and the longest header block. */
const CARRY_MAX = 6;
const BLOCK_MAX = 48;
const RUN_MAX = 8;
const MAX_JUDGED = 6000;

/** An IBAN (two letters, two check digits, up to 30 more), with the mod-97 check. Fake and real ones alike are hidden. */
function ibanValid(s: string): boolean {
  const t = s.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(t)) return false;
  let rem = 0;
  for (const ch of t.slice(4) + t.slice(0, 4)) {
    const v = ch >= "A" ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = (v > 9 ? rem * 100 + v : rem * 10 + v) % 97;
  }
  return rem === 1;
}
const IBAN_IN_TEXT = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])/g;
const hasIban = (p: string) => [...p.matchAll(IBAN_IN_TEXT)].some((m) => ibanValid(m[0]));

/** True when a piece of page text should not be spoken. */
export function isSensitivePiece(piece: string): boolean {
  const p = foldForMatching(piece).trim();
  if (!p) return false;
  return looksSecret(p) || sensitiveText(p) !== null || sensitiveCategory(p) !== null || CARD_RUN.test(p) || /\d{13,19}/.test(normaliseForSecrets(p)) || SECURITY_CODE.test(p) || SECRET_KEY_VALUE.test(p) || hasIban(p);
}

/** Only digits, digit words and separators ("4111", "062-000", "four one one one"), at least one of them a number. */
const numericPiece = (p: string) => p.length <= 24 && (/\d/.test(p) || new RegExp(NUMBER_WORD.source, "i").test(p)) && p.replace(NUMBER_WORD, "").replace(/[\d\s\-.]/g, "") === "";
/** A short cell of a table or list shown line by line: at most four words, not a sentence or a question. */
const cellLike = (p: string) => {
  if (p.length > 40) return false;
  const words = p.split(/\s+/).length;
  // A single token is a cell whatever it ends with ("Sunflower99!"); a phrase that ends like a sentence is not.
  return words === 1 || (words <= 4 && !/[.?!]$/.test(p));
};
/** A label as a page shows it: markdown emphasis and table pipes around it do not change what it is. */
const isLabel = (p: string) => LABEL_ONLY.test(p.replace(/[*_`#>|]/g, "").trim());

export type SafePage = { text: string; hidden: number; injected: number };

/** Sentence-sized pieces of a page's text (a sentence, a line, a table cell; the pipes around a markdown cell are dropped). */
const pieces = (raw: string) =>
  raw
    .split(/(?<=[.?])\s+|\r?\n+|\s\|\s|\s[•·]\s/)
    .map((s) => s.trim().replace(/^\|+\s*|\s*\|+$/g, "").trim())
    .filter(Boolean);

/**
 * The page text with every sensitive sentence and every sentence that reads like an instruction to an assistant
 * replaced by "[hidden]" (runs of them collapse to one). `hidden` and `injected` count what was taken out.
 */
export function safePageText(raw: string, maxChars = 6000): SafePage {
  // Only the first few thousand characters can ever be spoken (about 320), so no more than that is ever judged.
  const all = pieces(foldForMatching(String(raw ?? "").slice(0, Math.min(maxChars, MAX_JUDGED))));
  const state: Array<"keep" | "hidden" | "injected"> = all.map((p) => (INJECTION.test(p) ? "injected" : "keep"));
  /** How many cell-like lines follow line i without a break (a sentence, a question or an instruction ends the block). */
  const cellsAfter = (i: number) => {
    let n = 0;
    while (i + 1 + n < all.length && n < BLOCK_MAX && state[i + 1 + n] !== "injected" && cellLike(all[i + 1 + n])) n++;
    return n;
  };
  // Each piece on its own; a label hides itself and the cell-like lines after it (its whole header block and the value rows).
  let carry = 0;
  all.forEach((p, i) => {
    if (state[i] === "injected") return void (carry = 0);
    if (isLabel(p)) {
      state[i] = "hidden";
      carry = cellLike(p) ? Math.max(CARRY_MAX, cellsAfter(i)) : 0;
      return;
    }
    if (carry > 0 && cellLike(p)) {
      state[i] = "hidden";
      carry--;
      return;
    }
    if (isSensitivePiece(p)) {
      state[i] = "hidden";
      carry = 0;
      return;
    }
    carry = 0;
  });
  // A card, BSB or TFN shown one group per line: consecutive numeric pieces are judged as one joined run.
  for (let i = 0; i < all.length; ) {
    if (state[i] !== "keep" || !numericPiece(all[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < all.length && j - i < RUN_MAX && state[j] === "keep" && numericPiece(all[j])) j++;
    if (j - i >= 2 && isSensitivePiece(all.slice(i, j).join(" "))) for (let k = i; k < j; k++) state[k] = "hidden";
    i = j;
  }
  // An IBAN shown one group of two to five characters per line ("GB82", "WEST", "1234", …).
  const group = (p: string) => /^[A-Za-z0-9]{2,5}$/.test(p);
  for (let i = 0; i < all.length; ) {
    if (state[i] !== "keep" || !/^[A-Z]{2}\d{2}$/.test(all[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < all.length && j - i < 10 && state[j] === "keep" && group(all[j])) j++;
    for (let end = j; end - i >= 4; end--) {
      if (ibanValid(all.slice(i, end).join(""))) {
        for (let k = i; k < end; k++) state[k] = "hidden";
        break;
      }
    }
    i = Math.max(j, i + 1);
  }
  let hidden = 0;
  let injected = 0;
  const out: string[] = [];
  all.forEach((p, i) => {
    if (state[i] === "keep") return void out.push(p);
    if (state[i] === "injected") injected++;
    else hidden++;
    out.push(HIDDEN);
  });
  const text = out.join(" ").replace(/(?:\[hidden\]\s*){2,}/g, `${HIDDEN} `).replace(/\s+/g, " ").trim();
  return { text, hidden, injected };
}

/** A page title that may itself carry a secret or an instruction. */
export function safeTitle(title: string): string {
  const t = foldForMatching(String(title ?? "")).trim();
  return !t || INJECTION.test(t) || isSensitivePiece(t) ? "" : String(title).trim();
}
