// Screenshots for Track 1 (28 Sep 2026): every destination at 1440 and 390, plus named states.
//   node docs/t1-experience-20260928/shots.mjs <label> [baseUrl] [pages,comma,separated]
// Writes docs/t1-experience-20260928/shots/<label>/<page>-<width>.jpg and a JSON of console errors
// and horizontal overflow per shot. Quiet preview only (ARGENTIC_PREVIEW=1 AGENTIC_OS_NO_BACKGROUND=1).
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const label = process.argv[2] || "shots";
const base = (process.argv[3] || "http://127.0.0.1:4371").replace(/\/$/, "");
const pages = (process.argv[4] || "today,jarvis,receptionist,work,memory,finance,studio,system,operations").split(",").filter(Boolean);
const widths = (process.env.SHOT_WIDTHS || "1440,390").split(",").map(Number);
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "shots", label);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const report = [];
for (const w of widths) {
  for (const p of pages) {
    const context = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, deviceScaleFactor: 1, reducedMotion: process.env.REDUCED === "1" ? "reduce" : "no-preference" });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 240)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 240)}`));
    const path = p.startsWith("/") ? p : `/${p}`;
    await page.goto(base + path, { waitUntil: "load", timeout: 120_000 }).catch((e) => errors.push(`goto: ${e.message}`));
    await page.waitForTimeout(Number(process.env.SHOT_SETTLE_MS || 3500));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const name = path.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-") || "root";
    await page.screenshot({ path: join(out, `${name}-${w}.jpg`), type: "jpeg", quality: 70, fullPage: process.env.FULL === "1" });
    report.push({ page: path, width: w, overflow, errors });
    console.log(`${path} @${w}: overflow=${overflow} errors=${errors.length}`);
    await context.close();
  }
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
await browser.close();
