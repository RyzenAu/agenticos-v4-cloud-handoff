// Jarvis's fast hands in the browser: one Chrome DevTools Protocol call instead of a Hermes
// computer_use loop (screenshot → model → click, ~1 minute). Works on "Jarvis Chrome" — the
// separate profile on 127.0.0.1:9222 that scripts/windows/jarvis-chrome.ps1 starts — so the
// pages Jarvis opens are pages he can act on. Loopback only; no page content leaves the PC.
//
// Actions: click (by ordinal and/or words: "the first video", "Sign in"), pause, play, back,
// forward, reload, scroll_down, scroll_up, new_tab, close_tab, search (types into the page's
// search box and submits). Nothing here submits forms other than a site's search box, types
// passwords, or buys anything.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { FINAL_BUTTON } from "../src/lib/action-keywords";
import { moneyButton, moneyContextLevel } from "../src/lib/money-policy";
import { commitPress } from "./screen-hands/plan";
import { rememberReferent } from "./jarvis-skills/referent";

// --- final buttons (S2c, REVIEW-T1 required fix 1) ----------------------------------------------------
/**
 * A final or commit button by its words: send, submit, delete, post, publish, pay, place order, confirm,
 * book, accept… The ONE shared classification (src/lib/action-keywords.ts FINAL_BUTTON, which screen-hands'
 * vetAction and control_pc use, plus money-policy's moneyButton), never a copy. Pure.
 */
export function finalButtonText(text: string | null | undefined): boolean {
  const t = tidyName(text);
  // The name as written, and a copy without combining marks (REVIEW-S2C R3: "S̶e̶n̶d̶" is "Send"): either final is final.
  return !!t && [t, withoutMarks(t)].some((v) => FINAL_BUTTON.test(v) || moneyButton(v));
}
/** A copy with every combining mark removed (NFD, drop \p{Mn}, NFC): "S̶e̶n̶d̶" → "Send". Only ever ADDS refusals. Pure. */
export const withoutMarks = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC");
/**
 * The two bidi OVERRIDES (LRO U+202D, RLO U+202E): the only controls that make a word display differently from
 * how it's stored (logical "yap" drawn as "pay"). The marks, embeddings and isolates (LRM, RLM, ALM, LRE, RLE,
 * PDF, LRI, RLI, FSI, PDI) never reorder letters inside a word, so they're just stripped with \p{Cf}: Gmail's
 * "Bold (Ctrl-B)" hints and Hebrew or Arabic labels read normally (REVIEW-S2C R4, lead decision).
 */
const BIDI_CONTROL = /[\u202D\u202E]/u;
/** One word mixing Latin with Cyrillic or Greek letters ("Dеlete" with a Cyrillic е, "Ѕend", "Ρost"): a homoglyph. Pure. */
function mixedScriptWord(text: string): boolean {
  return text.split(/[^\p{L}\p{M}]+/u).some((word) => /\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word));
}
/**
 * A name nobody can read honestly (REVIEW-S2C R3): it carries a bidi control (RLO + "yap" displays as "pay"),
 * or a word mixes Latin with Cyrillic or Greek. Checked on the RAW name, before format characters are stripped.
 * Such a name counts as no name at all, so the unnamed-is-final rule refuses the press. Pure.
 */
export function hostileName(text: string | null | undefined): boolean {
  const raw = String(text ?? "");
  return BIDI_CONTROL.test(raw) || mixedScriptWord(raw.normalize("NFKC"));
}
/**
 * A control's name as the gate reads it (REVIEW-S2C R2): NFKC (full-width "ＳＥＮＤ" is "SEND"), with every
 * format character removed (zero-width spaces, the soft hyphen in "Sub­mit", bidi controls), spaces collapsed.
 * Pure.
 */
