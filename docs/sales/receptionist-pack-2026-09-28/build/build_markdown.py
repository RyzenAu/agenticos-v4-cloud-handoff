"""Writes the price and economics blocks inside the call-pack and pack markdown from the JSON exports.

Each block sits between markers like
    <!-- generated:packages (build/build_markdown.py; don't hand-edit) -->
    ...
    <!-- /generated:packages -->
Everything between the markers is replaced on every run. `--check` rewrites nothing and exits 1
if any block is stale (used by check_catalogue.py). No Office needed.
"""
import pathlib
import re
import sys

from common import *

CALL_PACK = PACK.parent / "dental-call-pack-2026-09-28"


def _row(cells):
    return "| " + " | ".join(str(c) for c in cells) + " |"


def _table(header, rows, align=None):
    align = align or ["---"] * len(header)
    return "\n".join([_row(header), _row(align)] + [_row(r) for r in rows])


def _pct(bps):
    return f"{bps / 100:.1f}%"


# ----------------------------------------------------------------------------- prices
def packages_block():
    ts = tiers()
    rows = [
        ["Monthly, ex GST"] + [f"**{aud_short(t['pricing']['monthly']['cents'])}**" for t in ts],
        ["Monthly incl. 10% GST"] + [aud(incl_gst(t["pricing"]["monthly"]["cents"])) for t in ts],
        ["Included minutes / month"] + [f"{t['pricing']['includedMinutes']:,}" for t in ts],
        ["Extra minutes, ex GST"] + [f"{aud_short(t['pricing']['overagePerMinute']['cents'])}/min" for t in ts],
        ["Included SMS segments / month"] + [f"{t['pricing']['includedSmsSegments']:,}" for t in ts],
        ["Calendars / locations / numbers"] + [f"{t['inclusions']['calendars']} / {t['inclusions']['locations']} / {t['inclusions']['phoneNumbers']}" for t in ts],
        ["Minimum term (from Acceptance)"] + [f"{t['pricing']['minimumTermMonths']} months" for t in ts],
    ]
    return "\n\n".join([
        _table([""] + list(TIER_NAMES), rows, ["---", "---:", "---:", "---:"]),
        f"Approved by the owner on {approved_on()} (catalogue {CATALOGUE['catalogueVersion']}). "
        f"Prices are ex GST, {GST_SHORT} (M&U is GST registered). {SETUP_LINE}.",
        f"**Invoice example:** {invoice_example_text(markdown=True)}",
    ])


STATE = {"available": "✓ live", "at-go-live": "at go-live", "not-offered": "not offered"}


