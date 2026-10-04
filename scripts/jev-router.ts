/**
 * Jev-first intent router for Jarvis's voice turns. Runs after the anchored regex rules and before
 * the language model: ONE TypeSafe Jev request per utterance (every question is evaluated in
 * parallel against the same state, so the speculative sub-questions cost no extra latency) picks
 * a category and, speculatively, the exact action within every category; deterministic slot
 * extractors then fill the arguments (app name, folder, page, site, click target, search words,
 * skill slots). Jarvis acts only when Jev's confidence clears the tier threshold for that action
 * AND the extractor succeeds; everything else falls through to the brain with Jev's guess as a
 * hint. See docs/JEV-ROUTING.md for the design, calibration and benchmark.
 *
 * Safety: an utterance the code-level outbound gate (needsConfirmation) flags never reaches Jev
 * at all, and a Jev "outbound" noul above threshold also sends the turn to the brain. Nothing
 * here can call an instant action for a request that sends, pays, deletes, posts or books;
 * those stay on control_pc, whose code gate asks for his spoken yes.
 *
 * Repeat commands hit an in-memory decision cache (normalised utterance → Jev's answers), so the
 * second "turn it down a bit" skips the network entirely. Extractors still re-run on a hit.
 */
import { needsConfirmation } from "../src/lib/jarvis-control";
import { lessonIntent } from "../src/lib/lesson-words";
import { parseTarget } from "./browser-hands";
import { PAGES, SITES, spokenUrls } from "./jev";
import { JEV_MODEL, JEV_URL, jevDecide } from "./jev-client";
import { PROTOCOLS, type ProtocolName } from "./jarvis-protocols";
import { matchApp, type StartApp } from "./pc-hands";
import { driveAppIntent } from "./screen-hands/cdp";
import { layaUrl, logShadow, queryLaya } from "./laya-shadow";
import { googleSearchUrl, linkedSteps, searchQueryIn } from "./jarvis-command/plan";

export type ToolCallSpec = { name: string; arguments: Record<string, unknown> };
type JevAnswer = { type?: string; choice?: string; noul?: number; confidence?: number; probabilities?: Record<string, number> };
export type JevAnswers = Record<string, JevAnswer>;

/** A skill the router can reach: the jarvis-skills pack registers these (timers, reminders, …). */
export type RouterSkill = {
  id: string;
  /** One line for Jev: when this skill is the right one. */
  description: string;
  /** The tool call for this utterance, or null when its slots can't be filled deterministically. */
  extract: (utterance: string) => ToolCallSpec | null;
  tier?: Tier;
};

export type Tier = "show" | "act" | "strong";
export type RouteTrace = {
  intent: string;
  confidence: number;
  ms: number;
  cached: boolean;
  outbound: number;
  complete: number;
  multi: number;
  reason?: string;
};
export type RouteDecision =
  | { kind: "act"; call: ToolCallSpec; trace: RouteTrace }
  | { kind: "status"; trace: RouteTrace }
  /** `unavailable`: Jev itself was out (no key, or the call failed), so nothing decided this turn: the caller must say so, never route by a model instead. */
  | { kind: "brain"; hint: string; trace: RouteTrace | null; unavailable?: "no-key" | "error"; /** The code's outbound gate answered before Jev was asked (sends, pays, books…): not a Jev decision. */ gate?: "outbound" };

// --- thresholds (calibrated on docs/jev-bench/calib-*.json; see docs/JEV-ROUTING.md) ------------
export const THRESHOLDS: Record<Tier, number> = { show: 0.55, act: 0.6, strong: 0.85 };
/** Handing the utterance straight to Hermes (control_pc) skips the brain; a wrong call costs ~10 s. */
export const HERMES_MIN = 0.75;
/** Jev's "this sends, pays, deletes, posts or books" noul: above this, never an instant action. */
export const OUTBOUND_MAX = 0.35;
/** "He asked for several things / a multi-step task": above this, not a single instant action. */
export const MULTI_MAX = 0.5;
/** "He hasn't finished speaking": below this, let the brain (and the next turn) handle it. */
export const COMPLETE_MIN = 0.4;
export const JEV_TIMEOUT_MS = 1200;

