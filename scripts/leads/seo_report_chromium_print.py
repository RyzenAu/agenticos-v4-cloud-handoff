"""Prints one self-contained HTML file to PDF using headless Chromium (Playwright).

Runs under D:\\crawl4ai\\venv's own Python -- the only place on this machine that already has the
`playwright` package installed *and* a matching Chromium build (D:\\crawl4ai\\browsers, found via
the PLAYWRIGHT_BROWSERS_PATH env var the caller sets). This is a deliberately tiny, standalone
script rather than adding playwright to jev-seo's venv: jev-seo's venv has no playwright at all,
and picking a playwright pip version there that happens to match the exact Chromium revision
already downloaded on D: is more fragile than reusing an install that's already proven to work.

`prefer_css_page_size` turned out to be enough: this Chromium build already honours jev-seo's
`@page` rules -- named "cover" page with zero margin, the regular pages' 16/15/17/15mm margin, and
the running page-number footer (`counter(page)` / `counter(pages)`) -- without any header/footer
template of our own. (Checked by rendering a sample and inspecting the PDF's own text layer: with
no `prefer_css_page_size` and a manual Playwright footer template added on top, the native
counter and the manual template both rendered, overlapping. Dropping the manual template and
turning this flag on removed the duplicate and reproduced jev-seo's intended layout.)
"""
from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--html", required=True, help="path to the self-contained report HTML to print")
    ap.add_argument("--pdf", required=True, help="path to write the PDF to")
    args = ap.parse_args()

    html_path = Path(args.html).resolve()
    pdf_path = Path(args.pdf).resolve()
    if not html_path.is_file():
        raise SystemExit(f"{html_path} does not exist")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.goto(html_path.as_uri())
            page.wait_for_load_state("networkidle")
            page.emulate_media(media="print")
            page.pdf(
                path=str(pdf_path),
                format="A4",
                print_background=True,
                prefer_css_page_size=True,
            )
        finally:
            browser.close()
    print(f"printed {pdf_path}")


if __name__ == "__main__":
    main()
