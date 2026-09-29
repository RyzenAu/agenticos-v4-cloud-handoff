// The away sentinel: a tiny compiled helper that watches for HIM, not for Jarvis.
//
// - Low-level keyboard and mouse hooks report only real input: events flagged LLKHF_INJECTED /
//   LLMHF_INJECTED (SendInput from screen-hands, clipboard pastes, UIA) are ignored, so Jarvis's own
//   clicks never look like him coming back. Which key he pressed is never reported, only that he did.
// - Lock state: the input desktop can't be opened (or isn't "Default") while the PC is locked,
//   asleep on the sign-in screen or showing UAC. Windows won't let anything drive that desktop, and
//   this never tries: it only reports it.
// - Masked screenshots: one region, password and secret fields painted over, scaled down, saved as
//   a small JPEG. Taken only for the audit log and for an approval request.
// Built like the Jarvis overlay: the C# compiled once by Windows PowerShell's own compiler into an
// exe (named by the source hash) on D:, started when away mode goes on, stopped when it goes off.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Rect = { x: number; y: number; w: number; h: number };
export type RealInput = { kind: "key" | "mouse" | "move"; at: number };
export type Sentinel = {
  start(): Promise<boolean>;
  stop(): void;
  /** true = locked (secure desktop), false = unlocked, null = unknown (helper not running). */
  locked(): Promise<boolean | null>;
  /** Idle time from GetLastInputInfo (includes Jarvis's own input): for arming at the start. */
  idleMs(): Promise<number | null>;
  /** A masked, scaled screenshot of `rect` saved to `path`; false if it couldn't be taken. */
  shot(path: string, rect: Rect, masks: Rect[], ring?: Rect | null, maxWidth?: number): Promise<boolean>;
  onInput(listener: (input: RealInput) => void): () => void;
  readonly running: boolean;
};