def comparison_block():
    ts = tiers()
    scope_ids, labels = [], {}
    for t in reversed(ts):  # the highest tier's wording labels the row
        for f in t["scope"]:
            if f["id"] not in labels:
                scope_ids.append(f["id"]); labels[f["id"]] = f["label"]
    order = [f["id"] for t in ts for f in t["scope"]]
    scope_ids.sort(key=order.index)

    def state(t, sid):
        f = next((x for x in t["scope"] if x["id"] == sid), None)
        if not f:
            return "—"
        # A tier whose wording differs from the row label shows its own wording (e.g. Essential's cover).
        return STATE[f["state"]] + (f": {f['label']}" if f["label"] != labels[sid] else "")

    def onboarding(t):
        hours = econ(t["catalogueId"])["setup"]["labourCents"] // ECONOMICS["assumptions"]["labourHourlyCents"]
        extra = " + 30-day hypercare" if any("hypercare" in o for o in t["onboarding"]) else ""
        return f"~{hours} hours of M&U work{extra}"

    rows = [
        ["Best for"] + [t["audience"] for t in ts],
        ["Monthly, ex GST"] + [f"**{aud_short(t['pricing']['monthly']['cents'])}**" for t in ts],
        ["Monthly incl. 10% GST"] + [aud(incl_gst(t["pricing"]["monthly"]["cents"])) for t in ts],
        ["Setup"] + [setup_text(t) for t in ts],
        ["Included minutes / month"] + [f"{t['pricing']['includedMinutes']:,}" for t in ts],
        ["Extra minutes, ex GST"] + [f"{aud_short(t['pricing']['overagePerMinute']['cents'])}/min" for t in ts],
        ["Included SMS segments / month"] + [f"{t['pricing']['includedSmsSegments']:,}" for t in ts],
        ["Extra SMS, ex GST"] + [f"{aud_short(t['pricing']['extraSmsSegment']['cents'])}/segment" for t in ts],
        ["Phone numbers / locations"] + [f"{t['inclusions']['phoneNumbers']} / {t['inclusions']['locations']}" for t in ts],
        ["Connected calendars (Google Calendar or Cal.com)"] + [str(t["inclusions"]["calendars"]) for t in ts],
        ["Cover modes (per configuration)"] + [cover_text(t) for t in ts],
    ] + [[labels[sid]] + [state(t, sid) for t in ts] for sid in scope_ids] + [
        ["Practice software integration"] + ["not offered" for _ in ts],
        ["Support hours"] + [t["support"]["hours"] for t in ts],
        ["First response"] + [t["support"]["firstResponse"] for t in ts],
        ["Reviews"] + [t["support"]["reviews"] for t in ts],
        ["Onboarding"] + [onboarding(t) for t in ts],
        ["Minimum term (starts at Acceptance)"] + [f"{t['pricing']['minimumTermMonths']} months" for t in ts],
        ["Notice after minimum term"] + [f"{t['pricing']['noticeDays']} days" for t in ts],
        ["Fair use: simultaneous calls"] + [f"up to {t['inclusions']['concurrentCallsFairUse']}" for t in ts],
    ]
    ess = ts[0]["pricing"]
    billing = ess["billing"]
    return "\n\n".join([
        _table([""] + [f"**{n}**" for n in TIER_NAMES], rows),
        "## Billing rules (all tiers)\n"
        f"- Minutes are counted **per second**, **added up across the month**, and rounded **up to the next whole minute once** per billing period (receptionist setting `roundingMode = {billing['receptionistRoundingMode']}`).\n"
        f"- {', '.join([billing['excluded'][0]] + [(x[0].lower() + x[1:]) if x[1:2].islower() else x for x in billing['excluded'][1:]])} don't count.\n"
        "- Included minutes and SMS **reset monthly and don't roll over**.\n"
        f"- Monthly billing starts at Acceptance. {BILLING_PENDING} Extra minutes and SMS are billed in arrears on the next monthly invoice.\n"
        f"- {GST_SENTENCE}\n"
        f"- {SETUP_LINE}. No invoice carries a setup line.",
        "## Invoice example\n" + _table(["Line", "Ex GST"], invoice_example_rows(), ["---", "---:"])
        + "\n\nNo setup line.",
    ])


# ----------------------------------------------------------------------------- economics (07)
def _fx_aud(usd_micros):
    """USD micros -> AUD cents (float), with the card/FX buffer, as the economics model does."""
    fx = ECONOMICS["assumptions"]["fx"]
    return usd_micros / fx["usdPerAudMillionths"] * 100 * (1 + fx["cardFeeBps"] / 10000)


