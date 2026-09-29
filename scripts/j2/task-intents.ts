// J6: the multi-step browser goals, by rules (no model, no network): "search Google for X and open the first result",
// "search YouTube for X and play the first video", "open the second result", "go back and open the next one", "go to <site>
// and click <link>", "open my Gmail and search for X", "find the pricing page on <site>", "read me the headline of the top
// story on <news site>", "scroll to the bottom and read the footer", "open the Contact page and read the phone number",
// "fill the contact form on <site> with my name and email but don't send it".
//
// A goal is recognised into a TaskShape (pure) and runs through the loop in browser-task.ts. What the rules don't recognise
// goes to Jev (browser.task) and then the brain, which drive the same loop (never the screen hands).
import { spokenUrls, SITES } from "../jev";
import { ownSiteIn } from "../../src/lib/own-sites";
import { finalButtonText } from "../browser-hands";
import { browserSkillIntent, catalogueSiteNamed, cleanUtterance, type BrowserSkillRequest } from "./intents";

export type TaskSite = { url: string; name: string };
export type PageKind = "pricing" | "contact" | "about" | "services" | "blog" | "careers" | "faq" | "support" | "team" | "packages";
export type Nth = number | "next" | "last";
export type TaskShape =
  | { kind: "search_open"; engine: "google" | "youtube"; query: string; nth: Nth; play: boolean }
  | { kind: "open_nth"; nth: Nth; back: boolean }
  | { kind: "site_click"; site: TaskSite; label: string }
  | { kind: "find_page"; site: TaskSite | null; page: PageKind }
  | { kind: "gmail_search"; query: string }
  | { kind: "read_headline"; site: TaskSite | null }
  | { kind: "read_footer"; site: TaskSite | null }
  | { kind: "contact_read"; site: TaskSite | null; what: "phone" | "email" | "address" }
  | { kind: "fill_form"; site: TaskSite | null; wants: string[] | "all" }
  | { kind: "free" };

/** Does the shape open something itself (a search or a named site), or act on the page already in front? */
export function opensItself(shape: TaskShape): boolean {
  switch (shape.kind) {
    case "search_open":
    case "gmail_search":
      return true;
    case "site_click":
      return true;
    case "find_page":
    case "read_headline":
    case "read_footer":
    case "contact_read":
    case "fill_form":
      return shape.site !== null;
    case "open_nth":
      return false;
    case "free":
      return false;
  }
}

