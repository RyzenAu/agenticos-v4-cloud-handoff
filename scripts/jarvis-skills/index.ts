// Jarvis's everyday instant skills, answered by rules and local code with no model call:
// timers/alarms/reminders, time and date, maths and units (and currency, with live rates),
// system info, clipboard, quick notes, dictation, window management, plus agent alerts.
//
// Routing: free-voice.ts calls skillIntent() right after its other rules; a match becomes one
// call to the rules-only `skill` tool, the voice client POSTs it to /__operator/jarvis/skill, and
// the returned line is spoken as-is (no second model call).
//
// Safety: nothing here sends, dials, deletes, pays or deploys. Typing happens only on an explicit
// "type"/"dictate". Clipboard and notes never read anything that looks like a secret aloud.
import { answerAskBack, createScheduler, timerIntent, type AskBack, type TimerRequest } from "./timers";
import { createReminderTasks, type ReminderTaskHost } from "../windows/reminder-tasks";
import { answerCurrency, answerMaths, answerTime, answerUnits, convertIntent, mathsIntent, timeIntent, TIME_ZONES, type CurrencyRequest, type MathsRequest, type TimeRequest, type UnitsRequest } from "./time-maths";
import { answerSystem, systemIntent, type SystemAction, type SystemRequest } from "./system-info";
import { answerClipboard, clipboardIntent, type ClipboardRequest } from "./clipboard";
import { createNotes, notesIntent, type NotesRequest } from "./notes";
import { answerType, typeIntent, MAX_TYPED, type TypeRequest } from "./dictation";
import { answerFileJob, fileJobIntent, type FileJobRequest } from "./pc-files";
import { isPlace } from "./places";
import { answerCapabilities, capabilitiesIntent, type CapabilitiesRequest } from "./capabilities";
import { answerSkillCandidates, skillCandidatesIntent, type SkillCandidatesRequest } from "./skill-candidates";
import { answerDeploys, answerFiles, answerSettings, deploysIntent, filesIntent, settingsIntent, type DeploysRequest, type FilesRequest, type SettingsRequest } from "./pc-control";
import { answerWindow, windowIntent, type WindowAction, type WindowDeps, type WindowRequest } from "./windows";
import type { ScreenName } from "./monitors";
import { answerWeather, weatherIntent, type WeatherRequest } from "./weather";
import { answerFinance, financeIntent, type FinanceRequest } from "./finance";
import { createStripeSync } from "../finance/stripe";
import { aiUsageIntent, answerAiUsage, answerAiUsageAtDesk, type AiUsageRequest } from "../ai-usage/jarvis-intent";
import { aiUsageSnapshot } from "../ai-usage/plugin";
import { receptionistIntent, type ReceptionistRequest } from "../receptionist/jarvis-intent";
import { receptionistSentence } from "../receptionist/plugin";
import { inboxAnswerFromLog, inboxIntent, type InboxRequest } from "../inbox-triage/jarvis-intent";
import { createAgentWatch, type AgentWatchOptions } from "./agent-watch";
import { createPsHost, type PsHost } from "./ps-host";
import { sir } from "./text";
import { UNITS, CURRENCIES } from "./time-maths";
import { BROWSER_ACTIONS, browserSkillIntent, PAGE_ACTIONS, type BrowserSkillRequest } from "../j2/intents";
import type { BrowserHands } from "../j2/agent-browser";
import type { BrowserSkillDeps } from "../j2/browser-skill";
import type { WeatherCity } from "../business-today";

export type SkillRequest =
  | TimerRequest
  | TimeRequest
  | MathsRequest
  | UnitsRequest
  | CurrencyRequest
  | SystemRequest
  | ClipboardRequest
  | NotesRequest
  | TypeRequest
  | WindowRequest
  | WeatherRequest
  | FinanceRequest
  | AiUsageRequest
  | ReceptionistRequest
  | InboxRequest
  | SettingsRequest
  | DeploysRequest
  | FilesRequest
  | FileJobRequest
  | CapabilitiesRequest
  | SkillCandidatesRequest
  | BrowserSkillRequest;
