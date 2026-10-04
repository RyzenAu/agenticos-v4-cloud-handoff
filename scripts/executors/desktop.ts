/**
 * The everyday desktop executors a companion runs on its own PC (programme 20261001, Agent B), on top of the
 * five in windows.ts. Each returns an ExecutorResult whose `verified` is its OWN post-action check; success is
 * never claimed before it.
 *
 *   app.focus         launch (if not running) or focus an allow-listed app, then confirm that app's window is the
 *                     FOREGROUND window: process and window handle are read back from Windows
 *   browser.navigate  open a new tab (or navigate this one) in Jarvis Chrome through the existing agent-browser
 *                     hands (scripts/j2/agent-browser.ts: the same S2c/S2e money and secret gates), then confirm
 *                     the tab is really at that site with a page title, and that it changed from before
 *   observe.window    read-only: the foreground window's process and title (and, for a named app, its windows'
 *                     titles). No screenshot is taken or kept. A banking/exchange window's title is withheld.
 *
 * Everything that touches Windows or the browser is injected (WindowsDeps, BrowserDeps), so the rules are tested
 * with fakes; `liveBrowserDeps()` builds the real browser side (agent-browser over CDP; Chrome started with its
 * own profile when nothing is listening). Constructing any of it starts nothing.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorResult } from "../jarvis-command/contracts";
import { moneyWindowRefusal } from "../screen-hands/refusals";
import { allowListedApp, APP_LAUNCH, Cancelled, urlRefusal, type ExecCtx, type WinInfo, type WindowsDeps, type WindowsExecutor } from "./windows";

export const DESKTOP_EXECUTORS = ["app.focus", "browser.navigate", "observe.window", "target.focus"] as const;
export type DesktopExecutorName = (typeof DESKTOP_EXECUTORS)[number];

export type BrowserTab = { targetId: string; title: string; url: string; active: boolean };
/** The slice of agent-browser's hands this file uses (createAgentBrowserHands). */
export type BrowserHandsLike = {
  tabs(): Promise<BrowserTab[]>;
  /** The active tab's LIVE title and address (the tab list's title can be stale). */
  read(): Promise<{ ok: boolean; title: string; url: string }>;
  /** Make one tab the active one (agent-browser `tab <id>`). */
  activate?(targetId: string): Promise<boolean>;
  open(url: string, where?: "new-tab" | "this-tab"): Promise<{ ok: boolean; said: string; targetId?: string; url?: string }>;
};
export type BrowserDeps = {
  port: number;
  /** null when agent-browser isn't installed on this PC. */
  hands(): Promise<BrowserHandsLike | null>;
  /** Is a browser listening for the hands (CDP)? */
  up(): Promise<boolean>;
  /** Start the browser with debugging on (its own profile); true when it is listening afterwards. */
  start(url: string): Promise<boolean>;
  close?: () => void;
};

