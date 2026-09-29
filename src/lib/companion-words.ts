/**
 * The words of the Jarvis cursor as a companion (after Clicky, docs/CLICKY-COMPARISON.md), shared
 * by the server's rules (scripts/free-voice.ts) and the voice client. Pure.
 *
 * - pointIntent: a one-shot question about what's on his screen, answered by pointing ("where's the
 *   export button?", "what does this do?"): no lesson, no clicking.
 * - tutorIntent: switch the proactive tutor on or off ("watch me and help if I get stuck"). It is
 *   opt-in and off by default.
 */
import { tidyWords } from "./lesson-words";

export type PointIntent = { question: string; kind: "find" | "this"; target?: string };

/** Words that say "a thing on my screen" rather than a place or a fact. */
const SCREEN_THING =
  /\b(?:button|buttons|menu|menus|icon|icons|tab|tabs|link|links|option|options|setting|settings|field|box|toggle|switch|bar|panel|pane|checkbox|tick ?box|drop ?down|slider|arrow|symbol|logo|search box|address bar|toolbar|sidebar|scroll ?bar)\b/i;
const ON_SCREEN = /\b(?:on (?:my|the|this) (?:screen|page|window)|on here|in here|here|in this (?:app|window|page)|on this)\s*$/i;

const FIND: RegExp[] = [
  /^where(?:'s| is| are| r)(?: the| my| that)? (.+?)\??$/i,
  /^(?:can you )?(?:point|show) me (?:to |at )?(?:where )?(?:the |my )?(.+?)(?: is| are)?\??$/i,
  /^point (?:to|at|out) (?:the |my )?(.+?)\??$/i,
  /^(?:which|what) (?:one|button|icon|thing|bit) is (?:the |my )?(.+?)\??$/i,
  /^(?:can you )?find (?:the |my )?(.+?)(?: for me)?\??$/i,
  /^i can'?t (?:find|see) (?:the |my )?(.+?)\??$/i,
  // "What does the dark mode switch do?": point at it now, explain as it lands.
  /^what (?:does|do|is) (?:the |that )(.+?) (?:do|for)\??$/i,
];
const THIS: RegExp[] = [
  // "What does this panel do?", "what's this section for?": a region, explained from the pixels
  // around his pointer when he has allowed a look (point.ts REGION).
  /^what(?:'s| is| does) (?:this|that) (?:panel|pane|section|area|sidebar|side bar|toolbar|tool bar|window|view|part|bit of the screen|box|strip|ribbon|timeline|inspector|palette)(?: (?:do|does|for|mean))?(?: here)?\??$/i,
  /^what (?:does|do) (?:this|that) (?:panel|pane|section|area|sidebar|toolbar|window|view|part|ribbon|timeline|inspector|palette) (?:do|show|mean)\??$/i,
  /^what(?:'s| is| does) (?:this|that)(?: (?:button|icon|thing|option|setting|menu|tab|link|one|bit|symbol|box|toggle|switch))?(?: (?:do|does|mean|for))?(?: here)?\??$/i,
  /^what (?:does|do) (?:this|that)(?: (?:button|icon|thing|option|setting|menu|tab|link|one|bit|symbol|box|toggle|switch))? (?:do|mean)\??$/i,
  /^what am i (?:pointing at|hovering (?:on|over)|on)\??$/i,
  /^what(?:'s| is) (?:under|at) my (?:mouse|cursor|pointer)\??$/i,
  /^(?:should i|do i) (?:click|press|tick|pick) (?:this|that)(?: one)?\??$/i,
];

/**
 * "Where's the export button?" → find; "what does this do?" → the thing under his pointer.
 * A find needs an on-screen word (a button, a menu, "here"), so "where is Sydney" or "where are my
 * downloads" stay with the brain and pc_act. Lesson phrases ("show me how to", "show me where to")
 * are checked first by the caller. Pure.
 */
export function pointIntent(utterance: string): PointIntent | null {
  const u = tidyWords(utterance).replace(/[’`]/g, "'");
  if (!u || u.length > 160) return null;
  if (/^(?:show me (?:how|where (?:to|i))|how do i|teach me|walk me)/i.test(u)) return null;
  for (const re of THIS) if (re.test(u)) return { question: utterance.trim().slice(0, 300), kind: "this" };
  for (const re of FIND) {
    const m = u.match(re);
    if (!m) continue;
    const target = m[1].replace(ON_SCREEN, "").replace(/[?.!]+$/, "").replace(/\s+(?:is|are)$/i, "").trim();
    if (target.length < 2 || target.length > 80) return null;
    // A thing on the screen, not a place, a person or a folder.
    if (!SCREEN_THING.test(m[1]) && !ON_SCREEN.test(m[1]) && !/^point\b/i.test(u)) return null;
    if (/\b(?:downloads?|documents|desktop|pictures|photos|music|videos) folder\b|\bmy (?:keys|phone|wallet)\b/i.test(target)) return null;
    return { question: utterance.trim().slice(0, 300), kind: "find", target };
  }
  return null;
}

/** "Watch me and help if I get stuck" → on; "stop watching me" → off. Pure. */
export function tutorIntent(utterance: string): { on: boolean } | null {
  const u = tidyWords(utterance).toLowerCase().replace(/[’`]/g, "'");
  if (!u || u.length > 120) return null;
  if (/^(?:turn |switch )?(?:the )?(?:tutor|coach|teacher|companion)(?: mode)? (?:off|stop)$|^(?:turn|switch) off (?:the )?(?:tutor|coach|companion)(?: mode)?$|^stop (?:watching|tutoring|coaching)(?: me| my screen| what i'?m doing)?$|^(?:you can )?stop keeping an eye on (?:me|my screen)$|^no more tips$/.test(u))
    return { on: false };
  if (
    /^(?:turn |switch )?(?:the )?(?:tutor|coach|companion) mode(?: on)?$|^(?:tutor|coach|companion)(?: mode)? on$|^(?:turn|switch) on (?:the )?(?:tutor|coach|companion)(?: mode)?$|^(?:watch|keep an eye on) (?:me|my screen|what i'?m doing)(?: and (?:help|tell|jump in|chip in).*)?$|^(?:help|tell) me (?:if|when) i (?:get|am|'m) stuck$|^(?:be my|act as my) (?:tutor|coach)$/.test(
      u,
    )
  )
    return { on: true };
  return null;
}
