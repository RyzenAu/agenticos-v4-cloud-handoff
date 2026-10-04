#!/usr/bin/env bun
/**
 * Real cold-start and reconnection proof (programme 20261001, Track B round 3). It owns the whole stack so it knows every PID:
 * a full Vite hub (MU_HUB_ROLE=cloud, isolated MU_DATA_DIR, loopback port) and a real companion process on this PC.
 *
 *   bun scripts/devices/real-r3-reconnect.ts <cold|hub-restart|companion-restart|sleep|all> [--port 8111] [--data D:\agent-scratch\prog-b\r3] [--cfg <companion config dir>]
 *
 * Needs an already-paired companion config (companion/main.ts pair) under --data\companion-cfg. Prints one JSON line per fact. Never prints tokens,
 * cookies or the page token. At the end it kills every process it started, by PID (process tree).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = argv[0] ?? "all";
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const PORT = Number(opt("port", "8111"));
const DATA = opt("data", "D:\\agent-scratch\\prog-b\\r3");
const CFG = opt("cfg", join(DATA, "companion-cfg"));
const HUB = `http://127.0.0.1:${PORT}`;
const BUN = process.execPath;
const REPO = join(import.meta.dir, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const out = (label: string, v: Record<string, unknown>) => console.log(JSON.stringify({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, label, ...v }));
const ps = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 }).trim();

let startDev: Dev | null = null;
let hubPid = 0;
let compPid = 0;
function startHub() {
  const child = spawn(BUN, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: REPO, detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, MU_HUB_ROLE: "cloud", MU_DATA_DIR: join(DATA, "data"), HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off" },
  });
  child.unref();
  hubPid = child.pid ?? 0;
}
function startCompanion() {
  const child = spawn(BUN, ["companion/main.ts", "run", "--config", CFG], { cwd: REPO, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, MU_DATA_DIR: join(DATA, "pc-data") } });
  child.unref();
  compPid = child.pid ?? 0;
}
function killTree(pid: number) {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    /* already gone */
  }
}
const suspend = (pid: number, on: boolean) =>
  ps(`Add-Type -Name N -Namespace R3 -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);'; $p = Get-Process -Id ${pid}; $h = $p.Handle; if (${on ? "$true" : "$false"}) { [R3.N]::NtSuspendProcess($h) } else { [R3.N]::NtResumeProcess($h) }`);