// --- the catalogue ---------------------------------------------------------------------------------
export const CATEGORIES: Record<string, string> = {
  pc: "Control this Windows PC directly: open or launch an app or a folder, music/media keys (next, previous, play/pause), volume up/down/mute, lock the PC.",
  browser: "Act on the web page or video already on screen: click something on it, pause/play the video, go back or forward a page, reload, scroll, open or close a tab, search within the site.",
  screen_teach: "Teach him how to do something in the app on his screen, step by step, pointing with Jarvis's own cursor while he clicks (show me how to, teach me, where do I click to, walk me through), or take over and do it for him.",
  screen_act: "Work the app or form he is looking at right now, hands on: click a named button or field, type into a field (\"in there\", \"here\"), fill in or finish a form, select all, press a key, or help him get through what's on screen.",
  os_page: "Open one of the OS's own pages: inbox, calendar, memory, business dashboard, leads, chat, design, websites, code graph, Hermes, settings.",
  website: "Show a named website or a spoken web address in a browser tab, nothing more.",
  search: "Search the web (Google) for something he names, or look it up online, in a browser tab on his own computer.",
  screen: "Look at what's on his screen, or what was just said in the video or call, and answer about it.",
  status: "A quick status report: how his day, calls and follow-ups are tracking right now.",
  routine: "One of his named routines: start the day, call mode on, call mode off, shutdown / end of day.",
  skill: "A built-in quick skill: timers, reminders, the time or date, arithmetic, system info, clipboard, notes, typing or dictating text, arranging windows.",
  emails: "Check for new or latest emails right now.",
  memory: "Recall something he saved or remembered before.",
  workspace: "A read-only question about his calendar, schedule, business numbers, goals or connections.",
  cad: "Design, build or open a physical part as a 3D CAD model: make, create, design or model a bracket, plate, enclosure, mount or part; change a model's dimensions, holes or size; open a model he already made in FreeCAD or Blender.",
  hermes: "Real multi-step work on the PC or web: files, several apps, typing into an app, WhatsApp, clipping pages, downloads, anything with more than one step.",
  brain: "Anything else: a question, opinion, joke, small talk, advice, or a request that needs thought or writing.",
};

export const PC_ACTIONS: Record<string, string> = {
  open_app: "Open or launch an application by name.",
  open_folder: "Open a folder: Downloads, Documents, Desktop, Pictures, Music or Videos.",
  next: "Skip to the next song or track.",
  previous: "Go back to the previous song or track.",
  play_pause: "Pause or resume the music.",
  volume_up: "Make it louder; turn the volume up.",
  volume_down: "Make it quieter; turn the volume down.",
  mute: "Mute or unmute the sound.",
  lock: "Lock the PC.",
};

export const BROWSER_ACTIONS: Record<string, string> = {
  click: "Click, press, tap, play or open a specific thing on the page (a video, result, link or button).",
  pause: "Pause the video.",
  play: "Play or resume the video.",
  back: "Go back a page.",
  forward: "Go forward a page.",
  reload: "Reload or refresh the page.",
  scroll_down: "Scroll down.",
  scroll_up: "Scroll up.",
  new_tab: "Open a new blank tab.",
  close_tab: "Close the current tab.",
  search: "Type words into this site's search box.",
};

export const ROUTER_PAGES: Record<string, string> = { ...PAGES, "/leads": "leads, CRM, call list" };

const ROUTINE_LABELS: Record<ProtocolName, string> = {
  "start-day": "Start the day (morning routine)",
  "call-mode": "Turn call mode on (about to make calls)",
  "end-call-mode": "Turn call mode off (calls finished)",
  shutdown: "Shutdown / end of day / wrap up for tonight",
};

/** Risk tier per resolved intent: the confidence it needs before acting without the brain. */
export function tierOf(intent: string, skills: RouterSkill[] = []): Tier {
  if (intent.startsWith("skill.")) return skills.find((s) => `skill.${s.id}` === intent)?.tier ?? "act";
  // screen_teach points and waits for him; a take-over has screen_act's gates.
  if (["os_page", "website", "search", "screen", "status", "emails", "memory", "workspace", "screen_teach"].includes(intent)) return "show";
  // screen_act has its own gates (no secrets, a spoken yes before any final button), so "act".
  if (intent === "pc.lock" || intent === "browser.close_tab" || intent.startsWith("routine.") || intent === "hermes") return "strong";
  return "act";
}

/** App names the outbound gate matches as words ("WhatsApp"): opening the app itself sends nothing. */
const OUTBOUND_APP_NAMES = /\bwhats\s?app\b/gi;
/**
 * The code gate with messaging apps' names taken out: true when something other than naming the
 * app is outbound ("open WhatsApp and message Mehroz" is; "I need WhatsApp up" isn't).
 */
export function outboundBeyondApps(text: string) {
  return needsConfirmation(text.replace(OUTBOUND_APP_NAMES, "the app"));
}

// --- normalising ------------------------------------------------------------------------------------
export function normaliseUtterance(text: string) {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.!?,;:]+/g, " ")
    .replace(/^\s*(?:(?:okay|ok|right|alright|hey)\s+)?(?:jarvis\s+)?/, "")
    .replace(/^(?:can you|could you|would you|will you|please)\s+/, "")
    .replace(/\s+(?:please|for me|now|jarvis|sir|thanks|thank you)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- slot extractors (deterministic) -----------------------------------------------------------------
const FILLER = new Set(
  ("a an the my me i i'm im it its this that some up on off open opened opening launch start run boot fire get got going go pop pull bring need want " +
    "please can could would will you for to app application program window quickly quick now just up real real bit let's lets start started " +
    "have has with and hey jarvis sir there here out load loaded show see use using")
    .split(" "),
);
const NOT_APPS = new Set([
  "inbox", "calendar", "memory", "business", "chat", "design", "websites", "website", "code graph", "codegraph", "hermes", "leads", "crm",
  "dashboard", "jarvis", "youtube", "gmail", "google", "github", "notebooklm", "folder", "downloads", "documents", "desktop", "pictures",
  "music", "videos", "photos", "song", "track", "volume", "sound", "page", "tab", "video", "screen",
]);
const ALIASES: Record<string, string> = {
  "vs code": "visual studio code", vscode: "visual studio code", chrome: "google chrome", explorer: "file explorer", calc: "calculator",
  cmd: "command prompt", powershell: "windows powershell", "task manager": "task manager", whatsapp: "whatsapp",
};
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}+ ]/gu, " ").replace(/\s+/g, " ").trim();

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length];
}