export function tidyName(text: string | null | undefined): string {
  // A hostile name (bidi reordering, mixed-script homoglyphs) reads as no name (REVIEW-S2C R3).
  if (hostileName(text)) return "";
  return String(text ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}
/** A name made only of symbols or emoji ("🗑️", "➤", "×") says nothing: the control counts as unnamed. Pure. */
export const saysSomething = (name: string) => /[\p{L}\p{N}]/u.test(name);
/**
 * The browser never presses a final button itself (REVIEW-T1 fix 1). /browser/act has no question and no
 * spoken-yes check, so a final press goes through screen_act instead, which asks "Shall I press Send?" and
 * presses only on his spoken yes to that exact button (the server's spoken-yes ledger); a typed yes never
 * counts. Returns the line to say, or null when the click may go ahead. A video title that happens to hold
 * such a word ("How to delete your account") isn't a button. Pure.
 */
export function finalClickRefusal(hit: Pick<Candidate, "kind" | "label" | "names"> | null, target: string): string | null {
  const wanted = parseTarget(target);
  const say = (label: string) =>
    `That's the final "${label.slice(0, 60)}" button, and I only press those after your spoken yes: say "press ${label.slice(0, 60)}" out loud and I'll ask you first. Nothing was pressed.`;
  if (wanted.kind !== "video" && finalButtonText(wanted.words || target)) return say(wanted.words || target);
  if (!hit || hit.kind === "video") return null;
  // A trick name (a bidi override or a mixed-script homoglyph) on ANY control, a link styled as a button
  // included, is never pressed (REVIEW-S2C R4). A plain unnamed link (an icon) stays clickable below.
  if ([hit.label, ...(hit.names ?? [])].some((name) => hostileName(name)))
    return `That button has no name I can read, so it could be a final press. Say out loud what it does ("press Send") and I'll ask you first, or click it yourself. Nothing was pressed.`;
  // EVERY name the control has, at any length (REVIEW-S2C fix 1): visible text, aria-label, title and value.
  // A title "More options" over a visible "Post", or an aria-label "Next" over a visible "Delete", is final.
  const names = candidateNames(hit);
  const final = names.find((name) => finalButtonText(name));
  if (final) return say(final);
  // A button with no readable name could be anything, a final press included (REVIEW-S2C fix 3).
  if (hit.kind === "button" && !names.length)
    return `That button has no name I can read, so it could be a final press. Say out loud what it does ("press Send") and I'll ask you first, or click it yourself. Nothing was pressed.`;
  return null;
}
/** Every name a candidate carries, tidied and de-duplicated. Pure. */
export function candidateNames(hit: Pick<Candidate, "label" | "names">): string[] {
  const raw = [hit.label, ...(hit.names ?? [])];
  // One hostile name makes the whole control unreadable: an honest aria-label "Next" beside a visible RLO
  // "yap" (drawn as "pay") must not let the press through (REVIEW-S2C R3).
  if (raw.some((name) => hostileName(name))) return [];
  const all = raw.map(tidyName).filter((n) => n && saysSomething(n));
  return [...new Set(all)];
}

/** The page around a click, read in the page (title, address, text, the texts beside the control…). */
export type PageMoneyContext = { title: string; url: string; text: string; nearby: string; controls: string; embeds: boolean; progress: boolean };
/**
 * A committing press ("Continue", "OK", "Next", an unnamed button…) on a page with money on it (REVIEW-S2C fix
 * 4): P's moneyContextLevel, exactly as the screen path uses it. A payment step (transactional) is never pressed
 * from the browser; an amount merely in sight needs his spoken yes. Ordinary presses ("Show more", "Next page")
 * are unchanged. Returns the line to say, or null. Pure.
 */
export function moneyClickRefusal(hit: Pick<Candidate, "kind" | "label" | "names">, page: PageMoneyContext): string | null {
  if (hit.kind === "video") return null;
  const label = candidateNames(hit)[0] ?? "";
  const commit = commitPress(label);
  if (!commit) return null;
  const level = moneyContextLevel({
    title: page.title, url: page.url, text: page.text, element: { name: label }, controls: page.controls, commit, embeds: page.embeds, nearby: page.nearby, progress: page.progress,
  });
  if (!level) return null;
  const name = label ? `"${label.slice(0, 60)}"` : "that button";
  return level.level === "transactional"
    ? `That's a payment step (${level.reason}), so I won't press ${name} from the browser. It's yours to do yourself. Nothing was pressed.`
    : `There's money on this page (${level.reason}), so ${name} needs your spoken yes: say "press ${label.slice(0, 60) || "it"}" out loud and I'll ask you first. Nothing was pressed.`;
}
/** Runs in the page: the money context around the point (x, y). */
export const PAGE_CONTEXT = (x: number, y: number) => `(() => {
  const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  const box = el && (el.closest("form, [role=dialog], dialog, fieldset, li, tr, section, article") || el.parentElement);
  const flat = (t) => String(t || "").replace(/\\s+/g, " ").trim();
  const controls = [...document.querySelectorAll("button, [role=button], input, select, a[href]")].slice(0, 200)
    .map((c) => [c.getAttribute("aria-label"), c.getAttribute("name"), c.id, c.getAttribute("autocomplete"), (c.innerText || c.value || "").slice(0, 60)].filter(Boolean).join(" "))
    .filter(Boolean).join("\\n").slice(0, 4000);
  const nearby = String(box ? box.innerText : "").split(/\\n+/).map((t) => t.trim()).filter((t) => t && t.length <= 40).slice(0, 40).join("\\n");
  return { title: document.title, url: location.href, text: (document.title + "\\n" + flat(document.body && document.body.innerText)).slice(0, 6000), nearby, controls,
    embeds: !!document.querySelector("iframe, canvas"), progress: !!document.querySelector("progress, [role=progressbar]") };
})()`;

/**
 * A real search field (REVIEW-S2C fix 5): type=search, role=searchbox, inside role=search, a known search name
 * (q, search_query), or labelled only "Search". Not "Search or write a comment", whose Enter posts. Pure.
 */
export function isSearchField(f: { type?: string | null; role?: string | null; inSearchRegion?: boolean; name?: string | null; label?: string | null; placeholder?: string | null }): boolean {
  const only = (t: string | null | undefined) => /^\s*search\s*(?:…|\.\.\.)?\s*$/i.test(String(t ?? ""));
  return String(f.type ?? "").toLowerCase() === "search" || String(f.role ?? "").toLowerCase() === "searchbox" || !!f.inSearchRegion
    || ["q", "search_query"].includes(String(f.name ?? "")) || only(f.label) || (!f.label && only(f.placeholder));
}

export const CDP = "http://127.0.0.1:9222";
export const BROWSER_ACTIONS = [
  "click", "pause", "play", "back", "forward", "reload", "scroll_down", "scroll_up", "new_tab", "close_tab", "search",
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
export type ActRequest = { action: BrowserAction; target?: string; ordinal?: number; text?: string; url?: string };
export type ActResult = { ok: boolean; said: string; ms: number; page?: string };

type Target = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string };

const ORDINALS: Record<string, number> = {
  // No "one": in "the second one" it's a pronoun, not a number.
  first: 1, "1st": 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4,
  fifth: 5, "5th": 5, five: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1,
};

/** "the second video" → { ordinal: 2, words: "video" }. */
export function parseTarget(target = "", ordinal?: number): { ordinal?: number; words: string; kind?: "video" | "link" | "button" } {
  let words = tidyName(target).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  let n = ordinal;
  for (const [word, value] of Object.entries(ORDINALS)) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(words)) {
      n ??= value;
      words = words.replace(re, " ");
    }
  }
  words = words.replace(/\b(the|a|an|on|my|screen|page|one|please|that|this|it|click|press|open|tap|select)\b/g, " ").replace(/\s+/g, " ").trim();
  const kind = /\b(videos?|clips?|results?)\b/.test(words) ? "video" : /\bbuttons?\b/.test(words) ? "button" : /\blinks?\b/.test(words) ? "link" : undefined;
  if (kind) words = words.replace(/\b(videos?|clips?|results?|buttons?|links?)\b/g, " ").replace(/\s+/g, " ").trim();
  return { ordinal: n, words, kind };
}

