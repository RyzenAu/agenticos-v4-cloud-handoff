# Coding harness and shared memory: evidence (1 Oct 2026, Agent D)

Branch `prog/d-coding-20261001`, worktree `D:/AgenticOS-prog-d-coding`. Nothing merged, deployed or messaged. No secret, token, account email or real memory content was read or recorded. Raw results: `coding-job-result.json`, `memory-journeys-result.json` (this folder).

## 1. Model ids

| Probe (Claude Code 2.1.280, `claude -p --output-format json`, `CLAUDE_CONFIG_DIR` = the claude:max-2 profile) | Result |
|---|---|
| `--model claude-sonnet-5-5` | ran, `modelUsage` key `claude-sonnet-5-5` (stderr carries a client-side `unrecognized_model` notice; the model is accepted and reported) |
| `--model claude-sonnet-5` | ran, reported `claude-sonnet-5` (the older id still works) |
| `claude-opus-5-5` | ran and reported as `claude-opus-5-5` in the real job below (reviewer) |

Not probed (no allowance spent on them): `claude-fable-5-1`, `claude-haiku-4-5`. Left as they were.

Changes: `ClaudeModelId` gains `claude-sonnet-5-5`; `claude-sonnet-5` stays accepted as a legacy alias (`LEGACY_CLAUDE_MODELS`, `currentClaudeModel`, `CLAUDE_MODELS_OFFERED` = what a person may pick for new work). New drafts (role-choice, shaper "Sonnet") bind `claude-sonnet-5-5`; a stored job keeps its own id (test: a spec with the legacy id still validates and is not rewritten). A saved preference or Jev proposal naming `claude-sonnet-5` is read as the current Sonnet. Catalogue gained `claude/sonnet-5-5` (additive; `claude/sonnet-5` untouched because the Hermes bridge, design page and meeting-mode use it: other owners).

## 2. Receipts