/** Candidate app phrases: contiguous runs of the utterance that don't start or end with filler. */
function phrases(text: string) {
  const words = norm(text).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let size = Math.min(4, words.length); size >= 1; size--)
    for (let i = 0; i + size <= words.length; i++) {
      const slice = words.slice(i, i + size);
      if (FILLER.has(slice[0]) || FILLER.has(slice[slice.length - 1])) continue;
      out.push(slice.join(" "));
    }
  return out;
}

/**
 * The app he named, from the Start-menu list: exact name or alias first (longest phrase wins),
 * then pc-hands' prefix match, then a small-typo fuzzy match ("calculater", "obsidan").
 */
export function extractApp(text: string, apps: StartApp[]): StartApp | null {
  if (!apps.length) return null;
  const candidates = phrases(text).filter((p) => !NOT_APPS.has(p) && p.length >= 3);
  const byName = apps.map((app) => ({ app, n: norm(app.name) }));
  for (const phrase of candidates) {
    const want = ALIASES[phrase] ?? phrase;
    const exact = byName.find((x) => x.n === want);
    if (exact) return exact.app;
  }
  for (const phrase of candidates) {
    if (phrase.length < 4 && !ALIASES[phrase]) continue;
    const hit = matchApp(apps, ALIASES[phrase] ?? phrase);
    if (hit) return hit;
  }
  for (const phrase of candidates) {
    if (phrase.length < 5 || phrase.includes(" ")) continue;
    const close = byName.filter((x) => {
      const first = x.n.split(" ")[0];
      return editDistance(phrase, x.n) <= (phrase.length >= 8 ? 2 : 1) || (first.length >= 5 && editDistance(phrase, first) <= 1 && x.n.split(" ").length <= 2);
    });
    if (close.length === 1) return close[0].app;
  }
  return null;
}

/** A web app he named that isn't installed ("fire up spotify" with no Spotify app). */
export function extractWebApp(text: string): string | null {
  const said = ` ${norm(text)} `;
  for (const [url, label] of Object.entries(SITES)) {
    const words = siteWords(label);
    if (words.some((w) => said.includes(` ${w} `))) return url;
  }
  return null;
}

const FOLDERS: Record<string, string> = {
  downloads: "Downloads", download: "Downloads", documents: "Documents", docs: "Documents", desktop: "Desktop",
  pictures: "Pictures", photos: "Pictures", music: "Music", videos: "Videos",
};
export function extractFolder(text: string): string | null {
  const found = [...new Set(norm(text).split(" ").map((w) => FOLDERS[w]).filter(Boolean))];
  return found.length === 1 ? found[0] : null;
}

const PAGE_WORDS: Array<[RegExp, string]> = [
  [/\b(inbox|e-?mails?|mail)\b/, "/inbox"],
  [/\b(calendar|schedule|diary)\b/, "/calendar"],
  [/\b(memory|memories|second brain)\b/, "/memory"],
  [/\b(business|dashboard|revenue|audience)\b/, "/business"],
  [/\b(leads|crm|call list)\b/, "/leads"],
  [/\bchat\b/, "/chat"],
  [/\b(design studio|design)\b/, "/design"],
  [/\bwebsites\b/, "/websites"],
  [/\b(code ?graph)\b/, "/codegraph"],
  [/\bhermes\b/, "/agents/hermes"],
  [/\b(settings|preferences)\b/, "/settings"],
  // AUDIT-F4 F3 (Track 1): the destinations Jev could not name before.
  [/\btoday\b/, "/today"],
  [/\bjarvis page\b/, "/jarvis"],
  [/\breceptionist\b/, "/receptionist"],
  [/\b(operations|packages|pricing)\b/, "/operations"],
  [/\bfinances?\b/, "/finance"],
  [/\bstudio\b/, "/studio"],
  [/\bsystem page\b/, "/system"],
  [/\bmodels page\b/, "/models"],
];
export function extractPage(text: string, jevPage?: string, jevConfidence = 0): string | null {
  const said = text.toLowerCase();
  const lexical = [...new Set(PAGE_WORDS.filter(([re]) => re.test(said)).map(([, path]) => path))];
  if (jevPage && jevPage in ROUTER_PAGES && lexical.includes(jevPage)) return jevPage;
  if (lexical.length === 1) return lexical[0];
  if (jevPage && jevPage in ROUTER_PAGES && jevConfidence >= 0.9) return jevPage;
  return null;
}

