"""Shared helpers for the receptionist sales pack builders.

Numbers come only from the generated JSON exports (catalogue + economics), never typed by hand.
Office rendering uses the locally installed Word / PowerPoint through COM (pywin32); PDFs are
rasterised with PyMuPDF for visual inspection.
"""
import json
import os
import pathlib
import time

HERE = pathlib.Path(__file__).resolve().parent
PACK = HERE.parent                      # docs/sales/receptionist-pack-2026-09-28
DOCS = PACK.parent.parent                # docs/
RENDERS = PACK / "renders"

CATALOGUE = json.loads((DOCS / "receptionist-package-catalogue.json").read_text(encoding="utf-8"))
ECONOMICS = json.loads((PACK / "package-economics.json").read_text(encoding="utf-8"))
FIXTURE = json.loads((DOCS / "receptionist-consistency-fixture.json").read_text(encoding="utf-8"))
PACKAGES = CATALOGUE["packages"]
TIER_NAMES = ("Essential", "Professional", "Premium")
AS_OF = "28 September 2026"

# GST: M&U is GST registered (catalogue gstBasis), so 10% GST is added to every invoice.
# GST per line = round-half-up(ex GST x 10%), the method in the consistency fixture.
GST_BPS = 1000
GST_SHORT = "+ 10% GST"
GST_SENTENCE = "Prices are in Australian dollars and exclude GST. M&U Ventures is registered for GST, so 10% GST is added to every invoice."
# Setup fees are PROPOSED, not approved: never price, invoice or promise one.
SETUP_LINE = "Setup: quoted separately once approved"
# Approved public promise and call to action (owner, 28 Sep 2026).
PROMISE = "Each business's booking, routing and texts are set up and tested before they go live."
CTA = "Book a 15-minute demo"
DIRECT_BOOKING = ("Direct booking depends on your system: we confirm compatibility during setup, "
                  "or agree a booking-request / lead workflow.")
# Booking claims always name the calendar types and the timing (audit A3 #18-#23).
BOOKS_INTO = "books into a connected Google Calendar or Cal.com calendar"
# One label for every demonstration (audit A3 #41; same as the films).
DEMO_LABEL = "Illustrative demonstration"

# Acceptance = the go-live test set passed on the client's own configuration, plus written
# confirmation (audit A3 #6; receptionist src/lib/acceptance/capabilities.ts goLiveStatus: booking
# and routing always, texts when SMS is configured).
ACCEPTANCE_TESTS = ("a test booking appears correctly in your connected calendar (in Booking request mode: "
                    "a complete booking request is received); an urgent-wording test call gives the 000 line first; "
                    "test calls reach the receptionist through your configured cover and call forwarding; and, "
                    "when SMS is configured, a test text is delivered with the opt-out wording")
ACCEPTANCE_SHORT = ("Acceptance = the go-live tests pass on your own setup (a booking or booking request, an urgent call, "
                    "calls through your cover and forwarding, and a text if SMS is set up) and you confirm them in writing.")

# ----------------------------------------------------------------------------- owner decisions
# One open owner decision (audit A3 #5; #1 settled 1 Oct 2026). Documents carry these placeholders verbatim until the
# owner decides; check_catalogue.py reports them and fails if one is altered or silently dropped.
# Decision (a) (Essential cover) was settled 1 Oct 2026 (owner brief 1 Oct 2026): every tier covers business hours,
# alongside staff, after hours and overflow. The placeholder is gone; check_catalogue.py fails if it reappears.
DECISION_B = ("[OWNER DECISION (b) PENDING: is the monthly fee billed in advance from Acceptance, "
              "or in arrears after each billing period? Not decided.]")
BILLING_TERMS = "Billing terms are confirmed in your agreement."
BILLING_PENDING = f"{DECISION_B} {BILLING_TERMS}"
OWNER_DECISIONS = {"b": DECISION_B}

# Palette: deep ink, clinical teal, one warm accent. No cream backgrounds.
INK = "14213D"; TEAL = "0F766E"; TEAL_LIGHT = "CCFBF1"; SLATE = "475569"; MIST = "F1F5F9"; LINE = "CBD5E1"; AMBER = "B45309"; WHITE = "FFFFFF"


def aud(cents, decimals=True):
    sign = "-" if cents < 0 else ""
    cents = abs(int(cents))
    whole = f"{cents // 100:,}"
    return f"{sign}A${whole}.{cents % 100:02d}" if decimals or cents % 100 else f"{sign}A${whole}"


