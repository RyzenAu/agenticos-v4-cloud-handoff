import { describe, expect, test } from "bun:test";
import { createDesktopExecutors, realTitle, type BrowserDeps, type BrowserHandsLike, type BrowserTab } from "./desktop";
import { abortableSleep, createWindowsExecutors, type WindowsDeps, type WinInfo } from "./windows";

// SYNTHETIC: a fake Windows desktop and a fake browser. No real window, Chrome, CDP or network.

class Desktop {
  windows: WinInfo[] = [];
  front: WinInfo | null = null;
  next = 100;
  started: string[] = [];
  focused: number[] = [];
  /** Windows refuses to bring it forward (foreground lock). */
  focusBlocked = false;
  /** Launching chrome.exe makes no window. */
  nothingOpens = false;
  deps(): WindowsDeps {
    return {
      platform: "win32",
      roots: [],
      windows: async () => this.windows.map((w) => ({ ...w })),
      foreground: async () => (this.front ? { ...this.front } : null),
      startApp: async (exe) => {
        this.started.push(exe);
        if (this.nothingOpens) return;
        const process = exe.replace(/\.exe$/i, "");
        const w: WinInfo = { handle: this.next++, process, cls: "Chrome_WidgetWin_1", title: "New Tab - Google Chrome" };
        this.windows.unshift(w);
      },
      shellOpen: async () => undefined,
      focus: async (handle) => {
        this.focused.push(handle);
        if (!this.focusBlocked) this.front = this.windows.find((w) => w.handle === handle) ?? null;
        return true;
      },
      keys: async () => undefined,
      typeText: async () => undefined,
      editorText: async () => null,
      runPs: async () => ({ code: 0, stdout: "", stderr: "" }),
      sleep: (ms, signal) => abortableSleep(Math.min(ms, 3), signal),
      timing: { appWaitMs: 200, pollMs: 5, settleMs: 1, urlWaitMs: 50, fileWaitMs: 50 },
    };
  }
}

class Browser implements BrowserDeps {
  port = 9333;
  listening = false;
  installed = true;
  tabs: BrowserTab[] = [{ targetId: "AAAA1111", title: "Existing", url: "https://existing.example/", active: true }];
  opened: string[] = [];
  started: string[] = [];
  /** What opening a URL makes of the new tab's title ("" = still loading forever). */
  titleFor: (url: string) => string = () => "Example Domain";
  /** The url the tab ends at (a redirect). */
  finalUrl: (url: string) => string = (u) => u;
  startWorks = true;
  openOk = true;
  /** While > 0, each tabs() read counts down and the new tab still shows its address as its title (as Chrome does while loading). */
  loadingReads = 0;
  private stale = new Map<string, string>();
  async hands(): Promise<BrowserHandsLike | null> {
    if (!this.installed) return null;
    return {
      // Like agent-browser's tab list: a tab keeps the title it had when it was created (the address), so this list
      // never proves a page loaded. Only read() is live.
      tabs: async () => this.tabs.map((t) => ({ ...t, title: this.stale.get(t.targetId) ?? t.title })),
      read: async () => {
        if (this.loadingReads > 0) this.loadingReads--;
        const t = this.tabs.find((x) => x.active);
        if (!t) return { ok: false, title: "", url: "" };
        return { ok: true, title: this.loadingReads > 0 ? new URL(t.url).hostname : t.title, url: t.url };
      },
      open: async (url, where = "new-tab") => {
        this.opened.push(`${where}:${url}`);
        if (!this.openOk) return { ok: false, said: "The browser didn't open it: boom." };
        if (where === "this-tab") {
          const t = this.tabs.find((x) => x.active)!;
          t.url = this.finalUrl(url);
          t.title = this.titleFor(url);
          return { ok: true, said: "Opened.", targetId: t.targetId, url: t.url };
        }
        const t: BrowserTab = { targetId: `T${this.tabs.length}BBBB`, title: this.titleFor(url), url: this.finalUrl(url), active: true };
        this.stale.set(t.targetId, new URL(url).hostname);
        for (const x of this.tabs) x.active = false;
        this.tabs.push(t);
        return { ok: true, said: "Opened.", targetId: t.targetId, url: t.url };
      },
    };
  }
  async up() {
    return this.listening;
  }
  async start(url: string) {
    this.started.push(url);
    if (this.startWorks) this.listening = true;
    return this.startWorks;
  }
}

