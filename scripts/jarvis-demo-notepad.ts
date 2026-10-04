/**
 * The P0 end-to-end demo (docs/sales/dental-call-pack-2026-09-28/research/jarvis-deep-research.md §6):
 * open Notepad, type a synthetic note, save it to a scratch folder, and prove it independently.
 *
 *   bun scripts/jarvis-demo-notepad.ts --dry-run            preview only: steps, tier, target, hash
 *   bun scripts/jarvis-demo-notepad.ts --approve            run it (--approve stands in for his spoken yes)
 *     [--out-dir D:\tmp\jarvis-demo] [--audit-dir <dir>]   defaults: D:\tmp\jarvis-demo, .operator-data/audit
 *
 * Flow: dry-run preview → approval gate → Notepad (its own new, empty, Untitled window) → type the note
 * through screen_act's rules/UIA path (typed text read back) → Ctrl+S → the Save As dialog (checked to
 * be owned by our window) → File name (Edit 1001) focused, path pasted, read back → Save (button 1) pressed by UIA
 * Invoke, or BM_CLICK where the classic control has no UIA pattern (never Enter, never the pointer) →
 * the file read from disk and its SHA-256 compared
 * with the intended text's → one audit entry per step (hashes and basenames only, never the note).
 * Exit 0 only when the independent check passed. No model calls: rules and UIA only, so anything the
 * rules can't do stops the run instead of guessing. The note file is left for manual clean-up.
 */
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { newTaskId, outcomeFrom, runVerifier, sha256Hex, type AuditEntry, type ControlOutcome, type VerificationResult } from "../src/lib/control-outcome";
import { classifyControlTask, inScratch, type RiskTier } from "../src/lib/control-risk";
import { auditDir, createAuditLog } from "./control-audit";
import { fileContentVerifier, sha256OfText } from "./control-verifiers";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const DRY_RUN = args.includes("--dry-run");
const APPROVED = args.includes("--approve");
const OUT_DIR = resolve(flag("--out-dir") ?? String.raw`D:\tmp\jarvis-demo`);
const AUDIT = createAuditLog({ dir: flag("--audit-dir") ?? auditDir(ROOT) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stamp = new Date().toISOString();
// Words only: a timestamp's long digit runs look like a code or account number to the typing
// guard, which (correctly) refuses to type them. A random word pair keeps each run unique.
const WORDS = ["amber", "cedar", "harbour", "juniper", "lantern", "meadow", "orchid", "quartz", "saffron", "willow"];
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
const NOTE = `M&U demo note, synthetic data only, run ${pick()} ${pick()}`;
const FILE = join(OUT_DIR, `note-${stamp.replace(/[:.]/g, "-")}.txt`);
const TASK = `Open Notepad, type the synthetic note, then save it to ${FILE}`;
const taskId = newTaskId();

type Step = { n: number; action: string; target: string; tier: RiskTier; detail: string };
const risk = classifyControlTask(TASK);
const PLAN: Step[] = [
  { n: 1, action: "open_app", target: "notepad", tier: "local-reversible", detail: "a new, empty, Untitled Notepad window of its own" },
  { n: 2, action: "type", target: "notepad", tier: "local-reversible", detail: `screen_act rules path (UIA focus, paste, read-back); ${NOTE.length} chars, sha256 ${sha256OfText(NOTE).slice(0, 16)}…` },
  { n: 3, action: "save", target: basename(FILE), tier: risk.tier, detail: `Ctrl+S; File name (Edit 1001) focused via UIA, path pasted and read back; Save (button 1) pressed by UIA Invoke or BM_CLICK, never Enter; a replace prompt is answered No → ${FILE}` },
  { n: 4, action: "verify", target: basename(FILE), tier: "read-only", detail: "read the file from disk; SHA-256 of its normalised text must equal the note's" },
];

let auditOk = true;
function audit(entry: Omit<AuditEntry, "ts" | "taskId">) {
  try {
    AUDIT.append({ ...entry, ts: new Date().toISOString(), taskId });
  } catch (error) {
    auditOk = false;
    console.error(`audit write failed: ${(error as Error).message}`);
  }
}

function preview() {
  console.log("DRY-RUN PREVIEW — nothing has been executed yet");
  console.log(`  task id:    ${taskId}`);
  console.log(`  risk tier:  ${risk.tier} (${risk.reasons.join("; ")})`);
  console.log(`  target:     ${FILE}`);
  console.log(`  note text:  ${NOTE}`);
  for (const s of PLAN) console.log(`  ${s.n}. ${s.action.padEnd(8)} [${s.tier}] ${s.detail}`);
  console.log("  approval:   required before any step runs (--approve stands in for his spoken yes)");
  audit({ action: "preview", target: basename(FILE), tier: risk.tier, approval: "not-needed", outcome: "preview" });
}

const WIN32 =
  `Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class JarvisDemoWin { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h, int id); [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h); [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, P cb, IntPtr l); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l); [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l); [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); public static bool SetText(long h, string t) { return SendMessage(new IntPtr(h), 0x000C, IntPtr.Zero, t) != IntPtr.Zero; } public static string GetText(long h) { int n = SendMessage(new IntPtr(h), 0x000E, IntPtr.Zero, IntPtr.Zero).ToInt32(); var b = new StringBuilder(n + 2); SendMessage(new IntPtr(h), 0x000D, new IntPtr(n + 1), b); return b.ToString(); } public static bool Click(long h) { return PostMessage(new IntPtr(h), 0x00F5, IntPtr.Zero, IntPtr.Zero); } public static long ButtonByText(long parent, string text) { long found = 0; EnumChildWindows(new IntPtr(parent), delegate (IntPtr h, IntPtr l) { var c = new StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "Button" && GetText(h.ToInt64()) == text) { found = h.ToInt64(); return false; } return true; }, IntPtr.Zero); return found; } public static long Owner(long h) { return GetWindow(new IntPtr(h), 4).ToInt64(); } public static long Item(long h, int id) { return GetDlgItem(new IntPtr(h), id).ToInt64(); } public static long FindChild(long parent, int id, string cls) { long found = 0; EnumChildWindows(new IntPtr(parent), delegate (IntPtr h, IntPtr l) { var c = new StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == cls && GetDlgCtrlID(h) == id && IsWindowVisible(h)) { found = h.ToInt64(); return false; } return true; }, IntPtr.Zero); return found; } }' -ErrorAction SilentlyContinue`;
const parseJson = (text: string): Record<string, any> => {
  try {
    return JSON.parse(text.trim().split(/\r?\n/).pop() ?? "{}");
  } catch {
    return { error: "unparseable helper output" };
  }
};
/**
 * One call on the Save As dialog (by handle). Windows 11's file dialog doesn't expose its lower pane
 * (File name, Save, Cancel) to a UIA tree walk, and this host's managed UIA sees those classic
 * controls as pattern-less panes. So they're found by their Win32 ids (Edit 1001 = File name,
 * Button 1 = Save, Button 2 = Cancel) and acted on directly: UIA SetFocus / InvokePattern when the
 * element exposes them, otherwise BM_CLICK (what UIA's Invoke sends a classic button). Never Enter,
 * never the pointer. The file name itself is NOT set programmatically: on Windows 11 the dialog
 * ignores a ValuePattern/WM_SETTEXT value and saves under its own suggested name (found live, 27
 * Sep), so the caller pastes it as input after "focus" and checks it with "read".
 * Ops: focus | read | save | cancel | decline (the replace prompt's No). Prints one JSON line.
 */
function dialogScript(handle: number, op: "focus" | "read" | "save" | "cancel" | "decline", path: string) {
  const b64 = Buffer.from(path, "utf8").toString("base64");
  const h = Math.trunc(handle);
  const has = (v: string, pattern: string) => `(@(${v}.GetSupportedPatterns() | Where-Object { $_.ProgrammaticName -eq '${pattern}' }).Count -gt 0)`;
  return [
    WIN32,
    "$A = [System.Windows.Automation.AutomationElement]",
    `$r = @{ op = '${op}' }`,
    "try {",
    `$boxH = [JarvisDemoWin]::FindChild(${h}, 1001, 'Edit'); $saveH = [JarvisDemoWin]::Item(${h}, 1); $cancelH = [JarvisDemoWin]::Item(${h}, 2)`,
    "$r.fileBox = @{ found = ($boxH -ne 0); id = 1001 }",
    "if ($saveH -ne 0) { $r.saveButton = @{ name = [JarvisDemoWin]::GetText($saveH); id = 1 } }",
    `if ('${op}' -eq 'focus') { if ($boxH -eq 0) { throw 'no File name box (Edit 1001)' }; $box = $A::FromHandle([IntPtr]$boxH); $box.SetFocus(); Start-Sleep -Milliseconds 150; $r.focused = $box.Current.HasKeyboardFocus; $r.method = 'uia-focus' }`,
    `if ('${op}' -eq 'read') { if ($boxH -eq 0) { throw 'no File name box (Edit 1001)' }; $r.matches = ([JarvisDemoWin]::GetText($boxH) -ceq [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) }`,
    `if ('${op}' -eq 'decline') { $noH = [JarvisDemoWin]::ButtonByText(${h}, '&No'); if ($noH -ne 0) { $r.invoked = [JarvisDemoWin]::Click($noH); $r.method = 'bm-click' } else { $r.error = 'no No button' } }`,
    `if ('${op}' -eq 'save') { if ($saveH -eq 0) { throw 'no Save button (id 1)' }; $save = $A::FromHandle([IntPtr]$saveH); if (${has("$save", "InvokePatternIdentifiers.Pattern")}) { $save.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $r.method = 'uia-invoke' } else { $r.invoked = [JarvisDemoWin]::Click($saveH); $r.method = 'bm-click' } }`,
    `if ('${op}' -eq 'cancel') { if ($cancelH -ne 0) { $r.invoked = [JarvisDemoWin]::Click($cancelH); $r.method = 'bm-click' } }`,
    "} catch { $r.error = $_.Exception.Message }",
    "$r | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
}

async function execute(): Promise<{ outcome: ControlOutcome; verification?: VerificationResult; said: string }> {
  if (process.platform !== "win32") return { outcome: "failed", said: "This demo drives Windows Notepad; it only runs on Windows." };
  if (!inScratch(FILE)) return { outcome: "failed", said: `Refused: ${FILE} is outside the scratch folder (D:\\tmp\\).` };
  if (existsSync(FILE)) return { outcome: "failed", said: `Refused: ${FILE} already exists; nothing is overwritten.` };
  mkdirSync(OUT_DIR, { recursive: true });

  // Loaded only now, so --dry-run never starts PowerShell or touches the screen.
  const { spawn } = await import("node:child_process");
  const { createPsHost } = await import("./jarvis-skills/ps-host");
  const { nativeScreen, SCREEN_PRELUDE } = await import("./screen-hands/native");
  const { createScreenHands, nativeHands, vetAction, FLAGS_OFF } = await Promise.all([import("./screen-hands/index"), import("./screen-hands/flags")]).then(([i, f]) => ({ ...i, FLAGS_OFF: f.FLAGS_OFF }));

  const ps = createPsHost({ prelude: SCREEN_PRELUDE });
  const native = nativeScreen(ps);
  const hands = nativeHands(ps, native);
  // No model keys: the rules and UIA only. The deny-list and the pre-press recheck are on.
  const screen = createScreenHands({ key: () => "", ps, hands, flags: () => ({ ...FLAGS_OFF, recheck: true, denylist: true }) });
  const signal = new AbortController().signal;
  const fail = (step: number, action: string, said: string) => {
    audit({ action, step, target: action === "open_app" ? "notepad" : basename(FILE), tier: PLAN[step - 1].tier, approval: "flag", outcome: "step-failed" });
    return { outcome: "failed" as const, said };
  };
  let handle = 0;
  let openDialog = 0;
  try {
    // 1. Our own Notepad window.
    const before = new Set((await hands.windows()).map((w) => w.handle));
    spawn("notepad.exe", [], { detached: true, stdio: "ignore" }).unref();
    let win = null as Awaited<ReturnType<typeof hands.windows>>[number] | null;
    for (const until = Date.now() + 15_000; !win && Date.now() < until; await sleep(400))
      win = (await hands.windows().catch(() => [])).find((w) => !before.has(w.handle) && /^notepad$/i.test(w.process)) ?? null;
    if (!win) return fail(1, "open_app", "Notepad didn't open a new window of its own, so nothing was typed.");
    handle = win.handle;
    await sleep(1200);
    await hands.focus(handle);
    // Windows 11 Notepad can restore old tabs: only ever type into an empty, Untitled document.
    const title = async () => (await hands.windows()).find((w) => w.handle === handle)?.title ?? "";
    if (!/^untitled\b/i.test(await title())) {
      await hands.keys(handle, "ctrl+n");
      await sleep(800);
    }
    const editorText = async () =>
      (await ps.run("$e = [System.Windows.Automation.AutomationElement]::FocusedElement; $o = $null; if ($e -and $e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$o)) { $o.DocumentRange.GetText(4000) } else { '<no-text-pattern>' }", 8000).catch(() => "<error>")).replace(/\r?\n$/, "");
    if (!/^untitled\b/i.test(await title()) || (await editorText()) !== "") return fail(1, "open_app", "Notepad's document wasn't a new, empty Untitled one, so nothing was typed.");
    audit({ action: "open_app", step: 1, target: "notepad", tier: "local-reversible", approval: "flag", outcome: "step-ok" });

    // 2. Type the note through screen_act's own path (rules → UIA focus → paste → read-back).
    const typed = await screen.act({ goal: `type ${NOTE} in there`, onlyWindow: handle, vision: false }, signal);
    const readBack = await editorText();
    const typedSha256 = await sha256Hex(NOTE);
    if (!typed.ok || sha256OfText(readBack) !== sha256OfText(NOTE)) {
      audit({ action: "type", step: 2, target: "notepad", tier: "local-reversible", approval: "flag", outcome: "step-failed", typedSha256 });
      return { outcome: "failed", said: `Typing wasn't confirmed: ${typed.said}` };
    }
    audit({ action: "type", step: 2, target: "notepad", tier: "local-reversible", approval: "flag", outcome: "step-ok", typedSha256, ms: typed.ms });

    // 3. Save: Ctrl+S → the Save As dialog → file name via UIA (read back) → Enter (approved above).
    const saveKeys = vetAction({ do: "key", keys: "ctrl+s", label: "ctrl+s" }, { focused: null, deny: true, window: win });
    if (!saveKeys.ok) return fail(3, "save", saveKeys.said);
    await hands.keys(handle, "ctrl+s");
    let dialog = null as Awaited<ReturnType<typeof hands.foreground>>;
    for (const until = Date.now() + 8000; Date.now() < until; await sleep(300)) {
      const front = await hands.foreground().catch(() => null);
      if (front && front.cls === "#32770" && /^notepad$/i.test(front.process)) {
        dialog = front;
        break;
      }
    }
    if (!dialog) return fail(3, "save", "The Save As dialog didn't appear, so nothing was saved.");
    // Only a dialog owned by OUR window (never his own Notepad window's).
    const owner = Number((await ps.run(`${WIN32}; [JarvisDemoWin]::Owner(${Math.trunc(dialog.handle)})`, 8000).catch(() => "0")).trim());
    if (owner !== handle) return fail(3, "save", `The Save As dialog isn't owned by the demo's Notepad window (owner ${owner}, ours ${handle}); left alone.`);
    openDialog = dialog.handle;
    await sleep(500);
    // The File name box (Edit 1001) is focused through UIA, then the path goes in as real input
    // (select all, then screen-hands' paste, his clipboard restored): Windows 11's dialog ignores a
    // programmatically set value and would save under its own suggested name instead.
    const found = parseJson(await ps.run(dialogScript(dialog.handle, "focus", FILE), 15_000).catch((e: Error) => JSON.stringify({ error: e.message })));
    console.log(`  save dialog: ${JSON.stringify({ fileBox: found.fileBox, saveButton: found.saveButton, focused: found.focused, error: found.error })}`);
    if (!found.fileBox?.found || !found.focused) return fail(3, "save", `Couldn't focus the File name box (${found.error ?? "not focused"}); nothing was saved.`);
    const box = await hands.focused();
    const typePath = vetAction({ do: "type", text: FILE, field: box }, { focused: box, deny: true, window: dialog });
    if (!typePath.ok) return fail(3, "save", typePath.said);
    // Exercise the public screen_act path, including its focus and exact filename read-back checks.
    const filenameTyped = await screen.act({ goal: `type ${FILE} in there`, onlyWindow: dialog.handle, vision: false }, signal);
    if (!filenameTyped.ok) return fail(3, "save", `screen_act could not verify the File name box: ${filenameTyped.said}`);
    await sleep(300);
    const check = parseJson(await ps.run(dialogScript(dialog.handle, "read", FILE), 15_000).catch((e: Error) => JSON.stringify({ error: e.message })));
    console.log(`  file name box: ${JSON.stringify({ readBackMatches: check.matches === true, error: check.error })}`);
    if (check.matches !== true) return fail(3, "save", `The File name box didn't read back as the target path (${check.error ?? "differs"}); nothing was saved.`);
    if (!found.saveButton || !/^&?save$/i.test(String(found.saveButton.name ?? ""))) return fail(3, "save", `The dialog's button 1 isn't "Save" (${JSON.stringify(found.saveButton ?? null)}); nothing was pressed.`);
    const saveElement = { id: 0, type: "Button", x: 0, y: 0, w: 1, h: 1, password: false, enabled: true, focused: false, hasValue: false, readOnly: false, name: String(found.saveButton.name ?? ""), aid: String(found.saveButton.aid ?? ""), help: "", value: "" };
    const press = vetAction({ do: "click", element: saveElement }, { focused: null, confirmed: saveElement.name, deny: true, window: dialog });
    if (!press.ok) return fail(3, "save", press.said);
    // Press Save: UIA InvokePattern, or BM_CLICK on the classic button (no Enter, no pointer).
    const invoked = parseJson(await ps.run(dialogScript(dialog.handle, "save", FILE), 15_000).catch((e: Error) => JSON.stringify({ error: e.message })));
    console.log(`  save press: ${JSON.stringify({ method: invoked.method, error: invoked.error })}`);
    for (const until = Date.now() + 10_000; !existsSync(FILE) && Date.now() < until; ) await sleep(250);
    const after = await hands.foreground().catch(() => null);
    if (after && after.cls === "#32770") {
      console.log(`  after save: a dialog is in front: "${after.title}"`);
      if (/confirm save as/i.test(after.title)) {
        const declined = parseJson(await ps.run(dialogScript(after.handle, "decline", FILE), 15_000).catch((e: Error) => JSON.stringify({ error: e.message })));
        console.log(`  replace prompt answered No (nothing overwritten): ${JSON.stringify(declined)}`);
        return fail(3, "save", "Windows asked to replace an existing file; answered No, so nothing was overwritten.");
      }
      if (!existsSync(FILE)) return fail(3, "save", `A dialog ("${after.title.slice(0, 60)}") is still up after Save and no file was written; the run stopped.`);
    }
    if (!existsSync(FILE)) return fail(3, "save", "Save was pressed but no file appeared at the target path.");
    openDialog = 0;
    audit({ action: "save", step: 3, target: basename(FILE), tier: risk.tier, approval: "flag", outcome: "step-ok" });

    // 4. Independent verification: the file on disk, not Notepad's "saved" state.
    const verification = await runVerifier(fileContentVerifier({ path: FILE, expectedSha256: sha256OfText(NOTE) }), { timeoutMs: 5000 });
    const outcome = outcomeFrom({ executed: "ok", verification });
    audit({ action: "verify", step: 4, target: basename(FILE), tier: "read-only", approval: "flag", outcome, verifier: verification.verifier, verification: verification.status, ms: verification.ms });
    return { outcome, verification, said: `${outcome}: ${verification.detail}` };
  } finally {
    // A Save As dialog left open is cancelled (Cancel via UIA): that writes nothing.
    if (openDialog) await ps.run(dialogScript(openDialog, "cancel", FILE), 10_000).catch(() => undefined);
    if (handle) {
      // Close only our own window, and only once it's saved (its title names our file). Otherwise it
      // stays open for him to close without saving: never a guess at someone else's window.
      await sleep(500);
      const title = (await hands.windows().catch(() => [])).find((w) => w.handle === handle)?.title ?? "";
      if (title.toLowerCase().startsWith(basename(FILE).toLowerCase()) && existsSync(FILE))
        await ps.run(`${WIN32}; [void][JarvisDemoWin]::PostMessage([IntPtr]${Math.trunc(handle)}, 16, [IntPtr]::Zero, [IntPtr]::Zero); 'ok'`, 10_000).catch(() => undefined);
      else console.log(`  left the demo's Notepad window open ("${title.slice(0, 60)}"): close it without saving.`);
    }
    screen.close();
  }
}

async function main() {
  preview();
  if (DRY_RUN) {
    console.log("\nDry run: nothing executed.");
    return process.exit(auditOk ? 0 : 1);
  }
  if (!APPROVED) {
    audit({ action: "control_pc", target: basename(FILE), tier: risk.tier, approval: "none", outcome: "refused" });
    console.log("\nNot approved: pass --approve (standing in for his spoken yes) to run it. Nothing was done.");
    return process.exit(2);
  }
  const started = Date.now();
  const result = await execute().catch((error: Error) => ({ outcome: "failed" as ControlOutcome, said: `Stopped: ${error.message}` }));
  audit({ action: "control_pc", target: basename(FILE), tier: risk.tier, approval: "flag", outcome: result.outcome, ms: Date.now() - started });
  console.log(`\nOutcome: ${result.outcome.toUpperCase()} — ${result.said}`);
  console.log(`File:    ${FILE}${existsSync(FILE) ? "" : " (not created)"}`);
  console.log(`Audit:   ${AUDIT.dir} (task ${taskId})${auditOk ? "" : " — WRITE FAILED"}`);
  if (existsSync(FILE)) console.log("Clean up by hand once checked (not by voice): delete the file above.");
  process.exit(result.outcome === "success" && auditOk ? 0 : 1);
}

await main();
