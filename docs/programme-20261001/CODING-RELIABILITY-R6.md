# Coding workspace reliability, round 6 (2 Oct 2026, Builder B)

Model that did this work: `claude-sonnet-5-5`. Branch `r6/coding-20261002` (worktree `D:/AgenticOS-r6-coding`, from `228bd232`). Nothing merged, deployed or messaged. The live hub (8081) and its real job history were not touched; the five historical jobs are as they were.

## How it was exercised

* **Synthetic**: temp git repos, fake Claude and Codex processes that speak the real wire protocols, a real approvals service. Files: `scripts/coding/reliability-r6.test.ts`, `reliability-r6-plan.test.ts`, `reliability-r6-limit.test.tsx`, `reliability-r6-ui.test.tsx`, `claude-accounts.test.ts` (item 8 block), shared world `r6-world.ts`. The existing `orchestrator.test.ts`, `claude-accounts.test.ts`, `routes.test.ts` and `voice-f4.test.ts` already covered much of the list and are cited where they carry an item.
* **Real harness (live-provider)**: my own hub, the full OS (`vite dev`) from this worktree on `127.0.0.1:8152`, `MU_HUB_ROLE=cloud`, fresh `MU_DATA_DIR=D:/prog-scratch/r6-coding/hub-data`, `CODING_REGISTRY_DEFAULTS=off`, `CODING_JEV=off` (new knob: no hosted decision call), `CODING_PLANNER=off`, memory writes off. One throwaway repo, `D:/prog-scratch/r6-coding/repos/r6-app`, one bun test. Driven through the Browser pane as a real signed-in session of that hub (the hub's first navigation on fresh data is trusted, as in earlier rounds). The account pool is the two Claude slots (`claude:max`, `claude:max-2`) read through that hub's own accounts route; no Codex (isolation not applied, `--apply` not run), no paid API route. Three small real jobs, all on the exact ids `claude-sonnet-5-5` (builder) and `claude-opus-5-5` (reviewer). **`claude:max` was at its weekly limit (100%, resets Mon 5 Oct 1:00 pm)**: used as test material for item 8, not worked around. The hub was stopped at the end; I started and stopped only that hub's process tree.

Real job ids: `e27b1120` (full run), `42f130ec` (blocked at once, superseded and unmarked), `1670d03b` (failing test and repair).

## The 14 items

Test names are in the files above. "Synthetic" = fakes. "Live-provider" = real Claude CLI through the real harness on the 8152 hub.

| # | Item | Automated proof | Real run | Label |
|---|---|---|---|---|
| 1 | Typed request gives a clear, editable plan | `reliability-r6-plan` "a typed request becomes a plan the person can edit"; `reliability-r6-ui` "the drafted plan can be edited"; planPatch unit cases | Typed in the page, plan drafted by the harness, objective / done-when / non-goals edited and saved as revision 2: job `e27b1120` | synthetic + live-provider (plan drafted by the rules, planner off) |
| 2 | Jarvis request enters the same job system | `reliability-r6-plan` "a spoken request is a job in the same store, in the same state, listed by the same route"; `voice-f4.test.ts` (one job driven only by voice) | not run live (spoken audio is all synthetic) | synthetic |
| 3 | Plan edit voids old approvals and late shaping | `reliability-r6-plan`: old digest refused after an edit (409), the spoken yes read out before an edit starts nothing, a re-draft closes the person's older unstarted draft, a program never closes anything, no check can be removed | edit then Start in the page; the earlier draft survived a page reload (not closed: the page forgets it) | synthetic (UI half: the page cancels a late result for changed words; no DOM test, see below) |
| 4 | Starting once creates one execution | `reliability-r6` "a double click, a retry and a reconnect start one builder and one reviewer"; route `once` replay and orchestrator idempotence (existing) | double click on Start in the page: one builder run (`e27b1120`) | synthetic + live-provider |
| 5 | Model and account match what was asked; unavailable never substituted | `reliability-r6` item 5 (Gemini, GPT-4, Sonnet 4.5, Opus 4 refused in words; real words still draft); `claude-accounts` named-account cases | "Sonnet builds and Opus reviews. Use Claude Max 2." drafted exactly that (`1670d03b`); the draft card has per-role account and model pickers | synthetic + live-provider |
| 6 | Receipts record the model that responded | `reliability-r6` "a builder asked for Opus whose CLI reports Sonnet" and "a role re-run as a new run reads its own receipts"; `reliability-r6-limit` receipt cases | `e27b1120`: 5 receipts, each with requested model, reported model, account and outcome (builder `claude-sonnet-5-5` answered on `claude:max-2`; reviewer `claude-opus-5-5`; two `rate_limited` receipts on `claude:max`) | synthetic + live-provider |
| 7 | Review and tests run against the correct revision | `orchestrator.test.ts` "review repair" (5 cases, new commit gets fresh tests and review); `reliability-r6` "a repair pass that changes nothing ... not repeated" | `e27b1120`: tests, review and gate all at `7c28338`; `1670d03b`: repair turn with no new commit is refused, no second test or review at the same commit | synthetic + live-provider |
| 8 | Unavailable or exhausted reviewer: recovery, fallbacks without repeats | `claude-accounts` item 8 block (signed-out reviewer: Resume on another account, authorised fallback moves it, exhausted chain stays with the owner; the full-account step is recorded); `reliability-r6-limit` (exhausted account never re-offered, limit sentence, button names the new account); existing fallback tests | `e27b1120`: builder hit the weekly limit, moved to Max 2; reviewer then hit it, moved to Max 2 (Opus), job completed, build and tests not repeated | synthetic + live-provider |
| 9 | Approval resumes the right step; cancel stops every later step | `reliability-r6` item 9 (stop during a check, during the baseline, during the review); `orchestrator.test.ts` merge approval and escalated-input cases | not run live | synthetic |
| 10 | Restart keeps accurate status | `reliability-r6` "running its tests when the hub died reads interrupted"; `orchestrator.test.ts` restart case | hub killed while the builder ran: the store read `building` and a `running` run before restart; after restart `interrupted`, no live role, page said "Interrupted: nothing was replayed"; Resume continued the same session (`e27b1120`) | synthetic + live-provider |
| 11 | Scope violations name the files | `reliability-r6` / `reliability-r6-ui` ownership cases (six long paths, every one whole); spoken line names three and counts the rest | the policy refuses unowned edits, so a real violation could not be forced | synthetic |
| 12 | Failing test name and assertion; output folded | `reliability-r6` item 12 (parser, job view, rows); `reliability-r6-ui` FailedTests; blocker sentence cases | `1670d03b`: "greeting says hello: expect(received).toBe(expected) · Expected: "hello" · Received: "hello world"" on the page, full output behind "Show the full output" | synthetic + live-provider |
| 13 | Superseded jobs keep history, can't be applied; Mark and Unmark | `orchestrator.test.ts` supersede block, `supersede-ui.test.tsx` (existing) | `42f130ec`: Mark superseded (ref `main`), resume, apply and test re-run refused (409 with the reason), history kept; Unmark took the mark back (job stays stopped, as designed) | synthetic + live-provider |
| 14 | Blocker explanations: what, why, one action | `reliability-r6` item 14 (seven stop kinds), `reliability-r6-limit` (limit, transient auth, failing test) | read on the real page for the limit, the transient failure, the failing test, the no-op repair and the interrupted job | synthetic + live-provider |

## Defects found and fixed

Found by probing the synthetic world first:

1. **A stop did not stop the later checks.** `runTests` ran every remaining check after the owner stopped the job. Fixed (checks, the baseline, and any role still queued behind a wave).
2. **Ownership stops lost their files.** The blocker kept only a cut sentence ("changed files it doesn't own."), the spoken line cut at 160 characters. Both now name every file.
3. **"The job stopped. Open it to see what needs attention."** was the answer for a merge conflict between builders, a change outside the worktrees, an unexpected fault, a merge that did not happen, and one stopped role. `stoppedBecause` is recorded where the job stops and each now says what, why and the one action.
4. **Failing tests had names only.** Bun's assertion is now parsed (`TestResult.failures`) and shown; the full output stays folded.
5. **A model nobody can run was silently replaced** ("Gemini builds" became Codex, "Sonnet 4.5 builds" became Opus). Refused in words in the shaper (typed, spoken, voice edit).
6. **No editable plan; stale drafts stayed startable.** New `POST /coding/jobs/:id/plan` (objective, done-when words, extra checks, non-goals; never removes a check); `replaces` closes the person's older unstarted draft.
7. **A signed-out account was outside the authorised fallback chain.** Now covered; nothing already done is repeated.

Found by the real runs on 8152:

8. **The page offered other models on the account that had just hit its weekly limit** (the usage reading was unknown). The limit is the account's; it is now recorded ("Account at its limit: slot", with the reset) and the move choices exclude it until the reset.
9. **The limit sentence** showed an ISO time and "..", and the next button said only "Resume". Now "can't run: ... resetting Mon, 5 Oct, 1:00 pm. Move this step to another connected account, or Resume after the reset." and "Retry review on Claude Max 2".
10. **A lost sign-in refresh** ("another Claude Code process is refreshing it") was shown as "Claude did not complete this turn". The cause is kept.
11. **Receipts were matched by role and turn only.** A role re-run as a new run reused turn numbers, so one run read another's model, account and outcome, and the gate's "every run has a receipt" could pass for a run with none. Receipts now carry `coding.runId`; the model list, the page rows and `unreceiptedRuns` match by run (older receipts keep the old match).
12. **A repair pass that committed nothing** was marked succeeded, re-tested and re-reviewed the same commit (a wasted review). It now fails with "made no new commit when asked to fix the review findings".
13. **"Leave src/x.test.ts alone"** left that file owned. It is now a non-goal.
14. **The review-changes blocker did not say which test failed.** It does, with the assertion.
15. **Page**: the account selector hid when only one Claude account was configured, so no model could be chosen; the model picker now shows whenever a Claude role exists.

## Not achieved, and why

* **Planner and Jev not exercised live.** The real typed request used the shaper's own rules (`CODING_PLANNER=off`, `CODING_JEV=off`) to avoid a hosted decision call and one more Claude turn. The planner-drafted plan path is covered by the existing tests only.
* **Item 2 is synthetic only**: no spoken audio; the voice path is the same shaper and orchestrator, tested with the voice rules.
* **Item 3, late results**: the server side (`replaces`, stale digest, stale spoken yes) is tested. The page's own "cancel a late result for changed words" is a few lines in `coding-list.tsx` with no DOM test. The draft that existed before a page reload is not known to the new page and stays startable (it is listed as waiting for you).
* **Items 9 and 11 were not run live**: the policy refuses unowned edits, so a real scope violation cannot be provoked; the approval and cancel paths were not worth a real job.
* **Handoff to memory** skipped (writes off on the test hub).
* **Codex** not exercised (isolation `--apply` is the owner's).
* Human-only gates are unchanged: Start, Resume, Apply, supersede and the new plan edit all require a signed-in browser session; a program can still only draft. On my hub the signed-in session was that hub's own first-navigation session.

## Independent review follow-up (same day)

Seven accepted findings, each with a test (`reliability-r6.test.ts` item 7 / item 10 / finding 6, `reliability-r6-plan.test.ts` findings 3 and 4, `claude-accounts.test.ts` finding 5). No further real job was needed.

1. A repair pass with no commit is recorded (`stoppedBecause: repair_no_change`) and its run counts as done, so the next Resume goes back through the repair branch with the review findings (previously it took the plain build branch with the original prompt). The test now runs past the second Resume to a fresh commit, test and review.
2. Success of a repair pass is "at least one writer committed", not one per writer: a writer with nothing to fix no longer fails the job or hides another writer's fix.
3. "Leave" is read clause by clause and applies to files, folders and absolute paths ("Fix src/a.ts but leave src/a.test.ts alone" now plans).
4. Codex models (`gpt-5.5`, `gpt-5.6-sol`...) are never refused and now bind to that model; a foreign name counts only as the subject of a role verb or after use/have/let/ask, so "the Gemini review summary" and "the cursor fix" are not model requests.
5. A signed-out role moves by account entry only (never to another model or Codex), says when the target can draw paid credits, and only that role is re-run (a second stopped writer stays stopped, and nothing integrates or reviews behind it). A Codex entry prefers a no-credits account.
6. A limit with no reset time holds the account 5 hours, not forever, and says the time is unknown; editing the objective rewords the reviewer line written from it; the failed-merge button reads "Re-check the job, then ask for the merge again". The "only gets stricter" wording is gone: rewording is the person's call.
7. The restart test builds a new orchestrator over the reopened store and proves nothing runs and the view reads interrupted.

Not run against the pre-fix code: the new tests were written from the reviewer's reproductions and pass on the fixed code.

## Checks

`bun test scripts/coding`: 716 pass, 0 fail (636 before this round, 697 before the review fixes). `bun run typecheck`, `bun run typecheck:scripts` and `bun run build` pass. The full suite was not run, as instructed.

## Commits

`b467d199`, `654d9166`, `2d3df79e`, `a863a9d4`, `3d30475c`, `fefa45e7`, `2408e752` on `r6/coding-20261002`, plus the commit that adds this file.
