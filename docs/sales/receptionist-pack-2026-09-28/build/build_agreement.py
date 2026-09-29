"""Australian service agreement DRAFT (.docx). Clauses needing a lawyer are flagged inline."""
from common import *

REVIEW = "<span class='flag'>[FOR QUALIFIED LEGAL REVIEW]</span>"
tiers = tiers()
ess = tiers[0]
min_sec = ess["pricing"]["billing"]["minimumBillableSeconds"]

processors = [
    ["Retell AI, Inc.", "United States", "Voice agent platform: speech recognition, voice, call recordings and transcripts, call metadata"],
    ["Twilio Inc.", "United States", "Australian phone number, call carriage (SIP), SMS sending and STOP handling"],
    ["Anthropic, PBC (through Retell)", "United States", "Language model that generates the receptionist's replies during the call (model at go-live to be confirmed in writing)"],
    ["Vercel Inc.", "United States (hosting region to be confirmed)", "Hosting of the receptionist application, dashboards and webhooks"],
    ["Neon (managed Postgres)", "Database region: Sydney, Australia (provider is US-based)", "Bookings, call records, messages, SMS log, consent and opt-out records"],
    [fill("Email alert provider, named before go-live"), fill("location"), "Staff alert emails for bookings and urgent messages"],
    ["Stripe Payments Australia", "Australia / United States", "Your billing only (no caller data)"],
    ["TypeSafe AI (only if the call-quality add-on is enabled)", "United States", "Yes/no quality checks on text with names, numbers, emails, dates of birth and addresses removed first"],
]

sched1 = [
    ["Package", "Essential", "Professional", "Premium"],
]
rows1 = [
    ["Monthly fee (ex GST)"] + [aud_short(t["pricing"]["monthly"]["cents"]) for t in tiers],
    ["Setup"] + [setup_text(t) for t in tiers],
    ["Included minutes per billing month"] + [f"{t['pricing']['includedMinutes']:,}" for t in tiers],
    ["Extra minutes (ex GST)"] + [aud_short(t["pricing"]["overagePerMinute"]["cents"]) + "/min" for t in tiers],
    ["Cover modes"] + [cover_text(t) for t in tiers],
    ["Included SMS segments / extra (ex GST)"] + [f"{t['pricing']['includedSmsSegments']:,} / {aud_short(t['pricing']['extraSmsSegment']['cents'])}" for t in tiers],
    ["Numbers / locations / calendars"] + [f"{t['inclusions']['phoneNumbers']} / {t['inclusions']['locations']} / {t['inclusions']['calendars']}" for t in tiers],
    ["Simultaneous calls (fair use)"] + [str(t["inclusions"]["concurrentCallsFairUse"]) for t in tiers],
    ["Minimum Term from Acceptance"] + [f"{t['pricing']['minimumTermMonths']} months" for t in tiers],
    ["First response (Support Hours)"] + [t["support"]["firstResponse"] for t in tiers],
]

