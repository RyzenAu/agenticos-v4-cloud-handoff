#!/usr/bin/env bun
/**
 * R12 UI: real interactions on the SYNTHETIC hub (scripts/acceptance/r7/hub.ts + scripts/r12-ui-seed.ts), never the live 8081.
 *
 *   bun scripts/r12-ui-verify.ts [port]
 *
 * Checks (PASS only on what the page itself shows after the action):
 *   1. Jarvis: a typed request is accepted (the box clears and the request shows as sent).
 *   2. Jarvis: the computer pane opens, resizes from the keyboard and by dragging, and hides.
 *   3. Departments: the index opens a department from the keyboard; a queue row opens the task drawer; Escape closes it and clears ?task.
 *   4. Keyboard focus is visible (a ring or outline on the focused control).
 *   5. At 390 px, long client names wrap inside the viewport on Home, Jarvis and the Research department (no sideways scroll).
 * Writes docs/programme-20261001/evidence/r12-ui/verify.json and a few interaction screenshots beside the after/ shots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { computerFixture, journeyFixture, routeJourneys } from "./r12-ui-fixtures";

const port = Number(process.argv[2] ?? 8150);
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only (8120-8199)");
const base = `http://127.0.0.1:${port}`;
const out = join(import.meta.dir, "..", "docs", "programme-20261001", "evidence", "r12-ui");
mkdirSync(join(out, "verify"), { recursive: true });
const fx = await journeyFixture(base);
const results: { check: string; status: "PASS" | "FAIL"; evidence: unknown }[] = [];
const record = (check: string, ok: boolean, evidence: unknown) => {
  results.push({ check, status: ok ? "PASS" : "FAIL", evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check} :: ${JSON.stringify(evidence).slice(0, 300)}`);
};
const settle = async (p: Page) => {
  await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(1500);
};

const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, executablePath: exe[0] })).catch(() => chromium.launch({ headless: true, executablePath: exe[1] }));
try {
  // ---- 1. send a message on Jarvis
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    const p = await ctx.newPage();
    await routeJourneys(p, fx);
    await p.goto(`${base}/jarvis`, { waitUntil: "domcontentloaded" });
    await settle(p);
    const words = `Synthetic check ${new Date().toISOString().slice(11, 19)}: what is running for Research right now?`;
    const box = p.locator("#assistant-request");
    await box.click();
    await box.fill(words);
    await p.getByRole("button", { name: "Send request" }).click();
    // Shown as "Sent to Jarvis" until the conversation has it, then as the conversation's own message: either is the accepted request.
    const sent = await p.locator("[data-jarvis-thread] li", { hasText: words }).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
    const cleared = (await box.inputValue()) === "";
    record("Jarvis: a typed request is accepted (box clears, request shown as sent)", sent && cleared, { sent, cleared });
    await p.screenshot({ path: join(out, "verify", "jarvis-sent-1440.png") });
    await ctx.close();
  }

  // ---- 2. computer pane: open, resize (keyboard + drag), hide
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    const p = await ctx.newPage();
    await routeJourneys(p, fx);
    await computerFixture(p);
    await p.addInitScript(() => { try { localStorage.removeItem("agents.workspace.computer-panel.v2"); } catch { /* none */ } });
    await p.goto(`${base}/jarvis`, { waitUntil: "domcontentloaded" });
    await settle(p);
    await p.getByRole("button", { name: /show computer/i }).first().click();
    const sep = p.getByRole("separator", { name: "Resize the computer panel" });
    const opened = await sep.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    const w0 = Number(await sep.getAttribute("aria-valuenow"));
    await sep.focus();
    await p.keyboard.press("ArrowLeft");
    await p.keyboard.press("ArrowLeft");
    const w1 = Number(await sep.getAttribute("aria-valuenow"));
    const box = await sep.boundingBox();
    if (box) {
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
      await p.mouse.up();
    }
    const w2 = Number(await sep.getAttribute("aria-valuenow"));
    await p.screenshot({ path: join(out, "verify", "jarvis-computer-resized-1440.png") });
    await p.getByRole("button", { name: /hide computer/i }).first().click();
    const hidden = await sep.waitFor({ state: "detached", timeout: 5000 }).then(() => true).catch(() => false);
    record("Jarvis: computer pane opens", opened, { opened });
    record("Jarvis: computer pane resizes from the keyboard", w1 !== w0, { before: w0, afterKeys: w1 });
    record("Jarvis: computer pane resizes by dragging", w2 !== w1, { afterKeys: w1, afterDrag: w2 });
    record("Jarvis: computer pane hides", hidden, { hidden });
    await ctx.close();
  }

  // ---- 3 + 4. departments: keyboard open, drawer, Escape; focus visible
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    const p = await ctx.newPage();
    await routeJourneys(p, fx);
    await p.goto(`${base}/departments`, { waitUntil: "domcontentloaded" });
    await settle(p);
    // Reach the Research row with the keyboard only (Tab), as a keyboard user would.
    for (let i = 0; i < 80; i++) {
      await p.keyboard.press("Tab");
      if (await p.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Open Research")) break;
    }
    const ring = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      // A ring is drawn when some box-shadow layer has a colour that isn't fully transparent.
      const visibleShadow = cs.boxShadow !== "none" && cs.boxShadow.split(/,(?![^(]*\))/).some((l) => !/rgba\([^)]*,\s*0\)/.test(l));
      return { label: el.getAttribute("aria-label"), focusVisible: el.matches(":focus-visible"), outline: cs.outlineStyle !== "none" && cs.outlineWidth !== "0px" ? `${cs.outlineStyle} ${cs.outlineWidth}` : null, ring: visibleShadow };
    });
    await p.screenshot({ path: join(out, "verify", "departments-focus-1440.png") });
    record("Keyboard focus is visible on a department row (reached by Tab)", !!ring && ring.label === "Open Research" && ring.focusVisible && (!!ring.outline || ring.ring), ring);
    await p.keyboard.press("Enter");
    const navigated = await p.waitForURL(/\/departments\/research$/, { timeout: 8000 }).then(() => true).catch(() => false);
    await settle(p);
    record("Departments: Enter on a row opens that department", navigated, { url: p.url() });
    // Tab to the first control on the page and check it shows a ring too.
    await p.keyboard.press("Tab");
    const tabRing = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const cs = el ? getComputedStyle(el) : null;
      return el && cs ? { tag: el.tagName, text: (el.textContent ?? "").trim().slice(0, 40), outline: cs.outlineStyle !== "none" ? `${cs.outlineStyle} ${cs.outlineWidth}` : null, shadow: cs.boxShadow !== "none" ? "yes" : null } : null;
    });
    record("Keyboard focus is visible after Tab", !!tabRing && (!!tabRing.outline || !!tabRing.shadow), tabRing);
    const first = p.locator('[data-testid="dept-queue"] tr[data-row]').first();
    const title = (await first.locator("[data-dept-task-title]").textContent())?.trim() ?? "";
    await first.click();
    const dialog = p.getByRole("dialog");
    const open = await dialog.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    const dialogTitle = open ? ((await dialog.locator("h2").first().textContent())?.trim() ?? "") : "";
    const withTask = /[?&]task=/.test(p.url());
    await p.screenshot({ path: join(out, "verify", "department-drawer-1440.png") });
    record("Departments: a queue row opens its task drawer (title matches, ?task in the URL)", open && dialogTitle === title && withTask, { title, dialogTitle, url: p.url() });
    await p.keyboard.press("Escape");
    const closed = await dialog.waitFor({ state: "detached", timeout: 5000 }).then(() => true).catch(() => false);
    await p.waitForTimeout(300);
    record("Departments: Escape closes the drawer and clears ?task", closed && !/[?&]task=/.test(p.url()), { closed, url: p.url() });
    await ctx.close();
  }

  // ---- 5. long names at 390
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" });
    for (const path of ["/business", "/jarvis", "/departments", "/departments/research", "/departments/research?task=" + encodeURIComponent((fx.journey.steps[0].jobId as string) ?? "")]) {
      const p = await ctx.newPage();
      await routeJourneys(p, fx);
      await p.goto(base + path, { waitUntil: "domcontentloaded" });
      await settle(p);
      const m = await p.evaluate(() => {
        const over = document.documentElement.scrollWidth - window.innerWidth;
        // Every element whose text names the long synthetic client must sit inside the viewport.
        const els = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && /Orchard Hills Family Dental and Orthodontic/.test(e.textContent ?? ""));
        const outside = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); }).length;
        return { over, longNames: els.length, outside };
      });
      record(`390 px: ${path} has no sideways scroll and long names wrap inside the viewport`, m.over <= 1 && m.outside === 0, m);
      await p.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "verify.json"), JSON.stringify({ at: new Date().toISOString(), hub: base, synthetic: true, results }, null, 2));
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
