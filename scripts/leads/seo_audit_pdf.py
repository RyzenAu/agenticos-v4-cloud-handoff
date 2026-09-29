"""Builds report.pdf for a jev-seo SEO audit using jev-seo's own HTML report template, printed by
headless Chromium instead of WeasyPrint.

Why: jev-seo's own PDF path (jevseo.report.pdf.write_pdf) needs WeasyPrint, and WeasyPrint needs
GTK/Pango/Cairo system libraries this Windows machine doesn't have. We don't install system-wide
libraries or change PATH to get them (see AGENTS.md) -- so seo-audit.ts runs jev-seo with
--formats xlsx,md only, and this script fills in report.pdf afterwards, separately.

How: this never modifies jev-seo's pinned source at D:\\jev-seo\\src. It imports jev-seo's own
`report.view_model()` / `report.pdf.render_html()` (unmodified) to build the exact same HTML
WeasyPrint would have received -- jev-seo bakes its charts in as inline SVG and its fonts as
file:// @font-face rules, so that HTML is already self-contained and needs no extra assets to print
correctly, including its `@page` rules (named "cover" page with zero margin, running header/footer
with a page counter): the Chromium build vendored at D:\\crawl4ai\\browsers turned out to already
support enough of CSS Paged Media (via Playwright's `prefer_css_page_size`) to honour those
directly, so this script hands jev-seo's HTML over completely unmodified. (Its only known gap is
the footer's `string(domain)` running text, which Chromium silently drops -- a cosmetic difference
from WeasyPrint's output, not worth fighting given the domain already headlines the cover page.)
That HTML is handed to a *second* Python interpreter -- D:\\crawl4ai\\venv's own Python, which
already has the `playwright` package and that Chromium build -- to print it to PDF (see
seo_report_chromium_print.py). Two interpreters because jev-seo's venv has jinja2/matplotlib but no
playwright, and reusing an existing, working Playwright install beats adding a new dependency to
the pinned jev-seo venv.

Finally, when a report.pdf exists, seo-audit.ts's own branding step
(scripts/leads/seo_audit_brand.py) prepends the M&U cover page exactly as it already did for a
WeasyPrint-built PDF -- unchanged, and not this script's job.

Usage, run under jev-seo's own venv (it needs jevseo, jinja2 and matplotlib importable):
    D:\\jev-seo\\venv\\Scripts\\python.exe scripts\\leads\\seo_audit_pdf.py --dir <audit-dir>

Regenerating a PDF for an already-completed audit needs no re-crawl -- this only reads the audit
folder's existing audit.json (and narrative.json, if a lead agent wrote one) and writes
report.html / report.pdf next to it. If the folder already has a run.json (written by a previous
live run), its recorded files.pdf is flipped to true so the lead drawer's "Open PDF" appears
without re-running the whole audit.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# jevseo.report.pdf.context() reads report.css with Path.read_text() and no explicit encoding --
# on a plain Windows install that defaults to the system codepage (cp1252), not UTF-8, and the CSS
# has a UTF-8 character (a middle dot) that codepage can't decode. Not our file to fix (pinned jev-
# seo source), and every other workaround (chcp, PYTHONIOENCODING) leaves pathlib's own default
# alone -- only Python's UTF-8 mode changes that, and it must be active before the interpreter
# reads anything, so re-launch once with it forced on rather than asking every caller to remember
# `PYTHONUTF8=1`. A plain re-exec (os.execv) is flaky for a path with spaces under Windows/Git
# Bash in practice, so this re-spawns and forwards the exit code instead.
if not sys.flags.utf8_mode:
    _r = subprocess.run([sys.executable, "-X", "utf8", __file__, *sys.argv[1:]], env={**os.environ, "PYTHONUTF8": "1"})
    sys.exit(_r.returncode)

JEV_SEO_SRC = os.environ.get("JEV_SEO_SRC", r"D:\jev-seo\src")
CRAWL4AI_PYTHON = os.environ.get("CRAWL4AI_PYTHON", r"D:\crawl4ai\venv\Scripts\python.exe")
PLAYWRIGHT_BROWSERS_PATH = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", r"D:\crawl4ai\browsers")
CHROMIUM_PRINTER = Path(__file__).resolve().parent / "seo_report_chromium_print.py"


def build_html(folder: Path) -> Path:
    """Reuses jev-seo's own view model + HTML renderer (unmodified) so the PDF matches exactly
    what report.md / report.xlsx already show for the same audit.json -- same numbers, same
    wording, same findings."""
    if JEV_SEO_SRC not in sys.path:
        sys.path.insert(0, JEV_SEO_SRC)
    from jevseo.report import view_model  # type: ignore
    from jevseo.report.pdf import render_html  # type: ignore

    data = json.loads((folder / "audit.json").read_text(encoding="utf-8"))
    vm = view_model(data, folder)
    html = render_html(vm)
    html_path = folder / "report.html"
    html_path.write_text(html, encoding="utf-8")
    return html_path


def print_pdf(html_path: Path, pdf_path: Path) -> None:
    if not Path(CRAWL4AI_PYTHON).is_file():
        raise SystemExit(f"Chromium's Python isn't at {CRAWL4AI_PYTHON} -- set CRAWL4AI_PYTHON if it moved.")
    if not CHROMIUM_PRINTER.is_file():
        raise SystemExit(f"Missing {CHROMIUM_PRINTER}")
    env = {**os.environ, "PLAYWRIGHT_BROWSERS_PATH": PLAYWRIGHT_BROWSERS_PATH}
    result = subprocess.run(
        [CRAWL4AI_PYTHON, str(CHROMIUM_PRINTER), "--html", str(html_path), "--pdf", str(pdf_path)],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise SystemExit(f"Chromium PDF print failed (exit {result.returncode}): {tail}")


def mark_run_json(folder: Path) -> None:
    """Best-effort: flips files.pdf in an already-written run.json to true. A live seo-audit.ts run
    recomputes this itself right after calling this script, so this only matters when regenerating
    a PDF for an audit that already finished (no re-crawl involved)."""
    run_json = folder / "run.json"
    if not run_json.is_file():
        return
    try:
        record = json.loads(run_json.read_text(encoding="utf-8"))
        record.setdefault("files", {})["pdf"] = True
        run_json.write_text(json.dumps(record, indent=2), encoding="utf-8")
    except Exception:
        pass  # cosmetic status file only -- never fail the PDF build over it


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="the audit folder (.operator-data/seo-audits/<leadId>) -- must already have audit.json")
    args = ap.parse_args()
    folder = Path(args.dir)
    if not (folder / "audit.json").is_file():
        raise SystemExit(f"{folder} has no audit.json -- run the audit first.")

    html_path = build_html(folder)
    pdf_path = folder / "report.pdf"
    print_pdf(html_path, pdf_path)
    if not pdf_path.is_file():
        raise SystemExit("Chromium reported success but wrote no report.pdf.")
    mark_run_json(folder)
    print(f"wrote {pdf_path}")


if __name__ == "__main__":
    main()
