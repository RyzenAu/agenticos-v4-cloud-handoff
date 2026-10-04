// Live bench for the companion cursor (docs/CLICKY-COMPARISON.md): opens its OWN Edge window on a
// local test page (a fresh profile, nothing of his), asks ten pointing questions and reports
// question→pointer latency and whether the pointer landed on the right control (checked against
// the control's UI Automation rectangle). Optional screenshots with the cursor visible.
//
//   bun scripts/screen-hands/point-bench.ts <page.html> [--shots <dir>] [--record <file.mp4>] [--vision]
//       [--profile <dir>] [--at x,y]
//
// Screenshots and the recording are guarded: the page opens as an Edge app window (no toolbar or
// favourites), only that window's rectangle is captured, and a frame is kept only when nine points
// across it all belong to that window (his windows are never captured). The Jarvis cursor is let
// into captures only for the run.
//
// It never clicks or types. It moves his mouse pointer only for the "what does this do?" case, and
// only when he has been idle for a minute, then puts it back.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPsHost } from "../jarvis-skills/ps-host";
import { providerKey } from "../provider-config";
import { createClaudeVision, createPointEyes } from "../claude-vision";
import { createScreenHands, nativeHands } from "./index";
import { nativeScreen, SCREEN_PRELUDE } from "./native";
import { createOverlay, type Overlay, type Point } from "./overlay";
import { labelOf, type UiElement } from "./plan";

