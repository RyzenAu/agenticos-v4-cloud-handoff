import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutorResult } from "../jarvis-command/contracts";
import {
  abortableSleep,
  allowListedApp,
  Cancelled,
  createWindowsExecutors,
  deckBlankScript,
  insideRoots,
  parseDeckReadBack,
  plainStderr,
  textRefusal,
  urlRefusal,
  type PsResult,
  type WindowsDeps,
  type WinInfo,
} from "./windows";

// SYNTHETIC: a fake Windows desktop. No PowerShell, no windows, no PowerPoint, no network.

type Doc = { title: string; text: string };
class FakeDesktop {
  windows: WinInfo[] = [];
  docs = new Map<number, Doc>();
  front: number | null = null;
  started: string[] = [];
  opened: string[] = [];
  typed: Array<{ handle: number; text: string }> = [];
  keys: Array<{ handle: number; chord: string }> = [];
  ps: string[] = [];
  next = 1000;
  /** What launching notepad does: a new Untitled window, a restored tab, or nothing. */
  notepad: "untitled" | "restored" | "restored-stuck" | "none" | "not-empty" = "untitled";
  /** Tabs left behind when a new tab opened (their text must never change). */
  tabs: Array<{ title: string; text: string }> = [];
  /** Type into Notepad, but read back something else. */
  garble = false;
  /** open-url: whether a browser window shows the page after the open. */
  browserShows = true;
  /** deck.blank: PowerShell's answer. */
  deck: (script: string) => PsResult = () => ({ code: 0, stdout: JSON.stringify({ name: "Presentation1", slides: 1, layout: 1, path: "", title64: Buffer.from("Mehroz test").toString("base64") }), stderr: "" });
  openWindow(process: string, title: string, cls = process) {
    const handle = this.next++;
    this.windows.push({ handle, process, cls, title });
    this.front = handle;
    return handle;
  }
  deps(extra: Partial<WindowsDeps> = {}): WindowsDeps {
    return {
      platform: "win32",
      roots: [],
      windows: async () => this.windows.map((w) => ({ ...w })),
      foreground: async () => this.windows.find((w) => w.handle === this.front) ?? null,
      startApp: async (exe) => {
        this.started.push(exe);
        if (exe === "notepad.exe") {
          if (this.notepad === "none") return;
          const title = this.notepad === "untitled" ? "Untitled - Notepad" : this.notepad === "not-empty" ? "Untitled - Notepad" : "old notes - Notepad";
          const h = this.openWindow("Notepad", title);
          this.docs.set(h, { title, text: this.notepad === "not-empty" ? "left over" : this.notepad === "untitled" ? "" : "restored text" });
          return;
        }
        if (exe === "calc.exe") this.openWindow("ApplicationFrameHost", "Calculator", "ApplicationFrameWindow");
        if (exe === "powerpnt.exe") this.openWindow("POWERPNT", "PowerPoint");
      },
      shellOpen: async (target) => {
        this.opened.push(target);
        if (/^https?:/.test(target)) {
          if (this.browserShows) this.openWindow("chrome", "Example Domain - Google Chrome", "Chrome_WidgetWin_1");
        } else this.openWindow("WINWORD", `${target.split(/[\\/]/).pop()} - Word`);
      },
      focus: async (h) => {
        this.front = h;
        return true;
      },
      keys: async (handle, chord) => {
        this.keys.push({ handle, chord });
        // Windows 11 Notepad: Ctrl+T opens a new, empty Untitled TAB in the same window (the old tab is kept).
        if (chord === "ctrl+t" && (this.notepad === "restored" || this.notepad === "not-empty")) {
          const w = this.windows.find((x) => x.handle === handle)!;
          this.tabs.push({ ...this.docs.get(handle)! });
          w.title = "Untitled - Notepad";
          this.docs.set(handle, { title: w.title, text: "" });
        }
      },
      typeText: async (handle, text) => {
        if (this.front !== handle) throw new Error("The window changed under me, so I stopped.");
        this.typed.push({ handle, text });
        const d = this.docs.get(handle)!;
        d.text += this.garble ? text.slice(1) : text;
      },
      editorText: async (handle) => this.docs.get(handle)?.text ?? null,
      runPs: async (script, { signal }) => {
        this.ps.push(script);
        if (signal.aborted) return { code: -1, stdout: "", stderr: "Cancelled." };
        return this.deck(script);
      },
      pageTitle: async () => "Example Domain",
      realpath: (p) => p,
      sleep: (ms, signal) => abortableSleep(Math.min(ms, 2), signal),
      timing: { appWaitMs: 40, pollMs: 2, settleMs: 1, urlWaitMs: 40, fileWaitMs: 40 },
      ...extra,
    };
  }
}

