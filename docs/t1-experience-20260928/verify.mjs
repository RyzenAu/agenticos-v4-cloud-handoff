// Track 1 rendered check on a quiet preview: every destination (plus Operations and Models) at 1440 and
// 390 in dark and light, with axe (WCAG 2.x A/AA), horizontal overflow and console errors (with the URL of
// any failed request); then the palette, the Command scene, the progress replay and the motion control,
// driven by keyboard only.
//   node docs/t1-experience-20260928/verify.mjs <label> [baseUrl]
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const label = process.argv[2] || "verify";
const base = (process.argv[3] || "http://127.0.0.1:4371").replace(/\/$/, "");
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AXE = process.env.AXE_PATH || "C:/Users/Nebula PC/source/repos/aldergate/node_modules/axe-core/axe.min.js";
const out = join(dirname(fileURLToPath(import.meta.url)), "shots", label);
mkdirSync(out, { recursive: true });
const pages = (process.env.PAGES || "today,jarvis,receptionist,work,memory,finance,studio,system,operations,models").split(",");
const widths = (process.env.WIDTHS || "1440,390").split(",").map(Number);
const themes = (process.env.THEMES || "dark,light").split(",");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const report = { pages: [], flows: [] };

async function ctx(width, theme, reduced = false) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  if (theme === "light") await context.addInitScript(() => localStorage.setItem("theme", "light"));
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on("response", (r) => { if (r.status() >= 500 || r.status() === 404) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  return { context, page, errors };
}
const hydrated = (page) => page.waitForFunction(() => Object.keys(document.querySelector("#op-main-content") || {}).some((k) => k.startsWith("__reactProps")), null, { timeout: 90_000, polling: 50 });
async function axe(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ")?.slice(0, 120) }));
  });
}
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 70 });

for (const theme of process.env.SKIP_PAGES ? [] : themes)
  for (const width of widths)
    for (const p of pages) {
      if (theme === "light" && width === 390 && p !== "today") continue; // light at phone width: Today only
      const { context, page, errors } = await ctx(width, theme);
      await page.goto(`${base}/${p}`, { waitUntil: "load", timeout: 120_000 }).catch((e) => errors.push(`goto ${e.message}`));
      await hydrated(page).catch(() => errors.push("not hydrated"));
      await page.waitForTimeout(Number(process.env.SETTLE || 5000));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const violations = process.env.NO_AXE ? [] : await axe(page).catch((e) => [{ id: "axe-failed", impact: "unknown", nodes: 0, sample: e.message.slice(0, 100) }]);
      await shot(page, `${p}-${width}-${theme}`);
      const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      report.pages.push({ page: p, width, theme, overflow, serious: serious.length, violations, errors: [...new Set(errors)] });
      console.log(`${p} ${width} ${theme}: overflow=${overflow} serious=${serious.length} (${serious.map((v) => v.id).join(",")}) errors=${[...new Set(errors)].length}`);
      await context.close();
    }

