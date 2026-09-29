"""Client onboarding deck (.pptx) with speaker notes: kickoff to first booking and the first 30 days."""
from common import *
from slides import Deck, W, H, M

ess, pro, pre = tiers()
EX = invoice_example()
d = Deck()

# 1 Welcome -------------------------------------------------------------------
s = d.slide(dark=True, footer=f"M&U Ventures · Onboarding · catalogue {CATALOGUE['catalogueVersion']}", notes=(
    "Kickoff call, 45 minutes. Only run this once booking go-live has been approved and has passed acceptance on our own demo line. "
    "Confirm the package from their signed proposal. Monthly billing starts at Acceptance; setup is quoted separately once approved, so never mention a setup amount."))
d.text(s, M, 80, 700, 30, "ONBOARDING", 14, bold=True, colour="5EEAD4")
d.text(s, M, 118, 760, 130, "From kickoff to your first booking", 46, colour=WHITE, font="Cambria")
d.text(s, M, 260, 700, 60, "[Practice name] · [Package] · Kickoff [date]", 18, colour="CBD5E1")
d.text(s, M, 330, 760, 80, "About a week to your first test booking once we have your calendar access and answers. Your booking, routing and texts are set up and tested before they go live.", 17, colour="E2E8F0")

# 2 The plan ------------------------------------------------------------------
s = d.slide(notes=(
    "Walk the timeline. Emphasise that steps 2, 4 and 5 are theirs: calendar access, the privacy policy and call forwarding. Acceptance is when monthly billing and the minimum term start. "
    "After go-live, each package gets the review it includes: Essential a setup review after 2 weeks, Professional a monthly check-in, Premium 30-day hypercare with daily call review for the first 2 weeks."))
d.title(s, "The plan", "Seven working days to Acceptance, then the review your package includes.")
steps = [("Kickoff", "Today: hours, services, what may be booked, urgent wording, alert contacts", "Day 1", "Us + you"),
         ("Access", "You connect your calendar and complete the setup checklist", "Days 1–3", "You"),
         ("Build", "We configure the receptionist, knowledge summary, disclosures and SMS wording", "Days 2–5", "Us"),
         ("Privacy policy", "You publish the updated wording (we supply a draft)", "Before go-live", "You"),
         ("Forwarding + test", "You switch on forwarding; go-live test calls together", "Days 5–7", "Us + you"),
         ("Acceptance + go-live", "Tests passed and confirmed by you in writing; booking switches on", "Day 7", "You")]
rows = [["", "Step", "What happens", "When", "Who"]] + [[str(i + 1), a, b, c, e] for i, (a, b, c, e) in enumerate(steps)]
d.table(s, rows, M, 125, W - 2 * M, [36, 170, 454, 110, 94], row_h=40, size=13, first_col_bold=False)

# 3 What we need --------------------------------------------------------------
s = d.slide(notes=(
    "Go through the setup checklist (client-setup-checklist.docx). Never accept passwords, API keys or patient details: calendar access is granted from their own account."))
d.title(s, "What we need from you", "The setup checklist takes about 30 minutes. No passwords or patient details, please.")
needs = [("Your practice", ["Name as callers should hear it", "Opening hours incl. lunch and public holidays", "Appointment types with lengths", "What a new patient may book"]),
         ("Calls and calendar", ["Google Calendar or Cal.com access", "Cover: after hours, overflow, or all calls", "Who can change call forwarding", "Voicemail stays as a fallback"]),
         ("Urgent and alerts", ["What urgent callers hear after hours", "Alert email address(es)", "Day-to-day contact", "Retention period: 30, 60 or 90 days"])]
for i, (h1, items) in enumerate(needs):
    x = M + i * 292
    d.box(s, x, 130, 272, 290, fill=MIST)
    d.dot(s, x + 20, 148, 40, fill=TEAL, label=str(i + 1), size=15)
    d.text(s, x + 20, 200, 232, 26, h1, 17, bold=True)
    d.text(s, x + 20, 236, 232, 180, items, 14, bullets=True, space_after=7, colour=INK)

# 4 Calendar ------------------------------------------------------------------
s = d.slide(notes=(
    "At go-live the receptionist books into a connected Google Calendar or Cal.com calendar only. If their diary lives in practice software, create a dedicated booking calendar and release only the slots they want booked. "
    "Each booking triggers an email so the team can copy it into their practice software. It only says 'booked' when the calendar confirms. Rescheduling or cancelling an earlier booking becomes a message."))
