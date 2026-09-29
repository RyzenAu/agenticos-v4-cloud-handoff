// The owner's PC, protected while a bench or the end-to-end suite runs (26 Sep, after round 3 lost
// his clipboard and changed a folder view). Used by scripts/jarvis-e2e/suite.ts,
// scripts/screen-hands/hardening-bench.ts and scripts/screen-hands/teach-demo.ts.
//
// - Real input only: a low-level keyboard and mouse hook in its own process reports input that
//   wasn't injected (LLKHF_INJECTED / LLMHF_INJECTED unset), so Jarvis's own clicks and keys don't
//   count and his do, the moment they happen. Runs start only after 60 s without his input, and a
//   run is stopped the moment he touches anything (a key, a click, a scroll, moving the mouse).
// - His clipboard: every format that can be read is copied into this helper's memory (never
//   written anywhere) before a run, fingerprinted (a SHA-256 per format), put back after, and the
//   fingerprint checked. If he copied something himself during the run, his newer clipboard wins.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPsHost, type PsHost } from "../jarvis-skills/ps-host";

const HOOK = String.raw`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Diagnostics;
public static class JarvisTouch {
  delegate IntPtr Proc(int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Proc p, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
  static Proc kb, ms; static long last;
  static void Say(string what) { long now = Environment.TickCount; if (now - last < 250) return; last = now; Console.Out.WriteLine("touch " + what); Console.Out.Flush(); }
  static IntPtr Kb(int code, IntPtr w, IntPtr l) { if (code >= 0) { int flags = Marshal.ReadInt32(l, 8); if ((flags & 0x10) == 0) Say("key"); } return CallNextHookEx(IntPtr.Zero, code, w, l); }
  static IntPtr Ms(int code, IntPtr w, IntPtr l) { if (code >= 0) { int flags = Marshal.ReadInt32(l, 12); if ((flags & 0x1) == 0) Say(w.ToInt64() == 0x200 ? "mouse-move" : "mouse"); } return CallNextHookEx(IntPtr.Zero, code, w, l); }
  public static void Run() { kb = Kb; ms = Ms; var mod = GetModuleHandle(null); SetWindowsHookEx(13, kb, mod, 0); SetWindowsHookEx(14, ms, mod, 0); Console.Out.WriteLine("ready"); Console.Out.Flush(); MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {} }
}
'@
[JarvisTouch]::Run()
`;

const CLIP_SAVE = [
  "$global:JarvisGuardClip = $null",
  "try { $o = [Windows.Forms.Clipboard]::GetDataObject(); if ($o) { $s = New-Object Windows.Forms.DataObject; foreach ($f in $o.GetFormats($false)) { try { $v = $o.GetData($f); if ($null -ne $v) { if ($v -is [IO.MemoryStream]) { $c = New-Object IO.MemoryStream; $v.Position = 0; $v.CopyTo($c); $c.Position = 0; $v = $c }; $s.SetData($f, $v) } } catch {} }; $global:JarvisGuardClip = $s } } catch {}",
].join("; ");
/** One line per format: "name=sha256". Text, streams, images, file lists; other objects by type. */
const CLIP_PRINT = String.raw`
function global:JarvisClipPrint($o) {
  if (-not $o) { return 'empty' }
  $sha = [Security.Cryptography.SHA256]::Create(); $rows = @()
  foreach ($f in @($o.GetFormats($false) | Sort-Object)) {
    try {
      $v = $o.GetData($f); $b = $null
      if ($v -is [string]) { $b = [Text.Encoding]::UTF8.GetBytes($v) }
      elseif ($v -is [IO.MemoryStream]) { $b = $v.ToArray() }
      elseif ($v -is [string[]]) { $b = [Text.Encoding]::UTF8.GetBytes(($v -join '|')) }
      elseif ($v -is [Drawing.Image]) { $m = New-Object IO.MemoryStream; $v.Save($m, [Drawing.Imaging.ImageFormat]::Png); $b = $m.ToArray() }
      if ($b) { $rows += $f + '=' + [BitConverter]::ToString($sha.ComputeHash($b)).Replace('-', '').Substring(0, 16) } else { $rows += $f + '=' + $(if ($v) { $v.GetType().Name } else { 'null' }) }
    } catch { $rows += $f + '=unreadable' }
  }
  if (-not $rows.Count) { 'empty' } else { $rows -join ';' }
}
`;
/** A multi-line definition through base64 (the helper reads one line per command). */
const defineInHost = (script: string) => `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script, "utf8").toString("base64")}')))`;

export type Guard = {
  /** Resolves when he's been away from the keyboard and mouse this long (default 60 s). */
  idle(seconds?: number, maxMs?: number): Promise<boolean>;
  /** Real input since the last `idle()` (or `arm()`), and what it was. */
  touched(): string | null;
  /** Start watching afresh (a new task). */
  arm(): void;
  /** Called at once on his first real input after arm(). */
  onTouch(listener: (what: string) => void): () => void;
  /** His clipboard: snapshot now (every readable format), fingerprint returned. */
  saveClipboard(): Promise<string>;
  /** Put the snapshot back and check it; `ours` are texts a run put there itself. */
  restoreClipboard(ours?: string[]): Promise<{ restored: boolean; verified: boolean; note: string }>;
  close(): void;
};