function rig() {
  const pc = new Desktop();
  const browser = new Browser();
  const deps = pc.deps();
  const shared = createWindowsExecutors(deps);
  const ex = createDesktopExecutors(deps, browser, shared, { focusWaitMs: 60, pollMs: 5, pageWaitMs: 60 });
  const ctx = () => ({ signal: new AbortController().signal });
  return { pc, browser, ex, ctx };
}

describe("app.focus: the app's window must be the foreground window, process and handle read back", () => {
  test("a running app is focused and confirmed in front, with its process and handle", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 7, process: "chrome", cls: "Chrome_WidgetWin_1", title: "Inbox - Chrome" }, { handle: 8, process: "notepad", cls: "Notepad", title: "Untitled - Notepad" }];
    pc.front = pc.windows[1];
    const r = await ex["app.focus"]({ name: "chrome" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { app: "chrome", handle: 7, process: "chrome", foreground: true, launched: false } });
    expect(r.evidence).toContain("window 7");
    expect(pc.focused).toEqual([7]);
    expect(pc.started).toEqual([]); // never launched a second one
  });
  test("a stopped app is launched (a NEW window), then focused and confirmed", async () => {
    const { pc, ex, ctx } = rig();
    const r = await ex["app.focus"]({ name: "Google Chrome" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { app: "chrome", process: "chrome", foreground: true, launched: true } });
    expect(pc.started).toEqual(["chrome.exe"]);
    expect(pc.windows).toHaveLength(1);
  });
  test("Windows won't bring it forward: honest failure naming what IS in front, never 'done'", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Chrome" }, { handle: 8, process: "notepad", cls: "Notepad", title: "Untitled - Notepad" }];
    pc.front = pc.windows[1];
    pc.focusBlocked = true;
    const r = await ex["app.focus"]({ name: "chrome" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false, data: { foreground: false } });
    expect(r.said).toContain("notepad is in front instead");
  });
  test("launched but no window appeared: fails, not 'done'", async () => {
    const { pc, ex, ctx } = rig();
    pc.nothingOpens = true;
    const r = await ex["app.focus"]({ name: "chrome" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
  });
  test("an app off the allow-list is refused and nothing is touched", async () => {
    const { pc, ex, ctx } = rig();
    const r = await ex["app.focus"]({ name: "regedit" }, ctx());
    expect(r).toMatchObject({ ok: false, data: { refused: true } });
    expect(pc.focused).toEqual([]);
    expect(pc.started).toEqual([]);
  });
  test("a cancel stops it: 'Stopped.', nothing more done", async () => {
    const { pc, ex } = rig();
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Chrome" }];
    const c = new AbortController();
    c.abort();
    expect(await ex["app.focus"]({ name: "chrome" }, { signal: c.signal })).toMatchObject({ ok: false, data: { cancelled: true } });
    expect(pc.focused).toEqual([]);
  });
});

