import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CdpSession, newTab, tabs, readPage } from "./cdp";
import { checkComputerHubUrl, readComputerConfig, writeComputerConfig } from "./config";
import { createLinuxExecutors, liveBrowserBackend, type BrowserBackend } from "./executors-linux";
import { checkPublicUrl, isPublicAddress } from "./urlpolicy";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "linux-computer-"));
  dirs.push(d);
  return d;
};

const ctx = (signal = new AbortController().signal) => ({ signal, owner: "usman" as const, log: () => undefined, progress: undefined as undefined | ((s: any) => void) });
const publicResolver = async (host: string) => (host === "private.example" ? ["10.0.0.5"] : host === "mixed.example" ? ["93.184.216.34", "127.0.0.1"] : host.endsWith(".example") || host === "example.com" ? ["93.184.216.34"] : []);

describe("which addresses a computer's browser may open", () => {
  test("public http(s) pages pass; private, loopback, metadata, tailnet and credential URLs do not", async () => {
    for (const u of ["https://example.com/", "http://news.example/path?q=1", "https://[2606:4700:4700::1111]/"]) expect((await checkPublicUrl(u, publicResolver)).ok).toBe(true);
    const refusals = [
      "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/", "http://localhost/", "http://127.0.0.1:8081/", "http://[::1]/", "http://10.1.2.3/", "http://172.19.48.1:8113/", "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/", "http://100.64.0.11/", "http://2130706433/", "http://0x7f.1/", "http://0.0.0.0/", "http://user:pass@example.com/",
      "http://printer.local/", "http://db.internal/", "http://private.example/", "http://mixed.example/", "http://nowhere.invalid-name/", "not a url", "",
    ];
    for (const u of refusals) expect((await checkPublicUrl(u, publicResolver)).ok).toBe(false);
  });

  test("address classes", () => {
    for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPublicAddress(a)).toBe(true);
    for (const a of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.127.0.1", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0", "198.18.0.1"]) expect(isPublicAddress(a)).toBe(false);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("100.128.0.1")).toBe(true);
  });
});

describe("where a computer may connect", () => {
  test("the same host, the tailnet or a private bridge address: never the public internet, never with credentials", () => {
    for (const u of ["http://127.0.0.1:8112", "http://localhost:8081", "http://172.19.48.1:8113", "http://10.0.0.4:8113", "http://192.168.1.9:8113", "http://100.101.102.103:8443", "https://hub.tail1234.ts.net:8443"]) expect(checkComputerHubUrl(u).ok).toBe(true);
    for (const u of ["http://8.8.8.8", "https://example.com", "http://hub.tail1234.ts.net", "http://user:pw@127.0.0.1", "ftp://127.0.0.1", "nope"]) expect(checkComputerHubUrl(u).ok).toBe(false);
  });

  test("the pairing is stored mode 0600 and read back", () => {
    const dir = tmp();
    writeComputerConfig(dir, { name: "research", hubUrl: "http://127.0.0.1:1", deviceId: "d", token: "secret-token", expiresAt: 1, pairedAt: 1, label: "l", display: "101", resolution: "1280x800x24", vncPort: 6001, workdir: join(dir, "work"), profileDir: join(dir, "profile"), browserPort: 9401 });
    expect(readComputerConfig(dir)).toMatchObject({ name: "research", deviceId: "d", browserPort: 9401 });
    expect(readComputerConfig(join(dir, "missing"))).toBeNull();
  });
});

/** An in-memory browser: tabs with a title and address; everything the executors ask of a real one. */
function fakeBrowser(pages: Record<string, { title: string; redirectTo?: string; ready?: string }>) {
  const state = { tabs: [] as { id: string; url: string; title: string; ready: string }[], clicks: [] as [number, number][], typed: [] as string[], keys: [] as string[], blanked: [] as string[], started: 0 };
  const backend: BrowserBackend = {
    available: () => true,
    alive: async () => state.started > 0,
    ensure: async () => void state.started++,
    open: async (url) => {
      state.started++;
      const page = pages[new URL(url).host] ?? { title: "" };
      const landed = page.redirectTo ?? url;
      const id = `t${state.tabs.length + 1}`;
      state.tabs.push({ id, url: landed, title: page.title, ready: page.ready ?? "complete" });
      return id;
    },
    read: async (tabId) => {
      const t = state.tabs.find((x) => x.id === tabId) ?? state.tabs.at(-1);
      return t ? { tabId: t.id, title: t.title, url: t.url, ready: t.ready } : null;
    },
    frame: async () => Uint8Array.from([1, 2, 3, 4, 5]),
    click: async (x, y) => void state.clicks.push([x, y]),
    type: async (t) => void state.typed.push(t),
    key: async (k) => void state.keys.push(k),
    blank: async (id) => void state.blanked.push(id),
  };
  return { backend, state };
}

