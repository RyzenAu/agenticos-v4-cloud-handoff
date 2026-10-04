#!/usr/bin/env bun
/**
 * R12 UI structure pass: before/after screenshots of Home, Jarvis and Departments from a SYNTHETIC hub seeded by
 * scripts/acceptance/r7/hub.ts (seed + start) and scripts/r12-ui-seed.ts. 1440x900 and 390x844, dark theme, reduced motion.
 *
 *   bun scripts/r12-ui-shots.ts <before|after> [port] [--only home,jarvis]
 *
 * Saved to docs/programme-20261001/evidence/r12-ui/<label>/<shot>-<width>.png (viewport) and <shot>-<width>-full.png (whole page,
 * for the long pages). The journey and the computers are browser fixtures (scripts/r12-ui-fixtures.ts); the hub is never changed.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { computerFixture, journeyFixture, routeJourneys } from "./r12-ui-fixtures";

const label = process.argv[2] ?? "after";
const port = Number(process.argv[3] && /^\d+$/.test(process.argv[3]) ? process.argv[3] : 8150);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : [];
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only (8120-8199)");
if (!["before", "after"].includes(label)) throw new Error("label is before or after");
const base = `http://127.0.0.1:${port}`;
const out = join(import.meta.dir, "..", "docs", "programme-20261001", "evidence", "r12-ui", label);
mkdirSync(out, { recursive: true });
const fx = await journeyFixture(base);

type Shot = { name: string; path: string; full?: boolean; setup?: (p: Page) => Promise<void>; act?: (p: Page) => Promise<void> };
const SHOTS: Shot[] = [
  { name: "home", path: "/business", full: true },
  { name: "jarvis", path: "/jarvis" },
  {
    name: "jarvis-computer",
    path: "/jarvis",
    setup: async (p) => {
      await computerFixture(p);
      await p.addInitScript(() => { try { localStorage.setItem("agents.workspace.computer-panel.v2", JSON.stringify({ open: true, width: 560 })); } catch { /* none */ } });
    },
    act: async (p) => {
      const b = p.getByRole("button", { name: /show computer/i }).first();
      if (await b.count()) await b.click().catch(() => {});
      await p.waitForTimeout(1200);
    },
  },
  {
    name: "jarvis-journey",
    path: "/jarvis",
    act: async (p) => {
      await p.locator("[data-thread-journey]").first().scrollIntoViewIfNeeded().catch(() => {});
      await p.waitForTimeout(500);
    },
  },
  { name: "departments", path: "/departments" },
  { name: "department-research", path: "/departments/research", full: true },
  {
    name: "department-task",
    path: "/departments/research",
    act: async (p) => {
      const row = p.locator("[data-dept-task]").first();
      if (await row.count()) await row.click().catch(() => {});
      await p.waitForTimeout(800);
    },
  },
  // The nearest surface the old build has for "a department's work": the Research agent's Tasks & Files tab.
  { name: "agents-research", path: "/agents/workspace/research?tab=tasks" },
];

const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, executablePath: exe[0] })).catch(() => chromium.launch({ headless: true, executablePath: exe[1] }));
try {
  for (const size of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: "dark", reducedMotion: "reduce" });
    for (const s of SHOTS) {
      if (only.length && !only.includes(s.name)) continue;
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));
      try {
        await routeJourneys(page, fx);
        if (s.setup) await s.setup(page);
        await page.goto(base + s.path, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2500);
        if (s.act) await s.act(page);
        await page.screenshot({ path: join(out, `${s.name}-${size.w}.png`) });
        if (s.full) await page.screenshot({ path: join(out, `${s.name}-${size.w}-full.png`), fullPage: true });
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        console.log(`${s.name}-${size.w}${over > 1 ? ` OVERFLOW ${over}px` : ""}${errors.length ? ` errors: ${errors.join(" | ")}` : ""}`);
      } catch (e) {
        console.log(`${s.name}-${size.w} FAILED ${(e as Error).message.split("\n")[0]}`);
      }
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`Saved to ${out}`);
