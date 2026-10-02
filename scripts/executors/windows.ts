/**
 * The Windows executors (Track 2, 28 Sep 2026): the ONE implementation of the device-local actions a
 * Jarvis command can run, used by the hub (Usman's PC) and by every paired companion (Mehroz's PC).
 *
 *   app.open      an APP_ALLOW_LIST app; verified by a NEW top-level window of that app appearing
 *   open-url      a plain http(s) page in the default browser; verified only when a browser window shows
 *                 the page's own title (else verified:null and the line never claims it's showing)
 *   file.open     a document by name inside the authorised roots only; never programs, scripts or
 *                 secret-bearing names; several matches → asks which; verified by a window for it
 *   deck.blank    PowerPoint COM: a NEW presentation with a title slide, NEVER saved; verified by reading
 *                 the slide count, layout, title and unsaved path back from PowerPoint itself
 *   notepad.type  its OWN new Notepad window, an Untitled EMPTY document only; the line typed, read back
 *                 through UI Automation and compared exactly; NEVER saved
 *
 * `verified` is true only when the independent post-action check passed; success is never claimed before
 * it. Every step honours ctx.signal (a stop, a cancel, the companion going offline) and returns promptly.
 * Text from speech reaches PowerShell only as base64, never spliced into a script.
 *
 * Everything that touches Windows is an injected dependency (WindowsDeps), so the rules are tested with
 * fakes; `liveWindowsDeps()` builds the real ones (a warm ps-host with the screen-hands UIA helpers, and
 * one-shot PowerShell for COM). Constructing it starts nothing: PowerShell starts on first use.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import type { ExecutorResult } from "../jarvis-command/contracts";
import { APP_ALLOW_LIST } from "../jarvis-command/registry";
import { findFiles, NEVER_OPEN } from "../jev-files";
import { SECRET_BEARING } from "../../src/lib/control-risk";
import { moneyWindowRefusal, screenGoalRefusal } from "../screen-hands/refusals";

export type WinInfo = { handle: number; process: string; cls: string; title: string };
export type PsResult = { code: number; stdout: string; stderr: string };
export type ExecCtx = { signal: AbortSignal };
export type WindowsExecutor = (args: Record<string, unknown>, ctx: ExecCtx) => Promise<ExecutorResult>;
export const WINDOWS_EXECUTORS = ["app.open", "open-url", "file.open", "deck.blank", "notepad.type"] as const;
export type WindowsExecutorName = (typeof WINDOWS_EXECUTORS)[number];

export type WindowsDeps = {
  platform: string;
  /** Authorised folders for file.open (absolute). Empty → file.open refuses. */
  roots: string[];
  /** Visible top-level windows now. */
  windows(): Promise<WinInfo[]>;
  foreground(): Promise<WinInfo | null>;
  /** Launch one of APP_LAUNCH's fixed program names (never text from speech). */
  startApp(exe: string, opts?: { hidden?: boolean }): Promise<void>;
  /** Hand a vetted document path or http(s) URL to its default Windows handler. */
  shellOpen(target: string): Promise<void>;
  focus(handle: number): Promise<boolean>;
  keys(handle: number, chord: string): Promise<void>;
  /** Input to `handle` only (throws if another window is in front). */
  typeText(handle: number, text: string): Promise<void>;
  /** The text of `handle`'s editor document through UI Automation; null when it can't be read. */
  editorText(handle: number): Promise<string | null>;
  /** One whole PowerShell script (COM); killed on abort. */
  runPs(script: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<PsResult>;
  /** The page's own <title> (for open-url's check). Absent → open-url can't verify (verified:null). */
  pageTitle?: (url: string, signal: AbortSignal) => Promise<string | null>;
  /** Files matching a name under the roots (defaults to jev-files' bounded walk). */
  findFiles?: (name: string, roots: string[]) => string[];
  realpath?: (path: string) => string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  timing?: Partial<Timing>;
  close?: () => void;
};
type Timing = { appWaitMs: number; pollMs: number; settleMs: number; urlWaitMs: number; fileWaitMs: number };
const TIMING: Timing = { appWaitMs: 15_000, pollMs: 400, settleMs: 1_200, urlWaitMs: 12_000, fileWaitMs: 12_000 };

