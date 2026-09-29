# Lead capture positioning: the booking-request / lead-capture mode

**Status (updated 28 Sep 2026 to match the package catalogue):** lead capture is not a separate
product. It is the **Booking request / lead capture** mode of the same receptionist packages. The
catalogue (`src/lib/receptionist-packages.ts`, `sectors: dental, property, legal`) sells the
receptionist to **dental practices, property agencies and law firms at the same package prices**
(`../dental-call-pack-2026-09-28/11-package-comparison.md`). **Trades are not sold**
(catalogue `UNSUPPORTED_SECTORS`: no trades playbook). This page is the honest answer when a
prospect doesn't fit the booking story — a law firm, a property agency, or a dental/medical
practice running software we don't book into directly (`10-qualification.md`). **"Books
appointments" stays the headline offer** where the business can use a connected Google Calendar
or Cal.com calendar (§2 of `01-offer.md`, "Booking request / lead capture").

**Demo line caveat:** the live demo line's prompt (v3) offers dental or real estate and still
tells callers law firms are "coming soon". Until that prompt changes, demo a law firm prospect on
the dental or real-estate flow and say so.

## 1. Who it's for

- **Trades: not sold.** The catalogue has no trades playbook; don't pitch or quote it.
- **Legal intake**: a law firm's first call is a conflict-and-fit check before anyone touches a
  calendar; the firm decides who calls back, not the caller.
- **Property enquiries**: a rental or sales enquiry ("is this still available", "can I book an
  inspection") that an agent wants captured and triaged, not auto-booked into a diary they don't
  fully control.
- **Practices whose software we don't book into** (dental, medical, allied health running
  Dentally, Core Practice, D4W or similar — `10-qualification.md` §"Which system do you use"):
  we haven't built a direct booking connection to any of these (Dentally does publish a public
  developer API, `https://developer.dentally.co/`, checked 27 Sep 2026 — possible future direct
  booking, not built today; no known public API for Core Practice or D4W), so the receptionist
  can't offer "Booked" mode there yet.

## 2. What it does

- Answers, discloses it's an automated assistant and that the call is recorded (same as every
  other mode — no exception).
- Asks what the caller needs and captures: **name, phone number, the reason for the call, and
  preferred time or urgency** (e.g. "today", "this week", "no rush").
- For property specifically: captures the **property address or listing reference** where
  relevant, so the agent isn't calling back to ask "sorry, which property was this?"
- **At go-live**, emails an alert to the business after the call (the same mechanism as the dental
  booking alert, once the alert channel is configured), with everything captured.
- Adds the caller to a **callback list** the business works from, on the same dashboard as booking
  alerts (at go-live).
- Anything urgent or life-threatening: the 000 line first, exactly as in every other mode. This
  never changes by business type.

## 3. What it doesn't do

- **Does not book anything into a calendar.** No appointment, no confirmed time, no reference
  number. If a business wants that, it needs "Booked" mode with a connected Google Calendar or
  Cal.com — see `01-offer.md` §2.
- **Does not quote a price**, give a legal, financial or clinical opinion, or assess urgency beyond
  the fixed 000 trigger wording. It never decides whether a job, a matter or a symptom is serious.
- **Does not transfer the call to a person.** Same rule as every other mode — not offered in any
  package (`03-objections.md` #7).
- **Does not replace the business's own callback discipline.** The list is only useful if someone
  actually works it; we don't promise call-back times or SLAs on the business's behalf.

## 4. Which package it maps to

**The same three packages, at the same prices.** Booking request / lead capture is a booking
mode, not a separate package: the tier follows call volume, locations and the reviews wanted
(`11-package-comparison.md`), and the proposal states which mode the client gets. There is no
separate lead-capture price, discount or non-dental package.

## 5. What we don't say

No invented market statistics. We don't say what share of calls go unanswered industry-wide, what
it costs a firm or agency in lost work, or any dollar figure for it, because we have no
sourced number for it (`01-offer.md` §"What we must never say" — the same rule that bars sector
averages for dental applies here). Any value case is built the same way as the dental value
worksheet: **their numbers, illustration not forecast, zero-benefit row shown.**
