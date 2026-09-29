// Rendered check of the REVIEW-T1 fixes on a quiet preview (SYNTHETIC: /__commands and the command entry
// are stubbed with page.route where noted; nothing runs on a device).
//   node docs/t1-experience-20260928/review-fixes.mjs [baseUrl]
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] || "http://127.0.0.1:4371").replace(/\/$/, "");
const out = join(dirname(fileURLToPath(import.meta.url)), "shots", "review-fixes");
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name} ${detail}`); };
const hydrated = (p) => p.waitForFunction(() => Object.keys(document.querySelector("#op-main-content") || {}).some((k) => k.startsWith("__reactProps")), null, { timeout: 90_000 });

async function palettePage({ apps, target, targetDelay = 0 } = {}) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const posts = [];
  p.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
  if (apps) await p.route("**/__commands/apps", (r) => r.fulfill({ json: { state: "live", lastSuccess: new Date().toISOString(), items: apps.map((name) => ({ name })) } }));
  if (target) await p.route("**/__commands/target**", async (r) => { if (targetDelay) await new Promise((s) => setTimeout(s, targetDelay)); await r.fulfill({ json: target }); });
  await p.route("**/__operator/screen/command", (r) => { posts.push(r.request().postData()); return r.fulfill({ status: 409, json: { error: "quiet copy" } }); });
  await p.route("**/__websites/overview", (r) => r.fulfill({ json: { sites: [{ id: "a", name: "Aldergate", url: "https://aldergate.muventures.com.au", kind: "flagship" }] } }));
  await p.goto(`${base}/today`, { waitUntil: "load" });
  await hydrated(p);
  await p.waitForTimeout(3000);
  return { ctx, p, posts };
}
const openPalette = async (p, text) => {
  await p.keyboard.press("Control+k");
  // The first open loads the palette chunk (a cold dev compile can take a while); one retry.
  if (!(await p.waitForSelector(".cp-dialog", { timeout: 60_000 }).catch(() => null))) {
    await p.keyboard.press("Control+k");
    await p.waitForSelector(".cp-dialog", { timeout: 60_000 });
  }
  await p.keyboard.type(text, { delay: 5 });
  await p.waitForTimeout(900);
  return (await p.locator(".cp-item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").slice(0, 80));
};

// Fix 2: money and action words
{
  const { ctx, p, posts } = await palettePage({ apps: ["Telstra", "Send to OneNote", "PowerPoint"] });
  for (const [text, shot] of [["pay the Telstra bill", "pay"], ["press send", "send"], ["open stake.com", "stake"]]) {
    const items = await openPalette(p, text);
    await p.screenshot({ path: join(out, `palette-${shot}.jpg`), type: "jpeg", quality: 70 });
    const noDevice = !items.some((i) => /\b(App|Website)$/.test(i));
    check(`palette "${text}": Ask Jarvis first, no app or site offered`, items[0]?.startsWith("Ask Jarvis") && noDevice, JSON.stringify(items.slice(0, 3)));
    await p.keyboard.press("Enter");
    await p.waitForTimeout(800);
    check(`palette "${text}": Enter posts no plain open`, !posts.some((x) => /"utterance":"open /.test(x ?? "")), JSON.stringify(posts));
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(300);
  }
  await ctx.close();
}
// Fix 3: early Enter while the target is still being checked
{
  const { ctx, p, posts } = await palettePage({ apps: ["PowerPoint"], target: { ok: true, deviceId: "usman-pc", label: "Usman's PC", owner: "usman", online: true, routing: "devices" }, targetDelay: 3000 });
  await openPalette(p, "open PowerPoint here");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(300);
  const waiting = await p.locator(".cp-detail").innerText();
  await p.screenshot({ path: join(out, "palette-device-early-enter.jpg"), type: "jpeg", quality: 70 });
  check("early Enter: nothing posted while 'Checking which device'", posts.length === 0 && /Checking which device/.test(waiting) && /Nothing runs until the device is shown/.test(waiting), waiting.replace(/\s+/g, " ").slice(0, 160));
  await p.waitForTimeout(3500);
  check("the device is shown before any run", /Usman's PC/.test(await p.locator(".cp-detail").innerText()) && posts.length === 0);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1500);
  check("second Enter runs it through the command entry", posts.length === 1, JSON.stringify(posts));
  const detail = await p.locator(".cp-detail").innerText();
  check("fix 4: a refused run (409) doesn't say 'Recorded in the job history'", !/Recorded in the job history/.test(detail), detail.replace(/\s+/g, " ").slice(0, 160));
  await ctx.close();
}
// Fix 4: target refused → no POST, no "Recorded"
{
  const { ctx, p, posts } = await palettePage({ apps: ["PowerPoint"], target: { ok: false, reason: "device offline", deviceId: "mehroz-laptop", label: "Mehroz's laptop", routing: "devices" } });
  await openPalette(p, "open PowerPoint here");
  await p.waitForTimeout(800);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(800);
  const detail = await p.locator(".cp-detail").innerText();
  await p.screenshot({ path: join(out, "palette-device-refused.jpg"), type: "jpeg", quality: 70 });
  check("refused target: no POST and no 'Recorded'", posts.length === 0 && !/Recorded in the job history/.test(detail), detail.replace(/\s+/g, " ").slice(0, 160));
  // Item 11: Escape returns focus to where it was
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  const focused = await p.evaluate(() => document.activeElement?.tagName + (document.activeElement === document.body ? "(body)" : ""));
  check("Escape returns focus off <body>", !/body/i.test(focused), focused);
  await ctx.close();
}
// Fix 5: no Live badge over an empty value, anywhere on the destinations
for (const page of ["today", "studio", "system", "models", "finance", "receptionist"]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/${page}`, { waitUntil: "load" });
  await hydrated(p).catch(() => {});
  await p.waitForTimeout(6000);
  const bad = await p.evaluate(() =>
    [...document.querySelectorAll(".sh-signal")]
      .filter((t) => t.querySelector('.hs-state[data-state="live"]'))
      .map((t) => ({ label: t.querySelector(".sh-signal-label")?.textContent?.trim(), value: t.querySelector(".sh-signal-value")?.textContent?.trim() ?? "", fresh: t.textContent?.includes("Stale ·") }))
      .filter((x) => x.value === "—" || x.value === "" || /unknown/i.test(x.value) || x.fresh),
  );
  await p.screenshot({ path: join(out, `${page}-badges.jpg`), type: "jpeg", quality: 70 });
  check(`${page}: no Live badge over an empty, unknown or stale value`, bad.length === 0, JSON.stringify(bad));
  await ctx.close();
}
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
await b.close();