const ctx = () => ({ signal: new AbortController().signal });

describe("pure rules", () => {
  test("allow-list names and aliases", () => {
    expect(allowListedApp("Notepad")).toBe("notepad");
    expect(allowListedApp("power point")).toBe("powerpoint");
    expect(allowListedApp("calc")).toBe("calculator");
    expect(allowListedApp("vscode")).toBe("vs code");
    expect(allowListedApp("regedit")).toBeNull();
    expect(allowListedApp("cmd")).toBeNull();
    expect(allowListedApp("toString")).toBeNull();
  });
  test("text refusals: secrets, money, private data, long digit runs, length, control characters", () => {
    expect(textRefusal("hello from Mehroz")).toBeNull();
    expect(textRefusal("M&U Track 2 test line synthetic")).toBeNull();
    expect(textRefusal("my OpenAI API key is sk-abc")).not.toBeNull();
    expect(textRefusal("the password for the bank")).not.toBeNull();
    expect(textRefusal("transfer $500 to Mehroz")).not.toBeNull();
    expect(textRefusal("card 4111 1111 1111 1111")).not.toBeNull();
    expect(textRefusal("call 0412 345 678")).not.toBeNull();
    expect(textRefusal("x".repeat(201))).not.toBeNull();
    expect(textRefusal("line one\nline two")).not.toBeNull();
    expect(textRefusal("   ")).not.toBeNull();
    expect(textRefusal("open .env")).not.toBeNull();
  });
  test("URLs: plain http(s) only, no credentials, no token parameters, no money sites", () => {
    expect(urlRefusal("https://example.com").ok).toBe(true);
    expect(urlRefusal("http://example.com/keyboards?page=2").ok).toBe(true);
    for (const bad of ["file:///C:/Windows", "javascript:alert(1)", "ftp://example.com", "https://user:pw@example.com", "https://example.com/?access_token=abc", "https://example.com/#id_token=abc", "https://example.com/?api_key=1", "not a url", "https://www.commbank.com.au/"])
      expect(urlRefusal(bad).ok).toBe(false);
  });
  test("roots: inside only, links resolved", () => {
    expect(insideRoots("C:\\docs\\a.txt", ["C:\\docs"])).toBe(true);
    expect(insideRoots("C:\\docs-evil\\a.txt", ["C:\\docs"])).toBe(false);
    expect(insideRoots("C:\\docs\\link\\a.txt", ["C:\\docs"], (p) => (p.includes("link") ? "C:\\Windows\\a.txt" : p))).toBe(false);
  });
  test("deck script: title is base64, never spliced; never saves", () => {
    const script = deckBlankScript("'; Remove-Item C:\\ -Recurse; '");
    expect(script).not.toContain("Remove-Item");
    expect(script).toContain(Buffer.from("'; Remove-Item C:\\ -Recurse; '").toString("base64"));
    expect(script).not.toMatch(/\.Save(?:As)?\(/);
    expect(script).toContain("Presentations.Add");
    expect(parseDeckReadBack('noise\n{"name":"Presentation2","slides":1,"layout":1,"path":"","title64":"SGk="}')).toEqual({ name: "Presentation2", slides: 1, layout: 1, path: "", title: "Hi" });
    expect(parseDeckReadBack("garbage")).toBeNull();
    expect(plainStderr('#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">Bad thing_x000D__x000A_</S></Objs>')).toBe("Bad thing");
  });
});

describe("app.open", () => {
  test("opens an allow-listed app, verified by a NEW window of it", async () => {
    const d = new FakeDesktop();
    d.openWindow("ApplicationFrameHost", "Calculator", "ApplicationFrameWindow"); // one already open: must not count
    const r = await createWindowsExecutors(d.deps())["app.open"]({ name: "calculator" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(d.started).toEqual(["calc.exe"]);
  });
  test("refuses anything off the allow-list, launching nothing", async () => {
    const d = new FakeDesktop();
    for (const name of ["regedit", "cmd", "powershell", "C:\\evil.exe", "", "__proto__"]) {
      const r = await createWindowsExecutors(d.deps())["app.open"]({ name }, ctx());
      expect(r).toMatchObject({ ok: false, verified: false });
    }
    expect(d.started).toEqual([]);
  });
  test("no new window → not claimed", async () => {
    const d = new FakeDesktop();
    const r = await createWindowsExecutors(d.deps({ startApp: async () => undefined }))["app.open"]({ name: "excel" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("can't say it opened");
  });
  test("not on Windows → refused honestly", async () => {
    const d = new FakeDesktop();
    const r = await createWindowsExecutors(d.deps({ platform: "linux" }))["app.open"]({ name: "notepad" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(d.started).toEqual([]);
  });
});

describe("open-url", () => {
  test("verified only when a browser window shows the page's own title", async () => {
    const d = new FakeDesktop();
    const r = await createWindowsExecutors(d.deps())["open-url"]({ url: "https://example.com" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(d.opened).toEqual(["https://example.com/"]);
  });
  test("browser not visible → verified:null and never claims it's showing", async () => {
    const d = new FakeDesktop();
    d.browserShows = false;
    const r = await createWindowsExecutors(d.deps())["open-url"]({ url: "https://example.com" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: null });
    expect(r.said).toMatch(/can't confirm/);
    expect(r.said).not.toMatch(/\bis open\b|\bshowing\.$/);
  });
  test("no way to check (no title lookup) → verified:null", async () => {
    const d = new FakeDesktop();
    const r = await createWindowsExecutors(d.deps({ pageTitle: undefined }))["open-url"]({ url: "https://example.com" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: null });
  });
  test("refused links open nothing", async () => {
    const d = new FakeDesktop();
    for (const url of ["file:///C:/Windows/System32", "https://a:b@example.com", "https://example.com/?token=x"]) {
      expect(await createWindowsExecutors(d.deps())["open-url"]({ url }, ctx())).toMatchObject({ ok: false, verified: false });
    }
    expect(d.opened).toEqual([]);
  });
});

describe("file.open", () => {
  const withRoot = (fn: (root: string, outside: string) => Promise<void>) => async () => {
    const base = mkdtempSync(join(tmpdir(), "exec-files-"));
    const root = join(base, "MU-Jarvis");
    const outside = join(base, "elsewhere");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    try {
      await fn(root, outside);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
  test(
    "opens one match inside the root, verified by its window",
    withRoot(async (root, outside) => {
      writeFileSync(join(root, "sub", "quarterly plan.docx"), "x");
      writeFileSync(join(outside, "quarterly plan.docx"), "x");
      const d = new FakeDesktop();
      const r = await createWindowsExecutors(d.deps({ roots: [root] }))["file.open"]({ name: "quarterly plan" }, ctx());
      expect(r).toMatchObject({ ok: true, verified: true });
      expect(d.opened).toEqual([join(root, "sub", "quarterly plan.docx")]);
    }),
  );
  test(
    "several matches → asks which, opens nothing",
    withRoot(async (root) => {
      writeFileSync(join(root, "notes.txt"), "x");
      writeFileSync(join(root, "sub", "notes.txt"), "x");
      const d = new FakeDesktop();
      const r = await createWindowsExecutors(d.deps({ roots: [root] }))["file.open"]({ name: "notes.txt" }, ctx());
      expect(r).toMatchObject({ ok: false, data: { ask: true } });
      expect(r.said).toMatch(/Which one\?/);
      expect(d.opened).toEqual([]);
    }),
  );
  test(
    "never programs, scripts or secret-bearing files; never outside the roots",
    withRoot(async (root, outside) => {
      writeFileSync(join(root, "setup.exe"), "x");
      writeFileSync(join(root, "run.ps1"), "x");
      writeFileSync(join(root, "api-key.txt"), "x");
      writeFileSync(join(outside, "budget.xlsx"), "x");
      const d = new FakeDesktop();
      const ex = createWindowsExecutors(d.deps({ roots: [root] }));
      for (const name of ["setup.exe", "setup", "run.ps1", "api-key.txt", ".env", "budget"]) expect((await ex["file.open"]({ name }, ctx())).ok).toBe(false);
      expect(d.opened).toEqual([]);
      // No roots at all → refused.
      expect(await createWindowsExecutors(d.deps({ roots: [] }))["file.open"]({ name: "budget" }, ctx())).toMatchObject({ ok: false });
    }),
  );
  test(
    "a window never appears → not claimed",
    withRoot(async (root) => {
      writeFileSync(join(root, "agenda.docx"), "x");
      const d = new FakeDesktop();
      const r = await createWindowsExecutors(d.deps({ roots: [root], shellOpen: async (t) => void d.opened.push(t) }))["file.open"]({ name: "agenda" }, ctx());
      expect(r).toMatchObject({ ok: false, verified: false });
    }),
  );
});

describe("deck.blank", () => {
  test("a new unsaved presentation, read back from PowerPoint; returns its name", async () => {
    const d = new FakeDesktop();
    const r = await createWindowsExecutors(d.deps())["deck.blank"]({ title: "Mehroz test" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { presentation: "Presentation1", slides: 1, title: "Mehroz test", saved: false } });
    expect(isExecutorResult(r)).toBe(true);
    expect(d.ps[0]).toContain(Buffer.from("Mehroz test").toString("base64"));
    expect(d.ps[0]).not.toContain("Mehroz test");
  });
  test("read-back mismatch (title, slide count or saved) → ok:false", async () => {
    for (const back of [
      { name: "Presentation1", slides: 1, layout: 1, path: "", title64: Buffer.from("Something else").toString("base64") },
      { name: "Presentation1", slides: 2, layout: 1, path: "", title64: Buffer.from("Mehroz test").toString("base64") },
      { name: "Presentation1", slides: 1, layout: 1, path: "C:\\Users\\x\\Documents", title64: Buffer.from("Mehroz test").toString("base64") },
    ]) {
      const d = new FakeDesktop();
      d.deck = () => ({ code: 0, stdout: JSON.stringify(back), stderr: "" });
      const r = await createWindowsExecutors(d.deps())["deck.blank"]({ title: "Mehroz test" }, ctx());
      expect(r).toMatchObject({ ok: false, verified: false });
    }
  });
  test("Unlicensed PowerPoint → said plainly", async () => {
    const d = new FakeDesktop();
    d.deck = () => ({ code: 1, stdout: "", stderr: "Exception from HRESULT: 0x80048240\nUNLICENSED\n" });
    const r = await createWindowsExecutors(d.deps())["deck.blank"]({ title: "Mehroz test" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("Unlicensed");
  });
  test("a secret or money title is refused before PowerPoint", async () => {
    const d = new FakeDesktop();
    expect((await createWindowsExecutors(d.deps())["deck.blank"]({ title: "our stripe api key" }, ctx())).ok).toBe(false);
    expect(d.ps).toEqual([]);
  });
});

describe("notepad.type", () => {
  test("its own new Untitled empty document; typed; read back exactly", async () => {
    const d = new FakeDesktop();
    const theirs = d.openWindow("Notepad", "shopping.txt - Notepad");
    d.docs.set(theirs, { title: "shopping.txt - Notepad", text: "milk" });
    const r = await createWindowsExecutors(d.deps())["notepad.type"]({ text: "hello from Mehroz" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(d.typed).toHaveLength(1);
    expect(d.typed[0].handle).not.toBe(theirs);
    expect(d.docs.get(theirs)!.text).toBe("milk");
  });
  test("restored or non-empty document: a NEW empty tab first (ctrl+t), verified, then typed; the old tab is untouched", async () => {
    for (const mode of ["restored", "not-empty"] as const) {
      const d = new FakeDesktop();
      d.notepad = mode;
      const r = await createWindowsExecutors(d.deps())["notepad.type"]({ text: "hello" }, ctx());
      expect(r).toMatchObject({ ok: true, verified: true });
      expect(d.keys.map((k) => k.chord)).toEqual(["ctrl+t"]);
      expect(d.tabs.map((t) => t.text)).toEqual([mode === "restored" ? "restored text" : "left over"]);
    }
  });
  test("still not a new, empty Untitled document after a new tab → refused, nothing typed", async () => {
    for (const mode of ["restored-stuck"] as const) {
      const d = new FakeDesktop();
      d.notepad = mode;
      const r = await createWindowsExecutors(d.deps())["notepad.type"]({ text: "hello" }, ctx());
      expect(r).toMatchObject({ ok: false, verified: false });
      expect(r.said).toContain("wasn't a new, empty Untitled one");
      expect(d.typed).toEqual([]);
    }
  });
  test("no new Notepad window → nothing typed", async () => {
    const d = new FakeDesktop();
    d.notepad = "none";
    const r = await createWindowsExecutors(d.deps())["notepad.type"]({ text: "hello" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(d.typed).toEqual([]);
  });
  test("a failed read-back → ok:false, never claimed", async () => {
    const d = new FakeDesktop();
    d.garble = true;
    const r = await createWindowsExecutors(d.deps())["notepad.type"]({ text: "hello from Mehroz" }, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("doesn't read it back the same");
  });
  test("secret, money, private-data or long-digit text is refused before Notepad opens", async () => {
    const d = new FakeDesktop();
    const ex = createWindowsExecutors(d.deps());
    for (const text of ["my github token ghp_123", "pay the invoice from my NAB account", "account 062000 12345678", "the seed phrase is apple", "x".repeat(250)]) {
      expect(await ex["notepad.type"]({ text }, ctx())).toMatchObject({ ok: false, verified: false });
    }
    expect(d.started).toEqual([]);
  });
});

describe("abort", () => {
  test("an abort mid-run stops promptly and reports Stopped (no success claimed)", async () => {
    const d = new FakeDesktop();
    d.notepad = "none"; // it would poll for a window for a while
    const controller = new AbortController();
    const started = Date.now();
    const pending = createWindowsExecutors(d.deps({ timing: { appWaitMs: 10_000, pollMs: 20 }, sleep: abortableSleep }))["notepad.type"]({ text: "hello" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, verified: false, said: "Stopped.", data: { cancelled: true } });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(d.typed).toEqual([]);
  });
  test("already aborted → nothing starts", async () => {
    const d = new FakeDesktop();
    const controller = new AbortController();
    controller.abort();
    for (const [name, args] of [["notepad.type", { text: "hi" }], ["deck.blank", { title: "T" }], ["app.open", { name: "notepad" }], ["open-url", { url: "https://example.com" }]] as const) {
      expect(await createWindowsExecutors(d.deps())[name](args, { signal: controller.signal })).toMatchObject({ ok: false, said: "Stopped." });
    }
    expect(d.started).toEqual([]);
    expect(d.opened).toEqual([]);
    expect(d.ps).toEqual([]);
  });
  test("abortableSleep rejects with Cancelled", async () => {
    const c = new AbortController();
    const p = abortableSleep(10_000, c.signal);
    c.abort();
    await expect(p).rejects.toBeInstanceOf(Cancelled);
  });
});
