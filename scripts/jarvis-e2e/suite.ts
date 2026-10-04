// Jarvis end-to-end suite: real multi-step tasks spoken in plain English, run through the live OS
// server (:8081) exactly as the voice client runs them. The utterance goes to /voice/free/turn;
// each tool call is carried out on the same operator routes the voice client uses (pc_act,
// skill, screen_act, lessons, browser_act, control_pc → Hermes); the tool result goes back; the
// loop ends on Jarvis's spoken reply. Then the task's own check reads the real state.
//
//   bun scripts/jarvis-e2e/suite.ts [task ids…] [--json out.json] [--label before] [--idle-max-min 30]
//
// Measured per task: completed (the check passed), clarification questions (turns that ended in
// a question to him), total time, wrong actions (a tool outside the task's expected set, or a
// side effect the task forbids), and the route taken.
//
// Safety (26 Sep, stricter after round 3 lost his clipboard and changed a folder view; guard.ts):
// - every task waits until he has had his hands off the PC for 60 s (a low-level hook tells his
//   input from Jarvis's), and the task is stopped the moment he touches anything;
// - his clipboard is snapshotted (every readable format) before the run, put back after each task,
//   and the restore checked by fingerprint; if he copied something himself, his stays;
// - files are made and changed only in D:\tmp\jarvis-suite, never his own folders; his Windows
//   settings (Bluetooth, Do not disturb, theme) and personal accounts (Spotify) are never changed:
//   those tasks are skipped by policy (--allow-settings runs the settings ones, restoring after);
//   so is opening his own VS Code (--allow-his-apps), whose extensions can update on start;
// - Notepad's saved tabs are copied before a task that opens Notepad and put back after (checked);
// - only windows and files this suite made are acted on, and each is closed or removed after;
//   tasks that would reach his own window (switching to a Notepad he has open, a Settings window
//   of his) are skipped;
// - open_url is carried out in a throwaway Edge window, never his browser;
// - nothing is sent: no message, email or form submit; the form's Submit is counted, never pressed;
// - reversible settings (Bluetooth, notifications) are read first and put back after.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPsHost, psText as psLiteral } from "../jarvis-skills/ps-host";
import { foregroundWindow, listWindows, type WindowInfo } from "../jarvis-skills/windows";
import { gateControlTask, runHermesTask } from "../../src/lib/jarvis-control";
import { runVoiceToolBatch } from "../../src/lib/screen-result";
import { nativeScreen, SCREEN_PRELUDE } from "../screen-hands/native";
import { parseSnapshot } from "../screen-hands/plan";
import { EXCEL_APP_PS } from "../jarvis-skills/pc-files";
import { createGuard, type Guard } from "./guard";
import { isOn, parseMonitors, parseWindowState, type Monitor } from "../jarvis-skills/monitors";
import { dataDirFor } from "../cloud/data-dir";

const args = process.argv.slice(2);
const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const only = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const BASE = process.env.JARVIS_OS_URL ?? "http://127.0.0.1:8081";
const ROOT = resolve(import.meta.dir, "..", "..");
const SCRATCH = join(tmpdir(), "jarvis-e2e");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const IDLE_MAX_MS = Number(flag("--idle-max-min") ?? 30) * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ps = createPsHost({ prelude: SCREEN_PRELUDE });

// --- the OS server, as the voice client talks to it ------------------------------------------------
let token = "";
/** Aborted the moment he touches the PC (the current task stops mid-request). */
let taskAbort = new AbortController();
/** The server restarts when its code changes (a new token each time): wait for it, then re-read the token. */
async function freshToken() {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${BASE}/__token`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (r?.ok) return (token = String(((await r.json()) as { token?: string }).token ?? ""));
    await sleep(2000);
  }
  throw new Error("the OS server didn't come back");
}
async function op<T = any>(path: string, body: unknown, ms = 120_000): Promise<{ status: number; data: T; text: string }> {
  if (!token) await freshToken();
  const send = () =>
    fetch(`${BASE}/__operator${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
      body: JSON.stringify(body),
      signal: path === "/screen/stop" ? AbortSignal.timeout(ms) : AbortSignal.any([AbortSignal.timeout(ms), taskAbort.signal]),
    });
  let response = await send().catch(async () => (await freshToken(), send()));
  if (response.status === 403) {
    await freshToken();
    response = await send();
  }
  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* NDJSON or text */
  }
  return { status: response.status, data, text };
}
const baseFetch = (async (input: string, init?: RequestInit) => {
  // Hermes' route reads /__token itself: hand it the live one.
  if (input === "/__token") return new Response(JSON.stringify({ token: token || (await freshToken()) }), { headers: { "Content-Type": "application/json" } });
  return fetch(input.startsWith("/") ? `${BASE}${input}` : input, init);
}) as typeof fetch;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = { role: "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type Ctx = {
  tools: string[];
  pendingControl: { task: string; at: number } | null;
  pendingScreen: { button: string; at: number } | null;
  lastUser: string;
  hermesSession: { id?: string };
  opened: WindowInfo[];
  edgeProfiles: string[];
};

// --- carrying out one tool call (the voice client's executor, minus the UI) -----------------------
const CONFIRM_MARK = "CONFIRM BUTTON: ";
async function execute(call: ToolCall, ctx: Ctx): Promise<string> {
  const name = call.function.name;
  let a: Record<string, any> = {};
  try {
    a = JSON.parse(call.function.arguments || "{}");
  } catch {
    /* empty */
  }
  ctx.tools.push(`${name}${typeof a.action === "string" ? `:${a.action}` : ""}`);
  switch (name) {
    case "pc_act": {
      if (a.action === "drive_app") {
        const r = await op<{ ok: boolean; said: string }>("/screen/cdp", { app: String(a.target ?? "") });
        return r.data?.ok ? `Done: ${r.data.said}` : `Not done: ${r.data?.said ?? r.status}`;
      }
      const r = await op<{ ok: boolean; said: string }>("/pc/act", { action: a.action, target: a.target });
      return r.data?.ok ? `Done: ${r.data.said}` : `Not done: ${r.data?.said ?? r.status}`;
    }
    case "skill": {
      const r = await op<{ said: string }>("/jarvis/skill", a);
      return r.data?.said ?? `That didn't work: ${r.status}`;
    }
    case "screen_act": {
      let confirm: string | undefined;
      if (a.confirmed === true) {
        if (!ctx.pendingScreen || Date.now() - ctx.pendingScreen.at > 120_000) return "Nothing is waiting for a yes any more, so I pressed nothing.";
        confirm = ctx.pendingScreen.button;
        ctx.pendingScreen = null;
      }
      const goal = confirm ? `click ${confirm}` : String(a.goal ?? "");
      const r = await op("/screen/act", { goal, ...(confirm ? { confirm } : {}), vision: false }, 180_000);
      const lines = r.text.split("\n").filter(Boolean);
      const done = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).reverse().find((e) => e?.type === "done");
      if (!done) return JSON.stringify({ type: "screen_result", ok: false, said: "The screen run ended without a report. Treat it as unfinished.", outcome: "unverified" });
      // Match the voice tool's string envelope without depending on its in-progress helper.
      const result = JSON.stringify({ type: "screen_result", ok: done.ok === true, said: String(done.said ?? ""), outcome: done.outcome, ask: done.ask, stopped: done.stopped });
      if (done.confirm) {
        ctx.pendingScreen = { button: done.confirm, at: Date.now() };
        return `${CONFIRM_MARK}${done.said}`;
      }
      return result;
    }
    case "screen_teach": {
      const body = typeof a.control === "string" ? { control: a.control } : typeof a.confirm === "string" ? { confirm: a.confirm } : typeof a.answer === "string" ? { answer: a.answer } : null;
      const r = body ? await op("/screen/lesson/control", body, 120_000) : await op("/screen/lesson", { goal: a.goal, mode: a.mode === "drive" ? "drive" : "teach" }, 120_000);
      return String(r.data?.said ?? r.text.slice(0, 200));
    }
    case "browser_act": {
      const r = await op<{ ok: boolean; said: string }>("/browser/act", { action: a.action, target: a.target, text: a.target });
      return r.data?.ok ? `Done: ${r.data.said}` : `Not done: ${r.data?.said ?? r.status}`;
    }
    case "open_url": {
      // Never his browser: a throwaway Edge window this suite owns.
      const url = String(a.url ?? "");
      if (!/^https?:\/\//.test(url) && !/^[\w.-]+\.[a-z]{2,}/i.test(url)) return "That is not a web address I can open. Nothing was opened.";
      const w = await edgeWindow(url.startsWith("http") ? url : `https://${url}`, null, ctx);
      return w ? `Opened ${new URL(url.startsWith("http") ? url : `https://${url}`).host} in the browser.` : "Couldn't open it.";
    }
    case "control_pc": {
      const decision = gateControlTask({ task: String(a.task ?? ""), confirmed: a.confirmed === true, pending: ctx.pendingControl, lastUserUtterance: ctx.lastUser, now: Date.now() });
      if (decision.action === "ask") {
        ctx.pendingControl = decision.pending;
        return decision.reply;
      }
      if (decision.action === "refuse") return decision.reply;
      ctx.pendingControl = null;
      return runHermesTask(decision.task, { signal: AbortSignal.timeout(240_000), session: ctx.hermesSession, fetch: baseFetch, approval: decision.approval });
    }
    case "screen":
      return "Screen sharing is off, so I can't see the screen.";
    case "navigate":
    case "show_visual":
      return "Opened that page in the OS.";
    default:
      return `The ${name} tool isn't available in this test.`;
  }
}

