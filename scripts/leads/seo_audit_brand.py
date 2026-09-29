"""Prepends a simple M&U Ventures cover page to a jev-seo PDF report, in place.

jev-seo (github.com/AgriciDaniel/jev-seo, MIT) has no built-in white-label/theming hook -- checked
its CLI, templates and docs for brand/theme/logo/footer options and found none. This adds a plain
one-page cover using matplotlib (already one of jev-seo's own dependencies, so nothing extra to
install) and merges it in front of the existing report with pypdf. It never touches jev-seo's own
scoring, findings or caveats: the same honest limit -- scores rank work, they don't predict search
rankings -- is repeated on the cover rather than hidden behind branding.

Run from the same venv that has jev-seo installed (it needs matplotlib) plus pypdf:
    python -m jevseo ...          # or wherever jevseo itself is invoked from
    python seo_audit_brand.py --pdf <report.pdf> --domain example.com --overall 60 --grade C
"""
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path


def build_cover(path: Path, business: str, domain: str, overall: int | None, grade: str | None, contact: str) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(8.27, 11.69))  # A4 portrait -- matches jev-seo's own report page size
    fig.patch.set_facecolor("white")
    ax = fig.add_axes((0, 0, 1, 1))
    ax.axis("off")
    ax.text(0.5, 0.72, "SEO Audit", ha="center", va="center", fontsize=34, fontweight="bold")
    ax.text(0.5, 0.65, domain, ha="center", va="center", fontsize=20, color="#333333")
    if overall is not None:
        score_line = f"Overall score: {overall}/100" + (f" (grade {grade})" if grade else "")
        ax.text(0.5, 0.56, score_line, ha="center", va="center", fontsize=14)
    ax.text(0.5, 0.42, f"Prepared by {business}", ha="center", va="center", fontsize=16, fontweight="bold")
    ax.text(0.5, 0.385, contact, ha="center", va="center", fontsize=11, color="#333333")
    ax.text(0.5, 0.34, datetime.now().strftime("%d %B %Y"), ha="center", va="center", fontsize=10, color="#666666")
    ax.text(
        0.5, 0.12,
        "Scores rank work to do against Google's own guidance and Core Web Vitals thresholds.\n"
        "They are not a prediction of search rankings.",
        ha="center", va="center", fontsize=9, color="#666666",
    )
    fig.savefig(path, format="pdf")
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="the jev-seo report.pdf to brand, in place")
    ap.add_argument("--business", default="M&U Ventures")
    ap.add_argument("--domain", required=True)
    ap.add_argument("--contact", default="muventures.com.au · muventuresau@muventures.com.au")
    ap.add_argument("--overall", type=int, default=None)
    ap.add_argument("--grade", default=None)
    args = ap.parse_args()

    from pypdf import PdfWriter

    report = Path(args.pdf)
    if not report.is_file():
        raise SystemExit(f"{report} does not exist -- nothing to brand")
    cover = report.with_name("_cover.pdf")
    build_cover(cover, args.business, args.domain, args.overall, args.grade, args.contact)

    writer = PdfWriter()
    writer.append(str(cover))
    writer.append(str(report))
    branded = report.with_name("_branded.pdf")
    with open(branded, "wb") as f:
        writer.write(f)
    writer.close()
    branded.replace(report)
    cover.unlink(missing_ok=True)
    print(f"branded {report}")


if __name__ == "__main__":
    main()
