# Triggers and routines: evidence (builder T, 1 Oct 2026)

Branch `prog/t-triggers-20261001` (from `prog/integration-20261001` at `cf556fe`). Design and comparison with Open Dot: `OPEN-DOT-ADOPTION.md`, section "Triggers and routines".

## Tests

`bun test scripts/triggers` runs 24 tests (engine, store, schedule, sources, panel). Also green: `scripts/jobs`, `scripts/approvals`, `scripts/automations.test.ts`, `scripts/l4-layout.test.tsx`, `scripts/operator-plugin.test.ts`, `scripts/commands-plugin.test.ts`, `scripts/jarvis-command`. `bun run typecheck` and `bun run typecheck:scripts` exit 0.

| Done-when | Test |
|---|---|
| Dedupe: repeated delivery is one job, event to job link durable | "a new enquiry becomes ONE job, replays are deduplicated"; "dedupe and the event-to-job link survive" (store reopened) |
| Permissions and approvals | sending is a pending `message.send` approval requested by a process; nothing sent after approval ("Nothing was sent"); rejection cancels the job; review mode holds the action until `trigger.review` is approved |
| Retry limit, visible failure, manual retry | "retry limit, then a visible failed state" (3 attempts, backoff, then "failing", manual retry makes job #4); unknown outcome is never auto-retried |
| Pause/disable | "paused and disabled triggers create no jobs"; a re-seed never undoes a pause; "the morning summary is seeded PAUSED" (no job at 07:30 until resumed, one job once on, restart keeps the choice) |
| Loop guard | "the loop guard treats % and _ in a ref literally" (LIKE wildcards in a stored ref are escaped) |
| No secrets or payloads stored | "only ids, hashes and masked short fields are stored"; an exception message containing a token is never stored |
| Feedback loops | "what our own job produced, or an agent actor, never re-triggers": draft id, child version, `originRef` = draft, `originRef` = our job id, agent actor are all ignored with no new job |
| Offline policy across a hub restart | four tests: skip / run-once / review / several missed days, each closing every store at 07:20, reopening at 09:15 (`recover()` as the owner would), then ticking; no second run on later ticks; a paused routine never catches up |

## Runtime (cloud-role hub, 127.0.0.1:8116, MU_DATA_DIR=D:\prog-t-data, synthetic data dir; torn down by listener PID, 8116 free afterwards)

1. Synthetic journey over HTTP: `POST /__operator/triggers/synthetic` for `ENQ-RT-1` returned a job (kind `trigger`, 4 steps, `awaiting-approval`, one pending `message.send` by a process); the same event twice more returned `duplicate` with the same job id.
2. Hub restarted (process killed, relaunched on the same data dir): replay of `ENQ-RT-1` was still `duplicate` (deliveryId 1); the two open jobs were `interrupted` by the existing recovery, their approvals stayed pending.
3. Loop guard over HTTP: an event with `originRef=draft:ENQ-RT-1` returned `ignored: self-output`; an event with actor `agent` returned `ignored: agent-actor`; no job was created for either.
4. Real source (read-only): the receptionist agency feed through the OS's own reader. The production feed has 1 organisation, 6 recent calls, 1 flagged call, and does not send a `qaFlags` list (counts only; nothing printed). With the QA-flag trigger switched on and a 30-day lookback: `{"seen":1,"jobs":1}` then, polling again, `{"jobs":0,"duplicates":1}`. The job is `awaiting-approval` ("Held for the owner's review. Nothing has run"), with one pending `trigger.review`. No message was sent, nothing was written to the receptionist, no provider config changed. The default 24-hour poll saw 0 (the flagged call is older), which is correct.
5. Business summary routine (seeded paused from the 1 Oct review fix; the run below had it switched on), real brief context from the hub (`/__operator/business/brief/context`, counts only: five sections) with the same simulated 07:20 up / 09:15 back across a store reopen: `skip` -> run `skipped-offline`, no job; `run-once` -> run `ran-on-return`, 1 job succeeded ("Business summary ready (coverage 9, sources 9, ...)"); `review` -> run `review-requested`, 1 job `awaiting-approval`.
6. UI: Automations page renders "Triggers and routines" with the three seeded triggers (the receptionist QA flag trigger and the morning business summary are seeded PAUSED; the owner opts in from Automations), state, last delivery, offline policy line and Pause/Disable/Retry controls (screenshot taken in the in-app browser at 1280 px).

## What is not proven

- The real 07:30 Sydney slot has not fired on a live host (the routine was exercised with a simulated clock and real stores; the live clock was 13:50 AEST).
- Approving a held job end to end through the real Telegram code or a spoken yes was not exercised on the hub (tests approve through the approval service with a Telegram-DM principal); `MU_TRIGGERS_NOTIFY` was left off, so no message was sent.
- Another real source (the native inbox) was not connected: one source was the brief.

## Hooks outside `scripts/triggers/**`

`scripts/jobs/types.ts` (job kind `trigger`), `scripts/approvals/policy.ts` (action `trigger.review`), `scripts/operator-plugin.ts` (mount, tick start, `/triggers*` routes), `src/components/activity/activity-view.tsx` (the "Trigger" label), `src/components/operator/automations-workspace.tsx` (renders the panel), new `src/components/operator/triggers-panel.tsx`.
