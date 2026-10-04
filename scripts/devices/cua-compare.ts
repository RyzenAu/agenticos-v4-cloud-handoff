#!/usr/bin/env bun
/**
 * Cua Driver vs our Windows executors, on the same Notepad tasks (programme 20261001, Agent B, round 4). Evidence, not an adapter.
 *
 *   CUA_EXE=<cua-driver.exe> CUA_PIPE=\\.\pipe\<name> bun scripts/devices/cua-compare.ts
 *
 * Needs a cua-driver daemon already running on that pipe (`cua-driver serve --socket <pipe>`), started from a scratch copy with telemetry
 * off. Everything it opens is Notepad windows/tabs it creates itself, cleaned up at the end (its own new tab emptied and closed; the
 * windows it launched closed by handle/pid). It prints one JSON line per fact: timings, outcomes, whether the foreground window changed.
 * It prints no window titles other than Notepad's own new-tab evidence and no environment.
 */
import { execFileSync } from "node:child_process";
import { createWindowsExecutors, liveWindowsDeps } from "../executors/windows";

const EXE = process.env.CUA_EXE ?? "";
const PIPE = process.env.CUA_PIPE ?? "";
if (!EXE || !PIPE) throw new Error("Set CUA_EXE and CUA_PIPE.");
const t0 = performance.now();
const out = (label: string, v: Record<string, unknown>) => console.log(JSON.stringify({ at: `+${((performance.now() - t0) / 1000).toFixed(1)}s`, label, ...v }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cua(tool: string, args: Record<string, unknown>) {
  const t = performance.now();
  const p = Bun.spawn([EXE, "call", tool, JSON.stringify({ session: "cmp", ...args }), "--socket", PIPE], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_TELEMETRY_ENABLED: "0" } });
  const o = await new Response(p.stdout).text();
  const e = await new Response(p.stderr).text();
  await p.exited;
  let json: any = null;
  try {
    json = JSON.parse(o);
  } catch {
    /* plain text result or error */
  }
  return { ms: Math.round(performance.now() - t), code: p.exitCode ?? -1, text: (o || e).trim(), json };
}
const ps = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).trim();
const FG = `Add-Type -Name F -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'; $p=0; $h=[U.F]::GetForegroundWindow(); [void][U.F]::GetWindowThreadProcessId($h,[ref]$p); "$h|$((Get-Process -Id $p).ProcessName)"`;
const foreground = () => ps(FG);

