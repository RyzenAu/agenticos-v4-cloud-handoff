# M&U creative production — 1 October 2026

Working brief and build record for campaign `mu-creative-20261001`. Source brief: `C:/Users/Nebula PC/source/repos/AgenticOS-v4/docs/creative-20261001/BRIEF.md` (not edited, and outside this build's worktree). Check this record against that file before production.

## Outputs

| File | Contents |
|---|---|
| `public/mu-creative-20261001/index.html` | Single-file presentation with **Film scripts**, **Website previews** and **Assets** tabs |
| `public/mu-creative-20261001/production-manifest.json` | Campaign manifest: voice, both films scene by scene, four shot prompts |
| `public/mu-creative-20261001/creative-brief.md` | This file |
| `public/mu-creative-20261001/assets/prepared/` | Silent motion-graphics tracks, SRT captions and reduced-motion stills (no footage, no narration) |
| `docs/creative-20261001/PRODUCTION-PREP.md` | Edit lists, narration blocks, render commands |

The presentation embeds the manifest's films, claim key and shots so it works from `file://`. If the manifest changes, update the embedded copy too.

## Fixed inputs

- **Narration:** Scotty ("the friendly Australian male conversational narrator"), ElevenLabs professional voice `hIreuBly94QFepU63yel` (category professional, not stock; verified by metadata lookup on 1 Oct), `eleven_multilingual_v2`. Not recorded in this build. Jarvis's runtime voice is unchanged.
- **Generation budget:** US$25 maximum for Higgsfield. Known spend: US$0; the Higgsfield API spend ledger is unverified, so spend nothing further until it is.
- **CTA:** Book a 15-minute demo.
- **Brand:** `#08090b`, `#f4f0e7`, `#c7a35a`, used for M&U material only. Client templates keep their own sector styles.

## Business truth used in every line

- All-hours front desk: all calls, business hours, alongside staff, after hours or overflow, set for each client.
- A booking is "booked" only after the calendar confirms. A recorded request is not an appointment.
- No invented staff, reviews, clinical results, valuations, metrics or live product captures.
- Human transfer is not claimed in either film.
- Demonstrations carry one discreet **Illustrative demonstration** label.
- Pricing is left out because neither film needs it. Setup fees and pilot terms are not approved and do not appear.

## Film 1: main receptionist, "The front desk that always answers"

90 seconds (allowed 75–95). 183 words, about 122 wpm on average; no scene is above 155 wpm.

One story: a weekday call to a busy dental practice is answered, qualified, booked only after the calendar confirms, and shown to the team. Flexible coverage gets one scene. The tested-setup promise and the single booking-system line close the film.

| # | Time | Beat |
|---|---|---|
| 1 | 0:00–0:07 | Tuesday morning; the desk is busy |
| 2 | 0:07–0:17 | Answered in the practice's name |
| 3 | 0:17–0:31 | Scheduling questions checked against practice rules |
| 4 | 0:31–0:43 | Calendar check, then "booked" |
| 5 | 0:43–0:54 | The team sees the summary |
| 6 | 0:54–1:06 | Coverage: all calls, overflow, after hours, alongside staff |
| 7 | 1:06–1:20 | Setup tested before going live; booking systems vary |
| 8 | 1:20–1:30 | End card: Book a 15-minute demo |

## Film 2: lead capture, "From enquiry to a useful handoff"

78 seconds (allowed 65–85). 151 words, about 116 wpm on average.

One story: a homeowner's Sunday-evening selling enquiry becomes one structured handoff for an estate agent. Scene 4 clearly separates *request recorded* from *appointment booked*. No valuation or callback time is promised. Booking is shown only where a calendar is connected and tested.

| # | Time | Beat |
|---|---|---|
| 1 | 0:00–0:08 | Sunday evening; homeowner rings the agency |
| 2 | 0:08–0:19 | Answered in the agency's name |
| 3 | 0:19–0:34 | Structured details captured |
| 4 | 0:34–0:46 | Request recorded, nothing booked, no price or time promised |
| 5 | 0:46–0:59 | One tidy handoff for the agent |
| 6 | 0:59–1:09 | With a tested calendar it can book; without one it records |
| 7 | 1:09–1:18 | End card: Book a 15-minute demo |

Full narration, visuals and claim-evidence status for each scene are in `production-manifest.json` and the Film scripts tab.

## Website previews

Three concept templates: dental (contemporary daylit), property (composed, editorial) and trades (clean workshop). Each one has:

- one banner reading "Concept template: not a deployed client site" and "Illustrative demonstration"
- bracketed placeholders instead of invented names, staff or reviews
- a hero video loop with honest pending and missing states in a fixed 16:9 box, so a missing file never collapses the layout
- a local-only enquiry form that sends nothing and says so
- a Desktop / Phone 390px toggle, using container queries so the phone view reflows

## Generation plan

Four five-second 16:9 clips. Prompts and exclusions are in the manifest.

1. `assets/dental-hero.mp4`: empty daylit dental corridor, slow forward dolly
2. `assets/property-hero.mp4`: unbranded Australian residential interior, lateral glide
3. `assets/trades-hero.mp4`: clean electrical workshop, slow lateral move
4. `assets/mu-brand-loop.mp4`: gold light across black material, with negative space for type

No model is called best without a comparison. API pricing and cashback stay pending until real receipts arrive. Higgsfield API credits and subscription or MCP credits are separate billing products.

## Motion and access

- The handoff diagram shows the call-to-booking or enquiry-to-agent path. It has a pause control and is static under reduced motion.
- Preview videos autoplay muted only when visible and when reduced motion is off. Each one has a play/pause button.
- Tabs follow the ARIA tabs pattern with arrow, Home and End keys, and each tab can be opened by URL hash.

## Status

Prepared. Motion graphics for both films exist as silent tracks; footage is 0 of 4 clips and narration is not recorded. This build does not establish final rendered films, recorded narration, provider acceptance of the prompts or deployed practice sites.