def inputs_block():
    a = ECONOMICS["assumptions"]
    rows = []
    for c in ECONOMICS["costEvidence"]:
        if c["estimatedMicros"] is None:
            est = "**unknown: excluded, not zero**"
        else:
            # The webhook rate is quoted per 1M invocations (quantityPer in src/lib/business-economics.ts).
            unit = "1M webhook events" if c["basis"] == "webhook-event" else c["basis"].replace("-", " ")
            cur = "US$" if c["currency"] == "USD" else "A$"
            v = c["estimatedMicros"] / 1e6
            est = f"{cur}{v:,.4f}".rstrip("0").rstrip(".") + f" per {unit}"
            if c["currency"] == "USD" and c["basis"] != "webhook-event":
                est += f" (≈ A${_fx_aud(c['estimatedMicros']) / 100:,.3f})"
        src = f"[{c['source'].split('//')[1].split('/')[0]}]({c['source']})" if c["source"] else "—"
        rows.append([c["label"], est, src, c["checkedAt"]])
    fx = a["fx"]; pay = a["payment"]; s = a["stripeFrom20261001"]
    base5 = {t["shortName"]: base_at(t["catalogueId"])[1] for t in tiers()}
    per_min = {v["perMinuteCents"] for v in base5.values()}
    notes = [
        f"- **FX:** RBA {fx['usdPerAudMillionths'] / 1e6:.4f} USD per AUD ({fx['date']}), plus a {fx['cardFeeBps'] / 100:.0f}% card/FX buffer.",
        f"- **Payments:** modelled at {pay['percentBps'] / 100:.1f}% + A${pay['fixedCents'] / 100:.2f} on the GST-inclusive charge (Stripe card {s['percentBps'] / 100:.1f}% from 1 Oct 2026, checked {s['checkedAt']}, plus Stripe Billing).",
        f"- **Labour:** A${a['labourHourlyCents'] // 100}/hour for onboarding and support (assumption).",
        f"- **GST:** {a['gst']}",
        f"- **Variable cost per connected minute ≈ A${min(per_min) / 100:.2f}** (Retell US${ECONOMICS['costEvidence'][0]['estimatedMicros'] / 1e6:.2f}/min, which includes Claude 4.5 Haiku and the ElevenLabs voice tier, plus Twilio SIP). "
        f"Unknown costs ({', '.join(a['unknownCosts'])}) are excluded, not zero.",
    ]
    return _table(["Cost", "Estimate", "Source", "Checked"], rows) + "\n\n" + "\n".join(notes)


def tier_economics_block():
    ts = tiers()
    n = 5
    e = {t["shortName"]: base_at(t["catalogueId"], n)[1] for t in ts}
    sc = {t["shortName"]: base_at(t["catalogueId"], n)[0] for t in ts}
    per = lambda name, k: aud(round(e[name][k] / n))
    rows = [
        ["Price"] + [aud_short(t["pricing"]["monthly"]["cents"]) for t in ts],
        ["Base usage"] + [f"{sc[x]['minutesPerClient']:,} min, {sc[x]['smsSegmentsPerClient']} SMS, {sc[x]['supportMinutesPerClient']} support min" for x in TIER_NAMES],
        ["Variable cost (voice, carrier, numbers, SMS, payment fees)"] + [per(x, "variableCostCents") for x in TIER_NAMES],
        ["**Gross contribution**"] + [f"{per(x, 'contributionCents')} (**{_pct(e[x]['contributionMarginBps'])}**)" for x in TIER_NAMES],
        ["Support labour"] + [per(x, "supportCents") for x in TIER_NAMES],
        [f"Shared platform (Vercel ÷ {n})"] + [per(x, "sharedPlatformCents") for x in TIER_NAMES],
        ["**Margin after allocated costs**"] + [f"{per(x, 'operatingContributionCents')} (**{_pct(e[x]['operatingMarginBps'])}**)" for x in TIER_NAMES],
        ["Overage price / floor at 70% marginal margin"] + [f"{aud_short(t['pricing']['overagePerMinute']['cents'])} / {aud(e[t['shortName']]['overageFloorExGstCents'])}" for t in ts],
        ["Minutes the base price funds before overage (break-even)"] + [f"~{e[x]['breakEvenIncludedMinutes']:,}" for x in TIER_NAMES],
        ["Setup (proposed, not approved, not quoted): price / labour / contribution"] + [
            f"{aud_short(econ(t['catalogueId'])['setup']['revenueExGstCents'])} / {econ(t['catalogueId'])['setup']['labourCents'] // ECONOMICS['assumptions']['labourHourlyCents']} h / {aud(econ(t['catalogueId'])['setup']['contributionCents'])}"
            for t in ts],
    ]
    be = {e[x]["breakEvenClients"] for x in TIER_NAMES}
    tail = (f"Client break-even (covering Vercel Pro) is **{max(be)} client{'s' if max(be) != 1 else ''}** in every tier."
            if len(be) == 1 else "Client break-even: " + ", ".join(f"{x} {e[x]['breakEvenClients']}" for x in TIER_NAMES) + ".")
    return (_table([""] + list(TIER_NAMES), rows, ["---", "---:", "---:", "---:"]) + "\n\n" + tail
            + " The setup row is internal modelling only: setup fees are proposed and are never quoted or invoiced.")


