# Cloud-to-OS reconciliation checklist (Dot's historical work vs current AgenticOS)

Basis: D:\AgenticOS-crm at HEAD 64e182aa (branch crm/integration-20261003), read-only. Historical branches fetched into refs/dot/hist/*. Handoff and source-inventory.json read from refs/dot/pr2. Nothing was run, checked out, merged or edited. No .env, logs or databases were read.

Evidence tags: **[S]** = read in source at the cited place; **[I]** = inferred from path, hash comparison or absence of a search hit.

Method note [S]: for every changed path in the ten branches I compared the cloud blob with the current HEAD blob. Where both differed I ran a three-way merge against the historical-main blob (3a8d304). This shows whether the cloud change is already contained in HEAD, absent, or in conflict. It identifies where to look. It is not proof of behaviour.

## 1. Summary of the 32 absent paths

| Class | Count | Paths |
|---|---|---|
| ALREADY LIVE | 0 | none of the 32 exists at its old location or has a drop-in equivalent |
| SUPERSEDED | 4 | browser-task.ts, task-intents.ts, task-brain.ts, typed.ts |
| WORTH INTEGRATING (narrow) | 5 | flows/when.ts, flows/parse.ts, lead-resolve.ts, f1/email-calendar.test.ts, f1/leads-voice.test.ts |
| CONFLICTING/INCOMPLETE | 3 | flows/service.ts, flows/live.ts, flows/store.ts |
| ARCHIVE ONLY | 20 | all 14 desk-payments files, desk-payment-card.tsx, desk-money.ts, j2/desk-handoff.test.ts, plus j2 test scaffolding (fake-web.ts, task-fixtures.ts, browser-task.test.ts) |
| **Total** | **32** | |

Central finding [S]: the wiring that connected these 32 files is also absent at HEAD. That covers the `/flows` routes and inbox "Drafts from Jarvis" card, the `browser.task` intent in jev-router.ts and j2/intents.ts, the `DeskPaymentCard` in `__root.tsx`, and `deskPaySyntheticAllowed` in preview-guard.ts. Nothing at HEAD imports a missing module. A reinstated file would need that wiring restored as well, and the wiring files have since diverged. This is why "restore the old files" is the wrong move.

## 2. The 32-path table

Historical branch for all: cloud/agenticos-next-integration-20260929 (blob SHAs in source-inventory.json). Current-code search covered function names, route paths, strings and test names.

### scripts/flows/ (F1 everyday flows: draft an email, add a calendar event)

| Path | Historical purpose | Current location | Class | Evidence / proposal |
|---|---|---|---|---|
| flows/when.ts | Pure Sydney-zone date and time parser (DST-correct `sydneyInstant`, "tomorrow at 3", "half past", durations, `whenSaid` read-back). | none. `parseWhen`, `sydneyInstant` and `sydneyParts` have zero hits at HEAD. The only calendar path is the model-driven `src/lib/chat-calendar.ts:9-40` (typed) and `scripts/calendar-write.ts:16` (reviewed Google/Outlook writer). [S] | WORTH INTEGRATING | Pure, no I/O, no authority. Voice has no rules path for "add X to my calendar" (`free-voice-client.test.ts:341` only treats the phrase as non-noise). Proposal: port as `scripts/jarvis-command/when.ts` with its own tests, behind no new route. |
| flows/parse.ts | Rules for "draft an email to X saying…" and "add … to my calendar" (`emailDraftIn`, `calendarAddIn`, `isCalendarAdd`, `composeEmail`). Adds nothing the owner did not say. | none ([S] zero hits). The inbox has a model-written reply draft (`inbox-workspace.tsx:1528`, "Do not send it"), not rules-based new-recipient drafts. | WORTH INTEGRATING | Proposal: port the parser only. Route calendar asks into the existing review card (`chat-calendar-review.tsx`), never a direct write. Drafts stay unsent. |
| flows/service.ts | Turn handler: pending-ask state, OS-calendar add with read-back and 15-minute Undo, reviewed Google/Outlook create on a spoken yes, unsent email drafts. | none. Overlaps the reviewed-booking path (`calendar-write.ts`, `account-connections.ts:277`). [S] | CONFLICTING/INCOMPLETE | Direct OS-calendar write with no review; spoken-yes confirmation pre-dates the current identity and approval gates; branch is "21 preserved unverified edits" (handoff §3). Reuse the design ideas (read-back, Undo), not the file. |
| flows/live.ts | Hub wiring: OS calendar through operator state, provider calendars through `/connections/calendar/*`, recipient address from inbox mail. | none. `operator-plugin.ts` no longer has `/flows` and has diverged (three-way conflict). [S] | CONFLICTING/INCOMPLETE | Depends on removed operator-plugin hooks. Archive. |
| flows/store.ts | JSON store (`.operator-data/flows/state.json`) of drafts and added events, capped at 50. | none | CONFLICTING/INCOMPLETE | A second private store beside Memory, the inbox and CRM. Do not revive; if drafts are wanted, use the existing inbox or CRM document records. |

### scripts/f1, scripts/jarvis-command

| Path | Purpose | Current location | Class | Evidence / proposal |
|---|---|---|---|---|
| f1/email-calendar.test.ts | Synthetic tests: voice turn routes a draft before any model call; drafts never sent; explicit Google destination never falls back to the OS calendar; undo removes only its event. | none | WORTH INTEGRATING | Port only the cases for the ported parser (draft detection, never-send, no silent fallback destination). The Undo and OS-calendar cases go with the archived service. |
| f1/leads-voice.test.ts | Tests resolve-by-name/description/fuzzy, retry identity (same utterance writes once) and read-back for CRM voice actions. | partial: `jarvis-command/unit.test.ts:200-225` covers exact-name, several-match "Which one?", none, and read-back. [S] | WORTH INTEGRATING | Port the fuzzy/description and retry-key cases alongside lead-resolve. |
| jarvis-command/lead-resolve.ts | Finds "the dentist in Parramatta", "Harbor Dental" (spelling slip, dropped Pty Ltd) with scored fuzzy matching. It asks when two candidates are close and never guesses. | `runLeadAction` (`jarvis-command/leads.ts:21-43`) does exact-title match, else asks if several, else "can't find". No fuzzy or description fallback, and it does **not** pass the `event` key that `scripts/leads/api.ts:65,97,244` already dedupes on. [S] | WORTH INTEGRATING | Real gap: a typed double-submit logs a call twice. A mis-heard name finds nothing. Proposal in follow-up 1. Fold it into the CRM adapter, since Dot's CRM now exposes `/__crm/resolve-legacy` and `operations.run`. |

### scripts/j2 (J6 browser task loop)

| Path | Purpose | Current location | Class | Evidence / proposal |
|---|---|---|---|---|
| j2/browser-task.ts | Multi-step browser goals on Jarvis Chrome (max 8 or 12 steps), rules-first drivers, stops on sign-in, captcha, paywall, wrong site, soft 404. | `scripts/computers/goal-loop.ts:1-40,80` is the hub-side bounded goal loop (12 steps, no-Jev stop, final-button and password fences). For Jarvis Chrome, first-result follow-through is `free-voice.ts:730` plus `j2/navigation-outcome.test.ts:87,102`, and compound sentences are `jarvis-command/continuation.ts`. [S] | SUPERSEDED | A second loop would duplicate three. One real gap remains: the error-page and soft-404 checks and the registrable-domain "landed on another site" check (browser-task.ts lines ~216-253, 476-510). Zero hits for soft-404 at HEAD. [S] Optional extract in follow-up 4. |
| j2/task-intents.ts | Rule recogniser for goals ("open the second result", "find the pricing page on X", "read the footer"). | none. `j2/intents.ts` has no `task` action. [S] | SUPERSEDED | Model tool loop plus continuation cover search-then-open. Nth-result and find-page rules are not covered [I] but low value. |
| j2/task-brain.ts | Free-model JSON-action chooser per step through the router task `screen.plan`. | `screen.plan` still exists (`model-router/catalogue.json:164`) and is used by the screen loop. [S] | SUPERSEDED | goal-loop uses Jev on the hub. |
| j2/typed.ts | Typed command uses the same browser hands as voice. | `src/lib/jarvis-intents.ts:7` documents the one command entry for typed and voice. [S] | SUPERSEDED | Same outcome, different mechanism. |
| j2/fake-web.ts | Fake page graph for the loop tests. | none | ARCHIVE ONLY | Test scaffold for a superseded loop. Reuse only if follow-up 4 is taken. |
| j2/task-fixtures.ts | Fixture pages (fake Google, YouTube, Gmail). | none | ARCHIVE ONLY | As above. |
| j2/browser-task.test.ts | 55 KB tests of the loop. | none | ARCHIVE ONLY | Mine only the soft-404 and host-drift cases if follow-up 4 is taken. |
| j2/desk-handoff.test.ts | Guards that the desk verdict reaches the browser skill. | none. `desk:` is not passed anywhere at HEAD, so there is no dead hook. [S] | ARCHIVE ONLY | Payment-linked. |

### scripts/desk-payments (14), desk-payment-card.tsx, desk-money.ts

All 16 files: purpose = P1 "pay at my desk" workflow (confirm card, one bound press of a money button, receipt via the away-mode receipts file). The files are `confirmed.ts, desk-payments.test.ts, desk-turn.test.ts, fake-bank.ts, live-check.ts, live.ts, page.ts, policy.ts, request.ts, review-fixes.test.ts, route.ts, rule-table.test.ts, service.ts, store.ts`, plus `desk-payment-card.tsx` and `desk-money.ts`.
- Current location: none. No `deskVerdict`, `ConfirmedPress`, `mintConfirmed` or `desk-pay` at HEAD. [S]
- Class: **ARCHIVE ONLY. Never activate.** This is payment code with no owner authorisation. The handoff itself says it was "never live-accepted" (p1-desk row) and that old payment code "is archival source, not payment authorisation". [S] It contradicts `docs/AWAY-MODE-MONEY.md:9` (every OS executor still refuses to move money) and the standing no-payments rule. [S]
- Only candidate salvage, if the owner ever authorises payments: `desk-money.ts` (a pure amount formatter) and the `confirmed.ts` "one-press token" idea. Neither is useful today.

## 3. The ten historical branches

Counts compare each cloud blob with current HEAD (stricter than the handoff's baseline comparison). "Same" = byte-identical at HEAD. "Contained" = three-way merge adds nothing. "Missing" = HEAD still equals historical main, so the cloud change is absent. "Conflict" = both sides changed.

| Branch | Same | Contained | Missing | Conflict / diverged | Disposition |
|---|---|---|---|---|---|
| agenticos-next-integration-20260929 (candidate) | 41 | 5 | 16 | 21 (+9 partial, 8 added-both) | Mostly live. The 16 "missing" are P1, J6 and F1 wiring plus two small items below. |
| f1-flows-wip | 4 | 1 | 5 | 8 | Mostly superseded or unfinished. Source of the flows follow-up. |
| integration-j6-f1-p1 | 4 | 1 | 16 | 13 | Not live by design (J6, F1, P1 wiring). Contains the soft-404, retry and host-binding fixes, which sit in the absent browser-task.ts. |
| j6-browser | 0 | 0 | 3 | 3 (+6 partial) | Superseded by goal-loop and continuation. |
| jarvis-device-coding-20260929 | 14 | 3 | 16 | 19 | Mostly live: device-target contract and recorded routing identical. |
| memory-finance-20260929 | 11 | 2 | 16 | 14 | Live: memory api, connector, types, vault and the NAB panel files are byte-identical. |
| nexus-interface-20260929 | 7 | 2 | 16 | 15 | Mostly live: palette-target, command-palette-body and the nexus test are identical. Command scene diverged (newer). |
| p1-desk | 0 | 0 | 7 | 6 | Archive only (payments). |
| receptionist-leads-handoff-20260929 | 50 | 6 | 16 | 20 | Mostly live: handoff seam and its test are identical. Receptionist is on hold, so do not touch. |
| codex/coding-ux-audit-20260929 | 47 | 6 | 16 | 23 | Mostly live (see sample 6 below). |

The shared "16 missing" are the same 16 paths in every branch. By inspection [S] they are:
- **P1 payments (do not integrate):** preview-guard.ts, away-mode/store.ts, screen-hands/payment.ts, money-policy.ts, ai-usage/jarvis-intent.ts, jarvis-skills/index.ts, docs/JARVIS-ACCEPTANCE-LIVE.md.
- **J6 browser task:** jev-router.ts, jev-bench-cases.ts, s2c-final-buttons.test.ts.
- **F1 flows:** jarvis-command/intents.ts, jarvis-command/leads.ts.
- **Two genuine small items (see samples 5 and 7):** workspace/needs-you-voice.ts and coding/runners/router.test.ts.
- **Test fixtures:** coding/test-fixtures.ts, coding/voice-f4.test.ts.

Samples checked for a still-missing fix:

1. **Memory decision-transfer.** ALREADY LIVE [S]. memory/vault.ts, api.ts, connector.ts and types.ts are byte-identical to the cloud blobs. `memory/vault-propagation.test.ts:101` ("an unindexed or forgotten note's decision is never handed to a merely similar note") is present.
2. **Mail-archive close fixes.** ALREADY LIVE [S]. `mail-archive-close.test.ts` is identical. The three-way merge shows `mail-archive.ts` already contains the cloud change.
3. **Device targeting and command idempotency.** ALREADY LIVE [S]. `DEDUPE_WINDOW_MS`, `commandKey` and the `keyed` map are in `devices/dispatch.ts` (:13, :47, :148). jev-target, context-device and palette-target are identical.
4. **Receipts-recorded gate and idempotent job start.** ALREADY LIVE [S]. `gate.ts:394`, `receipts.ts:307` `unreceiptedRuns`, and `orchestrator.ts:1170` (same plan digest is a no-op).
5. **Retry / soft-404 / host-binding (J6).** Not live [S]. The fixes live inside absent browser-task.ts. Related tab-timeout confirmation is covered (`navigation-outcome.test.ts:56`). Soft-404 and landed-on-another-site checks are not. See follow-up 4.
6. **Coding UX stale states.** ALREADY LIVE (newer form) [S]. `job-detail.tsx:224` ("Couldn't refresh this job… last successful read"), `coding-list.tsx:77,137,171`, `job-detail.tsx:300` ("Newest first · showing N of M"), and `pipeline-ui.test.tsx:223` cover audit items 1 to 4.
7. **Needs-you voice includes coding decisions.** Not live [S]. Cloud `needs-you-voice.ts` (+6 lines) and `operator-plugin.ts:670` add coding drafts and decisions to "what needs me?". HEAD `operator-plugin.ts:667-672` returns only `needsYou` and `today`, and `workspace/needs-you.ts` has no coding input. Small real gap. See follow-up 2.
8. **Free Cline choice never reaches metered fallback.** Behaviour live, test missing [S]. `coding/runners/router.ts:119` (`cline/` forces freeOnly) is identical to cloud. Only the regression test in `router.test.ts` (+6 lines) is absent.

## 4. Dot's nine held shared-file proposals

Handoff §4 says these are still needed and that page-context.ts is obsolete. At HEAD, committed state [S]:

| Path | Handoff disposition | Confirmed against current code |
|---|---|---|
| vite.config.ts | CRM plugin mount, still needed | Confirmed: no `crm` string at HEAD. The worktree shows it modified (lead integrating). |
| scripts/identity/routes.ts | `/__crm` classification | Confirmed missing at HEAD. Worktree modified. |
| docs/IDENTITY-ROUTES.md | Route docs | Confirmed missing at HEAD. Worktree modified. |
| scripts/identity/fixtures/legacy-route-decisions.json | Fixture | Confirmed missing at HEAD. Worktree modified. |
| scripts/events/bus.ts | CRM topic typing | Confirmed needed: `Topic` (line 17) has no `crm`. |
| scripts/events/sources.ts | Old helper, incomplete | Confirmed: no CRM source. `scripts/crm/runtime.ts:15,47` exposes `publishChange?` as the optional seam. Wire through it, not the old helper. |
| src/lib/activity-stream.ts | CRM topic typing | Confirmed needed: `ActivityTopic` (line 18) has no `crm`. Must match bus.ts. |
| src/routeTree.gen.ts | Regenerate, never apply the old diff | Confirmed: `src/routes/crm.tsx` exists but the generated tree has no crm entry. Regenerate. |
| src/lib/page-context.ts | **Obsolete** | **Confirmed obsolete.** `page-context.ts:32` already has `search?: Record<string,string>`. CRM reads `search.ref` (`crm-workspace.tsx:50`, `selectors.ts:28`). No new field needed. |

## 5. Recommended scoped follow-ups (at most 5)

1. **CRM voice resolve and retry key.** Fold lead-resolve's fuzzy/description matching and a per-intent event key into Jarvis's CRM action path. Do it after, or as part of, the CRM `operations.run` adapter so it targets one lead API, not two.
   Owns: `scripts/jarvis-command/leads.ts`, new `scripts/jarvis-command/lead-resolve.ts`, tests in `unit.test.ts` (or a new `lead-resolve.test.ts`).
   Acceptance: ported cases pass: "Harbor Dental" finds Harbour Dental and says so; two close names ask and write nothing; the same command twice logs one activity (the `event` key reaches `/leads/log`); a read-back miss is not called done. Typecheck clean. No provider calls.
2. **"What needs me?" includes coding decisions.** Add the coding drafts and approvals source to the voice answer (and check the Work panel agrees).
   Owns: `scripts/workspace/needs-you-voice.ts`, the `needsYou` dep in `scripts/operator-plugin.ts` (about :667-672), `free-voice.ts` types.
   Acceptance: synthetic test with a draft and an approval says "N coding draft(s)… Open Coding" with nothing started; an unreadable coding source says "couldn't be read", never zero.
3. **Pure Sydney date and email-draft parser (voice rules path only).** Port `when.ts` and `parse.ts` with their tests as a pure module. Route the result into the existing review card and inbox draft. Do not port service, live or store.
   Owns: new `scripts/jarvis-command/when.ts` and `parse.ts` with tests, plus one rule in `plan.ts`.
   Acceptance: DST-boundary cases (the October and April changes) pass; "draft an email to X saying…" produces an unsent draft with no send call; "add … to my calendar" opens the review card and writes nothing without confirmation; zero new routes or stores.
4. **(Optional) Soft-404 and wrong-site outcome checks.** Extract only the `ERROR_PAGE`/`SOFT_404` and registrable-domain-drift checks into `navigation-outcome` so "opened the first result" cannot report success on an error page or another site.
   Owns: `scripts/j2/browser-skill.ts` or a new small helper, plus `scripts/j2/navigation-outcome.test.ts`.
   Acceptance: a 404, a soft 404 served as 200 and a redirect to a different registrable domain each produce a "couldn't" line.
5. **Regression test only.** Add the "explicit free Cline choice never reaches a metered OpenRouter fallback" test to `scripts/coding/runners/router.test.ts`.
   Acceptance: test passes against the existing router with no source change.

Do not take: any desk-payments file, `deskPaySyntheticAllowed`, the `PaymentReceipt` widening, `money-policy.ts` desk additions or the `answerAiUsageAtDesk` hook (payment surface, no authorisation). Do not take the F1 service, live or store files, or any receptionist change (on hold). Nothing touches Brooke/Bianca.

## 6. What is inferred rather than read

- That the 16 "missing" shared paths carry only wiring for the absent modules. I read the diffs for 15 of them and the merge residue for the 5 largest conflict files (agent-browser, intents, away-mode service, `__root`, inbox). The 21 conflict files (coding/*, operator-plugin, jarvis-command service/live, free-voice, voice-companion, command scene) were sampled only through gate, orchestrator and dispatch. Treat the rest as "diverged, newer at HEAD" [I].
- The "low value" call on Nth-result and find-page rules is a judgement [I]. I did not run Jarvis against them.
- The current OS runtime was not checked. HEAD is stated to equal live 5fc21c05 plus the CRM PR and two fixes. I did not verify that.
