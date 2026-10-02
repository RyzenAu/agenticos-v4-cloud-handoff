# Production prep: mu-creative-20261001 (2 Oct 2026)

Everything needed to finish both films once footage and narration exist, plus the vector motion graphics that could be built for free and now exist as files. **Nothing paid was run.** Higgsfield, ElevenLabs speech and every image or video model were not called.

## 1. Where things stand

| Item | State |
|---|---|
| Budget | US$25 authorised for Higgsfield. **Known spend US$0.** The Higgsfield API spend ledger is unverified, so spend nothing until it is. The MCP account has 0 credits |
| Footage | **0 of 4 clips supplied.** Prompts below are ready to submit |
| Narration | **Not recorded.** Voice and text are ready; no speech generated |
| Motion graphics | **Prepared, free, local.** Two silent 1920x1080 30 fps tracks (90.00 s and 78.00 s), 15 reduced-motion stills and two SRT files under `public/mu-creative-20261001/assets/prepared/`. They are not finished films: no footage, no audio, caption timings are estimates |
| Voice | ElevenLabs "Scotty - the friendly Australian male conversational narrator", id `hIreuBly94QFepU63yel`, category **professional** (verified 1 Oct by metadata lookup, not speech), model `eleven_multilingual_v2` |
| Flagged claim | Main scene 07, "you can see that proof in your dashboard", stays flagged until the receptionist launch session shows that dashboard evidence. Fallback wording in section 4 |

## 2. Tooling on this PC

* `ffmpeg` and `ffprobe` 9.0.2 (Gyan full build) on PATH, with `drawtext`, `subtitles`, `colorkey`, libx264. Python 3.13 with Pillow 12.2.
* The repo has a canvas motion engine (`src/motion/**`, the `/motion` page, `MOTION-LIBRARY.md`, `bun run check:motion`). It makes seamless looping styles, not timed per-scene timelines, so it was not used for these tracks. The `anim-clip` skill (canonical checkout, read only) says to use the existing pipeline, to use HyperFrames only if installed, and to check timing against the actual audio. HyperFrames is not installed (`npx --no-install hyperframes` fails), so it was not used.
* Pipeline used: Pillow draws each frame at 2x and downsamples (anti-aliased vector shapes, Georgia and Arial from `C:/Windows/Fonts`), piped into ffmpeg (libx264, CRF 17, yuv420p). Source: `docs/creative-20261001/build-prepared.py`. The whole build takes about 70 seconds.
* No fonts, logos or footage are bundled. The M&U wordmark is typeset placeholder text; use the real logo file in the final edit.

## 3. Design spec (both films)

| Token | Value | Use |
|---|---|---|
| Black | `#08090b` | M&U background, all main-film scenes |
| Ivory | `#f4f0e7` | M&U text |
| Gold | `#c7a35a` | handoff line, ticks, CTA pill, highlights |
| Panel | `#12141a` | cards on black |
| Agency palette | bg `#10201b`, panel `#18302a`, paper `#f2eee4`, accent `#7fb5a0` | Lead film scenes 2 to 6 only. The script says card styling follows the agency concept palette, not M&U black and gold. Scenes 1 and 7 stay M&U |

* **Type:** Georgia for statements and values (38 to 110 px), Arial Bold for badges and tags, Arial for the setup line. Nothing under 24 px on a 1080p frame except labels at 22 to 26 px. Safe margins 96 px.
* **Motion:** vector only. Cubic ease-out for entries (0.6 to 0.8 s), smoothstep for line traces and the travelling card. Each state holds at least 2.5 s before the next change. The motion explains the path: call, answered, questions, calendar check, confirmed, team view (main); call, details, request recorded and not booked, one handoff card travelling into the team view, booking only where a calendar is connected (lead). No particles, glows, robot heads or invented metrics.
* **"Illustrative demonstration" label:** one persistent label, bottom-right, Arial 24 px, 62 percent of the text colour, 96 px from the right and bottom edges. It fades in at 0.3 s and is gone at the end-card cut (main 0:00 to 1:20, lead 0:00 to 1:09). It is part of the graphics track, so it stays on top of any footage.
* **Reduced motion:** the page already stops autoplay under `prefers-reduced-motion`. For the films, `assets/prepared/stills/<scene-id>.png` is the end-state frame of each scene, with all information and the label visible. A reduced-motion cut is those 15 stills held for each scene length with 0.4 s dissolves, plus the same narration and captions, and no motion. Command in section 8.
* **Accessibility:** captions on by default as a soft track; end card and checklist text are 36 px or larger.


