// L5 rendered check on a QUIET, SYNTHETIC preview (never 8081): /receptionist, /work and /chat at 1440
// and 390. It counts leaf text under 12 px (listing each element), checks sideways scroll and saves
// full-page screenshots. Receptionist data is the D1 synthetic fixture; nothing reaches a provider.
//   bun --no-env-file docs/l5-text-size-20260929/shots.ts <label> [outDir] [port]
// L5_WT serves another checkout (the BEFORE capture runs against a clean jarvis-voice worktree).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syntheticFixture } from "../d1-receptionist-calm-20260929/fixture";

const label = process.argv[2] ?? "shot";
const OUT = process.argv[3] ?? "D:/agent-scratch/l5";
const PORT = Number(process.argv[4] ?? 4395);
if (PORT === 8081) throw new Error("8081 is the live OS");
mkdirSync(OUT, { recursive: true });
const WT = process.env.L5_WT || join(import.meta.dir, "..", "..");
const tmpRoot = process.env.TMP ?? process.env.TEMP ?? "D:/agent-scratch/l5/tmp";
const home = mkdtempSync(join(tmpRoot, "l5-home-"));
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
    for (const route of ["receptionist", "work", "chat"]) {
      const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: "dark" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      const { snapshot, dashboard } = syntheticFixture();
      await page.route((url) => url.pathname.startsWith("/__receptionist"), (r) => {
        const path = new URL(r.request().url()).pathname;
        if (r.request().method() !== "GET") return r.fulfill({ status: 409, json: { error: "synthetic preview: read-only" } });
        if (path === "/__receptionist") return r.fulfill({ status: 200, json: snapshot });
        if (path === "/__receptionist/dashboard") return r.fulfill({ status: 200, json: { ...dashboard, generatedAt: new Date().toISOString() } });
        return r.fulfill({ status: 404, json: { error: "synthetic preview" } });
      });
      await page.goto(`${BASE}/${route}`, { waitUntil: "load", timeout: 180_000 });
      await page.waitForFunction(() => Object.keys(document.querySelector("#op-main-content") || {}).some((k) => k.startsWith("__reactProps")), null, { timeout: 120_000, polling: 100 }).catch(() => errors.push("not hydrated"));
      if (route === "receptionist") await page.getByText(/Not safe/).first().waitFor({ timeout: 60_000 }).catch(() => errors.push("no verdict"));
      await page.waitForTimeout(route === "chat" ? 9000 : 3500);
      const result = await page.evaluate(() => {
        const small: string[] = [];
        let total = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = (n.textContent || "").trim();
          const el = n.parentElement;
          if (!t || !el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
          total++;
          const px = parseFloat(cs.fontSize);
          if (px < 12) small.push(`${px}px <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 80)}"> ${t.slice(0, 40)}`);
        }
        return { small, total, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      await page.addStyleTag({ content: "html,body{height:auto!important;overflow:visible!important} #op-main-content,#op-main-content *:has(> [data-rx-page]){height:auto!important;max-height:none!important;overflow:visible!important}" });
      await page.screenshot({ path: join(OUT, `${label}-${route}-${width}.png`), fullPage: true });
      report.push({ route, width, small: result.small.length, total: result.total, overflow: result.overflow, items: result.small, errors: [...new Set(errors)] });
      console.log(`${label} ${route} ${width}: small=${result.small.length}/${result.total} overflow=${result.overflow} errors=${[...new Set(errors)].length}`);
      for (const s of result.small) console.log("   ", s);
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