/** Runs in the page: visible clickable things in reading order, video results first-class. */
export const COLLECT = `(() => {
  const vh = innerHeight, vw = innerWidth;
  const seen = new Set();
  const out = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return null;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return null;
    return r;
  };
  // Ads and promoted slots are never "the first video".
  const AD = "ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-display-ad-renderer, ytd-search-pyv-renderer, [data-ad], [id*='google_ads'], [aria-label*='Sponsored' i], [aria-label*='Advertisement' i]";
  const GENERIC = /^(watch|play|skip|more|menu|share|save|ad|sponsored|visit site|learn more|shop now)$/i;
  const add = (el, kind, label) => {
    if (!el || seen.has(el) || el.closest(AD)) return;
    if (kind === "video") {
      // Speak the video's title, not a thumbnail overlay like "2:00:53 Now playing".
      const card = el.closest("ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model");
      const title = card && card.querySelector("#video-title, a#video-title-link, .yt-lockup-metadata-view-model__title");
      if (title) label = title.getAttribute("title") || title.textContent;
      if (GENERIC.test(String(label || el.innerText || "").trim())) return;
    }
    const r = visible(el);
    if (!r) return;
    seen.add(el);
    const flat = (t) => String(t || "").trim().replace(/\\s+/g, " ");
    // Every name it has (REVIEW-S2C fix 1): the gate checks them all, not the first one found.
    const names = [el.innerText, el.getAttribute("aria-label"), el.title, el.tagName === "INPUT" ? el.value : "", el.getAttribute("alt")].map((t) => flat(t).slice(0, 300)).filter(Boolean);
    out.push({ i: out.length, kind, label: flat(label || el.getAttribute("aria-label") || el.title || el.innerText || (el.tagName === "INPUT" ? el.value : "") || "").slice(0, 140), names, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top), left: Math.round(r.left) });
  };
  // Video results: YouTube's title links, then any <a> wrapping a thumbnail or video.
  document.querySelectorAll("a#video-title, a#video-title-link, ytd-rich-grid-media a#video-title-link, a.yt-lockup-metadata-view-model__title, h3 a[href*='watch']").forEach((a) => add(a, "video", a.getAttribute("title") || a.innerText));
  document.querySelectorAll("a[href*='/watch'], a[href*='youtu.be/'], a[href*='/video'], a:has(video), a:has(img[src*='ytimg'])").forEach((a) => add(a, "video", a.getAttribute("title") || a.getAttribute("aria-label") || a.innerText));
  document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]").forEach((b) => add(b, "button"));
  document.querySelectorAll("a[href]").forEach((a) => add(a, "link"));
  return out.sort((a, b) => (Math.abs(a.top - b.top) < 24 ? a.left - b.left : a.top - b.top));
})()`;

