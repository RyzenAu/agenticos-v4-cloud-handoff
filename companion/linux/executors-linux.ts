import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorResult } from "../../scripts/jarvis-command/contracts";
import { abortableSleep } from "../../scripts/executors/windows";
import type { ExecContext, Executor } from "../executors";
import { CdpSession, MAX_OPEN_TABS, closeTab, ensureBrowser, trimTabs, findChromium, newTab, readPage, screenshot, tabs, browserUp, type CdpConfig, type PageFacts } from "./cdp";
import { PAGE_ELEMENTS_SCRIPT, pageTextScript, type PageElements, type PageText } from "./dom-script";
import { MEASURE_SCROLL_SCRIPT, forceScrollScript, pickScrollScript, type ScrollMeasure, type ScrollPick, type ScrollResult } from "./scroll-script";
import { checkPublicUrl, type Resolver, systemResolver } from "./urlpolicy";
import { createWorkflowExecutors, openOffline, type ViewportBackend } from "./workflow-executors";

/**
 * What a shared cloud computer runs. The SAME companion worker as a PC (wire contract, ledger, cancel, observe-before-retry); only
 * the hands differ. Every executor returns an ExecutorResult whose `verified` is its own read-back, never the hub's guess:
 *
 *   echo, wait, notify           connectivity and cancellation checks
 *   computer.info                what this computer is (no secrets, no paths outside its own folder names)
 *   file.write / file.read / file.list   this computer's own working folder only (jailed); write is verified by reading it back
 *   browser.navigate {url, expectTitle?}   a public http(s) page in this computer's own Chromium; verified by the page's real title
 *   observe.page                 the page in front (title, url), plus a frame's size and hash kept in memory only
 *   input.click / input.type / input.key   a person's takeover input (or a typed agent step), optionally verified with expectTitle/expectUrl
 *   app.open {name}              only "chromium" (its own profile); verified by the DevTools port answering
 *   screen.goal {goal}           the typed-goal contract a PC's screen.goal has (progress per sub-step, verified result), limited to
 *                                goals a rule can plan ("go to <url> and check the title is ..."). An open-ended goal is refused, not guessed:
 *                                a model loop needs provider keys, which a computer never holds (docs/programme-20261001/COMPUTERS-ARCHITECTURE.md)
 *
 * Nothing here writes a screenshot to disk, sends, pays, deletes or publishes, or reaches a private address.
 */

export type BrowserBackend = {
  available(): boolean;
  alive(): Promise<boolean>;
  ensure(): Promise<void>;
  /** Open a new tab at `url`; returns its id. */
  open(url: string): Promise<string>;
  /** The page in front (or `tabId`): its real title and address. Null when there is no page. */
  read(tabId?: string): Promise<(PageFacts & { tabId: string }) | null>;
  frame(tabId?: string, quality?: number): Promise<Uint8Array>;
  /** What could be pressed or typed into on the page in front (labels and positions only). */
  elements?(tabId?: string): Promise<PageElements>;
  /** The readable text of the page (main article if there is one) from `offset`, at most `limit` characters, plus its own links. Read-only. */
  pageText?(offset: number, limit: number, tabId?: string): Promise<PageText>;
  scroll?(dy: number, tabId?: string): Promise<void>;
  /** How far the page in front is scrolled and how far it can go (pixels): lets a scroll be checked by what the page did. */
  scrollState?(tabId?: string): Promise<{ y: number; max: number }>;
  /**
   * Scroll whatever actually scrolls (modal, inner panel, virtualised list or the document) by `dy` and say what happened by measurement.
   * Bound to ONE tab for the whole operation: a named tab that is gone is an error, never "the neighbouring tab".
   */
  scrollContainer?(dy: number, tabId?: string): Promise<ScrollResult>;
  click(x: number, y: number, tabId?: string): Promise<void>;
  type(text: string, tabId?: string): Promise<void>;
  key(name: string, tabId?: string): Promise<void>;
  /** Navigate a tab to about:blank (used when a redirect landed somewhere it shouldn't). */
  blank(tabId: string): Promise<void>;
  /** Workflows (website audit, builder preview): a screen size for one tab, a read of the page as one JSON string, and a page from this computer's own working folder. */
  setViewport?(width: number, height: number, mobile: boolean, tabId?: string): Promise<void>;
  clearViewport?(tabId?: string): Promise<void>;
  evalJson?(script: string, tabId?: string): Promise<string>;
  openFile?(url: string): Promise<string>;
  close?(): Promise<void>;
};

