#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey I (the part a synthetic hub can show) and finding H-07: Websites with no Vercel login.
 *
 *   1. On the hub (its PATH starts with hub.ts's stub, which answers exactly as a signed-out Vercel CLI): opening Websites refreshes the Vercel
 *      listing in the background; /__websites/overview must end with vercel.error "Vercel isn't signed in on the hub.", the page must say so in words, and
 *      no browser window may open (no process whose command line holds vercel.com/oauth).
 *   2. The REAL Vercel CLI, run exactly as the candidate's background refresh runs it (`--non-interactive`, CI=1) in an empty synthetic profile:
 *      it must exit with a not-signed-in message and open no browser. If a sign-in window does open it is closed at once and the check FAILS.
 *      This contacts vercel.com without credentials (an unauthenticated request); nothing is signed in, read or changed.
 *
 *   bun scripts/acceptance/r7/journey-i-vercel.ts [--hub http://127.0.0.1:8128] [--no-real-cli]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { api, closeAll, DATA, expect, flat, HUB, record, session, shot, SIZES, until, writeResults } from "./lib";

const ROW = "I websites";

/** Process ids (and the start of their command line) of anything showing Vercel's device sign-in. Command lines only; nothing else is read. */
function oauthWindows(): { pid: number; cmd: string }[] {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vercel\\.com/(oauth|login)' } | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)\" }"], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").split(/\r?\n/).filter(Boolean).map((l) => ({ pid: Number(l.split("\t")[0]), cmd: l.split("\t")[1] ?? "" }));
}
const closeWindows = (ws: { pid: number }[]) => ws.forEach((w) => spawnSync("taskkill", ["/PID", String(w.pid), "/T", "/F"], { stdio: "ignore" }));

async function main() {
  const before = oauthWindows();
  const s = await session(SIZES[0]);
  const p = s.page;
  await p.goto(`${HUB}/websites`, { waitUntil: "domcontentloaded" });
  const settled = await until("the Vercel refresh", async () => {
    const w = (await api(p, "GET", "/__websites/overview")).json;
    return w?.vercel && !w.vercel.refreshing && w.vercel.at ? w.vercel : null;
  }, 90_000, 2000);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  const text = flat(await p.locator("main").innerText());
  const after = oauthWindows().filter((w) => !before.some((b) => b.pid === w.pid));
  closeWindows(after);
  expect(ROW, "Websites with no Vercel login: the listing ends 'isn't signed in', the page says so, and no sign-in window opens", settled?.error === "Vercel isn't signed in on the hub." && /isn.t signed in/i.test(text) && after.length === 0, { vercel: settled, pageSays: (text.match(/[^.]*isn.t signed in[^.]*\.[^.]*\./i) ?? [""])[0], signInWindows: after.length });
  await shot(p, "i-1-websites-vercel-signed-out");
  await closeAll();

  if (process.argv.includes("--no-real-cli")) return record(ROW, "the real Vercel CLI, signed out, run as the background refresh runs it", "NOT RUN", "--no-real-cli");
  const which = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command vercel -ErrorAction SilentlyContinue).Source"], { encoding: "utf8" });
  if (!which.stdout.trim()) return record(ROW, "the real Vercel CLI, signed out, run as the background refresh runs it", "BLOCKED", "no vercel CLI on this PC's PATH");
  // An empty profile: no Vercel login can be found through HOME, USERPROFILE, APPDATA or LOCALAPPDATA. Credential-named variables are dropped by name.
  const home = join(`${DATA}-side`, "vercel-signed-out-home");
  for (const d of [home, join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) mkdirSync(d, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/(KEY|TOKEN|SECRET|PASSW|AUTH|CREDENTIAL|COOKIE|SESSION|VERCEL)/i.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), CI: "1", VERCEL_TELEMETRY_DISABLED: "1" });
  const before2 = oauthWindows();
  const out = await new Promise<{ code: number | null; text: string; timedOut: boolean }>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "vercel project ls --scope nahda --format json --non-interactive"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.stderr.on("data", (c) => (text += c));
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, text, timedOut: true }); }, 60_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, text, timedOut: false }); });
  });
  await new Promise((r) => setTimeout(r, 4000)); // a browser launch is asynchronous
  const opened = oauthWindows().filter((w) => !before2.some((b) => b.pid === w.pid));
  closeWindows(opened);
  const signedOut = /no existing credentials|vercel login|not (?:logged|signed) in|credentials|authenticat/i.test(out.text);
  expect(ROW, "the real Vercel CLI, signed out, run as the background refresh runs it (--non-interactive, CI=1): exits with a not-signed-in message and opens no sign-in window", !out.timedOut && out.code !== 0 && signedOut && opened.length === 0, { exit: out.code, timedOut: out.timedOut, says: flat(out.text).replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g, "<code>").slice(0, 220), signInWindowsOpened: opened.length });
}

try {
  await main();
} catch (e) {
  record(ROW, "ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-i-vercel");
  await closeAll();
}