export type Candidate = { i: number; kind: "video" | "button" | "link"; label: string; x: number; y: number; names?: string[] };

/** Pick what he meant: kind + ordinal ("first video") or best word overlap ("sign in"). */
export function pickCandidate(candidates: Candidate[], target: string, ordinal?: number): Candidate | null {
  const want = parseTarget(target, ordinal);
  let pool = want.kind ? candidates.filter((c) => c.kind === want.kind) : candidates;
  if (want.kind === "video") {
    // One entry per video: drop repeated labels (thumbnail + title point at the same video).
    const labels = new Set<string>();
    pool = pool.filter((c) => {
      const key = c.label.toLowerCase();
      if (!key || labels.has(key)) return false;
      labels.add(key);
      return true;
    });
  }
  if (want.words) {
    const terms = want.words.split(" ").filter((w) => w.length > 1);
    const scored = pool
      .map((c) => {
        const label = tidyName(c.label).toLowerCase();
        const hits = terms.filter((t) => label.includes(t)).length;
        return { c, score: hits / Math.max(terms.length, 1) + (label === want.words ? 1 : 0) };
      })
      .filter((s) => s.score >= 0.5);
    if (scored.length) pool = scored.sort((a, b) => b.score - a.score || a.c.i - b.c.i).map((s) => s.c);
    else if (!want.kind && !want.ordinal) return null;
  }
  if (!pool.length) return null;
  if (want.ordinal === -1) return pool[pool.length - 1];
  return pool[(want.ordinal ?? 1) - 1] ?? null;
}

