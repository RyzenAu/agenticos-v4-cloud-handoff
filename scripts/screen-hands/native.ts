// Jarvis's hands on the real screen, native side: one warm hidden PowerShell with a small C#
// helper compiled once (~1 s at warm-up, then ~20-400 ms a call).
//
// - Snapshot: the window's UI Automation tree in ONE cached FindAll (names, roles, rectangles,
//   password flag, focus, value), the way UFO and Codex Computer Use read Windows apps. Chrome and
//   Edge expose web content through UIA, so a form in his everyday browser is readable too.
// - Input: SendInput (mouse, wheel, virtual keys, and Unicode typing with no clipboard involved).
// - Capture: the window's pixels into a JPEG in RAM, optionally with numbered boxes over the UIA
//   elements (Set-of-Marks) for the vision fallback. Never written to disk. The window renders
//   itself (PrintWindow, full content), so another window over it is never captured; if it can't,
//   the screen is copied only when nothing covers the window.
//
// Safety: every script here is a fixed template. Text from speech is passed only as base64
// (psText) and numbers are validated integers, so nothing he says can run as PowerShell.
import { psText, unb64, type PsHost } from "../jarvis-skills/ps-host";

/** C# for Add-Type. One line when sent; no // comments; no backslashes (tabs/newlines by char code). */
const HELPER = `
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
using System.Windows.Automation; using System.Drawing; using System.Drawing.Imaging; using System.IO;
public static class JarvisScreen {
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 static bool Front(long h) { return h == 0 || GetForegroundWindow().ToInt64() == h; }
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
 static readonly string T = ((char)9).ToString();
 static readonly string N = ((char)10).ToString();
 static int InputSize { get { return Marshal.SizeOf(typeof(INPUT)); } }
 public static string Dpi() { try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "pmv2"; } catch {} try { SetProcessDPIAware(); } catch {} return "system"; }
 static INPUT Mouse(uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
 static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
 public static uint Click(long h, int x, int y, int right, int count) {
  if (!Front(h)) return 9999; SetCursorPos(x, y); var list = new List<INPUT>();
  for (int c = 0; c < Math.Max(1, count); c++) { list.Add(Mouse(right == 1 ? 8u : 2u, 0)); list.Add(Mouse(right == 1 ? 16u : 4u, 0)); }
  return SendInput((uint)list.Count, list.ToArray(), InputSize); }
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
 static INPUT MoveTo(int x, int y) {
  int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(1, GetSystemMetrics(78)), vh = Math.Max(1, GetSystemMetrics(79));
  var i = new INPUT(); i.type = 0; i.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1)); i.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1)); i.u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000; return i; }
 /** Press at (x1,y1), glide to (x2,y2) in small steps, release: what a hand does. 9999 if the window moved. */
 public static uint Drag(long h, int x1, int y1, int x2, int y2) {
  if (!Front(h)) return 9999;
  SetCursorPos(x1, y1); SendInput(1, new INPUT[] { MoveTo(x1, y1) }, InputSize); System.Threading.Thread.Sleep(60);
  SendInput(1, new INPUT[] { Mouse(2u, 0) }, InputSize); System.Threading.Thread.Sleep(120);
  uint sent = 0; int steps = Math.Max(8, (int)(Math.Sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) / 12));
  for (int s = 1; s <= steps; s++) {
   if (!Front(h)) { SendInput(1, new INPUT[] { Mouse(4u, 0) }, InputSize); return 9999; }
   int x = x1 + (x2 - x1) * s / steps, y = y1 + (y2 - y1) * s / steps;
   sent += SendInput(1, new INPUT[] { MoveTo(x, y) }, InputSize); System.Threading.Thread.Sleep(12); }
  System.Threading.Thread.Sleep(150);
  sent += SendInput(1, new INPUT[] { Mouse(4u, 0) }, InputSize);
  return sent; }
 public static uint Wheel(long h, int x, int y, int delta) { if (!Front(h)) return 9999; SetCursorPos(x, y); return SendInput(1, new INPUT[] { Mouse(2048, delta) }, InputSize); }
 static bool Extended(int vk) { return (vk >= 33 && vk <= 46) || vk == 91 || vk == 92; }
 public static uint Chord(long h, int[] vks) {
  if (!Front(h)) return 9999; var list = new List<INPUT>();
  foreach (var vk in vks) list.Add(Key((ushort)vk, 0, Extended(vk) ? 1u : 0u));
  for (int k = vks.Length - 1; k >= 0; k--) list.Add(Key((ushort)vks[k], 0, (Extended(vks[k]) ? 1u : 0u) | 2u));
  return SendInput((uint)list.Count, list.ToArray(), InputSize); }
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern short VkKeyScan(char ch);
 [DllImport("user32.dll")] static extern short GetKeyState(int key);
 public static uint Type(long h, string text) {
  uint sent = 0; bool caps = (GetKeyState(20) & 1) != 0;
  foreach (char ch in text) {
   if (ch == (char)10 || ch == (char)13) continue;
   if (!Front(h)) return 9999;
   var list = new List<INPUT>(); short scan = VkKeyScan(ch); int vk = scan & 255, mods = (scan >> 8) & 255;
   if (scan != -1 && vk != 255 && (mods & 6) == 0 && !(caps && Char.IsLetter(ch))) {
    if ((mods & 1) != 0) list.Add(Key(16, 0, 0));
    list.Add(Key((ushort)vk, 0, 0)); list.Add(Key((ushort)vk, 0, 2));
    if ((mods & 1) != 0) list.Add(Key(16, 0, 2));
   } else { list.Add(Key(0, ch, 4)); list.Add(Key(0, ch, 6)); }
   sent += SendInput((uint)list.Count, list.ToArray(), InputSize);
   System.Threading.Thread.Sleep(3); }
  return sent; }
 static System.Windows.Forms.DataObject saved;
 static int pasteSeq = 0;
 static System.IO.MemoryStream Zero() { return new System.IO.MemoryStream(new byte[] { 0, 0, 0, 0 }); }
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, ChildProc cb, IntPtr l);
 [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
 delegate bool ChildProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
 /** File name: Save As keeps it in Edit 1001; Open in the Edit (1148) inside ComboBox 1148 (cmb13). */
 static IntPtr FileNameBox(IntPtr dialog) {
  IntPtr found = IntPtr.Zero, open = IntPtr.Zero;
  EnumChildWindows(dialog, delegate(IntPtr child, IntPtr unused) {
   var cls = new StringBuilder(64); GetClassName(child, cls, 64);
   if (cls.ToString() != "Edit" || !IsWindowVisible(child)) return true;
   int id = GetDlgCtrlID(child);
   if (id == 1001) { found = child; return false; }
   if (id == 1148 && open == IntPtr.Zero) { var pc = new StringBuilder(64); var parent = GetParent(child); GetClassName(parent, pc, 64); if (pc.ToString() == "ComboBox" && GetDlgCtrlID(parent) == 1148) open = child; }
   return true;
  }, IntPtr.Zero);
  return found != IntPtr.Zero ? found : open;
 }
 [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
 /** Win32's own answer (the dialog thread's focus window): UIA's FocusedElement can be stale in a long-lived host. */
 static bool HasFocus(IntPtr box) {
  uint pid; uint tid = GetWindowThreadProcessId(box, out pid);
  var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
  return GetGUIThreadInfo(tid, ref gi) && gi.hwndFocus == box; }
 /** Diagnostics: the dialog thread's focused control as "class id", and the File name box's own id. */
 public static string DialogFocus(long h) {
  var d = new IntPtr(h); uint pid; uint tid = GetWindowThreadProcessId(d, out pid);
  var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
  if (!GetGUIThreadInfo(tid, ref gi)) return "none";
  var c = new StringBuilder(64); GetClassName(gi.hwndFocus, c, 64);
  var box = FileNameBox(d);
  return c + " " + GetDlgCtrlID(gi.hwndFocus) + " active=" + (gi.hwndActive == d) + " box=" + box.ToInt64() + " focus=" + gi.hwndFocus.ToInt64(); }
 [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
 /** ES_PASSWORD on the Win32 edit, or UIA's IsPassword when UIA answers: either refuses. */
 static bool PasswordBox(IntPtr box) {
  if ((GetWindowLong(box, -16) & 0x20) != 0) return true;
  try { return AutomationElement.FromHandle(box).Current.IsPassword; } catch { return false; } }
 /**
  * The focused element. UIA's FocusedElement can go stale in this long-lived host (found live 27 Sep:
  * Explorer's rename box and a file dialog's File name box reported as their container). When Win32's
  * own focus (the foreground thread's) is a classic Edit control and UIA disagrees, that Edit is used.
  */
 static AutomationElement FocusedNow() {
  AutomationElement f = null; try { f = AutomationElement.FocusedElement; } catch {}
  try {
   uint pid; uint tid = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
   var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
   if (GetGUIThreadInfo(tid, ref gi) && gi.hwndFocus != IntPtr.Zero) {
    var c = new StringBuilder(64); GetClassName(gi.hwndFocus, c, 64);
    if (c.ToString() == "Edit" && (f == null || (long)f.Current.NativeWindowHandle != gi.hwndFocus.ToInt64())) return AutomationElement.FromHandle(gi.hwndFocus);
   }
  } catch {}
  return f; }
 /**
  * A focused classic Win32 Edit that UIA exposes as something else (Explorer's rename box shows as a
  * "Pane"): reported as an Edit with its exact Win32 text, and never a password field's text.
  */
 static string EditRow(string row, AutomationElement e) {
  try {
   if (row == null) return null;
   var h = new IntPtr(e.Current.NativeWindowHandle); if (h == IntPtr.Zero) return row;
   var c = new StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() != "Edit") return row;
   var cols = row.Split((char)9); if (cols.Length < 12 || cols[2] == "Edit") return row;
   bool pw = (GetWindowLong(h, -16) & 0x20) != 0;
   cols[2] = "Edit"; cols[7] = cols[7].Replace("v", "").Replace("p", "").Replace("r", "") + (pw ? "p" : "") + "v"; cols[11] = pw ? "" : C(WindowText(h));
   return String.Join(T, cols);
  } catch { return row; } }
 static bool UiaFocus(IntPtr box) {
  try { var f = AutomationElement.FocusedElement; return f != null && (long)f.Current.NativeWindowHandle == box.ToInt64(); } catch { return false; } }
 static string WindowText(IntPtr h) {
  int count = SendMessage(h, 0x000E, IntPtr.Zero, IntPtr.Zero).ToInt32();
  var value = new StringBuilder(Math.Max(2, count + 2));
  SendMessage(h, 0x000D, new IntPtr(value.Capacity), value);
  return value.ToString();
 }
 /** Windows 11 ignores programmatic SetValue at Save. Use the real focused-input path and exact Win32 read-back. */
 public static string SetDialogValue(long h, string text) {
  if (!Front(h)) return "moved";
  var c = new StringBuilder(64); GetClassName(new IntPtr(h), c, 64); if (c.ToString() != "#32770") return "none";
  try {
   var box = FileNameBox(new IntPtr(h)); if (box == IntPtr.Zero) return "failed";
   if (!HasFocus(box) && !UiaFocus(box)) return "failed";
   if (PasswordBox(box)) return "failed";
   if (!Front(h)) return "moved";
   if (Chord(h, new int[] { 17, 65 }) != 4) return "failed";
   if (Paste(h, text) != 4) return "failed";
   System.Threading.Thread.Sleep(150);
   if (!Front(h)) return "moved";
   return WindowText(box) == text ? "set" : "failed";
  } catch { return "failed"; } }
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
 [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h, int id);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 static string Plain(string s) { return (s ?? "").Replace("&", "").Trim(); }
 static bool IsDialog(IntPtr h) { var c = new StringBuilder(64); GetClassName(h, c, 64); return c.ToString() == "#32770"; }
 /** The window that owns a dialog (GW_OWNER), or 0. */
 public static long DialogOwner(long h) { return GetWindow(new IntPtr(h), 4).ToInt64(); }
 public static bool Alive(long h) { return IsWindow(new IntPtr(h)); }
 /** GA_ROOTOWNER: the top-level window a popup, flyout or island window ultimately belongs to. */
 public static long RootOwner(long h) { return GetAncestor(new IntPtr(h), 3).ToInt64(); }
 /** A common file dialog, by control id: "1" when the File name box (Edit 1001) is there, then button 1 and button 2 text. */
 public static string DialogInfo(long h) {
  var d = new IntPtr(h); if (!IsDialog(d)) return "none";
  var box = FileNameBox(d); var b1 = GetDlgItem(d, 1); var b2 = GetDlgItem(d, 2);
  return (box != IntPtr.Zero ? "1" : "0") + T + (b1 != IntPtr.Zero ? C(Plain(WindowText(b1))) : "") + T + (b2 != IntPtr.Zero ? C(Plain(WindowText(b2))) : ""); }
 /** Focus the File name box (Edit 1001) through UIA and confirm it holds the keyboard focus: "focused", "failed" or "moved". */
 public static string FocusFileName(long h) {
  if (!Front(h)) return "moved";
  var d = new IntPtr(h); if (!IsDialog(d)) return "failed";
  var box = FileNameBox(d); if (box == IntPtr.Zero) return "failed";
  if (PasswordBox(box)) return "failed";
  if (HasFocus(box)) return "focused";
  try { AutomationElement.FromHandle(box).SetFocus(); System.Threading.Thread.Sleep(120); } catch {}
  if (!Front(h)) return "moved";
  if (HasFocus(box)) return "focused";
  Chord(h, new int[] { 18, 78 }); System.Threading.Thread.Sleep(150);
  if (!Front(h)) return "moved";
  return HasFocus(box) ? "focused" : "failed"; }
 static string PressButton(IntPtr b) {
  try { var e = AutomationElement.FromHandle(b); object p;
   if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { var ip = (InvokePattern)p; bool failed = false; var th = new System.Threading.Thread(() => { try { ip.Invoke(); } catch { failed = true; } }); th.IsBackground = true; th.Start(); if (!(th.Join(1500) && failed)) return "invoke"; } } catch {}
  return PostMessage(b, 0x00F5, IntPtr.Zero, IntPtr.Zero) ? "bmclick" : "failed"; }
 /** Press a dialog button by its control id, only when its text is exactly the label (no ampersand). Never Enter, never the pointer. */
 public static string PressDialogButton(long h, int id, string label) {
  if (!Front(h)) return "moved";
  var d = new IntPtr(h); if (!IsDialog(d)) return "missing";
  var b = GetDlgItem(d, id); if (b == IntPtr.Zero || !IsWindowVisible(b) || !IsWindowEnabled(b)) return "missing";
  var cls = new StringBuilder(64); GetClassName(b, cls, 64); if (cls.ToString() != "Button") return "missing";
  var text = Plain(WindowText(b)); if (!String.Equals(text, label, StringComparison.OrdinalIgnoreCase)) return "label" + T + C(text);
  return PressButton(b); }
 static List<IntPtr> Buttons(IntPtr d) {
  var list = new List<IntPtr>();
  EnumChildWindows(d, delegate(IntPtr child, IntPtr unused) { var cls = new StringBuilder(64); GetClassName(child, cls, 64); if (cls.ToString() == "Button" && IsWindowVisible(child)) list.Add(child); return true; }, IntPtr.Zero);
  return list; }
 /** A prompt's (Confirm Save As, an error box) visible button labels, tab-separated. Its message text is not read. */
 public static string PromptButtons(long h) {
  var d = new IntPtr(h); if (!IsDialog(d)) return "";
  var names = new List<string>(); foreach (var b in Buttons(d)) names.Add(C(Plain(WindowText(b))));
  if (names.Count == 0) { try { var all = AutomationElement.FromHandle(d).FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)); foreach (AutomationElement e in all) names.Add(C(Plain(e.Current.Name))); } catch {} }
  return String.Join(T, names.ToArray()); }
 /** Press the prompt button whose text is exactly the label: "invoke", "bmclick", "missing" or "moved". */
 public static string PressPromptButton(long h, string label) {
  if (!Front(h)) return "moved";
  var d = new IntPtr(h); if (!IsDialog(d)) return "missing";
  foreach (var b in Buttons(d)) if (String.Equals(Plain(WindowText(b)), label, StringComparison.OrdinalIgnoreCase)) return PressButton(b);
  try { var all = AutomationElement.FromHandle(d).FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
   foreach (AutomationElement e in all) { if (!String.Equals(Plain(e.Current.Name), label, StringComparison.OrdinalIgnoreCase)) continue; object p; if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoke"; } } } catch {}
  return "missing"; }
 public static uint Paste(long h, string text) {
  if (!Front(h)) return 9999;
  if (saved == null) { try { var o = System.Windows.Forms.Clipboard.GetDataObject(); if (o != null) { var s = new System.Windows.Forms.DataObject(); foreach (var f in o.GetFormats(false)) { try { var v = o.GetData(f); if (v != null) s.SetData(f, v); } catch {} } saved = s; } } catch {} }
  var d = new System.Windows.Forms.DataObject(); d.SetData(System.Windows.Forms.DataFormats.UnicodeText, text);
  d.SetData("ExcludeClipboardContentFromMonitorProcessing", Zero()); d.SetData("CanIncludeInClipboardHistory", Zero()); d.SetData("CanUploadToCloudClipboard", Zero());
  System.Windows.Forms.Clipboard.SetDataObject(d, true);
  if (!Front(h)) return 9999;
  uint sent = Chord(h, new int[] { 17, 86 });
  int mine = ++pasteSeq;
  var t = new System.Threading.Thread(() => { System.Threading.Thread.Sleep(900); if (mine != pasteSeq) return; try { if (saved != null && saved.GetFormats().Length > 0) System.Windows.Forms.Clipboard.SetDataObject(saved, true); else System.Windows.Forms.Clipboard.Clear(); } catch {} saved = null; });
  t.SetApartmentState(System.Threading.ApartmentState.STA); t.IsBackground = true; t.Start();
  return sent; } public static uint Pid(long handle) { uint pid; GetWindowThreadProcessId(new IntPtr(handle), out pid); return pid; }
 static RECT Bounds(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r); return r; }
 static string C(object o) { var s = o as string; if (s == null) return ""; s = s.Replace((char)9, ' ').Replace((char)10, ' ').Replace((char)13, ' ').Trim(); return s.Length > 120 ? s.Substring(0, 120) : s; }
 static object P(AutomationElement e, AutomationProperty p) { try { return e.GetCachedPropertyValue(p, true); } catch { return null; } }
 static bool B(object o) { return o is bool && (bool)o; }
 static readonly ControlType[] Kinds = { ControlType.Button, ControlType.SplitButton, ControlType.Edit, ControlType.Document, ControlType.Hyperlink, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox, ControlType.ListItem, ControlType.MenuItem, ControlType.TabItem, ControlType.TreeItem, ControlType.DataItem, ControlType.Slider, ControlType.Spinner, ControlType.List };
 static CacheRequest Request() {
  var cr = new CacheRequest(); cr.AutomationElementMode = AutomationElementMode.None; cr.TreeScope = TreeScope.Element;
  cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.BoundingRectangleProperty);
  cr.Add(AutomationElement.IsPasswordProperty); cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.HasKeyboardFocusProperty);
  cr.Add(AutomationElement.AutomationIdProperty); cr.Add(AutomationElement.HelpTextProperty); cr.Add(AutomationElement.IsValuePatternAvailableProperty);
  cr.Add(AutomationElement.IsTogglePatternAvailableProperty); cr.Add(ValuePattern.ValueProperty); cr.Add(ValuePattern.IsReadOnlyProperty); cr.Add(TogglePattern.ToggleStateProperty);
  cr.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty); cr.Add(ExpandCollapsePattern.ExpandCollapseStateProperty); cr.Add(AutomationElement.IsSelectionItemPatternAvailableProperty); cr.Add(SelectionItemPattern.IsSelectedProperty); cr.Add(AutomationElement.IsInvokePatternAvailableProperty);
  cr.Add(AutomationElement.IsRangeValuePatternAvailableProperty); cr.Add(RangeValuePattern.ValueProperty);
  return cr; }
 static string Row(string tag, int i, AutomationElement e) {
  object r0 = P(e, AutomationElement.BoundingRectangleProperty);
  if (!(r0 is System.Windows.Rect)) return null;
  var r = (System.Windows.Rect)r0;
  if (r.IsEmpty || r.Width < 2 || r.Height < 2) return null;
  var ct = P(e, AutomationElement.ControlTypeProperty) as ControlType;
  string type = ct == null ? "Unknown" : ct.ProgrammaticName.Replace("ControlType.", "");
  bool pw = B(P(e, AutomationElement.IsPasswordProperty));
  string flags = (pw ? "p" : "") + (B(P(e, AutomationElement.IsEnabledProperty)) ? "e" : "") + (B(P(e, AutomationElement.HasKeyboardFocusProperty)) ? "f" : "");
  string val = "";
  if (B(P(e, AutomationElement.IsValuePatternAvailableProperty))) { flags += "v"; if (B(P(e, ValuePattern.IsReadOnlyProperty))) flags += "r"; if (!pw) val = C(P(e, ValuePattern.ValueProperty)); }
  if (val == "" && !pw && B(P(e, AutomationElement.IsRangeValuePatternAvailableProperty))) { object rv = P(e, RangeValuePattern.ValueProperty); if (rv is double) val = ((double)rv).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture); }
  if (B(P(e, AutomationElement.IsTogglePatternAvailableProperty))) { object t = P(e, TogglePattern.ToggleStateProperty); if (t is ToggleState) flags += ((ToggleState)t) == ToggleState.On ? "1" : "0"; }
  if (B(P(e, AutomationElement.IsExpandCollapsePatternAvailableProperty))) { object x = P(e, ExpandCollapsePattern.ExpandCollapseStateProperty); if (x is ExpandCollapseState) { var st = (ExpandCollapseState)x; if (st == ExpandCollapseState.Expanded) flags += "X"; else if (st != ExpandCollapseState.LeafNode) flags += "C"; } }
  if (B(P(e, AutomationElement.IsSelectionItemPatternAvailableProperty)) && B(P(e, SelectionItemPattern.IsSelectedProperty))) flags += "S";
  if (B(P(e, AutomationElement.IsInvokePatternAvailableProperty))) flags += "I";
  return tag + T + i + T + type + T + (int)r.X + T + (int)r.Y + T + (int)r.Width + T + (int)r.Height + T + flags + T + C(P(e, AutomationElement.NameProperty)) + T + C(P(e, AutomationElement.AutomationIdProperty)) + T + C(P(e, AutomationElement.HelpTextProperty)) + T + val; }
 static OrCondition AnyOf(ControlType[] ks) { var l = new List<Condition>(); foreach (var k in ks) l.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, k)); return new OrCondition(l.ToArray()); }
 static readonly ControlType[] ContextKinds = { ControlType.Text, ControlType.Image, ControlType.ProgressBar, ControlType.Custom };
 static readonly string[] CommitWords = { "continue", "next", "confirm", "send", "submit", "pay", "place", "order", "checkout", "check out", "buy", "donate", "give", "tip", "gift", "join", "subscribe", "upgrade", "choose", "select", "pick", "proceed", "complete", "purchase", "book", "get", "start", "ok", "yes", "done", "finish", "support", "weiter", "suivant", "siguiente", "continuar", "continuer", "envoyer", "enviar", "senden", "bestellen", "kaufen", "betala", "zap", "avanti", "invia", "volgende", "doorgaan", "dalej", "ileri", "devam" };
 static bool CommitName(string name) { var l = (name ?? "").Trim().ToLowerInvariant(); if (l.Length == 0) return true; if (l.Length > 48) return false; foreach (var w in CommitWords) if (l.Contains(w)) return true; foreach (char ch in l) if (char.IsLetter(ch)) return false; return true; }
 static string RectKey(AutomationElement e) { object r0 = P(e, AutomationElement.BoundingRectangleProperty); if (!(r0 is System.Windows.Rect)) return ""; var r = (System.Windows.Rect)r0; return (int)r.X + "," + (int)r.Y + "," + (int)r.Width + "," + (int)r.Height; }
 static void Context(AutomationElementCollection all, CacheRequest cr, StringBuilder sb, ref int n, RECT wr, System.Diagnostics.Stopwatch clock, long deadline) {
  bool truncated = false; int ctx = 0, boxes = 0, cands = 0; var roots = new HashSet<string>(); var seen = new HashSet<string>(); var boxSeen = new HashSet<string>();
  double area = Math.Max(1.0, (double)(wr.Right - wr.Left) * (wr.Bottom - wr.Top));
  var ctxCond = new AndCondition(new PropertyCondition(AutomationElement.IsOffscreenProperty, false), AnyOf(ContextKinds));
  var walker = TreeWalker.ControlViewWalker;
  foreach (AutomationElement e in all) {
   if (clock.ElapsedMilliseconds > deadline) { truncated = true; break; }
   var ct = P(e, AutomationElement.ControlTypeProperty) as ControlType;
   if (ct == null || !(ct == ControlType.Button || ct == ControlType.Hyperlink || ct == ControlType.SplitButton || ct == ControlType.ListItem || ct == ControlType.MenuItem)) continue;
   if (!CommitName(C(P(e, AutomationElement.NameProperty)))) continue;
   if (++cands > 16) { truncated = true; break; }
   AutomationElement cur = e; AutomationElement scope = null; AutomationElement big = null;
   object e0 = P(e, AutomationElement.BoundingRectangleProperty); var er = e0 is System.Windows.Rect ? (System.Windows.Rect)e0 : System.Windows.Rect.Empty;
   for (int lvl = 0; lvl < 6; lvl++) {
    if (clock.ElapsedMilliseconds > deadline) { truncated = true; break; }
    AutomationElement p = null; try { p = walker.GetParent(cur, cr); } catch { break; }
    if (p == null) break;
    object r0 = P(p, AutomationElement.BoundingRectangleProperty); if (!(r0 is System.Windows.Rect)) break; var r = (System.Windows.Rect)r0;
    if (r.IsEmpty || r.Width * r.Height > area * 0.7) { big = p; break; }
    var pt = P(p, AutomationElement.ControlTypeProperty) as ControlType;
    if (pt == ControlType.Window || pt == ControlType.Pane || pt == ControlType.Group || pt == ControlType.Custom || pt == ControlType.List) {
     var bk = RectKey(p);
     if (r.Width >= 40 && r.Height >= 16 && boxes < 300 && boxSeen.Add(bk)) { var row = Row("B", -1, p); if (row != null) { sb.Append(row + N); boxes++; } }
    }
    scope = p; cur = p;
    if (r.Height >= 180 && r.Width >= 240) break;
   }
   if (truncated) break;
   var scopes = new List<AutomationElement>();
   if (scope != null) scopes.Add(scope);
   if (big != null && !er.IsEmpty) {
    AutomationElement ch = null; try { ch = walker.GetFirstChild(big, cr); } catch {}
    for (int k = 0; ch != null && k < 60; k++) {
     if (clock.ElapsedMilliseconds > deadline) { truncated = true; break; }
     object c0 = P(ch, AutomationElement.BoundingRectangleProperty);
     if (c0 is System.Windows.Rect) { var cr0 = (System.Windows.Rect)c0; double gap = cr0.Bottom < er.Top ? er.Top - cr0.Bottom : (cr0.Top > er.Bottom ? cr0.Top - er.Bottom : 0); if (!cr0.IsEmpty && gap <= 300 && cr0.Width * cr0.Height <= area * 0.7) scopes.Add(ch); }
     try { ch = walker.GetNextSibling(ch, cr); } catch { ch = null; } }
   }
   if (truncated) break;
   foreach (var sc in scopes) {
    if (!roots.Add(RectKey(sc))) continue;
    if (clock.ElapsedMilliseconds > deadline) { truncated = true; break; }
    AutomationElementCollection items; try { using (cr.Activate()) { items = sc.FindAll(TreeScope.Descendants, ctxCond); } } catch { continue; }
    foreach (AutomationElement it in items) {
     if (ctx >= 300) { truncated = true; break; }
     var key = RectKey(it) + "|" + C(P(it, AutomationElement.NameProperty));
     if (!seen.Add(key)) continue;
     var row = Row("E", n, it); if (row == null) continue; sb.Append(row + N); n++; ctx++; }
    if (truncated) break; }
   if (truncated) break;
  }
  if (truncated) sb.Append("T" + T + ctx + T + boxes + T + clock.ElapsedMilliseconds + N); }
 public static string Snapshot(long handle, int max) { return SnapshotX(handle, max, false); }
 public static string SnapshotX(long handle, int max, bool context) {
  var clock = System.Diagnostics.Stopwatch.StartNew();
  var h = new IntPtr(handle); var sb = new StringBuilder(); var wr = Bounds(h);
  sb.Append("W" + T + wr.Left + T + wr.Top + T + (wr.Right - wr.Left) + T + (wr.Bottom - wr.Top) + N);
  var cr = Request(); if (context) cr.AutomationElementMode = AutomationElementMode.Full; var root = AutomationElement.FromHandle(h);
  var kinds = new List<Condition>(); foreach (var k in Kinds) kinds.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, k));
  var cond = new AndCondition(new PropertyCondition(AutomationElement.IsOffscreenProperty, false), new OrCondition(kinds.ToArray()));
  AutomationElementCollection all; using (cr.Activate()) { all = root.FindAll(TreeScope.Descendants, cond); }
  int n = 0;
  foreach (AutomationElement e in all) { if (n >= max) break; var row = Row("E", n, e); if (row == null) continue; sb.Append(row + N); n++; }
  if (context) { long main = clock.ElapsedMilliseconds; long deadline = main + Math.Min(400, Math.Max(60, main * 3 / 10)); try { Context(all, cr, sb, ref n, wr, clock, deadline); } catch { sb.Append("T" + T + "0" + T + "0" + T + clock.ElapsedMilliseconds + N); } }
  try { var f = FocusedNow(); if (f != null) { var row = EditRow(Row("F", -1, f.GetUpdatedCache(Request())), f); if (row != null) sb.Append(row + N); } } catch {}
  return sb.ToString(); }
 public static string Focused() {
  try { var f = FocusedNow(); if (f == null) return ""; var row = EditRow(Row("F", -1, f.GetUpdatedCache(Request())), f); return row ?? ""; } catch { return ""; } }
 public static string At(int x, int y) {
  try { var e = AutomationElement.FromPoint(new System.Windows.Point(x, y)); var row = Row("A", -1, e.GetUpdatedCache(Request())); return row ?? ""; } catch { return ""; } }
 [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 public static string Cursor() { POINT p; GetCursorPos(out p); return p.X + T + p.Y; }
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
 public static long WindowAt(int x, int y) { var p = new POINT(); p.X = x; p.Y = y; var h = WindowFromPoint(p); if (h == IntPtr.Zero) return 0; var root = GetAncestor(h, 2); return (root == IntPtr.Zero ? h : root).ToInt64(); }
 public static bool MoveCursor(int x, int y) { return SetCursorPos(x, y); }
 static bool IsKind(AutomationElement e) { try { var ct = e.Current.ControlType; foreach (var k in Kinds) if (k == ct) return true; } catch {} return false; }
 static AutomationElement Interactive(AutomationElement e) { var cur = e; for (int i = 0; i < 4 && cur != null; i++) { if (IsKind(cur)) return cur; try { cur = TreeWalker.ControlViewWalker.GetParent(cur); } catch { break; } } return e; }
 public static string Probe(long handle, int x, int y) {
  var sb = new StringBuilder(); var t = new StringBuilder(512); GetWindowText(new IntPtr(handle), t, 512);
  sb.Append("P" + T + GetForegroundWindow().ToInt64() + T + C(t.ToString()) + N); var cr = Request();
  try { var f = FocusedNow(); if (f != null) { var row = EditRow(Row("F", -1, f.GetUpdatedCache(cr)), f); if (row != null) sb.Append(row + N); } } catch {}
  try { var e = Interactive(AutomationElement.FromPoint(new System.Windows.Point(x, y))); var row = Row("A", -1, e.GetUpdatedCache(cr)); if (row != null) sb.Append(row + N); } catch {}
  return sb.ToString(); }
 static bool Same(AutomationElement e, string type, string name) { try { var c = e.Current; return c.ControlType.ProgrammaticName.Replace("ControlType.", "") == type && C(c.Name) == name; } catch { return false; } }
 static AutomationElement Locate(long handle, int x, int y, string type, string name) {
  try { var hit = Interactive(AutomationElement.FromPoint(new System.Windows.Point(x, y))); if (hit != null && Same(hit, type, name)) return hit; } catch {}
  if (name.Length == 0) return null;
  try { var root = AutomationElement.FromHandle(new IntPtr(handle)); var all = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, name)); AutomationElement best = null; double bd = 1e18;
   foreach (AutomationElement e in all) { if (!Same(e, type, name)) continue; var r = e.Current.BoundingRectangle; if (r.IsEmpty) continue; double dx = r.X + r.Width / 2 - x, dy = r.Y + r.Height / 2 - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = e; } }
   return best; } catch { return null; } }
 public static string Act(long handle, int x, int y, string type, string name, string verb) {
  if (!Front(handle)) return "9999";
  var e = Locate(handle, x, y, type, name); if (e == null) return "missing";
  object p;
  try {
   if (verb == "focus") { e.SetFocus(); return "focus"; }
   if (verb == "scrollup" || verb == "scrolldown") { var cur = e; for (int i = 0; i < 8 && cur != null; i++) { if (cur.TryGetCurrentPattern(ScrollPattern.Pattern, out p) && ((ScrollPattern)p).Current.VerticallyScrollable) { ((ScrollPattern)p).ScrollVertical(verb == "scrollup" ? ScrollAmount.LargeDecrement : ScrollAmount.LargeIncrement); return "scroll"; } cur = TreeWalker.ControlViewWalker.GetParent(cur); } return "none"; }
   bool opens = type == "MenuItem" || type == "SplitButton" || type == "ComboBox";
   if (opens && e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { var ec = (ExpandCollapsePattern)p; var st = ec.Current.ExpandCollapseState; if (st == ExpandCollapseState.Expanded) { ec.Collapse(); return "collapse"; } if (st != ExpandCollapseState.LeafNode) { ec.Expand(); return "expand"; } }
   if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { var ip = (InvokePattern)p; bool failed = false; var th = new System.Threading.Thread(() => { try { ip.Invoke(); } catch { failed = true; } }); th.IsBackground = true; th.Start(); if (th.Join(1500) && failed) return "none"; return "invoke"; }
   if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggle"; }
   if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "select"; }
   if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { var ec = (ExpandCollapsePattern)p; if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) { ec.Collapse(); return "collapse"; } ec.Expand(); return "expand"; }
   if (type == "Edit" || type == "Document" || type == "Spinner") { e.SetFocus(); return "focus"; }
  } catch { return "none"; }
  return "none"; }
 static bool Near(double a, int b) { return Math.Abs(a - b) <= 6; }
 static bool Matches(AutomationElement e, string type, string name, string aid, int rx, int ry, int rw, int rh) {
  try { var c = e.Current; string t = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
   if (type != "Point" && t != type) return false; if (C(c.Name) != name) return false;
   string a = C(c.AutomationId); if (aid.Length > 0 && a.Length > 0 && a != aid) return false;
   if (rw <= 2 && rh <= 2) return true; var r = c.BoundingRectangle; if (r.IsEmpty) return false;
   return Near(r.X, rx) && Near(r.Y, ry) && Near(r.Width, rw) && Near(r.Height, rh); } catch { return false; } }
 public static string ClickAt(long h, int x, int y, string type, string name, string aid, int rx, int ry, int rw, int rh) {
  if (!Front(h)) return "9999";
  AutomationElement hit = null; try { hit = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch {}
  bool same = false; var cur = hit;
  for (int i = 0; i < 6 && cur != null && !same; i++) { if (Matches(cur, type, name, aid, rx, ry, rw, rh)) same = true; else { try { cur = TreeWalker.ControlViewWalker.GetParent(cur); } catch { cur = null; } } }
  if (!same) { string got = ""; try { if (hit != null) got = Row("A", -1, Interactive(hit).GetUpdatedCache(Request())) ?? ""; } catch {} return "stale" + N + got; }
  SetCursorPos(x, y); POINT p; GetCursorPos(out p);
  if (Math.Abs(p.X - x) > 1 || Math.Abs(p.Y - y) > 1) return "missed" + T + p.X + T + p.Y;
  var wp = new POINT(); wp.X = x; wp.Y = y; var owner = GetAncestor(WindowFromPoint(wp), 2);
  if (owner.ToInt64() != h) { var wt = new StringBuilder(256); GetWindowText(owner, wt, 256); return "covered" + T + C(wt.ToString()); }
  if (!Front(h)) return "9999";
  return SendInput(2, new INPUT[] { Mouse(2u, 0), Mouse(4u, 0) }, InputSize).ToString(); }
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
 static bool Render(IntPtr h, RECT r, Graphics g, int w, int ht) {
  RECT wr; if (!GetWindowRect(h, out wr)) return false; int fw = wr.Right - wr.Left, fh = wr.Bottom - wr.Top; if (fw < 10 || fh < 10) return false;
  using (var full = new Bitmap(fw, fh)) {
   bool ok; using (var fg = Graphics.FromImage(full)) { var dc = fg.GetHdc(); try { ok = PrintWindow(h, dc, 2); } finally { fg.ReleaseHdc(dc); } }
   if (!ok) return false;
   int lit = 0; for (int i = 1; i < 8; i++) for (int j = 1; j < 8; j++) { var c = full.GetPixel(fw * i / 8, fh * j / 8); if (c.R + c.G + c.B > 24) lit++; }
   if (lit < 3) return false;
   g.DrawImage(full, new Rectangle(0, 0, w, ht), new Rectangle(r.Left - wr.Left, r.Top - wr.Top, w, ht), GraphicsUnit.Pixel); return true; } }
 static bool Covered(IntPtr h, RECT r) {
  for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) { var p = new POINT(); p.X = r.Left + 12 + (r.Right - r.Left - 24) * i / 2; p.Y = r.Top + 12 + (r.Bottom - r.Top - 24) * j / 2; var root = GetAncestor(WindowFromPoint(p), 2); if (root != h) return true; }
  return false; }
 public static string Capture(long handle, int maxWidth, string marks) {
  var h = new IntPtr(handle); var r = Bounds(h); int w = r.Right - r.Left, ht = r.Bottom - r.Top;
  if (w < 10 || ht < 10) return "";
  using (var bmp = new Bitmap(w, ht)) {
   using (var g = Graphics.FromImage(bmp)) {
    if (!Render(h, r, g, w, ht)) { if (Covered(h, r)) return ""; g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, ht)); }
    if (!String.IsNullOrEmpty(marks)) {
     var pen = new Pen(Color.Magenta, 2); var font = new Font("Segoe UI", 11, FontStyle.Bold); var bg = new SolidBrush(Color.Magenta);
     foreach (var m in marks.Split(';')) { var p = m.Split(','); if (p.Length < 5) continue;
      int id = int.Parse(p[0]), x = int.Parse(p[1]) - r.Left, y = int.Parse(p[2]) - r.Top, mw = int.Parse(p[3]), mh = int.Parse(p[4]);
      g.DrawRectangle(pen, x, y, mw, mh); var label = id.ToString(); var sz = g.MeasureString(label, font);
      g.FillRectangle(bg, x, y, sz.Width, sz.Height); g.DrawString(label, font, Brushes.White, x, y); } } }
   double scale = Math.Min(1.0, (double)maxWidth / w);
   using (var small = new Bitmap(bmp, new Size(Math.Max(1, (int)(w * scale)), Math.Max(1, (int)(ht * scale))))) using (var ms = new MemoryStream()) {
    ImageCodecInfo codec = null; foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
    var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
    small.Save(ms, codec, ps);
    return scale.ToString(System.Globalization.CultureInfo.InvariantCulture) + T + r.Left + T + r.Top + T + Convert.ToBase64String(ms.ToArray()); } } }
}`;