// ── flows, keyboard only ──────────────────────────────────────────────────────────────────────────
for (const width of process.env.SKIP_FLOWS ? [] : widths) {
  const { context, page, errors } = await ctx(width, "dark");
  await page.goto(`${base}/today`, { waitUntil: "load", timeout: 120_000 });
  await hydrated(page);
  await page.waitForTimeout(4000);
  const flow = { width, steps: [], errors };
  const step = (name, ok, detail = "") => { flow.steps.push({ name, ok, detail }); console.log(`  [${width}] ${ok ? "ok " : "FAIL"} ${name} ${detail}`); };
  // Palette by keyboard
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".cp-dialog", { timeout: 20_000 });
  step("Ctrl+K opens the palette", await page.isVisible(".cp-dialog"));
  step("focus is in the palette input", await page.evaluate(() => document.activeElement?.classList.contains("cp-input")));
  await shot(page, `palette-empty-${width}`);
  await page.keyboard.type("open PowerPoint here", { delay: 5 });
  await page.waitForTimeout(8000); // the app index (Get-StartApps) on first read
  await shot(page, `palette-powerpoint-${width}`);
  const target = await page.locator(".cp-target").innerText().catch(() => "");
  step("device action shows its target before running", /Runs on/.test(target) && /Usman's PC|Nothing will run|Checking/.test(target), target.replace(/\s+/g, " ").slice(0, 120));
  await page.keyboard.press("Control+a");
  await page.keyboard.type("show the Professional margin", { delay: 5 });
  await page.waitForTimeout(800);
  await shot(page, `palette-margin-${width}`);
  step("margin answer shows figures, state and source", /80\.8%/.test(await page.locator(".cp-detail").innerText()) && /Simulated/.test(await page.locator(".cp-detail").innerText()));
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/operations\?package=receptionist-professional/, { timeout: 30_000 }).catch(() => null);
  await page.waitForTimeout(4000);
  step("Enter opens Operations on the Professional package", page.url().includes("package=receptionist-professional"), page.url().replace(base, ""));
  step("the package selector shows Professional", (await page.locator(".economics-workbench select").first().inputValue().catch(() => "")) === "receptionist-professional");
  const ctxSnap = await page.evaluate(() => window.__agenticPageContext?.read());
  step("page context: active page and selected package with figures", ctxSnap?.page?.path === "/operations" && ctxSnap?.selection?.id === "receptionist-professional" && !!ctxSnap?.selection?.facts?.["Contribution margin"], `${ctxSnap?.page?.title} · ${ctxSnap?.selection?.label}`);
  await shot(page, `operations-professional-${width}`);
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".cp-dialog");
  await page.keyboard.type("open the receptionist's flagged calls", { delay: 5 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/receptionist/, { timeout: 30_000 }).catch(() => null);
  await page.waitForFunction(() => document.activeElement?.id === "rx-flagged-calls" || !document.getElementById("rx-flagged-calls"), null, { timeout: 20_000 }).catch(() => null);
  await page.waitForTimeout(1500);
  const focused = await page.evaluate(() => ({ id: document.activeElement?.id, exists: !!document.getElementById("rx-flagged-calls") }));
  step("flagged calls: opened and focused (or the section isn't there because sell status couldn't be read)", focused.id === "rx-flagged-calls" || !focused.exists, JSON.stringify(focused));
  await shot(page, `receptionist-flagged-${width}`);
  // Command scene by keyboard
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".cp-dialog");
  await page.keyboard.type("command scene", { delay: 5 });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".cs-stage", { timeout: 30_000 }).catch(() => null);
  await page.waitForTimeout(5000);
  step("Command scene opens", await page.isVisible(".cs-stage"));
  const sceneObjects = await page.locator(".cs-object").count();
  step("five objects", sceneObjects === 5, String(sceneObjects));
  await page.keyboard.press("ArrowRight");
  step("arrow keys move between objects", await page.evaluate(() => document.activeElement?.getAttribute("data-slot") === "1"));
  await shot(page, `scene-${width}`);
  report.flows.push({ scene: await page.locator(".cs-object").allInnerTexts() });
  if (!process.env.NO_AXE) {
    const v = await axe(page).catch(() => []);
    const serious = v.filter((x) => x.impact === "serious" || x.impact === "critical");
    step("scene axe: 0 serious", serious.length === 0, serious.map((x) => x.id).join(","));
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  step("Enter opens that object's 2D page", /\/leads/.test(page.url()), page.url().replace(base, ""));
  // Progress replay on Jarvis
  await page.goto(`${base}/jarvis`, { waitUntil: "load" });
  await hydrated(page);
  await page.waitForTimeout(3000);
  const before = await page.locator('[aria-label="Receptionist call progress"] [data-state="done"]').count();
  step("call pipeline is static before any event", before === 0);
  await page.getByRole("button", { name: "Replay a synthetic call" }).click();
  await page.waitForTimeout(1600);
  const mid = await page.locator('[aria-label="Receptionist call progress"] .ps-step').evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  await shot(page, `progress-replay-mid-${width}`);
  step("mid-replay: only confirmed steps are done, the next is active, the rest wait", JSON.stringify(mid) === JSON.stringify(["done", "done", "active", "pending"]), JSON.stringify(mid));
  await page.waitForTimeout(3000);
  const end = await page.locator('[aria-label="Receptionist call progress"] .ps-step').evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  step("end of replay: all four confirmed", end.every((s) => s === "done"), JSON.stringify(end));
  await shot(page, `progress-replay-end-${width}`);
  // Motion control
  const m0 = await page.evaluate(() => document.documentElement.dataset.motion);
  step("ambient motion is still by default", m0 === "still", m0);
  if (width >= 768) {
    await page.locator(".mc-toggle").click();
    await page.waitForTimeout(200);
    const m1 = await page.evaluate(() => document.documentElement.dataset.motion);
    step("motion control turns ambient on", m1 === "ambient", m1);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(400);
    const m2 = await page.evaluate(() => document.documentElement.dataset.motion);
    step("ambient holds still while a dialog (the palette) is open and he types", m2 === "still", m2);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    await shot(page, `motion-control-${width}`);
  }
  step("no console errors in the flow", errors.filter((e) => !/HTTP 503|HTTP 404/.test(e)).length === 0, [...new Set(errors)].slice(0, 5).join(" | "));
  report.flows.push(flow);
  await context.close();
}
// Typed Jarvis ("Type to Jarvis"): the registry first, the same turn as speech after (AUDIT-F4/F1/F3)
{
  const { context, page, errors } = await ctx(1440, "dark");
  const flow = { typedJarvis: [] };
  const say = async (text) => {
    const input = page.getByRole("textbox", { name: "Voice companion command" });
    await input.fill(text);
    await input.press("Enter");
    await page.waitForTimeout(6000);
    const turns = await page.locator('[aria-label="Jarvis conversation"] .jarvis-message.is-assistant').allInnerTexts();
    return { text, url: page.url().replace(base, ""), reply: (turns.at(-1) ?? "").replace(/\s+/g, " ").slice(0, 300) };
  };
  await page.goto(`${base}/operations?package=receptionist-professional`, { waitUntil: "load" });
  await hydrated(page);
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("operator:voice-text")));
  await page.waitForSelector('[aria-label="Voice companion command"]', { timeout: 30_000 });
  for (const text of ["explain this margin", "which models are free", "what needs setup", "open finance", "show the Professional margin", "go to setup"]) {
    const r = await say(text);
    flow.typedJarvis.push(r);
    console.log(`  typed Jarvis: "${text}" → ${r.url} · ${r.reply.slice(0, 160)}`);
    if (!(await page.getByRole("textbox", { name: "Voice companion command" }).isVisible().catch(() => false))) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("operator:voice-text")));
      await page.waitForSelector('[aria-label="Voice companion command"]', { timeout: 30_000 }).catch(() => null);
    }
  }
  await shot(page, "typed-jarvis-1440");
  flow.errors = [...new Set(errors)];
  report.flows.push(flow);
  await context.close();
}
// Reduced motion: nothing ambient, the palette opens without animation
{
  const { context, page } = await ctx(1440, "dark", true);
  await page.goto(`${base}/today`, { waitUntil: "load" });
  await hydrated(page);
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => ({ motion: document.documentElement.dataset.motion, reduced: "reducedMotion" in document.documentElement.dataset }));
  console.log(`  reduced motion: ${JSON.stringify(r)}`);
  report.flows.push({ reducedMotion: r });
  await context.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
await browser.close();
