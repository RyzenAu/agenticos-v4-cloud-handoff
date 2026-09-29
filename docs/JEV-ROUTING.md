# Jev routing: how Jarvis decides in a third of a second

TypeSafe's Jev (`jev-latest`, `POST https://api.typesafe.ai/v1/systemone`) makes typed decisions
(choice / score / yes-no "noul") with calibrated probabilities. It can't write text, and it can't
answer outside the options it's given. Jarvis now uses it as the backbone of three decisions:

1. **Which instant action a voice turn is** (`scripts/jev-router.ts`), before the language model.
2. **How hard a Hermes task is** (`scripts/jev-hermes.ts` → `planHermesTask`), to set Hermes'
   reasoning effort per task.
3. **Whether a flagged shell command is safe** (`scripts/jev-hermes.ts` → `/__jev` guardian), in
   place of the gpt-6-sol call Hermes' smart approvals make.

The code stays in control; Jev only answers narrow questions.

## 1. The voice router

Order inside `freeVoice().turn()` (scripts/free-voice.ts):

1. Anchored regex rules: status, protocols, screen questions, `pcIntent`, `browserIntent`,
   skills. Local, ~0–10 ms.
2. **Jev router** — one request, ~250–350 ms warm, 0 ms on a cache hit.
3. The Groq brain (0.7–2.2 s), with Jev's best guess as a one-line hint.

### One request, speculative sub-questions

