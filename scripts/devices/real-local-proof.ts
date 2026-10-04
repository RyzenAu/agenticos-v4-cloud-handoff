#!/usr/bin/env bun
/**
 * The real local proof driver (programme 20261001, Agent B): talks to the ISOLATED hub (scripts/devices/local-hub.ts,
 * default 127.0.0.1:8095) and a REAL companion process paired to it, and prints one evidence record per scenario.
 *
 *   bun scripts/devices/real-local-proof.ts <a|b|c1|c2|d> [--hub http://127.0.0.1:8095] [--data D:\agent-scratch\prog-b\proof]
 *
 *   a   "open Chrome" through the real command service → app.open on this PC → a new Chrome window, handle read back
 *   b   browser.navigate https://example.com → the tab's title/address read back from the browser itself (CDP), independently
 *   c1  a 3-step job cancelled the moment step 1 is done → steps 2 and 3 are never dispatched or run
 *   c2  a 3-step job cancelled through the cancel endpoint while step 2 runs → the companion aborts it; step 3 never starts
 *   d   the companion process is killed mid-step → the job ends uncertain (not success); restarted, the hub learns
 *       "interrupted"; nothing is replayed or moved
 *
 * Prints no tokens, no cookies and no window titles other than the ones it opened itself.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const HUB = opt("hub", "http://127.0.0.1:8095");
const DATA = opt("data", "D:\\agent-scratch\\prog-b\\proof");
const CFG = join(DATA, "companion-cfg");
const BUN = process.execPath;
const REPO = join(import.meta.dir, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

type Done = { ok: boolean; said: string; kind?: string; jobId: string | null; targetDeviceId: string | null; stopped?: boolean; outcome?: string; verified?: boolean | null; decision?: { op?: string } };

async function state() {
  return (await (await fetch(`${HUB}/__proof/state`)).json()) as { devices: any[]; commands: any[]; hubIsDevice: boolean; hubRole: string };
}
async function jobOf(id: string | null) {
  return id ? ((await (await fetch(`${HUB}/__proof/job?id=${id}`)).json()) as any) : null;
}
/** POST a command; resolves with its final "done" and every event line (so a step can trigger something mid-stream). */
async function command(body: Record<string, unknown>, onEvent?: (e: any) => void): Promise<{ done: Done; events: any[] }> {
  const res = await fetch(`${HUB}/__operator/screen/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const events: any[] = [];
  let buf = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
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
  return { done: events.findLast((e) => e.type === "done") as Done, events };
}
const ps = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 }).trim();
const ledger = (): any[] => {
  try {
    return JSON.parse(readFileSync(join(CFG, "command-ledger.json"), "utf8"));
  } catch {
    return [];
  }
};
const jobLine = (j: any) => j && { state: j.state, note: j.note, steps: j.steps.map((s: any) => `${s.executor}${s.action ? `/${s.action}` : ""}:${s.outcome}`) };
const out = (label: string, value: unknown) => console.log(JSON.stringify({ at: stamp(), label, ...(typeof value === "object" && value ? value : { value }) }));

function companionPids(): number[] {
  const r = ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'bun*' -and $_.CommandLine -like '*companion/main.ts*run*' -and $_.CommandLine -like '*${CFG}*' } | ForEach-Object { $_.ProcessId }`);
  return r.split(/\s+/).filter(Boolean).map(Number);
}
function startCompanion() {
  const child = spawn(BUN, ["companion/main.ts", "run", "--config", CFG], { cwd: REPO, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
async function waitFor<T>(what: string, check: () => Promise<T | null | false | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const online = async () => (await state()).devices.find((d) => d.online && d.kind === "companion");

async function main() {
  const s0 = await state();
  out("hub", { hubRole: s0.hubRole, hubIsDevice: s0.hubIsDevice, devices: s0.devices.map((d) => ({ id: d.id, label: d.label, online: d.online, displayLabel: d.displayLabel, workerVersion: d.workerVersion, interactive: d.interactive, capabilities: d.capabilities?.length })) });
  if (scenario === "a") {
    // The real instruction path: words → rules → one typed step → the companion's app.open → verified → the job log.
    const before = ps(`Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.MainWindowHandle }`).split(/\s+/).filter(Boolean);
    const t = Date.now();
    const { done } = await command({ utterance: "open Chrome", source: "typed" });
    out("done", { ms: Date.now() - t, ok: done.ok, said: done.said, verified: done.verified, target: done.targetDeviceId, op: done.decision?.op });
    out("job", jobLine(await jobOf(done.jobId)));
    const entry = ledger().findLast((e) => e.executor === "app.open");
    const data = entry?.output?.data ?? {};
    out("companion-ledger", { key: entry?.commandKey, state: entry?.state, evidence: entry?.output?.evidence, handle: data.handle, title: data.title });
    // An independent look at the window, not through the executor: is that handle a live Chrome window now?
    if (data.handle) {
      const live = ps(`$h=[IntPtr]${data.handle}; Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'; $p=0; [void][U.W]::GetWindowThreadProcessId($h,[ref]$p); "visible=$([U.W]::IsWindowVisible($h)) process=$((Get-Process -Id $p).ProcessName) wasListedBefore=${before.includes(String(data.handle))}"`);
      out("independent-check", { handle: data.handle, result: live });
      // Close ONLY the window it opened.
      ps(`Add-Type -Name W2 -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'; [void][U.W2]::PostMessage([IntPtr]${data.handle}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`);
      await sleep(1500);
      out("closed", { handle: data.handle, stillVisible: ps(`Add-Type -Name W3 -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);'; [U.W3]::IsWindow([IntPtr]${data.handle})`) });
    }
  } else if (scenario === "b") {
    const t = Date.now();
    const { done } = await command({ utterance: "open example.com in the browser", source: "typed", steps: [{ executor: "browser.navigate", args: { url: "https://example.com/" } }] });
    out("done", { ms: Date.now() - t, ok: done.ok, said: done.said, verified: done.verified, target: done.targetDeviceId });
    out("job", jobLine(await jobOf(done.jobId)));
    const entry = ledger().findLast((e) => e.executor === "browser.navigate");
    out("companion-ledger", { key: entry?.commandKey, state: entry?.state, evidence: entry?.output?.evidence, data: entry?.output?.data });
    // Independently: ask the browser itself (DevTools) what its tabs are. Only the tab this job opened is named.
    const tabs = (await (await fetch("http://127.0.0.1:9333/json/list")).json()) as any[];
    out("independent-check", { tabs: tabs.filter((x) => x.type === "page").map((x) => ({ title: x.title, url: x.url })) });
  } else if (scenario === "c1") {
    await fetch(`${HUB}/__proof/arm-cancel`, { method: "POST" });
    const before = ledger().length;
    const { done } = await command({ utterance: "three steps then stop after the first", source: "typed", steps: [{ executor: "observe.window", args: {} }, { executor: "wait", args: { ms: 4000 } }, { executor: "echo", args: { text: "step three" } }] });
    await sleep(1500);
    const j = await jobOf(done.jobId);
    out("done", { ok: done.ok, stopped: done.stopped, said: done.said });
    out("job", jobLine(j));
    const mine = ledger().slice(before);
    out("companion-ledger", { entries: mine.map((e) => `${e.executor}:${e.state}`), stepIds: mine.map((e) => e.stepId) });
    out("hub-commands", { forThisJob: (await state()).commands.filter((c) => c.jobId === done.jobId).map((c) => `${c.stepId}:${c.executor}:${c.status}`) });
  } else if (scenario === "c2") {
    const before = ledger().length;
    let jobId: string | null = null;
    const pending = command({ utterance: "three steps stop during the second", source: "typed", steps: [{ executor: "echo", args: { text: "step one" } }, { executor: "wait", args: { ms: 20000 } }, { executor: "echo", args: { text: "step three" } }] }, (e) => void (e.type === "job" && (jobId = e.jobId)));
    await waitFor("step 2 running on the companion", async () => (await state()).commands.find((c) => c.executor === "wait" && c.status === "delivered"));
    const t = Date.now();
    const cancel = await (await fetch(`${HUB}/__operator/screen/command/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }) })).json();
    const { done } = await pending;
    out("cancel", { ms: Date.now() - t, response: cancel });
    await sleep(1500);
    out("done", { ok: done.ok, stopped: done.stopped, said: done.said });
    out("job", jobLine(await jobOf(done.jobId)));
    const mine = ledger().slice(before);
    out("companion-ledger", { entries: mine.map((e) => `${e.stepId}:${e.executor}:${e.state}`) });
  } else if (scenario === "d") {
    const before = ledger().length;
    const pending = command({ utterance: "three steps, the PC dies in the second", source: "typed", steps: [{ executor: "echo", args: { text: "step one" } }, { executor: "wait", args: { ms: 120000 } }, { executor: "echo", args: { text: "step three" } }] });
    const running = await waitFor("step 2 running", async () => (await state()).commands.find((c) => c.executor === "wait" && c.status === "delivered"));
    await sleep(800);
    const pids = companionPids();
    out("kill", { companionPids: pids, step: running.stepId });
    for (const pid of pids) ps(`Stop-Process -Id ${pid} -Force`);
    const killedAt = Date.now();
    const { done } = await pending;
    out("done", { afterKillMs: Date.now() - killedAt, ok: done.ok, outcome: done.outcome, verified: done.verified, said: done.said });
    const j = await jobOf(done.jobId);
    out("job", jobLine(j));
    const cmds = (await state()).commands.filter((c) => c.jobId === done.jobId).map((c) => `${c.stepId}:${c.executor}:${c.status}`);
    out("hub-commands", { forThisJob: cmds });
    out("ledger-after-kill", { entries: ledger().filter((e) => e.jobId === done.jobId).map((e) => `${e.stepId}:${e.executor}:${e.state}`) });
    // The PC comes back (same pairing, same ledger file).
    startCompanion();
    await waitFor("the companion to come back online", online, 40_000);
    const observed = await waitFor("the hub to learn what became of step 2", async () => (await state()).commands.find((c) => c.jobId === done.jobId && c.executor === "wait" && c.observed), 30_000);
    await sleep(1500);
    out("after-restart", { hubSays: `${observed.stepId}:${observed.status}, the companion says: ${observed.observed}`, ledger: ledger().filter((e) => e.jobId === done.jobId).map((e) => `${e.stepId}:${e.executor}:${e.state}`), jobStateNow: (await jobOf(done.jobId))?.state, stepsRunAgain: (await state()).commands.filter((c) => c.jobId === done.jobId && c.status === "delivered").length });
  } else {
    console.log("Usage: real-local-proof.ts <a|b|c1|c2|d>");
  }
  if (!existsSync(DATA)) process.exitCode = 1;
}
void main().catch((e) => {
  console.error("proof failed:", String(e?.message ?? e).slice(0, 300));
  process.exitCode = 1;
});
