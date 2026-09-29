// J2 browser intents: deterministic, no model. His everyday browser commands → one browser-skill request that the
// agent-browser hands run in Jarvis Chrome ("go to our website", "search Google for X", "open my Gmail", "open
// YouTube and search X", "open the Bianca site", "go back", "refresh", "close this tab", "scroll down", "read me
// this page", "click Contact on this page", "find the Dental site in the catalogue and open its preview").
// J4 (29 Sep, AUDIT-JARVIS): the same commands in the way people actually say them: fillers ("uh"), "can you look up X on
// Google", "youtube X", "find some X on YouTube", "show me Bianca Brown Realty", "take me back", "read this page out loud".
// Anything else returns null (window commands are the window skill's; "what's on my screen" is the vision tool's).
import { OUR_SITES } from "../websites/catalogue";
import { ownSiteIn } from "../../src/lib/own-sites";
import { finalButtonText } from "../browser-hands";
import { currentReferent } from "../jarvis-skills/referent";
import { browserTaskIntent } from "./task-intents";

export type BrowserAction = "open" | "open_chrome" | "new_tab" | "search" | "back" | "forward" | "reload" | "close_tab" | "scroll" | "read" | "click" | "task" | "task_here";
export type BrowserSkillRequest = {
  skill: "browser";
  action: BrowserAction;
  url?: string;
  /** What to call the page he opened, for the spoken line ("M&U Ventures", "Bianca Brown Realty"). */
  name?: string;
  engine?: "google" | "youtube";
  query?: string;
  dir?: "up" | "down";
  target?: string;
  /** "Search Google for X and open the first result": the search is done, the click is not (said plainly, J4). */
  firstResult?: boolean;
  /** J6, `task` / `task_here`: the goal sentence (a multi-step job in the browser: search then open a result, fill a form…). */
  goal?: string;
};
/** Actions on the page in front (Jarvis Chrome must be what he's looking at; otherwise it's his own window). */
export const PAGE_ACTIONS = new Set<BrowserAction>(["back", "forward", "reload", "close_tab", "scroll", "read", "click", "task_here"]);
export const BROWSER_ACTIONS: BrowserAction[] = ["open", "open_chrome", "new_tab", "search", "back", "forward", "reload", "close_tab", "scroll", "read", "click", "task", "task_here"];

const WEB_APPS: Array<[RegExp, string, string]> = [
  [/^(?:my\s+)?g ?mail(?:\s+inbox)?$/, "https://mail.google.com/", "Gmail"],
  [/^(?:my\s+)?google (?:drive|docs)$/, "https://drive.google.com/", "Google Drive"],
];

/** Spoken fillers and a correction lead-in ("uh", "no,") in front of the actual command. */
const FILLER_LEAD = /^(?:(?:uh+|um+|er+m?|hmm+|ah+|so|well|okay|ok|right|hey|yeah|like|actually|no|nope|nah)[,\s]+)+/i;