describe("browser.navigate: the tab must really be at the site, titled, and changed", () => {
  test("a new tab at example.com is confirmed by its own title and address", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    const r = await ex["browser.navigate"]({ url: "https://example.com/" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { title: "Example Domain", finalUrl: "https://example.com/", newTab: true, where: "new-tab" } });
    expect(r.evidence).toContain("Example Domain");
    expect(browser.opened).toEqual(["new-tab:https://example.com/"]);
    expect(browser.started).toEqual([]); // it was already listening
  });
  test("the browser isn't running: it is started, then the page is opened and confirmed", async () => {
    const { browser, ex, ctx } = rig();
    const r = await ex["browser.navigate"]({ url: "https://example.com/" }, ctx());
    expect(r.verified).toBe(true);
    expect(browser.started).toEqual(["https://example.com/"]);
  });
  test("the browser won't start: honest failure, nothing opened", async () => {
    const { browser, ex, ctx } = rig();
    browser.startWorks = false;
    const r = await ex["browser.navigate"]({ url: "https://example.com/" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("wouldn't start");
    expect(browser.opened).toEqual([]);
  });
  test("agent-browser missing: says so, nothing opened", async () => {
    const { browser, ex, ctx } = rig();
    browser.installed = false;
    expect(await ex["browser.navigate"]({ url: "https://example.com/" }, ctx())).toMatchObject({ ok: false, verified: false });
  });
  test("the tab never gets a title: not confirmed (never 'done' on the open alone)", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    browser.titleFor = () => "";
    const r = await ex["browser.navigate"]({ url: "https://example.com/" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
  });
  test("while the page is still loading its title is just the address: that is not confirmation; the real title is", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    browser.loadingReads = 4;
    const r = await ex["browser.navigate"]({ url: "https://example.com/" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { title: "Example Domain" } });
  });
  test("a page that never gets past its address as a title is not confirmed", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    browser.titleFor = () => "example.com";
    expect(await ex["browser.navigate"]({ url: "https://example.com/" }, ctx())).toMatchObject({ ok: false, verified: false });
  });
  test("realTitle: a loading placeholder is not the page's title", () => {
    for (const t of ["Loading", "Loading...", "Please wait", "Just a moment...", "Redirecting…"]) expect(realTitle(t, "https://example.com/")).toBe(false);
    expect(realTitle("Loading dock safety guide", "https://example.com/")).toBe(true);
  });
  test("realTitle: the address, its host, blank or empty are not page titles", () => {
    expect(realTitle("example.com", "https://example.com/")).toBe(false);
    expect(realTitle("https://example.com/", "https://example.com/")).toBe(false);
    expect(realTitle("www.example.com/docs", "https://www.example.com/docs")).toBe(false);
    expect(realTitle("about:blank", "https://example.com/")).toBe(false);
    expect(realTitle("", "https://example.com/")).toBe(false);
    expect(realTitle("Example Domain", "https://example.com/")).toBe(true);
    expect(realTitle("Docs | Example", "https://example.com/docs")).toBe(true);
  });
  test("the tab ends on a different site: not confirmed", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    browser.finalUrl = () => "https://elsewhere.test/";
    expect((await ex["browser.navigate"]({ url: "https://example.com/" }, ctx())).verified).toBe(false);
  });
  test("a redirect within the same site (www, path) still confirms, and the final address is reported", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    browser.finalUrl = () => "https://www.example.com/en/home";
    expect(await ex["browser.navigate"]({ url: "https://example.com/" }, ctx())).toMatchObject({ ok: true, verified: true, data: { finalUrl: "https://www.example.com/en/home" } });
  });
  test("navigating THIS tab confirms it changed from before (same address and title as before is not a change)", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    const r = await ex["browser.navigate"]({ url: "https://example.com/", where: "this-tab" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { newTab: false } });
    expect(r.evidence).toContain("Existing");
    // Already showing exactly that page: nothing changed, so it can't be claimed as done by this step.
    const again = await ex["browser.navigate"]({ url: "https://example.com/", where: "this-tab" }, ctx());
    expect(again).toMatchObject({ ok: false, verified: false });
  });
  test("an expected title must match", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    expect((await ex["browser.navigate"]({ url: "https://example.com/", expectTitle: "Example" }, ctx())).verified).toBe(true);
    expect((await ex["browser.navigate"]({ url: "https://example.com/", expectTitle: "Nope" }, ctx())).verified).toBe(false);
  });
  test("a link with a login or token, or a non-http link, is refused before any browser is touched", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    for (const url of ["https://user:pw@example.com/", "https://example.com/?token=abc", "file:///C:/secret.txt", "javascript:alert(1)"]) {
      expect(await ex["browser.navigate"]({ url }, ctx())).toMatchObject({ ok: false, data: { refused: true } });
    }
    expect(browser.opened).toEqual([]);
  });
  test("the browser tool reports a failure: passed on honestly", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    browser.openOk = false;
    expect(await ex["browser.navigate"]({ url: "https://example.com/" }, ctx())).toMatchObject({ ok: false, verified: false, said: expect.stringContaining("didn't open") });
  });
});