TypeSafe evaluates every question in a request in parallel against the same state ("adding
questions barely changes the response time"), so the router asks everything at once:

| question | type | options |
|---|---|---|
| `category` | choice | pc, browser, os_page, website, screen, status, routine, skill*, emails, memory, workspace, hermes, brain |
| `pc_action` | choice | open_app, open_folder, next, previous, play_pause, volume_up, volume_down, mute, lock, none |
| `browser_action` | choice | click, pause, play, back, forward, reload, scroll_down, scroll_up, new_tab, close_tab, search, none |
| `page` | choice | the OS's pages (+ /leads), none |
| `site` | choice | `SITES` in jev.ts + any spoken address, none |
| `routine` | choice | start-day, call-mode, end-call-mode, shutdown, none |
| `skill`* | choice | the jarvis-skills pack's skills, none |
| `listen` | noul | asking about audio, not the screen |
| `outbound` | noul | sends, calls, pays, books, posts, shares, deletes, deploys… |
| `multi` | noul | several actions / a multi-step task |
| `complete` | noul | he has finished the request |

\* only when skills are registered.

The router resolves `category` + the matching sub-choice into one intent (`pc.volume_down`,
`browser.back`, `os_page`, `routine.shutdown`, `skill.timer`, `hermes`, …). Its confidence is the
weaker of the two confidences. A flat design (one 40-option `intent` choice) is also implemented
(`design: "flat"`); on the calibration set it scored 88% against the tree's 90% at the same
latency, so the tree is the default.

### Slot extraction is deterministic

Jev picks the intent; code fills the arguments, and a failed extractor means "ask the brain":

| intent | extractor |
|---|---|
| `pc.open_app` | n-grams of the utterance against the Start-menu list: exact name/alias, then pc-hands `matchApp`, then a one- or two-letter typo match. No installed app but a known web app ("fire up spotify") → `open_url` |
| `pc.open_folder` | exactly one of Downloads/Documents/Desktop/Pictures/Music/Videos named |
| `os_page` | the page's words must be in the utterance (or Jev ≥ 0.9 on the page) |
| `website` | the site's name or a spoken address must be in the utterance; "search / play / find / watch" → brain (it builds search links) |
| `browser.click` | a click verb plus an ordinal or words (`parseTarget`) |
| `browser.search` | "search/look up/find X" not naming a site |
| `screen` | the utterance is the question; `listen` from the noul or "say/said/hear" |
| `skill.*` | the skills pack's own intent parser (timers, reminders, time, maths…) |
| `emails` / `memory` / `workspace` / `hermes` | the utterance itself |

### Thresholds (tiers by risk)

| tier | intents | min confidence |
|---|---|---|
| show | os_page, website, screen, status, emails, memory, workspace | 0.55 |
| act | pc media/volume/open app/folder, browser actions, skills | 0.60 |
| strong | pc.lock, browser.close_tab, routines | 0.85 |
| hermes | control_pc straight from Jev (skips the brain) | 0.75 |

Plus, for every instant action: `outbound` ≤ 0.35, `complete` ≥ 0.4, and `multi` ≤ 0.5 with no
"and then / and type…" in the words (routines, status and screen questions are exempt from the
multi check: they are one request however they're worded).

**Safety.** Before Jev is even asked, `needsConfirmation()` (the control_pc code gate in
`src/lib/jarvis-control.ts`) is run on the utterance; anything it flags goes straight to the brain,
which can only reach it through control_pc, whose gate asks for his spoken yes. Jev's own
`outbound` noul is a second net (it caught "ring Smile Dental for me", which the regex doesn't).
A unit test feeds every outbound benchmark utterance through the decision logic with Jev "lying"
at confidence 1.0 for pc/browser/website/page/routine and asserts none becomes an instant action.

### Cache, prefetch and warm connection

* `DecisionCache` (per freeVoice instance): normalised utterance ("hey jarvis, turn it down a bit
  please" = "turn it down a bit") → Jev's raw answers, 30 min TTL, 256 entries LRU. Extractors
  re-run on a hit, so a new app list or skill still applies. A repeat command costs ~0 ms.
* Partial transcripts (`/voice/free/reflex`) go through the same router, so the final turn for the
  same words is usually a cache hit; show-only calls (page / website) at ≥ 0.9 confidence with a
  complete-sounding request and stakes < 0.2 still run speculatively.
* `JevWarmer`: a cold TypeSafe request took 683 ms, warm ~300 ms, after 60 s idle 463 ms. While
  Jarvis is in use (10 min after the last turn) an unauthenticated `HEAD https://api.typesafe.ai/`
  every 20 s (free; it 404s; no key sent) keeps calls at ~250–300 ms.

## 2. Hermes task plan

`runWarmTask` (scripts/hermes-api.ts) asks Jev, for Jarvis's control_pc brief only, how much
thinking the task needs (`low` / `medium` / `high`) and which toolsets it needs (eight yes/no
nouls). The warm API server honours `model_options.reasoning.effort` per request
(`gateway/platforms/api_server.py::_request_reasoning_config`), so a confident `low` (≥ 0.7) is
sent; otherwise the config default (`agent.reasoning_effort: medium`) stands. The API server does
**not** accept per-request toolsets (it always uses `platform_toolsets.api_server`), so the toolset
plan rides on the `HermesApiUnavailable` error for the CLI fallback (`hermes chat -t`). A toolset
is dropped only when its noul is < 0.2; `terminal` and `file` are always kept.

## 3. Hermes approval guardian

Hermes' smart approvals (`tools/approval_smart.py`) send every flagged command
("script execution via -e/-c flag" covers Jarvis's own `powershell -Command "Start-Process …"`) to
the auxiliary `approval` model and parse one word: `APPROVE`, `DENY`, anything else = escalate.
`auxiliary.approval.base_url` accepts any OpenAI-compatible endpoint
(`agent/auxiliary_client.py::_resolve_task_provider_model`), so the OS serves one:
`POST http://127.0.0.1:8081/__jev/v1/chat/completions` — loopback only, its own bearer token
(`.operator-data/jev-shim.token`, 64 hex, created on first use).

The guardian (stricter than the LLM it replaces):

1. A code list of risky operations (delete, overwrite/redirect, move/copy/rename, kill, services,
   registry, installs, network transfer, encoded/eval'd payloads, git push, scheduled tasks,
   power state…) and risky targets (scripts, installers, .exe from Downloads/Temp) → `ESCALATE`
   without asking Jev.
2. Otherwise four nouls on `{flagged_as, command}`: `harmless` (only opens, launches, reads or
   lists), `destructive`, `outbound`, `manipulation`.
3. `APPROVE` only if harmless ≥ 0.75 and every risk noul ≤ 0.3; else `ESCALATE`. It never says
   `DENY` (escalation keeps a person in the loop), and no key / timeout / unparseable prompt →
   `ESCALATE`. Verdicts are logged without the command text.

Calibration (12 live commands, 24 Sep): benign launches/reads scored harmless 0.82–0.95 with every
risk noul ≤ 0.27; `shutil.rmtree`, exfiltrating `urlopen` and an "approve me" injection scored
harmless ≤ 0.01 and their risk noul ≥ 0.92; three more were stopped by the code list.

The OS's own outbound gate (`needsConfirmation` → spoken yes) is unchanged and runs before Hermes
ever sees a task.

**Hermes config (applied 24 Sep, after tests passed).** `%LOCALAPPDATA%\hermes\config.yaml` gained:

```yaml
auxiliary:
  approval:
    base_url: http://127.0.0.1:8081/__jev/v1
    api_key: <contents of .operator-data/jev-shim.token>
    model: jev-latest
    api_mode: chat_completions
    timeout: 5
```

Backup of the previous file: `%LOCALAPPDATA%\hermes\backups\config.yaml.2026-09-24T01-10-51-121Z.before-jev-guardian`.
To undo, restore that backup (or delete the `auxiliary:` block). Hermes' log confirms the route:
`Auxiliary approval: using custom (jev-latest) at http://127.0.0.1:8081/__jev/v1/`.

Scope and failure mode: the guardian applies to every Hermes surface that uses smart approvals
(Telegram, the API server), not only Jarvis. If Agentic OS isn't running, the call fails and Hermes
escalates, so flagged commands wait for a human (Telegram buttons) or are blocked on unattended
surfaces; nothing is ever auto-approved by a failure.

## How to tune

* Run `bun scripts/jev-bench.ts router --label calib-<date> [--design tree|flat]` (one Jev call
  per case, no brain, ~66 calls) and read each MISS line's `[intent confidence reason]`.
* Raise a tier's threshold if a wrong instant action appears above it; lower it only if the
  misses below it are all right answers and the tier is reversible.
* Add paraphrases to `scripts/jev-bench-cases.ts`; outbound ones are automatically part of the
  safety unit test.
* `bun scripts/jev-bench.ts endpoint --label <name> [--repeat]` measures the live turn endpoint
  (routing only; the endpoint returns tool calls, the browser runs them, so nothing is executed).

## Benchmarks

Results are in `docs/jev-bench/*.json`. Latencies are measured by the benchmark client around
`POST /__operator/voice/free/turn` on this PC.

### Voice routing, 77 labelled utterances (24 Sep)

`before` = the old pipeline (rules → narrow Jev reflex → brain), `after` = rules → skills pack →
Jev router → brain. Accuracy counts a route as right when it is the expected tool (or, for
questions, the brain; for outbound requests, anything except an instant action).

| run | route accuracy | all turns p50 / p95 | outbound → instant action |
|---|---|---|---|
| before (`before.json`) | 55/77 (71%) | 327 / 1,832 ms | 0 |
| router alone, tree (`calib-tree.json`) | 69/77 (90%) | 282 / 424 ms | 0 |
| router alone, flat (`calib-flat.json`) | 68/77 (88%) | 295 / 393 ms | 0 |
| after, first pass (`after.json`) | 74/77 (96%) | 294 / 1,222 ms | 1 (brain chose `open_url` for "book a table at Nando's"; now rerouted to control_pc by `guardToolCall`, re-run `after-outbound.json`: 11/11, 0) |
| after, repeat pass (cache warm) | 70/77 (91%)* | **1** / 1,346 ms | 0 |

\* the 7 misses in the repeat pass are 6 Groq free-tier 429s (the brain's 8k tokens/min, hit by
running 154 turns back to back) and "pull up settings" (see below).

Per path (after, first pass → repeat):

| path | turns | p50 | p95 |
|---|---|---|---|
| rules | 18 → 18 | 1 → 0 ms | 23 → 1 ms |
| Jev router | 38 → — | 287 ms | 724 ms |
| cache | — → 38 | — → 1 ms | — → 4 ms |
| brain | 21 → 15 | 930 → 1,051 ms | 1,361 → 3,129 ms |

Before, per path: rules 14 turns (p50 1 ms), Jev reflex 33 (287 / 397 ms), brain 30
(890 / 2,169 ms). By group, before → after: PC 6/19 → 18/19, browser 10/12 → 12/12,
status/routines 2/4 → 4/4, skills 0/4 → 4/4 (the skills pack's rules), outbound 11/11 → 11/11.

What "right" buys in wall time: 13 of the 19 PC paraphrases ("fire up discord", "turn it down a
bit", "lock the computer") used to go to control_pc, i.e. Hermes. Measured end to end that is
~0.3 s routing + 12–17 s of Hermes (warm) for a job pc_act does in ~0.3 s. Now: ~0.3 s routing
(0.001 s on a repeat) + ~0.3 s pc_act — **~0.6 s instead of ~13–18 s (20–30x), and ~0.3 s
instead of ~13–18 s (40–60x) for a repeated command.**

Remaining misses: "pull up settings" is taken by the older `pcIntent` rule as the Windows
Settings app (genuinely ambiguous; the rule runs before the router). "boot up vs code": Jev is
unsure (0.48, below the 0.6 act threshold), so the brain decides (it got it right once in two).
"I need WhatsApp up" reaches the brain because the code gate matches the word WhatsApp; the brain
opened the app correctly.

Trade-off: outbound requests no longer take the old reflex's direct control_pc shortcut
(~0.3 s); they go to the brain (~1 s p50) so an email becomes a draft rather than a Hermes task.
The gate itself is unchanged.

### Hermes "open Notepad" (warm API server, `runWarmTask`, Notepad closed afterwards)

| configuration | runs |
|---|---|
| before: reasoning `medium`, gpt-6-sol guardian | 41.5 s (first run: new terminal environment, 20 s), 17.5 s |
| + Jev plan (`low` effort) | 12.0 s, 13.1 s, 12.3 s |
| + Jev guardian (`/__jev`) | 12.3 s, 12.7 s, 7.5 s |

Step timings from Hermes' log: the approval + launch step went from 2.5–2.9 s (gpt-6-sol) to
0.96–1.66 s (Jev, including the launch itself); the first model call from 4.8–6.9 s to 2.1–5.0 s at
`low`. What remains is three gpt-6-sol round trips, one of them a `skill_view` Hermes makes despite
the brief telling it not to. With the router, plain "open X" requests don't reach Hermes at all.

## Round 2 (24 Sep, afternoon): faster Hermes, first audio, warm paths

### control_pc and Hermes

| "open Notepad" | before | after |
|---|---|---|
| control_pc route (`/__operator/hermes/task`) | 9.7–12.0 s (Hermes) | **7–624 ms**: a launch pc-hands can do alone skips Hermes (`directLaunch` in jev-hermes.ts: Jarvis's brief only, pcIntent's anchored grammar, never outbound, never remote; a failed launch still goes to Hermes) |
| Hermes itself, warm | 9.7–12.0 s, 3 model calls (`skill_view jarvis-capabilities` first) | 6.3–8.7 s, 2 model calls |

The `skill_view` came from Hermes' SOUL.md ("before choosing a tool … read the jarvis-capabilities
skill"); a line in the task prompt did not override it. SOUL.md now exempts a single Start-Process
launch (backup: `%LOCALAPPDATA%\hermes\backups\SOUL.md.2026-09-24T03-04-48Z.before-jev-fastlane`).
What remains in a Hermes turn is ~0.5–1 s of per-request agent construction plus two gpt-6-sol
calls (2–4 s each). Tried and dropped: reasoning `minimal` (no gain), `fast: true` / priority tier
(no gain; one 180 s terminal hang), per-request DeepSeek (no credentials: the configured DeepSeek
fallback has no key). The API server can't take per-request toolsets or skills.

### First audio on brain answers (5 questions, `scripts/voice-latency-bench.ts`)

The client waited for the whole brain reply, then synthesised the first speech chunk (up to 280
characters) as one clip. Now the first sentence streams from ElevenLabs (`/voice/free/tts-stream`,
raw PCM) and plays in ~120 ms blocks as it arrives; the rest is fetched meanwhile.

| | median first audio |
|---|---|
| before (turn + whole first chunk), run 1 | 1,928 ms |
| before, same session as the after run | 1,381 ms |
| after (turn + first 120 ms of streamed audio) | **1,004–1,009 ms** |

The speech step alone: whole clip 430–1,370 ms → streamed 254–475 ms (median ~290 ms). The brain
itself is 0.5–0.9 s including Jev; general questions now start the brain at the same time as the
Jev router (aborted if Jev acts), worth ~50–150 ms in a noisy measurement. Streaming the brain's
text was not done: replies are short and Groq finishes them within ~0.1 s of the first sentence.

### Warm paths

| connection | cold / idle | kept warm |
|---|---|---|
| TypeSafe | 683 ms cold, 463 ms after 60 s idle | ~250–300 ms |
| Groq | 344 ms after 60 s idle | 219 ms |
| ElevenLabs | 618 ms first request | ~250 ms |
| Hermes (first task after 20 min idle) | 3.5 s first model call, 8.0 s overall | 2.4 s, 6.1 s |

Opening the voice panel calls `/voice/free/warm`: free unauthenticated HEADs to TypeSafe, Groq and
the chosen voice's host (repeated every 20 s for 10 minutes after the last turn) and one tiny
low-effort Hermes turn (1 model call, ~2.2 s, at most every 5 minutes; a real task counts).

### Routing, re-run (`round2-before.json` → `round2-after.json`)

75/77 → **77/77**, 0 outbound cases turned instant, all-turn p50 268–309 ms. Fixed: "I need
WhatsApp up" (the code gate matched the app's name; now a pure launch of the app may pass while
anything else outbound still can't). "Pull up settings" is genuinely ambiguous: the rule opens
Windows Settings and "OS/Jarvis settings" opens the page (43556e2); the case now accepts both.
## 4. Jev as a fuzzy verifier only (27 Sep, P1)

`scripts/screen-hands/fuzzy-verify.ts` adds jarvis-deep-research.md judgment #4, "did it visibly
succeed?", with the limits in code rather than in a prompt:

- **Only when no deterministic check exists.** A file hash, a read-back field value, a DOM value or a
  Calculator display is always checked by code; `fuzzyEligible(intent, true)` refuses to ask Jev.
- **Never for Jev's weak spots.** Goals that hinge on numbers, counting, dates or times (any digit,
  "how many", "total", weekdays, months, "tomorrow", "o'clock"…) are not asked; they stay unverified.
- **Never private text.** Jev sees the intent, the app name and role + label lines of what changed
  between two UIA snapshots. Values are never sent; secure fields, anything `sensitiveText` flags,
  emails and 4+ digit runs are withheld (counted, not shown).
- **Never adversarial text.** If any changed label reads as instructions to an assistant (`INJECTION`),
  Jev isn't asked at all.
- **Never a gate, and it can only lift.** One `noul` (`succeeded`); ≥ 0.75 → the verifier `passed`
  (fuzzy); anything else, no key, a timeout or an error → `inconclusive`, reported as `unverified`. It
  never returns `failed`, never approves or blocks an action, and the audit keeps only
  `jevConfidence`, never the diff.

Tests: `scripts/screen-hands/p1-exec.test.ts` (thresholds, withheld values, injection, and the
notepad-list replay: an unchanged before/after stays unverified even when Jev says 0.99). No live Jev
calls were made for this change; the calibration sample was not run (no key in the test environment).