/** Thrown by sleep (and anything else) when ctx.signal aborts. */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "Cancelled";
  }
}
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new Cancelled();
};

/** How each allow-listed app is launched (fixed names) and how its window is recognised. */
/**
 * An Office app's splash screen is a window of the app too (title "Opening -", "Loading", blank, or class MsoSplash), and
 * it is gone seconds later: it is never the verified window. Pure.
 */
export function isSplash(w: WinInfo): boolean {
  const t = w.title.trim();
  return /^mosplash|^msosplash/i.test(w.cls) || /^(?:opening|loading|starting|initializing)\b/i.test(t) || /^[-\u2013\u2014 ]*$/.test(t);
}
export const APP_LAUNCH: Record<string, { exe: string; label: string; hidden?: boolean; match: (w: WinInfo) => boolean; splash?: (w: WinInfo) => boolean }> = {
  notepad: { exe: "notepad.exe", label: "Notepad", match: (w) => /^notepad$/i.test(w.process) },
  calculator: { exe: "calc.exe", label: "Calculator", match: (w) => /^(?:calculatorapp|applicationframehost|calc)$/i.test(w.process) && /calculator/i.test(w.title) },
  powerpoint: { exe: "powerpnt.exe", label: "PowerPoint", match: (w) => /^powerpnt$/i.test(w.process), splash: isSplash },
  excel: { exe: "excel.exe", label: "Excel", match: (w) => /^excel$/i.test(w.process), splash: isSplash },
  word: { exe: "winword.exe", label: "Word", match: (w) => /^winword$/i.test(w.process), splash: isSplash },
  chrome: { exe: "chrome.exe", label: "Chrome", match: (w) => /^chrome$/i.test(w.process) },
  edge: { exe: "msedge.exe", label: "Edge", match: (w) => /^msedge$/i.test(w.process) },
  explorer: { exe: "explorer.exe", label: "File Explorer", match: (w) => /^explorer$/i.test(w.process) && /^cabinetwclass$/i.test(w.cls) },
  "vs code": { exe: "code", label: "VS Code", hidden: true, match: (w) => /^code$/i.test(w.process) },
  paint: { exe: "mspaint.exe", label: "Paint", match: (w) => /^mspaint$/i.test(w.process) || (/^applicationframehost$/i.test(w.process) && /\bpaint$/i.test(w.title)) },
};

const BROWSERS = /^(?:chrome|msedge|firefox|brave|opera|vivaldi|arc|iexplore)$/i;

/** "Notepad" / "power point" / "calc" → the APP_ALLOW_LIST key, or null. Pure. */
export function allowListedApp(name: unknown): string | null {
  const said = String(name ?? "").toLowerCase().replace(/[^a-z0-9 .]+/g, " ").replace(/\s+/g, " ").trim();
  if (!said) return null;
  if (Object.prototype.hasOwnProperty.call(APP_ALLOW_LIST, said)) return said;
  for (const [key, words] of Object.entries(APP_ALLOW_LIST)) if (words.includes(said)) return key;
  return null;
}

export const MAX_TYPED = 200;
/** Six or more digits in a row (spaces/dashes allowed): an account, card or code number. */
const DIGIT_RUN = /\d(?:[\s-]?\d){5,}/;

/** Why a line must not be typed (or used as a slide title), or null. Pure. */
export function textRefusal(text: string, max = MAX_TYPED): string | null {
  if (!text.trim()) return "There's no text to type.";
  if (text.length > max) return `That's longer than ${max} characters, so I didn't type it. Keep it to one short line.`;
  if (/[\u0000-\u001f\u007f]/.test(text)) return "That has line breaks or control characters; I only type one plain line.";
  const refusal = screenGoalRefusal(text);
  if (refusal) return refusal.said;
  if (SECRET_BEARING.test(text)) return "That looks like a secret or a key, which I never type. Nothing was touched.";
  if (DIGIT_RUN.test(text)) return "That has a long run of digits (it could be an account, card or code number), so I didn't type it.";
  return null;
}

const CREDENTIAL_PARAM = /^(?:.*[_-])?(?:token|access[_-]?token|id[_-]?token|api[_-]?key|apikey|key|secret|password|passwd|pwd|pass|auth|authorization|session|sessionid|sid|sig|signature|otp|credentials?|code)$/i;

