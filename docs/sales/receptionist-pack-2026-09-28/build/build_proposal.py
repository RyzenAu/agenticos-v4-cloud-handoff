"""Proposal template (.docx). Default selected package: Essential. Yellow fields are for the sender."""
from common import *

sel = pkg("Essential")
pr = sel["pricing"]; disp = sel["display"]; inc = sel["inclusions"]


def price_rows(p):
    q = p["pricing"]
    monthly, over, sms = q["monthly"]["cents"], q["overagePerMinute"]["cents"], q["extraSmsSegment"]["cents"]
    return [
        ["Monthly fee (starts at Acceptance; timing below)", aud_short(monthly), aud(incl_gst(monthly))],
        ["Included minutes each month", f"{q['includedMinutes']:,}", "—"],
        ["Extra minutes (billed in arrears)", aud_short(over) + "/min", aud(incl_gst(over)) + "/min"],
        ["Included SMS segments each month", f"{q['includedSmsSegments']:,}", "—"],
        ["Extra SMS segments", aud_short(sms) + "/segment", aud(incl_gst(sms)) + "/segment"],
        ["Minimum term (starts at Acceptance)", f"{q['minimumTermMonths']} months", "—"],
        ["Notice after the minimum term", f"{q['noticeDays']} days", "—"],
        ["Setup", setup_text(p), "—"],
    ]


EXAMPLE = invoice_example()
ESS_A = ""  # decision (a) settled 1 Oct 2026: no placeholder
SETTLE = settle_in(sel)
state_label = {"available": "Live today", "at-go-live": "At go-live", "not-offered": "Not included"}
scope_rows = [[f["label"], state_label[f["state"]]] for f in sel["scope"]]

tiers = tiers()
compare = [
    ["Monthly, ex GST"] + [aud_short(t["pricing"]["monthly"]["cents"]) for t in tiers],
    ["Monthly, incl. 10% GST"] + [aud(incl_gst(t["pricing"]["monthly"]["cents"])) for t in tiers],
    ["Included minutes"] + [f"{t['pricing']['includedMinutes']:,}" for t in tiers],
    ["Extra minutes"] + [aud_short(t["pricing"]["overagePerMinute"]["cents"]) + "/min" for t in tiers],
    ["Included SMS segments"] + [f"{t['pricing']['includedSmsSegments']:,}" for t in tiers],
    ["Cover modes"] + [cover_text(t) for t in tiers],
    ["Calendars / locations / numbers"] + [f"{t['inclusions']['calendars']} / {t['inclusions']['locations']} / {t['inclusions']['phoneNumbers']}" for t in tiers],
    ["First response (business hours)"] + [t["support"]["firstResponse"] for t in tiers],
    ["Minimum term"] + [f"{t['pricing']['minimumTermMonths']} months" for t in tiers],
]

