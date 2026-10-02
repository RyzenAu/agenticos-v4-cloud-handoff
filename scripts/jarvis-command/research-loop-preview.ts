#!/usr/bin/env bun
/**
 * Rendered check for the research loop (programme r5-conv). Starts the REAL hub from this worktree on its own port with a fresh data folder and a
 * SYNTHETIC research computer (research-loop-preview-host.ts), opens the chat in headless Chrome at 1440 and 390 wide, types "use the research
 * computer to research ..." through the real command route, and screenshots the Jarvis conversation as progress, a takeover, the result and the
 * job's end arrive WITHOUT a page reload. Never prints a cookie, token or environment value. Kills what it starts by PID.
 *
 *   bun scripts/jarvis-command/research-loop-preview.ts [--out D:\prog-scratch\r5-conv] [--port 8171] [--data D:\prog-r5-conv-data]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "D:\\prog-scratch\\r5-conv");
const port = Number(arg("port", "8171"));
const data = arg("data", "D:\\prog-r5-conv-data");
if (port === 8081 || port === 8140) throw new Error("not the live or the test hub");
// Only a scratch folder is ever deleted.
if (!/(?:^|[\\/_-])(?:prog|scratch)/i.test(data.replace(/^[A-Za-z]:/, ""))) throw new Error(`--data must be a scratch folder (a path containing "prog" or "scratch"), not ${data}`);
const repo = resolve(import.meta.dir, "..", "..");
const base = `http://127.0.0.1:${port}`;
const searxPort = port + 3;
mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

// ---- a fake SearXNG (the hub's own search), loopback only
const URL1 = "https://www.fairtrading.nsw.gov.au/trades-and-businesses/home-building-licences";
let searx: Server | null = null;
function startSearx() {
  searx = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [{ title: "Home building licences | NSW Fair Trading", url: URL1, content: "Find out about the licence classes for home building work in NSW." }] }));
  });
  return new Promise<void>((r) => searx!.listen(searxPort, "127.0.0.1", () => r()));
}

// ---- the hub
let hub: ChildProcess | null = null;
function startHub() {
  const logFd = openSync(join(out, "hub.log"), "a");
  const home = join(data, "home");
  mkdirSync(home, { recursive: true });
  hub = spawn(process.execPath, ["--bun", "--preload", join(import.meta.dir, "research-loop-preview-host.ts"), "node_modules/vite/bin/vite.js", "dev", "--configLoader", "native", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: repo,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      MU_HUB_ROLE: "cloud", MU_DATA_DIR: data, HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off", MU_COMPUTERS_WSL_DISTRO: "synthetic",
      MU_SEARXNG_URL: `http://127.0.0.1:${searxPort}`, MU_RESEARCH_MODEL: "off", PREVIEW_HUB_PORT: String(port), PREVIEW_PAGE_MS: "4000",
      MU_COMPUTERS_MONITOR_MS: "5000", MU_COMPUTERS_PERSON_LEASE_MS: "60000",
    },
  });
  return hub.pid!;
}
function stopHub() {
  if (hub?.pid) spawnSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { windowsHide: true });
  hub = null;
}
async function hubReady(ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/__health`);
      if (r.ok || r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("the hub did not start");
}

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const token = (await (await fetch("/__token")).json()).token;
      const res = await fetch(path, { method, headers: { "content-type": "application/json", "x-claude-os-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, text: text.slice(0, 4000) };
    },
    { method, path, body },
  );
}

/** One live run in an open page: the page is NEVER reloaded after the conversation is showing; a marker on window proves it. */
async function scenario(name: "d" | "m", width: number, height: number, goal: string, ctx: Awaited<ReturnType<typeof chromium.launch>>["newContext"] extends (...a: any[]) => Promise<infer C> ? C : never) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width, height });
  const evidence: Record<string, unknown> = { width, goal };
  const shot = async (label: string) => {
    await page.waitForTimeout(400);
    const file = join(out, `r5-conv-${name}-${label}.png`);
    await page.screenshot({ path: file });
    log(`screenshot ${file}`);
  };
  const count = (text: string) => page.evaluate((t) => document.body.innerText.split(t).length - 1, text);
  const until = async (text: string, atLeast: number, ms = 60_000) => {
    const end = Date.now() + ms;
    while ((await count(text)) < atLeast) {
      if (Date.now() > end) throw new Error(`timed out waiting for "${text}" x${atLeast}`);
      await sleep(250);
    }
  };
  await page.goto(`${base}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  const startedBefore = await count("Started:");
  const finishedBefore = await count("Finished:");
  const stepBefore = await count("step 1 of 5 (find sources): done");
  const pausedBefore = await count("Paused:");
  const resumedBefore = await count("Resumed:");
  await shot("0-before");
  const said = await api(page, "POST", "/__operator/screen/command", { utterance: `Use the Research computer to ${goal}`, source: "typed" });
  evidence.command = said.text.replace(/\s+/g, " ").slice(0, 320);
  log(`command: ${said.status} ${String(evidence.command).slice(0, 200)}`);
  await until("Started:", startedBefore + 1, 20_000);
  await shot("1-started");
  await until("step 1 of 5 (find sources): done", stepBefore + 1, 40_000);
  // A founder takes the computer while the agent works; it pauses at the next safe step, and the conversation says so.
  const take = await api(page, "POST", "/__computers/research/takeover", {});
  log(`takeover: ${take.status} ${take.text.slice(0, 200)}`);
  await until("Paused:", pausedBefore + 1, 40_000);
  await shot("2-paused");
  const back = await api(page, "POST", "/__computers/research/return", {});
  log(`return: ${back.status} ${back.text.slice(0, 200)}`);
  await until("Resumed:", resumedBefore + 1, 40_000);
  await shot("3-resumed");
  await until("Finished:", finishedBefore + 1, 90_000);
  await page.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
  await shot("4-finished");
  evidence.pageNeverReloaded = await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true && performance.getEntriesByType("navigation").length === 1);
  evidence.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  evidence.resultLines = await page.evaluate(() => [...document.querySelectorAll(".ar-chat-turn.is-job-entry")].slice(-12).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150)));
  await page.close();
  return evidence;
}

async function main() {
  if (existsSync(data)) rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  await startSearx();
  const pid = startHub();
  log(`hub pid ${pid} on ${base}`);
  try {
    await hubReady();
    log("hub is up");
    const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });
    const setup = await browser.newContext({ reducedMotion: "reduce", deviceScaleFactor: 1 });
    const sp = await setup.newPage();
    await sp.goto(`${base}/chat`, { waitUntil: "domcontentloaded" });
    const made = await api(sp, "POST", "/__computers", { name: "research", label: "Research" });
    log(`provision research: ${made.status} ${made.text.slice(0, 200)}`);
    await sleep(2500);
    // Seed: the first run creates the person's Jarvis conversation (so the page can open it before the live run starts).
    const seed = await api(sp, "POST", "/__operator/screen/command", { utterance: "Use the Research computer to research the licence classes for home building in NSW", source: "typed" });
    log(`seed: ${seed.status}`);
    const seeded = Date.now();
    for (;;) {
      const r = await api(sp, "GET", "/__operator/conversations");
      if (/Finished:/.test(r.text) || Date.now() - seeded > 120_000) break;
      await sleep(1000);
    }
    // (one browser profile throughout: the hub trusts the first one as the confirmed person)
    const results = [];
    results.push(await scenario("d", 1440, 900, "research what an owner builder permit needs in NSW", setup));
    results.push(await scenario("m", 390, 844, "research the contractor licence rules in NSW", setup));
    await setup.close();
    writeFileSync(join(out, "evidence.json"), JSON.stringify(results, null, 2));
    log(JSON.stringify(results).slice(0, 2500));
    await browser.close();
  } finally {
    stopHub();
    searx?.close();
  }
}
void scenario;
main().catch((e) => {
  console.error(e);
  stopHub();
  process.exit(1);
});