/** A plain http(s) URL with no credentials in it, not a money site; else why not. Pure. */
export function urlRefusal(raw: unknown): { ok: true; url: URL } | { ok: false; said: string } {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 2000) return { ok: false, said: "That's not a web address I can open." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, said: "That's not a web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, said: "Only plain http(s) links can be opened." };
  if (!url.hostname) return { ok: false, said: "That link has no site in it." };
  if (url.username || url.password) return { ok: false, said: "That link has a login in it, so I didn't open it." };
  const params = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.replace(/^#/, "")).keys()];
  if (params.some((k) => CREDENTIAL_PARAM.test(k))) return { ok: false, said: "That link carries what looks like a key or token, so I didn't open it." };
  const money = moneyWindowRefusal("", url.href);
  if (money) return { ok: false, said: money.said };
  return { ok: true, url };
}

/** Is `path` (resolved through links) inside one of the roots? Pure given `real`. */
export function insideRoots(path: string, roots: string[], real: (p: string) => string = (p) => p): boolean {
  let p: string;
  try {
    p = real(resolvePath(path)).toLowerCase();
  } catch {
    return false;
  }
  return roots.some((r) => {
    let root: string;
    try {
      root = real(resolvePath(r)).toLowerCase().replace(/[\\/]+$/, "");
    } catch {
      return false;
    }
    return p.startsWith(root + sep) || p.startsWith(root + "/");
  });
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The deck.blank PowerShell: a new presentation + a title slide, read back, NEVER saved. Pure. */
export function deckBlankScript(title: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    `  $title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'))`,
    "  $app = New-Object -ComObject PowerPoint.Application",
    "  try { $app.Visible = -1 } catch {}",
    "  $pres = $app.Presentations.Add(-1)",
    "  $slide = $pres.Slides.Add(1, 1)",
    "  if ($title.Length -gt 0) { $slide.Shapes.Item(1).TextFrame.TextRange.Text = $title }",
    // The read-back: from PowerPoint itself, not from what was sent.
    "  $first = $pres.Slides.Item(1)",
    "  $read = [string]$first.Shapes.Item(1).TextFrame.TextRange.Text",
    "  [pscustomobject]@{ name = [string]$pres.Name; slides = [int]$pres.Slides.Count; layout = [int]$first.Layout; path = [string]$pres.Path; title64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($read)) } | ConvertTo-Json -Compress",
    "} catch {",
    "  [Console]::Error.WriteLine([string]$_.Exception.Message)",
    "  $t = (Get-Process POWERPNT -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowTitle",
    "  if ($t -match 'Unlicensed') { [Console]::Error.WriteLine('UNLICENSED') }",
    "  exit 1",
    "}",
  ].join("\n");
}

export type DeckReadBack = { name: string; slides: number; layout: number; path: string; title: string };
/** PowerShell's stderr without CLIXML progress/serialisation noise. Pure. */
export function plainStderr(stderr: string): string {
  if (!stderr.includes("#< CLIXML")) return stderr;
  const errors = [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((m) => m[1].replace(/_x000D__x000A_/g, "\n").replace(/_x[0-9A-F]{4}_/g, "")).join("");
  const rest = stderr.replace(/#< CLIXML[\s\S]*?<\/Objs>/g, "").trim();
  return [rest, errors.trim()].filter(Boolean).join("\n");
}

/** PowerShell's last JSON line → the read-back, or null. Pure. */
export function parseDeckReadBack(stdout: string): DeckReadBack | null {
  try {
    const v = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "");
    if (typeof v?.name !== "string" || typeof v?.slides !== "number") return null;
    return { name: v.name, slides: v.slides, layout: Number(v.layout), path: String(v.path ?? ""), title: Buffer.from(String(v.title64 ?? ""), "base64").toString("utf8") };
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[​-‏]/g, "").replace(/\s+/g, " ").trim();

export function createWindowsExecutors(deps: WindowsDeps): Record<WindowsExecutorName, WindowsExecutor> {
  const t: Timing = { ...TIMING, ...(deps.timing ?? {}) };
  const windows = (signal: AbortSignal) => {
    check(signal);
    return deps.windows();
  };
  const onWindows = (verb: string): ExecutorResult | null => (deps.platform === "win32" ? null : { ok: false, verified: false, said: `${verb} needs Windows; this device isn't running it, so nothing was done.` });

  /** Poll until `find` returns something or the wait runs out. */
  async function poll<T>(signal: AbortSignal, waitMs: number, find: () => Promise<T | null | undefined>): Promise<T | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      check(signal);
      const hit = await find();
      if (hit) return hit;
      if (Date.now() >= until) return null;
      await deps.sleep(t.pollMs, signal);
    }
  }

  const guard =
    (verb: string, run: WindowsExecutor): WindowsExecutor =>
    async (args, ctx) => {
      try {
        check(ctx.signal);
        return await run(args ?? {}, ctx);
      } catch (error) {
        if (error instanceof Cancelled || ctx.signal.aborted) return { ok: false, verified: false, said: "Stopped.", data: { cancelled: true } };
        return { ok: false, verified: false, said: `${verb} didn't work: ${String((error as Error)?.message ?? error).slice(0, 160)}` };
      }
    };

  const appOpen: WindowsExecutor = async (args, { signal }) => {
    const key = allowListedApp(args.name);
    if (!key || !APP_LAUNCH[key]) return { ok: false, verified: false, said: `I only open the apps on my list (${Object.keys(APP_LAUNCH).join(", ")}), so nothing was opened.`, data: { refused: true } };
    const app = APP_LAUNCH[key];
    const off = onWindows(`Opening ${app.label}`);
    if (off) return off;
    const before = await windows(signal);
    const had = new Set(before.map((w) => w.handle));
    const frontBefore = await deps.foreground().catch(() => null);
    check(signal);
    await deps.startApp(app.exe, app.hidden ? { hidden: true } : undefined);
    // The app's REAL window: an Office splash ("Opening -") is waited out (bounded), never accepted as the verified window.
    const real = (w: WinInfo) => app.match(w) && !app.splash?.(w);
    let sawSplash = false;
    const fresh = await poll(signal, t.appWaitMs, async () => {
      const now = (await deps.windows().catch(() => [] as WinInfo[])).filter((w) => !had.has(w.handle) && app.match(w));
      if (now.some((w) => app.splash?.(w))) sawSplash = true;
      return now.find(real);
    });
    if (!fresh && sawSplash) return { ok: true, verified: null, said: `${app.label} is still starting (only its splash screen is showing), so I can't confirm it opened.`, evidence: "only a splash window appeared", data: { app: key, splashOnly: true } };
    if (fresh) return { ok: true, verified: true, checkedAt: Date.now(), said: `Opened ${app.label}.`, evidence: `a new ${fresh.process} window appeared: "${fresh.title.slice(0, 80)}"`, data: { app: key, handle: fresh.handle, title: fresh.title } };
    const front = await deps.foreground().catch(() => null);
    if (front && real(front) && front.handle !== frontBefore?.handle)
      return { ok: true, verified: null, said: `${app.label} came to the front, but in a window that was already open, so I can't confirm a new one.`, evidence: `existing window in front: "${front.title.slice(0, 80)}"`, data: { app: key, handle: front.handle } };
    return { ok: false, verified: false, said: `I asked Windows to open ${app.label}, but no new ${app.label} window appeared, so I can't say it opened.` };
  };

  const openUrl: WindowsExecutor = async (args, { signal }) => {
    const vetted = urlRefusal(args.url);
    if (!vetted.ok) return { ok: false, verified: false, said: vetted.said, data: { refused: true } };
    const href = vetted.url.href;
    const host = vetted.url.hostname;
    const canCheck = deps.platform === "win32" && !!deps.pageTitle;
    const before = canCheck ? await windows(signal).catch(() => null) : null;
    check(signal);
    await deps.shellOpen(href);
    const unconfirmed = (why: string): ExecutorResult => ({ ok: true, verified: null, said: `I asked the default browser to open ${host}. ${why}`, data: { url: href } });
    if (!canCheck || !before) return unconfirmed("I can't see the browser from here, so I can't confirm it's showing.");
    const title = await deps.pageTitle!(href, signal).catch(() => null);
    check(signal);
    if (!title || norm(title).length < 3) return unconfirmed("The page has no title I can look for, so I can't confirm it's showing.");
    const want = norm(title);
    const seen = new Map(before.map((w) => [w.handle, w.title]));
    const hit = await poll(signal, t.urlWaitMs, async () =>
      (await deps.windows().catch(() => [] as WinInfo[])).find((w) => BROWSERS.test(w.process) && norm(w.title).includes(want) && seen.get(w.handle) !== w.title),
    );
    if (hit) return { ok: true, verified: true, checkedAt: Date.now(), said: `${host} is open in the browser.`, evidence: `${hit.process} window titled "${hit.title.slice(0, 80)}" matches the page title`, data: { url: href, window: hit.title } };
    return unconfirmed(`I couldn't see a browser window showing "${title.slice(0, 60)}", so I can't confirm it.`);
  };

  const fileOpen: WindowsExecutor = async (args, { signal }) => {
    const name = String(args.name ?? "").trim();
    if (!name || name.length > 120) return { ok: false, verified: false, said: "Which file? Say its name." };
    if (SECRET_BEARING.test(name)) return { ok: false, verified: false, said: "That name looks like a secret-bearing file, which I never open.", data: { refused: true } };
    if (NEVER_OPEN.test(name)) return { ok: false, verified: false, said: "That's a program or a script, and I never open those.", data: { refused: true } };
    const roots = deps.roots.filter((r) => isAbsolute(r));
    if (!roots.length) return { ok: false, verified: false, said: "No folders are authorised for opening files on this device, so nothing was opened." };
    const off = onWindows("Opening a file");
    if (off) return off;
    const real = deps.realpath ?? ((p: string) => realpathSync.native(p));
    const matches = (deps.findFiles ?? ((n, r) => findFiles(n, r)))(name, roots).filter((p) => !NEVER_OPEN.test(p) && !SECRET_BEARING.test(p) && insideRoots(p, roots, real));
    check(signal);
    if (!matches.length) return { ok: false, verified: false, said: `I couldn't find a file called ${name} in the folders I'm allowed to use.`, data: { matches: 0 } };
    if (matches.length > 1)
      return { ok: false, verified: false, said: `${matches.length} files match "${name}": ${matches.slice(0, 3).map((m) => basename(m)).join(", ")}${matches.length > 3 ? "…" : ""}. Which one?`, data: { ask: true, matches: matches.slice(0, 5).map((m) => basename(m)) } };
    const path = matches[0];
    const before = new Map((await windows(signal)).map((w) => [w.handle, w.title]));
    check(signal);
    await deps.shellOpen(path);
    const stem = basename(path, extname(path)).toLowerCase();
    const hit = await poll(signal, t.fileWaitMs, async () => (await deps.windows().catch(() => [] as WinInfo[])).find((w) => w.title.toLowerCase().includes(stem) && before.get(w.handle) !== w.title));
    if (hit) return { ok: true, verified: true, checkedAt: Date.now(), said: `Opened ${basename(path)}.`, evidence: `a window for it appeared: "${hit.title.slice(0, 80)}" (${hit.process})`, data: { file: basename(path), window: hit.title } };
    return { ok: false, verified: false, said: `I asked Windows to open ${basename(path)}, but no window for it showed up, so I can't say it opened.`, data: { file: basename(path) } };
  };

  const deckBlank: WindowsExecutor = async (args, { signal }) => {
    // No title asked for: a blank new presentation (its title placeholder left empty), not a made-up "Title".
    const title = String(args.title ?? "").trim();
    const blank = title === "";
    const refused = blank ? null : textRefusal(title, 120);
    if (refused) return { ok: false, verified: false, said: refused, data: { refused: true } };
    const off = onWindows("PowerPoint");
    if (off) return off;
    // PowerPoint's first start on a busy PC took over 60 s (28 Sep): allow two minutes.
    const r = await deps.runPs(deckBlankScript(title), { timeoutMs: 120_000, signal });
    check(signal);
    if (r.code !== 0) {
      const err = plainStderr(r.stderr);
      const unlicensed = /UNLICENSED/.test(err);
      const detail = (err.replace(/UNLICENSED/g, "").trim().split(/\r?\n/)[0] ?? "").slice(0, 160) || (r.code === -1 ? "it didn't answer in time" : "");
      return { ok: false, verified: false, said: unlicensed ? "PowerPoint is running as an Unlicensed Product, so it won't create a presentation until Office is activated." : `PowerPoint didn't make the presentation${detail ? ` (${detail})` : ""}.`, evidence: detail || undefined };
    }
    const back = parseDeckReadBack(r.stdout);
    if (!back) return { ok: false, verified: false, said: "PowerPoint answered, but I couldn't read the new presentation back, so I can't say it worked." };
    const data = { presentation: back.name, slides: back.slides, title: back.title, saved: back.path !== "" };
    if (back.slides !== 1 || back.layout !== 1 || back.title !== title || back.path !== "")
      return { ok: false, verified: false, said: `PowerPoint made ${back.name || "a presentation"}, but it doesn't read back as one unsaved ${blank ? "blank title slide" : `title slide saying "${title}"`}, so I'm not calling it done.`, evidence: `slides=${back.slides} layout=${back.layout} titleMatches=${back.title === title} saved=${back.path !== ""}`, data };
    return { ok: true, verified: true, checkedAt: Date.now(), said: blank ? "Started a new blank presentation. It isn't saved." : `Started a new presentation (${back.name}) with the title slide "${title}". It isn't saved.`, evidence: `PowerPoint reads back 1 slide, title layout, ${blank ? "title left empty" : "title matches"}, not saved`, data };
  };

  const notepadType: WindowsExecutor = async (args, { signal }) => {
    const text = String(args.text ?? "");
    const refused = textRefusal(text);
    if (refused) return { ok: false, verified: false, said: refused, data: { refused: true } };
    const off = onWindows("Notepad");
    if (off) return off;
    // 1. Notepad's own NEW window (never one he already had open).
    const had = new Set((await windows(signal)).map((w) => w.handle));
    await deps.startApp(APP_LAUNCH.notepad.exe);
    let win = await poll(signal, t.appWaitMs, async () => (await deps.windows().catch(() => [] as WinInfo[])).find((w) => !had.has(w.handle) && APP_LAUNCH.notepad.match(w)));
    // Windows 11 Notepad may open the new document as a TAB in a Notepad window that was already open:
    // then that window is in front, and only a fresh, empty tab in it (below) is ever typed into.
    if (!win) {
      const front = await deps.foreground().catch(() => null);
      if (front && APP_LAUNCH.notepad.match(front)) win = front;
    }
    if (!win) return { ok: false, verified: false, said: "Notepad didn't open a window I could use, so nothing was typed." };
    const handle = win.handle;
    await deps.sleep(t.settleMs, signal);
    await deps.focus(handle);
    // 2. Windows 11 Notepad restores saved tabs: type only into a genuinely NEW, EMPTY Untitled document.
    //    Not new and empty → a new tab (Ctrl+T) in THIS window, then check again; still not → refuse.
    const title = async () => (await deps.windows().catch(() => [] as WinInfo[])).find((w) => w.handle === handle)?.title ?? "";
    if (!/^untitled\b/i.test(await title()) || (await deps.editorText(handle)) !== "") {
      check(signal);
      await deps.keys(handle, "ctrl+t");
      await deps.sleep(800, signal);
    }
    check(signal);
    const now = await title();
    const existing = await deps.editorText(handle);
    if (!/^untitled\b/i.test(now) || existing !== "")
      return { ok: false, verified: false, said: "Notepad's document wasn't a new, empty Untitled one, so nothing was typed.", evidence: `title "${now.slice(0, 60)}", ${existing === null ? "text unreadable" : `${existing.length} chars already there`}` };
    // 3. Type the line into our window only, then read it back.
    check(signal);
    await deps.typeText(handle, text);
    await deps.sleep(300, signal);
    const back = await deps.editorText(handle);
    check(signal);
    if (back === null) return { ok: false, verified: false, said: "I typed the line, but couldn't read Notepad back, so I'm not calling it done. Nothing was saved.", data: { handle } };
    if (back.replace(/\r?\n$/, "") !== text)
      return { ok: false, verified: false, said: "I typed the line, but Notepad doesn't read it back the same, so I'm not calling it done. Nothing was saved.", evidence: `read back ${back.length} chars, expected ${text.length}`, data: { handle } };
    return { ok: true, verified: true, checkedAt: Date.now(), said: "Typed it into a new Notepad document and read it back. It isn't saved.", evidence: `UIA read-back matched ${text.length} chars exactly`, data: { handle, chars: text.length } };
  };

  return {
    "app.open": guard("Opening the app", appOpen),
    "open-url": guard("Opening the page", openUrl),
    "file.open": guard("Opening the file", fileOpen),
    "deck.blank": guard("PowerPoint", deckBlank),
    "notepad.type": guard("Typing in Notepad", notepadType),
  };
}

// ------------------------------------------------------------------------------------------------
// The real dependencies.

/** Abortable sleep: rejects with Cancelled when the signal fires. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Cancelled());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One whole PowerShell script via -EncodedCommand (errors stop it and set the exit code); killed on abort. */
export function runPowerShellScript(script: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<PsResult> {
  return new Promise((done) => {
    if (opts.signal.aborted) return done({ code: -1, stdout: "", stderr: "Cancelled." });
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const finish = (code: number, extra = "") => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", kill);
      done({ code, stdout, stderr: stderr + extra });
    };
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", (e) => finish(-1, String(e.message)));
  });
}

/** Fetch a page's <title> (bounded: 6 s, 256 KB). */
export async function fetchPageTitle(url: string, signal: AbortSignal): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(6_000)]), redirect: "follow", headers: { accept: "text/html" } });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  let html = "";
  const decoder = new TextDecoder();
  while (html.length < 256 * 1024) {
    const { value, done } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (/<\/title>/i.test(html)) break;
  }
  void reader.cancel().catch(() => undefined);
  const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The editor document's text in `handle` through UIA: the focused element if it's in that window, else its first Document. */
