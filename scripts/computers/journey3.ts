#!/usr/bin/env bun
/**
 * Round 3 real journey (programme 20261001, Track A): REAL isolated desktops (Xvfb + Chromium + x11vnc from the distro's own apt packages) for two
 * computers provisioned CONCURRENTLY through the existing adapter and API, then measured with 0, 1 and 2 active computers. The cloud-role hub is
 * started and killed by this script (own port and data folder). It never prints a cookie, token, pairing code, key or environment value: the only
 * per-process environment read is the MU_COMPUTER_DIR and DISPLAY variables, and computer.json is read through an allow-list of non-secret keys.
 *
 *   bun scripts/computers/journey3.ts --out D:\prog-scratch\journey3 [--port 8112] [--distro kali-linux] [--data D:\prog-f-data3] [--sample 2000] [--load 30] [--idle 15]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultRunner } from "./wsl-local";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "D:\\prog-scratch\\journey3");
const port = Number(arg("port", "8112"));
const distro = arg("distro", "kali-linux");
const data = arg("data", "D:\\prog-f-data3");
// The journey deletes this folder before and after a run: only a scratch folder (its path says prog or scratch) is ever removed.
if (!/(?:^|[\\/_-])(?:prog|scratch)/i.test(data.replace(/^[A-Za-z]:/, ""))) throw new Error(`--data must be a scratch folder (a path containing "prog" or "scratch"), not ${data}`);
const sampleMs = Number(arg("sample", "3000"));
const loadSec = Number(arg("load", "30"));
const idleSec = Number(arg("idle", "15"));
const repo = resolve(import.meta.dir, "..", "..");
const hubUrl = `http://127.0.0.1:${port}`;
const A = "a-research";
const B = "a-builder";
mkdirSync(out, { recursive: true });

const evidence: { at: string; step: string; ms?: number; data: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, d: unknown, ms?: number) => {
  evidence.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, step, ...(ms !== undefined ? { ms } : {}), data: d });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}${ms !== undefined ? ` (${ms} ms)` : ""}: ${JSON.stringify(d).slice(0, 900)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wsl(command: string, timeoutMs = 60_000) {
  return (await defaultRunner(["wsl.exe", "-d", distro, "--", "bash", "-s"], { stdin: command, timeoutMs })).stdout.trim();
}
const samplerSrc = readFileSync(join(import.meta.dir, "wsl-sampler.py"), "utf8");

let hub: ChildProcess | null = null;
function startHub() {
  const logFd = openSync(join(out, "hub.log"), "a");
  hub = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: repo,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env, MU_HUB_ROLE: "cloud", MU_DATA_DIR: data, HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off", MU_COMPUTERS_WSL_DISTRO: distro, MU_COMPUTERS_DISPLAY_BASE: "401", MU_COMPUTERS_HOME: "/home/ryzen/mu-computers-a", WSLENV: "MU_COMPUTERS_HOME", MU_COMPUTERS_PERSON_LEASE_MS: "30000", MU_COMPUTERS_MONITOR_MS: "5000" },
  });
  return hub.pid!;
}
function stopHub() {
  if (hub?.pid) spawnSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { windowsHide: true });
  hub = null;
}
async function hubReady(ms = 120_000) {
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
type Sample = { phase: string; t: number; hubRssMb: number; hubCpuSec: number; vmmemMb: number | null; wsl: any };
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
async function winSample(): Promise<{ hubRssMb: number; hubCpuSec: number; vmmemMb: number | null }> {
  if (!hubIds.length) await refreshHubIds();
  const ps = `$ErrorActionPreference='SilentlyContinue';$h=Get-Process -Id ${hubIds.join(",")}|Measure-Object WorkingSet64,CPU -Sum;@{rss=($h|?{$_.Property -eq 'WorkingSet64'}).Sum;cpu=($h|?{$_.Property -eq 'CPU'}).Sum}|ConvertTo-Json -Compress`;
  const r = await defaultRunner(["powershell.exe", "-NoProfile", "-Command", ps], { timeoutMs: 20_000 });
  const j = JSON.parse(r.stdout.trim() || "{}");
  return { hubRssMb: Math.round((j.rss ?? 0) / 1048576), hubCpuSec: Number(j.cpu ?? 0), vmmemMb: null };
}
async function sampler() {
  while (sampling) {
    const started = Date.now();
    try {
      const [w, l] = await Promise.all([winSample(), defaultRunner(["wsl.exe", "-d", distro, "--", "python3", "-", A, B], { stdin: samplerSrc, timeoutMs: 20_000 })]);
      samples.push({ phase, t: Date.now(), ...w, wsl: JSON.parse(l.stdout.trim()) });
    } catch (e) {
      log("sample failed", String((e as Error).message));
    }
    await sleep(Math.max(200, sampleMs - (Date.now() - started)));
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
  return me;
}
const call = (method: string, path: string, body?: unknown, prefix = "/__computers") =>
  page.evaluate(
    async ([m, p, b, t, pre]) => {
      const res = await fetch(`${pre}${p}`, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, json, bytes: text.length };
    },
    [method, path, body ?? null, token, prefix] as unknown[] as [string, string, unknown, string, string],
  ) as Promise<{ status: number; json: any; bytes: number }>;
const list = async () => (((await call("GET", "/")).json.computers as any[]) ?? []).filter((c) => c.name === A || c.name === B);
const view = async (n: string) => (await list()).find((c) => c.name === n);
const waitFor = async (what: string, fn: () => Promise<any>, ms = 90_000, every = 300) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
};
const settled = (s: string) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(s);
const job = async (id: string) => (await call("GET", `/jobs/${id}`)).json.job as any;
async function runJob(computer: string, steps: unknown[], agent = "journey3") {
  const t = Date.now();
  const r = await call("POST", `/${computer}/jobs`, { agent, steps });
  if (r.status !== 200) return { started: false as const, status: r.status, error: r.json.error, ms: Date.now() - t };
  await waitFor(`job on ${computer}`, async () => settled((await job(r.json.jobId)).state), 120_000, 100);
  return { started: true as const, job: await job(r.json.jobId), ms: Date.now() - t };
}
const lines = (j: any) => j.steps.map((s: any) => `${s.outcome} ${s.action ?? s.executor}: ${s.intent.slice(0, 120)}`);
async function shot(n: string, file?: string) {
  const t = Date.now();
  const r = await page.evaluate(async (name) => {
    const res = await fetch(`/__computers/${name}/screenshot`);
    const b = new Uint8Array(await res.arrayBuffer());
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { status: res.status, type: res.headers.get("content-type"), len: b.length, b64: res.status === 200 ? btoa(s) : "" };
  }, n);
  if (file && r.b64) writeFileSync(join(out, file), Buffer.from(r.b64, "base64"));
  return { status: r.status, type: r.type, bytes: r.len, ms: Date.now() - t };
}
const tcpOpenOnWindows = (p: number) =>
  new Promise<boolean>((resolvePort) => {
    const s = createConnection({ port: p, host: "127.0.0.1" });
    const done = (ok: boolean) => (s.destroy(), resolvePort(ok));
    s.setTimeout(800, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });

// ---- load -----------------------------------------------------------------------------------------------------------------------------
const PAGES: [string, string][] = [
  ["https://example.com", "Example Domain"],
  ["https://www.wikipedia.org", "Wikipedia"],
  ["https://example.org", "Example Domain"],
  ["https://en.wikipedia.org/wiki/Linux", "Linux - Wikipedia"],
];
type Lat = { nav: number[]; shot: number[]; observe: number[]; failures: string[] };
async function load(names: string[], seconds: number): Promise<Record<string, Lat>> {
  const res: Record<string, Lat> = Object.fromEntries(names.map((n) => [n, { nav: [], shot: [], observe: [], failures: [] }]));
  const end = Date.now() + seconds * 1000;
  await Promise.all(
    names.map(async (n, idx) => {
      let i = idx;
      while (Date.now() < end) {
        const [url, title] = PAGES[i++ % PAGES.length];
        const r = await runJob(n, [{ executor: "browser.navigate", args: { url, expectTitle: title }, timeoutMs: 60000 }]);
        if (r.started && r.job.state === "succeeded") res[n].nav.push(r.ms);
        else res[n].failures.push(`${url}: ${r.started ? r.job.state : r.error}`);
        const s = await shot(n);
        if (s.status === 200) res[n].shot.push(s.ms);
        const o = await runJob(n, [{ executor: "observe.page" }]);
        if (o.started && o.job.state === "succeeded") res[n].observe.push(o.ms);
        await sleep(500);
      }
    }),
  );
  return res;
}
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const latSummary = (l: Lat) => ({
  nav: { n: l.nav.length, p50: pct(l.nav, 50), p95: pct(l.nav, 95), max: pct(l.nav, 100) },
  screenshot: { n: l.shot.length, p50: pct(l.shot, 50), p95: pct(l.shot, 95) },
  observe: { n: l.observe.length, p50: pct(l.observe, 50), p95: pct(l.observe, 95) },
  failures: l.failures,
});

function summarise(label: string) {
  const s = samples.filter((x) => x.phase === label);
  if (s.length < 2) return { label, samples: s.length };
  const first = s[0];
  const last = s[s.length - 1];
  const dt = (last.t - first.t) / 1000;
  const clk = 100;
  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  const peak = (xs: number[]) => Math.max(...xs);
  const comp: Record<string, unknown> = {};
  for (const n of [A, B]) {
    const per: Record<string, unknown> = {};
    for (const r of ["companion", "xvfb", "vnc", "chromium"]) {
      const rss = s.map((x) => x.wsl.computers[n]?.[r]?.rssKb ?? 0);
      if (!rss.some((v) => v > 0)) continue;
      const cpu = (((last.wsl.computers[n]?.[r]?.ticks ?? 0) - (first.wsl.computers[n]?.[r]?.ticks ?? 0)) / clk / dt) * 100;
      per[r] = { meanRssMb: Math.round(mean(rss) / 1024), peakRssMb: Math.round(peak(rss) / 1024), cpuPctOfOneCore: Math.round(cpu * 10) / 10, procsMax: Math.max(...s.map((x) => x.wsl.computers[n]?.[r]?.procs ?? 0)) };
    }
    if (Object.keys(per).length) comp[n] = per;
  }
  const vmCpu = ((last.wsl.vm.cpuBusy - first.wsl.vm.cpuBusy) / (last.wsl.vm.cpuTotal - first.wsl.vm.cpuTotal)) * 100;
  const hubCpu = ((last.hubCpuSec - first.hubCpuSec) / dt) * 100;
  return {
    label,
    samples: s.length,
    seconds: Math.round(dt),
    hub: { meanRssMb: mean(s.map((x) => x.hubRssMb)), peakRssMb: peak(s.map((x) => x.hubRssMb)), cpuPctOfOneCore: Math.round(hubCpu * 10) / 10 },
    computers: comp,
    wslVm: { usedMbMean: Math.round(mean(s.map((x) => x.wsl.vm.memUsedKb)) / 1024), usedMbPeak: Math.round(peak(s.map((x) => x.wsl.vm.memUsedKb)) / 1024), cpuPctOfAllThreads: Math.round(vmCpu * 10) / 10 },
    vmmemMbMean: s.every((x) => x.vmmemMb != null) ? Math.round(mean(s.map((x) => x.vmmemMb!))) : null,
  };
}

// ---- verification of isolation ---------------------------------------------------------------------------------------------------------
const INSPECT = `
python3 - <<'PY'
import json, os, re, subprocess
base = os.path.expanduser("~/mu-computers-a")
out = {}
for n in ("${A}", "${B}"):
    d = base + "/" + n
    try:
        full = json.load(open(d + "/cfg/computer.json"))
        cfg = {k: full[k] for k in ("name", "deviceId", "display", "resolution", "vncPort", "workdir", "profileDir", "cdpPort") if k in full}
    except Exception as e:
        cfg = {"error": str(e)}
    out[n] = {"cfg": cfg, "dirs": sorted(os.listdir(d)) if os.path.isdir(d) else None}
ps = subprocess.run(["ps", "-eo", "pid=,ppid=,etimes=,args="], capture_output=True, text=True).stdout.splitlines()
keep = []
for l in ps:
    if re.search(r"Xvfb :4[0-9][0-9]|x11vnc -display :4[0-9][0-9]|mu-computers-a/bin/companion|user-data-dir=.*mu-computers-a/a-", l) and not re.search(r"--type=|crashpad", l):
        keep.append(l[:330])
out["processes"] = keep
for n in ("${A}", "${B}"):
    mine = [l for l in ps if "--user-data-dir=" + base + "/" + n + "/profile" in l and "--type=" not in l and "crashpad" not in l]
    out[n]["browserHeadless"] = any("--headless" in l for l in mine) if mine else None
    out[n]["browserOnDisplay"] = [re.search(r"--ozone-platform=(\\w+)", l).group(1) for l in mine if re.search(r"--ozone-platform=(\\w+)", l)][:1]
env = {}
for l in ps:
    if "companion.mjs" in l and "run --config" in l:
        pid = l.split()[0]
        try:
            for kv in open("/proc/" + pid + "/environ", "rb").read().split(b"\\0"):
                if kv.startswith(b"MU_COMPUTER_DIR=") or kv.startswith(b"DISPLAY="):
                    env.setdefault(pid, []).append(kv.decode())
        except Exception:
            pass
out["companionEnvOnlyDirAndDisplay"] = env
print(json.dumps(out))
PY`;
const SOCKETS = `echo "(only this hub's ports: displays 401+, VNC 63xx, DevTools 97xx)"; ss -ltnpH | grep -E ':(63[0-9][0-9]|97[0-9][0-9]) ' | awk '{print $4, $6}' | sort; echo ---unix; ss -lxH | awk '{print $5}' | grep -E 'X4[0-9][0-9]$' | sort`;
async function cdpTitles() {
  const r: Record<string, unknown> = {};
  for (const n of [A, B]) {
    r[n] = await wsl(
      `P=$(ps -eo args= | grep -- "--user-data-dir=$HOME/mu-computers-a/${n}/profile" | grep -o -- '--remote-debugging-port=[0-9]*' | head -1 | cut -d= -f2); echo "cdp=$P"; curl -s --max-time 5 http://127.0.0.1:$P/json/list | python3 -c 'import sys,json; print(json.dumps([{"type":t["type"],"title":t["title"],"url":t["url"]} for t in json.load(sys.stdin) if t["type"]=="page"]))'`,
    );
  }
  return r;
}

/** What the hub says and what each computer logged (log tails only: no tokens are ever logged by the companion). */
async function diagnose(why: string) {
  const ev = (await call("GET", "/events")).json;
  log(`DIAGNOSE ${why}: hub events`, (ev.events ?? []).slice(-12));
  log(`DIAGNOSE ${why}: views`, (await list()).map((c) => ({ name: c.name, state: c.state, failure: c.failure, recoveries: c.recoveries, viewer: c.viewer })));
  for (const n of [A, B]) log(`DIAGNOSE ${why}: ${n} logs`, (await wsl(`cd ~/mu-computers-a/${n}/logs 2>/dev/null && for f in companion xvfb vnc; do echo "== $f"; tail -n 6 $f.log 2>/dev/null | cut -c1-220; done; ls ../run`)).split(String.fromCharCode(10)));
}