def aud_short(cents):
    """A$699 for whole dollars, A$0.80 for cents."""
    return aud(cents, decimals=cents % 100 != 0)


def gst(cents):
    """GST on one invoice line, round half up to the cent."""
    return (int(cents) * GST_BPS + 5000) // 10000


def incl_gst(cents):
    return int(cents) + gst(cents)


def setup_approved(p):
    return p["pricing"].get("setupStatus") == "approved"


def setup_text(p):
    """The setup cell for a package: a price only once the owner approves setup fees."""
    return aud_short(p["pricing"]["setup"]["cents"]) if setup_approved(p) else "Quoted separately once approved"


def approved_on():
    """'28 Sep 2026' from the catalogue's pricing.approvedAt (all tiers must agree)."""
    import datetime
    dates = {p["pricing"].get("approvedAt") for p in PACKAGES}
    assert len(dates) == 1 and None not in dates, f"packages disagree on approvedAt: {dates}"
    return datetime.date.fromisoformat(dates.pop()).strftime("%d %b %Y").lstrip("0")


def tiers():
    return [pkg(n) for n in TIER_NAMES]


def invoice_example():
    """Worked invoice from the consistency fixture's usage and the catalogue's rates.

    Raises if the result differs from the fixture's expectedInvoice, so no document can show a
    number the receptionist app, CRM and Finance would not also produce.
    """
    fx = FIXTURE
    p = next(x for x in PACKAGES if x["catalogueId"] == fx["customer"]["packageId"])
    q = p["pricing"]
    minutes = fx["usage"]["billableMinutes"]
    over = max(0, minutes - q["includedMinutes"])
    rate = q["overagePerMinute"]["cents"]
    sms_over = max(0, fx["usage"]["smsSegments"] - q["includedSmsSegments"])
    lines = [("monthly", q["monthly"]["cents"]), ("overage", over * rate),
             ("sms", sms_over * q["extraSmsSegment"]["cents"])]
    ex = sum(c for _, c in lines)
    g = sum(gst(c) for _, c in lines)
    exp = fx["expectedInvoice"]
    got = (q["includedMinutes"], over, rate, ex, g, ex + g)
    want = (exp["includedMinutes"], exp["overageMinutes"], exp["overageRateExGstCents"],
            exp["totals"]["exGstCents"], exp["totals"]["gstCents"], exp["totals"]["totalInclGstCents"])
    assert got == want, f"invoice example {got} disagrees with the consistency fixture {want}"
    assert exp["setupFee"]["invoiced"] is False
    assert fx["usage"]["transfers"]["customerBillable"] is False
    return {"package": p, "name": p["shortName"], "minutes": minutes, "included": q["includedMinutes"],
            "over": over, "rate": rate, "monthly": q["monthly"]["cents"], "overage": over * rate,
            "sms_over": sms_over, "ex": ex, "gst": g, "total": ex + g}


def invoice_example_text(markdown=False):
    """One-line worked example, e.g. 'A$1,099.00 + 200 x A$0.75 = A$1,249.00 ex GST ...'."""
    e = invoice_example()
    b = (lambda t: f"**{t}**") if markdown else (lambda t: t)
    return (f"{e['name']}, {e['minutes']:,} billable minutes: {aud(e['monthly'])} + {e['over']:,} × {aud_short(e['rate'])} = "
            f"{b(aud(e['ex']) + ' ex GST')}; GST {aud(e['gst'])}; {b(aud(e['total']) + ' incl. GST')}. "
            f"No setup line.")


def invoice_example_rows():
    """[description, ex GST] rows for a small invoice table."""
    e = invoice_example()
    return [
        [f"{e['name']} monthly fee ({e['included']:,} minutes included)", aud(e["monthly"])],
        [f"Extra minutes: {e['over']:,} × {aud_short(e['rate'])}", aud(e["overage"])],
        ["Subtotal, ex GST", aud(e["ex"])],
        ["GST (10%)", aud(e["gst"])],
        ["Total, incl. GST", aud(e["total"])],
    ]


def cover_text(p, sep="; "):
    """A package's cover modes, straight from the catalogue."""
    return sep.join(p["inclusions"]["coverModes"])


