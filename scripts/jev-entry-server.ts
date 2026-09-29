/**
 * The Jarvis entry's live wiring on this PC (the server side of /screen/command): real executors,
 * keys through the runtime reference (providerKey; values are never logged or returned), and the
 * app-owned browser opened on first use and kept for the session (closed with the server).
 */
import { spawn } from "node:child_process";
import type { ScreenHands } from "./screen-hands/index";
import { createJarvisEntry, type JarvisEntry } from "./jev-command";
import { providerKey } from "./provider-config";
import { APP_BROWSER_DIR, groqSummariser, loadAppChromium, openAppBrowser, type AppBrowser } from "./browser/app-browser";
import { pcAct, startApps } from "./pc-hands";
import { windowIsApp } from "./jarvis-skills/windows";
import { createWindowsExecutors, liveWindowsDeps, type WindowsDeps } from "./executors/windows";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** Open a file with its default app (Start-Process, the path passed as base64: never spliced). */
export function openWithDefaultApp(path: string): Promise<void> {
  return new Promise((done, fail) => {
    const script = `Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}')))`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`Start-Process exited ${code}`))));
    child.on("error", fail);
  });
}

export function createLiveEntry(options: { screen: ScreenHands; root?: string; headless?: boolean }): { entry: JarvisEntry; close(): Promise<void> } {
  const root = options.root ?? process.cwd();
  const key = (name: string) => providerKey(root, name);
  let browser: Promise<AppBrowser | null> | null = null;
  const getBrowser = () =>
    (browser ??= (async () => {
      const chromium = await loadAppChromium();
      if (!chromium) return null;
      return openAppBrowser({ chromium, profileDir: APP_BROWSER_DIR(root), headless: options.headless ?? false }).catch(() => null);
    })().then((b) => {
      if (!b) browser = null;
      return b;
    }));
  const hands = options.screen.hands;
  // Track 2: the SAME Windows executors a companion runs (scripts/executors/windows.ts), started on first use.
  let windowsDeps: WindowsDeps | null = null;
  let windows: ReturnType<typeof createWindowsExecutors> | null = null;
  const windowsExec = () => (windows ??= createWindowsExecutors((windowsDeps = liveWindowsDeps({ roots: [] }))));
  const entry = createJarvisEntry({
    screen: options.screen,
    jevKey: () => key("TYPESAFE_API_KEY") || key("JEV_API_KEY"),
    front: async () => {
      const w = await hands.foreground().catch(() => null);
      return w ? { process: w.process, title: w.title } : null;
    },
    browser: getBrowser,
    activeVideo: async () => {
      const b = browser ? await browser.catch(() => null) : null;
      return !!b && /\/watch\?v=/.test(b.page().url());
    },
    summarise: groqSummariser({ key: () => key("GROQ_API_KEY") }),
    files: {
      open: openWithDefaultApp,
      titles: async () => (await hands.windows().catch(() => [])).map((w) => w.title),
    },
    apps: () => startApps(),
    notepad: (text, signal) => windowsExec()["notepad.type"]({ text }, { signal }),
    deckBlank: (title, signal) => windowsExec()["deck.blank"]({ title }, { signal }),
    // Open, then check a window of that app actually appeared (not just that Start-Process returned).
    // Honours the stop (REVIEW-T2 R2): before the launch nothing starts; after it, the wait for the window ends
    // at once and says Windows may still open it (never "opened").
    openApp: async (name, signal) => {
      if (signal.aborted) return { ok: false, said: "Stopped before anything opened." };
      const before = new Set((await hands.windows().catch(() => [])).map((w) => w.handle));
      if (signal.aborted) return { ok: false, said: "Stopped before anything opened." };
      const r = await pcAct({ action: "open_app", target: name });
      if (!r.ok) return { ok: false, said: r.said };
      for (let i = 0; i < 30; i++) {
        if (signal.aborted) return { ok: false, said: `Stopped. I'd already asked Windows to start ${name}, so it may still open.` };
        await new Promise((res) => setTimeout(res, 300));
        const fresh = (await hands.windows().catch(() => [])).find((w) => !before.has(w.handle) && (windowIsApp(name.toLowerCase(), w.process) || w.title.toLowerCase().includes(name.toLowerCase())));
        if (fresh) return { ok: true, said: `Opened ${name}.`, checkedAt: Date.now() };
      }
      return { ok: false, said: `I started ${name}, but no new ${name} window appeared, so I can't say it opened.` };
    },
  });
  return {
    entry,
    async close() {
      const b = await browser?.catch(() => null);
      await b?.close();
      windowsDeps?.close?.();
    },
  };
}
