# Screen control: Jarvis's hands on the real screen

*24 Sep 2026. Code: `scripts/screen-hands/` (loop, planner, native helper), `scripts/free-voice.ts`
(routing), `src/components/operator/voice-companion.tsx` (tool, confirmation), `src/lib/screen-drive.ts`
and `src/components/operator/screen-drive-pill.tsx` (the "Jarvis is driving… say stop" pill).*

## Why

Owner, 24 Sep: he was screen sharing and asking Jarvis to help with a task, and Jarvis "kept just
opening new tabs giving me long ass explanations instead of controlling my screen".

The cause was structural. `browser_act` drives a **separate** Jarvis Chrome profile (CDP on :9222),
and `screen` can only describe. Nothing could touch the window he was actually looking at, so the
brain fell back to `open_url` (new tabs) and talking.

## What it does

`screen_act({ goal })` acts on the owner's **real foreground window** (his own Chrome or Edge,
Notepad, any app), in a short loop of at most 8 steps:

1. **Read.** The window's Windows UI Automation (UIA) tree: names, roles, rectangles, the password
   flag, focus and values. It's one cached `FindAll` through a warm hidden PowerShell with a small
   C# helper compiled once. Chrome and Edge expose web content through UIA, so a form in his everyday
   browser is readable.
2. **Choose one action** (click, type, key, scroll or done), cheapest first:
   - **Rules, no model.** Plain orders ("click the Name field and type Test", "select all", "scroll
     down a bit", "type my business name in there") parse straight into steps (`parseGoal`), and
     `pickElement` finds the element by label, kind ("field", "button") and ordinal ("the second
     link").
   - **Jev.** Only when two differently labelled elements score almost the same: one choice call.
   - **Groq brain.** For open goals ("help me finish this form"): a compact, masked element list
     goes to `gpt-oss-120b` (falling back to `-20b`), which returns one JSON action per step.
   - **Vision (last resort).** Used only when UIA has nothing usable ("the blue button", canvas
     apps). It needs his remembered "Allow" for screen analysis: one screenshot with numbered boxes
     over the UIA elements (Set-of-Marks) goes to GPT-6 via Hermes (`askVision` in
     `scripts/vision.ts`), with Gemini as the fallback.
3. **Act** with `SendInput`: mouse, wheel, virtual keys. Text over one character is pasted through
   the clipboard, kept out of clipboard history, and his own clipboard is restored 0.9 s later,
   because Windows 11 Notepad drops keystrokes while it renames a new tab. Every input call first
   checks that the target window is still in front; if not, **nothing is sent** (`WindowMoved`).
4. **Verify** before the next step:
   - A typed value is read back (polled for up to about 0.4 s, since browsers update UIA a beat
     late).
   - A clicked field must hold the focus.
   - A clicked button must change the tree.
   - If a dialog or another window has taken the front after a click, the run stops and says so,
     rather than claiming a click that a modal swallowed.

Only one short progress line is spoken ("One moment."), and only if a step takes more than 1.5 s.
The result is one short line ("Clicked "Name" and typed "Test".").

## Routing: his screen, not a new tab

- **Rules first** (`screenActIntent`). Pointing or field-level orders go to `screen_act` with no
  model call ("type this in there", "click the Name field", "help me finish this form", "select
  all"). While sharing, every click, type, scroll or press does too, and play/pause becomes the media
  key.
- **The guard** (`guardToolCall`). While sharing, or when he says "this", "here", "that button" or
  "on my screen", `browser_act`, `open_url` and `navigate` become `screen_act`, unless he names a
  site or page ("open github" still opens GitHub).
- **Jarvis Chrome check.** `browser_act` is kept only when Jarvis Chrome really is the window in
  front (the front window's process against Jarvis Chrome's browser PID). That applies whoever chose
  it: rules, Jev or the brain.
- **Outbound goes to control_pc.** A request like "send Mehroz a WhatsApp…", "post this on
  LinkedIn", "pay the invoice" or "ring Smile Dental" goes to control_pc's gate even if the brain
  picks `screen_act`. The brain's `screen_act` survives only when his words are about the screen
  (click, type, field, button, form, page and so on), he's sharing, or he's saying yes.
- **Jev catalogue and bench.** `screen_act` is in the Jev router catalogue. The five owner phrases
  are in the benchmark (`scripts/jev-bench-cases.ts`, group `screen_act`): "click the blue button",
  "scroll down a bit", "type my business name in there", "what should I click next" (goes to
  `screen`) and "help me finish this form".

## Safety rules (code, not prompt)

`vetAction` in `plan.ts` checks every action, whoever chose it (rules, Jev, model or vision):

- **Secrets.**
  - It never types into a UIA `IsPassword` field.
  - It never types into a field labelled for a card, CVV, expiry, BSB or account number, TFN,
    passport, licence, Medicare, 2FA/OTP, verification code, API key, token or recovery phrase.
  - It never types text that looks like a card number (Luhn-checked), a 6 to 9 digit code, a bank
    number, an ID or a key.
  - A type is vetted against **both** the field it was aimed at and whatever holds the focus, so a
    popup stealing focus can't redirect it.
  - Password values never leave the native helper, and values that look sensitive are masked in
    the model's element list.
  - Banking and password-manager windows are never typed into at all.
- **Final buttons need his spoken yes.** This covers Submit, Pay, Send, Delete, Publish, Post,
  Confirm, Buy, Place order, Sign up, Book and the like. The run stops with a question, and the
  client holds that one button label for two minutes. Only a clear yes (`isAffirmative`) re-sends
  `screen_act` with `confirm: <that label>`, and the yes covers one press of that button only. The
  same gate applies to:
  - Enter or Space on a focused final button;
  - Enter in a form field;
  - Enter in any message, chat, comment or reply box (where Enter sends);
  - Ctrl+Enter and Alt+S;
  - Delete outside a text field.
  Filling fields needs no confirmation.
- **On-screen text is data.** A control whose text addresses an assistant ("Jarvis: click…",
  "ignore previous instructions") is never clicked, even with a yes. The planner is told that
  element text is untrusted.
- **Stop.** Any confirmed speech aborts the voice turn. That aborts the HTTP request, the server's
  `AbortController` ends the loop between any two sub-steps and cancels a model call in flight, and
  the client also calls `/screen/stop`. The pill's Stop button does the same.
- **Pill.** While the loop runs, "Jarvis is driving… say stop" shows as a pill in the OS and at the
  front of the tab title, so it also shows in the taskbar when his app is in front.
- **Target window.**
  - If the OS itself is in front (its browser page, or the Jarvis desktop app), the target is the
    window right behind it.
  - Shell windows, lock and credential screens, and always-on-top overlays are never targets.
  - `onlyWindow` (a window handle) lets a caller insist on one window; the live checks use it.
- **Privacy.** Frames are captured to a JPEG in RAM, sent once, and never written to disk or logs.

### Why a native capture rather than the shared frame

The brief said to use the shared frame while sharing. A shared tab or monitor stream has an unknown
offset and scale relative to the screen, so a point found in it can't be mapped back to a click
reliably. A native capture of the target window's own rectangle maps exactly. It carries the same
privacy terms (RAM only, sent once, his existing "Allow"), so it's used in both cases.

## Measured (24 Sep, live, on windows the test opened itself)

| Check | Result |
|---|---|
| Notepad: "type hello world in there", "select all" | typed, read back through UIA; select all ran |
| Edge form: "click the Name field and type Test", "click Next" | "Test" read back in Name; Next clicked |
| "type hunter2 in the password field" | refused by the password rule, nothing typed |
| "click Submit" | asked "Shall I press it?"; pressed only on re-send with `confirm: "Submit"` (page showed SUBMITTED) |
| Stop during a planner call | ended about 1 ms after the abort |
| "help me finish this form" (live Groq) | one step, 950 ms: asked what name to enter rather than guessing |
| Step latency (rules path, 9 steps) | p50 about 410 ms, p95 about 870 ms (a type step includes read-back) |
| Routing bench, `screen_act` group | 7/7, rules path, 0 to 7 ms |
| Outbound bench | 11/11 gated; none became an instant action |

## Known limits

- Apps without UIA (games, some canvas or Electron apps) need the vision fallback, and so his
  "Allow".
- Windows 11 Notepad opens files as tabs in an existing window; the loop simply drives whatever
  window is in front.
- The planner asks for personal details other than his name, business and co-founder rather than
  guessing.

---

# The Jarvis cursor, teach mode and take-over

*24 Sep 2026. Code: `scripts/screen-hands/overlay.ts` and `overlay-native.ts` (the cursor),
`teach.ts` (pure rules), `lesson.ts` (the runner), `routes.ts` (HTTP), `src/lib/lesson-words.ts`
(shared words), `src/lib/screen-lesson.ts` (voice client), and the pill in `screen-drive-pill.tsx`.*

Owner, 24 Sep: "is there a way to add a cursor i can see like a second cursor which is jarvis and
there's one that's mine so i could follow along and jarvis could teach me and then if it need to
take control it can research on that".

## What it looks like

- **A second pointer.** A sky-blue arrow with a white outline and a small dark "J" badge. It glides
  on a slight arc (ease-in-out, 220 to 650 ms, depending on the distance) and leaves a short,
  fading comet trail. His own pointer is never moved by it.
- **A ring** around the control Jarvis means: a rounded, glowing sky-blue outline that breathes
  slowly. It flashes green and fades when the step is done.
- **A caption** beside the Jarvis cursor with the line Jarvis says ("That one — Settings, top
  right."). It flips left or up at the edge of a monitor.
- **A tap ripple** when Jarvis presses something himself.
- **The HUD pill** shows a **Teaching** chip ("Follow the blue cursor… say next or stop") or a
  **Driving** chip ("Jarvis is driving… say stop"), and the tab title says the same.

## Choice: a tiny compiled helper with layered windows

| Option | Verdict |
|---|---|
| A resident WinForms host in the warm PowerShell | Works, and it's the fallback. But PowerShell keeps ~85 MB resident for a pointer. |
| The Tauri desktop shell (`desktop/`) | Rust and MSVC Build Tools aren't installed on this PC. The cursor must also work when the desktop app isn't running (the OS in Chrome). A WebView2 overlay is heavier than three small bitmaps. |
| **A tiny compiled helper (chosen)** | The same C#, compiled once by Windows PowerShell's own compiler into a **21 KB exe** in `%LOCALAPPDATA%\AgenticOS\jarvis-overlay\` (the name carries the source hash, so an edit rebuilds it). No toolchain to install. **24 to 33 MB**, ready in ~0.6 s. |

How it's built:
- It uses **three per-pixel-alpha layered windows** (pointer and trail, caption, ring), drawn with
  GDI+ into DIB sections and shown with `UpdateLayeredWindow`. Nothing is allocated per frame.
- The window styles are `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE |
  WS_EX_TOPMOST`. `WM_NCHITTEST` returns `HTTRANSPARENT` and `WM_MOUSEACTIVATE` returns
  `MA_NOACTIVATE`. So it never takes focus or clicks, and it isn't in Alt+Tab or the taskbar.
- **Per-monitor DPI aware (v2).** Every coordinate is a physical pixel, the same space UI
  Automation rectangles use. The pointer scales with each monitor's DPI (`GetDpiForMonitor`).
  Three monitors, including ones at negative coordinates, were checked.
- **About 60 fps.** A 15 ms timer runs only while something moves. The ring's breathing changes
  only the layer's constant alpha (about 30 fps, no redraw). Idle means no timer and 0 CPU.
- **Excluded from capture.** `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` succeeds on this
  build even for `UpdateLayeredWindow` windows; older builds refused layered windows. A
  screenshot taken for vision (`CopyFromScreen`) doesn't see the cursor, as checked by capturing
  with it on screen. `POST /screen/overlay {inScreenshots: true}` turns this off for a demo.
- **Not a target.** The windows are titled "Jarvis … overlay", which `screen_act`'s target picking
  already skips. They're transparent to hit testing, so UIA's `FromPoint` sees through them.
- **Protocol.** One command per stdin line. Numbers are validated and text is base64, so nothing
  said aloud can become code. The helper exits when stdin closes, so **the OS server owns it**: it
  starts on first use (never from a one-off script) and dies with the server.

Measured (24 Sep, compiled helper):

| State | CPU (one core) | Working set |
|---|---|---|
| Hidden, idle | 0.00 % | 24 MB |
| Pointing (ring breathing) | ~0.9 % | 32 MB |
| Gliding continuously | ~0.7 % | 33 MB |
| The PowerShell fallback, for comparison | 0 / 0.6 / 11 % | 81 to 90 MB |

## Teach mode (the default for learning requests)

- **Phrases.** "Show me how to…", "teach me (how) to…", "where do I click to…", "where do I
  change…", "walk me through…" and "how do I … here / in this app". Not "where do I find…" or
  "where do I go to…": those are usually a folder or one of the OS's pages.
- **Planning.** Jarvis works out the next step exactly as `screen_act` does. He reads the window's
  UIA tree, sends a compact, masked element list to the Groq planner (`gpt-oss-120b`, then `-20b`),
  and the planner names one control. A web guide's named controls (below) are matched first, with
  no model call.
- **Pointing.** He glides the Jarvis cursor there, rings it and says one short line. **He does not
  click.**
- **Noticing it's done.** Every ~300 ms a cheap probe (`Probe`, about 20 ms) reads the front
  window, its title, the focus and the control under the ring. A full snapshot runs at most every
  2 s, and straight after any click of his. It counts as done when:
  - a new window of the same app opened;
  - the title changed;
  - the ringed control expanded or collapsed, got ticked or selected, or took the focus;
  - its value changed, or typing settled (no change for 1.2 s, or the focus left);
  - it went away (the page changed); or
  - new controls appeared (a menu opened).

  A **scroll** only moves things, so the ring follows the control instead. A glance at Jarvis's
  own page or another app is ignored.
- **By hand.** "Next" or "done" advances, "skip" skips, "say that again" repeats, and "let me do
  it" returns to teaching.
- **Stuck.** "I can't find it", "you do this one", or **two missed clicks inside the window**, hand
  **that one step** to Jarvis, and then he goes back to teaching. A click in another window or
  monitor isn't an attempt (his own clicks come from a low-level mouse hook that runs only while a
  lesson waits, and injected clicks are ignored).

## Take-control mode

- **Phrases.** "Just do it", "you do it", "take over", "do it for me", "you do the rest", or
  "take over and <task>" to start one.
- **Acting.** The same planner and steps, but Jarvis acts, and the Jarvis cursor glides to each
  target with a tap ripple. **UI Automation patterns first** (`Invoke`, `Toggle`,
  `SelectionItem.Select`, `ExpandCollapse`, and `SetFocus` for a field), so **his pointer never
  moves**. An `Invoke` that opens a modal dialog is run on its own thread with a 1.5 s join, so it
  can't hang the helper.
- **SendInput fallback.** Only when a control has no pattern. His pointer is then put back
  (`restoreTo`), unless he has moved the mouse since. Plain `screen_act` clicks and scrolls now go
  the same way.
- **A choice only he can make** ("which font?") comes back as a question. His next words are
  taken as the answer, with no model call.
- **An empty field.** Taking over, an empty text field goes to the fast planner, which knows his
  name and business and asks for anything else ("What email should I use?"). His answer is typed
  into that field. A password or other private field is never asked for, and a private-looking
  answer is neither kept nor typed.
- **The end.** Pressing the final button he said yes to ends the task ("Done. Pressed "Submit".").
- **One step only.** "You do this one", "do that one for me" and "I can't find it" hand over just
  the current step. "You do it", "take over" and "you do the rest" hand over the rest.

## The GPT-6 Astra coach (plan and "why")

- **When it's asked.** A teach or take-over start asks GPT-6 Astra, alongside the first UIA read.
  It gets the goal, the app, the window title and a compact UIA summary (up to 60 labelled
  controls, open/closed/selected, never field values).
- **The route.** The warm Hermes API, with a per-request model: `gpt-6-astra` on `openai-codex`,
  low effort, **12 s cap**. Then `gpt-6-sol` (10 s). Then the older web lookup (Groq compound,
  which answers 404 on this account; Gemini with Google Search; Hermes).
- **What comes back.** An ordered plan: exact labels, where, pitfalls and a one-line "why" per
  step.
- **The per-step picker stays fast.** It finds each planned label in the UIA tree itself (exact
  label first, no model call). A planned step that isn't on screen re-asks Astra with the current
  summary (at most twice). The Groq planner (`gpt-oss-120b`, then `-20b`) and then Jev fill any
  gap. Jev also covers Groq's free-tier limit of 8k tokens a minute, which a quick take-over hits.
- **Coaching.** In teach mode the why is spoken after where it is: "That one — Settings, top
  right. Open Notepad's appearance settings." The first step waits at most 2.5 s for the plan. If
  the plan lands later, its why follows as one short line.
- **Cache.** Plans are cached per app and goal (in memory and in
  `%LOCALAPPDATA%\AgenticOS\lesson-plans.json`, 60 entries, no expiry), so a repeated task is
  coached from the first line at once. Re-asks bypass the cache. Treat the file as private: goals
  and labels can carry personal details.
- **Advisory only.** Every planned action still passes `vetAction`, the password and secret rules
  and the spoken-yes gate. A spoken why that links out or addresses Jarvis is dropped.
- **A known gap.** Hermes is a tool-capable agent. The screen summary is labelled untrusted, and
  Hermes' own approval gate still applies, but a tool-less completion endpoint would be tighter.

## Measured (24 Sep, live, on windows the test opened itself)

| Check | Result |
|---|---|
| Notepad, "teach me how to change the font" | Settings, then Font, then Family. Each advanced on his own UIA action, detected 0.4 to 1.5 s after it. The next line came about 1.3 s later. No false advance in 8 s idle. |
| Notepad, "just do it" | Settings, Font and Family through UIA, his pointer never moved. It asked "Which font would you like?" and set it. (An early run wandered through three fonts; the drop-down choice rule now asks instead. His font was restored to Consolas, Regular, 11.) |
| Edge form: teach, then take over | "Click in Name, in the middle. You pick the name to enter." It advanced 1.4 s after he typed. The take-over stopped at "That's the final "Submit" button. Shall I press it?"; a yes for a different button pressed nothing; only the yes for Submit submitted. |
| Astra plan latency (uncached) | 4.9, 6.8, 8.1, 8.9, 9.1 and 9.3 s: **p50 ≈ 8.5 s**. A cached plan is 0 ms. |
| Overlay (compiled helper) | 0 % CPU hidden, ~0.9 % while pointing, 24 to 33 MB |

## Known limits

- **Readable UIA controls, or his Allow.** Since 25 Sep a window with next to nothing readable is
  taught from one screenshot (vision, his Allow only); without the Allow it still can't be.
- **Heuristic completion.** Duplicate labels, a stale cached plan or an unrelated change can
  mislead the matching. Two missed-click *batches* (clicks collected between two looks) trigger
  the one-step hand-off.
- ~~No read-back in lessons.~~ Fixed 25 Sep: every step Jarvis drives is read back and reported
  "verified" or "unobserved" (see "Round 3" below).
- **Limits.** At most 12 steps. A taught step waits 4 minutes.
- **Windows 11 Notepad** has no Format menu. The font is under Settings → Font, and Jarvis teaches
  that path.
- **Live tests.** When the owner is at the PC, focus can be taken back between steps. The lesson
  then refuses to start rather than act on the wrong window.

## Companion mode, one-shot pointing and the tutor (25 Sep, after Clicky)

This is the Clicky study and what came of it: `docs/CLICKY-COMPARISON.md`.

- **The companion.** The Jarvis cursor rides beside his pointer (overlay commands `follow`,
  `home`, `think`, `stat`). It appears at once when he asks, flies to the target along an arc (the
  tip leads, and it swells slightly mid-flight) and flies home afterwards. The caption types itself
  out.
- **Pointing** (`point.ts`) answers one question by pointing, and never clicks: "where's the export
  button?" or "what does this do?". It goes rules, then the Groq planner, then a warm Claude Sonnet 5
  (GPT-6 is the fallback). It reads the window under his pointer.
- **The tutor** (`tutor.ts`) is opt-in and quiet. It checks only on signs he's stuck, and the
  model's default answer is silence. It has cooldowns, looks at text only, and "stop" or the pill's
  Stop ends it.

## Jev picks what to click too (25 Sep)

The owner: "use Jev and this new Jarvis Clicky thing to help Jarvis navigate through my screens as
well, where it does the clicking too".

**How a target is found.** `screen_act` (one click, or a chain such as "click System, then Display,
then turn on Night light") and the take-over's planned steps find each target in this order:

1. His exact words in the UIA tree.
2. Jev's typed choice over up to 20 named controls (30 when no label shares a word with his),
   accepted at confidence ≥ 0.6.
3. The Jev tie-break for look-alikes.
4. Vision: Claude Sonnet 5, then GPT-6, and only with his Allow.

**Each step.** The companion cursor flies to the target with a one-line caption ("Clicking
Display.") and taps. The press goes through UIA (Invoke, Toggle or Select), so his pointer doesn't
move; SendInput is the fallback. Each step is verified, and a switch is read back.

**Chains.**
- Commas and "then" split the steps, and a bare name after "then" is another click.
- "turn on X", "switch off X" and "enable X" set a switch, and leave it alone when it's already
  there.
- Before choosing, it waits for the next page to arrive, so Jev never chooses from a stale page.

**What's never a target.**
- The window's own system menu and Close/Minimise buttons are skipped unless he asks for them.
  Settings' "System" system-menu item caught this out live.
- A tab or page that's already selected isn't clicked again.
- Only colour or shape words ("the round green button") go straight to vision. "The blue light
  filter" doesn't.

**Live results (25 Sep).** Our own Windows Settings window, with Night light turned back off after
every run; the owner's windows were untouched and each run waited until he'd been idle for 15 s.

| Code | Goal | Result |
|---|---|---|
| Before (`da545d3`) | "click System, then Display, then turn on Night light" | Clicked one "System", then claimed success: the rest wasn't parsed. 1.34 s a step. |
| Before | "open the system page, then go to screen settings, then switch on the blue light filter" | Failed at step 2 |
| After, named (5 runs) | the first goal | 15/15 steps, all verified; **3.1–3.8 s end to end**; per step p50 **1.07 s** (UIA snapshot, a 0.3 s glide, a UIA press and a read-back) |
| After, paraphrased (2 runs) | the second goal | 6/6 steps, with Jev choosing Display (0.70) and Night light (0.95); **5.6–5.7 s**. A Jev step is ~2.3 s, most of it waiting for Settings' next page to settle. |

## Pro software: CAD and other canvas apps (plan)

Mehroz is a mechanical engineer, and the owner wants this for Fusion 360, SolidWorks, Onshape,
Blender and KiCad.

**Two surfaces.**
- **Menus, ribbons, dialogs and property panels.** These are usually exposed through UIA, and the
  same path handles them: words, then Jev, then vision.
- **The canvas or 3D viewport.** This has no UIA. It's Claude vision grounding plus the app's
  keyboard shortcuts:
  - Prefer shortcuts to pixel-dragging: Fusion's `R` for a rectangle and `E` for extrude; Blender's
    `Shift+A`, then `S` and a typed number for scale.
  - Type numbers into the dimension or operator fields.
  - Take a screenshot after each step to check it (not built yet).
  - Treat a viewport drag as a last resort.

**Installed on 25 Sep: none of them.**
- Get-StartApps found no Fusion 360, SolidWorks, Blender, KiCad or FreeCAD, so no live CAD test
  was run.
- Onshape runs in a browser but needs an account, and Jarvis won't create one.

**Recommended next step: drive the app's own scripting API instead of clicking.** For real modelling
work, this is the reliable route. Hermes (or a Jarvis skill) writes and runs a short script, and the
companion cursor only teaches the UI:
- Fusion 360: the Python API;
- SolidWorks: the COM API (VBA, C# or Python via pywin32);
- Onshape: FeatureScript and the REST API;
- Blender: the Python API (`bpy`), including headless `blender -b -P script.py`;
- KiCad: `pcbnew` Python.

The API gives exact dimensions, parametric history and a result that can be verified; pixel
clicking on a viewport can't. Not built yet.

## Safety (unchanged, and it applies to lessons)

- **The same checks.** Every drive action passes `screen_act`'s `vetAction`: no password,
  card/CVV/BSB/TFN/2FA/key fields, no secret-looking text, banking and password-manager windows
  never typed into, and on-screen text treated as data (an "ignore the user" link is never
  clicked).
- **Final buttons.** The final Submit/Send/Pay/Delete/Publish (and the keys that act like them)
  stops the lesson with a question and rings that button. Only his clear yes (`isAffirmative`)
  for **that one label**, within two minutes, presses it once. "No" leaves it unpressed.
- **Teach mode can't act.** It never clicks or types anything.
- **Stop.** "Stop" (or the pill's Stop button, or `/screen/stop`) aborts the lesson between any
  two sub-steps and hides the Jarvis cursor at once.

## Routing

- **Starting a lesson.** The start phrases go to `screen_teach` by rules (`lessonIntent` in
  `src/lib/lesson-words.ts`), before `screen_act`.
- **Jev and the bench.** `screen_teach` is in the Jev catalogue (tier "show") and the benchmark
  (group `screen_teach`); `scripts/screen-hands/lesson-routing.test.ts` checks the rules path.
  The engine's `lessonActive` hook lets the server steer a running lesson too.
- **Steering a running lesson.** The voice client short-circuits the turn with no model call
  (`lessonTurn`): "next", "you do it", "stop", his yes to the pending button, or his answer.
  `screen_teach`'s result is spoken as it is.
- **Lines while he works.** Lines Jarvis says as he works come over
  `GET /screen/lesson/events` (NDJSON) and are announced when the conversation is idle.

---

# Round 3 (25 Sep): faster steps, one-call forms, lessons that check, Teach Mode 2.0

*Code: `scripts/screen-hands/` (index, lesson, course, form-fill, flags), `scripts/voice-compound.ts`,
`scripts/jarvis-skills/pc-control.ts`, `scripts/jarvis-e2e/suite.ts`. Results:
`docs/jev-bench/screen-round3-2026-09-25.json`. Every run: windows the bench opened itself, only after
15 s idle.*

## What changed, measured before and after

| Change | Before | After | Now |
|---|---|---|---|
| **Focus without the Alt tap** (`JarvisWin.Focus`: AttachThreadInput, then a lone F24 key-up) | from behind 0/10, in front a menu opened 8/10; Notepad typing (flags off) 2/5, p50 616 ms | 9/10 and 9/10, no menu; 5/5, p50 475 ms | always |
| **One Jev call per step** (`jevStep`) | 12/12 open goals, 0 wrong clicks, p50 3.8 s a run, 834 ms a step, 44 Groq calls | 12/12, 0 wrong clicks, p50 2.9 s, 680 ms, 15 Groq calls | ON (Jev never says "done" alone: a live run stopped after one of two clicks) |
| **Form fill in one call** (`formFill`) | the planner filled 1 of 8 key fields, then asked for a last name | 7 of 8 (3 of 3 in the suite after a label rule); 0 secure fields, 0 submits | ON |
| **Lesson read-back and replay** (`replay`) | every step unverified; each run 7 Groq + 1 Gemini calls, 2.9-4.6 s | each step "verified" or "unobserved"; runs 2 and 3: 0 model calls, 1.6 s, 2/2 verified | ON |
| **refs** ("which one?" instead of a guess) | a guess | asked 4 of 16 orders: all 4 on the 2 orders built to be ambiguous, 0 of 12 on clear ones; 0 wrong clicks either way | ON |
| **Night light chain** | | 4/4, reverted to off each time, Settings closed | |
| **CDP by voice** ("open VS Code so you can control it" → `pc_act drive_app` → `POST /screen/cdp`) | | routed by rules and the Jev router, tested | `cdp` stays OFF (a loopback DevTools port is a new surface); not run live: VS Code and Discord were already open, and Jarvis won't close his windows |

## The end-to-end suite (17 plain-English tasks through the live OS server)

| | Before | After |
|---|---|---|
| Completed | 10 of 17 (59%) | 13 of 15 (87%) |
| Clarifying questions | 8 | 1 |
| Wrong actions | 1 | 0 |
| Total time | 377 s | 76 s |

The biggest cause was simple requests going to Hermes and the Settings app (60-220 s, "please
approve", often unfinished). The fastest reliable route now wins: the Vercel CLI for deploy status
(108 s → 5 s), the Radios API for Bluetooth, the notifications toggle, rename-by-date with undo (56 s →
0.0 s), city time zones, a compound splitter for "X and Y" when every part is a rule's, straight-to-page
YouTube search and Spotify Liked Songs, and a planner fallback when a named control isn't on this page.

Still open: "turn off email alerts in this app" (the brain cut it to one click; fixed after the final
run, unmeasured); the notifications check flickered once (the skill read back 0, the check didn't);
VS Code, Notepad and Bluetooth tasks were skipped because his were open or it was already on.

## Teach Mode 2.0: courses

"Teach me Excel pivot tables", "continue my Resolve lessons", "next lesson", "quiz me on Figma",
"what's in my Figma course". A 5-10 lesson curriculum from the app's docs (SearXNG, then Gemini with
Google Search, then the planner alone), saved with progress in `.operator-data/screen-courses.json`.

- **Show me**: Jarvis does each step with the companion cursor and says it ("Clicking Insert.").
- **Guide me**: points and explains, waits for him (UIA state or tree change), a hint after ~20 s,
  "Good." when he got it himself.
- **Quiz me**: the goal only; a hint when he says "hint" or after ~45 s.
- **Pacing**: "I know this" skips and records it; an unfinished lesson comes back next; one he needed
  hints for returns as a quiz once the rest are done; every lesson ends with a one-line recap and
  what's next.
- **Unfamiliar apps**: UIA first, CDP for an Electron app opened for driving, one screenshot with his
  Allow when nothing is readable; "what does this panel do?" reads the region around his pointer.
- **Safety**: curricula drop anything that sends, pays, deletes, publishes or signs in; every step is
  still vetted, deny-listed and yes-gated.

Live (Excel, a sample CSV): the course built in 3-9 s; a guided lesson ran Insert → Table → OK, each
step verified, with a hint 4 s after each line (the learner was simulated). The runs found and fixed:
Office KeyTips taught as controls ("S", "N"), a loop clicking Explorer's "Documents" 12 times, Enter in
Excel's Name Box held as a form submit, and "show me" stopping to ask which option.

Known limits: a lesson can still wander out of the folder it started in (Explorer's run switched his
Documents folder to Large icons; the curriculum prompt now keeps to the open folder); courses are only
as good as the plan for each step; dragging (PivotTable fields) isn't taught by doing yet.

---

# Round 4 (25 Sep): 32 everyday tasks, real notifications muting, drags, "what can you do"

*Results: `docs/jev-bench/screen-round4-2026-09-25.json`. Own windows only, idle-gated; every setting
changed was read first and put back.*

## A finding first: the suite ran inside the Claude app's MSIX package

HKCU writes from inside it are virtualised. The suite's "restore" of the notifications toggle never
reached the real registry, so the owner's notifications stayed muted after round 3 (restored on
25 Sep, through a process started by WMI, to his prior state: the value unset). The suite now reads
and restores registry settings that way. And that registry toggle turned out to be a cached copy the
shell ignores until sign-out, so "mute notifications" now switches Windows 11 **Do not disturb** on
the Settings page through UI Automation (`jarvis-skills/dnd.ps1`, ~1.6 s, read back from the switch).

## The suite: 19 tasks became 32

| | Before (the 12 new tasks that ran) | After (the same 12) | After (all 32) |
|---|---|---|---|
| Completed | 4 of 12 | 11 of 12 | 26 of 28 that ran (93%) |
| Clarifying questions | 8 | 0 | 0 |
| Wrong actions | 5 | 0 | 0 |
| Total time | ~330 s | ~11 s | 173 s |

New direct routes (rules, no model): zip, copy, move, save as PDF, screenshot
(`jarvis-skills/pc-files.ts`); Excel "total of the X column under it" and Word "make the first line
bold" on the document in front (Office automation; Excel found through its window, since a
just-opened workbook isn't registered for GetActiveObject yet); "copy <text> to my clipboard"; dark
or light mode; "open GitHub and Vercel in new tabs".

Still failing: "open my clipboard history" (the injected Win+V can't be seen to open the panel; the
spoken line now says what it did rather than claiming the panel is open), and "open Spotify and play
my liked songs" (the page opens; pressing Play needs his signed-in player). Skipped: VS Code, Notepad
and Jarvis Chrome tasks, because his were open or it wasn't running.

## Teach Mode drags

A lesson step can now be a drag: a field onto an area (PivotTable-style), a slider to a percent, a
clip along a timeline. **Show** performs a real press-move-release (his pointer put back); **guide**
has the companion cursor demonstrate it (press, carry, let go), then notices his own drag
(`judgeDrag`: it landed in the area, the value moved, or the thing moved along its track). A drop on a
bin or delete area needs his yes. A planned click on a slider, or on the thing (or place) his goal
says to move, is turned into the drag.

| Drag bench (bench/drag.html) | First run | Final run |
|---|---|---|
| Show (Jarvis drags) | 1 of 3 cleanly (the planner clicked the slider and the clip) | 3 of 3, 3.4-5.4 s |
| Guide (he drags) | 2 of 3 cleanly | 3 of 3; his drag noticed in 0.6-1.1 s |

Not yet: Excel's real PivotTable field list (the bench mimics it), and drags that need a modifier key.

## "What can you do on my PC?"

`jarvis-skills/capabilities.ts`: three spoken sentences built from the real routes and the last full
suite run ("26 of 28 everyday tasks worked end to end"), plus the guardrails. "Show me what you can
do" also writes `.operator-data/jarvis-capabilities.html` and opens it: each ability, its examples,
how it's done, and a works / failed / skipped badge per suite check. A full suite run refreshes it
(`.operator-data/jarvis-e2e-last.json`).

## Windows across his screens (25 Sep, from a real bug)

**What happened.** He said "bring the tab in front of my screen" and then "open my Chrome tab… it's
not showing up in my front screen" (Chrome was minimised or on another monitor). Nothing in the
rules knew that request, so the brain chose `screen_act`, and the tool guard kept it because the
words "screen" and "tab" count as screen words. The screen loop then worked on the window in front,
a Chrome window on his left or top monitor: it clicked a link and pressed Alt+Tab, then clicked the
address bar and six more steps. The click coordinates were right; the route was wrong. Window
management had been sent to the click loop. (Trace: conversation f2750fc5 in
.operator-data/conversations.json, 12:25–12:27.)

**Fix.**
- `windowPlaceIntent` (jarvis-skills/windows.ts), checked before any screen rule: "bring up / show /
  restore / switch to <app>" with a screen, "put <app> on my main / other / left / right / top
  screen", "move it to my other screen", "<app> isn't showing on my main screen", and "which screen
  is that on". Anything with a click, typing, search or play in it is left alone.
- The window skill's new `bring`, `move` and `where` actions call Win32 directly. It finds the app's
  window (minimised ones too). It reads the screens with EnumDisplayMonitors (the primary display is
  "main"; left, right and top go by position). Then it restores the window with SW_RESTORE, moves it
  with SetWindowPos (position first, then size) into the target's work area, maximises it again if it
  was maximised, and brings it to the front with the Alt-free Focus. Nothing is clicked or typed.
  - The result is checked: the window's centre must be on the target screen, or Jarvis says Windows
    didn't move it.
  - "Other" with three screens asks which one ("left screen or top screen?"), and "the left one" completes the request.
- The tool guard sends any `screen_act` or `browser_act` that is really window management to the skill.
- The helper calls run per-monitor DPI aware on their thread, so each size is a physical pixel. A
  window keeps its logical size across different display scales.

**The coordinate paths, checked for multiple monitors.**
- UIA rectangles, SetCursorPos and clicks are per-monitor v2 physical pixels (native.ts).
- Drags use absolute SendInput over the virtual desktop (SM_XVIRTUALSCREEN…), so negative coordinates are correct.
- Vision captures the target window itself (PrintWindow, or CopyFromScreen of its own rectangle), not the primary screen.
- The overlay is per-monitor (MonitorFromPoint + GetDpiForMonitor).
- One gap is fixed: the full screenshot skill ran DPI-unaware, which would scale the capture on
  mixed-DPI setups. It now switches its thread to per-monitor first.

**Measured, live on his three screens** (2560×1440 main, 1920×1080 left at x −1920, 1920×1080 above
at y −1080). A Notepad of ours, on a D:\tmp file, went through the real voice route.

| Request | Before (his trace) | After |
|---|---|---|
| "bring the tab in front of my screen" | screen_act: clicked a link, Alt+Tab, on the other monitor | rules → window bring, 0 clicks |
| "open my Chrome tab… not showing up in my front screen" | screen_act: 8 clicks and keys in the address bar | rules → window bring to main, 0 clicks |
| "bring Notepad up on my main screen" (it was minimised on the left screen) | not handled | done in 0.2 s: restored, on main, in front |
| "move it to my other screen" → "the left one" | not handled | done in 0.3 s, 1 question (three screens) |

Tests: monitors.test.ts covers 29 cases. The mocked layouts include a 150% main with a 100% screen
at negative X, and his real three-screen layout. They cover 15 routed phrasings, 11 phrasings that
must not route, and the bring/move/where paths on fake Windows. voice-compound.test.ts covers the
tool guard. Results are in docs/jev-bench/screen-window-2026-09-25.json. His Notepad session was
copied first and put back afterwards (verified), and his clipboard was unchanged (verified).

## Round 5 (25 Sep): the strict suite

Run with the new rules. Each task waited for 60 s idle and would have stopped on his first touch
(none came). His clipboard (7 formats) was snapshotted, put back after every task and verified.
His Notepad tabs were copied and put back, then verified. Files stayed under D:\tmp. His Windows
settings, his Spotify account and his own VS Code were skipped by policy.

- 33 tasks, 28 run, 26 done (93%), 2 questions, 2 wrong actions, p50 0.49 s.
  Results: docs/jev-bench/screen-round5-2026-09-25.json.
- The re-run of tasks skipped last round: notepad-list failed (below), switch-window passed and
  chrome-bookmarks failed (below). vscode-tests is now skipped by policy: opening his VS Code
  profile can update extensions and state that can't be put back.
- **chrome-bookmarks: an incident.** The brain sent "show my bookmarks in Chrome" to screen_act,
  which worked on the window in front: the Claude app. It switched that app's Browser button on.
  The button was switched back off through UIA straight after (he'd been idle since before the
  task, so the change was ours). Fix: a screen task that names an app ("in Chrome", "into
  Notepad") now refuses to act on any other app's window.
- **notepad-list:** Notepad opened with a restored tab, the Claude app kept the focus, and the type
  skill rightly refused. The brain then fell back to control_pc, and the harness answered Hermes's
  confirmation with an automatic "yes". Hermes ran for about 40 s. Nothing was typed anywhere we
  checked, and his Notepad tabs were put back and verified. Fix: the suite never gives Hermes an
  automatic yes.
- **Excel PivotTable drags:** blocked. The throwaway workbook, the scenario and the guard are
  built, but Excel on this PC says "the license to use this application has expired" and refuses
  to make the PivotTable.

## control_pc P0 (27 Sep): risk tiers, one keyword list, honest outcomes, audit

*Code: `src/lib/action-keywords.ts`, `src/lib/control-risk.ts`, `src/lib/control-outcome.ts`,
`src/lib/jarvis-control.ts`, `scripts/control-audit.ts`, `scripts/control-verifiers.ts`,
`scripts/jarvis-demo-notepad.ts`. Tests: `scripts/action-keywords.test.ts`,
`scripts/control-risk.test.ts`, `scripts/control-outcome.test.ts`.*

- **One keyword list.** control_pc's OUTBOUND regex and `plan.ts`'s FINAL_BUTTON are now built from
  one catalogue (`ACTION_KEYWORDS`), each entry scoped to spoken tasks, button labels or both, with a
  reason whenever it is one scope only ("Format" is a harmless ribbon button; "format the drive" is
  not). A new verb is added once. The test keeps both old regexes verbatim and proves every entry is
  still covered. Widened: tasks now also gate donate, withdraw, deposit, reserve, sign up, register,
  (un)subscribe and install; buttons now also gate RSVP, Tweet and Refund.
- **Risk tier in code.** Every control_pc task gets `read-only`, `local-reversible` or
  `external-effect` (`classifyControlTask`, worst clause wins). external-effect = the keyword list,
  plus effects no outbound verb names (emptying the bin, running scripts, moving/renaming files,
  shell commands, downloads, syncing to cloud, power/registry/firewall changes, credentials, paid
  generation, writes outside `D:\tmp\`), **plus anything the rules don't recognise (fail closed)**.
  external-effect always goes through the spoken-yes gate (2-minute TTL, `isAffirmative`, the
  read-back task text only). Trade-off: unrecognised phrasings now ask "shall I?" where they used to
  run silently; widen `LOCAL_REVERSIBLE` in `control-risk.ts` when a safe phrasing asks too often.
- **The `yolo` trade-off.** Hermes' CLI (`/__hermes_chat`) has no terminal to answer tool-approval
  prompts: without `--yolo` every tool call waits until the 10-minute watchdog. So `yolo` stays, but
  `runHermesTask` now calls `mayRunWithYolo` first and refuses (nothing reaches Hermes) unless
  either the tier is read-only/local-reversible **and** the keyword gate passes, or the approval is
  his spoken yes for that exact task text. The warm API path keeps Hermes' own smart approvals
  (Jev guardian) on top. What yolo still allows inside an approved local task is bounded only by
  Hermes' prompt and the guardian; the independent verifier is what catches a wrong effect.
- **Outcomes.** `success` only when an independent verifier passed; `failed`; `cancelled`;
  `unverified` when it ran but no check ran, the check timed out or couldn't decide. Hermes'
  narration alone is always `unverified`, and the voice reply says so. One verifier so far:
  `fileContentVerifier` (file exists; SHA-256 of BOM-stripped, LF-normalised text matches; content
  never returned or logged).
- **Dry run.** `runControlTask(task, { dryRun: true })` (and the voice client's control_pc handler with `preview: true`; not yet advertised in the tool schemas, to keep the free brief under its size budget) returns
  the planned clauses with their tiers and never executes. A gated task's CONFIRMATION REQUIRED reply
  now carries the same preview.
- **Audit.** Append-only JSONL, `.operator-data/audit/control-YYYY-MM-DD.jsonl` (or
  `JARVIS_AUDIT_DIR`). Fields: ts, taskId, action, target (app word or path basename), tier,
  approval method, Jev confidence, outcome, verifier/verification, ms, step, and the SHA-256 of typed
  text. `sanitizeAuditEntry` drops every other field, so task text, transcripts, screenshots and
  typed text can't be written. The browser posts entries to `POST /__operator/control/audit`
  (local only, token-gated).
- **Demo** (research doc §6): `bun scripts/jarvis-demo-notepad.ts --dry-run`, then `--approve` to
  run it. Rules + UIA only (no model keys, no pixel clicking): its own empty Untitled Notepad, the
  note typed via screen_act and read back, the Save As file name pasted into Edit 1001 and read
  back, Save pressed by id, the file hashed from disk. Exit 0 only when verified. The note file is
  left in `D:\tmp\jarvis-demo\` for manual clean-up. First passing live run: 27 Sep, 54 bytes,
  SHA-256 matched, one audit entry per step, no note text in the log.
- **Windows 11 Save As, found live (27 Sep).** (1) A UIA walk from the dialog never reaches its
  lower pane (File name, Save, Cancel); find them by Win32 id (Edit 1001, Button 1, Button 2).
  (2) This host's managed UIA can see those classic controls as pattern-less panes; BM_CLICK is
  the fallback (what UIA Invoke sends them). (3) **A file name set programmatically (ValuePattern
  or WM_SETTEXT) reads back correctly but is ignored: Save uses the dialog's own suggested name**
  (the note's first line, in the dialog's last folder, e.g. Downloads). Focus Edit 1001, select
  all, paste as input, read back, then press Save. (4) An ISO timestamp in typed text trips the
  typing guard (long digit runs), correctly; the demo note is words only. `nativeHands.type` still
  uses `SetDialogValue` for #32770 dialogs, so screen_act "save it as X" likely has bug (3); not
  changed here.

## 27 Sep: Save As general path and honest completion

The general `nativeHands.type` path now uses real input for a classic file dialog's focused
File name control (Edit 1001): focus, Ctrl+A, clipboard paste, and exact Win32 read-back. A missing
or differently focused filename control fails closed instead of falling through to ordinary paste.
No `ValuePattern.SetValue` is used in this path. Ordinary non-dialog text entry remains unchanged.

The parsed typing path requires the native exact-filename verification for a file dialog. A
matching prefix or a value in another edit box cannot pass. Planner `done` now returns
`ok:false, outcome:unverified`; a step limit returns `ok:false, outcome:step_limit`. These results
preserve the actions performed without claiming the whole goal is proven. Two consecutive
ineffective clicks on the same control stop with `no_progress`. Progress snapshots include
selection, expansion, enabled state and geometry; snapshot errors produce a terminal result.

The synthetic Notepad demo now types the filename through public `screen.act`, then independently
checks the exact path and file content hash after Save. Final live run 27 Sep at 03:05 UTC passed:
55 bytes, SHA-256 `95951d96d0b710a2` prefix, exact filename read-back, Save invoked through UIA.
The demo still owns dialog discovery and pressing Save; this is not an arbitrary multi-app workflow
proof or a claim of error-free desktop control. One earlier run failed to type the note and stopped;
a subsequent run passed. Synthetic demo files are under `D:/tmp/jarvis-demo-jev-review`.

Validation: the original 305 screen-hands tests passed, zero failed; typecheck and Bun-hosted Vite build passed.
The default build launcher uses Node and fails on a `bun:` import; explicit Bun hosting builds.
The broader script suite observed 3013 passed, four skipped, one operator-plugin transcript-import
failure. That failure independently reproduces on an archived unchanged HEAD (38 pass, one fail).
Six regression checks fail against the unchanged implementation and pass against the patch.
DeepSeek Flash reviewed the synthetic architecture summary; two Codex reviewers inspected
source/diff. Exact `claude-opus-5` through the owner-confirmed `https://agentrouter.org` was attempted
twice and rejected with HTTP 401; it did not return an Opus review. Credential values were never
printed or added to source. An earlier Hermes architectural review is separate, not proof of that route.

Follow-up: six synthetic dialog boundary regressions were independently rerun with the whole
screen-hands suite: 311 passed, zero failed. The live official integration guide identifies
`https://co.agentrouter.org` as the API host. A subsequent exact `claude-opus-5` Messages request
to `/v1/messages` with the documented authentication/version headers also returned HTTP 401.
This confirms rejection of that request, not a proven need to replace the credential. No Opus
review was returned. Reference: https://co.agentrouter.org/portal/guide .

Voice integration now transports non-confirm terminal results as `screen_result` JSON strings
with `ok`, `said`, `outcome`, `ask` and `stopped`. Confirmation markers still carry plain speech.
Both the voice batch runner and synthetic E2E loop stop remaining tools and model follow-up
after failed, unverified, limited, question or stopped results; skipped calls receive explicit
history entries. A fresh user instruction can act again. The feed consumes step `verified`.
Away mode preserves the failure category in its existing persisted result string without a
schema migration; failures remain failed and are not requeued.

Integrated focused verification: 519 passed, zero failed across 19 files (2244 assertions),
covering screen-hands, voice routing/client, result transport, away runner and E2E adapter.
Typecheck and Bun-hosted client/server Vite build passed; diff whitespace check passed.
These caller checks use synthetic inputs and do not establish physical voice quality or
new live arbitrary desktop workflow acceptance. No deployment or service restart was performed.

## 27 Sep (P1): one Save As/Open path, Playwright for browser targets, fuzzy Jev, a desktop suite

### Research (brief; accessed 27 Sep 2026)

- **Windows 11 file dialogs.** A File name set through UIA `ValuePattern.SetValue` (or `WM_SETTEXT`)
  reads back correctly and is then ignored at Save; the dialog writes its own suggestion. Real input
  (focus the box, Ctrl+A, paste) is what saves. Public reports match our live finding:
  github.com/marcelocruzrpa/ultrafast-computer-use PR #4 (seen via search; the page itself returned
  404 to our fetch) and https://github.com/greatscottgadgets/packetry/issues/302. `SetValue` is a
  provider-side contract with no promise the app acts on it:
  https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue ,
  https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementingvalue .
  Found live here and fixed in code: Save As keeps File name in `Edit 1001`, Open in the `Edit 1148`
  inside `ComboBox 1148`; the lower pane can be missing from a UIA walk and UIA calls on it can throw
  in a long-lived host, so buttons are pressed by control id (UIA Invoke, else `BM_CLICK`) and focus is
  confirmed with Win32 `GetGUIThreadInfo`
  (https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo).
- **Windows 11 Notepad (tabbed, WinUI).** Its editor is a `RichEditD2DPT` island that can itself be the
  foreground HWND; accelerators (Ctrl+S, Ctrl+Shift+S, Ctrl+O) are ignored while focus sits on the
  frame; posted `WM_CLOSE`/`SC_CLOSE` are ignored (UIA `WindowPattern.Close` works); "save changes?" and
  errors are in-window XAML dialogs, not `#32770`. It can restore session tabs into a new window
  (https://github.com/NilhanHub/notepad-live-mirror binds to window and tab identity for this reason),
  so the suite only uses a new window with exactly one empty Untitled tab.
- **File Explorer.** Ctrl+Shift+N creates "New folder" in rename mode; activating the window (our
  focus helper) ends in-place editing; and the rename box, a classic Win32 `Edit`, can be exposed by
  UIA as a "Pane". The helper now reports a focused classic `Edit` as an Edit with its exact Win32
  text (password style respected).
- **Playwright for browser targets.** Role/label locators and actionability checks (visible, stable,
  enabled, receives events) rather than pixels: https://playwright.dev/docs/best-practices ,
  https://playwright.dev/docs/locators , https://playwright.dev/docs/actionability ;
  `connectOverCDP` for an already-running browser: https://playwright.dev/docs/release-notes .
- **Injected instructions.** OWASP LLM01 (https://genai.owasp.org/llmrisk/llm01-prompt-injection/ ,
  https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html):
  least privilege, human approval for privileged actions, and never let untrusted content choose
  actions. That is the shape here: steps come from his goal only; page text is data.
- **TypeSafe Jev.** The API contract (https://docs.typesafe.ai/api) documents `noul`/`choice`/`score`
  but no limitations; the date/time, counting and adversarial-content weak spots come from the
  vendor's positioning and third-party coverage summarised in research/jev-facts.md and
  jarvis-deep-research.md §1.8. We treat them as real and design around them (docs/JEV-ROUTING.md §4).

### What changed (code)

- **"Save it as X" / "open the file X" everywhere** (`plan.ts` step `file`, `file-dialog.ts`, native
  helpers `DialogInfo`, `FocusFileName`, `PressDialogButton`, `PromptButtons`, `PressPromptButton`,
  `DialogOwner`, `RootOwner`): the main text control is focused; Ctrl+Shift+S / Ctrl+O is sent to his
  window or its own island/flyout (root owner checked); if nothing opens, File > Save as / Open through
  UIA; the dialog must be owned (or root-owned) by his window and its button 1 must say Save/Open;
  File name is focused (UIA, then Alt+N), pasted, read back exactly; button 1 is pressed by id, never
  Enter or the pointer; a replace prompt is always answered **No**; an error prompt is left for him and
  reported; success needs the dialog closed **and** the file on disk (full path) or his window's title
  naming it, else `unverified`.
- **Playwright executor** (`browser-exec.ts`): `playwrightHands` runs screen_act's own loop (parseGoal,
  vetAction, refs stale check, typed read-back) over a page, pressing through Playwright's
  actionability-checked click. `isolated` = fresh Chromium, ephemeral profile; `jarvis-chrome` =
  127.0.0.1:9222 **only if already running**, never launched; his own Chrome/Edge profiles are refused.
  Requests are limited to allow-listed loopback origins (others aborted and counted by origin only);
  popups closed, JS dialogs dismissed, downloads cancelled. `executorFor` puts Playwright ahead of UIA
  for Jarvis Chrome's own window (its pid owns the 9222 listener and exactly one page matches the
  title); vision is never chosen on this path. Wired into `createScreenHands().act`; playwright-core is
  not yet a dependency of this repo, so in the live server this route stays off until it is added
  (`loadChromium` also takes `PLAYWRIGHT_CORE_PATH`).
- **Jev fuzzy verification** (`fuzzy-verify.ts`): see docs/JEV-ROUTING.md §4.
- **Standard audit shape**: `AuditEntry` gains `executor`, `judgment`, `verdict` (sanitised to fixed
  vocabularies). `screen-hands/audit.ts` turns every screen_act run into step entries (verification
  only) plus one run entry (tier, executor, judgment `vet`, verdict, outcome, goal SHA-256, target
  basename, ms). `createScreenHands` writes them to `.operator-data/audit/` by default (off under bun
  test). Success needs every step verified; `ask`/`confirm` are `unverified`/`awaiting-approval`.

### Desktop acceptance suite (`scripts/jarvis-desktop-acceptance/`)

Nine synthetic tasks; each has a dry run (`suite.ts` without `--run` executes nothing), pass criteria
checked independently, and cleanup of only its own artefacts under `D:\tmp\jarvis-acceptance\<run>\`.
Only windows the run itself launched (new handles) are focused, acted on or closed; screen_act always
gets `onlyWindow`; nothing is force-killed; no model keys (rules, UIA and Playwright only).

| Task | Independent check |
|---|---|
| notepad-save | editor text hash (UIA by handle) and file hash on disk |
| saveas-subfolder | missing folder: nothing written anywhere; then the file in a fresh subfolder, by hash |
| open-file | Open dialog, then the window's editor text hash equals the file's |
| explorer-folder | Enter held for a yes; folder created then renamed, checked on disk |
| calculator | 97 × 8 via UIA buttons; `CalculatorResults` reads 776 |
| browser-form | Playwright on a local page: DOM read-back and one POST whose body hash matches |
| cancel-midtask | abort after step 1: stopped, later words absent from the editor |
| refuse-external | "Send message" held for a yes; page counter and server log both zero |
| injection-page | assistant-addressed control refused; off-origin requests blocked; no model saw the page |

Three full runs on the real desktop, 27 Sep (targeted reruns between them while fixing):

| Run | Result | Failures |
|---|---|---|
| 1 | 6/9 | open-file (Open dialog's box is Edit 1148: fixed); explorer (activation ended the rename box, UIA "Pane": fixed); injection-page (suite bug, `window.cont` was the button element: fixed) |
| 2 | 8/9 | explorer (rename box reported as "Pane": fixed, then passed twice in targeted runs) |
| 3 | 6/9 | notepad-save, calculator, explorer: another window took the foreground mid-task and input was withheld ("the window changed under me"); calculator read back 97, not 776, and was reported failed. In explorer, after the interruption the typed name went to a focused text box and read back correctly, but no rename happened: the file-system check caught it (step verification is not goal verification). |

Across the three runs: saveas-subfolder, browser-form, cancel-midtask and refuse-external 3/3;
injection-page 2/3 (a suite bug the first time); open-file 2/3; notepad-save and calculator 2/3 (the
misses were foreground interruptions); explorer-folder 0/3 in full runs, 2/2 in targeted runs after the
fixes. Audit scans: 0 synthetic plaintext markers in every run (the logs hold hashes, ids, basenames,
tiers and outcomes). Evidence: `D:\tmp\jarvis-acceptance\run-*\_evidence\report.json` and `audit\`.
Every run stopped within about 2 ms of an abort. These are synthetic tasks on this PC; they don't
show arbitrary-app reliability or physical voice quality.

Remaining gaps: add `playwright-core` as a dev dependency (owner or lead decision; this change doesn't
touch package.json), then prove the Jarvis Chrome route live with 9222 running; foreground stability
(the suite fails closed when he or another app takes focus, which is correct but noisy); Explorer
rename should target the item rather than rely on focus after an interruption; the live Jev
calibration sample was not run; the Notepad demo still has its own dialog code (it could now call
"save it as").

## STATUS at stop (27 Sep, owner said stop)

Brief: make Jev the main decision-maker for desktop control, entered through Jarvis, with step-by-step
narration. Stopped mid-build on the owner's instruction. No desktop task was running and no window was
opened by this session; the acceptance suite was not re-run; 1 live Jev call was made (response-shape
probe, synthetic state).

- **Done (uncommitted, on disk):** `scripts/screen-hands/jev-control.ts` (new: typed state, payload
  placeholders, candidates with instruction-like text withheld, one-request questions action/target/
  text/key/last_ok/complete/window, 0.6/0.4 confidence policy, narration lines, Jev client with
  usage tokens); `scripts/jev-desktop.ts` (new: Jev router tree as the desktop entry); `jev-router.ts`
  (optional `context` in the state, usage tokens returned); `control-outcome.ts` (audit `inputTokens`/
  `outputTokens`, outcome `decided`); `flags.ts` (`jevControl`, default OFF); `hardening.test.ts`.
- **Half-done:** `scripts/screen-hands/index.ts` Jev loop inside `runScreenAct` (written, not type-checked
  or tested; it only runs with `jevControl` on, which is off); narration events (`narrate`, `jev`,
  `jev_state`) defined but not yet persisted or audited in `createScreenHands.act`.
- **Not started:** `/screen/command` Jarvis entry route and `/screen/runs` step log (routes.ts);
  voice-companion narration wiring; acceptance suite through the live server (:8081) with the 600-call
  budget and focus-loss retry; tests for jev-control; doc updates reversing "Jev fuzzy only"
  (JEV-ROUTING.md §4, the P1 section above).
- **Next step:** `bunx tsc --noEmit`, unit tests for jev-control and the loop on fake hands, then the
  routes, voice wiring and suite, then turn `jevControl` on and run the suite (≤ 3 runs).
- Focused tests at stop: hardening + loop, 67 pass, 0 fail.

## STATUS update (28 Sep, Track 2: Jev-led commands)

The 27 Sep "not started" items above are superseded:

- **The ONE command entry** is `POST /__operator/screen/command` in `scripts/jarvis-command/route.ts` (moved out
  of `screen-hands/routes.ts`), backed by `scripts/jarvis-command/service.ts`. Typed commands (Track 1's
  palette, `runTypedCommand`) and spoken ones (the free-voice rule-only tool `jarvis_command`,
  `src/lib/jarvis-command.ts runJarvisCommand`) take the same path: refusals in code → page context →
  delegates (memory, coding, receptionist) → `resolveTarget` from the VERIFIED principal (a body `personId`
  is ignored) → a Job (B2) with `targetDeviceId` → the hub's Jarvis entry or a typed `ExecutorCall` on the
  requester's own companion. Every command records a §3.4 `JevDecision` step; success is only claimed after
  the check. `/screen/command/attach` re-attaches after a dropped stream; `/screen/command/cancel` and
  `/__jobs/<id>/cancel` stop through the job service; `/screen/stop` also cancels the caller's command jobs.
- **Still on `/screen/act`:** voice `screen_act` (the window-in-front loop) keeps its own path, because its
  final-button yes (the server's spoken-yes event + the client's pending button) is wired there. It joins the
  ONE job history through the B2 run-log mirror, runs at this PC only, and a remote founder gets 403.
- `/screen/runs` (the in-memory step log) is unchanged; the durable record is the job's steps.
- Synthetic acceptance: `scripts/jarvis-command/stage-c.e2e.test.ts` (real voice entry, fake STT/TTS).