// --- minimal CDP client -----------------------------------------------------------------------
async function targets(request: typeof fetch = fetch): Promise<Target[]> {
  const r = await request(`${CDP}/json/list`, { signal: AbortSignal.timeout(2000) });
  return ((await r.json()) as Target[]).filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
}

export async function cdpUp(request: typeof fetch = fetch) {
  try {
    const r = await request(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start Jarvis Chrome if it isn't running (≤ ~8 s), optionally opening a page. */
export async function ensureJarvisChrome(root: string, url = ""): Promise<boolean> {
  if (!url && (await cdpUp())) return true;
  const script = join(root, "scripts", "windows", "jarvis-chrome.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(url ? ["-Url", url] : [])];
  await new Promise<void>((resolve) => execFile("powershell.exe", args, { windowsHide: true, timeout: 20_000 }, () => resolve()));
  return cdpUp();
}

/**
 * Open a link in Jarvis Chrome and bring it to the front, so the next "click the first video"
 * acts on the page he's looking at. Already running: one DevTools call (~100 ms). Not running:
 * the launcher starts it with the page (~2–4 s). Returns false if Chrome won't start.
 */
export async function openInJarvisChrome(root: string, url: string, request: typeof fetch = fetch): Promise<boolean> {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch { /* keep the raw text */ }
  if (!(await cdpUp(request))) {
    const ok = await ensureJarvisChrome(root, url);
    // What "it" means next ("bring it up"): this site in Jarvis Chrome (J-fix).
    if (ok) rememberReferent({ app: "chrome", jarvisChrome: true, title: host });
    return ok;
  }
  try {
    const r = await request(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT", signal: AbortSignal.timeout(4000) });
    const target = (await r.json()) as Target;
    if (target.webSocketDebuggerUrl) {
      const s = await Session.open(target.webSocketDebuggerUrl);
      await s.send("Page.bringToFront").catch(() => undefined);
      s.close();
    }
    rememberReferent({ app: "chrome", jarvisChrome: true, title: host, ...(target.id ? { targetId: String(target.id).slice(0, 64) } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** Make one Jarvis Chrome tab the active one (DevTools' /json/activate = Target.activateTarget). */
export async function activateJarvisTab(targetId: string, request: typeof fetch = fetch): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(targetId)) return false;
  try {
    const r = await request(`${CDP}/json/activate/${targetId}`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

let chromePid: { pid: number; at: number } | null = null;
/**
 * Jarvis Chrome's browser process ID (it owns every Jarvis Chrome window), or null when it isn't
 * running. Compared with the process of the window he's looking at, so "click the first video"
 * goes to browser_act only when Jarvis Chrome really is what he sees. Cached for a minute.
 */
export async function jarvisChromePid(request: typeof fetch = fetch): Promise<number | null> {
  if (chromePid && Date.now() - chromePid.at < 60_000) return chromePid.pid || null;
  let pid = 0;
  try {
    const version = (await (await request(`${CDP}/json/version`, { signal: AbortSignal.timeout(800) })).json()) as { webSocketDebuggerUrl?: string };
    if (version.webSocketDebuggerUrl) {
      const s = await Session.open(version.webSocketDebuggerUrl);
      try {
        const info = await s.send("SystemInfo.getProcessInfo");
        pid = Number((info?.processInfo as Array<{ type: string; id: number }> | undefined)?.find((p) => p.type === "browser")?.id) || 0;
      } finally {
        s.close();
      }
    }
  } catch {
    pid = 0;
  }
  chromePid = { pid, at: Date.now() };
  return pid || null;
}

class Session {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
  }
  static open(url: string) {
    return new Promise<Session>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("Chrome didn't answer")), 3000);
      ws.onopen = () => (clearTimeout(timer), resolve(new Session(ws)));
      ws.onerror = () => (clearTimeout(timer), reject(new Error("Couldn't reach Jarvis Chrome")));
    });
  }
  send(method: string, params: Record<string, unknown> = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(`${method} timed out`))), 5000);
    });
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || "script error");
    return r?.result?.value as T;
  }
  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

async function click(s: Session, x: number, y: number) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const)
    await s.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
}

