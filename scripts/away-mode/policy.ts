// Away mode: the pure rules (no I/O, unit tested).
//
// - neverReason: what Jarvis never does while he's away, even with his approval: banking and
//   finance, money, password managers and credentials, security settings, installing software,
//   messaging other people.
// - approvalReason: what may happen only after his one-time Telegram code: anything that deletes,
//   overwrites, submits, deploys, publishes, restarts or otherwise can't be taken back.
// - classifyTask: the most direct route for a task (built-in file step, a CLI recipe, a screen
//   plan, or Hermes), picked before anything runs.
// - parseTelegram: his commands (/away, /task, /stop, /status, /log, "yes 7F3K").
// - approval codes: short, one-time, case-insensitive, compared in constant time.
// - awayVoiceIntent: "Jarvis, I'm heading out, away mode on".
import { randomInt, timingSafeEqual } from "node:crypto";
import { needsConfirmation } from "../../src/lib/jarvis-control";
import { matchKeywords } from "../../src/lib/action-keywords";
import { FINANCE_WORDS, MONEY_NAMES, moneyButton, moneyRefusal, moneySurfaceRefusal, PRIVATE_DATA, SECRET_BEARING } from "../../src/lib/control-risk";
import { bookkeeping, cardNumberIn, decodeHost, localDocument, moneyHost, moneySurfaceKind, ownDashboard, stripGitRefs } from "../../src/lib/money-policy";
import { controlPolicyDecision } from "../jarvis-execution/control-policy";