/** Extra prelude lines for the screen host (after ps-host's own: Forms, the JarvisWin helper). */
export const SCREEN_PRELUDE = [
  "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing",
  "$jarvisRefs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, [System.Drawing.Bitmap].Assembly.Location, [System.Windows.Forms.Clipboard].Assembly.Location)",
  `Add-Type -ReferencedAssemblies $jarvisRefs -TypeDefinition '${HELPER.replace(/\r?\n/g, " ").replace(/'/g, "''")}'`,
  // Physical pixels everywhere: UIA rectangles and SetCursorPos then agree on any display scale.
  "$null = [JarvisScreen]::Dpi()",
];

const int = (n: number) => {
  if (!Number.isFinite(n)) throw new Error("Not a coordinate.");
  return Math.trunc(n);
};
const b64out = (expr: string) => `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${expr}))`;

// --- virtual keys ------------------------------------------------------------------------------
const VK: Record<string, number> = {
  ctrl: 17, control: 17, alt: 18, shift: 16, win: 91, enter: 13, return: 13, tab: 9, escape: 27, esc: 27, space: 32,
  backspace: 8, delete: 46, del: 46, insert: 45, home: 36, end: 35, pageup: 33, pagedown: 34, up: 38, down: 40, left: 37, right: 39,
  f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
};
/** "ctrl+a" → [17, 65]; null if any part isn't a key we know. */
export function chordKeys(chord: string): number[] | null {
  const parts = chord.toLowerCase().replace(/page ?(up|down)/g, "page$1").split(/\s*\+\s*/).filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (VK[part] !== undefined) out.push(VK[part]);
    else if (/^[a-z0-9]$/.test(part)) out.push(part.toUpperCase().charCodeAt(0));
    else return null;
  }
  return out;
}

