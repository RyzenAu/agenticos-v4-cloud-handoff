#!/usr/bin/env bun
/**
 * Round 7 acceptance, matrix rows R-* (every src/routes page): load each page in a real browser at 1440, 834 and 390 as the confirmed owner, and
 * record: a visible h1 (or the page's own heading), no error boundary, no horizontal overflow, console errors, failed requests (path and status
 * only, never a body), the skip link as the first Tab stop with a visible focus ring, and Escape closing the command palette. Then back/forward
 * across three pages, a reload that keeps the route, and an offline client-side navigation that must say so rather than go blank.
 *
 *   bun scripts/acceptance/r7/routes-sweep.ts [--hub http://127.0.0.1:8128] [--only /activity,/leads] [--sizes 1440,390]
 */
import { arg, closeAll, expect, flat, focusRing, HUB, pageHealth, record, session, shot, SIZES, writeResults } from "./lib";
import { ROUTES } from "./routes";


const only = arg("only") ? arg("only").split(",") : null;
const sizes = arg("sizes") ? SIZES.filter((s) => arg("sizes").split(",").includes(s.tag)) : SIZES;

async function main() {
  const s = await session(sizes[0]);
  const p = s.page;
  const failed: string[] = [];
  p.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  p.on("requestfailed", (r) => failed.push(`ERR ${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText ?? ""}`));

  for (const size of sizes) {
    await p.setViewportSize({ width: size.w, height: size.h });
    for (const r of ROUTES) {
      if (only && !only.includes(r.path)) continue;
      const row = `R ${r.path}`;
      s.errors.length = 0;
      failed.length = 0;
      try {
        await p.goto(`${HUB}${r.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
        await p.waitForTimeout(1200);
      } catch (e) {
        record(row, `loads at ${size.tag}`, "FAIL", { error: String(e).slice(0, 200) });
        continue;
      }
      const h = await pageHealth(p);
      const url = p.url().replace(HUB, "");
      const is404 = r.path === "/no-such-page" || /no-such/.test(r.path);
      const notFoundText = /not found|doesn.t exist|no such|isn.t (here|on this hub)|couldn.t find|no (bot|agent|job|workspace) called|no job|isn.t one of/i.test(await p.evaluate(() => document.body.innerText));
      const ok = !h.crashed && !h.overflow && (h.h1.length > 0 || is404) && (!r.expectRedirect || r.expectRedirect.test(url)) && (!is404 || notFoundText);
      expect(row, `renders at ${size.tag}: h1, no crash, no overflow${r.expectRedirect ? ", redirects" : ""}${is404 ? ", says not found" : ""}`, ok, { url, ...h, ...(is404 ? { notFoundText } : {}) });
      const errs = [...s.errors];
      const fails = [...new Set(failed)].filter((f) => !/favicon|\.map$/.test(f));
      // Failed requests are a finding when the page did not explain them; recorded, and FAIL only for 5xx or a page error.
      const serious = errs.filter((e) => e.startsWith("pageerror")).length > 0 || fails.some((f) => /^5\d\d /.test(f));
      record(row, `no page errors or 5xx at ${size.tag}`, serious ? "FAIL" : "PASS", { pageErrors: errs.filter((e) => e.startsWith("pageerror")).slice(0, 3), failedRequests: fails.slice(0, 8), consoleErrors: errs.length });
      if (size.tag === "390" || r.path === "/agents/workspace" || r.path === "/activity") await shot(p, `route-${size.tag}${r.path.replace(/[^a-z0-9]+/gi, "_")}`);
      // Keyboard: the first Tab stop is the skip link, with a visible ring; Enter moves focus into the main content.
      if (size.tag === "1440" && !is404) {
        // A fresh load, then the very first Tab (no click first: a click moves the sequential focus starting point).
        await p.goto(`${HUB}${r.path}`, { waitUntil: "domcontentloaded" });
        await p.waitForTimeout(1500);
        await p.keyboard.press("Tab");
        const f = await focusRing(p);
        await p.keyboard.press("Enter");
        await p.waitForTimeout(200);
        // The effect that matters: the NEXT Tab lands inside the main content, not back in the sidebar.
        await p.keyboard.press("Tab");
        const after = await p.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          const main = document.getElementById("op-main-content") ?? document.querySelector("main");
          const focusable = main ? [...main.querySelectorAll("a[href], button, input, select, textarea, [tabindex]:not([tabindex=\"-1\"])")].filter((x) => (x as HTMLElement).offsetParent !== null && !(x as HTMLButtonElement).disabled).length : 0;
          return { hash: location.hash, nextStop: (el?.getAttribute("aria-label") || el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40), inMain: !!el && !!main && main.contains(el), mainFocusable: focusable };
        });
        // A page whose main content has nothing focusable (an empty state) cannot pass the "next Tab" half: judge the skip link alone there.
        expect(row, "keyboard: skip link is the first Tab stop with a focus ring; after Enter the next Tab lands in the main content", f.focused && /skip/i.test(f.name) && !!f.ring && (after.inMain || after.mainFocusable === 0), { first: f, after });
      }
    }
  }

  // Back and forward across three pages (client-side history), and reload keeps the page.
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(`${HUB}/activity`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  await p.getByRole("link", { name: /^Automations$/ }).first().click();
  await p.waitForURL(/\/automations/, { timeout: 15_000 }).catch(() => undefined);
  await p.getByRole("link", { name: /^Memory$/ }).first().click();
  await p.waitForURL(/\/memory/, { timeout: 15_000 }).catch(() => undefined);
  const trail: string[] = [p.url().replace(HUB, "")];
  await p.goBack();
  await p.waitForTimeout(1500);
  trail.push(p.url().replace(HUB, ""));
  const backH1 = (await pageHealth(p)).h1;
  await p.goBack();
  await p.waitForTimeout(1500);
  trail.push(p.url().replace(HUB, ""));
  await p.goForward();
  await p.waitForTimeout(1500);
  trail.push(p.url().replace(HUB, ""));
  expect("R generic", "back and forward move through Activity → Automations → Memory and render each page", trail.join(" ") === "/memory /automations /activity /automations" && backH1.length > 0, { trail, backH1 });
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  expect("R generic", "reload keeps the route and renders it", /\/automations/.test(p.url()) && (await pageHealth(p)).h1.length > 0, { url: p.url().replace(HUB, "") });

  // Escape closes the command palette and returns focus.
  await p.keyboard.press("Control+k");
  await p.waitForTimeout(600);
  const open = await p.locator('[role="dialog"]').count();
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  const closed = (await p.locator('[role="dialog"]').count()) === 0;
  expect("R generic", "Ctrl+K opens the command palette; Escape closes it", open > 0 && closed, { open, closed });

  // Offline: client-side navigation while the network is down must show a message, not a blank or a crash.
  for (const [from, link, to] of [["/activity", /^Agents$/, "/agents/workspace"], ["/business", /^Activity$/, "/activity"]] as const) {
    await s.ctx.setOffline(false);
    await p.goto(`${HUB}${from}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);
    await s.ctx.setOffline(true);
    s.errors.length = 0;
    await p.getByRole("link", { name: link }).first().click().catch(() => undefined);
    await p.waitForTimeout(5000);
    const text = flat(await p.evaluate(() => document.body.innerText));
    const h = await pageHealth(p);
    const honest = /offline|can.t reach|couldn.t (load|reach)|no connection|network|try again|reconnect/i.test(text);
    expect(`R ${to}`, `offline client navigation from ${from} says it is offline (no blank page, no crash)`, honest && !h.crashed && text.length > 40, { url: p.url().replace(HUB, ""), crashed: h.crashed, h1: h.h1, says: (text.match(/.{0,60}(offline|can.t reach|couldn.t (load|reach)|no connection|network|try again|reconnect).{0,60}/i) ?? [""])[0], chars: text.length });
    await shot(p, `offline${to.replace(/[^a-z0-9]+/gi, "_")}`);
    await s.ctx.setOffline(false);
  }
}

try {
  await main();
} finally {
  writeResults("routes-sweep");
  await closeAll();
}
