// Direct routes for everyday PC requests that used to go through Hermes and the Settings app
// (the 25 Sep end-to-end suite: 60-120 s and a "please approve" each). Each is one local call:
//
// - "settings": Bluetooth and Wi-Fi on/off (the Windows.Devices.Radios API, the same switch as
//   the quick settings); notifications muted or back on (Windows 11 "Do not disturb", switched on
//   the Settings page through UI Automation by dnd.ps1: the registry copy of the old toggle is
//   ignored by the shell, 25 Sep); light or dark mode (the theme values plus the same broadcast
//   Settings sends); and a new folder on the Desktop or in Documents/Downloads. All reversible.
// - "files": rename the screenshots (or photos, or all files) in one of his folders by the date
//   each was made ("2026-09-18.png", "2026-09-18 2.png" for a second one that day). Only files
//   directly in that folder; never a system folder; the old names are kept so "undo the rename"
//   puts every one back.
// - "deploys": the latest Vercel deployments and their status, from the Vercel CLI he's signed
//   into (read-only; nothing is deployed, promoted or removed).
//
// Safety: nothing here deletes, sends or pays. Folder names are sanitised (no paths, no "..").
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PsHost } from "./ps-host";
import { norm } from "./text";
import { placeFromWords, resolvePlace, spokenPlace } from "./places";

export type SettingsRequest =
  | { skill: "settings"; action: "radio"; radio: "bluetooth" | "wifi"; on: boolean }
  | { skill: "settings"; action: "notifications"; on: boolean }
  | { skill: "settings"; action: "theme"; dark: boolean }
  | { skill: "settings"; action: "clipboard_history" }
  | { skill: "settings"; action: "folder"; name: string; where: string };
export type DeploysRequest = { skill: "deploys"; action: "latest"; project?: string };
export type FilesRequest =
  | { skill: "files"; action: "rename_by_date"; folder: string; kind: "screenshots" | "photos" | "all" }
  | { skill: "files"; action: "undo_rename" };

const HOME_FOLDERS: Record<string, string> = { downloads: "Downloads", desktop: "Desktop", documents: "Documents", pictures: "Pictures", photos: "Pictures", screenshots: "Pictures\\Screenshots" };
/**
 * "rename the screenshots in the jarvis-suite-shots folder in my Downloads by date", "rename my
 * screenshots by date", "rename the photos in Pictures by date", "undo the rename". Pure.
 */
export function filesIntent(utterance: string): FilesRequest | null {
  const u = norm(utterance);
  if (!u || u.length > 160) return null;
  if (/^(?:undo|reverse|put back) (?:the |that |my )?(?:last )?rename(?:s)?$|^(?:undo|reverse) (?:the |that )?renaming$|^put (?:the |those )?(?:files|screenshots|photos) back$/.test(u)) return { skill: "files", action: "undo_rename" };
  const m = u.match(/^(?:rename|re name) (?:all )?(?:the |my |these |those )?(screenshots?|photos?|pictures?|images?|files?)(?: (?:in|inside|from) (?:the |my )?(.+?))? (?:by|with|using|to) (?:the )?(?:date|dates|day)(?: (?:taken|made|created|modified))?$/);
  if (!m) return null;
  const kind = /screenshot/.test(m[1]) ? "screenshots" : /photo|picture|image/.test(m[1]) ? "photos" : "all";
  // "the jarvis-suite-shots folder in my downloads" → Downloads/jarvis-suite-shots
  const words = m[2] ?? (kind === "screenshots" ? "screenshots" : kind === "photos" ? "pictures" : "");
  // The folder, as said (D:\tmp paths keep their case and slashes).
  const said = utterance.match(/\b(?:in|inside|from)\s+(?:the\s+|my\s+)?(.+?)\s+(?:by|with|using|to)\s+(?:the\s+)?(?:date|dates|day)\b/i)?.[1] ?? words;
  const folder = placeFromWords(said) ?? placeFromWords(words);
  if (!folder) return null;
  void HOME_FOLDERS;
  return { skill: "files", action: "rename_by_date", folder, kind };
}

