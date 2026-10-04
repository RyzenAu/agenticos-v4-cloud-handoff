// What "it", "that tab" and "the window" mean in his next sentence: the app, window or tab Jarvis last
// opened or acted on (J-fix, 29 Sep: "open a Chrome tab" then "bring it to my front screen" moved the
// Jarvis desktop app instead, because "it" fell back to whatever window was in front).
//
// One per hub process (the voice skills, the window skill and Jarvis Chrome all run in it). It holds no
// content: an app name, a window handle and, for Jarvis Chrome, that it's Jarvis' own browser.

export type Referent = {
  /** What he'd call it: "chrome", "notepad", "spotify". */
  app: string;
  /** The window handle, once known (the window skill fills it in when it finds or places the window). */
  handle?: number;
  /** Jarvis' own Chrome (the separate CDP profile), not his everyday browser. */
  jarvisChrome?: boolean;
  /** Jarvis Chrome's DevTools target (the tab) it opened, so bringing it up activates THAT tab. */
  targetId?: string;
  /** The page or window title when it was opened, a hint only. */
  title?: string;
  at: number;
};

/** Older than this, "it" is ambiguous again and the window skill asks. */
export const REFERENT_TTL_MS = 15 * 60_000;

let current: Referent | null = null;

export function rememberReferent(r: Omit<Referent, "at">, now = Date.now()): Referent {
  const app = String(r.app ?? "").toLowerCase().trim().slice(0, 40);
  current = { ...r, app, at: now };
  return current;
}

export function currentReferent(now = Date.now()): Referent | null {
  return current && now - current.at <= REFERENT_TTL_MS ? current : null;
}

export function forgetReferent() {
  current = null;
}

/**
 * Jarvis' own window (the desktop app, titled "Jarvis v… · shell 0.2.1"): never what "it" means, and
 * never the fallback for "bring it to my front screen".
 */
export function isJarvisOwnWindow(w: { process: string; title: string }): boolean {
  return /(?:^|\s)[·|-]\s*shell\s+\d+\.\d+/i.test(w.title) || /^(?:jarvis|agentic-os|agenticos|agentic os)$/i.test(w.process.trim());
}
