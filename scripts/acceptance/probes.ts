import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestObservation, LocalProof, Evidence, DeckObserved } from "./evaluators";

/** Observation helpers: each returns what a thing IS, read from outside it. Nothing here interprets a "done". */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ───────────────────────── bun tests as an observation ─────────────────────────

/**
 * Run one test file (optionally filtered by -t) and read each test's own result from bun's JUnit report (bun prints no
 * per-test lines without a terminal). A test that never ran is simply absent, which the evaluator counts as a failure.
 */
export function runBunTests(file: string, pattern?: string, timeoutMs = 600_000): TestObservation {
  const dir = join(process.env.ACCEPT_SCRATCH ?? "D:\\prog-scratch", "junit");
  mkdirSync(dir, { recursive: true });
  const report = join(dir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.xml`);
  const args = ["--no-env-file", "test", file, ...(pattern ? ["-t", pattern] : []), "--reporter=junit", `--reporter-outfile=${report}`];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const tests: { name: string; ok: boolean }[] = [];
  if (existsSync(report)) {
    const xml = readFileSync(report, "utf8");
    const unescape = (t: string) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
      if (!name) continue;
      const body = m[3] ?? "";
      // A filtered-out (or skipped) test did not run: it is absent, so a required test that only got skipped is a failure.
      if (/<skipped\b/.test(body)) continue;
      tests.push({ name: unescape(name), ok: !/<failure\b|<error\b/.test(body) });
    }
    try { rmSync(report, { force: true }); } catch { /* left for the scratch sweep */ }
  }
  return { tests, exitCode: r.status, file };
}

// ───────────────────────── earlier evidence, re-read ─────────────────────────

export function readEvidenceFile(path: string): { evidence: Evidence; at: string } | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const evidence = (Array.isArray(j) ? j : j.evidence) as Evidence;
    return { evidence, at: statSync(path).mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Lines of JSON printed by a proof driver (real-local-proof.ts), keyed by label. */
export function parseProofLines(text: string): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      (out[j.label] ??= []).push(j);
    } catch { /* not a record */ }
  }
  return out;
}

// ───────────────────────── PowerShell ─────────────────────────

export function ps(script: string, timeoutMs = 60_000): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: timeoutMs }).trim();
}

/** PowerPoint read from PowerPoint itself (its COM object model): the presentation whose first slide has this title. */
export function readDeckFromPowerPoint(title: string): DeckObserved {
  const b64 = Buffer.from(title, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { '{"found":false,"slideCount":0,"firstSlideTitle":""}'; exit 0 }
foreach ($p in $app.Presentations) {
  if ($p.Slides.Count -ge 1) {
    $t = ''
    try { $t = $p.Slides.Item(1).Shapes.Title.TextFrame.TextRange.Text } catch {}
    if ($t -eq $title) { (@{ found = $true; slideCount = $p.Slides.Count; firstSlideTitle = $t; layout = [int]$p.Slides.Item(1).Layout; saved = [bool]$p.Saved; path = [string]$p.FullName } | ConvertTo-Json -Compress); exit 0 }
  }
}
'{"found":false,"slideCount":0,"firstSlideTitle":""}'`;
  return JSON.parse(ps(script, 90_000));
}

/** Close ONLY the presentation whose first slide has this title (marked saved first so no dialog appears). Returns how many were closed. */
export function closeDeckInPowerPoint(title: string): number {
  const b64 = Buffer.from(title, "utf8").toString("base64");
  const script = `
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { '0'; exit 0 }
$n = 0
foreach ($p in @($app.Presentations)) {
  $t = ''
  try { $t = $p.Slides.Item(1).Shapes.Title.TextFrame.TextRange.Text } catch {}
  if ($t -eq $title) { $p.Saved = -1; $p.Close(); $n++ }
}
"$n"`;
  return Number(ps(script, 60_000));
}

// ───────────────────────── the isolated hub + a real companion (Agent B's real local proof) ─────────────────────────

export type LocalRig = {
  hub: string;
  dir: string;
  cfg: string;
  stop(): void;
  run(scenario: "c1" | "c2" | "d"): { text: string; parsed: Record<string, any[]> };
  /** Kill the hub process and start it again on the same data: a hub restart. */
  restartHub(): Promise<void>;
  state(): Promise<any>;
  job(id: string): Promise<any>;
  ledger(): any[];
};

const portFree = (port: number) => spawnSync("powershell.exe", ["-NoProfile", "-Command", `if (Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue) { 'busy' } else { 'free' }`], { encoding: "utf8", windowsHide: true }).stdout.trim() === "free";

/**
 * Start the isolated hub (scripts/devices/local-hub.ts, its own port and data folder) and ONE real companion process paired
 * to it. Everything it starts is recorded and stopped by `stop()`; nothing else is touched. Returns null with the reason
 * when it can't (port busy, pairing failed).
 */
export async function startLocalRig(dir: string, port: number): Promise<LocalRig | { error: string }> {
  if (!portFree(port)) return { error: `port ${port} is busy` };
  mkdirSync(dir, { recursive: true });
  const hub = `http://127.0.0.1:${port}`;
  const cfg = join(dir, "companion-cfg");
  const procs: ChildProcess[] = [];
  let hubProc = null as ChildProcess | null;
  const launchHub = () => {
    hubProc = spawn(process.execPath, ["scripts/devices/local-hub.ts", "--port", String(port), "--data", dir], { cwd: ROOT, stdio: "ignore", windowsHide: true });
    procs.push(hubProc);
  };
  const waitHub = async (ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const ok = await fetch(`${hub}/__proof/state`).then((r) => r.ok).catch(() => false);
      if (ok) return true;
      await sleep(500);
    }
    return false;
  };
  launchHub();
  if (!(await waitHub())) { hubProc?.pid && spawnSync("taskkill", ["/PID", String(hubProc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); return { error: "the isolated hub didn't start" }; }
  const companionPids = (): number[] => {
    const r = ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'bun*' -and $_.CommandLine -like '*companion/main.ts*' -and $_.CommandLine -like '*${cfg}*' } | ForEach-Object { $_.ProcessId }`);
    return r.split(/\s+/).filter(Boolean).map(Number);
  };
  const stop = () => {
    for (const pid of companionPids()) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    for (const p of procs) if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  };
  const code = existsSync(join(dir, "pair-code.txt")) ? readFileSync(join(dir, "pair-code.txt"), "utf8").trim() : "";
  if (!code) { stop(); return { error: "the hub wrote no pairing code" }; }
  const pair = spawnSync(process.execPath, ["companion/main.ts", "pair", "--hub", hub, "--code", code, "--config", cfg, "--label", "Acceptance PC"], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (pair.status !== 0) { stop(); return { error: `pairing failed (exit ${pair.status})` }; }
  const comp = spawn(process.execPath, ["companion/main.ts", "run", "--config", cfg], { cwd: ROOT, stdio: "ignore", windowsHide: true });
  procs.push(comp);
  const state = async () => (await (await fetch(`${hub}/__proof/state`)).json()) as any;
  const end = Date.now() + 40_000;
  while (Date.now() < end && !(await state().catch(() => ({ devices: [] }))).devices?.some((d: any) => d.online && d.kind === "companion")) await sleep(500);
  if (!(await state()).devices.some((d: any) => d.online && d.kind === "companion")) { stop(); return { error: "the real companion never came online" }; }
  return {
    hub, dir, cfg, stop, state,
    job: async (id) => (await (await fetch(`${hub}/__proof/job?id=${id}`)).json()) as any,
    ledger: () => { try { return JSON.parse(readFileSync(join(cfg, "command-ledger.json"), "utf8")); } catch { return []; } },
    run: (scenario) => {
      const r = spawnSync(process.execPath, ["scripts/devices/real-local-proof.ts", scenario, "--hub", hub, "--data", dir], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 240_000 });
      const text = `${r.stdout ?? ""}`;
      return { text, parsed: parseProofLines(text) };
    },
    restartHub: async () => {
      if (hubProc?.pid) spawnSync("taskkill", ["/PID", String(hubProc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await sleep(1500);
      launchHub();
      if (!(await waitHub())) throw new Error("the hub didn't come back");
    },
  };
}

/** Turn the driver's JSON lines for c1 / c2 / d into the evaluator's LocalProof. */
export function localProofFrom(parsed: Record<string, any[]>): LocalProof {
  const last = (label: string) => parsed[label]?.at(-1);
  return {
    jobState: last("job")?.state,
    steps: last("job")?.steps,
    companionLedger: last("companion-ledger")?.entries ?? last("ledger-after-kill")?.entries,
    hubCommands: last("hub-commands")?.forThisJob,
    afterRestart: last("after-restart") && { ledger: last("after-restart").ledger, jobStateNow: last("after-restart").jobStateNow, stepsRunAgain: last("after-restart").stepsRunAgain, hubSays: last("after-restart").hubSays },
  };
}

/** Remove a scratch folder this run made. Retries once after a pause (a just-killed process can still hold a handle); returns whether it is really gone. */
export async function rmScratch(dir: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* retried */ }
    if (!existsSync(dir)) return true;
    await sleep(1500);
  }
  return !existsSync(dir);
}