const args = process.argv.slice(2);
const page = resolve(args[0] ?? "");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const shots = flag("--shots");
const record = flag("--record");
const [atX, atY] = (flag("--at") ?? "160,110").split(",").map(Number);
const FFMPEG = flag("--ffmpeg");
const vision = args.includes("--vision");
const profile = resolve(flag("--profile") ?? join(process.env.TEMP ?? ".", "jarvis-point-bench-profile"));
const root = resolve(import.meta.dir, "..", "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

type Case = { question: string; kind: "find" | "this"; target?: string; expect: string; hover?: boolean; vision?: boolean };
export const CASES: Case[] = [
  { question: "where's the export PDF button?", kind: "find", target: "export PDF button", expect: "Export PDF" },
  { question: "where is the save draft button", kind: "find", target: "save draft button", expect: "Save draft" },
  { question: "point to the help centre link", kind: "find", target: "help centre link", expect: "Help centre" },
  { question: "where's the customer name field?", kind: "find", target: "customer name field", expect: "Customer name" },
  { question: "where's the currency drop down", kind: "find", target: "currency drop down", expect: "Currency" },
  { question: "where's the payments tab", kind: "find", target: "payments tab", expect: "Payments" },
  { question: "where's the option to put another item on the invoice?", kind: "find", target: "option to put another item on the invoice", expect: "Add line item" },
  { question: "where's the tax setting?", kind: "find", target: "tax setting", expect: "Include GST" },
  { question: "where's the round green button?", kind: "find", target: "round green button", expect: "Approve", vision: true },
  { question: "what does this switch do?", kind: "this", expect: "Dark mode", hover: true },
  // Ten more phrasings in his own words (Jev's calibration set, 25 Sep).
  { question: "where do I download this as a PDF", kind: "find", target: "download this as a PDF", expect: "Export PDF" },
  { question: "where's the button to keep this for later", kind: "find", target: "button to keep this for later", expect: "Save draft" },
  { question: "where do I get support", kind: "find", target: "get support", expect: "Help centre" },
  { question: "where do I type who the client is", kind: "find", target: "type who the client is", expect: "Customer name" },
  { question: "where can I change the money type", kind: "find", target: "change the money type", expect: "Currency" },
  { question: "where do I see what's been paid", kind: "find", target: "see what's been paid", expect: "Payments" },
  { question: "where's the log of past changes", kind: "find", target: "log of past changes", expect: "History" },
  { question: "where's the night theme toggle", kind: "find", target: "night theme toggle", expect: "Dark mode" },
  { question: "where's the approve button", kind: "find", target: "approve button", expect: "Approve" },
  { question: "how do I add a new row to the invoice", kind: "find", target: "add a new row to the invoice", expect: "Add line item" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};

async function main() {
  if (!args[0]) throw new Error("Usage: bun scripts/screen-hands/point-bench.ts <page.html> [--shots dir] [--vision]");
  const ps = createPsHost({ prelude: SCREEN_PRELUDE });
  const native = nativeScreen(ps);
  const hands = nativeHands(ps, native);
  // The real overlay, recording where each glide went.
  const real = createOverlay();
  const claudeVision = createClaudeVision();
  const pointEyes = createPointEyes(root, claudeVision);
  let lastGlide: Point | null = null;
  const overlay: Overlay = { ...real, glide: async (to, o) => ((lastGlide = to), real.glide(to, o)) };
  Object.defineProperty(overlay, "affinity", { get: () => real.affinity });
  const screen = createScreenHands({
    key: (name) => providerKey(root, name),
    ps,
    hands,
    overlay,
    // As the OS server does: the routed eyes (vision.point): warm Claude, free Groq, then GPT-6 via Hermes.
    pointLook: (image, prompt, signal) => pointEyes(image, prompt, signal, "point bench"),
    pointWarm: () => claudeVision.warm(),
  });
  if (shots || record) await real.excludeFromCapture(false);
  if (shots) mkdirSync(shots, { recursive: true });
  // A second helper for guarded captures, so frames never wait behind UI Automation.
  const cam = createPsHost();
  const frames = join(profile, "..", `point-bench-frames-${Date.now().toString(36)}`);
  mkdirSync(frames, { recursive: true });
  let camReady: Promise<unknown> | null = null;
  const grab = async (file: string, r: { x: number; y: number; w: number; h: number }, handle: number) => {
    camReady ??= cam.run(
      `Add-Type -AssemblyName System.Drawing; Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(GRAB_CS, "utf8").toString("base64")}'))); [JarvisGrab]::Dpi()`,
      30_000,
    );
    await camReady;
    const out = await cam.run(`[JarvisGrab]::Grab(${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.w)}, ${Math.round(r.h)}, ${handle}, '${file.replace(/'/g, "''")}')`, 8000).catch(() => "0");
    return out.trim() === "1";
  };

  // His own Edge is untouched: a fresh profile, one new window on the primary monitor.
  mkdirSync(profile, { recursive: true });
  spawn(EDGE, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", `--window-position=${atX},${atY}`, "--window-size=1500,820", `--app=${pathToFileURL(page).href}`], { detached: true, stdio: "ignore" }).unref();
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    await sleep(500);
    win = (await hands.windows().catch(() => [])).find((w) => /Invoice INV-0042/.test(w.title)) ?? null;
  }
  if (!win) throw new Error("The bench page didn't open.");
  // Pointing needs no focus: the bench never takes the front from him after Edge opens.
  await sleep(1500);
  // A new Edge window answers UI Automation a beat after it appears.
  let snap = await hands.snapshot(win).catch(() => null);
  for (let i = 0; i < 30 && !snap?.elements.some((e) => e.web && labelOf(e) === "Export PDF"); i++) {
    await sleep(800);
    snap = await hands.snapshot(win).catch(() => null);
  }
  if (!snap?.elements.some((e) => e.web && labelOf(e) === "Export PDF")) throw new Error("The bench page has no UI Automation tree yet.");
  const truth = (label: string): UiElement | undefined => snap!.elements.find((e) => labelOf(e) === label && e.web !== false);
  const missing = CASES.filter((c) => !truth(c.expect)).map((c) => c.expect);
  if (missing.length) console.log(`Not in the UIA tree: ${missing.join(", ")} (${snap!.elements.length} controls)`);

  // Only the bench window itself (an app window: no toolbar, no favourites). The page keeps room
  // on its right for the caption bubble.
  const region = { ...snap.window };
  let recording = !!record;
  let frameNo = 0;
  const recorder = (async () => {
    while (recording) {
      const t = Date.now();
      if (await grab(join(frames, `f${String(frameNo).padStart(5, "0")}.jpg`), region, win.handle)) frameNo++;
      await sleep(Math.max(0, 100 - (Date.now() - t)));
    }
  })();
  const rows: Array<Record<string, unknown>> = [];
  for (let [i, c] of CASES.entries()) {
    // The window may have moved: the truth is read fresh for every question.
    const fresh = await hands.snapshot(win).catch(() => null);
    if (fresh) snap = fresh;
    const want = truth(c.expect);
    let restore: Point | null = null;
    if (c.hover) {
      const idle = (await real.stat())?.idleMs ?? 0;
      if (want && idle >= 60_000) {
        restore = await native.cursor();
        await native.moveCursor(Math.round(want.x + want.w / 2), Math.round(want.y + want.h / 2));
        await sleep(300);
      } else {
        // He's using the mouse: never move it. Ask by name instead ("what does the … do?").
        c = { ...c, question: `what does the ${c.expect.toLowerCase()} switch do?`, kind: "find", target: `${c.expect.toLowerCase()} switch` };
        console.log("(he's using the mouse, so the pointer case asks by name)");
      }
    }
    lastGlide = null;
    const reply = await screen.point({ question: c.question, kind: c.kind, ...(c.target ? { target: c.target } : {}), vision: vision || !!c.vision, onlyWindow: win.handle }, new AbortController().signal);
    const at = lastGlide as Point | null;
    const hit = !!(want && at && at.x >= want.x - 6 && at.x <= want.x + want.w + 6 && at.y >= want.y - 6 && at.y <= want.y + want.h + 6);
    rows.push({ n: i + 1, question: c.question, expect: c.expect, via: reply.via, said: reply.said, label: reply.label, hit, point: reply.ms.point, arrived: reply.ms.arrived, total: reply.ms.total, model: reply.model });
    console.log(`${i + 1}. ${hit ? "HIT " : "MISS"} ${String(reply.ms.point).padStart(5)} ms  ${reply.via.padEnd(7)} ${c.question} → ${reply.said}`);
    if (shots) {
      await sleep(900);
      const file = join(shots, `jarvis-cursor-v2-${String(i + 1).padStart(2, "0")}.png`);
      if (!(await grab(file, region, win.handle))) console.log("   (screenshot skipped: something of his was over the bench window)");
    }
    if (restore) await native.moveCursor(restore.x, restore.y);
    await sleep(shots ? 900 : 400);
  }
  const done = rows.filter((r) => typeof r.point === "number");
  const points = done.map((r) => r.point as number);
  const arrived = done.map((r) => r.arrived as number);
  const summaryFile = flag("--json");
  const summary = { cases: rows.length, measured: done.length, hits: rows.filter((r) => r.hit).length, p50PointMs: pct(points, 50), p90PointMs: pct(points, 90), p50ArrivedMs: pct(arrived, 50), rows };
  if (summaryFile) await Bun.write(summaryFile, JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      { cases: rows.length, measured: done.length, hits: rows.filter((r) => r.hit).length, p50PointMs: pct(points, 50), p90PointMs: pct(points, 90), p50ArrivedMs: pct(arrived, 50), rows },
      null,
      2,
    ),
  );
  await sleep(1500);
  recording = false;
  await recorder;
  if (record && frameNo && FFMPEG) {
    await new Promise<void>((done) => {
      const ff = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "10", "-i", join(frames, "f%05d.jpg"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", record], { stdio: "inherit" });
      ff.on("close", () => done());
    });
    console.log(`Recording: ${record} (${frameNo} frames)`);
  }
  cam.close();
  screen.stopAll();
  await real.excludeFromCapture(true);
  // Close the bench window (its own profile), not his browser.
  const mark = profile.replace(/'/g, "''").replace(/[[\]*?]/g, "");
  await ps
    .run(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${mark}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'ok'`, 15_000)
    .catch(() => undefined);
  screen.close();
  claudeVision.close();
  setTimeout(() => process.exit(0), 800);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/** Guarded capture: only when nine points across the region all belong to the bench window. */
const GRAB_CS = `
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class JarvisGrab {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public static string Dpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} return "ok"; }
  public static int Grab(int x, int y, int w, int h, long handle, string path) {
    int ww = w;
    for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) {
      var p = new P(); p.X = x + 12 + (ww - 24) * i / 2; p.Y = y + 12 + (h - 24) * j / 2;
      var root = GetAncestor(WindowFromPoint(p), 2);
      if (root.ToInt64() != handle) return 0;
    }
    using (var b = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(b)) g.CopyFromScreen(x, y, 0, 0, b.Size);
      b.Save(path, path.EndsWith(".png") ? ImageFormat.Png : ImageFormat.Jpeg);
    }
    return 1;
  }
}`;
