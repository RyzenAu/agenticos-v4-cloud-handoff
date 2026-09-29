"""Rebuild every deliverable and its renders. Needs Windows with Microsoft Word and PowerPoint,
pywin32 and PyMuPDF. Run the catalogue exporter first so the JSON inputs are current:
    bun scripts/export-receptionist-catalogue.ts
    python docs/sales/receptionist-pack-2026-09-28/build/build_all.py
    python docs/sales/receptionist-pack-2026-09-28/build/check_catalogue.py
Renders are rebuilt from scratch: old PNGs for each document are removed first, so a document
that loses a page never leaves a stale page image behind.
"""
import runpy, pathlib, sys
here = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(here))
from common import RENDERS

PREFIXES = {"build_proposal": ["proposal-template"], "build_agreement": ["service-agreement-draft"],
            "build_onepagers": ["demo-guide", "client-setup-checklist"], "build_sales_deck": ["sales-presentation"],
            "build_onboarding_deck": ["onboarding-deck"], "build_forwarding_guide": ["call-forwarding-guide"]}

print("== build_markdown")
runpy.run_path(str(here / "build_markdown.py"), run_name="__main__")
for name in ("build_proposal", "build_agreement", "build_onepagers", "build_sales_deck", "build_onboarding_deck", "build_forwarding_guide"):
    for prefix in PREFIXES[name]:
        for old in RENDERS.glob(f"{prefix}-[0-9][0-9].png"):
            old.unlink()
    print("==", name)
    runpy.run_path(str(here / f"{name}.py"), run_name="__main__")
