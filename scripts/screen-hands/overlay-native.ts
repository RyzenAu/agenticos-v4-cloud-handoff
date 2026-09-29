// The Jarvis cursor overlay, native side: a tiny WinForms message loop in its own hidden
// PowerShell (C# compiled once with Add-Type, ~1 s at start-up). Design and reasons:
// docs/SCREEN-CONTROL.md, "The Jarvis cursor".
//
// Three per-pixel-alpha layered windows (UpdateLayeredWindow over a DIB section, no allocation per
// frame): the pointer with its "J" badge and trail, the caption bubble and the target ring. All are
// WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST, so they
// never take focus or clicks, and each asks for WDA_EXCLUDEFROMCAPTURE so screenshots skip them.
// The process is per-monitor DPI aware (v2): every coordinate is a physical pixel, the same space
// UI Automation rectangles use, on any monitor. A 15 ms timer runs only while something moves;
// the ring's pulse changes only the layer's constant alpha (~30 fps, no redraw); idle is 0 CPU.
//
// Protocol: one command per stdin line; events on stdout (`ready <affinity>`, `click <button> x y`,
// `pong …`, `error …`). Text arrives as base64 only and numbers are parsed as numbers, so nothing
// said aloud can become code. stdin closing ends the process.

/** C# 5 (Windows PowerShell's Add-Type compiler): no string interpolation, no `?.`. */
export const OVERLAY_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class JarvisOverlay {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; public PT(int x, int y) { X = x; Y = y; } }
  [StructLayout(LayoutKind.Sequential)] public struct SZ { public int W; public int H; public SZ(int w, int h) { W = w; H = h; } }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLEND { public byte Op; public byte Flags; public byte Alpha; public byte Format; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] public struct BMIH { public int Size; public int Width; public int Height; public short Planes; public short Bits; public int Compression; public int SizeImage; public int XPels; public int YPels; public int ClrUsed; public int ClrImportant; }
  [StructLayout(LayoutKind.Sequential)] public struct MSLL { public PT Pt; public uint Data; public uint Flags; public uint Time; public IntPtr Extra; }
  public delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref PT pos, ref SZ size, IntPtr src, ref PT srcPos, int key, ref BLEND blend, int flags);
  [DllImport("user32.dll", EntryPoint = "UpdateLayeredWindow")] static extern bool MoveLayered(IntPtr h, IntPtr dst, ref PT pos, IntPtr size, IntPtr src, IntPtr srcPos, int key, ref BLEND blend, int flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMIH bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(PT pt, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint x, out uint y);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUT { public uint Size; public uint Time; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUT li);

  // One click-through, never-activated, always-on-top layered window with its own DIB canvas.
  class Layer : NativeWindow {
    public int X, Y, W, H; public byte Alpha = 255; public bool Shown;
    IntPtr dc = IntPtr.Zero, dib = IntPtr.Zero, old = IntPtr.Zero;
    public Bitmap Canvas; public Graphics G;
    public Layer(string title) {
      var cp = new CreateParams();
      cp.Caption = title;
      cp.Style = unchecked((int)0x80000000);
      cp.ExStyle = 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000 | 0x00000008;
      cp.Width = 1; cp.Height = 1;
      CreateHandle(cp);
    }
    protected override void WndProc(ref Message m) {
      if (m.Msg == 0x0084) { m.Result = new IntPtr(-1); return; }
      if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; }
      base.WndProc(ref m);
    }
    public void Resize(int w, int h) {
      w = Math.Max(1, w); h = Math.Max(1, h);
      if (Canvas != null && w == W && h == H) return;
      Free(); W = w; H = h;
      var bi = new BMIH(); bi.Size = Marshal.SizeOf(typeof(BMIH)); bi.Width = w; bi.Height = -h; bi.Planes = 1; bi.Bits = 32;
      IntPtr bits;
      dc = CreateCompatibleDC(IntPtr.Zero);
      dib = CreateDIBSection(dc, ref bi, 0, out bits, IntPtr.Zero, 0);
      old = SelectObject(dc, dib);
      Canvas = new Bitmap(w, h, w * 4, PixelFormat.Format32bppPArgb, bits);
      G = Graphics.FromImage(Canvas);
      G.SmoothingMode = SmoothingMode.AntiAlias;
      G.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      G.PixelOffsetMode = PixelOffsetMode.HighQuality;
    }
    void Free() {
      if (G != null) G.Dispose();
      if (Canvas != null) Canvas.Dispose();
      if (dc != IntPtr.Zero) { SelectObject(dc, old); DeleteObject(dib); DeleteDC(dc); }
      G = null; Canvas = null; dc = IntPtr.Zero;
    }
    static BLEND Blend(byte a) { var b = new BLEND(); b.Op = 0; b.Flags = 0; b.Alpha = a; b.Format = 1; return b; }
    public void Push() {
      G.Flush(FlushIntention.Sync);
      var pos = new PT(X, Y); var size = new SZ(W, H); var src = new PT(0, 0); var bl = Blend(Alpha);
      UpdateLayeredWindow(Handle, IntPtr.Zero, ref pos, ref size, dc, ref src, 0, ref bl, 2);
    }
    public void Place() { var pos = new PT(X, Y); var bl = Blend(Alpha); MoveLayered(Handle, IntPtr.Zero, ref pos, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref bl, 2); }
    public void Show() { if (Shown) return; ShowWindow(Handle, 4); Shown = true; Raise(); }
    public void Raise() { SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0010 | 0x0002 | 0x0001); }
    public void Hide() { if (!Shown) return; ShowWindow(Handle, 0); Shown = false; }
    public bool Exclude(bool on) { return SetWindowDisplayAffinity(Handle, on ? 0x11u : 0u); }
  }

  const double TRAIL_MS = 300;
  static Control ui;
  static Layer cursor, caption, ring;
  static System.Windows.Forms.Timer timer;
  static readonly Stopwatch clock = Stopwatch.StartNew();
  static readonly object outLock = new object();
  static double tx, ty; static bool hasPos, visible;
  static bool gliding; static double gx0, gy0, gx1, gy1, gcx, gcy, gt0, gdur;
  static readonly List<double[]> trail = new List<double[]>();
  static double tapT = -1e9, flashT = -1e9, ringT0;
  static string text = ""; static bool captionDirty; static double revealT0 = -1e9; static int shownChars = -1;
  // Companion: the Jarvis cursor rides beside his own pointer (docked) until it's sent somewhere,
  // then "home" flies it back. A critically damped follow (tau ~70 ms) gives it a buddy's lag.
  static bool follow, docked, homing, thinking; static double lastFrame, thinkT0;
  const double DOCK_X = 26, DOCK_Y = 24, FOLLOW_TAU = 70, REVEAL_CPS = 0.06;
  // The arrow's own heading (tail to tip), in screen degrees; rot turns it to lead the flight.
  const double ARROW_HEADING = -112.6;
  static double rot = 0, pulse = 1;
  static bool ringOn, ringDirty; static int rx, ry, rw, rh;
  static double scale = 1, drawnScale = 0, captionScale = 0, ringScale = 0;
  static IntPtr hook = IntPtr.Zero; static HookProc hookProc;
  static Font badgeFont, captionFont;
  static readonly Color Cyan = Color.FromArgb(56, 189, 248);
  static readonly Color Deep = Color.FromArgb(2, 132, 199);
  static readonly Color Ink = Color.FromArgb(15, 23, 42);
  static readonly Color Paper = Color.FromArgb(241, 245, 249);
  static readonly Color Ok = Color.FromArgb(52, 211, 153);
  static readonly float[] Arrow = { 0f, 0f, 0f, 21f, 5f, 16.5f, 8.6f, 24.6f, 12f, 23.2f, 8.6f, 15.3f, 15f, 15.3f };

  static double Now() { return clock.Elapsed.TotalMilliseconds; }
  static void Emit(string line) { lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

  public static void Run() {
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
    ui = new Control();
    IntPtr force = ui.Handle;
    cursor = new Layer("Jarvis cursor overlay");
    caption = new Layer("Jarvis caption overlay");
    ring = new Layer("Jarvis target overlay");
    bool affinity = Exclude(true);
    timer = new System.Windows.Forms.Timer();
    timer.Interval = 15;
    timer.Tick += delegate { Frame(); };
    var reader = new Thread(Read); reader.IsBackground = true; reader.Start();
    Emit("ready " + (affinity ? "1" : "0") + " " + force.ToInt64());
    Application.Run();
    Unwatch();
  }

  static bool Exclude(bool on) { bool a = cursor.Exclude(on), b = caption.Exclude(on), c = ring.Exclude(on); return a && b && c; }

  static void Read() {
    try {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        var l = line.Trim();
        if (l.Length == 0) continue;
        ui.BeginInvoke(new Action(delegate { Command(l); }));
      }
    } catch { }
    try { ui.BeginInvoke(new Action(delegate { Application.ExitThread(); })); } catch { }
  }

  static double D(string[] p, int i) { return p.Length > i ? double.Parse(p[i], System.Globalization.CultureInfo.InvariantCulture) : 0; }
  static int I(string[] p, int i) { return (int)D(p, i); }

  static void Command(string l) {
    var p = l.Split(' ');
    try {
      switch (p[0]) {
        case "move": docked = false; homing = false; Move(D(p, 1), D(p, 2), D(p, 3)); break;
        case "follow": Follow(p.Length > 1 && p[1] == "1"); break;
        case "home": Home(D(p, 1)); break;
        case "think": thinking = p.Length > 1 && p[1] == "1"; thinkT0 = Now(); Kick(); break;
        case "stat": Stat(); break;
        case "ring": ringOn = true; rx = I(p, 1); ry = I(p, 2); rw = Math.Max(4, I(p, 3)); rh = Math.Max(4, I(p, 4)); ringT0 = Now(); flashT = -1e9; ringDirty = true; Kick(); break;
        case "unring": ringOn = false; ring.Hide(); break;
        case "say": text = p.Length > 1 ? Encoding.UTF8.GetString(Convert.FromBase64String(p[1])) : ""; captionDirty = true; revealT0 = Now(); shownChars = -1; Kick(); break;
        case "tap": tapT = Now(); Kick(); break;
        case "flash": if (ringOn) { flashT = Now(); ringDirty = true; Kick(); } break;
        case "hide": HideAll(); break;
        case "affinity": Emit("affinity " + (Exclude(p.Length > 1 && p[1] == "1") ? "1" : "0")); break;
        case "watch": if (p.Length > 1 && p[1] == "1") Watch(); else Unwatch(); break;
        case "ping": Emit("pong " + (visible ? "1" : "0") + " " + (int)tx + " " + (int)ty + " " + (hook != IntPtr.Zero ? "1" : "0")); break;
        case "quit": HideAll(); Application.ExitThread(); break;
      }
    } catch (Exception e) { Emit("error " + e.Message.Replace('\n', ' ').Replace('\r', ' ')); }
  }

  // Beside his pointer: below and to the right of its tip, clear of his own arrow, scaled per monitor.
  static void Dock(out double x, out double y) {
    PT c; GetCursorPos(out c); double s = ScaleAt(c.X, c.Y);
    x = c.X + DOCK_X * s; y = c.Y + DOCK_Y * s;
  }

  static void Follow(bool on) {
    follow = on;
    if (on) {
      double x, y; Dock(out x, out y);
      if (!hasPos || !visible) { tx = x; ty = y; hasPos = true; }
      if (!visible) { visible = true; cursor.Raise(); caption.Raise(); }
      if (!gliding && !ringOn) docked = true;
    } else { docked = false; homing = false; }
    lastFrame = Now(); Kick();
  }

  // Fly back beside his pointer, then ride along (or, when not following, stay where it lands).
  static void Home(double ms) {
    double x, y; Dock(out x, out y);
    if (!hasPos || !visible) { Follow(true); return; }
    Move(x, y, ms > 0 ? ms : 360);
    homing = gliding; docked = !gliding && follow;
  }

  static void Stat() {
    var li = new LASTINPUT(); li.Size = (uint)Marshal.SizeOf(typeof(LASTINPUT));
    uint idle = GetLastInputInfo(ref li) ? unchecked((uint)Environment.TickCount - li.Time) : 0;
    PT c; GetCursorPos(out c);
    Emit("stat " + idle + " " + c.X + " " + c.Y + " " + (visible ? "1" : "0") + " " + (docked ? "1" : "0"));
  }

  static void Move(double x, double y, double ms) {
    if (!hasPos) { Dock(out tx, out ty); hasPos = true; }
    if (!visible) { visible = true; cursor.Raise(); caption.Raise(); }
    double dx = x - tx, dy = y - ty, len = Math.Sqrt(dx * dx + dy * dy);
    if (ms <= 0 || len < 2) { tx = x; ty = y; gliding = false; }
    else {
      gx0 = tx; gy0 = ty; gx1 = x; gy1 = y;
      double k = Math.Min(90, len * 0.14);
      gcx = (gx0 + gx1) / 2 - dy / len * k; gcy = (gy0 + gy1) / 2 + dx / len * k;
      gt0 = Now(); gdur = ms; gliding = true;
    }
    Kick();
  }

  static void HideAll() {
    visible = false; ringOn = false; gliding = false; hasPos = false; text = ""; trail.Clear(); rot = 0; pulse = 1;
    follow = false; docked = false; homing = false; thinking = false; drawnX = double.NaN;
    cursor.Hide(); caption.Hide(); ring.Hide(); timer.Stop();
  }

  static void Kick() { Frame(); if (!timer.Enabled && Busy(Now())) timer.Start(); }
  static bool Revealing(double now) { return text.Length > 0 && (now - revealT0) * REVEAL_CPS < text.Length + 1; }
  static bool Moving(double now) { return gliding || trail.Count > 0 || now - tapT < 500 || now - flashT < 600 || thinking || Revealing(now); }
  static bool Busy(double now) { return Moving(now) || ringOn || (follow && visible); }
  static double drawnX = double.NaN, drawnY;

  static void Frame() {
    double now = Now(), dt = Math.Max(1, Math.Min(100, now - lastFrame)); lastFrame = now;
    bool riding = false;
    if (gliding) {
      // Homing aims at his pointer as it is now, so a moving mouse is still met.
      if (homing) { Dock(out gx1, out gy1); }
      double t = Math.Min(1, (now - gt0) / gdur);
      double e = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2, u = 1 - e;
      tx = u * u * gx0 + 2 * u * e * gcx + e * e * gx1;
      ty = u * u * gy0 + 2 * u * e * gcy + e * e * gy1;
      // The swoop (after Clicky): the tip leads along the arc's tangent and the arrow swells a
      // little mid-flight, both easing back to rest at either end.
      double vx = 2 * u * (gcx - gx0) + 2 * e * (gx1 - gcx), vy = 2 * u * (gcy - gy0) + 2 * e * (gy1 - gcy);
      double w = Math.Sin(Math.PI * t);
      if (vx * vx + vy * vy > 1) { double d = Math.Atan2(vy, vx) * 180 / Math.PI - ARROW_HEADING; while (d > 180) d -= 360; while (d < -180) d += 360; rot = d * w; }
      pulse = 1 + 0.16 * w;
      trail.Add(new double[] { tx, ty, now });
      if (t >= 1) { gliding = false; tx = gx1; ty = gy1; rot = 0; pulse = 1; if (homing) { homing = false; docked = follow; } }
    } else if (docked && follow && visible) {
      double x, y; Dock(out x, out y);
      double k = 1 - Math.Exp(-dt / FOLLOW_TAU);
      tx += (x - tx) * k; ty += (y - ty) * k;
      if (Math.Abs(x - tx) < 0.3 && Math.Abs(y - ty) < 0.3) { tx = x; ty = y; }
      riding = true;
    }
    trail.RemoveAll(delegate (double[] q) { return now - q[2] > TRAIL_MS; });
    // Riding beside a still pointer: nothing to redraw (a cheap poll of his pointer, not a frame).
    bool still = riding && !Moving(now) && Math.Abs(tx - drawnX) < 0.25 && Math.Abs(ty - drawnY) < 0.25;
    if (visible) {
      scale = ScaleAt((int)tx, (int)ty);
      if (!still) { DrawCursor(now); drawnX = tx; drawnY = ty; }
      if (text.Length > 0) { if (!still || Revealing(now)) PlaceCaption(); } else caption.Hide();
    }
    if (ringOn) DrawRing(now);
    if (!Busy(now)) timer.Stop();
    else timer.Interval = Moving(now) || (riding && !still) ? 15 : riding ? 24 : 33;
  }

  static double ScaleAt(int x, int y) {
    try { uint dx, dy; var mon = MonitorFromPoint(new PT(x, y), 2); if (GetDpiForMonitor(mon, 0, out dx, out dy) == 0 && dx > 0) return dx / 96.0; } catch { }
    return 1;
  }

  static RECT WorkArea(int x, int y) {
    var mi = new MONITORINFO(); mi.Size = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(MonitorFromPoint(new PT(x, y), 2), ref mi);
    return mi.Work;
  }

  static GraphicsPath Rounded(float x, float y, float w, float h, float r) {
    var p = new GraphicsPath(); float d = Math.Min(r * 2, Math.Min(w, h));
    p.AddArc(x, y, d, d, 180, 90); p.AddArc(x + w - d, y, d, d, 270, 90);
    p.AddArc(x + w - d, y + h - d, d, d, 0, 90); p.AddArc(x, y + h - d, d, d, 90, 90);
    p.CloseFigure(); return p;
  }

  static void DrawCursor(double now) {
    float s = (float)scale;
    int size = (int)Math.Ceiling(250 * scale);
    cursor.Resize(size, size);
    if (drawnScale != scale) { if (badgeFont != null) badgeFont.Dispose(); badgeFont = new Font("Segoe UI", 11.5f * s, FontStyle.Bold, GraphicsUnit.Pixel); drawnScale = scale; }
    var g = cursor.G;
    g.Clear(Color.Transparent);
    double ox = tx - size / 2.0, oy = ty - size / 2.0, reach = size / 2.0 - 6;
    float c = size / 2f;
    for (int i = 1; i < trail.Count; i++) {
      var a = trail[i - 1]; var b = trail[i];
      double k = Math.Max(0, 1 - (now - b[2]) / TRAIL_MS) * ((double)i / trail.Count);
      double dist = Math.Sqrt((b[0] - tx) * (b[0] - tx) + (b[1] - ty) * (b[1] - ty));
      k *= Math.Max(0, 1 - dist / reach);
      if (k <= 0.02) continue;
      using (var pen = new Pen(Color.FromArgb((int)(160 * k), Cyan), (float)((2 + 7 * k) * s))) {
        pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
        g.DrawLine(pen, (float)(a[0] - ox), (float)(a[1] - oy), (float)(b[0] - ox), (float)(b[1] - oy));
      }
    }
    double tt = (now - tapT) / 500.0;
    if (tt >= 0 && tt < 1) {
      float r = (float)((6 + 30 * tt) * s);
      using (var pen = new Pen(Color.FromArgb((int)(210 * (1 - tt)), Cyan), 2.5f * s)) g.DrawEllipse(pen, c - r, c - r, 2 * r, 2 * r);
    }
    float k2 = 1.6f * s * (float)pulse;
    double ra = rot * Math.PI / 180, ca = Math.Cos(ra), sa = Math.Sin(ra);
    var pts = new PointF[Arrow.Length / 2];
    for (int i = 0; i < pts.Length; i++) { double ax = Arrow[2 * i] * k2, ay = Arrow[2 * i + 1] * k2; pts[i] = new PointF((float)(c + ax * ca - ay * sa), (float)(c + ax * sa + ay * ca)); }
    var shadow = new PointF[pts.Length];
    for (int i = 0; i < pts.Length; i++) shadow[i] = new PointF(pts[i].X + 1.6f * s, pts[i].Y + 2.4f * s);
    using (var sb = new SolidBrush(Color.FromArgb(70, 0, 0, 0))) g.FillPolygon(sb, shadow);
    using (var fill = new LinearGradientBrush(new PointF(c, c), new PointF(c + 6 * k2, c + 25 * k2), Cyan, Deep)) g.FillPolygon(fill, pts);
    using (var pen = new Pen(Color.White, 1.6f * s)) { pen.LineJoin = LineJoin.Round; g.DrawPolygon(pen, pts); }
    float bx = c + 25 * s, by = c + 36 * s, br = 10.5f * s;
    using (var bb = new SolidBrush(Ink)) g.FillEllipse(bb, bx - br, by - br, 2 * br, 2 * br);
    using (var pen = new Pen(Cyan, 1.7f * s)) g.DrawEllipse(pen, bx - br, by - br, 2 * br, 2 * br);
    using (var fmt = new StringFormat()) {
      fmt.Alignment = StringAlignment.Center; fmt.LineAlignment = StringAlignment.Center;
      using (var tb = new SolidBrush(Color.White)) g.DrawString("J", badgeFont, tb, new RectangleF(bx - br, by - br + 0.5f * s, 2 * br, 2 * br), fmt);
    }
    // Thinking: a short arc orbits the badge (he asked; Jarvis is looking).
    if (thinking) {
      float a = (float)(((now - thinkT0) * 0.42) % 360), rr = br + 4.5f * s;
      using (var pen = new Pen(Color.FromArgb(235, Cyan), 2.4f * s)) { pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; g.DrawArc(pen, bx - rr, by - rr, 2 * rr, 2 * rr, a, 110); }
      using (var pen = new Pen(Color.FromArgb(90, Cyan), 2.4f * s)) g.DrawArc(pen, bx - rr, by - rr, 2 * rr, 2 * rr, a + 180, 50);
    }
    cursor.X = (int)Math.Round(ox); cursor.Y = (int)Math.Round(oy);
    cursor.Push(); cursor.Show();
  }

  static SizeF measured;
  // Whole words only, so a half-typed word never wraps and jumps.
  static string WholeWords(int n) {
    if (n >= text.Length) return text;
    int cut = text.IndexOf(' ', n);
    return cut < 0 ? text : text.Substring(0, cut);
  }
  static void PlaceCaption() {
    float s = (float)scale;
    // Typewriter: the bubble is sized for the whole line at once; the words fill it at speech pace.
    int shown = Math.Min(text.Length, (int)Math.Max(0, (Now() - revealT0) * REVEAL_CPS));
    if (captionDirty || captionScale != scale || shown != shownChars) {
      if (captionDirty || captionScale != scale) {
        if (captionFont != null) captionFont.Dispose();
        captionFont = new Font("Segoe UI Semibold", 13.5f * s, FontStyle.Regular, GraphicsUnit.Pixel);
        using (var probe = new Bitmap(1, 1)) using (var pg = Graphics.FromImage(probe)) measured = pg.MeasureString(text, captionFont, (int)(340 * s));
      }
      captionScale = scale; captionDirty = false; shownChars = shown;
      float padX = 11 * s, padY = 7 * s, sh = 4 * s;
      int w = (int)Math.Ceiling(measured.Width + 2 * padX + sh), h = (int)Math.Ceiling(measured.Height + 2 * padY + sh);
      caption.Resize(w, h);
      var g = caption.G; g.Clear(Color.Transparent);
      using (var path = Rounded(sh / 2, sh / 2, w - sh - 1, h - sh - 1, 10 * s)) {
        using (var shadowPath = Rounded(sh, sh, w - sh - 1, h - sh - 1, 10 * s)) using (var sb = new SolidBrush(Color.FromArgb(60, 0, 0, 0))) g.FillPath(sb, shadowPath);
        using (var bg = new SolidBrush(Color.FromArgb(238, Ink))) g.FillPath(bg, path);
        using (var pen = new Pen(Color.FromArgb(210, Cyan), 1.4f * s)) g.DrawPath(pen, path);
      }
      using (var tb = new SolidBrush(Paper)) g.DrawString(WholeWords(shown), captionFont, tb, new RectangleF(sh / 2 + padX, sh / 2 + padY, measured.Width + 2, measured.Height + 2));
      caption.Push();
    }
    var work = WorkArea((int)tx, (int)ty);
    double x = tx + 38 * scale, y = ty + 44 * scale;
    if (x + caption.W > work.R) x = tx - 18 * scale - caption.W;
    if (y + caption.H > work.B) y = ty - 18 * scale - caption.H;
    if (x < work.L) x = work.L;
    if (y < work.T) y = work.T;
    caption.X = (int)Math.Round(x); caption.Y = (int)Math.Round(y);
    caption.Place(); caption.Show();
  }

  static void DrawRing(double now) {
    double f = (now - flashT) / 600.0;
    bool flashing = f >= 0 && f < 1;
    if (flashT > 0 && f >= 1) { ringOn = false; flashT = -1e9; ring.Hide(); return; }
    double rs = ScaleAt(rx + rw / 2, ry + rh / 2);
    if (ringDirty || ringScale != rs) {
      float s = (float)rs, pad = 7 * s, glow = 10 * s;
      ring.Resize((int)Math.Ceiling(rw + 2 * (pad + glow)), (int)Math.Ceiling(rh + 2 * (pad + glow)));
      ring.X = (int)Math.Round(rx - pad - glow); ring.Y = (int)Math.Round(ry - pad - glow);
      var g = ring.G; g.Clear(Color.Transparent);
      var colour = flashing ? Ok : Cyan;
      using (var path = Rounded(glow, glow, rw + 2 * pad, rh + 2 * pad, 9 * s)) {
        using (var fill = new SolidBrush(Color.FromArgb(22, colour))) g.FillPath(fill, path);
        using (var p1 = new Pen(Color.FromArgb(34, colour), 13 * s)) g.DrawPath(p1, path);
        using (var p2 = new Pen(Color.FromArgb(70, colour), 7 * s)) g.DrawPath(p2, path);
        using (var p3 = new Pen(colour, 2.6f * s)) g.DrawPath(p3, path);
      }
      ring.Alpha = 255; ring.Push(); ring.Show(); ringDirty = false; ringScale = rs;
    }
    ring.Alpha = flashing ? (byte)(255 * (1 - f)) : (byte)(150 + 105 * (0.5 + 0.5 * Math.Cos(2 * Math.PI * (now - ringT0) / 1400.0)));
    ring.Place();
  }

  static void Watch() {
    if (hook == IntPtr.Zero) { hookProc = OnMouse; hook = SetWindowsHookEx(14, hookProc, GetModuleHandle(null), 0); }
    Emit("watch " + (hook != IntPtr.Zero ? "1" : "0"));
  }
  static void Unwatch() { if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; } }

  static IntPtr OnMouse(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      int msg = w.ToInt32();
      if (msg == 0x0201 || msg == 0x0204) {
        var s = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
        if ((s.Flags & 1) == 0) {
          string line = "click " + (msg == 0x0201 ? "left" : "right") + " " + s.Pt.X + " " + s.Pt.Y;
          ui.BeginInvoke(new Action(delegate { Emit(line); }));
        }
      }
    }
    return CallNextHookEx(hook, code, w, l);
  }
}
`;

/** The entry point when the overlay is compiled to its own small exe (see overlayCompileScript). */
export const OVERLAY_MAIN = String.raw`
public static class JarvisOverlayMain { [System.STAThread] public static void Main() { JarvisOverlay.Run(); } }
`;

/**
 * One PowerShell run that compiles the overlay into a console exe at `exePath` (the same C# plus a
 * Main). The exe is ~4x lighter than keeping PowerShell resident; it's rebuilt when the source
 * changes (the file name carries its hash). Run hidden (CREATE_NO_WINDOW), so no console shows.
 */
export function overlayCompileScript(exePath: string, source = OVERLAY_SOURCE) {
  const b64 = Buffer.from(source + OVERLAY_MAIN, "utf8").toString("base64");
  const path = exePath.replace(/'/g, "''");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "$jarvisRefs = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Bitmap].Assembly.Location)",
    `Add-Type -ReferencedAssemblies $jarvisRefs -OutputType ConsoleApplication -OutputAssembly '${path}' -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
  ].join("\n");
}

/** The lines that start the host: compile once, then hand stdin to the overlay's reader. */
export function overlayBootstrap(source = OVERLAY_SOURCE) {
  const b64 = Buffer.from(source, "utf8").toString("base64");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "$jarvisRefs = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Bitmap].Assembly.Location)",
    `try { Add-Type -ReferencedAssemblies $jarvisRefs -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) } catch { [Console]::Out.WriteLine('error ' + ($_.Exception.Message -replace '\\s+', ' ')); [Console]::Out.Flush(); exit 1 }`,
    "[JarvisOverlay]::Run()",
  ];
}