d.title(s, "Booked, or booking request?", "Booked: Google Calendar or Cal.com. Booking request / lead capture: everyone else.")
cal = [("1", "Booked: create or choose the calendar", "Your existing Google or Cal.com calendar, or a new dedicated booking calendar."),
       ("2", "Booked: release the slots", "Add the times and appointment types the receptionist may offer. Everything else stays yours."),
       ("3", "Grant access from your account", "During kickoff, on your screen. We never ask for a password."),
       ("4", "Booking request: no calendar at all", "We don't book directly into Dentally, Core Practice, D4W or similar (Dentally has an API; possible future direct booking, not built yet): the receptionist takes name, number, reason, preferred time. No reference number. Your desk commits to confirming each request (e.g. by the next business morning).")]
for i, (n, h1, b) in enumerate(cal):
    col, row = i % 2, i // 2
    x, y = M + col * 440, 130 + row * 150
    d.box(s, x, y, 420, 130, fill=(TEAL_LIGHT if i < 3 else MIST))
    d.dot(s, x + 18, y + 18, 40, fill=TEAL, label=n, size=15)
    d.text(s, x + 74, y + 20, 330, 24, h1, 16, bold=True)
    d.text(s, x + 74, y + 50, 330, 70, b, 13.5, colour=SLATE)
d.text(s, M, 440, W - 2 * M, 24, "Dentally publishes a public developer API (developer.dentally.co) — possible future direct booking, not offered today. Rescheduling or cancelling earlier bookings becomes a message.", 12.5, colour=SLATE, italic=True)

# 5 What callers hear --------------------------------------------------------
s = d.slide(notes=(
    "Agree the opening line and the urgent wording today. The greeting always includes the recording notice and AI disclosure (NSW all-party consent). "
    "The 000 line comes first on any urgent or life-threatening wording; it never assesses anyone."))
d.title(s, "What your callers will hear")
d.box(s, M, 120, 520, 150, fill=TEAL_LIGHT)
d.rich(s, M + 20, 138, 480, 120, [[("Greeting (we agree the wording today)", True, TEAL)],
                                   [("\"Thanks for calling [Practice]. This call is recorded. You're speaking with an automated assistant. How can I help?\"", False, None)]], size=15)
d.box(s, M, 290, 520, 150, fill="FFFBEB", line=AMBER)
d.rich(s, M + 20, 308, 480, 120, [[("Urgent or life-threatening words", True, AMBER)],
                                   [("\"If you're having trouble breathing or swallowing, or bleeding that won't stop, please hang up and call triple zero, 000.\" Then it takes an urgent callback message for your team, with the after-hours wording you choose.", False, None)]], size=15)
d.text(s, 600, 125, 312, 320, ["It books only the appointment types and times you release", "It confirms only when your calendar confirms, and reads back a reference", "It asks before sending a text; every text says Reply STOP to opt out", "No clinical advice, no triage, no fees you haven't published", "Asked for a person: it takes a message. Live transfer to a person isn't offered"], 14, bullets=True, space_after=10)

# 6 Privacy policy wording ----------------------------------------------------
s = d.slide(notes=(
    "Suggested wording only: the practice owns its privacy policy and should have its own adviser confirm it. It must be published before go-live. "
    "The provider list must match Schedule 2 of the service agreement at the time of go-live."))
d.title(s, "Your privacy policy: suggested wording", "Publish before go-live. You own your policy; please have it checked.")
d.box(s, M, 120, W - 2 * M, 215, fill=MIST)
d.text(s, M + 24, 140, W - 2 * M - 48, 220, [
    "\"We use an AI receptionist service, provided by M&U Ventures, to answer some phone calls and to book appointments. Calls to that service are recorded and transcribed. "
    "We collect only what we need to book or respond to your enquiry, such as your name, phone number and the appointment you want.",
    "Your call and booking details are processed by our service providers, some of which are located overseas, including in the United States (Retell AI, Twilio and Anthropic) and [other providers]. "
    "Our receptionist's booking database is in Sydney, Australia; your calendar provider and our call providers may store data overseas. We keep call recordings and transcripts for [30/60/90] days.",
    "If you agree on the call, we may send you an SMS about your booking. Reply STOP at any time to opt out.\""], 14, colour=INK, space_after=10)