/** C# 5 (Windows PowerShell's Add-Type compiler): no string interpolation, no `?.`. */
export const SENTINEL_SOURCE = String.raw`
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class AwaySentinel {
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder buf, int len, out int needed);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBLL { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }

  static HookProc mouseProc, keyProc;
  static IntPtr mouseHook, keyHook;
  static readonly object outLock = new object();
  static int lastX = int.MinValue, lastY = int.MinValue, travel = 0;
  static long lastMoveOut = 0, lastPressOut = 0;
  static int lastLock = -1;

  static void Say(string line) { lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
  static long Now() { return DateTime.UtcNow.Ticks / 10000; }

  static IntPtr OnMouse(int n, IntPtr w, IntPtr l) {
    if (n >= 0) {
      MSLL m = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
      bool injected = (m.flags & 0x3) != 0;
      if (!injected) {
        int msg = w.ToInt32();
        long now = Now();
        if (msg == 0x0200) {
          if (lastX != int.MinValue) travel += Math.Abs(m.x - lastX) + Math.Abs(m.y - lastY);
          lastX = m.x; lastY = m.y;
          if (travel >= 12 && now - lastMoveOut > 250) { travel = 0; lastMoveOut = now; Say("in move"); }
        } else if (now - lastPressOut > 100) { lastPressOut = now; Say("in mouse"); }
      }
    }
    return CallNextHookEx(mouseHook, n, w, l);
  }
  static IntPtr OnKey(int n, IntPtr w, IntPtr l) {
    if (n >= 0) {
      KBLL k = (KBLL)Marshal.PtrToStructure(l, typeof(KBLL));
      bool injected = (k.flags & 0x12) != 0;
      int msg = w.ToInt32();
      if (!injected && (msg == 0x0100 || msg == 0x0104)) {
        long now = Now();
        if (now - lastPressOut > 100) { lastPressOut = now; Say("in key"); }
      }
    }
    return CallNextHookEx(keyHook, n, w, l);
  }

  public static int Locked() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return 1;
    try {
      StringBuilder sb = new StringBuilder(256); int needed;
      if (!GetUserObjectInformation(d, 2, sb, 512, out needed)) return 1;
      return String.Equals(sb.ToString(), "Default", StringComparison.OrdinalIgnoreCase) ? 0 : 1;
    } finally { CloseDesktop(d); }
  }
  static uint Idle() {
    LASTINPUTINFO info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref info)) return 0;
    return (uint)Environment.TickCount - info.dwTime;
  }

  static Rectangle ParseRect(string s) {
    string[] p = s.Split(',');
    return new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
  }
  // shot <id> <path-b64> <x,y,w,h> <maxW> <ring x,y,w,h|-> [mask x,y,w,h;...]
  static void Shot(string[] a) {
    string id = a[1];
    try {
      if (Locked() == 1) { Say("shot " + id + " err locked"); return; }
      string path = Encoding.UTF8.GetString(Convert.FromBase64String(a[2]));
      Rectangle r = ParseRect(a[3]);
      int maxW = int.Parse(a[4]);
      if (r.Width < 8 || r.Height < 8 || r.Width > 20000 || r.Height > 20000) { Say("shot " + id + " err size"); return; }
      using (Bitmap full = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(full)) {
          g.CopyFromScreen(r.X, r.Y, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
          if (a.Length > 6 && a[6].Length > 0) {
            foreach (string m in a[6].Split(';')) {
              if (m.Length == 0) continue;
              Rectangle mr = ParseRect(m); mr.Offset(-r.X, -r.Y); mr.Inflate(3, 3);
              g.FillRectangle(Brushes.Black, mr);
            }
          }
          if (a[5] != "-") {
            Rectangle rr = ParseRect(a[5]); rr.Offset(-r.X, -r.Y); rr.Inflate(6, 6);
            using (Pen pen = new Pen(Color.FromArgb(255, 239, 68, 68), Math.Max(3, r.Width / 300))) g.DrawRectangle(pen, rr);
          }
        }
        double scale = Math.Min(1.0, (double)maxW / r.Width);
        int w = Math.Max(1, (int)(r.Width * scale)), h = Math.Max(1, (int)(r.Height * scale));
        using (Bitmap small = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
          using (Graphics g2 = Graphics.FromImage(small)) { g2.InterpolationMode = InterpolationMode.HighQualityBicubic; g2.DrawImage(full, 0, 0, w, h); }
          ImageCodecInfo jpeg = null;
          foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
          EncoderParameters ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 55L);
          Directory.CreateDirectory(Path.GetDirectoryName(path));
          small.Save(path, jpeg, ep);
          Say("shot " + id + " ok " + w + " " + h);
        }
      }
    } catch (Exception e) { Say("shot " + id + " err " + e.Message.Replace("\r", " ").Replace("\n", " ")); }
  }

  static void Reader() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] a = line.Trim().Split(' ');
      if (a.Length == 0) continue;
      try {
        if (a[0] == "lock") Say("lock " + Locked());
        else if (a[0] == "idle") Say("idle " + Idle());
        else if (a[0] == "shot" && a.Length >= 6) Shot(a);
        else if (a[0] == "quit") break;
      } catch (Exception e) { Say("error " + e.Message.Replace("\r", " ").Replace("\n", " ")); }
    }
    Application.Exit();
  }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    mouseProc = OnMouse; keyProc = OnKey;
    IntPtr mod = GetModuleHandle(null);
    mouseHook = SetWindowsHookEx(14, mouseProc, mod, 0);
    keyHook = SetWindowsHookEx(13, keyProc, mod, 0);
    Say("ready " + (mouseHook != IntPtr.Zero ? 1 : 0) + " " + (keyHook != IntPtr.Zero ? 1 : 0));
    Thread t = new Thread(Reader); t.IsBackground = true; t.Start();
    System.Threading.Timer poll = new System.Threading.Timer(delegate(object o) {
      int now = Locked();
      if (now != lastLock) { lastLock = now; Say("lockstate " + now); }
    }, null, 0, 1500);
    Application.Run();
    poll.Dispose();
    if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
    if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
  }
}
public static class AwaySentinelMain { [System.STAThread] public static void Main() { AwaySentinel.Run(); } }
`;

export function sentinelExe(binDir: string, source = SENTINEL_SOURCE) {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  return join(binDir, `away-sentinel-${hash}.exe`);
}