## 4. Film: The front desk that always answers (90 s, allowed 75 to 95 s)

One weekday call to a busy dental practice: answered, qualified, booked only after the calendar confirms, and visible to the team.

### Edit decision list

| Scene | In | Out | Dur | Footage / background | On-screen text | Graphics and timing | Claim status |
|---|---|---|---|---|---|---|---|
| main-01 | 0:00 | 0:07 | 7 s | dental-hero.mp4 slowed to 7 s | Tue 10:40 am (lower left, ivory serif, fades in 1.0 to 2.0 s) | Footage only; graphics are the time stamp. | scene-setting |
| main-02 | 0:07 | 0:17 | 10 s | last frame of dental-hero, dimmed, held 10 s | Incoming call, then Answered (from 3.0 s) | Card slides in from the right 0.2 to 1.0 s over the dimmed last frame of dental-hero. Gold line traces right 4.0 to 9.0 s. | illustrative-demonstration |
| main-03 | 0:17 | 0:31 | 14 s | solid #08090b | New patient / Chipped tooth / Mornings (at 1.0, 3.8, 6.6 s); tag Practice rules applied (9.4 s) | Rows type into the card; the gold line stays lit; tag with tick closes the beat. | illustrative-demonstration |
| main-04 | 0:31 | 0:43 | 12 s | solid #08090b | Checking calendar... (0 to 6.0 s); Confirmed by calendar (7.2 s); Booked (8.8 s); Thursday, 9:15 am | Week grid, scan highlight on Thursday, 9:15 slot fills gold at 6.0 s, badge, then the word Booked, only after the badge. | confirmed-only-after-calendar |
| main-05 | 0:43 | 0:54 | 11 s | solid #08090b | Team view: Caller New patient / Reason Chipped tooth / Booking Thursday 9:15 am, Confirmed by calendar / Summary (two lines) | Rows stagger in at 0.8, 2.2, 3.6 s; summary at 5.6 s. No names, no metrics. | illustrative-demonstration |
| main-06 | 0:54 | 1:06 | 12 s | solid #08090b | All calls / Alongside staff / After hours / Overflow; axis 00:00 to 24:00 | One 24-hour bar; each setting lights for about 2.9 s in turn (0.4, 3.3, 6.2, 9.1 s). No dashboard UI. | approved-positioning |
| main-07 | 1:06 | 1:20 | 14 s | solid #08090b | Booking tested / Routing tested / Texts tested (1.0, 3.5, 6.0 s); Booking-system compatibility varies; we confirm yours during setup. (9.0 s) | Three ticks in gold circles. FLAG: narration says proof in your dashboard; no dashboard is drawn. | approved-public-promise |
| main-08 | 1:20 | 1:30 | 10 s | mu-brand-loop.mp4 slowed to 10 s | M&U Ventures / An all-hours front desk for your business / Book a 15-minute demo | Type on the left two-thirds over mu-brand-loop. Gold hairline draws 1.0 to 2.0 s; CTA pill at 3.2 s. Typeset placeholder wordmark: swap in the real logo file. | call-to-action |

Total 90 s. Scene lengths are the manifest's; the graphics track was rendered to exactly 90.00 s (ffprobe).

### Narration blocks (Scotty, one file per scene)

Target speech time is words divided by 150 wpm. The rest of each scene is the briefed pause (0.35 s lead-in plus the tail).

| Scene | Words | Speech at 150 wpm | Scene length | Spare | Narration |
|---|---:|---:|---:|---:|---|
| main-01 | 15 | 6.0 s | 7 s | 1.0 s | It's Tuesday morning. The front desk is with a patient, and the phone rings again. |
| main-02 | 22 | 8.8 s | 10 s | 1.2 s | This time, it's answered straight away. The receptionist greets the caller in the practice's name, listens, and works out what they need. |
| main-03 | 32 | 12.8 s | 14 s | 1.2 s | A new patient, a chipped tooth, mornings only. It asks what your team would ask: the kind of visit, how soon, which times suit, and checks the answers against the practice's rules. |
| main-04 | 20 | 8.0 s | 12 s | 4.0 s | Then it checks the calendar. Only when the calendar confirms the slot does it say booked. Thursday, nine fifteen. Confirmed. |
| main-05 | 24 | 9.6 s | 11 s | 1.4 s | At the desk, the team can see it all: who called, why, what was booked, and a short summary, without stopping what they're doing. |
| main-06 | 23 | 9.2 s | 12 s | 2.8 s | And it works the way your practice does. Every call, or just overflow. Business hours, after hours, or alongside your staff. You choose. |
| main-07 | 34 | 13.6 s | 14 s | 0.4 s | Before anything goes live, we set up and test your booking, your call routing and your texts, and you can see that proof in your dashboard. Booking systems vary, so we confirm yours first. |
| main-08 | 13 | 5.2 s | 10 s | 4.8 s | M&U Ventures. An all-hours front desk for your business. Book a fifteen-minute demo. |