async function main() {
  const deps = liveWindowsDeps({ roots: [] });
  const ours = createWindowsExecutors(deps);
  const ctx = { signal: new AbortController().signal };
  const fg0 = foreground();
  out("start", { foreground: fg0 });

  // 1. Open an app (Notepad) and say which window is its own.
  const oursOpen = await (async () => {
    const t = performance.now();
    const r = await ours["app.open"]({ name: "notepad" }, ctx);
    return { ms: Math.round(performance.now() - t), r };
  })();
  out("ours.app.open", { ms: oursOpen.ms, ok: oursOpen.r.ok, verified: oursOpen.r.verified, evidence: oursOpen.r.evidence?.slice(0, 90), handle: (oursOpen.r.data as any)?.handle, foregroundAfter: foreground() });
  const cuaOpen = await cua("launch_app", { name: "notepad" });
  const cuaPid = cuaOpen.json?.pid as number;
  const cuaWin = cuaOpen.json?.windows?.[0]?.window_id as number;
  out("cua.launch_app", { ms: cuaOpen.ms, code: cuaOpen.code, pid: cuaPid, windowId: cuaWin, active: cuaOpen.json?.active, foregroundAfter: foreground(), note: "window reported with no focus steal; no post-action check of its own" });

  // 2. Exact window targeting: every Notepad window both sides can see.
  const oursWins = (await deps.windows()).filter((w) => /^notepad$/i.test(w.process));
  const cuaWins = await cua("list_windows", { pid: cuaPid });
  out("windows", { ours: oursWins.map((w) => w.handle), cua: (cuaWins.json?.windows ?? cuaWins.json ?? []).map?.((w: any) => w.window_id), cuaListMs: cuaWins.ms });

  // 3. Type a line into a NEW empty tab and read it back.
  const line = "cua compare line";
  const oursType = await (async () => {
    const t = performance.now();
    const fgBefore = foreground();
    const r = await ours["notepad.type"]({ text: line }, ctx);
    return { ms: Math.round(performance.now() - t), r, fgBefore };
  })();
  out("ours.notepad.type", { ms: oursType.ms, ok: oursType.r.ok, verified: oursType.r.verified, evidence: oursType.r.evidence, foregroundBefore: oursType.fgBefore, foregroundAfter: foreground(), handle: (oursType.r.data as any)?.handle });

  // cua: a new tab in the window IT launched, in the background (no foreground swap), then write and read back.
  const fgBefore = foreground();
  let tab = await cua("hotkey", { pid: cuaPid, window_id: cuaWin, keys: ["ctrl", "t"] });
  const backgroundFailure = tab.code !== 0 ? tab.text.replace(/\s+/g, " ").slice(0, 200) : null;
  // The driver's own contract: background first; only an explicit background_unavailable error escalates to a brief foreground swap.
  let escalated = false;
  if (tab.code !== 0 && /background_unavailable/.test(tab.text)) {
    escalated = true;
    tab = await cua("hotkey", { pid: cuaPid, window_id: cuaWin, keys: ["ctrl", "t"], delivery_mode: "foreground" });
  }
  out("cua.ctrl+t", { backgroundFailure, escalatedToForeground: escalated, finalCode: tab.code, foregroundAfter: foreground() });
  await sleep(800);
  const st1 = await cua("get_window_state", { pid: cuaPid, window_id: cuaWin, max_elements: 40 });
  const doc = (st1.json?.elements ?? []).find((e: any) => e.role === "Document");
  out("cua.new-tab+observe", { hotkeyMs: tab.ms, hotkeyCode: tab.code, stateMs: st1.ms, documentValueLength: String(doc?.value ?? "").length, hasToken: !!doc?.element_token });
  const typed = await cua("type_text", { pid: cuaPid, window_id: cuaWin, element_token: doc?.element_token, text: line });
  const st2 = await cua("get_window_state", { pid: cuaPid, window_id: cuaWin, max_elements: 40 });
  const doc2 = (st2.json?.elements ?? []).find((e: any) => e.role === "Document");
  const verify = await cua("verify_state", { pid: cuaPid, window_id: cuaWin, expect: [{ element: { selector: { role: "Document", label_contains: "Text editor" }, exists: true } }] });
  out("cua.type_text", { ms: typed.ms, code: typed.code, errorText: typed.code ? typed.text.replace(/\s+/g, " ").slice(0, 220) : undefined, readBackMatches: String(doc2?.value ?? "") === line, readBackLength: String(doc2?.value ?? "").length, foregroundBefore: fgBefore, foregroundAfter: foreground(), foregroundUnchanged: fgBefore === foreground(), verifyStateCode: verify.code, verifyState: verify.text.replace(/\s+/g, " ").slice(0, 160) });

  // 4. Structured failures and freshness.
  const bad = await cua("click", { pid: 99999999, x: 10, y: 10 });
  out("cua.failure(click bogus pid)", { code: bad.code, ms: bad.ms, text: bad.text.replace(/\s+/g, " ").slice(0, 200) });
  const badApp = await ours["app.open"]({ name: "no such program" }, ctx);
  out("ours.failure(unknown app)", { ok: badApp.ok, verified: badApp.verified, said: badApp.said.slice(0, 140), structured: Object.keys(badApp) });
  const fresh = await cua("get_window_state", { pid: cuaPid, window_id: cuaWin, max_elements: 40 });
  out("cua.freshness", { stateMs: fresh.ms, capture_id: fresh.json?.capture_id ? "present (an id per capture)" : "absent" });
  const tOurs = performance.now();
  const oursRead = await deps.editorText((oursType.r.data as any)?.handle ?? 0);
  out("ours.freshness", { readMs: Math.round(performance.now() - tOurs), readBackLength: oursRead?.length ?? null });

  // 5. Clean up: empty and close only the tabs/windows this script made.
  if (typed.code === 0 && tab.code === 0) {
    const m = escalated ? { delivery_mode: "foreground" } : {};
    await cua("hotkey", { pid: cuaPid, window_id: cuaWin, keys: ["ctrl", "a"], ...m });
    await cua("press_key", { pid: cuaPid, window_id: cuaWin, key: "delete", ...m });
    await cua("hotkey", { pid: cuaPid, window_id: cuaWin, keys: ["ctrl", "w"], ...m });
  }
  const h = (oursType.r.data as any)?.handle;
  if (h) {
    await deps.focus(h);
    await deps.keys(h, "ctrl+a");
    await deps.keys(h, "delete");
    await deps.keys(h, "ctrl+w");
  }
  await sleep(800);
  out("done", { foreground: foreground() });
  deps.close?.();
}
void main().catch((e) => {
  console.error("compare failed:", String(e?.message ?? e).slice(0, 300));
  process.exitCode = 1;
});
