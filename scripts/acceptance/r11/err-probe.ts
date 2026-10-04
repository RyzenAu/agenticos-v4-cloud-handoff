// R11 UI-CORE ad-hoc probe: every data call (and, with this matcher, the app code) fails; does the page still say so? Synthetic hub only.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const logs: string[] = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.type() + ": " + m.text().slice(0, 300)); });
page.on("pageerror", (e) => logs.push("PAGEERROR: " + e.message.slice(0, 300)));
// Same matcher as scripts/r11-ui-pages-states.ts (it also catches Vite's /@id/__x00__ module ids, so the app's code never loads).
// DATA_ONLY=1: only the hub's own /__… and /api/… calls fail; the app code still loads.
const isData = (u: string) => (process.env.DATA_ONLY ? /^\/(__|api\/)/ : /\/__|\/api\//).test(new URL(u).pathname);
await page.route((u) => isData(u.toString()), (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Synthetic failure" }) }));
await page.goto("http://127.0.0.1:8192" + (process.argv[2] ?? "/work"), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(23000);
await page.screenshot({ path: process.argv[3] ?? "D:/AgenticOS-tmp/r11/err.png" });
console.log(logs.slice(0, 15).join("\n"));
console.log("watchdog?", await page.evaluate(() => [typeof (window as any).__agenticOsLoadWatchdog, !!document.getElementById("os-load-watchdog")]));
await browser.close();