async function hubReady(ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${HUB}/__health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("hub never became healthy");
}
type Dev = { id: string; owner: string; online: boolean; interactive?: boolean | null; displayLabel?: string; workerVersion?: string };
async function devices(): Promise<Dev[]> {
  try {
    return (((await (await fetch(`${HUB}/__devices/devices`, { signal: AbortSignal.timeout(3000) })).json()) as { devices?: Dev[] }).devices ?? []);
  } catch {
    return [];
  }
}
const usman = async () => (await devices()).find((d) => d.owner === "usman" && d.id);
async function companionOnline(ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = await usman();
    if (d?.online) return d;
    await sleep(300);
  }
  return null;
}
// The page token is fixed for ONE server run; a restarted hub has a new one, so it is read fresh for every command.
const tok = async () => ((await (await fetch(`${HUB}/__token`)).json()) as { token: string }).token;
type Done = { ok: boolean; said: string; jobId: string | null; targetDeviceId: string | null; stopped?: boolean; outcome?: string; verified?: boolean | null };
async function command(body: Record<string, unknown>, onJob?: (id: string) => void): Promise<Done> {
  const res = await fetch(`${HUB}/__operator/screen/command`, { method: "POST", headers: { "content-type": "application/json", "x-claude-os-token": await tok() }, body: JSON.stringify(body) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let last: Done | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.type === "job") onJob?.(e.jobId);
      if (e.type === "done") last = e;
    }
  }
  return last ?? { ok: false, said: "no done event", jobId: null, targetDeviceId: null };
}
async function job(id: string | null) {
  if (!id) return null;
  const j = (await (await fetch(`${HUB}/__jobs/${id}`)).json()) as any;
  return j.job ?? j;
}
const steps = (j: any) => (j?.steps ?? []).map((s: any) => `${s.outcome}|${s.executor}|${String(s.intent).slice(0, 90)}`);
const observe = (u: string) => command({ utterance: u, source: "typed", steps: [{ executor: "observe.window", args: {} }] });
const jobCount = async () => (((await (await fetch(`${HUB}/__jobs`)).json()) as any).jobs ?? []).length;
const ledgerStates = () => {
  const f = join(DATA, "companion-cfg", "command-ledger.json");
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    const rows = Array.isArray(j) ? j : (j.entries ?? j.commands ?? []);
    return rows.slice(-4).map((r: any) => ({ executor: r.executor, state: r.state ?? r.status, key: String(r.commandKey ?? r.key ?? "").slice(0, 14) }));
  } catch {
    return ["(unreadable)"];
  }
};
const browserTabs = async (port: number) => {
  try {
    return ((await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as any[]).filter((t) => t.type === "page").map((t) => String(t.url).slice(0, 40));
  } catch {
    return null;
  }
};

async function bringUp() {
  killTree(hubPid);
  killTree(compPid);
  startHub();
  await hubReady();
  startCompanion();
  const d = await companionOnline();
  if (!d) throw new Error("companion never came online");
  return d;
}

async function cold() {
  out("cold:setup", { note: "everything stopped; companion started BEFORE the hub" });
  killTree(hubPid);
  killTree(compPid);
  startCompanion();
  await sleep(15_000);
  out("cold:companion-alone", { companionAlive: !!ps(`Get-Process -Id ${compPid} -ErrorAction SilentlyContinue | ForEach-Object Id`), hub: "down" });
  const t = Date.now();
  startHub();
  await hubReady();
  out("cold:hub-up", { ms: Date.now() - t });
  const d = await companionOnline();
  out("cold:companion-registered", { msAfterHubHealthy: Date.now() - t, id: d?.id, online: d?.online, displayLabel: d?.displayLabel });
  const r = await observe("cold: what is in front");
  out("cold:command", { ok: r.ok, verified: r.verified, target: r.targetDeviceId, sameDevice: r.targetDeviceId === d?.id, said: r.said.slice(0, 80) });
}

async function hubRestart() {
  const before = await usman();
  const jobsBefore = await jobCount();
  out("hub-restart:before", { id: before?.id, online: before?.online, jobs: jobsBefore });
  killTree(hubPid);
  await sleep(1500);
  out("hub-restart:hub-down", { devices: (await devices()).length, note: "no hub answering" });
  const t = Date.now();
  startHub();
  await hubReady();
  const healthyMs = Date.now() - t;
  const d = await companionOnline();
  out("hub-restart:companion-back", { msAfterHubHealthy: Date.now() - t - healthyMs, id: d?.id, sameDevice: d?.id === before?.id, jobsKept: (await jobCount()) >= jobsBefore });
  const r = await observe("hub-restart: what is in front");
  out("hub-restart:command", { ok: r.ok, verified: r.verified, sameDevice: r.targetDeviceId === before?.id });
}

async function companionRestart() {
  const dev = startDev;
  const marker = "https://example.net/";
  let jobId: string | null = null;
  const p = command({ utterance: "r3 restart: wait then open example.net", source: "typed", steps: [{ executor: "wait", args: { ms: 25_000 } }, { executor: "browser.navigate", args: { url: marker } }] }, (id) => (jobId = id));
  await sleep(4000);
  const j1 = await job(jobId);
  out("companion-restart:in-flight", { steps: steps(j1), state: j1?.state });
  killTree(compPid);
  const killedAt = Date.now();
  startCompanion();
  out("companion-restart:restarted", { note: "companion killed mid-wait and started again, same pairing" });
  const done = await p;
  out("companion-restart:done", { afterMs: Date.now() - killedAt, ok: done.ok, outcome: done.outcome, verified: done.verified, said: done.said.slice(0, 200) });
  const back = await companionOnline();
  await sleep(4000);
  const j2 = await job(done.jobId);
  out("companion-restart:job", { state: j2?.state, steps: steps(j2), sameDevice: back?.id === dev?.id });
  out("companion-restart:no-replay", { ledger: ledgerStates(), markerOpened: ((await browserTabs(9340)) ?? []).some((u) => u.startsWith("https://example.net")) });
}

async function sleepSim() {
  const dev = startDev;
  const marker = "https://example.org/";
  let jobId: string | null = null;
  const p = command({ utterance: "r3 sleep: wait then open example.org", source: "typed", steps: [{ executor: "wait", args: { ms: 40_000 } }, { executor: "browser.navigate", args: { url: marker } }] }, (id) => (jobId = id));
  await sleep(4000);
  out("sleep:in-flight", { state: (await job(jobId))?.state });
  suspend(compPid, true);
  const suspendedAt = Date.now();
  out("sleep:suspended", { pid: compPid, note: "NtSuspendProcess: no heartbeats, no executor progress (what a sleeping PC looks like to the hub)" });
  await sleep(45_000);
  const midDev = await usman();
  out("sleep:hub-view", { online: midDev?.online, displayLabel: midDev?.displayLabel, afterMs: Date.now() - suspendedAt });
  const done = await Promise.race([p, sleep(1000).then(() => null)]);
  out("sleep:job-while-asleep", { settled: !!done, ok: done?.ok, outcome: done?.outcome, said: done?.said?.slice(0, 200) });
  suspend(compPid, false);
  const resumedAt = Date.now();
  out("sleep:resumed", {});
  const final = done ?? (await p);
  const back = await companionOnline(60_000);
  out("sleep:back", { msAfterResume: Date.now() - resumedAt, online: back?.online, sameDevice: back?.id === dev?.id });
  await sleep(8000);
  const j = await job(final.jobId);
  out("sleep:job-final", { state: j?.state, steps: steps(j), said: final.said.slice(0, 200), outcome: final.outcome });
  out("sleep:no-replay", { markerOpened: ((await browserTabs(9340)) ?? []).some((u) => u.startsWith("https://example.org")), ledger: ledgerStates() });
  const r = await observe("sleep: after resume");
  out("sleep:next-command", { ok: r.ok, verified: r.verified, sameDevice: r.targetDeviceId === dev?.id });
}

async function main() {
  try {
    const d = await bringUp();
    startDev = d;
    out("start", { id: d.id, displayLabel: d.displayLabel, workerVersion: d.workerVersion, hubPid, compPid });
    if (scenario === "cold" || scenario === "all") await cold();
    if (scenario === "hub-restart" || scenario === "all") await hubRestart();
    if (scenario === "companion-restart" || scenario === "all") await companionRestart();
    if (scenario === "sleep" || scenario === "all") await sleepSim();
  } finally {
    try {
      suspend(compPid, false);
    } catch {
      /* not suspended or gone */
    }
    killTree(compPid);
    killTree(hubPid);
    out("teardown", { killed: [compPid, hubPid] });
  }
}
void main().catch((e) => {
  console.error("proof failed:", String(e?.message ?? e).slice(0, 300));
  process.exitCode = 1;
});
