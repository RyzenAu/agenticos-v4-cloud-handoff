// Page-load measurement for the native-perf pass (28 Sep 2026).
//
//   node docs/native-perf-20260928/measure.mjs <label> [baseUrl] [runs]
//   PERF_MODE=first node ... <label>   # first visit after a fresh server start: no warm-up, one visit per page
//
// Conditions: a quiet preview dev server (ARGENTIC_PREVIEW=1 AGENTIC_OS_NO_BACKGROUND=1, vite dev),
// warmed with one visit per page first (vite transforms on first request), then `runs` rounds.
// Every run is a fresh headless Chrome context, so the browser cache is always cold.
// Writes docs/native-perf-20260928/results-<label>.json with every raw run and the medians.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const label = process.argv[2] || "run";
const base = (process.argv[3] || "http://127.0.0.1:8097").replace(/\/$/, "");
const runs = Number(process.argv[4] || 3);
const pages = process.env.PERF_PAGES ? process.env.PERF_PAGES.split(",").map((p) => "/" + p.split("/").pop()) : ["/", "/workspace", "/finance", "/memory", "/receptionist", "/jarvis", "/design"];
const extra = (process.env.PERF_EXTRA || "").split(",").filter(Boolean).map((p) => "/" + p.split("/").pop()); // spot-check only (names, no slash)
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const browser = await chromium.launch({ executablePath: chrome, headless: true });

async function visit(path) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const reqs = new Map();
  cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, type: e.type, bytes: 0, done: false }));
  cdp.on("Network.responseReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (r) { r.type = e.type; r.mime = e.response.mimeType; }
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r) { r.bytes = e.encodedDataLength; r.done = true; }
  });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 300)}`));

  const t0 = Date.now();
  await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });
  // "Hydrated": React has committed props onto the shell's <main> (the root layout, every page).
  const hydrated = await page
    .waitForFunction(
      () => {
        const el = document.querySelector("#op-main-content") || document.querySelector("main");
        if (!el) return false;
        if (!Object.keys(el).some((k) => k.startsWith("__reactProps"))) return false;
        return performance.now();
      },
      null,
      { timeout: 60_000, polling: 25 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  // Let the post-hydration overlays (shell/late.tsx) and lazy chunks land: wait until no script,
  // style, font or image request has started or finished for 1.5 s (max 15 s; API polling is
  // ignored), so every run counts the same set of modules.
  let lastActivity = Date.now();
  const polling = new Set(["Fetch", "XHR", "EventSource", "WebSocket", "Ping", "Other"]);
  cdp.on("Network.requestWillBeSent", (e) => { if (!polling.has(e.type)) lastActivity = Date.now(); });
  cdp.on("Network.loadingFinished", (e) => { if (!polling.has(reqs.get(e.requestId)?.type)) lastActivity = Date.now(); });
  const quietStart = Date.now();
  while (Date.now() - lastActivity < 1500 && Date.now() - quietStart < 15_000) await page.waitForTimeout(100);
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const res = performance.getEntriesByType("resource");
    const fontBlock = res
      .filter((r) => r.renderBlockingStatus === "blocking" && /fonts\.(googleapis|gstatic)\.com/.test(r.name))
      .reduce((a, r) => a + (r.responseEnd - r.startTime), 0);
    const blockingCss = res
      .filter((r) => r.renderBlockingStatus === "blocking")
      .map((r) => ({ url: r.name, ms: Math.round(r.responseEnd - r.startTime) }));
    return {
      ttfb: nav.responseStart - nav.startTime,
      dcl: nav.domContentLoadedEventEnd - nav.startTime,
      load: nav.loadEventEnd - nav.startTime,
      fcp: fcp ? fcp.startTime : null,
      fontBlock,
      blockingCss,
      finalPath: location.pathname,
    };
  });
  const list = [...reqs.values()];
  const isJs = (r) => r.type === "Script" || /javascript/.test(r.mime || "");
  const out = {
    path,
    ...timing,
    hydrated,
    wallMs: Date.now() - t0,
    requests: list.length,
    jsRequests: list.filter(isJs).length,
    jsBytes: list.filter(isJs).reduce((a, r) => a + r.bytes, 0),
    totalBytes: list.reduce((a, r) => a + r.bytes, 0),
    imageBytes: list.filter((r) => r.type === "Image").reduce((a, r) => a + r.bytes, 0),
    fontRequests: list.filter((r) => r.type === "Font" || /fonts\.(googleapis|gstatic)/.test(r.url)).map((r) => r.url.replace(base, "")),
    heavy: list
      .filter((r) => r.bytes > 150_000)
      .map((r) => ({ url: r.url.replace(base, "").slice(0, 140), kb: Math.round(r.bytes / 1024) })),
    errors,
  };
  await context.close();
  return out;
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

const first = process.env.PERF_MODE === "first";
if (!first) console.log(`warm-up ${base}`);
for (const p of first ? [] : [...pages, ...extra]) {
  const w = await visit(p);
  console.log(`  warm ${p} ${Math.round(w.wallMs)} ms, errors=${w.errors.length}`);
}
const raw = [];
for (let i = 0; i < (first ? 1 : runs); i++) for (const p of pages) raw.push({ run: i + 1, ...(await visit(p)) });
const spot = [];
for (const p of first ? [] : extra) spot.push(await visit(p));

const keys = ["ttfb", "fcp", "dcl", "load", "hydrated", "requests", "jsRequests", "jsBytes", "totalBytes", "imageBytes", "fontBlock"];
const medians = pages.map((p) => {
  const rs = raw.filter((r) => r.path === p);
  return Object.fromEntries([["path", p], ...keys.map((k) => [k, median(rs.map((r) => r[k]))])]);
});
console.table(
  medians.map((m) => ({
    path: m.path,
    ttfb: Math.round(m.ttfb),
    fcp: Math.round(m.fcp),
    dcl: Math.round(m.dcl),
    load: Math.round(m.load),
    hydrated: Math.round(m.hydrated),
    reqs: m.requests,
    jsKB: Math.round(m.jsBytes / 1024),
    imgKB: Math.round(m.imageBytes / 1024),
    fontBlock: Math.round(m.fontBlock),
  })),
);
for (const s of spot) console.log(`spot ${s.path} -> ${s.finalPath} hydrated=${Math.round(s.hydrated)} errors=${JSON.stringify(s.errors)}`);
const errs = raw.filter((r) => r.errors.length).map((r) => ({ path: r.path, run: r.run, errors: r.errors }));
if (errs.length) console.log("console errors:", JSON.stringify(errs, null, 1));

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  join(here, `results-${label}.json`),
  JSON.stringify({ label, base, runs, when: new Date().toISOString(), conditions: first ? "FIRST VISIT after a fresh vite dev start (no warm-up), fresh headless Chrome context per page" : "vite dev preview server, warm (one warm-up visit per page), fresh headless Chrome context per run (cold browser cache, cache disabled), 1440x900", medians, spot, raw }, null, 1),
);
await browser.close();
