// Window management: show the desktop, restore it, switch to an app's window, maximise, minimise
// and snap the window in front; bring an app's window up (minimised or not) on the screen he names,
// move it between screens, and say which screen it's on. Win32 through the warm helper (user32:
// EnumWindows, SetForegroundWindow, ShowWindow, SetWindowPos, EnumDisplayMonitors). Nothing is
// clicked, typed or closed, so nothing can be lost.
import { norm } from "./text";
import { similarity } from "./fuzzy";
import { unb64, type PsHost } from "./ps-host";
import { currentReferent, isJarvisOwnWindow, rememberReferent } from "./referent";
import { isOn, monitorOf, parseMonitors, parseWindowState, pickMonitor, placeRect, screenLabel, type Monitor, type ScreenName } from "./monitors";

export type WindowAction = "show_desktop" | "restore_all" | "switch" | "maximise" | "minimise" | "restore" | "snap_left" | "snap_right" | "bring" | "move" | "where" | "open_tab";
/** `target` "front": the window he last had Jarvis place (else the one in front). `screen`: the one he named. */
export type WindowRequest = { skill: "window"; action: WindowAction; target?: string; screen?: ScreenName };
export type WindowInfo = { handle: number; process: string; cls: string; title: string };

/** OS pages and routines: "switch to the inbox" or "switch to call mode" aren't windows. */
const NOT_WINDOWS = new Set([
  "inbox", "calendar", "memory", "business", "chat", "design", "websites", "website", "code graph", "codegraph", "hermes",
  "leads", "crm", "automations", "dashboard", "mission control", "jarvis", "the os", "settings page", "home", "tasks",
]);