const SEARCH_BOX = `(() => {
  const isSearchField = ${isSearchField.toString()};
  const el = [...document.querySelectorAll("input, [role=searchbox]")].find((f) => f.getClientRects().length && isSearchField({
    type: f.getAttribute("type"), role: f.getAttribute("role"), inSearchRegion: !!f.closest("[role=search]"), name: f.getAttribute("name"),
    label: f.getAttribute("aria-label"), placeholder: f.getAttribute("placeholder"),
  }));
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

/** Do one browser action on the tab he is looking at (the most recently active page). */
export async function act(root: string, req: ActRequest, request: typeof fetch = fetch): Promise<ActResult> {
  const started = Date.now();
  const done = (ok: boolean, said: string, page?: string): ActResult => ({ ok, said, ms: Date.now() - started, page });
  if (!BROWSER_ACTIONS.includes(req.action)) return done(false, "I don't know that browser action.");
  if (req.action === "new_tab") {
    const url = req.url && /^https?:\/\//i.test(req.url) ? req.url : "about:blank";
    const ok = await ensureJarvisChrome(root, url === "about:blank" ? "chrome://newtab" : url);
    // "it" / "that tab" in his next sentence is this Jarvis Chrome tab (J-fix).
    if (ok) rememberReferent({ app: "chrome", jarvisChrome: true });
    return done(ok, ok ? "New tab open." : "Jarvis Chrome wouldn't start.");
  }
  if (!(await ensureJarvisChrome(root))) return done(false, "Jarvis Chrome wouldn't start, so nothing was done.");
  const page = (await targets(request))[0];
  if (!page?.webSocketDebuggerUrl) return done(false, "There's no page open in Jarvis Chrome.");
  const s = await Session.open(page.webSocketDebuggerUrl);
  try {
    await s.send("Page.bringToFront");
    switch (req.action) {
      case "pause":
      case "play": {
        const n = await s.eval<number>(`(() => { const v = [...document.querySelectorAll("video")]; v.forEach((x) => ${req.action === "pause" ? "x.pause()" : "x.play()"}); return v.length; })()`);
        return done(n > 0, n > 0 ? (req.action === "pause" ? "Paused." : "Playing.") : "There's no video on this page.", page.title);
      }
      case "back":
      case "forward":
        await s.eval(`history.${req.action}()`);
        return done(true, req.action === "back" ? "Gone back." : "Gone forward.", page.title);
      case "reload":
        await s.send("Page.reload");
        return done(true, "Reloaded.", page.title);
      case "scroll_down":
      case "scroll_up":
        await s.eval(`scrollBy({ top: ${req.action === "scroll_down" ? "" : "-"}innerHeight * 0.8, behavior: "smooth" })`);
        return done(true, req.action === "scroll_down" ? "Scrolled down." : "Scrolled up.", page.title);
      case "close_tab":
        await s.send("Page.close");
        return done(true, "Tab closed.", page.title);
      case "search": {
        const words = (req.text ?? req.target ?? "").trim().slice(0, 200);
        if (!words) return done(false, "Search for what?");
        const box = await s.eval<{ x: number; y: number } | null>(SEARCH_BOX);
        if (!box) return done(false, "I can't find a search box on this page.", page.title);
        await click(s, box.x, box.y);
        await s.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
        await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
        await s.send("Input.insertText", { text: words });
        for (const type of ["rawKeyDown", "char", "keyUp"] as const)
          await s.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "char" ? "\r" : undefined });
        return done(true, `Searched for ${words}.`, page.title);
      }
      case "click": {
        const candidates = await s.eval<Candidate[]>(COLLECT);
        // A final button named in the request is never pressed here, found or not (REVIEW-T1 fix 1).
        const named = finalClickRefusal(null, req.target ?? "");
        if (named) return done(false, named, page.title);
        const hit = pickCandidate(candidates ?? [], req.target ?? "", req.ordinal);
        if (!hit) return done(false, `I can't see ${req.target || "that"} on the page.`, page.title);
        // …nor one the words happened to land on ("the third button" that is "Delete").
        const landed = finalClickRefusal(hit, req.target ?? "");
        if (landed) return done(false, landed, page.title);
        // …nor a Continue or OK on a page with money on it (REVIEW-S2C fix 4: P's money context).
        const around = await s.eval<PageMoneyContext | null>(PAGE_CONTEXT(hit.x, hit.y));
        const money = around ? moneyClickRefusal(hit, around) : null;
        if (money) return done(false, money, page.title);
        await click(s, hit.x, hit.y);
        return done(true, `Clicked ${hit.label ? `"${hit.label.slice(0, 80)}"` : "it"}.`, page.title);
      }
    }
    return done(false, "Nothing was done.");
  } catch (error) {
    return done(false, `That didn't work: ${(error as Error).message}.`, page.title);
  } finally {
    s.close();
  }
}