describe("the Linux executors: each result is its own read-back", () => {
  test("a page whose load event never fires (analytics requests hang) opens once its DOM is ready and stable, and says so; a page that is not ready or keeps changing does not", async () => {
    const dir = tmp();
    const { backend } = fakeBrowser({ "slow.example": { title: "Slow Page", ready: "interactive" }, "loading.example": { title: "", ready: "loading" }, "done.example": { title: "Done" } });
    const ex = createLinuxExecutors({ name: "research", workdir: dir, browser: backend, resolve: publicResolver, settleMs: 1, interactiveStableMs: 5, pageTimeoutMs: 400 });
    const slow: any = await ex["browser.navigate"]({ url: "https://slow.example/", expectTitle: "Slow Page" }, ctx());
    expect(slow).toMatchObject({ ok: true, verified: true, data: { stillLoading: true } });
    expect(slow.said).toMatch(/still loading background requests/);
    const done: any = await ex["browser.navigate"]({ url: "https://done.example/", expectTitle: "Done" }, ctx());
    expect(done.said).not.toMatch(/still loading/);
    expect(done.data.stillLoading).toBeUndefined();
    // no title yet: still not opened (the address shown while loading is not the page)
    const none: any = await ex["browser.navigate"]({ url: "https://loading.example/" }, ctx());
    expect(none).toMatchObject({ ok: false, verified: false });
    expect(none.said).toMatch(/didn't finish loading/);
  });

  test("browser.navigate opens a public page and verifies it by the page's real title", async () => {
    const dir = tmp();
    const { backend, state } = fakeBrowser({ "example.com": { title: "Example Domain" } });
    const ex = createLinuxExecutors({ name: "research", workdir: dir, browser: backend, resolve: publicResolver, settleMs: 1 });
    const r: any = await ex["browser.navigate"]({ url: "https://example.com", expectTitle: "Example Domain" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(r.said).toContain("Example Domain");
    expect(state.tabs).toHaveLength(1);
    // a wrong expectation is honest, not "done"
    const wrong: any = await ex["browser.navigate"]({ url: "https://example.com", expectTitle: "Something else" }, ctx());
    expect(wrong).toMatchObject({ ok: false, verified: false });
    expect(wrong.said).toMatch(/not what was expected/);
  });

  test("a private address is refused before the browser is touched; a redirect into one is closed", async () => {
    const dir = tmp();
    const { backend, state } = fakeBrowser({ "evil.example": { title: "Hi", redirectTo: "http://169.254.169.254/latest/" } });
    const ex = createLinuxExecutors({ name: "research", workdir: dir, browser: backend, resolve: publicResolver, settleMs: 1 });
    for (const url of ["http://127.0.0.1:8081/", "http://172.19.48.1:8113/__devices/me", "http://private.example/", "file:///etc/passwd"]) {
      const r: any = await ex["browser.navigate"]({ url }, ctx());
      expect(r).toMatchObject({ ok: false, verified: false, data: { refused: true } });
    }
    expect(state.tabs).toHaveLength(0);
    const redirect: any = await ex["browser.navigate"]({ url: "https://evil.example/" }, ctx());
    expect(redirect).toMatchObject({ ok: false, verified: false });
    expect(redirect.said).toMatch(/redirected somewhere it shouldn't/);
    expect(state.blanked).toEqual(["t1"]);
  });

  test("observe.page reads the page in front and keeps the frame in memory only", async () => {
    const dir = tmp();
    const { backend } = fakeBrowser({ "example.com": { title: "Example Domain" } });
    const ex = createLinuxExecutors({ name: "research", workdir: dir, browser: backend, resolve: publicResolver, settleMs: 1 });
    expect((await ex["observe.page"]({}, ctx())) as any).toMatchObject({ ok: false }); // nothing open yet
    await ex["browser.navigate"]({ url: "https://example.com" }, ctx());
    const r: any = await ex["observe.page"]({}, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { title: "Example Domain", url: "https://example.com/", frame: { bytes: 5 } } });
    expect(readdirSync(dir)).toEqual([]); // no screenshot on disk
  });

  test("input executors report 'sent; not checked' unless told what to expect, then verify by reading the page", async () => {
    const dir = tmp();
    const { backend, state } = fakeBrowser({ "example.com": { title: "Example Domain" } });
    const ex = createLinuxExecutors({ name: "research", workdir: dir, browser: backend, resolve: publicResolver, settleMs: 1 });
    await ex["browser.navigate"]({ url: "https://example.com" }, ctx());
    expect((await ex["input.click"]({ x: 10, y: 20 }, ctx())) as any).toMatchObject({ ok: true, verified: null });
    expect((await ex["input.click"]({ x: 10, y: 20, expectTitle: "Example" }, ctx())) as any).toMatchObject({ ok: true, verified: true });
    expect((await ex["input.click"]({ x: 10, y: 20, expectTitle: "Nope" }, ctx())) as any).toMatchObject({ ok: false, verified: false });
    expect((await ex["input.click"]({ x: -5, y: 1 }, ctx())) as any).toMatchObject({ ok: false, data: { refused: true } });
    await ex["input.type"]({ text: "hello" }, ctx());
    await ex["input.key"]({ key: "Enter" }, ctx());
    expect(state.clicks).toHaveLength(3);
    expect(state.typed).toEqual(["hello"]);
    expect(state.keys).toEqual(["Enter"]);
  });

  test("files are jailed to the computer's own working folder, verified by reading them back", async () => {
    const dir = tmp();
    const ex = createLinuxExecutors({ name: "builder", workdir: join(dir, "work") });
    const w: any = await ex["file.write"]({ name: "notes.txt", text: "hello" }, ctx());
    expect(w).toMatchObject({ ok: true, verified: true });
    expect(readFileSync(join(dir, "work", "notes.txt"), "utf8")).toBe("hello");
    expect(((await ex["file.read"]({ name: "notes.txt" }, ctx())) as any).data.text).toBe("hello");
    expect(((await ex["file.list"]({}, ctx())) as any).data.names).toEqual(["notes.txt"]);
    for (const name of ["../escape.txt", "/etc/passwd", "a/b", "..", ".hidden", "x".repeat(100)]) {
      expect((await ex["file.write"]({ name, text: "x" }, ctx())) as any).toMatchObject({ ok: false, data: { refused: true } });
      expect((await ex["file.read"]({ name }, ctx())) as any).toMatchObject({ ok: false });
    }
    expect((await ex["file.write"]({ name: "big.txt", text: "x".repeat(300_000) }, ctx())) as any).toMatchObject({ ok: false });
    expect(readdirSync(dir)).toEqual(["work"]);
  });

  test("a computer without a browser still runs files and says plainly what it cannot do", async () => {
    const dir = tmp();
    const ex = createLinuxExecutors({ name: "builder", workdir: dir });
    expect(Object.keys(ex)).not.toContain("browser.navigate");
    expect(Object.keys(ex)).toEqual(expect.arrayContaining(["echo", "wait", "computer.info", "file.write", "file.read", "screen.goal"]));
    const goal: any = await ex["screen.goal"]({ goal: "go to example.com" }, ctx());
    expect(goal).toMatchObject({ ok: false, verified: false });
    expect(goal.said).toMatch(/no browser installed/);
    expect(((await ex["computer.info"]({}, ctx())) as any).data).toMatchObject({ name: "builder", desktop: false, browser: false });
  });

  test("screen.goal plans 'go to <address> and check the title is <text>', reports each sub-step, and refuses an open-ended goal instead of guessing", async () => {
    const dir = tmp();
    const { backend } = fakeBrowser({ "example.com": { title: "Example Domain" } });
    const ex = createLinuxExecutors({ name: "research", workdir: dir, browser: backend, resolve: publicResolver, settleMs: 1 });
    const steps: any[] = [];
    const c = ctx();
    c.progress = (s) => steps.push(s);
    const r: any = await ex["screen.goal"]({ goal: "Go to example.com and check the title is Example Domain" }, c);
    expect(r).toMatchObject({ ok: true, verified: true, data: { kind: "goal" } });
    expect(steps.map((s) => s.outcome)).toEqual(["note", "ok"]);
    expect(steps[1].verification).toMatchObject({ ok: true });
    const open: any = await ex["screen.goal"]({ goal: "find the cheapest flight to Lahore and book it" }, ctx());
    expect(open).toMatchObject({ ok: false, verified: false, data: { refused: true, needsPlan: true } });
  });
});

describe("the DevTools client against a DevTools-shaped server", () => {
  test("lists tabs, opens one, reads its real title and address, and sends input", async () => {
    // A minimal stand-in for Chromium's debugging port: /json/list, /json/new (PUT) and one tab's websocket.
    const received: { method: string; params: any }[] = [];
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      const tab = { id: "T1", type: "page", url: "https://example.com/", title: "Example Domain", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T1` };
      if (url.pathname === "/json/version") return void res.end(JSON.stringify({ Browser: "Fake/1" }));
      if (url.pathname === "/json/list") return void res.end(JSON.stringify([tab, { id: "W", type: "service_worker", url: "", title: "" }]));
      if (url.pathname === "/json/new" && req.method === "PUT") return void res.end(JSON.stringify(tab));
      res.statusCode = 404;
      res.end("{}");
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (raw: Buffer) => {
          const msg = JSON.parse(raw.toString());
          received.push({ method: msg.method, params: msg.params });
          const result = msg.method === "Runtime.evaluate" ? { result: { value: JSON.stringify({ title: "Example Domain", url: "https://example.com/", ready: "complete" }) } } : {};
          ws.send(JSON.stringify({ id: msg.id, result }));
        });
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    closers.push(() => new Promise<void>((r) => (server.closeAllConnections?.(), wss.close(), server.close(() => r()))));

    expect((await tabs(port)).map((t) => t.id)).toEqual(["T1"]); // pages only
    const tab = await newTab(port, "https://example.com");
    const s = await CdpSession.connect(tab.webSocketDebuggerUrl!);
    expect(await readPage(s)).toEqual({ title: "Example Domain", url: "https://example.com/", ready: "complete" });
    s.close();

    const backend = liveBrowserBackend({ port, profileDir: tmp(), chromiumPath: "/bin/true" });
    await backend.click(5, 6);
    await backend.type("hi");
    await backend.key("Enter");
    const methods = received.map((r) => r.method);
    expect(methods.filter((m) => m === "Input.dispatchMouseEvent")).toHaveLength(3);
    expect(methods).toContain("Input.insertText");
    expect(methods.filter((m) => m === "Input.dispatchKeyEvent")).toHaveLength(2);
    await expect(backend.key("F13")).rejects.toThrow(/supported keys/);
    await backend.close?.();
    writeFileSync(join(tmp(), "unused"), "");
  });
});

describe("the browser's environment (round 3)", () => {
  test("a computer with a display is X11 only: Wayland variables are dropped and DISPLAY is its own", async () => {
    const { browserEnv } = await import("./cdp");
    const env = browserEnv(":101", { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" });
    expect(env.DISPLAY).toBe(":101");
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
    expect(env.XDG_SESSION_TYPE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    // headless: left alone
    expect(browserEnv(undefined, { WAYLAND_DISPLAY: "wayland-0" }).WAYLAND_DISPLAY).toBe("wayland-0");
  });
});

describe("displayReady (round 3: WSLg mounts /tmp/.X11-unix read-only, so Xvfb only has the abstract socket)", () => {
  test("a socket file, or an abstract socket of the same name, means the display is ready", async () => {
    const { displayReady } = await import("./cdp");
    const table = "Num RefCount Protocol Flags Type St Inode Path\n0000: 2 0 00010000 0001 01 1 @/tmp/.X11-unix/X401\n0000: 2 0 00010000 0001 01 2 /tmp/.X11-unix/X0\n";
    const none = () => false;
    expect(displayReady("401", { exists: none, readUnix: () => table })).toBe(true); // abstract only (WSLg)
    expect(displayReady(":401", { exists: none, readUnix: () => table })).toBe(true);
    expect(displayReady(402, { exists: none, readUnix: () => table })).toBe(false);
    expect(displayReady("40", { exists: none, readUnix: () => table })).toBe(false); // not a prefix match
    expect(displayReady("7", { exists: (p) => p === "/tmp/.X11-unix/X7", readUnix: () => "" })).toBe(true); // an ordinary host
    expect(displayReady("401", { exists: none, readUnix: () => { throw new Error("no /proc"); } })).toBe(false);
    expect(displayReady("4;rm", { exists: () => true })).toBe(false); // never a path
  });
});

describe("trimTabs (round 3: a page per navigation, never closed, grew one computer from 0.6 to 1.4 GB in three minutes)", () => {
  test("keeps the newest few pages, closes the oldest, and never the page just opened", async () => {
    const closed: string[] = [];
    const ids = ["N", "A", "B", "C", "D", "E", "F"]; // most recently used first; N is the page just opened
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/json/list") return void res.end(JSON.stringify([...ids.map((id) => ({ id, type: "page", url: "https://x/", title: id })), { id: "W", type: "service_worker", url: "", title: "" }]));
      if (url.pathname.startsWith("/json/close/")) {
        closed.push(decodeURIComponent(url.pathname.slice("/json/close/".length)));
        return void res.end("Target is closing");
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))));
    const port = (server.address() as { port: number }).port;
    const { trimTabs, MAX_OPEN_TABS } = await import("./cdp");
    expect(MAX_OPEN_TABS).toBe(4);
    const gone = await trimTabs(port, 4, "N");
    expect(gone).toEqual(["D", "E", "F"]); // N + A + B + C stay
    expect(closed).toEqual(["D", "E", "F"]);
    // the page just opened survives even when it is listed last
    closed.length = 0;
    ids.splice(0, ids.length, "A", "B", "C", "D", "E", "N");
    const gone2 = await trimTabs(port, 4, "N");
    expect(gone2).toEqual(["D", "E"]);
    expect(gone2).not.toContain("N");
    // fewer pages than the limit: nothing closed
    closed.length = 0;
    ids.splice(0, ids.length, "A", "B");
    expect(await trimTabs(port, 4)).toEqual([]);
  });
});

describe("input.scroll is checked by what the page did (round 3b)", () => {
  const make = (start: number, max: number, step: number) => {
    const { backend } = fakeBrowser({});
    let y = start;
    backend.scroll = async (dy) => void (y = Math.max(0, Math.min(max, y + Math.min(step, Math.abs(dy)) * Math.sign(dy))));
    backend.scrollState = async () => ({ y, max });
    return createLinuxExecutors({ name: "r", workdir: tmp(), browser: backend, resolve: publicResolver, settleMs: 1 });
  };
  test("moved: verified true; at the edge: verified true and says so; a page that will not move: not ok; no state: unchanged behaviour", async () => {
    const moved: any = await make(0, 5000, 600)["input.scroll"]({ dy: 600 }, ctx());
    expect(moved).toMatchObject({ ok: true, verified: true });
    expect(moved.said).toMatch(/Scrolled down 600/);
    const edge: any = await make(4000, 4000, 600)["input.scroll"]({ dy: 600 }, ctx());
    expect(edge).toMatchObject({ ok: true, verified: true });
    expect(edge.said).toMatch(/bottom/);
    const top: any = await make(0, 4000, 600)["input.scroll"]({ dy: -600 }, ctx());
    expect(top).toMatchObject({ ok: true, verified: true });
    const stuck: any = await make(100, 4000, 0)["input.scroll"]({ dy: 600 }, ctx());
    expect(stuck).toMatchObject({ ok: false, verified: false });
    const { backend } = fakeBrowser({});
    backend.scroll = async () => undefined;
    const legacy: any = await createLinuxExecutors({ name: "r", workdir: tmp(), browser: backend })["input.scroll"]({ dy: 600 }, ctx());
    expect(legacy).toMatchObject({ ok: true, verified: null });
  });
});
