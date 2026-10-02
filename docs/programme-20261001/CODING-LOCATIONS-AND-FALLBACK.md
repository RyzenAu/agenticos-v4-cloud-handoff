# Coding harness: fallback, account words, job view, and where each account can run (1 Oct 2026, Agent D)

Code: `scripts/coding/fallback.ts`, `orchestrator.ts` (planFallback), `shaper.ts` (account words), `src/lib/commands/coding.ts` (the shared detector), `job-view.ts`, `receipts.ts`. Tests: `scripts/coding/claude-accounts.test.ts`, `account-words.test.ts`.

## 1. Automatic configured fallback (nothing replayed)

Opt-in, in `.operator-data/coding-prefs.json` (read by the plugin; absent = today's behaviour: a limit pauses the role for the owner):

```json
{ "fallback": { "auto": true, "chain": ["claude:max", "claude-opus-5-5", "claude:max-2/claude-sonnet-5-5", "gpt-6-astra"] } }
```

An entry is an account slot (same model on that account), a model id (that model on the role's own account), `slot/model`, or a Codex model (used only when Codex may run: it is paused until its sandbox isolation is applied). An entry is skipped, with the reason kept on the job, when the account isn't configured, is signed out, is itself at its limit, is the current binding, or was already tried for that role (so a chain can't loop).

What happens at a limit (before a role starts, or part-way through): the role's run is paused as before; if `auto` is on and an entry is usable, the orchestrator records a progress line `Automatic fallback: <role> <slot/model> → <slot/model>` (with the why) and a spoken line, then resumes that one role on the next binding through the same path as an owner's "use another account". That path is what guarantees no replay: roles that already finished are skipped, the integrated head and passing tests are kept (the test suite is not re-run for a head it already covered), and a role that was blocked after committing continues in its own worktree on top of its commit (a new native session with a "re-read git status, don't repeat what's visible" note). If nothing usable is left, the job stays paused and says which entries were refused and why.

Receipts show both attempts: a turn that ran and hit the limit has its own receipt (`outcome: rate_limited`, the first account/model); the continuation has the next (`turn: 2`, the new account/model). A turn that never started (the account was full before it began) has no provider receipt by nature; the job view lists it as `did_not_run` with the account it was moved from. Proved in tests: a reviewer moved off a full account while the builder and tests run exactly once; a builder that commits and then hits its limit is continued on the next account with one commit on its branch and receipts for turn 1 (max-2, rate_limited) and turn 2 (max, succeeded).

Not covered: a signed-out account fails the role before it starts (a failed run, not a paused one), so it still needs the owner. Reason: a failed run can't be resumed in place and a fresh run would collide with the first one's receipt numbering. It is the next thing to do if wanted.

## 2. Naming an account by voice or typing

"assign this fix to Claude Max 2", "give this change to Claude account 2", "have Sonnet build this using account two and another agent review it", "use the second Claude account for a builder to fix X and Opus to review it" all draft a coding job (confirmation still required) on the named slot. The named account applies to every Claude role in the draft (the independent reviewer too) and the reviewer is still a different model. An account that isn't configured is never named, so nothing silently lands on another login.

False positives are guarded on both halves: a job needs an assign verb plus a coding noun plus a Claude account; an account is named only as "Claude Max N" / "Claude account N" (any preposition) or after "use / using / via". 22 ordinary sentences are tested not to start a job ("my max heart rate is 180…", "what is the max I can put in account 2", "send the account two code to Mehroz", "give the change from lunch to account two", "switch to Claude Max 2", "open the code editor"…), and 7 more are tested not to pick an account ("allow max 3 retries", "fix the account 2 balance bug in src/a.ts", "open a new account"). One file outside the coding folders changed for this: `src/lib/commands/coding.ts` (two patterns and one line in `isCodingRequest`).

## 3. Job view fields for the Coding page (Agent C renders)

`GET /coding/jobs/:id` now also returns `readable` (built by `readableJob` in `job-view.ts`; pure, no contents of any brief or transcript). Existing keys are unchanged. `/coding/accounts` Claude rows gain `allowanceReading` (`fresh | stale | unknown`).

| Block | Fields |
|---|---|
| `plan` | `objective`, `nonGoals[]`, `doneWhen[{id,text,evidence,met: true\|false\|null,note\|null}]`, `checks[]`, `roles[{roleId,role,who{route,accountSlot,model},owns[],why\|null}]` |
| `progress` | `state`, `stateText`, `needsYou\|null`, `phases[{id,label,status: done\|active\|pending\|blocked\|failed,detail\|null}]` (Build, Merge branches, Tests, Review, Done gate), `runs[{roleId,role,state,attempt,who,error\|null,attempts[{turn,account,requestedModel,reportedModel,modelMismatch,outcome,location}]}]`, `fallbacks[{roleId,from,to,at,why}]`, `recent[]` (last 8 progress lines) |
| `diff` (or null) | `baseSha,headSha,baseShort,headShort`, `totals{files,additions,deletions}`, `files[{path,status,additions,deletions,ownedBy\|null}]`, `outsideOwnership[]`, `patchArtefact` |
| `tests` | `latest{sha,command,passed,failed,skipped,exitCode,timedOut,failedTests\|null,matchesHead}\|null`, `baselineFailed\|null`, `runs` |
| `review` (or null) | `verdict`, `sha`, `forCurrentHead`, `reviewer{roleId,account,model}\|null`, `findings[{id,severity,file,line,message,status}]`, `criteria[{id,met,note}]` |
| `result` | `state`, `headSha`, `headShort`, `jobBranch`, `gate{passed,at,checks[{check,passed,detail}]}\|null`, `merged`, `applies[{action,state,toRef}]`, `nextStep` |
| `context` | `sources[{roleId,kind,name,chars,sha256,truncated?}]` (latest turn of each role; sizes and digests only) |
| `location` | `"this-pc" \| "cloud" \| "mixed" \| null` |

Each usage receipt also carries `requestedModel`, `modelMismatch`, `executionLocation`, `executionDevice`, `contextSources`, `allowance.reading`.

## 4. Cloud-runtime compatibility: where each account can run

Rule: a login is never copied. A Claude or Codex sign-in lives in one device's own profile and is used only by a CLI running on that device.

| Account kind | Runs where | Sign-in lives in | On a cloud-role hub |
|---|---|---|---|
| `claude:max` | the machine whose default `~/.claude` holds the login | that machine's `~/.claude` | not available from the PC's login. A cloud computer signs itself in (`claude auth login` into its own profile) and lists its own slots in its own `accounts.json`; it may be the same Claude account, but it is a separate sign-in |
| `claude:max-N` | the machine that has that `CLAUDE_CONFIG_DIR` folder | that folder | same as above: a cloud computer needs its own folder and sign-in; the path in the PC's `accounts.json` means nothing there |
| `codex:openai-N` | the machine with that `CODEX_HOME` | that folder | Codex stays off until sandbox isolation exists for the platform: the current check is Windows ACLs (`icacls`), so a Linux cloud computer needs its own equivalent first |
| routed roles (`model-router`) | wherever the hub's router has its provider keys | the hub's own key store | the cloud hub needs its own keys; none are copied from the PC |

Two ways to run coding roles when the hub is in the cloud, both keeping the sign-in where it is:

1. **On a PC companion.** The hub plans and tracks; the role's CLI runs on the owner's PC under that PC's profile and `accounts.json`, through a runner that speaks the same `RoleRunner` interface over the companion channel. Receipts then say `executionLocation: "this-pc"` and `executionDevice: <that PC's device id>`. Not built yet: the orchestrator currently spawns the runner on its own host. Needed: a companion executor for `RoleRunner.start`, per-device accounts and allowance readings, and the repo registry per device (paths are local).
2. **On a cloud computer.** The same orchestrator runs there with its own `accounts.json`, its own native sign-ins, its own clone of each repo, and `executionLocation: () => "cloud"` passed to `createOrchestrator` (added; default `this-pc`). Worktrees, tests and the done gate run on that computer.

What the harness reports today: every receipt carries `executionLocation` (from the new `executionLocation` dependency, default `"this-pc"`) and `executionDevice` (the hub's device id), and the job view's `location`. A test checks that only the profile folder selects the account: no token, credential or API-key variable is ever forwarded to a child. Nothing in the harness reads, stores or copies a login file.

### A coding role on a shared cloud computer (once Agent F's computers are wired in)

Agent F's shared cloud computers are devices in the same registry and run the same companion worker, dispatched through the same device path as a PC (`scripts/computers`, `scripts/devices/dispatch.ts`). A coding role may therefore target a shared cloud computer the same way a personal PC companion is targeted: the hub plans, tracks, gates and records; the role's CLI runs on that computer, under that computer's own native sign-in and its own `accounts.json`, in its own clone of the repo. The receipt then says `executionLocation: "cloud"` and `executionDevice: <that computer's device id>`. Nothing about an account crosses over: no login file, token or profile is copied to or from a computer, and a shared computer is never a default target.

What still has to be built for this (nothing here pretends it exists): a `RoleRunner` that starts the CLI through the computer's device dispatch instead of spawning it locally, per-device accounts and allowance readings, and a per-device repo registry. The computers' lease applies: a role holds the computer's control lease while it runs, so a person's takeover pauses it at a step boundary, exactly as for any agent job there.

## 5. Round 3 check (Track D, 1 Oct 2026)

Verified against the code and the existing tests, with no new provider call and no probe (every answer below comes from receipts, the job store or the code):

| Ask | Where it lives | State |
|---|---|---|
| Model availability | `/coding/accounts` rows: `models` is the catalogue; `modelsVerified` is only models that actually succeeded on that account, read from usage receipts | honest: "offered" and "verified" are separate |
| Requested vs responding model | every receipt stores `requestedModel`, `providerModel` and `modelMismatch` (null when the CLI never reported one); the job view's `runs[].attempts[]` exposes the same | done |
| Account/builder/reviewer/tests/diff/result | job `readable` view (section 3) | done |
| Exhausted account falls to the next configured one | section 1; with claude:max at its weekly limit, claude:max-2 is the next chain entry; codex entries are skipped with "paused until its sandbox isolation is applied" | done, tested (reviewer moved while builder and tests run once; a builder that committed then hit its limit continues on top of its commit) |
| Receipts for both attempts, nothing replayed | section 1 | done, tested |
| Paid/free honesty | routed roles are text roles (planner/reviewer); their receipts take `costClass`, `cost.basis` and `fallbackFrom` from the route that actually ran; native roles are `subscription`. No native builder is silently moved to a metered route | done (router tests) |
| Stale usage never shown fresh | `allowanceReading` = fresh / stale / unknown (stale after 30 minutes or once a window has reset; never 0%); on account rows and every receipt | done, tested |
| Cancel / resume / single start | orchestrator.test.ts (stop keeps worktrees, restart never replays, resume refused if agent config appeared), assign-lifecycle.test.ts (start once) | done |

Two concrete gaps found and closed (both surfaced by the creative job 674f43, below):

1. **Policy refused a harmless word.** `commandVerdict` refused any command containing `source ` or `eval`, even inside a double-quoted argument, so `git commit -m "Correct brief source note"` was denied as `runtime-path` every time. The words are now refused only as commands; a quoted literal is data (a double-quoted string containing `$` or a backtick is still refused). Tests in `runners/policy.test.ts`. Remaining limit: an unquoted heredoc commit message is split at newlines, and a line starting with `source` there is still refused; use `-m`.
2. **A failed commit was reported as "N uncommitted file(s)".** `postcheck.ts` (`commitRefusalNote`) now appends "its git commit was refused by the coding policy N times (rule: ...)" to the run's postcheck error when the role's git add/commit were refused in that turn. Only the verb and the rule are repeated, never the command text. Tests: `postcheck.test.ts` and an orchestrator end-to-end case.

No real coding journey was run: no concrete gap needed one, and the account and fallback behaviour is covered by the fake-CLI tests above.

### The creative Coding job (674f43, 1 Oct)

The builder on Claude Max 2 (Opus 5.5) built `public/mu-creative-20261001/index.html`, `creative-brief.md` and `production-manifest.json`; commit `9839622` on `coding/in-agentic-os-build-the-674f43-builder-1` holds all three (tests 347 pass, typecheck clean). A later resume made two wording corrections (the brief's source note, and the film-scripts speech-rate sentence) and left them staged because every `git commit` was refused by rule `runtime-path`: the message contained the words "source note" (gap 1). The two staged diffs are cosmetic and correct. The harness has no commit path other than the builder's own policy-checked `git commit`, so nothing was committed by hand, nothing was bypassed, and the job is still `needs_owner`.

What the owner decides: the policy fix (branch prog/d-coding-20261001) has to be live before a resume can succeed, because the live server on 8081 still runs the old policy. After the lead merges it and restarts, either (a) resume job 674f43 once (the builder commits the two staged files with a normal `-m` message; one Opus turn on Max 2, weekly use was 9% at the last reading), or (b) accept `9839622` as it is and leave the two staged cosmetic edits unused. Also seen, for Track E: each failed turn's handoff write to memory failed with `prohibited-content`.
