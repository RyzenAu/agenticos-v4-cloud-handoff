#!/usr/bin/env bun
/**
 * Round 7 acceptance: the ACTUAL control inventory of every route, read from the rendered page (not from source): h1, h2s, and the named buttons,
 * links, fields and tabs inside the main content (the shell's own navigation is listed once). Used to build the coverage matrix in
 * ACCEPTANCE-R7.md and to reconcile it with worker F's APP-INVENTORY-R7.md. Reads only; clicks nothing.
 *
 *   bun scripts/acceptance/r7/inventory.ts [--hub http://127.0.0.1:8128]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeAll, HUB, OUT, session, SIZES } from "./lib";
import { ROUTES } from "./routes";

const s = await session(SIZES[0]);
const p = s.page;
const out: Record<string, unknown> = {};
let shell: string[] = [];
for (const r of ROUTES) {
  await p.goto(`${HUB}${r.path}`, { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  await p.waitForTimeout(1500);
  const inv = await p.evaluate(() => {
    const name = (e: Element) => (e.getAttribute("aria-label") || (e as HTMLInputElement).labels?.[0]?.textContent || e.textContent || (e as HTMLInputElement).placeholder || "").replace(/\s+/g, " ").trim().slice(0, 50);
    const main = document.getElementById("op-main-content") ?? document.querySelector("main") ?? document.body;
    const visible = (e: Element) => {
      const b = (e as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const ctrls = (root: Element) => [...new Set([...root.querySelectorAll("button, a[href], input, select, textarea, [role=tab], [role=radio], [role=switch]")].filter(visible).map((e) => `${e.getAttribute("role") ?? e.tagName.toLowerCase()}:${name(e)}`).filter((x) => !x.endsWith(":")))];
    const nav = document.querySelector("nav, aside");
    return {
      title: document.title,
      h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim().slice(0, 60)),
      h2: [...main.querySelectorAll("h2")].map((h) => (h.textContent ?? "").trim().slice(0, 60)).slice(0, 25),
      main: ctrls(main).slice(0, 120),
      shell: nav ? ctrls(nav) : [],
    };
  });
  if (!shell.length) shell = inv.shell;
  out[r.path] = { file: r.file, title: inv.title, h1: inv.h1, h2: inv.h2, controls: inv.main };
  console.log(`${r.path} [${r.file}] h1=${inv.h1.join("|")} · ${inv.main.length} controls · h2: ${inv.h2.slice(0, 6).join(" / ")}`);
}
writeFileSync(join(OUT, "inventory.json"), JSON.stringify({ hub: HUB, at: new Date().toISOString(), shell, routes: out }, null, 2));
console.log(`shell: ${shell.join(" | ")}`);
await closeAll();
