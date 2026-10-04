// Teach Mode 2.0, live: a real course on an installed app, on windows this script opens itself.
//
//   bun scripts/screen-hands/teach-demo.ts excel|explorer|drag|pivot [--json out.json] [--vision]
//
// pivot: Excel's real PivotTable Fields pane on a throwaway workbook (D:	mp, only when Excel isn't
// running): three field drags (Rows, Values, Columns), shown then guided, checked through Excel's own
// automation.
//
// drag: the drag bench page (bench/drag.html) in its own Edge window. Three drags (a field onto the
// Rows area, the Zoom slider to 80%, a clip along the timeline), each shown ("show": Jarvis drags),
// then guided ("guide": the cursor demonstrates, the simulated learner drags with a real mouse
// drag, and the lesson must notice). Timings: the demo, and how long after his drag it noticed.
//
// For each app: build the course (the real curriculum path: SearXNG, Gemini, Groq), then run
//   lesson 1 in "show" style (Jarvis does it and says each step),
//   lesson 2 in "guide" style (he's simulated: nothing for ~4 s, so a hint; then "I can't find it",
//            which hands that step to Jarvis; the rest the same way),
//   lesson 3 as a quiz ("hint", then "stuck" for each step),
// and record every line Jarvis says and every step result with timings: the transcript of a lesson.
//
// Safety: waits for 60 s idle before each lesson and stops the moment he touches the PC; his
// clipboard (every format) is snapshotted first and put back and verified after; only its own
// windows (a sample CSV in Excel when Excel isn't running; File Explorer on a scratch folder under
// D:	mp, and a lesson that wanders out of that folder is stopped, so his folders' views never change);
// every lesson runs with onlyWindow; every step still passes vetAction and the deny-list. Excel is
// closed without saving through its own automation; Explorer's view settings are read first and put
// back; the course is kept in a scratch file, not his .operator-data.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { nativeScreen } from "./native";
import { centre, labelOf, parseSnapshot } from "./plan";
import { createLesson, createLessonMinds, type LessonMinds } from "./lesson";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { providerKey } from "../provider-config";
import { startApps, startAppsReady } from "../pc-hands";
import { courseStore, createCourses, type Course } from "./course";
import { createScreenHands } from "./index";
import { SCREEN_PRELUDE } from "./native";
import { createPsHost } from "../jarvis-skills/ps-host";
import { screenFlags } from "./flags";
import type { LessonEvent, LessonReply } from "./lesson";
import { createGuard, type Guard } from "../jarvis-e2e/guard";
import { openExcelPivot, type PivotLayout } from "./bench/excel-pivot";

const args = process.argv.slice(2);
const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const which = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const ROOT = resolve(import.meta.dir, "..", "..");
const SCRATCH = String.raw`D:\tmp\jarvis-teach-demo`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (name: string) => providerKey(ROOT, name);
const ps = createPsHost({ prelude: SCREEN_PRELUDE });
const screen = createScreenHands({ key, ps, flags: () => screenFlags() });
screen.overlay.warm();

// His input, watched with a low-level hook (Jarvis's own injected input doesn't count): each lesson
// starts only after 60 s without it, and his first real key or mouse move stops everything at once.
let guard: Guard | null = null;
let touchedBy: string | null = null;
async function theGuard() {
  if (!guard) {
    guard = await createGuard();
    guard.onTouch((what) => {
      touchedBy = what;
      screen.stopAll();
      console.log(`(he touched the PC: ${what}; stopped)`);
    });
  }
  return guard;
}
async function idle(seconds = 60, maxMs = 30 * 60_000) {
  const ok = await (await theGuard()).idle(seconds, maxMs);
  if (ok) touchedBy = null;
  return ok;
}
const handles = async () => new Set((await screen.hands.windows()).map((w) => w.handle));
async function newWindow(before: Set<number>, match: (w: { process: string; title: string }) => boolean, ms = 30_000) {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    const w = (await screen.hands.windows()).find((x) => !before.has(x.handle) && match(x));
    if (w) return w;
    await sleep(500);
  }
  return null;
}