/** Thrown when the target window is no longer in front: input was withheld, not sent elsewhere. */
export class WindowMoved extends Error {
  constructor() {
    super("The window changed under me, so I stopped.");
  }
}

/**
 * A checked click that wasn't pressed: the pointer didn't land on the point (another desktop, a
 * UAC prompt or a locked screen has the input), or another window (a toast, a dialog) owns it.
 * Nothing was clicked. (typesafe-computer-use's `Missed`, for Windows.)
 */
export class Missed extends Error {
  constructor(readonly why: "pointer" | "covered", detail = "") {
    super(why === "pointer" ? "My pointer didn't land where I aimed, so I didn't click." : `${detail ? `"${detail.slice(0, 40)}"` : "Another window"} was over that spot, so I didn't click.`);
    this.name = "Missed";
  }
}

export type ClickCheck =
  | { ok: true }
  | { ok: false; why: "moved" }
  | { ok: false; why: "stale"; under: string }
  | { ok: false; why: "pointer"; at: { x: number; y: number } | null }
  | { ok: false; why: "covered"; title: string };
/** The helper's ClickAt answer → what happened. Pure. */
export function parseClickCheck(out: string): ClickCheck {
  const t = out.trim();
  if (t === "9999") return { ok: false, why: "moved" };
  if (t.startsWith("stale")) return { ok: false, why: "stale", under: t.split(/\r?\n/)[1] ?? "" };
  if (t.startsWith("missed")) {
    const [, x, y] = t.split("\t").map(Number);
    return { ok: false, why: "pointer", at: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null };
  }
  if (t.startsWith("covered")) return { ok: false, why: "covered", title: t.split("\t")[1] ?? "" };
  return /^\d+$/.test(t) && Number(t) > 0 ? { ok: true } : { ok: false, why: "pointer", at: null };
}