// --- one spoken task: the turn loop ---------------------------------------------------------------
type Outcome = { said: string; turns: number; questions: number; ms: number; tools: string[]; firstMs: number | null; route: string[] };
async function converse(utterance: string, answers: string[], ctx: Ctx): Promise<Outcome> {
  const started = Date.now();
  const messages: Message[] = [{ role: "user", content: utterance }];
  ctx.lastUser = utterance;
  let said = "";
  let questions = 0;
  let turns = 0;
  let firstMs: number | null = null;
  const route: string[] = [];
  const replies = [...answers];
  for (let hop = 0; hop < 12; hop++) {
    turns++;
    const r = await op<{ content: string | null; tool_calls?: ToolCall[]; model?: string; route?: { intent?: string } }>("/voice/free/turn", { messages, context: [], sharing: false }, 60_000);
    if (r.status !== 200 || !r.data) {
      said = `(turn failed: ${r.status} ${r.text.slice(0, 120)})`;
      break;
    }
    route.push(r.data.model ?? "?");
    const calls = r.data.tool_calls ?? [];
    if (calls.length) {
      messages.push({ role: "assistant", content: r.data.content ?? null, tool_calls: calls });
      const pause = await runVoiceToolBatch(calls, async (call) => {
        const result = await execute(call, ctx).catch((e) => `Not done: ${(e as Error).message}`);
        firstMs ??= Date.now() - started;
        return result;
      }, (id, result) => {
        messages.push({ role: "tool", tool_call_id: id, content: result.slice(0, 4000) });
      });
      if (pause !== null) {
        said = pause;
        messages.push({ role: "assistant", content: said });
        break;
      }
      continue;
    }
    said = String(r.data.content ?? "").trim();
    messages.push({ role: "assistant", content: said });
    const asks = /\?\s*$/.test(said) || /\b(?:shall i|should i|do you want|would you like|which one|what should|please confirm|confirm (?:the|that|this)|approve)\b/i.test(said);
    if (asks) {
      questions++;
      // A yes/no check on the task he just asked for gets his "yes" (still counted as a question);
      // anything else needs a scripted answer, or the task ends there.
      const confirming = /\b(?:shall i|should i|do you want me to|want me to|confirm|proceed|go ahead|okay to|ok to|is that right)\b/i.test(said);
      // Never an automatic "yes" to Hermes's computer control: it works on the whole PC, outside
      // this suite's windows (25 Sep: notepad-list fell back to it). Only a scripted answer goes.
      const reply = replies.shift() ?? (confirming && !ctx.pendingControl ? "yes" : undefined);
      if (!reply) break;
      messages.push({ role: "user", content: reply });
      ctx.lastUser = reply;
      continue;
    }
    break;
  }
  return { said, turns, questions, ms: Date.now() - started, tools: [...ctx.tools], firstMs, route };
}