// --- bringing a window up, and his screens ---------------------------------------------------------
/** "no, …" / "not that, …": a correction lead-in in front of the real command. */
const CORRECTION_LEAD = /^\s*(?:(?:no|nope|nah|not that(?: one)?|not there|wrong one)[,\s]+)+/i;
/** "main screen", "my other monitor", "the left display", "front screen": the screen he means. */
const SCREEN_WORD = "(main|primary|front|first|big|middle|centre|center|other|second|secondary|2nd|left hand|left|right hand|right|top|upper|bottom|lower|third|3rd) (?:screen|monitor|display)";
const SCREEN_PHRASE = new RegExp(`(?:^| )(?:(?:on|to|onto|in|into|over to|across to|across onto) )?(?:(?:my|the|this) )?${SCREEN_WORD}(?= |$)`);
export function screenName(word: string): ScreenName {
  if (/^(?:other|second|secondary|2nd)$/.test(word)) return "other";
  if (/^left/.test(word)) return "left";
  if (/^right/.test(word)) return "right";
  if (/^(?:top|upper)$/.test(word)) return "top";
  if (/^(?:bottom|lower)$/.test(word)) return "bottom";
  if (/^(?:third|3rd)$/.test(word)) return "third";
  return "main";
}
const TARGET_TAIL = / (?:browser|app|application|window|windows|program|tab|tabs)$/;
const IT = /^(?:it|this|that|this one|that one|this window|that window|the window|the current window|the one in front)$/;
/** Words that make it a job inside a window (a click, typing, playing), never window management. */
const INSIDE_WORDS = /\b(?:click|tap|press|type|fill|scroll|select|search|log ?in|sign ?in|play|pause|message|email|write|close|delete)\b/;
function cleanTarget(raw: string): string | null {
  const whole = raw.trim();
  if (IT.test(whole)) return "front";
  let t = whole.replace(/^(?:the|my|that|this|our) /, "").replace(TARGET_TAIL, "").trim();
  if (IT.test(t)) return "front";
  if (!t || /^(?:tab|browser|web browser|internet)$/.test(t)) t = /\b(?:tab|browser|internet)\b/.test(whole) ? "browser" : t;
  if (!t || t.split(" ").length > 4 || NOT_WINDOWS.has(t) || /\b(?:meeting|appointment|event|file|files|folder|email|message|call|song|video|mode|page|screen|monitor|display|windows)\b/.test(t)) return null;
  return t;
}
/** An app named anywhere in a longer request ("open my Chrome tab? It's not showing on my front screen"). */
function namedApp(u: string): string | null {
  const names = Object.keys(PROCESS_ALIASES).sort((a, b) => b.length - a.length);
  for (const n of names) if (new RegExp(`(?:^| )${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(u)) return n;
  return /\b(?:tab|browser)\b/.test(u) ? "browser" : null;
}

/**
 * The app a screen task says it's for ("show my bookmarks in Chrome", "type milk into Notepad"),
 * and whether a window belongs to it. 25 Sep: "show my bookmarks in Chrome" ran on the Claude app
 * in front and switched on its Browser button. Only "in / into / on <app>" counts, so "click the
 * Code tab" names nothing.
 */
export function appNamedIn(text: string): string | null {
  const u = ` ${clean(text)} `;
  const names = Object.keys(PROCESS_ALIASES).filter((n) => !/^(?:browser|web browser|code|files|word|settings|terminal|explorer|teams)$/.test(n)).sort((a, b) => b.length - a.length);
  for (const n of names) if (new RegExp(` (?:in|into|on|using) (?:my |the )?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `).test(u)) return n;
  return null;
}
export function windowIsApp(app: string, process: string): boolean {
  const key = app.toLowerCase().trim();
  const procs = PROCESS_ALIASES[key] ?? [key.replace(/ /g, "")];
  return procs.includes(process.toLowerCase());
}

/**
 * Window management by name and screen (25 Sep: "bring the Chrome browser up on my main screen"
 * went to the screen loop, which clicked around a Chrome window on his other monitor). "bring up /
 * show / restore / switch to <app>" with a screen, "put <app> on my main / other / left / right
 * screen", "move it to my other screen", "which screen is that on". A longer request counts only
 * when it names a screen and an app, and nothing in it is a click or typing.
 */
/** Jarvis Chrome may be on a screen he isn't looking at: bringing it up puts it on his main screen. */
const chromeMain = (target: string): ScreenName | undefined => (/^(?:chrome|google chrome|browser)$/.test(target) ? "main" : undefined);
export function windowPlaceIntent(utterance: string): WindowRequest | null {
  // "right now" goes before norm(), which drops a last "now" and would leave "right" (a screen).
  const corrected = CORRECTION_LEAD.test(utterance);
  const u = norm(utterance.replace(/\b(?:right now|real quick|right away)\b/gi, " ").replace(CORRECTION_LEAD, ""))
    .replace(/[?!.;:]+/g, " ")
    .replace(/(?:^| )(?:quickly|please|for me)(?= |$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!u || u.length > 160 || INSIDE_WORDS.test(u)) return null;
  const q = (action: WindowAction, target: string, screen?: ScreenName): WindowRequest => ({ skill: "window", action, target, ...(screen ? { screen } : {}) });
  // "Not that, the left screen" / "no, the other monitor": he's correcting where Jarvis put the window it just placed (J4).
  if (corrected) {
    const fix = u.match(/^(?:(?:on|to|onto) )?(?:(?:the|my) )?(main|primary|front|left|right|top|upper|bottom|lower|other|second|secondary) (?:one|screen|monitor|display)$/);
    if (fix) return q("move", "front", screenName(fix[1]));
  }
  // "which screen is Chrome on", "what monitor is that on", "where's my Notepad window".
  let m = u.match(/^(?:which|what) (?:screen|monitor|display) (?:is|'s) (.+?) (?:on|in)$|^(?:which|what) (?:screen|monitor|display)'s (.+?) (?:on|in)$|^where(?: is|'s) (?:the |my )?(.+?) window$/);
  if (m) {
    const target = cleanTarget(m[1] ?? m[2] ?? m[3] ?? "");
    if (target) return q("where", target);
  }
  // A named screen, else a plain "on my screen" (J-fix: "bring up Chrome on my screen" went to the share tool):
  // with one screen or several, that's the main one.
  const screenAt = u.match(SCREEN_PHRASE) ?? u.match(/(?:^| )(?:on|to|onto) (?:my|the) screen(?= |$)/);
  const screen = screenAt ? (screenAt[1] ? screenName(screenAt[1]) : "main") : undefined;
  const frontScreen = /\bin front of (?:my|the) screen\b|\bfront screen\b/.test(u);
  const rest = screenAt ? `${u.slice(0, screenAt.index)} ${u.slice((screenAt.index ?? 0) + screenAt[0].length)}` : u;
  const core = rest.replace(/\b(?:in front of (?:me|my screen|the screen)|to the front|up front|in front|to the foreground)\b/g, " ").replace(/\s+/g, " ").trim();
  const lifted = /\b(?:up|back|forward)\b/.test(core) || /\b(?:in front|to the front|up front|to the foreground)\b/.test(u);
  const where = screen ?? (frontScreen ? "main" : undefined);
  // "Can you open a Chrome tab for me?": a tab in Jarvis Chrome, put on his main screen (or the one he
  // named) and in front, and said where (J-fix: it opened somewhere he couldn't see, and said nothing).
  if (/^(?:open|start|launch|pull up|bring up|give me|get me)(?: me)?(?: up)? (?:a |another |one )?(?:new |fresh |blank )?(?:(?:google )?chrome|browser) (?:tab|window)(?: up)?$|^open (?:a |another )?(?:new )?tab (?:in|on) (?:google )?chrome$/.test(core))
    return { skill: "window", action: "open_tab", screen: where ?? "main" };
  m = core.match(/^(bring|get|pull|put|move|send|throw|shift|slide|push|drag|show|restore|unminimise|pop|open|switch|swap|flip)(?: (?:up|back|over|out))?(?: to)? (.+?)(?: (?:up|back|over|forward|out|across))*$/);
  if (m) {
    const verb = m[1];
    const target = cleanTarget(m[2]);
    if (target) {
      // "move / put / send / shift it": only with a screen ("move the meeting to Friday" isn't a window).
      if (/^(?:put|move|send|throw|shift|slide|push|drag)$/.test(verb)) return where ? q("move", target, where) : null;
      if (verb === "open" || /^(?:switch|swap|flip)$/.test(verb)) return where ? q("bring", target, where) : null;
      if (verb === "show") return where ? q("bring", target, where) : lifted && target !== "front" ? q("bring", target, chromeMain(target)) : null;
      if (verb === "restore" || verb === "unminimise") return target === "front" && !where ? null : q("bring", target, where);
      // bring / get / pull / pop: "up", "back", "to the front" or a screen.
      // (J2: "bring up Chrome" is focus + his main screen, with no question: it's harmless. Other apps stay where they are.)
      if (lifted || where) return target === "front" && !where ? null : q("bring", target, where ?? chromeMain(target));
    }
  }
  // "Chrome isn't showing up on my main screen", "open my Chrome tab … it's not showing up in my front screen".
  if (where) {
    const complaint = /\b(?:not|isn't|isnt|aren't) (?:showing|coming|popping|there|visible|up)\b|\bcan't see\b|\bcannot see\b|\b(?:bring|get|pull|put|move|open|show|restore)\b/.test(u);
    const app = namedApp(u);
    if (complaint && app) return q("bring", app, where);
  }
  return null;
}

/**
 * The spoken line after a site opened in Jarvis Chrome, from the window skill's line for bringing it forward:
 * "Opened muventures.com.au in Chrome on your main screen." — or, plainly, that it didn't come forward. Pure.
 */
export function openedWhereLine(host: string, placed: string | null): string {
  const where = placed?.match(/ is (?:up )?on (your main screen|your other screen(?:, on the \w+)?|the [\w ]+? screen|your only screen)(?: now)?, sir\.$/)?.[1];
  if (where) return `Opened ${host} in Chrome on ${where}.`;
  if (placed && / is (?:up )?on .+ but Windows wouldn't put it in front/.test(placed)) return `Opened ${host} in Chrome, but Windows wouldn't bring it to the front: it's flashing in the taskbar.`;
  return `Opened ${host} in Chrome, but I couldn't bring its window to the front${placed ? `: ${placed.replace(/, sir\.$/, ".").replace(/^(.)/, (c) => c.toLowerCase())}` : "."}`;
}

/** What "it" can be in "bring it up": the thing Jarvis just opened, a tab, a window, a site or a page. */
const THING = "(?:it|that|this|them|(?:the|that|this) (?:tab|window|app|browser)|(?:the|that|this|my|our) (?:[a-z0-9&.' -]{1,40} )?(?:site|website|web site|page|tab))";
const BRING_IT = new RegExp(
  [
    `^(?:bring|pull|get|pop) ${THING}(?: back)?(?: up| forward| to the front| to the foreground| in front| (?:to|on|onto) (?:my|the) screen)+$`,
    // "bring it back" (J4): the thing Jarvis just moved or minimised, brought forward again.
    `^(?:bring|pull|get|pop) ${THING} back$`,
    `^(?:bring|pull) (?:up|forward) ${THING}$`,
    `^(?:show|give) (?:me )?${THING}(?: (?:to me|on (?:my|the) screen))?$`,
    `^put ${THING} (?:up )?(?:on|onto) (?:my|the) screen$`,
    `^focus(?: on)? ${THING}$`,
    // (Only "it" / "that tab": "switch to the next tab" is a tab switch, not this.)
    `^(?:switch|go) (?:back )?to (?:it|that|that (?:tab|window|site|page))$`,
  ].join("|"),
);
/**
 * "Bring it up", "bring it to the front", "show me that tab", "put it on my screen", "focus the site": window
 * focus on what Jarvis just opened (the window skill's referent), on the main screen, with no question asked.
 * Never a screen_act goal (J-fix: "bring it up" → "yep" → screen hands typed in Windows Search and wandered
 * through YouTube). Pure.
 */
export function bringToFrontIntent(utterance: string): WindowRequest | null {
  const u = norm(utterance.replace(CORRECTION_LEAD, ""))
    .replace(/[?!.;:,]+/g, " ")
    .replace(/(?:^| )(?:quickly|please|for me|again|now)(?= |$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!u || u.length > 90 || INSIDE_WORDS.test(u)) return null;
  return BRING_IT.test(u) ? { skill: "window", action: "bring", target: "front", screen: "main" } : null;
}

const COMPLAINT =
  /\b(?:do not|don't|dont|did not|didn't|didnt|can't|cant|cannot|can not|couldn't|could not) (?:see|find)\b|\bnot (?:being )?(?:shown|showing|visible|there|up|in front|on)\b|\b(?:isn't|isnt|aren't|arent|wasn't|wasnt) (?:on|showing|shown|there|visible|up|in front)\b/;
const THE_THING = /\b(?:it|(?:the|that|this) (?:tab|window|app|browser))\b/;
/**
 * "I didn't see it on my main screen", "I don't see the Chrome tab on my front screen", "the Chrome tab I
 * asked you to open is not being shown on the screen I want": where a window is, never a request to LOOK
 * at his screen (J-fix: these went to the screen-share tool three times). The window he means is the one
 * he names, else the one Jarvis just opened or moved ("it"); the screen is the one he names, else the one
 * he named earlier (`earlier`, his previous requests, newest first), else his main screen.
 */
export function windowComplaintIntent(utterance: string, earlier: string[] = []): WindowRequest | null {
  const u = ` ${norm(utterance).replace(/[?!.;:,]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (u.length > 420 || !COMPLAINT.test(u) || !/\b(?:screen|monitor|display)s?\b/.test(u)) return null;
  // A question about what's ON the screen ("what's on my screen", "read this") is the screen tool's.
  if (/\bwhat(?:'s| is) on\b|\blook at\b|\bread (?:this|that|it)\b|\bwhat do you see\b/.test(u)) return null;
  const app = namedApp(u.trim());
  const target = app ?? (THE_THING.test(u) ? "front" : null);
  if (!target) return null;
  const named = (text: string) => {
    const m = ` ${norm(text).replace(/[?!.;:,]+/g, " ")} `.match(SCREEN_PHRASE);
    return m ? screenName(m[1]) : /\bfront screen\b/.test(norm(text)) ? "main" : undefined;
  };
  const screen = named(utterance) ?? earlier.map(named).find(Boolean) ?? "main";
  return { skill: "window", action: "bring", target, screen };
}

/**
 * His answer to "Which one, sir: left screen or top screen?" ("the left one", "top", "the main
 * screen"): the request he made before, on that screen. Null when it isn't that answer.
 */
export function windowFollowUp(utterance: string, previousUser: string, lastAssistant: string): WindowRequest | null {
  // (The line itself, or the tool result that carried it.)
  if (!/Which one, sir: [^"\n]+ screen\?/.test(lastAssistant)) return null;
  const before = windowPlaceIntent(previousUser);
  if (!before || (before.action !== "bring" && before.action !== "move")) return null;
  const u = norm(utterance).replace(/[?!.]+/g, "").trim();
  const m = u.match(/^(?:(?:on|to|onto) )?(?:(?:the|my) )?(main|primary|front|left|right|top|upper|bottom|lower|third|3rd)(?: (?:one|screen|monitor|display))?$/);
  if (!m) return null;
  return { ...before, screen: screenName(m[1]) };
}

export function windowIntent(utterance: string): WindowRequest | null {
  const placed = windowPlaceIntent(utterance) ?? windowComplaintIntent(utterance) ?? bringToFrontIntent(utterance);
  if (placed) return placed;
  const u = norm(utterance.replace(CORRECTION_LEAD, "")).replace(/\bminimize\b/g, "minimise").replace(/\bmaximize\b/g, "maximise");
  if (u.length > 60) return null;
  const q = (action: WindowAction, target?: string): WindowRequest => ({ skill: "window", action, ...(target ? { target } : {}) });
  if (/^(?:show|go to|take me to|show me)(?: me)? (?:the |my )?desktop$|^minimise (?:everything|all(?: (?:the |my )?windows)?|all apps)$|^hide (?:everything|all(?: (?:the |my )?windows)?)$|^clear (?:the |my )?(?:screen|desktop)$|^(?:get|clear) everything (?:out of|off) (?:the way|my screen)$/.test(u)) return q("show_desktop");
  if (/^(?:restore|bring back|unminimise|undo minimise(?: all)?) (?:all )?(?:my |the )?windows(?: back)?$|^bring (?:my |the |all (?:my |the )?)?windows back$|^undo (?:show desktop|minimise all)$/.test(u)) return q("restore_all");
  if (/^(?:maximise|full ?screen|go full ?screen|make (?:this|it|that|the) (?:window )?(?:full ?screen|bigger|full size))(?: (?:this|it|the|this window|the window|that window|the current window))?(?: window)?$/.test(u)) return q("maximise");
  if (/^minimise(?: (?:this|it|that|the|this window|the window|that window|the current window))?(?: window)?$/.test(u)) return q("minimise");
  if (/^(?:restore|unmaximise) (?:this|it|the|this window|the window)(?: window)?$|^unmaximise$/.test(u)) return q("restore");
  let m = u.match(/^(?:snap|move|put|dock|push)(?: (?:this|it|that|the window|this window))?(?: window)?(?: to)?(?: the)? (left|right)(?: (?:half|side|of the screen))?$/);
  if (m) return q(m[1] === "left" ? "snap_left" : "snap_right");
  m = u.match(/^(?:switch|swap|flip|alt tab)(?: over| back)? to (?:the |my )?(.+?)(?: app| window| application)?$/);
  if (m) {
    const target = m[1].trim();
    if (!target || target.split(" ").length > 4 || NOT_WINDOWS.has(target) || /\b(?:mode|tab|tabs|page|english|voice|engine|model)\b/.test(target)) return null;
    return q("switch", target);
  }
  // "go to Visual Studio Code", "jump over to Chrome", "hop over to code" (J4): only for an app he can have open (a known
  // window name), never an OS page, a site or a place ("go to gmail", "go to the inbox", "go to sleep").
  m = u.match(/^(?:go|jump|hop|head|cut|flip|swing)(?: over| back)? to (?:the |my )?(.+?)(?: app| window| application)?$/);
  if (m) {
    const target = m[1].trim();
    if (target && target.split(" ").length <= 4 && !NOT_WINDOWS.has(target) && target in PROCESS_ALIASES && !/^(?:browser|web browser|settings|files)$/.test(target)) return q("switch", target);
  }
  return null;
}

/** Process names for what he'll say ("vs code" is Code.exe, "word" is WINWORD.EXE). */
const PROCESS_ALIASES: Record<string, string[]> = {
  "vs code": ["code"], vscode: ["code"], "visual studio code": ["code"], code: ["code"], chrome: ["chrome"], "google chrome": ["chrome"],
  edge: ["msedge"], "microsoft edge": ["msedge"], firefox: ["firefox"], explorer: ["explorer"], "file explorer": ["explorer"], files: ["explorer"],
  word: ["winword"], excel: ["excel"], powerpoint: ["powerpnt"], outlook: ["outlook", "olk"], teams: ["ms-teams", "teams"],
  terminal: ["windowsterminal"], "windows terminal": ["windowsterminal"], powershell: ["powershell", "pwsh", "windowsterminal"],
  browser: ["chrome", "msedge", "firefox", "opera", "brave"], "web browser": ["chrome", "msedge", "firefox", "opera", "brave"],
  "command prompt": ["cmd"], notepad: ["notepad"], spotify: ["spotify"], whatsapp: ["whatsapp", "whatsapp.root"], obsidian: ["obsidian"],
  discord: ["discord"], slack: ["slack"], "task manager": ["taskmgr"], settings: ["systemsettings"], calculator: ["calculatorapp", "calculator"],
};
const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}+ ]/gu, " ").replace(/\s+/g, " ").trim();

/** The best window for "switch to X", first by process, then title; front-most wins a tie. Pure. */
export function pickWindow(windows: WindowInfo[], target: string): WindowInfo | null {
  const want = clean(target);
  if (!want) return null;
  const procs = PROCESS_ALIASES[want] ?? [want.replace(/ /g, "")];
  const candidates = windows.filter((w) => w.title && !/^(?:progman|workerw|shell_traywnd|shell_secondarytraywnd)$/i.test(w.cls));
  let best: WindowInfo | null = null,
    bestScore = 0;
  for (const w of candidates) {
    const proc = w.process.toLowerCase();
    const title = clean(w.title);
    const segments = w.title.split(/\s+[-–—|·]\s+/).map(clean).filter(Boolean);
    let score = 0;
    if (procs.includes(proc)) score = 1;
    else if (segments.some((s) => s === want)) score = 0.97;
    else if (new RegExp(`(?:^| )${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(title)) score = 0.93;
    else if (want.length >= 4 && procs.some((p) => proc.startsWith(p))) score = 0.9;
    else if (want.length >= 4) {
      const fuzzy = Math.max(similarity(want, proc), ...segments.map((s) => similarity(want, s)));
      if (fuzzy >= 0.8) score = fuzzy * 0.9;
    }
    // Strictly greater: windows arrive front-most first, so the most recent one wins a tie.
    if (score > bestScore) (best = w), (bestScore = score);
  }
  return best;
}

export function parseWindowRows(text: string): WindowInfo[] {
  return text
    .split("\n")
    .map((row) => row.split("\t"))
    .filter((cols) => cols.length >= 4 && /^-?\d+$/.test(cols[0]))
    .map(([handle, process, cls, ...title]) => ({ handle: Number(handle), process, cls, title: title.join(" ").trim() }));
}

export async function foregroundWindow(ps: PsHost): Promise<WindowInfo | null> {
  const out = (await ps.run("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([JarvisWin]::Foreground()))")).trim();
  if (out.startsWith("ERROR")) return null;
  return parseWindowRows(unb64(out))[0] ?? null;
}

export async function listWindows(ps: PsHost) {
  const out = (await ps.run("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([JarvisWin]::List()))")).trim();
  if (out.startsWith("ERROR")) throw new Error("I couldn't list the windows just now.");
  return parseWindowRows(unb64(out));
}

const friendly = (w: WindowInfo) => {
  const segments = w.title.split(/\s+[-–—|·]\s+/).filter(Boolean);
  return (segments[segments.length - 1] || w.process || "that window").slice(0, 40);
};

/** What else the window skill can do: launch an app, open a Jarvis Chrome tab, know Jarvis Chrome's process. */
export type WindowDeps = {
  launch?: (app: string) => Promise<string>;
  /** Open a new tab in Jarvis Chrome (browser-hands act new_tab). */
  newTab?: () => Promise<{ ok: boolean; said: string }>;
  /** Jarvis Chrome's browser process id, which owns every Jarvis Chrome window. */
  jarvisChromePid?: () => Promise<number | null>;
  /** Make a Jarvis Chrome tab the active one (CDP Target.activateTarget). */
  activateTab?: (targetId: string) => Promise<boolean>;
};
const monitorsOf = async (ps: PsHost) => parseMonitors(await ps.run("[JarvisWin]::Monitors()", 10_000));
const stateOf = async (ps: PsHost, handle: number) => parseWindowState(await ps.run(`[JarvisWin]::State(${Math.trunc(handle)})`, 10_000));
const screenOf = (monitors: Monitor[], id: number, rect: { x: number; y: number; w: number; h: number }) => monitors.find((m) => m.id === id) ?? monitorOf(monitors, rect);
const DESKTOP = /^(?:progman|workerw|shell_traywnd|shell_secondarytraywnd)$/i;

/** Jarvis Chrome's window: the Chrome window its browser process owns, else a Chrome window in front. */
async function jarvisChromeWindow(windows: WindowInfo[], ps: PsHost, deps: WindowDeps): Promise<WindowInfo | null> {
  const chromes = windows.filter((w) => w.process.toLowerCase() === "chrome" && !isJarvisOwnWindow(w));
  const pid = await deps.jarvisChromePid?.().catch(() => null);
  if (pid) {
    for (const w of chromes) if (Number((await ps.run(`[JarvisWin]::PidOf(${Math.trunc(w.handle)})`).catch(() => "")).trim()) === pid) return w;
    return null;
  }
  const fg = await foregroundWindow(ps).catch(() => null);
  if (fg && fg.process.toLowerCase() === "chrome") return fg;
  return chromes[0] ?? null;
}

/** The window "it / that / the tab" means: what Jarvis last opened or moved; never Jarvis' own window. */
async function referentWindow(windows: WindowInfo[], ps: PsHost, deps: WindowDeps, app?: string): Promise<WindowInfo | null> {
  const r = currentReferent();
  if (!r) return null;
  // "the Chrome tab" when the thing Jarvis last touched is something else: not this referent.
  if (app && app !== "browser" && !windowIsApp(app, r.app) && !(r.jarvisChrome && windowIsApp(app, "chrome"))) return null;
  if (app === "browser" && !r.jarvisChrome && !windowIsApp("browser", r.app)) return null;
  const kept = r.handle ? windows.find((w) => w.handle === r.handle) : undefined;
  if (kept && !isJarvisOwnWindow(kept)) return kept;
  if (r.jarvisChrome) return jarvisChromeWindow(windows, ps, deps);
  return pickWindow(windows.filter((w) => !isJarvisOwnWindow(w)), r.app);
}

async function findTarget(req: WindowRequest, ps: PsHost, deps: WindowDeps = {}): Promise<WindowInfo | null> {
  const windows = await listWindows(ps);
  if (!req.target || req.target === "front") {
    const meant = await referentWindow(windows, ps, deps);
    if (meant) return meant;
    // No referent: the window in front, unless that's the desktop or Jarvis itself (then he's asked).
    const fg = await foregroundWindow(ps);
    return fg && fg.handle && !DESKTOP.test(fg.cls) && !isJarvisOwnWindow(fg) ? fg : null;
  }
  // "the Chrome tab" right after Jarvis opened one: that window, not his other Chrome windows.
  const meant = await referentWindow(windows, ps, deps, clean(req.target));
  return meant ?? pickWindow(windows, req.target);
}

type Placed = { ok: boolean; said: string; label?: string; focused?: boolean };
/** Put one window on a screen (restored if minimised), in front, and check where it landed. */
async function placeWindow(w: WindowInfo, screen: ScreenName | undefined, ps: PsHost): Promise<Placed> {
  const name = friendly(w);
  const handle = Math.trunc(w.handle);
  const monitors = await monitorsOf(ps).catch(() => [] as Monitor[]);
  const st = await stateOf(ps, handle).catch(() => null);
  if (!monitors.length || !st) {
    const ok = (await ps.run(`[JarvisWin]::Focus(${handle})`)).trim() === "True";
    return { ok, focused: ok, said: ok ? `${name} is up, sir.` : `Windows wouldn't bring ${name} to the front, sir. It's flashing in the taskbar.` };
  }
  const from = screenOf(monitors, st.monitor, st.minimised ? st.normal : st.rect)!;
  let to = from;
  if (screen) {
    const pick = pickMonitor(monitors, screen, from);
    if ("ask" in pick) return { ok: false, said: pick.ask };
    if ("none" in pick) return { ok: false, said: pick.none };
    to = pick.monitor;
  }
  if (to.id !== from.id) {
    const maximise = st.maximised || (st.minimised && st.restoreMaximised);
    const r = placeRect(st.normal, from, to);
    await ps.run(`[JarvisWin]::Place(${handle}, ${r.x}, ${r.y}, ${r.w}, ${r.h}, $${maximise ? "true" : "false"})`, 10_000);
  } else if (st.minimised) await ps.run(`[void][JarvisWin]::ShowWindow([IntPtr]::new(${handle}), 9); 'OK'`);
  const focused = (await ps.run(`[JarvisWin]::Focus(${handle})`)).trim() === "True";
  // Checked, not assumed: the window's centre must now be on the screen it was meant for.
  const after = await stateOf(ps, handle).catch(() => null);
  const landed = !!after && !after.minimised && isOn(after.rect, to);
  const label = screenLabel(monitors, to);
  if (!landed) return { ok: false, label, said: `I tried to put ${name} on ${label}, sir, but Windows didn't move it.` };
  const said = to.id !== from.id ? `${name} is on ${label} now` : `${name} is up on ${label}`;
  return { ok: true, label, focused, said: focused ? `${said}, sir.` : `${said}, sir, but Windows wouldn't put it in front: it's flashing in the taskbar.` };
}

/** Bring a window up (restored if minimised) on the screen he named, or where it is; then in front. */
async function bring(req: WindowRequest, ps: PsHost, deps: WindowDeps): Promise<string> {
  const target = (req.target ?? "front").slice(0, 60);
  const w = await findTarget(req, ps, deps);
  if (!w) {
    if (target === "front") return "Which window, sir? Name the app and I'll bring it over.";
    if (req.action === "bring" && deps.launch && target !== "browser" && !req.screen) return deps.launch(target);
    return `I can't see a ${target} window open, sir. Say "open ${target}" and I'll launch it.`;
  }
  // A site Jarvis opened in Jarvis Chrome: THAT tab is made the active one before its window comes forward.
  const was = currentReferent();
  const stillJarvisChrome = !!was?.jarvisChrome && (was.handle === w.handle || (!was.handle && w.process.toLowerCase() === "chrome"));
  if (stillJarvisChrome && was?.targetId && deps.activateTab) await deps.activateTab(was.targetId).catch(() => false);
  const placed = await placeWindow(w, req.screen, ps);
  // What "it" means next: this window (a Jarvis Chrome referent stays Jarvis Chrome, and its tab).
  rememberReferent({
    app: w.process.toLowerCase(),
    handle: Math.trunc(w.handle),
    title: (stillJarvisChrome && was?.title) || w.title.slice(0, 80),
    ...(stillJarvisChrome ? { jarvisChrome: true, ...(was?.targetId ? { targetId: was.targetId } : {}) } : {}),
  });
  return placed.said;
}

/** "Open a Chrome tab": a new tab in Jarvis Chrome, its window on the screen he named (main by default), in front, and said so. */
async function openTab(req: WindowRequest, ps: PsHost, deps: WindowDeps): Promise<string> {
  if (!deps.newTab) return "I can't open a browser tab from here, sir.";
  const opened = await deps.newTab().catch((e: Error) => ({ ok: false, said: e.message }));
  if (!opened.ok) return `I couldn't open a Chrome tab, sir: ${opened.said.replace(/\.$/, "")}.`;
  rememberReferent({ app: "chrome", jarvisChrome: true, title: "New Tab" });
  const w = await jarvisChromeWindow(await listWindows(ps).catch(() => [] as WindowInfo[]), ps, deps);
  if (!w) return "I opened a Chrome tab, sir, but I couldn't find its window to put it on your screen.";
  rememberReferent({ app: "chrome", jarvisChrome: true, handle: Math.trunc(w.handle), title: w.title.slice(0, 80) });
  const placed = await placeWindow(w, req.screen ?? "main", ps);
  if (!placed.ok) return placed.label ? `I opened a Chrome tab, sir, but Windows didn't move it to ${placed.label}.` : `I opened a Chrome tab, sir. ${placed.said}`;
  const where = placed.label ?? "your screen";
  return placed.focused ? `Opened a Chrome tab on ${where}, sir.` : `Opened a Chrome tab on ${where}, sir, but Windows wouldn't put it in front: it's flashing in the taskbar.`;
}

async function whereIs(req: WindowRequest, ps: PsHost, deps: WindowDeps = {}): Promise<string> {
  const w = await findTarget(req, ps, deps);
  if (!w) return req.target && req.target !== "front" ? `I can't see a ${req.target} window open, sir.` : "There's no window in front, sir.";
  const monitors = await monitorsOf(ps);
  const st = await stateOf(ps, w.handle);
  if (!st || !monitors.length) return `I can't tell which screen ${friendly(w)} is on, sir.`;
  const label = screenLabel(monitors, screenOf(monitors, st.monitor, st.minimised ? st.normal : st.rect)!);
  if (monitors.length === 1) return `${friendly(w)} is on your only screen, sir${st.minimised ? ", minimised" : ""}.`;
  return st.minimised ? `${friendly(w)} is minimised, sir. It was on ${label}.` : `${friendly(w)} is on ${label}, sir.`;
}

export async function answerWindow(req: WindowRequest, ps: PsHost, deps: WindowDeps = {}): Promise<string> {
  switch (req.action) {
    case "bring":
    case "move":
      return bring(req, ps, deps);
    case "where":
      return whereIs(req, ps, deps);
    case "open_tab":
      return openTab(req, ps, deps);
    case "show_desktop":
      await ps.run("(New-Object -ComObject Shell.Application).MinimizeAll(); 'OK'");
      return "Desktop's clear, sir.";
    case "restore_all":
      await ps.run("(New-Object -ComObject Shell.Application).UndoMinimizeALL(); 'OK'");
      return "Windows restored, sir.";
    case "maximise":
    case "minimise":
    case "restore": {
      const front = await foregroundWindow(ps);
      if (!front || !front.handle || /^(?:progman|workerw|shell_traywnd)$/i.test(front.cls)) return "There's no window in front to change, sir.";
      const cmd = req.action === "maximise" ? 3 : req.action === "minimise" ? 6 : 9;
      await ps.run(`[void][JarvisWin]::ShowWindow([IntPtr]::new(${Math.trunc(front.handle)}), ${cmd}); 'OK'`);
      return req.action === "maximise" ? "Maximised, sir." : req.action === "minimise" ? "Minimised, sir." : "Restored, sir.";
    }
    case "snap_left":
    case "snap_right": {
      const front = await foregroundWindow(ps);
      if (!front || /^(?:progman|workerw|shell_traywnd)$/i.test(front.cls)) return "There's no window in front to snap, sir.";
      // Win + Left/Right: Windows' own snap, so Snap Assist behaves exactly as it does by hand.
      await ps.run(`[JarvisWin]::Chord(0x5B, ${req.action === "snap_left" ? "0x25" : "0x27"}); 'OK'`);
      return `Snapped ${req.action === "snap_left" ? "left" : "right"}, sir.`;
    }
    case "switch": {
      const target = (req.target ?? "").slice(0, 60);
      const match = pickWindow(await listWindows(ps), target);
      if (!match) return `I can't see a ${target} window open, sir. Say "open ${target}" and I'll launch it.`;
      const ok = (await ps.run(`[JarvisWin]::Focus(${Math.trunc(match.handle)})`)).trim() === "True";
      return ok ? `Switched to ${friendly(match)}, sir.` : `Windows wouldn't bring ${friendly(match)} to the front, sir. It's flashing in the taskbar.`;
    }
  }
}
