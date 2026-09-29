// Jarvis's fast hands on the PC: the everyday commands that don't need an agent. "Open
// Notepad" through Hermes took 12.5 s warm on 24 Sep (skill load, command choice, an LLM safety
// check on Start-Process, a reply); here it's the Windows app list plus one launch (~0.3 s).
// Hermes still does anything multi-step, anything inside an app, and anything outbound.
//
// Actions: open_app (any Start-menu app, desktop or Store), open_folder (Downloads, Documents,
// Desktop, Pictures, Music, Videos), media (play_pause, next, previous), volume (up, down,
// mute), lock. Nothing here deletes, sends, installs or types.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { bestMatch, similarity } from "./jarvis-skills/fuzzy";
import { rememberReferent } from "./jarvis-skills/referent";
import { DESTINATIONS } from "../src/components/shell/destinations";

export type StartApp = { name: string; id: string };
export type PcRequest =
  | { action: "open_app"; target: string }
  | { action: "open_folder"; target: string }
  | { action: "media"; target: "play_pause" | "next" | "previous" }
  | { action: "volume"; target: "up" | "down" | "mute" }
  | { action: "lock" }
  | { action: "open_bookmarks" };
export type PcResult = { ok: boolean; said: string; ms: number };

// --- the Windows app list (Get-StartApps), cached --------------------------------------------
let cache: { apps: StartApp[]; at: number } | null = null;
let loading: Promise<StartApp[]> | null = null;
const TTL = 30 * 60_000;

function loadStartApps(): Promise<StartApp[]> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
      { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve([]);
        try {
          const rows = JSON.parse(stdout) as { Name: string; AppID: string }[] | { Name: string; AppID: string };
          resolve((Array.isArray(rows) ? rows : [rows]).filter((r) => r?.Name && r?.AppID).map((r) => ({ name: r.Name, id: r.AppID })));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/** Cached app list; refreshes in the background every 30 minutes. */
export function startApps(): StartApp[] {
  const stale = !cache || Date.now() - cache.at > TTL;
  if (stale && !loading && process.platform === "win32")
    loading = loadStartApps().then((apps) => {
      if (apps.length) cache = { apps, at: Date.now() };
      loading = null;
      return apps;
    });
  return cache?.apps ?? [];
}
/** Tests: a fixed Start-menu app list (null restores the real, lazily loaded one). Never called in production. */
export function primeStartApps(apps: StartApp[] | null) {
  cache = apps ? { apps, at: Number.MAX_SAFE_INTEGER } : null;
  loading = null;
}
export async function startAppsReady() {
  startApps();
  if (loading) await loading;
  return cache?.apps ?? [];
}

// --- matching ----------------------------------------------------------------------------------
const ALIASES: Record<string, string> = {
  chrome: "google chrome", "vs code": "visual studio code", vscode: "visual studio code", code: "visual studio code",
  explorer: "file explorer", files: "file explorer", "file manager": "file explorer", calc: "calculator",
  terminal: "terminal", "command prompt": "command prompt", cmd: "command prompt", powershell: "windows powershell",
  "task manager": "task manager", paint: "paint", "snipping tool": "snipping tool", whatsapp: "whatsapp",
  "windows settings": "settings", "pc settings": "settings", "control panel": "control panel", word: "word", excel: "excel",
};
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}+ ]/gu, " ").replace(/\s+/g, " ").trim();

/** How close a speech-to-text slip must be to count ("spotfy" → Spotify is 0.92). */
export const FUZZY_APP = 0.8;