/**
 * Deterministic routing for plain browser commands, checked before Jev: Jev's lanes predate
 * browser_act and sent "click the first video" / "pause the video" to control_pc (Hermes,
 * ~1 minute). Conservative on purpose: anything that isn't clearly one of these returns null
 * and goes through Jev and the brain as before.
 */
export function browserIntent(utterance: string): ActRequest | null {
  const u = utterance
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/^\s*(?:hey\s+)?jarvis[,\s]+/, "")
    .replace(/^(?:can you|could you|would you|will you|please)\s+/, "")
    .replace(/\s+(?:please|for me|now|jarvis)$/g, "")
    .trim();
  if (u.length > 160) return null;
  // Music/songs go to the media keys (pc-hands), so Spotify pauses too.
  const media = "(?:the\\s+)?(?:video|clip|it|this|that|playback)";
  if (new RegExp(`^(?:pause|stop|hold)(?:\\s+${media})?$`).test(u)) return { action: "pause" };
  if (new RegExp(`^(?:play|resume|unpause|continue)(?:\\s+${media}|\\s+playing)?$`).test(u)) return { action: "play" };
  if (/^(?:go\s+)?back(?:\s+a\s+page)?$/.test(u)) return { action: "back" };
  if (/^(?:go\s+)?forward(?:\s+a\s+page)?$/.test(u)) return { action: "forward" };
  if (/^(?:reload|refresh)(?:\s+(?:the\s+)?page)?$/.test(u)) return { action: "reload" };
  if (/^scroll(?:\s+(?:the\s+page\s+)?down)?$/.test(u)) return { action: "scroll_down" };
  if (/^scroll\s+(?:the\s+page\s+)?up$/.test(u)) return { action: "scroll_up" };
  if (/^close\s+(?:this|the|that)\s+tab$/.test(u)) return { action: "close_tab" };
  if (/^(?:open\s+)?(?:a\s+)?new\s+tab$/.test(u)) return { action: "new_tab" };
  // "click the first video", "navigate to the second video on my screen and click it",
  // "press the third result", "open the last video".
  const ordinal = "(?:first|second|third|fourth|fifth|sixth|last|1st|2nd|3rd|4th|5th)";
  if (new RegExp(`\\b(?:click|press|tap|open|select|play|watch|navigate to|go to)\\b.*\\b${ordinal}\\b.*\\b(?:video|result|clip|link|one)\\b`).test(u))
    return { action: "click", target: u.replace(/\band\s+(?:click|press|open|play)\s+(?:it|that)\b/g, "").trim() };
  // "click sign in", "press the subscribe button" (short, explicit).
  const m = u.match(/^(?:click|press|tap)(?:\s+on)?\s+(.{2,60})$/);
  if (m) return { action: "click", target: m[1] };
  return null;
}

