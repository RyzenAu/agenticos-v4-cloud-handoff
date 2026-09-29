// Direct routes for everyday file and Office jobs (25 Sep, round 4 of the end-to-end suite: each of
// these went to Hermes and took 30-90 s, asked for approval, or failed):
//
// - "zip the X folder in my Downloads" → X.zip beside it (never over an existing file);
// - "copy report.txt from the X folder in my Downloads to my Documents", "move notes.txt … to my
//   Desktop" (never over an existing file; only his Desktop, Documents, Downloads, Pictures);
// - "save report.txt in my X folder as a PDF" (Edge prints it, headless, with a throwaway profile);
// - "take a screenshot" → Pictures\Screenshots\Screenshot <date time>.png (all screens, saved
//   locally, nothing sent anywhere);
// - Office, on the document in front: "put the total of the Sales column in the cell under it"
//   (Excel: a SUM formula, only into an empty cell) and "make the first line bold" (Word: undoable
//   with Ctrl+Z), through Office's own automation.
//
// Safety: nothing is deleted or overwritten; paths are resolved under his home folders only.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PsHost } from "./ps-host";
import { psText } from "./ps-host";
import { norm } from "./text";
import { placeFromWords, resolvePlace, spokenPlace } from "./places";

export type FileJobRequest =
  | { skill: "filejob"; action: "zip"; folder: string }
  | { skill: "filejob"; action: "copy" | "move"; file: string; from: string; to: string }
  | { skill: "filejob"; action: "pdf"; file: string; from: string }
  | { skill: "filejob"; action: "screenshot"; to?: string }
  | { skill: "filejob"; action: "excel_sum"; column: string }
  | { skill: "filejob"; action: "word_format"; which: "first" | "last"; style: "bold" | "italic" | "underline" };

/**
 * PowerShell that sets $x to the Excel in front: through its sheet window's accessible object
 * (Excel registers for GetActiveObject only after it first loses focus, so a just-opened workbook
 * isn't there yet: 25 Sep suite), then GetActiveObject as the fallback.
 */
export const EXCEL_APP_PS = [
  "if (-not ('JarvisXl' -as [type])) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class JarvisXl { [DllImport(\"user32.dll\")] static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport(\"oleacc.dll\")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IDispatch)] out object o); public static object App() { var fg = GetForegroundWindow(); var c = new StringBuilder(64); GetClassName(fg, c, 64); if (c.ToString() != \"XLMAIN\") return null; var desk = FindWindowEx(fg, IntPtr.Zero, \"XLDESK\", null); if (desk == IntPtr.Zero) return null; var sheet = FindWindowEx(desk, IntPtr.Zero, \"EXCEL7\", null); if (sheet == IntPtr.Zero) return null; var g = new Guid(\"00020400-0000-0000-C000-000000000046\"); object o; if (AccessibleObjectFromWindow(sheet, 0xFFFFFFF0, ref g, out o) != 0 || o == null) return null; return o.GetType().InvokeMember(\"Application\", System.Reflection.BindingFlags.GetProperty, null, o, null); } }' };",
  "$x = $null; try { $x = [JarvisXl]::App() } catch {}; if (-not $x) { try { $x = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') } catch {} };",
].join(" ");

