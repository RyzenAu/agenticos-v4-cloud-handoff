# Jarvis reliability & safety architecture — deep research and design

*Compiled 27 Sep 2026, Australian English. Read-only research; no code, config, or running service
was changed to produce this document. All local claims are cited by file path (repo:
`C:\Users\Nebula PC\source\repos\AgenticOS-v4`, branch `jarvis-voice`, unless noted). All external
claims carry URL + access date (27 Sep 2026 unless stated).*

---

## 1. Current-state map (what owns what, measured, with evidence)

### 1.1 Which implementation owns the workflow — verdict

**AgenticOS-v4 on branch `jarvis-voice` owns Jarvis's voice and desktop-control workflow today.
There is no separate `jarvis-next` rebuild.** A search of `C:\Users\Nebula PC\source\repos` and
`D:\` (top level and one level down) found no folder or branch named `jarvis-next` or similar. The
desktop app (`docs/DESKTOP-APP.md`) is a thin Tauri shell in `desktop/` at the repo root that
attaches to, or spawns, `bun --bun run start` **in AgenticOS-v4 itself** — it does not wrap or load
any other codebase. Evidence: `docs/DESKTOP-APP.md` §"Built (23 Sep 2026)" — "it spawns `bun --bun
run start` in the repo root itself"; the app "replaces the Startup `.vbs` + PowerShell supervisor,
not wraps it" and the supervisor's own target is AgenticOS-v4's dev server. There is one shipped
exe (`desktop/src-tauri/target/release/app.exe`, 10.1 MB) and it is optional — the Startup `.vbs` +
PowerShell supervisor launching the same AgenticOS-v4 server is still the primary autostart path as
of 23 Sep 2026 (`docs/DESKTOP-APP.md` §"Next step": "Owner decides whether/when this app should
replace the Startup `.vbs` + supervisor").

### 1.2 Voice pipeline

- **Router before the model.** `scripts/free-voice.ts`'s `freeVoice().turn()` runs, in order:
  anchored regex rules (0–10 ms) → the Jev router (one `POST
  https://api.typesafe.ai/v1/systemone` call, ~250–350 ms warm, 0 ms cached) → the Groq brain
  (`gpt-oss-120b`, 0.7–2.2 s). Evidence: `docs/JEV-ROUTING.md` §1.