Total 183 words, 122 wpm averaged over the film including pauses.

Pacing note: main-07 has 34 words, 13.6 s of speech in a 14 s scene, so about 0.4 s spare. Record it first and check it. If it runs long, borrow one second from main-08 (its 13 words need only 5.2 s of its 10 s) rather than speeding Scotty up.

**Flagged line (main-07):** "...and you can see that proof in your dashboard." Do not record or publish this clause until the receptionist launch session shows the dashboard evidence. Fallback that makes no dashboard claim: "Before anything goes live, we set up and test your booking, your call routing and your texts. Booking systems vary, so we confirm yours first." That is 25 words, about 10 s; hold the checklist a little longer.

### Captions

Full file: `public/mu-creative-20261001/assets/prepared/main-receptionist.en-AU.srt`. **Timings are estimates** (150 wpm, 0.35 s lead-in per scene, compressed if a line would overrun its scene). Re-time every cue against the recorded narration before delivery. The text is final unless the script changes.

```srt
1
00:00:00,350 --> 00:00:01,550
It's Tuesday morning.

2
00:00:01,550 --> 00:00:06,350
The front desk is with a patient, and the phone rings again.

3
00:00:07,350 --> 00:00:09,750
This time, it's answered straight away.

4
00:00:09,750 --> 00:00:13,750
The receptionist greets the caller in the practice's name, listens,

5
00:00:13,750 --> 00:00:16,150
and works out what they need.

6
00:00:17,350 --> 00:00:20,550
A new patient, a chipped tooth, mornings only.

7
00:00:20,550 --> 00:00:24,950
It asks what your team would ask: the kind of visit,

8
00:00:24,950 --> 00:00:26,950
how soon, which times suit,

9
00:00:26,950 --> 00:00:30,150
and checks the answers against the practice's rules.

10
00:00:31,350 --> 00:00:33,350
Then it checks the calendar.

11
00:00:33,350 --> 00:00:37,750
Only when the calendar confirms the slot does it say booked.

12
00:00:37,750 --> 00:00:38,950
Thursday, nine fifteen.

13
00:00:38,950 --> 00:00:39,350
Confirmed.

14
00:00:43,350 --> 00:00:48,150
At the desk, the team can see it all: who called, why,

15
00:00:48,150 --> 00:00:52,950
what was booked, and a short summary, without stopping what they're doing.

16
00:00:54,350 --> 00:00:57,550
And it works the way your practice does.

17
00:00:57,550 --> 00:00:59,550
Every call, or just overflow.

18
00:00:59,550 --> 00:01:02,750
Business hours, after hours, or alongside your staff.

19
00:01:02,750 --> 00:01:03,550
You choose.

20
00:01:06,350 --> 00:01:10,701
Before anything goes live, we set up and test your booking,

21
00:01:10,701 --> 00:01:13,075
your call routing and your texts,

22
00:01:13,075 --> 00:01:16,635
and you can see that proof in your dashboard.

23
00:01:16,635 --> 00:01:19,800
Booking systems vary, so we confirm yours first.

24
00:01:20,350 --> 00:01:21,150
M&U Ventures.

25
00:01:21,150 --> 00:01:23,950
An all-hours front desk for your business.

26
00:01:23,950 --> 00:01:25,550
Book a fifteen-minute demo.
```


## 5. Film: From enquiry to a useful handoff (78 s, allowed 65 to 85 s)

A homeowner's selling enquiry on a Sunday evening becomes one structured handoff for an estate agent, with the request clearly recorded and nothing falsely booked.

### Edit decision list

