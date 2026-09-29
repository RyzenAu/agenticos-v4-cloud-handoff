# Public-video research study — 27 Sep 2026

## Method

- **Model:** `gemini-3.8-flash` via the Gemini API `fileData` YouTube route (the model was given each public YouTube URL directly — it watched and listened to the full video itself; this is model analysis, not a human transcript or a human viewing).
- **Tool:** `gem.ts video gemini-3.8-flash <youtubeUrl> <outName> prompt-video.txt`, run one call at a time, no parallel calls, no paid route.
- **Dates:** videos found and verified public 27 Sep 2026; all 10 Gemini calls made 27 Sep 2026 (UTC timestamps in `usage.jsonl` show 26 Sep late evening UTC = 27 Sep AEST).
- **Selection:** 10 public YouTube videos, 2–3 per group, each verified to load and be public (checked title, view count and on-player duration in‑browser before running) and under ~12 minutes (actual range 1:16–9:41).
- **Per-video output:** structured Markdown — beat list with **SAW** vs **HEARD** tags, first-5-seconds hook analysis, up to 6 techniques worth adapting, accessibility notes, and "what not to copy." Quotes are kept under 15 consecutive words. Raw per-video outputs are copied unedited into `research/video-study-raw/`.
- **Interpretation vs observation:** each per-video file prefixes Gemini's own inferences with "Interpretation:" — those are Gemini's read, not a human researcher's. This document's final "Production-system lessons" section is Usman/M&U's synthesis on top of that.

## Video table

| Group | Title | URL | Length | 1-line lesson |
|---|---|---|---|---|
| A — SaaS/product explainer | So Yeah, We Tried Slack… | https://www.youtube.com/watch?v=B6zVzWU95Sw | 2:22 | Open with a reluctant-customer testimonial, not a feature pitch. |
| A — SaaS/product explainer | Dropbox Intro Video (Common Craft, 2009) | https://www.youtube.com/watch?v=w4eTR7tci6A | 2:18 | A single everyday-inconvenience hook beats a technical opener. |
| A — SaaS/product explainer | Meet Asana, your work manager. But better. | https://www.youtube.com/watch?v=jY0-gsNImlk | 1:17 | Physicalise the invisible cost (missed calls, lost bookings) as visual debris. |
| B — AI voice receptionist demo | AI Call Center from Future: Building a FIRE VOICE AGENT: Retell AI | https://www.youtube.com/watch?v=OcEGgDaq6JM | 8:37 | Show the guardrail and the interruption-handling live, not just a spec sheet. |
| B — AI voice receptionist demo | We Tested Bland AI's Voice Agent. Here's What Happened | https://www.youtube.com/watch?v=-j4XDojlGLc | 8:22 | Labelled stress-test banners (silence, objection, topic switch) read as credible; admitting flaws builds trust. |
| B — AI voice receptionist demo | Bland: AI Phone Calls for Businesses | https://www.youtube.com/watch?v=YKk1p9oUedk | 1:48 | An IVR-hold-time pain hook lands in 5 seconds flat — skip the platform tour. |
| C — Dental patient-journey/practice promo | New Dentist Office - Innovative Dental (facility preview) | https://www.youtube.com/watch?v=N9vXcHqtoj4 | 5:04 | Owner-on-camera + lifestyle framing (fire pits, not drills) reframes the visit as hospitality. |
| C — Dental patient-journey/practice promo | My Dental Office Tour (Teeth Talk Girl) | https://www.youtube.com/watch?v=zQawxU8wv70 | 5:30 | A single continuous POV walk from waiting room to back-of-house is the calmest possible "dry run" for a nervous patient. |
| D — Motion-design/UI breakdown | Give Me 9 Minutes & Make INSANE Website Animations | https://www.youtube.com/watch?v=q5UFK4ziDuE | 9:41 | "Doing less, but better" (one typeface, one accent colour, negative space) is the actual driver of the expensive look — not the animation. |
| D — Motion-design/UI breakdown | AWWWARDS-Level Scroll Video Effects | https://www.youtube.com/watch?v=n6g9YNVkxNo | 5:21 | Prove the finished result in the first 25 seconds, before any code/setup is shown. |