// --- the PC: windows, idle, fixtures ---------------------------------------------------------------
const windows = () => listWindows(ps).catch(() => [] as WindowInfo[]);
const handles = async () => new Set((await windows()).map((w) => w.handle));
async function newWindow(before: Set<number>, match: (w: WindowInfo) => boolean, ms = 15_000) {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    const w = (await windows()).find((x) => !before.has(x.handle) && match(x));
    if (w) return w;
    await sleep(400);
  }
  return null;
}
async function focus(handle: number) {
  return (await ps.run(`[JarvisWin]::Focus(${Math.trunc(handle)})`)).trim() === "True";
}
async function closeWindow(handle: number) {
  await ps.run(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class JarvisClose { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }' -ErrorAction SilentlyContinue; [void][JarvisClose]::PostMessage([IntPtr]${Math.trunc(handle)}, 16, [IntPtr]::Zero, [IntPtr]::Zero); 'ok'`, 10_000).catch(() => undefined);
}
async function killByCommandLine(image: string, marker: string) {
  const mark = marker.replace(/'/g, "''").replace(/[[\]*?]/g, "");
  await ps.run(`Get-CimInstance Win32_Process -Filter "Name='${image}'" | Where-Object { $_.CommandLine -like '*${mark}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'ok'`, 20_000).catch(() => undefined);
}
/** A throwaway Edge window (its own profile) on a URL; `title` waits for it. */
async function edgeWindow(url: string, title: RegExp | null, ctx: Ctx, size = "900,700") {
  const profile = join(SCRATCH, `edge-${ctx.edgeProfiles.length}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  ctx.edgeProfiles.push(profile);
  const before = await handles();
  spawn(EDGE, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-position=160,90", `--window-size=${size}`, `--app=${url}`], { detached: true, stdio: "ignore" }).unref();
  const w = await newWindow(before, (x) => /^msedge$/i.test(x.process) && (!title || title.test(x.title)), 20_000);
  if (w) ctx.opened.push(w);
  return w;
}
const bench = (page: string) => pathToFileURL(join(ROOT, "scripts", "screen-hands", "bench", page)).href;
const titleOf = async (handle: number) => (await windows()).find((w) => w.handle === handle)?.title ?? "";
const psText = (script: string, ms = 20_000) => ps.run(script, ms).then((s) => s.trim()).catch(() => "");

// --- the tasks -----------------------------------------------------------------------------------
type Check = { ok: boolean; wrong: string[]; note?: string };
type Task = {
  id: string;
  say: string;
  /** Skipped unless allowed: "settings" changes his Windows settings; "account" uses his accounts. */
  policy?: "settings" | "account" | "his-app";
  /** The words, chosen from what setup found (e.g. light mode when he's in dark mode). */
  sayFrom?: (state: Record<string, any>) => string;
  /** Scripted replies, in order, when Jarvis asks something. */
  answers?: string[];
  /** Tools that are a sensible route for this task (anything else counts as a wrong action). */
  tools: RegExp;
  /** Set up; returns state for check/cleanup, or a reason to skip. */
  setup?(ctx: Ctx): Promise<Record<string, any> | { skip: string }>;
  check(out: Outcome, state: Record<string, any>, ctx: Ctx): Promise<Check>;
  cleanup?(state: Record<string, any>, ctx: Ctx): Promise<void>;
  /** His app's own state this task may change (it opens that app): saved first, put back after. */
  appState?: { process: string; states: AppState[] };
};

const DOWNLOADS = join(homedir(), "Downloads");
/** Everything this suite makes or changes lives here, never in his own folders. */
const WORK = "D:\\tmp\\jarvis-suite";
const SHOTS = join(WORK, "shots");
const MADE_FOLDER = join(WORK, "made-by-jarvis");
const timers = () => {
  try {
    return (JSON.parse(readFileSync(join(dataDirFor(ROOT), "jarvis-timers.json"), "utf8")).items ?? []) as Array<Record<string, any>>;
  } catch {
    return [];
  }
};
/** Cancel the timers this task made (by their phrase, and only when no older timer shares it). */
const cancelNewTimers = async (before: Set<string>) => {
  const all = timers();
  for (const t of all.filter((x) => !before.has(String(x.id)))) {
    const match = t.phrase ?? t.label ?? t.text;
    if (match && !all.some((o) => before.has(String(o.id)) && (o.phrase ?? o.label ?? o.text) === match))
      await op("/jarvis/skill", { skill: "timer", action: "cancel", kind: t.kind ?? "timer", match }).catch(() => undefined);
  }
};
const notepadText = (handle: number) =>
  psText(`$w = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Math.trunc(handle)}); $c = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document); $d = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c); $o = $null; if ($d -and $d.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$o)) { $o.DocumentRange.GetText(2000) } else { '' }`);
const BT = `Add-Type -AssemblyName System.Runtime.WindowsRuntime; $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]; function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(8000); $task.Result }; [void][Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]; $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]); $bt = $radios | Where-Object { $_.Kind -eq 'Bluetooth' } | Select-Object -First 1`;
const bluetooth = () => psText(`${BT}; if ($bt) { [string]$bt.State } else { 'none' }`, 30_000);
const setBluetooth = (on: boolean) =>
  psText(`${BT}; if ($bt) { [void][Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime]; $null = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]); $null = Await ($bt.SetStateAsync('${on ? "On" : "Off"}')) ([Windows.Devices.Radios.RadioAccessStatus]); [string]$bt.State }`, 30_000);
const TOASTS = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings";
/**
 * 25 Sep: this suite runs inside the Claude desktop app's MSIX package, where HKCU writes are
 * virtualised: a "restore" written from here never reached his real registry (his notifications
 * stayed muted). Real reads and writes go through a process started by WMI, outside the package.
 */
async function outside(command: string, ms = 10_000): Promise<string> {
  // The answer lands under D:\tmp (never his home folder), and only once the command has finished.
  mkdirSync(WORK, { recursive: true });
  const file = join(WORK, `outside-${Date.now().toString(36)}.txt`);
  const cmd = `cmd.exe /c (${command}) > "${file}.part" 2>&1 & move /y "${file}.part" "${file}" >nul`;
  await psText(`$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral(cmd)} }; 'ok'`, 20_000);
  for (const until = Date.now() + ms; Date.now() < until; ) {
    await sleep(250);
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      rmSync(file, { force: true });
      return text;
    }
  }
  return "";
}

// --- his apps' own state ------------------------------------------------------------------------------
// Opening Notepad reopens his saved tabs (and saves them again as it closes); opening VS Code adds
// to his recent list and workspace state. So before a task that opens one (only when it isn't
// running), that state is copied to D:\tmp; after, once the app has gone, it's compared file by file
// and, if anything differs, put back exactly (through a process outside the app package, so the
// write is real) and compared again.
type AppState = { label: string; dir: string; how: "mirror" | "new-folders" };
const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const ROAMING = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const NOTEPAD_PKG = join(LOCAL, "Packages", "Microsoft.WindowsNotepad_8wekyb3d8bbwe");
const NOTEPAD_STATE: AppState[] = [
  { label: "notepad-tabs", dir: join(NOTEPAD_PKG, "LocalState"), how: "mirror" },
  { label: "notepad-settings", dir: join(NOTEPAD_PKG, "Settings"), how: "mirror" },
];
const VSCODE_STATE: AppState[] = [
  { label: "vscode-global", dir: join(ROAMING, "Code", "User", "globalStorage"), how: "mirror" },
  { label: "vscode-workspaces", dir: join(ROAMING, "Code", "User", "workspaceStorage"), how: "new-folders" },
  { label: "vscode-backups", dir: join(ROAMING, "Code", "Backups"), how: "new-folders" },
];
/** Every file under `dir`: path, size and content hash (or the top folders' names). */
function fingerprint(s: AppState): string {
  if (!existsSync(s.dir)) return "absent";
  if (s.how === "new-folders") return readdirSync(s.dir).sort().join("|");
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${rel}${n}/`);
      else {
        let h = "locked";
        try {
          h = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
        } catch {}
        out.push(`${rel}${n}:${st.size}:${h}`);
      }
    }
  };
  walk(s.dir, "");
  return out.join("\n");
}
type SavedState = { s: AppState; print: string; backup: string };
function saveAppState(task: string, states: AppState[]): SavedState[] {
  return states.map((s) => {
    const backup = join(WORK, "app-state", `${task}-${s.label}`);
    rmSync(backup, { recursive: true, force: true });
    if (s.how === "mirror" && existsSync(s.dir)) spawnSync("robocopy", [s.dir, backup, "/MIR", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { windowsHide: true });
    return { s, print: fingerprint(s), backup };
  });
}
/** After the task: wait for the app to go, then compare, put back if needed, and compare again. */
async function restoreAppState(saved: SavedState[], process: string, since: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    if ((await psText(`@(Get-Process ${process} -ErrorAction SilentlyContinue).Count`)) === "0") break;
    // It wasn't running before this task, so what's running now started during it: ours.
    if (i === 30) await psText(`Get-Process ${process} -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt [datetime]'${since}' } | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'`);
    await sleep(500);
  }
  if ((await psText(`@(Get-Process ${process} -ErrorAction SilentlyContinue).Count`)) !== "0") return `${process} still running: state NOT checked`;
  await sleep(800);
  const notes: string[] = [];
  for (const { s, print, backup } of saved) {
    if (fingerprint(s) === print) {
      notes.push(`${s.label} unchanged`);
      continue;
    }
    if (s.how === "mirror") await outside(`robocopy "${backup}" "${s.dir}" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP`, 60_000);
    else {
      const before = new Set(print.split("|"));
      for (const n of readdirSync(s.dir).filter((x) => !before.has(x) && /^[\w.-]+$/.test(x))) await outside(`rmdir /s /q "${join(s.dir, n)}"`, 30_000);
    }
    await sleep(500);
    notes.push(`${s.label} ${fingerprint(s) === print ? "restored (verified)" : "restore NOT verified"}`);
  }
  return notes.join(", ");
}
const REAL_THEME = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
/** "apps,system" light-theme values in his real registry ("1,1" light, "0,0" dark). */
async function realTheme() {
  const out = await outside(`reg query "${REAL_THEME}" /v AppsUseLightTheme & reg query "${REAL_THEME}" /v SystemUsesLightTheme`);
  const v = (name: string) => out.match(new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, "i"))?.[1];
  const a = v("AppsUseLightTheme"), b = v("SystemUsesLightTheme");
  return a === undefined || b === undefined ? "" : `${parseInt(a, 16)},${parseInt(b, 16)}`;
}
async function setRealTheme(value: string) {
  const [a, b] = value.split(",").map(Number);
  await outside(`reg add "${REAL_THEME}" /v AppsUseLightTheme /t REG_DWORD /d ${a} /f & reg add "${REAL_THEME}" /v SystemUsesLightTheme /t REG_DWORD /d ${b} /f`);
  // The same broadcast Settings sends, so open apps repaint.
  await psText(`Add-Type -Namespace JarvisSuiteTheme -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendNotifyMessage(IntPtr h, uint m, UIntPtr w, string l);' -ErrorAction SilentlyContinue; [void][JarvisSuiteTheme.Native]::SendNotifyMessage([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'ImmersiveColorSet'); 'ok'`);
}
/** Do not disturb, read or set on the Settings page (the same script the skill uses). */
const DND = join(ROOT, "scripts", "jarvis-skills", "dnd.ps1");
const dnd = (want: "on" | "off" | "read") =>
  new Promise<string>((resolve) =>
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DND, "-Want", want], { windowsHide: true, timeout: 25_000 }, (_e, out) => resolve(String(out ?? "").trim().split(/\r?\n/).pop() ?? "")),
  );

/**
 * The notifications toggle, read with reg.exe (25 Sep: the shared PowerShell host once answered
 * nothing right after the Bluetooth task, so a muted toggle read as "not muted").
 */
