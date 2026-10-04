// Shared pieces of the real-desktop acceptance suite (see suite.ts). Rules the code enforces:
// - Every artefact lives under one run folder, D:\tmp\jarvis-acceptance\<run>\ (checked with
//   inScratch and a prefix test); cleanup deletes only task folders inside it, never evidence.
// - Windows: only handles this run opened (a NEW handle that appeared after our own launch) are ever
//   focused, acted on or closed. screen_act always gets onlyWindow. Nothing is force-killed: Notepad,
//   Explorer and Calculator processes are shared with his own windows.
// - Evidence is metadata: SHA-256 hashes, UIA read-back matches, counts, audit lines. The audit log is
//   scanned afterwards for every synthetic plaintext marker the run used; any hit fails the suite.
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { inScratch } from "../../src/lib/control-risk";
import type { RiskTier } from "../../src/lib/control-risk";
import type { AuditEntry, ControlOutcome } from "../../src/lib/control-outcome";

export const ACCEPTANCE_ROOT = String.raw`D:\tmp\jarvis-acceptance`;
const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "garnet", "harbour", "iris", "juniper", "kestrel", "lantern", "meadow", "nectar", "orchid", "pebble", "quartz", "saffron", "tidal", "willow"];
/** Words only: long digit runs look like codes to the typing guard (correctly), so ids are words. */
export const word = () => WORDS[randomInt(WORDS.length)];
export const runName = () => `run-${word()}-${word()}-${word()}`;
export const sha256 = (text: string) => createHash("sha256").update(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), "utf8").digest("hex");

/** Is `path` strictly inside `dir` (after resolving)? Pure. */
export function inside(dir: string, path: string) {
  const d = resolve(dir).toLowerCase() + sep;
  return resolve(path).toLowerCase().startsWith(d);
}
/** The run folder, refusing anything outside the acceptance root or the scratch roots. */
export function runDir(name: string, root = ACCEPTANCE_ROOT) {
  if (!/^run-[a-z]+(?:-[a-z]+){1,4}$/.test(name)) throw new Error("Not a run name.");
  const dir = join(root, name);
  if (!inScratch(dir + "\\") && !inside(root, dir)) throw new Error("The run folder must be under D:\\tmp.");
  return dir;
}
/**
 * Delete one task folder, only when it is inside the run folder, not the evidence folder, and not a
 * junction or symlink (never recurse through a junction).
 */
export function removeTaskDir(run: string, dir: string): boolean {
  if (!inside(run, dir) || resolve(dir).toLowerCase() === resolve(run, "_evidence").toLowerCase() || inside(join(run, "_evidence"), dir)) return false;
  if (!existsSync(dir)) return true;
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink()) return false;
  const walk = (d: string): boolean => readdirSync(d, { withFileTypes: true }).every((e) => (e.isSymbolicLink() ? false : e.isDirectory() ? walk(join(d, e.name)) : true));
  if (!walk(dir)) return false;
  rmSync(dir, { recursive: true, force: false });
  return !existsSync(dir);
}

export type TaskStatus = "pass" | "fail" | "skipped";
export type Check = { name: string; ok: boolean; evidence: string };
export type TaskResult = {
  id: string;
  title: string;
  status: TaskStatus;
  outcome: ControlOutcome | "refused" | "n/a";
  checks: Check[];
  ms: number;
  cleanup: string[];
  note?: string;
};
export type TaskPlan = { id: string; title: string; tier: RiskTier; steps: string[]; pass: string[]; cleanup: string[] };

/** Scan audit files for synthetic plaintext markers: every match is a leak. */
export function scanForMarkers(files: string[], markers: string[]) {
  const hits: Array<{ file: string; marker: string }> = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of markers) if (m.length >= 4 && text.includes(m)) hits.push({ file: f.split(/[\\/]/).pop() ?? f, marker: `${m.slice(0, 3)}…(${m.length} chars)` });
  }
  return hits;
}

/** The audit lines for one task id (for the report: counts and actions, never content). */
export const auditSummary = (entries: AuditEntry[], taskId: string) =>
  entries.filter((e) => e.taskId === taskId).map((e) => `${e.action}${e.step !== undefined ? `#${e.step}` : ""}:${e.outcome}${e.executor ? `/${e.executor}` : ""}${e.verification ? `/${e.verification}` : ""}`);

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** PowerShell (fixed templates; handles are validated integers) for independent reads. */
export const PS = {
  /** The Document/Edit text of ONE window (by handle), never the focused element of whatever is in front. */
  editorText: (handle: number) =>
    `$w = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Math.trunc(handle)}); ` +
    `$c = New-Object System.Windows.Automation.OrCondition((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)), (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))); ` +
    `$d = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c); $o = $null; ` +
    `if ($d -and $d.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$o)) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($o.DocumentRange.GetText(20000))) } else { 'NOTEXT' }`,
  /** How many tabs ONE window has (names never read). */
  tabCount: (handle: number) =>
    `$w = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Math.trunc(handle)}); ` +
    "$w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem))).Count",
  /** Windows Calculator's display, by AutomationId, in ONE window. */
  calculatorDisplay: (handle: number) =>
    `$w = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Math.trunc(handle)}); ` +
    `$r = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'CalculatorResults'))); ` +
    `if ($r) { $r.Current.Name } else { 'NODISPLAY' }`,
  /**
   * Close one window through UIA WindowPattern.Close (the title bar's X). A polite close: an unsaved
   * document asks, nothing is forced. (Windows 11 Notepad ignores posted WM_CLOSE / SC_CLOSE.)
   */
  close: (handle: number) =>
    `$w = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Math.trunc(handle)}); $p = $null; ` +
    `if ($w -and $w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$p)) { $p.Close(); 'closed' } else { 'nopattern' }`,
};