export function cleanUtterance(utterance: string) {
  return clean(utterance);
}
function clean(utterance: string) {
  return String(utterance ?? "")
    .replace(/[’`]/g, "'")
    .replace(/^\s*(?:(?:hey|ok|okay|right)[,\s]+)?(?:jarvis[,\s]+)?/i, "")
    .replace(FILLER_LEAD, "")
    .replace(/^(?:can you|could you|would you|will you|please)[,\s]+/i, "")
    .replace(/^please\s+/i, "")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+(?:please|for me|now|jarvis|sir|mate)$/i, "")
    .replace(/\s+in\s+(?:the|my)\s+(?:browser|chrome|google chrome)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_STOP = new Set(["the", "our", "my", "a", "an", "site", "website", "web", "page", "homepage", "home", "landing", "preview", "demo", "for", "version", "flagship", "client", "live", "of", "in", "catalogue", "and"]);
const tokensOf = (s: string) => s.toLowerCase().replace(/'s\b/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

/** A site from the websites catalogue by the name he uses ("the Bianca site", "the Dental site"), with its preview. */
export function catalogueSite(words: string, preview = false): { name: string; url: string } | null {
  const w = words.toLowerCase();
  for (const s of OUR_SITES) {
    const names = [s.id, s.name.toLowerCase(), s.name.toLowerCase().split(" ")[0], s.vertical, s.vertical.replace("-", " ")];
    if (names.some((n) => n.length >= 4 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(w))) {
      const url = preview && s.alsoAt[0] ? s.alsoAt[0] : s.url;
      return { name: s.name, url: url.endsWith("/") ? url : `${url}/` };
    }
  }
  return null;
}

/**
 * A catalogue site named in ANY way ("show me Bianca Brown Realty", "go to bianca", "open Lantern Dental", "pull up the dental
 * demo", "open the real estate demo for Bianca"): every word must be part of the site's name or plain site words, so "the dental
 * leads" or "the Bianca invoice" never open a site (J4, AUDIT-JARVIS #11). Pure.
 */
export function catalogueSiteNamed(words: string): { name: string; url: string } | null {
  const site = catalogueSite(words, /\bpreview\b/i.test(words));
  if (!site) return null;
  const s = OUR_SITES.find((x) => x.name === site.name)!;
  const allowed = new Set([...tokensOf(s.id.replace(/-/g, " ")), ...tokensOf(s.name), ...tokensOf(s.vertical.replace(/-/g, " ")), ...NAME_STOP]);
  const tokens = tokensOf(words);
  return tokens.length && tokens.every((t) => allowed.has(t)) ? site : null;
}

/** Words that mean "his own things", not the web: a search for these is the OS's, never Google's. */
const OWN_DATA = /\b(?:my|our|mine|files?|folders?|e-?mails?|inbox|notes?|memory|memories|clipboard|leads?|crm|calls?|receptionist|transcripts?|vault|wiki|obsidian|deck|slides?|calendar|downloads?|reminders?|timers?)\b/i;
const webQuery = (q: string | undefined) => {
  const t = String(q ?? "").trim().replace(/^(?:some|any)\s+/i, "");
  return t.length >= 2 && t.length <= 160 && !OWN_DATA.test(t) ? t : null;
};
const youtubeQuery = (q: string | undefined) => {
  const t = String(q ?? "").trim().replace(/^(?:some|any)\s+/i, "");
  return t.length >= 2 && t.length <= 160 ? t : null;
};

const SCROLL_WORDS = new Set(["the", "page", "it", "this", "a", "bit", "little", "lot", "more", "some", "down", "up", "just"]);

export function browserSkillIntent(utterance: string, options: { sharing?: boolean; noTask?: boolean } = {}): BrowserSkillRequest | null {
  const u = clean(utterance);
  if (!u || u.length > 200) return null;
  const l = u.toLowerCase();
  const q = (action: BrowserAction, extra: Partial<BrowserSkillRequest> = {}): BrowserSkillRequest => ({ skill: "browser", action, ...extra });
  // "Open Chrome": Jarvis Chrome, on his main screen (a bare app open; "open Chrome and go to X" is a compound, not this).
  // ("bring up Chrome" is the window skill's: focus and his main screen.)
  if (/^(?:open|launch|start|fire up|run)\s+(?:up\s+)?(?:(?:google\s+)?chrome|(?:the|a|my)\s+(?:web\s+)?browser)(?:\s+browser)?(?:\s+up)?$|^i\s+(?:need|want)\s+(?:google\s+)?chrome(?:\s+(?:up|open))?$/.test(l)) return q("open_chrome");
  // J6: a multi-step goal ("search Google for X and open the first result", "go to <site> and click <link>", "open my Gmail and
  // search for X", "fill the contact form…"): the task loop. A goal on the page in front waits for the sharing check below.
  if (!options.noTask) {
    const task = browserTaskIntent(u);
    // YouTube search/play/open-result stays with the command entry's app-owned browser (its transcript watcher, device routing
    // and job record); the task loop is for the rest of the web. The loop still runs a YouTube goal when asked for one by name.
    const youtube = /\byou\s?tube\b/i.test(u);
    if (task && !youtube && (task.action === "task" || !options.sharing)) return task;
  }
  // Our own site (muventures.com.au, never a guessed .com).
  const own = ownSiteIn(u);
  if (own) return q("open", { url: own.url, name: own.host });
  // A site in the websites catalogue: "open the Bianca site", "find the Dental site in the catalogue and open its preview".
  let m = l.match(/^(?:find|look up)\s+(?:the\s+)?(.{2,40}?)\s+(?:site|website)(?:\s+in the catalogue)?\s+and\s+open\s+(?:its|the)\s+(preview|site|website|live site)$/);
  if (m) {
    const site = catalogueSite(m[1], m[2] === "preview");
    return site ? q("open", { url: site.url, name: site.name }) : null;
  }
  m = l.match(/^(?:open|go to|pull up|show me|load|visit|take me to|bring up|check out|head to|launch)\s+(?:up\s+)?(?:the\s+|our\s+|my\s+)?(.{2,60})$/);
  if (m) {
    const site = catalogueSiteNamed(m[1]);
    if (site) return q("open", { url: site.url, name: site.name });
  }
  // Web apps: "open my Gmail", "can you open up gmail", "uh go to gmail", "open Gmail in the browser".
  m = l.match(/^(?:open|go to|pull up|show me|check|bring up|load|visit|take me to)\s+(?:up\s+)?(.{3,30})$/);
  if (m) for (const [re, url, name] of WEB_APPS) if (re.test(m[1])) return q("open", { url, name });
  // A compound — "…and play the first video, then pause it" — is a multi-step job: not a single search here.
  const single = (words: string) => !/\b(?:and|then)\s+(?:play|click|open|pause|watch|tap|press|stop|skip|like|subscribe)\b|,\s*then\b/.test(words);
  // "Search Google for dentists and open the first result": the search is done; the click isn't, and he's told so plainly.
  m = l.match(/^(?:search|look up|google)\s+(?:(?:on\s+)?google\s+)?(?:for\s+)?(.{2,120}?)\s+(?:and|then)\s+(?:open|click|go to|pick|select|choose)\s+(?:on\s+)?(?:the\s+)?(?:first|top|1st)\s+(?:result|link|one|hit|page)$/);
  if (m && webQuery(m[1])) return q("search", { engine: "google", query: webQuery(m[1])!, firstResult: true });
  // Searches: "search Google for X", "google X", "do a google search for X", "find X on Google", "can you look up X on Google".
  m = l.match(/^(?:search|look up|find|look for)\s+(?:on\s+|in\s+)?google\s+(?:for\s+)?(.{1,120})$|^google\s+search\s+(?:for\s+)?(.{1,120})$|^(?:do|run|make|perform)\s+an?\s+google\s+search\s+(?:for|on|about)\s+(.{1,120})$|^google\s+(?!chrome\b|drive\b|docs\b|maps\b|calendar\b|mail\b|gmail\b|search\b)(.{1,120})$|^(?:search|look up|find|look for)\s+(?:for\s+)?(.{1,120}?)\s+(?:on|in|using|with)\s+google$|^(?:search|look up|find|look for)\s+(?:the\s+(?:web|internet|net)|online)\s+for\s+(.{1,120})$/);
  const g = m && (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6]);
  if (g && single(g)) return q("search", { engine: "google", query: g.trim() });
  // YouTube: "open YouTube and search X", "search YouTube for X", "find some X on YouTube", "youtube X", "put on some X on YouTube".
  m = l.match(/^(?:open|go to)\s+youtube\s+(?:and|then)\s+(?:search|look up)(?:\s+for)?\s+(.{1,120})$|^(?:search|look up|find)\s+(?:on\s+|in\s+)?youtube\s+(?:for\s+)?(.{1,120})$|^(?:search|look up|find|look for|put on)\s+(?:for\s+)?(.{1,120}?)\s+(?:on|in)\s+youtube$|^youtube\s+(?:search\s+(?:for\s+)?)?(?!(?:and|then|for|on|is|has|was|studio|music|premium|tv|kids|shorts|channel|home|homepage|subscriptions|history|videos?)\b)(.{2,120})$/);
  const yt = m && (m[1] ?? m[2] ?? m[3] ?? m[4]);
  if (yt && single(yt) && youtubeQuery(yt)) return q("search", { engine: "youtube", query: youtubeQuery(yt)! });
  // A plain "search for X" / "look up X" with no engine named is the web (Google), unless X is his own stuff.
  m = l.match(/^(?:search|look up)\s+(?:for\s+)?(.{2,120})$/);
  if (m && single(m[1]) && !/\b(?:youtube|in memory|in the vault|in my)\b/.test(m[1]) && webQuery(m[1])) return q("search", { engine: "google", query: webQuery(m[1])! });
  // While he shares his screen, "this page" is the one he's showing: not Jarvis Chrome's.
  if (options.sharing) return null;
  if (/^(?:(?:open|start|make|give me|get me|create)(?:\s+up)?\s+(?:me\s+)?(?:a\s+|another\s+|one more\s+)?(?:new\s+|fresh\s+|blank\s+)?(?:chrome\s+|browser\s+)?tab|new\s+(?:chrome\s+)?tab|i\s+(?:want|need)\s+(?:a\s+)?(?:new|fresh|another)\s+tab)$/.test(l)) return q("new_tab");
  // (A pronoun — "refresh it", "what does it say" — is Jarvis Chrome's page only right after Jarvis opened something there.)
  const here = !!currentReferent()?.jarvisChrome;
  if (/^(?:go\s+)?back(?:\s+(?:a|one)\s+page)?$|^take me back(?:\s+a\s+page)?$|^(?:go\s+)?(?:back\s+)?to\s+the\s+(?:previous|last)\s+page$/.test(l)) return q("back");
  if (/^(?:go\s+)?forward(?:\s+a\s+page)?$/.test(l)) return q("forward");
  if (/^(?:refresh|reload)(?:\s+(?:the|this)\s+page)?$/.test(l) || (here && /^(?:refresh|reload)\s+(?:it|that)$/.test(l))) return q("reload");
  if (/^(?:close|shut)\s+(?:this|the|that)\s+tab$/.test(l)) return q("close_tab");
  m = l.match(/^(scroll|nudge|page)\b\s*(.*)$/);
  if (m) {
    const rest = tokensOf(m[2]);
    const dir = rest.includes("up") ? "up" : rest.includes("down") ? "down" : null;
    if (rest.every((w) => SCROLL_WORDS.has(w)) && (dir || m[1] === "scroll") && !(rest.includes("up") && rest.includes("down")) && (m[1] === "scroll" || dir)) return q("scroll", { dir: dir === "up" ? "up" : "down" });
  }
  if (/^(?:read|summari[sz]e)\s+(?:me\s+)?(?:this|the|that)\s+page(?:\s+(?:to me|out(?:\s+loud)?|aloud|back to me))?$|^what(?:'s| is| does)\s+(?:this|the)\s+page\s+(?:say|about|saying)$|^(?:tell me|what(?:'s| is))\s+(?:what(?:'s| is)\s+)?on\s+(?:this|the)\s+page$|^(?:give me|what(?:'s| is))\s+(?:a\s+|the\s+)?(?:summary|gist)\s+of\s+(?:this|the)\s+page$/.test(l)) return q("read");
  if (here && /^(?:what\s+does\s+it\s+say|(?:read|summari[sz]e)\s+(?:it|that)(?:\s+(?:to me|out(?:\s+loud)?|aloud))?)$/.test(l)) return q("read");
  // "click "Contact" on this page", "click Contact", "press the Contact link".
  m = u.match(/^(?:click|press|tap|hit)(?:\s+on)?\s+(?:the\s+)?["“']?(.{1,60}?)["”']?(?:\s+(?:link|button|tab))?(?:\s+on\s+(?:this|the)\s+page)?$/i);
  // A final or money button ("press send", "click pay now") stays on the gated path that asks for his spoken yes.
  // Not a compound ("click the Name field and type Test") and not a pointer ("click that one there"): those are
  // steps on his own screen.
  if (m && !/^(?:the\s+)?(?:first|second|third|last|\d)/i.test(m[1]) && !/\b(?:and|then)\b/i.test(m[1]) && !/^(?:that|this|it|here|there)\b/i.test(m[1]) && !/\b(?:here|there|over there|right there)$/i.test(m[1]) && !finalButtonText(m[1]))
    return q("click", { target: m[1].trim() });
  return null;
}