/** Validate a request body from the voice client. */
export function parseActRequest(body: unknown): ActRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = String(b.action ?? "") as BrowserAction;
  if (!BROWSER_ACTIONS.includes(action)) throw new Error(`action must be one of ${BROWSER_ACTIONS.join(", ")}`);
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const ordinal = typeof b.ordinal === "number" && Number.isInteger(b.ordinal) && b.ordinal >= -1 && b.ordinal <= 50 ? b.ordinal : undefined;
  return { action, target: str(b.target, 200), text: str(b.text, 200), url: str(b.url, 2000), ordinal };
}

/** Runs in the page: the whole page's money context (title, address, text, controls). */
const PAGE_WHOLE = `(() => {
  const flat = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const controls = [...document.querySelectorAll("button, [role=button], input, select, a[href]")].slice(0, 200)
    .map((c) => [c.getAttribute("aria-label"), c.getAttribute("name"), c.id, c.getAttribute("autocomplete"), (c.innerText || c.value || "").slice(0, 60)].filter(Boolean).join(" "))
    .filter(Boolean).join("\n").slice(0, 4000);
  return { title: document.title, url: location.href, text: (document.title + "\n" + String(document.body ? document.body.innerText : "")).slice(0, 6000), nearby: "", controls,
    embeds: !!document.querySelector("iframe, canvas"), progress: !!document.querySelector("progress, [role=progressbar]") };
})()`;
/** Two page addresses are the same page when they match without the #fragment. Pure. */
export function samePageUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(String(u ?? "").trim());
      x.hash = "";
      return x.href;
    } catch {
      return String(u ?? "").trim().split("#")[0];
    }
  };
  const na = norm(a);
  return !!na && na === norm(b);
}
/**
 * Which Jarvis Chrome tab a guarded tool acts on (REVIEW S2e: not simply the first tab). With the address the tool's
 * own browser session is on (`pageUrl`, sent by the Hermes plugin), the one tab at that address; without it, the one
 * visible tab. Anything else (no match, two tabs at that address, several or no visible tabs) is null: the guard
 * can't tell which page it is, so it refuses (fail closed). Pure.
 */
export function chooseGuardTarget<T extends { url: string; visible?: boolean }>(tabs: readonly T[], pageUrl?: string | null): T | null {
  if (pageUrl) {
    const hits = tabs.filter((t) => samePageUrl(t.url, pageUrl));
    return hits.length === 1 ? hits[0] : null;
  }
  const shown = tabs.filter((t) => t.visible === true);
  return shown.length === 1 ? shown[0] : null;
}
async function evalOn<T>(target: Target, expression: string): Promise<T | null> {
  if (!target.webSocketDebuggerUrl) return null;
  const s = await Session.open(target.webSocketDebuggerUrl);
  try {
    return (await s.eval<T>(expression)) ?? null;
  } finally {
    s.close();
  }
}
/**
 * The page a Hermes browser tool is about to act on, read over CDP, for the tool guard (scripts/away-mode/tool-
 * guard.ts): the tab at `pageUrl` (the tool's own session's address), else the one visible tab (chooseGuardTarget).
 * Never starts Chrome; null when it isn't running, the tab can't be told apart, or the page can't be read.
 */
export async function currentPageMoneyContext(pageUrl: string | null = null, request: typeof fetch = fetch): Promise<PageMoneyContext | null> {
  try {
    const tabs = await targets(request);
    let chosen: Target | null;
    if (pageUrl) chosen = chooseGuardTarget(tabs, pageUrl);
    else {
      const seen = await Promise.all(
        tabs.slice(0, 20).map(async (t) => ({ ...t, visible: (await evalOn<string>(t, "document.visibilityState").catch(() => null)) === "visible" })),
      );
      chosen = tabs.length > 20 ? null : chooseGuardTarget(seen);
    }
    if (!chosen) return null;
    const page = await evalOn<PageMoneyContext>(chosen, PAGE_WHOLE);
    // The tab must still be on that page when read (it could have navigated in between).
    if (!page || (pageUrl && !samePageUrl(page.url, pageUrl))) return null;
    return page;
  } catch {
    return null;
  }
}