body = f"""
<h1>AI Receptionist Service Agreement</h1>
<p class='lead'>M&amp;U Ventures and {fill('Client legal name')} · Draft {CATALOGUE['catalogueVersion']}</p>
<div class='warn'><b>DRAFT FOR QUALIFIED LEGAL REVIEW. NOT FOR CLIENT USE.</b> Prepared by M&amp;U Ventures from its own understanding of the service; it is not legal advice. Every clause marked {REVIEW} must be reviewed by an Australian lawyer before any client signs. Pay particular attention to the unfair contract terms regime for standard form small business contracts (Australian Consumer Law, Competition and Consumer Act 2010 (Cth), Sch 2, Pt 2-3), the Privacy Act 1988 (Cth), the Health Records and Information Privacy Act 2002 (NSW), the Surveillance Devices Act 2007 (NSW) and the Spam Act 2003 (Cth).</div>

<h2>Parties</h2>
<p><b>M&amp;U Ventures</b> {fill('legal entity name and structure')}, ABN {fill('ABN')}, {fill('address')} ("<b>M&amp;U</b>", "we").<br>
<b>{fill('Client legal name')}</b>, ABN {fill('ABN')}, {fill('address')} ("<b>Client</b>", "you").</p>

<h2>1. Definitions</h2>
<p><b>Acceptance</b>: the day you confirm in writing that the go-live tests in Schedule 3 have passed on your configuration: {ACCEPTANCE_TESTS.replace('your connected calendar', 'your Connected Calendar')}. <b>Connected Calendar</b>: a Google Calendar or Cal.com calendar you control and connect to the Service. <b>Caller</b>: a person who calls your Receptionist Line. <b>Caller Data</b>: personal information about Callers processed through the Service, including recordings, transcripts, names, phone numbers and booking details. <b>Receptionist Line</b>: the phone number(s) we provide for the Service. <b>Package</b>: the package in your signed proposal, described in Schedule 1. <b>Support Hours</b>: {ess['support']['hours']}.</p>

<h2>2. The Service</h2>
<p>2.1 We provide an AI voice receptionist on your Receptionist Line that: tells each Caller it is an automated assistant and that the call is recorded; answers questions from the information you give us; takes messages and callback requests; and gives any Caller who uses urgent or life-threatening words the instruction to hang up and call 000 before anything else.</p>
<p>2.2 <b>Booking Mode.</b> Your Package operates in exactly one of two modes, stated in Schedule 1 or your signed proposal: <b>"Booked"</b> — the Service checks availability, books the appointment types you release into your Connected Calendar, and reads back a booking reference to the Caller; or <b>"Booking request"</b> — where you have no Connected Calendar and we have not built a direct booking connection to your practice-management system (for example Dentally, Core Practice or D4W; some of these publish their own developer APIs, but we do not integrate with any of them today), the Service instead takes the Caller's name, number, reason and preferred time as a booking request, gives no reference number and books nothing, and you confirm it from the dashboard. Both modes are otherwise the same Service. {REVIEW}</p>
<p>2.3 Depending on your Package: SMS booking confirmations, reminders and callback confirmations (each with STOP opt-out); email alerts for bookings, booking requests and urgent messages; a monthly usage summary; a weekly call report; and M&amp;U review of flagged calls.</p>
<p>2.4 <b>Features that start at Acceptance.</b> Booking (or booking requests), email alerts and SMS are switched on for you only at Acceptance. Before Acceptance, your Receptionist Line, if forwarded at all, only takes messages.</p>
<p>2.5 <b>Not included:</b> live transfer of calls to a person (not offered in any Package; the Service takes a message instead); integration with practice-management software (Booking request mode above is a message taken for your own staff to enter, not an integration); outbound or marketing calls or messages; clinical, legal, financial or other professional advice; assessment of urgency or triage.</p>
<p>2.6 A booking is only confirmed to a Caller when your Connected Calendar confirms it. If the Service cannot book, or is in Booking request mode, it takes a message or request instead.</p>

<h2>3. Not an emergency service {REVIEW}</h2>
<p>3.1 The Service is not an emergency service and must not be relied on for emergencies. It does not monitor calls in real time, cannot contact emergency services and cannot assess anyone's condition. It tells Callers who use urgent words to hang up and call 000, but it may not recognise every emergency.</p>
<p>3.2 You must keep your own arrangements for urgent and after-hours matters (for example an on-call number or recorded message) and tell us the wording you want Callers to hear.</p>

<h2>4. Term, Acceptance and cancellation {REVIEW}</h2>
<p>4.1 This agreement starts when both parties sign it. Fees are not payable, and the Minimum Term does not start, until Acceptance.</p>
<p>4.2 If Acceptance has not happened within {fill('60')} days of signing, either party may end this agreement by written notice; under clause 4.1 no fees will have become payable.</p>
<p>4.3 After Acceptance the agreement runs for the Minimum Term in Schedule 1, then continues month to month until either party gives {ess['pricing']['noticeDays']} days' written notice.</p>
<p>4.4 You may switch call forwarding off at any time. That stops calls reaching the Service but does not end this agreement or the Minimum Term.</p>
<p>4.5 Either party may end this agreement immediately by notice if the other materially breaches it and does not fix the breach within 14 days of notice, or becomes insolvent.</p>
<p>4.6 If you end the agreement during the Minimum Term other than under clause 4.5, the monthly fees for the rest of the Minimum Term become payable. {REVIEW}</p>

<h2>5. Fees, usage and billing {REVIEW}</h2>
<p>5.1 Fees are in Schedule 1 and in your signed proposal, in Australian dollars, excluding GST.</p>
<p>5.2 <b>GST.</b> M&amp;U is registered for GST. It adds GST at the prevailing rate (currently 10%) to each taxable supply under this agreement and issues a tax invoice.</p>
<p>5.3 Monthly fees are payable from Acceptance. {DECISION_B} Extra minutes and extra SMS are invoiced monthly in arrears. Setup is quoted separately once approved.</p>
<p>5.4 <b>How minutes are counted.</b> Connected call time is measured by the second, added up over the billing month and rounded up to the next whole minute once. Calls shorter than {min_sec} seconds, calls that never reach the receptionist, and our test and demonstration calls are not counted. Included minutes and SMS reset each billing month and do not roll over.</p>
<p>5.5 An SMS segment is one billed message part; a long message may use more than one segment.</p>
<p>5.6 Invoices are payable within 14 days by card or bank transfer. If an invoice is more than 30 days overdue, we may suspend the Service after giving 7 days' written notice.</p>
<p>5.7 We may change fees on 60 days' written notice, but not during the Minimum Term. If you do not accept a change you may end the agreement before it takes effect without paying anything further. {REVIEW}</p>
<p>5.8 If your usage is regularly above your included minutes, we will tell you and suggest a Package that fits before extra charges build up.</p>

<h2>6. Your responsibilities</h2>
<p>6.1 Give us accurate business information (hours, services, appointment lengths, fees you want quoted, urgent wording) and tell us promptly about changes.</p>
<p>6.2 Connect and maintain your Connected Calendar, release only the appointment types and times the Service may book, and check bookings it makes.</p>
<p>6.3 Arrange call forwarding with your phone provider in the cover modes your Package includes (Schedule 1) and keep your existing voicemail or answering arrangement as a fallback. We will give you the relevant carrier codes; you dial them yourself, and your business number is never changed or ported.</p>
<p>6.4 Before Acceptance, update your privacy policy and collection notices to describe the Service, call recording and the overseas recipients in Schedule 2. We will give you suggested wording; you are responsible for your own policy. {REVIEW}</p>
<p>6.5 Not use the Service for unlawful purposes, marketing calls or messages, or to collect information you are not permitted to collect.</p>
<p>6.6 Never send us passwords or patient records. Calendar access is granted from your own account.</p>

<h2>7. Privacy and data roles {REVIEW}</h2>
<p>7.1 <b>Roles.</b> You decide why Caller Data is collected and how it is used. We handle Caller Data only to provide the Service to you, on your instructions, and for billing, security and quality of the Service. We agree to handle Caller Data as if we were bound by the Australian Privacy Principles in the Privacy Act 1988 (Cth), whether or not we are an APP entity, and to comply with the Health Records and Information Privacy Act 2002 (NSW) where it applies. {REVIEW}</p>
<p>7.2 <b>Health information.</b> Callers may volunteer health information. The Service is set up to collect only what is needed for a booking or message and does not ask for symptoms or clinical detail. Health information is sensitive information and you and we must handle it accordingly.</p>
<p>7.3 <b>Recording.</b> Every call starts with a statement that it is recorded. Recording and transcription are part of how the Service works.</p>
<p>7.4 <b>Overseas disclosure (APP 8).</b> Caller Data is processed by the service providers in Schedule 2, including in the United States. We will take reasonable steps to ensure they handle it consistently with the APPs and will give you 30 days' notice before adding a provider that changes the countries in Schedule 2. {REVIEW}</p>
<p>7.5 <b>Retention.</b> We keep recordings, transcripts and call records for {fill('30 / 60 / 90')} days (agreed at onboarding), then delete or de-identify them, except billing records (duration and counts, without content), which we keep as long as tax law requires. {REVIEW}</p>
<p>7.6 <b>Security.</b> We use access controls, encryption in transit, tenant isolation and signed provider webhooks, and limit staff access to what is needed.</p>
<p>7.7 <b>Data breaches.</b> If we become aware of unauthorised access to or loss of Caller Data, we will tell you without undue delay and in any case within 72 hours, and help you assess and, if required, notify under the Notifiable Data Breaches scheme (Privacy Act Part IIIC). {REVIEW}</p>
<p>7.8 <b>Access and correction requests</b> from Callers are handled by you; we will help within 10 business days.</p>
<p>7.9 <b>End of agreement.</b> After this agreement ends, Caller Data continues to be deleted or de-identified on the retention period in clause 7.5; we do not keep it longer except where the law requires. We have no self-service export tool: if you ask before the agreement ends, we will tell you which booking and message records we can reasonably provide and in what form. Bookings made in Booked mode are already in your own Connected Calendar. {REVIEW}</p>

<h2>8. SMS {REVIEW}</h2>
<p>8.1 SMS are sent only to a Caller who agrees on the call, only about their booking or request, and never for marketing. Each message identifies your business and says "Reply STOP to opt out". Opt-outs are honoured automatically. Reminders are not sent between 8pm and 9am in your time zone.</p>
<p>8.2 Messages are sent from {fill('+61 485 011 208 or a number provided for you')}. {REVIEW}</p>

<h2>9. Third-party providers</h2>
<p>9.1 The Service depends on the providers in Schedule 2 and on telephone networks. Their outages, changes and pricing are outside our control. We will tell you about any outage we become aware of that affects your Receptionist Line and restore service as soon as we reasonably can.</p>
<p>9.2 We may change a provider to maintain or improve the Service, subject to clause 7.4.</p>

<h2>10. Support and service levels</h2>
<p>10.1 Support is by email and phone during Support Hours. First-response targets are in Schedule 1. Targets are not guarantees. {REVIEW}</p>
<p>10.2 We do not guarantee that the Service will be uninterrupted or error-free. If calls cannot reach the Service, your phone provider's fallback (for example voicemail) applies.</p>

<h2>11. Limitations {REVIEW}</h2>
<p>11.1 The Service uses artificial intelligence and can make mistakes, including mishearing, misunderstanding or giving incomplete information. You must review bookings and messages.</p>
<p>11.2 We do not promise any number of calls answered, bookings, patients, revenue or other business outcome.</p>
<p>11.3 Nothing in this agreement excludes, restricts or modifies any right or remedy, or any guarantee, warranty or other term or condition, implied or imposed by the Australian Consumer Law or other legislation that cannot lawfully be excluded, restricted or modified.</p>
<p>11.4 To the extent permitted by law, our total liability under or in connection with this agreement is limited to the fees you paid in the 3 months before the event giving rise to the claim, and neither party is liable for indirect or consequential loss. This limit does not apply to our obligations under clause 7 or to liability that cannot be limited by law. {REVIEW}</p>

<h2>12. Intellectual property and confidentiality</h2>
<p>12.1 We own the Service, our prompts, software and templates. You own your business information and Caller Data. You give us a licence to use your information only to provide the Service.</p>
<p>12.2 Each party keeps the other's confidential information confidential and uses it only for this agreement.</p>

<h2>13. General</h2>
<p>13.1 This agreement is governed by the laws of New South Wales. Before starting proceedings (except for urgent relief), the parties will try in good faith to resolve a dispute by discussion for 20 business days. {REVIEW}</p>
<p>13.2 Notices must be in writing and may be sent by email to the addresses below.</p>
<p>13.3 This agreement, your signed proposal and the Schedules are the entire agreement. If they conflict, the signed proposal prevails on price and Package, and this agreement prevails on everything else.</p>

<h2>Signatures</h2>
{table(['', 'For M&amp;U Ventures', 'For the Client'], [
    ['Name', fill('authorised signatory'), fill('name')],
    ['Role', fill('role'), fill('role')],
    ['Email for notices', fill('email'), fill('email')],
    ['Signature', '', ''],
    ['Date', '', ''],
], widths=[20, 40, 40])}

<h2>Schedule 1: Packages (the signed proposal states the Client's Package)</h2>
{table(sched1[0], rows1, widths=[34, 22, 22, 22])}
<p class='small'>Support Hours: {ess['support']['hours']}. Fair use: inbound calls to the Client's own business number(s) only. Booking Mode (clause 2.2): <b>{fill('Booked / Booking request')}</b>, per the Client's signed proposal. Catalogue {CATALOGUE['catalogueVersion']}; monthly prices approved {approved_on()}; prices ex GST, {GST_SHORT} (clause 5.2). {SETUP_LINE}.</p>

<h2>Schedule 2: Service providers that may process Caller Data {REVIEW}</h2>
{table(['Provider', 'Location', 'What it does'], processors, widths=[30, 25, 45])}
<p class='small'>Locations to be confirmed with each provider's current terms before first client use. Stripe processes only the Client's billing details.</p>

<h2>Schedule 3: Onboarding and Acceptance</h2>
<p>(1) Kickoff call and setup checklist, including which Booking Mode applies (clause 2.2); (2) you choose the cover modes for your Receptionist Line (clause 6.3); (3) if in Booked mode, you connect your Connected Calendar and release the appointment types it may book; (4) we configure the Service and you update your privacy policy (clause 6.4); (5) you switch on call forwarding yourself in the agreed cover modes (before Acceptance the Receptionist Line only takes messages, clause 2.4); (6) the go-live tests, as scripted test calls: {ACCEPTANCE_TESTS}; (7) Acceptance (clause 1), when you confirm in writing that those tests passed.</p>
"""

if __name__ == "__main__":
    pdf, pages = build_docx(html_doc(body), PACK / "service-agreement-draft.docx",
                            "DRAFT FOR QUALIFIED LEGAL REVIEW · NOT FOR CLIENT USE · M&U Ventures AI Receptionist Service Agreement",
                            f"Draft {CATALOGUE['catalogueVersion']}")
    print(pdf, pages, len(rasterise(pdf, "service-agreement-draft")))
