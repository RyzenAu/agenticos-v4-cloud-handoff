// Hard refusals for screen control, in code and independent of any model: Jev may be sure of a click,
// but these never run whatever it decides and whatever the approval.
//
//  - money movement and trading (transfers, payments, PayID/BPAY/Osko, payees, withdrawals, deposits,
//    share or crypto trades and sends) and any task naming a bank, broker, exchange or payment app:
//    the owner's rule is "never execute a trade or transfer";
//  - a window or page that IS a bank, broker, exchange or payment screen (its title or URL says so),
//    checked before the run AND before every step (runScreenAct's perform): nothing is clicked,
//    typed or pressed there;
//  - secret-bearing files and private data (the same patterns as control_pc, audit A-H2).
//
// The lists live in ONE place, src/lib/control-risk.ts (moneyRefusal, moneySurfaceRefusal), shared with
// control_pc, lessons, the app browser and away mode (27 Sep night: the three copies had drifted).
//
// Deliberately NOT here: "send", "pay", "delete", "publish", "submit" and account settings on an
// ordinary window. Those are final buttons: vetAction asks for his spoken yes (bound to the voice
// pipeline's server-side event), and they run only after it. Pure.
import { moneyRefusal, moneySurfaceRefusal, PRIVATE_DATA, SECRET_BEARING } from "../../src/lib/control-risk";

export type ScreenRefusal = { kind: "money-or-trading" | "bank-broker-or-exchange" | "secret-or-private-data"; said: string };

const SAID: Record<ScreenRefusal["kind"], string> = {
  "money-or-trading": "I don't move money, pay or trade, whatever the approval: transfers, payments, PayID, BPAY, payees and share or crypto trades are yours to do yourself. Nothing was touched.",
  "bank-broker-or-exchange": "That's a bank, broker, exchange or payment service, and I never drive those, whatever the approval. It's yours to do yourself. Nothing was touched.",
  "secret-or-private-data": "That names a secret-bearing file or private data, which I never open, read or type. Nothing was touched.",
};

/** His goal → a hard refusal, or null. Pure. */
export function screenGoalRefusal(goal: string): ScreenRefusal | null {
  const text = String(goal ?? "");
  if (SECRET_BEARING.test(text) || PRIVATE_DATA.test(text)) return { kind: "secret-or-private-data", said: SAID["secret-or-private-data"] };
  const money = moneyRefusal(text);
  return money ? { kind: money.kind, said: SAID[money.kind] } : null;
}

/**
 * A goal that is really window focus or "go somewhere" ("focus muventures.com", "bring up the MU Ventures site",
 * "show me Chrome", "switch to Spotify", "go to example.com"), with no concrete control to act on: screen hands
 * never explores its way there (J-fix, 29 Sep: "focus muventures.com" typed in Windows Search, then clicked
 * through YouTube results about another company). The line to say instead, or null. Pure.
 */
export const VAGUE_GOAL_LINE =
  "That's about bringing a window or site forward, not something to press, so I haven't touched your screen. Say \"bring it up\" or name the app, and I'll bring its window to the front; or tell me exactly what to click.";
const CONCRETE = /\b(?:click|press|tap|type|write|enter|fill|select|choose|tick|untick|check|uncheck|toggle|scroll|drag|drop|paste|copy|save|close|play|pause|mute|expand|collapse)\b/i;
const PLACE_OBJECT = /(?:\b[a-z0-9-]+\.(?:com|au|net|org|io|ai|dev|app|co)\b|\b(?:site|website|web site|browser window|chrome|edge|firefox)\b|^(?:it|that|this)$)/i;
export function vagueScreenGoal(goal: string): string | null {
  const g = String(goal ?? "").trim().replace(/^(?:please\s+|can you\s+|could you\s+)/i, "").replace(/[.!?]+$/, "");
  if (!g || CONCRETE.test(g)) return null;
  // Window focus, whatever it names.
  if (/^(?:focus(?: on)?|bring\b|pull up|pop up|put .+ (?:on|onto) (?:my|the) (?:\w+ )?screen|switch (?:over |back )?to|alt tab to|restore|unminimi[sz]e|maximi[sz]e)\b/i.test(g)) return VAGUE_GOAL_LINE;
  // "Show me / go to / open / find <a site, tab, window or app>": navigation, not a control on the page.
  const m = g.match(/^(?:show(?: me)?|go to|navigate to|head to|find|open(?: up)?|visit|load)\s+(.+)$/i);
  return m && PLACE_OBJECT.test(m[1].replace(/^(?:the|my|our|a|an)\s+/i, "")) ? VAGUE_GOAL_LINE : null;
}

/** Clicks the planner may explore (clicks it chose itself, beyond his named steps) before it stops and asks. */
export const MAX_EXPLORE_CLICKS = 3;
const RESULT_LIKE = /\s[-–|·]\s(?:youtube|google search|bing|wikipedia|linkedin|facebook|instagram|x|twitter|reddit)\b|\b(?:\d[\d,.]*\s*[kmb]?\s*views|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|search results?|sponsored|playlist|shorts?)\b|\bon th(?:e|…)|…$/i;
const STOP = new Set(["the", "a", "an", "to", "of", "on", "in", "and", "my", "our", "for", "with", "at", "is", "it", "this", "that", "please", "go", "open", "click", "find", "show", "me", "up", "com", "au", "www", "https", "http"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
/**
 * A click that drifts off the goal: a search result, video or feed item whose words share nothing with what he
 * asked for (J-fix: "focus muventures.com" clicked "Gary Benerofe, GP at Mu Ventures, on th…" on YouTube).
 * Only result-like controls are judged; ordinary buttons and fields are never blocked here. Pure.
 */
export function driftClick(goal: string, element: { type: string; name: string }): boolean {
  const label = String(element.name ?? "");
  const resultLike = RESULT_LIKE.test(label) || (/^(?:ListItem|DataItem|TreeItem)$/.test(element.type) && label.length > 40);
  if (!resultLike) return false;
  const want = new Set(words(goal));
  if (!want.size) return true;
  // Whole-goal match only: a result naming "Mu Ventures" doesn't match "muventures.com.au" unless the
  // label carries the goal's own distinctive word.
  return !words(label).some((w) => want.has(w));
}

/**
 * The window he'd have Jarvis act in is a bank, broker, exchange or payment screen (title or URL). Pure.
 * `process`: a local statement file open in Acrobat, Excel, Word or Notepad ("NAB statement.pdf - Adobe
 * Acrobat Reader") is a document, not a bank screen (REVIEW-SAFETY-R3 §2 carve-out 1); in a browser it isn't.
 */
export function moneyWindowRefusal(title: string, url?: string | null, process?: string | null): ScreenRefusal | null {
  return moneySurfaceRefusal({ title, url, process }) ? { kind: "bank-broker-or-exchange", said: SAID["bank-broker-or-exchange"] } : null;
}

/** The browser's own address bar in a UIA snapshot: its value is the page's URL. Pure. */
const ADDRESS_BAR = /address and search bar|address bar|search or enter address|search with .* or enter address|search or type a url|url bar|location/i;
export function addressBarUrl(elements: ReadonlyArray<{ type: string; name: string; aid?: string; value: string; web?: boolean }> | null | undefined): string | null {
  for (const e of elements ?? []) {
    if (e.web === true || !["Edit", "ComboBox", "Text"].includes(e.type)) continue;
    if (ADDRESS_BAR.test(`${e.name} ${e.aid ?? ""}`) && e.value.trim()) return e.value.trim().slice(0, 500);
  }
  return null;
}