function siteWords(label: string) {
  // "Gmail (email, mail)" → ["gmail"]; "X / Twitter (tw)" → ["twitter", "tw"]; generic words and
  // the aliases shared with OS pages (email, mail) never count as naming a site on their own.
  const generic = new Set(["google", "search", "email", "mail", "x", "maps", "calendar", "drive"]);
  const words = norm(label.replace(/[()/,]/g, " ")).split(" ").filter((w) => w.length >= 2 && !generic.has(w));
  if (/^google (\w+)/i.test(label)) words.push(norm(label).replace(/\s*\(.*$/, ""));
  return words;
}

const SEARCHY = /\b(search|play|find|look\s*up|watch|videos?|songs?|results?)\b/i;
export function extractSite(text: string, jevSite?: string, jevConfidence = 0): string | null {
  if (SEARCHY.test(text)) return null; // the brain builds search links
  const spoken = spokenUrls(text);
  if (spoken.length === 1) return spoken[0];
  const said = ` ${norm(text)} `;
  const named = Object.entries(SITES).filter(([, label]) => siteWords(label).some((w) => said.includes(` ${w} `))).map(([url]) => url);
  if (jevSite && named.includes(jevSite)) return jevSite;
  if (named.length === 1) return named[0];
  if (jevSite && jevSite in SITES && jevConfidence >= 0.95) return jevSite;
  return null;
}

const CLICK_VERB = /^(?:(?:go ahead and|now)\s+)?(?:click|press|tap|hit|select|choose|pick|open|play|watch|go to|navigate to)(?:\s+on)?\s+/;
export function extractClickTarget(text: string): string | null {
  const u = normaliseUtterance(text).replace(/\band\s+(?:click|press|open|play)\s+(?:it|that)\b/g, "").trim();
  const target = u.replace(CLICK_VERB, "").trim();
  if (target === u && !/\b(first|second|third|fourth|fifth|last)\b/.test(u)) return null; // no verb: not a click
  const parsed = parseTarget(target);
  if (parsed.ordinal === undefined && parsed.words.replace(/\s/g, "").length < 2) return null;
  return target.slice(0, 120);
}

export function extractSearch(text: string): string | null {
  const u = normaliseUtterance(text);
  const m = u.match(/^(?:search|look\s*up|find)\s+(?:(?:this|the)\s+(?:page|site)\s+)?(?:for\s+)?(.{2,120}?)(?:\s+on\s+(?:this|the)\s+(?:page|site))?$/);
  if (!m) return null;
  const words = m[1].trim();
  // "search YouTube for …" names a site: that's a search link for the brain, not this page's box.
  if (extractWebApp(words) || /\b(google|youtube|web|internet|online)\b/.test(words)) return null;
  return words;
}

// --- the Jev request ---------------------------------------------------------------------------------
export type Design = "tree" | "flat";

export function routerQuestions(text: string, skills: RouterSkill[] = [], design: Design = "tree") {
  const sites: Record<string, string> = { ...SITES, none: "No website is involved" };
  for (const url of spokenUrls(text)) sites[url] = `The address he said: ${url}`;
  const categories: Record<string, string> = { ...CATEGORIES };
  if (!skills.length) delete categories.skill;
  const shared = {
    page: { type: "choice", instructions: "If he wants one of the OS's own pages, which one?", criteria: { ...ROUTER_PAGES, none: "No OS page" } },
    site: { type: "choice", instructions: "If he wants a website shown, which one?", criteria: sites },
    routine: { type: "choice", instructions: "If he wants one of his named routines, which one?", criteria: { ...ROUTINE_LABELS, none: "No routine" } },
    listen: { type: "noul", instructions: "He is asking about what was said or heard (audio), not what is visible." },
    outbound: { type: "noul", instructions: "Doing this would send a message or email, call someone, spend or move money, book, publish, post, share, delete, uninstall, deploy or push: something that affects other people or can't be undone." },
    multi: { type: "noul", instructions: "He asked for two or more separate actions, or a task with several steps." },
    complete: { type: "noul", instructions: "He has finished a complete request (not cut off mid-sentence)." },
    ...(skills.length
      ? { skill: { type: "choice", instructions: "If he wants a built-in quick skill, which one?", criteria: { ...Object.fromEntries(skills.map((s) => [s.id, s.description])), none: "No skill" } } }
      : {}),
  };
  if (design === "flat") {
    const intents: Record<string, string> = {};
    for (const [id, text] of Object.entries(PC_ACTIONS)) intents[`pc.${id}`] = `On this PC: ${text}`;
    for (const [id, text] of Object.entries(BROWSER_ACTIONS)) intents[`browser.${id}`] = `On the web page on screen: ${text}`;
    for (const key of ["os_page", "website", "search", "screen", "screen_act", "screen_teach", "status", "routine", "emails", "memory", "workspace", "hermes", "brain"]) intents[key] = CATEGORIES[key];
    for (const skill of skills) intents[`skill.${skill.id}`] = `Quick skill: ${skill.description}`;
    return { intent: { type: "choice", instructions: "Which single action best serves what he just said to his assistant, Jarvis?", criteria: intents }, ...shared };
  }
  return {
    category: { type: "choice", instructions: "Which kind of action best serves what he just said to his assistant, Jarvis?", criteria: categories },
    pc_action: { type: "choice", instructions: "If this is about controlling the PC, which action?", criteria: { ...PC_ACTIONS, none: "None of these" } },
    browser_action: { type: "choice", instructions: "If this is about the web page on screen, which action?", criteria: { ...BROWSER_ACTIONS, none: "None of these" } },
    ...shared,
  };
}

type AskJevOptions = {
  request?: typeof fetch;
  skills?: RouterSkill[];
  design?: Design;
  timeoutMs?: number;
  shorthand?: string[];
  /**
   * Extra, already-redacted facts for the state (the desktop entry adds the window in front:
   * "front_window": "Notepad"). Voice turns leave it out, so their request is unchanged.
   */
  context?: Record<string, string>;
};

/** The exact body a router request sends — shared with the Laya shadow call, so it asks the identical question. */
export function jevRequestBody(text: string, options: AskJevOptions) {
  return {
    model: JEV_MODEL,
    // His shorthand travels with the words ("yt = YouTube"), so Jev reads him as he means it.
    state: {
      utterance: text.slice(0, 2000),
      ...(options.shorthand?.length ? { shorthand: options.shorthand } : {}),
      ...Object.fromEntries(Object.entries(options.context ?? {}).map(([k, v]) => [k, String(v).slice(0, 300)])),
    },
    questions: routerQuestions(text, options.skills, options.design),
  };
}

export async function askJev(text: string, key: string, options: AskJevOptions = {}): Promise<{ answers: JevAnswers; ms: number; inputTokens?: number; outputTokens?: number } | null> {
  // Through the one Jev client (surface voice.router): same body, same budget, a receipt per decision.
  const { state, questions } = jevRequestBody(text, options);
  const out = await jevDecide({ surface: "voice.router", caller: "scripts/jev-router.ts", key, state, questions, request: options.request, timeoutMs: options.timeoutMs ?? JEV_TIMEOUT_MS });
  if (!out.ok) return null;
  const raw = out.raw as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : {};
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const tokens = { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) };
  return { answers: out.answers as JevAnswers, ms: out.ms, ...(tokens.inputTokens !== undefined ? { inputTokens: tokens.inputTokens } : {}), ...(tokens.outputTokens !== undefined ? { outputTokens: tokens.outputTokens } : {}) };
}

