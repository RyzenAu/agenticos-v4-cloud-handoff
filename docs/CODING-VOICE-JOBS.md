# Coding by voice: builder and reviewer jobs

"Jarvis, assign a builder to fix X and a reviewer to check it" starts the coding harness. Nothing runs until a signed-in person says start. This page says what gets created, who approves what, where the evidence lives, how models are chosen, and what is fake in the cloud versus what needs a real Windows run.

## The phrase

Typed and spoken both reach the same detector (`src/lib/commands/coding.ts`, used by the command registry and by `scripts/coding/voice.ts`). These all mean build plus review:

- "assign a builder to fix the login bug in the dental site and a reviewer to check it"
- "have a builder fix X and a reviewer check it", "get a builder to fix X and a second agent to check it"
- "assign Codex to fix X and Opus to review it" (models named: the words win)
- "Jarvis, fix X. Opus builds, another Opus reviews."

Left alone: non-code errands ("assign a builder to fix my calendar"), and money orders ("assign a builder to pay the invoice"). A code change that only names a money feature is ordinary code work. "No reviewer" or "without a reviewer" makes a build-only job.

The command service calls `createCodingCommandEntry` (`scripts/coding/command-entry.ts`) for both typed and spoken turns. Its header comment is the contract: it returns `{ say, navigate?, jobId?, jobState?, draft? }`, or null when the words are not a coding turn.

## What gets created