d.text(s, M, 350, W - 2 * M, 50, "Relevant principles: APP 1 (open and transparent management), APP 5 (notification of collection), APP 8 (cross-border disclosure). This is not legal advice.", 12.5, colour=SLATE, italic=True)

# 7 Testing and Acceptance ----------------------------------------------------
s = d.slide(notes=(
    "Run the calls together on speaker, with forwarding already on in the agreed cover. Acceptance is the go-live test set passing on their own configuration: "
    "the booking (or, in Booking request mode, a complete request received), the 000 line first on urgent wording, calls reaching the receptionist through their cover and forwarding, and a delivered text when SMS is configured. "
    "Record their written confirmation by email. That's when monthly billing and the minimum term start."))
d.title(s, "Go-live tests, then Acceptance")
tests = [["#", "Test call", "Pass when"],
         ["1", "Book a new-patient check-up", "Booking appears in your calendar with the right time and details (Booking request mode: a complete request arrives)"],
         ["2", "Say an urgent phrase (e.g. \"I can't breathe\")", "000 line first, then an urgent message and alert"],
         ["3", "Ring your own number in the agreed cover", "The call reaches the receptionist the way your cover and forwarding say it should"],
         ["4", "Agree to a text (only if SMS is set up)", "The text arrives, names your practice and says Reply STOP to opt out"],
         ["5", "Ask for a time with no free slots; ask for a person", "It offers alternatives or takes a message; never claims a booking or a transfer"]]
d.table(s, tests, M, 112, W - 2 * M, [40, 330, 494], row_h=44, size=12.5, first_col_bold=False)
d.box(s, M, 390, W - 2 * M, 66, fill=TEAL_LIGHT)
d.text(s, M + 16, 400, W - 2 * M - 32, 50, ACCEPTANCE_SHORT + " Monthly billing and the minimum term start from that day.", 14, colour=INK)

# 8 Go-live -------------------------------------------------------------------
s = d.slide(notes=(
    "They switch call forwarding on with their phone provider in the mode they chose. Rollback is simply switching forwarding off: their phones go back to exactly what they had."))
d.title(s, "Go-live: you switch on call forwarding")
def who(mode):
    names = [t["shortName"] for t in (ess, pro, pre) if mode in t["inclusions"]["coverModes"]]
    return "All packages" if len(names) == 3 else ", ".join(names)


modes = [("After hours", "Calls outside your opening hours go to the receptionist.", who("After hours")),
         ("Overflow: busy / no answer", "Calls you can't pick up within a few rings go to the receptionist.", who("When busy / no answer")),
         ("All calls, alongside your team", "Every call is answered by the receptionist first.", who("All calls"))]
for i, (h1, b, who) in enumerate(modes):
    x = M + i * 292
    d.box(s, x, 125, 272, 210, fill=MIST)
    d.text(s, x + 20, 145, 232, 26, h1, 18, bold=True)
    d.text(s, x + 20, 180, 232, 90, b, 14, colour=SLATE)
    d.box(s, x + 20, 285, 150, 26, fill=TEAL_LIGHT)
    d.text(s, x + 20, 290, 150, 20, who, 11, bold=True, colour=TEAL, align=2)
if DECISION_A in cover_text(ess):
    d.text(s, M, 340, W - 2 * M, 24, f"Essential: {DECISION_A}", 10.5, colour=AMBER, italic=True)
d.box(s, M, 368, W - 2 * M, 80, fill="FFFBEB", line=AMBER)
d.text(s, M + 16, 383, W - 2 * M - 32, 60, "Cover is set for your practice and tested before it goes live. Rollback, any time: switch forwarding off with your phone provider (exact codes in call-forwarding-guide.md) and your phones work exactly as before. Your number is never changed or ported. Keep your voicemail on as a fallback.", 14, colour=INK)

# 9 First 30 days + support ---------------------------------------------------
s = d.slide(notes=(
    "Two people run M&U; be honest about support hours. First-response targets are targets, not guarantees. "
    "Daily review of flagged calls is Premium's 30-day hypercare only: never promise it on Essential or Professional. Premium also adds weekly call review and a monthly optimisation review."))