export type SkillName = SkillRequest["skill"];
export const SKILL_NAMES = ["timer", "reminder", "time", "maths", "units", "currency", "system", "clipboard", "notes", "type", "window", "weather", "finance", "receptionist", "ai_usage", "inbox", "settings", "deploys", "files", "filejob", "capabilities", "skill_candidates", "browser"] as const;
/** Skills someone signed in from another device may use: pure answers that touch nothing on this
 *  PC. Finance and ai_usage are deliberately left out even though they're read-only — they're
 *  money figures, not the kind of thing to hand to whoever else is signed in remotely. */
export const REMOTE_SAFE = new Set<SkillName>(["time", "maths", "units", "currency", "weather"]);

export type SkillContext = {
  /** Jarvis's last spoken answer, for "copy that". */
  lastAnswer?: string;
  /** His previous request and Jarvis's reply to it, to finish an ask-back ("morning or evening?"). */
  previousUser?: string;
  lastAssistant?: string;
};

/**
 * Deterministic: a skill request, a one-line question back ({ skill: "say" }), or null to let the
 * other tiers have it. Order matters: the most specific grammars go first.
 */
export function skillIntent(utterance: string, context: SkillContext = {}): SkillRequest | AskBack | null {
  if (!utterance || utterance.length > 2100) return null;
  if (context.previousUser && context.lastAssistant) {
    const answered = answerAskBack(utterance, context.previousUser, context.lastAssistant);
    if (answered) return answered;
  }
  return (
    // AI spend/limits before the general finance intent: "what's my ai spend this month" must
    // not fall into the bank's generic "spend ... this month" pattern (see docs/AI-USAGE.md).
    // "What can you do on my PC?": from the real routes and the last end-to-end check-up.
    capabilitiesIntent(utterance) ??
    // "What skills should I build?": last night's Dream skill-candidate pass, read back.
    skillCandidatesIntent(utterance) ??
    receptionistIntent(utterance) ??
    aiUsageIntent(utterance) ??
    financeIntent(utterance) ??
    // Inbox triage log (scripts/inbox-triage): "what's in my inbox", "anything important", "any client emails".
    inboxIntent(utterance) ??
    typeIntent(utterance) ??
    // Bluetooth/Wi-Fi/notifications/new folder, and the Vercel deploy status: direct, no Hermes.
    settingsIntent(utterance) ??
    deploysIntent(utterance) ??
    filesIntent(utterance) ??
    fileJobIntent(utterance) ??
    notesIntent(utterance) ??
    timerIntent(utterance) ??
    timeIntent(utterance) ??
    convertIntent(utterance) ??
    mathsIntent(utterance) ??
    systemIntent(utterance) ??
    clipboardIntent(utterance, context.lastAnswer ?? "") ??
    windowIntent(utterance) ??
    // J2: everyday browser commands (agent-browser in Jarvis Chrome).
    // (Only the ones that open something: a page action depends on what he's looking at, which the voice rules check.)
    ((b) => (b && !PAGE_ACTIONS.has(b.action) ? b : null))(browserSkillIntent(utterance)) ??
    weatherIntent(utterance)
  );
}

// --- validating what the client sends back ------------------------------------------------------
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function fail(): never {
  throw new Error("That isn't a skill I know.");
}