const BROWSER_PROC = /^(?:chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
/** Second-level public suffixes that sit under a country code ("co.uk", "com.au"). */
const SLD = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
/** The registrable part of a host: "mail.google.com" → "google.com", "shop.example.com.au" → "example.com.au". Pure. */
export function registrableDomain(h: string): string {
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const cc = parts[parts.length - 1].length === 2 && SLD.has(parts[parts.length - 2]);
  return parts.slice(-(cc ? 3 : 2)).join(".");
}
/**
 * Does a browser window's title show this recorded site? Three ways, strongest first: the recorded page title is in the window
 * title; the full host is; or, ONLY for a bare registrable domain (youtube.com, not mail.google.com), the site's own name as a whole
 * word ("Sydney weather - YouTube"). A subdomain's first label ("mail", "docs", "news", "maps") is a common word and never matches
 * on its own, so another site's window cannot be taken for it. Pure.
 */
export function siteWindowMatches(windowTitle: string, recordedTitle: string, siteHost: string): boolean {
  const wt = norm(windowTitle);
  const rt = norm(recordedTitle);
  if (rt.length > 2 && wt.includes(rt)) return true;
  if (!siteHost) return false;
  if (wt.includes(siteHost)) return true;
  if (registrableDomain(siteHost) !== siteHost) return false;
  const stem = siteHost.split(".")[0] ?? "";
  return stem.length > 3 && new RegExp(`(?:^|[^a-z0-9])${stem.replace(/[^a-z0-9]/g, "")}(?:$|[^a-z0-9])`).test(wt);
}
/** A tab's title is the page's own, not what the browser shows while it loads (the address, its host, or blank). Pure. */
export function realTitle(title: string, url: string): boolean {
  const t = norm(title);
  if (!t || t === "about:blank" || t === "untitled") return false;
  // A placeholder a page shows while it is still becoming itself ("Loading...", "Please wait", a challenge page) is not the page.
  if (/^(?:loading|please wait|just a moment|one moment|redirecting|connecting)\W*$/.test(t)) return false;
  const h = host(url);
  let path = "";
  try {
    const u = new URL(url);
    path = norm(`${u.hostname}${u.pathname}`).replace(/\/$/, "");
  } catch {
    /* not a URL */
  }
  const bare = (x: string) => x.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  return t !== norm(url) && bare(t) !== h && bare(t) !== bare(path) && bare(t) !== bare(norm(url));
}
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new Cancelled();
};

export type DesktopTiming = { focusWaitMs: number; pollMs: number; pageWaitMs: number };
const TIMING: DesktopTiming = { focusWaitMs: 5_000, pollMs: 400, pageWaitMs: 12_000 };