| Scene | In | Out | Dur | Footage / background | On-screen text | Graphics and timing | Claim status |
|---|---|---|---|---|---|---|---|
| lead-01 | 0:00 | 0:08 | 8 s | property-hero.mp4 slowed to 8 s | Sun 7:20 pm (lower left, ivory serif) | Footage only; graphics are the time stamp. | scene-setting |
| lead-02 | 0:08 | 0:19 | 11 s | last frame of property-hero, dimmed, held 11 s | Incoming call, then Answered (2.5 s); Listening | Agency palette. Card slides in over the dimmed last frame of property-hero; waveform bars beside the card from 3.5 s. | illustrative-demonstration |
| lead-03 | 0:19 | 0:34 | 15 s | solid agency green #10201b | Suburb [Suburb] / Property type [Property type] / Timing [Timing] / Preferred contact [Preferred contact] | Fields type in at 1.0, 4.4, 7.8, 11.2 s, each with a tick. Bracketed placeholders only, never a real address. | illustrative-demonstration |
| lead-04 | 0:34 | 0:46 | 12 s | solid agency green #10201b | Request recorded (tick) / Appointment booked (empty) / Not booked | Two cards side by side; left lit from 0.6 s, right outlined and empty from 3.0 s, Not booked at 4.6 s. No valuation figure. | request-not-booking |
| lead-05 | 0:46 | 0:59 | 13 s | solid agency green #10201b | Agency team view; handoff card: Caller [Caller], Suburb [Suburb], Timing [Timing], Asked [Questions asked], Request recorded; One handoff, ready for the agent | Four form rows collapse into one card (0 to 1.5 s) which travels along the line into the team panel (1.5 to 6.5 s). | request-not-booking |
| lead-06 | 0:59 | 1:09 | 10 s | solid agency green #10201b | Calendar connected and tested -> Confirmed by calendar | No calendar connected -> Request recorded | Split frame, equal weight; badges appear together at 3.0 s. | confirmed-only-after-calendar |
| lead-07 | 1:09 | 1:18 | 9 s | mu-brand-loop.mp4 slowed to 9 s | M&U Ventures / Every enquiry, a useful next step / Book a 15-minute demo | As main-08 over mu-brand-loop. | call-to-action |

Total 78 s. Scene lengths are the manifest's; the graphics track was rendered to exactly 78.00 s (ffprobe).

### Narration blocks (Scotty, one file per scene)

Target speech time is words divided by 150 wpm. The rest of each scene is the briefed pause (0.35 s lead-in plus the tail).

| Scene | Words | Speech at 150 wpm | Scene length | Spare | Narration |
|---|---:|---:|---:|---:|---|
| lead-01 | 19 | 7.6 s | 8 s | 0.4 s | It's Sunday evening. A homeowner is thinking about selling, and they ring the agency they drove past this morning. |
| lead-02 | 18 | 7.2 s | 11 s | 3.8 s | The receptionist answers in the agency's name. It's friendly, it listens, and it keeps the conversation on track. |
| lead-03 | 27 | 10.8 s | 15 s | 4.2 s | It gathers what an agent actually needs: the suburb, the kind of home, when they're hoping to sell, and the best way to get back to them. |
| lead-04 | 24 | 9.6 s | 12 s | 2.4 s | Then it's straight with the caller. Their request is recorded. Nothing is booked yet, and no one has promised a price or a time. |
| lead-05 | 26 | 10.4 s | 13 s | 2.6 s | When the agent next checks in, there's one tidy handoff waiting, not a vague voicemail: who called, about which property, how soon, and what they asked. |
| lead-06 | 22 | 8.8 s | 10 s | 1.2 s | If your calendar is connected and tested, it can book the meeting too. If not, it records the request, and says so. |
| lead-07 | 15 | 6.0 s | 9 s | 3.0 s | Every enquiry, turned into a useful next step. Book a fifteen-minute demo with M&U Ventures. |

Total 151 words, 116 wpm averaged over the film including pauses.

### Captions

Full file: `public/mu-creative-20261001/assets/prepared/lead-capture.en-AU.srt`. **Timings are estimates** (150 wpm, 0.35 s lead-in per scene, compressed if a line would overrun its scene). Re-time every cue against the recorded narration before delivery. The text is final unless the script changes.