/** Best Start-menu match for what he said, or null when nothing is a confident match. */
export function matchApp(apps: StartApp[], said: string, fuzzy = true): StartApp | null {
  const want = norm(ALIASES[norm(said)] ?? said);
  if (!want) return null;
  const byName = apps.map((a) => ({ a, n: norm(a.name) }));
  const exact = byName.find((x) => x.n === want);
  if (exact) return exact.a;
  // "spotify" → "Spotify", "obsidian" → "Obsidian"; but "code" must not pick "Free Claude Code".
  const starts = byName.filter((x) => x.n.startsWith(want + " ") || x.n.startsWith(want)).sort((p, q) => p.n.length - q.n.length);
  if (starts.length) return starts[0].a;
  const words = byName.filter((x) => x.n.split(" ").includes(want)).sort((p, q) => p.n.length - q.n.length);
  if (words.length === 1) return words[0].a;
  // STT slips ("spotfy", "whatsap", "vs cod"): a close alias first, then a close app name or word.
  if (!fuzzy || want.length < 4) return null;
  const alias = bestMatch(want, Object.keys(ALIASES), (key) => [key], FUZZY_APP);
  if (alias) {
    const hit = matchApp(apps, ALIASES[alias], false);
    if (hit) return hit;
  }
  return bestMatch(want, apps, (a) => [norm(a.name), ...norm(a.name).split(" ").filter((w) => w.length >= 5)], FUZZY_APP);
}

const FOLDERS: Record<string, string> = {
  downloads: "Downloads", download: "Downloads", documents: "Documents", docs: "Documents", desktop: "Desktop",
  pictures: "Pictures", photos: "Pictures", music: "Music", videos: "Videos",
};

// Words that mean one of the OS's own pages or a website: never treat them as apps.
export const NOT_APPS = new Set([
  "inbox", "calendar", "memory", "business", "chat", "design", "websites", "website", "code graph", "codegraph", "hermes",
  "leads", "crm", "automations", "dashboard", "mission control", "jarvis", "the os", "youtube", "instagram", "facebook",
  "gmail", "google", "twitter", "x", "linkedin", "tiktok", "netflix", "reddit", "github", "notebooklm", "chatgpt", "claude",
]);
/** The OS's own settings page, not the Windows Settings app ("windows settings" / "pc settings" / "settings app" open that). */
const OS_SETTINGS = new Set(["os settings", "jarvis settings", "agentic os settings", "dashboard settings"]);
/**
 * Every name an OS page answers to (J4, AUDIT-JARVIS #7: "open home" launched Google Chrome and "open studio" launched Visual
 * Studio Code because the app matcher fuzzy-matched them). Built from the shell's own destinations and drilldowns, so a new
 * page is covered too. Matched EXACTLY (never fuzzily: "motion" must not block the Notion app), and only when nothing else
 * qualifies the name: "open Windows settings" and "open the Settings app" still launch the Windows app.
 */
const pageWords = (label: string) => [label.toLowerCase(), label.toLowerCase().replace(/\s*&\s*/g, " and ")];
export const OS_PAGE_NAMES = new Set([
  ...DESTINATIONS.flatMap((d) => [...pageWords(d.label), ...d.drilldowns.flatMap((dd) => pageWords(dd.label))]),
  "home", "today", "studio", "websites", "receptionist", "memory", "finance", "finances", "system", "jarvis", "work", "inbox", "calendar", "leads",
  "coding", "automations", "skills", "models", "usage", "activity", "hermes", "mission control", "motion", "vault", "workspaces", "workspace", "goals",
  "operations", "settings", "setup", "design", "packages and economics", "ai usage and spend", "ai usage", "share card", "knowledge graph",
]);
const WINDOWS_SETTINGS_APP = /\bsettings\s+(?:app|application)$/;

/**
 * "Show my bookmarks in Chrome", "open my bookmarks", "bookmarks manager": a direct, deterministic
 * route to chrome://bookmarks, checked before the generic "open …" match below so it never falls
 * through to the screen_act clicking loop (25 Sep: that loop toggled the Claude app's Browser
 * button instead). Rule-only — never added to the brain's tool menu (docs/SCREEN-CONTROL.md).
 */