async function main() {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  console.log(`hub pid ${startHub()}`);
  await hubReady();
  browser = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true });
  const me = await session();
  log("hub up; real browser session", { person: me.person?.id, via: me.via, actor: me.principal?.actor, role: "cloud", port });
  const host = (await call("GET", "/host")).json;
  log("host check (adapter)", { present: host.adapters[0].check.present, missing: host.adapters[0].check.missing });
  await refreshHubIds();
  log("hub process tree measured (Windows)", { processes: hubIds.length });
  void sampler();

  // 0 computers: the hub alone.
  phase = "0-computers";
  await sleep(idleSec * 1000);

  // Provision both computers CONCURRENTLY through the API.
  phase = "provisioning";
  const tp = Date.now();
  const [pa, pb] = await Promise.all([call("POST", "/", { name: A, label: "A research" }), call("POST", "/", { name: B, label: "A builder" })]);
  log("provision two computers concurrently", {
    wallMs: Date.now() - tp,
    a: { status: pa.status, desktop: pa.json.computer?.desktop, browser: pa.json.computer?.browser, err: pa.json.error },
    b: { status: pb.status, desktop: pb.json.computer?.desktop, browser: pb.json.computer?.browser, err: pb.json.error },
  });
  await waitFor("both online", async () => (await list()).length === 2 && (await list()).every((c) => c.state === "online"));
  log("both online", (await list()).map((c) => ({ name: c.name, id: c.id, state: c.state, desktop: c.desktop, viewer: c.viewer, caps: c.capabilities.length })));

  // Each computer drives its OWN browser to a different page; read each title from its own CDP.
  const [na, nb] = await Promise.all([
    runJob(A, [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }, { executor: "observe.page" }, { executor: "file.write", args: { name: "notes.txt", text: "research working file" } }]),
    runJob(B, [{ executor: "browser.navigate", args: { url: "https://www.wikipedia.org", expectTitle: "Wikipedia" }, timeoutMs: 60000 }, { executor: "observe.page" }, { executor: "file.write", args: { name: "notes.txt", text: "builder working file" } }]),
  ]);
  log("navigate + write a file, concurrently", { research: na.started ? { state: na.job.state, steps: lines(na.job), ms: na.ms } : na, builder: nb.started ? { state: nb.job.state, steps: lines(nb.job), ms: nb.ms } : nb });
  await sleep(1500);
  log("ISOLATION: processes, displays, profiles, workdirs, identities (inside WSL)", JSON.parse(await wsl(INSPECT)));
  log("ISOLATION: each Chromium's own CDP (page titles read from its own DevTools port)", await cdpTitles());
  log("LISTENING sockets inside WSL (tcp on 127.0.0.1 only; X11 is unix-socket only)", (await wsl(SOCKETS)).split("\n"));
  const cdpPorts = (await wsl(`ps -eo args= | grep -o -- '--remote-debugging-port=[0-9]*' | sort -u`)).match(/\d+/g) ?? [];
  const vncPorts = (await wsl(`ps -eo args= | grep -o -- 'x11vnc.*-rfbport [0-9]*' | grep -o '[0-9]*$' | sort -u`)).match(/\d+/g) ?? [];
  const probe: Record<string, boolean> = {};
  for (const p of [...cdpPorts, ...vncPorts]) probe[p] = await tcpOpenOnWindows(Number(p));
  log("Windows loopback can reach these WSL ports? (WSL2 localhost forwarding check; true = reachable from a local Windows process)", probe);
  const snaps = { research: await shot(A, "a-research.jpg"), builder: await shot(B, "a-builder.jpg") };
  log("snapshots through the authenticated hub route", snaps);
  if (snaps.research.status !== 200 || snaps.builder.status !== 200) await diagnose("snapshot");
  // The real desktop over VNC: noVNC in the real browser, through the hub's authenticated WebSocket, to each computer's x11vnc.
  for (const [n, file] of [
    [A, "vnc-a-research.png"],
    [B, "vnc-a-builder.png"],
  ] as const) {
    const vp = await browser!.newPage();
    await vp.setViewportSize({ width: 1320, height: 900 });
    try {
      await vp.goto(`${hubUrl}/__computers/${n}/viewer`, { waitUntil: "domcontentloaded" });
      await vp.waitForFunction(() => {
        const c = document.querySelector("canvas") as HTMLCanvasElement | null;
        return !!c && c.width > 100;
      }, null, { timeout: 30_000 });
      await sleep(2500);
      await vp.screenshot({ path: join(out, file) });
      log(`VNC frame for ${n} (noVNC via the hub proxy)`, {
        file,
        canvas: await vp.evaluate(() => {
          const c = document.querySelector("canvas") as HTMLCanvasElement;
          return { w: c.width, h: c.height };
        }),
        header: (await vp.locator("header").innerText().catch(() => "")).slice(0, 120),
      });
    } catch (e) {
      log(`VNC frame for ${n} FAILED`, String((e as Error).message).slice(0, 300));
    } finally {
      await vp.close();
    }
  }

  // 2 active computers: load + idle.
  phase = "2-active-load";
  await diagnose("before load");
  const l2 = await load([A, B], loadSec);
  log("2 active computers under load: latency (ms)", { [A]: latSummary(l2[A]), [B]: latSummary(l2[B]) });
  phase = "2-idle-pages-loaded";
  await sleep(idleSec * 1000);

  // One computer down, the other under load; then the stopped one comes back with its files.
  const ws = await call("POST", `/${B}/action`, { action: "stop" });
  log("stop builder", { status: ws.status, state: (await view(B))?.state });
  phase = "1-active-load";
  const l1 = await load([A], loadSec);
  log("1 active computer under load: latency (ms)", { [A]: latSummary(l1[A]) });
  phase = "1-idle-page-loaded";
  await sleep(idleSec * 1000);
  phase = "restart";
  const tr = Date.now();
  await call("POST", `/${B}/action`, { action: "start" });
  await waitFor("builder online", async () => (await view(B))?.state === "online");
  const onlineMs = Date.now() - tr;
  const rb = await runJob(B, [{ executor: "file.read", args: { name: "notes.txt" } }, { executor: "browser.navigate", args: { url: "https://www.wikipedia.org", expectTitle: "Wikipedia" }, timeoutMs: 60000 }]);
  log("builder after stop/start: file survived, browser works", { restartToOnlineMs: onlineMs, state: rb.started ? rb.job.state : rb, steps: rb.started ? lines(rb.job) : null });
  phase = "done";
  sampling = false;
  await sleep(500);
  log("resource view as the hub reports it", (await list()).map((c) => ({ name: c.name, resource: c.resource })));
  for (const l of ["0-computers", "2-active-load", "2-idle-pages-loaded", "1-active-load", "1-idle-page-loaded"]) log(`MEASURED ${l}`, summarise(l));
  writeFileSync(join(out, "samples.json"), JSON.stringify(samples));

  // Teardown: destroy computers (the apt packages stay).
  for (const n of [A, B]) log(`destroy ${n}`, { status: (await call("POST", `/${n}/action`, { action: "destroy" })).status });
}

main()
  .catch((e) => log("FAILED", String((e as Error)?.stack ?? e)))
  .finally(async () => {
    sampling = false;
    await browser?.close().catch(() => undefined);
    const pid = hub?.pid;
    stopHub();
    log("hub stopped by PID", { pid, stillListening: await fetch(`${hubUrl}/__health`).then(() => true, () => false) });
    log("WSL after teardown (a-* processes; computer directories)", (await wsl('pgrep -fa "mu-computers-a/a-" | grep -v pgrep | head; ls ~/mu-computers-a')).split("\n"));
    writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    await sleep(1500);
    try {
      rmSync(data, { recursive: true, force: true });
    } catch {
      /* scratch */
    }
  });