/** The control a checked click must find under its point (role, name, AutomationId, rectangle). */
export type ClickTarget = { type: string; name: string; aid: string; x: number; y: number; w: number; h: number };

export type NativeScreen = {
  snapshot(handle: number, max?: number, context?: boolean): Promise<string>;
  focused(): Promise<string>;
  at(x: number, y: number): Promise<string>;
  /** Input goes to `handle` only: if another window has come to the front, nothing is sent. */
  click(handle: number, x: number, y: number): Promise<void>;
  /** Press, move and release (a drag); the pointer is his, so callers put it back. */
  drag?(handle: number, x1: number, y1: number, x2: number, y2: number): Promise<void>;
  /** A common dialog's File name box: focus, select all, paste as input, and read back exactly. */
  setDialogValue?(handle: number, text: string): Promise<boolean>;
  /** Common file dialogs by Win32 control id (Edit 1001, Button 1/2): see NativeDialog. */
  dialog?: NativeDialog;
  /**
   * The checked click (flag `recheck`): in ONE helper call, right before SendInput, the UIA element
   * at the point must be `target` (or contain the hit), the pointer must read back at the point and
   * the point must belong to `handle`. Otherwise nothing is pressed and the reason comes back.
   */
  clickAt(handle: number, x: number, y: number, target: ClickTarget): Promise<ClickCheck>;
  wheel(handle: number, x: number, y: number, delta: number): Promise<void>;
  keys(handle: number, chord: string): Promise<void>;
  type(handle: number, text: string): Promise<void>;
  focus(handle: number): Promise<boolean>;
  pid(handle: number): Promise<number>;
  capture(handle: number, maxWidth: number, marks: Array<{ id: number; x: number; y: number; w: number; h: number }>): Promise<{ image: string; scale: number; left: number; top: number } | null>;
  /** Cheap look for a lesson: the front window, `handle`'s title, the focus and the control at a point. */
  probe(handle: number, x: number, y: number): Promise<string>;
  /**
   * Work a control through UI Automation (Invoke, Toggle, SelectionItem, ExpandCollapse, SetFocus,
   * Scroll), so his mouse pointer never moves. "none"/"missing" mean it couldn't; WindowMoved if
   * `handle` isn't in front.
   */
  act(handle: number, target: { x: number; y: number; type: string; name: string }, verb: UiaVerb): Promise<UiaResult>;
  cursor(): Promise<{ x: number; y: number } | null>;
  moveCursor(x: number, y: number): Promise<void>;
  /** The top-level window under a point (his pointer), or 0. */
  windowAt(x: number, y: number): Promise<number>;
};
/**
 * Windows 11's Save As / Open dialog, driven by Win32 control id because its lower pane (File name,
 * Save, Cancel) isn't reliably in a UIA tree walk and ignores a programmatically set file name (found
 * live 27 Sep). Every call is a fixed template; text goes in as base64.
 */
