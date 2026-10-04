// R11 UI-CORE bounded sweep (synthetic hub only): controls under 44 px or without an accessible name, per page.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const w = Number(process.env.W ?? 1440);
const page = await (await browser.newContext({ viewport: { width: w, height: 900 } })).newPage();
for (const path of (process.env.PAGES ?? "/jarvis,/agents/workspace,/business,/system").split(",")) {
  await page.goto("http://127.0.0.1:8192" + path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const main = document.querySelector("main") ?? document.body;
    for (const el of main.querySelectorAll<HTMLElement>("button, a[href], [role=button], [role=tab], [role=radio], input, select, textarea, summary")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || (el as HTMLInputElement).placeholder || "").trim();
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
      if (!name) out.push(`NO NAME <${el.tagName.toLowerCase()} class="${el.className.toString().slice(0, 60)}">`);
      if (!inline && (r.height < 44 && r.width < 44 || r.height < 32)) out.push(`SMALL ${Math.round(r.width)}x${Math.round(r.height)} "${name.slice(0, 40)}"`);
    }
    return [...new Set(out)];
  });
  console.log(`== ${path} (${found.length})\n` + found.slice(0, 25).join("\n"));
}
await browser.close();