function editorTextScript(handle: number): string {
  const h = Math.trunc(handle);
  return [
    "$A = [System.Windows.Automation.AutomationElement]; $TP = [System.Windows.Automation.TextPattern]::Pattern; $out = '<none>'",
    "$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker; $root = $A::RootElement",
    "$f = $A::FocusedElement; $top = $f; $n = 0; while ($top -and $n -lt 60) { $p = $walker.GetParent($top); if (-not $p -or $p.Equals($root)) { break }; $top = $p; $n++ }",
    "$o = $null",
    `if ($f -and $top -and $top.Current.NativeWindowHandle -eq ${h} -and $f.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -and $f.TryGetCurrentPattern($TP, [ref]$o)) { $out = $o.DocumentRange.GetText(8000) } else { $w = $A::FromHandle([IntPtr]${h}); $c = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document); $d = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c); if ($d -and $d.TryGetCurrentPattern($TP, [ref]$o)) { $out = $o.DocumentRange.GetText(8000) } }`,
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$out))",
  ].join("; ");
}

/**
 * A cheap window lister for the executors. ps-host's JarvisWin.List names each window's process with
 * Process.GetProcessById, which snapshots EVERY process per call: measured 11-85 s for 43 windows on this
 * PC under load (28 Sep). This asks each window's own process only (QueryFullProcessImageName). Same row
 * format (handle, process, class, title; tab-separated), so jarvis-skills/windows.parseWindowRows reads it.
 */
