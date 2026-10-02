#!/usr/bin/env bun
/**
 * Real proof driver for screen.goal and owner isolation against the FULL hub (Vite, MU_HUB_ROLE=cloud, isolated
 * MU_DATA_DIR) and real companion processes on this PC (programme 20261001, Agent B).
 *
 *   bun scripts/devices/real-goal-proof.ts <yt|cancel|kill|ppt|switch|stop|owners> [--hub http://127.0.0.1:8111] [--data D:\agent-scratch\prog-b\proof2]
 *
 * Prints one JSON evidence record per fact. Never prints the page token, tokens or cookies; prints only window titles of windows
 * a scenario opened itself.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const HUB = opt("hub", "http://127.0.0.1:8111");
const DATA = opt("data", "D:\\agent-scratch\\prog-b\\proof2");
const BUN = process.execPath;
const REPO = join(import.meta.dir, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const out = (label: string, value: Record<string, unknown>) => console.log(JSON.stringify({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, label, ...value }));
const ps = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 }).trim();

let tokenCache = "";
async function token() {
  return (tokenCache ||= ((await (await fetch(`${HUB}/__token`)).json()) as { token: string }).token);
}
const hdr = async (extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-claude-os-token": await token(), ...extra });

type Done = { ok: boolean; said: string; kind?: string; jobId: string | null; targetDeviceId: string | null; stopped?: boolean; outcome?: string; verified?: boolean | null; ask?: boolean; confirm?: string; refused?: boolean };
export async function command(body: Record<string, unknown>, onEvent?: (e: any) => void, extra: Record<string, string> = {}): Promise<{ done: Done; events: any[]; status: number }> {
  const res = await fetch(`${HUB}/__operator/screen/command`, { method: "POST", headers: await hdr(extra), body: JSON.stringify(body) });
  if (!res.headers.get("content-type")?.includes("ndjson")) {
    const j = (await res.json().catch(() => ({}))) as any;
    return { done: { ok: false, said: String(j.error ?? j.said ?? `HTTP ${res.status}`), jobId: null, targetDeviceId: null, refused: true, ...j }, events: [], status: res.status };
  }
  const events: any[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
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
      events.push(e);
      onEvent?.(e);
    }
  }
  return { done: events.findLast((e) => e.type === "done"), events, status: res.status };
}
async function job(id: string | null) {
  if (!id) return null;
  const j = (await (await fetch(`${HUB}/__jobs/${id}`)).json()) as any;
  return j.job ?? j;
}
const steps = (j: any, max = 140) => (j?.steps ?? []).map((s: any) => `${s.outcome}|${s.executor}|${String(s.intent).slice(0, max)}${s.verification ? `|v=${s.verification.ok}` : ""}`);
async function devices() {
  return (((await (await fetch(`${HUB}/__devices/devices`)).json()) as any).devices ?? []) as any[];
}
const cancel = async (jobId: string) => (await (await fetch(`${HUB}/__operator/screen/command/cancel`, { method: "POST", headers: await hdr(), body: JSON.stringify({ jobId }) })).json()) as any;

function companionPids(cfgTail: string): number[] {
  const r = ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'bun*' -and $_.CommandLine -like '*companion/main.ts*run*' -and $_.CommandLine -like '*${cfgTail}*' } | ForEach-Object { $_.ProcessId }`);
  return r.split(/\s+/).filter(Boolean).map(Number);
}
function startCompanion(cfgDir: string, dataDir: string) {
  const child = spawn(BUN, ["companion/main.ts", "run", "--config", cfgDir], { cwd: REPO, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, MU_DATA_DIR: dataDir } });
  child.unref();
}
async function waitFor<T>(what: string, check: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const windowsLike = (pattern: string) =>
  ps(`Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '${pattern}' } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowHandle)|$($_.MainWindowTitle)" }`).split(/\r?\n/).filter(Boolean);

const YT = "open a new Chrome tab, go to YouTube and search for Sydney weather";
const LONG = "open a new Chrome tab, go to YouTube, search for Sydney weather and open the first video";
const PC_CFG = join(DATA, "companion-cfg");
const PC_DATA = join(DATA, "pc-data");

async function main() {
  const devs = await devices();
  out("devices", { list: devs.map((d) => ({ id: d.id, owner: d.owner, label: d.label, online: d.online, displayLabel: d.displayLabel, mine: d.mine, caps: d.capabilities?.includes("screen.goal") ? "screen.goal" : "no screen.goal" })) });
  if (scenario === "yt") {
    const t = Date.now();
    const { done, events } = await command({ utterance: YT, source: "typed" });
    out("done", { ms: Date.now() - t, ok: done.ok, verified: done.verified, said: done.said, target: done.targetDeviceId });
    out("job", { steps: steps(await job(done.jobId)) });
    out("stream", { events: events.map((e) => e.type).reduce((a: Record<string, number>, k) => ((a[k] = (a[k] ?? 0) + 1), a), {}) });
    out("independent-windows", { titled: windowsLike("*Sydney weather*") });
  } else if (scenario === "cancel") {
    let jobId: string | null = null;
    const p = command({ utterance: LONG, source: "typed" }, (e) => void (e.type === "job" && (jobId = e.jobId)));
    // The moment the goal's own first action step is in the job (not the hub's narration), say stop.
    await waitFor("the goal's first action", async () => (((await job(jobId))?.steps ?? []) as any[]).some((s) => /^act:/.test(String(s.intent)) && s.executor !== "companion"), 60_000);
    const before = steps(await job(jobId)).length;
    const sent = Date.now();
    const r = await cancel(jobId!);
    out("cancel-sent", { stepsBefore: before, response: r });
    const { done } = await p;
    out("done", { cancelToDoneMs: Date.now() - sent, ok: done.ok, stopped: done.stopped, said: done.said });
    await sleep(3000);
    const j = await job(done.jobId);
    out("job", { state: j?.state, note: j?.note, stepsAfterStop: steps(j).length - before, steps: steps(j) });
  } else if (scenario === "kill") {
    let jobId: string | null = null;
    const p = command({ utterance: LONG, source: "typed" }, (e) => void (e.type === "job" && (jobId = e.jobId)));
    await waitFor("a sub-step in the job", async () => (((await job(jobId))?.steps ?? []) as any[]).some((s) => /^act:/.test(String(s.intent)) && s.executor !== "companion"), 60_000);
    const before = steps(await job(jobId));
    const pids = companionPids("proof2");
    out("kill", { companionPids: pids, stepsSoFar: before.length });
    for (const pid of pids) ps(`Stop-Process -Id ${pid} -Force`);
    const killedAt = Date.now();
    const { done } = await p;
    out("done", { afterKillMs: Date.now() - killedAt, ok: done.ok, outcome: done.outcome, verified: done.verified, said: done.said });
    const j = await job(done.jobId);
    out("job", { state: j?.state, note: j?.note, steps: steps(j) });
    startCompanion(PC_CFG, PC_DATA);
    await waitFor("companion back", async () => (await devices()).find((d) => d.online && d.owner === "usman"), 40_000);
    await sleep(2500);
    out("after-restart", { jobStateNow: (await job(done.jobId))?.state, stepCountNow: (await job(done.jobId))?.steps?.length });
  } else if (scenario === "ppt") {
    const t = Date.now();
    const { done } = await command({ utterance: "open PowerPoint and create a blank presentation", source: "typed" });
    out("done", { ms: Date.now() - t, ok: done.ok, verified: done.verified, said: done.said });
    out("job", { steps: steps(await job(done.jobId)) });
    out("independent-windows", { powerpoint: windowsLike("*PowerPoint*") });
  } else if (scenario === "switch") {
    const { done } = await command({ utterance: argv[1] && !argv[1].startsWith("--") ? argv[1] : "switch back to the website we were using", source: "typed" });
    out("done", { ok: done.ok, verified: done.verified, said: done.said, ask: done.ask });
    out("job", { steps: steps(await job(done.jobId)) });
  } else if (scenario === "stop") {
    // A goal is running; "stop that task" as a command stops it (the existing STOP_WORDS path through the job service).
    let jobId: string | null = null;
    const p = command({ utterance: YT, source: "typed" }, (e) => void (e.type === "job" && (jobId = e.jobId)));
    await waitFor("a sub-step", async () => ((await job(jobId))?.steps?.length ?? 0) >= 1, 60_000);
    const s = await command({ utterance: "stop that task", source: "typed" });
    out("stop-said", { said: s.done.said, ok: s.done.ok, stopped: s.done.stopped });
    const { done } = await p;
    const j = await job(done.jobId);
    out("original", { state: j?.state, stopped: done.stopped, said: done.said, steps: steps(j) });
  } else if (scenario === "back") {
    // example.com in Jarvis Chrome (a tab it opened), then PowerPoint, then the natural phrase.
    const nav = await command({ utterance: "proof step: open example.com", source: "typed", steps: [{ executor: "browser.navigate", args: { url: "https://example.com/" } }] });
    out("1-navigate", { ok: nav.done.ok, verified: nav.done.verified, said: nav.done.said });
    const ppt = await command({ utterance: "open PowerPoint and create a blank presentation", source: "typed" });
    out("2-powerpoint", { ok: ppt.done.ok, verified: ppt.done.verified, said: ppt.done.said });
    const foc = await command({ utterance: "proof step: bring PowerPoint to the front", source: "typed", steps: [{ executor: "app.focus", args: { name: "powerpoint" } }] });
    out("2b-focus-powerpoint", { ok: foc.done.ok, verified: foc.done.verified });
    await sleep(1000);
    out("front-before", { foregroundIsPowerPoint: /PowerPoint/.test(ps("Add-Type -Name F -Namespace U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);'; $sb = New-Object System.Text.StringBuilder 256; [void][U.F]::GetWindowText([U.F]::GetForegroundWindow(), $sb, 256); $sb.ToString()")) });
    const t = Date.now();
    const back = await command({ utterance: argv[1] && !argv[1].startsWith("--") ? argv[1] : "switch back to the website we were using", source: "typed" });
    out("3-switch-back", { ms: Date.now() - t, ok: back.done.ok, verified: back.done.verified, said: back.done.said, ask: back.done.ask });
    out("job", { steps: steps(await job(back.done.jobId), 160) });
    const title = ps("Add-Type -Name F2 -Namespace U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);'; $sb = New-Object System.Text.StringBuilder 256; [void][U.F2]::GetWindowText([U.F2]::GetForegroundWindow(), $sb, 256); $sb.ToString()");
    out("independent-foreground", { isExampleTab: /Example Domain/.test(title), title: /Example Domain/.test(title) ? title : "(not the example tab)" });
  } else if (scenario === "journeys") {
    const port = Number(argv[1] && !argv[1].startsWith("--") ? argv[1] : 9334);
    const tabsNow = async () => (((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).filter((t) => t.type === "page").map((t) => `${String(t.title).slice(0, 34)} | ${new URL(t.url).hostname || t.url}`));
    const nav = async (label: string, url: string, extra: Record<string, unknown> = {}) => {
      const r = await command({ utterance: `journey ${label}`, source: "typed", steps: [{ executor: "browser.navigate", args: { url, ...extra } }] });
      out(label, { ok: r.done.ok, verified: r.done.verified, said: r.done.said.slice(0, 120), tabs: await tabsNow() });
    };
    const say = async (label: string, utterance: string) => {
      const r = await command({ utterance, source: "typed" });
      out(label, { utterance, ok: r.done.ok, verified: r.done.verified, ask: r.done.ask, said: r.done.said.slice(0, 140), job: steps(await job(r.done.jobId), 90).slice(-2) });
      return r.done;
    };
    await nav("1-fresh-tab-example", "https://example.com/");
    await nav("2-navigate-and-search", "https://duckduckgo.com/?q=sydney+weather", { expectTitle: "sydney weather" });
    await say("3-return-to-recent-site", "go back to the example page");
    out("3-foreground-check", { tabs: await tabsNow() });
    // 4. the companion restarts: same session name and profile, the browser kept running; the hub still remembers the tab ids.
    const pids = companionPids("proof5");
    for (const pid of pids) ps(`Stop-Process -Id ${pid} -Force`);
    await sleep(1500);
    startCompanion(PC_CFG, PC_DATA);
    await waitFor("companion back", async () => (await devices()).find((d) => d.online && d.owner === "usman"), 40_000);
    out("4-companion-restarted", { killed: pids.length, tabsStillOpen: await tabsNow() });
    await say("4-resume-after-restart", "go back to the search page");
    // 5. the tab is closed behind everyone's back, then asked for.
    const exampleTab = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find((t) => /example\.com/.test(t.url));
    if (exampleTab) await fetch(`http://127.0.0.1:${port}/json/close/${exampleTab.id}`);
    await sleep(1000);
    out("5-tab-closed-by-hand", { tabs: await tabsNow() });
    await nav("5b-stale-id-navigate", "https://example.net/", { tabId: exampleTab?.id });
    await say("5c-back-to-closed-tab", "go back to the example page");
    // 6. cancel in the middle of a multi-step plan: the last navigation never happens.
    let jobId: string | null = null;
    const p6 = command({ utterance: "journey 6 three steps", source: "typed", steps: [{ executor: "browser.navigate", args: { url: "https://example.net/" } }, { executor: "wait", args: { ms: 20000 } }, { executor: "browser.navigate", args: { url: "https://example.org/" } }] }, (e) => void (e.type === "job" && (jobId = e.jobId)));
    await waitFor("step 2 running", async () => (((await job(jobId))?.steps ?? []) as any[]).some((s) => s.outcome === "ok" && /browser.navigate/.test(String(s.intent))), 60_000);
    await sleep(800);
    await cancel(jobId!);
    const d6 = await p6;
    await sleep(1500);
    out("6-cancel-mid-plan", { stopped: d6.done.stopped, job: (await job(d6.done.jobId))?.state, steps: steps(await job(d6.done.jobId), 70), orgOpened: (await tabsNow()).some((t) => /example\.org/.test(t)), tabs: await tabsNow() });
  } else if (scenario === "owners") {
    await owners();
  } else console.log("Usage: real-goal-proof.ts <yt|cancel|kill|ppt|switch|stop|owners>");
}

/** Cross-owner isolation on the real path, with a second (synthetic) paired companion for Mehroz on this same PC. */
async function owners() {
  const all = await devices();
  const usman = all.find((d) => d.owner === "usman" && d.kind === "companion");
  const mehroz = all.find((d) => d.owner === "mehroz" && d.kind === "companion");
  out("setup", { usman: usman?.id, mehroz: mehroz?.id, both: !!usman && !!mehroz });
  if (!usman || !mehroz) throw new Error("pair a companion for each person first");
  const rows = async () => ((await (await fetch(`${HUB}/__proof/commands`)).json().catch(() => ({ commands: [] }))) as any).commands ?? [];
  void rows;
  // Usman's loopback session names Mehroz's PC: refused before dispatch.
  for (const phrase of ["open Chrome on Mehroz's PC", "open notepad on mehroz's computer"]) {
    const r = await command({ utterance: phrase, source: "typed" });
    out("usman-names-mehroz", { phrase, ok: r.done.ok, said: r.done.said, target: r.done.targetDeviceId });
  }
  // A body that tries to smuggle a device id / display name / person id is ignored: identity is the verified principal.
  const smuggle = await command({ utterance: "open notepad", source: "typed", deviceId: mehroz.id, targetDeviceId: mehroz.id, personId: "mehroz", displayName: "Mehroz", spokenTarget: undefined });
  out("usman-body-smuggle", { said: smuggle.done.said, ok: smuggle.done.ok, target: smuggle.done.targetDeviceId, ranOnMehroz: smuggle.done.targetDeviceId === mehroz.id });
  const here = await command({ utterance: "what window is in front here", source: "typed", steps: [{ executor: "observe.window", args: {} }], spokenTarget: "here" });
  out("usman-here", { target: here.done.targetDeviceId, isUsmansOwn: here.done.targetDeviceId === usman.id, ok: here.done.ok });
}
void main().catch((e) => {
  console.error("proof failed:", String(e?.message ?? e).slice(0, 300));
  process.exitCode = 1;
});
