#!/usr/bin/env bun
/** R11 visual pass 2: populated before/after screenshots of Studio, Inbox (+triage), Calendar, Receptionist, Operations, Design and Activity at 1440 and 390. SYNTHETIC hub only. Usage: bun scripts/r11-visual-shots2.ts <before|after> [port] */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const tag = process.argv[2] ?? "after";
const port = Number(process.argv[3] ?? 8193);
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only");
const base = `http://127.0.0.1:${port}`;
const out = `docs/programme-20261001/evidence/r11-visual/pages2/${tag}`;
mkdirSync(out, { recursive: true });
const PAGES: Record<string, string> = {
  studio: "/studio", inbox: "/inbox", "inbox-triage": "/inbox-triage", calendar: "/calendar", receptionist: "/receptionist",
  "receptionist-calls": "/receptionist?view=calls", operations: "/operations", design: "/design", "design-library": "/design", activity: "/activity",
};
const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath: exe }).catch(() => chromium.launch({ headless: true }));
for (const s of [{ n: "1440", w: 1440, h: 900 }, { n: "390", w: 390, h: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, reducedMotion: "reduce" });
  for (const [name, path] of Object.entries(PAGES)) {
    const page = await ctx.newPage();
    try {
      await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(path.startsWith("/design") ? 9000 : 3500);
      if (name === "design-library") { await page.getByText("Library", { exact: true }).first().click().catch(() => {}); await page.waitForTimeout(4000); }
      await page.screenshot({ path: `${out}/${name}-${s.n}.png`, fullPage: true });
      console.log(`${name}@${s.n} overflowX=${await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)}`);
    } catch (e) { console.log(`${name}@${s.n} FAIL ${(e as Error).message.slice(0, 60)}`); }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
export {};
