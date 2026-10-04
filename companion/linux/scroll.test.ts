import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CdpSession, findChromium, tabs } from "./cdp";
import { createLinuxExecutors, liveBrowserBackend } from "./executors-linux";

/**
 * Inner-container scrolling, against a REAL Chromium-family browser over DevTools (the same backend a bot computer runs), on local static
 * fixtures: a normal document, an app shell with nested panels (the body does not scroll), a modal, and a virtualised list. Skipped when the
 * host has no browser. Evidence label for these tests: real local browser, synthetic pages.
 */
const WINDOWS_CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const exe = process.env.MU_CHROMIUM && existsSync(process.env.MU_CHROMIUM) ? process.env.MU_CHROMIUM : (findChromium() ?? WINDOWS_CHROME ?? null);
const port = 9440 + Math.floor(Math.random() * 40);
const fixtures = resolve(import.meta.dir, "fixtures", "scroll");
const ctx = () => ({ signal: new AbortController().signal, owner: "usman" as const, log: () => undefined, progress: undefined as undefined | ((s: any) => void) });

const profile = exe ? mkdtempSync(join(tmpdir(), "scroll-fixture-")) : "";
const backend = exe ? liveBrowserBackend({ port, profileDir: profile, chromiumPath: exe, noSandbox: process.platform === "linux" }) : null;
const run = backend && exe ? createLinuxExecutors({ name: "scroll-test", workdir: join(profile, "work"), browser: backend }) : null;

async function open(name: string) {
  const tabId = await backend!.open(pathToFileURL(join(fixtures, name)).href);
  for (let i = 0; i < 40; i++) {
    const f = await backend!.read(tabId).catch(() => null);
    if (f?.ready === "complete") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return tabId;
}
async function evalIn(tabId: string, expr: string) {
  const t = (await tabs(port)).find((x) => x.id === tabId)!;
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    return await s.evaluate<any>(expr);
  } finally {
    s.close();
  }
}
async function scrollAll(tabId: string, dy: number, limit = 80) {
  const results: any[] = [];
  for (let i = 0; i < limit; i++) {
    const r: any = await run!["input.scroll"]({ dy, tabId }, ctx());
    results.push(r);
    if (r.data?.boundary || !r.ok) break;
  }
  return results;
}

afterAll(async () => {
  if (!backend) return;
  try {
    const v: any = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const s = await CdpSession.connect(v.webSocketDebuggerUrl);
    await s.send("Browser.close").catch(() => undefined);
    s.close();
  } catch {
    /* already gone */
  }
  await backend.close?.();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(profile, { recursive: true, force: true });
});

