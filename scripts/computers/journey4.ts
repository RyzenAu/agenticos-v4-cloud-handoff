#!/usr/bin/env bun
/**
 * Round 3b: MEASURED capacity of this PC for real desktop computers. A cloud-role hub (own port, own data folder, killed by PID) provisions 4 computers
 * and runs a realistic workload on all of them for several minutes, then adds 2 more (6) and runs it again. Everything is provisioned, measured and
 * destroyed through the hub's API and the host allocator; nothing is stopped by name.
 *
 * Workload per computer, in a loop with human-ish pauses: navigate to a real public page (images and scripts: Wikipedia articles, MDN, the BBC,
 * Hacker News), scroll down three times, take a screenshot over the hub, read the page back. One noVNC viewer stays open through the hub proxy on the
 * first computer for the whole phase. Sampled every 3 s: hub (Windows process tree) CPU and memory, each computer's companion/Xvfb/x11vnc/Chromium PSS and
 * CPU inside WSL, the WSL VM, and Windows free memory and CPU load. Prints only numbers and public page names: no cookie, token, key or environment value.
 *
 *   bun scripts/computers/journey4.ts --out D:\prog-scratch\journey4 [--port 8112] [--phase 190] [--sizes 4,6]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultRunner } from "./wsl-local";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "D:\\prog-scratch\\journey4");
const port = Number(arg("port", "8112"));
const distro = arg("distro", "kali-linux");
const data = arg("data", "D:\\prog-f-data4");
const phaseSec = Number(arg("phase", "190"));
const sizes = arg("sizes", "4,6").split(",").map(Number);
const repo = resolve(import.meta.dir, "..", "..");
const hubUrl = `http://127.0.0.1:${port}`;
const HOME_DIR = "/home/ryzen/mu-computers-a";
mkdirSync(out, { recursive: true });

const evidence: { at: string; step: string; data: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, d: unknown) => {
  evidence.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, step, data: d });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}: ${JSON.stringify(d).slice(0, 1400)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wsl(command: string, timeoutMs = 60_000) {
  return (await defaultRunner(["wsl.exe", "-d", distro, "--", "bash", "-s"], { stdin: command, timeoutMs })).stdout.trim();
}
const samplerSrc = readFileSync(join(import.meta.dir, "wsl-sampler.py"), "utf8");
const names = Array.from({ length: Math.max(...sizes) }, (_, i) => `a-load${i + 1}`);

let hub: ChildProcess | null = null;
function startHub() {
  const logFd = openSync(join(out, "hub.log"), "a");
  hub = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: repo, stdio: ["ignore", logFd, logFd], windowsHide: true,
    env: { ...process.env, MU_HUB_ROLE: "cloud", MU_DATA_DIR: data, HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off", MU_COMPUTERS_WSL_DISTRO: distro, MU_COMPUTERS_HOME: HOME_DIR, WSLENV: "MU_COMPUTERS_HOME", MU_COMPUTERS_MONITOR_MS: "10000", MU_COMPUTERS_PERSON_LEASE_MS: "30000" },
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
      await fetch(`${hubUrl}/__health`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("the hub did not start");
}

// ---- sampling -------------------------------------------------------------------------------------------------------------------------
type Sample = { phase: string; t: number; hubRssMb: number; hubCpuSec: number; winFreeMb: number; winTotalMb: number; winCpuLoad: number | null; wsl: any };
const samples: Sample[] = [];
let phase = "setup";
let sampling = true;
let hubIds: number[] = [];
async function refreshHubIds() {
  const ps = `$ErrorActionPreference='SilentlyContinue';$ids=@(${hub!.pid});$q=@(${hub!.pid});for($d=0;$d -lt 4 -and $q.Count;$d++){$n=@();foreach($p in $q){$n+=(Get-CimInstance Win32_Process -Filter "ParentProcessId=$p").ProcessId};$q=$n;$ids+=$n};$ids -join ','`;
  const r = await defaultRunner(["powershell.exe", "-NoProfile", "-Command", ps], { timeoutMs: 60_000 });
  hubIds = r.stdout.trim().split(",").map(Number).filter(Boolean);
  if (!hubIds.length) hubIds = [hub!.pid!];
}
async function winSample() {
  const ps = `$ErrorActionPreference='SilentlyContinue';$h=Get-Process -Id ${hubIds.join(",")}|Measure-Object WorkingSet64,CPU -Sum;$o=Get-CimInstance Win32_OperatingSystem;$c=(Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average;@{rss=($h|?{$_.Property -eq 'WorkingSet64'}).Sum;cpu=($h|?{$_.Property -eq 'CPU'}).Sum;free=$o.FreePhysicalMemory;total=$o.TotalVisibleMemorySize;load=$c}|ConvertTo-Json -Compress`;
  const r = await defaultRunner(["powershell.exe", "-NoProfile", "-Command", ps], { timeoutMs: 30_000 });
  const j = JSON.parse(r.stdout.trim() || "{}");
  return { hubRssMb: Math.round((j.rss ?? 0) / 1048576), hubCpuSec: Number(j.cpu ?? 0), winFreeMb: Math.round((j.free ?? 0) / 1024), winTotalMb: Math.round((j.total ?? 0) / 1024), winCpuLoad: j.load ?? null };
}
async function sampler() {
  while (sampling) {
    const started = Date.now();
    try {
      const [w, l] = await Promise.all([winSample(), defaultRunner(["wsl.exe", "-d", distro, "--", "python3", "-", ...names], { stdin: samplerSrc, timeoutMs: 30_000 })]);
      samples.push({ phase, t: Date.now(), ...w, wsl: JSON.parse(l.stdout.trim()) });
    } catch (e) {
      log("sample failed", String((e as Error).message).slice(0, 120));
    }
    await sleep(Math.max(300, 3000 - (Date.now() - started)));
  }
}

// ---- hub API through the confirmed browser session -------------------------------------------------------------------------------------
let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
let page!: Page;
let token = "";
async function session() {
  page = browser!.pages()[0] ?? (await browser!.newPage());
  await page.goto(`${hubUrl}/`, { waitUntil: "domcontentloaded" });
  const me = await page.evaluate(async () => (await (await fetch("/__devices/me")).json()) as any);
  if (me.principal?.actor !== "human") throw new Error("the hub did not treat the browser as a confirmed human session");
  token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
}
const call = (method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ([m, p, b, t]) => {
      const res = await fetch(`/__computers${p}`, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, json };
    },
    [method, path, body ?? null, token] as [string, string, unknown, string],
  ) as Promise<{ status: number; json: any }>;
const list = async () => (((await call("GET", "/")).json.computers as any[]) ?? []).filter((c) => names.includes(c.name));
const settled = (s: string) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(s);
async function runJob(computer: string, steps: unknown[]) {
  const t = Date.now();
  const r = await call("POST", `/${computer}/jobs`, { agent: "journey4", steps });
  if (r.status !== 200) return { ok: false, ms: Date.now() - t, why: `${r.status} ${r.json.error ?? ""}`.slice(0, 80) };
  for (;;) {
    const j = (await call("GET", `/jobs/${r.json.jobId}`)).json.job;
    if (settled(j.state)) return { ok: j.state === "succeeded", ms: Date.now() - t, why: j.state === "succeeded" ? "" : `${j.state}: ${String(j.steps?.find((s: any) => s.outcome !== "ok")?.intent ?? "").slice(0, 80)}` };
    await sleep(100);
  }
}
async function shotMs(name: string) {
  const t = Date.now();
  const r = await page.evaluate(async (n) => {
    const res = await fetch(`/__computers/${n}/screenshot`);
    const b = await res.arrayBuffer();
    return { status: res.status, len: b.byteLength };
  }, name);
  return r.status === 200 && r.len > 1000 ? Date.now() - t : null;
}

// ---- workload -------------------------------------------------------------------------------------------------------------------------
const PAGES = [
  "https://en.wikipedia.org/wiki/Sydney",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://www.bbc.com/news",
  "https://news.ycombinator.com/",
  "https://en.wikipedia.org/wiki/Linux",
  "https://en.wikipedia.org/wiki/Moon",
  "https://www.bbc.com/weather",
];
type Lat = { nav: number[]; scroll: number[]; shot: number[]; observe: number[]; failures: string[] };
const lats: Record<string, Record<string, Lat>> = {}; // phase -> computer -> latencies
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

async function workload(active: string[], label: string, seconds: number) {
  lats[label] = Object.fromEntries(active.map((n) => [n, { nav: [], scroll: [], shot: [], observe: [], failures: [] }]));
  const end = Date.now() + seconds * 1000;
  await Promise.all(
    active.map(async (n, idx) => {
      let i = idx * 2;
      const L = lats[label][n];
      await sleep(idx * 700); // staggered, like separate agents
      while (Date.now() < end) {
        const url = PAGES[i++ % PAGES.length];
        const nav = await runJob(n, [{ executor: "browser.navigate", args: { url }, timeoutMs: 60000 }]);
        if (nav.ok) L.nav.push(nav.ms);
        else L.failures.push(`${new URL(url).host}: ${nav.why}`);
        for (let k = 0; k < 3 && Date.now() < end; k++) {
          await sleep(900);
          const sc = await runJob(n, [{ executor: "input.scroll", args: { dy: 600 } }]);
          if (sc.ok) L.scroll.push(sc.ms);
          else L.failures.push(`scroll: ${sc.why}`);
        }
        const s = await shotMs(n);
        if (s != null) L.shot.push(s);
        else L.failures.push("screenshot");
        const o = await runJob(n, [{ executor: "observe.page" }]);
        if (o.ok) L.observe.push(o.ms);
        await sleep(1500 + ((idx * 397) % 1500));
      }
    }),
  );
}

function summarise(label: string, active: string[]) {
  const s = samples.filter((x) => x.phase === label);
  const first = s[0];
  const last = s[s.length - 1];
  const dt = (last.t - first.t) / 1000;
  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  const roles = ["companion", "xvfb", "vnc", "chromium"] as const;
  const per = active.map((n) => {
    const o: Record<string, unknown> = { name: n };
    let totalMb = 0;
    let cpu = 0;
    for (const r of roles) {
      const rss = s.map((x) => x.wsl.computers[n]?.[r]?.rssKb ?? 0);
      const mb = mean(rss) / 1024;
      totalMb += mb;
      const c = (((last.wsl.computers[n]?.[r]?.ticks ?? 0) - (first.wsl.computers[n]?.[r]?.ticks ?? 0)) / 100 / dt) * 100;
      cpu += c;
      o[r] = { meanMb: Math.round(mb), peakMb: Math.round(Math.max(...rss) / 1024), cpuPct: Math.round(c * 10) / 10 };
    }
    o.totalMeanMb = Math.round(totalMb);
    o.totalCpuPctOfOneCore = Math.round(cpu * 10) / 10;
    return o;
  });
  const lat = Object.fromEntries(active.map((n) => {
    const L = lats[label][n];
    return [n, { nav: { n: L.nav.length, p50: pct(L.nav, 50), p95: pct(L.nav, 95), max: pct(L.nav, 100) }, scroll: { n: L.scroll.length, p50: pct(L.scroll, 50), p95: pct(L.scroll, 95) }, screenshot: { n: L.shot.length, p50: pct(L.shot, 50), p95: pct(L.shot, 95) }, observe: { n: L.observe.length, p50: pct(L.observe, 50), p95: pct(L.observe, 95) }, failures: L.failures.length, failureSample: L.failures.slice(0, 3) }];
  }));
  const all = (k: "nav" | "shot" | "scroll" | "observe") => active.flatMap((n) => lats[label][n][k]);
  const totalFail = active.reduce((a, n) => a + lats[label][n].failures.length, 0);
  const vmCpu = ((last.wsl.vm.cpuBusy - first.wsl.vm.cpuBusy) / (last.wsl.vm.cpuTotal - first.wsl.vm.cpuTotal)) * 100;
  const hubCpu = ((last.hubCpuSec - first.hubCpuSec) / dt) * 100;
  const sum = (key: "totalMeanMb" | "totalCpuPctOfOneCore") => Math.round((per as any[]).reduce((a, p) => a + (p[key] as number), 0));
  return {
    label, seconds: Math.round(dt), samples: s.length,
    computersTotal: { meanMb: sum("totalMeanMb"), cpuPctOfOneCore: sum("totalCpuPctOfOneCore"), perComputerMeanMb: Math.round(sum("totalMeanMb") / active.length) },
    allComputersLatencyMs: { nav: { n: all("nav").length, p50: pct(all("nav"), 50), p95: pct(all("nav"), 95) }, scroll: { p50: pct(all("scroll"), 50), p95: pct(all("scroll"), 95) }, screenshot: { n: all("shot").length, p50: pct(all("shot"), 50), p95: pct(all("shot"), 95) }, observe: { p50: pct(all("observe"), 50), p95: pct(all("observe"), 95) }, failures: totalFail },
    hub: { meanRssMb: mean(s.map((x) => x.hubRssMb)), peakRssMb: Math.max(...s.map((x) => x.hubRssMb)), cpuPctOfOneCore: Math.round(hubCpu * 10) / 10 },
    wslVm: { usedMbMean: Math.round(mean(s.map((x) => x.wsl.vm.memUsedKb)) / 1024), usedMbPeak: Math.round(Math.max(...s.map((x) => x.wsl.vm.memUsedKb)) / 1024), cpuPctOfAllThreads: Math.round(vmCpu * 10) / 10 },
    windows: { freeMbMin: Math.min(...s.map((x) => x.winFreeMb)), freeMbMean: Math.round(mean(s.map((x) => x.winFreeMb))), totalMb: s[0].winTotalMb, cpuLoadPctMean: mean(s.map((x) => x.winCpuLoad ?? 0)), cpuLoadPctPeak: Math.max(...s.map((x) => x.winCpuLoad ?? 0)) },
    perComputer: per, latencyPerComputer: lat,
  };
}

async function ownerApps() {
  const ps = `Get-Process | Group-Object ProcessName | % { [pscustomobject]@{n=$_.Name;c=$_.Count;mb=[math]::Round((($_.Group|Measure-Object WorkingSet64 -Sum).Sum)/1MB)} } | ? { $_.mb -ge 250 } | Sort-Object mb -Descending | Select -First 12 | ConvertTo-Json -Compress`;
  const r = await defaultRunner(["powershell.exe", "-NoProfile", "-Command", ps], { timeoutMs: 30_000 });
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return r.stdout.slice(0, 200);
  }
}

async function main() {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  console.log(`hub pid ${startHub()}`);
  await hubReady();
  browser = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true });
  await session();
  await refreshHubIds();
  log("hub up (cloud role, own data folder); real browser session; hub process tree", { processes: hubIds.length });
  log("the owner's normal apps are running (not touched): processes using 250 MB or more, by name", await ownerApps());
  void sampler();
  phase = "idle-hub";
  await sleep(12_000);

  const active: string[] = [];
  let provisioned = 0;
  for (const size of sizes) {
    phase = `provision-${size}`;
    const want = names.slice(provisioned, size);
    const t = Date.now();
    const res = await Promise.all(want.map((n) => call("POST", "/", { name: n })));
    provisioned = size;
    log(`provision ${want.length} more (to ${size}) concurrently`, { wallMs: Date.now() - t, statuses: res.map((r) => r.status), errors: res.filter((r) => r.status !== 200).map((r) => r.json.error) });
    if (res.some((r) => r.status !== 200)) throw new Error("a provision failed");
    for (const n of want) active.push(n);
    const end = Date.now() + 90_000;
    while (Date.now() < end && (await list()).filter((c) => c.state === "online").length < size) await sleep(500);
    const states = (await list()).map((c) => ({ n: c.name, s: c.state, d: c.desktop, vnc: c.viewer?.vnc }));
    log(`all ${size} online`, states);
    const alloc = (await wsl(`python3 -c 'import json,os;d=json.load(open(os.path.expanduser("~/mu-computers/alloc.json")));print(json.dumps([(e.get("name"),e.get("display"),e.get("vncPort"),e.get("cdpPort")) for e in d["entries"] if e.get("name","").startswith("a-load")]))'`));
    log("allocator entries for these computers (name, display, vnc, cdp)", JSON.parse(alloc));

    // One viewer open through the hub proxy for the whole phase.
    const vp = await browser!.newPage();
    await vp.setViewportSize({ width: 1320, height: 900 });
    await vp.goto(`${hubUrl}/__computers/${active[0]}/viewer`, { waitUntil: "domcontentloaded" });
    phase = `load-${size}`;
    await workload(active, phase, phaseSec);
    await vp.screenshot({ path: join(out, `viewer-${size}.png`) }).catch(() => undefined);
    await vp.close();
    log(`MEASURED ${size} computers, ${phaseSec} s`, summarise(phase, active));
  }
  phase = "done";
  sampling = false;
  await sleep(800);
  writeFileSync(join(out, "samples.json"), JSON.stringify(samples));
  for (const n of [...active].reverse()) log(`destroy ${n}`, { status: (await call("POST", `/${n}/action`, { action: "destroy" })).status });
}

main()
  .catch((e) => log("FAILED", String((e as Error)?.stack ?? e).slice(0, 600)))
  .finally(async () => {
    sampling = false;
    await browser?.close().catch(() => undefined);
    const pid = hub?.pid;
    stopHub();
    log("hub stopped by PID", { pid, stillListening: await fetch(`${hubUrl}/__health`).then(() => true, () => false) });
    log("left on the host (this journey's a-load* processes and folders; allocator entries)", (await wsl(`ls ${HOME_DIR}; ps -eo pid=,args= | grep -c "[a]-load" ; python3 -c 'import json,os;d=json.load(open(os.path.expanduser("~/mu-computers/alloc.json")));print([e.get("name") for e in d["entries"] if e.get("name","").startswith("a-load")])'`)).split("\n"));
    writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    await sleep(1500);
    try {
      rmSync(data, { recursive: true, force: true });
    } catch {
      /* scratch */
    }
  });