const TOAST_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings";
function toastsNow() {
  try {
    const out = execFileSync("reg", ["query", TOAST_KEY, "/v", "NOC_GLOBAL_SETTING_TOASTS_ENABLED"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
    return m ? String(parseInt(m[1], 16)) : "unset";
  } catch {
    return "unset";
  }
}
const toasts = async () => toastsNow();
/** Poll a moment for a value (a setting written by another process lands within ~100 ms). */
async function settles(read: () => Promise<string> | string, want: string, ms = 2000) {
  for (const until = Date.now() + ms; ; ) {
    const v = await read();
    if (v === want || Date.now() > until) return v;
    await sleep(150);
  }
}
const setToasts = (value: string) =>
  value === "unset"
    ? psText(`Remove-ItemProperty -Path '${TOASTS}' -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -ErrorAction SilentlyContinue; 'ok'`)
    : psText(`Set-ItemProperty -Path '${TOASTS}' -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -Value ${Number(value) ? 1 : 0} -Type DWord; 'ok'`);
const jarvisChromeTabs = async () => {
  const r = await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(2000) }).catch(() => null);
  return r?.ok ? ((await r.json()) as Array<{ id: string; type: string; url: string; title: string }>).filter((t) => t.type === "page") : [];
};
const closeJarvisTab = (id: string) => fetch(`http://127.0.0.1:9222/json/close/${id}`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
const any = (text: string, ...res: RegExp[]) => res.some((re) => re.test(text));

/** Our own Notepad window (Windows 11 Notepad opens new windows in one process). */
async function openNotepad(ctx: Ctx) {
  const before = await handles();
  spawn("notepad.exe", [], { detached: true, stdio: "ignore" }).unref();
  const w = await newWindow(before, (x) => /^notepad$/i.test(x.process));
  if (w) ctx.opened.push(w);
  await sleep(1200);
  return w;
}
/** Close our Notepad window without saving (Ctrl+A, Delete, then WM_CLOSE; the text is ours). */
/** Close a Notepad window this suite opened: only when its process started after `since` (ours). */
async function closeNotepad(handle: number, since = 0) {
  if (!(await windows()).some((w) => w.handle === handle)) return;
  const pid = Number(await psText(`[JarvisScreen]::Pid(${Math.trunc(handle)})`)) || 0;
  const started = Number(await psText(`[int64]((Get-Process -Id ${pid}).StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds`)) || 0;
  if (!pid || started < since - 2000) {
    console.log("   (that Notepad belongs to an older process: not touched)");
    return;
  }
  // No Ctrl+A, Delete: Notepad reopens his saved tabs, and one of his could be the tab in front.
  // Its process is ours (started during the task), so it's stopped; his tabs' saved state is put
  // back from the copy taken before (restoreAppState).
  await psText(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; 'ok'`);
}

// --- window management across his screens ---------------------------------------------------------
const WINDOW_TEST = join(WORK, "window-test.txt");
const screens = async () => parseMonitors(await psText("[JarvisWin]::Monitors()"));
/** Our own Notepad on a D:\tmp file (his Notepad isn't running: the task's appState checks that). */
async function openTestNotepad() {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(WINDOW_TEST, "Jarvis window test (safe to delete).\r\n");
  const before = await handles();
  const since = Date.now();
  spawn("notepad.exe", [WINDOW_TEST], { detached: true, stdio: "ignore" }).unref();
  const w = await newWindow(before, (x) => /^notepad$/i.test(x.process) && /window-test/i.test(x.title));
  await sleep(800);
  return w ? { ...w, since } : null;
}
/** Up (not minimised), in front, and its centre on the screen it should be on. */
async function windowCheck(handle: number, want: (ms: Monitor[]) => Monitor): Promise<Check> {
  const ms = await screens();
  const st = parseWindowState(await psText(`[JarvisWin]::State(${Math.trunc(handle)})`));
  const target = want(ms);
  const front = (await foregroundWindow(ps))?.handle === handle;
  const on = !!st && !st.minimised && isOn(st.rect, target);
  return { ok: on && front, wrong: [], note: `${st ? `${st.minimised ? "minimised " : ""}at ${st.rect.x},${st.rect.y} ${st.rect.w}x${st.rect.h}` : "gone"}; wanted ${target.device}; front=${front}` };
}

// --- fixtures for the 30-task suite (25 Sep, round 4) ------------------------------------------------
const FILES = join(WORK, "files");
/** Remove the suite's own test folder, retrying while an app it opened lets go of a file. */
async function removeFiles() {
  for (let i = 0; i < 10 && existsSync(FILES); i++) {
    try {
      rmSync(FILES, { recursive: true, force: true });
    } catch {
      await sleep(700);
    }
  }
}
function makeFiles() {
  rmSync(FILES, { recursive: true, force: true });
  mkdirSync(FILES, { recursive: true });
  writeFileSync(join(FILES, "report.txt"), "Jarvis suite report\r\nA harmless file for the end-to-end suite.\r\n");
  writeFileSync(join(FILES, "notes.txt"), "Jarvis suite notes\r\n");
}
const appRunning = async (image: string) => Number(await psText(`@(Get-Process ${image} -ErrorAction SilentlyContinue).Count`)) > 0;
/** Office through its own automation (our documents only: the app wasn't running before). */
const officeClose = (prog: "Excel.Application" | "Word.Application", image: string, since: string) =>
  psText(
    `try { $a = [Runtime.InteropServices.Marshal]::GetActiveObject('${prog}'); $a.DisplayAlerts = ${prog === "Word.Application" ? "0" : "$false"}; ${prog === "Word.Application" ? "foreach ($d in @($a.Documents)) { $d.Close(0) }" : "foreach ($w in @($a.Workbooks)) { $w.Close($false) }"}; $a.Quit() } catch {}; Start-Sleep -Milliseconds 1500; Get-Process ${image} -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt [datetime]'${since}' } | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'`,
    40_000,
  );
/**
 * Open a file in Excel or Word through their automation, visible, WITHOUT adding it to his recent
 * files (AddToMru / AddToRecentFiles off) and without the shell's recent items. Starts the app.
 */
const officeOpen = (app: "excel" | "word", file: string) =>
  psText(
    app === "excel"
      ? `$x = New-Object -ComObject Excel.Application; $x.Visible = $true; $m = [Type]::Missing; $null = $x.Workbooks.Open(${psLiteral(file)}, $m, $m, $m, $m, $m, $m, $m, $m, $m, $m, $m, $false); $x.WindowState = -4143; $x.UserControl = $true; 'ok'`
      : `$w = New-Object -ComObject Word.Application; $w.Visible = $true; $m = [Type]::Missing; $null = $w.Documents.Open(${psLiteral(file)}, $false, $false, $false); $w.Activate(); $w.UserControl = $true; 'ok'`,
    60_000,
  );
const THEME_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
const theme = async () => (await psText(`$p = Get-ItemProperty '${THEME_KEY}'; [string]$p.AppsUseLightTheme + ',' + [string]$p.SystemUsesLightTheme`)).trim();
const setTheme = (v: string) => {
  const [apps, sys] = v.split(",");
  return psText(`${apps !== "" ? `Set-ItemProperty '${THEME_KEY}' -Name AppsUseLightTheme -Value ${Number(apps)} -Type DWord;` : ""} ${sys !== "" ? `Set-ItemProperty '${THEME_KEY}' -Name SystemUsesLightTheme -Value ${Number(sys)} -Type DWord;` : ""} 'ok'`);
};
const clipboardText = () => psText("try { [string][Windows.Forms.Clipboard]::GetText() } catch { '' }");
const newFiles = (dir: string, since: number) => (existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).mtimeMs >= since - 1000) : []);

