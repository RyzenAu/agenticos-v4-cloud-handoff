"""Sales presentation (.pptx) with speaker notes, demo flow and current economics."""
from common import *
from slides import Deck, W, H, M

tiers = tiers()
ess, pro, pre = tiers
EX = invoice_example()
d = Deck()

# 1 Title ---------------------------------------------------------------------
s = d.slide(dark=True, footer=f"M&U Ventures · Mount Druitt NSW · Packages approved {approved_on()}, catalogue {CATALOGUE['catalogueVersion']}", notes=(
    "Open by naming what you saw on their site. This deck is for a 15-minute demo. "
    "Before presenting, check the receptionist readiness file: if booking is not live on the demo line, run the booking section as the video labelled 'Illustrative demonstration' or the narrated call flow (Mode A). "
    "Never present the live line as booking until go-live has been approved and retested."))
d.text(s, M, 70, 600, 30, "AI RECEPTIONIST FOR DENTAL PRACTICES", 13, bold=True, colour="5EEAD4")
d.text(s, M, 110, 640, 150, "Your calls, answered and booked.", 50, colour=WHITE, font="Cambria")
d.text(s, M, 262, 600, 90, "In the cover you choose (after hours, overflow, or alongside your team), the receptionist answers. At go-live, with a connected Google Calendar or Cal.com calendar, it books, texts the patient a confirmation and emails your team.", 17, colour="CBD5E1")
d.text(s, M, 370, 600, 24, "Prepared for [Practice name] · [Date]", 14, colour="94A3B8")
for i, (lbl, y) in enumerate((("Answers", 120), ("Books", 210), ("Confirms", 300))):
    d.dot(s, 740, y, 64, fill=TEAL, label=str(i + 1), size=22)
    d.text(s, 820, y + 18, 120, 30, lbl, 20, bold=True, colour=WHITE)

# 2 Their calls ---------------------------------------------------------------
s = d.slide(notes=(
    "Use their numbers only. Ask, write them in live, and leave blanks blank. We never supply sector averages or claim how many calls they get or lose. "
    "Cover is per configuration: after hours, overflow when the desk is busy, or all calls alongside the team (Professional and Premium). Never pitch it as missed-call cover."))
d.title(s, "Which calls should it answer?", "Your numbers and your choice of cover. We fill these in together.")
cards = [("Calls a week you'd want it to take", "____"),
         ("Cover: after hours, overflow, or all calls alongside your team", "____"),
         ("Where your bookings live today", "____")]
for i, (lbl, val) in enumerate(cards):
    x = M + i * 292
    d.box(s, x, 150, 272, 200, fill=MIST)
    d.text(s, x + 20, 170, 232, 70, val, 48, colour=TEAL, font="Cambria")
    d.text(s, x + 20, 245, 232, 90, lbl, 16, colour=INK)
d.text(s, M, 380, W - 2 * M, 50, "Online booking (HotDoc, HealthEngine) stays. This is for the people who pick up the phone.", 16, colour=SLATE, italic=True)

# 3 What it does (flow) ------------------------------------------------------
s = d.slide(notes=(
    "Walk the flow left to right. Say clearly: steps 1 and 2 are live on our demo line today; booking, the text and the email switch on at go-live, "
    "after acceptance tests and the owner's approval. It only says 'you're booked' when the calendar confirms. No live transfer to a person in any package."))
d.title(s, "What happens on every call", "Live today: answer, disclose, message, 000. At go-live: book, text, email.")
steps = [("Answers", "Says it's an automated assistant and the call is recorded", "Live"),
         ("Understands", "New or existing patient, what they need, when suits", "Live"),
         ("Checks your calendar", "Only the appointment types and slots you release", "At go-live"),
         ("Books", "Confirms only when your calendar confirms; reads back a reference", "At go-live"),
         ("Confirms by SMS", "If the caller agrees; STOP to opt out", "At go-live"),
         ("Tells your team", "Email for every booking or urgent message", "At go-live")]