def margin_grid_block():
    rows = []
    counts = None
    for t in tiers():
        for s in econ(t["catalogueId"])["scenarios"]:
            counts = [c["clients"] for c in s["byClients"]]
            rows.append([t["shortName"], s["label"], f"{s['minutesPerClient']:,}"] + [_pct(c["estimated"]["operatingMarginBps"]) for c in s["byClients"]])
    header = ["Tier", "Usage", "Min/client"] + [f"{c} client{'s' if c != 1 else ''}" for c in counts]
    return _table(header, rows, ["---", "---", "---:"] + ["---:"] * len(counts))


def estimate_status_block():
    rows = []
    for c in ECONOMICS["costEvidence"]:
        if c["basis"] not in ("minute", "number-month", "sms-segment") or c["estimatedMicros"] is None:
            continue
        est = f"US${c['estimatedMicros'] / 1e6:,.4f}".rstrip("0").rstrip(".") if c["currency"] == "USD" else "—"
        meas = f"US${c['measuredMicros'] / 1e6:.4f}" if c["measuredMicros"] is not None else "**empty**: " + c["measuredReason"].split(". ")[0].rstrip(".")
        inv = f"US${c['invoiceReconciledMicros'] / 1e6:.4f}" if c["invoiceReconciledMicros"] is not None else "**empty**: no invoice matched yet"
        rows.append([c["label"], est, meas, inv])
    unknown = [c["label"] for c in ECONOMICS["costEvidence"] if c["estimatedMicros"] is None]
    rows.append(["; ".join(unknown), "**unknown (excluded, not zero)**", "empty", "empty"])
    return _table(["Cost", "Estimated", "Measured", "Invoice-reconciled"], rows)


def readme_block():
    ts = tiers()
    rows = []
    for t in ts:
        q = t["pricing"]; b = base_at(t["catalogueId"])[1]
        rows.append([t["shortName"], aud_short(q["monthly"]["cents"]), aud(incl_gst(q["monthly"]["cents"])), f"{q['includedMinutes']:,}",
                     aud_short(q["overagePerMinute"]["cents"]), f"{q['includedSmsSegments']:,}", _pct(b["operatingMarginBps"])])
    return "\n\n".join([
        _table(["Tier", "Monthly, ex GST", "Incl. 10% GST", "Minutes", "Extra minute", "SMS", "Base margin after allocated costs (5 clients, estimate)"],
               rows, ["---", "---:", "---:", "---:", "---:", "---:", "---:"]),
        f"Approved {approved_on()}, ex GST, {GST_SHORT}. {SETUP_LINE}.",
        f"**Invoice example:** {invoice_example_text(markdown=True)}",
    ])


BLOCKS = {
    CALL_PACK / "01-offer.md": {"packages": packages_block},
    CALL_PACK / "11-package-comparison.md": {"comparison": comparison_block},
    CALL_PACK / "07-unit-economics-and-jev.md": {"inputs": inputs_block, "tier-economics": tier_economics_block,
                                                  "margin-grid": margin_grid_block, "estimate-status": estimate_status_block},
    PACK / "README.md": {"packages": readme_block},
}


def render(path, text):
    for name, fn in BLOCKS[path].items():
        end = f"<!-- /generated:{name} -->"
        pat = re.compile(rf"(<!-- generated:{re.escape(name)} [^>]*-->\n)(.*?)\n?{re.escape(end)}", re.S)
        if not pat.search(text):
            raise SystemExit(f"{path.name}: missing block markers for '{name}'")
        body = fn()
        text = pat.sub(lambda m: m.group(1) + body + "\n" + end, text)
    return text


def run(check=False):
    stale = []
    for path in BLOCKS:
        old = path.read_bytes().decode("utf-8")
        new = render(path, old)
        if new != old:
            stale.append(path)
            if not check:
                path.write_bytes(new.encode("utf-8"))  # bytes: keep LF on Windows
    return stale


if __name__ == "__main__":
    check = "--check" in sys.argv
    stale = run(check)
    for p in stale:
        print(("STALE " if check else "wrote ") + str(p.relative_to(DOCS.parent)))
    if check and stale:
        sys.exit(1)
    print("markdown blocks", "stale" if (check and stale) else "ok")