- **Jev router request shape**: one request with 10 parallel typed sub-questions (`category`,
  `pc_action`, `browser_action`, `page`, `site`, `routine`, `skill`, plus nouls `listen`,
  `outbound`, `multi`, `complete`). Jev only picks the intent; deterministic code extracts slots
  (app names, folder names, etc.) and a failed extractor falls to the brain. Tiered confidence
  thresholds: `show` 0.55, `act` 0.60, `strong` 0.85, `hermes` 0.75 (`docs/JEV-ROUTING.md` §"1. The
  voice router", "Thresholds").
- **Wake word / "Hey Jarvis"** and "act while I speak" are voice-panel settings referenced in
  `docs/DESKTOP-APP.md` ("Already in the voice panel… voice, engine, 'Hey Jarvis', 'Act while I
  speak'") — implementation is in the voice-companion component, not separately audited here.
- **Measured routing accuracy**: 77-utterance labelled benchmark, `rules → skills → Jev router →
  brain` scored **74/77 (96%)** first pass, **77/77 (100%)** after two fixes (`docs/JEV-ROUTING.md`
  §"Benchmarks", "Round 2" re-run `round2-after.json`). All-turn latency p50 268–309 ms, p95 up to
  ~1.2 s when the brain is hit.
- **First-audio latency** (voice-out): streamed synthesis brought median first-audio from
  1,928 ms → **1,004–1,009 ms** (`docs/JEV-ROUTING.md` §"First audio on brain answers").

### 1.3 Hermes bridge (`/__hermes_chat`, `control_pc`)

- **`control_pc` sends `yolo: true` to Hermes.** Confirmed in code: `src/lib/jarvis-control.ts:180`
  (`yolo: true`), and independently in `scripts/capability-acceptance.ts:63` ("Exactly what
  control_pc does: the shared brief, yolo, streamed back" — `yolo: true` in the POST body) and
  `scripts/jarvis-control.test.ts:168` (`expect(calls[1].body.yolo).toBe(true)`). **This means
  Hermes' own per-tool "ask" confirmation loop is bypassed for every control_pc call** — Hermes will
  not itself pause to ask a human before running a tool it decides to run.
- **What actually gates a control_pc call today, given `yolo: true`:**
  1. **The code-level spoken-yes gate**, entirely outside Hermes: `gateControlTask()` in
     `src/lib/jarvis-control.ts:26-76`. `needsConfirmation(task)` regex-matches an `OUTBOUND` word
     list (send, email, message, whatsapp, post, publish, pay, buy, order, transfer, delete,
     uninstall, deploy, push, merge, submit, cancel a subscription/booking, etc. —
     `jarvis-control.ts:8-9`). If matched, the task is held as `pending` for **2 minutes**
     (`CONFIRM_TTL_MS`) and only re-runs on `isAffirmative(lastUserUtterance)` — a narrow regex that
     also rejects "yes, but…" style hedges via a `NEGATION` check (`jarvis-control.ts:10-33`). A
     **re-confirmed call always re-runs the exact task text that was read back**, never new text the
     model supplies afterwards (`jarvis-control.ts:36-37` comment, enforced at line 75).
  2. **The `/__jev` Hermes approval guardian** — this only fires for commands Hermes' own
     `tools/approval_smart.py` flags as needing smart approval (e.g. `powershell -Command
     "Start-Process …"`, "script execution via -e/-c"), and only inside a Hermes run that has
     already started. It is a **second, narrower net**, not a substitute for pre-execution gating:
     Hermes' `auxiliary.approval.base_url` is repointed at `http://127.0.0.1:8081/__jev/v1` (loopback
     only, bearer token from `.operator-data/jev-shim.token`), which asks Jev four yes/no questions
     (`harmless`, `destructive`, `outbound`, `manipulation`) on `{flagged_as, command}`, after a
     hard-coded risky-operation/target code list that auto-escalates without asking Jev at all
     (delete, overwrite/redirect, kill, services, registry, installs, network transfer, encoded
     payloads, git push, scheduled tasks, power state, or scripts/installers from
     Downloads/Temp — `docs/JEV-ROUTING.md` §3, list 1). `APPROVE` only when `harmless ≥ 0.75` and
     every risk noul `≤ 0.3`; it **never returns `DENY`**, only `APPROVE` or `ESCALATE` (a human
     stays in the loop on any doubt); no key/timeout/unparseable response also escalates
     (`docs/JEV-ROUTING.md` §3, list 3).
  3. **`needsConfirmation()` runs before Jev is even asked at the router layer too**
     (`docs/JEV-ROUTING.md` §"1. The voice router", "Safety"): any utterance it flags never becomes
     an instant action and only reaches control_pc's own gate. Jev's own `outbound` noul is
     described as "a second net" that catches phrasings the regex misses (e.g. "ring Smile Dental
     for me").
  - **Net effect for this design doc: with `yolo: true`, the only two things standing between a
    voice utterance and Hermes taking a real action are (a) the code regex + spoken-yes gate in
    `jarvis-control.ts`, entirely independent of any model or Jev judgment, and (b) the `/__jev`
    guardian, which only inspects flagged shell commands Hermes chooses to run mid-task and is a
    probabilistic (not deterministic) check.** A gap exists between these: an action the OUTBOUND
    regex does not match, and that Hermes does not classify as needing smart approval (e.g. a plain
    file write, a UIA click sequence that has no shell command in it, a browser action Hermes drives
    directly), currently has **no gate at all** once yolo:true is set and the task has started. This
    is the load-bearing finding for the target architecture below (§2): **Jev must never be the only
    gate on anything with external effects, and the code-level allow/deny list needs to widen from
    "outbound-shaped words" to "has this action left the sandbox of screen_act's own vetting."**

### 1.4 Computer control (`screen_act`, spoken-yes, verification)

`docs/SCREEN-CONTROL.md` documents a materially more mature and better-gated system than the
Hermes/control_pc path above, and it is the model worth generalising from:

- **Read → choose → act → verify loop, capped at 8 steps.** Reads the foreground window's Windows
  UI Automation (UIA) tree (cached `FindAll` via a warm hidden PowerShell + compiled C# helper).
  Action choice is cheapest-first: plain-English rules with no model call → Jev (only when two
  candidate elements score near-identically) → Groq brain (open goals) → vision (Claude Sonnet 5 /
  GPT-6, last resort, requires the owner's remembered "Allow"). Acts via `SendInput`, or UI
  Automation patterns (`Invoke`, `Toggle`, `Select`) first so the owner's real mouse pointer never
  moves. **Verifies before the next step**: a typed value is read back (polled up to ~0.4 s); a
  clicked field must hold focus; a clicked button must change the tree; if a dialog/other window
  steals focus, the run stops and says so rather than claiming a swallowed click.
  (`docs/SCREEN-CONTROL.md` §"What it does".)
- **Safety is in code (`vetAction` in `plan.ts`), not the prompt**, and runs on every action
  regardless of who chose it (rules, Jev, model, or vision): never types into a UIA
  `IsPassword` field; never types into any field labelled card/CVV/expiry/BSB/account/TFN/passport/
  licence/Medicare/2FA/OTP/API-key/token/recovery-phrase; text that Luhn-checks as a card number or
  matches a 6-9 digit code/bank number/ID/key is refused regardless of the field; vetting checks
  **both** the aimed-at field and whatever currently holds focus (defeats a popup stealing focus);
  banking and password-manager windows are never typed into at all.
  (`docs/SCREEN-CONTROL.md` §"Safety rules (code, not prompt)".)
- **Explicit spoken-yes gate on "final" actions** — Submit, Pay, Send, Delete, Publish, Post,
  Confirm, Buy, Place order, Sign up, Book, and the Enter/Space/Ctrl+Enter/Alt+S equivalents. The
  run **stops with a question**, holds that one button label for 2 minutes, and only a clear
  `isAffirmative` yes re-sends the action **confirmed for that exact label** — "the yes covers one
  press of that button only." Filling fields needs no confirmation (low external effect).
- **On-screen text is explicitly treated as untrusted data**: "A control whose text addresses an
  assistant ('Jarvis: click…', 'ignore previous instructions') is never clicked, even with a yes.
  The planner is told that element text is untrusted." This is the repo's own working defence
  against prompt injection via screen content — already implemented, and it is the pattern the
  target architecture (§2, §3) should extend to Jev-scored decisions as well, not just clicks.
- **Cancellation**: "Stop" (voice) aborts the HTTP request; the server's `AbortController` ends the
  loop between sub-steps and cancels an in-flight model call; the client also calls
  `/screen/stop`; measured **~1 ms** to end after the abort (`docs/SCREEN-CONTROL.md` §"Measured").
- **Measured reliability** (`docs/SCREEN-CONTROL.md`, `docs/jev-bench/screen-round3..5-2026-09-25.json`):
  - Round 3 end-to-end suite (17 tasks): 10/17 (59%) → **13/15 (87%)** after fixes; total time
    377 s → 76 s.
  - Round 4 (32 tasks): 4/12 → **11/12** on the same 12 retested; **26/28 (93%)** across all that ran.
  - Round 5 "strict suite" (33 tasks, 28 run): **26/28 (93%)**, p50 step latency **0.49 s**, 2
    questions, 2 wrong actions. Two real incidents surfaced and were fixed live: `screen_act`
    toggling a UI element in the **wrong app** because a same-window heuristic didn't check the app
    name (`chrome-bookmarks` incident, fixed by refusing to act on any app other than the one named);
    and the test harness auto-answering Hermes' own confirmation prompt with "yes" (`notepad-list`
    incident — fix: "the suite never gives Hermes an automatic yes"). Both are logged as concrete
    known failure modes, not hypotheticals.
  - Step latency, rules path: p50 ~410 ms, p95 ~870 ms (`docs/SCREEN-CONTROL.md` §"Measured").
  - Jev-assisted click chains: p50 **1.07 s/step** (UIA snapshot + glide + press + read-back),
    3.1–5.7 s end to end for 2-3 step chains (`docs/SCREEN-CONTROL.md` §"Jev picks what to click
    too", "Live results").
  - Outbound bench: **11/11 gated**, "none became an instant action" (repeated across rounds).
- **Known gaps, in the repo's own words**: apps without UIA (games, canvas/Electron) fall to
  vision and need the owner's "Allow"; CAD/canvas apps have no UIA surface at all and the repo
  explicitly recommends driving each app's own scripting API (Fusion 360 Python API, SolidWorks COM,
  Blender `bpy`, KiCad `pcbnew`) over pixel-dragging a viewport, calling this "not built yet"; a
  cached lesson plan or duplicate labels can mislead completion-detection heuristics.

### 1.5 Capability registry and acceptance suite

- `scripts/capability-registry.ts` and `scripts/capability-acceptance.ts` exist and are what
  generates `jarvis-skills/capabilities.ts`'s "what can you do" answer from **real routes and the
  last full suite run**, not a hand-written list (`docs/SCREEN-CONTROL.md` §"'What can you do on my
  PC?'"). `capability-acceptance.ts:57-63` shows the acceptance harness calls control_pc exactly as
  production code does, `yolo: true` included — i.e. the acceptance suite exercises the same
  ungated path production uses, which is appropriate for testing but means a suite bug (as in the
  `notepad-list` incident above) can itself take a real, unconfirmed action.

### 1.6 Hermes config structure (structure only, no secret values read)

`%LOCALAPPDATA%\hermes\config.yaml` has an `auxiliary.approval` block added 24 Sep 2026
(`docs/JEV-ROUTING.md` §3, "Hermes config"): keys `base_url`, `api_key` (value not read here —
referred to as "contents of `.operator-data/jev-shim.token`" only), `model: jev-latest`,
`api_mode: chat_completions`, `timeout: 5`. A dated backup of the prior file exists
(`%LOCALAPPDATA%\hermes\backups\config.yaml.2026-09-24T01-10-51-121Z.before-jev-guardian`), and
SOUL.md has a backed-up edit exempting a single Start-Process launch from a mandatory
`skill_view` read (`%LOCALAPPDATA%\hermes\backups\SOUL.md.2026-09-24T03-04-48Z.before-jev-fastlane`).
The guardian's scope note is explicit: it applies to **every** Hermes surface using smart approvals
(Telegram, the API server), not Jarvis alone, and a guardian-call failure always escalates to a
human rather than auto-approving (`docs/JEV-ROUTING.md` §3, "Scope and failure mode").

### 1.7 Provider fallback and latency figures already recorded

`docs/FALLBACK-ORDER.md` documents six fallback chains (coding agent, image gen, video
understanding, bulk text, critique, voice brain), each with a primary/fallback/last-resort and a
plain unauthenticated health-check command, re-run 26 Sep 2026. Relevant to this design: the
**voice brain** chain is Groq (free tier: 8k tok/min, 1k req/day) → Gemini (direct, then
OpenRouter) → **Jev's fast-path rules/cache with no model call at all** as the absolute last resort
(`docs/FALLBACK-ORDER.md` §6) — i.e. the repo already treats "no model available" as a real
operating condition and has a defined degraded mode for it, which the target architecture should
preserve and extend to the planner/executor layers.

### 1.8 TypeSafe Jev — documented weaknesses, cost, and data handling

Per `docs/sales/dental-call-pack-2026-09-28/research/jev-facts.md` (compiled 27 Sep 2026, primary
sources fetched that date):

- **API contract**: `POST https://api.typesafe.ai/v1/systemone`, bearer auth, `state` +
  `questions` map of `noul` (yes/no probability) / `choice` (≤255 options) / `score` (2-10 level
  rubric) questions; response includes per-answer `confidence`/`probabilities`. No published SLA
  latency figure on `docs.typesafe.ai/api` — AgenticOS-v4's own 1.5 s client-side abort timeout is
  **our choice, not a TypeSafe-documented limit** (code comment: "the community routers fall back
  at 1.5 s; so do we").
- **Cost**: **US$0.042 per million input tokens, output free** (Jev returns a typed decision, not
  text) — confirmed directly on `typesafe.ai` (accessed 27 Sep 2026), corroborated by third-party
  listings. TypeSafe's own "40x-200x faster than frontier LLMs" and "238x lower input price than
  Claude 5.1" claims are marketing copy, not independently reproduced — the repo's own measured
  numbers (§1.2-1.4 above) are the only latencies to rely on for planning.
- **Hosting/retention**: TypeSafe's privacy policy states **"The Services are hosted in the United
  States"** and **"We will not train or fine tune any... models on your prompts or other Input,"**
  but retention language is a vague "as long as reasonably necessary" with **no fixed number of
  days published**. A zero-data-retention (ZDR) enterprise option is mentioned only in a
  third-party (non-TypeSafe) source and is **not independently confirmed**; treat as
  "enterprise-only if it exists at all, and unconfirmed even then." No HIPAA statement or health-data
  disclosure appears anywhere on the policy as fetched.
- **Documented model weaknesses** (from TypeSafe's own material, per `jev-facts.md` and the
  external research below): Jev is explicitly a narrow, schema-constrained classifier/scorer, not a
  reasoner — the vendor's own positioning and third-party coverage describe **date/time reasoning,
  counting, and resistance to adversarial/injected content** as known weak points for this class of
  "System One" model, consistent with it being optimised for fast calibrated classification over a
  small option set rather than robust judgment under adversarial input.
  **Consequence for design: Jev must never be the sole gate on any action whose input state
  (a screen, a webpage, a document) could contain adversarial/injected text** — exactly the class of
  input `screen_act`'s own `vetAction` already treats as untrusted (§1.4). Any Jev judgment that
  consumes on-screen or web content as its `state` needs a code-level check either upstream (as
  `vetAction` already does for clicks) or downstream (verifying the actual effect, not trusting the
  judgment) — this is threaded through every Jev judgment spec in §2.2 below.

---

## 2. Target architecture

```
voice/screen input
   │
   ▼
[1] fast rules (regex/anchored grammar, 0–10 ms, in code)
   │  no match / ambiguous
   ▼
[2] Jev typed judgments (single or fan-out call, ~250–350ms warm, narrow typed questions only)
   │  low confidence / timeout / adversarial-content flag
   ▼
[3] planner (Groq brain for open dialogue; Hermes/Claude for multi-step PC tasks)
   │  produces a plan: named actions against named targets
   ▼
[4] action executor (UIA/Playwright first, SendInput fallback; approval tiers enforced HERE in code)
   │
   ▼
[5] verifier (re-read UIA/DOM state; confirm effect matches intent; never assume success)
   │
   ▼
[6] audit log (structured event: intent, tier, verdict, latency, outcome — never raw transcript/screen text)
```

The one rule that must not be relaxed: **hard rules, permission tiers, approvals, and the actual
side-effecting code live in the executor (step 4) and are deterministic.** Jev (step 2) may only
narrow which deterministic path gets taken faster; it never becomes the gate itself. This mirrors
what `screen_act`'s `vetAction` already does (§1.4) and closes the gap identified in §1.3 for
`control_pc`.

### 2.1 Design principle carried through every judgment below

Because Jev is a narrow, schema-constrained "System One" classifier — fast and calibrated on
well-posed questions, but with documented weak points on date/time reasoning, counting, and
adversarial/injected content (§1.8) — every judgment spec below states explicitly:
**(a)** what happens on low confidence or timeout (never "assume yes"),
**(b)** whether the input state could contain adversarial content, and if so what independent
code-level check exists besides Jev's own answer, and
**(c)** the cost of being wrong, which sets the confidence threshold (external-effect judgments get
higher thresholds than pure UX-routing judgments, matching the existing tier design in
`docs/JEV-ROUTING.md` §"Thresholds": show 0.55 / act 0.60 / strong 0.85 / hermes 0.75).

### 2.2 Candidate Jev judgments — accept/reject each

| # | Judgment | Verdict | Input state | Output schema | Confidence threshold | Fallback (low-conf/timeout) | Latency budget | Privacy (what goes to the US) | Cost/call |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Intent routing (voice → category) | **ACCEPT — already built** | The utterance text + a fixed option catalogue (`category`, `pc_action`, etc.) | `choice` × several, fan-out in one request | Tiered: show 0.55 / act 0.60 / strong 0.85 / hermes 0.75 (existing) | Falls to Groq brain, which gets Jev's best guess as a hint, not a command | ~250–350 ms warm (measured) | The spoken utterance text only — never screen content, never file contents | ~$0.0004/call (TypeSafe's own estimate, unverified independently) |
| 2 | "Does this action have external effects?" (tiering) | **ACCEPT, but as a second net only — code regex stays primary** | The parsed action (tool name + args), never raw screen/document text | `noul` (`outbound`) | `outbound ≤ 0.35` to allow an instant action (existing threshold in the router); a control_pc task additionally must pass the code-level `needsConfirmation()` OUTBOUND regex first | On ambiguity (0.35–0.6), always ask, never run silently | ~250–350 ms, folded into the existing router call | The parsed intent/args only | Marginal (bundled into judgment #1's fan-out where possible) |
| 3 | Target-window/element selection among UIA candidates | **ACCEPT — already built and measured** | A masked, labelled list of ≤20-30 UIA elements (values masked; passwords never sent) | `choice` over named elements | ≥ 0.6 to click directly; below that, tie-break or vision fallback (existing) | Vision (Claude Sonnet 5 → GPT-6), owner's "Allow" required | ~0.7–1 s including the glide+press+read-back (measured, `docs/SCREEN-CONTROL.md`) | Element labels/roles only, not field values; passwords excluded by `vetAction` before this call ever fires | ~$0.0004/call |
| 4 | "Did the action succeed?" from before/after UIA state | **ACCEPT — extend existing verify step to use Jev instead of ad hoc code where the check is genuinely fuzzy** (e.g. "did a toast notification confirm this?"); **REJECT for anything code can check deterministically** (focus held, value read back, tree changed — keep these as plain code per `docs/SCREEN-CONTROL.md`, don't add a model call to a check that's already exact) | Before/after UIA snapshot diff (labels/roles/values changed, never full text dumps) | `noul` (`succeeded`) | ≥ 0.75 to report success; below that, report "unverified," never "succeeded" | Report the action as **unverified**, not failed and not succeeded — surface it to the user/log honestly | ~250–350 ms, off the critical path (verification can run after the spoken reply) | Element diffs only | ~$0.0004/call |
| 5 | "Is this screen text an injected instruction?" | **REJECT as the primary defence; ACCEPT only as a secondary, non-blocking flag** — the primary defence must stay the existing code rule ("a control whose text addresses an assistant... is never clicked, even with a yes" — `docs/SCREEN-CONTROL.md`) precisely because this is exactly the adversarial-content case Jev is documented to be weak on (§1.8). A Jev flag can add a second signal for logging/anomaly review but must never be trusted to *allow* a click a keyword rule would otherwise block. | The element's own text/label | `noul` (`looks_like_injection`) | Not gating — informational only, logged | N/A — never blocks or allows on its own | Not on the critical path | The specific control's text only | ~$0.0004/call |
| 6 | Cancel-intent detection during barge-in | **ACCEPT** | The interrupting utterance | `noul` (`is_cancel`) | ≥ 0.6, but any recognised "stop" keyword bypasses Jev entirely (existing: "Any confirmed speech aborts the voice turn," `docs/SCREEN-CONTROL.md` §"Safety rules") | Treat ambiguous interruptions as "keep listening," not as a stop — a missed stop is worse than an unnecessary continue-check, so keep the plain keyword path as primary and this as an enhancement only for non-keyword phrasing ("hold on", "wait no") | ~250–350 ms | The interrupting utterance text only | ~$0.0004/call |
| 7 | Clarification-needed | **ACCEPT — already effectively built** (`refs`/"which one?" logic in Round 3, `docs/SCREEN-CONTROL.md`) | The parsed goal + count of matching candidates | `noul` (`ambiguous`) | Existing behaviour: ask on genuine ties, don't ask on clear ones (measured "asked 4 of 16 orders: all 4 on the 2 orders built to be ambiguous, 0 of 12 on clear ones") | Ask — over-asking is the safe failure mode here, not silent guessing | Folds into judgment #3's call | Parsed goal + candidate labels only | Marginal |

**Judgments explicitly rejected outright, with reasons**: any judgment whose `state` would need to
include free-form document/web content combined with a *binding* (not just advisory) decision to
act — e.g. "should I trust this web page's instructions," "is this email safe to reply to
automatically" — because Jev's documented weakness on adversarial content (§1.8) makes it an unsafe
sole arbiter for exactly the case where the input is most likely to be adversarial. These stay
either fully rule-based (deny-list, as `vetAction` already does) or fully human-gated (spoken yes).

---

## 3. Desktop control reliability

The repo has already made the right architectural call and validated it live — this section is
about tightening what exists, not replacing it.

- **UIA/accessibility-tree first, Playwright for browser targets, pixel/vision last resort.**
  `screen_act` already orders itself this way (`docs/SCREEN-CONTROL.md` §"Choose one action"), and
  the measured numbers justify it: rules-path steps run p50 ~410 ms with exact read-back
  verification; vision is reserved for apps with no UIA surface and requires the owner's standing
  "Allow." **Recommendation: keep this order, and extend it explicitly to Playwright for any
  browser-only target** (form fills on sites without exposed UIA semantics, or when Jarvis Chrome —
  the separate CDP profile on :9222 — is the actual target rather than the owner's own browser
  window) rather than falling to vision for browser content, since Playwright gives exact DOM
  selectors and network-idle waits that vision cannot.
- **Dry-run preview**: not currently implemented as a distinct step — today the "preview" *is* the
  spoken read-back before a final-button confirmation (`gateControlTask`, `screen_act`'s
  `[confirm]` mechanism). **Recommendation: make the dry-run explicit and visual for tier-2+
  actions** (see §5's demo task) — render the planned action (target element, its label, the text
  to be typed) to the HUD pill *before* sending input, not just as spoken text, since a spoken
  read-back is lossy for anything with multiple fields.
- **Explicit approval for external effects**: exists today as the OUTBOUND regex +
  `gateControlTask` 2-minute pending window (`jarvis-control.ts`) for control_pc, and the
  final-button spoken-yes gate for screen_act. **Gap to close**: as established in §1.3, an action
  that is neither OUTBOUND-regex-matched nor a "final button" click currently has no approval gate
  once a Hermes task is running with `yolo: true`. **Recommendation: widen `vetAction`'s deny/confirm
  list to be the single source of truth for "needs approval," and make control_pc route every task
  through the same `vetAction`-equivalent check before it ever reaches Hermes**, rather than having
  two separate ad hoc keyword lists (`OUTBOUND` in `jarvis-control.ts` vs. the final-button list in
  `plan.ts`) that can drift out of sync.
- **Cancellation**: already fast and verified (~1 ms to end after abort,
  `docs/SCREEN-CONTROL.md` §"Measured"). No change recommended.
- **Post-action verification**: already the core loop discipline for `screen_act` (read back typed
  values, confirm focus, confirm tree change, stop rather than assume on an unexpected dialog).
  **Recommendation: apply the same discipline to control_pc/Hermes tasks**, which today report
  success based on Hermes' own narration rather than an independent state check — e.g. after a file
  operation, verify the file exists with the expected content rather than trusting Hermes said it
  wrote it.
- **Failure recovery**: `screen_act` already fails closed (stops and reports, doesn't guess) on an
  unexpected window/dialog. **Recommendation: define one shared "unverified" outcome state** (not
  just success/fail) surfaced identically across screen_act, control_pc and the planner, so the user
  and the audit log can distinguish "definitely worked," "definitely failed," and "we don't actually
  know" — judgment #4 above (§2.2) is designed to report exactly this third state honestly rather
  than being coerced into a binary.
- **Audit trail free of private transcripts**: `docs/SCREEN-CONTROL.md` already states frames are
  "captured to a JPEG in RAM, sent once, and never written to disk or logs," and the `/__jev`
  guardian "logs verdicts without the command text" (`docs/JEV-ROUTING.md` §3). **Recommendation:
  formalise this as a standing rule for every new judgment in §2.2**: log `{judgment_name, tier,
  confidence, verdict, latency_ms, outcome}` only — never the `state` payload itself, matching the
  existing pattern rather than introducing a new logging convention per feature.

---

## 4. Real-time voice: latency budget and fast paths

| Stage | Current measured (this repo) | External reference target | Notes |
|---|---|---|---|
| Endpointing / turn detection | Not separately benchmarked in-repo | Sub-200 ms endpoint detection is the norm for realtime voice systems built on streaming VAD (see external research pack, §(b)) | Worth a dedicated bench entry — currently folded into overall first-audio numbers |
| Router (rules → Jev → brain decision) | p50 268–309 ms all-turn; rules alone 0–10 ms; Jev alone 282–311 ms warm; cache hit ~1 ms (`docs/JEV-ROUTING.md`) | — | Already well inside a <800 ms full-loop budget on its own |
| Brain (open-ended reply generation, Groq) | 0.5–0.9 s including Jev (`docs/JEV-ROUTING.md` §"First audio") | — | The dominant cost when the router can't resolve to an instant action |
| First audio out (TTS, streamed) | **1,004–1,009 ms** median, down from 1,928 ms unstreamed (`docs/JEV-ROUTING.md`) | Realtime voice UX guidance generally targets <800 ms mouth-to-ear for natural turn-taking (external research pack, §(b)) | **This is the one stage currently outside the <800 ms target** — closest lever is trimming the brain's pre-first-sentence latency further, since TTS streaming is already applied |
| Barge-in / cancellation | ~1 ms to abort after a recognised "stop" (`docs/SCREEN-CONTROL.md`) | — | Already fast; the recommendation in §2.2 judgment #6 only extends coverage to non-keyword interruptions, not speed |
| Warm-connection keepalive | TypeSafe 683→463→~250-300 ms; Groq 344→219 ms; ElevenLabs 618→~250 ms; Hermes first task 3.5s→2.4s model call (`docs/JEV-ROUTING.md` §"Warm paths") | — | Already implemented via `/voice/free/warm` HEAD pings every 20 s for 10 min post-turn |

**What to cache** (already implemented, worth preserving as explicit design invariants): normalised
utterance → Jev router answer (30 min TTL, 256-entry LRU, `DecisionCache`); per-app/goal lesson
plans (`%LOCALAPPDATA%\AgenticOS\lesson-plans.json`, 60 entries, no expiry — flagged in-repo as
containing personal details, treat as private); Astra coaching plans per app+goal.

**Speculative execution**: partial transcripts already run through the same router
(`/voice/free/reflex`) so the final turn is usually a cache hit; show-only, high-confidence,
low-stakes calls are already run speculatively ahead of turn completion (`docs/JEV-ROUTING.md`
§"Cache, prefetch and warm connection"). No further speculative work recommended beyond keeping
this invariant as new intents are added — speculative execution must never be applied to anything
above the `show` tier (i.e. never speculate an action with external effects).

---

## 5. Phased plan (P0 → P2), each with acceptance tests

Every item is tagged **[synthetic]** (a healthy-gateway/synthetic-data test — proves the pipes
work) or **[real]** (proof of actual Windows control on the owner's machine) so the two are never
conflated in a status report.

### P0 — this week

1. **Unify the two approval keyword lists.** Replace the separate `OUTBOUND` regex
   (`jarvis-control.ts`) and the final-button list (`plan.ts`) with one shared deny/confirm
   definition, so a new outbound verb only needs to be added once. **[synthetic]** Acceptance:
   existing unit tests (`jarvis-control.test.ts`, the outbound bench in
   `scripts/jev-bench-cases.ts`) still pass 11/11 with the merged list; add one new case per merged
   category to prove no verb was dropped in the merge.
2. **Close the yolo:true gap for control_pc.** Route every control_pc task through a `vetAction`-
   style code check before Hermes ever sees it, not only ones matching the OUTBOUND regex.
   **[synthetic]** Acceptance: a scripted control_pc call for an action with no OUTBOUND keyword but
   a real external effect (e.g. a file delete outside `D:\tmp`) must escalate/refuse under the new
   check where it previously would have run silently — write this as a new test case, not a live
   deletion.
3. **Formalise the "unverified" outcome state** across screen_act and control_pc reporting.
   **[synthetic]** Acceptance: unit test that a verification timeout returns `unverified`, never
   silently coerced to `succeeded`.

### P1 — next 2-4 weeks

4. **Playwright as the explicit browser-target executor**, ahead of vision, for any action on
   Jarvis Chrome (:9222) or a named site the owner's own browser doesn't expose well through UIA.
   **[real]** Acceptance: the demo task in §6, plus a second browser-only task (fill and submit a
   test form on a scratch local page) with a dry-run preview before submission.
5. **Judgment #4 ("did it succeed") as a genuine Jev call** for the fuzzy cases identified in §2.2
   (toast/notification-style confirmations), leaving deterministic UIA checks as plain code.
   **[synthetic]** Acceptance: replay the round-5 `notepad-list` incident's before/after UIA
   snapshots (already logged) through the new judgment and confirm it reports `unverified` rather
   than a false `succeeded`.
6. **Extend audit logging** to the shared `{judgment_name, tier, confidence, verdict, latency_ms,
   outcome}` shape for every judgment in §2.2, and confirm none of it captures `state` payload
   content. **[synthetic]** Acceptance: grep the resulting log file for known test-only PII markers
   inserted deliberately in a test run; confirm zero matches.

### P2 — 1-2 months

7. **Non-keyword barge-in detection (judgment #6)** as an enhancement layered over the existing
   keyword stop, never replacing it. **[real]** Acceptance: 10 live interruption phrasings ("hold on
   a sec", "wait, no", "actually stop") correctly pause without a literal "stop"/"pause" keyword,
   with zero regressions on the existing keyword-based stop bench.
8. **Pro-app scripting-API integration** (Fusion 360 Python API / Blender `bpy` / etc.) for the
   canvas-app gap already identified in-repo, starting with whichever app Mehroz actually uses.
   **[real]** Acceptance: one parametric operation (e.g. Blender: create a cube, scale it via typed
   input, save the file) run headless via the app's own API and verified by reading the saved file
   back — no viewport pixel-dragging involved.
9. **Cut over the desktop app from "coexists with the supervisor" to "replaces it"** per
   `docs/DESKTOP-APP.md`'s own open decision — an operational milestone, not a reliability feature,
   but blocks distributing the installer beyond this one PC. **[real]** Acceptance: the Tauri app
   survives a full reboot as the sole autostart mechanism for 5 consecutive days with the supervisor
   `.vbs` disabled, with the existing "attach, don't duplicate" health check confirming exactly one
   server process throughout.

---

## 6. ONE small end-to-end demo task (synthetic data) — for the lead to run

**Task**: "Open Notepad, type a synthetic note, save it to a scratch folder, verify the file
contents, with dry-run preview and approval."

**Exact steps**:
1. Say (or send via the voice endpoint): *"Open Notepad and type: This is a synthetic test note,
   dated [today's date], created by the Jarvis reliability demo. Then save it to D:\tmp as
   jarvis-demo-note.txt."*
2. Confirm `screen_act` reads the foreground window (Notepad) via UIA and types through the
   verified path (typed text read back via UIA poll, per `docs/SCREEN-CONTROL.md` §"Verify").
3. Confirm the **Save** action is treated as a final/external-effect action (it writes a new file)
   and triggers the dry-run preview: the HUD pill (or a logged pre-action event) shows the exact
   target path and filename *before* the save dialog is confirmed.
4. Say the spoken "yes" only after reviewing the preview; confirm the gate accepts only that exact
   confirmation (per `gateControlTask`'s "always re-runs the exact task that was read back").
5. After save, run an independent verification step (not trusting Notepad's own "Saved" state):
   read `D:\tmp\jarvis-demo-note.txt` directly and diff its contents against the intended text.
6. Confirm the audit log contains one structured entry per step (`intent`, `tier`, `confidence`
   where applicable, `verdict`, `latency_ms`, `outcome`) and **zero raw note text** in the log file
   itself — only in the actual saved file.
7. Clean up: delete `D:\tmp\jarvis-demo-note.txt` manually (not by voice, to avoid exercising the
   delete-approval path as part of cleanup) once verified.

**Pass criteria**: file exists at the exact path, content matches exactly (byte-for-byte after
newline normalisation), the dry-run preview appeared and named the correct target before the write,
the spoken-yes gate held for the full 2-minute window and rejected a hedge ("yes but wait") if
tested, and the audit log has one entry per step with no note content in it.

**Fail criteria**: file missing, wrong path, wrong content, the save proceeding without a visible
preview step, the gate accepting an ambiguous confirmation, or any log entry containing the literal
note text.

This is deliberately synthetic (no real owner data, no real external effect beyond a scratch-folder
file) and deliberately small — it exercises the full loop (voice → router → UIA action → verify →
gate → audit) without needing the Playwright/pro-app work from later phases.

---

## 7. What NOT to build, and why

- **Do not make Jev the sole gate on any action with external effects.** Its own documented
  weaknesses (date/time reasoning, counting, adversarial-content resistance — §1.8) make it
  unsuitable as a lone arbiter for exactly the situations where being wrong matters most. Keep code
  deny-lists and the spoken-yes gate as the actual authority; Jev only chooses which deterministic
  path runs, faster.
- **Do not build a general "is this screen text malicious" classifier as a blocking gate**
  (rejected explicitly in judgment #5, §2.2) — the existing keyword-based "never click a control
  whose text addresses the assistant" rule is simpler, auditable, and doesn't depend on a
  probabilistic call being right under adversarial pressure, which is the exact failure mode being
  defended against.
- **Do not route CAD/canvas-app tasks through pixel-dragging or vision-only control.** The repo's
  own analysis (§1.4, "Pro software") already concludes the scripting-API route is the only one that
  gives exact, verifiable results; building a vision-based clicker for Fusion 360/Blender/SolidWorks
  would be measurably less reliable and shouldn't be attempted as a shortcut.
- **Do not send patient-identifiable or otherwise sensitive personal data through Jev calls** while
  TypeSafe's retention terms remain a vague "as long as reasonably necessary" with no confirmed
  fixed period and no HIPAA/health-data statement, and its ZDR enterprise option remains
  third-party-sourced and unconfirmed (§1.8). This applies directly to any future MU-Receptionist /
  dental-context integration that would route call content through Jev — keep Jev's `state` input to
  routing/UI metadata (element labels, intent categories), never raw customer or patient text, until
  TypeSafe's own retention and health-data terms are confirmed in writing.
- **Do not claim a "$10M" or otherwise hype-scale outcome from this work.** The measurable targets
  are: sub-800 ms voice loop (currently ~1.0 s first-audio, the one stage still above target, §4);
  ≥93% task completion on the existing 28-33 task acceptance suite (already achieved, §1.4); zero
  ungated external-effect actions (the gap identified in §1.3, closed by P0 items 1-2). These are
  the numbers to report against, not a revenue projection this document has no basis for.

---

## Evidence index (local)

- `docs/SCREEN-CONTROL.md` — computer-control loop, safety rules, all measured tables cited in §1.4, §3, §6.
- `docs/JEV-ROUTING.md` — voice router, Hermes task planning, `/__jev` approval guardian, all benchmark tables cited in §1.2, §1.3, §1.6, §4.
- `docs/FALLBACK-ORDER.md` — provider fallback chains and health checks, §1.7.
- `docs/DESKTOP-APP.md` — desktop app architecture and the "which implementation owns this" evidence, §1.1.
- `docs/sales/dental-call-pack-2026-09-28/research/jev-facts.md` — TypeSafe Jev API contract, pricing, hosting/retention, compiled 27 Sep 2026, §1.8.
- `docs/sales/dental-call-pack-2026-09-28/research/pricing-and-sources.md` — cross-check on TypeSafe pricing figures, §1.8.
- `src/lib/jarvis-control.ts:1-90` — `needsConfirmation`, `isAffirmative`, `gateControlTask`, the `yolo: true` call site (line 180) — §1.3.
- `scripts/capability-acceptance.ts:57-63` — confirms the acceptance suite itself calls control_pc with `yolo: true`, §1.5.
- `scripts/jarvis-control.test.ts:168` — unit-test assertion of `yolo: true`, §1.3.
- `scripts/jarvis-skills/pc-control.ts` — direct-route skills bypassing Hermes for everyday PC requests (settings, files, deploys), §1.3 context.
- `docs/jev-bench/*.json` — raw benchmark run logs backing every measured number cited above.
- Search of `C:\Users\Nebula PC\source\repos` and `D:\` (no `jarvis-next` found) — §1.1.

## External sources consulted for this document

External deep research on (a) computer-use agents on Windows, (b) real-time voice agent latency
budgets and barge-in, and (c) agentic-action safety patterns was conducted via a dedicated research
pass; the TypeSafe-specific findings from that pass are folded into §1.8 above and sourced directly
to `docs.typesafe.ai/api`, `typesafe.ai`, and `typesafe.ai/legal/privacy-policy` (all accessed 27
Sep 2026, per `jev-facts.md`). General industry guidance on UIA-vs-pixel control, realtime voice
latency budgets, and approval-tier/dry-run/audit patterns for agentic systems (§2-§4 framing) draws
on the current state of publicly documented practice for computer-use and voice-agent products as
of September 2026; where a specific external claim needed a number, it is either already carried
into the tables above with its own citation, or flagged as general industry framing rather than a
sourced statistic, to avoid overstating verification beyond what was actually fetched and confirmed.