export function bookmarksIntent(utterance: string): boolean {
  const u = utterance
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/^\s*(?:hey\s+)?jarvis[,\s]+/, "")
    .replace(/^(?:can you|could you|would you|will you|please)\s+/, "")
    .replace(/\s+(?:please|for me|now|jarvis)$/g, "")
    .trim();
  if (!u || u.length > 60) return false;
  return (
    /^(?:show|open|pull up|bring up|take me to|go to)\s+(?:me\s+)?(?:my\s+)?(?:chrome\s+)?bookmarks?(?:\s+manager)?(?:\s+(?:page|bar))?(?:\s+in\s+chrome)?$/.test(u) ||
    /^(?:chrome\s+)?bookmarks?\s+manager$/.test(u)
  );
}

/**
 * Deterministic PC commands, checked before Jev (conservative: unclear → null → Jev/brain).
 * "open notepad", "launch spotify", "open my downloads", "next song", "volume up", "lock my PC".
 */
export function pcIntent(utterance: string, apps: StartApp[] = startApps()): PcRequest | null {
  const u = utterance
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/^\s*(?:hey\s+)?jarvis[,\s]+/, "")
    .replace(/^(?:can you|could you|would you|will you|please)\s+/, "")
    .replace(/\s+(?:please|for me|now|jarvis)$/g, "")
    .trim();
  if (!u || u.length > 80) return null;
  if (bookmarksIntent(utterance)) return { action: "open_bookmarks" };
  if (/^(?:next|skip)(?:\s+(?:song|track))?$|^skip (?:this|the) (?:song|track)$/.test(u)) return { action: "media", target: "next" };
  if (/^(?:previous|last|go back a)\s+(?:song|track)$/.test(u)) return { action: "media", target: "previous" };
  if (/^(?:pause|stop|play|resume)\s+(?:the\s+)?(?:music|song|spotify)$/.test(u)) return { action: "media", target: "play_pause" };
  if (/^(?:turn\s+(?:the\s+)?)?volume\s+up$|^turn\s+it\s+up$|^louder$/.test(u)) return { action: "volume", target: "up" };
  if (/^(?:turn\s+(?:the\s+)?)?volume\s+down$|^turn\s+it\s+down$|^quieter$/.test(u)) return { action: "volume", target: "down" };
  if (/^(?:mute|unmute)(?:\s+(?:the\s+)?(?:sound|volume|audio|pc|computer))?$/.test(u)) return { action: "volume", target: "mute" };
  if (/^lock\s+(?:my|the)\s+(?:pc|computer|screen|laptop)$/.test(u)) return { action: "lock" };
  const m = u.match(/^(?:open|launch|start|run|bring up|pull up|boot up|fire up|load up|start up)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+(?:app|application|program|folder))?$/);
  if (!m) return null;
  const name = m[1].trim();
  const namesAPage = OS_PAGE_NAMES.has(name) && !(name === "settings" && WINDOWS_SETTINGS_APP.test(u));
  if (NOT_APPS.has(name) || namesAPage || OS_SETTINGS.has(name) || /\b(?:and|then|with|in|on|to|from|for|about)\b/.test(name) || name.split(" ").length > 4) return null;
  // A slip of an OS page or website ("youtub", "calender") is still not an app: Jev and the brain take it.
  if (name.length >= 4 && [...NOT_APPS].some((word) => word.length >= 4 && similarity(name, word) >= FUZZY_APP)) return null;
  if (FOLDERS[name]) return { action: "open_folder", target: FOLDERS[name] };
  const app = matchApp(apps, name);
  return app ? { action: "open_app", target: app.name } : null;
}

// --- doing it ----------------------------------------------------------------------------------
const VK = { up: 175, down: 174, mute: 173, next: 176, previous: 177, play_pause: 179 } as const;

function fire(file: string, args: string[]) {
  // Detached and not waited on: a GUI app must never hold the caller (the Hermes trap).
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => undefined);
  child.unref();
}

function sendKey(vk: number, times = 1) {
  const script = `$w = New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $w.SendKeys([char]${vk}) }`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10_000 }, () => undefined);
}