const ORDINALS: Record<string, number> = { first: 1, "1st": 1, top: 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4, fifth: 5, "5th": 5, five: 5, sixth: 6, "6th": 6, seventh: 7, "7th": 7, eighth: 8, "8th": 8, ninth: 9, "9th": 9, tenth: 10, "10th": 10 };
/** "first", "2nd", "number 3", "next", "last" → 1, 2, 3, "next", "last". Null when it isn't one. Pure. */
export function ordinalOf(word: string | undefined): Nth | null {
  const w = String(word ?? "").toLowerCase().trim().replace(/^(?:number|no\.?|#)\s*/, "");
  if (!w) return null;
  if (w === "next" || w === "another" || w === "other") return "next";
  if (w === "last" || w === "final") return "last";
  if (w in ORDINALS) return ORDINALS[w];
  const n = Number(w.replace(/(?:st|nd|rd|th)$/, ""));
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

// --- sites ---------------------------------------------------------------------------------------------------------------
const NEWS: Array<[RegExp, string, string]> = [
  [/^(?:the\s+)?(?:abc(?:\s+news)?|abc\.net\.au(?:\/news)?)$/, "https://www.abc.net.au/news", "ABC News"],
  [/^(?:the\s+)?bbc(?:\s+news)?$/, "https://www.bbc.com/news", "BBC News"],
  [/^(?:the\s+)?guardian(?:\s+(?:australia|au))?$/, "https://www.theguardian.com/au", "The Guardian"],
  [/^(?:the\s+)?(?:sydney morning herald|smh)$/, "https://www.smh.com.au/", "The Sydney Morning Herald"],
  [/^(?:sky news(?:\s+australia)?)$/, "https://www.skynews.com.au/", "Sky News"],
  [/^reuters$/, "https://www.reuters.com/", "Reuters"],
  [/^(?:cnn)$/, "https://edition.cnn.com/", "CNN"],
  [/^(?:hacker news|hn)$/, "https://news.ycombinator.com/", "Hacker News"],
];
const WEB_APPS: Array<[RegExp, string, string]> = [
  [/^(?:my\s+)?g ?mail(?:\s+inbox)?$/, "https://mail.google.com/", "Gmail"],
];

/**
 * The site he means by these words: our own site, a catalogue site, a spoken address (bristol.com, "example dot com"), a news
 * site, or one of his known sites (YouTube, GitHub…). Null when it can't be one (never a guess). Pure.
 */
export function resolveSite(words: string): TaskSite | null {
  const w = String(words ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+$/, "").replace(/^(?:the\s+)?(?:web\s*)?(?:site|website|page)\s+(?:of\s+)?/, "").replace(/\s+(?:web\s*site|site|home\s*page|page)$/, "").replace(/\s+/g, " ").trim();
  if (!w || w.length > 80) return null;
  const own = ownSiteIn(`go to ${words}`);
  if (own) return { url: own.url, name: own.host };
  for (const [re, url, name] of [...NEWS, ...WEB_APPS]) if (re.test(w)) return { url, name };
  const urls = spokenUrls(w);
  if (urls.length === 1 && w.replace(/\s+dot\s+/g, ".").replace(/\s+/g, "") === urls[0].replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\s+/g, "")) {
    const host = new URL(urls[0]).hostname.replace(/^www\./, "");
    return { url: urls[0].endsWith("/") ? urls[0] : `${urls[0]}/`, name: host };
  }
  const named = catalogueSiteNamed(w);
  if (named) return { url: named.url, name: named.name };
  for (const [url, label] of Object.entries(SITES)) {
    const tokens = label.toLowerCase().replace(/\)/g, "").split(/\s*\(|,\s*/).map((t) => t.trim()).filter(Boolean);
    if (tokens.includes(w) && !/\bsearch\b/.test(label.toLowerCase())) return { url: `${url}/`, name: label.replace(/\s*\(.*$/, "").trim() };
  }
  return null;
}

// --- the grammar ---------------------------------------------------------------------------------------------------------
const ACT = "(?:open|click(?:\\s+on)?|go\\s+to|pick|select|choose|play|watch|start|hit|press|tap|check\\s+out|pull\\s+up|show\\s+me)";
const ORD_WORD = "(first|top|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|another|last|number\\s+\\d+|#\\d+|\\d{1,2}(?:st|nd|rd|th))";
const NOUN = "(?:search\\s+)?(?:result|link|one|hit|video|clip|song|track|listing|story|article)s?";
/** "…, then open the first result": the act clause at the end of a search phrase. */
const RESULT_TAIL = new RegExp(`(?:\\s*,\\s*|\\s+)(?:and\\s+|then\\s+|and\\s+then\\s+)?(${ACT})\\s+(?:on\\s+)?(?:the\\s+)?(?:${ORD_WORD}\\s+)?(?:${NOUN}|it|that)(?:\\s+(?:on|in|from)\\s+(?:google|youtube|the results?))?$`, "i");
/** "open the second result" on its own, after a search. */
const NTH_ALONE = new RegExp(`^(?:go\\s+ahead\\s+and\\s+)?${ACT}\\s+(?:on\\s+)?(?:the\\s+)?(?:${ORD_WORD}\\s+)?(?:result|link|one|hit|video|listing|story|article)s?(?:\\s+(?:one|number\\s+\\d+))?$`, "i");
const NTH_NUMBERED = new RegExp(`^(?:go\\s+ahead\\s+and\\s+)?${ACT}\\s+(?:on\\s+)?(?:the\\s+)?(?:result|link|video|hit|listing|story|article)\\s+(?:number\\s+|no\\.?\\s*|#)(\\d{1,2})$`, "i");
const NTH_BACK = new RegExp(`^(?:go\\s+)?back\\s*(?:a\\s+page\\s*)?(?:,|and|then)\\s*(?:and\\s+|then\\s+)?${ACT}\\s+(?:on\\s+)?(?:the\\s+)?(?:${ORD_WORD}\\s+)?(?:result|link|one|hit|video|listing|story|article)?s?$`, "i");
const PAGES: Array<[RegExp, PageKind]> = [
  [/^(?:pricing|prices?|plans?(?:\s+(?:and|&)\s+pricing)?|pricing\s+(?:and|&)\s+plans)$/, "pricing"],
  [/^contact(?:\s+us)?$/, "contact"],
  [/^about(?:\s+us)?$/, "about"],
  [/^services?$/, "services"],
  [/^blog$/, "blog"],
  [/^(?:careers|jobs)$/, "careers"],
  [/^faqs?$/, "faq"],
  [/^support$/, "support"],
  [/^team$/, "team"],
  [/^packages?$/, "packages"],
];
const pageKind = (w: string): PageKind | null => PAGES.find(([re]) => re.test(w.toLowerCase().trim()))?.[1] ?? null;
/** The words a link to each page goes by. Pure data for the loop. */
export const PAGE_LABELS: Record<PageKind, RegExp> = {
  pricing: /\b(?:pricing|prices?|plans?|packages?|rates|cost)\b/i,
  contact: /\b(?:contact(?:\s+us)?|get in touch|enquir(?:e|y|ies)|inquir(?:e|y|ies))\b/i,
  about: /\b(?:about(?:\s+us)?|our story|who we are)\b/i,
  services: /\bservices?\b/i,
  blog: /\b(?:blog|news|articles)\b/i,
  careers: /\b(?:careers|jobs|work with us)\b/i,
  faq: /\b(?:faqs?|questions)\b/i,
  support: /\b(?:support|help)\b/i,
  team: /\b(?:team|our people|meet)\b/i,
  packages: /\b(?:packages?|plans?)\b/i,
};

const PAGE_WORDS = "pricing|prices?|plans?|contact(?:\\s+us)?|about(?:\\s+us)?|services?|blog|careers|jobs|faqs?|support|team|packages?";
const SITE_HEAD = "(?:go\\s+to|open|visit|head\\s+to|pull\\s+up|load)";

/**
 * His words → the task shape they name, or null (a plain command, or something the rules don't know: Jev and the brain take it
 * from there). Pure; `u` is a cleaned utterance (cleanUtterance).
 */
export function parseTaskGoal(u: string): TaskShape | null {
  const l = u.toLowerCase().trim();
  if (!l || l.length > 200) return null;
  let m: RegExpMatchArray | null;

  // 1. A search and an act on its results.
  const tail = l.match(RESULT_TAIL);
  if (tail && tail.index !== undefined) {
    const head = u.slice(0, tail.index).trim();
    const search = head ? browserSkillIntent(head, { noTask: true }) : null;
    if (search?.action === "search" && search.query && (search.engine === "google" || search.engine === "youtube")) {
      const nth = ordinalOf(tail[2]) ?? 1;
      const verb = tail[1].toLowerCase();
      return { kind: "search_open", engine: search.engine, query: search.query, nth, play: /play|watch|start/.test(verb) || search.engine === "youtube" };
    }
  }
  // "play lo-fi beats on YouTube", "watch the Sydney FC highlights on youtube": a search and the first video.
  m = l.match(/^(?:play|watch|put on)\s+(?:some\s+)?(.{2,100}?)\s+on\s+youtube$/);
  if (m) return { kind: "search_open", engine: "youtube", query: u.slice(l.indexOf(m[1]), l.indexOf(m[1]) + m[1].length).replace(/^(?:some|any)\s+/i, ""), nth: 1, play: true };

  // 2. Go back and open the next one; open the second result.
  m = l.match(NTH_BACK);
  if (m && /\b(?:next|another|other|second|third|fourth|fifth|1st|2nd|3rd)\b|#\d|number\s+\d/i.test(l.replace(/^(?:go\s+)?back\b/, ""))) return { kind: "open_nth", nth: ordinalOf(m[1]) ?? "next", back: true };
  m = l.match(NTH_NUMBERED);
  if (m) return { kind: "open_nth", nth: ordinalOf(m[1]) ?? 1, back: false };
  m = l.match(NTH_ALONE);
  if (m && (m[1] || /\b(?:result|link|video|hit|listing)s?$/.test(l))) {
    // "open one" / "click it" are not a result: an ordinal, or a noun that names one.
    return { kind: "open_nth", nth: ordinalOf(m[1]) ?? 1, back: false };
  }

  // 3. Gmail: open it and search its box.
  m = l.match(/^(?:open|go to|check|pull up|bring up)\s+(?:up\s+)?(?:my\s+)?g ?mail(?:\s+inbox)?\s*(?:,|and|then)?\s*(?:and\s+|then\s+)?(?:search|look|find)(?:\s+(?:for|up))?\s+(?:for\s+)?(.{1,100})$/)
    ?? l.match(/^(?:search|look up|find)\s+(?:my\s+)?g ?mail\s+(?:for\s+)?(.{1,100})$/)
    ?? l.match(/^(?:search|look up|find)\s+(?:for\s+)?(.{1,100}?)\s+(?:in|on)\s+(?:my\s+)?g ?mail$/);
  if (m) {
    const query = u.slice(l.indexOf(m[1]), l.indexOf(m[1]) + m[1].length).replace(/^(?:for\s+)?(?:any\s+)?(?:emails?\s+)?/i, "").trim();
    if (query && !/^(?:and|then)\b/i.test(query)) return { kind: "gmail_search", query };
  }

  // 4. Fill a form and stop before the button.
  m = l.match(new RegExp(`^(?:${SITE_HEAD}\\s+(.+?)\\s+(?:and|then)\\s+)?fill\\s+(?:in\\s+|out\\s+)?(?:the\\s+)?(?:contact\\s+|enquiry\\s+|inquiry\\s+)?form(?:\\s+(?:on|at|for)\\s+(.+?))?\\s+(?:with|using)\\s+(?:my\\s+)?(name and email|name and phone|email and phone|name,?\\s*email,?\\s*(?:and\\s+)?phone|name|email|phone|details|contact details|info|information)(?:\\s*(?:,|and)?\\s*(?:but\\s+)?(?:(?:don't|do not|dont|without|never)\\s+(?:send|submit|press|sending|submitting|pressing)(?:\\s+it)?|leave it unsent|stop before (?:the )?(?:send|submit)(?: button)?))?$`));
  if (m) {
    const siteWords = m[1] ?? m[2];
    const site = siteWords ? resolveSite(siteWords) : null;
    if (!siteWords || site) {
      const w = m[3];
      const wants = /details|info/.test(w) ? "all" : ([/name/.test(w) ? ["first_name", "full_name", "last_name"] : [], /email/.test(w) ? ["email"] : [], /phone/.test(w) ? ["phone"] : []].flat() as string[]);
      return { kind: "fill_form", site, wants };
    }
  }

  // 5. Read the footer.
  if (/^(?:scroll\s+(?:down\s+)?to\s+the\s+(?:bottom|end)(?:\s+of\s+(?:the|this)\s+page)?\s*(?:,|and|then)\s*(?:and\s+|then\s+)?(?:read|tell me|what(?:'s| is))\s+(?:me\s+)?(?:what\s+)?(?:the\s+)?footer(?:\s+says)?|(?:read|tell me|what(?:'s| is)|what does)\s+(?:me\s+)?(?:what\s+)?the\s+footer(?:\s+say|\s+says)?)$/.test(l)) return { kind: "read_footer", site: null };
  m = l.match(new RegExp(`^${SITE_HEAD}\\s+(.+?)\\s*(?:,|and|then)\\s*(?:and\\s+|then\\s+)?scroll\\s+(?:down\\s+)?to\\s+the\\s+(?:bottom|end)(?:\\s+of\\s+the\\s+page)?\\s*(?:,|and|then)\\s*(?:and\\s+|then\\s+)?(?:read|tell me)\\s+(?:me\\s+)?the\\s+footer$`));
  if (m) {
    const site = resolveSite(m[1]);
    if (site) return { kind: "read_footer", site };
  }

  // 6. The top story's headline.
  m = l.match(/^(?:read|tell|give)\s+me\s+(?:the\s+)?(?:top\s+)?(?:headline|story)(?:s)?(?:\s+of\s+the\s+top\s+story)?(?:\s+(?:on|from|at|of)\s+(.+))?$/)
    ?? l.match(/^what(?:'s| is)\s+(?:the\s+)?(?:top\s+(?:story|headline)|headline)(?:\s+of\s+the\s+top\s+story)?(?:\s+(?:on|from|at)\s+(.+))?$/);
  if (m) {
    const site = m[1] ? resolveSite(m[1]) : null;
    if (!m[1] || site) return { kind: "read_headline", site };
  }

  // 7. The Contact page and a phone number, email or address.
  const what = (w: string): "phone" | "email" | "address" => (/email/.test(w) ? "email" : /address/.test(w) ? "address" : "phone");
  let whatFirst = false;
  m = l.match(/^open\s+(?:the\s+)?contact(?:\s+us)?(?:\s+page)?(?:\s+(?:on|of|for|at)\s+(.+?))?\s*(?:,|and|then)\s*(?:and\s+|then\s+)?(?:read|tell|give)\s+(?:me\s+)?(?:the\s+)?(phone(?:\s+number)?|number|email(?:\s+address)?|address)$/)
    ?? l.match(new RegExp(`^${SITE_HEAD}\\s+(.+?)\\s+(?:and|then)\\s+(?:open|find|go to)\\s+(?:the\\s+)?contact(?:\\s+us)?(?:\\s+page)?\\s*(?:,|and|then)\\s*(?:and\\s+|then\\s+)?(?:read|tell|give)\\s+(?:me\\s+)?(?:the\\s+)?(phone(?:\\s+number)?|number|email(?:\\s+address)?|address)$`))
    ?? ((whatFirst = true), l.match(/^(?:what(?:'s| is)|find|get|read me|tell me)\s+(?:the\s+)?(phone(?:\s+number)?|email(?:\s+address)?)\s+(?:on|of|for|at)\s+(.+)$/));
  if (m) {
    // (Two of the three grammars say the site first and the thing after; "what's the phone number on X" the other way round.)
    const siteWords = whatFirst ? m[2] : m[1];
    const w = whatFirst ? m[1] : m[2];
    const thePage = siteWords && /^(?:the\s+|this\s+)?contact(?:\s+us)?\s+page$/.test(siteWords);
    const site = siteWords && !thePage ? resolveSite(siteWords) : null;
    if (!siteWords || thePage || site) return { kind: "contact_read", site, what: what(w) };
  }

  // 8. A named site, then a link or a page on it.
  m = l.match(new RegExp(`^${SITE_HEAD}\\s+(.+?)\\s+(?:and|then)\\s+(?:find|open|show me|go to|take me to)\\s+(?:the\\s+)?(${PAGE_WORDS})(?:\\s+page)?$`));
  if (m) {
    const site = resolveSite(m[1]);
    const page = pageKind(m[2]);
    if (site && page) return { kind: "find_page", site, page };
  }
  m = l.match(new RegExp(`^(?:find|show me|open|go to|take me to|get me to|look for)\\s+(?:me\\s+)?(?:the\\s+)?(${PAGE_WORDS})\\s+page\\s+(?:on|of|for|at|in)\\s+(.+)$`))
    ?? l.match(new RegExp(`^(?:show me|find|open|go to)\\s+(.+?)'s\\s+(${PAGE_WORDS})\\s+page$`));
  if (m) {
    const swap = pageKind(m[1]) === null;
    const site = resolveSite(swap ? m[1] : m[2]);
    const page = pageKind(swap ? m[2] : m[1]);
    if (site && page) return { kind: "find_page", site, page };
  }
  // "find the pricing page" (the page in front is the site): only the word "find", so "open pricing" stays the OS's own page.
  m = l.match(new RegExp(`^find\\s+(?:me\\s+)?(?:the\\s+)?(${PAGE_WORDS})\\s+page$`));
  if (m && pageKind(m[1])) return { kind: "find_page", site: null, page: pageKind(m[1])! };
  m = u.match(new RegExp(`^${SITE_HEAD}\\s+(.+?)\\s+(?:and|then)\\s+(?:click|open|press|tap|hit|select|choose)(?:\\s+on)?\\s+(?:the\\s+)?["“']?(.{2,60}?)["”']?(?:\\s+(?:link|button|tab|page|menu|item))?$`, "i"));
  if (m && !finalButtonText(m[2]) && !/^(?:it|that|this|here|there)$/i.test(m[2]) && !ordinalOf(m[2].split(/\s+/)[0])) {
    const site = resolveSite(m[1]);
    if (site) return { kind: "site_click", site, label: m[2].trim() };
  }
  return null;
}

/**
 * A goal sentence → the browser-skill request that runs it, or null. `task` opens something itself (a search, a site);
 * `task_here` acts on the page already in front (Jarvis Chrome must be what he's looking at).
 */
export function browserTaskIntent(utterance: string): BrowserSkillRequest | null {
  const u = cleanUtterance(utterance);
  const shape = parseTaskGoal(u);
  if (!shape) return null;
  return { skill: "browser", action: opensItself(shape) ? "task" : "task_here", goal: u.slice(0, 200) };
}
