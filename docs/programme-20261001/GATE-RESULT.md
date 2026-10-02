# Release gate: round 6b candidate `2d998a85` (2 Oct 2026)

| Check | Result |
|---|---|
| `bun test scripts` (full, run alone) | **11,804 pass · 13 skip · 0 fail** (11,817 tests, 654 files, 1,299 s) |
| `bun test src` | 24 pass · 0 fail |
| `typecheck` / `typecheck:scripts` / `build` | pass / pass / pass |

**Adds since live `d771c80`:** creative page served at `/mu-creative-20261001` and `/…/` (public directory index, never over an app route; dead `public/transitions/` removed); explicit stored website-check outcome on every lead (migration adds one column, backfills `found` for leads with a website, repairs on every open, changes no existing value); old "no website" claims no longer reach call openers; Find leads show honest website states; reusable gate seed (`scripts/acceptance/seed-gate-hub.ts`, refuses real data through junctions and short names); host-key failures shown as a distinct refusal; tokens stripped from job labels; narrower hand-back fallback; Activity and Computers fixes.

**Reviews (Opus 5.5):** creative URL + Find (2 defects, fixed), website-check migration (safe on the live database; 6 follow-ups, fixed), seed + computers (4 findings incl. 2 safety gaps, fixed). Receptionist `r6/launch-20261002` at `d8a6d15`: two reviews, all findings fixed, not merged, NOT SAFE TO SELL.

**Evidence labels:** concurrent website checks — real browser, stubbed search to force ordering; real Find — two live Overpass queries + local SearXNG on an isolated hub (2 leads added, a second run added 0 and kept a manual correction); Activity and Computers — real clicks; Create/viewer/takeover/Stop on this PC's WSL (real local computer) because Ryzen-PC did not answer ping or SSH all round.

# Release gate: round 6 candidate `eac77968` (2 Oct 2026)

**Full suite ran on `4faaa875`.** After it: one stale test assertion corrected (`cc4a6262`), then two reviewed fixes from the rendered check (`b37d8684`, merged as `eac77968`): a confirm step for Do not contact in the lead edit form, and a Promotional films link on Studio. Those were re-checked with focused tests, both typechecks and the build, not a second full run.

| Check | Result |
|---|---|
| `bun test scripts` (full, run alone, on `4faaa875`) | **11,761 pass · 13 skip · 2 fail** (11,776 tests, 651 files, 1,255 s) |
| The 2 failures | `events/thread-client.test.ts` expected the old label "Research result" (the label is "Result" since four workflows post results): assertion corrected, file 8/0. `memory/j5-secrets.test.ts` 100 ms timing bound at 200 KB: fails only under full-suite load, 3 of 3 alone, no code change |
| `bun test src` | 20 pass · 0 fail |
| `typecheck` / `typecheck:scripts` / `build` on `4faaa875` and again on `eac77968` | pass / pass / pass |
| Focused re-run on `eac77968` (leads, r6-ui, r6 behaviour, events, j5-secrets, src) | 642 pass · 0 fail (55 files) |
| Clean copy of `cc4a6262` (`git archive`) → frozen install (584 packages) → both typechecks → build | all exit 0; no `.operator-data`, no `.env*` |
| Browser vs running candidate `cc4a626` (PC role, isolated synthetic data, port 8141) | 38 of 40 route loads pass at 1440 and 390 (h1, no error boundary, no overflow, no console errors, no failed requests). The 2 failures are `/mu-creative-20261001/` (404; same on the previous live build); `/mu-creative-20261001/index.html` passes and its videos play |
| Leads journeys at 1440, 768, 390 | search (multiword, three phone formats, `#ID`), short numbers not matching phones, filters and Clear all, Back closes the drawer, edit persists after refresh, draft restore, Call-tab Do not contact needs a separate Confirm, three distinct website states, `?view=today`, `?lead=abc` opens nothing |
| Not observable on the gate seed | Activity "Open job" (no jobs seeded), Computers Create (no host on the test hub), the daily brief body |

## What it adds since live `228bd23`