1. A **draft job** (state `awaiting_confirmation`): repo, objective, done-when checks, owned files, and one row per role with the model and the reason it was picked. The spoken line reads "Draft ready: ... Builder: Opus, ... Reviewer: Codex, a different provider than the builder ... Say start when you want it built."
2. On a person's whole "start it" right after that question, or the Coding page Start: the job runs. Starting is idempotent. A spoken yes plus a page Start plus a double click make one run set; a repeat of the same plan is a no-op.
3. **Isolated work copy**: the baseline checks run on the base commit, then the builder works in its own git worktree on its own branch. The canonical checkout and the live OS checkout are snapshotted before and after every turn and must be byte-identical.
4. **Progress**: state changes, steps, the diff, test runs, review, gate and spoken lines are events on the job (Coding page, "how's the coding job going?", or `/__operator/coding/jobs/:id`).
5. **Diff and test receipts**: the orchestrator runs the registry checks itself at the integrated commit (an agent's claim is never evidence) and records the diff summary and each test result.
6. **Independent reviewer**: a read-only session on a detached worktree at that exact commit. It is a different model from the builder, and never the same session.
7. **Done gate**: committed and clean, ownership, secret scan, checks pass, review approved for this commit, done-when evidenced, and every finished agent run has a usage receipt. Only a passed gate for the head makes a job `completed`. Even then nothing is merged.
8. **Stop and resume**: "stop the reviewer" (or builder) stops one role and the job waits for you; "pause the coding job" interrupts; "resume the coding job" continues from the first unfinished phase. Finished roles are not replayed and no run is duplicated. "Stop the coding job" cancels the whole job: worktrees are kept, nothing is merged, and a cancelled job cannot be resumed.
9. **Reviewable merge**: "merge it into production" creates an approval request only (`requestApply`), and only for a job whose gate passed. Deploys and pushes to a deploy branch are refused.

## Who approves what

| Action | Who |
| --- | --- |
| Draft, ask how it is going | Usman, Mehroz, or a program under the page token |
| Start, stop, pause, resume | A signed-in person (Usman or Mehroz). A program is refused. |
| Ask for a merge | A signed-in person. Mehroz asking creates the request and tells Usman. |
| Approve a merge | Usman only, by his spoken yes to that exact question or his Telegram code. A typed yes, a click, or Mehroz's yes is refused. |

The approval is bound to the job head and plan digest. A moved head voids it. The merge itself does not touch any working tree: it is verified from git before Jarvis says "merged".

## Where the receipts are

- `.operator-data/coding/coding.sqlite`: job, runs, events. Each agent turn writes one usage receipt event: provider, account slot, the model that ran, `fallbackFrom` when a routed role fell back, tokens, cost basis and cost when known. Native roles also get a row in the fleet ledger (System > Models).
- `GET /__operator/coding/jobs/:id` returns `modelsUsed`: per role turn, the model selected versus the model that ran, whether it fell back and why. "How's the coding job going?" says it: "The reviewer ran on Cline DeepSeek (selected Hermes, fell back because ...)". A turn with no receipt is shown as having no receipt, never as having run, and the gate fails until it has one.
- The handoff (`handoff.json` and `.md`) is written when the job settles, with what changed, tests, review and what ran.

## Model choice and paid/free rules

Words win. "Codex builds, Opus reviews" is used as said, even when both roles are the same model ("Opus builds, another Opus reviews").

When the words name no model, `scripts/coding/role-choice.ts` picks, deterministically:

- **Builder**: your Claude plan's Opus by default; Sonnet for small copy or style changes (saves allowance); Codex for test and typecheck repair. Jev, the typed decision brain, may propose a model for a role; its pick is used only when that model is available and allowed, and is recorded as Jev's.
- **Reviewer**: never the builder's model. A different provider family first (Opus builds, Codex reviews), then a different model of the same family. A free route is used as the reviewer only when nothing else differs.
- Unavailable models are skipped: Claude at its stop window, Codex without its isolation applied or with no connected account. A Codex slot that would draw paid credits is never chosen automatically.
- Each pick carries a short "why" saved in the spec (`roleChoices`) and spoken in the draft summary. Old specs without it are unchanged.

Preferences live in `.operator-data/coding-prefs.json` (optional):

```json
{ "freeOnly": false, "allowPaidFallback": true, "preferred": ["claude-opus-5-5", "gpt-6-astra"] }
```

- Default (no file): paid subscription models (Claude plan, Codex accounts) may be chosen, as before. Metered or paid API models are never auto-selected.
- `freeOnly: true`: builder and reviewer come only from the verified-free Cline routes (DeepSeek, MiMo, Muse). A model you name that is not free (Opus, Codex, Hermes) is refused with the reason and the way out, not run. If no free route is set up, Jarvis says so.
- `allowPaidFallback: false`: a routed role that falls back will not land on a metered model. The router still falls back automatically among free and subscription routes.
- `preferred`: model ids tried first.
- A missing or invalid file falls back to the safe default and logs why.

The receipt records the model that ran, never the one selected when a fallback ran.

## What is fake in the cloud versus real on the PC

Fake or synthetic here (all in `bun test scripts/coding`):

- Claude and Codex are scripted fake processes that speak the real wire protocols and really edit and commit inside a temp git worktree. No real CLI, login, provider call or network.
- Router models run through the real router logic with a fake provider.
- The repos are temp fixtures. The approvals service is real; the spoken yes is a fake speech-to-text event.
- Codex sandbox isolation is stubbed as passing.

Needs a real Windows run (nothing here proves it):

- Real Claude Code and Codex CLIs, their versions and logins, real allowance windows, real Codex `--apply` isolation.
- Real repos, real worktrees on NTFS (junctions, long paths), real test commands.
- Real speech-to-text spoken yes and Telegram approval codes.
- Real free-route (Cline) availability and real fallback behaviour.

## Windows real-device coding checklist

Run on the PC as the signed-in owner, with a throwaway repo registered in `.operator-data/coding/repos.json` first.

1. `claude --version` and `codex --version` work; the Coding page shows both as installed and signed in. Run `bun scripts/coding/codex-isolation.ts --apply` once so Codex roles are allowed.
2. Optional: create `.operator-data/coding-prefs.json` and confirm a draft honours it (try `freeOnly` and a named paid model).
3. Say: "Jarvis, assign a builder to fix <a small real bug> in <throwaway repo> and a reviewer to check it." Confirm the draft names two different models with reasons, and that nothing started.
4. Say "start it". Confirm one builder worktree appears under the repo's worktree folder and the main checkout stays untouched (`git status` unchanged).
5. Watch progress on the Coding page. Confirm the diff, the orchestrator's own test run, and the reviewer's verdict.
6. Stop the reviewer, then "resume the coding job". Confirm the builder does not run again.
7. Open the job's models-used view. Confirm each role shows the model that actually ran. Force a fallback if you can (a Hermes reviewer while its window is used up) and confirm the receipt names the fallback.
8. After the gate passes, ask Mehroz's session to "merge it into production": only a request appears. Then Usman answers with his spoken yes or the Telegram code. Confirm the branch moved, git verifies it, and a typed yes does nothing.
9. Cancel a second job mid-run. Confirm the worktrees remain and nothing merged.