const LISTER = [
  "using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;",
  "public static class MuExecWin {",
  " public delegate bool EnumProc(IntPtr h, IntPtr l);",
  ' [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  ' [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  ' [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);',
  ' [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  ' [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  ' [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  ' [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  ' [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);',
  ' [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);',
  ' [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  ' [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int n);',
  " static string Clean(string s) { return (s ?? \"\").Replace(\"\\t\", \" \").Replace(\"\\n\", \" \").Replace(\"\\r\", \" \"); }",
  " static string Proc(uint pid) { IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return \"\"; try { var s = new StringBuilder(1024); int n = 1024; if (!QueryFullProcessImageName(p, 0, s, ref n)) return \"\"; var f = s.ToString(); int i = f.LastIndexOf('\\\\'); f = i >= 0 ? f.Substring(i + 1) : f; return f.EndsWith(\".exe\", StringComparison.OrdinalIgnoreCase) ? f.Substring(0, f.Length - 4) : f; } finally { CloseHandle(p); } }",
  " static string Info(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); var c = new StringBuilder(256); GetClassName(h, c, 256); uint pid; GetWindowThreadProcessId(h, out pid);",
  "  return h.ToInt64() + \"\\t\" + Clean(Proc(pid)) + \"\\t\" + Clean(c.ToString()) + \"\\t\" + Clean(t.ToString()); }",
  " public static string Foreground() { var h = GetForegroundWindow(); return h == IntPtr.Zero ? \"\" : Info(h); }",
  " public static string List() { var rows = new List<string>(); EnumWindows(delegate (IntPtr h, IntPtr l) {",
  "  if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true; int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;",
  "  var t = new StringBuilder(8); if (GetWindowText(h, t, 8) == 0) return true; rows.Add(Info(h)); return rows.Count < 120; }, IntPtr.Zero); return String.Join(\"\\n\", rows.ToArray()); }",
  "}",
].join(" ");

/**
 * The real Windows dependencies. Nothing starts until first use; `close()` stops the warm PowerShell.
 * `roots` are the device's authorised folders for file.open.
 */
export function liveWindowsDeps(overrides: Partial<WindowsDeps> = {}): WindowsDeps {
  let host: Promise<{ ps: import("../jarvis-skills/ps-host").PsHost; native: import("../screen-hands/native").NativeScreen }> | null = null;
  const screen = () =>
    (host ??= (async () => {
      const [{ createPsHost }, { nativeScreen, SCREEN_PRELUDE }] = await Promise.all([import("../jarvis-skills/ps-host"), import("../screen-hands/native")]);
      const ps = createPsHost({ prelude: [...SCREEN_PRELUDE, `Add-Type -TypeDefinition '${LISTER.replace(/'/g, "''")}'`] });
      // The first answer waits for the UIA helpers to compile (15-20 s on a loaded PC).
      await ps.run("'ready'", 120_000).catch((error) => {
        host = null;
        throw error;
      });
      return { ps, native: nativeScreen(ps) };
    })());
  const listWith = async (expr: string) => {
    const [{ ps }, { parseWindowRows }, { unb64 }] = await Promise.all([screen(), import("../jarvis-skills/windows"), import("../jarvis-skills/ps-host")]);
    const out = (await ps.run(`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${expr}))`, 30_000)).trim();
    if (out.startsWith("ERROR")) throw new Error("I couldn't list the windows just now.");
    return parseWindowRows(unb64(out));
  };
  const deps: WindowsDeps = {
    platform: process.platform,
    roots: [],
    windows: () => listWith("[MuExecWin]::List()"),
    foreground: async () => (await listWith("[MuExecWin]::Foreground()"))[0] ?? null,
    async startApp(exe, opts) {
      if (!/^[a-z0-9._-]{1,40}$/i.test(exe)) throw new Error("Not a program I launch.");
      const r = await runPowerShellScript(`Start-Process -FilePath '${exe}'${opts?.hidden ? " -WindowStyle Hidden" : ""}`, { timeoutMs: 20_000, signal: new AbortController().signal });
      if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 120) || "Windows wouldn't start it.");
    },
    async shellOpen(target) {
      const r = await runPowerShellScript(`$ErrorActionPreference = 'Stop'; Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(target)}')))`, { timeoutMs: 20_000, signal: new AbortController().signal });
      if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 120) || "Windows wouldn't open it.");
    },
    focus: async (handle) => (await screen()).native.focus(handle),
    keys: async (handle, chord) => (await screen()).native.keys(handle, chord),
    typeText: async (handle, text) => (await screen()).native.type(handle, text),
    async editorText(handle) {
      const [{ ps }, { unb64 }] = await Promise.all([screen(), import("../jarvis-skills/ps-host")]);
      const out = (await ps.run(editorTextScript(handle), 30_000).catch(() => "ERROR")).trim();
      if (out.startsWith("ERROR")) return null;
      const text = unb64(out);
      return text === "<none>" ? null : text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    },
    runPs: runPowerShellScript,
    pageTitle: fetchPageTitle,
    realpath: (p) => realpathSync.native(p),
    sleep: abortableSleep,
    close() {
      const h = host;
      host = null;
      void h?.then(({ ps }) => ps.close()).catch(() => undefined);
    },
    ...overrides,
  };
  return deps;
}
