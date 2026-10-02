// Playwright as the explicit executor for browser targets, ahead of vision (jarvis-deep-research.md
// §3 and P1 item 4). Browser content is driven through the page's own DOM with Playwright's
// actionability checks (visible, stable, enabled, receives events: playwright.dev/docs/actionability)
// instead of pixels, and every action still goes through screen_act's loop: parseGoal, vetAction
// (final buttons need his yes, no secrets, no controls whose text addresses an assistant), the refs
// stale check and the typed-value read-back. Vision is never used on this path.
//
// Which browser, in code:
// - "isolated": a fresh Playwright Chromium with an ephemeral profile (no user-data dir at all):
//   synthetic tasks and the acceptance suite.
// - "jarvis-chrome": the separate Jarvis Chrome CDP profile on 127.0.0.1:9222, ONLY when it is
//   already running (this module never launches it), and only a page of that browser.
// - Never his own Chrome/Edge profile: any user-data dir under a browser's "User Data" is refused.
//
// Page text is untrusted data: steps come from his goal only, never from the page. Requests are
// limited to an allow-list of loopback origins; anything else is aborted and counted (origins only,
// never URLs or bodies); popups are closed, JavaScript dialogs dismissed, downloads cancelled.
import { resolve as resolvePath, sep } from "node:path";
import type { WindowInfo } from "../jarvis-skills/windows";
import { CDP_ID_BASE, cdpElements, FOCUSED_JS, refJs, SNAPSHOT_JS, type CdpPage } from "./cdp";
import { FLAGS_OFF, type ScreenFlags } from "./flags";
import type { Hands, Minds, ScreenDone, ScreenEvent, ScreenRequest } from "./index";
import { runScreenAct } from "./index";
import { FINAL_BUTTON, INJECTION, parseGoal, type Snapshot, type UiElement } from "./plan";
import { RefError, sameTarget } from "./refs";
import { classifyControlTask, type RiskTier } from "../../src/lib/control-risk";

