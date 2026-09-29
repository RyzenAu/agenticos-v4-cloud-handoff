# Demo path: a booking call, start to finish (15-minute demo)

Booked on the calls and run Wed 30 Sep – Fri 2 Oct. **Every screen uses synthetic, labelled demonstration data.** Say the limits out loud: admitting a real limitation builds more trust than hiding it.

## Which demo you run depends on one fact: is booking live on the demo line?

Check `06-receptionist-readiness.md` on the morning of the demo.

| | **Mode A: before go-live (the default this week)** | **Mode B: after booking go-live is approved and retested** |
|---|---|---|
| The booking call | Play the receptionist-edition booking video, **labelled "Illustrative demonstration"** (a fictional practice, showing the flow at go-live) | Ring the demo line on speaker, choose "dental", book a check-up, receive the SMS on your own phone |
| The live line | Optional: ring it to hear the voice, the disclosure, message-taking and the 000 line. **Say first: "Today this line takes a message; it won't book."** | As above, plus the booking |
| What you must not do | Imply the line books; hand over the number as a booking demo | Use a real patient's details; book outside the fictional demo business |

## Running order

| Min | Step | What they see | What you say (and the limit you state) |
|---|---|---|---|
| 0–1 | **Their calls** | Their own site: the hours, how patients book | "Which calls would you want it to take: after hours, overflow when the desk is busy, or all calls alongside your team?" |
| 1–5 | **A booking call** | Mode A: the video. Mode B: the live call | "It says it's automated and recorded, asks what they need, offers two times from the slots you release, books, reads back a reference, and asks if they'd like a text." |
| 5–7 | **The urgent path** | A caller says "my face is really swollen and I'm struggling to breathe" | "It gives the 000 line first, every time, then takes an urgent message. It never decides how serious something is." |
| 7–9 | **What the team sees** | The receptionist dashboard with **synthetic calls only**: the booking, the email alert, the message queue, minutes used | "At go-live, every booking lands in your connected Google Calendar or Cal.com calendar and your inbox. Nothing is hidden in a recording." (Mode A: "The alert email switches on with booking at go-live.") |
| 9–11 | **The calendar fit** | A dedicated Google Calendar with released slots | "Direct booking depends on your system. It books into Google Calendar or Cal.com, not Dentally or Core Practice; we confirm compatibility in setup, or agree a booking-request workflow." |
| 11–12 | **Failure paths** | Caller asks for a person; no slots free; caller changes their mind | "If it can't book, it takes a message. It only says 'booked' when your calendar confirms. Live transfer to a person isn't offered; it tells them the team will call back." |
| 12–14 | **Packages** | `11-package-comparison.md` | Recommend one tier based on what they told you. Prices are ex GST, + 10% GST. Setup: quoted separately once approved. |
| 14–15 | **Next step** | How a practice starts (`01-offer.md`) | "Each business's booking, routing and texts are set up and tested before they go live. Shall I send the proposal?" |

## Per-prospect demo close (only once it's live — check first)

Check both before offering this: `06-receptionist-readiness.md` (is booking live at all) **and**
`D:/MU-Receptionist-wt-prompt/docs/PROSPECT-DEMO.md` (the per-prospect demo build, tracked by
another agent — it did not exist as of 27 Sep 2026 evening). **Until that doc says the per-prospect
steps are live and retested, don't use this close — run the generic demo above instead** (Mode A
or B) and the 15-minute demo ask in `02-call-script.md` §6.

Once it is live, this replaces the "Book a 15-minute demo" close, in person or on the phone:
> "Ring this number from your practice phone now — you'll hear a demonstration receptionist we
> built from your public website."

Rules, once it's live:
- **Honest framing only.** Say "demonstration" or "demo", never "your receptionist" or "it's
  live for you" — they haven't signed anything and nothing is configured for real use yet.
- It's built from their **public website only** — never anything from inside their practice
  software, patient records or anything not visible to anyone browsing their site.
- It still discloses it's automated and recorded, still gives 000 first on urgent wording, and
  still runs whichever booking mode fits their system (`10-qualification.md`) — never show
  "Booked" behaviour to a prospect who qualified as "Booking request" only.
- If it fails, breaks character, or the prospect finds it unconvincing: log it and default back to
  the 15-minute demo. Don't defend a bad demo live on the call.

## Before any demo, check
- Readiness file checked this morning: which mode?
- The dashboard shows **only synthetic or demo calls**. Never a real caller's details.
- The video is the **receptionist edition**: `C:/Users/Nebula PC/source/repos/mu-video-demos/out/receptionist/dental/dental-demo-16x9.mp4` (rendered 27 Sep, in progress on the video track). Use it only once that track marks the cut READY in its `docs/READINESS.md`; until then walk through the dashboard and the call flow in `../receptionist-pack-2026-09-28/demo-guide.docx` instead. Never use an older edition. Say "Illustrative demonstration" out loud.
- Your own mobile for any SMS demo (Mode B only). Never a prospect's number.
- The flagship dental demo site's forms are no-send/synthetic. Don't submit real details.