for i, (h1, body_, state) in enumerate(steps):
    x = M + i * 146
    d.dot(s, x + 44, 150, 48, fill=(TEAL if state == "Live" else INK), label=str(i + 1), size=18)
    if i < 5:
        d.arrow(s, x + 98, 174, x + 184, 174)
    d.text(s, x, 215, 136, 26, h1, 15, bold=True, align=2)
    d.text(s, x, 245, 136, 90, body_, 12.5, colour=SLATE, align=2)
    d.box(s, x + 23, 340, 90, 24, fill=(TEAL_LIGHT if state == "Live" else "E2E8F0"))
    d.text(s, x + 23, 344, 90, 18, state, 11, bold=True, colour=(TEAL if state == "Live" else INK), align=2)
d.box(s, M, 395, W - 2 * M, 70, fill="FFFBEB", line=AMBER)
d.text(s, M + 16, 407, W - 2 * M - 32, 50, "Anything urgent or life-threatening: the 000 line first, every time, then an urgent message to your team. It never assesses anyone and it is not an emergency service.", 15, colour=INK)

# 4 Live vs go-live -----------------------------------------------------------
s = d.slide(notes=(
    "This is the honesty slide. Read the left column as 'what you'd hear if you rang our demo line today'. "
    "If asked for a date: we don't promise one until booking has passed acceptance testing on our own line. Each business's booking, routing and texts are set up and tested before they go live."))
d.title(s, "Straight answer: what's live and what switches on at go-live")
d.box(s, M, 125, 420, 275, fill=TEAL_LIGHT)
d.text(s, M + 20, 140, 380, 26, "Live on our demo line today", 18, bold=True, colour=TEAL)
d.text(s, M + 20, 178, 380, 260, ["Answers and says it's an automated assistant", "Says the call is recorded", "Takes a structured message and callback request", "000 line first on urgent wording", "It does not book yet: it takes a message"], 15, bullets=True, space_after=8)
d.box(s, 492, 125, 420, 275, fill=MIST)
d.text(s, 512, 140, 380, 26, "At go-live (built, being tested)", 18, bold=True)
d.text(s, 512, 178, 380, 200, ["Books into a connected Google Calendar or Cal.com calendar", "Email alert for every booking or urgent message", "SMS confirmation with STOP opt-out", "Reminders and weekly report (Professional, Premium)"], 15, bullets=True, space_after=8)
d.text(s, 512, 330, 380, 50, "Not offered in any package: live transfer to a person; practice-software integration.", 13, colour=SLATE, italic=True)
d.text(s, M, 425, W - 2 * M, 30, "We don't promise a go-live date until booking has passed acceptance tests on our own line.", 15, colour=INK)

# 5 Demo flow -----------------------------------------------------------------
s = d.slide(notes=(
    "Mode A (before go-live): play the receptionist-edition booking video labelled 'Illustrative demonstration', or narrate these lines. "
    "Mode B (after go-live): ring the demo line on speaker and book, then show the SMS on your own phone. "
    "Then show the dashboard with demonstration calls only. Never show a real caller."))
d.title(s, "A booking call, start to finish", f"{DEMO_LABEL}: a fictional practice. At go-live this is a live call.")
lines = [("Receptionist", "Thanks for calling Bayview Dental. This call is recorded. You're speaking with an automated assistant. How can I help?"),
         ("Caller", "I'd like a check-up. I haven't been before."),
         ("Receptionist", "I can see Tuesday at 10:30 or Thursday at 2:15. Which suits?"),
         ("Caller", "Thursday, please."),
         ("Receptionist", "Shall I book that? … You're booked for Thursday at 2:15. Your reference is BD-4821. Would you like a text confirming it?")]
y = 125
for who, line in lines:
    right = who == "Caller"
    x = 420 if right else M
    d.box(s, x, y, 492, 56, fill=("E2E8F0" if right else TEAL_LIGHT))
    d.rich(s, x + 14, y + 7, 464, 44, [[(who.upper(), True, TEAL if not right else SLATE)], [(line, False, None)]], size=12)
    y += 62
d.text(s, M, 442, W - 2 * M, 30, f"{DEMO_LABEL} until booking goes live on our demo line. Reference and times are fictional.", 12, colour=SLATE, italic=True)