export function createDesktopExecutors(win: WindowsDeps, browser: BrowserDeps, shared: { "app.open": WindowsExecutor }, timing: Partial<DesktopTiming> = {}): Record<DesktopExecutorName, WindowsExecutor> {
  const t = { ...TIMING, ...timing };
  const notWindows = (verb: string): ExecutorResult | null => (win.platform === "win32" ? null : { ok: false, verified: false, said: `${verb} needs Windows; this device isn't running it, so nothing was done.` });

  async function poll<T>(signal: AbortSignal, waitMs: number, find: () => Promise<T | null | undefined>): Promise<T | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      check(signal);
      const hit = await find();
      if (hit) return hit;
      if (Date.now() >= until) return null;
      await win.sleep(t.pollMs, signal);
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

  const appFocus: WindowsExecutor = async (args, ctx: ExecCtx) => {
    const { signal } = ctx;
    const key = allowListedApp(args.name);
    if (!key || !APP_LAUNCH[key]) return { ok: false, verified: false, said: `I only focus the apps on my list (${Object.keys(APP_LAUNCH).join(", ")}), so nothing was touched.`, data: { refused: true } };
    const app = APP_LAUNCH[key];
    const off = notWindows(`Focusing ${app.label}`);
    if (off) return off;
    let target: WinInfo | undefined = (await win.windows()).find((w) => app.match(w));
    let launched = false;
    if (!target) {
      // Not running: the same verified launch as app.open (a NEW window of it), then focus what it opened.
      const opened = await shared["app.open"]({ name: key }, ctx);
      const handle = typeof opened.data?.handle === "number" ? opened.data.handle : null;
      if (!opened.ok || handle === null) return { ...opened, ok: false, verified: false, said: opened.ok ? `${opened.said} I couldn't tell which window is its own, so I can't confirm it's in front.` : opened.said };
      target = (await win.windows().catch(() => [] as WinInfo[])).find((w) => w.handle === handle) ?? { handle, process: String(app.exe).replace(/\.exe$/i, ""), cls: "", title: String(opened.data?.title ?? "") };
      launched = true;
    }
    check(signal);
    const handle = target.handle;
    await win.focus(handle);
    const front = await poll(signal, t.focusWaitMs, async () => {
      const f = await win.foreground().catch(() => null);
      return f && f.handle === handle && app.match(f) ? f : null;
    });
    if (front)
      return {
        ok: true,
        verified: true,
        checkedAt: Date.now(),
        said: `${launched ? `Opened ${app.label} and brought it to the front` : `Brought ${app.label} to the front`}.`,
        evidence: `Windows reports the ${front.process} window ${front.handle} "${front.title.slice(0, 80)}" as the foreground window`,
        data: { app: key, handle: front.handle, process: front.process, title: front.title, foreground: true, launched },
      };
    const now = await win.foreground().catch(() => null);
    return {
      ok: false,
      verified: false,
      said: `I asked Windows to bring ${app.label} to the front, but ${now ? `${now.process} is in front instead` : "nothing reports being in front"}, so I can't say it's focused.`,
      evidence: now ? `foreground is ${now.process} window ${now.handle}` : "no foreground window",
      data: { app: key, handle, foreground: false, launched },
    };
  };

  /** "open Chrome and create a new tab": Jarvis Chrome gets a blank tab, confirmed by the browser's own tab list (a new id, in front). */
  const browserBlankTab: WindowsExecutor = async (_args, { signal }) => {
    const off = notWindows("Opening a new tab");
    if (off) return off;
    const hands = await browser.hands();
    if (!hands) return { ok: false, verified: false, said: "agent-browser isn't installed on this PC, so I can't drive the browser from here. Nothing was opened." };
    const blank = (b: BrowserTab) => /^(?:about:blank|chrome:\/\/newtab\/?)$/i.test(b.url);
    let started = false;
    if (!(await browser.up())) {
      check(signal);
      if (!(await browser.start("about:blank"))) return { ok: false, verified: false, said: `The browser I drive (Jarvis Chrome, port ${browser.port}) wouldn't start, so nothing was opened.` };
      started = true;
    }
    check(signal);
    const before = await hands.tabs().catch(() => [] as BrowserTab[]);
    if (started) {
      // A browser that has just been started opens with its own blank tab: that IS the new tab (a second one would be two).
      const first = await poll(signal, t.pageWaitMs, async () => (await hands.tabs().catch(() => [] as BrowserTab[])).find((b) => blank(b) && b.active));
      if (first) return { ok: true, verified: true, checkedAt: Date.now(), said: "Opened Chrome with a new tab.", evidence: `tab ${first.targetId.slice(0, 8)} is a blank tab and is in front (the browser's own list)`, data: { blank: true, targetId: first.targetId, newTab: true, launched: true } };
    }
    const prior = new Set(before.map((b) => b.targetId));
    const opened = await hands.open("about:blank", "new-tab");
    check(signal);
    if (!opened.ok) return { ok: false, verified: false, said: opened.said };
    const seen = await poll(signal, t.pageWaitMs, async () => (await hands.tabs().catch(() => [] as BrowserTab[])).find((b) => (opened.targetId ? b.targetId === opened.targetId : !prior.has(b.targetId)) && b.active && blank(b)));
    if (seen) return { ok: true, verified: true, checkedAt: Date.now(), said: "Opened a new tab in Chrome.", evidence: `tab ${seen.targetId.slice(0, 8)} is new (${before.length} before, now in front), blank`, data: { blank: true, targetId: seen.targetId, newTab: true, launched: started } };
    return { ok: false, verified: false, said: "I asked Chrome for a new tab, but its tab list doesn't show a new blank one in front, so I can't say it opened.", data: { blank: true } };
  };

  const browserNavigate: WindowsExecutor = async (args, ctx) => {
    if (args.blank === true && args.url === undefined) return browserBlankTab(args, ctx);
    const { signal } = ctx;
    const vetted = urlRefusal(args.url);
    if (!vetted.ok) return { ok: false, verified: false, said: vetted.said, data: { refused: true } };
    const href = vetted.url.href;
    const wantHost = host(href);
    const where = args.where === "this-tab" || (typeof args.tabId === "string" && args.tabId) ? "this-tab" : "new-tab";
    const expectTitle = typeof args.expectTitle === "string" ? args.expectTitle.trim().slice(0, 120) : "";
    const off = notWindows("Opening a page in the browser");
    if (off) return off;
    const hands = await browser.hands();
    if (!hands) return { ok: false, verified: false, said: "agent-browser isn't installed on this PC, so I can't drive the browser from here. Nothing was opened." };
    // STRICT TAB BINDING: an operation bound to a tab id acts on that tab or on nothing. If it was closed, say so; never on a neighbour.
    const boundTab = typeof args.tabId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(args.tabId) ? args.tabId : "";
    if (boundTab) {
      if (!(await browser.up())) return { ok: false, verified: false, said: "That tab was closed (the browser it was in is no longer running), so I didn't open anything.", data: { recovery: "tab-closed", tabId: boundTab } };
      const live = await hands.tabs().catch(() => [] as BrowserTab[]);
      if (!live.some((b) => b.targetId === boundTab)) return { ok: false, verified: false, said: "That tab was closed, so I didn't open anything in another one. Say where to open it.", data: { recovery: "tab-closed", tabId: boundTab } };
      const activated = hands.activate ? await hands.activate(boundTab).catch(() => false) : false;
      const nowActive = (await hands.tabs().catch(() => [] as BrowserTab[])).find((b) => b.active);
      if (!activated || nowActive?.targetId !== boundTab) return { ok: false, verified: false, said: "I couldn't make that tab the active one, so I didn't open anything (I won't use a different tab).", data: { recovery: "tab-not-active", tabId: boundTab } };
    }
    if (!(await browser.up())) {
      check(signal);
      if (!(await browser.start(href))) return { ok: false, verified: false, said: `The browser I drive (Jarvis Chrome, port ${browser.port}) wouldn't start, so nothing was opened.` };
    }
    check(signal);
    const before = await hands.tabs().catch(() => [] as BrowserTab[]);
    const prior = new Map(before.map((b) => [b.targetId, b]));
    const opened = await hands.open(href, where);
    check(signal);
    if (!opened.ok) return { ok: false, verified: false, said: opened.said, data: { url: href } };
    // The page itself. agent-browser's tab LIST keeps the title a tab had when it was created (the address, while the
    // page loads), so the list only says WHICH tab is ours and that it is in front; the title and address are read
    // from the live page. They must be at this site, a REAL title (not the address the browser shows while loading),
    // the same on two reads in a row, and changed from before.
    let last = "";
    const seen = await poll(signal, t.pageWaitMs, async () => {
      const tabs = await hands.tabs().catch(() => [] as BrowserTab[]);
      const mine = opened.targetId ? tabs.find((b) => b.targetId === opened.targetId) : tabs.find((b) => !prior.has(b.targetId) && host(b.url) === wantHost);
      if (!mine || !mine.active) return null;
      const page = await hands.read().catch(() => null);
      if (!page || !page.ok || host(page.url) !== wantHost || !realTitle(page.title, page.url)) return null;
      if (expectTitle && !norm(page.title).includes(norm(expectTitle))) return null;
      const was = prior.get(mine.targetId);
      if (was && was.url === page.url && was.title === page.title) return null;
      const steady = last === page.title;
      last = page.title;
      return steady ? { tab: { ...mine, title: page.title, url: page.url }, was } : null;
    });
    if (seen)
      return {
        ok: true,
        verified: true,
        checkedAt: Date.now(),
        said: `${wantHost} is open in the browser${seen.tab.title ? `: "${seen.tab.title.slice(0, 60)}"` : ""}.`,
        evidence: `tab ${seen.tab.targetId.slice(0, 8)} is at ${seen.tab.url.slice(0, 100)} titled "${seen.tab.title.slice(0, 80)}"; ${seen.was ? `it was "${seen.was.title.slice(0, 40)}" at ${seen.was.url.slice(0, 60)} before` : "it is a new tab"}`,
        data: { url: href, finalUrl: seen.tab.url, title: seen.tab.title, targetId: seen.tab.targetId, newTab: !seen.was, where },
      };
    return { ok: false, verified: false, said: `${wantHost} didn't finish loading${expectTitle ? ` with "${expectTitle}" in its title` : ""}, so I can't say it's showing.`, data: { url: href, where } };
  };

  const observeWindow: WindowsExecutor = async (args, { signal }) => {
    const off = notWindows("Looking at the window in front");
    if (off) return off;
    check(signal);
    const front = await win.foreground().catch(() => null);
    const wanted = args.app === undefined ? null : allowListedApp(args.app);
    if (args.app !== undefined && (!wanted || !APP_LAUNCH[wanted])) return { ok: false, verified: false, said: "I only look at the apps on my list, so nothing was read.", data: { refused: true } };
    const withheld = front ? moneyWindowRefusal(front.title, null, front.process) : null;
    const data: Record<string, unknown> = front
      ? { foreground: { handle: front.handle, process: front.process, ...(withheld ? { titleWithheld: true } : { title: front.title.slice(0, 120) }) } }
      : { foreground: null };
    if (wanted) {
      const list = (await win.windows()).filter((w) => APP_LAUNCH[wanted].match(w)).slice(0, 10);
      data.windows = list.map((w) => ({ handle: w.handle, process: w.process, ...(moneyWindowRefusal(w.title, null, w.process) ? { titleWithheld: true } : { title: w.title.slice(0, 80) }) }));
      data.app = wanted;
    }
    if (!front) return { ok: true, verified: null, said: "No window is reporting itself in front (the screen may be locked or on the secure desktop).", data };
    return {
      ok: true,
      verified: true,
      checkedAt: Date.now(),
      said: withheld ? `${front.process} is in front (its title is withheld).` : `${front.process} is in front: "${front.title.slice(0, 60)}".`,
      evidence: `Windows reports window ${front.handle} (${front.process}) in front; read only, nothing captured`,
      data,
    };
  };

  /**
   * target.focus: bring back something the person was using (a website or an app window), and confirm it is the FOREGROUND window.
   * A site: its tab is activated when its id is known (the browser's own tab list), then the browser window showing its title is
   * focused and read back (process, handle, title). An app: the same verified focus as app.focus.
   */
  const targetFocus: WindowsExecutor = async (args, ctx) => {
    const { signal } = ctx;
    const off = notWindows("Switching back");
    if (off) return off;
    if (args.kind === "app") return appFocus({ name: args.app }, ctx);
    if (args.kind !== "site") return { ok: false, verified: false, said: "I only switch back to a website or an app, so nothing was touched.", data: { refused: true } };
    const title = String(args.title ?? "").trim().slice(0, 120);
    const url = String(args.url ?? "");
    const wantHost = host(url);
    if (!title && !wantHost) return { ok: false, verified: false, said: "I don't know which page that was, so nothing was touched." };
    const targetId = typeof args.targetId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(args.targetId) ? args.targetId : "";
    let activated = false;
    if (targetId) {
      // The tab's id is known: it is that tab or nothing. A closed tab (or a closed browser) is a recovery state, never a fallback to a
      // window that merely has a similar title.
      const hands = await browser.hands().catch(() => null);
      const up = await browser.up().catch(() => false);
      const live = up && hands ? await hands.tabs().catch(() => [] as BrowserTab[]) : [];
      if (!live.some((b) => b.targetId === targetId)) return { ok: false, verified: false, said: `That tab was closed, so I can't switch back to "${title || wantHost}".`, data: { recovery: "tab-closed", tabId: targetId } };
      if (hands?.activate) activated = await hands.activate(targetId).catch(() => false);
      if (!activated) return { ok: false, verified: false, said: "I couldn't make that tab the active one, so I didn't switch to a different window.", data: { recovery: "tab-not-active", tabId: targetId } };
    }
    // A site's own name is also what its pages call themselves ("Sydney weather - YouTube" for youtube.com), but only for a bare registrable domain.
    const matches = (w: WinInfo) => BROWSER_PROC.test(w.process) && siteWindowMatches(w.title, title, wantHost);
    const found = await poll(signal, t.focusWaitMs, async () => (await win.windows().catch(() => [] as WinInfo[])).find(matches));
    if (!found) return { ok: false, verified: false, said: `I couldn't find the browser window showing "${title || wantHost}" any more, so I can't switch back to it.`, data: { activated } };
    await win.focus(found.handle);
    const front = await poll(signal, t.focusWaitMs, async () => {
      const f = await win.foreground().catch(() => null);
      return f && f.handle === found.handle && matches(f) ? f : null;
    });
    if (front)
      return { ok: true, verified: true, checkedAt: Date.now(), said: `Switched back to ${title || wantHost}.`, evidence: `Windows reports the ${front.process} window ${front.handle} "${front.title.slice(0, 80)}" as the foreground window`, data: { kind: "site", handle: front.handle, process: front.process, title: front.title, foreground: true, activated } };
    const now = await win.foreground().catch(() => null);
    return { ok: false, verified: false, said: `I asked Windows to bring ${title || wantHost} back, but ${now ? `${now.process} is in front instead` : "nothing reports being in front"}, so I can't say it's showing.`, data: { kind: "site", foreground: false, activated } };
  };

  return { "app.focus": guard("Focusing the app", appFocus), "browser.navigate": guard("Opening the page", browserNavigate), "observe.window": guard("Looking at the window", observeWindow), "target.focus": guard("Switching back", targetFocus) };
}