Every usage receipt now also stores: `requestedModel` (what the binding asked for), `providerModel` (what the CLI reported, from `modelUsage`/init), `modelMismatch` (true / false / null = the CLI never said), `executionLocation` (`this-pc`; type also allows `cloud`), `contextSources` (max 12; kind, name, chars, 12-hex digest; never contents: the shared brief's path and size, `CLAUDE.md`/`AGENTS.md` present in the worktree, the task text), plus `allowance.reading` (fresh / stale / unknown). Account slot and CLI version were already on the receipt (`account`, `coding.cliVersion`). A mismatch also adds a job step "Model mismatch: asked for X, the CLI reported Y". All new fields are optional, so stored receipts still parse.

## 3. Account handling (tests in `scripts/coding/claude-accounts.test.ts`)

- Unknown is not 0: no snapshot, no readAt, or no window with a figure gives `reading: "unknown"` and `usedPercentAtLastRead: null`.
- Bug fixed: `claudeAllowance` stamped `readAt = now` on a cached figure, so a stale number looked fresh. It now carries the provider's last-read time (`freshness.checkedAt`), or null.
- Stale = older than 30 minutes, or a window it shows has already reset. A window that has reset no longer blocks a new role (it used to block on a figure that no longer holds). `/coding` accounts rows carry `allowanceReading`.
- One account's usage is never shown for another: `claudeAllowance(cards, "claude:max-2")` is null when only `claude:max` was read; `allowanceReading(snapshot, now, slot)` is unknown for a different slot.
- Resume binds to the original slot: a role blocked at 97% on claude:max-2 (while claude:max reads 3%) launches nothing; after the window clears, `resume` runs on claude:max-2's own `CLAUDE_CONFIG_DIR`, and the receipt says `claude:max-2`.
- Two existing tests had fixed past reset dates (time bombs under the new rule); they now use a future reset.

## 4. One real coding job on claude:max-2

Through the harness itself (`scripts/coding/live-smoke.ts claude2`, which I added: real `claudeRunner`, orchestrator, registry, store, worktree, gate; accounts read from the live `accounts.json`, shared brief from the live `shared-context.json`, nothing written to either). Repo: a throwaway git repo under `D:/prog-scratch/job2/canonical` (not AgenticOS), check `bun --no-env-file test`.

| | |
|---|---|
| Job id | `20cef94d-4b6d-497e-a91b-8e6b4e39838e` |
| Account slot | `claude:max-2` (both roles), plan claude-max-20x, usage at end 4% |
| Builder | requested `claude-sonnet-5-5`, reported `claude-sonnet-5-5`, mismatch false |
| Reviewer | requested `claude-opus-5-5`, reported `claude-opus-5-5`, mismatch false (a different model from the builder) |
| CLI | Claude Code 2.1.280, location `this-pc` |
| Context recorded | shared brief `MU-BUSINESS-CONTEXT-20260930.txt` 11,809 chars (digest 1f041305256b) + task text 1,425 / 2,397 chars |
| Change | "add `farewell(name)` and a test": `src/greet.ts` +2 -0, `src/greet.test.ts` +5 -1, isolated worktree branch `coding/in-src-greet-ts-add-20cef9` (head `748d990`), committed by the builder |
| Tests | baseline 1 pass at `4b55619`; at `748d990` 2 pass, 0 fail |
| Review | approve at `748d990`, 0 findings, both done-when criteria met |
| Gate | passed: 8 of 8 checks (committed-and-clean, ownership, no-eol-churn, secret-scan, checks-pass, review-approved-for-sha, done-when-evidenced, receipts-recorded) |
| Merge | none. The throwaway repo's `main` is untouched; the live checkout snapshot was byte-identical afterwards |

Disclosure: a first attempt (job `90947f0f`) was invalidated by my own mistake: I started a second run and deleted its scratch folder while the first was still running, so the post-check flagged the throwaway checkout as changed. Its builder turn (about US$0.23 API-equivalent, well under 1% of the window) is the only extra spend; nothing else ran on that account. The scratch folder `D:/prog-scratch/job1` is partly locked and can be deleted by hand.

## 5. Memory journeys

Script: `scripts/memory/prog-d-journeys.ts` (21 checks, all pass: `memory-journeys-result.json`). What it runs on:

- Hindsight: the dedicated Stage D instance (API 8893, client proxy 8883), which is the same Hindsight, proxy (writer capability **on**), supervisor and LLM chain as the pilot, and a fresh disposable bank `syn-prog-d-<run>`. The OS process (this script) owns the writer port and registers the per-process writer capability like the OS does on 8081.
- The OS's own memory module in-process: `createMemoryApi` (real connector, real Hindsight client, real approvals service), over a temporary vault under `D:/prog-scratch/` (a copy of the synthetic mini-wiki). No ad-hoc SQL.
- Tag `SYNTHETIC-PROG-20261001` on every record.

| Journey | Result |
|---|---|
| Save | memory indexed `confirmed`; document present in the bank |
| Recall with citation | returned via Hindsight (`via: hindsight, local`), source `{kind: memory, id}`, spoken answer cites "from the Jarvis memory mem-…" |
| Dedupe | same text again: `duplicate`, same id, bank document count unchanged (9 and 9) |
| Correct | new memory current and recalled; old marked superseded in the app, retracted from Hindsight (document 404), never recalled, old wording absent from every recalled text |
| Delete | asks for approval first (nothing removed); the same person's program session cannot use the approval; approved on the page card: Hindsight document 404, not in recall, not in the app; the approval is single use |
| Note create | stable `n-…` id, indexed, a Hindsight document |
| Note edit | same id, Hindsight's document text replaced (new wording in, old out), recall shows the new wording only |
| Note rename | same id, new path, identical set of Hindsight documents (no duplicate) |
| Note copy | the copy is not a second note: no new document, one note with that title |
| Reindex + full sync | same ids, same documents |
| Note delete | removed from Hindsight, recall and the index |
| Processing model | Hindsight's receipts for these saves: provider `openrouter`, model `deepseek/deepseek-v4.1-flash`, `fallback_from: []`, basis metered, about 3,500 tokens per save; 12 receipts in the bank, all `success` |
| Cleanup | extra Hindsight documents 0, recall hits for the run 0 (app and raw bank recall), current items 0, vault files left 0, Telegram messages 0. Both synthetic banks I created were then deleted with the operator command (`supervisor.py admin … delete-bank --confirm`), and the bank list shows no `syn-prog-d-*`. The temporary vault and scratch folders were removed |

Live Hindsight (read-only, nothing written): the pilot proxy is healthy; a recall for the tag and run words on `mu-shared` returns 0 hits containing either; the pilot's own `llm-requests` receipts (latest 200 window, 42 rows) are all `openrouter / deepseek/deepseek-v4.1-flash / success`, so the live route matches what the synthetic instance reported.

### Why not write to the live bank

1. The live proxy lets only the process serving 127.0.0.1:8081 (the live OS) register as the writer, so a separate process cannot write there by design.
2. Deleting a saved memory needs a confirmed person. Since S1 a script's page-load session is pending, which the OS treats as a program, and a program's forget sends the owner a Telegram code. Rule: no messages. So the delete and correct journeys ran in-process with the harness's confirmed-session principal (`usman`), and the program-session refusal is proved in the same run.

### Findings for the lead (not fixed here)

- `scripts/memory/stage-d-acceptance.ts` no longer works end to end against a real proxy since Track 6: it reaches Hindsight through a relay it owns, so the proxy sees the relay (not the OS) as the client and refuses the writer registration ("only the process serving 127.0.0.1:<writer port>… may register as the writer"). Its page-card approval step also needs a confirmed session now. Its unit-level cousin `t6-verify-live.test.ts` passes (fake Hindsight). My script avoids both.
- To enforce the writer capability on the Stage D proxy I temporarily set `writer_capability: on` and `writer_port: 8097` in `D:\hindsight\stage-d\hindsight.stage-d.json`. That file is now restored to its original content and the instance is stopped, as I found it. (Before the change the proxy's registration refused every write because its default writer port is 8081.)
- An attempt to drive the same journeys through a quiet copy of the OS (HTTP routes, real vite server on 8097) passed save, recall, dedupe, correct and note create, then failed at delete (403: a pending session cannot approve) and the dev server dropped twice (ECONNRESET / ECONNREFUSED). Partial output kept out of the repo; superseded by the in-process run.
- A dated id: `claude-sonnet-5-5` makes Claude Code 2.1.280 print `[claude-code:unrecognized_model]` on stderr although it runs and reports the model. Harmless; the CLI's local list is older than the service.

## 6. Extended brief (same day)

Automatic configured fallback without replay, naming an account by voice with false-positive tests, the readable job view fields, and where each account can run (cloud compatibility, execution location on every receipt) are in `CODING-LOCATIONS-AND-FALLBACK.md` in this folder.

## 7. Checks

See the final report for the exact commands and outputs (focused test run, `bun run typecheck`, `agent-done-gate`). Files changed outside `scripts/coding`, `scripts/memory`, `scripts/model-router`: `src/lib/coding-client.ts` (one label line: Sonnet 5.5, legacy id), `src/lib/commands/coding.ts` (the shared coding detector: two patterns and one line so a named Claude account starts a draft), `scripts/f1/coding-flows.test.ts` (one expected string).

## Round 3 (1 Oct 2026, Track E): memory journeys re-verified, and the handoff `prohibited-content` diagnosed

Code: `prog/a-cloud-20261001` on `prog/integration-20261001` (includes Track D's merge). Raw result: `memory-journeys-round3-result.json` (25 checks, 25 pass). Same method as section 5: `scripts/memory/prog-d-journeys.ts` (improved, not duplicated: it gained the credential-screen, per-save model and handoff steps) against the dedicated Stage D Hindsight (API 8893, proxy 8883, writer capability on for the run) with a fresh disposable bank `syn-prog-d-56cb2a`, the real connector, real Hindsight client and real approvals service, over a temporary synthetic vault on D:. Tag `SYNTHETIC-PROG-20261001`. The real private bank and the live OS (8081) were not touched; no message sent (captured count 0).

| Journey | Result |
|---|---|
| Save, recall with source cited, dedupe | pass: saved `confirmed`, recalled via Hindsight with its source named, same text again is `duplicate` with no new document |
| Credential screening | pass: a synthetic "Xero password is now ..." string is refused, absent from the bank, the app and recall, no new document |
| Correction supersedes | pass: new fact recalled; old one retracted from Hindsight (404), never recalled |
| Deletion across connector and engine | pass: asks approval first; a program session (the same person's agent) cannot use the approval; approved on the page card: Hindsight document 404, not in recall, not in the app; single use |
| Note edit / rename / copy / reindex / delete | pass: stable id, no duplicate documents at any step, deletion removes it from Hindsight, recall and index |
| Agent-requested forgetting still needs the owner | pass (program session refused, above) |
| Processing model per save | `openrouter` / `deepseek/deepseek-v4.1-flash`, `fallback_from: []`, metered, about 3,570 tokens per save, for the first save and the correction alike (12 of 12 receipts `success`). The router decides; nothing was chosen by hand. |
| Cleanup | pass: extra documents 0, recall hits 0 (app and raw bank), current items 0, vault files 0, Telegram 0. The bank was then deleted with the operator command (`supervisor.py admin --action delete-bank`, HTTP 200) and the bank list shows no `syn-prog-d-*`; the Stage D proxy config was put back byte-identical and the instance stopped; the temp vault removed. |

### The coding handoff refused with `prohibited-content` (lead's extra item)

Diagnosed on synthetic handoff text only (no real handoff or memory read). Not a handoff that "includes something it shouldn't": the handoff fact is composed from controlled fields (job id, repo, branch, counts, models, link) plus the request's own wording, and the screen was refusing **ordinary requests that talk about credentials**.

* Cause 1 (the reported refusal): a strong credential label (password, api key, access or refresh token, credentials, passcode, licence key) followed by "is" and a word is read as "label is VALUE", so the handling word was taken for the secret. Synthetic matrix of 435 objective sentences ("Make sure the password is stored hashed", "the api key is never logged", "the token is validated before use"): **220 refused before, 0 after**. Words on their own (token, key, pin, code), file paths, 40-hex commit hashes, UUIDs, branch names, model names and account slots were not the problem, with one exception found on the way: a lower-case file path after a weak label ("add the wake word code to scripts/voice") was read as a value.
* Cause 2 (a second failure mode found while proving it, same symptom: the handoff does not reach memory): two handoffs on one repo share most of their words, so the memory's "this disagrees with something already saved" check (`likelyConflict`, Jaccard at least 0.5) refused the second with `conflict`. The disposable bank shows it: second handoff without keep-both is `conflict`, with it `saved`.
* Fixes (in `scripts/memory/guard.ts` and `scripts/coding/orchestrator.ts`): (1) the screen knows how a credential is *handled* (hashed, logged, validated, masked, never, ...) and does not read those words as a value, and a lower-case path is not a value; (2) if the full fact is still refused as `prohibited-content`, the orchestrator saves the same facts WITHOUT the request's words (`handoffFactNeutral`, then also without the branch), through the same screen, and records `memoryObjective: "withheld"` on the handoff event and in the job log; (3) handoff saves pass `onConflict: "keep-both"`. The screen is not otherwise relaxed.
* Still blocked (tests): `scripts/memory/handoff-screen.test.ts` keeps "the Xero password is now <value>", "the api key is <value>", "the wifi password is sunflowerfield", "the password is hashed: <value>", an `sk-ant-` key, a private-key block and "Login: admin / <value>" refused, and checks the neutral fact carries none of the request's words; `scripts/coding/orchestrator.test.ts` runs two real jobs through the handoff: a request about hashing saves WITH its wording, a request containing a fake secret saves without it and the secret is in no saved text. On the disposable bank: normal handoff saved and recalled; full fact with a fake secret refused (`prohibited-content`); its neutral form saved; the secret is in neither the bank nor recall.
* Known residual: the guard's identity rule still refuses the odd sentence such as "the account fallback for claude:max-2 and codex:openai-1" (account + two identifiers). The neutral fallback saves such a handoff anyway, so it no longer fails the handoff; it was left alone rather than loosen the login-details rule.
* The live OS needs the code merged and restarted to benefit; nothing live was changed.