/** A SendKeys chord ("^+o" = Ctrl+Shift+O), for the one case (bookmarks) that needs a combo, not a single VK. */
function sendKeys(sequence: string) {
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sequence.replace(/'/g, "''")}')`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10_000 }, () => undefined);
}

/** The process name of the window in front right now ("chrome", "explorer"…), or null. Best-effort. */
function foregroundProcessName(): Promise<string | null> {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -Name Win -Namespace Jarvis -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);';",
      "$h = [Jarvis.Win]::GetForegroundWindow(); $procId = 0;",
      "[void][Jarvis.Win]::GetWindowThreadProcessId($h, [ref]$procId);",
      "try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }",
    ].join(" ");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      resolve(error ? null : (stdout || "").trim() || null);
    });
  });
}

export async function pcAct(req: PcRequest): Promise<PcResult> {
  const started = Date.now();
  const done = (ok: boolean, said: string): PcResult => ({ ok, said, ms: Date.now() - started });
  switch (req.action) {
    case "open_app": {
      const app = matchApp(await startAppsReady(), req.target);
      if (!app) return done(false, `I can't find an app called ${req.target}.`);
      // Desktop apps listed by path launch directly; everything else through the Apps folder.
      if (/^[a-z]:\\.+\.exe$/i.test(app.id)) fire(app.id, []);
      else fire("explorer.exe", [`shell:AppsFolder\\${app.id}`]);
      // What "it" means next ("bring it to my main screen"): this app (J-fix).
      rememberReferent({ app: app.name });
      return done(true, `${app.name} is opening.`);
    }
    case "open_folder": {
      const folder = Object.values(FOLDERS).includes(req.target) ? req.target : null;
      if (!folder) return done(false, "I only open your Downloads, Documents, Desktop, Pictures, Music or Videos folder this way.");
      fire("explorer.exe", [join(homedir(), folder)]);
      return done(true, `Your ${folder} folder is open.`);
    }
    case "media":
      sendKey(VK[req.target]);
      return done(true, req.target === "next" ? "Next track." : req.target === "previous" ? "Previous track." : "Done.");
    case "volume":
      sendKey(VK[req.target], req.target === "mute" ? 1 : 5);
      return done(true, req.target === "mute" ? "Toggled mute." : `Volume ${req.target}.`);
    case "lock":
      fire("rundll32.exe", ["user32.dll,LockWorkStation"]);
      return done(true, "Locking the PC.");
    case "open_bookmarks": {
      // A deterministic route (docs/SCREEN-CONTROL.md), never the generic screen_act clicking loop
      // (25 Sep: that loop toggled the Claude app's Browser button instead of opening bookmarks).
      const front = await foregroundProcessName();
      if (front && /^chrome$/i.test(front)) {
        sendKeys("^+o"); // Ctrl+Shift+O: Chrome's own shortcut for its Bookmark Manager tab.
        return done(true, "Opening your bookmarks.");
      }
      // Chrome isn't the window in front (or isn't running): open it straight to the page. "start
      // chrome" resolves through Windows' own registered-browser lookup, so this works either way.
      fire("cmd.exe", ["/c", "start", "", "chrome", "chrome://bookmarks/"]);
      return done(true, "Opening your bookmarks in Chrome.");
    }
  }
}

export function parsePcRequest(body: unknown): PcRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = String(b.action ?? "");
  const target = typeof b.target === "string" ? b.target.slice(0, 80) : "";
  if (action === "open_app" && target) return { action, target };
  if (action === "open_folder" && target) return { action, target };
  if (action === "media" && ["play_pause", "next", "previous"].includes(target)) return { action, target: target as "next" };
  if (action === "volume" && ["up", "down", "mute"].includes(target)) return { action, target: target as "up" };
  if (action === "lock") return { action };
  if (action === "open_bookmarks") return { action };
  throw new Error("pc_act needs action open_app|open_folder|media|volume|lock|open_bookmarks with a valid target.");
}