export type NativeDialog = {
  owner(handle: number): Promise<number>;
  /** GA_ROOTOWNER of a window (a XAML flyout or editor island → the app's frame). */
  rootOwner(handle: number): Promise<number>;
  alive(handle: number): Promise<boolean>;
  /** null when the window isn't a #32770 dialog. */
  info(handle: number): Promise<{ fileBox: boolean; button1: string; button2: string } | null>;
  /** UIA SetFocus on Edit 1001, confirmed. WindowMoved if the dialog isn't in front. */
  focusFileName(handle: number): Promise<boolean>;
  /** Press button `id` only when its text is `label`; how it was pressed. Throws otherwise. */
  press(handle: number, id: number, label: string): Promise<"invoke" | "bmclick">;
  /** A prompt's button labels (never its message text). */
  promptButtons(handle: number): Promise<string[]>;
  pressPrompt(handle: number, label: string): Promise<boolean>;
};
/** The helper's DialogInfo answer. Pure. */
export function parseDialogInfo(out: string): { fileBox: boolean; button1: string; button2: string } | null {
  if (!out || out.trim() === "none") return null;
  const [box = "0", button1 = "", button2 = ""] = out.replace(/\r?\n$/, "").split("\t");
  return { fileBox: box.trim() === "1", button1: button1.trim(), button2: button2.trim() };
}
export type UiaVerb = "press" | "focus" | "scrollup" | "scrolldown";
export type UiaResult = "invoke" | "toggle" | "select" | "expand" | "collapse" | "focus" | "scroll" | "none" | "missing";