body = f"""
<p class='small'>M&amp;U Ventures · Mount Druitt NSW · ABN {fill('ABN')} · {fill('business phone')} · {fill('email')}</p>
<h1>Proposal: AI booking receptionist</h1>
<p class='lead'>Prepared for {fill('Practice name')} · {fill('Contact name, role')} · {fill('Date')} · Valid for 30 days</p>

<div class='warn'><b>Template notes for M&amp;U (delete this box before sending):</b> yellow fields must be replaced. The yellow [OWNER DECISION …] fields are open owner decisions: only Usman settles them, so don't reword or delete them. The selected package below defaults to <b>Essential</b>; for Professional or Premium, copy that column from Appendix A into sections 2 and 3. Fill in the cover and booking mode (section 2) from your qualification notes before sending. Monthly prices were approved on {approved_on()} (catalogue {CATALOGUE['catalogueVersion']}); setup fees are not approved, so never add a setup amount. There is no pilot or trial offer. Usman approves before sending. Don't attach the service agreement until it has had qualified legal review.</div>

<h2>1. What you told us</h2>
<p>{fill('One or two sentences in their words: which calls they want covered (after hours, overflow, or all calls alongside the team), roughly how many a week (their number), where bookings live, which appointment types may be booked by phone.')}</p>

<h2>2. What we'll set up: {sel['title']}</h2>
<div class='note'>{PROMISE}</div>
<p>An AI receptionist that answers your {fill('after-hours / busy and no-answer / all calls, where the package includes it')} calls on {fill('number')}, in the cover you choose ({sel['shortName']} includes: {', '.join(c.lower() for c in inc['coverModes'])}{ESS_A}). It tells every caller it is an automated assistant and that the call is recorded. At go-live, in Booked mode, it {BOOKS_INTO}, reads back a reference and texts the caller a confirmation if they agree; in Booking request mode it takes a booking request instead. Anything urgent gets the 000 line first, then an urgent message to your team.</p>
{table(['What it does', 'Status'], scope_rows, widths=[78, 22])}
<p class='small'><b>Live today</b> works on our demonstration line now. <b>At go-live</b> is built and switches on when it has passed our acceptance tests; it is switched on for you only at Acceptance (section 6). <b>Our demonstration line does not book appointments yet</b>; it takes a message.</p>

<h3>Which booking mode you'll get</h3>
<p>{DIRECT_BOOKING} It depends on what you told us about your booking system (section 1), not on your package.</p>
{table(['', 'Booked', 'Booking request / lead capture'], [
    ['When it applies', 'You run a connected Google Calendar or Cal.com calendar', "We don't book directly into your practice software (e.g. Dentally, Core Practice, D4W) — see the note below"],
    ['What the caller hears', 'The receptionist checks availability, books the slot and reads back a reference number', 'The receptionist takes name, number, reason and preferred time; no reference number, no promised time'],
    ['What you do', 'Nothing — it is already in your calendar', 'You commit to confirming each request from the dashboard, for example by the next business morning (your commitment, set in section 7)'],
], widths=[26, 37, 37])}
<p class='small'>Dentally publishes a public developer API ({fill('developer.dentally.co')}, checked 27 Sep 2026) that could support direct booking later. We have not built that integration; this is not offered today.</p>
<p><b>Your mode for this proposal: {fill('Booked / Booking request')}.</b></p>

<h3>Included</h3>
<ul>
<li>{inc['phoneNumbers']} Australian mobile number for your receptionist line; {inc['calendars']} connected Google Calendar or Cal.com calendar; {inc['locations']} location.</li>
<li>Cover modes: {', '.join(inc['coverModes'])}.{ESS_A}</li>
<li>SMS: {'; '.join(inc['sms'])}, with STOP opt-out.</li>
<li>Reports: {'; '.join(inc['reports'])}.</li>
<li>Support: {sel['support']['hours']}. First response: {sel['support']['firstResponse'].lower()}. {sel['support']['reviews']}.</li>
</ul>
<h3>Not included</h3>
<ul>
<li>Live transfer to a person (it isn't offered; the receptionist takes a message instead).</li>
<li>Integration with practice-management software (for example Dentally, Core Practice, Cliniko). Bookings go into the connected calendar and your team copies them across if needed.</li>
<li>Clinical, legal or financial advice, or assessment of urgency. It is not an emergency service.</li>
<li>Outbound or marketing calls or messages.</li>
</ul>

<h2>3. Price</h2>
<p>{GST_SENTENCE} Monthly prices approved {approved_on()}. {SETUP_LINE}.</p>
{table(['Item', 'Ex GST', 'Incl. 10% GST'], price_rows(sel), num_cols=(1, 2), widths=[52, 22, 26])}
<p class='small'><b>How minutes are counted:</b> by the second, added up over the billing month and rounded up to the next whole minute once. Calls under {pr['billing']['minimumBillableSeconds']} seconds, calls that never reach the receptionist, and our own test calls are not counted. Included minutes and SMS reset each month and do not roll over. Extra minutes and SMS are billed in arrears. {BILLING_PENDING}</p>
<h3>Invoice example</h3>
{table(['Line', 'Ex GST'], invoice_example_rows(), num_cols=(1,), widths=[74, 26])}
<p class='small'>Example only: {EXAMPLE['name']} with {EXAMPLE['minutes']:,} billable minutes in one month. No setup line.</p>

<h2>4. Terms</h2>
<div class='note'>Monthly billing and your minimum term start at Acceptance (section 6), once your own line has passed its go-live tests and you have confirmed them in writing. {BILLING_PENDING} You can switch call forwarding off at any time and your phones work exactly as they do today. The service agreement sets out the full terms.</div>

<h2>5. Timeline</h2>
{table(['Step', 'What happens', 'Typical timing'], [
    ['Start', 'Proposal accepted and agreement signed', fill('date')],
    ['Kickoff', '45-minute call: hours, services and appointment lengths, what may be booked by phone, urgent wording, alert contacts', 'Day 1'],
    ['Access', 'You grant calendar access from your own account and complete the setup checklist (no passwords or patient details)', 'Days 1–3'],
    ['Build', 'We configure the receptionist, knowledge summary, disclosures and SMS wording; you update your privacy policy with our suggested wording', 'Days 2–5'],
    ['Forwarding', 'You switch on call forwarding in the agreed cover so we can test it; until Acceptance your line only takes messages', 'Day 5'],
    ['Test', 'Five scripted test calls together: a booking (or booking request), an urgent-wording call, calls through your cover and forwarding, and a text if SMS is set up', 'Days 5–7'],
    ['Acceptance', 'The go-live tests pass and you confirm them in writing (section 6). Monthly billing and the minimum term start', 'Day 7'],
    ['Go-live', 'Booking, alerts and texts (as configured) switch on for your callers; forwarding stays on in the agreed cover', 'Day 7'],
    ['Settle in', f'{SETTLE} (what {sel["shortName"]} includes; daily review of flagged calls is Premium hypercare only)', 'Days 7–30'],
], widths=[14, 66, 20])}
<p class='small'>Timings start once booking has passed acceptance testing on our demonstration line and we have your calendar access and answers. We will confirm your start date in writing.</p>

<h2>6. Acceptance</h2>
<p>Acceptance happens when the go-live tests pass on your own configuration and you confirm them in writing (email is fine). The tests: {ACCEPTANCE_TESTS}. The booking test checks the correct time and details; a booking request must include name, number, reason and preferred time.</p>

<h2>7. Assumptions</h2>
<ul>
<li>If your mode is Booked: you use, or will create, a Google Calendar or Cal.com calendar containing the slots the receptionist may book. If your mode is Booking request / lead capture: your desk commits to checking and confirming requests {fill('each business morning / other agreed time')}; the receptionist doesn't confirm them for you.</li>
<li>You can change call forwarding with your phone provider (we send the codes; your number never changes), and keep your existing voicemail as a fallback.</li>
<li>Your privacy policy will mention the AI receptionist, call recording and our overseas service providers before go-live (we supply wording).</li>
<li>Call audio and transcripts are processed by our service providers, including in the United States. Details are in the service agreement.</li>
<li>Usage estimate: about {fill('N')} calls a month of about {fill('2–3')} minutes. If usage is regularly above the included minutes we will suggest the right package before extra minutes add up.</li>
<li>No guarantee of a particular number of bookings, patients or revenue.</li>
</ul>

<h2>8. Accept this proposal</h2>
{table(['', 'For ' + '[Practice name]', 'For M&amp;U Ventures'], [
    ['Name', fill('name'), fill('authorised signatory')],
    ['Role', fill('role'), fill('role')],
    ['Signature', '', ''],
    ['Date', '', ''],
], widths=[16, 42, 42])}
<p class='small'>Signing this proposal confirms the package and price. The service is provided under the M&amp;U Ventures service agreement, signed separately.</p>

<br style='page-break-before:always' clear='all'>
<h2>Appendix A: all packages (approved monthly plans, ex GST, + 10% GST)</h2>
{table(['', 'Essential', 'Professional', 'Premium'], compare, widths=[31, 23, 23, 23])}
<p class='small'>Every package includes the same live and at-go-live receptionist features, with reminders and the weekly proof report from Professional up, and weekly M&amp;U call review in Premium. Live transfer and practice-software integration are not included in any package. {SETUP_LINE}. Source: M&amp;U package catalogue {CATALOGUE['catalogueVersion']}, approved {approved_on()}; built {AS_OF}.</p>
"""

# Open owner decisions render as yellow fill-in fields, like the sender's fields (review T5).
body = fill_decisions(body)

if __name__ == "__main__":
    pdf, pages = build_docx(html_doc(body), PACK / "proposal-template.docx",
                            "M&U Ventures · Proposal template",
                            f"Catalogue {CATALOGUE['catalogueVersion']} · Prices ex GST, + 10% GST")
    print(pdf, pages, [str(p) for p in rasterise(pdf, "proposal-template")])
