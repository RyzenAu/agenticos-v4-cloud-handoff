// The command palette, end to end in a quiet preview: the three starter commands typed, the device
// target preview, Enter on the navigations (lands on the page, focuses the section), keyboard only.
//   node docs/t1-experience-20260928/palette.mjs <label> [baseUrl]
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const label = process.argv[2] || "palette";
const base = (process.argv[3] || "http://127.0.0.1:4371").replace(/\/$/, "");
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const out = join(dirname(fileURLToPath(import.meta.url)), "shots", label);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const results = [];
for (const width of (process.env.SHOT_WIDTHS || "1440,390").split(",").map(Number)) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  await page.goto(`${base}/today`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(() => Object.keys(document.querySelector("#op-main-content") || {}).some((k) => k.startsWith("__reactProps")), null, { timeout: 60_000 });
  const run = async (text, name, enter) => {
    const t0 = Date.now();
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".cp-dialog", { timeout: 20_000 });
    const openMs = Date.now() - t0;
    await page.keyboard.type(text, { delay: 10 });
    await page.waitForTimeout(1500);
    const top = await page.locator(".cp-item[data-selected=true]").first().innerText().catch(() => "");
    const detail = await page.locator(".cp-detail").innerText().catch(() => "");
    await page.screenshot({ path: join(out, `${name}-${width}.jpg`), type: "jpeg", quality: 72 });
    let landed = null;
    if (enter) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(4500);
      landed = await page.evaluate(() => ({ path: location.pathname + location.search, focused: document.activeElement?.id || document.activeElement?.tagName, dialog: !!document.querySelector(".cp-dialog") }));
      await page.screenshot({ path: join(out, `${name}-landed-${width}.jpg`), type: "jpeg", quality: 72 });
    } else {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    results.push({ width, text, openMs, top: top.replace(/\s+/g, " ").slice(0, 120), detail: detail.replace(/\s+/g, " ").slice(0, 400), landed });
    console.log(width, text, "->", top.replace(/\s+/g, " ").slice(0, 80), landed ? JSON.stringify(landed) : "", `open ${openMs}ms`);
  };
  await run("", "empty", false);
  await run("open PowerPoint here", "powerpoint", false);
  await run("show the Professional margin", "margin", true);
  await page.goto(`${base}/today`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await run("open the receptionist's flagged calls", "flagged", true);
  results.push({ width, errors });
  await context.close();
}
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
await browser.close();