# 6 Calendar fit / booking modes ----------------------------------------------
s = d.slide(notes=(
    "Qualify here: ask which system they use before describing either mode. It books into Google Calendar or Cal.com (Booked mode). Most dental practices run Dentally, Core Practice or similar, and we don't book into any of those directly today: that's Booking request / lead capture mode, not a lesser version of Booked — no reference number, no promised time; the practice commits to confirming each request (e.g. by the next business morning). "
    "Dentally does publish a public developer API (developer.dentally.co, checked 27 Sep 2026): say 'possible future direct booking, not offered today', never 'coming soon'."))
d.title(s, "Two honest booking modes", "Booked (Google Calendar / Cal.com) or Booking request / lead capture (closed practice software).")
opts = [("Booked", "Google Calendar or Cal.com, including a dedicated booking calendar. Books on the spot, reads back a reference."),
        ("Booking request / lead capture", "Dentally, Core Practice, D4W and similar: no direct booking yet (Dentally has an API; possible future). Takes name, number, reason, preferred time. No reference number. Your desk commits to confirming each request (e.g. next business morning)."),
        ("Neither works for you", "Then it isn't a fit yet, and we'll tell you so.")]
for i, (h1, b) in enumerate(opts):
    x = M + i * 292
    d.box(s, x, 140, 272, 250, fill=(TEAL_LIGHT if i < 2 else MIST))
    d.dot(s, x + 20, 160, 40, fill=(TEAL if i < 2 else SLATE), label=str(i + 1), size=16)
    d.text(s, x + 20, 215, 232, 50, h1, 16, bold=True)
    d.text(s, x + 20, 262, 232, 118, b, 13, colour=SLATE)
d.text(s, M, 405, W - 2 * M, 50, [DIRECT_BOOKING, "You choose which appointment types and times it may book (Booked mode). Everything else becomes a message or request."], 14, colour=INK, space_after=4)

# 7 Safety & privacy ----------------------------------------------------------
s = d.slide(notes=(
    "Be exact. Calls are recorded and transcribed. Retell, Twilio and the language model provider process calls in the United States; the database is in Sydney. "
    "Their privacy policy must say so before go-live (APP 1, 5, 8); we supply wording but they own their policy. Health information is sensitive: the receptionist asks only what a booking needs."))
d.title(s, "Safety and privacy, said plainly")
items = [("000 first", "Urgent or life-threatening wording gets 'hang up and call 000' before anything else. Not an emergency service."),
         ("No advice", "No clinical advice, no triage, no quoting fees you haven't published."),
         ("Disclosure", "Every call starts: this call is recorded; you're speaking with an automated assistant."),
         ("Overseas processing", "Call audio and transcripts are processed by providers in the United States. Your privacy policy names them (we give you wording)."),
         ("Minimum data", "Name, number, appointment type and time. No symptoms or clinical detail asked for."),
         ("Retention", "Recordings and transcripts kept for an agreed period (30, 60 or 90 days), then deleted.")]
for i, (h1, b) in enumerate(items):
    col, row = i % 2, i // 2
    x, y = M + col * 440, 120 + row * 110
    d.dot(s, x, y + 4, 36, fill=TEAL, label=str(i + 1), size=14)
    d.text(s, x + 50, y, 370, 24, h1, 16, bold=True)
    d.text(s, x + 50, y + 26, 370, 70, b, 13, colour=SLATE)

# 8 Packages ------------------------------------------------------------------
s = d.slide(notes=(
    "Recommend one package from what they told you; don't read all three. Monthly prices are approved and quoted ex GST; M&U is GST registered, so 10% GST is added. "
    "Setup: quoted separately once approved. Never quote a setup amount. "
    "Essential suits one location (its cover is open owner decision (a): see the footnote; don't state it either way); Professional several practitioners, all calls alongside the team, reminders and the weekly report; Premium multi-site or high volume with weekly call review."))
d.title(s, "Three packages", f"Approved monthly plans, ex GST, {GST_SHORT}. {SETUP_LINE}.")