export type LinuxExecutorOptions = {
  name: string;
  workdir: string;
  display?: string;
  resolution?: string;
  browser?: BrowserBackend;
  resolve?: Resolver;
  /** Steady-read timing (tests shorten it). */
  settleMs?: number;
  pageTimeoutMs?: number;
  /** A page whose DOM is ready ("interactive") with a real title that has not changed for this long counts as opened even if its `load` event never fires (default 2000 ms). */
  interactiveStableMs?: number;
};

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FILE = 256 * 1024;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const refused = (said: string, data: Record<string, unknown> = {}): ExecutorResult => ({ ok: false, said, verified: false, data: { refused: true, ...data } });

export function liveBrowserBackend(cfg: CdpConfig, log: (line: string) => void = () => undefined): BrowserBackend {
  const sessions = new Map<string, CdpSession>();
  let last: string | null = null;
  const session = async (tabId?: string, strict = false): Promise<{ s: CdpSession; id: string } | null> => {
    const list = await tabs(cfg.port).catch(() => []);
    if (strict && tabId && !list.some((t) => t.id === tabId)) throw new Error("That tab is closed, so nothing was done.");
    // Chromium lists the most recently used tab first; the initial about:blank tab is last.
    const id = tabId && list.some((t) => t.id === tabId) ? tabId : last && list.some((t) => t.id === last) ? last : list[0]?.id;
    const tab = list.find((t) => t.id === id);
    if (!tab?.webSocketDebuggerUrl) return null;
    let s = sessions.get(tab.id);
    if (!s) sessions.set(tab.id, (s = await CdpSession.connect(tab.webSocketDebuggerUrl)));
    return { s, id: tab.id };
  };
  return {
    available: () => !!(cfg.chromiumPath ?? findChromium()),
    alive: () => browserUp(cfg.port),
    ensure: () => ensureBrowser(cfg, log),
    async open(url) {
      await ensureBrowser(cfg, log);
      const t = await newTab(cfg.port, url);
      last = t.id;
      // Old pages are closed (their sessions with them): one per navigation, kept forever, was a memory leak.
      const closed = await trimTabs(cfg.port, MAX_OPEN_TABS, t.id).catch(() => [] as string[]);
      for (const id of closed) {
        sessions.get(id)?.close();
        sessions.delete(id);
      }
      return t.id;
    },
    async read(tabId) {
      const c = await session(tabId);
      return c ? { ...(await readPage(c.s)), tabId: c.id } : null;
    },
    async frame(tabId, quality) {
      const c = await session(tabId);
      if (!c) throw new Error("There is no page open.");
      return screenshot(c.s, quality);
    },
    async elements(tabId) {
      const c = await session(tabId);
      if (!c) throw new Error("There is no page open.");
      return JSON.parse(await c.s.evaluate<string>(PAGE_ELEMENTS_SCRIPT)) as PageElements;
    },
    async pageText(offset, limit, tabId) {
      const c = await session(tabId, true);
      if (!c) throw new Error("There is no page open.");
      return JSON.parse(await c.s.evaluate<string>(pageTextScript(offset, limit))) as PageText;
    },
    async scroll(dy, tabId) {
      const c = await session(tabId);
      if (!c) throw new Error("There is no page open.");
      await c.s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200, deltaX: 0, deltaY: dy });
    },
    async scrollState(tabId) {
      const c = await session(tabId);
      if (!c) throw new Error("There is no page open.");
      const o = JSON.parse(await c.s.evaluate<string>("JSON.stringify({y:Math.round(window.scrollY),max:Math.max(0,Math.round(document.documentElement.scrollHeight-window.innerHeight))})")) as { y: number; max: number };
      return o;
    },
    async scrollContainer(dy, tabId) {
      const c = await session(tabId, true);
      if (!c) throw new Error("There is no page open.");
      const measure = async () => JSON.parse(await c.s.evaluate<string>(MEASURE_SCROLL_SCRIPT)) as ScrollMeasure;
      const pick = JSON.parse(await c.s.evaluate<string>(pickScrollScript(dy))) as ScrollPick;
      if (pick.kind === "none") return { kind: "none" };
      if (pick.kind === "edge") return { kind: "edge", container: pick.container, at: pick.top, max: pick.max, modal: pick.modal };
      const sign = Math.sign(dy);
      const settle = async (first: ScrollMeasure, quietMs: number) => {
        // Smooth scrolling keeps moving for a while: wait until it changed AND stopped (two equal reads), at most about 1.5 s.
        let prev = first;
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, i === 0 ? quietMs : 120));
          const now = await measure();
          if ("lost" in now) return now;
          if (!("lost" in prev) && now.top === prev.top && now.top !== pick.top) return now;
          if (!("lost" in prev) && now.top === prev.top && i >= 2) return now; // never moved
          prev = now;
        }
        return prev;
      };
      await c.s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pick.x, y: pick.y, deltaX: 0, deltaY: 0 });
      await c.s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: pick.x, y: pick.y, deltaX: 0, deltaY: dy });
      let after = await settle({ top: pick.top, max: pick.max }, 120);
      let via: "wheel" | "script" = "wheel";
      if (!("lost" in after) && Math.sign(after.top - pick.top) !== sign) {
        // The wheel did nothing (something covered the container, or the page swallows wheel events): move the same container by script.
        after = JSON.parse(await c.s.evaluate<string>(forceScrollScript(dy))) as ScrollMeasure;
        if (!("lost" in after)) after = await settle(after, 60);
        via = "script";
      }
      if ("lost" in after) return { kind: "lost", container: pick.container };
      if (Math.sign(after.top - pick.top) === sign) return { kind: "moved", container: pick.container, before: pick.top, after: after.top, max: after.max, via, modal: pick.modal };
      return { kind: "stuck", container: pick.container, before: pick.top, after: after.top, max: after.max, modal: pick.modal };
    },
    async click(x, y, tabId) {
      const c = await session(tabId);
      if (!c) throw new Error("There is no page open.");
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await c.s.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    },
    async type(text, tabId) {
      const c = await session(tabId);
      if (!c) throw new Error("There is no page open.");
      await c.s.send("Input.insertText", { text });
    },
    async key(name, tabId) {
      const c = await session(tabId);
      if (!c) throw new Error("There is no page open.");
      const codes: Record<string, number> = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, PageDown: 34, PageUp: 33, Home: 36, End: 35, Space: 32 };
      const code = codes[name];
      if (!code) throw new Error("That key isn't one of the supported keys.");
      const base = { key: name === "Space" ? " " : name, code: name, windowsVirtualKeyCode: code, ...(name === "Enter" ? { text: "\r" } : {}) };
      await c.s.send("Input.dispatchKeyEvent", { type: name === "Enter" ? "keyDown" : "rawKeyDown", ...base });
      await c.s.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async setViewport(width, height, mobile, tabId) {
      const c = await session(tabId, true);
      if (!c) throw new Error("There is no page open.");
      await c.s.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    },
    async clearViewport(tabId) {
      const c = await session(tabId);
      if (c) await c.s.send("Emulation.clearDeviceMetricsOverride");
    },
    async evalJson(script, tabId) {
      const c = await session(tabId, true);
      if (!c) throw new Error("There is no page open.");
      return c.s.evaluate<string>(script);
    },
    async openFile(url) {
      await ensureBrowser(cfg, log);
      // A page from this computer's own folder (a fixture, a builder's preview) is loaded with the network blocked first: it is code a model wrote.
      const t = await newTab(cfg.port, "about:blank");
      last = t.id;
      const tab = (await tabs(cfg.port)).find((x) => x.id === t.id);
      if (!tab?.webSocketDebuggerUrl) throw new Error("The new tab cannot be controlled.");
      const s = await CdpSession.connect(tab.webSocketDebuggerUrl);
      sessions.set(t.id, s);
      await openOffline(s, url);
      const closed = await trimTabs(cfg.port, MAX_OPEN_TABS, t.id).catch(() => [] as string[]);
      for (const id of closed) {
        sessions.get(id)?.close();
        sessions.delete(id);
      }
      return t.id;
    },
    async blank(tabId) {
      const c = await session(tabId);
      if (c) await c.s.send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
      void closeTab;
    },
    async close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}