const d = exe ? describe : describe.skip;
d("scrolling finds the container that actually scrolls and measures the movement", () => {
  beforeAll(async () => {
    await backend!.ensure();
  }, 30_000);

  test("a normal document scrolls the page, reports the true bottom, then scrolls back up", async () => {
    const tab = await open("doc.html");
    const down = await scrollAll(tab, 600);
    expect(down.length).toBeGreaterThan(3);
    expect(down.slice(0, -1).every((r) => r.ok && r.verified === true && /Scrolled down \d+ px in the page/.test(r.said))).toBe(true);
    expect(down.at(-1).said).toMatch(/Already at the bottom of the page/);
    const y = await evalIn(tab, "Math.round(scrollY)");
    expect(y).toBeGreaterThan(2000);
    const up = await scrollAll(tab, -900);
    expect(up.at(-1).said).toMatch(/Already at the top/);
    expect(await evalIn(tab, "Math.round(scrollY)")).toBe(0);
  }, 60_000);

  test("nested panels: the body is locked, the main panel scrolls, then the inner code box when it is under the pointer", async () => {
    const tab = await open("panels.html");
    const down = await scrollAll(tab, 500);
    expect(down.slice(0, -1).every((r) => r.ok && r.verified === true)).toBe(true);
    expect(down.at(-1).said).toMatch(/Already at the bottom/);
    expect(await evalIn(tab, "document.querySelector('main').scrollTop")).toBeGreaterThan(1500);
    expect(await evalIn(tab, "Math.round(scrollY)")).toBe(0);
    // The side list is small and not under the pointer: it is not "the page scrolling".
    expect(await evalIn(tab, "document.querySelector('nav').scrollTop")).toBe(0);
  }, 60_000);

  test("a modal owns the scroll: its content moves, the page behind it does not", async () => {
    const tab = await open("modal.html");
    const down = await scrollAll(tab, 400);
    expect(down.slice(0, -1).every((r) => r.ok && r.verified === true && /dialog/.test(r.said))).toBe(true);
    expect(down.at(-1).said).toMatch(/Already at the bottom of the dialog/);
    expect(await evalIn(tab, "document.getElementById('content').scrollTop")).toBeGreaterThan(500);
    expect(await evalIn(tab, "Math.round(scrollY)")).toBe(0);
  }, 60_000);

  test("a virtualised list: the list container scrolls while rows are replaced; the boundary is the real end", async () => {
    const tab = await open("virtual.html");
    const down = await scrollAll(tab, 3000, 40);
    expect(down.slice(0, -1).every((r) => r.ok && r.verified === true)).toBe(true);
    expect(down.at(-1).said).toMatch(/Already at the bottom/);
    expect(await evalIn(tab, "document.getElementById('list').scrollTop")).toBeGreaterThan(39_000);
    expect(await evalIn(tab, "document.querySelector('.row:last-child').textContent")).toContain("Row 1000");
  }, 90_000);

  test("a tab that is gone is refused, never replaced by the neighbouring tab", async () => {
    const tab = await open("doc.html");
    await open("virtual.html");
    const before = await evalIn((await tabs(port)).find((t) => t.url.includes("virtual"))!.id, "document.getElementById('list').scrollTop");
    const r: any = await run!["input.scroll"]({ dy: 300, tabId: "no-such-tab" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.said).toMatch(/tab is closed/);
    expect(await evalIn((await tabs(port)).find((t) => t.url.includes("virtual"))!.id, "document.getElementById('list').scrollTop")).toBe(before);
    void tab;
  }, 60_000);
  // page.text re-checks the address the page is AT when it is read. The fixtures are file:// pages, so these two present the same real page script
  // at a public address and at a metadata address (what a page that moved itself after settling would look like).
  const readAs = (url: string) => createLinuxExecutors({ name: "pt", workdir: join(profile, `pt-${Math.random()}`), browser: { ...backend!, pageText: async (o: number, l: number, t?: string) => ({ ...(await backend!.pageText!(o, l, t)), url }) } as any, resolve: async () => ["93.184.216.34"] });

  test("page.text reads the page's words in chunks (main content first), with its links, for the hub's research reader", async () => {
    const tab = await open("panels.html");
    const reader = readAs("https://example.com/fixture");
    const first: any = await reader["page.text"]({ tabId: tab, offset: 0, limit: 400 }, ctx());
    expect(first.said).toMatch(/^Read 400 of/);
    expect(first.ok).toBe(true);
    expect(first.verified).toBe(true);
    expect(first.data.title).toBe("Scroll fixture: nested panels");
    expect(first.data.text.length).toBe(400);
    expect(first.data.total).toBeGreaterThan(1000);
    expect(first.data.text).toContain("Main panel");
    const next: any = await reader["page.text"]({ tabId: tab, offset: 400, limit: 400 }, ctx());
    expect(next.data.offset).toBe(400);
    expect(next.data.text).not.toBe(first.data.text);
    const gone: any = await reader["page.text"]({ tabId: "no-such-tab" }, ctx());
    expect(gone.ok).toBe(false);
    expect(gone.said).toMatch(/tab is closed/);
  }, 30_000);

  test("page.text refuses a page that is now at a private address (metadata, loopback, tailnet, the bridge) and returns none of its text", async () => {
    const tab = await open("panels.html");
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8081/", "http://100.64.0.11/", "http://172.19.48.1:8113/", "file:///etc/passwd"]) {
      const r: any = await readAs(url)["page.text"]({ tabId: tab }, ctx());
      expect(r.ok).toBe(false);
      expect(r.data?.refused).toBe(true);
      expect(r.data?.text).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain("Main panel");
    }
  }, 30_000);

  test("a big role=dialog that is not modal (a cookie banner) does not lock the page: the page still scrolls", async () => {
    const tab = await open("banner.html");
    const down = await scrollAll(tab, 600);
    expect(down.length).toBeGreaterThan(3);
    expect(down.slice(0, -1).every((r) => r.ok && r.verified === true && /Scrolled down \d+ px in the page/.test(r.said))).toBe(true);
    expect(down.at(-1).said).toMatch(/Already at the bottom of the page/);
    expect(await evalIn(tab, "Math.round(scrollY)")).toBeGreaterThan(2000);
  }, 60_000);
});
