"""One-page demo guide (presenter) and client setup checklist (client-facing)."""
from common import *

ess, pro, pre = tiers()

demo = f"""
<h1>Demo guide: a booking call in 15 minutes</h1>
<p class='lead'>For the M&amp;U presenter. Demonstration data only, labelled "{DEMO_LABEL}". Say every limit out loud.</p>
<div class='warn'><b>Check first:</b> is booking live on the demo line today? (receptionist <i>docs/BOOKING-DEMO-ENABLEMENT.md</i> STATUS). <b>No → Mode A.</b> Yes, and the owner's 5 retest calls passed → Mode B. Never present the live line as booking until it does. <b>Also check</b> which Booking Mode this prospect qualifies for (Booked vs Booking request/lead capture — ask "which system do you use" before the demo) and never demonstrate "Booked" behaviour to a Booking-request prospect.</div>
{table(['Min', 'Step', 'Mode A (before go-live, default)', 'Mode B (after go-live)'], [
    ['0–1', 'Their calls', 'Their site: hours and how patients book. "Which calls would you want it to take: after hours, overflow, or all calls alongside your team?"', 'Same'],
    ['1–5', 'A booking call', 'Booking video labelled <b>' + DEMO_LABEL + '</b> (fictional practice), or walk the call flow below. Optional: ring the live line after saying "today it takes a message; it won\'t book".', 'Ring the demo line on speaker, choose dental, book a check-up, show the SMS on <b>your own</b> phone.'],
    ['5–7', 'Urgent path', '"My face is really swollen and I\'m struggling to breathe" → 000 line first, then urgent message. "It never decides how serious something is."', 'Same, live'],
    ['7–9', 'What the team sees', 'Dashboard with <b>demonstration calls only</b>: booking, email alert, message queue, minutes used. "Alerts switch on with booking at go-live."', 'Same, with the booking you just made'],
    ['9–11', 'Calendar fit', f'{DIRECT_BOOKING} Google Calendar or Cal.com, not Dentally/Core Practice. A dedicated calendar with released slots works.', 'Same'],
    ['11–12', 'Failure paths', 'Asks for a person → message (live transfer isn\'t offered). No slots → message. Changes mind → moves the same-call booking.', 'Same'],
    ['12–14', 'Package', f'Recommend one: Essential {aud_short(ess["pricing"]["monthly"]["cents"])} · Professional {aud_short(pro["pricing"]["monthly"]["cents"])} · Premium {aud_short(pre["pricing"]["monthly"]["cents"])} a month, ex GST, {GST_SHORT}. {SETUP_LINE}.', 'Same'],
    ['14–15', 'Next step', f'"{PROMISE} Shall I send the proposal?"', 'Same'],
], widths=[7, 14, 45, 34])}
<h3>The call flow to narrate (Mode A)</h3>
<p>"Thanks for calling [fictional practice]. This call is recorded. You're speaking with an automated assistant." → caller asks for a check-up → it asks new or existing, offers two times from released slots → caller picks one → "Shall I book that?" → calendar confirms → "You're booked for [time]. Your reference is [ref]." → asks consent to text a confirmation → "Anything else?"</p>
<h3>Per-prospect demo close (once live — check first)</h3>
<p>Once <i>D:/MU-Receptionist-wt-prompt/docs/PROSPECT-DEMO.md</i> confirms the per-prospect demo is live and retested (it did not exist as of 27 Sep 2026): "Ring this number from your practice phone now — you'll hear a demonstration receptionist we built from your public website." Built from their public site only, still discloses AI + recording, still 000 first, still whichever Booking Mode fits their system. Until that doc says it's live, don't offer this — run Mode A/B above instead.</p>
<h3>Never</h3>
<p>Use a real patient's or prospect's details · show a real caller's call · position it as missed-call cover or promise bookings/revenue · offer any pilot, trial or setup waiver · quote a setup amount · claim it transfers, integrates with practice software, or is live with other practices · give out the demo number as a booking demo before go-live · demonstrate "Booked" behaviour to a prospect who only qualifies for Booking request / lead capture.</p>
"""

