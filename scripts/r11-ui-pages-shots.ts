#!/usr/bin/env bun
/** R11 UI-PAGES: screenshot the business pages of a SYNTHETIC hub at three widths. Usage: bun scripts/r11-ui-pages-shots.ts <before|after> [port] */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const tag = process.argv[2] ?? "after";
const port = Number(process.argv[3] ?? 8193);
if (port === 8081) throw new Error("never the live hub");
const out = `docs/programme-20261001/evidence/r11-ui/pages/${tag}`;
mkdirSync(out, { recursive: true });
const PAGES: Record<string, string> = {
  crm: "/crm", leads: "/leads", "leads-today": "/leads?view=today", business: "/business", work: "/work", websites: "/websites", operations: "/operations",
  calendar: "/calendar", inbox: "/inbox", workspaces: "/workspaces", finance: "/finance", receptionist: "/receptionist",
  memory: "/memory", "memory-vault": "/memory/vault", "memory-map": "/memory-map", studio: "/studio", design: "/design", motion: "/motion",
};
const SIZES = [{ n: "1440", w: 1440, h: 900 }, { n: "768", w: 768, h: 1024 }, { n: "390", w: 390, h: 844 }];
const only = process.argv[4]?.split(",");
const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath: exe }).catch(() => chromium.launch({ headless: true }));
for (const s of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, reducedMotion: "reduce" });
  for (const [name, path] of Object.entries(PAGES)) {
    if (only && !only.includes(name)) continue;
    const page = await ctx.newPage();
    const errs: string[] = [];
    page.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
    try {
      await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(3500);
      await page.screenshot({ path: `${out}/${name}-${s.n}.png`, fullPage: false });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(`${name}@${s.n} ok overflowX=${over}${errs.length ? " errors=" + errs.join("|") : ""}`);
    } catch (e) { console.log(`${name}@${s.n} FAIL ${(e as Error).message.slice(0, 80)}`); }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
