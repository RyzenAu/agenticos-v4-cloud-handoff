"""Fails (exit 1) if the sales pack or call pack disagrees with the package catalogue JSON.

Checks, in order:
 1. The consistency fixture's invoice reproduces from the catalogue (common.invoice_example).
 2. Every generated markdown block is current (build_markdown.py --check).
 3. Every generated .docx / .pptx / .pdf contains the catalogue's prices for the tiers it shows,
    and the Professional invoice example where the document shows one.
 4. No generated document or current markdown file carries a retired or unapproved term: old
    prices, pilot/trial offers, setup amounts or setup invoicing, "if registered" GST wording,
    or a claim fixed after audit A3 (transfer billing, daily review below Premium, "the calendar
    your practice already uses", missed-call framing, "##002#", founding terms, and so on).
 4a. Open owner decisions (build/common.py OWNER_DECISIONS) are REPORTED, not failed: every
    placeholder must be verbatim, still open, and present where the decision matters.
 5. Every A$ amount in a client document is a catalogue-derived amount.
 6. Each PDF has exactly one PNG per page (decks: one per slide), with no stale page images.
 7. (review T5) No literal {UPPER_CASE} template variable in a generated document; a daily review
    or a booking claim is checked per paragraph (the Premium / go-live qualifier must be in the same
    paragraph, not merely nearby); and the lead-engine code that writes sales text
    (scripts/leads/call-script.ts, outreach.ts, sales-backoffice.ts) carries no retired claim.

Stale decks (review T5 R5): renders/render-manifest.json may mark sales-presentation and
onboarding-deck "stale": true (with a staleReason) while PowerPoint can't rebuild them. Their known
problems are then reported as expected-stale, not failed, and a "STALE, do not send" line is printed.
The flag can't cover any other document, it covers only the exact deck binary recorded in the
manifest, and a flagged deck that turns out clean fails (remove the flag). Rebuilding a deck with
build_all.py rewrites its manifest entry, which clears the flag.

Dated evidence folders (research/, design-gate/, site-audit/, receptionist-prompt/) are records,
not offers, and are skipped. Runs without Office: .docx/.pptx are read as zip XML, PDFs with PyMuPDF.
    python docs/sales/receptionist-pack-2026-09-28/build/check_catalogue.py
"""
import html
import re
import sys
import zipfile

from common import *
import build_markdown
from common import _sha256, MANIFEST

MANIFEST_DATA = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}


CALL_PACK = PACK.parent / "dental-call-pack-2026-09-28"
HISTORICAL_DIRS = ("research", "design-gate", "site-audit", "receptionist-prompt")
failures = []
# Stale decks (review T5 R5): only these may be flagged, and only while PowerPoint can't rebuild them.
STALE_ALLOWED = ("sales-presentation", "onboarding-deck")
_flagged = {stem for stem, e in MANIFEST_DATA.items() if isinstance(e, dict) and e.get("stale")}
STALE = [s for s in STALE_ALLOWED if s in _flagged] + sorted(_flagged - set(STALE_ALLOWED))
stale_failures = {}
_stale_ctx = None  # set to a flagged deck's stem while its own checks run


def fail(msg):
    if _stale_ctx:
        stale_failures.setdefault(_stale_ctx, []).append(msg)
    else:
        failures.append(msg)


