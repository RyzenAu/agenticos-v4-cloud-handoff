// How Jarvis's lines sound (J4, AUDIT-JARVIS: "one voice"). Two pure helpers, applied in ONE place (scripts/free-voice.ts) to
// every line that is spoken back from a tool or a rule:
//   spokenSafe   never IDs, file paths or ISO dates aloud: "from your memory", the note's title, "28 September".
//   createTone   the light "sir": about one reply in four, deterministic by a counter, never doubled, never on a refusal,
//                a safety line, a question or a greeting.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09-28" → "28 September" (with the year when it isn't this year). Australian order, never ISO. */
export function spokenDate(iso: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return iso;
  const thisYear = Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric" }).format(now));
  return `${day} ${MONTHS[month - 1]}${year === thisYear ? "" : ` ${year}`}`;
}

/** "memory-business-shared" / "wiki/topics/business/memory-business-shared.md" → "Business shared". */
function noteTitle(pathOrLink: string): string {
  const stem = pathOrLink.replace(/[#^].*$/, "").split(/[\\/]/).pop()!.replace(/\.[a-z0-9]{1,5}$/i, "");
  const words = stem.replace(/^memory-/, "").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "a note";
}

/** A line with no memory IDs, vault links, file paths or ISO dates in it. Pure. */
export function spokenSafe(line: string, now = new Date()): string {
  const original = String(line ?? "");
  if (!original) return original;
  let s = original;
  // Vault links: [[memory-business-shared#^mf-6dbfbbf222]] → the note's title.
  s = s.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_m, target: string) => `your "${noteTitle(target)}" note`);
  // Memory IDs: "as mem-3b20eebb69", "from the Jarvis memory mem-075a2bc89e", a bare "mem-…".
  s = s.replace(/\s+as\s+mem-[0-9a-f]{6,}\b/gi, "");
  s = s.replace(/\b(?:from|in|to)\s+the\s+(?:Jarvis\s+|Hindsight\s+)?memory\s+mem-[0-9a-f]{6,}\b/gi, (m) => `${/^\w+/.exec(m)![0]} your memory`);
  s = s.replace(/\bmem-[0-9a-f]{6,}\b/gi, "that memory");
  s = s.replace(/\bmf-[0-9a-f]{6,}\b/gi, "that fact");
  // File paths: "vault note wiki/topics/business/memory-business-shared.md", "C:\…\notes.md" → the note's title.
  s = s.replace(/\b(?:the\s+)?(?:vault\s+)?note\s+((?:[A-Za-z]:[\\/]?)?[\w.\-\\/ ]*[\\/][\w.\-]+\.(?:md|json|txt|csv|ts))\b/gi, (_m, p: string) => `your "${noteTitle(p)}" note`);
  s = s.replace(/(?:[A-Za-z]:[\\/]?)?(?:[\w.\-]+[\\/]){2,}[\w.\-]+\.(?:md|json|txt|csv|ts|tsx|sqlite)\b/g, (p) => `"${noteTitle(p)}"`);
  // ISO dates and timestamps: "saved 2026-09-28" → "saved 28 September".
  s = s.replace(/\b(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, (_m, d: string) => spokenDate(d, now));
  // Nothing to say differently: the line is returned exactly as it came (newlines and spacing untouched).
  if (s === original) return original;
  return s.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?])/g, "$1").trim();
}

/** Lines that are never given a "sir": refusals, failures, safety lines, questions, greetings and apologies. */
const NEVER_SIR =
  /\?|\b(?:can't|cannot|can not|couldn't|could not|won't|will not|wouldn't|never|refus\w*|isn't|aren't|wasn't|didn't|don't|doesn't|haven't|hasn't|unable|unavailable|failed|nothing was|not done|not safe|sign-in|money site|final button|yours to|yourself|password|passcode|secret|banking|card number|sorry|my mistake|I only)\b|^(?:good (?:morning|afternoon|evening|night)|goodnight|sorry)\b/i;

/** "…, sir." at the end, "Sir, …" in front and ", sir," in the middle: taken out (the tone helper puts it back one reply in four). */
function withoutSir(line: string): string {
  return line
    .replace(/^sir,\s*(\w)/i, (_m, c: string) => c.toUpperCase())
    .replace(/,\s*sir(?=\s*[.!?]|\s*$)/gi, "")
    .replace(/,\s*sir,/gi, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** One helper per voice engine: `tone(line)` → the line, with "sir" on about one reply in `period` (the first, then every fourth). */
export function createTone(period = 4) {
  let n = 0;
  return (line: string): string => {
    const text = String(line ?? "");
    if (!text.trim() || NEVER_SIR.test(text)) return text;
    const turn = n++;
    const bare = withoutSir(text);
    // Something else in the line already addresses him (a name after "sir" elsewhere): leave it alone, never double.
    if (/\bsir\b/i.test(bare) || turn % period !== 0) return bare;
    // After the first sentence: "Opened muventures.com.au in Chrome on your main screen, sir."
    const first = /^(.*?[^.\s])([.!])(\s|$)/.exec(bare);
    if (first && !/\bsir\b/i.test(first[1])) return `${first[1]}, sir${first[2]}${bare.slice(first[0].length - first[3].length)}`;
    return `${bare.replace(/[.!]?$/, "")}, sir.`;
  };
}

/** Roughly how often a run of lines carries "sir" (tests). */
export const sirRate = (lines: string[]) => (lines.length ? lines.filter((l) => /\bsir\b/i.test(l)).length / lines.length : 0);