def feats(t):
    inc, q, ids = t["inclusions"], t["pricing"], {f["id"] for f in t["scope"]}
    cal, loc = inc["calendars"], inc["locations"]
    out = [f"{q['includedMinutes']:,} minutes included",
           f"{aud_short(q['overagePerMinute']['cents'])} per extra minute",
           (f"Up to {cal} calendars" if cal > 1 else "1 calendar") + (f", {loc} locations" if loc > 1 else ", 1 location"),
           "Cover: after hours, overflow" + (", all calls" if "All calls" in inc["coverModes"] else "")]
    out.append("SMS confirmations + reminders*" if "sms-reminder" in ids else "SMS booking confirmation*")
    if "assured-review" in ids:
        out.append("Weekly M&U call review*")
    elif "weekly-report" in ids:
        out.append("Weekly proof report*")
    out.append(f"Support: {t['support']['firstResponse'].split(' (')[0].lower()}")
    out.append(f"{q['minimumTermMonths']}-month minimum from Acceptance")
    return out


for i, t in enumerate(tiers):
    x = M + i * 292
    hl = t["shortName"] == "Professional"
    d.box(s, x, 118, 272, 312, fill=(INK if hl else MIST))
    fg = WHITE if hl else INK
    d.text(s, x + 20, 130, 232, 26, t["shortName"].upper(), 14, bold=True, colour=("5EEAD4" if hl else TEAL))
    d.text(s, x + 20, 156, 232, 50, aud_short(t["pricing"]["monthly"]["cents"]), 38, colour=fg, font="Cambria")
    d.text(s, x + 20, 206, 232, 20, f"per month {GST_SHORT}", 12, colour=("CBD5E1" if hl else SLATE))
    d.text(s, x + 20, 234, 232, 190, feats(t), 12.5, colour=fg, bullets=True, space_after=3)
_foot = "*At go-live. Not in any package: live transfer, practice-software integration."
d.text(s, M, 436, W - 2 * M, 36, _foot, 10.5, colour=SLATE, italic=True)

# 9 How billing works + value ------------------------------------------------
s = d.slide(notes=(
    "Client-facing economics. Minutes are counted per second, summed over the month and rounded up once; under-5-second calls and our test calls don't count; no rollover. "
    "Walk the invoice example once so they can see how extra minutes and GST land. "
    "Billing timing (in advance or in arrears) is open owner decision (b): don't state either; say billing terms are confirmed in their agreement. "
    "Work the value worksheet with THEIR numbers only and always show the zero-benefit row. Label every figure 'illustration, not a forecast'. Never promise bookings or revenue."))
d.title(s, "What you pay for, and how to judge it", "Prices ex GST, + 10% GST. Value: an illustration with your numbers, not a forecast.")
rows = [["", "Essential", "Professional", "Premium"],
        ["Monthly, ex GST"] + [aud_short(t["pricing"]["monthly"]["cents"]) for t in tiers],
        ["Included minutes"] + [f"{t['pricing']['includedMinutes']:,}" for t in tiers],
        ["≈ calls of 2.5 min"] + [f"{t['pricing']['includedMinutes'] * 2 // 5:,}" for t in tiers],
        ["Extra minute"] + [aud_short(t["pricing"]["overagePerMinute"]["cents"]) for t in tiers]]
d.table(s, rows, M, 118, 520, [160, 120, 120, 120], row_h=28, size=12.5)
d.box(s, M, 300, 520, 150, fill=TEAL_LIGHT)
d.text(s, M + 16, 310, 488, 20, f"Invoice example: {EX['name']}, {EX['minutes']:,} billable minutes", 14, bold=True)
d.text(s, M + 16, 336, 488, 110, [f"{aud(EX['monthly'])} + {EX['over']:,} × {aud_short(EX['rate'])} = {aud(EX['ex'])} ex GST",
                                  f"GST {aud(EX['gst'])} · total {aud(EX['total'])} incl. GST",
                                  f"No setup line. {BILLING_TERMS}",
                                  "Counted per second, summed over the month, rounded up once. Calls under 5 seconds and our test calls don't count. No rollover."],
       12, colour=INK, bullets=True, space_after=3)