d.title(s, "The first 30 days, and support after that")
d.text(s, M, 120, 400, 26, "First 30 days", 18, bold=True, colour=TEAL)
d.text(s, M, 155, 400, 260, [f"{t['shortName']}: {settle_in(t)}" for t in (ess, pro, pre)] + ["We tune wording, slots and knowledge from what the review finds", "Monthly usage summary: minutes used, remaining, any extra"], 14, bullets=True, space_after=10)
def _short_response(r):
    """'Same business day (within 4 business hours)' -> 'Within 4 business hours'."""
    return r[r.index("(") + 1:r.rindex(")")].capitalize() if "(" in r else r


sup = [["", "Essential", "Professional", "Premium"],
       ["Hours", "Mon–Fri 9–5", "Mon–Fri 9–5", "Mon–Fri 9–5"],
       ["First response"] + [_short_response(t["support"]["firstResponse"]) for t in (ess, pro, pre)],
       ["Reviews", "After 2 weeks", "Monthly check-in", "Monthly optimisation"],
       ["Channels"] + [", ".join(t["support"]["channels"]).capitalize() for t in (ess, pro, pre)]]
d.table(s, sup, 480, 125, 432, [102, 110, 110, 110], row_h=44, size=12)
d.text(s, 480, 360, 432, 60, "Sydney time, excluding NSW public holidays. Response targets are targets, not guarantees.", 12, colour=SLATE, italic=True)

# 10 Your bill ----------------------------------------------------------------
s = d.slide(notes=(
    "Use the package from their signed proposal. Prices ex GST; M&U is GST registered, so 10% GST is added to every invoice. "
    "Walk the invoice example. Setup is quoted separately once approved: never mention a setup amount. "
    "Billing timing (in advance or in arrears) is open owner decision (b): say billing terms are confirmed in their agreement. "
    "If usage regularly exceeds included minutes, we'll suggest the right package before extra charges build up."))
d.title(s, "How your bill works", f"Prices ex GST, {GST_SHORT} (M&U is GST registered). {SETUP_LINE}.")
rows = [["", "Essential", "Professional", "Premium"],
        ["Monthly"] + [aud_short(t["pricing"]["monthly"]["cents"]) for t in (ess, pro, pre)],
        ["Included minutes"] + [f"{t['pricing']['includedMinutes']:,}" for t in (ess, pro, pre)],
        ["Extra minute (in arrears)"] + [aud_short(t["pricing"]["overagePerMinute"]["cents"]) for t in (ess, pro, pre)],
        ["Included SMS / extra"] + [f"{t['pricing']['includedSmsSegments']:,} / {aud_short(t['pricing']['extraSmsSegment']['cents'])}" for t in (ess, pro, pre)]]
d.table(s, rows, M, 118, 520, [170, 116, 118, 116], row_h=34, size=13)
d.box(s, M, 300, 520, 150, fill=TEAL_LIGHT)
d.text(s, M + 16, 310, 488, 20, f"Invoice example: {EX['name']}, {EX['minutes']:,} billable minutes", 14, bold=True)
d.text(s, M + 16, 336, 488, 110, [f"Monthly fee {aud(EX['monthly'])} + extra minutes {EX['over']:,} × {aud_short(EX['rate'])} = {aud(EX['ex'])} ex GST",
                                  f"GST {aud(EX['gst'])} · total {aud(EX['total'])} incl. GST",
                                  "No setup line."], 13, colour=INK, bullets=True, space_after=4)
d.text(s, 600, 118, 312, 330, [BILLING_PENDING, "Minutes are counted by the second, added up over the month and rounded up to a whole minute once", "Calls under 5 seconds and our test calls don't count", "Minutes and SMS reset monthly; no rollover", "If your usage is regularly above your included minutes, we'll suggest the package that fits before extra charges build up"], 12, bullets=True, space_after=7)

# 11 Contacts -----------------------------------------------------------------
s = d.slide(dark=True, notes="Close the kickoff by confirming who does what by when, and book the test-call session before hanging up.")
d.text(s, M, 90, 760, 60, "Next: your setup checklist and calendar access", 34, colour=WHITE, font="Cambria")
d.text(s, M, 200, 760, 150, ["Setup checklist back by: [date]", "Calendar access granted during kickoff", "Privacy policy updated by: [date]", "Test-call session: [date, time]"], 18, colour="E2E8F0", bullets=True, space_after=10)
d.text(s, M, 400, 760, 30, "Usman Khan · M&U Ventures · [business phone] · [email]", 15, colour="94A3B8")

if __name__ == "__main__":
    pdf, pngs = d.save(PACK / "onboarding-deck.pptx", "onboarding-deck")
    print(pdf, len(pngs))