/**
 * Fire-and-forget: also asks Laya the same question Jev was just asked, and logs whether they
 * agreed and how long each took. Never awaited by the router and never throws — a shadow failure
 * must not affect, delay or appear in the real routing decision.
 */
function shadowAskLaya(text: string, options: AskJevOptions, jev: { answers: JevAnswers; ms: number }) {
  const base = layaUrl();
  if (!base) return;
  void (async () => {
    // Same question, but Laya's `model` field is pinned to its `typed-decisions` checkpoint
    // (docs/LAYA.md), not the shared `model: "jev-latest"` Jev itself reads: laya-serve only
    // honours a `model` value that names one of its own checkpoints (english/multilingual/
    // typed-decisions) and otherwise auto-routes by detected language, which for Jarvis's
    // English utterances resolves to the base `english` checkpoint, not the one we're shadowing.
    const layaBody = { ...jevRequestBody(text, options), model: "typed-decisions" };
    const laya = await queryLaya(base, layaBody, options.request);
    const jevIntent = resolveIntent(jev.answers, options.skills ?? []);
    const layaIntent = laya ? resolveIntent(laya.answers, options.skills ?? []) : null;
    await logShadow({
      at: new Date().toISOString(),
      jevIntent: jevIntent.intent,
      jevConfidence: jevIntent.confidence,
      jevMs: jev.ms,
      layaIntent: layaIntent?.intent ?? null,
      layaConfidence: layaIntent?.confidence ?? null,
      layaMs: laya?.ms ?? null,
      agree: layaIntent ? layaIntent.intent === jevIntent.intent : null,
    });
  })();
}