## Per-video notes

### A1 — So Yeah, We Tried Slack… (2:22)
**Gemini's analysis:**
- Hook (0:00–0:05): founder Adam, on camera, recounts Slack's own founder emailing him — establishes a *reluctant, skeptical customer* rather than a marketer.
- Key beats: 0:18–0:37 visualises communication chaos as floating UI notification cards physically crowding the founder; 0:38 onward shows "today" — the same office, calm, with clean Slack message bubbles; 1:04–1:28 shows drag-and-drop file sharing and inline audio playback as fast, clutter-free screen inserts; 2:11 pulls back to reveal the film crew, a meta payoff.
- Techniques flagged: floating in-situ UI bubbles anchored to real desks (0:18); the "reluctant skeptic" testimonial frame (0:02–0:17); problem escalation via rotating high-angle camera (0:30–0:35); clean full-screen UI demo capture (1:06); dynamic logo-wall for integrations (1:17); the behind-the-scenes reveal as a pacing payoff (2:11).
- Accessibility: no burned-in captions; on-screen UI cards are high-contrast but flash by in under a second.
- What not to copy: Slack/partner branding; the "cool creative studio" meta joke (Gemini interpretation: would confuse a dental/trades/real-estate buyer who wants ROI, not humour); uncaptioned floating text cards.

### A2 — Dropbox Intro Video, Common Craft (2:18)
**Gemini's analysis:**
- Hook (0:00–0:05): "You've been there" — narrator describes forgetting a wallet in different pants, paired with a paper-cutout customer patting empty pockets. No jargon at all in the first 5 seconds.
- Key beats: 0:19–0:35 introduces the "digital magic pocket" metaphor; 0:36–0:52 anchors the whole demo to one protagonist ("Josh") planning an Africa trip; 0:52–1:17 shows simultaneous sync across three devices with icons flipping from question-marks to green ticks; 1:17–1:37 uses a sunk 4x4 and ruined laptop as a comic worst-case that resolves painlessly via the web.
- Techniques flagged: physical-analogy framing (0:08); problem-to-resolution icon shorthand (0:22); single-protagonist narrative anchor (0:36); simultaneous multi-device staging (0:57); comedic disaster-relief beat (1:28); calm unhurried voice tone throughout.
- Accessibility: no captions; strong black-on-white contrast; on-screen labels held several seconds (readable).
- What not to copy: the stop-motion paper-cutout look itself (Gemini interpretation: reads as dated for a "reliable, enterprise-grade" pitch); the "magic pocket" IP; file-sync-specific metaphors (luggage, USB) that don't map to call handling.

### A3 — Meet Asana, your work manager. But better. (1:17)
**Gemini's analysis:**
- Hook (0:01): a stated statistic ("60% of your team's time…") is dramatised instantly as an avalanche of admin junk burying a calm desk worker.
- Key beats: 0:14 a "white dome" clears the chaos into organised avatars; 0:18–0:25 tasks slide into a clean timeline; 0:32–0:39 a 4-second seamless morph between List/Kanban/Calendar/Timeline views; 0:40–0:46 a real photographic hand flattens a workload spike drawn as a graph; 1:00–1:08 scales up to company-level "on track" metric cards.
- Techniques flagged: physicalising digital friction as literal debris (0:05–0:09); stylised/simplified UI rather than raw screen capture (0:32–0:39); mixed-media real-hand-on-vector-graph interaction (0:43–0:46); seamless multi-view morph transitions (0:35–0:39); a mobile-approval micro-interaction with tactile sound (0:54–0:58); calm, non-aggressive ~135wpm narrator tone throughout.
- Accessibility: no burned-in captions (flagged by Gemini as a gap for muted social feeds); strong text contrast; UI labels held 1.5–2.5s (comfortable).
- What not to copy: the specific "60% / LA-to-New-York" US enterprise stat and metaphor; corporate abstract-shape visual language; the creative-agency-specific mood-board sequence (0:25–0:31) — Gemini's interpretation is to swap this for job quotes/patient appointments/after-hours call transcripts for a tradie or dental audience.