/** Kept for callers of the old name: a place from his words (see places.ts). */
export const homePlace = placeFromWords;
const HOME: Record<string, string> = { downloads: "Downloads", desktop: "Desktop", documents: "Documents", pictures: "Pictures" };
const NAME = /^[\w][\w .()&+,'-]{0,80}$/;

export function fileJobIntent(utterance: string): FileJobRequest | null {
  const u = utterance.trim().replace(/[.!?]+$/, "").replace(/^(?:(?:hey\s+)?jarvis[,\s]+)?(?:can you|could you|please)\s+/i, "");
  if (!u || u.length > 200) return null;
  let m = u.match(/^(?:zip|compress)(?: up)? (?:the |my )?(.+?)(?: folder)?(?: (?:in|inside|on) (?:my |the )?(downloads|desktop|documents|pictures|d:[\\/]tmp\S*))?(?: (?:into|to) a zip(?: file)?)?$/i);
  if (m && !/\bfile\b/i.test(m[1])) {
    const place = m[2] ? placeFromWords(`${m[1]} in ${m[2]}`) : placeFromWords(m[1]);
    if (place && place.includes("/") && place !== "D:/tmp") return { skill: "filejob", action: "zip", folder: place };
  }
  m = u.match(/^(copy|move) ["“]?([\w .()&+,'-]+\.[a-z0-9]{1,5})["”]? from (?:the |my )?(.+?) to (?:the |my )?(desktop|documents|downloads|pictures|d:[\\/]tmp\S*)(?: folder)?$/i);
  if (m) {
    const from = placeFromWords(m[3]);
    const to = HOME[m[4].toLowerCase()] ?? placeFromWords(m[4]);
    if (from && to && NAME.test(m[2])) return { skill: "filejob", action: m[1].toLowerCase() as "copy" | "move", file: m[2], from, to };
  }
  m = u.match(/^(?:save|export|convert|turn|print) ["“]?([\w .()&+,'-]+\.(?:txt|html?|md|png|jpe?g))["”]? (?:in|from) (?:the |my )?(.+?) (?:as|to|into) (?:a )?pdf$/i);
  if (m) {
    const from = placeFromWords(m[2]);
    if (from && NAME.test(m[1])) return { skill: "filejob", action: "pdf", file: m[1], from };
  }
  if (/^(?:take|grab|capture|snap) (?:a |me a )?(?:screenshot|screen shot|screen grab|screen capture)(?: of (?:my|the) (?:whole )?screens?)?$|^screenshot(?: please)?$/i.test(u)) return { skill: "filejob", action: "screenshot" };
  m = u.match(/^(?:take|grab|capture|snap) (?:a |me a )?(?:screenshot|screen shot|screen grab) and (?:save|put|keep) it (?:in|to|into) (?:the |my )?(.+)$/i);
  if (m) {
    const to = placeFromWords(m[1]);
    if (to) return { skill: "filejob", action: "screenshot", to };
  }
  m = u.match(/^(?:put|add|write|show|give me) (?:the )?(?:total|sum) of (?:the )?(.+?) column (?:in|into|at) (?:the )?(?:cell |row )?(?:under|below|beneath) (?:it|that|the column|them)$|^(?:sum|total)(?: up)? (?:the )?(.+?) column$/i);
  if (m) return { skill: "filejob", action: "excel_sum", column: (m[1] ?? m[2]).trim().slice(0, 60) };
  m = norm(u).match(/^(?:make|set|turn|format) (?:the )?(first|last|top|bottom) (?:line|paragraph|heading|title) (bold|italic|italics|underlined|underline)$|^(bold|italicise|italicize|underline) (?:the )?(first|last|top|bottom) (?:line|paragraph|heading|title)$/);
  if (m) {
    const which = /^(?:first|top)$/.test(m[1] ?? m[4]) ? "first" : "last";
    const w = m[2] ?? m[3];
    const style = /^bold/.test(w) ? "bold" : /^ital/.test(w) ? "italic" : "underline";
    return { skill: "filejob", action: "word_format", which, style };
  }
  return null;
}

// --- answers -----------------------------------------------------------------------------------
const within = (home: string, rel: string, workRoot?: string) => resolvePlace(rel, home, workRoot);
const nice = spokenPlace;
/** "report.pdf", or "report (2).pdf" when that's taken. */
function freeName(dir: string, name: string) {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  let n = 1, out = name;
  while (existsSync(join(dir, out))) out = `${stem} (${++n})${ext}`;
  return out;
}
const run = (file: string, args: string[], ms: number) =>
  new Promise<{ ok: boolean; out: string }>((done) => execFile(file, args, { windowsHide: true, timeout: ms }, (e, stdout, stderr) => done({ ok: !e, out: `${stdout}${stderr}` })));

export async function answerFileJob(req: FileJobRequest, deps: { ps: PsHost; home?: string; edge?: string; workRoot?: string }): Promise<string> {
  const home = deps.home ?? homedir();
  const within_ = (rel: string) => within(home, rel, deps.workRoot);
  switch (req.action) {
    case "zip": {
      const folder = within_(req.folder);
      if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) return `I can't find a ${nice(req.folder)} folder, sir.`;
      const zip = join(dirname(folder), freeName(dirname(folder), `${basename(folder)}.zip`));
      const out = (await deps.ps.run(`Compress-Archive -LiteralPath ${psText(folder)} -DestinationPath ${psText(zip)} -CompressionLevel Optimal; if (Test-Path -LiteralPath ${psText(zip)}) { 'OK' } else { 'NO' }`, 120_000)).trim();
      if (out !== "OK") throw new Error("Windows didn't make the zip");
      return `Zipped it to ${basename(zip)} in ${nice(req.folder.split("/").slice(0, -1).join("/") || req.folder)}, sir.`;
    }
    case "copy":
    case "move": {
      const fromDir = within_(req.from);
      const toDir = within_(req.to);
      if (!fromDir || !toDir) return "I only move files between your home folders, sir.";
      const src = join(fromDir, req.file);
      if (!existsSync(src) || !statSync(src).isFile()) return `I can't find ${req.file} in ${nice(req.from)}, sir.`;
      const dst = join(toDir, req.file);
      if (existsSync(dst)) return `There's already a ${req.file} in ${nice(req.to)}, sir, so I left both alone.`;
      mkdirSync(toDir, { recursive: true });
      if (req.action === "copy") copyFileSync(src, dst);
      else renameSync(src, dst);
      return `${req.action === "copy" ? "Copied" : "Moved"} ${req.file} to ${nice(req.to)}, sir.`;
    }
    case "pdf": {
      const fromDir = within_(req.from);
      const src = fromDir ? join(fromDir, req.file) : null;
      if (!fromDir || !src || !existsSync(src)) return `I can't find ${req.file} in ${nice(req.from)}, sir.`;
      const out = join(fromDir, freeName(fromDir, `${req.file.slice(0, req.file.length - extname(req.file).length)}.pdf`));
      const edge = deps.edge ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
      const profile = join(tmpdir(), `jarvis-pdf-${Date.now().toString(36)}`);
      await run(edge, [`--user-data-dir=${profile}`, "--headless", "--disable-gpu", "--no-first-run", "--no-pdf-header-footer", `--print-to-pdf=${out}`, pathToFileURL(src).href], 60_000);
      rmSync(profile, { recursive: true, force: true });
      if (!existsSync(out)) throw new Error("Edge didn't print it");
      return `Saved it as ${basename(out)}, next to the original, sir.`;
    }
    case "screenshot": {
      const dir = req.to ? within_(req.to) : join(home, "Pictures", "Screenshots");
      if (!dir) return "I can only save screenshots in your folders or D:\\tmp, sir.";
      mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const file = join(dir, freeName(dir, `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`));
      const out = (
        await deps.ps.run(
          // Every screen, in physical pixels (a screen at 150% or left of the main one included).
          `Add-Type -AssemblyName System.Drawing; [JarvisWin]::PerMonitorDpi(); $v = [System.Windows.Forms.SystemInformation]::VirtualScreen; $b = New-Object System.Drawing.Bitmap $v.Width, $v.Height; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($v.Left, $v.Top, 0, 0, $b.Size); $b.Save(${psText(file)}, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose(); 'OK'`,
          20_000,
        )
      ).trim();
      if (out !== "OK" || !existsSync(file)) throw new Error("the screenshot didn't save");
      return `Screenshot saved in ${req.to ? nice(req.to) : "Pictures, Screenshots"}, sir.`;
    }
    case "excel_sum": {
      const out = (
        await deps.ps.run(
          `${EXCEL_APP_PS} if (-not $x -or -not $x.ActiveSheet) { 'NOEXCEL' } else { $s = $x.ActiveSheet; $u = $s.UsedRange; $want = ${psText(req.column)}.ToLower(); $col = 0; for ($c = 1; $c -le $u.Columns.Count; $c++) { $h = [string]$s.Cells.Item($u.Row, $u.Column + $c - 1).Text; if ($h.Trim().ToLower() -eq $want) { $col = $u.Column + $c - 1; break } }; if ($col -eq 0) { 'NOCOL' } else { $last = $s.Cells.Item($s.Rows.Count, $col).End(-4162).Row; $cell = $s.Cells.Item($last + 1, $col); if ([string]$cell.Formula -ne '') { 'NOTEMPTY' } else { $top = $s.Cells.Item($u.Row + 1, $col).Address($false, $false); $bottom = $s.Cells.Item($last, $col).Address($false, $false); $cell.Formula = "=SUM($top" + ":" + "$bottom)"; 'OK ' + $cell.Address($false, $false) + ' ' + [string]$cell.Value2 } } }`,
          20_000,
        )
      ).trim();
      if (out === "NOEXCEL") return "Open the spreadsheet in Excel first, sir.";
      if (out === "NOCOL") return `I can't see a ${req.column} column on this sheet, sir.`;
      if (out === "NOTEMPTY") return "The cell under that column isn't empty, sir, so I left it alone.";
      const m = out.match(/^OK (\S+) (.*)$/);
      if (!m) throw new Error("Excel didn't take the formula");
      return `Put the total in ${m[1]}: ${Number(m[2]).toLocaleString("en-AU")}, sir.`;
    }
    case "word_format": {
      const prop = req.style === "bold" ? "Bold" : req.style === "italic" ? "Italic" : "Underline";
      const out = (
        await deps.ps.run(
          `try { $w = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') } catch { $w = $null }; if (-not $w -or $w.Documents.Count -eq 0) { 'NOWORD' } else { $d = $w.ActiveDocument; $n = $d.Paragraphs.Count; $i = ${req.which === "first" ? "1" : "$n"}; for ($k = 0; $k -lt $n -and [string]::IsNullOrWhiteSpace($d.Paragraphs.Item($i).Range.Text); $k++) { $i = $i ${req.which === "first" ? "+" : "-"} 1 }; $r = $d.Paragraphs.Item($i).Range; $r.${prop} = 1; 'OK ' + [string]$r.${prop} }`,
          20_000,
        )
      ).trim();
      if (out === "NOWORD") return "Open the document in Word first, sir.";
      if (!/^OK -?1$/.test(out)) throw new Error("Word didn't take the formatting");
      return `Made the ${req.which} line ${req.style === "underline" ? "underlined" : req.style}, sir. Ctrl+Z undoes it.`;
    }
  }
}
