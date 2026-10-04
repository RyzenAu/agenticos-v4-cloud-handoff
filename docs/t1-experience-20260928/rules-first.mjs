// Palette rules-first check: "receptionist status" offers "Ask Jarvis" first (the page stays below);
// Enter opens Jarvis in Text mode with the request (this branch alone), which runs the same voice turn
// (a quiet preview refuses that POST with 409, so only the palette ordering is checked here).
import { chromium } from "playwright-core";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const base = (process.argv[2] || "http://127.0.0.1:4371").replace(/\/$/, "");
const out = join(dirname(fileURLToPath(import.meta.url)), "shots", "final");
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto(`${base}/today`, { waitUntil: "load" });
await p.waitForFunction(() => Object.keys(document.querySelector("#op-main-content") || {}).some((k) => k.startsWith("__reactProps")), null, { timeout: 90_000 });
await p.waitForTimeout(4000);
await p.keyboard.press("Control+k");
await p.waitForSelector(".cp-dialog");
await p.keyboard.type("receptionist status", { delay: 5 });
await p.waitForTimeout(800);
const items = (await p.locator(".cp-item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").slice(0, 90));
console.log("items:", JSON.stringify(items.slice(0, 3)));
await p.screenshot({ path: join(out, "palette-rules-first-1440.jpg"), type: "jpeg", quality: 70 });
await p.keyboard.press("Enter");
await p.waitForTimeout(9000);
const turns = await p.locator('[aria-label="Jarvis conversation"] .jarvis-message').allInnerTexts();
console.log("jarvis:", JSON.stringify(turns.map((t) => t.replace(/\s+/g, " ").slice(0, 200))));
await p.screenshot({ path: join(out, "palette-rules-first-answer-1440.jpg"), type: "jpeg", quality: 70 });
await b.close();