d.box(s, 600, 118, 312, 332, fill=MIST)
d.text(s, 616, 131, 280, 24, "Your break-even, on your numbers", 15, bold=True)
d.text(s, 616, 161, 280, 280, ["Extra first visits a month = calls a week it takes in your chosen cover × 4.33 × share wanting an appointment × share who'd book × share who'd otherwise not have booked",
                                "× your gross profit per first course of care",
                                "− the monthly fee",
                                "Always include the zero row: if nothing changes, you're down the monthly fee."], 12.5, bullets=True, space_after=6)

# 10 Set up and tested -----------------------------------------------------------
s = d.slide(dark=True, notes=(
    "Say the promise exactly. Acceptance = the go-live tests pass on their own configuration (booking or booking request, urgent wording, routing through their cover, texts when SMS is configured) plus their written confirmation. There is no pilot or trial offer: don't offer one, and don't promise a setup waiver. Setup is quoted separately once approved; never quote a setup amount. "
    "Direct booking depends on their system: confirm compatibility in setup, or agree a booking-request / lead workflow. "
    "The service agreement is a draft until qualified legal review is done: don't send it before Usman confirms."))
d.text(s, M, 70, 800, 30, "HOW YOU START", 14, bold=True, colour="5EEAD4")
d.text(s, M, 105, 860, 100, PROMISE, 32, colour=WHITE, font="Cambria")
d.text(s, M, 235, 860, 190, ["Cover set for your practice: after hours, overflow, or all calls alongside your team where your package includes it.",
                              DIRECT_BOOKING,
                              "Go-live tests with you: a booking or booking request, an urgent call, calls through your cover and forwarding, and a text if SMS is set up. Acceptance is your written confirmation; monthly billing and the minimum term start then.",
                              "Your number never changes. Switch call forwarding off any time and your phones work as they do today."],
       16, colour="E2E8F0", bullets=True, space_after=8)

# 11 Timeline -----------------------------------------------------------------
s = d.slide(notes=(
    "About a week from kickoff to the first test booking, once booking has passed acceptance on our own line and we have calendar access. Don't promise a calendar date before that. "
    "Settle in: Essential gets a setup review after 2 weeks, Professional a monthly check-in, Premium 30-day hypercare with daily call review for the first 2 weeks. Never promise daily review below Premium."))
d.title(s, "From yes to your first booking", "About a week, once we have your calendar access and answers.")
tl = [("Day 1", "Kickoff", "Hours, services, what may be booked, urgent wording"),
      ("Days 1–3", "Access", "You connect your calendar; setup checklist"),
      ("Days 2–5", "Build", "We configure; you update your privacy policy"),
      ("Days 5–7", "Test", "Forwarding on; go-live test calls together"),
      ("Day 7", "Acceptance", "Tests pass; you confirm in writing"),
      ("Days 7–30", "Settle in", "The review your package includes (daily for 2 weeks on Premium)")]
d.box(s, M, 234, W - 2 * M, 4, fill=LINE, rounded=False)
for i, (when, what, detail) in enumerate(tl):
    x = M + i * 146
    d.dot(s, x + 50, 216, 40, fill=(TEAL if what != "Acceptance" else AMBER), label=str(i + 1), size=15)
    d.text(s, x, 170, 140, 20, when, 12, bold=True, colour=SLATE, align=2)
    d.text(s, x, 270, 140, 24, what, 16, bold=True, align=2)
    d.text(s, x + 4, 300, 132, 80, detail, 12.5, colour=SLATE, align=2)
d.box(s, M, 400, W - 2 * M, 56, fill=TEAL_LIGHT)
d.text(s, M + 16, 417, W - 2 * M - 32, 30, "Kickoff starts once booking has passed acceptance tests on our own line. Monthly billing starts at Acceptance.", 15, colour=INK)

# 12 Next steps ---------------------------------------------------------------
s = d.slide(notes=(
    "Ask for the proposal. Every email is a draft until Usman approves it. Book the follow-up before you hang up."))
d.title(s, "Next steps")
ns = [("1", "Choose a package", "We'll recommend one from what you've told us."),
      ("2", "Proposal", "Package, price, timeline and Acceptance, in writing."),
      ("3", "Agreement and checklist", "Service agreement, then a 30-minute setup checklist."),
      ("4", "Kickoff", "Once booking has passed our acceptance tests.")]