const PHOTO = /\.(?:png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
/** New names by date (local), in date order; a second one that day gets " 2". Pure. */
export function datedNames(files: Array<{ name: string; ms: number }>): Array<{ from: string; to: string }> {
  const used = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [...files]
    .sort((a, b) => a.ms - b.ms)
    .map((f) => {
      const d = new Date(f.ms);
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const ext = f.name.match(/\.[^.]+$/)?.[0] ?? "";
      let to = `${day}${ext.toLowerCase()}`;
      for (let n = 2; used.has(to.toLowerCase()); n++) to = `${day} ${n}${ext.toLowerCase()}`;
      used.add(to.toLowerCase());
      return { from: f.name, to };
    })
    .filter((r) => r.from !== r.to);
}

const ON = /\b(?:on|enable|activate|start|unmute|resume)\b/;
const OFF = /\b(?:off|disable|deactivate|stop|mute|silence|pause|block)\b/;

export function settingsIntent(utterance: string): SettingsRequest | null {
  const u = norm(utterance).replace(/\bwifi\b|\bwi fi\b/g, "wi-fi");
  if (!u || u.length > 100) return null;
  let m = u.match(/^(?:turn|switch|flip|put) (on|off) (?:the |my )?(bluetooth|wi-fi|wireless)$|^(?:turn|switch|flip|put) (?:the |my )?(bluetooth|wi-fi|wireless) (on|off)$|^(enable|disable) (?:the |my )?(bluetooth|wi-fi|wireless)$|^(bluetooth|wi-fi) (on|off)$/);
  if (m) {
    const state = m[1] ?? m[4] ?? m[5] ?? m[8];
    const radio = (m[2] ?? m[3] ?? m[6] ?? m[7]) === "bluetooth" ? "bluetooth" : "wifi";
    return { skill: "settings", action: "radio", radio, on: state === "on" || state === "enable" };
  }
  // "mute notifications", "turn off notifications", "do not disturb on", "notifications back on"
  if (/\b(?:notifications?|alerts|toasts|do not disturb|dnd|focus assist)\b/.test(u) && !/\b(?:email|slack|discord|whatsapp|teams|app|for)\b/.test(u)) {
    const dnd = /\b(?:do not disturb|dnd|focus assist)\b/.test(u);
    if (/^(?:turn |switch |put )?(?:on )?(?:do not disturb|dnd|focus assist)(?: on| mode)?$|^(?:mute|silence|pause|block|stop|disable|turn off|switch off|hide|no more) (?:all |my |the )?(?:windows )?notifications?$|^(?:turn|switch) (?:all |my |the )?notifications? off$/.test(u))
      return { skill: "settings", action: "notifications", on: false };
    if (/^(?:turn |switch )?off (?:do not disturb|dnd|focus assist)$|^(?:do not disturb|dnd|focus assist) off$|^(?:unmute|resume|enable|turn on|switch on|allow) (?:all |my |the )?(?:windows )?notifications?(?: again| back on)?$|^(?:turn|switch) (?:all |my |the )?notifications? (?:back )?on$|^notifications? back on$/.test(u))
      return { skill: "settings", action: "notifications", on: true };
    void dnd;
  }
  if (/^(?:open|show|bring up|pull up)(?: me)? (?:my |the )?clipboard history$|^clipboard history$/.test(u)) return { skill: "settings", action: "clipboard_history" };
  // "switch Windows to dark mode", "turn on light mode", "dark mode on"
  m = u.match(/^(?:switch|change|set|put|turn)(?: (?:on|the pc|windows|my pc|my computer|everything|it))?(?: (?:to|into|on))? (dark|light) (?:mode|theme)(?: on)?$|^(dark|light) (?:mode|theme)(?: on| please)?$|^(?:turn on|enable|use) (dark|light) (?:mode|theme)$/);
  if (m) return { skill: "settings", action: "theme", dark: (m[1] ?? m[2] ?? m[3]) === "dark" };
  // "make a new folder on my desktop called jarvis-suite-test", "create a folder called X in documents"
  m = utterance.trim().replace(/[.!?]+$/, "").match(/^(?:please )?(?:make|create|add) (?:me )?(?:a )?(?:new )?folder (?:(?:on|in) (?:my |the )?(desktop|documents|downloads|d:[\\/]tmp\S*)(?: folder)? )?(?:called|named) ["“]?([^"”]{1,60}?)["”]?(?: (?:on|in) (?:my |the )?(desktop|documents|downloads|d:[\\/]tmp\S*)(?: folder)?)?$/i);
  if (m) {
    const name = m[2].trim();
    const where = placeFromWords(m[1] ?? m[3] ?? "desktop");
    if (!where || !/^[\w][\w .,'()&+-]{0,59}$/.test(name) || /\.\./.test(name) || /^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return null;
    return { skill: "settings", action: "folder", name, where };
  }
  return null;
}

/** "What's the last deploy status", "did my Vercel deploy work", "open my Vercel dashboard and tell me the latest deploy". */
export function deploysIntent(utterance: string): DeploysRequest | null {
  const u = norm(utterance);
  if (!u || u.length > 200) return null;
  if (!/\b(?:vercel|deploy|deploys|deployment|deployments)\b/.test(u)) return null;
  if (!/\b(?:status|last|latest|recent|newest|how did|how is|did|ready|fail|failed|error|errored|building|live|went|go)\b/.test(u)) return null;
  // Doing a deploy isn't a question about one.
  if (/\b(?:deploy|redeploy|promote|rollback|roll back|remove|delete|cancel)\b (?:it|this|that|the|my|to)\b/.test(u) && !/\b(?:status|last|latest|did|how)\b/.test(u)) return null;
  const project = u.match(/\bdeploy(?:ment)? (?:of|for) ([a-z0-9-]{3,60})\b/)?.[1];
  return { skill: "deploys", action: "latest", ...(project ? { project } : {}) };
}

// --- answers -----------------------------------------------------------------------------------
const RADIO = `Add-Type -AssemblyName System.Runtime.WindowsRuntime; $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]; function JarvisAwait($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(8000); $task.Result }; [void][Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]; [void][Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime]; $radios = JarvisAwait ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])`;
const PERSONALIZE = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
const DND_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "dnd.ps1");
/** Do not disturb through Settings (dnd.ps1): "on", "off", "none" or "error: …". */
export function runDnd(want: "on" | "off" | "read"): Promise<string> {
  return new Promise((resolve) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", DND_SCRIPT, "-Want", want], { windowsHide: true, timeout: 25_000 }, (error, stdout) =>
      resolve(error && !stdout ? `error: ${String(error.message).slice(0, 80)}` : String(stdout).trim().split(/\r?\n/).pop() ?? ""),
    ),
  );
}

export async function answerSettings(req: SettingsRequest, deps: { ps: PsHost; home?: string; workRoot?: string; dnd?: (want: "on" | "off" | "read") => Promise<string> }): Promise<string> {
  switch (req.action) {
    case "radio": {
      const kind = req.radio === "bluetooth" ? "Bluetooth" : "WiFi";
      const name = req.radio === "bluetooth" ? "Bluetooth" : "Wi-Fi";
      const out = (
        await deps.ps.run(
          `${RADIO}; $r = $radios | Where-Object { $_.Kind -eq '${kind}' } | Select-Object -First 1; if (-not $r) { 'NONE' } elseif ([string]$r.State -eq '${req.on ? "On" : "Off"}') { 'ALREADY' } else { $null = JarvisAwait ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]); $s = JarvisAwait ($r.SetStateAsync('${req.on ? "On" : "Off"}')) ([Windows.Devices.Radios.RadioAccessStatus]); [string]$s + ':' + [string]$r.State }`,
          20_000,
        )
      ).trim();
      if (out === "NONE") return `I can't find a ${name} radio on this PC, sir.`;
      if (out === "ALREADY") return `${name}'s already ${req.on ? "on" : "off"}, sir.`;
      if (/^Allowed:/.test(out)) return `${name}'s ${req.on ? "on" : "off"}, sir.`;
      if (/DeniedBy(?:User|System)/.test(out)) return `Windows wouldn't let me switch ${name} ${req.on ? "on" : "off"}; it's blocked in privacy settings, sir.`;
      throw new Error(`${name} didn't switch`);
    }
    case "notifications": {
      // Muted = Do not disturb on. Switched on the Settings page and read back from it.
      const want = req.on ? "off" : "on";
      const got = (await (deps.dnd ?? runDnd)(want)).trim();
      if (got === "none") throw new Error("I couldn't find the Do not disturb switch in Settings");
      if (got !== want) throw new Error(got.startsWith("error") ? got.slice(7, 120) : "Do not disturb didn't switch");
      return req.on ? "Notifications are back on, sir." : "Notifications are muted: Do not disturb is on, sir. Say \"notifications back on\" to undo it.";
    }
    case "theme": {
      const v = req.dark ? 0 : 1;
      const out = (
        await deps.ps.run(
          `$k = '${PERSONALIZE}'; Set-ItemProperty $k -Name AppsUseLightTheme -Value ${v} -Type DWord; Set-ItemProperty $k -Name SystemUsesLightTheme -Value ${v} -Type DWord; Add-Type -Namespace JarvisTheme -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendNotifyMessage(IntPtr h, uint m, UIntPtr w, string l);' -ErrorAction SilentlyContinue; [void][JarvisTheme.Native]::SendNotifyMessage([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'ImmersiveColorSet'); $p = Get-ItemProperty $k; [string]$p.AppsUseLightTheme + ',' + [string]$p.SystemUsesLightTheme`,
          15_000,
        )
      ).trim();
      if (out !== `${v},${v}`) throw new Error("Windows didn't take the change");
      return req.dark ? "Dark mode's on, sir." : "Light mode's on, sir.";
    }
    case "clipboard_history": {
      // 26 Sep: the panel can't be seen to open from here, and on this PC history is switched off
      // (Win+V then shows only a prompt to turn it on). So: say so when it's off, and press nothing.
      const on = (await deps.ps.run("[string](Get-ItemProperty 'HKCU:\Software\Microsoft\Clipboard' -Name EnableClipboardHistory -ErrorAction SilentlyContinue).EnableClipboardHistory", 5000)).trim() === "1";
      if (!on) return "Clipboard history is switched off on this PC, sir. Turn it on in Settings, System, Clipboard, and Windows+V will show it.";
      await deps.ps.run("[JarvisWin]::Chord(0x5B, 0x56); 'ok'", 5000);
      return "I've pressed Windows+V for your clipboard history, sir.";
    }
    case "folder": {
      const base = resolvePlace(req.where, deps.home ?? homedir(), deps.workRoot);
      const path = base ? join(base, req.name) : "";
      if (!base || !path.startsWith(base)) throw new Error("that isn't a folder I can use");
      if (existsSync(path)) return `There's already a ${req.name} folder in ${spokenPlace(req.where)}, sir.`;
      mkdirSync(path, { recursive: true });
      return `Made the ${req.name} folder in ${spokenPlace(req.where)}, sir.`;
    }
  }
}

/** Where the last rename's old names are kept (for "undo the rename"). */
const UNDO_FILE = (root: string) => join(root, ".operator-data", "jarvis-last-rename.json");
export async function answerFiles(req: FilesRequest, deps: { root: string; home?: string; workRoot?: string }): Promise<string> {
  const home = deps.home ?? homedir();
  if (req.action === "undo_rename") {
    let last: { folder: string; renames: Array<{ from: string; to: string }> } | null = null;
    try {
      last = JSON.parse(readFileSync(UNDO_FILE(deps.root), "utf8"));
    } catch {
      return "There's no rename of mine to undo, sir.";
    }
    let back = 0;
    for (const r of [...(last?.renames ?? [])].reverse()) {
      const from = join(last!.folder, r.to);
      const to = join(last!.folder, r.from);
      if (existsSync(from) && !existsSync(to)) {
        renameSync(from, to);
        back++;
      }
    }
    writeFileSync(UNDO_FILE(deps.root), JSON.stringify({ folder: last?.folder, renames: [] }));
    return back ? `Put ${back} file${back === 1 ? "" : "s"} back to ${back === 1 ? "its" : "their"} old name${back === 1 ? "" : "s"}, sir.` : "Nothing to put back, sir.";
  }
  const folder = resolvePlace(req.folder, home, deps.workRoot);
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) return `I can't find a ${spokenPlace(req.folder)} folder, sir.`;
  const files = readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isFile() && (req.kind === "all" || (PHOTO.test(e.name) && (req.kind === "photos" || /screen ?shot|snip|capture/i.test(e.name) || /screenshots$/i.test(req.folder)))))
    .map((e) => ({ name: e.name, ms: statSync(join(folder, e.name)).mtimeMs }));
  if (!files.length) return `There are no ${req.kind === "all" ? "files" : req.kind} in that folder to rename, sir.`;
  if (files.length > 500) return `That's ${files.length} files, sir; more than I'll rename in one go.`;
  const renames = datedNames(files).filter((r) => !existsSync(join(folder, r.to)) || files.some((f) => f.name.toLowerCase() === r.to.toLowerCase()));
  // Two passes through temporary names, so "a" → "b" and "b" → "c" can't collide.
  const temp = renames.map((r, i) => ({ ...r, tmp: `.jarvis-rename-${Date.now().toString(36)}-${i}` }));
  for (const r of temp) renameSync(join(folder, r.from), join(folder, r.tmp));
  for (const r of temp) renameSync(join(folder, r.tmp), join(folder, r.to));
  mkdirSync(join(deps.root, ".operator-data"), { recursive: true });
  writeFileSync(UNDO_FILE(deps.root), JSON.stringify({ folder, renames: renames.map(({ from, to }) => ({ from, to })) }));
  return renames.length ? `Renamed ${renames.length} ${req.kind === "all" ? "file" : req.kind.replace(/s$/, "")}${renames.length === 1 ? "" : "s"} by date, sir. Say "undo the rename" to put them back.` : "They're already named by date, sir.";
}