def settle_in(p):
    """What a package includes after go-live, from the catalogue (daily review is Premium hypercare only)."""
    hyper = next((o for o in p["onboarding"] if "hypercare" in o), None)
    return hyper if hyper else p["support"]["reviews"]


def pkg(short):
    for p in PACKAGES:
        if p["shortName"] == short:
            return p
    raise KeyError(short)


def econ(package_id):
    for p in ECONOMICS["packages"]:
        if p["packageId"] == package_id:
            return p
    raise KeyError(package_id)


def base_at(package_id, clients=5, scenario="base"):
    e = econ(package_id)
    s = next(x for x in e["scenarios"] if x["scenarioId"] == scenario)
    c = next(x for x in s["byClients"] if x["clients"] == clients)
    return s, c["estimated"]


def rgb(hex6):
    """Office COM colour (BGR integer) from RRGGBB."""
    r, g, b = int(hex6[0:2], 16), int(hex6[2:4], 16), int(hex6[4:6], 16)
    return r + (g << 8) + (b << 16)


# ----------------------------------------------------------------------------- Word
def build_docx(html, out_docx, header_text, footer_text, landscape=False):
    """Insert HTML into a fresh print-layout Word document, save .docx and export .pdf."""
    import win32com.client as win32
    out_docx = pathlib.Path(out_docx)
    tmp_html = HERE / f"_{out_docx.stem}.html"
    tmp_html.write_text(html, encoding="utf-8")
    word = win32.DispatchEx("Word.Application")
    word.Visible = False
    word.DisplayAlerts = 0
    try:
        doc = word.Documents.Add()
        ps = doc.PageSetup
        if landscape:
            ps.Orientation = 1
        ps.PaperSize = 7  # wdPaperA4
        for side in ("TopMargin", "BottomMargin", "LeftMargin", "RightMargin"):
            setattr(ps, side, 56)  # ~2 cm in points
        doc.Content.InsertFile(str(tmp_html))
        # Word maps h1-h3 to its built-in heading styles; restyle them to the pack palette.
        for style_id, size, colour, font in ((-2, 22, INK, "Cambria"), (-3, 13, TEAL, "Calibri"), (-4, 11, INK, "Calibri")):
            st = doc.Styles(style_id)
            st.Font.Name = font; st.Font.Size = size; st.Font.Color = rgb(colour); st.Font.Bold = style_id != -2
        # Tables: compact rows, repeat header, keep short tables on one page.
        for t in doc.Tables:
            t.Range.ParagraphFormat.SpaceBefore = 0
            t.Range.ParagraphFormat.SpaceAfter = 0
            t.Range.ParagraphFormat.LineSpacingRule = 0
            t.Rows(1).HeadingFormat = True
            t.Rows.AllowBreakAcrossPages = False
            if t.Rows.Count <= 12:
                for i in range(1, t.Rows.Count):
                    t.Rows(i).Range.ParagraphFormat.KeepWithNext = True
        for heading_style in (-2, -3, -4):
            doc.Styles(heading_style).ParagraphFormat.KeepWithNext = True
        # Header / footer (primary) with page numbers.
        sec = doc.Sections(1)
        h = sec.Headers(1).Range
        h.Text = header_text
        h.Font.Name = "Calibri"; h.Font.Size = 8; h.Font.Color = rgb(SLATE)
        f = sec.Footers(1).Range
        f.Text = footer_text + "\tPage "
        f.Font.Name = "Calibri"; f.Font.Size = 8; f.Font.Color = rgb(SLATE)
        f.Collapse(0)
        f.Fields.Add(f, 33)  # wdFieldPage
        doc.SaveAs2(str(out_docx), FileFormat=16)
        pdf = RENDERS / (out_docx.stem + ".pdf")
        RENDERS.mkdir(exist_ok=True)
        doc.ExportAsFixedFormat(str(pdf), 17)
        pages = doc.ComputeStatistics(2)
        doc.Close(0)
    finally:
        word.Quit()
        try:
            tmp_html.unlink()
        except OSError:
            pass
    return pdf, pages


# ----------------------------------------------------------------------------- PDF → PNG
def rasterise(pdf, prefix, zoom=1.4):
    import pymupdf as fitz
    out = []
    doc = fitz.open(str(pdf))
    for i, page in enumerate(doc):
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        path = RENDERS / f"{prefix}-{i + 1:02d}.png"
        pix.save(str(path))
        out.append(path)
    doc.close()
    source = PACK / f"{prefix}.docx"
    if source.exists():
        record_render(prefix, source, out)
    return out