// --- minimal structural types for the parts of Playwright used (no type dependency) ----------------
export type PwElementHandle = { asElement(): PwElementHandle | null; click(o?: { timeout?: number }): Promise<void>; dispose(): Promise<void> };
export type PwRoute = { request(): { url(): string }; continue(): Promise<void>; abort(code?: string): Promise<void> };
export type PwPage = {
  url(): string;
  title(): Promise<string>;
  goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  evaluateHandle(fn: (i: number) => unknown, arg: number): Promise<PwElementHandle>;
  keyboard: { insertText(text: string): Promise<void>; press(key: string): Promise<void> };
  mouse: { click(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  route(url: string, handler: (route: PwRoute) => unknown): Promise<unknown>;
  on(event: "dialog" | "download" | "popup", handler: (x: any) => unknown): unknown;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
};
export type PwContext = { newPage(): Promise<PwPage>; pages(): PwPage[]; on(event: "page", handler: (p: PwPage) => unknown): unknown; close(): Promise<void> };
export type PwBrowser = { newContext(o?: Record<string, unknown>): Promise<PwContext>; contexts(): PwContext[]; close(): Promise<void> };
export type PwChromium = {
  launch(o?: Record<string, unknown>): Promise<PwBrowser>;
  connectOverCDP(endpoint: string, o?: Record<string, unknown>): Promise<PwBrowser>;
};

/**
 * Playwright's Chromium, or null. playwright-core isn't a dependency of this repo yet (only its
 * browsers are installed), so it is loaded from the package, then PLAYWRIGHT_CORE_PATH, then `path`.
 */
export async function loadChromium(path?: string, env: Record<string, string | undefined> = process.env): Promise<PwChromium | null> {
  for (const spec of ["playwright-core", env.PLAYWRIGHT_CORE_PATH, path].filter(Boolean) as string[]) {
    try {
      const mod: any = await import(spec);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium?.launch) return chromium as PwChromium;
    } catch {
      // next candidate
    }
  }
  return null;
}

// --- policy (pure) ---------------------------------------------------------------------------------
export const JARVIS_CHROME_CDP = "http://127.0.0.1:9222";
/** His own browsers' profile roots: never driven, never launched with. */
export function ownerProfileRoots(env: Record<string, string | undefined> = process.env): string[] {
  const local = env.LOCALAPPDATA ?? "";
  if (!local) return [];
  return [
    ["Google", "Chrome", "User Data"],
    ["Google", "Chrome Beta", "User Data"],
    ["Microsoft", "Edge", "User Data"],
    ["BraveSoftware", "Brave-Browser", "User Data"],
    ["Chromium", "User Data"],
  ].map((p) => resolvePath(local, ...p));
}
/** Is this user-data dir one of his real browser profiles (or inside one)? Pure. */
export function isOwnerProfile(dir: string, env: Record<string, string | undefined> = process.env): boolean {
  const d = resolvePath(dir).toLowerCase();
  return ownerProfileRoots(env).some((root) => {
    const r = root.toLowerCase();
    return d === r || d.startsWith(r + sep);
  });
}
/** A loopback origin (the only kind the executor will talk to). Pure. */
export const loopbackOrigin = (origin: string) => /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?$/i.test(origin);
/** May the page load this URL? Only the allow-listed loopback origins (and about:blank). Pure. */
export function allowedUrl(url: string, allow: readonly string[]): boolean {
  if (url === "about:blank") return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return loopbackOrigin(origin) && allow.includes(origin);
}

export type BrowserExecutor = "playwright" | "cdp" | "uia" | "vision";
/**
 * The executor for a window, cheapest-exact first: Playwright for Jarvis Chrome's own page (the 9222
 * browser owns the window), CDP for an Electron app opened for driving, UIA for everything else. Vision
 * is never chosen here; screen_act reaches it only when UIA finds nothing and he has allowed it. Pure.
 */
export function executorFor(input: { win: Pick<WindowInfo, "process">; windowPid: number | null; jarvisChromePid: number | null; electronSession: boolean; playwright: boolean }): BrowserExecutor {
  if (input.electronSession) return "cdp";
  const browser = /^(?:chrome|msedge|chromium)$/i.test(input.win.process);
  if (browser && input.playwright && input.jarvisChromePid && input.windowPid === input.jarvisChromePid) return "playwright";
  return "uia";
}
/** "Checkout - Google Chrome" → "Checkout". Pure. */
export const pageTitleOf = (windowTitle: string) => windowTitle.replace(/\s+[-–—]\s+(?:Google Chrome|Chromium|Microsoft​? Edge|Chrome for Testing)$/i, "").trim();

// --- dry run (pure) --------------------------------------------------------------------------------
export type BrowserPlanStep = { n: number; action: string; target: string; tier: RiskTier; needsApproval: boolean; note?: string };
/**
 * What a browser goal would do, without running anything: each parsed step, its tier, and whether
 * it needs his yes (a final button) or would be refused (a control that addresses an assistant).
 * Typed text is shown only as a length. Pure.
 */
export function planBrowserTask(goal: string): { steps: BrowserPlanStep[] | null; tier: RiskTier; executed: false } {
  const steps = parseGoal(goal);
  const tier = classifyControlTask(goal).tier;
  if (!steps) return { steps: null, tier, executed: false };
  return {
    tier,
    executed: false,
    steps: steps.map((s, i) => {
      const n = i + 1;
      if (s.do === "click") {
        const final = FINAL_BUTTON.test(s.target);
        return { n, action: "click", target: s.target.slice(0, 60), tier: final ? "external-effect" : "local-reversible", needsApproval: final, ...(INJECTION.test(s.target) ? { note: "refused: reads as instructions to an assistant" } : {}) };
      }
      if (s.do === "type") return { n, action: "type", target: s.into ?? "the focused field", tier: "local-reversible", needsApproval: false, note: `${s.text.length} characters` };
      if (s.do === "key") return { n, action: "key", target: s.keys, tier: "local-reversible", needsApproval: /enter/.test(s.keys), ...( /enter/.test(s.keys) ? { note: "Enter in a form field asks for his yes" } : {}) };
      if (s.do === "file") return { n, action: s.kind, target: s.name.split(/[\\/]/).pop() ?? s.name, tier: "local-reversible", needsApproval: false };
      if (s.do === "scroll") return { n, action: "scroll", target: s.dir, tier: "read-only", needsApproval: false };
      return { n, action: s.do, target: "", tier: "read-only", needsApproval: false };
    }),
  };
}

// --- the session -------------------------------------------------------------------------------------
export type BrowserEvidence = { blockedOrigins: string[]; blocked: number; dialogs: number; popups: number; downloads: number };
export type BrowserSession = {
  mode: "isolated" | "jarvis-chrome";
  page: PwPage;
  evidence: BrowserEvidence;
  close(): Promise<void>;
};

function guard(page: PwPage, allow: readonly string[], evidence: BrowserEvidence) {
  return Promise.all([
    page.route("**/*", async (route) => {
      const url = route.request().url();
      if (allowedUrl(url, allow)) return route.continue();
      evidence.blocked++;
      let origin = "invalid";
      try {
        origin = new URL(url).origin;
      } catch {
        // counted as invalid
      }
      if (!evidence.blockedOrigins.includes(origin) && evidence.blockedOrigins.length < 20) evidence.blockedOrigins.push(origin.slice(0, 80));
      return route.abort("blockedbyclient");
    }),
    page.on("dialog", (d: { dismiss(): Promise<void> }) => {
      evidence.dialogs++;
      void d.dismiss().catch(() => undefined);
    }),
    page.on("download", (d: { cancel(): Promise<void> }) => {
      evidence.downloads++;
      void d.cancel().catch(() => undefined);
    }),
  ]);
}

/**
 * Open a browser session for a task. `isolated` launches a fresh Chromium (ephemeral profile);
 * `jarvis-chrome` attaches only if 127.0.0.1:9222 already answers, and opens its own new page there.
 */
export async function openBrowserSession(options: {
  chromium: PwChromium;
  mode: "isolated" | "jarvis-chrome";
  allowOrigins: string[];
  headless?: boolean;
  request?: typeof fetch;
  userDataDir?: string;
}): Promise<BrowserSession> {
  if (options.userDataDir && isOwnerProfile(options.userDataDir)) throw new Error("That's his own browser profile; I never drive it.");
  const allow = options.allowOrigins.filter(loopbackOrigin);
  if (allow.length !== options.allowOrigins.length) throw new Error("The browser executor only talks to loopback origins.");
  const evidence: BrowserEvidence = { blockedOrigins: [], blocked: 0, dialogs: 0, popups: 0, downloads: 0 };
  if (options.mode === "jarvis-chrome") {
    const request = options.request ?? fetch;
    const alive = await request(`${JARVIS_CHROME_CDP}/json/version`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
    if (!alive) throw new Error("Jarvis Chrome isn't running on 127.0.0.1:9222, and I don't start it for this.");
    const browser = await options.chromium.connectOverCDP(JARVIS_CHROME_CDP, { timeout: 5000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Jarvis Chrome has no browsing context to use.");
    const page = await context.newPage();
    await guard(page, allow, evidence);
    return {
      mode: "jarvis-chrome",
      page,
      evidence,
      // Our page only: Jarvis Chrome itself keeps running.
      close: async () => {
        await page.close().catch(() => undefined);
      },
    };
  }
  const browser = await options.chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  context.on("page", (p) => {
    if (p === page) return;
    evidence.popups++;
    void p.close().catch(() => undefined);
  });
  await guard(page, allow, evidence);
  return {
    mode: "isolated",
    page,
    evidence,
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

// --- Hands over a Playwright page -------------------------------------------------------------------
export const PLAYWRIGHT_WINDOW = 1_000_001;
const KEY: Record<string, string> = {
  ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  space: "Space", backspace: "Backspace", delete: "Delete", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", f5: "F5",
};
/** "ctrl+a" → "Control+a"; null for anything not on the list (no Windows key, no chords beyond it). Pure. */
export function playwrightKey(chord: string): string | null {
  const parts = chord.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (KEY[p]) out.push(KEY[p]);
    else if (/^[a-z0-9]$/.test(p)) out.push(p);
    else return null;
  }
  return out.join("+");
}

/**
 * screen_act's Hands, backed by one Playwright page: the same fixed page scripts as the CDP path
 * (cdp.ts), presses through Playwright's actionability-checked click after a stale-ref recheck,
 * typing as inserted text (no clipboard, no pointer), and no screenshots (no vision on this path).
 */
export function playwrightHands(page: PwPage, title = "Playwright page", as?: WindowInfo): Hands {
  // `as`: the real browser window this page is shown in (Jarvis Chrome), so onlyWindow checks still hold.
  const win: WindowInfo = as ?? { handle: PLAYWRIGHT_WINDOW, process: "playwright", cls: "PlaywrightPage", title };
  const read = async (): Promise<Snapshot> => {
    const raw = await page.evaluate(SNAPSHOT_JS);
    const p = JSON.parse(String(raw)) as CdpPage;
    const elements = cdpElements({ ...p, dpr: 1 }, { x: 0, y: 0 });
    return { window: { x: 0, y: 0, w: p.innerWidth, h: p.innerHeight }, elements, focused: elements.find((e) => e.focused) ?? null, browser: true };
  };
  const focused = async (): Promise<UiElement | null> => {
    const raw = await page.evaluate(FOCUSED_JS).catch(() => null);
    return raw ? cdpElements({ ...(JSON.parse(String(raw)) as CdpPage), dpr: 1 }, { x: 0, y: 0 })[0] ?? null : null;
  };
  const press = async (element: UiElement) => {
    if (element.id < CDP_ID_BASE) throw new RefError("STALE_REF", "That isn't a control on this page, so I left it alone.");
    const i = element.id - CDP_ID_BASE;
    const now = await page.evaluate(refJs(i));
    const fresh = now ? (JSON.parse(String(now)) as { x: number; y: number; w: number; h: number; name: string }) : null;
    const asUi = fresh ? { ...element, name: fresh.name, x: Math.round(fresh.x), y: Math.round(fresh.y), w: Math.round(fresh.w), h: Math.round(fresh.h) } : null;
    if (!sameTarget(element, asUi)) throw new RefError("STALE_REF", "That control changed just before the click, so I didn't press it.");
    const handle = await page.evaluateHandle((n: number) => ((globalThis as any)[Symbol.for("jarvis.refs")] ?? [])[n], i);
    const el = handle.asElement();
    if (!el) throw new RefError("STALE_REF", "That control is gone, so I didn't press it.");
    try {
      await el.click({ timeout: 5000 });
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  };
  return {
    foreground: async () => (page.isClosed() ? null : as ? win : { ...win, title: (await page.title().catch(() => title)) || title }),
    windows: async () => (page.isClosed() ? [] : [win]),
    focus: async () => (await page.bringToFront().catch(() => undefined), true),
    snapshot: read,
    focused,
    at: async () => null,
    click: async (_h, x, y, expect) => {
      if (expect) return press(expect);
      await page.mouse.click(x, y);
    },
    press: async (_h, element) => (await press(element), "uia"),
    type: async (_h, text) => page.keyboard.insertText(text),
    keys: async (_h, chord) => {
      const key = playwrightKey(chord);
      if (!key) throw new Error(`I don't press ${chord} in a browser page.`);
      await page.keyboard.press(key);
    },
    wheel: async (_h, _x, _y, delta) => page.mouse.wheel(0, -delta),
    capture: async () => null,
  };
}

/**
 * One goal on a Playwright page, through screen_act's own loop and rules. Vision is off; the
 * deny-list, the pre-press recheck and refs are on. The page's evidence (blocked origins, dialogs,
 * popups) comes back with the result.
 */
export async function runBrowserAct(
  req: ScreenRequest,
  session: Pick<BrowserSession, "page" | "evidence">,
  deps: { signal: AbortSignal; minds?: Minds; flags?: ScreenFlags; onEvent?: (e: ScreenEvent) => void; title?: string } ,
): Promise<ScreenDone & { executor: "playwright"; evidence: BrowserEvidence }> {
  const hands = playwrightHands(session.page, deps.title);
  const done = await runScreenAct(
    { ...req, vision: false, onlyWindow: PLAYWRIGHT_WINDOW },
    { hands, minds: deps.minds ?? {}, signal: deps.signal, onEvent: deps.onEvent, flags: { ...(deps.flags ?? FLAGS_OFF), denylist: true, recheck: true, refs: true } },
  );
  return { ...done, executor: "playwright", evidence: { ...session.evidence, blockedOrigins: [...session.evidence.blockedOrigins] } };
}

// --- Jarvis Chrome (127.0.0.1:9222) as screen_act's browser executor ----------------------------------
export type JarvisChromeDeps = {
  /** The pid listening on 127.0.0.1:9222, or null. */
  listenerPid(): Promise<number | null>;
  windowPid(handle: number): Promise<number | null>;
  chromium(): Promise<PwChromium | null>;
  request?: typeof fetch;
};
export type JarvisChromeRoute = { forWindow(win: WindowInfo): Promise<{ hands: Hands; close(): Promise<void> } | null> };
/**
 * When the window in front is Jarvis Chrome's own (the browser listening on 127.0.0.1:9222 owns it) and
 * exactly one of its pages has the window's title, screen_act drives that page through Playwright.
 * Anything else (his own Chrome, no 9222, no Playwright, an ambiguous title) returns null: UIA as before.
 * Never launches a browser; disconnecting leaves Jarvis Chrome running.
 */
export function createJarvisChromeRoute(deps: JarvisChromeDeps): JarvisChromeRoute {
  const request = deps.request ?? fetch;
  return {
    async forWindow(win) {
      if (!/^(?:chrome|msedge|chromium)$/i.test(win.process)) return null;
      const alive = await request(`${JARVIS_CHROME_CDP}/json/version`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
      if (!alive) return null;
      const [jarvisChromePid, windowPid] = await Promise.all([deps.listenerPid().catch(() => null), deps.windowPid(win.handle).catch(() => null)]);
      if (executorFor({ win, windowPid, jarvisChromePid, electronSession: false, playwright: true }) !== "playwright") return null;
      const chromium = await deps.chromium().catch(() => null);
      if (!chromium) return null;
      const browser = await chromium.connectOverCDP(JARVIS_CHROME_CDP, { timeout: 4000 }).catch(() => null);
      if (!browser) return null;
      const want = pageTitleOf(win.title);
      const pages = browser.contexts().flatMap((c) => c.pages());
      const titles = await Promise.all(pages.map((pg) => pg.title().catch(() => "")));
      const matches = pages.filter((_, i) => titles[i] === want);
      if (matches.length !== 1) {
        await browser.close().catch(() => undefined);
        return null;
      }
      return { hands: playwrightHands(matches[0], win.title, win), close: () => browser.close().catch(() => undefined) };
    },
  };
}
