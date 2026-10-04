// D1 rendered check on a QUIET, SYNTHETIC preview (never 8081): /receptionist at 1440 and 390, collapsed
// and expanded, with the fixture.ts snapshot and dashboard served by route interception. No request
// reaches Retell, Twilio or the agency feed: every /__receptionist* call is fulfilled here, and the
// server runs with an empty temp home and without any receptionist/feed/Retell/Twilio variables.
//   bun --no-env-file docs/d1-receptionist-calm-20260929/shots.ts <label> [outDir] [port]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syntheticFixture } from "./fixture";

const label = process.argv[2] ?? "shot";
const OUT = process.argv[3] ?? "D:/agent-scratch/d1";
const PORT = Number(process.argv[4] ?? 4391);
if (PORT === 8081) throw new Error("8081 is the live OS");
mkdirSync(OUT, { recursive: true });
// D1_WT: serve another checkout (the BEFORE capture runs against a clean jarvis-voice worktree).
const WT = process.env.D1_WT || join(import.meta.dir, "..", "..");
const tmpRoot = process.env.TMP ?? process.env.TEMP ?? "D:/agent-scratch/d1/tmp";
const home = mkdtempSync(join(tmpRoot, "d1-home-"));
// Names only are filtered (values are never read or printed).
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/RETELL|RECEPTIONIST|AGENCY|FEED|TWILIO|TOKEN|SECRET|KEY|PASSWORD/i.test(k)) env[k] = v;
Object.assign(env, { ARGENTIC_PREVIEW: "1", AGENTIC_OS_NO_BACKGROUND: "1", USERPROFILE: home, HOME: home });
const server = Bun.spawn([process.execPath, "--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: WT, env, stdout: "ignore", stderr: "ignore" });
const BASE = `http://127.0.0.1:${PORT}`;
const started = Date.now();
for (;;) {
  try { await (await fetch(`${BASE}/today`, { signal: AbortSignal.timeout(120_000) })).text(); break; } catch { if (Date.now() - started > 240_000) throw new Error("preview did not start"); await Bun.sleep(500); }
}
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390]) {
    for (const reduced of [false]) {
      const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: "dark", reducedMotion: reduced ? "reduce" : "no-preference" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
      const { snapshot, dashboard } = syntheticFixture();
      await page.route((url) => url.pathname.startsWith("/__receptionist"), (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() !== "GET") return route.fulfill({ status: 409, json: { error: "synthetic preview: read-only" } });
        if (path === "/__receptionist") return route.fulfill({ status: 200, json: snapshot });
        if (path === "/__receptionist/dashboard") return route.fulfill({ status: 200, json: { ...dashboard, generatedAt: new Date().toISOString() } });
        return route.fulfill({ status: 404, json: { error: "synthetic preview" } });
      });
      await page.goto(`${BASE}/receptionist`, { waitUntil: "load", timeout: 180_000 });
      await page.waitForFunction(() => Object.keys(document.querySelector("#op-main-content") || {}).some((k) => k.startsWith("__reactProps")), null, { timeout: 120_000, polling: 100 }).catch(() => errors.push("not hydrated"));
      await page.getByText(/Not safe/).first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      const measure = () => page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      // The shell scrolls its own main region: unclip it so a full-page capture shows the whole page.
      await page.addStyleTag({ content: "html,body{height:auto!important;overflow:visible!important} #op-main-content,#op-main-content *:has(> [data-rx-page]){height:auto!important;max-height:none!important;overflow:visible!important}" });
      const collapsed = await measure();
      await page.screenshot({ path: join(OUT, `${label}-${width}-collapsed.png`), fullPage: true });
      const top = await page.screenshot({ path: join(OUT, `${label}-${width}-first-screen.png`), fullPage: false });
      void top;
      // Expand every disclosure on the page (buttons with aria-expanded=false). Dialog triggers
      // (aria-haspopup, e.g. "Sign off", "Mark followed up") are never clicked.
      const main = page.locator("#op-main-content");
      for (let pass = 0; pass < 3; pass++) {
        const closed = main.locator('button[aria-expanded="false"]:not([aria-haspopup]):not([aria-controls^="ds-info-"])');
        const n = await closed.count();
        if (!n) break;
        for (let i = n - 1; i >= 0; i--) await closed.nth(i).click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.mouse.move(0, 0);
      const expanded = await measure();
      await page.screenshot({ path: join(OUT, `${label}-${width}-expanded.png`), fullPage: true });
      // A tabbed page (D1 round 2): each tab, its disclosures opened, one full-page capture per tab.
      const tabs: Record<string, number> = {};
      if (await page.locator('[role="tablist"]').count()) {
        for (const id of ["calls", "golive", "clients", "economics", "health"]) {
          await page.locator(`#rx-tab-${id}`).click();
          await page.waitForTimeout(300);
          const panel = page.locator(`#rx-panel-${id}`);
          for (let pass = 0; pass < 3; pass++) {
            const closed = panel.locator('button[aria-expanded="false"]:not([aria-haspopup]):not([aria-controls^="ds-info-"])');
            const n = await closed.count();
            if (!n) break;
            for (let i = n - 1; i >= 0; i--) await closed.nth(i).click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(400);
          }
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.mouse.move(0, 0);
          tabs[id] = (await measure()).overflow;
          await page.screenshot({ path: join(OUT, `${label}-${width}-tab-${id}.png`), fullPage: true });
        }
        await page.locator("#rx-tab-overview").click();
      }
      report.push({ width, collapsed, expanded, tabs, errors: [...new Set(errors)] });
      console.log(`${label} ${width}: overflow collapsed=${collapsed.overflow} expanded=${expanded.overflow} tabs=${JSON.stringify(tabs)} errors=${[...new Set(errors)].length}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(server.pid)]);
  rmSync(home, { recursive: true, force: true });
}
writeFileSync(join(OUT, `${label}-report.json`), JSON.stringify(report, null, 2));
process.exit(0);
