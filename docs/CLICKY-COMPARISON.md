# Clicky and the Jarvis cursor

*25 Sep 2026. Owner: "there's one called Clicky which is really good at teaching and following
cursor and doing work, look into it so we can improve ours".*

## What was studied

| Repo | What it is | Licence |
|---|---|---|
| [farzaa/clicky](https://github.com/farzaa/clicky) | The original. A macOS menu-bar buddy: push-to-talk, AssemblyAI STT, one screenshot of every display, Claude Sonnet 4.6, ElevenLabs TTS, and a blue triangle that flies to `[POINT:x,y:label:screenN]`. | MIT, © 2026 Farza |
| [danpeg/clicky](https://github.com/danpeg/clicky) | A fork that adds a "tutor mode": after 3 s idle, it screenshots the front window and speaks. | MIT (Farza's notice kept) |
| [MatheeshaAI/clicky-windows](https://github.com/MatheeshaAI/clicky-windows) | A PyQt6 Windows port: UIA, then OCR, then vision to find things; drawing tags; a title blocklist that skips screenshots of private windows. | MIT, © 2026 Shashank Singh |

We copied no code. Everything below is our own implementation of ideas, which MIT permits anyway.
The findings come from reading the source; Clicky itself runs only on macOS, so its latency wasn't
measured here.

## Area by area

| Area | Clicky does better | We do better | Adopted (now built) |
|---|---|---|---|
| **Pointing accuracy and feel** | The buddy is always beside the cursor. The flight swoops: the arrow's tip follows the arc's tangent and swells about 1.3× mid-flight, then a bubble types out "right here!". | We ring the real UI Automation rectangle, so the target is exact. A vision point is snapped to the UIA control under it (as clicky-windows' hybrid pointer does). Per-monitor DPI v2 in physical pixels; the overlay is hidden from captures. | Companion mode: the Jarvis cursor rides beside his pointer with a springy lag (τ ≈ 70 ms) and flies home when done. The swoop: tangent rotation and a 16 % swell. A typewriter caption that reveals whole words. A "thinking" arc around the badge. |
| **Question to pointer** | One request does everything: Claude answers and points in one reply. | The pointer doesn't wait for a model. A named control is found by rules in the UIA tree, and the pointer leaves in about 0.4 s. Clicky parses `[POINT]` only after Claude's whole reply, then fetches the whole TTS MP3 before it plays. | The Jarvis cursor appears beside his pointer at once, thinking (for lessons too). Pointing is rules first, then the Groq planner (~0.6 s), then vision. The vision model is a **warm** Claude session (below). |
| **Conversational teaching** | Every turn carries a screenshot of every display and 10 turns of history. The persona is well tuned: it writes for the ear, keeps to one or two sentences and ends by setting up the next step. | Lessons: a plan from GPT-6 Astra, step detection (we notice when he's done it), a hand-off of one step, and take-over. Clicky-windows only has "next". | One-shot pointing answers in Clicky's register: one or two short, warm spoken sentences. "What does the X do?" points at once, then explains. "What's this?" means the control under his pointer. |
| **Proactive tips** | — (the fork speaks after 3 s idle following any action, with no silence convention and no cooldown: chatty). | An opt-in tutor that is quiet by default. It asks the model only on a sign he's stuck (rage clicks, an error window, going back and forth, a long pause after working), and the model's default is `{"silent":true}`. There are cooldowns and a cap, it never looks at private windows, and it never runs during a lesson or a run. It sends text only, no screenshots. | New: `scripts/screen-hands/tutor.ts`. |
| **Following his cursor and context** | Every display is sent, labelled, with the cursor's display marked "primary focus", so the model can point on another screen. | He can ask about any window, not just the one in front: we read the window under his pointer. The planner is told what his pointer is over. | The window under his pointer is used (`WindowAt`). "This" and "that" resolve to the control under his pointer. |
| **Doing work** | Nothing: none of the three repos clicks or types. Clicky-windows records a workflow but deliberately leaves replay unbuilt. | `screen_act` and take-over act through UIA patterns, so his pointer never moves, with a read-back after each step. | — (already ahead) |
| **Safety** | Clicky-windows won't screenshot a window whose title looks private. | The original has no injection guard and screenshots everything. We have `vetAction`, a spoken yes before any final button, on-screen text treated as data, frames kept in RAM only and an instant stop. | The title guard, extended: `NO_LOOK_TITLE` (banking, password managers, sign-in pages, `.env`) blocks point captures and tutor looks. Pointing never clicks. The spoken answer drops links, text aimed at Jarvis and anything that looks like a secret. |

## Vision model choice (measured)

The test was raw-coordinate grounding, Clicky style (no marks), on 1280-pixel captures of our own
Edge window. It was run on two pages of 10 targets each: a form, and a toolbar of 16 px icons plus two
unlabelled round buttons. A hit is a point inside the control's UIA rectangle (±6 px).

| Engine | Form page | Icon page | p50 latency |
|---|---|---|---|
| GPT-6 via Hermes (`askVision`) | 10/10 | 9/10 (one 22 s timeout) | 5.0 s / 6.2 s |
| Claude Sonnet 5, a cold `claude -p` for each call | 10/10 | — | 4.8 s |
| **Claude Sonnet 5, one warm `claude -p` session** | **10/10** | **10/10** | **1.95 s / 2.3 s** |

**Decision: pointing looks with a warm Claude Sonnet 5, and GPT-6 (then Gemini) is the fallback.**

- The code is `scripts/claude-vision.ts`. It runs the official, pinned CLI with the bridge's own
  flags: no tools, no MCP, no CLAUDE.md or memory, no session saved to disk, and the variables that
  would switch Claude Code to API billing removed.
- It answers one question at a time. The session is replaced every 8 turns and after any timeout or
  abort, and it ends after five idle minutes.
- It warms up when a point request arrives with his Allow.
- The first look after a cold start is about 5.5 s; after that, about 2 s.

## Live results (25 Sep, our own Edge app window, fresh profile; nothing clicked)

`bun scripts/screen-hands/point-bench.ts <page> --shots … --record …`: 10 questions.

- **Six by name** ("where's the export PDF button?").
- **Three the planner had to work out** ("where's the option to put another item on the invoice?",
  "where's the tax setting?", "what does the dark mode switch do?").
- **One visual** ("where's the round green button?").

| Measure | Result |
|---|---|
| Pointing accuracy | **10/10** (an earlier run: 9/9, and the 10th case was fixed) |
| Question → pointer leaves, p50 | **442 ms** (rules 331–482 ms; planner 344–906 ms; vision 5.5 s, a cold Claude) |
| Question → pointer arrives, p50 | **683 ms** |
| Tutor, 16 s while he used the PC | docked beside his pointer, **0 model calls, 0 tips**, overlay 0.65 % of one core, 30 MB |

- The screenshots are `Downloads\jarvis-cursor-v2-01…10.png` and the recording is
  `jarvis-cursor-v2-demo.mp4`.
- Captures are guarded: only the bench's own window is captured, and a frame is kept only when nine
  points across it all belong to that window.
- He was using the PC during the run, so the "what does *this* do?" case was asked by name. The
  bench moves his mouse only after a minute idle.
- These figures are the server side, from question text to pointer. The voice loop adds his STT
  (streaming on the client), and routing adds 0 ms because it's done by rules.

## Jev first for the pointer (25 Sep, owner: "use Jev for the pointer as well")

The order is now:

1. **Rules** for a control he names exactly (0 ms of model time).
2. **Jev** (`jev-latest`, one typed choice) over up to 20 named controls, pre-ranked by a
   trigram match. The pointer goes at once at confidence ≥ **0.6** (`JEV_POINT_MIN`).
3. **Claude Sonnet 5 vision** when Jev is unsure or says "none", with his Allow; GPT-6 is Claude's
   fallback. A colour- or picture-only description skips Jev.
4. **The Groq planner** words "what does it do?", and picks when there's no Allow.

Calibration: 20 phrasings on the invoice page (the 10 above plus 10 in his own words, such as
"where do I download this as a PDF" and "where's the night theme toggle").

| | Right | p50 |
|---|---|---|
| Jev alone | 18/20; it never named a wrong control (the other 2 were "none") | **238 ms** |
| Claude Sonnet 5 alone (warm) | 20/20 | 2,156 ms |

- **The first prompt said "none" too often** (15/20). Rewording it to "match by meaning" gave 18/20.
- **Confidence on a correct pick ranged from 0.50 to 0.98.**

Live, the whole chain, 20 phrasings: **20/20 hits; question → pointer leaves, p50 468 ms**.

| Route | Cases | Pointer leaves |
|---|---|---|
| Rules | 7 | 265–380 ms |
| Jev | 10 | 459–522 ms |
| Planner, after an explain point | 1 | — |
| Fell back to Claude vision | 2 (10 %): "round green button" and "what's been paid" | 2.7 s |

**The sub-300 ms target is met only by rules.** A Jev point is about 250 ms of UIA snapshot plus about
220 ms of Jev.

**Fixed along the way: captures could include his other windows.** Captures used to copy the
window's screen rectangle, so anything covering the window went to the vision model. It happened
once in the bench, and went to his own Claude session with nothing kept. The window now renders
itself (`PrintWindow`, full content). If it can't, the screen is copied only when nothing covers
the window.

## Not adopted yet

- **Every monitor in one capture**, with the model naming the screen (`:screen2`). Ours looks only at
  the window under his pointer.
- **Drawing tags** (arrows, circles), and an **OCR tier** between UIA and vision (clicky-windows).
- **Using warm Claude for `screen_act`'s vision fallback too.** It still uses GPT-6.
- **Warming Claude when he grants Allow**, rather than on the first point.

## Words and routes

- **Pointing:** "where's the X (button/menu/tab…)?", "point to X", "I can't find the X option",
  "what does the X switch do?" and "what's this / what does this button do?". These go to
  `screen_point` by rules; lesson phrases still win.
- **The tutor:** "watch me and help if I get stuck" or "tutor mode on" to start it; "stop watching",
  "tutor mode off" or just "stop" while it's on to end it. It goes to `screen_tutor`. The pill shows
  **Tutor on**, and its Stop and `/screen/stop` turn it off.
- **HTTP:**
  - `POST /screen/point {question, kind?, target?, vision?}`
  - `POST /screen/tutor {on}`
  - `GET /screen/tutor/events` (NDJSON tips)
