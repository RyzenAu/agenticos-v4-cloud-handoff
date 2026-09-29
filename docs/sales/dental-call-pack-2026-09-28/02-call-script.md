# Call script: owner-led, dental, booking receptionist

**Goal of every call:** book a 15-minute demo, or get a clear no. Don't close on the phone.
**Before dialling:** caller ID on; it's a weekday between 9am and 5pm Sydney time (never Sunday, never Mon 5 Oct); you've looked at their site; the `personalised_opening` from `prospects.csv` is on screen. Don't record the call.

---

## 1. Opener (first 15 seconds): who, why, permission
> "Hi, it's Usman from M&U Ventures. This is a sales call, I'll be quick. I was on [Practice name]'s website this morning and noticed [the one specific thing]. Have I caught you at an OK time for thirty seconds?"

- **Yes:** go to 3.
- **Busy:** "No worries. When's a better time?" Log **Call back – time agreed**.
- **"Not interested" / "don't call again":** "Understood, sorry to bother you. I'll make sure we don't call again." Log **Do not contact**. Don't re-pitch.

## 2. Gatekeeper (front desk)
> "Hi, it's Usman from M&U Ventures in Mount Druitt. I'm hoping to speak with whoever looks after the phones and bookings. Is that the practice manager? When's a good time to catch them?"

- Get the **role and a good time**, not a personal mobile. Never imply the desk is doing a bad job.
- Message: "Could you let them know Usman from M&U Ventures called about a receptionist that answers calls, after hours or alongside the desk, and, once it's set up, books them into a connected calendar? I'll try again [time]."

## 3. The reason, from what you saw
> "Your site says the phones are staffed [hours]. How do you handle calls after that, or while everyone's with patients: would it help to have them answered and booked?"

## 4. Discovery: one question on a cold call, then listen
Default: the question above. Save the rest for the demo:
1. "Roughly how many calls a week would you want answered that way: after hours, when the desk is busy, or all of them alongside your team?" *(Their number. Never supply one.)*
2. "**What system do you run your bookings in** — Dentally, Core Practice, D4W, something else, or a Google calendar?" *(Ask this before describing either booking mode — `01-offer.md` §"Two booking modes" and `10-qualification.md`. It decides whether they'd get Booked or Booking request/lead capture, and never promise the former to a closed-system practice.)*
3. "Which appointments would you be happy for someone else to book: new-patient check-ups, cosmetic consults?"
4. "Who checks voicemail, and when?"
5. "If you could change one thing about how calls come in, what would it be?"

## 5. Bridge (only if they've described a need)
> "That's what we set up. An AI receptionist answers the calls you choose: after hours, overflow when the desk is busy, or alongside your team. It says it's an automated assistant, and anything urgent gets the 000 line first. At go-live, with a connected Google Calendar or Cal.com calendar, it checks the times you've released, books the patient in, texts them a confirmation and emails your team."

Then the honesty line, every time:
> "Straight up: booking switches on at go-live. If you rang our demo line today it would take a message rather than book. Each business's booking, routing and texts are set up and tested before they go live, so you'd hear your own line book a test appointment before anything goes live."

If they ask how booking works with their system: "Direct booking depends on your system. We confirm compatibility during setup, or agree a booking-request workflow where your desk confirms each request."

**If they ask "is this AI?":** "Yes. It tells every caller it's automated and that the call is recorded."

## 6. The ask
> "Book a 15-minute demo with me: I'll take you through a demonstration call and exactly what your team would see. Does Wednesday, Thursday or Friday suit?"

- **Yes:** confirm day, time, name, role, best email for the invite. Log **Demo booked**.
- **"Send me something":** "Sure, what's the best email?" Log **Info requested**. Draft from `13-follow-up-drafts.md` (Usman approves before sending).
- **No:** "Fair enough. What would make it worth a look later?" Log **Not now** or **Closed – declined**.

**Only once the per-prospect demo is live** (`05-demo-path.md` §"Per-prospect demo close"; check
`06-receptionist-readiness.md` and `D:/MU-Receptionist-wt-prompt/docs/PROSPECT-DEMO.md` first —
**until then, don't offer this, book the 15-minute demo above**), you can close harder on
the spot instead of booking a demo:
> "Actually, ring this number from your practice phone right now — [demo number]. You'll hear a
> demonstration receptionist we built from your own website. Have a listen and tell me what you
> think."

## 7. Voicemail (about 20 seconds; one per practice per week)
> "Hi, this is Usman from M&U Ventures, a small Sydney business. I had a quick idea about answering and booking your practice's calls, after hours or alongside your front desk. No need to call back if it's not relevant. If it is, I'm on [owner business number]. That's Usman, M&U Ventures. Thanks."

*Leave a business number, never a personal one. Don't leave the demo number until booking is live on it.*

## 8. After every call (Mehroz logs within one minute)
Status (`04-crm-statuses.md`) · next action · date · owner · one line of **what they said** (not a transcript). Calendar answer if you got one (Google / Cal.com / practice software only / unknown).

## 9. Opt-out
"Of course. I've noted that and we won't contact you again." Flag **Do not contact** on every number and duplicate within 5 minutes.