/** The Vercel CLI's entry script (npm's .cmd shim can't be spawned directly on Windows). */
function vercelEntry() {
  const candidates = [join(process.env.APPDATA ?? "", "npm", "node_modules", "vercel", "dist", "vc.js"), join(process.env.APPDATA ?? "", "npm", "node_modules", "vercel", "dist", "index.js")];
  return candidates.find((p) => existsSync(p)) ?? null;
}
export type DeployRow = { age: string; project: string; url: string; status: string; env: string };
/** `vercel ls` output → rows (ANSI stripped). Pure. */
export function parseDeploys(text: string): DeployRow[] {
  const rows: DeployRow[] = [];
  for (const raw of text.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const m = raw.trim().match(/^(\d+[smhdwy])\s+(\S+)\s+(https:\/\/\S+)\s+●?\s*(Ready|Error|Building|Queued|Canceled|Cancelled|Initializing)\s+(Production|Preview)\b/i);
    if (m) rows.push({ age: m[1], project: m[2].replace(/^[^/]+\//, ""), url: m[3], status: m[4], env: m[5] });
  }
  return rows;
}
const ageWords = (age: string) => {
  const n = Number(age.slice(0, -1));
  const unit = ({ s: "second", m: "minute", h: "hour", d: "day", w: "week", y: "year" } as Record<string, string>)[age.slice(-1)] ?? "";
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
};
/** The spoken summary: the latest deploy, and any recent one that failed. Pure. */
export function deploysLine(rows: DeployRow[], project?: string) {
  const mine = project ? rows.filter((r) => r.project.includes(project)) : rows;
  if (!mine.length) return project ? `I can't see any recent deploys of ${project}, sir.` : "I can't see any recent deploys, sir.";
  const last = mine[0];
  const recent = mine.slice(0, 10);
  const bad = recent.filter((r) => /error|cancel/i.test(r.status));
  const building = recent.filter((r) => /building|queued|initializing/i.test(r.status));
  const status = /ready/i.test(last.status) ? "ready" : last.status.toLowerCase();
  let line = `Your last deploy, ${last.project} to ${last.env.toLowerCase()} ${ageWords(last.age)}, is ${status}`;
  if (bad.length) line += `. ${bad.length === 1 ? `One recent deploy failed: ${bad[0].project}, ${ageWords(bad[0].age)}` : `${bad.length} of the last ${recent.length} failed, the latest ${bad[0].project}`}`;
  else if (recent.length > 1 && !building.length) line += `, and the ${recent.length - 1} before it are all ready too`;
  if (building.length && building[0] !== last) line += `. ${building[0].project} is still building`;
  return `${line}, sir.`;
}

export async function answerDeploys(req: DeploysRequest, run?: () => Promise<string>): Promise<string> {
  const entry = vercelEntry();
  const exec =
    run ??
    (() =>
      new Promise<string>((resolve, reject) => {
        if (!entry) return reject(new Error("the Vercel CLI isn't installed"));
        execFile(process.execPath.includes("bun") ? "node" : process.execPath, [entry, "ls"], { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) =>
          error && !stdout ? reject(new Error(String(stderr || error.message).split("\n")[0].slice(0, 120))) : resolve(`${stdout}\n${stderr}`),
        );
      }));
  const rows = parseDeploys(await exec());
  if (!rows.length) throw new Error("the Vercel CLI didn't list any deploys (is it signed in?)");
  return deploysLine(rows, req.project);
}