for i, (n, h1, b) in enumerate(ns):
    y = 125 + i * 80
    d.dot(s, M, y, 48, fill=TEAL, label=n, size=18)
    d.text(s, M + 70, y + 2, 700, 24, h1, 18, bold=True)
    d.text(s, M + 70, y + 28, 700, 24, b, 14, colour=SLATE)
d.text(s, M, 450, W - 2 * M, 24, "Usman Khan · M&U Ventures · [business phone] · [email]", 14, colour=INK)
d.box(s, 600, 125, 312, 300, fill=INK)
d.text(s, 620, 145, 272, 26, "Have ready for kickoff", 17, bold=True, colour=WHITE)
d.text(s, 620, 185, 272, 230, ["Access to the calendar it will book into", "Opening hours, incl. public holidays", "Appointment types it may book, with lengths", "What urgent callers should hear after hours", "Your privacy policy link"], 14, colour="E2E8F0", bullets=True, space_after=8)

# 13 Internal appendix (hidden) ----------------------------------------------
rows = [["Per client / month, 5 clients, base usage", "Essential", "Professional", "Premium"]]
vals = {t["shortName"]: base_at(t["catalogueId"])[1] for t in tiers}
rows.append(["Revenue ex GST"] + [aud(vals[n]["revenueExGstCents"] // 5) for n in ("Essential", "Professional", "Premium")])
rows.append(["Variable cost (voice, carrier, number, SMS, fees)"] + [aud(vals[n]["variableCostCents"] // 5) for n in ("Essential", "Professional", "Premium")])
rows.append(["Gross contribution"] + [f"{vals[n]['contributionMarginBps'] / 100:.1f}%" for n in ("Essential", "Professional", "Premium")])
rows.append(["Margin after support + platform"] + [f"{vals[n]['operatingMarginBps'] / 100:.1f}%" for n in ("Essential", "Professional", "Premium")])
rows.append(["Overage floor (70% marginal)"] + [aud(vals[n]["overageFloorExGstCents"]) for n in ("Essential", "Professional", "Premium")])
s = d.slide(hidden=True, notes=(
    f"INTERNAL. Hidden in slideshow; delete before sending the file to a client. Estimates from official rates in package-economics.json (as of {ECONOMICS['asOf']}: Retell, Twilio, Vercel, Stripe, RBA {ECONOMICS['assumptions']['fx']['usdPerAudMillionths'] / 1e6:.4f}). "
    "Measured and invoice-reconciled costs are empty: no client traffic yet. Neon, alert email, Retell concurrency and other subscriptions are unknown and excluded, not zero."))
d.title(s, "INTERNAL: unit economics (hidden, delete before sending)", "Estimates only; measured and invoice-reconciled columns are empty. Source: package-economics.json")
d.table(s, rows, M, 130, W - 2 * M, [384, 160, 160, 160], row_h=34, size=13)
_ce = {c["id"]: c for c in ECONOMICS["costEvidence"]}
d.text(s, M, 390, W - 2 * M, 60,
       f"Variable cost ≈ {aud(base_at(ess['catalogueId'])[1]['perMinuteCents'])} per connected minute (Retell US${_ce['retell']['estimatedMicros'] / 1e6:.2f} incl. Claude 4.5 Haiku and ElevenLabs tier; Twilio SIP US${_ce['carrier']['estimatedMicros'] / 1e6:.3f}). "
       f"Labour A${ECONOMICS['assumptions']['labourHourlyCents'] // 100}/h. Unknown costs excluded, not zero. Setup is proposed, not approved: not modelled here. High usage margins: "
       + " / ".join(f"{base_at(t['catalogueId'], 5, 'high')[1]['operatingMarginBps'] / 100:.0f}%" for t in tiers) + ".", 12.5, colour=SLATE)

if __name__ == "__main__":
    pdf, pngs = d.save(PACK / "sales-presentation.pptx", "sales-presentation")
    print(pdf, len(pngs))