| Track | Branch | Independent review (Opus 5.5) |
|---|---|---|
| Coding reliability (14 behaviours, 3 real jobs on a throwaway repo) | `r6/coding-20261002` | no gate bypass; 5 should-fix + minors, all fixed |
| Performance, search availability, health, resilience, disk report | `r6/perf-20261002` | fix-before-merge: restart test did not test a restart, poll could hang, stale brief unlabelled, false verified-none; all fixed |
| Bot workflows (Research, Builder, Website audit, Business preparation) and conversation continuity | `r6/bots-20261002` | no blockers; audit allow-list escape, builder preview bypass, research completeness fallback; all fixed |
| Interface cleanup and control inventory (868 listed, 679 clicked, 14 broken and fixed) | `r6/ui-20261002` | no blockers; draft restore could overwrite newer changes, short digits matched phones, Do not contact confirm; all fixed |
| Dot's Leads improvements (package SHA-256 b2f6379a…835893d, exact patch `17ddd0a2`) | `r6/dot-leads-20261002`, reconciled in the ui and perf branches | reviewed as part of the combined Leads review |
| Films: two rendered with Scotty narration | lead, on integration | not reviewed by ear; owner watch-through owed |

Receptionist `r6/launch-20261002` (`1d74a4b`, 2,061 tests, 50/50 evals, reviewed, findings fixed) is on its own repository and is **not merged and NOT SAFE TO SELL**.

## Evidence labels

| Area | Label |
|---|---|
| Bot workflows, takeover, Stop, tunnel drop, hub restart | real LAN host (Ryzen-PC) through a separate test hub; not from the live OS |
| Coding | 3 live-provider jobs on a throwaway repo (claude:max-2); the rest synthetic |
| Leads | synthetic data, real browser clicks on a test hub; concurrent website checks unit-tested only; no real Find search |
| Performance | builder's own dev-mode hub |
| Films | local assembly; frames, loudness and transcription checked; not listened to |

# Release gate: round 5 final candidate `ce0e5bb2` (2 Oct 2026, ~04:20 AEST)

**Tested commit:** `ce0e5bb2a11b9667395e869849c5da60f0d1d34e`. This is `af42a9b9` (gate below) plus the Computers page "Add a shared computer" control and the gate record.

| Check | Result |
|---|---|
| `bun test scripts` (full, run alone) | **11,492 pass · 13 skip · 0 fail** (11,505 tests, 631 files, 794 s) |
| `bun test src` | 20 pass · 0 fail |
| `bun run typecheck` / `typecheck:scripts` / `build` | pass / pass / pass |

The clean frozen-copy build and the 27-load rendered check were run on `af42a9b9`. The Computers control was rendered separately at 1440 and 390 on a test hub.

# Release gate: round 5 candidate `af42a9b9` (2 Oct 2026, ~03:30 AEST)

**Tested commit:** `af42a9b9c82b55529b8aca4e5f30d8cddcdbe127` on `r5/integration-20261002`, clean tree. Later commits are docs only.

**What it adds since live `af45e77`:**
- Track A: Ryzen-PC LAN bot host.
- Track B: Jarvis conversation loop.
- Track C: interface audit and Coding "Mark superseded".
- Track D: memory acceptance and guard.
- Track F: creative prep and adoption reconciliation.
- Lead: the leads test clock fix.

| Check | Result |
|---|---|
| `bun test scripts` (full, run alone) | **11,492 pass · 13 skip · 0 fail** (11,505 tests, 631 files, 790 s) |
| `bun test src` | 10 pass · 0 fail |
| `bun run typecheck` / `typecheck:scripts` | pass / pass |
| `bun run build` | pass |
| Clean copy (`git archive`) → frozen install → both typechecks → build | all pass |
| Browser vs running candidate (PC role, isolated seeded data, port 8141) | 20 routes at 1280 and 7 at 390: h1 present, no crash, no overflow |

**Preliminary run** at `56384f3d`: 11,035 pass, 2 fail. Both failures were a date time-bomb in two leads tests, which hard-coded 1 Oct 2026 as a future date. Fixed in `cc84a9b8`.

## Independent reviews (Opus 5.5), all findings fixed before this gate

| Review | Result |
|---|---|
| LAN adapter | 0 blockers, 7 should-fix |
| LAN real-host changes | 0 code blockers, 7 should-fix, plus wording and evidence corrections |
| Conversation loop | 0 blockers, 9 fixed |
| Interface + supersede | 0 blockers, 9 fixed |
| Memory guard, pass 1 | **2 blockers** (about 80 base-blocked secrets passed) |
| Memory guard, pass 2 | **still looser** (32 strings) |

