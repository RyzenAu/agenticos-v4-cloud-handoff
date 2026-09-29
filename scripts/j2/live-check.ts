// J2 SYNTHETIC live check: everyday commands 1-11 end to end through the real router (freeVoice's turn), the real
// skills and the REAL agent-browser against a SEPARATE, HEADLESS Chrome on a spare CDP port with its own throwaway
// profile. It never touches the owner's Jarvis Chrome (9222) or his profile or his windows: Windows is a fake PsHost,
// Chrome is headless (no window at all), and the browser and its agent-browser session are stopped when it ends.
//
//   bun --bun scripts/j2/live-check.ts            (port 9333, profile D:\agent-scratch\j2\chrome-live)
//
// Nothing is printed from the environment. Public pages only (no logins, nothing typed, nothing clicked but a link).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice } from "../free-voice";
import { createJarvisSkills } from "../jarvis-skills";
import { forgetReferent } from "../jarvis-skills/referent";
import { agentBrowserExe, createAgentBrowserHands, spawnRunner } from "./agent-browser";
import { fakeWindows, JARVIS_CHROME_PID } from "./fake-windows";

const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 9333);
if (PORT === 9222) throw new Error("Refusing to use the owner's Jarvis Chrome port (9222).");
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
const exe = agentBrowserExe();
if (!CHROME || !exe) throw new Error(`Needs Chrome (${!!CHROME}) and agent-browser (${!!exe}).`);
const PROFILE = process.argv.find((a) => a.startsWith("--profile="))?.slice(10) ?? "D:\\agent-scratch\\j2\\chrome-live";
const SESSION = "j2live";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function up() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return true;
    } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore", windowsHide: true });
let failures = 0;
const results: Array<{ n: number; said: string; url?: string; ok: boolean }> = [];
async function stop() {
  spawnSync(exe!, ["--session", SESSION, "close"], { timeout: 15_000 });
  if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { timeout: 15_000 });
  await sleep(500);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch { /* a locked profile file is harmless scratch */ }
}
try {
  if (!(await up())) throw new Error("The spare headless Chrome didn't come up.");
  const hands = createAgentBrowserHands({ run: spawnRunner(exe), port: PORT, session: SESSION });
  const win = fakeWindows({ jarvisChromeOn: "left" });
  const root = mkdtempSync(join(tmpdir(), "j2-live-"));
  const skills = createJarvisSkills(root, {
    events: { submit: () => undefined },
    now: Date.now,
    ps: win.ps,
    vault: () => null,
    browser: { hands, ensure: async () => false },
    windows: { launch: async (a) => `${a} is opening.`, jarvisChromePid: async () => JARVIS_CHROME_PID, activateTab: async (id) => hands.activate(id) },
  });
  const voice = freeVoice(root, {
    key: () => "",
    jarvisChromeInFront: async () => true,
    fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "(the brain was asked: it should not be)" } }] }), { status: 200 })) as typeof fetch,
  });
  const say = async (n: number, words: string, expect: (said: string, url: string) => boolean) => {
    const r: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: words }] });
    const fn = r?.tool_calls?.[0]?.function;
    let said = "";
    if (r.model !== "rules" || !fn) said = `NOT ROUTED BY RULES (${r.model}): ${String(r.content).slice(0, 80)}`;
    else if (fn.name !== "skill") said = `unexpected tool ${fn.name}`;
    else said = (await skills.run(JSON.parse(fn.arguments))).said;
    // (A page is still loading for a moment after the tab opens: wait, up to 10 s, for the address to settle.)
    let tab = (await hands.active())?.url ?? "";
    for (let i = 0; i < 20 && !expect(said, tab); i++) {
      await sleep(500);
      tab = (await hands.active())?.url ?? "";
    }
    const ok = r.model === "rules" && fn?.name === "skill" && expect(said, tab);
    if (!ok) failures++;
    results.push({ n, said, url: tab, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${String(n).padStart(2)}. "${words}"\n       -> ${said}\n       tab: ${tab || "(none)"}`);
  };
  const first = await hands.tabs();
  console.log(`Spare Chrome up on ${PORT}, headless, ${first.length} tab(s). Owner's 9222 untouched.`);
  await say(1, "open Chrome", (s) => s === "Opened Chrome on your main screen.");
  await say(2, "bring up Chrome", (s) => /Chrome|New Tab/.test(s) && !/Jarvis|shell/.test(s));
  await say(3, "go to our website", (s, u) => s === "Opened muventures.com.au in Chrome on your main screen." && /^https:\/\/muventures\.com\.au/.test(u));
  await say(4, "open a new tab", (s) => s === "Opened a new tab in Chrome on your main screen.");
  await say(5, "search Google for best dentist in Sydney", (s, u) => /^Searched Google for/.test(s) && /google\.com\/(?:search\?q=best|sorry\/.*search%3Fq%3Dbest)/.test(u)); // (a headless Chrome may be handed Google's own bot check for the same search; it is never bypassed)
  await say(6, "open my Gmail", (s, u) => s === "Opened Gmail in Chrome on your main screen." && /google\.com/.test(u));
  await say(7, "open YouTube and search lo-fi beats", (s, u) => /^Searched YouTube for/.test(s) && /youtube\.com\/results\?search_query=lo-fi/.test(u));
  await say(8, "open the Bianca site", (s, u) => /^Opened Bianca Brown Realty in Chrome on your main screen\.$/.test(s) && /bianca\.muventures\.com\.au/.test(u));
  await say(9, "go back", (s) => s === "Gone back.");
  await say(9, "refresh", (s) => s === "Refreshed.");
  await say(9, "close this tab", (s) => s === "Tab closed.");
  await say(10, "scroll down", (s) => s === "Scrolled down.");
  await sleep(1500);
  await say(11, "read me this page", (s) => /^This page is ".+"/.test(s));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed.`);
} catch (error) {
  failures++;
  console.log(`FAIL: ${(error as Error).message}`);
} finally {
  await stop();
  forgetReferent();
}
process.exit(failures ? 1 : 0);