const TASKS: Task[] = [
  {
    id: "vercel-status",
    say: "open Chrome, go to my Vercel dashboard and tell me the last deploy status",
    tools: /^(?:control_pc|open_url|browser_act|skill)/,
    check: async (out) => ({ ok: any(out.said, /\b(?:ready|error|errored|failed|building|queued|cancel+ed|succeeded|success|live|deployed)\b/i) && !/couldn't|can't|unable|not (?:logged|signed)/i.test(out.said), wrong: [] }),
  },
  {
    id: "rename-screenshots",
    say: "rename the screenshots in D:\\tmp\\jarvis-suite\\shots by date",
    tools: /^(?:control_pc|skill)/,
    setup: async () => {
      rmSync(SHOTS, { recursive: true, force: true });
      mkdirSync(SHOTS, { recursive: true });
      const days = ["2026-09-18", "2026-09-20", "2026-09-22", "2026-09-24"];
      const files = days.map((d, i) => {
        const f = join(SHOTS, `Screenshot ${i + 1}.png`);
        writeFileSync(f, Buffer.from("89504e470d0a1a0a", "hex"));
        const t = new Date(`${d}T10:0${i}:00`);
        utimesSync(f, t, t);
        return { f, d };
      });
      return { days, count: files.length };
    },
    check: async (_out, st) => {
      const names = existsSync(SHOTS) ? readdirSync(SHOTS) : [];
      const dated = st.days.filter((d: string) => names.some((n) => n.includes(d) || n.includes(d.replace(/-/g, ""))));
      const wrong = names.length !== st.count ? [`${names.length} files now, ${st.count} before`] : [];
      return { ok: dated.length === st.count && names.length === st.count, wrong, note: names.join(", ").slice(0, 200) };
    },
    cleanup: async () => rmSync(SHOTS, { recursive: true, force: true }),
  },
  {
    id: "vscode-tests",
    say: "open VS Code in the AgenticOS repo and run the tests in scripts/jarvis-skills",
    policy: "his-app",
    appState: { process: "Code", states: VSCODE_STATE },
    tools: /^(?:control_pc|pc_act|delegate_task)/,
    setup: async () => {
      const running = (await psText("@(Get-Process Code -ErrorAction SilentlyContinue).Count")) !== "0";
      return running ? { skip: "VS Code is already open (his), so it wasn't touched" } : { before: [...(await handles())] };
    },
    check: async (out, st) => {
      const code = (await windows()).filter((w) => /^code$/i.test(w.process) && !st.before.includes(w.handle));
      const ran = any(out.said, /\b\d+\s+(?:tests? )?pass(?:ed|ing)?\b|\ball (?:the )?tests pass|\bpassed\b/i);
      return { ok: code.some((w) => /agenticos/i.test(w.title)) && ran, wrong: [], note: `${code.map((w) => w.title).join(" | ")}` };
    },
    cleanup: async (st) => {
      for (const w of (await windows()).filter((x) => /^code$/i.test(x.process) && !st.before.includes(x.handle))) await closeWindow(w.handle);
    },
  },
  {
    id: "bluetooth-on",
    policy: "settings",
    say: "turn on Bluetooth",
    tools: /^(?:control_pc|skill|pc_act)/,
    setup: async () => {
      const state = await bluetooth();
      // Already on: not measurable without switching it off first, which could drop his headphones.
      if (state === "On") return { skip: "Bluetooth is already on (switching it off to test could drop his devices)" };
      return state === "Off" ? { state } : { skip: `no Bluetooth radio readable (${state || "?"})` };
    },
    check: async (out, st) => {
      const now = await bluetooth();
      return { ok: now === "On", wrong: [], note: `was ${st.state}, now ${now}` };
    },
    cleanup: async (st) => {
      if ((await bluetooth()) !== st.state) await setBluetooth(st.state === "On");
    },
  },
  {
    id: "focus-timer-mute",
    policy: "settings",
    say: "set a 25-minute focus timer and mute notifications",
    tools: /^(?:skill|control_pc|pc_act)/,
    setup: async () => {
      // Do not disturb is read and put back on the Settings page: never while his Settings is open.
      if (await appRunning("SystemSettings")) return { skip: "Settings is open (his), so Do not disturb wasn't touched" };
      const was = await dnd("read");
      if (was !== "on" && was !== "off") return { skip: `Do not disturb unreadable (${was})` };
      if (was === "on") return { skip: "Do not disturb is already on" };
      return { dnd: was, timers: timers().map((t) => String(t.id)) };
    },
    check: async (_out, st) => {
      const fresh = timers().filter((t) => !st.timers.includes(String(t.id)));
      const timer = fresh.some((t) => Math.abs(Date.parse(t.dueAt) - Date.now() - 25 * 60_000) < 4 * 60_000);
      const muted = (await dnd("read")) === "on";
      return { ok: timer && muted, wrong: [], note: `timer ${timer ? "set" : "missing"}, Do not disturb ${muted ? "on" : "off"}` };
    },
    cleanup: async (st) => {
      await cancelNewTimers(new Set(st.timers));
      if (st.dnd && (await dnd("read")) !== st.dnd) console.log(`   Do not disturb put back: ${await dnd(st.dnd)}`);
    },
  },
  {
    id: "spotify-liked",
    policy: "account",
    say: "open Spotify and play my liked songs",
    tools: /^(?:open_url|browser_act|pc_act|control_pc)/,
    setup: async () => ({ tabs: (await jarvisChromeTabs()).map((t) => t.id), before: [...(await handles())] }),
    check: async (out, st) => {
      const tabs = (await jarvisChromeTabs()).filter((t) => !st.tabs.includes(t.id));
      const liked = tabs.some((t) => /open\.spotify\.com\/collection\/tracks/.test(t.url)) || /liked songs/i.test(out.said) && /play/i.test(out.said);
      return { ok: liked && !/can't|couldn't|log ?in|sign ?in/i.test(out.said), wrong: [], note: tabs.map((t) => t.url).join(" ").slice(0, 160) };
    },
    cleanup: async (st) => {
      for (const t of await jarvisChromeTabs()) if (!st.tabs.includes(t.id)) await closeJarvisTab(t.id);
      for (const w of (await windows()).filter((x) => /spotify/i.test(x.title) && !st.before.includes(x.handle))) await closeWindow(w.handle);
    },
  },
  {
    id: "form-fill",
    say: "fill this form with my details",
    tools: /^(?:screen_act|screen_teach)/,
    setup: async (ctx) => {
      const w = await edgeWindow(bench("form.html"), /^Form bench/, ctx, "640,860");
      if (!w) return { skip: "the form page didn't open" };
      await sleep(1500);
      await focus(w.handle);
      return { handle: w.handle };
    },
    check: async (_out, st) => {
      const snap = parseSnapshot(await nativeScreen(ps).snapshot(st.handle), { browser: true });
      const value = (label: string) => snap.elements.find((e) => e.web !== false && ["Edit", "Document"].includes(e.type) && e.name === label)?.value ?? "";
      const want: Record<string, RegExp> = { "First name": /^Usman$/, "Business name": /^M&U Ventures$/, "Who else runs it with you?": /^Mehroz$/ };
      const filled = Object.entries(want).filter(([l, re]) => re.test(value(l))).length;
      const submitted = /submitted=[1-9]/.test(await titleOf(st.handle));
      const bad = ["Card number", "Last name", "Email", "Phone"].filter((l) => value(l));
      const wrong = [...(submitted ? ["pressed Submit"] : []), ...bad.map((l) => `filled ${l}`), ...(value("Promo code") !== "SPRING" ? ["changed Promo code"] : [])];
      return { ok: filled === 3 && !wrong.length, wrong, note: `${filled}/3 key fields` };
    },
  },
  {
    id: "notepad-list",
    say: "open Notepad and type a shopping list: milk, eggs, bread",
    appState: { process: "notepad", states: NOTEPAD_STATE },
    tools: /^(?:pc_act|screen_act|skill|control_pc)/,
    setup: async () => {
      // Any Notepad running (his, or another agent's): its restored tabs could be typed into.
      if (Number(await psText("@(Get-Process notepad -ErrorAction SilentlyContinue).Count")) > 0) return { skip: "Notepad is already running (someone's tabs), so it wasn't touched" };
      return { before: [...(await handles())], since: Date.now() };
    },
    check: async (_out, st) => {
      const ours = (await windows()).filter((w) => /^notepad$/i.test(w.process) && !st.before.includes(w.handle));
      let text = "";
      for (const w of ours) text += await notepadText(w.handle);
      st.ours = ours.map((w) => w.handle);
      return { ok: /milk/i.test(text) && /eggs/i.test(text) && /bread/i.test(text), wrong: ours.length > 1 ? [`${ours.length} Notepad windows`] : [], note: text.slice(0, 80) };
    },
    cleanup: async (st) => {
      for (const h of st.ours ?? []) await closeNotepad(h, st.since);
    },
  },
  {
    id: "battery",
    say: "how much battery have I got",
    tools: /^skill/,
    check: async (out) => ({ ok: any(out.said, /\d+\s*%|per ?cent|no battery|plugged in|mains|desktop/i), wrong: [] }),
  },
  {
    id: "disk-space",
    say: "how much free space is on my C drive",
    tools: /^(?:skill|control_pc)/,
    check: async (out) => ({ ok: any(out.said, /\d+(?:\.\d+)?\s*(?:GB|gigabytes|TB|terabytes)/i), wrong: [] }),
  },
  {
    id: "downloads-folder",
    say: "open my Downloads folder",
    tools: /^pc_act/,
    setup: async () => ({ before: [...(await handles())] }),
    check: async (_out, st) => {
      await sleep(1500);
      const w = (await windows()).filter((x) => /^explorer$/i.test(x.process) && /downloads/i.test(x.title) && !st.before.includes(x.handle));
      st.ours = w.map((x) => x.handle);
      return { ok: w.length > 0, wrong: [] };
    },
    cleanup: async (st) => {
      for (const h of st.ours ?? []) await closeWindow(h);
    },
  },
  {
    id: "maths",
    say: "what's 18% of 4,850",
    tools: /^skill/,
    check: async (out) => ({ ok: /\b873\b/.test(out.said.replace(/,/g, "")), wrong: [] }),
  },
  {
    id: "open-goal-screen",
    say: "turn off email alerts in this app",
    tools: /^(?:screen_act|screen_teach)/,
    setup: async (ctx) => {
      const w = await edgeWindow(bench("steps.html"), /^Steps bench/, ctx);
      if (!w) return { skip: "the steps page didn't open" };
      await sleep(1500);
      await focus(w.handle);
      return { handle: w.handle };
    },
    check: async (_out, st) => {
      const t = await titleOf(st.handle);
      const clicks = (t.match(/clicks: (.*?) \|/)?.[1] ?? "").split(">").filter(Boolean);
      const wrong = clicks.filter((c) => !["Notifications", "Email alerts"].includes(c));
      return { ok: /email=off/.test(t) && /digest=on/.test(t) && /sms=off/.test(t), wrong: wrong.map((c) => `clicked ${c}`), note: clicks.join(">") };
    },
  },
  {
    id: "take-over-dark",
    say: "take over and switch this app to dark mode",
    tools: /^(?:screen_teach|screen_act)/,
    setup: async (ctx) => {
      const w = await edgeWindow(bench("steps.html"), /^Steps bench/, ctx);
      if (!w) return { skip: "the steps page didn't open" };
      await sleep(1500);
      await focus(w.handle);
      return { handle: w.handle };
    },
    check: async (_out, st) => {
      // A take-over lesson runs on after its first line: give it a moment to finish.
      for (let i = 0; i < 20 && !/theme=dark/.test(await titleOf(st.handle)); i++) await sleep(500);
      const t = await titleOf(st.handle);
      const clicks = (t.match(/clicks: (.*?) \|/)?.[1] ?? "").split(">").filter(Boolean);
      const wrong = clicks.filter((c) => !["Appearance", "Dark"].includes(c));
      return { ok: /theme=dark/.test(t), wrong: wrong.map((c) => `clicked ${c}`), note: clicks.join(">") };
    },
    cleanup: async () => void (await op("/screen/stop", {}).catch(() => undefined)),
  },
  {
    id: "youtube-search",
    say: "search YouTube for lo-fi beats",
    tools: /^(?:open_url|browser_act)/,
    setup: async () => ({ tabs: (await jarvisChromeTabs()).map((t) => t.id) }),
    check: async (out, st, ctx) => {
      const tabs = (await jarvisChromeTabs()).filter((t) => !st.tabs.includes(t.id));
      const inEdge = ctx.opened.some((w) => /youtube/i.test(w.title));
      const ok = tabs.some((t) => /youtube\.com\/results\?search_query=lo/i.test(t.url)) || inEdge || (/youtube/i.test(ctx.tools.join(" ")) && /lo-?fi/i.test(out.said));
      return { ok: ok || tabs.some((t) => /youtube/.test(t.url) && /lo/i.test(t.url)), wrong: [], note: tabs.map((t) => t.url).join(" ").slice(0, 120) };
    },
    cleanup: async (st) => {
      for (const t of await jarvisChromeTabs()) if (!st.tabs.includes(t.id)) await closeJarvisTab(t.id);
    },
  },
  {
    id: "timer-2min",
    say: "set a timer for 2 minutes",
    tools: /^skill/,
    setup: async () => ({ timers: timers().map((t) => String(t.id)) }),
    check: async (_out, st) => ({ ok: timers().some((t) => !st.timers.includes(String(t.id))), wrong: [] }),
    cleanup: async (st) => cancelNewTimers(new Set(st.timers)),
  },
  {
    id: "make-folder",
    say: "make a new folder in D:\\tmp\\jarvis-suite called made-by-jarvis",
    tools: /^(?:control_pc|skill|pc_act)/,
    setup: async () => (mkdirSync(WORK, { recursive: true }), existsSync(MADE_FOLDER) ? { skip: "the folder already exists" } : {}),
    check: async () => ({ ok: existsSync(MADE_FOLDER) && statSync(MADE_FOLDER).isDirectory(), wrong: [] }),
    cleanup: async () => {
      if (existsSync(MADE_FOLDER) && !readdirSync(MADE_FOLDER).length) rmSync(MADE_FOLDER, { recursive: false, force: true });
    },
  },
  {
    id: "switch-window",
    say: "switch to Notepad",
    appState: { process: "notepad", states: NOTEPAD_STATE },
    tools: /^(?:skill|pc_act|screen_act)/,
    setup: async (ctx) => {
      if (Number(await psText("@(Get-Process notepad -ErrorAction SilentlyContinue).Count")) > 0) return { skip: "Notepad is already running (his, or another agent's)" };
      const since = Date.now();
      const np = await openNotepad(ctx);
      if (!np) return { skip: "Notepad didn't open" };
      const ex = await edgeWindow(bench("steps.html"), /^Steps bench/, ctx);
      if (ex) await focus(ex.handle);
      return { np: np.handle, since };
    },
    check: async (_out, st) => ({ ok: (await foregroundWindow(ps))?.handle === st.np, wrong: [] }),
    cleanup: async (st) => closeNotepad(st.np, st.since),
  },
  // --- 25 Sep: window management across his screens (a Notepad of ours on a D:\tmp file) ------------
  {
    id: "window-main",
    say: "bring Notepad up on my main screen",
    tools: /^skill/,
    appState: { process: "notepad", states: NOTEPAD_STATE },
    setup: async () => {
      // Off the main screen and minimised first: the case that went to the wrong screen.
      const w = await openTestNotepad();
      if (!w) return { skip: "Notepad didn't open" };
      const side = (await screens()).find((m) => !m.primary);
      if (!side) return { skip: "only one screen is connected" };
      await psText(`[JarvisWin]::Place(${w.handle}, ${side.work.x + 120}, ${side.work.y + 120}, 900, 600, $false)`);
      await psText(`[void][JarvisWin]::ShowWindow([IntPtr]::new(${w.handle}), 6); 'OK'`);
      await sleep(600);
      return { handle: w.handle, since: w.since };
    },
    check: async (_out, st) => windowCheck(st.handle, (ms) => ms.find((m) => m.primary)!),
    cleanup: async (st) => closeNotepad(st.handle, st.since),
  },
  {
    id: "window-other",
    say: "move it to my other screen",
    // With three screens "other" is asked about: he says which.
    answers: ["the left one"],
    tools: /^skill/,
    appState: { process: "notepad", states: NOTEPAD_STATE },
    setup: async () => {
      const w = await openTestNotepad();
      if (!w) return { skip: "Notepad didn't open" };
      const main = (await screens()).find((m) => m.primary)!;
      await psText(`[JarvisWin]::Place(${w.handle}, ${main.work.x + 200}, ${main.work.y + 150}, 900, 600, $false)`);
      await focus(w.handle);
      await sleep(600);
      return { handle: w.handle, since: w.since };
    },
    check: async (_out, st) =>
      windowCheck(st.handle, (ms) => {
        const others = ms.filter((m) => !m.primary);
        // Two screens: the other one; three: the left one he chose.
        return others.length === 1 ? others[0] : [...ms].sort((a, b) => a.bounds.x - b.bounds.x)[0];
      }),
    cleanup: async (st) => closeNotepad(st.handle, st.since),
  },
  {
    id: "time-london",
    say: "what time is it in London",
    tools: /^(?:skill|search|chat)/,
    check: async (out) => ({ ok: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i.test(out.said) && !/sydney|here/i.test(out.said.slice(0, 20)), wrong: [] }),
  },
  // --- round 4: 13 more everyday tasks ------------------------------------------------------------
  {
    id: "chrome-tabs",
    say: "open GitHub and Vercel in new tabs",
    tools: /^(?:open_url|browser_act|pc_act)/,
    check: async (_out, _st, ctx) => {
      const hosts = ctx.tools.join(" ");
      const titles = ctx.opened.map((w) => w.title).join(" | ");
      const ok = ctx.tools.filter((t) => t.startsWith("open_url")).length >= 2 || (/github/i.test(titles) && /vercel/i.test(titles));
      return { ok, wrong: [], note: `${hosts} | ${titles}`.slice(0, 160) };
    },
  },
  {
    id: "chrome-bookmarks",
    say: "show my bookmarks in Chrome",
    tools: /^(?:browser_act|open_url|pc_act|skill)/,
    setup: async () => {
      const tabs = await jarvisChromeTabs();
      return (await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1500) }).catch(() => null))?.ok ? { tabs: tabs.map((t) => t.id) } : { skip: "Jarvis Chrome isn't running" };
    },
    check: async (_out, st) => {
      const fresh = (await jarvisChromeTabs()).filter((t) => !st.tabs.includes(t.id));
      return { ok: fresh.some((t) => /^chrome:\/\/bookmarks/.test(t.url)), wrong: [], note: fresh.map((t) => t.url).join(" ") };
    },
    cleanup: async (st) => {
      for (const t of await jarvisChromeTabs()) if (!st.tabs.includes(t.id)) await closeJarvisTab(t.id);
    },
  },
  {
    id: "zip-folder",
    say: "zip the D:\\tmp\\jarvis-suite\\files folder",
    tools: /^(?:skill|control_pc)/,
    setup: async () => (makeFiles(), rmSync(`${FILES}.zip`, { force: true }), {}),
    check: async () => ({ ok: existsSync(`${FILES}.zip`) && statSync(`${FILES}.zip`).size > 100, wrong: [] }),
    cleanup: async () => {
      rmSync(`${FILES}.zip`, { force: true });
      await removeFiles();
    },
  },
  {
    id: "copy-file",
    say: "copy report.txt from D:\\tmp\\jarvis-suite\\files to D:\\tmp\\jarvis-suite\\copies",
    tools: /^(?:skill|control_pc)/,
    setup: async () => (makeFiles(), rmSync(join(WORK, "copies"), { recursive: true, force: true }), {}),
    check: async () => ({ ok: existsSync(join(WORK, "copies", "report.txt")) && existsSync(join(FILES, "report.txt")), wrong: [] }),
    cleanup: async () => {
      rmSync(join(WORK, "copies"), { recursive: true, force: true });
      await removeFiles();
    },
  },
  {
    id: "move-file",
    say: "move notes.txt from D:\\tmp\\jarvis-suite\\files to D:\\tmp\\jarvis-suite\\moved",
    tools: /^(?:skill|control_pc)/,
    setup: async () => (makeFiles(), rmSync(join(WORK, "moved"), { recursive: true, force: true }), {}),
    check: async () => ({ ok: existsSync(join(WORK, "moved", "notes.txt")) && !existsSync(join(FILES, "notes.txt")), wrong: [] }),
    cleanup: async () => {
      rmSync(join(WORK, "moved"), { recursive: true, force: true });
      await removeFiles();
    },
  },
  {
    id: "pdf-export",
    say: "save report.txt in D:\\tmp\\jarvis-suite\\files as a PDF",
    tools: /^(?:skill|control_pc)/,
    setup: async () => (makeFiles(), {}),
    check: async () => {
      const pdf = join(FILES, "report.pdf");
      const ok = existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === "%PDF-";
      return { ok, wrong: [] };
    },
    cleanup: async () => removeFiles(),
  },
  {
    id: "excel-sum",
    say: "put the total of the Sales column in the cell under it",
    tools: /^(?:screen_act|screen_teach|skill)/,
    setup: async () => {
      if (await appRunning("EXCEL")) return { skip: "Excel is already running (his)" };
      makeFiles();
      const csv = join(FILES, "jarvis-sales.csv");
      writeFileSync(csv, ["Region,Sales", "North,4200", "South,3100", "East,3900", "West,1800"].join("\r\n"));
      const since = new Date().toISOString();
      const before = await handles();
      // Through Excel's automation with AddToMru off: his recent files list isn't touched.
      await officeOpen("excel", csv);
      const w = await newWindow(before, (x) => /^excel$/i.test(x.process) && /jarvis-sales/i.test(x.title), 45_000);
      if (!w) return { skip: "Excel didn't open" };
      await sleep(2500);
      await focus(w.handle);
      return { handle: w.handle, since };
    },
    check: async (_out, st) => {
      await focus(st.handle);
      const v = await psText(`${EXCEL_APP_PS} try { $s = $x.ActiveSheet; [string]$s.Range('B6').Value2 + '|' + [string]$s.Range('B6').Formula } catch { 'ERR' }`);
      return { ok: /^13000\|/.test(v), wrong: [], note: v };
    },
    cleanup: async (st) => {
      if (st.since) await officeClose("Excel.Application", "EXCEL", st.since);
      await removeFiles();
    },
  },
  {
    id: "word-bold",
    say: "make the first line bold",
    tools: /^(?:screen_act|screen_teach|skill)/,
    setup: async () => {
      if (await appRunning("WINWORD")) return { skip: "Word is already running (his)" };
      makeFiles();
      const doc = join(FILES, "jarvis-suite-doc.rtf");
      writeFileSync(doc, "{\\rtf1\\ansi{\\fonttbl{\\f0 Calibri;}}\\f0\\fs24 Quarterly plan\\par This line stays as it is.\\par}");
      const since = new Date().toISOString();
      const before = await handles();
      await officeOpen("word", doc);
      const w = await newWindow(before, (x) => /^winword$/i.test(x.process) && /jarvis-suite-doc/i.test(x.title), 45_000);
      if (!w) return { skip: "Word didn't open" };
      await sleep(2500);
      await focus(w.handle);
      return { handle: w.handle, since };
    },
    check: async () => {
      const v = await psText("try { $w = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $d = $w.ActiveDocument; [string]$d.Paragraphs(1).Range.Bold + '|' + [string]$d.Paragraphs(2).Range.Bold } catch { 'ERR' }");
      return { ok: /^-1\|0$/.test(v), wrong: /\|-1$/.test(v) ? ["the second line went bold too"] : [], note: v };
    },
    cleanup: async (st) => {
      if (st.since) await officeClose("Word.Application", "WINWORD", st.since);
      await removeFiles();
    },
  },
  {
    id: "screenshot",
    say: "take a screenshot and save it in D:\\tmp\\jarvis-suite\\screens",
    tools: /^(?:skill|pc_act|control_pc|screen)/,
    setup: async () => (rmSync(join(WORK, "screens"), { recursive: true, force: true }), mkdirSync(join(WORK, "screens"), { recursive: true }), { since: Date.now() }),
    check: async (_out, st) => {
      const made = newFiles(join(WORK, "screens"), st.since).filter((f) => /\.png$/i.test(f));
      return { ok: made.length === 1, wrong: made.length > 1 ? [`${made.length} screenshots`] : [], note: made.join(", ") };
    },
    cleanup: async () => rmSync(join(WORK, "screens"), { recursive: true, force: true }),
  },
  {
    id: "snipping-tool",
    say: "open the Snipping Tool",
    tools: /^(?:pc_act|skill)/,
    setup: async () => ({ since: new Date().toISOString(), before: [...(await handles())] }),
    check: async (_out, st) => {
      await sleep(1500);
      const w = (await windows()).filter((x) => !st.before.includes(x.handle) && /snipping/i.test(`${x.title} ${x.process}`));
      return { ok: w.length > 0, wrong: [] };
    },
    cleanup: async (st) => void (await psText(`Get-Process SnippingTool, ScreenClippingHost -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt [datetime]'${st.since}' } | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'`)),
  },
  {
    id: "dark-mode",
    policy: "settings",
    say: "switch Windows to dark mode",
    // Whichever mode he isn't in, then his own put back (read from and written to the real registry).
    sayFrom: (st) => (st.theme === "0,0" ? "switch Windows to light mode" : "switch Windows to dark mode"),
    tools: /^(?:skill|control_pc)/,
    setup: async () => {
      const t = await realTheme();
      return /^[01],[01]$/.test(t) ? { theme: t, want: t === "0,0" ? "1,1" : "0,0" } : { skip: `theme unreadable (${t || "?"})` };
    },
    check: async (_out, st) => {
      let now = await realTheme();
      for (let i = 0; i < 4 && now !== st.want; i++) (await sleep(500), (now = await realTheme()));
      return { ok: now === st.want, wrong: [], note: `was ${st.theme}, now ${now}` };
    },
    cleanup: async (st) => {
      if (st.theme && (await realTheme()) !== st.theme) {
        await setRealTheme(st.theme);
        console.log(`   theme put back: ${await realTheme()}`);
      }
    },
  },
  {
    id: "clipboard-copy",
    say: "copy M&U Ventures to my clipboard",
    tools: /^(?:skill)/,
    check: async () => {
      const t = (await clipboardText()).trim();
      return { ok: t === "M&U Ventures", wrong: [], note: t.length > 40 ? `${t.length} chars` : t };
    },
  },
];

