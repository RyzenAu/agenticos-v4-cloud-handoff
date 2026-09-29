# AgenticOS cloud continuation — 29 September 2026

This private repository is a code snapshot for Claude Code cloud. It is separate from the live Windows checkout. The `main` branch is a snapshot of local `jarvis-voice` at `b96c046`, with the synthetic raw transcript fixture omitted. Git history, ignored operator data, credentials, and the dirty local checkout were not transferred.

## Model and delegation

Use **Claude Sonnet 5.5, Medium**. You may spawn **up to two agents** at once, with disjoint tasks and no agents spawned by those agents. Keep one lead responsible for integrating and checking the result. Do not use Opus or paid generation for this handoff.

## Branches to continue

- `cloud/j6-browser`: J6 browser task loop at local `18c7c07`. Its independent re-review is **HOLD** despite 276 focused tests and typecheck passing. Fix two findings: inspect destination before clicking an external link on a site-bound task; reject a search result landing on a 404/error page before reporting success. Then independently re-review with synthetic pages.
- `cloud/f1-flows-wip`: F1 flows at local `1c677ee` plus 21 preserved, unverified follow-up edits. Explicit free Cline routes, named calendar destination, CRM read-back/event key, editable unsent email draft, needs-you coding decisions, and site source labels are in progress. Typecheck and diff check passed; focused tests were 218 passed/10 failed **before** the latest test edits. Rerun the focused suite and build, resolve failures, and harden CRM retry identity across resubmitted commands.
- `cloud/p1-desk`: Desk payment branch at local `3f85c48`. Synthetic focused tests (898) and typecheck passed; a local fake-bank Chrome probe passed 8/8. It is **not live** and real bank acceptance is unverified. Preserve its desk-confirmation rules and away-mode restrictions. Do not run a real payment.

The three branches all start from `main` and overlap in `free-voice.ts`, `j2/agent-browser.ts`, `jarvis-command/live.ts`, `jarvis-command/service.ts`, and/or `operator-plugin.ts`. Integrate them on a **new cloud branch**, resolve each overlap intentionally, then run targeted tests, typecheck, build and an independent review. Do not merge to `main` until those gates pass. Do not push into the original local repo or deploy.

## Programme direction

Jarvis is the voice-first assistant inside a calm black-and-gold M&U business OS. Jev is its primary decision brain, delegating when another model is better suited. Keep the existing Hindsight plus Obsidian memory arrangement, the coding harness, receptionist, Finance, Leads and Command scene. Do not replace the existing working features. Correct data states must distinguish live, simulated, stale and unknown. There are separate founder logins with a shared business workspace; commands act on the right person's Windows device.

The owner wants capability work ahead of repeated guardrail redesign. Routine reversible actions should happen without repeated questions. Desk payments need one exact confirmation; away-mode payments remain off. No trades, crypto, betting, typed secrets or payment instructions from untrusted pages. Keep refusals brief.

The local source of truth remains `C:\Users\Nebula PC\source\repos\AgenticOS-v4`. Its live branch was `b96c046` when this snapshot was made. Local Windows/browser hardware tests and live provider acceptance must happen later on that PC. Preserve all cloud commits and give a precise branch/commit handoff for local integration.

## First cloud outcome

Finish and review J6 and F1, integrate J6/F1/P1 in a new branch with meaningful synthetic checks, and report exact passing/failing evidence. Use Sonnet 5.5 Medium with at most two agents. Work on code; do not call unfinished work live or production-ready.
