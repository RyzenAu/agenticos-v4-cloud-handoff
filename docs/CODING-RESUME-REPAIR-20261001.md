# Coding Resume loop: reviewed patch, not live

Prepared in `D:/AgenticOS-coding-resume-repair`, branch `codex/coding-resume-repair-20261001`, from `cab1e43`. The canonical and live OS were independently checked at `885f309`. Claude's integration tree progressed to `18ffb1c` during verification and was left untouched.

## Root cause and patch

Resume chose the completion gate whenever a review existed for the current commit, including request-changes and cannot-assess. It neither dispatched repairs nor refreshed the review. The two affected jobs repeatedly recorded needs_owner -> gating -> needs_owner, on the same commit.

The patch routes request-changes through one repair pass per explicit owner Resume: existing builder/test-author worktrees, unchanged ownership and bindings, review findings and unmet criteria supplied as data, then integration, tests, independent review and the existing gate. An inconclusive review retries only the reviewer. A test author's existing work is retained and updated to include the corrected builder head. There is no automatic unbounded retry, finding acceptance, live merge or deploy.

Reviewer prompts now include recorded baseline failures by identity without calling them passing tests. Job cards/details show the current blocker and use Fix review findings / Retry review where appropriate. Earlier resolved role errors no longer mask current failures. Voice replies describe repair and reviewer retries accurately.

## Current jobs need distinct follow-ups

1. `fd219e20-2b2b-4c9b-89d2-f6da1868a670` (model selection): review found missing committed focused tests. Its confirmed builder ownership contains ONLY scripts/coding/shaper.ts and scripts/coding/voice.ts, with no newFiles. Adding separate test files is currently prohibited despite the task asking for tests. Correct this scope through the existing confirmed-plan mechanism or finish the missing tests in an explicitly bounded successor task; do not silently mutate the confirmed spec or remove the review requirement. The existing failed Windows ACL test is classified by the gate as pre-existing, not a new regression.
2. `4465ff87-684d-43e7-ac34-2662e64b0b34` (finance dates): the recorded review rejected it primarily over that pre-existing test. A fresh review needs the recorded baseline context; the current review must not be fabricated into an approval.
3. `674f4376-22b9-4517-aee9-1e88da66f81a` (creative): its latest reviewer attempt was refused by the Codex isolation preflight. A repeat Resume cannot remove that blocker. Use the supported explicit account/role reassignment to an available Claude reviewer, or resolve isolation through the authorised procedure. This patch changes no account or isolation settings.

No live jobs were resumed, models called, accounts changed, approvals consumed, or user files edited during this investigation.

## Fresh verification

- Failing-before regression: request-changes Resume launched no second builder; cannot-assess Resume launched no second reviewer. Both reproduced the loop before the patch.
- All original orchestrator tests plus pause-reason and pipeline UI tests: 48 passed, 0 failed (before adding the two additional repair scenarios).
- Final repair regressions plus reason/UI tests: 31 passed, 0 failed. Includes new commit reviewed, reviewer-only retry, test-author continuity and baseline failure identities.
- Readable job/account view checks: 2 passed, 0 failed.
- `bun run typecheck`: exit 0.
- `bun run typecheck:scripts`: exit 0.
- `git diff --check`: clean.

Evidence uses disposable git repositories and fake model processes. It does not establish live provider or browser acceptance. No full release suite or build was run here while Claude's release gate was in progress.

## Integration handoff

After the current integration run is settled, review the commit on `codex/coding-resume-repair-20261001` and bring it into the integration branch. Run the standard serial release gate before any live merge. Preserve the canonical modified FALLBACK-ORDER.md and all untracked user docs/skills. Once live, verify the actual job events show repair/review rather than repeating gating; handle the three separate follow-ups above. Do not report the old jobs complete merely because this regression patch passes.