**Memory guard outcome:** the builder rebuilt the guard from base under a monotone rule. The lead re-ran the reviewer's 314-string probe against it:
- 5 base-blocked strings pass. All are the accepted short lowercase glued-value shape (`?token=abcdefg`).
- 36 strings are newly blocked.
- 204 strings are blocked on both.

## Evidence labels

| Area | Label |
|---|---|
| Ryzen-PC bot computers | real LAN host (Ryzen-PC WSL), on a separate test hub. See LAN-BOT-HOST-EVIDENCE.md |
| Conversation loop | synthetic, plus the builder's own hub with a synthetic computer; rendered at 1440 and 390 |
| Memory acceptance | real Hindsight engine, disposable bank (deleted); 31 of 31 |
| Receptionist | synthetic (local Postgres): 1,991 tests, 50 of 50 evals |
| Creative | local free render of graphics tracks; no paid generation |

# Release gate: round 4 candidate `460cb7a` (1 Oct 2026, ~18:10 AEST)

**Tested commit:** `460cb7a80eb1efb4ec2871c561b8d33fc864e2df` on `r4/integration-20261001`, clean tree. Later commits are docs only.

**What it adds since live `2a1310c`:** five Sonnet 5.5 builder branches plus their fixes from two independent Opus 5.5 reviews:
- coding jobs (shaper free/paid routes, paths and reviewer independence; finance dates);
- coding UI and gate (job glance, reassign on Resume, baseline-aware gate, typed paid notice);
- memory URL screen;
- cloud activation pack;
- bot-computer scrolling and research.

| Check | Result |
|---|---|
| `bun test scripts` (full, run alone) | **10,656 pass · 13 skip · 0 fail** (10,669 tests, 621 files, 1,020 s) |
| `bun test src` | 10 pass · 0 fail |
| `bun run typecheck` | pass |
| `bun run typecheck:scripts` | pass (0 errors) |
| `bun run build` | pass |
| Clean copy (`git archive`, no .operator-data/.env) → frozen install → both typechecks → build | all pass |
| Browser vs running candidate (PC role, isolated seeded data, port 8141) | 16 routes at 1280 render their h1, no crash, no overflow; 5 routes at 390 are the same; `/__health` ok, gitSha 460cb7a, dirty false |

## Reviews

**Review 1 (Opus) on the first four branches.**
- 2 blockers:
  - typed paid route had no disclosure, and free phrases landed on paid;
  - reviewer independence was checked against the spec binding rather than the run binding.
- 6 should-fix items, all fixed.

**Review 2 (Opus) on bot computers and the follow-ups.**
- 0 blockers.
- 9 should-fix items, all fixed:
  - `page.text` URL re-check against redirect to metadata, private or tailnet addresses;
  - takeover boundary at every step;
  - deadline and a 40-model-call cap;
  - delivery only to the asker's conversation;
  - injection filtering of web text;
  - non-modal dialog scroll;
  - more free→paid phrasings;
  - more credential strings;
  - restore-data.sh rollback state.

## Evidence labels

| Area | Label |
|---|---|
| Scroll | real local WSL Chromium. 96/96 (old code 61/96) on fixtures and public sites, then 60/60 on fixtures after the fixes |
| Research | real local WSL computer, public web. 6/8 complete; 2 sites block automated browsers. About US$0.0007 for 8 goals |
| Restore rehearsal | real local hub (disposable data) |
| Coding and gate behaviour | synthetic: disposable repos and fake model processes |
| Receptionist A$1,373.90 | synthetic test in the candidate repo |

# Release gate: combined candidate `a9407aa` (1 Oct 2026, ~06:10 AEST)

Tested commit: **`a9407aad9615cf0588773697d20688063d3e94e4`** on `prog/integration-20261001` (clean tree). Commits after it are docs only.