tick = "&#9744;"
check = f"""
<h1>Your receptionist setup checklist</h1>
<p class='lead'>{fill('Practice name')} · {fill('Package')} · About 30 minutes. Please don't include passwords, API keys or patient details anywhere in this form.</p>
<h2>A. Your practice</h2>
{table(['', 'Question', 'Your answer'], [
    [tick, 'Practice name, as callers should hear it', ''],
    [tick, 'Address and time zone', ''],
    [tick, 'Opening hours for each day, including lunch closures and public holidays', ''],
    [tick, 'Appointment types the receptionist may book, each with its length in minutes (e.g. new-patient check-up, 60 min)', ''],
    [tick, 'Which of those a new patient may book without speaking to your team', ''],
    [tick, 'Anything that must never be booked by phone (e.g. extractions, sedation)', ''],
    [tick, 'Fees or policies you are happy for it to quote (only published ones)', ''],
], widths=[5, 50, 45])}
<h2>B. Calendar and calls</h2>
{table(['', 'Step', 'Done'], [
    [tick, 'Practice-management / booking system you use today (e.g. Dentally, Core Practice, D4W, Google Calendar, Cal.com, other)', ''],
    [tick, 'Booking Mode that follows from that (M&amp;U confirms): ☐ Booked ☐ Booking request / lead capture', ''],
    [tick, 'If Booked: calendar it books into — ☐ Google Calendar ☐ Cal.com (a dedicated booking calendar is fine)', ''],
    [tick, 'You grant access from your own account during kickoff (we never ask for passwords)', ''],
    [tick, 'Who copies bookings into your practice software, if you use one', ''],
    [tick, 'Cover you want at go-live: ☐ after hours ☐ when busy / no answer (overflow) ☐ all calls, alongside your team (if your package includes it)', ''],
    [tick, 'Your phone provider, and who can switch call forwarding on and off (codes: <i>call-forwarding-guide.md</i> — your number is never changed or ported)', ''],
    [tick, 'Existing voicemail stays on as a fallback', ''],
], widths=[5, 80, 15])}
<h2>C. Urgent calls and alerts</h2>
{table(['', 'Question', 'Your answer'], [
    [tick, 'What callers should hear for urgent dental problems after hours (e.g. on-call number or referral service). Life-threatening emergencies are always told to call 000 first.', ''],
    [tick, 'Email address(es) for booking and urgent-message alerts', ''],
    [tick, 'Day-to-day contact for M&amp;U (name, role)', ''],
], widths=[5, 60, 35])}
<h2>D. Privacy and consent</h2>
{table(['', 'Confirmation', 'Yes / No'], [
    [tick, 'Callers are told they are speaking with an automated assistant and that the call is recorded', ''],
    [tick, 'Your privacy policy will mention the AI receptionist, call recording and overseas service providers before go-live (we send suggested wording). Link:', ''],
    [tick, 'Callers who agree may receive SMS booking confirmations' + ' (and reminders on Professional and Premium)' + ', each with "Reply STOP to opt out"', ''],
    [tick, 'Recording and call-record retention period agreed: ☐ 30 ☐ 60 ☐ 90 days', ''],
], widths=[5, 80, 15])}
<h2>E. Testing and Acceptance</h2>
{table(['', 'Step', 'Date'], [
    [tick, 'Call forwarding switched on in the agreed cover (until Acceptance your line only takes messages)', ''],
    [tick, 'Go-live test calls together: a booking (or booking request), an urgent-wording call, calls through your cover and forwarding, and a text if SMS is set up', ''],
    [tick, 'You confirm in writing that the tests passed (Acceptance: monthly billing and the minimum term start)', ''],
], widths=[5, 80, 15])}
<p class='small'>M&amp;U Ventures · Support {ess['support']['hours']} · {fill('business phone')} · {fill('email')}</p>
"""

if __name__ == "__main__":
    pdf, pages = build_docx(html_doc(demo), PACK / "demo-guide.docx", "M&U Ventures · Internal demo guide · synthetic data only", f"Catalogue {CATALOGUE['catalogueVersion']}")
    print(pdf, pages, len(rasterise(pdf, "demo-guide")))
    pdf, pages = build_docx(html_doc(check), PACK / "client-setup-checklist.docx", "M&U Ventures · AI receptionist setup checklist", "Please don't include passwords or patient details")
    print(pdf, pages, len(rasterise(pdf, "client-setup-checklist")))
