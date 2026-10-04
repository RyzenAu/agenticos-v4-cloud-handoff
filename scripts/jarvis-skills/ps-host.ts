// One warm, hidden PowerShell for Jarvis's Windows skills (clipboard, typing, windows, battery).
// A cold `powershell.exe` costs ~300 ms and compiling the user32 helper another ~300 ms, which
// would blow the "instant" budget on every command; kept warm, a command is ~20–50 ms.
//
// Safety: commands are fixed script templates written in this repo. Anything that came from
// speech (text to type, a window handle) is passed ONLY as base64 or a validated integer, so it
// can never be read as PowerShell. Output that may hold arbitrary text is base64 too.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type PsHost = { run: (script: string, timeoutMs?: number) => Promise<string>; close: () => void; warm: () => void };

/** A C# helper compiled once per host: window list, focus, keys. No // comments (one line). */
const HELPER = [
  "using System; using System.Text; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices;",
  "public static class JarvisWin {",
  " public delegate bool EnumProc(IntPtr h, IntPtr l);",
  ' [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  ' [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  ' [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  ' [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  ' [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  ' [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  ' [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  ' [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  ' [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
  ' [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
  ' [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  ' [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  ' [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  ' [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);',
  " static string Clean(string s) { return (s ?? \"\").Replace(\"\\t\", \" \").Replace(\"\\n\", \" \").Replace(\"\\r\", \" \"); }",
  " public static string Info(IntPtr h) {",
  "  var t = new StringBuilder(512); GetWindowText(h, t, 512); var c = new StringBuilder(256); GetClassName(h, c, 256);",
  "  uint pid; GetWindowThreadProcessId(h, out pid); string p = \"\"; try { p = Process.GetProcessById((int)pid).ProcessName; } catch {}",
  "  return h.ToInt64() + \"\\t\" + Clean(p) + \"\\t\" + Clean(c.ToString()) + \"\\t\" + Clean(t.ToString()); }",
  " public static string Foreground() { return Info(GetForegroundWindow()); }",
  " public static string List() { var rows = new List<string>(); EnumWindows(delegate (IntPtr h, IntPtr l) {",
  "  if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true; int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;",
  "  var t = new StringBuilder(8); if (GetWindowText(h, t, 8) == 0) return true; rows.Add(Info(h)); return rows.Count < 80; }, IntPtr.Zero); return String.Join(\"\\n\", rows.ToArray()); }",
  // Focus without the old Alt tap (it opened the app's menu bar: Notepad's File menu ate the
  // typing). Already in front: nothing is sent. Else SetForegroundWindow; else with this thread's
  // input attached to the front window's thread; last, a lone F24 key-up (no key-down, so no app
  // sees a key) makes this the last-input process, which Windows lets take the foreground.
  " public static bool Focus(long handle) { var h = new IntPtr(handle); if (IsIconic(h)) ShowWindow(h, 9);",
  "  if (GetForegroundWindow() == h) return true; if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;",
  "  uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId(); bool att = fg != 0 && fg != me && AttachThreadInput(me, fg, true);",
  "  try { BringWindowToTop(h); SetForegroundWindow(h); } finally { if (att) AttachThreadInput(me, fg, false); } if (GetForegroundWindow() == h) return true;",
  "  keybd_event(0x87, 0, 2, UIntPtr.Zero); SetForegroundWindow(h); return GetForegroundWindow() == h; }",
  " public static uint PidOf(long handle) { uint pid; GetWindowThreadProcessId(new IntPtr(handle), out pid); return pid; }",
  " public static void Chord(byte a, byte b) { keybd_event(a, 0, 0, UIntPtr.Zero); keybd_event(b, 0, 1, UIntPtr.Zero); keybd_event(b, 0, 3, UIntPtr.Zero); keybd_event(a, 0, 2, UIntPtr.Zero); }",
  // His screens and moving a window between them (jarvis-skills/monitors.ts does the maths). Each
  // call runs per-monitor DPI aware on this thread only, so every number is a physical pixel on any
  // mix of display scales; a screen left of or above the main one has negative coordinates.
  " [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }",
  " [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct MONINFO { public int Size; public RECT M; public RECT W; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Dev; }",
  " [StructLayout(LayoutKind.Sequential)] public struct PLACEMENT { public int Length; public int Flags; public int ShowCmd; public int MinX, MinY, MaxX, MaxY; public RECT Normal; }",
  " public delegate bool MonProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr d);",
  ' [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc cb, IntPtr d);',
  ' [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONINFO i);',
  ' [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);',
  ' [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr m, int t, out uint x, out uint y);',
  ' [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);',
  ' [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  ' [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);',
  ' [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT p);',
  ' [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);',
  " static IntPtr Aware() { try { return SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { return IntPtr.Zero; } }",
  " static void Unaware(IntPtr old) { try { if (old != IntPtr.Zero) SetThreadDpiAwarenessContext(old); } catch {} }",
  " public static void PerMonitorDpi() { Aware(); }",
  " static string R(RECT r) { return r.L + \"\\t\" + r.T + \"\\t\" + (r.R - r.L) + \"\\t\" + (r.B - r.T); }",
  " public static string Monitors() { var old = Aware(); try { var rows = new List<string>(); EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr dc, ref RECT r, IntPtr d) {",
  "  var i = new MONINFO(); i.Size = Marshal.SizeOf(typeof(MONINFO)); if (!GetMonitorInfo(m, ref i)) return true; uint dx = 96, dy = 96; try { GetDpiForMonitor(m, 0, out dx, out dy); } catch {}",
  "  rows.Add(m.ToInt64() + \"\\t\" + R(i.M) + \"\\t\" + R(i.W) + \"\\t\" + ((i.Flags & 1) != 0 ? 1 : 0) + \"\\t\" + dx + \"\\t\" + Clean(i.Dev)); return true; }, IntPtr.Zero); return String.Join(\"\\n\", rows.ToArray()); } finally { Unaware(old); } }",
  // The normal (restored) rectangle comes from GetWindowPlacement, in workspace coordinates:
  // shifted by the main screen's work-area offset to screen coordinates.
  " public static string State(long handle) { var old = Aware(); try { var h = new IntPtr(handle); RECT r; GetWindowRect(h, out r); var p = new PLACEMENT(); p.Length = Marshal.SizeOf(typeof(PLACEMENT)); GetWindowPlacement(h, ref p);",
  "  var pm = new MONINFO(); pm.Size = Marshal.SizeOf(typeof(MONINFO)); GetMonitorInfo(MonitorFromWindow(IntPtr.Zero, 1), ref pm); int ox = pm.W.L - pm.M.L, oy = pm.W.T - pm.M.T;",
  "  var n = new RECT(); n.L = p.Normal.L + ox; n.T = p.Normal.T + oy; n.R = p.Normal.R + ox; n.B = p.Normal.B + oy;",
  "  return handle + \"\\t\" + (IsIconic(h) ? 1 : 0) + \"\\t\" + (IsZoomed(h) ? 1 : 0) + \"\\t\" + ((p.Flags & 2) != 0 ? 1 : 0) + \"\\t\" + R(r) + \"\\t\" + R(n) + \"\\t\" + MonitorFromWindow(h, 2).ToInt64(); } finally { Unaware(old); } }",
  // Restore, move (position first, then size, so a change of display scale can't undo the size),
  // maximise again if asked. Nothing is clicked or typed.
  " public static string Place(long handle, int x, int y, int w, int hh, bool max) { var old = Aware(); try { var h = new IntPtr(handle);",
  "  if (IsIconic(h)) ShowWindow(h, 9); if (IsZoomed(h)) ShowWindow(h, 9);",
  "  SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010); SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0004 | 0x0010); if (max) ShowWindow(h, 3);",
  "  RECT r; GetWindowRect(h, out r); return R(r); } finally { Unaware(old); } }",
  "}",
].join(" ");

const PRELUDE = [
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  `Add-Type -TypeDefinition '${HELPER.replace(/'/g, "''")}'`,
  "$null = [Windows.Forms.Clipboard]::ContainsText()",
];

/** Base64 of UTF-8 text, for passing speech into a script without it ever being code. */
export const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
export const unb64 = (text: string) => Buffer.from(text.trim(), "base64").toString("utf8");
/** PowerShell expression decoding a base64 literal (the alphabet can't break out of quotes). */
export const psText = (text: string) => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}')))`;

/**
 * `prelude` adds lines run once after the standard ones (screen-hands compiles its UI Automation
 * and SendInput helper there, in its own host, so a slow screen step never queues behind a skill).
 */
export function createPsHost(options: { prelude?: string[] } = {}): PsHost {
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = "";
  let counter = 0;
  const waiting: Array<{ marker: string; resolve: (out: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let chain: Promise<unknown> = Promise.resolve();

  function stop() {
    const dead = child;
    child = null;
    buffer = "";
    for (const w of waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error("Windows helper stopped."));
    }
    try {
      dead?.stdin.end();
      dead?.kill();
    } catch {
      /* already gone */
    }
  }

  function start() {
    if (child) return child;
    if (process.platform !== "win32") throw new Error("This skill needs Windows.");
    const proc = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      windowsHide: true,
    });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (data: string) => {
      buffer += data;
      while (waiting.length) {
        const at = buffer.indexOf(waiting[0].marker);
        if (at < 0) break;
        const out = buffer.slice(0, at);
        buffer = buffer.slice(at + waiting[0].marker.length).replace(/^\r?\n/, "");
        const w = waiting.shift()!;
        clearTimeout(w.timer);
        w.resolve(out);
      }
    });
    proc.stderr.on("data", () => undefined);
    proc.on("exit", () => {
      if (child === proc) stop();
    });
    proc.on("error", () => {
      if (child === proc) stop();
    });
    child = proc;
    for (const line of [...PRELUDE, ...(options.prelude ?? [])]) proc.stdin.write(`${line}\n`);
    return proc;
  }

  function exec(script: string, timeoutMs: number) {
    return new Promise<string>((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = start();
      } catch (error) {
        return reject(error as Error);
      }
      const marker = `<<jarvis-${++counter}-${Date.now().toString(36)}>>`;
      const timer = setTimeout(() => {
        // A wedged helper is replaced, not waited on.
        stop();
        reject(new Error("Windows took too long to answer."));
      }, timeoutMs);
      waiting.push({ marker, resolve, reject, timer });
      // One line per command: `-Command -` reads line by line. Errors come back as text.
      const oneLine = script.replace(/\r?\n/g, " ");
      proc.stdin.write(`try { ${oneLine} } catch { 'ERROR: ' + $_.Exception.Message }\nWrite-Output '${marker}'\n`);
    });
  }

  return {
    /** Runs one command at a time, in order. The first call also pays the ~0.6 s warm-up. */
    run(script: string, timeoutMs = 6000) {
      const next = chain.then(() => exec(script, timeoutMs));
      chain = next.catch(() => undefined);
      return next;
    },
    warm() {
      if (process.platform === "win32") void this.run("'ready'", 15_000).catch(() => undefined);
    },
    close: stop,
  };
}