# ----------------------------------------------------------------------------- HTML
CSS = f"""
<style>
body {{ font-family: Calibri, Arial, sans-serif; font-size: 10.5pt; color: #{INK}; line-height: 1.3; }}
h1 {{ font-family: Cambria, Georgia, serif; font-size: 22pt; color: #{INK}; margin: 0 0 4pt 0; }}
h2 {{ font-family: Calibri, Arial, sans-serif; font-size: 13pt; color: #{TEAL}; margin: 14pt 0 4pt 0; }}
h3 {{ font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #{INK}; margin: 10pt 0 2pt 0; }}
p {{ margin: 0 0 6pt 0; }}
li {{ margin: 0 0 3pt 0; }}
table {{ border-collapse: collapse; width: 100%; margin: 4pt 0 8pt 0; }}
th {{ background: #{INK}; color: #FFFFFF; font-weight: bold; text-align: left; padding: 4pt 6pt; font-size: 9.5pt; border: 1px solid #{INK}; }}
td {{ padding: 4pt 6pt; border: 1px solid #{LINE}; font-size: 9.5pt; vertical-align: top; }}
td.num, th.num {{ text-align: right; }}
tr.alt td {{ background: #{MIST}; }}
.lead {{ font-size: 11.5pt; color: #{SLATE}; }}
.small {{ font-size: 8.5pt; color: #{SLATE}; }}
.fill {{ background: #FEF3C7; }}
.flag {{ color: #{AMBER}; font-weight: bold; }}
.note {{ border: 1px solid #{TEAL}; background: #{TEAL_LIGHT}; padding: 6pt 8pt; margin: 6pt 0 8pt 0; }}
.warn {{ border: 1px solid #{AMBER}; background: #FFFBEB; padding: 6pt 8pt; margin: 6pt 0 8pt 0; }}
</style>
"""


def html_doc(body):
    return f"<html><head><meta charset='utf-8'>{CSS}</head><body>{body}</body></html>"


def table(headers, rows, num_cols=(), widths=None):
    def cell(tag, i, v):
        cls = " class='num'" if i in num_cols else ""
        w = f" width='{widths[i]}%'" if widths else ""
        return f"<{tag}{cls}{w}>{v}</{tag}>"
    head = "<tr>" + "".join(cell("th", i, h) for i, h in enumerate(headers)) + "</tr>"
    body = "".join(
        f"<tr{' class=\"alt\"' if r % 2 else ''}>" + "".join(cell("td", i, v) for i, v in enumerate(row)) + "</tr>"
        for r, row in enumerate(rows))
    return f"<table>{head}{body}</table>"


def fill(text):
    """Yellow-highlighted placeholder the sender must replace."""
    return f"<span class='fill'>[{text}]</span>"


def fill_decisions(html_text):
    """Style every open owner-decision placeholder as a yellow fill-in field (the same style as fill()),
    so it reads as a field still to settle, not as settled prose. The text stays verbatim."""
    for ph in OWNER_DECISIONS.values():
        html_text = html_text.replace(ph, f"<span class='fill'>{ph}</span>")
    return html_text


# ----------------------------------------------------------------------------- render manifest
MANIFEST = RENDERS / "render-manifest.json"
# Review T5 R2 C1: a deck that can't be rebuilt is renamed with this prefix (its .pptx, PDF and PNGs),
# so nobody attaches it by accident. A rebuild writes the plain names and removes the prefixed copies.
STALE_PREFIX = "STALE-DO-NOT-SEND-"


def _sha256(path):
    import hashlib
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def record_render(stem, source, pngs):
    """Record which source file (by sha256) a set of PNG renders was made from. check_catalogue.py
    compares hashes, not timestamps: a rebuild can leave byte-identical PNGs, and a git checkout
    gives every file its checkout time."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    for old in list(PACK.glob(f"{STALE_PREFIX}{stem}.*")) + list(RENDERS.glob(f"{STALE_PREFIX}{stem}*")):
        old.unlink()
    data[stem] = {"source": pathlib.Path(source).name, "sourceSha256": _sha256(source),
                  "pngs": {pathlib.Path(p).name: _sha256(p) for p in sorted(pngs)}}
    MANIFEST.write_text(json.dumps(dict(sorted(data.items())), indent=2) + "\n", encoding="utf-8", newline="\n")
