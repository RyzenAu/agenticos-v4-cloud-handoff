// M&U's own websites, by the names the founders use for them. "Go to the MU Ventures main website" opens
// https://muventures.com.au/ from this list, never a web search or a guessed ".com" (J-fix, 29 Sep: Jarvis
// opened muventures.com, and screen hands then wandered into videos about Mu Ventures, a different firm).
// Pure; shared by the voice rules (scripts/free-voice.ts) and anything else that opens "our site".

export type OwnSite = { name: string; url: string; host: string };

export const OWN_SITES: OwnSite[] = [{ name: "M&U Ventures", url: "https://muventures.com.au/", host: "muventures.com.au" }];

const NAME = "(?:m\\s*(?:&|and|n)\\s*u|mu|m u|mnu)\\s*ventures|muventures";
const OURS = "(?:our|my)\\s+(?:own\\s+|main\\s+|business\\s+|company\\s+)*(?:web\\s*site|site|home\\s*page)";
const OWN = new RegExp(`(?:^|\\b)(?:the\\s+)?(?:${NAME})(?:'s|s)?(?:\\s+(?:main|official|home|business|company))?(?:\\s+(?:web\\s*site|site|home\\s*page|page))?\\b|\\b${OURS}\\b`, "i");
const GO = /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+|will you\s+)?(?:go to|open(?: up)?|pull up|load|show me|take me to|bring up|visit|navigate to|head to)\s+/i;

/** "Can you go to MU Ventures main website?", "open our website", "pull up muventures" → our site. Pure. */
export function ownSiteIn(utterance: string): OwnSite | null {
  const u = String(utterance ?? "")
    .replace(/[’`]/g, "'")
    .replace(/^\s*(?:(?:hey|ok|okay)\s+)?(?:jarvis[,\s]+)?/i, "")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+(?:please|for me|now|jarvis|sir)$/i, "")
    .trim();
  if (!u || u.length > 120 || !GO.test(u)) return null;
  // "muventures dot com dot au", "muventures.com.au": the address said or typed in full is still our site (J4).
  const rest = u.replace(GO, "").trim().replace(/^(?:the\s+)?((?:m\s*(?:&|and|n)\s*u|mu|m u|mnu)\s*ventures|muventures)\s*(?:\.|dot)\s*com(?:\s*(?:\.|dot)\s*au)?$/i, "$1");
  // Only the site itself, never a job on it ("go to our website and change the pricing").
  if (/\b(?:and|then)\b/i.test(rest.replace(new RegExp(NAME, "gi"), "our"))) return null;
  const m = rest.match(OWN);
  return m && m.index === 0 && m[0].trim().length >= rest.replace(/\s+/g, " ").length - 2 ? OWN_SITES[0] : null;
}

/**
 * A URL a model guessed for our site ("muventures.com", "www.muventures.com/about") → the real one, path
 * kept. Anything else is returned unchanged. Pure.
 */
export function ownSiteUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/^(?:www\.)?muventures\.com$/i.test(u.hostname)) return `https://muventures.com.au${u.pathname === "/" ? "/" : u.pathname}${u.search}`;
  } catch { /* not a URL */ }
  return url;
}