describe("observe.window: read-only, no screenshot", () => {
  test("the foreground process and title, and the windows of a named app", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [
      { handle: 7, process: "chrome", cls: "x", title: "Example Domain - Google Chrome" },
      { handle: 9, process: "chrome", cls: "x", title: "Other - Google Chrome" },
      { handle: 8, process: "notepad", cls: "Notepad", title: "Untitled - Notepad" },
    ];
    pc.front = pc.windows[0];
    const r = await ex["observe.window"]({ app: "chrome" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { foreground: { handle: 7, process: "chrome", title: "Example Domain - Google Chrome" }, app: "chrome" } });
    expect((r.data as any).windows.map((w: any) => w.handle)).toEqual([7, 9]);
    expect(pc.focused).toEqual([]); // looking never touches
    expect(pc.started).toEqual([]);
  });
  test("a bank's window title is withheld", async () => {
    const { pc, ex, ctx } = rig();
    pc.front = { handle: 5, process: "chrome", cls: "x", title: "Online Banking - Commonwealth Bank - Google Chrome" };
    pc.windows = [pc.front];
    const r = await ex["observe.window"]({}, ctx());
    expect(r.ok).toBe(true);
    expect((r.data as any).foreground).toEqual({ handle: 5, process: "chrome", titleWithheld: true });
    expect(r.said).not.toContain("Banking");
  });
  test("nothing in front (locked screen): ok but unverified, said plainly", async () => {
    const { ex, ctx } = rig();
    expect(await ex["observe.window"]({}, ctx())).toMatchObject({ ok: true, verified: null, data: { foreground: null } });
  });
  test("an app off the list is refused", async () => {
    const { ex, ctx } = rig();
    expect(await ex["observe.window"]({ app: "regedit" }, ctx())).toMatchObject({ ok: false, data: { refused: true } });
  });
});

describe("not on Windows", () => {
  test("every one says it can't, and does nothing", async () => {
    const pc = new Desktop();
    const browser = new Browser();
    const deps = { ...pc.deps(), platform: "linux" };
    const ex = createDesktopExecutors(deps, browser, createWindowsExecutors(deps));
    const ctx = { signal: new AbortController().signal };
    for (const [name, args] of [["app.focus", { name: "chrome" }], ["browser.navigate", { url: "https://example.com/" }], ["observe.window", {}]] as const) {
      expect(await ex[name](args, ctx)).toMatchObject({ ok: false, verified: false, said: expect.stringContaining("needs Windows") });
    }
    expect(browser.opened).toEqual([]);
  });
});

describe("target.focus: bring back a website or app, confirmed in the foreground", () => {
  test("a site: its tab is activated by id, the browser window showing its title is focused and read back", async () => {
    const { pc, browser, ex, ctx } = rig();
    const activated: string[] = [];
    browser.listening = true;
    const hands = await browser.hands();
    browser.hands = async () => ({ ...hands!, tabs: async () => [{ targetId: "TAB1", title: "Example Domain", url: "https://example.com/", active: false }], activate: async (id: string) => (activated.push(id), true) });
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Example Domain - Google Chrome" }, { handle: 8, process: "POWERPNT", cls: "y", title: "Presentation1 - PowerPoint" }];
    pc.front = pc.windows[1];
    const r = await ex["target.focus"]({ kind: "site", title: "Example Domain", url: "https://example.com/", targetId: "TAB1" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { handle: 7, process: "chrome", foreground: true, activated: true } });
    expect(activated).toEqual(["TAB1"]);
    expect(pc.focused).toEqual([7]);
  });
  test("a site recorded by its address is found by the name its pages use for themselves", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 9, process: "chrome", cls: "x", title: "Sydney weather - YouTube - Google Chrome for Testing" }, { handle: 8, process: "POWERPNT", cls: "y", title: "Presentation1 - PowerPoint" }];
    pc.front = pc.windows[1];
    const r = await ex["target.focus"]({ kind: "site", title: "youtube.com", url: "https://www.youtube.com/" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { handle: 9, foreground: true } });
  });
  test("the page's window is gone: honest failure, nothing focused", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 8, process: "POWERPNT", cls: "y", title: "PowerPoint" }];
    const r = await ex["target.focus"]({ kind: "site", title: "Example Domain", url: "https://example.com/" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(pc.focused).toEqual([]);
  });
  test("Windows won't bring it forward: not verified, says what is in front", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Example Domain - Google Chrome" }, { handle: 8, process: "POWERPNT", cls: "y", title: "PowerPoint" }];
    pc.front = pc.windows[1];
    pc.focusBlocked = true;
    const r = await ex["target.focus"]({ kind: "site", title: "Example Domain", url: "https://example.com/" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("POWERPNT is in front instead");
  });
  test("an app is the same verified focus as app.focus; any other kind is refused", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 9, process: "POWERPNT", cls: "y", title: "Presentation1 - PowerPoint" }];
    expect(await ex["target.focus"]({ kind: "app", app: "powerpoint" }, ctx())).toMatchObject({ ok: true, verified: true, data: { handle: 9, foreground: true } });
    expect(await ex["target.focus"]({ kind: "file", title: "x" }, ctx())).toMatchObject({ ok: false, data: { refused: true } });
  });
});

