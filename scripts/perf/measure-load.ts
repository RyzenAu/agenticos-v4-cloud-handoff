/**
 * Round 6 performance measurement, one method for before and after.
 *
 *   bun scripts/perf/measure-load.ts --url http://127.0.0.1:8154 --label before [--idle-seconds 60] [--navs 30]
 *
 * Real headless Chrome (playwright-core) against a hub. It records, per run:
 *  - first load of /business: requests, script/CSS/other bytes transferred (CDP encodedDataLength) and
 *    uncompressed (decoded body size), DOMContentLoaded, load, and "usable" (React is listening and the page
 *    has real text, so a click works);
 *  - slowest page-data calls (path only, never a body) during the first 6 s;
 *  - idle network requests per minute on each main route (fetch/xhr/eventsource only);
 *  - JS heap after a forced GC before and after N client-side navigations between the main routes.
 * Nothing about page content is recorded. Synthetic data only: point it at a test hub, never the live one.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Page, type BrowserContext } from "playwright-core";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const base = arg("url", "http://127.0.0.1:8154").replace(/\/$/, "");
const label = arg("label", "run");
const idleSeconds = Number(arg("idle-seconds", "60"));
const navCount = Number(arg("navs", "30"));
const out = arg("out", `docs/programme-20261001/perf-r6-${label}.json`);
const ROUTES = ["/business", "/leads", "/computers", "/coding", "/memory", "/operations"];
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!CHROME) throw new Error("no Chrome or Edge found");

const kind = (type: string, url: string) => (type === "Script" || /\.(m?js)(\?|$)/.test(url) ? "script" : type === "Stylesheet" ? "css" : type === "Font" ? "font" : type === "Image" ? "image" : type === "Document" ? "document" : "other");
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url.slice(0, 80);
  }
};

async function usable(page: Page, startedAt: number): Promise<number | null> {
  try {
    await page.waitForFunction(
      () => Object.keys(document).some((k) => k.startsWith("_reactListening")) && (document.body?.innerText ?? "").length > 300,
      undefined,
      { timeout: 30_000, polling: 25 },
    );
    return Date.now() - startedAt;
  } catch {
    return null;
  }
}

async function firstLoad(browser: import("playwright-core").Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const reqs = new Map<string, { url: string; type: string; start: number; end?: number; enc: number; decoded: number; status: number }>();
  cdp.on("Network.requestWillBeSent", (e: any) => reqs.set(e.requestId, { url: e.request.url, type: e.type ?? "Other", start: e.timestamp, enc: 0, decoded: 0, status: 0 }));
  cdp.on("Network.responseReceived", (e: any) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.status = e.response.status;
      r.type = e.type ?? r.type;
    }
  });
  cdp.on("Network.dataReceived", (e: any) => {
    const r = reqs.get(e.requestId);
    if (r) r.decoded += e.dataLength ?? 0;
  });
  cdp.on("Network.loadingFinished", (e: any) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.enc = e.encodedDataLength ?? 0;
      r.end = e.timestamp;
    }
  });
  const t0 = Date.now();
  let dcl = 0;
  let load = 0;
  page.on("domcontentloaded", () => (dcl = Date.now() - t0));
  page.on("load", () => (load = Date.now() - t0));
  await page.goto(base + "/business", { waitUntil: "commit", timeout: 120_000 });
  const usableMs = await usable(page, t0);
  await page.waitForTimeout(Math.max(0, 6000 - (Date.now() - t0)));
  const list = [...reqs.values()];
  const sum = (k: string, field: "enc" | "decoded") => list.filter((r) => kind(r.type, r.url) === k).reduce((s, r) => s + r[field], 0);
  const api = list.filter((r) => /\/__/.test(pathOf(r.url)) && r.end).map((r) => ({ path: pathOf(r.url), ms: Math.round(((r.end ?? r.start) - r.start) * 1000), status: r.status }));
  api.sort((a, b) => b.ms - a.ms);
  const result = {
    route: "/business",
    requests: list.length,
    scriptRequests: list.filter((r) => kind(r.type, r.url) === "script").length,
    scriptTransferredKB: Math.round(sum("script", "enc") / 1024),
    scriptUncompressedKB: Math.round(sum("script", "decoded") / 1024),
    cssTransferredKB: Math.round(sum("css", "enc") / 1024),
    cssUncompressedKB: Math.round(sum("css", "decoded") / 1024),
    totalTransferredKB: Math.round(list.reduce((s, r) => s + r.enc, 0) / 1024),
    apiCallsIn6s: api.length,
    dclMs: dcl,
    loadMs: load,
    usableMs,
    slowestApi: api.slice(0, 5),
    apiByPath: Object.fromEntries(Object.entries(api.reduce((m: Record<string, number>, a) => ((m[a.path] = (m[a.path] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])),
    biggestScripts: list.filter((r) => kind(r.type, r.url) === "script").sort((a, b) => b.decoded - a.decoded).slice(0, 12).map((r) => `${pathOf(r.url).slice(0, 90)} ${Math.round(r.decoded / 1024)} KB`),
  };
  await context.close();
  return result;
}

async function idleRoute(browser: import("playwright-core").Browser, route: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(base + route, { waitUntil: "commit", timeout: 120_000 });
  await usable(page, Date.now());
  await page.waitForTimeout(10_000); // settle: the page's own load-time fetches are not "idle"
  const hits: { path: string; type: string }[] = [];
  page.on("request", (r) => {
    const t = r.resourceType();
    if (t === "fetch" || t === "xhr" || t === "eventsource") hits.push({ path: pathOf(r.url()), type: t });
  });
  await page.waitForTimeout(idleSeconds * 1000);
  const by: Record<string, number> = {};
  for (const h of hits) by[h.path] = (by[h.path] ?? 0) + 1;
  await context.close();
  const perMin = (n: number) => Math.round((n * 60 * 10) / idleSeconds) / 10;
  return { route, seconds: idleSeconds, requests: hits.length, perMinute: perMin(hits.length), byPath: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12)) };
}

async function heap(page: Page, cdp: any): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await page.waitForTimeout(300);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const m = await cdp.send("Performance.getMetrics");
  return Math.round((m.metrics.find((x: any) => x.name === "JSHeapUsedSize")?.value ?? 0) / 1024 / 1024 * 10) / 10;
}

async function navigations(browser: import("playwright-core").Browser) {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(base + "/business", { waitUntil: "commit", timeout: 120_000 });
  await usable(page, Date.now());
  await page.waitForTimeout(6000);
  const start = await heap(page, cdp);
  const samples: number[] = [];
  let clicked = 0;
  for (let i = 0; i < navCount; i++) {
    const route = ROUTES[(i + 1) % ROUTES.length];
    const link = page.locator(`a[href="${route}"]`).first();
    if (await link.count()) {
      await link.click({ timeout: 5000 }).catch(() => {});
      clicked++;
    } else await page.evaluate((r) => { history.pushState({}, "", r); window.dispatchEvent(new PopStateEvent("popstate")); }, route);
    await page.waitForTimeout(1500);
    if ((i + 1) % 10 === 0) samples.push(await heap(page, cdp));
  }
  await page.waitForTimeout(3000);
  const end = await heap(page, cdp);
  await context.close();
  return { navigations: navCount, viaSidebarLinks: clicked, heapStartMB: start, heapEndMB: end, growthMB: Math.round((end - start) * 10) / 10, every10: samples };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--js-flags=--expose-gc"] });
const result: Record<string, unknown> = { label, at: new Date().toISOString(), url: base, mode: arg("mode", "dev"), browser: "chrome headless" };
const only = arg("only", "all");
result.firstLoad = await firstLoad(browser);
result.firstLoadWarm = await firstLoad(browser); // modules transformed once; the second is what a returning visit sees on a running hub
if (only === "first") {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ firstLoad: result.firstLoad, firstLoadWarm: result.firstLoadWarm }, null, 1));
  await browser.close();
  process.exit(0);
}
const idle = await Promise.all(ROUTES.slice(0, 4).map((r) => idleRoute(browser, r)));
result.idle = idle;
const idle2 = await Promise.all(ROUTES.slice(4).map((r) => idleRoute(browser, r)));
result.idle = [...idle, ...idle2];
result.memory = await navigations(browser);
await browser.close();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ firstLoadWarm: result.firstLoadWarm, idle: (result.idle as any[]).map((i) => [i.route, i.perMinute]), memory: result.memory }, null, 1));