function hostOk(requested: URL, landed: string): boolean {
  try {
    const a = requested.hostname.replace(/^www\./, "");
    const b = new URL(landed).hostname.replace(/^www\./, "");
    return b === a || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
  } catch {
    return false;
  }
}

export function createLinuxExecutors(opts: LinuxExecutorOptions): Record<string, Executor> {
  mkdirSync(opts.workdir, { recursive: true });
  const browser = opts.browser;
  const resolve = opts.resolve ?? systemResolver;
  const settleMs = opts.settleMs ?? 400;
  const pageTimeoutMs = opts.pageTimeoutMs ?? 25_000;
  const interactiveStableMs = opts.interactiveStableMs ?? 2_000;
  const hasBrowser = !!browser?.available();

  const navigate = async (args: Record<string, unknown>, ctx: ExecContext): Promise<ExecutorResult> => {
    if (!browser || !hasBrowser) return refused("This computer has no browser installed (its host is missing chromium), so nothing was opened.");
    const verdict = await checkPublicUrl(args.url, resolve);
    if (!verdict.ok) return refused(verdict.reason);
    const expect = typeof args.expectTitle === "string" ? args.expectTitle.trim().slice(0, 120) : "";
    const tab = await browser.open(verdict.url.href);
    const deadline = Date.now() + pageTimeoutMs;
    let prev = "";
    let stableMs = 0;
    let facts: (PageFacts & { tabId: string }) | null = null;
    // Steady on two reads, complete, with a real title: the address shown while loading is not the page.
    // Pages with analytics or long-polling requests that never settle (found on the LAN host, where the owner's DNS filter sinks tracker hosts to
    // 127.0.0.1 and those requests hang) never fire `load`: DOM ready ("interactive") with the same title and address for interactiveStableMs is enough,
    // and the result says the page was still loading in the background.
    while (Date.now() < deadline && !ctx.signal.aborted) {
      await abortableSleep(settleMs, ctx.signal);
      facts = await browser.read(tab).catch(() => null);
      const sig = facts ? `${facts.ready}|${facts.url}|${facts.title}` : "";
      stableMs = sig && sig === prev ? stableMs + settleMs : 0;
      if (facts && facts.title && sig === prev && (facts.ready === "complete" || (facts.ready === "interactive" && stableMs >= interactiveStableMs))) break;
      prev = sig;
    }
    if (ctx.signal.aborted) return { ok: false, said: "Stopped.", verified: false, data: { cancelled: true } };
    if (!facts) return { ok: false, said: "The page didn't open.", verified: false };
    // A redirect (or DNS that changed after the check) must not have landed somewhere private.
    const landed = await checkPublicUrl(facts.url === "about:blank" ? "https://example.invalid/" : facts.url, resolve);
    if (facts.url !== "about:blank" && !landed.ok && !/Couldn't find/.test(landed.reason)) {
      await browser.blank(tab).catch(() => undefined);
      return refused(`The page redirected somewhere it shouldn't (${landed.reason}); I closed it.`);
    }
    const matchesHost = hostOk(verdict.url, facts.url);
    const titleOk = expect ? facts.title.toLowerCase().includes(expect.toLowerCase()) : facts.title.length > 0;
    const loaded = facts.ready === "complete";
    const usable = loaded || (facts.ready === "interactive" && !!facts.title && stableMs >= interactiveStableMs);
    const verified = usable && matchesHost && titleOk;
    return {
      ok: verified,
      said: verified ? `Opened ${verdict.url.hostname}: the page title reads "${facts.title.slice(0, 80)}".${loaded ? "" : " (The page was still loading background requests, such as analytics, that never finished; its text is there.)"}` : /^chrome-error:/.test(facts.url) ? `${verdict.url.hostname} didn't load: the browser shows a network error (the site refused this computer or didn't answer).` : !matchesHost ? `The page ended up at ${safeHost(facts.url)}, not ${verdict.url.hostname}.` : expect ? `The page title is "${facts.title.slice(0, 80)}", not what was expected ("${expect}").` : "The page didn't finish loading.",
      verified,
      evidence: `${facts.ready}; title "${facts.title.slice(0, 80)}"; ${safeHost(facts.url)}`,
      data: { title: facts.title.slice(0, 200), url: safeUrl(facts.url), tabId: facts.tabId, ...(loaded ? {} : { stillLoading: true }) },
    };
  };

  const observe: Executor = async (args, ctx) => {
    if (!browser || !hasBrowser) return refused("This computer has no browser installed, so there's no page to read.");
    if (!(await browser.alive())) return { ok: false, said: "No page is open on this computer.", verified: false };
    const facts = await browser.read().catch(() => null);
    if (!facts) return { ok: false, said: "No page is open on this computer.", verified: false };
    let frame = { bytes: 0, sha256: "" };
    if (!ctx.signal.aborted) {
      const shot = await browser.frame(facts.tabId).catch(() => null);
      if (shot) frame = { bytes: shot.length, sha256: sha(shot).slice(0, 16) }; // in memory only; never written out
    }
    // With elements:true, also what could be pressed or typed into (for the hub's goal loop): labels and positions, never a password's value.
    const dom = args.elements === true && browser.elements ? await browser.elements(facts.tabId).catch(() => null) : null;
    return { ok: true, said: `Page: "${facts.title.slice(0, 80)}" at ${safeHost(facts.url)}.`, verified: true, evidence: `${facts.ready}; frame ${frame.bytes} bytes${dom ? `; ${dom.elements.length} controls` : ""}`, data: { title: facts.title.slice(0, 200), url: safeUrl(facts.url), frame, ...(dom ? { viewport: { w: dom.w, h: dom.h }, elements: dom.elements } : {}) } };
  };

  /** Read the page back after an input, when the caller said what it expects. */
  const afterInput = async (args: Record<string, unknown>, said: string): Promise<ExecutorResult> => {
    const wantTitle = typeof args.expectTitle === "string" ? args.expectTitle : "";
    const wantUrl = typeof args.expectUrl === "string" ? args.expectUrl : "";
    if (!wantTitle && !wantUrl) return { ok: true, said: `${said} (sent; not checked).`, verified: null };
    await new Promise((r) => setTimeout(r, 300));
    const facts = await browser!.read().catch(() => null);
    const ok = !!facts && (!wantTitle || facts.title.toLowerCase().includes(wantTitle.toLowerCase())) && (!wantUrl || facts.url.includes(wantUrl));
    return { ok, said: ok ? `${said}; the page now reads "${facts!.title.slice(0, 60)}".` : `${said}, but the page doesn't read as expected.`, verified: ok, ...(facts ? { evidence: `title "${facts.title.slice(0, 60)}"; ${safeHost(facts.url)}` } : {}) };
  };

  const needBrowser = () => (!browser || !hasBrowser ? refused("This computer has no browser installed, so there is nothing to click or type into.") : null);

  const executors: Record<string, Executor> = {
    echo: async (args) => ({ ok: true, said: "Echoed.", verified: true, data: { echoed: String(args.text ?? "").slice(0, 500) } }),
    notify: async (args, ctx) => {
      ctx.log(`[notify] ${String(args.text ?? "").slice(0, 300)}`);
      return { ok: true, said: "Shown in the computer's log.", verified: null };
    },
    wait: async (args, ctx) => {
      const ms = Math.max(0, Math.min(Number(args.ms) || 0, 60_000));
      await abortableSleep(ms, ctx.signal);
      return { ok: true, said: `Waited ${ms} ms.`, verified: true, data: { waited: ms } };
    },
    "computer.info": async () => ({
      ok: true,
      said: `${opts.name}: ${opts.display ? `desktop ${opts.display} ${opts.resolution ?? ""}`.trim() : "headless"}, ${hasBrowser ? "browser installed" : "no browser installed"}.`,
      verified: true,
      data: { name: opts.name, desktop: !!opts.display, browser: hasBrowser, resolution: opts.resolution ?? null, platform: process.platform, pid: process.pid },
    }),
    "file.write": async (args) => {
      const name = String(args.name ?? "");
      if (!FILE_NAME.test(name)) return refused("A file name is letters, digits, dots, dashes and underscores (no folders).");
      const text = String(args.text ?? "");
      if (Buffer.byteLength(text) > MAX_FILE) return refused("That file is too large for this computer's working folder.");
      const path = join(opts.workdir, name);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, path);
      const back = readFileSync(path, "utf8");
      const ok = sha(back) === sha(text);
      return { ok, said: ok ? `Wrote ${name} (${Buffer.byteLength(text)} bytes) and read it back.` : `Wrote ${name} but the read-back differs.`, verified: ok, evidence: `sha256 ${sha(back).slice(0, 12)}`, data: { name, bytes: Buffer.byteLength(text), sha256: sha(back).slice(0, 16) } };
    },
    "file.read": async (args) => {
      const name = String(args.name ?? "");
      if (!FILE_NAME.test(name)) return refused("A file name is letters, digits, dots, dashes and underscores (no folders).");
      const path = join(opts.workdir, name);
      if (!existsSync(path) || statSync(path).size > MAX_FILE) return { ok: false, said: `${name} isn't in this computer's working folder.`, verified: false };
      const text = readFileSync(path, "utf8");
      return { ok: true, said: `Read ${name} (${Buffer.byteLength(text)} bytes).`, verified: true, data: { name, text: text.slice(0, 4000), sha256: sha(text).slice(0, 16) } };
    },
    "file.list": async () => {
      const names = readdirSync(opts.workdir).filter((f) => FILE_NAME.test(f) && !f.endsWith(".tmp")).slice(0, 100);
      return { ok: true, said: `${names.length} file${names.length === 1 ? "" : "s"} in the working folder.`, verified: true, data: { names } };
    },
  };

  if (hasBrowser && browser) {
    executors["browser.navigate"] = navigate;
    executors["observe.page"] = observe;
    executors["app.open"] = async (args) => {
      if (String(args.name ?? "").toLowerCase() !== "chromium") return refused('This computer opens only "chromium".');
      await browser.ensure();
      const up = await browser.alive();
      return { ok: up, said: up ? "Chromium is open on this computer's own profile." : "Chromium didn't start.", verified: up, evidence: "DevTools port answered" };
    };
    executors["input.click"] = async (args) => {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10_000 || y > 10_000) return refused("A click needs x and y inside the screen.");
      const gone = needBrowser();
      if (gone) return gone;
      await browser.click(x, y);
      return afterInput(args, `Clicked at ${Math.round(x)},${Math.round(y)}`);
    };
    if (browser.pageText) {
      // Research reading: the page's own words (never a field's value), in chunks, with its links. The hub's reader cites only what it can find here.
      executors["page.text"] = async (args) => {
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const limit = Math.max(200, Math.min(12_000, Math.floor(Number(args.limit) || 6_000)));
        const tab = typeof args.tabId === "string" && args.tabId ? args.tabId : undefined;
        let t;
        try {
          t = await browser.pageText!(offset, limit, tab);
        } catch (e) {
          return { ok: false, said: e instanceof Error ? e.message.slice(0, 160) : "The page couldn't be read.", verified: false };
        }
        // The page may have settled and then moved itself (script, meta refresh) somewhere private: the address it is AT now is checked again, and
        // nothing it said is returned if that address is not a public one.
        const here = await checkPublicUrl(t.url, resolve);
        if (!here.ok) return refused(`The page in front is at an address this computer won't read (${here.reason}), so nothing was returned.`);
        const empty = t.total === 0;
        return {
          ok: !empty, said: empty ? `"${t.title.slice(0, 60)}" has no readable text.` : `Read ${t.text.length} of ${t.total} characters of "${t.title.slice(0, 60)}" at ${safeHost(t.url)}.`, verified: !empty,
          evidence: `${t.total} characters; ${t.links.length} links`,
          data: { title: t.title.slice(0, 200), url: safeUrl(t.url), total: t.total, offset: t.offset, text: t.text, links: t.links.slice(0, 40) },
        };
      };
    }
    executors["input.scroll"] = async (args) => {
      const dy = Number(args.dy);
      if (!Number.isFinite(dy) || Math.abs(dy) > 5000 || !browser.scroll) return refused("A scroll is between -5000 and 5000 pixels.");
      const dir = dy > 0 ? "down" : "up";
      if (browser.scrollContainer) {
        const tab = typeof args.tabId === "string" && args.tabId ? args.tabId : undefined;
        let r: ScrollResult;
        try {
          r = await browser.scrollContainer(dy, tab);
        } catch (e) {
          return { ok: false, said: e instanceof Error ? e.message.slice(0, 160) : "The page couldn't be scrolled.", verified: false };
        }
        const where = (c: string | null, modal: boolean) => (c && c !== "the page" ? `${modal ? "the dialog's " : ""}${c}` : modal ? "the dialog" : "the page");
        if (r.kind === "moved") return { ok: true, said: `Scrolled ${dir} ${Math.abs(r.after - r.before)} px in ${where(r.container, r.modal)}.`, verified: true, evidence: `${r.container} scrollTop ${r.before} to ${r.after} of ${r.max} (${r.via})`, data: { container: r.container, before: r.before, after: r.after, max: r.max, via: r.via } };
        if (r.kind === "edge") return { ok: true, said: `Already at the ${dy > 0 ? "bottom" : "top"} of ${where(r.container, r.modal)}.`, verified: true, evidence: `${r.container ?? "page"} scrollTop ${r.at} of ${r.max}; nothing else can scroll ${dir}`, data: { boundary: true, container: r.container } };
        if (r.kind === "none") return { ok: true, said: "Nothing on this page scrolls (it fits the window).", verified: true, evidence: "no scrollable container", data: { boundary: true, container: null } };
        if (r.kind === "lost") return { ok: false, said: `The page changed under the scroll (${r.container} was replaced), so I can't say whether it moved.`, verified: false, evidence: "container detached" };
        return { ok: false, said: `The page did not scroll ${dir}.`, verified: false, evidence: `${r.container} scrollTop ${r.before} to ${r.after} of ${r.max}; wheel and script both tried` };
      }
      if (!browser.scrollState) {
        await browser.scroll(dy);
        return afterInput(args, `Scrolled ${dir}`);
      }
      // Checked by what the page did: it moved the way asked, or it was already at that edge. (An unchecked scroll made every job step "unknown", so a
      // job that scrolled even once could never succeed: 298 failed steps in the round-3b four-computer run.)
      const before = await browser.scrollState().catch(() => null);
      await browser.scroll(dy);
      // Pages scroll smoothly: wait (up to 1.5 s) for the position to settle on a new value.
      let after = await browser.scrollState().catch(() => null);
      for (let i = 0; i < 10 && before && after && after.y === before.y; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 100 : 150));
        after = await browser.scrollState().catch(() => null);
      }
      if (!before || !after) return afterInput(args, `Scrolled ${dir}`);
      const moved = after.y - before.y;
      const atEdge = dy > 0 ? before.y >= before.max - 1 : before.y <= 0;
      if (moved !== 0 && Math.sign(moved) === Math.sign(dy)) return { ok: true, said: `Scrolled ${dir} ${Math.abs(moved)} px.`, verified: true, evidence: `scrollY ${before.y} to ${after.y} of ${after.max}` };
      if (atEdge) return { ok: true, said: `Already at the ${dy > 0 ? "bottom" : "top"} of the page.`, verified: true, evidence: `scrollY ${after.y} of ${after.max}` };
      return { ok: false, said: `The page did not scroll ${dir}.`, verified: false, evidence: `scrollY ${before.y} to ${after.y} of ${after.max}` };
    };
    executors["input.type"] = async (args) => {
      const text = String(args.text ?? "");
      if (!text || text.length > 2000) return refused("Type between 1 and 2000 characters.");
      await browser.type(text);
      return afterInput(args, `Typed ${text.length} characters`);
    };
    executors["input.key"] = async (args) => {
      const key = String(args.key ?? "");
      await browser.key(key);
      return afterInput(args, `Pressed ${key}`);
    };
  }

  executors["screen.goal"] = async (args, ctx) => {
    const goal = String(args.goal ?? "").trim().slice(0, 600);
    if (!goal) return refused("Which goal? Say what to do on this computer.");
    const m = /^(?:please\s+)?(?:go to|open|navigate to|visit)\s+(\S+?)(?:\s+and\s+(?:check|confirm|verify|make sure)\s+(?:that\s+)?the\s+title\s+(?:is|contains|has|reads)\s+["“']?(.+?)["”']?)?[.!]?$/i.exec(goal);
    if (!m) return refused("On a cloud computer I can plan 'go to <address> and check the title is <text>'. An open-ended goal needs a typed plan of steps; nothing was done.", { needsPlan: true });
    const url = /^[a-z]+:\/\//i.test(m[1]) ? m[1] : `https://${m[1]}`;
    const step = (intent: string, outcome: "ok" | "failed" | "note", verified?: boolean | null) => ctx.progress?.({ intent, executor: "screen.goal", outcome, ms: 0, ...(verified !== undefined ? { verification: { method: "goal-check", ok: verified } } : {}) });
    step(`plan: open ${url}${m[2] ? ` and check the title reads "${m[2]}"` : ""}`, "note");
    const r = await navigate({ url, ...(m[2] ? { expectTitle: m[2] } : {}) }, ctx);
    step(`act: browser.navigate: ${r.said}`, r.ok ? "ok" : "failed", r.verified);
    return { ...r, data: { ...(r.data ?? {}), kind: "goal" } };
  };

  // Workflows: the Builder's git workspace, local fixtures, the website audit's read and screenshots, link status, chunked file reads.
  const vb: ViewportBackend | null = browser?.setViewport && browser.clearViewport && browser.evalJson && browser.openFile ? { setViewport: browser.setViewport.bind(browser), clearViewport: browser.clearViewport.bind(browser), evalJson: browser.evalJson.bind(browser), openFile: browser.openFile.bind(browser), read: browser.read.bind(browser), frame: browser.frame.bind(browser) } : null;
  Object.assign(executors, createWorkflowExecutors({ workdir: opts.workdir, browser: hasBrowser ? vb : null, resolve }));

  return executors;
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "an unknown address";
  }
}
function safeUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return "";
  }
}

export { findChromium };