export async function createGuard(): Promise<Guard> {
  const ps: PsHost = createPsHost();
  await ps.run(`Add-Type -AssemblyName System.Drawing; ${defineInHost(CLIP_PRINT)}; 'ok'`, 30_000);
  let lastReal = 0;
  let touchedWhat: string | null = null;
  let armed = false;
  const listeners = new Set<(what: string) => void>();
  let hook: ChildProcessWithoutNullStreams | null = null;
  let ready = false;
  const startHook = () =>
    new Promise<void>((resolve) => {
      // A .ps1 file, not stdin: the hook's C# is a here-string, which "-Command -" can't read.
      const file = join(tmpdir(), `jarvis-guard-hook-${process.pid}.ps1`);
      writeFileSync(file, process.env.JARVIS_GUARD_SELFTEST === "1" ? HOOK.replace(/\(flags & 0x10\) == 0|\(flags & 0x1\) == 0/g, "true") : HOOK);
      hook = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true });
      hook.stdout.setEncoding("utf8");
      let buf = "";
      hook.stdout.on("data", (d: string) => {
        buf += d;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === "ready") {
            ready = true;
            resolve();
          } else if (line.startsWith("touch ")) {
            lastReal = Date.now();
            if (armed && !touchedWhat) {
              touchedWhat = line.slice(6);
              for (const l of listeners) l(touchedWhat);
            }
          }
        }
      });
      // (JARVIS_GUARD_SELFTEST=1 counts injected input too: only to check the hook itself works.)
      hook.stdin.end();
      hook.on("exit", () => void rmSync(file, { force: true }));
      setTimeout(resolve, 15_000);
    });
  await startHook();
  // Before the hook started: Windows' own last-input time (his or ours; we've sent nothing yet).
  const since = Number((await ps.run(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class JarvisGuardIdle { [StructLayout(LayoutKind.Sequential)] public struct L { public uint S; public uint T; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l); public static double Seconds() { var l = new L(); l.S = 8; GetLastInputInfo(ref l); return (Environment.TickCount - l.T) / 1000.0; } }'; [JarvisGuardIdle]::Seconds()`, 20_000)).trim()) || 0;
  lastReal = Date.now() - since * 1000;
  let saved: string | null = null;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async idle(seconds = 60, maxMs = 40 * 60_000) {
      if (!ready) throw new Error("the input watcher didn't start, so nothing runs");
      for (const until = Date.now() + maxMs; Date.now() < until; ) {
        if (Date.now() - lastReal >= seconds * 1000) {
          touchedWhat = null;
          armed = true;
          return true;
        }
        await sleep(1000);
      }
      return false;
    },
    touched: () => touchedWhat,
    arm() {
      touchedWhat = null;
      armed = true;
    },
    onTouch(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async saveClipboard() {
      saved = (await ps.run(`${CLIP_SAVE}; JarvisClipPrint $global:JarvisGuardClip`, 20_000)).trim();
      return saved;
    },
    async restoreClipboard(ours = []) {
      if (saved === null) return { restored: false, verified: false, note: "nothing saved" };
      const now = (await ps.run("JarvisClipPrint ([Windows.Forms.Clipboard]::GetDataObject())", 20_000)).trim();
      if (now === saved) return { restored: false, verified: true, note: "unchanged" };
      const text = (await ps.run("try { [string][Windows.Forms.Clipboard]::GetText() } catch { '' }", 10_000)).trim();
      // He copied something himself during the run: his newer clipboard stays.
      if (touchedWhat && !ours.some((o) => o && text.includes(o.slice(0, 40)))) return { restored: false, verified: false, note: `left his newer clipboard (he used the PC: ${touchedWhat})` };
      await ps.run("try { if ($global:JarvisGuardClip -and $global:JarvisGuardClip.GetFormats().Length) { [Windows.Forms.Clipboard]::SetDataObject($global:JarvisGuardClip, $true) } else { [Windows.Forms.Clipboard]::Clear() } } catch {}; 'ok'", 20_000);
      await sleep(300);
      const after = (await ps.run("JarvisClipPrint ([Windows.Forms.Clipboard]::GetDataObject())", 20_000)).trim();
      // Windows adds derived formats (Locale, OEMText…) on its own: every saved format must match.
      const want = new Map(saved.split(";").map((r) => r.split("=") as [string, string]));
      const got = new Map(after.split(";").map((r) => r.split("=") as [string, string]));
      const unicodeOk = !want.has("UnicodeText") || got.get("UnicodeText") === want.get("UnicodeText");
      const derived = /^(?:Locale|OEMText|Text|System\.String)$/;
      const missing = [...want].filter(([f, h]) => got.get(f) !== h && !(derived.test(f) && unicodeOk));
      const verified = saved === "empty" ? after === "empty" : missing.length === 0;
      return { restored: true, verified, note: verified ? `restored ${want.size} format(s)` : `restore differs: ${missing.map(([f]) => f).join(", ")}` };
    },
    close() {
      try {
        hook?.kill();
      } catch {}
      ps.close();
    },
  };
}