```srt
1
00:00:00,350 --> 00:00:01,526
It's Sunday evening.

2
00:00:01,526 --> 00:00:03,879
A homeowner is thinking about selling,

3
00:00:03,879 --> 00:00:07,800
and they ring the agency they drove past this morning.

4
00:00:08,350 --> 00:00:11,150
The receptionist answers in the agency's name.

5
00:00:11,150 --> 00:00:15,550
It's friendly, it listens, and it keeps the conversation on track.

6
00:00:19,350 --> 00:00:22,950
It gathers what an agent actually needs: the suburb,

7
00:00:22,950 --> 00:00:26,550
the kind of home, when they're hoping to sell,

8
00:00:26,550 --> 00:00:30,150
and the best way to get back to them.

9
00:00:34,350 --> 00:00:36,750
Then it's straight with the caller.

10
00:00:36,750 --> 00:00:38,350
Their request is recorded.

11
00:00:38,350 --> 00:00:39,950
Nothing is booked yet,

12
00:00:39,950 --> 00:00:43,950
and no one has promised a price or a time.

13
00:00:46,350 --> 00:00:50,750
When the agent next checks in, there's one tidy handoff waiting,

14
00:00:50,750 --> 00:00:55,150
not a vague voicemail: who called, about which property, how soon,

15
00:00:55,150 --> 00:00:56,750
and what they asked.

16
00:00:59,350 --> 00:01:02,150
If your calendar is connected and tested,

17
00:01:02,150 --> 00:01:04,550
it can book the meeting too.

18
00:01:04,550 --> 00:01:08,150
If not, it records the request, and says so.

19
00:01:09,350 --> 00:01:12,550
Every enquiry, turned into a useful next step.

20
00:01:12,550 --> 00:01:15,350
Book a fifteen-minute demo with M&U Ventures.
```


## 6. Clip prompts (ready to submit; not submitted)

Four clips, each 5 s, 16:9, one camera move, no cuts. Provider settings are not chosen here: no model is called best without a comparison, and API pricing stays pending real receipts. Submit one clip first and inspect it before the rest.

### shot-dental: `assets/dental-hero.mp4` (5 s, 16:9)

Purpose: Opening shot of the main receptionist film and hero loop of the dental website preview.

Prompt:

> Empty contemporary dental practice, reception opening into a treatment corridor. Eye-level framing, centred one-point perspective, corridor leading towards soft window light. Materials: pale oak joinery, matte white walls, warm limestone floor, brushed stainless details, one green plant. Light: clear Australian morning daylight through large windows, soft natural shadows, neutral white balance. Camera: one slow, steady forward dolly of about one metre, no cuts, no shake. Realistic photographic look, 35mm lens, readable depth of field.

Negative requirements: No people, patients or staff; No dental treatment, instruments in use or clinical procedures; No logos, brand marks, readable signage or text; No lens flare, glow effects or particles; No warped or distorted architecture.

Acceptance on arrival: 5 s or longer (trim to 5 s), 16:9, one camera move, nothing excluded present, no warped architecture. Save under `public/mu-creative-20261001/assets/` with the filename above; the page then flips its pending state to ready by itself.

### shot-property: `assets/property-hero.mp4` (5 s, 16:9)

Purpose: Opening shot of the lead-capture film and hero loop of the property website preview.

Prompt:

> Unbranded contemporary Australian residential living room opening to a covered deck and garden. Composed architectural framing at chest height, level horizon, true verticals. Materials: light timber floor, off-white rendered walls, linen sofa, stone benchtop in the background, large sliding glass doors. Light: late-afternoon warm natural light with gentle falloff. Camera: one restrained lateral glide left to right of about half a metre, no cuts, no shake. Realistic architectural photography look, 24mm lens.

Negative requirements: No people; No for-sale signs, agency boards, logos or readable text; No recognisable real address, street or landmark; No exaggerated HDR, glow or particles; No warped furniture or bending lines.

Acceptance on arrival: 5 s or longer (trim to 5 s), 16:9, one camera move, nothing excluded present, no warped architecture. Save under `public/mu-creative-20261001/assets/` with the filename above; the page then flips its pending state to ready by itself.

### shot-trades: `assets/trades-hero.mp4` (5 s, 16:9)

Purpose: Hero loop of the trades website preview; available as a cutaway for later trades films.

Prompt:

> Clean, organised electrical trades workshop. Waist-height framing along a workbench with neatly coiled cable, unlabelled storage drawers, a pegboard of hand tools, a closed switchboard enclosure, and a ute tray just visible through an open roller door. Materials: galvanised steel, plywood benchtop, matte grey concrete floor. Light: bright, even daylight from the roller door with soft fill. Camera: one slow lateral move of about half a metre, no cuts, no shake. Realistic documentary look, 35mm lens.

Negative requirements: No people; No unsafe work, exposed live wiring, sparks or smoke; No logos, brand marks, readable signage or text; No clutter, mess or damaged equipment; No glow effects or particles.

