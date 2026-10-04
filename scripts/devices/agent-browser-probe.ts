#!/usr/bin/env bun
/**
 * What does agent-browser do when a command is bound to a tab id that has been closed? (programme 20261001, Agent B, round 4)
 *
 *   AB_EXE=<agent-browser exe> [CHROME=<chrome.exe>] bun scripts/devices/agent-browser-probe.ts [--port 9335] [--profile D:\scratch\ab-profile]
 *
 * Starts its OWN headless Chrome on a spare port with a throwaway profile (never port 9222, never a real profile), opens two tabs through
 * agent-browser, closes the first through DevTools, then tries to act on it by id and by position, and reports whether the tool refused
 * clearly or acted on the neighbouring tab. Prints only what it made. Stops its Chrome and closes its agent-browser session at the end.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const AB = process.env.AB_EXE ?? "";
const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9335);
const profile = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : "D:\\agent-scratch\\prog-b\\ab-probe-profile";
if (!AB || port === 9222) throw new Error("Set AB_EXE; port 9222 is the owner's Jarvis Chrome.");
const CHROME = process.env.CHROME ?? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
if (!CHROME) throw new Error("Chrome not found.");
const SESSION = `probe-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (label: string, v: Record<string, unknown>) => console.log(JSON.stringify({ label, ...v }));
const ab = (...args: string[]) => {
  const r = spawnSync(AB, ["--session", SESSION, "--cdp", String(port), ...args, "--json"], { encoding: "utf8", timeout: 25_000, windowsHide: true });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "");
  } catch {
    /* plain text */
  }
  return { code: r.status, json, raw: (r.stdout + r.stderr).replace(/\s+/g, " ").slice(0, 240) };
};
const list = async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).filter((t) => t.type === "page").map((t) => ({ id: String(t.id), url: String(t.url), title: String(t.title) }));

mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore", windowsHide: true });
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  const a = ab("tab", "new", "https://example.com/");
  const b = ab("tab", "new", "https://example.org/");
  await sleep(1500);
  const tabs = ab("tab");
  const A = a.json?.data?.targetId as string;
  const B = b.json?.data?.targetId as string;
  out("tabs-opened", { A: A?.slice(0, 8), B: B?.slice(0, 8), listed: (tabs.json?.data?.tabs ?? []).map((t: any) => `${String(t.targetId).slice(0, 8)}:${t.url}`) });
  // Close A behind agent-browser's back (the person closed it).
  await fetch(`http://127.0.0.1:${port}/json/close/${A}`);
  await sleep(800);
  out("after-close", { real: (await list()).map((t) => `${t.id.slice(0, 8)}:${t.url}`) });
  // Bound to A by id: what happens?
  const byId = ab("tab", A);
  const after = await list();
  out("tab <closed id>", { code: byId.code, success: byId.json?.success, error: byId.json?.error ?? byId.raw, tabsNow: after.map((t) => `${t.id.slice(0, 8)}:${t.url}`) });
  // Act "on it": navigate the active tab after the failed switch. If the failed bind left a neighbour active, this lands on the wrong tab.
  const nav = ab("open", "https://example.net/");
  const final = await list();
  out("open after failed bind", { code: nav.code, success: nav.json?.success, tabsNow: final.map((t) => `${t.id.slice(0, 8)}:${t.url}`), navigatedNeighbour: final.some((t) => /example\.net/.test(t.url)) });
} finally {
  spawnSync(AB, ["--session", SESSION, "close"], { timeout: 15_000 });
  if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { timeout: 15_000 });
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* scratch */
  }
}