describe("strict tab binding: a tab id is that tab or nothing", () => {
  test("target.focus on a closed tab: 'That tab was closed', no focus, no fallback to a window with a similar title", async () => {
    const { pc, browser, ex, ctx } = rig();
    browser.listening = true; // tabs: only AAAA1111 ("Existing")
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Example Domain - Google Chrome" }]; // a NEIGHBOUR with the same title
    const r = await ex["target.focus"]({ kind: "site", title: "Example Domain", url: "https://example.com/", targetId: "GONE1234" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false, data: { recovery: "tab-closed", tabId: "GONE1234" } });
    expect(r.said).toContain("That tab was closed");
    expect(pc.focused).toEqual([]);
  });
  test("target.focus when the browser itself is gone: the same recovery state", async () => {
    const { pc, ex, ctx } = rig(); // browser not listening
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Example Domain - Google Chrome" }];
    expect(await ex["target.focus"]({ kind: "site", title: "Example Domain", url: "https://example.com/", targetId: "GONE1234" }, ctx())).toMatchObject({ data: { recovery: "tab-closed" } });
    expect(pc.focused).toEqual([]);
  });
  test("target.focus when the tab cannot be made active: refused, not a different window", async () => {
    const { pc, browser, ex, ctx } = rig();
    browser.listening = true;
    const hands = await browser.hands();
    browser.hands = async () => ({ ...hands!, activate: async () => false });
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Existing - Google Chrome" }];
    expect(await ex["target.focus"]({ kind: "site", title: "Existing", url: "https://existing.example/", targetId: "AAAA1111" }, ctx())).toMatchObject({ ok: false, data: { recovery: "tab-not-active" } });
    expect(pc.focused).toEqual([]);
  });
  test("browser.navigate bound to a closed tab: nothing is opened anywhere", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    const r = await ex["browser.navigate"]({ url: "https://example.com/", tabId: "GONE1234" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false, data: { recovery: "tab-closed", tabId: "GONE1234" } });
    expect(browser.opened).toEqual([]);
  });
  test("browser.navigate bound to a live tab: that tab is activated first, then navigated, and confirmed changed", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    const hands = await browser.hands();
    const activated: string[] = [];
    browser.hands = async () => ({ ...hands!, activate: async (id: string) => (activated.push(id), true) });
    const r = await ex["browser.navigate"]({ url: "https://example.com/", tabId: "AAAA1111" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { newTab: false, where: "this-tab" } });
    expect(activated).toEqual(["AAAA1111"]);
  });
  test("browser.navigate bound to a tab that will not become active: refused, nothing opened", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    const hands = await browser.hands();
    browser.hands = async () => ({ ...hands!, activate: async () => false });
    expect(await ex["browser.navigate"]({ url: "https://example.com/", tabId: "AAAA1111" }, ctx())).toMatchObject({ ok: false, data: { recovery: "tab-not-active" } });
    expect(browser.opened).toEqual([]);
  });
});