// --- run ------------------------------------------------------------------------------------------
type Row = { id: string; say: string; ok: boolean; skipped?: string; questions: number; ms: number; firstMs: number | null; turns: number; tools: string[]; wrong: string[]; said: string; note?: string; route: string[]; appState?: string };
const OURS = ["M&U Ventures", "milk, eggs, bread", "Jarvis bench line", "Usman", "Mehroz"];
async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  const guard: Guard = await createGuard();
  const clipBefore = await guard.saveClipboard();
  console.log(`clipboard saved: ${clipBefore.split(";").length} format(s)`);
  const clipChecks: string[] = [];
  const appChecks: string[] = [];
  const rows: Row[] = [];
  const list = only.length ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  const allowSettings = args.includes("--allow-settings");
  try {
  for (const task of list) {
    const ctx: Ctx = { tools: [], pendingControl: null, pendingScreen: null, lastUser: "", hermesSession: {}, opened: [], edgeProfiles: [] };
    const skipRow = (why: string): Row => ({ id: task.id, say: task.say, ok: false, skipped: why, questions: 0, ms: 0, firstMs: null, turns: 0, tools: [], wrong: [], said: "", route: [] });
    if (task.policy === "account" || (task.policy === "settings" && !allowSettings) || (task.policy === "his-app" && !args.includes("--allow-his-apps"))) {
      rows.push(skipRow(task.policy === "account" ? "policy: uses his personal account" : task.policy === "his-app" ? "policy: opens his own VS Code (his profile; extensions and the app can update on start, which can't be put back)" : "policy: changes his Windows settings"));
      console.log(`${task.id}: SKIPPED (policy: ${task.policy})`);
      continue;
    }
    if (!(await guard.idle(60))) {
      rows.push(skipRow("he was using the PC"));
      continue;
    }
    // His first touch stops this task at once: the request in flight, the screen loop, a lesson.
    taskAbort = new AbortController();
    const offTouch = guard.onTouch((what) => {
      taskAbort.abort();
      void op("/screen/stop", {}).catch(() => undefined);
      console.log(`   he touched the PC (${what}): stopping ${task.id}`);
    });
    let state: Record<string, any> = {};
    const visibleBefore = await handles();
    const taskStarted = new Date(Date.now() - 1000).toISOString();
    let appSaved: SavedState[] | null = null;
    try {
      if (task.appState) {
        if ((await psText(`@(Get-Process ${task.appState.process} -ErrorAction SilentlyContinue).Count`)) !== "0") {
          rows.push(skipRow(`${task.appState.process} is already running (his), so it wasn't touched`));
          console.log(`${task.id}: SKIPPED (${task.appState.process} is running)`);
          continue;
        }
        appSaved = saveAppState(task.id, task.appState.states);
      }
      const set = task.setup ? await task.setup(ctx) : {};
      if ("skip" in set) {
        rows.push({ id: task.id, say: task.say, ok: false, skipped: String(set.skip), questions: 0, ms: 0, firstMs: null, turns: 0, tools: [], wrong: [], said: "", route: [] });
        console.log(`${task.id}: SKIPPED (${set.skip})`);
        continue;
      }
      state = set;
      const out = await converse(task.sayFrom ? task.sayFrom(state) : task.say, task.answers ?? [], ctx);
      if (guard.touched()) throw new Error(`stopped: he touched the PC (${guard.touched()})`);
      await sleep(800);
      const check = await task.check(out, state, ctx);
      const offRoute = out.tools.filter((t) => !task.tools.test(t)).map((t) => `used ${t}`);
      const row: Row = { id: task.id, say: task.say, ok: check.ok, questions: out.questions, ms: out.ms, firstMs: out.firstMs, turns: out.turns, tools: out.tools, wrong: [...check.wrong, ...offRoute], said: out.said.slice(0, 300), note: check.note, route: out.route };
      rows.push(row);
      console.log(`${task.id}: ${row.ok ? "DONE" : "FAIL"} ${(row.ms / 1000).toFixed(1)} s  q=${row.questions} wrong=${row.wrong.length}  [${row.tools.join(", ")}] ${row.route.join(",")}  "${row.said.slice(0, 140)}"${row.note ? `  (${row.note})` : ""}`);
    } catch (error) {
      if (guard.touched()) {
        rows.push(skipRow(`stopped: he touched the PC (${guard.touched()})`));
        console.log(`${task.id}: STOPPED (he touched the PC)`);
      } else {
        rows.push({ id: task.id, say: task.say, ok: false, questions: 0, ms: 0, firstMs: null, turns: 0, tools: ctx.tools, wrong: [], said: `harness error: ${(error as Error).message}`, route: [] });
        console.log(`${task.id}: ERROR ${(error as Error).message}`);
      }
    } finally {
      offTouch();
      await task.cleanup?.(state, ctx).catch(() => undefined);
      if (appSaved && task.appState) {
        const note = await restoreAppState(appSaved, task.appState.process, taskStarted).catch((e) => `state check failed: ${(e as Error).message}`);
        console.log(`   (his ${task.appState.process} state: ${note})`);
        const row = rows.find((r) => r.id === task.id);
        if (row) row.appState = note;
        appChecks.push(`${task.id}: ${note}`);
      }
      for (const w of ctx.opened) if (/^msedge$/i.test(w.process)) await closeWindow(w.handle);
      for (const p of ctx.edgeProfiles) await killByCommandLine("msedge.exe", p);
      await op("/screen/stop", {}).catch(() => undefined);
      // Apps and dialogs this task launched (by start time): Open With, Spotify.
      await psText(`Get-Process OpenWith, Spotify -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt [datetime]'${taskStarted}' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $_.Name } | Out-String`).then((o) => o.trim() && console.log(`   (closed what the task launched: ${o.trim().replace(/\s+/g, ", ")})`));
      // New windows nobody closed are only reported: another agent (Away mode) may be working on
      // this PC too, so a window is closed only when this task's own cleanup knows it's ours.
      await sleep(500);
      for (const w of (await windows()).filter((x) => !visibleBefore.has(x.handle))) console.log(`   (left open: ${w.process} "${w.title.slice(0, 50)}")`);
      // His clipboard, back after every task (a paste restores itself after 0.9 s: wait for it).
      await sleep(1200);
      const clip = await guard.restoreClipboard(OURS);
      if (clip.restored || !clip.verified) console.log(`   clipboard: ${clip.note}${clip.verified ? " (verified)" : " (NOT verified)"}`);
      clipChecks.push(`${task.id}: ${clip.verified ? "ok" : clip.note}`);
    }
  }
  } finally {
    const clip = await guard.restoreClipboard(OURS);
    console.log(`clipboard at the end: ${clip.note}${clip.verified ? " (verified)" : " (NOT verified)"}`);
    clipChecks.push(`end: ${clip.verified ? "verified" : clip.note}`);
    guard.close();
  }
  // Any throwaway Edge this run started (its profile is under SCRATCH) goes, whatever happened.
  await killByCommandLine("msedge.exe", SCRATCH);
  const ran = rows.filter((r) => !r.skipped);
  const pctl = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
  };
  const summary = {
    label: flag("--label") ?? "",
    at: new Date().toISOString(),
    tasks: rows.length,
    ran: ran.length,
    skipped: rows.filter((r) => r.skipped).map((r) => `${r.id}: ${r.skipped}`),
    completed: ran.filter((r) => r.ok).length,
    completionRate: ran.length ? Math.round((100 * ran.filter((r) => r.ok).length) / ran.length) : 0,
    questions: ran.reduce((n, r) => n + r.questions, 0),
    wrongActions: ran.reduce((n, r) => n + r.wrong.length, 0),
    totalSeconds: Math.round(ran.reduce((n, r) => n + r.ms, 0) / 100) / 10,
    p50Seconds: (pctl(ran.map((r) => r.ms), 50) ?? 0) / 1000,
    p90Seconds: (pctl(ran.map((r) => r.ms), 90) ?? 0) / 1000,
    clipboard: clipChecks.filter((c) => !/: ok$/.test(c)),
    clipboardFormats: clipBefore.split(";").length,
    appState: appChecks,
  };
  console.log(JSON.stringify(summary, null, 2));
  const file = flag("--json");
  if (file) writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
  // The latest full run is what "what can you do on my PC" reports (jarvis-skills/capabilities.ts).
  if (!only.length) writeFileSync(join(dataDirFor(ROOT), "jarvis-e2e-last.json"), JSON.stringify({ at: summary.at, label: summary.label, rows: rows.map((r) => ({ id: r.id, say: r.say, ok: r.ok, ...(r.skipped ? { skipped: r.skipped } : {}), ms: r.ms })) }, null, 1));
}
void main()
  .catch((error) => console.error(error))
  .finally(async () => {
    // A paste puts his clipboard back 0.9 s later from inside the helper: let it before closing.
    await sleep(1500);
    ps.close();
    setTimeout(() => process.exit(0), 500);
  });