Acceptance on arrival: 5 s or longer (trim to 5 s), 16:9, one camera move, nothing excluded present, no warped architecture. Save under `public/mu-creative-20261001/assets/` with the filename above; the page then flips its pending state to ready by itself.

### shot-brand: `assets/mu-brand-loop.mp4` (5 s, 16:9)

Purpose: M&U end card and brand background; typography is added during editing.

Prompt:

> Abstract architectural close-up: warm metallic gold light slowly sweeping across a near-black surface of fluted stone or brushed black metal. The left two-thirds of the frame stay dark and calm as negative space for typography. Colour: deep black near #08090b with restrained gold highlights near #c7a35a. Camera: locked off or an almost imperceptible drift; the motion comes from the light. Photographic material realism.

Negative requirements: No baked-in text, letters, numbers or logos; No robot heads, faces, figures or generic AI imagery; No particle clouds, bokeh, sparks or lens flares; No saturated or rainbow colour; No fast motion or cuts.

Acceptance on arrival: 5 s or longer (trim to 5 s), 16:9, one camera move, nothing excluded present, no warped architecture. Save under `public/mu-creative-20261001/assets/` with the filename above; the page then flips its pending state to ready by itself.


## 7. Narration job (ready, not run)

* Provider and voice: ElevenLabs, voice id `hIreuBly94QFepU63yel` (Scotty, professional), model `eleven_multilingual_v2`. Jarvis's runtime voice is unchanged.
* One request per scene, using the exact `narration` string of each scene in `production-manifest.json` (the Narration column above). Save as `<scene-id>.wav` or `.mp3` in one folder per film, for example `D:/prog-scratch/creative-narration/main/main-01.wav`. Per-scene files let `assemble-film.py` place each at its scene start plus 0.35 s.
* Say numbers as written ("nine fifteen", "fifteen-minute demo"). Do not add anything that is not in the script.
* Cost: speech generation is paid and needs the owner's yes. Main film 183 words, lead film 151 words, 334 in total before any retakes.
* After recording: check each file against its scene length in the tables above, then re-time the SRT.

## 8. Exact commands (all local and free)

Run from `D:/AgenticOS-r5-creative` (or the merged checkout).

```text
# 1. Rebuild graphics tracks, SRT and stills from the manifest (about 70 s)
python docs/creative-20261001/build-prepared.py
python docs/creative-20261001/build-prepared.py --film main --stills-only     # stills and SRT only

# 2. Consistency check: manifest vs embedded copy, links, voice entry, spend wording
python docs/creative-20261001/check-creative.py

# 3. Verify an output
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact public/mu-creative-20261001/assets/prepared/main-receptionist-graphics.mp4

# 4. When the four clips exist in a folder (narration folder optional):
python docs/creative-20261001/assemble-film.py --film main --footage <clip-folder> --narration <narration-folder> --out <out>/main-receptionist.mp4
python docs/creative-20261001/assemble-film.py --film lead --footage <clip-folder> --narration <narration-folder> --out <out>/lead-capture.mp4
#    add --burn to render captions into the picture; the default is a soft mov_text track
```

`assemble-film.py` was tested with placeholder gradient clips and tone files (outside the repo, never shown as footage): the main test gave 90.00 s with H.264 video, AAC audio and a subtitle track, and the lead test gave 78.00 s with burned captions. It stops and names any missing clip; it never invents footage.

Reduced-motion cut (stills held, 0.4 s dissolves). Chain one `xfade` per cut with offset equal to the cumulative scene end minus 0.4 s per join, for example for the first two main scenes:

```text
ffmpeg -y -loop 1 -framerate 30 -t 7 -i stills/main-01.png -loop 1 -framerate 30 -t 10 -i stills/main-02.png -filter_complex "[0][1]xfade=transition=fade:duration=0.4:offset=6.6" -c:v libx264 -pix_fmt yuv420p reduced-motion-test.mp4
```

The full chain was not built now because it depends on the final scene lengths after narration.

## 9. What still needs paid generation or the owner

1. **Four clips** (Higgsfield): the owner's yes, and a verified API ledger before any of the US$25 is spent.
2. **Scotty narration** (ElevenLabs, about 334 words): the owner's yes.
3. **Dashboard evidence** from the receptionist launch session for main-07, or use the fallback line.
4. **Real M&U logo and brand font files** for the end cards.
5. **Final edit, re-timed captions and a watch-through** of both films with footage and audio in place. Only then can the page say "rendered".
6. Codex review of the supplied footage, as the brief assigns.
