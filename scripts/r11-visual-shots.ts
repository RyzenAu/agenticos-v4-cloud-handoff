#!/usr/bin/env bun
/** R11 visual pass: populated before/after screenshots at 1440 and 390 on a SYNTHETIC hub. Usage: bun scripts/r11-visual-shots.ts <before|after> [port] */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const tag = process.argv[2] ?? "after";
const port = Number(process.argv[3] ?? 8193);
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only");
const base = `http://127.0.0.1:${port}`;
const out = `docs/programme-20261001/evidence/r11-visual/pages/${tag}`;
mkdirSync(out, { recursive: true });
const token = ((await (await fetch(`${base}/__token`)).json()) as { token: string }).token;
const snap = ((await (await fetch(`${base}/__crm/ops`, { method: "POST", headers: { "content-type": "application/json", "x-claude-os-token": token }, body: JSON.stringify({ name: "crm.snapshot", input: {} }) })).json()) as any).data;
const co = snap.companies.find((c: any) => /Parramatta/.test(c.name)) ?? snap.companies.at(-1);
const PAGES: Record<string, string> = {
  crm: "/crm", "crm-pipeline": "/crm?view=pipeline", "crm-company-quote": `/crm?ref=${encodeURIComponent(`crm:company:${co.id}`)}&tab=deals`,
  leads: "/leads", work: "/work", websites: "/websites", finance: "/finance", "finance-business": "/business?view=finance", memory: "/memory", studio: "/studio",
  inbox: "/inbox", calendar: "/calendar", receptionist: "/receptionist", operations: "/operations", design: "/design",
};
const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath: exe }).catch(() => chromium.launch({ headless: true }));
for (const s of [{ n: "1440", w: 1440, h: 900 }, { n: "390", w: 390, h: 844 }]) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, reducedMotion: "reduce" });
  for (const [name, path] of Object.entries(PAGES)) {
    const page = await ctx.newPage();
    try {
      await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(3500);
      await page.screenshot({ path: `${out}/${name}-${s.n}.png`, fullPage: true });
      console.log(`${name}@${s.n} overflowX=${await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)}`);
    } catch (e) { console.log(`${name}@${s.n} FAIL ${(e as Error).message.slice(0, 60)}`); }
    await page.close();
  }
  await ctx.close();
}
await browser.close();

export {};
