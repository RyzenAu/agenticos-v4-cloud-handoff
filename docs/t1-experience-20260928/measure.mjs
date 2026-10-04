// Track 1 load and interaction speed, before vs after (median of 3), on a quiet preview.
//   node docs/t1-experience-20260928/measure.mjs <label> [baseUrl] [runs]
// Load: every destination, a fresh headless Chrome context per visit (cold browser cache), after one
// warm-up visit per page (Vite transforms on first request). "hydrated" = React has committed the shell's
// <main>. Interaction: Ctrl+K until a dialog is visible (the palette; before this track, the CRM palette),
// and a sidebar click until the destination's h1 shows.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const label = process.argv[2] || "run";
const base = (process.argv[3] || "http://127.0.0.1:4371").replace(/\/$/, "");
const runs = Number(process.argv[4] || 3);
const pages = ["/today", "/jarvis", "/receptionist", "/work", "/memory", "/finance", "/studio", "/system"];
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const hydratedFn = () => {
  const el = document.querySelector("#op-main-content");
  return el && Object.keys(el).some((k) => k.startsWith("__reactProps")) ? performance.now() : false;
};

async function load(path) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  let jsBytes = 0;
  let requests = 0;
  const types = new Map();
  cdp.on("Network.requestWillBeSent", (e) => { requests++; types.set(e.requestId, e.type); });
  cdp.on("Network.loadingFinished", (e) => { if (types.get(e.requestId) === "Script") jsBytes += e.encodedDataLength; });
  await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });
  const hydrated = await page.waitForFunction(hydratedFn, null, { timeout: 60_000, polling: 25 }).then((h) => h.jsonValue()).catch(() => null);
  await page.waitForTimeout(1500);
  const t = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return { ttfb: nav.responseStart, fcp: fcp ? fcp.startTime : null, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd };
  });
  await context.close();
  return { path, ...t, hydrated, requests, jsKB: Math.round(jsBytes / 1024) };
}

async function interactions() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/today`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(hydratedFn, null, { timeout: 60_000, polling: 25 });
  await page.waitForTimeout(5000); // let the settle-gated overlays mount
  const out = { paletteOpenMs: [], paletteSearchMs: [], navMs: [] };
  for (let i = 0; i < runs; i++) {
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.press("Control+k");
    await page.waitForSelector('[role="dialog"]', { state: "visible", timeout: 20_000 });
    const t1 = await page.evaluate(() => performance.now());
    out.paletteOpenMs.push(Math.round(t1 - t0));
    // Typing to the first result (the palette's own ranking; the old CRM palette needed a server round trip).
    const s0 = await page.evaluate(() => performance.now());
    await page.keyboard.type("finance");
    await page.waitForSelector('[role="dialog"] [cmdk-item]', { state: "visible", timeout: 20_000 }).catch(() => null);
    const s1 = await page.evaluate(() => performance.now());
    out.paletteSearchMs.push(Math.round(s1 - s0));
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 10_000 }).catch(() => null);
    await page.waitForTimeout(400);
  }
  for (let i = 0; i < runs; i++) {
    for (const [href, title] of [["/finance", "Finance"], ["/today", "Today"]]) {
      const n0 = await page.evaluate(() => performance.now());
      await page.click(`nav[aria-label="Main"] a[href="${href}"]`);
      await page.waitForFunction((t) => document.querySelector("#op-main-content h1")?.textContent?.trim().startsWith(t), title, { timeout: 30_000, polling: 16 });
      const n1 = await page.evaluate(() => performance.now());
      if (href === "/finance") out.navMs.push(Math.round(n1 - n0));
      await page.waitForTimeout(600);
    }
  }
  await context.close();
  return out;
}

for (const p of pages) await load(p); // warm-up
const raw = [];
for (let i = 0; i < runs; i++) for (const p of pages) raw.push(await load(p));
const table = pages.map((p) => {
  const rs = raw.filter((r) => r.path === p);
  return { path: p, ...Object.fromEntries(["ttfb", "fcp", "dcl", "load", "hydrated", "requests", "jsKB"].map((k) => [k, Math.round(median(rs.map((r) => r[k])) ?? NaN)])) };
});
console.table(table);
const inter = await interactions();
const summary = { paletteOpenMs: median(inter.paletteOpenMs), paletteSearchMs: median(inter.paletteSearchMs), sidebarNavToFinanceMs: median(inter.navMs) };
console.log("interactions (median of", runs, "):", JSON.stringify(summary), JSON.stringify(inter));
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, `perf-${label}.json`), JSON.stringify({ label, base, runs, at: new Date().toISOString(), table, interactions: inter, summary, raw }, null, 1));
await browser.close();