### B1 — AI Call Center from Future: Building a FIRE VOICE AGENT: Retell AI (8:37)
**Gemini's analysis:**
- Hook (0:00–0:05): direct product positioning over the vendor's own hero page ("Meet your AI call center from the future"), immediately followed by a promise to test it live — no dramatised customer pain first.
- Key beats: 0:37–1:43 builds a single-prompt voice agent from scratch with an explicit "## Important Boundary" guardrail against giving financial advice; 1:44–2:09 configures "AI speaks first"; 3:30–4:08 a **live, uncut** audio test where the caller interrupts mid-sentence and the agent handles the barge-in cleanly; 5:20–6:29 shows analytics (1200ms latency, sentiment graphs), live monitoring, and an automated QA scoring dashboard; 6:30–7:42 shows CRM integrations (HubSpot/Salesforce) and compliance certifications (HIPAA, SOC 2, GDPR — explicitly no EU hosting).
- Techniques flagged: explicit boundary/guardrail highlighting to pre-empt hallucination fears (1:16); "AI speaks first" greeting shown as a toggle (1:48); uncut live interruption test as the core proof point (3:30–4:08); post-call telemetry/sentiment dashboard (5:25); automated QA scoring reframing the bot as "measured," not "risky" (6:02); CRM connector cards (6:33).
- Accessibility: no burned-in captions; dashboard text high-contrast but small telemetry numbers at 5:30 pass by too quickly for mobile.
- What not to copy: raw markdown system-prompt text (would overwhelm a non-technical clinic manager — Gemini's interpretation is to show simplified settings like "Custom Business FAQs" instead); an empty "No Ongoing Calls" dashboard state; vendor/model branding and token counts (should stay white-labelled); the EU-data-residency gap should not simply be left hanging for an Australian audience — flag APPs/local handling instead.

### B2 — We Tested Bland AI's Voice Agent. Here's What Happened (8:22)
**Gemini's analysis:**
- Hook (0:00–0:05): a 2-second logo sting into a dry technical definition ("self-hosted, enterprise-grade conversational AI platform…") — Gemini's interpretation: too dry for a local-business audience; a scenario-first hook would work better.
- Key beats: 13 labelled, banner-marked live stress tests run back-to-back on a real phone call — naturalness, lead qualification, interruption, topic switching, guardrail-poking, AI disclosure, language switching (agent politely declines French), ambiguity ("can you file my taxes?"), silence handling, price objection, escalation request (agent admits it *can't* transfer to a human), tool execution (agent admits it *can't* send SMS/email), and call closing. 6:22–7:50 is a candid pros/cons breakdown including the two capability gaps.
- Techniques flagged: structured test-case banners + a pulsing "LIVE DEMO" bug that gamifies the test (1:11 onward); a humorous meme cutaway on a real audio glitch that reinforces authenticity (1:08); a deliberate silence stress-test where the host stops talking and lets the agent recover (4:20); a transparent strengths-vs-flaws breakdown on camera (6:35) that Gemini flags as building real credibility with sceptical small-business owners.
- Accessibility: no burned-in captions; on-screen test banners readable for 5–10 seconds.
- What not to copy: the dry enterprise-jargon opener; holding a phone speaker up to a desk mic (caused real feedback screeches) — record the digital audio stream directly instead; and, critically, this agent genuinely **failed** call transfer and SMS follow-up — Gemini's interpretation is that a dental/tradie demo has to show those working to be commercially credible.

### B3 — Bland: AI Phone Calls for Businesses (1:48)
**Gemini's analysis:**
- Hook (0:00–0:05): a man at a rundown payphone hears an IVR announce a 4-hour wait, slams the phone down, and turns straight to camera — pure pain-then-relief in 5 seconds, no platform screenshots at all.
- Key beats: 0:10 crew visibly remove props mid-shot (fourth-wall break); 0:15 a banner plane carries the demo phone number instead of a text overlay; 0:21–0:47 the founder rides a custom giant telephone-car while the AI switches between a neutral voice, a cowboy accent and Spanish mid-sentence to prove multilingual range; 1:04–1:15 physical props (torn calendar page, tossed calculator) stand in for booking and payment features; 1:38 the receiver is thrust into the lens before a hard cut to the logo.
- Techniques flagged: fast physical in-scene prop transitions (0:05); ambient in-world CTA placement instead of a graphic overlay (0:15); personifying the AI as a literal speaking character rather than a screen recording (0:26); rapid multi-persona vocal switching as instant audible proof of range (0:33–0:41); physical-prop stand-ins for abstract backend features (1:07–1:15); a handset-to-lens punch as a transition into the branding card (1:38).
- Accessibility: full kinetic burned-in captions throughout, word-by-word, tracking speech pace — the strongest captioning of any video in this study.
- What not to copy: the custom drivable phone-car prop (Gemini's interpretation: unaffordable and mismatched for a local agency — use a real reception desk or workshop instead); name-dropping enterprise clients without rights; "millions of calls, any language" venture-scale claims that would sound implausible from a local Sydney agency (use local, concrete metrics instead); the "offshored call centre guy" jab, which risks reading as unprofessional.

### C1 — New Dentist Office - Innovative Dental (5:04)
**Gemini's analysis:**
- Hook (0:00–0:05): Dr. O, outdoors in an empty field (not the clinic), states directly he's *not* at Innovative Dental — a deliberate setting-disruption hook.
- Key beats: 0:45–3:42 is an almost entirely music-only 3D architectural flythrough of a planned facility — exterior, courtyard with fire pit and pond, day-to-night lighting change — before Dr. O returns on camera at 3:42 to thank viewers and orient the location against real local landmarks (Highway 65, a nearby hospital).
- Techniques flagged: direct personal hook via setting disruption (0:00); clean 3D pre-visualisation flythrough pacing (0:45); lifestyle/hospitality framing over clinical equipment — fire pits and water features, not dental chairs (1:30); day-to-dusk-to-night lighting transition for visual variety (3:30); tangible local-landmark anchoring via handheld pointing (4:15).
- Accessibility: no captions at all; small low-contrast architectural-partner branding.
- What not to copy: nearly 3 minutes of narration-free CGI (Gemini flags this as a drop-off risk for a conversion asset — needs voiceover callouts on parking/comfort/check-in if reused); third-party architectural-partner branding; 20+ seconds of dead black-screen outro.

### C2 — My Dental Office Tour, Teeth Talk Girl (5:30)
**Gemini's analysis:**
- Hook (0:00–0:05): presenter Whitney, in full PPE (mask, cap, gown, loupes), addresses camera directly and introduces herself — instant clinical authority, no title card needed first.
- Key beats: a single continuous POV walk from waiting room (0:12) through panoramic X-ray (0:20), two working operatories (0:37, 0:58), sterilisation bay (1:56), staff breakroom and laundry (2:50–3:44), lab bench and supply/IT closet (3:50–3:58), back to reception and the patient restroom (4:40–4:48) before sign-off.
- Techniques flagged: continuous single-take POV flow from entry to treatment areas as a "dry run" for anxious patients (0:12); host's clinical attire doubling as passive branding (0:01, 0:38); feature-to-workflow spatial walkthrough — showing *why* a room is laid out that way, not just that it exists (1:00); back-of-house transparency (sterilisation, lab, storage) as a trust signal (1:58, 3:58); warm, high-energy unscripted voice tone; a full-circle structure that ends back at the exact touchpoint (reception) where a booking happens (4:40).
- Accessibility: no burned-in captions except a 2-second animated title card; zero lower-third room labels, which Gemini flags as a real gap for muted viewers.
- What not to copy: surgical-mask audio muffling — use a lavalier mic for a produced asset; personal-brand merchandise mentions; visible clutter in the back-of-house staging; playing licensed music via a smart speaker on camera (copyright risk).

### D1 — Give Me 9 Minutes & Make INSANE Website Animations (9:41)
**Gemini's analysis:**
- Hook (0:00–0:05): host states the promise directly ("teach you how to build scroll animations…") then hard-cuts into an isometric mockup of a scroll-scrubbed product page with a bass-sweep sound effect.
- Key beats: 0:59 the video's central design thesis — "expensive looking websites aren't about doing more… doing less, but better" — delivered as an animated highlight card; 1:07–2:14 breaks down Apple's actual restraint (one typeface, monochrome base + one accent colour, generous white space) *before* any animation is discussed; 2:50 reveals that "3D" scroll animations are usually pre-rendered video scrubbed by scroll position, not live 3D; 7:47–8:19 zooms in on a subtle background-colour mismatch as a "craft" flaw worth fixing with a CSS gradient mask.
- Techniques flagged: physical hand-gesture driving hard cuts (0:03); crude "ugly" pixel-art contrast for pain points/failed projects (0:46); a single-aphorism highlight card ("doing less, but better") for landing a strategic point without overload (1:00); rough-sketch-vs-polished-output side by side to lower the intimidation barrier (4:36); extreme-zoom "problem isolation" on a tiny flaw to justify craft/pricing (7:49); scrubbing demo timed to voice cadence to prove the mechanic fast (2:56).
- Accessibility: no burned-in captions; paper-card text has strong contrast; dark-mode code snippets are small on mobile.
- What not to copy: unlicensed Apple product renders/assets; the claim that a complex interactive build takes "an afternoon" (Gemini's interpretation: would undercut a Sydney agency's own pricing/scoping with a dental or trades client); unexplained technical jargon ("neo-grotesk," "GSAP") without plain-English translation; overpromising AI-video consistency given known temporal-morphing artifacts in the generation tools shown.

### D2 — AWWWARDS-Level Scroll Video Effects (5:21)
**Gemini's analysis:**
- Hook (0:00–0:08): bold kinetic on-screen text over a synthwave grid promises an "absolutely mind blowing" effect that's actually simple, read aloud by an enthusiastic voiceover.
- Key beats: 0:22–0:41 shows the finished, working scroll-scrubbed video effect *before* any code is shown; 0:41–2:28 walks through the minimal HTML/CSS needed (fixed-position video, Lenis smooth-scroll); 2:33–3:57 builds the core JS loop mapping `window.scrollY` to `video.currentTime`; 4:45–5:03 demonstrates the effect working in both scroll directions.
- Techniques flagged: dynamic kinetic on-screen subtitles synced to speech during the hook (0:08); showing the finished result within the first 25 seconds, before any setup (0:22) — Gemini's interpretation: for a trade/dental client, show the working booking widget or hero live within ~15 seconds; a glowing rounded-corner code-window frame instead of raw desktop capture (0:43); sequential line-by-line code reveal without live-typing stumbles (2:35); translating an abstract formula into a concrete number (2,500px of scroll = 2.5 seconds of video) at 3:27; demonstrating forward *and* reverse scroll interaction to prove stability (4:48).
- Accessibility: kinetic captions appear only on the intro/outro; captions vanish entirely for the ~4.5-minute coding-tutorial body — Gemini flags this as a real gap for a persistent-caption sales asset.
- What not to copy: official Apple iPhone launch footage/assets; the lack of any mobile/touch-scroll fallback in the code shown (would cause battery drain and choppy scrubbing on iOS Safari if reused as-is); dropping captions mid-video.

## Production-system lessons for our 15–20s hook, 45–60s explainer and 75–120s demo

1. **The first 5 seconds should establish a real, specific pain — not a feature claim.** Slack A1 (0:02–0:17), Dropbox A2 (0:00–0:05) and Bland B3 (0:00–0:05) all open on a relatable inconvenience before naming the product; Retell B1 and Bland B2 open on dry product definitions and read weaker for it.
2. **For the 15–20s hook: dramatise the cost of a missed call/booking as physical clutter or a countdown**, the way Asana A3 (0:05–0:09) turns "60% of time wasted" into literal debris — swap in a Sydney-specific stat (e.g. missed after-hours calls at a dental clinic).
3. **Show the working result before any setup or code.** D2 (0:22–0:41) proves the effect in the first 25 seconds; D1 opens with the finished isometric mockup at 0:03–0:07. Apply this to the 75–120s demo: show the AI receptionist actually answering and booking before explaining how it was configured.
4. **Live, uncut interruption/edge-case handling is the single strongest proof point for an AI voice product.** Retell B1's uncut barge-in test (3:30–4:08) and Bland B2's 13 labelled stress tests (silence, objection, topic switch) both read as far more credible than a scripted call.
5. **Admitting a real limitation on camera builds trust rather than costing it** — B2's candid pros/cons breakdown (6:22–7:50), including two capability gaps (no call transfer, no SMS). Our demo shouldn't hide what the receptionist can't yet do.
6. **Visual design restraint reads as "expensive," not motion.** D1's stated thesis at 0:59 — one typeface, a near-monochrome palette plus one accent colour, generous white space — should be the default for every site we ship, before we reach for scroll animation at all.
7. **Reframe the dental visit as hospitality, not clinical procedure.** C1 (1:30–2:22, fire pits/water features/lounge seating) and C2's continuous calm walkthrough (0:12–4:40) both avoid dental-chair imagery; our dental hero content should do the same.
8. **A single continuous POV walkthrough from entry to back-of-house is the cheapest, most effective "reduce patient anxiety" asset** — C2, 0:12–4:40, one take, no cuts.
9. **Physicalise abstract software features instead of showing raw dashboards.** B3 (1:04–1:15, torn calendar page = booking, tossed calculator = payment security) and A3 (0:32–0:39, simplified vector UI instead of a 1080p screen capture) both land better than a literal screen recording — use this for the receptionist's booking/CRM-sync beats.
10. **Persistent, burned-in captions matter and are the most commonly skipped element** — 7 of 10 videos analysed had no open captions at all, and D2 explicitly drops its captions after the intro. Every M&U hook/explainer/demo should carry open captions the entire way through, not just in the cold open.
11. **A single-protagonist anchor beats a feature list.** Dropbox A2 follows one traveller ("Josh") through one trip; our 45–60s explainer should follow one fictional patient or one tradie's missed call through the whole flow rather than listing capabilities.
12. **Live compliance/telemetry evidence (latency numbers, sentiment score, QA score) reframes an AI receptionist from "risky bot" to "managed, measured asset."** Retell B1, 5:20–6:29 — worth a 3–5 second beat in the 75–120s demo showing a real call-quality score, adapted to reference Australian Privacy Principles rather than the vendor's own (non-Australian) compliance badges.

## Usage table

| Video | Status | Prompt tokens | Output tokens | Total tokens | Notes |
|---|---:|---:|---:|---:|---|
| A1 Slack | 200 | 12,987 | 2,020 | 15,866 | |
| A2 Dropbox | 200 | 12,707 | 1,671 | 16,121 | |
| A3 Asana | 503 → 200 | — / 7,159 | — / 2,140 | 0 / 10,271 | 1 retry after transient 503 (server overload, not quota) |
| B1 Retell AI | 200 | 47,111 | 2,302 | 49,772 | |
| B2 Bland AI tested | 200 | 45,916 | 2,232 | 49,460 | |
| B3 Bland phone calls | 503 → 200 | — / 10,060 | — / 1,902 | 0 / 13,024 | 1 retry after transient 503 |
| C1 Innovative Dental | 200 | 27,894 | 1,524 | 29,634 | |
| C2 My Dental Office Tour | 200 | 30,186 | 1,998 | 32,383 | |
| D1 9-minute animations | 200 | 53,100 | 2,386 | 56,139 | |
| D2 AWWWARDS scroll | 200 | 29,362 | 1,582 | 31,835 | |
| **Total (successful calls)** | **10 ok / 12 calls** | **276,482** | **19,757** | **304,505** | 2 transient HTTP 503 UNAVAILABLE errors, both auto-recovered on a single retry; no 429/RESOURCE_EXHAUSTED and no billing/permission errors — nothing required stopping the study. |

Source data: `research/video-study-raw/usage.jsonl` (copied verbatim from the tool's log). Raw per-video Gemini outputs: `research/video-study-raw/*.md`.