/** Strict validation of POST /jarvis/skill: only known skills, actions and bounded values. */
export function parseSkillRequest(body: unknown): SkillRequest {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const action = b.action;
  switch (b.skill) {
    case "browser": {
      // J2: the agent-browser hands in Jarvis Chrome (scripts/j2). Plain http(s) pages only.
      if (!BROWSER_ACTIONS.includes(action as BrowserSkillRequest["action"])) fail();
      const url = str(b.url, 2000);
      if (action === "open" && (!url || !/^https?:\/\/\S+$/i.test(url))) fail();
      const engine = b.engine === "youtube" ? "youtube" : b.engine === "google" ? "google" : undefined;
      const query = str(b.query, 200);
      const target = str(b.target, 80);
      if (action === "search" && !query) fail();
      if (action === "click" && !target) fail();
      // J6: a multi-step goal is a sentence (the shape is worked out again on the server, never taken from the client).
      const goal = str(b.goal, 200);
      if ((action === "task" || action === "task_here") && !goal) fail();
      return {
        skill: "browser",
        action: action as BrowserSkillRequest["action"],
        ...(goal && (action === "task" || action === "task_here") ? { goal } : {}),
        ...(url && action === "open" ? { url } : {}),
        ...(str(b.name, 60) ? { name: str(b.name, 60) } : {}),
        ...(action === "search" ? { engine: engine ?? "google", query, ...(b.firstResult === true ? { firstResult: true } : {}) } : {}),
        ...(action === "scroll" ? { dir: b.dir === "up" ? ("up" as const) : ("down" as const) } : {}),
        ...(action === "click" ? { target } : {}),
      };
    }
    case "timer": {
      if (action === "start") {
        const seconds = int(b.seconds, 1, 24 * 3600);
        const phrase = str(b.phrase, 60);
        if (!seconds || !phrase) fail();
        const label = str(b.label, 30);
        return { skill: "timer", action, seconds, phrase, ...(label ? { label } : {}) };
      }
      if (action === "alarm") {
        const clock = parseClockSpec(b.clock);
        const label = str(b.label, 30);
        return { skill: "timer", action, clock, ...(label ? { label } : {}) };
      }
      if (action === "cancel") {
        const kind = ["timer", "alarm", "reminder", "any"].includes(b.kind as string) ? (b.kind as "timer") : fail();
        const match = str(b.match, 80);
        return { skill: "timer", action, kind, ...(b.all === true ? { all: true } : {}), ...(match ? { match } : {}) };
      }
      if (action === "left") return { skill: "timer", action };
      fail();
    }
    case "reminder": {
      if (action === "list") return { skill: "reminder", action };
      if (action !== "set") fail();
      const text = str(b.text, 200) ?? fail();
      const about = b.about === true ? { about: true } : {};
      if (b.seconds !== undefined) return { skill: "reminder", action, text, seconds: int(b.seconds, 1, 30 * 86400) ?? fail(), ...about };
      return { skill: "reminder", action, text, clock: parseClockSpec(b.clock), ...about };
    }
    case "time": {
      if (action === "now") {
        const place = str(b.place ?? b.city, 40)?.toLowerCase();
        return { skill: "time", action, ...(place && place in TIME_ZONES ? { place } : {}) };
      }
      if (action === "date") return { skill: "time", action };
      if (action === "weekday_of") {
        const day = int(b.day, 1, 31) ?? fail();
        const month = b.month === undefined ? undefined : (int(b.month, 1, 12) ?? fail());
        const year = b.year === undefined ? undefined : (int(b.year, 1900, 2200) ?? fail());
        const claimed = b.claimed === undefined ? undefined : (int(b.claimed, 0, 6) ?? fail());
        return { skill: "time", action, day, ...(month ? { month } : {}), ...(year ? { year } : {}), ...(b.past === true ? { past: true } : {}), ...(claimed !== undefined ? { claimed } : {}) };
      }
      if (action === "find_weekday") return { skill: "time", action, weekday: int(b.weekday, 0, 6) ?? fail(), day: int(b.day, 1, 31) ?? fail() };
      if (action === "date_of") return { skill: "time", action, weekday: int(b.weekday, 0, 6) ?? fail(), ...(b.next === true ? { next: true } : {}) };
      fail();
    }
    case "maths": {
      const expr = str(b.expr, 200);
      if (action !== "calc" || !expr || !/^[\d.\s+\-*/^()sqrt]+$/.test(expr)) fail();
      return { skill: "maths", action, expr, said: str(b.said, 120) ?? expr };
    }
    case "units": {
      const value = num(b.value);
      if (action !== "convert" || value === undefined || !Object.hasOwn(UNITS, String(b.from)) || !Object.hasOwn(UNITS, String(b.to))) fail();
      return { skill: "units", action, value, from: String(b.from), to: String(b.to) };
    }
    case "currency": {
      const amount = num(b.amount);
      if (action !== "convert" || amount === undefined || !Object.hasOwn(CURRENCIES, String(b.from)) || !Object.hasOwn(CURRENCIES, String(b.to))) fail();
      return { skill: "currency", action, amount, from: String(b.from), to: String(b.to) };
    }
    case "system": {
      const actions: SystemAction[] = ["battery", "cpu", "memory", "cpu_memory", "disk", "ip", "internet"];
      if (!actions.includes(action as SystemAction)) fail();
      return { skill: "system", action: action as SystemAction };
    }
    case "clipboard": {
      if (action === "read") return { skill: "clipboard", action };
      if (action === "copy") return { skill: "clipboard", action, text: typeof b.text === "string" ? b.text.slice(0, 4000) : "" };
      fail();
    }
    case "notes": {
      if (action === "read") return { skill: "notes", action };
      if (action === "add") return { skill: "notes", action, text: str(b.text, 500) ?? fail() };
      fail();
    }
    case "type": {
      if (action !== "type") fail();
      const app = str(b.app, 60);
      return { skill: "type", action, text: str(b.text, MAX_TYPED) ?? fail(), ...(app ? { app } : {}) };
    }
    case "settings": {
      if (action === "radio" && (b.radio === "bluetooth" || b.radio === "wifi") && typeof b.on === "boolean") return { skill: "settings", action, radio: b.radio, on: b.on };
      if (action === "notifications" && typeof b.on === "boolean") return { skill: "settings", action, on: b.on };
      if (action === "theme" && typeof b.dark === "boolean") return { skill: "settings", action, dark: b.dark };
      if (action === "clipboard_history") return { skill: "settings", action };
      if (action === "folder" && isPlace(b.where)) {
        const name = str(b.name, 60);
        if (!name || !/^[\w][\w .,'()&+-]{0,59}$/.test(name) || name.includes("..")) fail();
        return { skill: "settings", action, name, where: b.where };
      }
      fail();
    }
    case "capabilities":
      return { skill: "capabilities", action: action === "show" ? "show" : "say" };
    case "skill_candidates":
      return { skill: "skill_candidates", action: "say" };
    case "filejob": {
      const place = (v: unknown) => (isPlace(v) ? v : fail());
      const file = (v: unknown) => (typeof v === "string" && /^[\w][\w .()&+,'-]{0,80}\.[a-z0-9]{1,5}$/i.test(v) ? v : fail());
      if (action === "zip") return { skill: "filejob", action, folder: place(b.folder) };
      if (action === "copy" || action === "move") return { skill: "filejob", action, file: file(b.file), from: place(b.from), to: place(b.to) };
      if (action === "pdf") return { skill: "filejob", action, file: file(b.file), from: place(b.from) };
      if (action === "screenshot") return { skill: "filejob", action, ...(b.to !== undefined ? { to: place(b.to) } : {}) };
      if (action === "excel_sum") return { skill: "filejob", action, column: str(b.column, 60) ?? fail() };
      if (action === "word_format" && (b.which === "first" || b.which === "last") && ["bold", "italic", "underline"].includes(b.style as string))
        return { skill: "filejob", action, which: b.which, style: b.style as "bold" | "italic" | "underline" };
      fail();
    }
    case "files": {
      if (action === "undo_rename") return { skill: "files", action };
      const folder = str(b.folder, 120);
      if (action !== "rename_by_date" || !folder || !isPlace(folder) || !["screenshots", "photos", "all"].includes(b.kind as string)) fail();
      return { skill: "files", action, folder, kind: b.kind as "screenshots" | "photos" | "all" };
    }
    case "deploys": {
      if (action !== "latest") fail();
      const project = str(b.project, 60);
      return { skill: "deploys", action, ...(project && /^[a-z0-9-]+$/.test(project) ? { project } : {}) };
    }
    case "window": {
      const actions: WindowAction[] = ["show_desktop", "restore_all", "switch", "maximise", "minimise", "restore", "snap_left", "snap_right", "bring", "move", "where", "open_tab"];
      if (!actions.includes(action as WindowAction)) fail();
      if (action === "switch") return { skill: "window", action, target: str(b.target, 60) ?? fail() };
      if (action === "open_tab") {
        const screens: ScreenName[] = ["main", "other", "left", "right", "top", "bottom", "third"];
        return { skill: "window", action, screen: screens.includes(b.screen as ScreenName) ? (b.screen as ScreenName) : "main" };
      }
      if (action === "bring" || action === "move" || action === "where") {
        const screens: ScreenName[] = ["main", "other", "left", "right", "top", "bottom", "third"];
        const screen = screens.includes(b.screen as ScreenName) ? (b.screen as ScreenName) : undefined;
        if (action === "move" && !screen) fail();
        return { skill: "window", action, target: str(b.target, 60) ?? "front", ...(screen ? { screen } : {}) };
      }
      return { skill: "window", action: action as WindowAction };
    }
    case "weather": {
      if (action !== "report") fail();
      const focus = b.focus === "rain" ? "rain" : b.focus === "conditions" ? "conditions" : fail();
      const when = b.when === "now" || b.when === "today" || b.when === "tomorrow" ? b.when : fail();
      const city = str(b.city, 80);
      return { skill: "weather", action, focus, when, ...(city ? { city } : {}) };
    }
    case "finance": {
      if (b.source === "stripe") {
        const stripeKinds = ["outstanding-invoices", "overdue-invoices", "next-payout"];
        const kind = stripeKinds.includes(b.kind as string) ? (b.kind as "outstanding-invoices" | "overdue-invoices" | "next-payout") : fail();
        return { skill: "finance", source: "stripe", kind };
      }
      if (b.source !== "nab") fail();
      if (b.kind === "spend-category") {
        const category = str(b.category, 40) ?? fail();
        return { skill: "finance", source: "nab", kind: "spend-category", category };
      }
      const nabKinds = ["income-today", "income-week", "income-month", "balance", "paid-invoices", "spend-week", "spend-month"];
      const kind = nabKinds.includes(b.kind as string) ? (b.kind as "income-today" | "income-week" | "income-month" | "balance" | "paid-invoices" | "spend-week" | "spend-month") : fail();
      return { skill: "finance", source: "nab", kind };
    }
    case "ai_usage": {
      if (b.action === "spend") {
        const provider = b.provider === "anthropic" || b.provider === "openai" ? b.provider : undefined;
        const deskText = str(b.deskText, 300);
        return { skill: "ai_usage", action: "spend", ...(provider ? { provider } : {}), ...(b.wontPay === true ? { wontPay: true as const } : {}), ...(deskText ? { deskText } : {}) };
      }
      if (b.action === "codex" || b.action === "claude") return { skill: "ai_usage", action: b.action };
      fail();
    }
    case "receptionist": {
      if (b.action === "status") return { skill: "receptionist", action: "status" };
      fail();
    }
    case "inbox": {
      if (b.action === "summary" || b.action === "important" || b.action === "clients") return { skill: "inbox", action: b.action };
      fail();
    }
  }
  fail();
}
function parseClockSpec(value: unknown) {
  const c = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const hour = int(c.hour, 0, 23),
    minute = int(c.minute, 0, 59);
  if (hour === undefined || minute === undefined) fail();
  const day = c.day === "today" || c.day === "tomorrow" ? c.day : null;
  return { hour, minute, day } as const;
}

// --- running them --------------------------------------------------------------------------------
export type SkillResult = { ok: boolean; said: string; ms: number; skill?: string; /** What the conversation history stores instead of said (a page read aloud: never the page's words). */ keep?: string };
export type SkillDeps = {
  events: { submit: (body: unknown) => unknown };
  now?: () => number;
  fetch?: typeof fetch;
  ps?: PsHost;
  vault?: () => string | null;
  agents?: Omit<AgentWatchOptions, "submit">;
  /** The dashboard's default weather city (profile, then time zone) — same rule as the daily brief. */
  city?: () => WeatherCity | undefined;
  /** Windows-native backup reminders (Task Scheduler). Defaults to the real thing, same pattern as `ps`. */
  reminderTasks?: ReminderTaskHost;
  /** Window skill overrides (tests: a fake Jarvis Chrome), same pattern as `ps`. */
  windows?: WindowDeps;
  /** J2 browser hands (tests: a CDP stub runner; default: agent-browser against Jarvis Chrome). */
  browser?: { hands?: BrowserHands; ensure?: () => Promise<boolean>; task?: BrowserSkillDeps["task"] };
  /**
   * Desk payments (P1): the payment part of "what's my AI spend, and pay it", for a caller the host verified at his desk.
   * Without it (or without the desk) the spend answer says what it always said: it reads, it never pays.
   */
  deskPayment?: { compound(text: string): Promise<string> };
};

export function createJarvisSkills(root: string, deps: SkillDeps) {
  const now = deps.now ?? Date.now;
  const ps = deps.ps ?? createPsHost();
  /** The window skill's helpers: launch an app, open a Jarvis Chrome tab, find and activate Jarvis Chrome's tab. */
  const windowDeps = (): WindowDeps => ({
    launch: async (app) => {
      const { pcAct } = await import("../pc-hands");
      return (await pcAct({ action: "open_app", target: app })).said;
    },
    // "Open a Chrome tab": a tab in Jarvis Chrome, then its window is put on his screen (J-fix).
    newTab: async () => {
      const { act } = await import("../browser-hands");
      const r = await act(root, { action: "new_tab" });
      return { ok: r.ok, said: r.said };
    },
    jarvisChromePid: async () => (await import("../browser-hands")).jarvisChromePid(),
    activateTab: async (id) => (await import("../browser-hands")).activateJarvisTab(id),
    ...deps.windows,
  });
  let hands: BrowserHands | null | undefined;
  /** agent-browser against Jarvis Chrome (its native binary; null when it isn't installed). */
  const defaultHands = async (): Promise<BrowserHands | null> => {
    if (hands !== undefined) return hands;
    const { agentBrowserExe, createAgentBrowserHands, spawnRunner } = await import("../j2/agent-browser");
    const exe = agentBrowserExe();
    hands = exe ? createAgentBrowserHands({ run: spawnRunner(exe) }) : null;
    return hands;
  };
  /**
   * J6: what the browser task loop needs beyond the hands: the free brain for goals the rules don't know (only built when a
   * task actually runs), and one short "Still working." through the event gate when a step is slow.
   */
  let taskDeps: BrowserSkillDeps["task"] | undefined;
  const defaultTask = async (): Promise<BrowserSkillDeps["task"]> => {
    if (taskDeps) return taskDeps;
    const { createTaskDecider } = await import("../j2/task-brain");
    taskDeps = {
      decide: createTaskDecider({ root }),
      progress: (line) => {
        try {
          deps.events.submit({ source: "jarvis-browser", text: line, priority: "normal", dedupeKey: `browser-task:${now()}`, expiresAt: new Date(now() + 20_000).toISOString() });
        } catch {
          /* the event gate refused it: the answer still comes */
        }
      },
    };
    return taskDeps;
  };
  const reminderTasks = deps.reminderTasks ?? createReminderTasks(root);
  const scheduler = createScheduler(root, { now, submit: (body) => deps.events.submit(body), tasks: reminderTasks });
  const notes = createNotes({ vault: deps.vault, now });
  const watch = deps.agents ? createAgentWatch({ ...deps.agents, submit: (alert) => deps.events.submit(alert) }) : null;
  // Lazy handles (audit A-M2): booting skills opens nothing. Bank questions read the NAB CSV store
  // (finance-manual.sqlite) only if it exists; Stripe opens only its own stripe_* tables on the first
  // finance answer. close() below releases whatever was opened: on Windows a still-open bun:sqlite
  // handle blocks rmSync of a temp test directory (EBUSY), the same class of issue as the FTS5 note.
  const stripe = createStripeSync(root);

  /** `desk`: the HOST verified the caller is the owner at his desk (scripts/desk-payments/policy.ts). Never from the request body. */
  async function answer(req: SkillRequest, ctx: { desk?: boolean } = {}): Promise<string | { said: string; keep?: string }> {
    switch (req.skill) {
      case "timer":
      case "reminder":
        return scheduler.handle(req);
      case "time":
        return answerTime(req, now());
      case "maths":
        return answerMaths(req);
      case "units":
        return answerUnits(req);
      case "currency":
        return answerCurrency(req, deps.fetch);
      case "system":
        return answerSystem(req, { ps, fetch: deps.fetch });
      case "clipboard":
        return answerClipboard(req, ps);
      case "notes":
        return notes.handle(req);
      case "type":
        return answerType(req, ps);
      case "window":
        // "Bring up Spotify" with no Spotify window open: it's launched instead.
        return answerWindow(req, ps, windowDeps());
      case "browser": {
        // J2: agent-browser in Jarvis Chrome, then its window forward on his main screen, and where it is.
        const hands = deps.browser?.hands ?? (await defaultHands());
        if (!hands) return "My browser hands (agent-browser) aren't installed on this PC, so nothing opened.";
        const { runBrowserSkillDetailed } = await import("../j2/browser-skill");
        return runBrowserSkillDetailed(req, {
          hands,
          task: deps.browser?.task ?? (await defaultTask()),
          desk: ctx.desk === true,
          present: () => answerWindow({ skill: "window", action: "bring", target: "front", screen: "main" }, ps, windowDeps()),
          ensure:
            deps.browser?.ensure ??
            (async () => {
              if (hands.port !== 9222) return false;
              const { ensureJarvisChrome } = await import("../browser-hands");
              return ensureJarvisChrome(root);
            }),
        });
      }
      case "settings":
        return answerSettings(req, { ps });
      case "deploys":
        return answerDeploys(req);
      case "files":
        return answerFiles(req, { root });
      case "filejob":
        return answerFileJob(req, { ps });
      case "capabilities": {
        const { SKILL_DESCRIPTIONS } = await import("../jev-router-skills");
        return answerCapabilities(req, { root, skills: SKILL_DESCRIPTIONS });
      }
      case "skill_candidates": {
        const { homedir } = await import("node:os");
        const { join: pathJoin } = await import("node:path");
        return answerSkillCandidates(req, { stateDir: pathJoin(homedir(), ".claude-os") });
      }
      case "weather":
        return answerWeather(req, { fetch: deps.fetch, city: deps.city });
      case "finance":
        return answerFinance(req, { root, stripe });
      case "ai_usage":
        try {
          // At his desk the "I won't pay" notice goes: the spend answer stays, and the payment part is the desk payments'
          // (a confirm card when it names a payee or amount, else one question).
          if (ctx.desk && req.action === "spend" && req.wontPay && deps.deskPayment) return await answerAiUsageAtDesk(req, await aiUsageSnapshot(), deps.deskPayment.compound);
          return answerAiUsage(req, await aiUsageSnapshot());
        } catch {
          return "I couldn't read the usage figures.";
        }
      case "receptionist":
        try { return await receptionistSentence(); } catch { return "I couldn't read the receptionist status."; }
      case "inbox":
        try {
          return inboxAnswerFromLog(root, req, now());
        } catch {
          return "I couldn't read the inbox triage log.";
        }
    }
  }

  return {
    /** POST /jarvis/skill. `remote` is someone signed in from another device. */
    async run(body: unknown, options: { remote?: boolean; desk?: boolean } = {}): Promise<SkillResult> {
      const started = Date.now();
      let req: SkillRequest;
      try {
        req = parseSkillRequest(body);
      } catch (error) {
        return { ok: false, said: sir((error as Error).message), ms: Date.now() - started };
      }
      if (options.remote && !REMOTE_SAFE.has(req.skill))
        return { ok: false, said: "That one only works at the PC itself, sir.", ms: Date.now() - started, skill: req.skill };
      try {
        const out = await answer(req, { desk: options.desk === true && !options.remote });
        const said = typeof out === "string" ? out : out.said;
        return { ok: true, said, ms: Date.now() - started, skill: req.skill, ...(typeof out === "object" && out.keep ? { keep: out.keep } : {}) };
      } catch (error) {
        return { ok: false, said: sir((error as Error).message || "That didn't work"), ms: Date.now() - started, skill: req.skill };
      }
    },
    /** GET /jarvis/timers: what the HUD shows (read-only). */
    timers: () => scheduler.snapshot(),
    start() {
      scheduler.start();
      watch?.start();
      // Warm the Windows helper so the first clipboard/window command is instant too.
      if (process.platform === "win32") setTimeout(() => ps.warm(), 5_000).unref?.();
    },
    close() {
      scheduler.close();
      watch?.close();
      ps.close();
      stripe.close();
    },
  };
}
export type JarvisSkills = ReturnType<typeof createJarvisSkills>;