// ------------------------------------------------------------------------------------------------
// The real browser side.

const CHROME_PATHS = (env: Record<string, string | undefined>) =>
  [env.ProgramFiles && join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"), env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"]!, "Google", "Chrome", "Application", "chrome.exe"), env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")].filter((p): p is string => !!p);

/** The profile Jarvis Chrome uses: the well-known one on 9222 (as scripts/windows/jarvis-chrome.ps1), else one beside it per port. */
export function jarvisProfileDir(port: number, env: Record<string, string | undefined> = process.env): string {
  const base = env.LOCALAPPDATA || join(env.USERPROFILE || ".", "AppData", "Local");
  return join(base, port === 9222 ? "Jarvis Chrome" : `Jarvis Chrome ${port}`);
}

export type LiveBrowserOptions = { port?: number; profileDir?: string; chromeExe?: string; session?: string; startWaitMs?: number };

/** The real browser dependencies: agent-browser hands over CDP; Chrome started with its own profile when nothing listens. */
export function liveBrowserDeps(opts: LiveBrowserOptions = {}): BrowserDeps {
  let cached: Promise<{ hands: BrowserHandsLike; port: number } | null> | null = null;
  const portOf = async () => opts.port ?? (await import("../j2/agent-browser")).jarvisCdpPort();
  let knownPort = opts.port ?? 9222;
  const up = async () => {
    const port = await portOf();
    knownPort = port;
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  };
  return {
    get port() {
      return knownPort;
    },
    async hands() {
      cached ??= (async () => {
        const { agentBrowserExe, createAgentBrowserHands, spawnRunner } = await import("../j2/agent-browser");
        const exe = agentBrowserExe();
        if (!exe) return null;
        const port = await portOf();
        knownPort = port;
        return { hands: createAgentBrowserHands({ run: spawnRunner(exe), port, session: opts.session ?? "companion-hands" }) as unknown as BrowserHandsLike, port };
      })();
      return (await cached)?.hands ?? null;
    },
    up,
    async start(url) {
      const port = await portOf();
      const chrome = opts.chromeExe ?? CHROME_PATHS(process.env).find(existsSync);
      if (!chrome) return false;
      const profile = opts.profileDir ?? jarvisProfileDir(port);
      mkdirSync(profile, { recursive: true });
      const child = spawn(chrome, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "about:blank"], { detached: true, stdio: "ignore" });
      child.unref();
      const until = Date.now() + (opts.startWaitMs ?? 20_000);
      while (Date.now() < until) {
        if (await up()) return true;
        await new Promise((r) => setTimeout(r, 400));
      }
      void url;
      return false;
    },
  };
}
