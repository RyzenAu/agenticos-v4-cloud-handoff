#!/usr/bin/env bun
/**
 * R12 rollout: before/after screenshots of the business and tool pages (Work, CRM, Leads, Finance, Receptionist, Inbox + triage, Calendar,
 * Agents workspace, Activity, Studio, Design, Memory, System, Settings) from a SYNTHETIC hub. 1440x900 and 390x844, dark, reduced motion.
 *
 *   bun scripts/r12-rollout-shots.ts <before|after> [port] [--only work,crm]
 *
 * Seed first (fresh folder per run; restart recovery turns seeded running jobs into "outcome unknown"):
 *   bun scripts/r12-rollout-seed.ts <port> <D:\AgenticOS-r12-data\rollout-<label>>
 *
 * Saved to docs/programme-20261001/evidence/r12-rollout/<label>/<shot>-<width>.png (+ -full.png for long pages).
 * The journey and the computers are browser fixtures (scripts/r12-ui-fixtures.ts); the hub is never changed by this script.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { computerFixture, journeyFixture, routeJourneys } from "./r12-ui-fixtures";

const label = process.argv[2] ?? "after";
const port = Number(process.argv[3] && /^\d+$/.test(process.argv[3]) ? process.argv[3] : 8160);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : [];
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only (8120-8199)");
if (!["before", "after"].includes(label)) throw new Error("label is before or after");
const base = `http://127.0.0.1:${port}`;
const out = join(import.meta.dir, "..", "docs", "programme-20261001", "evidence", "r12-rollout", label);
mkdirSync(out, { recursive: true });
const fx = await journeyFixture(base);

type Shot = { name: string; path: string; full?: boolean; setup?: (p: Page) => Promise<void>; act?: (p: Page) => Promise<void> };
/** Open the first record of a list and let the drawer settle. Selectors cover both the old and the new structure. */
const openFirst = (sel: string) => async (p: Page) => {
  const row = p.locator(sel).first();
  if (await row.count()) await row.click().catch(() => {});
  await p.waitForTimeout(900);
};
export const SHOTS: Shot[] = [
  { name: "work", path: "/work", full: true },
  { name: "work-decision", path: "/work", act: openFirst("[data-decision] button") },
  { name: "crm", path: "/crm", full: true },
  { name: "crm-record", path: "/crm", act: openFirst("[aria-label='Next steps'] li button, [data-crm-row], [data-testid='crm-directory'] button") },
  { name: "leads", path: "/leads", full: true },
  { name: "leads-record", path: "/leads", act: openFirst("[aria-label='Lead results'] li button") },
  { name: "finance", path: "/finance", full: true },
  { name: "receptionist", path: "/receptionist", full: true },
  { name: "inbox", path: "/inbox", full: true },
  { name: "inbox-mail", path: "/inbox", act: openFirst("[aria-label='Recent mail'] li button") },
  { name: "inbox-triage", path: "/inbox-triage", full: true },
  { name: "inbox-triage-mail", path: "/inbox-triage", act: openFirst("[data-testid='triage-table'] tr[data-row], [data-testid='triage-table'] li[data-row]") },
  { name: "calendar", path: "/calendar", full: true },
  { name: "calendar-event", path: "/calendar", act: openFirst(".ar-upcoming-agenda > button") },
  { name: "agents-workspace", path: "/agents/workspace", setup: computerFixture },
  { name: "agents-workspace-tasks", path: "/agents/workspace/research?tab=tasks", setup: computerFixture, full: true },
  { name: "agents-workspace-task", path: "/agents/workspace/research?tab=tasks", setup: computerFixture, act: openFirst("[data-task-row] button") },
  { name: "activity", path: "/activity", full: true },
  { name: "activity-job", path: "/activity", act: openFirst("[data-testid='activity-jobs'] tbody tr a") },
  { name: "studio", path: "/studio", full: true },
  { name: "studio-asset", path: "/studio", act: openFirst("[aria-label='Recent assets'] li button") },
  { name: "design", path: "/design", full: true },
  { name: "memory", path: "/memory", full: true },
  { name: "memory-record", path: "/memory", act: openFirst("[data-memory='find'] li button") },
  { name: "system", path: "/system", full: true },
  { name: "settings", path: "/settings", full: true },
];

if (import.meta.main) {
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
}
