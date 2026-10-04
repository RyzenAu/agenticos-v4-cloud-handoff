// Ad-hoc probe for UI-CORE (synthetic hub only).
import { chromium } from "playwright-core";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const [path, w, h, out, ...steps] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, colorScheme: "dark", reducedMotion: "reduce" });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8192" + path, { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(1500);
for (const s of steps) {
  if (s.startsWith("radio:")) { await page.getByRole("radio", { name: new RegExp(s.slice(6), "i") }).first().click().catch(() => console.log("radio failed")); await page.waitForTimeout(900); }
  else if (s.startsWith("click:")) { await page.getByRole("button", { name: new RegExp(s.slice(6), "i") }).first().click().catch((e) => console.log("click failed", s)); await page.waitForTimeout(900); }
  else if (s.startsWith("tab:")) { await page.getByRole("tab", { name: new RegExp(s.slice(4), "i") }).first().click().catch(() => console.log("tab failed", s)); await page.waitForTimeout(900); }
  else if (s.startsWith("js:")) console.log(JSON.stringify(await page.evaluate(s.slice(3))));
}
await page.screenshot({ path: out, fullPage: process.env.FULL === "1" });
await browser.close();