type Line = { t: number; kind: string; text: string };
/** `stay`: the window must keep a title like this (Explorer stays in the scratch folder), or the lesson stops. */
async function runLesson(reply: LessonReply, style: "show" | "guide" | "quiz", t0: number, transcript: Line[], stay?: { handle: number; title: RegExp }) {
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  transcript.push({ t: at(), kind: "jarvis", text: reply.said });
  if (reply.state === "ended" || !reply.id) return { ended: true };
  let end: Extract<LessonEvent, { type: "end" }> | null = null;
  let lastSay = Date.now();
  const off = screen.lessons.subscribe(reply.id, reply.seq ?? 0, (e) => {
    if (e.type === "say") {
      transcript.push({ t: at(), kind: "jarvis", text: e.said });
      lastSay = Date.now();
    } else if (e.type === "step") transcript.push({ t: at(), kind: "step", text: `${e.did} (${e.status})` });
    else if (e.type === "state" && e.step) transcript.push({ t: at(), kind: "state", text: e.step });
    else if (e.type === "end") end = e;
  });
  const deadline = Date.now() + 150_000;
  let hinted = false;
  while (!end && Date.now() < deadline) {
    await sleep(500);
    if (end) break;
    if (touchedBy) break;
    if (stay) {
      const title = (await screen.hands.windows()).find((w) => w.handle === stay.handle)?.title ?? "";
      if (title && !stay.title.test(title)) {
        screen.stopAll();
        transcript.push({ t: at(), kind: "note", text: `(left the scratch folder for "${title}"; stopped)` });
        break;
      }
    }
    // The simulated learner in guide and quiz: waits ~4 s, asks for a hint, then hands the step over.
    if (style !== "show" && Date.now() - lastSay > 4000) {
      const said = hinted ? "I can't find it" : "hint";
      transcript.push({ t: at(), kind: "him", text: said });
      const r = await screen.lessons.command({ control: hinted ? "stuck" : "hint" });
      if (r.said && r.state !== "ended") {
        transcript.push({ t: at(), kind: "jarvis", text: r.said });
        lastSay = Date.now();
      }
      hinted = !hinted;
    }
  }
  off();
  if (!end) {
    screen.stopAll();
    transcript.push({ t: at(), kind: "note", text: "(timed out; stopped)" });
  }
  return { ended: true, end };
}

