# Saved research duration

Base: `00e2fe12e0df4eba05787cb0f99b400e497cb58f` (tree `d5909d64d4b3ea53f51ed3f2000d144022dc3a04`, the sanitised export declared to match live `1c94f418`). No production state or provider was queried for this patch.

## Cause and change

`runResearch` passed its initial zero elapsed/cost metrics to the artifact producer. Those metrics were only refreshed after conversation delivery, too late for the saved markdown. One metrics refresh now runs immediately before artifact serialization, before the completion note, and at the existing final return.

The report labels this number **research elapsed**. Its cutoff is immediately before hub persistence: research start through the computer's report write/read-back. It excludes hub persistence and subsequent conversation delivery. The final research-step duration still includes delivery; Activity measures the whole job, including preceding steps. These values need not equal each other. No job/store timing semantics, old saved files, metadata schema or idempotent-save behavior are changed. True zero/sub-second measurements are not padded or backfilled.

## Verification

All restored source dependencies were checked against the base tree's Git blob hashes. Tests ran with a fresh synthetic HOME/data area, no inherited credentials and no live web/model calls.

- Baseline `research.test.ts`: 31 tests passed. Before the fix, the new real-service regression reproduced Activity = 26,000 ms, final research step = 23,000 ms, saved report = 0 s. The snapshot test also reproduced 0 instead of measured 12,000 ms.
- Fixed integration uses the real computers service, JobService, companion worker, artifact persistence and renderer with async synthetic stages and a fake wall clock. The saved and reopened report reads 17 s research elapsed; six seconds of subsequent delivery remain included in the 23-second research step and 26-second job.
- Zero and 120 ms runs retain their measured values and round to 0 s. Accumulated model cost agrees between the artifact snapshot, completion note and returned metrics.
- Focused Bun suite: `research-metrics.test.ts`, `research.test.ts`, `results-r7.test.ts`, `workflows.test.ts`: 76 passed, 0 failed, 465 assertions.
- Scoped strict TypeScript check of the two production files, new test and their transitive imports passed (`ES2022`, `ESNext`, Bundler resolution, `ES2023,DOM,DOM.Iterable`, Bun types, `skipLibCheck`, `resolveJsonModule`, `allowImportingTsExtensions`).

Full repository tests, full app/server typechecks, frozen-install build and live browser QA were not run in this partial source export. Claude owns the release gate and deployment. Existing reports retain their original bytes; no duration is guessed from Activity or rewritten retrospectively.
