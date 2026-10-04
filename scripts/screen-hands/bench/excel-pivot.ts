// A throwaway Excel workbook with a PivotTable, for teaching and benchmarking drags in Excel's real
// PivotTable Fields pane (scripts/screen-hands/teach-demo.ts pivot). Only when Excel isn't running
// (his workbooks are never touched): Excel is started through its automation with a NEW, unsaved
// workbook (so his recent files don't change), the sample data and an empty PivotTable are made,
// and a cell in it is selected so the Fields pane shows. close() quits it without saving.
import type { PsHost } from "../../jarvis-skills/ps-host";

export type PivotLayout = { rows: string[]; values: string[]; filters: string[]; columns: string[] };
export type ExcelPivot = {
  hwnd: number;
  close(): Promise<void>;
  layout(): Promise<PivotLayout>;
  /** Every field back out of the areas (between benchmark tasks). */
  reset(): Promise<void>;
};

const ROWS = [
  ["Region", "Product", "Sales"],
  ["North", "Websites", 4200],
  ["South", "Websites", 3100],
  ["North", "Receptionist", 2600],
  ["South", "Receptionist", 1800],
  ["East", "Automation", 3900],
  ["West", "Automation", 1500],
];

const DIR = String.raw`D:\tmp\jarvis-pivot`;
const FILE = (stamp: number) => String.raw`${DIR}\jarvis-pivot-${stamp}.xlsx`;

export async function openExcelPivot(ps: PsHost): Promise<ExcelPivot | { skip: string }> {
  const stamp = Date.now();
  if (Number((await ps.run("@(Get-Process EXCEL -ErrorAction SilentlyContinue).Count", 10_000)).trim()) > 0) return { skip: "Excel is already running (his)" };
  const cells = ROWS.map((r, i) => r.map((v, j) => `$s.Cells.Item(${i + 1}, ${j + 1}).Value2 = ${typeof v === "number" ? v : `'${v}'`}`).join("; ")).join("; ");
  const out = (
    await ps.run(
      [
        "$global:JarvisPivotXl = New-Object -ComObject Excel.Application",
        "$x = $global:JarvisPivotXl; $x.Visible = $true; $x.DisplayAlerts = $false",
        "$wb = $x.Workbooks.Add(); $s = $wb.Worksheets.Item(1); $s.Name = 'Data'",
        cells,
        `$pc = $wb.PivotCaches().Create(1, $s.Range('A1:C${ROWS.length}'))`,
        "$ps2 = $wb.Worksheets.Add(); $ps2.Name = 'Pivot'",
        "$pt = $pc.CreatePivotTable($ps2.Range('A3'), 'JarvisPivot')",
        // Saved as a throwaway file under D:\tmp, kept out of his recent files (AddToMru false).
        `New-Item -ItemType Directory -Force '${DIR}' | Out-Null; $m = [Type]::Missing; try { $wb.SaveAs('${FILE(stamp)}', 51, $m, $m, $m, $m, 1, 2, $false) } catch {}`,
        "$ps2.Activate(); $ps2.Range('A3').Select(); $x.WindowState = -4137",
        "$x.UserControl = $true",
        "[string]$x.Hwnd",
      ].join("; "),
      60_000,
    )
  ).trim();
  const hwnd = Number(out.split(/\s+/).pop());
  if (!hwnd) {
    // Whatever Excel this started goes again (none was running before).
    await ps.run("try { $global:JarvisPivotXl.DisplayAlerts = $false; $global:JarvisPivotXl.Quit() } catch {}; Start-Sleep -Seconds 2; Get-Process EXCEL -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-3) } | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'", 30_000).catch(() => undefined);
    return { skip: `Excel didn't make the PivotTable (${out.slice(0, 120)})` };
  }
  const pid = Number((await ps.run(`[JarvisScreen]::Pid(${hwnd})`, 10_000).catch(() => "0")).trim()) || 0;
  return {
    hwnd,
    layout: async () => {
      const o = (
        await ps.run(
          "$pt = $global:JarvisPivotXl.ActiveWorkbook.Worksheets.Item('Pivot').PivotTables('JarvisPivot'); function N($c, $p) { $o = @(); for ($i = 1; $i -le $c.Count; $i++) { $o += [string]$c.Item($i).$p }; $o -join ',' }; 'rows=' + (N $pt.RowFields 'Name') + ';values=' + (N $pt.DataFields 'SourceName') + ';filters=' + (N $pt.PageFields 'Name') + ';columns=' + ((N $pt.ColumnFields 'Name').Split(',') | Where-Object { $_ -and $_ -ne 'Data' -and $_ -ne 'Values' }) -join ','",
          20_000,
        )
      ).trim();
      const part = (k: string) => (o.match(new RegExp(`${k}=([^;]*)`))?.[1] ?? "").split(",").filter(Boolean);
      return { rows: part("rows"), values: part("values"), filters: part("filters"), columns: part("columns") };
    },
    reset: async () => {
      await ps.run(
        "$pt = $global:JarvisPivotXl.ActiveWorkbook.Worksheets.Item('Pivot').PivotTables('JarvisPivot'); foreach ($d in @($pt.DataFields)) { try { $d.Orientation = 0 } catch {} }; for ($i = 1; $i -le $pt.PivotFields().Count; $i++) { $f = $pt.PivotFields().Item($i); try { if ($f.Orientation -ne 0) { $f.Orientation = 0 } } catch {} }; $global:JarvisPivotXl.ActiveWorkbook.Worksheets.Item('Pivot').Range('A3').Select(); 'ok'",
        20_000,
      );
    },
    close: async () => {
      await ps.run("try { $x = $global:JarvisPivotXl; $x.DisplayAlerts = $false; foreach ($w in @($x.Workbooks)) { $w.Close($false) }; $x.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($x) } catch {}; $global:JarvisPivotXl = $null; 'ok'", 30_000).catch(() => undefined);
      // The Excel we started (Excel wasn't running before): gone within 8 s, or stopped.
      for (let i = 0; i < 16 && pid; i++) {
        if ((await ps.run(`@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`, 5000).catch(() => "0")).trim() === "0") return;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (pid) await ps.run(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; 'ok'`, 10_000).catch(() => undefined);
      await ps.run(`Remove-Item -LiteralPath '${FILE(stamp)}' -Force -ErrorAction SilentlyContinue; 'ok'`, 10_000).catch(() => undefined);
    },
  };
}