// --- never, even with approval --------------------------------------------------------------------
// Banking and finance come from the ONE shared money policy (src/lib/control-risk.ts: moneyRefusal,
// MONEY_NAMES, the strict tier's FINANCE_WORDS), shared with control_pc and screen control (27 Sep
// night, Stage 0 F4: this file's own copy had drifted from the other two).
const NEVER: Array<[RegExp, string]> = [
  // (R4 §4: "check out the new landing page / this video", "withdraw the proposal / our quote" and
  // "pay attention" aren't money.)
  [/\b(?:pay(?:ment|ing)?(?!\s+(?:attention|heed|respects?)\b)|buy|purchase|(?<!\bgit\s)check ?out(?!\s+(?:main|master|develop|dev|head|origin|-b\b|the\s+(?:\w+\s+)?branch|(?:a\s+|new\s+)?(?:feature\s+)?branch|(?:the\s+|this\s+|that\s+|our\s+|my\s+|his\s+|her\s+)?(?:new\s+|latest\s+)?(?:[\w'-]+\s+)?(?:page|video|site|website|design|link|post|article|repo|docs?|demo|mock-?up|draft|slides?|deck)\b))|place (?:an? |the |my )?order|transfer (?:money|funds|\$)|withdraw(?!\s+(?:the\s+|my\s+|our\s+|that\s+|this\s+|a\s+|an\s+)?(?:[\w'-]+\s+){0,3}?(?:proposal|quotes?|quotation|estimate|tender|application|submission|request|offer|complaint|comment|consent|invitation|nomination|pull\s+request|pr)\b)|deposit|donate|refund)\b/i, "money"],
  [
    /\b(?:passwords?|passcodes?|passphrases?|credentials?|log ?in|sign ?in|signing in|logging in|2fa|two[- ]factor|otp|one[- ]time code|verification code|api ?keys?|tokens?|secrets?|\.env\b|1password|bitwarden|lastpass|keepass(?:xc)?|dashlane|keeper|nordpass|keychain|password manager|credential manager)\b/i,
    "passwords or credentials",
  ],
  [
    /\b(?:defender|firewall|anti ?virus|\buac\b|user account control|lock ?screen|screen ?lock|bitlocker|windows security|security settings?|smart ?screen|execution ?policy|registry|regedit|group policy|gpedit|admin(?:istrator)? (?:rights|mode)|run as admin(?:istrator)?|disable (?:the )?(?:lock|password|pin|security|updates))\b/i,
    "security settings",
  ],
  [/\b(?:install(?:er|ing|s)?|uninstall(?:ing)?|set ?up\.exe|\.msi\b|\.exe\b|winget|choco(?:latey)?|scoop install|pip install|npm (?:i|install)|download and run)\b/i, "installing software"],
  [
    /\b(?:send|reply|replies|respond to|forward|tweet|dm|sms|whats ?app|invite|comment on)\b|\b(?:e-?mail|message|text|ring|call|phone)\s+(?:him|her|them|mehroz|usman|my (?:partner|client|mum|dad|friend|team)|the (?:client|lead|customer|team)s?|everyone|\S+@\S+|\+?\d)|\bpost (?:it |this |that )?(?:on|to)\b/i,
    "messaging other people",
  ],
];
/** "…and send me the result": the result comes to him on Telegram anyway; not messaging anyone else. */
const SELF_REPORT = /,?\s*(?:and\s+)?(?:then\s+)?(?:send|message|text|tell|show|dm|ping)\s+me\b.*$/i;
export const stripSelfReport = (text: string) => text.replace(SELF_REPORT, "").trim();

/**
 * away.payment: the "never" reasons OTHER than money (credentials, security settings, installing, messaging),
 * for a task the owner's own words make an approvable payment. Pure.
 */
export function neverReasonBesidesMoney(text: string): string | null {
  // "send my zakat", "send the payment": sending money is the payment itself, not a message to someone.
  const t = stripSelfReport(text).replace(/\bsend\s+(?:my\s+|the\s+|our\s+|his\s+|her\s+|some\s+|a\s+)?(?:zakat|zakah|sadaqah|sadaqa|donation|payment|money|funds|fitrah|charity)\b/gi, "");
  for (const [re, why] of NEVER) if (why !== "money" && re.test(t)) return why;
  return null;
}

/** Why this task (or button, or window) is never done while he's away, or null. Pure. */
export function neverReason(text: string): string | null {
  const t0 = stripSelfReport(text);
  const money = moneyRefusal(t0);
  if (money) return money.kind === "money-or-trading" ? "money" : "banking or finance";
  // Bookkeeping in his own records, and git branch names, aren't money (R4 §4).
  const books = bookkeeping(t0);
  // (His own dashboards' addresses, like mu-receptionist.vercel.app/payments, aren't money words either.)
  const t = (stripGitRefs(t0) ?? t0).replace(/(?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi, (u) => (ownDashboard(u) ? " " : u));
  // A local statement file names a bank but drives none (carve-out 1).
  if (!books && (MONEY_NAMES.test(t) || FINANCE_WORDS.test(t)) && !localDocument(t)) return "banking or finance";
  for (const [re, why] of NEVER) if (!(books && why === "money") && re.test(t)) return why;
  return null;
}
/**
 * Away tasks reach Hermes through its warm API directly (Stage 0 F1): before any Hermes call, the task
 * must pass the shared refusal AND the control executor's allowlist (scripts/jarvis-execution/
 * control-policy.ts). The only widening is the reversible file verbs away mode's own Hermes brief
 * already allows ("tidy Downloads", "download the invoices from Xero", "export this to PDF"); the
 * denylist is never widened. Returns why not, or null. Pure.
 */
// "sort out" only with files as its object (REVIEW-SAFETY-R3 finding 4: "sort out the Telstra bill").
const AWAY_HERMES_LEADS =
  /^(?:tidy(?: up)?|organi[sz]e|sort(?: out)?(?=\s+(?:the\s+|my\s+|these\s+|those\s+|all\s+)?(?:[\w'-]+\s+){0,2}?(?:files?|folders?|downloads|desktop|documents|photos|pictures|screenshots|notes|images|videos|pdfs)\b)|download|export|research|draft|compile|gather|collect|file|summari[sz]e|back up)\b/i;
/** Hermes has no screen while he's away: a click or key press is screen work, never a Hermes job. */
const SCREEN_WORK = /\b(?:click|double[- ]click|right[- ]click|press|tap|hit)\b|\bthe\s+(?:\w+\s+)?button\b/i;
/** Websites Hermes may open while he's away; anything else (an unlisted shop, exchange or bookie) is refused. */
const AWAY_SAFE_HOST = /^(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|google\.com(?:\.au)?|github\.com|wikipedia\.org|muventures\.com\.au|vercel\.app|localhost)$/i;
const URL_IN_TEXT = /(?:https?:\/\/)?(?:[\p{L}0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/giu;
const FILE_EXT = /\.(?:txt|md|csv|pdf|docx?|xlsx?|pptx?|json|log|png|jpe?g|gif|mp[34]|zip|ts|js|py|html?)$/i;
export function awayHermesRefusal(task: string): string | null {
  const t = stripSelfReport(task);
  if (SECRET_BEARING.test(t) || PRIVATE_DATA.test(t)) return "it names a secret-bearing file or private data";
  // Before anything goes to Hermes (REVIEW-SAFETY-R3 finding 4): the shared money list (bills, card
  // numbers, money sites incl. punycode look-alikes), clicks, and any website off the away list.
  if (moneyRefusal(t) || cardNumberIn(t) || /\b\d(?:[ -]?\d){11,}\b/.test(t)) return "banking, money or trading";
  if (SCREEN_WORK.test(t)) return "it needs clicking on screen, which Hermes can't do while you're away (queue it as steps: \"open Chrome, click …\")";
  for (const m of t.match(URL_IN_TEXT) ?? []) {
    const host = m.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0].toLowerCase().replace(/^www\./, "");
    if (FILE_EXT.test(host) && !/^https?:/i.test(m)) continue;
    if (moneyHost(m) || /(?:^|\.)xn--/i.test(host) || decodeHost(host) !== host) return "banking, money or trading";
    if (!AWAY_SAFE_HOST.test(host)) return "it opens a website that isn't on the away list";
  }
  const d = controlPolicyDecision(t, { extraLeads: AWAY_HERMES_LEADS });
  if (d.permitted) return null;
  switch (d.reason) {
    case "money-or-trading":
    case "bank-broker-or-exchange":
      return "banking, money or trading";
    case "secret-or-private-data":
      return "it names a secret-bearing file or private data";
    case "app-not-allowed":
      return "it opens an app that isn't on the control allowlist";
    default:
      return "it isn't on the control allowlist (open, find, list, read, summarise, create, save, copy, tidy, download, export…)";
  }
}

/**
 * Stage 0 F3: an approval for Hermes binds to prose ("delete 3 duplicate PDFs"), not to an exact
 * action, so Hermes could do more than he approved. For money, deleting, publishing and account
 * changes that isn't good enough: such a NEEDS_APPROVAL (or a Hermes task worded that way) is refused,
 * never replayed. Exact built-in steps (a file delete by path, a screen button) still ask for his code.
 * Returns the category, or null. Pure.
 */
const PROSE_REFUSED = /\b(?:delete|deleting|remove|removing|erase|wipe|shred|overwrite|replace|purge|empty|clear (?:out|all|the)|reset|format|deploy|publish|release|push|merge|submit|upload|share|post|close (?:my |the |an? )?account|revoke|deactivate|sign ?out|log ?out|password|passcode|2fa|two[- ]factor)\b/i;
export function proseApprovalRefusal(action: string): string | null {
  const t = String(action ?? "");
  if (moneyRefusal(t) || MONEY_NAMES.test(t) || FINANCE_WORDS.test(t)) return "money";
  const kinds = new Set(matchKeywords(t, "task").map((k) => k.category));
  if (kinds.has("money")) return "money";
  if (kinds.has("account")) return "an account change";
  if (kinds.has("publishing")) return "publishing";
  if (kinds.has("destructive")) return "deleting";
  const m = t.match(PROSE_REFUSED);
  if (m) return /delet|remov|erase|wipe|shred|overwrit|replace|purge|empty|clear|reset|format/i.test(m[0]) ? "deleting" : /password|passcode|2fa|factor|account|revoke|deactivate|sign|log/i.test(m[0]) ? "an account change" : "publishing";
  return null;
}

// --- only with his one-time code ------------------------------------------------------------------
const IRREVERSIBLE =
  /\b(?:delete|remove|erase|wipe|shred|overwrite|replace|purge|empty (?:the )?(?:recycle bin|bin|trash)|clear (?:out|all|the)|reset|format|deploy|publish|release|push|merge|submit|upload|share|book|schedule|cancel|unsubscribe|subscribe|close (?:my |the |an? )?account|revoke|kill|end task|terminate|restart|reboot|shut ?down|sign ?out|log ?out|take ?down|accept|agree)\b/i;

/** Why this needs his approval first (it can't be taken back), or null. Pure. */
export function approvalReason(text: string): string | null {
  const t = stripSelfReport(text);
  const m = t.match(IRREVERSIBLE);
  if (m) return `it would ${m[0].toLowerCase()}`;
  if (needsConfirmation(t)) return "it reaches outside this PC or can't be undone";
  return null;
}

/**
 * A final button screen-hands stopped at (FINAL_BUTTON or Jev's "can't be undone"): "never" when
 * it's money, messaging, an account or a credential; otherwise it needs his code. Pure.
 */
export function buttonVerdict(label: string): { never: string } | { approval: string } {
  const l = label.toLowerCase();
  // The shared money-button list (money-policy.ts MONEY_BUTTON), plus the old words.
  if (moneyButton(label) || /\b(?:pay|buy|purchase|check ?out|order|transfer|donate|withdraw|deposit|subscribe|bet|sell|swap|top ?up|bid|invest|redeem|tip)\b/.test(l)) return { never: "money" };
  if (/\b(?:send|reply|post|tweet|comment|share|invite|message|call)\b/.test(l)) return { never: "messaging other people" };
  if (/\b(?:sign ?up|register|create (?:an? )?account|save password|sign ?in|log ?in)\b/.test(l)) return { never: "accounts and credentials" };
  if (/\b(?:install|uninstall)\b/.test(l)) return { never: "installing software" };
  return { approval: `"${label.slice(0, 40)}" can't easily be undone` };
}

/** Windows he's away from that Jarvis never drives: banking, money, chat apps, installers, settings. */
const NEVER_WINDOW_PROCESS = /^(?:whatsapp|telegram|signal|discord|slack|ms-teams|teams|outlook|olk|thunderbird|messenger|skype|zoom|msiexec|setup|installer|consent|securityhealthhost|systemsettings|mmc|regedit|gpedit|taskmgr)$/i;
const NEVER_WINDOW_TITLE =
  /\b(?:whatsapp|messenger|gmail|outlook|inbox|compose|linkedin|facebook|instagram|twitter|\bx\.com|setup|install(?:er|ing)?|windows security|defender|firewall|user account control|bitwarden|1password|lastpass|keepass|password)\b/i;
/**
 * away.payment: the window checks OTHER than money (chat apps, installers, settings, password managers),
 * plus the surfaces that are never approvable (brokers, exchanges, crypto, betting). A bank, biller or shop
 * page may be driven for the owner's approvable payment; screen-hands' paymentFence reads the page too. Pure.
 */
export function neverWindowBesidesMoney(win: { process?: string; title?: string } | null | undefined): string | null {
  if (!win) return null;
  const process = (win.process ?? "").replace(/\.exe$/i, "");
  if (NEVER_WINDOW_PROCESS.test(process)) return `${process} is off limits while you're away`;
  const title = win.title ?? "";
  if (NEVER_WINDOW_TITLE.test(title)) return `"${title.slice(0, 50)}" is off limits while you're away`;
  const kind = moneySurfaceKind({ title });
  if (kind === "broker" || kind === "crypto" || kind === "gambling") return `"${title.slice(0, 50)}" is trading, crypto or betting: never approvable`;
  return null;
}

/** A window away mode never acts in (on top of screen-hands' own deny-list), or null. Pure. */
export function neverWindow(win: { process?: string; title?: string } | null | undefined): string | null {
  if (!win) return null;
  const process = (win.process ?? "").replace(/\.exe$/i, "");
  if (NEVER_WINDOW_PROCESS.test(process)) return `${process} is off limits while you're away`;
  // Money screens: the shared policy (names, pay-anyone pages, sites), plus the strict finance words.
  const title = win.title ?? "";
  if (moneySurfaceRefusal({ title }) || FINANCE_WORDS.test(title) || NEVER_WINDOW_TITLE.test(title)) return `"${title.slice(0, 50)}" is off limits while you're away`;
  return null;
}

// --- routes ----------------------------------------------------------------------------------------
export type FileOp =
  | { op: "mkdir"; path: string }
  | { op: "write"; path: string; text: string }
  | { op: "delete"; path: string };
export type ScreenStep = { kind: "open"; app: string } | { kind: "act"; goal: string } | { kind: "save"; path: string } | { kind: "wait"; ms: number };
export type CliRecipe = { name: string; argv: string[]; timeoutMs: number };
export type Route =
  | { route: "file"; ops: FileOp[] }
  | { route: "cli"; recipe: CliRecipe }
  | { route: "screen"; steps: ScreenStep[] }
  | { route: "hermes" };
export type RouteName = Route["route"];

const PATH = String.raw`[a-z]:\\[^"*?<>|\r\n]*?`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const unquote = (s: string) => s.trim().replace(/^["“'](.*)["”']$/s, "$1");
const trimPath = (p: string) => p.trim().replace(/[\s.,;]+$/, "").replace(/[\\/]+$/, "");
/** "that test file", "it", "the file" → the path an earlier away task made. */
const REFERENCE = /^(?:that|the|this|it|my)?\s*(?:test |text |new |same )?(?:file|note|one)?$|^it$/i;

/** Folders away tasks may write in: D:\tmp and his Desktop, Documents and Downloads (never system folders). */
export function allowedPath(path: string, home: string): boolean {
  const p = path.replace(/\//g, "\\").toLowerCase();
  if (/\.\.(?:\\|$)/.test(p) || !/^[a-z]:\\/.test(p)) return false;
  const roots = ["d:\\tmp", `${home}\\desktop`, `${home}\\documents`, `${home}\\downloads`].map((r) => r.replace(/\//g, "\\").toLowerCase());
  return roots.some((r) => p === r || p.startsWith(`${r}\\`));
}

/** Built-in file steps: "create a folder D:\tmp\x and write a text file there saying hi". Pure; null if not that. */
export function parseFileOps(task: string, lastPath: string | null): FileOp[] | null {
  const parts = task.split(/\s*(?:,\s*(?:and\s+)?(?:then\s+)?|\s+and\s+then\s+|\s+then\s+|\s+and\s+)(?=(?:create|make|write|delete|remove|put|save)\b)/i);
  const ops: FileOp[] = [];
  let folder: string | null = null;
  let last = lastPath;
  for (const raw of parts) {
    const part = raw.trim().replace(/[.!]+$/, "");
    let m = part.match(new RegExp(`^(?:create|make)\\s+(?:a\\s+)?(?:new\\s+)?(?:folder|directory)\\s+(?:called\\s+|named\\s+)?(?:(?:at|in|on)\\s+)?(${PATH})$`, "i"));
    if (!m) {
      const inside = part.match(new RegExp(`^(?:create|make)\\s+(?:a\\s+)?(?:new\\s+)?(?:folder|directory)\\s+(?:called|named)\\s+"?([\\w .-]{1,60})"?\\s+(?:at|in|on)\\s+(${PATH})$`, "i"));
      if (inside) m = [inside[0], `${trimPath(inside[2])}\\${inside[1].trim()}`] as unknown as RegExpMatchArray;
    }
    if (m) {
      folder = trimPath(m[1]);
      ops.push({ op: "mkdir", path: folder });
      continue;
    }
    m = part.match(new RegExp(`^(?:create|make|write|put|save)\\s+(?:a\\s+)?(?:new\\s+)?(?:text\\s+|txt\\s+)?(?:file|note)(?:\\s+(?:called|named)\\s+"?([\\w .-]{1,60}?\\.(?:txt|md|csv|log))"?)?(?:\\s+(?:(?:at|in|to|into|on)\\s+(${PATH}|that folder|it)|(?:in\\s+)?there))?(?:\\s+(?:called|named)\\s+"?([\\w .-]{1,60}?\\.(?:txt|md|csv|log))"?)?\\s+(?:with|containing|saying|that says|reading)\\s+(?:the\\s+(?:text|line|words)\\s+)?(.+)$`, "i"));
    if (m) {
      const name = m[1] ?? m[3];
      const where = m[2];
      let path: string;
      if (where && /^[a-z]:\\/i.test(where)) path = /\.(?:txt|md|csv|log)$/i.test(trimPath(where)) ? trimPath(where) : `${trimPath(where)}\\${name ?? "note.txt"}`;
      else if (folder) path = `${folder}\\${name ?? "note.txt"}`;
      else return null;
      const text = unquote(m[4]);
      if (!text) return null;
      ops.push({ op: "write", path, text: clip(text, 4000) });
      last = path;
      continue;
    }
    m = part.match(new RegExp(`^(?:delete|remove|bin|trash)\\s+(?:the\\s+file\\s+)?(${PATH}|.{0,30})$`, "i"));
    if (m) {
      const target = m[1].trim();
      const path = /^[a-z]:\\/i.test(target) ? trimPath(target) : REFERENCE.test(target) && last ? last : null;
      if (!path) return null;
      ops.push({ op: "delete", path });
      continue;
    }
    return null;
  }
  return ops.length ? ops : null;
}

/** Known jobs with a CLI, run directly (no clicking, no model). */
export function cliRecipe(task: string): CliRecipe | null {
  const t = task.toLowerCase();
  if (/\b(?:run|start|kick off|do)\b.*\bphone[- ]?finder\b|\bfind (?:the )?(?:missing )?phone numbers\b/.test(t))
    return { name: "lead phone-finder", argv: ["scripts/leads/cli.ts", "phones", "run"], timeoutMs: 45 * 60_000 };
  const preview = t.match(/\b(?:re-?build|re-?generate|generate|build|make)\b.*\bpreview\b.*?\blead\s*#?\s*(\d{1,6})\b|\blead\s*#?\s*(\d{1,6})\b.*\bpreview\b/);
  if (preview && !/\bdeploy|publish|live\b/.test(t)) return { name: `preview for lead ${preview[1] ?? preview[2]}`, argv: ["scripts/lead-sites/cli.ts", "generate", preview[1] ?? preview[2], "--by", "usman"], timeoutMs: 20 * 60_000 };
  if (/\b(?:check|show)\b.*\bphone[- ]?finder\b.*\b(?:status|progress)\b/.test(t)) return { name: "phone-finder status", argv: ["scripts/leads/cli.ts", "phones", "status"], timeoutMs: 60_000 };
  return null;
}

/**
 * A screen plan: "open Notepad, type hello, then save it to D:\tmp\x.txt". Only for tasks that
 * name an app to open and say what to click or type; everything vaguer goes to Hermes. Pure.
 */
export function parseScreenTask(task: string): ScreenStep[] | null {
  // "pay my Telstra bill: open Chrome, click Make payment": a purpose, then the steps (the purpose stays
  // in the task's text, where away.payment reads his intent).
  const whole = task.trim().replace(/[.!]+$/, "");
  const t = whole.match(/^[^:\n]{3,80}:\s*((?:open|launch|start)\s[\s\S]+)$/i)?.[1] ?? whole;
  const open = t.match(/^(?:open|launch|start)\s+(?:up\s+)?([a-z][\w .&+-]{1,30}?)(?:\s*,\s*|\s+and\s+|\s+then\s+)(.+)$/i);
  if (!open) return null;
  const steps: ScreenStep[] = [{ kind: "open", app: open[1].trim() }];
  const rest = open[2].split(/\s*,\s*(?:and\s+)?(?:then\s+)?|\s+and\s+then\s+|\s+then\s+|\s+and\s+(?=(?:type|click|press|save|select|tick|scroll|fill|wait)\b)/i);
  for (const raw of rest) {
    const part = raw.trim();
    if (!part) continue;
    const save = part.match(new RegExp(`^save\\s+(?:it|this|the file|the document)?\\s*(?:as|to|in(?:to)?)\\s+(${PATH})$`, "i"));
    if (save) {
      steps.push({ kind: "save", path: trimPath(save[1]) });
      continue;
    }
    const wait = part.match(/^wait\s+(\d{1,2})\s*(?:s|sec|secs|seconds?)$/i);
    if (wait) {
      steps.push({ kind: "wait", ms: Number(wait[1]) * 1000 });
      continue;
    }
    if (/^(?:type|write|enter|click|tap|press|select|tick|untick|scroll|fill|choose|pick)\b/i.test(part)) {
      steps.push({ kind: "act", goal: clip(part, 300) });
      continue;
    }
    return null;
  }
  return steps.length > 1 ? steps : null;
}

/** The most direct route: built-in file step, then a CLI recipe, then a screen plan, then Hermes. Pure. */
export function classifyTask(task: string, lastPath: string | null = null): Route {
  const t = stripSelfReport(task);
  const ops = parseFileOps(t, lastPath);
  if (ops) return { route: "file", ops };
  const recipe = cliRecipe(t);
  if (recipe) return { route: "cli", recipe };
  const steps = parseScreenTask(t);
  if (steps) return { route: "screen", steps };
  return { route: "hermes" };
}

/** Does this task need the screen (and so an unlocked PC)? */
export const needsScreen = (route: Route) => route.route === "screen";

// --- approval codes ---------------------------------------------------------------------------------
/** No 0/O, 1/I/L: a code he can read off a phone and type without mistakes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_DIGITS = "23456789";
/** Four characters, at least one a digit: "yes sure" or "no thanks" in chat is never a code. */
export function newCode(pick: (n: number) => number = (n) => randomInt(n)): string {
  const chars = Array.from({ length: 4 }, () => CODE_ALPHABET[pick(CODE_ALPHABET.length)]);
  if (!chars.some((c) => /\d/.test(c))) chars[pick(4)] = CODE_DIGITS[pick(CODE_DIGITS.length)];
  return chars.join("");
}
/** A code as he'd type it: four letters or digits, at least one digit. */
const CODE = String.raw`((?=[A-Za-z]{0,3}\d)[A-Za-z0-9]{4})`;
export function sameCode(given: string, want: string): boolean {
  const a = Buffer.from(given.trim().toUpperCase());
  const b = Buffer.from(want.trim().toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Telegram commands --------------------------------------------------------------------------------
export type TelegramCommand =
  | { cmd: "on" }
  | { cmd: "off" }
  | { cmd: "status" }
  | { cmd: "stop" }
  | { cmd: "resume" }
  | { cmd: "log"; n: number }
  | { cmd: "task"; text: string }
  | { cmd: "cancel"; id: number }
  | { cmd: "help" }
  | { cmd: "approve"; code: string }
  | { cmd: "deny"; code: string };

/** His Telegram message → an away-mode command, or null (it goes to Hermes as usual). Pure. */
export function parseTelegram(text: string): TelegramCommand | null {
  const t = text.trim().replace(/^\/(\w+)@\w+/, "/$1");
  let m = t.match(new RegExp(String.raw`^(?:yes|approve|approved|y)\s+${CODE}\s*[.!]?$`, "i"));
  if (m) return { cmd: "approve", code: m[1].toUpperCase() };
  m = t.match(new RegExp(String.raw`^(?:no|deny|denied|reject|n)\s+${CODE}\s*[.!]?$`, "i"));
  if (m) return { cmd: "deny", code: m[1].toUpperCase() };
  if (/^\/stop\b/i.test(t)) return { cmd: "stop" };
  if (/^\/status\s*$/i.test(t)) return { cmd: "status" };
  m = t.match(/^\/log(?:\s+(\d{1,3}))?\s*$/i);
  if (m) return { cmd: "log", n: Math.min(30, Math.max(1, Number(m[1] ?? 10))) };
  m = t.match(/^\/task\s+([\s\S]{2,600})$/i);
  if (m) return { cmd: "task", text: m[1].trim() };
  m = t.match(/^\/away(?:\s+([\s\S]*))?$/i);
  if (m) {
    const arg = (m[1] ?? "").trim();
    if (!arg || /^status$/i.test(arg)) return { cmd: "status" };
    if (/^on$/i.test(arg)) return { cmd: "on" };
    if (/^off$/i.test(arg)) return { cmd: "off" };
    if (/^stop$/i.test(arg)) return { cmd: "stop" };
    if (/^resume$/i.test(arg)) return { cmd: "resume" };
    if (/^help$/i.test(arg)) return { cmd: "help" };
    const log = arg.match(/^log(?:\s+(\d{1,3}))?$/i);
    if (log) return { cmd: "log", n: Math.min(30, Math.max(1, Number(log[1] ?? 10))) };
    const cancel = arg.match(/^cancel\s+#?(\d{1,6})$/i);
    if (cancel) return { cmd: "cancel", id: Number(cancel[1]) };
    const add = arg.match(/^(?:add|queue|task)\s+([\s\S]{2,600})$/i);
    if (add) return { cmd: "task", text: add[1].trim() };
    return { cmd: "help" };
  }
  return null;
}

export const TELEGRAM_HELP = [
  "Away mode:",
  "/away on · /away off · /status",
  "/task <what to do>  (queue a job)",
  "/stop  (halt now) · /away resume",
  "/log [n]  (last steps) · /away cancel <id>",
  "Approvals: reply \"yes CODE\" or \"no CODE\".",
].join("\n");

// --- voice ----------------------------------------------------------------------------------------------
export type AwayVoice = { on: true } | { on: false } | { task: string } | { status: true };
/** "Jarvis, I'm heading out, away mode on", "away mode off", "while I'm away, tidy Downloads". Pure. */
export function awayVoiceIntent(utterance: string): AwayVoice | null {
  const u = utterance.trim().replace(/^(?:(?:ok(?:ay)?|right|alright|hey)[,\s]+)?(?:jarvis[,\s]+)?/i, "").replace(/[.!?]+$/, "").trim();
  if (u.length > 400) return null;
  if (/\baway mode\b/i.test(u)) {
    if (/\b(?:off|stop|end|disable|cancel|i'?m back|i am back)\b/i.test(u)) return { on: false };
    if (/\b(?:on|start|enable|activate|turn it on|switch it on)\b/i.test(u) || /\b(?:heading|going|stepping|popping) out\b/i.test(u)) return { on: true };
    if (/\b(?:status|what'?s (?:in )?the queue|queue)\b/i.test(u)) return { status: true };
    return null;
  }
  const task = u.match(/^(?:while i'?m (?:away|out|gone)|when i'?m (?:away|out|gone)|(?:add|queue)(?: this)?(?: to the away queue| for away mode| for while i'?m away)?:?)[,:\s]+(.{3,})$/i);
  if (task) return { task: task[1].trim() };
  return null;
}
