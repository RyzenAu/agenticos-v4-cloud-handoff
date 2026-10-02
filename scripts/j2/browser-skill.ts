// J2: one browser-skill request → the agent-browser hands in Jarvis Chrome → the window brought forward on his main
// screen → one line that says what happened and WHERE ("Opened muventures.com.au in Chrome on your main screen.").
import type { BrowserHands } from "./agent-browser";
import type { BrowserSkillRequest } from "./intents";
import { rememberReferent } from "../jarvis-skills/referent";
import { openedWhereLine } from "../jarvis-skills/windows";
import { HIDDEN_NOTE, INJECTED_NOTE, READ_KEPT, safePageText, safeTitle } from "./page-redact";

export type BrowserSkillDeps = {
  hands: BrowserHands;
  /** Bring Jarvis Chrome's window (the referent) to the front on his main screen; the window skill's line. */
  present: () => Promise<string | null>;
  /** Start Jarvis Chrome when it isn't running (the launcher); true when its DevTools port answers. */
  ensure?: () => Promise<boolean>;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
};
const sentences = (text: string, max = 320) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.slice(0, max);
  const end = cut.lastIndexOf(". ");
  return (end > 80 ? cut.slice(0, end + 1) : cut).trim();
};

/** One browser-skill answer: `said` is the line spoken; `keep`, when set, is what the conversation history stores instead. */
export type BrowserSkillOutcome = { said: string; keep?: string };

export async function runBrowserSkill(req: BrowserSkillRequest, deps: BrowserSkillDeps): Promise<string> {
  return (await runBrowserSkillDetailed(req, deps)).said;
}

/** The page's text as it may be spoken: secrets and instructions aimed at an assistant taken out first (J3). */
function readAloud(p: { title: string; url: string; text: string }): BrowserSkillOutcome {
  const title = safeTitle(p.title).slice(0, 80) || "untitled";
  const rest = p.title && p.text.startsWith(p.title) ? p.text.slice(p.title.length) : p.text;
  const safe = safePageText(rest);
  const where = p.url ? ` (${hostOf(p.url)})` : "";
  const notes = [safe.hidden ? HIDDEN_NOTE : "", safe.injected ? INJECTED_NOTE : ""].filter(Boolean).join(" ");
  // Cut to a speakable length AFTER the redaction, never mid-marker.
  const gist = sentences(safe.text).replace(/\[[^\]]*$/, "").trim();
  const onlyHidden = !gist.replace(/\[hidden\]/g, "").replace(/[\s.,;:!?-]+/g, "");
  if (!gist)
    return { said: `This page is "${title}"${where}, and there's no text on it to read.`, keep: READ_KEPT };
  if (onlyHidden)
    return { said: `This page is "${title}"${where}. Everything readable on it looked sensitive, so I haven't read it out. ${notes}`.trim(), keep: READ_KEPT };
  return { said: `This page is "${title}"${where}. It says: ${gist}${notes ? ` ${notes}` : ""}`, keep: READ_KEPT };
}

export async function runBrowserSkillDetailed(req: BrowserSkillRequest, deps: BrowserSkillDeps): Promise<BrowserSkillOutcome> {
  if (req.action === "read") return readAloudNow(deps.hands);
  return { said: await runBrowserSkillPlain(req, deps) };
}

async function runBrowserSkillPlain(req: BrowserSkillRequest, deps: BrowserSkillDeps): Promise<string> {
  const { hands } = deps;
  /** Open in a new Jarvis Chrome tab (starting Jarvis Chrome once if it isn't up), remember it, bring it forward. */
  const openHere = async (url: string, label: string, done: (where: string) => string) => {
    // Check/start the controllable browser before sending navigation. A daemon may
    // report a generic timeout instead of ECONNREFUSED when Chrome is absent.
    if (deps.ensure && !(await hands.tabs()).length && !(await deps.ensure().catch(() => false))) return "The browser didn't open it: I couldn't connect to Jarvis Chrome. Your ordinary Chrome window may still be open.";
    const r = await hands.open(url, "new-tab");
    if (!r.ok) return r.said;
    rememberReferent({ app: "chrome", jarvisChrome: true, title: label, ...(r.targetId ? { targetId: r.targetId } : {}) });
    if (r.targetId) await hands.activate(r.targetId);
    const placed = await deps.present().catch(() => null);
    const line = openedWhereLine(label, placed);
    const where = line.match(/^Opened .+? in Chrome on (.+)\.$/)?.[1];
    return where ? done(where) : line;
  };
  switch (req.action) {
    case "open": {
      const url = String(req.url ?? "");
      const label = String(req.name ?? "").trim().slice(0, 60) || hostOf(url);
      return openHere(url, label, (where) => `Opened ${label} in Chrome on ${where}.`);
    }
    case "open_chrome": {
      // Jarvis Chrome up (started if it isn't), its front tab activated (a blank one when it has none), on his main screen.
      let tabs = await hands.tabs();
      if (!tabs.length && deps.ensure && (await deps.ensure())) tabs = await hands.tabs();
      if (!tabs.length) return openHere("chrome://newtab/", "Chrome", (where) => `Opened Chrome on ${where}.`);
      const front = tabs.find((t) => t.active) ?? tabs[0];
      rememberReferent({ app: "chrome", jarvisChrome: true, title: front.title.slice(0, 80), targetId: front.targetId });
      await hands.activate(front.targetId);
      const placed = await deps.present().catch(() => null);
      const where = openedWhereLine("Chrome", placed).match(/^Opened .+? in Chrome on (.+)\.$/)?.[1];
      return where ? `Opened Chrome on ${where}.` : openedWhereLine("Chrome", placed);
    }
    case "new_tab":
      return openHere("chrome://newtab/", "a new tab", (where) => `Opened a new tab in Chrome on ${where}.`);
    case "search": {
      const words = String(req.query ?? "").trim().slice(0, 200);
      if (!words) return "Search for what, sir?";
      const youtube = req.engine === "youtube";
      const url = youtube ? `https://www.youtube.com/results?search_query=${encodeURIComponent(words)}` : `https://www.google.com/search?q=${encodeURIComponent(words)}`;
      // The voice turn continues an explicitly requested first-result step through screen_act.
      // This result reports only the search; it does not claim the result has been opened.
      return openHere(url, youtube ? "YouTube" : "Google", (where) => `Searched ${youtube ? "YouTube" : "Google"} for "${words}" in Chrome on ${where}.`);
    }
    case "back":
      return (await hands.back()).said;
    case "forward":
      return (await hands.forward()).said;
    case "reload":
      return (await hands.reload()).said;
    case "close_tab":
      return (await hands.closeTab()).said;
    case "scroll":
      return (await hands.scroll(req.dir === "up" ? "up" : "down")).said;
    case "read":
      return (await readAloudNow(hands)).said;
    case "click":
      return (await hands.click(String(req.target ?? ""))).said;
  }
}

async function readAloudNow(hands: BrowserHands): Promise<BrowserSkillOutcome> {
  const p = await hands.read();
  return p.ok ? readAloud(p) : { said: p.said ?? "I couldn't read the page." };
}