function compileScript(exePath: string, source: string) {
  const b64 = Buffer.from(source, "utf8").toString("base64");
  const path = exePath.replace(/'/g, "''");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "$refs = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Bitmap].Assembly.Location)",
    `Add-Type -ReferencedAssemblies $refs -OutputType ConsoleApplication -OutputAssembly '${path}' -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
  ].join("\n");
}

async function ensureExe(binDir: string, source: string): Promise<string | null> {
  const exe = sentinelExe(binDir, source);
  if (existsSync(exe)) return exe;
  mkdirSync(binDir, { recursive: true });
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true });
    const timer = setTimeout(() => ps.kill(), 90_000);
    ps.on("error", () => resolve(null));
    ps.on("close", () => {
      clearTimeout(timer);
      resolve(existsSync(exe) ? exe : null);
    });
    ps.stdin.end(`${compileScript(exe, source)}\n`);
  });
}

const rectArg = (r: Rect) => [r.x, r.y, r.w, r.h].map((n) => Math.round(n)).join(",");

/** The real sentinel (Windows only). */
export function nativeSentinel(binDir: string, source = SENTINEL_SOURCE): Sentinel {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let starting: Promise<boolean> | null = null;
  const listeners = new Set<(input: RealInput) => void>();
  const waiters = new Map<string, Array<(line: string) => void>>();
  let lockState: boolean | null = null;
  let seq = 0;
  let buffer = "";

  const onLine = (line: string) => {
    const [head, ...rest] = line.trim().split(" ");
    if (head === "in") {
      const kind = rest[0] === "key" ? "key" : rest[0] === "move" ? "move" : "mouse";
      for (const l of listeners) l({ kind, at: Date.now() });
      return;
    }
    if (head === "lockstate") {
      lockState = rest[0] === "1";
      return;
    }
    const key = head === "shot" ? `shot ${rest[0]}` : head;
    const queue = waiters.get(key);
    const next = queue?.shift();
    if (next) next(line.trim());
  };
  const ask = (command: string, key: string, timeoutMs: number) =>
    new Promise<string | null>((resolve) => {
      if (!proc) return resolve(null);
      const timer = setTimeout(() => {
        const q = waiters.get(key);
        const i = q?.indexOf(done) ?? -1;
        if (q && i >= 0) q.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const done = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      waiters.set(key, [...(waiters.get(key) ?? []), done]);
      proc.stdin.write(`${command}\n`);
    });

  return {
    get running() {
      return !!proc;
    },
    start() {
      if (proc) return Promise.resolve(true);
      if (process.platform !== "win32") return Promise.resolve(false);
      starting ??= (async () => {
        const exe = await ensureExe(binDir, source);
        if (!exe) return false;
        const child = spawn(exe, [], { windowsHide: true });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          let i: number;
          while ((i = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            if (line.trim()) onLine(line);
          }
        });
        child.on("exit", () => {
          if (proc === child) proc = null;
          lockState = null;
        });
        child.on("error", () => undefined);
        proc = child;
        return true;
      })().finally(() => {
        starting = null;
      });
      return starting;
    },
    stop() {
      const p = proc;
      proc = null;
      lockState = null;
      if (p) {
        try {
          p.stdin.write("quit\n");
        } catch {
          /* gone */
        }
        setTimeout(() => p.kill(), 1500).unref?.();
      }
    },
    async locked() {
      if (!proc) return null;
      const line = await ask("lock", "lock", 3000);
      if (line) lockState = line.endsWith(" 1");
      return lockState;
    },
    async idleMs() {
      const line = await ask("idle", "idle", 3000);
      const n = line ? Number(line.split(" ")[1]) : NaN;
      return Number.isFinite(n) ? n : null;
    },
    async shot(path, rect, masks, ring, maxWidth = 960) {
      if (!proc) return false;
      const id = String(++seq);
      const args = ["shot", id, Buffer.from(path, "utf8").toString("base64"), rectArg(rect), String(maxWidth), ring ? rectArg(ring) : "-", masks.map(rectArg).join(";")];
      const line = await ask(args.join(" "), `shot ${id}`, 15_000);
      return !!line && / ok /.test(line);
    },
    onInput(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