describe("browser.navigate {blank}: 'open Chrome and create a new tab', confirmed by the browser's own tab list", () => {
  test("Chrome already up: a NEW blank tab appears in front (a new id), and is confirmed", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    const r = await ex["browser.navigate"]({ blank: true }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, said: "Opened a new tab in Chrome.", data: { blank: true, newTab: true } });
    expect(browser.opened).toEqual(["new-tab:about:blank"]);
    expect(browser.tabs.filter((b) => b.active)).toHaveLength(1);
    expect(browser.tabs).toHaveLength(2);
  });
  test("Chrome not running: it is started with a blank tab, and that one tab is the new tab (not two)", async () => {
    const { browser, ex, ctx } = rig();
    const start = browser.start.bind(browser);
    browser.start = async (url: string) => {
      const ok = await start(url);
      browser.tabs = [{ targetId: "FIRST001", title: "", url: "about:blank", active: true }];
      return ok;
    };
    const r = await ex["browser.navigate"]({ blank: true }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, said: "Opened Chrome with a new tab.", data: { launched: true, targetId: "FIRST001" } });
    expect(browser.opened).toEqual([]);
    expect(browser.tabs).toHaveLength(1);
  });
  test("the browser says it opened but its list shows no new blank tab in front: not confirmed", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    const hands = browser.hands.bind(browser);
    browser.hands = async () => ({ ...(await hands())!, open: async () => ({ ok: true, said: "Opened.", targetId: "GHOST" }) });
    const r = await ex["browser.navigate"]({ blank: true }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("can't say it opened");
  });
  test("the browser won't start, or agent-browser is missing: said plainly, nothing opened", async () => {
    const a = rig();
    a.browser.startWorks = false;
    expect((await a.ex["browser.navigate"]({ blank: true }, a.ctx())).said).toContain("wouldn't start");
    const b = rig();
    b.browser.installed = false;
    expect(await b.ex["browser.navigate"]({ blank: true }, b.ctx())).toMatchObject({ ok: false, verified: false });
  });
  test("a url still takes the normal path; blank with a url is a url", async () => {
    const { browser, ex, ctx } = rig();
    browser.listening = true;
    expect(await ex["browser.navigate"]({ blank: true, url: "https://example.com/" }, ctx())).toMatchObject({ ok: true, data: { title: "Example Domain" } });
  });
});

describe("round 3 fixer: a common first label of a host never picks another site's window", () => {
  test("mail.google.com is not found in a Docs or news window, and nothing is focused or verified", async () => {
    for (const other of ["Mail merge plan - Google Docs - Google Chrome", "Mail room news - Google Chrome"]) {
      const { pc, ex, ctx } = rig();
      pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: other }, { handle: 8, process: "POWERPNT", cls: "y", title: "Presentation1 - PowerPoint" }];
      pc.front = pc.windows[1];
      const r = await ex["target.focus"]({ kind: "site", title: "", url: "https://mail.google.com/mail/u/0/" }, ctx());
      expect(r).toMatchObject({ ok: false, verified: false });
      expect(pc.focused).toEqual([]);
    }
  });
  test("a news.example.org page is not confused with a window that says 'news'", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Breaking news - Other Paper - Google Chrome" }];
    const r = await ex["target.focus"]({ kind: "site", title: "", url: "https://news.example.org/" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(pc.focused).toEqual([]);
  });
  test("the right window is still found by the full host or by the recorded page title", async () => {
    const { pc, ex, ctx } = rig();
    pc.windows = [{ handle: 7, process: "chrome", cls: "x", title: "Inbox (2) - Gmail - Google Chrome" }, { handle: 8, process: "POWERPNT", cls: "y", title: "Presentation1 - PowerPoint" }];
    pc.front = pc.windows[1];
    const r = await ex["target.focus"]({ kind: "site", title: "Inbox (2) - Gmail", url: "https://mail.google.com/mail/u/0/" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { handle: 7, foreground: true } });
  });
});