# ----------------------------------------------------------------------------- text extraction
def docx_text(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    paras = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
    return "\n".join(html.unescape("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p))) for p in paras)


def pptx_text(path):
    out = []
    with zipfile.ZipFile(path) as z:
        names = sorted((n for n in z.namelist() if re.match(r"ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml$", n)),
                       key=lambda n: (n.split("/")[1], int(re.search(r"(\d+)\.xml$", n).group(1))))
        for n in names:
            xml = z.read(n).decode("utf-8")
            for p in re.findall(r"<a:p>.*?</a:p>|<a:p .*?</a:p>", xml, re.S):
                out.append(html.unescape("".join(re.findall(r"<a:t>([^<]*)</a:t>", p))))
    return "\n".join(out)


def pdf_text(path):
    import pymupdf
    with pymupdf.open(str(path)) as doc:
        return "\n".join(page.get_text() for page in doc), doc.page_count


def norm(t):
    """Join PDF line breaks and normalise spaces so phrases split across lines still match."""
    return re.sub(r"\s+", " ", t.replace(" ", " "))


# ----------------------------------------------------------------------------- expected values
TS = tiers()
MONTHLY = {t["shortName"]: aud_short(t["pricing"]["monthly"]["cents"]) for t in TS}
OVERAGE = {t["shortName"]: aud_short(t["pricing"]["overagePerMinute"]["cents"]) for t in TS}
EX = invoice_example()
EXAMPLE_AMOUNTS = [aud(EX["monthly"]), aud(EX["overage"]), aud(EX["ex"]), aud(EX["gst"]), aud(EX["total"])]


def catalogue_amounts():
    """Every A$ string a client document may legitimately show."""
    vals = set()
    for t in TS:
        q = t["pricing"]
        for c in (q["monthly"]["cents"], q["overagePerMinute"]["cents"], q["extraSmsSegment"]["cents"]):
            vals |= {aud(c), aud_short(c), aud(incl_gst(c)), aud_short(incl_gst(c))}
        if setup_approved(t):
            vals |= {aud(q["setup"]["cents"]), aud_short(q["setup"]["cents"])}
    for c in (EX["monthly"], EX["overage"], EX["ex"], EX["gst"], EX["total"], EX["rate"]):
        vals |= {aud(c), aud_short(c)}
    return vals


def internal_econ_amounts():
    """Amounts on the hidden internal economics slide (derived from package-economics.json)."""
    vals = set()
    for t in TS:
        s, e = base_at(t["catalogueId"])
        for k in ("revenueExGstCents", "variableCostCents"):
            vals.add(aud(e[k] // 5))
        vals.add(aud(e["overageFloorExGstCents"]))
        vals.add(aud(e["perMinuteCents"]))
    vals.add(f"A${ECONOMICS['assumptions']['labourHourlyCents'] // 100}")
    return vals


ALLOWED = catalogue_amounts()
SETUP_AMOUNTS = set()
for t in TS:
    if not setup_approved(t):
        c = t["pricing"]["setup"]["cents"]
        SETUP_AMOUNTS |= {aud_short(c), aud(c), aud_short(incl_gst(c)), aud(incl_gst(c))}

# Retired figures from the superseded 27 Sep packs (never valid again).
RETIRED = ["A$999", "A$1,098.90", "A$1,690", "1,690", "A$1,859", "A$0.90", "0.90/min", "A$549", "A$490"]
# Case-sensitive phrases (the owner's done-gate list) and case-insensitive ones.
FORBIDDEN_CS = [r"14-day", r"free pilot", r"After-Hours Pilot", r"owner-approved 27 Sep", r"invoiced at Acceptance",
                r"if registered", r"if applicable", r"no setup fee"]
FORBIDDEN_CI = [r"\bpilot\b", r"\btrial\b",r"owe (us )?nothing", r"nothing('s)? owing", r"pay nothing",
                r"setup (fee )?is invoiced", r"invoice[sd]? (the )?setup", r"setup invoice", r"GST if\b", r"only if (M&U|we're|we are) (is )?registered",
                r"pending (the )?owner'?s? approval", r"proposals? pending", r"\bmissed[- ]calls?\b", r"risk-free",
                r"20-minute (demo|screen)", r"screen share",
                # One call to action: "Book a 15-minute demo". No competing asks.
                r"\b(5|10|20|30|45|60)-minute demo", r"book (a|an) (free |quick |short )?(call|chat|consult(ation)?|meeting)\b",
                r"free (consult(ation)?|demo|audit|strategy call)"]
# A line may name a banned idea only to rule it out.
NEGATION = re.compile(r"\b(no|never|not|don't|any|none)\b.{0,60}\b(pilot|trial|missed[- ]call|waiver)|"
                      r"(pilot|trial).{0,40}\b(not|never) approved|position it as missed-call cover|missed-call cover\b.*\b(never|not)\b",
                      re.I)

# Regressions fixed after claims audit A3 (28 Sep 2026). Matched on whitespace-normalised text with the
# owner-decision placeholders removed, so a phrase split across PDF lines is still caught.
REGRESSIONS = [
    (r"transfer minutes", "transfer isn't offered: no transfer billing wording (A3 #11)"),
    (r"(the )?calendar (that )?your (practice|business) already uses", "books only into a connected Google Calendar or Cal.com calendar (A3 #18)"),
    (r"founding (terms|offer|client|rate)", "no founding terms: billing per the signed agreement (A3 #9)"),
    (r"labell?ed simulated|simulated: fictional|\bsynthetic (caller|tenant|test client)", f"one demo label: {DEMO_LABEL!r} (A3 #41)"),
    (r"calls 1 and 3", "Acceptance is the full go-live test set (A3 #6)"),
    (r"booking records are stored in Australia", "bookings live in the client's calendar provider (A3 #31)"),
    (r"alerts? (your team |you )?(instantly|straight away)|instant alert", "alerts are email at go-live, never 'instant' (A3 #33)"),
    (r"not priced,? (or|and|not) (sold|offered)|haven't priced or sold", "the catalogue sells dental, property and legal at the same prices (A3 #33)"),
    (r"(billed|invoiced|payable) (monthly )?in advance|\(in advance\)", "billing timing is open owner decision (b) (A3 #5)"),
    (r"desk confirms (it |the request |each request )?(from the dashboard )?(the |by the )?next business morning",
     "confirming a booking request is the client's commitment (A3 #30)"),
    (r"\bbook a demo\b|(worth|can i book|shall i book) a 15-minute demo", f"the one CTA is {CTA!r}"),
]
DAILY_REVIEW = re.compile(r"daily (call[- ])?review|review(s|ed)? (flagged calls |calls )?daily|daily review of flagged", re.I)
# A booking claim must carry its own qualifier in the same paragraph (audit A3 #22, #23; review T5).
BOOKING_CLAIM = re.compile(r"\bbooks? (straight |them |it )?(in|into) (your|their|the practice's|the) (own )?(calendar|system|diary)", re.I)
BOOKING_QUALIFIER = re.compile(r"connected|Google Calendar|Cal\.com|go-live|go live", re.I)
TEMPLATE_VAR = re.compile(r"\{[A-Z][A-Z0-9_]*\}")


def scan_paragraphs(label, text):
    """Per-paragraph checks on source text (markdown lines, .docx / .pptx paragraphs): a nearby
    "Premium" in another paragraph or table cell must not excuse a daily-review claim."""
    for i, para in enumerate(text.split("\n"), 1):
        t = strip_decisions(para)
        if DAILY_REVIEW.search(t) and not re.search(r"Premium|hypercare", t):
            fail(f"{label}:{i}: daily review of flagged calls outside Premium (A3 #7): {t.strip()[:140]}")
        m = BOOKING_CLAIM.search(t)
        if m and not BOOKING_QUALIFIER.search(t):
            fail(f"{label}:{i}: booking claim without 'at go-live' / connected calendar (A3 #22-#23): {t.strip()[:140]}")


def scan_template_vars(label, text):
    for m in TEMPLATE_VAR.finditer(text):
        fail(f"{label}: literal template variable {m.group(0)} (a builder string that isn't an f-string)")


def strip_decisions(text):
    t = norm(text)
    for ph in OWNER_DECISIONS.values():
        t = t.replace(ph, " ")
    return t


def scan_regressions(label, text):
    t = strip_decisions(text)
    for pat, why in REGRESSIONS:
        for m in re.finditer(pat, t, re.I):
            fail(f"{label}: regression /{pat}/ ({why}): …{t[max(0, m.start() - 50):m.end() + 50]}…")
    for m in DAILY_REVIEW.finditer(t):
        window = t[max(0, m.start() - 160):m.end() + 160]
        if not re.search(r"Premium|hypercare", window):
            fail(f"{label}: daily review of flagged calls outside Premium (A3 #7): …{t[max(0, m.start() - 60):m.end() + 60]}…")
    for m in re.finditer(r"##002#", t):
        if not re.search(r"not (published|publish)|(^|\W)no `?##002#`?[;,.]|excluded", t[max(0, m.start() - 80):m.end() + 80], re.I):
            fail(f"{label}: '##002#' is not a carrier-documented code in Australia (A3 #32)")


# ----------------------------------------------------------------------------- owner decisions
PLACEHOLDER = re.compile(r"\[OWNER DECISION \((\w)\)")
decision_places = {k: [] for k in OWNER_DECISIONS}


def scan_decisions(label, text, count=True):
    """Every placeholder must be verbatim and for a decision that is still open."""
    t = norm(text)
    for m in PLACEHOLDER.finditer(t):
        key = m.group(1)
        if key not in OWNER_DECISIONS:
            fail(f"{label}: placeholder for unknown or closed owner decision ({key}): {t[m.start():m.start() + 100]}")
        elif not t.startswith(OWNER_DECISIONS[key], m.start()):
            fail(f"{label}: owner decision ({key}) placeholder altered: {t[m.start():m.start() + len(OWNER_DECISIONS[key]) + 10]!r}")
        elif count:
            decision_places[key].append(label)


def require_decisions(label, text, keys):
    t = norm(text)
    for k in keys:
        if k in OWNER_DECISIONS and OWNER_DECISIONS[k] not in t:
            fail(f"{label}: owner decision ({k}) is open but its placeholder is missing")
    if "b" in keys and "b" in OWNER_DECISIONS and label.split(".")[0] != "service-agreement-draft" and BILLING_TERMS not in t:
        fail(f"{label}: missing {BILLING_TERMS!r} next to the decision (b) placeholder")


def scan_terms(label, text, allow_pilot=False, allow_setup_amounts=False):
    for i, line in enumerate(text.split("\n"), 1):
        where = f"{label}:{i}"
        for r in RETIRED:
            if r in line:
                fail(f"{where}: retired figure {r!r}: {line.strip()[:120]}")
        for pat in FORBIDDEN_CS:
            if re.search(pat, line):
                fail(f"{where}: forbidden phrase /{pat}/: {line.strip()[:120]}")
        for pat in FORBIDDEN_CI:
            if re.search(pat, line, re.I):
                if pat == r"\bpilot\b" and allow_pilot:
                    continue
                if NEGATION.search(line):
                    continue
                fail(f"{where}: forbidden phrase /{pat}/: {line.strip()[:120]}")
        if not allow_setup_amounts:
            for a in re.findall(r"A\$[\d,]+(?:\.\d\d)?", line):
                if a in SETUP_AMOUNTS:
                    fail(f"{where}: unapproved setup amount {a}: {line.strip()[:120]}")


def scan_amounts(label, text, extra=frozenset()):
    for a in sorted(set(re.findall(r"A\$[\d,]*\d(?:\.\d\d)?", text))):
        if a not in ALLOWED and a not in extra:
            fail(f"{label}: A$ amount {a} is not a catalogue-derived value")


def need(label, text, phrases):
    t = norm(text)
    for ph in phrases:
        if norm(ph) not in t:
            fail(f"{label}: missing expected text {ph!r}")


# ----------------------------------------------------------------------------- 1. fixture
try:
    invoice_example()
except AssertionError as e:
    fail(f"fixture: {e}")
for t in TS:
    if t["pricing"]["status"] != "approved":
        fail(f"catalogue: {t['shortName']} pricing.status is {t['pricing']['status']!r}, documents say approved")
    for k in ("monthly", "overagePerMinute", "extraSmsSegment"):
        d = t["display"][k]
        catalogue_incl = d.get("inclGstCents", d.get("inclGstIfRegisteredCents"))
        if catalogue_incl is not None and catalogue_incl != incl_gst(d["exGstCents"]):
            fail(f"catalogue: {t['shortName']} {k} incl-GST {catalogue_incl} != ex GST + 10% ({incl_gst(d['exGstCents'])})")
if "registered" not in CATALOGUE.get("gstBasis", "") or "pending" in CATALOGUE.get("gstBasis", ""):
    fail(f"catalogue: gstBasis {CATALOGUE.get('gstBasis')!r} no longer says M&U is registered; documents add 10% GST")
all_calls = [t["shortName"] for t in TS if "All calls" in t["inclusions"]["coverModes"]]
if all_calls != ["Professional", "Premium"]:
    fail(f"catalogue: 'All calls' cover is now {all_calls}; update call-forwarding-guide.md and 01-offer.md wording")
# Decision (a) lives in the catalogue itself (Essential audience + answer label, OWNER_DECISION_A in
# src/lib/receptionist-packages.ts). Open there <=> open here; the texts must match exactly.
ess_cat = pkg("Essential")
ess_texts = [ess_cat["audience"], next(f["label"] for f in ess_cat["scope"] if f["id"] == "answer")]
if "a" in OWNER_DECISIONS and not all(DECISION_A in x for x in ess_texts):
    fail("catalogue: decision (a) is open in build/common.py but the Essential audience/answer label lacks the exact placeholder")
if "a" not in OWNER_DECISIONS and any("OWNER DECISION (a)" in x for x in ess_texts):
    fail("catalogue: decision (a) is closed in build/common.py but the catalogue still carries its placeholder")
for t in TS:
    scan_decisions(f"catalogue {t['shortName']}", json.dumps(t, ensure_ascii=False), count=False)
    if t["shortName"] != "Premium":
        scan_regressions(f"catalogue {t['shortName']}", json.dumps(t, ensure_ascii=False))

# ----------------------------------------------------------------------------- 2. markdown blocks
for p in build_markdown.run(check=True):
    fail(f"{p.name}: generated block is stale; run build/build_markdown.py")

# ----------------------------------------------------------------------------- 4/5. markdown files
md_files = [p for p in CALL_PACK.glob("*.md")] + [p for p in PACK.glob("*.md")]
for p in md_files:
    text = p.read_bytes().decode("utf-8")
    internal = p.name.startswith("07-")  # internal economics: Jev "pilot" is a model test; setup is modelled, labelled not approved
    scan_terms(p.name, text, allow_pilot=internal, allow_setup_amounts=internal)
    scan_regressions(p.name, text)
    scan_paragraphs(p.name, text)
    scan_template_vars(p.name, text)
    scan_decisions(p.name, text)
    if internal:
        for i, line in enumerate(text.split("\n"), 1):
            if any(a in line for a in re.findall(r"A\$[\d,]+(?:\.\d\d)?", line) if a in SETUP_AMOUNTS) and "not approved" not in line:
                fail(f"{p.name}:{i}: setup amount without the 'not approved' label")
    else:
        scan_amounts(p.name, text)
# The approved CTA and promise must be where a prospect meets them (call pack, verbatim).
CTA_FILES = ("00-START-HERE.md", "01-offer.md", "02-call-script.md", "13-follow-up-drafts.md")
PROMISE_FILES = ("00-START-HERE.md", "01-offer.md", "12-closing.md")
for name in CTA_FILES:
    if CTA.lower() not in (CALL_PACK / name).read_text(encoding="utf-8").lower():
        fail(f"{name}: missing the approved call to action {CTA!r}")
for name in PROMISE_FILES:
    if PROMISE not in norm((CALL_PACK / name).read_text(encoding="utf-8")):
        fail(f"{name}: missing the approved promise {PROMISE!r}")
for p in CALL_PACK.rglob("*.md"):
    rel = p.relative_to(CALL_PACK).parts
    if len(rel) > 1 and rel[0] not in HISTORICAL_DIRS:
        fail(f"{p}: new sub-folder not covered by this check")
# Where an open owner decision must be flagged (the places that state Essential's cover or billing timing).
MD_DECISIONS = {"01-offer.md": "ab", "10-qualification.md": "a", "11-package-comparison.md": "ab", "12-closing.md": "ab",
                "14-onboarding.md": "b", "00-START-HERE.md": "ab"}
for name, keys in MD_DECISIONS.items():
    require_decisions(name, (CALL_PACK / name).read_text(encoding="utf-8"), keys)
require_decisions("README.md", (PACK / "README.md").read_text(encoding="utf-8"), "ab")
# prospects.csv openers (A3 #36): cover choice and booking; no website-only or missed-call opener.
import csv
with open(CALL_PACK / "prospects.csv", encoding="utf-8", newline="") as fh:
    _rows = list(csv.DictReader(fh))
for i, r in enumerate(_rows, 2):
    opener, fit = r["personalised_opening"], r["offer_fit(receptionist | website | none)"]
    if fit == "receptionist" and not re.search(r"after hours, when the desk is busy, or alongside your team", opener):
        fail(f"prospects.csv:{i}: receptionist opener doesn't lead on cover choice and booking")
    if fit != "receptionist" and opener and not opener.startswith("(Website fit only"):
        fail(f"prospects.csv:{i}: website-only opener left on the receptionist call list")
    if re.search(r"missed|no after-hours|copyright|refresh|resize", opener, re.I):
        fail(f"prospects.csv:{i}: opener uses missed-call or website framing: {opener[:100]}")

# ----------------------------------------------------------------------------- 3/4/5/6. generated documents
DOCS_EXPECT = {
    "proposal-template": {"kind": "docx", "need": [MONTHLY["Essential"], aud(incl_gst(pkg("Essential")["pricing"]["monthly"]["cents"])),
                                                   OVERAGE["Essential"] + "/min", SETUP_LINE.split(": ")[1].capitalize(), "10% GST", PROMISE]
                          + list(MONTHLY.values()) + EXAMPLE_AMOUNTS, "decisions": "ab"},
    "service-agreement-draft": {"kind": "docx", "need": list(MONTHLY.values()) + [o + "/min" for o in OVERAGE.values()]
                                + ["Quoted separately once approved", "registered for GST", "DRAFT FOR QUALIFIED LEGAL REVIEW"], "decisions": "ab"},
    "demo-guide": {"kind": "docx", "need": list(MONTHLY.values()) + [GST_SHORT, PROMISE, DEMO_LABEL]},
    "client-setup-checklist": {"kind": "docx", "need": ["all calls, alongside your team"]},
    "call-forwarding-guide": {"kind": "docx", "need": ["All calls, alongside the team", "16 September 2026"]},
    "sales-presentation": {"kind": "pptx", "need": list(MONTHLY.values()) + [f"{o} per extra minute" for o in OVERAGE.values()]
                           + [GST_SHORT, PROMISE, DIRECT_BOOKING, DEMO_LABEL, "Google Calendar or Cal.com"] + [aud(EX["ex"]), aud(EX["gst"]), aud(EX["total"])],
                           "extra": internal_econ_amounts(), "decisions": "a"},
    "onboarding-deck": {"kind": "pptx", "need": list(MONTHLY.values()) + list(OVERAGE.values()) + [aud(EX["ex"]), aud(EX["gst"]), aud(EX["total"]), GST_SHORT],
                        "decisions": "ab"},
}
for stem in STALE:
    entry = MANIFEST_DATA[stem]
    if stem not in STALE_ALLOWED:
        fail(f"renders/render-manifest.json: {stem} is marked stale, but only {', '.join(STALE_ALLOWED)} may be (rebuild it instead)")
    if not str(entry.get("staleReason", "")).strip():
        fail(f"renders/render-manifest.json: {stem} is marked stale without a staleReason")
    src = PACK / f"{STALE_PREFIX}{stem}.{DOCS_EXPECT[stem]['kind']}" if stem in DOCS_EXPECT else None
    for plain in [PACK / f"{stem}.{DOCS_EXPECT[stem]['kind']}", RENDERS / f"{stem}.pdf", *RENDERS.glob(f"{stem}-[0-9][0-9].png")] if stem in DOCS_EXPECT else []:
        if plain.exists():
            fail(f"{plain.name}: {stem} is stale, so its files must carry the {STALE_PREFIX} prefix (review T5 R2 C1)")
    if src is not None and src.exists() and entry.get("sourceSha256") != _sha256(src):
        fail(f"renders: {stem} is marked stale but {src.name} is not the recorded binary; rebuild it with build_all.py (a rebuild clears the flag)")

for stem, spec in DOCS_EXPECT.items():
    _stale_ctx = stem if stem in STALE and stem in STALE_ALLOWED else None
    name = f"{STALE_PREFIX}{stem}" if _stale_ctx else stem
    src = PACK / f"{name}.{spec['kind']}"
    pdf = RENDERS / f"{name}.pdf"
    for f in (src, pdf):
        if not f.exists():
            fail(f"{f.name}: missing")
    if failures and not (src.exists() and pdf.exists()):
        continue
    src_text = docx_text(src) if spec["kind"] == "docx" else pptx_text(src)
    pdf_txt, pages = pdf_text(pdf)
    extra = spec.get("extra", frozenset())
    for label, text in ((src.name, src_text), (pdf.name, pdf_txt)):
        scan_terms(label, text)
        scan_amounts(label, text, extra)
        scan_regressions(label, text)
        scan_template_vars(label, text)
        if label == src.name:
            scan_paragraphs(label, text)
        # A stale deck's placeholders aren't counted: nobody should be sending it.
        scan_decisions(label, text, count=(label == src.name and not _stale_ctx))
        require_decisions(label, text, spec.get("decisions", ""))
        need(label, text, spec["need"] if label == src.name else [n for n in spec["need"] if n not in (PROMISE, DIRECT_BOOKING)])
    # Renders: one PNG per page (PDF) or per slide (the deck PDF omits the hidden slide).
    if spec["kind"] == "pptx":
        with zipfile.ZipFile(src) as z:
            expected_pngs = len([n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)])
    else:
        expected_pngs = pages
    pngs = sorted(RENDERS.glob(f"{name}-[0-9][0-9].png"))
    if len(pngs) != expected_pngs:
        fail(f"renders: {len(pngs)} PNGs for {stem}, expected {expected_pngs}")
    # Staleness by content: the render manifest records the sha256 of the source each set of PNGs
    # was made from (and of each PNG). Timestamps are not evidence: a git checkout resets them and a
    # rebuild can leave byte-identical PNGs with old commit times.
    entry = MANIFEST_DATA.get(stem)
    if entry is None:
        fail(f"renders: {stem} has no entry in renders/render-manifest.json; rebuild it with build_all.py")
    else:
        if entry.get("sourceSha256") != _sha256(src):
            fail(f"renders: {stem} renders were made from a different {src.name}; rebuild")
        if set(entry.get("pngs", {})) != {p.name for p in pngs}:
            fail(f"renders: {stem} PNG set differs from the manifest; rebuild")
        for png in pngs:
            if entry.get("pngs", {}).get(png.name) not in (None, _sha256(png)):
                fail(f"renders: {png.name} changed after it was rendered; rebuild")
_stale_ctx = None
for leftover in sorted(set(PACK.glob(f"{STALE_PREFIX}*")) | set(RENDERS.glob(f"{STALE_PREFIX}*"))):
    if not any(leftover.name.startswith(f"{STALE_PREFIX}{s}") for s in STALE):
        fail(f"{leftover.name}: carries the {STALE_PREFIX} prefix but its document isn't marked stale; delete it")
for stem in STALE:
    if stem in STALE_ALLOWED and not stale_failures.get(stem):
        fail(f"renders/render-manifest.json: {stem} is marked stale but now passes every check; remove the stale flag")

# ----------------------------------------------------------------------------- 7. lead-engine code
# The drawer's call script, the outreach drafts and the proposal / invoice drafts write sales text
# from code, outside the pack: the same retired claims are refused there (review T5 R6).
REPO = DOCS.parent
CODE_BANNED = [
    (r"straight into|books straight", "books only into a connected Google Calendar or Cal.com calendar, at go-live"),
    (r"answers every call", "cover is what the client configures"),
    (r"\bmissed[- ]((after|after-hours|after hours|business|phone|patient)[- ])?calls?\b|\bcalls? (they|you) miss\b|\bunanswered[- ]calls?\b", "never missed-call framing: cover is configurable"),
    (r"15-minute look", f"the one CTA is {CTA!r}"),
    (r"\b10-minute\b", f"the one CTA is {CTA!r}"),
]
for rel in ("scripts/leads/call-script.ts", "scripts/leads/outreach.ts", "scripts/leads/sales-backoffice.ts"):
    path = REPO / rel
    if not path.exists():
        fail(f"{rel}: missing (the claims scan covers it)")
        continue
    code = path.read_text(encoding="utf-8")
    for i, line in enumerate(code.split("\n"), 1):
        for pat, why in CODE_BANNED:
            if re.search(pat, line, re.I) and not NEGATION.search(line):
                fail(f"{rel}:{i}: /{pat}/ ({why}): {line.strip()[:140]}")
    scan_decisions(rel, code, count=False)
# The invoice / proposal drafts carry decision (b) verbatim (never a billing-timing claim).
if "b" in OWNER_DECISIONS and DECISION_B not in (REPO / "scripts/leads/sales-backoffice.ts").read_text(encoding="utf-8"):
    fail("scripts/leads/sales-backoffice.ts: owner decision (b) is open but its exact placeholder is missing")

# The proposal must show the invoice example as lines, and no setup line in it.
prop = norm(pdf_text(RENDERS / "proposal-template.pdf")[0])
m = re.search(r"Invoice example(.*?)Example only", prop)
if not m:
    fail("proposal-template.pdf: invoice example table not found")
elif "setup" in m.group(1).lower():
    fail("proposal-template.pdf: the invoice example contains a setup line")
if re.search(r"\b4A\b", norm(pdf_text(RENDERS / "service-agreement-draft.pdf")[0])):
    fail("service-agreement-draft.pdf: clause 4A (pilot) is still present")

# ----------------------------------------------------------------------------- result
# Open owner decisions are reported, never failed on: they are the owner's to make.
if STALE:
    print(f"STALE, do not send: {', '.join(STALE)} (rebuild with build_all.py once PowerPoint works)"
          + f"; {sum(len(v) for v in stale_failures.values())} known problem(s) excused only while renders/render-manifest.json marks them stale")
print(f"owner decisions pending: {len(OWNER_DECISIONS)}"
      + "".join(f"\n - ({k}) in {len(v)} place(s): {', '.join(sorted(set(v)))}" for k, v in sorted(decision_places.items())))
if failures:
    print(f"FAIL: {len(failures)} problem(s)")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print(f"OK: catalogue {CATALOGUE['catalogueVersion']} (approved {approved_on()}) matches {len(md_files)} markdown files "
      f"and {len(DOCS_EXPECT) - len(STALE)} current generated documents with their PDFs and PNG renders"
      f"{f' ({len(STALE)} stale, not checked as current)' if STALE else ''}; invoice example "
      f"{aud(EX['ex'])} + GST {aud(EX['gst'])} = {aud(EX['total'])} matches the consistency fixture.")