async function course(app: "excel" | "explorer") {
  const transcript: Line[] = [];
  const timings: Record<string, number> = {};
  await startAppsReady();
  let cleanup: () => Promise<void> = async () => undefined;
  let handle = 0;
  let topic = "";
  let stay: { handle: number; title: RegExp } | undefined;
  // --- our own window --------------------------------------------------------------------------
  if (app === "excel") {
    if (Number((await ps.run("@(Get-Process EXCEL -ErrorAction SilentlyContinue).Count")).trim()) > 0) return { app, skipped: "Excel is already running (his)" };
    mkdirSync(SCRATCH, { recursive: true });
    const csv = join(SCRATCH, "jarvis-sales-sample.csv");
    const rows = ["Region,Product,Month,Sales"];
    for (const [r, p, m, s] of [["North", "Websites", "Jul", 4200], ["South", "Websites", "Jul", 3100], ["North", "Receptionist", "Aug", 2600], ["South", "Receptionist", "Aug", 1800], ["North", "Automation", "Sep", 1500], ["South", "Automation", "Sep", 2400], ["East", "Websites", "Sep", 3900], ["East", "Receptionist", "Sep", 1200]]) rows.push(`${r},${p},${m},${s}`);
    writeFileSync(csv, rows.join("\r\n"));
    const before = await handles();
    spawn("cmd.exe", ["/c", "start", "", "excel.exe", csv], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    const w = await newWindow(before, (x) => /^excel$/i.test(x.process) && /jarvis-sales-sample/i.test(x.title), 45_000);
    if (!w) return { app, skipped: "Excel didn't open" };
    handle = w.handle;
    topic = "Excel pivot tables";
    cleanup = async () => {
      // Our workbook only (Excel wasn't running before): closed without saving, then Excel quits.
      await ps.run("try { $xl = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application'); $xl.DisplayAlerts = $false; foreach ($wb in @($xl.Workbooks)) { $wb.Close($false) }; $xl.Quit() } catch {}; 'ok'", 30_000).catch(() => undefined);
      await sleep(2000);
      await ps.run("Get-Process EXCEL -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddHours(-1) } | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'", 20_000).catch(() => undefined);
    };
  } else {
    const folder = join(SCRATCH, "jarvis-explorer-lesson");
    mkdirSync(join(folder, "Invoices"), { recursive: true });
    for (const f of ["notes.txt", "budget draft.txt", "photo list.txt"]) writeFileSync(join(folder, f), "A harmless file for the lesson.\r\n");
    // Explorer's lasting view options, read now and put back after.
    const saved = (await ps.run("$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'; $p = Get-ItemProperty $k; @('HideFileExt','Hidden','ShowStatusBar','ShowPreviewHandlers','SeparateProcess','NavPaneExpandToCurrentFolder') | ForEach-Object { $_ + '=' + $p.$_ } | Out-String")).trim();
    const before = await handles();
    spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" }).unref();
    const w = await newWindow(before, (x) => /^explorer$/i.test(x.process) && /jarvis-explorer-lesson/i.test(x.title));
    if (!w) return { app, skipped: "Explorer didn't open" };
    handle = w.handle;
    topic = "File Explorer";
    // His own folders (Documents and the rest) are off limits: their views must never change.
    stay = { handle, title: /jarvis-explorer-lesson|Invoices/i };
    cleanup = async () => {
      await ps.run(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class JDClose { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }' -ErrorAction SilentlyContinue; [void][JDClose]::PostMessage([IntPtr]${handle}, 16, [IntPtr]::Zero, [IntPtr]::Zero); 'ok'`).catch(() => undefined);
      for (const line of saved.split(/\r?\n/)) {
        const [name, value] = line.split("=");
        if (name && value !== undefined && value !== "" && /^\d+$/.test(value.trim()))
          await ps.run(`$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'; if ((Get-ItemProperty $k).${name.trim()} -ne ${value.trim()}) { Set-ItemProperty $k -Name ${name.trim()} -Value ${value.trim()}; 'restored ${name.trim()}' } else { 'same' }`).then((o) => o.trim() !== "same" && console.log(o.trim())).catch(() => undefined);
      }
      rmSync(folder, { recursive: true, force: true });
    };
  }
  try {
    await sleep(3000);
    // --- the course, with its lessons pinned to our window ----------------------------------------
    const store = courseStore(join(SCRATCH, `courses-${app}.json`));
    const courses = createCourses({
      store,
      key,
      startLesson: (req, outro) => screen.lessons.start({ ...req, onlyWindow: handle, ...(args.includes("--vision") ? { vision: true } : {}) }, { outro }),
      foreground: () => screen.hands.foreground(),
      apps: () => startApps(),
      screen: async () => {
        const w = (await screen.hands.windows()).find((x) => x.handle === handle);
        return w ? (await import("./teach")).screenSummary(await screen.hands.snapshot(w), 50) : "";
      },
    });
    const styles = ["show", "guide", "quiz"] as const;
    for (const [i, style] of styles.entries()) {
      if (!(await idle())) return { app, skipped: "he was using the PC", transcript };
      await screen.hands.focus(handle);
      await sleep(600);
      const t0 = Date.now();
      transcript.push({ t: 0, kind: "him", text: i === 0 ? `teach me ${topic}` : "next lesson" });
      const reply = await courses.handle(i === 0 ? { action: "start", topic, style } : { action: "next", style });
      timings[`lesson${i + 1}FirstLineMs`] = Date.now() - t0;
      if (i === 0) timings.courseBuildAndFirstLineMs = Date.now() - t0;
      await runLesson(reply, style, t0, transcript, stay);
      timings[`lesson${i + 1}TotalMs`] = Date.now() - t0;
      if (touchedBy) return { app, skipped: `he used the PC (${touchedBy}), so it stopped`, timings, transcript };
      await sleep(1500);
    }
    const c: Course | null = store.list()[0] ?? null;
    return { app, course: c ? { title: c.title, model: c.model, sources: c.sources, lessons: c.lessons.map((l) => l.goal), progress: c.progress.records } : null, timings, transcript };
  } finally {
    screen.stopAll();
    await cleanup();
  }
}

/** The drag bench: show, then guide, for three kinds of drag. */
async function drags() {
  const transcript: Line[] = [];
  const results: Array<Record<string, unknown>> = [];
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const profile = join(SCRATCH, `edge-drag-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const url = pathToFileURL(resolve(import.meta.dir, "bench", "drag.html")).href;
  const before = await handles();
  spawn(EDGE, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-position=120,80", "--window-size=1000,640", `--app=${url}`], { detached: true, stdio: "ignore" }).unref();
  const win = await newWindow(before, (x) => /^Drag bench/.test(x.title));
  if (!win) return { app: "drag", skipped: "the drag page didn't open" };
  const title = async () => (await screen.hands.windows()).find((w) => w.handle === win.handle)?.title ?? "";
  const reload = async () => {
    await screen.hands.focus(win.handle);
    await screen.hands.keys(win.handle, "f5");
    await sleep(1500);
  };
  const minds: LessonMinds = createLessonMinds({ key, hermes: null });
  const tasks = [
    { goal: "put the Region field in the Rows area", done: (t: string) => /rows=Region\b/.test(t), learner: { from: "Region", to: "Rows area" } },
    { goal: "set the Zoom slider to about 80 percent", done: (t: string) => { const z = Number(t.match(/zoom=(\d+)/)?.[1]); return z >= 70 && z <= 90; }, learner: { from: "Zoom", percent: 80 } },
    { goal: "move Clip 1 to the middle of the Timeline", done: (t: string) => { const c = Number(t.match(/clip=(\d+)/)?.[1]); return c >= 250; }, learner: { from: "Clip 1", to: "Timeline", percent: 50 } },
  ] as const;
  try {
    for (const style of ["show", "guide"] as const)
      for (const task of tasks) {
        if (!(await idle())) return { app: "drag", skipped: "he was using the PC", transcript, results };
        await reload();
        const t0 = Date.now();
        const at = () => Math.round((Date.now() - t0) / 100) / 10;
        transcript.push({ t: 0, kind: "him", text: `${style === "show" ? "show me how to" : "teach me to"} ${task.goal}` });
        const lesson = createLesson({ goal: task.goal, mode: style === "show" ? "drive" : "teach", style, onlyWindow: win.handle }, { hands: screen.hands, overlay: screen.overlay, minds, hintMs: 20_000 });
        let saidDrag = 0;
        let learnerAt = 0;
        let noticedAt = 0;
        lesson.subscribe(0, (e) => {
          if (e.type === "say") {
            transcript.push({ t: at(), kind: "jarvis", text: e.said });
            if (/^Drag |^Dragging /.test(e.said)) saidDrag = Date.now();
          } else if (e.type === "step") {
            transcript.push({ t: at(), kind: "step", text: `${e.did} (${e.status})` });
            if (learnerAt && !noticedAt && e.by === "he") noticedAt = Date.now();
          }
        });
        const first = await lesson.started;
        transcript.push({ t: at(), kind: "jarvis", text: first.said });
        if (style === "guide") {
          // The simulated learner: a real mouse drag, 3 s after the demo line (never while it's still showing).
          for (let i = 0; i < 40 && !saidDrag && lesson.active; i++) await sleep(250);
          await sleep(3000);
          const snap = parseSnapshot(await nativeScreen(ps).snapshot(win.handle), { browser: true });
          // Plain locals: the learner is a union (drag to a target, drag by a percent, or both), and a closure loses the `in` narrowing.
          const learner = task.learner;
          const targetLabel = "to" in learner ? learner.to : undefined;
          const src = snap.elements.find((e) => e.web !== false && labelOf(e) === learner.from);
          const dst = targetLabel !== undefined ? snap.elements.find((e) => e.web !== false && labelOf(e) === targetLabel) : src;
          if (src && dst && lesson.active) {
            const pct = "percent" in learner ? learner.percent : undefined;
            const to = pct !== undefined ? { x: Math.round(dst.x + (dst.w * pct) / 100), y: Math.round(dst.y + dst.h / 2) } : centre(dst);
            transcript.push({ t: at(), kind: "him", text: `(drags ${learner.from} to ${pct !== undefined ? `${pct}%` : targetLabel})` });
            learnerAt = Date.now();
            await nativeScreen(ps).drag!(win.handle, centre(src).x, centre(src).y, to.x, to.y);
          } else transcript.push({ t: at(), kind: "note", text: `(learner couldn't find ${learner.from})` });
        }
        const out = await Promise.race([lesson.finished, sleep(60_000).then(() => ({ ok: false, said: "(timed out)" }))]);
        lesson.stop();
        await sleep(400);
        const tt = await title();
        if (touchedBy) return { app: "drag", skipped: `he used the PC (${touchedBy}), so it stopped`, transcript, results };
        results.push({ style, goal: task.goal, ok: task.done(tt), lessonOk: out.ok, said: out.said, ms: Date.now() - t0, noticedMs: learnerAt && noticedAt ? noticedAt - learnerAt : null, title: tt.replace(/^Drag bench \| /, "") });
        transcript.push({ t: at(), kind: "note", text: `result: ${task.done(tt) ? "done" : "NOT done"} | ${tt.replace(/^Drag bench \| /, "")}` });
      }
  } finally {
    screen.stopAll();
    await ps.run(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'ok'`, 20_000).catch(() => undefined);
  }
  return { app: "drag", results, transcript };
}

/**
 * Excel's real PivotTable Fields pane: a throwaway workbook (bench/excel-pivot.ts, only when Excel
 * isn't running) and three field drags, each shown then guided. Checked through Excel's own
 * automation (the PivotTable's layout), not by looking.
 */
async function pivot() {
  const transcript: Line[] = [];
  const results: Array<Record<string, unknown>> = [];
  if (!(await idle())) return { app: "pivot", skipped: "he was using the PC" };
  const t00 = Date.now();
  const xl = await openExcelPivot(ps);
  if ("skip" in xl) return { app: "pivot", skipped: xl.skip };
  const openMs = Date.now() - t00;
  const minds: LessonMinds = createLessonMinds({ key, hermes: null });
  const tasks = [
    { goal: "put the Region field in the Rows area", done: (l: PivotLayout) => l.rows.includes("Region"), learner: { from: "Region", to: /^Rows\b/i } },
    { goal: "put the Sales field in the Values area", done: (l: PivotLayout) => l.values.includes("Sales"), learner: { from: "Sales", to: /^Values\b/i } },
    { goal: "put the Product field in the Columns area", done: (l: PivotLayout) => l.columns.includes("Product"), learner: { from: "Product", to: /^Columns\b/i } },
  ];
  try {
    for (const style of ["show", "guide"] as const)
      for (const task of tasks) {
        if (touchedBy || !(await idle())) return { app: "pivot", skipped: `he used the PC (${touchedBy ?? "not idle"}), so it stopped`, transcript, results };
        await xl.reset();
        await screen.hands.focus(xl.hwnd);
        await sleep(800);
        const t0 = Date.now();
        const at = () => Math.round((Date.now() - t0) / 100) / 10;
        transcript.push({ t: 0, kind: "him", text: `${style === "show" ? "show me how to" : "teach me to"} ${task.goal}` });
        const lesson = createLesson({ goal: task.goal, mode: style === "show" ? "drive" : "teach", style, onlyWindow: xl.hwnd }, { hands: screen.hands, overlay: screen.overlay, minds, hintMs: 20_000 });
        let saidDrag = 0;
        let learnerAt = 0;
        let noticedAt = 0;
        lesson.subscribe(0, (e) => {
          if (e.type === "say") {
            transcript.push({ t: at(), kind: "jarvis", text: e.said });
            if (/^Drag |^Dragging /.test(e.said)) saidDrag = Date.now();
          } else if (e.type === "step") {
            transcript.push({ t: at(), kind: "step", text: `${e.did} (${e.status})` });
            if (learnerAt && !noticedAt && e.by === "he") noticedAt = Date.now();
          }
        });
        const first = await lesson.started;
        transcript.push({ t: at(), kind: "jarvis", text: first.said });
        if (style === "guide") {
          // The simulated learner: a real mouse drag from the field list to the area, 3 s after the demo line.
          for (let i = 0; i < 40 && !saidDrag && lesson.active; i++) await sleep(250);
          await sleep(3000);
          const snap = parseSnapshot(await nativeScreen(ps).snapshot(xl.hwnd, 600));
          const src = snap.elements.find((e) => /checkbox|listitem/i.test(e.type) && labelOf(e) === task.learner.from);
          const dst = snap.elements.find((e) => task.learner.to.test(labelOf(e)) && e.h > 20);
          if (src && dst && lesson.active && !touchedBy) {
            transcript.push({ t: at(), kind: "him", text: `(drags ${task.learner.from} to ${labelOf(dst)})` });
            learnerAt = Date.now();
            await nativeScreen(ps).drag!(xl.hwnd, centre(src).x, centre(src).y, centre(dst).x, centre(dst).y);
          } else transcript.push({ t: at(), kind: "note", text: `(learner couldn't find ${src ? "the area" : task.learner.from})` });
        }
        const out = await Promise.race([lesson.finished, sleep(90_000).then(() => ({ ok: false, said: "(timed out)" }))]);
        lesson.stop();
        await sleep(600);
        if (touchedBy) return { app: "pivot", skipped: `he used the PC (${touchedBy}), so it stopped`, transcript, results };
        const layout = await xl.layout();
        results.push({ style, goal: task.goal, ok: task.done(layout), lessonOk: out.ok, said: out.said, ms: Date.now() - t0, noticedMs: learnerAt && noticedAt ? noticedAt - learnerAt : null, layout });
        transcript.push({ t: at(), kind: "note", text: `result: ${task.done(layout) ? "done" : "NOT done"} | ${JSON.stringify(layout)}` });
      }
  } finally {
    screen.stopAll();
    await xl.close();
  }
  return { app: "pivot", openMs, results, transcript };
}

async function main() {
  const out: unknown[] = [];
  await (await theGuard()).saveClipboard();
  for (const app of (which.length ? which : ["excel", "explorer"]) as Array<"excel" | "explorer" | "drag" | "pivot">) {
    console.log(`--- ${app}`);
    const r = await (app === "drag" ? drags() : app === "pivot" ? pivot() : course(app)).catch((e) => ({ app, error: (e as Error).message }));
    out.push(r);
    const t = (r as { transcript?: Line[] }).transcript ?? [];
    for (const l of t) console.log(`${String(l.t).padStart(6)} s  ${l.kind.padEnd(6)} ${l.text}`);
    console.log(JSON.stringify({ ...r, transcript: undefined }, null, 1));
  }
  // A paste puts his clipboard back 0.9 s later from inside the helper: let it, then check it's his.
  await sleep(1500);
  const clipboard = await (await theGuard()).restoreClipboard();
  console.log("clipboard:", JSON.stringify(clipboard));
  out.push({ clipboard });
  const file = flag("--json");
  if (file) writeFileSync(file, JSON.stringify(out, null, 2));
}
void main()
  .catch((e) => console.error(e))
  .finally(async () => {
    // A paste puts his clipboard back 0.9 s later from inside the helper: let it before closing.
    await sleep(1500);
    screen.close();
    guard?.close();
    setTimeout(() => process.exit(0), 800);
  });
