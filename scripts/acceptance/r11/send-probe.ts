// R11 UI-CORE ad-hoc probe (synthetic hub only): type a harmless request in the /jarvis composer and see it accepted, not dropped.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
// SLOW=1: the companion's code never arrives (its chunk hangs), so the composer must keep the words and say it's still connecting.
if (process.env.SLOW) await page.route((u) => /floating-oracle|voice-companion/.test(u.toString()), () => undefined);
await page.goto("http://127.0.0.1:8192/jarvis", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
// A real click first: in the first seconds after load, a text box that takes focus without a key or click is let go (keyboard-start.ts).
await page.click("#assistant-request");
await page.keyboard.type("what time is it");
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 200)));
await page.evaluate(() => { window.addEventListener("operator:voice-text", (e) => console.log("VT", JSON.stringify((e as CustomEvent).detail))); window.addEventListener("operator:voice-text-accepted", () => console.log("ACCEPTED")); });
page.on("console", (m) => { if (/VT|ACCEPTED/.test(m.text())) console.log(m.text()); });
console.log("before", JSON.stringify(await page.evaluate(() => { const b = document.querySelector("[data-assistant-request] button[type=submit]") as HTMLButtonElement; const t = document.querySelector("#assistant-request") as HTMLTextAreaElement; return { active: document.activeElement?.id || document.activeElement?.tagName, disabled: b?.disabled, readOnly: t?.readOnly, val: t?.value, n: document.querySelectorAll("#assistant-request").length }; })));
await (process.env.CLICK ? page.click("[data-assistant-request] button[type=submit]") : page.keyboard.press("Enter"));
await page.waitForTimeout(Number(process.env.WAIT ?? 4000));
console.log(JSON.stringify({ box: await page.inputValue("#assistant-request"), alert: await page.locator("#jarvis-send-error").count(), sent: await page.getByText("Sent to Jarvis").count(), connecting: await page.getByText("Still connecting to Jarvis").count(), nothingSent: await page.getByText("nothing was sent").count() }));
await page.screenshot({ path: process.argv[2] ?? "D:/AgenticOS-tmp/r11/send.png" });
await browser.close();