export function nativeScreen(ps: PsHost): NativeScreen {
  const text = async (script: string, timeoutMs = 8000) => {
    const out = (await ps.run(script, timeoutMs)).trim();
    if (out.startsWith("ERROR")) throw new Error(out.slice(7, 200) || "Windows refused that.");
    return out;
  };
  const input = async (script: string) => {
    if ((await text(script)) === "9999") throw new WindowMoved();
  };
  return {
    async snapshot(handle, max = 400, context = false) {
      // (context: browser windows only, bounded by a deadline inside the helper; a "T" row says it was cut short.)
      return unb64(await text(b64out(`[JarvisScreen]::SnapshotX(${int(handle)}, ${int(max)}, ${context ? "$true" : "$false"})`), 10_000));
    },
    async focused() {
      return unb64(await text(b64out("[JarvisScreen]::Focused()")));
    },
    async at(x, y) {
      return unb64(await text(b64out(`[JarvisScreen]::At(${int(x)}, ${int(y)})`)));
    },
    async click(handle, x, y) {
      await input(`[JarvisScreen]::Click(${int(handle)}, ${int(x)}, ${int(y)}, 0, 1)`);
    },
    async clickAt(handle, x, y, t) {
      const out = await text(
        b64out(`[JarvisScreen]::ClickAt(${int(handle)}, ${int(x)}, ${int(y)}, ${psText(t.type.slice(0, 40))}, ${psText(t.name.slice(0, 120))}, ${psText(t.aid.slice(0, 120))}, ${int(t.x)}, ${int(t.y)}, ${int(t.w)}, ${int(t.h)})`),
        6000,
      );
      return parseClickCheck(unb64(out));
    },
    async wheel(handle, x, y, delta) {
      await input(`[JarvisScreen]::Wheel(${int(handle)}, ${int(x)}, ${int(y)}, ${int(delta)})`);
    },
    async keys(handle, chord) {
      const vks = chordKeys(chord);
      if (!vks) throw new Error(`I don't know the key ${chord}.`);
      await input(`[JarvisScreen]::Chord(${int(handle)}, [int[]]@(${vks.join(",")}))`);
    },
    async drag(handle, x1, y1, x2, y2) {
      await input(`[JarvisScreen]::Drag(${int(handle)}, ${int(x1)}, ${int(y1)}, ${int(x2)}, ${int(y2)})`);
    },
    async setDialogValue(handle, value) {
      const out = await text(`[JarvisScreen]::SetDialogValue(${int(handle)}, ${psText(value.slice(0, 2000))})`);
      if (out === "moved") throw new WindowMoved();
      if (out === "failed") throw new Error("The Save As file name did not match after typing, so I did not save.");
      return out === "set";
    },
    dialog: {
      async owner(handle) {
        return Number(await text(`[JarvisScreen]::DialogOwner(${int(handle)})`)) || 0;
      },
      async alive(handle) {
        return (await text(`[JarvisScreen]::Alive(${int(handle)})`)) === "True";
      },
      async rootOwner(handle) {
        return Number(await text(`[JarvisScreen]::RootOwner(${int(handle)})`)) || 0;
      },
      async info(handle) {
        return parseDialogInfo(unb64(await text(b64out(`[JarvisScreen]::DialogInfo(${int(handle)})`))));
      },
      async focusFileName(handle) {
        const out = await text(`[JarvisScreen]::FocusFileName(${int(handle)})`);
        if (out === "moved") throw new WindowMoved();
        return out === "focused";
      },
      async press(handle, id, label) {
        const out = unb64(await text(b64out(`[JarvisScreen]::PressDialogButton(${int(handle)}, ${int(id)}, ${psText(label.slice(0, 40))})`)));
        if (out === "moved") throw new WindowMoved();
        if (out === "invoke" || out === "bmclick") return out;
        if (out.startsWith("label")) throw new Error(`The dialog's button ${int(id)} says "${out.split("\t")[1] ?? ""}", not "${label}", so I didn't press it.`);
        throw new Error(`The dialog's "${label}" button wasn't there to press.`);
      },
      async promptButtons(handle) {
        return unb64(await text(b64out(`[JarvisScreen]::PromptButtons(${int(handle)})`)))
          .split("\t")
          .map((s) => s.trim())
          .filter(Boolean);
      },
      async pressPrompt(handle, label) {
        const out = await text(`[JarvisScreen]::PressPromptButton(${int(handle)}, ${psText(label.slice(0, 40))})`);
        if (out === "moved") throw new WindowMoved();
        return out === "invoke" || out === "bmclick";
      },
    },
    async type(handle, value) {
      const text = value.slice(0, 2000);
      // Pasted in one go (Windows 11 Notepad drops keystrokes while it renames a new tab); the
      // copy is kept out of clipboard history and his own clipboard comes back 0.9 s later.
      // A single character is simply typed.
      await input(text.length > 1 ? `[JarvisScreen]::Paste(${int(handle)}, ${psText(text)})` : `[JarvisScreen]::Type(${int(handle)}, ${psText(text)})`);
    },
    async focus(handle) {
      return (await text(`[JarvisWin]::Focus(${int(handle)})`)) === "True";
    },
    async pid(handle) {
      return Number(await text(`[JarvisScreen]::Pid(${int(handle)})`)) || 0;
    },
    async probe(handle, x, y) {
      return unb64(await text(b64out(`[JarvisScreen]::Probe(${int(handle)}, ${int(x)}, ${int(y)})`)));
    },
    async act(handle, target, verb) {
      const out = await text(`[JarvisScreen]::Act(${int(handle)}, ${int(target.x)}, ${int(target.y)}, ${psText(target.type.slice(0, 40))}, ${psText(target.name.slice(0, 120))}, '${verb.replace(/[^a-z]/g, "")}')`, 6000);
      if (out === "9999") throw new WindowMoved();
      return (["invoke", "toggle", "select", "expand", "collapse", "focus", "scroll", "missing"].includes(out) ? out : "none") as UiaResult;
    },
    async cursor() {
      const [x, y] = (await text("[JarvisScreen]::Cursor()")).split("	").map(Number);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    },
    async moveCursor(x, y) {
      await text(`[JarvisScreen]::MoveCursor(${int(x)}, ${int(y)})`);
    },
    async windowAt(x, y) {
      return Number(await text(`[JarvisScreen]::WindowAt(${int(x)}, ${int(y)})`)) || 0;
    },
    async capture(handle, maxWidth, marks) {
      const list = marks.map((m) => [m.id, m.x, m.y, m.w, m.h].map(int).join(",")).join(";");
      const out = await text(`[JarvisScreen]::Capture(${int(handle)}, ${int(maxWidth)}, '${list.replace(/[^0-9,;-]/g, "")}')`, 12_000);
      const [scale, left, top, image] = out.split("\t");
      return image ? { image, scale: Number(scale) || 1, left: Number(left) || 0, top: Number(top) || 0 } : null;
    },
  };
}
