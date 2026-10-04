#!/usr/bin/env bun
/**
 * Round 11 UI-CORE: before/after screenshots of the UI-CORE pages from a SYNTHETIC hub (scripts/acceptance/r7/hub.ts on 8120-8199,
 * synthetic data only). Headless Edge through playwright-core, its own throwaway profile. Never the live 8081.
 *
 *   bun scripts/acceptance/r11/ui-core-shots.ts --label before [--port 8192] [--only jarvis,agents] [--scheme dark|light]
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const arg = (n: string, d = "") => (process.argv.includes(`--${n}`) ? (process.argv[process.argv.indexOf(`--${n}`) + 1] ?? d) : d);
const LABEL = arg("label", "after");
const PORT = Number(arg("port", "8192"));
const SCHEME = (arg("scheme", "dark") as "dark" | "light");
const ONLY = arg("only").split(",").filter(Boolean);
if (PORT === 8081 || PORT < 8120 || PORT > 8199) throw new Error(`Refusing port ${PORT}: synthetic hubs only (8120-8199).`);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = resolve(arg("out", join(import.meta.dir, "..", "..", "..", "docs", "programme-20261001", "evidence", "r11-ui", "core", LABEL)));
mkdirSync(OUT, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const jobs = (await fetch(`${BASE}/__operator/coding/jobs`).then((r) => r.json()).catch(() => ({ jobs: [] }))) as { jobs: { id: string }[] };
const jobId = jobs.jobs[0]?.id;

type Shot = { name: string; path: string; before?: (page: import("playwright-core").Page) => Promise<void>; after?: (page: import("playwright-core").Page) => Promise<void> };

/**
 * The synthetic hub has no computer host, so the computer pane would be empty. For the "computer pane open" shots only, the browser is
 * given two FIXTURE shared computers (clearly named synthetic) and a drawn stand-in for the desktop snapshot. Nothing on the hub changes.
 */
const fixtureComputer = (name: string, label: string, over: Record<string, unknown> = {}) => ({ name, id: `fx-${name}`, label, kind: "cloud-computer", owner: "shared", adapter: "wsl", state: "online", desired: "running", desktop: true, capabilities: ["browser"], assigned: null, controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, takeoverPending: null, paused: null, resource: null, lastSeen: Date.now(), failure: null, recoveries: 0, createdBy: "usman", createdAt: Date.now(), viewer: { snapshot: true, vnc: false }, ...over });
const DESKTOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#20242b"/><rect x="0" y="0" width="1280" height="44" fill="#2d323b"/><circle cx="26" cy="22" r="7" fill="#c7a35a"/><rect x="60" y="12" width="520" height="20" rx="10" fill="#3a404b"/><rect x="80" y="100" width="760" height="36" rx="6" fill="#3a404b"/><rect x="80" y="160" width="1120" height="14" rx="4" fill="#343a44"/><rect x="80" y="190" width="980" height="14" rx="4" fill="#343a44"/><rect x="80" y="220" width="1060" height="14" rx="4" fill="#343a44"/><rect x="80" y="280" width="540" height="300" rx="10" fill="#2a2f38"/><rect x="660" y="280" width="540" height="300" rx="10" fill="#2a2f38"/><text x="640" y="700" fill="#8b93a1" font-family="sans-serif" font-size="26" text-anchor="middle">Synthetic desktop (screenshot fixture)</text></svg>`;
async function computerFixture(page: import("playwright-core").Page) {
  await page.route(/\/__computers$/, async (r) => {
    const res = await r.fetch().catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, computers: [fixtureComputer("research", "Research computer (synthetic)"), fixtureComputer("builder", "Builder computer (synthetic)")] }) });
  });
  await page.route(/\/__computers\/[^/]+\/screenshot/, (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: DESKTOP_SVG }));
  await page.addInitScript(() => { try { localStorage.setItem("agents.workspace.computer-panel.v2", JSON.stringify({ open: true, width: 640 })); } catch { /* none */ } });
}
const SHOTS: Shot[] = [
  { name: "home", path: "/business" },
  { name: "jarvis", path: "/jarvis" },
  { name: "jarvis-computer", path: "/jarvis", before: computerFixture, after: async (page) => { const b = page.getByRole("radio", { name: /^Computer$/ }).first(); if (await b.count()) await b.click().catch(() => {}); await page.waitForTimeout(1500); } },
  { name: "chat", path: "/chat" },
  { name: "agents", path: "/agents/workspace" },
  {
    name: "agents-computer",
    path: "/agents/workspace",
    before: computerFixture,
    after: async (page) => {
      const b = page.getByRole("button", { name: /show computer/i }).first();
      if (await b.count()) await b.click().catch(() => {});
      await page.waitForTimeout(1200);
    },
  },
  { name: "claude-code", path: "/agents/claude-code" },
  { name: "hermes", path: "/agents/hermes" },
  { name: "computers", path: "/computers" },
  { name: "coding", path: "/coding" },
  ...(jobId ? [{ name: "coding-job", path: `/coding/${jobId}` }] : []),
  { name: "activity", path: "/activity" },
  { name: "system", path: "/system" },
  { name: "settings", path: "/settings" },
  { name: "setup", path: "/setup" },
  { name: "models", path: "/models" },
  { name: "usage", path: "/usage" },
];
const WIDTHS = arg("widths").split(",").filter(Boolean).map(Number);
const SIZES = [
  { w: 1440, h: 900 },
  { w: 768, h: 1024 },
  { w: 390, h: 844 },
].filter((s) => !WIDTHS.length || WIDTHS.includes(s.w));

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
try {
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: SCHEME, reducedMotion: "reduce" });
    // The app reads its theme from localStorage ("theme"), not from the colour-scheme media query.
    if (SCHEME === "light") await ctx.addInitScript(() => { try { localStorage.setItem("theme", "light"); } catch { /* none */ } });
    // A populated Jarvis thread with a long name: one synthetic request this browser "sent" (src/lib/jarvis-sent.ts), next to the hub's seeded
    // job entries (which include failed and outcome-unclear ones).
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("jarvis-page.sent.v1", JSON.stringify([{ requestId: "jr-shot-1", at: Date.now() - 60_000, text: "Compare the Synthetic Northern Beaches Family & Cosmetic Dental Studio Pty Ltd site with the two nearest synthetic competitors and list what to fix first" }]));
      } catch { /* none */ }
    });
    for (const s of SHOTS) {
      if (ONLY.length && !ONLY.includes(s.name)) continue;
      // A page per shot, so one shot's fixtures never leak into the next.
      const page = await ctx.newPage();
      try {
        if (s.before) await s.before(page);
        await page.goto(BASE + s.path, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);
        if (s.after) await s.after(page);
        await page.screenshot({ path: join(OUT, `${s.name}-${size.w}.png`), fullPage: false });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        console.log(`${s.name}-${size.w}${overflow > 1 ? `  (horizontal overflow ${overflow}px)` : ""}`);
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
console.log(`Saved to ${OUT}`);
