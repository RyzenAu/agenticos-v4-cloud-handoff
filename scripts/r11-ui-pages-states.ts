#!/usr/bin/env bun
/** R11 UI-PAGES: loading, error, long-name and keyboard-focus states of the business pages, on a SYNTHETIC hub. Usage: bun scripts/r11-ui-pages-states.ts [port] */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const port = Number(process.argv[2] ?? 8193);
if (port === 8081) throw new Error("never the live hub");
const out = "docs/programme-20261001/evidence/r11-ui/pages/states";
mkdirSync(out, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const PAGES = { leads: "/leads", crm: "/crm", websites: "/websites", finance: "/finance", work: "/work", memory: "/memory", studio: "/studio", inbox: "/inbox-triage" };
const LONG = "Parramatta and Western Sydney Family Dental and Orthodontic Specialists Pty Ltd trading as Smile Studio Blacktown";
const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath: exe }).catch(() => chromium.launch({ headless: true }));
const isData = (u: string) => /\/__|\/api\//.test(new URL(u).pathname);
async function shot(name: string, w: number, setup: (p: import("playwright-core").Page) => Promise<void>, path: string, wait: number, after?: (p: import("playwright-core").Page) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await setup(page);
  await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(wait);
  if (after) await after(page);
  await page.screenshot({ path: `${out}/${name}.png` });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`${name} overflowX=${over}`);
  await ctx.close();
}
for (const [n, path] of Object.entries(PAGES)) {
  // loading: every data call is held for 20 s
  await shot(`${n}-loading-1440`, 1440, async (p) => { await p.route((u) => isData(u.toString()), async (r) => { await new Promise((x) => setTimeout(x, 20000)); await r.abort().catch(() => {}); }); }, path, 1200);
  // error: every data call fails
  await shot(`${n}-error-1440`, 1440, async (p) => { await p.route((u) => isData(u.toString()), (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Synthetic failure" }) })); }, path, 14000); // react-query retries first, so wait for the settled error
  // long names: synthetic names are replaced by a very long one in every JSON answer
  for (const w of [1440, 390]) {
    await shot(`${n}-longnames-${w}`, w, async (p) => { await p.route((u) => isData(u.toString()), async (r) => { try { const res = await r.fetch(); const t = await res.text(); await r.fulfill({ response: res, body: t.replace(/Demo Family Dentist|Placeholder Property|Bianca Brown Realty|Sample[A-Za-z ]+?(?=")/g, LONG) }); } catch { await r.continue().catch(() => {}); } }); }, path, 3500);
  }
  // keyboard focus: Tab six times
  await shot(`${n}-focus-1440`, 1440, async () => {}, path, 3500, async (p) => { for (let i = 0; i < 9; i++) await p.keyboard.press("Tab"); });
}
await browser.close();