// --- cache -------------------------------------------------------------------------------------------
export class DecisionCache {
  private map = new Map<string, { answers: JevAnswers; at: number }>();
  constructor(private max = 256, private ttlMs = 30 * 60_000, private now: () => number = Date.now) {}
  get(key: string): JevAnswers | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, hit); // most recently used last
    return hit.answers;
  }
  set(key: string, answers: JevAnswers) {
    if (!key) return;
    this.map.delete(key);
    this.map.set(key, { answers, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  get size() {
    return this.map.size;
  }
}

// --- deciding ----------------------------------------------------------------------------------------
const pickChoice = (a?: JevAnswer) => (a?.choice && a.choice !== "none" ? a.choice : undefined);
const conf = (a?: JevAnswer) => (typeof a?.confidence === "number" ? a.confidence : 0);
const noul = (a: JevAnswer | undefined, fallback: number) => (typeof a?.noul === "number" ? a.noul : fallback);
/** "open notepad and type hello", "then", "after that": more than one step. */
const COMPOUND = /\b(?:and then|then|after that|and (?:type|write|search|click|send|message|open|play|save|close|find|copy|paste|tell|put|make))\b/;

/** Resolve Jev's answers to one intent id ("pc.volume_down", "os_page", "skill.timer") with a confidence. */
export function resolveIntent(answers: JevAnswers, skills: RouterSkill[] = []): { intent: string; confidence: number } {
  if (answers.intent) {
    const intent = answers.intent.choice ?? "brain";
    if (intent.startsWith("skill.")) {
      const sub = pickChoice(answers.skill);
      return { intent, confidence: Math.min(conf(answers.intent), sub && `skill.${sub}` === intent ? 1 : 0.5) };
    }
    if (intent === "routine") {
      const routine = pickChoice(answers.routine);
      return routine ? { intent: `routine.${routine}`, confidence: Math.min(conf(answers.intent), conf(answers.routine)) } : { intent, confidence: 0 };
    }
    return { intent, confidence: conf(answers.intent) };
  }
  const category = answers.category?.choice ?? "brain";
  const c = conf(answers.category);
  const sub = (name: string, prefix: string) => {
    const choice = pickChoice(answers[name]);
    return choice ? { intent: `${prefix}.${choice}`, confidence: Math.min(c, conf(answers[name])) } : { intent: prefix, confidence: 0 };
  };
  if (category === "pc") return sub("pc_action", "pc");
  if (category === "browser") return sub("browser_action", "browser");
  if (category === "routine") return sub("routine", "routine");
  if (category === "skill") return skills.length ? sub("skill", "skill") : { intent: "brain", confidence: 0 };
  return { intent: category, confidence: c };
}

/** The tool call for a resolved intent, or a reason it can't be filled in. */
export function buildCall(
  intent: string,
  text: string,
  answers: JevAnswers,
  context: { apps: StartApp[]; skills: RouterSkill[] },
): ToolCallSpec | { status: true } | { miss: string } {
  const utterance = text.trim().slice(0, 2000);
  const [head, action] = intent.split(".");
  switch (head) {
    case "pc": {
      if (action === "open_app") {
        // "…so you can control it": opened for Jarvis to drive, through its debugging port.
        const drive = driveAppIntent(text);
        if (drive) return { name: "pc_act", arguments: { action: "drive_app", target: drive.app } };
        const app = extractApp(text, context.apps);
        if (app) return { name: "pc_act", arguments: { action: "open_app", target: app.name } };
        const web = extractWebApp(text);
        return web ? { name: "open_url", arguments: { url: web } } : { miss: "no installed app matched" };
      }
      if (action === "open_folder") {
        const folder = extractFolder(text);
        return folder ? { name: "pc_act", arguments: { action: "open_folder", target: folder } } : { miss: "no folder named" };
      }
      if (action === "next" || action === "previous" || action === "play_pause") return { name: "pc_act", arguments: { action: "media", target: action } };
      if (action === "volume_up" || action === "volume_down") return { name: "pc_act", arguments: { action: "volume", target: action.slice(7) } };
      if (action === "mute") return { name: "pc_act", arguments: { action: "volume", target: "mute" } };
      if (action === "lock") return { name: "pc_act", arguments: { action: "lock" } };
      return { miss: "no pc action" };
    }
    case "browser": {
      if (action === "click") {
        const target = extractClickTarget(text);
        return target ? { name: "browser_act", arguments: { action: "click", target } } : { miss: "no click target" };
      }
      if (action === "search") {
        const words = extractSearch(text);
        return words ? { name: "browser_act", arguments: { action: "search", target: words } } : { miss: "no search words" };
      }
      if (action && action in BROWSER_ACTIONS) return { name: "browser_act", arguments: { action } };
      return { miss: "no browser action" };
    }
    case "os_page": {
      const page = extractPage(text, pickChoice(answers.page), conf(answers.page));
      return page ? { name: "navigate", arguments: { path: page } } : { miss: "no page named" };
    }
    case "website": {
      const site = extractSite(text, pickChoice(answers.site), conf(answers.site));
      return site ? { name: "open_url", arguments: { url: site } } : { miss: "no site named" };
    }
    case "search": {
      // The exact words he said, by code (round 10): Jev chose "search"; it never writes the query.
      const query = searchQueryIn(text);
      return query ? { name: "open_url", arguments: { url: googleSearchUrl(query) } } : { miss: "no search words" };
    }
    case "screen": {
      const listen = noul(answers.listen, 0) >= 0.5 || /\b(say|said|saying|hear|heard|listen|talking about)\b/i.test(text);
      return { name: "screen", arguments: { question: utterance.slice(0, 1000), listen } };
    }
    case "status":
      return { status: true };
    case "routine":
      return action && (PROTOCOLS as readonly string[]).includes(action) ? { name: "protocol", arguments: { name: action } } : { miss: "no routine" };
    case "skill": {
      const skill = context.skills.find((s) => s.id === intent.slice(6));
      const call = skill?.extract(text) ?? null;
      return call ?? { miss: "skill slots not filled" };
    }
    case "emails":
      return { name: "get_recent_emails", arguments: {} };
    case "memory":
      return { name: "search_memory", arguments: { query: utterance } };
    case "workspace":
      return { name: "ask_workspace", arguments: { request: utterance } };
    case "cad":
      return { name: "cad", arguments: { spec: utterance.slice(0, 600) } };
    case "hermes":
      return { name: "control_pc", arguments: { task: utterance } };
    case "screen_act":
      return { name: "screen_act", arguments: { goal: utterance.slice(0, 600) } };
    case "screen_teach": {
      const lesson = lessonIntent(text);
      return { name: "screen_teach", arguments: { goal: (lesson?.goal ?? utterance).slice(0, 400), mode: lesson?.mode ?? "teach" } };
    }
    default:
      return { miss: "brain" };
  }
}

export function routerHint(intent: string, confidence: number, answers: JevAnswers) {
  const bits = [`likely ${intent} (${Math.round(confidence * 100)}%)`];
  const page = pickChoice(answers.page), site = pickChoice(answers.site);
  if (intent === "os_page" && page) bits.push(`page ${page}`);
  if (intent === "website" && site) bits.push(`site ${site}`);
  if (noul(answers.outbound, 0) >= 0.5) bits.push("consequential: needs his yes");
  if (noul(answers.complete, 1) < 0.6) bits.push("he may not have finished speaking");
  return `Fast decision layer (Jev): ${bits.join("; ")}.`;
}

/** Pure decision from Jev's answers: thresholds, safety gates and extractors. */
export function decide(
  text: string,
  answers: JevAnswers,
  context: { apps: StartApp[]; skills: RouterSkill[]; ms: number; cached: boolean; sharing?: boolean },
): RouteDecision {
  const { intent, confidence } = resolveIntent(answers, context.skills);
  const outbound = noul(answers.outbound, 0), multi = noul(answers.multi, 0), complete = noul(answers.complete, 1);
  const trace: RouteTrace = { intent, confidence, ms: context.ms, cached: context.cached, outbound, complete, multi };
  const brain = (reason: string): RouteDecision => ({ kind: "brain", hint: routerHint(intent, confidence, answers), trace: { ...trace, reason } });
  if (intent === "brain") return brain("jev chose the brain");
  // Naming WhatsApp trips the code gate even for "I need WhatsApp up"; only opening the app itself
  // may pass, and only when nothing else in the words is outbound.
  if (needsConfirmation(text) && (outboundBeyondApps(text) || intent !== "pc.open_app")) return brain("outbound (code gate)");
  if (outbound > OUTBOUND_MAX) return brain("outbound (jev)");
  if (complete < COMPLETE_MIN) return brain("incomplete");
  const tier = tierOf(intent, context.skills);
  if (confidence < (intent === "hermes" ? HERMES_MIN : THRESHOLDS[tier])) return brain(`below ${intent === "hermes" ? "hermes" : tier} threshold`);
  // A single instant action can't satisfy "open X and type Y"; that is Hermes' or the brain's.
  // (A routine, the status report and a screen question are one request however they're worded.)
  const single = !["hermes", "status", "screen", "screen_act", "screen_teach"].includes(intent) && !intent.startsWith("routine.");
  // "Open Google and search for X" is ONE search (the exact rules read it as one step), not a multi-step task.
  const oneSearch = intent === "search" && (linkedSteps(text)?.length ?? 1) === 1;
  if (single && !oneSearch && (multi > MULTI_MAX || COMPOUND.test(text.toLowerCase()))) return brain("multi-step");
  const call = buildCall(intent, text, answers, context);
  if ("miss" in call) return brain(call.miss);
  if ("status" in call) return { kind: "status", trace };
  // While he shares his screen, "the page" is the one he's showing, not Jarvis Chrome: page
  // actions become screen_act, and play/pause the media key (works for any browser's video).
  if (context.sharing && call.name === "browser_act") {
    if (call.arguments.action === "pause" || call.arguments.action === "play") return { kind: "act", call: { name: "pc_act", arguments: { action: "media", target: "play_pause" } }, trace };
    if (call.arguments.action !== "new_tab") return { kind: "act", call: { name: "screen_act", arguments: { goal: text.trim().slice(0, 600) } }, trace };
  }
  return { kind: "act", call, trace };
}

export type RouterOptions = {
  key: string;
  request?: typeof fetch;
  apps?: StartApp[];
  skills?: RouterSkill[];
  design?: Design;
  /** Pass null to disable caching (benchmark calibration). */
  cache?: DecisionCache | null;
  timeoutMs?: number;
  /** His shorthand entries used in this utterance ("yt = YouTube"). */
  shorthand?: string[];
  /** Screen sharing is on: page actions mean the screen he's showing (screen_act). */
  sharing?: boolean;
};

const sharedCache = new DecisionCache();

/**
 * Route one fresh utterance. Never throws: no key, a slow or failed Jev call, or anything unclear
 * returns { kind: "brain" }.
 */
export async function routeUtterance(text: string, options: RouterOptions): Promise<RouteDecision> {
  const apps = options.apps ?? [];
  const skills = options.skills ?? [];
  if (!text.trim()) return { kind: "brain", hint: "", trace: null };
  // The code gate first: outbound/destructive words never reach an instant action, and they don't
  // need a Jev round trip to be sent to the brain (which hands them to control_pc's gate).
  if (outboundBeyondApps(text)) return { kind: "brain", hint: "Fast decision layer (Jev): consequential: needs his yes.", trace: null, gate: "outbound" };
  const key = normaliseUtterance(text);
  const cache = options.cache === undefined ? sharedCache : options.cache;
  const hit = cache?.get(`${options.design ?? "tree"}:${key}`);
  if (hit) return decide(text, hit, { apps, skills, ms: 0, cached: true, sharing: options.sharing });
  if (!options.key) return { kind: "brain", hint: "", trace: null, unavailable: "no-key" };
  const askOptions = { request: options.request, skills, design: options.design, timeoutMs: options.timeoutMs, shorthand: options.shorthand };
  const asked = await askJev(text, options.key, askOptions);
  if (!asked) return { kind: "brain", hint: "", trace: null, unavailable: "error" };
  cache?.set(`${options.design ?? "tree"}:${key}`, asked.answers);
  // Shadow mode (LAYA_URL, opt-in): asks Laya the same question in parallel, purely to measure
  // agreement/latency. Never awaited, never on the decision path — see scripts/laya-shadow.ts.
  shadowAskLaya(text, askOptions, asked);
  return decide(text, asked.answers, { apps, skills, ms: asked.ms, cached: false, sharing: options.sharing });
}

/**
 * Keeps the TLS connection to TypeSafe open while he's talking to Jarvis. Measured 24 Sep: a cold
 * request took 683 ms, a warm one ~300 ms, and after 60 s idle 463 ms; with an unauthenticated
 * HEAD to the API host every 10 s (free: it 404s, no key is sent) a call after 60 s took 254 ms.
 * Pings only for ACTIVE_MS after the last routed turn, so an idle OS makes no requests.
 */
export class JevWarmer {
  private last = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private request: typeof fetch = fetch,
    private intervalMs = 20_000,
    private activeMs = 10 * 60_000,
    private now: () => number = Date.now,
    /**
     * The API hosts to keep warm (origins, pinged with an unauthenticated HEAD). The voice engine
     * adds Groq and the chosen voice's host: 24 Sep, Groq after 60 s idle 344 ms vs 219 ms kept
     * warm; ElevenLabs' first request of a session 618 ms cold vs ~250 ms warm.
     */
    private hosts: () => string[] = () => [new URL(JEV_URL).origin],
  ) {}
  /** Call on every turn; starts the pings if they aren't running. */
  touch() {
    this.last = this.now();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
  async tick() {
    if (this.now() - this.last > this.activeMs) return this.stop();
    await Promise.all(this.hosts().map((origin) => this.request(`${origin}/`, { method: "HEAD", signal: AbortSignal.timeout(3000) }).catch(() => null)));
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  get running() {
    return this.timer !== null;
  }
}

export const SPECULATIVE_MIN = 0.9;

/**
 * Acting before he finishes speaking (partial transcripts): only show-only, instantly reversible
 * calls (an OS page or a website), at 0.9 confidence, a request that already sounds complete and
 * negligible stakes. Routing the partial through the router also warms the decision cache, so the
 * final turn for the same words costs no Jev round trip.
 */
export function speculativeCall(decision: RouteDecision): ToolCallSpec | null {
  if (decision.kind !== "act") return null;
  const t = decision.trace;
  if (t.confidence < SPECULATIVE_MIN || t.complete < 0.8 || t.outbound >= 0.2) return null;
  return decision.call.name === "navigate" || decision.call.name === "open_url" ? decision.call : null;
}

/** Warm the cache from a partial transcript, so the final turn usually costs no round trip. */
export async function prefetchRoute(text: string, options: RouterOptions) {
  if (!text.trim() || outboundBeyondApps(text) || !options.key) return;
  const cache = options.cache === undefined ? sharedCache : options.cache;
  const key = `${options.design ?? "tree"}:${normaliseUtterance(text)}`;
  if (!cache || cache.get(key)) return;
  const asked = await askJev(text, options.key, { request: options.request, skills: options.skills, design: options.design, timeoutMs: options.timeoutMs, shorthand: options.shorthand });
  if (asked) cache.set(key, asked.answers);
}