| Check | Result |
|---|---|
| `bun test scripts` (full suite) | **10,146 pass · 13 skip · 0 fail** (10,159 tests, 591 files, 833 s) |
| `bun run typecheck` (src/) | pass |
| `bun run typecheck:scripts` (scripts/, companion/, deploy/; @types/bun 1.4.2, ES2023) | 15 errors, **all pre-existing**: identical set on `bc4678a` under the same settings, **0 new** |
| `bun run build` | pass |
| Clean copy (`git archive a9407aa`, no .operator-data/.env) → `bun install --frozen-lockfile` → typecheck → build | all pass (584 packages) |
| Browser check vs running server (candidate, PC role, isolated empty data dir) | 15 main routes (Home, Work, Leads, Coding, Jarvis, Memory, Receptionist, Finance, Studio, Models, System, Settings, Computers, Inbox, Calendar) render their h1; no error boundary; no horizontal overflow at 1280; no failed requests on a fresh load; `/__health` ok, `hubRole: pc`, gitSha a9407aa |
| Outcome acceptance (`scripts/acceptance/run.ts`, run at 921d66f; code unchanged since) | 8 pass · 3 partial · 0 fail · 1 owed (ACCEPTANCE-RESULTS.md) |
| Recovery (full OS, hard kills) | worker kill → job unknown, no replay; hub kill → job unknown "not re-run" after restart (RECOVERY-EVIDENCE.md) |

Fixed during the gate (all before a9407aa): jobs:nudge could throw inside runJarvisCommand (31 tests), version test default-param bug, synthetic companion observe crash (type-check find), acceptance task 3 overstated PASS → PARTIAL (unobserved property rule).

Known flake (pre-existing, not changed): `scripts/j2/page-safety.test.ts` F2 50 ms timing fails only under full-suite load; passes 3/3 alone.

Not live: the everyday OS on 127.0.0.1:8081 still serves `bc4678a` (canonical `jarvis-voice`). A fast-forward to a9407aa is possible (76 commits; no overlap with the owner's 11 dirty/untracked entries, hashes verified unchanged).

# Release gate: round 3 candidate `8237181` (1 Oct 2026, ~14:15 AEST)

Tested commit: **`823718136081053611f09c5f5c72320ff7cb0ea6`** (clean tree). Contents since the live `e586622`: Tracks A–E round 3 (+3b), the round-3 independent review fixes, the lead's secret-format and test-isolation fixes.

| Check | Result |
|---|---|
| `bun test scripts` (full, run alone) | **10,297 pass · 13 skip · 0 fail** (10,310 tests, 603 files). The first run at cf556fe had 12 order-dependent failures (page-context dispatch under a leftover global DOM) — fixed in 8237181 |
| `bun run typecheck` | pass |
| `bun run typecheck:scripts` | **pass (0 errors; was 15 pre-existing)** |
| `bun run build` | pass |
| Clean copy (`git archive`, no .operator-data/.env) → frozen install → both typechecks → build | all pass |
| Browser vs running server (PC role, isolated data) | 16 routes at 1280 + 8 at 390: h1 present, no crash, no overflow, main opacity 1 (legible without animation frames), skip link present |
| Outcome acceptance (real PC, real companion, PowerPoint) | 8 pass · 3 partial · 0 fail · 1 owed (unchanged; partials need real desktop restart evidence in the harness, Mehroz's PC, the mic) |
| Real desktops (Tracks A/C, WSL on D:) | two concurrent isolated desktops, viewer, holder-only input, takeover/return, stop, cookie isolation; capacity measured: 2 comfortable, 3 headroom, 4 at the PC's limit |
| Independent review | 7 confirmed findings fixed with failing-first regression tests; lead added credential-URL/secret-key formats |

# Release gate: add-on candidate `2120168` (1 Oct 2026, ~16:00 AEST)

Tested commit **`21201689ede592a86890f110846c05f878696ecc`** (clean). Adds since live 885f309: Open Dot add-ons (voice→job threads, live activity stream, agent workspaces, triggers/routines), engineering guidance for coding roles, context-mode opt-in pilot, the Open Dot independent-review fixes, and the Codex coding Resume repair.

| Check | Result |
|---|---|
| Full suite (alone) | **10,456 pass · 13 skip · 0 fail** (10,469 tests, 612 files). Earlier runs on this branch caught and fixed: page-context/ui-round2 order-dependent failures |
| typecheck / typecheck:scripts | pass / pass (0 errors) |
| build | pass |
| Clean copy (git archive, frozen install, both typechecks, build) | pass; no private files |
| Browser vs running server (PC role, isolated data) | 16 routes at 1280 + 5 at 390: h1, no crash, no overflow, opacity 1; Automations shows the triggers panel; the page opens the authenticated `/__events` stream |
| Independent review | 6 confirmed findings fixed with failing-first tests (owned conversations, person-scoped stream, follow-up false positives, ctx_index files-only, context data cleanup, masking/loop-guard); morning summary + QA-flag trigger seeded paused |
| Not included | OpenShell pilot (branch prog/os-openshell-20261001, not wired) |
